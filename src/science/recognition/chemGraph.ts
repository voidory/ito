/**
 * M18 FEAT-002 (spec Phase 2, Step 2.2) — a richer internal chemical graph that
 * PRESERVES the information an OCSR (optical chemical structure recognition)
 * model can emit. The original minimal parser in `src/pdf/scienceOcr.ts`
 * UPPERCASES aromatic atoms (so `c1ccccc1` collapses onto `C1CCCCC1`) and drops
 * formal charge / isotope / explicit-H / stereochemistry. This module keeps all
 * of that: aromatic organic-subset atoms are flagged `aromatic:true` (the
 * element symbol is stored upper-cased as the canonical symbol, but the aromatic
 * flag is NEVER lost), bracket atoms carry charge / isotope / explicit-H /
 * chirality, bond orders and ring-closure bonds survive, and `.`-separated
 * disconnected components (and reaction `>`/`>>` groupings) are kept distinct.
 *
 * The parse is PURE, synchronous and dependency-free (no network, no WASM): it
 * is a deterministic hand-written SMILES walker, the same shape as the engine
 * parser it supersedes, extended to retain the lost information rather than to
 * become a full OpenSMILES implementation.
 */

/** One atom in a parsed molecule graph. */
export interface ParsedAtom {
  /** Canonical element symbol (upper-cased first letter, e.g. "C", "Cl"). */
  readonly element: string;
  /** True for aromatic organic-subset atoms (lowercase c/n/o/s/p/b in SMILES). */
  readonly aromatic: boolean;
  /** Formal charge (0 when neutral). */
  readonly charge: number;
  /** Mass number for an isotope, when specified in a bracket atom. */
  readonly isotope?: number;
  /** Explicit hydrogen count from a bracket atom (e.g. [C@@H] → 1). */
  readonly explicitH?: number;
  /** Tetrahedral chirality from a bracket atom, or null. */
  readonly chirality?: "@" | "@@" | null;
}

/** One bond in a parsed molecule graph (indices into the atoms array). */
export interface ParsedBond {
  readonly a: number;
  readonly b: number;
  /** Bond order: 1 single, 2 double, 3 triple (aromatic bonds use 1 + aromatic). */
  readonly order: number;
  /** True when the bond joins two aromatic atoms / was written lowercase. */
  readonly aromatic?: boolean;
  /** Directional (cis/trans) bond stereo marker, or null. */
  readonly stereo?: "/" | "\\" | null;
}

/** A single connected molecule: its atoms + bonds. */
export interface ParsedMolecule {
  readonly atoms: readonly ParsedAtom[];
  readonly bonds: readonly ParsedBond[];
}

/** The reactant / agent / product grouping of a reaction SMILES. */
export interface ParsedReaction {
  readonly reactants: readonly ParsedMolecule[];
  readonly agents: readonly ParsedMolecule[];
  readonly products: readonly ParsedMolecule[];
}

/** Two-letter organic-subset element symbols that must be read before one char. */
const TWO_LETTER_ORGANIC = new Set(["Cl", "Br"]);

/** Aromatic organic-subset lowercase atom letters. */
const AROMATIC_ORGANIC = new Set(["c", "n", "o", "s", "p", "b"]);

/**
 * Parse a plain (non-reaction) SMILES string into one {@link ParsedMolecule}
 * per `.`-separated disconnected component. Aromaticity, charge, isotope,
 * explicit-H, chirality, bond order and ring-closure bonds are all preserved.
 * Malformed fragments are parsed best-effort (this function does not throw); use
 * {@link validateSmiles} for syntactic validation.
 */
export function parseSmilesGraph(smiles: string): ParsedMolecule[] {
  const s = (smiles ?? "").trim();
  if (s.length === 0) return [];
  return s
    .split(".")
    .filter((p) => p.length > 0)
    .map((component) => parseComponent(component));
}

/**
 * Parse a reaction SMILES ("Reactants>Agents>Products", agents optional) into
 * its three molecule groups. A plain SMILES (no ">") is returned with all its
 * components as reactants and empty agents/products.
 */
export function parseReactionGraph(smiles: string): ParsedReaction {
  const s = (smiles ?? "").trim();
  if (!s.includes(">")) {
    return { reactants: parseSmilesGraph(s), agents: [], products: [] };
  }
  const fields = s.split(">");
  const reactants = parseSmilesGraph(fields[0] ?? "");
  // 3-field reaction SMILES has agents in the middle; ">>" leaves it empty.
  const agents = fields.length >= 3 ? parseSmilesGraph(fields[1] ?? "") : [];
  const products = parseSmilesGraph(fields[fields.length - 1] ?? "");
  return { reactants, agents, products };
}

/** Parse a single connected component (no '.' separators). */
function parseComponent(src: string): ParsedMolecule {
  const atoms: ParsedAtom[] = [];
  const bonds: ParsedBond[] = [];
  const ringOpen = new Map<string, { atom: number; order: number; aromatic: boolean }>();
  const branchStack: number[] = [];
  let prev = -1;
  let pendingOrder = 1;
  let pendingAromatic = false;
  let pendingStereo: "/" | "\\" | null = null;
  let i = 0;
  const s = src;

  const pushBond = (a: number, b: number, order: number, aromatic: boolean, stereo: "/" | "\\" | null): void => {
    if (a < 0 || b < 0 || a === b) return;
    const bond: ParsedBond = { a, b, order, aromatic };
    bonds.push(stereo ? { ...bond, stereo } : bond);
  };

  const addAtom = (atom: ParsedAtom): void => {
    const idx = atoms.length;
    atoms.push(atom);
    if (prev >= 0) {
      pushBond(prev, idx, pendingOrder, pendingAromatic || (atom.aromatic && atoms[prev]!.aromatic), pendingStereo);
    }
    prev = idx;
    pendingOrder = 1;
    pendingAromatic = false;
    pendingStereo = null;
  };

  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "(") {
      branchStack.push(prev);
      i++;
      continue;
    }
    if (ch === ")") {
      prev = branchStack.pop() ?? prev;
      i++;
      continue;
    }
    if (ch === "-" || ch === "=" || ch === "#") {
      pendingOrder = ch === "=" ? 2 : ch === "#" ? 3 : 1;
      i++;
      continue;
    }
    if (ch === ":") {
      // Explicit aromatic bond.
      pendingOrder = 1;
      pendingAromatic = true;
      i++;
      continue;
    }
    if (ch === "/" || ch === "\\") {
      pendingStereo = ch;
      i++;
      continue;
    }
    if (/[0-9]/.test(ch) || ch === "%") {
      // Ring closure digit ("%nn" for two-digit ring bonds).
      let label = ch;
      if (ch === "%" && /[0-9]/.test(s[i + 1] ?? "") && /[0-9]/.test(s[i + 2] ?? "")) {
        label = s.slice(i + 1, i + 3);
        i += 3;
      } else {
        i++;
      }
      const existing = ringOpen.get(label);
      if (existing) {
        pushBond(prev, existing.atom, Math.max(existing.order, pendingOrder), existing.aromatic || pendingAromatic, null);
        ringOpen.delete(label);
      } else if (prev >= 0) {
        ringOpen.set(label, { atom: prev, order: pendingOrder, aromatic: pendingAromatic });
      }
      pendingOrder = 1;
      pendingAromatic = false;
      continue;
    }
    if (ch === "[") {
      const close = s.indexOf("]", i);
      const inner = close > i ? s.slice(i + 1, close) : s.slice(i + 1);
      addAtom(parseBracketAtom(inner));
      i = close > i ? close + 1 : s.length;
      continue;
    }
    const organic = readOrganicAtom(s, i);
    if (organic) {
      addAtom(organic.atom);
      i += organic.length;
      continue;
    }
    // Unrecognized character: skip so the walker always makes progress.
    i++;
  }

  return { atoms, bonds };
}

/** Read an organic-subset atom (aliphatic or aromatic) at position i. */
function readOrganicAtom(s: string, i: number): { atom: ParsedAtom; length: number } | null {
  const two = s.slice(i, i + 2);
  if (TWO_LETTER_ORGANIC.has(two)) {
    return { atom: { element: two, aromatic: false, charge: 0 }, length: 2 };
  }
  const ch = s[i]!;
  if (/[A-Z]/.test(ch)) {
    return { atom: { element: ch, aromatic: false, charge: 0 }, length: 1 };
  }
  if (AROMATIC_ORGANIC.has(ch)) {
    // Aromatic atom: canonical symbol is upper-cased but the aromatic flag is
    // preserved — aromaticity is NEVER lost (spec Phase 2.2).
    return { atom: { element: ch.toUpperCase(), aromatic: true, charge: 0 }, length: 1 };
  }
  return null;
}

/**
 * Parse a bracket-atom body (the text between "[" and "]"), e.g. "NH4+",
 * "O-", "C@@H", "13C", "N+", capturing isotope, element, aromaticity,
 * chirality, explicit-H count and formal charge.
 */
export function parseBracketAtom(inner: string): ParsedAtom {
  let rest = inner;

  // Leading isotope digits.
  let isotope: number | undefined;
  const isoMatch = rest.match(/^(\d+)/);
  if (isoMatch) {
    isotope = parseInt(isoMatch[1]!, 10);
    rest = rest.slice(isoMatch[1]!.length);
  }

  // Element symbol: uppercase+optional lowercase (aliphatic) OR a single
  // lowercase aromatic organic-subset letter.
  let element = "C";
  let aromatic = false;
  const aliphatic = rest.match(/^([A-Z][a-z]?)/);
  if (aliphatic) {
    element = aliphatic[1]!;
    rest = rest.slice(element.length);
  } else {
    const arom = rest.match(/^([cnospb])/);
    if (arom) {
      element = arom[1]!.toUpperCase();
      aromatic = true;
      rest = rest.slice(1);
    }
  }

  // Chirality: "@" or "@@".
  let chirality: "@" | "@@" | null = null;
  if (rest.startsWith("@@")) {
    chirality = "@@";
    rest = rest.slice(2);
  } else if (rest.startsWith("@")) {
    chirality = "@";
    rest = rest.slice(1);
  }

  // Explicit hydrogens: "H" optionally followed by a count.
  let explicitH: number | undefined;
  const hMatch = rest.match(/^H(\d*)/);
  if (hMatch) {
    explicitH = hMatch[1] ? parseInt(hMatch[1], 10) : 1;
    rest = rest.slice(hMatch[0].length);
  }

  // Formal charge: one or more "+"/"-", optionally "+2"/"-3" or "++".
  let charge = 0;
  const chargeMatch = rest.match(/^([+-])(\d+)?/);
  if (chargeMatch) {
    const sign = chargeMatch[1] === "+" ? 1 : -1;
    if (chargeMatch[2]) {
      charge = sign * parseInt(chargeMatch[2], 10);
    } else {
      // Count repeated signs, e.g. "++" → +2.
      const run = rest.match(/^[+]+|^[-]+/);
      charge = sign * (run ? run[0].length : 1);
    }
  }

  const atom: ParsedAtom = { element, aromatic, charge };
  if (isotope !== undefined) (atom as { isotope?: number }).isotope = isotope;
  if (explicitH !== undefined) (atom as { explicitH?: number }).explicitH = explicitH;
  if (chirality !== null) (atom as { chirality?: "@" | "@@" | null }).chirality = chirality;
  return atom;
}
