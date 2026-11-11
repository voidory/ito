import { defineConfig } from "vitest/config";

/**
 * Test configuration for the EXPERIMENTAL research area that the default
 * product config (vitest.config.ts) intentionally excludes. Currently this is
 * the FEAT-005C independent-renderer validation, which is unfinished and NOT
 * yet green. Run with: npm run research:independent:test
 *
 * This exists so the research work is preserved and runnable while continuing
 * development, without its instability blocking the shippable MVP test run.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/science/research/skeleton/independent/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
