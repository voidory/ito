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

export function useWorkbench(adapter?: StorageAdapter): UseWorkbench {
  const wbRef = useRef<Workbench | null>(null);
  const [state, setState] = useState<WorkbenchState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bump = useCallback(() => {
    if (wbRef.current) setState(wbRef.current.snapshot());
  }, []);

  useEffect(() => {
    let cancelled = false;
    const storage = adapter ?? new LocalFileStorageAdapter();
    Workbench.open(storage)
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
