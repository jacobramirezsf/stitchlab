// Next Gen · Blackwork - fill any shape with a repeating geometric line
// pattern, sewn as one reversible line. Blackwork (Spanish/Holbein work) is a
// real Renaissance embroidery tradition: monochrome geometric "diaper" fills
// worked in double-running stitch so the line reads identically on the front
// and the back. That reversibility is meaningful only in thread - which is the
// whole reason to make this as embroidery rather than screen graphics.
//
// Pipeline: pick a lattice motif → tile it across the region's bounding box →
// clip the segments to the shape → dedupe shared edges → route the segment
// network through lib/routing.ts (Holbein reversible / single-stroke Eulerian
// / as-drawn) → resample → real DST. The routing engine is what makes the
// whole pattern sew as a few continuous strokes instead of hundreds of trims.
//
// GUARANTEED: every kept segment lies on the motif lattice and inside the clip
// region; the Eulerian route covers every kept edge; deterministic per seed.
// HEURISTIC: odd-vertex pairing (near-optimal continuity, not proven minimum).
// UNKNOWN UNTIL STITCHED: which pitch reads cleanly on a given fabric, and how
// perfectly double-running registers on knit vs. woven.

import { useMemo, useState } from "react";
import { THREADS } from "../../data/threads";
import type { PathMm } from "../lib/generators";
import { pathGroupsToStitches, pathsToStitches, resamplePath } from "../lib/generators";
import { planStrokes, holbeinRoute, type Segment } from "../lib/routing";
import { layoutText } from "./lettering";
import { type Ring } from "./tatami";
import {
  buildDesign,
  FabricSelect,
  type FabricId,
  ModeButtons,
  PreviewRail,
  RangeRow,
  SectionBox,
  SizeField,
  ThreadRow,
  ToolLayout,
  useDebounced,
  useShapeSource,
  Warning,
} from "./shared";

// ─── Seeded RNG ──────────────────────────────────────────────────────────

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

// ─── Motif library: segments for a unit cell at (ox,oy), size s ──────────

export type MotifId =
  | "diagonalLattice"
  | "diamonds"
  | "squares"
  | "chevron"
  | "crosshatch"
  | "star8"
  | "pinwheel"
  | "scales"
  | "woven";

type CellFn = (ox: number, oy: number, s: number, rand: () => number) => Segment[];

const seg = (ax: number, ay: number, bx: number, by: number): Segment => [
  { x: ax, y: ay },
  { x: bx, y: by },
];

/** A quarter-arc as a short polyline broken into segments. */
function arcSegs(cx: number, cy: number, r: number, a0: number, a1: number, steps = 6): Segment[] {
  const out: Segment[] = [];
  let px = cx + r * Math.cos(a0);
  let py = cy + r * Math.sin(a0);
  for (let i = 1; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    out.push(seg(px, py, x, y));
    px = x;
    py = y;
  }
  return out;
}

export const MOTIFS: { id: MotifId; name: string; cell: CellFn }[] = [
  {
    id: "diagonalLattice",
    name: "Diagonal lattice",
    cell: (o, p, s) => [seg(o, p, o + s, p + s), seg(o + s, p, o, p + s)],
  },
  {
    id: "diamonds",
    name: "Diamonds",
    cell: (o, p, s) => [
      seg(o + s / 2, p, o + s, p + s / 2),
      seg(o + s, p + s / 2, o + s / 2, p + s),
      seg(o + s / 2, p + s, o, p + s / 2),
      seg(o, p + s / 2, o + s / 2, p),
    ],
  },
  {
    id: "squares",
    name: "Squares",
    cell: (o, p, s) => [
      seg(o, p, o + s, p),
      seg(o + s, p, o + s, p + s),
      seg(o + s, p + s, o, p + s),
      seg(o, p + s, o, p),
    ],
  },
  {
    id: "chevron",
    name: "Chevron",
    cell: (o, p, s) => [seg(o, p + s, o + s / 2, p), seg(o + s / 2, p, o + s, p + s)],
  },
  {
    id: "crosshatch",
    name: "Cross-hatch",
    cell: (o, p, s) => [
      seg(o, p, o + s, p + s),
      seg(o + s, p, o, p + s),
      seg(o + s / 2, p, o + s / 2, p + s),
      seg(o, p + s / 2, o + s, p + s / 2),
    ],
  },
  {
    id: "star8",
    name: "Eight-point star",
    cell: (o, p, s) => {
      const cx = o + s / 2;
      const cy = p + s / 2;
      const h = s / 2;
      return [
        seg(cx - h, cy, cx + h, cy),
        seg(cx, cy - h, cx, cy + h),
        seg(cx - h, cy - h, cx + h, cy + h),
        seg(cx + h, cy - h, cx - h, cy + h),
      ];
    },
  },
  {
    id: "pinwheel",
    name: "Pinwheel",
    cell: (o, p, s) => {
      const m = s / 2;
      return [
        seg(o, p, o + m, p),
        seg(o + m, p, o + m, p + m),
        seg(o + s, p, o + s, p + m),
        seg(o + s, p + m, o + m, p + m),
        seg(o + s, p + s, o + m, p + s),
        seg(o + m, p + s, o + m, p + m),
        seg(o, p + s, o, p + m),
        seg(o, p + m, o + m, p + m),
      ];
    },
  },
  {
    id: "scales",
    name: "Fish scales",
    cell: (o, p, s) => [
      ...arcSegs(o, p, s / 2, 0, Math.PI / 2),
      ...arcSegs(o + s, p, s / 2, Math.PI / 2, Math.PI),
    ],
  },
  {
    id: "woven",
    name: "Woven (seeded)",
    cell: (o, p, s, rand) =>
      rand() < 0.5
        ? [seg(o, p, o + s, p + s), seg(o + s / 2, p, o + s / 2, p + s)]
        : [seg(o + s, p, o, p + s), seg(o, p + s / 2, o + s, p + s / 2)],
  },
];

// ─── Geometry: dedupe, clip to region ────────────────────────────────────

function dedupeSegments(segs: Segment[], tol: number): Segment[] {
  const seen = new Set<string>();
  const q = (v: number) => Math.round(v / tol);
  const out: Segment[] = [];
  for (const [a, b] of segs) {
    const ka = `${q(a.x)},${q(a.y)}`;
    const kb = `${q(b.x)},${q(b.y)}`;
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([a, b]);
  }
  return out;
}

function insideRings(rings: Ring[], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

/** Clip a segment to the region: keep the sub-segments whose midpoints are
 *  inside (even-odd). Intersections with every ring edge split the segment. */
function clipSegment(s: Segment, rings: Ring[]): Segment[] {
  const [a, b] = s;
  const ts: number[] = [0, 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const p = ring[j];
      const q = ring[i];
      const ex = q.x - p.x;
      const ey = q.y - p.y;
      const denom = dx * ey - dy * ex;
      if (Math.abs(denom) < 1e-9) continue;
      const t = ((p.x - a.x) * ey - (p.y - a.y) * ex) / denom;
      const u = ((p.x - a.x) * dy - (p.y - a.y) * dx) / denom;
      if (t > 1e-6 && t < 1 - 1e-6 && u >= -1e-6 && u <= 1 + 1e-6) ts.push(t);
    }
  }
  ts.sort((m, n) => m - n);
  const out: Segment[] = [];
  for (let i = 1; i < ts.length; i++) {
    const t0 = ts[i - 1];
    const t1 = ts[i];
    if (t1 - t0 < 1e-4) continue;
    const mt = (t0 + t1) / 2;
    if (insideRings(rings, a.x + dx * mt, a.y + dy * mt)) {
      out.push(seg(a.x + dx * t0, a.y + dy * t0, a.x + dx * t1, a.y + dy * t1));
    }
  }
  return out;
}

function ringsToSegments(rings: Ring[]): Segment[] {
  const out: Segment[] = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      out.push(seg(a.x, a.y, b.x, b.y));
    }
  }
  return out;
}

/** Route just the region outline (for two-color mode, sewn as its own thread). */
export function outlineStrokes(
  rings: Ring[],
  route: "holbein" | "eulerian" | "asDrawn",
  stitchLenMm: number,
): PathMm[] {
  const segs = ringsToSegments(rings);
  if (segs.length === 0) return [];
  if (route === "holbein") return holbeinRoute(segs, stitchLenMm, 0.3).strokes;
  return planStrokes(segs, 0.3).strokes;
}

// ─── The blackwork build (pure) ──────────────────────────────────────────

export type BlackworkOpts = {
  motif?: MotifId;
  pitchMm?: number;
  seed?: number;
  outline?: boolean;
  route?: "holbein" | "eulerian" | "asDrawn";
  stitchLenMm?: number;
};

export type BlackworkResult = {
  strokes: PathMm[];
  stats: { keptSegments: number; strokes: number; duplicatedEdges: number };
};

/** Fill the region rings with the motif, clipped and routed. */
export function blackworkFill(rings: Ring[], opts: BlackworkOpts = {}): BlackworkResult {
  const motifId = opts.motif ?? "diagonalLattice";
  const pitch = Math.max(2, opts.pitchMm ?? 8);
  const rand = mulberry32(opts.seed ?? 1);
  const route = opts.route ?? "holbein";
  const stitchLen = opts.stitchLenMm ?? 2.2;
  const motif = MOTIFS.find((m) => m.id === motifId) ?? MOTIFS[0];

  if (rings.length === 0) return { strokes: [], stats: { keptSegments: 0, strokes: 0, duplicatedEdges: 0 } };
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
  // Tile the motif across the bbox (aligned to a pitch grid through origin).
  const raw: Segment[] = [];
  const x0 = Math.floor(minX / pitch) * pitch;
  const y0 = Math.floor(minY / pitch) * pitch;
  for (let y = y0; y < maxY + pitch; y += pitch) {
    for (let x = x0; x < maxX + pitch; x += pitch) {
      for (const s of motif.cell(x, y, pitch, rand)) raw.push(s);
    }
  }
  const deduped = dedupeSegments(raw, Math.max(0.05, pitch * 0.02));
  let clipped: Segment[] = [];
  for (const s of deduped) for (const c of clipSegment(s, rings)) clipped.push(c);
  if (opts.outline ?? true) clipped = clipped.concat(ringsToSegments(rings));

  if (clipped.length === 0) return { strokes: [], stats: { keptSegments: 0, strokes: 0, duplicatedEdges: 0 } };

  const tol = Math.max(0.1, pitch * 0.03);
  if (route === "holbein") {
    const hb = holbeinRoute(clipped, stitchLen, tol);
    return {
      strokes: hb.strokes,
      stats: { keptSegments: clipped.length, strokes: hb.strokes.length, duplicatedEdges: 0 },
    };
  }
  if (route === "eulerian") {
    const r = planStrokes(clipped, tol);
    return {
      strokes: r.strokes,
      stats: { keptSegments: clipped.length, strokes: r.strokes.length, duplicatedEdges: r.stats.duplicatedEdges },
    };
  }
  // as-drawn: each clipped segment is its own tiny stroke (many trims).
  return {
    strokes: clipped.map(([a, b]) => [a, b]),
    stats: { keptSegments: clipped.length, strokes: clipped.length, duplicatedEdges: 0 },
  };
}

// ─── Curated presets ─────────────────────────────────────────────────────

export type Preset = {
  name: string;
  shape: "circle" | "square" | "heart" | "star" | "ring";
  motif: MotifId;
  pitchMm: number;
  sizeMm: number;
  route: "holbein" | "eulerian" | "asDrawn";
  outline: boolean;
  seed: number;
};

export const PRESETS: Preset[] = [
  { name: "Sampler diamond", shape: "square", motif: "diamonds", pitchMm: 9, sizeMm: 100, route: "holbein", outline: true, seed: 1 },
  { name: "Heart in lattice", shape: "heart", motif: "diagonalLattice", pitchMm: 7, sizeMm: 95, route: "holbein", outline: true, seed: 1 },
  { name: "Tudor rose ground", shape: "circle", motif: "star8", pitchMm: 11, sizeMm: 110, route: "holbein", outline: true, seed: 1 },
  { name: "Chevron field", shape: "square", motif: "chevron", pitchMm: 8, sizeMm: 120, route: "eulerian", outline: false, seed: 1 },
  { name: "Scale mail", shape: "circle", motif: "scales", pitchMm: 10, sizeMm: 105, route: "eulerian", outline: true, seed: 1 },
  { name: "Pinwheel star", shape: "star", motif: "pinwheel", pitchMm: 9, sizeMm: 120, route: "holbein", outline: true, seed: 1 },
  { name: "Woven ring", shape: "ring", motif: "woven", pitchMm: 8, sizeMm: 110, route: "eulerian", outline: true, seed: 7 },
  { name: "Fine cross-hatch", shape: "square", motif: "crosshatch", pitchMm: 5, sizeMm: 90, route: "eulerian", outline: true, seed: 1 },
  { name: "Bold squares", shape: "square", motif: "squares", pitchMm: 12, sizeMm: 120, route: "holbein", outline: true, seed: 1 },
];

// ─── Test-sheet mode: a labeled matrix of motif × pitch ──────────────────

/** One hoop-ready sheet: rows = motifs, cols = pitches, each a small filled
 *  square with a single-line label. Mechanically credible (moderate size). */
export function testSheet(): PathMm[] {
  const motifs: MotifId[] = ["diagonalLattice", "diamonds", "star8", "chevron"];
  const pitches = [6, 9, 12];
  const swatch = 44; // mm per swatch
  const gap = 10;
  const labelH = 6;
  const cols = pitches.length;
  const rows = motifs.length;
  const totalW = cols * swatch + (cols - 1) * gap + 34;
  const totalH = rows * (swatch + labelH + gap);
  const ox = -totalW / 2;
  const oy = -totalH / 2;
  const out: PathMm[] = [];
  motifs.forEach((m, ri) => {
    const cy = oy + ri * (swatch + labelH + gap);
    // row label
    for (const p of layoutText({ text: m.slice(0, 8), faceId: "sans", heightMm: 4, stitchLenMm: 1.5 })) {
      out.push(p.map((q) => ({ x: q.x + ox + 14, y: q.y + cy + swatch / 2 })));
    }
    pitches.forEach((pitch, ci) => {
      const cx = ox + 34 + ci * (swatch + gap);
      const rings: Ring[] = [
        [
          { x: cx, y: cy },
          { x: cx + swatch, y: cy },
          { x: cx + swatch, y: cy + swatch },
          { x: cx, y: cy + swatch },
        ],
      ];
      const r = blackworkFill(rings, { motif: m, pitchMm: pitch, route: "eulerian", outline: true, stitchLenMm: 2.2 });
      for (const s of r.strokes) out.push(resamplePath(s, 2.2, 0.3));
    });
  });
  return out;
}

// ─── Component ───────────────────────────────────────────────────────────

const NAME = "bayside-blackwork";

export default function BlackworkTool() {
  const [motif, setMotif] = useState<MotifId>("diamonds");
  const [pitch, setPitch] = useState(9);
  const [sizeMm, setSizeMm] = useState(100);
  const [route, setRoute] = useState<"holbein" | "eulerian" | "asDrawn">("holbein");
  const [outline, setOutline] = useState(true);
  const [seed, setSeed] = useState(1);
  const [fabric, setFabric] = useState<FabricId>("canvas");
  const [stitchLen, setStitchLen] = useState(2.2);
  const [bean, setBean] = useState<1 | 3>(1);
  const [sheet, setSheet] = useState(false);
  const [twoTone, setTwoTone] = useState(false);
  const [threadHex, setThreadHex] = useState(
    THREADS.find((t) => t.family === "Black" && t.hex)?.hex ??
      THREADS.find((t) => t.hex)?.hex ??
      "#1c1c1a",
  );
  const [threadHexB, setThreadHexB] = useState(
    THREADS.find((t) => t.family === "Red" && t.hex && !t.isMetallic)?.hex ?? "#8a2020",
  );

  const dPitch = useDebounced(pitch);
  const dSize = useDebounced(sizeMm);
  const { rings, element: shapeElement } = useShapeSource(dSize, "square");

  const applyPreset = (p: Preset) => {
    setMotif(p.motif);
    setPitch(p.pitchMm);
    setSizeMm(p.sizeMm);
    setRoute(p.route);
    setOutline(p.outline);
    setSeed(p.seed);
    setSheet(false);
  };

  const built = useMemo(() => {
    if (sheet) {
      const paths = testSheet();
      return {
        built: buildDesign(pathsToStitches(paths, 1), "bayside-blackwork-sheet"),
        info: { strokes: paths.length, dup: 0 },
      };
    }
    if (rings.length === 0) return { built: null, info: null, twoTone: false };
    // Holbein already double-covers; bean only for non-holbein routes.
    const passes = route === "holbein" ? 1 : bean;
    const twoToneActive = twoTone && outline && route !== "asDrawn";
    if (twoToneActive) {
      // Pattern and frame as two separate thread colors (one color change).
      const pat = blackworkFill(rings, { motif, pitchMm: dPitch, seed, outline: false, route, stitchLenMm: stitchLen });
      const frame = outlineStrokes(rings, route, stitchLen);
      const gA = pat.strokes.map((s) => resamplePath(s, stitchLen, 0.3)).filter((s) => s.length >= 2);
      const gB = frame.map((s) => resamplePath(s, stitchLen, 0.3)).filter((s) => s.length >= 2);
      if (gA.length === 0 && gB.length === 0) return { built: null, info: null, twoTone: false };
      return {
        built: buildDesign(pathGroupsToStitches([gA, gB], passes), NAME),
        info: { strokes: pat.stats.strokes + frame.length, dup: pat.stats.duplicatedEdges },
        twoTone: true,
      };
    }
    const res = blackworkFill(rings, { motif, pitchMm: dPitch, seed, outline, route, stitchLenMm: stitchLen });
    if (res.strokes.length === 0) return { built: null, info: null, twoTone: false };
    const sampled = res.strokes.map((s) => resamplePath(s, stitchLen, 0.3)).filter((s) => s.length >= 2);
    return {
      built: buildDesign(pathsToStitches(sampled, passes), NAME),
      info: { strokes: res.stats.strokes, dup: res.stats.duplicatedEdges },
      twoTone: false,
    };
  }, [sheet, rings, motif, dPitch, seed, outline, route, stitchLen, bean, twoTone]);

  const stitchCount = built.built?.stats.realStitches ?? 0;
  const previewColors = built.twoTone ? [threadHex, threadHexB] : [threadHex];

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="Presets">
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.name}
                  onClick={() => applyPreset(p)}
                  className="border border-hairline bg-bg px-2.5 py-1 text-[0.6875rem] text-fg hover:bg-card"
                >
                  {p.name}
                </button>
              ))}
              <button
                onClick={() => {
                  const m = MOTIFS[Math.floor(Math.random() * MOTIFS.length)].id;
                  setMotif(m);
                  setPitch(5 + Math.floor(Math.random() * 8));
                  setSeed(Math.floor(Math.random() * 100000));
                  setSheet(false);
                }}
                className="border border-fg bg-fg text-bg px-2.5 py-1 text-[0.6875rem] hover:opacity-85"
              >
                Surprise me
              </button>
            </div>
          </SectionBox>

          <SectionBox eyebrow="Pattern">
            <div>
              <div className="text-[0.6875rem] tracking-[0.14em] uppercase text-mid mb-1.5">Motif</div>
              <ModeButtons
                small
                options={MOTIFS.map((m) => [m.id, m.name] as const)}
                value={motif}
                onChange={(v) => {
                  setMotif(v);
                  setSheet(false);
                }}
              />
            </div>
            <RangeRow label="Spacing" value={pitch} min={4} max={20} step={0.5} onChange={setPitch} fmt={(v) => `${v.toFixed(1)} mm`} />
            {motif === "woven" && (
              <button
                onClick={() => setSeed(Math.floor(Math.random() * 100000))}
                className="border border-hairline bg-bg px-3 py-1 text-[0.75rem] text-fg hover:bg-card"
              >
                Reshuffle weave (seed {seed})
              </button>
            )}
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              A lattice motif tiled across your shape and clipped to its edge. Finer pitch =
              denser, more delicate - but watch the stitch count and fabric.
            </p>
          </SectionBox>

          <SectionBox eyebrow="Region">
            {shapeElement}
            <SizeField valueMm={sizeMm} min={40} max={330} onChange={setSizeMm} />
            <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer">
              <input type="checkbox" checked={outline} onChange={(ev) => setOutline(ev.target.checked)} className="accent-accent" />
              Frame with an outline
            </label>
            {outline && route !== "asDrawn" && (
              <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer">
                <input type="checkbox" checked={twoTone} onChange={(ev) => setTwoTone(ev.target.checked)} className="accent-accent" />
                Two colors (frame in a second thread)
              </label>
            )}
          </SectionBox>

          <SectionBox eyebrow="Routing &amp; stitch">
            <div>
              <div className="text-[0.6875rem] tracking-[0.14em] uppercase text-mid mb-1.5">Route</div>
              <ModeButtons
                small
                options={[
                  ["holbein", "Reversible (Holbein)"],
                  ["eulerian", "One-stroke"],
                  ["asDrawn", "As drawn"],
                ]}
                value={route}
                onChange={setRoute}
              />
              <p className="mt-1.5 text-[0.6875rem] text-mid leading-relaxed">
                {route === "holbein"
                  ? "Double-running out and back - the classic blackwork line, clean on front and back."
                  : route === "eulerian"
                    ? "The whole pattern connected into the fewest continuous strokes (minimal trims)."
                    : "Every segment sewn separately - many trims (comparison only)."}
              </p>
            </div>
            <FabricSelect value={fabric} onChange={(id) => { setFabric(id); setStitchLen(id === "leather" ? 3 : 2.2); }} />
            <RangeRow label="Stitch length" value={stitchLen} min={1.5} max={4} step={0.1} onChange={setStitchLen} fmt={(v) => `${v.toFixed(1)} mm`} />
            {route !== "holbein" && (
              <ModeButtons
                small
                options={[
                  [1, "Run"],
                  [3, "Bean ×3"],
                ]}
                value={bean}
                onChange={setBean}
              />
            )}
            <ThreadRow label={built.twoTone ? "Pattern" : "Thread"} hex={threadHex} onChange={(hex) => setThreadHex(hex)} />
            {built.twoTone && <ThreadRow label="Frame" hex={threadHexB} onChange={(hex) => setThreadHexB(hex)} />}
            <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer pt-1">
              <input type="checkbox" checked={sheet} onChange={(ev) => setSheet(ev.target.checked)} className="accent-accent" />
              Test sheet (motif × pitch matrix)
            </label>
          </SectionBox>
        </>
      }
      preview={
        <PreviewRail built={built.built} colors={sheet ? [threadHex] : previewColors} name={sheet ? "bayside-blackwork-sheet" : NAME} emptyHint="Pick a preset or a shape.">
          {built.info && built.built && (
            <p className="text-[0.75rem] text-mid tabular-nums">
              {sheet
                ? "test sheet · motif × pitch matrix"
                : route === "holbein"
                  ? `reversible double-running · ${built.info.strokes} stroke${built.info.strokes === 1 ? "" : "s"} · clean front & back`
                  : route === "eulerian"
                    ? `${built.info.strokes} continuous stroke${built.info.strokes === 1 ? "" : "s"} · ${built.info.dup} edges doubled for continuity`
                    : `${built.info.strokes} segments · as-drawn (many trims)`}
            </p>
          )}
          {pitch < 5 && (
            <Warning>Pitch under 5&nbsp;mm gets dense fast - check the stitch count and test on stable fabric.</Warning>
          )}
          {stitchCount > 60000 && <Warning>Over 60k stitches - coarser pitch or smaller region.</Warning>}
        </PreviewRail>
      }
    />
  );
}
