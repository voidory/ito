import { useState } from "react";
import type { KoofrStorageAdapter } from "../storage";
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
 */
export function SyncBanner({
  wb,
  remote,
  onChange,
}: {
  wb: Workbench;
  /** The configured remote, or null when no Koofr endpoint is available. */
  remote?: KoofrStorageAdapter | null;
  onChange: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
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
    </span>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", alignItems: "center", gap: "0.4rem" },
  badge: {
    fontSize: "0.72rem",
    padding: "0.05rem 0.45rem",
    borderRadius: "4px",
    background: "#eef2ff",
    color: "#3730a3",
    whiteSpace: "nowrap",
  },
};
