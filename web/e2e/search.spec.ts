import { test, expect, type Page } from "@playwright/test";

const TEST_EMAIL = "sessiongraph.test@gmail.com";
const TEST_PASSWORD = "testpass123";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(TEST_EMAIL);
  await page.getByLabel("Password").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/", { timeout: 15000 });
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 10000 });
}

test.describe("Search", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("shows empty state before searching", async ({ page }) => {
    await page.goto("/search");

    await expect(page.getByText("Search your reasoning")).toBeVisible();
    await expect(
      page.getByText(/enter a query to semantically search/i)
    ).toBeVisible();
  });

  test("shows type filter buttons", async ({ page }) => {
    await page.goto("/search");

    // Should show all 5 type filter buttons
    await expect(page.getByRole("button", { name: "Decision" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Exploration" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Rejection" })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Solution" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Insight" })).toBeVisible();
  });

  test("performs semantic search and shows results", async ({ page }) => {
    await page.goto("/search");

    // Type a search query
    const searchInput = page.getByPlaceholder(/search/i);
    await searchInput.fill("database migration");

    // Wait for results to appear (the hook debounces, so give it time)
    await expect(page.getByText(/result/i)).toBeVisible({ timeout: 15000 });

    // Should show at least one chain card in results
    const resultCards = page.locator('[class*="rounded-xl border"]');
    await expect(resultCards.first()).toBeVisible();
  });

  test("quick search on dashboard navigates to search page", async ({
    page,
  }) => {
    // Start on dashboard
    await page.goto("/");

    // Use the quick search
    const quickSearch = page.getByPlaceholder(/search/i);
    await quickSearch.fill("error handling");
    await quickSearch.press("Enter");

    // Should navigate to /search with the query
    await expect(page).toHaveURL(/\/search/);
  });

  test("type filter toggles work", async ({ page }) => {
    await page.goto("/search");

    // Search first to get results
    const searchInput = page.getByPlaceholder(/search/i);
    await searchInput.fill("architecture");

    // Wait for results
    await expect(page.getByText(/result/i)).toBeVisible({ timeout: 15000 });

    // Click a type filter
    await page.getByRole("button", { name: "Decision" }).click();

    // "Clear filters" link should appear
    await expect(page.getByText("Clear filters")).toBeVisible();

    // Click clear to reset
    await page.getByText("Clear filters").first().click();
  });
});
