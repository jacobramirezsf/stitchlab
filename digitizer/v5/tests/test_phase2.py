"""Phase 2 tests: underlay, pull comp, fill variants, short-stitch, applique."""

import sys
from pathlib import Path

import numpy as np
import pyembroidery
import pytest
from shapely.geometry import Point, Polygon

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from v5.compile import compile_objects, write_outputs  # noqa: E402
from v5.objects import (Applique, FillRegion, SatinColumn,  # noqa: E402
                        StitchProperties, UnderlaySpec)
from v5.stitchgen.fill import contour_stitches, spiral_stitches  # noqa: E402
from v5.stitchgen.satin import satin_stitches  # noqa: E402
from v5.stitchgen.underlay import (auto_underlay_for_satin,  # noqa: E402
                                   fill_underlay, satin_underlay)
from v5.validate import validate_file  # noqa: E402


# ── underlay ────────────────────────────────────────────────────────────────

def rails():
    return [(0, 0), (20, 0)], [(0, 4), (20, 4)]


def test_auto_underlay_rules():
    assert auto_underlay_for_satin(2.0).kinds == ("center_run",)
    assert auto_underlay_for_satin(5.0).kinds == ("edge_run", "zigzag")
    assert auto_underlay_for_satin(9.0).kinds == ("edge_run", "double_zigzag")


def test_center_run_underlay_inside_column():
    a, b = rails()
    blocks = satin_underlay(a, b, UnderlaySpec(kinds=("center_run",)))
    pts = blocks[0].points
    assert np.allclose(pts[:, 1], 2.0, atol=0.3)  # down the middle


def test_edge_run_underlay_inset():
    a, b = rails()
    blocks = satin_underlay(a, b, UnderlaySpec(kinds=("edge_run",), inset=0.8))
    pts = blocks[0].points
    # stays inside the column by ~inset
    assert pts[:, 1].min() > 0.5 and pts[:, 1].max() < 3.5


def test_zigzag_underlay_spans_column():
    a, b = rails()
    blocks = satin_underlay(a, b, UnderlaySpec(kinds=("zigzag",), spacing=2.0))
    pts = blocks[0].points
    assert pts[:, 1].max() - pts[:, 1].min() > 2.0  # crosses the column
    assert len(pts) < 40  # far sparser than cover satin


def test_fill_underlay_counter_angle_and_inset():
    poly = Polygon([(0, 0), (20, 0), (20, 20), (0, 20)])
    props = StitchProperties(angle=0)
    blocks = fill_underlay(poly, UnderlaySpec(kinds=("edge_run", "tatami"),
                                              inset=0.8, spacing=2.5),
                           cover_angle=0, props=props)
    assert len(blocks) >= 2
    pts = np.concatenate([b.points for b in blocks])
    assert pts[:, 0].min() > 0.1 and pts[:, 0].max() < 19.9  # respects inset
    assert all(b.kind == "underlay" for b in blocks)


def test_satin_underlay_emitted_by_compiler(tmp_path):
    col = SatinColumn([(0, 0), (20, 0)], [(0, 4), (20, 4)],
                      props=StitchProperties(
                          density=0.4,
                          underlay=UnderlaySpec(kinds=("edge_run", "zigzag"))))
    plan = compile_objects([col])
    kinds = [b.kind for b in plan.blocks]
    assert kinds[:2] == ["underlay", "underlay"] and "satin" in kinds
    out = write_outputs(plan, str(tmp_path / "u"), formats=("dst",))
    assert validate_file(out[0])["warnings"] == []


# ── pull compensation ───────────────────────────────────────────────────────

def test_satin_pull_comp_widens():
    base = SatinColumn([(0, 0), (20, 0)], [(0, 3), (20, 3)],
                       props=StitchProperties(density=0.4))
    comp = SatinColumn([(0, 0), (20, 0)], [(0, 3), (20, 3)],
                       props=StitchProperties(density=0.4, pull_comp=0.2))
    h0 = base.generate()[0].points[:, 1]
    h1 = comp.generate()[0].points[:, 1]
    width0 = h0.max() - h0.min()
    width1 = h1.max() - h1.min()
    assert width1 == pytest.approx(width0 + 0.4, abs=0.1)


def test_fill_pull_comp_extends_along_rows():
    poly = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)])
    base = FillRegion(poly, props=StitchProperties(angle=0))
    comp = FillRegion(poly, props=StitchProperties(angle=0, pull_comp=0.3))
    p0 = np.concatenate([b.points for b in base.generate()])
    p1 = np.concatenate([b.points for b in comp.generate()])
    assert (p1[:, 0].max() - p1[:, 0].min()) > (p0[:, 0].max() - p0[:, 0].min()) + 0.4
    # perpendicular unchanged
    assert abs((p1[:, 1].max() - p1[:, 1].min()) - (p0[:, 1].max() - p0[:, 1].min())) < 0.3


# ── fill variants ───────────────────────────────────────────────────────────

def disk():
    return Point(10, 10).buffer(8)


def test_contour_fill_covers_disk():
    props = StitchProperties(row_spacing=0.8, fill_stitch_length=2.5)
    sections = contour_stitches(disk(), props)
    pts = np.concatenate(sections)
    r = np.hypot(pts[:, 0] - 10, pts[:, 1] - 10)
    assert r.max() <= 8.3
    assert r.min() < 1.5   # reaches the middle
    assert len(sections) <= 3  # mostly continuous


def test_spiral_fill_is_single_path():
    props = StitchProperties(row_spacing=0.8, fill_stitch_length=2.5)
    sections = spiral_stitches(disk(), props)
    assert len(sections) == 1
    pts = sections[0]
    r = np.hypot(pts[:, 0] - 10, pts[:, 1] - 10)
    # radius sweeps monotonically-ish from edge to center or back
    assert abs(r[0] - r[-1]) > 5


def test_fill_mode_dispatch():
    poly = disk()
    contour = FillRegion(poly, props=StitchProperties(fill_mode="contour",
                                                      row_spacing=0.8))
    assert len(contour.generate()) >= 1


def test_pattern_presets_change_stagger():
    poly = Polygon([(0, 0), (40, 0), (40, 4), (0, 4)])
    a = FillRegion(poly, props=StitchProperties(pattern="standard", angle=0,
                                                row_spacing=0.5, fill_stitch_length=4))
    b = FillRegion(poly, props=StitchProperties(pattern="random", angle=0,
                                                row_spacing=0.5, fill_stitch_length=4))
    pa = np.concatenate([blk.points for blk in a.generate()])
    pb = np.concatenate([blk.points for blk in b.generate()])
    assert len(pa) > 50 and len(pb) > 50
    assert not np.array_equal(pa[:50], pb[:50])


# ── satin short-stitch ──────────────────────────────────────────────────────

def test_short_stitch_on_tight_curve():
    # 90° elbow: inner rail much shorter than outer
    theta = np.linspace(0, np.pi / 2, 60)
    outer = np.column_stack([8 * np.cos(theta), 8 * np.sin(theta)])
    inner = np.column_stack([3 * np.cos(theta), 3 * np.sin(theta)])
    props = StitchProperties(density=0.4)
    pts = satin_stitches(outer, inner, props)
    r = np.hypot(pts[:, 0], pts[:, 1])
    near_inner = (r < 3.2).sum()
    pulled_back = ((r > 3.4) & (r < 5.2)).sum()
    assert pulled_back > near_inner * 0.3  # a real share got shortened


# ── applique ────────────────────────────────────────────────────────────────

def test_applique_sequence(tmp_path):
    boundary = list(Point(0, 0).buffer(10).exterior.coords)
    ap = Applique(boundary, props=StitchProperties(density=0.45))
    plan = compile_objects([ap])
    kinds = [b.kind for b in plan.blocks]
    assert kinds == ["run", "tack", "satin"]
    stops = sum(1 for c, *_ in plan.commands if c == pyembroidery.STOP)
    assert stops == 2
    out = write_outputs(plan, str(tmp_path / "ap"), formats=("dst",))
    assert validate_file(out[0])["warnings"] == []
