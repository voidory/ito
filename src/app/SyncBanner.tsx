import { useState } from "react";
import { KoofrStorageAdapter } from "../storage";
import type { Workbench } from "./workbench";

/**
 * M4 (§15, §16.1, A20) the remote-sync status banner + publish/refresh
 * controls. It renders the current `wb.syncStatus()` state and, when a remote
 * adapter is configured, lets the user publish the live brain to the remote
 * (pointer-last) or refresh the local copy from it. The banner lives in the
 * shell header so it is always reachable.
 *
 * `remote` is provided at runtime once Koofr credentials are available; when it
 * is absent the publish/refresh buttons are disabled (there is nothing to sync
 * to), but the status label is still shown.
 *
 * FEAT-003 (3.2): a "Configure Sync" button opens a modal that lets the user
 * either enter WebDAV credentials (building a real KoofrStorageAdapter) OR wire
 * a local in-memory demo remote so Publish/Refresh work interactively without
 * any external Koofr account. The configured adapter is lifted into App via
 * `onConfigureRemote` so the publish/refresh buttons become enabled.
 */
export function SyncBanner({
  wb,
  remote,
  onChange,
  onConfigureRemote,
  compact,
}: {
  wb: Workbench;
  /** The configured remote, or null when no Koofr endpoint is available. */
  remote?: KoofrStorageAdapter | null;
  onChange: () => void;
  /**
   * M9 (FEAT-001 D): when true, render ONLY the status badge; the individual
   * Configure Sync / Publish / Refresh controls are relocated into the shell
   * gear settings menu. Defaults to false so the banner still renders its own
   * controls in isolation (and in its colocated render tests).
   */
  compact?: boolean;
  /**
   * Lift a freshly-configured remote adapter into the shell (App) so the
   * publish/refresh controls here (and anywhere else the adapter is wired)
   * become enabled. Optional so the banner still renders in isolation (tests).
   */
  onConfigureRemote?: (remote: KoofrStorageAdapter) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [username, setUsername] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const status = wb.syncStatus();

  const publish = async (): Promise<void> => {
    if (!remote) return;
    setBusy(true);
    try {
      await wb.publishToRemote(remote);
      onChange();
    } finally {
      setBusy(false);
    }
  };

  const refresh = async (): Promise<void> => {
    if (!remote) return;
    setBusy(true);
    try {
      await wb.refreshFromRemote(remote);
      onChange();
    } finally {
      setBusy(false);
    }
  };

  // FEAT-003 (3.2): build a KoofrStorageAdapter from the entered WebDAV
  // credentials and lift it into App. Credentials are STRICTLY runtime (never
  // hardcoded) and are passed straight to the adapter config.
  const configureWebdav = (): void => {
    if (baseUrl.trim() === "") return;
    const user = username.trim();
    const adapter = new KoofrStorageAdapter({
      baseUrl: baseUrl.trim(),
      ...(user === "" ? {} : { username: user }),
      ...(appPassword === "" ? {} : { appPassword }),
    });
    onConfigureRemote?.(adapter);
    setConfigOpen(false);
  };

  // FEAT-003 (3.2): wire a local in-memory demo remote so Publish/Refresh work
  // interactively without a real Koofr account. It is a REAL KoofrStorageAdapter
  // whose transport is an in-memory WebDAV fake fetch (PUT/GET/PROPFIND/MKCOL
  // against a Map), so wb.publishToRemote/refreshFromRemote run unmodified.
  const configureDemo = (): void => {
    onConfigureRemote?.(createDemoRemote());
    setConfigOpen(false);
  };

  const label =
    status.state === "up-to-date"
      ? "Up to date"
      : status.state === "publishing"
        ? "Publishing…"
        : status.state === "stale"
          ? "Stale"
          : "Offline";

  return (
    <span style={styles.root}>
      <span
        data-testid="sync-publication-status"
        data-state={status.state}
        title={status.reason ?? label}
        style={styles.badge}
      >
        {label}
      </span>
      {!compact && (
        <>
          <button
            data-testid="configure-sync-btn"
            aria-expanded={configOpen}
            onClick={() => setConfigOpen((v) => !v)}
          >
            Configure Sync
          </button>
          <button
            data-testid="publish-remote-btn"
            disabled={busy || !remote || status.state === "publishing"}
            onClick={() => void publish()}
          >
            Publish
          </button>
          <button
            data-testid="refresh-remote-btn"
            disabled={busy || !remote}
            onClick={() => void refresh()}
          >
            Refresh
          </button>
        </>
      )}

      {configOpen && (
        <div data-testid="sync-config-modal" style={styles.modal} role="dialog">
          <div style={styles.modalTitle}>Configure remote sync</div>
          <label style={styles.field}>
            <span style={styles.fieldLabel}>WebDAV base URL</span>
            <input
              data-testid="sync-base-url-input"
              type="text"
              placeholder="https://app.koofr.net/dav/Koofr"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
          <label style={styles.field}>
            <span style={styles.fieldLabel}>Username</span>
            <input
              data-testid="sync-username-input"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label style={styles.field}>
            <span style={styles.fieldLabel}>Application password</span>
            <input
              data-testid="sync-app-password-input"
              type="password"
              value={appPassword}
              onChange={(e) => setAppPassword(e.target.value)}
            />
          </label>
          <div style={styles.modalActions}>
            <button
              data-testid="sync-connect-webdav-btn"
              disabled={baseUrl.trim() === ""}
              onClick={configureWebdav}
            >
              Connect WebDAV
            </button>
            <button data-testid="use-demo-remote-btn" onClick={configureDemo}>
              Use Local Demo Remote
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

/**
 * FEAT-003 (3.2): a local in-memory demo remote. It is a genuine
 * KoofrStorageAdapter wired to an in-memory WebDAV fake fetch so every real
 * publication primitive (writeSnapshot / readSnapshot / writePointer /
 * readPointer via PUT / GET / PROPFIND / MKCOL) works against a Map, letting
 * Publish and Refresh round-trip interactively with ZERO external network.
 */
export function createDemoRemote(): KoofrStorageAdapter {
  const baseUrl = "memory://demo";
  const store = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();

  const bodyToBytes = (body: unknown): Uint8Array => {
    if (typeof body === "string") return encoder.encode(body);
    if (body instanceof Uint8Array) return body;
    if (body && typeof (body as ArrayBuffer).byteLength === "number") {
      return new Uint8Array(body as ArrayBuffer);
    }
    return encoder.encode(String(body ?? ""));
  };

  const makeResponse = (status: number, body: string | Uint8Array): Response => {
    const bytes = typeof body === "string" ? encoder.encode(body) : body;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `status ${status}`,
      async text() {
        return new TextDecoder().decode(bytes);
      },
      async arrayBuffer() {
        return bytes.slice().buffer;
      },
    } as unknown as Response;
  };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    // Strip the base + any trailing slash so the Map is keyed by relative path.
    const path = url.replace(`${baseUrl}/`, "").replace(/\/+$/, "");
    if (method === "PUT") {
      store.set(path, bodyToBytes(init?.body));
      return makeResponse(201, "");
    }
    if (method === "GET") {
      const bytes = store.get(path);
      return bytes ? makeResponse(200, bytes) : makeResponse(404, "");
    }
    if (method === "MKCOL") return makeResponse(201, "");
    if (method === "PROPFIND") {
      const children = [...store.keys()].filter((k) => k.startsWith(`${path}/`));
      const hrefs = children
        .map((k) => `<d:response><d:href>/${k}</d:href></d:response>`)
        .join("");
      return makeResponse(207, `<d:multistatus xmlns:d="DAV:">${hrefs}</d:multistatus>`);
    }
    return makeResponse(405, "");
  }) as unknown as typeof fetch;

  return new KoofrStorageAdapter({ baseUrl, fetchImpl });
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", alignItems: "center", gap: "0.4rem", position: "relative" },
  badge: {
    fontSize: "0.72rem",
    padding: "0.05rem 0.45rem",
    borderRadius: "4px",
    background: "#eef2ff",
    color: "#3730a3",
    whiteSpace: "nowrap",
  },
  modal: {
    position: "absolute",
    top: "calc(100% + 0.4rem)",
    right: 0,
    zIndex: 50,
    width: "18rem",
    padding: "0.85rem",
    borderRadius: "10px",
    background: "#ffffff",
    border: "1px solid #c7cbe0",
    boxShadow: "0 6px 24px rgba(40, 40, 40, 0.2)",
    display: "flex",
    flexDirection: "column",
    gap: "0.4rem",
    textAlign: "left",
  },
  modalTitle: { fontWeight: 700, fontSize: "0.85rem", color: "#312e81" },
  field: { display: "flex", flexDirection: "column", gap: "0.15rem", fontSize: "0.72rem" },
  fieldLabel: { color: "#4b5563" },
  modalActions: { display: "flex", gap: "0.4rem", marginTop: "0.3rem", flexWrap: "wrap" },
};
