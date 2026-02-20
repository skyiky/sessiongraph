---
name: backfill
description: Use when the user asks to backfill or process old sessions — reads past AI coding sessions and extracts reasoning chains using the remember tool
---

# Session Backfill

You are backfilling past AI coding sessions into SessionGraph. Your job is to read old session conversations and extract high-quality reasoning chains from them using the `remember` tool.

## Workflow

1. **Get a batch** — Call `sessiongraph_get_sessions_to_backfill` with `limit: 3` to get the next batch of unprocessed sessions.

2. **Process each session** — For each session in the batch:
   a. Read the conversation text carefully.
   b. Identify the **2-6 most important** reasoning chains. Look for:
      - **Decisions** — chose X over Y, with rationale
      - **Rejections** — ruled out an approach and why
      - **Solutions** — diagnosed and fixed a non-trivial problem
      - **Insights** — learned something surprising or non-obvious
      - **Explorations** — compared multiple options with meaningful tradeoffs
   c. For each chain, call `sessiongraph_remember` with:
      - `type`: The correct category (`decision`, `exploration`, `rejection`, `solution`, `insight`)
      - `title`: A specific, descriptive sentence. "Chose WebSocket over polling for real-time updates" not "Communication decision"
      - `content`: 2-5 self-contained sentences. Include WHAT was decided/discovered, WHY, and what alternatives existed. Someone reading just this chain — with no access to the original conversation — should fully understand the reasoning.
      - `tags`: 2-4 relevant topic tags for searchability
      - `project`: The project name/path from the session metadata
   d. After extracting all chains for a session, call `sessiongraph_mark_session_backfilled` with the session's ID.

3. **Report progress** — After finishing the batch, tell the user: "Processed X sessions, captured Y reasoning chains."

4. **Ask to continue** — Ask if the user wants to continue with the next batch.

5. **Completion** — If `get_sessions_to_backfill` returns no sessions, report: "All sessions have been backfilled."

## Quality Guidelines

- **Quality over coverage.** 3 excellent chains are worth more than 8 mediocre ones. Every chain should be something genuinely useful to recall months from now.
- **Self-contained chains.** Each chain must stand alone. Don't reference "the above discussion" or "as mentioned earlier." Write as if the reader has zero context.
- **Skip empty sessions.** If a session is purely routine — file reads, simple edits, boilerplate, no real reasoning — mark it as backfilled and move on. Don't fabricate reasoning that isn't there.
- **Don't duplicate.** If reasoning from a session has already been captured (e.g. via auto-reasoning-capture during the original session), don't re-capture it.
- **Accurate types.** Use the right type. A decision is not an insight. A rejection is not a solution. Be precise.
- **Set the project.** Always set the `project` field to match the session's project path/name from the metadata.
