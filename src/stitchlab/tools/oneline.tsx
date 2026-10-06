// Stitch Lab tool: One-Line - a photo drawn as a single continuous line, the
// classic "TSP art" look (and what finitecurve.com does). Two steps, both pure
// and deterministic:
//   1. Weighted blue-noise stippling: scatter dots so their density tracks the
//      photo's darkness (dark areas get more dots, highlights stay bare), spaced
//      apart by dart-throwing so they never clump.
//   2. Traveling-salesman routing: order every dot into the shortest single
//      tour (grid-accelerated nearest-neighbour, then 2-opt to pull out the
//      crossings), and connect them into ONE polyline.
// The result is a single unbroken stroke - which is exactly what a machine wants
// (no trims, no jumps) and what a pen plotter or drawing robot needs too.
//
// This is the same problem space as the pen-plotter / robot single-line-drawing
// references: image -> stipple -> TSP path -> one continuous toolpath.

import { useMemo, useState } from "react";
import {
  ToolLayout,
  SectionBox,
  RangeRow,
  ThreadRow,
  Warning,
  PreviewRail,
  buildDesign,
  useDebouncedKey,
  ImagePick,
  type LumImg,
  fmtLen, useUnits,
} from "./shared";
import { pathsToStitches, resamplePath, fitPaths, type PathMm } from "../lib/generators";
import { THREADS } from "../../data/threads";

// ─── Pure generator ──────────────────────────────────────────────────────

/** Small deterministic PRNG so the same photo + settings always route the same
 *  line (React re-renders shouldn't reshuffle the dots). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lumAt(img: { w: number; h: number; lum: Float32Array }, x: number, y: number): number {
  const xi = x < 0 ? 0 : x > img.w - 1 ? img.w - 1 : x | 0;
  const yi = y < 0 ? 0 : y > img.h - 1 ? img.h - 1 : y | 0;
  return img.lum[yi * img.w + xi];
}

type Pt = { x: number; y: number };

/**
 * Weighted blue-noise stipple. Dart-throws candidate points, keeps one only if
 * (a) it survives a darkness-weighted coin flip and (b) nothing already sits
 * within `minDist` of it (a uniform grid makes that check O(1)). The darkness
 * weighting concentrates dots in the shadows; the spacing rule keeps them from
 * piling up, so the tour reads as smooth tone rather than a scribble.
 */
export function stipple(
  img: { w: number; h: number; lum: Float32Array },
  opts: { count: number; gamma: number; invert: boolean; seed: number },
): Pt[] {
  const { w, h } = img;
  const target = Math.max(20, Math.min(6000, opts.count | 0));
  const rnd = mulberry32(opts.seed);
  // spacing that would place ~target points across the whole frame, tightened a
  // touch (0.7) because the darkness gate rejects most of the light-area darts
  const minDist = Math.max(1.2, Math.sqrt((w * h) / target) * 0.7);
  const cell = minDist;
  const gw = Math.max(1, Math.ceil(w / cell));
  const gh = Math.max(1, Math.ceil(h / cell));
  const grid: number[][] = Array.from({ length: gw * gh }, () => []);
  const pts: Pt[] = [];
  const minD2 = minDist * minDist;

  const farEnough = (x: number, y: number): boolean => {
    const cx = Math.min(gw - 1, (x / cell) | 0);
    const cy = Math.min(gh - 1, (y / cell) | 0);
    for (let j = cy - 1; j <= cy + 1; j++) {
      if (j < 0 || j >= gh) continue;
      for (let i = cx - 1; i <= cx + 1; i++) {
        if (i < 0 || i >= gw) continue;
        for (const idx of grid[j * gw + i]) {
          const p = pts[idx];
          const dx = p.x - x, dy = p.y - y;
          if (dx * dx + dy * dy < minD2) return false;
        }
      }
    }
    return true;
  };

  // budget the darts so a mostly-light photo still terminates quickly
  const maxDarts = target * 40;
  for (let d = 0; d < maxDarts && pts.length < target; d++) {
    const x = rnd() * w;
    const y = rnd() * h;
    const lum = lumAt(img, x, y);
    let dark = opts.invert ? lum : 1 - lum;
    dark = dark <= 0 ? 0 : Math.pow(dark, opts.gamma);
    if (rnd() > dark) continue; // darkness-weighted acceptance
    if (!farEnough(x, y)) continue;
    const idx = pts.length;
    pts.push({ x, y });
    const cx = Math.min(gw - 1, (x / cell) | 0);
    const cy = Math.min(gh - 1, (y / cell) | 0);
    grid[cy * gw + cx].push(idx);
  }
  return pts;
}

/** Order points into one short tour: grid nearest-neighbour seed, then 2-opt
 *  using per-point candidate neighbours + don't-look bits (bounded passes).
 *  Returns the points reordered along the tour. */
export function routeTour(pts: Pt[], improvePasses = 6): Pt[] {
  const n = pts.length;
  if (n < 3) return pts.slice();

  // spatial grid for nearest-neighbour queries
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const spanX = Math.max(1e-6, maxX - minX), spanY = Math.max(1e-6, maxY - minY);
  const cell = Math.max(1e-6, Math.sqrt((spanX * spanY) / n));
  const gw = Math.max(1, Math.ceil(spanX / cell) + 1);
  const gh = Math.max(1, Math.ceil(spanY / cell) + 1);
  const gi = (x: number, y: number) =>
    Math.min(gh - 1, Math.max(0, ((y - minY) / cell) | 0)) * gw +
    Math.min(gw - 1, Math.max(0, ((x - minX) / cell) | 0));
  const grid: number[][] = Array.from({ length: gw * gh }, () => []);
  for (let i = 0; i < n; i++) grid[gi(pts[i].x, pts[i].y)].push(i);

  const d2 = (a: number, b: number) => {
    const dx = pts[a].x - pts[b].x, dy = pts[a].y - pts[b].y;
    return dx * dx + dy * dy;
  };

  // nearest-neighbour construction using expanding ring search on the grid
  const used = new Uint8Array(n);
  const tour: number[] = [0];
  used[0] = 1;
  for (let step = 1; step < n; step++) {
    const from = tour[tour.length - 1];
    const cx = Math.min(gw - 1, Math.max(0, ((pts[from].x - minX) / cell) | 0));
    const cy = Math.min(gh - 1, Math.max(0, ((pts[from].y - minY) / cell) | 0));
    let best = -1, bestD = Infinity;
    for (let r = 0; r < Math.max(gw, gh); r++) {
      for (let j = cy - r; j <= cy + r; j++) {
        if (j < 0 || j >= gh) continue;
        for (let i = cx - r; i <= cx + r; i++) {
          if (i < 0 || i >= gw) continue;
          // only the ring's border cells are new at radius r
          if (r > 0 && j > cy - r && j < cy + r && i > cx - r && i < cx + r) continue;
          for (const idx of grid[j * gw + i]) {
            if (used[idx]) continue;
            const dd = d2(from, idx);
            if (dd < bestD) { bestD = dd; best = idx; }
          }
        }
      }
      // once we have a candidate, one extra ring guarantees correctness
      if (best >= 0 && r >= 1 && bestD <= (r * cell) * (r * cell)) break;
    }
    if (best < 0) { for (let k = 0; k < n; k++) if (!used[k]) { best = k; break; } }
    used[best] = 1;
    tour.push(best);
  }

  // candidate neighbour lists (k nearest) for a cheap 2-opt
  const K = 8;
  const cand: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const cx = Math.min(gw - 1, Math.max(0, ((pts[i].x - minX) / cell) | 0));
    const cy = Math.min(gh - 1, Math.max(0, ((pts[i].y - minY) / cell) | 0));
    const near: { j: number; d: number }[] = [];
    for (let r = 1; r <= 2; r++) {
      for (let j = cy - r; j <= cy + r; j++) {
        if (j < 0 || j >= gh) continue;
        for (let ii = cx - r; ii <= cx + r; ii++) {
          if (ii < 0 || ii >= gw) continue;
          for (const idx of grid[j * gw + ii]) if (idx !== i) near.push({ j: idx, d: d2(i, idx) });
        }
      }
      if (near.length >= K) break;
    }
    near.sort((a, b) => a.d - b.d);
    cand[i] = near.slice(0, K).map((x) => x.j);
  }

  // position lookup + neighbour-list 2-opt with don't-look bits.
  // A move reverses tour[lo+1..hi], swapping edges (A,An)+(B,Bn) for
  // (A,B)+(An,Bn); we only try B among A's nearest candidates so the new (A,B)
  // edge is short. Treating the tour as cyclic, reversing either arc is
  // equivalent, so normalising to lo<hi is always valid.
  const pos = new Int32Array(n);
  for (let i = 0; i < n; i++) pos[tour[i]] = i;
  const dontlook = new Uint8Array(n);
  const reverse = (a: number, b: number) => {
    while (a < b) {
      const ta = tour[a], tb = tour[b];
      tour[a] = tb; tour[b] = ta; pos[tb] = a; pos[ta] = b;
      a++; b--;
    }
  };

  for (let pass = 0; pass < improvePasses; pass++) {
    let improved = false;
    for (let scan = 0; scan < n; scan++) {
      const c1 = tour[scan];
      if (dontlook[c1]) continue;
      let localImproved = false;
      for (const c2 of cand[c1]) {
        const i = pos[c1], j = pos[c2];
        const lo = Math.min(i, j), hi = Math.max(i, j);
        if (hi - lo < 1 || (lo === 0 && hi === n - 1)) continue;
        const A = tour[lo], An = tour[lo + 1];
        const B = tour[hi], Bn = tour[(hi + 1) % n];
        const before = d2(A, An) + d2(B, Bn);
        const after = d2(A, B) + d2(An, Bn);
        if (after + 1e-6 < before) {
          reverse(lo + 1, hi);
          dontlook[A] = dontlook[An] = dontlook[B] = dontlook[Bn] = 0;
          localImproved = true; improved = true;
          break;
        }
      }
      if (!localImproved) dontlook[c1] = 1;
    }
    if (!improved) break;
  }

  return tour.map((i) => pts[i]);
}

// ─── Component ───────────────────────────────────────────────────────────

const DEFAULT_THREAD = THREADS.find((t) => t.code === "1000")?.hex ?? THREADS.find((t) => t.hex)?.hex ?? "#111111";

export default function OneLineTool() {
  const units = useUnits();
  const [img, setImg] = useState<LumImg | null>(null);
  const [fileName, setFileName] = useState("");
  const [detail, setDetail] = useState(900);
  const [gamma, setGamma] = useState(1.5);
  const [invert, setInvert] = useState(false);
  const [seed, setSeed] = useState(1);
  const [closed, setClosed] = useState(false);
  const [sizeMm, setSizeMm] = useState(160);
  const [stitchLen, setStitchLen] = useState(2.2);
  const [threadHex, setThreadHex] = useState(DEFAULT_THREAD);

  const genKey = useDebouncedKey([detail, gamma, invert, seed, closed], 220);
  const { path, count } = useMemo(() => {
    if (!img) return { path: [] as PathMm, count: 0 };
    const pts = stipple(img, { count: detail, gamma, invert, seed });
    if (pts.length < 3) return { path: [] as PathMm, count: pts.length };
    const tour = routeTour(pts);
    const line: PathMm = tour.map((p) => ({ x: p.x, y: p.y }));
    if (closed && line.length > 2) line.push({ x: line[0].x, y: line[0].y });
    return { path: line, count: tour.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, genKey]);

  const built = useMemo(() => {
    if (path.length < 2) return null;
    const fitted = fitPaths([path], sizeMm).map((p) => resamplePath(p, stitchLen, 0.4));
    return buildDesign(pathsToStitches(fitted, 1), "bayside-oneline");
  }, [path, sizeMm, stitchLen]);

  const renderThreadMm = 0.5;

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="photo">
            <ImagePick onImage={(i, n) => { setImg(i); setFileName(n); }} fileName={fileName} longSide={260} hint="A clear, high-contrast subject reads best - a face, a logo, a silhouette." />
            {img && <p className="text-[0.75rem] text-mid">{fileName} - {img.w}×{img.h} px. Nothing uploads; it stays in your browser.</p>}
          </SectionBox>

          <SectionBox eyebrow="the line">
            <RangeRow label="Detail" value={detail} min={200} max={3000} step={50} onChange={setDetail} fmt={(v) => `${v} dots`} />
            <RangeRow label="Contrast" value={gamma} min={0.6} max={3} step={0.1} onChange={setGamma} fmt={(v) => v.toFixed(1)} />
            <RangeRow label="Variation" value={seed} min={1} max={12} step={1} onChange={setSeed} fmt={(v) => `#${v}`} />
            <label className="flex items-center gap-2 text-[0.75rem] text-mid">
              <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} className="accent-accent" />
              trace the light instead of the dark (for dark fabric)
            </label>
            <label className="flex items-center gap-2 text-[0.75rem] text-mid">
              <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} className="accent-accent" />
              close the loop (end returns to the start)
            </label>
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              The photo becomes a field of dots - denser where it's dark - and a single line is routed through every one in the shortest order it can find. More detail = more dots and a finer likeness; higher contrast pushes dots into the shadows. Variation reshuffles the dots for a different take.
            </p>
          </SectionBox>

          <SectionBox eyebrow="stitch">
            <RangeRow label="Size" value={sizeMm} min={60} max={300} step={5} onChange={setSizeMm} fmt={(v) => fmtLen(v, units)} />
            <RangeRow label="Stitch length" value={stitchLen} min={1.5} max={3.5} step={0.1} onChange={setStitchLen} fmt={(v) => `${v.toFixed(1)} mm`} />
            <ThreadRow hex={threadHex} onChange={setThreadHex} />
          </SectionBox>

          {built && built.stats.realStitches > 45000 && (
            <Warning>Over 45,000 stitches - drop the detail or raise the stitch length.</Warning>
          )}
        </>
      }
      preview={
        <PreviewRail built={built} colors={[threadHex]} name="bayside-oneline" threadMm={renderThreadMm} emptyHint="Load a photo - it becomes one continuous line.">
          {built && (
            <p className="text-[0.6875rem] text-mid tabular-nums">
              1 continuous line · {count.toLocaleString()} dots · {built.stats.realStitches.toLocaleString()} stitches · no trims
            </p>
          )}
        </PreviewRail>
      }
    />
  );
}
