import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  getStorageProvider,
  getEmbeddingProvider,
  resetProviders,
  type StorageProvider,
  type EmbeddingProvider,
} from "../storage/provider.ts";
import { REASONING_TYPES, RELATION_TYPES, BIDIRECTIONAL_RELATIONS, SEARCH_WEIGHT_PRESETS } from "../config/types.ts";
import type { RelationType, ChainSource, ChainStatus, SearchWeights } from "../config/types.ts";
import { config } from "../config/config.ts";
import { loadAuth } from "../auth/auth.ts";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { isOpenCodeAvailable, getNewSessions as getOpenCodeSessions, parseSession as parseOpenCodeSession } from "../ingestion/parsers/opencode.ts";
import { isClaudeCodeAvailable, getNewSessions as getClaudeCodeSessions, parseSession as parseClaudeCodeSession } from "../ingestion/parsers/claude-code.ts";
import { loadBackfillState, saveBackfillState, markSessionBackfilled } from "../backfill/backfill.ts";
import type { BackfillState } from "../backfill/backfill.ts";

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
      context: z.string().optional().describe("Additional context about when/where this reasoning occurred (e.g. file paths, error messages, environment details)"),
      related_to: z.array(z.object({
        chain_id: z.string().describe("ID of an existing reasoning chain to link to"),
        relation: z.enum(RELATION_TYPES).describe("Type of relationship: leads_to, supersedes, contradicts, builds_on, depends_on, refines, generalizes, analogous_to"),
      })).default([]).describe("Optional links to existing reasoning chains. Use chain IDs from recall results."),
    }),
  },
  async (input) => {
    const { userId, storage, embeddings } = await ensureReady();

    // Generate embedding for the content (include tags for better semantic matching)
    const embeddingParts = [input.title, input.content];
    if (input.tags.length > 0) embeddingParts.push(input.tags.join(", "));
    const embeddingText = embeddingParts.join("\n");
    const embedding = await embeddings.generateEmbedding(embeddingText);

    const id = await storage.insertReasoningChain({
      sessionId: null, // No session for explicit remember calls
      userId,
      type: input.type,
      title: input.title,
      content: input.content,
      context: input.context,
      tags: input.tags,
      embedding,
      project: input.project,
      source: "mcp_capture" as ChainSource,
      status: "active",
    });

    // Create relations if specified
    let relationsCreated = 0;
    if (input.related_to.length > 0) {
      const relations = [];
      for (const link of input.related_to) {
        // New chain is the source, existing chain is the target
        relations.push({
          sourceChainId: id,
          targetChainId: link.chain_id,
          relationType: link.relation as RelationType,
        });
        // For bidirectional relations, also store the reverse
        if (BIDIRECTIONAL_RELATIONS.includes(link.relation as RelationType)) {
          relations.push({
            sourceChainId: link.chain_id,
            targetChainId: id,
            relationType: link.relation as RelationType,
          });
        }
      }
      await storage.insertChainRelations(relations);
      relationsCreated = input.related_to.length;
    }

    const relationMsg = relationsCreated > 0
      ? `\nLinked to ${relationsCreated} existing chain(s).`
      : "";

    return {
      content: [
        {
          type: "text" as const,
          text: `Remembered: "${input.title}" (${input.type})\nID: ${id}${relationMsg}`,
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
      spread: z.boolean().default(false).describe("Enable spreading activation to find serendipitous connections. Returns additional 'associatively connected' results beyond direct matches, discovered by following graph edges from search results."),
      weights: z.object({
        vectorSimilarity: z.number().optional().describe("Weight for vector similarity (default: 0.55)"),
        textMatch: z.number().optional().describe("Weight for text match (default: 0.15)"),
        quality: z.number().optional().describe("Weight for quality score (default: 0.15)"),
        recency: z.number().optional().describe("Weight for recency (default: 0.15)"),
        salience: z.number().optional().describe("Weight for recall/reference count signal (default: 0). Higher values favor frequently-recalled and highly-connected chains."),
      }).optional().describe("Custom search ranking weights. Use preset 'agentCognition' for durable mental models (quality=0.30, recency=0.10)."),
      weightPreset: z.enum(["default", "agentCognition", "recentFirst", "qualityFirst", "creative"]).optional().describe("Use a preset weight profile instead of custom weights. 'creative' heavily weights salience (recall_count + reference_count) for serendipitous retrieval."),
    }),
  },
  async (input) => {
    const { userId, storage, embeddings } = await ensureReady();

    // Resolve weights: explicit > preset > default
    let resolvedWeights: SearchWeights | undefined;
    if (input.weights) {
      resolvedWeights = input.weights;
    } else if (input.weightPreset) {
      resolvedWeights = SEARCH_WEIGHT_PRESETS[input.weightPreset];
    }

    // Generate embedding for the query
    const queryEmbedding = await embeddings.generateEmbedding(input.query);

    const results = await storage.searchReasoning({
      queryEmbedding,
      queryText: input.query,
      userId,
      project: input.project,
      matchThreshold: 0.3,
      limit: input.limit,
      weights: resolvedWeights,
    });

    // Touch recalled chains to track reinforcement signal
    if (results.length > 0) {
      await storage.touchChains(results.map((r) => r.id));
    }

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
          `ID: ${r.id}\n` +
          `Score: ${(r.score * 100).toFixed(1)}% | Similarity: ${(r.similarity * 100).toFixed(1)}% | Quality: ${(r.quality * 100).toFixed(0)}%\n` +
          (r.recallCount ? `Recalls: ${r.recallCount} | ` : "") +
          (r.referenceCount ? `References: ${r.referenceCount} | ` : "") +
          (r.project ? `Project: ${r.project}\n` : "") +
          (r.source ? `Source: ${r.source}\n` : "") +
          `${r.content}\n` +
          (r.tags.length > 0 ? `Tags: ${r.tags.join(", ")}\n` : "") +
          (r.metadata && Object.keys(r.metadata).length > 0 ? `Metadata: ${JSON.stringify(r.metadata)}\n` : "") +
          `Date: ${r.createdAt}`
      )
      .join("\n\n---\n\n");

    // Spreading activation: find serendipitous connections via graph edges
    let spreadSection = "";
    if (input.spread && results.length > 0) {
      try {
        const activated = await storage.spreadActivation({
          initialChainIds: results.map((r) => r.id),
          initialScores: results.map((r) => r.score),
          hops: 2,
          decayFactor: 0.5,
          minActivation: 0.1,
          limit: 3,
        });

        if (activated.length > 0) {
          const activatedFormatted = activated
            .map(
              (a, i) =>
                `## S${i + 1}. [${a.type.toUpperCase()}] ${a.title}\n` +
                `ID: ${a.chainId}\n` +
                `Activation: ${(a.activation * 100).toFixed(1)}% | ${a.hopsFromSeed} hop(s) from search results\n` +
                `Path: ${a.activationPath.map((id) => id.slice(0, 8)).join(" → ")}\n` +
                `${a.content}\n` +
                (a.tags.length > 0 ? `Tags: ${a.tags.join(", ")}\n` : "") +
                `Date: ${a.createdAt}`
            )
            .join("\n\n---\n\n");

          spreadSection = `\n\n===\n\n**Serendipitous connections** (via spreading activation):\n\n${activatedFormatted}`;
        }
      } catch {
        // Spreading activation is best-effort — don't fail the entire recall
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${results.length} relevant reasoning chains:\n\n${formatted}${spreadSection}`,
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

// ---- Tool: graph ----
server.registerTool(
  "graph",
  {
    description:
      "Explore the reasoning graph — find chains related to a given chain by following relationship edges. Returns connected chains with their relationship types and directions. Use chain IDs from recall or remember results.",
    inputSchema: z.object({
      chain_id: z.string().uuid().describe("The ID of the reasoning chain to explore connections for"),
      relation_type: z.enum(RELATION_TYPES).optional().describe("Filter to a specific relation type (e.g. 'builds_on', 'contradicts')"),
      depth: z.number().min(1).max(3).default(1).describe("How many hops to traverse (1 = direct, 2-3 = multi-hop). Default: 1"),
      limit: z.number().default(20).describe("Maximum number of related chains to return"),
    }),
  },
  async (input) => {
    const { storage } = await ensureReady();

    const results = await storage.getRelatedChains({
      chainId: input.chain_id,
      relationType: input.relation_type as RelationType | undefined,
      depth: input.depth,
      limit: input.limit,
    });

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No related chains found for chain ${input.chain_id}.`,
          },
        ],
      };
    }

    const formatted = results
      .map(
        (r, i) =>
          `## ${i + 1}. ${r.direction === "outgoing" ? "→" : "←"} [${r.relationType}] ${r.title}\n` +
          `Chain ID: ${r.chainId}\n` +
          `Type: ${r.type} | Direction: ${r.direction} | Depth: ${r.depth}` +
          (r.confidence != null ? ` | Confidence: ${(r.confidence * 100).toFixed(0)}%` : "") +
          `\n` +
          `${r.content}\n` +
          (r.tags.length > 0 ? `Tags: ${r.tags.join(", ")}\n` : "") +
          `Date: ${r.createdAt}`
      )
      .join("\n\n---\n\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${results.length} related chain(s) for ${input.chain_id}:\n\n${formatted}`,
        },
      ],
    };
  }
);

// ---- Tool: drift ----
server.registerTool(
  "drift",
  {
    description:
      "Take a stochastic random walk through your reasoning graph. Returns a chain of associatively connected memories — like a train of thought. " +
      "Use this for creative exploration, finding unexpected connections, or when you want inspiration without a specific query. " +
      "Each step follows graph edges probabilistically, with occasional 'teleport' jumps to moderately similar but unconnected chains (simulating loose associations). " +
      "Lower temperature = more coherent walks following strong edges. Higher temperature = more random, creative walks.",
    inputSchema: z.object({
      seed_chain_id: z.string().uuid().optional().describe("Starting chain ID. If omitted, a random chain is selected weighted by salience (recall frequency + connectivity)."),
      steps: z.number().min(1).max(20).default(5).describe("Number of steps to walk (default: 5)"),
      temperature: z.number().min(0).max(1).default(0.7).describe("Stochasticity: 0.0 = always follow strongest edge, 1.0 = near-uniform random (default: 0.7)"),
      project: z.string().optional().describe("Constrain walk to chains in this project"),
    }),
  },
  async (input) => {
    const { userId, storage } = await ensureReady();

    let result;
    try {
      result = await storage.driftWalk({
        userId,
        seedChainId: input.seed_chain_id,
        steps: input.steps,
        temperature: input.temperature,
        project: input.project,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: `Drift walk failed: ${message}`,
          },
        ],
      };
    }

    if (result.steps.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No chains found for drift walk. The reasoning graph may be empty.",
          },
        ],
      };
    }

    const formatted = result.steps
      .map((step, i) => {
        const prefix = i === 0
          ? `## Step ${i + 1} (seed${result.seedWasRandom ? ", randomly selected" : ""})`
          : step.teleport
            ? `## Step ${i + 1} ⟿ TELEPORT (loose association jump)`
            : `## Step ${i + 1} → [${step.relationFromPrevious}]${step.confidence != null ? ` (${(step.confidence * 100).toFixed(0)}% confidence)` : ""}`;

        return (
          `${prefix}\n` +
          `**[${step.type.toUpperCase()}] ${step.title}**\n` +
          `ID: ${step.chainId}\n` +
          `Quality: ${(step.quality * 100).toFixed(0)}% | Salience: ${step.salience.toFixed(2)}\n` +
          `${step.content}\n` +
          (step.tags.length > 0 ? `Tags: ${step.tags.join(", ")}\n` : "") +
          `Date: ${step.createdAt}`
        );
      })
      .join("\n\n---\n\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `Drift walk (${result.steps.length} steps, temperature=${input.temperature}):\n\n${formatted}`,
        },
      ],
    };
  }
);

// ---- Tool: update_chain ----
server.registerTool(
  "update_chain",
  {
    description:
      "Update mutable fields on an existing reasoning chain. Use this to update tags, quality, metadata, or status. Useful for tracking prediction outcomes, adding structured data, or manually adjusting chain quality.",
    inputSchema: z.object({
      chain_id: z.string().uuid().describe("The ID of the reasoning chain to update"),
      tags: z.array(z.string()).optional().describe("Replace the chain's tags with these new tags"),
      quality: z.number().min(0).max(1).optional().describe("Set the chain's quality score (0-1)"),
      status: z.enum(["active", "superseded"]).optional().describe("Set the chain's lifecycle status"),
      metadata: z.record(z.string(), z.unknown()).optional().describe("Set or replace the chain's structured metadata (e.g. prediction state, deadlines)"),
    }),
  },
  async (input) => {
    const { storage } = await ensureReady();

    const updates: {
      tags?: string[];
      quality?: number;
      metadata?: Record<string, unknown>;
      status?: ChainStatus;
    } = {};

    if (input.tags !== undefined) updates.tags = input.tags;
    if (input.quality !== undefined) updates.quality = input.quality;
    if (input.metadata !== undefined) updates.metadata = input.metadata;
    if (input.status !== undefined) updates.status = input.status;

    if (Object.keys(updates).length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No updates provided. Specify at least one field to update (tags, quality, status, or metadata).",
          },
        ],
      };
    }

    await storage.updateChain(input.chain_id, updates);

    const updatedFields = Object.keys(updates).join(", ");
    return {
      content: [
        {
          type: "text" as const,
          text: `Updated chain ${input.chain_id}: ${updatedFields}`,
        },
      ],
    };
  }
);

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
      markSessionBackfilled(state, input.sessionId);
    }

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

// ---- Graceful shutdown ----
let isShuttingDown = false;

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.error(`\nReceived ${signal}, shutting down...`);
  try {
    await resetProviders();
  } catch (err) {
    console.error("Error during shutdown:", err);
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("beforeExit", () => shutdown("beforeExit"));

// Catch unexpected crashes — attempt checkpoint + backup before dying
process.on("uncaughtException", async (err) => {
  console.error("Uncaught exception:", err);
  await shutdown("uncaughtException");
});

process.on("unhandledRejection", async (reason) => {
  console.error("Unhandled rejection:", reason);
  await shutdown("unhandledRejection");
});

main().catch((err) => {
  console.error("Fatal error:", err);
  shutdown("fatal").finally(() => process.exit(1));
});
