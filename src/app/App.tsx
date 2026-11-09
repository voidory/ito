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

  const onToggleNodesView = useCallback(
    (active: boolean) => {
      wb?.setNodesViewActive(active);
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
        state.nodesViewActive ? (
          <div
            data-testid="nodes-view"
            style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column" }}
          >
            <div style={{ padding: "0.5rem", borderBottom: "1px solid #e5e2dc" }}>
              <button
                data-testid="exit-nodes-view"
                onClick={() => onToggleNodesView(false)}
              >
                ← Files
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <NodesCanvas wb={wb} suppressMotion={state.suppressMotion} bump={bump} />
            </div>
          </div>
        ) : state.openSourceIds.length === 0 ? (
          <>
            <div style={{ padding: "0.5rem 1rem" }}>
              <button
                data-testid="open-nodes-view"
                onClick={() => onToggleNodesView(true)}
              >
                Nodes
              </button>
            </div>
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
          </>
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
        )
      ) : (
        <p style={{ padding: "2rem" }}>Loading workbench…</p>
      )}
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
