import { useMemo, useState } from "react";
import type { Source, SourceId } from "../model";
import type { Workbench } from "./workbench";

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
