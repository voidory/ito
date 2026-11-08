/**
 * Helpers for constructing and updating the top-level BrainData container.
 *
 * These exist so the app and tests never hand-assemble a partial BrainData and
 * so new record collections (added as the model grows) get a single, correct
 * default in one place.
 */

import { SCHEMA_VERSION } from "./index";
import { newBrainId } from "./ids";
import type { BrainData, BrainManifest } from "./types";

/** An empty, valid manifest for a fresh brain. */
export function createManifest(now: string = new Date().toISOString()): BrainManifest {
  return {
    brainId: newBrainId(),
    schemaVersion: SCHEMA_VERSION,
    publicationRevision: 0,
    createdAt: now,
    updatedAt: now,
    assetIndex: [],
  };
}

/** A fully-populated, empty BrainData with every collection present. */
export function createEmptyBrainData(
  manifest: BrainManifest = createManifest(),
): BrainData {
  return {
    manifest,
    sources: [],
    annotations: [],
    evidenceInstances: [],
    subjectAssociations: [],
    pages: [],
    categories: [],
    relationships: [],
    tentativeAssociations: [],
    captures: [],
    revisions: [],
    presentation: {
      hiddenPageIds: [],
      hiddenRelationshipIds: [],
      positions: {},
    },
  };
}
