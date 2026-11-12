/**
 * Isolated Staging Validator (M3, A19). PURE, in-memory, DOM-free, and NEVER
 * touches the live store: `stageImport` parses an incoming backup (a Lane-2
 * `.ito.zip` byte array, or a bare Lane-1 `brain.ito.json` string/bytes),
 * validates it, and returns a discriminated result; `commitStagedImport` turns
 * a validated result into a committed BrainData + asset map, honoring the
 * 'Try Import Anyway' lenient override.
 *
 * Three outcomes (step 4):
 *
 *  - HARD-REJECT: corrupted zip headers, invalid %PDF- magic on a bundled
 *    asset, or unparseable JSON. Aborts immediately; nothing is committable.
 *  - NEEDS-CONFIRMATION (default-reject): schemaVersion mismatch vs
 *    SCHEMA_VERSION, a PDF versionHash checksum mismatch, or a missing optional
 *    array. Carries a diagnostic report (findings) so the UI can render the
 *    staging report and offer 'Try Import Anyway'. Commits ONLY when lenient.
 *  - READY: a clean bundle; commits normally.
 *
 * The validator re-uses the backup codec (`parseBundleZip`) and the FEAT-001
 * primitives (`sha256Hex`, `hasPdfMagic`, `migrateBrainData`).
 */

import {
  SCHEMA_VERSION,
  createEmptyBrainData,
  migrateBrainData,
  type Annotation,
  type BrainData,
  type EvidenceInstance,
  type SubjectAssociation,
} from "../model";
import { hasPdfMagic, sha256Hex } from "./hash";
import {
  assetEntryName,
  parseBundleZip,
  type ParsedBundle,
} from "./backup";

/** A single diagnostic finding surfaced in the staging report. */
export interface StagingFinding {
  readonly kind:
    | "schema-version-mismatch"
    | "checksum-mismatch"
    | "missing-array"
    | "missing-binary"
    | "referential-integrity";
  readonly message: string;
}

/** The OPTIONAL collections whose absence triggers a default-reject finding. */
const OPTIONAL_ARRAY_KEYS = [
  "captures",
  "revisions",
  "tentativeAssociations",
  "subjectAssociations",
] as const;

/**
 * The staged, in-memory parse of an import. For a non-hard-reject it carries
 * the raw parsed JSON payload plus the parsed asset map (entry-name -> bytes)
 * so the commit step can reconstruct the BrainData + asset writes WITHOUT
 * re-parsing the input.
 */
export type StagedImport =
  | {
      readonly outcome: "hard-reject";
      readonly reason: string;
    }
  | {
      readonly outcome: "needs-confirmation";
      readonly findings: readonly StagingFinding[];
      readonly raw: unknown;
      readonly assets: ReadonlyMap<string, Uint8Array>;
    }
  | {
      readonly outcome: "ready";
      readonly raw: unknown;
      readonly assets: ReadonlyMap<string, Uint8Array>;
    };

/** The result of committing a staged import. */
export type CommitResult =
  | {
      readonly committed: true;
      readonly data: BrainData;
      readonly assets: ReadonlyMap<string, Uint8Array>;
      readonly findings: readonly StagingFinding[];
    }
  | {
      readonly committed: false;
      readonly reason: string;
      readonly findings: readonly StagingFinding[];
    };

const DECODER = new TextDecoder();

/** Decode a bundle input into either a bare JSON string or a parsed zip. */
function decodeInput(
  bundle: Uint8Array | string,
): { kind: "json"; text: string } | { kind: "zip"; parsed: ParsedBundle } {
  if (typeof bundle === "string") {
    return { kind: "json", text: bundle };
  }
  // A Lane-2 bundle is a real zip (PK\x03\x04); a bare Lane-1 payload decodes to
  // JSON starting with '{'. Peek the first bytes to pick the lane.
  const b0 = bundle[0];
  const b1 = bundle[1];
  const looksZip = b0 === 0x50 && b1 === 0x4b; // "PK"
  if (!looksZip) {
    return { kind: "json", text: DECODER.decode(bundle) };
  }
  const parsed = parseBundleZip(bundle);
  return { kind: "zip", parsed };
}

function tryParseJson(text: string | null): { ok: true; value: unknown } | { ok: false } {
  if (text === null) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function readSchemaVersion(raw: unknown): number | null {
  if (typeof raw !== "object" || raw === null) return null;
  const manifest = (raw as Record<string, unknown>)["manifest"];
  if (typeof manifest !== "object" || manifest === null) return null;
  const version = (manifest as Record<string, unknown>)["schemaVersion"];
  return typeof version === "number" && Number.isFinite(version) ? version : null;
}

/**
 * The sources carried by a parsed payload, as lightweight records with enough
 * fields (id, assetId, versionHash) to match assets. Defensive against a
 * malformed array (returns []).
 */
function readSources(
  raw: unknown,
): { id: string; assetId: string; versionHash: string }[] {
  if (typeof raw !== "object" || raw === null) return [];
  const sources = (raw as Record<string, unknown>)["sources"];
  if (!Array.isArray(sources)) return [];
  const out: { id: string; assetId: string; versionHash: string }[] = [];
  for (const s of sources) {
    if (typeof s !== "object" || s === null) continue;
    const rec = s as Record<string, unknown>;
    if (
      typeof rec["id"] === "string" &&
      typeof rec["assetId"] === "string" &&
      typeof rec["versionHash"] === "string"
    ) {
      out.push({
        id: rec["id"],
        assetId: rec["assetId"],
        versionHash: rec["versionHash"],
      });
    }
  }
  return out;
}

/**
 * Stage an incoming import for validation WITHOUT touching any live store. See
 * the module header for the three outcomes. Async because it hashes bundled PDF
 * binaries (sha256) to detect checksum drift.
 */
export async function stageImport(
  bundle: Uint8Array | string,
): Promise<StagedImport> {
  let decoded: ReturnType<typeof decodeInput>;
  try {
    decoded = decodeInput(bundle);
  } catch (err) {
    // A corrupted zip central directory makes unzipSync throw -> hard-reject.
    return {
      outcome: "hard-reject",
      reason: `corrupted bundle: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let jsonText: string | null;
  const assets = new Map<string, Uint8Array>();
  if (decoded.kind === "json") {
    jsonText = decoded.text;
  } else {
    jsonText = decoded.parsed.brainJson;
    for (const [name, bytes] of decoded.parsed.assets) {
      assets.set(name, bytes);
    }
  }

  const parsed = tryParseJson(jsonText);
  if (!parsed.ok) {
    return { outcome: "hard-reject", reason: "unparseable JSON payload" };
  }
  const raw = parsed.value;

  // HARD-REJECT: any bundled asset that is not a real PDF (bad %PDF- magic).
  for (const [name, bytes] of assets) {
    if (!hasPdfMagic(bytes)) {
      return {
        outcome: "hard-reject",
        reason: `bundled asset ${name} is not a valid PDF (missing %PDF- magic)`,
      };
    }
  }

  const findings: StagingFinding[] = [];

  // DEFAULT-REJECT: schema version mismatch vs the build's SCHEMA_VERSION. A
  // FUTURE version is unparseable later, but here we only flag a mismatch so
  // the lenient path can still migrate a known-older payload.
  const schemaVersion = readSchemaVersion(raw);
  if (schemaVersion === null) {
    findings.push({
      kind: "schema-version-mismatch",
      message: "manifest.schemaVersion is missing or not a number",
    });
  } else if (schemaVersion !== SCHEMA_VERSION) {
    findings.push({
      kind: "schema-version-mismatch",
      message: `schemaVersion ${schemaVersion} does not match the current version ${SCHEMA_VERSION}`,
    });
  }

  // DEFAULT-REJECT: a missing OPTIONAL array (the backup omitted a section).
  if (typeof raw === "object" && raw !== null) {
    const rec = raw as Record<string, unknown>;
    for (const key of OPTIONAL_ARRAY_KEYS) {
      if (!Array.isArray(rec[key])) {
        findings.push({
          kind: "missing-array",
          message: `optional collection '${key}' is missing or not an array`,
        });
      }
    }
  }

  // DEFAULT-REJECT: a bundled asset whose sha256 does not match the matching
  // Source.versionHash (true edition drift), and a source whose binary is
  // absent from a bundle that otherwise carried binaries.
  const sources = readSources(raw);
  const bundledBySource = new Map<string, Uint8Array>();
  for (const source of sources) {
    const entry = assetEntryName(source.id, source.versionHash);
    const bytes = assets.get(entry);
    if (bytes) bundledBySource.set(source.id, bytes);
  }
  for (const source of sources) {
    const bytes = bundledBySource.get(source.id);
    if (!bytes) continue;
    const digest = await sha256Hex(bytes);
    if (digest !== source.versionHash) {
      findings.push({
        kind: "checksum-mismatch",
        message: `source ${source.id} binary checksum ${digest} does not match versionHash ${source.versionHash}`,
      });
    }
  }

  if (findings.length > 0) {
    return { outcome: "needs-confirmation", findings, raw, assets };
  }
  return { outcome: "ready", raw, assets };
}

/**
 * Build an assetId -> bytes map from a parsed payload's sources + the bundle's
 * entry-name-keyed assets, and classify each source's binary availability.
 * Returns the asset map plus the set of source ids whose binary was absent and
 * whose binary checksum mismatched (used by the lenient resolution rewrite).
 */
function mapAssetsBySource(
  data: BrainData,
  assets: ReadonlyMap<string, Uint8Array>,
): {
  byAssetId: Map<string, Uint8Array>;
  absent: Set<string>;
} {
  const byAssetId = new Map<string, Uint8Array>();
  const absent = new Set<string>();
  for (const source of data.sources) {
    const entry = assetEntryName(source.id, source.versionHash);
    const bytes = assets.get(entry);
    if (bytes) {
      byAssetId.set(source.assetId, bytes);
    } else {
      absent.add(source.id);
    }
  }
  return { byAssetId, absent };
}

/**
 * Re-derive each annotation's resolution for the lenient path: a source whose
 * bundled binary checksum MISMATCHED becomes 'mismatched'; a source whose
 * binary is ABSENT becomes 'binary-offloaded'. Annotations whose source is
 * fine keep their stored resolution.
 *
 * `mismatched` maps sourceId -> the ACTUAL sha256 digest of the imported bytes
 * (computed upstream in commitStagedImport). The resolution records the stored
 * `Source.versionHash` as `expectedVersionHash` and that recomputed digest as
 * `actualVersionHash`, so a drifted binary reports the two distinct hashes
 * rather than collapsing both to the stored value.
 */
function applyBinaryResolutions(
  data: BrainData,
  absent: ReadonlySet<string>,
  mismatched: ReadonlyMap<string, string>,
): BrainData {
  if (absent.size === 0 && mismatched.size === 0) return data;
  const sourceById = new Map(data.sources.map((s) => [s.id as string, s]));
  const annotations: Annotation[] = data.annotations.map((ann) => {
    const actual = mismatched.get(ann.sourceId);
    if (actual !== undefined) {
      const expected = sourceById.get(ann.sourceId as string)?.versionHash;
      return {
        ...ann,
        resolution: {
          kind: "mismatched",
          reason: "imported binary checksum did not match the stored versionHash",
          expectedVersionHash: expected ?? ann.scope.anchor.sourceVersionHash,
          actualVersionHash: actual,
        },
      } as Annotation;
    }
    if (absent.has(ann.sourceId)) {
      return {
        ...ann,
        resolution: {
          kind: "binary-offloaded",
          reason: "the PDF binary was not included in this backup; re-attach it to view the page",
        },
      } as Annotation;
    }
    return ann;
  });
  return { ...data, annotations };
}

/**
 * Verify referential integrity of a BrainData before a commit: every record
 * that references another record by id points at an existing record. Returns
 * the list of integrity findings (empty = clean).
 */
export function verifyReferentialIntegrity(data: BrainData): StagingFinding[] {
  const findings: StagingFinding[] = [];
  const sourceIds = new Set(data.sources.map((s) => s.id as string));
  const annotationIds = new Set(data.annotations.map((a) => a.id as string));
  const pageIds = new Set(data.pages.map((p) => p.id as string));

  for (const ann of data.annotations as readonly Annotation[]) {
    if (!sourceIds.has(ann.sourceId as string)) {
      findings.push({
        kind: "referential-integrity",
        message: `annotation ${ann.id} references missing source ${ann.sourceId}`,
      });
    }
  }
  for (const ev of data.evidenceInstances as readonly EvidenceInstance[]) {
    if (!annotationIds.has(ev.annotationId as string)) {
      findings.push({
        kind: "referential-integrity",
        message: `evidence ${ev.id} references missing annotation ${ev.annotationId}`,
      });
    }
    if (!pageIds.has(ev.destinationPageId as string)) {
      findings.push({
        kind: "referential-integrity",
        message: `evidence ${ev.id} references missing page ${ev.destinationPageId}`,
      });
    }
  }
  for (const sa of data.subjectAssociations as readonly SubjectAssociation[]) {
    if (!annotationIds.has(sa.annotationId as string)) {
      findings.push({
        kind: "referential-integrity",
        message: `subjectAssociation ${sa.id} references missing annotation ${sa.annotationId}`,
      });
    }
    if (!pageIds.has(sa.destinationPageId as string)) {
      findings.push({
        kind: "referential-integrity",
        message: `subjectAssociation ${sa.id} references missing page ${sa.destinationPageId}`,
      });
    }
  }
  return findings;
}

/**
 * Commit a staged import into a BrainData + asset map.
 *
 *  - 'ready': migrate via migrateBrainData, verify referential integrity, and
 *    return the committed data + the matched asset bytes (keyed by assetId).
 *  - 'needs-confirmation': commit ONLY when `opts.lenient` is true. The lenient
 *    coercion pass fills missing optional collections with empty defaults (via
 *    migrateBrainData), keeps all valid records, marks sources whose binary
 *    checksum mismatched as 'mismatched' and sources whose binary is absent as
 *    'binary-offloaded', then verifies referential integrity. Without lenient
 *    it returns a rejected result and commits nothing.
 *  - 'hard-reject': never commits.
 */
export async function commitStagedImport(
  staged: StagedImport,
  opts?: { lenient?: boolean },
): Promise<CommitResult> {
  if (staged.outcome === "hard-reject") {
    return { committed: false, reason: staged.reason, findings: [] };
  }
  if (staged.outcome === "needs-confirmation" && !opts?.lenient) {
    return {
      committed: false,
      reason: "import needs confirmation; re-run with lenient to Try Import Anyway",
      findings: staged.findings,
    };
  }

  const stagingFindings =
    staged.outcome === "needs-confirmation" ? staged.findings : [];

  // migrateBrainData fills every missing optional collection with its canonical
  // empty default and upgrades the schema version. Throws UnmigratableError /
  // FutureSchemaError for a truly broken payload, which we surface as rejected.
  let migrated: BrainData;
  try {
    migrated = migrateBrainData(staged.raw);
  } catch (err) {
    return {
      committed: false,
      reason: `could not migrate payload: ${err instanceof Error ? err.message : String(err)}`,
      findings: stagingFindings,
    };
  }

  // Classify asset availability and re-derive the sha256 of each bundled binary
  // to find the mismatched set (recomputed here so a lenient commit without a
  // prior checksum finding still resolves correctly).
  const { byAssetId, absent } = mapAssetsBySource(migrated, staged.assets);
  // sourceId -> ACTUAL recomputed digest of the imported bytes (the drift hash
  // we surface as actualVersionHash, distinct from the stored versionHash).
  const mismatched = new Map<string, string>();
  for (const source of migrated.sources) {
    const bytes = byAssetId.get(source.assetId);
    if (!bytes) continue;
    const digest = await sha256Hex(bytes);
    if (digest !== source.versionHash) {
      mismatched.set(source.id, digest);
      // A mismatched binary must not be written as if it were the real one.
      byAssetId.delete(source.assetId);
      // Not added to `absent`: that would mask the drift as 'binary-offloaded'.
      // applyBinaryResolutions checks `mismatched` first, so the annotation is
      // correctly reported as 'mismatched' with both hashes.
    }
  }

  const resolved = applyBinaryResolutions(migrated, absent, mismatched);

  const integrity = verifyReferentialIntegrity(resolved);
  if (integrity.length > 0) {
    return {
      committed: false,
      reason: "referential integrity check failed",
      findings: [...stagingFindings, ...integrity],
    };
  }

  return {
    committed: true,
    data: resolved,
    assets: byAssetId,
    findings: stagingFindings,
  };
}

/** Re-exported so callers can seed an empty brain default when needed. */
export { createEmptyBrainData };
