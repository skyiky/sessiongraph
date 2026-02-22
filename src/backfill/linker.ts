import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { config } from "../config/config.ts";
import { getStorageProvider } from "../storage/provider.ts";
import type { ChainWithEmbedding, RelationType, ChainRelation } from "../config/types.ts";
import { RELATION_TYPES, BIDIRECTIONAL_RELATIONS } from "../config/types.ts";

// --- Types ---

export interface LinkOptions {
  /** Maximum chains to process in this run */
  limit?: number;
  /** Top-K similar chains to compare against for each chain */
  topK?: number;
  /** Minimum similarity threshold for candidate pairs (default 0.5) */
  threshold?: number;
  /** Delay in milliseconds between classification calls (default 1000) */
  delayMs?: number;
  /** Ollama runtime options */
  ollamaOptions?: {
    numThread?: number;
    numGpu?: number;
    numCtx?: number;
  };
  /** Progress callback */
  onProgress?: (progress: LinkProgress) => void;
}

export interface LinkProgress {
  current: number;
  total: number;
  chainId: string;
  candidatesFound: number;
  relationsCreated: number;
}

export interface LinkResult {
  chainsProcessed: number;
  chainsSkipped: number;
  relationsCreated: number;
  errors: string[];
}

// --- Classification prompt ---

const CLASSIFICATION_PROMPT = `You classify the relationship between two reasoning chains from AI coding sessions.

Given Chain A and Chain B, determine if there is a meaningful relationship between them.

Valid relation types (from A's perspective toward B):
- "leads_to": A caused or motivated B
- "supersedes": A replaces or overrides B
- "contradicts": A and B conflict with each other
- "builds_on": A extends or deepens B
- "depends_on": A only makes sense because of B
- "refines": A narrows or improves B without replacing it
- "generalizes": A abstracts B into a broader pattern
- "analogous_to": Similar reasoning applied in different contexts
- "none": No meaningful relationship

Return a JSON object: {"relation": "...", "confidence": 0.0-1.0}

Rules:
- Only return a relation if there is a clear, meaningful connection.
- "none" is the correct answer most of the time. Be selective.
- confidence should be 0.7+ for the relation to be worth storing.
- Consider the direction: the relation goes FROM Chain A TO Chain B.
- Return ONLY the JSON object. No other text.`;

/** Timeout for classification calls (60 seconds — these are small prompts) */
const CLASSIFY_TIMEOUT_MS = 60_000;

/** Minimum confidence to store a relation */
const MIN_CONFIDENCE = 0.7;

// --- Link state persistence ---

const LOCAL_USER_ID = "00000000-0000-0000-0000-000000000000";

interface LinkState {
  /** Chain IDs that have already been processed (linked against all candidates) */
  linkedChainIds: string[];
}

function getStatePath(): string {
  return join(config.paths.dataDir, "link-state.json");
}

function loadState(): LinkState {
  const statePath = getStatePath();
  if (!existsSync(statePath)) {
    return { linkedChainIds: [] };
  }
  try {
    const raw = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw) as LinkState;
    return {
      linkedChainIds: Array.isArray(parsed.linkedChainIds)
        ? parsed.linkedChainIds
        : [],
    };
  } catch {
    return { linkedChainIds: [] };
  }
}

function saveState(state: LinkState): void {
  const statePath = getStatePath();
  const dir = config.paths.dataDir;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}

// --- Ollama classification ---

interface ClassificationResult {
  relation: RelationType | "none";
  confidence: number;
}

const VALID_RELATIONS = new Set<string>([...RELATION_TYPES, "none"]);

async function classifyPair(
  chainA: ChainWithEmbedding,
  chainB: ChainWithEmbedding,
  opts?: LinkOptions["ollamaOptions"],
): Promise<ClassificationResult> {
  const model = config.ollama.chatModel;
  const baseUrl = config.ollama.baseUrl;

  const userPrompt = `Chain A [${chainA.type}]: ${chainA.title}
${chainA.content}

Chain B [${chainB.type}]: ${chainB.title}
${chainB.content}

What is the relationship from Chain A to Chain B?`;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: CLASSIFICATION_PROMPT },
          { role: "user", content: userPrompt },
        ],
        stream: false,
        format: "json",
        options: {
          ...(opts?.numThread != null && { num_thread: opts.numThread }),
          ...(opts?.numGpu != null && { num_gpu: opts.numGpu }),
          num_ctx: opts?.numCtx ?? 4096,
        },
      }),
      signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(`Classification timed out after ${CLASSIFY_TIMEOUT_MS / 1000}s`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Ollama request failed: ${message}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Ollama API error (${response.status}): ${body}`);
  }

  const result = (await response.json()) as { message?: { content?: string } };
  const content = result.message?.content;
  if (!content) return { relation: "none", confidence: 0 };

  // Clean response
  let cleaned = content.trim();
  const thinkEnd = cleaned.indexOf("</think>");
  if (thinkEnd !== -1) {
    cleaned = cleaned.slice(thinkEnd + 8).trim();
  }
  if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
  if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
  cleaned = cleaned.trim();

  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const relation = String(parsed.relation ?? "none").toLowerCase().trim();
    const confidence = Number(parsed.confidence ?? 0);

    if (!VALID_RELATIONS.has(relation)) return { relation: "none", confidence: 0 };

    return {
      relation: relation as RelationType | "none",
      confidence: Number.isFinite(confidence) ? confidence : 0,
    };
  } catch {
    return { relation: "none", confidence: 0 };
  }
}

/** Number of chains between state saves (avoids excessive I/O) */
const STATE_SAVE_INTERVAL = 10;

// --- Main linker ---

/**
 * Run the auto-linking pass.
 *
 * For each unprocessed chain with an embedding:
 * 1. Use searchReasoning to find top-K similar chains
 * 2. Filter out self-matches and already-linked pairs
 * 3. Classify each pair with qwen2.5:3b
 * 4. Insert relations for confident matches
 *
 * State is persisted to link-state.json so runs are resumable.
 */
export async function runLinker(opts: LinkOptions = {}): Promise<LinkResult> {
  const topK = opts.topK ?? 5;
  const threshold = opts.threshold ?? 0.5;
  const delayMs = opts.delayMs ?? 1000;

  const storage = await getStorageProvider();
  const state = loadState();
  const linkedSet = new Set(state.linkedChainIds);

  // Track pairs we've already classified in this run (sorted IDs as key)
  const processedPairs = new Set<string>();

  const result: LinkResult = {
    chainsProcessed: 0,
    chainsSkipped: 0,
    relationsCreated: 0,
    errors: [],
  };

  // Load all chains with embeddings in batches
  const allChains: ChainWithEmbedding[] = [];
  const batchSize = 200;
  let offset = 0;
  while (true) {
    const batch = await storage.listChainsWithEmbeddings({
      userId: LOCAL_USER_ID,
      limit: batchSize,
      offset,
    });
    if (batch.length === 0) break;
    allChains.push(...batch);
    offset += batch.length;
    if (batch.length < batchSize) break;
  }

  // Filter to unprocessed chains
  const unprocessed = allChains.filter((c) => !linkedSet.has(c.id));

  if (unprocessed.length === 0) {
    return result;
  }

  // Build a lookup map for all chains by ID
  const chainMap = new Map(allChains.map((c) => [c.id, c]));

  // Apply limit
  const toProcess = opts.limit ? unprocessed.slice(0, opts.limit) : unprocessed;
  const total = toProcess.length;

  for (let i = 0; i < toProcess.length; i++) {
    const chain = toProcess[i]!;

    // Find top-K similar chains using vector search
    const candidates = await storage.searchReasoning({
      queryEmbedding: chain.embedding,
      userId: LOCAL_USER_ID,
      matchThreshold: threshold,
      limit: topK + 1, // +1 because we'll filter out self
    });

    // Filter out self-match
    const filtered = candidates.filter((c) => c.id !== chain.id);

    // Pre-load existing relations for this chain to avoid O(candidates) DB queries
    const existingRelations = await storage.getRelatedChains({
      chainId: chain.id,
      limit: 200,
    });
    const alreadyLinkedIds = new Set(existingRelations.map((r) => r.chainId));

    let relationsForChain = 0;

    for (const candidate of filtered) {
      // Create sorted pair key for dedup
      const pairKey = [chain.id, candidate.id].sort().join(":");
      if (processedPairs.has(pairKey)) continue;
      processedPairs.add(pairKey);

      // Check if any relation already exists between these two (local Set lookup)
      if (alreadyLinkedIds.has(candidate.id)) continue;

      // Get the full candidate chain data for classification
      const candidateChain = chainMap.get(candidate.id);
      if (!candidateChain) continue;

      // Classify the pair
      try {
        const classification = await classifyPair(chain, candidateChain, opts.ollamaOptions);

        if (classification.relation !== "none" && classification.confidence >= MIN_CONFIDENCE) {
          // Insert the relation
          const relations: ChainRelation[] = [
            {
              sourceChainId: chain.id,
              targetChainId: candidate.id,
              relationType: classification.relation,
              confidence: classification.confidence,
            },
          ];

          // Auto-insert reverse for bidirectional relations
          if (BIDIRECTIONAL_RELATIONS.includes(classification.relation)) {
            relations.push({
              sourceChainId: candidate.id,
              targetChainId: chain.id,
              relationType: classification.relation,
              confidence: classification.confidence,
            });
          }

          await storage.insertChainRelations(relations);
          relationsForChain += relations.length;
          result.relationsCreated += relations.length;
        }

        // Rate limit
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Chain ${chain.id.slice(0, 8)} ↔ ${candidate.id.slice(0, 8)}: ${msg}`);
      }
    }

    // Mark chain as processed
    state.linkedChainIds.push(chain.id);
    linkedSet.add(chain.id);
    result.chainsProcessed++;

    // Save state periodically (every STATE_SAVE_INTERVAL chains) to reduce I/O
    if (result.chainsProcessed % STATE_SAVE_INTERVAL === 0) {
      saveState(state);
    }

    // Report progress
    opts.onProgress?.({
      current: i + 1,
      total,
      chainId: chain.id,
      candidatesFound: filtered.length,
      relationsCreated: relationsForChain,
    });
  }

  // Final state flush to capture any remaining unwritten progress
  if (result.chainsProcessed > 0) {
    saveState(state);
  }

  return result;
}
