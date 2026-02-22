// Reasoning chain types
export const REASONING_TYPES = ["decision", "exploration", "rejection", "solution", "insight"] as const;
export type ReasoningType = (typeof REASONING_TYPES)[number];

// Relation types for the reasoning graph
export const RELATION_TYPES = [
  "leads_to",
  "supersedes",
  "contradicts",
  "builds_on",
  "depends_on",
  "refines",
  "generalizes",
  "analogous_to",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

/** Bidirectional relations — stored in both directions automatically */
export const BIDIRECTIONAL_RELATIONS: readonly RelationType[] = ["contradicts", "analogous_to"];

// Chain source — how a chain was created
export const CHAIN_SOURCES = ["mcp_capture", "backfill", "agent_backfill"] as const;
export type ChainSource = (typeof CHAIN_SOURCES)[number];

// Chain status — lifecycle state
export const CHAIN_STATUSES = ["active", "superseded"] as const;
export type ChainStatus = (typeof CHAIN_STATUSES)[number];

// A relationship between two reasoning chains
export interface ChainRelation {
  id?: string;
  sourceChainId: string;
  targetChainId: string;
  relationType: RelationType;
  confidence?: number; // 0-1, from linker classification
  createdAt?: Date;
}

// Result from getRelatedChains query
export interface RelatedChainResult {
  chainId: string;
  relationType: RelationType;
  direction: "outgoing" | "incoming";
  confidence?: number;
  depth: number; // 1 = direct relation, 2+ = multi-hop
  title: string;
  type: ReasoningType;
  content: string;
  tags: string[];
  createdAt: string;
}

// A chain with its embedding vector (for linking/batch operations)
export interface ChainWithEmbedding {
  id: string;
  title: string;
  content: string;
  type: ReasoningType;
  tags: string[];
  embedding: number[];
}

// A reasoning chain extracted from a session
export interface ReasoningChain {
  id?: string;
  sessionId: string | null;
  userId: string;
  type: ReasoningType;
  title: string;
  content: string;
  context?: string;
  tags: string[];
  embedding?: number[];
  quality?: number; // 0-1, defaults to 1.0. Real-time capture = 1.0, Ollama backfill = 0.6
  project?: string; // Direct project association (independent of session)
  source?: ChainSource; // How this chain was created
  status?: ChainStatus; // Lifecycle state (active, superseded)
  createdAt?: Date;
}

// A session from an AI tool
export interface Session {
  id?: string;
  userId: string;
  tool: string; // "opencode", "claude-code", "aider", etc.
  project?: string;
  startedAt: Date;
  endedAt?: Date;
  summary?: string;
  metadata: Record<string, unknown>;
  createdAt?: Date;
}

// A raw chunk of conversation (for reference/replay)
export interface SessionChunk {
  id?: string;
  sessionId: string;
  userId: string;
  role: "user" | "assistant" | "system";
  content: string;
  chunkIndex: number;
  createdAt?: Date;
}

// User profile
export interface UserProfile {
  id: string;
  apiKey: string;
  settings: Record<string, unknown>;
  createdAt?: Date;
}

// Auth state stored locally
export interface AuthState {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string;
  expiresAt: number;
}

// Buffer queue item (for offline sync)
export interface BufferItem {
  id: number;
  table: "sessions" | "reasoning_chains" | "session_chunks" | "chain_relations";
  operation: "insert" | "update" | "delete";
  data: string; // JSON serialized
  createdAt: number; // unix ms
  syncedAt?: number;
  retries: number;
  lastError?: string;
}

// MCP tool responses
export interface RecallResult {
  id: string;
  sessionId: string;
  type: ReasoningType;
  title: string;
  content: string;
  context?: string;
  tags: string[];
  similarity: number; // Raw cosine similarity
  score: number; // Blended ranking score (vector + text + quality + recency)
  quality: number; // 0-1 quality score
  project?: string;
  source?: ChainSource;
  status?: ChainStatus;
  createdAt: string;
}

export interface TimelineEntry {
  sessionId: string;
  tool: string;
  project?: string;
  startedAt: string;
  endedAt?: string;
  summary?: string;
  reasoningChains: {
    id: string;
    type: ReasoningType;
    title: string;
    content: string;
    tags: string[];
    quality: number;
    project?: string;
    source?: ChainSource;
    status?: ChainStatus;
    createdAt: string;
  }[];
}

export interface SessionListEntry {
  id: string;
  tool: string;
  project?: string;
  startedAt: string;
  endedAt?: string;
  summary?: string;
  chainCount: number;
}
