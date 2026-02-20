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

test.describe("Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("navigates to Sessions page via sidebar", async ({ page }) => {
    await page.getByRole("link", { name: "Sessions" }).click();
    await expect(page).toHaveURL("/sessions");
    await expect(
      page.getByRole("heading", { name: "Sessions" })
    ).toBeVisible();
    await expect(page.getByText(/sessions? recorded/)).toBeVisible();
  });

  test("navigates to Search page via sidebar", async ({ page }) => {
    await page.getByRole("link", { name: "Search" }).click();
    await expect(page).toHaveURL("/search");
    await expect(page.getByRole("heading", { name: "Search", exact: true })).toBeVisible();
    await expect(
      page.getByText("Find reasoning chains using semantic search")
    ).toBeVisible();
  });

  test("navigates to Chains page via sidebar", async ({ page }) => {
    // Locate the sidebar's Chains link by its href
    await page.locator('a[href="/chains"]').click();
    await expect(page).toHaveURL("/chains", { timeout: 10000 });
    await expect(page.getByRole("heading", { name: "Chains" })).toBeVisible({ timeout: 10000 });
  });

  test("navigates back to Dashboard from Sessions", async ({ page }) => {
    await page.getByRole("link", { name: "Sessions" }).click();
    await expect(page).toHaveURL("/sessions");

    // Use href-based locator for the sidebar Dashboard link
    await page.locator('a[href="/"]').first().click();
    await expect(page).toHaveURL("/", { timeout: 10000 });
    await expect(
      page.getByRole("heading", { name: "Dashboard" })
    ).toBeVisible({ timeout: 10000 });
  });

  test("Sessions page shows session table with data", async ({ page }) => {
    await page.goto("/sessions");

    // Table should have rows (we have 216 sessions)
    const tableRows = page.locator("tbody tr");
    await expect(tableRows.first()).toBeVisible({ timeout: 10000 });

    // Should show "sessions recorded" text
    await expect(page.getByText(/sessions recorded/)).toBeVisible();
  });

  test("clicking a session row navigates to session detail", async ({ page }) => {
    await page.goto("/sessions");

    // Wait for table to load
    const firstRow = page.locator("tbody tr").first();
    await expect(firstRow).toBeVisible({ timeout: 10000 });

    // Rows are clickable (router.push, not <a> links), so click the row directly
    await firstRow.click();

    // Should navigate to /sessions/[id] (IDs are like ses_xxx or UUIDs)
    await expect(page).toHaveURL(/\/sessions\/\w+/, { timeout: 10000 });
  });
});
