/**
 * Pure, stepwise schema migration runner (M3, A19).
 *
 * `migrateBrainData(raw)` takes an UNKNOWN value read from storage (an older
 * brain payload, a restored backup, or a hand-authored fixture) and returns a
 * fully-populated, current-version BrainData. It validates the input shape,
 * applies registered migration STEPS keyed by their FROM version from the
 * stored version up to SCHEMA_VERSION, and fills any missing optional
 * collections / presentation fields with the canonical defaults from
 * createEmptyBrainData so no downstream reader ever sees a hole.
 *
 * The steps match the existing StorageAdapter.Migration shape
 * (`(data: BrainData) => BrainData | Promise<BrainData>`) so the SAME registry
 * can be handed to LocalFileStorageAdapter.registerMigration and to this pure
 * runner. The additive v0 -> v1 and v1 -> v2 steps only bump the version and
 * default new fields (near-identity), because every M3 contract change is
 * additive and optional.
 *
 * It deliberately imports only sibling model modules (no storage/app) so it is
 * usable anywhere and unit-testable in isolation.
 */

import { SCHEMA_VERSION } from "./index";
import { createEmptyBrainData } from "./brain";
import type { Migration } from "../storage/StorageAdapter";
import type { BrainData } from "./types";

/** Thrown when a payload cannot be parsed at all (not an object / no manifest). */
export class UnmigratableError extends Error {
  constructor(detail: string) {
    super(`Cannot migrate brain data: ${detail}`);
    this.name = "UnmigratableError";
  }
}

/**
 * Thrown when a payload's schemaVersion is NEWER than this build supports. A
 * newer payload is never silently downgraded; the caller must upgrade the app.
 */
export class FutureSchemaError extends Error {
  constructor(
    readonly storedVersion: number,
    readonly supportedVersion: number,
  ) {
    super(
      `Stored schema version ${storedVersion} is newer than supported version ${supportedVersion}; upgrade the app.`,
    );
    this.name = "FutureSchemaError";
  }
}

/**
 * The migration registry, keyed by FROM version. Each step receives data whose
 * manifest already reports the FROM version and returns data for the next
 * version; the runner advances `manifest.schemaVersion` after each step so a
 * step body only needs to default its own new fields.
 */
export const MIGRATIONS: ReadonlyMap<number, Migration> = new Map<number, Migration>([
  // v0 -> v1 (legacy). The earliest brains had no annotation-style store and a
  // bare presentation block; the fill-defaults pass below reconstructs them, so
  // this step is a near-identity version bump.
  [0, (data) => data],
  // v1 -> v2 (M3). Additive: the new fields (binary-offloaded resolution,
  // manifest.backupMode/omissions, Revision snapshot fields) are all optional,
  // so no record transform is needed — only the version bump + default fill.
  [1, (data) => data],
]);

/** True when `value` is a non-null object (not an array). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fill any missing OPTIONAL collections and presentation fields with the
 * canonical defaults from createEmptyBrainData, preserving every value already
 * present. The manifest is passed through unchanged (its version is managed by
 * the runner). This is what guarantees a migrated brain has EVERY collection.
 */
function fillDefaults(data: BrainData): BrainData {
  const defaults = createEmptyBrainData(data.manifest);
  return {
    manifest: data.manifest,
    sources: data.sources ?? defaults.sources,
    annotations: data.annotations ?? defaults.annotations,
    evidenceInstances: data.evidenceInstances ?? defaults.evidenceInstances,
    subjectAssociations: data.subjectAssociations ?? defaults.subjectAssociations,
    pages: data.pages ?? defaults.pages,
    categories: data.categories ?? defaults.categories,
    relationships: data.relationships ?? defaults.relationships,
    tentativeAssociations:
      data.tentativeAssociations ?? defaults.tentativeAssociations,
    captures: data.captures ?? defaults.captures,
    revisions: data.revisions ?? defaults.revisions,
    // M7 (H06, H04): additive optional collections; a v2 brain without them
    // reads fine and gets the empty defaults here (no version bump needed).
    checkpoints: data.checkpoints ?? defaults.checkpoints ?? [],
    reflections: data.reflections ?? defaults.reflections ?? [],
    revisionComments: data.revisionComments ?? defaults.revisionComments ?? {},
    // M5 (§16.3, A22): additive optional collection; a v2 brain without it
    // reads fine and gets the empty default here (no version bump needed).
    captureHandlings: data.captureHandlings ?? defaults.captureHandlings ?? [],
    presentation: {
      ...defaults.presentation,
      ...(data.presentation ?? {}),
    },
  };
}

/**
 * Run the migration steps from `fromVersion` up to SCHEMA_VERSION over `data`,
 * advancing the manifest version after each step. Synchronous because every
 * registered step is synchronous; kept tolerant of a step returning a Promise
 * would require async, so steps MUST stay synchronous (they are near-identity).
 */
function runSteps(data: BrainData, fromVersion: number): BrainData {
  let current = data;
  let version = fromVersion;
  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS.get(version);
    if (step) {
      const result = step(current);
      if (result instanceof Promise) {
        throw new UnmigratableError(
          `migration step from v${version} returned a Promise; steps must be synchronous`,
        );
      }
      current = result;
    }
    version += 1;
    current = {
      ...current,
      manifest: { ...current.manifest, schemaVersion: version },
    };
  }
  return current;
}

/**
 * Migrate an unknown stored payload to a fully-populated current-version
 * BrainData. Throws UnmigratableError when the shape is unparseable and
 * FutureSchemaError when the stored version is newer than this build.
 */
export function migrateBrainData(raw: unknown): BrainData {
  if (!isObject(raw)) {
    throw new UnmigratableError("payload is not an object");
  }
  const manifest = raw["manifest"];
  if (!isObject(manifest)) {
    throw new UnmigratableError("payload has no manifest object");
  }
  const storedVersion = manifest["schemaVersion"];
  if (typeof storedVersion !== "number" || !Number.isFinite(storedVersion)) {
    throw new UnmigratableError("manifest.schemaVersion is missing or not a number");
  }
  if (storedVersion > SCHEMA_VERSION) {
    throw new FutureSchemaError(storedVersion, SCHEMA_VERSION);
  }

  // Treat the input as a (possibly partial) BrainData. runSteps advances the
  // version; fillDefaults guarantees every collection + presentation field.
  const migrated = runSteps(raw as unknown as BrainData, storedVersion);
  return fillDefaults(migrated);
}
