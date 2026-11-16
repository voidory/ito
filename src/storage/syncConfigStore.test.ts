/**
 * P5 — unit coverage for the remote-sync config persistence store. Uses an
 * injected in-memory KeyValueStore so the tests are hermetic (no real
 * localStorage) and also proves the no-storage / malformed-value paths.
 */

import { describe, expect, it } from "vitest";
import {
  type KeyValueStore,
  clearSyncConfig,
  loadSyncConfig,
  saveSyncConfig,
} from "./syncConfigStore";

function memStore(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("syncConfigStore (P5)", () => {
  it("round-trips a full WebDAV config", () => {
    const store = memStore();
    saveSyncConfig(
      { baseUrl: "https://dav.example/Koofr", username: "u", appPassword: "secret" },
      store,
    );
    expect(loadSyncConfig(store)).toEqual({
      baseUrl: "https://dav.example/Koofr",
      username: "u",
      appPassword: "secret",
    });
  });

  it("omits empty username/password instead of storing blanks", () => {
    const store = memStore();
    saveSyncConfig({ baseUrl: "https://dav.example/Koofr", username: "", appPassword: "" }, store);
    expect(loadSyncConfig(store)).toEqual({ baseUrl: "https://dav.example/Koofr" });
  });

  it("returns null when nothing is stored", () => {
    expect(loadSyncConfig(memStore())).toBeNull();
  });

  it("returns null for a malformed stored value", () => {
    const store = memStore();
    store.map.set("ito:sync-config:v1", "{not json");
    expect(loadSyncConfig(store)).toBeNull();
  });

  it("returns null when the stored baseUrl is missing or blank", () => {
    const store = memStore();
    store.map.set("ito:sync-config:v1", JSON.stringify({ username: "u" }));
    expect(loadSyncConfig(store)).toBeNull();
    store.map.set("ito:sync-config:v1", JSON.stringify({ baseUrl: "   " }));
    expect(loadSyncConfig(store)).toBeNull();
  });

  it("clear removes the persisted config", () => {
    const store = memStore();
    saveSyncConfig({ baseUrl: "https://dav.example/Koofr" }, store);
    expect(loadSyncConfig(store)).not.toBeNull();
    clearSyncConfig(store);
    expect(loadSyncConfig(store)).toBeNull();
  });

  it("is inert (no throw) when the backing store throws (blocked storage)", () => {
    const throwing: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => saveSyncConfig({ baseUrl: "x" }, throwing)).not.toThrow();
    expect(loadSyncConfig(throwing)).toBeNull();
    expect(() => clearSyncConfig(throwing)).not.toThrow();
  });
});
