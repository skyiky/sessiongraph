import { homedir } from "os";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";

// Storage mode: "local" (PGlite) or "cloud" (Supabase)
// Defaults to "local" unless explicitly set to "cloud" or Supabase env vars are present
// with SESSIONGRAPH_STORAGE_MODE=cloud.
type StorageMode = "local" | "cloud";

function resolveStorageMode(): StorageMode {
  const explicit = process.env.SESSIONGRAPH_STORAGE_MODE;
  if (explicit === "cloud") return "cloud";
  if (explicit === "local") return "local";
  // Default: local (PGlite) — no account, no network required
  return "local";
}

// Paths
const DATA_DIR = join(homedir(), ".sessiongraph");
const BUFFER_DB_PATH = join(DATA_DIR, "buffer.db");
const CONFIG_PATH = join(DATA_DIR, "config.json");
const AUTH_PATH = join(DATA_DIR, "auth.json");
const PGLITE_DIR = join(DATA_DIR, "pglite");

// OpenCode paths
const OPENCODE_DATA_DIR = join(homedir(), ".local", "share", "opencode");
const OPENCODE_DB_PATH = join(OPENCODE_DATA_DIR, "opencode.db");

// Claude Code paths
const CLAUDE_CODE_DIR = join(homedir(), ".claude");
const CLAUDE_CODE_PROJECTS_DIR = join(CLAUDE_CODE_DIR, "projects");
const CLAUDE_CODE_HISTORY = join(CLAUDE_CODE_DIR, "history.jsonl");

export const config = {
  storage: {
    mode: resolveStorageMode(),
  },
  paths: {
    dataDir: DATA_DIR,
    bufferDb: BUFFER_DB_PATH,
    config: CONFIG_PATH,
    auth: AUTH_PATH,
    pgliteDir: PGLITE_DIR,
  },
  opencode: {
    dataDir: OPENCODE_DATA_DIR,
    dbPath: OPENCODE_DB_PATH,
  },
  claudeCode: {
    baseDir: CLAUDE_CODE_DIR,
    projectsDir: CLAUDE_CODE_PROJECTS_DIR,
    historyPath: CLAUDE_CODE_HISTORY,
  },
  supabase: {
    url: process.env.SESSIONGRAPH_SUPABASE_URL ?? "",
    anonKey: process.env.SESSIONGRAPH_SUPABASE_ANON_KEY ?? "",
  },
  sync: {
    intervalMs: 30_000, // sync every 30 seconds
    batchSize: 50,
  },
  embedding: {
    model: "gte-small",
    dimensions: 384,
  },
} as const;

export type Config = typeof config;

// Ensure data directory exists
export function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}
