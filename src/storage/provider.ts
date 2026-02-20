import type {
  ReasoningChain,
  RecallResult,
  Session,
  SessionChunk,
  SessionListEntry,
  TimelineEntry,
} from "../config/types.ts";

// ---- Storage Provider Interface ----

export interface ListSessionsOpts {
  userId: string;
  project?: string;
  tool?: string;
  limit?: number;
}

export interface SearchReasoningOpts {
  queryEmbedding: number[];
  userId: string;
  project?: string;
  type?: string;
  matchThreshold?: number;
  limit?: number;
}

export interface TimelineOpts {
  userId: string;
  project?: string;
  since?: string;
  limit?: number;
}

/**
 * StorageProvider abstracts where data lives (PGlite local vs Supabase cloud).
 * Both implementations share the same Postgres SQL dialect thanks to PGlite.
 */
export interface StorageProvider {
  readonly mode: "local" | "cloud";

  /** One-time setup: create tables, extensions, indexes */
  initialize(): Promise<void>;

  /** Clean shutdown */
  close(): Promise<void>;

  // ---- Sessions ----
  upsertSession(session: Session): Promise<string>;
  listSessions(opts: ListSessionsOpts): Promise<SessionListEntry[]>;

  // ---- Reasoning Chains ----
  insertReasoningChain(chain: ReasoningChain): Promise<string>;
  insertReasoningChains(chains: ReasoningChain[]): Promise<string[]>;
  searchReasoning(opts: SearchReasoningOpts): Promise<RecallResult[]>;

  // ---- Timeline ----
  getTimeline(opts: TimelineOpts): Promise<TimelineEntry[]>;

  // ---- Session Chunks ----
  insertSessionChunks(chunks: SessionChunk[]): Promise<void>;
}

// ---- Embedding Provider Interface ----

/**
 * EmbeddingProvider abstracts how vector embeddings are generated.
 * Implementations: Supabase Edge Function, Ollama, local JS model.
 */
export interface EmbeddingProvider {
  /** Generate a single embedding vector */
  generateEmbedding(text: string): Promise<number[]>;

  /** Generate embeddings for multiple texts (batched) */
  generateEmbeddings(texts: string[]): Promise<number[][]>;

  /** The dimensionality of the embedding vectors */
  readonly dimensions: number;
}

// ---- Provider Factory ----

import { config } from "../config/config.ts";

let storageProvider: StorageProvider | null = null;
let embeddingProvider: EmbeddingProvider | null = null;

/**
 * Get the storage provider (singleton, lazily initialized).
 * Uses SESSIONGRAPH_STORAGE_MODE env var or config to determine which provider.
 * Defaults to "local" (PGlite) if no Supabase credentials are configured.
 */
export async function getStorageProvider(): Promise<StorageProvider> {
  if (storageProvider) return storageProvider;

  const mode = config.storage.mode;

  if (mode === "cloud") {
    const { SupabaseStorageProvider } = await import("./supabase-provider.ts");
    storageProvider = new SupabaseStorageProvider();
  } else {
    const { PGliteStorageProvider } = await import("./pglite.ts");
    storageProvider = new PGliteStorageProvider();
  }

  await storageProvider.initialize();
  return storageProvider;
}

/**
 * Get the embedding provider (singleton, lazily initialized).
 * For cloud mode: uses Supabase Edge Function.
 * For local mode: uses Supabase Edge Function as fallback (Ollama coming in Phase 1.2).
 */
export async function getEmbeddingProvider(): Promise<EmbeddingProvider> {
  if (embeddingProvider) return embeddingProvider;

  // For now, both modes use Supabase Edge Function for embeddings.
  // Ollama local embeddings will be added in Phase 1.2.
  // When Ollama is available: local mode will prefer Ollama, fall back to Supabase.
  const { SupabaseEmbeddingProvider } = await import("../embeddings/supabase.ts");
  embeddingProvider = new SupabaseEmbeddingProvider();

  return embeddingProvider;
}

/**
 * Reset providers (for testing or reconfiguration).
 */
export async function resetProviders(): Promise<void> {
  if (storageProvider) {
    await storageProvider.close();
    storageProvider = null;
  }
  embeddingProvider = null;
}
