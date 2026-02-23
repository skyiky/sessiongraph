/**
 * Chain quality pillar — heuristic scoring of individual chains.
 *
 * Detects specific fixable issues (short titles, empty content, missing tags, etc.)
 * and near-duplicate pairs via the HNSW vector index (threshold 0.95).
 *
 * Answers: "Are the stored reasoning chains high-quality and unique?"
 */

import type { PGlite } from "@electric-sql/pglite";
import type { StorageProvider, SearchReasoningOpts } from "../storage/provider.ts";
import type { ChainQualityResult, ChainIssue, DuplicatePair } from "./types.ts";

const LOCAL_USER_ID = "00000000-0000-0000-0000-000000000000";

// ---- Heuristic thresholds ----

const MIN_TITLE_LENGTH = 10;
const MIN_CONTENT_LENGTH = 30;
const MAX_TITLE_LENGTH = 200;
const MAX_CONTENT_LENGTH = 5000;

interface RawChain {
  id: string;
  title: string;
  content: string;
  type: string;
  tags: string[];
  quality: number;
  source: string;
  status: string;
  embedding_exists: boolean;
}

/**
 * Run chain quality analysis.
 *
 * Uses direct SQL for aggregation, and the StorageProvider's searchReasoning
 * for duplicate detection (reuses the HNSW index — O(n) not O(n²)).
 */
export async function runChainQualityAnalysis(
  db: PGlite,
  storage: StorageProvider | null,
): Promise<ChainQualityResult> {
  // 1. Load all chains with basic fields for heuristic analysis
  const chainsRes = await db.query<RawChain>(`
    SELECT
      id::text,
      title,
      content,
      type,
      tags,
      COALESCE(quality, 1.0) AS quality,
      COALESCE(source, 'unknown') AS source,
      COALESCE(status, 'active') AS status,
      (embedding IS NOT NULL) AS embedding_exists
    FROM reasoning_chains
    ORDER BY created_at DESC
  `);
  const chains = chainsRes.rows;
  const totalChains = chains.length;

  // 2. Average quality score
  const averageScore =
    totalChains > 0
      ? chains.reduce((sum, c) => sum + c.quality, 0) / totalChains
      : 0;

  // 3. Breakdown by source
  const bySource: Record<string, { count: number; avgScore: number }> = {};
  for (const chain of chains) {
    const src = chain.source;
    if (!bySource[src]) bySource[src] = { count: 0, avgScore: 0 };
    bySource[src].count++;
    bySource[src].avgScore += chain.quality;
  }
  for (const [src, stats] of Object.entries(bySource)) {
    stats.avgScore = stats.avgScore / stats.count;
  }

  // 4. Heuristic issue detection
  const issues: ChainIssue[] = [];

  for (const chain of chains) {
    // Short title
    if (chain.title.length < MIN_TITLE_LENGTH) {
      issues.push({
        chainId: chain.id,
        title: chain.title,
        issue: `Title too short (${chain.title.length} chars, min ${MIN_TITLE_LENGTH})`,
        severity: "warning",
      });
    }

    // Excessively long title (likely content stuffed into title)
    if (chain.title.length > MAX_TITLE_LENGTH) {
      issues.push({
        chainId: chain.id,
        title: chain.title.slice(0, 60) + "...",
        issue: `Title too long (${chain.title.length} chars, max ${MAX_TITLE_LENGTH})`,
        severity: "warning",
      });
    }

    // Short content
    if (chain.content.length < MIN_CONTENT_LENGTH) {
      issues.push({
        chainId: chain.id,
        title: chain.title,
        issue: `Content too short (${chain.content.length} chars, min ${MIN_CONTENT_LENGTH})`,
        severity: "error",
      });
    }

    // Excessively long content
    if (chain.content.length > MAX_CONTENT_LENGTH) {
      issues.push({
        chainId: chain.id,
        title: chain.title,
        issue: `Content very long (${chain.content.length} chars) — may be raw conversation dump`,
        severity: "warning",
      });
    }

    // No tags
    if (!chain.tags || chain.tags.length === 0) {
      issues.push({
        chainId: chain.id,
        title: chain.title,
        issue: "No tags — reduces discoverability in search",
        severity: "warning",
      });
    }

    // Missing embedding
    if (!chain.embedding_exists) {
      issues.push({
        chainId: chain.id,
        title: chain.title,
        issue: "No embedding — chain is invisible to semantic search",
        severity: "error",
      });
    }

    // Title equals content (lazy extraction)
    if (chain.title.trim() === chain.content.trim()) {
      issues.push({
        chainId: chain.id,
        title: chain.title,
        issue: "Title and content are identical — no additional detail",
        severity: "warning",
      });
    }
  }

  // 5. Near-duplicate detection via vector index
  // For each chain with an embedding, search for itself at threshold 0.95
  // If we find another chain at that similarity, it's a near-duplicate.
  // Requires StorageProvider for searchReasoning (skipped if DB is locked).
  const duplicatePairs: DuplicatePair[] = [];

  if (storage) {
    const seenPairs = new Set<string>();

    // Only check chains that have embeddings — load them with their vectors
    const embeddedChainsRes = await db.query<{
      id: string;
      title: string;
      embedding: string;
    }>(`
      SELECT id::text, title, embedding::text
      FROM reasoning_chains
      WHERE embedding IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 200
    `);

    for (const chain of embeddedChainsRes.rows) {
      // Parse the embedding vector from PGlite's text representation
      const embedding = parseVector(chain.embedding);
      if (!embedding || embedding.length === 0) continue;

      try {
        const results = await storage.searchReasoning({
          queryEmbedding: embedding,
          userId: LOCAL_USER_ID,
          matchThreshold: 0.95,
          limit: 5,
        });

        for (const result of results) {
          // Skip self-match
          if (result.id === chain.id) continue;

          // Create a canonical pair key to avoid duplicates
          const pairKey = [chain.id, result.id].sort().join(":");
          if (seenPairs.has(pairKey)) continue;
          seenPairs.add(pairKey);

          duplicatePairs.push({
            chainId1: chain.id,
            title1: chain.title,
            chainId2: result.id,
            title2: result.title,
            similarity: result.similarity,
          });
        }
      } catch {
        // Skip chains that fail search (e.g. dimension mismatch)
      }
    }
  }

  return {
    totalChains,
    averageScore,
    bySource,
    issues,
    duplicatePairs,
  };
}

/**
 * Parse a PGlite vector text representation like "[0.1,0.2,...]" into number[].
 */
function parseVector(text: string): number[] | null {
  try {
    // PGlite returns vectors as "[0.1,0.2,0.3,...]"
    const cleaned = text.replace(/^\[/, "").replace(/\]$/, "");
    if (!cleaned) return null;
    return cleaned.split(",").map((s) => parseFloat(s.trim()));
  } catch {
    return null;
  }
}
