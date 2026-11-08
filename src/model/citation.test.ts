import { describe, expect, it } from "vitest";
import {
  deriveSubjectReferenceStatus,
  deriveSubjectReferences,
  newAnnotationId,
  newEvidenceInstanceId,
  newPageId,
  newSubjectAssociationId,
  type EvidenceInstance,
  type SubjectAssociation,
} from "./index";

/**
 * Unit coverage for the DERIVED source-association / citation state machine
 * (spec section 6 table). These assert the machine over the model directly;
 * the real-browser flows live in the Playwright suite.
 */
describe("subject-reference state machine (derived per annotation-destination pair)", () => {
  const ann = newAnnotationId();
  const other = newAnnotationId();
  const subjectA = newPageId();
  const subjectB = newPageId();
  const now = new Date().toISOString();

  function assoc(annotationId = ann, destinationPageId = subjectA): SubjectAssociation {
    return {
      id: newSubjectAssociationId(),
      annotationId,
      destinationPageId,
      createdAt: now,
    };
  }
  function evidence(
    annotationId = ann,
    destinationPageId = subjectA,
    quotedText = "quote",
  ): EvidenceInstance {
    return {
      id: newEvidenceInstanceId(),
      annotationId,
      destinationPageId,
      quotedText,
      createdAt: now,
    };
  }

  it("is 'none' when nothing links the pair", () => {
    expect(deriveSubjectReferenceStatus(ann, subjectA, [], [])).toBe("none");
  });

  it("is 'tentative' (dotted) for a bare association with no evidence (R05)", () => {
    expect(deriveSubjectReferenceStatus(ann, subjectA, [], [assoc()])).toBe("tentative");
  });

  it("is 'cited' (solid) once a provenance-bearing quote exists", () => {
    expect(deriveSubjectReferenceStatus(ann, subjectA, [evidence()], [])).toBe("cited");
  });

  it("evidence dominates a coexisting association (solid, not dotted)", () => {
    expect(
      deriveSubjectReferenceStatus(ann, subjectA, [evidence()], [assoc()]),
    ).toBe("cited");
  });

  it("same annotation is solid for one subject while tentative for another (R07)", () => {
    const evi = [evidence(ann, subjectA)];
    const assocs = [assoc(ann, subjectB)];
    expect(deriveSubjectReferenceStatus(ann, subjectA, evi, assocs)).toBe("cited");
    expect(deriveSubjectReferenceStatus(ann, subjectB, evi, assocs)).toBe("tentative");
  });

  it("removing ONE of two quotes does not demote the pair (stays cited)", () => {
    const e1 = evidence(ann, subjectA, "first");
    const e2 = evidence(ann, subjectA, "second");
    const afterRemoval = [e1]; // e2 removed
    expect(deriveSubjectReferenceStatus(ann, subjectA, [e1, e2], [])).toBe("cited");
    expect(deriveSubjectReferenceStatus(ann, subjectA, afterRemoval, [])).toBe("cited");
  });

  it("removing the LAST quote reverts to tentative when an association remains", () => {
    const e1 = evidence(ann, subjectA);
    const a1 = assoc(ann, subjectA);
    // With the quote: cited. After removing the only quote: tentative (dotted).
    expect(deriveSubjectReferenceStatus(ann, subjectA, [e1], [a1])).toBe("cited");
    expect(deriveSubjectReferenceStatus(ann, subjectA, [], [a1])).toBe("tentative");
  });

  it("removing the last quote with NO association falls to none", () => {
    const e1 = evidence(ann, subjectA);
    expect(deriveSubjectReferenceStatus(ann, subjectA, [e1], [])).toBe("cited");
    expect(deriveSubjectReferenceStatus(ann, subjectA, [], [])).toBe("none");
  });

  it("enumerates references only for linked pairs, with live status", () => {
    const evi = [evidence(ann, subjectA)];
    const assocs = [assoc(ann, subjectB)];
    const refs = deriveSubjectReferences(ann, evi, assocs);
    const byDest = new Map(refs.map((r) => [r.destinationPageId, r.status]));
    expect(refs).toHaveLength(2);
    expect(byDest.get(subjectA)).toBe("cited");
    expect(byDest.get(subjectB)).toBe("tentative");
    // Nothing links `other`.
    expect(deriveSubjectReferences(other, evi, assocs)).toHaveLength(0);
  });
});
