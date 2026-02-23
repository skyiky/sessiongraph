import { config } from "../config/config.ts";
import { getStorageProvider, getEmbeddingProvider } from "../storage/provider.ts";
import type { ReasoningChain, ReasoningType, ChainRelation } from "../config/types.ts";

export interface ConsolidateOptions {
  /** Minimum cluster size to consolidate (default: 3) */
  minClusterSize?: number;
  /** Only consolidate chains in this project */
  project?: string;
  /** Delay between Ollama calls in ms (default: 1000) */
  delayMs?: number;
  /** Don't write anything, just report what would happen */
  dryRun?: boolean;
  /** Ollama runtime options */
  ollamaOptions?: {
    numThread?: number;
    numGpu?: number;
    numCtx?: number;
  };
  /** Progress callback */
  onProgress?: (progress: ConsolidateProgress) => void;
}

export interface ConsolidateProgress {
  phase: "scanning" | "clustering" | "synthesizing" | "inserting";
  current: number;
  total: number;
  detail?: string;
}

export interface ConsolidateResult {
  clustersFound: number;
  clustersSynthesized: number;
  chainsConsolidated: number; // total original chains that were superseded
  chainsCreated: number; // new consolidated chains inserted
  errors: string[];
}

export interface Cluster {
  chains: ClusterChain[];
  project?: string;
}

interface ClusterChain {
  id: string;
  title: string;
  content: string;
  type: ReasoningType;
  tags: string[];
  quality: number;
  project?: string;
  createdAt: string;
}

const LOCAL_USER_ID = "00000000-0000-0000-0000-000000000000";
const VALID_TYPES = new Set<ReasoningType>([
  "decision",
  "exploration",
  "rejection",
  "solution",
  "insight",
]);

const SYNTHESIS_PROMPT = `You consolidate multiple related reasoning chains into one.

You will be given several reasoning chains that are connected and overlapping.

Return a single JSON object: {"title": "...", "content": "...", "type": "insight|decision|solution|exploration|rejection", "tags": ["..."]}

Rules:
- Produce one consolidated chain only.
- Content should be dense and non-redundant, capturing all key insights.
- Type must be one of: decision, exploration, rejection, solution, insight.
- Return ONLY the JSON object. No other text.`;

function getClusterChainFromSeed(seed: {
  id: string;
  title: string;
  content: string;
  type: ReasoningType;
  tags: string[];
}): ClusterChain {
  return {
    id: seed.id,
    title: seed.title,
    content: seed.content,
    type: seed.type,
    tags: seed.tags,
    quality: 1.0,
    project: undefined,
    createdAt: "",
  };
}

function mergeClusterChain(
  existing: ClusterChain | undefined,
  update: Partial<ClusterChain> & Pick<ClusterChain, "id" | "title" | "content" | "type" | "tags">,
): ClusterChain {
  if (!existing) {
    return {
      id: update.id,
      title: update.title,
      content: update.content,
      type: update.type,
      tags: update.tags,
      quality: update.quality ?? 1.0,
      project: update.project,
      createdAt: update.createdAt ?? "",
    };
  }

  return {
    id: existing.id,
    title: existing.title || update.title,
    content: existing.content || update.content,
    type: existing.type ?? update.type,
    tags: existing.tags.length > 0 ? existing.tags : update.tags,
    quality: existing.quality ?? update.quality ?? 1.0,
    project: existing.project ?? update.project,
    createdAt: existing.createdAt || update.createdAt || "",
  };
}

export async function findClusters(opts: ConsolidateOptions = {}): Promise<Cluster[]> {
  const storage = await getStorageProvider();
  const minClusterSize = opts.minClusterSize ?? 3;

  const allChains: {
    id: string;
    title: string;
    content: string;
    type: ReasoningType;
    tags: string[];
  }[] = [];

  const batchSize = 200;
  let offset = 0;
  while (true) {
    const batch = await storage.listChainsWithEmbeddings({
      userId: LOCAL_USER_ID,
      limit: batchSize,
      offset,
    });
    if (batch.length === 0) break;
    for (const chain of batch) {
      allChains.push({
        id: chain.id,
        title: chain.title,
        content: chain.content,
        type: chain.type,
        tags: chain.tags,
      });
    }
    offset += batch.length;
    if (batch.length < batchSize) break;
  }

  const chainData = new Map<string, ClusterChain>();
  for (const chain of allChains) {
    chainData.set(chain.id, getClusterChainFromSeed(chain));
  }

  const adjacency = new Map<string, Set<string>>();
  const addEdge = (a: string, b: string) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
  };

  for (const chain of allChains) {
    const related = await storage.getRelatedChains({
      chainId: chain.id,
      limit: 200,
    });

    for (const rel of related) {
      if (rel.relationType !== "builds_on" && rel.relationType !== "refines") continue;
      addEdge(chain.id, rel.chainId);

      const existing = chainData.get(rel.chainId);
      chainData.set(
        rel.chainId,
        mergeClusterChain(existing, {
          id: rel.chainId,
          title: rel.title,
          content: rel.content,
          type: rel.type,
          tags: rel.tags,
          quality: 1.0,
          project: undefined,
          createdAt: rel.createdAt,
        }),
      );
    }
  }

  const allIds = Array.from(chainData.keys());
  const visited = new Set<string>();
  const clusters: Cluster[] = [];

  for (const id of allIds) {
    if (visited.has(id)) continue;
    const queue = [id];
    const component: ClusterChain[] = [];
    visited.add(id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const chain = chainData.get(current);
      if (chain) component.push(chain);

      const neighbors = adjacency.get(current);
      if (!neighbors) continue;
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    if (component.length >= minClusterSize) {
      if (opts.project) {
        const matchesProject = component.every((c) => c.project === opts.project);
        if (!matchesProject) continue;
      }
      const project = component.every((c) => c.project === component[0]?.project)
        ? component[0]?.project
        : undefined;
      clusters.push({
        chains: component,
        project,
      });
    }
  }

  return clusters;
}

function buildSynthesisPrompt(cluster: Cluster): string {
  const lines: string[] = [];
  lines.push(`You are given ${cluster.chains.length} related reasoning chains.`);
  lines.push("Consolidate them into one chain.");
  lines.push("");

  cluster.chains.forEach((chain, index) => {
    lines.push(`Chain ${index + 1} (${chain.id}):`);
    lines.push(`Type: ${chain.type}`);
    lines.push(`Title: ${chain.title}`);
    if (chain.tags.length > 0) {
      lines.push(`Tags: ${chain.tags.join(", ")}`);
    }
    lines.push(`Content: ${chain.content}`);
    lines.push("");
  });

  return lines.join("\n");
}

function cleanOllamaJson(content: string): string {
  let cleaned = content.trim();
  const thinkEnd = cleaned.indexOf("</think>");
  if (thinkEnd !== -1) {
    cleaned = cleaned.slice(thinkEnd + 8).trim();
  }
  if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
  if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
  return cleaned.trim();
}

export async function synthesizeCluster(
  cluster: Cluster,
  opts?: ConsolidateOptions["ollamaOptions"],
): Promise<ReasoningChain> {
  const model = config.ollama.chatModel;
  const baseUrl = config.ollama.baseUrl;
  const userPrompt = buildSynthesisPrompt(cluster);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYNTHESIS_PROMPT },
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
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error("Synthesis timed out after 120s");
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
  if (!content) {
    throw new Error("Ollama returned empty response");
  }

  const cleaned = cleanOllamaJson(content);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    throw new Error("Failed to parse Ollama response as JSON");
  }

  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  const body = typeof parsed.content === "string" ? parsed.content.trim() : "";
  const rawType = typeof parsed.type === "string" ? parsed.type.trim().toLowerCase() : "";
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.filter((t): t is string => typeof t === "string")
    : [];

  const type = VALID_TYPES.has(rawType as ReasoningType) ? (rawType as ReasoningType) : "insight";

  if (!title || !body) {
    throw new Error("Ollama response missing title or content");
  }

  const chainIds = cluster.chains.map((c) => c.id);
  const project = cluster.project;

  return {
    sessionId: null,
    userId: LOCAL_USER_ID,
    type,
    title,
    content: body,
    tags,
    quality: 1.0,
    project,
    source: "agent",
    status: "active",
    metadata: {
      consolidatedFrom: chainIds,
      consolidatedAt: new Date().toISOString(),
    },
  };
}

export async function consolidate(opts: ConsolidateOptions = {}): Promise<ConsolidateResult> {
  const delayMs = opts.delayMs ?? 1000;

  const result: ConsolidateResult = {
    clustersFound: 0,
    clustersSynthesized: 0,
    chainsConsolidated: 0,
    chainsCreated: 0,
    errors: [],
  };

  opts.onProgress?.({ phase: "scanning", current: 0, total: 1, detail: "Loading chains" });
  let clusters: Cluster[] = [];
  try {
    clusters = await findClusters(opts);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Cluster scan failed: ${msg}`);
    return result;
  }

  result.clustersFound = clusters.length;
  opts.onProgress?.({
    phase: "clustering",
    current: clusters.length,
    total: clusters.length,
    detail: `${clusters.length} clusters found`,
  });

  const storage = await getStorageProvider();
  const embeddings = await getEmbeddingProvider();

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i]!;
    opts.onProgress?.({
      phase: "synthesizing",
      current: i + 1,
      total: clusters.length,
      detail: `Cluster ${i + 1} of ${clusters.length}`,
    });

    try {
      const synthesized = await synthesizeCluster(cluster, opts.ollamaOptions);
      result.clustersSynthesized += 1;

      if (!opts.dryRun) {
        const embeddingParts = [synthesized.title, synthesized.content];
        if (synthesized.tags.length > 0) embeddingParts.push(synthesized.tags.join(", "));
        const embeddingText = embeddingParts.join("\n");
        const embedding = await embeddings.generateEmbedding(embeddingText);

        const chainId = await storage.insertReasoningChain({
          ...synthesized,
          embedding,
        });

        const relations: ChainRelation[] = cluster.chains.map((original) => ({
          sourceChainId: chainId,
          targetChainId: original.id,
          relationType: "supersedes",
        }));

        if (relations.length > 0) {
          await storage.insertChainRelations(relations);
        }

        result.chainsCreated += 1;
        result.chainsConsolidated += relations.length;
      }

      opts.onProgress?.({
        phase: "inserting",
        current: i + 1,
        total: clusters.length,
        detail: opts.dryRun ? "Dry run" : "Inserted consolidated chain",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Cluster ${i + 1}: ${msg}`);
    }

    if (delayMs > 0 && i < clusters.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return result;
}
