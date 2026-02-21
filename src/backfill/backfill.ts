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

interface BackfillState {
  backfilledSessionIds: string[];
  /** Maps session IDs to their error retry count. Sessions exceeding MAX_RETRIES are skipped. */
  erroredSessions?: Record<string, { count: number; lastError: string }>;
}

function getStatePath(): string {
  return join(config.paths.dataDir, "backfill-state.json");
}

function loadState(): BackfillState {
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

function saveState(state: BackfillState): void {
  const statePath = getStatePath();
  const dir = config.paths.dataDir;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}

function markSessionBackfilled(state: BackfillState, sessionId: string): void {
  state.backfilledSessionIds.push(sessionId);
  saveState(state);
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

  saveState(state);
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

/** Intermediate result from phase 1 extraction */
interface ExtractedSession {
  index: number;
  entry: SessionEntry;
  sessionData: Session;
  chains: import("./ollama-extractor.ts").ExtractedChain[];
}

/** Max chains to embed in a single Ollama call */
const EMBED_BATCH_SIZE = 50;

/**
 * Run the backfill pipeline in three phases to minimize Ollama model swaps:
 *
 * Phase 1 (Extract): Parse all sessions + extract chains via chat model.
 *   → Ollama loads the chat model once for all sessions.
 * Phase 2 (Embed): Generate embeddings for all extracted chains.
 *   → Ollama loads the embedding model once for all chains.
 * Phase 3 (Save): Write sessions + chains to storage, mark as backfilled.
 *
 * Supports resume — tracks which sessions have already been processed
 * in a state file so interrupted runs can be continued.
 */
export async function runBackfill(opts?: BackfillOptions): Promise<BackfillResult> {
  const storage = await getStorageProvider();
  const embeddings = await getEmbeddingProvider();
  const state = loadState();
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

  // ================================================================
  // Phase 1: Parse + Extract (chat model loaded once)
  // ================================================================
  const extracted: ExtractedSession[] = [];

  for (let i = 0; i < sessions.length; i++) {
    const entry = sessions[i]!;

    try {
      // Parse the session
      emitStep(i, entry, "parsing");
      const parsed = entry.parse();
      if (!parsed) {
        result.sessionsSkipped++;
        markSessionBackfilled(state, entry.id);
        emitStep(i, entry, "skipped", "unparseable");
        continue;
      }

      // Skip sessions that are too short
      const minTurns = 4;
      if (parsed.turnCount < minTurns) {
        result.sessionsSkipped++;
        markSessionBackfilled(state, entry.id);
        emitStep(i, entry, "skipped", `only ${parsed.turnCount} turns`);
        continue;
      }

      // Extract reasoning chains via Ollama (chat model)
      const charLen = parsed.conversationText.length;
      emitStep(i, entry, "extracting", `${parsed.turnCount} turns, ${(charLen / 1000).toFixed(0)}k chars`);
      const chains = await extractWithOllama(parsed.conversationText, ollamaOpts);

      if (chains.length === 0) {
        result.sessionsSkipped++;
        markSessionBackfilled(state, entry.id);
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

      // Stash for phase 2+3
      extracted.push({
        index: i,
        entry,
        sessionData: {
          userId: LOCAL_USER_ID,
          tool: entry.tool,
          project: parsed.project,
          startedAt: parsed.startedAt,
          endedAt: parsed.endedAt,
          summary: parsed.summary,
          metadata: parsed.metadata,
        },
        chains,
      });

      emitStep(i, entry, "done", `extracted ${chains.length} chains`);
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

    // Throttle between extraction calls to keep system responsive
    if (delayMs > 0 && i < sessions.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (extracted.length === 0) {
    return result;
  }

  // ================================================================
  // Phase 2: Embed all chains (embedding model loaded once)
  // ================================================================
  // Flatten all chain texts across all sessions, tracking flat offset per session
  const allTexts: string[] = [];
  const sessionFlatOffset: number[] = []; // sessionFlatOffset[si] = starting index in allTexts

  for (let si = 0; si < extracted.length; si++) {
    sessionFlatOffset.push(allTexts.length);
    const ex = extracted[si]!;
    for (let ci = 0; ci < ex.chains.length; ci++) {
      const chain = ex.chains[ci]!;
      allTexts.push(`${chain.title}\n${chain.content}`);
    }
  }

  // Emit a progress step for the embedding phase
  const firstEx = extracted[0]!;
  emitStep(firstEx.index, firstEx.entry, "embedding", `${allTexts.length} chains across ${extracted.length} sessions`);

  // Batch embed to avoid overloading Ollama
  const allEmbeddings: number[][] = [];
  for (let i = 0; i < allTexts.length; i += EMBED_BATCH_SIZE) {
    const batch = allTexts.slice(i, i + EMBED_BATCH_SIZE);
    const batchEmbeddings = await embeddings.generateEmbeddings(batch);
    allEmbeddings.push(...batchEmbeddings);
  }

  // ================================================================
  // Phase 3: Save all sessions + chains to storage
  // ================================================================
  for (let si = 0; si < extracted.length; si++) {
    const ex = extracted[si]!;
    try {
      emitStep(ex.index, ex.entry, "saving", `${ex.chains.length} chains`);

      const sessionId = await storage.upsertSession(ex.sessionData);
      const offset = sessionFlatOffset[si]!;

      // Build chain records with embeddings
      const chainRecords: ReasoningChain[] = ex.chains.map((chain, ci) => {
        const embedding = allEmbeddings[offset + ci]?.length
          ? allEmbeddings[offset + ci]
          : undefined;

        return {
          sessionId,
          userId: LOCAL_USER_ID,
          type: chain.type,
          title: chain.title,
          content: chain.content,
          tags: chain.tags,
          embedding,
        };
      });

      await storage.insertReasoningChains(chainRecords);

      result.sessionsProcessed++;
      result.chainsExtracted += ex.chains.length;
      markSessionBackfilled(state, ex.entry.id);

      emitStep(ex.index, ex.entry, "done", `+${ex.chains.length} chains`);
      opts?.onProgress?.({
        current: ex.index + 1,
        total,
        sessionId: ex.entry.id,
        tool: ex.entry.tool,
        chainsExtracted: ex.chains.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`Session ${ex.entry.id} (${ex.entry.tool}) save failed: ${message}`);
      emitStep(ex.index, ex.entry, "error", message.slice(0, 100));
    }
  }

  return result;
}
