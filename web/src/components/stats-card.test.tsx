import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { StatsCard } from "@/components/stats-card";
import { GitBranch } from "lucide-react";

describe("StatsCard", () => {
  it("renders label and numeric value", () => {
    render(<StatsCard label="Total Chains" value={630} icon={GitBranch} />);
    expect(screen.getByText("Total Chains")).toBeInTheDocument();
    expect(screen.getByText("630")).toBeInTheDocument();
  });

  it("renders string value", () => {
    render(<StatsCard label="Most Common" value="decision" icon={GitBranch} />);
    expect(screen.getByText("decision")).toBeInTheDocument();
  });

  it("renders zero value", () => {
    render(<StatsCard label="Sessions" value={0} icon={GitBranch} />);
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    const { container } = render(
      <StatsCard label="Test" value={1} icon={GitBranch} className="my-class" />
    );
    expect(container.firstChild).toHaveClass("my-class");
  });
});
