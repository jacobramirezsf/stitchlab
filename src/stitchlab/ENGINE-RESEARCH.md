# Engine Research — strengthening the seven engines

*Companion to [CREATIVE-SYSTEM.md](./CREATIVE-SYSTEM.md). Status: in progress —
experimental results below are measured against the real pipeline; the literature
review (adjacent-field research memos) is being compiled and will extend this
document.*

Harnesses: `scripts/research-exp1.ts` (cross-stitch color fidelity ladder),
`scripts/research-exp2.ts` (continuous-line tour quality). Both bundle with esbuild
and run in node against the production engine code — no forks, no mocks. Test images:
the flowertests set plus the "more ref images to use" set (posters, ink drawings,
photos) in the baysidesf stitch-outs folder.

## Experiment 1 — cross-stitch color fidelity

Five variants, four images, two grid sizes (72 and 140 stitches across), k=8 cones.
Metrics: mean ΔE in OKLab between each cell's assigned cone and the cell's true
average color ("hard", sharpness of local match), and the same after a 2-cell blur of
both sides ("soft", how right the image reads at a glance — the metric dithering is
supposed to win).

| Variant | Hard ΔE (lower better) | Soft ΔE (lower better) |
|---|---|---|
| **A — production V1** (RGB k-means → cone snap, no dither) | **best everywhere** (3.6–5.2) | 2.3–4.2 |
| **B — V1 + its own Ostromoukhov dither** (exists, off by default) | slightly worse (4.5–6.0) | **best or near-best everywhere** (1.2–3.9) |
| C — OKLab `threadPalette` assignment | much worse (5.7–12.1) | worse |
| D — C + Floyd–Steinberg in OKLab | worst hard | good soft, still loses to B |
| E — C + edge-aware (bilateral) cell averaging | ≈ C | ≈ C |

**Findings:**

1. **The V1 quantizer is genuinely good.** Image-specific RGB k-means with
   D²-seeded init beats a generic OKLab palette assignment by a wide margin. The
   engine we ship is the strongest of the five tested — worth knowing before
   "improving" it.
2. **The biggest available win is already in the codebase, switched off.** V1's
   Ostromoukhov error-diffusion dither improves soft (perceived) fidelity by
   **25–45% on every image at both grid sizes**, for a modest hard-ΔE cost. It's a
   `useState(false)` in the cross-stitch tool and isn't exposed in the Workspace's
   cross-stitch mode or Photoreal at all. Promoting it (default-on for photographic
   sources, or at least exposed everywhere) is a measured, cheap upgrade.
3. **`threadPalette`'s `minSeparation = 0.06` merge is a fidelity tax.** It
   aggressively merges clusters, effectively shrinking k below what the user asked
   for. Tools built on it inherit the loss. Worth a tuning pass (smaller separation,
   or merge only when cones are literally identical).
4. **Honest negative result:** bilateral edge-aware cell averaging (my "beyond the
   frontier" candidate) did not measurably help at these grid sizes on these images.
   Parked unless the literature suggests a better formulation.

## Experiment 2 — continuous-line (portrait) tour quality

Production `stipplePoints + nnTour` (nearest-neighbor + 200k random 2-opt) vs a 4×
2-opt budget vs production + a budgeted **Or-opt** pass (segment relocation, ≤1.5s).
Metric: total tour length — shorter means less redundant travel, calmer drawing,
less thread.

| Image (points) | Production | +4× 2-opt | +Or-opt (total time) |
|---|---|---|---|
| portrait sketch (1500) | 15,488 | −3.4% | **−5.4%** (122 ms) |
| portrait sketch (3000) | 22,532 | −2.0% | **−5.2%** (193 ms) |
| chihuahua ink (1500) | 10,778 | −5.0% | **−5.6%** (104 ms) |
| chihuahua ink (3000) | 15,160 | −2.7% | **−4.9%** (228 ms) |
| foxglove (1500) | 24,845 | −4.7% | **−6.1%** (105 ms) |
| foxglove (3000) | 34,465 | −2.2% | **−4.2%** (265 ms) |

**Finding:** a windowed Or-opt pass after the existing tour gives a consistent
**4–6% shorter line in ~100–270 ms** — interactive-budget compatible. Small but
real, and it compounds with the 2-opt already there. Candidate for landing directly
in `nnTour` (or as an optional refinement pass) in portrait, workspace photo layers,
and the Animator's portrait mode simultaneously — one engine, many tools.

## Experiment 3 — routing: linemerge + endpoint-aware ordering ✅ LANDED

`scripts/research-exp3.ts`. Real engine output (block patterns, Hershey lettering),
three treatments: generation order (how most tools sewed), the greedy
`orderStrokes`, and vpype-style **linemerge (0.5 mm, with reversal) + greedy
nearest-endpoint sort with reversal + windowed Or-opt**:

| Set | Strokes → after merge | Inter-stroke travel | Trim-length gaps (>3 mm) |
|---|---|---|---|
| truchet | 162 → **25** | 3,476 → **629 mm** (−82%) | 161 → **24** (−85%) |
| topo contours | 404 → **27** | 8,960 → **548 mm** (−94%) | 371 → **26** (−93%) |
| moiré (disjoint loops) | 74 → 74 | 9,753 → **336 mm** (−97%) | 59 (merge can't help closed loops) |
| honeycomb | 68 → 68 | 2,068 → **1,401 mm** (−32%) | 67 |
| fractal tree | 255 → **128** | 1,430 → **749 mm** (−48%) | 127 → **78** |
| lettering | 34 → **24** | 332 → **159 mm** (−52%) | 31 → **20** |

Reading: sorting kills travel; **only merging kills trims**, and connected
geometry (mazes, contours, trees, lettering) merges spectacularly. Landed as
`routeStrokes()` in `lib/generators.ts`, wired into the blockmini factory (23
tools) and the Workspace compositor (generated layers only — imported designs
keep their original stitch order). Geometry is unchanged; only connectivity and
sew order improve.

## Experiment 4 — Gerstner-style joint cell+palette optimization

`scripts/research-exp4.ts`. SLIC-constrained-to-grid: input pixels choose among
neighboring cells by joint OKLab+space distance, cell colors and the cone
palette refine each other. vs production V1 on 4 images at 72/140 cells:
soft ΔE improves in 6/8 cases (TWA poster @140: 5.84 → 4.34); hard ΔE is
usually slightly worse — expected, since the metric compares against box
averages, which structurally favors V1. **The visual verdict is the real
result:** the Gerstner grids are clearly crisper (lettering, windows, saturated
color commitment — the Apes poster keeps its yellows/pinks where V1 muddies to
brown), but palette allocation sometimes trades a hue (teal → purple on the TWA
poster). **E4b measured:** SLIC cells + V1's palette does NOT beat full Gerstner —
it inherits V1's muddier palette (TWA @140 soft dE 5.93 vs 4.34). Full
Gerstner (joint palette) stays the lead variant; the open issue is hue
allocation in k-means (weighting by saturation/area is the next idea). Candidate for a "Crisp" toggle in the
cross-stitch tools once that combo is measured.

## Experiment 5 — hedcut dots + engraving dashes (new interpretation modes)

`scripts/research-exp5.ts`, built on the production edge-tangent flow
(`lib/lineart.ts`). Two renderings, both first-pass successes on the portrait
test image:
- **Hedcut**: dots with anisotropic spacing (tight along flow, wide across) so
  chains ridge along features — the WSJ look, immediately recognizable. ~7k
  dots at 760 px. Creative controls that already exist as parameters: dot
  scale, chain tightness, tone gamma, background scatter.
- **Engraving**: short streamlines along the flow, thickness by tone, layered
  occupancy. After one tune (suppress light regions, len 16) it reads as an
  ink/woodcut portrait with real stroke character.
Both are path-native (dots = future knot/tack stitches; dashes = running
stitch), so the stitch-file route is straightforward if the look earns a tool.
These are exactly the "operation on a photo layer" candidates the
creative-system doc anticipated.

## Literature review (compiled Aug 10, 2026)

Sources marked **[v]** were verified via web search this session; **[r]** are
recalled from training and should be re-verified before citing externally.

### A. Image → grid (cross-stitch quantizer)

- **Gerstner, DeCarlo, Alexa et al., "Pixelated Image Abstraction" (NPAR 2012)
  [v]** — jointly optimizes a set of superpixels *and* the reduced palette:
  superpixels start on a regular grid, then pixels↔superpixels↔palette assignments
  iterate together. This is the principled version of what our E1 variant E tried
  naively — cells align themselves to image structure instead of being fixed boxes.
  TS cost: moderate (a few hundred lines, iterative, no ML). Expected payoff:
  largest at coarse grids (60–140 cells), exactly where cross-stitch lives.
  **This is the strongest candidate for the next fidelity jump.**
- **Kopf et al., content-adaptive image downscaling (2013) [v-adjacent]** — adaptive
  bilateral/mean-shift kernels that preserve high-frequency features during extreme
  downscaling. Confirms the *joint-optimization* formulation is what works (our
  one-shot bilateral averaging measurably didn't).
- **Öztireli & Gross, perceptually based downscaling (SIGGRAPH Asia 2015) [r]** —
  optimizes a perceptual (SSIM-like) objective for extreme downscaling.
- **Pang, Qu, Wong et al., "Structure-Aware Halftoning" (SIGGRAPH 2008) [v]** —
  halftoning that preserves image structure/texture via optimization, not just tone.
  The conceptual upgrade path for our dithering: structure-aware assignment rather
  than pure error diffusion.
- **"Image Stylization for Thread Art via Color Quantization and Sparse Modeling"
  (Springer 2018) [v]** — academic treatment of quantizing against a *fixed physical
  thread library* — literally our problem (126 Madeira cones). Worth a close read
  for the cone-selection objective.
- Already implemented and validated: Ostromoukhov-style error diffusion (E1's
  variant B — the measured 25–45% soft-fidelity win, currently off by default).

### B. Points and lines (portrait / stipple / string art)

- **Secord, "Weighted Voronoi Stippling" (NPAR 2002) [v]** — iterative relaxation
  of a *weighted* Voronoi diagram (density-weighted Lloyd). We do importance
  sampling + optional plain Lloyd; full weighted-centroid relaxation gives the
  characteristic even, tone-true stipple field.
- **Balzer et al., capacity-constrained point distributions (SIGGRAPH 2009) [r]** —
  eliminates the clustering artifacts Lloyd leaves; slower, quality ceiling.
- **Kaplan & Bosch, "TSP Art" (Bridges 2005) [v]** — the canonical continuous-line
  formulation; our nnTour + 2-opt (+ the E2-validated Or-opt) is squarely in this
  family. Their observation: tour *quality* directly reads as drawing calm.
- **Kim et al., "Automated Hedcut Illustration Using Isophotes" [v]** — WSJ-style
  portraits: stipple dots placed *along feature flow / isophote lines*, not just by
  density. We already compute edge-tangent flow in `lib/lineart.ts` — the hard
  ingredient exists.
- **"Image-based Portrait Engraving" (arXiv 2020) [v]** — engraving lines following
  feature directions with thickness modulation; pairs with our orientation field.
- **Birsak et al., "String Art: Towards Computational Fabrication of String
  Images" (Eurographics 2018) [v]** — greedy chord selection scored by actual error
  reduction against the target, plus an iterative *removal* pass and non-opaque
  string handling. Our stringart tool can adopt the error-driven objective and the
  removal refinement directly.
- **Halftoning with minimum spanning trees / maze-like images (Computers &
  Graphics 2009) [v]** — MST-based halftones that read as solvable maze/labyrinth
  images; connects our maze engine to image interpretation.

### C. Fills and toolpaths (tatami / fermat / routing)

- **Zhao et al., "Connected Fermat Spirals for Layered Fabrication" (SIGGRAPH
  2016) [v]** — decompose any 2D region into sub-regions each fillable by one
  Fermat spiral, then *join them into a single globally continuous low-curvature
  curve*. We already ship a Fermat tool; the paper's real contribution is the
  decomposition + joining, which for embroidery means **fills with near-zero trims
  and jumps**. Directly transferable; the algorithm is geometric, no ML.
- **vpype's linemerge/linesort [v]** — the plotter community's standard pass:
  merge strokes whose endpoints are within tolerance (with reversal), then greedy +
  optional 2-opt ordering to minimize pen-up travel. No published percentages —
  we should measure on our own stroke tools (redwork, blackwork, workspace
  compositions), where the equivalent of pen-up is jumps/trims.
- **CNC pocketing literature (contour-parallel vs direction-parallel) [r]** —
  decades of results on continuity, corner handling, and hybrid fills; the vocabulary
  maps cleanly onto tatami (direction-parallel) vs outline-following fills.

### D. Rendering realism

- **"Embroidery Modeling and Rendering" (Chen et al., 2012) [v]** and **Cui et
  al., "Image-based embroidery modeling and rendering" (CAVW 2017) [v]** — build a
  3D stitch primitive (thread bundle) and light it (Phong); stitch patterns derive
  from the primitive. **Parametric texture mapping for embroidery rendering (US
  patent) [v]** — pre-rendered stitch sprites parameterized by start/end/color:
  fast and "highly realistic." The browser-feasible translation: **pre-rendered
  thread sprites at angle buckets with a twist texture and per-stitch normal
  shading** — canvas2d-compatible, no WebGL required for the next fidelity step.
- **CNN embroidery style rendering (IJPRAI 2020) [v]** and diffusion-based
  embroidery stylization (npj Heritage Science 2026) [v] — the neural route:
  photoreal *pictures* of embroidery, but no stitch files. Relevant to Photoreal's
  "intentionally beyond physical constraints" lane only.

## New interpretation modes worth building

Ranked by (distinctiveness × engine-reuse × stitchability). Each names the engines
it reuses — per the creative-system principle, every one should land as a
capability the Workspace can eventually apply, not just a menu item.

1. **Hedcut portrait** — stipples/French-knot dots placed along the ETF feature
   flow (lineart.ts) with tone-driven density. The WSJ look is iconic, unclaimed in
   embroidery, and both ingredients exist. (New primitive: knot/dot stitch cluster.)
2. **Engraving / banknote portrait** — parallel wavy line sets following the
   orientation field, thickness-modulated by tone (orientation.ts + halftone
   engine). Reads spectacular in thread; running stitch only — very stitchable.
3. **Maze-halftone** — MST-based maze whose corridors carry the image tone (maze
   engine + quantizer). A picture that is literally a solvable labyrinth.
4. **Connected-Fermat fill mode** — image regions filled with globally continuous
   Fermat spirals (fermat + digitizer stack + Zhao decomposition): near-trimless
   color-field interpretation; also upgrades the auto-digitizers' fill quality.
5. **String-art upgrade** — Birsak error-driven chord selection + removal pass +
   multi-color layers in the existing stringart tool.
6. **Text-fill portrait** — tone rendered by packing Hershey lettering strokes
   (lettering engine): typewriter-art/calligram lane, name-in-the-portrait merch.
7. **Appliqué planner** — segment an image into a few flat fabric regions + satin
   borders (quantizer + satin + digitizer): a new *physical* output genre (fabric +
   stitch), strong for jackets and backs.
8. **Sashiko photo mode** — tone → density/variant of sashiko grid patterns
   (sashiko engine + quantizer): subtle, textile-native, very stitchable.

## Ranked experiment queue (next round)

1. **E3 — linemerge + linesort pass** over redwork/blackwork/workspace outputs;
   metrics: jump count, trim count, travel mm. Expected: the largest physical-
   quality win available (fewer trims = cleaner backs, faster sews). [small]
2. **E4 — Gerstner-style joint superpixel+cone optimization** vs V1 on the E1
   image set; metrics: hard/soft ΔE + an edge-alignment score. [medium]
3. **E5 — hedcut/engraving prototype** on portrait images using existing ETF +
   orientation fields; judged visually against hedcut references. [medium]
4. **E6 — connected-Fermat fill** on digitizer regions; metrics: trims, jumps,
   direction coherence vs tatami. [medium-large]
5. **E7 — sprite-based thread rendering** vs current gradient quads, side-by-side
   against photos of real stitch-outs (we have them). [medium]
6. **E8 — weighted-centroid (Secord) relaxation** in stipplePoints; metric: tone
   uniformity (Voronoi cell capacity variance). [small]

Findings land here with numbers before anything ships in the engines.

## New-tools round (Aug 11, 2026) — E6–E9 → three shipped tools

- **E6 maze-halftone** (`research-exp6.ts`): tone-driven quadtree sites + MST
  with darkness-weighted costs. After fixing a NaN-poisoning bug in fractional
  quadtree sampling (worth remembering: fractional indices into Float32Array
  fail silently), the portrait reads clearly as one connected labyrinth.
  **Shipped as Image Maze** (`tools/imagemaze.tsx`) — routeStrokes merges the
  tree into long corridors, so it sews with almost no trims.
- **E7 reaction-diffusion on images** (`research-exp7.ts`): Gray-Scott with
  feed rate mapped from tone (dark → worm regimes) and ETF-anisotropic
  Laplacian. Strong organic look on the first run. **Shipped as Turing Skin**
  (`tools/turing.tsx`) — B field thinned + traced into running-stitch worms;
  Character slider morphs spots↔worms, Comb bends growth along the photo.
- **E5+E9 → Flow Ink** (`tools/flowink.tsx`): hedcut dots (anisotropic
  dart-throwing; sew as tack clusters), engraving strokes, and Jobard–Lefer
  evenly-spaced contours, all over the shared ETF. Contours got a paper-white
  seed suppression after the prototype showed background noise.
- **E8 differential growth** (`research-exp8.ts`): PARKED. Two lessons
  recorded: the split threshold must sit below the repulsion equilibrium
  spacing or the loop never grows; and the naive O(n²)-ish relaxation explodes
  past ~10k nodes. Needs a proper spatial-hash reuse + iteration budget before
  it can be a tool. The look (one closed line filling a silhouette) is still
  wanted.

All three tools: PreviewRail shells, 60k-stitch guards, registry + sections
("From a photo") + preview thumbnails. Algorithms are the harness-validated
code adapted to mm output — the harness PNGs are the visual reference.
