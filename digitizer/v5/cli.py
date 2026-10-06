"""V5 command-line interface.

    python -m v5.cli <input.svg|png|dir> [--size 50.8] [--fabric twill]
                     [--config design.toml] [-o outdir] [--formats dst,pes]
                     [--frontend auto|lineart|raster] [--colors 6]
                     [--px-per-mm 16] [--style redwork|satin]

SVG inputs are rasterized via ../rasterize.mjs (headless Chrome). A directory
input batches every .svg/.png inside it. Every run writes the requested
formats plus -preview.png and prints a stats block with validation and
density warnings.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from v5.compile import compile_objects, render_preview, write_outputs  # noqa: E402
from v5.config import ResolvedConfig  # noqa: E402
from v5.frontends.lineart import digitize_lineart  # noqa: E402
from v5.frontends.raster import digitize_raster  # noqa: E402
from v5.simulate import render_simulation  # noqa: E402
from v5.validate import (density_warnings, ties_at_trims,  # noqa: E402
                         validate_file, validate_files)

RASTERIZE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "rasterize.mjs")


def rasterize_svg(svg_path: str, out_png: str, size_mm: float, px_per_mm: float):
    result = subprocess.run(
        ["node", RASTERIZE, svg_path, out_png, str(size_mm), str(px_per_mm)],
        capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError(f"rasterize failed: {result.stderr.strip()[:200]}")
    import time
    for _ in range(40):  # chrome writes asynchronously
        if os.path.exists(out_png) and os.path.getsize(out_png) > 0:
            return
        time.sleep(0.25)
    raise RuntimeError("rasterize produced no output")


def is_lineartish(png_path: str) -> bool:
    """Heuristic: near-monochrome images take the line-art path."""
    img = Image.open(png_path).convert("RGB").resize((64, 64))
    import numpy as np
    arr = np.array(img, float)
    saturation = (arr.max(axis=2) - arr.min(axis=2)).mean()
    return saturation < 12


def digitize_one(path: str, args, cfg: ResolvedConfig) -> dict:
    name = os.path.splitext(os.path.basename(path))[0]
    os.makedirs(args.out, exist_ok=True)
    out_base = os.path.join(args.out, name)

    # source raster
    if path.lower().endswith(".svg"):
        raster = os.path.join(args.out, f".{name}-raster.png")
        rasterize_svg(path, raster, args.size, args.px_per_mm)
        mm_per_px = 1 / args.px_per_mm
    else:
        raster = path
        img = Image.open(path)
        mm_per_px = args.size / max(img.size)

    frontend = args.frontend
    if frontend == "auto":
        frontend = "lineart" if is_lineartish(raster) else "raster"

    props = cfg.properties()
    if frontend == "raster":
        objects, _palette = digitize_raster(raster, mm_per_px,
                                            n_colors=args.colors, props=props)
    else:
        la = cfg.lineart()
        if args.style:
            la["style"] = args.style
        objects = digitize_lineart(raster, mm_per_px, props=props,
                                   style=la["style"], params=la)
    cfg.apply_object_overrides(objects)
    if not objects:
        return {"name": name, "error": "no stitchable objects"}

    plan = compile_objects(objects, transit=cfg.transit())
    formats = tuple(args.formats.split(",")) if args.formats else tuple(cfg.output()["formats"])
    files = write_outputs(plan, out_base, formats=formats)
    render_preview(plan, out_base + "-preview.png",
                   background=Image.open(raster), mm_per_px=mm_per_px)
    if path.lower().endswith(".svg") and os.path.exists(raster):
        os.unlink(raster)

    if args.simulate:
        render_simulation(plan, out_base + "-sim.png")

    stats = validate_file(files[0])
    stats["warnings"] += density_warnings(plan)
    stats["warnings"] += ties_at_trims(plan)
    # read back every written format; flag if stitch counts disagree
    for fstats in validate_files(files).values():
        for w in fstats["warnings"]:
            if w not in stats["warnings"]:
                stats["warnings"].append(w)
    stats["name"] = name
    stats["files"] = files + [out_base + "-preview.png"] + \
        ([out_base + "-sim.png"] if args.simulate else [])
    stats["objects"] = len(objects)
    stats["frontend"] = frontend
    if cfg.fabric:
        stats["fabric"] = cfg.fabric
    return stats


def main(argv=None):
    ap = argparse.ArgumentParser(prog="digitize", description=__doc__)
    ap.add_argument("input", help="SVG/PNG file or a directory to batch")
    ap.add_argument("--size", type=float, default=50.8,
                    help="design size in mm (longer side)")
    ap.add_argument("--px-per-mm", type=float, default=16.0)
    ap.add_argument("--fabric", default=None,
                    help="fabric preset: twill/denim/knit/canvas/cap")
    ap.add_argument("--config", default=None, help="design TOML config")
    ap.add_argument("-o", "--out", default="v5/output")
    ap.add_argument("--formats", default=None, help="e.g. dst,pes,exp,jef")
    ap.add_argument("--frontend", choices=("auto", "lineart", "raster"),
                    default="auto")
    ap.add_argument("--style", choices=("redwork", "satin", "master"), default=None)
    ap.add_argument("--colors", type=int, default=6,
                    help="raster frontend: palette size")
    ap.add_argument("--simulate", action="store_true",
                    help="also render a thread simulation (-sim.png)")
    args = ap.parse_args(argv)

    cfg = ResolvedConfig(fabric=args.fabric, config_path=args.config)

    if os.path.isdir(args.input):
        paths = sorted(
            os.path.join(args.input, f) for f in os.listdir(args.input)
            if f.lower().endswith((".svg", ".png")) and not f.startswith("."))
    else:
        paths = [args.input]

    results = []
    for path in paths:
        try:
            stats = digitize_one(path, args, cfg)
        except Exception as e:  # batch keeps going
            stats = {"name": os.path.basename(path), "error": str(e)[:200]}
        results.append(stats)
        line = {k: v for k, v in stats.items() if k != "files"}
        print(json.dumps(line))
    bad = [r for r in results if r.get("error") or r.get("warnings")]
    return 1 if any(r.get("error") for r in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
