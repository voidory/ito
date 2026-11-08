/**
 * Data model barrel. See types.ts for the full section-20 contract and the
 * invariant map, ids.ts for durable id generation, citation.ts for derived
 * citation status.
 */

/**
 * Current logical schema version. Stored on BrainManifest and checked by the
 * storage adapter; bumping it requires a migration (see src/storage).
 */
export const SCHEMA_VERSION = 1 as const;

export * from "./ids";
export * from "./types";
export * from "./citation";
export * from "./brain";
