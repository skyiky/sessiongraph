#!/usr/bin/env bun
import { Command } from "commander";
import { config } from "./config/config.ts";
import { getStorageProvider, getEmbeddingProvider, resetProviders } from "./storage/provider.ts";
import { runInit } from "./cli/init.ts";
import { runBackfill } from "./backfill/backfill.ts";

const program = new Command();

/**
 * Parse a string as a positive integer, or exit with an error.
 * Used as a Commander argParser for --limit, --threads, etc.
 */
function parsePositiveInt(value: string, flagName: string): number {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`Error: --${flagName} must be a positive integer, got '${value}'`);
    process.exit(1);
  }
  return n;
}

/**
 * Parse a string as a positive number (float allowed), or exit with an error.
 * Used for --delay which accepts fractional seconds.
 */
function parsePositiveNumber(value: string, flagName: string): number {
  const n = parseFloat(value);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`Error: --${flagName} must be a non-negative number, got '${value}'`);
    process.exit(1);
  }
  return n;
}

program
  .name("sessiongraph")
  .description("Never lose the reasoning behind an AI-assisted decision again.")
  .version("0.1.0");

/**
 * Helper: require cloud mode for a command, exit with a clear error if local.
 */
function requireCloudMode(commandName: string): void {
  if (config.storage.mode !== "cloud") {
    console.error(
      `Error: '${commandName}' requires cloud mode.\n` +
        `Current mode: ${config.storage.mode}\n` +
        `Set SESSIONGRAPH_STORAGE_MODE=cloud to use this command.`
    );
    process.exit(1);
  }
}

/**
 * Helper: resolve the current user ID.
 * - Local mode: fixed user ID, no auth.
 * - Cloud mode: loads auth.json, exits if not authenticated.
 */
async function resolveUserId(): Promise<string> {
  if (config.storage.mode === "local") {
    return "00000000-0000-0000-0000-000000000000";
  }

  const { loadAuth } = await import("./auth/auth.ts");
  const auth = await loadAuth();
  if (!auth) {
    console.error("Not authenticated. Run 'sessiongraph login' first.");
    process.exit(1);
  }

  // Set auth on the Supabase provider if needed
  const { setSupabaseAuth } = await import("./storage/supabase.ts");
  await setSupabaseAuth(auth.accessToken, auth.refreshToken);

  return auth.userId;
}

// ---- Auth Commands (cloud-only) ----

program
  .command("login")
  .description("Log in to SessionGraph (cloud mode only)")
  .requiredOption("-e, --email <email>", "Email address")
  .requiredOption("-p, --password <password>", "Password")
  .action(async (opts) => {
    requireCloudMode("login");
    try {
      const { login } = await import("./auth/auth.ts");
      const auth = await login(opts.email, opts.password);
      console.log(`Logged in as ${auth.email} (${auth.userId})`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("signup")
  .description("Create a new SessionGraph account (cloud mode only)")
  .requiredOption("-e, --email <email>", "Email address")
  .requiredOption("-p, --password <password>", "Password (min 6 characters)")
  .action(async (opts) => {
    requireCloudMode("signup");
    try {
      const { signup } = await import("./auth/auth.ts");
      const auth = await signup(opts.email, opts.password);
      console.log(`Account created! Logged in as ${auth.email} (${auth.userId})`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("logout")
  .description("Log out of SessionGraph (cloud mode only)")
  .action(async () => {
    requireCloudMode("logout");
    const { logout } = await import("./auth/auth.ts");
    await logout();
    console.log("Logged out.");
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
      } catch (err: any) {
        console.log(`Database:      Error: ${err.message}`);
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
    for (const r of results) {
      console.log(`[${r.type.toUpperCase()}] ${r.title}`);
      console.log(`  Similarity: ${(r.similarity * 100).toFixed(1)}%`);
      console.log(`  ${r.content}`);
      if (r.tags.length > 0) console.log(`  Tags: ${r.tags.join(", ")}`);
      console.log(`  Date: ${r.createdAt}`);
      console.log();
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

    console.log(`Sessions (${sessions.length}):\n`);
    for (const s of sessions) {
      console.log(`${s.startedAt} | ${s.tool} | ${s.project ?? "no project"} | ${s.chainCount} chains`);
      if (s.summary) console.log(`  ${s.summary}`);
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
    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nDone in ${totalElapsed}s! Processed ${result.sessionsProcessed} sessions, extracted ${result.chainsExtracted} chains.`);
    if (result.sessionsSkipped > 0) console.log(`Skipped ${result.sessionsSkipped} sessions (too short or empty).`);
    if (result.errors.length > 0) {
      console.log(`${result.errors.length} error(s):`);
      for (const err of result.errors.slice(0, 5)) console.log(`  - ${err}`);
    }
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
