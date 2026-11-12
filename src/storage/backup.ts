/**
 * Two-lane disentangled backup codec (M3, D09). PURE and DOM-free so Vitest
 * covers every branch with the real fflate dependency:
 *
 *  - LANE 1 (core brain graph): a single `brain.ito.json` text payload built by
 *    `exportCoreBrainJson`. It carries the always-on core graph (manifest +
 *    sources + annotations + subjectAssociations + pages + evidenceInstances +
 *    categories + relationships) plus the OPTIONAL sections (captures,
 *    revisions, shared presentation) gated by the Targeted Backup Checklist.
 *    Omission stamping (A18) records exactly what a targeted backup left out.
 *
 *  - LANE 2 (bundled archive): a `.ito.zip` built by `exportBundleZip` via
 *    fflate `zipSync`, containing `manifest.json`, `brain.json` (the Lane-1
 *    json), and, when `sourceBinaries` is ticked, `assets/<sourceId>-<hash>.pdf`
 *    for each source whose binary is available. `parseBundleZip` is the inverse
 *    via fflate `unzipSync`.
 *
 * The functions operate on a plain BrainData plus an ASSET-BYTE PROVIDER (a Map
 * or lookup), never a StorageAdapter, so they are trivially testable. The
 * workbench wrappers (exportBackup / stageImport / commitStagedImport) are thin
 * glue that pull asset bytes via `storage.readAsset` and persist via
 * `storage.writeBrain`/`writeAsset`.
 *
 * Decision (recorded in the feature findings): fflate@^0.8.3 is installed and
 * importable, so the real zip codec is used; there is NO pure-codec fallback.
 */

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import type {
  BrainData,
  BrainManifest,
  Capture,
  Revision,
  Source,
  SourceId,
} from "../model";

/**
 * The four OPTIONAL Targeted Backup Checklist keys (A18). The core brain graph
 * is ALWAYS on and is not represented here. Each key defaults to `true` (a full
 * backup); unticking a box omits that section and stamps the omission token.
 */
export interface BackupOptions {
  /** Shared presentation state (nodePositions, dragOffsets, ...). */
  readonly presentation: boolean;
  /** Pending Captures & Reflections. */
  readonly captures: boolean;
  /** Revision History. */
  readonly revisions: boolean;
  /** PDF Source Binaries (Lane-2 assets/). */
  readonly sourceBinaries: boolean;
}

/** The default full-backup options (every optional section ticked). */
export const DEFAULT_BACKUP_OPTIONS: BackupOptions = {
  presentation: true,
  captures: true,
  revisions: true,
  sourceBinaries: true,
};

/**
 * The stable omission tokens (A18). These EXACT strings must match across the
 * export, the staging validator, and the e2e spec, so they are centralized.
 */
export const OMISSION_TOKENS = {
  presentation: "presentation",
  captures: "captures",
  revisions: "revisions",
  sourceBinaries: "sourceBinaries",
} as const;

export type OmissionToken = (typeof OMISSION_TOKENS)[keyof typeof OMISSION_TOKENS];

/**
 * The SHARED presentation fields that DO cross devices in a backup (D19). The
 * DEVICE-LOCAL fields (paneWidths, zoom, active3D, suppressMotion) are NEVER
 * exported; only these survive an export/restore across devices.
 */
export const SHARED_PRESENTATION_KEYS = [
  "nodePositions",
  "dragOffsets",
  "categoryBounds",
  "hiddenPageIds",
  "hiddenRelationshipIds",
  "annotationStyles",
] as const;

/** Lightweight source metadata recorded in a Lane-1 export (never the bytes). */
export interface BackupSourceMeta {
  readonly id: SourceId;
  readonly title: string;
  readonly versionHash: string;
  readonly pageCount: number;
  readonly category: string;
  readonly kind: Source["kind"];
  readonly assetId: string;
  readonly importedAt: string;
}

/**
 * Compute the effective options by filling any missing key with the full
 * default (`true`). Callers may pass a partial checklist.
 */
export function resolveBackupOptions(
  options?: Partial<BackupOptions>,
): BackupOptions {
  return {
    presentation: options?.presentation ?? DEFAULT_BACKUP_OPTIONS.presentation,
    captures: options?.captures ?? DEFAULT_BACKUP_OPTIONS.captures,
    revisions: options?.revisions ?? DEFAULT_BACKUP_OPTIONS.revisions,
    sourceBinaries: options?.sourceBinaries ?? DEFAULT_BACKUP_OPTIONS.sourceBinaries,
  };
}

/**
 * Compute the omission tokens for a set of options in STABLE order: an unticked
 * box contributes its token. Order follows the checklist order so the UI badge
 * and the e2e spec can assert a deterministic array.
 */
export function computeOmissions(options: BackupOptions): OmissionToken[] {
  const omissions: OmissionToken[] = [];
  if (!options.presentation) omissions.push(OMISSION_TOKENS.presentation);
  if (!options.captures) omissions.push(OMISSION_TOKENS.captures);
  if (!options.revisions) omissions.push(OMISSION_TOKENS.revisions);
  if (!options.sourceBinaries) omissions.push(OMISSION_TOKENS.sourceBinaries);
  return omissions;
}

/** Project a Source down to the lightweight metadata recorded in a backup. */
function toSourceMeta(source: Source): BackupSourceMeta {
  return {
    id: source.id,
    title: source.title,
    versionHash: source.versionHash,
    pageCount: source.pageCount,
    category: source.category,
    kind: source.kind,
    assetId: source.assetId,
    importedAt: source.importedAt,
  };
}

/**
 * Keep ONLY the shared presentation fields (D19). Returns a plain record so the
 * serialized JSON never carries device-local fields even if BrainData grew new
 * ones. Absent fields are simply omitted.
 */
function sharedPresentation(
  presentation: BrainData["presentation"],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const src = presentation as unknown as Record<string, unknown>;
  for (const key of SHARED_PRESENTATION_KEYS) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out;
}

/** The parsed shape of a Lane-1 brain.ito.json payload. */
export interface CoreBrainJson {
  readonly manifest: BrainManifest;
  readonly sources: readonly BackupSourceMeta[];
  readonly annotations: BrainData["annotations"];
  readonly subjectAssociations: BrainData["subjectAssociations"];
  readonly pages: BrainData["pages"];
  readonly evidenceInstances: BrainData["evidenceInstances"];
  readonly categories: BrainData["categories"];
  readonly relationships: BrainData["relationships"];
  readonly tentativeAssociations: BrainData["tentativeAssociations"];
  /** Present only when the captures box is ticked. */
  readonly captures?: readonly Capture[];
  /** Present only when the revisions box is ticked. */
  readonly revisions?: readonly Revision[];
  /** Shared-only presentation; present only when the presentation box is ticked. */
  readonly presentation?: Record<string, unknown>;
}

/**
 * Build the Lane-1 core brain json (A18 omission-stamped) for the given data +
 * options. Returns both the serialized json text and the STAMPED manifest (so a
 * Lane-2 bundle can reuse the exact manifest in manifest.json).
 */
export function exportCoreBrainJson(
  data: BrainData,
  options?: Partial<BackupOptions>,
): { json: string; manifest: BrainManifest; payload: CoreBrainJson } {
  const resolved = resolveBackupOptions(options);
  const omissions = computeOmissions(resolved);
  const backupMode: BrainManifest["backupMode"] =
    omissions.length === 0 ? "full" : "targeted";

  const manifest: BrainManifest = {
    ...data.manifest,
    backupMode,
    omissions,
  };

  const payload: CoreBrainJson = {
    manifest,
    sources: data.sources.map(toSourceMeta),
    annotations: data.annotations,
    subjectAssociations: data.subjectAssociations,
    pages: data.pages,
    evidenceInstances: data.evidenceInstances,
    categories: data.categories,
    relationships: data.relationships,
    tentativeAssociations: data.tentativeAssociations,
    ...(resolved.captures ? { captures: data.captures } : {}),
    ...(resolved.revisions ? { revisions: data.revisions } : {}),
    ...(resolved.presentation
      ? { presentation: sharedPresentation(data.presentation) }
      : {}),
  };

  return { json: JSON.stringify(payload), manifest, payload };
}

/** The asset-byte provider: a Map keyed by assetId, or a lookup function. */
export type AssetProvider =
  | ReadonlyMap<string, Uint8Array>
  | ((assetId: string) => Uint8Array | undefined);

function lookupAsset(
  provider: AssetProvider | undefined,
  assetId: string,
): Uint8Array | undefined {
  if (!provider) return undefined;
  if (typeof provider === "function") return provider(assetId);
  return provider.get(assetId);
}

/** The entry name for a source's bundled PDF binary: assets/<sourceId>-<hash>.pdf */
export function assetEntryName(sourceId: string, versionHash: string): string {
  return `assets/${sourceId}-${versionHash}.pdf`;
}

/**
 * Build a Lane-2 `.ito.zip` bundle: manifest.json + brain.json + (when the
 * sourceBinaries box is ticked) one `assets/<sourceId>-<versionHash>.pdf` per
 * source whose binary is available from the provider. Pure: it synchronously
 * returns the zip bytes. (Kept `async` so the workbench wrapper and tests can
 * await it uniformly and so a future streaming codec stays signature-compatible.)
 */
export async function exportBundleZip(
  data: BrainData,
  options?: Partial<BackupOptions>,
  assets?: AssetProvider,
): Promise<Uint8Array> {
  const resolved = resolveBackupOptions(options);
  const { json, manifest } = exportCoreBrainJson(data, resolved);

  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "brain.json": strToU8(json),
  };

  if (resolved.sourceBinaries) {
    for (const source of data.sources) {
      const bytes = lookupAsset(assets, source.assetId);
      if (bytes) {
        files[assetEntryName(source.id, source.versionHash)] = bytes;
      }
    }
  }

  // level 0 (store) keeps PDF bytes byte-identical through the round-trip and
  // avoids re-compressing already-compressed PDF streams.
  return zipSync(files, { level: 0 });
}

/** The parsed shape of a Lane-2 bundle. */
export interface ParsedBundle {
  /** Raw manifest.json text (may be absent in a malformed bundle). */
  readonly manifestJson: string | null;
  /** Raw brain.json text (may be absent in a malformed bundle). */
  readonly brainJson: string | null;
  /** assets/<...>.pdf entries keyed by their FULL entry name. */
  readonly assets: Map<string, Uint8Array>;
}

/**
 * Parse a `.ito.zip` bundle back into its parts via fflate `unzipSync`. Throws
 * if the zip headers are corrupt (fflate rejects a bad central directory); the
 * staging validator catches that and reports a hard-reject.
 */
export function parseBundleZip(bytes: Uint8Array): ParsedBundle {
  const entries = unzipSync(bytes);
  const assets = new Map<string, Uint8Array>();
  let manifestJson: string | null = null;
  let brainJson: string | null = null;
  for (const [name, content] of Object.entries(entries)) {
    if (name === "manifest.json") {
      manifestJson = strFromU8(content);
    } else if (name === "brain.json") {
      brainJson = strFromU8(content);
    } else if (name.startsWith("assets/")) {
      assets.set(name, content);
    }
  }
  return { manifestJson, brainJson, assets };
}

export { strFromU8, strToU8 };
