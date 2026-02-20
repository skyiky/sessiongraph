import { GitBranch } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { ChainsBrowser } from "@/components/chains-browser";
import type { ReasoningChain } from "@/lib/types";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Chains",
  description: "Browse reasoning chains by type: decisions, explorations, rejections, solutions, and insights.",
};

const PAGE_SIZE = 20;

export default async function ChainsPage() {
  const supabase = await createClient();

  const [{ data: chainsData, count }, { data: sessions }] = await Promise.all([
    supabase
      .from("reasoning_chains")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE),
    supabase.from("sessions").select("project"),
  ]);

  const chains = (chainsData ?? []) as ReasoningChain[];
  const totalCount = count ?? 0;
  const projects = [
    ...new Set(
      sessions?.filter((s) => s.project).map((s) => s.project as string)
    ),
  ].sort();

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      {/* Header */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <GitBranch className="h-5 w-5 text-primary" />
          <h1 className="font-mono text-2xl font-bold tracking-tight">
            Reasoning Chains
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Browse and filter all captured reasoning chains
        </p>
      </div>

      {/* Interactive browser */}
      <ChainsBrowser
        initialChains={chains}
        initialTotalCount={totalCount}
        projects={projects}
      />
    </div>
  );
}
