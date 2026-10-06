// Stitch Lab tool: Flow Field - evenly-spaced streamlines through a seeded
// noise field, after Jobard & Lefér 1997 ("Creating Evenly-Spaced Streamlines
// of Arbitrary Density"). The trick from flow-visualization research: an
// occupancy grid remembers every point already sewn, each new streamline is
// integrated (RK2 midpoint) through the field until it drifts within 0.9×
// separation of another line, and fresh seeds are spawned one separation to
// either side of every accepted line. The result is a field of lines that
// never crowd and never gap - an evenness no hand embroidery can hold.
//
// Pure math lives at the top of the file (node-importable, no DOM, seeded
// PRNG only); everything React/DOM stays inside the component.

import { useMemo, useState } from "react";
import { THREADS } from "../../data/threads";
import type { PathMm } from "../lib/generators";
import { pathsToStitches, resampleAdaptive, resamplePath } from "../lib/generators";
import {
  buildDesign,
  useDebouncedKey,
  ModeButtons,
  PreviewRail,
  RangeRow,
  SectionBox,
  ThreadRow,
  ToolLayout,
  Warning,
  SizeField,
} from "./shared";

// ─── Pure logic ──────────────────────────────────────────────────────────

const TAU = Math.PI * 2;

/** Tiny seedable PRNG (mulberry32) - deterministic fields, reproducible tests. */
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
 * Smooth seeded angle field: value noise on a hashed integer lattice (the
 * permutation table is shuffled by mulberry32(seed)), bilinear interpolation
 * with a smoothstep fade so no grid shows, summed over 3 octaves. The noise
 * value (0..1) maps to an angle of noise · 2π · swirl - swirl 1 uses the full
 * circle once; higher swirl wraps the circle multiple times, so nearby noise
 * values land on very different headings and the field curls tighter.
 */
export function makeAngleField(seed: number, swirl?: number): (x: number, y: number) => number {
  const rand = mulberry32(seed);
  // Fisher–Yates shuffle of 0..255, doubled so perm[i + 256] never wraps.
  const base: number[] = [];
  for (let i = 0; i < 256; i++) base.push(i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = base[i];
    base[i] = base[j];
    base[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = base[i & 255];

  const lattice = (ix: number, iy: number) => perm[(perm[ix & 255] + (iy & 255)) & 255] / 255;
  const fade = (t: number) => t * t * (3 - 2 * t);
  const noise2 = (x: number, y: number): number => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const u = fade(x - ix);
    const v = fade(y - iy);
    const a = lattice(ix, iy);
    const b = lattice(ix + 1, iy);
    const c = lattice(ix, iy + 1);
    const d = lattice(ix + 1, iy + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };

  const s = swirl ?? 1;
  return (x, y) => {
    // 3 octaves, each offset so the lattices don't align; normalized to 0..1.
    let sum = 0;
    let norm = 0;
    let amp = 1;
    let freq = 1;
    for (let o = 0; o < 3; o++) {
      sum += amp * noise2(x * freq + o * 37.7, y * freq - o * 17.3);
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return (sum / norm) * TAU * s;
  };
}

export type StreamlineOpts = {
  widthMm: number;
  heightMm: number;
  /** Target spacing between neighboring lines. Default 2.5 mm. */
  sepMm?: number;
  /** If set, each streamline is resampled to this stitch length. */
  stitchLenMm?: number;
  seed?: number;
  /** Angle multiplier - more swirl, tighter curls. Default 1. */
  swirl?: number;
  /** Noise-field frequency per mm. Default 0.035. */
  noiseScale?: number;
};

/**
 * Jobard–Lefér evenly-spaced streamlines. An occupancy grid (cell = sep/2)
 * stores every placed point; lines integrate with RK2 (midpoint, step
 * 0.4·sep) BOTH directions from each seed, stopping a direction on leaving
 * the canvas, on coming within 0.9·sep of a point from another streamline,
 * or after 2000 steps. Candidate seeds are enqueued ±sep perpendicular from
 * every 2nd point of each accepted line (FIFO), skipped if they've since
 * been crowded within sep of any placed point. First seed sits at center.
 * Caps: 600 lines, 150k total points. Output is mm, y-down, origin top-left.
 */
export function streamlines(opts: StreamlineOpts): PathMm[] {
  const W = Math.max(1, opts.widthMm);
  const H = Math.max(1, opts.heightMm);
  const sep = Math.max(0.5, opts.sepMm ?? 2.5);
  const noiseScale = opts.noiseScale ?? 0.035;
  const field = makeAngleField(opts.seed ?? 1, opts.swirl ?? 1);
  const angleAt = (x: number, y: number) => field(x * noiseScale, y * noiseScale);

  const h = 0.4 * sep; // integration step
  const dtest2 = (0.9 * sep) * (0.9 * sep); // stop-distance² to other lines
  const sep2 = sep * sep; // seed-rejection distance²
  const cell = sep / 2;
  const cols = Math.ceil(W / cell) + 2;
  const MAX_STEPS = 2000;
  const MAX_LINES = 600;
  const MAX_POINTS = 150000;

  type GridPt = { x: number; y: number; line: number };
  const grid = new Map<number, GridPt[]>();
  const insert = (x: number, y: number, line: number) => {
    const k = Math.floor(y / cell) * cols + Math.floor(x / cell);
    const arr = grid.get(k);
    if (arr) arr.push({ x, y, line });
    else grid.set(k, [{ x, y, line }]);
  };
  /** Any placed point (excluding line `self`) within √r2, checking ±reach cells? */
  const nearOther = (x: number, y: number, self: number, r2: number, reach: number): boolean => {
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const arr = grid.get((cy + dy) * cols + (cx + dx));
        if (!arr) continue;
        for (const p of arr) {
          if (p.line === self) continue;
          const ddx = p.x - x;
          const ddy = p.y - y;
          if (ddx * ddx + ddy * ddy < r2) return true;
        }
      }
    }
    return false;
  };

  const inBounds = (x: number, y: number) => x >= 0 && x <= W && y >= 0 && y <= H;

  // One RK2 midpoint step along the field; dir = +1 downstream, −1 upstream.
  const rk2 = (x: number, y: number, dir: number): { x: number; y: number } => {
    const a1 = angleAt(x, y);
    const mx = x + dir * Math.cos(a1) * (h / 2);
    const my = y + dir * Math.sin(a1) * (h / 2);
    const a2 = angleAt(mx, my);
    return { x: x + dir * Math.cos(a2) * h, y: y + dir * Math.sin(a2) * h };
  };

  const trace = (sx: number, sy: number, line: number): PathMm => {
    const halves: [PathMm, PathMm] = [[], []];
    for (let d = 0; d < 2; d++) {
      const dir = d === 0 ? 1 : -1;
      let x = sx;
      let y = sy;
      for (let i = 0; i < MAX_STEPS; i++) {
        const n = rk2(x, y, dir);
        if (!inBounds(n.x, n.y)) break;
        if (nearOther(n.x, n.y, line, dtest2, 1)) break;
        halves[d].push(n);
        x = n.x;
        y = n.y;
      }
    }
    const out: PathMm = [];
    for (let i = halves[1].length - 1; i >= 0; i--) out.push(halves[1][i]);
    out.push({ x: sx, y: sy });
    out.push(...halves[0]);
    return out;
  };

  const paths: PathMm[] = [];
  let total = 0;
  const queue: { x: number; y: number }[] = [{ x: W / 2, y: H / 2 }];
  let qi = 0; // FIFO read head - never shift(), the queue grows long
  const seedReach = Math.max(1, Math.ceil(sep / cell)); // sep = 2 cells → 5×5

  while (qi < queue.length && paths.length < MAX_LINES && total < MAX_POINTS) {
    const cand = queue[qi++];
    if (!inBounds(cand.x, cand.y)) continue;
    if (nearOther(cand.x, cand.y, -1, sep2, seedReach)) continue;

    const line = paths.length;
    const pts = trace(cand.x, cand.y, line);
    if (pts.length < 3) continue; // dust - not worth a jump + trim
    if (total + pts.length > MAX_POINTS) pts.length = MAX_POINTS - total;
    if (pts.length < 3) break;

    for (const p of pts) insert(p.x, p.y, line);
    total += pts.length;
    paths.push(pts);

    // Enqueue candidate seeds ±sep perpendicular from every 2nd point.
    for (let i = 0; i < pts.length; i += 2) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      let tx = b.x - a.x;
      let ty = b.y - a.y;
      const len = Math.hypot(tx, ty);
      if (len < 1e-9) continue;
      tx /= len;
      ty /= len;
      queue.push({ x: pts[i].x - ty * sep, y: pts[i].y + tx * sep });
      queue.push({ x: pts[i].x + ty * sep, y: pts[i].y - tx * sep });
    }
  }

  const sl = opts.stitchLenMm;
  return sl !== undefined && sl > 0 ? paths.map((p) => resamplePath(p, sl)) : paths;
}

// ─── Component ───────────────────────────────────────────────────────────

const NAME = "bayside-flowfield";

export default function FlowFieldTool() {
  const [sizeMm, setSizeMm] = useState(130);
  const [sep, setSep] = useState(2.5);
  const [swirl, setSwirl] = useState(1);
  const [seed, setSeed] = useState(1997); // the Jobard–Lefér vintage
  const [stitchLen, setStitchLen] = useState(2.8);
  const [adaptive, setAdaptive] = useState(true);
  const [bean, setBean] = useState<1 | 3>(1);
  const [densityOn, setDensityOn] = useState(false);
  const [threadHex, setThreadHex] = useState(
    THREADS.find((t) => t.code === "1568")?.hex ??
      THREADS.find((t) => t.hex)?.hex ??
      "#082870",
  );

  const genKey = useDebouncedKey([sizeMm, sep, swirl, seed, stitchLen, adaptive, bean], 170);
  const gen = useMemo(() => {
    const raw = streamlines({
      widthMm: sizeMm,
      heightMm: sizeMm,
      sepMm: sep,
      seed,
      swirl,
    });
    // Center on the origin for the hoop; sizing is already exact in mm.
    const cx = sizeMm / 2;
    const cy = sizeMm / 2;
    const centered = raw.map((p) => {
      const shifted = p.map((pt) => ({ x: pt.x - cx, y: pt.y - cy }));
      return adaptive
        ? resampleAdaptive(shifted, {
            chordErrorMm: 0.15,
            minLenMm: Math.max(0.8, stitchLen / 3),
            maxLenMm: stitchLen,
          })
        : resamplePath(shifted, stitchLen);
    });
    return { lineCount: raw.length, stitches: pathsToStitches(centered, bean) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genKey]);

  const built = useMemo(() => buildDesign(gen.stitches, NAME), [gen.stitches]);
  const stitchCount = built?.stats.realStitches ?? 0;

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="Field">
            <p className="text-[0.75rem] text-mid leading-relaxed">
              Flow-visualization research turned thread texture: streamlines traced
              through a seeded noise field, held apart by the Jobard–Lefér occupancy
              grid. Every line keeps its distance from every other - an evenness no
              hand embroidery can hold.
            </p>
            <div className="flex items-center gap-2 text-[0.75rem] text-mid">
              <span>
                Seed <span className="tabular-nums text-fg">{seed}</span>
              </span>
              <button
                onClick={() => setSeed(Math.floor(Math.random() * 1000000))}
                className="ml-auto border border-hairline bg-bg px-3 py-1 text-[0.75rem] text-fg hover:bg-card"
                title="Roll a fresh field - the number reproduces it exactly"
              >
                Roll the dice
              </button>
            </div>
            <RangeRow
              label="Separation"
              value={sep}
              min={1.5}
              max={6}
              step={0.1}
              onChange={setSep}
              fmt={(v) => `${v.toFixed(1)} mm`}
            />
            <RangeRow
              label="Swirl"
              value={swirl}
              min={0.5}
              max={3}
              step={0.1}
              onChange={setSwirl}
              fmt={(v) => `${v.toFixed(1)}×`}
            />
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Separation is the promise the grid keeps - no two lines closer than
              this. Swirl wraps the angle field around the circle more than once:
              low swirl combs gently, high swirl curls into tight eddies.
            </p>
          </SectionBox>

          <SectionBox eyebrow="Stitch settings">
            <SizeField valueMm={sizeMm} min={60} max={330} onChange={setSizeMm} />
            <RangeRow
              label="Stitch length"
              value={stitchLen}
              min={1.5}
              max={5}
              step={0.1}
              onChange={setStitchLen}
              fmt={(v) => `${v.toFixed(1)} mm`}
            />
            <label className="flex items-start gap-2 text-[0.8125rem] text-fg cursor-pointer">
              <input
                type="checkbox"
                checked={adaptive}
                onChange={(ev) => setAdaptive(ev.target.checked)}
                className="accent-accent mt-0.5"
              />
              <span>
                Adaptive stitch length
                <span className="block text-[0.6875rem] text-mid leading-relaxed">
                  Chord-tolerance stitching (0.15&nbsp;mm cap): long on straights, short in
                  curves. The slider sets the maximum.
                </span>
              </span>
            </label>
            <ModeButtons
              small
              options={[
                [1, "Run"],
                [3, "Bean ×3"],
              ]}
              value={bean}
              onChange={setBean}
            />
            <label className="flex items-start gap-2 text-[0.75rem] text-mid cursor-pointer">
              <input
                type="checkbox"
                checked={densityOn}
                onChange={(ev) => setDensityOn(ev.target.checked)}
                className="mt-0.5 accent-accent"
              />
              <span>
                <span className="text-fg">Density view</span> - heat-map the needle
                penetrations to spot crowded spots before the machine finds them.
              </span>
            </label>
          </SectionBox>

          <SectionBox eyebrow="Thread">
            <ThreadRow hex={threadHex} onChange={(hex) => setThreadHex(hex)} />
          </SectionBox>
        </>
      }
      preview={
        <PreviewRail
          built={built}
          colors={[threadHex]}
          name={NAME}
          emptyHint="Adjust the field - it appears as soon as it's sewable."
          showDensity={densityOn}
        >
          {built && (
            <p className="text-[0.75rem] text-mid tabular-nums">
              {gen.lineCount} streamlines · zero crossings by construction
            </p>
          )}
          {stitchCount > 60000 && (
            <Warning>
              {stitchCount.toLocaleString()} stitches - that's a long sit at the
              machine. Widen the separation, lengthen the stitch, or shrink the
              size and the count drops fast.
            </Warning>
          )}
          {sep < 1.8 && (
            <Warning>
              Lines under 1.8 mm apart put a lot of needle holes in every square
              centimeter - sew this on a stable, tightly-woven fabric with a firm
              stabilizer, and skip the bean stitch.
            </Warning>
          )}
        </PreviewRail>
      }
    />
  );
}
