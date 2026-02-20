import { test, expect } from "@playwright/test";

const TEST_EMAIL = "sessiongraph.test@gmail.com";
const TEST_PASSWORD = "testpass123";

test.describe("Authentication", () => {
  test("shows login page with form fields", async ({ page }) => {
    await page.goto("/login");

    await expect(page.getByText("SessionGraph")).toBeVisible();
    await expect(
      page.getByText("Sign in to access your reasoning chains")
    ).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("shows signup link on login page", async ({ page }) => {
    await page.goto("/login");

    const signupLink = page.getByRole("link", { name: "Sign up" });
    await expect(signupLink).toBeVisible();
    await expect(signupLink).toHaveAttribute("href", "/signup");
  });

  test("shows error for invalid credentials", async ({ page }) => {
    await page.goto("/login");

    await page.getByLabel("Email").fill("wrong@example.com");
    await page.getByLabel("Password").fill("wrongpassword");
    await page.getByRole("button", { name: "Sign in" }).click();

    // Should show an error message (Supabase returns "Invalid login credentials")
    await expect(page.getByText(/invalid/i)).toBeVisible({ timeout: 10000 });
  });

  test("redirects unauthenticated users to login", async ({ page }) => {
    await page.goto("/");

    // The middleware should redirect to /login
    await expect(page).toHaveURL(/\/login/);
  });

  test("successful login redirects to dashboard", async ({ page }) => {
    await page.goto("/login");

    await page.getByLabel("Email").fill(TEST_EMAIL);
    await page.getByLabel("Password").fill(TEST_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    // Should redirect to dashboard
    await expect(page).toHaveURL("/", { timeout: 15000 });
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 10000 });
  });
});
