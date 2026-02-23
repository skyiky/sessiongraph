/**
 * Graph quality pillar — measures the health of the reasoning graph.
 *
 * All metrics computed via direct PGlite SQL queries.
 * Answers: "Is the knowledge graph well-connected and consistent?"
 */

import type { PGlite } from "@electric-sql/pglite";
import type { GraphQualityResult } from "./types.ts";

/**
 * Run graph quality analysis against raw PGlite database.
 */
export async function runGraphQualityAnalysis(db: PGlite): Promise<GraphQualityResult> {
  // 1. Total relations & breakdown by type
  const relationsRes = await db.query<{ relation_type: string; count: string }>(`
    SELECT relation_type, COUNT(*) AS count
    FROM chain_relations
    GROUP BY relation_type
    ORDER BY count DESC
  `);
  const byType: Record<string, number> = {};
  let totalRelations = 0;
  for (const row of relationsRes.rows) {
    const count = parseInt(row.count, 10);
    byType[row.relation_type] = count;
    totalRelations += count;
  }

  // 2. Orphan chains — active chains with no relations at all
  const orphanRes = await db.query<{ orphan_count: string; total_active: string }>(`
    SELECT
      COUNT(*) FILTER (WHERE cr_count = 0) AS orphan_count,
      COUNT(*) AS total_active
    FROM (
      SELECT rc.id,
        (SELECT COUNT(*) FROM chain_relations cr
         WHERE cr.source_chain_id = rc.id OR cr.target_chain_id = rc.id) AS cr_count
      FROM reasoning_chains rc
      WHERE rc.status = 'active' OR rc.status IS NULL
    ) sub
  `);
  const orphanChains = parseInt(orphanRes.rows[0]?.orphan_count ?? "0", 10);
  const totalActiveChains = parseInt(orphanRes.rows[0]?.total_active ?? "0", 10);

  // 3. Confidence stats for relations
  const confidenceRes = await db.query<{
    avg_conf: number | null;
    min_conf: number | null;
    max_conf: number | null;
    null_count: string;
  }>(`
    SELECT
      AVG(confidence) AS avg_conf,
      MIN(confidence) AS min_conf,
      MAX(confidence) AS max_conf,
      COUNT(*) FILTER (WHERE confidence IS NULL) AS null_count
    FROM chain_relations
  `);
  const confRow = confidenceRes.rows[0];
  const confidence = {
    mean: confRow?.avg_conf ?? 0,
    min: confRow?.min_conf ?? 0,
    max: confRow?.max_conf ?? 0,
    nullCount: parseInt(confRow?.null_count ?? "0", 10),
  };

  // 4. Superseded chain count
  const supersededRes = await db.query<{ count: string }>(`
    SELECT COUNT(*) AS count
    FROM reasoning_chains
    WHERE status = 'superseded'
  `);
  const supersededCount = parseInt(supersededRes.rows[0]?.count ?? "0", 10);

  // 5. Bidirectional consistency check
  // For 'contradicts' and 'analogous_to', we should have (A→B) AND (B→A)
  const bidiRes = await db.query<{
    expected: string;
    found: string;
  }>(`
    WITH bidi_relations AS (
      SELECT source_chain_id, target_chain_id, relation_type
      FROM chain_relations
      WHERE relation_type IN ('contradicts', 'analogous_to')
    )
    SELECT
      COUNT(*) AS expected,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM bidi_relations b2
        WHERE b2.source_chain_id = b1.target_chain_id
          AND b2.target_chain_id = b1.source_chain_id
          AND b2.relation_type = b1.relation_type
      )) AS found
    FROM bidi_relations b1
  `);
  const expectedBidi = parseInt(bidiRes.rows[0]?.expected ?? "0", 10);
  const foundBidi = parseInt(bidiRes.rows[0]?.found ?? "0", 10);

  return {
    totalRelations,
    byType,
    orphanChains,
    totalActiveChains,
    confidence,
    supersededCount,
    bidirectionalConsistency: {
      expected: expectedBidi,
      found: foundBidi,
      missing: expectedBidi - foundBidi,
    },
  };
}
