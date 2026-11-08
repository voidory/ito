import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL(".", import.meta.url));

// Vite handles copying the pdf.js worker from pdfjs-dist when imported via
// `?url`; no extra config is required here for M0.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        // Main SPA shell.
        main: resolve(root, "index.html"),
        // M0 PDF anchor spike harness, driven by the Playwright spike test.
        "pdf-anchor-spike": resolve(root, "spikes/pdf-anchor/index.html"),
      },
    },
  },
  server: {
    port: 5173,
  },
  preview: {
    port: 4173,
  },
});
