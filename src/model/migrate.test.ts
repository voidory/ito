/**
 * Pure stepwise migration runner tests (M3, A19).
 *
 * These assert migrateBrainData upgrades a v1 (and legacy v0) brain to the
 * current SCHEMA_VERSION, fills every missing optional collection, preserves
 * all records across a round-trip (no data loss), and refuses to silently
 * downgrade a payload that is newer than this build.
 */

import { describe, expect, it } from "vitest";
import {
  FutureSchemaError,
  SCHEMA_VERSION,
  UnmigratableError,
  migrateBrainData,
  newBrainId,
  type BrainData,
} from "./index";

/** A minimal, hand-authored v1 brain payload (as it would sit in storage). */
function v1Brain(): Record<string, unknown> {
  const brainId = newBrainId();
  return {
    manifest: {
      brainId,
      schemaVersion: 1,
      publicationRevision: 3,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
      assetIndex: [
        {
          assetId: "asset_a",
          contentType: "application/pdf",
          byteLength: 10,
          contentHash: "hash_a",
        },
      ],
    },
    sources: [
      {
        id: "src_1",
        kind: "pdf",
        title: "A Paper",
        assetId: "asset_a",
        versionHash: "hash_a",
        pageCount: 5,
        importedAt: "2024-01-01T00:00:00.000Z",
        category: "Imported",
      },
    ],
    annotations: [
      {
        id: "ann_1",
        sourceId: "src_1",
        scope: {
          kind: "text",
          anchor: {
            docId: "src_1",
            sourceVersionHash: "hash_a",
            pageIndex: 0,
            rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.03 }],
            selectedText: "quoted",
            prefix: "",
            suffix: "",
          },
        },
        resolution: { kind: "resolved" },
        comment: "",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ],
    pages: [
      {
        id: "page_1",
        kind: "subject",
        title: "Subject",
        documentJson: { type: "doc", content: [{ type: "paragraph" }] },
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ],
    // Intentionally OMIT evidenceInstances, subjectAssociations, categories,
    // relationships, tentativeAssociations, captures, revisions to prove the
    // runner fills missing optional collections with empty defaults.
    presentation: {
      hiddenPageIds: [],
      hiddenRelationshipIds: [],
      positions: {},
    },
  };
}

describe("migrateBrainData", () => {
  it("migrates a v1 brain to the current version with all collections present", () => {
    const migrated = migrateBrainData(v1Brain());
    expect(migrated.manifest.schemaVersion).toBe(SCHEMA_VERSION);
    // Records preserved.
    expect(migrated.sources).toHaveLength(1);
    expect(migrated.annotations).toHaveLength(1);
    expect(migrated.pages).toHaveLength(1);
    // Missing optional collections filled with empty defaults.
    expect(migrated.evidenceInstances).toEqual([]);
    expect(migrated.subjectAssociations).toEqual([]);
    expect(migrated.categories).toEqual([]);
    expect(migrated.relationships).toEqual([]);
    expect(migrated.tentativeAssociations).toEqual([]);
    expect(migrated.captures).toEqual([]);
    expect(migrated.revisions).toEqual([]);
    // Presentation defaults folded in (annotationStyles seeded) while keeping
    // the explicitly-present fields.
    expect(migrated.presentation.hiddenPageIds).toEqual([]);
    expect(migrated.presentation.annotationStyles).toEqual({});
    // M13 (§2.2): the Subject-intersection page map backfills to {}.
    expect(migrated.subjectIntersectionPages).toEqual({});
  });

  it("preserves all records across a migrate -> serialize -> migrate round-trip", () => {
    const first = migrateBrainData(v1Brain());
    // Re-serialize (structuredClone mimics a storage write/read) and migrate
    // the already-current payload again: nothing is lost or duplicated.
    const roundTripped = migrateBrainData(structuredClone(first) as unknown);
    expect(roundTripped.manifest.schemaVersion).toBe(SCHEMA_VERSION);
    expect(roundTripped.sources).toEqual(first.sources);
    expect(roundTripped.annotations).toEqual(first.annotations);
    expect(roundTripped.pages).toEqual(first.pages);
    expect(roundTripped.manifest.brainId).toBe(first.manifest.brainId);
  });

  it("runs the legacy v0 -> v1 step for a v0 payload", () => {
    const raw = v1Brain();
    (raw["manifest"] as Record<string, unknown>)["schemaVersion"] = 0;
    const migrated = migrateBrainData(raw);
    expect(migrated.manifest.schemaVersion).toBe(SCHEMA_VERSION);
    // v0 records still survive the full v0 -> v1 -> v2 climb.
    expect(migrated.sources).toHaveLength(1);
    expect(migrated.annotations).toHaveLength(1);
  });

  it("fills missing optional arrays with empty defaults", () => {
    const raw = v1Brain();
    delete raw["sources"];
    delete raw["annotations"];
    const migrated = migrateBrainData(raw);
    expect(migrated.sources).toEqual([]);
    expect(migrated.annotations).toEqual([]);
  });

  it("reports (does not downgrade) a payload newer than the current version", () => {
    const raw = v1Brain();
    (raw["manifest"] as Record<string, unknown>)["schemaVersion"] = SCHEMA_VERSION + 1;
    expect(() => migrateBrainData(raw)).toThrow(FutureSchemaError);
  });

  it("rejects an unparseable payload", () => {
    expect(() => migrateBrainData(null)).toThrow(UnmigratableError);
    expect(() => migrateBrainData(42)).toThrow(UnmigratableError);
    expect(() => migrateBrainData({})).toThrow(UnmigratableError);
    expect(() => migrateBrainData({ manifest: {} } as BrainData)).toThrow(
      UnmigratableError,
    );
  });
});
