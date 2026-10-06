"""Parameter layering: built-in defaults → fabric preset → design config file
→ per-object-name overrides.

Config files are TOML (parsed with stdlib tomllib on 3.11+, else a strict
built-in subset parser: [sections], key = value for strings/numbers/bools/
flat lists, # comments — everything these configs need).

Sections:
    [props]      StitchProperties fields (density, pull_comp, angle, ...)
    [underlay]   UnderlaySpec fields (kinds, inset, spacing, stitch_length)
    [transit]    TransitPolicy fields (connect_mm, trim_mm, ...)
    [lineart]    line-art frontend thresholds (single_max_w, bean_max_w, ...)
    [output]     formats = ["dst", "pes"], ...
    [object.NAME] per-object-name property overrides (applied by frontend
                  object name, e.g. [object.fill-outline] bean_repeats = 1)
"""

from __future__ import annotations

from dataclasses import fields
from typing import Any

from .compile import TransitPolicy
from .objects import StitchProperties, UnderlaySpec

# ── fabric presets (numbers from RESEARCH.md §4) ────────────────────────────

FABRIC_PRESETS: dict[str, dict] = {
    "twill": {   # stable woven — the jacket case
        "props": {"density": 0.40, "pull_comp": 0.15, "row_spacing": 0.42},
        "underlay": {"kinds": [], "inset": 0.8, "spacing": 2.5},
    },
    "denim": {
        "props": {"density": 0.40, "pull_comp": 0.15, "row_spacing": 0.42},
        "underlay": {"kinds": [], "inset": 0.8, "spacing": 2.5},
    },
    "canvas": {  # very stable, coarse
        "props": {"density": 0.42, "pull_comp": 0.10, "row_spacing": 0.45},
        "underlay": {"kinds": [], "inset": 0.8, "spacing": 2.8},
    },
    "knit": {    # stretchy — stronger underlay, more comp
        "props": {"density": 0.40, "pull_comp": 0.30, "row_spacing": 0.40},
        "underlay": {"kinds": ["edge_run", "zigzag"], "inset": 0.8, "spacing": 2.0},
        "transit": {"trim_mm": 5.0},
    },
    "cap": {     # structured, unstable — heaviest support
        "props": {"density": 0.38, "pull_comp": 0.35, "row_spacing": 0.40},
        "underlay": {"kinds": ["edge_run", "double_zigzag"], "inset": 0.8, "spacing": 1.8},
    },
}

# Line-art frontend thresholds (defaults mirror frontends/lineart.py).
LINEART_DEFAULTS = {
    "single_max_w": 0.45,
    "bean_max_w": 1.8,
    "blob_w": 3.2,
    "speck_area_mm2": 1.5,
    "spur_mm": 1.6,
    "min_element_mm": 1.2,
    "style": "redwork",
}

OUTPUT_DEFAULTS = {"formats": ["dst", "pes"]}


# ── TOML loading ────────────────────────────────────────────────────────────

def _parse_value(raw: str) -> Any:
    raw = raw.strip()
    if raw.startswith("[") and raw.endswith("]"):
        inner = raw[1:-1].strip()
        return [_parse_value(v) for v in _split_list(inner)] if inner else []
    if raw.startswith('"') and raw.endswith('"'):
        return raw[1:-1]
    if raw.startswith("'") and raw.endswith("'"):
        return raw[1:-1]
    if raw in ("true", "false"):
        return raw == "true"
    try:
        return int(raw)
    except ValueError:
        pass
    try:
        return float(raw)
    except ValueError:
        raise ValueError(f"unsupported TOML value: {raw!r}")


def _split_list(inner: str) -> list[str]:
    parts, depth, buf, quote = [], 0, "", None
    for ch in inner:
        if quote:
            buf += ch
            if ch == quote:
                quote = None
            continue
        if ch in "\"'":
            quote = ch
            buf += ch
        elif ch == "[":
            depth += 1
            buf += ch
        elif ch == "]":
            depth -= 1
            buf += ch
        elif ch == "," and depth == 0:
            parts.append(buf)
            buf = ""
        else:
            buf += ch
    if buf.strip():
        parts.append(buf)
    return parts


def _mini_toml(text: str) -> dict:
    root: dict = {}
    current = root
    for lineno, line in enumerate(text.splitlines(), 1):
        line = line.split("#", 1)[0].strip() if not ('"' in line or "'" in line) \
            else line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            path = line[1:-1].strip()
            keys = [k.strip().strip('"').strip("'") for k in path.split(".")]
            current = root
            for k in keys:
                current = current.setdefault(k, {})
            continue
        if "=" not in line:
            raise ValueError(f"config line {lineno}: expected key = value")
        key, _, raw = line.partition("=")
        current[key.strip()] = _parse_value(raw)
    return root


def load_config_file(path: str) -> dict:
    with open(path, "rb") as f:
        data = f.read()
    try:
        import tomllib
        return tomllib.loads(data.decode("utf-8"))
    except ModuleNotFoundError:
        return _mini_toml(data.decode("utf-8"))


# ── layering ────────────────────────────────────────────────────────────────

def _merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


class ResolvedConfig:
    """The fully layered configuration for one digitizing run."""

    def __init__(self, fabric: str | None = None, config_path: str | None = None,
                 overrides: dict | None = None):
        layers = [{}]
        if fabric:
            if fabric not in FABRIC_PRESETS:
                raise ValueError(f"unknown fabric {fabric!r}; "
                                 f"choose from {sorted(FABRIC_PRESETS)}")
            layers.append(FABRIC_PRESETS[fabric])
        if config_path:
            layers.append(load_config_file(config_path))
        if overrides:
            layers.append(overrides)
        cfg: dict = {}
        for layer in layers:
            cfg = _merge(cfg, layer)
        self.raw = cfg
        self.fabric = fabric

    def _dataclass_from(self, cls, section: str, base=None, extra: dict | None = None):
        allowed = {f.name for f in fields(cls)}
        values = dict(self.raw.get(section, {}))
        if extra:
            values = _merge(values, extra)
        unknown = set(values) - allowed
        if unknown:
            raise ValueError(f"[{section}] unknown keys: {sorted(unknown)}")
        if section == "underlay" and "kinds" in values:
            values["kinds"] = tuple(values["kinds"])
        base_values = {f.name: getattr(base, f.name) for f in fields(cls)} if base else {}
        return cls(**{**base_values, **values})

    def properties(self, object_name: str | None = None) -> StitchProperties:
        underlay = self._dataclass_from(UnderlaySpec, "underlay")
        props = self._dataclass_from(StitchProperties, "props")
        props = props.with_(underlay=underlay)
        if object_name:
            per_object = self.raw.get("object", {}).get(object_name)
            if per_object:
                allowed = {f.name for f in fields(StitchProperties)}
                unknown = set(per_object) - allowed
                if unknown:
                    raise ValueError(f"[object.{object_name}] unknown keys: {sorted(unknown)}")
                props = props.with_(**per_object)
        return props

    def transit(self) -> TransitPolicy:
        return self._dataclass_from(TransitPolicy, "transit")

    def lineart(self) -> dict:
        cfg = dict(LINEART_DEFAULTS)
        cfg.update(self.raw.get("lineart", {}))
        unknown = set(cfg) - set(LINEART_DEFAULTS)
        if unknown:
            raise ValueError(f"[lineart] unknown keys: {sorted(unknown)}")
        return cfg

    def output(self) -> dict:
        cfg = dict(OUTPUT_DEFAULTS)
        cfg.update(self.raw.get("output", {}))
        return cfg

    def apply_object_overrides(self, objects) -> None:
        """Per-object-name overrides from [object.NAME] sections."""
        per_object = self.raw.get("object", {})
        if not per_object:
            return
        for o in objects:
            if o.name in per_object:
                o.props = o.props.with_(**per_object[o.name])
