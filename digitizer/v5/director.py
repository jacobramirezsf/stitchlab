"""AI director: Claude vision proposes the judgment layer.

Given the artwork and its segmented elements, ask Claude to do what a human
digitizer does — assign each element a treatment, pick a small thread
palette, decide emphasis. The proposal comes back as a plan the UI lets the
human review and override before stitching. Requires ANTHROPIC_API_KEY.
"""

from __future__ import annotations

import base64
import io
import json
import os
import urllib.request

MODEL = "claude-sonnet-5"

STYLE_BRIEF = """You are directing machine embroidery digitizing in the studio
style of Bayside (Jacob Ramirez, SF). The engine handles stitch mechanics;
you make the creative calls a human digitizer makes. House style, distilled
from Jacob's own reference files:

- Default to light single-pass running stitch for outlines and linework.
- Solid or visibly wide marks become satin — they should read as thread, not
  as traced outlines.
- One focal element may be emphasized with 'fill' (dense tatami) if it is a
  solid shape big enough to carry it (roughly > 40mm² and chunky).
- Small scattered accent marks (confetti, sparkles, dots) look best satinized
  and colored playfully.
- Text reads best as plain runs in a single color.
- Use 1-4 thread colors total. Pick hex colors that suit the artwork's mood;
  the first palette color is the base/outline thread. Dark bases read well
  on garments.
- Skip elements that are scanning noise or too small to stitch (< ~1mm²).

Treatments: auto (engine decides), run (force running stitch), satin
(satinize everything), fill (solid tatami region), skip (omit)."""


def propose_plan(artwork_png: bytes, overlay_png: bytes, elements: list,
                 size_mm: float, api_key: str | None = None) -> dict:
    """Returns {"palette": [...], "elements": {id: {treatment, color, why}},
    "notes": str}. Raises RuntimeError without an API key."""
    api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError(
            "no ANTHROPIC_API_KEY configured — add it to the environment "
            "(Vercel: project settings → environment variables)")

    table = "\n".join(
        f"  element {e['id']}: bbox {e['bbox_mm']}mm, area {e['area_mm2']}mm²"
        for e in elements)
    prompt = f"""{STYLE_BRIEF}

The design stitches at {size_mm:.0f}mm on its long side. The first image is
the artwork; the second is the same artwork with numbered element tags.
Elements:
{table}

Assign every element a treatment and a palette color index. Respond with
ONLY a JSON object, no prose:
{{"palette": ["#rrggbb", ...], "elements": {{"1": {{"treatment": "satin",
"color": 1, "why": "short reason"}}, ...}}, "notes": "one-line summary of
your read of the design"}}"""

    def img_block(png_bytes):
        return {"type": "image", "source": {
            "type": "base64", "media_type": "image/png",
            "data": base64.b64encode(png_bytes).decode()}}

    body = json.dumps({
        "model": MODEL,
        "max_tokens": 3000,
        "messages": [{"role": "user", "content": [
            img_block(artwork_png), img_block(overlay_png),
            {"type": "text", "text": prompt}]}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages", data=body,
        headers={"Content-Type": "application/json",
                 "x-api-key": api_key,
                 "anthropic-version": "2023-06-01"})
    with urllib.request.urlopen(req, timeout=90) as resp:
        reply = json.loads(resp.read())
    text = "".join(b.get("text", "") for b in reply.get("content", []))
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < 0:
        raise RuntimeError(f"director returned no JSON: {text[:200]}")
    plan = json.loads(text[start:end + 1])
    plan.setdefault("palette", [])
    plan.setdefault("elements", {})
    return plan


def direct(data: bytes, size_mm: float = 50.8) -> dict:
    """Segment + overlay + propose, from raw PNG bytes. Used by the API."""
    import numpy as np
    from PIL import Image

    from v5.elements import numbered_overlay, segment_elements
    from v5.frontends.lineart import load_mask
    import tempfile

    with tempfile.TemporaryDirectory(prefix="v5-dir-") as workdir:
        raster = os.path.join(workdir, "in.png")
        Image.open(io.BytesIO(data)).save(raster)
        mask = load_mask(raster)
        img = Image.open(raster)
        mm_per_px = size_mm / max(img.size)
        elements, idmap = segment_elements(mask, mm_per_px)
        if not elements:
            return {"error": "no elements found"}
        overlay = numbered_overlay(raster, elements, idmap, mm_per_px)
        buf = io.BytesIO()
        overlay.save(buf, "PNG")
        plan = propose_plan(data, buf.getvalue(), elements, size_mm)
        plan["element_count"] = len(elements)
        return plan
