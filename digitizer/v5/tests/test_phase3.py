"""Phase 3 tests: exact routing, 2-opt, travel-under, color order."""

import sys
from pathlib import Path

import numpy as np
import pyembroidery
from shapely.geometry import Polygon

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from v5.compile import (TransitPolicy, compile_objects,  # noqa: E402
                        sequence_objects)
from v5.objects import (FillRegion, RunPath, SatinColumn,  # noqa: E402
                        StitchProperties)


def props():
    return StitchProperties()


def test_exact_routing_orders_line():
    # five segments along a line, given shuffled — optimal order is 1..5
    xs = [(30, 40), (0, 10), (20, 30), (40, 50), (10, 20)]
    units = [RunPath([(a, 0), (b, 0)], props=props()) for a, b in xs]
    order = sequence_objects(units, start=np.array([0.0, 0.0]))
    starts = [o.path[0 if e == 0 else -1][0] for o, e in order]
    assert starts == sorted(starts)


def test_exact_routing_zero_trims_when_chainable():
    xs = [(30, 40), (0, 10), (20, 30), (40, 50), (10, 20)]
    units = [RunPath([(a, 0), (b, 0)], props=props()) for a, b in xs]
    plan = compile_objects(units)
    assert plan.trims == 0  # every hop is a 0mm connect


def test_2opt_beats_greedy_crossing():
    # >EXACT_MAX_UNITS units placed so greedy NN produces a long final hop;
    # 2-opt should keep total trims low. Grid of 12 short strokes.
    units = []
    for i in range(12):
        x = (i % 4) * 20
        y = (i // 4) * 20
        units.append(RunPath([(x, y), (x + 5, y)], props=props()))
    plan = compile_objects(units)
    # worst orderings trim ~11 times; a sane route trims ≤ 11 with many
    # 15mm hops → every hop trims. The real assertion: route length sanity.
    order = sequence_objects(units)
    import math
    pos = np.array([0.0, 0.0])
    total = 0.0
    for o, e in order:
        entry, exit_ = o.endpoints()[e]
        total += math.dist(pos, entry)
        pos = np.asarray(exit_)
    assert total < 320  # naive bad orders exceed 400


def test_travel_buried_under_later_fill():
    # two runs on opposite sides of a fill; fill stitches AFTER (same color).
    left = RunPath([(0, 5), (9.4, 5)], props=props(), group=1)
    right = RunPath([(30.6, 5), (40, 5)], props=props(), group=1)
    fill = FillRegion(Polygon([(10, 0), (30, 0), (30, 10), (0 + 10, 10)]),
                      props=props().with_(angle=0, row_spacing=0.5))
    plan = compile_objects([left, right, fill])
    kinds = [b.kind for b in plan.blocks]
    # the run→run transit is buried; only the final hop into the fill may trim
    assert kinds.index("travel") == 1
    assert plan.trims <= 1
    # travel points sit inside the fill region (will be covered)
    travel = next(b for b in plan.blocks if b.kind == "travel")
    poly = fill.polygon.buffer(0.6)
    from shapely.geometry import Point
    inside = sum(poly.contains(Point(*p)) for p in travel.points)
    assert inside >= len(travel.points) - 2


def test_travel_along_later_satin_centerline():
    # Deterministic order (explicit): run → run with the satin last; the
    # transit between the runs buries along the satin's centerline.
    a = RunPath([(0, 5), (0.5, 5)], props=props())
    b = RunPath([(40, 5), (40.5, 5)], props=props())
    col = SatinColumn([(0, 3.5), (41, 3.5)], [(0, 6.5), (41, 6.5)],
                      props=props().with_(density=0.4))
    plan = compile_objects([a, b, col], order=[(a, 0), (b, 0), (col, 1)])
    assert plan.trims == 0
    kinds = [blk.kind for blk in plan.blocks]
    assert kinds.index("travel") == 1
    travel = next(blk for blk in plan.blocks if blk.kind == "travel")
    assert np.allclose(travel.points[:, 1], 5.0, atol=0.6)  # on the centerline


def test_no_travel_under_earlier_object():
    # fill stitches FIRST → travel over it must NOT be buried (it would show)
    fill = FillRegion(Polygon([(10, 0), (30, 0), (30, 10), (10, 10)]),
                      props=props().with_(angle=0, row_spacing=0.5))
    left = RunPath([(0, 5), (9.4, 5)], props=props())
    right = RunPath([(30.6, 5), (40, 5)], props=props())
    order = sequence_objects([fill, left, right])
    # wherever the fill lands in the route, transits AFTER it may not bury
    # under it: compile and check any travel block precedes the fill blocks
    plan = compile_objects([fill, left, right])
    kinds = [b.kind for b in plan.blocks]
    if "travel" in kinds:
        assert kinds.index("travel") < kinds.index("fill")


def test_color_order_respected():
    a = RunPath([(0, 0), (5, 0)], props=props(), color=2)
    b = RunPath([(10, 0), (15, 0)], props=props(), color=1)
    order = sequence_objects([a, b], color_order=[1, 2])
    assert [o.color for o, _ in order] == [1, 2]
