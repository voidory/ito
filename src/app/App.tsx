import { useCallback, useEffect, useState } from "react";
import { runStartupChecks } from "./startup";
import { useWorkbench } from "./useWorkbench";
import { Library } from "./Library";
import { Reader } from "./Reader";
import { NodesCanvas } from "./NodesCanvas";
import { HistoryReflectionPanel } from "./HistoryReflectionPanel";
import { NetworkSearch } from "./NetworkSearch";
import { ThreeScene } from "./ThreeScene";
import { BackupExportModal } from "./BackupExportModal";
import { ImportStagingReport } from "./ImportStagingReport";
import { revealPresentation } from "./threeScene.map";
import { installTestApi } from "./testApi";
import type { StagedImport } from "../storage";
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
  // M3 backup/restore surfaces (A18/A19): the export modal and the staged
  // import report are mounted from the shell behind visible triggers.
  const [backupModalOpen, setBackupModalOpen] = useState(false);
  const [staged, setStaged] = useState<StagedImport | null>(null);

  const onRestoreFile = useCallback(
    async (file: File | null) => {
      if (!wb || !file) return;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await wb.stageImport(bytes);
      setStaged(result);
      bump();
    },
    [wb, bump],
  );

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
    (mode: "files" | "nodes" | "history") => {
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
    <div
      data-testid="app-status"
      data-state="ready"
      // Propagate the motion-suppression gate to the shell root so theme.css
      // disables every transition/keyframe app-wide (R19, A09-M2).
      data-suppress-motion={state?.suppressMotion ? "true" : "false"}
      style={{ fontFamily: "system-ui, sans-serif" }}
    >
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
          <div
            data-testid="shell-header"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              borderBottom: "1px solid #e5e2dc",
            }}
          >
            <ViewSwitch viewMode={state.viewMode} onSetViewMode={onSetViewMode} />
            {/*
              Shell-level search surface (FEAT-005): reachable in BOTH Files and
              Nodes. Selecting a result opens the match via existing Workbench
              transitions and creates ZERO durable records.
            */}
            <NetworkSearch wb={wb} categoryScope={state.categoryScope} bump={bump} />
            {/* M3 backup/restore triggers (A18/A19): always reachable. */}
            <span style={{ marginLeft: "auto", display: "flex", gap: "0.5rem", paddingRight: "1rem" }}>
              <button data-testid="open-backup-export" onClick={() => setBackupModalOpen(true)}>
                Backup
              </button>
              <label data-testid="restore-backup-label" style={{ cursor: "pointer" }}>
                Restore
                <input
                  data-testid="restore-backup-input"
                  type="file"
                  accept=".ito,.zip,.json,application/zip,application/json"
                  style={{ display: "none" }}
                  onChange={(e) => void onRestoreFile(e.target.files?.[0] ?? null)}
                />
              </label>
            </span>
          </div>
          {backupModalOpen && (
            <BackupExportModal wb={wb} onClose={() => setBackupModalOpen(false)} />
          )}
          {staged && (
            <ImportStagingReport
              wb={wb}
              staged={staged}
              onDone={(committed) => {
                if (committed) setStaged(null);
                bump();
              }}
              onCancel={() => {
                wb.clearStagedImport();
                setStaged(null);
                bump();
              }}
            />
          )}
          {state.viewMode === "history" ? (
            <div
              data-testid="history-view"
              style={{ position: "fixed", inset: 0, top: "3rem", overflow: "auto" }}
            >
              <HistoryReflectionPanel wb={wb} onChange={bump} />
            </div>
          ) : state.viewMode === "nodes" ? (
            <NodesView
              wb={wb}
              categoryScope={state.categoryScope}
              openSourceIds={state.openSourceIds}
              focusedPageId={state.focusedPageId}
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
              onImported={() => bump()}
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
  viewMode: "files" | "nodes" | "history";
  onSetViewMode: (mode: "files" | "nodes" | "history") => void;
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
      <button
        data-testid="view-history"
        role="tab"
        aria-selected={viewMode === "history"}
        data-active={viewMode === "history"}
        onClick={() => onSetViewMode("history")}
      >
        History
      </button>
    </div>
  );
}

/**
 * The Nodes view container (§3.3, FEAT-005). Shows the concept-network canvas.
 *
 * N06-M2: for EVERY currently open source that does NOT yet participate in the
 * network (no cited annotation → no node/relationship), it renders a TRANSIENT
 * "Not connected yet" placeholder sourced from `wb.nodePlaceholderFor(sourceId)`
 * — including the open-together (2+) case, not only a single open source. Each
 * placeholder creates NOTHING and offers a Return-to-Reader action; leaving the
 * view simply discards them (ephemeral UI only, zero durable records).
 *
 * The live `categoryScope` is passed into NodesCanvas so selecting a category
 * in Files carries into Nodes: no scope = the global network; a scope = only
 * that category's squircle + its local/overlapping network.
 */
function NodesView({
  wb,
  categoryScope,
  openSourceIds,
  focusedPageId,
  suppressMotion,
  bump,
}: {
  wb: NonNullable<ReturnType<typeof useWorkbench>["wb"]>;
  categoryScope: string | null;
  openSourceIds: readonly SourceId[];
  focusedPageId: string | null;
  suppressMotion: boolean;
  bump: () => void;
}): JSX.Element {
  // N06: EVERY currently open source that does not yet participate in the
  // network (no cited annotation) gets its own transient placeholder — not just
  // when exactly one source is open. Each placeholder is ephemeral and creates
  // ZERO durable Page/Relationship/Category records.
  const placeholders = openSourceIds
    .filter((id) => !wb.sourceIsConnected(id))
    .map((id) => wb.nodePlaceholderFor(id));

  // §3.4 density reward: the "enter 3D" prompt is revealed ONLY once the live
  // graph reaches the density threshold (is3DUnlocked). Its presentation (glow
  // vs static control) honors suppress-motion via the pure reveal mapping.
  const reveal = revealPresentation(wb.is3DUnlocked(), suppressMotion);
  const active3D = wb.active3D();

  return (
    <div
      data-testid="nodes-view"
      style={{ position: "fixed", inset: 0, top: "3rem", display: "flex", flexDirection: "column" }}
    >
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {active3D ? (
          // Smooth scale-out transition from the 2D canvas into 3D; an instant
          // swap when motion is suppressed (no scale animation).
          <div
            data-testid="three-container"
            data-suppress-motion={suppressMotion ? "true" : "false"}
            style={{
              width: "100%",
              height: "100%",
              animation: suppressMotion ? undefined : "ito-3d-enter 420ms ease-out",
            }}
          >
            <ThreeScene
              wb={wb}
              suppressMotion={suppressMotion}
              onExit={() => {
                void wb.setActive3D(false);
                bump();
              }}
            />
          </div>
        ) : (
          <>
            <NodesCanvas
              wb={wb}
              categoryScope={categoryScope}
              placeholders={placeholders}
              focusedPageId={focusedPageId}
              suppressMotion={suppressMotion}
              bump={bump}
            />
            {reveal.present ? (
              <button
                data-testid="enter-3d"
                data-glow={reveal.glow ? "true" : "false"}
                className={reveal.glow ? "enter-3d enter-3d-glow" : "enter-3d"}
                aria-label="Enter the 3D dimensional view"
                onClick={() => {
                  void wb.setActive3D(true);
                  bump();
                }}
              >
                Enter 3D
              </button>
            ) : null}
          </>
        )}
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
