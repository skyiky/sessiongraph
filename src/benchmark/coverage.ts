/**
 * Coverage pillar — measures how thoroughly sessions are captured.
 *
 * All metrics computed via direct PGlite SQL queries (no StorageProvider methods).
 * Answers: "Are we capturing reasoning from all sessions?"
 */

import type { PGlite } from "@electric-sql/pglite";
import type { CoverageResult, TemporalGap } from "./types.ts";

/**
 * Run coverage analysis against raw PGlite database.
 */
export async function runCoverageAnalysis(db: PGlite): Promise<CoverageResult> {
  // 1. Total sessions and chains
  const [sessionsRes, chainsRes] = await Promise.all([
    db.query<{ count: string }>("SELECT COUNT(*) as count FROM sessions"),
    db.query<{ count: string }>("SELECT COUNT(*) as count FROM reasoning_chains"),
  ]);
  const totalSessions = parseInt(sessionsRes.rows[0]?.count ?? "0", 10);
  const totalChains = parseInt(chainsRes.rows[0]?.count ?? "0", 10);

  // 2. Chains per session distribution
  const chainsPerSessionRes = await db.query<{ chain_count: string }>(`
    SELECT COALESCE(rc.chain_count, 0) AS chain_count
    FROM sessions s
    LEFT JOIN (
      SELECT session_id, COUNT(*) AS chain_count
      FROM reasoning_chains
      GROUP BY session_id
    ) rc ON rc.session_id = s.id
    ORDER BY chain_count
  `);

  const counts = chainsPerSessionRes.rows.map((r) => parseInt(r.chain_count, 10));
  const emptySessions = counts.filter((c) => c === 0).length;

  let chainsPerSession = { min: 0, median: 0, p90: 0, max: 0, mean: 0 };
  if (counts.length > 0) {
    const sorted = [...counts].sort((a, b) => a - b);
    const medianIdx = Math.floor(sorted.length / 2);
    const p90Idx = Math.floor(sorted.length * 0.9);
    chainsPerSession = {
      min: sorted[0]!,
      median: sorted.length % 2 === 0
        ? (sorted[medianIdx - 1]! + sorted[medianIdx]!) / 2
        : sorted[medianIdx]!,
      p90: sorted[p90Idx]!,
      max: sorted[sorted.length - 1]!,
      mean: counts.reduce((a, b) => a + b, 0) / counts.length,
    };
  }

  // 3. Embedding coverage — fraction of chains that have embeddings
  const embeddingRes = await db.query<{ with_embedding: string; total: string }>(`
    SELECT
      COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS with_embedding,
      COUNT(*) AS total
    FROM reasoning_chains
  `);
  const withEmbedding = parseInt(embeddingRes.rows[0]?.with_embedding ?? "0", 10);
  const embeddingTotal = parseInt(embeddingRes.rows[0]?.total ?? "1", 10);
  const embeddingCoverage = embeddingTotal > 0 ? withEmbedding / embeddingTotal : 1;

  // 4. Source mix
  const sourceRes = await db.query<{ source: string; count: string }>(`
    SELECT COALESCE(source, 'unknown') AS source, COUNT(*) AS count
    FROM reasoning_chains
    GROUP BY source
    ORDER BY count DESC
  `);
  const sourceMix: Record<string, number> = {};
  for (const row of sourceRes.rows) {
    sourceMix[row.source] = parseInt(row.count, 10);
  }

  // 5. Status mix
  const statusRes = await db.query<{ status: string; count: string }>(`
    SELECT COALESCE(status, 'active') AS status, COUNT(*) AS count
    FROM reasoning_chains
    GROUP BY status
    ORDER BY count DESC
  `);
  const statusMix: Record<string, number> = {};
  for (const row of statusRes.rows) {
    statusMix[row.status] = parseInt(row.count, 10);
  }

  // 6. Temporal gaps (> 7 days between consecutive sessions)
  const gapRes = await db.query<{
    gap_start: string;
    gap_end: string;
    gap_days: number;
  }>(`
    WITH ordered_sessions AS (
      SELECT started_at,
             LAG(started_at) OVER (ORDER BY started_at) AS prev_started_at
      FROM sessions
    )
    SELECT
      prev_started_at::text AS gap_start,
      started_at::text AS gap_end,
      EXTRACT(EPOCH FROM (started_at - prev_started_at)) / 86400.0 AS gap_days
    FROM ordered_sessions
    WHERE prev_started_at IS NOT NULL
      AND EXTRACT(EPOCH FROM (started_at - prev_started_at)) / 86400.0 > 7
    ORDER BY gap_days DESC
    LIMIT 10
  `);

  const temporalGaps: TemporalGap[] = gapRes.rows.map((r) => ({
    gapStart: r.gap_start,
    gapEnd: r.gap_end,
    gapDays: Math.round(r.gap_days * 10) / 10,
  }));

  return {
    totalSessions,
    totalChains,
    chainsPerSession,
    emptySessions,
    embeddingCoverage,
    sourceMix,
    statusMix,
    temporalGaps,
  };
}
