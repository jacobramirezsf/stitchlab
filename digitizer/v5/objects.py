"""The object model: what commercial digitizers build before any stitch exists.

Every StitchObject carries StitchProperties and can report its entry/exit
candidates (for sequencing) and generate its cover stitches. Underlay and
pull compensation are applied by the compiler as passes around/into
generation (Phase 2 fleshes those out; the property slots exist now).
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Literal, Optional

import numpy as np
from shapely.geometry import Polygon

TieMode = Literal["none", "small_run", "triangle"]
UnderlayKind = Literal["none", "center_run", "edge_run", "zigzag", "double_zigzag", "tatami"]


@dataclass
class UnderlaySpec:
    kinds: tuple[UnderlayKind, ...] = ()   # applied in order
    inset: float = 0.8                     # mm, edge-run inset (needle width)
    spacing: float = 2.0                   # mm, zigzag/tatami underlay spacing
    stitch_length: float = 2.0             # mm


@dataclass
class StitchProperties:
    """Per-object parameters. Defaults are the industry standards from
    RESEARCH.md §4; presets and per-object overrides layer on top."""
    # runs
    run_length: float = 2.2          # max stitch on straights
    run_min_length: float = 0.8
    run_tolerance: float = 0.15      # chord-gapping tolerance
    bean_repeats: int = 1            # 1 = single run, 3 = bean, up to 9
    # satin
    density: float = 0.4             # mm advance per zig (satin) / row (fill)
    min_width: float = 1.5           # satin narrower than this gets widened
    max_stitch: float = 10.0         # split any longer movement
    # fill
    angle: float = 0.0               # degrees, fill row angle (per-object!)
    row_spacing: float = 0.4         # mm between fill rows
    fill_stitch_length: float = 3.5  # mm along fill rows
    staggers: int = 4                # penetration offset cycle length
    pattern: str = "standard"        # tatami pattern preset (see fill.PATTERNS)
    fill_mode: str = "tatami"        # tatami | contour | spiral | motif
    # quality
    pull_comp: float = 0.0           # mm widening perpendicular to stitches
    underlay: UnderlaySpec = field(default_factory=UnderlaySpec)
    # ties & transits
    tie_in: TieMode = "small_run"
    tie_off: TieMode = "small_run"
    tie_size: float = 0.5

    def with_(self, **kw) -> "StitchProperties":
        return replace(self, **kw)


@dataclass
class StitchBlock:
    """A continuous run of needle-downs of one kind (no jumps inside)."""
    points: np.ndarray                     # (n, 2) mm
    kind: str = "run"                      # run/bean/satin/fill/underlay/motif/manual/tack
    color: int = 0                         # color block index

    def __len__(self):
        return len(self.points)


class StitchObject:
    """Base: a design object that can be compiled to stitch blocks."""

    def __init__(self, props: Optional[StitchProperties] = None, color: int = 0,
                 name: str = "", group: Optional[int] = None):
        self.props = props or StitchProperties()
        self.color = color
        self.name = name
        # Objects sharing a group id are one continuous physical path (e.g. an
        # Euler trail through a line network); the sequencer never splits or
        # reorders a group, it only places/reverses it as a whole.
        self.group = group

    # sequencing interface -------------------------------------------------
    def endpoints(self) -> list[tuple[np.ndarray, np.ndarray]]:
        """Candidate (entry, exit) pairs. Sequencer may pick any, including
        reversed variants the object chooses to offer."""
        raise NotImplementedError

    # generation interface --------------------------------------------------
    def generate(self, entry_index: int = 0) -> list[StitchBlock]:
        """Cover stitches for the chosen entry/exit variant."""
        raise NotImplementedError

    def underlay_blocks(self, entry_index: int = 0) -> list[StitchBlock]:
        return []  # Phase 2

    def hidden_travel(self, a, b) -> Optional[np.ndarray]:
        """A path from a to b that this object will later COVER with its own
        stitching (fills and satins can bury travel runs). None if it can't."""
        return None


class RunPath(StitchObject):
    """Line stitching along a path: single / bean×n via tolerance placement."""

    def __init__(self, path, **kw):
        super().__init__(**kw)
        self.path = np.asarray(path, float)

    def endpoints(self):
        return [(self.path[0], self.path[-1]), (self.path[-1], self.path[0])]

    def generate(self, entry_index: int = 0) -> list[StitchBlock]:
        from .stitchgen.runs import run_stitches
        path = self.path if entry_index == 0 else self.path[::-1]
        pts = run_stitches(path, self.props)
        if pts is None:
            return []
        kind = "bean" if self.props.bean_repeats >= 3 else "run"
        return [StitchBlock(pts, kind=kind, color=self.color)]


class SatinColumn(StitchObject):
    """Two rails + implicit rungs. Rails are sampled polylines of equal
    direction; stitches zigzag rail-to-rail at `density` advance."""

    def __init__(self, rail_a, rail_b, **kw):
        super().__init__(**kw)
        self.rail_a = np.asarray(rail_a, float)
        self.rail_b = np.asarray(rail_b, float)

    @classmethod
    def from_centerline(cls, center, widths, **kw):
        """Auto-satin: build rails by offsetting a centerline by half the
        (possibly varying) width — the medial-axis path from the patents."""
        from .geometry import offset_polyline, resample, smooth
        center = resample(np.asarray(center, float), 0.3)
        w = np.asarray(widths, float)
        if w.ndim == 0 or len(w) != len(center):
            w = np.full(len(center), float(np.mean(w)))
        half = np.maximum(w, kw.get("props", StitchProperties()).min_width) / 2
        from .geometry import unit_normals
        n = unit_normals(center)
        rail_a = smooth(center + n * half[:, None])
        rail_b = smooth(center - n * half[:, None])
        return cls(rail_a, rail_b, **kw)

    def endpoints(self):
        start = (self.rail_a[0] + self.rail_b[0]) / 2
        end = (self.rail_a[-1] + self.rail_b[-1]) / 2
        return [(start, end), (end, start)]

    def _comp_rails(self):
        """Pull compensation: satin pulls across the column (along its
        stitches), so widen each rail outward by pull_comp."""
        c = self.props.pull_comp
        if c <= 0:
            return self.rail_a, self.rail_b
        from .geometry import resample
        import numpy as _np
        a = resample(self.rail_a, 0.5)
        b = resample(self.rail_b, 0.5)
        m = min(len(a), len(b))
        a, b = a[:m], b[:m]
        d = b - a
        n = _np.maximum(_np.hypot(d[:, 0], d[:, 1]), 1e-9)[:, None]
        u = d / n
        return a - u * c, b + u * c

    def generate(self, entry_index: int = 0) -> list[StitchBlock]:
        from .stitchgen.satin import satin_stitches
        a, b = self._comp_rails()
        if entry_index == 1:
            a, b = a[::-1], b[::-1]
        pts = satin_stitches(a, b, self.props)
        if pts is None:
            return []
        return [StitchBlock(pts, kind="satin", color=self.color)]

    def underlay_blocks(self, entry_index: int = 0) -> list[StitchBlock]:
        spec = self.props.underlay
        if not spec.kinds:
            return []
        from .stitchgen.underlay import satin_underlay
        a, b = self.rail_a, self.rail_b
        if entry_index == 1:
            a, b = a[::-1], b[::-1]
        return satin_underlay(a, b, spec, color=self.color)

    def center_line(self) -> np.ndarray:
        n = min(len(self.rail_a), len(self.rail_b))
        from .geometry import resample
        a = resample(self.rail_a, 0.5)
        b = resample(self.rail_b, 0.5)
        n = min(len(a), len(b))
        return (a[:n] + b[:n]) / 2

    def hidden_travel(self, a, b):
        """Travel along the column's centerline if both endpoints sit on/near
        the column (within snap_mm of the centerline)."""
        import math as m
        snap = 1.5
        center = self.center_line()
        if len(center) < 2:
            return None
        da = np.hypot(*(center - np.asarray(a, float)).T)
        db = np.hypot(*(center - np.asarray(b, float)).T)
        ia, ib = int(np.argmin(da)), int(np.argmin(db))
        if da[ia] > snap or db[ib] > snap:
            return None
        lo, hi = (ia, ib) if ia <= ib else (ib, ia)
        path = center[lo:hi + 1]
        if len(path) < 2:
            return None
        return path if ia <= ib else path[::-1]


class FillRegion(StitchObject):
    """A filled area (shapely Polygon, holes supported)."""

    def __init__(self, polygon: Polygon, **kw):
        super().__init__(**kw)
        self.polygon = polygon

    def endpoints(self):
        # Entry/exit at the extreme points along the row angle: fills sew
        # best end-to-end (Embrilliance "exit bead at the opposite end").
        import math as m
        ang = m.radians(self.props.angle)
        d = np.array([m.cos(ang), m.sin(ang)])
        pts = np.array(self.polygon.exterior.coords)
        lo = pts[np.argmin(pts @ d)]
        hi = pts[np.argmax(pts @ d)]
        return [(lo, hi), (hi, lo)]

    def _comp_polygon(self):
        """Pull compensation for fills: stitches run along `angle`, pulling
        the region in that direction — extend the region along the row axis.
        Approximated as an anisotropic scale about the centroid."""
        c = self.props.pull_comp
        if c <= 0:
            return self.polygon
        from shapely import affinity
        rot = affinity.rotate(self.polygon, -self.props.angle, origin="centroid")
        minx, _miny, maxx, _maxy = rot.bounds
        w = max(maxx - minx, 1e-6)
        rot = affinity.scale(rot, xfact=(w + 2 * c) / w, yfact=1.0, origin="centroid")
        return affinity.rotate(rot, self.props.angle, origin="centroid")

    def generate(self, entry_index: int = 0) -> list[StitchBlock]:
        from .stitchgen import fill as fillgen
        poly = self._comp_polygon()
        mode = self.props.fill_mode
        if mode == "contour":
            segments = fillgen.contour_stitches(poly, self.props)
        elif mode == "spiral":
            segments = fillgen.spiral_stitches(poly, self.props)
        elif mode == "motif" and getattr(self, "motif", None) is not None:
            segments = fillgen.motif_fill_stitches(poly, self.props,
                                                   self.motif, self.motif_length)
        else:
            segments = fillgen.tatami_stitches(poly, self.props,
                                               reverse=(entry_index == 1))
        return [StitchBlock(pts, kind="fill", color=self.color) for pts in segments]

    def underlay_blocks(self, entry_index: int = 0) -> list[StitchBlock]:
        spec = self.props.underlay
        if not spec.kinds:
            return []
        from .stitchgen.underlay import fill_underlay
        return fill_underlay(self.polygon, spec, self.props.angle,
                             color=self.color, props=self.props)

    def hidden_travel(self, a, b):
        """Bury the covered middle of the a→b journey inside this region:
        clip the straight segment to the (slightly shrunk) polygon; if what
        remains outside is a short hop on each side (≤ snap), the travel can
        run through here and be covered when this fill stitches later."""
        import math as m
        from shapely.geometry import LineString
        snap = 1.6
        seg = LineString([tuple(a), tuple(b)])
        safe = self.polygon.buffer(-0.25)
        if safe.is_empty:
            return None
        inter = safe.intersection(seg)
        pieces = []
        if inter.geom_type == "LineString" and not inter.is_empty:
            pieces = [inter]
        elif inter.geom_type == "MultiLineString":
            pieces = list(inter.geoms)
        if not pieces:
            return None
        longest = max(pieces, key=lambda g: g.length)
        p = np.array(longest.coords[0])
        q = np.array(longest.coords[-1])
        # orient along a→b
        if m.dist(a, p) > m.dist(a, q):
            p, q = q, p
        if m.dist(a, p) > snap or m.dist(q, b) > snap:
            return None
        return np.array([a, p, q, b], float)


class MotifRun(StitchObject):
    """A motif (list of stitch offsets, in mm, one 'stamp') repeated along a path."""

    def __init__(self, path, motif, motif_length=None, **kw):
        super().__init__(**kw)
        self.path = np.asarray(path, float)
        self.motif = np.asarray(motif, float)   # (n, 2), spans x: 0..motif_length
        self.motif_length = motif_length or float(self.motif[:, 0].max() - self.motif[:, 0].min())

    def endpoints(self):
        return [(self.path[0], self.path[-1]), (self.path[-1], self.path[0])]

    def generate(self, entry_index: int = 0) -> list[StitchBlock]:
        from .stitchgen.runs import motif_stitches
        path = self.path if entry_index == 0 else self.path[::-1]
        pts = motif_stitches(path, self.motif, self.motif_length)
        if pts is None:
            return []
        return [StitchBlock(pts, kind="motif", color=self.color)]


class Applique(StitchObject):
    """Applique: placement run → STOP → tackdown zigzag → STOP → cover satin
    border along the boundary (the standard machine-applique sequence)."""

    def __init__(self, boundary, cover_width: float = 3.0,
                 tack_width: float = 1.5, **kw):
        super().__init__(**kw)
        self.boundary = np.asarray(boundary, float)
        self.cover_width = cover_width
        self.tack_width = tack_width

    def endpoints(self):
        return [(self.boundary[0], self.boundary[0])]

    def generate(self, entry_index: int = 0) -> list[StitchBlock]:
        from .geometry import offset_polyline, resample, tolerance_walk
        from .stitchgen.satin import satin_stitches
        blocks = []
        # 1. placement line
        pts = tolerance_walk(self.boundary, max_len=2.5, min_len=1.0, tol=0.3)
        blocks.append(StitchBlock(np.array(pts), kind="run", color=self.color))
        # 2. tackdown zigzag (stop before, so fabric can be placed)
        dense = resample(self.boundary, 0.4)
        ra = offset_polyline(dense, +self.tack_width / 2)
        rb = offset_polyline(dense, -self.tack_width / 2)
        tack = satin_stitches(ra, rb, self.props.with_(density=1.6))
        b = StitchBlock(np.array(tack), kind="tack", color=self.color)
        b.stop_before = True
        blocks.append(b)
        # 3. cover satin border (stop before, so excess can be trimmed)
        ca = offset_polyline(dense, +self.cover_width / 2)
        cb = offset_polyline(dense, -self.cover_width / 2)
        cover = satin_stitches(ca, cb, self.props)
        c = StitchBlock(np.array(cover), kind="satin", color=self.color)
        c.stop_before = True
        blocks.append(c)
        return blocks


class ManualStitch(StitchObject):
    """Exact needle points, verbatim (cross stitches on specks, edits)."""

    def __init__(self, points, **kw):
        super().__init__(**kw)
        self.points = np.asarray(points, float)

    def endpoints(self):
        return [(self.points[0], self.points[-1]), (self.points[-1], self.points[0])]

    def generate(self, entry_index: int = 0) -> list[StitchBlock]:
        pts = self.points if entry_index == 0 else self.points[::-1]
        return [StitchBlock(pts, kind="manual", color=self.color)]
