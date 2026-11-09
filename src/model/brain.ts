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
    // M7 (H06, H04): periodic history checkpoints, multi-span reflections, and
    // per-revision comments. All optional/additive so a v2 brain loads fine;
    // seeded here so a fresh brain is fully populated. SCHEMA_VERSION stays 2.
    checkpoints: [],
    reflections: [],
    revisionComments: {},
    // M5 (§16.3, A22): mobile-capture handling audit log. Optional/additive so
    // a v2 brain loads fine; seeded here so a fresh brain is fully populated.
    captureHandlings: [],
    presentation: {
      hiddenPageIds: [],
      hiddenRelationshipIds: [],
      positions: {},
      // M2 concept-network view state (ADR-0009). Sensible empty defaults so a
      // fresh brain is valid; all are optional so v1 data loads without them.
      nodePositions: {},
      zoom: 1,
      categoryBounds: {},
      active3D: false,
      dragOffsets: {},
      // M2.5 non-destructive annotation-style store (ADR-0010). Replaces the M1
      // sentinel-Capture hack; keyed by annotation id, empty on a fresh brain.
      annotationStyles: {},
    },
  };
}

/** The default watercolor pigment assigned to a category with no explicit color. */
export const DEFAULT_CATEGORY_COLOR = "#9aa7b2";
