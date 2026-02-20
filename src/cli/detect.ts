/**
 * detect.ts — Environment detection for the SessionGraph init wizard.
 *
 * Scans the local machine for:
 *   1. Supported AI coding tools (OpenCode, Claude Code) and their session counts.
 *   2. A running Ollama instance and whether the required models are pulled.
 *
 * This module is consumed by the interactive setup wizard so it can present
 * sensible defaults and skip irrelevant configuration steps.
 */

import { config } from "../config/config.ts";
import {
  isOpenCodeAvailable,
  getNewSessions as getOpenCodeSessions,
} from "../ingestion/parsers/opencode.ts";
import {
  isClaudeCodeAvailable,
  getNewSessions as getClaudeCodeSessions,
} from "../ingestion/parsers/claude-code.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DetectedTool {
  /** Tool identifier. */
  name: "opencode" | "claude-code";
  /** Whether the tool's data directory / database was found on disk. */
  available: boolean;
  /** Number of sessions discovered (0 when unavailable). */
  sessionCount: number;
  /** Filesystem path to the tool's data. */
  path: string;
}

export interface OllamaStatus {
  /** Whether the Ollama HTTP server responded successfully. */
  running: boolean;
  /** True when the configured embedding model (e.g. `all-minilm`) is pulled. */
  embeddingModelReady: boolean;
  /** True when the configured chat model (e.g. `llama3.1:8b`) is pulled. */
  chatModelReady: boolean;
  /** Full list of model names reported by Ollama. */
  availableModels: string[];
  /** Base URL used for the check (from config / env). */
  baseUrl: string;
}

export interface DetectionResult {
  tools: DetectedTool[];
  ollama: OllamaStatus;
  /** Convenience flag — true when at least one tool has sessions > 0. */
  hasAnySessions: boolean;
}

// ---------------------------------------------------------------------------
// Tool detection
// ---------------------------------------------------------------------------

/** Detect whether OpenCode is installed and count its sessions. */
function detectOpenCode(): DetectedTool {
  const available = isOpenCodeAvailable();
  let sessionCount = 0;

  if (available) {
    try {
      const sessions = getOpenCodeSessions();
      sessionCount = sessions.length;
    } catch {
      // DB might be locked or corrupt — treat as 0 sessions.
    }
  }

  return {
    name: "opencode",
    available,
    sessionCount,
    path: config.opencode.dbPath,
  };
}

/** Detect whether Claude Code is installed and count its sessions. */
function detectClaudeCode(): DetectedTool {
  const available = isClaudeCodeAvailable();
  let sessionCount = 0;

  if (available) {
    try {
      const sessions = getClaudeCodeSessions();
      sessionCount = sessions.length;
    } catch {
      // History file might be missing or unreadable — treat as 0 sessions.
    }
  }

  return {
    name: "claude-code",
    available,
    sessionCount,
    path: config.claudeCode.projectsDir,
  };
}

// ---------------------------------------------------------------------------
// Ollama detection
// ---------------------------------------------------------------------------

/** Model name returned by the Ollama `/api/tags` endpoint. */
interface OllamaModelEntry {
  name: string;
  [key: string]: unknown;
}

/**
 * Check whether a model name from Ollama matches the configured model.
 *
 * Ollama tags are formatted as `model:tag` (e.g. `all-minilm:latest`).
 * We match on the base name so that `all-minilm:latest` satisfies a check
 * for `all-minilm`, and `llama3.1:8b` matches exactly.
 */
function modelMatches(ollamaName: string, wanted: string): boolean {
  // Exact match (includes tag).
  if (ollamaName === wanted) return true;
  // Match base name when the Ollama entry has a `:tag` suffix.
  const baseName = ollamaName.split(":")[0];
  return baseName === wanted || baseName === wanted.split(":")[0];
}

/** Probe the local Ollama server for status and available models. */
async function detectOllama(): Promise<OllamaStatus> {
  const baseUrl = config.ollama.baseUrl;
  const embeddingModel = config.ollama.embeddingModel;
  const chatModel = config.ollama.chatModel;

  const notRunning: OllamaStatus = {
    running: false,
    embeddingModelReady: false,
    chatModelReady: false,
    availableModels: [],
    baseUrl,
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return notRunning;

    const data = (await response.json()) as { models?: OllamaModelEntry[] };
    const models = data.models ?? [];
    const modelNames = models.map((m) => m.name);

    return {
      running: true,
      embeddingModelReady: modelNames.some((n) => modelMatches(n, embeddingModel)),
      chatModelReady: modelNames.some((n) => modelMatches(n, chatModel)),
      availableModels: modelNames,
      baseUrl,
    };
  } catch {
    // Network error, timeout, or Ollama not installed — all treated the same.
    return notRunning;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run all environment checks and return a unified result.
 *
 * This is intentionally fast (2-second timeout on network, synchronous FS
 * checks) so it can be called at the start of the init wizard without a
 * noticeable delay.
 */
export async function detectEnvironment(): Promise<DetectionResult> {
  // Tool detection is synchronous (filesystem only) — run first.
  const tools: DetectedTool[] = [detectOpenCode(), detectClaudeCode()];

  // Ollama detection hits the network — run concurrently with nothing else.
  const ollama = await detectOllama();

  const hasAnySessions = tools.some((t) => t.sessionCount > 0);

  return { tools, ollama, hasAnySessions };
}
