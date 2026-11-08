# ito

Research PDF reader + source-local annotation + deliberate subject pages +
concept network. Browser SPA with strict data/app separation behind a pluggable
storage adapter.

> M0 scaffold. The visible READY/ERROR state is a safeguard, not a substitute
> for runtime tests (spec section 24). See `docs/PLAN.md` and
> `docs/decisions/`.

## Requirements

- Node 22 (see `.nvmrc`)

## Setup

```bash
npm install
npx playwright install chromium   # first run only, for e2e
```

## Scripts

| Command                 | What it does                                        |
| ----------------------- | --------------------------------------------------- |
| `npm run dev`           | Start the Vite dev server.                          |
| `npm run build`         | Type-check (`tsc --noEmit`) then `vite build`.      |
| `npm run typecheck`     | `tsc --noEmit` only.                                |
| `npm run test`          | Run Vitest (unit/integration) once.                 |
| `npm run test:watch`    | Run Vitest in watch mode.                           |
| `npm run test:e2e`      | Run Playwright (chromium) real-browser tests.       |
| `npm run gen-fixtures`  | Regenerate the PDF test fixtures (see below).        |

## Test fixtures

Real PDFs with a selectable text layer live under `src/test/fixtures/` and are
generated reproducibly by `scripts/gen-fixtures.mjs` (pdf-lib):

- `sample-3page.pdf` — 3+ pages of ordinary selectable text.
- `sample-multicol.pdf` — a two-column layout.
- `sample-rotated.pdf` — rotated pages (90/180/270).

Regenerate with:

```bash
npm run gen-fixtures
```

The generated PDFs are committed for test stability.

## Layout

- `src/model/` — section-20 data contract types + durable ids.
- `src/storage/` — `StorageAdapter` interface + `LocalFileStorageAdapter`.
- `src/app/` — app shell (READY/ERROR state).
- `src/test/` — Vitest tests + fixtures.
- `e2e/` — Playwright real-browser tests.
- `scripts/` — fixture generation.
- `docs/` — decisions (ADRs), plan, backlog, requirement→test map.
