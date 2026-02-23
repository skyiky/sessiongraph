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
export const CHAIN_SOURCES = ["mcp_capture", "backfill", "agent_backfill", "agent"] as const;
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
  metadata?: Record<string, unknown>; // Arbitrary structured data (predictions, agent state, etc.)
  recallCount?: number; // How many times this chain has been recalled (reinforcement signal)
  lastRecalledAt?: Date; // When this chain was last recalled
  referenceCount?: number; // How many other chains reference this one (builds_on, refines, depends_on)
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
  metadata?: Record<string, unknown>;
  recallCount?: number;
  referenceCount?: number;
  createdAt: string;
}

// Configurable weights for hybrid search ranking
export interface SearchWeights {
  vectorSimilarity?: number; // Weight for cosine similarity (default: 0.55)
  textMatch?: number; // Weight for full-text search match (default: 0.15)
  quality?: number; // Weight for quality score (default: 0.15)
  recency?: number; // Weight for recency (default: 0.15)
  salience?: number; // Weight for recall_count + reference_count signal (default: 0)
}

// Preset weight profiles for different use cases
export const SEARCH_WEIGHT_PRESETS = {
  default: { vectorSimilarity: 0.55, textMatch: 0.15, quality: 0.15, recency: 0.15, salience: 0 } as SearchWeights,
  agentCognition: { vectorSimilarity: 0.45, textMatch: 0.15, quality: 0.30, recency: 0.10, salience: 0 } as SearchWeights,
  recentFirst: { vectorSimilarity: 0.35, textMatch: 0.10, quality: 0.10, recency: 0.45, salience: 0 } as SearchWeights,
  qualityFirst: { vectorSimilarity: 0.35, textMatch: 0.10, quality: 0.45, recency: 0.10, salience: 0 } as SearchWeights,
  creative: { vectorSimilarity: 0.35, textMatch: 0.10, quality: 0.15, recency: 0.10, salience: 0.30 } as SearchWeights,
} as const;

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

// ---- Drift: Stochastic Graph Walk ----

/** A single step in a drift walk */
export interface DriftStep {
  chainId: string;
  title: string;
  type: ReasoningType;
  content: string;
  tags: string[];
  quality: number;
  /** How we arrived at this chain from the previous step */
  relationFromPrevious?: RelationType;
  /** Edge confidence (if we followed a graph edge) */
  confidence?: number;
  /** Computed salience score for this chain */
  salience: number;
  /** Whether this step was a "teleport" (loose association jump, not a graph edge) */
  teleport: boolean;
  createdAt: string;
}

/** Result of a drift walk */
export interface DriftResult {
  steps: DriftStep[];
  /** Whether the seed chain was randomly selected */
  seedWasRandom: boolean;
}

// ---- Spreading Activation ----

/** A chain activated via spreading activation through the graph */
export interface ActivatedChain {
  chainId: string;
  title: string;
  type: ReasoningType;
  content: string;
  tags: string[];
  /** Accumulated activation score */
  activation: number;
  /** Chain IDs showing how activation spread to reach this chain */
  activationPath: string[];
  /** Number of hops from the nearest seed */
  hopsFromSeed: number;
  createdAt: string;
}
