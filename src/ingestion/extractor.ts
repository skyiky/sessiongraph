import type { ReasoningType } from "../config/types.ts";

export interface ExtractedChain {
  type: ReasoningType;
  title: string;
  content: string;
  tags: string[];
}

// --- Rate limiting & retry configuration ---

/** Delay between LLM requests in ms (configurable via SESSIONGRAPH_LLM_DELAY_MS) */
const REQUEST_DELAY_MS = parseInt(process.env.SESSIONGRAPH_LLM_DELAY_MS ?? "3000", 10);

/** Maximum number of retries on 429/5xx errors */
const MAX_RETRIES = 5;

/** Initial backoff delay in ms (doubles each retry) */
const INITIAL_BACKOFF_MS = 3000;

/** Max chars to send to LLM (~5k tokens at ~4 chars/token, safe for 8k token limit) */
const MAX_CONVERSATION_LENGTH = 20_000;

/**
 * Timestamp of the last LLM request — used to enforce minimum delay
 * between requests to avoid triggering rate limits proactively.
 */
let lastRequestTime = 0;

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
- Each extracted item should be self-contained — someone reading just that item should understand the reasoning.
- Be concise but complete. Include enough context to understand the reasoning without the original conversation.

Respond with a JSON array of objects with these fields:
- type: one of "decision", "exploration", "rejection", "solution", "insight"
- title: short summary (1 sentence, max 100 chars)
- content: the full reasoning (2-5 sentences)
- tags: array of relevant topic tags (e.g. "database", "architecture", "auth", "performance")

If the conversation contains no extractable reasoning chains, return an empty array [].

IMPORTANT: Return ONLY valid JSON. No markdown code fences, no explanation, just the JSON array.`;

/** Sleep for a given number of milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Enforce a minimum delay between LLM API calls to avoid
 * triggering rate limits proactively.
 */
async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < REQUEST_DELAY_MS) {
    await sleep(REQUEST_DELAY_MS - elapsed);
  }
  lastRequestTime = Date.now();
}

/**
 * Make an LLM API call with retry + exponential backoff on 429 / 5xx errors.
 * Returns the Response on success, or null after all retries are exhausted.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
): Promise<Response | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await throttle();

    const response = await fetch(url, init);

    if (response.ok) {
      return response;
    }

    const status = response.status;
    const isRetryable = status === 429 || status >= 500;

    if (!isRetryable) {
      // Non-retryable error (400, 401, 413, etc.) — bail immediately
      const errorText = await response.text();
      console.error(`LLM API error (${status}): ${errorText}`);
      return null;
    }

    // Retryable error — backoff
    if (attempt < MAX_RETRIES) {
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      // Add 0-25% jitter to avoid thundering herd
      const jitter = Math.random() * 0.25 * backoff;
      const delay = Math.round(backoff + jitter);
      console.error(
        `LLM API ${status} (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${delay}ms...`
      );
      await sleep(delay);
    } else {
      const errorText = await response.text();
      console.error(
        `LLM API ${status} after ${MAX_RETRIES} retries, giving up: ${errorText}`
      );
    }
  }

  return null;
}

/**
 * Extract reasoning chains from conversation text using an LLM.
 * 
 * For v1, this calls an OpenAI-compatible API endpoint.
 * The endpoint can be configured via environment variables.
 * 
 * Includes:
 * - Proactive throttling (min delay between requests)
 * - Retry with exponential backoff on 429/5xx
 * - Conservative token truncation for 8k token models
 */
export async function extractReasoningChains(
  conversationText: string,
  opts?: {
    apiUrl?: string;
    apiKey?: string;
    model?: string;
  }
): Promise<ExtractedChain[]> {
  const apiUrl = opts?.apiUrl ?? process.env.SESSIONGRAPH_LLM_API_URL ?? "https://api.openai.com/v1/chat/completions";
  const apiKey = opts?.apiKey ?? process.env.SESSIONGRAPH_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  const model = opts?.model ?? process.env.SESSIONGRAPH_LLM_MODEL ?? "gpt-4o-mini";

  if (!apiKey) {
    console.error("No LLM API key configured. Set SESSIONGRAPH_LLM_API_KEY or OPENAI_API_KEY.");
    return [];
  }

  // Truncate to stay safely within token limits
  // 20k chars ≈ 5k tokens, leaves ~3k for system prompt + response in an 8k context
  const truncatedText = conversationText.length > MAX_CONVERSATION_LENGTH
    ? conversationText.slice(0, MAX_CONVERSATION_LENGTH) + "\n\n[CONVERSATION TRUNCATED]"
    : conversationText;

  try {
    const response = await fetchWithRetry(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: EXTRACTION_PROMPT },
          {
            role: "user",
            content: `Extract reasoning chains from this AI coding session:\n\n${truncatedText}`,
          },
        ],
        temperature: 0.1, // Low temperature for consistent extraction
        response_format: { type: "json_object" },
      }),
    });

    if (!response) {
      // All retries exhausted or non-retryable error
      return [];
    }

    const result = await response.json() as any;
    const content = result.choices?.[0]?.message?.content;
    if (!content) return [];

    // Parse the response
    const parsed = JSON.parse(content);
    
    // Handle both { chains: [...] } and direct array format
    const chains: any[] = Array.isArray(parsed)
      ? parsed
      : (parsed.chains ?? parsed.reasoning_chains ?? parsed.reasoningChains ?? parsed.items ?? parsed.results ?? []);

    // Validate and filter
    const validTypes = new Set(["decision", "exploration", "rejection", "solution", "insight"]);
    return chains
      .filter(
        (c: any) =>
          c &&
          typeof c.type === "string" &&
          validTypes.has(c.type) &&
          typeof c.title === "string" &&
          typeof c.content === "string"
      )
      .map((c: any) => ({
        type: c.type as ReasoningType,
        title: c.title.slice(0, 200),
        content: c.content,
        tags: Array.isArray(c.tags) ? c.tags.filter((t: any) => typeof t === "string") : [],
      }));
  } catch (err) {
    console.error("Failed to extract reasoning chains:", err);
    return [];
  }
}

/**
 * A simpler extraction that doesn't require an LLM.
 * Uses pattern matching to find obvious reasoning chains.
 * Falls back to this when no LLM API key is configured.
 */
export function extractReasoningChainsSimple(conversationText: string): ExtractedChain[] {
  const chains: ExtractedChain[] = [];
  const lines = conversationText.split("\n");

  // Simple heuristic patterns
  const decisionPatterns = [
    /(?:we(?:'ll| will|'re going to)?\s+(?:go with|use|choose|pick|select|stick with))\s+(.+)/i,
    /(?:let's\s+(?:go with|use|choose))\s+(.+)/i,
    /(?:decision|chose|decided):\s*(.+)/i,
  ];

  const rejectionPatterns = [
    /(?:won't work|ruled out|rejected|don't use|avoid|skip)\s+(.+?)(?:\s+because\s+(.+))?/i,
    /(?:(?:that|this|it)\s+(?:won't|doesn't|can't)\s+work)\s*(?:because\s+(.+))?/i,
  ];

  const insightPatterns = [
    /(?:TIL|learned|discovered|realized|turns out|interesting(?:ly)?)\s*[:—-]?\s*(.+)/i,
    /(?:key (?:insight|learning|takeaway)):\s*(.+)/i,
  ];

  const solutionPatterns = [
    /(?:(?:the\s+)?(?:fix|solution|answer)\s+(?:is|was))\s+(.+)/i,
    /(?:root cause|problem)\s+(?:is|was)\s+(.+)/i,
  ];

  // Scan through assistant text blocks
  let currentBlock = "";
  let inAssistant = false;

  for (const line of lines) {
    if (line.startsWith("--- ASSISTANT ---")) {
      inAssistant = true;
      currentBlock = "";
      continue;
    }
    if (line.startsWith("--- USER ---")) {
      // Process the completed assistant block
      if (inAssistant && currentBlock.trim()) {
        // Check patterns
        for (const pattern of decisionPatterns) {
          const match = currentBlock.match(pattern);
          if (match) {
            chains.push({
              type: "decision",
              title: match[1]?.slice(0, 100) ?? "Decision made",
              content: currentBlock.trim().slice(0, 500),
              tags: [],
            });
            break;
          }
        }
        for (const pattern of rejectionPatterns) {
          const match = currentBlock.match(pattern);
          if (match) {
            chains.push({
              type: "rejection",
              title: `Rejected: ${match[1]?.slice(0, 80) ?? "approach"}`,
              content: currentBlock.trim().slice(0, 500),
              tags: [],
            });
            break;
          }
        }
        for (const pattern of insightPatterns) {
          const match = currentBlock.match(pattern);
          if (match) {
            chains.push({
              type: "insight",
              title: match[1]?.slice(0, 100) ?? "Insight",
              content: currentBlock.trim().slice(0, 500),
              tags: [],
            });
            break;
          }
        }
        for (const pattern of solutionPatterns) {
          const match = currentBlock.match(pattern);
          if (match) {
            chains.push({
              type: "solution",
              title: match[1]?.slice(0, 100) ?? "Solution found",
              content: currentBlock.trim().slice(0, 500),
              tags: [],
            });
            break;
          }
        }
      }
      inAssistant = false;
      currentBlock = "";
      continue;
    }
    if (inAssistant) {
      currentBlock += line + "\n";
    }
  }

  return chains;
}
