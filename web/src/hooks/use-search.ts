"use client";

import { useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useSearchStore } from "@/stores/search-store";
import { useFilterStore } from "@/stores/filter-store";
import type { ReasoningChain } from "@/lib/types";

const DEBOUNCE_MS = 300;

export function useSearch() {
  const supabase = createClient();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const searchParams = useSearchParams();

  const { query, results, loading, error, setQuery, setResults, setLoading, setError, reset } =
    useSearchStore();
  const { selectedTypes, selectedProject } = useFilterStore();

  const executeSearch = useCallback(
    async (searchQuery: string) => {
      // Cancel any in-flight request
      if (abortRef.current) {
        abortRef.current.abort();
      }
      abortRef.current = new AbortController();

      const trimmed = searchQuery.trim();
      if (!trimmed) {
        setResults([]);
        setLoading(false);
        setError(null);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        // Get current user
        const {
          data: { user },
          error: authError,
        } = await supabase.auth.getUser();

        if (authError || !user) {
          setError("You must be signed in to search.");
          setLoading(false);
          return;
        }

        // Generate embedding from query text
        const { data: embeddingData, error: embeddingError } =
          await supabase.functions.invoke("generate-embedding", {
            body: { text: trimmed },
          });

        if (embeddingError) {
          setError("Failed to generate search embedding. Please try again.");
          setLoading(false);
          return;
        }

        const embedding = embeddingData?.embedding;
        if (!embedding) {
          setError("Invalid embedding response.");
          setLoading(false);
          return;
        }

        // Search reasoning chains via RPC
        const { data: searchResults, error: searchError } = await supabase.rpc(
          "search_reasoning",
          {
            query_embedding: embedding,
            filter_user_id: user.id,
            match_threshold: 0.7,
            match_count: 20,
          }
        );

        if (searchError) {
          setError("Search failed. Please try again.");
          setLoading(false);
          return;
        }

        // Abort guard — if this request was cancelled, discard results
        if (abortRef.current?.signal.aborted) {
          return;
        }

        setResults((searchResults as ReasoningChain[]) ?? []);
      } catch (err) {
        // Ignore abort errors
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        setError("An unexpected error occurred. Please try again.");
      } finally {
        setLoading(false);
      }
    },
    [supabase, setResults, setLoading, setError]
  );

  const debouncedSearch = useCallback(
    (searchQuery: string) => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        executeSearch(searchQuery);
      }, DEBOUNCE_MS);
    },
    [executeSearch]
  );

  const handleQueryChange = useCallback(
    (newQuery: string) => {
      setQuery(newQuery);
      debouncedSearch(newQuery);
    },
    [setQuery, debouncedSearch]
  );

  const clearSearch = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    if (abortRef.current) {
      abortRef.current.abort();
    }
    reset();
  }, [reset]);

  // Read initial query from URL search params on mount
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    const urlQuery = searchParams.get("q");
    if (urlQuery && urlQuery.trim()) {
      setQuery(urlQuery.trim());
      executeSearch(urlQuery.trim());
    }
  }, [searchParams, setQuery, executeSearch]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, []);

  // Client-side filtering by type and project
  const filteredResults = results.filter((chain) => {
    const typeMatch =
      selectedTypes.length === 0 || selectedTypes.includes(chain.type);
    const projectMatch =
      !selectedProject || chain.session_id === selectedProject;
    return typeMatch && projectMatch;
  });

  return {
    query,
    results: filteredResults,
    allResults: results,
    loading,
    error,
    handleQueryChange,
    clearSearch,
    executeSearch,
  };
}
