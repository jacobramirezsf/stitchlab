"""Line-art frontend: V4's medial-axis / Euler-trail pipeline, emitting
StitchObjects instead of raw stitches.

Style "redwork" (default) reproduces V4's treatment tiers so the 22 TLS
designs regression-diff cleanly:
    width ≤ single_max   → RunPath, single pass
    width ≤ bean_max     → RunPath, bean ×3
    width ≤ blob cutoff  → RunPath ×3 parallel lanes (out/back/out)
    wider                → FillRegion (+ outline RunPath)
Style "satin" swaps the heavy tier for SatinColumn.from_centerline — the
patents' thin-object satin path — for when the design scale supports it.
"""

from __future__ import annotations

from collections import defaultdict

import numpy as np
from PIL import Image
from scipy import ndimage
from shapely.geometry import Polygon
from skimage.measure import find_contours, label
from skimage.morphology import medial_axis

from ..geometry import offset_polyline, polyline_length, smooth
from ..objects import FillRegion, ManualStitch, RunPath, StitchProperties

NEIGHBORS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]

# Frontend structure thresholds (mm) — mirror V4.
SPECK_AREA_MM2 = 1.5
SPUR_MM = 1.6
MIN_ELEMENT_MM = 1.2
SINGLE_MAX_W = 0.45
BEAN_MAX_W = 1.8
BLOB_W = 3.2


def load_mask(path):
    return np.array(Image.open(path).convert("L")) < 128


# ── skeleton → chains (V4 port) ──────────────────────────────────────────────

def trace_chains(skel):
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
    for p in pts:
        for q in nbrs[p]:
            if (p, q) not in visited:
                loop = walk(p, q)
                loop.append(p)
                chains.append(loop)
    return chains


def prune_spurs(chains, mm_per_px, spur_mm=SPUR_MM):
    for _ in range(2):
        degree = defaultdict(int)
        for ch in chains:
            degree[ch[0]] += 1
            degree[ch[-1]] += 1
        keep = []
        for ch in chains:
            length = polyline_length(np.asarray(ch, float)) * mm_per_px
            d0, d1 = degree[ch[0]], degree[ch[-1]]
            if not (length < spur_mm and ((d0 == 1) != (d1 == 1)) and max(d0, d1) >= 3):
                keep.append(ch)
        if len(keep) == len(chains):
            break
        chains = keep
    return chains


def cluster_nodes(chains):
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
    """Virtual-edge Eulerization + single Hierholzer circuit per component,
    cut at virtual edges (V4's proven construction)."""
    import math
    node_of = cluster_nodes(chains)
    node_px = {}
    for ch in chains:
        for p in (ch[0], ch[-1]):
            node_px.setdefault(node_of[p], p)

    n_real = len(chains)
    ends = [(node_of[ch[0]], node_of[ch[-1]]) for ch in chains]

    true_deg = defaultdict(int)
    for a, b in ends:
        true_deg[a] += 1
        true_deg[b] += 1

    node_comp, comp_nodes = {}, defaultdict(list)
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

    for cid in range(comp_id):
        odd = [v for v in comp_nodes[cid] if true_deg[v] % 2 == 1]
        while len(odd) > 1:
            v = odd.pop()
            best = min(range(len(odd)),
                       key=lambda i: math.dist(node_px[v], node_px[odd[i]]))
            w = odd.pop(best)
            ends.append((v, w))

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
        virtual_at = [i for i, (ei, _) in enumerate(route) if ei >= n_real]
        if virtual_at:
            k = virtual_at[0]
            route = route[k:] + route[:k]
        trails, current = [], []
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


# ── frontend main ────────────────────────────────────────────────────────────

def digitize_lineart(raster_path=None, mm_per_px=0.0625,
                     props: StitchProperties | None = None,
                     style: str = "redwork", params: dict | None = None,
                     mask=None):
    """Returns a list of StitchObjects for a black-on-white raster.
    `params` overrides the structural thresholds (see config.LINEART_DEFAULTS).
    Pass either a path or a boolean `mask` array directly."""
    P = {
        "single_max_w": SINGLE_MAX_W, "bean_max_w": BEAN_MAX_W, "blob_w": BLOB_W,
        "speck_area_mm2": SPECK_AREA_MM2, "spur_mm": SPUR_MM,
        "min_element_mm": MIN_ELEMENT_MM,
        "satin_min_w": None, "satin_min_len": None,   # treatment forcing
    }
    if params:
        P.update({k: v for k, v in params.items() if k in P})
        style = params.get("style", style)
    base_props = props or StitchProperties()
    if style == "master":
        # Jacob's reference style: single-pass runs, longer stitches
        base_props = base_props.with_(run_length=2.8, run_tolerance=0.12,
                                      bean_repeats=1)
    if mask is None:
        mask = load_mask(raster_path)
    else:
        mask = mask.copy()   # the pipeline mutates it
    if not mask.any():
        return []

    objects = []
    px_area = mm_per_px * mm_per_px

    # specks → cross stitches
    labeled = label(mask, connectivity=2)
    for rid in range(1, labeled.max() + 1):
        region = labeled == rid
        if region.sum() * px_area < P["speck_area_mm2"]:
            rs, cs = np.nonzero(region)
            c = np.array([cs.mean(), rs.mean()]) * mm_per_px
            d = 0.4
            objects.append(ManualStitch(
                [c + [-d, -d], c + [d, d], c + [-d, d], c + [d, -d], c],
                props=base_props, name="speck"))
            mask = mask & ~region

    # blobs → fill regions (nearest-ridge classification, V4)
    skel, dist = medial_axis(mask, return_distance=True, rng=0)
    width_mm = 2 * dist * mm_per_px
    blob_seed = skel & (width_mm > P["blob_w"])
    if blob_seed.any():
        _, (ir, ic) = ndimage.distance_transform_edt(~skel, return_indices=True)
        blob_mask = mask & (width_mm[ir, ic] > P["blob_w"])
        blob_labeled = label(blob_mask, connectivity=2)
        for rid in range(1, blob_labeled.max() + 1):
            region = blob_labeled == rid
            if region.sum() * px_area < 2.0:
                blob_mask &= ~region
                continue
            contours = find_contours(region.astype(float), 0.5)
            if not contours:
                continue
            rings = [np.column_stack([c[:, 1], c[:, 0]]) * mm_per_px for c in contours]
            rings.sort(key=lambda r: -Polygon(r).area if len(r) >= 4 else 0)
            exterior = rings[0]
            holes = [r for r in rings[1:] if len(r) >= 4 and Polygon(r).area > 1.0]
            poly = Polygon(exterior, holes)
            if not poly.is_valid:
                poly = poly.buffer(0)
            if poly.is_empty:
                continue
            bar = _satin_bar(poly, base_props) if style == "master" else None
            if bar is not None:
                objects.append(bar)
                continue
            fill_props = base_props.with_(row_spacing=0.42, fill_stitch_length=3.0)
            objects.append(FillRegion(poly, props=fill_props, name="blob-fill"))
            if style != "master":
                for ring in [exterior] + holes:
                    if polyline_length(ring) >= 3.0:
                        objects.append(RunPath(smooth(ring), props=base_props.with_(bean_repeats=1),
                                               name="fill-outline"))
        mask = mask & ~blob_mask
        if mask.any():
            skel, dist = medial_axis(mask, return_distance=True, rng=0)
            width_mm = 2 * dist * mm_per_px
        else:
            skel = np.zeros_like(mask)

    # centerline network → Euler trails → RunPath / SatinColumn objects
    if skel.any():
        chains_px = prune_spurs(trace_chains(skel), mm_per_px, P["spur_mm"])
        degree = defaultdict(int)
        for ch in chains_px:
            degree[ch[0]] += 1
            degree[ch[-1]] += 1
        chains_px = [ch for ch in chains_px
                     if not (degree[ch[0]] == 1 and degree[ch[-1]] == 1
                             and polyline_length(np.asarray(ch, float)) * mm_per_px < P["min_element_mm"])]
        if chains_px:
            chain_mm = [smooth(np.array([(c, r) for r, c in ch], float)) * mm_per_px
                        for ch in chains_px]
            # master classifies by the wide part of the mark (tips taper to 0
            # and drag the mean down); other styles keep V4's mean
            q = 75 if style == "master" else 50
            chain_w = [float(np.mean([width_mm[r, c] for r, c in ch]))
                       if style != "master" else
                       float(np.percentile([width_mm[r, c] for r, c in ch], q))
                       for ch in chains_px]

            group_counter = 0
            for comp_trails in euler_trails(chains_px):
                for trail in comp_trails:
                    group_counter += 1
                    objects.extend(_trail_to_objects(
                        trail, chain_mm, chain_w, base_props, style,
                        group=group_counter, P=P))
    return objects


def _satin_bar(poly, base_props, max_width=4.0, max_length=14.0):
    """Compact solid mark → satin bar along its long axis (the master-style
    confetti treatment). Returns None if the shape is too big or too hollow
    for a bar — caller falls back to a fill."""
    from ..objects import SatinColumn
    if not poly.is_valid or poly.area <= 0 or list(getattr(poly, "interiors", [])):
        return None
    with np.errstate(invalid="ignore"):
        rect = poly.minimum_rotated_rectangle
    if rect.geom_type != "Polygon" or rect.area <= 0:
        return None
    if poly.area / rect.area < 0.55:   # not compact enough for a bar
        return None
    corners = np.asarray(rect.exterior.coords)[:4]
    e1, e2 = corners[1] - corners[0], corners[2] - corners[1]
    l1, l2 = np.linalg.norm(e1), np.linalg.norm(e2)
    long_v, short_v = (e1, e2) if l1 >= l2 else (e2, e1)
    length, width = max(l1, l2), min(l1, l2)
    if width > max_width or length > max_length or width < 0.5:
        return None
    mid0 = corners[0] + (corners[2] - corners[0]) / 2 - long_v / 2
    a = mid0 + long_v * (width * 0.25 / length)      # pull ends in slightly
    b = mid0 + long_v * (1 - width * 0.25 / length)
    center = np.linspace(a, b, max(2, int(length / 1.5)))
    return SatinColumn.from_centerline(
        center, np.full(len(center), width), props=base_props, name="satin-bar")


def _trail_to_objects(trail, chain_mm, chain_w, base_props, style, group=None, P=None):
    """One continuous trail → per-chain objects with exact V4 treatments,
    bound into a sequence group so the compiler keeps them contiguous
    (adjacent endpoints → tier-1 transits: no ties, no trims)."""
    from ..objects import SatinColumn

    if P is None:
        P = {"single_max_w": SINGLE_MAX_W, "bean_max_w": BEAN_MAX_W, "blob_w": BLOB_W}
    objects = []
    pending: list[np.ndarray] = []
    pending_repeats = None

    def flush():
        nonlocal pending, pending_repeats
        if pending:
            path = np.concatenate(pending)
            objects.append(RunPath(path, props=base_props.with_(bean_repeats=pending_repeats),
                                   name="line", group=group))
            pending, pending_repeats = [], None

    # master style satinizes anything visibly wider than a pen line;
    # default styles only satinize genuinely heavy strokes. Treatments
    # force the threshold outright (999 = never satin, 0 = always).
    satin_w = P.get("satin_min_w")
    if satin_w is None:
        satin_w = 0.9 if style == "master" else P["bean_max_w"]
    satin_len = P.get("satin_min_len")
    if satin_len is None:
        satin_len = 1.5 if style == "master" else 2.5

    for ei, fwd in trail:
        coords = chain_mm[ei] if fwd else chain_mm[ei][::-1]
        w = chain_w[ei]
        if w > satin_w and polyline_length(coords) >= satin_len:
            flush()
            if style in ("satin", "master"):
                objects.append(SatinColumn.from_centerline(
                    coords, np.full(len(coords), w), props=base_props,
                    name="heavy-line", group=group))
            else:
                lane = max(0.3, (min(w, P["blob_w"]) / 2) - 0.35)
                path = np.concatenate([
                    offset_polyline(coords, +lane),
                    np.asarray(coords, float)[::-1],
                    offset_polyline(coords, -lane),
                ])
                objects.append(RunPath(path, props=base_props.with_(bean_repeats=1),
                                       name="heavy-line-lanes", group=group))
            continue
        repeats = 1 if (style == "master" or w <= P["single_max_w"]) else 3
        if pending and repeats != pending_repeats:
            flush()
        pending.append(coords)
        pending_repeats = repeats
    flush()
    return objects
