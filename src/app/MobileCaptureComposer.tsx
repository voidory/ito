import { useMemo, useState } from "react";
import type { Capture, PageId, SourceId } from "../model";
import type { Workbench } from "./workbench";

/**
 * M5 (§16.2, A22/A23) the phone-side capture composer. A capture is a loose
 * thought/quote: submitting one calls `wb.createMobileCapture(...)` which adds
 * ONLY a Capture to the brain and NEVER creates a Page/Category/Relationship
 * (A23). Each existing capture renders with an explicit sync badge so the user
 * sees where it lives: on this device (`local`), queued (`pending`), or on the
 * remote (`uploaded`).
 *
 * `currentSourceId` (if provided) lets the composer offer a toggle to anchor
 * the capture to the source the reader is currently on.
 */
export function MobileCaptureComposer({
  wb,
  currentSourceId,
  onChange,
}: {
  wb: Workbench;
  /** The source the mobile reader currently has open, if any (for anchoring). */
  currentSourceId?: SourceId | null;
  /** Re-render the shell after a capture is created. */
  onChange: () => void;
}): JSX.Element {
  const [content, setContent] = useState("");
  const [anchorToSource, setAnchorToSource] = useState(false);
  const [targetPageId, setTargetPageId] = useState<string>("");
  const [busy, setBusy] = useState(false);

  // Subject pages are the valid incorporation targets to suggest.
  const subjectPages = useMemo(
    () => wb.rawData().pages.filter((p) => p.kind === "subject"),
    [wb, wb.rawData()],
  );
  const captures = wb.captures();

  const submit = async (): Promise<void> => {
    if (content.trim() === "") return;
    setBusy(true);
    try {
      await wb.createMobileCapture({
        content: content.trim(),
        originDevice: "phone",
        ...(anchorToSource && currentSourceId ? { sourceId: currentSourceId } : {}),
        ...(targetPageId !== "" ? { targetPageId: targetPageId as PageId } : {}),
      });
      setContent("");
      setTargetPageId("");
      setAnchorToSource(false);
      onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-testid="mobile-capture-composer" style={styles.root}>
      <h3 style={{ margin: "0 0 0.5rem" }}>Capture a thought</h3>
      <textarea
        data-testid="capture-content-input"
        placeholder="Jot a thought or paste a quote…"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={3}
        style={styles.input}
      />
      <div style={styles.controls}>
        {currentSourceId ? (
          <label style={styles.toggle}>
            <input
              data-testid="capture-anchor-toggle"
              type="checkbox"
              checked={anchorToSource}
              onChange={(e) => setAnchorToSource(e.target.checked)}
            />
            Anchor to current source
          </label>
        ) : null}
        <label style={styles.toggle}>
          Suggest subject{" "}
          <select
            data-testid="capture-target-select"
            value={targetPageId}
            onChange={(e) => setTargetPageId(e.target.value)}
          >
            <option value="">None</option>
            {subjectPages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
        <button
          data-testid="capture-submit-btn"
          disabled={busy || content.trim() === ""}
          onClick={() => void submit()}
        >
          {busy ? "Saving…" : "Save capture"}
        </button>
      </div>

      <ul data-testid="capture-composer-list" style={styles.list}>
        {captures.map((cap) => (
          <li key={cap.id} data-testid="capture-composer-item" style={styles.item}>
            <span style={{ flex: 1 }}>{cap.text}</span>
            <CaptureSyncBadge capture={cap} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The capture's sync lifecycle badge (A22): where the capture currently lives. */
function CaptureSyncBadge({ capture }: { capture: Capture }): JSX.Element {
  const status = capture.status ?? "local";
  const label =
    status === "uploaded"
      ? "Uploaded to Koofr"
      : status === "pending"
        ? "Pending upload"
        : status === "incorporated"
          ? "Incorporated"
          : status === "dismissed"
            ? "Dismissed"
            : "Saved on this device";
  const palette: Record<string, { bg: string; fg: string }> = {
    local: { bg: "#e6f4ea", fg: "#166534" },
    pending: { bg: "#fef3c7", fg: "#92400e" },
    uploaded: { bg: "#dbeafe", fg: "#1e40af" },
    incorporated: { bg: "#ede9fe", fg: "#5b21b6" },
    dismissed: { bg: "#f3f4f6", fg: "#6b7280" },
  };
  const colors = palette[status] ?? palette.local!;
  return (
    <span
      data-testid="capture-sync-badge"
      data-status={status}
      style={{
        fontSize: "0.72rem",
        padding: "0.05rem 0.45rem",
        borderRadius: "4px",
        background: colors.bg,
        color: colors.fg,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    padding: "1rem",
    background: "#fff",
    border: "1px solid #dcd6c8",
    borderRadius: "10px",
    maxWidth: "40rem",
    margin: "0 auto",
  },
  input: {
    display: "block",
    width: "100%",
    boxSizing: "border-box",
    marginBottom: "0.5rem",
    fontFamily: "inherit",
    fontSize: "0.95rem",
  },
  controls: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.75rem",
    marginBottom: "0.75rem",
  },
  toggle: { fontSize: "0.85rem", color: "#555", display: "flex", alignItems: "center", gap: "0.3rem" },
  list: { listStyle: "none", padding: 0, margin: 0 },
  item: {
    display: "flex",
    alignItems: "center",
    gap: "0.6rem",
    padding: "0.4rem 0",
    borderBottom: "1px solid #eee",
    fontSize: "0.9rem",
  },
};
