// Stitch Lab tool: Differential Growth - a closed loop of nodes that
// attracts its neighbors, repels everyone else, and splits any edge that
// stretches - folding itself into coral, brains, and river deltas
// (inconvergent's differential-line method). The property that makes it the
// most embroidery-native generative algorithm we know: the curve stays ONE
// non-self-intersecting closed loop at every step of its growth, so wherever
// you stop it, it's already a continuous stitch path with zero trims.
//
// Deterministic: same seed + parameters = same organism = same DST.

import { useMemo, useState } from "react";
import { THREADS } from "../../data/threads";
import type { PathMm } from "../lib/generators";
import { fitPaths, pathsToStitches, resampleAdaptive, resamplePath } from "../lib/generators";
import {
  buildDesign,
  useDebounced,
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

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type GrowthOpts = {
  steps?: number; // simulation frames, default 350
  seed?: number; // default 1
  repulsionRadius?: number; // fold spacing in unit space, default 8
  attraction?: number; // spring toward linked neighbors, default 0.12
  repulsion?: number; // push from all nearby nodes, default 0.55
  maxEdge?: number; // split edges longer than this, default 3
  maxNodes?: number; // growth cap, default 3500
  boundsRadius?: number; // confining circle, default 100
};

/** Grow a closed loop; returns the final loop in unit space (closed: last≠first). */
export function differentialGrowth(opts: GrowthOpts = {}): PathMm {
  const steps = Math.max(10, Math.min(1200, Math.round(opts.steps ?? 350)));
  const rand = mulberry32(opts.seed ?? 1);
  const R = opts.repulsionRadius ?? 8;
  const kAttract = opts.attraction ?? 0.12;
  const kRepel = opts.repulsion ?? 0.55;
  const maxEdge = opts.maxEdge ?? 3;
  const maxNodes = Math.min(6000, opts.maxNodes ?? 3500);
  const bounds = opts.boundsRadius ?? 100;

  // Seed: a small circle with deterministic jitter to break symmetry.
  let xs: number[] = [];
  let ys: number[] = [];
  const n0 = 40;
  for (let i = 0; i < n0; i++) {
    const a = (i / n0) * Math.PI * 2;
    const r = 14 + (rand() - 0.5) * 1.6;
    xs.push(r * Math.cos(a));
    ys.push(r * Math.sin(a));
  }

  const cell = R;
  for (let s = 0; s < steps; s++) {
    const n = xs.length;
    // Spatial hash for neighbor lookups.
    const grid = new Map<number, number[]>();
    const keyOf = (x: number, y: number) =>
      (Math.floor(x / cell) + 4096) * 8192 + (Math.floor(y / cell) + 4096);
    for (let i = 0; i < n; i++) {
      const k = keyOf(xs[i], ys[i]);
      const bucket = grid.get(k);
      if (bucket) bucket.push(i);
      else grid.set(k, [i]);
    }

    const nx = new Float64Array(n);
    const ny = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const prev = (i + n - 1) % n;
      const next = (i + 1) % n;
      const px = xs[i];
      const py = ys[i];
      // Attraction toward the midpoint of linked neighbors (spring + smooth).
      let fx = ((xs[prev] + xs[next]) / 2 - px) * kAttract;
      let fy = ((ys[prev] + ys[next]) / 2 - py) * kAttract;
      // Repulsion from every node within R (except linked neighbors).
      const cx = Math.floor(px / cell);
      const cy = Math.floor(py / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const bucket = grid.get((gx + 4096) * 8192 + (gy + 4096));
          if (!bucket) continue;
          for (const j of bucket) {
            if (j === i || j === prev || j === next) continue;
            const dx = px - xs[j];
            const dy = py - ys[j];
            const d = Math.hypot(dx, dy);
            if (d >= R || d < 1e-9) continue;
            const f = (kRepel * (1 - d / R)) / d;
            fx += dx * f;
            fy += dy * f;
          }
        }
      }
      // Clamp displacement for stability.
      const mag = Math.hypot(fx, fy);
      const cap = 0.9;
      if (mag > cap) {
        fx = (fx / mag) * cap;
        fy = (fy / mag) * cap;
      }
      let qx = px + fx;
      let qy = py + fy;
      // Confine to the bounding circle.
      const rr = Math.hypot(qx, qy);
      if (rr > bounds) {
        qx = (qx / rr) * bounds;
        qy = (qy / rr) * bounds;
      }
      nx[i] = qx;
      ny[i] = qy;
    }
    xs = Array.from(nx);
    ys = Array.from(ny);

    // Growth: split any over-stretched edge by inserting its midpoint.
    if (xs.length < maxNodes) {
      const gx: number[] = [];
      const gy: number[] = [];
      const m = xs.length;
      for (let i = 0; i < m; i++) {
        const next = (i + 1) % m;
        gx.push(xs[i]);
        gy.push(ys[i]);
        const d = Math.hypot(xs[next] - xs[i], ys[next] - ys[i]);
        if (d > maxEdge && gx.length < maxNodes) {
          gx.push((xs[i] + xs[next]) / 2);
          gy.push((ys[i] + ys[next]) / 2);
        }
      }
      xs = gx;
      ys = gy;
    }
  }

  return xs.map((x, i) => ({ x, y: ys[i] }));
}

// ─── Component ───────────────────────────────────────────────────────────

const NAME = "bayside-growth";

export default function GrowthTool() {
  const [steps, setSteps] = useState(350);
  const [fold, setFold] = useState(8); // repulsion radius = fold spacing
  const [seed, setSeed] = useState(7);
  const [sizeMm, setSizeMm] = useState(110);
  const [stitchLen, setStitchLen] = useState(2.8);
  const [adaptive, setAdaptive] = useState(true);
  const [bean, setBean] = useState<1 | 3>(1);
  const [threadHex, setThreadHex] = useState(
    THREADS.find((t) => t.family === "Green" && t.hex)?.hex ??
      THREADS.find((t) => t.hex)?.hex ??
      "#082870",
  );

  const dSteps = useDebounced(steps);
  const dFold = useDebounced(fold);
  const built = useMemo(() => {
    const loop = differentialGrowth({ steps: dSteps, seed, repulsionRadius: dFold });
    if (loop.length < 8) return null;
    const closed = [...loop, loop[0]];
    const [fitted] = fitPaths([closed], sizeMm);
    const sampled = adaptive
      ? resampleAdaptive(fitted, {
          chordErrorMm: 0.15,
          minLenMm: Math.max(0.8, stitchLen / 3),
          maxLenMm: stitchLen,
        })
      : resamplePath(fitted, stitchLen);
    return buildDesign(pathsToStitches([sampled], bean), NAME);
  }, [dSteps, seed, dFold, sizeMm, stitchLen, adaptive, bean]);

  const stitchCount = built?.stats.realStitches ?? 0;

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="Organism">
            <RangeRow label="Growth" value={steps} min={80} max={800} step={10} onChange={setSteps} fmt={(v) => `${v} steps`} />
            <RangeRow label="Fold spacing" value={fold} min={5} max={14} step={0.5} onChange={setFold} />
            <button
              onClick={() => setSeed(Math.floor(Math.random() * 100000))}
              className="border border-hairline bg-bg px-3 py-1 text-[0.75rem] text-fg hover:bg-card"
            >
              New organism (seed {seed})
            </button>
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              A loop that attracts its neighbors, repels everyone else, and splits
              any edge that stretches. Stop it anywhere - it's always one
              non-crossing closed line, so it always sews with zero trims. Tighter
              fold spacing packs more coral into the same hoop.
            </p>
          </SectionBox>

          <SectionBox eyebrow="Stitches">
            <SizeField valueMm={sizeMm} min={50} max={330} onChange={setSizeMm} />
            <RangeRow label="Stitch length" value={stitchLen} min={1.5} max={5} step={0.1} onChange={setStitchLen} fmt={(v) => `${v.toFixed(1)} mm`} />
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
                  The folds are all curvature - adaptive stitching spends thread where
                  the organism bends.
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
            <ThreadRow hex={threadHex} onChange={(hex) => setThreadHex(hex)} />
          </SectionBox>
        </>
      }
      preview={
        <PreviewRail
          built={built}
          colors={[threadHex]}
          name={NAME}
          emptyHint="Adjust the growth settings - the shape appears as soon as it's sewable."
        >
          {built && (
            <p className="text-[0.75rem] text-mid tabular-nums">
              one closed line · zero trims · stop the growth anywhere and it still sews
            </p>
          )}
          {stitchCount > 60000 && (
            <Warning>Over 60k stitches - fewer steps or wider folds.</Warning>
          )}
        </PreviewRail>
      }
    />
  );
}
