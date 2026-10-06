"""Raster frontend: the "auto-digitize a JPEG" path (SoftSight patent recipe,
minimal viable Phase 1 version).

Pipeline: color quantization → per-color region segmentation → thin/thick
classification from medial-axis width statistics → objects per color block
(thin → line-art treatment via the lineart frontend machinery on that color's
mask; thick → FillRegion). The 16-angle fill search lands in Phase 2.
"""

from __future__ import annotations

import numpy as np
from PIL import Image
from shapely.geometry import Polygon
from skimage.measure import find_contours, label
from skimage.morphology import medial_axis

from ..objects import FillRegion, StitchProperties
from .lineart import digitize_lineart

MIN_REGION_MM2 = 2.0
THIN_MAX_MEAN_W = 2.5  # mean stroke width below which a color region is "thin"


def quantize(image_path, n_colors=6, min_share=0.01):
    """Adaptive-palette quantization; returns (labels array, palette rgb list).
    Background = the palette entry closest to white."""
    img = Image.open(image_path).convert("RGB")
    q = img.quantize(colors=n_colors, method=Image.MEDIANCUT)
    palette = np.array(q.getpalette()[:n_colors * 3]).reshape(-1, 3)
    labels = np.array(q)
    # drop colors with a tiny share into their nearest neighbor
    counts = np.bincount(labels.ravel(), minlength=len(palette))
    share = counts / counts.sum()
    for ci in np.nonzero(share < min_share)[0]:
        others = [i for i in range(len(palette)) if i != ci and share[i] >= min_share]
        if not others:
            continue
        nearest = min(others, key=lambda i: np.sum((palette[i] - palette[ci]) ** 2))
        labels[labels == ci] = nearest
    return labels, palette


def digitize_raster(image_path, mm_per_px, n_colors=6,
                    props: StitchProperties | None = None):
    """Returns (objects, color_palette). Objects carry color block indices in
    stitch order (darkest colors last so outlines sit on top)."""
    base = props or StitchProperties()
    labels, palette = quantize(image_path, n_colors)
    brightness = palette.mean(axis=1)
    bg = int(np.argmax(brightness))

    # stitch light-to-dark, skipping background
    color_ids = [c for c in np.argsort(-brightness) if c != bg
                 and (labels == c).sum() > 0]

    objects = []
    px_area = mm_per_px * mm_per_px
    for block_index, ci in enumerate(color_ids):
        mask = labels == ci
        if mask.sum() * px_area < MIN_REGION_MM2:
            continue
        skel, dist = medial_axis(mask, return_distance=True, rng=0)
        widths = 2 * dist[skel] * mm_per_px if skel.any() else np.array([0])
        if float(np.mean(widths)) <= THIN_MAX_MEAN_W:
            # Thin color: reuse the line-art machinery on this mask.
            from PIL import Image as PILImage
            tmp = PILImage.fromarray((~mask * 255).astype(np.uint8))
            import tempfile, os
            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
                tmp.save(f.name)
                objs = digitize_lineart(f.name, mm_per_px, props=base)
            os.unlink(f.name)
            for o in objs:
                o.color = block_index
            objects.extend(objs)
        else:
            for region_id in range(1, label(mask, connectivity=2).max() + 1):
                region = label(mask, connectivity=2) == region_id
                if region.sum() * px_area < MIN_REGION_MM2:
                    continue
                contours = find_contours(region.astype(float), 0.5)
                rings = [np.column_stack([c[:, 1], c[:, 0]]) * mm_per_px
                         for c in contours if len(c) >= 4]
                if not rings:
                    continue
                rings.sort(key=lambda r: -Polygon(r).area)
                poly = Polygon(rings[0], [r for r in rings[1:] if Polygon(r).area > 1.0])
                if not poly.is_valid:
                    poly = poly.buffer(0)
                if poly.is_empty:
                    continue
                objects.append(FillRegion(poly, props=base, color=block_index,
                                          name=f"color-{ci}-fill"))
    return objects, [tuple(palette[c]) for c in color_ids]
