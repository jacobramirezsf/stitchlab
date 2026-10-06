// Stitch Lab tool: Cross-Stitch - a photo becomes counted cross-stitch sewn
// in actual Madeira Polyneon cones from the studio wall. The image is averaged
// into a cell grid, k-means clustered (seeded k-means++ init), and every
// cluster snaps to the nearest real cone the studio stocks - so the "Cones to
// pull" panel is a literal packing list. Optional Ostromoukhov error-diffusion dithering
// speckles neighboring cones together for smooth gradients, and an optional
// backstitch pass traces every color boundary in a doubled running stitch,
// sewn last. Crosses sew as serpentine runs: consecutive same-color cells
// chain into one continuous path (bl→tr→tl→br per cell, mirrored on odd rows)
// so the needle walks straight into the next X without a jump.

import { useMemo, useState, type ChangeEvent } from "react";
import { ostromoukhovWeights } from "./data/ostromoukhov";
import { THREADS } from "../../data/threads";
import { nearestThreads } from "../lib/threadMatch";
import { pathGroupsToStitches, type PathMm } from "../lib/generators";
import {
  ToolLayout,
  SectionBox,
  RangeRow,
  ModeButtons,
  ThreadSelect,
  ThreadRow,
  Warning,
  PreviewRail,
  buildDesign,
  LABEL,
  DropZone,
  SizeField,
} from "./shared";

// ─── Pure logic (node-testable, no DOM) ──────────────────────────────────

export type PaletteEntry = { hex: string; code: string; name: string };

function lum01(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function rgbToHex(r: number, g: number, b: number): string {
  const n = (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
  return `#${n.toString(16).padStart(6, "0")}`;
}

function hexChannels(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Deterministic 32-bit PRNG (mulberry32). Same seed → same clustering. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Average an image into a cols × rows cell grid (rows keeps aspect), k-means
 * the cell colors (seeded k-means++ init, 12 iterations), then snap each
 * centroid to a distinct real Polyneon cone. Cells lighter than
 * `lightThreshold` become -1 (bare fabric) when `skipLight` is on. `rgb` may
 * be RGBA (canvas ImageData) or packed RGB. With `dither` on, cells are
 * assigned in serpentine order with Ostromoukhov error diffusion against
 * the snapped cone palette (redmean distance), so a few cones can carry a
 * smooth gradient. Fully deterministic either way.
 */
export function quantizeToThreads(
  img: { w: number; h: number; rgb: Uint8ClampedArray },
  opts: {
    cols: number;
    k: number;
    skipLight?: boolean;
    lightThreshold?: number;
    dither?: boolean;
  },
): { cols: number; rows: number; grid: Int16Array; palette: PaletteEntry[] } {
  const { w, h, rgb } = img;
  const cols = Math.max(1, Math.round(opts.cols));
  if (w < 1 || h < 1) return { cols, rows: 0, grid: new Int16Array(0), palette: [] };
  const rows = Math.max(1, Math.round((cols * h) / w));
  const skipLight = opts.skipLight ?? true;
  const lightThreshold = opts.lightThreshold ?? 0.92;
  const stride = rgb.length >= w * h * 4 ? 4 : 3;

  // Cell color = average RGB of the cell's pixel block.
  const n = cols * rows;
  const cr = new Float64Array(n);
  const cg = new Float64Array(n);
  const cb = new Float64Array(n);
  const grid = new Int16Array(n).fill(-1);
  const active: number[] = [];
  for (let gy = 0; gy < rows; gy++) {
    const y0 = Math.min(h - 1, Math.floor((gy * h) / rows));
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * h) / rows));
    for (let gx = 0; gx < cols; gx++) {
      const x0 = Math.min(w - 1, Math.floor((gx * w) / cols));
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * w) / cols));
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        let idx = (y * w + x0) * stride;
        for (let x = x0; x < x1; x++) {
          r += rgb[idx];
          g += rgb[idx + 1];
          b += rgb[idx + 2];
          idx += stride;
          count++;
        }
      }
      const i = gy * cols + gx;
      cr[i] = r / count;
      cg[i] = g / count;
      cb[i] = b / count;
      if (!(skipLight && lum01(cr[i], cg[i], cb[i]) > lightThreshold)) active.push(i);
    }
  }
  if (active.length === 0) return { cols, rows, grid, palette: [] };

  // Seeded k-means++ init (mulberry32(1)): first centroid is the first active
  // cell; each next centroid is D²-sampled, so far-off colors are the likely
  // seeds and small-but-distinct regions keep their own cluster.
  const seen = new Set<number>();
  for (const i of active) {
    seen.add((Math.round(cr[i]) << 16) | (Math.round(cg[i]) << 8) | Math.round(cb[i]));
  }
  const kWant = Math.max(1, Math.min(Math.round(opts.k), seen.size));
  const rand = mulberry32(1);
  const cent: [number, number, number][] = [[cr[active[0]], cg[active[0]], cb[active[0]]]];
  const minD = new Float64Array(active.length).fill(Infinity);
  while (cent.length < kWant) {
    const last = cent[cent.length - 1];
    let total = 0;
    for (let ai = 0; ai < active.length; ai++) {
      const i = active[ai];
      const dr = cr[i] - last[0];
      const dg = cg[i] - last[1];
      const db = cb[i] - last[2];
      const d = dr * dr + dg * dg + db * db;
      if (d < minD[ai]) minD[ai] = d;
      total += minD[ai];
    }
    if (!(total > 0)) break; // every cell equals a chosen centroid already
    let roll = rand() * total;
    let pick = active.length - 1;
    for (let ai = 0; ai < active.length; ai++) {
      roll -= minD[ai];
      if (roll <= 0) {
        pick = ai;
        break;
      }
    }
    const i = active[pick];
    cent.push([cr[i], cg[i], cb[i]]);
  }
  const k = cent.length;

  // 12 rounds of assign + update, then a final assignment pass.
  const assign = new Int32Array(n).fill(-1);
  const doAssign = () => {
    for (const i of active) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const dr = cr[i] - cent[c][0];
        const dg = cg[i] - cent[c][1];
        const db = cb[i] - cent[c][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      assign[i] = best;
    }
  };
  for (let iter = 0; iter < 12; iter++) {
    doAssign();
    const sr = new Float64Array(k);
    const sg = new Float64Array(k);
    const sb = new Float64Array(k);
    const cnt = new Int32Array(k);
    for (const i of active) {
      const c = assign[i];
      sr[c] += cr[i];
      sg[c] += cg[i];
      sb[c] += cb[i];
      cnt[c]++;
    }
    for (let c = 0; c < k; c++) {
      if (cnt[c] > 0) cent[c] = [sr[c] / cnt[c], sg[c] / cnt[c], sb[c] / cnt[c]];
    }
  }
  doAssign();

  // Snap centroids to distinct studio cones - biggest cluster picks first.
  // If every near cone is taken the cluster shares one, which merges it.
  const size = new Int32Array(k);
  for (const i of active) size[assign[i]]++;
  const order: number[] = [];
  for (let c = 0; c < k; c++) if (size[c] > 0) order.push(c);
  order.sort((a, b) => size[b] - size[a] || a - b);

  const used = new Set<string>();
  const palette: PaletteEntry[] = [];
  const codeToIdx = new Map<string, number>();
  const clusterToPalette = new Int32Array(k).fill(-1);
  for (const c of order) {
    const matches = nearestThreads(rgbToHex(cent[c][0], cent[c][1], cent[c][2]), 8);
    const pick = matches.find((m) => !used.has(m.thread.code)) ?? matches[0];
    if (!pick?.thread.hex) continue;
    used.add(pick.thread.code);
    let pi = codeToIdx.get(pick.thread.code);
    if (pi === undefined) {
      pi = palette.length;
      palette.push({ hex: pick.thread.hex, code: pick.thread.code, name: pick.thread.name });
      codeToIdx.set(pick.thread.code, pi);
    }
    clusterToPalette[c] = pi;
  }
  if ((opts.dither ?? false) && palette.length > 1) {
    // Ostromoukhov variable-coefficient error diffusion (SIGGRAPH 2001) over
    // the cone palette: serpentine scan, each cell takes its color plus
    // accumulated error and snaps to the nearest cone by redmean; the leftover
    // diffuses to just three neighbors with per-luminance-level coefficients
    // (blue-noise optimized - cleaner midtones than Floyd–Steinberg, and
    // isolated single crosses read as noise on fabric, so this matters here).
    // Skipped cells stay bare and neither take nor pass along error.
    const pn = palette.length;
    const pr = new Float64Array(pn);
    const pg = new Float64Array(pn);
    const pb = new Float64Array(pn);
    for (let p = 0; p < pn; p++) {
      const [r, g, b] = hexChannels(palette[p].hex);
      pr[p] = r;
      pg[p] = g;
      pb[p] = b;
    }
    const er = new Float64Array(n);
    const eg = new Float64Array(n);
    const eb = new Float64Array(n);
    const isActive = new Uint8Array(n);
    for (const i of active) isActive[i] = 1;
    const spread = (x: number, y: number, wR: number, wG: number, wB: number) => {
      if (x < 0 || x >= cols || y < 0 || y >= rows) return;
      const j = y * cols + x;
      if (!isActive[j]) return;
      er[j] += wR;
      eg[j] += wG;
      eb[j] += wB;
    };
    for (let gy = 0; gy < rows; gy++) {
      const ltr = gy % 2 === 0;
      for (let step = 0; step < cols; step++) {
        const gx = ltr ? step : cols - 1 - step;
        const i = gy * cols + gx;
        if (!isActive[i]) continue;
        const vr = Math.min(255, Math.max(0, cr[i] + er[i]));
        const vg = Math.min(255, Math.max(0, cg[i] + eg[i]));
        const vb = Math.min(255, Math.max(0, cb[i] + eb[i]));
        let best = 0;
        let bestD = Infinity;
        for (let p = 0; p < pn; p++) {
          const rMean = (vr + pr[p]) / 2;
          const dr = vr - pr[p];
          const dg = vg - pg[p];
          const db = vb - pb[p];
          const d =
            (2 + rMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rMean) / 256) * db * db;
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
        grid[i] = best;
        const rr = vr - pr[best];
        const rg = vg - pg[best];
        const rb = vb - pb[best];
        const dx = ltr ? 1 : -1;
        const lum = 0.299 * vr + 0.587 * vg + 0.114 * vb;
        const [wR, wDL, wD] = ostromoukhovWeights(lum);
        spread(gx + dx, gy, rr * wR, rg * wR, rb * wR);
        spread(gx - dx, gy + 1, rr * wDL, rg * wDL, rb * wDL);
        spread(gx, gy + 1, rr * wD, rg * wD, rb * wD);
      }
    }
    // Compact away any cone the dither never used, so every listed cone maps
    // to real crosses and color blocks line up with the palette.
    const usage = new Int32Array(pn);
    for (let i = 0; i < n; i++) if (grid[i] >= 0) usage[grid[i]]++;
    const remap = new Int32Array(pn).fill(-1);
    const compact: PaletteEntry[] = [];
    for (let p = 0; p < pn; p++) {
      if (usage[p] > 0) {
        remap[p] = compact.length;
        compact.push(palette[p]);
      }
    }
    if (compact.length < pn) {
      for (let i = 0; i < n; i++) if (grid[i] >= 0) grid[i] = remap[grid[i]];
    }
    return { cols, rows, grid, palette: compact };
  }

  for (const i of active) {
    const pi = clusterToPalette[assign[i]];
    if (pi >= 0) grid[i] = pi;
  }
  return { cols, rows, grid, palette };
}

/**
 * Backstitch outlines: trace every boundary where the grid changes value -
 * between two different cones, between a cone and a bare (-1) cell, and along
 * the outer edge of stitched cells (outside counts as bare). Edge segments on
 * the cell lattice are chained through shared endpoints into merged polylines
 * (greedy, deterministic), coordinates in mm centered like crossesFromGrid.
 * Each segment is one cell long, so downstream stitches stay short and even.
 */
export function backstitchOutlines(
  q: { cols: number; rows: number; grid: Int16Array },
  cellMm: number,
): PathMm[] {
  const { cols, rows, grid } = q;
  if (cols < 1 || rows < 1 || !(cellMm > 0)) return [];
  const at = (x: number, y: number): number =>
    x < 0 || x >= cols || y < 0 || y >= rows ? -1 : grid[y * cols + x];

  // Lattice nodes are (cols+1) × (rows+1); a segment joins adjacent nodes.
  const nodesW = cols + 1;
  const segA: number[] = [];
  const segB: number[] = [];
  const segUsed: boolean[] = [];
  const atNode = new Map<number, number[]>();
  const addSeg = (a: number, b: number) => {
    const si = segA.length;
    segA.push(a);
    segB.push(b);
    segUsed.push(false);
    const la = atNode.get(a);
    if (la) la.push(si);
    else atNode.set(a, [si]);
    const lb = atNode.get(b);
    if (lb) lb.push(si);
    else atNode.set(b, [si]);
  };
  // Vertical edges sit between horizontal neighbors, horizontal edges between
  // vertical neighbors. Scan order is fixed, so chaining is deterministic.
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x <= cols; x++) {
      if (at(x - 1, y) !== at(x, y)) addSeg(y * nodesW + x, (y + 1) * nodesW + x);
    }
  }
  for (let y = 0; y <= rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (at(x, y - 1) !== at(x, y)) addSeg(y * nodesW + x, y * nodesW + x + 1);
    }
  }

  const takeFrom = (node: number): number => {
    const list = atNode.get(node);
    if (list) for (const si of list) if (!segUsed[si]) return si;
    return -1;
  };
  const ox = (-cols * cellMm) / 2;
  const oy = (-rows * cellMm) / 2;
  const toPt = (node: number) => ({
    x: ox + (node % nodesW) * cellMm,
    y: oy + Math.floor(node / nodesW) * cellMm,
  });
  const paths: PathMm[] = [];
  for (let s0 = 0; s0 < segA.length; s0++) {
    if (segUsed[s0]) continue;
    segUsed[s0] = true;
    const chain: number[] = [segA[s0], segB[s0]];
    for (;;) {
      const tail = chain[chain.length - 1];
      const si = takeFrom(tail);
      if (si < 0) break;
      segUsed[si] = true;
      chain.push(segA[si] === tail ? segB[si] : segA[si]);
    }
    for (;;) {
      const head = chain[0];
      const si = takeFrom(head);
      if (si < 0) break;
      segUsed[si] = true;
      chain.unshift(segA[si] === head ? segB[si] : segA[si]);
    }
    paths.push(chain.map(toPt));
  }
  return paths;
}

/**
 * Grid → mm cross paths, one group per palette index, centered on the origin.
 * Serpentine rows; a run of same-color cells is ONE continuous path - each
 * cross appends [bl, tr, tl, br] (mirrored on odd right-to-left rows) so the
 * exit corner lands exactly on the next cell's entry corner. Runs break on
 * color change or row end (that break becomes a jump).
 */
export function crossesFromGrid(
  q: { cols: number; rows: number; grid: Int16Array },
  paletteLength: number,
  cellMm: number,
): PathMm[][] {
  const { cols, rows, grid } = q;
  const groups: PathMm[][] = [];
  for (let p = 0; p < paletteLength; p++) groups.push([]);
  if (cols < 1 || rows < 1 || !(cellMm > 0)) return groups;
  const ox = (-cols * cellMm) / 2;
  const oy = (-rows * cellMm) / 2;
  for (let p = 0; p < paletteLength; p++) {
    const paths = groups[p];
    for (let r = 0; r < rows; r++) {
      const top = oy + r * cellMm;
      const bottom = top + cellMm;
      const ltr = r % 2 === 0;
      let path: PathMm | null = null;
      for (let step = 0; step < cols; step++) {
        const c = ltr ? step : cols - 1 - step;
        if (grid[r * cols + c] !== p) {
          if (path) {
            paths.push(path);
            path = null;
          }
          continue;
        }
        const left = ox + c * cellMm;
        const right = left + cellMm;
        const bl = { x: left, y: bottom };
        const br = { x: right, y: bottom };
        const tl = { x: left, y: top };
        const tr = { x: right, y: top };
        const pts = ltr ? [bl, tr, tl, br] : [br, tl, tr, bl];
        if (path) path.push(pts[1], pts[2], pts[3]); // pts[0] is where we already are
        else path = [pts[0], pts[1], pts[2], pts[3]];
      }
      if (path) paths.push(path);
    }
  }
  return groups;
}

// ─── Component ───────────────────────────────────────────────────────────

const NO_OVERRIDES: Record<number, PaletteEntry> = {};

// Default backstitch cone: the darkest cone on the studio wall.
const DEFAULT_OUTLINE: PaletteEntry = (() => {
  let best: PaletteEntry = { hex: "#1c1c1a", code: "1800", name: "Black" };
  let bestL = Infinity;
  for (const t of THREADS) {
    if (!t.hex) continue;
    const [r, g, b] = hexChannels(t.hex);
    const l = lum01(r, g, b);
    if (l < bestL) {
      bestL = l;
      best = { hex: t.hex, code: t.code, name: t.name };
    }
  }
  return best;
})();

export default function CrossStitchTool() {
  const [img, setImg] = useState<{ bitmap: ImageBitmap; name: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [cols, setCols] = useState(60);
  const [cellMm, setCellMm] = useState(2.5);
  const [k, setK] = useState(5);
  const [skipLight, setSkipLight] = useState(true);
  const [lightThreshold, setLightThreshold] = useState(0.92);
  const [dither, setDither] = useState(false);
  const [backstitch, setBackstitch] = useState(false);
  const [outlineCone, setOutlineCone] = useState<PaletteEntry>(DEFAULT_OUTLINE);
  // Overrides map palette index → replacement cone, keyed to the palette they
  // were made against so a re-quantize never recolors the wrong block.
  const [overrides, setOverrides] = useState<{ key: string; map: Record<number, PaletteEntry> }>({
    key: "",
    map: {},
  });

  const loadFile = (file: File) => {
    setLoadError(null);
    createImageBitmap(file).then(
      (bitmap) => setImg({ bitmap, name: file.name }),
      () => setLoadError("Couldn't read that as an image - try a JPG or PNG."),
    );
  };
  const onFile = (ev: ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (file) loadFile(file);
  };

  // Downscale to a 3× supersample of the grid so each cell averages a clean
  // 3×3 block - a one-shot drawImage straight to grid size aliases badly.
  const sampled = useMemo(() => {
    if (!img) return null;
    const rows = Math.max(1, Math.round((cols * img.bitmap.height) / img.bitmap.width));
    const w = cols * 3;
    const h = rows * 3;
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#ffffff"; // transparency reads as bare fabric
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img.bitmap, 0, 0, w, h);
    return { w, h, rgb: ctx.getImageData(0, 0, w, h).data };
  }, [img, cols]);

  const quantized = useMemo(() => {
    if (!sampled) return null;
    try {
      setGenError(null);
      return quantizeToThreads(sampled, { cols, k, skipLight, lightThreshold, dither });
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Couldn't quantize that image.");
      return null;
    }
  }, [sampled, cols, k, skipLight, lightThreshold, dither]);

  const paletteKey = useMemo(
    () => (quantized ? quantized.palette.map((p) => p.code).join(",") : ""),
    [quantized],
  );
  const ovMap = overrides.key === paletteKey ? overrides.map : NO_OVERRIDES;
  const setOverride = (i: number, entry: PaletteEntry | null) =>
    setOverrides((prev) => {
      const map = { ...(prev.key === paletteKey ? prev.map : {}) };
      if (entry) map[i] = entry;
      else delete map[i];
      return { key: paletteKey, map };
    });

  // Effective palette = quantized cones with any user swaps applied.
  const palette = useMemo(
    () => (quantized ? quantized.palette.map((p, i) => ovMap[i] ?? p) : []),
    [quantized, ovMap],
  );

  const counts = useMemo(() => {
    if (!quantized) return [];
    const c = new Array<number>(quantized.palette.length).fill(0);
    for (let i = 0; i < quantized.grid.length; i++) {
      const v = quantized.grid[i];
      if (v >= 0) c[v]++;
    }
    return c;
  }, [quantized]);
  const totalCrosses = useMemo(() => counts.reduce((a, b) => a + b, 0), [counts]);

  // The honest pipeline: grid → cross paths → stitches → DST → re-parse.
  // With backstitch on, the outline joins as its own final color group - each
  // polyline sewn out-and-back so every edge carries two passes of thread.
  const built = useMemo(() => {
    if (!quantized || quantized.palette.length === 0) return null;
    try {
      const groups = crossesFromGrid(quantized, quantized.palette.length, cellMm);
      if (backstitch) {
        const outlines = backstitchOutlines(quantized, cellMm);
        if (outlines.length > 0)
          groups.push(outlines.map((path) => [...path, ...path.slice(0, -1).reverse()]));
      }
      const stitches = pathGroupsToStitches(groups, 1);
      return buildDesign(stitches, "bayside-crossstitch");
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Couldn't build the stitch file.");
      return null;
    }
  }, [quantized, cellMm, backstitch]);

  const designW = cols * cellMm;
  const designH = quantized ? quantized.rows * cellMm : null;
  const allLight = quantized !== null && quantized.palette.length === 0;

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="Photo">
            <DropZone onFile={loadFile}>
              <label className="block cursor-pointer border border-dashed border-mid/60 bg-bg px-3 py-5 text-center text-[0.75rem] text-mid hover:border-fg hover:text-fg">
                {img ? img.name : "Choose a photo (JPG or PNG) - or drop it here"}
                <input type="file" accept="image/*" className="hidden" onChange={onFile} />
              </label>
            </DropZone>
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Bold, high-contrast images count best. Light areas can stay bare fabric and let the
              garment do some of the work.
            </p>
          </SectionBox>

          <SectionBox eyebrow="Grid">
            <RangeRow
              label="Grid width"
              value={cols}
              min={20}
              max={160}
              onChange={setCols}
              fmt={(v) => `${v} cells`}
            />
            <RangeRow
              label="Cell size"
              value={cellMm}
              min={1.5}
              max={4}
              step={0.1}
              onChange={setCellMm}
              fmt={(v) => `${v.toFixed(1)} mm`}
            />
            <SizeField
              label="Finished width"
              valueMm={designW}
              min={cols * 1.5}
              max={cols * 4}
              onChange={(mm) => setCellMm(Math.max(1.5, Math.min(4, mm / Math.max(1, cols))))}
            />
            <p className="text-[0.75rem] text-mid tabular-nums">
              Design size{" "}
              <span className="text-fg">
                {designW.toFixed(0)}
                {designH !== null ? ` × ${designH.toFixed(0)}` : ""} mm
              </span>
            </p>
          </SectionBox>

          <SectionBox eyebrow="Colors">
            <RangeRow label="Thread colors" value={k} min={2} max={8} onChange={setK} fmt={(v) => `${v} cones`} />
            <div className="space-y-1.5">
              <div className={LABEL}>Light cells</div>
              <ModeButtons
                small
                options={
                  [
                    ["skip", "Leave as fabric"],
                    ["stitch", "Stitch them too"],
                  ] as const
                }
                value={skipLight ? "skip" : "stitch"}
                onChange={(v) => setSkipLight(v === "skip")}
              />
            </div>
            {skipLight && (
              <RangeRow
                label="Light threshold"
                value={lightThreshold}
                min={0.8}
                max={0.98}
                step={0.01}
                onChange={setLightThreshold}
                fmt={(v) => v.toFixed(2)}
              />
            )}
            <div className="space-y-1.5">
              <div className={LABEL}>Dither</div>
              <ModeButtons
                small
                options={
                  [
                    ["off", "Solid blocks"],
                    ["on", "Dither"],
                  ] as const
                }
                value={dither ? "on" : "off"}
                onChange={(v) => setDither(v === "on")}
              />
            </div>
            {dither && (
              <p className="text-[0.6875rem] text-mid leading-relaxed">
                Dither speckles neighboring cones into each other, so a handful of colors can
                carry a smooth gradient - skies, skin, slow fades.
              </p>
            )}
          </SectionBox>

          <SectionBox eyebrow="Backstitch">
            <ModeButtons
              small
              options={
                [
                  ["off", "Off"],
                  ["on", "Outline"],
                ] as const
              }
              value={backstitch ? "on" : "off"}
              onChange={(v) => setBackstitch(v === "on")}
            />
            {backstitch && (
              <ThreadRow
                label="Outline cone"
                hex={outlineCone.hex}
                onChange={(hex, code) => {
                  const t = THREADS.find((th) => th.code === code);
                  setOutlineCone({ hex, code, name: t?.name ?? code });
                }}
              />
            )}
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Traces every color edge in a doubled running stitch, sewn last - the crisp outline
              that makes counted work read from across the room.
            </p>
          </SectionBox>

          {quantized && quantized.palette.length > 0 && (
            <SectionBox eyebrow="Cones to pull">
              <div className="space-y-3">
                {quantized.palette.map((orig, i) => {
                  const eff = ovMap[i] ?? orig;
                  const overridden = ovMap[i] !== undefined;
                  return (
                    <div key={`${i}-${orig.code}`} className="space-y-1.5">
                      <div className="flex items-center gap-2 text-[0.75rem]">
                        <span
                          className="w-5 h-5 border border-hairline shrink-0"
                          style={{ background: eff.hex }}
                        />
                        <span className="text-fg">
                          {eff.code} <span className="text-mid">- {eff.name}</span>
                        </span>
                        <span className="ml-auto shrink-0 text-mid tabular-nums">
                          {(counts[i] ?? 0).toLocaleString()}×
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <ThreadSelect
                          value={eff.hex}
                          onChange={(hex, code) => {
                            const t = THREADS.find((th) => th.code === code);
                            setOverride(i, { hex, code, name: t?.name ?? code });
                          }}
                        />
                        {overridden && (
                          <button
                            onClick={() => setOverride(i, null)}
                            className="shrink-0 text-[0.6875rem] text-accent hover:underline"
                          >
                            reset
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="text-[0.6875rem] text-mid leading-relaxed">
                Swap any cone and that whole color block recolors - the counts stay put.
              </p>
            </SectionBox>
          )}
        </>
      }
      preview={
        <PreviewRail
          built={built}
          colors={[...palette.map((p) => p.hex), ...(backstitch ? [outlineCone.hex] : [])]}
          name="bayside-crossstitch"
          emptyHint="Pick a photo and it becomes counted crosses in real thread cones."
        >
          {loadError && <Warning>{loadError}</Warning>}
          {genError && <Warning>{genError}</Warning>}
          {allLight && (
            <Warning>
              Every cell came out lighter than the threshold - lower it, or stitch light cells too.
            </Warning>
          )}
          {built && totalCrosses > 0 && (
            <p className="text-[0.75rem] text-mid tabular-nums">
              {totalCrosses.toLocaleString()} crosses × 2 passes each, in {palette.length}{" "}
              {palette.length === 1 ? "cone" : "cones"}
              {backstitch ? ` - backstitch outline in ${outlineCone.code} sews last.` : "."}
            </p>
          )}
        </PreviewRail>
      }
    />
  );
}
