/**
 * FEAT-005B — deterministic DEVELOPMENT / EVALUATION split.
 *
 * The spec requires: "Do not tune the algorithm against the held-out test set.
 * Separate development and evaluation examples." We therefore partition the
 * real-world corpus once, deterministically, into a development set (may be
 * inspected while iterating) and a held-out evaluation set (reported, never
 * used to tune thresholds). The split is a stable hash of the structure name,
 * so it is reproducible and independent of corpus ordering, and it keeps every
 * structural category represented on BOTH sides.
 */

import { REAL_WORLD_CORPUS, type RealWorldStructure, type RealWorldCategory } from "./corpus";

export type SplitName = "development" | "evaluation";

/** Fraction of each category routed to the held-out evaluation set. */
const EVAL_FRACTION = 0.5;

/** Stable 32-bit FNV-1a hash of a string → [0, 1). */
function hashUnit(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * Assign each structure to a split. We stratify by category: within a category,
 * structures are ordered by their stable hash and the first EVAL_FRACTION go to
 * evaluation, the rest to development. This guarantees both splits contain every
 * category (so per-category metrics exist on the held-out set) while remaining
 * fully deterministic and independent of the algorithm.
 */
export function splitOf(name: string): SplitName {
  const byCategory = new Map<RealWorldCategory, RealWorldStructure[]>();
  for (const s of REAL_WORLD_CORPUS) {
    const arr = byCategory.get(s.category) ?? [];
    arr.push(s);
    byCategory.set(s.category, arr);
  }
  for (const [, arr] of byCategory) {
    arr.sort((a, b) => hashUnit(a.name) - hashUnit(b.name));
    const evalCount = Math.max(1, Math.round(arr.length * EVAL_FRACTION));
    const target = arr.find((s) => s.name === name);
    if (!target) continue;
    const idx = arr.indexOf(target);
    if (arr[0]?.name === name || idx < evalCount) return "evaluation";
    return "development";
  }
  return "development";
}

export function structuresIn(split: SplitName): RealWorldStructure[] {
  return REAL_WORLD_CORPUS.filter((s) => splitOf(s.name) === split);
}
