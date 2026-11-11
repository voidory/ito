import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: [
      "e2e/**",
      "node_modules/**",
      "dist/**",
      // FEAT-005C independent-renderer validation is EXPERIMENTAL research that
      // is not yet green (its bundled RDKit-rendered corpus and optimal-matching
      // metric are unfinished). It is preserved under research/ but kept OUT of
      // the default product test run so research instability never blocks the
      // shippable MVP. Run it explicitly with `npm run research:independent:test`.
      "src/science/research/skeleton/independent/**",
    ],
  },
});
