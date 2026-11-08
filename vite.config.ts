import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite handles copying the pdf.js worker from pdfjs-dist when imported via
// `?url`; no extra config is required here for M0.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  preview: {
    port: 4173,
  },
});
