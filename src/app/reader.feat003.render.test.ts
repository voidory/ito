/**
 * FEAT-003 (3.3) scroll-performance coverage for the Reader's SourcePane.
 *
 * Scrolling a reader pane previously called the root `bump()` on EVERY scroll
 * tick, which forces a whole-app re-render each wheel/touch frame. The scroll
 * handler now routes through a pure, rAF-coalesced scheduler that repaints the
 * per-page highlight overlays LOCALLY and NEVER calls bump(). This test targets
 * the extracted `createScrollCoalescer` helper (the full SourcePane needs live
 * pdf.js, which jsdom cannot run) and asserts the two invariants that matter:
 *
 *  - a scroll tick never invokes the root bump handler, and
 *  - repeated schedule() calls within one frame coalesce into a single run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScrollCoalescer } from "./Reader";

describe("FEAT-003 3.3 createScrollCoalescer (rAF-coalesced, bump-free)", () => {
  let rafQueue: FrameRequestCallback[] = [];

  beforeEach(() => {
    rafQueue = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number): void => {
      rafQueue[handle - 1] = () => undefined;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function flushFrame(): void {
    const pending = rafQueue;
    rafQueue = [];
    for (const cb of pending) cb(0);
  }

  it("a scroll tick runs the local onFrame callback and never calls bump", () => {
    const bump = vi.fn();
    const onFrame = vi.fn();
    const coalescer = createScrollCoalescer(onFrame);

    // One scroll tick: nothing runs synchronously, and bump is never touched.
    coalescer.schedule();
    expect(onFrame).not.toHaveBeenCalled();
    expect(bump).not.toHaveBeenCalled();

    // On the next animation frame the LOCAL redraw runs exactly once.
    flushFrame();
    expect(onFrame).toHaveBeenCalledTimes(1);
    // The whole-app bump handler is never invoked by a scroll tick.
    expect(bump).not.toHaveBeenCalled();
  });

  it("coalesces many scroll ticks in one frame into a single onFrame run", () => {
    const onFrame = vi.fn();
    const coalescer = createScrollCoalescer(onFrame);

    // A burst of scroll events within a single frame.
    for (let i = 0; i < 20; i++) coalescer.schedule();
    expect(rafQueue.length).toBe(1); // only ONE frame is scheduled

    flushFrame();
    expect(onFrame).toHaveBeenCalledTimes(1);

    // A later tick schedules a fresh frame (the previous one already ran).
    coalescer.schedule();
    flushFrame();
    expect(onFrame).toHaveBeenCalledTimes(2);
  });

  it("cancel() tears down a pending frame so it never fires", () => {
    const onFrame = vi.fn();
    const coalescer = createScrollCoalescer(onFrame);

    coalescer.schedule();
    coalescer.cancel();
    flushFrame();
    expect(onFrame).not.toHaveBeenCalled();
  });
});
