/**
 * §3.4 Warm Archival Research theme + micro-animation motion-gate coverage.
 *
 * theme.css is plain CSS (no runtime logic), so the proof that the exact design
 * tokens exist, that the micro-animations use the specified 160ms
 * cubic-bezier(0.22,1,0.36,1) curve, and that the STRICT motion gate (R19,
 * A09-M2) disables ALL transitions/keyframes under [data-suppress-motion="true"]
 * and prefers-reduced-motion is a content assertion over the stylesheet source.
 * The sandbox cannot run Playwright/Chromium, so this is the headless guarantee
 * that the gate is wired correctly and cannot silently regress.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/app/theme.css"), "utf8");

describe("theme.css — Warm Archival Research design tokens (§3.4)", () => {
  it("defines the exact core palette custom properties", () => {
    expect(css).toContain("--ito-bg-paper: #f8f5ee");
    expect(css).toContain("--ito-bg-elevated: #ffffff");
    expect(css).toContain("--ito-ink: #1e232a");
    expect(css).toContain("--ito-accent: #2c4a6f");
    expect(css).toContain("--ito-border: #dcd6c8");
  });

  it("defines radius + shadow tokens", () => {
    expect(css).toMatch(/--ito-radius-[a-z]+:/);
    expect(css).toMatch(/--ito-shadow-[a-z]+:/);
  });

  it("styles buttons, inputs, selects, checkboxes, cards, and modals", () => {
    expect(css).toMatch(/\bbutton\s*\{/);
    expect(css).toContain("input");
    expect(css).toContain("select");
    expect(css).toContain('input[type="checkbox"]');
    expect(css).toContain(".ito-card");
    expect(css).toContain('[data-testid$="-modal"]');
    // Segmented view-switch pills.
    expect(css).toContain('[data-testid="view-switch"]');
  });
});

describe("theme.css — tactile micro-animations (§3.4)", () => {
  it("uses the specified 160ms cubic-bezier(0.22, 1, 0.36, 1) motion curve", () => {
    expect(css).toContain("--ito-motion-fast: 160ms");
    expect(css).toContain("cubic-bezier(0.22, 1, 0.36, 1)");
  });

  it("includes a subtle button press scale(0.97) on :active", () => {
    expect(css).toMatch(/button:active\s*\{[^}]*transform:\s*scale\(0\.97\)/);
  });

  it("defines the fade-and-slide modal entry + highlight pulse keyframes", () => {
    expect(css).toContain("@keyframes ito-pop-in");
    expect(css).toContain("@keyframes ito-highlight-pulse");
  });
});

describe("theme.css — STRICT motion gate (R19, A09-M2)", () => {
  it("disables all transitions + animations under [data-suppress-motion='true']", () => {
    const block = css.slice(css.indexOf('[data-suppress-motion="true"]'));
    expect(block).toContain("animation: none !important");
    expect(block).toContain("transition: none !important");
  });

  it("disables all transitions + animations under prefers-reduced-motion: reduce", () => {
    const idx = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(idx).toBeGreaterThanOrEqual(0);
    const block = css.slice(idx);
    expect(block).toContain("animation: none !important");
    expect(block).toContain("transition: none !important");
  });
});
