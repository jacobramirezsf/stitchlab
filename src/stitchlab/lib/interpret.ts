// Photo interpretation core - pure functions, no DOM, unit-testable. One
// analysis pass (luminance grid, k-means spot palette, flow field) feeds
// every visual style; styles emit MARKS - {x, y, r, colorIdx, glyph, angle,
// order} in normalized 0..1 space - so any style renders at any resolution
// and every mark carries a time coordinate, which is what makes all of them
// animatable for free.

export type ImgLike = { data: Uint8ClampedArray; width: number; height: number };

export type Grid = { cols: number; rows: number; v: Float32Array };

export type Mark = {
  x: number; // 0..1 of image width
  y: number; // 0..1 of image height
  r: number; // radius as a fraction of image width
  colorIdx: number;
  glyph?: string; // marks style: which glyph to draw
  angle?: number; // radians, from the flow field
  order: number; // 0..1 assembly time
};

export type StyleId = "dotgrid" | "scatter" | "blobs" | "marks" | "riso";
export type OrderMode = "darkness" | "sweep" | "radial" | "shuffle";

// deterministic LCG so previews, exports, and tests all agree
export function rng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const lumOf = (r: number, g: number, b: number) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;

// ── analysis ─────────────────────────────────────────────────────────────

/** Per-cell mean luminance (0 dark..1 light) and alpha coverage. */
export function luminanceGrid(img: ImgLike, cols: number): Grid & { alpha: Float32Array } {
  const rows = Math.max(1, Math.round((cols * img.height) / img.width));
  const v = new Float32Array(cols * rows);
  const alpha = new Float32Array(cols * rows);
  const cw = img.width / cols, ch = img.height / rows;
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      let sum = 0, aSum = 0, n = 0;
      const x0 = Math.floor(gx * cw), x1 = Math.min(img.width, Math.ceil((gx + 1) * cw));
      const y0 = Math.floor(gy * ch), y1 = Math.min(img.height, Math.ceil((gy + 1) * ch));
      const step = Math.max(1, Math.floor((x1 - x0) / 6));
      for (let y = y0; y < y1; y += step) {
        for (let x = x0; x < x1; x += step) {
          const i = (y * img.width + x) * 4;
          const a = img.data[i + 3] / 255;
          sum += lumOf(img.data[i], img.data[i + 1], img.data[i + 2]) * a + (1 - a); // transparent reads light
          aSum += a;
          n++;
        }
      }
      v[gy * cols + gx] = n ? sum / n : 1;
      alpha[gy * cols + gx] = n ? aSum / n : 0;
    }
  }
  return { cols, rows, v, alpha };
}

/** k-means over sampled opaque pixels; returns palette dark→light as [r,g,b]. */
export function kmeansPalette(img: ImgLike, k: number, seed = 7, maxSamples = 4000): [number, number, number][] {
  const rand = rng(seed);
  const samples: [number, number, number][] = [];
  const total = img.width * img.height;
  const stride = Math.max(1, Math.floor(total / maxSamples));
  for (let p = Math.floor(rand() * stride); p < total; p += stride) {
    const i = p * 4;
    if (img.data[i + 3] < 40) continue;
    samples.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
  }
  if (!samples.length) return [[17, 17, 17]];
  const kk = Math.max(1, Math.min(k, samples.length));
  // init: spread across the luminance range for stable, useful clusters
  const sorted = [...samples].sort((a, b) => lumOf(...a) - lumOf(...b));
  let centers: [number, number, number][] = Array.from({ length: kk }, (_, i) =>
    [...sorted[Math.floor(((i + 0.5) / kk) * (sorted.length - 1))]] as [number, number, number]
  );
  const assign = new Uint16Array(samples.length);
  for (let iter = 0; iter < 8; iter++) {
    for (let si = 0; si < samples.length; si++) {
      let best = 0, bd = Infinity;
      for (let ci = 0; ci < centers.length; ci++) {
        const d =
          (samples[si][0] - centers[ci][0]) ** 2 +
          (samples[si][1] - centers[ci][1]) ** 2 +
          (samples[si][2] - centers[ci][2]) ** 2;
        if (d < bd) { bd = d; best = ci; }
      }
      assign[si] = best;
    }
    const acc = centers.map(() => [0, 0, 0, 0]);
    for (let si = 0; si < samples.length; si++) {
      const a = acc[assign[si]];
      a[0] += samples[si][0]; a[1] += samples[si][1]; a[2] += samples[si][2]; a[3]++;
    }
    centers = centers.map((c, ci) =>
      acc[ci][3]
        ? ([acc[ci][0] / acc[ci][3], acc[ci][1] / acc[ci][3], acc[ci][2] / acc[ci][3]] as [number, number, number])
        : c
    );
  }
  return centers
    .map((c) => c.map(Math.round) as [number, number, number])
    .sort((a, b) => lumOf(...a) - lumOf(...b));
}

/** Nearest-palette-index grid (mean cell color → palette). */
export function colorGrid(img: ImgLike, cols: number, palette: [number, number, number][]): Grid {
  const rows = Math.max(1, Math.round((cols * img.height) / img.width));
  const v = new Float32Array(cols * rows);
  const cw = img.width / cols, ch = img.height / rows;
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      let r = 0, g = 0, b = 0, n = 0;
      const x0 = Math.floor(gx * cw), x1 = Math.min(img.width, Math.ceil((gx + 1) * cw));
      const y0 = Math.floor(gy * ch), y1 = Math.min(img.height, Math.ceil((gy + 1) * ch));
      const step = Math.max(1, Math.floor((x1 - x0) / 6));
      for (let y = y0; y < y1; y += step) {
        for (let x = x0; x < x1; x += step) {
          const i = (y * img.width + x) * 4;
          if (img.data[i + 3] < 40) continue;
          r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
        }
      }
      if (!n) { v[gy * cols + gx] = -1; continue; }
      r /= n; g /= n; b /= n;
      let best = 0, bd = Infinity;
      for (let ci = 0; ci < palette.length; ci++) {
        const d = (r - palette[ci][0]) ** 2 + (g - palette[ci][1]) ** 2 + (b - palette[ci][2]) ** 2;
        if (d < bd) { bd = d; best = ci; }
      }
      v[gy * cols + gx] = best;
    }
  }
  return { cols, rows, v };
}

/** Sobel flow on the luminance grid: angle of the local gradient (radians). */
export function flowField(g: Grid): Float32Array {
  const out = new Float32Array(g.cols * g.rows);
  const at = (x: number, y: number) =>
    g.v[Math.min(g.rows - 1, Math.max(0, y)) * g.cols + Math.min(g.cols - 1, Math.max(0, x))];
  for (let y = 0; y < g.rows; y++) {
    for (let x = 0; x < g.cols; x++) {
      const gx =
        -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) +
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
      const gy =
        -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) +
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      // marks run ALONG edges (perpendicular to the gradient)
      out[y * g.cols + x] = Math.atan2(gy, gx) + Math.PI / 2;
    }
  }
  return out;
}

// ── styles → marks ───────────────────────────────────────────────────────

export type StyleOpts = {
  cutoff: number; // 0..1: cells lighter than this produce nothing
  invert: boolean; // light-on-dark subjects
  minR: number; // fraction of cell (0..0.5)
  maxR: number; // fraction of cell
  jitter: number; // 0..1 of cell
  density: number; // scatter: marks per dark cell (0.2..4)
  glyphs: string[]; // marks style rotation set
  seed: number;
};

const darkness = (v: number, invert: boolean) => (invert ? v : 1 - v);

export function styleMarks(
  style: StyleId,
  lum: Grid & { alpha: Float32Array },
  color: Grid,
  flow: Float32Array,
  o: StyleOpts
): Mark[] {
  const rand = rng(o.seed);
  const cell = 1 / lum.cols;
  const out: Mark[] = [];
  if (style === "riso") return out; // riso renders from separations, not marks
  for (let y = 0; y < lum.rows; y++) {
    for (let x = 0; x < lum.cols; x++) {
      const i = y * lum.cols + x;
      if (lum.alpha[i] < 0.25) continue;
      const d = darkness(lum.v[i], o.invert);
      if (d <= o.cutoff) continue;
      const strength = (d - o.cutoff) / Math.max(1e-6, 1 - o.cutoff);
      const colorIdx = Math.max(0, color.v[i]);
      const cx = (x + 0.5) * cell;
      const yNorm = (y + 0.5) / lum.rows;
      const base = {
        colorIdx,
        angle: flow[i],
      };
      if (style === "scatter") {
        const n = Math.max(0, Math.round(strength * o.density * 3 * (0.5 + rand())));
        for (let m = 0; m < n; m++) {
          out.push({
            ...base,
            x: cx + (rand() - 0.5) * cell,
            y: yNorm + (rand() - 0.5) / lum.rows,
            r: cell * (o.minR + (o.maxR - o.minR) * (0.3 + 0.7 * rand()) * strength),
            order: 0,
          });
        }
      } else {
        out.push({
          ...base,
          x: cx + (rand() - 0.5) * cell * o.jitter,
          y: yNorm + (rand() - 0.5) * (1 / lum.rows) * o.jitter,
          r: cell * (o.minR + (o.maxR - o.minR) * strength),
          glyph: style === "marks" ? o.glyphs[Math.min(o.glyphs.length - 1, Math.floor(strength * o.glyphs.length))] : undefined,
          order: 0,
        });
      }
    }
  }
  return out;
}

// ── assembly: give every mark its moment ─────────────────────────────────

export function orderMarks(marks: Mark[], mode: OrderMode, seed = 1): Mark[] {
  const rand = rng(seed);
  const keyed = marks.map((m) => {
    let key: number;
    if (mode === "darkness") key = -m.r; // biggest (darkest) first
    else if (mode === "sweep") key = m.x + m.y * 0.15;
    else if (mode === "radial") key = Math.hypot(m.x - 0.5, m.y - 0.5);
    else key = rand();
    return { m, key };
  });
  keyed.sort((a, b) => a.key - b.key);
  const n = Math.max(1, keyed.length - 1);
  return keyed.map(({ m }, i) => ({ ...m, order: i / n }));
}

/**
 * Soft separation: for each cell, how much of each palette ink covers it.
 * Weight = inverse-distance softness to each palette color, scaled by
 * darkness so light cells carry little ink. Rows sum to <= 1.
 */
export function softColorWeights(
  img: ImgLike,
  cols: number,
  palette: [number, number, number][],
  invert = false
): { cols: number; rows: number; w: Float32Array[] } {
  const rows = Math.max(1, Math.round((cols * img.height) / img.width));
  const w = palette.map(() => new Float32Array(cols * rows));
  const cw = img.width / cols, ch = img.height / rows;
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const x0 = Math.floor(gx * cw), x1 = Math.min(img.width, Math.ceil((gx + 1) * cw));
      const y0 = Math.floor(gy * ch), y1 = Math.min(img.height, Math.ceil((gy + 1) * ch));
      const step = Math.max(1, Math.floor((x1 - x0) / 6));
      for (let y = y0; y < y1; y += step) {
        for (let x = x0; x < x1; x += step) {
          const i = (y * img.width + x) * 4;
          const al = img.data[i + 3] / 255;
          r += img.data[i] * al; g += img.data[i + 1] * al; b += img.data[i + 2] * al;
          a += al; n++;
        }
      }
      const idx = gy * cols + gx;
      if (!n || a / n < 0.25) continue;
      r /= a; g /= a; b /= a;
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const dark = invert ? lum : 1 - lum;
      // inverse-square distance softmax over the palette
      const inv = palette.map((c) => {
        const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
        return 1 / (1 + d / 900);
      });
      const sum = inv.reduce((x, y) => x + y, 0) || 1;
      for (let ci = 0; ci < palette.length; ci++) {
        w[ci][idx] = (inv[ci] / sum) * Math.min(1, dark * 1.35);
      }
    }
  }
  return { cols, rows, w };
}

/** Classic Risograph ink colors (community-standard hex approximations). */
export const RISO_INKS: { name: string; hex: string }[] = [
  { name: "Black", hex: "#000000" },
  { name: "Blue", hex: "#0078bf" },
  { name: "Medium Blue", hex: "#3255a4" },
  { name: "Teal", hex: "#00838a" },
  { name: "Green", hex: "#00a95c" },
  { name: "Mint", hex: "#82d8d5" },
  { name: "Yellow", hex: "#ffe800" },
  { name: "Orange", hex: "#ff6c2f" },
  { name: "Bright Red", hex: "#f15060" },
  { name: "Fluor Pink", hex: "#ff48b0" },
  { name: "Burgundy", hex: "#914e72" },
  { name: "Purple", hex: "#765ba7" },
];

/** Map an arbitrary color to the nearest riso ink (auto ink assignment). */
export function nearestRisoInk(c: [number, number, number]): string {
  let best = RISO_INKS[0].hex, bd = Infinity;
  for (const ink of RISO_INKS) {
    const n = parseInt(ink.hex.slice(1), 16);
    const d =
      (c[0] - ((n >> 16) & 255)) ** 2 + (c[1] - ((n >> 8) & 255)) ** 2 + (c[2] - (n & 255)) ** 2;
    if (d < bd) { bd = d; best = ink.hex; }
  }
  return best;
}

export const hex = (c: [number, number, number]) =>
  "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

// ── deep-tool algorithms (stipple, strings, trails, shatter, contours) ───

export type StippleResult = { frames: Float32Array[]; count: number };

/**
 * Weighted Voronoi stippling (Secord 2002): rejection-sample seeds from
 * darkness, then Lloyd-relax each seed toward the darkness-weighted centroid
 * of its Voronoi cell. Every iteration's positions are kept so the tool can
 * ANIMATE the settle. Assignment runs on the luminance grid with a spatial
 * hash, so it stays interactive at thousands of points.
 */
export function stippleLloyd(
  lum: Grid & { alpha: Float32Array },
  n: number,
  iterations: number,
  seed: number,
  invert = false,
  cutoff = 0.08
): StippleResult {
  const rand = rng(seed);
  const { cols, rows } = lum;
  const dark = (i: number) => {
    if (lum.alpha[i] < 0.25) return 0;
    const d = invert ? lum.v[i] : 1 - lum.v[i];
    return d <= cutoff ? 0 : (d - cutoff) / (1 - cutoff);
  };
  // rejection sampling
  const pts = new Float32Array(n * 2);
  let placed = 0, guard = n * 400;
  while (placed < n && guard-- > 0) {
    const x = rand() * cols, y = rand() * rows;
    const i = Math.min(rows - 1, y | 0) * cols + Math.min(cols - 1, x | 0);
    if (rand() < dark(i)) {
      pts[placed * 2] = x; pts[placed * 2 + 1] = y;
      placed++;
    }
  }
  const count = placed;
  const frames: Float32Array[] = [pts.slice(0, count * 2)];
  if (!count) return { frames, count };

  const bucketSize = Math.max(2, Math.sqrt((cols * rows) / count) * 1.6);
  for (let it = 0; it < iterations; it++) {
    const cur = frames[frames.length - 1];
    // spatial hash of seeds
    const bw = Math.ceil(cols / bucketSize), bh = Math.ceil(rows / bucketSize);
    const buckets: number[][] = Array.from({ length: bw * bh }, () => []);
    for (let s = 0; s < count; s++) {
      const bx = Math.min(bw - 1, (cur[s * 2] / bucketSize) | 0);
      const by = Math.min(bh - 1, (cur[s * 2 + 1] / bucketSize) | 0);
      buckets[by * bw + bx].push(s);
    }
    const accX = new Float64Array(count), accY = new Float64Array(count), accW = new Float64Array(count);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const w = dark(y * cols + x);
        if (w <= 0) continue;
        const px = x + 0.5, py = y + 0.5;
        const bx = Math.min(bw - 1, (px / bucketSize) | 0);
        const by = Math.min(bh - 1, (py / bucketSize) | 0);
        let best = -1, bd = Infinity;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const bxx = bx + ox, byy = by + oy;
            if (bxx < 0 || byy < 0 || bxx >= bw || byy >= bh) continue;
            for (const s of buckets[byy * bw + bxx]) {
              const d = (cur[s * 2] - px) ** 2 + (cur[s * 2 + 1] - py) ** 2;
              if (d < bd) { bd = d; best = s; }
            }
          }
        }
        if (best < 0) {
          // sparse region: brute-force fallback
          for (let s = 0; s < count; s++) {
            const d = (cur[s * 2] - px) ** 2 + (cur[s * 2 + 1] - py) ** 2;
            if (d < bd) { bd = d; best = s; }
          }
        }
        accX[best] += px * w; accY[best] += py * w; accW[best] += w;
      }
    }
    const next = new Float32Array(count * 2);
    for (let s = 0; s < count; s++) {
      if (accW[s] > 0) {
        next[s * 2] = accX[s] / accW[s];
        next[s * 2 + 1] = accY[s] / accW[s];
      } else {
        next[s * 2] = cur[s * 2];
        next[s * 2 + 1] = cur[s * 2 + 1];
      }
    }
    frames.push(next);
  }
  return { frames, count };
}

export type StringArtResult = { pins: Float32Array; sequence: number[] };

/**
 * Greedy string art (the Vrellis-style residual method): pins around a
 * circle or rectangle; each step picks the chord that removes the most
 * remaining darkness per unit length, then subtracts the thread's opacity
 * along it. `budgetMs`+`yieldFn` let the tool run it in chunks off one
 * long task; pass neither for synchronous (tests).
 */
export async function stringChords(
  lum: Grid & { alpha: Float32Array },
  opts: {
    pins: number;
    lines: number;
    opacity: number; // darkness removed per pass 0..1
    invert?: boolean;
    frame?: "circle" | "rect";
    seed?: number;
    minSkip?: number; // avoid near-neighbor chords
    onProgress?: (done: number, total: number) => void;
    yieldFn?: () => Promise<void>;
  }
): Promise<StringArtResult> {
  const { cols, rows } = lum;
  const P = opts.pins;
  const pins = new Float32Array(P * 2);
  const cx = cols / 2, cy = rows / 2;
  for (let i = 0; i < P; i++) {
    if ((opts.frame ?? "circle") === "circle") {
      const a = (i / P) * Math.PI * 2 - Math.PI / 2;
      pins[i * 2] = cx + Math.cos(a) * (cols / 2 - 1);
      pins[i * 2 + 1] = cy + Math.sin(a) * (rows / 2 - 1);
    } else {
      // walk the rectangle perimeter
      const t = i / P, per = 2 * (cols + rows);
      let d = t * per;
      if (d < cols) { pins[i * 2] = d; pins[i * 2 + 1] = 0; }
      else if ((d -= cols) < rows) { pins[i * 2] = cols - 1; pins[i * 2 + 1] = d; }
      else if ((d -= rows) < cols) { pins[i * 2] = cols - 1 - d; pins[i * 2 + 1] = rows - 1; }
      else { d -= cols; pins[i * 2] = 0; pins[i * 2 + 1] = rows - 1 - d; }
    }
  }
  // residual darkness
  const res = new Float32Array(cols * rows);
  for (let i = 0; i < res.length; i++) {
    if (lum.alpha[i] < 0.25) continue;
    res[i] = opts.invert ? lum.v[i] : 1 - lum.v[i];
  }
  const minSkip = opts.minSkip ?? Math.max(2, Math.floor(P / 16));
  const scoreChord = (a: number, b: number): number => {
    const ax = pins[a * 2], ay = pins[a * 2 + 1], bx = pins[b * 2], by = pins[b * 2 + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(2, Math.min(64, len | 0));
    let sum = 0;
    for (let s = 0; s <= steps; s++) {
      const x = ax + ((bx - ax) * s) / steps, y = ay + ((by - ay) * s) / steps;
      sum += res[Math.min(rows - 1, y | 0) * cols + Math.min(cols - 1, x | 0)];
    }
    return sum / (steps + 1);
  };
  const subtractChord = (a: number, b: number) => {
    const ax = pins[a * 2], ay = pins[a * 2 + 1], bx = pins[b * 2], by = pins[b * 2 + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(2, (len * 1.5) | 0);
    for (let s = 0; s <= steps; s++) {
      const x = ax + ((bx - ax) * s) / steps, y = ay + ((by - ay) * s) / steps;
      const i = Math.min(rows - 1, y | 0) * cols + Math.min(cols - 1, x | 0);
      res[i] = Math.max(0, res[i] - opts.opacity);
    }
  };
  const sequence: number[] = [];
  let current = 0;
  const t0 = Date.now();
  let lastYield = t0;
  for (let line = 0; line < opts.lines; line++) {
    let best = -1, bs = 0.02; // stop threshold: chords must still earn ink
    for (let cand = 0; cand < P; cand++) {
      const skip = Math.abs(cand - current);
      if (Math.min(skip, P - skip) < minSkip) continue;
      const sc = scoreChord(current, cand);
      if (sc > bs) { bs = sc; best = cand; }
    }
    if (best < 0) break;
    subtractChord(current, best);
    sequence.push(best);
    current = best;
    opts.onProgress?.(line + 1, opts.lines);
    if (opts.yieldFn && Date.now() - lastYield > 28) {
      await opts.yieldFn();
      lastYield = Date.now();
    }
  }
  return { pins, sequence };
}

export type Trail = { pts: Float32Array; colorIdx: number };

/**
 * Flow-field trails: particles seeded in dark regions advect along the
 * photo's edge-following field (with an adjustable swirl blended in, the
 * classic generative flow-field move), leaving polyline trails.
 */
export function advectTrails(
  lum: Grid & { alpha: Float32Array },
  flow: Float32Array,
  color: Grid,
  opts: { count: number; steps: number; stepLen: number; swirl: number; seed: number; invert?: boolean }
): Trail[] {
  const rand = rng(opts.seed);
  const { cols, rows } = lum;
  const dark = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= cols || y >= rows) return 0;
    const i = (y | 0) * cols + (x | 0);
    if (lum.alpha[i] < 0.25) return 0;
    return opts.invert ? lum.v[i] : 1 - lum.v[i];
  };
  const angleAt = (x: number, y: number) => {
    const i = Math.min(rows - 1, Math.max(0, y | 0)) * cols + Math.min(cols - 1, Math.max(0, x | 0));
    const swirlA = Math.sin(x * 0.13 + opts.seed) + Math.cos(y * 0.11 - opts.seed);
    return flow[i] * (1 - opts.swirl) + swirlA * opts.swirl * Math.PI;
  };
  const trails: Trail[] = [];
  let guard = opts.count * 60;
  while (trails.length < opts.count && guard-- > 0) {
    const x0 = rand() * cols, y0 = rand() * rows;
    if (rand() > dark(x0, y0)) continue;
    const pts: number[] = [x0, y0];
    let x = x0, y = y0;
    for (let s = 0; s < opts.steps; s++) {
      const a = angleAt(x, y);
      // midpoint (RK2) step for smoother curves
      const mx = x + (Math.cos(a) * opts.stepLen) / 2;
      const my = y + (Math.sin(a) * opts.stepLen) / 2;
      const a2 = angleAt(mx, my);
      x += Math.cos(a2) * opts.stepLen;
      y += Math.sin(a2) * opts.stepLen;
      if (x < 0 || y < 0 || x >= cols || y >= rows || dark(x, y) <= 0.02) break;
      pts.push(x, y);
    }
    if (pts.length >= 8) {
      const i0 = Math.min(rows - 1, y0 | 0) * cols + Math.min(cols - 1, x0 | 0);
      trails.push({ pts: Float32Array.from(pts), colorIdx: Math.max(0, color.v[i0]) });
    }
  }
  return trails;
}

/** Chaikin corner-cutting - smooths grid-resolution contours beautifully. */
export function chaikin(pts: { x: number; y: number }[], iterations = 2): { x: number; y: number }[] {
  let p = pts;
  for (let it = 0; it < iterations; it++) {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    p = out;
  }
  return p;
}

export type Cell = { seed: [number, number]; poly: [number, number][] };

/**
 * Approximate Voronoi cells by half-plane clipping against the k nearest
 * neighbors - exact enough for mosaic shatter, no geometry library needed.
 */
export function voronoiCells(n: number, aspect: number, seed: number, kNeighbors = 12): Cell[] {
  const rand = rng(seed);
  const seeds: [number, number][] = Array.from({ length: n }, () => [rand(), rand() * aspect]);
  const cells: Cell[] = [];
  for (let i = 0; i < n; i++) {
    const [sx, sy] = seeds[i];
    // start from the bounding box
    let poly: [number, number][] = [[0, 0], [1, 0], [1, aspect], [0, aspect]];
    const others = seeds
      .map((p, j) => ({ p, d: j === i ? Infinity : (p[0] - sx) ** 2 + (p[1] - sy) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, kNeighbors);
    for (const { p } of others) {
      if (!isFinite(p[0])) continue;
      const mx = (sx + p[0]) / 2, my = (sy + p[1]) / 2;
      const nx = p[0] - sx, ny = p[1] - sy;
      const next: [number, number][] = [];
      for (let a = 0; a < poly.length; a++) {
        const A = poly[a], B = poly[(a + 1) % poly.length];
        const da = (A[0] - mx) * nx + (A[1] - my) * ny;
        const db = (B[0] - mx) * nx + (B[1] - my) * ny;
        if (da <= 0) next.push(A);
        if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
          const t = da / (da - db);
          next.push([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]);
        }
      }
      poly = next;
      if (poly.length < 3) break;
    }
    if (poly.length >= 3) cells.push({ seed: seeds[i], poly });
  }
  return cells;
}
