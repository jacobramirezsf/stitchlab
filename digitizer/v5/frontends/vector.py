"""Vector frontend: clean vector geometry → objects, no rasterization.

Phase 1 scope: accepts shapely geometry directly (Polygon/MultiPolygon →
FillRegion; LineString → RunPath). Direct SVG parsing (paths + fill rules →
shapely) needs the `svgelements` package — flagged for approval; until then
SVG input goes through the raster or lineart frontends.
"""

from __future__ import annotations

from shapely.geometry import LineString, MultiPolygon, Polygon

from ..objects import FillRegion, RunPath, StitchProperties


def objects_from_geometry(geoms, props: StitchProperties | None = None):
    base = props or StitchProperties()
    out = []
    for g in geoms:
        if isinstance(g, MultiPolygon):
            out.extend(FillRegion(p, props=base) for p in g.geoms)
        elif isinstance(g, Polygon):
            out.append(FillRegion(g, props=base))
        elif isinstance(g, LineString):
            out.append(RunPath(list(g.coords), props=base))
        else:
            raise TypeError(f"unsupported geometry: {type(g).__name__}")
    return out
