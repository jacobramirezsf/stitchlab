"""Stitch simulator: render a compiled plan as thread, not polylines.

Every stitch is drawn as a capsule of thread width with a cylindrical
sheen — a directional highlight whose intensity depends on the angle
between the stitch and the light. Stitches render in machine order, so
later objects cover earlier ones exactly as they would on the garment
(including buried travel runs).
"""

from __future__ import annotations

import math

import numpy as np
import pyembroidery
from PIL import Image, ImageDraw, ImageFilter

# Madeira-ish default palette, indexed by color-change count.
DEFAULT_PALETTE = [
    (24, 39, 84),     # navy
    (168, 22, 38),    # crimson
    (20, 92, 55),     # forest
    (222, 168, 32),   # gold
    (40, 40, 40),     # charcoal
    (235, 232, 225),  # ivory
]

LIGHT = np.array([-0.7071, -0.7071])  # top-left


def _shade(color, k: float):
    return tuple(int(max(0, min(255, c * k))) for c in color)


def _mix(a, b, t: float):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def render_simulation(plan, out_path: str, px_per_mm: float = 12.0,
                      thread_mm: float = 0.42, palette=None,
                      background=(244, 241, 235), margin_mm: float = 4.0,
                      supersample: int = 2):
    """Render plan.commands as threaded stitches. Returns the PIL image."""
    palette = palette or DEFAULT_PALETTE
    pts = np.array([(x, y) for c, x, y in plan.commands
                    if c in (pyembroidery.STITCH, pyembroidery.JUMP)])
    if len(pts) == 0:
        raise ValueError("plan has no stitches")
    lo = pts.min(axis=0) - margin_mm
    hi = pts.max(axis=0) + margin_mm
    ss = supersample
    scale = px_per_mm * ss
    size = (int((hi[0] - lo[0]) * scale) + 1, int((hi[1] - lo[1]) * scale) + 1)

    img = Image.new("RGB", size, background)
    # fabric: faint noise + a whisper of a weave grid
    noise = (np.random.default_rng(7).standard_normal(size[::-1]) * 3.0)
    base = np.array(img, float)
    base += noise[..., None]
    yy, xx = np.mgrid[0:size[1], 0:size[0]]
    weave = ((xx // int(max(2, 0.55 * scale))) + (yy // int(max(2, 0.55 * scale)))) % 2
    base -= weave[..., None] * 2.0
    img = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))
    draw = ImageDraw.Draw(img)

    def to_px(p):
        return ((p[0] - lo[0]) * scale, (p[1] - lo[1]) * scale)

    w = thread_mm * scale
    color_idx = 0
    color = palette[0]
    pos = None
    for c, x, y in plan.commands:
        if c == pyembroidery.COLOR_CHANGE:
            color_idx += 1
            color = palette[color_idx % len(palette)]
            continue
        if c in (pyembroidery.JUMP, pyembroidery.TRIM, pyembroidery.STOP):
            if c == pyembroidery.JUMP:
                pos = (x, y)   # move without laying thread
            continue
        if c != pyembroidery.STITCH:
            continue
        if pos is None:
            pos = (x, y)
            continue
        a, b = to_px(pos), to_px((x, y))
        pos = (x, y)
        seg = np.array([b[0] - a[0], b[1] - a[1]])
        n = math.hypot(*seg)
        if n < 1e-6:
            draw.ellipse([b[0] - w / 2, b[1] - w / 2, b[0] + w / 2, b[1] + w / 2],
                         fill=_shade(color, 0.9))
            continue
        u = seg / n
        # cylinder sheen: strongest when the thread runs across the light
        gleam = abs(u[0] * LIGHT[1] - u[1] * LIGHT[0])
        perp = np.array([-u[1], u[0]])
        off = perp * (w * 0.18) * np.sign(perp @ LIGHT + 1e-9) * -1

        def cap_line(p, q, width, fill):
            draw.line([tuple(p), tuple(q)], fill=fill, width=max(1, int(width)))
            r = width / 2
            for e in (p, q):
                draw.ellipse([e[0] - r, e[1] - r, e[0] + r, e[1] + r], fill=fill)

        cap_line(np.array(a), np.array(b), w, _shade(color, 0.62))          # under-shadow
        cap_line(np.array(a) + off * 0.4, np.array(b) + off * 0.4, w * 0.78,
                 color)                                                      # body
        hi_c = _mix(color, (255, 255, 255), 0.18 + 0.38 * gleam)
        cap_line(np.array(a) + off, np.array(b) + off, w * 0.34, hi_c)       # sheen

    img = img.filter(ImageFilter.GaussianBlur(radius=ss * 0.45))
    img = img.resize((size[0] // ss, size[1] // ss), Image.LANCZOS)
    img.save(out_path)
    return img
