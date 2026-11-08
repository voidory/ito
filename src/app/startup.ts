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
    // Not fatal for the shell, but worth surfacing. Storage falls back/handles
    // this explicitly at the adapter layer; here we only note it.
    missing.push("indexedDB");
  }

  if (missing.includes("crypto.randomUUID")) {
    throw new Error(`Required browser APIs unavailable: ${missing.join(", ")}`);
  }

  const storageNote = missing.includes("indexedDB")
    ? " (persistent storage unavailable; running in-memory)"
    : "";

  return `Schema v${SCHEMA_VERSION} initialised.${storageNote}`;
}
