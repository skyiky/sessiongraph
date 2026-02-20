import { create } from "zustand";
import type { ChainType } from "@/lib/types";

interface FilterState {
  selectedTypes: ChainType[];
  selectedProject: string | null;
  dateRange: { from: Date | null; to: Date | null };
  toggleType: (type: ChainType) => void;
  setProject: (project: string | null) => void;
  setDateRange: (range: { from: Date | null; to: Date | null }) => void;
  resetFilters: () => void;
}

export const useFilterStore = create<FilterState>((set) => ({
  selectedTypes: [],
  selectedProject: null,
  dateRange: { from: null, to: null },
  toggleType: (type) =>
    set((state) => ({
      selectedTypes: state.selectedTypes.includes(type)
        ? state.selectedTypes.filter((t) => t !== type)
        : [...state.selectedTypes, type],
    })),
  setProject: (project) => set({ selectedProject: project }),
  setDateRange: (range) => set({ dateRange: range }),
  resetFilters: () =>
    set({
      selectedTypes: [],
      selectedProject: null,
      dateRange: { from: null, to: null },
    }),
}));
