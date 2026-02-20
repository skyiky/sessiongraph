import { History, GitBranch, FolderOpen, Zap } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { StatsCard } from "@/components/stats-card";
import { ChainCard } from "@/components/chain-card";
import { QuickSearch } from "@/components/quick-search";
import type { ReasoningChain, ChainType } from "@/lib/types";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Overview of your AI coding sessions and reasoning chains.",
};

export default async function DashboardPage() {
  const supabase = await createClient();

  const [
    { count: sessionCount },
    { count: chainCount },
    { data: typeCounts },
    { data: projects },
    { data: recentChains },
  ] = await Promise.all([
    supabase.from("sessions").select("*", { count: "exact", head: true }),
    supabase
      .from("reasoning_chains")
      .select("*", { count: "exact", head: true }),
    supabase.from("reasoning_chains").select("type"),
    supabase.from("sessions").select("project"),
    supabase
      .from("reasoning_chains")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const projectCount = projects
    ? new Set(projects.filter((p) => p.project).map((p) => p.project)).size
    : 0;

  const typeFrequency: Partial<Record<ChainType, number>> = {};
  if (typeCounts) {
    for (const row of typeCounts) {
      const t = row.type as ChainType;
      typeFrequency[t] = (typeFrequency[t] ?? 0) + 1;
    }
  }

  const mostCommonType =
    Object.keys(typeFrequency).length > 0
      ? (Object.entries(typeFrequency).sort(
          ([, a], [, b]) => b - a
        )[0][0] as ChainType)
      : null;

  const chains = (recentChains ?? []) as ReasoningChain[];

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      {/* Header */}
      <div className="space-y-1">
        <h1 className="font-mono text-2xl font-bold tracking-tight">
          Dashboard
        </h1>
        <p className="text-sm text-muted-foreground">
          {chainCount ?? 0} reasoning chains across {sessionCount ?? 0} sessions
        </p>
      </div>

      {/* Quick search */}
      <div className="max-w-lg">
        <QuickSearch />
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatsCard
          label="Total Sessions"
          value={sessionCount ?? 0}
          icon={History}
        />
        <StatsCard
          label="Total Chains"
          value={chainCount ?? 0}
          icon={GitBranch}
        />
        <StatsCard
          label="Projects"
          value={projectCount}
          icon={FolderOpen}
        />
        <StatsCard
          label="Most Common Type"
          value={mostCommonType ?? "—"}
          icon={Zap}
        />
      </div>

      {/* Recent chains */}
      <section className="space-y-4">
        <h2 className="font-mono text-lg font-semibold tracking-tight">
          Recent Chains
        </h2>

        {chains.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {chains.map((chain) => (
              <ChainCard key={chain.id} chain={chain} truncate />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <p className="text-sm text-muted-foreground">
              No reasoning chains yet. Start a session to capture your first
              chain.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
