import { expect, test } from "@playwright/test";

// Real-browser baseline (spec section 24): launch chromium against the built
// app and assert the visible READY state actually renders. This is runtime
// validation; a static string assertion or a mocked boot would NOT satisfy it,
// so we wait for the async startup checks to flip the state attribute.
test("app boots to the READY state in a real browser", async ({ page }) => {
  await page.goto("/");

  const status = page.getByTestId("app-status");
  await expect(status).toHaveAttribute("data-state", "ready", { timeout: 10_000 });
  await expect(status.getByRole("heading", { name: "READY" })).toBeVisible();
  await expect(page.getByText(/Schema v\d+ initialised/)).toBeVisible();
});
