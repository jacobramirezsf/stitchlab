// Stitch Lab tool: Quilting - unicursal free-motion quilting patterns, after
// Li, Breen, McCann & Hodgins, "Algorithmic Quilting Pattern Generation"
// (Graphics Interface 2019). Their architecture, distilled: sample points in
// the region, build a spanning-tree skeleton, walk it down-and-back (every
// edge twice = a closed walk), and graft decoration onto the walk - all
// without ever breaking the single line. Chaikin corner-cutting rounds the
// walk into the classic free-motion meander; pebbles and blooms grow loops
// and spirals along the way.
//
// One continuous closed path by construction. Seeded, deterministic.

import { useMemo, useState } from "react";
import { THREADS } from "../../data/threads";
import type { PathMm } from "../lib/generators";
import { pathsToStitches, resamplePath } from "../lib/generators";
import type { Ring } from "./tatami";
import {
  buildDesign,
  ModeButtons,
  PreviewRail,
  useDebounced,
  useShapeSource,
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

function insideRings(rings: Ring[], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
  }
  return inside;
}

export type QuiltStyle = "meander" | "pebbles" | "blooms";

export type QuiltOpts = {
  spacingMm?: number; // point spacing, default 9
  style?: QuiltStyle;
  seed?: number;
  smoothing?: number; // Chaikin rounds, default 2
};

/** One closed quilting walk over the shape. Returns [] if the region is tiny. */
export function quiltPath(rings: Ring[], opts: QuiltOpts = {}): PathMm {
  const spacing = Math.max(4, opts.spacingMm ?? 9);
  const style = opts.style ?? "meander";
  const rand = mulberry32(opts.seed ?? 1);
  const rounds = Math.max(0, Math.min(4, opts.smoothing ?? 2));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rings)
    for (const p of r) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

  // Dart-throwing with a min-distance grid: blue-noise-ish samples.
  const pts: { x: number; y: number }[] = [];
  const cell = spacing / Math.SQRT2;
  const gcols = Math.max(1, Math.ceil((maxX - minX) / cell));
  const grid = new Map<number, number>();
  const gkey = (x: number, y: number) =>
    Math.floor((y - minY) / cell) * (gcols + 2) + Math.floor((x - minX) / cell);
  const attempts = Math.ceil(((maxX - minX) * (maxY - minY)) / (spacing * spacing)) * 14;
  for (let a = 0; a < attempts; a++) {
    const x = minX + rand() * (maxX - minX);
    const y = minY + rand() * (maxY - minY);
    if (!insideRings(rings, x, y)) continue;
    let ok = true;
    const gx = Math.floor((x - minX) / cell);
    const gy = Math.floor((y - minY) / cell);
    for (let dy = -2; dy <= 2 && ok; dy++) {
      for (let dx = -2; dx <= 2 && ok; dx++) {
        const idx = grid.get((gy + dy) * (gcols + 2) + (gx + dx));
        if (idx === undefined) continue;
        const p = pts[idx];
        if (Math.hypot(p.x - x, p.y - y) < spacing) ok = false;
      }
    }
    if (!ok) continue;
    grid.set(gkey(x, y), pts.length);
    pts.push({ x, y });
  }
  if (pts.length < 3) return [];

  // Prim MST; candidate edges must keep their midpoint inside the region so
  // the skeleton doesn't shortcut across holes or concavities.
  const n = pts.length;
  const inTree = new Uint8Array(n);
  const dist = new Float64Array(n).fill(Infinity);
  const link = new Int32Array(n).fill(-1);
  inTree[0] = 1;
  const children: number[][] = Array.from({ length: n }, () => []);
  const valid = (i: number, j: number) =>
    insideRings(rings, (pts[i].x + pts[j].x) / 2, (pts[i].y + pts[j].y) / 2);
  for (let j = 1; j < n; j++) {
    if (valid(0, j)) {
      dist[j] = Math.hypot(pts[j].x - pts[0].x, pts[j].y - pts[0].y);
      link[j] = 0;
    }
  }
  for (let added = 1; added < n; added++) {
    let best = -1;
    let bd = Infinity;
    for (let j = 0; j < n; j++) {
      if (!inTree[j] && dist[j] < bd) {
        bd = dist[j];
        best = j;
      }
    }
    if (best < 0) break; // isolated leftovers (filtered edges) stay unquilted
    inTree[best] = 1;
    children[link[best]].push(best);
    for (let j = 0; j < n; j++) {
      if (inTree[j] || !valid(best, j)) continue;
      const d = Math.hypot(pts[j].x - pts[best].x, pts[j].y - pts[best].y);
      if (d < dist[j]) {
        dist[j] = d;
        link[j] = best;
      }
    }
  }

  // Down-and-back DFS: every tree edge exactly twice → closed walk.
  const walk: PathMm = [];
  const decorate = (i: number, isLeaf: boolean) => {
    const p = pts[i];
    if (style === "pebbles") {
      const r = spacing * 0.28;
      const phase = rand() * Math.PI * 2;
      for (let k = 0; k <= 10; k++) {
        const a = phase + (k / 10) * Math.PI * 2;
        walk.push({ x: p.x + r * Math.cos(a), y: p.y + r * Math.sin(a) });
      }
    } else if (style === "blooms" && isLeaf) {
      const turns = 1.6;
      const rMax = spacing * 0.42;
      const phase = rand() * Math.PI * 2;
      for (let k = 0; k <= 16; k++) {
        const t = k / 16;
        const a = phase + t * Math.PI * 2 * turns;
        const r = rMax * t;
        walk.push({ x: p.x + r * Math.cos(a), y: p.y + r * Math.sin(a) });
      }
      for (let k = 16; k >= 0; k--) {
        const t = k / 16;
        const a = phase + t * Math.PI * 2 * turns + 0.35;
        const r = rMax * t;
        walk.push({ x: p.x + r * Math.cos(a), y: p.y + r * Math.sin(a) });
      }
    }
  };
  // Offset each directed pass to its right by `off`. Going parent→child the
  // right side is one bank; the child→parent return's right side is the
  // opposite physical bank - so the down-and-back becomes a boundary walk
  // around the tree with the two passes ~2·off apart, never retracing (the
  // fix for the old overlap where 23% of points sat within 1mm of a pass).
  const off = spacing * 0.24;
  const bank = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = dy / len; // right-hand normal of travel direction
    const ny = -dx / len;
    return [
      { x: a.x + nx * off, y: a.y + ny * off },
      { x: b.x + nx * off, y: b.y + ny * off },
    ];
  };
  const dfs = (i: number) => {
    decorate(i, children[i].length === 0);
    for (const c of children[i]) {
      const [o1, o2] = bank(pts[i], pts[c]);
      walk.push(o1, o2);
      dfs(c);
      const [r1, r2] = bank(pts[c], pts[i]);
      walk.push(r1, r2);
    }
  };
  walk.push(pts[0]);
  dfs(0);
  walk.push(pts[0]);

  // Chaikin corner cutting rounds the skeletal walk into free-motion curves.
  let cur = walk;
  for (let r = 0; r < rounds; r++) {
    const next: PathMm = [];
    for (let i = 0; i < cur.length - 1; i++) {
      const a = cur[i];
      const b = cur[i + 1];
      next.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
      next.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    next.push(next[0]);
    cur = next;
  }
  return cur;
}

// ─── Component ───────────────────────────────────────────────────────────

const NAME = "bayside-quilting";

export default function QuiltingTool() {
  const [style, setStyle] = useState<QuiltStyle>("meander");
  const [sizeMm, setSizeMm] = useState(110);
  const [spacing, setSpacing] = useState(9);
  const [smoothing, setSmoothing] = useState(2);
  const [seed, setSeed] = useState(2019); // the paper's vintage
  const [stitchLen, setStitchLen] = useState(2.6);
  const [threadHex, setThreadHex] = useState(
    THREADS.find((t) => t.family === "Brown" && t.hex)?.hex ??
      THREADS.find((t) => t.hex)?.hex ??
      "#082870",
  );

  const dSize = useDebounced(sizeMm);
  const dSpacing = useDebounced(spacing);
  const { rings, element: shapeElement } = useShapeSource(dSize, "square");

  const built = useMemo(() => {
    if (rings.length === 0) return null;
    const path = quiltPath(rings, { spacingMm: dSpacing, style, seed, smoothing });
    if (path.length < 8) return null;
    return buildDesign(pathsToStitches([resamplePath(path, stitchLen, 0.4)], 1), NAME);
  }, [rings, style, dSpacing, smoothing, seed, stitchLen]);

  const stitchCount = built?.stats.realStitches ?? 0;

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="Pattern">
            <ModeButtons
              options={[
                ["meander", "Meander (stipple)"],
                ["pebbles", "Pebbles"],
                ["blooms", "Blooms"],
              ]}
              value={style}
              onChange={setStyle}
            />
            <RangeRow label="Spacing" value={spacing} min={5} max={16} step={0.5} onChange={setSpacing} fmt={(v) => `${v.toFixed(1)} mm`} />
            <RangeRow label="Smoothing" value={smoothing} min={0} max={4} onChange={setSmoothing} fmt={(v) => `${v} round${v === 1 ? "" : "s"}`} />
            <button
              onClick={() => setSeed(Math.floor(Math.random() * 100000))}
              className="border border-hairline bg-bg px-3 py-1 text-[0.75rem] text-fg hover:bg-card"
            >
              Reshuffle (seed {seed})
            </button>
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Blue-noise samples → spanning-tree skeleton → a down-and-back walk that
              covers every branch - the free-motion quilter's meander, machine-exact.
              Pebbles circle every point; blooms spiral at the branch tips.
            </p>
          </SectionBox>

          <SectionBox eyebrow="Region">
            {shapeElement}
            <SizeField valueMm={sizeMm} min={50} max={330} onChange={setSizeMm} />
          </SectionBox>

          <SectionBox eyebrow="Stitches">
            <RangeRow label="Stitch length" value={stitchLen} min={1.5} max={5} step={0.1} onChange={setStitchLen} fmt={(v) => `${v.toFixed(1)} mm`} />
            <ThreadRow hex={threadHex} onChange={(hex) => setThreadHex(hex)} />
          </SectionBox>
        </>
      }
      preview={
        <PreviewRail
          built={built}
          colors={[threadHex]}
          name={NAME}
          emptyHint="Pick a region or drop an SVG."
        >
          {built && (
            <p className="text-[0.75rem] text-mid tabular-nums">
              one closed walk · every branch covered twice · zero trims
            </p>
          )}
          {stitchCount > 60000 && (
            <Warning>Over 60k stitches - widen the density or shrink the region.</Warning>
          )}
        </PreviewRail>
      }
    />
  );
}
