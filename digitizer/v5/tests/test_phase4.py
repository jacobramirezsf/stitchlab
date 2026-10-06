"""Phase 4 tests: config layering, fabric presets, TOML parsing, CLI, density."""

import subprocess
import sys
from pathlib import Path

import numpy as np
from shapely.geometry import Polygon

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from v5.compile import compile_objects  # noqa: E402
from v5.config import FABRIC_PRESETS, ResolvedConfig, _mini_toml  # noqa: E402
from v5.objects import FillRegion, RunPath, StitchProperties  # noqa: E402
from v5.validate import density_warnings  # noqa: E402

V5DIR = Path(__file__).resolve().parents[1]


def test_mini_toml_types():
    cfg = _mini_toml('''
# comment
[props]
density = 0.35
staggers = 6
pattern = "weave"
[underlay]
kinds = ["edge_run", "zigzag"]
inset = 0.8
[object.fill-outline]
bean_repeats = 1
''')
    assert cfg["props"]["density"] == 0.35
    assert cfg["props"]["staggers"] == 6
    assert cfg["props"]["pattern"] == "weave"
    assert cfg["underlay"]["kinds"] == ["edge_run", "zigzag"]
    assert cfg["object"]["fill-outline"]["bean_repeats"] == 1


def test_layering_order(tmp_path):
    # fabric sets pull_comp 0.30; design file overrides density only
    design = tmp_path / "d.toml"
    design.write_text("[props]\ndensity = 0.5\n")
    cfg = ResolvedConfig(fabric="knit", config_path=str(design))
    p = cfg.properties()
    assert p.pull_comp == 0.30       # from fabric
    assert p.density == 0.5          # design file wins over fabric's 0.40
    assert p.underlay.kinds == ("edge_run", "zigzag")  # knit underlay


def test_fabric_presets_complete():
    for name, preset in FABRIC_PRESETS.items():
        cfg = ResolvedConfig(fabric=name)
        p = cfg.properties()
        assert 0.3 <= p.density <= 0.5
        assert 0.0 <= p.pull_comp <= 0.5


def test_unknown_key_rejected(tmp_path):
    design = tmp_path / "d.toml"
    design.write_text("[props]\ndensty = 0.5\n")  # typo
    cfg = ResolvedConfig(config_path=str(design))
    try:
        cfg.properties()
        assert False, "should reject unknown key"
    except ValueError as e:
        assert "densty" in str(e)


def test_per_object_override(tmp_path):
    design = tmp_path / "d.toml"
    design.write_text('[object.fill-outline]\nbean_repeats = 5\n')
    cfg = ResolvedConfig(config_path=str(design))
    objs = [RunPath([(0, 0), (5, 0)], props=cfg.properties(), name="fill-outline"),
            RunPath([(0, 2), (5, 2)], props=cfg.properties(), name="line")]
    cfg.apply_object_overrides(objs)
    assert objs[0].props.bean_repeats == 5
    assert objs[1].props.bean_repeats == 1


def test_density_warning_triggers():
    # a deliberately over-dense stack: same tiny fill five times
    poly = Polygon([(0, 0), (4, 0), (4, 4), (0, 4)])
    objs = [FillRegion(poly, props=StitchProperties(row_spacing=0.3,
                                                    fill_stitch_length=0.6))
            for _ in range(5)]
    plan = compile_objects(objs)
    warnings = density_warnings(plan)
    assert warnings and "density" in warnings[0]


def test_density_ok_for_normal_fill():
    poly = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)])
    plan = compile_objects([FillRegion(poly, props=StitchProperties())])
    assert density_warnings(plan) == []


def test_cli_end_to_end(tmp_path):
    # smallest jacket design through the CLI, lineart, dst only
    raster = V5DIR.parent / "raster" / "pear.png"
    out = tmp_path / "out"
    result = subprocess.run(
        [sys.executable, "-m", "v5.cli", str(raster), "--size", "50.8",
         "--fabric", "twill", "--frontend", "lineart", "--formats", "dst",
         "-o", str(out)],
        capture_output=True, text=True, cwd=str(V5DIR.parent), timeout=300)
    assert result.returncode == 0, result.stderr[-500:]
    assert (out / "pear.dst").exists()
    assert (out / "pear-preview.png").exists()
    import json
    stats = json.loads(result.stdout.strip().splitlines()[-1])
    assert stats["stitches"] > 100
    assert stats["fabric"] == "twill"
