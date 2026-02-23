import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, unlinkSync } from "fs";
import { config, ensureDataDir } from "../config/config.ts";
import { acquireLock } from "./lockfile.ts";
import type {
  StorageProvider,
  ListSessionsOpts,
  SearchReasoningOpts,
  TimelineOpts,
  GetRelatedChainsOpts,
  ListChainsWithEmbeddingsOpts,
  DriftWalkOpts,
  SpreadActivationOpts,
} from "./provider.ts";
import type {
  ChainRelation,
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
  ChainSource,
  ChainStatus,
  SearchWeights,
  DriftStep,
  DriftResult,
  ActivatedChain,
} from "../config/types.ts";
import { SEARCH_WEIGHT_PRESETS } from "../config/types.ts";

/** Fixed user ID for local single-user mode. Keeps schema compatible with cloud sync. */
const LOCAL_USER_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Validate and serialize an embedding array to a pgvector literal string.
 * Throws if any element is not a finite number — prevents SQL injection
 * from corrupted or malicious embedding data.
 */
function toVectorLiteral(embedding: number[]): string {
  if (!Array.isArray(embedding)) {
    throw new Error("Embedding must be an array");
  }
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
  private releaseLock: (() => void) | null = null;
  private writeCount = 0;
  private backupInFlight = false;

  /** Number of write operations between automatic CHECKPOINT + backup. */
  private static CHECKPOINT_INTERVAL = 10;

  private async getDb(): Promise<PGlite> {
    if (this.db) return this.db;
    throw new Error("PGlite not initialized. Call initialize() first.");
  }

  async initialize(): Promise<void> {
    if (this.db) return;

    ensureDataDir();
    const dataDir = join(config.paths.dataDir, "pglite");
    const lockPath = join(config.paths.dataDir, "pglite.lock");

    // Acquire exclusive lock before opening the database
    this.releaseLock = acquireLock(lockPath);

    try {
      this.db = await PGlite.create({
        dataDir,
        extensions: { vector },
      });

      // Layer 3: Health check — verify DB is actually functional
      await this.db.exec("SELECT 1");

      await this.db.exec("CREATE EXTENSION IF NOT EXISTS vector;");
      await this.initSchema();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Aborted(")) {
        // Layer 2: Attempt auto-restore from backup
        const restored = await this.attemptRestore(dataDir);
        if (restored) {
          return; // Successfully restored — initialize() is done
        }

        this.releaseLock?.();
        this.releaseLock = null;

        console.error(
          `\nPGlite database is corrupted and cannot start.\n` +
          `Data directory: ${dataDir}\n\n` +
          `No backup found to restore from.\n` +
          `To recover, delete the data directory and re-run:\n\n` +
          `  rm -rf "${dataDir}"\n\n` +
          `The database will be recreated automatically. Data can be rebuilt via backfill.\n`
        );
        throw new Error(
          `PGlite database corrupted. Delete ${dataDir} to recover.`
        );
      }

      this.releaseLock?.();
      this.releaseLock = null;
      throw err;
    }
  }

  /**
   * Attempt to restore from a backup after corruption is detected.
   * Deletes the corrupted data directory, restores from backup, re-initializes.
   * Returns true if restoration succeeded, false if no backup available.
   */
  private async attemptRestore(dataDir: string): Promise<boolean> {
    const backupPath = config.paths.pgliteBackup;
    const backupMetaPath = config.paths.pgliteBackupMeta;

    if (!existsSync(backupPath)) {
      return false;
    }

    // Read backup metadata for logging
    let backupAge = "unknown age";
    try {
      if (existsSync(backupMetaPath)) {
        const meta = JSON.parse(readFileSync(backupMetaPath, "utf-8"));
        if (meta.timestamp) {
          const ageMs = Date.now() - new Date(meta.timestamp).getTime();
          const ageHours = Math.round(ageMs / (1000 * 60 * 60) * 10) / 10;
          backupAge = ageHours < 1
            ? `${Math.round(ageMs / (1000 * 60))} minutes old`
            : `${ageHours} hours old`;
        }
      }
    } catch {
      // Metadata is optional — proceed without it
    }

    console.error(
      `\n[SessionGraph] Database corruption detected. Restoring from backup (${backupAge})...`
    );

    try {
      // Close the broken instance if it partially initialized
      if (this.db) {
        try { await this.db.close(); } catch { /* ignore */ }
        this.db = null;
      }

      // Delete the corrupted data directory
      rmSync(dataDir, { recursive: true, force: true });

      // Read backup blob
      const backupData = readFileSync(backupPath);
      const backupBlob = new Blob([backupData]);

      // Restore from backup
      this.db = await PGlite.create({
        dataDir,
        loadDataDir: backupBlob,
        extensions: { vector },
      });

      // Verify the restored DB works
      await this.db.exec("SELECT 1");
      await this.db.exec("CREATE EXTENSION IF NOT EXISTS vector;");
      await this.initSchema();

      console.error(
        `[SessionGraph] Successfully restored from backup (${backupAge}). Some recent data may be lost.\n`
      );
      return true;
    } catch (restoreErr: unknown) {
      const restoreMsg = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
      console.error(
        `[SessionGraph] Backup restoration failed: ${restoreMsg}\n` +
        `Falling back to manual recovery.\n`
      );

      // Clean up partial state
      if (this.db) {
        try { await this.db.close(); } catch { /* ignore */ }
        this.db = null;
      }
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      // Layer 1: CHECKPOINT before close to flush WAL to data files
      try {
        await this.db.exec("CHECKPOINT");
      } catch (err: unknown) {
        console.error(
          "CHECKPOINT before close failed:",
          err instanceof Error ? err.message : String(err)
        );
      }

      // Layer 2: Final backup before shutdown
      try {
        await this.createBackup();
      } catch (err: unknown) {
        console.error(
          "Backup before close failed:",
          err instanceof Error ? err.message : String(err)
        );
      }

      await this.db.close();
      this.db = null;
    }
    this.releaseLock?.();
    this.releaseLock = null;
  }

  /**
   * Called after each write operation. Triggers CHECKPOINT + backup
   * every CHECKPOINT_INTERVAL writes to minimize the dirty window.
   */
  private async afterWrite(): Promise<void> {
    this.writeCount++;
    if (this.writeCount >= PGliteStorageProvider.CHECKPOINT_INTERVAL) {
      this.writeCount = 0;
      if (!this.db || this.backupInFlight) return;

      this.backupInFlight = true;
      try {
        await this.db.exec("CHECKPOINT");
        await this.createBackup();
      } catch (err: unknown) {
        console.error(
          "Periodic checkpoint/backup failed:",
          err instanceof Error ? err.message : String(err)
        );
      } finally {
        this.backupInFlight = false;
      }
    }
  }

  /**
   * Create a rolling backup of the PGlite data directory.
   * Uses atomic write (temp file + rename) to avoid corrupt backups.
   */
  private async createBackup(): Promise<void> {
    if (!this.db) return;

    const backupPath = config.paths.pgliteBackup;
    const backupMetaPath = config.paths.pgliteBackupMeta;
    const tmpPath = backupPath + ".tmp";

    const dumpBlob = await this.db.dumpDataDir("gzip");
    const buffer = Buffer.from(await dumpBlob.arrayBuffer());

    // Atomic write: write to temp, then rename
    writeFileSync(tmpPath, buffer);
    renameSync(tmpPath, backupPath);

    // Write metadata
    const meta = {
      timestamp: new Date().toISOString(),
      writeCount: this.writeCount,
      sizeBytes: buffer.length,
    };
    writeFileSync(backupMetaPath, JSON.stringify(meta, null, 2));
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
        embedding vector(1024),
        quality REAL DEFAULT 1.0,
        project TEXT,
        source TEXT DEFAULT 'mcp_capture',
        status TEXT DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
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

    // Chain relations table — reasoning graph edges
    await db.exec(`
      CREATE TABLE IF NOT EXISTS chain_relations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_chain_id UUID NOT NULL REFERENCES reasoning_chains(id) ON DELETE CASCADE,
        target_chain_id UUID NOT NULL REFERENCES reasoning_chains(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL CHECK (relation_type IN (
          'leads_to', 'supersedes', 'contradicts', 'builds_on',
          'depends_on', 'refines', 'generalizes', 'analogous_to'
        )),
        confidence REAL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(source_chain_id, target_chain_id, relation_type)
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
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_relations_source
        ON chain_relations (source_chain_id);
    `);
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_relations_target
        ON chain_relations (target_chain_id);
    `);

    // ---- Migrations for existing databases ----
    // Add quality column if it doesn't exist (v0.3 schema upgrade)
    await db.exec(`
      ALTER TABLE reasoning_chains ADD COLUMN IF NOT EXISTS quality REAL DEFAULT 1.0;
    `);
    // v0.4 schema upgrade: project, source, status on reasoning_chains; confidence on chain_relations
    await db.exec(`
      ALTER TABLE reasoning_chains ADD COLUMN IF NOT EXISTS project TEXT;
    `);
    await db.exec(`
      ALTER TABLE reasoning_chains ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'mcp_capture';
    `);
    await db.exec(`
      ALTER TABLE reasoning_chains ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
    `);
    await db.exec(`
      ALTER TABLE chain_relations ADD COLUMN IF NOT EXISTS confidence REAL;
    `);

    // v0.5 schema upgrade: dynamic quality signals + metadata (Aegis extensions)
    await db.exec(`
      ALTER TABLE reasoning_chains ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
    `);
    await db.exec(`
      ALTER TABLE reasoning_chains ADD COLUMN IF NOT EXISTS recall_count INTEGER DEFAULT 0;
    `);
    await db.exec(`
      ALTER TABLE reasoning_chains ADD COLUMN IF NOT EXISTS last_recalled_at TIMESTAMPTZ;
    `);
    await db.exec(`
      ALTER TABLE reasoning_chains ADD COLUMN IF NOT EXISTS reference_count INTEGER DEFAULT 0;
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

    await this.afterWrite();
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
      `INSERT INTO reasoning_chains (session_id, user_id, type, title, content, context, tags, embedding, quality, project, source, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9, $10, $11, $12, $13)
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
        chain.quality ?? 1.0,
        chain.project ?? null,
        chain.source ?? "mcp_capture",
        chain.status ?? "active",
        JSON.stringify(chain.metadata ?? {}),
      ]
    );

    await this.afterWrite();
    return result.rows[0]!.id;
  }


  async insertReasoningChains(chains: ReasoningChain[]): Promise<string[]> {
    if (chains.length === 0) return [];
    const db = await this.getDb();

    // Build multi-row VALUES clause (13 params per row)
    const valueClauses: string[] = [];
    const params: any[] = [];
    let idx = 1;

    for (const chain of chains) {
      const embeddingStr = chain.embedding
        ? toVectorLiteral(chain.embedding)
        : null;

      valueClauses.push(
        `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}::vector, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
      );
      params.push(
        chain.sessionId ?? null,
        LOCAL_USER_ID,
        chain.type,
        chain.title,
        chain.content,
        chain.context ?? null,
        chain.tags,
        embeddingStr,
        chain.quality ?? 1.0,
        chain.project ?? null,
        chain.source ?? "mcp_capture",
        chain.status ?? "active",
        JSON.stringify(chain.metadata ?? {}),
      );
    }

    const result = await db.query<{ id: string }>(
      `INSERT INTO reasoning_chains (session_id, user_id, type, title, content, context, tags, embedding, quality, project, source, status, metadata)
       VALUES ${valueClauses.join(", ")}
       RETURNING id`,
      params
    );

    await this.afterWrite();
    return result.rows.map((r) => r.id);
  }

  async searchReasoning(opts: SearchReasoningOpts): Promise<RecallResult[]> {
    const db = await this.getDb();
    const threshold = opts.matchThreshold ?? 0.5;
    const limit = opts.limit ?? 10;
    const includeSuperseded = opts.includeSuperseded ?? false;

    // Configurable weights with defaults
    const w = {
      vectorSimilarity: opts.weights?.vectorSimilarity ?? SEARCH_WEIGHT_PRESETS.default.vectorSimilarity!,
      textMatch: opts.weights?.textMatch ?? SEARCH_WEIGHT_PRESETS.default.textMatch!,
      quality: opts.weights?.quality ?? SEARCH_WEIGHT_PRESETS.default.quality!,
      recency: opts.weights?.recency ?? SEARCH_WEIGHT_PRESETS.default.recency!,
      salience: opts.weights?.salience ?? SEARCH_WEIGHT_PRESETS.default.salience!,
    };

    const embeddingStr = toVectorLiteral(opts.queryEmbedding);

    // Build dynamic WHERE conditions
    const conditions: string[] = [
      "rc.embedding IS NOT NULL",
    ];
    const params: any[] = [embeddingStr];
    let paramIdx = 2;

    // Status filter: exclude superseded by default
    if (!includeSuperseded) {
      conditions.push(`COALESCE(rc.status, 'active') = 'active'`);
    }

    // Direct project filter on reasoning_chains (no longer JOINs through sessions)
    if (opts.project) {
      conditions.push(`(rc.project = $${paramIdx} OR rc.session_id IN (SELECT s.id FROM sessions s WHERE s.project = $${paramIdx}))`);
      params.push(opts.project);
      paramIdx++;
    }

    if (opts.type) {
      conditions.push(`rc.type = $${paramIdx}`);
      params.push(opts.type);
      paramIdx++;
    }

    // Hybrid search: vector similarity OR full-text match
    // If queryText is provided, include text matches even if they're below vector threshold
    const hasTextQuery = opts.queryText && opts.queryText.trim().length > 0;
    let textMatchExpr = "0.0";
    let matchCondition: string;

    if (hasTextQuery) {
      const textParamIdx = paramIdx++;
      params.push(opts.queryText!.trim());
      textMatchExpr = `CASE WHEN to_tsvector('english', rc.title || ' ' || rc.content || ' ' || COALESCE(array_to_string(rc.tags, ' '), '')) @@ plainto_tsquery('english', $${textParamIdx}) THEN 1.0 ELSE 0.0 END`;
      // Match if vector similarity > threshold OR text matches
      matchCondition = `(1 - (rc.embedding <=> $1::vector) > $${paramIdx} OR to_tsvector('english', rc.title || ' ' || rc.content || ' ' || COALESCE(array_to_string(rc.tags, ' '), '')) @@ plainto_tsquery('english', $${textParamIdx}))`;
    } else {
      matchCondition = `1 - (rc.embedding <=> $1::vector) > $${paramIdx}`;
    }
    params.push(threshold);
    paramIdx++;

    conditions.push(matchCondition);

    // Weight params
    const wVecIdx = paramIdx++;
    params.push(w.vectorSimilarity);
    const wTextIdx = paramIdx++;
    params.push(w.textMatch);
    const wQualIdx = paramIdx++;
    params.push(w.quality);
    const wRecIdx = paramIdx++;
    params.push(w.recency);
    const wSalIdx = paramIdx++;
    params.push(w.salience);

    // Limit param
    params.push(limit);
    const limitParamIdx = paramIdx++;

    const whereClause = conditions.join("\n          AND ");

    // Blended ranking formula with parameterized weights:
    //   score = vector_similarity * w_vec + text_match * w_text + quality * w_qual + recency * w_rec + salience * w_sal
    // Recency decay: 1.0 / (1.0 + age_in_days * 0.0005) — gentle, ~15% penalty at 1 year
    // Salience: log-scaled recall_count + reference_count * 2, normalized to 0-1 range via
    //   LN(1 + recall_count + reference_count * 2) / LN(1 + max_salience_across_all_chains)
    //   reference_count weighted 2x because being referenced is a stronger structural signal
    // Max salience is computed once via CTE (not per-row subquery)
    const result = await db.query<{
      id: string;
      session_id: string | null;
      type: string;
      title: string;
      content: string;
      context: string | null;
      tags: string[];
      similarity: number;
      text_match: number;
      quality: number;
      score: number;
      project: string | null;
      source: string | null;
      status: string | null;
      metadata: Record<string, unknown> | null;
      recall_count: number;
      reference_count: number;
      created_at: string;
    }>(
      `WITH max_sal AS (
         SELECT GREATEST(LN(1 + COALESCE(MAX(COALESCE(recall_count,0) + COALESCE(reference_count,0) * 2), 0)), 1.0) AS val
         FROM reasoning_chains
       )
       SELECT
         rc.id,
         rc.session_id,
         rc.type,
         rc.title,
         rc.content,
         rc.context,
         rc.tags,
         1 - (rc.embedding <=> $1::vector) AS similarity,
         ${textMatchExpr} AS text_match,
         COALESCE(rc.quality, 1.0) AS quality,
         (1 - (rc.embedding <=> $1::vector)) * $${wVecIdx}
           + ${textMatchExpr} * $${wTextIdx}
           + COALESCE(rc.quality, 1.0) * $${wQualIdx}
           + (1.0 / (1.0 + EXTRACT(EPOCH FROM (NOW() - rc.created_at)) / 86400.0 * 0.0005)) * $${wRecIdx}
           + CASE WHEN $${wSalIdx}::float > 0 THEN
               LN(1 + COALESCE(rc.recall_count, 0) + COALESCE(rc.reference_count, 0) * 2)
               / (SELECT val FROM max_sal)
               * $${wSalIdx}::float
             ELSE 0 END
         AS score,
         rc.project,
         rc.source,
         rc.status,
         rc.metadata,
         COALESCE(rc.recall_count, 0) AS recall_count,
         COALESCE(rc.reference_count, 0) AS reference_count,
         rc.created_at
       FROM reasoning_chains rc
       WHERE ${whereClause}
       ORDER BY score DESC
       LIMIT $${limitParamIdx}`,
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
      score: r.score,
      quality: r.quality,
      project: r.project ?? undefined,
      source: (r.source as ChainSource) ?? undefined,
      status: (r.status as ChainStatus) ?? undefined,
      metadata: r.metadata ?? undefined,
      recallCount: r.recall_count,
      referenceCount: r.reference_count,
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

    if (opts.userId) {
      conditions.push(`s.user_id = $${paramIdx++}`);
      params.push(opts.userId);
    }
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
      ended_at: string | null;
      summary: string | null;
    }>(
      `SELECT id, tool, project, started_at, ended_at, summary
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
      id: string;
      session_id: string;
      type: string;
      title: string;
      content: string;
      tags: string[];
      quality: number;
      project: string | null;
      source: string | null;
      status: string | null;
      created_at: string;
    }>(
      `SELECT id, session_id, type, title, content, tags, COALESCE(quality, 1.0) AS quality,
              project, source, status, created_at
       FROM reasoning_chains
       WHERE session_id IN (${placeholders})
       ORDER BY created_at ASC`,
      sessionIds
    );

    // Group chains by session
    const chainMap = new Map<string, { id: string; type: ReasoningType; title: string; content: string; tags: string[]; quality: number; project?: string; source?: ChainSource; status?: ChainStatus; createdAt: string }[]>();
    for (const c of chainResult.rows) {
      if (!chainMap.has(c.session_id)) chainMap.set(c.session_id, []);
      chainMap.get(c.session_id)!.push({
        id: c.id,
        type: c.type as ReasoningType,
        title: c.title,
        content: c.content,
        tags: c.tags ?? [],
        quality: c.quality,
        project: c.project ?? undefined,
        source: (c.source as ChainSource) ?? undefined,
        status: (c.status as ChainStatus) ?? undefined,
        createdAt: c.created_at,
      });
    }

    return sessResult.rows.map((s) => ({
      sessionId: s.id,
      tool: s.tool,
      project: s.project ?? undefined,
      startedAt: s.started_at,
      endedAt: s.ended_at ?? undefined,
      summary: s.summary ?? undefined,
      reasoningChains: chainMap.get(s.id) ?? [],
    }));
  }

  // ---- Session Chunks ----

  async insertSessionChunks(chunks: SessionChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const db = await this.getDb();

    // Build multi-row VALUES clause (5 params per row)
    const valueClauses: string[] = [];
    const params: any[] = [];
    let idx = 1;

    for (const chunk of chunks) {
      valueClauses.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      params.push(chunk.sessionId, LOCAL_USER_ID, chunk.role, chunk.content, chunk.chunkIndex);
    }

    await db.query(
      `INSERT INTO session_chunks (session_id, user_id, role, content, chunk_index)
       VALUES ${valueClauses.join(", ")}`,
      params
    );

    await this.afterWrite();
  }

  // ---- Chain Relations ----

  async insertChainRelation(relation: ChainRelation): Promise<string> {
    const db = await this.getDb();

    // Use xmax = 0 to detect true inserts vs conflict updates.
    // xmax = 0 means the row was freshly inserted (no previous version existed).
    const result = await db.query<{ id: string; xmax: number }>(
      `INSERT INTO chain_relations (source_chain_id, target_chain_id, relation_type, confidence)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (source_chain_id, target_chain_id, relation_type)
       DO UPDATE SET relation_type = EXCLUDED.relation_type, confidence = COALESCE(EXCLUDED.confidence, chain_relations.confidence)
       RETURNING id, xmax::int`,
      [relation.sourceChainId, relation.targetChainId, relation.relationType, relation.confidence ?? null]
    );

    const wasInserted = result.rows[0]!.xmax === 0;

    // Auto-archive: when a 'supersedes' relation is created, mark the target as superseded
    if (relation.relationType === "supersedes") {
      await db.query(
        `UPDATE reasoning_chains SET status = 'superseded' WHERE id = $1 AND COALESCE(status, 'active') = 'active'`,
        [relation.targetChainId]
      );
    }

    // Increment reference_count on target only for NEW relations (not re-upserts)
    const referenceRelations = ["builds_on", "refines", "depends_on", "analogous_to"];
    if (wasInserted && referenceRelations.includes(relation.relationType)) {
      await db.query(
        `UPDATE reasoning_chains SET reference_count = COALESCE(reference_count, 0) + 1 WHERE id = $1`,
        [relation.targetChainId]
      );
    }

    await this.afterWrite();
    return result.rows[0]!.id;
  }

  async insertChainRelations(relations: ChainRelation[]): Promise<string[]> {
    if (relations.length === 0) return [];
    const db = await this.getDb();

    // Build multi-row VALUES clause (4 params per row)
    // Use DO UPDATE with no-op SET so RETURNING includes conflict rows too
    const valueClauses: string[] = [];
    const params: any[] = [];
    let idx = 1;

    for (const relation of relations) {
      valueClauses.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      params.push(relation.sourceChainId, relation.targetChainId, relation.relationType, relation.confidence ?? null);
    }

    // Use xmax::int to detect true inserts (xmax = 0) vs conflict updates
    const result = await db.query<{ id: string; xmax: number; target_chain_id: string; relation_type: string }>(
      `INSERT INTO chain_relations (source_chain_id, target_chain_id, relation_type, confidence)
       VALUES ${valueClauses.join(", ")}
       ON CONFLICT (source_chain_id, target_chain_id, relation_type)
       DO UPDATE SET relation_type = EXCLUDED.relation_type, confidence = COALESCE(EXCLUDED.confidence, chain_relations.confidence)
       RETURNING id, xmax::int, target_chain_id, relation_type`,
      params
    );

    // Build a set of newly inserted relation rows
    const newlyInserted = result.rows.filter((r) => r.xmax === 0);

    // Auto-archive: mark targets of 'supersedes' relations as superseded
    const supersededTargets = relations
      .filter((r) => r.relationType === "supersedes")
      .map((r) => r.targetChainId);

    if (supersededTargets.length > 0) {
      const placeholders = supersededTargets.map((_, i) => `$${i + 1}`).join(",");
      await db.query(
        `UPDATE reasoning_chains SET status = 'superseded' WHERE id IN (${placeholders}) AND COALESCE(status, 'active') = 'active'`,
        supersededTargets
      );
    }

    // Increment reference_count on targets only for NEWLY INSERTED relations
    const referenceRelations = ["builds_on", "refines", "depends_on", "analogous_to"];
    const referenceTargets = newlyInserted
      .filter((r) => referenceRelations.includes(r.relation_type))
      .map((r) => r.target_chain_id);

    if (referenceTargets.length > 0) {
      // Deduplicate targets and count occurrences
      const targetCounts = new Map<string, number>();
      for (const t of referenceTargets) {
        targetCounts.set(t, (targetCounts.get(t) ?? 0) + 1);
      }
      for (const [targetId, count] of targetCounts) {
        await db.query(
          `UPDATE reasoning_chains SET reference_count = COALESCE(reference_count, 0) + $1 WHERE id = $2`,
          [count, targetId]
        );
      }
    }

    await this.afterWrite();
    return result.rows.map((r) => r.id);
  }

  async getRelatedChains(opts: GetRelatedChainsOpts): Promise<RelatedChainResult[]> {
    const db = await this.getDb();
    const limit = opts.limit ?? 20;
    const depth = Math.min(Math.max(opts.depth ?? 1, 1), 3); // Clamp to 1-3

    if (depth === 1) {
      // Fast path: single-hop query (original behavior + confidence)
      return this.getDirectRelatedChains(db, opts.chainId, opts.relationType, limit);
    }

    // Multi-hop BFS traversal
    const visited = new Set<string>([opts.chainId]);
    const allResults: RelatedChainResult[] = [];
    let frontier = [opts.chainId];

    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const nextFrontier: string[] = [];

      for (const nodeId of frontier) {
        const neighbors = await this.getDirectRelatedChains(db, nodeId, opts.relationType, limit);

        for (const neighbor of neighbors) {
          if (!visited.has(neighbor.chainId)) {
            visited.add(neighbor.chainId);
            allResults.push({ ...neighbor, depth: d + 1 });
            nextFrontier.push(neighbor.chainId);
          }
        }
      }

      frontier = nextFrontier;
    }

    // Sort by depth, then by date, and apply limit
    return allResults
      .sort((a, b) => a.depth - b.depth || String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  }

  /** Get direct (1-hop) related chains for a given chain ID. */
  private async getDirectRelatedChains(
    db: PGlite,
    chainId: string,
    relationType?: RelationType,
    limit = 20,
  ): Promise<RelatedChainResult[]> {
    // Query both directions: chains this one points to (outgoing) and chains pointing to this one (incoming)
    let typeFilter = "";
    const params: any[] = [chainId, limit];
    let paramIdx = 3;

    if (relationType) {
      typeFilter = `AND cr.relation_type = $${paramIdx++}`;
      params.push(relationType);
    }

    const result = await db.query<{
      chain_id: string;
      relation_type: string;
      direction: string;
      confidence: number | null;
      title: string;
      type: string;
      content: string;
      tags: string[];
      created_at: string;
    }>(
      `SELECT
         rc.id AS chain_id,
         cr.relation_type,
         'outgoing' AS direction,
         cr.confidence,
         rc.title,
         rc.type,
         rc.content,
         rc.tags,
         rc.created_at
       FROM chain_relations cr
       JOIN reasoning_chains rc ON rc.id = cr.target_chain_id
       WHERE cr.source_chain_id = $1 ${typeFilter}

       UNION ALL

       SELECT
         rc.id AS chain_id,
         cr.relation_type,
         'incoming' AS direction,
         cr.confidence,
         rc.title,
         rc.type,
         rc.content,
         rc.tags,
         rc.created_at
       FROM chain_relations cr
       JOIN reasoning_chains rc ON rc.id = cr.source_chain_id
       WHERE cr.target_chain_id = $1 ${typeFilter}

       ORDER BY created_at DESC
       LIMIT $2`,
      params
    );

    return result.rows.map((r) => ({
      chainId: r.chain_id,
      relationType: r.relation_type as RelationType,
      direction: r.direction as "outgoing" | "incoming",
      confidence: r.confidence ?? undefined,
      depth: 1,
      title: r.title,
      type: r.type as ReasoningType,
      content: r.content,
      tags: r.tags ?? [],
      createdAt: r.created_at,
    }));
  }

  // ---- Batch / Linking ----

  async listChainsWithEmbeddings(opts: ListChainsWithEmbeddingsOpts): Promise<ChainWithEmbedding[]> {
    const db = await this.getDb();
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;

    const result = await db.query<{
      id: string;
      title: string;
      content: string;
      type: string;
      tags: string[];
      embedding: string;
    }>(
      `SELECT id, title, content, type, tags, embedding::text
       FROM reasoning_chains
       WHERE embedding IS NOT NULL
       ORDER BY created_at ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return result.rows.map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      type: r.type as ReasoningType,
      tags: r.tags ?? [],
      embedding: parseVectorString(r.embedding),
    }));
  }

  // ---- Dynamic Quality & Chain Mutation ----

  async touchChains(chainIds: string[]): Promise<void> {
    if (chainIds.length === 0) return;
    const db = await this.getDb();

    const placeholders = chainIds.map((_, i) => `$${i + 1}`).join(",");
    await db.query(
      `UPDATE reasoning_chains
       SET recall_count = COALESCE(recall_count, 0) + 1,
           last_recalled_at = NOW()
       WHERE id IN (${placeholders})`,
      chainIds
    );

    await this.afterWrite();
  }

  async updateChain(chainId: string, updates: {
    tags?: string[];
    quality?: number;
    metadata?: Record<string, unknown>;
    status?: ChainStatus;
  }): Promise<void> {
    const db = await this.getDb();

    const setClauses: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (updates.tags !== undefined) {
      setClauses.push(`tags = $${paramIdx++}`);
      params.push(updates.tags);
    }
    if (updates.quality !== undefined) {
      setClauses.push(`quality = $${paramIdx++}`);
      params.push(updates.quality);
    }
    if (updates.metadata !== undefined) {
      setClauses.push(`metadata = $${paramIdx++}`);
      params.push(JSON.stringify(updates.metadata));
    }
    if (updates.status !== undefined) {
      setClauses.push(`status = $${paramIdx++}`);
      params.push(updates.status);
    }

    if (setClauses.length === 0) return;

    params.push(chainId);
    await db.query(
      `UPDATE reasoning_chains SET ${setClauses.join(", ")} WHERE id = $${paramIdx}`,
      params
    );

    await this.afterWrite();
  }

  async decayUnusedChains(olderThanDays: number, decayFactor: number): Promise<number> {
    const db = await this.getDb();

    // Decay quality for chains that haven't been recalled within olderThanDays.
    // Uses last_recalled_at if set, otherwise falls back to created_at.
    // Only affects active chains with quality > 0.05 (avoid decaying already-negligible chains).
    const result = await db.query<{ count: string }>(
      `WITH decayed AS (
         UPDATE reasoning_chains
         SET quality = GREATEST(0.05, COALESCE(quality, 1.0) * $1)
         WHERE COALESCE(status, 'active') = 'active'
           AND COALESCE(quality, 1.0) > 0.05
           AND COALESCE(last_recalled_at, created_at) < NOW() - INTERVAL '1 day' * $2
         RETURNING id
       )
       SELECT COUNT(*)::text AS count FROM decayed`,
      [decayFactor, olderThanDays]
    );

    const count = parseInt(result.rows[0]?.count ?? "0", 10);
    if (count > 0) await this.afterWrite();
    return count;
  }

  // ---- Drift: Stochastic Graph Walk ----

  async driftWalk(opts: DriftWalkOpts): Promise<DriftResult> {
    const db = await this.getDb();
    const steps = Math.min(Math.max(opts.steps ?? 5, 1), 20);
    const temperature = Math.min(Math.max(opts.temperature ?? 0.7, 0), 1);

    const walkSteps: DriftStep[] = [];
    const visited = new Set<string>();

    // Step 0: Select seed chain
    let seedId = opts.seedChainId;
    let seedWasRandom = !seedId;

    if (!seedId) {
      // Pick a random seed weighted by salience
      const seed = await this.getRandomChainBySalience(db, opts.project);
      if (!seed) {
        return { steps: [], seedWasRandom: true };
      }
      seedId = seed.id;
    }

    // Fetch the seed chain's details
    const seedChain = await this.getChainForDrift(db, seedId);
    if (!seedChain) {
      return { steps: [], seedWasRandom };
    }

    walkSteps.push(seedChain);
    visited.add(seedId);

    // Walk loop
    let currentId = seedId;
    for (let i = 1; i < steps; i++) {
      const nextStep = await this.driftStep(db, currentId, visited, temperature, opts.project);

      if (!nextStep) {
        // Dead end and teleport failed — end the walk
        break;
      }

      walkSteps.push(nextStep);
      visited.add(nextStep.chainId);
      currentId = nextStep.chainId;
    }

    return { steps: walkSteps, seedWasRandom };
  }

  /**
   * Select a random chain weighted by salience (recall_count + reference_count).
   * Uses a combination of quality, recency, and usage signals to bias toward "hot" chains.
   */
  private async getRandomChainBySalience(
    db: PGlite,
    project?: string,
  ): Promise<{ id: string } | null> {
    // Fetch top candidates by salience, then sample one stochastically.
    // We grab more candidates than needed to allow for randomness.
    let projectFilter = "";
    const params: any[] = [];
    let paramIdx = 1;

    if (project) {
      projectFilter = `AND rc.project = $${paramIdx++}`;
      params.push(project);
    }

    const result = await db.query<{
      id: string;
      salience_score: number;
    }>(
      `SELECT
         rc.id,
         (COALESCE(rc.quality, 1.0) * 0.4
           + LN(1 + COALESCE(rc.recall_count, 0) + COALESCE(rc.reference_count, 0) * 2) * 0.3
           + (1.0 / (1.0 + EXTRACT(EPOCH FROM (NOW() - rc.created_at)) / 86400.0 * 0.005)) * 0.3
         ) AS salience_score
       FROM reasoning_chains rc
       WHERE rc.embedding IS NOT NULL
         AND COALESCE(rc.status, 'active') = 'active'
         ${projectFilter}
       ORDER BY salience_score DESC
       LIMIT 20`,
      params
    );

    if (result.rows.length === 0) return null;

    // Softmax sample from the candidates
    const scores = result.rows.map((r) => r.salience_score);
    const idx = softmaxSample(scores, 0.8);
    return { id: result.rows[idx]!.id };
  }

  /**
   * Perform one step of the drift walk from the current node.
   * Follows graph edges stochastically, with teleportation fallback.
   */
  private async driftStep(
    db: PGlite,
    currentId: string,
    visited: Set<string>,
    temperature: number,
    project?: string,
  ): Promise<DriftStep | null> {
    // Get all graph neighbors (both directions)
    const neighbors = await db.query<{
      chain_id: string;
      relation_type: string;
      confidence: number | null;
      title: string;
      type: string;
      content: string;
      tags: string[];
      quality: number;
      recall_count: number;
      reference_count: number;
      created_at: string;
      project: string | null;
    }>(
      `SELECT
         rc.id AS chain_id,
         cr.relation_type,
         cr.confidence,
         rc.title,
         rc.type,
         rc.content,
         rc.tags,
         COALESCE(rc.quality, 1.0) AS quality,
         COALESCE(rc.recall_count, 0) AS recall_count,
         COALESCE(rc.reference_count, 0) AS reference_count,
         rc.created_at,
         rc.project
       FROM chain_relations cr
       JOIN reasoning_chains rc ON rc.id = cr.target_chain_id
       WHERE cr.source_chain_id = $1
         AND COALESCE(rc.status, 'active') = 'active'
         AND rc.embedding IS NOT NULL

       UNION ALL

       SELECT
         rc.id AS chain_id,
         cr.relation_type,
         cr.confidence,
         rc.title,
         rc.type,
         rc.content,
         rc.tags,
         COALESCE(rc.quality, 1.0) AS quality,
         COALESCE(rc.recall_count, 0) AS recall_count,
         COALESCE(rc.reference_count, 0) AS reference_count,
         rc.created_at,
         rc.project
       FROM chain_relations cr
       JOIN reasoning_chains rc ON rc.id = cr.source_chain_id
       WHERE cr.target_chain_id = $1
         AND COALESCE(rc.status, 'active') = 'active'
         AND rc.embedding IS NOT NULL`,
      [currentId]
    );

    // Filter out visited nodes and optionally filter by project
    let candidates = neighbors.rows.filter(
      (n) => !visited.has(n.chain_id) && (!project || n.project === project)
    );

    // Deduplicate (a chain could appear via multiple edges)
    const seen = new Set<string>();
    candidates = candidates.filter((c) => {
      if (seen.has(c.chain_id)) return false;
      seen.add(c.chain_id);
      return true;
    });

    if (candidates.length > 0) {
      // Score each candidate and sample
      const scores = candidates.map((c) => {
        const edgeConf = c.confidence ?? 0.5;
        const salience = Math.log(1 + c.recall_count + c.reference_count * 2);
        return edgeConf * c.quality * (1 + salience * 0.2);
      });

      const idx = softmaxSample(scores, temperature);
      const chosen = candidates[idx]!;

      return {
        chainId: chosen.chain_id,
        title: chosen.title,
        type: chosen.type as ReasoningType,
        content: chosen.content,
        tags: chosen.tags ?? [],
        quality: chosen.quality,
        relationFromPrevious: chosen.relation_type as RelationType,
        confidence: chosen.confidence ?? undefined,
        salience: Math.log(1 + chosen.recall_count + chosen.reference_count * 2),
        teleport: false,
        createdAt: chosen.created_at,
      };
    }

    // No unvisited graph neighbors — attempt teleportation
    // Find a moderately similar chain via embedding (loose association)
    return this.driftTeleport(db, currentId, visited, project);
  }

  /**
   * Teleportation: when the walk reaches a dead end (no unvisited graph neighbors),
   * find a chain with moderate embedding similarity (0.2-0.6 range) to simulate
   * a long-range neural association jump.
   */
  private async driftTeleport(
    db: PGlite,
    currentId: string,
    visited: Set<string>,
    project?: string,
  ): Promise<DriftStep | null> {
    // Get current chain's embedding
    const current = await db.query<{ embedding: string }>(
      `SELECT embedding::text FROM reasoning_chains WHERE id = $1`,
      [currentId]
    );

    if (current.rows.length === 0 || !current.rows[0]!.embedding) return null;

    const embeddingStr = current.rows[0]!.embedding;

    // Find chains in the moderate similarity range (0.2-0.6)
    // This is the "interesting but not obvious" zone — too similar = boring, too different = noise
    let projectFilter = "";
    const params: any[] = [embeddingStr];
    let paramIdx = 2;

    // Exclude visited chains
    const visitedArr = Array.from(visited);
    if (visitedArr.length > 0) {
      const placeholders = visitedArr.map((_, i) => `$${paramIdx + i}`).join(",");
      params.push(...visitedArr);
      paramIdx += visitedArr.length;
    }

    if (project) {
      projectFilter = `AND rc.project = $${paramIdx++}`;
      params.push(project);
    }

    const excludeClause = visitedArr.length > 0
      ? `AND rc.id NOT IN (${visitedArr.map((_, i) => `$${2 + i}`).join(",")})`
      : "";

    const result = await db.query<{
      id: string;
      title: string;
      type: string;
      content: string;
      tags: string[];
      quality: number;
      recall_count: number;
      reference_count: number;
      created_at: string;
      similarity: number;
    }>(
      `SELECT
         rc.id,
         rc.title,
         rc.type,
         rc.content,
         rc.tags,
         COALESCE(rc.quality, 1.0) AS quality,
         COALESCE(rc.recall_count, 0) AS recall_count,
         COALESCE(rc.reference_count, 0) AS reference_count,
         rc.created_at,
         1 - (rc.embedding <=> $1::vector) AS similarity
       FROM reasoning_chains rc
       WHERE rc.embedding IS NOT NULL
         AND COALESCE(rc.status, 'active') = 'active'
         AND 1 - (rc.embedding <=> $1::vector) BETWEEN 0.2 AND 0.6
         ${excludeClause}
         ${projectFilter}
       ORDER BY RANDOM()
       LIMIT 5`,
      params
    );

    if (result.rows.length === 0) return null;

    // Pick one at random from the candidates (already randomized by DB)
    const chosen = result.rows[0]!;

    return {
      chainId: chosen.id,
      title: chosen.title,
      type: chosen.type as ReasoningType,
      content: chosen.content,
      tags: chosen.tags ?? [],
      quality: chosen.quality,
      salience: Math.log(1 + chosen.recall_count + chosen.reference_count * 2),
      teleport: true,
      createdAt: chosen.created_at,
    };
  }

  /** Fetch a single chain's details for use as a drift step. */
  private async getChainForDrift(db: PGlite, chainId: string): Promise<DriftStep | null> {
    const result = await db.query<{
      id: string;
      title: string;
      type: string;
      content: string;
      tags: string[];
      quality: number;
      recall_count: number;
      reference_count: number;
      created_at: string;
    }>(
      `SELECT
         id, title, type, content, tags,
         COALESCE(quality, 1.0) AS quality,
         COALESCE(recall_count, 0) AS recall_count,
         COALESCE(reference_count, 0) AS reference_count,
         created_at
       FROM reasoning_chains
       WHERE id = $1`,
      [chainId]
    );

    if (result.rows.length === 0) return null;
    const r = result.rows[0]!;

    return {
      chainId: r.id,
      title: r.title,
      type: r.type as ReasoningType,
      content: r.content,
      tags: r.tags ?? [],
      quality: r.quality,
      salience: Math.log(1 + r.recall_count + r.reference_count * 2),
      teleport: false,
      createdAt: r.created_at,
    };
  }

  // ---- Spreading Activation ----

  async spreadActivation(opts: SpreadActivationOpts): Promise<ActivatedChain[]> {
    const db = await this.getDb();
    const hops = Math.min(Math.max(opts.hops ?? 2, 1), 3);
    const decayFactor = opts.decayFactor ?? 0.5;
    const minActivation = opts.minActivation ?? 0.1;
    const limit = opts.limit ?? 3;

    // Activation map: chainId → { activation, path, hops }
    const activationMap = new Map<string, {
      activation: number;
      path: string[];
      hopsFromSeed: number;
    }>();

    // Seed chains (these are the direct search results — we'll exclude them from output)
    const seedSet = new Set(opts.initialChainIds);

    // Initialize seeds
    for (let i = 0; i < opts.initialChainIds.length; i++) {
      const chainId = opts.initialChainIds[i]!;
      const score = opts.initialScores[i] ?? 0.5;
      activationMap.set(chainId, {
        activation: score,
        path: [chainId],
        hopsFromSeed: 0,
      });
    }

    // Spread activation hop by hop
    for (let hop = 0; hop < hops; hop++) {
      // Collect nodes to spread from at this hop level
      const toSpread: Array<{ chainId: string; activation: number; path: string[] }> = [];

      for (const [chainId, state] of activationMap) {
        if (state.hopsFromSeed === hop) {
          toSpread.push({ chainId, activation: state.activation, path: state.path });
        }
      }

      for (const source of toSpread) {
        // Get all neighbors via graph edges
        const neighbors = await db.query<{
          chain_id: string;
          confidence: number | null;
        }>(
          `SELECT rc.id AS chain_id, cr.confidence
           FROM chain_relations cr
           JOIN reasoning_chains rc ON rc.id = cr.target_chain_id
           WHERE cr.source_chain_id = $1
             AND COALESCE(rc.status, 'active') = 'active'
           UNION ALL
           SELECT rc.id AS chain_id, cr.confidence
           FROM chain_relations cr
           JOIN reasoning_chains rc ON rc.id = cr.source_chain_id
           WHERE cr.target_chain_id = $1
             AND COALESCE(rc.status, 'active') = 'active'`,
          [source.chainId]
        );

        for (const neighbor of neighbors.rows) {
          const edgeConf = neighbor.confidence ?? 0.5;
          const incomingActivation = source.activation * edgeConf * decayFactor;

          if (incomingActivation < minActivation) continue;

          const existing = activationMap.get(neighbor.chain_id);
          if (existing) {
            // Accumulate activation (a chain reached from multiple paths gets boosted)
            if (!seedSet.has(neighbor.chain_id)) {
              existing.activation += incomingActivation;
            }
          } else {
            activationMap.set(neighbor.chain_id, {
              activation: incomingActivation,
              path: [...source.path, neighbor.chain_id],
              hopsFromSeed: hop + 1,
            });
          }
        }
      }
    }

    // Collect non-seed activated chains above threshold
    const activated: Array<{
      chainId: string;
      activation: number;
      path: string[];
      hopsFromSeed: number;
    }> = [];

    for (const [chainId, state] of activationMap) {
      if (!seedSet.has(chainId) && state.activation >= minActivation) {
        activated.push({
          chainId,
          activation: state.activation,
          path: state.path,
          hopsFromSeed: state.hopsFromSeed,
        });
      }
    }

    // Sort by activation descending, take top-N
    activated.sort((a, b) => b.activation - a.activation);
    const topActivated = activated.slice(0, limit);

    if (topActivated.length === 0) return [];

    // Fetch chain details for the top activated chains
    const chainIds = topActivated.map((a) => a.chainId);
    const placeholders = chainIds.map((_, i) => `$${i + 1}`).join(",");

    const details = await db.query<{
      id: string;
      title: string;
      type: string;
      content: string;
      tags: string[];
      created_at: string;
    }>(
      `SELECT id, title, type, content, tags, created_at
       FROM reasoning_chains
       WHERE id IN (${placeholders})`,
      chainIds
    );

    const detailMap = new Map(details.rows.map((r) => [r.id, r]));

    return topActivated
      .map((a) => {
        const detail = detailMap.get(a.chainId);
        if (!detail) return null;
        return {
          chainId: a.chainId,
          title: detail.title,
          type: detail.type as ReasoningType,
          content: detail.content,
          tags: detail.tags ?? [],
          activation: a.activation,
          activationPath: a.path,
          hopsFromSeed: a.hopsFromSeed,
          createdAt: detail.created_at,
        };
      })
      .filter((x): x is ActivatedChain => x !== null);
  }
}

/**
 * Parse a pgvector text representation "[0.1,0.2,...]" back into a number array.
 * Validates that all elements are finite numbers.
 */
function parseVectorString(vecStr: string): number[] {
  // pgvector returns "[0.1,0.2,0.3,...]"
  const inner = vecStr.replace(/^\[/, "").replace(/\]$/, "");
  const values = inner.split(",").map(Number);
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      throw new Error(`Invalid vector element at index ${i}: '${inner.split(",")[i]}' is not a finite number`);
    }
  }
  return values;
}

/**
 * Softmax sampling with temperature.
 * Returns the index of the sampled element.
 *
 * - temperature = 0: always picks the highest score (greedy/argmax)
 * - temperature = 1: probabilities proportional to exp(score)
 * - temperature > 1: more uniform/random
 * - temperature < 1: more peaked toward highest scores
 */
function softmaxSample(scores: number[], temperature: number): number {
  if (scores.length === 0) return 0;
  if (scores.length === 1) return 0;

  // Greedy mode: return the index of the max score
  if (temperature <= 0.01) {
    let maxIdx = 0;
    for (let i = 1; i < scores.length; i++) {
      if (scores[i]! > scores[maxIdx]!) maxIdx = i;
    }
    return maxIdx;
  }

  // Scale scores by temperature and compute softmax
  const maxScore = Math.max(...scores);
  const exps = scores.map((s) => Math.exp((s - maxScore) / temperature));
  const sumExps = exps.reduce((a, b) => a + b, 0);
  const probs = exps.map((e) => e / sumExps);

  // Sample from the probability distribution
  const r = Math.random();
  let cumulative = 0;
  for (let i = 0; i < probs.length; i++) {
    cumulative += probs[i]!;
    if (r <= cumulative) return i;
  }

  // Fallback (floating point edge case)
  return probs.length - 1;
}
