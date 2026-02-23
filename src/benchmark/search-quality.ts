/**
 * Search quality pillar — self-retrieval test.
 *
 * Samples N chains, uses their titles as queries, and checks whether
 * the original chain appears in the search results. Measures Recall@5,
 * Recall@10, and MRR (Mean Reciprocal Rank).
 *
 * Requires Ollama for embedding generation (batch mode).
 * Answers: "Can we find our own reasoning when we search for it?"
 */

import type { PGlite } from "@electric-sql/pglite";
import type { StorageProvider, EmbeddingProvider } from "../storage/provider.ts";
import type { SearchQualityResult, SearchHit } from "./types.ts";

const LOCAL_USER_ID = "00000000-0000-0000-0000-000000000000";

interface SampleChain {
  id: string;
  title: string;
  type: string;
}

/**
 * Run search quality analysis via self-retrieval test.
 *
 * @param sampleSize Number of chains to sample (default 50)
 */
export async function runSearchQualityAnalysis(
  db: PGlite,
  storage: StorageProvider,
  embeddings: EmbeddingProvider,
  sampleSize: number = 50,
): Promise<SearchQualityResult> {
  // 1. Sample chains that have embeddings (random-ish via ORDER BY created_at spread)
  // Pick evenly across time range to avoid recency bias
  const totalRes = await db.query<{ count: string }>(`
    SELECT COUNT(*) AS count FROM reasoning_chains WHERE embedding IS NOT NULL
  `);
  const totalWithEmbeddings = parseInt(totalRes.rows[0]?.count ?? "0", 10);

  if (totalWithEmbeddings === 0) {
    return {
      sampleSize: 0,
      recallAt5: 0,
      recallAt10: 0,
      mrr: 0,
      hits: [],
      skipped: 0,
      skipReason: "No chains with embeddings found",
    };
  }

  const actualSample = Math.min(sampleSize, totalWithEmbeddings);

  // Sample evenly across the dataset using NTILE
  const sampleRes = await db.query<SampleChain>(`
    WITH numbered AS (
      SELECT id::text, title, type,
             NTILE(${actualSample}) OVER (ORDER BY created_at) AS bucket
      FROM reasoning_chains
      WHERE embedding IS NOT NULL
    )
    SELECT DISTINCT ON (bucket) id, title, type
    FROM numbered
    ORDER BY bucket, RANDOM()
    LIMIT ${actualSample}
  `);

  const samples = sampleRes.rows;

  if (samples.length === 0) {
    return {
      sampleSize: 0,
      recallAt5: 0,
      recallAt10: 0,
      mrr: 0,
      hits: [],
      skipped: 0,
      skipReason: "Could not sample chains",
    };
  }

  // 2. Generate embeddings for all sample titles in one batch call
  const titles = samples.map((s) => s.title);
  let titleEmbeddings: number[][];
  try {
    titleEmbeddings = await embeddings.generateEmbeddings(titles);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      sampleSize: samples.length,
      recallAt5: 0,
      recallAt10: 0,
      mrr: 0,
      hits: [],
      skipped: samples.length,
      skipReason: `Embedding generation failed: ${message}`,
    };
  }

  // 3. For each sample, search and check if the original chain appears
  const hits: SearchHit[] = [];
  let recallAt5Count = 0;
  let recallAt10Count = 0;
  let mrrSum = 0;
  let skipped = 0;

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!;
    const queryEmbedding = titleEmbeddings[i];

    if (!queryEmbedding || queryEmbedding.length === 0) {
      skipped++;
      continue;
    }

    try {
      const results = await storage.searchReasoning({
        queryEmbedding,
        queryText: sample.title,
        userId: LOCAL_USER_ID,
        limit: 10,
      });

      // Find the rank of the original chain in results
      const rank = results.findIndex((r) => r.id === sample.id) + 1; // 1-indexed, 0 = not found

      if (rank > 0) {
        if (rank <= 5) recallAt5Count++;
        if (rank <= 10) recallAt10Count++;
        mrrSum += 1 / rank;

        hits.push({
          chainId: sample.id,
          title: sample.title,
          rank,
          score: results[rank - 1]!.score,
          similarity: results[rank - 1]!.similarity,
        });
      }
    } catch {
      skipped++;
    }
  }

  const evaluated = samples.length - skipped;

  return {
    sampleSize: samples.length,
    recallAt5: evaluated > 0 ? recallAt5Count / evaluated : 0,
    recallAt10: evaluated > 0 ? recallAt10Count / evaluated : 0,
    mrr: evaluated > 0 ? mrrSum / evaluated : 0,
    hits,
    skipped,
  };
}
