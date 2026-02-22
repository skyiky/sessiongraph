#!/usr/bin/env bun
import { Command } from "commander";
import { config } from "./config/config.ts";
import { getStorageProvider, getEmbeddingProvider, resetProviders } from "./storage/provider.ts";
import { runInit } from "./cli/init.ts";
import { runBackfill, requestBackfillStop } from "./backfill/backfill.ts";
import { runLinker } from "./backfill/linker.ts";
import {
  bold, dim, cyan, green, yellow, red,
  typeBadge, colorPct, formatTags, separator, shortDate,
  sourceBadge, statusIndicator,
} from "./cli/format.ts";

import { createInterface } from "node:readline";

const program = new Command();

/**
 * Parse a string as a positive integer, or throw with a clear error.
 * Used as a Commander argParser for --limit, --threads, etc.
 */
function parsePositiveInt(value: string, flagName: string): number {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--${flagName} must be a positive integer, got '${value}'`);
  }
  return n;
}

/**
 * Parse a string as a positive number (float allowed), or throw with a clear error.
 * Used for --delay which accepts fractional seconds.
 */
function parsePositiveNumber(value: string, flagName: string): number {
  const n = parseFloat(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`--${flagName} must be a non-negative number, got '${value}'`);
  }
  return n;
}

/**
 * Prompt the user for a password on stdin (not hidden — Bun limitation).
 * Falls back to a simple readline prompt.
 */
function promptPassword(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, (answer) => {
      rl.close();
      if (!answer) {
        reject(new Error("Password is required."));
      } else {
        resolve(answer);
      }
    });
  });
}

program
  .name("sessiongraph")
  .description("Never lose the reasoning behind an AI-assisted decision again.")
  .version("0.2.0");

/**
 * Helper: require cloud mode for a command, throw with a clear error if local.
 */
function requireCloudMode(commandName: string): void {
  if (config.storage.mode !== "cloud") {
    throw new Error(
      `'${commandName}' requires cloud mode.\n` +
        `Current mode: ${config.storage.mode}\n` +
        `Set SESSIONGRAPH_STORAGE_MODE=cloud to use this command.`
    );
  }
}

/**
 * Helper: resolve the current user ID.
 * - Local mode: fixed user ID, no auth.
 * - Cloud mode: loads auth.json, throws if not authenticated.
 */
async function resolveUserId(): Promise<string> {
  if (config.storage.mode === "local") {
    return "00000000-0000-0000-0000-000000000000";
  }

  const { loadAuth } = await import("./auth/auth.ts");
  const auth = await loadAuth();
  if (!auth) {
    throw new Error("Not authenticated. Run 'sessiongraph login' first.");
  }

  // Set auth on the actual storage provider instance for RLS
  const storage = await getStorageProvider();
  if (storage.mode === "cloud" && "setAuth" in storage) {
    await (storage as any).setAuth(auth.accessToken, auth.refreshToken);
  }

  return auth.userId;
}

// ---- Auth Commands (cloud-only) ----

program
  .command("login")
  .description("Log in to SessionGraph (cloud mode only)")
  .requiredOption("-e, --email <email>", "Email address")
  .option("-p, --password <password>", "Password (omit to enter interactively)")
  .action(async (opts) => {
    requireCloudMode("login");
    try {
      const password = opts.password ?? await promptPassword("Password: ");
      const { login } = await import("./auth/auth.ts");
      const auth = await login(opts.email, password);
      console.log(`Logged in as ${auth.email} (${auth.userId})`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program
  .command("signup")
  .description("Create a new SessionGraph account (cloud mode only)")
  .requiredOption("-e, --email <email>", "Email address")
  .option("-p, --password <password>", "Password (min 6 characters, omit to enter interactively)")
  .action(async (opts) => {
    requireCloudMode("signup");
    try {
      const password = opts.password ?? await promptPassword("Password (min 6 characters): ");
      const { signup } = await import("./auth/auth.ts");
      const auth = await signup(opts.email, password);
      console.log(`Account created! Logged in as ${auth.email} (${auth.userId})`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program
  .command("logout")
  .description("Log out of SessionGraph (cloud mode only)")
  .action(async () => {
    requireCloudMode("logout");
    try {
      const { logout } = await import("./auth/auth.ts");
      await logout();
      console.log("Logged out.");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

// ---- Status ----

program
  .command("status")
  .description("Show SessionGraph status")
  .action(async () => {
    console.log("SessionGraph Status");
    console.log("-------------------");
    console.log(`Storage mode:  ${config.storage.mode}`);

    if (config.storage.mode === "local") {
      console.log(`Data dir:      ${config.paths.dataDir}`);
      console.log(`PGlite dir:    ${config.paths.pgliteDir}`);

      try {
        const storage = await getStorageProvider();
        const userId = "00000000-0000-0000-0000-000000000000";
        const sessions = await storage.listSessions({ userId, limit: 1000 });
        const totalChains = sessions.reduce((sum, s) => sum + s.chainCount, 0);
        console.log(`Sessions:      ${sessions.length}`);
        console.log(`Chains:        ${totalChains}`);
        await resetProviders();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`Database:      Error: ${message}`);
      }

      // Ollama status
      try {
        const resp = await fetch(`${config.ollama.baseUrl}/api/tags`);
        if (resp.ok) {
          const data = (await resp.json()) as { models?: Array<{ name: string }> };
          const models = data.models?.map((m) => m.name).join(", ") ?? "none";
          console.log(`Ollama:        Running (${models})`);
        } else {
          console.log(`Ollama:        Error (status ${resp.status})`);
        }
      } catch {
        console.log(`Ollama:        Not running`);
      }
    } else {
      // Cloud mode status
      const { isAuthenticated, loadAuth } = await import("./auth/auth.ts");
      const { getSyncStatus } = await import("./storage/sync.ts");
      const authed = await isAuthenticated();
      const syncStatus = getSyncStatus();

      console.log(`Authenticated: ${authed ? "Yes" : "No"}`);
      console.log(`Pending sync:  ${syncStatus.pending} items`);
      console.log(`Online:        ${syncStatus.isOnline ? "Yes" : "No"}`);

      if (authed) {
        const auth = await loadAuth();
        if (auth) {
          console.log(`User:          ${auth.email}`);
          console.log(`Expires:       ${new Date(auth.expiresAt).toLocaleString()}`);
        }
      }
    }
  });

// ---- Search ----

program
  .command("search")
  .description("Search your reasoning history")
  .argument("<query>", "Search query")
  .option("-l, --limit <number>", "Max results", "5")
  .option("-p, --project <project>", "Filter by project")
  .action(async (query, opts) => {
    const userId = await resolveUserId();
    const storage = await getStorageProvider();
    const embeddings = await getEmbeddingProvider();

    const limit = parsePositiveInt(opts.limit, "limit");
    const queryEmbedding = await embeddings.generateEmbedding(query);
    const results = await storage.searchReasoning({
      queryEmbedding,
      queryText: query,
      userId,
      project: opts.project,
      limit,
    });

    if (results.length === 0) {
      console.log("No results found.");
      await resetProviders();
      return;
    }

    console.log(`Found ${results.length} results:\n`);
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const badges = [typeBadge(r.type), sourceBadge(r.source), statusIndicator(r.status)].filter(Boolean).join(" ");
      console.log(`${badges} ${bold(r.title)}`);
      console.log(`  ${colorPct(r.score, "Score")} ${dim("|")} ${colorPct(r.similarity, "Similarity")} ${dim("|")} ${colorPct(r.quality, "Quality")}`);
      if (r.project) console.log(`  ${dim("Project:")} ${green(r.project)}`);
      console.log(`  ${r.content}`);
      const tags = formatTags(r.tags);
      if (tags) console.log(`  ${tags}`);
      console.log(`  ${shortDate(r.createdAt)}`);
      if (i < results.length - 1) console.log(separator());
    }

    await resetProviders();
  });

// ---- Sessions ----

program
  .command("sessions")
  .description("List past AI sessions")
  .option("-l, --limit <number>", "Max sessions", "10")
  .option("-p, --project <project>", "Filter by project")
  .option("-t, --tool <tool>", "Filter by AI tool")
  .action(async (opts) => {
    const userId = await resolveUserId();
    const storage = await getStorageProvider();

    const limit = parsePositiveInt(opts.limit, "limit");
    const sessions = await storage.listSessions({
      userId,
      project: opts.project,
      tool: opts.tool,
      limit,
    });

    if (sessions.length === 0) {
      console.log("No sessions found.");
      await resetProviders();
      return;
    }

    console.log(bold(`Sessions (${sessions.length}):\n`));
    for (const s of sessions) {
      const chains = s.chainCount > 0 ? green(`${s.chainCount} chains`) : dim("0 chains");
      console.log(`  ${cyan(s.tool)} ${dim("|")} ${s.project ?? dim("no project")} ${dim("|")} ${chains} ${dim("|")} ${shortDate(s.startedAt)}`);
      if (s.summary) console.log(`    ${dim(s.summary)}`);
    }

    await resetProviders();
  });

// ---- Init ----

program
  .command("init")
  .description("Set up SessionGraph (detect tools, configure storage, install skills)")
  .action(async () => {
    await runInit();
  });

// ---- Backfill ----

program
  .command("backfill")
  .description("Backfill reasoning chains from past sessions using Ollama")
  .option("-t, --tool <tool>", "Only process sessions from this tool (opencode, claude-code)")
  .option("-l, --limit <number>", "Maximum sessions to process")
  .option("-d, --delay <seconds>", "Delay between sessions in seconds (default: 2)", "2")
  .option("--threads <number>", "Limit CPU threads for Ollama inference")
  .option("--cpu-only", "Run on CPU only (no GPU)")
  .action(async (opts) => {
    // Validate --tool
    const validTools = ["opencode", "claude-code"] as const;
    if (opts.tool && !validTools.includes(opts.tool)) {
      console.error(
        `Error: --tool must be one of: ${validTools.join(", ")}. Got '${opts.tool}'`
      );
      process.exit(1);
    }

    // Validate numeric args
    const delayMs = parsePositiveNumber(opts.delay, "delay") * 1000;
    const ollamaOptions: Record<string, number> = {};
    if (opts.threads) {
      ollamaOptions.numThread = parsePositiveInt(opts.threads, "threads");
    }
    if (opts.cpuOnly) ollamaOptions.numGpu = 0;

    const limit = opts.limit
      ? parsePositiveInt(opts.limit, "limit")
      : undefined;

    console.log("Starting backfill...");
    console.log(`  Delay: ${opts.delay}s between sessions`);
    if (opts.threads) console.log(`  CPU threads: ${opts.threads}`);
    if (opts.cpuOnly) console.log(`  Mode: CPU-only (no GPU)`);
    if (opts.limit) console.log(`  Limit: ${limit} sessions`);
    if (opts.tool) console.log(`  Tool: ${opts.tool}`);

    const startTime = Date.now();

    // Handle Ctrl+C gracefully — finish current session, then stop
    const sigintHandler = () => {
      console.log("\n\nCtrl+C received — finishing current session before stopping...");
      console.log("(Press Ctrl+C again to force quit)\n");
      requestBackfillStop();
      // On second Ctrl+C, force exit
      process.once("SIGINT", () => {
        console.log("\nForce quit.");
        process.exit(1);
      });
    };
    process.once("SIGINT", sigintHandler);

    const result = await runBackfill({
      tool: opts.tool,
      limit,
      delayMs,
      ollamaOptions: Object.keys(ollamaOptions).length > 0 ? ollamaOptions : undefined,
      onStepProgress: (step) => {
        const pct = Math.round((step.current / step.total) * 100);
        const prefix = `[${pct}%] ${step.current}/${step.total}`;
        const sid = step.sessionId.slice(0, 12);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

        switch (step.step) {
          case "parsing":
            process.stdout.write(`\r\x1b[K${prefix} | ${step.tool}:${sid} | Parsing...`);
            break;
          case "extracting":
            process.stdout.write(`\r\x1b[K${prefix} | ${step.tool}:${sid} | Extracting (${step.detail})...`);
            break;
          case "embedding":
            process.stdout.write(`\r\x1b[K${prefix} | ${step.tool}:${sid} | Generating embeddings (${step.detail})...`);
            break;
          case "saving":
            process.stdout.write(`\r\x1b[K${prefix} | ${step.tool}:${sid} | Saving (${step.detail})...`);
            break;
          case "done":
            process.stdout.write(`\r\x1b[K${prefix} | ${step.tool}:${sid} | Done ${step.detail} [${elapsed}s]\n`);
            break;
          case "skipped":
            process.stdout.write(`\r\x1b[K${prefix} | ${step.tool}:${sid} | Skipped (${step.detail}) [${elapsed}s]\n`);
            break;
          case "error":
            process.stdout.write(`\r\x1b[K${prefix} | ${step.tool}:${sid} | ERROR: ${step.detail} [${elapsed}s]\n`);
            break;
        }
      },
    });

    // Remove SIGINT handler after backfill completes
    process.removeListener("SIGINT", sigintHandler);

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nDone in ${totalElapsed}s! Processed ${result.sessionsProcessed} sessions, extracted ${result.chainsExtracted} chains.`);
    if (result.sessionsSkipped > 0) console.log(`Skipped ${result.sessionsSkipped} sessions (too short or empty).`);
    if (result.errors.length > 0) {
      console.log(`${result.errors.length} error(s):`);
      for (const err of result.errors.slice(0, 5)) console.log(`  - ${err}`);
    }
  });

// ---- Link (auto-linking pass) ----

program
  .command("link")
  .description("Auto-link reasoning chains into a knowledge graph using Ollama")
  .option("-l, --limit <number>", "Maximum chains to process")
  .option("-k, --top-k <number>", "Top-K similar chains to compare (default: 5)", "5")
  .option("-d, --delay <seconds>", "Delay between classification calls in seconds (default: 1)", "1")
  .option("--threshold <number>", "Minimum similarity threshold for candidates (default: 0.5)", "0.5")
  .option("--threads <number>", "Limit CPU threads for Ollama inference")
  .option("--cpu-only", "Run on CPU only (no GPU)")
  .action(async (opts) => {
    const delayMs = parsePositiveNumber(opts.delay, "delay") * 1000;
    const topK = parsePositiveInt(opts.topK, "top-k");
    const threshold = parsePositiveNumber(opts.threshold, "threshold");

    const ollamaOptions: Record<string, number> = {};
    if (opts.threads) {
      ollamaOptions.numThread = parsePositiveInt(opts.threads, "threads");
    }
    if (opts.cpuOnly) ollamaOptions.numGpu = 0;

    const limit = opts.limit
      ? parsePositiveInt(opts.limit, "limit")
      : undefined;

    console.log("Starting auto-linking pass...");
    console.log(`  Top-K: ${topK} candidates per chain`);
    console.log(`  Threshold: ${threshold}`);
    console.log(`  Delay: ${opts.delay}s between classifications`);
    if (opts.threads) console.log(`  CPU threads: ${opts.threads}`);
    if (opts.cpuOnly) console.log(`  Mode: CPU-only (no GPU)`);
    if (limit) console.log(`  Limit: ${limit} chains`);

    const startTime = Date.now();

    const result = await runLinker({
      limit,
      topK,
      threshold,
      delayMs,
      ollamaOptions: Object.keys(ollamaOptions).length > 0 ? ollamaOptions : undefined,
      onProgress: (progress) => {
        const pct = Math.round((progress.current / progress.total) * 100);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const cid = progress.chainId.slice(0, 8);
        process.stdout.write(
          `\r\x1b[K[${pct}%] ${progress.current}/${progress.total} | chain:${cid} | ` +
          `${progress.candidatesFound} candidates, ${progress.relationsCreated} links [${elapsed}s]`
        );
        // Print newline after each chain
        process.stdout.write("\n");
      },
    });

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nDone in ${totalElapsed}s!`);
    console.log(`  Chains processed: ${result.chainsProcessed}`);
    console.log(`  Relations created: ${result.relationsCreated}`);
    if (result.errors.length > 0) {
      console.log(`  ${result.errors.length} error(s):`);
      for (const err of result.errors.slice(0, 5)) console.log(`    - ${err}`);
    }

    await resetProviders();
  });

// ---- Stats ----

program
  .command("stats")
  .description("Show reasoning chain statistics")
  .action(async () => {
    const userId = await resolveUserId();
    const storage = await getStorageProvider();

    const sessions = await storage.listSessions({ userId, limit: 10000 });
    const timeline = await storage.getTimeline({ userId, limit: 10000 });

    // Aggregate chains across all timeline entries
    const allChains = timeline.flatMap((e) => e.reasoningChains);
    const totalChains = allChains.length;
    const totalSessions = sessions.length;

    // Chains by type
    const byType: Record<string, number> = {};
    for (const c of allChains) {
      byType[c.type] = (byType[c.type] ?? 0) + 1;
    }

    // Sessions by tool
    const byTool: Record<string, number> = {};
    for (const s of sessions) {
      byTool[s.tool] = (byTool[s.tool] ?? 0) + 1;
    }

    // Sessions by project
    const byProject: Record<string, number> = {};
    for (const s of sessions) {
      const proj = s.project ?? "(no project)";
      byProject[proj] = (byProject[proj] ?? 0) + 1;
    }

    // Storage size (local mode only)
    let storageSize = "";
    if (config.storage.mode === "local") {
      try {
        const { statSync, readdirSync } = await import("node:fs");
        const { join } = await import("node:path");
        const pgliteDir = config.paths.pgliteDir;
        let totalBytes = 0;

        const walk = (dir: string) => {
          try {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const fullPath = join(dir, entry.name);
              if (entry.isDirectory()) {
                walk(fullPath);
              } else {
                totalBytes += statSync(fullPath).size;
              }
            }
          } catch {
            // skip inaccessible dirs
          }
        };

        walk(pgliteDir);

        if (totalBytes < 1024) storageSize = `${totalBytes} B`;
        else if (totalBytes < 1024 * 1024) storageSize = `${(totalBytes / 1024).toFixed(1)} KB`;
        else storageSize = `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`;
      } catch {
        storageSize = "unknown";
      }
    }

    // Output
    console.log(bold("\nSessionGraph Statistics\n"));
    console.log(`  ${bold("Total sessions:")}  ${cyan(String(totalSessions))}`);
    console.log(`  ${bold("Total chains:")}    ${cyan(String(totalChains))}`);
    if (storageSize) {
      console.log(`  ${bold("Storage size:")}    ${cyan(storageSize)}`);
    }
    console.log(`  ${bold("Storage mode:")}    ${config.storage.mode}`);

    if (Object.keys(byType).length > 0) {
      console.log(bold("\n  Chains by type:"));
      // Sort by count descending
      const sorted = Object.entries(byType).sort((a, b) => b[1] - a[1]);
      for (const [type, count] of sorted) {
        console.log(`    ${typeBadge(type)} ${count}`);
      }
    }

    if (Object.keys(byTool).length > 0) {
      console.log(bold("\n  Sessions by tool:"));
      const sorted = Object.entries(byTool).sort((a, b) => b[1] - a[1]);
      for (const [tool, count] of sorted) {
        console.log(`    ${cyan(tool)} ${count}`);
      }
    }

    if (Object.keys(byProject).length > 0) {
      console.log(bold("\n  Sessions by project:"));
      const sorted = Object.entries(byProject).sort((a, b) => b[1] - a[1]);
      for (const [project, count] of sorted) {
        console.log(`    ${green(project)} ${count}`);
      }
    }

    console.log();
    await resetProviders();
  });

// ---- Export ----

program
  .command("export")
  .description("Export reasoning chains to JSON or Markdown")
  .option("-f, --format <format>", "Output format: json or markdown", "json")
  .option("-o, --output <file>", "Output file (default: stdout)")
  .option("-p, --project <project>", "Filter by project")
  .action(async (opts) => {
    const validFormats = ["json", "markdown"] as const;
    if (!validFormats.includes(opts.format)) {
      console.error(`Error: --format must be one of: ${validFormats.join(", ")}. Got '${opts.format}'`);
      process.exit(1);
    }

    const userId = await resolveUserId();
    const storage = await getStorageProvider();

    const timeline = await storage.getTimeline({
      userId,
      project: opts.project,
      limit: 10000,
    });

    let output: string;

    if (opts.format === "json") {
      // Structured JSON export
      const data = timeline.map((entry) => ({
        session: {
          id: entry.sessionId,
          tool: entry.tool,
          project: entry.project ?? null,
          startedAt: entry.startedAt,
          endedAt: entry.endedAt ?? null,
          summary: entry.summary ?? null,
        },
        chains: entry.reasoningChains.map((c) => ({
          id: c.id,
          type: c.type,
          title: c.title,
          content: c.content,
          tags: c.tags,
          quality: c.quality,
          project: c.project ?? null,
          source: c.source ?? null,
          status: c.status ?? "active",
          createdAt: c.createdAt,
        })),
      }));
      output = JSON.stringify(data, null, 2);
    } else {
      // Markdown export
      const lines: string[] = [];
      lines.push("# SessionGraph Export\n");
      lines.push(`Exported: ${new Date().toISOString()}`);
      if (opts.project) lines.push(`Project: ${opts.project}`);
      lines.push(`Sessions: ${timeline.length}`);
      const totalChains = timeline.reduce((sum, e) => sum + e.reasoningChains.length, 0);
      lines.push(`Chains: ${totalChains}\n`);
      lines.push("---\n");

      for (const entry of timeline) {
        lines.push(`## ${entry.tool} — ${entry.project ?? "no project"}`);
        lines.push(`**Started:** ${entry.startedAt}`);
        if (entry.endedAt) lines.push(`**Ended:** ${entry.endedAt}`);
        if (entry.summary) lines.push(`**Summary:** ${entry.summary}`);
        lines.push("");

        for (const c of entry.reasoningChains) {
          const statusMark = c.status === "superseded" ? " ~~(superseded)~~" : "";
          lines.push(`### [${c.type.toUpperCase()}] ${c.title}${statusMark}\n`);
          lines.push(c.content);
          lines.push("");
          if (c.tags.length > 0) lines.push(`*Tags: ${c.tags.join(", ")}*`);
          const meta: string[] = [`Quality: ${((c.quality ?? 1.0) * 100).toFixed(0)}%`];
          if (c.source) meta.push(`Source: ${c.source}`);
          if (c.project) meta.push(`Project: ${c.project}`);
          lines.push(`*${meta.join(" | ")}*\n`);
        }

        lines.push("---\n");
      }

      output = lines.join("\n");
    }

    if (opts.output) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(opts.output, output, "utf-8");
      console.log(`Exported ${timeline.length} sessions to ${opts.output}`);
    } else {
      process.stdout.write(output);
    }

    await resetProviders();
  });

// ---- MCP (starts the MCP server) ----

program
  .command("mcp")
  .description("Start the MCP server (for AI tool integration)")
  .action(async () => {
    await import("./mcp/server.ts");
  });

// ---- Sync (cloud-only) ----

program
  .command("sync")
  .description("Manually sync pending items to Supabase (cloud mode only)")
  .action(async () => {
    requireCloudMode("sync");
    await resolveUserId(); // sets up auth

    const { syncToSupabase } = await import("./storage/sync.ts");
    const { getPendingCount } = await import("./storage/buffer.ts");

    let pending = getPendingCount();
    if (pending === 0) {
      console.log("Nothing to sync.");
      return;
    }

    console.log(`Syncing ${pending} items...`);
    let totalSynced = 0;
    let totalFailed = 0;

    while (pending > 0) {
      const result = await syncToSupabase();
      totalSynced += result.synced;
      totalFailed += result.failed;

      const remaining = getPendingCount();
      console.log(`  Batch: synced ${result.synced}, failed ${result.failed} | Total: synced ${totalSynced}, remaining ${remaining}`);

      if (result.synced === 0 && result.failed === 0) break;
      if (result.synced === 0 && result.failed > 0) break;

      pending = remaining;
    }

    console.log(`Done. Total synced: ${totalSynced}, total failed: ${totalFailed}.`);
  });

program.parse();
