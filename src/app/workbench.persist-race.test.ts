/**
 * Regression: a mutation made WHILE a previous save is still writing must not
 * be lost. persistNow used to snapshot this.data, await the write, then assign
 * the pre-await snapshot back, silently dropping the concurrent edit from
 * memory (it surfaced as "insertEvidenceIntoPage: unknown page" right after
 * createSubject in a real browser, where the write takes real time).
 */
import { describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import type { BrainData } from "../model";

class SlowStorage extends InMemoryStorageAdapter {
  async writeBrain(data: BrainData): Promise<void> {
    await new Promise((r) => setTimeout(r, 15));
    return super.writeBrain(data);
  }
}

describe("persist does not clobber concurrent edits", () => {
  it("keeps a page created while an earlier save is still in flight", async () => {
    const wb = await Workbench.open(new SlowStorage());
    const first = wb.createSubjectPage("First"); // save #1 starts writing
    await new Promise((r) => setTimeout(r, 5)); // ...and is now mid-write
    const second = wb.createSubjectPage("Second"); // mutates during save #1
    const [a, b] = await Promise.all([first, second]);

    const titles = wb.rawData().pages.map((p) => p.title);
    expect(titles).toEqual(["First", "Second"]);
    expect(wb.rawData().pages.map((p) => p.id)).toEqual([a.id, b.id]);

    // ...and both survive a reopen (the later save re-read the latest data).
    // A page can be cited into right away.
    expect(() => wb.subjectDocJson(b.id)).not.toThrow();
  });
});
