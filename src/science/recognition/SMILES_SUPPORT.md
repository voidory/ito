# SMILES support audit (M18 FEAT-002, spec Phase 2)

This is an honest audit of what the Ito chemistry representation does and does
not support. It covers the ORIGINAL minimal parser that shipped in
`src/pdf/scienceOcr.ts` (M17) and the NEW graph parser added in
`src/science/recognition/chemGraph.ts` + validation in
`src/science/recognition/chemistryValidation.ts` (M18 FEAT-002).

It is deliberately conservative: a feature is only marked "supported" if the
code actually preserves it. We do not pretend unsupported SMILES are supported.

## Original parser (`parseSmiles` / `readOrganicElement` / `parseBracketElement` in `scienceOcr.ts`, M17)

The original parser was a minimal skeletal-layout helper. It produced an
`atoms: string[]` + `bonds` list purely to draw a figure.

| SMILES feature | Original behavior |
| --- | --- |
| Aliphatic atoms | Supported (organic subset; `Cl`/`Br` as two-letter). |
| Aromatic atoms | **LOST** — lowercase `c/n/o/s/p` were `.toUpperCase()`-ed into aliphatic atoms, so `c1ccccc1` rendered byte-identically to `C1CCCCC1`. |
| Bond orders | Supported (`-`, `=`, `#` → 1/2/3). |
| Ring closures | Supported (single digits only; bond re-connected). |
| Branches | Supported (`(` / `)` via a branch stack). |
| Charges | **DROPPED** — bracket body reduced to its element symbol; `+`/`-` ignored. |
| Bracket atoms | Partially — only the leading element symbol was extracted. |
| Stereochemistry | **DROPPED** — `@`/`@@` and `/`\\ ignored. |
| Explicit hydrogens | **DROPPED** — `[C@@H]` kept only `C`. |
| Isotopes | **DROPPED** — `[13C]` kept only `C`. |
| Disconnected components | Split on `.` at the reaction layer, but each fragment parsed the same lossy way. |

## New graph parser (`chemGraph.ts`, M18 FEAT-002)

`parseSmilesGraph(smiles): ParsedMolecule[]` (one entry per `.`-separated
component) and `parseReactionGraph(smiles): ParsedReaction` (reactant / agent /
product grouping). Atoms carry
`{ element, aromatic, charge, isotope?, explicitH?, chirality? }` and bonds
carry `{ a, b, order, aromatic?, stereo? }`.

| SMILES feature | New behavior |
| --- | --- |
| Aliphatic atoms | Supported. |
| Aromatic atoms | **PRESERVED** — lowercase `c/n/o/s/p/b` set `aromatic: true`; the element symbol is stored upper-cased as the canonical symbol, but the aromatic flag is never lost. `c1ccccc1` is now distinguishable from `C1CCCCC1`. |
| Bond orders | Supported (`-`, `=`, `#`). |
| Aromatic bonds | Supported (`:` explicit, or inferred when both endpoints are aromatic). |
| Ring closures | Supported, including two-digit `%nn`. |
| Branches | Supported. |
| Charges | **PRESERVED** — `[O-]`, `[N+]`, `[Mg+2]`, `[Fe++]` → signed integer `charge`. |
| Bracket atoms | Supported — isotope, element, aromaticity, chirality, explicit-H and charge all parsed. |
| Stereochemistry | **PRESERVED where practical** — tetrahedral `@`/`@@` on atoms; directional `/`\\ captured as bond `stereo` (not yet used for E/Z perception). |
| Explicit hydrogens | **PRESERVED** — `[C@@H]` → `explicitH: 1`, `[NH4+]` → `explicitH: 4`. |
| Isotopes | **PRESERVED** — `[13C]` → `isotope: 13`. |
| Disconnected components | **PRESERVED** — one `ParsedMolecule` per `.` fragment. |
| Reaction SMILES | Supported — `A>B>C` and `A>>C` split into reactants / agents / products. |

## Validation (`chemistryValidation.ts`, M18 FEAT-002)

`validateSmiles(smiles): ChemistryValidationResult` where
`{ valid, normalizedSmiles?, errors, warnings }`.

- Deterministic, dependency-free syntactic checks: balanced parentheses,
  balanced ring-closure digits, balanced brackets, no dangling/misplaced bond
  operators, recognized element symbols.
- On success it derives a deterministic (NOT RDKit-canonical)
  `normalizedSmiles` from the parsed graph.
- It NEVER returns `valid: true` for input that fails a syntactic check
  (spec: "Never silently accept an invalid recognition result").

### Backend choice (RDKit)

The spec recommends a chemistry toolkit, "preferably RDKit, where practical".
RDKit-JS is a WebAssembly module whose default distribution is fetched over the
network, and this environment makes no guarantee that RDKit (or any external
AI / WASM endpoint) is reachable. Per the project's environment constraints,
such capabilities must degrade to a deterministic, dependency-free default
rather than depend on a network call.

Accordingly the DEFAULT backend is the deterministic validator above. It is
placed behind a small `ChemistryBackend` seam (`setChemistryBackend()`), so a
stronger backend (RDKit-JS, once a runtime is known to support it) can be
swapped in later WITHOUT changing the `ChemistryValidationResult` contract or
any caller.

## Still lossy / not yet done (honest limitations)

- No valence / octet checking; `normalizedSmiles` is a stable echo, not a
  canonical ranking, and ring-closure labels are not re-emitted in the echo.
- E/Z and R/S perception are not computed (the raw stereo markers are kept but
  not interpreted).
- Aromaticity is taken from the SMILES casing; no ring-aromaticity perception
  (Hückel) is performed on Kekulé input.
