import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { QuickSearch } from "@/components/quick-search";

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

describe("QuickSearch", () => {
  it("renders search input", () => {
    render(<QuickSearch />);
    expect(
      screen.getByPlaceholderText("Search reasoning chains...")
    ).toBeInTheDocument();
  });

  it("navigates to /search on submit", async () => {
    const user = userEvent.setup();
    render(<QuickSearch />);

    const input = screen.getByPlaceholderText("Search reasoning chains...");
    await user.type(input, "how to handle auth");
    await user.keyboard("{Enter}");

    expect(mockPush).toHaveBeenCalledWith(
      "/search?q=how%20to%20handle%20auth"
    );
  });

  it("does not navigate on empty submit", async () => {
    mockPush.mockClear();
    const user = userEvent.setup();
    render(<QuickSearch />);

    const input = screen.getByPlaceholderText("Search reasoning chains...");
    await user.click(input);
    await user.keyboard("{Enter}");

    expect(mockPush).not.toHaveBeenCalled();
  });

  it("does not navigate on whitespace-only submit", async () => {
    mockPush.mockClear();
    const user = userEvent.setup();
    render(<QuickSearch />);

    const input = screen.getByPlaceholderText("Search reasoning chains...");
    await user.type(input, "   ");
    await user.keyboard("{Enter}");

    expect(mockPush).not.toHaveBeenCalled();
  });
});
