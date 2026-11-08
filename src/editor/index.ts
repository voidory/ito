/**
 * Editor barrel. `schema.ts` defines the ProseMirror subject-page schema with
 * the typed `evidence` node; `serialize.ts` converts to/from the structured
 * JSON data model that is the durable source of truth (ADR-0002).
 */

export * from "./schema";
export * from "./serialize";
export * from "./compose";
