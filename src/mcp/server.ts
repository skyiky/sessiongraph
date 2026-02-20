import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  getStorageProvider,
  getEmbeddingProvider,
  type StorageProvider,
  type EmbeddingProvider,
} from "../storage/provider.ts";
import { REASONING_TYPES } from "../config/types.ts";
import { config } from "../config/config.ts";
import { loadAuth } from "../auth/auth.ts";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { isOpenCodeAvailable, getNewSessions as getOpenCodeSessions, parseSession as parseOpenCodeSession } from "../ingestion/parsers/opencode.ts";
import { isClaudeCodeAvailable, getNewSessions as getClaudeCodeSessions, parseSession as parseClaudeCodeSession } from "../ingestion/parsers/claude-code.ts";

const server = new McpServer({
  name: "sessiongraph",
  version: "0.2.0",
});

let currentUserId: string | null = null;
let storage: StorageProvider | null = null;
let embeddings: EmbeddingProvider | null = null;

/**
 * Ensure providers are initialized and auth is set up.
 * - Local mode: no auth needed, uses fixed local user ID.
 * - Cloud mode: loads auth.json and sets Supabase session.
 */
async function ensureReady(): Promise<{ userId: string; storage: StorageProvider; embeddings: EmbeddingProvider }> {
  // Initialize providers lazily
  if (!storage) storage = await getStorageProvider();
  if (!embeddings) embeddings = await getEmbeddingProvider();

  if (currentUserId) {
    return { userId: currentUserId, storage, embeddings };
  }

  if (config.storage.mode === "local") {
    // Local mode: no auth, fixed user ID
    currentUserId = "00000000-0000-0000-0000-000000000000";
  } else {
    // Cloud mode: authenticate with Supabase
    const auth = await loadAuth();
    if (!auth) {
      throw new Error("Not authenticated. Run 'sessiongraph login' first.");
    }

    // Set auth on the Supabase provider
    const { SupabaseStorageProvider } = await import("../storage/supabase-provider.ts");
    if (storage instanceof SupabaseStorageProvider) {
      await storage.setAuth(auth.accessToken, auth.refreshToken);
    }

    currentUserId = auth.userId;
  }

  return { userId: currentUserId, storage, embeddings };
}

// ---- Tool: remember ----
server.registerTool(
  "remember",
  {
    description:
      "Save an important reasoning chain, decision, insight, or learning from the current session. Use this when you make a significant decision, reject an approach, solve a problem, or learn something worth preserving.",
    inputSchema: z.object({
      content: z.string().describe("The reasoning, decision, or insight to remember. Be detailed — include context, alternatives considered, and rationale."),
      type: z.enum(REASONING_TYPES).default("insight").describe("Type of reasoning: decision (chose X over Y), exploration (comparing options), rejection (ruled out X because Y), solution (fixed problem X), insight (learned something)"),
      title: z.string().describe("A short title summarizing the reasoning (1 sentence)"),
      tags: z.array(z.string()).default([]).describe("Optional tags for categorization (e.g. 'database', 'architecture', 'performance')"),
      project: z.string().optional().describe("Project name or path this reasoning relates to"),
    }),
  },
  async (input) => {
    const { userId, storage, embeddings } = await ensureReady();

    // Generate embedding for the content
    const embeddingText = `${input.title}\n${input.content}`;
    const embedding = await embeddings.generateEmbedding(embeddingText);

    const id = await storage.insertReasoningChain({
      sessionId: null, // No session for explicit remember calls
      userId,
      type: input.type,
      title: input.title,
      content: input.content,
      tags: input.tags,
      embedding,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Remembered: "${input.title}" (${input.type})\nID: ${id}`,
        },
      ],
    };
  }
);

// ---- Tool: recall ----
server.registerTool(
  "recall",
  {
    description:
      "Search your reasoning history for relevant past decisions, insights, and solutions. Use this when you need context about why something was done a certain way, what approaches were tried before, or what you learned previously.",
    inputSchema: z.object({
      query: z.string().describe("What you're looking for — describe the topic, decision, or problem you want to recall context about"),
      project: z.string().optional().describe("Filter to a specific project"),
      type: z.enum(REASONING_TYPES).optional().describe("Filter by reasoning type"),
      limit: z.number().default(5).describe("Maximum number of results to return"),
    }),
  },
  async (input) => {
    const { userId, storage, embeddings } = await ensureReady();

    // Generate embedding for the query
    const queryEmbedding = await embeddings.generateEmbedding(input.query);

    const results = await storage.searchReasoning({
      queryEmbedding,
      userId,
      project: input.project,
      matchThreshold: 0.5,
      limit: input.limit,
    });

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No relevant reasoning chains found for this query.",
          },
        ],
      };
    }

    const formatted = results
      .map(
        (r, i) =>
          `## ${i + 1}. [${r.type.toUpperCase()}] ${r.title}\n` +
          `Similarity: ${(r.similarity * 100).toFixed(1)}%\n` +
          `${r.content}\n` +
          (r.tags.length > 0 ? `Tags: ${r.tags.join(", ")}\n` : "") +
          `Date: ${r.createdAt}`
      )
      .join("\n\n---\n\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${results.length} relevant reasoning chains:\n\n${formatted}`,
        },
      ],
    };
  }
);

// ---- Tool: timeline ----
server.registerTool(
  "timeline",
  {
    description:
      "View a chronological timeline of recent AI sessions and the decisions/reasoning captured from them. Use this to get an overview of recent work and context.",
    inputSchema: z.object({
      project: z.string().optional().describe("Filter to a specific project"),
      since: z.string().optional().describe("ISO date string — only show sessions after this date"),
      limit: z.number().default(10).describe("Maximum number of sessions to show"),
    }),
  },
  async (input) => {
    const { userId, storage } = await ensureReady();

    const entries = await storage.getTimeline({
      userId,
      project: input.project,
      since: input.since,
      limit: input.limit,
    });

    if (entries.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No sessions found in the timeline.",
          },
        ],
      };
    }

    const formatted = entries
      .map((entry) => {
        const chains = entry.reasoningChains
          .map((c) => `  - [${c.type.toUpperCase()}] ${c.title}`)
          .join("\n");

        return (
          `## ${entry.startedAt} — ${entry.tool}` +
          (entry.project ? ` (${entry.project})` : "") +
          "\n" +
          (entry.summary ? `${entry.summary}\n` : "") +
          (chains ? `\nReasoning chains:\n${chains}` : "\nNo reasoning chains captured.")
        );
      })
      .join("\n\n---\n\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `Timeline (${entries.length} sessions):\n\n${formatted}`,
        },
      ],
    };
  }
);

// ---- Tool: sessions ----
server.registerTool(
  "sessions",
  {
    description:
      "Browse past AI coding sessions. Lists sessions with their tools, projects, and number of captured reasoning chains.",
    inputSchema: z.object({
      project: z.string().optional().describe("Filter to a specific project"),
      tool: z.string().optional().describe("Filter by AI tool (e.g. 'opencode', 'claude-code', 'aider')"),
      limit: z.number().default(20).describe("Maximum number of sessions to return"),
    }),
  },
  async (input) => {
    const { userId, storage } = await ensureReady();

    const sessions = await storage.listSessions({
      userId,
      project: input.project,
      tool: input.tool,
      limit: input.limit,
    });

    if (sessions.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No sessions found.",
          },
        ],
      };
    }

    const formatted = sessions
      .map(
        (s) =>
          `- **${s.startedAt}** | ${s.tool}` +
          (s.project ? ` | ${s.project}` : "") +
          ` | ${s.chainCount} reasoning chains` +
          (s.summary ? `\n  ${s.summary}` : "")
      )
      .join("\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `Sessions (${sessions.length}):\n\n${formatted}`,
        },
      ],
    };
  }
);

// ---- Backfill state helpers ----

const BACKFILL_STATE_PATH = join(config.paths.dataDir, "backfill-state.json");

function loadBackfillState(): { backfilledSessionIds: string[] } {
  try {
    if (existsSync(BACKFILL_STATE_PATH)) {
      return JSON.parse(readFileSync(BACKFILL_STATE_PATH, "utf-8"));
    }
  } catch {}
  return { backfilledSessionIds: [] };
}

function saveBackfillState(state: { backfilledSessionIds: string[] }): void {
  const dir = config.paths.dataDir;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(BACKFILL_STATE_PATH, JSON.stringify(state, null, 2));
}

// ---- Tool: get_sessions_to_backfill ----
server.registerTool(
  "get_sessions_to_backfill",
  {
    description:
      "Get a batch of past AI coding sessions that haven't been backfilled yet. Returns session conversation text for you to read and extract reasoning chains from using the remember tool.",
    inputSchema: z.object({
      limit: z.number().default(3).describe("Number of sessions to return in this batch (keep small to stay within context)"),
      tool: z.enum(["opencode", "claude-code"]).optional().describe("Filter to a specific AI tool"),
    }),
  },
  async (input) => {
    await ensureReady();

    const state = loadBackfillState();
    const backfilledSet = new Set(state.backfilledSessionIds);

    // Collect sessions from available parsers
    const candidates: Array<{
      id: string;
      tool: string;
      project: string;
      startedAt: string;
    }> = [];

    if ((!input.tool || input.tool === "opencode") && isOpenCodeAvailable()) {
      const sessions = getOpenCodeSessions();
      for (const s of sessions) {
        if (!backfilledSet.has(s.id)) {
          candidates.push({
            id: s.id,
            tool: "opencode",
            project: s.projectPath,
            startedAt: new Date(s.createdAt).toISOString(),
          });
        }
      }
    }

    if ((!input.tool || input.tool === "claude-code") && isClaudeCodeAvailable()) {
      const sessions = getClaudeCodeSessions();
      for (const s of sessions) {
        if (!backfilledSet.has(s.id)) {
          candidates.push({
            id: s.id,
            tool: "claude-code",
            project: s.project,
            startedAt: new Date(s.startedAt).toISOString(),
          });
        }
      }
    }

    if (candidates.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No sessions to backfill. All sessions have already been processed.",
          },
        ],
      };
    }

    // Take first `limit` sessions
    const batch = candidates.slice(0, input.limit);
    const parts: string[] = [];

    for (const candidate of batch) {
      let conversationText = "";

      if (candidate.tool === "opencode") {
        const parsed = parseOpenCodeSession(candidate.id);
        conversationText = parsed?.conversationText ?? "[Could not parse session]";
      } else if (candidate.tool === "claude-code") {
        const parsed = parseClaudeCodeSession(candidate.id);
        conversationText = parsed?.conversationText ?? "[Could not parse session]";
      }

      parts.push(
        `=== Session: ${candidate.id} ===\n` +
        `Tool: ${candidate.tool}\n` +
        `Project: ${candidate.project}\n` +
        `Started: ${candidate.startedAt}\n\n` +
        `${conversationText}\n\n` +
        `---`
      );
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${candidates.length} sessions to backfill. Returning batch of ${batch.length}:\n\n${parts.join("\n\n")}`,
        },
      ],
    };
  }
);

// ---- Tool: mark_session_backfilled ----
server.registerTool(
  "mark_session_backfilled",
  {
    description:
      "Mark a session as backfilled after you've extracted and remembered its reasoning chains. Call this after processing each session from get_sessions_to_backfill.",
    inputSchema: z.object({
      sessionId: z.string().describe("The session ID to mark as backfilled"),
    }),
  },
  async (input) => {
    const state = loadBackfillState();

    // Deduplicate
    if (!state.backfilledSessionIds.includes(input.sessionId)) {
      state.backfilledSessionIds.push(input.sessionId);
    }

    saveBackfillState(state);

    return {
      content: [
        {
          type: "text" as const,
          text: `Marked session ${input.sessionId} as backfilled. Total backfilled sessions: ${state.backfilledSessionIds.length}`,
        },
      ],
    };
  }
);

// ---- Start Server ----
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `SessionGraph MCP server running on stdio (${config.storage.mode} mode)`
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
