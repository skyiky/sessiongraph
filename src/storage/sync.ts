import {
  getPendingItems,
  markSynced,
  markFailed,
  getPendingCount,
} from "./buffer.ts";
import { getSupabaseClient } from "./supabase-provider.ts";
import { config } from "../config/config.ts";

/**
 * Sync pending items from local buffer to Supabase.
 * Returns the number of items successfully synced.
 */
export async function syncToSupabase(): Promise<{ synced: number; failed: number }> {
  const pending = getPendingItems(config.sync.batchSize);
  if (pending.length === 0) return { synced: 0, failed: 0 };

  const sb = getSupabaseClient();
  let synced = 0;
  let failed = 0;

  // Group by table for batch inserts
  const grouped = new Map<string, { id: number; data: Record<string, unknown> }[]>();
  for (const item of pending) {
    if (!grouped.has(item.tableName)) grouped.set(item.tableName, []);
    grouped.get(item.tableName)!.push({ id: item.id, data: item.data });
  }

  // Sync in FK order: sessions first, then dependent tables
  const tableOrder = ["sessions", "reasoning_chains", "session_chunks", "chain_relations"];
  const sortedTables = [...grouped.keys()].sort((a, b) => {
    const ai = tableOrder.indexOf(a);
    const bi = tableOrder.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  for (const tableName of sortedTables) {
    const items = grouped.get(tableName)!;
    try {
      const { error } = await sb.from(tableName).upsert(
        items.map((i) => i.data),
        { onConflict: "id" }
      );

      if (error) {
        // Mark all items in this batch as failed
        for (const item of items) {
          markFailed(item.id, error.message);
          failed++;
        }
      } else {
        // Mark all items as synced
        markSynced(items.map((i) => i.id));
        synced += items.length;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      for (const item of items) {
        markFailed(item.id, errorMsg);
        failed++;
      }
    }
  }

  return { synced, failed };
}

/**
 * Start a periodic sync loop.
 * Returns an async cleanup function that waits for any in-flight sync to finish.
 */
export function startSyncLoop(): () => Promise<void> {
  let running = true;

  const loop = async () => {
    while (running) {
      try {
        const pending = getPendingCount();
        if (pending > 0) {
          const result = await syncToSupabase();
          if (result.synced > 0 || result.failed > 0) {
            console.error(
              `[sync] Synced ${result.synced}, failed ${result.failed}, remaining ${getPendingCount()}`
            );
          }
        }
      } catch (err) {
        console.error("[sync] Error:", err);
      }
      await new Promise((resolve) => setTimeout(resolve, config.sync.intervalMs));
    }
  };

  const loopPromise = loop();

  return async () => {
    running = false;
    await loopPromise;
  };
}

/**
 * Get sync status info.
 */
export function getSyncStatus(): { pending: number; isOnline: boolean } {
  return {
    pending: getPendingCount(),
    isOnline: true, // TODO: add actual connectivity check
  };
}
