# M0 spike: Koofr browser access assessment (CORS / credentials / phone)

- Status: **UNTESTABLE for authenticated access (outcome c)**, with a concrete
  CORS signal pointing against seamless static-only browser access.
- Feature: FEAT-002 · Spec: sections 14, 15, 24 · decision **D08** / **ADR-0005**
- Probe: `scripts/koofr-probe.mjs` (runnable) · `npm run koofr-probe`
- Koofr *implementation* is M4. This is the **M0 assessment only**.

## Goal

Independently and honestly assess whether an authenticated browser SPA can
list / read / write a Koofr store over WebDAV, including whether CORS and
credential handling permit it — without promising seamless static-only
delivery. Report one of: (a) verified, (b) blocked, or (c) untestable.

## Method (what was actually run)

`scripts/koofr-probe.mjs` is a real network probe (not a mock). It reads
credentials **only from environment variables** so nothing secret is ever
committed:

- `KOOFR_WEBDAV_URL` (default `https://app.koofr.net/dav/Koofr`)
- `KOOFR_USERNAME`, `KOOFR_PASSWORD` (a Koofr **application password**)
- `KOOFR_ORIGIN` (optional, to probe CORS from a given browser origin)

With credentials it performs: a CORS `OPTIONS` preflight for `PROPFIND`, a
`PROPFIND` list (depth 1), a `PUT` write of a tiny probe file, a `GET` read-back,
and a `DELETE` cleanup — capturing status, `access-control-*` headers, and a
short body sample for each. Without credentials it still issues an
unauthenticated `OPTIONS` preflight to learn reachability + advertised CORS.

Run in this sandbox:

```
$ node scripts/koofr-probe.mjs
```

## Executed result (actual output)

No Koofr credentials are present in this sandbox, so the authenticated probe
could not run. The probe's real output:

```json
{
  "probedAt": "2026-11-08T22:45:05.200Z",
  "webdavUrl": "https://app.koofr.net/dav/Koofr",
  "credentialsProvided": false,
  "originProvided": false,
  "node": "v22.23.4",
  "steps": [
    {
      "label": "OPTIONS (unauthenticated preflight)",
      "ok": false,
      "status": 401,
      "statusText": "Unauthorized",
      "cors": {},
      "ms": 540
    }
  ],
  "outcome": "untestable",
  "notes": [
    "No KOOFR_USERNAME / KOOFR_PASSWORD in the environment; cannot perform an authenticated probe. ..."
  ]
}
```

### What this does and does NOT establish

- **Reachability:** the Koofr WebDAV endpoint is reachable from the sandbox —
  the `OPTIONS` request returned an HTTP `401 Unauthorized` (a server response),
  not a DNS/connection/network error.
- **CORS signal (important):** the preflight came back with **no
  `access-control-allow-*` headers at all** (`"cors": {}`) and a `401`. A
  browser performing a cross-origin preflight for a non-simple method
  (`PROPFIND`/`PUT` with an `Authorization` header) requires the server to
  answer the `OPTIONS` preflight with permissive `access-control-allow-origin` /
  `-methods` / `-headers` / `-credentials`. The absence of those headers here is
  concrete evidence that a **static browser SPA calling Koofr WebDAV
  cross-origin is unlikely to work out of the box.** (This is a preflight-level
  observation and is not changed by having valid credentials.)
- **Outcome (c), honestly:** authenticated list/read/write **could not be
  tested** because no credentials/endpoint were available in this environment.
  We therefore make **no claim of verified working access** and, equally, no
  claim of seamless static-only browser access.

To complete a (a)/(b) determination later, set the env vars above (a Koofr app
password) and re-run `npm run koofr-probe`; the report will self-update to
`verified` or `blocked` with the specific evidence/error. Note that a successful
**Node** probe verifies the API + credentials but NOT the browser case, because
Node does not enforce CORS — browser feasibility is judged from the `OPTIONS`
step's `access-control-*` headers.

## Fallbacks (spec section 15) and their consequences

Because direct static-only browser access is unverified and the CORS signal is
negative, the viable paths are:

1. **Manual import / export.** The user downloads from Koofr and imports the
   file into the app (and exports back) by hand.
   - *Consequence:* no live sync; simplest to ship; works with pure static
     hosting and zero Koofr CORS cooperation. Good M1-era default.
2. **Authenticated intermediary / proxy.** A small server-side component holds
   the Koofr credentials (or an OAuth token) and exposes a same-origin,
   CORS-clean API the SPA calls.
   - *Consequence:* removes the browser CORS problem and keeps secrets off the
     client, but adds a hosted backend (no longer "static only"), plus its own
     auth, deployment, and trust surface.
3. **Packaged app** (desktop/Electron-style or a browser extension with host
   permissions).
   - *Consequence:* can talk WebDAV directly without browser CORS limits and can
     store credentials in an OS keystore, but changes the distribution model and
     platform story entirely.

The storage-adapter boundary (ADR-0004) deliberately keeps the local adapter
independent of this choice, so delivery/hosting can be decided late (M4) without
disturbing M0–M1.

## Decision input (D08 / ADR-0005)

Recorded against ADR-0005: **do not assume static-only browser access to Koofr.**
The only runtime evidence so far (an unauthenticated preflight returning `401`
with no CORS headers) points toward needing a fallback (manual import for M1;
intermediary or packaged app for a live-sync M4). A definitive (a)/(b) call
awaits a run with real credentials via `npm run koofr-probe`.

## Secrets

No credentials or tokens are committed. The probe reads them from environment
variables only; the committed output above contains none.

## Gating

**Koofr does NOT gate M1** (its implementation is M4). This assessment is
recorded; M1 proceeds on the local storage adapter (ADR-0004).
