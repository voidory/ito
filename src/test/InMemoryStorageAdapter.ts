/**
 * A minimal in-memory StorageAdapter for unit tests. It mirrors the
 * write-then-verify + publish-pointer-last shape of the real adapter closely
 * enough to exercise the workbench, and can be told to FAIL the next write so
 * the draft-retention path (R12) can be tested without a real browser.
 */

import {
  SchemaVersionError,
  type Migration,
  type StorageAdapter,
} from "../storage";
import {
  SCHEMA_VERSION,
  type BrainData,
  type BrainId,
  type BrainManifest,
} from "../model";

export class InMemoryStorageAdapter implements StorageAdapter {
  private brains = new Map<string, BrainData>();
  private assets = new Map<string, Uint8Array>();
  private readonly migrations = new Map<number, Migration>();
  /** When > 0, the next N writeBrain calls throw to simulate a save failure. */
  failNextWrites = 0;

  registerMigration(from: number, migration: Migration): void {
    this.migrations.set(from, migration);
  }

  async listBrains(): Promise<BrainId[]> {
    return [...this.brains.keys()] as BrainId[];
  }

  async readBrain(brainId: BrainId): Promise<BrainData | null> {
    const data = this.brains.get(brainId);
    if (!data) return null;
    if (data.manifest.schemaVersion > SCHEMA_VERSION) {
      throw new SchemaVersionError(data.manifest.schemaVersion, SCHEMA_VERSION);
    }
    // Deep clone so callers can't mutate stored state in place.
    return structuredClone(data);
  }

  async writeBrain(data: BrainData): Promise<void> {
    if (this.failNextWrites > 0) {
      this.failNextWrites -= 1;
      throw new Error("simulated storage failure");
    }
    const clone = structuredClone(data);
    // write-then-verify
    const verify = structuredClone(clone);
    if (verify.manifest.brainId !== clone.manifest.brainId) {
      throw new Error("verify mismatch");
    }
    this.brains.set(clone.manifest.brainId, clone);
  }

  async readAsset(brainId: BrainId, assetId: string): Promise<Uint8Array | null> {
    return this.assets.get(`${brainId}/${assetId}`) ?? null;
  }

  async writeAsset(brainId: BrainId, assetId: string, bytes: Uint8Array): Promise<void> {
    this.assets.set(`${brainId}/${assetId}`, bytes.slice());
  }

  async migrate(_manifest: BrainManifest, data: BrainData): Promise<BrainData> {
    return data;
  }
}
