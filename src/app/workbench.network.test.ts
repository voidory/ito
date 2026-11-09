/**
 * FEAT-003 (M2) — concept-network domain tests (Vitest). These exercise, through
 * the real Workbench + the in-memory StorageAdapter, the typed/persisted
 * foundation the later rendering features (FEAT-004/005/006) build on:
 *
 *  - a Category persists its watercolor `colorCode`;
 *  - a Relationship with 2 endpoints (lens) and with >=3 endpoints (star-hub)
 *    both persist and ROUND-TRIP through storage (reopen restores them);
 *  - a Relationship's `blendColor` is DERIVED from the endpoint categories'
 *    colors (watercolor multiply, §3.2), not hand-stored;
 *  - hiding a node / relationship is PRESENTATION ONLY: it leaves
 *    pages.length / relationships.length unchanged (A09-M2, non-destructive);
 *  - the §3.4 density reward flips at exactly the 35-node threshold;
 *  - the N06 transient placeholder returns transient:true and creates ZERO
 *    Page/Relationship/Category records.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { THREE_D_UNLOCK_THRESHOLD, Workbench } from "./workbench";
import {
  relationshipEndpoints,
  type BrainId,
  type PageId,
} from "../model";
import { blendColors } from "../network";

async function makePages(wb: Workbench, titles: readonly string[]): Promise<PageId[]> {
  const ids: PageId[] = [];
  for (const t of titles) {
    const page = await wb.createSubjectPage(t);
    ids.push(page.id);
  }
  return ids;
}

describe("FEAT-003 — categories carry a watercolor colorCode", () => {
  let wb: Workbench;
  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
  });

  it("stores the colorCode on the created Category", async () => {
    const category = await wb.createCategory("Theory", "#ff8800");
    expect(category.colorCode).toBe("#ff8800");
    const stored = wb.rawData().categories.find((c) => c.id === category.id);
    expect(stored?.colorCode).toBe("#ff8800");
  });

  it("surfaces the color through the derived conceptGraph", async () => {
    await wb.createCategory("Theory", "#ff8800");
    const g = wb.conceptGraph();
    expect(g.categories).toHaveLength(1);
    expect(g.categories[0]!.colorCode).toBe("#ff8800");
  });
});

describe("FEAT-003 — relationship round-trip (N=2 lens and N>=3 star)", () => {
  let storage: InMemoryStorageAdapter;
  let wb: Workbench;
  let brainId: BrainId;

  beforeEach(async () => {
    storage = new InMemoryStorageAdapter();
    wb = await Workbench.open(storage);
    brainId = wb.snapshot().brainId;
  });

  it("persists a 2-endpoint relationship as a lens and round-trips it", async () => {
    const [a, b] = await makePages(wb, ["A", "B"]);
    const rel = await wb.createRelationship([a!, b!], "supports", "because");
    expect(relationshipEndpoints(rel)).toEqual([a, b]);
    // Degenerate from/to remain filled for back-compat.
    expect(rel.fromPageId).toBe(a);
    expect(rel.toPageId).toBe(b);

    const reopened = await Workbench.open(storage, brainId);
    const g = reopened.conceptGraph();
    expect(g.links).toHaveLength(1);
    expect(g.links[0]!.endpointPageIds).toEqual([a, b]);
    expect(g.links[0]!.topology).toBe("lens");
  });

  it("persists an N>=3 endpoint relationship as a star and round-trips it", async () => {
    const [a, b, c, d] = await makePages(wb, ["A", "B", "C", "D"]);
    const rel = await wb.createRelationship([a!, b!, c!, d!], "relates", "cluster");
    expect(relationshipEndpoints(rel)).toEqual([a, b, c, d]);

    const reopened = await Workbench.open(storage, brainId);
    const g = reopened.conceptGraph();
    expect(g.links).toHaveLength(1);
    expect(g.links[0]!.endpointPageIds).toEqual([a, b, c, d]);
    expect(g.links[0]!.topology).toBe("star");
  });

  it("rejects a relationship with fewer than 2 endpoints", async () => {
    const [a] = await makePages(wb, ["A"]);
    await expect(wb.createRelationship([a!])).rejects.toThrow(/at least 2/);
  });
});

describe("FEAT-003 — blendColor is derived from endpoint category colors", () => {
  let wb: Workbench;
  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
  });

  it("multiplies the distinct category colors spanning the endpoints (§3.2)", async () => {
    const [a, b] = await makePages(wb, ["A", "B"]);
    const red = await wb.createCategory("Red", "#ff0000", [a!]);
    const blue = await wb.createCategory("Blue", "#0000ff", [b!]);
    const rel = await wb.createRelationship([a!, b!]);

    const expected = blendColors([
      red.colorCode ?? "#ffffff",
      blue.colorCode ?? "#ffffff",
    ]);
    expect(rel.blendColor).toBe(expected);
    // red (#ff0000) * blue (#0000ff) multiply = black on every channel.
    expect(rel.blendColor).toBe("#000000");
  });

  it("falls back to white when no category spans the endpoints", async () => {
    const [a, b] = await makePages(wb, ["A", "B"]);
    const rel = await wb.createRelationship([a!, b!]);
    expect(rel.blendColor).toBe("#ffffff");
  });
});

describe("FEAT-003 — hiding a node/relationship is presentation-only", () => {
  let wb: Workbench;
  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
  });

  it("hiding a node leaves pages.length unchanged (non-destructive, A09-M2)", async () => {
    const [a, b] = await makePages(wb, ["A", "B"]);
    await wb.createRelationship([a!, b!]);
    const before = wb.rawData().pages.length;

    await wb.hideNode(a!);

    expect(wb.rawData().pages.length).toBe(before);
    const g = wb.conceptGraph();
    expect(g.nodes.find((n) => n.pageId === a)!.hidden).toBe(true);
    // The durable Page record still exists.
    expect(wb.rawData().pages.some((p) => p.id === a)).toBe(true);
  });

  it("hiding a relationship leaves relationships.length unchanged", async () => {
    const [a, b] = await makePages(wb, ["A", "B"]);
    const rel = await wb.createRelationship([a!, b!]);
    const before = wb.rawData().relationships.length;

    await wb.hideRelationship(rel.id);

    expect(wb.rawData().relationships.length).toBe(before);
    const g = wb.conceptGraph();
    expect(g.links.find((l) => l.relationshipId === rel.id)!.hidden).toBe(true);
    expect(wb.rawData().relationships.some((r) => r.id === rel.id)).toBe(true);
  });
});

describe("FEAT-003 — §3.4 density reward (3D unlock) at the 35-node threshold", () => {
  let wb: Workbench;
  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
  });

  it("the threshold constant is 35", () => {
    expect(THREE_D_UNLOCK_THRESHOLD).toBe(35);
  });

  it("locked at 34 active nodes, unlocked at 35", async () => {
    const titles = Array.from({ length: 34 }, (_, i) => `P${i}`);
    await makePages(wb, titles);
    expect(wb.activeNodeCount()).toBe(34);
    expect(wb.is3DUnlocked()).toBe(false);

    const last = await wb.createSubjectPage("P34");
    expect(wb.activeNodeCount()).toBe(35);
    expect(wb.is3DUnlocked()).toBe(true);

    // Hiding one node drops it back below the threshold (presentation-only).
    await wb.hideNode(last.id);
    expect(wb.activeNodeCount()).toBe(34);
    expect(wb.is3DUnlocked()).toBe(false);
    // ...without deleting any Page.
    expect(wb.rawData().pages.length).toBe(35);
  });

  it("persists the active3D opt-in flag", async () => {
    expect(wb.active3D()).toBe(false);
    await wb.setActive3D(true);
    expect(wb.active3D()).toBe(true);
    expect(wb.rawData().presentation.active3D).toBe(true);
  });
});

describe("FEAT-003 — N06 transient placeholder creates zero records", () => {
  let wb: Workbench;
  beforeEach(async () => {
    wb = await Workbench.open(new InMemoryStorageAdapter());
  });

  it("returns transient:true and persists nothing", async () => {
    const source = await wb.importSource({
      title: "Paper",
      bytes: new Uint8Array([1, 2, 3]),
      versionHash: "h1",
      pageCount: 2,
    });
    const before = {
      pages: wb.rawData().pages.length,
      relationships: wb.rawData().relationships.length,
      categories: wb.rawData().categories.length,
    };

    const placeholder = wb.nodePlaceholderFor(source.id);

    expect(placeholder.transient).toBe(true);
    expect(placeholder.sourceId).toBe(source.id);
    expect(placeholder.title).toContain("Paper");
    // Zero graph records created.
    expect(wb.rawData().pages.length).toBe(before.pages);
    expect(wb.rawData().relationships.length).toBe(before.relationships);
    expect(wb.rawData().categories.length).toBe(before.categories);
  });
});

describe("FEAT-003 — node positions / zoom are durable presentation state", () => {
  let storage: InMemoryStorageAdapter;
  let wb: Workbench;

  beforeEach(async () => {
    storage = new InMemoryStorageAdapter();
    wb = await Workbench.open(storage);
  });

  it("round-trips node positions, drag offsets and zoom", async () => {
    const brainId = wb.snapshot().brainId;
    const [a] = await makePages(wb, ["A"]);
    await wb.setNodePosition(a!, 12, 34);
    await wb.setDragOffset(a!, 5, 6);
    await wb.setZoom(1.5);

    const reopened = await Workbench.open(storage, brainId);
    expect(reopened.zoom()).toBe(1.5);
    const node = reopened.conceptGraph().nodes.find((n) => n.pageId === a)!;
    expect(node.position).toEqual({ x: 12, y: 34 });
    expect(reopened.rawData().presentation.dragOffsets?.[a!]).toEqual({ x: 5, y: 6 });
  });
});

describe("Ruling 1 (A14-M2, §12.2) — category master pages", () => {
  let storage: InMemoryStorageAdapter;
  let wb: Workbench;

  beforeEach(async () => {
    storage = new InMemoryStorageAdapter();
    wb = await Workbench.open(storage);
  });

  it("getOrCreateCategoryMasterPage creates ONE real editable subject Page and sets masterPageId", async () => {
    const cat = await wb.createCategory("Theory", "#4b5578");
    expect(wb.categoryMasterPageId(cat.id)).toBeNull();
    const pagesBefore = wb.rawData().pages.length;

    const masterId = await wb.getOrCreateCategoryMasterPage(cat.id);

    // A real subject page exists and is editable in the SubjectEditor path.
    const page = wb.rawData().pages.find((p) => p.id === masterId)!;
    expect(page).toBeDefined();
    expect(page.kind).toBe("subject");
    expect(page.title).toBe("Theory (master)");
    expect(wb.rawData().pages.length).toBe(pagesBefore + 1);
    // Category now references the master page immutably.
    expect(wb.categoryMasterPageId(cat.id)).toBe(masterId);
    // Membership semantics are unchanged (master page is NOT a member).
    const stored = wb.rawData().categories.find((c) => c.id === cat.id)!;
    expect(stored.memberPageIds).not.toContain(masterId);
    // Editable via subject doc JSON (proves it is a normal Page).
    expect(wb.subjectDocJson(masterId)).toBeTruthy();
  });

  it("is idempotent: a second call returns the same id and creates no second page", async () => {
    const cat = await wb.createCategory("Theory");
    const first = await wb.getOrCreateCategoryMasterPage(cat.id);
    const pagesAfterFirst = wb.rawData().pages.length;

    const second = await wb.getOrCreateCategoryMasterPage(cat.id);
    expect(second).toBe(first);
    expect(wb.rawData().pages.length).toBe(pagesAfterFirst);
  });

  it("persists masterPageId across reopen", async () => {
    const brainId = wb.snapshot().brainId;
    const cat = await wb.createCategory("Theory");
    const masterId = await wb.getOrCreateCategoryMasterPage(cat.id);

    const reopened = await Workbench.open(storage, brainId);
    expect(reopened.categoryMasterPageId(cat.id)).toBe(masterId);
    // The master page id also flows through the derived graph.
    const graphCat = reopened.conceptGraph().categories.find((c) => c.categoryId === cat.id)!;
    expect(graphCat.masterPageId).toBe(masterId);
  });

  it("connectCategoryBoundaries ensures both master pages and relates them (§12.2)", async () => {
    const catA = await wb.createCategory("A");
    const catB = await wb.createCategory("B");

    const relId = await wb.connectCategoryBoundaries(catA.id, catB.id);

    const masterA = wb.categoryMasterPageId(catA.id)!;
    const masterB = wb.categoryMasterPageId(catB.id)!;
    expect(masterA).not.toBeNull();
    expect(masterB).not.toBeNull();

    const rel = wb.rawData().relationships.find((r) => r.id === relId)!;
    expect(relationshipEndpoints(rel)).toEqual([masterA, masterB]);
  });

  it("connectCategoryBoundaries reuses existing master pages (idempotent masters)", async () => {
    const catA = await wb.createCategory("A");
    const catB = await wb.createCategory("B");
    const masterA = await wb.getOrCreateCategoryMasterPage(catA.id);
    const masterB = await wb.getOrCreateCategoryMasterPage(catB.id);
    const pagesBefore = wb.rawData().pages.length;

    await wb.connectCategoryBoundaries(catA.id, catB.id);

    // No new master pages were created (the two existing ones were reused).
    expect(wb.rawData().pages.length).toBe(pagesBefore);
    expect(wb.categoryMasterPageId(catA.id)).toBe(masterA);
    expect(wb.categoryMasterPageId(catB.id)).toBe(masterB);
  });

  it("rejects connecting a category to itself", async () => {
    const cat = await wb.createCategory("A");
    await expect(wb.connectCategoryBoundaries(cat.id, cat.id)).rejects.toThrow(/distinct/);
  });
});
