import { SCHEMA_VERSION } from "../model";

/**
 * Minimal startup checks for M0. Confirms the runtime environment exposes the
 * primitives the storage adapter will need (IndexedDB / crypto) and reports a
 * short human-readable detail string.
 *
 * Returns the READY detail string, or throws to drive the ERROR state.
 */
export async function runStartupChecks(): Promise<string> {
  const missing: string[] = [];

  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
    missing.push("crypto.randomUUID");
  }
  if (typeof indexedDB === "undefined") {
    missing.push("indexedDB");
  }

  if (missing.includes("crypto.randomUUID")) {
    throw new Error(`Required browser APIs unavailable: ${missing.join(", ")}`);
  }

  // P3: the only storage adapter the app wires up is the IndexedDB-backed one
  // (useWorkbench → LocalFileStorageAdapter). There is NO in-memory fallback:
  // if IndexedDB is missing, Workbench.open will fail and nothing can be saved.
  // The old READY note falsely claimed the app kept running "in-memory", which
  // masked a hard failure as a soft note. Surface the truth instead.
  if (missing.includes("indexedDB")) {
    throw new Error(
      "Persistent storage unavailable: this browser does not expose IndexedDB, " +
        "so your work cannot be saved. Enable storage (e.g. leave private/incognito " +
        "mode or allow site data) and reload.",
    );
  }

  return `Schema v${SCHEMA_VERSION} initialised.`;
}
