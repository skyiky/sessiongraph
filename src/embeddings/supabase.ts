import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config/config.ts";
import type { EmbeddingProvider } from "../storage/provider.ts";

/**
 * Generates embeddings via Supabase Edge Function (1024 dims).
 * Used for cloud mode. Dimensions should match the Ollama local model.
 */
export class SupabaseEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 1024;
  private client: SupabaseClient | null = null;

  private getClient(): SupabaseClient {
    if (!this.client) {
      if (!config.supabase.url || !config.supabase.anonKey) {
        throw new Error(
          "Supabase URL and anon key required for embeddings. " +
          "Set SESSIONGRAPH_SUPABASE_URL and SESSIONGRAPH_SUPABASE_ANON_KEY, " +
          "or install Ollama for local embeddings (coming soon)."
        );
      }
      // Use unauthenticated client for edge functions.
      // The embedding function doesn't need user auth — it only computes vectors.
      this.client = createClient(config.supabase.url, config.supabase.anonKey);
    }
    return this.client;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const sb = this.getClient();
    const { data, error } = await sb.functions.invoke("generate-embedding", {
      body: { text },
    });

    if (error) throw new Error(`Failed to generate embedding: ${error.message}`);
    if (!data || !Array.isArray(data.embedding)) {
      throw new Error(
        `Supabase embedding response missing 'embedding' array. Got: ${JSON.stringify(data).slice(0, 200)}`
      );
    }
    return data.embedding;
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const BATCH_SIZE = 5;
    const allEmbeddings: number[][] = [];
    const sb = this.getClient();

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const { data, error } = await sb.functions.invoke("generate-embedding", {
        body: { texts: batch },
      });

      if (error) {
        throw new Error(
          `Failed to generate embeddings (batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(texts.length / BATCH_SIZE)}): ${error.message}`
        );
      }

      if (!data || !Array.isArray(data.embeddings)) {
        throw new Error(
          `Supabase batch embedding response missing 'embeddings' array. Got: ${JSON.stringify(data).slice(0, 200)}`
        );
      }

      allEmbeddings.push(...data.embeddings);
    }

    return allEmbeddings;
  }
}
