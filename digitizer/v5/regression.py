"""Regression: run the 22 TLS designs through V5's line-art path and diff
stitch counts / trims against the V4 outputs.

Usage (from digitizer/):
    .venv/bin/python -m v5.regression                    # report vs V4
    .venv/bin/python -m v5.regression --write-baseline   # freeze current numbers
    .venv/bin/python -m v5.regression --check            # fail if drifted from baseline
"""

import glob
import json
import os
import sys

import pyembroidery
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from v5.compile import compile_objects, render_preview, write_outputs  # noqa: E402
from v5.frontends.lineart import digitize_lineart  # noqa: E402
from v5.objects import StitchProperties  # noqa: E402
from v5.validate import validate_file  # noqa: E402

MM_PER_PX = 0.0625
RASTER_DIR = "raster"
V4_DIR = "output"
V5_DIR = "v5/output"
BASELINE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "regression-baseline.json")
STITCH_DRIFT = 0.02   # ±2% stitches allowed before --check fails
TRIM_DRIFT = 2        # ±2 trims allowed


def v4_stats(name):
    path = os.path.join(V4_DIR, f"{name}V4.dst")
    if not os.path.exists(path):
        return None
    p = pyembroidery.read_dst(path)
    stitches = sum(1 for *_xy, c in p.stitches
                   if (c & pyembroidery.COMMAND_MASK) == pyembroidery.STITCH)
    trims = sum(1 for *_xy, c in p.stitches
                if (c & pyembroidery.COMMAND_MASK) == pyembroidery.TRIM)
    return {"stitches": stitches, "trims": trims}


def main():
    os.makedirs(V5_DIR, exist_ok=True)
    # Redwork props matching V4's parameters.
    props = StitchProperties(
        run_length=2.2, run_min_length=0.8, run_tolerance=0.15,
        bean_repeats=3, tie_size=0.5,
    )
    print(f"{'design':<20}{'V4 st':>7}{'V5 st':>7}{'Δ%':>7}{'V4 tr':>7}{'V5 tr':>7}  warnings")
    rows = []
    for raster in sorted(glob.glob(os.path.join(RASTER_DIR, "*.png"))):
        name = os.path.splitext(os.path.basename(raster))[0]
        objects = digitize_lineart(raster, MM_PER_PX, props=props)
        plan = compile_objects(objects)
        out_base = os.path.join(V5_DIR, f"{name}V5")
        write_outputs(plan, out_base, formats=("dst", "pes"))
        render_preview(plan, out_base + "-preview.png",
                       background=Image.open(raster), mm_per_px=MM_PER_PX)
        stats = validate_file(out_base + ".dst")
        old = v4_stats(name)
        delta = (100 * (stats["stitches"] - old["stitches"]) / old["stitches"]) if old else 0
        warn = "; ".join(stats["warnings"]) or "-"
        print(f"{name:<20}{old['stitches'] if old else '-':>7}{stats['stitches']:>7}"
              f"{delta:>6.0f}%{old['trims'] if old else '-':>7}{stats['trims']:>7}  {warn}")
        rows.append((name, old, stats))
    return rows


def check_baseline(rows):
    """Compare a regression run against the frozen baseline. Any drift past
    the tolerances is a failure — deviations need explanation, not silence."""
    with open(BASELINE) as f:
        baseline = json.load(f)
    failures = []
    current = {name: stats for name, _old, stats in rows}
    for name, want in baseline.items():
        got = current.get(name)
        if got is None:
            failures.append(f"{name}: missing from run")
            continue
        if abs(got["stitches"] - want["stitches"]) > want["stitches"] * STITCH_DRIFT:
            failures.append(f"{name}: stitches {want['stitches']} → {got['stitches']}")
        if abs(got["trims"] - want["trims"]) > TRIM_DRIFT:
            failures.append(f"{name}: trims {want['trims']} → {got['trims']}")
        if got["warnings"]:
            failures.append(f"{name}: warnings {got['warnings']}")
    for name in set(current) - set(baseline):
        failures.append(f"{name}: not in baseline (add with --write-baseline)")
    return failures


if __name__ == "__main__":
    rows = main()
    if "--write-baseline" in sys.argv:
        data = {name: {"stitches": s["stitches"], "trims": s["trims"]}
                for name, _old, s in rows}
        with open(BASELINE, "w") as f:
            json.dump(data, f, indent=1, sort_keys=True)
        print(f"\nbaseline written: {BASELINE} ({len(data)} designs)")
    elif "--check" in sys.argv:
        failures = check_baseline(rows)
        if failures:
            print("\nBASELINE DRIFT:")
            for f_ in failures:
                print(f"  {f_}")
            raise SystemExit(1)
        print("\nbaseline check: clean")
