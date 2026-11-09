import { useCallback, useEffect, useState } from "react";
import { runStartupChecks } from "./startup";
import { useWorkbench } from "./useWorkbench";
import { Library } from "./Library";
import { Reader } from "./Reader";
import { NodesCanvas } from "./NodesCanvas";
import { installTestApi } from "./testApi";
import type { SourceId } from "../model";
import { loadDocument, hashBytes } from "../pdf";

// Import the two real fixtures so the library has documents to open. One is the
// 3+ page fixture required for the range-annotation flow.
import fixture3 from "../test/fixtures/sample-3page.pdf?url";
import fixtureMulti from "../test/fixtures/sample-multicol.pdf?url";
import fixtureRotated from "../test/fixtures/sample-rotated.pdf?url";

type Boot =
  | { kind: "booting" }
  | { kind: "ready"; detail: string }
  | { kind: "error"; detail: string };

/**
 * App shell for the M1 reading workbench. The Library is the DEFAULT entry
 * (spec section 5); opening a document switches to the Reader. The visible
 * READY/ERROR state from M0 is preserved as a boot safeguard.
 */
export function App(): JSX.Element {
  const [boot, setBoot] = useState<Boot>({ kind: "booting" });
  const { wb, state, bump, error } = useWorkbench();
  const [importing, setImporting] = useState(false);

  const onToggleTab = useCallback(
    (open: boolean) => {
      wb?.setHighlightsTabOpen(open);
      bump();
    },
    [wb, bump],
  );

  const onToggleMotion = useCallback(
    (suppress: boolean) => {
      wb?.setSuppressMotion(suppress);
      bump();
    },
    [wb, bump],
  );

  const onSetViewMode = useCallback(
    (mode: "files" | "nodes") => {
      wb?.setViewMode(mode);
      bump();
    },
    [wb, bump],
  );

  useEffect(() => {
    let cancelled = false;
    runStartupChecks()
      .then((detail) => !cancelled && setBoot({ kind: "ready", detail }))
      .catch((err: unknown) =>
        !cancelled
          ? setBoot({ kind: "error", detail: err instanceof Error ? err.message : String(err) })
          : undefined,
      );
    return () => {
      cancelled = true;
    };
  }, []);

  // Seed the library with the two real fixtures on first run.
  useEffect(() => {
    if (!wb || importing) return;
    if (wb.rawData().sources.length > 0) return;
    setImporting(true);
    void (async () => {
      await importFixture(wb, fixture3, "Sample Document (3 pages)", "Papers");
      await importFixture(wb, fixtureMulti, "Multi-Column Fixture", "References");
      // A third paper so a reader pane can be switched to a third source while
      // the same subject stays open (spec section 8.2 note).
      await importFixture(wb, fixtureRotated, "Rotated Fixture", "Papers");
      bump();
    })();
  }, [wb, importing, bump]);

  // Expose the imperative test API for Playwright once the workbench is ready.
  useEffect(() => {
    if (wb) installTestApi(wb, bump);
  }, [wb, bump]);

  if (boot.kind !== "ready") {
    return (
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
        <section data-testid="app-status" data-state={boot.kind}>
          {boot.kind === "booting" && <p>Starting…</p>}
          {boot.kind === "error" && (
            <>
              <h2 style={{ color: "#c5221f" }}>ERROR</h2>
              <p>{boot.detail}</p>
            </>
          )}
        </section>
      </main>
    );
  }

  if (error) {
    return (
      <main style={{ padding: "2rem" }}>
        <section data-testid="app-status" data-state="error">
          <h2 style={{ color: "#c5221f" }}>ERROR</h2>
          <p>{error}</p>
        </section>
      </main>
    );
  }

  return (
    <div data-testid="app-status" data-state="ready" style={{ fontFamily: "system-ui, sans-serif" }}>
      {/* Hidden boot confirmation retained for traceability to the M0 checks. */}
      <span style={{ display: "none" }} data-testid="boot-detail">
        {boot.detail}
      </span>
      {wb && state ? (
        <>
          {/*
            Top-level Files/Nodes view switch (§3.3, FEAT-005). Always visible in
            the shell header so either view is one click away; categoryScope is
            shared between them (it lives on the Workbench, carried across).
          */}
          <ViewSwitch viewMode={state.viewMode} onSetViewMode={onSetViewMode} />
          {state.viewMode === "nodes" ? (
            <NodesView
              wb={wb}
              categoryScope={state.categoryScope}
              openSourceIds={state.openSourceIds}
              suppressMotion={state.suppressMotion}
              bump={bump}
            />
          ) : state.openSourceIds.length === 0 ? (
            <Library
              wb={wb}
              categoryScope={state.categoryScope}
              onScopeChange={(category) => {
                wb.setCategoryScope(category);
                bump();
              }}
              onOpen={(id: SourceId) => {
                wb.openSource(id);
                bump();
              }}
              onOpenTogether={(ids: SourceId[]) => {
                wb.openTogether(ids);
                bump();
              }}
            />
          ) : (
            <Reader
              wb={wb}
              openSourceIds={state.openSourceIds}
              openSubjectPageId={state.openSubjectPageId}
              suppressMotion={state.suppressMotion}
              highlightsTabOpen={state.highlightsTabOpen}
              onToggleTab={onToggleTab}
              onToggleMotion={onToggleMotion}
              onBackToLibrary={() => {
                wb.closeWorkspace();
                bump();
              }}
              bump={bump}
            />
          )}
        </>
      ) : (
        <p style={{ padding: "2rem" }}>Loading workbench…</p>
      )}
    </div>
  );
}

/**
 * The top-level Files/Nodes view toggle (§3.3, FEAT-005). Presentation-only —
 * it drives `wb.setViewMode` which writes no durable record. Rendered in the
 * shell header so it is always reachable and testable.
 */
function ViewSwitch({
  viewMode,
  onSetViewMode,
}: {
  viewMode: "files" | "nodes";
  onSetViewMode: (mode: "files" | "nodes") => void;
}): JSX.Element {
  return (
    <div
      data-testid="view-switch"
      data-view-mode={viewMode}
      role="tablist"
      aria-label="View"
      style={{
        display: "flex",
        gap: "0.25rem",
        padding: "0.5rem 1rem",
        borderBottom: "1px solid #e5e2dc",
      }}
    >
      <button
        data-testid="view-files"
        role="tab"
        aria-selected={viewMode === "files"}
        data-active={viewMode === "files"}
        onClick={() => onSetViewMode("files")}
      >
        Files
      </button>
      <button
        data-testid="view-nodes"
        role="tab"
        aria-selected={viewMode === "nodes"}
        data-active={viewMode === "nodes"}
        onClick={() => onSetViewMode("nodes")}
      >
        Nodes
      </button>
    </div>
  );
}

/**
 * The Nodes view container (§3.3, FEAT-005). Shows the concept-network canvas.
 *
 * N06-M2: when exactly one source is open and it does NOT yet participate in
 * the network (no cited annotation → no node/relationship), it renders a
 * TRANSIENT "Not connected yet" placeholder sourced from
 * `wb.nodePlaceholderFor(sourceId)`. The placeholder creates NOTHING — clicking
 * it or leaving the view simply discards it (ephemeral UI only).
 *
 * The live `categoryScope` is passed into NodesCanvas so selecting a category
 * in Files carries into Nodes: no scope = the global network; a scope = only
 * that category's squircle + its local/overlapping network.
 */
function NodesView({
  wb,
  categoryScope,
  openSourceIds,
  suppressMotion,
  bump,
}: {
  wb: NonNullable<ReturnType<typeof useWorkbench>["wb"]>;
  categoryScope: string | null;
  openSourceIds: readonly SourceId[];
  suppressMotion: boolean;
  bump: () => void;
}): JSX.Element {
  // A single open, unconnected source drives the N06 placeholder. "Open
  // together" (2+) or a connected source shows the real canvas.
  const soloSourceId = openSourceIds.length === 1 ? openSourceIds[0]! : null;
  const placeholder =
    soloSourceId && !wb.sourceIsConnected(soloSourceId)
      ? wb.nodePlaceholderFor(soloSourceId)
      : null;

  return (
    <div
      data-testid="nodes-view"
      style={{ position: "fixed", inset: 0, top: "3rem", display: "flex", flexDirection: "column" }}
    >
      <div style={{ flex: 1, minHeight: 0 }}>
        <NodesCanvas
          wb={wb}
          categoryScope={categoryScope}
          placeholder={placeholder}
          suppressMotion={suppressMotion}
          bump={bump}
        />
      </div>
    </div>
  );
}

async function importFixture(
  wb: NonNullable<ReturnType<typeof useWorkbench>["wb"]>,
  url: string,
  title: string,
  category: string,
): Promise<void> {
  const res = await fetch(url);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const versionHash = await hashBytes(bytes);
  const doc = await loadDocument(bytes.slice());
  await wb.importSource({ title, bytes, versionHash, pageCount: doc.numPages, category });
}
