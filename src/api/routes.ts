import type { StorageProvider, EmbeddingProvider } from "../storage/provider.ts";
import type { ReasoningChain, RelationType, ChainStatus } from "../config/types.ts";
import { SEARCH_WEIGHT_PRESETS, REASONING_TYPES, CHAIN_SOURCES, CHAIN_STATUSES } from "../config/types.ts";

const LOCAL_USER_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Create the HTTP route handler.
 * Returns an async function that matches request paths/methods and dispatches to handlers.
 */
export function createRouter(storage: StorageProvider, embeddings: EmbeddingProvider) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // ---- GET /api/health ----
    if (method === "GET" && path === "/api/health") {
      return Response.json({
        status: "ok",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    }

    // ---- POST /api/remember ----
    if (method === "POST" && path === "/api/remember") {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }

      const { title, content, type, tags, context, project, source, quality, metadata } = body as Record<string, unknown>;

      if (typeof title !== "string" || !title.trim()) {
        return Response.json({ error: "title is required (string)" }, { status: 400 });
      }
      if (typeof content !== "string" || !content.trim()) {
        return Response.json({ error: "content is required (string)" }, { status: 400 });
      }
      if (typeof type !== "string" || !(REASONING_TYPES as readonly string[]).includes(type)) {
        return Response.json({ error: `type must be one of: ${REASONING_TYPES.join(", ")}` }, { status: 400 });
      }

      // Validate optional fields
      const chainTags = Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [];
      const chainSource = typeof source === "string" && (CHAIN_SOURCES as readonly string[]).includes(source)
        ? (source as ReasoningChain["source"])
        : undefined;
      const chainQuality = typeof quality === "number" && quality >= 0 && quality <= 1 ? quality : undefined;
      const chainMetadata = metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : undefined;

      // Generate embedding
      const embeddingParts = [title, content];
      if (chainTags.length > 0) embeddingParts.push(chainTags.join(", "));
      const embeddingText = embeddingParts.join("\n");
      const embedding = await embeddings.generateEmbedding(embeddingText);

      const chain: ReasoningChain = {
        sessionId: null,
        userId: LOCAL_USER_ID,
        type: type as ReasoningChain["type"],
        title: title.trim(),
        content: content.trim(),
        context: typeof context === "string" ? context : undefined,
        tags: chainTags,
        embedding,
        quality: chainQuality,
        project: typeof project === "string" ? project : undefined,
        source: chainSource,
        status: "active",
        metadata: chainMetadata,
      };

      const id = await storage.insertReasoningChain(chain);
      return Response.json({ id });
    }

    // ---- POST /api/recall ----
    if (method === "POST" && path === "/api/recall") {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }

      const { query, limit, project, type, matchThreshold, includeSuperseded, weights, weightPreset } = body as Record<string, unknown>;

      if (typeof query !== "string" || !query.trim()) {
        return Response.json({ error: "query is required (string)" }, { status: 400 });
      }

      // Resolve weights
      let resolvedWeights = undefined;
      if (typeof weightPreset === "string" && weightPreset in SEARCH_WEIGHT_PRESETS) {
        resolvedWeights = SEARCH_WEIGHT_PRESETS[weightPreset as keyof typeof SEARCH_WEIGHT_PRESETS];
      } else if (weights && typeof weights === "object" && !Array.isArray(weights)) {
        resolvedWeights = weights as Record<string, unknown>;
      }

      const queryEmbedding = await embeddings.generateEmbedding(query.trim());

      const results = await storage.searchReasoning({
        queryEmbedding,
        queryText: query.trim(),
        userId: LOCAL_USER_ID,
        project: typeof project === "string" ? project : undefined,
        type: typeof type === "string" ? type : undefined,
        matchThreshold: typeof matchThreshold === "number" ? matchThreshold : undefined,
        limit: typeof limit === "number" ? limit : undefined,
        includeSuperseded: typeof includeSuperseded === "boolean" ? includeSuperseded : undefined,
        weights: resolvedWeights as any,
      });

      // Touch chains (reinforcement signal)
      if (results.length > 0) {
        const chainIds = results.map((r) => r.id);
        await storage.touchChains(chainIds).catch(() => {});
      }

      return Response.json({ results });
    }

    // ---- GET /api/timeline ----
    if (method === "GET" && path === "/api/timeline") {
      const project = url.searchParams.get("project") ?? undefined;
      const since = url.searchParams.get("since") ?? undefined;
      const limitStr = url.searchParams.get("limit");
      const limit = limitStr ? parseInt(limitStr, 10) : undefined;

      const entries = await storage.getTimeline({
        userId: LOCAL_USER_ID,
        project,
        since,
        limit: Number.isFinite(limit) ? limit : undefined,
      });

      return Response.json({ entries });
    }

    // ---- GET /api/sessions ----
    if (method === "GET" && path === "/api/sessions") {
      const project = url.searchParams.get("project") ?? undefined;
      const tool = url.searchParams.get("tool") ?? undefined;
      const limitStr = url.searchParams.get("limit");
      const limit = limitStr ? parseInt(limitStr, 10) : undefined;

      const sessions = await storage.listSessions({
        userId: LOCAL_USER_ID,
        project,
        tool,
        limit: Number.isFinite(limit) ? limit : undefined,
      });

      return Response.json({ sessions });
    }

    // ---- POST /api/graph ----
    if (method === "POST" && path === "/api/graph") {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }

      const { chainId, relationType, depth, limit: bodyLimit } = body as Record<string, unknown>;

      if (typeof chainId !== "string" || !chainId.trim()) {
        return Response.json({ error: "chainId is required (string)" }, { status: 400 });
      }

      const related = await storage.getRelatedChains({
        chainId: chainId.trim(),
        relationType: typeof relationType === "string" ? (relationType as RelationType) : undefined,
        depth: typeof depth === "number" ? depth : undefined,
        limit: typeof bodyLimit === "number" ? bodyLimit : undefined,
      });

      return Response.json({ related });
    }

    // ---- PATCH /api/chains/:id ----
    const chainsPatchMatch = method === "PATCH" && path.match(/^\/api\/chains\/([a-f0-9-]+)$/);
    if (chainsPatchMatch) {
      const chainId = chainsPatchMatch[1]!;
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }

      const { tags, quality, metadata, status } = body as Record<string, unknown>;

      const updates: {
        tags?: string[];
        quality?: number;
        metadata?: Record<string, unknown>;
        status?: ChainStatus;
      } = {};

      if (Array.isArray(tags)) {
        updates.tags = tags.filter((t): t is string => typeof t === "string");
      }
      if (typeof quality === "number" && quality >= 0 && quality <= 1) {
        updates.quality = quality;
      }
      if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
        updates.metadata = metadata as Record<string, unknown>;
      }
      if (typeof status === "string" && (CHAIN_STATUSES as readonly string[]).includes(status)) {
        updates.status = status as ChainStatus;
      }

      if (Object.keys(updates).length === 0) {
        return Response.json({ error: "No valid fields to update. Accepted: tags, quality, metadata, status" }, { status: 400 });
      }

      await storage.updateChain(chainId, updates);
      return Response.json({ ok: true });
    }

    // ---- POST /api/consolidate ----
    if (method === "POST" && path === "/api/consolidate") {
      const body = await req.json().catch(() => null);
      const opts = (body && typeof body === "object") ? body as Record<string, unknown> : {};

      const { consolidate } = await import("../consolidation/consolidator.ts");

      const result = await consolidate({
        minClusterSize: typeof opts.minClusterSize === "number" ? opts.minClusterSize : undefined,
        project: typeof opts.project === "string" ? opts.project : undefined,
        dryRun: typeof opts.dryRun === "boolean" ? opts.dryRun : undefined,
        delayMs: typeof opts.delayMs === "number" ? opts.delayMs : undefined,
      });

      return Response.json({ result });
    }

    // ---- POST /api/decay ----
    if (method === "POST" && path === "/api/decay") {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }

      const { olderThanDays, decayFactor } = body as Record<string, unknown>;

      if (typeof olderThanDays !== "number" || olderThanDays <= 0) {
        return Response.json({ error: "olderThanDays is required (positive number)" }, { status: 400 });
      }
      if (typeof decayFactor !== "number" || decayFactor <= 0 || decayFactor >= 1) {
        return Response.json({ error: "decayFactor is required (number between 0 and 1, exclusive)" }, { status: 400 });
      }

      const decayed = await storage.decayUnusedChains(olderThanDays, decayFactor);
      return Response.json({ decayed });
    }

    // ---- 404 ----
    return Response.json({ error: "Not found" }, { status: 404 });
  };
}
