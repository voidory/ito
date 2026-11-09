import { useRef, useState } from "react";
import type { Source, SourceId } from "../model";
import type { Workbench } from "./workbench";
import { importPdfFiles } from "./pdfImport";

/** Accepted snapshot file extensions for a website source (A15, D11). */
const SNAPSHOT_ACCEPT = ".html,.htm,.md,.txt";

/** M9 (FEAT-002 3) the sortable Library table columns. */
type LibrarySortColumn = "title" | "authors" | "year" | "pages" | "annotations" | "importedAt";

const LIBRARY_COLUMNS: { key: LibrarySortColumn; label: string }[] = [
  { key: "title", label: "Title" },
  { key: "authors", label: "Authors" },
  { key: "year", label: "Year" },
  { key: "pages", label: "Pages" },
  { key: "annotations", label: "Annotations" },
  { key: "importedAt", label: "Date added" },
];

/**
 * The Source model carries no explicit authors/year, so they are derived best
 * effort from the title (e.g. a trailing "(2021)" year) and otherwise shown as
 * an em-dash placeholder. The derivation never mutates the record.
 */
function sourceYear(title: string): string {
  const m = title.match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  return m ? m[1]! : "—";
}
function sourceAuthors(_title: string): string {
  return "—";
}
function formatDateAdded(iso: string): string {
  return iso.slice(0, 10);
}

function hasAcceptedExtension(name: string): boolean {
  return /\.(html?|md|txt)$/i.test(name);
}

/**
 * The "Add website" modal (A15, D11). A website source REQUIRES both a URL and
 * a dropped/selected snapshot file; submitting a URL with no snapshot is
 * rejected with an inline error. On success the snapshot is stored via the
 * StorageAdapter and the source is tagged kind/type "website" +
 * availabilityStatus "snapshot-cached".
 */
export function AddWebsiteModal({
  wb,
  onClose,
  onImported,
}: {
  wb: Workbench;
  onClose: () => void;
  onImported: () => void;
}): JSX.Element {
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const takeFile = (f: File | null): void => {
    if (!f) return;
    if (!hasAcceptedExtension(f.name)) {
      setError("Snapshot must be an .html, .htm, .md, or .txt file.");
      return;
    }
    setError(null);
    setFile(f);
  };

  const submit = async (): Promise<void> => {
    if (url.trim() === "") {
      setError("Enter the website URL.");
      return;
    }
    // Reject URL-only submissions (A15, D11): a snapshot file is REQUIRED.
    if (!file) {
      setError("A snapshot file is required to add a website.");
      return;
    }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await wb.importWebsiteSource({ url: url.trim(), snapshot: bytes, title: url.trim() });
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="add-website-modal"
      role="dialog"
      aria-label="Add website"
      style={styles.modal}
    >
      <h3 style={{ marginTop: 0 }}>Add a website</h3>
      <label style={{ display: "block", marginBottom: "0.5rem" }}>
        Website URL
        <input
          data-testid="website-url-input"
          type="url"
          placeholder="https://example.com/article"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
        />
      </label>
      {/* Dropzone sits DIRECTLY underneath the URL input (D11). */}
      <label
        data-testid="website-snapshot-dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          takeFile(e.dataTransfer.files?.[0] ?? null);
        }}
        style={styles.dropzone}
      >
        {file ? `Snapshot: ${file.name}` : "Drop or choose a snapshot file (.html, .htm, .md, .txt)"}
        <input
          data-testid="website-snapshot-input"
          type="file"
          accept={SNAPSHOT_ACCEPT}
          style={{ display: "none" }}
          onChange={(e) => takeFile(e.target.files?.[0] ?? null)}
        />
      </label>
      {error && (
        <p
          data-testid="website-snapshot-required-error"
          role="alert"
          style={{ color: "#c5221f", fontSize: "0.85rem" }}
        >
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
        <button data-testid="add-website-cancel" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button data-testid="add-website-submit" onClick={() => void submit()} disabled={busy}>
          {busy ? "Adding…" : "Add website"}
        </button>
      </div>
    </div>
  );
}

/**
 * M6 Zotero import surfacing (§2.3). A modal that accepts a raw Zotero export
 * JSON (pasted into a textarea OR loaded from a chosen file) and feeds it to the
 * existing `wb.importZoteroBundle(rawJson)` engine, then reports the summary.
 * The engine method already exists; this only adds the visible UI.
 */
export function ImportZoteroModal({
  wb,
  onClose,
  onImported,
}: {
  wb: Workbench;
  onClose: () => void;
  onImported: () => void;
}): JSX.Element {
  const [rawJson, setRawJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const takeFile = async (f: File | null): Promise<void> => {
    if (!f) return;
    const text = await f.text();
    setRawJson(text);
    setError(null);
  };

  const submit = async (): Promise<void> => {
    if (rawJson.trim() === "") {
      setError("Paste or choose a Zotero export JSON.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await wb.importZoteroBundle(rawJson);
      setSummary(
        `Added ${result.sourcesAdded} source(s), updated ${result.sourcesUpdated}; ` +
          `added ${result.annotationsAdded} annotation(s), updated ${result.annotationsUpdated}.`,
      );
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="import-zotero-modal"
      role="dialog"
      aria-label="Import Zotero"
      style={styles.modal}
    >
      <h3 style={{ marginTop: 0 }}>Import from Zotero</h3>
      <label style={{ display: "block", marginBottom: "0.5rem", fontSize: "0.85rem", color: "#555" }}>
        Paste the Zotero export JSON, or choose a file:
      </label>
      <textarea
        data-testid="zotero-json-input"
        value={rawJson}
        placeholder='{"items": [ … ]}'
        onChange={(e) => setRawJson(e.target.value)}
        rows={6}
        style={{ display: "block", width: "100%", boxSizing: "border-box", fontFamily: "monospace", fontSize: "0.8rem" }}
      />
      <label style={{ display: "inline-block", marginTop: "0.5rem", cursor: "pointer" }}>
        <input
          data-testid="zotero-file-input"
          type="file"
          accept=".json,application/json"
          style={{ display: "none" }}
          onChange={(e) => void takeFile(e.target.files?.[0] ?? null)}
        />
        <span style={{ fontSize: "0.85rem", color: "#1a56db" }}>Choose JSON file…</span>
      </label>
      {error && (
        <p data-testid="zotero-import-error" role="alert" style={{ color: "#c5221f", fontSize: "0.85rem" }}>
          {error}
        </p>
      )}
      {summary && (
        <p data-testid="zotero-import-summary" style={{ color: "#166534", fontSize: "0.85rem" }}>
          {summary}
        </p>
      )}
      <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", marginTop: "0.5rem" }}>
        <button data-testid="import-zotero-cancel" onClick={onClose} disabled={busy}>
          Close
        </button>
        <button data-testid="zotero-import-submit" onClick={() => void submit()} disabled={busy}>
          {busy ? "Importing…" : "Import"}
        </button>
      </div>
    </div>
  );
}

/**
 * The Library is the DEFAULT entry (spec section 5). It lists all imported PDFs
 * as one flat, sortable table, opens a document on double-click/tap, and
 * offers "Open together" to open a multi-selection in a shared workspace with
 * NO implied automatic analysis.
 */
export function Library({
  wb,
  onOpen,
  onOpenTogether,
  onImported,
}: {
  wb: Workbench;
  onOpen: (id: SourceId) => void;
  onOpenTogether: (ids: SourceId[]) => void;
  /** Called after a website import so the shell can re-render the list. */
  onImported?: () => void;
}): JSX.Element {
  const [sortColumn, setSortColumn] = useState<LibrarySortColumn>("title");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [selected, setSelected] = useState<Set<SourceId>>(new Set());
  const [addWebsiteOpen, setAddWebsiteOpen] = useState(false);
  const [importZoteroOpen, setImportZoteroOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const pdfInputRef = useRef<HTMLInputElement>(null);

  const importFiles = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    const count = await importPdfFiles(wb, Array.from(files));
    if (count > 0) onImported?.();
  };
  // One flat list: a document is a document, whatever it was imported as.
  const allSources = wb.rawData().sources;
  // Ids awaiting delete confirmation (row button or bulk action).
  const [pendingDelete, setPendingDelete] = useState<SourceId[] | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Apply the table-header sort (column + direction) on top of the workbench's
  // category grouping. Annotation counts are read live from the workbench.
  const annotationCount = (id: SourceId): number => wb.annotationsForSource(id).length;
  const compare = (a: Source, b: Source): number => {
    let r = 0;
    switch (sortColumn) {
      case "title":
        r = a.title.localeCompare(b.title);
        break;
      case "authors":
        r = sourceAuthors(a.title).localeCompare(sourceAuthors(b.title));
        break;
      case "year":
        r = sourceYear(a.title).localeCompare(sourceYear(b.title));
        break;
      case "pages":
        r = a.pageCount - b.pageCount;
        break;
      case "annotations":
        r = annotationCount(a.id) - annotationCount(b.id);
        break;
      case "importedAt":
        r = a.importedAt.localeCompare(b.importedAt);
        break;
    }
    return sortDir === "asc" ? r : -r;
  };
  const sources = allSources.slice().sort((a, b) => {
    const r = compare(a, b);
    // Stable, predictable tie-break so equal rows never shuffle between renders.
    return r !== 0 ? r : a.title.localeCompare(b.title);
  });

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      for (const id of pendingDelete) await wb.deleteSource(id);
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of pendingDelete) next.delete(id);
        return next;
      });
      setPendingDelete(null);
      onImported?.();
    } finally {
      setDeleting(false);
    }
  };

  const onHeaderSort = (col: LibrarySortColumn): void => {
    if (sortColumn === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(col);
      setSortDir("asc");
    }
  };

  const toggle = (id: SourceId): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <section
      data-testid="library-pdf-dropzone"
      data-dragging={dragging ? "true" : "false"}
      // Full-window drag-and-drop: dropping a .pdf from the OS must NOT navigate
      // the tab away (the browser's default for a dropped file), so every drag
      // event preventDefaults. On drop we import each PDF via the same hash +
      // numPages + wb.importSource path the button uses.
      //
      // stopPropagation is REQUIRED here: this dropzone is a DOM descendant of
      // the `.app-shell` root, which also wires onDragOver/onDrop as the
      // full-window safety net. React synthetic events bubble, so without
      // stopping propagation a drop ON this dropzone would also fire the shell
      // handler and import the SAME file twice (one dropped PDF becoming two
      // Source records, since wb.importSource does not dedupe). Stopping
      // propagation keeps a dropzone drop a single import while the shell
      // handler still guards drops anywhere ELSE in the shell.
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        if (!dragging) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragging(false);
        void importFiles(e.dataTransfer.files);
      }}
      style={styles.dropRoot}
    >
    <section data-testid="library" data-view="library" style={styles.root}>
      <header style={styles.header}>
        <h2 style={{ margin: 0 }}>Library</h2>
        <div>
          <button
            data-testid="import-pdf-btn"
            style={{ marginLeft: "0.75rem", fontWeight: 600 }}
            onClick={() => pdfInputRef.current?.click()}
          >
            + Import PDF
          </button>
          <input
            ref={pdfInputRef}
            data-testid="import-pdf-input"
            type="file"
            accept=".pdf,application/pdf"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              void importFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            data-testid="open-together"
            disabled={selected.size < 2}
            style={{ marginLeft: "0.75rem" }}
            onClick={() => onOpenTogether([...selected])}
          >
            Open together ({selected.size})
          </button>
          {selected.size > 0 && (
            <button
              data-testid="delete-selected"
              style={{ marginLeft: "0.75rem", color: "#b3261e" }}
              onClick={() => setPendingDelete([...selected])}
            >
              Delete selected ({selected.size})
            </button>
          )}
          <button
            data-testid="add-website"
            style={{ marginLeft: "0.75rem" }}
            onClick={() => setAddWebsiteOpen(true)}
          >
            Add website…
          </button>
          <button
            data-testid="import-zotero-btn"
            style={{ marginLeft: "0.75rem" }}
            onClick={() => setImportZoteroOpen(true)}
          >
            Import Zotero
          </button>
        </div>
      </header>

      {addWebsiteOpen && (
        <AddWebsiteModal
          wb={wb}
          onClose={() => setAddWebsiteOpen(false)}
          onImported={() => {
            setAddWebsiteOpen(false);
            onImported?.();
          }}
        />
      )}

      {importZoteroOpen && (
        <ImportZoteroModal
          wb={wb}
          onClose={() => setImportZoteroOpen(false)}
          onImported={() => {
            onImported?.();
          }}
        />
      )}

      {pendingDelete && (
        <DeleteConfirmBar
          wb={wb}
          ids={pendingDelete}
          busy={deleting}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      <div style={styles.tableWrap}>
        {sources.length === 0 && (
          <p data-testid="library-empty" style={{ color: "#777" }}>
            No documents yet.
          </p>
        )}

        {sources.length > 0 && (
          <table data-testid="library-table" style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th} aria-hidden="true" />
                {LIBRARY_COLUMNS.map((col) => (
                  <th key={col.key} style={styles.th}>
                    <button
                      type="button"
                      data-testid={`library-sort-${col.key}`}
                      aria-sort={
                        sortColumn === col.key
                          ? sortDir === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                      style={styles.sortHeader}
                      onClick={() => onHeaderSort(col.key)}
                    >
                      {col.label}
                      {sortColumn === col.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                    </button>
                  </th>
                ))}
                <th style={styles.th} aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <LibraryRow
                  key={source.id}
                  wb={wb}
                  source={source}
                  annotations={annotationCount(source.id)}
                  checked={selected.has(source.id)}
                  onToggle={() => toggle(source.id)}
                  onOpen={() => onOpen(source.id)}
                  onDelete={() => setPendingDelete([source.id])}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
    </section>
  );
}

function LibraryRow({
  wb,
  source,
  annotations,
  checked,
  onToggle,
  onOpen,
  onDelete,
}: {
  wb: Workbench;
  source: Source;
  annotations: number;
  checked: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onDelete: () => void;
}): JSX.Element {
  // A17: the source's PDF binary availability. Offloading evicts ONLY the bytes
  // (the Source + its annotations + citations survive), flipping the badge to
  // "binary-offloaded". Reading the status synchronously keeps the row simple;
  // a bump() after offload re-renders this row from the fresh status.
  const [busy, setBusy] = useState(false);
  const status = wb.sourceBinaryStatus(source.id);
  const offloaded = status === "binary-offloaded";

  const onOffload = async (): Promise<void> => {
    setBusy(true);
    try {
      await wb.offloadSourceBinary(source.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr
      data-testid="library-item"
      data-source-id={source.id}
      style={styles.item}
      onDoubleClick={onOpen}
    >
      <td style={styles.td}>
        <input
          type="checkbox"
          aria-label={`Select ${source.title}`}
          checked={checked}
          onChange={onToggle}
        />
      </td>
      <td style={styles.td}>
        <button
          data-testid="library-open"
          style={styles.openBtn}
          onClick={onOpen}
          title="Open document"
        >
          {source.title}
        </button>
      </td>
      <td data-testid="library-cell-authors" style={styles.td}>
        {sourceAuthors(source.title)}
      </td>
      <td data-testid="library-cell-year" style={styles.td}>
        {sourceYear(source.title)}
      </td>
      <td data-testid="library-cell-pages" style={styles.tdNum}>
        {source.pageCount || "—"}
      </td>
      <td data-testid="library-cell-annotations" style={styles.tdNum}>
        {annotations}
      </td>
      <td data-testid="library-cell-date" style={styles.td}>
        {formatDateAdded(source.importedAt)}
      </td>
      <td style={styles.td}>
        <span
          data-testid="source-binary-status"
          data-source-id={source.id}
          data-status={status}
          style={{
            fontSize: "0.72rem",
            padding: "0.05rem 0.4rem",
            borderRadius: "4px",
            background: offloaded ? "#fef3c7" : "#e6f4ea",
            color: offloaded ? "#92400e" : "#166534",
          }}
        >
          {status}
        </span>
        <button
          data-testid="offload-pdf-binary"
          data-source-id={source.id}
          disabled={busy || offloaded}
          title="Offload the PDF binary to reclaim space (citations are preserved)"
          onClick={() => void onOffload()}
          style={{ fontSize: "0.75rem", marginLeft: "0.4rem" }}
        >
          Offload PDF Binary
        </button>
        <button
          data-testid="delete-source"
          data-source-id={source.id}
          aria-label={`Delete ${source.title}`}
          title="Delete this document and its highlights"
          onClick={onDelete}
          style={{ fontSize: "0.75rem", marginLeft: "0.4rem", color: "#b3261e" }}
        >
          Delete
        </button>
      </td>
    </tr>
  );
}

/**
 * Inline confirmation shown above the table before anything is deleted. States
 * exactly what goes (the file + its highlights) and what stays (quotes already
 * inserted into Subject pages keep their text).
 */
function DeleteConfirmBar({
  wb,
  ids,
  busy,
  onConfirm,
  onCancel,
}: {
  wb: Workbench;
  ids: readonly SourceId[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const sources = wb.rawData().sources.filter((s) => ids.includes(s.id));
  const highlights = ids.reduce((n, id) => n + wb.annotationsForSource(id).length, 0);
  const what =
    sources.length === 1 ? `“${sources[0]!.title}”` : `${sources.length} documents`;
  return (
    <div data-testid="delete-confirm" role="alertdialog" aria-label="Confirm delete" className="ito-confirm-bar">
      <span>
        Delete {what}
        {highlights > 0 ? ` and its ${highlights} highlight${highlights === 1 ? "" : "s"}` : ""}? Quotes
        already inserted into Subject pages keep their text but will no longer link back to the source.
        This can’t be undone.
      </span>
      <span className="ito-confirm-actions">
        <button data-testid="delete-cancel" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button data-testid="delete-confirm-yes" className="ito-confirm-danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Deleting…" : "Delete"}
        </button>
      </span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  dropRoot: { height: "100%", overflowY: "auto" },
  root: { padding: "1.5rem", maxWidth: "72rem", margin: "0 auto" },
  layout: { display: "flex", gap: "1.25rem", alignItems: "flex-start" },
  tree: {
    flex: "0 0 12rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.15rem",
    borderRight: "1px solid #eee",
    paddingRight: "0.75rem",
  },
  treeItem: {
    textAlign: "left",
    border: "none",
    background: "none",
    cursor: "pointer",
    padding: "0.25rem 0.4rem",
    borderRadius: "6px",
    fontSize: "0.9rem",
    color: "#333",
  },
  tableWrap: { flex: 1, minWidth: 0 },
  table: { width: "100%", borderCollapse: "collapse", marginBottom: "1.25rem" },
  th: {
    textAlign: "left",
    borderBottom: "2px solid #e3e0d6",
    padding: "0.3rem 0.5rem",
    fontSize: "0.78rem",
  },
  sortHeader: {
    border: "none",
    background: "none",
    cursor: "pointer",
    font: "inherit",
    fontWeight: 600,
    color: "#555",
    padding: 0,
  },
  td: {
    padding: "0.35rem 0.5rem",
    borderBottom: "1px solid #eee",
    fontSize: "0.88rem",
    verticalAlign: "middle",
  },
  tdNum: {
    padding: "0.35rem 0.5rem",
    borderBottom: "1px solid #eee",
    fontSize: "0.88rem",
    textAlign: "right",
    whiteSpace: "nowrap",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "1rem",
  },
  categoryHeading: {
    fontSize: "0.8rem",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "#888",
    marginBottom: "0.25rem",
  },
  item: {},
  openBtn: {
    textAlign: "left",
    border: "none",
    background: "none",
    fontSize: "0.95rem",
    cursor: "pointer",
    color: "#1a56db",
    padding: 0,
  },
  modal: {
    margin: "0 0 1.25rem",
    padding: "1rem",
    background: "#fff",
    border: "1px solid #dcd6c8",
    borderRadius: "10px",
    boxShadow: "0 6px 24px rgba(0,0,0,0.12)",
  },
  dropzone: {
    display: "block",
    marginTop: "0.5rem",
    padding: "1rem",
    border: "2px dashed #c3bdaf",
    borderRadius: "8px",
    textAlign: "center",
    color: "#666",
    cursor: "pointer",
    fontSize: "0.85rem",
  },
};
