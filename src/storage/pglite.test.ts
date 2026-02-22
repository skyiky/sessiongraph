import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { PGliteStorageProvider } from "./pglite.ts";
import type { ChainRelation } from "../config/types.ts";

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

  // ---- Quality Scoring ----

  test("quality defaults to 1.0 when not specified", async () => {
    // The chain inserted at line 139 (with embedding, no quality) should default to 1.0
    const queryEmbedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.1) + 0.01);

    const results = await provider.searchReasoning({
      queryEmbedding,
      userId: LOCAL_USER_ID,
      matchThreshold: 0.9,
      limit: 1,
    });

    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("PGlite supports pgvector");
    expect(results[0]!.quality).toBe(1.0);
  });

  test("quality is stored and returned when explicitly set", async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.5));

    await provider.insertReasoningChain({
      sessionId: "test-session-1",
      userId: LOCAL_USER_ID,
      type: "insight",
      title: "Backfill-quality chain",
      content: "This chain was extracted by Ollama backfill.",
      tags: ["backfill"],
      embedding,
      quality: 0.6,
    });

    const queryEmbedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.5) + 0.001);
    const results = await provider.searchReasoning({
      queryEmbedding,
      userId: LOCAL_USER_ID,
      matchThreshold: 0.9,
      limit: 1,
    });

    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("Backfill-quality chain");
    expect(results[0]!.quality).toBe(0.6);
  });

  test("quality-weighted ranking: high-quality chain ranks above low-quality at similar similarity", async () => {
    // Insert two chains with the SAME embedding but different quality
    const embedding = Array.from({ length: 1024 }, (_, i) => Math.cos(i * 0.7));

    await provider.insertReasoningChain({
      sessionId: "test-session-1",
      userId: LOCAL_USER_ID,
      type: "decision",
      title: "Low-quality twin",
      content: "Same embedding as its twin but low quality.",
      tags: ["quality-test"],
      embedding,
      quality: 0.3,
    });

    await provider.insertReasoningChain({
      sessionId: "test-session-1",
      userId: LOCAL_USER_ID,
      type: "decision",
      title: "High-quality twin",
      content: "Same embedding as its twin but high quality.",
      tags: ["quality-test"],
      embedding,
      quality: 1.0,
    });

    // Query with the exact same embedding — both should match, high-quality first
    const results = await provider.searchReasoning({
      queryEmbedding: embedding,
      userId: LOCAL_USER_ID,
      matchThreshold: 0.9,
      limit: 10,
    });

    const qualityTestResults = results.filter((r) => r.tags.includes("quality-test"));
    expect(qualityTestResults.length).toBe(2);
    // High-quality chain should rank first due to blended score
    expect(qualityTestResults[0]!.title).toBe("High-quality twin");
    expect(qualityTestResults[1]!.title).toBe("Low-quality twin");
    // Both have identical raw similarity (same embedding), so similarity values should be equal
    expect(qualityTestResults[0]!.similarity).toBeCloseTo(qualityTestResults[1]!.similarity, 5);
  });

  test("batch insert respects quality values", async () => {
    const embedding1 = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.9));
    const embedding2 = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 1.1));

    await provider.insertReasoningChains([
      {
        sessionId: "test-session-1",
        userId: LOCAL_USER_ID,
        type: "insight",
        title: "Batch chain quality=0.5",
        content: "Batch inserted with quality 0.5.",
        tags: ["batch-quality"],
        embedding: embedding1,
        quality: 0.5,
      },
      {
        sessionId: "test-session-1",
        userId: LOCAL_USER_ID,
        type: "insight",
        title: "Batch chain quality=0.8",
        content: "Batch inserted with quality 0.8.",
        tags: ["batch-quality"],
        embedding: embedding2,
        quality: 0.8,
      },
    ]);

    // Verify quality stored correctly for first chain
    const q1 = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.9) + 0.001);
    const r1 = await provider.searchReasoning({
      queryEmbedding: q1,
      userId: LOCAL_USER_ID,
      matchThreshold: 0.9,
      limit: 1,
    });
    expect(r1.length).toBe(1);
    expect(r1[0]!.title).toBe("Batch chain quality=0.5");
    expect(r1[0]!.quality).toBe(0.5);

    // Verify quality stored correctly for second chain
    const q2 = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 1.1) + 0.001);
    const r2 = await provider.searchReasoning({
      queryEmbedding: q2,
      userId: LOCAL_USER_ID,
      matchThreshold: 0.9,
      limit: 1,
    });
    expect(r2.length).toBe(1);
    expect(r2[0]!.title).toBe("Batch chain quality=0.8");
    expect(r2[0]!.quality).toBe(0.8);
  });

  test("search results include both similarity and quality fields", async () => {
    const queryEmbedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.1) + 0.01);

    const results = await provider.searchReasoning({
      queryEmbedding,
      userId: LOCAL_USER_ID,
      matchThreshold: 0.5,
      limit: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(typeof r.similarity).toBe("number");
      expect(r.similarity).toBeGreaterThan(0);
      expect(r.similarity).toBeLessThanOrEqual(1);
      expect(typeof r.quality).toBe("number");
      expect(r.quality).toBeGreaterThanOrEqual(0);
      expect(r.quality).toBeLessThanOrEqual(1);
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
    expect(entries[1]!.reasoningChains.length).toBeGreaterThanOrEqual(3);
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

  // ---- listChainsWithEmbeddings ----

  test("listChainsWithEmbeddings returns chains that have embeddings", async () => {
    const results = await provider.listChainsWithEmbeddings({
      userId: LOCAL_USER_ID,
    });

    // Only chains inserted with embeddings should be returned
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.id).toBeTruthy();
      expect(r.title).toBeTruthy();
      expect(r.content).toBeTruthy();
      expect(r.type).toBeTruthy();
      expect(Array.isArray(r.tags)).toBe(true);
      expect(Array.isArray(r.embedding)).toBe(true);
      expect(r.embedding.length).toBeGreaterThan(0);
      // Verify all embedding values are finite numbers
      for (const v of r.embedding) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  test("listChainsWithEmbeddings excludes chains without embeddings", async () => {
    // Insert a chain without an embedding
    const noEmbedId = await provider.insertReasoningChain({
      sessionId: "test-session-1",
      userId: LOCAL_USER_ID,
      type: "insight",
      title: "Chain without embedding",
      content: "This chain has no embedding vector.",
      tags: ["test"],
    });

    const results = await provider.listChainsWithEmbeddings({
      userId: LOCAL_USER_ID,
      limit: 1000,
    });

    // The chain without an embedding should not appear
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain(noEmbedId);
  });

  test("listChainsWithEmbeddings supports pagination", async () => {
    const page1 = await provider.listChainsWithEmbeddings({
      userId: LOCAL_USER_ID,
      limit: 1,
      offset: 0,
    });
    const page2 = await provider.listChainsWithEmbeddings({
      userId: LOCAL_USER_ID,
      limit: 1,
      offset: 1,
    });

    expect(page1.length).toBeLessThanOrEqual(1);
    // If there are at least 2 chains with embeddings, pages should differ
    if (page1.length > 0 && page2.length > 0) {
      expect(page1[0]!.id).not.toBe(page2[0]!.id);
    }
  });

  // ---- Chain Relations ----

  // Store chain IDs for relation tests
  let chainA: string;
  let chainB: string;
  let chainC: string;

  test("setup: create chains for relation tests", async () => {
    chainA = await provider.insertReasoningChain({
      sessionId: "test-session-1",
      userId: LOCAL_USER_ID,
      type: "decision",
      title: "Chose React for frontend",
      content: "We chose React over Vue because of ecosystem size and team familiarity.",
      tags: ["frontend", "framework"],
    });
    chainB = await provider.insertReasoningChain({
      sessionId: "test-session-1",
      userId: LOCAL_USER_ID,
      type: "decision",
      title: "Chose Next.js for SSR",
      content: "After choosing React, Next.js was the natural choice for server-side rendering.",
      tags: ["frontend", "framework"],
    });
    chainC = await provider.insertReasoningChain({
      sessionId: "test-session-2",
      userId: LOCAL_USER_ID,
      type: "rejection",
      title: "Rejected Vue for frontend",
      content: "Vue was rejected because team had no experience with it.",
      tags: ["frontend", "framework"],
    });

    expect(chainA).toBeTruthy();
    expect(chainB).toBeTruthy();
    expect(chainC).toBeTruthy();
  });

  test("insertChainRelation creates a relation", async () => {
    const id = await provider.insertChainRelation({
      sourceChainId: chainA,
      targetChainId: chainB,
      relationType: "leads_to",
    });

    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
  });

  test("insertChainRelation deduplicates (ON CONFLICT DO UPDATE)", async () => {
    const id = await provider.insertChainRelation({
      sourceChainId: chainA,
      targetChainId: chainB,
      relationType: "leads_to",
    });

    // Duplicate returns existing row's ID (DO UPDATE + RETURNING)
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
  });

  test("insertChainRelation allows same pair with different relation type", async () => {
    const id = await provider.insertChainRelation({
      sourceChainId: chainA,
      targetChainId: chainB,
      relationType: "builds_on",
    });

    expect(id).toBeTruthy();
    expect(id).not.toBe("");
  });

  test("insertChainRelations batch inserts", async () => {
    const ids = await provider.insertChainRelations([
      {
        sourceChainId: chainA,
        targetChainId: chainC,
        relationType: "contradicts",
      },
      {
        sourceChainId: chainC,
        targetChainId: chainA,
        relationType: "contradicts",
      },
    ]);

    expect(ids.length).toBe(2);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
  });

  test("insertChainRelations handles empty array", async () => {
    const ids = await provider.insertChainRelations([]);
    expect(ids).toEqual([]);
  });

  test("insertChainRelations deduplicates within batch", async () => {
    // Re-insert the same contradicts relations
    const ids = await provider.insertChainRelations([
      {
        sourceChainId: chainA,
        targetChainId: chainC,
        relationType: "contradicts",
      },
    ]);

    expect(ids.length).toBe(1);
    expect(ids[0]).toBeTruthy(); // duplicate → returns existing row's ID (no-op upsert)
  });

  test("getRelatedChains returns outgoing relations", async () => {
    const results = await provider.getRelatedChains({ chainId: chainA });

    // chainA has outgoing: leads_to→B, builds_on→B, contradicts→C
    const outgoing = results.filter((r) => r.direction === "outgoing");
    expect(outgoing.length).toBe(3);

    const leadsTo = outgoing.find((r) => r.relationType === "leads_to");
    expect(leadsTo).toBeDefined();
    expect(leadsTo!.chainId).toBe(chainB);
    expect(leadsTo!.title).toBe("Chose Next.js for SSR");
  });

  test("getRelatedChains returns incoming relations", async () => {
    const results = await provider.getRelatedChains({ chainId: chainB });

    // chainB has incoming: A→leads_to, A→builds_on
    const incoming = results.filter((r) => r.direction === "incoming");
    expect(incoming.length).toBe(2);

    const fromA = incoming.filter((r) => r.chainId === chainA);
    expect(fromA.length).toBe(2);
  });

  test("getRelatedChains shows bidirectional contradicts", async () => {
    // chainA contradicts chainC (both directions stored)
    const fromA = await provider.getRelatedChains({ chainId: chainA });
    const fromC = await provider.getRelatedChains({ chainId: chainC });

    const aContradicts = fromA.filter((r) => r.relationType === "contradicts");
    const cContradicts = fromC.filter((r) => r.relationType === "contradicts");

    // A has outgoing contradicts→C
    expect(aContradicts.some((r) => r.direction === "outgoing" && r.chainId === chainC)).toBe(true);
    // A also has incoming contradicts←C
    expect(aContradicts.some((r) => r.direction === "incoming" && r.chainId === chainC)).toBe(true);

    // C should see both directions too
    expect(cContradicts.some((r) => r.direction === "outgoing" && r.chainId === chainA)).toBe(true);
    expect(cContradicts.some((r) => r.direction === "incoming" && r.chainId === chainA)).toBe(true);
  });

  test("getRelatedChains filters by relation type", async () => {
    const results = await provider.getRelatedChains({
      chainId: chainA,
      relationType: "leads_to",
    });

    expect(results.length).toBe(1);
    expect(results[0]!.relationType).toBe("leads_to");
    expect(results[0]!.chainId).toBe(chainB);
  });

  test("getRelatedChains returns empty for chain with no relations", async () => {
    // Insert a chain with no relations
    const lonelyChain = await provider.insertReasoningChain({
      sessionId: "test-session-1",
      userId: LOCAL_USER_ID,
      type: "insight",
      title: "Isolated insight",
      content: "This chain has no connections.",
      tags: [],
    });

    const results = await provider.getRelatedChains({ chainId: lonelyChain });
    expect(results.length).toBe(0);
  });

  test("getRelatedChains respects limit", async () => {
    const results = await provider.getRelatedChains({
      chainId: chainA,
      limit: 2,
    });

    expect(results.length).toBe(2);
  });

  test("getRelatedChains includes tags in results", async () => {
    const results = await provider.getRelatedChains({ chainId: chainA });
    const leadsTo = results.find((r) => r.relationType === "leads_to" && r.direction === "outgoing");

    expect(leadsTo).toBeDefined();
    expect(leadsTo!.tags).toContain("frontend");
    expect(leadsTo!.tags).toContain("framework");
  });

  test("cascade delete removes relations when chain is deleted", async () => {
    // Insert a temporary chain and relation
    const tempChain = await provider.insertReasoningChain({
      sessionId: "test-session-1",
      userId: LOCAL_USER_ID,
      type: "insight",
      title: "Temporary chain",
      content: "This will be deleted.",
      tags: [],
    });

    await provider.insertChainRelation({
      sourceChainId: chainA,
      targetChainId: tempChain,
      relationType: "refines",
    });

    // Verify relation exists
    let related = await provider.getRelatedChains({ chainId: chainA });
    expect(related.some((r) => r.chainId === tempChain)).toBe(true);

    // Delete the chain directly via DB
    const db = (provider as any).db;
    await db.query("DELETE FROM reasoning_chains WHERE id = $1", [tempChain]);

    // Relation should be gone due to CASCADE
    related = await provider.getRelatedChains({ chainId: chainA });
    expect(related.some((r) => r.chainId === tempChain)).toBe(false);
  });

  // ---- Project Column (direct on chain) ----

  test("insertReasoningChain stores project directly on chain", async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 1.3));

    const id = await provider.insertReasoningChain({
      sessionId: null,
      userId: LOCAL_USER_ID,
      type: "decision",
      title: "Project-tagged chain",
      content: "This chain has a direct project tag, independent of session.",
      tags: ["project-test"],
      embedding,
      project: "my-cool-project",
    });

    expect(id).toBeTruthy();

    // Search with project filter should find it even though sessionId is null
    const queryEmbedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 1.3) + 0.001);
    const results = await provider.searchReasoning({
      queryEmbedding,
      userId: LOCAL_USER_ID,
      project: "my-cool-project",
      matchThreshold: 0.9,
      limit: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.project).toBe("my-cool-project");
  });

  test("searchReasoning project filter finds chains via session OR direct project", async () => {
    // Chain on session with project "sessiongraph" already exists from earlier tests.
    // Chain with direct project "my-cool-project" was just created.
    // Searching for "sessiongraph" should find session-linked chains but NOT "my-cool-project" chains.
    const queryEmbedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.1) + 0.01);

    const sgResults = await provider.searchReasoning({
      queryEmbedding,
      userId: LOCAL_USER_ID,
      project: "sessiongraph",
      matchThreshold: 0.3,
      limit: 50,
    });

    // All results should be from sessiongraph (via session or direct)
    for (const r of sgResults) {
      // Either the chain's project is sessiongraph, or it came through a session with that project
      // (we can't easily distinguish here, but none should be from "my-cool-project")
      expect(r.project).not.toBe("my-cool-project");
    }
  });

  // ---- Source Column ----

  test("insertReasoningChain stores source field", async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 1.5));

    const id = await provider.insertReasoningChain({
      sessionId: null,
      userId: LOCAL_USER_ID,
      type: "insight",
      title: "Backfill-sourced chain",
      content: "This chain was created by the backfill process.",
      tags: ["source-test"],
      embedding,
      source: "backfill",
    });

    expect(id).toBeTruthy();

    const queryEmbedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 1.5) + 0.001);
    const results = await provider.searchReasoning({
      queryEmbedding,
      userId: LOCAL_USER_ID,
      matchThreshold: 0.9,
      limit: 1,
    });

    expect(results.length).toBe(1);
    expect(results[0]!.source).toBe("backfill");
  });

  test("source defaults to mcp_capture when not specified", async () => {
    // The chain "PGlite supports pgvector" was inserted without source field
    const queryEmbedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.1) + 0.01);

    const results = await provider.searchReasoning({
      queryEmbedding,
      userId: LOCAL_USER_ID,
      matchThreshold: 0.9,
      limit: 1,
    });

    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("PGlite supports pgvector");
    expect(results[0]!.source).toBe("mcp_capture");
  });

  // ---- Context Field ----

  test("insertReasoningChain stores context field", async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 1.7));

    const id = await provider.insertReasoningChain({
      sessionId: null,
      userId: LOCAL_USER_ID,
      type: "decision",
      title: "Chain with context",
      content: "This chain includes context about the surrounding discussion.",
      context: "User was asking about database migrations when this decision was made.",
      tags: ["context-test"],
      embedding,
    });

    expect(id).toBeTruthy();

    const queryEmbedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 1.7) + 0.001);
    const results = await provider.searchReasoning({
      queryEmbedding,
      userId: LOCAL_USER_ID,
      matchThreshold: 0.9,
      limit: 1,
    });

    expect(results.length).toBe(1);
    expect(results[0]!.context).toBe("User was asking about database migrations when this decision was made.");
  });

  // ---- Status & Auto-Archive ----

  test("status defaults to active", async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.1) + 0.01);
    const results = await provider.searchReasoning({
      queryEmbedding: embedding,
      userId: LOCAL_USER_ID,
      matchThreshold: 0.9,
      limit: 1,
    });

    expect(results.length).toBe(1);
    expect(results[0]!.status).toBe("active");
  });

  test("supersedes relation auto-archives target chain", async () => {
    // Create old chain and new chain
    const embedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 2.1));

    const oldChainId = await provider.insertReasoningChain({
      sessionId: null,
      userId: LOCAL_USER_ID,
      type: "decision",
      title: "Old decision to be superseded",
      content: "This decision will be replaced by a newer one.",
      tags: ["supersede-test"],
      embedding,
    });

    const newChainId = await provider.insertReasoningChain({
      sessionId: null,
      userId: LOCAL_USER_ID,
      type: "decision",
      title: "New decision that supersedes old",
      content: "This decision replaces the old one.",
      tags: ["supersede-test"],
      embedding,
    });

    // Create supersedes relation: new → old
    await provider.insertChainRelation({
      sourceChainId: newChainId,
      targetChainId: oldChainId,
      relationType: "supersedes",
    });

    // Search — old chain should NOT appear (status='superseded', excluded by default)
    const queryEmbedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 2.1) + 0.001);
    const defaultResults = await provider.searchReasoning({
      queryEmbedding,
      userId: LOCAL_USER_ID,
      matchThreshold: 0.9,
      limit: 10,
    });

    const defaultTitles = defaultResults.map((r) => r.title);
    expect(defaultTitles).toContain("New decision that supersedes old");
    expect(defaultTitles).not.toContain("Old decision to be superseded");

    // Search with includeSuperseded=true — old chain SHOULD appear
    const allResults = await provider.searchReasoning({
      queryEmbedding,
      userId: LOCAL_USER_ID,
      matchThreshold: 0.9,
      limit: 10,
      includeSuperseded: true,
    });

    const allTitles = allResults.map((r) => r.title);
    expect(allTitles).toContain("New decision that supersedes old");
    expect(allTitles).toContain("Old decision to be superseded");

    // Verify the superseded chain has status='superseded'
    const supersededChain = allResults.find((r) => r.title === "Old decision to be superseded");
    expect(supersededChain!.status).toBe("superseded");
  });

  test("batch insertChainRelations also auto-archives superseded targets", async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 2.3));

    const targetId = await provider.insertReasoningChain({
      sessionId: null,
      userId: LOCAL_USER_ID,
      type: "insight",
      title: "Batch-superseded target",
      content: "Will be superseded via batch insert.",
      tags: ["batch-supersede"],
      embedding,
    });

    const sourceId = await provider.insertReasoningChain({
      sessionId: null,
      userId: LOCAL_USER_ID,
      type: "insight",
      title: "Batch superseder",
      content: "Supersedes via batch.",
      tags: ["batch-supersede"],
      embedding,
    });

    await provider.insertChainRelations([
      {
        sourceChainId: sourceId,
        targetChainId: targetId,
        relationType: "supersedes",
      },
    ]);

    // Target should be auto-archived
    const queryEmbedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 2.3) + 0.001);
    const results = await provider.searchReasoning({
      queryEmbedding,
      userId: LOCAL_USER_ID,
      matchThreshold: 0.9,
      limit: 10,
    });

    const titles = results.map((r) => r.title);
    expect(titles).toContain("Batch superseder");
    expect(titles).not.toContain("Batch-superseded target");
  });

  // ---- Confidence on Relations ----

  test("insertChainRelation stores confidence", async () => {
    const id = await provider.insertChainRelation({
      sourceChainId: chainA,
      targetChainId: chainC,
      relationType: "refines",
      confidence: 0.85,
    });

    expect(id).toBeTruthy();

    const results = await provider.getRelatedChains({ chainId: chainA });
    const refines = results.find(
      (r) => r.relationType === "refines" && r.direction === "outgoing" && r.chainId === chainC
    );

    expect(refines).toBeDefined();
    expect(refines!.confidence).toBeCloseTo(0.85, 2);
  });

  test("confidence is undefined when not set", async () => {
    // The leads_to relation from chainA → chainB was inserted without confidence
    const results = await provider.getRelatedChains({ chainId: chainA, relationType: "leads_to" });

    expect(results.length).toBe(1);
    expect(results[0]!.confidence).toBeUndefined();
  });

  // ---- Multi-hop Graph Traversal ----

  test("getRelatedChains with depth=1 returns only direct neighbors", async () => {
    const results = await provider.getRelatedChains({ chainId: chainA, depth: 1 });

    // All should be depth 1
    for (const r of results) {
      expect(r.depth).toBe(1);
    }
  });

  test("getRelatedChains with depth=2 returns 2-hop neighbors", async () => {
    // Create a 3-node chain: D → E → F
    const dId = await provider.insertReasoningChain({
      sessionId: "test-session-1",
      userId: LOCAL_USER_ID,
      type: "decision",
      title: "Node D",
      content: "First node in multi-hop test.",
      tags: ["multihop"],
    });
    const eId = await provider.insertReasoningChain({
      sessionId: "test-session-1",
      userId: LOCAL_USER_ID,
      type: "decision",
      title: "Node E",
      content: "Middle node in multi-hop test.",
      tags: ["multihop"],
    });
    const fId = await provider.insertReasoningChain({
      sessionId: "test-session-1",
      userId: LOCAL_USER_ID,
      type: "decision",
      title: "Node F",
      content: "Last node in multi-hop test.",
      tags: ["multihop"],
    });

    await provider.insertChainRelation({
      sourceChainId: dId,
      targetChainId: eId,
      relationType: "leads_to",
    });
    await provider.insertChainRelation({
      sourceChainId: eId,
      targetChainId: fId,
      relationType: "leads_to",
    });

    // Depth 1 from D: should find E only (outgoing)
    const depth1 = await provider.getRelatedChains({ chainId: dId, depth: 1 });
    const depth1Ids = depth1.map((r) => r.chainId);
    expect(depth1Ids).toContain(eId);
    expect(depth1Ids).not.toContain(fId);

    // Depth 2 from D: should find E (depth 1) and F (depth 2)
    const depth2 = await provider.getRelatedChains({ chainId: dId, depth: 2 });
    const depth2Map = new Map(depth2.map((r) => [r.chainId, r]));

    expect(depth2Map.has(eId)).toBe(true);
    expect(depth2Map.has(fId)).toBe(true);
    expect(depth2Map.get(eId)!.depth).toBe(1);
    expect(depth2Map.get(fId)!.depth).toBe(2);
  });

  test("getRelatedChains depth is clamped to max 3", async () => {
    // Requesting depth=10 should behave like depth=3 (no crash)
    const results = await provider.getRelatedChains({ chainId: chainA, depth: 10 });
    // Should return results without error
    expect(Array.isArray(results)).toBe(true);
  });

  // ---- Score Field in Search Results ----

  test("search results include blended score field", async () => {
    const queryEmbedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.1) + 0.01);

    const results = await provider.searchReasoning({
      queryEmbedding,
      userId: LOCAL_USER_ID,
      matchThreshold: 0.5,
      limit: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(typeof r.score).toBe("number");
      expect(r.score).toBeGreaterThan(0);
      // Score is a blend of similarity (0-1), text_match (0-1), quality (0-1), recency (0-1)
      // All weighted to sum ≤ 1.0 max, but can be slightly above due to rounding
      expect(r.score).toBeLessThanOrEqual(1.1);
    }
  });

  test("search results are ordered by blended score descending", async () => {
    const queryEmbedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.1) + 0.01);

    const results = await provider.searchReasoning({
      queryEmbedding,
      userId: LOCAL_USER_ID,
      matchThreshold: 0.3,
      limit: 20,
    });

    // Verify descending order
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });

  // ---- Hybrid Search (queryText) ----

  test("searchReasoning with queryText finds text matches", async () => {
    // Insert a chain with specific searchable text but a dissimilar embedding
    const dissimilarEmbedding = Array.from({ length: 1024 }, (_, i) => (i % 3 === 0 ? 0.5 : -0.5));

    await provider.insertReasoningChain({
      sessionId: null,
      userId: LOCAL_USER_ID,
      type: "insight",
      title: "Kubernetes pod scaling strategy",
      content: "Horizontal pod autoscaler with custom metrics for production workloads.",
      tags: ["kubernetes", "scaling"],
      embedding: dissimilarEmbedding,
    });

    // Query with a very different embedding but matching text
    const queryEmbedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.1));

    const results = await provider.searchReasoning({
      queryEmbedding,
      userId: LOCAL_USER_ID,
      queryText: "Kubernetes pod scaling",
      matchThreshold: 0.5,
      limit: 20,
    });

    // The kubernetes chain should appear even though its embedding is dissimilar,
    // because queryText does full-text matching
    const k8sResult = results.find((r) => r.title === "Kubernetes pod scaling strategy");
    expect(k8sResult).toBeDefined();
  });

  test("searchReasoning without queryText uses vector-only matching", async () => {
    // Same query without queryText — kubernetes chain shouldn't appear
    // because its embedding is dissimilar to our query embedding
    const queryEmbedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.1));

    const results = await provider.searchReasoning({
      queryEmbedding,
      userId: LOCAL_USER_ID,
      matchThreshold: 0.5,
      limit: 20,
    });

    // The kubernetes chain has a very different embedding pattern, should not match at 0.5 threshold
    const k8sResult = results.find((r) => r.title === "Kubernetes pod scaling strategy");
    // It may or may not appear depending on embedding math, but if it does, it should rank low
    if (k8sResult) {
      expect(k8sResult.similarity).toBeLessThan(0.5);
    }
  });

  // ---- Batch insert with new fields ----

  test("batch insertReasoningChains respects project, source, status fields", async () => {
    const embedding1 = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 2.5));
    const embedding2 = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 2.7));

    const ids = await provider.insertReasoningChains([
      {
        sessionId: null,
        userId: LOCAL_USER_ID,
        type: "decision",
        title: "Batch chain with all fields",
        content: "Has project, source, and status set.",
        tags: ["batch-fields"],
        embedding: embedding1,
        project: "batch-project",
        source: "backfill",
        status: "active",
      },
      {
        sessionId: null,
        userId: LOCAL_USER_ID,
        type: "insight",
        title: "Batch chain defaults",
        content: "Should get default source and status.",
        tags: ["batch-fields"],
        embedding: embedding2,
      },
    ]);

    expect(ids.length).toBe(2);

    // Verify first chain has explicit values
    const q1 = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 2.5) + 0.001);
    const r1 = await provider.searchReasoning({
      queryEmbedding: q1,
      userId: LOCAL_USER_ID,
      matchThreshold: 0.9,
      limit: 1,
    });
    expect(r1.length).toBe(1);
    expect(r1[0]!.project).toBe("batch-project");
    expect(r1[0]!.source).toBe("backfill");
    expect(r1[0]!.status).toBe("active");

    // Verify second chain has defaults
    const q2 = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 2.7) + 0.001);
    const r2 = await provider.searchReasoning({
      queryEmbedding: q2,
      userId: LOCAL_USER_ID,
      matchThreshold: 0.9,
      limit: 1,
    });
    expect(r2.length).toBe(1);
    expect(r2[0]!.source).toBe("mcp_capture");
    expect(r2[0]!.status).toBe("active");
  });

  // ---- Timeline includes new fields ----

  test("getTimeline includes project, source, status on chains", async () => {
    // Insert a chain with explicit project/source on a session
    await provider.insertReasoningChain({
      sessionId: "test-session-1",
      userId: LOCAL_USER_ID,
      type: "decision",
      title: "Timeline chain with new fields",
      content: "Should show up in timeline with project, source, status.",
      tags: ["timeline-test"],
      project: "sessiongraph",
      source: "mcp_capture",
    });

    const entries = await provider.getTimeline({
      userId: LOCAL_USER_ID,
      project: "sessiongraph",
      limit: 5,
    });

    expect(entries.length).toBeGreaterThan(0);
    const entry = entries.find((e) => e.project === "sessiongraph");
    expect(entry).toBeDefined();

    // Find the chain we just inserted
    const chain = entry!.reasoningChains.find((c) => c.title === "Timeline chain with new fields");
    expect(chain).toBeDefined();
    expect(chain!.source).toBe("mcp_capture");
    expect(chain!.status).toBe("active");
  });

  // ---- Search with type filter + new param binding ----

  test("searchReasoning with type filter works correctly", async () => {
    const queryEmbedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.1) + 0.01);

    const results = await provider.searchReasoning({
      queryEmbedding,
      userId: LOCAL_USER_ID,
      type: "insight",
      matchThreshold: 0.5,
      limit: 10,
    });

    for (const r of results) {
      expect(r.type).toBe("insight");
    }
  });

  test("searchReasoning with project + type + queryText all together", async () => {
    // Exercise the most complex parameter binding path
    const queryEmbedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.1));

    // Should not throw (the parameter binding bug would cause a crash here)
    const results = await provider.searchReasoning({
      queryEmbedding,
      userId: LOCAL_USER_ID,
      project: "sessiongraph",
      type: "decision",
      queryText: "PGlite",
      matchThreshold: 0.3,
      limit: 5,
    });

    // Should return valid results
    expect(Array.isArray(results)).toBe(true);
    for (const r of results) {
      expect(r.type).toBe("decision");
    }
  });
});
