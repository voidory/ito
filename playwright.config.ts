import { defineConfig, devices } from "@playwright/test";

// Playwright drives a REAL chromium browser against the production build served
// by `vite preview`. Per spec section 24, this is runtime validation and is NOT
// a substitute that type/syntax checks can satisfy.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // The e2e suite drives the PRODUCTION build (`vite build`), where
    // `import.meta.env.DEV` is false. The privileged `window.__ito` test API is
    // gated off in production builds (see App.tsx `testApiEnabled`), so opt it
    // back in explicitly for the e2e build with `VITE_ITO_TEST_API=1`. A normal
    // `npm run build` does NOT set this, so the API never ships to users.
    command: "VITE_ITO_TEST_API=1 npm run build && npm run preview",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
