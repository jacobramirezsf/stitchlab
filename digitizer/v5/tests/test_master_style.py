"""Master style (Jacob's reference digitizing) + web service tests."""

import base64
import sys
from pathlib import Path

import pyembroidery
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from v5.frontends.lineart import digitize_lineart  # noqa: E402
from v5.objects import RunPath, SatinColumn, StitchProperties  # noqa: E402
from v5.service import run_job  # noqa: E402

RASTER = Path(__file__).resolve().parents[2] / "raster"
CONFETTI = str(RASTER / "10yrs_confetti.png")


@pytest.fixture(scope="module")
def master_objects():
    return digitize_lineart(CONFETTI, 0.0625,
                            props=StitchProperties(tie_size=0.5),
                            style="master")


def test_master_is_single_pass(master_objects):
    runs = [o for o in master_objects if isinstance(o, RunPath)]
    assert runs
    assert all(o.props.bean_repeats == 1 for o in runs)


def test_master_satinizes_wide_marks(master_objects):
    satins = [o for o in master_objects if isinstance(o, SatinColumn)]
    assert len(satins) >= 2   # the curls + solid confetti in this design


def test_master_longer_run_length(master_objects):
    runs = [o for o in master_objects if isinstance(o, RunPath)]
    assert runs[0].props.run_length == pytest.approx(2.8)


def test_default_style_unchanged():
    objs = digitize_lineart(CONFETTI, 0.0625,
                            props=StitchProperties(tie_size=0.5))
    beans = [o for o in objs if isinstance(o, RunPath)
             and o.props.bean_repeats == 3]
    assert beans  # redwork default keeps bean ×3


def test_service_run_job(tmp_path):
    data = (RASTER / "pear.png").read_bytes()
    r = run_job("pear.png", data, size_mm=50.8, style="master")
    assert "error" not in r
    assert r["stats"]["stitches"] > 100
    assert set(r["files"]) == {"dst", "pes", "exp", "jef"}
    # the returned DST decodes and matches the reported stitch count
    dst = tmp_path / "x.dst"
    dst.write_bytes(base64.b64decode(r["files"]["dst"]))
    p = pyembroidery.read(str(dst))
    stitches = sum(1 for *_xy, c in p.stitches
                   if (c & pyembroidery.COMMAND_MASK) == pyembroidery.STITCH)
    assert stitches == r["stats"]["stitches"]
    assert len(base64.b64decode(r["sim"])) > 1000


def test_service_rejects_blank_image():
    from PIL import Image
    import io
    buf = io.BytesIO()
    Image.new("L", (100, 100), 255).save(buf, "PNG")
    r = run_job("blank.png", buf.getvalue())
    assert "error" in r
