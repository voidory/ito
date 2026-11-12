import { useMemo, useState } from "react";
import type { Revision } from "../model";
import { Workbench } from "./workbench";
import { HistoryTimeline, bucketByDay } from "./history/HistoryTimeline";

/**
 * M7 (H03, H04, D14) the Linked History & Multi-Span Reflection panel.
 *
 * It renders the brain's recorded revisions grouped by their creation-timezone
 * day key (`YYYY-MM-DD`), offers both a single-day picker and a date-RANGE
 * filter so a user can analyze a week/month-wide span, and lets the user
 * cherry-pick revisions across multiple days into a single ReflectionEntry. Per
 * the H04 invariant, a reflection NEVER rewrites a Revision and NEVER creates a
 * graph node - this panel only reads the history and calls the Workbench's
 * reflection/comment recorders.
 *
 * The component is intentionally driven by a real Workbench (no mocks) so the
 * jsdom render test exercises the same transitions the Playwright spec polls.
 */
export function HistoryReflectionPanel({
  wb,
  onChange,
}: {
  wb: Workbench;
  /** Optional callback so the shell can re-render after a mutation. */
  onChange?: () => void;
}): JSX.Element {
  const revisions = wb.revisions();
  const comments = wb.revisionComments();

  // Date-range filter (both inclusive, YYYY-MM-DD). Empty = unbounded.
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  // Single-day picker (a convenience shortcut that sets the range to one day).
  const [singleDay, setSingleDay] = useState("");
  // Cherry-picked revision selection (ids) and the reflection draft text.
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [reflectionText, setReflectionText] = useState("");
  // Per-revision comment drafts keyed by revision id.
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  // The revision whose before/after diff is currently expanded (or null).
  const [diffRevId, setDiffRevId] = useState<string | null>(null);
  const [savedSpan, setSavedSpan] = useState<{ start: string; end: string } | null>(null);

  const dateKeyOf = (r: Revision): string =>
    r.dateKey ?? Workbench.dateKeyOf(r.createdAt);

  // Apply the active filter (single day takes precedence when set).
  const effStart = singleDay || rangeStart;
  const effEnd = singleDay || rangeEnd;
  const filtered = useMemo(
    () =>
      revisions.filter((r) => {
        const key = dateKeyOf(r);
        if (effStart && key < effStart) return false;
        if (effEnd && key > effEnd) return false;
        return true;
      }),
    [revisions, effStart, effEnd],
  );

  // Group the filtered revisions by day key (newest day first, stable within).
  const grouped = useMemo(() => {
    const map = new Map<string, Revision[]>();
    for (const r of filtered) {
      const key = dateKeyOf(r);
      const bucket = map.get(key) ?? [];
      bucket.push(r);
      map.set(key, bucket);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [filtered]);

  const selectedIds = Object.keys(selected).filter((id) => selected[id]);

  const toggleSelect = (id: string): void => {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const saveReflection = async (): Promise<void> => {
    if (selectedIds.length === 0) return;
    const entry = await wb.createReflection({
      text: reflectionText,
      linkedRevisionIds: selectedIds,
    });
    setSavedSpan({ start: entry.startDateKey, end: entry.endDateKey });
    setReflectionText("");
    setSelected({});
    onChange?.();
  };

  const saveComment = async (revId: string): Promise<void> => {
    const text = commentDrafts[revId] ?? "";
    await wb.addRevisionComment(revId, text);
    onChange?.();
  };

  // The span of the CURRENT selection (for the live editor badge) OR the
  // last-saved reflection, so the date-span indicator renders when multi-day.
  const selectionKeys = selectedIds
    .map((id) => {
      const rev = revisions.find((r) => r.id === id);
      return rev ? dateKeyOf(rev) : "";
    })
    .filter(Boolean)
    .sort();
  const spanStart = savedSpan?.start ?? selectionKeys[0] ?? "";
  const spanEnd = savedSpan?.end ?? selectionKeys[selectionKeys.length - 1] ?? "";
  const isMultiDay = Boolean(spanStart && spanEnd && spanStart !== spanEnd);

  // Timeline: per-day buckets over ALL revisions; a day is "selected" when every
  // one of its changes is picked. Selecting days (click or drag) picks all of
  // their changes, and the reflection's date period follows automatically.
  const timelineDays = useMemo(() => bucketByDay(revisions, dateKeyOf), [revisions]);
  const selectedDayKeys = useMemo(
    () =>
      new Set(
        timelineDays
          .filter((d) => d.ids.length > 0 && d.ids.every((id) => selected[id]))
          .map((d) => d.key),
      ),
    [timelineDays, selected],
  );
  const onSelectDays = (keys: readonly string[], mode: "replace" | "toggle"): void => {
    const idsFor = (k: string): readonly string[] =>
      timelineDays.find((d) => d.key === k)?.ids ?? [];
    if (mode === "replace") {
      const next: Record<string, boolean> = {};
      for (const k of keys) for (const id of idsFor(k)) next[id] = true;
      setSelected(next);
      setSavedSpan(null);
      return;
    }
    setSelected((prev) => {
      const next = { ...prev };
      for (const k of keys) {
        const ids = idsFor(k);
        const allOn = ids.every((id) => prev[id]);
        for (const id of ids) next[id] = !allOn;
      }
      return next;
    });
    setSavedSpan(null);
  };

  // FIX-HISTORY-FULL-LAYOUT (§3.4): empty-state when the brain has no revisions
  // recorded at all yet (distinct from "none in the current date range").
  const hasAnyRevisions = revisions.length > 0;

  return (
    <section
      data-testid="daily-review-panel"
      aria-label="Linked history and reflection"
      className="daily-review-panel"
    >
      {/* Back-compat marker: existing render tests + the M7 spec locate the
          panel by this testid; the full-view grid lives on the section above. */}
      <div data-testid="history-reflection-panel" style={{ display: "contents" }}>
      <header style={styles.header} className="daily-review-header">
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>History &amp; Reflection</h2>
      </header>

      {!hasAnyRevisions && (
        <p data-testid="daily-review-empty" className="daily-review-empty">
          No history yet. As you annotate sources and edit subject pages, each
          change is recorded here so you can review a day or a date range and
          weave a multi-span reflection across them.
        </p>
      )}

      {hasAnyRevisions && (
        <div className="ito-history-timeline-row">
          <HistoryTimeline
            days={timelineDays}
            selectedDayKeys={selectedDayKeys}
            onSelectDays={onSelectDays}
          />
        </div>
      )}

      <div className="daily-review-left">
      <div style={styles.filters}>
        <label style={styles.filterLabel}>
          Day
          <input
            data-testid="review-date-picker"
            type="date"
            value={singleDay}
            onChange={(e) => setSingleDay(e.target.value)}
          />
        </label>
        <label style={styles.filterLabel}>
          From
          <input
            data-testid="review-range-start"
            type="date"
            value={rangeStart}
            onChange={(e) => setRangeStart(e.target.value)}
          />
        </label>
        <label style={styles.filterLabel}>
          To
          <input
            data-testid="review-range-end"
            type="date"
            value={rangeEnd}
            onChange={(e) => setRangeEnd(e.target.value)}
          />
        </label>
      </div>

      <div data-testid="revision-timeline" style={styles.timeline}>
        {grouped.length === 0 && (
          <p data-testid="history-empty" style={styles.empty}>
            No revisions in this range yet.
          </p>
        )}
        {grouped.map(([dayKey, revs]) => (
          <div key={dayKey} data-testid="revision-day-group" data-date-key={dayKey}>
            <h3 data-testid="revision-day-heading" style={styles.dayHeading}>
              {dayKey}
            </h3>
            {revs.map((rev) => (
              <div key={rev.id} data-testid="revision-item" data-rev-id={rev.id} style={styles.item}>
                <label style={styles.itemHead}>
                  <input
                    data-testid="revision-select-checkbox"
                    type="checkbox"
                    checked={Boolean(selected[rev.id])}
                    onChange={() => toggleSelect(rev.id)}
                  />
                  <span style={styles.itemLabel}>{rev.summary ?? rev.label}</span>
                  <span style={styles.itemKind}>{rev.kind ?? "other"}</span>
                </label>

                <button
                  type="button"
                  data-testid="revision-diff-toggle"
                  style={styles.linkButton}
                  onClick={() => setDiffRevId(diffRevId === rev.id ? null : rev.id)}
                >
                  {diffRevId === rev.id ? "Hide diff" : "View diff"}
                </button>

                {diffRevId === rev.id && (
                  <div data-testid="revision-diff-view" style={styles.diff}>
                    <pre data-testid="revision-diff-before" style={styles.diffPre}>
                      {JSON.stringify(rev.beforeSnapshot ?? null, null, 2)}
                    </pre>
                    <pre data-testid="revision-diff-after" style={styles.diffPre}>
                      {JSON.stringify(rev.afterSnapshot ?? null, null, 2)}
                    </pre>
                  </div>
                )}

                <div style={styles.commentRow}>
                  <input
                    data-testid="revision-comment-input"
                    type="text"
                    placeholder="Comment on this change"
                    value={commentDrafts[rev.id] ?? comments[rev.id] ?? ""}
                    onChange={(e) =>
                      setCommentDrafts((prev) => ({ ...prev, [rev.id]: e.target.value }))
                    }
                  />
                  <button
                    type="button"
                    data-testid="revision-comment-save"
                    onClick={() => void saveComment(rev.id)}
                  >
                    Save
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      </div>

      <div style={styles.reflection} className="daily-review-right">
        <h3 style={{ margin: "0 0 0.35rem" }}>Reflection</h3>
        <p style={styles.hint} data-testid="reflection-selection-count">
          {selectedIds.length} revision(s) selected across the timeline.
        </p>
        {isMultiDay && (
          <p data-testid="reflection-date-span" style={styles.span}>
            Period: {spanStart} &rarr; {spanEnd}
          </p>
        )}
        {spanStart && !isMultiDay && (
          <p data-testid="reflection-period" style={styles.span}>
            Period: {spanStart}
          </p>
        )}
        <textarea
          data-testid="reflection-editor"
          placeholder="Analyze the selected changes together..."
          value={reflectionText}
          onChange={(e) => setReflectionText(e.target.value)}
          style={styles.editor}
        />
        <button
          type="button"
          data-testid="reflection-save"
          onClick={() => void saveReflection()}
          disabled={selectedIds.length === 0}
        >
          Save reflection
        </button>
      </div>
      </div>
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
    padding: "1rem",
    maxWidth: "48rem",
  },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  filters: { display: "flex", gap: "0.75rem", flexWrap: "wrap" },
  filterLabel: { display: "flex", flexDirection: "column", fontSize: "0.8rem", gap: "0.2rem" },
  timeline: { display: "flex", flexDirection: "column", gap: "0.75rem" },
  empty: { fontSize: "0.85rem", color: "#666" },
  dayHeading: { margin: "0 0 0.35rem", fontSize: "0.95rem" },
  item: {
    padding: "0.5rem 0.65rem",
    border: "1px solid #dcd6c8",
    borderRadius: "8px",
    marginBottom: "0.4rem",
  },
  itemHead: { display: "flex", alignItems: "center", gap: "0.5rem" },
  itemLabel: { flex: 1, fontSize: "0.88rem" },
  itemKind: { fontSize: "0.72rem", color: "#888" },
  linkButton: {
    background: "none",
    border: "none",
    color: "#2c4a6f",
    cursor: "pointer",
    fontSize: "0.78rem",
    padding: 0,
    marginTop: "0.25rem",
  },
  diff: { display: "flex", gap: "0.5rem", marginTop: "0.4rem" },
  diffPre: {
    flex: 1,
    maxHeight: "10rem",
    overflow: "auto",
    background: "#f4f1e9",
    padding: "0.4rem",
    borderRadius: "6px",
    fontSize: "0.72rem",
    margin: 0,
  },
  commentRow: { display: "flex", gap: "0.4rem", marginTop: "0.4rem" },
  reflection: {
    borderTop: "1px solid #dcd6c8",
    paddingTop: "0.75rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.4rem",
  },
  hint: { fontSize: "0.82rem", color: "#555", margin: 0 },
  span: { fontSize: "0.82rem", fontWeight: 600, color: "#2c4a6f", margin: 0 },
  editor: { minHeight: "5rem", padding: "0.5rem", borderRadius: "6px", border: "1px solid #dcd6c8" },
};
