import { expect, test } from "@playwright/test";

// Real-browser baseline (spec section 24): launch chromium against the built
// app and assert it actually boots in a browser. The M1 workbench makes the
// Library the default view once startup succeeds, so the visible READY signal
// is the ready-state container flipping its data-state attribute AND the
// Library rendering. A static string assertion or a mocked boot would NOT
// satisfy this, so we wait for the async startup checks to flip the state.
test("app boots to the READY state (library) in a real browser", async ({ page }) => {
  await page.goto("/");

  const status = page.getByTestId("app-status");
  await expect(status).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  // The default entry after a successful boot is the Library view.
  await expect(page.getByTestId("library")).toBeVisible();
});


