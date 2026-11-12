import type { BrainData, BrainId, BrainManifest } from "../model";

/**
 * StorageAdapter is the boundary between the app and whatever persists a brain
 * (spec sections 14, 20, D09). The app NEVER talks to IndexedDB / OPFS / WebDAV
 * directly; it goes through this interface so storage back-ends are pluggable
 * (LocalFileStorageAdapter now; Koofr/WebDAV deferred to M4).
 */
export interface StorageAdapter {
  /** List the brain ids currently available in this store. */
  listBrains(): Promise<BrainId[]>;

  /**
   * Read a brain's full structured data. Returns null if the brain does not
   * exist. Throws SchemaVersionError if the stored schema version is newer than
   * this build supports.
   */
  readBrain(brainId: BrainId): Promise<BrainData | null>;

  /**
   * Write a brain's full structured data using a safe-publication sequence
   * (spec section 15): write the new payload, verify it read back correctly,
   * then advance the published pointer LAST. A crash mid-write must never leave
   * a brain pointing at a partial payload.
   */
  writeBrain(data: BrainData): Promise<void>;

  /** Read a stored binary asset (e.g. PDF bytes). Null if absent. */
  readAsset(brainId: BrainId, assetId: string): Promise<Uint8Array | null>;

  /** Write a binary asset with write-then-verify. */
  writeAsset(brainId: BrainId, assetId: string, bytes: Uint8Array): Promise<void>;

  /**
   * Delete ONLY the stored binary asset bytes for an asset id (offline-first
   * eviction, A17). It is a no-op when the asset is already absent. Structured
   * records (Source / Annotation / EvidenceInstance) are NEVER touched here;
   * this reclaims local space while leaving every citation functional from its
   * stored metadata.
   */
  deletePdfBinary(brainId: BrainId, assetId: string): Promise<void>;

  /**
   * Hook invoked to migrate a stored manifest from an older schema version to
   * the current one. Implementations register migrations keyed by source
   * version; the default is identity + version bump when no migration is
   * registered and the gap is one minor step the build understands.
   */
  migrate(manifest: BrainManifest, data: BrainData): Promise<BrainData>;
}

/** Thrown when stored data is newer than the running build can understand. */
export class SchemaVersionError extends Error {
  constructor(
    readonly storedVersion: number,
    readonly supportedVersion: number,
  ) {
    super(
      `Stored schema version ${storedVersion} is newer than supported version ${supportedVersion}; upgrade the app.`,
    );
    this.name = "SchemaVersionError";
  }
}

/** Thrown when a write-then-verify read-back does not match what was written. */
export class WriteVerificationError extends Error {
  constructor(detail: string) {
    super(`Write verification failed: ${detail}`);
    this.name = "WriteVerificationError";
  }
}

/**
 * A migration function transforms brain data from one schema version to the
 * next. Keyed by the FROM version in the migration registry.
 */
export type Migration = (data: BrainData) => BrainData | Promise<BrainData>;
