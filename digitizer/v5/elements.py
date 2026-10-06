"""The plan layer: bridge between artwork pixels and human/AI judgment.

The engine segments artwork into ELEMENTS (connected marks). A plan assigns
each element a TREATMENT and a COLOR — the decisions a human digitizer makes
that aren't derivable from pixels. The engine then executes the mechanics.

Treatments:
    auto   — the chosen style's own judgment (master/redwork/satin)
    run    — force running stitch, never satin
    satin  — satinize everything satinizable (solid marks → bars)
    fill   — treat the whole element as a tatami fill region
    skip   — omit the element entirely
"""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw
from shapely.geometry import Polygon
from skimage.measure import find_contours, label

from .frontends.lineart import digitize_lineart, load_mask
from .objects import FillRegion, StitchProperties
from .stitchgen.underlay import auto_underlay_for_fill

TREATMENTS = ("auto", "run", "satin", "fill", "skip")

# Madeira-ish default palette (hex) — index 0 is the base thread
DEFAULT_PALETTE = ["#182754", "#a81626", "#145c37", "#dea820", "#282828",
                   "#ebe8e1"]


def segment_elements(mask, mm_per_px, min_area_mm2: float = 0.4,
                     max_elements: int = 120):
    """Connected marks in the artwork → element records. Returns
    (elements, idmap) where idmap[r, c] = element id (0 = background)."""
    labeled = label(mask, connectivity=2)
    idmap = np.zeros_like(labeled, dtype=np.uint8)
    elements = []
    order = sorted(range(1, labeled.max() + 1),
                   key=lambda rid: -(labeled == rid).sum())
    for rid in order[:max_elements]:
        region = labeled == rid
        area = float(region.sum()) * mm_per_px * mm_per_px
        if area < min_area_mm2:
            continue
        rs, cs = np.nonzero(region)
        eid = len(elements) + 1
        if eid > 255:
            break
        idmap[region] = eid
        elements.append({
            "id": eid,
            "bbox_mm": [round(float(cs.min()) * mm_per_px, 1),
                        round(float(rs.min()) * mm_per_px, 1),
                        round(float(cs.max()) * mm_per_px, 1),
                        round(float(rs.max()) * mm_per_px, 1)],
            "area_mm2": round(area, 1),
        })
    return elements, idmap


def _fill_objects(region_mask, mm_per_px, props):
    """Whole element as a tatami fill (the 'make it solid' treatment)."""
    objects = []
    for contour_set in [find_contours(region_mask.astype(float), 0.5)]:
        if not contour_set:
            return []
        rings = [np.column_stack([c[:, 1], c[:, 0]]) * mm_per_px
                 for c in contour_set]
        rings.sort(key=lambda r: -Polygon(r).area if len(r) >= 4 else 0)
        exterior = rings[0]
        if len(exterior) < 4:
            return []
        holes = [r for r in rings[1:] if len(r) >= 4 and Polygon(r).area > 1.0]
        poly = Polygon(exterior, holes)
        if not poly.is_valid:
            poly = poly.buffer(0)
        if poly.is_empty:
            return []
        fill_props = props.with_(row_spacing=0.42, fill_stitch_length=3.0,
                                 underlay=auto_underlay_for_fill())
        objects.append(FillRegion(poly, props=fill_props, name="element-fill"))
    return objects


TREATMENT_PARAMS = {
    "run": {"satin_min_w": 999.0},
    "satin": {"satin_min_w": 0.0, "satin_min_len": 0.8},
}


def digitize_with_plan(raster_path, mm_per_px, *, style="master",
                       props: StitchProperties | None = None,
                       params: dict | None = None, plan: dict | None = None):
    """Digitize with per-element treatments and colors.

    plan = {"elements": {"3": {"treatment": "satin", "color": 1}, ...}}
    Elements without an entry get treatment 'auto', color 0.
    Returns (objects, elements, idmap).
    """
    base_props = props or StitchProperties()
    mask = load_mask(raster_path)
    elements, idmap = segment_elements(mask, mm_per_px)
    choices = (plan or {}).get("elements", {})

    all_objects = []
    for el in elements:
        pick = choices.get(str(el["id"]), {})
        treatment = pick.get("treatment", "auto")
        color = int(pick.get("color", 0))
        if treatment == "skip":
            continue
        region = idmap == el["id"]
        if treatment == "fill":
            objs = _fill_objects(region, mm_per_px, base_props)
        else:
            p = dict(params or {})
            p.update(TREATMENT_PARAMS.get(treatment, {}))
            objs = digitize_lineart(mm_per_px=mm_per_px, mask=region,
                                    props=base_props, style=style, params=p)
        for o in objs:
            o.color = color
        all_objects.extend(objs)
    return all_objects, elements, idmap


def idmap_png(idmap) -> Image.Image:
    """Element ids in the red channel — the UI hit-tests clicks against it."""
    rgb = np.zeros((*idmap.shape, 3), dtype=np.uint8)
    rgb[..., 0] = idmap
    return Image.fromarray(rgb)


def numbered_overlay(raster_path, elements, idmap, mm_per_px) -> Image.Image:
    """Artwork with element ids drawn at centroids — what an AI director
    (or a human) looks at when assigning treatments."""
    img = Image.open(raster_path).convert("RGB")
    draw = ImageDraw.Draw(img)
    for el in elements:
        ys, xs = np.nonzero(idmap == el["id"])
        cx, cy = float(xs.mean()), float(ys.mean())
        tag = str(el["id"])
        draw.rectangle([cx - 9, cy - 8, cx + 9 * len(tag), cy + 8],
                       fill=(217, 164, 65))
        draw.text((cx - 5, cy - 7), tag, fill=(20, 16, 10))
    return img


def hex_palette(palette) -> list[tuple]:
    out = []
    for h in (palette or DEFAULT_PALETTE):
        h = h.lstrip("#")
        out.append(tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)))
    return out
