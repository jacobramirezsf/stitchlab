"""Underlay generation + automatic selection rules.

Types (RESEARCH.md §4): center run, edge run (inset 0.8mm ≈ needle width),
zigzag, double zigzag (crosshatch), tatami underlay at a counter angle.
Selection by column width / object kind follows the published practice:
    satin < 3mm        → center run
    satin 3–7mm        → edge run + zigzag
    satin ≥ 7mm        → edge run + double zigzag
    fill               → edge run + light tatami at counter angle
"""

from __future__ import annotations

import numpy as np
from shapely.geometry import MultiPolygon, Polygon

from ..geometry import polyline_length, resample, tolerance_walk
from ..objects import StitchBlock, UnderlaySpec


def auto_underlay_for_satin(width_mm: float) -> UnderlaySpec:
    if width_mm < 3.0:
        return UnderlaySpec(kinds=("center_run",))
    if width_mm < 7.0:
        return UnderlaySpec(kinds=("edge_run", "zigzag"))
    return UnderlaySpec(kinds=("edge_run", "double_zigzag"))


def auto_underlay_for_fill() -> UnderlaySpec:
    return UnderlaySpec(kinds=("edge_run", "tatami"), spacing=2.5)


# ── satin column underlays (rails given) ────────────────────────────────────

def _rail_pair(rail_a, rail_b, n):
    a = resample(rail_a, max(polyline_length(rail_a) / n, 0.1))
    b = resample(rail_b, max(polyline_length(rail_b) / n, 0.1))
    m = min(len(a), len(b))
    return a[:m], b[:m]


def satin_underlay(rail_a, rail_b, spec: UnderlaySpec, color=0):
    blocks = []
    for kind in spec.kinds:
        if kind == "center_run":
            a, b = _rail_pair(rail_a, rail_b, 60)
            center = (a + b) / 2
            pts = tolerance_walk(center, max_len=spec.stitch_length, min_len=0.6, tol=0.2)
            if pts is not None:
                blocks.append(StitchBlock(np.array(pts), kind="underlay", color=color))
        elif kind == "edge_run":
            a, b = _rail_pair(rail_a, rail_b, 60)
            width = np.hypot(*(a - b).T)
            inset = np.minimum(spec.inset, width * 0.3)[:, None]
            direction = (b - a) / np.maximum(np.hypot(*(b - a).T), 1e-9)[:, None]
            ia = a + direction * inset
            ib = b - direction * inset
            # up one inset edge, back down the other — continuous
            path = np.concatenate([ia, ib[::-1]])
            pts = tolerance_walk(path, max_len=spec.stitch_length, min_len=0.6, tol=0.2)
            if pts is not None:
                blocks.append(StitchBlock(np.array(pts), kind="underlay", color=color))
        elif kind in ("zigzag", "double_zigzag"):
            a, b = _rail_pair(rail_a, rail_b, 60)
            width = np.hypot(*(a - b).T)
            inset = np.minimum(spec.inset * 0.6, width * 0.25)[:, None]
            direction = (b - a) / np.maximum(np.hypot(*(b - a).T), 1e-9)[:, None]
            ia = a + direction * inset
            ib = b - direction * inset
            length = max(polyline_length((ia + ib) / 2), 0.1)
            n = max(2, int(length / spec.spacing))
            idx = np.linspace(0, len(ia) - 1, n + 1).astype(int)
            zig = [ia[j] if k % 2 == 0 else ib[j] for k, j in enumerate(idx)]
            if kind == "double_zigzag":
                zig += [ib[j] if k % 2 == 0 else ia[j]
                        for k, j in enumerate(idx[::-1])]
            blocks.append(StitchBlock(np.array(zig), kind="underlay", color=color))
    return blocks


# ── fill underlays (polygon given) ──────────────────────────────────────────

def fill_underlay(polygon: Polygon, spec: UnderlaySpec, cover_angle: float,
                  color=0, props=None):
    from .fill import tatami_stitches
    blocks = []
    for kind in spec.kinds:
        if kind == "edge_run":
            shrunk = polygon.buffer(-spec.inset)
            geoms = list(shrunk.geoms) if isinstance(shrunk, MultiPolygon) else (
                [] if shrunk.is_empty else [shrunk])
            for g in geoms:
                for ring in [g.exterior] + list(g.interiors):
                    coords = np.array(ring.coords)
                    if polyline_length(coords) < 2.0:
                        continue
                    pts = tolerance_walk(coords, max_len=spec.stitch_length,
                                         min_len=0.6, tol=0.2)
                    if pts is not None:
                        blocks.append(StitchBlock(np.array(pts), kind="underlay", color=color))
        elif kind == "tatami":
            shrunk = polygon.buffer(-spec.inset)
            if shrunk.is_empty:
                continue
            geoms = list(shrunk.geoms) if isinstance(shrunk, MultiPolygon) else [shrunk]
            from ..objects import StitchProperties
            uprops = (props or StitchProperties()).with_(
                angle=cover_angle + 90, row_spacing=spec.spacing,
                fill_stitch_length=spec.stitch_length * 1.8, staggers=2)
            for g in geoms:
                for sec in tatami_stitches(g, uprops):
                    blocks.append(StitchBlock(sec, kind="underlay", color=color))
    return blocks
