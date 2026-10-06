"""Phase 5 tests: plan validation (ties, micro-stitches), cross-format
read-back, regression baseline drift detection, determinism, simulator."""

import json
import sys
from pathlib import Path

import numpy as np
import pyembroidery
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from v5.compile import StitchPlan, compile_objects, write_outputs  # noqa: E402
from v5.objects import RunPath, StitchProperties  # noqa: E402
from v5.simulate import render_simulation  # noqa: E402
from v5.validate import (ties_at_trims, validate_files,  # noqa: E402
                         validate_plan)

V5DIR = Path(__file__).resolve().parents[1]
RASTER = V5DIR.parent / "raster"


def far_runs():
    """Two runs far enough apart to force a trim."""
    return [RunPath([(0, 0), (8, 0)], props=StitchProperties()),
            RunPath([(40, 0), (48, 0)], props=StitchProperties())]


def test_compiled_trims_have_ties():
    plan = compile_objects(far_runs())
    assert plan.trims == 1
    assert ties_at_trims(plan) == []


def test_missing_ties_detected():
    # hand-built plan: long stitches straight into a trim, no ties anywhere
    plan = StitchPlan()
    for x in range(0, 10):
        plan.commands.append((pyembroidery.STITCH, float(x * 2), 0.0))
    plan.commands.append((pyembroidery.TRIM, 18.0, 0.0))
    plan.trims = 1
    plan.commands.append((pyembroidery.JUMP, 40.0, 0.0))
    for x in range(0, 5):
        plan.commands.append((pyembroidery.STITCH, 40.0 + x * 2, 0.0))
    warnings = ties_at_trims(plan)
    assert any("tie-off" in w for w in warnings)
    assert any("tie-in" in w for w in warnings)


def test_validate_plan_clean_on_compiled():
    plan = compile_objects(far_runs())
    stats = validate_plan(plan)
    assert stats["warnings"] == []
    assert stats["stitches"] > 0


def test_validate_plan_flags_micro_excess():
    plan = StitchPlan()
    for i in range(100):
        plan.commands.append((pyembroidery.STITCH, i * 0.1, 0.0))  # all 0.1mm
    stats = validate_plan(plan)
    assert any("micro" in w for w in stats["warnings"])


def test_cross_format_readback(tmp_path):
    plan = compile_objects(far_runs())
    files = write_outputs(plan, str(tmp_path / "x"), formats=("dst", "pes", "exp"))
    stats = validate_files(files)
    assert len(stats) == 3
    counts = [s["stitches"] for s in stats.values()]
    assert max(counts) - min(counts) <= max(5, max(counts) * 0.01)


def test_baseline_drift_detection(tmp_path, monkeypatch):
    from v5 import regression
    baseline = {"pear": {"stitches": 249, "trims": 0}}
    bl = tmp_path / "baseline.json"
    bl.write_text(json.dumps(baseline))
    monkeypatch.setattr(regression, "BASELINE", str(bl))
    ok_rows = [("pear", None, {"stitches": 250, "trims": 0, "warnings": []})]
    assert regression.check_baseline(ok_rows) == []
    bad_rows = [("pear", None, {"stitches": 300, "trims": 4, "warnings": []})]
    failures = regression.check_baseline(bad_rows)
    assert any("stitches" in f for f in failures)
    assert any("trims" in f for f in failures)
    # a design that vanished from the run is a failure too
    assert regression.check_baseline([]) == ["pear: missing from run"]


def test_lineart_deterministic():
    from v5.frontends.lineart import digitize_lineart
    props = StitchProperties(run_length=2.2, run_min_length=0.8,
                             run_tolerance=0.15, bean_repeats=3, tie_size=0.5)
    a = digitize_lineart(str(RASTER / "pear.png"), 0.0625, props=props)
    b = digitize_lineart(str(RASTER / "pear.png"), 0.0625, props=props)
    assert len(a) == len(b)
    assert (compile_objects(a).stitch_count()
            == compile_objects(b).stitch_count())


def test_simulator_renders_thread(tmp_path):
    plan = compile_objects([RunPath([(0, 0), (20, 0), (20, 20)],
                                    props=StitchProperties())])
    out = tmp_path / "sim.png"
    img = render_simulation(plan, str(out), px_per_mm=10)
    assert out.exists()
    # 20mm + 2×4mm margin at 10px/mm ≈ 280px
    assert abs(img.size[0] - 280) < 30
    arr = np.array(img).astype(int)
    # thread pixels (navy default) present, plenty of fabric left
    navy = (arr[..., 2] > arr[..., 0] + 20).mean()
    assert 0.005 < navy < 0.5


def test_cli_simulate_flag(tmp_path):
    from v5 import cli
    out = tmp_path / "out"
    rc = cli.main([str(RASTER / "pear.png"), "--size", "50.8",
                   "--frontend", "lineart", "--formats", "dst",
                   "--simulate", "-o", str(out)])
    assert rc == 0
    assert (out / "pear-sim.png").exists()
    assert (out / "pear.dst").exists()
