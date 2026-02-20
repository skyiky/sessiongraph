import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ChainTypeBadge } from "@/components/chain-type-badge";
import type { ChainType } from "@/lib/types";

describe("ChainTypeBadge", () => {
  const types: { type: ChainType; label: string }[] = [
    { type: "decision", label: "Decision" },
    { type: "exploration", label: "Exploration" },
    { type: "rejection", label: "Rejection" },
    { type: "solution", label: "Solution" },
    { type: "insight", label: "Insight" },
  ];

  types.forEach(({ type, label }) => {
    it(`renders ${label} badge for type "${type}"`, () => {
      render(<ChainTypeBadge type={type} />);
      expect(screen.getByText(label)).toBeInTheDocument();
    });
  });

  it("applies custom className", () => {
    const { container } = render(
      <ChainTypeBadge type="decision" className="custom-class" />
    );
    expect(container.firstChild).toHaveClass("custom-class");
  });
});
