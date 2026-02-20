import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { config } from "../config/config.ts";
import { getStorageProvider, getEmbeddingProvider } from "../storage/provider.ts";
import { extractWithOllama } from "./ollama-extractor.ts";
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

export interface BackfillOptions {
  /** Only process sessions from this tool */
  tool?: "opencode" | "claude-code";
  /** Only process sessions after this timestamp (ms) */
  since?: number;
  /** Maximum sessions to process in this run */
  limit?: number;
  /** Callback for progress updates */
  onProgress?: (progress: BackfillProgress) => void;
}

export interface BackfillProgress {
  current: number;
  total: number;
  sessionId: string;
  tool: string;
  chainsExtracted: number;
}

export interface BackfillResult {
  sessionsProcessed: number;
  sessionsSkipped: number;
  chainsExtracted: number;
  errors: string[];
}

// --- Backfill state persistence ---

const LOCAL_USER_ID = "00000000-0000-0000-0000-000000000000";

interface BackfillState {
  backfilledSessionIds: string[];
}

function getStatePath(): string {
  return join(config.paths.dataDir, "backfill-state.json");
}

function loadState(): BackfillState {
  const statePath = getStatePath();
  if (!existsSync(statePath)) {
    return { backfilledSessionIds: [] };
  }
  try {
    const raw = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw) as BackfillState;
    return {
      backfilledSessionIds: Array.isArray(parsed.backfilledSessionIds)
        ? parsed.backfilledSessionIds
        : [],
    };
  } catch {
    return { backfilledSessionIds: [] };
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

/**
 * Run the backfill pipeline: process existing AI coding sessions,
 * extract reasoning chains via Ollama, generate embeddings, and store.
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

  for (let i = 0; i < sessions.length; i++) {
    const entry = sessions[i]!;

    try {
      // Parse the session
      const parsed = entry.parse();
      if (!parsed) {
        result.sessionsSkipped++;
        markSessionBackfilled(state, entry.id);
        continue;
      }

      // Skip sessions that are too short
      const minTurns = 4;
      if (parsed.turnCount < minTurns) {
        result.sessionsSkipped++;
        markSessionBackfilled(state, entry.id);
        continue;
      }

      // Extract reasoning chains via Ollama
      const chains = await extractWithOllama(parsed.conversationText);

      // Mark as backfilled even if no chains found
      if (chains.length === 0) {
        result.sessionsSkipped++;
        markSessionBackfilled(state, entry.id);
        opts?.onProgress?.({
          current: i + 1,
          total,
          sessionId: entry.id,
          tool: entry.tool,
          chainsExtracted: 0,
        });
        continue;
      }

      // Generate embeddings for all chains
      const texts = chains.map((c) => `${c.title}\n${c.content}`);
      const chainEmbeddings = await embeddings.generateEmbeddings(texts);

      // Upsert the session
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

      // Insert reasoning chains
      const chainRecords: ReasoningChain[] = chains.map((chain, idx) => ({
        sessionId,
        userId: LOCAL_USER_ID,
        type: chain.type,
        title: chain.title,
        content: chain.content,
        tags: chain.tags,
        embedding: chainEmbeddings[idx] && chainEmbeddings[idx]!.length > 0
          ? chainEmbeddings[idx]
          : undefined,
      }));
      await storage.insertReasoningChains(chainRecords);

      result.sessionsProcessed++;
      result.chainsExtracted += chains.length;
      markSessionBackfilled(state, entry.id);

      opts?.onProgress?.({
        current: i + 1,
        total,
        sessionId: entry.id,
        tool: entry.tool,
        chainsExtracted: chains.length,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      result.errors.push(`Session ${entry.id} (${entry.tool}): ${message}`);
      console.error(`[backfill] Error processing session ${entry.id}:`, message);
    }
  }

  return result;
}
