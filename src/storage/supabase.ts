import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config/config.ts";
import type {
  ReasoningChain,
  ReasoningType,
  Session,
  SessionChunk,
  RecallResult,
  SessionListEntry,
  TimelineEntry,
} from "../config/types.ts";

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!client) {
    if (!config.supabase.url || !config.supabase.anonKey) {
      throw new Error(
        "Supabase URL and anon key must be set. Set SESSIONGRAPH_SUPABASE_URL and SESSIONGRAPH_SUPABASE_ANON_KEY environment variables."
      );
    }
    client = createClient(config.supabase.url, config.supabase.anonKey);
  }
  return client;
}

export async function setSupabaseAuth(accessToken: string, refreshToken: string) {
  const sb = getSupabaseClient();
  await sb.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
}

// ---- Sessions ----

export async function upsertSession(session: Session): Promise<string> {
  const sb = getSupabaseClient();
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

export async function listSessions(opts: {
  userId: string;
  project?: string;
  tool?: string;
  limit?: number;
}): Promise<SessionListEntry[]> {
  const sb = getSupabaseClient();
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

  // Get chain counts for each session
  const sessionIds = data.map((s: any) => s.id);
  const { data: counts, error: countError } = await sb
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

export async function insertReasoningChain(chain: ReasoningChain): Promise<string> {
  const sb = getSupabaseClient();
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

export async function insertReasoningChains(chains: ReasoningChain[]): Promise<string[]> {
  if (chains.length === 0) return [];
  const sb = getSupabaseClient();
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

// ---- Recall (semantic search) ----

export async function searchReasoning(opts: {
  queryEmbedding: number[];
  userId: string;
  project?: string;
  type?: string;
  matchThreshold?: number;
  limit?: number;
}): Promise<RecallResult[]> {
  const sb = getSupabaseClient();
  const { data, error } = await sb.rpc("search_reasoning", {
    query_embedding: opts.queryEmbedding,
    filter_user_id: opts.userId,
    filter_project: opts.project ?? null,
    match_threshold: opts.matchThreshold ?? 0.7,
    match_count: opts.limit ?? 10,
  });

  if (error) throw new Error(`Failed to search reasoning: ${error.message}`);

  return (data ?? []).map((r: any) => ({
    id: r.id,
    sessionId: r.session_id,
    type: r.type,
    title: r.title,
    content: r.content,
    context: r.context,
    tags: r.tags,
    similarity: r.similarity,
    createdAt: r.created_at,
  }));
}

// ---- Timeline ----

export async function getTimeline(opts: {
  userId: string;
  project?: string;
  since?: string;
  limit?: number;
}): Promise<TimelineEntry[]> {
  const sb = getSupabaseClient();
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

export async function insertSessionChunks(chunks: SessionChunk[]): Promise<void> {
  if (chunks.length === 0) return;
  const sb = getSupabaseClient();
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

// ---- Embeddings (via Edge Function) ----

// Separate unauthenticated client for edge functions.
// User access tokens use ES256 signing which Supabase Edge Functions
// may not verify correctly. The embedding function doesn't need user
// auth — it only computes vectors — so we use the anon key directly.
let edgeFnClient: SupabaseClient | null = null;

function getEdgeFnClient(): SupabaseClient {
  if (!edgeFnClient) {
    if (!config.supabase.url || !config.supabase.anonKey) {
      throw new Error(
        "Supabase URL and anon key must be set. Set SESSIONGRAPH_SUPABASE_URL and SESSIONGRAPH_SUPABASE_ANON_KEY environment variables."
      );
    }
    edgeFnClient = createClient(config.supabase.url, config.supabase.anonKey);
  }
  return edgeFnClient;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const sb = getEdgeFnClient();
  const { data, error } = await sb.functions.invoke("generate-embedding", {
    body: { text },
  });

  if (error) throw new Error(`Failed to generate embedding: ${error.message}`);
  return data.embedding;
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const BATCH_SIZE = 5;
  const allEmbeddings: number[][] = [];
  const sb = getEdgeFnClient();

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const { data, error } = await sb.functions.invoke("generate-embedding", {
      body: { texts: batch },
    });

    if (error) {
      throw new Error(
        `Failed to generate embeddings (batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(texts.length / BATCH_SIZE)}): ${error.message}`
      );
    }

    allEmbeddings.push(...data.embeddings);
  }

  return allEmbeddings;
}
