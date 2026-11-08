/// <reference types="vite/client" />

/**
 * Vite asset imports. Importing a file with the `?url` suffix resolves to the
 * emitted asset URL as a string (used for the pdf.js worker and PDF fixtures).
 */
declare module "*?url" {
  const src: string;
  export default src;
}
