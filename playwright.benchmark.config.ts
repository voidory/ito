import { defineConfig, devices } from "@playwright/test";

// The LaTeX-extraction benchmark (docs/LATEX-EXTRACTION-PLAN.md, Phase 1). It
// drives the production build in real Chromium, like the e2e suite, but is kept
// out of `npm run test:e2e`: it is a measurement over thousands of equations,
// not a behaviour test. Run with `npm run benchmark:latex`.
//
// ITO_CHROMIUM_PATH points Playwright at an already-installed Chromium when the
// pinned browser build is not available (for example in a cloud sandbox).
const executablePath = process.env.ITO_CHROMIUM_PATH;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.bench.ts",
  // One worker: the tiers run in order and share the tally the gate reads.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 45 * 60_000,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "off",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && npm run preview",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
