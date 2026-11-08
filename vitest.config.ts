import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Playwright specs live under e2e/ and must NOT be picked up by Vitest.
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
