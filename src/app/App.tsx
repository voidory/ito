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
import { SyncBanner } from "./SyncBanner";
import { MobileReaderSheet } from "./MobileReaderSheet";
import { CaptureProcessingQueue } from "./CaptureProcessingQueue";
import { revealPresentation } from "./threeScene.map";
import { installTestApi } from "./testApi";
import type { KoofrStorageAdapter, StagedImport } from "../storage";
import type { SourceId } from "../model";
import { loadDocument, hashBytes } from "../pdf";
import { importPdfFiles } from "./pdfImport";

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
  // FEAT-003 (3.2): the live remote-sync adapter, lifted into the shell so the
  // SyncBanner's Configure Sync modal can wire a WebDAV or local demo remote
  // and the publish/refresh controls become enabled once configured.
  const [remote, setRemote] = useState<KoofrStorageAdapter | null>(null);

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

  // Full-window drop guard (spec section 1.2). A .pdf dropped ANYWHERE in the
  // app (Reader/Nodes/3D/History views, not just the Library dropzone) must
  // never navigate the browser tab away, so the shell root preventDefaults
  // every drag-over/drop and routes the dropped PDFs through the SAME shared
  // import path the Library button and dropzone use (sha256 versionHash +
  // numPages fallback + wb.importSource). The Library dropzone keeps its own
  // handler; this is the outer safety net for the rest of the shell.
  const onShellDragOver = useCallback(shellDragOverHandler, []);
  const onShellDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => shellDropHandler(e, wb, bump),
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
    (mode: "files" | "nodes" | "history" | "captures") => {
      wb?.setViewMode(mode);
      bump();
    },
    [wb, bump],
  );

  // M4/M5 (A21) deterministic Phone Reading toggle. When on (or on a <760px
  // viewport) the Reader body collapses to the MobileReaderShell flow.
  const [mobileMode, setMobileMode] = useState(false);

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
      // FIX-TOP-BAR-CLIPPING (§3.5): the shell root is a strict flex column so
      // the header never gets clipped by the Nodes/3D canvas; see .app-shell in
      // theme.css (height:100vh; flex column; overflow:hidden).
      className="app-shell"
      // Propagate the motion-suppression gate to the shell root so theme.css
      // disables every transition/keyframe app-wide (R19, A09-M2).
      data-suppress-motion={state?.suppressMotion ? "true" : "false"}
      // Full-window drop guard (spec section 1.2): a stray PDF dropped on any
      // view never navigates the tab away and is imported via the shared path.
      onDragOver={onShellDragOver}
      onDrop={onShellDrop}
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
            className="shell-header"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              borderBottom: "1px solid #e5e2dc",
            }}
          >
            <ViewSwitch viewMode={state.viewMode} onSetViewMode={onSetViewMode} />
            {/* Subjects launcher: open any existing subject page, or create a
                new standalone one, from the shell header (always reachable). */}
            <SubjectsLauncher wb={wb} bump={bump} />
            {/*
              Shell-level search surface (FEAT-005): reachable in BOTH Files and
              Nodes. Selecting a result opens the match via existing Workbench
              transitions and creates ZERO durable records.
            */}
            <NetworkSearch wb={wb} categoryScope={state.categoryScope} bump={bump} />
            {/* M3 backup/restore triggers (A18/A19) + M4 sync banner + M5 mobile toggle. */}
            <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.5rem", paddingRight: "1rem" }}>
              {/* M4 (§16.1, A20) remote-sync status + publish/refresh. The remote
                  adapter is wired at runtime once Koofr credentials exist; the
                  banner still shows status (and disables actions) without one. */}
              <SyncBanner
                wb={wb}
                remote={remote}
                onChange={bump}
                onConfigureRemote={(adapter) => {
                  setRemote(adapter);
                  bump();
                }}
              />
              {/* M5 (A21) deterministic Phone Reading toggle. */}
              <button
                data-testid="toggle-mobile-mode"
                data-active={mobileMode}
                onClick={() => setMobileMode((v) => !v)}
              >
                {mobileMode ? "Exit mobile" : "Mobile"}
              </button>
              <button data-testid="open-backup-export" onClick={() => setBackupModalOpen(true)}>
                Backup
              </button>
              {/* FIX-RESTORE-BUTTON-STYLE (§3.5): the label is styled like
                  .ito-btn/button in theme.css so "Restore" visually matches
                  "Backup". The original restore-backup-label testid is kept for
                  back-compat; open-restore-input is the §3.5-named selector. */}
              <label
                data-testid="open-restore-input"
                data-legacy-testid="restore-backup-label"
                className="ito-btn restore-backup-label"
                style={{ cursor: "pointer" }}
              >
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
          {/* Always-visible save-error banner (R12): a failed persist retains
              the in-memory draft and surfaces here so the user can retry. */}
          <SaveErrorBanner wb={wb} bump={bump} />

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
          {/*
            FIX-TOP-BAR-CLIPPING (§3.5): the view body takes the remaining
            height (flex:1; min-height:0) and is the positioning context for the
            canvases, so the header's bottom edge is no longer overdrawn. The
            previous `position: fixed; inset: 0; top: 3rem` containers are gone.
          */}
          <div className="view-body" data-testid="view-body">
          {state.viewMode === "captures" ? (
            <div
              data-testid="captures-view"
              style={{ position: "absolute", inset: 0, overflow: "auto" }}
            >
              <CaptureProcessingQueue wb={wb} onChange={bump} />
            </div>
          ) : state.viewMode === "history" ? (
            <div
              data-testid="history-view"
              style={{ position: "absolute", inset: 0, overflow: "auto" }}
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
          ) : mobileMode && state.openSourceIds.length === 1 ? (
            // M4/M5 (A21) Phone Reading: a single-document reader whose scroll +
            // zoom survive the related-writing bottom sheet round-trip.
            <div
              data-testid="mobile-reader-view"
              style={{ position: "absolute", inset: 0, overflow: "auto" }}
            >
              <MobileReaderSheet
                wb={wb}
                sourceId={state.openSourceIds[0]!}
                onBackToLibrary={() => {
                  wb.closeWorkspace();
                  bump();
                }}
                onChange={bump}
              />
            </div>
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
          </div>
        </>
      ) : (
        <p style={{ padding: "2rem" }}>Loading workbench…</p>
      )}
    </div>
  );
}

/**
 * Subjects launcher (m8): a header dropdown listing every existing Subject Page
 * so any one can be opened (wb.openSubjectPage) without first finding a cited
 * annotation, plus a "+ New Subject" action that creates a standalone subject
 * page (wb.createSubjectPage) and opens it. Presentation-only shell affordance;
 * the durable records it touches are created only by the explicit new action.
 */
/**
 * Always-visible save-error banner (R12). When the last persist failed the
 * Workbench retains the in-memory draft and records a SaveError; this surfaces
 * it with a Retry action that re-attempts the save and clears the error on
 * success. Renders nothing when there is no error.
 */
export function SaveErrorBanner({
  wb,
  bump,
}: {
  wb: NonNullable<ReturnType<typeof useWorkbench>["wb"]>;
  bump: () => void;
}): JSX.Element | null {
  const saveError = wb.snapshot().saveError;
  if (!saveError) return null;
  return (
    <div
      data-testid="save-error-banner"
      role="alert"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        padding: "0.5rem 1rem",
        background: "#fdecea",
        color: "#611a15",
        borderBottom: "1px solid #f5c6c2",
        fontSize: "0.85rem",
      }}
    >
      <span style={{ flex: 1 }}>
        A change could not be saved: {saveError.message}. Your draft is kept.
      </span>
      <button
        data-testid="retry-save-btn"
        onClick={() => {
          void wb.retrySave().finally(() => bump());
        }}
      >
        Retry save
      </button>
    </div>
  );
}

export function SubjectsLauncher({
  wb,
  bump,
}: {
  wb: NonNullable<ReturnType<typeof useWorkbench>["wb"]>;
  bump: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const subjects = wb.rawData().pages.filter((p) => p.kind === "subject");

  const openSubject = (id: SourceId | string): void => {
    wb.openSubjectPage(id as never);
    setOpen(false);
    bump();
  };

  const createStandalone = async (): Promise<void> => {
    const page = await wb.createSubjectPage("Untitled subject");
    wb.openSubjectPage(page.id);
    setOpen(false);
    bump();
  };

  return (
    <div data-testid="subjects-launcher" style={{ position: "relative" }}>
      <button
        data-testid="subjects-launcher-toggle"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        Subjects ({subjects.length})
      </button>
      {open && (
        <div
          data-testid="subjects-launcher-menu"
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 20,
            minWidth: "16rem",
            background: "#fff",
            border: "1px solid #ddd",
            borderRadius: "8px",
            boxShadow: "0 6px 24px rgba(0,0,0,0.14)",
            padding: "0.4rem",
          }}
        >
          <button
            data-testid="create-standalone-subject"
            style={{ width: "100%", textAlign: "left", fontWeight: 600, marginBottom: "0.3rem" }}
            onClick={() => void createStandalone()}
          >
            + New Subject
          </button>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: "16rem", overflow: "auto" }}>
            {subjects.length === 0 && (
              <li data-testid="subjects-launcher-empty" style={{ color: "#888", fontSize: "0.85rem", padding: "0.25rem" }}>
                No subject pages yet
              </li>
            )}
            {subjects.map((p) => (
              <li key={p.id}>
                <button
                  data-testid="subjects-launcher-item"
                  data-page-id={p.id}
                  style={{ width: "100%", textAlign: "left" }}
                  onClick={() => openSubject(p.id)}
                >
                  {p.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
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
  viewMode: "files" | "nodes" | "history" | "captures";
  onSetViewMode: (mode: "files" | "nodes" | "history" | "captures") => void;
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
      <button
        data-testid="view-captures"
        role="tab"
        aria-selected={viewMode === "captures"}
        data-active={viewMode === "captures"}
        onClick={() => onSetViewMode("captures")}
      >
        Captures
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
      // FIX-TOP-BAR-CLIPPING (§3.5): fill the flex view-body instead of pinning
      // `position: fixed; top: 3rem`, so the canvas can never overdraw the
      // header's bottom edge.
      style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}
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

/**
 * Full-window drop guard handlers (spec section 1.2), extracted so the exact
 * behavior wired onto the `.app-shell` root is unit-testable. `onDragOver`
 * preventDefaults and sets a copy drop effect; `onDrop` preventDefaults (so a
 * stray PDF never navigates the tab away) and imports every dropped PDF via the
 * SAME shared path (sha256 versionHash + numPages + wb.importSource) the
 * Library button and dropzone use.
 */
export function shellDragOverHandler(e: React.DragEvent<HTMLDivElement>): void {
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
}

export function shellDropHandler(
  e: React.DragEvent<HTMLDivElement>,
  wb: ReturnType<typeof useWorkbench>["wb"],
  bump: () => void,
): void {
  e.preventDefault();
  if (!wb) return;
  const files = e.dataTransfer.files;
  if (!files || files.length === 0) return;
  void (async () => {
    const count = await importPdfFiles(wb, Array.from(files));
    if (count > 0) bump();
  })();
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
