# SessionGraph - Key Concepts

## What is an Embedding?

An embedding is a list of numbers (a vector) that represents the **meaning** of a piece of text. For example:

```
"I chose Postgres over SQLite" → [0.12, -0.45, 0.78, 0.33, ...]  (1024 numbers)
"I picked Postgres instead of SQLite" → [0.11, -0.44, 0.79, 0.32, ...]  (very similar numbers)
"I like pizza" → [0.91, 0.22, -0.56, 0.01, ...]  (very different numbers)
```

Texts with similar meaning produce similar numbers. Texts with different meaning produce different numbers. That's what makes search work -- when you ask "why did we choose our database?", your query gets converted to numbers, and we find stored chains whose numbers are closest.

### Why does it need a model?

The hard part is: **how do you turn words into meaningful numbers?** A simple approach like "assign each word a number" doesn't capture meaning -- it wouldn't know that "chose" and "picked" mean the same thing, or that "Postgres" and "database" are related.

An embedding model is a neural network that was trained on massive amounts of text to learn these relationships. It doesn't generate text or reason. It's more like a very sophisticated **translation function**: text in, numbers out. It learned during training that semantically similar text should map to nearby points in vector space.

### Why not just use keyword search?

You could, but it fails on meaning. If you stored "Chose PGlite for local storage" and searched for "database decision", keyword search finds nothing -- no words match. Embedding search finds it because the model understands those concepts are related.

### Embedding models vs Chat LLMs

Embedding models are simpler and faster than chat LLMs. They share similar architecture (transformers, trained on text), but serve different purposes:

| | Chat LLM (qwen2.5:3b) | Embedding model (qwen3-embedding:0.6b) |
|---|---|---|
| **Input** | Text | Text |
| **Output** | More text (generated) | A fixed-size list of numbers |
| **Purpose** | Understand + reason + write | Capture meaning as numbers |
| **Speed** | Slow (generates token by token) | Fast (single forward pass) |

The bigger the embedding model, the better it understands nuance and produces more meaningful numbers. It's the same idea as why GPT-4 understands things better than a small model, just applied to the "text to numbers" task instead of "text to text".

## Backfill Pipeline

The backfill pipeline processes old AI coding sessions to extract reasoning chains and store them for search. It has two stages per session:

### Stage 1: Extraction (Chat LLM)

Ollama loads the chat model (`qwen2.5:3b`) and reads the raw conversation text from an old OpenCode session. The LLM identifies reasoning chains -- decisions, rejections, insights, explorations, solutions -- from the conversation. This is the "thinking" step; it requires a generative model that can understand context and produce structured output.

This happens in `src/backfill/ollama-extractor.ts`.

### Stage 2: Embedding (Embedding Model)

Once the extractor produces reasoning chains (title, content, type, tags), each chain's text gets converted into a vector so it can be stored in pgvector and searched via cosine similarity later. This uses a different kind of model that doesn't generate text -- it just maps text to a point in vector space.

### How they work together

During backfill, Ollama alternates between the two models for each session:

```
For each session:
  1. Load qwen2.5:3b → extract reasoning chains from conversation
  2. Load embedding model → vectorize each chain's text
  3. Store chains + vectors in PGlite
  4. Repeat for next session
```

Ollama swaps models in and out of VRAM as needed. Only one model is loaded at a time.

### Real-time capture vs backfill

Outside of backfill (normal usage), only the **embedding model** runs:

- **`remember`** -- embeds the reasoning text and stores it with its vector
- **`recall`** -- embeds your search query and finds stored chains with similar vectors

The extraction model (`qwen2.5:3b`) isn't needed during normal usage because the AI agent does the extraction in real-time via the `auto-reasoning-capture` skill. The agent identifies reasoning chains as they happen and calls `remember` directly -- no post-hoc extraction needed.

This is why backfill exists: it retroactively processes old sessions that happened before SessionGraph was installed.
