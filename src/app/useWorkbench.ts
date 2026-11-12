import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { IndexedDbStorageAdapter } from "../storage";
import type { StorageAdapter } from "../storage";
import { Workbench, type WorkbenchState } from "./workbench";

/**
 * React binding for the headless Workbench.
 *
 * P4 (observable store): the Workbench is now observable. The binding subscribes
 * to it with `useSyncExternalStore(wb.subscribe, wb.snapshot)`, so React tracks
 * state through the subscription and re-renders on EVERY committed mutation —
 * durable writes (which funnel through `persist()`) and transient view setters
 * both call `notify()`. A forgotten manual refresh can no longer leave the UI
 * showing stale data.
 *
 * `bump()` is retained for backward compatibility (dozens of call sites pass it
 * down), but it is now just a manual nudge that re-notifies subscribers. It is
 * no longer the sole re-render trigger, so mis-timed or missing `bump()` calls
 * are a non-issue: the store drives the UI.
 */
export interface UseWorkbench {
  readonly wb: Workbench | null;
  readonly state: WorkbenchState | null;
  readonly bump: () => void;
  readonly error: string | null;
}

/**
 * The default (IndexedDB) workbench is opened ONCE per page load and shared.
 * React StrictMode mounts effects twice in development; opening twice against
 * an empty store raced two `Workbench.open` calls that each created and
 * persisted a separate empty brain, after which a reload could open the wrong
 * (empty) one and the user's work appeared lost.
 */
let defaultWorkbench: Promise<Workbench> | null = null;

function openDefaultWorkbench(): Promise<Workbench> {
  if (!defaultWorkbench) {
    defaultWorkbench = Workbench.open(new IndexedDbStorageAdapter());
    defaultWorkbench.catch(() => {
      defaultWorkbench = null; // allow a later retry after a failed open
    });
  }
  return defaultWorkbench;
}

/** A stable no-op store used before the Workbench has opened. */
const EMPTY_SUBSCRIBE = (): (() => void) => () => undefined;
const EMPTY_SNAPSHOT = (): WorkbenchState | null => null;

export function useWorkbench(adapter?: StorageAdapter): UseWorkbench {
  const [wb, setWb] = useState<Workbench | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (adapter ? Workbench.open(adapter) : openDefaultWorkbench())
      .then((opened) => {
        if (cancelled) return;
        opened.enableAutoHistory();
        setWb(opened);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [adapter]);

  // Track the Workbench's observable state. Before it opens, a stable no-op
  // store yields null; once `wb` is set, React re-subscribes to the real store.
  const state = useSyncExternalStore(
    wb ? wb.subscribe : EMPTY_SUBSCRIBE,
    wb ? wb.snapshot : EMPTY_SNAPSHOT,
    wb ? wb.snapshot : EMPTY_SNAPSHOT,
  );

  // Backward-compatible manual nudge. Mutations already notify on their own;
  // this simply re-notifies, which is harmless (React coalesces).
  const bump = useCallback(() => {
    wb?.notify();
  }, [wb]);

  return { wb, state, bump, error };
}
