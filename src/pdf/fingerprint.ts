/**
 * M12 (FEAT-001) Universal PDF Identity Engine.
 *
 * A collection of PURE, SYNCHRONOUS, DETERMINISTIC functions over raw PDF bytes
 * and extracted page text. They carry NO DOM/pixel coordinates, never touch
 * pdf.js, and never await anything, so they run identically in jsdom unit tests
 * and in the browser. This keeps the synchronous `workbench.ts` surface intact:
 * the Workbench calls these helpers inline and only persists once per import.
 *
 * The engine answers one question: "is this incoming PDF the SAME source as one
 * we already hold (a re-import, a prepended cover sheet, a textbook reflow, a
 * revised draft) — or a genuinely new source we must NOT clobber?" It layers
 * four matching tiers (exact bytes, canonical DOI/ISBN, textbook fuzzy, revised
 * draft) behind two anti-collision HARD VETOES (sequence collision, scanned PDF)
 * so a `Lab 1` and a `Lab 2` sharing 80% boilerplate never merge.
 *
 * Determinism note: every hash is a 64-bit FNV-1a folded to a fixed 16-hex
 * string via BigInt, so the SAME input always yields the SAME digest across
 * runs and machines.
 */

// ---------------------------------------------------------------------------
// 64-bit FNV-1a core
// ---------------------------------------------------------------------------

const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** Fold a running 64-bit FNV-1a accumulator to a fixed 16-char hex string. */
function toHex64(acc: bigint): string {
  return (acc & MASK_64).toString(16).padStart(16, "0");
}

/**
 * Compute a fast synchronous 64-bit FNV-1a hex digest (16 hex chars) over all
 * bytes. Deterministic: identical bytes always produce the identical digest.
 */
export function computeByteHash(bytes: Uint8Array): string {
  let acc = FNV_OFFSET_64;
  for (let i = 0; i < bytes.length; i++) {
    acc ^= BigInt(bytes[i]!);
    acc = (acc * FNV_PRIME_64) & MASK_64;
  }
  return toHex64(acc);
}

/** 64-bit FNV-1a hex digest over a UTF-16 code-unit view of a string. */
function hashString(s: string): string {
  let acc = FNV_OFFSET_64;
  for (let i = 0; i < s.length; i++) {
    acc ^= BigInt(s.charCodeAt(i) & 0xffff);
    acc = (acc * FNV_PRIME_64) & MASK_64;
  }
  return toHex64(acc);
}

// ---------------------------------------------------------------------------
// Document stem + sequence token
// ---------------------------------------------------------------------------

/**
 * Explicit sequence kinds we extract from a filename/title, e.g. `lab 1`,
 * `tutorial-2`, `ch3`, `lecture_4`. The matched number becomes the veto key
 * `"<kind>:<num>"` (`"lab:1"`), and is STRIPPED from the stem so a draft/final
 * pair of the SAME sequence share one stem.
 *
 * Global so we can scan ALL candidate tokens and prefer a specific kind over
 * the ambiguous `ch`/`chapter` (which collides with course codes like
 * `CH2101`). The alpha run is captured in group 1, the number in group 2.
 */
const SEQ_REGEX_G =
  /(lab|tutorial|tut|assignment|asg|hw|lecture|lec|part|experiment|exp|report|chapter|ch)\s*[-_#]?\s*(\d+[a-z]?)(?![a-z0-9])/gi;

/** `ch`/`chapter` are ambiguous (course codes); prefer any other kind. */
const AMBIGUOUS_SEQ_KINDS = new Set(["ch"]);

/** Canonicalize a raw sequence kind to a stable short token. */
function normalizeSeqKind(raw: string): string {
  const k = raw.toLowerCase();
  switch (k) {
    case "tut":
      return "tutorial";
    case "asg":
      return "assignment";
    case "lec":
      return "lecture";
    case "exp":
      return "experiment";
    case "chapter":
      return "ch";
    default:
      return k;
  }
}

/** Revision / copy suffix tokens stripped from a stem (do not affect identity). */
const REVISION_WORDS = new Set([
  "draft",
  "final",
  "revised",
  "revision",
  "rev",
  "copy",
  "v1",
  "v2",
  "v3",
  "v4",
  "v5",
]);

/**
 * Derive a normalized document stem + explicit sequence token from a title or
 * filename. The returned `docStem` is the persisted compound key: `stem` plus a
 * `::seq=<kind>:<num>` suffix when a sequence token was found.
 *
 * Normalization intentionally discards layout-irrelevant noise so a draft and a
 * final of the SAME document converge:
 *  - lowercase, drop a trailing `.pdf`,
 *  - strip revision/copy suffixes (`_v1`, `-v2`, `draft`, `final`, `revised`,
 *    `copy`, `(1)`) and ISO dates `YYYY-MM-DD`,
 *  - pull out an explicit sequence token and REMOVE its number from the stem so
 *    `CH2101_Lab1_draft` and `CH2101_Lab1_final` share stem `ch2101_lab` and
 *    seqToken `lab:1`.
 */
export function extractDocStem(titleOrFilename: string): {
  stem: string;
  seqToken: string | null;
  docStem: string;
} {
  let s = (titleOrFilename ?? "").toLowerCase();
  // Drop a trailing .pdf extension.
  s = s.replace(/\.pdf$/i, "");
  // Strip ISO dates YYYY-MM-DD anywhere (underscores aren't word boundaries, so
  // match an optional separator before the year rather than relying on \b).
  s = s.replace(/(^|[^0-9])(1[5-9]\d{2}|20\d{2})-\d{2}-\d{2}(?![0-9])/g, "$1 ");
  // Strip parenthetical copy markers like "(1)".
  s = s.replace(/\(\s*\d+\s*\)/g, " ");

  // Scan ALL sequence candidates and prefer a specific kind (lab/tutorial/...)
  // over the ambiguous `ch`/`chapter` so a course code like "CH2101_Lab1"
  // resolves to "lab:1", not "ch:2101".
  let seqKind: string | null = null;
  let seqNum: string | null = null;
  let seqToken: string | null = null;
  let ambiguousKind: string | null = null;
  let ambiguousNum: string | null = null;
  for (const m of s.matchAll(SEQ_REGEX_G)) {
    const kind = normalizeSeqKind(m[1]!);
    const num = m[2]!.toLowerCase();
    if (AMBIGUOUS_SEQ_KINDS.has(kind)) {
      if (ambiguousKind == null) {
        ambiguousKind = kind;
        ambiguousNum = num;
      }
      continue;
    }
    // First non-ambiguous kind wins.
    seqKind = kind;
    seqNum = num;
    break;
  }
  if (seqKind == null && ambiguousKind != null) {
    seqKind = ambiguousKind;
    seqNum = ambiguousNum;
  }
  if (seqKind && seqNum) seqToken = `${seqKind}:${seqNum}`;

  // Tokenize into alphanumeric words.
  const rawTokens = s.split(/[^a-z0-9]+/i).filter((t) => t.length > 0);
  // The literal filename form of the matched kind (so we can strip a glued
  // "lab1" token). Our normalized kinds already equal their literal form.
  const kindLiteral = seqKind;

  const stemTokens: string[] = [];
  let strippedSeq = false;
  for (const tok of rawTokens) {
    const t = tok.toLowerCase();
    // Drop pure revision/copy words.
    if (REVISION_WORDS.has(t)) continue;
    // Drop a `vN` revision suffix like v1..v99.
    if (/^v\d+$/.test(t)) continue;
    // If this token is exactly the matched sequence kind+number (e.g. "lab1"),
    // reduce it to the kind only so the number does not pollute the stem.
    if (!strippedSeq && kindLiteral && seqNum && t === `${kindLiteral}${seqNum}`) {
      stemTokens.push(kindLiteral);
      strippedSeq = true;
      continue;
    }
    // If this token is exactly the matched kind alone (the number lived in a
    // separate token), keep the kind and mark the seq stripped.
    if (!strippedSeq && kindLiteral && t === kindLiteral) {
      stemTokens.push(kindLiteral);
      strippedSeq = true;
      continue;
    }
    // If this token is exactly the sequence number alone (e.g. "1" after "lab"),
    // drop it once: the number lives in seqToken, not the stem.
    if (!strippedSeq && seqNum && t === seqNum) {
      strippedSeq = true;
      continue;
    }
    stemTokens.push(t);
  }

  const stem = stemTokens.join("_");
  const docStem = seqToken ? `${stem}::seq=${seqToken}` : stem;
  return { stem, seqToken, docStem };
}

// ---------------------------------------------------------------------------
// Canonical id (DOI / ISBN)
// ---------------------------------------------------------------------------

const DOI_REGEX = /\b(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)\b/i;
const ISBN_REGEX = /\bISBN(?:-1[03])?:?\s*((?:97[89][-\s]?)?(?:\d[-\s]?){9,12}[\dxX])\b/i;
const BARE_ISBN_REGEX = /\b(97[89](?:[-\s]?\d){10}|\d{9}[\dxX])\b/;

/** Strip trailing sentence punctuation a DOI regex may greedily absorb. */
function trimDoi(doi: string): string {
  return doi.replace(/[.,;:)\]]+$/, "");
}

/** Normalize an ISBN candidate to digits (+ trailing X) only. */
function normalizeIsbn(raw: string): string | undefined {
  const cleaned = raw.replace(/[-\s]/g, "").toUpperCase();
  if (/^(?:\d{9}[\dX]|\d{13})$/.test(cleaned)) return cleaned;
  return undefined;
}

/**
 * Scan the optional metadata string and the FIRST 15 pages for a canonical
 * identifier. Returns `"doi:<lowercased-doi>"` (preferred) or
 * `"isbn:<digits>"`, or `undefined` when neither is present. Deterministic:
 * scans metadata first, then pages in order, returning the first DOI found
 * before falling back to the first ISBN.
 */
export function extractCanonicalId(
  pageTexts: readonly string[],
  metaStr?: string,
): string | undefined {
  const haystacks: string[] = [];
  if (metaStr && metaStr.trim().length > 0) haystacks.push(metaStr);
  for (let i = 0; i < Math.min(pageTexts.length, 15); i++) {
    haystacks.push(pageTexts[i] ?? "");
  }

  // Prefer a DOI (strongest canonical signal).
  for (const h of haystacks) {
    const m = h.match(DOI_REGEX);
    if (m) {
      const doi = trimDoi(m[1]!).toLowerCase();
      if (doi.length > 0) return `doi:${doi}`;
    }
  }
  // Fall back to an ISBN.
  for (const h of haystacks) {
    const labelled = h.match(ISBN_REGEX);
    if (labelled) {
      const norm = normalizeIsbn(labelled[1]!);
      if (norm) return `isbn:${norm}`;
    }
    const bare = h.match(BARE_ISBN_REGEX);
    if (bare) {
      const norm = normalizeIsbn(bare[1]!);
      if (norm) return `isbn:${norm}`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Text shingles (MinHash + sentence hashes)
// ---------------------------------------------------------------------------

const BOILERPLATE_PATTERNS = [
  "matriculation",
  "declaration of originality",
  "university",
  "student id",
  "all rights reserved",
];

/** A line is boilerplate if it contains any academic-boilerplate marker. */
function isBoilerplateLine(line: string): boolean {
  const l = line.toLowerCase();
  return BOILERPLATE_PATTERNS.some((p) => l.includes(p));
}

/**
 * Pick the page indices to sample for shingling. When there are more than 10
 * pages, sample 8 evenly spaced pages between 15% and 85% of the document
 * (`idx = floor(N * (0.15 + 0.70 * i/7))`) to skip front/back matter; otherwise
 * use every page. Deterministic and dedup-ordered.
 */
function sampledPageIndices(n: number): number[] {
  if (n <= 10) return Array.from({ length: n }, (_, i) => i);
  const picked = new Set<number>();
  for (let i = 0; i < 8; i++) {
    const idx = Math.floor(n * (0.15 + 0.7 * (i / 7)));
    picked.add(Math.min(Math.max(idx, 0), n - 1));
  }
  return [...picked].sort((a, b) => a - b);
}

/** Collapse a page's text into kept content lines (drops headers/boilerplate). */
function contentLinesForPage(pageText: string): string[] {
  const lines = pageText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  let kept = lines;
  // Strip top/bottom 10% of lines to drop running headers/footers/watermarks.
  if (lines.length >= 10) {
    const cut = Math.floor(lines.length * 0.1);
    kept = lines.slice(cut, lines.length - cut);
  }
  return kept.filter((l) => !isBoilerplateLine(l));
}

/** Lowercased alphanumeric words of length >= 4, in order. */
function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 4);
}

/**
 * Compute up to 24 deterministic shingle hashes for a document:
 *  - 16 MinHash hashes: the lexicographically smallest unique 64-bit FNV-1a
 *    hashes over sliding 5-word normalized windows (words >= 4 chars) across the
 *    sampled, header-stripped, boilerplate-filtered pages.
 *  - up to 8 sentence hashes: evenly sampled normalized sentences >= 50 chars.
 *
 * Returns a stable, sorted-then-concatenated array (MinHash first, then sentence
 * hashes). A scanned/empty PDF with little extractable text yields `< 4` hashes
 * and is therefore excluded from fuzzy matching by the veto in
 * `matchExistingSource`.
 */
export function computeTextShingles(pageTexts: readonly string[]): string[] {
  const indices = sampledPageIndices(pageTexts.length);

  // ---- MinHash over 5-word windows --------------------------------------
  const windowHashes = new Set<string>();
  for (const idx of indices) {
    const lines = contentLinesForPage(pageTexts[idx] ?? "");
    const words = contentWords(lines.join(" "));
    for (let i = 0; i + 5 <= words.length; i++) {
      const window = words.slice(i, i + 5).join(" ");
      windowHashes.add(hashString(window));
    }
  }
  const minHashes = [...windowHashes].sort().slice(0, 16);

  // ---- Sentence hashes ---------------------------------------------------
  const sentenceSet = new Set<string>();
  const orderedSentences: string[] = [];
  for (const idx of indices) {
    const lines = contentLinesForPage(pageTexts[idx] ?? "");
    const joined = lines.join(" ");
    for (const raw of joined.split(/(?<=[.!?])\s+/)) {
      const norm = raw.toLowerCase().replace(/\s+/g, " ").trim();
      if (norm.length >= 50 && !sentenceSet.has(norm)) {
        sentenceSet.add(norm);
        orderedSentences.push(norm);
      }
    }
  }
  const sentenceHashes: string[] = [];
  const total = orderedSentences.length;
  if (total > 0) {
    const take = Math.min(8, total);
    const seen = new Set<string>();
    for (let i = 0; i < take; i++) {
      const sIdx = take === 1 ? 0 : Math.floor((total - 1) * (i / (take - 1)));
      const h = hashString(orderedSentences[sIdx]!);
      if (!seen.has(h)) {
        seen.add(h);
        sentenceHashes.push(h);
      }
    }
  }

  return [...minHashes, ...sentenceHashes];
}

// ---------------------------------------------------------------------------
// Full document signature
// ---------------------------------------------------------------------------

/** A pure document identity signature derived from bytes + title + page text. */
export interface DocumentSignature {
  readonly contentHash?: string | undefined;
  readonly canonicalId?: string | undefined;
  readonly stem: string;
  readonly seqToken: string | null;
  readonly docStem: string;
  readonly textShingles?: readonly string[] | undefined;
}

/**
 * Build a complete {@link DocumentSignature} from whatever inputs are available.
 * Every field is computed by the pure helpers above; missing inputs simply
 * leave the corresponding signal `undefined`/empty so the matcher can degrade
 * gracefully (e.g. an offloaded source with no bytes still matches on stem).
 */
export function extractDocumentSignature(input: {
  bytes?: Uint8Array | undefined;
  titleOrFilename: string;
  pageTexts?: readonly string[] | undefined;
  metaStr?: string | undefined;
}): DocumentSignature {
  const { stem, seqToken, docStem } = extractDocStem(input.titleOrFilename);
  const pageTexts = input.pageTexts ?? [];
  const contentHash = input.bytes ? computeByteHash(input.bytes) : undefined;
  const canonicalId =
    pageTexts.length > 0 || input.metaStr
      ? extractCanonicalId(pageTexts, input.metaStr)
      : undefined;
  const shingles = pageTexts.length > 0 ? computeTextShingles(pageTexts) : undefined;
  return {
    ...(contentHash != null ? { contentHash } : {}),
    ...(canonicalId != null ? { canonicalId } : {}),
    stem,
    seqToken,
    docStem,
    ...(shingles != null ? { textShingles: shingles } : {}),
  };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Jaccard overlap |A ∩ B| / |A ∪ B| of two hash arrays, with the intersection size. */
export function shingleOverlap(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): { jaccard: number; shared: number } {
  if (!a || !b || a.length === 0 || b.length === 0) return { jaccard: 0, shared: 0 };
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const h of setA) if (setB.has(h)) shared += 1;
  const union = setA.size + setB.size - shared;
  return { jaccard: union === 0 ? 0 : shared / union, shared };
}

/** The identity signals a candidate source exposes to the matcher. */
export interface MatchCandidate {
  readonly contentHash?: string | undefined;
  readonly canonicalId?: string | undefined;
  readonly stem?: string | undefined;
  readonly seqToken?: string | null | undefined;
  readonly textShingles?: readonly string[] | undefined;
  /** True when the candidate's PDF binary is currently offloaded / missing. */
  readonly binaryOffloaded?: boolean | undefined;
}

export type MatchTier =
  | "exact-bytes"
  | "canonical-id"
  | "textbook"
  | "revised-draft";

export interface MatchDecision {
  readonly matched: boolean;
  readonly tier?: MatchTier;
  readonly reason: string;
}

/** Derive a stem + seqToken from a candidate Source's stored `docStem`. */
export function parseDocStem(docStem: string | undefined): {
  stem: string;
  seqToken: string | null;
} {
  if (!docStem) return { stem: "", seqToken: null };
  const seqIdx = docStem.indexOf("::seq=");
  if (seqIdx < 0) return { stem: docStem, seqToken: null };
  return {
    stem: docStem.slice(0, seqIdx),
    seqToken: docStem.slice(seqIdx + "::seq=".length) || null,
  };
}

/**
 * Decide whether an incoming PDF signature identifies the SAME source as a
 * single candidate. Layered tiers behind two hard vetoes (see the module
 * header). Pure and synchronous.
 */
export function matchExistingSource(
  incoming: {
    contentHash?: string | undefined;
    canonicalId?: string | undefined;
    stem: string;
    seqToken: string | null;
    textShingles?: readonly string[] | undefined;
  },
  candidate: MatchCandidate,
): MatchDecision {
  const candStem = candidate.stem ?? "";
  const candSeq = candidate.seqToken ?? null;

  // HARD VETO 1 — sequence collision guard. Two explicit, DIFFERENT sequence
  // tokens (lab:1 vs lab:2) can never be the same document, no matter how much
  // boilerplate they share.
  if (incoming.seqToken != null && candSeq != null && incoming.seqToken !== candSeq) {
    return {
      matched: false,
      reason: `sequence collision veto: ${incoming.seqToken} != ${candSeq}`,
    };
  }

  // Tier 1 — exact bytes.
  if (incoming.contentHash && incoming.contentHash === candidate.contentHash) {
    return { matched: true, tier: "exact-bytes", reason: "identical content hash" };
  }

  // Tier 2 — canonical DOI/ISBN.
  if (incoming.canonicalId && incoming.canonicalId === candidate.canonicalId) {
    return { matched: true, tier: "canonical-id", reason: "identical canonical id" };
  }

  // HARD VETO 2 — scanned/empty PDF guard. Never match on fuzzy shingles alone
  // when either side has too few shingles to be meaningful.
  const incCount = incoming.textShingles?.length ?? 0;
  const candCount = candidate.textShingles?.length ?? 0;
  const shinglesUsable = incCount >= 4 && candCount >= 4;

  const { jaccard, shared } = shingleOverlap(incoming.textShingles, candidate.textShingles);

  // Tier 3 — textbook / cross-source paper: strong fuzzy text overlap.
  if (shinglesUsable && jaccard >= 0.35 && shared >= 5) {
    return {
      matched: true,
      tier: "textbook",
      reason: `textbook overlap jaccard=${jaccard.toFixed(3)} shared=${shared}`,
    };
  }

  // Tier 4 — revised university doc draft (Lab1_draft -> Lab1_final). Same stem
  // (no seq conflict, already vetoed above) PLUS a weak corroborating signal:
  // some fuzzy overlap, OR an offloaded candidate binary, OR neither side has
  // extracted shingles yet.
  if (incoming.stem.length >= 3 && incoming.stem === candStem) {
    const neitherHasShingles = incCount === 0 && candCount === 0;
    const weakOverlap = shinglesUsable && (jaccard >= 0.15 || shared >= 2);
    if (
      weakOverlap ||
      candidate.binaryOffloaded === true ||
      neitherHasShingles
    ) {
      return {
        matched: true,
        tier: "revised-draft",
        reason: `revised draft: shared stem "${candStem}" (jaccard=${jaccard.toFixed(3)}, shared=${shared})`,
      };
    }
  }

  return { matched: false, reason: "no tier matched" };
}
