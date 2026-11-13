/**
 * P5 (sync persistence) — durable storage for the remote-sync endpoint config.
 *
 * The previous behaviour lost the configured WebDAV endpoint on every reload:
 * `remote` started null and the user had to re-enter the base URL + credentials
 * each session. This module persists the serializable part of a {@link
 * KoofrConfig} (everything EXCEPT the non-serializable `fetchImpl`) so a real
 * WebDAV remote reconnects automatically on the next load.
 *
 * It intentionally lives in browser `localStorage` (synchronous, survives
 * reload, scoped to the origin) rather than the brain's IndexedDB payload: the
 * endpoint is a per-device/per-browser setting, not part of the portable brain
 * data, and must not travel inside a backup/export. All access is guarded so
 * the module is inert (and never throws) under Node/jsdom or when storage is
 * blocked (private mode), returning null instead.
 *
 * SECURITY NOTE: for a bring-your-own WebDAV client the application password is
 * persisted in the user's own browser `localStorage`. This is the standard
 * trade-off for not re-prompting every session; the UI makes persistence
 * explicit (an opt-in "Connect" that saves, and a "Disconnect" that clears).
 * The in-memory demo remote is NEVER persisted (it has no real endpoint).
 */

/** The serializable remote-sync config persisted across reloads. */
export interface PersistedSyncConfig {
  readonly baseUrl: string;
  readonly username?: string;
  readonly appPassword?: string;
}

const STORAGE_KEY = "ito:sync-config:v1";

/** The localStorage-like surface this module needs; injectable for tests. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Resolve the backing store. Prefers an injected store (tests), else the global
 * `localStorage`, else null when it is unavailable (Node/jsdom, private mode, a
 * SecurityError on access). Never throws.
 */
function resolveStore(injected?: KeyValueStore | null): KeyValueStore | null {
  if (injected) return injected;
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // Accessing localStorage can throw (blocked by the browser). Treat as none.
  }
  return null;
}

/**
 * Persist the serializable sync config. The `fetchImpl` of a live adapter is a
 * runtime-only transport and is intentionally NOT accepted here. A no-op when
 * storage is unavailable.
 */
export function saveSyncConfig(
  config: PersistedSyncConfig,
  store?: KeyValueStore | null,
): void {
  const target = resolveStore(store);
  if (!target) return;
  const serializable: PersistedSyncConfig = {
    baseUrl: config.baseUrl,
    ...(config.username ? { username: config.username } : {}),
    ...(config.appPassword ? { appPassword: config.appPassword } : {}),
  };
  try {
    target.setItem(STORAGE_KEY, JSON.stringify(serializable));
  } catch {
    // Quota/security errors are non-fatal; the session simply isn't persisted.
  }
}

/**
 * Load a previously persisted sync config, or null when none is stored or the
 * stored value is unusable (missing/blank baseUrl, malformed JSON, no storage).
 * Never throws.
 */
export function loadSyncConfig(store?: KeyValueStore | null): PersistedSyncConfig | null {
  const target = resolveStore(store);
  if (!target) return null;
  let raw: string | null = null;
  try {
    raw = target.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { baseUrl?: unknown }).baseUrl !== "string"
    ) {
      return null;
    }
    const p = parsed as PersistedSyncConfig;
    if (p.baseUrl.trim() === "") return null;
    return {
      baseUrl: p.baseUrl,
      ...(typeof p.username === "string" && p.username !== "" ? { username: p.username } : {}),
      ...(typeof p.appPassword === "string" && p.appPassword !== ""
        ? { appPassword: p.appPassword }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Remove any persisted sync config (used by "Disconnect"). Never throws. */
export function clearSyncConfig(store?: KeyValueStore | null): void {
  const target = resolveStore(store);
  if (!target) return;
  try {
    target.removeItem(STORAGE_KEY);
  } catch {
    // Non-fatal.
  }
}
