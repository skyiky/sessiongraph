import { create } from "zustand";
import type { ReasoningChain } from "@/lib/types";

interface SearchState {
  query: string;
  results: ReasoningChain[];
  loading: boolean;
  error: string | null;
  setQuery: (query: string) => void;
  setResults: (results: ReasoningChain[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useSearchStore = create<SearchState>((set) => ({
  query: "",
  results: [],
  loading: false,
  error: null,
  setQuery: (query) => set({ query }),
  setResults: (results) => set({ results }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  reset: () => set({ query: "", results: [], loading: false, error: null }),
}));
