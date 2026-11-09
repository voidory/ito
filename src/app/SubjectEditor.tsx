import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { AnnotationView, Workbench } from "./workbench";

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

  const refreshStats = useCallback(() => {
    const view = viewRef.current;
    if (view) setStats(compositionStats(view.state.doc));
  }, []);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const view = viewRef.current;
      if (!view) return;
      void wb
        .saveSubjectDoc(pageId, serializeState(view.state))
        .then(() => {
          setSavedTick((t) => t + 1);
          bump();
        })
        .catch((err) => console.error("subject save failed", err));
    }, 150);
  }, [wb, pageId, bump]);

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
        evidence: (node) => new EvidenceNodeView(node.attrs as unknown as EvidenceAttrs, onFollowSource),
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
    setStats(compositionStats(state.doc));
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      view.destroy();
      viewRef.current = null;
    };
  }, [wb, pageId, onFollowSource, refreshStats, scheduleSave]);

  // Insert a quote at the CURRENT cursor position from a chosen annotation.
  const insertAtCursor = useCallback(
    async (annotationId: AnnotationId, includeComment: boolean) => {
      const view = viewRef.current;
      if (!view) return;
      const pos = view.state.selection.from;
      // Flush any pending composition edits first so the inserted-at position
      // reflects the latest text the user typed.
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        await wb.saveSubjectDoc(pageId, serializeState(view.state));
      }
      await wb.insertEvidenceIntoPage(annotationId, pageId, { pos, includeComment });
      // Re-hydrate the editor from the canonical stored JSON (source of truth).
      const json = wb.subjectDocJson(pageId) as DocumentJson;
      const nextState = EditorState.create({
        schema: subjectSchema,
        doc: hydrateState(json).doc,
        plugins: subjectKeymapPlugins(),
      });
      view.updateState(nextState);
      setStats(compositionStats(nextState.doc));
      setPicking(false);
      bump();
    },
    [wb, pageId, bump],
  );

  // Move the block containing the cursor up or down (reorder, A04).
  const move = useCallback(
    async (dir: -1 | 1) => {
      const view = viewRef.current;
      if (!view) return;
      const $from = view.state.selection.$from;
      const blockIndex = $from.index(0);
      const target = blockIndex + dir;
      await wb.moveSubjectBlock(pageId, blockIndex, target);
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
      setStats(compositionStats(withSel.doc));
      view.focus();
      bump();
    },
    [wb, pageId, bump],
  );

  const annotations = useMemo(() => {
    const data = wb.rawData();
    const views: AnnotationView[] = [];
    for (const s of data.sources) views.push(...wb.annotationsForSource(s.id));
    return views;
  }, [wb, savedTick, stats]);

  if (!page) {
    return <div data-testid="subject-editor">Subject not found.</div>;
  }

  return (
    <section data-testid="subject-editor" data-page-id={pageId} style={styles.root}>
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
  ) {
    const chip = document.createElement("span");
    chip.className = "evidence-chip";
    chip.setAttribute("data-testid", "evidence-chip");
    chip.setAttribute("data-evidence-id", attrs.evidenceId);
    chip.setAttribute("data-source-id", attrs.sourceId);
    chip.setAttribute("data-annotation-id", attrs.annotationId);
    chip.setAttribute("data-mode", attrs.mode);
    chip.contentEditable = "false";

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
};
