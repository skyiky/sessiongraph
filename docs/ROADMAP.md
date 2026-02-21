# SessionGraph Roadmap

> Last updated: 2026-02-21

What's shipped is documented in [CLAUDE.md](../CLAUDE.md). This file covers what's next.

---

## Phase 2: Multi-Tool & Polish (v0.3)

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

Long-term, only if Phase 2-3 succeed.

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

## Anti-Goals

Explicit anti-goals to avoid scope creep:

- **Not a code review tool.** We capture reasoning, not code diffs.
- **Not a project management tool.** No tickets, no sprints, no kanban.
- **Not a knowledge base.** We don't store facts or documentation. We store the reasoning process.
- **Not a session replay tool.** We don't replay conversations. We extract and index the reasoning from them.
- **Not server-side extraction infrastructure.** The user's agent or local Ollama handles extraction. We never run LLMs on our servers for extraction.
