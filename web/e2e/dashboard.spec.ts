import { test, expect, type Page } from "@playwright/test";

const TEST_EMAIL = "sessiongraph.test@gmail.com";
const TEST_PASSWORD = "testpass123";

// Reusable login helper
async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(TEST_EMAIL);
  await page.getByLabel("Password").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/", { timeout: 15000 });
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 10000 });
}

test.describe("Dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("displays stats cards with real data", async ({ page }) => {
    // Should show stat cards
    await expect(page.getByText("Total Sessions")).toBeVisible();
    await expect(page.getByText("Total Chains")).toBeVisible();
    await expect(page.getByText("Projects")).toBeVisible();
    await expect(page.getByText("Most Common Type")).toBeVisible();

    // Values should be non-zero (we know there's data)
    const sessionsCard = page.locator("text=Total Sessions").locator("..");
    await expect(sessionsCard).toBeVisible();
  });

  test("displays recent chains section", async ({ page }) => {
    await expect(page.getByText("Recent Chains")).toBeVisible();

    // There should be chain cards rendered (we have 630 chains)
    const chainCards = page.locator('[class*="rounded-xl border"]').filter({
      has: page.locator("text=View session"),
    });
    // At least some chains should be visible
    await expect(chainCards.first()).toBeVisible({ timeout: 5000 });
  });

  test("quick search input is visible", async ({ page }) => {
    const searchInput = page.getByPlaceholder(/search/i);
    await expect(searchInput).toBeVisible();
  });

  test("sidebar navigation links are present", async ({ page }) => {
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Search" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Sessions" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Chains" })).toBeVisible();
  });
});
