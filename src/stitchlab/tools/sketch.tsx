// Stitch Lab tool: Sketch - creative coding for the needle. A tiny p5.js-spirit
// drawing environment where you write JavaScript that draws, and every line you
// draw becomes real running-stitch geometry in a downloadable DST. The canvas
// is a 100×100 unit space, y-down like p5; you get line/circle/arc/polygon, a
// path builder, seeded random + value noise, and the usual math - then the
// sketch's strokes are scaled to your hoop and sewn, grouped by stroke color.
//
// runSketch is pure and deterministic (seeded RNG/noise, no DOM, no clock) so
// node can test it; the component is the editor + live preview around it. User
// code runs via `new Function` - this is an unlisted internal bench tool, and
// the sketch only ever touches the drawing API it's handed.

import { useMemo, useState } from "react";
import {
  ToolLayout,
  SectionBox,
  RangeRow,
  ModeButtons,
  ThreadRow,
  Warning,
  PreviewRail,
  buildDesign,
  LABEL,
  useDebounced,
  fmtLen, useUnits,
} from "./shared";
import { pathGroupsToStitches, resamplePath, fitPaths, type PathMm } from "../lib/generators";
import { THREADS } from "../../data/threads";

// ─── Seeded value noise (deterministic p5-ish noise) ─────────────────────

function makeNoise(seed: number) {
  // Hash-based 2D value noise with smoothstep interpolation. Deterministic.
  const hash = (x: number, y: number) => {
    let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y = 0) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const tl = hash(xi, yi);
    const tr = hash(xi + 1, yi);
    const bl = hash(xi, yi + 1);
    const br = hash(xi + 1, yi + 1);
    const u = smooth(xf);
    const v = smooth(yf);
    const top = tl + (tr - tl) * u;
    const bot = bl + (br - bl) * u;
    return top + (bot - top) * v;
  };
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Pure sketch runner ──────────────────────────────────────────────────

export type SketchResult = {
  groups: PathMm[][];
  colors: string[];
  error: string | null;
  strokeCount: number;
  pointCount: number;
};

const CANVAS = 100; // sketch coordinate space (units), y-down, origin top-left

// The drawing surface both the code editor and the block builder share.
export type SketchAPI = {
  W: number; H: number;
  stroke: (hex: string) => void;
  line: (x1: number, y1: number, x2: number, y2: number) => void;
  polyline: (pts: [number, number][]) => void;
  polygon: (pts: [number, number][]) => void;
  rect: (x: number, y: number, w: number, h: number) => void;
  circle: (cx: number, cy: number, r: number, segs?: number) => void;
  ellipse: (cx: number, cy: number, rx: number, ry: number, segs?: number) => void;
  arc: (cx: number, cy: number, r: number, a0: number, a1: number, segs?: number) => void;
  beginPath: () => void;
  vertex: (x: number, y: number) => void;
  endPath: (close?: boolean) => void;
  random: (a?: number, b?: number) => number;
  randomSeed: (s: number) => void;
  noise: (x: number, y?: number) => number;
  noiseSeed: (s: number) => void;
  [k: string]: unknown;
};

/**
 * Build a fresh drawing context: the API the sketch draws with, and a collect()
 * that returns the color-grouped strokes. Strokes are grouped by stroke() color
 * in first-appearance order. Deterministic for a given seed; a point budget
 * caps runaway loops (spend throws, the caller catches). Shared by the code
 * runner and the block runner so both draw exactly the same geometry.
 */
export function createSketchContext(opts: { seed?: number; defaultHex?: string; maxPoints?: number }) {
  const seed = opts.seed ?? 1;
  let budget = opts.maxPoints ?? 140000;
  const strokes: { hex: string; pts: PathMm }[] = [];
  let curHex = opts.defaultHex ?? "#0b1f3a";
  let building: PathMm | null = null;

  const spend = (n: number) => {
    budget -= n;
    if (budget < 0) throw new Error("Drew too much - over the point budget. Use fewer/shorter strokes.");
  };
  const emit = (pts: PathMm) => { if (pts.length >= 2) { spend(pts.length); strokes.push({ hex: curHex, pts }); } };
  const rand = mulberry32(seed);
  let noise = makeNoise(seed);
  const arcPts = (cx: number, cy: number, r: number, a0: number, a1: number, segs?: number): PathMm => {
    const span = Math.abs(a1 - a0);
    const n = Math.max(3, segs ?? Math.ceil((span / (Math.PI * 2)) * Math.max(16, r * 1.2)));
    const out: PathMm = [];
    for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); }
    return out;
  };

  const api = {
    W: CANVAS, H: CANVAS, PI: Math.PI, TAU: Math.PI * 2,
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    sqrt: Math.sqrt, abs: Math.abs, min: Math.min, max: Math.max,
    floor: Math.floor, ceil: Math.ceil, round: Math.round,
    pow: Math.pow, exp: Math.exp, hypot: Math.hypot, atan2: Math.atan2, sign: Math.sign,
    map: (v: number, a: number, b: number, c: number, d: number) => (b === a ? c : c + (d - c) * ((v - a) / (b - a))),
    lerp: (a: number, b: number, t: number) => a + (b - a) * t,
    clamp: (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v)),
    dist: (x1: number, y1: number, x2: number, y2: number) => Math.hypot(x2 - x1, y2 - y1),
    random: (a?: number, b?: number) => (a === undefined ? rand() : b === undefined ? rand() * a : a + rand() * (b - a)),
    randomSeed: (s: number) => { const r = mulberry32(s >>> 0); (api as { random: unknown }).random = (a?: number, b?: number) => (a === undefined ? r() : b === undefined ? r() * a : a + r() * (b - a)); },
    noise: (x: number, y = 0) => noise(x, y),
    noiseSeed: (s: number) => { noise = makeNoise(s >>> 0); },
    stroke: (hex: string) => { if (typeof hex === "string" && /^#[0-9a-fA-F]{6}$/.test(hex)) curHex = hex; },
    line: (x1: number, y1: number, x2: number, y2: number) => emit([{ x: x1, y: y1 }, { x: x2, y: y2 }]),
    polyline: (pts: [number, number][]) => emit(pts.map(([x, y]) => ({ x, y }))),
    polygon: (pts: [number, number][]) => { if (pts.length) emit([...pts, pts[0]].map(([x, y]) => ({ x, y }))); },
    rect: (x: number, y: number, w: number, h: number) => emit([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }]),
    circle: (cx: number, cy: number, r: number, segs?: number) => emit(arcPts(cx, cy, r, 0, Math.PI * 2, segs)),
    ellipse: (cx: number, cy: number, rx: number, ry: number, segs?: number) => {
      const n = Math.max(12, segs ?? Math.ceil(Math.max(rx, ry) * 1.2));
      const out: PathMm = [];
      for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2; out.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry }); }
      emit(out);
    },
    arc: (cx: number, cy: number, r: number, a0: number, a1: number, segs?: number) => emit(arcPts(cx, cy, r, a0, a1, segs)),
    beginPath: () => { building = []; },
    vertex: (x: number, y: number) => { if (building) building.push({ x, y }); },
    endPath: (close?: boolean) => { if (building) { if (close && building.length) building.push({ ...building[0] }); emit(building); building = null; } },
  };

  const collect = (): Omit<SketchResult, "error"> => {
    const dangling = building as PathMm | null;
    if (dangling && dangling.length >= 2) emit(dangling);
    const order: string[] = [];
    const byHex = new Map<string, PathMm[]>();
    for (const s of strokes) { let g = byHex.get(s.hex); if (!g) { g = []; byHex.set(s.hex, g); order.push(s.hex); } g.push(s.pts); }
    return {
      groups: order.map((h) => byHex.get(h)!),
      colors: order,
      strokeCount: strokes.length,
      pointCount: strokes.reduce((n, s) => n + s.pts.length, 0),
    };
  };

  return { api, collect };
}

/** Run a text sketch (code editor). Deterministic; errors are captured. */
export function runSketch(code: string, opts: { seed?: number; defaultHex?: string; maxPoints?: number }): SketchResult {
  const { api, collect } = createSketchContext(opts);
  let error: string | null = null;
  try {
    const keys = Object.keys(api);
    const body = `"use strict";\nconst {${keys.join(",")}} = __api;\n${code}\n`;
    // eslint-disable-next-line no-new-func
    const fn = new Function("__api", body) as (a: typeof api) => void;
    fn(api);
  } catch (e) {
    error = e instanceof Error ? e.message : "Sketch error.";
  }
  return { ...collect(), error };
}

// ─── Block programming (no-code) ─────────────────────────────────────────
// Each block draws one parametric motif using the shared API. A program is a
// vertical stack of blocks; there's no nesting or loops to reason about - the
// accessibility win of Scratch/Snap without the drag-and-drop machinery.

export type BlockParam =
  | { key: string; label: string; min: number; max: number; step: number }
  | { key: string; label: string; kind: "color" };

export type BlockDef = {
  type: string;
  label: string;
  hint: string;
  params: BlockParam[];
  defaults: Record<string, number | string>;
  draw: (api: SketchAPI, p: Record<string, number | string>, cx: number, cy: number) => void;
};

const n = (p: Record<string, number | string>, k: string, d = 0) => (typeof p[k] === "number" ? (p[k] as number) : d);
const TAU = Math.PI * 2;

export const BLOCK_DEFS: BlockDef[] = [
  {
    type: "color", label: "Set thread color", hint: "Everything after this block sews in this thread.",
    params: [{ key: "hex", label: "Color", kind: "color" }], defaults: { hex: "#b4472e" },
    draw: (api, p) => api.stroke(String(p.hex)),
  },
  {
    type: "concentricRings", label: "Concentric rings", hint: "Rings nested around the center.",
    params: [{ key: "count", label: "Rings", min: 1, max: 20, step: 1 }, { key: "gap", label: "Spacing", min: 1, max: 8, step: 0.5 }],
    defaults: { count: 8, gap: 4 },
    draw: (api, p, cx, cy) => { const c = n(p, "count"), g = n(p, "gap"); for (let k = 1; k <= c; k++) api.circle(cx, cy, k * g); },
  },
  {
    type: "circleGrid", label: "Grid of circles", hint: "A repeating grid of little circles.",
    params: [{ key: "cols", label: "Columns", min: 1, max: 14, step: 1 }, { key: "rows", label: "Rows", min: 1, max: 14, step: 1 }, { key: "r", label: "Radius", min: 1, max: 12, step: 0.5 }, { key: "rings", label: "Rings each", min: 1, max: 5, step: 1 }],
    defaults: { cols: 6, rows: 6, r: 5, rings: 2 },
    draw: (api, p) => { const cols = n(p, "cols"), rows = n(p, "rows"), r = n(p, "r"), rings = n(p, "rings"); const sx = api.W / (cols + 1), sy = api.H / (rows + 1); for (let gy = 1; gy <= rows; gy++) for (let gx = 1; gx <= cols; gx++) for (let k = 1; k <= rings; k++) api.circle(gx * sx, gy * sy, (r * k) / rings); },
  },
  {
    type: "spiral", label: "Spiral", hint: "One line spiralling out from the center.",
    params: [{ key: "turns", label: "Turns", min: 2, max: 40, step: 1 }, { key: "radius", label: "Radius", min: 5, max: 48, step: 1 }],
    defaults: { turns: 14, radius: 42 },
    draw: (api, p, cx, cy) => { const turns = n(p, "turns"), R = n(p, "radius"); api.beginPath(); for (let a = 0; a <= turns * TAU; a += 0.12) { const r = (a / (turns * TAU)) * R; api.vertex(cx + Math.cos(a) * r, cy + Math.sin(a) * r); } api.endPath(); },
  },
  {
    type: "rose", label: "Rose curve", hint: "A flower / petal curve.",
    params: [{ key: "petals", label: "Petals", min: 2, max: 12, step: 1 }, { key: "radius", label: "Radius", min: 8, max: 48, step: 1 }],
    defaults: { petals: 5, radius: 42 },
    draw: (api, p, cx, cy) => { const k = n(p, "petals"), R = n(p, "radius"); const loops = k % 2 === 0 ? 1 : 1; api.beginPath(); for (let a = 0; a <= TAU * (k % 2 === 0 ? 2 : 1) * loops; a += 0.03) { const r = R * Math.cos(k * a); api.vertex(cx + Math.cos(a) * r, cy + Math.sin(a) * r); } api.endPath(); },
  },
  {
    type: "starburst", label: "String-art star", hint: "Chords across a ring of points.",
    params: [{ key: "points", label: "Points", min: 12, max: 120, step: 1 }, { key: "skip", label: "Skip", min: 2, max: 60, step: 1 }, { key: "radius", label: "Radius", min: 10, max: 48, step: 1 }],
    defaults: { points: 72, skip: 31, radius: 46 },
    draw: (api, p, cx, cy) => { const pts = n(p, "points"), skip = n(p, "skip"), R = n(p, "radius"); for (let i = 0; i < pts; i++) { const a1 = (i / pts) * TAU, a2 = (((i * skip) % pts) / pts) * TAU; api.line(cx + Math.cos(a1) * R, cy + Math.sin(a1) * R, cx + Math.cos(a2) * R, cy + Math.sin(a2) * R); } },
  },
  {
    type: "waveRows", label: "Wave rows", hint: "Stacked sine waves - ribbons / water.",
    params: [{ key: "rows", label: "Rows", min: 3, max: 40, step: 1 }, { key: "amp", label: "Amplitude", min: 0, max: 12, step: 0.5 }, { key: "freq", label: "Frequency", min: 1, max: 12, step: 0.5 }],
    defaults: { rows: 20, amp: 5, freq: 4 },
    draw: (api, p) => { const rows = n(p, "rows"), amp = n(p, "amp"), freq = n(p, "freq"); const m = 8; for (let r = 0; r < rows; r++) { const y0 = m + (r * (api.H - 2 * m)) / (rows - 1); api.beginPath(); for (let x = m; x <= api.W - m; x += 1.5) api.vertex(x, y0 + amp * Math.sin((x / api.W) * freq * TAU + r * 0.4)); api.endPath(); } },
  },
  {
    type: "polygonRing", label: "Ring of polygons", hint: "N shapes arranged in a circle.",
    params: [{ key: "count", label: "Count", min: 3, max: 30, step: 1 }, { key: "sides", label: "Sides", min: 3, max: 10, step: 1 }, { key: "r", label: "Shape size", min: 2, max: 14, step: 0.5 }, { key: "radius", label: "Ring radius", min: 8, max: 44, step: 1 }],
    defaults: { count: 10, sides: 6, r: 7, radius: 32 },
    draw: (api, p, cx, cy) => { const count = n(p, "count"), sides = n(p, "sides"), r = n(p, "r"), R = n(p, "radius"); for (let i = 0; i < count; i++) { const a = (i / count) * TAU, px = cx + Math.cos(a) * R, py = cy + Math.sin(a) * R; const poly: [number, number][] = []; for (let s = 0; s < sides; s++) { const sa = (s / sides) * TAU - Math.PI / 2; poly.push([px + Math.cos(sa) * r, py + Math.sin(sa) * r]); } api.polygon(poly); } },
  },
  {
    type: "lissajous", label: "Lissajous", hint: "A woven parametric loop.",
    params: [{ key: "a", label: "X frequency", min: 1, max: 9, step: 1 }, { key: "b", label: "Y frequency", min: 1, max: 9, step: 1 }, { key: "radius", label: "Radius", min: 10, max: 46, step: 1 }],
    defaults: { a: 3, b: 4, radius: 44 },
    draw: (api, p, cx, cy) => { const a = n(p, "a"), b = n(p, "b"), R = n(p, "radius"); api.beginPath(); for (let t = 0; t <= TAU; t += 0.005) api.vertex(cx + R * Math.sin(a * t + Math.PI / 2), cy + R * Math.sin(b * t)); api.endPath(true); },
  },
  {
    type: "grid", label: "Cross-hatch grid", hint: "Ruled lines - a woven or graph texture.",
    params: [{ key: "cols", label: "Verticals", min: 0, max: 40, step: 1 }, { key: "rows", label: "Horizontals", min: 0, max: 40, step: 1 }],
    defaults: { cols: 16, rows: 16 },
    draw: (api, p) => { const cols = n(p, "cols"), rows = n(p, "rows"), m = 6; for (let i = 0; i <= cols; i++) { const x = m + (i * (api.W - 2 * m)) / Math.max(1, cols); api.line(x, m, x, api.H - m); } for (let j = 0; j <= rows; j++) { const y = m + (j * (api.H - 2 * m)) / Math.max(1, rows); api.line(m, y, api.W - m, y); } },
  },
  {
    type: "concentricPolygons", label: "Nested polygons", hint: "Polygons nested inside each other, optionally twisting.",
    params: [{ key: "sides", label: "Sides", min: 3, max: 10, step: 1 }, { key: "count", label: "Count", min: 1, max: 14, step: 1 }, { key: "size", label: "Size", min: 6, max: 46, step: 1 }, { key: "twist", label: "Twist", min: 0, max: 30, step: 1 }],
    defaults: { sides: 6, count: 8, size: 44, twist: 6 },
    draw: (api, p, cx, cy) => { const sides = n(p, "sides"), count = n(p, "count"), size = n(p, "size"), tw = (n(p, "twist") * Math.PI) / 180; for (let k = 1; k <= count; k++) { const r = (size * k) / count; const poly: [number, number][] = []; for (let s = 0; s <= sides; s++) { const a = (s / sides) * TAU - Math.PI / 2 + tw * k; poly.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } api.polyline(poly); } },
  },
  {
    type: "spirograph", label: "Spirograph", hint: "The classic hypotrochoid - one looping continuous line.",
    params: [{ key: "outer", label: "Outer wheel", min: 20, max: 48, step: 1 }, { key: "inner", label: "Inner wheel", min: 3, max: 24, step: 1 }, { key: "pen", label: "Pen offset", min: 2, max: 24, step: 1 }],
    defaults: { outer: 44, inner: 9, pen: 16 },
    draw: (api, p, cx, cy) => { const R = n(p, "outer"), r = Math.max(1, n(p, "inner")), d = n(p, "pen"); const gcd = (a: number, b: number): number => { a = Math.abs(Math.round(a)); b = Math.abs(Math.round(b)); while (b) { const t = b; b = a % b; a = t; } return a || 1; }; const rev = r / gcd(R, r); api.beginPath(); for (let t = 0; t <= TAU * rev + 0.01; t += 0.03) { const x = (R - r) * Math.cos(t) + d * Math.cos(((R - r) / r) * t); const y = (R - r) * Math.sin(t) - d * Math.sin(((R - r) / r) * t); api.vertex(cx + x, cy + y); } api.endPath(); },
  },
  {
    type: "starPolygon", label: "Star polygon", hint: "An {n/k} star drawn as a single unbroken line.",
    params: [{ key: "points", label: "Points", min: 5, max: 24, step: 1 }, { key: "skip", label: "Skip", min: 2, max: 11, step: 1 }, { key: "radius", label: "Radius", min: 10, max: 46, step: 1 }],
    defaults: { points: 8, skip: 3, radius: 44 },
    draw: (api, p, cx, cy) => { const pts = n(p, "points"), skip = Math.max(1, n(p, "skip")), R = n(p, "radius"); api.beginPath(); for (let i = 0; i <= pts; i++) { const idx = (i * skip) % pts; const a = (idx / pts) * TAU - Math.PI / 2; api.vertex(cx + Math.cos(a) * R, cy + Math.sin(a) * R); } api.endPath(); },
  },
  {
    type: "concentricSquares", label: "Nested squares", hint: "Squares inside squares - rotate toward diamonds.",
    params: [{ key: "count", label: "Count", min: 1, max: 16, step: 1 }, { key: "gap", label: "Spacing", min: 1.5, max: 6, step: 0.5 }, { key: "rotate", label: "Rotate", min: 0, max: 45, step: 1 }],
    defaults: { count: 9, gap: 5, rotate: 0 },
    draw: (api, p, cx, cy) => { const count = n(p, "count"), gap = n(p, "gap"), rot = (n(p, "rotate") * Math.PI) / 180, co = Math.cos(rot), si = Math.sin(rot); for (let k = 1; k <= count; k++) { const h = k * gap; const corners: [number, number][] = [[-h, -h], [h, -h], [h, h], [-h, h], [-h, -h]]; api.polyline(corners.map(([x, y]) => [cx + x * co - y * si, cy + x * si + y * co])); } },
  },
  {
    type: "heart", label: "Heart", hint: "A single heart outline.",
    params: [{ key: "size", label: "Size", min: 12, max: 48, step: 1 }],
    defaults: { size: 40 },
    draw: (api, p, cx, cy) => { const S = n(p, "size") / 17; api.beginPath(); for (let t = 0; t <= TAU + 0.05; t += 0.08) { const x = 16 * Math.sin(t) ** 3; const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)); api.vertex(cx + x * S, cy + y * S); } api.endPath(true); },
  },
  {
    type: "polarGrid", label: "Spider web", hint: "Concentric rings crossed by radial spokes.",
    params: [{ key: "rings", label: "Rings", min: 1, max: 14, step: 1 }, { key: "spokes", label: "Spokes", min: 3, max: 36, step: 1 }, { key: "radius", label: "Radius", min: 10, max: 48, step: 1 }],
    defaults: { rings: 6, spokes: 12, radius: 46 },
    draw: (api, p, cx, cy) => { const rings = n(p, "rings"), spokes = n(p, "spokes"), R = n(p, "radius"); for (let k = 1; k <= rings; k++) api.circle(cx, cy, (R * k) / rings); for (let s = 0; s < spokes; s++) { const a = (s / spokes) * TAU; api.line(cx, cy, cx + Math.cos(a) * R, cy + Math.sin(a) * R); } },
  },
  {
    type: "plaid", label: "Plaid weave", hint: "Wavy lines crossing both ways - tartan / weave.",
    params: [{ key: "lines", label: "Lines", min: 4, max: 30, step: 1 }, { key: "amp", label: "Wave", min: 0, max: 8, step: 0.5 }, { key: "freq", label: "Frequency", min: 1, max: 10, step: 0.5 }],
    defaults: { lines: 14, amp: 3, freq: 4 },
    draw: (api, p) => { const L = n(p, "lines"), amp = n(p, "amp"), freq = n(p, "freq"), m = 6; for (let i = 0; i <= L; i++) { const y0 = m + (i * (api.H - 2 * m)) / L; api.beginPath(); for (let x = m; x <= api.W - m; x += 1.5) api.vertex(x, y0 + amp * Math.sin((x / api.W) * freq * TAU)); api.endPath(); } for (let i = 0; i <= L; i++) { const x0 = m + (i * (api.W - 2 * m)) / L; api.beginPath(); for (let y = m; y <= api.H - m; y += 1.5) api.vertex(x0 + amp * Math.sin((y / api.H) * freq * TAU), y); api.endPath(); } },
  },
  {
    type: "truchet", label: "Truchet maze", hint: "Random arc tiles that weave into a maze.",
    params: [{ key: "cells", label: "Cells", min: 3, max: 16, step: 1 }, { key: "variation", label: "Variation", min: 1, max: 40, step: 1 }],
    defaults: { cells: 9, variation: 3 },
    draw: (api, p) => { const c = n(p, "cells"); api.randomSeed(n(p, "variation")); const cell = api.W / c, r = cell / 2; for (let gy = 0; gy < c; gy++) for (let gx = 0; gx < c; gx++) { const x = gx * cell, y = gy * cell; if (api.random() < 0.5) { api.arc(x, y, r, 0, Math.PI / 2); api.arc(x + cell, y + cell, r, Math.PI, Math.PI * 1.5); } else { api.arc(x + cell, y, r, Math.PI / 2, Math.PI); api.arc(x, y + cell, r, -Math.PI / 2, 0); } } },
  },
  {
    type: "flowField", label: "Flow field", hint: "Noise-steered streamlines - draw the wind.",
    params: [{ key: "lines", label: "Lines", min: 20, max: 180, step: 5 }, { key: "steps", label: "Length", min: 10, max: 80, step: 5 }, { key: "scale", label: "Swirl", min: 1, max: 10, step: 0.5 }, { key: "variation", label: "Variation", min: 1, max: 40, step: 1 }],
    defaults: { lines: 110, steps: 55, scale: 4, variation: 7 },
    draw: (api, p) => { const L = n(p, "lines"), steps = n(p, "steps"), scl = n(p, "scale"), m = 2; api.noiseSeed(n(p, "variation")); api.randomSeed(n(p, "variation")); for (let i = 0; i < L; i++) { let x = api.random(api.W), y = api.random(api.H); api.beginPath(); api.vertex(x, y); for (let s = 0; s < steps; s++) { const a = api.noise(x * scl * 0.008, y * scl * 0.008) * TAU * 2; x += Math.cos(a) * 1.5; y += Math.sin(a) * 1.5; if (x < m || x > api.W - m || y < m || y > api.H - m) break; api.vertex(x, y); } api.endPath(); } },
  },
  {
    type: "phyllotaxis", label: "Sunflower", hint: "Seeds spiralling at the golden angle.",
    params: [{ key: "count", label: "Seeds", min: 20, max: 160, step: 5 }, { key: "spread", label: "Spread", min: 1.5, max: 4.5, step: 0.1 }, { key: "dot", label: "Seed size", min: 0.5, max: 3, step: 0.1 }],
    defaults: { count: 120, spread: 3.4, dot: 1.4 },
    draw: (api, p, cx, cy) => { const count = n(p, "count"), spread = n(p, "spread"), dot = n(p, "dot"), ga = Math.PI * (3 - Math.sqrt(5)); for (let i = 0; i < count; i++) { const r = spread * Math.sqrt(i); const a = i * ga; const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r; if (x > 2 && x < api.W - 2 && y > 2 && y < api.H - 2) api.circle(x, y, dot, 10); } },
  },
  {
    type: "superformula", label: "Superformula", hint: "One formula that morphs into flowers, stars, and blobs.",
    params: [{ key: "m", label: "Symmetry", min: 1, max: 20, step: 1 }, { key: "n1", label: "Sharpness", min: 1, max: 40, step: 1 }, { key: "n2", label: "Bulge A", min: 1, max: 40, step: 1 }, { key: "n3", label: "Bulge B", min: 1, max: 40, step: 1 }],
    defaults: { m: 6, n1: 1, n2: 1, n3: 1 },
    draw: (api, p, cx, cy) => { const m = n(p, "m"), n1 = Math.max(0.1, n(p, "n1")), n2 = n(p, "n2"), n3 = n(p, "n3"); const sf = (th: number) => { const t = (m * th) / 4; return Math.pow(Math.pow(Math.abs(Math.cos(t)), n2) + Math.pow(Math.abs(Math.sin(t)), n3), -1 / n1); }; let mx = 0; for (let th = 0; th < TAU; th += 0.05) { const v = sf(th); if (isFinite(v) && v > mx) mx = v; } const sc = 44 / (mx || 1); api.beginPath(); for (let th = 0; th <= TAU + 0.01; th += 0.01) { const r = sf(th) * sc; if (isFinite(r)) api.vertex(cx + Math.cos(th) * r, cy + Math.sin(th) * r); } api.endPath(true); },
  },
  {
    type: "maurerRose", label: "Maurer rose", hint: "A rose sampled in straight lines - a woven web bloom.",
    params: [{ key: "petals", label: "Petals", min: 2, max: 12, step: 1 }, { key: "degree", label: "Walk angle", min: 2, max: 179, step: 1 }],
    defaults: { petals: 6, degree: 71 },
    draw: (api, p, cx, cy) => { const nn = n(p, "petals"), d = n(p, "degree"), R = 44; api.beginPath(); for (let i = 0; i <= 360; i++) { const k = (i * d * Math.PI) / 180; const r = R * Math.sin(nn * k); api.vertex(cx + Math.cos(k) * r, cy + Math.sin(k) * r); } api.endPath(); },
  },
  {
    type: "timesTable", label: "Times table", hint: "Chords on a circle from modular multiplication - cardioids.",
    params: [{ key: "points", label: "Points", min: 20, max: 200, step: 2 }, { key: "mult", label: "Multiplier", min: 2, max: 99, step: 1 }],
    defaults: { points: 120, mult: 2 },
    draw: (api, p, cx, cy) => { const pts = n(p, "points"), mult = n(p, "mult"), R = 46; const at = (i: number): [number, number] => { const a = (i / pts) * TAU - Math.PI / 2; return [cx + Math.cos(a) * R, cy + Math.sin(a) * R]; }; for (let i = 0; i < pts; i++) { const A = at(i), B = at((i * mult) % pts); api.line(A[0], A[1], B[0], B[1]); } },
  },
  {
    type: "rosette", label: "Rosette", hint: "Overlapping circles in a ring - the flower of life.",
    params: [{ key: "count", label: "Petals", min: 3, max: 18, step: 1 }, { key: "radius", label: "Circle size", min: 6, max: 30, step: 1 }, { key: "offset", label: "Spread", min: 4, max: 32, step: 1 }, { key: "center", label: "Center circle", min: 0, max: 1, step: 1 }],
    defaults: { count: 6, radius: 18, offset: 18, center: 1 },
    draw: (api, p, cx, cy) => { const count = n(p, "count"), R = n(p, "radius"), off = n(p, "offset"); if (n(p, "center") >= 1) api.circle(cx, cy, R); for (let i = 0; i < count; i++) { const a = (i / count) * TAU; api.circle(cx + Math.cos(a) * off, cy + Math.sin(a) * off, R); } },
  },
  {
    type: "hilbert", label: "Hilbert curve", hint: "A space-filling maze drawn as one unbroken line.",
    params: [{ key: "order", label: "Order", min: 1, max: 6, step: 1 }],
    defaults: { order: 5 },
    draw: (api, p, cx, cy) => { const order = Math.min(6, n(p, "order")); const pts: [number, number][] = []; const hil = (x: number, y: number, xi: number, xj: number, yi: number, yj: number, d: number) => { if (d <= 0) { pts.push([x + (xi + yi) / 2, y + (xj + yj) / 2]); } else { hil(x, y, yi / 2, yj / 2, xi / 2, xj / 2, d - 1); hil(x + xi / 2, y + xj / 2, xi / 2, xj / 2, yi / 2, yj / 2, d - 1); hil(x + xi / 2 + yi / 2, y + xj / 2 + yj / 2, xi / 2, xj / 2, yi / 2, yj / 2, d - 1); hil(x + xi / 2 + yi, y + xj / 2 + yj, -yi / 2, -yj / 2, -xi / 2, -xj / 2, d - 1); } }; const S = 92; hil(cx - S / 2, cy - S / 2, S, 0, 0, S, order); api.beginPath(); for (const [x, y] of pts) api.vertex(x, y); api.endPath(); },
  },
  {
    type: "koch", label: "Koch snowflake", hint: "A fractal snowflake edge, endlessly crinkled.",
    params: [{ key: "sides", label: "Sides", min: 3, max: 8, step: 1 }, { key: "depth", label: "Depth", min: 1, max: 4, step: 1 }],
    defaults: { sides: 3, depth: 3 },
    draw: (api, p, cx, cy) => { const sides = n(p, "sides"), depth = Math.min(4, n(p, "depth")), R = 44; let poly: [number, number][] = []; for (let i = 0; i <= sides; i++) { const a = (i / sides) * TAU - Math.PI / 2; poly.push([cx + Math.cos(a) * R, cy + Math.sin(a) * R]); } for (let d = 0; d < depth; d++) { const np: [number, number][] = []; for (let i = 0; i < poly.length - 1; i++) { const [ax, ay] = poly[i], [bx, by] = poly[i + 1]; const dx = (bx - ax) / 3, dy = (by - ay) / 3; const p1: [number, number] = [ax + dx, ay + dy], p2: [number, number] = [ax + 2 * dx, ay + 2 * dy]; const ang = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) - Math.PI / 3, len = Math.hypot(dx, dy); np.push([ax, ay], p1, [p1[0] + Math.cos(ang) * len, p1[1] + Math.sin(ang) * len], p2); } np.push(poly[poly.length - 1]); poly = np; } api.beginPath(); for (const [x, y] of poly) api.vertex(x, y); api.endPath(); },
  },
  {
    type: "sierpinski", label: "Sierpinski", hint: "The classic recursive triangle gasket.",
    params: [{ key: "depth", label: "Depth", min: 0, max: 6, step: 1 }],
    defaults: { depth: 4 },
    draw: (api, p, cx, cy) => { const depth = Math.min(6, n(p, "depth")), R = 46; const A: [number, number] = [cx, cy - R], B: [number, number] = [cx - R * 0.87, cy + R * 0.5], C: [number, number] = [cx + R * 0.87, cy + R * 0.5]; const mid = (P: [number, number], Q: [number, number]): [number, number] => [(P[0] + Q[0]) / 2, (P[1] + Q[1]) / 2]; const tri = (a: [number, number], b: [number, number], c: [number, number], d: number) => { if (d <= 0) { api.polyline([a, b, c, a]); } else { tri(a, mid(a, b), mid(a, c), d - 1); tri(mid(a, b), b, mid(b, c), d - 1); tri(mid(a, c), mid(b, c), c, d - 1); } }; tri(A, B, C, depth); },
  },
  {
    type: "tree", label: "Fractal tree", hint: "A branching tree that splits again and again.",
    params: [{ key: "depth", label: "Depth", min: 3, max: 10, step: 1 }, { key: "angle", label: "Branch angle", min: 10, max: 45, step: 1 }, { key: "ratio", label: "Shrink", min: 0.5, max: 0.8, step: 0.02 }],
    defaults: { depth: 8, angle: 25, ratio: 0.72 },
    draw: (api, p, cx, cy) => { const depth = Math.min(10, n(p, "depth")), ang = (n(p, "angle") * Math.PI) / 180, ratio = n(p, "ratio"); const branch = (x: number, y: number, len: number, dir: number, d: number) => { if (d <= 0 || len < 0.5) return; const x2 = x + Math.cos(dir) * len, y2 = y + Math.sin(dir) * len; api.line(x, y, x2, y2); branch(x2, y2, len * ratio, dir - ang, d - 1); branch(x2, y2, len * ratio, dir + ang, d - 1); }; branch(cx, cy + 44, 28, -Math.PI / 2, depth); },
  },
  {
    type: "dragon", label: "Dragon curve", hint: "The paper-folding fractal - a self-tiling dragon.",
    params: [{ key: "iter", label: "Folds", min: 6, max: 13, step: 1 }],
    defaults: { iter: 11 },
    draw: (api, p, cx, cy) => { const iter = Math.min(13, n(p, "iter")); let seq: number[] = [1]; for (let i = 0; i < iter; i++) seq = [...seq, 1, ...seq.slice().reverse().map((t) => -t)]; let x = 0, y = 0, dir = 0; const step = 3; const pts: [number, number][] = [[0, 0]]; const walk = (turn: number | null) => { x += Math.cos(dir) * step; y += Math.sin(dir) * step; pts.push([x, y]); if (turn !== null) dir += (turn * Math.PI) / 2; }; for (const t of seq) walk(t); walk(null); let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity; for (const [px, py] of pts) { mnx = Math.min(mnx, px); mxx = Math.max(mxx, px); mny = Math.min(mny, py); mxy = Math.max(mxy, py); } const s = 88 / Math.max(mxx - mnx, mxy - mny, 1); const oxc = (mnx + mxx) / 2, oyc = (mny + mxy) / 2; api.beginPath(); for (const [px, py] of pts) api.vertex(cx + (px - oxc) * s, cy + (py - oyc) * s); api.endPath(); },
  },
  {
    type: "contours", label: "Topographic", hint: "Iso-contours of a noise field - a topo map.",
    params: [{ key: "detail", label: "Detail", min: 10, max: 44, step: 2 }, { key: "levels", label: "Levels", min: 2, max: 14, step: 1 }, { key: "scale", label: "Terrain", min: 1, max: 8, step: 0.5 }, { key: "variation", label: "Variation", min: 1, max: 40, step: 1 }],
    defaults: { detail: 28, levels: 8, scale: 3, variation: 5 },
    draw: (api, p) => { const res = n(p, "detail"), levels = n(p, "levels"), scl = n(p, "scale"); api.noiseSeed(n(p, "variation")); const cell = api.W / res; const F = (i: number, j: number) => api.noise(i * scl * 0.03, j * scl * 0.03); for (let L = 1; L <= levels; L++) { const th = L / (levels + 1); for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) { const fx = i * cell, fy = j * cell; const a = F(i, j), b = F(i + 1, j), c = F(i + 1, j + 1), d = F(i, j + 1); const lp = (v1: number, v2: number) => (th - v1) / ((v2 - v1) || 1e-9); const T: [number, number] | null = (a > th) !== (b > th) ? [fx + cell * lp(a, b), fy] : null; const Rt: [number, number] | null = (b > th) !== (c > th) ? [fx + cell, fy + cell * lp(b, c)] : null; const Bt: [number, number] | null = (d > th) !== (c > th) ? [fx + cell * lp(d, c), fy + cell] : null; const Lf: [number, number] | null = (a > th) !== (d > th) ? [fx, fy + cell * lp(a, d)] : null; const cr = [T, Rt, Bt, Lf].filter(Boolean) as [number, number][]; if (cr.length === 2) api.line(cr[0][0], cr[0][1], cr[1][0], cr[1][1]); else if (cr.length === 4 && T && Rt && Bt && Lf) { api.line(T[0], T[1], Rt[0], Rt[1]); api.line(Bt[0], Bt[1], Lf[0], Lf[1]); } } } },
  },
  {
    type: "circlePack", label: "Circle packing", hint: "Circles of every size packed to fill the space.",
    params: [{ key: "count", label: "Circles", min: 10, max: 160, step: 5 }, { key: "minR", label: "Smallest", min: 1, max: 6, step: 0.5 }, { key: "maxR", label: "Largest", min: 4, max: 18, step: 1 }, { key: "variation", label: "Variation", min: 1, max: 40, step: 1 }],
    defaults: { count: 90, minR: 1.5, maxR: 12, variation: 4 },
    draw: (api, p, cx, cy) => { void cx; void cy; api.randomSeed(n(p, "variation")); const count = n(p, "count"), minR = n(p, "minR"), maxR = n(p, "maxR"); const placed: [number, number, number][] = []; let attempts = 0; while (placed.length < count && attempts < count * 40) { attempts++; const x = api.random(6, api.W - 6), y = api.random(6, api.H - 6); let r = maxR; for (const c of placed) { const d = Math.hypot(x - c[0], y - c[1]) - c[2]; if (d < r) r = d; } r = Math.min(r - 0.5, maxR); if (r >= minR) { placed.push([x, y, r]); api.circle(x, y, r); } } },
  },
  {
    type: "moire", label: "Moiré", hint: "Two line grids at a slight angle - shimmering interference.",
    params: [{ key: "lines", label: "Lines", min: 10, max: 60, step: 1 }, { key: "angle", label: "Angle", min: 1, max: 30, step: 1 }],
    defaults: { lines: 36, angle: 8 },
    draw: (api, p, cx, cy) => { const lines = n(p, "lines"), ang = (n(p, "angle") * Math.PI) / 180; const set = (rot: number) => { const dx = Math.cos(rot), dy = Math.sin(rot), nx = -dy, ny = dx; for (let i = 0; i <= lines; i++) { const t = (i / lines - 0.5) * 92; const ox = cx + nx * t, oy = cy + ny * t; api.line(ox - dx * 46, oy - dy * 46, ox + dx * 46, oy + dy * 46); } }; set(0); set(ang); },
  },
  {
    type: "honeycomb", label: "Honeycomb", hint: "A tessellating grid of hexagons.",
    params: [{ key: "size", label: "Cell size", min: 4, max: 16, step: 1 }],
    defaults: { size: 8 },
    draw: (api, p) => { const s = n(p, "size"), dx = s * 1.5, dy = s * Math.sqrt(3); let col = 0; for (let x = s; x < api.W + s; x += dx) { const yoff = col % 2 ? dy / 2 : 0; for (let y = s + yoff; y < api.H + s; y += dy) { const hex: [number, number][] = []; for (let k = 0; k <= 6; k++) { const a = (k * Math.PI) / 3; hex.push([x + Math.cos(a) * s, y + Math.sin(a) * s]); } api.polyline(hex); } col++; } },
  },
  {
    type: "ripples", label: "Ripples", hint: "Rings from several centers, overlapping like rain on water.",
    params: [{ key: "centers", label: "Sources", min: 2, max: 8, step: 1 }, { key: "rings", label: "Rings each", min: 3, max: 14, step: 1 }, { key: "spacing", label: "Spacing", min: 2, max: 8, step: 0.5 }, { key: "variation", label: "Variation", min: 1, max: 40, step: 1 }],
    defaults: { centers: 3, rings: 8, spacing: 4, variation: 6 },
    draw: (api, p) => { api.randomSeed(n(p, "variation")); const centers = n(p, "centers"), rings = n(p, "rings"), sp = n(p, "spacing"); for (let c = 0; c < centers; c++) { const x = api.random(15, api.W - 15), y = api.random(15, api.H - 15); for (let k = 1; k <= rings; k++) api.circle(x, y, k * sp); } },
  },
  {
    type: "harmonograph", label: "Harmonograph", hint: "Two damped pendulums - Lissajous that spirals inward.",
    params: [{ key: "freqX", label: "X frequency", min: 1, max: 8, step: 0.5 }, { key: "freqY", label: "Y frequency", min: 1, max: 8, step: 0.5 }, { key: "phase", label: "Phase", min: 0, max: 180, step: 5 }, { key: "damping", label: "Damping", min: 0, max: 0.05, step: 0.005 }],
    defaults: { freqX: 3, freqY: 2, phase: 90, damping: 0.01 },
    draw: (api, p, cx, cy) => { const f1 = n(p, "freqX"), f2 = n(p, "freqY"), ph = (n(p, "phase") * Math.PI) / 180, damp = n(p, "damping"), A = 44; api.beginPath(); for (let t = 0; t <= TAU * 8; t += 0.02) { const dec = Math.exp(-damp * t); api.vertex(cx + A * dec * Math.sin(f1 * t + ph), cy + A * dec * Math.sin(f2 * t)); } api.endPath(); },
  },
  {
    type: "butterfly", label: "Butterfly", hint: "Fay's butterfly curve - an organic, winged loop.",
    params: [{ key: "size", label: "Size", min: 20, max: 48, step: 1 }],
    defaults: { size: 42 },
    draw: (api, p, cx, cy) => { const S = n(p, "size") / 5; api.beginPath(); for (let t = 0; t <= TAU * 6 + 0.01; t += 0.01) { const e = Math.exp(Math.cos(t)) - 2 * Math.cos(4 * t) - Math.pow(Math.sin(t / 12), 5); api.vertex(cx + Math.sin(t) * e * S, cy - Math.cos(t) * e * S); } api.endPath(); },
  },
];

export const BLOCK_BY_TYPE: Record<string, BlockDef> = Object.fromEntries(BLOCK_DEFS.map((d) => [d.type, d]));

export type Block = { id: string; type: string; params: Record<string, number | string> };

/** Run a block program. Blocks draw in order; center is the canvas middle. */
export function runBlocks(blocks: Block[], opts: { seed?: number; defaultHex?: string; maxPoints?: number }): SketchResult {
  const { api, collect } = createSketchContext(opts);
  let error: string | null = null;
  try {
    for (const b of blocks) {
      const def = BLOCK_BY_TYPE[b.type];
      if (def) def.draw(api as unknown as SketchAPI, b.params, CANVAS / 2, CANVAS / 2);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "Block error.";
  }
  return { ...collect(), error };
}

// ─── Example sketches ────────────────────────────────────────────────────

const EXAMPLES: { name: string; code: string }[] = [
  {
    name: "Spiral rose",
    code: `// A rose curve traced as one continuous line
const cx = W/2, cy = H/2;
beginPath();
for (let a = 0; a < TAU * 6; a += 0.03) {
  const r = 42 * sin(2.5 * a);
  vertex(cx + cos(a) * r, cy + sin(a) * r);
}
endPath();`,
  },
  {
    name: "Lissajous",
    code: `// Parametric Lissajous figure
const cx = W/2, cy = H/2;
beginPath();
for (let t = 0; t < TAU; t += 0.006) {
  vertex(cx + 44*sin(3*t + PI/2), cy + 44*sin(4*t));
}
endPath(true);`,
  },
  {
    name: "Concentric grid",
    code: `// A grid of circles, each a bit rotated - moiré depth
stroke("#0b1f3a");
for (let gy = 0; gy < 5; gy++)
  for (let gx = 0; gx < 5; gx++) {
    const cx = 12 + gx*19, cy = 12 + gy*19;
    for (let k = 1; k <= 4; k++) circle(cx, cy, k*2.1);
  }`,
  },
  {
    name: "Flow field",
    code: `// Noise-steered streamlines - draw the wind
noiseSeed(7);
for (let i = 0; i < 130; i++) {
  let x = random(W), y = random(H);
  beginPath(); vertex(x, y);
  for (let s = 0; s < 60; s++) {
    const a = noise(x*0.04, y*0.04) * TAU * 2;
    x += cos(a) * 1.4; y += sin(a) * 1.4;
    if (x<0||x>W||y<0||y>H) break;
    vertex(x, y);
  }
  endPath();
}`,
  },
  {
    name: "Starburst",
    code: `// Radiating chords across a ring - string-art look
const cx = W/2, cy = H/2, n = 72, r = 46;
for (let i = 0; i < n; i++) {
  const a1 = (i/n)*TAU, a2 = ((i*31)%n/n)*TAU;
  line(cx+cos(a1)*r, cy+sin(a1)*r, cx+cos(a2)*r, cy+sin(a2)*r);
}`,
  },
  {
    name: "Wave stack",
    code: `// Stacked noise waves - topographic ribbons
noiseSeed(3);
for (let row = 0; row < 22; row++) {
  const y0 = 8 + row*3.8;
  beginPath();
  for (let x = 6; x <= W-6; x += 1.5) {
    vertex(x, y0 + noise(x*0.05, row*0.35)*10 - 5);
  }
  endPath();
}`,
  },
];

const DEFAULT_THREAD = THREADS.find((t) => t.code === "1568")?.hex ?? "#0b1f3a";

export default function SketchTool() {
  const units = useUnits();
  const [code, setCode] = useState(EXAMPLES[0].code);
  const [seed, setSeed] = useState(1);
  const [sizeMm, setSizeMm] = useState(120);
  const [stitchLen, setStitchLen] = useState(2.2);
  const [bean, setBean] = useState<1 | 3>(1);
  const [threadHex, setThreadHex] = useState(DEFAULT_THREAD);

  const debouncedCode = useDebounced(code, 350);

  const result = useMemo(
    () => runSketch(debouncedCode, { seed, defaultHex: threadHex }),
    [debouncedCode, seed, threadHex],
  );

  const built = useMemo(() => {
    if (result.groups.length === 0) return null;
    // Scale the whole sketch to fit the requested hoop size, keep proportions.
    const all = result.groups.flat();
    const fitted = fitPaths(all, sizeMm);
    // fitPaths returns paths in the same order; re-split back into groups.
    const scaledGroups: PathMm[][] = [];
    let idx = 0;
    for (const g of result.groups) {
      scaledGroups.push(fitted.slice(idx, idx + g.length).map((p) => resamplePath(p, stitchLen, 0.4)));
      idx += g.length;
    }
    return buildDesign(pathGroupsToStitches(scaledGroups, bean), "bayside-sketch");
  }, [result, sizeMm, stitchLen, bean]);

  const previewColors = result.colors.length ? result.colors : [threadHex];

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="sketch">
            <div className="flex items-center justify-between gap-2">
              <span className={LABEL}>Code - draws in a 100×100 space</span>
              <select
                onChange={(e) => { const ex = EXAMPLES[Number(e.target.value)]; if (ex) setCode(ex.code); }}
                value=""
                className="text-[0.75rem] border border-hairline bg-bg text-fg px-1.5 py-1"
              >
                <option value="" disabled>examples…</option>
                {EXAMPLES.map((ex, i) => <option key={ex.name} value={i}>{ex.name}</option>)}
              </select>
            </div>
            <textarea
              value={code}
              onChange={(e) => setCode(e.target.value)}
              spellCheck={false}
              rows={16}
              className="mt-1.5 w-full border border-hairline bg-bg text-fg rounded-none px-2.5 py-2 text-[0.75rem] font-mono leading-snug resize-y"
            />
            {result.error ? (
              <Warning>{result.error}</Warning>
            ) : (
              <p className="text-[0.6875rem] text-mid tabular-nums">
                {result.strokeCount} stroke{result.strokeCount === 1 ? "" : "s"} · {result.pointCount.toLocaleString()} points · {result.colors.length} color{result.colors.length === 1 ? "" : "s"}
              </p>
            )}
          </SectionBox>

          <SectionBox eyebrow="api">
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              <span className="text-fg">Draw:</span> line, circle, ellipse, arc, rect, polygon, polyline, and beginPath / vertex / endPath. <span className="text-fg">Color:</span> stroke("#rrggbb") starts a new thread. <span className="text-fg">Math:</span> sin cos PI TAU map lerp dist clamp. <span className="text-fg">Random:</span> random(), noise(x,y), randomSeed, noiseSeed. Canvas is W×H (100×100), y-down.
            </p>
          </SectionBox>

          <SectionBox eyebrow="stitch">
            <RangeRow label="Seed" value={seed} min={1} max={99} step={1} onChange={setSeed} />
            <RangeRow label="Size" value={sizeMm} min={40} max={300} step={5} onChange={setSizeMm} fmt={(v) => fmtLen(v, units)} />
            <RangeRow label="Stitch length" value={stitchLen} min={1.5} max={4} step={0.1} onChange={setStitchLen} fmt={(v) => `${v.toFixed(1)} mm`} />
            <div>
              <div className={`${LABEL} mb-1.5`}>Line weight</div>
              <ModeButtons small options={[["1", "Run"], ["3", "Bean ×3"]] as const} value={String(bean)} onChange={(v) => setBean(Number(v) as 1 | 3)} />
            </div>
            {result.colors.length <= 1 && <ThreadRow hex={threadHex} onChange={setThreadHex} />}
            {result.colors.length > 1 && (
              <p className="text-[0.6875rem] text-mid leading-relaxed">This sketch sets its own colors with stroke(). {result.colors.length} threads, sewn in the order they first appear.</p>
            )}
          </SectionBox>
        </>
      }
      preview={
        <PreviewRail built={built} colors={previewColors} name="bayside-sketch" emptyHint="Write a sketch - every line becomes stitches.">
          {built && (
            <p className="text-[0.6875rem] text-mid tabular-nums">
              creative-coded · {result.strokeCount} strokes → {built.stats.realStitches.toLocaleString()} stitches
            </p>
          )}
        </PreviewRail>
      }
    />
  );
}
