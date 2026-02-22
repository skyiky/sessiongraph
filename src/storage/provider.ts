import type {
  ChainRelation,
  ChainWithEmbedding,
  ReasoningChain,
  RecallResult,
  RelatedChainResult,
  RelationType,
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
  queryText?: string; // Raw query text for full-text search (hybrid search)
  userId: string;
  project?: string;
  type?: string;
  matchThreshold?: number;
  limit?: number;
  includeSuperseded?: boolean; // Include chains with status='superseded' (default: false)
}

export interface TimelineOpts {
  userId: string;
  project?: string;
  since?: string;
  limit?: number;
}

export interface GetRelatedChainsOpts {
  chainId: string;
  relationType?: RelationType;
  depth?: number; // 1 = direct, 2-3 = multi-hop (default: 1, max: 3)
  limit?: number;
}

export interface ListChainsWithEmbeddingsOpts {
  userId: string;
  limit?: number;
  offset?: number;
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

  // ---- Chain Relations ----
  insertChainRelation(relation: ChainRelation): Promise<string>;
  insertChainRelations(relations: ChainRelation[]): Promise<string[]>;
  getRelatedChains(opts: GetRelatedChainsOpts): Promise<RelatedChainResult[]>;

  // ---- Batch / Linking ----
  /** List chains that have embeddings, paginated. Used by the auto-linker. */
  listChainsWithEmbeddings(opts: ListChainsWithEmbeddingsOpts): Promise<ChainWithEmbedding[]>;
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

// Pending-promise guards prevent race conditions where concurrent callers
// both see null and create duplicate provider instances.
let storageInitPromise: Promise<StorageProvider> | null = null;
let embeddingInitPromise: Promise<EmbeddingProvider> | null = null;

/**
 * Get the storage provider (singleton, lazily initialized).
 * Uses SESSIONGRAPH_STORAGE_MODE env var or config to determine which provider.
 * Defaults to "local" (PGlite) if no Supabase credentials are configured.
 *
 * Safe for concurrent callers — uses a pending-promise guard so only one
 * initialization runs at a time.
 */
export async function getStorageProvider(): Promise<StorageProvider> {
  if (storageProvider) return storageProvider;
  if (storageInitPromise) return storageInitPromise;

  storageInitPromise = (async () => {
    try {
      const mode = config.storage.mode;
      let provider: StorageProvider;

      if (mode === "cloud") {
        const { SupabaseStorageProvider } = await import("./supabase-provider.ts");
        provider = new SupabaseStorageProvider();
      } else {
        const { PGliteStorageProvider } = await import("./pglite.ts");
        provider = new PGliteStorageProvider();
      }

      await provider.initialize();
      storageProvider = provider;
      return provider;
    } finally {
      storageInitPromise = null;
    }
  })();

  return storageInitPromise;
}

/**
 * Get the embedding provider (singleton, lazily initialized).
 * For cloud mode: uses Supabase Edge Function.
 * For local mode: uses Ollama local embeddings.
 *
 * Safe for concurrent callers — uses a pending-promise guard.
 */
export async function getEmbeddingProvider(): Promise<EmbeddingProvider> {
  if (embeddingProvider) return embeddingProvider;
  if (embeddingInitPromise) return embeddingInitPromise;

  embeddingInitPromise = (async () => {
    try {
      const mode = config.storage.mode;
      let provider: EmbeddingProvider;

      if (mode === "local") {
        const { OllamaEmbeddingProvider } = await import("../embeddings/ollama.ts");
        provider = new OllamaEmbeddingProvider();
      } else {
        const { SupabaseEmbeddingProvider } = await import("../embeddings/supabase.ts");
        provider = new SupabaseEmbeddingProvider();
      }

      embeddingProvider = provider;
      return provider;
    } finally {
      embeddingInitPromise = null;
    }
  })();

  return embeddingInitPromise;
}

/**
 * Reset providers (for testing or reconfiguration).
 */
export async function resetProviders(): Promise<void> {
  // Wait for any in-flight initialization before closing
  if (storageInitPromise) await storageInitPromise.catch(() => {});
  if (embeddingInitPromise) await embeddingInitPromise.catch(() => {});

  if (storageProvider) {
    await storageProvider.close();
    storageProvider = null;
  }
  embeddingProvider = null;
  storageInitPromise = null;
  embeddingInitPromise = null;
}
