#!/usr/bin/env python3
"""FEAT-005B — render the real-world carbon-skeleton benchmark corpus to PNG.

Reads the manifest written by `manifest.test.ts`
(`src/science/skeleton/fixtures/realworld/manifest.json`) — the single source of
truth for geometry — and renders each structure to a genuine anti-aliased PNG
using Pillow with 4x supersampling. It emits:

  fixtures/realworld/png/<name>.png                 the base clean render
  fixtures/realworld/png/<name>__<transform>.png    robustness variants

Transforms (applied only to the HELD-OUT evaluation split, so the development
split stays clean for iteration; the base render is produced for every
structure):
  rot15, rot30           rotation
  jpegish                moderate lossy-compression artefacts (quantise+blur)
  gauss, saltpepper      additive Gaussian / salt-and-pepper noise
  thin, thick            line-weight variation
  lowres                 reduced resolution (downscale+upscale)
  contrast               reduced contrast
  skew                   slight shear

These are REAL structures rendered by a raster engine (not scanned pages); the
benchmark report states that limitation plainly.
"""

import json
import math
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageFilter

SS = 4  # supersampling factor for anti-aliasing
ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "src/science/skeleton/fixtures/realworld/manifest.json"
OUT = ROOT / "src/science/skeleton/fixtures/realworld/png"


def load_font(size):
    for name in [
        "DejaVuSans.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]:
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            continue
    return ImageFont.load_default()


def render_base(struct):
    """Render a clean anti-aliased PNG of one structure. Returns an RGB image."""
    w, h = struct["width"], struct["height"]
    lw = max(1, int(round(struct["lineWidth"])))
    img = Image.new("RGB", (w * SS, h * SS), "white")
    d = ImageDraw.Draw(img)
    atoms = struct["atoms"]
    for a, b in struct["bonds"]:
        (x0, y0) = atoms[a]
        (x1, y1) = atoms[b]
        d.line(
            [(x0 * SS, y0 * SS), (x1 * SS, y1 * SS)],
            fill="black",
            width=lw * SS,
            joint="curve",
        )
    # Labels (element / group text next to or touching bonds).
    font = load_font(14 * SS)
    for (lx, ly, text) in struct.get("labels", []):
        d.text((lx * SS, ly * SS), text, fill="black", font=font)
    # Downsample for anti-aliasing.
    return img.resize((w, h), Image.LANCZOS)


def rotate_coords(atoms, deg, in_w, in_h, out_w, out_h):
    """Replicate PIL's Image.rotate(expand=True) coordinate transform.

    PIL rotates about the image centre COUNTER-clockwise by `deg`, then expands
    the canvas and recentres. We map each atom accordingly so ground truth stays
    aligned with the rotated PNG.
    """
    th = math.radians(deg)
    cos, sin = math.cos(th), math.sin(th)
    cx_in, cy_in = in_w / 2.0, in_h / 2.0
    cx_out, cy_out = out_w / 2.0, out_h / 2.0
    out = []
    for (x, y) in atoms:
        dx, dy = x - cx_in, y - cy_in
        # PIL rotates the sampling grid; image content rotates by -deg visually
        # for +deg argument in screen coords (y-down). Use the standard screen
        # rotation that matches Image.rotate for y-down coordinates.
        rx = dx * cos + dy * sin
        ry = -dx * sin + dy * cos
        out.append([rx + cx_out, ry + cy_out])
    return out


def skew_coords(atoms, shear, in_h):
    # Matches t_skew's AFFINE (1, shear, tx, 0, 1, 0) with the inverse mapping
    # PIL applies: output(x,y) samples input(x + shear*y + tx, y). So an input
    # point (ix, iy) lands at output x = ix - shear*iy - tx.
    tx = -shear * in_h if shear > 0 else 0
    return [[ix - shear * iy - tx, iy] for (ix, iy) in atoms]


def t_rotate(img, deg):
    return img.rotate(deg, resample=Image.BICUBIC, expand=True, fillcolor="white")


def t_jpegish(img):
    # Mimic moderate lossy compression: posterise + light blur (no JPEG dep
    # needed, but visually similar block/ringing softening).
    small = img.filter(ImageFilter.GaussianBlur(0.6))
    return small.quantize(colors=16).convert("RGB")


def t_gauss(img):
    import numpy as np
    arr = np.asarray(img).astype(np.float32)
    noise = np.random.default_rng(42).normal(0, 16, arr.shape)
    out = np.clip(arr + noise, 0, 255).astype("uint8")
    return Image.fromarray(out)


def t_saltpepper(img):
    import numpy as np
    arr = np.asarray(img).copy()
    rng = np.random.default_rng(7)
    mask = rng.random(arr.shape[:2])
    arr[mask < 0.02] = 0
    arr[mask > 0.98] = 255
    return Image.fromarray(arr)


def t_thin(struct):
    s = dict(struct)
    s["lineWidth"] = max(1, struct["lineWidth"] - 1)
    return render_base(s)


def t_thick(struct):
    s = dict(struct)
    s["lineWidth"] = struct["lineWidth"] + 2
    return render_base(s)


def t_lowres(img):
    w, h = img.size
    small = img.resize((max(1, w // 2), max(1, h // 2)), Image.BILINEAR)
    return small.resize((w, h), Image.BILINEAR)


def t_contrast(img):
    import numpy as np
    arr = np.asarray(img).astype(np.float32)
    # Compress the dynamic range toward mid-gray (reduced contrast).
    out = np.clip(128 + (arr - 128) * 0.55, 0, 255).astype("uint8")
    return Image.fromarray(out)


def t_skew(img):
    w, h = img.size
    shear = 0.18
    new_w = int(w + abs(shear) * h)
    return img.transform(
        (new_w, h),
        Image.AFFINE,
        (1, shear, -shear * h if shear > 0 else 0, 0, 1, 0),
        resample=Image.BICUBIC,
        fillcolor="white",
    )


def main():
    if not MANIFEST.exists():
        print(f"manifest not found: {MANIFEST}", file=sys.stderr)
        print("run: ITO_WRITE_REALWORLD_MANIFEST=1 npx vitest run "
              "src/science/skeleton/realworld/manifest", file=sys.stderr)
        sys.exit(1)
    manifest = json.loads(MANIFEST.read_text())
    OUT.mkdir(parents=True, exist_ok=True)

    written = 0
    # variants.json records, for EVERY rendered file, the ground-truth atom
    # coordinates in that file's pixel space (transformed for geometric ops) so
    # the TypeScript benchmark can score without guessing the transform.
    variants_manifest = []

    for struct in manifest["structures"]:
        name = struct["name"]
        atoms = struct["atoms"]
        bonds = struct["bonds"]
        has_labels = len(struct.get("labels", [])) > 0
        base = render_base(struct)
        base.save(OUT / f"{name}.png")
        written += 1
        variants_manifest.append({
            "file": f"{name}.png",
            "name": name,
            "transform": "base",
            "category": struct["category"],
            "split": struct["split"],
            "atoms": atoms,
            "bonds": bonds,
            "expectedCycleRank": struct["expectedCycleRank"],
            "bondLengthPx": struct["bondLengthPx"],
            "hasLabels": has_labels,
        })

        if struct["split"] != "evaluation":
            continue

        in_w, in_h = base.size
        rot15 = t_rotate(base, 15)
        rot30 = t_rotate(base, 30)
        skew = t_skew(base)

        variants = [
            ("rot15", rot15, rotate_coords(atoms, 15, in_w, in_h, rot15.size[0], rot15.size[1])),
            ("rot30", rot30, rotate_coords(atoms, 30, in_w, in_h, rot30.size[0], rot30.size[1])),
            ("jpegish", t_jpegish(base), atoms),
            ("gauss", t_gauss(base), atoms),
            ("saltpepper", t_saltpepper(base), atoms),
            ("thin", t_thin(struct), atoms),
            ("thick", t_thick(struct), atoms),
            ("lowres", t_lowres(base), atoms),
            ("contrast", t_contrast(base), atoms),
            ("skew", skew, skew_coords(atoms, 0.18, in_h)),
        ]
        for tname, vimg, vatoms in variants:
            fname = f"{name}__{tname}.png"
            vimg.convert("RGB").save(OUT / fname)
            written += 1
            variants_manifest.append({
                "file": fname,
                "name": name,
                "transform": tname,
                "category": struct["category"],
                "split": struct["split"],
                "atoms": [[round(x, 1), round(y, 1)] for (x, y) in vatoms],
                "bonds": bonds,
                "expectedCycleRank": struct["expectedCycleRank"],
                "bondLengthPx": struct["bondLengthPx"],
                "hasLabels": has_labels,
            })

    (OUT.parent / "variants.json").write_text(
        json.dumps({"count": len(variants_manifest), "variants": variants_manifest}, indent=2) + "\n"
    )
    print(f"wrote {written} PNG files to {OUT}")
    print(f"wrote variants.json with {len(variants_manifest)} entries")


if __name__ == "__main__":
    main()
