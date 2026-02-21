import type { ReasoningType } from "../config/types.ts";
import { config } from "../config/config.ts";

export interface ExtractedChain {
  type: ReasoningType;
  title: string;
  content: string;
  tags: string[];
}

const EXTRACTION_PROMPT = `You are a reasoning chain extractor. Your job is to analyze AI coding session conversations and extract structured reasoning chains.

Extract the following types:
- **decision**: A choice was made between alternatives. Include what was chosen, why, and what alternatives existed.
- **exploration**: Multiple options are being weighed with no conclusion yet. Include options, tradeoffs, criteria.
- **rejection**: Something was explicitly ruled out with a reason. Include what was rejected and why.
- **solution**: A problem was identified and solved. Include the problem, root cause, fix, and why it works.
- **insight**: A standalone learning or discovery not tied to a decision or fix.

Rules:
- If an exploration leads to a decision, extract BOTH as separate items.
- If a rejection is part of reaching a decision, extract BOTH as separate items.
- A solution involving choice between fix approaches is a "solution", not "decision".
- If unsure between exploration and insight, default to "insight".
- Only extract substantive reasoning. Skip small talk, file reads, routine tool calls.
- Each extracted item should be self-contained — someone reading just that item should understand the reasoning without the original conversation.
- Be concise but complete. Include enough context to understand the reasoning without the original conversation.

Respond with a JSON array of objects with these fields:
- type: one of "decision", "exploration", "rejection", "solution", "insight"
- title: short summary (1 sentence, max 100 chars)
- content: the full reasoning (2-5 sentences)
- tags: array of relevant topic tags (e.g. "database", "architecture", "auth", "performance")

If the conversation contains no extractable reasoning chains, return an empty array [].

IMPORTANT: Return ONLY valid JSON. No markdown code fences, no explanation, just the JSON array.`;

/** Max chars to send to Ollama. qwen3:4b supports 256K context — we use ~80K chars (~20K tokens) */
const MAX_CONVERSATION_LENGTH = 80_000;

/** Timeout for chat/extraction requests (180 seconds — larger context needs more time) */
const CHAT_TIMEOUT_MS = 180_000;

const VALID_TYPES = new Set<string>(["decision", "exploration", "rejection", "solution", "insight"]);

/**
 * Extract reasoning chains from conversation text using Ollama's chat API.
 *
 * Calls the local Ollama server with the extraction prompt and parses
 * the structured JSON response into validated ExtractedChain objects.
 */
export interface OllamaOptions {
  model?: string;
  baseUrl?: string;
  /** Limit CPU threads used by Ollama (lower = less system impact) */
  numThread?: number;
  /** Number of GPU layers to offload (0 = CPU-only) */
  numGpu?: number;
  /** Context window size in tokens (default: 4096) */
  numCtx?: number;
}

export async function extractWithOllama(
  conversationText: string,
  opts?: OllamaOptions,
): Promise<ExtractedChain[]> {
  const model = opts?.model ?? config.ollama.chatModel;
  const baseUrl = opts?.baseUrl ?? config.ollama.baseUrl;

  // Truncate to stay safely within token limits
  const truncatedText =
    conversationText.length > MAX_CONVERSATION_LENGTH
      ? conversationText.slice(0, MAX_CONVERSATION_LENGTH) + "\n\n[CONVERSATION TRUNCATED]"
      : conversationText;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: EXTRACTION_PROMPT },
          {
            role: "user",
            content: `Extract reasoning chains from this AI coding session:\n\n${truncatedText}`,
          },
        ],
        stream: false,
        options: {
          ...(opts?.numThread != null && { num_thread: opts.numThread }),
          ...(opts?.numGpu != null && { num_gpu: opts.numGpu }),
          num_ctx: opts?.numCtx ?? 32768,
        },
      }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(
        `Ollama chat request timed out after ${CHAT_TIMEOUT_MS / 1000}s. ` +
        `The model may be too slow or the server unresponsive.`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Ollama is not running. Start it with 'ollama serve' or install from https://ollama.com (${message})`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 404 || body.toLowerCase().includes("not found")) {
      throw new Error(
        `Ollama model '${model}' not found. Pull it with 'ollama pull ${model}'`,
      );
    }
    throw new Error(`Ollama API error (${response.status}): ${body}`);
  }

  const result = (await response.json()) as { message?: { content?: string } };
  const content = result.message?.content;
  if (!content) return [];

  // Strip markdown code fences if present (common LLM behavior)
  let cleaned = content.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  try {
    const parsed: unknown = JSON.parse(cleaned);

    // Handle both direct array and { chains: [...] } wrapper formats
    let chains: unknown[];
    if (Array.isArray(parsed)) {
      chains = parsed;
    } else if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const wrapped =
        obj.chains ?? obj.reasoning_chains ?? obj.reasoningChains ?? obj.items ?? obj.results;
      chains = Array.isArray(wrapped) ? wrapped : [];
    } else {
      return [];
    }

    // Validate each chain
    return chains
      .filter(
        (c): c is Record<string, unknown> =>
          c != null &&
          typeof c === "object" &&
          typeof (c as Record<string, unknown>).type === "string" &&
          VALID_TYPES.has((c as Record<string, unknown>).type as string) &&
          typeof (c as Record<string, unknown>).title === "string" &&
          typeof (c as Record<string, unknown>).content === "string",
      )
      .map((c) => ({
        type: c.type as ReasoningType,
        title: (c.title as string).slice(0, 200),
        content: c.content as string,
        tags: Array.isArray(c.tags)
          ? (c.tags as unknown[]).filter((t): t is string => typeof t === "string")
          : [],
      }));
  } catch {
    console.error("[ollama-extractor] Failed to parse Ollama response as JSON:", cleaned.slice(0, 200));
    return [];
  }
}
