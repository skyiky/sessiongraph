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

## Quality Over Quantity

A good session captures 2-6 chains. If you're capturing 10+, you're being too noisy. If you're capturing 0, you're missing reasoning. Aim for chains that would be genuinely useful to recall 3 months from now.
