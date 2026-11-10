import { useCallback, useEffect, useRef, useState } from "react";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { subjectKeymapPlugins } from "./subjectEditorKeymap";
import {
  compositionStats,
  hydrateState,
  serializeState,
  subjectSchema,
  type CompositionStats,
  type DocumentJson,
  type EvidenceAttrs,
} from "../editor";
import type { AnnotationId, PageId } from "../model";
import { INTERSECTION_RELATIONSHIP_KINDS, type AnnotationView, type Workbench } from "./workbench";

/**
 * The continuous subject editor (FEAT-004, spec sections 4.2, 9, 10).
 *
 * ONE rich editable composition: the user writes before/between/after quotes
 * and typed `evidence` nodes are interspersed with no mandatory section or
 * template. Quotes are visually distinguishable from writing and carry quiet
 * source attribution. The ProseMirror document JSON is the durable source of
 * truth; every structural change is serialized back through the Workbench so
 * save/close/reopen restores order, quote identities, provenance and anchors.
 *
 * Insert-evidence-at-cursor records a provenance-bearing EvidenceInstance and
 * derives the (annotation, page) relationship to SOLID. Following a quote asks
 * the parent to navigate to the exact source passage WITHOUT closing this page.
 */
export function SubjectEditor({
  wb,
  pageId,
  onFollowSource,
  onClose,
  bump,
}: {
  wb: Workbench;
  pageId: PageId;
  onFollowSource: (evidenceId: string) => void;
  onClose: () => void;
  bump: () => void;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [stats, setStats] = useState<CompositionStats>(() => wb.compositionStatsForPage(pageId));
  const [showDetails, setShowDetails] = useState(false);
  const [picking, setPicking] = useState(false);
  const [savedTick, setSavedTick] = useState(0);

  const page = wb.rawData().pages.find((p) => p.id === pageId);
  // M13 (§2.1(2/4)): whether the open page is a Subject's overarching Subject
  // Page (a "basin page"), discriminated via workbench state (P4).
  const isBasinPage = wb.isSubjectBasinPage(pageId);
  // M13 (§2.2): the two intersection page kinds. A Subject-intersection page
  // (P3) renders the aspect selector bar; a Node-Intersection / Connecting Page
  // (P2) renders the intersection-page editor surface. Discriminated directly
  // from the page id so the correct surface shows regardless of which open flow
  // mounted this editor.
  const isSubjectIntersectionPage = wb.isSubjectIntersectionPage(pageId);
  const isNodeIntersectionPage = !isSubjectIntersectionPage && wb.isNodeIntersectionPage(pageId);
  const intersectionAspects = isSubjectIntersectionPage ? wb.intersectionAspects(pageId) : null;
  const intersectionRelationshipKind = wb.intersectionRelationshipKind(pageId);
  /**
   * The stored documentJson object this editor last loaded or wrote. When the
   * stored value differs, some OTHER path (e.g. "Insert into subject page..."
   * from the reader menu) changed the page and the editor must re-hydrate
   * instead of overwriting it with its stale state on the next keystroke.
   */
  const lastSyncedDoc = useRef<unknown>(null);
  const storedDoc = useCallback(
    () => wb.rawData().pages.find((p) => p.id === pageId)?.documentJson,
    [wb, pageId],
  );

  /** Replace the editor state from stored JSON, keeping the cursor nearby. */
  const rehydrateFromStore = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const json = wb.subjectDocJson(pageId) as DocumentJson;
    const fresh = EditorState.create({
      schema: subjectSchema,
      doc: hydrateState(json).doc,
      plugins: subjectKeymapPlugins(),
    });
    const pos = Math.min(view.state.selection.from, fresh.doc.content.size);
    let next = fresh;
    try {
      next = fresh.apply(fresh.tr.setSelection(TextSelection.near(fresh.doc.resolve(pos))));
    } catch {
      // keep default selection
    }
    view.updateState(next);
    lastSyncedDoc.current = storedDoc();
    setStats(compositionStats(next.doc));
  }, [wb, pageId, storedDoc]);

  /** True (and the editor re-hydrated) when the stored doc changed elsewhere. */
  const syncIfChangedElsewhere = useCallback((): boolean => {
    if (!viewRef.current || storedDoc() === lastSyncedDoc.current) return false;
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    rehydrateFromStore();
    return true;
  }, [storedDoc, rehydrateFromStore]);

  const refreshStats = useCallback(() => {
    const view = viewRef.current;
    if (view) setStats(compositionStats(view.state.doc));
  }, []);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      const view = viewRef.current;
      if (!view) return;
      // An external mutation already folded this editor's live content in
      // (Workbench.pullLiveDoc); adopt the result rather than overwrite it.
      if (syncIfChangedElsewhere()) return;
      const pending = wb.saveSubjectDoc(pageId, serializeState(view.state));
      // saveSubjectDoc updates memory synchronously; record what we wrote.
      lastSyncedDoc.current = storedDoc();
      void pending
        .then(() => {
          setSavedTick((t) => t + 1);
          bump();
        })
        .catch(() => bump()); // surfaced by the Reader's save-error banner
    }, 150);
  }, [wb, pageId, bump, storedDoc, syncIfChangedElsewhere]);

  // Build the editor once per page id.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const json = wb.subjectDocJson(pageId) as DocumentJson;
    const state = EditorState.create({
      schema: subjectSchema,
      doc: hydrateState(json).doc,
      plugins: subjectKeymapPlugins(),
    });
    const view = new EditorView(host, {
      state,
      nodeViews: {
        evidence: (node) =>
          new EvidenceNodeView(
            node.attrs as unknown as EvidenceAttrs,
            onFollowSource,
            // FEAT-002 (2.4c): resolve a cited area annotation's cropped figure
            // image so the chip can render its thumbnail.
            (annotationId) => {
              const ann = wb.rawData().annotations.find((a) => a.id === annotationId);
              return ann && ann.scope.kind === "area"
                ? ann.scope.anchor.imageDataUrl ?? null
                : null;
            },
          ),
      },
      dispatchTransaction(tr) {
        const next = view.state.apply(tr);
        view.updateState(next);
        if (tr.docChanged) {
          refreshStats();
          scheduleSave();
        }
      },
    });
    view.dom.setAttribute("data-testid", "subject-prosemirror");
    viewRef.current = view;
    lastSyncedDoc.current = storedDoc();
    const detach = wb.attachLiveDoc(pageId, () => serializeState(view.state));
    setStats(compositionStats(state.doc));
    return () => {
      // Flush a pending debounced save instead of dropping it: closing the page
      // (or leaving for the library) right after typing must not lose text.
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        void wb.saveSubjectDoc(pageId, serializeState(view.state)).catch(() => undefined);
      }
      detach();
      view.destroy();
      viewRef.current = null;
    };
    // Built once per page: the callbacks used inside are stable for (wb, pageId).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wb, pageId]);

  // After every render, pick up changes made to this page by other paths.
  useEffect(() => {
    syncIfChangedElsewhere();
  });

  // Insert a quote at the CURRENT cursor position from a chosen annotation.
  const insertAtCursor = useCallback(
    async (annotationId: AnnotationId, includeComment: boolean) => {
      const view = viewRef.current;
      if (!view) return;
      const pos = view.state.selection.from;
      // Flush any pending composition edits first so the inserted-at position
      // reflects the latest text the user typed.
      // (insertEvidenceIntoPage also pulls the live doc; failures surface via
      // the save-error banner while the change stays in memory.)
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        await wb.saveSubjectDoc(pageId, serializeState(view.state)).catch(() => undefined);
      }
      await wb
        .insertEvidenceIntoPage(annotationId, pageId, { pos, includeComment })
        .catch(() => undefined);
      // Re-hydrate the editor from the canonical stored JSON (source of truth).
      const json = wb.subjectDocJson(pageId) as DocumentJson;
      const nextState = EditorState.create({
        schema: subjectSchema,
        doc: hydrateState(json).doc,
        plugins: subjectKeymapPlugins(),
      });
      view.updateState(nextState);
      lastSyncedDoc.current = storedDoc();
      setStats(compositionStats(nextState.doc));
      setPicking(false);
      bump();
    },
    [wb, pageId, bump, storedDoc],
  );

  // Move the block containing the cursor up or down (reorder, A04).
  const move = useCallback(
    async (dir: -1 | 1) => {
      const view = viewRef.current;
      if (!view) return;
      const $from = view.state.selection.$from;
      const blockIndex = $from.index(0);
      const target = blockIndex + dir;
      // moveSubjectBlock first pulls this editor's live (unsaved) content, so
      // text typed moments ago is moved with the block, not discarded.
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      await wb.moveSubjectBlock(pageId, blockIndex, target).catch(() => undefined);
      const json = wb.subjectDocJson(pageId) as DocumentJson;
      const nextState = EditorState.create({
        schema: subjectSchema,
        doc: hydrateState(json).doc,
        plugins: subjectKeymapPlugins(),
      });
      // Keep the cursor on the moved block so successive moves feel continuous.
      const clampedIndex = Math.max(0, Math.min(target, nextState.doc.childCount - 1));
      let pos = 1;
      for (let i = 0; i < clampedIndex; i++) pos += nextState.doc.child(i).nodeSize;
      const withSel = nextState.apply(
        nextState.tr.setSelection(TextSelection.create(nextState.doc, Math.min(pos, nextState.doc.content.size))),
      );
      view.updateState(withSel);
      lastSyncedDoc.current = storedDoc();
      setStats(compositionStats(withSel.doc));
      view.focus();
      bump();
    },
    [wb, pageId, bump, storedDoc],
  );

  // Recomputed every render: annotations made in the reader after this editor
  // opened must appear in the picker (a memo keyed on editor state missed them).
  void savedTick;
  const annotations: AnnotationView[] = [];
  for (const src of wb.rawData().sources) annotations.push(...wb.annotationsForSource(src.id));

  if (!page) {
    return <div data-testid="subject-editor">Subject not found.</div>;
  }

  return (
    <section
      data-testid="subject-editor"
      data-page-id={pageId}
      data-basin-page={isBasinPage ? "true" : undefined}
      data-subject-intersection-page={isSubjectIntersectionPage ? "true" : undefined}
      data-node-intersection-page={isNodeIntersectionPage ? "true" : undefined}
      style={styles.root}
    >
      {isBasinPage && (
        <div data-testid="subject-basin-page" data-page-id={pageId} hidden />
      )}
      {/* M13 (§2.2, P2): a Node-Intersection / Connecting Page editor surface. */}
      {isNodeIntersectionPage && (
        <div data-testid="intersection-page-editor" data-page-id={pageId} hidden />
      )}
      {/* M13 (§2.2, P3): the unified Subject-intersection page + its Intersection
          Aspect Selector Bar (core overlap + pairwise sub-overlaps + a
          relationship-kind selector + the LIVE list of Observation Nodes inside
          the overlap). */}
      {isSubjectIntersectionPage && intersectionAspects && (
        <div data-testid="subject-intersection-page" data-page-id={pageId}>
          <div
            data-testid="subject-intersection-aspect-bar"
            role="tablist"
            aria-label="Intersection aspects"
            style={styles.aspectBar}
          >
            <button
              type="button"
              data-testid="aspect-pill"
              data-aspect-kind="core"
              data-subject-ids={intersectionAspects.corePill.subjectIds.join("|")}
              className="ito-aspect-pill ito-aspect-pill-core"
            >
              {intersectionAspects.corePill.label}
            </button>
            {intersectionAspects.pairwisePills.map((pill) => (
              <button
                key={pill.subjectIds.join("|")}
                type="button"
                data-testid="aspect-pill"
                data-aspect-kind="pairwise"
                data-subject-ids={pill.subjectIds.join("|")}
                className="ito-aspect-pill ito-aspect-pill-pairwise"
              >
                {pill.label}
              </button>
            ))}
            <label style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
              <span style={{ fontSize: "0.75rem", color: "#666" }}>Relationship</span>
              <select
                data-testid="aspect-relationship-kind"
                value={intersectionRelationshipKind}
                onChange={(e) => {
                  wb.setIntersectionRelationshipKind(
                    pageId,
                    e.target.value as typeof intersectionRelationshipKind,
                  );
                  bump();
                }}
              >
                {INTERSECTION_RELATIONSHIP_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <ul
            data-testid="intersection-nodes-inside"
            style={{ listStyle: "none", margin: 0, padding: "0.25rem 0.75rem", fontSize: "0.8rem" }}
          >
            {intersectionAspects.nodesInside.length === 0 && (
              <li data-testid="intersection-nodes-empty" style={{ color: "#888" }}>
                No Observation Nodes inside this overlap yet
              </li>
            )}
            {intersectionAspects.nodesInside.map((n) => (
              <li
                key={n.pageId}
                data-testid="intersection-node-inside"
                data-page-id={n.pageId}
              >
                {n.title}
              </li>
            ))}
          </ul>
        </div>
      )}
      <header className="ito-pane-header" style={styles.header}>
        <h2
          data-testid="subject-title"
          className="ito-pane-title"
          title={page.title}
          style={{ margin: 0, fontSize: "1.1rem" }}
        >
          {page.title}
        </h2>
        <div className="ito-pane-actions">
          <button data-testid="insert-at-cursor" onClick={() => setPicking((v) => !v)} aria-pressed={picking}>
            Insert quote at cursor
          </button>
          <button data-testid="move-block-up" onClick={() => void move(-1)} title="Move block up">
            ↑ Move up
          </button>
          <button data-testid="move-block-down" onClick={() => void move(1)} title="Move block down">
            ↓ Move down
          </button>
          <button
            data-testid="toggle-details"
            aria-pressed={showDetails}
            aria-expanded={showDetails}
            onClick={() => setShowDetails((v) => !v)}
          >
            {showDetails ? "Hide details" : "Show details"}
          </button>
          <button
            data-testid="close-subject"
            className="ito-pane-close"
            aria-label="Close subject page"
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </header>

      {picking && (
        <AnnotationPicker
          annotations={annotations}
          onPick={(id, includeComment) => void insertAtCursor(id, includeComment)}
          onClose={() => setPicking(false)}
        />
      )}

      <div ref={hostRef} data-testid="subject-doc" style={styles.doc} />

      {showDetails && (
        <aside data-testid="subject-details" style={styles.details}>
          <h3 style={{ margin: "0 0 0.5rem" }}>Structural details</h3>
          <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
            <li data-testid="detail-blocks">Blocks: {stats.blockCount}</li>
            <li data-testid="detail-paragraphs">Paragraphs: {stats.paragraphCount}</li>
            <li data-testid="detail-headings">Headings: {stats.headingCount}</li>
            <li data-testid="detail-quotes">Quotes: {stats.quoteCount}</li>
            <li data-testid="detail-sources">Source documents: {stats.sourceCount}</li>
          </ul>
          <h4 style={{ margin: "0.75rem 0 0.25rem" }}>Quotes</h4>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {stats.quotes.map((q) => (
              <li
                key={q.evidenceId}
                data-testid="detail-quote-row"
                data-evidence-id={q.evidenceId}
                style={{ fontSize: "0.8rem", padding: "0.15rem 0" }}
              >
                <button
                  data-testid="detail-follow-source"
                  data-evidence-id={q.evidenceId}
                  onClick={() => onFollowSource(q.evidenceId)}
                >
                  ↩ source
                </button>{" "}
                <span>“{q.quotedText.slice(0, 48)}”</span>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </section>
  );
}

/**
 * A ProseMirror NodeView for the typed `evidence` node. Renders the quote as a
 * distinguishable inline chip with quiet source attribution and a "follow to
 * source" affordance. The data-* attributes mirror the JSON (which remains the
 * source of truth) so Playwright can locate and follow the quote.
 */
class EvidenceNodeView {
  readonly dom: HTMLElement;

  constructor(
    attrs: EvidenceAttrs,
    private readonly onFollow: (evidenceId: string) => void,
    resolveFigure?: (annotationId: string) => string | null,
  ) {
    const chip = document.createElement("span");
    chip.className = "evidence-chip";
    chip.setAttribute("data-testid", "evidence-chip");
    chip.setAttribute("data-evidence-id", attrs.evidenceId);
    chip.setAttribute("data-source-id", attrs.sourceId);
    chip.setAttribute("data-annotation-id", attrs.annotationId);
    chip.setAttribute("data-mode", attrs.mode);
    chip.contentEditable = "false";

    // FEAT-002 (2.4c): when the cited annotation is an area/figure annotation
    // with a captured crop, show its thumbnail inside the chip.
    const figureUrl = resolveFigure?.(attrs.annotationId) ?? null;
    if (figureUrl) {
      const img = document.createElement("img");
      img.setAttribute("data-testid", "area-figure-preview");
      img.src = figureUrl;
      img.alt = "Cited figure";
      img.style.maxHeight = "3rem";
      img.style.maxWidth = "100%";
      img.style.display = "block";
      img.style.marginBottom = "0.2rem";
      chip.appendChild(img);
    }

    const quote = document.createElement("span");
    quote.className = "evidence-quote";
    quote.textContent = `“${attrs.quotedText}”`;
    chip.appendChild(quote);

    const follow = document.createElement("button");
    follow.className = "evidence-follow";
    follow.setAttribute("data-testid", "follow-source");
    follow.setAttribute("data-evidence-id", attrs.evidenceId);
    follow.setAttribute("aria-label", "Go to source passage");
    follow.textContent = "↩";
    follow.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onFollow(attrs.evidenceId);
    });
    chip.appendChild(follow);

    this.dom = chip;
  }

  // The node is an atom: no contentDOM, no editable child content.
  stopEvent(): boolean {
    return false;
  }
  ignoreMutation(): boolean {
    return true;
  }
}

/** A compact picker that lists the reader's annotations to insert as a quote. */
function AnnotationPicker({
  annotations,
  onPick,
  onClose,
}: {
  annotations: readonly AnnotationView[];
  onPick: (id: AnnotationId, includeComment: boolean) => void;
  onClose: () => void;
}): JSX.Element {
  const [includeComment, setIncludeComment] = useState(false);
  return (
    <div data-testid="insert-picker" style={styles.picker}>
      <label style={{ fontSize: "0.8rem", display: "flex", alignItems: "center", gap: "0.3rem" }}>
        <input
          type="checkbox"
          data-testid="include-comment"
          checked={includeComment}
          onChange={(e) => setIncludeComment(e.target.checked)}
        />
        Include annotation comment (marked as copied)
      </label>
      <ul style={{ listStyle: "none", margin: "0.4rem 0 0", padding: 0, maxHeight: "12rem", overflow: "auto" }}>
        {annotations.map((v) => {
          const label =
            v.annotation.scope.kind === "text"
              ? v.annotation.scope.anchor.selectedText.slice(0, 48)
              : (v.rangeLabel ?? "range");
          return (
            <li key={v.annotation.id}>
              <button
                data-testid="insert-annotation-option"
                data-annotation-id={v.annotation.id}
                style={{ width: "100%", textAlign: "left" }}
                onClick={() => onPick(v.annotation.id, includeComment)}
              >
                {label}
              </button>
            </li>
          );
        })}
        {annotations.length === 0 && (
          <li data-testid="insert-empty" style={{ color: "#888" }}>
            No annotations yet
          </li>
        )}
      </ul>
      <button data-testid="insert-cancel" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minWidth: 0,
    width: "100%",
    background: "#fff",
  },
  header: {
    // FIX-NARROW-PANE-TOOLBARS (§3.3): single-row toolbar that never wraps the
    // close "×" onto a second row in a narrow 2/3-pane layout. The title
    // ellipsizes; the action buttons stay compact and on one line (see
    // .ito-pane-header/.ito-pane-title/.ito-pane-actions in theme.css).
    display: "flex",
    alignItems: "center",
    flexWrap: "nowrap",
    gap: "6px",
    overflowX: "auto",
    padding: "0.6rem 0.9rem",
    borderBottom: "1px solid #eee",
    background: "#fafafa",
  },
  doc: {
    flex: 1,
    overflow: "auto",
    padding: "1rem 1.2rem",
    lineHeight: 1.6,
  },
  details: {
    borderTop: "1px solid #eee",
    padding: "0.6rem 0.9rem",
    background: "#fcfcfc",
    fontSize: "0.85rem",
  },
  picker: {
    border: "1px solid #ccc",
    borderRadius: "8px",
    padding: "0.5rem 0.7rem",
    margin: "0.5rem 0.9rem 0",
    background: "#fff",
    boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
  },
  aspectBar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.35rem",
    padding: "0.4rem 0.75rem",
    borderBottom: "1px solid #eee",
    background: "#f7f5f0",
  },
};
