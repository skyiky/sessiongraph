# SessionGraph

> Searchable reasoning history for AI coding sessions.

Your AI coding sessions produce two things: code changes and the reasoning that led to them. Git saves the code. Nothing saves the reasoning. Three months later you're staring at an architecture decision with no idea why you chose this approach — or what alternatives you explored and rejected.

SessionGraph captures reasoning chains from your AI coding sessions and makes them semantically searchable.

## Quick Start

**Prerequisites:** [Bun](https://bun.sh) and [Ollama](https://ollama.com) installed.

```bash
# Clone and install
git clone https://github.com/skyiky/sessiongraph.git
cd sessiongraph
bun install

# Pull required models
ollama pull qwen3-embedding:0.6b   # embeddings (639MB)
ollama pull qwen2.5:3b              # extraction (1.9GB)

# Interactive setup — detects your AI tools, configures MCP, offers backfill
bun run src/index.ts init
```

That's it. The MCP server runs automatically when your AI tool starts a session.

## How Is This Different From CLAUDE.md?

CLAUDE.md (or AGENTS.md, CONVENTIONS.md, etc.) is great for active instructions — things the agent should know right now. Some people even use auto-update skills to keep it maintained. SessionGraph solves a different problem.

|  | **CLAUDE.md + Auto-Update** | **SessionGraph** |
|---|---|---|
| **What it captures** | Conclusions and rules — "use Zustand not Redux" | Full reasoning — "evaluated Redux, Zustand, Jotai; rejected Redux because X; picked Zustand because Y" |
| **Search** | Ctrl+F / grep (keyword match only) | Semantic search — "state management decision" finds results even if those exact words weren't used |
| **Scope** | Single project | Cross-project — search reasoning from any session across all your repos |
| **History** | Overwritten as project evolves. Old reasoning lost. | Append-only — reasoning from 6 months ago is still searchable |
| **Context cost** | Loaded into every session in full, whether relevant or not | Zero cost until queried — only relevant chains retrieved on demand |
| **Onboarding** | Blank file — value builds over weeks | Backfill existing sessions — searchable history in minutes |
| **Failure mode** | Agent writes garbage, corrupts useful content | Worst case: low-quality extraction gets ignored by search |
| **Privacy** | In your repo — could accidentally commit secrets | Local database, never in version control |
| **Setup** | Create a file | Install MCP server + Ollama (local) or create account (cloud) |
| **Best for** | "What should the agent do right now in this project?" | "Why did we make that decision 3 months ago?" |

**They're complementary, not competitive.** Use CLAUDE.md for active project instructions. Use SessionGraph for searchable reasoning history across projects and time.

## How It Works

### Real-Time Capture (Primary)

An [auto-reasoning-capture skill](skills/auto-reasoning-capture/SKILL.md) runs silently during your AI coding sessions. When the agent makes a significant decision, rejects an approach, or discovers something important, it calls `remember` automatically. No manual intervention needed.

### Backfill (Onboarding)

Already have hundreds of AI coding sessions? Run the backfill to extract reasoning from your existing history:

```bash
sessiongraph backfill
```

This parses your past sessions, extracts reasoning chains via a local LLM (Ollama), generates vector embeddings, and makes everything searchable immediately.

### Search

Later, when you (or your AI agent) need context:

```bash
sessiongraph search "why did we pick Supabase over PGlite?"
```

Or the agent calls `recall("authentication strategy")` and gets back the full reasoning chain — the alternatives considered, the tradeoffs weighed, and the final decision.

### MCP Tools

Your AI agents get seven tools via MCP:

| Tool | What it does |
|------|-------------|
| `remember` | Save a reasoning chain (decision, insight, rejection, etc.). Supports `related_to` for linking chains. |
| `recall` | Semantic search — "what do I know about X?" Returns matching chains with IDs. |
| `timeline` | Recent sessions with their reasoning chains, chronologically |
| `sessions` | List past sessions, filterable by project or tool |
| `graph` | Explore reasoning chain relations by chain ID |
| `get_sessions_to_backfill` | Get unprocessed sessions for agent-driven backfill |
| `mark_session_backfilled` | Mark a session as processed |

### Reasoning Graph

Chains aren't isolated — they connect to each other. SessionGraph tracks eight relation types:

| Relation | Meaning |
|----------|---------|
| `leads_to` | A caused or motivated B |
| `supersedes` | A replaces/overrides B |
| `contradicts` | A and B conflict |
| `builds_on` | A extends/deepens B |
| `depends_on` | A only makes sense because of B |
| `refines` | A narrows/improves B without replacing it |
| `generalizes` | A abstracts B into a broader pattern |
| `analogous_to` | Similar reasoning in different contexts |

Relations are created automatically via `sessiongraph link` or manually when calling `remember` with a `related_to` parameter.

### CLI

```bash
sessiongraph init             # interactive setup (one time)
sessiongraph search "query"   # search your reasoning history
sessiongraph sessions         # list recent sessions
sessiongraph timeline         # show recent activity
sessiongraph backfill         # extract reasoning from past sessions
sessiongraph link             # auto-link related chains via embeddings
sessiongraph login            # authenticate for cloud sync
sessiongraph status           # show sync status
```

## Architecture

SessionGraph runs in two modes:

**Local (default):** Everything stays on your machine. No account needed.

```
Your AI Tool (OpenCode, Claude Code, etc.)
        |
        v
MCP Server (stdio) ──── auto-reasoning-capture skill
        |                  calls remember/recall silently
        v
PGlite (embedded Postgres + pgvector)
        |
        v
Local Ollama (qwen3-embedding for vectors, qwen2.5:3b for extraction)
```

**Cloud (optional):** Supabase-hosted Postgres for sync across machines and future team features.

### Storage

| Mode | Database | Embeddings | Account Required |
|------|----------|-----------|-----------------|
| Local (default) | PGlite (embedded Postgres) | Ollama (qwen3-embedding:0.6b, 1024 dims) | No |
| Cloud | Supabase (hosted Postgres + pgvector) | Supabase Edge Functions | Yes |

## Supported AI Tools

| Tool | Status | Data Source |
|------|--------|-------------|
| OpenCode | Working | SQLite DB at `~/.local/share/opencode/opencode.db` |
| Claude Code | Parser built, untested | JSONL at `~/.claude/projects/` |
| Aider | Planned | Markdown at `.aider.chat.history.md` |
| Cursor | Planned | SQLite in VS Code workspace storage |
| Windsurf | Planned | TBD |

## Reasoning Chain Types

SessionGraph captures five types of reasoning:

| Type | Color | What it captures |
|------|-------|-----------------|
| **decision** | Blue | A choice was made between alternatives, with reasoning |
| **exploration** | Violet | Multiple options being weighed, no conclusion yet |
| **rejection** | Red | Something explicitly ruled out with a reason |
| **solution** | Green | A problem was identified and solved |
| **insight** | Amber | A standalone learning or discovery |

## Tech Stack

- **Runtime:** Bun + TypeScript
- **Local database:** PGlite (embedded Postgres + pgvector)
- **Cloud database:** Supabase (hosted Postgres + pgvector)
- **Local embeddings:** Ollama (qwen3-embedding:0.6b, 1024 dims)
- **Local extraction:** Ollama (qwen2.5:3b)
- **MCP:** @modelcontextprotocol/sdk (stdio transport)
- **Web dashboard:** Next.js 15, Tailwind CSS v4, shadcn/ui
- **Auth:** Supabase Auth (cloud mode only)

## License

[MIT](LICENSE)
