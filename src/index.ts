#!/usr/bin/env bun
import { Command } from "commander";
import { login, signup, logout, isAuthenticated, loadAuth } from "./auth/auth.ts";
import { setSupabaseAuth, searchReasoning, generateEmbedding, listSessions } from "./storage/supabase.ts";
import { syncToSupabase, getSyncStatus } from "./storage/sync.ts";
import { ingestOpenCodeSessions } from "./ingestion/pipeline.ts";
import { getPendingCount } from "./storage/buffer.ts";
import { runInit } from "./cli/init.ts";
import { runBackfill } from "./backfill/backfill.ts";

const program = new Command();

program
  .name("sessiongraph")
  .description("Never lose the reasoning behind an AI-assisted decision again.")
  .version("0.1.0");

// ---- Auth Commands ----

program
  .command("login")
  .description("Log in to SessionGraph")
  .requiredOption("-e, --email <email>", "Email address")
  .requiredOption("-p, --password <password>", "Password")
  .action(async (opts) => {
    try {
      const auth = await login(opts.email, opts.password);
      console.log(`Logged in as ${auth.email} (${auth.userId})`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("signup")
  .description("Create a new SessionGraph account")
  .requiredOption("-e, --email <email>", "Email address")
  .requiredOption("-p, --password <password>", "Password (min 6 characters)")
  .action(async (opts) => {
    try {
      const auth = await signup(opts.email, opts.password);
      console.log(`Account created! Logged in as ${auth.email} (${auth.userId})`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("logout")
  .description("Log out of SessionGraph")
  .action(async () => {
    await logout();
    console.log("Logged out.");
  });

// ---- Status ----

program
  .command("status")
  .description("Show SessionGraph status")
  .action(async () => {
    const authed = await isAuthenticated();
    const syncStatus = getSyncStatus();

    console.log("SessionGraph Status");
    console.log("-------------------");
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
  });

// ---- Ingest ----

program
  .command("ingest")
  .description("Ingest new sessions from AI tools (OpenCode)")
  .action(async () => {
    const auth = await loadAuth();
    if (!auth) {
      console.error("Not authenticated. Run 'sessiongraph login' first.");
      process.exit(1);
    }

    await setSupabaseAuth(auth.accessToken, auth.refreshToken);

    console.log("Ingesting new sessions from OpenCode...");
    const result = await ingestOpenCodeSessions(auth.userId);
    console.log(`Processed ${result.sessionsProcessed} sessions, extracted ${result.chainsExtracted} reasoning chains.`);

    // Sync to Supabase
    const pending = getPendingCount();
    if (pending > 0) {
      console.log(`Syncing ${pending} items to Supabase...`);
      const syncResult = await syncToSupabase();
      console.log(`Synced ${syncResult.synced}, failed ${syncResult.failed}.`);
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
    const auth = await loadAuth();
    if (!auth) {
      console.error("Not authenticated. Run 'sessiongraph login' first.");
      process.exit(1);
    }

    await setSupabaseAuth(auth.accessToken, auth.refreshToken);

    const queryEmbedding = await generateEmbedding(query);
    const results = await searchReasoning({
      queryEmbedding,
      userId: auth.userId,
      project: opts.project,
      limit: parseInt(opts.limit, 10),
    });

    if (results.length === 0) {
      console.log("No results found.");
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
  });

// ---- Sessions ----

program
  .command("sessions")
  .description("List past AI sessions")
  .option("-l, --limit <number>", "Max sessions", "10")
  .option("-p, --project <project>", "Filter by project")
  .option("-t, --tool <tool>", "Filter by AI tool")
  .action(async (opts) => {
    const auth = await loadAuth();
    if (!auth) {
      console.error("Not authenticated. Run 'sessiongraph login' first.");
      process.exit(1);
    }

    await setSupabaseAuth(auth.accessToken, auth.refreshToken);

    const sessions = await listSessions({
      userId: auth.userId,
      project: opts.project,
      tool: opts.tool,
      limit: parseInt(opts.limit, 10),
    });

    if (sessions.length === 0) {
      console.log("No sessions found.");
      return;
    }

    console.log(`Sessions (${sessions.length}):\n`);
    for (const s of sessions) {
      console.log(`${s.startedAt} | ${s.tool} | ${s.project ?? "no project"} | ${s.chainCount} chains`);
      if (s.summary) console.log(`  ${s.summary}`);
    }
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
  .action(async (opts) => {
    console.log("Starting backfill...");
    const result = await runBackfill({
      tool: opts.tool,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      onProgress: (progress) => {
        const pct = Math.round((progress.current / progress.total) * 100);
        process.stdout.write(
          `\r[${pct}%] ${progress.current}/${progress.total} — ` +
          `${progress.tool}:${progress.sessionId.slice(0, 8)}… +${progress.chainsExtracted} chains`
        );
      },
    });
    process.stdout.write("\n");
    console.log(`Done! Processed ${result.sessionsProcessed} sessions, extracted ${result.chainsExtracted} chains.`);
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
    // Import and run the MCP server
    await import("./mcp/server.ts");
  });

// ---- Sync ----

program
  .command("sync")
  .description("Manually sync pending items to Supabase")
  .action(async () => {
    const auth = await loadAuth();
    if (!auth) {
      console.error("Not authenticated. Run 'sessiongraph login' first.");
      process.exit(1);
    }

    await setSupabaseAuth(auth.accessToken, auth.refreshToken);

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

      // If nothing was synced and nothing failed, we're stuck
      if (result.synced === 0 && result.failed === 0) break;
      // If everything failed this round, stop to avoid infinite loop
      if (result.synced === 0 && result.failed > 0) break;

      pending = remaining;
    }

    console.log(`Done. Total synced: ${totalSynced}, total failed: ${totalFailed}.`);
  });

program.parse();
