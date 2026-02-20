import { homedir } from "os";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";

// Paths
const DATA_DIR = join(homedir(), ".sessiongraph");
const BUFFER_DB_PATH = join(DATA_DIR, "buffer.db");
const CONFIG_PATH = join(DATA_DIR, "config.json");
const AUTH_PATH = join(DATA_DIR, "auth.json");

// OpenCode paths
const OPENCODE_DATA_DIR = join(homedir(), ".local", "share", "opencode");
const OPENCODE_DB_PATH = join(OPENCODE_DATA_DIR, "opencode.db");

export const config = {
  paths: {
    dataDir: DATA_DIR,
    bufferDb: BUFFER_DB_PATH,
    config: CONFIG_PATH,
    auth: AUTH_PATH,
  },
  opencode: {
    dataDir: OPENCODE_DATA_DIR,
    dbPath: OPENCODE_DB_PATH,
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
