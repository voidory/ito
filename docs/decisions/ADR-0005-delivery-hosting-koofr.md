# ADR-0005: Delivery/hosting + Koofr CORS/auth

- Status: OPEN
- Spec references: decision D08; sections 14, 24

## Context

The app is a browser SPA. How it is hosted and whether an authenticated browser
can read/list/write a Koofr/WebDAV store directly (including CORS) is not yet
settled. This materially affects whether "static hosting only" is viable or
whether an authenticated intermediary / packaged app is required.

## Decision (deferred — informed by the M0 spike)

This decision remains OPEN, but the M0 Koofr access spike (FEAT-002) has now run
and its result is recorded here as the D08 decision input. See
`docs/spikes/koofr-access.md` and the runnable probe `scripts/koofr-probe.mjs`
(`npm run koofr-probe`).

**M0 spike outcome: UNTESTABLE for authenticated access (outcome c), with a
negative CORS signal.** No Koofr credentials were available in the sandbox, so
authenticated WebDAV list/read/write could not be exercised. The endpoint is
reachable (an unauthenticated `OPTIONS` preflight returned HTTP `401`, not a
network error), but that preflight returned **no `access-control-*` headers**,
which is concrete evidence that a static browser SPA calling Koofr WebDAV
cross-origin is unlikely to work out of the box.

**Working stance:** do NOT assume static-only browser access to Koofr. For M1
the local storage adapter (ADR-0004) is the path; any Koofr live-sync (M4) will
most likely need a fallback — manual import/export, an authenticated
intermediary/proxy, or a packaged app — per spec section 15. A definitive
verified/blocked determination awaits a probe run with real credentials.

Koofr *implementation* is M4, out of M0-M1 scope.

## Consequences

- We assume nothing about static-only delivery; the negative CORS signal means a
  fallback is the likely requirement for any browser-based live sync.
- The storage boundary (ADR-0004) keeps the local adapter independent of this
  decision, so delivery/hosting can be chosen late (M4) without disturbing
  M0-M1.

## OPEN

- Hosting target (static host vs packaged app vs intermediary).
- Final Koofr/WebDAV CORS + auth verdict from a browser with real credentials
  (re-run `npm run koofr-probe`); the M0 signal points toward needing a
  fallback.
- CSP and worker/wasm hosting constraints for pdf.js under the chosen host.
