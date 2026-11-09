/**
 * FEAT-002 hardening: focused unit coverage for `yearFromPdfDate`, the
 * best-effort PDF-date year parser used by `readPdfMetadata`. It must prefer
 * the `D:YYYY` PDF-date form, accept a bare plausible year, and — crucially —
 * reject a malformed 4-digit run that falls outside the plausible-year window
 * (1500-2099, matching Library.tsx's title regex) by returning `undefined` so
 * the caller's title-regex/em-dash fallback still applies. It never throws.
 */

import { describe, expect, it } from "vitest";
import { yearFromPdfDate } from "./pdfImport";

describe("yearFromPdfDate (FEAT-002)", () => {
  it("parses the year from a full PDF date (D:YYYYMMDD...)", () => {
    expect(yearFromPdfDate("D:20230115093000Z")).toBe("2023");
  });

  it("parses a bare plausible year with no D: prefix", () => {
    expect(yearFromPdfDate("1987")).toBe("1987");
  });

  it("returns undefined for a malformed 4-digit non-year", () => {
    // A stray 4-digit run outside the plausible-year range must NOT be taken
    // as a year; the caller then falls back to the title regex / em-dash.
    expect(yearFromPdfDate("3141 pages")).toBeUndefined();
    expect(yearFromPdfDate("D:2099")).toBe("2099");
    expect(yearFromPdfDate("D:2100")).toBeUndefined();
  });

  it("never throws on non-string / empty input", () => {
    expect(yearFromPdfDate(undefined)).toBeUndefined();
    expect(yearFromPdfDate(42)).toBeUndefined();
    expect(yearFromPdfDate("")).toBeUndefined();
  });
});
