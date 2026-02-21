import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { join } from "path";
import { config, ensureDataDir } from "../config/config.ts";
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

/** Fixed user ID for local single-user mode. Keeps schema compatible with cloud sync. */
const LOCAL_USER_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Validate and serialize an embedding array to a pgvector literal string.
 * Throws if any element is not a finite number — prevents SQL injection
 * from corrupted or malicious embedding data.
 */
function toVectorLiteral(embedding: number[]): string {
  if (embedding.length === 0) {
    throw new Error("Embedding array must not be empty");
  }
  for (let i = 0; i < embedding.length; i++) {
    if (!Number.isFinite(embedding[i])) {
      throw new Error(
        `Invalid embedding value at index ${i}: ${embedding[i]} (expected finite number)`
      );
    }
  }
  return `[${embedding.join(",")}]`;
}

/**
 * PGlite storage provider — embedded Postgres with pgvector.
 * All data lives in ~/.sessiongraph/pglite/
 * No auth, no network, no account needed.
 */
export class PGliteStorageProvider implements StorageProvider {
  readonly mode = "local" as const;
  private db: PGlite | null = null;

  private async getDb(): Promise<PGlite> {
    if (this.db) return this.db;
    throw new Error("PGlite not initialized. Call initialize() first.");
  }

  async initialize(): Promise<void> {
    if (this.db) return;

    ensureDataDir();
    const dataDir = join(config.paths.dataDir, "pglite");

    this.db = await PGlite.create({
      dataDir,
      extensions: { vector },
    });

    await this.db.exec("CREATE EXTENSION IF NOT EXISTS vector;");
    await this.initSchema();
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }

  private async initSchema(): Promise<void> {
    const db = await this.getDb();

    // Sessions table
    await db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT '${LOCAL_USER_ID}',
        tool TEXT NOT NULL,
        project TEXT,
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ,
        summary TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Reasoning chains table
    await db.exec(`
      CREATE TABLE IF NOT EXISTS reasoning_chains (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL DEFAULT '${LOCAL_USER_ID}',
        type TEXT NOT NULL CHECK (type IN ('decision', 'exploration', 'rejection', 'solution', 'insight')),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        context TEXT,
        tags TEXT[] DEFAULT '{}',
        embedding vector(384),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Session chunks table
    await db.exec(`
      CREATE TABLE IF NOT EXISTS session_chunks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL DEFAULT '${LOCAL_USER_ID}',
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Indexes (use IF NOT EXISTS via exec — PGlite handles it)
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_reasoning_embedding
        ON reasoning_chains USING hnsw (embedding vector_cosine_ops);
    `);
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_time
        ON sessions (started_at DESC);
    `);
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_reasoning_time
        ON reasoning_chains (created_at DESC);
    `);
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_reasoning_session
        ON reasoning_chains (session_id);
    `);
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chunks_session
        ON session_chunks (session_id, chunk_index);
    `);
  }

  // ---- Sessions ----

  async upsertSession(session: Session): Promise<string> {
    const db = await this.getDb();
    const id = session.id ?? crypto.randomUUID();

    await db.query(
      `INSERT INTO sessions (id, user_id, tool, project, started_at, ended_at, summary, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         tool = EXCLUDED.tool,
         project = EXCLUDED.project,
         started_at = EXCLUDED.started_at,
         ended_at = EXCLUDED.ended_at,
         summary = EXCLUDED.summary,
         metadata = EXCLUDED.metadata`,
      [
        id,
        LOCAL_USER_ID,
        session.tool,
        session.project ?? null,
        session.startedAt.toISOString(),
        session.endedAt?.toISOString() ?? null,
        session.summary ?? null,
        JSON.stringify(session.metadata),
      ]
    );

    return id;
  }

  async listSessions(opts: ListSessionsOpts): Promise<SessionListEntry[]> {
    const db = await this.getDb();
    const limit = opts.limit ?? 20;

    // Build dynamic WHERE clauses
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    // userId filter — local mode always has a single user, but filter for parity
    if (opts.userId) {
      conditions.push(`s.user_id = $${paramIdx++}`);
      params.push(opts.userId);
    }
    if (opts.project) {
      conditions.push(`s.project = $${paramIdx++}`);
      params.push(opts.project);
    }
    if (opts.tool) {
      conditions.push(`s.tool = $${paramIdx++}`);
      params.push(opts.tool);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Get sessions with chain counts in a single query
    const result = await db.query<{
      id: string;
      tool: string;
      project: string | null;
      started_at: string;
      ended_at: string | null;
      summary: string | null;
      chain_count: string;
    }>(
      `SELECT s.id, s.tool, s.project, s.started_at, s.ended_at, s.summary,
              COALESCE(rc.cnt, 0) AS chain_count
       FROM sessions s
       LEFT JOIN (
         SELECT session_id, COUNT(*) AS cnt
         FROM reasoning_chains
         GROUP BY session_id
       ) rc ON rc.session_id = s.id
       ${where}
       ORDER BY s.started_at DESC
       LIMIT $${paramIdx}`,
      [...params, limit]
    );

    return result.rows.map((s) => ({
      id: s.id,
      tool: s.tool,
      project: s.project ?? undefined,
      startedAt: s.started_at,
      endedAt: s.ended_at ?? undefined,
      summary: s.summary ?? undefined,
      chainCount: Number(s.chain_count),
    }));
  }

  // ---- Reasoning Chains ----

  async insertReasoningChain(chain: ReasoningChain): Promise<string> {
    const db = await this.getDb();

    const embeddingStr = chain.embedding
      ? toVectorLiteral(chain.embedding)
      : null;

    const result = await db.query<{ id: string }>(
      `INSERT INTO reasoning_chains (session_id, user_id, type, title, content, context, tags, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)
       RETURNING id`,
      [
        chain.sessionId ?? null,
        LOCAL_USER_ID,
        chain.type,
        chain.title,
        chain.content,
        chain.context ?? null,
        chain.tags,
        embeddingStr,
      ]
    );

    return result.rows[0]!.id;
  }

  async insertReasoningChains(chains: ReasoningChain[]): Promise<string[]> {
    if (chains.length === 0) return [];
    const db = await this.getDb();

    const ids: string[] = [];
    await db.exec("BEGIN");
    try {
      for (const chain of chains) {
        const embeddingStr = chain.embedding
          ? toVectorLiteral(chain.embedding)
          : null;

        const result = await db.query<{ id: string }>(
          `INSERT INTO reasoning_chains (session_id, user_id, type, title, content, context, tags, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)
           RETURNING id`,
          [
            chain.sessionId ?? null,
            LOCAL_USER_ID,
            chain.type,
            chain.title,
            chain.content,
            chain.context ?? null,
            chain.tags,
            embeddingStr,
          ]
        );
        ids.push(result.rows[0]!.id);
      }
      await db.exec("COMMIT");
    } catch (err) {
      await db.exec("ROLLBACK");
      throw err;
    }
    return ids;
  }

  async searchReasoning(opts: SearchReasoningOpts): Promise<RecallResult[]> {
    const db = await this.getDb();
    const threshold = opts.matchThreshold ?? 0.3;
    const limit = opts.limit ?? 10;

    const embeddingStr = toVectorLiteral(opts.queryEmbedding);

    // Build optional project filter
    let projectFilter = "";
    let typeFilter = "";
    const params: any[] = [embeddingStr, threshold, limit];
    let paramIdx = 4;

    if (opts.project) {
      projectFilter = `AND rc.session_id IN (SELECT s.id FROM sessions s WHERE s.project = $${paramIdx++})`;
      params.push(opts.project);
    }

    if (opts.type) {
      typeFilter = `AND rc.type = $${paramIdx++}`;
      params.push(opts.type);
    }

    const result = await db.query<{
      id: string;
      session_id: string | null;
      type: string;
      title: string;
      content: string;
      context: string | null;
      tags: string[];
      similarity: number;
      created_at: string;
    }>(
      `SELECT
         rc.id,
         rc.session_id,
         rc.type,
         rc.title,
         rc.content,
         rc.context,
         rc.tags,
         1 - (rc.embedding <=> $1::vector) AS similarity,
         rc.created_at
       FROM reasoning_chains rc
       WHERE rc.embedding IS NOT NULL
          AND 1 - (rc.embedding <=> $1::vector) > $2
          ${projectFilter}
          ${typeFilter}
       ORDER BY rc.embedding <=> $1::vector
       LIMIT $3`,
      params
    );

    return result.rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id ?? "",
      type: r.type as ReasoningType,
      title: r.title,
      content: r.content,
      context: r.context ?? undefined,
      tags: r.tags ?? [],
      similarity: r.similarity,
      createdAt: r.created_at,
    }));
  }

  // ---- Timeline ----

  async getTimeline(opts: TimelineOpts): Promise<TimelineEntry[]> {
    const db = await this.getDb();
    const limit = opts.limit ?? 10;

    // Build conditions
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (opts.project) {
      conditions.push(`s.project = $${paramIdx++}`);
      params.push(opts.project);
    }
    if (opts.since) {
      conditions.push(`s.started_at >= $${paramIdx++}`);
      params.push(opts.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Get sessions
    const sessResult = await db.query<{
      id: string;
      tool: string;
      project: string | null;
      started_at: string;
      summary: string | null;
    }>(
      `SELECT id, tool, project, started_at, summary
       FROM sessions s
       ${where}
       ORDER BY started_at DESC
       LIMIT $${paramIdx}`,
      [...params, limit]
    );

    if (sessResult.rows.length === 0) return [];

    // Get chains for these sessions
    const sessionIds = sessResult.rows.map((s) => s.id);
    const placeholders = sessionIds.map((_, i) => `$${i + 1}`).join(",");

    const chainResult = await db.query<{
      session_id: string;
      type: string;
      title: string;
      content: string;
    }>(
      `SELECT session_id, type, title, content
       FROM reasoning_chains
       WHERE session_id IN (${placeholders})
       ORDER BY created_at ASC`,
      sessionIds
    );

    // Group chains by session
    const chainMap = new Map<string, { type: ReasoningType; title: string; content: string }[]>();
    for (const c of chainResult.rows) {
      if (!chainMap.has(c.session_id)) chainMap.set(c.session_id, []);
      chainMap.get(c.session_id)!.push({
        type: c.type as ReasoningType,
        title: c.title,
        content: c.content,
      });
    }

    return sessResult.rows.map((s) => ({
      sessionId: s.id,
      tool: s.tool,
      project: s.project ?? undefined,
      startedAt: s.started_at,
      summary: s.summary ?? undefined,
      reasoningChains: chainMap.get(s.id) ?? [],
    }));
  }

  // ---- Session Chunks ----

  async insertSessionChunks(chunks: SessionChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const db = await this.getDb();

    await db.exec("BEGIN");
    try {
      for (const chunk of chunks) {
        await db.query(
          `INSERT INTO session_chunks (session_id, user_id, role, content, chunk_index)
           VALUES ($1, $2, $3, $4, $5)`,
          [chunk.sessionId, LOCAL_USER_ID, chunk.role, chunk.content, chunk.chunkIndex]
        );
      }
      await db.exec("COMMIT");
    } catch (err) {
      await db.exec("ROLLBACK");
      throw err;
    }
  }
}
