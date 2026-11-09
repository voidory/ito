/**
 * Data model barrel. See types.ts for the full section-20 contract and the
 * invariant map, ids.ts for durable id generation, citation.ts for derived
 * citation status.
 */

/**
 * Current logical schema version. Stored on BrainManifest and checked by the
 * storage adapter; bumping it requires a migration (see src/storage + migrate).
 *
 * Bumped to 2 in M3: the first non-trivial contract change (the new
 * "binary-offloaded" AnchorResolution state plus manifest.backupMode/omissions
 * and the reconstructable Revision snapshot fields). The v1 -> v2 step is
 * additive, so a v1 brain migrates cleanly via migrateBrainData (see
 * migrate.ts); the fields are all optional so already-loaded v1 data still
 * typechecks.
 */
export const SCHEMA_VERSION = 2 as const;

export * from "./ids";
export * from "./types";
export * from "./citation";
export * from "./relationship";
export * from "./brain";
export * from "./migrate";
