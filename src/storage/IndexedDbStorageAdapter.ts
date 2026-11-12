import { openDB, type IDBPDatabase } from "idb";
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  type BrainData,
  type BrainId,
  type BrainManifest,
} from "../model";
import type { AnchorResolution, Annotation, Source } from "../model";
import {
  SchemaVersionError,
  WriteVerificationError,
  type Migration,
  type StorageAdapter,
} from "./StorageAdapter";

const DB_NAME = "ito";
const DB_VERSION = 1;

/** Object store names. */
const STORE_PAYLOAD = "payloads"; // staged + published brain payloads
const STORE_POINTER = "pointers"; // published-pointer per brain (written LAST)
const STORE_ASSETS = "assets"; // binary assets keyed by `${brainId}/${assetId}`

type StoredPayload = {
  readonly key: string; // `${brainId}:${slot}` where slot is "staged" | published rev
  readonly data: BrainData;
};

type StoredPointer = {
  readonly brainId: string;
  readonly publishedKey: string; // which payload key is the live one
};

/**
 * IndexedDbStorageAdapter persists a brain to the browser using IndexedDB for
 * structured records and binary assets (PDF bytes). (Formerly named
 * `LocalFileStorageAdapter`, which was misleading — it has never touched OPFS
 * or the filesystem; the implementation is pure IndexedDB via `idb`.)
 *
 * It implements the safe-publication shape from spec section 15 even locally:
 *
 *   1. Write the new payload to a STAGED key.
 *   2. Read it back and verify it matches (write-then-verify).
 *   3. Advance the published pointer LAST, in a separate transaction, to point
 *      at the staged payload.
 *
 * A crash between (1) and (3) leaves the old published pointer intact, so a
 * brain never ends up pointing at a partial payload.
 */
export class IndexedDbStorageAdapter implements StorageAdapter {
  private dbPromise: Promise<IDBPDatabase> | null = null;
  private readonly migrations: Map<number, Migration> = new Map();

  constructor(migrations?: Iterable<readonly [number, Migration]>) {
    // Seed with the shared model-layer migration steps (the SAME registry the
    // pure migrateBrainData runner uses) so a v1 brain read from IndexedDB and
    // a restored backup migrate identically. Explicit overrides win.
    for (const [from, fn] of MIGRATIONS) this.migrations.set(from, fn);
    if (migrations) {
      for (const [from, fn] of migrations) this.migrations.set(from, fn);
    }
  }

  /** Register a migration from schema version `from` to `from + 1`. */
  registerMigration(from: number, migration: Migration): void {
    this.migrations.set(from, migration);
  }

  private db(): Promise<IDBPDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDB(DB_NAME, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(STORE_PAYLOAD)) {
            db.createObjectStore(STORE_PAYLOAD, { keyPath: "key" });
          }
          if (!db.objectStoreNames.contains(STORE_POINTER)) {
            db.createObjectStore(STORE_POINTER, { keyPath: "brainId" });
          }
          if (!db.objectStoreNames.contains(STORE_ASSETS)) {
            db.createObjectStore(STORE_ASSETS);
          }
        },
      });
    }
    return this.dbPromise;
  }

  async listBrains(): Promise<BrainId[]> {
    const db = await this.db();
    const pointers = (await db.getAll(STORE_POINTER)) as StoredPointer[];
    return pointers.map((p) => p.brainId as BrainId);
  }

  async readBrain(brainId: BrainId): Promise<BrainData | null> {
    const db = await this.db();
    const pointer = (await db.get(STORE_POINTER, brainId)) as
      | StoredPointer
      | undefined;
    if (!pointer) return null;

    const stored = (await db.get(STORE_PAYLOAD, pointer.publishedKey)) as
      | StoredPayload
      | undefined;
    if (!stored) return null;

    const data = stored.data;
    const stored_version = data.manifest.schemaVersion;

    if (stored_version > SCHEMA_VERSION) {
      throw new SchemaVersionError(stored_version, SCHEMA_VERSION);
    }
    if (stored_version < SCHEMA_VERSION) {
      return this.migrate(data.manifest, data);
    }
    return data;
  }

  async writeBrain(data: BrainData): Promise<void> {
    const db = await this.db();
    const brainId = data.manifest.brainId;

    // (1) Write to a staged key, distinct from any live payload.
    const stagedKey = stagedKeyFor(brainId, data.manifest.publicationRevision);
    const payload: StoredPayload = { key: stagedKey, data };
    {
      const tx = db.transaction(STORE_PAYLOAD, "readwrite");
      await tx.store.put(payload);
      await tx.done;
    }

    // (2) Write-then-verify: read the staged payload back and compare.
    const readBack = (await db.get(STORE_PAYLOAD, stagedKey)) as
      | StoredPayload
      | undefined;
    if (!readBack) {
      throw new WriteVerificationError(`staged payload ${stagedKey} missing after write`);
    }
    if (
      readBack.data.manifest.brainId !== brainId ||
      readBack.data.manifest.publicationRevision !== data.manifest.publicationRevision
    ) {
      throw new WriteVerificationError(`staged payload ${stagedKey} does not match written data`);
    }

    // (3) Advance the published pointer LAST, in its own transaction.
    const pointer: StoredPointer = { brainId, publishedKey: stagedKey };
    {
      const tx = db.transaction(STORE_POINTER, "readwrite");
      await tx.store.put(pointer);
      await tx.done;
    }

    // (4) Only now that the pointer is advanced, drop superseded payloads for
    // this brain. Every write stores a FULL brain copy, so without this the
    // store grows by one complete snapshot per keystroke-save. Only strictly
    // older revisions are removed; the live payload is never touched.
    await this.collectSupersededPayloads(brainId, data.manifest.publicationRevision);
  }

  private async collectSupersededPayloads(brainId: BrainId, liveRevision: number): Promise<void> {
    const db = await this.db();
    const prefix = stagedKeyPrefix(brainId);
    const tx = db.transaction(STORE_PAYLOAD, "readwrite");
    const keys = (await tx.store.getAllKeys(
      IDBKeyRange.bound(prefix, `${prefix}\uffff`),
    )) as string[];
    // Delegate the "which keys are strictly older than the live revision"
    // decision to a pure, unit-tested helper so the deletion policy is pinned
    // without an IndexedDB round-trip.
    for (const key of supersededStagedKeys(keys, liveRevision, brainId)) {
      await tx.store.delete(key);
    }
    await tx.done;
  }

  /** Test/diagnostic helper: the payload keys currently stored for a brain. */
  async payloadKeysForTest(brainId: BrainId): Promise<string[]> {
    const db = await this.db();
    const prefix = stagedKeyPrefix(brainId);
    return (await db.getAllKeys(
      STORE_PAYLOAD,
      IDBKeyRange.bound(prefix, `${prefix}\uffff`),
    )) as string[];
  }

  async readAsset(brainId: BrainId, assetId: string): Promise<Uint8Array | null> {
    const db = await this.db();
    const value = (await db.get(STORE_ASSETS, assetKey(brainId, assetId))) as
      | Uint8Array
      | undefined;
    return value ?? null;
  }

  async writeAsset(brainId: BrainId, assetId: string, bytes: Uint8Array): Promise<void> {
    const db = await this.db();
    const key = assetKey(brainId, assetId);
    {
      const tx = db.transaction(STORE_ASSETS, "readwrite");
      await tx.store.put(bytes, key);
      await tx.done;
    }
    // Write-then-verify by byte length (cheap integrity check for M0).
    const readBack = (await db.get(STORE_ASSETS, key)) as Uint8Array | undefined;
    if (!readBack || readBack.byteLength !== bytes.byteLength) {
      throw new WriteVerificationError(`asset ${key} read-back length mismatch`);
    }
  }

  /**
   * Delete only the stored binary asset bytes (A17 offline eviction). No-op if
   * the key is absent; never touches payloads/pointers (structured records).
   */
  async deletePdfBinary(brainId: BrainId, assetId: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_ASSETS, "readwrite");
    await tx.store.delete(assetKey(brainId, assetId));
    await tx.done;
  }

  /**
   * Apply registered migrations stepwise from the stored version up to
   * SCHEMA_VERSION. If no migration is registered for a step, the data is
   * passed through unchanged and only the manifest version is advanced — this
   * keeps additive/compatible changes cheap while leaving a hook for real
   * transforms.
   */
  async migrate(manifest: BrainManifest, data: BrainData): Promise<BrainData> {
    let current: BrainData = data;
    let version = manifest.schemaVersion;

    while (version < SCHEMA_VERSION) {
      const migration = this.migrations.get(version);
      if (migration) {
        current = await migration(current);
      }
      version += 1;
      current = {
        ...current,
        manifest: { ...current.manifest, schemaVersion: version },
      };
    }
    return current;
  }
}

function assetKey(brainId: BrainId, assetId: string): string {
  return `${brainId}/${assetId}`;
}

/** The shared staged-payload key prefix for a brain (`${brainId}:staged:`). */
export function stagedKeyPrefix(brainId: BrainId): string {
  return `${brainId}:staged:`;
}

/** The staged-payload key for a specific brain + publication revision. */
export function stagedKeyFor(brainId: BrainId, revision: number): string {
  return `${stagedKeyPrefix(brainId)}${revision}`;
}

/**
 * Pure selection of the staged payload keys that are SUPERSEDED by the live
 * revision and therefore safe to delete. A key is superseded only when its
 * parsed revision is a finite number STRICTLY LESS than `liveRevision`; the
 * live key (and anything newer, or anything unparseable) is always kept. This
 * is the single source of truth for the cleanup-on-write deletion policy, kept
 * pure so it can be unit-tested without an IndexedDB round-trip.
 */
export function supersededStagedKeys(
  keys: readonly string[],
  liveRevision: number,
  brainId: BrainId,
): string[] {
  const prefix = stagedKeyPrefix(brainId);
  return keys.filter((key) => {
    if (!key.startsWith(prefix)) return false;
    const rev = Number(key.slice(prefix.length));
    return Number.isFinite(rev) && rev < liveRevision;
  });
}

/**
 * Explicit unresolved / mismatched anchor handling hooks (spec invariant:
 * unresolved sources/anchors must be explicit, never silently dropped). These
 * live here so storage round-trips surface anchor health rather than hiding it.
 */
export function resolveAnnotationAgainstSource(
  annotation: Annotation,
  source: Source | undefined,
): AnchorResolution {
  if (!source) {
    return { kind: "unresolved", reason: "source not loaded" };
  }
  const expected =
    annotation.scope.kind === "text"
      ? annotation.scope.anchor.sourceVersionHash
      : annotation.scope.anchor.sourceVersionHash;

  if (expected !== source.versionHash) {
    return {
      kind: "mismatched",
      reason: "source version hash changed since annotation was created",
      expectedVersionHash: expected,
      actualVersionHash: source.versionHash,
    };
  }
  return { kind: "resolved" };
}
