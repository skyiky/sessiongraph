import { Database } from "bun:sqlite";
import { config } from "../../config/config.ts";
import { existsSync } from "fs";

// --- Shared read-only connection ---

let sharedDb: Database | null = null;
let sharedDbPath: string | null = null;

/**
 * Get a shared read-only Database connection to the OpenCode SQLite database.
 * Reuses the same connection across getNewSessions/parseSession calls to avoid
 * O(N) open/close overhead during backfill.
 */
function getSharedDb(): Database {
  const dbPath = config.opencode.dbPath;
  // Revalidate if path changed (shouldn't happen, but defensive)
  if (sharedDb && sharedDbPath === dbPath) return sharedDb;
  if (sharedDb) { sharedDb.close(); sharedDb = null; }

  sharedDb = new Database(dbPath, { readonly: true });
  sharedDbPath = dbPath;
  return sharedDb;
}

/** Close the shared connection. Call when done with a batch of operations. */
export function closeSharedDb(): void {
  if (sharedDb) {
    sharedDb.close();
    sharedDb = null;
    sharedDbPath = null;
  }
}

// Raw types from OpenCode's schema
export interface OpenCodeSession {
  id: string;
  projectId: string;
  projectPath: string;
  title: string;
  createdAt: number; // unix ms
  updatedAt: number; // unix ms
}

export interface OpenCodeConversationTurn {
  messageId: string;
  role: "user" | "assistant";
  createdAt: number; // unix ms
  model?: string;
  cost?: number;
  parts: OpenCodePart[];
}

export type OpenCodePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; tool: string; callId: string; status: string; title?: string; input?: string; output?: string }
  | { type: "patch"; hash: string; files: string[] }
  | { type: "step-start" }
  | { type: "step-finish"; reason?: string; cost?: number }
  | { type: "compaction"; auto: boolean }
  | { type: "file"; filename?: string; mime?: string };

export interface ParsedSession {
  session: OpenCodeSession;
  conversation: OpenCodeConversationTurn[];
  /** The full conversation reconstructed as a readable text for the extractor */
  conversationText: string;
}

export function isOpenCodeAvailable(): boolean {
  return existsSync(config.opencode.dbPath);
}

export function getNewSessions(sinceTimestamp?: number): OpenCodeSession[] {
  if (!isOpenCodeAvailable()) return [];

  const db = getSharedDb();
  let query: string;
  let params: any[];

  if (sinceTimestamp) {
    query = `
      SELECT s.id, s.project_id, p.worktree as project_path, s.title, s.time_created as created_at, s.time_updated as updated_at
      FROM session s
      LEFT JOIN project p ON s.project_id = p.id
      WHERE s.time_updated > ?
      ORDER BY s.time_updated ASC
    `;
    params = [sinceTimestamp];
  } else {
    query = `
      SELECT s.id, s.project_id, p.worktree as project_path, s.title, s.time_created as created_at, s.time_updated as updated_at
      FROM session s
      LEFT JOIN project p ON s.project_id = p.id
      ORDER BY s.time_updated ASC
    `;
    params = [];
  }

  const rows = db.prepare(query).all(...params) as any[];

  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    projectPath: row.project_path ?? "",
    title: row.title ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function parseSession(sessionId: string): ParsedSession | null {
  if (!isOpenCodeAvailable()) return null;

  const db = getSharedDb();

  // Get session info
  const sessionRow = db
    .prepare(
      `SELECT s.id, s.project_id, p.worktree as project_path, s.title, s.time_created as created_at, s.time_updated as updated_at
       FROM session s
       LEFT JOIN project p ON s.project_id = p.id
       WHERE s.id = ?`
    )
    .get(sessionId) as any;

  if (!sessionRow) return null;

  const session: OpenCodeSession = {
    id: sessionRow.id,
    projectId: sessionRow.project_id,
    projectPath: sessionRow.project_path ?? "",
    title: sessionRow.title ?? "",
    createdAt: sessionRow.created_at,
    updatedAt: sessionRow.updated_at,
  };

  // Get messages ordered by creation time
  const messageRows = db
    .prepare(
      `SELECT id, data FROM message
       WHERE session_id = ?
       ORDER BY time_created ASC`
    )
    .all(sessionId) as any[];

  const conversation: OpenCodeConversationTurn[] = [];

  for (const msgRow of messageRows) {
    const msgData = JSON.parse(msgRow.data);

    // Get parts for this message
    const partRows = db
      .prepare(
        `SELECT data FROM part
         WHERE message_id = ?
         ORDER BY time_created ASC`
      )
      .all(msgRow.id) as any[];

    const parts: OpenCodePart[] = [];
    for (const partRow of partRows) {
      const partData = JSON.parse(partRow.data);
      const part = parsePartData(partData);
      if (part) parts.push(part);
    }

    conversation.push({
      messageId: msgRow.id,
      role: msgData.role === "user" ? "user" : "assistant",
      createdAt: msgData.time?.created ?? 0,
      model: msgData.modelID,
      cost: msgData.cost,
      parts,
    });
  }

  // Build conversation text for the extractor
  const conversationText = buildConversationText(conversation);

  return { session, conversation, conversationText };
}

function parsePartData(data: any): OpenCodePart | null {
  switch (data.type) {
    case "text":
      return { type: "text", text: data.text ?? "" };
    case "reasoning":
      return { type: "reasoning", text: data.text ?? "" };
    case "tool":
      return {
        type: "tool",
        tool: data.tool ?? "",
        callId: data.callID ?? "",
        status: data.state?.status ?? "",
        title: data.state?.title,
        input: typeof data.state?.input === "string"
          ? data.state.input
          : JSON.stringify(data.state?.input ?? ""),
        output: typeof data.state?.output === "string"
          ? data.state.output
          : JSON.stringify(data.state?.output ?? ""),
      };
    case "patch":
      return { type: "patch", hash: data.hash ?? "", files: data.files ?? [] };
    case "step-start":
      return { type: "step-start" };
    case "step-finish":
      return { type: "step-finish", reason: data.reason, cost: data.cost };
    case "compaction":
      return { type: "compaction", auto: data.auto ?? false };
    case "file":
      return { type: "file", filename: data.filename, mime: data.mime };
    default:
      return null;
  }
}

function buildConversationText(conversation: OpenCodeConversationTurn[]): string {
  const lines: string[] = [];

  for (const turn of conversation) {
    const role = turn.role === "user" ? "USER" : "ASSISTANT";
    lines.push(`\n--- ${role} ---`);

    for (const part of turn.parts) {
      switch (part.type) {
        case "text":
          if (part.text.trim()) lines.push(part.text.trim());
          break;
        case "reasoning":
          if (part.text.trim()) lines.push(`[REASONING] ${part.text.trim()}`);
          break;
        case "tool":
          lines.push(`[TOOL: ${part.tool}] ${part.title ?? ""}`);
          if (part.output && part.output.length < 500) {
            lines.push(`  Output: ${part.output}`);
          }
          break;
        case "patch":
          lines.push(`[COMMIT: ${part.hash}] Files: ${part.files.join(", ")}`);
          break;
        case "compaction":
          lines.push(`[CONTEXT COMPACTED]`);
          break;
        // Skip step-start, step-finish, file — not useful for reasoning extraction
      }
    }
  }

  return lines.join("\n");
}

/**
 * Parse all new sessions since the last sync.
 * Returns parsed sessions ready for the ingestion pipeline.
 */
export function parseNewSessions(sinceTimestamp?: number): ParsedSession[] {
  const sessions = getNewSessions(sinceTimestamp);
  const parsed: ParsedSession[] = [];

  for (const session of sessions) {
    const result = parseSession(session.id);
    if (result && result.conversation.length > 0) {
      parsed.push(result);
    }
  }

  return parsed;
}
