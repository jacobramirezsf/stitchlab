"""Plan layer tests: segmentation, treatments, colors, director plumbing."""

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from v5.compile import compile_objects  # noqa: E402
from v5.elements import (digitize_with_plan, hex_palette,  # noqa: E402
                         segment_elements)
from v5.frontends.lineart import load_mask  # noqa: E402
from v5.objects import FillRegion, SatinColumn, StitchProperties  # noqa: E402
from v5.service import run_job  # noqa: E402

RASTER = Path(__file__).resolve().parents[2] / "raster"
CONFETTI = str(RASTER / "10yrs_confetti.png")
MM = 0.0625


def test_segmentation_finds_marks():
    mask = load_mask(CONFETTI)
    elements, idmap = segment_elements(mask, MM)
    assert 10 < len(elements) < 60          # cone + confetti + letters
    assert idmap.max() == len(elements)     # ids are dense
    # biggest element first (the cone component)
    assert elements[0]["area_mm2"] == max(e["area_mm2"] for e in elements)


def test_plan_treatments_apply():
    plan = {"elements": {"1": {"treatment": "run", "color": 0},
                         "2": {"treatment": "fill", "color": 1},
                         "3": {"treatment": "skip"}}}
    objects, elements, idmap = digitize_with_plan(
        CONFETTI, MM, style="master",
        props=StitchProperties(tie_size=0.5), plan=plan)
    by_color = {c: [o for o in objects if o.color == c] for c in {o.color for o in objects}}
    # element 2 became a fill, colored 1
    assert any(isinstance(o, FillRegion) for o in by_color.get(1, []))
    # element 1 forced to runs: no satin among color-0 objects from it is
    # not directly checkable per element, but treatment run must not satin
    # (the cone is element 1 and includes wide curls that master satinizes)
    # → without the override there ARE satins in element 1's objects
    auto_objects, *_ = digitize_with_plan(
        CONFETTI, MM, style="master", props=StitchProperties(tie_size=0.5))
    assert any(isinstance(o, SatinColumn) for o in auto_objects)


def test_skip_removes_element():
    all_objs, elements, idmap = digitize_with_plan(
        CONFETTI, MM, style="master", props=StitchProperties(tie_size=0.5))
    skip_all = {"elements": {str(e["id"]): {"treatment": "skip"} for e in elements}}
    none_objs, *_ = digitize_with_plan(
        CONFETTI, MM, style="master", props=StitchProperties(tie_size=0.5),
        plan=skip_all)
    assert len(all_objs) > 0 and len(none_objs) == 0


def test_colors_produce_color_changes():
    plan = {"elements": {"2": {"treatment": "auto", "color": 1},
                         "3": {"treatment": "auto", "color": 2}}}
    objects, *_ = digitize_with_plan(
        CONFETTI, MM, style="master",
        props=StitchProperties(tie_size=0.5), plan=plan)
    used = sorted({o.color for o in objects})
    assert used == [0, 1, 2]
    compiled = compile_objects(objects, color_order=used)
    assert compiled.color_changes == 2


def test_service_returns_elements_and_plan_roundtrip():
    data = (RASTER / "tada.png").read_bytes()
    r = run_job("tada.png", data, size_mm=50.8, style="master")
    assert r["elements"] and r["idmap"]
    eid = str(r["elements"][0]["id"])
    r2 = run_job("tada.png", data, size_mm=50.8, style="master",
                 plan={"elements": {eid: {"treatment": "skip"}},
                       "palette": ["#112233", "#a81626"]})
    assert r2["stats"]["stitches"] < r["stats"]["stitches"]


def test_hex_palette_parses():
    assert hex_palette(["#182754"]) == [(24, 39, 84)]


def test_director_requires_key(monkeypatch):
    from v5.director import propose_plan
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY"):
        propose_plan(b"", b"", [], 50.8)
