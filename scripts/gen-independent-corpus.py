#!/usr/bin/env python3
"""Regenerate FEAT-005C's locked RDKit SVG source corpus.

Requires RDKit. The script writes individual SVGs and variants.json under
src/science/skeleton/fixtures/independent-source. The committed bundle is the
actual evaluation artifact; regeneration is intentionally a development
operation.
"""
from rdkit import Chem
from rdkit.Chem import AllChem
from rdkit.Chem.Draw import rdMolDraw2D
from pathlib import Path
import json, math

MOLECULES = [
    ("benzene",241,"c1ccccc1","simple-ring"),
    ("cyclopropane",6351,"C1CC1","small-ring"),
    ("cyclobutane",9253,"C1CCC1","small-ring"),
    ("cyclopentane",9253,"C1CCCC1","simple-ring"),
    ("cyclohexane",8078,"C1CCCCC1","simple-ring"),
    ("cycloheptane",9264,"C1CCCCCC1","simple-ring"),
    ("cyclooctane",9265,"C1CCCCCCC1","simple-ring"),
    ("n-butane",7843,"CCCC","straight-chain"),
    ("n-hexane",8058,"CCCCCC","straight-chain"),
    ("n-heptane",9080,"CCCCCCC","straight-chain"),
    ("n-octane",356,"CCCCCCCC","straight-chain"),
    ("n-decane",15600,"CCCCCCCCCC","straight-chain"),
    ("isobutane",6360,"CC(C)C","branched-chain"),
    ("isopentane",6550,"CCC(C)C","branched-chain"),
    ("neopentane",10028,"CC(C)(C)C","multi-branch"),
    ("2-methylhexane",11502,"CCCCC(C)C","branched-chain"),
    ("3,3-dimethylpentane",11293,"CCC(C)(C)CC","multi-branch"),
    ("toluene",1140,"Cc1ccccc1","substituted-ring"),
    ("ethylbenzene",7500,"CCc1ccccc1","substituted-ring"),
    ("cumene",7406,"CC(C)c1ccccc1","substituted-ring"),
    ("xylene",7929,"Cc1cccc(C)c1","substituted-ring"),
    ("mesitylene",7925,"Cc1cc(C)cc(C)c1","substituted-ring"),
    ("naphthalene",931,"c1ccc2ccccc2c1","fused-ring"),
    ("indane",10326,"c1ccc2CCc2c1","fused-ring"),
    ("tetralin",11430,"c1ccc2CCCCc2c1","fused-ring"),
    ("phenanthrene",995,"c1ccc2c(c1)ccc1ccccc12","polycyclic"),
    ("fluorene",6853,"c1ccc2c(c1)Cc1ccccc1-2","polycyclic"),
    ("adamantane",9238,"C1C2CC3CC1CC(C2)C3","polycyclic"),
    ("norbornane",13620,"C1CC2CCC1C2","polycyclic"),
    ("biphenyl",7095,"c1ccc(cc1)-c1ccccc1","connected-ring"),
]

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "src/science/skeleton/fixtures/independent-source"
OUT.mkdir(parents=True, exist_ok=True)

entries = []
for name, cid, smiles, category in MOLECULES:
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise ValueError(f"Invalid SMILES: {name}")
    AllChem.Compute2DCoords(mol)
    drawer = rdMolDraw2D.MolDraw2DSVG(420, 320)
    drawer.drawOptions().padding = 0.1
    drawer.DrawMolecule(mol)
    drawer.FinishDrawing()
    (OUT / f"{name}.svg").write_text(drawer.GetDrawingText(), encoding="utf-8")

    carbon = [a.GetIdx() for a in mol.GetAtoms() if a.GetSymbol() == "C"]
    carbon_index = {idx: i for i, idx in enumerate(carbon)}
    atoms = []
    for idx in carbon:
        p = drawer.GetDrawCoords(idx)
        atoms.append([round(float(p.x), 2), round(float(p.y), 2)])

    bonds = []
    for bond in mol.GetBonds():
        a, b = bond.GetBeginAtomIdx(), bond.GetEndAtomIdx()
        if a in carbon_index and b in carbon_index:
            bonds.append([carbon_index[a], carbon_index[b]])

    v, e = len(atoms), len(bonds)
    adjacency = [[] for _ in atoms]
    for a, b in bonds:
        adjacency[a].append(b)
        adjacency[b].append(a)
    seen, components = set(), 0
    for start in range(v):
        if start in seen:
            continue
        components += 1
        stack = [start]
        seen.add(start)
        while stack:
            u = stack.pop()
            for w in adjacency[u]:
                if w not in seen:
                    seen.add(w)
                    stack.append(w)
    bond_lengths = [
        math.hypot(atoms[a][0] - atoms[b][0], atoms[a][1] - atoms[b][1])
        for a, b in bonds
    ]
    entries.append({
        "file": f"{name}.svg",
        "name": name,
        "source": "PubChem",
        "cid": cid,
        "smiles": smiles,
        "category": category,
        "split": "evaluation",
        "atoms": atoms,
        "bonds": bonds,
        "expectedCycleRank": e - v + components,
        "bondLengthPx": sum(bond_lengths) / len(bond_lengths),
        "hasLabels": False,
    })

(OUT / "variants.json").write_text(
    json.dumps({"renderer":"RDKit MolDraw2DSVG","count":len(entries),"variants":entries}, indent=2) + "\n",
    encoding="utf-8",
)
print(f"Wrote {len(entries)} independent SVG structures to {OUT}")
