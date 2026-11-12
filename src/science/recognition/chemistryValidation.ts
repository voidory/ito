/**
 * M18 FEAT-002 (spec Phase 2, Step 2.3) — chemistry validation layer.
 *
 *   SMILES  →  chemical parser (chemGraph.ts)  →  ChemistryValidationResult
 *
 * The spec says to "use a chemistry toolkit where practical, preferably RDKit".
 * RDKit-JS ships as a WebAssembly module whose default distribution is fetched
 * over the network, and this sandbox makes NO guarantee that RDKit (or any
 * external AI / WASM endpoint) is reachable. Per the project's environment
 * constraints every such capability must degrade to a deterministic,
 * dependency-free default rather than silently depend on a network call.
 *
 * Therefore the DEFAULT backend here is a deterministic, dependency-free
 * validator built on the hand-written SMILES parser in `chemGraph.ts`. It is
 * structured behind a small `ChemistryBackend` seam so a stronger backend (e.g.
 * RDKit-JS, once a runtime is known to support it) can be registered later with
 * `setChemistryBackend()` WITHOUT changing the `ChemistryValidationResult`
 * contract or any caller. The validator NEVER returns `valid: true` for input
 * that fails a syntactic check — an invalid recognition result is never silently
 * accepted (spec: "Never silently accept an invalid recognition result").
 */

import { parseReactionGraph, parseSmilesGraph, type ParsedMolecule } from "./chemGraph";

/** The validation result contract (identical to the spec's interface). */
export interface ChemistryValidationResult {
  valid: boolean;
  normalizedSmiles?: string;
  errors: string[];
  warnings: string[];
}

/**
 * A pluggable validation backend. The default is the deterministic validator
 * below; a stronger backend (RDKit) could implement the same signature.
 */
export interface ChemistryBackend {
  readonly name: string;
  validate(smiles: string): ChemistryValidationResult;
}

/**
 * Element symbols the deterministic validator recognizes. This is a broad but
 * finite set (organic subset + common main-group / metals that appear in OCSR
 * output); an unknown symbol produces an error rather than a false positive.
 */
const KNOWN_ELEMENTS = new Set([
  "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne",
  "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar", "K", "Ca",
  "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn",
  "Ga", "Ge", "As", "Se", "Br", "Kr", "Rb", "Sr", "Y", "Zr",
  "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd", "In", "Sn",
  "Sb", "Te", "I", "Xe", "Cs", "Ba", "La", "Ce", "Pt", "Au",
  "Hg", "Tl", "Pb", "Bi", "W", "Re", "Os", "Ir",
]);

/** Lowercase aromatic organic-subset atoms permitted outside brackets. */
const AROMATIC_ORGANIC = new Set(["c", "n", "o", "s", "p", "b"]);

/** Uppercase organic-subset atoms permitted outside brackets. */
const ALIPHATIC_ORGANIC = new Set(["B", "C", "N", "O", "P", "S", "F", "Cl", "Br", "I"]);

/**
 * Deterministic, dependency-free validation of a single SMILES string.
 * Performs syntactic checks (balanced parentheses, ring-closure digits,
 * brackets, valid bond symbols, recognized element symbols, no trailing bond
 * operator) and, on success, derives a deterministic `normalizedSmiles` from
 * the parsed graph.
 */
function validateDeterministic(smiles: string): ChemistryValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const raw = (smiles ?? "").trim();

  if (raw.length === 0) {
    return { valid: false, errors: ["Empty SMILES string."], warnings };
  }

  const isReaction = raw.includes(">");

  // ---- Syntactic checks over the raw string ----------------------------
  // Balanced parentheses (branches).
  let depth = 0;
  for (const ch of raw) {
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth < 0) {
        errors.push("Unbalanced branch parentheses: unexpected ')'.");
        break;
      }
    }
  }
  if (depth > 0) errors.push("Unbalanced branch parentheses: unclosed '('.");

  // Balanced square brackets (bracket atoms).
  checkBrackets(raw, errors);

  // Balanced ring-closure digits (per reaction field, since '>' resets context).
  for (const field of raw.split(">")) {
    checkRingClosures(field, errors);
  }

  // Bond-symbol placement: no trailing bond operator, no bond before ')'.
  checkBondOperators(raw, errors);

  // Unrecognized element symbols (organic subset + bracket atoms).
  checkElements(raw, errors);

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  // ---- Parse into the graph and derive a normalized SMILES -------------
  let molecules: ParsedMolecule[];
  if (isReaction) {
    const rxn = parseReactionGraph(raw);
    molecules = [...rxn.reactants, ...rxn.agents, ...rxn.products];
    if (rxn.reactants.length === 0 && rxn.products.length === 0) {
      errors.push("Reaction SMILES has no reactants or products.");
      return { valid: false, errors, warnings };
    }
  } else {
    molecules = parseSmilesGraph(raw);
  }

  const totalAtoms = molecules.reduce((n, m) => n + m.atoms.length, 0);
  if (totalAtoms === 0) {
    errors.push("No atoms could be parsed from the SMILES.");
    return { valid: false, errors, warnings };
  }

  // Warnings for features that cannot be FULLY represented by this
  // deterministic backend (it tracks them but does not do valence/charge
  // balancing or canonicalization the way RDKit would).
  if (molecules.some((m) => m.atoms.some((a) => a.chirality))) {
    warnings.push("Stereochemistry is captured but not canonicalized by the default backend.");
  }
  if (molecules.some((m) => m.atoms.some((a) => a.charge !== 0))) {
    warnings.push("Formal charges are captured but valence is not balance-checked by the default backend.");
  }
  if (molecules.some((m) => m.bonds.some((b) => b.stereo))) {
    warnings.push("Double-bond (cis/trans) stereo is captured but not canonicalized by the default backend.");
  }

  const normalizedSmiles = normalizeSmiles(raw);
  return { valid: true, normalizedSmiles, errors, warnings };
}

/** Assert square brackets are balanced and non-empty. */
function checkBrackets(raw: string, errors: string[]): void {
  let open = 0;
  let sawOpen = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "[") {
      open++;
      sawOpen = true;
      if (raw.indexOf("]", i) < 0) break;
    } else if (ch === "]") {
      open--;
      if (open < 0) {
        errors.push("Unbalanced bracket atom: unexpected ']'.");
        return;
      }
    }
  }
  if (open > 0 || (sawOpen && open !== 0)) {
    errors.push("Unbalanced bracket atom: unclosed '['.");
  }
}

/** Assert every ring-closure digit is opened and closed exactly once. */
function checkRingClosures(field: string, errors: string[]): void {
  const counts = new Map<string, number>();
  let i = 0;
  let sawAtom = false;
  while (i < field.length) {
    const ch = field[i]!;
    if (ch === "[") {
      // Skip bracket-atom bodies; digits inside are isotope/charge, not rings.
      const close = field.indexOf("]", i);
      i = close < 0 ? field.length : close + 1;
      sawAtom = true;
      continue;
    }
    if (ch === "%" && /[0-9]/.test(field[i + 1] ?? "") && /[0-9]/.test(field[i + 2] ?? "")) {
      const label = field.slice(i + 1, i + 3);
      counts.set(label, (counts.get(label) ?? 0) + 1);
      i += 3;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      if (!sawAtom) {
        errors.push(`Ring-closure digit '${ch}' before any atom.`);
      }
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
      i++;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) sawAtom = true;
    i++;
  }
  for (const [label, n] of counts) {
    if (n % 2 !== 0) {
      errors.push(`Unbalanced ring-closure digit '${label}' (opened but never closed).`);
    }
  }
}

/** Assert bond operators are not trailing / dangling. */
function checkBondOperators(raw: string, errors: string[]): void {
  const bondChars = new Set(["-", "=", "#", ":", "/", "\\", "$"]);
  for (const field of raw.split(">")) {
    const t = field.trim();
    if (t.length === 0) continue;
    const last = t[t.length - 1]!;
    if (bondChars.has(last)) {
      errors.push(`Dangling bond operator '${last}' at end of '${t}'.`);
    }
    // A bond operator immediately followed by ')' or another bond operator.
    for (let i = 0; i < t.length - 1; i++) {
      if (bondChars.has(t[i]!) && (t[i + 1] === ")" || bondChars.has(t[i + 1]!))) {
        errors.push(`Misplaced bond operator near '${t.slice(i, i + 2)}'.`);
        break;
      }
    }
  }
}

/** Walk atoms and flag unrecognized element symbols. */
function checkElements(raw: string, errors: string[]): void {
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === "[") {
      const close = raw.indexOf("]", i);
      if (close < 0) return; // bracket error already reported
      const inner = raw.slice(i + 1, close);
      const el = bracketElementSymbol(inner);
      if (el && !KNOWN_ELEMENTS.has(el)) {
        errors.push(`Unrecognized element symbol '${el}' in bracket atom.`);
      }
      i = close + 1;
      continue;
    }
    // Organic-subset two-letter atoms first.
    const two = raw.slice(i, i + 2);
    if (ALIPHATIC_ORGANIC.has(two)) {
      i += 2;
      continue;
    }
    if (/[A-Z]/.test(ch)) {
      if (!ALIPHATIC_ORGANIC.has(ch)) {
        errors.push(`Unrecognized element symbol '${ch}' outside brackets (use [${ch}...] for non-organic-subset atoms).`);
      }
      i++;
      continue;
    }
    if (/[a-z]/.test(ch) && !AROMATIC_ORGANIC.has(ch)) {
      // A stray lowercase letter that is not a valid aromatic organic atom.
      errors.push(`Unrecognized aromatic atom '${ch}'.`);
    }
    i++;
  }
}

/** Extract the element symbol from a bracket-atom body (after optional isotope). */
function bracketElementSymbol(inner: string): string | null {
  const rest = inner.replace(/^\d+/, "");
  const aliphatic = rest.match(/^([A-Z][a-z]?)/);
  if (aliphatic) return aliphatic[1]!;
  const arom = rest.match(/^([cnospb])/);
  if (arom) return arom[1]!.toUpperCase();
  return null;
}

/**
 * Produce a deterministic (NOT RDKit-canonical) normalized SMILES from the
 * parsed graph. The full connective skeleton is preserved: bond orders
 * (`=`/`#`), branch parentheses and ring-closure digits are reconstructed, as
 * are aromaticity, charge, isotope, explicit-H and chirality. Reaction fields
 * are rebuilt around their '>' separators. The transform round-trips (parse →
 * serialize → parse yields the same graph: a ring stays a ring, a double bond
 * stays double), so it is safe BOTH as a dedupe key AND as persisted structure.
 */
export function normalizeSmiles(smiles: string): string {
  const raw = (smiles ?? "").trim();
  if (raw.includes(">")) {
    const rxn = parseReactionGraph(raw);
    const left = rxn.reactants.map(moleculeToSmiles).join(".");
    const mid = rxn.agents.map(moleculeToSmiles).join(".");
    const right = rxn.products.map(moleculeToSmiles).join(".");
    return `${left}>${mid}>${right}`;
  }
  return parseSmilesGraph(raw).map(moleculeToSmiles).join(".");
}

/** Render a single atom as its SMILES token (bracketed when necessary). */
function atomToken(atom: ParsedMolecule["atoms"][number]): string {
  const needsBracket =
    atom.charge !== 0 ||
    atom.isotope !== undefined ||
    atom.chirality ||
    atom.explicitH !== undefined ||
    !ALIPHATIC_ORGANIC.has(atom.element);
  if (needsBracket) {
    const iso = atom.isotope !== undefined ? String(atom.isotope) : "";
    const sym = atom.aromatic ? atom.element.toLowerCase() : atom.element;
    const chir = atom.chirality ?? "";
    const h = atom.explicitH !== undefined ? (atom.explicitH === 1 ? "H" : `H${atom.explicitH}`) : "";
    const chg =
      atom.charge === 0
        ? ""
        : atom.charge > 0
          ? `+${atom.charge === 1 ? "" : atom.charge}`
          : `-${atom.charge === -1 ? "" : -atom.charge}`;
    return `[${iso}${sym}${chir}${h}${chg}]`;
  }
  return atom.aromatic ? atom.element.toLowerCase() : atom.element;
}

/** Render a bond-order prefix ("" single, "=" double, "#" triple). Aromatic
 * bonds between two aromatic atoms are left implicit (lowercase atoms imply the
 * aromatic bond), matching the input SMILES convention. */
function bondPrefix(bond: ParsedMolecule["bonds"][number]): string {
  if (bond.order === 2) return "=";
  if (bond.order === 3) return "#";
  return "";
}

/**
 * Serialize one parsed molecule into a SMILES string that faithfully round-trips
 * the graph: bond orders (`=`/`#`), branch parentheses, and ring-closure digits
 * are all reconstructed, and aromaticity / charge / isotope / explicit-H /
 * chirality are preserved. A depth-first spanning tree over the bond graph emits
 * tree edges inline (with branches), and every non-tree edge becomes a matched
 * pair of ring-closure digits on its two endpoints. The result is a stable,
 * deterministic echo: parse → serialize → parse yields the same molecule
 * (a ring stays a ring, a double bond stays double), so it is safe both as a
 * dedupe key and as persisted structure.
 */
function moleculeToSmiles(mol: ParsedMolecule): string {
  const n = mol.atoms.length;
  if (n === 0) return "";

  // Adjacency: for each atom, the bonds that touch it (with the neighbour).
  const adjacency: Array<Array<{ other: number; bond: ParsedMolecule["bonds"][number]; bondIndex: number }>> =
    mol.atoms.map(() => []);
  mol.bonds.forEach((bond, bondIndex) => {
    if (bond.a < 0 || bond.b < 0 || bond.a >= n || bond.b >= n || bond.a === bond.b) return;
    adjacency[bond.a]!.push({ other: bond.b, bond, bondIndex });
    adjacency[bond.b]!.push({ other: bond.a, bond, bondIndex });
  });

  const visitedAtoms = new Array<boolean>(n).fill(false);
  const usedBonds = new Array<boolean>(mol.bonds.length).fill(false);
  // Ring-closure labels keyed by atom index; each closure bond assigns one digit
  // to both of its endpoints so they match when serialized.
  const ringLabels = new Map<number, Array<{ digit: number; bond: ParsedMolecule["bonds"][number] }>>();
  let nextRingDigit = 1;

  // First pass over a DFS spanning tree to allocate ring-closure digits for the
  // non-tree (back) edges, so the digits can be emitted on both endpoints.
  const treeChildren: Array<Array<{ child: number; bond: ParsedMolecule["bonds"][number] }>> =
    mol.atoms.map(() => []);
  const assignRings = (start: number): void => {
    const stack: number[] = [start];
    visitedAtoms[start] = true;
    while (stack.length > 0) {
      const atom = stack[stack.length - 1]!;
      let advanced = false;
      for (const edge of adjacency[atom]!) {
        if (usedBonds[edge.bondIndex]) continue;
        if (!visitedAtoms[edge.other]) {
          // Tree edge: descend.
          usedBonds[edge.bondIndex] = true;
          visitedAtoms[edge.other] = true;
          treeChildren[atom]!.push({ child: edge.other, bond: edge.bond });
          stack.push(edge.other);
          advanced = true;
          break;
        }
        // Non-tree (ring-closure) edge: allocate a shared digit once.
        usedBonds[edge.bondIndex] = true;
        const digit = nextRingDigit++;
        for (const endpoint of [atom, edge.other]) {
          const list = ringLabels.get(endpoint) ?? [];
          list.push({ digit, bond: edge.bond });
          ringLabels.set(endpoint, list);
        }
      }
      if (!advanced) stack.pop();
    }
  };

  // Second pass: emit the SMILES recursively from the spanning tree.
  const emit = (atom: number, incoming: ParsedMolecule["bonds"][number] | null): string => {
    let out = (incoming ? bondPrefix(incoming) : "") + atomToken(mol.atoms[atom]!);
    // Ring-closure digits (with the bond's own order prefix, once, on the
    // lower-indexed endpoint's first appearance — here simply on each endpoint).
    for (const { digit, bond } of ringLabels.get(atom) ?? []) {
      out += `${bondPrefix(bond)}${digit > 9 ? `%${digit}` : digit}`;
    }
    const children = treeChildren[atom]!;
    children.forEach(({ child, bond }, idx) => {
      const sub = emit(child, bond);
      // Last child continues the main chain without parentheses; earlier
      // children are branches.
      out += idx < children.length - 1 ? `(${sub})` : sub;
    });
    return out;
  };

  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    if (!visitedAtoms[i]) assignRings(i);
  }
  // Emit each connected component starting from its DFS root (first atom seen).
  const emitted = new Array<boolean>(n).fill(false);
  const markEmitted = (root: number): void => {
    const stack = [root];
    while (stack.length > 0) {
      const a = stack.pop()!;
      if (emitted[a]) continue;
      emitted[a] = true;
      for (const { child } of treeChildren[a]!) stack.push(child);
    }
  };
  for (let i = 0; i < n; i++) {
    if (emitted[i]) continue;
    parts.push(emit(i, null));
    markEmitted(i);
  }
  return parts.join(".");
}

/** The active backend (default: deterministic). Swappable for RDKit later. */
let activeBackend: ChemistryBackend = {
  name: "deterministic",
  validate: validateDeterministic,
};

/** Register a stronger validation backend (e.g. RDKit) at runtime. */
export function setChemistryBackend(backend: ChemistryBackend): void {
  activeBackend = backend;
}

/** The name of the active backend (for diagnostics / UI badges). */
export function activeChemistryBackendName(): string {
  return activeBackend.name;
}

/**
 * Validate a SMILES string, returning a {@link ChemistryValidationResult}.
 * Delegates to the active backend (deterministic by default). NEVER returns
 * `valid: true` for input that fails a syntactic check.
 */
export function validateSmiles(smiles: string): ChemistryValidationResult {
  return activeBackend.validate(smiles);
}
