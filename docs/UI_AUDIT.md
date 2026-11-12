# ito — UI Audit: Critical Problems & Remediation Plan

_Audit date: 2026-11-12 · Branch: `m21-ui-ux-priorities` · HEAD: `ca1fc2e`_

This report inspects the app's UI (`src/app/**`) and flags critical problems —
bugs, inconsistencies, missing backend wiring, and disorganised/legacy code —
each with a concrete plan to fix. Items are ordered by severity.

### Status

- **P0 — DONE** (PR #19): build unbroken; `Library.tsx` JSX + e2e dialog typing fixed.
- **P1 — DONE**: CI now runs typecheck + full Vitest suite + build + Playwright e2e
  (was one unit file). Suite made green — 3 stale test files updated to the current
  empty-state Library design and the M20 selection-based hub UX (881/881 passing).
- **P2 — DONE**: `window.__ito` test API gated behind `testApiEnabled()` and loaded
  via dynamic `import()`, so it is code-split out of a normal `npm run build` and
  never installed in production. e2e opts in with `VITE_ITO_TEST_API=1`.
- **P3 — DONE**: startup no longer claims a non-existent in-memory fallback; a missing
  IndexedDB now surfaces an honest error instead of a passing READY note.
- **P4 — DONE**: `Workbench` is now an observable store (`subscribe`/`notify` + a cached,
  reference-stable `snapshot`); `useWorkbench` consumes it via `useSyncExternalStore`.
  Every durable mutation (through `persist()`) and every transient view setter — plus the
  two paths that swap the live brain outside `persist()` (`commitStagedImport`,
  `refreshFromRemote`) — now `notify()`, so a forgotten/mis-timed `bump()` can no longer
  leave the UI stale. `bump()` is kept as a backward-compatible re-notify shim.
- **P5 — DONE**: WebDAV sync config now persists (new `syncConfigStore` in
  `localStorage`); `App` restores a configured real remote at boot so it reconnects
  automatically, the config modal shows a "reconnects on reload" hint + a Disconnect
  action, and the in-memory demo remote is explicitly labelled ephemeral (never persisted).
- **P6–P8**: still open (see below).

---

## P0 — BLOCKER: the app does not build at HEAD

**Problem.** `src/app/Library.tsx` has malformed JSX that breaks `tsc` and
therefore `npm run build` (`tsc --noEmit && vite build`). The whole app fails
to type-check on the current branch.

```
src/app/Library.tsx(538,21): error TS17002: Expected corresponding JSX closing tag for 'header'.
src/app/Library.tsx(539,9):  error TS17002: Expected corresponding JSX closing tag for 'section'.
src/app/Library.tsx(712,5):  error TS1005: ')' expected.
src/app/Library.tsx(713,3):  error TS1109: Expression expected.
```

The offending region (Library header):

```tsx
        {sources.length > 0 && (
          <div>
            ... buttons ...
          </div>          // ← inner div closed (correct)
        )}        </div>  // ← extra, unmatched </div>  (line 538)
      </header>
```

The `{sources.length > 0 && ( <div>…</div> )}` block opens exactly one `<div>`,
which is already closed on line 537. The trailing `</div>` on line 538 is a
leftover from an edit ("Reduce empty-state header clutter", commit `c4b31ee`)
and has no matching opening tag, which cascades into the later `)` / section
errors.

- This is **committed**, not a dirty working-tree artifact (`git status` is clean;
  `git blame` points at `c4b31ee` on this branch).
- CI (`.github/workflows/m17-playtest.yml`) runs `npm run build`, so `main`/PR
  builds for this branch are red.

**Fix plan.**
1. Delete the stray `</div>` on line 538 so the block reads `)}` then `</header>`.
2. Re-run `npm run typecheck` to confirm 0 errors.
3. (Prevention) See P1 — CI must fail the branch loudly; and a pre-commit/pre-push
   typecheck hook would have caught this before it landed.

_Estimate: 5 minutes for the fix; the prevention work is tracked under P1._

---

## P1 — CI does not actually test the app

**Problem.** The only workflow (`m17-playtest.yml`) runs:
```
npm test -- --run src/pdf/scienceOcr.test.ts   # ONE unit file
npm run typecheck
npm run build
```
It runs a **single** unit-test file out of ~90 Vitest suites, and runs **none**
of the 18 Playwright e2e specs in `e2e/`. The typecheck/build steps _should_
have blocked the P0 regression — verify why they didn't (branch not covered,
workflow disabled, or build step silently passing).

**Impact.** The large test investment (unit + e2e) provides no safety net on PRs.
Regressions like P0 reach the default branch.

**Fix plan.**
1. Run the full unit suite in CI: `npm test` (all Vitest), not one file.
2. Add an e2e job: `npx playwright install --with-deps chromium` + `npm run test:e2e`.
3. Confirm `typecheck`/`build` are required status checks on `main` and that the
   current branch is in the trigger set; fail the job on non-zero exit.
4. Rename the workflow away from the milestone-specific `m17-playtest` to a
   stable name (e.g. `ci.yml`).

---

## P2 — Test API (`window.__ito`) is shipped in the production bundle

**Problem.** `App.tsx` installs the full Playwright imperative API
unconditionally:

```tsx
useEffect(() => {
  if (wb) installTestApi(wb, bump);
}, [wb, bump]);
```

`installTestApi` (`src/app/testApi.ts`, 1,456 lines) ends with:
```ts
(window as unknown as { __ito: ItoTestApi }).__ito = api;
```
There is **no** `import.meta.env.DEV` guard (the app has the pattern — see
`src/pdf/instrumentation.ts:80` — it's just not used here).

**Impact.**
- Exposes dozens of privileged, destructive mutators to _any_ page script/console:
  `deleteAnnotationAndQuotes`, `restoreRevision`, `exportBackup`, `publishToRemote`,
  `forceNextSaveFailures`, `readSourceBytes`, etc. — a data-safety and exfiltration risk.
- Ships test-only fakes and dummy credentials (`username: "test", appPassword: "test"`,
  an in-memory WebDAV fake) in the shipped JS.
- Bundle bloat + internal data-model disclosure.

**Fix plan.**
1. Gate the call: `if (import.meta.env.DEV && wb) installTestApi(wb, bump);`
   (e2e runs against the dev server, so DEV is true there).
2. If prod e2e is ever needed, gate behind an explicit env flag
   (`import.meta.env.VITE_ITO_TEST_API === "1"`) instead of always-on.
3. Verify the module is tree-shaken out of `vite build` once the call is guarded.

---

## P3 — Startup claims an in-memory fallback that doesn't exist

**Problem.** `src/app/startup.ts` reports, when IndexedDB is missing:
`"(persistent storage unavailable; running in-memory)"`. But there is **no**
in-memory adapter: `useWorkbench` always constructs `new LocalFileStorageAdapter()`
(IndexedDB-backed). If `indexedDB` is truly absent, `Workbench.open` will throw,
not run in-memory. The message is misleading and masks a hard failure as a soft note.

**Fix plan.**
1. Either implement a real `InMemoryStorageAdapter` and have `useWorkbench`
   fall back to it when `indexedDB` is undefined, **or**
2. Change the copy to the truth: persistent storage unavailable → the app cannot
   save, and surface it as an error/warning banner rather than a passing READY note.
   (Option 1 is the better UX; option 2 is the honest minimum.)

---

## P4 — Fragile re-render architecture (manual `bump()` everywhere)

**Problem.** `useWorkbench` has no subscription model. The UI re-renders only
when a component remembers to call `bump()` (which does
`setState(wb.snapshot())`) _after_ an async mutation settles. `bump` is threaded
as a prop through nearly every component.

Failure modes observed:
- **Missed re-render:** any handler that forgets `bump()` leaves the UI stale
  while IndexedDB is already updated.
- **Stale read:** mutators are `async` (they await `persist()`); handlers that
  call a mutator without awaiting and then `bump()` synchronously can snapshot
  pre-mutation state. The codebase mixes `await`, `void x().then(bump)`, and
  bump-after-sync-call inconsistently.
- **Untracked live reads during render:** `SaveErrorBanner` reads
  `wb.snapshot().saveError` and `SubjectsLauncher` reads `wb.rawData().pages`
  _during render_, bypassing React's tracked `state`. They refresh only
  incidentally when a parent happens to `bump()`.
- The module-level `defaultWorkbench` promise cache in `useWorkbench.ts` exists
  only to paper over a StrictMode double-open that previously persisted two
  empty brains and "lost" user work — a symptom of the fragile lifecycle.

**Fix plan (incremental, no big-bang rewrite).**
1. Make `Workbench` an observable: add `subscribe(listener)` + emit on every
   committed mutation.
2. Replace the `bump()` plumbing with `useSyncExternalStore(subscribe,
   () => wb.snapshot())`. Components read tracked state and never call a manual
   bump; async mutations auto-notify on commit. This removes the entire class of
   missed-re-render / stale-read bugs.
3. Migrate component-by-component; delete `bump` props as each is converted.
4. Forbid `wb.snapshot()`/`wb.rawData()` calls inside `render` via lint; route
   all reads through the store selector.

---

## P5 — Sync/remote UI is present but effectively stubbed by default

**Problem.** The publish/refresh/configure-sync surfaces (`SyncBanner`,
`SettingsMenu`) are wired, and the workbench's `publishToRemote`/`refreshFromRemote`
logic + `KoofrStorageAdapter` (real WebDAV) are functional and tested. **But** at
runtime `remote` starts `null`, Publish/Refresh are `disabled` until the user
hand-enters WebDAV credentials each session, and the prominently offered
alternative, "demo" remote, is an **in-memory `Map`-backed fake** that evaporates
on reload. There is no default endpoint and no credential persistence.

**Impact.** A core advertised capability (Koofr sync, mobile capture upload/pull)
looks available but does nothing durable out of the box.

**Fix plan.**
1. Persist configured WebDAV credentials (e.g. in IndexedDB settings) so sync
   survives reload, with a clear connected/disconnected status.
2. Clearly label the demo remote as ephemeral in the UI (it currently reads like
   a working option).
3. If a hosted Koofr endpoint is intended for v1, wire it; otherwise document
   that remote sync is BYO-WebDAV and gate the mobile-capture UI behind a
   configured remote so it isn't a dead affordance.

---

## P6 — Styling is inconsistent: design tokens vs. ~150 inline styles

**Problem.** There is a real design system — `theme.css` (1,676 lines, 195
`--ito-*` CSS variables) — yet components lean heavily on hardcoded inline
styles and raw hex colors that bypass the tokens:

| File | inline `style={{…}}` count |
| --- | --- |
| `Library.tsx` | 29 |
| `App.tsx` | 29 |
| `SubjectEditor.tsx` | 16 |
| `reader/AnnotationOverlays.tsx` | 12 |
| `MobileReaderSheet.tsx` | 10 |
| … | (≈150 total across `src/app`) |

Examples: hardcoded `#c5221f`, `#fdecea`, `#611a15`, `#e5e2dc`, `#b3261e` in
`App.tsx`/`Library.tsx` instead of `--ito-*` tokens; `fontFamily:
"system-ui, sans-serif"` repeated inline. The same concepts (error banner red,
border grey) are re-specified per component, so theming/dark-mode/consistency
changes require touching dozens of inline objects.

**Fix plan.**
1. Audit the recurring inline colors; map each to an existing `--ito-*` token
   (add tokens where missing — e.g. `--ito-danger-bg/fg/border`).
2. Move repeated inline blocks into CSS classes in `theme.css`; keep inline only
   for genuinely dynamic values (computed positions/sizes).
3. Add a lint rule discouraging raw hex in `.tsx` so new code uses tokens.

---

## P7 — Monolithic / disorganised modules

**Problem.**
- `workbench.ts` is **5,735 lines** — one class owning data model, persistence
  queue, history, sync, captures, network, migrations, and more.
- `NodesCanvas.tsx` (1,811), `testApi.ts` (1,456), `Library.tsx` (1,016),
  `App.tsx` (892) are all oversized; `App.tsx` defines many sub-components
  (`SettingsMenu`, `SubjectsLauncher`, `NodesView`, drop handlers) inline.

**Impact.** Hard to navigate, review, and test; merge-conflict magnet; the P0
JSX break hid in a 1,000-line component.

**Fix plan.**
1. Split `workbench.ts` into focused modules behind the same public interface:
   `persist`, `history`, `sync`, `captures`, `network`, `migrate`.
2. Extract `App.tsx` sub-components (`SettingsMenu`, `SubjectsLauncher`,
   `NodesView`, shell drop handlers) into their own files.
3. Do this alongside P4 so re-render changes and decomposition land together per area.

---

## P8 — Legacy / stale artifacts in the tree

**Problem.**
- `KIRO_HANDOFF_m13.md` and `KIRO_HANDOFF_reader_rework.md` at repo root are
  stale agent task-briefs (old milestones/branches), not product docs.
- `src/storage/localFileStorageAdapter.superseded.test.ts` is self-labeled
  superseded.
- **Naming drift:** `LocalFileStorageAdapter` and `StorageAdapter.ts` comments
  mention "OPFS/WebDAV/file", but the implementation is pure IndexedDB. The
  `useWorkbench` doc even calls it "the IndexedDB workbench". The class name lies.
- Milestone tags are baked into comments throughout `src` (M13 ~132×, M2 ~119×,
  M17 ~67×, …) — rationale accreted per milestone rather than refactored.
- The reader-rework handoff asked to delete the old workspace-pane/evidence-line
  layout, but `reader/EvidenceLines.tsx` + `PassageEvidenceLine` /
  `workspaceLayout.linesVisible` machinery still exist — a partially-removed path.

**Fix plan.**
1. Move `KIRO_HANDOFF_*.md` out of the product repo (or into `docs/archive/`).
2. Rename `LocalFileStorageAdapter` → `IndexedDbStorageAdapter`; fix the stale
   "OPFS/file" comments to match reality.
3. Confirm the evidence-line layout is dead; if so delete it, else document why
   it's retained.
4. Delete the `superseded` test if its coverage is subsumed; otherwise rename it.
5. (Lower priority) prune milestone-narrative comments during the P7 refactor.

---

## Suggested sequencing

1. **P0** — unbreak the build (today).
2. **P1 + P2 + P3** — CI covers the app; strip test API from prod; honest storage
   fallback (safety/hygiene, low effort).
3. **P4** — observable store via `useSyncExternalStore` (removes a whole bug class).
4. **P5** — persist/clarify sync.
5. **P6 / P7 / P8** — styling tokens, decomposition, legacy cleanup (incremental).
