import { parseNewSessions, type ParsedSession } from "./parsers/opencode.ts";
import { extractWithOllama } from "../backfill/ollama-extractor.ts";
import { enqueue, enqueueBatch, getSyncState, setSyncState } from "../storage/buffer.ts";
import { generateEmbedding, generateEmbeddings } from "../storage/supabase.ts";
import type { ReasoningChain, Session, SessionChunk } from "../config/types.ts";

const SYNC_STATE_KEY = "opencode_last_sync";

/**
 * Run the ingestion pipeline for OpenCode sessions.
 * 
 * 1. Find new sessions since last sync
 * 2. For each session, extract reasoning chains
 * 3. Generate embeddings
 * 4. Queue everything for sync to Supabase
 * 
 * Returns the number of sessions processed and chains extracted.
 */
export async function ingestOpenCodeSessions(userId: string): Promise<{
  sessionsProcessed: number;
  chainsExtracted: number;
}> {
  // Get last sync timestamp
  const lastSync = getSyncState(SYNC_STATE_KEY);
  const sinceTimestamp = lastSync ? parseInt(lastSync, 10) : undefined;

  // Parse new sessions from OpenCode
  const newSessions = parseNewSessions(sinceTimestamp);
  if (newSessions.length === 0) {
    return { sessionsProcessed: 0, chainsExtracted: 0 };
  }

  console.error(`[ingest] Found ${newSessions.length} new OpenCode sessions to process`);

  let totalChains = 0;
  let latestTimestamp = sinceTimestamp ?? 0;

  for (const parsed of newSessions) {
    try {
      // Track the latest timestamp for sync state
      if (parsed.session.updatedAt > latestTimestamp) {
        latestTimestamp = parsed.session.updatedAt;
      }

      // Skip very short sessions (< 4 conversation turns)
      if (parsed.conversation.length < 4) {
        console.error(`[ingest] Skipping session ${parsed.session.id} (too short: ${parsed.conversation.length} turns)`);
        continue;
      }

      // Extract project name from path
      const projectName = parsed.session.projectPath
        ? parsed.session.projectPath.split(/[\\/]/).pop() ?? parsed.session.projectPath
        : undefined;

      // Queue session for sync
      const sessionData: Record<string, unknown> = {
        id: parsed.session.id,
        user_id: userId,
        tool: "opencode",
        project: projectName,
        started_at: new Date(parsed.session.createdAt).toISOString(),
        ended_at: new Date(parsed.session.updatedAt).toISOString(),
        summary: parsed.session.title || null,
        metadata: {
          opencode_project_id: parsed.session.projectId,
          project_path: parsed.session.projectPath,
          message_count: parsed.conversation.length,
        },
      };
      enqueue("sessions", sessionData);

      // Queue session chunks (raw conversation for reference)
      const chunkItems = parsed.conversation.map((turn, idx) => ({
        tableName: "session_chunks",
        data: {
          session_id: parsed.session.id,
          user_id: userId,
          role: turn.role,
          content: turn.parts
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("\n"),
          chunk_index: idx,
        } as Record<string, unknown>,
      }));
      enqueueBatch(chunkItems.filter((c) => (c.data.content as string).trim().length > 0));

      // Extract reasoning chains via Ollama
      const chains = await extractWithOllama(parsed.conversationText);

      if (chains.length === 0) {
        console.error(`[ingest] No reasoning chains found in session ${parsed.session.id}`);
        continue;
      }

      console.error(`[ingest] Extracted ${chains.length} reasoning chains from session ${parsed.session.id}`);

      // Generate embeddings for all chains
      let embeddings: number[][] = [];
      try {
        const texts = chains.map((c) => `${c.title}\n${c.content}`);
        embeddings = await generateEmbeddings(texts);
      } catch (err) {
        console.error(`[ingest] Failed to generate embeddings, will store without:`, err);
        embeddings = chains.map(() => []);
      }

      // Queue reasoning chains for sync
      const chainItems = chains.map((chain, idx) => ({
        tableName: "reasoning_chains",
        data: {
          session_id: parsed.session.id,
          user_id: userId,
          type: chain.type,
          title: chain.title,
          content: chain.content,
          context: null,
          tags: chain.tags,
          embedding: embeddings[idx] && embeddings[idx].length > 0 ? embeddings[idx] : null,
        } as Record<string, unknown>,
      }));
      enqueueBatch(chainItems);

      totalChains += chains.length;
    } catch (err) {
      console.error(`[ingest] Error processing session ${parsed.session.id}:`, err);
    }

    // Update sync state incrementally after each session so we don't
    // reprocess sessions if the pipeline is interrupted
    if (latestTimestamp > 0) {
      setSyncState(SYNC_STATE_KEY, String(latestTimestamp));
    }
  }

  return {
    sessionsProcessed: newSessions.length,
    chainsExtracted: totalChains,
  };
}
