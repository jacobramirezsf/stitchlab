"""Stateless digitizing service: one PNG in, stats + previews + files out.

Shared by the local web UI (v5/webui.py) and the Vercel function
(api/digitize.py). SVG rasterization happens client-side in the browser,
so this only ever sees raster images.
"""

from __future__ import annotations

import base64
import io
import os
import tempfile

from PIL import Image

from v5.compile import compile_objects, render_preview, write_outputs
from v5.config import ResolvedConfig
from v5.elements import (DEFAULT_PALETTE, digitize_with_plan, hex_palette,
                         idmap_png, numbered_overlay)
from v5.frontends.raster import digitize_raster
from v5.simulate import render_simulation
from v5.validate import density_warnings, ties_at_trims, validate_file

FORMATS = ("dst", "pes", "exp", "jef")


def is_lineartish(img: Image.Image) -> bool:
    import numpy as np
    arr = np.array(img.convert("RGB").resize((64, 64)), float)
    return (arr.max(axis=2) - arr.min(axis=2)).mean() < 12


def run_job(filename: str, data: bytes, *, size_mm: float = 50.8,
            fabric: str | None = None, style: str = "redwork",
            frontend: str = "auto", colors: int = 6,
            plan: dict | None = None) -> dict:
    """Digitize one raster image; returns a JSON-safe dict with base64
    previews and output files. No state survives the call.

    `plan` carries the human/AI judgment layer: per-element treatments and
    colors plus a thread palette — see v5/elements.py."""
    name = os.path.splitext(os.path.basename(filename))[0] or "design"
    img = Image.open(io.BytesIO(data))
    mm_per_px = size_mm / max(img.size)

    if frontend == "auto":
        frontend = "lineart" if is_lineartish(img) else "raster"

    cfg = ResolvedConfig(fabric=fabric or None)
    props = cfg.properties()
    palette_hex = (plan or {}).get("palette") or DEFAULT_PALETTE
    with tempfile.TemporaryDirectory(prefix="v5-svc-") as workdir:
        raster = os.path.join(workdir, "in.png")
        img.save(raster)
        elements, idmap = [], None
        if frontend == "raster":
            objects, _ = digitize_raster(raster, mm_per_px, n_colors=colors,
                                         props=props)
        else:
            la = cfg.lineart()
            la["style"] = style
            objects, elements, idmap = digitize_with_plan(
                raster, mm_per_px, style=style, props=props, params=la,
                plan=plan)
        if not objects:
            return {"error": "no stitchable objects found in the image"}

        used = sorted({o.color for o in objects})
        rgb = hex_palette(palette_hex)
        sim_palette = [rgb[c % len(rgb)] for c in used]
        compiled = compile_objects(objects, transit=cfg.transit(),
                                   color_order=used)
        out_base = os.path.join(workdir, name)
        files = write_outputs(compiled, out_base, formats=FORMATS)
        render_preview(compiled, out_base + "-preview.png",
                       background=img, mm_per_px=mm_per_px)
        render_simulation(compiled, out_base + "-sim.png",
                          palette=sim_palette)

        stats = validate_file(files[0])
        stats["warnings"] += density_warnings(compiled)
        stats["warnings"] += ties_at_trims(compiled)

        def b64(path):
            with open(path, "rb") as f:
                return base64.b64encode(f.read()).decode()

        def b64img(pil):
            buf = io.BytesIO()
            pil.save(buf, "PNG")
            return base64.b64encode(buf.getvalue()).decode()

        return {
            "name": name,
            "frontend": frontend,
            "style": style,
            "fabric": fabric or "",
            "stats": stats,
            "elements": elements,
            "idmap": b64img(idmap_png(idmap)) if idmap is not None else None,
            "palette": palette_hex,
            "sim": b64(out_base + "-sim.png"),
            "preview": b64(out_base + "-preview.png"),
            "files": {ext: b64(f"{out_base}.{ext}") for ext in FORMATS},
        }
