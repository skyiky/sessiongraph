# SessionGraph Roadmap

> Last updated: 2026-02-21

## Guiding Principles

1. **Local-first, cloud-optional.** Solo devs want their data on their machine. Cloud sync is a feature you opt into, not a requirement.
2. **The AI agent IS the extractor.** The agent making the decision has perfect context. No post-hoc extraction can match real-time capture. The auto-reasoning skill is the primary extraction path.
3. **Backfill is non-negotiable.** A tool that only works going forward has zero value on install day. Backfill gives immediate value from hundreds of existing sessions.
4. **Ship speed > architectural purity.** No users yet. Optimize for learning, not scalability.

---

## Phase 0: Foundation (v0.1) — DONE

*Shipped: 2026-02-19*

Everything built so far. Proves the concept works end-to-end.

### What shipped
- **MCP server** with 4 tools: `remember`, `recall`, `timeline`, `sessions` (`src/mcp/server.ts`)
- **Auto-reasoning capture skill** — AI agent proactively calls `remember` during sessions, 2-6 high-quality chains per session (`skills/auto-reasoning-capture/SKILL.md`)
- **Supabase backend** — Postgres + pgvector, RLS, Edge Function embeddings (gte-small, 384 dims)
- **Web dashboard** — Next.js 15, full auth flow, search, session browser, chain detail views (43 unit tests, 20 E2E tests)
- **OpenCode parser** — reads from `~/.local/share/opencode/opencode.db`
- **Offline buffer** — SQLite write-through, syncs to Supabase when online
- **CLI** — `login`, `search`, `status`, `sessions`

### What we learned
- Real-time agent capture produces dramatically better chains than regex or LLM post-processing. Regex chains are thin procedural descriptions. Agent-captured chains include the WHY, the alternatives, the tradeoffs.
- The regex extractor (`extractReasoningChainsSimple`) and LLM extractor (`extractReasoningChains`) in `src/ingestion/extractor.ts` both produce low-quality output. **Both will be removed in Phase 1.**
- Supabase works but forces an account + internet connection for a tool that should work on a plane.

---

## Phase 1: Local-First Pivot (v0.2) — DONE

*Shipped: 2026-02-20*

The biggest architectural change. Moved from Supabase-required to fully local by default. SessionGraph is now installable in 60 seconds with zero accounts.

### 1.1 PGlite as Default Storage

Replace Supabase as the default storage backend with [PGlite](https://pglite.dev/) (embedded Postgres in the process).

**Why PGlite over SQLite:** pgvector extension works in PGlite. This means semantic search works locally without any cloud dependency. SQLite has no production-quality vector search extension.

**Why we initially rejected PGlite and why we're reversing:** In v0.1 we chose Supabase over PGlite because PGlite was "newer project, smaller community" and we wanted Supabase's built-in features. Now that we've proven the concept, the right move is local-first. PGlite has matured, and the upgrade path from PGlite to hosted Postgres is clean (same SQL, same pgvector).

**Storage tiers:**
| Tier | Storage | Embeddings | Who |
|------|---------|------------|-----|
| Solo (default) | PGlite local | Ollama local | Individual dev, no account needed |
| Cloud | Supabase hosted | Supabase Edge Function | Dev who wants cross-device sync |
| Team | Supabase hosted | Supabase Edge Function | Teams who want shared reasoning |

**Files to change:**
- New: `src/storage/pglite.ts` — PGlite client, same query interface as `src/storage/supabase.ts`
- New: `src/storage/provider.ts` — storage provider abstraction (PGlite or Supabase)
- Update: `src/mcp/server.ts` — use provider abstraction instead of direct Supabase imports
- Update: `src/config/config.ts` — storage mode config (`local` | `cloud`)

### 1.2 Ollama for Local Embeddings + Backfill

Two uses for Ollama:

**Local embeddings (replaces Supabase Edge Function for solo tier):**
- Model: `nomic-embed-text` (768 dims) or `all-minilm` (384 dims, matches current schema)
- Called from `src/storage/pglite.ts` during `remember` and `recall`
- Fallback: if Ollama not installed, use a JS-native embedding model (e.g., `@xenova/transformers` with `all-MiniLM-L6-v2`)

**Backfill extraction (batch-processes existing sessions):**
- Model: `llama3.1:8b`, `phi3`, or `qwen2.5:7b` — small, fast, free
- Runs during `sessiongraph init` or `sessiongraph backfill`
- Processes existing OpenCode/Claude Code sessions in bulk
- Uses the same extraction prompt as `src/ingestion/extractor.ts` but via local Ollama instead of OpenAI API
- User choice during init: Ollama (free, requires install) or their own API key (GPT-4o-mini, costs ~$0.01/session)

**Why Ollama and not the user's AI agent:** The user's agent (Claude Opus, GPT-4) costs $0.05-0.15 per response. Backfilling 200 sessions would cost $10-30. Ollama is free. The quality difference doesn't matter much for backfill — these are "good enough" chains that fill the search index. Going-forward chains from the auto-reasoning skill are the high-quality ones.

**Files to create:**
- `src/embeddings/ollama.ts` — Ollama embedding client
- `src/embeddings/provider.ts` — embedding provider abstraction
- `src/backfill/backfill.ts` — batch extraction pipeline
- `src/backfill/ollama-extractor.ts` — Ollama-based extraction (reuses prompt from `extractor.ts`)

### 1.3 Claude Code Parser

Well-researched, ready to implement.

**Data format:**
- Session storage: JSONL at `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`
- Path encoding: `cwd.replace(/[^a-zA-Z0-9]/g, "-")`
- Message format: `{"type": "human"|"assistant"|"tool_result", "message": {...}, "timestamp": ...}`
- Session index: `~/.claude/history.jsonl` with `{display, timestamp, project, sessionId}`

**Files to create:**
- `src/ingestion/parsers/claude-code.ts` — JSONL parser, mirrors `src/ingestion/parsers/opencode.ts` interface

### 1.4 One-Command Onboarding

```bash
npx sessiongraph init
```

Interactive setup flow:
1. Detect installed AI tools (check for OpenCode DB, Claude Code sessions dir)
2. Choose storage mode: Local (PGlite) or Cloud (Supabase login)
3. Choose embedding provider: Ollama (check if installed) or API key
4. Offer backfill: "Found 247 existing sessions. Backfill now? [Y/n]"
5. Install MCP server config into detected AI tool(s)
6. Copy auto-reasoning-capture skill to tool's skill directory

**Files to create:**
- `src/cli/init.ts` — interactive setup wizard
- `src/cli/detect.ts` — AI tool detection logic

### 1.5 Session-Close Capture

Enhance the auto-reasoning skill with end-of-session behavior:
- At session end, agent does a final sweep for any reasoning it missed during the session
- Completely silent — no confirmation prompt, no "I'm now capturing..." announcements
- Can leverage context compaction summaries if available (distilled version of the session)

**File to update:**
- `skills/auto-reasoning-capture/SKILL.md` — add session-close section

### 1.6 Delete Legacy Extractors

Remove both extractors from `src/ingestion/extractor.ts`:
- `extractReasoningChains()` — LLM-based, requires OpenAI API key, produces mediocre chains
- `extractReasoningChainsSimple()` — regex-based, produces garbage chains

These are replaced by:
- **Real-time**: Auto-reasoning skill (agent calls `remember` as it works)
- **Backfill**: Ollama-based extraction (`src/backfill/ollama-extractor.ts`)

The `ExtractedChain` interface stays — it's used by both new and old code.

### Phase 1 Definition of Done
- [x] `npx sessiongraph init` works end-to-end on a fresh machine
- [x] All data stored in PGlite by default, no Supabase account needed
- [x] `recall` returns semantically relevant results from local PGlite + Ollama embeddings
- [x] Backfill processes existing OpenCode + Claude Code sessions
- [x] `extractor.ts` contains only the `ExtractedChain` type, no extraction functions
- [x] Existing Supabase path still works when configured (cloud tier)

---

## Phase 1.5: Reasoning Graph (v0.2.1) — DONE

*Shipped: 2026-02-21*

Chains aren't isolated — they form a graph of related reasoning. This phase adds the ability to link chains together and explore those connections.

### What shipped
- **chain_relations table** with 8 relation types: `leads_to`, `supersedes`, `contradicts`, `builds_on`, `depends_on`, `refines`, `generalizes`, `analogous_to`
- **`remember` with `related_to`** — link a new chain to an existing one at creation time
- **`graph` MCP tool** — explore chain relations by chain ID
- **`recall` returns chain IDs** — so agents can reference specific chains
- **Auto-linker engine** (`sessiongraph link`) — uses embedding similarity to discover and classify chain relations automatically via Ollama
- **`listChainsWithEmbeddings`** in both PGlite and Supabase providers
- **35 PGlite tests** (14 original + 18 relation + 3 listChainsWithEmbeddings)

---

## Phase 2: Multi-Tool & Polish (v0.3)

*Target: 4-6 weeks after Phase 1*

Expand tool support, improve quality, polish the experience.

### 2.1 Aider Parser
- Data source: `.aider.chat.history.md` per project directory
- Markdown format, simpler than JSONL — pattern-match user/assistant turns

### 2.2 Cross-Tool Unified Timeline
- `recall` and `timeline` search across all tools seamlessly
- "Last week I used Claude Code on project X and OpenCode on project Y" — one search finds both

### 2.3 Chain Quality Scoring
- Not all chains are equal. Backfill chains < real-time agent chains.
- Add a `quality` field (0-1) to `reasoning_chains`
- Real-time capture = 1.0, Ollama backfill = 0.6, regex legacy = 0.2
- Search results weighted by quality — higher quality chains rank higher at equal similarity

### 2.4 CLI Polish
- `sessiongraph search` with rich terminal output (colors, formatting)
- `sessiongraph stats` — chain count by type, sessions by tool, storage size
- `sessiongraph export` — dump reasoning chains to JSON/Markdown

### 2.5 Cursor Parser (Stretch)
- Data source: SQLite in VS Code workspace storage
- Lower priority — Cursor users are less likely to be CLI-first developers

---

## Phase 3: Cloud Sync & Teams (v0.4)

*Target: 8-12 weeks after Phase 1*

Only build this when users ask for it. Cloud sync and team features are the monetization path.

### 3.1 Optional Cloud Sync
- Local PGlite → Supabase sync (one-way push, or bidirectional)
- `sessiongraph sync enable` — connects local to cloud
- Cross-device access: laptop at work, desktop at home, same reasoning history

### 3.2 Web Dashboard Deployment
- Deploy existing Next.js dashboard to Vercel
- Only available for cloud-tier users (needs Supabase backend)
- Already built and tested — just needs deployment + domain

### 3.3 Team Features (`ee/` directory)
- Org-level search across team members' reasoning
- "Has anyone on the team solved this before?"
- Shared project reasoning — new team member onboards by searching past decisions
- Admin dashboard, usage analytics

### 3.4 API Access
- REST API for programmatic access to reasoning chains
- Webhook on new chain capture (integrate with Slack, Notion, etc.)

---

## Phase 4: Ecosystem (v0.5+)

*Long-term, only if Phase 1-3 succeed.*

### 4.1 GitHub Integration
- Link reasoning chains to specific commits and PRs
- PR description auto-populated with relevant decision chains
- "Why was this PR created?" → links to the reasoning that led to it

### 4.2 VS Code Extension
- Sidebar panel showing reasoning chains for the current project
- Inline annotations: hover over a file/function → see decisions made about it
- Search without leaving the editor

### 4.3 Reasoning Visualization
- Graph view: decisions → rejections → explorations → final solution
- Timeline scrubber: see how thinking evolved across sessions
- Dependency graph: which decisions influenced which

### 4.4 Import/Export & Interop
- Export to Markdown, JSON, CSV
- Import from other tools (if they exist by then)
- CLAUDE.md ↔ SessionGraph bidirectional sync (conclusions in CLAUDE.md, reasoning in SessionGraph)

---

## What We're NOT Building

Explicit anti-goals to avoid scope creep:

- **Not a code review tool.** We capture reasoning, not code diffs.
- **Not a project management tool.** No tickets, no sprints, no kanban.
- **Not a knowledge base.** We don't store facts or documentation. We store the reasoning process.
- **Not a session replay tool.** We don't replay conversations. We extract and index the reasoning from them.
- **Not server-side extraction infrastructure.** The user's agent or local Ollama handles extraction. We never run LLMs on our servers for extraction.

---

## Open Questions (Resolved)

Decisions made during Phase 1 development:

1. **Embedding model for local:** Chose `qwen3-embedding:0.6b` (1024 dims). Started with `all-minilm` (384), upgraded to `nomic-embed-text` (768), then settled on qwen3-embedding for best quality-to-size ratio at 639MB.
2. **PGlite storage location:** `~/.sessiongraph/pglite/` (centralized). One database for all projects — cross-project search is a key differentiator.
3. **Backfill quality threshold:** Acceptable for search. `qwen2.5:3b` with `format: "json"` produces structured chains at ~20 tok/s on a 4GB VRAM GPU. Not perfect, but fills the search index well enough.
4. **Claude Code session discovery:** Scans all projects automatically. User can filter by project later via `recall` or `sessions`.
5. **npm package scope:** `sessiongraph` (unscoped). Simpler, shorter, no org overhead.
