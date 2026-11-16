# Working in this repo

## Reader & app usability work is governed by a plan

Before changing the reader (`src/app/reader/`), shared UI primitives
(`src/app/ui/`), the app shell menus (`src/app/App.tsx`), find, the sync badge,
library seeding or reading-position persistence, read
`docs/READER-USABILITY-IMPLEMENTATION-PLAN.md` and follow it.

Rules (full text in section 0 of that file):

1. Implement items as specified, by ID (`RU-x.y`); one commit per item, message
   prefixed with the ID.
2. If reality differs from the plan, record it in the plan's Deviation log in the
   same commit. Do not diverge silently.
3. Locate code by symbol, not line number; check anything marked UNVERIFIED.
4. Tests first: turn the item's `test.fixme` in `e2e/reader-usability.spec.ts`
   into a real test.
5. Keep `data-testid`s; add no new inline `style={{}}`; do not touch
   `src/science/` or the synced data model unless the item says so.
6. Update the tracker table in the plan when an item is done.

`docs/ARCHITECTURE.md` (from PR #19) is the living architecture reference. Its
maintenance contract applies: if a change alters module responsibilities, the data
contract, `StorageAdapter`, the Workbench/React store contract, persistence/sync
wiring or adds a cross-cutting gotcha, update it in the same commit. The
Workbench is an observable store; do not reintroduce manual `bump()` plumbing
in new code.

LaTeX extraction (`src/science/`, `src/pdf/tex*`) is paused; do not work on it
unless asked.

## Environment notes

- Do not run `npx playwright install` in the cloud sandbox. Use
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium` (see plan
  section 3.1 and RU-0.2).
- Checks: `npm run typecheck`, `npx vitest run`.
