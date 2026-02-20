"use client";

import { Suspense } from "react";
import { Search, Filter } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { ChainCard } from "@/components/chain-card";
import { SearchInput } from "@/components/search-input";
import { useSearch } from "@/hooks/use-search";
import { useFilterStore } from "@/stores/filter-store";
import { REASONING_TYPES, type ChainType } from "@/lib/types";
import { cn } from "@/lib/utils";

const TYPE_STYLES: Record<ChainType, { active: string; inactive: string }> = {
  decision: {
    active:
      "bg-chain-decision/20 text-chain-decision border-chain-decision/40 hover:bg-chain-decision/30",
    inactive:
      "bg-transparent text-muted-foreground border-border hover:bg-chain-decision/10 hover:text-chain-decision hover:border-chain-decision/30",
  },
  exploration: {
    active:
      "bg-chain-exploration/20 text-chain-exploration border-chain-exploration/40 hover:bg-chain-exploration/30",
    inactive:
      "bg-transparent text-muted-foreground border-border hover:bg-chain-exploration/10 hover:text-chain-exploration hover:border-chain-exploration/30",
  },
  rejection: {
    active:
      "bg-chain-rejection/20 text-chain-rejection border-chain-rejection/40 hover:bg-chain-rejection/30",
    inactive:
      "bg-transparent text-muted-foreground border-border hover:bg-chain-rejection/10 hover:text-chain-rejection hover:border-chain-rejection/30",
  },
  solution: {
    active:
      "bg-chain-solution/20 text-chain-solution border-chain-solution/40 hover:bg-chain-solution/30",
    inactive:
      "bg-transparent text-muted-foreground border-border hover:bg-chain-solution/10 hover:text-chain-solution hover:border-chain-solution/30",
  },
  insight: {
    active:
      "bg-chain-insight/20 text-chain-insight border-chain-insight/40 hover:bg-chain-insight/30",
    inactive:
      "bg-transparent text-muted-foreground border-border hover:bg-chain-insight/10 hover:text-chain-insight hover:border-chain-insight/30",
  },
};

const TYPE_LABELS: Record<ChainType, string> = {
  decision: "Decision",
  exploration: "Exploration",
  rejection: "Rejection",
  solution: "Solution",
  insight: "Insight",
};

function SearchPageContent() {
  const { query, results, allResults, loading, error, handleQueryChange, clearSearch } =
    useSearch();
  const { selectedTypes, toggleType, resetFilters } = useFilterStore();

  const hasQuery = query.trim().length > 0;
  const hasResults = results.length > 0;
  const hasFilters = selectedTypes.length > 0;
  const isFiltered = hasFilters && allResults.length !== results.length;

  // Compute similarity stats for display
  const avgSimilarity =
    results.length > 0
      ? results.reduce((sum, r) => sum + (r.similarity ?? 0), 0) / results.length
      : 0;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Header */}
      <div>
        <h1 className="font-mono text-2xl font-bold tracking-tight">Search</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Find reasoning chains using semantic search
        </p>
      </div>

      {/* Search input */}
      <SearchInput
        value={query}
        onChange={handleQueryChange}
        onClear={clearSearch}
        loading={loading}
        autoFocus
      />

      {/* Filter controls */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Filter className="h-3.5 w-3.5" />
          <span>Type</span>
        </div>
        {REASONING_TYPES.map((type) => {
          const isActive = selectedTypes.includes(type);
          const styles = TYPE_STYLES[type];
          return (
            <button
              key={type}
              onClick={() => toggleType(type)}
              className={cn(
                "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors cursor-pointer",
                isActive ? styles.active : styles.inactive
              )}
            >
              {TYPE_LABELS[type]}
            </button>
          );
        })}
        {hasFilters && (
          <button
            onClick={resetFilters}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline cursor-pointer"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Error state */}
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-border p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <Skeleton className="h-5 w-24" />
                  <Skeleton className="h-4 w-16" />
                </div>
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-16 w-full" />
                <div className="flex gap-1">
                  <Skeleton className="h-5 w-12" />
                  <Skeleton className="h-5 w-16" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty prompt — no query entered yet */}
      {!loading && !hasQuery && !error && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
            <Search className="h-7 w-7 text-muted-foreground" />
          </div>
          <h2 className="mt-4 font-mono text-base font-semibold text-foreground">
            Search your reasoning
          </h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Enter a query to semantically search across all your decisions,
            explorations, solutions, and insights.
          </p>
        </div>
      )}

      {/* No results */}
      {!loading && hasQuery && !hasResults && !error && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
            <Search className="h-7 w-7 text-muted-foreground" />
          </div>
          <h2 className="mt-4 font-mono text-base font-semibold text-foreground">
            No results found
          </h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            {isFiltered
              ? `No chains match the selected type filters. ${allResults.length} result${allResults.length === 1 ? "" : "s"} found before filtering.`
              : "Try rephrasing your query or using different keywords."}
          </p>
          {isFiltered && (
            <button
              onClick={resetFilters}
              className="mt-3 text-sm text-primary hover:underline cursor-pointer"
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {/* Results */}
      {!loading && hasResults && (
        <div className="space-y-4">
          {/* Results summary */}
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {results.length} result{results.length === 1 ? "" : "s"}
              {isFiltered && ` (filtered from ${allResults.length})`}
            </span>
            {avgSimilarity > 0 && (
              <span className="font-mono text-xs">
                avg. {Math.round(avgSimilarity * 100)}% similarity
              </span>
            )}
          </div>

          {/* Results grid */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {results.map((chain) => (
              <ChainCard
                key={chain.id}
                chain={chain}
                showSimilarity
                className="h-full"
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-4xl space-y-6">
          <div>
            <Skeleton className="h-8 w-32" />
            <Skeleton className="mt-2 h-4 w-64" />
          </div>
          <Skeleton className="h-12 w-full rounded-xl" />
        </div>
      }
    >
      <SearchPageContent />
    </Suspense>
  );
}
