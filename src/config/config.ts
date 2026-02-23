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

/**
 * Build a fresh config object from current environment variables.
 * Extracted as a factory so tests can call it after modifying env vars.
 *
 * Validates that cloud mode has required Supabase credentials (I7).
 */
export function createConfig() {
  // Paths
  const DATA_DIR = join(homedir(), ".sessiongraph");
  const BUFFER_DB_PATH = join(DATA_DIR, "buffer.db");
  const CONFIG_PATH = join(DATA_DIR, "config.json");
  const AUTH_PATH = join(DATA_DIR, "auth.json");
  const PGLITE_DIR = join(DATA_DIR, "pglite");
  const PGLITE_BACKUP_PATH = join(DATA_DIR, "pglite-backup.tar.gz");
  const PGLITE_BACKUP_META_PATH = join(DATA_DIR, "pglite-backup.json");

  // OpenCode paths
  const OPENCODE_DATA_DIR = join(homedir(), ".local", "share", "opencode");
  const OPENCODE_DB_PATH = join(OPENCODE_DATA_DIR, "opencode.db");

  // Claude Code paths
  const CLAUDE_CODE_DIR = join(homedir(), ".claude");
  const CLAUDE_CODE_PROJECTS_DIR = join(CLAUDE_CODE_DIR, "projects");
  const CLAUDE_CODE_HISTORY = join(CLAUDE_CODE_DIR, "history.jsonl");

  const storageMode = resolveStorageMode();

  const supabaseUrl = process.env.SESSIONGRAPH_SUPABASE_URL ?? "";
  const supabaseAnonKey = process.env.SESSIONGRAPH_SUPABASE_ANON_KEY ?? "";

  // I7: Fail-fast if cloud mode is set but Supabase credentials are missing
  if (storageMode === "cloud") {
    if (!supabaseUrl) {
      throw new Error(
        "SESSIONGRAPH_SUPABASE_URL is required when SESSIONGRAPH_STORAGE_MODE=cloud. " +
        "Set the environment variable or switch to local mode."
      );
    }
    if (!supabaseAnonKey) {
      throw new Error(
        "SESSIONGRAPH_SUPABASE_ANON_KEY is required when SESSIONGRAPH_STORAGE_MODE=cloud. " +
        "Set the environment variable or switch to local mode."
      );
    }
  }

  return {
    storage: {
      mode: storageMode,
    },
    paths: {
      dataDir: DATA_DIR,
      bufferDb: BUFFER_DB_PATH,
      config: CONFIG_PATH,
      auth: AUTH_PATH,
      pgliteDir: PGLITE_DIR,
      pgliteBackup: PGLITE_BACKUP_PATH,
      pgliteBackupMeta: PGLITE_BACKUP_META_PATH,
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
      url: supabaseUrl,
      anonKey: supabaseAnonKey,
    },
    sync: {
      intervalMs: 30_000, // sync every 30 seconds
      batchSize: 50,
    },
    ollama: {
      baseUrl: process.env.SESSIONGRAPH_OLLAMA_URL ?? "http://localhost:11434",
      embeddingModel: process.env.SESSIONGRAPH_OLLAMA_EMBEDDING_MODEL ?? "qwen3-embedding:0.6b",
      chatModel: process.env.SESSIONGRAPH_OLLAMA_CHAT_MODEL ?? "qwen2.5:3b",
    },
  } as const;
}

/** Singleton config instance, lazily created on first access. */
let _config: ReturnType<typeof createConfig> | null = null;

/**
 * The application config. Lazily evaluated from environment variables
 * on first access. Use `createConfig()` directly in tests.
 */
export const config: ReturnType<typeof createConfig> = new Proxy({} as ReturnType<typeof createConfig>, {
  get(_target, prop, receiver) {
    if (!_config) {
      _config = createConfig();
    }
    return Reflect.get(_config, prop, receiver);
  },
});

export type Config = ReturnType<typeof createConfig>;

// Ensure data directory exists
export function ensureDataDir(): void {
  const dataDir = config.paths.dataDir;
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
}
