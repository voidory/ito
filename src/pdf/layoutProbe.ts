/**
 * Evidence about how sure a layout decision was, collected while
 * `analyzeGlyphs` (mathLayout.ts) runs. Pure bookkeeping: nothing here is read
 * by the layout, so a probe cannot change what is extracted.
 *
 * Most decisions in the layout compare a measurement against a threshold. A
 * decision made far from its threshold is not in doubt; one made next to it
 * could have gone the other way. Each probe site records the smallest such
 * distance seen, in ems (the line's own size), so the confidence model can ask
 * "how close was the closest call?".
 */

/** What the probe collected over one extraction. */
export interface LayoutProbe {
  /** Closest call per kind of decision, in ems; absent when no such decision was made. */
  readonly margins: Record<string, number>;
  /** How many decisions of each kind were made. */
  readonly counts: Record<string, number>;
}

let active: LayoutProbe | null = null;

/** Run `fn` with a fresh probe and return it with the result. Not re-entrant: an inner call shares the outer probe. */
export function withProbe<T>(fn: () => T): { value: T; probe: LayoutProbe } {
  if (active) return { value: fn(), probe: active };
  const probe: LayoutProbe = { margins: {}, counts: {} };
  active = probe;
  try {
    return { value: fn(), probe };
  } finally {
    active = null;
  }
}

/** Record that a decision of this kind was made. */
export function note(kind: string, n = 1): void {
  if (active) active.counts[kind] = (active.counts[kind] ?? 0) + n;
}

/** Record how far a decision was from its threshold, in ems. Keeps the smallest. */
export function margin(kind: string, ems: number): void {
  if (!active) return;
  const seen = active.margins[kind];
  if (seen === undefined || ems < seen) active.margins[kind] = ems;
  active.counts[kind] = (active.counts[kind] ?? 0) + 1;
}
