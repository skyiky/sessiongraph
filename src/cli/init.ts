/**
 * init.ts — Interactive setup wizard for SessionGraph.
 *
 * Walks the user through first-time configuration:
 *   1. Environment detection (AI tools, session counts)
 *   2. Storage mode selection (local PGlite vs cloud Supabase)
 *   3. Ollama availability check (local mode)
 *   4. Backfill strategy selection
 *   5. MCP server config installation (OpenCode)
 *   6. Auto-reasoning-capture skill installation
 *
 * Uses raw stdin/stdout for prompting — no external prompt libraries.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { detectEnvironment } from "./detect.ts";
import type { DetectionResult, OllamaStatus } from "./detect.ts";
import { runBackfill, requestBackfillStop } from "../backfill/backfill.ts";
import type { BackfillProgress } from "../backfill/backfill.ts";
import { config } from "../config/config.ts";

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";

function green(s: string): string { return `${GREEN}${s}${RESET}`; }
function yellow(s: string): string { return `${YELLOW}${s}${RESET}`; }
function cyan(s: string): string { return `${CYAN}${s}${RESET}`; }
function dim(s: string): string { return `${DIM}${s}${RESET}`; }
function bold(s: string): string { return `${BOLD}${s}${RESET}`; }
function red(s: string): string { return `${RED}${s}${RESET}`; }

// ---------------------------------------------------------------------------
// Box drawing helpers
// ---------------------------------------------------------------------------

function printBox(lines: string[]): void {
  // Calculate width from the longest raw (un-escaped) line
  const rawLength = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
  const maxLen = Math.max(...lines.map(rawLength), 30);
  const width = maxLen + 4; // 2 padding each side

  process.stdout.write(`┌${"─".repeat(width)}┐\n`);
  for (const line of lines) {
    const pad = width - rawLength(line) - 2;
    process.stdout.write(`│ ${line}${" ".repeat(Math.max(pad, 0))} │\n`);
  }
  process.stdout.write(`└${"─".repeat(width)}┘\n`);
}

function printSeparator(): void {
  process.stdout.write(`\n${dim("─".repeat(50))}\n\n`);
}

// ---------------------------------------------------------------------------
// Simple readline prompt (no external libraries)
// ---------------------------------------------------------------------------

/**
 * Prompt the user with a question, optionally showing numbered options.
 * Reads a single line from stdin.
 */
async function prompt(question: string, options?: string[]): Promise<string> {
  process.stdout.write(`\n${question}\n`);

  if (options && options.length > 0) {
    for (let i = 0; i < options.length; i++) {
      process.stdout.write(`  ${cyan(`${i + 1})`)} ${options[i]}\n`);
    }
  }

  process.stdout.write(`\n${CYAN}> ${RESET}`);

  return new Promise<string>((resolve) => {
    // Build up the line from raw data chunks
    let buffer = "";

    const onData = (chunk: Buffer) => {
      const str = chunk.toString("utf-8");
      for (const ch of str) {
        if (ch === "\n" || ch === "\r") {
          process.stdin.removeListener("data", onData);
          process.stdin.pause();
          resolve(buffer.trim());
          return;
        }
        buffer += ch;
      }
    };

    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", onData);
  });
}

/**
 * Ask a yes/no question. Returns true for "y"/"yes", false otherwise.
 */
async function confirm(question: string): Promise<boolean> {
  const answer = await prompt(`${question} ${dim("[y/N]")}`);
  return /^y(es)?$/i.test(answer);
}

// ---------------------------------------------------------------------------
// Project root detection
// ---------------------------------------------------------------------------

/**
 * Get the SessionGraph project root (directory containing package.json
 * with name "sessiongraph", or fall back to cwd).
 */
function getProjectRoot(): string {
  // Walk up from this file's directory to find the project root
  let dir = dirname(new URL(import.meta.url).pathname);
  // On Windows, strip leading slash from /C:/... paths
  if (process.platform === "win32" && dir.startsWith("/")) {
    dir = dir.slice(1);
  }

  for (let i = 0; i < 5; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

// ---------------------------------------------------------------------------
// OpenCode config paths
// ---------------------------------------------------------------------------

function getOpenCodeConfigDir(): string {
  return join(homedir(), ".config", "opencode");
}

function getOpenCodeConfigPath(): string {
  return join(getOpenCodeConfigDir(), "opencode.json");
}

function getOpenCodeSkillsDir(): string {
  return join(getOpenCodeConfigDir(), "skills");
}

// ---------------------------------------------------------------------------
// Step 1 & 2: Welcome + environment detection
// ---------------------------------------------------------------------------

async function stepDetectEnvironment(): Promise<DetectionResult> {
  printBox([
    `${bold("SessionGraph Init")}`,
    `${dim("Never lose a reasoning chain again")}`,
  ]);

  process.stdout.write(`\n${cyan("Scanning environment...")}\n\n`);

  const result = await detectEnvironment();

  // Show detected tools
  process.stdout.write(`${bold("Detected AI tools:")}\n\n`);

  for (const tool of result.tools) {
    const status = tool.available
      ? green("✓ found")
      : dim("✗ not found");
    const sessions = tool.available
      ? ` — ${bold(String(tool.sessionCount))} sessions`
      : "";
    process.stdout.write(`  ${status}  ${bold(tool.name)}${sessions}\n`);
    if (tool.available) {
      process.stdout.write(`         ${dim(tool.path)}\n`);
    }
  }

  const availableTools = result.tools.filter((t) => t.available);
  if (availableTools.length === 0) {
    process.stdout.write(
      `\n${yellow("No AI tools detected.")} SessionGraph works with OpenCode and Claude Code.\n` +
      `Install one and create some sessions, then re-run ${cyan("sessiongraph init")}.\n`
    );
  }

  // Show Ollama status
  process.stdout.write(`\n${bold("Ollama status:")}\n\n`);
  if (result.ollama.running) {
    process.stdout.write(`  ${green("✓ running")} at ${dim(result.ollama.baseUrl)}\n`);
    const embStatus = result.ollama.embeddingModelReady
      ? green("✓ ready")
      : yellow("✗ missing");
    const chatStatus = result.ollama.chatModelReady
      ? green("✓ ready")
      : yellow("✗ missing");
    process.stdout.write(`  ${embStatus}  embedding model (${config.ollama.embeddingModel})\n`);
    process.stdout.write(`  ${chatStatus}  chat model (${config.ollama.chatModel})\n`);
  } else {
    process.stdout.write(`  ${yellow("✗ not running")} at ${dim(result.ollama.baseUrl)}\n`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step 3: Storage choice
// ---------------------------------------------------------------------------

interface StorageChoice {
  mode: "local" | "cloud";
  supabaseUrl?: string;
  supabaseAnonKey?: string;
}

async function stepStorageChoice(): Promise<StorageChoice> {
  printSeparator();
  process.stdout.write(`${bold("Storage Setup")}\n`);

  const answer = await prompt("Where should SessionGraph store your data?", [
    `${bold("Local")} ${dim("— PGlite embedded database, runs offline, no account needed")}`,
    `${bold("Cloud")} ${dim("— Supabase, syncs across machines, requires account")}`,
  ]);

  if (answer === "2") {
    process.stdout.write(
      `\n${cyan("Cloud mode")} requires a Supabase project.\n` +
      `If you don't have one, create a free project at ${bold("https://supabase.com")}\n` +
      `Then find your project URL and anon key in Settings → API.\n\n`
    );

    const supabaseUrl = await prompt("Supabase project URL:");
    const supabaseAnonKey = await prompt("Supabase anon key:");

    if (!supabaseUrl || !supabaseAnonKey) {
      process.stdout.write(
        `\n${yellow("Missing Supabase credentials.")} Falling back to local mode.\n`
      );
      return { mode: "local" };
    }

    process.stdout.write(`\n${green("✓")} Cloud storage configured.\n`);
    process.stdout.write(
      `${dim("Set these environment variables in your shell profile:")}\n` +
      `  ${cyan("SESSIONGRAPH_STORAGE_MODE")}=cloud\n` +
      `  ${cyan("SESSIONGRAPH_SUPABASE_URL")}=${supabaseUrl}\n` +
      `  ${cyan("SESSIONGRAPH_SUPABASE_ANON_KEY")}=${supabaseAnonKey}\n`
    );

    return { mode: "cloud", supabaseUrl, supabaseAnonKey };
  }

  process.stdout.write(`\n${green("✓")} Local storage selected ${dim("(default, no config needed)")}\n`);
  return { mode: "local" };
}

// ---------------------------------------------------------------------------
// Step 4: Ollama check (local mode only)
// ---------------------------------------------------------------------------

/**
 * Validates Ollama is available for local mode. Returns false if setup
 * cannot proceed (user needs to install/configure Ollama first).
 */
function stepOllamaCheck(ollama: OllamaStatus, storageMode: "local" | "cloud"): boolean {
  if (storageMode === "cloud") return true;

  printSeparator();
  process.stdout.write(`${bold("Ollama Check")}\n\n`);

  if (!ollama.running) {
    process.stdout.write(
      `${red("✗")} Ollama is required for local mode.\n\n` +
      `  ${bold("Install:")} ${cyan("https://ollama.com")}\n` +
      `  ${bold("Start:")}   ${cyan("ollama serve")}\n` +
      `  ${bold("Models:")}  ${cyan(`ollama pull ${config.ollama.embeddingModel}`)}\n` +
      `             ${cyan(`ollama pull ${config.ollama.chatModel}`)}\n\n` +
      `Run ${cyan("sessiongraph init")} again after setting up Ollama.\n`
    );
    return false;
  }

  const missing: string[] = [];
  if (!ollama.embeddingModelReady) missing.push(config.ollama.embeddingModel);
  if (!ollama.chatModelReady) missing.push(config.ollama.chatModel);

  if (missing.length > 0) {
    process.stdout.write(
      `${yellow("!")} Ollama is running, but required models are missing.\n\n` +
      `Pull them with:\n`
    );
    for (const model of missing) {
      process.stdout.write(`  ${cyan(`ollama pull ${model}`)}\n`);
    }
    process.stdout.write(
      `\nRun ${cyan("sessiongraph init")} again after pulling the models.\n`
    );
    return false;
  }

  process.stdout.write(`${green("✓")} Ollama ready with all required models.\n`);
  return true;
}

// ---------------------------------------------------------------------------
// Step 5: Backfill method
// ---------------------------------------------------------------------------

async function stepBackfill(
  detection: DetectionResult,
  storageChoice: StorageChoice,
): Promise<void> {
  if (!detection.hasAnySessions) {
    printSeparator();
    process.stdout.write(
      `${dim("No sessions found to backfill — skipping.\n")}`
    );
    return;
  }

  printSeparator();
  process.stdout.write(`${bold("Backfill Past Sessions")}\n`);

  const totalSessions = detection.tools.reduce((sum, t) => sum + t.sessionCount, 0);
  process.stdout.write(
    `\nFound ${bold(String(totalSessions))} session(s) across detected tools.\n` +
    `Backfilling extracts reasoning chains from your past conversations.\n`
  );

  const options = [
    `${bold("Ollama automated")} ${dim("— process all sessions now via Ollama (may take a while)")}`,
    `${bold("Agent skill-based")} ${dim("— install a skill so your AI agent does it conversationally")}`,
    `${bold("Skip")} ${dim("— don't backfill, start fresh")}`,
  ];

  const answer = await prompt("How would you like to backfill?", options);

  if (answer === "1") {
    await backfillWithOllama(totalSessions);
  } else if (answer === "2") {
    await backfillWithSkill();
  } else {
    process.stdout.write(`\n${dim("Skipping backfill.")}\n`);
  }
}

async function backfillWithOllama(totalSessions: number): Promise<void> {
  process.stdout.write(
    `\n${cyan("Starting automated backfill...")} ` +
    `${dim(`(${totalSessions} session(s))`)}\n\n`
  );

  // Handle Ctrl+C gracefully
  const sigintHandler = () => {
    process.stdout.write(`\n\n${yellow("!")} Ctrl+C — finishing current session...\n`);
    requestBackfillStop();
    process.once("SIGINT", () => process.exit(1));
  };
  process.once("SIGINT", sigintHandler);

  try {
    const result = await runBackfill({
      onProgress: (progress: BackfillProgress) => {
        const pct = Math.round((progress.current / progress.total) * 100);
        const bar = progressBar(pct);
        process.stdout.write(
          `\r  ${bar} ${pct}%  ` +
          `${dim(`[${progress.current}/${progress.total}]`)} ` +
          `${progress.tool}:${progress.sessionId.slice(0, 8)}… ` +
          `${cyan(`+${progress.chainsExtracted}`)} chains`
        );
      },
    });

    process.stdout.write("\n\n");
    process.stdout.write(
      `${green("✓")} Backfill complete!\n` +
      `  Sessions processed: ${bold(String(result.sessionsProcessed))}\n` +
      `  Sessions skipped:   ${dim(String(result.sessionsSkipped))}\n` +
      `  Chains extracted:   ${bold(String(result.chainsExtracted))}\n`
    );

    if (result.errors.length > 0) {
      process.stdout.write(
        `\n${yellow("!")} ${result.errors.length} error(s) during backfill:\n`
      );
      for (const err of result.errors.slice(0, 5)) {
        process.stdout.write(`  ${dim("•")} ${err}\n`);
      }
      if (result.errors.length > 5) {
        process.stdout.write(`  ${dim(`... and ${result.errors.length - 5} more`)}\n`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      `\n${red("✗")} Backfill failed: ${message}\n` +
      `${dim("You can retry later with:")} ${cyan("sessiongraph backfill")}\n`
    );
  } finally {
    process.removeListener("SIGINT", sigintHandler);
  }
}

function progressBar(pct: number): string {
  const filled = Math.round(pct / 5);
  const empty = 20 - filled;
  return `[${GREEN}${"█".repeat(filled)}${DIM}${"░".repeat(empty)}${RESET}]`;
}

async function backfillWithSkill(): Promise<void> {
  const projectRoot = getProjectRoot();
  const srcSkill = join(projectRoot, "skills", "backfill", "SKILL.md");
  const destDir = join(getOpenCodeSkillsDir(), "backfill");
  const destFile = join(destDir, "SKILL.md");

  try {
    if (!existsSync(srcSkill)) {
      process.stdout.write(
        `\n${red("✗")} Backfill skill source not found at:\n` +
        `  ${dim(srcSkill)}\n`
      );
      return;
    }

    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    copyFileSync(srcSkill, destFile);

    process.stdout.write(
      `\n${green("✓")} Backfill skill installed to:\n` +
      `  ${dim(destFile)}\n\n` +
      `${bold("Next steps:")}\n` +
      `  1. Start a new OpenCode session\n` +
      `  2. Ask your AI agent: ${cyan('"Run /backfill to process my past sessions"')}\n` +
      `  3. The agent will read old sessions and extract reasoning chains\n`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      `\n${red("✗")} Failed to install backfill skill: ${message}\n`
    );
  }
}

// ---------------------------------------------------------------------------
// Step 6: Install MCP config for detected tools
// ---------------------------------------------------------------------------

async function stepInstallMcp(storageChoice: StorageChoice): Promise<void> {
  printSeparator();
  process.stdout.write(`${bold("MCP Server Configuration")}\n\n`);

  const configPath = getOpenCodeConfigPath();
  const configDir = getOpenCodeConfigDir();
  const projectRoot = getProjectRoot();
  const serverScript = join(projectRoot, "src", "mcp", "server.ts");

  // Build the MCP server entry
  const env: Record<string, string> = {
    SESSIONGRAPH_STORAGE_MODE: storageChoice.mode,
  };
  if (storageChoice.mode === "cloud" && storageChoice.supabaseUrl) {
    env.SESSIONGRAPH_SUPABASE_URL = storageChoice.supabaseUrl;
    env.SESSIONGRAPH_SUPABASE_ANON_KEY = storageChoice.supabaseAnonKey ?? "";
  }

  const mcpEntry = {
    command: "bun",
    args: ["run", serverScript],
    env,
  };

  try {
    // Read existing config or create skeleton
    let openCodeConfig: Record<string, unknown> = {};

    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, "utf-8");
        openCodeConfig = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        process.stdout.write(
          `${yellow("!")} Existing opencode.json is malformed — creating a new one.\n`
        );
      }
    }

    // Ensure mcpServers key exists
    if (!openCodeConfig.mcpServers || typeof openCodeConfig.mcpServers !== "object") {
      openCodeConfig.mcpServers = {};
    }

    const mcpServers = openCodeConfig.mcpServers as Record<string, unknown>;

    // Check if already configured
    if (mcpServers.sessiongraph) {
      const overwrite = await confirm(
        `${yellow("!")} SessionGraph MCP server is already configured. Overwrite?`
      );
      if (!overwrite) {
        process.stdout.write(`${dim("Keeping existing MCP config.")}\n`);
        return;
      }
    }

    // Install
    mcpServers.sessiongraph = mcpEntry;
    openCodeConfig.mcpServers = mcpServers;

    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    writeFileSync(configPath, JSON.stringify(openCodeConfig, null, 2) + "\n", "utf-8");

    process.stdout.write(
      `${green("✓")} MCP server configured in:\n` +
      `  ${dim(configPath)}\n\n` +
      `${dim("Server script:")} ${serverScript}\n` +
      `${dim("Storage mode:")}  ${storageChoice.mode}\n`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      `${red("✗")} Failed to configure MCP server: ${message}\n` +
      `\n${dim("You can manually add this to")} ${configPath}${dim(":")}\n\n` +
      `${dim(JSON.stringify({ mcpServers: { sessiongraph: mcpEntry } }, null, 2))}\n`
    );
  }
}

// ---------------------------------------------------------------------------
// Step 7: Install auto-reasoning-capture skill
// ---------------------------------------------------------------------------

async function stepInstallSkill(): Promise<void> {
  printSeparator();
  process.stdout.write(`${bold("Auto-Reasoning Capture Skill")}\n\n`);

  const projectRoot = getProjectRoot();
  const srcSkill = join(projectRoot, "skills", "auto-reasoning-capture", "SKILL.md");
  const destDir = join(getOpenCodeSkillsDir(), "auto-reasoning-capture");
  const destFile = join(destDir, "SKILL.md");

  try {
    if (!existsSync(srcSkill)) {
      process.stdout.write(
        `${yellow("!")} Skill source not found at:\n` +
        `  ${dim(srcSkill)}\n` +
        `${dim("Skipping skill installation.")}\n`
      );
      return;
    }

    // Check if already installed
    if (existsSync(destFile)) {
      const overwrite = await confirm(
        `${yellow("!")} auto-reasoning-capture skill already installed. Overwrite?`
      );
      if (!overwrite) {
        process.stdout.write(`${dim("Keeping existing skill.")}\n`);
        return;
      }
    }

    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    copyFileSync(srcSkill, destFile);

    process.stdout.write(
      `${green("✓")} Auto-reasoning-capture skill installed to:\n` +
      `  ${dim(destFile)}\n\n` +
      `This skill makes your AI agent automatically capture reasoning\n` +
      `chains (decisions, insights, solutions) as you work.\n`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      `${red("✗")} Failed to install skill: ${message}\n`
    );
  }
}

// ---------------------------------------------------------------------------
// Step 8: Done
// ---------------------------------------------------------------------------

function stepDone(storageChoice: StorageChoice): void {
  printSeparator();
  printBox([
    `${green("✓")} ${bold("SessionGraph is ready!")}`,
    ``,
    `${dim("Storage:")}  ${storageChoice.mode === "local" ? "PGlite (local)" : "Supabase (cloud)"}`,
    `${dim("MCP:")}      sessiongraph server configured`,
    `${dim("Skill:")}    auto-reasoning-capture installed`,
  ]);

  process.stdout.write(
    `\n${bold("What happens next:")}\n\n` +
    `  1. Start a new AI coding session\n` +
    `  2. The agent will automatically capture reasoning chains\n` +
    `  3. Use ${cyan("sessiongraph recall <query>")} to search your history\n` +
    `  4. Use ${cyan("sessiongraph timeline")} to review recent sessions\n\n` +
    `${dim("For more info:")} ${cyan("https://github.com/anomalyco/sessiongraph")}\n\n`
  );
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runInit(): Promise<void> {
  try {
    // Step 1 & 2: Detect environment
    const detection = await stepDetectEnvironment();

    // Step 3: Storage choice
    const storageChoice = await stepStorageChoice();

    // Step 4: Ollama check (local mode)
    if (!stepOllamaCheck(detection.ollama, storageChoice.mode)) {
      // Ollama not ready — exit early so user can fix it
      return;
    }

    // Step 5: Backfill
    try {
      await stepBackfill(detection, storageChoice);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(
        `\n${yellow("!")} Backfill step encountered an error: ${message}\n` +
        `${dim("Continuing with remaining setup...")}\n`
      );
    }

    // Step 6: MCP config
    try {
      await stepInstallMcp(storageChoice);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(
        `\n${yellow("!")} MCP config step encountered an error: ${message}\n` +
        `${dim("Continuing with remaining setup...")}\n`
      );
    }

    // Step 7: Auto-reasoning skill
    try {
      await stepInstallSkill();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(
        `\n${yellow("!")} Skill installation step encountered an error: ${message}\n` +
        `${dim("Continuing...")}\n`
      );
    }

    // Step 8: Done!
    stepDone(storageChoice);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      `\n${red("✗")} Init wizard failed: ${message}\n\n` +
      `${dim("If this is a bug, please report it at:")}\n` +
      `${cyan("https://github.com/anomalyco/sessiongraph/issues")}\n\n`
    );
    process.exitCode = 1;
  }
}
