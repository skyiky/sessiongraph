"use client";

import { useState, useCallback } from "react";
import { Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { ChainCard } from "@/components/chain-card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { REASONING_TYPES } from "@/lib/types";
import type { ReasoningChain, ChainType } from "@/lib/types";

const PAGE_SIZE = 20;

const TYPE_STYLES: Record<
  ChainType,
  { active: string; inactive: string; label: string }
> = {
  decision: {
    active:
      "bg-chain-decision/15 text-chain-decision border-chain-decision/30",
    inactive:
      "bg-transparent text-muted-foreground border-border hover:text-chain-decision hover:border-chain-decision/20",
    label: "Decision",
  },
  exploration: {
    active:
      "bg-chain-exploration/15 text-chain-exploration border-chain-exploration/30",
    inactive:
      "bg-transparent text-muted-foreground border-border hover:text-chain-exploration hover:border-chain-exploration/20",
    label: "Exploration",
  },
  rejection: {
    active:
      "bg-chain-rejection/15 text-chain-rejection border-chain-rejection/30",
    inactive:
      "bg-transparent text-muted-foreground border-border hover:text-chain-rejection hover:border-chain-rejection/20",
    label: "Rejection",
  },
  solution: {
    active:
      "bg-chain-solution/15 text-chain-solution border-chain-solution/30",
    inactive:
      "bg-transparent text-muted-foreground border-border hover:text-chain-solution hover:border-chain-solution/20",
    label: "Solution",
  },
  insight: {
    active:
      "bg-chain-insight/15 text-chain-insight border-chain-insight/30",
    inactive:
      "bg-transparent text-muted-foreground border-border hover:text-chain-insight hover:border-chain-insight/20",
    label: "Insight",
  },
};

interface ChainsBrowserProps {
  initialChains: ReasoningChain[];
  initialTotalCount: number;
  projects: string[];
}

export function ChainsBrowser({
  initialChains,
  initialTotalCount,
  projects,
}: ChainsBrowserProps) {
  const [chains, setChains] = useState<ReasoningChain[]>(initialChains);
  const [totalCount, setTotalCount] = useState(initialTotalCount);
  const [selectedTypes, setSelectedTypes] = useState<Set<ChainType>>(new Set());
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isFiltering, setIsFiltering] = useState(false);

  const supabase = createClient();

  const fetchSessionIdsForProject = useCallback(
    async (project: string): Promise<string[]> => {
      const { data } = await supabase
        .from("sessions")
        .select("id")
        .eq("project", project);
      return data?.map((s) => s.id) ?? [];
    },
    [supabase]
  );

  const buildQuery = useCallback(
    (
      types: Set<ChainType>,
      project: string | null,
      sessionIds: string[] | null
    ) => {
      let query = supabase
        .from("reasoning_chains")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false });

      if (types.size > 0) {
        query = query.in("type", [...types]);
      }

      if (project && sessionIds && sessionIds.length > 0) {
        query = query.in("session_id", sessionIds);
      } else if (project && (!sessionIds || sessionIds.length === 0)) {
        // Project selected but has no sessions — return impossible filter
        query = query.eq("session_id", "no-match-placeholder");
      }

      return query;
    },
    [supabase]
  );

  const applyFilters = useCallback(
    async (types: Set<ChainType>, project: string | null) => {
      setIsFiltering(true);
      try {
        let sessionIds: string[] | null = null;
        if (project) {
          sessionIds = await fetchSessionIdsForProject(project);
        }

        const { data, count } = await buildQuery(
          types,
          project,
          sessionIds
        ).limit(PAGE_SIZE);

        setChains((data ?? []) as ReasoningChain[]);
        setTotalCount(count ?? 0);
      } finally {
        setIsFiltering(false);
      }
    },
    [buildQuery, fetchSessionIdsForProject]
  );

  const toggleType = useCallback(
    (type: ChainType) => {
      const next = new Set(selectedTypes);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      setSelectedTypes(next);
      applyFilters(next, selectedProject);
    },
    [selectedTypes, selectedProject, applyFilters]
  );

  const handleProjectChange = useCallback(
    (value: string) => {
      const project = value === "all" ? null : value;
      setSelectedProject(project);
      applyFilters(selectedTypes, project);
    },
    [selectedTypes, applyFilters]
  );

  const loadMore = useCallback(async () => {
    setIsLoadingMore(true);
    try {
      let sessionIds: string[] | null = null;
      if (selectedProject) {
        sessionIds = await fetchSessionIdsForProject(selectedProject);
      }

      const offset = chains.length;
      const { data, count } = await buildQuery(
        selectedTypes,
        selectedProject,
        sessionIds
      ).range(offset, offset + PAGE_SIZE - 1);

      if (data) {
        setChains((prev) => [...prev, ...(data as ReasoningChain[])]);
      }
      if (count !== null) {
        setTotalCount(count);
      }
    } finally {
      setIsLoadingMore(false);
    }
  }, [
    chains.length,
    selectedTypes,
    selectedProject,
    buildQuery,
    fetchSessionIdsForProject,
  ]);

  const remaining = totalCount - chains.length;
  const nextLoadSize = Math.min(PAGE_SIZE, remaining);

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        {/* Type toggles */}
        <div className="flex flex-wrap gap-2">
          {REASONING_TYPES.map((type) => {
            const isActive = selectedTypes.has(type);
            const style = TYPE_STYLES[type];
            return (
              <button
                key={type}
                onClick={() => toggleType(type)}
                disabled={isFiltering}
                className={cn(
                  "inline-flex items-center rounded-md border px-3 py-1.5 font-mono text-xs font-medium transition-colors",
                  isActive ? style.active : style.inactive,
                  isFiltering && "opacity-50 cursor-not-allowed"
                )}
              >
                {style.label}
              </button>
            );
          })}
        </div>

        {/* Project filter */}
        {projects.length > 0 && (
          <Select
            value={selectedProject ?? "all"}
            onValueChange={handleProjectChange}
            disabled={isFiltering}
          >
            <SelectTrigger className="w-[200px] font-mono text-xs">
              <SelectValue placeholder="All projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All projects</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project} value={project}>
                  {project}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Count header */}
      <div className="flex items-center gap-2">
        <p className="font-mono text-sm text-muted-foreground">
          {totalCount} {totalCount === 1 ? "chain" : "chains"}
        </p>
        {isFiltering && (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        )}
      </div>

      {/* Chains grid */}
      {chains.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {chains.map((chain) => (
            <ChainCard key={chain.id} chain={chain} truncate />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <p className="font-mono text-sm text-muted-foreground">
            {isFiltering
              ? "Searching..."
              : "No chains match the current filters."}
          </p>
        </div>
      )}

      {/* Load more */}
      {remaining > 0 && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            onClick={loadMore}
            disabled={isLoadingMore}
            className="font-mono text-xs"
          >
            {isLoadingMore ? (
              <>
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                Loading...
              </>
            ) : (
              <>
                Load {nextLoadSize} more of {remaining} remaining
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
