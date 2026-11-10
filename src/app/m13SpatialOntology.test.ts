/**
 * M13 — Spatial Ontology & Reader Stability hard-gate tests (Vitest/jsdom).
 *
 * This file is the single home for the six M13 invariant tests from the handoff
 * (§3). FEAT-001 owns Tests 1 & 2 (reader stability); FEAT-002/003 append Tests
 * 3–6 (spatial basins, source routing, promote-to-node) to the same file.
 *
 *  - Test 1 (Canvas Render Serialization, §1.1): renderPage()'s initial draw()
 *    and a concurrent rerender() NEVER run two pdf.js page.render() calls on the
 *    same canvas — the in-flight RenderTask is cancelled + awaited first.
 *  - Test 2 (Quote-to-Rect Re-Anchoring, §1.3): after a paragraph shifts to a
 *    new vertical position on a revised page, recomputeRectsFromQuote (and the
 *    workbench re-anchor path + updateAnnotationRects) re-derive the
 *    annotation's normalized [x, y, w, h] from the new span coordinates.
 *
 * The real SourcePane needs a live pdf.js worker (browser-only), so these tests
 * drive the DOM-pure seams: Test 1 mocks the pdfjs module so renderPage runs in
 * jsdom; Test 2 builds a hand-shaped .textLayer fixture and drives the REAL
 * Workbench (in-memory storage) for the re-anchor path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workbench as WorkbenchType } from "./workbench";

// ---------------------------------------------------------------------------
// Test 1 harness: mock pdfjs-dist so render.ts runs under jsdom. The mock lets
// each fake page.render() hand back a controllable promise + a RenderTask-like
// object with a cancel() spy, and a shared monitor records how many renders are
// concurrently in flight on the SAME canvas.
// ---------------------------------------------------------------------------

/** A controllable fake RenderTask: resolve/reject its promise on demand. */
interface FakeRenderTask {
  readonly promise: Promise<void>;
  cancel: ReturnType<typeof vi.fn>;
  resolve: () => void;
  reject: (err: unknown) => void;
  cancelled: boolean;
}

/** Shared monitor for concurrent render() calls on the fake page's canvas. */
interface RenderMonitor {
  inFlight: number;
  maxConcurrent: number;
  starts: number;
  tasks: FakeRenderTask[];
}

const renderMonitor: RenderMonitor = {
  inFlight: 0,
  maxConcurrent: 0,
  starts: 0,
  tasks: [],
};

/**
 * Build a pdf.js RenderingCancelledException-shaped error. render.ts identifies
 * a cancellation by `err.name === "RenderingCancelledException"` (it never
 * imports a concrete class), so matching the name is sufficient + realistic.
 */
function renderingCancelledError(): Error {
  const err = new Error("Rendering cancelled");
  err.name = "RenderingCancelledException";
  return err;
}

function makeRenderTask(): FakeRenderTask {
  let resolveFn: () => void = () => undefined;
  let rejectFn: (err: unknown) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  // Swallow unhandled-rejection noise: tests settle every task explicitly.
  promise.catch(() => undefined);
  const task: FakeRenderTask = {
    promise,
    cancelled: false,
    cancel: vi.fn(() => {
      task.cancelled = true;
    }),
    resolve: () => {
      renderMonitor.inFlight -= 1;
      resolveFn();
    },
    reject: (err: unknown) => {
      renderMonitor.inFlight -= 1;
      rejectFn(err);
    },
  };
  return task;
}

vi.mock("pdfjs-dist/build/pdf.worker.mjs?url", () => ({ default: "mock-worker-url" }));

vi.mock("pdfjs-dist", () => {
  // A minimal viewport pdf.js returns from getViewport({ scale }).
  const makeViewport = (scale: number) => ({ width: 100 * scale, height: 140 * scale });
  // The fake page: render() hands back a controllable RenderTask and bumps the
  // concurrency monitor so the test can assert serialization on the canvas.
  const page = {
    getViewport: (opts: { scale: number }) => makeViewport(opts.scale),
    getTextContent: async () => ({ items: [{ str: "hello" }] }),
    render: () => {
      renderMonitor.starts += 1;
      renderMonitor.inFlight += 1;
      renderMonitor.maxConcurrent = Math.max(
        renderMonitor.maxConcurrent,
        renderMonitor.inFlight,
      );
      const task = makeRenderTask();
      renderMonitor.tasks.push(task);
      return task;
    },
  };
  // A TextLayer stub whose render() resolves immediately (no real glyphs).
  class TextLayer {
    render(): Promise<void> {
      return Promise.resolve();
    }
  }
  return {
    GlobalWorkerOptions: { workerSrc: "" },
    getDocument: () => ({
      promise: Promise.resolve({ numPages: 1, getPage: async () => page }),
    }),
    TextLayer,
  };
});

describe("M13 Test 1 — Canvas Render Serialization (§1.1)", () => {
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    renderMonitor.inFlight = 0;
    renderMonitor.maxConcurrent = 0;
    renderMonitor.starts = 0;
    renderMonitor.tasks = [];
    // jsdom has no 2d canvas backend, so getContext("2d") is null; render.ts
    // calls ctx.setTransform before page.render(). Stub a minimal 2d context so
    // draw() reaches the render-task serialization under test.
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      kind: string,
    ) {
      return kind === "2d"
        ? ({ setTransform: () => undefined } as unknown as CanvasRenderingContext2D)
        : null;
    } as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    document.body.replaceChildren();
  });

  it("never runs two concurrent page.render() calls on the same canvas when a rerender races the initial draw", async () => {
    // Import AFTER the mocks are registered so render.ts binds the fake pdfjs.
    const { loadDocument, renderPage } = await import("../pdf/render");

    const mount = document.createElement("div");
    document.body.appendChild(mount);

    const doc = await loadDocument(new Uint8Array([1, 2, 3]));

    // Kick off the initial render but DO NOT resolve its render task yet, so the
    // first page.render() is still in flight when we fire a rerender.
    const renderedPromise = renderPage(doc, 1, mount, 1.5);
    // Let the microtasks up to the first `await task.promise` run.
    await Promise.resolve();
    await Promise.resolve();

    expect(renderMonitor.starts).toBe(1);
    expect(renderMonitor.inFlight).toBe(1);
    const firstTask = renderMonitor.tasks[0]!;

    // Resolve the initial render so renderPage() can finish wiring the page.
    firstTask.resolve();
    const page = await renderedPromise;

    // Now race: start a rerender (which calls draw again) while we hold its
    // in-flight task open, then fire a SECOND rerender immediately. The second
    // draw must cancel + await the first before calling page.render() again.
    const rerenderA = page.rerender(2.6);
    await Promise.resolve();
    await Promise.resolve();
    // The rerender started a new render task (starts === 2) and it is the only
    // one in flight.
    expect(renderMonitor.starts).toBe(2);
    expect(renderMonitor.inFlight).toBe(1);
    const taskA = renderMonitor.tasks[1]!;

    // Fire a competing rerender WHILE taskA is still in flight.
    const rerenderB = page.rerender(1.0);
    await Promise.resolve();
    await Promise.resolve();

    // The competing draw must have cancelled the in-flight task A rather than
    // starting a second concurrent render on the same canvas.
    expect(taskA.cancel).toHaveBeenCalledTimes(1);
    // Settle the cancelled task A exactly as pdf.js would: reject with a
    // RenderingCancelledException (render.ts swallows it).
    taskA.reject(renderingCancelledError());
    await Promise.resolve();
    await Promise.resolve();

    // Draw B now owns the canvas; resolve whichever render task is live.
    const liveTask = renderMonitor.tasks[renderMonitor.tasks.length - 1]!;
    liveTask.resolve();
    await rerenderA;
    await rerenderB;

    // The core invariant: at no point were two renders concurrently in flight
    // on the same canvas.
    expect(renderMonitor.maxConcurrent).toBe(1);
    expect(renderMonitor.inFlight).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Quote-to-Rect Re-Anchoring (§1.3). Uses a hand-built .pdf-page-stage
// with a .textLayer whose spans carry absolute left/top/width/height so the
// jsdom 0x0 getClientRects() fallback can recover a span box. Proves both the
// pure DOM helper (recomputeRectsFromQuote) and the workbench re-anchor path
// (reanchorAnnotations sets rectsStale; updateAnnotationRects persists fresh
// rects + clears the flag).
// ---------------------------------------------------------------------------

describe("M13 Test 2 — Quote-to-Rect Re-Anchoring (§1.3)", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  /**
   * Build a `.pdf-page-stage` of a fixed size containing a `.textLayer` whose
   * paragraph span sits at a chosen vertical offset. jsdom has no layout engine
   * so getBoundingClientRect() returns 0×0; the span records its geometry as
   * inline left/top/width/height styles, which recomputeRectsFromQuote's jsdom
   * fallback reads. The stage's getBoundingClientRect is stubbed to a known box
   * so normalization is deterministic.
   */
  function buildStage(
    quote: string,
    span: { left: number; top: number; width: number; height: number },
    stageBox: { width: number; height: number } = { width: 100, height: 200 },
  ): HTMLElement {
    const stage = document.createElement("div");
    stage.className = "pdf-page-stage";
    // Deterministic stage box (jsdom would otherwise report all zeros).
    stage.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: stageBox.width,
        bottom: stageBox.height,
        width: stageBox.width,
        height: stageBox.height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    const spanEl = document.createElement("span");
    spanEl.textContent = quote;
    spanEl.style.position = "absolute";
    spanEl.style.left = `${span.left}px`;
    spanEl.style.top = `${span.top}px`;
    spanEl.style.width = `${span.width}px`;
    spanEl.style.height = `${span.height}px`;
    textLayer.appendChild(spanEl);
    stage.appendChild(textLayer);
    document.body.appendChild(stage);
    return stage;
  }

  it("re-derives normalized rects from the quote's NEW span position on a revised page", async () => {
    const { recomputeRectsFromQuote } = await import("../pdf/highlight");
    const quote = "quantum decoherence in microtubules";

    // The paragraph sits near the top in the original draft (y = 20 / 200).
    const originalStage = buildStage(quote, { left: 10, top: 20, width: 60, height: 12 });
    const originalRects = recomputeRectsFromQuote(originalStage, quote);
    expect(originalRects).toHaveLength(1);
    expect(originalRects[0]!.y).toBeCloseTo(20 / 200, 5);
    expect(originalRects[0]!.x).toBeCloseTo(10 / 100, 5);

    // In the revised draft the SAME paragraph moved far down the page (y = 150).
    const revisedStage = buildStage(quote, { left: 10, top: 150, width: 60, height: 12 });
    const revisedRects = recomputeRectsFromQuote(revisedStage, quote);
    expect(revisedRects).toHaveLength(1);
    // The re-derived y tracks the NEW vertical position, not the old one.
    expect(revisedRects[0]!.y).toBeCloseTo(150 / 200, 5);
    expect(revisedRects[0]!.y).toBeGreaterThan(originalRects[0]!.y);
  });

  it("matches the quote whitespace-insensitively and returns [] for a missing quote", async () => {
    const { recomputeRectsFromQuote } = await import("../pdf/highlight");
    // The stored quote uses collapsed spacing; the DOM text has extra newlines.
    const stage = buildStage("alpha   beta\n gamma", {
      left: 5,
      top: 40,
      width: 80,
      height: 10,
    });
    const hit = recomputeRectsFromQuote(stage, "alpha beta gamma");
    expect(hit).toHaveLength(1);
    expect(hit[0]!.y).toBeCloseTo(40 / 200, 5);
    // A quote not present anywhere yields [] so the caller keeps existing rects.
    expect(recomputeRectsFromQuote(stage, "not on this page at all")).toEqual([]);
  });

  it("workbench re-anchor path marks rectsStale then updateAnnotationRects writes fresh rects + clears the flag", async () => {
    const { Workbench } = await import("./workbench");
    const { InMemoryStorageAdapter } = await import("../test/InMemoryStorageAdapter");

    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const quote =
      "introduction and apparatus list for the titration experiment procedure steps safety goggles";

    // Draft: the highlighted paragraph lives on page 0.
    const draftPages = [
      quote,
      "results discussion sources of error and conclusion of the laboratory report",
    ];
    const src = await wb.importSource({
      title: "CH2101_Lab1_draft.pdf",
      bytes: new TextEncoder().encode("LAB1-DRAFT-BYTES"),
      versionHash: "draft",
      pageCount: 2,
      pageTexts: draftPages,
    });
    const view = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: {
        docId: src.id,
        sourceVersionHash: src.versionHash,
        pageIndex: 0,
        // Stale rects from the draft (will be replaced after re-anchor).
        rects: [{ x: 0.1, y: 0.1, width: 0.5, height: 0.02 }],
        selectedText: quote,
        prefix: "",
        suffix: "",
      },
    });
    const annId = view.annotation.id;

    // Final draft: a rewritten page 0 pushed the paragraph to page 1.
    const finalPages = [
      "completely rewritten abstract and theoretical background section with new equations",
      quote,
    ];
    await wb.reconcileOrAttachSource({
      title: "CH2101_Lab1_final.pdf",
      bytes: new TextEncoder().encode("LAB1-FINAL-BYTES"),
      versionHash: "final",
      pageCount: 2,
      pageTexts: finalPages,
    });

    // The re-anchor moved the annotation to page 1 AND marked its rects stale,
    // because the stored rects still hold the draft's (page-0) coordinates.
    const afterReanchor = wb
      .rawData()
      .annotations.find((a) => a.id === annId)!;
    expect(afterReanchor.scope.kind).toBe("text");
    if (afterReanchor.scope.kind !== "text") throw new Error("expected text scope");
    expect(afterReanchor.scope.anchor.pageIndex).toBe(1);
    expect(afterReanchor.rectsStale).toBe(true);

    // The Reader would now re-measure the quote against the live text layer of
    // page 1 and persist the fresh rects. Simulate that measurement with a
    // hand-built stage whose span sits low on the page.
    const stage = buildStage(quote, { left: 8, top: 120, width: 70, height: 11 });
    const { recomputeRectsFromQuote } = await import("../pdf/highlight");
    const fresh = recomputeRectsFromQuote(stage, quote);
    expect(fresh.length).toBeGreaterThan(0);

    await wb.updateAnnotationRects(annId, fresh);

    const finalAnn = wb.rawData().annotations.find((a) => a.id === annId)!;
    if (finalAnn.scope.kind !== "text") throw new Error("expected text scope");
    // rectsStale is CLEARED (key omitted), and the rects now hold the new
    // vertical position (y ~ 120/200 = 0.6), not the draft's 0.1.
    expect(finalAnn.rectsStale).toBeUndefined();
    expect(finalAnn.scope.anchor.rects).toHaveLength(1);
    expect(finalAnn.scope.anchor.rects[0]!.y).toBeCloseTo(120 / 200, 5);
    expect(finalAnn.scope.anchor.rects[0]!.y).toBeGreaterThan(0.1);
  });

  it("updateAnnotationRects is a no-op for an empty rects array (keeps existing geometry)", async () => {
    const { Workbench } = await import("./workbench");
    const { InMemoryStorageAdapter } = await import("../test/InMemoryStorageAdapter");
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const src = await wb.importSource({
      title: "Doc.pdf",
      bytes: new TextEncoder().encode("BYTES"),
      versionHash: "v1",
      pageCount: 1,
      pageTexts: ["some page text"],
    });
    const view = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: {
        docId: src.id,
        sourceVersionHash: src.versionHash,
        pageIndex: 0,
        rects: [{ x: 0.2, y: 0.3, width: 0.4, height: 0.05 }],
        selectedText: "some page text",
        prefix: "",
        suffix: "",
      },
    });
    await wb.updateAnnotationRects(view.annotation.id, []);
    const ann = wb.rawData().annotations.find((a) => a.id === view.annotation.id)!;
    if (ann.scope.kind !== "text") throw new Error("expected text scope");
    // Unchanged: the empty-array call never clobbers the stored rects.
    expect(ann.scope.anchor.rects[0]!.x).toBeCloseTo(0.2, 5);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Bidirectional Spatial Basin Membership (§2.1(3)). An Observation Node
// belongs to EXACTLY the Subject basins that geometrically contain its [x, y].
// Drives the pure ellipse helper (pointInSubjectBasin) + the workbench
// membership-sync method (syncNodeBasinMembership) against the REAL Workbench
// (in-memory storage) — no DOM, nothing mocked. Basins A and B are given
// explicit geometry that overlaps so the A∩B lens exists.
// ---------------------------------------------------------------------------

describe("M13 Test 3 — Bidirectional Spatial Basin Membership (§2.1(3))", () => {
  it("moving a node into A assigns [A], into A∩B assigns [A,B], outside clears to []", async () => {
    const { Workbench } = await import("./workbench");
    const { InMemoryStorageAdapter } = await import("../test/InMemoryStorageAdapter");
    const { pointInSubjectBasin } = await import("../network");

    const wb = await Workbench.open(new InMemoryStorageAdapter());

    // Two Subjects with explicit basins that OVERLAP horizontally. A is centred
    // at x=-60, B at x=+60; both span rx=100 so the strip around x=0 lies inside
    // BOTH (the A∩B lens), while |x| ~ 150 lies inside only one, and far out
    // (x=500) lies inside neither.
    const catA = await wb.createCategory("A", "#4b5578");
    const catB = await wb.createCategory("B", "#b5653f");
    await wb.setSubjectBasin(catA.id, { x: -60, y: 0, rx: 100, ry: 100 });
    await wb.setSubjectBasin(catB.id, { x: 60, y: 0, rx: 100, ry: 100 });

    const basinA = wb.subjectBasin(catA.id)!;
    const basinB = wb.subjectBasin(catB.id)!;

    // The Observation Node (a subject Page — there is no distinct node record).
    const node = await wb.createSubjectPage("Observation");

    const membership = (): string[] =>
      wb
        .conceptGraph()
        .categories.filter((c) => c.memberPageIds.includes(node.id))
        .map((c) => String(c.categoryId))
        .sort();

    // Sanity: the pure helper agrees with the three regions.
    const inA = { x: -150, y: 0 };
    const inOverlap = { x: 0, y: 0 };
    const outside = { x: 500, y: 0 };
    expect(pointInSubjectBasin(inA, basinA)).toBe(true);
    expect(pointInSubjectBasin(inA, basinB)).toBe(false);
    expect(pointInSubjectBasin(inOverlap, basinA)).toBe(true);
    expect(pointInSubjectBasin(inOverlap, basinB)).toBe(true);
    expect(pointInSubjectBasin(outside, basinA)).toBe(false);
    expect(pointInSubjectBasin(outside, basinB)).toBe(false);

    // Into Basin A alone -> [A].
    await wb.syncNodeBasinMembership(node.id, inA);
    expect(membership()).toEqual([String(catA.id)]);

    // Into the A∩B overlap lens -> BOTH [A, B].
    await wb.syncNodeBasinMembership(node.id, inOverlap);
    expect(membership()).toEqual([String(catA.id), String(catB.id)].sort());

    // Out onto the bare paper desk -> cleared [].
    await wb.syncNodeBasinMembership(node.id, outside);
    expect(membership()).toEqual([]);
  });

  it("placeNodeInSubjects places a node inside a single basin and into the A∩B centroid for two", async () => {
    const { Workbench } = await import("./workbench");
    const { InMemoryStorageAdapter } = await import("../test/InMemoryStorageAdapter");
    const { pointInSubjectBasin } = await import("../network");
    const wb = await Workbench.open(new InMemoryStorageAdapter());

    const catA = await wb.createCategory("A", "#4b5578");
    const catB = await wb.createCategory("B", "#b5653f");
    await wb.setSubjectBasin(catA.id, { x: -60, y: 0, rx: 100, ry: 100 });
    await wb.setSubjectBasin(catB.id, { x: 60, y: 0, rx: 100, ry: 100 });
    const node = await wb.createSubjectPage("Observation");

    // Programmatic placement into BOTH: lands in the overlap centroid, so both
    // basins contain it and membership is [A, B].
    const placed = await wb.placeNodeInSubjects(node.id, [catA.id, catB.id]);
    expect(pointInSubjectBasin(placed, wb.subjectBasin(catA.id)!)).toBe(true);
    expect(pointInSubjectBasin(placed, wb.subjectBasin(catB.id)!)).toBe(true);
    const members = wb
      .conceptGraph()
      .categories.filter((c) => c.memberPageIds.includes(node.id))
      .map((c) => String(c.categoryId))
      .sort();
    expect(members).toEqual([String(catA.id), String(catB.id)].sort());
  });
});

// ---------------------------------------------------------------------------
// Test 6: Promote Note/Highlight to Observation Node (§2.1(1)).
// wb.promoteAnnotationToNode(annotationId) creates an Observation Node (a
// subject Page — there is no distinct node record type) that CITES the promoted
// annotation via a provenance-bearing EvidenceInstance. Driven against the REAL
// Workbench (in-memory storage), nothing mocked.
// ---------------------------------------------------------------------------

describe("M13 Test 6 — Promote Note/Highlight to Observation Node (§2.1(1))", () => {
  it("creates an Observation Node citing the promoted annotation", async () => {
    const { Workbench } = await import("./workbench");
    const { InMemoryStorageAdapter } = await import("../test/InMemoryStorageAdapter");
    const wb = await Workbench.open(new InMemoryStorageAdapter());

    const quote = "neural correlates of sustained attention in the prefrontal cortex";
    const src = await wb.importSource({
      title: "Attention.pdf",
      bytes: new TextEncoder().encode("ATTENTION-BYTES"),
      versionHash: "v1",
      pageCount: 1,
      pageTexts: [quote],
    });
    const view = await wb.commitTextAnnotation({
      sourceId: src.id,
      anchor: {
        docId: src.id,
        sourceVersionHash: src.versionHash,
        pageIndex: 0,
        rects: [{ x: 0.1, y: 0.1, width: 0.6, height: 0.02 }],
        selectedText: quote,
        prefix: "",
        suffix: "",
      },
    });
    const annId = view.annotation.id;

    const pagesBefore = wb.rawData().pages.length;
    const { page, evidence } = await wb.promoteAnnotationToNode(annId);

    // A new Observation Node (subject Page) was created.
    const data = wb.rawData();
    expect(data.pages.length).toBe(pagesBefore + 1);
    const created = data.pages.find((p) => p.id === page.id)!;
    expect(created).toBeTruthy();
    expect(created.kind).toBe("subject");

    // The node CITES the promoted annotation: an EvidenceInstance links the two.
    expect(evidence.annotationId).toBe(annId);
    expect(evidence.destinationPageId).toBe(page.id);
    const link = data.evidenceInstances.find(
      (e) => e.annotationId === annId && e.destinationPageId === page.id,
    );
    expect(link).toBeTruthy();

    // The (annotation, page) pair derives to a solid citation (cited subject).
    const cited = wb.citedSubjectPagesForAnnotation(annId).map((id) => String(id));
    expect(cited).toContain(String(page.id));
  });
});

// ---------------------------------------------------------------------------
// Test 4: Single Subject Basin Click vs. Overlap Click (§2.2, P3/P4).
//
// Clicking inside Basin A ALONE (>24px from any node) opens Subject A's Page
// (`subject-basin-page`, P4); clicking inside the A∩B∩C overlap zone opens ONE
// unified `subject-intersection-page` (P3) whose Intersection Aspect Selector
// Bar carries the core pill (A∩B∩C) and each pairwise sub-overlap (A∩B, B∩C,
// A∩C). Driven against the REAL Workbench (in-memory storage) via the pure
// hitTestCanvas + the workbench open methods; a render test asserts the testids
// + pills on the SubjectEditor surface.
// ---------------------------------------------------------------------------

describe("M13 Test 4 — Single Subject Basin Click vs. Overlap Click (§2.2)", () => {
  // React act-environment render harness (shared shape with the m8 render test).
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

  async function renderInto(
    node: unknown,
  ): Promise<{ container: HTMLElement; unmount: () => void }> {
    const { act, createElement } = await import("react");
    void createElement;
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(node as Parameters<typeof root.render>[0]);
    });
    return {
      container,
      unmount: () => {
        act(() => root.unmount());
        container.remove();
      },
    };
  }

  it("routes a single-basin click to the basin page and an overlap click to ONE intersection page", async () => {
    const { Workbench } = await import("./workbench");
    const { InMemoryStorageAdapter } = await import("../test/InMemoryStorageAdapter");
    const { buildScene, hitTestCanvas } = await import("../network");

    const wb = await Workbench.open(new InMemoryStorageAdapter());

    // Three Subjects whose basins all overlap near the origin so an A∩B∩C lens
    // exists. A far-left point lies in A alone; the near-origin point lies in
    // all three. Explicit basins keep the geometry deterministic.
    const catA = await wb.createCategory("Alpha", "#4b5578");
    const catB = await wb.createCategory("Beta", "#b5653f");
    const catC = await wb.createCategory("Gamma", "#5f7a52");
    await wb.setSubjectBasin(catA.id, { x: -40, y: 0, rx: 100, ry: 100 });
    await wb.setSubjectBasin(catB.id, { x: 40, y: 0, rx: 100, ry: 100 });
    await wb.setSubjectBasin(catC.id, { x: 0, y: 40, rx: 100, ry: 100 });

    // Build the live scene + the basins the hit-tester tests (scene squircle
    // bounds tagged with category ids — the empty Subjects render basin-driven).
    const scene = buildScene({
      nodes: wb.conceptGraph().nodes.map((n) => ({
        pageId: n.pageId,
        title: n.title,
        hidden: n.hidden,
        position: n.position,
      })),
      links: [],
      categories: wb.conceptGraph().categories.map((c) => ({
        categoryId: c.categoryId,
        name: c.name,
        colorCode: c.colorCode,
        memberPageIds: c.memberPageIds,
        ...(c.basin != null ? { basin: c.basin } : {}),
      })),
    });
    const basins = scene.squircles.map((sq) => ({
      categoryId: sq.categoryId,
      basin: { x: sq.bounds.cx, y: sq.bounds.cy, rx: sq.bounds.rx, ry: sq.bounds.ry },
    }));

    // A point in Basin A alone (far left) -> P4 single basin.
    const single = hitTestCanvas(scene, { x: -130, y: 0 }, { basins, pickRadius: 24 });
    expect(single.kind).toBe("basin");
    if (single.kind !== "basin") throw new Error("expected P4 basin");
    expect(single.subjectId).toBe(String(catA.id));

    // A point in the A∩B∩C overlap (near origin) -> P3 overlap with all three.
    const overlap = hitTestCanvas(scene, { x: 0, y: 20 }, { basins, pickRadius: 24 });
    expect(overlap.kind).toBe("overlap");
    if (overlap.kind !== "overlap") throw new Error("expected P3 overlap");
    expect([...overlap.subjectIds].sort()).toEqual(
      [String(catA.id), String(catB.id), String(catC.id)].sort(),
    );

    // P4: the single-basin click opens Subject A's overarching Subject Page.
    const basinPageId = await wb.getOrCreateSubjectBasinPage(single.subjectId as never);
    expect(wb.isSubjectBasinPage(basinPageId)).toBe(true);
    expect(wb.snapshot().openSubjectPageId).toBe(basinPageId);
    expect(wb.openPageKind()).toBe("subject-basin");

    // P3: the overlap click opens ONE unified Subject-intersection page, and
    // clicking the SAME overlap again reopens the SAME page (dedupe by key).
    const interPageId = await wb.getOrCreateSubjectIntersectionPage(
      overlap.subjectIds as never,
    );
    const pagesAfterFirst = wb.rawData().pages.length;
    const interPageIdAgain = await wb.getOrCreateSubjectIntersectionPage(
      overlap.subjectIds as never,
    );
    expect(interPageIdAgain).toBe(interPageId);
    expect(wb.rawData().pages.length).toBe(pagesAfterFirst); // no duplicate page
    expect(wb.isSubjectIntersectionPage(interPageId)).toBe(true);
    expect(wb.openPageKind()).toBe("subject-intersection");

    // The aspect-bar data: a CORE pill spanning all three + three PAIRWISE pills
    // (A∩B, B∩C, A∩C in some order).
    const aspects = wb.intersectionAspects()!;
    expect(aspects).toBeTruthy();
    expect(aspects.corePill.kind).toBe("core");
    expect(aspects.corePill.subjectIds.map(String).sort()).toEqual(
      [String(catA.id), String(catB.id), String(catC.id)].sort(),
    );
    const names = new Map(
      [catA, catB, catC].map((c) => [String(c.id), c.name] as const),
    );
    // The core pill label is the three names joined by ∩.
    expect(aspects.corePill.label.split(" ∩ ").sort()).toEqual(
      ["Alpha", "Beta", "Gamma"].sort(),
    );
    // Exactly three pairwise pills, each a distinct unordered pair of Subjects.
    expect(aspects.pairwisePills).toHaveLength(3);
    const pairKeys = aspects.pairwisePills
      .map((p) => p.subjectIds.map(String).sort().join("|"))
      .sort();
    const expectedPairs = [
      [String(catA.id), String(catB.id)].sort().join("|"),
      [String(catB.id), String(catC.id)].sort().join("|"),
      [String(catA.id), String(catC.id)].sort().join("|"),
    ].sort();
    expect(pairKeys).toEqual(expectedPairs);
    // Each pairwise label joins the two subjects' names.
    for (const pill of aspects.pairwisePills) {
      const expectedLabel = pill.subjectIds.map((id) => names.get(String(id))!).join(" ∩ ");
      expect(pill.label).toBe(expectedLabel);
    }
  });

  it("renders the subject-intersection-page surface + aspect-bar pills (SubjectEditor)", async () => {
    const { Workbench } = await import("./workbench");
    const { InMemoryStorageAdapter } = await import("../test/InMemoryStorageAdapter");
    const { createElement } = await import("react");
    const { SubjectEditor } = await import("./SubjectEditor");

    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const catA = await wb.createCategory("Alpha", "#4b5578");
    const catB = await wb.createCategory("Beta", "#b5653f");
    const catC = await wb.createCategory("Gamma", "#5f7a52");
    const interPageId = await wb.getOrCreateSubjectIntersectionPage([
      catA.id,
      catB.id,
      catC.id,
    ]);

    const { container, unmount } = await renderInto(
      createElement(SubjectEditor, {
        wb,
        pageId: interPageId,
        onFollowSource: () => undefined,
        onClose: () => undefined,
        bump: () => undefined,
      }),
    );
    try {
      expect(
        container.querySelector('[data-testid="subject-intersection-page"]'),
      ).not.toBeNull();
      const bar = container.querySelector(
        '[data-testid="subject-intersection-aspect-bar"]',
      );
      expect(bar).not.toBeNull();
      const pills = Array.from(
        container.querySelectorAll('[data-testid="aspect-pill"]'),
      ).map((el) => el.textContent ?? "");
      // One core pill (all three) + three pairwise pills = four pills total.
      expect(pills.length).toBe(4);
      const core = pills.find((p) => p.split(" ∩ ").length === 3);
      expect(core).toBeTruthy();
      expect(core!.split(" ∩ ").sort()).toEqual(["Alpha", "Beta", "Gamma"].sort());
      // Pairwise labels are ordered by the (sorted) subject ids, so normalize
      // each to a name-sorted key before comparing the SET of pairs.
      const pairwise = pills
        .filter((p) => p.split(" ∩ ").length === 2)
        .map((p) => p.split(" ∩ ").sort().join("∩"))
        .sort();
      expect(pairwise).toEqual(
        [
          ["Alpha", "Beta"].sort().join("∩"),
          ["Alpha", "Gamma"].sort().join("∩"),
          ["Beta", "Gamma"].sort().join("∩"),
        ].sort(),
      );
      // The relationship-kind selector offers the UI-local vocabulary.
      const select = bar!.querySelector(
        '[data-testid="aspect-relationship-kind"]',
      ) as HTMLSelectElement | null;
      expect(select).not.toBeNull();
      const options = Array.from(select!.options).map((o) => o.value).sort();
      expect(options).toEqual(["bridges", "contrasts", "relates", "synthesizes"]);
    } finally {
      unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 5: Node & Hub Top-2 Source Ranking + Switcher (§2.2, P1/P2).
//
// A Node (and a Node-Intersection Hub) citing highlights from 3 PDFs — Paper A:
// 4 highlights, Paper B: 2, Paper C: 1 — ranks the sources DESC and opens the
// Node/Hub Page alongside the TOP 2 (Paper A + Paper B). The Reader renders the
// `workspace-source-switcher` pill offering to swap in Paper C (1). Driven
// against the REAL Workbench; a render test asserts the switcher pill.
// ---------------------------------------------------------------------------

describe("M13 Test 5 — Node & Hub Top-2 Source Ranking + Switcher (§2.2)", () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

  /** Import a source with `count` distinct cited highlights into `pageId`. */
  async function citeHighlights(
    wb: WorkbenchType,
    title: string,
    versionHash: string,
    count: number,
    pageId: string,
  ): Promise<string> {
    const pageTexts = Array.from(
      { length: count },
      (_, i) => `passage ${i} of ${title} to be highlighted and cited into the node`,
    );
    const src = await wb.importSource({
      title,
      bytes: new TextEncoder().encode(`${versionHash}-BYTES`),
      versionHash,
      pageCount: count,
      pageTexts,
    });
    for (let i = 0; i < count; i++) {
      const view = await wb.commitTextAnnotation({
        sourceId: src.id,
        anchor: {
          docId: src.id,
          sourceVersionHash: src.versionHash,
          pageIndex: i,
          rects: [{ x: 0.1, y: 0.1, width: 0.6, height: 0.02 }],
          selectedText: pageTexts[i]!,
          prefix: "",
          suffix: "",
        },
      });
      await wb.insertEvidenceIntoPage(view.annotation.id, pageId as never, {
        pos: null,
      });
    }
    return src.id;
  }

  it("ranks a Node's cited sources DESC and opens the top 2 (Paper A, Paper B)", async () => {
    const { Workbench } = await import("./workbench");
    const { InMemoryStorageAdapter } = await import("../test/InMemoryStorageAdapter");
    const wb = await Workbench.open(new InMemoryStorageAdapter());

    const node = await wb.createSubjectPage("Observation");
    const idA = await citeHighlights(wb, "Paper A", "pa", 4, node.id);
    const idB = await citeHighlights(wb, "Paper B", "pb", 2, node.id);
    const idC = await citeHighlights(wb, "Paper C", "pc", 1, node.id);

    const ranked = wb.topCitedSourcesForNode(node.id);
    expect(ranked.map((r) => r.sourceId)).toEqual([idA, idB, idC]);
    expect(ranked.map((r) => r.count)).toEqual([4, 2, 1]);

    // Opening the Node workspace opens the top-2 sources together + the page.
    const opened = wb.openNodeWorkspace(node.id);
    expect(opened).toEqual([idA, idB]);
    const snap = wb.snapshot();
    expect([...snap.openSourceIds].sort()).toEqual([idA, idB].sort());
    expect(snap.openSubjectPageId).toBe(node.id);
    expect(snap.openPageKind).toBe("node");
    // EvidenceLines stay active in the workspace.
    expect(snap.workspaceLayout.linesVisible).toBe(true);
  });

  it("aggregates a Hub's cited sources across the connected nodes and opens the top 2", async () => {
    const { Workbench } = await import("./workbench");
    const { InMemoryStorageAdapter } = await import("../test/InMemoryStorageAdapter");
    const wb = await Workbench.open(new InMemoryStorageAdapter());

    // Two Observation Nodes joined by a hub; the papers are cited across BOTH:
    // Paper A 4 (3 into node1 + 1 into node2), Paper B 2, Paper C 1 in total.
    const node1 = await wb.createSubjectPage("Node 1");
    const node2 = await wb.createSubjectPage("Node 2");
    const idA1 = await citeHighlights(wb, "Paper A", "pa", 3, node1.id);
    const idA2 = await citeHighlights(wb, "Paper A rev", "pa2", 1, node2.id);
    const idB = await citeHighlights(wb, "Paper B", "pb", 2, node1.id);
    const idC = await citeHighlights(wb, "Paper C", "pc", 1, node2.id);
    void idA1;
    void idA2;
    void idB;
    void idC;

    const rel = await wb.createRelationship([node1.id, node2.id], "relates", "bridge");
    const ranked = wb.topCitedSourcesForRelationship(rel.id);
    // Aggregated counts across both nodes' pages: A-variants 3 and 1 are
    // distinct sources, so Paper A(3) + Paper B(2) are the top two.
    expect(ranked[0]!.count).toBe(3);
    expect(ranked[0]!.sourceId).toBe(idA1);
    expect(ranked[1]!.count).toBe(2);
    expect(ranked[1]!.sourceId).toBe(idB);

    const openedPageId = await wb.openRelationshipWorkspace(rel.id);
    const snap = wb.snapshot();
    expect(snap.openSubjectPageId).toBe(openedPageId);
    expect([...snap.openSourceIds].sort()).toEqual([idA1, idB].sort());
    expect(snap.openPageKind).toBe("node-intersection");
    expect(snap.workspaceLayout.linesVisible).toBe(true);
  });

  it("renders the workspace-source-switcher pill offering to swap in Paper C (Reader)", async () => {
    const { act, createElement } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { Workbench } = await import("./workbench");
    const { InMemoryStorageAdapter } = await import("../test/InMemoryStorageAdapter");
    const { Reader } = await import("./Reader");

    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const node = await wb.createSubjectPage("Observation");
    const idA = await citeHighlights(wb, "Paper A", "pa", 4, node.id);
    const idB = await citeHighlights(wb, "Paper B", "pb", 2, node.id);
    const idC = await citeHighlights(wb, "Paper C", "pc", 1, node.id);
    const opened = wb.openNodeWorkspace(node.id);
    expect(opened).toEqual([idA, idB]);

    // The Reader's EvidenceLines effect constructs a ResizeObserver, which
    // jsdom lacks; provide a no-op stub so the render completes.
    const prevRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const snap = wb.snapshot();
    await act(async () => {
      root.render(
        createElement(Reader, {
          wb,
          openSourceIds: snap.openSourceIds,
          openSubjectPageId: snap.openSubjectPageId,
          suppressMotion: true,
          highlightsTabOpen: false,
          onToggleTab: () => undefined,
          onToggleMotion: () => undefined,
          onBackToLibrary: () => undefined,
          bump: () => undefined,
        }),
      );
    });
    try {
      const switcher = container.querySelector(
        '[data-testid="workspace-source-switcher"]',
      );
      expect(switcher).not.toBeNull();
      // The cited sources are listed with their counts (Paper A(4), B(2), C(1)).
      const citedEls = Array.from(
        container.querySelectorAll('[data-testid="source-switcher-cited"]'),
      );
      const citedIds = citedEls.map((el) => el.getAttribute("data-source-id"));
      expect(citedIds).toEqual([idA, idB, idC]);
      // Paper C is NOT open and is offered under "Swap to:".
      const swapBtns = Array.from(
        container.querySelectorAll('[data-testid="source-switcher-swap"]'),
      );
      const swapIds = swapBtns.map((el) => el.getAttribute("data-source-id"));
      expect(swapIds).toEqual([idC]);

      // Clicking "Swap to: Paper C" brings Paper C into a pane (3rd+ PDF).
      await act(async () => {
        (swapBtns[0] as HTMLElement).dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(wb.snapshot().openSourceIds).toContain(idC);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      if (prevRO === undefined) {
        delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
      } else {
        (globalThis as { ResizeObserver?: unknown }).ResizeObserver = prevRO;
      }
    }
  });
});
