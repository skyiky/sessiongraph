export const REASONING_TYPES = [
  "decision",
  "exploration",
  "rejection",
  "solution",
  "insight",
] as const;

export type ChainType = (typeof REASONING_TYPES)[number];

export interface ReasoningChain {
  id: string;
  session_id: string | null;
  user_id: string;
  type: ChainType;
  title: string;
  content: string;
  context: string | null;
  tags: string[];
  created_at: string;
  similarity?: number; // only present in search results
}

export interface Session {
  id: string;
  user_id: string;
  tool: string;
  project: string | null;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  reasoning_chains?: { count: number }[];
}

export interface SessionChunk {
  id: string;
  session_id: string;
  user_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  chunk_index: number;
  created_at: string;
}

export interface DashboardStats {
  totalSessions: number;
  totalChains: number;
  chainsByType: Record<ChainType, number>;
  projectCount: number;
}
