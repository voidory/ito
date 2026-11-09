import { defineConfig } from "@playwright/test";

/**
 * Sandbox-only Playwright config: drives the pre-built preview server with the
 * resident chrome-headless-shell binary (full Chromium is unavailable here and
 * `npx playwright install` fails with SIGTRAP). The server is started by the
 * surrounding shell script, so no `webServer` is declared.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: process.env.PW_BASE_URL ?? "http://127.0.0.1:4173",
    launchOptions: {
      executablePath:
        process.env.PW_CHROMIUM_BIN ??
        "/inner_container/opt/playwright/chromium_headless_shell-1232/chrome-headless-shell-linux64/chrome-headless-shell",
    },
  },
  projects: [{ name: "chromium-headless-shell" }],
});
