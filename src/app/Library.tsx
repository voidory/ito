import { useMemo, useState } from "react";
import type { Source, SourceId } from "../model";
import type { Workbench } from "./workbench";

/**
 * The Library is the DEFAULT entry (spec section 5). It lists all imported PDFs
 * organized by category and sorted, opens a document on double-click/tap, and
 * offers "Open together" to open a multi-selection in a shared workspace with
 * NO implied automatic analysis.
 */
export function Library({
  wb,
  onOpen,
  onOpenTogether,
}: {
  wb: Workbench;
  onOpen: (id: SourceId) => void;
  onOpenTogether: (ids: SourceId[]) => void;
}): JSX.Element {
  const [sortBy, setSortBy] = useState<"title" | "importedAt">("title");
  const [selected, setSelected] = useState<Set<SourceId>>(new Set());
  const sections = useMemo(() => wb.librarySections(sortBy), [wb, sortBy, wb.rawData()]);

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
        </div>
      </header>

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
  source,
  checked,
  onToggle,
  onOpen,
}: {
  source: Source;
  checked: boolean;
  onToggle: () => void;
  onOpen: () => void;
}): JSX.Element {
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
};
