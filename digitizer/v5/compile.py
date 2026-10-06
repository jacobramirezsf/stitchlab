"""Compiler: StitchObjects → sequenced stitch plan → embroidery files.

Sequencing: greedy nearest-neighbor over object entry/exit candidates
(2-opt improvement arrives in Phase 3). Transits between objects follow the
three-tier model (Embrilliance "Ties and Transits"):

    gap ≤ connect_mm  → nested running stitches, no tie, no trim
    gap ≤ trim_mm     → tie-off, jump, tie-in (thread drag, hand-trimmable)
    gap >  trim_mm    → tie-off, TRIM, jump(s), tie-in

Output: DST/PES/EXP/JEF via pyembroidery + a color-coded preview PNG.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import pyembroidery

from .geometry import resample
from .objects import StitchBlock, StitchObject

KIND_COLORS = {
    "travel": (200, 200, 160),
    "run": (26, 60, 130),
    "bean": (26, 60, 130),
    "satin": (150, 40, 120),
    "fill": (30, 110, 60),
    "underlay": (170, 170, 170),
    "motif": (200, 120, 30),
    "manual": (190, 60, 40),
    "tack": (120, 120, 40),
}


@dataclass
class TransitPolicy:
    connect_mm: float = 1.2
    trim_mm: float = 5.0
    max_move_mm: float = 10.0
    connect_stitch: float = 1.5   # nested run length for tier-1 transits


@dataclass
class StitchPlan:
    """Flat machine program: list of (command, x, y) in mm plus stats."""
    commands: list = field(default_factory=list)   # (cmd, x, y)
    trims: int = 0
    color_changes: int = 0
    blocks: list = field(default_factory=list)     # StitchBlocks for preview

    def stitch_count(self):
        return sum(1 for c, *_ in self.commands if c == pyembroidery.STITCH)


def _tie_points(p, toward, mode: str, size: float):
    if mode == "none":
        return []
    d = np.asarray(toward, float)
    n = math.hypot(*d)
    d = d / n * size if n > 1e-9 else np.array([size, 0.0])
    if mode == "triangle":
        e = np.array([-d[1], d[0]])
        return [p + d, p + e * 0.8, p]
    return [p + d, p]  # small_run


TRIM_COST = 12.0   # a trim "costs" this many mm of travel in the optimizer
EXACT_MAX_UNITS = 10


def _build_units(objects, color):
    units, seen_groups = [], {}
    for o in objects:
        if o.color != color:
            continue
        if o.group is None:
            units.append([o])
        elif o.group in seen_groups:
            seen_groups[o.group].append(o)
        else:
            seen_groups[o.group] = [o]
            units.append(seen_groups[o.group])
    return units


def _unit_entry_exit(unit, reverse):
    if not reverse:
        return unit[0].endpoints()[0][0], unit[-1].endpoints()[0][1]
    if any(len(o.endpoints()) < 2 for o in unit):
        return None
    return unit[-1].endpoints()[1][0], unit[0].endpoints()[1][1]


def _transit_cost(d, transit):
    if d <= transit.connect_mm:
        return d * 0.1
    if d > transit.trim_mm:
        return d + TRIM_COST
    return d


def _order_exact(units, pos, transit):
    """Held-Karp over (subset, last unit, orientation) — exact for small N."""
    n = len(units)
    ees = [[_unit_entry_exit(u, r) for r in (False, True)] for u in units]
    import math as m
    INF = float("inf")
    # dp[(mask, i, r)] = (cost, parent)
    dp = {}
    for i in range(n):
        for r in (0, 1):
            if ees[i][r] is None:
                continue
            entry, _ = ees[i][r]
            dp[(1 << i, i, r)] = (_transit_cost(m.dist(pos, entry), transit), None)
    full = (1 << n) - 1
    for mask in range(1, full + 1):
        for i in range(n):
            if not mask & (1 << i):
                continue
            for r in (0, 1):
                key = (mask, i, r)
                if key not in dp:
                    continue
                cost, _ = dp[key]
                _, exit_i = ees[i][r]
                for j in range(n):
                    if mask & (1 << j):
                        continue
                    for r2 in (0, 1):
                        if ees[j][r2] is None:
                            continue
                        entry_j, _ = ees[j][r2]
                        nc = cost + _transit_cost(m.dist(exit_i, entry_j), transit)
                        nkey = (mask | (1 << j), j, r2)
                        if nkey not in dp or nc < dp[nkey][0]:
                            dp[nkey] = (nc, key)
    best_key, best_cost = None, INF
    for i in range(n):
        for r in (0, 1):
            key = (full, i, r)
            if key in dp and dp[key][0] < best_cost:
                best_key, best_cost = key, dp[key][0]
    order = []
    key = best_key
    while key is not None:
        mask, i, r = key
        order.append((units[i], bool(r)))
        key = dp[key][1]
    order.reverse()
    return order


def _order_2opt(units, pos, transit):
    """Greedy NN then 2-opt segment reversal (reversing a segment flips each
    unit's orientation — proper 2-opt for TSP-with-direction)."""
    import math as m
    remaining = list(range(len(units)))
    seq = []   # (unit_index, reversed)
    cur = pos
    while remaining:
        best = None
        for ui in remaining:
            for r in (False, True):
                ee = _unit_entry_exit(units[ui], r)
                if ee is None:
                    continue
                d = m.dist(cur, ee[0])
                if best is None or d < best[0]:
                    best = (d, ui, r)
        _, ui, r = best
        remaining.remove(ui)
        seq.append((ui, r))
        cur = _unit_entry_exit(units[ui], r)[1]

    def seq_cost(sq):
        c, cur = 0.0, pos
        for ui, r in sq:
            ee = _unit_entry_exit(units[ui], r)
            if ee is None:
                return float("inf")
            c += _transit_cost(m.dist(cur, ee[0]), transit)
            cur = ee[1]
        return c

    improved = True
    guard = 0
    best_cost = seq_cost(seq)
    while improved and guard < 30:
        improved = False
        guard += 1
        for i in range(len(seq) - 1):
            for j in range(i + 1, len(seq)):
                cand = seq[:i] + [(ui, not r) for ui, r in reversed(seq[i:j + 1])] + seq[j + 1:]
                c = seq_cost(cand)
                if c + 1e-9 < best_cost:
                    seq, best_cost, improved = cand, c, True
    return [(units[ui], r) for ui, r in seq]


def sequence_objects(objects: list[StitchObject], start=np.array([0.0, 0.0]),
                     transit=None, color_order=None):
    """Route optimization over UNITS (single objects or sequence groups).
    Exact Held-Karp for ≤ EXACT_MAX_UNITS units per color, NN + 2-opt beyond.
    Colors keep a layering-meaningful order (insertion by default,
    `color_order` to override) — color order is a design semantic, not a
    travel optimization."""
    transit = transit or TransitPolicy()
    order: list[tuple[StitchObject, int]] = []
    colors_seen = []
    for o in objects:
        if o.color not in colors_seen:
            colors_seen.append(o.color)
    if color_order is not None:
        colors_seen = [c for c in color_order if c in colors_seen] + \
                      [c for c in colors_seen if c not in color_order]

    pos = np.asarray(start, float)
    for color in colors_seen:
        units = _build_units(objects, color)
        if not units:
            continue
        if len(units) <= EXACT_MAX_UNITS:
            placed = _order_exact(units, pos, transit)
        else:
            placed = _order_2opt(units, pos, transit)
        for unit, rev in placed:
            seq = unit if not rev else unit[::-1]
            for o in seq:
                order.append((o, 1 if rev else 0))
            pos = np.asarray(_unit_entry_exit(unit, rev)[1], float)
    return order


def compile_objects(objects: list[StitchObject],
                    transit: TransitPolicy | None = None,
                    order: list | None = None,
                    color_order: list | None = None) -> StitchPlan:
    """Compile objects to a stitch plan. `order` (list of (object,
    entry_index)) overrides the optimizer for caller-dictated sequences."""
    transit = transit or TransitPolicy()
    plan = StitchPlan()
    if order is None:
        order = sequence_objects(objects, transit=transit,
                                 color_order=color_order)
    # objects later in the sequence, for burying travel beneath them
    seq_positions = {id(o): i for i, (o, _) in enumerate(order)}

    pos = None
    color = None
    for obj, entry_index in order:
        blocks = obj.underlay_blocks(entry_index) + obj.generate(entry_index)
        blocks = [b for b in blocks if len(b) >= 2]
        if not blocks:
            continue
        if color is None:
            color = obj.color
        elif obj.color != color:
            plan.commands.append((pyembroidery.COLOR_CHANGE, *(pos if pos is not None else (0, 0))))
            plan.color_changes += 1
            color = obj.color
            pos = None  # force jump-in after color change

        props = obj.props
        for block in blocks:
            if getattr(block, "stop_before", False):
                plan.commands.append((pyembroidery.STOP, *(pos if pos is not None else (0, 0))))
            first = block.points[0]
            if pos is None:
                plan.commands.append((pyembroidery.JUMP, *first))
                for q in _tie_points(first, block.points[1] - first, props.tie_in, props.tie_size):
                    plan.commands.append((pyembroidery.STITCH, *q))
            else:
                gap = math.dist(pos, first)
                buried = None
                if gap > transit.connect_mm:
                    # Try to hide the travel under an object that stitches
                    # LATER (its cover will bury these running stitches).
                    my_pos = seq_positions.get(id(obj), 0)
                    for later, _ei in order[my_pos:]:
                        if later is obj or later.color != obj.color:
                            continue
                        path = later.hidden_travel(pos, first)
                        if path is not None:
                            buried = path
                            break
                if gap <= transit.connect_mm:
                    for q in resample(np.array([pos, first]), transit.connect_stitch)[1:]:
                        plan.commands.append((pyembroidery.STITCH, *q))
                elif buried is not None:
                    travel_pts = resample(np.asarray(buried, float), transit.connect_stitch)
                    for q in travel_pts[1:]:
                        plan.commands.append((pyembroidery.STITCH, *q))
                    plan.blocks.append(StitchBlock(np.asarray(travel_pts), kind="travel",
                                                   color=obj.color))
                else:
                    for q in _tie_points(np.asarray(pos), np.asarray(pos) - first,
                                         props.tie_off, props.tie_size):
                        plan.commands.append((pyembroidery.STITCH, *q))
                    if gap > transit.trim_mm:
                        plan.commands.append((pyembroidery.TRIM, *pos))
                        plan.trims += 1
                    steps = max(1, math.ceil(gap / transit.max_move_mm))
                    for s in range(1, steps + 1):
                        q = pos + (first - np.asarray(pos)) * (s / steps)
                        plan.commands.append((pyembroidery.JUMP, *q))
                    for q in _tie_points(first, block.points[1] - first,
                                         props.tie_in, props.tie_size):
                        plan.commands.append((pyembroidery.STITCH, *q))
            plan.blocks.append(block)
            for p in block.points:
                plan.commands.append((pyembroidery.STITCH, *p))
            pos = block.points[-1]

    if pos is not None and order:
        last_props = order[-1][0].props
        for q in _tie_points(np.asarray(pos), np.array([1.0, 0.0]),
                             last_props.tie_off, last_props.tie_size):
            plan.commands.append((pyembroidery.STITCH, *q))
    plan.commands.append((pyembroidery.END, 0, 0))
    return plan


def to_pattern(plan: StitchPlan) -> pyembroidery.EmbPattern:
    pat = pyembroidery.EmbPattern()
    for cmd, x, y in plan.commands:
        if cmd in (pyembroidery.TRIM, pyembroidery.COLOR_CHANGE, pyembroidery.END,
                   pyembroidery.STOP):
            pat.add_command(cmd)
        else:
            pat.add_stitch_absolute(cmd, round(x * 10), round(y * 10))
    return pat


def write_outputs(plan: StitchPlan, out_base: str, formats=("dst", "pes", "exp", "jef")):
    pat = to_pattern(plan)
    written = []
    for fmt in formats:
        path = f"{out_base}.{fmt}"
        getattr(pyembroidery, f"write_{fmt}")(pat, path)
        written.append(path)
    return written


def render_preview(plan: StitchPlan, out_path: str, background=None,
                   mm_per_px: float | None = None, scale: float = 16.0):
    """Stitch plan preview, color-coded by block kind. If `background` (a PIL
    image) and its mm_per_px are given, draw over the faded artwork."""
    from PIL import Image, ImageDraw

    if background is not None and mm_per_px:
        base = background.convert("RGB")
        faded = Image.blend(base, Image.new("RGB", base.size, "white"), 0.82)
        s = 2 / mm_per_px
        canvas = faded.resize((base.width * 2, base.height * 2), Image.LANCZOS)
    else:
        pts = np.concatenate([b.points for b in plan.blocks]) if plan.blocks else np.zeros((1, 2))
        w = int((pts[:, 0].max() + 5) * scale)
        h = int((pts[:, 1].max() + 5) * scale)
        canvas = Image.new("RGB", (max(w, 10), max(h, 10)), "white")
        s = scale
    draw = ImageDraw.Draw(canvas)
    for block in plan.blocks:
        colorv = KIND_COLORS.get(block.kind, (0, 0, 0))
        pts = [(p[0] * s, p[1] * s) for p in block.points]
        if len(pts) >= 2:
            draw.line(pts, fill=colorv, width=2)
        for p in pts:
            draw.ellipse([p[0] - 1.2, p[1] - 1.2, p[0] + 1.2, p[1] + 1.2],
                         fill=(190, 60, 40))
    if background is not None and mm_per_px:
        canvas = canvas.resize(background.size, Image.LANCZOS)
    canvas.save(out_path)
