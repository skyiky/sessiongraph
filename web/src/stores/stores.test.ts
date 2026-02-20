import { describe, it, expect, beforeEach } from "vitest";
import { useSearchStore } from "@/stores/search-store";
import { useFilterStore } from "@/stores/filter-store";
import { useUIStore } from "@/stores/ui-store";
import type { ReasoningChain } from "@/lib/types";

const mockChain: ReasoningChain = {
  id: "1",
  session_id: "s1",
  user_id: "u1",
  type: "decision",
  title: "Test",
  content: "Test content",
  context: null,
  tags: [],
  created_at: new Date().toISOString(),
};

describe("useSearchStore", () => {
  beforeEach(() => {
    useSearchStore.getState().reset();
  });

  it("starts with empty state", () => {
    const state = useSearchStore.getState();
    expect(state.query).toBe("");
    expect(state.results).toEqual([]);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it("sets query", () => {
    useSearchStore.getState().setQuery("test query");
    expect(useSearchStore.getState().query).toBe("test query");
  });

  it("sets results", () => {
    useSearchStore.getState().setResults([mockChain]);
    expect(useSearchStore.getState().results).toHaveLength(1);
    expect(useSearchStore.getState().results[0].id).toBe("1");
  });

  it("sets loading", () => {
    useSearchStore.getState().setLoading(true);
    expect(useSearchStore.getState().loading).toBe(true);
  });

  it("sets error", () => {
    useSearchStore.getState().setError("Something went wrong");
    expect(useSearchStore.getState().error).toBe("Something went wrong");
  });

  it("resets to initial state", () => {
    useSearchStore.getState().setQuery("test");
    useSearchStore.getState().setResults([mockChain]);
    useSearchStore.getState().setLoading(true);
    useSearchStore.getState().setError("err");
    useSearchStore.getState().reset();

    const state = useSearchStore.getState();
    expect(state.query).toBe("");
    expect(state.results).toEqual([]);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });
});

describe("useFilterStore", () => {
  beforeEach(() => {
    useFilterStore.getState().resetFilters();
  });

  it("starts with no filters", () => {
    const state = useFilterStore.getState();
    expect(state.selectedTypes).toEqual([]);
    expect(state.selectedProject).toBeNull();
    expect(state.dateRange.from).toBeNull();
    expect(state.dateRange.to).toBeNull();
  });

  it("toggles type on", () => {
    useFilterStore.getState().toggleType("decision");
    expect(useFilterStore.getState().selectedTypes).toEqual(["decision"]);
  });

  it("toggles type off", () => {
    useFilterStore.getState().toggleType("decision");
    useFilterStore.getState().toggleType("decision");
    expect(useFilterStore.getState().selectedTypes).toEqual([]);
  });

  it("toggles multiple types", () => {
    useFilterStore.getState().toggleType("decision");
    useFilterStore.getState().toggleType("insight");
    expect(useFilterStore.getState().selectedTypes).toEqual([
      "decision",
      "insight",
    ]);
  });

  it("sets project", () => {
    useFilterStore.getState().setProject("sessiongraph");
    expect(useFilterStore.getState().selectedProject).toBe("sessiongraph");
  });

  it("clears project with null", () => {
    useFilterStore.getState().setProject("sessiongraph");
    useFilterStore.getState().setProject(null);
    expect(useFilterStore.getState().selectedProject).toBeNull();
  });

  it("sets date range", () => {
    const from = new Date("2026-01-01");
    const to = new Date("2026-02-01");
    useFilterStore.getState().setDateRange({ from, to });
    expect(useFilterStore.getState().dateRange.from).toEqual(from);
    expect(useFilterStore.getState().dateRange.to).toEqual(to);
  });

  it("resets all filters", () => {
    useFilterStore.getState().toggleType("decision");
    useFilterStore.getState().setProject("test");
    useFilterStore
      .getState()
      .setDateRange({ from: new Date(), to: new Date() });
    useFilterStore.getState().resetFilters();

    const state = useFilterStore.getState();
    expect(state.selectedTypes).toEqual([]);
    expect(state.selectedProject).toBeNull();
    expect(state.dateRange.from).toBeNull();
    expect(state.dateRange.to).toBeNull();
  });
});

describe("useUIStore", () => {
  beforeEach(() => {
    useUIStore.getState().setSidebarCollapsed(false);
  });

  it("starts with sidebar expanded", () => {
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });

  it("toggles sidebar", () => {
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });

  it("sets sidebar collapsed directly", () => {
    useUIStore.getState().setSidebarCollapsed(true);
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
  });
});
