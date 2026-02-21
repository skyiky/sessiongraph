import type { ReasoningType } from "../config/types.ts";
import { config } from "../config/config.ts";

export interface ExtractedChain {
  type: ReasoningType;
  title: string;
  content: string;
  tags: string[];
}

const EXTRACTION_PROMPT = `You extract reasoning chains from AI coding sessions.

Return a JSON object: {"chains": [{"type": "...", "title": "...", "content": "...", "tags": ["..."]}]}

Valid types (use ONLY these exact strings):
- "decision": chose X over Y, with reasoning
- "exploration": comparing options, no conclusion yet
- "rejection": ruled out X because Y
- "solution": fixed a problem, with root cause and fix
- "insight": learned something new

Rules:
- Extract ONLY substantive reasoning. Skip routine actions.
- Each item must be self-contained.
- Content: 2-5 sentences with full context.
- If no reasoning found, return {"chains": []}.
- Return ONLY the JSON object. No other text.`;

/** Max chars to send to Ollama. qwen2.5:3b works well at 8K context — ~20K chars (~5K tokens) */
const MAX_CONVERSATION_LENGTH = 20_000;

/** Timeout for chat/extraction requests (5 minutes — some sessions need extended processing) */
const CHAT_TIMEOUT_MS = 300_000;

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
  /** Context window size in tokens (default: 8192) */
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
            content: `Extract reasoning chains:\n\n${truncatedText}`,
          },
        ],
        stream: false,
        format: "json",
        options: {
          ...(opts?.numThread != null && { num_thread: opts.numThread }),
          ...(opts?.numGpu != null && { num_gpu: opts.numGpu }),
          num_ctx: opts?.numCtx ?? 8192,
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

  // Strip <think>...</think> blocks that some models leak into content
  let cleaned = content.trim();
  const thinkEnd = cleaned.indexOf("</think>");
  if (thinkEnd !== -1) {
    cleaned = cleaned.slice(thinkEnd + 8).trim();
  }

  // Strip markdown code fences if present (common LLM behavior)
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

    // Map close-but-invalid types to valid ones
    const TYPE_ALIASES: Record<string, string> = {
      adjustment: "solution",
      fix: "solution",
      learning: "insight",
      discovery: "insight",
      observation: "insight",
      comparison: "exploration",
      tradeoff: "exploration",
      choice: "decision",
    };

    // Validate each chain
    return chains
      .filter(
        (c): c is Record<string, unknown> =>
          c != null &&
          typeof c === "object" &&
          typeof (c as Record<string, unknown>).type === "string" &&
          typeof (c as Record<string, unknown>).title === "string" &&
          typeof (c as Record<string, unknown>).content === "string",
      )
      .map((c) => {
        const rawType = (c.type as string).toLowerCase().trim();
        const resolvedType = VALID_TYPES.has(rawType) ? rawType : (TYPE_ALIASES[rawType] ?? null);
        return resolvedType
          ? {
              type: resolvedType as ReasoningType,
              title: (c.title as string).slice(0, 200),
              content: c.content as string,
              tags: Array.isArray(c.tags)
                ? (c.tags as unknown[]).filter((t): t is string => typeof t === "string")
                : [],
            }
          : null;
      })
      .filter((c): c is ExtractedChain => c !== null);
  } catch {
    console.error("[ollama-extractor] Failed to parse Ollama response as JSON:", cleaned.slice(0, 200));
    return [];
  }
}
