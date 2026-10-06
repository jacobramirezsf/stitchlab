"""Tatami fill: rotated row grating over a shapely polygon (holes honored),
serpentine routing, stagger pattern so needle penetrations don't align.

The Ink/Stitch model: intersect the region with parallel rows at `angle`,
group into sections of consecutive overlapping rows, sew each section
serpentine. Penetration stagger: row k's stitches shift by
(k % staggers)/staggers * stitch_length along the row.
"""

import math

import numpy as np
from shapely import affinity
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Polygon

# Tatami pattern presets: named stagger behaviors (Pulse: offsets as % of
# stitch length, including random).
PATTERNS = {
    "standard": {"staggers": 4},
    "weave": {"staggers": 2},
    "diagonal": {"staggers": 8},
    "random": {"staggers": 0},   # 0 → per-row random phase
}


def _rows(polygon: Polygon, angle_deg: float, spacing: float):
    """Row segments in rotated frame where rows are horizontal."""
    rot = affinity.rotate(polygon, -angle_deg, origin=(0, 0), use_radians=False)
    minx, miny, maxx, maxy = rot.bounds
    rows = []
    y = miny + spacing / 2
    row_i = 0
    while y <= maxy:
        cut = rot.intersection(LineString([(minx - 1, y), (maxx + 1, y)]))
        segs = []
        if isinstance(cut, LineString) and not cut.is_empty:
            segs = [cut]
        elif isinstance(cut, MultiLineString):
            segs = [g for g in cut.geoms if g.length > 0.05]
        rows.append((row_i, y, sorted(
            (min(g.coords[0][0], g.coords[-1][0]), max(g.coords[0][0], g.coords[-1][0]))
            for g in segs)))
        y += spacing
        row_i += 1
    return rows


def tatami_stitches(polygon: Polygon, props, reverse: bool = False):
    """Returns a list of stitch-point arrays (sections), mm coordinates."""
    angle = props.angle
    rows = _rows(polygon, angle, props.row_spacing)
    L = props.fill_stitch_length
    pattern = PATTERNS.get(getattr(props, "pattern", "standard"), PATTERNS["standard"])
    staggers = pattern["staggers"] if getattr(props, "pattern", "standard") != "standard" \
        else max(1, int(props.staggers))
    rng = np.random.default_rng(1234)

    sections: list[list] = []
    current: list = []
    direction = 1
    for row_i, y, segs in rows:
        if not segs:
            if current:
                sections.append(current)
                current = []
            continue
        ordered = segs if direction == 1 else segs[::-1]
        for x0, x1 in ordered:
            a, b = (x0, x1) if direction == 1 else (x1, x0)
            # stagger: penetrations at global grid offset by row phase
            if staggers == 0:
                phase = float(rng.uniform(0, L))   # "random" pattern
            else:
                phase = (row_i % staggers) / staggers * L
            xs = _stitch_positions(a, b, L, phase)
            seg_pts = [(x, y) for x in xs]
            if current and math.dist(current[-1], seg_pts[0]) > 3 * props.row_spacing + L:
                sections.append(current)
                current = []
            current += seg_pts
        direction *= -1
    if current:
        sections.append(current)

    out = []
    for sec in (sections[::-1] if reverse else sections):
        pts = np.array(sec, float)
        if reverse:
            pts = pts[::-1]
        # rotate back to design frame
        c, s = math.cos(math.radians(angle)), math.sin(math.radians(angle))
        rotm = np.array([[c, -s], [s, c]])
        out.append(pts @ rotm.T)
    return [o for o in out if len(o) >= 2]


def _stitch_positions(a: float, b: float, L: float, phase: float):
    """Needle x-positions from a to b on a global grid of pitch L shifted by
    phase — this is what makes staggers line-free."""
    lo, hi = (a, b) if a <= b else (b, a)
    start = math.floor((lo - phase) / L) * L + phase
    xs = [lo]
    x = start
    while x <= hi:
        if lo + 0.2 < x < hi - 0.2:
            xs.append(x)
        x += L
    xs.append(hi)
    return xs if a <= b else xs[::-1]


# ── contour / spiral fills (isocontour tree, Ink/Stitch model) ───────────────

def _inward_rings(polygon: Polygon, spacing: float):
    """Concentric inward offsets until the polygon is exhausted."""
    rings = []
    current = polygon
    depth = 0
    while not current.is_empty and depth < 400:
        geoms = list(current.geoms) if isinstance(current, MultiPolygon) else [current]
        for g in geoms:
            rings.append((depth, np.array(g.exterior.coords)))
            for hole in g.interiors:
                rings.append((depth, np.array(hole.coords)))
        current = current.buffer(-spacing)
        depth += 1
    return rings


def contour_stitches(polygon: Polygon, props):
    """Contour fill: concentric rings inner-to-outer, stitched with the
    tolerance walk, joined at nearest points."""
    from ..geometry import tolerance_walk
    rings = _inward_rings(polygon, props.row_spacing)
    if not rings:
        return []
    rings.sort(key=lambda t: -t[0])  # innermost first
    sections = []
    current = []
    for _, ring in rings:
        pts = tolerance_walk(ring, max_len=props.fill_stitch_length,
                             min_len=0.6, tol=0.2)
        if pts is None:
            continue
        pts = list(pts)
        if current:
            # rotate ring to start nearest to where we are
            arr = np.array(pts)
            k = int(np.argmin(np.hypot(*(arr - current[-1]).T)))
            pts = pts[k:] + pts[:k + 1]
            if math.dist(current[-1], pts[0]) > 2 * props.row_spacing + 1.0:
                sections.append(np.array(current))
                current = []
        current += pts
    if current:
        sections.append(np.array(current))
    return sections


def spiral_stitches(polygon: Polygon, props):
    """Spiral fill: consecutive inward rings blended into one continuous
    spiral (each ring interpolated toward the next as it sweeps around)."""
    from ..geometry import resample
    rings = [r for _, r in sorted(_inward_rings(polygon, props.row_spacing),
                                  key=lambda t: t[0])]
    if len(rings) < 2:
        return contour_stitches(polygon, props)
    n = 60
    ring_pts = [resample(r, max(polyline_length_ring(r) / n, 0.05))[:n] for r in rings]
    ring_pts = [r for r in ring_pts if len(r) == n]
    if len(ring_pts) < 2:
        return contour_stitches(polygon, props)
    out = []
    for i in range(len(ring_pts) - 1):
        a, b = ring_pts[i], ring_pts[i + 1]
        for j in range(n):
            t = j / n
            out.append(a[j] * (1 - t) + b[j] * t)
    out += list(ring_pts[-1][:1])
    from ..geometry import tolerance_walk
    pts = tolerance_walk(np.array(out), max_len=props.fill_stitch_length,
                         min_len=0.6, tol=0.25)
    return [np.array(pts)] if pts is not None else []


def polyline_length_ring(r):
    d = np.diff(np.asarray(r, float), axis=0)
    return float(np.hypot(d[:, 0], d[:, 1]).sum())


def motif_fill_stitches(polygon: Polygon, props, motif, motif_length):
    """Motif fill: stamp a motif along tatami rows (rows spaced wider)."""
    from .runs import motif_stitches
    row_props = props.with_(fill_stitch_length=1e9)  # rows as plain segments
    sections = tatami_stitches(polygon, row_props)
    out = []
    for sec in sections:
        pts = motif_stitches(sec, motif, motif_length)
        if pts is not None and len(pts) >= 2:
            out.append(pts)
        elif len(sec) >= 2:
            out.append(sec)
    return out
