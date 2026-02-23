/**
 * Benchmark orchestrator — runs all four pillars and produces a BenchmarkResult.
 *
 * Entry point for `sessiongraph benchmark`.
 */

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import type { StorageProvider, EmbeddingProvider } from "../storage/provider.ts";
import type { BenchmarkOptions, BenchmarkResult } from "./types.ts";

import { runCoverageAnalysis } from "./coverage.ts";
import { runGraphQualityAnalysis } from "./graph-quality.ts";
import { runChainQualityAnalysis } from "./chain-quality.ts";
import { runSearchQualityAnalysis } from "./search-quality.ts";
import {
  deriveSearchSummary,
  deriveChainQualitySummary,
  deriveCoverageSummary,
  deriveGraphSummary,
  formatReport,
} from "./report.ts";

/**
 * Run the full benchmark suite.
 *
 * Opens PGlite directly against a given dataDir (can be a copy of the live DB
 * to avoid locking conflicts with the running MCP server).
 *
 * @param dataDir - Path to the PGlite data directory
 * @param storage - StorageProvider instance (used for searchReasoning in chain quality)
 * @param embeddings - EmbeddingProvider instance (nullable — skipped if --skip-search)
 * @param options - Benchmark options
 * @param onProgress - Optional progress callback for terminal output
 */
export async function runBenchmark(
  dataDir: string,
  storage: StorageProvider | null,
  embeddings: EmbeddingProvider | null,
  options: BenchmarkOptions,
  onProgress?: (step: string) => void,
): Promise<BenchmarkResult> {
  // Open a standalone PGlite instance against the provided data dir
  onProgress?.("Opening PGlite database...");
  const db = await PGlite.create({
    dataDir,
    extensions: { vector },
  });

  try {
    await db.exec("CREATE EXTENSION IF NOT EXISTS vector;");

    // Verify it works
    const testRes = await db.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM reasoning_chains"
    );
    const chainCount = parseInt(testRes.rows[0]?.count ?? "0", 10);
    onProgress?.(`Database opened: ${chainCount} chains found.`);

    // ---- Run pillars ----

    onProgress?.("Running coverage analysis...");
    const coverage = await runCoverageAnalysis(db);

    onProgress?.("Running chain quality analysis...");
    // Chain quality needs StorageProvider for duplicate detection via searchReasoning.
    // If we don't have one (DB locked), run without duplicate detection.
    const chainQuality = await runChainQualityAnalysis(db, storage);

    onProgress?.("Running graph quality analysis...");
    const graph = await runGraphQualityAnalysis(db);

    let search = null;
    if (!options.skipSearch && embeddings && storage) {
      onProgress?.(`Running search quality analysis (sample: ${options.sample})...`);
      search = await runSearchQualityAnalysis(db, storage, embeddings, options.sample);
    } else if (!options.skipSearch && (!embeddings || !storage)) {
      onProgress?.("Skipping search quality (no embedding provider or storage provider available).");
    }

    // ---- Derive summaries ----

    const summaries = [
      deriveCoverageSummary(coverage),
      deriveChainQualitySummary(chainQuality),
      deriveGraphSummary(graph),
      deriveSearchSummary(search),
    ];

    const result: BenchmarkResult = {
      timestamp: new Date().toISOString(),
      search,
      chainQuality,
      coverage,
      graph,
      summaries,
    };

    return result;
  } finally {
    await db.close();
  }
}

export { formatReport };
