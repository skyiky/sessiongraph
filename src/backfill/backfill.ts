import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { config } from "../config/config.ts";
import { getStorageProvider, getEmbeddingProvider } from "../storage/provider.ts";
import { extractWithOllama } from "./ollama-extractor.ts";
import type { OllamaOptions } from "./ollama-extractor.ts";
import {
  isOpenCodeAvailable,
  getNewSessions as getOpenCodeSessions,
  parseSession as parseOpenCodeSession,
} from "../ingestion/parsers/opencode.ts";
import type { OpenCodeSession } from "../ingestion/parsers/opencode.ts";
import {
  isClaudeCodeAvailable,
  getNewSessions as getClaudeCodeSessions,
  parseSession as parseClaudeCodeSession,
} from "../ingestion/parsers/claude-code.ts";
import type { ClaudeCodeSession } from "../ingestion/parsers/claude-code.ts";
import type { ReasoningChain, Session } from "../config/types.ts";

// --- Types ---

export type BackfillStep =
  | "parsing"
  | "extracting"
  | "embedding"
  | "saving"
  | "done"
  | "skipped"
  | "error";

export interface BackfillOptions {
  /** Only process sessions from this tool */
  tool?: "opencode" | "claude-code";
  /** Only process sessions after this timestamp (ms) */
  since?: number;
  /** Maximum sessions to process in this run */
  limit?: number;
  /** Delay in milliseconds between processing sessions (default: 2000) */
  delayMs?: number;
  /** Ollama runtime options for resource throttling */
  ollamaOptions?: Omit<OllamaOptions, "model" | "baseUrl">;
  /** Callback for progress updates (fires once per completed session) */
  onProgress?: (progress: BackfillProgress) => void;
  /** Callback for step-level progress within each session */
  onStepProgress?: (step: StepProgress) => void;
}

export interface BackfillProgress {
  current: number;
  total: number;
  sessionId: string;
  tool: string;
  chainsExtracted: number;
}

export interface StepProgress {
  current: number;
  total: number;
  sessionId: string;
  tool: string;
  step: BackfillStep;
  detail?: string;
}

export interface BackfillResult {
  sessionsProcessed: number;
  sessionsSkipped: number;
  chainsExtracted: number;
  errors: string[];
}

// --- Backfill state persistence ---

const LOCAL_USER_ID = "00000000-0000-0000-0000-000000000000";

/** Max times a session will be retried before being permanently skipped. */
const MAX_RETRIES = 3;

export interface BackfillState {
  backfilledSessionIds: string[];
  /** Maps session IDs to their error retry count. Sessions exceeding MAX_RETRIES are skipped. */
  erroredSessions?: Record<string, { count: number; lastError: string }>;
}

function getStatePath(): string {
  return join(config.paths.dataDir, "backfill-state.json");
}

export function loadBackfillState(): BackfillState {
  const statePath = getStatePath();
  if (!existsSync(statePath)) {
    return { backfilledSessionIds: [], erroredSessions: {} };
  }
  try {
    const raw = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw) as BackfillState;
    return {
      backfilledSessionIds: Array.isArray(parsed.backfilledSessionIds)
        ? parsed.backfilledSessionIds
        : [],
      erroredSessions: parsed.erroredSessions ?? {},
    };
  } catch {
    return { backfilledSessionIds: [], erroredSessions: {} };
  }
}

export function saveBackfillState(state: BackfillState): void {
  const statePath = getStatePath();
  const dir = config.paths.dataDir;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}

export function markSessionBackfilled(state: BackfillState, sessionId: string): void {
  state.backfilledSessionIds.push(sessionId);
  // State is saved periodically by the caller (every SAVE_INTERVAL sessions + on exit)
  // to avoid O(N^2) disk writes across the full backfill run.
}

/**
 * Record that a session errored during backfill.
 * Returns true if the session has exceeded its retry budget.
 */
function markSessionErrored(state: BackfillState, sessionId: string, error: string): boolean {
  if (!state.erroredSessions) state.erroredSessions = {};
  const entry = state.erroredSessions[sessionId];
  const newCount = (entry?.count ?? 0) + 1;
  state.erroredSessions[sessionId] = { count: newCount, lastError: error };

  if (newCount >= MAX_RETRIES) {
    // Permanently skip — add to backfilled set so it's never retried
    state.backfilledSessionIds.push(sessionId);
  }

  // Errors are saved immediately (they're rare and losing error state is worse)
  saveBackfillState(state);
  return newCount >= MAX_RETRIES;
}

/**
 * Check if a session has been errored but still has retries remaining.
 * Returns the retry count, or 0 if never errored.
 */
function getErrorCount(state: BackfillState, sessionId: string): number {
  return state.erroredSessions?.[sessionId]?.count ?? 0;
}

// --- Unified session entry ---

interface SessionEntry {
  id: string;
  tool: "opencode" | "claude-code";
  timestamp: number;
  parse: () => {
    conversationText: string;
    turnCount: number;
    project: string | undefined;
    startedAt: Date;
    endedAt: Date;
    summary: string | undefined;
    metadata: Record<string, unknown>;
  } | null;
}

function collectSessions(opts?: BackfillOptions): SessionEntry[] {
  const entries: SessionEntry[] = [];

  // OpenCode sessions
  if (!opts?.tool || opts.tool === "opencode") {
    if (isOpenCodeAvailable()) {
      const sessions: OpenCodeSession[] = getOpenCodeSessions(opts?.since);
      for (const session of sessions) {
        entries.push({
          id: session.id,
          tool: "opencode",
          timestamp: session.updatedAt,
          parse: () => {
            const parsed = parseOpenCodeSession(session.id);
            if (!parsed) return null;
            const projectName = parsed.session.projectPath
              ? parsed.session.projectPath.split(/[\\/]/).pop() ?? parsed.session.projectPath
              : undefined;
            return {
              conversationText: parsed.conversationText,
              turnCount: parsed.conversation.length,
              project: projectName,
              startedAt: new Date(parsed.session.createdAt),
              endedAt: new Date(parsed.session.updatedAt),
              summary: parsed.session.title || undefined,
              metadata: {
                opencode_project_id: parsed.session.projectId,
                project_path: parsed.session.projectPath,
                message_count: parsed.conversation.length,
              },
            };
          },
        });
      }
    }
  }

  // Claude Code sessions
  if (!opts?.tool || opts.tool === "claude-code") {
    if (isClaudeCodeAvailable()) {
      const sessions: ClaudeCodeSession[] = getClaudeCodeSessions(opts?.since);
      for (const session of sessions) {
        entries.push({
          id: session.id,
          tool: "claude-code",
          timestamp: session.updatedAt,
          parse: () => {
            const parsed = parseClaudeCodeSession(session.id);
            if (!parsed) return null;
            const projectName = parsed.session.project
              ? parsed.session.project.split(/[\\/]/).pop() ?? parsed.session.project
              : undefined;
            return {
              conversationText: parsed.conversationText,
              turnCount: parsed.messages.length,
              project: projectName,
              startedAt: new Date(parsed.session.startedAt),
              endedAt: new Date(parsed.session.updatedAt),
              summary: parsed.session.title || undefined,
              metadata: {
                project_path: parsed.session.project,
                message_count: parsed.messages.length,
              },
            };
          },
        });
      }
    }
  }

  return entries;
}

// --- Main backfill function ---

/** Max chains to embed in a single Ollama call */
const EMBED_BATCH_SIZE = 50;

/** How often to flush backfill state to disk (every N completed sessions) */
const STATE_SAVE_INTERVAL = 10;

/** Flag set by SIGINT handler to stop after current session completes */
let interruptRequested = false;

/**
 * Request a graceful stop of the backfill pipeline.
 * The current session will finish (extract → embed → save) before stopping.
 */
export function requestBackfillStop(): void {
  interruptRequested = true;
}

/**
 * Run the backfill pipeline. Each session is processed atomically:
 *   parse → extract → embed → save → mark
 * before moving to the next session. This ensures Ctrl+C / interrupts
 * never lose progress — on resume, only the in-flight session is re-done.
 *
 * Both the chat model and embedding model fit in VRAM concurrently
 * (qwen2.5:3b ~1.6GB + qwen3-embedding:0.6b ~0.7GB < 4GB), so
 * per-session model "swaps" have negligible overhead.
 */
export async function runBackfill(opts?: BackfillOptions): Promise<BackfillResult> {
  interruptRequested = false;

  const storage = await getStorageProvider();
  const embeddings = await getEmbeddingProvider();
  const state = loadBackfillState();
  const backfilledSet = new Set(state.backfilledSessionIds);

  const result: BackfillResult = {
    sessionsProcessed: 0,
    sessionsSkipped: 0,
    chainsExtracted: 0,
    errors: [],
  };

  // Collect all candidate sessions
  let sessions = collectSessions(opts);

  // Filter out already-backfilled sessions
  sessions = sessions.filter((s) => !backfilledSet.has(s.id));

  // Apply limit
  if (opts?.limit && opts.limit > 0) {
    sessions = sessions.slice(0, opts.limit);
  }

  const total = sessions.length;
  const delayMs = opts?.delayMs ?? 2000;
  const ollamaOpts: OllamaOptions = {
    ...(opts?.ollamaOptions ?? {}),
  };

  const emitStep = (i: number, entry: SessionEntry, step: BackfillStep, detail?: string) => {
    opts?.onStepProgress?.({
      current: i + 1,
      total,
      sessionId: entry.id,
      tool: entry.tool,
      step,
      detail,
    });
  };

  let sessionsSinceLastSave = 0;

  try {
    for (let i = 0; i < sessions.length; i++) {
      // Check for graceful interrupt between sessions
      if (interruptRequested) {
        opts?.onStepProgress?.({
          current: i + 1,
          total,
          sessionId: sessions[i]!.id,
          tool: sessions[i]!.tool,
          step: "done",
          detail: "interrupted — progress saved, resume with `sessiongraph backfill`",
        });
        break;
      }

      const entry = sessions[i]!;

      try {
        // ---- Step 1: Parse ----
        emitStep(i, entry, "parsing");
        const parsed = entry.parse();
        if (!parsed) {
          result.sessionsSkipped++;
          markSessionBackfilled(state, entry.id);
          sessionsSinceLastSave++;
          emitStep(i, entry, "skipped", "unparseable");
          continue;
        }

        // Skip sessions that are too short
        const minTurns = 4;
        if (parsed.turnCount < minTurns) {
          result.sessionsSkipped++;
          markSessionBackfilled(state, entry.id);
          sessionsSinceLastSave++;
          emitStep(i, entry, "skipped", `only ${parsed.turnCount} turns`);
          continue;
        }

        // ---- Step 2: Extract reasoning chains via Ollama (chat model) ----
        const charLen = parsed.conversationText.length;
        emitStep(i, entry, "extracting", `${parsed.turnCount} turns, ${(charLen / 1000).toFixed(0)}k chars`);
        const chains = await extractWithOllama(parsed.conversationText, ollamaOpts);

        if (chains.length === 0) {
          result.sessionsSkipped++;
          markSessionBackfilled(state, entry.id);
          sessionsSinceLastSave++;
          emitStep(i, entry, "done", "0 chains (skipped)");
          opts?.onProgress?.({
            current: i + 1,
            total,
            sessionId: entry.id,
            tool: entry.tool,
            chainsExtracted: 0,
          });
          continue;
        }

        // ---- Step 3: Embed chains (embedding model) ----
        emitStep(i, entry, "embedding", `${chains.length} chains`);
        const texts = chains.map((c) => `${c.title}\n${c.content}`);
        const chainEmbeddings: number[][] = [];
        for (let bi = 0; bi < texts.length; bi += EMBED_BATCH_SIZE) {
          const batch = texts.slice(bi, bi + EMBED_BATCH_SIZE);
          const batchEmbeddings = await embeddings.generateEmbeddings(batch);
          chainEmbeddings.push(...batchEmbeddings);
        }

        // ---- Step 4: Save to storage ----
        emitStep(i, entry, "saving", `${chains.length} chains`);

        const sessionData: Session = {
          userId: LOCAL_USER_ID,
          tool: entry.tool,
          project: parsed.project,
          startedAt: parsed.startedAt,
          endedAt: parsed.endedAt,
          summary: parsed.summary,
          metadata: parsed.metadata,
        };

        const sessionId = await storage.upsertSession(sessionData);

        const chainRecords: ReasoningChain[] = chains.map((chain, ci) => {
          const embedding = chainEmbeddings[ci]?.length
            ? chainEmbeddings[ci]
            : undefined;

          return {
            sessionId,
            userId: LOCAL_USER_ID,
            type: chain.type,
            title: chain.title,
            content: chain.content,
            tags: chain.tags,
            embedding,
            quality: 0.6, // Ollama backfill — good but not agent-authored
          };
        });

        await storage.insertReasoningChains(chainRecords);

        // ---- Step 5: Mark complete ----
        result.sessionsProcessed++;
        result.chainsExtracted += chains.length;
        markSessionBackfilled(state, entry.id);
        sessionsSinceLastSave++;

        emitStep(i, entry, "done", `+${chains.length} chains`);
        opts?.onProgress?.({
          current: i + 1,
          total,
          sessionId: entry.id,
          tool: entry.tool,
          chainsExtracted: chains.length,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const exhausted = markSessionErrored(state, entry.id, message);
        const retryCount = getErrorCount(state, entry.id);
        const retryInfo = exhausted
          ? ` (retry budget exhausted after ${retryCount} attempts — permanently skipped)`
          : ` (attempt ${retryCount}/${MAX_RETRIES} — will retry on next run)`;
        result.errors.push(`Session ${entry.id} (${entry.tool}): ${message}${retryInfo}`);
        emitStep(i, entry, "error", message.slice(0, 100));
      }

      // Periodically flush state to disk (every STATE_SAVE_INTERVAL sessions)
      if (sessionsSinceLastSave >= STATE_SAVE_INTERVAL) {
        saveBackfillState(state);
        sessionsSinceLastSave = 0;
      }

      // Throttle between sessions to keep system responsive
      if (delayMs > 0 && i < sessions.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  } finally {
    // Always flush state on exit — covers normal completion, interrupts, and crashes
    saveBackfillState(state);
  }

  return result;
}
