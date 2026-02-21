import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { PGliteStorageProvider } from "./pglite.ts";

/** The fixed local user ID used by PGlite provider for all data */
const LOCAL_USER_ID = "00000000-0000-0000-0000-000000000000";

/**
 * End-to-end tests for PGlite storage provider.
 * Tests all CRUD operations and vector similarity search.
 * Uses an in-memory PGlite instance (no disk persistence needed for tests).
 */

// We need a custom instance that uses in-memory storage for tests.
// Override the initialize to use memory:// instead of a disk path.
class TestPGliteProvider extends PGliteStorageProvider {
  override async initialize(): Promise<void> {
    // Access private db field via any cast for testing
    const { PGlite } = await import("@electric-sql/pglite");
    const { vector } = await import("@electric-sql/pglite/vector");

    const db = await PGlite.create({
      extensions: { vector },
    });

    await db.exec("CREATE EXTENSION IF NOT EXISTS vector;");

    // Set the private db field
    (this as any).db = db;

    // Call schema init
    await (this as any).initSchema();
  }
}

describe("PGliteStorageProvider", () => {
  let provider: TestPGliteProvider;

  beforeAll(async () => {
    provider = new TestPGliteProvider();
    await provider.initialize();
  });

  afterAll(async () => {
    await provider.close();
  });

  test("mode is 'local'", () => {
    expect(provider.mode).toBe("local");
  });

  // ---- Sessions ----

  test("upsertSession creates a session", async () => {
    const id = await provider.upsertSession({
      id: "test-session-1",
      userId: LOCAL_USER_ID,
      tool: "opencode",
      project: "sessiongraph",
      startedAt: new Date("2026-02-19T10:00:00Z"),
      metadata: { foo: "bar" },
    });

    expect(id).toBe("test-session-1");
  });

  test("upsertSession updates an existing session", async () => {
    const id = await provider.upsertSession({
      id: "test-session-1",
      userId: LOCAL_USER_ID,
      tool: "opencode",
      project: "sessiongraph",
      startedAt: new Date("2026-02-19T10:00:00Z"),
      endedAt: new Date("2026-02-19T11:00:00Z"),
      summary: "Updated summary",
      metadata: { foo: "updated" },
    });

    expect(id).toBe("test-session-1");
  });

  test("listSessions returns sessions with chain counts", async () => {
    const sessions = await provider.listSessions({
      userId: LOCAL_USER_ID,
    });

    expect(sessions.length).toBe(1);
    expect(sessions[0]!.id).toBe("test-session-1");
    expect(sessions[0]!.tool).toBe("opencode");
    expect(sessions[0]!.chainCount).toBe(0);
  });

  test("listSessions filters by project", async () => {
    // Add another session with different project
    await provider.upsertSession({
      id: "test-session-2",
      userId: LOCAL_USER_ID,
      tool: "claude-code",
      project: "other-project",
      startedAt: new Date("2026-02-19T12:00:00Z"),
      metadata: {},
    });

    const filtered = await provider.listSessions({
      userId: LOCAL_USER_ID,
      project: "sessiongraph",
    });

    expect(filtered.length).toBe(1);
    expect(filtered[0]!.project).toBe("sessiongraph");
  });

  test("listSessions filters by tool", async () => {
    const filtered = await provider.listSessions({
      userId: LOCAL_USER_ID,
      tool: "claude-code",
    });

    expect(filtered.length).toBe(1);
    expect(filtered[0]!.tool).toBe("claude-code");
  });

  // ---- Reasoning Chains ----

  test("insertReasoningChain inserts a chain without embedding", async () => {
    const id = await provider.insertReasoningChain({
      sessionId: "test-session-1",
      userId: LOCAL_USER_ID,
      type: "decision",
      title: "Chose PGlite for local storage",
      content: "We chose PGlite over SQLite because pgvector works in PGlite.",
      tags: ["database", "architecture"],
    });

    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
  });

  test("insertReasoningChain inserts a chain with embedding", async () => {
    // Create a fake 768-dim embedding
    const embedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.1));

    const id = await provider.insertReasoningChain({
      sessionId: "test-session-1",
      userId: LOCAL_USER_ID,
      type: "insight",
      title: "PGlite supports pgvector",
      content: "PGlite has built-in support for the pgvector extension, enabling local vector search.",
      tags: ["database", "vector"],
      embedding,
    });

    expect(id).toBeTruthy();
  });

  test("insertReasoningChains batch inserts", async () => {
    const embedding1 = Array.from({ length: 1024 }, (_, i) => Math.cos(i * 0.1));
    const embedding2 = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.2));

    const ids = await provider.insertReasoningChains([
      {
        sessionId: "test-session-1",
        userId: LOCAL_USER_ID,
        type: "rejection",
        title: "Rejected SQLite for vector search",
        content: "SQLite has no production-quality vector search extension.",
        tags: ["database"],
        embedding: embedding1,
      },
      {
        sessionId: "test-session-2",
        userId: LOCAL_USER_ID,
        type: "solution",
        title: "Fixed embedding cost with built-in model",
        content: "Used Supabase gte-small instead of OpenAI for free embeddings.",
        tags: ["embeddings", "cost"],
        embedding: embedding2,
      },
    ]);

    expect(ids.length).toBe(2);
  });

  test("listSessions shows updated chain counts", async () => {
    const sessions = await provider.listSessions({ userId: LOCAL_USER_ID });
    const s1 = sessions.find((s) => s.id === "test-session-1");
    const s2 = sessions.find((s) => s.id === "test-session-2");

    expect(s1?.chainCount).toBe(3); // decision + insight + rejection
    expect(s2?.chainCount).toBe(1); // solution
  });

  // ---- Vector Search ----

  test("searchReasoning finds similar chains", async () => {
    // Query with a vector similar to the "PGlite supports pgvector" chain
    const queryEmbedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.1) + 0.01);

    const results = await provider.searchReasoning({
      queryEmbedding,
      userId: LOCAL_USER_ID,
      matchThreshold: 0.5,
      limit: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    // The most similar result should be the one with the closest embedding
    expect(results[0]!.similarity).toBeGreaterThan(0.9);
    expect(results[0]!.title).toBe("PGlite supports pgvector");
  });

  test("searchReasoning respects threshold", async () => {
    // Use a vector orthogonal/dissimilar to seeded ones — should match nothing at high threshold
    // Alternating +1/-1 pattern is dissimilar to sin/cos patterns
    const queryEmbedding = Array.from({ length: 1024 }, (_, i) => (i % 2 === 0 ? 1 : -1));

    const results = await provider.searchReasoning({
      queryEmbedding,
      userId: LOCAL_USER_ID,
      matchThreshold: 0.99,
      limit: 5,
    });

    expect(results.length).toBe(0);
  });

  test("searchReasoning filters by project", async () => {
    const queryEmbedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.2));

    const results = await provider.searchReasoning({
      queryEmbedding,
      userId: LOCAL_USER_ID,
      project: "other-project",
      matchThreshold: 0.3,
      limit: 10,
    });

    // Only chains from test-session-2 (other-project) should be returned
    for (const r of results) {
      expect(r.sessionId).toBe("test-session-2");
    }
  });

  // ---- Timeline ----

  test("getTimeline returns sessions with chains", async () => {
    const entries = await provider.getTimeline({
      userId: LOCAL_USER_ID,
      limit: 10,
    });

    expect(entries.length).toBe(2);
    // Most recent first
    expect(entries[0]!.tool).toBe("claude-code");
    expect(entries[1]!.tool).toBe("opencode");
    expect(entries[1]!.reasoningChains.length).toBe(3);
  });

  test("getTimeline filters by project", async () => {
    const entries = await provider.getTimeline({
      userId: LOCAL_USER_ID,
      project: "sessiongraph",
    });

    expect(entries.length).toBe(1);
    expect(entries[0]!.project).toBe("sessiongraph");
  });

  // ---- Session Chunks ----

  test("insertSessionChunks stores chunks", async () => {
    // Should not throw
    await provider.insertSessionChunks([
      {
        sessionId: "test-session-1",
        userId: LOCAL_USER_ID,
        role: "user",
        content: "Help me build a database",
        chunkIndex: 0,
      },
      {
        sessionId: "test-session-1",
        userId: LOCAL_USER_ID,
        role: "assistant",
        content: "I'll help you set up PGlite...",
        chunkIndex: 1,
      },
    ]);
  });

  // ---- Chain without session (remember tool) ----

  test("insertReasoningChain works without sessionId", async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.3));

    const id = await provider.insertReasoningChain({
      sessionId: null,
      userId: LOCAL_USER_ID,
      type: "exploration",
      title: "Exploring Ollama vs OpenAI for backfill",
      content: "Comparing Ollama (free, local) vs OpenAI (paid, cloud) for batch extraction.",
      tags: ["backfill", "embeddings"],
      embedding,
    });

    expect(id).toBeTruthy();

    // Should be findable via search (no session filter)
    const queryEmbedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.3) + 0.001);
    const results = await provider.searchReasoning({
      queryEmbedding,
      userId: LOCAL_USER_ID,
      matchThreshold: 0.9,
      limit: 1,
    });

    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("Exploring Ollama vs OpenAI for backfill");
  });
});
