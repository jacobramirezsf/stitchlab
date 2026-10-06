"""Machine-safety and quality validation of compiled plans and written files."""

from __future__ import annotations

import pyembroidery

DST_MAX_DELTA_MM = 12.1


def validate_file(path, max_stitch_mm=None):
    """Read a written file back and check machine limits. Returns a dict of
    stats plus a list of warnings (empty = clean)."""
    p = pyembroidery.read(path)
    warnings = []
    prev = None
    max_len = 0.0
    tiny = 0
    stitches = jumps = trims = 0
    trim_positions = []
    for x, y, cmd in p.stitches:
        c = cmd & pyembroidery.COMMAND_MASK
        if c == pyembroidery.STITCH:
            stitches += 1
            if prev is not None:
                d = ((x - prev[0]) ** 2 + (y - prev[1]) ** 2) ** 0.5 / 10
                max_len = max(max_len, d)
                if 0 < d < 0.25:
                    tiny += 1
        elif c == pyembroidery.JUMP:
            jumps += 1
            if prev is not None:
                # DST limit is ±12.1mm per AXIS, not euclidean
                d = max(abs(x - prev[0]), abs(y - prev[1])) / 10
                if d > DST_MAX_DELTA_MM:
                    warnings.append(f"jump axis delta {d:.1f}mm exceeds {DST_MAX_DELTA_MM}")
        elif c == pyembroidery.TRIM:
            trims += 1
            trim_positions.append(len(p.stitches))
        prev = (x, y)
    if max_len > DST_MAX_DELTA_MM:
        warnings.append(f"stitch delta {max_len:.1f}mm exceeds {DST_MAX_DELTA_MM}")
    if max_stitch_mm and max_len > max_stitch_mm:
        warnings.append(f"stitch {max_len:.1f}mm exceeds configured max {max_stitch_mm}")
    ext = p.extents()
    return {
        "stitches": stitches,
        "jumps": jumps,
        "trims": trims,
        "max_stitch_mm": round(max_len, 2),
        "tiny_stitches": tiny,
        "size_mm": (round((ext[2] - ext[0]) / 10, 1), round((ext[3] - ext[1]) / 10, 1)),
        "warnings": warnings,
    }


def density_warnings(plan, cell_mm: float = 1.0, ceiling_per_mm2: float = 14.0):
    """Grid the needle penetrations; flag cells that stack past the ceiling
    (≈ what 0.35mm effective spacing looks like when layers pile up)."""
    import numpy as np
    import pyembroidery as pe
    pts = [(x, y) for c, x, y in plan.commands if c == pe.STITCH]
    if not pts:
        return []
    arr = np.array(pts)
    cells = np.floor(arr / cell_mm).astype(int)
    from collections import Counter
    counts = Counter(map(tuple, cells))
    limit = ceiling_per_mm2 * cell_mm * cell_mm
    hot = [(c, n) for c, n in counts.items() if n > limit]
    warnings = []
    if hot:
        worst = max(hot, key=lambda t: t[1])
        warnings.append(
            f"density: {len(hot)} zone(s) exceed {ceiling_per_mm2:.0f} "
            f"penetrations/mm² (worst {worst[1] / (cell_mm * cell_mm):.0f} at "
            f"{worst[0][0] * cell_mm:.0f},{worst[0][1] * cell_mm:.0f}mm)")
    return warnings


def ties_at_trims(plan, tie_max_mm: float = 0.9, window: int = 4):
    """Every TRIM should have tie stitches just before it, and the block
    entered after the following jump(s) should tie in. Ties read as short
    (< tie_max_mm) stitch deltas near the boundary."""
    import math
    import pyembroidery as pe
    cmds = plan.commands
    warnings = []

    def is_micro(i, j):
        (c1, x1, y1), (c2, x2, y2) = cmds[i], cmds[j]
        return math.dist((x1, y1), (x2, y2)) < tie_max_mm

    for idx, (c, _x, _y) in enumerate(cmds):
        if c != pe.TRIM:
            continue
        # look back over stitches for at least one micro delta
        back = [i for i in range(max(0, idx - window - 1), idx)
                if cmds[i][0] == pe.STITCH]
        ok_out = any(is_micro(a, b) for a, b in zip(back, back[1:]))
        # look forward past jumps for tie-in
        fwd = [i for i in range(idx + 1, min(len(cmds), idx + window + 6))
               if cmds[i][0] == pe.STITCH][:window]
        ok_in = any(is_micro(a, b) for a, b in zip(fwd, fwd[1:]))
        if not ok_out:
            warnings.append(f"trim at command {idx}: no tie-off before trim")
        if not ok_in:
            warnings.append(f"trim at command {idx}: no tie-in after trim")
    return warnings


def validate_plan(plan, max_stitch_mm=12.1, tiny_frac_limit=0.08):
    """Full plan-level validation: machine limits, density, ties."""
    import math
    import pyembroidery as pe
    warnings = []
    prev = None
    max_len, tiny, stitches = 0.0, 0, 0
    for c, x, y in plan.commands:
        if c == pe.STITCH:
            stitches += 1
            if prev is not None and prev[0] == pe.STITCH:
                d = math.dist(prev[1:], (x, y))
                max_len = max(max_len, d)
                if 0 < d < 0.25:
                    tiny += 1
        elif c == pe.JUMP and prev is not None:
            d = max(abs(x - prev[1]), abs(y - prev[2]))
            if d > max_stitch_mm:
                warnings.append(f"jump axis delta {d:.1f}mm exceeds {max_stitch_mm}")
        prev = (c, x, y)
    if max_len > max_stitch_mm:
        warnings.append(f"stitch delta {max_len:.1f}mm exceeds {max_stitch_mm}")
    if stitches and tiny / stitches > tiny_frac_limit:
        warnings.append(f"{100 * tiny / stitches:.0f}% of stitches are micro (<0.25mm)")
    warnings += density_warnings(plan)
    warnings += ties_at_trims(plan)
    return {"stitches": stitches, "max_stitch_mm": round(max_len, 2),
            "tiny_stitches": tiny, "trims": plan.trims, "warnings": warnings}


def validate_files(paths):
    """Read back every written format; cross-check stitch counts agree."""
    stats = {p: validate_file(p) for p in paths}
    counts = {p: s["stitches"] for p, s in stats.items()}
    if len(set(counts.values())) > 1:
        lo, hi = min(counts.values()), max(counts.values())
        if hi - lo > max(5, hi * 0.01):
            for p, s in stats.items():
                s["warnings"].append(
                    f"stitch count varies across formats: {counts}")
            # only annotate once
            return stats
    return stats
