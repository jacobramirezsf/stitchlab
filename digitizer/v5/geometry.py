"""Shared geometry: resampling, tolerance-based stitch placement, offsets.

All coordinates are (x, y) in millimeters unless stated otherwise.
The tolerance walk is the V4 algorithm (Embrilliance calls the idea "chord
gapping"): stitches extend up to max_len but shorten so the thread never
deviates more than tol from the source path.
"""

import math

import numpy as np


def polyline_length(coords) -> float:
    coords = np.asarray(coords, float)
    if len(coords) < 2:
        return 0.0
    d = np.diff(coords, axis=0)
    return float(np.hypot(d[:, 0], d[:, 1]).sum())


def resample(coords, step: float) -> np.ndarray:
    """Evenly spaced points along a polyline, keeping both endpoints."""
    coords = np.asarray(coords, float)
    if len(coords) < 2:
        return coords
    segs = np.diff(coords, axis=0)
    seglen = np.hypot(segs[:, 0], segs[:, 1])
    total = seglen.sum()
    if total < 1e-9:
        return coords[:1]
    n = max(1, round(total / step))
    targets = np.linspace(0, total, n + 1)
    cum = np.concatenate([[0], np.cumsum(seglen)])
    out = []
    for t in targets:
        i = min(np.searchsorted(cum, t, side="right") - 1, len(seglen) - 1)
        frac = (t - cum[i]) / seglen[i] if seglen[i] > 0 else 0
        out.append(coords[i] + frac * segs[i])
    return np.array(out)


def smooth(coords, window: int = 3) -> np.ndarray:
    """Moving-average smoothing that pins both endpoints."""
    coords = np.asarray(coords, float)
    if len(coords) < window:
        return coords
    kernel = np.ones(window) / window
    out = coords.copy()
    for axis in range(2):
        padded = np.pad(coords[:, axis], window // 2, mode="edge")
        out[:, axis] = np.convolve(padded, kernel, mode="valid")
    out[0], out[-1] = coords[0], coords[-1]
    return out


def point_segment_dist(pts, a, b) -> float:
    """Max distance of pts from segment a→b."""
    pts = np.asarray(pts, float)
    a = np.asarray(a, float)
    b = np.asarray(b, float)
    ab = b - a
    denom = float(ab @ ab)
    if denom < 1e-12:
        return float(np.max(np.hypot(*(pts - a).T)))
    t = np.clip(((pts - a) @ ab) / denom, 0, 1)
    proj = a + t[:, None] * ab
    return float(np.max(np.hypot(*(pts - proj).T)))


def tolerance_walk(coords, max_len=2.2, min_len=0.8, tol=0.15) -> np.ndarray | None:
    """Adaptive needle placement: longest stitches that keep the thread
    within tol of the path. Curves/corners get short stitches automatically."""
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
            if math.dist(dense[i], dense[j]) > max_len:
                break
            if point_segment_dist(dense[i:j + 1], dense[i], dense[j]) > tol:
                break
            best = j
            j += 1
        while best < len(dense) - 1 and math.dist(dense[i], dense[best]) < min_len:
            best += 1
        pts.append(dense[best])
        i = best
    return np.array(pts) if len(pts) >= 2 else None


def offset_polyline(coords, offset: float) -> np.ndarray:
    """Offset a polyline perpendicular to its local direction."""
    coords = np.asarray(coords, float)
    if len(coords) < 2:
        return coords
    tangents = np.gradient(coords, axis=0)
    norms = np.hypot(tangents[:, 0], tangents[:, 1])
    norms[norms < 1e-9] = 1
    normals = np.column_stack([-tangents[:, 1], tangents[:, 0]]) / norms[:, None]
    return smooth(coords + normals * offset)


def unit_normals(coords) -> np.ndarray:
    """Per-point unit normals of a polyline."""
    coords = np.asarray(coords, float)
    tangents = np.gradient(coords, axis=0)
    norms = np.hypot(tangents[:, 0], tangents[:, 1])
    norms[norms < 1e-9] = 1
    return np.column_stack([-tangents[:, 1], tangents[:, 0]]) / norms[:, None]
