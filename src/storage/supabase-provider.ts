import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config/config.ts";
import type {
  StorageProvider,
  ListSessionsOpts,
  SearchReasoningOpts,
  TimelineOpts,
  GetRelatedChainsOpts,
  ListChainsWithEmbeddingsOpts,
} from "./provider.ts";
import type {
  ChainRelation,
  ChainSource,
  ChainStatus,
  ChainWithEmbedding,
  ReasoningChain,
  ReasoningType,
  RecallResult,
  RelatedChainResult,
  RelationType,
  Session,
  SessionChunk,
  SessionListEntry,
  TimelineEntry,
} from "../config/types.ts";

/**
 * Supabase storage provider — hosted Postgres + pgvector.
 * Requires Supabase account and auth.
 * Used for cloud sync and team features.
 */
/**
 * Create and return a bare Supabase client using config credentials.
 * Used by sync.ts and other modules that need direct Supabase access
 * outside the storage provider abstraction.
 */
export function getSupabaseClient(): SupabaseClient {
  if (!config.supabase.url || !config.supabase.anonKey) {
    throw new Error(
      "Supabase URL and anon key must be set. " +
      "Set SESSIONGRAPH_SUPABASE_URL and SESSIONGRAPH_SUPABASE_ANON_KEY environment variables."
    );
  }
  return createClient(config.supabase.url, config.supabase.anonKey);
}

export class SupabaseStorageProvider implements StorageProvider {
  readonly mode = "cloud" as const;
  private client: SupabaseClient | null = null;

  private getClient(): SupabaseClient {
    if (!this.client) {
      if (!config.supabase.url || !config.supabase.anonKey) {
        throw new Error(
          "Supabase URL and anon key must be set. " +
          "Set SESSIONGRAPH_SUPABASE_URL and SESSIONGRAPH_SUPABASE_ANON_KEY environment variables."
        );
      }
      this.client = createClient(config.supabase.url, config.supabase.anonKey);
    }
    return this.client;
  }

  async initialize(): Promise<void> {
    // Schema is managed via Supabase migrations, nothing to do here
    this.getClient(); // Ensure client can be created (validates config)
  }

  async close(): Promise<void> {
    this.client = null;
  }

  /** Set auth session for RLS. Must be called before any data operations. */
  async setAuth(accessToken: string, refreshToken: string): Promise<void> {
    const sb = this.getClient();
    await sb.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
  }

  // ---- Sessions ----

  async upsertSession(session: Session): Promise<string> {
    const sb = this.getClient();
    const { data, error } = await sb
      .from("sessions")
      .upsert({
        id: session.id,
        user_id: session.userId,
        tool: session.tool,
        project: session.project,
        started_at: session.startedAt.toISOString(),
        ended_at: session.endedAt?.toISOString(),
        summary: session.summary,
        metadata: session.metadata,
      })
      .select("id")
      .single();

    if (error) throw new Error(`Failed to upsert session: ${error.message}`);
    return data.id;
  }

  async listSessions(opts: ListSessionsOpts): Promise<SessionListEntry[]> {
    const sb = this.getClient();
    let query = sb
      .from("sessions")
      .select("id, tool, project, started_at, ended_at, summary")
      .eq("user_id", opts.userId)
      .order("started_at", { ascending: false })
      .limit(opts.limit ?? 20);

    if (opts.project) query = query.eq("project", opts.project);
    if (opts.tool) query = query.eq("tool", opts.tool);

    const { data, error } = await query;
    if (error) throw new Error(`Failed to list sessions: ${error.message}`);

    // Get chain counts — one HEAD request per session (returns count without row data)
    const sessionIds = data.map((s: any) => s.id);
    const countMap = new Map<string, number>();
    // Batch: fetch counts in parallel, HEAD-only (no row data transferred)
    const countPromises = sessionIds.map(async (sid: string) => {
      const { count } = await sb
        .from("reasoning_chains")
        .select("*", { count: "exact", head: true })
        .eq("session_id", sid);
      countMap.set(sid, count ?? 0);
    });
    await Promise.all(countPromises);

    return data.map((s: any) => ({
      id: s.id,
      tool: s.tool,
      project: s.project,
      startedAt: s.started_at,
      endedAt: s.ended_at,
      summary: s.summary,
      chainCount: countMap.get(s.id) ?? 0,
    }));
  }

  // ---- Reasoning Chains ----

  async insertReasoningChain(chain: ReasoningChain): Promise<string> {
    const sb = this.getClient();
    const { data, error } = await sb
      .from("reasoning_chains")
      .insert({
        session_id: chain.sessionId,
        user_id: chain.userId,
        type: chain.type,
        title: chain.title,
        content: chain.content,
        context: chain.context,
        tags: chain.tags,
        embedding: chain.embedding,
        quality: chain.quality ?? 1.0,
        project: chain.project ?? null,
        source: chain.source ?? "mcp_capture",
        status: chain.status ?? "active",
      })
      .select("id")
      .single();

    if (error) throw new Error(`Failed to insert reasoning chain: ${error.message}`);
    return data.id;
  }

  async insertReasoningChains(chains: ReasoningChain[]): Promise<string[]> {
    if (chains.length === 0) return [];
    const sb = this.getClient();
    const { data, error } = await sb
      .from("reasoning_chains")
      .insert(
        chains.map((chain) => ({
          session_id: chain.sessionId || null,
          user_id: chain.userId,
          type: chain.type,
          title: chain.title,
          content: chain.content,
          context: chain.context,
          tags: chain.tags,
          embedding: chain.embedding,
          quality: chain.quality ?? 1.0,
          project: chain.project ?? null,
          source: chain.source ?? "mcp_capture",
          status: chain.status ?? "active",
        }))
      )
      .select("id");

    if (error) throw new Error(`Failed to insert reasoning chains: ${error.message}`);
    return data.map((d: any) => d.id);
  }

  async searchReasoning(opts: SearchReasoningOpts): Promise<RecallResult[]> {
    const sb = this.getClient();
    const { data, error } = await sb.rpc("search_reasoning", {
      query_embedding: opts.queryEmbedding,
      filter_user_id: opts.userId,
      filter_project: opts.project ?? null,
      match_threshold: opts.matchThreshold ?? 0.5,
      match_count: opts.limit ?? 10,
    });

    if (error) throw new Error(`Failed to search reasoning: ${error.message}`);

    let results = (data ?? []).map((r: any) => ({
      id: r.id,
      sessionId: r.session_id,
      type: r.type as ReasoningType,
      title: r.title,
      content: r.content,
      context: r.context,
      tags: r.tags,
      similarity: r.similarity,
      score: r.similarity * (0.7 + 0.3 * (r.quality ?? 1.0)), // Approximate blended score until RPC is updated
      quality: r.quality ?? 1.0,
      project: r.project ?? undefined,
      source: (r.source as ChainSource) ?? undefined,
      status: (r.status as ChainStatus) ?? undefined,
      createdAt: r.created_at,
    }));

    // Client-side type filter (RPC doesn't support type filtering natively)
    if (opts.type) {
      results = results.filter((r: { type: ReasoningType }) => r.type === opts.type);
    }

    return results;
  }

  // ---- Timeline ----

  async getTimeline(opts: TimelineOpts): Promise<TimelineEntry[]> {
    const sb = this.getClient();
    let sessionQuery = sb
      .from("sessions")
      .select("id, tool, project, started_at, ended_at, summary")
      .eq("user_id", opts.userId)
      .order("started_at", { ascending: false })
      .limit(opts.limit ?? 10);

    if (opts.project) sessionQuery = sessionQuery.eq("project", opts.project);
    if (opts.since) sessionQuery = sessionQuery.gte("started_at", opts.since);

    const { data: sessions, error: sessError } = await sessionQuery;
    if (sessError) throw new Error(`Failed to get timeline: ${sessError.message}`);
    if (!sessions || sessions.length === 0) return [];

    const sessionIds = sessions.map((s: any) => s.id);
    const { data: chains, error: chainError } = await sb
      .from("reasoning_chains")
      .select("id, session_id, type, title, content, tags, quality, project, source, status, created_at")
      .in("session_id", sessionIds)
      .order("created_at", { ascending: true });

    if (chainError) throw new Error(`Failed to get timeline chains: ${chainError.message}`);

    const chainMap = new Map<string, TimelineEntry["reasoningChains"]>();
    for (const c of (chains ?? []) as any[]) {
      if (!chainMap.has(c.session_id)) chainMap.set(c.session_id, []);
      chainMap.get(c.session_id)!.push({
        id: c.id,
        type: c.type as ReasoningType,
        title: c.title,
        content: c.content,
        tags: c.tags ?? [],
        quality: c.quality ?? 1.0,
        project: c.project ?? undefined,
        source: (c.source as ChainSource) ?? undefined,
        status: (c.status as ChainStatus) ?? undefined,
        createdAt: c.created_at,
      });
    }

    return sessions.map((s: any) => ({
      sessionId: s.id,
      tool: s.tool,
      project: s.project,
      startedAt: s.started_at,
      endedAt: s.ended_at,
      summary: s.summary,
      reasoningChains: chainMap.get(s.id) ?? [],
    }));
  }

  // ---- Session Chunks ----

  async insertSessionChunks(chunks: SessionChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const sb = this.getClient();
    const { error } = await sb.from("session_chunks").insert(
      chunks.map((c) => ({
        session_id: c.sessionId,
        user_id: c.userId,
        role: c.role,
        content: c.content,
        chunk_index: c.chunkIndex,
      }))
    );
    if (error) throw new Error(`Failed to insert session chunks: ${error.message}`);
  }

  // ---- Chain Relations ----

  async insertChainRelation(relation: ChainRelation): Promise<string> {
    const sb = this.getClient();
    const { data, error } = await sb
      .from("chain_relations")
      .upsert(
        {
          source_chain_id: relation.sourceChainId,
          target_chain_id: relation.targetChainId,
          relation_type: relation.relationType,
          confidence: relation.confidence ?? null,
        },
        { onConflict: "source_chain_id,target_chain_id,relation_type" }
      )
      .select("id")
      .single();

    if (error) throw new Error(`Failed to insert chain relation: ${error.message}`);
    return data.id;
  }

  async insertChainRelations(relations: ChainRelation[]): Promise<string[]> {
    if (relations.length === 0) return [];
    const sb = this.getClient();
    const { data, error } = await sb
      .from("chain_relations")
      .upsert(
        relations.map((r) => ({
          source_chain_id: r.sourceChainId,
          target_chain_id: r.targetChainId,
          relation_type: r.relationType,
          confidence: r.confidence ?? null,
        })),
        { onConflict: "source_chain_id,target_chain_id,relation_type" }
      )
      .select("id");

    if (error) throw new Error(`Failed to insert chain relations: ${error.message}`);
    return (data ?? []).map((d: any) => d.id);
  }

  async getRelatedChains(opts: GetRelatedChainsOpts): Promise<RelatedChainResult[]> {
    const sb = this.getClient();
    const limit = opts.limit ?? 20;
    // Note: Supabase provider only supports depth=1 (direct relations) for now.
    // Multi-hop would require recursive queries or RPC functions.

    // Query outgoing relations (this chain → others)
    let outgoingQuery = sb
      .from("chain_relations")
      .select("target_chain_id, relation_type, confidence, reasoning_chains!chain_relations_target_chain_id_fkey(id, title, type, content, tags, created_at)")
      .eq("source_chain_id", opts.chainId)
      .limit(limit);

    if (opts.relationType) {
      outgoingQuery = outgoingQuery.eq("relation_type", opts.relationType);
    }

    // Query incoming relations (others → this chain)
    let incomingQuery = sb
      .from("chain_relations")
      .select("source_chain_id, relation_type, confidence, reasoning_chains!chain_relations_source_chain_id_fkey(id, title, type, content, tags, created_at)")
      .eq("target_chain_id", opts.chainId)
      .limit(limit);

    if (opts.relationType) {
      incomingQuery = incomingQuery.eq("relation_type", opts.relationType);
    }

    const [outgoing, incoming] = await Promise.all([outgoingQuery, incomingQuery]);

    if (outgoing.error) throw new Error(`Failed to get outgoing relations: ${outgoing.error.message}`);
    if (incoming.error) throw new Error(`Failed to get incoming relations: ${incoming.error.message}`);

    const results: RelatedChainResult[] = [];

    for (const row of outgoing.data ?? []) {
      const chain = row.reasoning_chains as any;
      if (!chain) continue;
      results.push({
        chainId: chain.id,
        relationType: row.relation_type as RelationType,
        direction: "outgoing",
        confidence: (row as any).confidence ?? undefined,
        depth: 1,
        title: chain.title,
        type: chain.type as ReasoningType,
        content: chain.content,
        tags: chain.tags ?? [],
        createdAt: chain.created_at,
      });
    }

    for (const row of incoming.data ?? []) {
      const chain = row.reasoning_chains as any;
      if (!chain) continue;
      results.push({
        chainId: chain.id,
        relationType: row.relation_type as RelationType,
        direction: "incoming",
        confidence: (row as any).confidence ?? undefined,
        depth: 1,
        title: chain.title,
        type: chain.type as ReasoningType,
        content: chain.content,
        tags: chain.tags ?? [],
        createdAt: chain.created_at,
      });
    }

    return results;
  }

  // ---- Batch / Linking ----

  async listChainsWithEmbeddings(opts: ListChainsWithEmbeddingsOpts): Promise<ChainWithEmbedding[]> {
    const sb = this.getClient();
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;

    const { data, error } = await sb
      .from("reasoning_chains")
      .select("id, title, content, type, tags, embedding")
      .eq("user_id", opts.userId)
      .not("embedding", "is", null)
      .order("created_at", { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) throw new Error(`Failed to list chains with embeddings: ${error.message}`);

    return (data ?? []).map((r: any) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      type: r.type as ReasoningType,
      tags: r.tags ?? [],
      embedding: r.embedding,
    }));
  }

  // ---- Dynamic Quality & Chain Mutation (stubs for cloud provider) ----

  async touchChains(chainIds: string[]): Promise<void> {
    if (chainIds.length === 0) return;
    const client = this.getClient();

    // Supabase doesn't support bulk increment natively, so loop
    for (const id of chainIds) {
      await client.rpc("touch_chain", { chain_id: id });
    }
  }

  async updateChain(chainId: string, updates: {
    tags?: string[];
    quality?: number;
    metadata?: Record<string, unknown>;
    status?: import("../config/types.ts").ChainStatus;
  }): Promise<void> {
    const client = this.getClient();

    const updateObj: Record<string, unknown> = {};
    if (updates.tags !== undefined) updateObj.tags = updates.tags;
    if (updates.quality !== undefined) updateObj.quality = updates.quality;
    if (updates.metadata !== undefined) updateObj.metadata = updates.metadata;
    if (updates.status !== undefined) updateObj.status = updates.status;

    if (Object.keys(updateObj).length === 0) return;

    const { error } = await client
      .from("reasoning_chains")
      .update(updateObj)
      .eq("id", chainId);

    if (error) throw new Error(`Failed to update chain: ${error.message}`);
  }

  async decayUnusedChains(_olderThanDays: number, _decayFactor: number): Promise<number> {
    // Cloud-side decay should be handled by a Supabase Edge Function or cron job
    throw new Error("decayUnusedChains is not supported in cloud mode. Use a server-side cron job instead.");
  }
}
