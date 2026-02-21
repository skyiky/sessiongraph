# SessionGraph

Captures reasoning chains from AI coding sessions and makes them semantically searchable. Git saves code; SessionGraph saves the *why*.

## Tech Stack

- **Runtime:** Bun + TypeScript
- **Local DB:** PGlite (embedded Postgres + pgvector) at `~/.sessiongraph/pglite/`
- **Cloud DB:** Supabase (hosted Postgres + pgvector)
- **Local embeddings:** Ollama `qwen3-embedding:0.6b` (1024 dims)
- **Local extraction:** Ollama `qwen2.5:3b` (backfill only)
- **MCP:** `@modelcontextprotocol/sdk` (stdio transport)
- **Web dashboard:** Next.js 15, Tailwind CSS v4, shadcn/ui (in `web/`, separate app)

## Architecture

Two storage modes, same interface:

| Mode | Database | Embeddings | Account |
|------|----------|------------|---------|
| Local (default) | PGlite | Ollama | No |
| Cloud | Supabase | Supabase Edge Functions | Yes |

### Provider pattern

`StorageProvider` interface (`src/storage/provider.ts`) — both `PGliteStorageProvider` and `SupabaseStorageProvider` implement it. `getStorageProvider()` is a singleton factory with a pending-promise guard for concurrent callers.

`EmbeddingProvider` interface — `OllamaEmbeddingProvider` (local) and `SupabaseEmbeddingProvider` (cloud).

### Data flow

**Real-time capture:** AI agent runs → auto-reasoning-capture skill silently calls `remember` → MCP server embeds text via Ollama → stores chain + vector in PGlite.

**Backfill:** CLI parses old sessions → Ollama `qwen2.5:3b` extracts reasoning chains → Ollama `qwen3-embedding:0.6b` embeds them → stores in PGlite.

**Search:** User or agent calls `recall` → query embedded via Ollama → pgvector cosine similarity search → returns matching chains.

### Reasoning graph

Chains connect via `chain_relations` table with 8 relation types: `leads_to`, `supersedes`, `contradicts`, `builds_on`, `depends_on`, `refines`, `generalizes`, `analogous_to`. Bidirectional relations (`contradicts`, `analogous_to`) are stored in both directions automatically.

## Project Structure

```
src/
├── index.ts              # CLI entry point (Commander)
├── auth/auth.ts          # Supabase auth, credential storage (0o600 perms)
├── backfill/
│   ├── backfill.ts       # Backfill orchestrator (periodic state saves, graceful shutdown)
│   ├── linker.ts         # Auto-linker: discovers chain relations via embedding similarity
│   └── ollama-extractor.ts  # Extracts reasoning chains from session text via Ollama
├── config/
│   ├── config.ts         # Config factory, paths, ensureDataDir
│   └── types.ts          # All TypeScript types, RELATION_TYPES, BIDIRECTIONAL_RELATIONS
├── embeddings/
│   ├── ollama.ts         # OllamaEmbeddingProvider
│   └── supabase.ts       # SupabaseEmbeddingProvider
├── ingestion/parsers/
│   ├── opencode.ts       # Parses OpenCode SQLite DB (shared read-only connection)
│   └── claude-code.ts    # Parses Claude Code JSONL sessions (cached history.jsonl)
├── mcp/server.ts         # MCP server (7 tools: remember, recall, timeline, sessions, graph, get_sessions_to_backfill, mark_session_backfilled)
├── storage/
│   ├── provider.ts       # StorageProvider + EmbeddingProvider interfaces, singleton factories
│   ├── pglite.ts         # PGliteStorageProvider (local, lazy init)
│   ├── supabase-provider.ts  # SupabaseStorageProvider (cloud)
│   ├── sync.ts           # Local → cloud sync
│   └── buffer.ts         # Offline write buffer (SQLite, retry with backoff)
├── capture/              # Real-time capture utilities
└── cli/                  # CLI subcommands (init wizard, detect tools)

skills/
├── auto-reasoning-capture/SKILL.md  # Skill for AI agents to capture reasoning in real-time
└── backfill/SKILL.md               # Skill for agent-driven backfill

web/                      # Separate Next.js dashboard app (has its own tsconfig)
docs/
```

## Key Decisions

**PGlite over SQLite (local storage):** pgvector extension works in PGlite, enabling semantic search locally without cloud. SQLite has no production-quality vector search. PGlite speaks the same Postgres SQL as Supabase, so the upgrade path is clean.

**Real-time capture over post-hoc extraction:** The AI agent making the decision has perfect context. No regex or LLM post-processing can match that quality. The auto-reasoning skill is the primary capture path. Backfill via Ollama is "good enough" for filling the search index retroactively.

**Ollama over API keys for backfill:** Backfilling 200 sessions via GPT-4 would cost $10-30. Ollama is free. `qwen2.5:3b` with `format: "json"` produces structured chains at ~20 tok/s on a 4GB VRAM GPU.

**Embedding model choice:** Started with `all-minilm` (384 dims), tried `nomic-embed-text` (768 dims), settled on `qwen3-embedding:0.6b` (1024 dims) for best quality-to-size ratio at 639MB.

**One database for all projects:** PGlite stores everything in `~/.sessiongraph/pglite/`. Cross-project search is a key differentiator — "has anyone solved this before?" works across all your repos.

**Removed legacy extractors:** `extractReasoningChains()` (LLM-based, required OpenAI key) and `extractReasoningChainsSimple()` (regex-based) both produced mediocre output. Deleted in favor of real-time capture + Ollama backfill.

## Conventions

- **Error handling:** `catch (err: unknown)` not `catch (err: any)`. Use `err instanceof Error ? err.message : String(err)`.
- **Singleton providers:** Always go through `getStorageProvider()` / `getEmbeddingProvider()`. Never instantiate providers directly outside tests.
- **Auth on cloud provider:** Use `storage.setAuth(accessToken)` on the provider instance. No standalone auth-setting functions.
- **Upserts:** `INSERT ... ON CONFLICT DO UPDATE` for idempotency (chains, relations, sessions).
- **Batch methods:** `insertReasoningChains()` and `insertChainRelations()` for bulk operations. Single-item methods exist but prefer batch when inserting multiple.
- **Graceful shutdown:** Backfill and linker register SIGINT/SIGTERM handlers to save state before exit.
- **File permissions:** `auth.json` written with `0o600` (credentials file).

## Testing

```bash
# Run all tests (117 tests)
bun test src/backfill/ollama-extractor.test.ts src/config/config.test.ts src/embeddings/ollama.test.ts src/storage/pglite.test.ts src/ingestion/parsers/claude-code.test.ts
```

Known pre-existing TS issues (not bugs, tests pass):
- `preconnect` property errors on `fetch` mocks in test files — Bun `@types` version mismatch
- `web/` directory has module resolution errors — separate Next.js app with its own tsconfig
- `src/storage/supabase-provider.ts:211` has implicit `any` on a filter callback

## CLI Commands

```
sessiongraph init             # interactive setup (one time)
sessiongraph search "query"   # semantic search over reasoning history
sessiongraph sessions         # list recent sessions
sessiongraph backfill         # extract reasoning from past sessions via Ollama
sessiongraph link             # auto-link related chains via embedding similarity
sessiongraph login            # authenticate for cloud sync
sessiongraph signup           # create a cloud account
sessiongraph logout           # clear stored credentials
sessiongraph status           # show sync status
sessiongraph sync             # sync local data to cloud
sessiongraph mcp              # start the MCP server (stdio)
```

## Supported AI Tools

| Tool | Status | Data Source |
|------|--------|-------------|
| OpenCode | Working | SQLite DB at `~/.local/share/opencode/opencode.db` |
| Claude Code | Parser built, untested | JSONL at `~/.claude/projects/` |
| Aider | Planned | Markdown at `.aider.chat.history.md` |
| Cursor | Planned | SQLite in VS Code workspace storage |

## What This Is NOT

- **Not a code review tool.** Captures reasoning, not code diffs.
- **Not a knowledge base.** Stores reasoning process, not facts or documentation.
- **Not a session replay tool.** Extracts and indexes reasoning, doesn't replay conversations.
- **Not server-side infrastructure.** The user's agent or local Ollama handles extraction. We never run LLMs on our servers.
