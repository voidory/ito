import { useEffect, useMemo, useRef, useState } from "react";
import type { Revision } from "../../model";

/**
 * A linear, horizontal timeline of changes. Time runs left to right on a single
 * axis; every day that has changes carries a small sideways sheet of paper (a
 * landscape page with a folded corner) whose stack and badge show how much was
 * written that day. Click a sheet to select that day; drag across the axis to
 * select a whole period. The selection is reported as day keys, from which the
 * panel derives the reflection's date period automatically.
 */

const DAY_MS = 86_400_000;
const MIN_DAY_W = 64; // px per day on the axis (grows to fill a wide panel)
const PAD = 32;

function dayIndex(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Math.round(Date.UTC(y!, (m ?? 1) - 1, d ?? 1) / DAY_MS);
}
function keyOf(index: number): string {
  return new Date(index * DAY_MS).toISOString().slice(0, 10);
}

export interface TimelineDay {
  readonly key: string;
  readonly count: number;
  readonly ids: readonly string[];
}

/** Group revisions into per-day buckets (ascending). Exported for tests. */
export function bucketByDay(
  revisions: readonly Revision[],
  dateKeyOf: (r: Revision) => string,
): TimelineDay[] {
  const map = new Map<string, string[]>();
  for (const r of revisions) {
    const k = dateKeyOf(r);
    map.set(k, [...(map.get(k) ?? []), r.id]);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, ids]) => ({ key, count: ids.length, ids }));
}

function Sheet({ count, selected }: { count: number; selected: boolean }): JSX.Element {
  const stack = Math.min(count, 3);
  return (
    <svg width="44" height="36" viewBox="0 0 44 36" aria-hidden="true" className="ito-sheet">
      {Array.from({ length: stack }).map((_, i) => {
        const o = (stack - 1 - i) * 3;
        return (
          <g key={i} transform={`translate(${o} ${-o + (stack - 1) * 3})`}>
            <path
              d="M2 4h28l6 6v18a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"
              className="ito-sheet-body"
              data-top={i === stack - 1 ? "true" : undefined}
              data-selected={selected ? "true" : undefined}
            />
            {i === stack - 1 && (
              <>
                <path d="M30 4v6h6" className="ito-sheet-fold" />
                <path d="M6 15h22M6 20h26M6 25h16" className="ito-sheet-lines" />
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function HistoryTimeline({
  days,
  selectedDayKeys,
  onSelectDays,
}: {
  days: readonly TimelineDay[];
  /** Day keys that currently count as selected (all of that day's changes picked). */
  selectedDayKeys: ReadonlySet<string>;
  /** Replace the selection with these day keys; `toggle` flips a single day. */
  onSelectDays: (keys: readonly string[], mode: "replace" | "toggle") => void;
}): JSX.Element | null {
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const gesture = useRef<{ startX: number; startIdx: number; moved: boolean } | null>(null);

  // Track the visible width so a short history spreads across the panel
  // instead of huddling at the left.
  const [viewW, setViewW] = useState(0);
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    setViewW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [days.length > 0]);

  const layout = useMemo(() => {
    if (days.length === 0) return null;
    const first = dayIndex(days[0]!.key);
    const last = dayIndex(days[days.length - 1]!.key);
    // Always show at least a week so a lone day does not fill the whole axis.
    const span = Math.max(last - first + 1, 7);
    const start = first - Math.floor((span - (last - first + 1)) / 2);
    const dayW = Math.max(MIN_DAY_W, Math.min(140, (viewW - PAD * 2) / span));
    return { start, span, dayW, width: Math.max(viewW, PAD * 2 + span * dayW) };
  }, [days, viewW]);

  if (!layout) return null;

  const xOf = (idx: number): number => PAD + (idx - layout.start) * layout.dayW + layout.dayW / 2;
  const idxAtClientX = (clientX: number): number => {
    const r = trackRef.current!.getBoundingClientRect();
    const x = clientX - r.left + trackRef.current!.scrollLeft - PAD;
    return layout.start + Math.min(layout.span - 1, Math.max(0, Math.floor(x / layout.dayW)));
  };
  const daysInRange = (a: number, b: number): string[] => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return days.filter((d) => dayIndex(d.key) >= lo && dayIndex(d.key) <= hi).map((d) => d.key);
  };

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return;
    gesture.current = { startX: e.clientX, startIdx: idxAtClientX(e.clientX), moved: false };
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    const g = gesture.current;
    if (!g || (e.buttons & 1) === 0) return;
    if (!g.moved && Math.abs(e.clientX - g.startX) > 5) {
      g.moved = true;
      // Capture only once it is a real drag, so plain clicks on a sheet still
      // reach the sheet (capturing on press would retarget the click).
      trackRef.current?.setPointerCapture?.(e.pointerId);
    }
    if (g.moved) setDrag({ a: g.startIdx, b: idxAtClientX(e.clientX) });
  };
  const finish = (): void => {
    const g = gesture.current;
    gesture.current = null;
    if (g?.moved && drag) {
      onSelectDays(daysInRange(drag.a, drag.b), "replace");
    }
    setDrag(null);
  };

  // Month ticks / day numbers along the axis.
  const ticks = Array.from({ length: layout.span }, (_, i) => layout.start + i);
  const band = drag
    ? { l: xOf(Math.min(drag.a, drag.b)) - layout.dayW / 2, r: xOf(Math.max(drag.a, drag.b)) + layout.dayW / 2 }
    : null;

  return (
    <div className="ito-timeline-wrap" data-testid="history-timeline-wrap">
      <div
        ref={trackRef}
        className="ito-timeline"
        data-testid="history-timeline"
        role="group"
        aria-label="Timeline of changes. Click a sheet to select a day, or drag across the axis to select a period."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
      >
        <div className="ito-timeline-inner" style={{ width: layout.width }}>
          {band && (
            <div
              className="ito-timeline-band"
              data-testid="timeline-drag-band"
              style={{ left: band.l, width: band.r - band.l }}
            />
          )}
          <div className="ito-timeline-axis" />
          {ticks.map((t) => {
            const key = keyOf(t);
            const showMonth = key.endsWith("-01") || t === layout.start;
            return (
              <div key={t} className="ito-timeline-tick" style={{ left: xOf(t) }}>
                <span className="ito-timeline-daynum">{Number(key.slice(8))}</span>
                {showMonth && (
                  <span className="ito-timeline-month">
                    {new Date(t * DAY_MS).toLocaleString("en", { month: "short", year: "numeric", timeZone: "UTC" })}
                  </span>
                )}
              </div>
            );
          })}
          {days.map((d) => {
            const selected = selectedDayKeys.has(d.key);
            return (
              <button
                key={d.key}
                type="button"
                className="ito-timeline-sheet"
                data-testid="timeline-sheet"
                data-date-key={d.key}
                data-count={d.count}
                aria-pressed={selected}
                aria-label={`${d.key}: ${d.count} change${d.count === 1 ? "" : "s"}`}
                title={`${d.key} · ${d.count} change${d.count === 1 ? "" : "s"}`}
                style={{ left: xOf(dayIndex(d.key)) }}
                onClick={(e) => {
                  onSelectDays([d.key], e.shiftKey || e.metaKey || e.ctrlKey ? "toggle" : "toggle");
                }}
              >
                <Sheet count={d.count} selected={selected} />
                <span className="ito-timeline-count">{d.count}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
