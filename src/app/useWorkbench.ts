import { useCallback, useEffect, useRef, useState } from "react";
import { LocalFileStorageAdapter } from "../storage";
import type { StorageAdapter } from "../storage";
import { Workbench, type WorkbenchState } from "./workbench";

/**
 * React binding for the headless Workbench. It owns a single Workbench instance
 * and republishes an immutable snapshot whenever a mutation completes. A
 * `bump()` callback is passed to child components so they can force a re-render
 * after awaiting a Workbench method.
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
    defaultWorkbench = Workbench.open(new LocalFileStorageAdapter());
    defaultWorkbench.catch(() => {
      defaultWorkbench = null; // allow a later retry after a failed open
    });
  }
  return defaultWorkbench;
}

export function useWorkbench(adapter?: StorageAdapter): UseWorkbench {
  const wbRef = useRef<Workbench | null>(null);
  const [state, setState] = useState<WorkbenchState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bump = useCallback(() => {
    if (wbRef.current) setState(wbRef.current.snapshot());
  }, []);

  useEffect(() => {
    let cancelled = false;
    (adapter ? Workbench.open(adapter) : openDefaultWorkbench())
      .then((wb) => {
        if (cancelled) return;
        wbRef.current = wb;
        setState(wb.snapshot());
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [adapter]);

  return { wb: wbRef.current, state, bump, error };
}
