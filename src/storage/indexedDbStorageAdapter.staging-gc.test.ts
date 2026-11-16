/**
 * Unit coverage for the superseded-staging-key cleanup policy
 * (IndexedDbStorageAdapter). Every writeBrain stores a FULL brain copy under a
 * `${brainId}:staged:${revision}` key, so after the published pointer advances
 * the adapter must delete the strictly-older staged payloads (otherwise the
 * store grows by one complete snapshot per keystroke-save) while never touching
 * the live payload.
 *
 * The deletion DECISION lives in the pure `supersededStagedKeys` helper, which
 * this test pins directly (no IndexedDB round-trip needed): after a sequence of
 * increasing publicationRevisions, only keys whose revision is strictly less
 * than the live revision are selected for deletion, and the live key (plus any
 * unparseable or other-brain key) survives.
 */
import { describe, expect, it } from "vitest";
import {
  stagedKeyFor,
  stagedKeyPrefix,
  supersededStagedKeys,
} from "./IndexedDbStorageAdapter";
import type { BrainId } from "../model";

const BRAIN = "brain-a" as BrainId;

describe("supersededStagedKeys", () => {
  it("selects only strictly-older staged keys for a brain, keeping the live one", () => {
    // Simulate the store after writeBrain was called with revisions 1..4: each
    // write left its own staged key behind (before cleanup ran).
    const keys = [1, 2, 3, 4].map((rev) => stagedKeyFor(BRAIN, rev));
    const liveRevision = 4;

    const toDelete = supersededStagedKeys(keys, liveRevision, BRAIN);

    expect(toDelete.sort()).toEqual(
      [1, 2, 3].map((rev) => stagedKeyFor(BRAIN, rev)).sort(),
    );
    // The live (latest) staged key is never selected for deletion.
    expect(toDelete).not.toContain(stagedKeyFor(BRAIN, liveRevision));
  });

  it("leaves nothing to delete on the very first write (only the live key exists)", () => {
    const keys = [stagedKeyFor(BRAIN, 1)];
    expect(supersededStagedKeys(keys, 1, BRAIN)).toEqual([]);
  });

  it("never selects keys belonging to another brain", () => {
    const other = "brain-b" as BrainId;
    const keys = [
      stagedKeyFor(BRAIN, 1),
      stagedKeyFor(BRAIN, 2),
      stagedKeyFor(other, 1), // strictly older number, but a DIFFERENT brain
    ];
    const toDelete = supersededStagedKeys(keys, 2, BRAIN);
    expect(toDelete).toEqual([stagedKeyFor(BRAIN, 1)]);
    expect(toDelete).not.toContain(stagedKeyFor(other, 1));
  });

  it("ignores keys whose revision suffix is not a finite number", () => {
    const keys = [
      stagedKeyFor(BRAIN, 1),
      `${stagedKeyPrefix(BRAIN)}not-a-number`,
      stagedKeyFor(BRAIN, 3),
    ];
    const toDelete = supersededStagedKeys(keys, 3, BRAIN);
    expect(toDelete).toEqual([stagedKeyFor(BRAIN, 1)]);
  });
});
