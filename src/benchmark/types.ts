/**
 * Benchmark result types for the four measurement pillars:
 * search quality, chain quality, coverage, and graph quality.
 *
 * Design principles:
 * - No composite overall score — arbitrary weights would be misleading
 * - Per-pillar metrics with pass/warn/fail indicators
 * - Actionable output: list specific fixable issues with chain IDs
 */

// ---- Options ----

export interface BenchmarkOptions {
  /** Number of chains to sample for self-retrieval test (default: 50) */
  sample: number;
  /** Skip the search quality pillar (avoids Ollama dependency) */
  skipSearch: boolean;
  /** Output raw JSON instead of formatted terminal output */
  json: boolean;
}

// ---- Search Quality (Pillar 1) ----

export interface SearchHit {
  chainId: string;
  title: string;
  rank: number;
  score: number;
  similarity: number;
}

export interface SearchQualityResult {
  sampleSize: number;
  /** Fraction of sampled chains found in their own top-5 results */
  recallAt5: number;
  /** Fraction of sampled chains found in their own top-10 results */
  recallAt10: number;
  /** Mean Reciprocal Rank (1/rank of the correct chain in results) */
  mrr: number;
  /** Chains that were successfully retrieved */
  hits: SearchHit[];
  /** Number of chains skipped (e.g. missing embedding) */
  skipped: number;
  /** Reason chains were skipped */
  skipReason?: string;
}

// ---- Chain Quality (Pillar 2) ----

export interface ChainIssue {
  chainId: string;
  title: string;
  issue: string;
  severity: "warning" | "error";
}

export interface DuplicatePair {
  chainId1: string;
  title1: string;
  chainId2: string;
  title2: string;
  similarity: number;
}

export interface ChainQualityResult {
  totalChains: number;
  averageScore: number;
  /** Breakdown by source (mcp_capture, backfill, agent_backfill) */
  bySource: Record<string, { count: number; avgScore: number }>;
  /** Specific fixable issues (short title, empty content, missing tags, etc.) */
  issues: ChainIssue[];
  /** Near-duplicate pairs detected via vector similarity >= 0.95 */
  duplicatePairs: DuplicatePair[];
}

// ---- Coverage (Pillar 3) ----

export interface TemporalGap {
  gapStart: string;
  gapEnd: string;
  gapDays: number;
}

export interface CoverageResult {
  totalSessions: number;
  totalChains: number;
  chainsPerSession: {
    min: number;
    median: number;
    p90: number;
    max: number;
    mean: number;
  };
  /** Sessions with zero reasoning chains extracted */
  emptySessions: number;
  /** Fraction of chains that have embeddings (should be ~1.0) */
  embeddingCoverage: number;
  /** Breakdown by source */
  sourceMix: Record<string, number>;
  /** Breakdown by status */
  statusMix: Record<string, number>;
  /** Gaps in session activity > 7 days */
  temporalGaps: TemporalGap[];
}

// ---- Graph Quality (Pillar 4) ----

export interface GraphQualityResult {
  totalRelations: number;
  /** Breakdown by relation type */
  byType: Record<string, number>;
  /** Chains with no relations (neither source nor target of any edge) */
  orphanChains: number;
  /** Total active chains (for computing orphan percentage) */
  totalActiveChains: number;
  /** Confidence score stats for relations */
  confidence: {
    mean: number;
    min: number;
    max: number;
    /** Relations with NULL confidence */
    nullCount: number;
  };
  /** Count of chains with status='superseded' */
  supersededCount: number;
  /** Whether bidirectional relations (contradicts, analogous_to) have matching reverse edges */
  bidirectionalConsistency: {
    expected: number;
    found: number;
    missing: number;
  };
}

// ---- Pillar Summary ----

export type PillarStatus = "pass" | "warn" | "fail";

export interface PillarSummary {
  name: string;
  status: PillarStatus;
  /** Human-readable key metric */
  highlights: string[];
  /** Issues that need attention */
  warnings: string[];
}

// ---- Top-level Result ----

export interface BenchmarkResult {
  timestamp: string;
  search: SearchQualityResult | null;
  chainQuality: ChainQualityResult;
  coverage: CoverageResult;
  graph: GraphQualityResult;
  summaries: PillarSummary[];
}
