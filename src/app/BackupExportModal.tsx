import { useMemo, useState } from "react";
import type { Workbench } from "./workbench";

/**
 * The Backup Export Modal (M3, A18, D09). It renders the interactive Targeted
 * Backup Checklist: a LOCKED-ON "Core Brain Graph (Required)" item plus four
 * optional toggles (Shared Presentation Layout, Pending Captures & Reflections,
 * Revision History, Include PDF Source Binaries). All optional boxes ticked is
 * a "Full Archival Backup"; unticking ANY box downgrades the backup to a
 * "Targeted Backup (Partial - not a complete archival backup)" and stamps the
 * corresponding omission token on the exported manifest.
 *
 * The modal drives `wb.exportBackup(options)` with the chosen checklist. The
 * core brain graph is ALWAYS exported and is never a toggle.
 */
export interface BackupChecklist {
  presentation: boolean;
  captures: boolean;
  revisions: boolean;
  sourceBinaries: boolean;
}

const FULL_BADGE = "Full Archival Backup";
const TARGETED_BADGE = "Targeted Backup (Partial - not a complete archival backup)";

export function BackupExportModal({
  wb,
  onClose,
}: {
  wb: Workbench;
  onClose: () => void;
}): JSX.Element {
  const [checklist, setChecklist] = useState<BackupChecklist>({
    presentation: true,
    captures: true,
    revisions: true,
    sourceBinaries: true,
  });
  const [result, setResult] = useState<{
    backupMode: string;
    omissions: readonly string[];
    byteLength: number;
  } | null>(null);
  const [exporting, setExporting] = useState(false);

  // Full = every optional box ticked; any unticked box downgrades to targeted.
  const isFull = useMemo(
    () =>
      checklist.presentation &&
      checklist.captures &&
      checklist.revisions &&
      checklist.sourceBinaries,
    [checklist],
  );
  const badge = isFull ? FULL_BADGE : TARGETED_BADGE;

  const toggle = (key: keyof BackupChecklist): void => {
    setChecklist((prev) => ({ ...prev, [key]: !prev[key] }));
    setResult(null);
  };

  const runExport = async (): Promise<void> => {
    setExporting(true);
    try {
      const { manifest, bytes } = await wb.exportBackup(checklist);
      setResult({
        backupMode: manifest.backupMode ?? "full",
        omissions: manifest.omissions ?? [],
        byteLength: bytes.byteLength,
      });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div
      data-testid="backup-export-modal"
      role="dialog"
      aria-label="Backup export"
      data-backup-mode={isFull ? "full" : "targeted"}
      style={styles.modal}
    >
      <header style={styles.header}>
        <h3 style={{ margin: 0 }}>Export Backup</h3>
        <button data-testid="backup-export-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>

      <p style={styles.hint}>
        Choose what to include. The core brain graph is always exported;
        unticking any optional section produces a targeted (partial) backup.
      </p>

      <ul style={styles.list}>
        {/* Locked-on required item: the core graph can never be excluded. */}
        <li data-testid="export-opt-core" style={styles.item}>
          <label style={styles.label}>
            <input type="checkbox" checked readOnly disabled aria-label="Core Brain Graph (Required)" />
            <span>Core Brain Graph (Required)</span>
          </label>
          <span style={styles.lock} aria-hidden="true">
            locked
          </span>
        </li>

        <ChecklistItem
          testId="export-opt-presentation"
          label="Shared Presentation Layout"
          checked={checklist.presentation}
          onToggle={() => toggle("presentation")}
        />
        <ChecklistItem
          testId="export-opt-captures"
          label="Pending Captures & Reflections"
          checked={checklist.captures}
          onToggle={() => toggle("captures")}
        />
        <ChecklistItem
          testId="export-opt-revisions"
          label="Revision History"
          checked={checklist.revisions}
          onToggle={() => toggle("revisions")}
        />
        <ChecklistItem
          testId="export-opt-binaries"
          label="Include PDF Source Binaries"
          checked={checklist.sourceBinaries}
          onToggle={() => toggle("sourceBinaries")}
        />
      </ul>

      <div
        data-testid="backup-mode-badge"
        data-mode={isFull ? "full" : "targeted"}
        style={{ ...styles.badge, background: isFull ? "#e6f4ea" : "#fef3c7" }}
      >
        {badge}
      </div>

      <div style={styles.actions}>
        <button data-testid="backup-export-run" disabled={exporting} onClick={() => void runExport()}>
          {exporting ? "Exporting…" : "Export"}
        </button>
      </div>

      {result && (
        <div data-testid="backup-export-result" data-backup-mode={result.backupMode} style={styles.result}>
          <span>
            Exported {result.backupMode} backup ({result.byteLength} bytes).
          </span>
          {result.omissions.length > 0 && (
            <span data-testid="backup-export-omissions">
              {" "}
              Omitted: {result.omissions.join(", ")}.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ChecklistItem({
  testId,
  label,
  checked,
  onToggle,
}: {
  testId: string;
  label: string;
  checked: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <li style={styles.item}>
      <label style={styles.label}>
        <input
          type="checkbox"
          data-testid={testId}
          checked={checked}
          onChange={onToggle}
          aria-label={label}
        />
        <span>{label}</span>
      </label>
    </li>
  );
}

const styles: Record<string, React.CSSProperties> = {
  modal: {
    position: "fixed",
    zIndex: 2000,
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    width: "28rem",
    maxWidth: "90vw",
    padding: "1rem 1.25rem",
    background: "#fff",
    border: "1px solid #ccc",
    borderRadius: "10px",
    boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "0.5rem",
  },
  hint: { fontSize: "0.85rem", color: "#555", margin: "0 0 0.75rem" },
  list: { listStyle: "none", padding: 0, margin: "0 0 0.75rem" },
  item: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0.35rem 0",
    borderBottom: "1px solid #f0f0f0",
  },
  label: { display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.95rem" },
  lock: { fontSize: "0.7rem", color: "#999", textTransform: "uppercase", letterSpacing: "0.05em" },
  badge: {
    padding: "0.5rem 0.75rem",
    borderRadius: "6px",
    fontWeight: 600,
    fontSize: "0.9rem",
    textAlign: "center",
  },
  actions: { display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "0.75rem" },
  result: { marginTop: "0.75rem", fontSize: "0.85rem", color: "#333" },
};
