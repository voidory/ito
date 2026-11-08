// Koofr access probe (FEAT-002 M0 spike, spec sections 14/15, decision D08).
//
// Attempts an authenticated WebDAV list / read / write against Koofr and
// inspects CORS + credential handling, then prints a structured JSON report to
// stdout. It is a RUNNABLE probe, not a mock: it performs real network calls.
//
// CREDENTIALS ARE NEVER COMMITTED. They are read from environment variables:
//   KOOFR_WEBDAV_URL   e.g. https://app.koofr.net/dav/Koofr
//   KOOFR_USERNAME     your Koofr account email
//   KOOFR_PASSWORD     a Koofr *application password* (NOT your login password)
//   KOOFR_ORIGIN       (optional) an Origin header to probe CORS from a browser
//
// Usage:
//   KOOFR_WEBDAV_URL=... KOOFR_USERNAME=... KOOFR_PASSWORD=... \
//     node scripts/koofr-probe.mjs
//
// Honest outcomes (printed as report.outcome):
//   "verified"   — authenticated list/read/write all succeeded (evidence shown)
//   "blocked"    — reached Koofr but auth/CORS/method failed (error shown)
//   "untestable" — no credentials/endpoint available in this environment
//
// For "blocked"/"untestable", consult docs/spikes/koofr-access.md for the
// section-15 fallbacks. Do NOT infer that seamless static-only browser access
// works from a successful server-side (Node) probe: Node does not enforce CORS.

const DEFAULT_URL = "https://app.koofr.net/dav/Koofr";

function env(name) {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : null;
}

function basicAuthHeader(user, pass) {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

function pickCorsHeaders(headers) {
  const keys = [
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "access-control-expose-headers",
  ];
  const out = {};
  for (const k of keys) {
    const v = headers.get(k);
    if (v !== null) out[k] = v;
  }
  return out;
}

async function tryFetch(label, url, init) {
  const started = Date.now();
  try {
    const res = await fetch(url, init);
    // Drain a little of the body so we can show evidence without dumping files.
    let bodySample = "";
    try {
      const text = await res.text();
      bodySample = text.slice(0, 240);
    } catch {
      /* ignore body read errors */
    }
    return {
      label,
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      cors: pickCorsHeaders(res.headers),
      bodySample,
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      label,
      ok: false,
      status: 0,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      ms: Date.now() - started,
    };
  }
}

async function main() {
  const webdavUrl = env("KOOFR_WEBDAV_URL") ?? DEFAULT_URL;
  const username = env("KOOFR_USERNAME");
  const password = env("KOOFR_PASSWORD");
  const origin = env("KOOFR_ORIGIN");

  const report = {
    probedAt: new Date().toISOString(),
    webdavUrl,
    credentialsProvided: Boolean(username && password),
    originProvided: Boolean(origin),
    node: process.version,
    steps: [],
    outcome: "untestable",
    notes: [],
  };

  if (!username || !password) {
    report.outcome = "untestable";
    report.notes.push(
      "No KOOFR_USERNAME / KOOFR_PASSWORD in the environment; cannot perform " +
        "an authenticated probe. This is an expected outcome in a sandbox " +
        "without Koofr credentials. See docs/spikes/koofr-access.md for the " +
        "section-15 fallbacks (manual import / authenticated intermediary / " +
        "packaged app).",
    );
    // Still attempt an UNAUTHENTICATED OPTIONS preflight so we at least learn
    // whether the endpoint is reachable and whether it advertises CORS.
    const base = { headers: {} };
    if (origin) base.headers.Origin = origin;
    const preflight = await tryFetch("OPTIONS (unauthenticated preflight)", webdavUrl, {
      method: "OPTIONS",
      headers: {
        ...base.headers,
        "Access-Control-Request-Method": "PROPFIND",
        "Access-Control-Request-Headers": "authorization,depth,content-type",
      },
    });
    report.steps.push(preflight);
    print(report);
    return;
  }

  const auth = basicAuthHeader(username, password);
  const corsHeaders = origin ? { Origin: origin } : {};

  // 1) CORS preflight for the browser case (what a static SPA would hit first).
  report.steps.push(
    await tryFetch("OPTIONS (CORS preflight for PROPFIND)", webdavUrl, {
      method: "OPTIONS",
      headers: {
        ...corsHeaders,
        "Access-Control-Request-Method": "PROPFIND",
        "Access-Control-Request-Headers": "authorization,depth,content-type",
      },
    }),
  );

  // 2) LIST (WebDAV PROPFIND, depth 1) on the root collection.
  report.steps.push(
    await tryFetch("PROPFIND (list root, depth 1)", webdavUrl, {
      method: "PROPFIND",
      headers: {
        ...corsHeaders,
        Authorization: auth,
        Depth: "1",
        "Content-Type": "application/xml",
      },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/></d:prop></d:propfind>`,
    }),
  );

  // 3) WRITE (PUT) a small probe file.
  const probePath = webdavUrl.replace(/\/$/, "") + "/ito-koofr-probe.txt";
  const probeBody = `ito koofr probe ${report.probedAt}`;
  report.steps.push(
    await tryFetch("PUT (write probe file)", probePath, {
      method: "PUT",
      headers: { ...corsHeaders, Authorization: auth, "Content-Type": "text/plain" },
      body: probeBody,
    }),
  );

  // 4) READ (GET) the probe file back.
  report.steps.push(
    await tryFetch("GET (read probe file back)", probePath, {
      method: "GET",
      headers: { ...corsHeaders, Authorization: auth },
    }),
  );

  // 5) Clean up the probe file (best effort).
  report.steps.push(
    await tryFetch("DELETE (clean up probe file)", probePath, {
      method: "DELETE",
      headers: { ...corsHeaders, Authorization: auth },
    }),
  );

  const list = report.steps.find((s) => s.label.startsWith("PROPFIND"));
  const put = report.steps.find((s) => s.label.startsWith("PUT"));
  const get = report.steps.find((s) => s.label.startsWith("GET"));

  if (list?.ok && put?.ok && get?.ok) {
    report.outcome = "verified";
    report.notes.push(
      "Authenticated WebDAV list/write/read succeeded from Node. NOTE: Node " +
        "does NOT enforce CORS, so this verifies the Koofr WebDAV API + " +
        "credentials, NOT that a browser SPA can call it cross-origin. Inspect " +
        "the OPTIONS step's access-control-* headers to judge browser " +
        "feasibility; absent permissive CORS, a browser SPA still needs a " +
        "fallback (see docs/spikes/koofr-access.md).",
    );
  } else {
    report.outcome = "blocked";
    report.notes.push(
      "One or more authenticated WebDAV operations failed; see the failing " +
        "step's status/error. Consult docs/spikes/koofr-access.md for the " +
        "section-15 fallbacks and their consequences.",
    );
  }

  print(report);
}

function print(report) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((err) => {
  process.stdout.write(
    JSON.stringify(
      { outcome: "blocked", fatal: String(err && err.stack ? err.stack : err) },
      null,
      2,
    ) + "\n",
  );
  process.exit(0);
});
