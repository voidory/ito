import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icons } from "../ui/icons";
import type { AnnotationId, PageId } from "../../model";
import { HIGHLIGHT_COLORS, type Workbench } from "../workbench";
import {
  swatch,
  type ContextMenuState,
  type MenuState,
  type OffloadedPopover,
} from "./overlayShared";

/**
 * M10 split of the reader annotation menus + comment/offloaded surfaces out of
 * AnnotationOverlays.tsx. Everything here is re-exported from the
 * AnnotationOverlays.tsx barrel (and Reader.tsx) so existing imports keep
 * resolving. Presentation is CSS-class driven (theme.css); only dynamic colour
 * swatches remain inline.
 */

/* --------------------------------------------------------------------- */
/* Context menu                                                          */
/* --------------------------------------------------------------------- */

/**
 * The right-click context menu. Two variants: an annotation menu and a page
 * menu. Exported as both ReaderContextMenu (legacy) and ContextMenu (M9 name).
 */
export function ReaderContextMenu({
  wb,
  menu,
  onClose,
  onEditComment,
  onPageAction,
  bump,
}: {
  wb: Workbench;
  menu: ContextMenuState;
  onClose: () => void;
  onEditComment: (annotationId: AnnotationId, x: number, y: number) => void;
  onPageAction: (action: "range" | "area" | "switch" | "lines" | "motion") => void;
  bump: () => void;
}): JSX.Element {
  const [picking, setPicking] = useState<null | "associate" | "insert">(null);
  const ref = useRef<HTMLDivElement>(null);
  const MENU_WIDTH = 248;
  const [pos, setPos] = useState<{ left: number; top: number }>(() => ({
    left: Math.max(
      8,
      Math.min(menu.x, ((typeof window !== "undefined" && window.innerWidth) || 1024) - MENU_WIDTH - 8),
    ),
    top: menu.y,
  }));

  // Flip/clamp against the viewport once the real height is known so the menu
  // never opens off-screen (it opens upward / shifts in when near an edge).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof window === "undefined") return;
    const h = el.offsetHeight;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    let top = menu.y;
    if (top + h > vh - 8) top = Math.max(8, menu.y - h);
    if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
    const left = Math.max(8, Math.min(menu.x, vw - MENU_WIDTH - 8));
    setPos((p) => (p.left === left && p.top === top ? p : { left, top }));
  }, [menu.x, menu.y, picking]);

  // Esc and any pointer-up outside the menu dismiss it. We close on `mouseup`
  // (not `mousedown`) so a focused textarea/input inside any sibling surface
  // commits its blur handler before this menu unmounts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    const onUp = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    const t = setTimeout(() => document.addEventListener("mouseup", onUp), 0);
    return () => {
      document.removeEventListener("keydown", onKey);
      clearTimeout(t);
      document.removeEventListener("mouseup", onUp);
    };
  }, [onClose]);

  const style: React.CSSProperties = {
    position: "fixed",
    left: pos.left,
    top: pos.top,
    width: MENU_WIDTH,
  };

  if (menu.variant === "page") {
    return (
      <div
        ref={ref}
        data-testid="reader-context-menu"
        data-variant="page"
        role="menu"
        aria-label="Page actions"
        className="ito-ctx-menu"
        style={style}
      >
        <MenuRow testId="ctx-comment-range" icon={Icons.comment} label="Comment on page range…" onClick={() => onPageAction("range")} />
        <MenuRow testId="ctx-select-area" icon={Icons.area} label="Select figure or area" shortcut="A" onClick={() => onPageAction("area")} />
        <div className="ito-ctx-sep" role="separator" />
        <MenuRow testId="ctx-switch-paper" icon={Icons.swap} label="Switch paper…" onClick={() => onPageAction("switch")} />
        <MenuRow testId="ctx-toggle-lines" icon={Icons.lines} label="Toggle source lines" onClick={() => onPageAction("lines")} />
        <MenuRow testId="ctx-toggle-motion" icon={Icons.motion} label="Reduce motion" onClick={() => onPageAction("motion")} />
      </div>
    );
  }

  if (picking) {
    return (
      <div
        ref={ref}
        data-testid="reader-context-menu"
        data-variant="annotation"
        role="menu"
        className="ito-ctx-menu ito-ctx-menu-picker"
        style={style}
      >
        <AssociationMenu
          wb={wb}
          menu={{ annotationId: menu.annotationId, sourceId: menu.sourceId, x: 0, y: 0 }}
          embedded
          onClose={onClose}
          bump={bump}
        />
      </div>
    );
  }

  return (
    <div
      ref={ref}
      data-testid="reader-context-menu"
      data-variant="annotation"
      role="menu"
      aria-label="Annotation actions"
      className="ito-ctx-menu"
      style={style}
    >
      <div className="ito-ctx-colors">
        <span className="ito-ctx-section-label">Colour</span>
        <ContextColorSwatches wb={wb} annotationId={menu.annotationId} bump={bump} />
      </div>
      <div className="ito-ctx-sep" role="separator" />
      <MenuRow
        testId="ctx-edit-comment"
        icon={Icons.pencil}
        label="Edit comment"
        onClick={() => onEditComment(menu.annotationId, menu.x, menu.y)}
      />
      <MenuRow testId="ctx-associate" icon={Icons.link} label="Associate with Subject…" onClick={() => setPicking("associate")} />
      <MenuRow testId="ctx-insert" icon={Icons.quote} label="Insert quote into Subject…" onClick={() => setPicking("insert")} />
      <ShowInNodes wb={wb} annotationId={menu.annotationId} bump={bump} asMenuRow />
      <div className="ito-ctx-sep" role="separator" />
      <MenuRow
        testId="delete-highlight-only"
        icon={Icons.trash}
        label="Delete highlight"
        danger
        onClick={async () => {
          await wb.deleteAnnotationOnly(menu.annotationId);
          bump();
          onClose();
        }}
      />
      <MenuRow
        testId="delete-highlight-and-quotes"
        icon={Icons.trashAll}
        label="Delete highlight and quotes"
        danger
        onClick={async () => {
          await wb.deleteAnnotationAndQuotes(menu.annotationId);
          bump();
          onClose();
        }}
      />
    </div>
  );
}

/** One left-aligned, icon-led row of the reader context menu. */
function MenuRow({
  testId,
  icon,
  label,
  shortcut,
  danger,
  onClick,
}: {
  testId: string;
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  danger?: boolean;
  onClick: () => void | Promise<void>;
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      className={["ito-ctx-item", danger ? "ito-ctx-item-danger" : null].filter(Boolean).join(" ")}
      onClick={() => void onClick()}
    >
      <span className="ito-ctx-item-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="ito-ctx-item-label">{label}</span>
      {shortcut && <kbd className="ito-ctx-item-kbd">{shortcut}</kbd>}
    </button>
  );
}

/** M9 name for the right-click context menu. */
export const ContextMenu = ReaderContextMenu;

/** Inline colour swatches used inside the annotation context menu. */
function ContextColorSwatches({
  wb,
  annotationId,
  bump,
}: {
  wb: Workbench;
  annotationId: AnnotationId;
  bump: () => void;
}): JSX.Element {
  const view = wb.viewFor(annotationId);
  return (
    <div
      data-testid="color-controls"
      role="group"
      aria-label="Color swatches"
      className="ito-color-controls"
    >
      {HIGHLIGHT_COLORS.map((c) => (
        <button
          key={c}
          data-testid={`color-${c}`}
          aria-label={`Color ${c}`}
          onClick={async () => {
            const kind = view?.style.kind ?? "highlight";
            await wb.setAnnotationStyle(annotationId, { kind, color: c });
            bump();
          }}
          className="ito-color-dot"
          data-selected={view?.style.color === c ? "true" : undefined}
          style={{ background: swatch(c) }}
        />
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------- */
/* Comment surface                                                       */
/* --------------------------------------------------------------------- */

/**
 * Quiet comment surface (R02, R10). It resets its draft whenever it switches to
 * a DIFFERENT annotation so one highlight's in-progress comment can never leak
 * into another (keyed on annotationId).
 */
export function CommentSurface({
  wb,
  annotationId,
  onClose,
  bump,
  embedded = false,
}: {
  wb: Workbench;
  annotationId: AnnotationId;
  onClose: () => void;
  bump: () => void;
  /** Rendered inside the annotation popover: flows inline instead of floating. */
  embedded?: boolean;
}): JSX.Element {
  const view = wb.viewFor(annotationId);
  const [draft, setDraft] = useState(view?.annotation.comment ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(wb.viewFor(annotationId)?.annotation.comment ?? "");
    setError(null);
  }, [wb, annotationId]);

  // `closeAfter` is true for the explicit Save button. Autosave-on-blur passes
  // false: leaving the textarea (to click the sidebar toggle, say) must keep the
  // draft and the popover, never dismiss them.
  const save = async (closeAfter = true): Promise<void> => {
    try {
      await wb.setComment(annotationId, draft);
      setError(null);
      bump();
      if (closeAfter) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      bump();
    }
  };

  return (
    <div
      data-testid="comment-surface"
      data-annotation-id={annotationId}
      role="dialog"
      aria-label="Annotation comment"
      className={embedded ? "ito-comment-embedded" : "ito-comment-surface-floating"}
    >
      {view?.rangeLabel && (
        <div data-testid="range-label" style={{ fontWeight: 600 }}>
          {view.rangeLabel}
        </div>
      )}
      <textarea
        data-testid="comment-input"
        value={draft}
        placeholder="Add a quiet comment (optional)"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          // Autosave only a real change; an untouched draft needs no write.
          if (draft !== (wb.viewFor(annotationId)?.annotation.comment ?? "")) void save(false);
        }}
      />
      {error && (
        <p data-testid="comment-error" role="alert" className="ito-comment-error">
          Could not save: {error}. Your draft is kept.
        </p>
      )}
      <div className="ito-comment-surface-foot">
        <button data-testid="comment-cancel" onClick={onClose}>
          Close
        </button>
        <button
          data-testid="comment-save"
          // Keep focus in the textarea so Save is ONE save (no blur-autosave
          // racing the click).
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void save()}
        >
          Save
        </button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- */
/* Association + nodes menus                                             */
/* --------------------------------------------------------------------- */

/**
 * Right-click / keyboard-menu equivalent (R15). Offers "Associate with
 * subject..." (tentative dotted) and a separate "Insert into subject page...".
 */
export function AssociationMenu({
  wb,
  menu,
  onClose,
  bump,
  embedded,
}: {
  wb: Workbench;
  menu: MenuState;
  onClose: () => void;
  bump: () => void;
  embedded?: boolean;
}): JSX.Element {
  const [picking, setPicking] = useState<null | "associate" | "insert">(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [query, setQuery] = useState("");
  const pages = wb.rawData().pages.filter((p) => p.kind === "subject");
  const matches = pages.filter((p) =>
    p.title.toLowerCase().includes(query.toLowerCase()),
  );

  const doAssociate = async (pageId: PageId): Promise<void> => {
    await wb.associateWithSubject(menu.annotationId, pageId);
    bump();
    onClose();
  };
  const doInsert = async (pageId: PageId): Promise<void> => {
    await wb.insertEvidenceIntoPage(menu.annotationId, pageId, { pos: null });
    wb.openSubjectPage(pageId);
    bump();
    onClose();
  };
  const doCreate = async (): Promise<void> => {
    const title = newTitle.trim();
    if (!title) return;
    const { page } = await wb.createSubjectFromAnnotation(title, menu.annotationId);
    wb.openSubjectPage(page.id);
    bump();
    onClose();
  };
  const doDeleteOnly = async (): Promise<void> => {
    await wb.deleteAnnotationOnly(menu.annotationId);
    bump();
    onClose();
  };
  const doDeleteAndQuotes = async (): Promise<void> => {
    await wb.deleteAnnotationAndQuotes(menu.annotationId);
    bump();
    onClose();
  };

  return (
    <div
      data-testid="association-menu"
      role="menu"
      aria-label="Annotation actions"
      className={embedded ? "ito-association-menu-embedded" : "ito-association-menu"}
      style={
        embedded
          ? undefined
          : { left: menu.x, top: menu.y + (typeof window !== "undefined" ? window.scrollY : 0) }
      }
    >
      {!picking && !creating && (
        <>
          <button data-testid="menu-create-subject" role="menuitem" onClick={() => setCreating(true)}>
            Create new subject from this…
          </button>
          <button data-testid="menu-associate" role="menuitem" onClick={() => setPicking("associate")}>
            Associate with subject…
          </button>
          <button data-testid="menu-insert" role="menuitem" onClick={() => setPicking("insert")}>
            Insert into subject page…
          </button>
          <button data-testid="delete-highlight-only" role="menuitem" onClick={() => void doDeleteOnly()}>
            Delete highlight only
          </button>
          <button
            data-testid="delete-highlight-and-quotes"
            role="menuitem"
            onClick={() => void doDeleteAndQuotes()}
          >
            Delete highlight and its quotes
          </button>
          <button data-testid="menu-close" role="menuitem" onClick={onClose}>
            Cancel
          </button>
        </>
      )}
      {creating && (
        <div data-testid="create-subject">
          <input
            data-testid="new-subject-title"
            autoFocus
            placeholder="New subject title…"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            aria-label="New subject title"
            onKeyDown={(e) => {
              if (e.key === "Enter") void doCreate();
            }}
          />
          <button data-testid="create-subject-confirm" onClick={() => void doCreate()}>
            Create and cite
          </button>
        </div>
      )}
      {picking && (
        <div data-testid="subject-picker">
          <input
            data-testid="subject-search"
            autoFocus
            placeholder="Search subjects…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search subjects"
          />
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {matches.map((p) => (
              <li key={p.id}>
                <button
                  data-testid="subject-option"
                  data-page-id={p.id}
                  onClick={() => (picking === "associate" ? doAssociate(p.id) : doInsert(p.id))}
                >
                  {p.title}
                </button>
              </li>
            ))}
            {matches.length === 0 && (
              <li data-testid="subject-empty" style={{ color: "#888" }}>
                No subjects
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Reference-directed locating in Nodes (N04/N05/N07). Renders a "Show in Nodes"
 * control only for an annotation cited into >= 1 subject page.
 */
export function ShowInNodes({
  wb,
  annotationId,
  bump,
  asMenuRow = false,
}: {
  wb: Workbench;
  annotationId: AnnotationId;
  bump: () => void;
  /** Render as a labelled context-menu row instead of the compact icon button. */
  asMenuRow?: boolean;
}): JSX.Element | null {
  const [pickerOpen, setPickerOpen] = useState(false);
  const citedPageIds = wb.citedSubjectPagesForAnnotation(annotationId);
  if (citedPageIds.length === 0) return null;

  const locate = (pageId: PageId): void => {
    wb.setViewMode("nodes");
    wb.setFocusedPageId(pageId);
    setPickerOpen(false);
    bump();
  };

  const onClick = (): void => {
    if (citedPageIds.length === 1) {
      locate(citedPageIds[0]!);
      return;
    }
    setPickerOpen((v) => !v);
  };

  return (
    <span style={{ position: "relative", display: asMenuRow ? "block" : "inline-flex" }}>
      {asMenuRow ? (
        <button
          type="button"
          role="menuitem"
          data-testid="show-in-nodes"
          data-annotation-id={annotationId}
          data-cited-count={String(citedPageIds.length)}
          className="ito-ctx-item"
          onClick={onClick}
        >
          <span className="ito-ctx-item-icon" aria-hidden="true">
            {Icons.nodes}
          </span>
          <span className="ito-ctx-item-label">Show in Nodes</span>
        </button>
      ) : (
        <button
          data-testid="show-in-nodes"
          data-annotation-id={annotationId}
          data-cited-count={String(citedPageIds.length)}
          aria-label="Show in Nodes"
          title="Show in Nodes"
          onClick={onClick}
        >
          ◎
        </button>
      )}
      {pickerOpen && citedPageIds.length > 1 && (
        <div
          data-testid="nodes-destination-picker"
          role="menu"
          aria-label="Choose a subject node"
          className="ito-nodes-destination-picker"
        >
          {citedPageIds.map((pid) => {
            const page = wb.rawData().pages.find((p) => p.id === pid);
            return (
              <button
                key={pid}
                data-testid="nodes-destination-option"
                data-page-id={pid}
                role="menuitem"
                onClick={() => locate(pid)}
              >
                {page?.title ?? "Subject"}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}

/* --------------------------------------------------------------------- */
/* Binary-offloaded citation popover                                     */
/* --------------------------------------------------------------------- */

/**
 * The binary-offloaded citation popover (A17). Shows the citation's stored
 * quote + comment + page number + source title and offers an "Attach PDF
 * Binary" action (sha256-verified re-hydration).
 */
export function BinaryOffloadedPopover({
  wb,
  popover,
  onClose,
  onAttached,
}: {
  wb: Workbench;
  popover: OffloadedPopover;
  onClose: () => void;
  onAttached: () => void;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);

  const onFile = async (file: File | null): Promise<void> => {
    if (!file) return;
    setAttaching(true);
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await wb.attachSourceBinary(popover.sourceId, bytes);
      if (!result.attached) {
        setError(result.reason ?? "the file did not match this source");
        return;
      }
      onAttached();
    } finally {
      setAttaching(false);
    }
  };

  // The offloaded citation popover has no highlight to anchor to; it stays a
  // centred modal surface (its historical position) sharing the <Popover>
  // visual language via the .ito-ui-popover chrome class, but rendered inline
  // (no portal) so it stays inside the reader fixed layer its caller provides.
  return (
    <div
      data-testid="binary-offloaded-popover"
      data-return-resolution="binary-offloaded"
      data-source-id={popover.sourceId}
      data-evidence-id={popover.evidenceId}
      role="dialog"
      aria-label="Offloaded source citation"
      className="ito-ui-popover ito-offloaded-popover ito-offloaded-popover-floating"
    >
      <div className="ito-offloaded-header">
        <strong data-testid="offloaded-source-title">{popover.sourceTitle}</strong>
        <button data-testid="offloaded-popover-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="ito-offloaded-reason">{popover.reason}</p>
      <blockquote data-testid="offloaded-quote" className="ito-offloaded-quote">
        {popover.quotedText}
      </blockquote>
      {popover.comment !== "" && (
        <p data-testid="offloaded-comment" className="ito-offloaded-comment">
          {popover.comment}
        </p>
      )}
      <div data-testid="offloaded-page" className="ito-offloaded-page">
        Page {popover.pageNumber}
      </div>
      {error && (
        <p data-testid="attach-pdf-error" role="alert" className="ito-offloaded-error">
          {error}
        </p>
      )}
      <label data-testid="attach-pdf-binary" className="ito-attach-pdf-label">
        {attaching ? "Attaching…" : "Attach PDF Binary"}
        <input
          data-testid="attach-pdf-input"
          type="file"
          accept=".pdf,application/pdf"
          style={{ display: "none" }}
          disabled={attaching}
          onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
        />
      </label>
    </div>
  );
}
