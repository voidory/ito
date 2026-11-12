import type { Capture, CaptureId } from "../model";
import type { Workbench } from "./workbench";

/**
 * M5 (§16.3, A22/A23) the desktop capture-processing queue. It lists captures
 * that have been pulled from the remote (or created locally) and are awaiting a
 * disposition, and offers the reviewer four EXPLICIT actions per capture, each
 * wired to the idempotent `wb.handleCapture(id, action)` engine:
 *
 *  - Open Source Passage  -> opens the capture's source in the reader
 *  - Insert into Subject Page -> handleCapture(id, "insert-into-page")
 *  - Create New Subject   -> handleCapture(id, "create-subject")
 *  - Dismiss              -> handleCapture(id, "dismiss")
 *
 * Only captures that have NOT yet been handled (status local/pending/uploaded)
 * are shown as actionable queue rows; once incorporated/dismissed they drop
 * out of the pending queue (the Capture record itself is preserved by the
 * engine). All actions are strictly idempotent by CaptureId (A22).
 */
export function CaptureProcessingQueue({
  wb,
  onChange,
}: {
  wb: Workbench;
  onChange: () => void;
}): JSX.Element {
  const captures = wb.captures();
  const pending = captures.filter(
    (c) => (c.status ?? "local") === "local" ||
      c.status === "pending" ||
      c.status === "uploaded",
  );

  const act = async (id: CaptureId, action: "insert-into-page" | "create-subject" | "dismiss"): Promise<void> => {
    await wb.handleCapture(id, action);
    onChange();
  };

  const openSource = (capture: Capture): void => {
    if (capture.sourceId) {
      wb.openSource(capture.sourceId);
      onChange();
    }
  };

  return (
    <section data-testid="capture-processing-queue" style={styles.root}>
      <h2 style={{ marginTop: 0 }}>Capture queue</h2>
      {pending.length === 0 ? (
        <p data-testid="capture-queue-empty" style={{ color: "#777" }}>
          No captures awaiting review.
        </p>
      ) : (
        <ul style={styles.list}>
          {pending.map((capture) => (
            <li
              key={capture.id}
              data-testid="capture-queue-item"
              data-capture-id={capture.id}
              style={styles.item}
            >
              <div style={styles.body}>
                <p style={styles.text}>{capture.text}</p>
                <span
                  data-testid="capture-queue-status"
                  data-status={capture.status ?? "local"}
                  style={styles.status}
                >
                  {capture.status ?? "local"}
                </span>
              </div>
              <div style={styles.actions}>
                <button
                  data-testid="capture-open-source"
                  data-capture-id={capture.id}
                  disabled={!capture.sourceId}
                  title="Open the source passage this capture came from"
                  onClick={() => openSource(capture)}
                >
                  Open Source Passage
                </button>
                <button
                  data-testid="capture-insert-page"
                  data-capture-id={capture.id}
                  title="Insert this capture into its target subject page"
                  onClick={() => void act(capture.id, "insert-into-page")}
                >
                  Insert into Subject Page
                </button>
                <button
                  data-testid="capture-create-subject"
                  data-capture-id={capture.id}
                  title="Create a new subject page from this capture"
                  onClick={() => void act(capture.id, "create-subject")}
                >
                  Create New Subject
                </button>
                <button
                  data-testid="capture-dismiss"
                  data-capture-id={capture.id}
                  title="Dismiss this capture"
                  onClick={() => void act(capture.id, "dismiss")}
                >
                  Dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { padding: "1.5rem", maxWidth: "52rem", margin: "0 auto" },
  list: { listStyle: "none", padding: 0, margin: 0 },
  item: {
    padding: "0.75rem 0.5rem",
    borderBottom: "1px solid #eee",
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  },
  body: { display: "flex", alignItems: "center", gap: "0.6rem" },
  text: { margin: 0, flex: 1 },
  status: {
    fontSize: "0.72rem",
    padding: "0.05rem 0.45rem",
    borderRadius: "4px",
    background: "#f3f4f6",
    color: "#374151",
    whiteSpace: "nowrap",
  },
  actions: { display: "flex", flexWrap: "wrap", gap: "0.5rem" },
};
