/**
 * FEAT-001 (Pass-A engine refinement 1.3.2) - sanitizeSnapshotHtml must strip
 * inline event-handler attributes whether their value is double-quoted,
 * single-quoted, OR UNQUOTED (e.g. onclick=alert(1)). The widened regex also
 * preserves the preceding whitespace so adjacent attributes are not glued
 * together, and the <script>/<style>/javascript: strips remain intact.
 */

import { describe, expect, it } from "vitest";
import { sanitizeSnapshotHtml } from "./Reader";

describe("sanitizeSnapshotHtml (1.3.2) strips inline handlers", () => {
  it("strips an UNQUOTED inline handler (onclick=alert(1))", () => {
    const out = sanitizeSnapshotHtml('<a href="#" onclick=alert(1)>x</a>');
    expect(out).not.toMatch(/onclick/i);
    expect(out).toContain('href="#"');
    expect(out).toContain(">x</a>");
  });

  it("still strips double- and single-quoted handlers", () => {
    const dq = sanitizeSnapshotHtml('<div onmouseover="steal()">hi</div>');
    expect(dq).not.toMatch(/onmouseover/i);
    const sq = sanitizeSnapshotHtml("<div onload='go()'>hi</div>");
    expect(sq).not.toMatch(/onload/i);
  });

  it("preserves the preceding whitespace so adjacent attributes stay separated", () => {
    const out = sanitizeSnapshotHtml('<img src="a.png" onerror=boom() alt="pic">');
    expect(out).not.toMatch(/onerror/i);
    // src and alt must both survive and remain parseable (not glued together).
    expect(out).toContain('src="a.png"');
    expect(out).toContain('alt="pic"');
    expect(out).toContain('src="a.png" ');
  });

  it("still removes <script>/<style> blocks and javascript: URLs", () => {
    const out = sanitizeSnapshotHtml(
      '<script>evil()</script><style>.x{}</style><a href="javascript:bad()">y</a>',
    );
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/<style/i);
    expect(out).not.toMatch(/javascript:/i);
  });
});
