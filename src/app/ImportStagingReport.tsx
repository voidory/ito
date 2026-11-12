import { useState } from "react";
import type { StagedImport } from "../storage";
import type { Workbench } from "./workbench";

/**
 * The Import Staging surface (M3, A19). Given a staged import held on the
 * Workbench, it renders the diagnostic report and the appropriate commit path:
 *
 *  - "ready": a clean bundle commits normally (Import button).
 *  - "needs-confirmation": the diagnostic findings are listed and a
 *    'Try Import Anyway' button commits leniently (coerces the payload).
 *  - "hard-reject": the abort reason is shown and NO override is offered.
 *
 * It never mutates the live store itself; it drives `wb.commitStagedImport`.
 */
export function ImportStagingReport({
  wb,
  staged,
  onDone,
  onCancel,
}: {
  wb: Workbench;
  staged: StagedImport;
  onDone: (committed: boolean) => void;
  onCancel: () => void;
}): JSX.Element {
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const commit = async (lenient: boolean): Promise<void> => {
    setCommitting(true);
    setError(null);
    try {
      const result = await wb.commitStagedImport(lenient ? { lenient: true } : {});
      if (!result.committed) {
        setError(result.reason ?? "import was not committed");
        onDone(false);
        return;
      }
      onDone(true);
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div
      data-testid="import-staging-report"
      data-outcome={staged.outcome}
      role="dialog"
      aria-label="Import staging report"
      style={styles.modal}
    >
      <header style={styles.header}>
        <h3 style={{ margin: 0 }}>Review Import</h3>
        <button data-testid="import-staging-close" aria-label="Close" onClick={onCancel}>
          ×
        </button>
      </header>

      {staged.outcome === "hard-reject" && (
        <div data-testid="import-abort-reason" role="alert" style={styles.reject}>
          This backup cannot be imported: {staged.reason}
        </div>
      )}

      {staged.outcome === "needs-confirmation" && (
        <>
          <p style={styles.hint}>
            This backup differs from what this build expects. Review the findings
            below. You can still force the import, which coerces the payload.
          </p>
          <ul data-testid="import-staging-findings" style={styles.findings}>
            {staged.findings.map((f, i) => (
              <li key={i} data-testid="import-staging-finding" data-kind={f.kind} style={styles.finding}>
                <strong>{f.kind}</strong>: {f.message}
              </li>
            ))}
          </ul>
        </>
      )}

      {staged.outcome === "ready" && (
        <p data-testid="import-staging-ready" style={styles.hint}>
          This backup is clean and ready to import.
        </p>
      )}

      {error && (
        <p data-testid="import-staging-error" role="alert" style={{ color: "#c5221f" }}>
          {error}
        </p>
      )}

      <div style={styles.actions}>
        <button data-testid="import-staging-cancel" onClick={onCancel} disabled={committing}>
          Cancel
        </button>
        {staged.outcome === "ready" && (
          <button
            data-testid="import-staging-commit"
            onClick={() => void commit(false)}
            disabled={committing}
          >
            {committing ? "Importing…" : "Import"}
          </button>
        )}
        {staged.outcome === "needs-confirmation" && (
          <button
            data-testid="try-import-anyway"
            onClick={() => void commit(true)}
            disabled={committing}
          >
            {committing ? "Importing…" : "Try Import Anyway"}
          </button>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  modal: {
    position: "fixed",
    zIndex: 2000,
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    width: "30rem",
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
  hint: { fontSize: "0.85rem", color: "#555", margin: "0 0 0.5rem" },
  reject: {
    padding: "0.6rem 0.75rem",
    background: "#fde8e8",
    border: "1px solid #f5a9a9",
    borderRadius: "6px",
    color: "#9b1c1c",
    fontSize: "0.85rem",
  },
  findings: { listStyle: "none", padding: 0, margin: "0 0 0.5rem", maxHeight: "12rem", overflow: "auto" },
  finding: {
    padding: "0.4rem 0.5rem",
    marginBottom: "0.35rem",
    background: "#fef3c7",
    border: "1px solid #f0d38a",
    borderRadius: "6px",
    fontSize: "0.82rem",
  },
  actions: { display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "0.75rem" },
};
