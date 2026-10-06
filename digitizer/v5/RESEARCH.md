# V5 Research: How Commercial Digitizers Actually Work

*Phase 0 deliverable. Sources: patents (Pulse, SoftSight/Vistaprint family, Brother),
Ink/Stitch source (GPL — studied for algorithms, reimplemented from understanding),
Embrilliance's bundled help (local install, legitimately readable docs + presets),
Wilcom/Hatch public documentation, industry practice references. Academic scan
included; conclusion: patents + Ink/Stitch are the real literature; academia is
mostly GAN/rendering work (MSEmbGAN etc.), not stitch planning.*

---

## 1. The universal architecture: objects, then compilation

Every serious tool — Pulse (US5343401), Wilcom, Embrilliance StitchArtist,
Ink/Stitch — separates **design objects** from **stitch generation**:

```
artwork → [frontend: manual digitizing or auto-vectorization]
        → OBJECT MODEL (runs, columns, fills + properties)
        → [sequencer: order objects, plan connections]
        → [compiler: per-object underlay → cover stitches → ties]
        → stitch plan → format encoder (DST/PES/…)
```

Pulse's hierarchy: **points → segments** (points sharing a stitch type) **→
groups** (auto-grouped by color or long jump). Objects carry *properties*
(density, length, underlay, compensation), and stitches are regenerated from
objects at any scale — the resize-without-redigitizing insight that defined
Wilcom's early patents. **V4's mistake to avoid repeating: it goes pixels →
stitches directly with no object layer.**

Object types across platforms (union):

| Family | Variants seen in the wild |
|---|---|
| Line | single run, double run (there-and-back), bean ×3..×9, motif run, back/stem/chain (heirloom), "boot" (parallel runs — validates V4's 3-lane) |
| Column | satin (two rails + inclination rungs), curved satin, satin border (centerline+width, "much like a sewing machine"), split satin, feathered satin |
| Region | tatami/ceeded fill (with holes = "complex fill"), curved/contour fill, motif fill, stipple/meander, geflect (outline-based) |
| Special | applique (position → material → topstitch steps with machine stops), manual stitches |

## 2. Auto-digitizing from images (SoftSight patent family, US6804573 → US9200397)

The canonical raster pipeline, refined over ~15 years of continuations:

1. **Segment** with edge-preserving smoothing + region growing; kill regions <6 px.
2. **Chain-code** contours in one raster scan while computing a **(3,4) chamfer
   distance transform**; extract skeleton simultaneously.
3. **Thin vs thick classification** per object from skeleton-pixel DT stats
   (max, mean, σ against thresholds). Thin → satin strokes; thick → fills.
4. **Thin path**: polygonal contour fitting (triangular filter), endpoint/junction
   anchor detection (extend skeleton ends by local thickness, snap to contour
   vertices, prefer acute corners <30°), serif merging, stroke reconstruction
   across junctions by energy minimization, **stroke normals** (the satin rungs)
   extracted as opposite-contour vectors, normal smoothing, split at bends <45°.
5. **Thick path**: test **16 candidate stitch angles**, pick the one producing the
   fewest scanline **fragments**; fragments sewn in an order minimizing trims,
   traveling along computed mid-lines.

V4 already implements a cousin of (2)–(4) (medial axis + chain graph + Euler
trails). What it lacks: the thin/thick decision feeding an *object* model, stroke
normals for satin, and the 16-angle fragment-minimizing fill angle search.

## 3. Ink/Stitch algorithms worth reimplementing (from source study)

- **running_stitch.py** — even running stitch parameterized by `(stitch_length,
  tolerance)`: path is split into curves (`path_to_curves`), stitches placed so
  chord deviation stays within tolerance (same idea as V4's adaptive walk, plus
  optional length jitter for a hand look). `bean_stitch(stitches, repeats)` wraps
  any run. `zigzag_stitch()` takes **pull_compensation as a parameter** at the
  stitch level.
- **satin_column** — two rails + rungs model; rungs define inclination; density
  is advance-per-zig; handles variable width; short-stitch on tight inner curves.
- **auto_satin.py** — satins become graph edges (`SatinSegment` with fractional
  start/end so a column can be *split* mid-way), plus `RunningStitch` edges and
  `JumpStitch` edges with `should_trim()`; routed via **autoroute.find_path**:
  Eulerize (pair odd nodes via shortest jumps), walk every edge; satins traversed
  "backwards" become **hidden center-line travel runs under the satin that will
  stitch later** — the single biggest trim-killer. V5 must generalize this:
  travel under any object that stitches after you.
- **fill.py (tatami)** — intersect region with a rotated **grating** of rows
  (`row_spacing`, `angle`), group intersections into runs (`pull_runs`), stitch
  rows serpentine with **staggers**: needle penetrations offset row-to-row by
  `stitch_length/staggers` so holes don't align (Pulse: offsets as % of stitch
  length, incl. random).
- **contour_fill.py** — `offset_polygon()` → **tree of isocontours** (shapely
  buffer inward until exhausted, holes handled by polygon/hole matching); route
  inner-to-outer recursively with nearest-entry-point thresholds; optional
  self-crossing avoidance.
- **meander_fill.py** — grid graph inside shape → connected → initial path →
  stochastic edge replacement to meander; zigzag optionally overlaid.
- Fill variants in tree: tatami, contour, guided, meander, circular, tartan,
  linear-gradient, cross-stitch — confirms fills are **one engine + row/path
  generators**, not separate systems.

## 4. Parameter standards (numbers to bake into presets)

From Embrilliance help (local), Hatch/Wilcom docs, practice references:

| Parameter | Standard | Range / notes |
|---|---|---|
| Satin density (advance) | **0.40mm** normal | 0.3–2.0mm range (Embrilliance); 0.38–0.45 typical quality band |
| Satin width | min **1.5mm** (thread breaks below), sweet spot 2–7mm | split satin ≥ ~8mm; 12.1mm machine delta = hard cap |
| Tatami density | "4-point" (**0.4mm**) full coverage | 5-point+ for softness; two half-density fills at crossed angles = more stable, less displacement |
| Tatami stagger | offset % of stitch length, e.g. 25% | random offset available; fill stitch length ~3–4mm |
| Pull compensation | start **0.17–0.20mm** | 0–1.0mm range; knits/caps higher; applied perpendicular to stitch direction (stitches pull along axis, push perpendicular) |
| Underlay by column width | <3mm: **center run**; 3–7mm: **edge run** (inset **0.8mm** ≈ needle width) **+ zigzag**; wide/fills: **double zigzag + edge run** or tatami underlay at counter-angle | underlay angle runs counter to cover |
| Run stitch | 2–2.5mm; ≥1mm min | "chord gapping" (Embrilliance's term) = shorten on curves — exactly V4's tolerance walk |
| Bean | ×3 standard; up to ×9 for heavy hand-sewn look | longer stitch length at high repeats |
| Transits (Embrilliance model) | gap ≤ ~4.5mm: two nested 1.5mm runs, **no trim**; beyond: tie → trim → tie | many machines won't trim <5mm anyway; commercial shops nest, hobbyists trim |
| Ties | auto, direction-aware ("innocuous angle"), few stitches fwd/back | count on underlay to reinforce; modes: none/small-run/triangle |
| Fill travel | default: **under unsewn rows**; low-density fills: **edge travel** | exit bead at region ends, not middle (coverage line artifact) |
| Applique | position run → stop → material tack → stop → cover (satin border / blanket / E-stitch) | pre-cut flag locks size |
| Fabric logic | stable (denim/twill/canvas): standard underlay; stretchy (knit): stronger underlay (zigzag+edge run), more pull comp; caps: stitch bottom-up, more comp | Wilcom "Auto Fabric" = presets that set density+underlay+comp together |

## 5. Decisions for V5 (what we build, mapped to findings)

1. **Object model over pyembroidery** (pyembroidery stays as the format encoder
   only — it's I/O, not a model). `StitchObject` subclasses: `RunPath`,
   `SatinColumn` (rails+rungs), `FillRegion` (shapely polygon w/ holes),
   `MotifRun`, `Applique`, `ManualStitch`. Properties object per node:
   density, underlay spec, pull comp, angle, stagger, ties, entry/exit.
2. **Compiler per object**: pull-comp geometry transform → underlay pass(es) →
   cover stitches → tie policy; then a global **sequencer** (nearest-neighbor +
   2-opt over entry/exit points; exact for small N) and **transit planner**
   implementing the Embrilliance 3-tier + Ink/Stitch's *travel-under-later-objects*.
3. **Frontends**: (a) line-art = V4's medial-axis/Euler pipeline emitting
   RunPath/SatinColumn objects (stroke normals from the DT for auto-satin);
   (b) clean vector fills via shapely directly (no rasterization);
   (c) raster auto-digitize per the SoftSight recipe: quantize → segment →
   thin/thick classify → objects per color block, 16-angle fill search.
4. **Fills**: one engine, pluggable row/path generators (tatami+stagger presets,
   contour via isocontour tree, spiral, motif stamp). Angle per-object.
5. **Presets**: TOML; layering global → fabric → design → object. Fabrics: twill/
   denim (the jackets), knit, canvas, cap, with the Section-4 numbers.
6. **Validation**: read-back, delta limits, density ceiling map, tie presence,
   plus the V4-vs-V5 regression diff on the 22 TLS designs.

## 6. Sources

- Pulse Microsystems, [US5343401 "Embroidery design system"](https://patents.google.com/patent/US5343401A/en)
- SoftSight/Vistaprint auto-digitizing family: [US6804573](https://patents.google.com/patent/US6804573) (+ continuations US6836695, US6947808, US7016756/7, US7587256, US8219238), [US9200397](https://patents.google.com/patent/US9200397)
- Brother: [US6356648 "Embroidery data processor"](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/6356648), [US5563795](https://patents.google.com/patent/US5563795)
- Pulse: [US5771173 chenille/concentric fill](https://patents.google.com/patent/US5771173), [US6968255 stippling](https://patents.google.com/patent/US6968255)
- [Ink/Stitch source](https://github.com/inkstitch/inkstitch) (GPL; algorithms studied: `lib/stitches/{running_stitch,auto_satin,fill,contour_fill,meander_fill}.py`, `lib/stitches/utils/autoroute.py`)
- Embrilliance bundled help 1.176 (local install): Stitch Properties, Run Objects, Fill Objects, Fill Coverage, Satin Border, Ties and Transits, Applique Objects
- Wilcom docs: [Underlay & Pull Compensation](https://docs.wilcom.com/embroiderystudio/e4/en/MainHelp/Quality/underlays/Underlay_Pull_Compensation.htm), [Tatami underlay](https://docs.wilcom.com/embroiderystudio/26/en/OnlineHelp/Quality/underlays/Tatami_underlay_settings.htm), [Auto-digitizing](https://docs.wilcom.com/embroiderystudio/27/en/OnlineHelp/Automatic/automatic/automatic-10.htm), [push/pull blog](https://wilcom.com/resources/blog/push-and-pull-compensation)
- Practice: [digitizing cheat sheet (Hooping Station)](https://hoopingstation.com/blogs/articles/the-ultimate-embroidery-digitizing-cheat-sheet-density-underlay-pull-comp-and-objects-explained-for-real-stitch-out-results), [Hatch redwork](https://hatch.embroideryhelp.net/v3/en/OnlineHelp/Digitizing/digitize_advanced/Create_redwork.htm)
- Academic scan: mostly generative/rendering (e.g. MSEmbGAN 2024, embroidery style transfer); stitch planning literature lives in the patents above.
