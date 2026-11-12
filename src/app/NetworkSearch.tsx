/**
 * NetworkSearch (FEAT-005, M2-FIX-2) — the shell-level search surface for the
 * concept network. Mounted in the App shell header next to the Files/Nodes
 * ViewSwitch so it is reachable in BOTH the Files and Nodes views.
 *
 * It drives the REAL Workbench: `wb.search(query, { categoryId? })` returns a
 * deterministic, discriminated result list (page / category / annotation).
 * Selecting a result OPENS the match using EXISTING Workbench transitions and
 * creates ZERO durable records:
 *
 *  - a 'page' result   => `wb.openSubjectPage(id)` (and, when the Nodes view is
 *                         active, `wb.setFocusedPageId(id)` so the located node
 *                         is centered);
 *  - a 'category' result => `wb.setCategoryScope(categoryName)`;
 *  - an 'annotation' result => `wb.openSource(sourceId)` (open its source in the
 *                              Reader).
 *
 * The surface is keyboard-accessible (a real <input> + <button> items) and does
 * NOT animate. Results are derived synchronously from the live graph on every
 * keystroke — there is no separate search index to keep in sync.
 */

import { useState } from "react";
import type { PageId, SourceId } from "../model";
import type { Workbench } from "./workbench";

export function NetworkSearch({
  wb,
  categoryScope,
  bump,
}: {
  wb: Workbench;
  /** The active library category scope (a category NAME) or null for all. */
  categoryScope: string | null;
  bump: () => void;
}): JSX.Element {
  const [query, setQuery] = useState("");

  // Translate the active scope NAME into a CategoryId so page results can be
  // restricted to the scoped category's members (search is name-agnostic).
  const scopedCategoryId =
    categoryScope != null
      ? (wb.rawData().categories.find((c) => c.name === categoryScope)?.id ?? undefined)
      : undefined;

  const results = wb.search(
    query,
    scopedCategoryId != null ? { categoryId: scopedCategoryId } : {},
  );

  const onSelect = (result: (typeof results)[number]): void => {
    if (result.kind === "page") {
      wb.openSubjectPage(result.id as PageId);
      if (wb.viewMode() === "nodes") wb.setFocusedPageId(result.id as PageId);
    } else if (result.kind === "category") {
      wb.setCategoryScope(result.name);
    } else {
      wb.openSource(result.sourceId as SourceId);
    }
    bump();
  };

  const labelFor = (result: (typeof results)[number]): string => {
    if (result.kind === "page") return result.title;
    if (result.kind === "category") return result.name;
    return result.anchorText || result.comment;
  };

  return (
    <div
      data-testid="network-search"
      role="search"
      style={{ position: "relative", padding: "0.5rem 1rem", flex: 1, minWidth: 0 }}
    >
      <input
        data-testid="network-search-input"
        type="search"
        aria-label="Search pages, categories and annotations"
        placeholder="Search pages, categories, annotations…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ width: "100%", boxSizing: "border-box", padding: "0.25rem 0.5rem" }}
      />
      {results.length > 0 ? (
        <ul
          data-testid="network-search-results"
          role="listbox"
          aria-label="Search results"
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            position: "absolute",
            left: "1rem",
            right: "1rem",
            zIndex: 20,
            background: "#fff",
            border: "1px solid #e5e2dc",
            maxHeight: "16rem",
            overflowY: "auto",
          }}
        >
          {results.map((result) => (
            <li key={`${result.kind}:${result.id}`} role="presentation">
              <button
                data-testid="network-search-result"
                data-result-kind={result.kind}
                data-result-id={result.id}
                role="option"
                aria-selected={false}
                onClick={() => onSelect(result)}
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  width: "100%",
                  textAlign: "left",
                  padding: "0.35rem 0.5rem",
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                }}
              >
                <span
                  data-testid="network-search-result-kind"
                  style={{ opacity: 0.6, textTransform: "uppercase", fontSize: "0.7em" }}
                >
                  {result.kind}
                </span>
                <span data-testid="network-search-result-label">{labelFor(result)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
