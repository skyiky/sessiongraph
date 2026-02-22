import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { extractWithOllama, type ExtractedChain } from "./ollama-extractor.ts";
import type { ReasoningType } from "../config/types.ts";

/**
 * Unit tests for the Ollama extraction pipeline.
 *
 * All tests mock `globalThis.fetch` to avoid hitting a real Ollama server.
 * Focuses on the response parsing, cleaning, validation, and error handling
 * that was rewritten for the qwen2.5:3b model.
 */

// Helper: build a fake Ollama chat response
function ollamaResponse(content: string, status = 200): Response {
  return new Response(JSON.stringify({ message: { content } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ollamaErrorResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

// Save and restore fetch
const originalFetch = globalThis.fetch;

/** Assign a mock to globalThis.fetch. Cast handles Bun's extended fetch type (includes `preconnect`). */
const setFetch = (fn: (...args: any[]) => Promise<Response | never>): void => {
  globalThis.fetch = fn as typeof fetch;
};

// Fixed options to avoid importing config (which reads env vars)
const opts = {
  model: "test-model",
  baseUrl: "http://localhost:11434",
  numCtx: 4096,
};

beforeEach(() => {
  // Reset fetch before each test
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---- Response parsing ----

describe("extractWithOllama", () => {
  describe("response parsing", () => {
    test("returns empty array when content is null/empty", async () => {
      setFetch(async () =>
        new Response(JSON.stringify({ message: { content: "" } }), { status: 200 }));
      const result = await extractWithOllama("some conversation", opts);
      expect(result).toEqual([]);
    });

    test("returns empty array when message is missing", async () => {
      setFetch(async () =>
        new Response(JSON.stringify({}), { status: 200 }));
      const result = await extractWithOllama("some conversation", opts);
      expect(result).toEqual([]);
    });

    test("parses {chains: [...]} wrapper format", async () => {
      const payload = {
        chains: [
          { type: "decision", title: "Chose X", content: "Picked X over Y because Z.", tags: ["arch"] },
        ],
      };
      setFetch(async () => ollamaResponse(JSON.stringify(payload)));
      const result = await extractWithOllama("conversation text", opts);
      expect(result).toHaveLength(1);
      expect(result[0]!.type).toBe("decision");
      expect(result[0]!.title).toBe("Chose X");
      expect(result[0]!.content).toBe("Picked X over Y because Z.");
      expect(result[0]!.tags).toEqual(["arch"]);
    });

    test("parses direct array format", async () => {
      const payload = [
        { type: "insight", title: "Learned something", content: "Important discovery.", tags: [] },
      ];
      setFetch(async () => ollamaResponse(JSON.stringify(payload)));
      const result = await extractWithOllama("conversation text", opts);
      expect(result).toHaveLength(1);
      expect(result[0]!.type).toBe("insight");
    });

    test("accepts alternate wrapper keys: reasoning_chains, items, results", async () => {
      for (const key of ["reasoning_chains", "reasoningChains", "items", "results"]) {
        const payload = { [key]: [{ type: "solution", title: "Fixed it", content: "Root cause was X.", tags: [] }] };
        setFetch(async () => ollamaResponse(JSON.stringify(payload)));
        const result = await extractWithOllama("conversation text", opts);
        expect(result).toHaveLength(1);
        expect(result[0]!.type).toBe("solution");
      }
    });

    test("returns empty for non-object/non-array parsed JSON (e.g. string)", async () => {
      setFetch(async () => ollamaResponse(JSON.stringify("just a string")));
      const result = await extractWithOllama("conversation text", opts);
      expect(result).toEqual([]);
    });

    test("returns empty for object with no recognized wrapper key", async () => {
      const payload = { unknown_key: [{ type: "insight", title: "T", content: "C", tags: [] }] };
      setFetch(async () => ollamaResponse(JSON.stringify(payload)));
      const result = await extractWithOllama("conversation text", opts);
      expect(result).toEqual([]);
    });
  });

  // ---- Content cleaning ----

  describe("content cleaning", () => {
    test("strips <think>...</think> blocks from response", async () => {
      const thinkBlock = "<think>Some internal reasoning here</think>";
      const payload = JSON.stringify({
        chains: [{ type: "insight", title: "T", content: "C", tags: [] }],
      });
      setFetch(async () => ollamaResponse(thinkBlock + payload));
      const result = await extractWithOllama("conversation text", opts);
      expect(result).toHaveLength(1);
      expect(result[0]!.type).toBe("insight");
    });

    test("strips ```json fences from response", async () => {
      const payload = JSON.stringify({
        chains: [{ type: "decision", title: "T", content: "C", tags: [] }],
      });
      setFetch(async () => ollamaResponse("```json\n" + payload + "\n```"));
      const result = await extractWithOllama("conversation text", opts);
      expect(result).toHaveLength(1);
    });

    test("strips bare ``` fences from response", async () => {
      const payload = JSON.stringify({
        chains: [{ type: "decision", title: "T", content: "C", tags: [] }],
      });
      setFetch(async () => ollamaResponse("```\n" + payload + "\n```"));
      const result = await extractWithOllama("conversation text", opts);
      expect(result).toHaveLength(1);
    });

    test("handles combined think block + markdown fences", async () => {
      const thinkBlock = "<think>reasoning</think>";
      const payload = JSON.stringify({
        chains: [{ type: "solution", title: "T", content: "C", tags: [] }],
      });
      setFetch(async () =>
        ollamaResponse(thinkBlock + "```json\n" + payload + "\n```"));
      const result = await extractWithOllama("conversation text", opts);
      expect(result).toHaveLength(1);
      expect(result[0]!.type).toBe("solution");
    });
  });

  // ---- Validation ----

  describe("chain validation", () => {
    test("filters out chains missing required fields", async () => {
      const payload = {
        chains: [
          { type: "decision", title: "Valid", content: "Has all fields", tags: [] },
          { type: "decision", title: "No content" }, // missing content
          { type: "decision", content: "No title", tags: [] }, // missing title
          { title: "No type", content: "Missing type", tags: [] }, // missing type
          null, // null entry
          "string entry", // not an object
        ],
      };
      setFetch(async () => ollamaResponse(JSON.stringify(payload)));
      const result = await extractWithOllama("conversation text", opts);
      expect(result).toHaveLength(1);
      expect(result[0]!.title).toBe("Valid");
    });

    test("truncates title to 200 characters", async () => {
      const longTitle = "A".repeat(300);
      const payload = {
        chains: [{ type: "insight", title: longTitle, content: "Content", tags: [] }],
      };
      setFetch(async () => ollamaResponse(JSON.stringify(payload)));
      const result = await extractWithOllama("conversation text", opts);
      expect(result[0]!.title).toHaveLength(200);
    });

    test("handles non-string tags gracefully (filters to strings only)", async () => {
      const payload = {
        chains: [
          { type: "insight", title: "T", content: "C", tags: ["valid", 123, null, true, "also-valid"] },
        ],
      };
      setFetch(async () => ollamaResponse(JSON.stringify(payload)));
      const result = await extractWithOllama("conversation text", opts);
      expect(result[0]!.tags).toEqual(["valid", "also-valid"]);
    });

    test("returns empty tags array when tags field is not an array", async () => {
      const payload = {
        chains: [{ type: "insight", title: "T", content: "C", tags: "not-an-array" }],
      };
      setFetch(async () => ollamaResponse(JSON.stringify(payload)));
      const result = await extractWithOllama("conversation text", opts);
      expect(result[0]!.tags).toEqual([]);
    });
  });

  // ---- Type aliases ----

  describe("type alias mapping", () => {
    const aliases: [string, ReasoningType][] = [
      ["fix", "solution"],
      ["adjustment", "solution"],
      ["learning", "insight"],
      ["discovery", "insight"],
      ["observation", "insight"],
      ["comparison", "exploration"],
      ["tradeoff", "exploration"],
      ["choice", "decision"],
    ];

    for (const [alias, expected] of aliases) {
      test(`maps "${alias}" → "${expected}"`, async () => {
        const payload = {
          chains: [{ type: alias, title: "T", content: "C", tags: [] }],
        };
        setFetch(async () => ollamaResponse(JSON.stringify(payload)));
        const result = await extractWithOllama("conversation text", opts);
        expect(result).toHaveLength(1);
        expect(result[0]!.type).toBe(expected);
      });
    }

    test("case-insensitive type matching", async () => {
      const payload = {
        chains: [{ type: "DECISION", title: "T", content: "C", tags: [] }],
      };
      setFetch(async () => ollamaResponse(JSON.stringify(payload)));
      const result = await extractWithOllama("conversation text", opts);
      expect(result[0]!.type).toBe("decision");
    });

    test("rejects unknown types not in VALID_TYPES or TYPE_ALIASES", async () => {
      const payload = {
        chains: [
          { type: "banana", title: "T", content: "C", tags: [] },
          { type: "insight", title: "Valid", content: "C", tags: [] },
        ],
      };
      setFetch(async () => ollamaResponse(JSON.stringify(payload)));
      const result = await extractWithOllama("conversation text", opts);
      expect(result).toHaveLength(1);
      expect(result[0]!.title).toBe("Valid");
    });
  });

  // ---- Input handling ----

  describe("input handling", () => {
    test("truncates conversation text > 20K chars", async () => {
      const longText = "X".repeat(25_000);
      let capturedBody = "";
      setFetch(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return ollamaResponse(JSON.stringify({ chains: [] }));
      });
      await extractWithOllama(longText, opts);
      const parsed = JSON.parse(capturedBody);
      const userContent = parsed.messages[1].content as string;
      // Should be truncated: "Extract reasoning chains:\n\n" prefix + 20000 chars + "[CONVERSATION TRUNCATED]"
      expect(userContent).toContain("[CONVERSATION TRUNCATED]");
      // The raw conversation portion should be <= 20000 + truncation marker
      expect(userContent.length).toBeLessThan(25_100); // well under 25K
    });

    test("does not truncate text under 20K chars", async () => {
      const shortText = "X".repeat(1000);
      let capturedBody = "";
      setFetch(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return ollamaResponse(JSON.stringify({ chains: [] }));
      });
      await extractWithOllama(shortText, opts);
      const parsed = JSON.parse(capturedBody);
      const userContent = parsed.messages[1].content as string;
      expect(userContent).not.toContain("[CONVERSATION TRUNCATED]");
    });

    test("sends correct Ollama request structure", async () => {
      let capturedBody: Record<string, unknown> = {};
      setFetch(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return ollamaResponse(JSON.stringify({ chains: [] }));
      });
      await extractWithOllama("test", opts);
      expect(capturedBody.model).toBe("test-model");
      expect(capturedBody.stream).toBe(false);
      expect(capturedBody.format).toBe("json");
      expect((capturedBody.options as Record<string, unknown>).num_ctx).toBe(4096);
    });
  });

  // ---- Error handling ----

  describe("error handling", () => {
    test("throws timeout error with clear message", async () => {
      setFetch(async () => {
        const err = new DOMException("The operation was aborted", "TimeoutError");
        throw err;
      });
      await expect(extractWithOllama("text", opts)).rejects.toThrow(/timed out after 300s/);
    });

    test("throws 'not running' error on network failure", async () => {
      setFetch(async () => {
        throw new Error("ECONNREFUSED");
      });
      await expect(extractWithOllama("text", opts)).rejects.toThrow(/Ollama is not running/);
      await expect(extractWithOllama("text", opts)).rejects.toThrow(/ECONNREFUSED/);
    });

    test("throws 'model not found' on 404", async () => {
      setFetch(async () => ollamaErrorResponse("model not found", 404));
      await expect(extractWithOllama("text", opts)).rejects.toThrow(/not found.*Pull it/);
    });

    test("throws generic API error on other HTTP errors", async () => {
      setFetch(async () => ollamaErrorResponse("internal server error", 500));
      await expect(extractWithOllama("text", opts)).rejects.toThrow(/Ollama API error \(500\)/);
    });

    test("returns empty array on malformed JSON response", async () => {
      setFetch(async () => ollamaResponse("this is not json {{{"));
      const result = await extractWithOllama("text", opts);
      expect(result).toEqual([]);
    });
  });
});
