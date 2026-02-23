/**
 * Terminal report formatting for benchmark results.
 *
 * Uses the existing cli/format.ts utilities for ANSI colors.
 * Rich terminal output with color-coded sections, pass/warn/fail indicators.
 */

import {
  bold, dim, cyan, green, yellow, red, magenta,
  boldCyan, boldGreen, boldYellow, boldRed,
  separator, colorPct,
} from "../cli/format.ts";
import type {
  BenchmarkResult,
  PillarSummary,
  PillarStatus,
  SearchQualityResult,
  ChainQualityResult,
  CoverageResult,
  GraphQualityResult,
} from "./types.ts";

// ---- Status indicators ----

function statusIcon(status: PillarStatus): string {
  switch (status) {
    case "pass": return boldGreen("[PASS]");
    case "warn": return boldYellow("[WARN]");
    case "fail": return boldRed("[FAIL]");
  }
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function num(value: number, decimals = 1): string {
  return value.toFixed(decimals);
}

// ---- Pillar summary derivation ----

export function deriveSearchSummary(result: SearchQualityResult | null): PillarSummary {
  if (!result) {
    return {
      name: "Search Quality",
      status: "warn",
      highlights: ["Skipped (no Ollama)"],
      warnings: ["Run without --skip-search to test search quality"],
    };
  }

  if (result.skipReason) {
    return {
      name: "Search Quality",
      status: "fail",
      highlights: [`Skipped: ${result.skipReason}`],
      warnings: [],
    };
  }

  const warnings: string[] = [];
  const highlights: string[] = [
    `Recall@5: ${pct(result.recallAt5)}`,
    `Recall@10: ${pct(result.recallAt10)}`,
    `MRR: ${num(result.mrr, 3)}`,
    `Sample: ${result.sampleSize} chains`,
  ];

  if (result.skipped > 0) {
    warnings.push(`${result.skipped} chains skipped during evaluation`);
  }

  let status: PillarStatus = "pass";
  if (result.recallAt5 < 0.5) status = "fail";
  else if (result.recallAt5 < 0.8) status = "warn";

  if (result.mrr < 0.3) status = "fail";
  else if (result.mrr < 0.6 && status !== "fail") status = "warn";

  return { name: "Search Quality", status, highlights, warnings };
}

export function deriveChainQualitySummary(result: ChainQualityResult): PillarSummary {
  const highlights: string[] = [
    `${result.totalChains} chains, avg quality: ${num(result.averageScore, 2)}`,
  ];
  const warnings: string[] = [];

  const errors = result.issues.filter((i) => i.severity === "error");
  const warns = result.issues.filter((i) => i.severity === "warning");

  if (errors.length > 0) warnings.push(`${errors.length} errors (missing embeddings, empty content)`);
  if (warns.length > 0) warnings.push(`${warns.length} warnings (short titles, missing tags, etc.)`);
  if (result.duplicatePairs.length > 0) {
    warnings.push(`${result.duplicatePairs.length} near-duplicate pairs detected`);
  }

  let status: PillarStatus = "pass";
  if (errors.length > result.totalChains * 0.1) status = "fail";
  else if (errors.length > 0 || result.duplicatePairs.length > 5) status = "warn";

  return { name: "Chain Quality", status, highlights, warnings };
}

export function deriveCoverageSummary(result: CoverageResult): PillarSummary {
  const highlights: string[] = [
    `${result.totalSessions} sessions, ${result.totalChains} chains`,
    `Chains/session: median ${num(result.chainsPerSession.median)}, p90 ${num(result.chainsPerSession.p90)}`,
    `Embedding coverage: ${pct(result.embeddingCoverage)}`,
  ];
  const warnings: string[] = [];

  const emptyPct = result.totalSessions > 0
    ? result.emptySessions / result.totalSessions
    : 0;

  if (result.emptySessions > 0) {
    warnings.push(`${result.emptySessions} empty sessions (${pct(emptyPct)} of total)`);
  }
  if (result.embeddingCoverage < 1.0) {
    const missing = result.totalChains - Math.round(result.embeddingCoverage * result.totalChains);
    warnings.push(`${missing} chains missing embeddings`);
  }
  if (result.temporalGaps.length > 0) {
    warnings.push(`${result.temporalGaps.length} gaps > 7 days in session activity`);
  }

  let status: PillarStatus = "pass";
  if (result.embeddingCoverage < 0.8 || emptyPct > 0.5) status = "fail";
  else if (result.embeddingCoverage < 0.95 || emptyPct > 0.2) status = "warn";

  return { name: "Coverage", status, highlights, warnings };
}

export function deriveGraphSummary(result: GraphQualityResult): PillarSummary {
  const orphanPct = result.totalActiveChains > 0
    ? result.orphanChains / result.totalActiveChains
    : 0;

  const highlights: string[] = [
    `${result.totalRelations} relations across ${Object.keys(result.byType).length} types`,
    `${result.orphanChains} orphan chains (${pct(orphanPct)})`,
  ];

  if (result.confidence.mean > 0) {
    highlights.push(`Confidence: mean ${num(result.confidence.mean, 2)}, min ${num(result.confidence.min, 2)}`);
  }

  const warnings: string[] = [];

  if (result.bidirectionalConsistency.missing > 0) {
    warnings.push(
      `${result.bidirectionalConsistency.missing} bidirectional relations missing reverse edge`
    );
  }
  if (result.confidence.nullCount > 0) {
    warnings.push(`${result.confidence.nullCount} relations have NULL confidence`);
  }
  if (orphanPct > 0.5) {
    warnings.push(`${pct(orphanPct)} of active chains have no graph connections`);
  }

  let status: PillarStatus = "pass";
  if (result.totalRelations === 0) status = "warn"; // No graph at all
  if (orphanPct > 0.9) status = "fail";
  else if (orphanPct > 0.7) status = "warn";
  if (result.bidirectionalConsistency.missing > 0 && status !== "fail") status = "warn";

  return { name: "Graph Quality", status, highlights, warnings };
}

// ---- Full report rendering ----

/**
 * Format a BenchmarkResult as a rich terminal report string.
 */
export function formatReport(result: BenchmarkResult): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(bold("SessionGraph Benchmark Report"));
  lines.push(dim(`Generated: ${result.timestamp}`));
  lines.push(separator(70));

  // ---- Summary bar ----
  lines.push("");
  lines.push(bold("  Summary"));
  lines.push("");
  for (const summary of result.summaries) {
    lines.push(`  ${statusIcon(summary.status)} ${bold(summary.name)}`);
    for (const h of summary.highlights) {
      lines.push(`    ${cyan(h)}`);
    }
    for (const w of summary.warnings) {
      lines.push(`    ${yellow("! " + w)}`);
    }
    lines.push("");
  }
  lines.push(separator(70));

  // ---- Coverage details ----
  lines.push("");
  lines.push(bold("  Coverage Details"));
  lines.push("");
  const cov = result.coverage;
  lines.push(`    Sessions:            ${cyan(String(cov.totalSessions))}`);
  lines.push(`    Chains:              ${cyan(String(cov.totalChains))}`);
  lines.push(`    Empty sessions:      ${cov.emptySessions > 0 ? yellow(String(cov.emptySessions)) : green("0")}`);
  lines.push(`    Embedding coverage:  ${cov.embeddingCoverage >= 0.95 ? green(pct(cov.embeddingCoverage)) : yellow(pct(cov.embeddingCoverage))}`);
  lines.push("");
  lines.push(`    Chains/session:  min=${cov.chainsPerSession.min}  median=${num(cov.chainsPerSession.median)}  p90=${num(cov.chainsPerSession.p90)}  max=${cov.chainsPerSession.max}  mean=${num(cov.chainsPerSession.mean)}`);
  lines.push("");

  if (Object.keys(cov.sourceMix).length > 0) {
    lines.push(`    ${dim("Source mix:")}`);
    for (const [src, count] of Object.entries(cov.sourceMix)) {
      const pctVal = cov.totalChains > 0 ? pct(count / cov.totalChains) : "0%";
      lines.push(`      ${src}: ${count} (${pctVal})`);
    }
    lines.push("");
  }

  if (cov.temporalGaps.length > 0) {
    lines.push(`    ${dim("Temporal gaps (> 7 days):")}`);
    for (const gap of cov.temporalGaps.slice(0, 5)) {
      lines.push(`      ${num(gap.gapDays)} days  (${dim(gap.gapStart.slice(0, 10))} → ${dim(gap.gapEnd.slice(0, 10))})`);
    }
    lines.push("");
  }

  lines.push(separator(70));

  // ---- Chain Quality details ----
  lines.push("");
  lines.push(bold("  Chain Quality Details"));
  lines.push("");
  const cq = result.chainQuality;
  lines.push(`    Total chains:     ${cyan(String(cq.totalChains))}`);
  lines.push(`    Average quality:  ${cq.averageScore >= 0.8 ? green(num(cq.averageScore, 2)) : yellow(num(cq.averageScore, 2))}`);
  lines.push("");

  if (Object.keys(cq.bySource).length > 0) {
    lines.push(`    ${dim("Quality by source:")}`);
    for (const [src, stats] of Object.entries(cq.bySource)) {
      lines.push(`      ${src}: ${stats.count} chains, avg quality ${num(stats.avgScore, 2)}`);
    }
    lines.push("");
  }

  // Show top issues (max 15)
  const errorIssues = cq.issues.filter((i) => i.severity === "error");
  const warnIssues = cq.issues.filter((i) => i.severity === "warning");

  if (errorIssues.length > 0) {
    lines.push(`    ${red(`Errors (${errorIssues.length}):`)}`);
    for (const issue of errorIssues.slice(0, 10)) {
      lines.push(`      ${red("✗")} ${dim(issue.chainId.slice(0, 8))} ${issue.title.slice(0, 50)} — ${issue.issue}`);
    }
    if (errorIssues.length > 10) lines.push(`      ${dim(`... and ${errorIssues.length - 10} more`)}`);
    lines.push("");
  }

  if (warnIssues.length > 0) {
    lines.push(`    ${yellow(`Warnings (${warnIssues.length}):`)}`);
    for (const issue of warnIssues.slice(0, 10)) {
      lines.push(`      ${yellow("!")} ${dim(issue.chainId.slice(0, 8))} ${issue.title.slice(0, 50)} — ${issue.issue}`);
    }
    if (warnIssues.length > 10) lines.push(`      ${dim(`... and ${warnIssues.length - 10} more`)}`);
    lines.push("");
  }

  if (cq.duplicatePairs.length > 0) {
    lines.push(`    ${yellow(`Near-duplicates (${cq.duplicatePairs.length}):`)}`);
    for (const dup of cq.duplicatePairs.slice(0, 5)) {
      lines.push(`      ${dim(dup.chainId1.slice(0, 8))} "${dup.title1.slice(0, 40)}" ↔ ${dim(dup.chainId2.slice(0, 8))} "${dup.title2.slice(0, 40)}" (${pct(dup.similarity)})`);
    }
    if (cq.duplicatePairs.length > 5) lines.push(`      ${dim(`... and ${cq.duplicatePairs.length - 5} more`)}`);
    lines.push("");
  }

  lines.push(separator(70));

  // ---- Graph Quality details ----
  lines.push("");
  lines.push(bold("  Graph Quality Details"));
  lines.push("");
  const gq = result.graph;
  lines.push(`    Total relations:  ${cyan(String(gq.totalRelations))}`);
  lines.push(`    Orphan chains:    ${gq.orphanChains > 0 ? yellow(String(gq.orphanChains)) : green("0")} / ${gq.totalActiveChains} active`);
  lines.push(`    Superseded:       ${gq.supersededCount}`);
  lines.push("");

  if (Object.keys(gq.byType).length > 0) {
    lines.push(`    ${dim("Relations by type:")}`);
    for (const [type, count] of Object.entries(gq.byType)) {
      lines.push(`      ${type}: ${count}`);
    }
    lines.push("");
  }

  if (gq.confidence.mean > 0) {
    lines.push(`    ${dim("Confidence stats:")}`);
    lines.push(`      Mean: ${num(gq.confidence.mean, 3)}  Min: ${num(gq.confidence.min, 3)}  Max: ${num(gq.confidence.max, 3)}`);
    if (gq.confidence.nullCount > 0) {
      lines.push(`      ${yellow(`${gq.confidence.nullCount} relations have NULL confidence`)}`);
    }
    lines.push("");
  }

  const bidi = gq.bidirectionalConsistency;
  if (bidi.expected > 0) {
    lines.push(`    ${dim("Bidirectional consistency:")}`);
    lines.push(`      Expected: ${bidi.expected}  Found: ${bidi.found}  Missing: ${bidi.missing > 0 ? yellow(String(bidi.missing)) : green("0")}`);
    lines.push("");
  }

  lines.push(separator(70));

  // ---- Search Quality details ----
  if (result.search) {
    lines.push("");
    lines.push(bold("  Search Quality Details"));
    lines.push("");
    const sq = result.search;

    if (sq.skipReason) {
      lines.push(`    ${yellow("Skipped: " + sq.skipReason)}`);
    } else {
      lines.push(`    Sample size:  ${cyan(String(sq.sampleSize))}`);
      lines.push(`    Recall@5:     ${sq.recallAt5 >= 0.8 ? green(pct(sq.recallAt5)) : sq.recallAt5 >= 0.5 ? yellow(pct(sq.recallAt5)) : red(pct(sq.recallAt5))}`);
      lines.push(`    Recall@10:    ${sq.recallAt10 >= 0.8 ? green(pct(sq.recallAt10)) : sq.recallAt10 >= 0.5 ? yellow(pct(sq.recallAt10)) : red(pct(sq.recallAt10))}`);
      lines.push(`    MRR:          ${sq.mrr >= 0.6 ? green(num(sq.mrr, 3)) : sq.mrr >= 0.3 ? yellow(num(sq.mrr, 3)) : red(num(sq.mrr, 3))}`);

      if (sq.skipped > 0) {
        lines.push(`    Skipped:      ${yellow(String(sq.skipped))}`);
      }

      // Show some hits
      if (sq.hits.length > 0) {
        lines.push("");
        lines.push(`    ${dim("Sample hits (showing first 5):")}`);
        for (const hit of sq.hits.slice(0, 5)) {
          const rankColor = hit.rank <= 1 ? green : hit.rank <= 3 ? yellow : red;
          lines.push(`      Rank ${rankColor(String(hit.rank))}: "${hit.title.slice(0, 50)}" (score: ${num(hit.score, 3)}, sim: ${num(hit.similarity, 3)})`);
        }
      }
    }

    lines.push("");
    lines.push(separator(70));
  }

  lines.push("");

  return lines.join("\n");
}
