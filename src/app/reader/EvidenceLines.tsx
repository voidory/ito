import { useCallback, useEffect, useRef, useState } from "react";
import { type Workbench } from "../workbench";
import { cssEscapeId, styles } from "./AnnotationOverlays";

/**
 * The pane wrapper + inter-pane passage-to-evidence line layer, extracted from
 * Reader.tsx during the FEAT-002 decomposition. Reader.tsx renders both; the
 * modules stay dependency-free of Reader.tsx so the split introduces no cycle.
 */

/**
 * A pane wrapper that applies the pane's flex-grow WEIGHT (adjustable widths,
 * section 8.2) and renders a draggable divider after it (except the last pane).
 * The weight ratio is the durable-across-transitions pane configuration (R19);
 * dragging the divider calls back into the Workbench so the ratio survives
 * layout changes.
 */
export function PaneGroup({
  children,
  last,
  narrow,
  weight,
  onResize,
  slotId,
}: {
  children: React.ReactNode;
  last: boolean;
  narrow: boolean;
  weight: number;
  onResize: (weight: number) => void;
  slotId: string;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragging.current = true;
      const startX = e.clientX;
      const startWidth = ref.current?.getBoundingClientRect().width ?? 1;
      const startWeight = weight;
      const move = (ev: PointerEvent): void => {
        if (!dragging.current) return;
        const dx = ev.clientX - startX;
        // Convert pixel delta into a proportional weight change.
        const factor = (startWidth + dx) / Math.max(1, startWidth);
        onResize(Math.max(0.15, startWeight * factor));
      };
      const up = (): void => {
        dragging.current = false;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [weight, onResize],
  );

  return (
    <>
      <div
        ref={ref}
        data-testid="workspace-pane"
        data-slot-id={slotId}
        style={{
          flex: narrow ? "1 1 auto" : `${weight} 1 0`,
          minWidth: 0,
          minHeight: narrow ? "60vh" : 0,
          height: narrow ? "auto" : "100%",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {children}
      </div>
      {!last && !narrow && (
        <div
          data-testid="pane-divider"
          data-slot-id={slotId}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize pane"
          onPointerDown={onPointerDown}
          style={styles.divider}
        />
      )}
    </>
  );
}

/**
 * The passage-to-evidence line layer for the editing workspace (spec section
 * 10.2). It draws one SVG polyline per `passageEvidenceLine`, routing from the
 * source pane's edge toward the subject pane through the inter-pane margin so
 * it NEVER crosses over readable text. Lines recompute on source scroll, editor
 * scroll, zoom and pane resize via a live geometry pass over the registered
 * pane scroll containers + evidence chips. The visibility toggle controls only
 * whether this layer renders — the underlying line DATA is always present, so
 * hiding is non-destructive (A08/R08 foundation). There is NO camera motion:
 * the layer never scrolls or re-centres any pane.
 */
export function PassageEvidenceLines({
  wb,
  bodyRef,
  paneScrollRefs,
  visible,
  bump,
}: {
  wb: Workbench;
  bodyRef: React.RefObject<HTMLDivElement>;
  paneScrollRefs: React.MutableRefObject<Map<string, HTMLElement>>;
  visible: boolean;
  bump: () => void;
}): JSX.Element {
  const [segments, setSegments] = useState<
    {
      key: string;
      status: "solid" | "dotted";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    }[]
  >([]);
  const frame = useRef<number>(0);

  /** Union box of an annotation's drawn pieces inside a source pane, if any. */
  const highlightBox = (
    scroll: HTMLElement,
    annotationId: string,
  ): DOMRect | null => {
    const id = cssEscapeId(annotationId);
    const els = scroll.querySelectorAll(
      `.ito-highlight[data-annotation-id="${id}"] .ito-highlight-fragment, ` +
        `.ito-highlight[data-annotation-id="${id}"] .ito-highlight-area, ` +
        `.ito-highlight[data-annotation-id="${id}"] .ito-highlight-border`,
    );
    let l = Infinity;
    let t = Infinity;
    let r = -Infinity;
    let b = -Infinity;
    for (const el of Array.from(els)) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      l = Math.min(l, box.left);
      t = Math.min(t, box.top);
      r = Math.max(r, box.right);
      b = Math.max(b, box.bottom);
    }
    return Number.isFinite(l) ? new DOMRect(l, t, r - l, b - t) : null;
  };

  const recompute = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    const bodyBox = body.getBoundingClientRect();
    const subjectEl = paneScrollRefs.current.get("subject");
    if (!subjectEl) {
      setSegments([]);
      return;
    }
    const subjBox = subjectEl.getBoundingClientRect();
    const clampY = (y: number, top: number, bottom: number): number =>
      Math.min(Math.max(y, top + 6), bottom - 6);

    const entries: {
      key: string;
      status: "solid" | "dotted";
      annotationId: string;
      sourceId: string;
      evidenceId: string | null;
    }[] = [
      ...wb.passageEvidenceLines().map((l) => ({
        key: l.evidenceId,
        status: "solid" as const,
        annotationId: l.annotationId,
        sourceId: l.sourceId,
        evidenceId: l.evidenceId,
      })),
      ...wb.passageAssociationLines().map((l) => ({
        key: `assoc-${l.associationId}`,
        status: "dotted" as const,
        annotationId: l.annotationId,
        sourceId: l.sourceId,
        evidenceId: null,
      })),
    ];

    const next: typeof segments = [];
    for (const e of entries) {
      const sourceScroll = paneScrollRefs.current.get(e.sourceId);
      if (!sourceScroll) continue;
      const paneBox = sourceScroll.getBoundingClientRect();
      const sourceLeftOfSubject = paneBox.left < subjBox.left;

      // SOURCE END: the highlight itself, so the line visibly leaves the passage
      // and crosses the page toward the subject. If the passage has scrolled out
      // of the pane band, slide along the pane's inner edge (never off-canvas).
      const hl = highlightBox(sourceScroll, e.annotationId);
      let sx: number;
      let sy: number;
      if (hl && hl.bottom > paneBox.top && hl.top < paneBox.bottom) {
        sx = sourceLeftOfSubject ? hl.right : hl.left;
        sy = clampY(hl.top + hl.height / 2, paneBox.top, paneBox.bottom);
      } else {
        sx = sourceLeftOfSubject ? paneBox.right : paneBox.left;
        const clampTo = hl ? (hl.top < paneBox.top ? paneBox.top : paneBox.bottom) : paneBox.top + paneBox.height / 2;
        sy = clampY(clampTo, paneBox.top, paneBox.bottom);
      }

      // SUBJECT END: the quote itself (its near edge) for a cited link; the
      // pane's inner edge for a tentative one (nothing is quoted yet).
      const chip = e.evidenceId
        ? (subjectEl.querySelector(
            `[data-testid="evidence-chip"][data-evidence-id="${e.evidenceId}"]`,
          ) as HTMLElement | null)
        : null;
      let dx: number;
      let dy: number;
      if (chip) {
        const cb = chip.getBoundingClientRect();
        dx = sourceLeftOfSubject ? cb.left : cb.right;
        dy = clampY(cb.top + cb.height / 2, subjBox.top, subjBox.bottom);
      } else {
        dx = sourceLeftOfSubject ? subjBox.left : subjBox.right;
        dy = clampY(subjBox.top + subjBox.height / 2, subjBox.top, subjBox.bottom);
      }
      next.push({
        key: e.key,
        status: e.status,
        x1: sx - bodyBox.left,
        y1: sy - bodyBox.top,
        x2: dx - bodyBox.left,
        y2: dy - bodyBox.top,
      });
    }
    setSegments(next);
  }, [wb, bodyRef, paneScrollRefs]);

  // Recompute on any scroll (source or editor), resize, and after mount. We use
  // rAF-coalesced passive listeners so dragging a divider or scrolling a pane
  // updates lines smoothly without obstructing interaction, and without ever
  // moving a pane (presentation only, no camera motion).
  useEffect(() => {
    const schedule = (): void => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(recompute);
    };
    schedule();
    const scrolls = [...paneScrollRefs.current.values()];
    // The subject editor's inner scroller (styles.doc) is the element that
    // actually scrolls the composition, so listen there too (editor scroll).
    const subjectWrapper = paneScrollRefs.current.get("subject");
    const subjectDoc = subjectWrapper?.querySelector(
      '[data-testid="subject-doc"]',
    ) as HTMLElement | null;
    const listenEls = subjectDoc ? [...scrolls, subjectDoc] : scrolls;
    for (const el of listenEls) el.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const ro = new ResizeObserver(schedule);
    if (bodyRef.current) ro.observe(bodyRef.current);
    for (const el of scrolls) ro.observe(el);
    // Highlights are removed and redrawn on every refit / zoom / re-render, and
    // pages re-render at a new scale: re-anchor the line when that happens, or
    // it keeps pointing where the highlight USED to be.
    const mo = new MutationObserver(schedule);
    for (const el of scrolls) mo.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
    return () => {
      mo.disconnect();
      cancelAnimationFrame(frame.current);
      for (const el of listenEls) el.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      ro.disconnect();
    };
    // `bump` is intentionally not a dep; recompute closes over live refs.
  }, [recompute, paneScrollRefs, bodyRef, bump]);

  const count = segments.length;

  return (
    <svg
      data-testid="passage-evidence-lines"
      data-visible={visible ? "true" : "false"}
      data-line-count={String(count)}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        // The toggle changes PRESENTATION ONLY: hidden lines keep their data
        // (data-line-count stays accurate) but are not painted.
        visibility: visible ? "visible" : "hidden",
        zIndex: 5,
      }}
      aria-hidden="true"
    >
      {segments.map((s) => {
        const midX = (s.x1 + s.x2) / 2;
        const d = `M ${s.x1} ${s.y1} C ${midX} ${s.y1}, ${midX} ${s.y2}, ${s.x2} ${s.y2}`;
        const dotted = s.status === "dotted";
        return (
          <g
            key={s.key}
            data-testid="evidence-line"
            data-evidence-id={s.key}
            data-line-status={s.status}
          >
            {/* Pale halo so the line stays legible where it crosses page text. */}
            <path d={d} fill="none" stroke="#fff" strokeWidth={4.5} strokeOpacity={0.85} strokeLinecap="round" />
            <path
              d={d}
              fill="none"
              stroke="#1a56db"
              strokeWidth={dotted ? 2 : 1.75}
              strokeOpacity={dotted ? 0.7 : 0.85}
              strokeLinecap="round"
              strokeDasharray={dotted ? "0.1 5.5" : undefined}
            />
            {/* Endpoints: a dot at the highlight, a dot at the quote / pane. */}
            <circle cx={s.x1} cy={s.y1} r={3.2} fill="#1a56db" stroke="#fff" strokeWidth={1.5} />
            <circle cx={s.x2} cy={s.y2} r={3.2} fill={dotted ? "#fff" : "#1a56db"} stroke="#1a56db" strokeWidth={1.5} />
          </g>
        );
      })}
    </svg>
  );
}
