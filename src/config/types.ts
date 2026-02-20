// Reasoning chain types
export const REASONING_TYPES = ["decision", "exploration", "rejection", "solution", "insight"] as const;
export type ReasoningType = (typeof REASONING_TYPES)[number];

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
  table: "sessions" | "reasoning_chains" | "session_chunks";
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
  similarity: number;
  createdAt: string;
}

export interface TimelineEntry {
  sessionId: string;
  tool: string;
  project?: string;
  startedAt: string;
  summary?: string;
  reasoningChains: {
    type: ReasoningType;
    title: string;
    content: string;
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
