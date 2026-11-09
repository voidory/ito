import { useMemo, useRef, useState } from "react";
import type { Source, SourceId } from "../model";
import type { Workbench } from "./workbench";
import { importPdfFiles } from "./pdfImport";

/** Accepted snapshot file extensions for a website source (A15, D11). */
const SNAPSHOT_ACCEPT = ".html,.htm,.md,.txt";

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
 * organized by category and sorted, opens a document on double-click/tap, and
 * offers "Open together" to open a multi-selection in a shared workspace with
 * NO implied automatic analysis.
 */
export function Library({
  wb,
  categoryScope,
  onScopeChange,
  onOpen,
  onOpenTogether,
  onImported,
}: {
  wb: Workbench;
  categoryScope: string | null;
  onScopeChange: (category: string | null) => void;
  onOpen: (id: SourceId) => void;
  onOpenTogether: (ids: SourceId[]) => void;
  /** Called after a website import so the shell can re-render the list. */
  onImported?: () => void;
}): JSX.Element {
  const [sortBy, setSortBy] = useState<"title" | "importedAt">("title");
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
  const categories = useMemo(() => wb.categories(), [wb, wb.rawData()]);
  const sections = useMemo(
    () => wb.librarySections(sortBy),
    [wb, sortBy, categoryScope, wb.rawData()],
  );

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
          <label style={{ fontSize: "0.85rem", color: "#555", marginRight: "0.75rem" }}>
            Category{" "}
            <select
              data-testid="library-scope"
              value={categoryScope ?? ""}
              onChange={(e) => onScopeChange(e.target.value === "" ? null : e.target.value)}
            >
              <option value="">All</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: "0.85rem", color: "#555" }}>
            Sort by{" "}
            <select
              data-testid="library-sort"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as "title" | "importedAt")}
            >
              <option value="title">Title</option>
              <option value="importedAt">Imported</option>
            </select>
          </label>
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

      {sections.length === 0 && (
        <p data-testid="library-empty" style={{ color: "#777" }}>
          No documents yet.
        </p>
      )}

      {sections.map((section) => (
        <div key={section.category} data-testid="library-category" data-category={section.category}>
          <h3 style={styles.categoryHeading}>{section.category}</h3>
          <ul style={styles.list}>
            {section.sources.map((source) => (
              <LibraryRow
                key={source.id}
                wb={wb}
                source={source}
                checked={selected.has(source.id)}
                onToggle={() => toggle(source.id)}
                onOpen={() => onOpen(source.id)}
              />
            ))}
          </ul>
        </div>
      ))}
    </section>
    </section>
  );
}

function LibraryRow({
  wb,
  source,
  checked,
  onToggle,
  onOpen,
}: {
  wb: Workbench;
  source: Source;
  checked: boolean;
  onToggle: () => void;
  onOpen: () => void;
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
    <li
      data-testid="library-item"
      data-source-id={source.id}
      style={styles.item}
      onDoubleClick={onOpen}
    >
      <input
        type="checkbox"
        aria-label={`Select ${source.title}`}
        checked={checked}
        onChange={onToggle}
      />
      <button
        data-testid="library-open"
        style={styles.openBtn}
        onClick={onOpen}
        title="Open document"
      >
        {source.title}
      </button>
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
        style={{ fontSize: "0.75rem" }}
      >
        Offload PDF Binary
      </button>
      <span style={{ color: "#999", fontSize: "0.8rem" }}>{source.pageCount}pp</span>
    </li>
  );
}

const styles: Record<string, React.CSSProperties> = {
  dropRoot: { minHeight: "100%" },
  root: { padding: "1.5rem", maxWidth: "52rem", margin: "0 auto" },
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
  list: { listStyle: "none", padding: 0, margin: "0 0 1.25rem" },
  item: {
    display: "flex",
    alignItems: "center",
    gap: "0.6rem",
    padding: "0.4rem 0.5rem",
    borderBottom: "1px solid #eee",
  },
  openBtn: {
    flex: 1,
    textAlign: "left",
    border: "none",
    background: "none",
    fontSize: "1rem",
    cursor: "pointer",
    color: "#1a56db",
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
