#!/usr/bin/env python3
"""Extract Jacob's digitizing house style from reference embroidery files.

Reads every embroidery file in reference/, measures the habits that matter to
the auto-digitizer, and prints per-file + aggregate numbers:

  - run-stitch length profile (median/p25/p75 of straight-travel stitches)
  - bean usage: share of stitches in immediate back-and-forth repeats
  - zigzag/satin usage: alternating-direction runs, their width + advance
  - trims + jumps per 1000 stitches, jump length profile
  - tie style: micro-stitch (<0.9mm) cluster size around block boundaries
  - overall density: stitches per mm² of bounding box
"""

import glob
import math
import os
import sys
from collections import Counter

import numpy as np
import pyembroidery


def analyze(path):
    p = pyembroidery.read(path)
    if p is None:
        return None
    st = [(x, y, cmd & pyembroidery.COMMAND_MASK) for x, y, cmd in p.stitches]
    cmds = Counter(c for _, _, c in st)
    ext = p.extents()
    w_mm, h_mm = (ext[2] - ext[0]) / 10, (ext[3] - ext[1]) / 10

    # Deltas between consecutive STITCH commands (0.1mm units → mm).
    deltas = []
    prev = None
    for x, y, c in st:
        if c == pyembroidery.STITCH and prev is not None and prev[2] == pyembroidery.STITCH:
            deltas.append(((x - prev[0]) / 10, (y - prev[1]) / 10))
        prev = (x, y, c)
    if not deltas:
        return None
    d = np.array(deltas)
    lens = np.hypot(d[:, 0], d[:, 1])

    # Bean: immediate reversal pairs (delta_{i+1} ≈ -delta_i).
    rev = np.sum(d[1:] * d[:-1], axis=1)
    closeness = np.hypot(*(d[1:] + d[:-1]).T)
    bean_pairs = (closeness < 0.15) & (lens[1:] > 0.3)
    bean_frac = bean_pairs.mean()

    # Zigzag/satin: alternating direction runs (negative dot) that are NOT
    # pure reversals — the needle swings side to side while advancing.
    alt = (rev < 0) & ~bean_pairs
    runs = []
    n = 0
    for a in alt:
        n = n + 1 if a else 0
        if n >= 6:
            runs.append(n)
    zig_mask = np.zeros(len(d), bool)
    n = 0
    for i, a in enumerate(alt):
        n = n + 1 if a else 0
        if n >= 6:
            zig_mask[max(0, i - n + 1):i + 2] = True
    zig_frac = zig_mask.mean()
    zig_widths = lens[zig_mask] if zig_mask.any() else np.array([])
    # Advance = midpoint progression between successive swings.
    if zig_mask.sum() > 4:
        idx = np.nonzero(zig_mask)[0]
        mids = d[idx[:-1]] / 2 + d[idx[1:]] / 2
        advances = np.hypot(mids[:, 0], mids[:, 1])
        advance = float(np.median(advances[advances < 2]))
    else:
        advance = None

    # Plain running stitches: not bean, not zigzag.
    run_mask = ~zig_mask
    run_mask[1:] &= ~bean_pairs
    run_lens = lens[run_mask & (lens > 0.9)]  # ignore micro/tie stitches

    # Ties: micro-stitch clusters.
    micro = lens < 0.9
    micro_frac = micro.mean()

    trims = cmds.get(pyembroidery.TRIM, 0)
    jumps = cmds.get(pyembroidery.JUMP, 0)
    stitches = cmds.get(pyembroidery.STITCH, 0)
    colors = cmds.get(pyembroidery.COLOR_CHANGE, 0)

    return {
        "name": os.path.basename(path),
        "stitches": stitches,
        "size": f"{w_mm:.0f}x{h_mm:.0f}",
        "density": stitches / max(w_mm * h_mm, 1),
        "run_med": float(np.median(run_lens)) if len(run_lens) else None,
        "run_p25": float(np.percentile(run_lens, 25)) if len(run_lens) else None,
        "run_p75": float(np.percentile(run_lens, 75)) if len(run_lens) else None,
        "bean_frac": float(bean_frac),
        "zig_frac": float(zig_frac),
        "zig_w_med": float(np.median(zig_widths)) if len(zig_widths) else None,
        "zig_advance": advance,
        "micro_frac": float(micro_frac),
        "trims_per_1k": 1000 * trims / max(stitches, 1),
        "colors": colors,
    }


def main():
    rows = []
    for path in sorted(glob.glob("digitizer/reference/*")):
        if path.lower().endswith((".md", ".ds_store")) or os.path.basename(path).startswith("."):
            continue
        try:
            r = analyze(path)
            if r:
                rows.append(r)
        except Exception as e:
            print(f"{os.path.basename(path)}: unreadable ({e})", file=sys.stderr)

    fmt = "{name:<28}{stitches:>7} {size:>9} {density:>5.2f} {run:>11} {bean:>5} {zig:>5} {zigw:>5} {adv:>5} {trims:>6}"
    print(f"{'file':<28}{'stitch':>7} {'size mm':>9} {'dens':>5} {'run med/iqr':>11} {'bean':>5} {'zig%':>5} {'zigW':>5} {'adv':>5} {'tr/1k':>6}")
    for r in rows:
        print(fmt.format(
            name=r["name"][:27], stitches=r["stitches"], size=r["size"], density=r["density"],
            run=f"{r['run_med']:.1f}({r['run_p25']:.1f}-{r['run_p75']:.1f})" if r["run_med"] else "-",
            bean=f"{r['bean_frac']*100:.0f}%", zig=f"{r['zig_frac']*100:.0f}%",
            zigw=f"{r['zig_w_med']:.1f}" if r["zig_w_med"] else "-",
            adv=f"{r['zig_advance']:.2f}" if r["zig_advance"] else "-",
            trims=f"{r['trims_per_1k']:.1f}",
        ))

    # Aggregates (median across files).
    def med(key):
        vals = [r[key] for r in rows if r[key] is not None]
        return float(np.median(vals)) if vals else None

    print("\n── corpus medians ──")
    print(f"run stitch: {med('run_med'):.2f}mm | bean share: {med('bean_frac')*100:.0f}% | "
          f"zigzag share: {med('zig_frac')*100:.0f}% | zig width: {med('zig_w_med'):.2f}mm | "
          f"zig advance: {med('zig_advance'):.2f}mm | trims/1k: {med('trims_per_1k'):.1f} | "
          f"micro(tie) share: {med('micro_frac')*100:.1f}%")


if __name__ == "__main__":
    main()
