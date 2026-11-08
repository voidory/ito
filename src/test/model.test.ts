import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  countCitingPages,
  deriveCitationStatus,
  newAnnotationId,
  newEvidenceInstanceId,
  newPageId,
  type EvidenceInstance,
} from "../model";

describe("durable ids", () => {
  it("generates unique prefixed ids", () => {
    const a = newAnnotationId();
    const b = newAnnotationId();
    expect(a).not.toEqual(b);
    expect(a.startsWith("ann_")).toBe(true);
  });
});

describe("citation status (derived per annotation-destination pair)", () => {
  const annotationId = newAnnotationId();
  const otherAnnotationId = newAnnotationId();
  const pageA = newPageId();
  const pageB = newPageId();

  const evidence: EvidenceInstance[] = [
    {
      id: newEvidenceInstanceId(),
      annotationId,
      destinationPageId: pageA,
      quotedText: "quoted",
      createdAt: new Date().toISOString(),
    },
  ];

  it("is cited for the exact pair that has evidence", () => {
    expect(deriveCitationStatus(annotationId, pageA, evidence)).toBe("cited");
  });

  it("is uncited for a different destination page", () => {
    expect(deriveCitationStatus(annotationId, pageB, evidence)).toBe("uncited");
  });

  it("is uncited for a different annotation", () => {
    expect(deriveCitationStatus(otherAnnotationId, pageA, evidence)).toBe("uncited");
  });

  it("counts distinct citing pages", () => {
    expect(countCitingPages(annotationId, evidence)).toBe(1);
  });
});

describe("schema version", () => {
  it("is a positive integer", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });
});
