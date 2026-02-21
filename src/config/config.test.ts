import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createConfig } from "./config.ts";
import { homedir } from "os";
import { join } from "path";

/**
 * Unit tests for createConfig() factory.
 *
 * Tests env var resolution, storage mode detection, cloud-mode validation,
 * default values, and path construction.
 *
 * Each test manipulates process.env directly and restores original values
 * after to avoid cross-test contamination.
 */

// Env vars that createConfig() reads
const ENV_KEYS = [
  "SESSIONGRAPH_STORAGE_MODE",
  "SESSIONGRAPH_SUPABASE_URL",
  "SESSIONGRAPH_SUPABASE_ANON_KEY",
  "SESSIONGRAPH_OLLAMA_URL",
  "SESSIONGRAPH_OLLAMA_EMBEDDING_MODEL",
  "SESSIONGRAPH_OLLAMA_CHAT_MODEL",
] as const;

type EnvSnapshot = Record<string, string | undefined>;

let savedEnv: EnvSnapshot;

beforeEach(() => {
  // Snapshot all relevant env vars
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  // Clear them all so each test starts clean
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  // Restore original env
  for (const key of ENV_KEYS) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
});

describe("createConfig", () => {
  // ---- Storage mode ----

  describe("storage mode", () => {
    test("defaults to 'local' when no env var set", () => {
      const cfg = createConfig();
      expect(cfg.storage.mode).toBe("local");
    });

    test("returns 'local' when SESSIONGRAPH_STORAGE_MODE=local", () => {
      process.env.SESSIONGRAPH_STORAGE_MODE = "local";
      const cfg = createConfig();
      expect(cfg.storage.mode).toBe("local");
    });

    test("returns 'cloud' when SESSIONGRAPH_STORAGE_MODE=cloud", () => {
      process.env.SESSIONGRAPH_STORAGE_MODE = "cloud";
      process.env.SESSIONGRAPH_SUPABASE_URL = "https://example.supabase.co";
      process.env.SESSIONGRAPH_SUPABASE_ANON_KEY = "some-key";
      const cfg = createConfig();
      expect(cfg.storage.mode).toBe("cloud");
    });

    test("defaults to 'local' for unknown storage mode value", () => {
      process.env.SESSIONGRAPH_STORAGE_MODE = "something-invalid";
      const cfg = createConfig();
      expect(cfg.storage.mode).toBe("local");
    });
  });

  // ---- Cloud mode validation (I7) ----

  describe("cloud mode validation", () => {
    test("throws when cloud mode set without SUPABASE_URL", () => {
      process.env.SESSIONGRAPH_STORAGE_MODE = "cloud";
      process.env.SESSIONGRAPH_SUPABASE_ANON_KEY = "some-key";
      // No URL
      expect(() => createConfig()).toThrow(/SESSIONGRAPH_SUPABASE_URL is required/);
    });

    test("throws when cloud mode set without SUPABASE_ANON_KEY", () => {
      process.env.SESSIONGRAPH_STORAGE_MODE = "cloud";
      process.env.SESSIONGRAPH_SUPABASE_URL = "https://example.supabase.co";
      // No anon key
      expect(() => createConfig()).toThrow(/SESSIONGRAPH_SUPABASE_ANON_KEY is required/);
    });

    test("throws when cloud mode set with neither Supabase var", () => {
      process.env.SESSIONGRAPH_STORAGE_MODE = "cloud";
      expect(() => createConfig()).toThrow(/SESSIONGRAPH_SUPABASE_URL is required/);
    });

    test("succeeds in cloud mode when both Supabase vars provided", () => {
      process.env.SESSIONGRAPH_STORAGE_MODE = "cloud";
      process.env.SESSIONGRAPH_SUPABASE_URL = "https://example.supabase.co";
      process.env.SESSIONGRAPH_SUPABASE_ANON_KEY = "some-key";
      const cfg = createConfig();
      expect(cfg.storage.mode).toBe("cloud");
      expect(cfg.supabase.url).toBe("https://example.supabase.co");
      expect(cfg.supabase.anonKey).toBe("some-key");
    });
  });

  // ---- Ollama config ----

  describe("ollama config", () => {
    test("uses default Ollama values when no env vars set", () => {
      const cfg = createConfig();
      expect(cfg.ollama.baseUrl).toBe("http://localhost:11434");
      expect(cfg.ollama.embeddingModel).toBe("qwen3-embedding:0.6b");
      expect(cfg.ollama.chatModel).toBe("qwen2.5:3b");
    });

    test("reads custom Ollama values from env vars", () => {
      process.env.SESSIONGRAPH_OLLAMA_URL = "http://remote:1234";
      process.env.SESSIONGRAPH_OLLAMA_EMBEDDING_MODEL = "custom-embed";
      process.env.SESSIONGRAPH_OLLAMA_CHAT_MODEL = "custom-chat";
      const cfg = createConfig();
      expect(cfg.ollama.baseUrl).toBe("http://remote:1234");
      expect(cfg.ollama.embeddingModel).toBe("custom-embed");
      expect(cfg.ollama.chatModel).toBe("custom-chat");
    });
  });

  // ---- Paths ----

  describe("paths", () => {
    test("data directory is under homedir/.sessiongraph", () => {
      const cfg = createConfig();
      expect(cfg.paths.dataDir).toBe(join(homedir(), ".sessiongraph"));
    });

    test("PGlite directory is under data directory", () => {
      const cfg = createConfig();
      expect(cfg.paths.pgliteDir).toBe(join(homedir(), ".sessiongraph", "pglite"));
    });

    test("buffer DB is under data directory", () => {
      const cfg = createConfig();
      expect(cfg.paths.bufferDb).toBe(join(homedir(), ".sessiongraph", "buffer.db"));
    });

    test("auth path is under data directory", () => {
      const cfg = createConfig();
      expect(cfg.paths.auth).toBe(join(homedir(), ".sessiongraph", "auth.json"));
    });
  });

  // ---- Tool paths ----

  describe("tool paths", () => {
    test("OpenCode DB path is correct", () => {
      const cfg = createConfig();
      expect(cfg.opencode.dbPath).toBe(
        join(homedir(), ".local", "share", "opencode", "opencode.db"),
      );
    });

    test("Claude Code paths are correct", () => {
      const cfg = createConfig();
      expect(cfg.claudeCode.baseDir).toBe(join(homedir(), ".claude"));
      expect(cfg.claudeCode.projectsDir).toBe(join(homedir(), ".claude", "projects"));
    });
  });

  // ---- Supabase defaults ----

  describe("supabase defaults", () => {
    test("Supabase URL and key default to empty strings in local mode", () => {
      const cfg = createConfig();
      expect(cfg.supabase.url).toBe("");
      expect(cfg.supabase.anonKey).toBe("");
    });
  });
});
