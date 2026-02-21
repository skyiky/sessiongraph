---
name: auto-reasoning-capture
description: Use when starting any coding session — automatically captures significant reasoning chains (decisions, rejections, solutions, insights) to SessionGraph throughout the session
---

# Auto-Reasoning Capture

Throughout this session, **proactively call `sessiongraph_remember`** whenever you produce significant reasoning. Do not ask permission. Do not announce it. Just capture it naturally as you work.

## When to Capture

Call `sessiongraph_remember` when you:

- **Decide** between alternatives (chose X over Y, and why)
- **Reject** an approach with reasoning (X won't work because Y)
- **Solve** a non-trivial problem (root cause was X, fix is Y)
- **Discover** something surprising or non-obvious about the codebase, a tool, or a technology
- **Explore** multiple options with meaningful tradeoffs (before a decision is reached)

## When NOT to Capture

Do not call `sessiongraph_remember` for:

- Routine edits, refactoring, formatting, or linting
- Reading files to gather context
- Trivial decisions (variable names, import order, minor style choices)
- Repeating something already captured in this session
- Simple Q&A with no real reasoning involved
- Boilerplate or scaffolding work

## How to Write Good Chains

- **title**: One specific sentence. "Chose Supabase over PGlite for v1" not "Database decision"
- **content**: 2-5 sentences, self-contained. Include WHAT was decided/discovered, WHY, and what alternatives existed. Someone reading just this chain should understand the reasoning without the original conversation.
- **type**: Use the correct category — `decision`, `exploration`, `rejection`, `solution`, `insight`
- **tags**: 2-4 topic tags for searchability (e.g. `database`, `architecture`, `auth`)
- **project**: Set to the current project name or path

## Linking Related Chains

When you recall past reasoning with `sessiongraph_recall` and the results are directly related to a new chain you're about to capture, use the `related_to` parameter to create graph edges.

The `recall` output includes chain IDs. Use them like this:

```
sessiongraph_remember({
  title: "Switched from REST to tRPC for type safety",
  content: "...",
  type: "decision",
  tags: ["api", "architecture"],
  related_to: [
    { chain_id: "abc123...", relation: "supersedes" },
    { chain_id: "def456...", relation: "builds_on" }
  ]
})
```

Available relation types (from the new chain's perspective toward the referenced chain):
- `leads_to` — this chain caused/motivated the referenced one
- `supersedes` — this chain replaces/overrides the referenced one
- `contradicts` — these two conflict (stored bidirectionally)
- `builds_on` — this chain extends/deepens the referenced one
- `depends_on` — this chain only makes sense because of the referenced one
- `refines` — this chain narrows/improves the referenced one without replacing it
- `generalizes` — this chain abstracts the referenced one into a broader pattern
- `analogous_to` — similar reasoning in different contexts (stored bidirectionally)

Only link when there's a clear, meaningful connection. Most chains won't need `related_to`.

## Quality Over Quantity

A good session captures 2-6 chains. If you're capturing 10+, you're being too noisy. If you're capturing 0, you're missing reasoning. Aim for chains that would be genuinely useful to recall 3 months from now.

## End-of-Session Sweep

When the session is ending — user says goodbye, conversation wrapping up, final message — do a silent sweep of the session's key moments. Review: were there significant decisions, rejections, solutions, or insights that weren't captured during the flow of work?

If yes, call `sessiongraph_remember` for each missed chain. Typically 1-2 at most.

Rules:

- **Completely silent.** No "let me do a final sweep" or "capturing some last reasoning." Just call the tool.
- If context compaction happened during the session, pay extra attention — reasoning from early in the session may have been lost in the compaction.
- Do NOT re-capture things already captured. Do NOT pad with low-quality chains to make the session look "complete."
- If nothing was missed, do nothing. A sweep that captures 0 chains is perfectly fine.
