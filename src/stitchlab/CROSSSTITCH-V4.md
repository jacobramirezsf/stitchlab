# Cross-Stitch V4: architecture, research, and roadmap

V4 is a new photo-to-cross-stitch engine (`lib/crossstitch4.ts`, with 14 tests) and the tool built on it (`tools/crossstitch4.tsx`, at slug `#crossstitch4`). It replaces the approach used by Cross-Stitch V2/V3 and by Photoreal's "Fine cross-stitch" method. Those tools are still in place and unchanged.

## 1. What V2/V3 and Photoreal did, and where they lose quality

| Stage | V2 / V3 | Photoreal "Fine cross-stitch" (V1 engine) | Problem |
|---|---|---|---|
| Downsample | Box mean of gamma-encoded sRGB, using 2×2 sub-cells | Same, one sample per cell | Averaging sRGB values darkens mixed cells: a black/white edge cell comes out at about 21% luminance instead of 50%. Edge cells also average into a third color that isn't in the photo. |
| Palette | k-means in CIELAB, then each center snapped to the nearest unused cone | k-means in RGB, then snapped | The error that matters (photo to the actual cone) is never optimized. Snapping is greedy, so the result depends on which cone gets taken first. |
| Light areas | A fixed luminance threshold leaves cells bare | Same (0.94) | Only works on white fabric. |
| Cleanup | One pass: a cell with no same-color 4-neighbor is relabeled | None. Dithering exists but is off in Photoreal. | Confetti in two-cell clusters survives. There is no control over the fidelity vs. sewability tradeoff. |
| Fractional stitches | 3/4 + 1/4 when exactly one sub-cell differs | None | Reasonable. Kept in V4, with a quarter-leg length guard. |
| Routing | V2 sews every diagonal as its own path, so the machine jumps before each one. V3 adds nearest-neighbor ordering, but still jumps per diagonal. | Serpentine runs that move from cell to cell along the top edge | V1/Photoreal sews a visible horizontal bar on every cell. V2/V3 leave a float on every leg. |

## 2. What V4 does

Each row lists the technique, its source, and where it lives in the code.

1. **Linear-light sampling and OKLab color.** Ottosson 2020. The "Edge sharpness" control pulls each cell toward the dominant color of a 2-means split of its pixels. That is a cheap stand-in for content-adaptive downscaling: the k-centroid mode in PixelOE, and Kopf et al. 2013. Code: `sampleCells`.
2. **Palette as facility location over the cone catalog.** A greedy build (within 1−1/e of optimal for the coverage form; Nemhauser, Wolsey & Fisher 1978), then PAM swaps, run on an OKLab histogram. It respects kept and banned cones, offers an optional CIEDE2000 metric (Sharma et al. 2005, checked against the published test pairs), and has a detail weight that keeps small high-contrast features from losing their cone. Code: `selectPalette`.
3. **Fabric is a free color, and fabric shows through.** Bare fabric is a label with the fabric's real color. Each cell's predicted color is a partitive mix, in linear light, of thread and fabric by a coverage factor. This is Murray–Davies, i.e. Yule–Nielsen with n = 1. Code: `buildLabels`, `mixOver`.
4. **Leg-level color.** A blended cross puts "/" in cone A and "\" in cone B. A half stitch is one leg over fabric. So k cones give up to k + k(k−1)/2 + k tones with no extra color changes. Blends are only built between nearby cones, by default within ΔE about 15–22 in OKLab ×100.
5. **One energy for the labeling.** The labels minimize
   `E(l) = Σ_p D(t_p, c(l_p)) + λ Σ_{p~q} w_pq [l_p ≠ l_q]`
   - w_pq = 0.25 + 0.75·exp(−Δ²/2σ²) is an edge-aware Potts weight, floored so speckle can still be cleaned up.
   - Texture mode uses error diffusion with the λ term applied causally ("confetti-aware diffusion"), attenuated and clamped, and optionally gated to flat areas, following libimagequant's dither map.
   - Clean mode uses ICM sweeps (Besag 1986).
   - A hard minimum-region merge follows.

   Boykov, Veksler & Zabih 2001 is the reference for Potts energy minimization. Code: `assignLabels`, `mergeSmallRegions`.
6. **Routing on a half-leg lattice.** The "/" and "\" legs of a cell join corners of opposite checkerboard parity, so a graph of whole diagonals always splits a solid region into two zigzags. Splitting each leg at the cell center (Ink/Stitch's cross-stitch model) fixes this. Code: `coneMasks`, `planStitches`. There are two routes:
   - **Fewest jumps:** Eulerian trails with Chinese-postman doubling, using the existing `lib/routing.planStrokes`. One stroke per 8-connected region.
   - **Even sheen:** per region, every "/" along anti-diagonal chains, then every "\" along main-diagonal chains, serpentine, linked by BFS through cell centers. Every cell's "\" leg is on top. This is a test.
   - Both routes take lock stitches, 1 or 2 passes per leg, and a sew-order option.
7. **UX.** Three presets (Clean chart, Balanced, Photoreal) set the granular controls, and any edit after that switches to "custom". There is also:
   - A smooth↔detailed slider and a texture slider.
   - Stitches across, stitch size, and the equivalent fabric count.
   - A tone↔hue priority control.
   - Fabric color.
   - Keep / ban / swap per cone. The rest of the palette re-fits around those choices.
   - An inspector with three views (chart with blend and fractional glyphs, the sampled photo, and a per-cell error map) plus stats: average error, single-stitch islands, strokes, and re-sewn half-legs.

### Measured (headless Chrome, synthetic 600×450 scene, 80 columns)

| Preset | Avg error (OKLab ×100) | Islands | Strokes | Half-legs re-sewn | Stitches | Est. sew time |
|---|---|---|---|---|---|---|
| Balanced (fewest jumps) | 7.2 | 0 | 125 | 4,966 | 24,666 | ~49 m |
| Clean chart (even sheen, 4-cell travel cap) | 8.7 | 0 | 130 | 2,339 | 22,059 | ~48 m |
| Photoreal | 6.9 | 383 | 423 | 7,404 | 28,170 | ~58 m |

On a solid 40×30 block, "fewest jumps" sews 1 stroke and re-sews 2.5% of half-legs. "Even sheen" sews 2 strokes and re-sews 5.7%. Building the chart takes 50–120 ms at 80–160 columns.

**A finding from building it.** With no cap on travel, "even sheen" mode re-sewed long straight diagonals, which read as visible lines (6,395 re-sewn half-legs on the scene). Capping hidden travel at 4 cells, and sewing loose quarter-legs nearest-first, removed the lines. That cut re-sewn half-legs by 63% and sew time by about 12 minutes, at the cost of more strokes (72 → 130), which the machine trims.

## 3. Research sweep

Citation confidence: **(V)** = verified online during the sweep. **(M)** = canonical work cited from memory; check volume and pages before citing. **(?)** = unverified.

**Gap in the literature.** No peer-reviewed paper was found on photo-to-cross-stitch quantization or on routing machine cross-stitch. The closest formal result is Biedl, Horton & López-Ortiz, "Cross-Stitching Using Little Thread," CCCG 2005 (V): minimizing thread is NP-hard in general, and linear-time for connected regions.

**Closest HCI and graphics work:**
- Leake & Daly, *ScrapMap*, UIST 2024 (V). Coloring from a constrained physical inventory.
- Hamdan, Voelker & Borchers, *Sketch&Stitch*, CHI 2018 (V).
- *MSEmbGAN*, IEEE TVCG 2024 (V). Learning-based photoreal embroidery rendering.
- PEmbroider, CMU 2020 (V). Software, no archival paper.
- Knitting compilers as a framing for fabrication-aware design tools: McCann et al. 2016 (M), Kaspar et al. 2019 (V).

**Methods V4 uses or should use next:**
- Puzicha et al., IEEE TIP 2000 (V), and Huang et al., IEEE TIP 2016 (V): joint quantization and dithering.
- Pang et al., SIGGRAPH 2008 (V), and Chang, Alain & Ostromoukhov, SIGGRAPH Asia 2009 (V): structure-aware halftoning.
- Ostromoukhov, SIGGRAPH 2001 (M), and Ulichney, void-and-cluster, 1993 (M).
- Kopf et al. 2013 (M), Gerstner et al. 2012 (M), Weber et al. DPID 2016 (M): structure-preserving downscaling.
- Delong et al., label costs, IJCV 2012 (V): automatic palette size.
- Edmonds & Johnson 1973 (M): Chinese postman.
- Zhang & Wandell, S-CIELAB, 1997 (M): evaluation metric.

**GitHub.** Licenses decide what can be reused.

| Project | License | What to take |
|---|---|---|
| Ink/Stitch: `lib/stitches/cross_stitch.py`, `utils/cross_stitch.py` | **GPL-3**. Re-implement from the description only. | Center-node cross graph; splicing per-cross loops into an Eulerian cycle with "good" / "bad" entry corners; expand ≈ 0.2 mm; coverage-% threshold; trim-after. |
| pyembroidery: `EmbEncoder.py` | MIT | Encoder state machine: max-stitch/jump splitting, tie-on/tie-off after trims and color changes, explicit trims. Our DST writer has no trims. |
| heatstitch | MIT, TypeScript | DST/PES/JEF/EXP/VP3 writers; saliency-weighted Lab k-means; graphic-palette detection for logos. |
| image-q | MIT, TypeScript | CIEDE2000; Wu quantizer; Riemersma (Hilbert-curve) dithering. |
| quantette | MIT/Apache, Rust | Quantization done entirely in OKLab; Wu-seeded k-means; dither factor below 1. |
| libimagequant | GPL-3 | Ideas only: dither map, error clamp, importance map. |
| PixelOE | Apache-2.0 | k-centroid downscale; contrast-aware outline expansion so 1-cell features survive. |
| go-cross-stitch, zigzag (Apache, Rust), libembroidery (zlib) | permissive | Banned-thread lists, hoop and stitch checks, format details. |

No open-source tool does credible confetti cleanup or two-cone blends. V4's handling of both is new.

## 4. Roadmap (highest leverage first)

1. **Point Photoreal's "Fine cross-stitch" at the V4 engine.** This keeps its detail sweep, GIF, and video export. Today it still uses V1 with dithering off.
2. **Stitch a calibration swatch card on the Makery machines.** Sew solids, blend pairs, and half stitches on white, natural, and black fabric. Scan them and fit coverage and Yule–Nielsen n. This replaces the guessed 0.85 / 0.55, and it doubles as a research dataset.
3. **Blend-aware palette selection, plus label costs (Delong 2012).** Today's selection ignores the tones blends can provide, and k is fixed.
4. **Better inter-region order and explicit trims.** Add 2-opt over region order. Emit trims and ties using pyembroidery's encoder model, since today the machine infers trims from jumps.
5. **Blue-noise / ordered dither option.** Dither patterns would then stay put while you tune.
6. **DPID downscale plus face weighting**, with a browser face detector.
7. **Move the heavy work to a web worker.** "Fewest jumps" combined with heavy dither takes about 1.8 s because of greedy odd-vertex pairing.
8. **Brushes for detail and smoothness.** Paint "protect detail here" / "simplify here" locally.

## 5. Possible papers

- **UIST: fabrication-cost-aware quantization.** One objective covering both appearance (S-CIELAB on the predicted stitch-out) and machine cost (color changes, trims, jumps, stitch count). Show a Pareto frontier of fidelity vs. sew time and validate with timed stitch-outs. V4's smoothness slider already traces this curve.
- **SCF / CHI late-breaking work: measured "embroidery primaries."** The swatch card above: blend-pair gamut expansion, published as a dataset.
- **SCF poster or short theory paper: routing on the half-leg lattice.** The parity split, the diagonal-chain method that keeps the top leg consistent, and the measured travel/jump tradeoff, benchmarked against Ink/Stitch.
- **CHI: mixed-initiative detail painting**, with a live sew-time estimate.

## Known limits

- Status is **candidate**: nothing has been stitched on fabric yet.
- In "even sheen" mode, travel between chains sometimes crosses a cell after its "\" leg is already sewn, so that cell's top leg isn't guaranteed. The test checks the full-leg order only.
- Coverage and blend weights are uncalibrated estimates.
- The dev bench (`/stitchlab?dev`) doesn't size the editor frame, so the controls overflow there. Use `/stitchlab#crossstitch4`.
