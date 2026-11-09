/**
 * Imperative test API exposed on `window.__ito` for the Playwright runtime
 * suite (spec section 24). It drives the SAME Workbench the UI uses and the
 * SAME rendered pdf.js text layers in the DOM — it mocks nothing. The helpers
 * exist so tests can perform deterministic real-text selections (find a glyph
 * offset, build a DOM Range over the live text nodes, apply it to the window
 * Selection) and read back real state.
 *
 * Selecting via this API dispatches a real `mouseup` on the pane so the app's
 * ordinary selection→toolbar path runs exactly as a human's would.
 */

import type {
  AnnotationId,
  PageId,
  RelationshipId,
  RelationshipKind,
  SourceId,
} from "../model";
import {
  hydrateState,
  outline,
  evidenceInOrder,
  compositionStatsFromJson,
  type DocumentJson,
} from "../editor";
import type { Workbench } from "./workbench";

interface ItoTestApi {
  /** Current open source ids. */
  openSourceIds(): string[];
  /** Page text of a rendered page (0-based index) within the first/given pane. */
  pageText(pageIndex: number, sourceId?: string): string;
  /** Select [needle] in the given page's live text layer and fire mouseup. */
  selectText(needle: string, pageIndex?: number, sourceId?: string): boolean;
  /** Current annotation count for a source (or all). */
  annotationCount(sourceId?: string): number;
  /** Derived reference status for an (annotation, destination) pair. */
  referenceStatus(annotationId: string, destinationPageId: string): string;
  /** Create a subject page and return its id (test setup convenience). */
  createSubject(title: string): Promise<string>;
  /** Open a subject page for composition alongside the reader. */
  openSubject(pageId: string): void;
  /** The currently open subject page id, or null. */
  openSubjectId(): string | null;
  /** Linear outline of a subject page composition (writing + ⟦evidence⟧). */
  subjectOutline(pageId: string): string[];
  /** Evidence-node ids in exact composition order for a subject page. */
  subjectEvidenceOrder(pageId: string): string[];
  /** The id of the first annotation for the first source (test convenience). */
  firstAnnotationId(): string | null;
  /** Structural detail counts for a subject page composition. */
  subjectStats(pageId: string): {
    blockCount: number;
    paragraphCount: number;
    headingCount: number;
    quoteCount: number;
    sourceCount: number;
  };
  /** Count of evidence instances whose destination is the given page. */
  pageEvidenceCount(pageId: string): number;
  /** Resolve the source-return state for an evidence instance. */
  evidenceResolution(evidenceId: string): string;
  /** The ordered open source ids, the flex-grow weights per pane slot. */
  paneWidths(): Record<string, number>;
  /** Whether passage-to-evidence lines are currently set visible. */
  linesVisible(): boolean;
  /** Toggle passage-to-evidence line visibility (presentation only). */
  setLinesVisible(visible: boolean): void;
  /** The passage-to-evidence line DATA (independent of whether drawn). */
  passageLineData(): {
    evidenceId: string;
    sourceId: string;
    sourcePageIndex: number;
  }[];
  /** The active library category scope (or null for all). */
  categoryScope(): string | null;
  /** Set the active library category scope. */
  setCategoryScope(category: string | null): void;
  /** Switch a reader pane from one source to another (third-paper swap). */
  switchReaderPane(fromSourceId: string, toSourceId: string): void;
  /** All distinct library category names. */
  categories(): string[];
  /** Count of Page + Relationship + Category records (invariant probe). */
  graphRecordCount(): { pages: number; relationships: number; categories: number };
  /** The derived concept-network graph snapshot (nodes/links/categories). */
  conceptGraph(): {
    nodes: { pageId: string; title: string; hidden: boolean }[];
    links: {
      relationshipId: string;
      endpointPageIds: string[];
      topology: string;
      blendColor: string;
      hidden: boolean;
    }[];
    categories: { categoryId: string; name: string; colorCode: string }[];
  };
  /** Count of non-hidden pages participating in the network (§3.4). */
  activeNodeCount(): number;
  /** Whether the 3D presentation is unlocked (activeNodeCount >= 35). */
  is3DUnlocked(): boolean;
  /** Set the active-3D flag (presentation only). */
  setActive3D(on: boolean): Promise<void>;
  /** The transient N06 "not connected yet" placeholder for a source id. */
  nodePlaceholderFor(sourceId: string): { sourceId: string; title: string; transient: boolean };
  /** Create a category with a watercolor color (test setup convenience). */
  createCategory(name: string, colorCode?: string): Promise<string>;
  /** Create a relationship across N>=2 endpoints; returns the relationship id. */
  createRelationship(endpointPageIds: string[], kind?: string, label?: string): Promise<string>;
  /** Hide a node (presentation only; never deletes the Page). */
  hideNode(pageId: string): Promise<void>;
  /** Hide a relationship (presentation only; never deletes the Relationship). */
  hideRelationship(relationshipId: string): Promise<void>;
  /** Test-only: force the next N persist() calls to fail (R12). */
  forceNextSaveFailures(count: number): void;
  /** Test-only: drift a source's stored version hash to trigger A17 mismatch. */
  forceSourceVersionDrift(sourceId: string): Promise<void>;
  /** Raw counts for assertions. */
  counts(): {
    sources: number;
    annotations: number;
    evidence: number;
    associations: number;
    pages: number;
    relationships: number;
    categories: number;
  };
}

function findPane(sourceId?: string): HTMLElement | null {
  if (sourceId) {
    return document.querySelector(`[data-testid="source-pane"][data-source-id="${sourceId}"]`);
  }
  return document.querySelector('[data-testid="source-pane"]');
}

function findPageContainer(pane: HTMLElement, pageIndex: number): HTMLElement | null {
  const mount = pane.querySelector('[data-testid="pdf-mount"]');
  if (!mount) return null;
  return mount.querySelector(`.pdf-page[data-page-index="${pageIndex}"]`);
}

function textLayerOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector(".textLayer");
}

/** Flatten a text layer to a string + per-node offset spans (live DOM). */
function glyphMap(layer: HTMLElement): { text: string; runs: { node: Text; start: number; end: number }[] } {
  const runs: { node: Text; start: number; end: number }[] = [];
  let text = "";
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode();
  while (n) {
    const node = n as Text;
    runs.push({ node, start: text.length, end: text.length + node.data.length });
    text += node.data;
    n = walker.nextNode();
  }
  return { text, runs };
}

export function installTestApi(wb: Workbench, bump: () => void): void {
  const api: ItoTestApi = {
    openSourceIds() {
      return [...wb.snapshot().openSourceIds];
    },
    pageText(pageIndex, sourceId) {
      const pane = findPane(sourceId);
      if (!pane) return "";
      const container = findPageContainer(pane, pageIndex);
      if (!container) return "";
      const layer = textLayerOf(container);
      return layer ? glyphMap(layer).text : "";
    },
    selectText(needle, pageIndex = 0, sourceId) {
      const pane = findPane(sourceId);
      if (!pane) return false;
      const container = findPageContainer(pane, pageIndex);
      if (!container) return false;
      const layer = textLayerOf(container);
      if (!layer) return false;
      const map = glyphMap(layer);
      const start = map.text.indexOf(needle);
      if (start < 0) return false;
      const end = start + needle.length;
      const startRun = map.runs.find((r) => start >= r.start && start < r.end);
      const endRun = map.runs.find((r) => end > r.start && end <= r.end);
      if (!startRun || !endRun) return false;
      const range = document.createRange();
      range.setStart(startRun.node, start - startRun.start);
      range.setEnd(endRun.node, end - endRun.start);
      const selection = window.getSelection();
      if (!selection) return false;
      selection.removeAllRanges();
      selection.addRange(range);
      // Fire the real mouseup the app listens for.
      pane.querySelector('[data-testid="pdf-mount"]')?.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true }),
      );
      return true;
    },
    annotationCount(sourceId) {
      const data = wb.rawData();
      return sourceId
        ? data.annotations.filter((a) => a.sourceId === (sourceId as SourceId)).length
        : data.annotations.length;
    },
    referenceStatus(annotationId, destinationPageId) {
      return wb.referenceStatus(annotationId as AnnotationId, destinationPageId as PageId);
    },
    async createSubject(title) {
      const page = await wb.createSubjectPage(title);
      bump();
      return page.id;
    },
    openSubject(pageId) {
      wb.openSubjectPage(pageId as PageId);
      bump();
    },
    openSubjectId() {
      return wb.snapshot().openSubjectPageId;
    },
    subjectOutline(pageId) {
      const json = wb.subjectDocJson(pageId as PageId) as DocumentJson;
      return outline(hydrateState(json).doc);
    },
    subjectEvidenceOrder(pageId) {
      const json = wb.subjectDocJson(pageId as PageId) as DocumentJson;
      return evidenceInOrder(hydrateState(json).doc).map((e) => e.attrs.evidenceId);
    },
    firstAnnotationId() {
      const d = wb.rawData();
      return d.annotations[0]?.id ?? null;
    },
    subjectStats(pageId) {
      const json = wb.subjectDocJson(pageId as PageId) as DocumentJson;
      const s = compositionStatsFromJson(json);
      return {
        blockCount: s.blockCount,
        paragraphCount: s.paragraphCount,
        headingCount: s.headingCount,
        quoteCount: s.quoteCount,
        sourceCount: s.sourceCount,
      };
    },
    pageEvidenceCount(pageId) {
      return wb
        .rawData()
        .evidenceInstances.filter((e) => e.destinationPageId === (pageId as PageId)).length;
    },
    evidenceResolution(evidenceId) {
      const resolved = wb.resolveEvidenceSource(evidenceId);
      return resolved ? resolved.resolution.kind : "missing";
    },
    paneWidths() {
      return { ...wb.snapshot().workspaceLayout.paneWidths };
    },
    linesVisible() {
      return wb.linesVisible();
    },
    setLinesVisible(visible) {
      wb.setLinesVisible(visible);
      bump();
    },
    passageLineData() {
      return wb.passageEvidenceLines().map((l) => ({
        evidenceId: l.evidenceId,
        sourceId: l.sourceId,
        sourcePageIndex: l.sourcePageIndex,
      }));
    },
    categoryScope() {
      return wb.categoryScope();
    },
    setCategoryScope(category) {
      wb.setCategoryScope(category);
      bump();
    },
    switchReaderPane(fromSourceId, toSourceId) {
      wb.switchReaderPane(fromSourceId as SourceId, toSourceId as SourceId);
      bump();
    },
    categories() {
      return wb.categories();
    },
    graphRecordCount() {
      const d = wb.rawData();
      return {
        pages: d.pages.length,
        relationships: d.relationships.length,
        categories: d.categories.length,
      };
    },
    conceptGraph() {
      const g = wb.conceptGraph();
      return {
        nodes: g.nodes.map((n) => ({
          pageId: n.pageId,
          title: n.title,
          hidden: n.hidden,
        })),
        links: g.links.map((l) => ({
          relationshipId: l.relationshipId,
          endpointPageIds: [...l.endpointPageIds],
          topology: l.topology,
          blendColor: l.blendColor,
          hidden: l.hidden,
        })),
        categories: g.categories.map((c) => ({
          categoryId: c.categoryId,
          name: c.name,
          colorCode: c.colorCode,
        })),
      };
    },
    activeNodeCount() {
      return wb.activeNodeCount();
    },
    is3DUnlocked() {
      return wb.is3DUnlocked();
    },
    async setActive3D(on) {
      await wb.setActive3D(on);
      bump();
    },
    nodePlaceholderFor(sourceId) {
      return wb.nodePlaceholderFor(sourceId);
    },
    async createCategory(name, colorCode) {
      const category = await wb.createCategory(name, colorCode);
      bump();
      return category.id;
    },
    async createRelationship(endpointPageIds, kind, label) {
      const rel = await wb.createRelationship(
        endpointPageIds as PageId[],
        (kind as RelationshipKind | undefined) ?? "relates",
        label ?? "",
      );
      bump();
      return rel.id;
    },
    async hideNode(pageId) {
      await wb.hideNode(pageId as PageId);
      bump();
    },
    async hideRelationship(relationshipId) {
      await wb.hideRelationship(relationshipId as RelationshipId);
      bump();
    },
    forceNextSaveFailures(count) {
      wb.forceNextSaveFailures(count);
    },
    async forceSourceVersionDrift(sourceId) {
      await wb.forceSourceVersionDrift(sourceId as SourceId);
      bump();
    },
    counts() {
      const d = wb.rawData();
      return {
        sources: d.sources.length,
        annotations: d.annotations.length,
        evidence: d.evidenceInstances.length,
        associations: d.subjectAssociations.length,
        pages: d.pages.length,
        relationships: d.relationships.length,
        categories: d.categories.length,
      };
    },
  };

  (window as unknown as { __ito: ItoTestApi }).__ito = api;
  document.body.setAttribute("data-ito-ready", "true");
}
