import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { config } from "../../config/config.ts";

// --- Types ---

export interface ClaudeCodeSession {
  id: string;         // session UUID
  project: string;    // original CWD (from history.jsonl)
  title: string;      // display name (from history.jsonl)
  startedAt: number;  // unix ms
  updatedAt: number;  // unix ms
}

export interface ClaudeCodeMessage {
  type: "human" | "assistant" | "tool_result" | "tool_use";
  role: string;
  content: string;      // extracted text content
  timestamp: number;    // unix ms
  toolName?: string;    // for tool_use/tool_result
  toolInput?: string;   // for tool_use
}

export interface ParsedClaudeCodeSession {
  session: ClaudeCodeSession;
  messages: ClaudeCodeMessage[];
  conversationText: string;
}

// --- Raw JSONL types (internal) ---

interface HistoryEntry {
  id: string;
  display: string;
  timestamp: string;
  project: string;
  sessionId: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
}

interface RawSessionLine {
  type: "human" | "assistant" | "tool_result";
  message: {
    role: string;
    content: ContentBlock[];
  };
  timestamp: string;
}

// --- Public API ---

export function isClaudeCodeAvailable(): boolean {
  return existsSync(config.claudeCode.projectsDir);
}

export function getNewSessions(sinceTimestamp?: number): ClaudeCodeSession[] {
  const index = getHistoryIndex();
  const sessions: ClaudeCodeSession[] = [];

  for (const session of index.values()) {
    if (sinceTimestamp && session.startedAt <= sinceTimestamp) continue;
    sessions.push(session);
  }

  return sessions;
}

export function parseSession(sessionId: string): ParsedClaudeCodeSession | null {
  const filePath = findSessionFile(sessionId);
  if (!filePath) return null;

  const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);

  // Try to find session info from history
  const sessionInfo = findSessionInfo(sessionId);
  if (!sessionInfo) return null;

  return parseSessionFromLines(lines, sessionInfo);
}

/**
 * Parse raw JSONL lines into a structured session.
 * Exported for direct testing without filesystem access.
 */
export function parseSessionFromLines(
  lines: string[],
  sessionInfo: ClaudeCodeSession,
): ParsedClaudeCodeSession {
  const messages: ClaudeCodeMessage[] = [];

  for (const line of lines) {
    try {
      const raw = JSON.parse(line) as RawSessionLine;
      const ts = new Date(raw.timestamp).getTime();
      const contentBlocks = raw.message?.content ?? [];

      if (raw.type === "assistant") {
        // Assistant messages can contain mixed text and tool_use blocks
        for (const block of contentBlocks) {
          if (block.type === "text" && block.text) {
            messages.push({
              type: "assistant",
              role: "assistant",
              content: block.text,
              timestamp: ts,
            });
          } else if (block.type === "tool_use") {
            messages.push({
              type: "tool_use",
              role: "assistant",
              content: "",
              timestamp: ts,
              toolName: block.name,
              toolInput: summarizeToolInput(block.input),
            });
          }
        }
      } else if (raw.type === "human") {
        const text = extractTextContent(contentBlocks);
        if (text) {
          messages.push({
            type: "human",
            role: "user",
            content: text,
            timestamp: ts,
          });
        }
      } else if (raw.type === "tool_result") {
        const text = extractTextContent(contentBlocks);
        messages.push({
          type: "tool_result",
          role: "tool",
          content: text,
          timestamp: ts,
          toolName: undefined, // tool_result doesn't carry tool name directly
        });
      }
    } catch {
      console.error("Skipping malformed session line:", line.slice(0, 100));
    }
  }

  // Update session timestamps from messages
  const session = { ...sessionInfo };
  if (messages.length > 0) {
    const timestamps = messages.map((m) => m.timestamp).filter((t) => !isNaN(t));
    if (timestamps.length > 0) {
      session.startedAt = Math.min(...timestamps);
      session.updatedAt = Math.max(...timestamps);
    }
  }

  const conversationText = buildConversationText(messages);

  return { session, messages, conversationText };
}

/**
 * Parse all new sessions since the last sync.
 * Returns parsed sessions ready for the ingestion pipeline.
 */
export function parseNewSessions(sinceTimestamp?: number): ParsedClaudeCodeSession[] {
  const sessions = getNewSessions(sinceTimestamp);
  const parsed: ParsedClaudeCodeSession[] = [];

  for (const session of sessions) {
    const result = parseSession(session.id);
    if (result && result.messages.length > 0) {
      parsed.push(result);
    }
  }

  return parsed;
}

// --- Cached history index ---

/** Cached map of sessionId → ClaudeCodeSession from history.jsonl. Lazily built once. */
let historyCache: Map<string, ClaudeCodeSession> | null = null;
let historyCachePath: string | null = null;

function getHistoryIndex(): Map<string, ClaudeCodeSession> {
  const historyPath = config.claudeCode.historyPath;

  // Invalidate cache if the path changed (shouldn't happen, but defensive)
  if (historyCache && historyCachePath === historyPath) {
    return historyCache;
  }

  const map = new Map<string, ClaudeCodeSession>();
  if (!existsSync(historyPath)) {
    historyCache = map;
    historyCachePath = historyPath;
    return map;
  }

  const lines = readFileSync(historyPath, "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as HistoryEntry;
      const ts = new Date(entry.timestamp).getTime();
      map.set(entry.sessionId, {
        id: entry.sessionId,
        project: entry.project,
        title: entry.display,
        startedAt: ts,
        updatedAt: ts,
      });
    } catch {
      // skip malformed
    }
  }

  historyCache = map;
  historyCachePath = historyPath;
  return map;
}

/** Clear the cached history index (useful for testing or after new sessions arrive). */
export function clearHistoryCache(): void {
  historyCache = null;
  historyCachePath = null;
}

// --- Internal helpers ---

function extractTextContent(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n");
}

function summarizeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) return "";

  // For common tools, extract the most relevant field
  if (typeof input.command === "string") return input.command;
  if (typeof input.filePath === "string") return input.filePath;
  if (typeof input.path === "string") return input.path;
  if (typeof input.pattern === "string") return input.pattern;
  if (typeof input.query === "string") return input.query;
  if (typeof input.url === "string") return input.url;

  // Fallback: compact JSON (truncated)
  const json = JSON.stringify(input);
  return json.length > 200 ? json.slice(0, 200) + "..." : json;
}

function findSessionFile(sessionId: string): string | null {
  const projectsDir = config.claudeCode.projectsDir;
  if (!existsSync(projectsDir)) return null;

  try {
    const projectDirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const dir of projectDirs) {
      const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    console.error("Error scanning projects directory");
  }

  return null;
}

function findSessionInfo(sessionId: string): ClaudeCodeSession | null {
  const index = getHistoryIndex();
  return index.get(sessionId) ?? null;
}

function buildConversationText(messages: ClaudeCodeMessage[]): string {
  const lines: string[] = [];
  let lastRole: string | null = null;

  for (const msg of messages) {
    // Emit role header when the role changes
    if (msg.type === "human" && lastRole !== "user") {
      lines.push("\n--- USER ---");
      lastRole = "user";
    } else if ((msg.type === "assistant" || msg.type === "tool_use") && lastRole !== "assistant") {
      lines.push("\n--- ASSISTANT ---");
      lastRole = "assistant";
    }

    switch (msg.type) {
      case "human":
        if (msg.content.trim()) lines.push(msg.content.trim());
        break;
      case "assistant":
        if (msg.content.trim()) lines.push(msg.content.trim());
        break;
      case "tool_use":
        lines.push(`[TOOL: ${msg.toolName}] ${msg.toolInput ?? ""}`);
        break;
      case "tool_result":
        // Tool results go under assistant context (tool output)
        if (msg.content.trim() && msg.content.length < 500) {
          lines.push(`  Output: ${msg.content.trim()}`);
        }
        break;
    }
  }

  return lines.join("\n");
}
