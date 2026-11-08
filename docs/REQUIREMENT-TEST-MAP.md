# REQUIREMENT → TEST MAP

Maps spec acceptance IDs (A01–A24 acceptance, R01–R20 requirements, N01–N08
non-functional) to the milestone that delivers them and the test that covers
them. Status: implemented / planned / deferred.

Test kinds: `unit` (Vitest), `e2e` (Playwright chromium, real browser), `n/a`.

## Acceptance (A01–A24)

| ID  | Requirement (summary)                              | Milestone | Test kind | Test / location                          | Status      |
| --- | -------------------------------------------------- | --------- | --------- | ---------------------------------------- | ----------- |
| A01 | App boots to a visible READY state in a browser    | M0        | e2e       | `e2e/ready.spec.ts`                      | implemented |
| A02 | Startup failure surfaces a visible ERROR state     | M0        | e2e       | planned (`e2e/error.spec.ts`)            | planned     |
| A03 | Import a PDF source                                 | M1        | e2e       | planned                                  | planned     |
| A04 | Render PDF with a real selectable text layer       | M2        | e2e       | planned                                  | planned     |
| A05 | Select text and commit a highlight                 | M2        | e2e       | planned                                  | planned     |
| A06 | Highlight stored as a portable anchor (0..1 rects) | M2        | unit+e2e  | planned; anchor type `src/model`         | planned     |
| A07 | Add an annotation comment (empty comment valid)    | M2        | unit      | `src/test/model.test.ts` (type) + e2e    | planned     |
| A08 | Multi-page scope annotation                         | M2        | unit      | planned                                  | planned     |
| A09 | Save to local storage adapter                      | M1        | unit+e2e  | planned (`src/test/storage.test.ts`)     | planned     |
| A10 | Reopen and re-resolve anchors                       | M2        | unit+e2e  | planned                                  | planned     |
| A11 | Unresolved/mismatched anchor shown explicitly       | M2        | unit      | `AnchorResolution` + resolve hook         | planned     |
| A12 | Create a subject page                               | M3        | e2e       | planned                                  | planned     |
| A13 | Insert evidence from an annotation                  | M3        | e2e       | planned                                  | planned     |
| A14 | Evidence serialized independent of DOM coords       | M3        | unit      | ProseMirror doc JSON round-trip (planned) | planned     |
| A15 | Citation status derived per annotation-dest pair    | M3        | unit      | `src/test/model.test.ts`                 | implemented |
| A16 | Concept network graph of pages/relationships        | M5        | e2e       | planned                                  | planned     |
| A17 | Graph `hide` never deletes content                  | M5        | unit      | `PresentationState` (type) + planned     | planned     |
| A18 | Categories group pages without duplicating them     | M5        | unit      | `Category.memberPageIds` + planned       | planned     |
| A19 | Tentative associations distinct from relationships  | M5        | unit      | planned                                  | planned     |
| A20 | Safe publication (no partial published state)       | M4        | unit      | `src/test/storage.test.ts` (planned)     | planned     |
| A21 | Named revisions advance publicationRevision         | M6        | unit      | planned                                  | planned     |
| A22 | Koofr/WebDAV remote adapter                          | M4        | unit      | planned                                  | deferred    |
| A23 | Schema migration across versions                     | M7        | unit      | migration hook (planned)                 | planned     |
| A24 | Delivery/hosting resolved                            | M4        | n/a       | ADR-0005 / FEAT-002 spike                | deferred    |

## Requirements (R01–R20)

| ID  | Requirement (summary)                              | Milestone | Test kind | Status      |
| --- | -------------------------------------------------- | --------- | --------- | ----------- |
| R01 | Durable unique string IDs on every record          | M0        | unit      | implemented |
| R02 | pdfjs-dist, not iframe + fake-HTML layer            | M0        | n/a       | implemented (ADR-0001) |
| R03 | Portable anchor field set                          | M0        | unit      | implemented (type) |
| R04 | ProseMirror doc JSON is source of truth            | M0        | n/a       | implemented (ADR-0002) |
| R05 | StorageAdapter boundary; app never touches IDB      | M0        | unit      | implemented |
| R06 | schemaVersion on BrainManifest                     | M0        | unit      | implemented |
| R07 | Migration hook                                     | M0        | unit      | implemented (hook) |
| R08 | Write-then-verify, publish pointer last            | M1        | unit      | implemented (adapter) |
| R09 | Annotation vs evidence are distinct records        | M0        | unit      | implemented (types) |
| R10 | No standalone isCited boolean                       | M0        | unit      | implemented |
| R11 | Empty annotation comment valid                     | M0        | unit      | implemented (type) |
| R12 | Real PDF fixtures (3+ pages, multi-col, rotated)   | M0        | unit      | implemented |
| R13 | Reproducible fixture generation script             | M0        | n/a       | implemented |
| R14 | Vitest harness                                     | M0        | unit      | implemented |
| R15 | Playwright real-browser harness                    | M0        | e2e       | implemented |
| R16 | Highlighting validated first (order binding)        | M2        | e2e       | planned     |
| R17 | Continuous page editing validated second            | M3        | e2e       | planned     |
| R18 | Context-preserving view transitions validated third | M5        | e2e       | planned     |
| R19 | Making annotations never auto-creates nodes/pages   | M2        | e2e       | planned     |
| R20 | Categories never duplicate pages                    | M5        | unit      | planned     |

## Non-functional (N01–N08)

| ID  | Requirement (summary)                        | Milestone | Status      |
| --- | -------------------------------------------- | --------- | ----------- |
| N01 | Strict TypeScript, no type errors            | M0        | implemented |
| N02 | Build passes (tsc + vite build)              | M0        | implemented |
| N03 | Runtime validation via real browser          | M0        | implemented |
| N04 | Data/app separation                          | M0        | implemented |
| N05 | Recoverable writes (crash safety)            | M1        | implemented (local) |
| N06 | Large-PDF performance                        | M7        | planned     |
| N07 | Accessibility / keyboard                     | M7        | planned     |
| N08 | Reproducible, committed fixtures             | M0        | implemented |
