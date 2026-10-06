// Photo → clean line art, the Coherent Line Drawing pipeline (Kang, Lee &
// Chui, NPAR 2007): build an Edge Tangent Flow (a smoothed field of edge
// directions where strong edges win), then run a difference-of-Gaussians
// filter ACROSS the flow while accumulating ALONG it - noisy fragments die,
// coherent lines survive. Followed by Zhang–Suen thinning to one-pixel
// skeletons and junction-aware tracing into polylines. Everything typed-array,
// deterministic, DOM-free.

import type { PathMm } from "./generators";

export type LumImage = { w: number; h: number; lum: Float32Array };

/**
 * Percentile contrast stretch: map the 2nd–98th luminance percentiles to
 * [0,1] so photos with washed-out or crushed tone all present the edge
 * detector a comparable signal. Returns a new image; input untouched.
 */
export function normalizeContrast(img: LumImage): LumImage {
  const n = img.w * img.h;
  const sorted = Float32Array.from(img.lum).sort();
  const lo = sorted[Math.floor(n * 0.02)];
  const hi = sorted[Math.floor(n * 0.98)];
  const range = hi - lo || 1;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = Math.min(1, Math.max(0, (img.lum[i] - lo) / range));
  return { w: img.w, h: img.h, lum };
}

// ─── Edge Tangent Flow ───────────────────────────────────────────────────

export type Etf = { w: number; h: number; tx: Float32Array; ty: Float32Array; mag: Float32Array };

export function edgeTangentFlow(img: LumImage, radius = 5, iterations = 2): Etf {
  const { w, h, lum } = img;
  const n = w * h;
  const tx = new Float32Array(n);
  const ty = new Float32Array(n);
  const mag = new Float32Array(n);
  const at = (x: number, y: number) =>
    lum[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];

  // Init: normalized gradient rotated 90° (tangent), magnitude kept.
  let maxMag = 1e-9;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) -
        at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const gy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) -
        at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      const i = y * w + x;
      const m = Math.hypot(gx, gy);
      mag[i] = m;
      if (m > maxMag) maxMag = m;
      if (m > 1e-9) {
        tx[i] = -gy / m;
        ty[i] = gx / m;
      }
    }
  }
  for (let i = 0; i < n; i++) mag[i] /= maxMag;

  // Iterative smoothing: box kernel, magnitude + direction weights, sign flip.
  let curX = tx;
  let curY = ty;
  for (let pass = 0; pass < iterations; pass++) {
    const nX = new Float32Array(n);
    const nY = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const cx = curX[i];
        const cy = curY[i];
        let sx = 0;
        let sy = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            const dot = cx * curX[j] + cy * curY[j];
            const phi = dot >= 0 ? 1 : -1;
            const wm = 0.5 * (1 + Math.tanh(mag[j] - mag[i]));
            const wd = Math.abs(dot);
            sx += phi * curX[j] * wm * wd;
            sy += phi * curY[j] * wm * wd;
          }
        }
        const len = Math.hypot(sx, sy);
        if (len > 1e-9) {
          nX[i] = sx / len;
          nY[i] = sy / len;
        } else {
          nX[i] = cx;
          nY[i] = cy;
        }
      }
    }
    curX = nX;
    curY = nY;
  }
  return { w, h, tx: curX, ty: curY, mag };
}

// ─── Flow-based DoG ──────────────────────────────────────────────────────

export type FdogOpts = {
  sigmaC?: number; // cross-flow DoG center sigma, default 1.0 (surround = 1.6×)
  sigmaM?: number; // along-flow accumulation sigma, default 3.0
  rho?: number; // DoG inhibition, default 0.99
  tau?: number; // threshold, default 0.5
  passes?: number; // re-application count, default 2
};

/** Returns a binary edge map (1 = line pixel). */
export function flowDoG(img: LumImage, etf: Etf, opts: FdogOpts = {}): Uint8Array {
  const sigmaC = opts.sigmaC ?? 1.0;
  const sigmaS = 1.6 * sigmaC;
  const sigmaM = opts.sigmaM ?? 3.0;
  const rho = opts.rho ?? 0.99;
  const tau = opts.tau ?? 0.5;
  const passes = Math.max(1, opts.passes ?? 2);
  const { w, h } = img;
  const n = w * h;

  const lum = new Float32Array(img.lum); // working copy (passes superimpose)
  const g = (s: number, t: number) => Math.exp(-(t * t) / (2 * s * s)) / (Math.sqrt(2 * Math.PI) * s);
  const halfT = Math.max(2, Math.ceil(sigmaS * 2));
  const halfS = Math.max(2, Math.ceil(sigmaM * 2));
  const out = new Uint8Array(n);

  const sample = (x: number, y: number): number => {
    const xi = Math.min(w - 1, Math.max(0, Math.round(x)));
    const yi = Math.min(h - 1, Math.max(0, Math.round(y)));
    return lum[yi * w + xi];
  };
  const dir = (x: number, y: number): [number, number] => {
    const xi = Math.min(w - 1, Math.max(0, Math.round(x)));
    const yi = Math.min(h - 1, Math.max(0, Math.round(y)));
    const i = yi * w + xi;
    return [etf.tx[i], etf.ty[i]];
  };

  const response = new Float32Array(n);
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Accumulate the cross-flow DoG along the streamline through (x,y).
        let H = 0;
        let wSum = 0;
        for (const sgn of [1, -1]) {
          let px = x;
          let py = y;
          for (let s = sgn === 1 ? 0 : 1; s <= halfS; s++) {
            const gm = g(sigmaM, s);
            // 1-D DoG perpendicular to the flow at this streamline point.
            const [dx, dy] = dir(px, py);
            const nx2 = -dy;
            const ny2 = dx;
            let F = 0;
            for (let t = -halfT; t <= halfT; t++) {
              const v = sample(px + nx2 * t, py + ny2 * t);
              F += v * (g(sigmaC, t) - rho * g(sigmaS, t));
            }
            H += gm * F;
            wSum += gm;
            px += dx * sgn;
            py += dy * sgn;
            if (px < 0 || px >= w || py < 0 || py >= h) break;
          }
        }
        response[y * w + x] = wSum > 0 ? H / wSum : 0;
      }
    }
    // ADAPTIVE THRESHOLD: an edge candidate has negative DoG response; keep the
    // strongest `tau` fraction of candidates by magnitude. This is robust to any
    // photo's absolute response scale - the old fixed tanh(H·40) constant only
    // fit the one synthetic test image and produced all-or-nothing on real ones.
    const mags: number[] = [];
    for (let i = 0; i < n; i++) if (response[i] < 0) mags.push(-response[i]);
    mags.sort((a, b) => a - b);
    const frac = Math.min(0.6, Math.max(0.02, tau * 0.5));
    const cutoff = mags.length ? mags[Math.floor(mags.length * (1 - frac))] : 0;
    for (let i = 0; i < n; i++) out[i] = response[i] < 0 && -response[i] >= cutoff ? 1 : 0;
    if (pass < passes - 1) {
      // Superimpose found edges into the source and refilter - solidifies lines.
      for (let i = 0; i < n; i++) if (out[i]) lum[i] = 0;
    }
  }
  return out;
}

// ─── Zhang–Suen thinning ─────────────────────────────────────────────────

export function thin(binary: Uint8Array, w: number, h: number): Uint8Array {
  const img = new Uint8Array(binary);
  const idx = (x: number, y: number) => y * w + x;
  const p = (x: number, y: number) => (x < 0 || x >= w || y < 0 || y >= h ? 0 : img[idx(x, y)]);
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 200) {
    changed = false;
    for (const phase of [0, 1]) {
      const kill: number[] = [];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!p(x, y)) continue;
          const n2 = p(x, y - 1);
          const n3 = p(x + 1, y - 1);
          const n4 = p(x + 1, y);
          const n5 = p(x + 1, y + 1);
          const n6 = p(x, y + 1);
          const n7 = p(x - 1, y + 1);
          const n8 = p(x - 1, y);
          const n9 = p(x - 1, y - 1);
          const B = n2 + n3 + n4 + n5 + n6 + n7 + n8 + n9;
          if (B < 2 || B > 6) continue;
          const seq = [n2, n3, n4, n5, n6, n7, n8, n9, n2];
          let A = 0;
          for (let k = 0; k < 8; k++) if (seq[k] === 0 && seq[k + 1] === 1) A++;
          if (A !== 1) continue;
          if (phase === 0) {
            if (n2 * n4 * n6 !== 0 || n4 * n6 * n8 !== 0) continue;
          } else {
            if (n2 * n4 * n8 !== 0 || n2 * n6 * n8 !== 0) continue;
          }
          kill.push(idx(x, y));
        }
      }
      if (kill.length) changed = true;
      for (const i of kill) img[i] = 0;
    }
  }
  return img;
}

// ─── Skeleton tracing ────────────────────────────────────────────────────

/**
 * Trace a 1-px skeleton into polylines (pixel coordinates). Junction pixels
 * (≥3 neighbors) and endpoints break paths; closed loops become closed
 * polylines. Greedy but deterministic (scan order).
 */
export function traceSkeleton(skel: Uint8Array, w: number, h: number): PathMm[] {
  const at = (x: number, y: number) =>
    x >= 0 && x < w && y >= 0 && y < h && skel[y * w + x] === 1;
  const N8 = [
    [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
  ] as const;
  // Thinned skeletons leave redundant diagonal adjacencies along 45°
  // staircases (a pixel touches both an orthogonal neighbor and the diagonal
  // beyond it), which would make every staircase pixel look like a junction.
  // A diagonal connection only counts when neither of its two corner
  // orthogonals is set.
  const connected = (x: number, y: number, dx: number, dy: number): boolean => {
    if (!at(x + dx, y + dy)) return false;
    if (dx !== 0 && dy !== 0 && (at(x + dx, y) || at(x, y + dy))) return false;
    return true;
  };
  const degree = (x: number, y: number) => {
    let d = 0;
    for (const [dx, dy] of N8) if (connected(x, y, dx, dy)) d++;
    return d;
  };
  const usedEdge = new Set<string>();
  const ekey = (a: number, b: number) => (a < b ? a + ":" + b : b + ":" + a);
  const paths: PathMm[] = [];

  const walk = (sx: number, sy: number, fx: number, fy: number) => {
    const path: PathMm = [{ x: sx, y: sy }];
    let px = sx;
    let py = sy;
    let cx = fx;
    let cy = fy;
    usedEdge.add(ekey(py * w + px, cy * w + cx));
    for (;;) {
      path.push({ x: cx, y: cy });
      if (degree(cx, cy) !== 2) break; // endpoint or junction
      let nx = -1;
      let ny = -1;
      for (const [dx, dy] of N8) {
        if (!connected(cx, cy, dx, dy)) continue;
        const qx = cx + dx;
        const qy = cy + dy;
        if (qx === px && qy === py) continue;
        if (usedEdge.has(ekey(cy * w + cx, qy * w + qx))) continue;
        nx = qx;
        ny = qy;
        break;
      }
      if (nx < 0) break;
      usedEdge.add(ekey(cy * w + cx, ny * w + nx));
      px = cx;
      py = cy;
      cx = nx;
      cy = ny;
    }
    return path;
  };

  // First from endpoints and junctions, then sweep leftovers (pure loops).
  // Keep even 2-point fragments - mergePolylines chains them back together.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(x, y)) continue;
      const d = degree(x, y);
      if (d === 2) continue;
      for (const [dx, dy] of N8) {
        if (!connected(x, y, dx, dy)) continue;
        const qx = x + dx;
        const qy = y + dy;
        if (usedEdge.has(ekey(y * w + x, qy * w + qx))) continue;
        const p = walk(x, y, qx, qy);
        if (p.length >= 2) paths.push(p);
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(x, y) || degree(x, y) !== 2) continue;
      for (const [dx, dy] of N8) {
        if (!connected(x, y, dx, dy)) continue;
        const qx = x + dx;
        const qy = y + dy;
        if (usedEdge.has(ekey(y * w + x, qy * w + qx))) continue;
        const p = walk(x, y, qx, qy);
        if (p.length >= 3) paths.push(p);
      }
    }
  }
  return paths;
}

/** Merge polylines whose endpoints coincide within tol (vpype's linemerge). */
export function mergePolylines(paths: PathMm[], tol: number): PathMm[] {
  const pool = paths.map((p) => p.slice());
  const out: PathMm[] = [];
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);
  while (pool.length) {
    let cur = pool.pop()!;
    let extended = true;
    while (extended) {
      extended = false;
      for (let i = 0; i < pool.length; i++) {
        const cand = pool[i];
        const tail = cur[cur.length - 1];
        if (dist(tail, cand[0]) <= tol) {
          cur = cur.concat(cand.slice(1));
        } else if (dist(tail, cand[cand.length - 1]) <= tol) {
          cur = cur.concat(cand.slice(0, -1).reverse());
        } else if (dist(cur[0], cand[cand.length - 1]) <= tol) {
          cur = cand.concat(cur.slice(1));
        } else if (dist(cur[0], cand[0]) <= tol) {
          cur = cand.slice(1).reverse().concat(cur);
        } else {
          continue;
        }
        pool.splice(i, 1);
        extended = true;
        break;
      }
    }
    out.push(cur);
  }
  return out;
}
