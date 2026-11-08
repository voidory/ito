# ADR-0005: Delivery/hosting + Koofr CORS/auth

- Status: OPEN
- Spec references: decision D08; sections 14, 24

## Context

The app is a browser SPA. How it is hosted and whether an authenticated browser
can read/list/write a Koofr/WebDAV store directly (including CORS) is not yet
settled. This materially affects whether "static hosting only" is viable or
whether an authenticated intermediary / packaged app is required.

## Decision (deferred)

This decision is OPEN. The M0 Koofr access spike is tracked in **FEAT-002** and
MUST honestly report whether authenticated browser read/list/write + CORS work
from the sandbox. The result (and any fallback: manual import / authenticated
intermediary / packaged app) will be recorded against this ADR. Koofr
*implementation* is M4, out of M0-M1 scope.

## Consequences

- Until the spike resolves, we assume nothing about static-only delivery.
- The storage boundary (ADR-0004) keeps the local adapter independent of this
  decision, so delivery/hosting can be chosen late.

## OPEN

- Hosting target (static host vs packaged app vs intermediary).
- Koofr/WebDAV CORS + auth feasibility from a browser (FEAT-002 spike result).
- CSP and worker/wasm hosting constraints for pdf.js under the chosen host.
