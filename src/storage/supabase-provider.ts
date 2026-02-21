import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config/config.ts";
import type {
  StorageProvider,
  ListSessionsOpts,
  SearchReasoningOpts,
  TimelineOpts,
} from "./provider.ts";
import type {
  ReasoningChain,
  ReasoningType,
  RecallResult,
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

    // Get chain counts
    const sessionIds = data.map((s: any) => s.id);
    const { data: counts } = await sb
      .from("reasoning_chains")
      .select("session_id")
      .in("session_id", sessionIds);

    const countMap = new Map<string, number>();
    if (counts) {
      for (const c of counts as any[]) {
        countMap.set(c.session_id, (countMap.get(c.session_id) ?? 0) + 1);
      }
    }

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
      match_threshold: opts.matchThreshold ?? 0.3,
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
      createdAt: r.created_at,
    }));

    // Client-side type filter (RPC doesn't support type filtering natively)
    if (opts.type) {
      results = results.filter((r) => r.type === opts.type);
    }

    return results;
  }

  // ---- Timeline ----

  async getTimeline(opts: TimelineOpts): Promise<TimelineEntry[]> {
    const sb = this.getClient();
    let sessionQuery = sb
      .from("sessions")
      .select("id, tool, project, started_at, summary")
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
      .select("session_id, type, title, content")
      .in("session_id", sessionIds)
      .order("created_at", { ascending: true });

    if (chainError) throw new Error(`Failed to get timeline chains: ${chainError.message}`);

    const chainMap = new Map<string, { type: ReasoningType; title: string; content: string }[]>();
    for (const c of (chains ?? []) as any[]) {
      if (!chainMap.has(c.session_id)) chainMap.set(c.session_id, []);
      chainMap.get(c.session_id)!.push({ type: c.type as ReasoningType, title: c.title, content: c.content });
    }

    return sessions.map((s: any) => ({
      sessionId: s.id,
      tool: s.tool,
      project: s.project,
      startedAt: s.started_at,
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
}
