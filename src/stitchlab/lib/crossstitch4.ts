// Cross-Stitch V4 engine - pure, deterministic, no DOM. The tool shell is
// tools/crossstitch4.tsx; tests are crossstitch4.test.ts.
//
// What V4 changes over V1-V3 (and Photoreal's "Fine cross-stitch", which runs
// on the V1 engine):
//
//   • Color in OKLab (Ottosson 2020), averaged in LINEAR light. V1-V3 averaged
//     gamma-encoded sRGB, which darkens every mixed cell (a black/white edge
//     cell averages to sRGB 128 ≈ 21% luminance, not 50%).
//   • The palette is chosen FROM the cone catalog, not clustered then snapped.
//     V2/V3 ran k-means in Lab and then moved each center to its nearest
//     unused cone, so the error that counts (photo → actual cone) was never
//     optimized. V4 treats it as k-facility location over the ~120 cones:
//     greedy build + PAM-style swaps (Kaufman & Rousseeuw 1990) on a color
//     histogram, with locked and excluded cones. Optional CIEDE2000 metric.
//   • Fabric is a free color. Bare cells are a label like any other, with the
//     fabric's real color, so "skip light areas" becomes "leave fabric where
//     fabric is the best match" - and works on dark fabric too.
//   • Show-through. A stitched X never covers its cell; the preview color of a
//     cell is the partitive (linear-light) mix of thread and fabric by a
//     coverage factor, so matching accounts for the fabric showing between legs.
//   • Leg-level color. Each X is two legs, so one cell can carry two cones
//     ("/" in A, "\" in B - a blended cross) or one leg over bare fabric (a
//     half stitch). k cones give k + k(k-1)/2 + k tones with no extra color
//     changes - the cross-stitch analogue of halftone screens.
//   • One energy, one Smoothness control. Labeling minimizes a Potts MRF
//         E(l) = Σ_p D(t_p, c(l_p)) + λ Σ_{p~q} [l_p ≠ l_q]
//     (Boykov, Veksler & Zabih 2001). Dither mode runs error diffusion with the
//     λ term applied causally (confetti-aware diffusion); clean mode runs ICM
//     sweeps (Besag 1986). A hard minimum-region size merges any leftover
//     islands. This replaces V2's single-pass "isolated cell" cleanup.
//   • Routing on the half-leg lattice. A "/" leg joins corners of one
//     checkerboard parity and a "\" leg the other, so a graph of whole
//     diagonals always splits a solid region into two zigzags. Splitting every
//     leg at the cell center (the Ink/Stitch cross-stitch model) reconnects
//     them: nodes = corners + centers, edges = half-legs. Travel then runs on
//     top of legs of the same cone - never along a visible cell edge (V1) or
//     as a jump per diagonal (V2/V3).
//       "continuous": Eulerian trails with Chinese-postman doubling
//         (lib/routing planStrokes) - one stroke per 8-connected region.
//       "consistent": per region, every "/" along anti-diagonal chains, then
//         every "\" along main-diagonal chains, linked by BFS through cell
//         centers - so every top leg points the same way, for even sheen.

import { planStrokes, type Segment } from "./routing";
import type { PathMm } from "./generators";
import { THREADS, type Thread } from "../../data/threads";

// ─── Color ───────────────────────────────────────────────────────────────

export type Vec3 = [number, number, number];

const SRGB_TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function srgb8ToLin(v: number): number {
  return SRGB_TO_LIN[Math.max(0, Math.min(255, Math.round(v)))];
}

export function linToSrgb8(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/** Linear sRGB → OKLab (Björn Ottosson, 2020). */
export function linToOklab(r: number, g: number, b: number): Vec3 {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Linear sRGB → CIELAB (D65), for CIEDE2000. */
export function linToCielab(r: number, g: number, b: number): Vec3 {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 color difference (Sharma, Wu & Dalal 2005 formulation). */
export function ciede2000(l1: Vec3, l2: Vec3): number {
  const [L1, a1, b1] = l1, [L2, a2, b2] = l2;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cb7 = Math.pow((C1 + C2) / 2, 7);
  const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + 6103515625))); // 25^7
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hp = (b: number, a: number) => {
    if (a === 0 && b === 0) return 0;
    const h = Math.atan2(b, a) / rad;
    return h < 0 ? h + 360 : h;
  };
  const h1p = hp(b1, a1p), h2p = hp(b2, a2p);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbp += h1p + h2p < 360 ? 360 : -360;
    hbp /= 2;
  }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad)
    + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Cbp7 = Math.pow(Cbp, 7);
  const Rc = 2 * Math.sqrt(Cbp7 / (Cbp7 + 6103515625));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  const tl = dLp / Sl, tc = dCp / Sc, th = dHp / Sh;
  return Math.sqrt(tl * tl + tc * tc + th * th + Rt * tc * th);
}

export function hexToLin(hex: string): Vec3 {
  const n = parseInt(hex.slice(1), 16);
  return [srgb8ToLin((n >> 16) & 255), srgb8ToLin((n >> 8) & 255), srgb8ToLin(n & 255)];
}

export function linToHex([r, g, b]: Vec3): string {
  return "#" + [r, g, b].map((c) => linToSrgb8(c).toString(16).padStart(2, "0")).join("");
}

// ─── Image → cell targets ────────────────────────────────────────────────

export type RgbaImage = { w: number; h: number; rgb: Uint8ClampedArray };

/** Per-pixel linear RGB + OKLab, computed once per photo. */
export type PreparedImage = { w: number; h: number; lin: Float32Array; ok: Float32Array };

export function prepareImage(img: RgbaImage): PreparedImage {
  const { w, h, rgb } = img;
  const n = w * h;
  const lin = new Float32Array(n * 3);
  const ok = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = SRGB_TO_LIN[rgb[i * 4]], g = SRGB_TO_LIN[rgb[i * 4 + 1]], b = SRGB_TO_LIN[rgb[i * 4 + 2]];
    lin[i * 3] = r; lin[i * 3 + 1] = g; lin[i * 3 + 2] = b;
    const o = linToOklab(r, g, b);
    ok[i * 3] = o[0]; ok[i * 3 + 1] = o[1]; ok[i * 3 + 2] = o[2];
  }
  return { w, h, lin, ok };
}

export type CellTargets = {
  cols: number;
  rows: number;
  /** Per-cell target, linear RGB (×3). */
  lin: Float32Array;
  /** Per-cell target, OKLab (×3). */
  ok: Float32Array;
  /** Per-quadrant OKLab, 4 per cell in TL, TR, BR, BL order (×3). */
  quad: Float32Array;
  /** Per-cell local contrast (OKLab L gradient to neighbors), 0..~1. */
  edge: Float32Array;
};

/**
 * Downsample to the stitch grid. Each cell's target is its linear-light mean,
 * pulled toward the cell's dominant color by `sharpness` (0 = plain box mean,
 * 1 = majority color). The dominant color comes from a 2-means split of the
 * cell's pixels in OKLab - a cheap stand-in for content-adaptive downscaling
 * (Kopf et al. 2013) that stops edge cells from averaging into a third color
 * no region in the photo actually has.
 */
export function sampleCells(p: PreparedImage, cols: number, sharpness: number): CellTargets {
  const { w, h } = p;
  cols = Math.max(4, Math.round(cols));
  const rows = Math.max(2, Math.round((cols * h) / w));
  const n = cols * rows;
  const lin = new Float32Array(n * 3);
  const ok = new Float32Array(n * 3);
  const quad = new Float32Array(n * 12);
  const sharp = Math.max(0, Math.min(1, sharpness));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let gx = 0; gx <= cols; gx++) xs.push(Math.round((gx * w) / cols));
  for (let gy = 0; gy <= rows; gy++) ys.push(Math.round((gy * h) / rows));

  const samp: number[] = []; // pixel indices (reused buffer)
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const c = gy * cols + gx;
      const x0 = Math.min(w - 1, xs[gx]), x1 = Math.max(x0 + 1, xs[gx + 1]);
      const y0 = Math.min(h - 1, ys[gy]), y1 = Math.max(y0 + 1, ys[gy + 1]);
      const xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
      const q = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // 4 quadrants × (r,g,b)
      const qn = [0, 0, 0, 0];
      let r = 0, g = 0, b = 0, cnt = 0;
      samp.length = 0;
      for (let y = y0; y < Math.min(h, y1); y++) {
        for (let x = x0; x < Math.min(w, x1); x++) {
          const i = y * w + x;
          const lr = p.lin[i * 3], lg = p.lin[i * 3 + 1], lb = p.lin[i * 3 + 2];
          r += lr; g += lg; b += lb; cnt++;
          const qi = y < ym ? (x < xm ? 0 : 1) : x < xm ? 3 : 2;
          q[qi * 3] += lr; q[qi * 3 + 1] += lg; q[qi * 3 + 2] += lb; qn[qi]++;
          samp.push(i);
        }
      }
      r /= cnt; g /= cnt; b /= cnt;
      let mOk = linToOklab(r, g, b);
      if (sharp > 0 && samp.length >= 4) {
        const dom = dominant(p, samp, mOk);
        if (dom) {
          // blend in linear light, then re-derive OKLab
          r += (dom[0] - r) * sharp; g += (dom[1] - g) * sharp; b += (dom[2] - b) * sharp;
          mOk = linToOklab(r, g, b);
        }
      }
      lin[c * 3] = r; lin[c * 3 + 1] = g; lin[c * 3 + 2] = b;
      ok[c * 3] = mOk[0]; ok[c * 3 + 1] = mOk[1]; ok[c * 3 + 2] = mOk[2];
      for (let k = 0; k < 4; k++) {
        const m = qn[k] || 1;
        const o = qn[k] ? linToOklab(q[k * 3] / m, q[k * 3 + 1] / m, q[k * 3 + 2] / m) : mOk;
        quad[c * 12 + k * 3] = o[0]; quad[c * 12 + k * 3 + 1] = o[1]; quad[c * 12 + k * 3 + 2] = o[2];
      }
    }
  }
  const edge = new Float32Array(n);
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const c = gy * cols + gx;
      let m = 0;
      const nb = (j: number) => { m = Math.max(m, Math.abs(ok[c * 3] - ok[j * 3])); };
      if (gx > 0) nb(c - 1);
      if (gx < cols - 1) nb(c + 1);
      if (gy > 0) nb(c - cols);
      if (gy < rows - 1) nb(c + cols);
      edge[c] = m;
    }
  }
  return { cols, rows, lin, ok, quad, edge };
}

/** Linear-RGB mean of the larger half of a 2-means split, or null when the
 *  cell is effectively one color. */
function dominant(p: PreparedImage, idx: number[], mean: Vec3): Vec3 | null {
  const step = Math.max(1, Math.floor(idx.length / 96));
  const pts: number[] = [];
  for (let i = 0; i < idx.length; i += step) pts.push(idx[i]);
  const d2 = (i: number, c: Vec3) =>
    (p.ok[i * 3] - c[0]) ** 2 + (p.ok[i * 3 + 1] - c[1]) ** 2 + (p.ok[i * 3 + 2] - c[2]) ** 2;
  const at = (i: number): Vec3 => [p.ok[i * 3], p.ok[i * 3 + 1], p.ok[i * 3 + 2]];
  let far = pts[0], fd = -1;
  for (const i of pts) { const d = d2(i, mean); if (d > fd) { fd = d; far = i; } }
  if (fd < 0.03 * 0.03) return null;
  let c1 = at(far);
  let far2 = pts[0]; fd = -1;
  for (const i of pts) { const d = d2(i, c1); if (d > fd) { fd = d; far2 = i; } }
  let c2 = at(far2);
  let n1 = 0, n2 = 0;
  const s1 = [0, 0, 0], s2 = [0, 0, 0];
  for (let it = 0; it < 4; it++) {
    const o1 = [0, 0, 0], o2 = [0, 0, 0];
    n1 = 0; n2 = 0; s1.fill(0); s2.fill(0);
    for (const i of pts) {
      const one = d2(i, c1) <= d2(i, c2);
      const o = one ? o1 : o2, s = one ? s1 : s2;
      for (let k = 0; k < 3; k++) { o[k] += p.ok[i * 3 + k]; s[k] += p.lin[i * 3 + k]; }
      if (one) n1++; else n2++;
    }
    if (!n1 || !n2) return null;
    c1 = [o1[0] / n1, o1[1] / n1, o1[2] / n1];
    c2 = [o2[0] / n2, o2[1] / n2, o2[2] / n2];
  }
  if ((c1[0] - c2[0]) ** 2 + (c1[1] - c2[1]) ** 2 + (c1[2] - c2[2]) ** 2 < 0.03 * 0.03) return null;
  return n1 >= n2 ? [s1[0] / n1, s1[1] / n1, s1[2] / n1] : [s2[0] / n2, s2[1] / n2, s2[2] / n2];
}

// ─── Palette: k-facility location over the cone catalog ───────────────────

export type Cone = { code: string; name: string; hex: string };

export type PaletteOpts = {
  k: number;
  /** "oklab" (fast, perceptually even) or "de2000" (CIEDE2000). */
  metric?: "oklab" | "de2000";
  /** Weight on lightness differences (1 = neutral, >1 = favor tone). */
  toneWeight?: number;
  /** Extra selection weight on high-contrast cells (0 = off). Protects small
   *  details - eyes, lettering - from losing their cone to large flat areas. */
  detailWeight?: number;
  locked?: string[];
  excluded?: string[];
  /** Fabric color; when `useFabric`, bare fabric is a free (uncounted) color. */
  fabricHex?: string;
  useFabric?: boolean;
  /** Thread coverage of a full cross, 0..1 (1 = no fabric shows through). */
  coverage?: number;
  catalog?: Thread[];
};

/** Mix a thread over fabric by coverage, in linear light (partitive mixing). */
export function mixOver(thread: Vec3, fabric: Vec3, coverage: number): Vec3 {
  return [
    thread[0] * coverage + fabric[0] * (1 - coverage),
    thread[1] * coverage + fabric[1] * (1 - coverage),
    thread[2] * coverage + fabric[2] * (1 - coverage),
  ];
}

/**
 * Choose k cones from the catalog to minimize the weighted total distance of
 * every cell to its nearest chosen cone (bare fabric free when enabled).
 * Greedy BUILD then PAM SWAP passes, on a histogram of cell colors so the
 * cost is O(bins × cones) rather than O(cells × cones). Deterministic.
 */
export function selectPalette(t: CellTargets, o: PaletteOpts): Cone[] {
  const catalog = (o.catalog ?? THREADS).filter((th) => th.hex && !th.isMetallic);
  const excluded = new Set(o.excluded ?? []);
  const lockedCodes = (o.locked ?? []).filter((c) => catalog.some((th) => th.code === c));
  const cands = catalog.filter((th) => !excluded.has(th.code) || lockedCodes.includes(th.code));
  const k = Math.max(1, Math.min(cands.length, Math.round(o.k)));
  const cov = o.coverage ?? 1;
  const fabric = hexToLin(o.fabricHex ?? "#ffffff");
  const toneW = o.toneWeight ?? 1;
  const detailW = o.detailWeight ?? 0;
  const metric = o.metric ?? "oklab";

  // Histogram the cells in OKLab (bins of 0.02).
  const bins = new Map<string, { w: number; lin: Vec3; n: number }>();
  const n = t.cols * t.rows;
  for (let c = 0; c < n; c++) {
    const key = `${Math.round(t.ok[c * 3] * 50)},${Math.round(t.ok[c * 3 + 1] * 50)},${Math.round(t.ok[c * 3 + 2] * 50)}`;
    const wgt = 1 + detailW * Math.min(1, t.edge[c] * 5);
    let b = bins.get(key);
    if (!b) { b = { w: 0, lin: [0, 0, 0], n: 0 }; bins.set(key, b); }
    b.w += wgt; b.n++;
    b.lin[0] += t.lin[c * 3]; b.lin[1] += t.lin[c * 3 + 1]; b.lin[2] += t.lin[c * 3 + 2];
  }
  const B = [...bins.values()].map((b) => ({ w: b.w, lin: [b.lin[0] / b.n, b.lin[1] / b.n, b.lin[2] / b.n] as Vec3 }));

  const dist = makeDistance(metric, toneW);
  const binKey = B.map((b) => dist.key(b.lin));
  const coneLin = cands.map((th) => mixOver(hexToLin(th.hex!), fabric, cov));
  const coneKey = coneLin.map((l) => dist.key(l));
  const D = new Float64Array(B.length * cands.length);
  for (let i = 0; i < B.length; i++)
    for (let j = 0; j < cands.length; j++) D[i * cands.length + j] = B[i].w * dist.d(binKey[i], coneKey[j]);
  const bare = new Float64Array(B.length).fill(Infinity);
  if (o.useFabric) {
    const fk = dist.key(fabric);
    for (let i = 0; i < B.length; i++) bare[i] = B[i].w * dist.d(binKey[i], fk);
  }

  const M = cands.length;
  const chosen: number[] = lockedCodes.map((c) => cands.findIndex((th) => th.code === c)).filter((j) => j >= 0);
  const isLocked = new Set(chosen);
  const best = Float64Array.from(bare);
  for (const j of chosen) for (let i = 0; i < B.length; i++) best[i] = Math.min(best[i], D[i * M + j]);

  // BUILD: add the cone with the largest total gain until k are chosen.
  while (chosen.length < k) {
    let bj = -1, bg = -Infinity;
    for (let j = 0; j < M; j++) {
      if (chosen.includes(j)) continue;
      let gain = 0;
      for (let i = 0; i < B.length; i++) {
        const v = D[i * M + j];
        if (v < best[i]) gain += (best[i] === Infinity ? 1e9 : best[i]) - v;
      }
      if (gain > bg) { bg = gain; bj = j; }
    }
    if (bj < 0) break;
    chosen.push(bj);
    for (let i = 0; i < B.length; i++) best[i] = Math.min(best[i], D[i * M + bj]);
  }

  // SWAP: replace any unlocked cone with any other while total cost drops.
  const cost = () => {
    let s = 0;
    for (let i = 0; i < B.length; i++) {
      let m = bare[i];
      for (const j of chosen) m = Math.min(m, D[i * M + j]);
      s += m;
    }
    return s;
  };
  let total = cost();
  for (let pass = 0; pass < 3; pass++) {
    // nearest and second-nearest among chosen (+bare) per bin
    const near = new Int32Array(B.length), d1 = new Float64Array(B.length), d2 = new Float64Array(B.length);
    for (let i = 0; i < B.length; i++) {
      let a = bare[i], an = -1, s2 = Infinity;
      for (const j of chosen) {
        const v = D[i * M + j];
        if (v < a) { s2 = a; a = v; an = j; } else if (v < s2) s2 = v;
      }
      near[i] = an; d1[i] = a; d2[i] = s2;
    }
    let improved = false;
    let bestDelta = -1e-9, bestOut = -1, bestIn = -1;
    for (const out of chosen) {
      if (isLocked.has(out)) continue;
      for (let j = 0; j < M; j++) {
        if (chosen.includes(j)) continue;
        let delta = 0;
        for (let i = 0; i < B.length; i++) {
          const without = near[i] === out ? d2[i] : d1[i];
          delta += Math.min(without, D[i * M + j]) - d1[i];
        }
        if (delta < bestDelta) { bestDelta = delta; bestOut = out; bestIn = j; }
      }
    }
    if (bestOut >= 0) {
      chosen[chosen.indexOf(bestOut)] = bestIn;
      total += bestDelta;
      improved = true;
    }
    if (!improved) break;
  }
  void total;
  return chosen.map((j) => ({ code: cands[j].code, name: cands[j].name, hex: cands[j].hex! }));
}

type Metric = { key: (lin: Vec3) => Vec3; d: (a: Vec3, b: Vec3) => number };

function makeDistance(metric: "oklab" | "de2000", toneWeight: number): Metric {
  if (metric === "de2000") {
    return {
      key: (l) => linToCielab(l[0], l[1], l[2]),
      // CIEDE2000 with kL folded in by scaling L before comparison
      d: (a, b) => {
        const e = ciede2000([a[0] * toneWeight, a[1], a[2]], [b[0] * toneWeight, b[1], b[2]]);
        return e * e;
      },
    };
  }
  return {
    key: (l) => linToOklab(l[0], l[1], l[2]),
    d: (a, b) => toneWeight * (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2,
  };
}

// ─── Labels: what a cell can be ──────────────────────────────────────────

/**
 * A cell's stitch. `fwd` is the "/" leg's cone (palette index), `back` the "\"
 * leg's; -1 = no leg. Solid: fwd = back. Blend: two cones. Half: fwd only.
 * Bare: neither.
 */
export type Label = { kind: "bare" | "solid" | "blend" | "half"; fwd: number; back: number; lin: Vec3; ok: Vec3; hex: string };

export type LabelOpts = {
  fabricHex?: string;
  useFabric?: boolean;
  blends?: boolean;
  halves?: boolean;
  /** Full-cross coverage, 0..1. A half stitch covers a bit over half of that. */
  coverage?: number;
  /** Only blend cone pairs closer than this (OKLab distance). Far-apart
   *  pairs (red + green) read as speckle, not as a mixed tone. */
  maxBlendDelta?: number;
};

export function buildLabels(palette: Cone[], o: LabelOpts): Label[] {
  const fabric = hexToLin(o.fabricHex ?? "#ffffff");
  const cov = o.coverage ?? 1;
  const mk = (kind: Label["kind"], fwd: number, back: number, lin: Vec3): Label =>
    ({ kind, fwd, back, lin, ok: linToOklab(lin[0], lin[1], lin[2]), hex: linToHex(lin) });
  const cl = palette.map((p) => hexToLin(p.hex));
  const out: Label[] = [];
  palette.forEach((_, i) => out.push(mk("solid", i, i, mixOver(cl[i], fabric, cov))));
  if (o.useFabric) out.push(mk("bare", -1, -1, fabric));
  if (o.blends) {
    const maxD = o.maxBlendDelta ?? 0.25;
    const ok = cl.map((l) => linToOklab(l[0], l[1], l[2]));
    for (let i = 0; i < cl.length; i++)
      for (let j = i + 1; j < cl.length; j++) {
        if (Math.hypot(ok[i][0] - ok[j][0], ok[i][1] - ok[j][1], ok[i][2] - ok[j][2]) > maxD) continue;
        const mid: Vec3 = [(cl[i][0] + cl[j][0]) / 2, (cl[i][1] + cl[j][1]) / 2, (cl[i][2] + cl[j][2]) / 2];
        out.push(mk("blend", i, j, mixOver(mid, fabric, cov)));
      }
  }
  if (o.halves) {
    // One leg covers a little over half a full cross (the legs overlap at
    // the center), so ~0.55 of the full-cross coverage.
    palette.forEach((_, i) => out.push(mk("half", i, -1, mixOver(cl[i], fabric, cov * 0.55))));
  }
  return out;
}

// ─── Assignment: Potts energy, diffusion or ICM ──────────────────────────

export type AssignOpts = {
  /** Lightness weight in the data term (1 = neutral). */
  toneWeight?: number;
  /** Potts λ, 0..1 slider scale. 0 = per-cell best match. */
  smoothness?: number;
  /** Error diffusion strength, 0..1 (0 = no dithering). */
  dither?: number;
  /** Merge any same-label region smaller than this many cells (1 = off). */
  minRegion?: number;
  /** Dither only where the photo is flat; edges stay crisp (libimagequant's
   *  "dither map" idea - edges dither into jaggies, texture is already noisy). */
  ditherFlatOnly?: boolean;
  /** Edge-aware smoothing: cutting between two cells that differ in the photo
   *  costs less (Potts weight exp(-Δ²/2σ²)), so boundaries follow real edges. */
  edgeAware?: boolean;
};

const LAMBDA_SCALE = 0.004; // OKLab² units
const EDGE_SIGMA = 0.06; // OKLab
// Slider → λ. Gentle over most of the travel (0.5 ≈ a small cone step per
// neighbor), steep at the top so 1.0 flattens even black-on-white speckle.
export const smoothnessToLambda = (s: number) => LAMBDA_SCALE * s * (1 + 99 * s ** 4);

export function assignLabels(t: CellTargets, labels: Label[], o: AssignOpts): Int16Array {
  const { cols, rows } = t;
  const n = cols * rows;
  const L = labels.length;
  const tw = o.toneWeight ?? 1;
  const lambda = smoothnessToLambda(Math.max(0, o.smoothness ?? 0));
  const dith = Math.max(0, Math.min(1, o.dither ?? 0));
  const lo = new Float32Array(L * 3);
  labels.forEach((l, i) => { lo[i * 3] = l.ok[0]; lo[i * 3 + 1] = l.ok[1]; lo[i * 3 + 2] = l.ok[2]; });
  const data = (c0: number, c1: number, c2: number, l: number) =>
    tw * (c0 - lo[l * 3]) ** 2 + (c1 - lo[l * 3 + 1]) ** 2 + (c2 - lo[l * 3 + 2]) ** 2;
  const out = new Int16Array(n).fill(-1);
  if (L === 0) return out;
  const edgeAware = o.edgeAware ?? true;
  // Potts pair weight between cells p and q.
  const wpq = (p: number, q: number) => {
    if (!edgeAware) return 1;
    const d2 = (t.ok[p * 3] - t.ok[q * 3]) ** 2 + (t.ok[p * 3 + 1] - t.ok[q * 3 + 1]) ** 2 + (t.ok[p * 3 + 2] - t.ok[q * 3 + 2]) ** 2;
    // floored, so a strong edge is cheaper to cut but never free - otherwise
    // high-contrast speckle would count as "edge" and could never be cleaned
    return 0.25 + 0.75 * Math.exp(-d2 / (2 * EDGE_SIGMA * EDGE_SIGMA));
  };

  // Pass 1: serpentine scan. Each cell picks argmin data + λ·Σ w_pq over
  // already-decided neighbors that differ; with dither > 0 the quantization
  // error diffuses (Floyd–Steinberg weights, attenuated and clamped) -
  // confetti-aware error diffusion.
  const err = new Float32Array(n * 3);
  const CLAMP = 0.12;
  for (let gy = 0; gy < rows; gy++) {
    const ltr = gy % 2 === 0;
    const dx = ltr ? 1 : -1;
    for (let s = 0; s < cols; s++) {
      const gx = ltr ? s : cols - 1 - s;
      const c = gy * cols + gx;
      const v0 = t.ok[c * 3] + err[c * 3], v1 = t.ok[c * 3 + 1] + err[c * 3 + 1], v2 = t.ok[c * 3 + 2] + err[c * 3 + 2];
      const nbs: number[] = [];
      const nbw: number[] = [];
      if (lambda > 0) {
        const add = (j: number) => { nbs.push(out[j]); nbw.push(wpq(c, j)); };
        const prevX = gx - dx;
        if (prevX >= 0 && prevX < cols) add(c - dx);
        if (gy > 0) {
          add(c - cols);
          if (gx > 0) add(c - cols - 1);
          if (gx < cols - 1) add(c - cols + 1);
        }
      }
      let best = 0, bd = Infinity;
      for (let l = 0; l < L; l++) {
        let e = data(v0, v1, v2, l);
        for (let q = 0; q < nbs.length; q++) if (nbs[q] !== l) e += lambda * 0.5 * nbw[q];
        if (e < bd) { bd = e; best = l; }
      }
      out[c] = best;
      const dc = o.ditherFlatOnly ? dith * Math.max(0, 1 - t.edge[c] * 8) : dith;
      if (dc > 0) {
        const e0 = clamp((v0 - lo[best * 3]) * dc, CLAMP), e1 = clamp((v1 - lo[best * 3 + 1]) * dc, CLAMP), e2 = clamp((v2 - lo[best * 3 + 2]) * dc, CLAMP);
        const spread = (x: number, y: number, wgt: number) => {
          if (x < 0 || x >= cols || y >= rows) return;
          const j = y * cols + x;
          err[j * 3] += e0 * wgt; err[j * 3 + 1] += e1 * wgt; err[j * 3 + 2] += e2 * wgt;
        };
        spread(gx + dx, gy, 7 / 16);
        spread(gx - dx, gy + 1, 3 / 16);
        spread(gx, gy + 1, 5 / 16);
        spread(gx + dx, gy + 1, 1 / 16);
      }
    }
  }

  // Pass 2 (clean mode): ICM sweeps on the symmetric 4-neighbor Potts energy.
  if (lambda > 0 && dith === 0) {
    for (let sweep = 0; sweep < 5; sweep++) {
      let changed = 0;
      for (let c = 0; c < n; c++) {
        const gx = c % cols, gy = (c / cols) | 0;
        const nb: number[] = [];
        const nw: number[] = [];
        const add = (j: number) => { nb.push(out[j]); nw.push(wpq(c, j)); };
        if (gx > 0) add(c - 1);
        if (gx < cols - 1) add(c + 1);
        if (gy > 0) add(c - cols);
        if (gy < rows - 1) add(c + cols);
        const v0 = t.ok[c * 3], v1 = t.ok[c * 3 + 1], v2 = t.ok[c * 3 + 2];
        let best = out[c], bd = Infinity;
        for (let l = 0; l < L; l++) {
          let e = data(v0, v1, v2, l);
          for (let q = 0; q < nb.length; q++) if (nb[q] !== l) e += lambda * nw[q];
          if (e < bd) { bd = e; best = l; }
        }
        if (best !== out[c]) { out[c] = best; changed++; }
      }
      if (!changed) break;
    }
  }

  const minRegion = Math.max(1, Math.round(o.minRegion ?? 1));
  if (minRegion > 1) mergeSmallRegions(t, out, lo, tw, minRegion);
  return out;
}

const clamp = (v: number, m: number) => (v > m ? m : v < -m ? -m : v);

/**
 * Hard cleanup: every 4-connected same-label region smaller than `minRegion`
 * is relabeled, as a whole, to whichever bordering label fits its cells best.
 */
export function mergeSmallRegions(
  t: CellTargets, lab: Int16Array, lo: Float32Array, tw: number, minRegion: number,
): void {
  const { cols, rows } = t;
  const n = cols * rows;
  for (let round = 0; round < 3; round++) {
    const seen = new Uint8Array(n);
    let merged = 0;
    for (let s = 0; s < n; s++) {
      if (seen[s]) continue;
      const l = lab[s];
      const comp: number[] = [s];
      seen[s] = 1;
      const border = new Set<number>();
      for (let h = 0; h < comp.length; h++) {
        const c = comp[h];
        const gx = c % cols, gy = (c / cols) | 0;
        const visit = (j: number) => {
          if (lab[j] === l) { if (!seen[j]) { seen[j] = 1; comp.push(j); } }
          else border.add(lab[j]);
        };
        if (gx > 0) visit(c - 1);
        if (gx < cols - 1) visit(c + 1);
        if (gy > 0) visit(c - cols);
        if (gy < rows - 1) visit(c + cols);
      }
      if (comp.length >= minRegion || border.size === 0) continue;
      let best = l, bd = Infinity;
      for (const b of border) {
        let e = 0;
        for (const c of comp)
          e += tw * (t.ok[c * 3] - lo[b * 3]) ** 2 + (t.ok[c * 3 + 1] - lo[b * 3 + 1]) ** 2 + (t.ok[c * 3 + 2] - lo[b * 3 + 2]) ** 2;
        if (e < bd) { bd = e; best = b; }
      }
      for (const c of comp) lab[c] = best;
      merged++;
    }
    if (!merged) break;
  }
}

// ─── Fractional stitches ─────────────────────────────────────────────────

/**
 * Three-quarter + quarter stitches on diagonal boundaries. For a solid cell
 * with label A, a corner gets label B (a solid neighbor's label, or bare)
 * when B fits that quadrant clearly better than A and a neighbor sharing the
 * corner is already B - so it smooths a real staircase, never invents one.
 * Returns per-cell corner (0 TL, 1 TR, 2 BR, 3 BL; -1 none) and its label.
 */
export function fractionalCorners(
  t: CellTargets, lab: Int16Array, labels: Label[], toneWeight = 1, margin = 0.0015,
): { corner: Int8Array; minority: Int16Array } {
  const { cols, rows } = t;
  const n = cols * rows;
  const corner = new Int8Array(n).fill(-1);
  const minority = new Int16Array(n).fill(-1);
  const d = (c: number, k: number, l: number) => {
    const q = c * 12 + k * 3, o = labels[l].ok;
    return toneWeight * (t.quad[q] - o[0]) ** 2 + (t.quad[q + 1] - o[1]) ** 2 + (t.quad[q + 2] - o[2]) ** 2;
  };
  // neighbors sharing each corner: TL → left, up; TR → right, up; BR → right, down; BL → left, down
  for (let c = 0; c < n; c++) {
    const A = lab[c];
    if (A < 0 || labels[A].kind !== "solid") continue;
    const gx = c % cols, gy = (c / cols) | 0;
    const left = gx > 0 ? lab[c - 1] : -2, right = gx < cols - 1 ? lab[c + 1] : -2;
    const up = gy > 0 ? lab[c - cols] : -2, down = gy < rows - 1 ? lab[c + cols] : -2;
    const share = [[left, up], [right, up], [right, down], [left, down]];
    let bestGain = margin, bk = -1, bl = -1;
    for (let k = 0; k < 4; k++) {
      // the opposite quadrant must still clearly belong to A
      const opp = (k + 2) % 4;
      for (const B of share[k]) {
        if (B < 0 || B === A) continue;
        const kind = labels[B].kind;
        if (kind !== "solid" && kind !== "bare") continue;
        if (d(c, opp, B) < d(c, opp, A)) continue;
        const gain = d(c, k, A) - d(c, k, B);
        if (gain > bestGain) { bestGain = gain; bk = k; bl = B; }
      }
    }
    if (bk >= 0) { corner[c] = bk; minority[c] = bl; }
  }
  return { corner, minority };
}

// ─── Chart: the whole pipeline ───────────────────────────────────────────

export type ChartOpts = PaletteOpts & LabelOpts & AssignOpts & {
  cols: number;
  sharpness?: number;
  fractional?: boolean;
};

export type Chart = {
  cols: number;
  rows: number;
  palette: Cone[];
  labels: Label[];
  cell: Int16Array;
  corner: Int8Array;
  minority: Int16Array;
  targets: CellTargets;
  /** Mean OKLab error ×100 (≈ just-noticeable units: ~2 is a JND). */
  meanError: number;
  /** Stitched single-cell regions (confetti) - each one costs a jump. */
  islands: number;
};

/** Count stitched 4-connected regions of exactly one cell. */
export function countIslands(cols: number, rows: number, cell: Int16Array, labels: Label[]): number {
  let k = 0;
  for (let c = 0; c < cols * rows; c++) {
    if (labels[cell[c]]?.kind === "bare") continue;
    const gx = c % cols, gy = (c / cols) | 0, l = cell[c];
    if (gx > 0 && cell[c - 1] === l) continue;
    if (gx < cols - 1 && cell[c + 1] === l) continue;
    if (gy > 0 && cell[c - cols] === l) continue;
    if (gy < rows - 1 && cell[c + cols] === l) continue;
    k++;
  }
  return k;
}

export function buildChart(p: PreparedImage, o: ChartOpts): Chart {
  const targets = sampleCells(p, o.cols, o.sharpness ?? 0);
  let palette = selectPalette(targets, o);
  let labels = buildLabels(palette, o);
  let cell = assignLabels(targets, labels, o);
  const n = targets.cols * targets.rows;
  // Drop cones no cell ended up using (blends, bare fabric or the cleanup
  // can make a selected cone redundant), so the list matches the file.
  const used = new Set<number>();
  for (let c = 0; c < n; c++) { const l = labels[cell[c]]; if (l.fwd >= 0) used.add(l.fwd); if (l.back >= 0) used.add(l.back); }
  if (used.size > 0 && used.size < palette.length) {
    const keep = palette.map((_, i) => i).filter((i) => used.has(i));
    const remap = new Map(keep.map((old, ni) => [old, ni]));
    const next = buildLabels(keep.map((i) => palette[i]), o);
    const key = (kind: string, f: number, b: number) => `${kind}:${f}:${b}`;
    const at = new Map(next.map((l, i) => [key(l.kind, l.fwd, l.back), i]));
    const map = labels.map((l) => at.get(key(l.kind, l.fwd < 0 ? -1 : remap.get(l.fwd) ?? -9, l.back < 0 ? -1 : remap.get(l.back) ?? -9)) ?? -1);
    cell = cell.map((v) => map[v]);
    palette = keep.map((i) => palette[i]);
    labels = next;
  }
  const frac = o.fractional
    ? fractionalCorners(targets, cell, labels, o.toneWeight ?? 1)
    : { corner: new Int8Array(n).fill(-1), minority: new Int16Array(n).fill(-1) };
  let e = 0;
  for (let c = 0; c < n; c++) {
    const l = labels[cell[c]].ok;
    e += Math.sqrt((targets.ok[c * 3] - l[0]) ** 2 + (targets.ok[c * 3 + 1] - l[1]) ** 2 + (targets.ok[c * 3 + 2] - l[2]) ** 2);
  }
  return {
    cols: targets.cols, rows: targets.rows, palette, labels, cell, ...frac, targets,
    meanError: (e / Math.max(1, n)) * 100,
    islands: countIslands(targets.cols, targets.rows, cell, labels),
  };
}

/** Per-cell error (OKLab ΔE ×100) for the error-map view. */
export function cellErrors(ch: Chart): Float32Array {
  const n = ch.cols * ch.rows;
  const out = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    const l = ch.labels[ch.cell[c]].ok, t = ch.targets.ok;
    out[c] = Math.sqrt((t[c * 3] - l[0]) ** 2 + (t[c * 3 + 1] - l[1]) ** 2 + (t[c * 3 + 2] - l[2]) ** 2) * 100;
  }
  return out;
}

/** Cells per palette cone, counting each leg as half a cell. */
export function coneUsage(ch: Chart): number[] {
  const use = new Array(ch.palette.length).fill(0);
  for (let c = 0; c < ch.cell.length; c++) {
    const l = ch.labels[ch.cell[c]];
    if (l.fwd >= 0) use[l.fwd] += 0.5;
    if (l.back >= 0) use[l.back] += 0.5;
  }
  return use;
}

// ─── Geometry + routing: the half-leg lattice ────────────────────────────
//
// Lattice in half-cell units: cell (x, y) has corners at (2x, 2y) + offset
// (TL, TR, BR, BL) and its center at (2x+1, 2y+1). Each cell carries, per
// cone, a 4-bit mask of the half-legs (center → corner) sewn in that cone.
// A full "/" is TR|BL, a full "\" is TL|BR; a three-quarter stitch is one full
// leg plus one half; a quarter is a single half.

const CORNER_OFF: readonly (readonly [number, number])[] = [[0, 0], [2, 0], [2, 2], [0, 2]]; // TL TR BR BL
const FWD = 2 | 8; // "/" = TR | BL
const BACK = 1 | 4; // "\" = TL | BR

export type StitchOpts = {
  cellMm: number;
  /** "continuous": Eulerian trails over half-legs - fewest strokes.
   *  "consistent": diagonal chains - every top leg points the same way. */
  route?: "continuous" | "consistent";
  /** 2 = each leg sewn there-and-back: bolder coverage, even degrees. */
  passes?: 1 | 2;
  /** Tiny lock stitches at the start and end of every stroke. */
  locks?: boolean;
  /** Sew order of cones. */
  order?: "light-first" | "dark-first" | "palette";
  /** Shortest leg allowed (mm). Quarter stitches shorter than this are dropped
   *  back to a full cross. */
  minLegMm?: number;
  /** Consistent mode: when no hidden route exists, allow one visible stitch
   *  along a cell side instead of a jump (how machine half-stitch travels). */
  sideTravel?: boolean;
  /** Consistent mode: longest hidden travel, in cells. Travel re-sews legs
   *  already laid, and a long straight run of doubled legs reads as a line;
   *  past this a jump (and the machine's trim) is cleaner. */
  maxTravelCells?: number;
};

export type StitchPlan = {
  groups: PathMm[][];
  colors: string[];
  /** Palette index of each group. */
  coneOf: number[];
  /** Strokes in total; each stroke after a cone's first starts with a jump. */
  strokes: number;
  /** Half-legs sewn more than once (postman doubling or hidden travel). */
  extraHalfLegs: number;
};

/** Per-cone half-leg masks for every cell. */
export function coneMasks(ch: Chart, cellMm: number, minLegMm = 1): Uint8Array[] {
  const n = ch.cols * ch.rows;
  const masks = ch.palette.map(() => new Uint8Array(n));
  const quarterOk = (cellMm * Math.SQRT2) / 2 >= minLegMm;
  for (let c = 0; c < n; c++) {
    const l = ch.labels[ch.cell[c]];
    const k = quarterOk && l.kind === "solid" ? ch.corner[c] : -1;
    if (k >= 0) {
      const onBack = k === 0 || k === 2; // corner k lies on the "\" diagonal
      masks[l.fwd][c] |= (onBack ? FWD : BACK) | (1 << ((k + 2) % 4));
      const B = ch.labels[ch.minority[c]];
      if (B && B.kind === "solid") masks[B.fwd][c] |= 1 << k;
      continue;
    }
    if (l.fwd >= 0) masks[l.fwd][c] |= FWD;
    if (l.back >= 0) masks[l.back][c] |= BACK;
  }
  return masks;
}

/** Diagonal-chain method on one cone's mask (all "/" then all "\" per
 *  region). Returns strokes as flat lattice [X, Y, ...]. */
export function routeConsistent(
  mask: Uint8Array, cols: number, rows: number, passes: 1 | 2, sideTravel: boolean, maxTravelCells = 4,
): { strokes: number[][]; extra: number } {
  const maxSteps = Math.max(2, Math.round(maxTravelCells * 2));
  const W = 2 * cols + 1;
  const strokes: number[][] = [];
  let cur: number[] | null = null;
  let extra = 0;
  const nbrs = (X: number, Y: number, out: number[]) => {
    out.length = 0;
    if (X & 1) {
      const cx = (X - 1) >> 1, cy = (Y - 1) >> 1, m = mask[cy * cols + cx];
      for (let k = 0; k < 4; k++) if (m & (1 << k)) out.push(2 * cx + CORNER_OFF[k][0], 2 * cy + CORNER_OFF[k][1]);
    } else {
      const hx = X >> 1, hy = Y >> 1;
      const cells: [number, number, number][] = [[hx - 1, hy - 1, 2], [hx, hy - 1, 3], [hx - 1, hy, 1], [hx, hy, 0]];
      for (const [cx, cy, k] of cells) {
        if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
        if (mask[cy * cols + cx] & (1 << k)) out.push(2 * cx + 1, 2 * cy + 1);
      }
    }
  };
  const nb: number[] = [];
  // Shortest hidden route (along this cone's own half-legs), ≤ maxD steps.
  const bfs = (sx: number, sy: number, tx: number, ty: number, maxD: number): number[] | null => {
    const start = sy * W + sx, goal = ty * W + tx;
    const prev = new Map<number, number>([[start, -1]]);
    let frontier = [start];
    for (let d = 0; d < maxD && frontier.length; d++) {
      const next: number[] = [];
      for (const node of frontier) {
        nbrs(node % W, (node / W) | 0, nb);
        for (let i = 0; i < nb.length; i += 2) {
          const id = nb[i + 1] * W + nb[i];
          if (prev.has(id)) continue;
          prev.set(id, node);
          if (id === goal) {
            const path: number[] = [];
            for (let p = id; p !== start; p = prev.get(p)!) path.unshift(p % W, (p / W) | 0);
            return path;
          }
          next.push(id);
        }
      }
      frontier = next;
    }
    return null;
  };
  const goTo = (X: number, Y: number) => {
    if (cur) {
      const cx = cur[cur.length - 2], cy = cur[cur.length - 1];
      if (cx === X && cy === Y) return;
      const path = bfs(cx, cy, X, Y, maxSteps);
      if (path) { cur.push(...path); extra += path.length / 2; return; }
      if (sideTravel && ((Math.abs(cx - X) === 2 && cy === Y) || (cx === X && Math.abs(cy - Y) === 2))) {
        cur.push(X, Y);
        return;
      }
    }
    cur = [X, Y];
    strokes.push(cur);
  };
  const corner = (x: number, y: number, k: number): [number, number] => [2 * x + CORNER_OFF[k][0], 2 * y + CORNER_OFF[k][1]];
  const leg = (x: number, y: number, from: number, to: number) => {
    const [ax, ay] = corner(x, y, from), [bx, by] = corner(x, y, to);
    goTo(ax, ay);
    cur!.push(2 * x + 1, 2 * y + 1, bx, by);
    if (passes === 2) cur!.push(2 * x + 1, 2 * y + 1, ax, ay);
  };
  const half = (x: number, y: number, k: number) => {
    const [ax, ay] = corner(x, y, k);
    goTo(ax, ay);
    cur!.push(2 * x + 1, 2 * y + 1);
    if (passes === 2) cur!.push(ax, ay);
  };
  // Regions: cells joined through a shared corner that both sew to. The row
  // method runs one region at a time, so it never bounces between regions
  // (a jump per row) - each region ideally becomes a single stroke.
  const parent = new Int32Array(cols * rows).map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const cornerOwner = new Map<number, number>();
  for (let c = 0; c < cols * rows; c++) {
    const m = mask[c];
    if (!m) continue;
    const x = c % cols, y = (c / cols) | 0;
    for (let k = 0; k < 4; k++) {
      if (!(m & (1 << k))) continue;
      const id = (2 * y + CORNER_OFF[k][1]) * W + 2 * x + CORNER_OFF[k][0];
      const o = cornerOwner.get(id);
      if (o === undefined) cornerOwner.set(id, c);
      else parent[find(c)] = find(o);
    }
  }
  const regions = new Map<number, number[]>(); // insertion = row-major first cell
  for (let c = 0; c < cols * rows; c++) {
    if (!mask[c]) continue;
    const r = find(c);
    const list = regions.get(r);
    if (list) list.push(c); else regions.set(r, [c]);
  }
  // Group a region's cells into diagonal chains: key(x, y) → sorted xs.
  const chains = (cells: number[], key: (x: number, y: number) => number) => {
    const by = new Map<number, number[]>();
    for (const c of cells) {
      const x = c % cols, y = (c / cols) | 0, k = key(x, y);
      const l = by.get(k);
      if (l) l.push(x); else by.set(k, [x]);
    }
    return [...by.entries()].sort((p, q) => p[0] - q[0]).map(([k, xs]) => [k, xs.sort((p, q) => p - q)] as const);
  };
  // Sew chains serpentine. Of the four sweeps (chain order × first direction)
  // start with the one whose first corner is nearest the needle.
  type Chains = ReturnType<typeof chains>;
  const sweep = (cs: Chains, yOf: (k: number, x: number) => number, lo: number, hi: number) => {
    if (!cs.length) return;
    const options: [Chains, boolean][] = [[cs, false], [cs, true], [[...cs].reverse(), false], [[...cs].reverse(), true]];
    const startOf = ([list, flip]: [Chains, boolean]) => {
      const [k, xs] = list[0];
      const x = flip ? xs[xs.length - 1] : xs[0];
      return corner(x, yOf(k, x), flip ? hi : lo);
    };
    let pick = options[0];
    if (cur) {
      const cx = cur[cur.length - 2], cy = cur[cur.length - 1];
      let bd = Infinity;
      for (const o of options) {
        const [sx, sy] = startOf(o);
        const d = Math.abs(sx - cx) + Math.abs(sy - cy);
        if (d < bd) { bd = d; pick = o; }
      }
    }
    const list = pick[0];
    let flip = pick[1];
    for (const [k, xs] of list) {
      const seq = flip ? [...xs].reverse() : xs;
      for (const x of seq) leg(x, yOf(k, x), flip ? hi : lo, flip ? lo : hi);
      flip = !flip;
    }
  };
  for (const cells of regions.values()) {
    // Pass A: every "/" along anti-diagonals (x + y = d). One cell's TR is the
    // next cell's BL, so a chain is one unbroken line; serpentine between
    // chains, so travel is a couple of half-legs per diagonal, not per leg.
    sweep(chains(cells.filter((c) => (mask[c] & FWD) === FWD), (x, y) => x + y), (k, x) => k - x, 3, 1);
    // Pass B: every "" along main diagonals (x - y = e), after all "/" - so
    // each cell's top leg is "".
    sweep(chains(cells.filter((c) => (mask[c] & BACK) === BACK), (x, y) => x - y), (k, x) => x - k, 0, 2);
    // Loose half-legs (three-quarter and quarter stitches) last, nearest
    // first, so the needle doesn't cross the region for each one.
    const loose: [number, number, number][] = [];
    for (const c of cells) {
      const m = mask[c], x = c % cols, y = (c / cols) | 0;
      for (let k = 0; k < 4; k++) {
        const bit = 1 << k;
        if (!(m & bit)) continue;
        const whole = FWD & bit ? (m & FWD) === FWD : (m & BACK) === BACK;
        if (!whole) loose.push([x, y, k]);
      }
    }
    while (loose.length) {
      let bi = 0;
      const at = cur as number[] | null; // assigned in closures; TS can't see it
      if (at) {
        const cx = at[at.length - 2], cy = at[at.length - 1];
        let bd = Infinity;
        loose.forEach(([x, y, k], i) => {
          const [ax, ay] = corner(x, y, k);
          const d = Math.abs(ax - cx) + Math.abs(ay - cy);
          if (d < bd) { bd = d; bi = i; }
        });
      }
      const [x, y, k] = loose.splice(bi, 1)[0];
      half(x, y, k);
    }
  }
  return { strokes, extra };
}

export function planStitches(ch: Chart, o: StitchOpts): StitchPlan {
  const { cols, rows } = ch;
  const s = o.cellMm;
  const ox = (-cols * s) / 2, oy = (-rows * s) / 2;
  const masks = coneMasks(ch, s, o.minLegMm ?? 1);
  const passes = o.passes ?? 1;
  const toMm = (X: number, Y: number) => ({ x: ox + (X * s) / 2, y: oy + (Y * s) / 2 });

  const lum = (hex: string) => { const [r, g, b] = hexToLin(hex); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const idx = ch.palette.map((_, i) => i);
  if (o.order === "light-first") idx.sort((a, b) => lum(ch.palette[b].hex) - lum(ch.palette[a].hex));
  else if (o.order === "dark-first") idx.sort((a, b) => lum(ch.palette[a].hex) - lum(ch.palette[b].hex));

  const groups: PathMm[][] = [];
  const coneOf: number[] = [];
  let strokes = 0, extra = 0;
  for (const i of idx) {
    const mask = masks[i];
    let paths: PathMm[] = [];
    if ((o.route ?? "continuous") === "consistent") {
      const r = routeConsistent(mask, cols, rows, passes, o.sideTravel ?? true, o.maxTravelCells ?? 4);
      paths = r.strokes.map((st) => { const p: PathMm = []; for (let j = 0; j < st.length; j += 2) p.push(toMm(st[j], st[j + 1])); return p; });
      extra += r.extra;
    } else {
      const segs: Segment[] = [];
      for (let c = 0; c < mask.length; c++) {
        const m = mask[c];
        if (!m) continue;
        const x = c % cols, y = (c / cols) | 0;
        const ctr = toMm(2 * x + 1, 2 * y + 1);
        for (let k = 0; k < 4; k++) {
          if (!(m & (1 << k))) continue;
          const seg: Segment = [toMm(2 * x + CORNER_OFF[k][0], 2 * y + CORNER_OFF[k][1]), ctr];
          segs.push(seg);
          if (passes === 2) segs.push(seg);
        }
      }
      if (segs.length) {
        const r = planStrokes(segs, Math.max(0.01, s * 0.05));
        paths = r.strokes;
        extra += r.stats.duplicatedEdges;
      }
    }
    paths = paths.filter((p) => p.length >= 2);
    if (!paths.length) continue;
    if (o.locks ?? true) paths = paths.map(withLocks);
    strokes += paths.length;
    groups.push(paths);
    coneOf.push(i);
  }
  return { groups, colors: coneOf.map((i) => ch.palette[i].hex), coneOf, strokes, extraHalfLegs: extra };
}

/** Tie-in and tie-off: a 0.5 mm stitch back along the first and last legs and
 *  return, so a stroke that starts after a jump or ends before one holds. */
export function withLocks(path: PathMm): PathMm {
  if (path.length < 2) return path;
  const back = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const t = Math.min(0.5, L / 3) / L;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
  const a0 = path[0], a1 = path[1];
  const z0 = path[path.length - 1], z1 = path[path.length - 2];
  return [a0, back(a0, a1), a0, ...path.slice(1), back(z0, z1), z0];
}
