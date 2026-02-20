import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ChainCard } from "@/components/chain-card";
import type { ReasoningChain } from "@/lib/types";

const mockChain: ReasoningChain = {
  id: "chain-1",
  session_id: "session-1",
  user_id: "user-1",
  type: "decision",
  title: "Chose React over Vue",
  content:
    "After evaluating both frameworks, React was chosen for its ecosystem maturity and team familiarity.",
  context: null,
  tags: ["react", "frontend"],
  created_at: new Date().toISOString(),
};

describe("ChainCard", () => {
  it("renders chain title", () => {
    render(<ChainCard chain={mockChain} />);
    expect(screen.getByText("Chose React over Vue")).toBeInTheDocument();
  });

  it("renders chain content", () => {
    render(<ChainCard chain={mockChain} />);
    expect(
      screen.getByText(/After evaluating both frameworks/)
    ).toBeInTheDocument();
  });

  it("renders chain type badge", () => {
    render(<ChainCard chain={mockChain} />);
    expect(screen.getByText("Decision")).toBeInTheDocument();
  });

  it("renders tags", () => {
    render(<ChainCard chain={mockChain} />);
    expect(screen.getByText("react")).toBeInTheDocument();
    expect(screen.getByText("frontend")).toBeInTheDocument();
  });

  it("renders 'View session' link by default", () => {
    render(<ChainCard chain={mockChain} />);
    const link = screen.getByText("View session →");
    expect(link).toBeInTheDocument();
    expect(link.closest("a")).toHaveAttribute("href", "/sessions/session-1");
  });

  it("hides 'View session' link when hideSessionLink is true", () => {
    render(<ChainCard chain={mockChain} hideSessionLink />);
    expect(screen.queryByText("View session →")).not.toBeInTheDocument();
  });

  it("truncates long content by default", () => {
    const longChain: ReasoningChain = {
      ...mockChain,
      content: "A".repeat(300),
    };
    render(<ChainCard chain={longChain} />);
    expect(screen.getByText(/\.\.\.$/)).toBeInTheDocument();
  });

  it("shows full content when truncate is false", () => {
    const longChain: ReasoningChain = {
      ...mockChain,
      content: "A".repeat(300),
    };
    render(<ChainCard chain={longChain} truncate={false} />);
    expect(screen.getByText("A".repeat(300))).toBeInTheDocument();
  });

  it("shows similarity badge when showSimilarity is true", () => {
    const chainWithSim: ReasoningChain = {
      ...mockChain,
      similarity: 0.85,
    };
    render(<ChainCard chain={chainWithSim} showSimilarity />);
    expect(screen.getByText("85% match")).toBeInTheDocument();
  });

  it("does not show similarity badge when showSimilarity is false", () => {
    const chainWithSim: ReasoningChain = {
      ...mockChain,
      similarity: 0.85,
    };
    render(<ChainCard chain={chainWithSim} />);
    expect(screen.queryByText("85% match")).not.toBeInTheDocument();
  });

  it("does not render session link when session_id is null", () => {
    const orphanChain: ReasoningChain = {
      ...mockChain,
      session_id: null,
    };
    render(<ChainCard chain={orphanChain} />);
    expect(screen.queryByText("View session →")).not.toBeInTheDocument();
  });

  it("renders empty tags gracefully", () => {
    const noTagsChain: ReasoningChain = {
      ...mockChain,
      tags: [],
    };
    render(<ChainCard chain={noTagsChain} />);
    expect(screen.getByText("Chose React over Vue")).toBeInTheDocument();
  });
});
