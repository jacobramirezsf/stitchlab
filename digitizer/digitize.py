#!/usr/bin/env python3
"""
Auto-digitizer for hand-drawn line-art SVGs → Tajima DST.

Tuned for the Bayside/d.school jacket designs: sketch-style artwork stitched
small (~2"). Pipeline:

  raster (via rasterize.mjs)          black-on-white PNG at px-per-mm scale
    → binary mask
    → specks → cross stitches         confetti dots etc.
    → blob detection                  regions too wide for satin → tatami fill
    → medial axis                     centerlines + local stroke width
    → chain graph + spur pruning      skeleton as junction-to-junction chains
    → EULER TRAIL ROUTING             continuous paths through junctions
                                      (retraced lines are invisible on bean),
                                      so the machine flows instead of trimming
    → stitch planning                 bean stitch (thin) / satin zigzag (wide)
    → 3-tier connections              sew across tiny gaps · jump short gaps ·
                                      trim only for real ones
    → out.dst + preview PNG           stitches drawn over the faded original

Usage:
  .venv/bin/python digitize.py <raster.png> <mm_per_px> <out_basename>

The output is a STARTING POINT for production: always test-stitch and review
density/pull-comp in real embroidery software before running a garment.
"""

import json
import math
import sys
from collections import defaultdict

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from skimage.measure import approximate_polygon, label
from skimage.morphology import medial_axis

import pyembroidery

# ── Stitch parameters (mm) ──────────────────────────────────────────────────
# V4: redwork-style clean line art. Run-family stitches only (single/bean/
# multi-lane runs) + tatami fill for solids. Tolerance-based stitch placement
# keeps thread within RUN_TOL of the drawn path, which makes curves round and
# corners sharp without wasting stitches on straights.
RUN_MAX = 2.2             # longest stitch on straight sections
RUN_MIN = 0.8             # shortest stitch in tight curves/corners
RUN_TOL = 0.15            # max thread deviation from the drawn path
SINGLE_MAX_W = 0.45       # only true hairlines get a single pass
BEAN_MAX_W = 1.8          # up to this: bean ×3 (classic redwork line)
SATIN_MAX_W = 3.2         # up to this: 3 parallel run lanes; beyond: fill
RUN_STITCH = 1.8          # connector/outline run length
FILL_ROW_SPACING = 0.42   # tatami row pitch
FILL_MAX_STITCH = 3.0     # split fill rows into stitches this long
MIN_ELEMENT_MM = 1.2      # drop isolated fragments shorter than this
SPUR_MM = 1.6             # prune junction spurs shorter than this
TIE_MM = 0.5              # tie micro stitches (ties show on runs — keep tiny)
CONNECT_MM = 1.2          # sew across gaps this small instead of jumping
TRIM_JUMP_MM = 5.0        # jumps longer than this get a trim first
MAX_MOVE_MM = 10.0        # split any movement beyond this (DST delta limit)
SPECK_AREA_MM2 = 1.5      # components smaller than this become a cross stitch


def load_mask(path):
    img = Image.open(path).convert("L")
    return np.array(img) < 128  # dark artwork on white


# ── Skeleton → junction-to-junction chains ──────────────────────────────────

NEIGHBORS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def trace_chains(skel):
    """Chains between endpoints/junctions, as pixel-coordinate lists."""
    pts = {(int(r), int(c)) for r, c in zip(*np.nonzero(skel))}
    nbrs = {}
    for p in pts:
        r, c = p
        nbrs[p] = [q for dr, dc in NEIGHBORS if (q := (r + dr, c + dc)) in pts]
    degree = {p: len(n) for p, n in nbrs.items()}
    visited = set()
    chains = []

    def walk(start, first):
        line = [start, first]
        visited.add((start, first))
        visited.add((first, start))
        prev, cur = start, first
        while degree[cur] == 2:
            nxt = next((q for q in nbrs[cur] if q != prev), None)
            if nxt is None or (cur, nxt) in visited:
                break
            visited.add((cur, nxt))
            visited.add((nxt, cur))
            line.append(nxt)
            prev, cur = cur, nxt
        return line

    for p in pts:
        if degree[p] == 2:
            continue
        for q in nbrs[p]:
            if (p, q) not in visited:
                chains.append(walk(p, q))
    for p in pts:  # pure loops
        for q in nbrs[p]:
            if (p, q) not in visited:
                loop = walk(p, q)
                loop.append(p)
                chains.append(loop)
    return chains


def polyline_length(line):
    return sum(math.dist(line[i], line[i + 1]) for i in range(len(line) - 1))


def prune_spurs(chains, mm_per_px):
    """Remove short dead-end whiskers hanging off junctions (2 passes)."""
    for _ in range(2):
        degree = defaultdict(int)
        for ch in chains:
            degree[ch[0]] += 1
            degree[ch[-1]] += 1
        keep = []
        for ch in chains:
            length = polyline_length(ch) * mm_per_px
            d0, d1 = degree[ch[0]], degree[ch[-1]]
            is_spur = length < SPUR_MM and ((d0 == 1) != (d1 == 1)) and max(d0, d1) >= 3
            if not is_spur:
                keep.append(ch)
        if len(keep) == len(chains):
            break
        chains = keep
    return chains


# ── Euler trail routing: continuous paths through junctions ─────────────────

def cluster_nodes(chains):
    """Skeleton junctions often span 2-3 adjacent pixels that are really ONE
    junction. Union endpoints that touch (8-connectivity) into shared nodes so
    the graph connects properly."""
    endpoints = {ch[0] for ch in chains} | {ch[-1] for ch in chains}
    parent = {p: p for p in endpoints}

    def find(p):
        while parent[p] != p:
            parent[p] = parent[parent[p]]
            p = parent[p]
        return p

    for p in endpoints:
        r, c = p
        for dr, dc in NEIGHBORS:
            q = (r + dr, c + dc)
            if q in parent:
                ra, rb = find(p), find(q)
                if ra != rb:
                    parent[ra] = rb
    return {p: find(p) for p in endpoints}


def euler_trails(chains):
    """Partition the chain graph into few continuous trails per component.

    Odd-degree junctions get paired with VIRTUAL edges (nearest together) so
    each component becomes Eulerian; one Hierholzer circuit is then cut at
    the virtual edges into real trails — a component with 2k odd junctions
    yields exactly max(1, k) continuous trails, and each cut lands where two
    odd junctions sit close together, keeping the machine's hops short.
    """
    node_of = cluster_nodes(chains)
    node_px = {}  # representative pixel per cluster, for distance pairing
    for ch in chains:
        for p in (ch[0], ch[-1]):
            node_px.setdefault(node_of[p], p)

    n_real = len(chains)
    ends = [(node_of[ch[0]], node_of[ch[-1]]) for ch in chains]

    # True degree counts loops twice.
    true_deg = defaultdict(int)
    for a, b in ends:
        true_deg[a] += 1
        true_deg[b] += 1

    # Connected components over nodes.
    node_comp = {}
    comp_nodes = defaultdict(list)
    comp_id = 0
    adj0 = defaultdict(list)
    for i, (a, b) in enumerate(ends):
        adj0[a].append(i)
        if b != a:
            adj0[b].append(i)
    for start in list(adj0.keys()):
        if start in node_comp:
            continue
        stack = [start]
        node_comp[start] = comp_id
        comp_nodes[comp_id].append(start)
        while stack:
            v = stack.pop()
            for ei in adj0[v]:
                for w in ends[ei]:
                    if w not in node_comp:
                        node_comp[w] = comp_id
                        comp_nodes[comp_id].append(w)
                        stack.append(w)
        comp_id += 1

    # Pair odd nodes within each component with virtual edges (greedy nearest).
    for cid in range(comp_id):
        odd = [v for v in comp_nodes[cid] if true_deg[v] % 2 == 1]
        while len(odd) > 1:
            v = odd.pop()
            best = min(range(len(odd)), key=lambda i: math.dist(node_px[v], node_px[odd[i]]))
            w = odd.pop(best)
            ends.append((v, w))  # virtual edge id >= n_real

    adj = defaultdict(list)
    by_pair = defaultdict(list)
    for i, (a, b) in enumerate(ends):
        adj[a].append(i)
        if b != a:
            adj[b].append(i)
        by_pair[frozenset((a, b)) if a != b else frozenset((a,))].append(i)

    used = [False] * len(ends)

    def next_unused(v):
        for ei in adj[v]:
            if not used[ei]:
                return ei
        return None

    def circuit_from(start):
        """All-even graph: the vertex splice algorithm gives a valid circuit."""
        stack = [start]
        node_route = []
        while stack:
            v = stack[-1]
            ei = next_unused(v)
            if ei is not None:
                used[ei] = True
                a, b = ends[ei]
                stack.append(b if a == v else a)
            else:
                node_route.append(stack.pop())
        node_route.reverse()
        route = []
        for a, b in zip(node_route, node_route[1:]):
            key = frozenset((a, b)) if a != b else frozenset((a,))
            ei = by_pair[key].pop()
            route.append((ei, ends[ei][0] == a))
        return route

    trails_by_comp = []
    for cid in range(comp_id):
        start = comp_nodes[cid][0]
        if next_unused(start) is None:
            continue
        route = circuit_from(start)
        # Rotate so a virtual edge (if any) sits at the boundary, then split
        # the circuit at every virtual edge.
        virtual_at = [i for i, (ei, _) in enumerate(route) if ei >= n_real]
        if virtual_at:
            k = virtual_at[0]
            route = route[k:] + route[:k]
        trails = []
        current = []
        for ei, fwd in route:
            if ei >= n_real:
                if current:
                    trails.append(current)
                current = []
            else:
                current.append((ei, fwd))
        if current:
            trails.append(current)
        if trails:
            trails_by_comp.append(trails)
    return trails_by_comp


# ── Stitch generators (mm coordinates) ──────────────────────────────────────

def simplify_chain(coords_px, mm_per_px):
    # Light smoothing only — the tolerance walk in adaptive_points() decides
    # where needles land, and it needs the dense path to measure deviation.
    return smooth(coords_px) * mm_per_px


def smooth(coords, window=3):
    if len(coords) < window:
        return coords.astype(float)
    kernel = np.ones(window) / window
    out = coords.astype(float).copy()
    for axis in range(2):
        padded = np.pad(coords[:, axis].astype(float), window // 2, mode="edge")
        out[:, axis] = np.convolve(padded, kernel, mode="valid")
    out[0], out[-1] = coords[0], coords[-1]
    return out


def resample(coords, step):
    if len(coords) < 2:
        return np.array(coords, dtype=float)
    segs = np.diff(coords, axis=0)
    seglen = np.hypot(segs[:, 0], segs[:, 1])
    total = seglen.sum()
    if total < 1e-6:
        return np.array(coords[:1], dtype=float)
    n = max(1, round(total / step))
    targets = np.linspace(0, total, n + 1)
    cum = np.concatenate([[0], np.cumsum(seglen)])
    out = []
    for t in targets:
        i = min(np.searchsorted(cum, t, side="right") - 1, len(seglen) - 1)
        frac = (t - cum[i]) / seglen[i] if seglen[i] > 0 else 0
        out.append(coords[i] + frac * segs[i])
    return np.array(out)


def point_segment_dist(pts, a, b):
    """Max distance of points from segment a→b."""
    ab = b - a
    denom = float(ab @ ab)
    if denom < 1e-12:
        return float(np.max(np.hypot(*(pts - a).T)))
    t = np.clip(((pts - a) @ ab) / denom, 0, 1)
    proj = a + t[:, None] * ab
    return float(np.max(np.hypot(*(pts - proj).T)))


def adaptive_points(coords):
    """Tolerance-based stitch placement: each stitch is as long as possible
    (≤ RUN_MAX) while the thread stays within RUN_TOL of the drawn path.
    Curves and corners automatically get short stitches; straights get long
    ones — the way a careful digitizer places needle points."""
    coords = np.asarray(coords, float)
    if len(coords) < 2:
        return None
    dense = resample(coords, 0.25)
    pts = [dense[0]]
    i = 0
    while i < len(dense) - 1:
        j = i + 1
        best = j
        while j < len(dense):
            seg_len = math.dist(dense[i], dense[j])
            if seg_len > RUN_MAX:
                break
            if point_segment_dist(dense[i:j + 1], dense[i], dense[j]) > RUN_TOL:
                break
            best = j
            j += 1
        # Enforce a minimum so tight curls don't produce micro stitches.
        while best < len(dense) - 1 and math.dist(dense[i], dense[best]) < RUN_MIN:
            best += 1
        pts.append(dense[best])
        i = best
    return pts if len(pts) >= 2 else None


def bean_from(pts):
    """Triple-pass (bean) over already-placed needle points."""
    out = [pts[0]]
    for i in range(1, len(pts)):
        out += [pts[i], pts[i - 1], pts[i]]
    return out


def bean_points(coords):
    pts = adaptive_points(coords)
    return bean_from(pts) if pts else None


def single_run_points(coords):
    return adaptive_points(coords)


def offset_polyline(coords, offset):
    coords = np.asarray(coords, float)
    if len(coords) < 2:
        return coords
    tangents = np.gradient(coords, axis=0)
    norms = np.hypot(tangents[:, 0], tangents[:, 1])
    norms[norms < 1e-9] = 1
    normals = np.column_stack([-tangents[:, 1], tangents[:, 0]]) / norms[:, None]
    return smooth(coords + normals * offset)


def three_lane_points(coords, width):
    """Heavy stroke as three parallel run lanes (out on one side, back down
    the center, out on the other) — bold coverage that stays run-family and
    ends at the chain's end so Euler trails keep flowing."""
    lane = max(0.3, (min(width, SATIN_MAX_W) / 2) - 0.35)
    a = adaptive_points(offset_polyline(coords, +lane))
    b = adaptive_points(np.asarray(coords, float)[::-1])
    c = adaptive_points(offset_polyline(coords, -lane))
    parts = [p for p in (a, b, c) if p]
    if not parts:
        return None
    out = []
    for part in parts:
        out += part
    return out


def fill_elements(region_mask, mm_per_px):
    """Serpentine tatami rows across a blob region."""
    rows_px = max(1, round(FILL_ROW_SPACING / mm_per_px))
    rs, _ = np.nonzero(region_mask)
    elements, current = [], []
    direction = 1
    for r in range(rs.min(), rs.max() + 1, rows_px):
        cols = np.nonzero(region_mask[r])[0]
        if len(cols) == 0:
            if current:
                elements.append(np.array(current))
                current = []
            continue
        splits = np.split(cols, np.nonzero(np.diff(cols) > 1)[0] + 1)
        runs = sorted((run[0], run[-1]) for run in splits if run[-1] - run[0] >= 1)
        if not runs:
            continue
        for c0, c1 in (runs if direction == 1 else runs[::-1]):
            a = (c0, r) if direction == 1 else (c1, r)
            b = (c1, r) if direction == 1 else (c0, r)
            seg = [np.array(a, float) * mm_per_px, np.array(b, float) * mm_per_px]
            if current and math.dist(current[-1], seg[0]) > CONNECT_MM:
                elements.append(np.array(current))
                current = []
            current += list(resample(np.array(seg), FILL_MAX_STITCH))
        direction *= -1
    if current:
        elements.append(np.array(current))
    return [e for e in elements if len(e) >= 2]


def region_outlines(region_mask, mm_per_px):
    """Running-stitch outline around a fill region for a crisp edge."""
    from skimage.measure import find_contours
    outlines = []
    for contour in find_contours(region_mask.astype(float), 0.5):
        coords = np.column_stack([contour[:, 1], contour[:, 0]]) * mm_per_px
        if polyline_length(coords) < 3.0:
            continue
        pts = adaptive_points(smooth(contour)[:, ::-1] * mm_per_px)
        if pts and len(pts) >= 3:
            outlines.append(np.array(pts))
    return outlines


def cross_element(centroid_mm, size=0.8):
    c = np.array(centroid_mm)
    d = size / 2
    return np.array([c + [-d, -d], c + [d, d], c + [-d, d], c + [d, -d], c])


# ── Main ────────────────────────────────────────────────────────────────────

def digitize(raster_path, mm_per_px, out_base):
    mask = load_mask(raster_path)
    if not mask.any():
        raise SystemExit("empty mask — nothing to digitize")

    elements = []  # np arrays of (x, y) mm stitch positions
    px_area_mm2 = mm_per_px * mm_per_px

    # 1. Tiny specks → cross stitches.
    labeled = label(mask, connectivity=2)
    for rid in range(1, labeled.max() + 1):
        region = labeled == rid
        if region.sum() * px_area_mm2 < SPECK_AREA_MM2:
            rs, cs = np.nonzero(region)
            elements.append(cross_element((cs.mean() * mm_per_px, rs.mean() * mm_per_px)))
            mask = mask & ~region

    # 2. Blobs → tatami fill. Every mask pixel is classified by the stroke
    # width at its NEAREST skeleton ridge, so fill regions take their whole
    # stroke with them — no leftover shells whose skeletons become webs.
    skel, dist = medial_axis(mask, return_distance=True)
    width_mm = 2 * dist * mm_per_px
    blob_seed = skel & (width_mm > SATIN_MAX_W)
    if blob_seed.any():
        _, (ir, ic) = ndimage.distance_transform_edt(~skel, return_indices=True)
        nearest_ridge_width = width_mm[ir, ic]
        blob_mask = mask & (nearest_ridge_width > SATIN_MAX_W)
        blob_labeled = label(blob_mask, connectivity=2)
        for rid in range(1, blob_labeled.max() + 1):
            region = blob_labeled == rid
            if region.sum() * px_area_mm2 < 2.0:
                blob_mask &= ~region
                continue
            elements.extend(fill_elements(region, mm_per_px))
            elements.extend(region_outlines(region, mm_per_px))
        mask = mask & ~blob_mask
        if mask.any():
            skel, dist = medial_axis(mask, return_distance=True)
            width_mm = 2 * dist * mm_per_px
        else:
            skel = np.zeros_like(mask)

    # 3. Centerline chains → Euler trails → continuous stitch elements.
    if skel.any():
        chains_px = prune_spurs(trace_chains(skel), mm_per_px)
        # Drop isolated tiny fragments (not connected to anything).
        degree = defaultdict(int)
        for ch in chains_px:
            degree[ch[0]] += 1
            degree[ch[-1]] += 1
        chains_px = [
            ch for ch in chains_px
            if not (degree[ch[0]] == 1 and degree[ch[-1]] == 1
                    and polyline_length(ch) * mm_per_px < MIN_ELEMENT_MM)
        ]
        if chains_px:
            chain_mm = []
            chain_w = []
            for ch in chains_px:
                coords_px = np.array([(c, r) for r, c in ch], float)
                chain_mm.append(simplify_chain(coords_px, mm_per_px))
                chain_w.append(float(np.mean([width_mm[r, c] for r, c in ch])))

            for comp_trails in euler_trails(chains_px):
                comp_elements = []
                for trail in comp_trails:
                    pts = []
                    for ei, fwd in trail:
                        coords = chain_mm[ei] if fwd else chain_mm[ei][::-1]
                        w = chain_w[ei]
                        if w <= SINGLE_MAX_W:
                            chunk = single_run_points(coords)
                        elif w <= BEAN_MAX_W or polyline_length(coords) < 2.5:
                            chunk = bean_points(coords)
                        else:
                            chunk = three_lane_points(coords, w)
                        if chunk is None:
                            continue
                        if pts and math.dist(pts[-1], chunk[0]) < 0.05:
                            chunk = chunk[1:]
                        pts += list(chunk)
                    if len(pts) >= 2:
                        comp_elements.append(np.array(pts))
                # Within a component, chain trails together nearest-first so
                # the connector stitches stay short.
                if comp_elements:
                    ordered = [comp_elements.pop(0)]
                    while comp_elements:
                        pos = ordered[-1][-1]
                        best = min(
                            range(len(comp_elements)),
                            key=lambda i: min(
                                math.dist(pos, comp_elements[i][0]),
                                math.dist(pos, comp_elements[i][-1]),
                            ),
                        )
                        el = comp_elements.pop(best)
                        if math.dist(pos, el[-1]) < math.dist(pos, el[0]):
                            el = el[::-1]
                        ordered.append(el)
                    merged = list(ordered[0])
                    for el in ordered[1:]:
                        gap = math.dist(merged[-1], el[0])
                        if gap <= CONNECT_MM:
                            connector = resample(np.array([merged[-1], el[0]]), RUN_STITCH)
                            merged += list(connector[1:]) + list(el)
                        else:
                            elements.append(np.array(merged))
                            merged = list(el)
                    elements.append(np.array(merged))

    if not elements:
        raise SystemExit("no stitchable elements found")

    # 4. Global routing: greedy nearest neighbor, elements reversible.
    ordered = []
    remaining = list(elements)
    pos = np.array([0.0, 0.0])
    while remaining:
        best_i, best_rev, best_d = 0, False, float("inf")
        for i, el in enumerate(remaining):
            d0, d1 = math.dist(pos, el[0]), math.dist(pos, el[-1])
            if d0 < best_d:
                best_i, best_rev, best_d = i, False, d0
            if d1 < best_d:
                best_i, best_rev, best_d = i, True, d1
        el = remaining.pop(best_i)
        ordered.append(el[::-1] if best_rev else el)
        pos = ordered[-1][-1]

    # 5. Emit DST. Three connection tiers: sew / jump / trim+jump.
    pattern = pyembroidery.EmbPattern()
    trims = 0

    def emit(cmd, p):
        pattern.add_stitch_absolute(cmd, round(p[0] * 10), round(p[1] * 10))

    def tie(p, toward):
        d = np.array(toward, float)
        n = math.hypot(*d)
        d = d / n * TIE_MM if n > 1e-6 else np.array([TIE_MM, 0])
        emit(pyembroidery.STITCH, p + d)
        emit(pyembroidery.STITCH, p)

    pos = None
    stitch_count = 0
    for el in ordered:
        if pos is None:
            emit(pyembroidery.JUMP, el[0])
            tie(el[0], el[min(1, len(el) - 1)] - el[0])
        else:
            gap = math.dist(pos, el[0])
            if gap <= CONNECT_MM:
                for q in resample(np.array([pos, el[0]]), RUN_STITCH)[1:]:
                    emit(pyembroidery.STITCH, q)
                    stitch_count += 1
            else:
                tie(np.array(pos), np.array(pos) - el[0])
                if gap > TRIM_JUMP_MM:
                    pattern.add_command(pyembroidery.TRIM)
                    trims += 1
                steps = max(1, math.ceil(gap / MAX_MOVE_MM))
                for s in range(1, steps + 1):
                    q = pos + (np.array(el[0]) - pos) * (s / steps)
                    emit(pyembroidery.JUMP, q)
                tie(el[0], el[min(1, len(el) - 1)] - el[0])
        for p in el:
            emit(pyembroidery.STITCH, p)
            stitch_count += 1
        pos = el[-1]
    tie(np.array(pos), ordered[-1][-2] - pos if len(ordered[-1]) > 1 else [1, 0])
    pattern.add_command(pyembroidery.END)

    dst_path = out_base + ".dst"
    pyembroidery.write_dst(pattern, dst_path)
    render_preview(raster_path, mm_per_px, ordered, out_base + "-preview.png")

    ext = pattern.extents()
    return {
        "dst": dst_path,
        "stitches": stitch_count,
        "elements": len(ordered),
        "trims": trims,
        "size_mm": [round((ext[2] - ext[0]) / 10, 1), round((ext[3] - ext[1]) / 10, 1)],
    }


def render_preview(raster_path, mm_per_px, ordered, out_path):
    base = Image.open(raster_path).convert("RGB")
    faded = Image.blend(base, Image.new("RGB", base.size, "white"), 0.82)
    scale = 1 / mm_per_px
    canvas = faded.resize((base.width * 2, base.height * 2), Image.LANCZOS)
    draw = ImageDraw.Draw(canvas)
    for el in ordered:
        pts = [(p[0] * scale * 2, p[1] * scale * 2) for p in el]
        draw.line(pts, fill=(26, 60, 130), width=2)
        for p in pts:
            draw.ellipse([p[0] - 1.5, p[1] - 1.5, p[0] + 1.5, p[1] + 1.5], fill=(190, 60, 40))
    canvas.resize(base.size, Image.LANCZOS).save(out_path)


if __name__ == "__main__":
    raster, mmpp, out = sys.argv[1], float(sys.argv[2]), sys.argv[3]
    print(json.dumps(digitize(raster, mmpp, out)))
