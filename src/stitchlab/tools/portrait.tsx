// Stitch Lab tool: Thread Portrait - a photo becomes running-stitch line art.
// Darkness-weighted stippling drops the dots (Secord's weighted-Voronoi
// relaxation evens them into that reference stipple look), a Sobel edge pass
// can pull extra dots toward eyes and hairlines, then a traveling-salesman
// tour (nearest-neighbor construction + random 2-opt) threads every dot into
// an unbroken path. One tone sews with zero trims - white thread on navy is
// the signature look. Two or three tones split the shadows across separate
// threads, darkest first, for portraits with real tonal depth.
//
// v2 adds photographic control before the dots drop (adjustLum: brightness,
// contrast, denoise) and flow to the line after (chaikinSmooth rounds the
// dot-to-dot tour into a silky continuous stroke, endpoints pinned).
//
// The pure logic (mulberry32 / sobelGrad / adjustLum / chaikinSmooth /
// lloydRelax / stipplePoints / stippleTones / nnTour) touches no DOM so node
// can import and test it; file reading and canvas sampling live in the
// component. Model space is mm y-down until pathsToStitches converts to 0.1 mm
// machine units.

import { useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import { THREADS } from "../../data/threads";
import { pathsToStitches, pathGroupsToStitches, type PathMm } from "../lib/generators";
import {
  ToolLayout,
  SectionBox,
  RangeRow,
  ModeButtons,
  ThreadRow,
  Warning,
  PreviewRail,
  buildDesign,
  useDebouncedKey,
  LABEL,
  DropZone,
  SizeField,
} from "./shared";

// ─── Pure logic ──────────────────────────────────────────────────────────

type Pt = { x: number; y: number };

/** Deterministic 32-bit PRNG (mulberry32). Same seed → same portrait. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sobel gradient magnitude of a luminance image, normalized to 0..1 (1 = the
 * strongest edge in the photo). Border pixels use edge replication. Pure and
 * deterministic - feed the result back in as `img.grad` for edge-aware
 * stippling.
 */
export function sobelGrad(img: { w: number; h: number; lum: Float32Array }): Float32Array {
  const { w, h, lum } = img;
  const out = new Float32Array(w * h);
  if (w < 1 || h < 1) return out;
  const at = (x: number, y: number) =>
    lum[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  let max = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = at(x - 1, y - 1);
      const tc = at(x, y - 1);
      const tr = at(x + 1, y - 1);
      const ml = at(x - 1, y);
      const mr = at(x + 1, y);
      const bl = at(x - 1, y + 1);
      const bc = at(x, y + 1);
      const br = at(x + 1, y + 1);
      const gx = tr + 2 * mr + br - (tl + 2 * ml + bl);
      const gy = bl + 2 * bc + br - (tl + 2 * tc + tr);
      const g = Math.sqrt(gx * gx + gy * gy);
      out[y * w + x] = g;
      if (g > max) max = g;
    }
  }
  if (max > 1e-6) for (let i = 0; i < w * h; i++) out[i] /= max;
  return out;
}

/**
 * Photographic tone control applied before stippling. A small box blur knocks
 * back sensor noise and JPEG grain (so the stipple reads the face, not the
 * speckle), then brightness shifts and contrast pivots around mid-grey. Pure;
 * returns a new luminance buffer, values clamped to 0..1. `brightness` is a
 * signed lift (−0.5..0.5); `contrast` is a multiplier around 0.5 (1 = none).
 */
export function adjustLum(
  img: { w: number; h: number; lum: Float32Array },
  o: { brightness?: number; contrast?: number; blur?: number },
): Float32Array {
  const { w, h, lum } = img;
  const brightness = o.brightness ?? 0;
  const contrast = o.contrast ?? 1;
  const blur = Math.max(0, Math.min(3, Math.round(o.blur ?? 0)));
  let src = lum;
  // Separable box blur, `blur` px radius, run once. Cheap and denoise-y.
  if (blur > 0 && w > 2 && h > 2) {
    const tmp = new Float32Array(w * h);
    const dst = new Float32Array(w * h);
    const r = blur;
    const norm = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -r; k <= r; k++) s += src[y * w + Math.min(w - 1, Math.max(0, x + k))];
        tmp[y * w + x] = s * norm;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let s = 0;
        for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x];
        dst[y * w + x] = s * norm;
      }
    }
    src = dst;
  }
  if (brightness === 0 && contrast === 1) return src === lum ? lum.slice() : src;
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let v = (src[i] - 0.5) * contrast + 0.5 + brightness;
    out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return out;
}

/**
 * Chaikin corner-cutting: replace the sharp dot-to-dot tour with a flowing
 * line by cutting each corner at 1/4 and 3/4. Endpoints are pinned so the line
 * stays one continuous stroke. `passes` rounds (0 = untouched). Every extra
 * pass roughly doubles the vertex count, so 1–2 is plenty. Pure.
 */
export function chaikinSmooth(path: PathMm, passes: number): PathMm {
  let p = path;
  const n = Math.max(0, Math.min(3, Math.round(passes)));
  for (let it = 0; it < n && p.length >= 3; it++) {
    const out: PathMm = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i];
      const b = p[i + 1];
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p === path ? path.slice() : p;
}

/**
 * One pass of true weighted Lloyd relaxation (Secord, "Weighted Voronoi
 * Stippling"): every image pixel is assigned to its nearest stipple point -
 * the discrete Voronoi region - via a spatial hash with an expanding-ring
 * search, weighted centroids accumulate, and each point moves to the centroid
 * of the pixels it collected. `stride === 2` visits a checkerboard of pixels
 * for speed on big images.
 */
function relaxPass(pts: Pt[], w: number, h: number, wts: Float32Array, stride: 1 | 2): void {
  const n = pts.length;
  if (n === 0) return;
  const cell = Math.max(1, Math.sqrt((w * h) / n));
  const gw = Math.max(1, Math.ceil(w / cell));
  const gh = Math.max(1, Math.ceil(h / cell));
  const cells: number[][] = Array.from({ length: gw * gh }, () => []);
  for (let i = 0; i < n; i++) {
    const gx = Math.min(gw - 1, Math.max(0, Math.floor(pts[i].x / cell)));
    const gy = Math.min(gh - 1, Math.max(0, Math.floor(pts[i].y / cell)));
    cells[gy * gw + gx].push(i);
  }
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  const sw = new Float64Array(n);
  const maxRing = gw + gh;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      if (stride === 2 && ((px + py) & 1) === 1) continue;
      const wt = wts[py * w + px];
      if (wt <= 1e-4) continue;
      const cx = px + 0.5;
      const cy = py + 0.5;
      const gx = Math.min(gw - 1, Math.max(0, Math.floor(cx / cell)));
      const gy = Math.min(gh - 1, Math.max(0, Math.floor(cy / cell)));
      let best = -1;
      let bestD2 = Infinity;
      const scanCell = (xx: number, yy: number) => {
        if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) return;
        for (const idx of cells[yy * gw + xx]) {
          const dx = pts[idx].x - cx;
          const dy = pts[idx].y - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = idx;
          }
        }
      };
      for (let ring = 0; ring <= maxRing; ring++) {
        if (best >= 0) {
          const reach = (ring - 1) * cell;
          if (reach > 0 && reach * reach > bestD2) break;
        }
        if (ring === 0) scanCell(gx, gy);
        else {
          for (let xx = gx - ring; xx <= gx + ring; xx++) {
            scanCell(xx, gy - ring);
            scanCell(xx, gy + ring);
          }
          for (let yy = gy - ring + 1; yy <= gy + ring - 1; yy++) {
            scanCell(gx - ring, yy);
            scanCell(gx + ring, yy);
          }
        }
      }
      if (best >= 0) {
        sx[best] += wt * cx;
        sy[best] += wt * cy;
        sw[best] += wt;
      }
    }
  }
  for (let i = 0; i < n; i++) {
    if (sw[i] > 0) pts[i] = { x: sx[i] / sw[i], y: sy[i] / sw[i] };
  }
}

/**
 * Weighted centroidal Voronoi relaxation, `passes` rounds. Mutates `pts` in
 * place and returns it. The spatial hash is rebuilt every pass, so points
 * keep converging toward the classic evenly-spread-but-density-true stipple.
 * Deterministic. `stride` defaults to 2 above 90k pixels (checkerboard
 * sampling - half the pixels, visually identical centroids).
 */
export function lloydRelax(
  pts: { x: number; y: number }[],
  w: number,
  h: number,
  wts: Float32Array,
  opts?: { passes?: number; stride?: 1 | 2 },
): { x: number; y: number }[] {
  const passes = Math.max(0, Math.round(opts?.passes ?? 1));
  const stride: 1 | 2 = opts?.stride ?? (w * h > 90000 ? 2 : 1);
  for (let p = 0; p < passes; p++) relaxPass(pts, w, h, wts, stride);
  return pts;
}

/** Rejection sampling against a weight field. RNG call order is stable. */
function rejectSample(
  w: number,
  h: number,
  wts: Float32Array,
  wMax: number,
  count: number,
  rand: () => number,
): Pt[] {
  const pts: Pt[] = [];
  const maxAttempts = Math.max(20000, count * 600);
  for (let a = 0; a < maxAttempts && pts.length < count; a++) {
    const x = rand() * w;
    const y = rand() * h;
    const px = Math.min(w - 1, Math.floor(x));
    const py = Math.min(h - 1, Math.floor(y));
    if (rand() < wts[py * w + px] / wMax) pts.push({ x, y });
  }
  return pts;
}

/**
 * Darkness-weighted stippling via rejection sampling. `lum` is 0..1 luminance
 * (1 = white); weight = pow(invert ? lum : 1 - lum, gamma), plus
 * `edgeBoost · grad` when a gradient field is supplied - that biases dots
 * toward edges so eyes, hairlines, and jaw lines hold their shape.
 * `relaxPasses` rounds of weighted Lloyd (up to 6) even out clumps without
 * flattening the density gradient. Deterministic for a given seed. Returns
 * points in image pixel coordinates.
 */
export function stipplePoints(
  img: { w: number; h: number; lum: Float32Array; grad?: Float32Array },
  opts: {
    count: number;
    invert?: boolean;
    gamma?: number;
    seed?: number;
    relaxPasses?: number;
    edgeBoost?: number;
  },
): { x: number; y: number }[] {
  const { w, h, lum } = img;
  const count = Math.max(0, Math.floor(opts.count));
  if (count === 0 || w <= 0 || h <= 0) return [];
  const gamma = opts.gamma ?? 1.8;
  const invert = opts.invert ?? false;
  const boost = Math.max(0, opts.edgeBoost ?? 0);
  const grad = boost > 0 ? img.grad : undefined;
  const rand = mulberry32(opts.seed ?? 1);

  // Precompute weights once; normalizing by the max keeps the same
  // distribution but makes rejection sampling fast on low-contrast photos.
  const wts = new Float32Array(w * h);
  let wMax = 0;
  for (let i = 0; i < w * h; i++) {
    const v = invert ? lum[i] : 1 - lum[i];
    const base = v <= 0 ? 0 : Math.pow(v, gamma);
    const wt = grad ? base + boost * grad[i] : base;
    wts[i] = wt;
    if (wt > wMax) wMax = wt;
  }
  if (wMax <= 1e-4) return []; // nothing to stitch (blank image for this mode)

  const pts = rejectSample(w, h, wts, wMax, count, rand);
  const passes = Math.max(0, Math.min(6, Math.round(opts.relaxPasses ?? 0)));
  if (passes > 0) lloydRelax(pts, w, h, wts, { passes, stride: 1 });
  return pts;
}

export type ToneCount = 1 | 2 | 3;

// Darkness bands per tone count, darkest first, as [dLo, dHi) on
// d = invert ? lum : 1 - lum. The 3-tone split is the classic
// lum < 0.35 / 0.35–0.65 / 0.65–0.88 read (near-white stays bare fabric).
const TONE_SPLITS: Record<2 | 3, readonly (readonly [number, number])[]> = {
  2: [
    [0.5, 1.01],
    [0.12, 0.5],
  ],
  3: [
    [0.65, 1.01],
    [0.35, 0.65],
    [0.12, 0.35],
  ],
};

/**
 * Multi-tone stippling: split the darkness range into `tones` bands, stipple
 * each band separately (the shared point budget divides proportional to each
 * band's ink mass), relax each band against its own weights. Returns one
 * point set per band, darkest first - feed each through a tour and stitch
 * them via pathGroupsToStitches so the darkest thread sews first. With
 * `tones: 1` this is exactly `stipplePoints`. Deterministic for a given seed.
 */
export function stippleTones(
  img: { w: number; h: number; lum: Float32Array; grad?: Float32Array },
  opts: {
    count: number;
    tones: ToneCount;
    invert?: boolean;
    gamma?: number;
    seed?: number;
    relaxPasses?: number;
    edgeBoost?: number;
  },
): { x: number; y: number }[][] {
  const { tones } = opts;
  if (tones === 1) return [stipplePoints(img, opts)];
  const bands = TONE_SPLITS[tones];
  const { w, h, lum } = img;
  const count = Math.max(0, Math.floor(opts.count));
  if (count === 0 || w <= 0 || h <= 0) return bands.map(() => []);
  const gamma = opts.gamma ?? 1.8;
  const invert = opts.invert ?? false;
  const boost = Math.max(0, opts.edgeBoost ?? 0);
  const grad = boost > 0 ? img.grad : undefined;

  // Per-band masked weight fields + ink mass (the budget key).
  const wtsPer: Float32Array[] = [];
  const maxPer: number[] = [];
  const massPer: number[] = [];
  for (const [dLo, dHi] of bands) {
    const wts = new Float32Array(w * h);
    let wMax = 0;
    let mass = 0;
    for (let i = 0; i < w * h; i++) {
      const d = invert ? lum[i] : 1 - lum[i];
      if (d < dLo || d >= dHi) continue;
      const base = d <= 0 ? 0 : Math.pow(d, gamma);
      const wt = grad ? base + boost * grad[i] : base;
      wts[i] = wt;
      mass += wt;
      if (wt > wMax) wMax = wt;
    }
    wtsPer.push(wts);
    maxPer.push(wMax);
    massPer.push(mass);
  }

  const totalMass = massPer.reduce((s, m) => s + m, 0);
  if (totalMass <= 1e-6) return bands.map(() => []);

  // Largest-remainder split of the point budget, deterministic tie-break.
  const exact = massPer.map((m) => (count * m) / totalMass);
  const alloc = exact.map((e) => Math.floor(e));
  let rem = count - alloc.reduce((s, c) => s + c, 0);
  const byFrac = exact
    .map((e, i) => [e - Math.floor(e), i] as const)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; k < byFrac.length && rem > 0; k++) {
    alloc[byFrac[k][1]]++;
    rem--;
  }

  const passes = Math.max(0, Math.min(6, Math.round(opts.relaxPasses ?? 0)));
  const seed = opts.seed ?? 1;
  return bands.map((_, k) => {
    if (alloc[k] === 0 || maxPer[k] <= 1e-4) return [];
    const rand = mulberry32(seed + k * 7919);
    const pts = rejectSample(w, h, wtsPer[k], maxPer[k], alloc[k], rand);
    if (passes > 0) lloydRelax(pts, w, h, wtsPer[k], { passes, stride: 1 });
    return pts;
  });
}

/**
 * Traveling-salesman-ish tour: nearest-neighbor construction on a spatial
 * grid (squared distances, so 6000 points stays fast), then `improveIters`
 * random-pair 2-opt improvement attempts. Deterministic (internal RNG is
 * mulberry32(1)). Returns the visiting order as indices into `points`.
 */
export function nnTour(points: { x: number; y: number }[], improveIters = 200000): number[] {
  const n = points.length;
  if (n < 2) return points.map((_, i) => i);

  // Spatial grid over the point bounds.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const cell = Math.max(1e-9, Math.sqrt((spanX * spanY) / n));
  const gw = Math.max(1, Math.min(1024, Math.ceil(spanX / cell)));
  const gh = Math.max(1, Math.min(1024, Math.ceil(spanY / cell)));
  const cw = spanX / gw; // actual cell width/height after clamping
  const ch = spanY / gh;
  const cellMin = Math.min(cw, ch);
  const cells: number[][] = Array.from({ length: gw * gh }, () => []);
  const cellX = (x: number) => Math.min(gw - 1, Math.max(0, Math.floor((x - minX) / cw)));
  const cellY = (y: number) => Math.min(gh - 1, Math.max(0, Math.floor((y - minY) / ch)));
  for (let i = 0; i < n; i++) cells[cellY(points[i].y) * gw + cellX(points[i].x)].push(i);

  // Nearest-neighbor construction, expanding-ring search, lazy visited skip.
  const visited = new Uint8Array(n);
  const order: number[] = [0];
  visited[0] = 1;
  let cur = 0;
  const maxRing = gw + gh;
  while (order.length < n) {
    const cx = points[cur].x;
    const cy = points[cur].y;
    const gx = cellX(cx);
    const gy = cellY(cy);
    let best = -1;
    let bestD2 = Infinity;
    const scanCell = (xx: number, yy: number) => {
      if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) return;
      for (const idx of cells[yy * gw + xx]) {
        if (visited[idx]) continue;
        const dx = points[idx].x - cx;
        const dy = points[idx].y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = idx;
        }
      }
    };
    for (let ring = 0; ring <= maxRing; ring++) {
      if (best >= 0) {
        const reach = (ring - 1) * cellMin;
        if (reach > 0 && reach * reach > bestD2) break;
      }
      if (ring === 0) scanCell(gx, gy);
      else {
        for (let xx = gx - ring; xx <= gx + ring; xx++) {
          scanCell(xx, gy - ring);
          scanCell(xx, gy + ring);
        }
        for (let yy = gy - ring + 1; yy <= gy + ring - 1; yy++) {
          scanCell(gx - ring, yy);
          scanCell(gx + ring, yy);
        }
      }
    }
    if (best < 0) break; // unreachable, but never loop forever
    order.push(best);
    visited[best] = 1;
    cur = best;
  }

  // 2-opt: random edge pairs; reverse the span when it shortens the path.
  // True (non-squared) distances here - the improvement test needs them.
  const dist = (a: number, b: number): number => {
    const dx = points[a].x - points[b].x;
    const dy = points[a].y - points[b].y;
    return Math.sqrt(dx * dx + dy * dy);
  };
  const rng = mulberry32(1);
  const iters = Math.max(0, Math.floor(improveIters));
  for (let it = 0; it < iters; it++) {
    let i = Math.floor(rng() * (n - 1));
    let j = Math.floor(rng() * (n - 1));
    if (i > j) {
      const t = i;
      i = j;
      j = t;
    }
    if (j - i < 2) continue; // shared node or no-op reversal
    const a = order[i];
    const b = order[i + 1];
    const c = order[j];
    const e = order[j + 1];
    if (dist(a, c) + dist(b, e) < dist(a, b) + dist(c, e) - 1e-9) {
      for (let lo = i + 1, hi = j; lo < hi; lo++, hi--) {
        const t = order[lo];
        order[lo] = order[hi];
        order[hi] = t;
      }
    }
  }
  return order;
}

/**
 * Cap segment length by SUBDIVIDING long hops into equal parts. Every
 * original point survives untouched - detail is never smoothed away.
 */
function subdivideHops(path: PathMm, maxSegMm: number): PathMm {
  if (path.length < 2) return path.slice();
  const out: PathMm = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const parts = Math.max(1, Math.ceil(len / maxSegMm));
    for (let k = 1; k <= parts; k++) {
      out.push({ x: a.x + ((b.x - a.x) * k) / parts, y: a.y + ((b.y - a.y) * k) / parts });
    }
  }
  return out;
}

// ─── Component ───────────────────────────────────────────────────────────

type ImgLum = { w: number; h: number; lum: Float32Array };

const DEFAULT_WHITE =
  THREADS.find((t) => t.code === "1802")?.hex ?? // Natural White
  THREADS.find((t) => t.family === "White" && t.hex)?.hex ??
  THREADS.find((t) => t.hex)?.hex ??
  "#ececdf";

function hexLuma(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
}

// Multi-tone defaults: the darkest non-metallic cone in the rack, a mid grey,
// a light grey. All real Madeira Polyneon codes from the studio inventory.
const DARKEST_CONE = (() => {
  let best = "#1a1a1a";
  let bestL = Infinity;
  for (const t of THREADS) {
    if (!t.hex || t.isMetallic) continue;
    const l = hexLuma(t.hex);
    if (l < bestL) {
      bestL = l;
      best = t.hex;
    }
  }
  return best;
})();
const MID_GREY = THREADS.find((t) => t.code === "1918")?.hex ?? "#8A8B8E"; // Sterling Silver
const LIGHT_GREY = THREADS.find((t) => t.code === "1811")?.hex ?? "#A9B0B1"; // Weimaraner
const DEFAULT_TONE_HEXES = [DARKEST_CONE, MID_GREY, LIGHT_GREY];

const TONE_LABELS: Record<2 | 3, string[]> = {
  2: ["Dark tone", "Light tone"],
  3: ["Dark tone", "Mid tone", "Light tone"],
};

export default function ThreadPortrait() {
  const [img, setImg] = useState<ImgLum | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  const [count, setCount] = useState(2500);
  const [gamma, setGamma] = useState(1.8);
  const [invert, setInvert] = useState(false);
  const [relax, setRelax] = useState(1);
  const [detail, setDetail] = useState(0.6);
  const [tones, setTones] = useState<ToneCount>(1);
  const [sizeMm, setSizeMm] = useState(100);
  const [maxSeg, setMaxSeg] = useState(3);
  // v2 controls: photographic tone adjustment + output line smoothing.
  const [brightness, setBrightness] = useState(0);
  const [contrast, setContrast] = useState(1);
  const [denoise, setDenoise] = useState(0);
  const [flow, setFlow] = useState(1);
  const [threadHex, setThreadHex] = useState(DEFAULT_WHITE);
  const [toneHexes, setToneHexes] = useState<string[]>(DEFAULT_TONE_HEXES);

  const loadFile = async (file: File) => {
    try {
      setLoadError(null);
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 260 / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Couldn't get a canvas context.");
      ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close();
      const data = ctx.getImageData(0, 0, w, h).data;
      const lum = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const r = data[i * 4] / 255;
        const g = data[i * 4 + 1] / 255;
        const b = data[i * 4 + 2] / 255;
        const a = data[i * 4 + 3] / 255;
        // Rec.601 luma, composited over white (transparent reads as white).
        lum[i] = (0.299 * r + 0.587 * g + 0.114 * b) * a + (1 - a);
      }
      setImg({ w, h, lum });
      setFileName(file.name);
    } catch (err) {
      setImg(null);
      setFileName(null);
      setLoadError(
        err instanceof Error && err.message
          ? err.message
          : "Couldn't read that image - a plain JPG or PNG works best.",
      );
    }
  };

  const onFile = (ev: ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (file) void loadFile(file);
  };

  // Stippling + the 2-opt tour are expensive, so the whole chain runs off a
  // debounced key: sliders move instantly, the portrait recomputes once they
  // rest. The memo bodies read the live params (current when the key settles).
  const genKey = useDebouncedKey([brightness, contrast, denoise, count, tones, invert, gamma, relax, detail], 200);

  // Tone-adjusted image (brightness / contrast / denoise) - everything
  // downstream reads this, so the sliders shape the whole portrait.
  const adjImg = useMemo<ImgLum | null>(() => {
    if (!img) return null;
    if (brightness === 0 && contrast === 1 && denoise === 0) return img;
    return { w: img.w, h: img.h, lum: adjustLum(img, { brightness, contrast, blur: denoise }) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, genKey]);

  // Sobel gradient magnitude (0..1) - the Detail slider's edge map, on the
  // adjusted image so edges track the tones you actually stitch.
  const gradMap = useMemo(() => (adjImg ? sobelGrad(adjImg) : null), [adjImg]);

  // params → per-tone stipple point sets (image pixel coords, darkest first)
  const toneSets = useMemo<Pt[][]>(() => {
    if (!adjImg) return [];
    const img = adjImg;
    try {
      setGenError(null);
      const src =
        gradMap && detail > 0 ? { w: img.w, h: img.h, lum: img.lum, grad: gradMap } : img;
      return stippleTones(src, {
        count,
        tones,
        invert,
        gamma,
        seed: 1,
        relaxPasses: relax,
        edgeBoost: detail,
      });
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Stippling failed on that photo.");
      return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adjImg, gradMap, genKey]);

  // each point set → one tour through it. Single tone keeps the full 400k
  // 2-opt budget; multi-tone splits it by point share so total work is level.
  const toneOrders = useMemo<number[][]>(() => {
    const total = toneSets.reduce((s, set) => s + set.length, 0);
    if (total < 2) return toneSets.map(() => []);
    try {
      return toneSets.map((set) => {
        if (set.length < 2) return [];
        const iters =
          toneSets.length === 1
            ? 400000
            : Math.max(60000, Math.round((400000 * set.length) / total));
        return nnTour(set, iters);
      });
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Routing failed.");
      return toneSets.map(() => []);
    }
  }, [toneSets]);

  // tours → mm paths: scale to size, merge sub-0.3 mm steps (kind to the
  // machine), subdivide hops longer than the max segment. Never smooths.
  const tonePaths = useMemo<PathMm[]>(() => {
    if (!img) return [];
    const scale = sizeMm / Math.max(img.w, img.h);
    return toneSets.map((set, k) => {
      const order = toneOrders[k] ?? [];
      if (order.length < 2) return [];
      const raw: PathMm = order.map((i) => ({
        x: (set[i].x - img.w / 2) * scale,
        y: (set[i].y - img.h / 2) * scale,
      }));
      const cleaned: PathMm = [raw[0]];
      for (let i = 1; i < raw.length; i++) {
        const tail = cleaned[cleaned.length - 1];
        if (Math.hypot(raw[i].x - tail.x, raw[i].y - tail.y) >= 0.3) cleaned.push(raw[i]);
      }
      // Flow: round the dot-to-dot corners into a flowing line before hops are
      // capped. Endpoints stay pinned, so it's still one continuous stroke.
      const flowed = flow > 0 ? chaikinSmooth(cleaned, flow) : cleaned;
      return subdivideHops(flowed, maxSeg);
    });
  }, [img, toneSets, toneOrders, sizeMm, maxSeg, flow]);

  // mm paths → machine stitches → real DST bytes → re-parsed preview.
  // Multi-tone goes through pathGroupsToStitches: darkest first, a color
  // change between tones, each tone still one continuous line.
  const built = useMemo(() => {
    const kept = tonePaths.filter((p) => p.length >= 2);
    if (kept.length === 0) return null;
    const stitches =
      kept.length === 1 ? pathsToStitches([kept[0]]) : pathGroupsToStitches(kept.map((p) => [p]));
    return buildDesign(stitches, "bayside-portrait");
  }, [tonePaths]);

  // Preview colors track the tones that actually produced a sewable path.
  const previewColors = useMemo(() => {
    const hexes = tones === 1 ? [threadHex] : toneHexes.slice(0, tones);
    const kept: string[] = [];
    tonePaths.forEach((p, k) => {
      if (p.length >= 2) kept.push(hexes[k] ?? hexes[hexes.length - 1] ?? threadHex);
    });
    return kept.length > 0 ? kept : [hexes[0] ?? threadHex];
  }, [tonePaths, tones, threadHex, toneHexes]);

  return (
    <div className="space-y-5">
      <ToolLayout
        controls={
          <>
            <SectionBox eyebrow="photo">
              <DropZone onFile={(f) => void loadFile(f)} className="border border-dashed border-mid/50 px-3 py-3">
                <label className={LABEL}>
                  Photo - or drop it here
                  <input
                    type="file"
                    accept="image/*"
                    onChange={onFile}
                    className="mt-1.5 block w-full text-[0.75rem] text-mid file:mr-3 file:rounded-none file:border file:border-hairline file:bg-bg file:px-3 file:py-1 file:text-[0.75rem] file:text-fg"
                  />
                </label>
              </DropZone>
              {img && fileName ? (
                <p className="text-[0.75rem] text-mid">
                  {fileName} - working at {img.w} × {img.h} px. Nothing uploads; the photo stays
                  in your browser.
                </p>
              ) : (
                <p className="text-[0.75rem] text-mid leading-relaxed">
                  A clear face on a plain background reads best. High contrast helps.
                </p>
              )}
              {loadError && <Warning>{loadError}</Warning>}
            </SectionBox>

            <SectionBox eyebrow="adjust">
              <RangeRow
                label="Brightness"
                value={brightness}
                min={-0.35}
                max={0.35}
                step={0.01}
                onChange={setBrightness}
                fmt={(v) => (v === 0 ? "0" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(0)}`)}
              />
              <RangeRow
                label="Contrast"
                value={contrast}
                min={0.6}
                max={2}
                step={0.05}
                onChange={setContrast}
                fmt={(v) => `×${v.toFixed(2)}`}
              />
              <RangeRow label="Denoise" value={denoise} min={0} max={3} step={1} onChange={setDenoise} fmt={(v) => (v === 0 ? "off" : `${v}px`)} />
              <div className="flex items-center justify-between">
                <p className="text-[0.6875rem] text-mid leading-relaxed pr-2">
                  Set the tones before stippling - push contrast so the face separates from the
                  background, denoise to keep grain out of the dots.
                </p>
                <button
                  onClick={() => { setBrightness(0); setContrast(1); setDenoise(0); }}
                  className="shrink-0 text-[0.6875rem] text-mid hover:text-fg border border-hairline px-2 py-0.5"
                >
                  reset
                </button>
              </div>
            </SectionBox>

            <SectionBox eyebrow="stipple">
              <RangeRow label="Points" value={count} min={500} max={6000} step={100} onChange={setCount} />
              <RangeRow
                label="Gamma"
                value={gamma}
                min={0.8}
                max={3}
                step={0.1}
                onChange={setGamma}
                fmt={(v) => v.toFixed(1)}
              />
              <RangeRow label="Smoothing passes" value={relax} min={0} max={3} step={1} onChange={setRelax} />
              <RangeRow
                label="Detail"
                value={detail}
                min={0}
                max={2}
                step={0.1}
                onChange={setDetail}
                fmt={(v) => v.toFixed(1)}
              />
              <label className="flex items-center gap-2 text-[0.75rem] text-mid">
                <input
                  type="checkbox"
                  checked={invert}
                  onChange={(ev) => setInvert(ev.target.checked)}
                  className="accent-accent"
                />
                stitch the light instead of the dark
              </label>
              <p className="text-[0.6875rem] text-mid leading-relaxed">
                Ticked, the line chases the highlights - that's the move for white thread on a
                navy blank. Higher gamma concentrates dots in the deepest tones; relax passes
                even out clumps. Detail pulls dots toward edges, so eyes, hairlines, and jaw
                lines hold their shape.
              </p>
            </SectionBox>

            <SectionBox eyebrow="tones">
              <ModeButtons
                options={
                  [
                    [1, "1 tone"],
                    [2, "2 tones"],
                    [3, "3 tones"],
                  ] as const
                }
                value={tones}
                onChange={setTones}
              />
              {tones > 1 && (
                <>
                  {toneHexes.slice(0, tones).map((hex, k) => (
                    <ThreadRow
                      key={k}
                      label={TONE_LABELS[tones === 2 ? 2 : 3][k]}
                      hex={hex}
                      onChange={(h) =>
                        setToneHexes((prev) => prev.map((p, i) => (i === k ? h : p)))
                      }
                    />
                  ))}
                </>
              )}
              <p className="text-[0.6875rem] text-mid leading-relaxed">
                {tones === 1
                  ? "One thread, one unbroken line - the classic. Add tones to split the shadows across two or three threads for real depth."
                  : "Darkest thread sews first so the lighter tones sit on top. Each tone is still one continuous line - the only trims are the color changes."}
              </p>
            </SectionBox>

            <SectionBox eyebrow="stitch">
              <SizeField valueMm={sizeMm} min={40} max={330} onChange={setSizeMm} />
              <RangeRow
                label="Max segment"
                value={maxSeg}
                min={1.5}
                max={5}
                step={0.1}
                onChange={setMaxSeg}
                fmt={(v) => `${v.toFixed(1)} mm`}
              />
              <RangeRow label="Line flow" value={flow} min={0} max={3} step={1} onChange={setFlow} fmt={(v) => (v === 0 ? "angular" : v >= 3 ? "silky" : v === 1 ? "eased" : "smooth")} />
              {tones === 1 && <ThreadRow hex={threadHex} onChange={(hex) => setThreadHex(hex)} />}
            </SectionBox>

            {genError && <Warning>{genError}</Warning>}
          </>
        }
        preview={
          <PreviewRail
            built={built}
            colors={previewColors}
            name="bayside-portrait"
            emptyHint="Load a photo to begin - the whole portrait becomes one continuous thread."
          >
            {built && (
              <p className="text-[0.8125rem] text-mid tabular-nums">
                {previewColors.length === 1
                  ? `${built.stats.stitchPathM.toFixed(1)} m tour · 1 continuous line - zero trims`
                  : `${built.stats.stitchPathM.toFixed(1)} m across ${previewColors.length} tones, darkest first - trims only at the color changes`}
              </p>
            )}
            {built && built.stats.realStitches > 45000 && (
              <Warning>
                Over 45,000 stitches - that's a long, dense sew. Drop the point count or raise
                the max segment to bring it back into range.
              </Warning>
            )}
          </PreviewRail>
        }
      />
    </div>
  );
}
