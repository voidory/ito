/**
 * FEAT-003 (M2) — BrainData default + additive-schema tests (Vitest).
 *
 * These assert that `createEmptyBrainData()` is a VALID fresh brain carrying
 * sensible defaults for the M2-added presentation fields (ADR-0009), and that
 * the additions are purely additive: a persisted v1-shape PresentationState
 * (only the original three fields) still typechecks and reads, and
 * SCHEMA_VERSION remains 1 (ADR-0004 / M7 for real migrations).
 */

import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "./index";
import { createEmptyBrainData, DEFAULT_CATEGORY_COLOR } from "./brain";
import { relationshipEndpoints } from "./relationship";
import {
  newCategoryId,
  newPageId,
  newRelationshipId,
  type AnnotationStyleRecord,
  type Category,
  type PresentationState,
  type Relationship,
} from "./index";

describe("createEmptyBrainData — fresh brain with M2 presentation defaults", () => {
  it("is valid and every collection is present and empty", () => {
    const data = createEmptyBrainData();
    expect(data.pages).toEqual([]);
    expect(data.categories).toEqual([]);
    expect(data.relationships).toEqual([]);
    expect(data.presentation.hiddenPageIds).toEqual([]);
    expect(data.presentation.hiddenRelationshipIds).toEqual([]);
    expect(data.presentation.positions).toEqual({});
  });

  it("seeds the M2 presentation fields with sane defaults (ADR-0009)", () => {
    const data = createEmptyBrainData();
    expect(data.presentation.nodePositions).toEqual({});
    expect(data.presentation.zoom).toBe(1);
    expect(data.presentation.categoryBounds).toEqual({});
    expect(data.presentation.active3D).toBe(false);
    expect(data.presentation.dragOffsets).toEqual({});
  });

  it("seeds the M2.5 annotationStyles store as an empty object (ADR-0010)", () => {
    const data = createEmptyBrainData();
    expect(data.presentation.annotationStyles).toEqual({});
  });

  it("stamps the current SCHEMA_VERSION (2 in M3) on a fresh manifest", () => {
    const data = createEmptyBrainData();
    expect(SCHEMA_VERSION).toBe(2);
    expect(data.manifest.schemaVersion).toBe(2);
  });
});

describe("additive schema — v1 shapes still typecheck and read", () => {
  it("accepts a v1 PresentationState with only the original three fields", () => {
    // This compiles ONLY if every M2-added field is optional.
    const v1: PresentationState = {
      hiddenPageIds: [],
      hiddenRelationshipIds: [],
      positions: {},
    };
    expect(v1.nodePositions).toBeUndefined();
    expect(v1.active3D).toBeUndefined();
    // M2.5 additive field (ADR-0010) is optional too.
    expect(v1.annotationStyles).toBeUndefined();
  });

  it("types annotationStyles as a map of AnnotationStyleRecord (M2.5)", () => {
    const annId = "ann-1";
    const style: AnnotationStyleRecord = { kind: "highlight", color: "#ffcc00" };
    const withStyles: PresentationState = {
      hiddenPageIds: [],
      hiddenRelationshipIds: [],
      positions: {},
      annotationStyles: { [annId]: style },
    };
    expect(withStyles.annotationStyles?.[annId]).toEqual({
      kind: "highlight",
      color: "#ffcc00",
    });
    // strokeWidth is an optional §14 refinement.
    const withStroke: AnnotationStyleRecord = {
      kind: "underline",
      color: "#00aaff",
      strokeWidth: 2,
    };
    expect(withStroke.strokeWidth).toBe(2);
  });

  it("accepts a v1 Category with no colorCode or masterPageId (additive)", () => {
    const v1: Category = {
      id: newCategoryId(),
      name: "Legacy",
      memberPageIds: [],
      createdAt: new Date().toISOString(),
    };
    expect(v1.colorCode).toBeUndefined();
    // M2.5 A14 master-page link is optional/additive (ADR-0010).
    expect(v1.masterPageId).toBeUndefined();
    // DEFAULT_CATEGORY_COLOR documents the fallback the app applies.
    expect(DEFAULT_CATEGORY_COLOR).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("reads a v1 Relationship (from/to only) via the endpoint normalizer", () => {
    const from = newPageId();
    const to = newPageId();
    const v1: Relationship = {
      id: newRelationshipId(),
      fromPageId: from,
      toPageId: to,
      kind: "relates",
      label: "",
      createdAt: new Date().toISOString(),
    };
    expect(v1.endpointPageIds).toBeUndefined();
    // M2.5 A13 explanatory-page link is optional/additive (ADR-0010).
    expect(v1.explanatoryPageId).toBeUndefined();
    // The normalizer yields the 2-page degenerate case.
    expect(relationshipEndpoints(v1)).toEqual([from, to]);
  });
});
