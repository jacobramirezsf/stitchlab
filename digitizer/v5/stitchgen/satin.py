"""Satin column stitch generation from a rail pair.

Rails are matched by arc-length fraction (the implicit "rungs"); stitches
zigzag rail-to-rail advancing `density` mm per zig, measured along the
longer rail so tight inner curves don't starve. Columns wider than
`split_width` get intermediate penetrations (split satin). On tight inner
curves (inner rail advancing much slower than outer), every other inner
penetration is pulled back toward the center — the classic SHORT-STITCH
treatment that stops needle pile-up and thread damage at the pivot.
"""

import math

import numpy as np

from ..geometry import polyline_length, resample


def satin_stitches(rail_a, rail_b, props, split_width: float = 8.0):
    la, lb = polyline_length(rail_a), polyline_length(rail_b)
    if max(la, lb) < 0.5:
        return None
    n = max(2, int(math.ceil(max(la, lb) / max(props.density, 0.05))) + 1)
    a = resample(rail_a, la / (n - 1) if la > 0 else 1)
    b = resample(rail_b, lb / (n - 1) if lb > 0 else 1)
    m = min(len(a), len(b))
    a, b = a[:m], b[:m]

    # local advance per rail — the slower side is the inside of a curve
    adv_a = np.hypot(*np.diff(a, axis=0).T)
    adv_b = np.hypot(*np.diff(b, axis=0).T)

    def short_stitch_shift(i):
        """Return (shift_a, shift_b): fraction to pull each end toward the
        center on tight inner curves (every other stitch only)."""
        if i == 0 or i >= m - 1 or i % 2 == 0:
            return 0.0, 0.0
        la = adv_a[i - 1] + (adv_a[i] if i < len(adv_a) else 0)
        lb = adv_b[i - 1] + (adv_b[i] if i < len(adv_b) else 0)
        if la < 1e-9 and lb < 1e-9:
            return 0.0, 0.0
        if la < 0.45 * lb:
            return 0.35, 0.0   # a is the tight inner rail
        if lb < 0.45 * la:
            return 0.0, 0.35
        return 0.0, 0.0

    out = []
    for i in range(m):
        sa, sb = short_stitch_shift(i)
        ai = a[i] + (b[i] - a[i]) * sa
        bi = b[i] + (a[i] - b[i]) * sb
        pair = (ai, bi) if i % 2 == 0 else (bi, ai)
        width = math.dist(ai, bi)
        if width > split_width:
            # split satin: intermediate penetrations across the rung
            k = int(math.ceil(width / split_width)) + 1
            for t in np.linspace(0, 1, k + 1):
                out.append(np.asarray(pair[0]) + t * (np.asarray(pair[1]) - np.asarray(pair[0])))
        else:
            out.append(np.asarray(pair[0], float))
            out.append(np.asarray(pair[1], float))
    return np.array(out)
