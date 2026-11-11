/**
 * M18 FEAT-004 (spec Phases 4, 5, 9, 10) — Identify UI + equation/molecule
 * recognition VERIFICATION render tests (Vitest / jsdom).
 *
 * Follows the M17 render pattern: a REAL Workbench over the InMemoryStorageAdapter,
 * createRoot/act, and assertions against the REAL persisted state
 * (wb.rawData() / reopen) — nothing mocked away. The only injected seam is the
 * RecognitionService's model backend (the UI exposes a `recognitionService`
 * prop defaulting to a not-configured service), so these tests prove both:
 *
 *  - the DEFAULT (unconfigured) path routes to manual entry and never
 *    fabricates a latex/smiles, yet an edited value still persists on Accept;
 *  - an INJECTED fake backend surfaces an editable recognized result whose
 *    Accept persists AreaAnchor.latex / AreaAnchor.smiles + mechanism.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InMemoryStorageAdapter } from "../../test/InMemoryStorageAdapter";
import { Workbench } from "../workbench";
import { HighlightEditPopover } from "./AnnotationOverlays";
import { createRecognitionService } from "../../science/recognition";
import type { ImageModelBackend } from "../../science/recognition";
import { parseSmilesGraph } from "../../science/recognition/chemGraph";
import { validateSmiles } from "../../science/recognition/chemistryValidation";
import type { NormalizedRect, Source } from "../../model";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  // The Popover mounts via a portal to document.body; clear any residue so a
  // stale popover from a prior test cannot satisfy a document-wide query.
  document.body.innerHTML = "";
});

async function render(node: ReturnType<typeof createElement>): Promise<HTMLElement> {
  // Tear down any prior mount + its portal so document-wide queries only ever
  // see the popover rendered by THIS call.
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
  return container;
}

async function flush(): Promise<void> {
  // Drain several microtask + macrotask turns so an async recognize() (a fake
  // backend's `async infer()`) and its follow-up setState settle. Each turn is
  // wrapped in its own act() so React re-renders between awaits.
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

async function type(el: Element, value: string): Promise<void> {
  const input = el as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

/**
 * M19: the scientific recognition controls now live behind a compact
 * "Scientific tools" submenu rather than the first-level popover. Open it so
 * the Equation / Molecule / Carbon skeleton controls resolve.
 */
async function openScientificTools(): Promise<void> {
  await click(document.querySelector('[data-testid="scientific-tools-btn"]')!);
}

async function importOne(wb: Workbench, title: string): Promise<Source> {
  return wb.importSource({
    title,
    bytes: new Uint8Array([title.length, 2, 3, 4]),
    versionHash: "hash-" + title,
    pageCount: 2,
    category: "Papers",
  });
}

/** A configured fake backend echoing a fixed text (model replaced; nothing else). */
function fakeBackend(text: string, confidence?: number): ImageModelBackend {
  return {
    id: "fake",
    isConfigured: () => true,
    async infer() {
      return confidence !== undefined ? { text, confidence } : { text };
    },
  };
}

const RECT: NormalizedRect = { x: 0.1, y: 0.1, width: 0.4, height: 0.3 };
const CROP = "data:image/png;base64,AAAA";

function popoverProps(wb: Workbench, annotationId: string, sourceId: string) {
  return {
    wb,
    popover: {
      annotationId: annotationId as never,
      sourceId: sourceId as never,
      rect: { left: 100, top: 100, right: 300, bottom: 140, width: 200 },
    },
    onClose: () => undefined,
    bump: () => undefined,
  };
}

describe("M19 — compact area menu with a Scientific tools submenu", () => {
  it("keeps the first-level menu compact: scientific controls are NOT shown directly", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);
    const src = await importOne(wb, "Figures");
    const area = await wb.commitAreaAnnotation(src.id, 0, RECT, "", CROP);

    await render(
      createElement(HighlightEditPopover, popoverProps(wb, area.annotation.id, src.id)),
    );
    await flush();

    // The first-level menu offers "Scientific tools" as ONE secondary entry…
    expect(document.querySelector('[data-testid="scientific-tools-btn"]')).not.toBeNull();
    // …and does NOT expose the recognition controls directly.
    for (const id of [
      "identify-equation-btn",
      "identify-molecule-btn",
      "identify-carbon-skeleton-btn",
      "extract-latex-btn",
      "extract-chem-btn",
      "science-panel",
    ]) {
      expect(document.querySelector(`[data-testid="${id}"]`)).toBeNull();
    }

    // Basic annotation controls + Delete remain available at the first level.
    expect(document.querySelector('[data-testid="color-controls"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="toggle-style-kind"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="popover-associate-insert"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="delete-highlight-only"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="delete-highlight-and-quotes"]')).not.toBeNull();
  });

  it("opening Scientific tools reveals Equation/Molecule/Carbon skeleton (and only there)", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);
    const src = await importOne(wb, "Figures");
    const area = await wb.commitAreaAnnotation(src.id, 0, RECT, "", CROP);

    await render(
      createElement(HighlightEditPopover, popoverProps(wb, area.annotation.id, src.id)),
    );
    await flush();
    await openScientificTools();

    // The submenu is shown with a back affordance and the three real tools.
    expect(document.querySelector('[data-testid="scientific-tools-menu"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="scientific-tools-back"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="identify-equation-btn"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="identify-molecule-btn"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="identify-carbon-skeleton-btn"]')).not.toBeNull();
    // Existing extract/edit scientific controls moved here too.
    expect(document.querySelector('[data-testid="extract-latex-btn"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="extract-chem-btn"]')).not.toBeNull();

    // No unimplemented / placeholder tool is exposed.
    expect(document.querySelector('[data-testid="identify-reaction-btn"]')).toBeNull();

    // The first-level actions are not duplicated underneath the submenu.
    expect(document.querySelector('[data-testid="scientific-tools-btn"]')).toBeNull();
    expect(document.querySelector('[data-testid="popover-associate-insert"]')).toBeNull();

    // Back returns to the first-level menu.
    await click(document.querySelector('[data-testid="scientific-tools-back"]')!);
    expect(document.querySelector('[data-testid="scientific-tools-menu"]')).toBeNull();
    expect(document.querySelector('[data-testid="scientific-tools-btn"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="identify-equation-btn"]')).toBeNull();
  });
});

describe("M18 FEAT-004 — unconfigured service routes to manual entry (Phase 9)", () => {
  it("Identify->Equation with the default service surfaces 'not configured' and fabricates no latex", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);
    const src = await importOne(wb, "Equations");
    const area = await wb.commitAreaAnnotation(src.id, 0, RECT, "", CROP);

    await render(
      createElement(HighlightEditPopover, popoverProps(wb, area.annotation.id, src.id)),
    );
    await flush();
    await openScientificTools();

    await click(document.querySelector('[data-testid="identify-equation-btn"]')!);

    // Unsupported status surface shown, and the editable field is EMPTY (no
    // fabricated recognition result).
    expect(document.querySelector('[data-testid="recognition-unsupported"]')).not.toBeNull();
    const input = document.querySelector(
      '[data-testid="recognized-latex-input"]',
    ) as HTMLTextAreaElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("");

    // Nothing was persisted to the anchor just by running Identify.
    const stored = wb.rawData().annotations.find((a) => a.id === area.annotation.id)!;
    expect(stored.scope.kind).toBe("area");
    if (stored.scope.kind === "area") expect(stored.scope.anchor.latex).toBeUndefined();
  });

  it("editing the recognized LaTeX and clicking Accept persists AreaAnchor.latex + renders MathML", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);
    const src = await importOne(wb, "Quadratics");
    const area = await wb.commitAreaAnnotation(src.id, 0, RECT, "", CROP);

    await render(
      createElement(HighlightEditPopover, popoverProps(wb, area.annotation.id, src.id)),
    );
    await flush();
    await openScientificTools();

    await click(document.querySelector('[data-testid="identify-equation-btn"]')!);
    await type(
      document.querySelector('[data-testid="recognized-latex-input"]')!,
      "\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
    );
    // Live preview compiles the edited LaTeX to MathML before Accept.
    const preview = document.querySelector('[data-testid="recognition-live-preview"]');
    expect(preview).not.toBeNull();
    expect(preview!.innerHTML).toContain("<mfrac>");

    await click(document.querySelector('[data-testid="recognition-accept-btn"]')!);

    // Persisted on the area anchor + survives reopen.
    const wb2 = await Workbench.open(storage, wb.snapshot().brainId);
    const stored = wb2.rawData().annotations.find((a) => a.id === area.annotation.id)!;
    expect(stored.scope.kind).toBe("area");
    if (stored.scope.kind === "area") {
      expect(stored.scope.anchor.latex).toContain("\\frac");
    }

    // Re-render the (reopened) popover: the existing MathML preview is shown.
    await render(
      createElement(HighlightEditPopover, popoverProps(wb2, area.annotation.id, src.id)),
    );
    await flush();
    await openScientificTools();
    const mathPreview = document.querySelector('[data-testid="annotation-latex-preview"]');
    expect(mathPreview).not.toBeNull();
    expect(mathPreview!.innerHTML).toContain("<mfrac>");
  });

  it("editing a valid SMILES and Accept persists AreaAnchor.smiles + mechanism", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);
    const src = await importOne(wb, "Molecules");
    const area = await wb.commitAreaAnnotation(src.id, 0, RECT, "", CROP);

    await render(
      createElement(HighlightEditPopover, popoverProps(wb, area.annotation.id, src.id)),
    );
    await flush();
    await openScientificTools();

    await click(document.querySelector('[data-testid="identify-molecule-btn"]')!);
    await type(document.querySelector('[data-testid="recognized-smiles-input"]')!, "c1ccccc1");
    await click(document.querySelector('[data-testid="recognition-accept-btn"]')!);

    const wb2 = await Workbench.open(storage, wb.snapshot().brainId);
    const stored = wb2.rawData().annotations.find((a) => a.id === area.annotation.id)!;
    expect(stored.scope.kind).toBe("area");
    if (stored.scope.kind === "area") {
      const storedSmiles = stored.scope.anchor.smiles!;
      // Aromaticity preserved: c1ccccc1 is not uppercased.
      expect(storedSmiles).toContain("c");
      expect(storedSmiles).not.toContain("C");
      // Topology preserved: the benzene RING survives Accept (ring-closure
      // digit is not dropped), so the stored molecule is still a ring, not an
      // open aromatic chain. Round-trip: the stored smiles parses to the SAME
      // graph the user confirmed (6 aromatic carbons, 6 bonds forming a cycle).
      expect(storedSmiles).toMatch(/c1cccc.*1|c1ccccc1/);
      const graph = parseSmilesGraph(storedSmiles);
      expect(graph).toHaveLength(1);
      expect(graph[0]!.atoms).toHaveLength(6);
      expect(graph[0]!.atoms.every((a) => a.aromatic)).toBe(true);
      // 6 atoms + 6 bonds = exactly one ring (a chain would have only 5 bonds).
      expect(graph[0]!.bonds).toHaveLength(6);
      expect(validateSmiles(storedSmiles).valid).toBe(true);
      expect(stored.scope.anchor.mechanism).toBeTruthy();
      expect(stored.scope.anchor.mechanism!.smiles).toBe(storedSmiles);
      expect(stored.scope.anchor.mechanism!.arrows).toEqual([]);
    }
  });

  it("an invalid edited SMILES is never accepted (Accept surfaces errors, nothing persists)", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);
    const src = await importOne(wb, "BadMol");
    const area = await wb.commitAreaAnnotation(src.id, 0, RECT, "", CROP);

    await render(
      createElement(HighlightEditPopover, popoverProps(wb, area.annotation.id, src.id)),
    );
    await flush();
    await openScientificTools();

    await click(document.querySelector('[data-testid="identify-molecule-btn"]')!);
    await type(document.querySelector('[data-testid="recognized-smiles-input"]')!, "CC(");
    await click(document.querySelector('[data-testid="recognition-accept-btn"]')!);

    expect(document.querySelector('[data-testid="recognition-errors"]')).not.toBeNull();
    const stored = wb.rawData().annotations.find((a) => a.id === area.annotation.id)!;
    if (stored.scope.kind === "area") expect(stored.scope.anchor.smiles).toBeUndefined();
  });
});

describe("M18 FEAT-004 — injected fake backend exercises the success verification path", () => {
  it("a configured math backend prefills the recognized LaTeX and Accept persists it", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);
    const src = await importOne(wb, "RecognizedEq");
    const area = await wb.commitAreaAnnotation(src.id, 0, RECT, "", CROP);
    const service = createRecognitionService({ mathBackend: fakeBackend("E = mc^2") });

    await render(
      createElement(HighlightEditPopover, {
        ...popoverProps(wb, area.annotation.id, src.id),
        recognitionService: service,
      }),
    );
    await flush();
    await openScientificTools();

    await click(document.querySelector('[data-testid="identify-equation-btn"]')!);

    const input = document.querySelector(
      '[data-testid="recognized-latex-input"]',
    ) as HTMLTextAreaElement;
    expect(input.value).toBe("E = mc^2");
    // A confident success does NOT show the low-confidence caveat.
    expect(document.querySelector('[data-testid="recognition-low-confidence"]')).toBeNull();

    await click(document.querySelector('[data-testid="recognition-accept-btn"]')!);

    const wb2 = await Workbench.open(storage, wb.snapshot().brainId);
    const stored = wb2.rawData().annotations.find((a) => a.id === area.annotation.id)!;
    if (stored.scope.kind === "area") {
      expect(stored.scope.anchor.latex).toBe("E = mc^2");
    }
  });

  it("a low-confidence molecule backend requires explicit review before Accept", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);
    const src = await importOne(wb, "LowConf");
    const area = await wb.commitAreaAnnotation(src.id, 0, RECT, "", CROP);
    const service = createRecognitionService({ moleculeBackend: fakeBackend("CCO", 0.1) });

    await render(
      createElement(HighlightEditPopover, {
        ...popoverProps(wb, area.annotation.id, src.id),
        recognitionService: service,
      }),
    );
    await flush();
    await openScientificTools();

    await click(document.querySelector('[data-testid="identify-molecule-btn"]')!);

    // The low-confidence caveat is shown; result is NOT auto-accepted.
    expect(document.querySelector('[data-testid="recognition-low-confidence"]')).not.toBeNull();
    const notYet = wb.rawData().annotations.find((a) => a.id === area.annotation.id)!;
    if (notYet.scope.kind === "area") expect(notYet.scope.anchor.smiles).toBeUndefined();

    // Explicit Accept persists the reviewed value.
    await click(document.querySelector('[data-testid="recognition-accept-btn"]')!);
    const stored = wb.rawData().annotations.find((a) => a.id === area.annotation.id)!;
    if (stored.scope.kind === "area") expect(stored.scope.anchor.smiles).toBe("CCO");
  });

  it("Cancel discards the recognition without touching the anchor", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);
    const src = await importOne(wb, "CancelMe");
    const area = await wb.commitAreaAnnotation(src.id, 0, RECT, "", CROP);
    const service = createRecognitionService({ mathBackend: fakeBackend("E = mc^2") });

    await render(
      createElement(HighlightEditPopover, {
        ...popoverProps(wb, area.annotation.id, src.id),
        recognitionService: service,
      }),
    );
    await flush();
    await openScientificTools();

    await click(document.querySelector('[data-testid="identify-equation-btn"]')!);
    expect(document.querySelector('[data-testid="recognized-latex-input"]')).not.toBeNull();
    await click(document.querySelector('[data-testid="recognition-cancel-btn"]')!);

    // Verification view gone, crop image untouched, nothing persisted.
    expect(document.querySelector('[data-testid="recognition-verify"]')).toBeNull();
    const stored = wb.rawData().annotations.find((a) => a.id === area.annotation.id)!;
    if (stored.scope.kind === "area") {
      expect(stored.scope.anchor.latex).toBeUndefined();
      expect(stored.scope.anchor.imageDataUrl).toBe(CROP);
    }
  });
});
