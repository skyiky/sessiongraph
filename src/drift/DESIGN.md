# Mind Wandering: Autonomous Background Exploration

Design document for Phase 5 of the Drift feature. **Design only — no implementation in this phase.**

## Core Idea

Human minds don't only think when prompted. During idle moments — walking, showering, falling asleep — the brain's default mode network activates and performs spontaneous associative retrieval: pulling up old memories, connecting them to recent experiences, and occasionally producing insights ("eureka moments"). This is mind wandering.

SessionGraph's mind wandering does the same thing for an AI agent's reasoning history. When the system is idle, it autonomously:

1. Drifts through the reasoning graph (using the drift walk from Phase 2)
2. Examines what it found
3. Reflects on cross-domain connections (using an LLM)
4. Stores any genuine insights back into the graph as new reasoning chains

The key constraint: this must run **without human prompting**. The system generates its own motivation to explore by noticing gaps, tensions, and unexpected similarities in its own memory.

## Architecture

### Components

```
┌──────────────────────────────────────────────────────┐
│                   Mind Wandering Daemon               │
│                                                       │
│  ┌─────────────┐    ┌──────────────┐    ┌──────────┐ │
│  │   Trigger    │───>│  Drift Walk  │───>│ Reflect  │ │
│  │   System     │    │  (Phase 2)   │    │  (LLM)   │ │
│  └─────────────┘    └──────────────┘    └──────────┘ │
│                                                │      │
│                                          ┌─────▼────┐ │
│                                          │  Store    │ │
│                                          │  Insight  │ │
│                                          └──────────┘ │
└──────────────────────────────────────────────────────┘
```

### 1. Trigger System

Determines **when** to wander. Multiple trigger modes:

**Idle trigger (primary):** After the MCP server has been running for N minutes without receiving any tool calls, initiate a wandering session. Default: 30 minutes of inactivity. This mimics the brain's default mode network activating during rest.

**Scheduled trigger:** Run wandering at fixed intervals (e.g., once per day) regardless of activity. Useful for users who start/stop the MCP server frequently.

**Post-session trigger:** After a session with substantial new chains (5+ new chains ingested), trigger a short wandering pass to integrate new knowledge with existing memory. This mimics the brain's post-experience consolidation during sleep.

**Manual trigger:** CLI command `sessiongraph wander` or MCP tool `wander` for on-demand exploration.

### 2. Drift Walk

Uses the existing `driftWalk()` from Phase 2 with specific parameters tuned for exploration:

- **Temperature: 0.8-0.9** — High stochasticity for maximal exploration
- **Steps: 8-12** — Long walks to traverse more of the graph
- **No seed chain** — Always start from a random salience-weighted chain
- **No project filter** — Cross-project wandering is the whole point

Multiple walks per wandering session (3-5 walks) to sample different regions of the graph.

### 3. Reflection (LLM)

After each drift walk, the sequence of visited chains is presented to an LLM with a reflection prompt. This is the only component that requires an LLM.

**Reflection prompt structure:**

```
You just took a walk through a developer's reasoning history. Here are the
stops you made, in order:

[Step 1: title, type, content]
[Step 2: title, type, content]
...

Consider:
1. Are there surprising connections between any of these chains?
2. Do any of these chains, when seen together, suggest a pattern or principle
   that wasn't visible from any single chain?
3. Does this sequence remind you of a known concept, design pattern, or
   principle that could be named and reused?
4. Are there contradictions or tensions between chains that deserve attention?

If you find a genuine insight, return it as JSON:
{
  "found": true,
  "title": "...",
  "content": "...",
  "type": "insight" | "decision" | "exploration",
  "tags": [...],
  "related_chain_ids": [...],
  "relations": [{"chain_id": "...", "relation": "analogous_to" | "builds_on" | "generalizes"}]
}

If there is no genuine insight (most walks won't produce one), return:
{"found": false}

Be selective. Only surface insights that are non-obvious and actionable.
A walk that produces nothing is a successful walk — it explored without
forcing a false connection.
```

**LLM choice:** Use Ollama with the configured chat model (currently `qwen2.5:3b`). The prompt is small (walk steps are short summaries) so even a 3B model should handle it. Consider allowing a separate `wanderModel` config for users who want a larger model for reflection (e.g., `qwen2.5:7b` or `llama3.1:8b`).

### 4. Store Insight

When the LLM produces a genuine insight:

1. Create a new reasoning chain with `source: "drift_wander"` (new ChainSource value)
2. Set quality to 0.5 initially — wandering insights start lower than human-captured or agent-captured chains
3. Generate embedding and store
4. Create `analogous_to` / `builds_on` / `generalizes` relations to the chains referenced in the walk
5. Log the wandering result for observability

The quality of wandering insights should be boosted over time if they get recalled frequently (the existing `touchChains` mechanism handles this via `recall_count`). Insights that are never recalled naturally decay in relevance.

## State Management

### Wandering State

```typescript
interface WanderState {
  /** When the last wandering session completed */
  lastWanderedAt: string; // ISO date
  /** Total number of wandering sessions completed */
  totalSessions: number;
  /** Total insights generated across all sessions */
  totalInsightsGenerated: number;
  /** Chain IDs of all insights generated by wandering */
  generatedChainIds: string[];
}
```

Persisted to `~/.sessiongraph/wander-state.json` (same pattern as `link-state.json` and `backfill-state.json`).

### Rate Limiting

Wandering should be conservative with resources:

- **Max 1 wandering session per hour** (even if triggered multiple times)
- **Max 5 drift walks per session** (each walk = 8-12 steps)
- **Max 3 LLM reflection calls per session** (skip remaining walks if 3 insights found)
- **Total wall-clock cap: 5 minutes per session** (kill long-running LLM calls)
- **Cool-down after failure:** If Ollama is unreachable, back off exponentially (1h → 2h → 4h → 8h max)

## Observability

### Logging

All wandering activity logged to `~/.sessiongraph/wander.log` (append-only):

```
[2026-02-23T10:00:00Z] Wandering session started (trigger: idle, idle_time: 45m)
[2026-02-23T10:00:01Z] Walk 1: 10 steps, seed=abc123 (random)
[2026-02-23T10:00:03Z] Walk 1 reflection: no insight
[2026-02-23T10:00:04Z] Walk 2: 8 steps, seed=def456 (random)
[2026-02-23T10:00:07Z] Walk 2 reflection: INSIGHT "Pattern: retry-with-backoff appears in 4 unrelated projects"
[2026-02-23T10:00:07Z] Stored chain xyz789 (source: drift_wander, quality: 0.5)
[2026-02-23T10:00:07Z] Session complete: 2 walks, 1 insight, 7.2s elapsed
```

### CLI

```bash
sessiongraph wander              # Run one wandering session manually
sessiongraph wander --status     # Show wandering stats
sessiongraph wander --history    # Show recent wandering log
```

### MCP

```
Tool: wander
  - Trigger one wandering session
  - Returns the walk paths and any insights generated
  - Useful for agents that want to "daydream" between tasks
```

## Configuration

```typescript
// In config.ts
interface WanderConfig {
  /** Enable/disable autonomous wandering (default: false — opt-in) */
  enabled: boolean;
  /** Minutes of inactivity before triggering idle wandering (default: 30) */
  idleMinutes: number;
  /** Maximum drift walks per session (default: 5) */
  maxWalksPerSession: number;
  /** Drift walk temperature for wandering (default: 0.85) */
  temperature: number;
  /** Drift walk steps (default: 10) */
  steps: number;
  /** Ollama model override for reflection (default: use config.ollama.chatModel) */
  reflectionModel?: string;
  /** Maximum wandering sessions per day (default: 10) */
  maxSessionsPerDay: number;
}
```

Wandering is **opt-in** (disabled by default). Users enable it via `sessiongraph init` or by setting `wander.enabled = true` in config.

## Integration with Existing Features

### With Spreading Activation (Phase 3)

After a wandering session generates insights, those insights become seeds for future spreading activation during `recall`. This creates a feedback loop:

1. Wandering discovers: "retry-with-backoff is a cross-cutting pattern"
2. User searches for "error handling in API client"
3. Spreading activation follows `analogous_to` edges from search results
4. The wandering-generated insight surfaces as a serendipitous connection
5. User recalls it → `recall_count` increases → salience grows → drift walks visit it more often

### With Cross-Domain Edges (Phase 4)

The exploration pass creates `analogous_to` edges between distant chains. These edges make drift walks more interesting (more teleport-like connections available). Wandering then traverses these edges and reflects on the connections, potentially generating higher-quality insights than the edge discovery alone.

### With Consolidation

Wandering insights that cluster around a theme can be input to the consolidator, which synthesizes them into dense summaries. A "meta-consolidation" pass could periodically consolidate wandering insights.

## Open Questions

### Quality Control

How do we prevent the graph from filling up with low-quality wandering noise? Options:

1. **Aggressive filtering at generation:** Only store insights with high LLM confidence. Risk: lose surprising/weak connections.
2. **Natural decay:** Start wandering insights at quality 0.5 and let the existing decay mechanism (`decayUnusedChains`) clean up insights nobody recalls. Risk: slow cleanup.
3. **Capped quota:** Maximum N wandering insights stored. Oldest/lowest-quality get pruned when cap is reached. Risk: arbitrary limits.
4. **User review gate:** Wandering generates candidate insights but flags them for user approval before storing. Risk: defeats the "autonomous" goal.

**Recommended:** Combination of (1) and (2). Start at quality 0.5, apply a slightly faster decay rate to `drift_wander` chains (e.g., 2x the normal decay factor). This lets the system explore freely while ensuring unused insights naturally fade.

### Concurrency with MCP Server

The MCP server runs as a long-lived stdio process. Wandering needs to run in the same process (same PGlite connection). Options:

1. **setInterval in the MCP server process:** Simple. Check idle time every 5 minutes. If idle > threshold, start wandering. Pause if a tool call comes in mid-wander.
2. **Separate daemon process:** More complex. Needs its own PGlite connection (conflicts with lockfile). Would need IPC or shared lock protocol.
3. **Cron job via CLI:** `sessiongraph wander` runs as a one-shot command. User sets up their own cron/task scheduler. Simple but requires user setup.

**Recommended:** Option 1 for the MCP server (primary use case), with option 3 as fallback for users who don't run MCP persistently.

### Model Quality vs. Speed

`qwen2.5:3b` is fast but may produce shallow reflections. The reflection prompt asks for genuine cross-domain connections — this is a hard task for a 3B model. Consider:

- Allow a separate `wanderModel` config (default: same as `chatModel`)
- Document that larger models (7B+) produce better wandering insights
- The quality floor (0.5) and decay mechanism protect against bad outputs

### Privacy and Resource Usage

Wandering runs autonomously in the background. Users should understand:

- It uses Ollama (local, no data leaves the machine)
- It uses CPU/GPU resources periodically
- It modifies the reasoning graph by adding new chains and edges
- It can be disabled at any time

All of this should be clearly communicated during `sessiongraph init`.

## Non-Goals for Phase 5

- **No implementation.** This is a design document only.
- **No multi-agent coordination.** Each SessionGraph instance wanders independently.
- **No cloud wandering.** Wandering runs locally only (Ollama dependency).
- **No real-time notifications.** Wandering results are discoverable via search/recall, not pushed to the user.
