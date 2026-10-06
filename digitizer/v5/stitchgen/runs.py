"""Run-family stitch generation: single, bean×n, motif runs."""

import numpy as np

from ..geometry import resample, tolerance_walk, polyline_length, unit_normals


def run_stitches(path, props):
    """Tolerance-placed run; bean_repeats folds each segment n times
    (1 = single, 3 = bean, ... odd numbers keep direction)."""
    pts = tolerance_walk(path, max_len=props.run_length,
                         min_len=props.run_min_length, tol=props.run_tolerance)
    if pts is None:
        return None
    r = max(1, int(props.bean_repeats))
    if r == 1:
        return pts
    out = [pts[0]]
    for i in range(1, len(pts)):
        # r passes over the segment: fwd, back, fwd, ... (odd r ends forward)
        for k in range(r):
            out.append(pts[i] if k % 2 == 0 else pts[i - 1])
    return np.array(out)


def motif_stitches(path, motif, motif_length):
    """Stamp a motif repeatedly along a path (motif in local x-along/y-across
    mm coordinates)."""
    path = np.asarray(path, float)
    total = polyline_length(path)
    if total < motif_length or len(motif) < 2:
        return None
    reps = int(total // motif_length)
    spine = resample(path, total / (reps * 8))  # dense spine for mapping
    spine_len = np.concatenate([[0], np.cumsum(
        np.hypot(*np.diff(spine, axis=0).T))])
    normals = unit_normals(spine)

    def at(dist):
        i = int(np.clip(np.searchsorted(spine_len, dist) - 1, 0, len(spine) - 2))
        seg = spine_len[i + 1] - spine_len[i]
        frac = (dist - spine_len[i]) / seg if seg > 0 else 0
        p = spine[i] + frac * (spine[i + 1] - spine[i])
        n = normals[i]
        return p, n

    out = []
    x0 = float(motif[:, 0].min())
    for rep in range(reps):
        base = rep * motif_length
        for mx, my in motif:
            p, n = at(base + (mx - x0))
            out.append(p + n * my)
    return np.array(out)
