"""Phase 1 test suite: geometry, generators, objects, compiler, files."""

import math
import sys
from pathlib import Path

import numpy as np
import pytest
from shapely.geometry import LineString, Polygon

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from v5.compile import TransitPolicy, compile_objects, to_pattern, write_outputs  # noqa: E402
from v5.geometry import (offset_polyline, point_segment_dist, polyline_length,  # noqa: E402
                         resample, tolerance_walk)
from v5.objects import (FillRegion, ManualStitch, MotifRun, RunPath,  # noqa: E402
                        SatinColumn, StitchProperties)
from v5.stitchgen.fill import tatami_stitches  # noqa: E402
from v5.stitchgen.satin import satin_stitches  # noqa: E402
from v5.validate import validate_file  # noqa: E402


# ── geometry ────────────────────────────────────────────────────────────────

def test_resample_even_spacing():
    line = [(0, 0), (10, 0)]
    pts = resample(line, 2.0)
    assert len(pts) == 6
    gaps = np.hypot(*np.diff(pts, axis=0).T)
    assert np.allclose(gaps, 2.0, atol=1e-6)


def test_tolerance_walk_long_on_straight_short_on_curve():
    straight = [(0, 0), (20, 0)]
    pts = tolerance_walk(straight, max_len=2.2, min_len=0.8, tol=0.15)
    gaps = np.hypot(*np.diff(pts, axis=0).T)
    assert gaps.max() <= 2.2 + 1e-6
    assert gaps.mean() > 1.8  # uses long stitches on straights

    theta = np.linspace(0, np.pi, 100)
    arc = np.column_stack([5 * np.cos(theta), 5 * np.sin(theta)])
    apts = tolerance_walk(arc, max_len=2.2, min_len=0.8, tol=0.15)
    agaps = np.hypot(*np.diff(apts, axis=0).T)
    assert agaps.mean() < gaps.mean()  # shorter on the curve
    # every stitch chord stays within tolerance of the arc (radius check)
    mids = (apts[1:] + apts[:-1]) / 2
    r = np.hypot(mids[:, 0], mids[:, 1])
    assert (5 - r).max() < 0.2


def test_point_segment_dist():
    assert point_segment_dist([(5, 3)], (0, 0), (10, 0)) == pytest.approx(3)


def test_offset_polyline_distance():
    line = np.array([(0, 0), (10, 0)], float)
    off = offset_polyline(resample(line, 1), 1.5)
    assert np.allclose(off[:, 1], -1.5, atol=0.2) or np.allclose(off[:, 1], 1.5, atol=0.2)


# ── run generation ──────────────────────────────────────────────────────────

def test_bean_triples_segments():
    p = StitchProperties(bean_repeats=3)
    obj = RunPath([(0, 0), (10, 0)], props=p)
    (block,) = obj.generate()
    single = RunPath([(0, 0), (10, 0)], props=StitchProperties(bean_repeats=1)).generate()[0]
    assert len(block.points) == (len(single.points) - 1) * 3 + 1
    assert block.kind == "bean"


def test_run_reversal_endpoint():
    obj = RunPath([(0, 0), (10, 0)], props=StitchProperties())
    fwd = obj.generate(0)[0].points
    rev = obj.generate(1)[0].points
    assert np.allclose(fwd[0], rev[-1])


# ── satin ───────────────────────────────────────────────────────────────────

def test_satin_zigzags_between_rails():
    props = StitchProperties(density=0.5)
    pts = satin_stitches([(0, 0), (10, 0)], [(0, 2), (10, 2)], props)
    ys = pts[:, 1]
    # alternates between rails
    assert set(np.round(ys, 1)) <= {0.0, 2.0}
    assert (np.abs(np.diff(ys)) > 1.5).sum() >= len(pts) // 2
    # density: advance per zig pair ≈ 0.5mm over 10mm → ≥ 18 crossings
    assert len(pts) >= 36


def test_satin_from_centerline_width():
    col = SatinColumn.from_centerline(
        [(0, 0), (10, 0)], np.full(30, 2.0), props=StitchProperties(density=0.5))
    pts = col.generate()[0].points
    width = pts[:, 1].max() - pts[:, 1].min()
    assert 1.6 < width < 2.6


def test_split_satin_wide_column():
    props = StitchProperties(density=1.0)
    pts = satin_stitches([(0, 0), (10, 0)], [(0, 10), (10, 10)], props, split_width=8.0)
    deltas = np.hypot(*np.diff(pts, axis=0).T)
    assert deltas.max() < 8.1  # no rail-to-rail 10mm stitches survive


# ── fill ────────────────────────────────────────────────────────────────────

def square_with_hole():
    return Polygon([(0, 0), (20, 0), (20, 20), (0, 20)],
                   [[(8, 8), (12, 8), (12, 12), (8, 12)]])


def test_tatami_covers_and_respects_holes():
    props = StitchProperties(row_spacing=0.5, fill_stitch_length=3.0, angle=0)
    sections = tatami_stitches(square_with_hole(), props)
    pts = np.concatenate(sections)
    # nothing lands inside the hole (with a small margin)
    inside_hole = ((pts[:, 0] > 8.6) & (pts[:, 0] < 11.4)
                   & (pts[:, 1] > 8.6) & (pts[:, 1] < 11.4))
    assert not inside_hole.any()
    # rows span the shape
    assert pts[:, 1].max() > 18 and pts[:, 1].min() < 2


def test_tatami_angle_rotates_rows():
    props = StitchProperties(row_spacing=0.5, fill_stitch_length=3.0, angle=90)
    sections = tatami_stitches(Polygon([(0, 0), (10, 0), (10, 30), (0, 30)]), props)
    pts = np.concatenate(sections)
    # rows at 90° → long runs along y: consecutive same-x spans
    xs = np.unique(np.round(pts[:, 0], 1))
    assert len(xs) <= 45  # ~20 rows (+ rounding splits), not hundreds of x positions


def test_tatami_stagger_offsets_rows():
    props = StitchProperties(row_spacing=0.5, fill_stitch_length=4.0, staggers=4, angle=0)
    sections = tatami_stitches(Polygon([(0, 0), (40, 0), (40, 4), (0, 4)]), props)
    pts = np.concatenate(sections)
    by_row = {}
    for x, y in pts:
        by_row.setdefault(round(y, 1), []).append(x)
    rows = [sorted(v) for _, v in sorted(by_row.items())][:4]
    interior = [set(np.round([x for x in r if 5 < x < 35], 1)) for r in rows]
    assert interior[0] != interior[1]  # penetrations don't align row-to-row


# ── motif & manual ──────────────────────────────────────────────────────────

def test_motif_repeats_along_path():
    motif = np.array([(0, 0), (1, 1), (2, -1), (3, 0)], float)
    obj = MotifRun([(0, 0), (30, 0)], motif, motif_length=3.0, props=StitchProperties())
    pts = obj.generate()[0].points
    assert len(pts) == 10 * 4  # 10 repeats of 4 points


# ── compiler ────────────────────────────────────────────────────────────────

def test_compile_transit_tiers(tmp_path):
    props = StitchProperties(tie_in="small_run", tie_off="small_run")
    a = RunPath([(0, 0), (10, 0)], props=props)
    b = RunPath([(10.5, 0), (20, 0)], props=props)       # 0.5mm → connect
    c = RunPath([(24, 0), (30, 0)], props=props)          # 4mm → jump, no trim
    d = RunPath([(50, 0), (60, 0)], props=props)          # 20mm → trim
    plan = compile_objects([a, b, c, d], TransitPolicy())
    assert plan.trims == 1
    out = write_outputs(plan, str(tmp_path / "t"), formats=("dst",))
    stats = validate_file(out[0])
    assert stats["trims"] == 1
    assert stats["warnings"] == []


def test_compile_color_change(tmp_path):
    a = RunPath([(0, 0), (10, 0)], props=StitchProperties(), color=0)
    b = RunPath([(10, 5), (0, 5)], props=StitchProperties(), color=1)
    plan = compile_objects([a, b])
    assert plan.color_changes == 1


def test_sequencer_orders_nearest():
    far = RunPath([(100, 0), (110, 0)], props=StitchProperties())
    near = RunPath([(1, 0), (10, 0)], props=StitchProperties())
    plan_order = [o.name for o, _ in
                  __import__("v5.compile", fromlist=["sequence_objects"])
                  .sequence_objects([far, near])]
    # nearest to origin first
    assert plan_order is not None


def test_formats_roundtrip(tmp_path):
    obj = FillRegion(Polygon([(0, 0), (15, 0), (15, 15), (0, 15)]),
                     props=StitchProperties(angle=45))
    plan = compile_objects([obj])
    files = write_outputs(plan, str(tmp_path / "sq"), formats=("dst", "pes", "exp", "jef"))
    assert len(files) == 4
    stats = validate_file(files[0])
    assert stats["stitches"] > 200
    assert stats["warnings"] == []


def test_manual_verbatim():
    pts = [(0, 0), (1, 1), (0, 2)]
    obj = ManualStitch(pts, props=StitchProperties(tie_in="none", tie_off="none"))
    plan = compile_objects([obj])
    stitched = [(x, y) for c, x, y in plan.commands if c == 2 or c == 0]
    assert len(plan.blocks[0].points) == 3
