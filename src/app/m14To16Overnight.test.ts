/**
 * M14–M16 — overnight overhaul hard-gate tests (Vitest/jsdom).
 *
 * This file is the single home for the six overnight invariants from the
 * handoff. It drives the REAL Workbench (in-memory storage, nothing mocked) and
 * mounts the REAL React surfaces where a DOM contract is asserted. The reader's
 * SourcePane needs a live pdf.js worker (browser-only), so the adaptive-layout
 * test asserts the Reader SHELL's responsive decision (pane count + the
 * compact-second-source-tab) which is owned by Reader.tsx, not by SourcePane.
 *
 *  - Test 1 (<1360px Adaptive 2-Pane Layout): 2 open PDFs + 1 open Node page →
 *    at 1440px all 3 panes render; at 1100px only 1 PDF pane + Editor render
 *    alongside the compact-second-source-tab for 1-click swapping to Paper B.
 *  - Test 2 (Highlight-to-Highlight Drag Linking): linkHighlightsToObservation
 *    synthesises an Observation Node (nodeTier "observation") citing both
 *    highlights with a bridging-note block between them.
 *  - Test 3 (Unstirred Watercolour Curl Ribbons): buildWatercolorCurlRibbons +
 *    the NodesCanvas / WatercolorLayer render watercolor-curl-ribbons with
 *    distinct geometry for supports, contradicts and derives.
 *  - Test 4 (Camera Dive & Return): clicking a target records lastDiveTarget and
 *    returnToMap switches the view back to "nodes".
 *  - Test 5 (Idempotent Folder Inbox Sync): ingestFolderPdfEntries([a,b]) twice
 *    imports 2 sources on the first scan and 0 duplicates on the second.
 *  - Test 6 (SubjectEditor Formatting & Bridging Note Toolbar): the editor
 *    renders subject-editor-toolbar and insert-bridging-note-btn inserts a
 *    commentary block into the live ProseMirror document.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import { Reader, WORKSPACE_3PANE_MIN_WIDTH } from "./Reader";
import { NodesCanvas } from "./NodesCanvas";
import { SubjectEditor } from "./SubjectEditor";
import { buildWatercolorCurlRibbons } from "./WatercolorLayer";
import { hydrateState } from "../editor";
import type { DocumentJson } from "../editor";
import type { Source, SourceId, TextAnchor } from "../model";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
let root: Root | null = null;
let prevResizeObserver: unknown;

beforeEach(() => {
  // The Reader's EvidenceLines effect constructs a ResizeObserver, which jsdom
  // lacks; provide a no-op stub so the render completes.
  prevResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

afterEach(() => {
  if (prevResizeObserver === undefined) {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  } else {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = prevResizeObserver;
  }
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function render(node: ReturnType<typeof createElement>): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
  return container;
}

async function rerender(node: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root!.render(node);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

/** Set window.innerWidth and dispatch a resize so the Reader re-measures. */
function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
    writable: true,
  });
}

function textAnchor(sourceId: SourceId, versionHash: string, text: string): TextAnchor {
  return {
    docId: sourceId,
    sourceVersionHash: versionHash,
    pageIndex: 0,
    rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.02 }],
    selectedText: text,
    prefix: "before ",
    suffix: " after",
  };
}

async function importOne(wb: Workbench, title: string): Promise<Source> {
  return wb.importSource({
    title,
    bytes: new Uint8Array([title.length, 2, 3, 4]),
    versionHash: "hash-" + title,
    pageCount: 3,
    category: "Papers",
  });
}

async function annotate(wb: Workbench, src: Source, text: string) {
  return wb.commitTextAnnotation({
    sourceId: src.id,
    anchor: textAnchor(src.id, src.versionHash, text),
  });
}

/** A fake PDF File whose arrayBuffer yields the given bytes (jsdom lacks it). */
function pdfFile(bytes: Uint8Array, name: string): File {
  const file = new File([], name, { type: "application/pdf" });
  const copy = new Uint8Array(bytes);
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => copy.buffer.slice(0, copy.byteLength),
    configurable: true,
  });
  return file;
}

// ---------------------------------------------------------------------------
// Test 1 — <1360px Adaptive 2-Pane Layout
// ---------------------------------------------------------------------------

describe("M14–M16 Test 1 — <1360px adaptive multi-pane breakpoint", () => {
  it("renders 3 panes at >=1360px and a compact 2-pane + swap tab below it", async () => {
    expect(WORKSPACE_3PANE_MIN_WIDTH).toBe(1360);

    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);
    const paperA = await importOne(wb, "Paper A");
    const paperB = await importOne(wb, "Paper B");
    // A Node page to compose beside the two papers.
    const node = await wb.createSubjectPage("Observation");

    wb.openTogether([paperA.id, paperB.id]);
    wb.openSubjectPage(node.id);

    const props = () => ({
      wb,
      openSourceIds: wb.snapshot().openSourceIds,
      openSubjectPageId: wb.snapshot().openSubjectPageId,
      suppressMotion: true,
      highlightsTabOpen: false,
      onToggleTab: () => undefined,
      onToggleMotion: () => undefined,
      onBackToLibrary: () => undefined,
      bump: () => undefined,
    });

    // --- Wide: full 3-pane center-editor layout (Paper A | Editor | Paper B).
    setViewportWidth(1440);
    const el = await render(createElement(Reader, props()));
    await flush();
    const bodyWide = el.querySelector('[data-testid="reader-body"]')!;
    expect(bodyWide.getAttribute("data-pane-count")).toBe("3");
    expect(bodyWide.getAttribute("data-workspace-density")).not.toBe("compact-2pane");
    expect(el.querySelector('[data-testid="compact-second-source-tab"]')).toBeNull();

    // --- Narrow (<1360px): compact Paper A | Editor + the quick-swap tab.
    setViewportWidth(1100);
    window.dispatchEvent(new Event("resize"));
    await rerender(createElement(Reader, props()));
    await flush();
    const bodyNarrow = el.querySelector('[data-testid="reader-body"]')!;
    expect(bodyNarrow.getAttribute("data-workspace-density")).toBe("compact-2pane");
    expect(bodyNarrow.getAttribute("data-pane-count")).toBe("2");
    const tab = el.querySelector('[data-testid="compact-second-source-tab"]');
    expect(tab).not.toBeNull();
    // The hidden Paper B is the one offered for the 1-click swap.
    expect(tab!.getAttribute("data-source-id")).toBe(paperB.id);

    // Clicking the tab promotes Paper B to the front (visible) pane; both stay
    // open so the swap is reversible.
    await click(tab!);
    expect(wb.snapshot().openSourceIds[0]).toBe(paperB.id);
    expect(wb.snapshot().openSourceIds).toContain(paperA.id);
    expect(wb.snapshot().openSourceIds.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Highlight-to-Highlight Drag Linking
// ---------------------------------------------------------------------------

describe("M14–M16 Test 2 — highlight-to-highlight linking", () => {
  it("creates an Observation Node citing both highlights with a bridging note", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);
    const src = await importOne(wb, "Doc");
    const a1 = await annotate(wb, src, "first quote");
    const a2 = await annotate(wb, src, "second quote");

    const pagesBefore = wb.rawData().pages.length;
    const pageId = await wb.linkHighlightsToObservation(a1.annotation.id, a2.annotation.id);

    // Exactly one new page (the Observation Node) was created and opened.
    expect(wb.rawData().pages.length).toBe(pagesBefore + 1);
    expect(wb.snapshot().openSubjectPageId).toBe(pageId);

    // It cites BOTH highlights as evidence instances.
    const evidence = wb.rawData().evidenceInstances.filter((e) => e.destinationPageId === pageId);
    expect(evidence.length).toBe(2);
    const citedAnnotationIds = new Set(evidence.map((e) => e.annotationId));
    expect(citedAnnotationIds.has(a1.annotation.id)).toBe(true);
    expect(citedAnnotationIds.has(a2.annotation.id)).toBe(true);

    // Two cited evidence instances → the node is the "observation" tier (filled),
    // never a hollow single-highlight memory.
    const graphNode = wb.conceptGraph().nodes.find((n) => n.pageId === pageId)!;
    expect(graphNode.nodeTier).toBe("observation");

    // A bridging-note block sits between the two cited quote atoms.
    const doc = hydrateState(wb.subjectDocJson(pageId) as DocumentJson).doc;
    let bridgingNoteBlocks = 0;
    let evidenceAtoms = 0;
    doc.forEach((block) => {
      if (block.type.name === "paragraph" && block.attrs.bridgingNote === true) {
        bridgingNoteBlocks += 1;
      }
      block.descendants((n) => {
        if (n.type.name === "evidence") evidenceAtoms += 1;
        return true;
      });
    });
    expect(bridgingNoteBlocks).toBeGreaterThanOrEqual(1);
    expect(evidenceAtoms).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Unstirred Watercolour Curl Ribbons
// ---------------------------------------------------------------------------

describe("M14–M16 Test 3 — unstirred watercolour curl ribbons", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 200, y: 0 };

  it("buildWatercolorCurlRibbons yields distinct geometry per relationship kind", () => {
    const relates = buildWatercolorCurlRibbons(a, b, "relates");
    const supports = buildWatercolorCurlRibbons(a, b, "supports");
    const contradicts = buildWatercolorCurlRibbons(a, b, "contradicts");
    const derives = buildWatercolorCurlRibbons(a, b, "derives");

    // Each kind generates 2–3 interlocking ribbon path strings.
    for (const ribbons of [relates, supports, contradicts, derives]) {
      expect(ribbons.length).toBeGreaterThanOrEqual(2);
      expect(ribbons.length).toBeLessThanOrEqual(3);
      for (const d of ribbons) expect(d.startsWith("M ")).toBe(true);
    }

    // relates/supports share the harmonious helix geometry (3 ribbons each);
    // contradicts/derives differ (2 ribbons each), and all three requested
    // kinds produce DISTINCT path geometry from one another.
    expect(relates).toEqual(supports);
    expect(supports.join("|")).not.toBe(contradicts.join("|"));
    expect(contradicts.join("|")).not.toBe(derives.join("|"));
    expect(supports.join("|")).not.toBe(derives.join("|"));

    // Deterministic: identical inputs reproduce identical path strings.
    expect(buildWatercolorCurlRibbons(a, b, "contradicts")).toEqual(contradicts);
  });

  it("NodesCanvas renders curl-ribbon groups at a hub with the relationship kind", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);
    const n1 = await wb.createSubjectPage("Node 1");
    const n2 = await wb.createSubjectPage("Node 2");
    await wb.createRelationship([n1.id, n2.id], "contradicts", "tension");

    const el = await render(
      createElement(NodesCanvas, {
        wb,
        suppressMotion: true,
        bump: () => undefined,
      }),
    );
    await flush();

    const ribbons = el.querySelectorAll('[data-testid="watercolor-curl-ribbons"]');
    expect(ribbons.length).toBeGreaterThanOrEqual(1);
    // The hub ribbon carries the relationship kind it was created with.
    const kinds = Array.from(ribbons).map((r) => r.getAttribute("data-curl-kind"));
    expect(kinds).toContain("contradicts");
    // The directional marbling filter def is present in the scene.
    expect(el.querySelector("#watercolor-curl-marbling")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Camera Dive & Return
// ---------------------------------------------------------------------------

describe("M14–M16 Test 4 — camera dive & return-to-map", () => {
  it("records lastDiveTarget on dive and returns viewMode to 'nodes'", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);
    const node = await wb.createSubjectPage("Dive target");

    // No dive recorded yet.
    expect(wb.lastDiveTarget()).toBeNull();

    // Record a dive into the node (as the NodesCanvas clean-click does).
    await wb.recordCameraDive({ x: 12, y: -8, zoom: 1.5, targetId: node.id as string });
    const dive = wb.lastDiveTarget();
    expect(dive).not.toBeNull();
    expect(dive!.targetId).toBe(node.id);
    expect(dive!.zoom).toBe(1.5);

    // Navigate into a workspace (leave the nodes view).
    wb.setViewMode("files");
    expect(wb.snapshot().viewMode).toBe("files");

    // "← Return to Map" switches the view back to the nodes map.
    const returned = wb.returnToMap();
    expect(returned!.targetId).toBe(node.id);
    expect(wb.snapshot().viewMode).toBe("nodes");

    // The dive target survives a save/reopen (persisted presentation context).
    const wb2 = await Workbench.open(storage, wb.snapshot().brainId);
    expect(wb2.lastDiveTarget()?.targetId).toBe(node.id);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — Idempotent Folder Inbox Sync
// ---------------------------------------------------------------------------

describe("M14–M16 Test 5 — idempotent folder inbox sync", () => {
  it("imports 2 on the first scan and 0 duplicates on the second", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);

    const pdfA = pdfFile(new Uint8Array([10, 20, 30, 40, 50]), "alpha.pdf");
    const pdfB = pdfFile(new Uint8Array([11, 21, 31, 41, 51]), "beta.pdf");

    // First scan: both PDFs are brand new.
    const first = await wb.ingestFolderPdfEntries([pdfA, pdfB]);
    expect(first.length).toBe(2);
    expect(wb.rawData().sources.length).toBe(2);
    // Imported under the Inbox category.
    for (const s of wb.rawData().sources) expect(s.category).toBe("Inbox");

    // Second scan of the SAME folder: 0 duplicates created (slots re-hydrated).
    const second = await wb.ingestFolderPdfEntries([
      pdfFile(new Uint8Array([10, 20, 30, 40, 50]), "alpha.pdf"),
      pdfFile(new Uint8Array([11, 21, 31, 41, 51]), "beta.pdf"),
    ]);
    expect(second.length).toBe(2);
    expect(wb.rawData().sources.length).toBe(2);

    // Non-.pdf entries are ignored.
    const notPdf = new File([], "notes.txt", { type: "text/plain" });
    Object.defineProperty(notPdf, "arrayBuffer", {
      value: async () => new Uint8Array([1]).buffer,
      configurable: true,
    });
    await wb.ingestFolderPdfEntries([notPdf]);
    expect(wb.rawData().sources.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test 6 — SubjectEditor Formatting & Bridging Note Toolbar
// ---------------------------------------------------------------------------

describe("M14–M16 Test 6 — SubjectEditor formatting + bridging-note toolbar", () => {
  it("renders the toolbar and inserts a bridging-note block on click", async () => {
    const storage = new InMemoryStorageAdapter();
    const wb = await Workbench.open(storage);
    const page = await wb.createSubjectPage("Composition");

    const el = await render(
      createElement(SubjectEditor, {
        wb,
        pageId: page.id,
        onFollowSource: () => undefined,
        onClose: () => undefined,
        bump: () => undefined,
      }),
    );
    await flush();

    // The toolbar and all five controls render.
    expect(el.querySelector('[data-testid="subject-editor-toolbar"]')).not.toBeNull();
    for (const id of [
      "fmt-h2-btn",
      "fmt-bold-btn",
      "fmt-italic-btn",
      "fmt-callout-btn",
      "insert-bridging-note-btn",
    ]) {
      expect(el.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }

    // Clicking "+ Bridging Note" inserts a bridging-note paragraph into the live
    // ProseMirror document (persisted through the workbench).
    const btn = el.querySelector('[data-testid="insert-bridging-note-btn"]')!;
    await click(btn);
    // Let the debounced save flush.
    await new Promise((r) => setTimeout(r, 200));
    await flush();

    const doc = hydrateState(wb.subjectDocJson(page.id) as DocumentJson).doc;
    let bridgingNoteBlocks = 0;
    doc.forEach((block) => {
      if (block.type.name === "paragraph" && block.attrs.bridgingNote === true) {
        bridgingNoteBlocks += 1;
      }
    });
    expect(bridgingNoteBlocks).toBeGreaterThanOrEqual(1);
  });
});
