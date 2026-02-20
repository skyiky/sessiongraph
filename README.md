# SessionGraph

> Never lose the reasoning behind an AI-assisted decision again.

Your AI coding sessions produce two things: code changes and the reasoning that led to them. Git saves the code. Nothing saves the reasoning. Three months later you're staring at an architecture decision and have no idea why you (and Claude) chose this approach over the three alternatives you explored and rejected.

SessionGraph runs in the background, captures the reasoning chains from all your AI agent sessions, and makes them searchable — so you never lose the "why" behind any decision.

**CLAUDE.md saves conclusions. Mem0 saves facts. SessionGraph saves the reasoning — the exploration, the rejected alternatives, the tradeoffs that led to the decision.**

## How It Works

### Setup (one time)

```bash
npm install -g sessiongraph
sessiongraph login
```

Then add SessionGraph as an MCP server in your AI tool's config. Done.

### Daily workflow

You code with AI as normal — nothing changes. Behind the scenes:

```
You're coding with your AI tool (OpenCode, Claude Code, Aider, etc.)
        |
        v
Your AI tool spawns SessionGraph as an MCP server (stdio)
        |
        v
SessionGraph reads your AI tool's session database
        |
        v
It finds new sessions/messages since last sync
        |
        v
It extracts reasoning chains from the conversation:
  - "We chose Supabase because X, Y, Z"         -> decision
  - "We considered PGlite but rejected it"        -> rejection
  - "The root cause was the WAL lock"             -> insight
        |
        v
Each reasoning chain gets a vector embedding
(via Supabase Edge Function, gte-small model)
        |
        v
Everything is stored in Supabase (Postgres + pgvector)
        |
        v
Later, when an AI agent calls recall("why did we pick Supabase")
        |
        v
SessionGraph does a vector similarity search, finds the relevant
reasoning chains, and returns them to the agent
        |
        v
The agent now has context it never would have had otherwise
```

### MCP Tools

Your AI agents get four tools:

| Tool | What it does | Example |
|------|-------------|---------|
| `remember` | AI agent explicitly saves something important | Agent decides on an architecture — calls `remember` to save the reasoning |
| `recall` | AI agent asks "what do I know about X?" | Agent calls `recall("authentication strategy")` — gets back past decisions |
| `timeline` | "What happened recently?" | Shows last 10 sessions and key decisions, chronologically |
| `sessions` | "Show me past sessions" | Lists sessions filtered by project or tool |

### Offline

SessionGraph works offline. It writes to a local SQLite buffer and syncs to Supabase when the connection returns.

### CLI

```bash
sessiongraph login          # authenticate (one time)
sessiongraph search "query" # search your reasoning history
sessiongraph status         # show sync status
sessiongraph sessions       # list recent sessions
```

## Tech Stack

- **Runtime:** Bun + TypeScript
- **Database:** Supabase (hosted Postgres + pgvector)
- **Embeddings:** Supabase Edge Functions (gte-small, 384 dims)
- **Offline buffer:** SQLite (via bun:sqlite)
- **MCP:** @modelcontextprotocol/sdk (stdio transport)
- **Auth:** Supabase Auth

## Architecture

```
User's Machine                              Cloud (Supabase)
+------------------------------+     +-------------------------+
|     MCP Server Process       |     |    Supabase Project     |
|                              |     |                         |
|  +----------+ +-----------+  |     |  +------------------+  |
|  |MCP Tools | |  Session   |  |     |  |  PostgreSQL +    |  |
|  | (stdio)  | |  Parsers   |  |     |  |  pgvector        |  |
|  +----+-----+ +-----+-----+  |     |  +------------------+  |
|       +------+------+        |     |                         |
|       +------v------+        |     |  +------------------+  |
|       |  Ingestion  |        |     |  |  Edge Functions   |  |
|       |  Pipeline   |        |     |  |  (embeddings)     |  |
|       +------+------+        |     |  +------------------+  |
|       +------v------+        |     |                         |
|       |Local Buffer |  sync  |     |  +------------------+  |
|       |  (SQLite)   |----------->  |  |  Supabase Auth   |  |
|       +-------------+        |     |  +------------------+  |
+------------------------------+     +-------------------------+
```

## Supported AI Tools

| Tool | Parser Status | Data Source |
|------|--------------|-------------|
| OpenCode | v1 (first) | SQLite DB at `~/.local/share/opencode/opencode.db` |
| Claude Code | Planned | JSON/MD at `~/.claude/projects/` |
| Aider | Planned | Markdown at `.aider.chat.history.md` per project |
| Cursor | Future | SQLite in VS Code workspace storage |
| GitHub Copilot Chat | Future | JSON in VS Code global storage |
| Windsurf | Future | Unknown — needs investigation |

## Reasoning Chain Categories

SessionGraph extracts 5 types of reasoning chains from your AI sessions:

| Type | What it captures | Trigger signals |
|------|-----------------|-----------------|
| **decision** | A choice was made between alternatives | "We'll go with X", "Let's use X", "X is the right choice" |
| **exploration** | Multiple options being weighed, no conclusion yet | "Let's compare X vs Y", "Options are...", "We could do X or Y" |
| **rejection** | Something explicitly ruled out with a reason | "X won't work because", "We ruled out X", "Don't use X" |
| **solution** | A problem was identified and solved | "The fix is X", "Root cause was X", "This works because X" |
| **insight** | A standalone learning or discovery | "TIL", "Interesting — X means Y", "I didn't know that X" |

### What each category should contain

- **decision** — What was chosen, why, and what the alternatives were
- **exploration** — The options, tradeoffs being discussed, criteria being evaluated
- **rejection** — What was rejected, why, what the failure or limitation was
- **solution** — The problem, root cause, the fix, why it works
- **insight** — The learning, its implications, where it applies

### Boundary rules

- If an exploration leads to a decision in the same turn, extract **both** separately.
- If something is rejected as part of reaching a decision, extract **both** separately.
- A solution that involves choosing between fix approaches is a **solution**, not a decision.
- If unsure between exploration and insight, default to **insight**.

### Example extractions

From a real session about choosing a database:

```
exploration: "Database choice: SQLite vs Supabase vs PGlite"
  Compared three options. SQLite: zero-dep, weak vector search.
  Supabase: hosted Postgres with pgvector, requires internet.
  PGlite: embedded Postgres, clean upgrade path.

rejection: "PGlite rejected for v1"
  Rejected despite cleanest upgrade path. Reason: newer project,
  smaller community, user preferred Supabase's built-in features.

decision: "Supabase chosen as database"
  Chose Supabase-native over Postgres-portable. Rationale: no
  enterprise customers yet, ship speed > flexibility.

insight: "Supabase has free built-in embedding model"
  Supabase Edge Functions include gte-small (384 dims) for free.
  No OpenAI API key needed. Eliminates embedding cost for v1.

solution: "Embedding cost solved with built-in model"
  Problem: server-side OpenAI embeddings cost money per user.
  Fix: use Supabase's built-in gte-small model instead. Free,
  good enough quality. Upgrade to OpenAI as Pro tier later.
```
