/**
 * KoofrStorageAdapter (M4, spec section 15, D08).
 *
 * A pluggable WebDAV client for the Koofr publication layout. It is NOT a full
 * StorageAdapter: Koofr is the REMOTE delivery/hosting target that the PC
 * publishes to and that a phone refreshes from, so this class exposes the
 * WebDAV primitives (PUT / GET / PROPFIND / MKCOL) plus higher-level helpers
 * for the four remote object kinds:
 *
 *   snapshots/rev-<n>.json     immutable per-revision brain snapshot
 *   assets/<assetId>           binary PDF / snapshot assets
 *   captures/<captureId>.json  individual mobile capture items
 *   current-revision.json      the atomic revision pointer (written LAST)
 *
 * Credentials are STRICTLY runtime/session provided through the constructor
 * config; nothing is ever hardcoded. The transport is injectable via
 * `fetchImpl` so the adapter is unit-testable against a fake fetch (and so a
 * packaged app can thread an authenticated intermediary). Request/header shapes
 * follow scripts/koofr-probe.mjs (Authorization Basic, Depth header, and
 * Content-Type application/xml for PROPFIND).
 */

/** Runtime configuration for a Koofr/WebDAV endpoint. Credentials are never hardcoded. */
export interface KoofrConfig {
  /** The WebDAV collection base URL, e.g. https://app.koofr.net/dav/Koofr. */
  readonly baseUrl: string;
  /** Koofr account username (session/runtime-provided). Optional for anonymous. */
  readonly username?: string;
  /** Koofr APPLICATION password (session/runtime-provided). Optional for anonymous. */
  readonly appPassword?: string;
  /** Injectable fetch transport so the adapter is unit-testable with a fake fetch. */
  readonly fetchImpl?: typeof fetch;
}

/** The parsed pointer stored in current-revision.json. */
export interface RemotePointer {
  readonly publicationRevision: number;
  /** sha256 hex of the snapshot JSON bytes, so a refresh can verify integrity. */
  readonly snapshotHash: string;
  readonly updatedAt: string;
}

const JSON_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export class KoofrStorageAdapter {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authHeader: string | null;

  constructor(config: KoofrConfig) {
    // Strip a trailing slash so path joins are predictable.
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    // Use the injected transport when provided; otherwise the global fetch.
    this.fetchImpl = config.fetchImpl ?? fetch;
    // Build a Basic auth header ONLY from the passed credentials; never hardcode.
    this.authHeader =
      config.username && config.appPassword
        ? "Basic " + base64(`${config.username}:${config.appPassword}`)
        : null;
  }

  // -- low-level WebDAV primitives -----------------------------------------

  private url(path: string): string {
    const clean = path.replace(/^\/+/, "");
    return `${this.baseUrl}/${clean}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...(extra ?? {}) };
    if (this.authHeader) h["Authorization"] = this.authHeader;
    return h;
  }

  /** Write bytes (or a string) to a path. Throws on a non-2xx response. */
  async put(path: string, body: Uint8Array | string, contentType: string): Promise<void> {
    const bytes = typeof body === "string" ? JSON_ENCODER.encode(body) : body;
    // Copy into a plain ArrayBuffer so the body is an unambiguous BodyInit
    // (sidesteps the Uint8Array<ArrayBufferLike> vs BodyInit generic mismatch).
    const payload = bytes.slice().buffer as ArrayBuffer;
    const res = await this.fetchImpl(this.url(path), {
      method: "PUT",
      headers: this.headers({ "Content-Type": contentType }),
      body: payload,
    });
    if (!res.ok) {
      throw new Error(`Koofr PUT ${path} failed: ${res.status} ${res.statusText}`);
    }
  }

  /** Read bytes from a path. Returns null on 404; throws on other non-2xx. */
  async get(path: string): Promise<Uint8Array | null> {
    const res = await this.fetchImpl(this.url(path), {
      method: "GET",
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Koofr GET ${path} failed: ${res.status} ${res.statusText}`);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  /** Read a path as UTF-8 text. Returns null on 404. */
  async getText(path: string): Promise<string | null> {
    const bytes = await this.get(path);
    return bytes === null ? null : TEXT_DECODER.decode(bytes);
  }

  /**
   * PROPFIND depth-1 listing of a collection. Returns the href strings found in
   * the multistatus body (best-effort XML scrape; the body shape is Koofr's).
   * Returns [] on 404 (missing collection).
   */
  async propfind(path: string): Promise<string[]> {
    const res = await this.fetchImpl(this.url(path), {
      method: "PROPFIND",
      headers: this.headers({ Depth: "1", "Content-Type": "application/xml" }),
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/></d:prop></d:propfind>`,
    });
    if (res.status === 404) return [];
    if (!res.ok) {
      throw new Error(`Koofr PROPFIND ${path} failed: ${res.status} ${res.statusText}`);
    }
    const xml = await res.text();
    return parseHrefs(xml);
  }

  /** Create a collection. Tolerant of an already-existing collection (405/409). */
  async mkcol(path: string): Promise<void> {
    const res = await this.fetchImpl(this.url(path), {
      method: "MKCOL",
      headers: this.headers(),
    });
    // 201 Created on success; 405 Method Not Allowed / 409 Conflict are the
    // common "already exists" responses which we deliberately tolerate.
    if (res.ok || res.status === 405 || res.status === 409) return;
    throw new Error(`Koofr MKCOL ${path} failed: ${res.status} ${res.statusText}`);
  }

  // -- publication-layout helpers ------------------------------------------

  /** Ensure the publication collections exist (idempotent). */
  async ensureLayout(): Promise<void> {
    await this.mkcol("snapshots");
    await this.mkcol("assets");
    await this.mkcol("captures");
  }

  snapshotPath(publicationRevision: number): string {
    return `snapshots/rev-${publicationRevision}.json`;
  }

  async writeSnapshot(publicationRevision: number, json: string): Promise<void> {
    await this.put(this.snapshotPath(publicationRevision), json, "application/json");
  }

  async readSnapshot(publicationRevision: number): Promise<string | null> {
    return this.getText(this.snapshotPath(publicationRevision));
  }

  assetPath(assetId: string): string {
    return `assets/${assetId}`;
  }

  async writeAsset(assetId: string, bytes: Uint8Array): Promise<void> {
    await this.put(this.assetPath(assetId), bytes, "application/octet-stream");
  }

  async readAsset(assetId: string): Promise<Uint8Array | null> {
    return this.get(this.assetPath(assetId));
  }

  /** True when an asset already exists remotely (so it need not be re-uploaded). */
  async hasAsset(assetId: string): Promise<boolean> {
    const bytes = await this.get(this.assetPath(assetId));
    return bytes !== null;
  }

  capturePath(captureId: string): string {
    return `captures/${captureId}.json`;
  }

  async writeCapture(captureId: string, json: string): Promise<void> {
    await this.put(this.capturePath(captureId), json, "application/json");
  }

  async readCapture(captureId: string): Promise<string | null> {
    return this.getText(this.capturePath(captureId));
  }

  /** List the capture ids present under captures/ (strips the .json suffix). */
  async listCaptureIds(): Promise<string[]> {
    const hrefs = await this.propfind("captures");
    const ids: string[] = [];
    for (const href of hrefs) {
      const name = href.replace(/\/+$/, "").split("/").pop() ?? "";
      const m = /^(.+)\.json$/.exec(decodeURIComponent(name));
      if (m && m[1]) ids.push(m[1]);
    }
    return ids;
  }

  // -- the atomic revision pointer (written LAST) --------------------------

  async readPointer(): Promise<RemotePointer | null> {
    const text = await this.getText("current-revision.json");
    if (text === null) return null;
    try {
      const parsed = JSON.parse(text) as RemotePointer;
      if (typeof parsed.publicationRevision !== "number") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async writePointer(pointer: RemotePointer): Promise<void> {
    await this.put("current-revision.json", JSON.stringify(pointer), "application/json");
  }
}

/** Base64-encode a UTF-8 string in both browser and Node runtimes. */
function base64(input: string): string {
  if (typeof btoa === "function") {
    // btoa needs a binary (latin1) string; encode UTF-8 bytes first.
    const bytes = JSON_ENCODER.encode(input);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  }
  // Node fallback.
  return Buffer.from(input, "utf-8").toString("base64");
}

/** Scrape <d:href> values out of a WebDAV multistatus XML body (best-effort). */
function parseHrefs(xml: string): string[] {
  const out: string[] = [];
  const re = /<[a-z0-9]*:?href>\s*([^<]+?)\s*<\/[a-z0-9]*:?href>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}
