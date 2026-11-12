/**
 * jsdom render coverage for the FEAT-002 Library Authors/Year metadata. It
 * mounts the REAL Library against a REAL Workbench (in-memory storage) and
 * asserts the Authors + Year cells render the PERSISTED PDF metadata when it is
 * present on the Source, and fall back correctly when it is absent:
 *  - authors: persisted `source.authors`, else em-dash;
 *  - year: persisted `source.year`, else a 4-digit year scraped from the title,
 *    else em-dash.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { sha256Hex } from "../storage";
import { Workbench } from "./workbench";
import { Library } from "./Library";
import type { Source, SourceId } from "../model";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mount(wb: Workbench): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(Library, {
        wb,
        onOpen: () => undefined,
        onOpenTogether: () => undefined,
      }),
    );
  });
  return container;
}

async function seed(
  wb: Workbench,
  params: { title: string; authors?: string; year?: string },
): Promise<Source> {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, params.title.length & 0xff]);
  return wb.importSource({
    title: params.title,
    bytes,
    versionHash: await sha256Hex(bytes),
    pageCount: 3,
    category: "Papers",
    authors: params.authors,
    year: params.year,
  });
}

function cells(el: HTMLElement, id: SourceId): { authors: string; year: string } {
  const row = el.querySelector(`[data-testid="library-item"][data-source-id="${id}"]`)!;
  return {
    authors: row.querySelector('[data-testid="library-cell-authors"]')!.textContent ?? "",
    year: row.querySelector('[data-testid="library-cell-year"]')!.textContent ?? "",
  };
}

describe("Library — real Authors/Year metadata (FEAT-002)", () => {
  it("renders persisted authors and year when present on the Source", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const s = await seed(wb, { title: "A Study of Things", authors: "Ada Lovelace", year: "1999" });
    const el = await mount(wb);
    const c = cells(el, s.id);
    expect(c.authors).toBe("Ada Lovelace");
    expect(c.year).toBe("1999");
  });

  it("persisted year wins over a different year in the title", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const s = await seed(wb, { title: "Paper (2010)", authors: "Grace Hopper", year: "2021" });
    const el = await mount(wb);
    const c = cells(el, s.id);
    expect(c.authors).toBe("Grace Hopper");
    // The persisted metadata year is preferred, NOT the 2010 in the title.
    expect(c.year).toBe("2021");
  });

  it("falls back to the title-regex year and an em-dash author when metadata is absent", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const s = await seed(wb, { title: "Classic Result (1987)" });
    const el = await mount(wb);
    const c = cells(el, s.id);
    expect(c.authors).toBe("—");
    expect(c.year).toBe("1987");
  });

  it("falls back to an em-dash year when neither metadata nor a title year exist", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const s = await seed(wb, { title: "Untitled Draft" });
    const el = await mount(wb);
    const c = cells(el, s.id);
    expect(c.authors).toBe("—");
    expect(c.year).toBe("—");
  });
});

// Keep an explicit reference so an unused-import lint never trips on SourceId.
export type _KeepSourceId = SourceId;
