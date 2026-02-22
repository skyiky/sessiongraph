import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { OllamaEmbeddingProvider } from "./ollama.ts";

/**
 * Unit tests for OllamaEmbeddingProvider.
 *
 * All tests mock `globalThis.fetch` to avoid hitting a real Ollama server.
 * Tests cover input validation, response handling, error mapping, and timeout behavior.
 */

// Helpers
function embedResponse(embeddings: number[][]): Response {
  return new Response(JSON.stringify({ embeddings }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

// A 1024-dim fake vector (all zeros except first element)
function fakeVector(marker = 1.0): number[] {
  const v = new Array(1024).fill(0);
  v[0] = marker;
  return v;
}

const originalFetch = globalThis.fetch;

/** Assign a mock to globalThis.fetch. Cast handles Bun's extended fetch type (includes `preconnect`). */
const setFetch = (fn: (...args: any[]) => Promise<Response | never>): void => {
  globalThis.fetch = fn as typeof fetch;
};

/**
 * OllamaEmbeddingProvider reads from config.ollama.baseUrl and config.ollama.embeddingModel
 * via getters. We need those to resolve without hitting real env. Since the provider uses
 * the lazy config proxy, we set the env vars before creating the provider instance.
 */
let provider: OllamaEmbeddingProvider;

beforeEach(() => {
  // Ensure config resolves with test-friendly defaults
  process.env.SESSIONGRAPH_OLLAMA_URL = "http://localhost:11434";
  process.env.SESSIONGRAPH_OLLAMA_EMBEDDING_MODEL = "test-embed-model";
  provider = new OllamaEmbeddingProvider();
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OllamaEmbeddingProvider", () => {
  // ---- Basic properties ----

  test("dimensions is 1024", () => {
    expect(provider.dimensions).toBe(1024);
  });

  // ---- generateEmbedding (single) ----

  describe("generateEmbedding", () => {
    test("returns embedding vector from Ollama response", async () => {
      const vec = fakeVector(0.42);
      setFetch(async () => embedResponse([vec]));
      const result = await provider.generateEmbedding("test text");
      expect(result).toEqual(vec);
      expect(result).toHaveLength(1024);
    });

    test("rejects empty string", async () => {
      await expect(provider.generateEmbedding("")).rejects.toThrow(
        /empty or whitespace-only/,
      );
    });

    test("rejects whitespace-only string", async () => {
      await expect(provider.generateEmbedding("   \n\t  ")).rejects.toThrow(
        /empty or whitespace-only/,
      );
    });

    test("throws when Ollama returns empty embeddings array", async () => {
      setFetch(async () => embedResponse([]));
      await expect(provider.generateEmbedding("test")).rejects.toThrow(
        /empty embeddings array/,
      );
    });
  });

  // ---- generateEmbeddings (batch) ----

  describe("generateEmbeddings", () => {
    test("returns empty array for empty input", async () => {
      const result = await provider.generateEmbeddings([]);
      expect(result).toEqual([]);
    });

    test("returns multiple embedding vectors", async () => {
      const vecs = [fakeVector(1.0), fakeVector(2.0), fakeVector(3.0)];
      setFetch(async () => embedResponse(vecs));
      const result = await provider.generateEmbeddings(["a", "b", "c"]);
      expect(result).toHaveLength(3);
      expect(result[0]![0]).toBe(1.0);
      expect(result[2]![0]).toBe(3.0);
    });

    test("validates no empty texts in batch (first empty)", async () => {
      await expect(
        provider.generateEmbeddings(["valid", "", "also valid"]),
      ).rejects.toThrow(/empty text at index 1/);
    });

    test("validates no whitespace-only texts in batch", async () => {
      await expect(
        provider.generateEmbeddings(["valid", "  \n  "]),
      ).rejects.toThrow(/empty text at index 1/);
    });

    test("throws on count mismatch between inputs and outputs", async () => {
      // Send 3 texts but only get 2 embeddings back
      setFetch(async () => embedResponse([fakeVector(), fakeVector()]));
      await expect(
        provider.generateEmbeddings(["a", "b", "c"]),
      ).rejects.toThrow(/2 embeddings for 3 inputs/);
    });

    test("sends all texts in a single request (batch API)", async () => {
      let capturedBody: Record<string, unknown> = {};
      setFetch(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return embedResponse([fakeVector(), fakeVector()]);
      });
      await provider.generateEmbeddings(["text1", "text2"]);
      // Should send array input, not individual requests
      expect(capturedBody.input).toEqual(["text1", "text2"]);
      expect(capturedBody.model).toBe("test-embed-model");
    });
  });

  // ---- Error handling ----

  describe("error handling", () => {
    test("throws timeout error with clear message", async () => {
      setFetch(async () => {
        throw new DOMException("The operation was aborted", "TimeoutError");
      });
      await expect(provider.generateEmbedding("test")).rejects.toThrow(
        /timed out after 30s/,
      );
    });

    test("throws 'not running' on network failure", async () => {
      setFetch(async () => {
        throw new Error("ECONNREFUSED");
      });
      await expect(provider.generateEmbedding("test")).rejects.toThrow(
        /Ollama is not running/,
      );
    });

    test("throws 'model not found' on 404 response", async () => {
      setFetch(async () => errorResponse("model not found", 404));
      await expect(provider.generateEmbedding("test")).rejects.toThrow(
        /not found.*Pull it/,
      );
    });

    test("throws generic API error on 500", async () => {
      setFetch(async () =>
        errorResponse("internal server error", 500));
      await expect(provider.generateEmbedding("test")).rejects.toThrow(
        /Ollama API error \(500\)/,
      );
    });

    test("batch timeout scales with input count (capped at 10x)", async () => {
      // With 5 items, timeout should be 5 * 30s = 150s
      // With 15 items, timeout should be capped at 10 * 30s = 300s
      // We verify by checking the error message includes the scaled timeout
      setFetch(async () => {
        throw new DOMException("The operation was aborted", "TimeoutError");
      });
      // 5 items → 150s
      await expect(
        provider.generateEmbeddings(["a", "b", "c", "d", "e"]),
      ).rejects.toThrow(/timed out after 150s/);
    });

    test("batch timeout caps at 10x base for large batches", async () => {
      setFetch(async () => {
        throw new DOMException("The operation was aborted", "TimeoutError");
      });
      // 20 items → should cap at 10 * 30s = 300s
      const texts = Array.from({ length: 20 }, (_, i) => `text-${i}`);
      await expect(provider.generateEmbeddings(texts)).rejects.toThrow(
        /timed out after 300s/,
      );
    });
  });
});
