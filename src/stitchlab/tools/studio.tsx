// Digitizing Studio - a proper manual digitizer: click to place nodes, build
// objects, apply a stitch type to each (running stitch, satin column, or tatami
// fill), edit the nodes, and it generates a real DST. This is the classic
// object-based digitizing workflow (create a shape → assign a stitch → tune
// parameters), browser-native and honest: the stitches you see under your
// editable nodes are rendered from the actual parsed DST bytes.
//
// The pure object→stitch logic is exported and Node-tested; all canvas and
// pointer interaction lives in the React layer.

import { useEffect, useMemo, useRef, useState } from "react";
import AnimExport from "./animexport";
import { THREADS } from "../../data/threads";
import type { PathMm } from "../lib/generators";
import { beanify, pathGroupsToStitches, resamplePath } from "../lib/generators";
import { satinAlongPath } from "./satin";
import { tatamiFill, type Ring } from "./tatami";
import { fitTransform, renderPattern } from "../lib/render";
import { saveDesign } from "../lib/library";
import { nearestThreads } from "../lib/threadMatch";
import {
  buildDesign,
  ExportButton,
  FabricSelect,
  type FabricId,
  formatMinutes,
  ModeButtons,
  RangeRow,
  SectionBox,
  ThreadSelect,
  Warning,
  fmtLen, useUnits, fmtSize,
} from "./shared";

// ─── Object model ────────────────────────────────────────────────────────

export type StitchType = "run" | "satin" | "fill";

export type DigitObject = {
  id: string;
  type: StitchType;
  nodes: { x: number; y: number }[]; // mm, y-down
  hex: string;
  code: string;
  name: string;
  // parameters (used per type)
  stitchLenMm: number; // run
  bean: 1 | 3; // run weight
  widthMm: number; // satin column width
  densityMm: number; // satin/fill spacing
  angleDeg: number; // fill angle
  underlay: boolean; // satin/fill
  outline: boolean; // fill: add a run outline
  smooth: boolean; // interpolate a Catmull-Rom curve through the nodes
};

/** Catmull-Rom spline through the control nodes → dense polyline. Pure. */
export function catmullRom(pts: { x: number; y: number }[], closed: boolean, samplesPerSeg = 12): PathMm {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const get = (i: number) => (closed ? pts[((i % n) + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  const out: PathMm = [];
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);
    for (let s = 0; s < samplesPerSeg; s++) {
      const t = s / samplesPerSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(closed ? out[0] : pts[n - 1]);
  return out;
}

export function defaultObject(type: StitchType, cone: { hex: string; code: string; name: string }): Omit<DigitObject, "id" | "nodes"> {
  return {
    type,
    hex: cone.hex,
    code: cone.code,
    name: cone.name,
    stitchLenMm: 2.5,
    bean: type === "run" ? 3 : 1,
    widthMm: 4,
    densityMm: type === "satin" ? 0.4 : 0.45,
    angleDeg: 45,
    underlay: true,
    outline: true,
    smooth: false,
  };
}

/** One object → its stitch paths (already at final weight). Pure. */
export function objectStrokes(o: DigitObject): PathMm[] {
  if (o.type === "run") {
    if (o.nodes.length < 2) return [];
    const path = resamplePath(o.smooth ? catmullRom(o.nodes, false) : o.nodes, o.stitchLenMm, 0.4);
    return [o.bean === 3 ? beanify(path, 3) : path];
  }
  if (o.type === "satin") {
    if (o.nodes.length < 2) return [];
    const center = o.smooth ? catmullRom(o.nodes, false) : o.nodes;
    const r = satinAlongPath(center, {
      widthMm: o.widthMm,
      densityMm: o.densityMm,
      underlayCenter: o.underlay,
      underlayEdge: o.underlay && o.widthMm >= 3.5,
    });
    return [...r.underlay, r.satin];
  }
  // fill (closed polygon)
  if (o.nodes.length < 3) return [];
  const ring: Ring = o.smooth ? catmullRom(o.nodes, true) : o.nodes;
  const fill = tatamiFill([ring], {
    angleDeg: o.angleDeg,
    rowSpacingMm: o.densityMm,
    stitchLenMm: 3,
    travel: "boundary",
  });
  const out = [...fill];
  if (o.outline) out.push(resamplePath([...ring, ring[0]], 2.5, 0.4));
  return out;
}

/** All objects → color groups (one per cone, first-appearance order). Pure. */
export function objectsToGroups(objects: DigitObject[]): { groups: PathMm[][]; hexes: string[] } {
  const byCone = new Map<string, { hex: string; strokes: PathMm[] }>();
  const order: string[] = [];
  for (const o of objects) {
    const strokes = objectStrokes(o);
    if (strokes.length === 0) continue;
    let g = byCone.get(o.code);
    if (!g) {
      g = { hex: o.hex, strokes: [] };
      byCone.set(o.code, g);
      order.push(o.code);
    }
    g.strokes.push(...strokes);
  }
  return {
    groups: order.map((c) => byCone.get(c)!.strokes),
    hexes: order.map((c) => byCone.get(c)!.hex),
  };
}

// ─── Auto-trace wand (region → editable fill nodes) ──────────────────────
// Fuses the auto-digitizer's organs into the manual tool: flood a connected
// same-color region of the reference image, trace its boundary, simplify to a
// handful of editable nodes, and hand it back as a Fill object the user refines.

/** Flood-fill the connected region within colorTol of the seed pixel. Pure. */
export function floodRegion(rgb: Uint8ClampedArray, w: number, h: number, sx: number, sy: number, colorTol: number): Uint8Array {
  const mask = new Uint8Array(w * h);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;
  const s = (sy * w + sx) * 4;
  const sr = rgb[s];
  const sg = rgb[s + 1];
  const sb = rgb[s + 2];
  const tol2 = colorTol * colorTol;
  const stack = [sy * w + sx];
  while (stack.length) {
    const i = stack.pop()!;
    if (mask[i]) continue;
    const p = i * 4;
    const dr = rgb[p] - sr;
    const dg = rgb[p + 1] - sg;
    const db = rgb[p + 2] - sb;
    if (dr * dr + dg * dg + db * db > tol2) continue;
    mask[i] = 1;
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  return mask;
}

/** Marching-squares → the longest closed contour of a mask (px coords). Pure. */
export function traceLargestContour(mask: Uint8Array, w: number, h: number): { x: number; y: number }[] {
  const segs: [{ x: number; y: number }, { x: number; y: number }][] = [];
  const v = (x: number, y: number) => (x >= 0 && x < w && y >= 0 && y < h ? mask[y * w + x] : 0);
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const tl = v(x, y);
      const tr = v(x + 1, y);
      const br = v(x + 1, y + 1);
      const bl = v(x, y + 1);
      const code = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const T = { x: x + 1, y: y + 0.5 };
      const R = { x: x + 1.5, y: y + 1 };
      const B = { x: x + 1, y: y + 1.5 };
      const L = { x: x + 0.5, y: y + 1 };
      const add = (a: { x: number; y: number }, b: { x: number; y: number }) => segs.push([a, b]);
      switch (code) {
        case 1: add(L, B); break; case 2: add(B, R); break; case 3: add(L, R); break;
        case 4: add(T, R); break; case 5: add(L, T); add(B, R); break; case 6: add(T, B); break;
        case 7: add(L, T); break; case 8: add(T, L); break; case 9: add(T, B); break;
        case 10: add(T, R); add(B, L); break; case 11: add(T, R); break; case 12: add(R, L); break;
        case 13: add(R, B); break; case 14: add(B, L); break;
      }
    }
  }
  const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) < 0.01;
  const pool = segs.slice();
  let best: { x: number; y: number }[] = [];
  while (pool.length) {
    let cur = pool.pop()!.slice();
    let ext = true;
    while (ext) {
      ext = false;
      const tail = cur[cur.length - 1];
      for (let i = 0; i < pool.length; i++) {
        if (near(tail, pool[i][0])) { cur.push(pool[i][1]); pool.splice(i, 1); ext = true; break; }
        if (near(tail, pool[i][1])) { cur.push(pool[i][0]); pool.splice(i, 1); ext = true; break; }
      }
    }
    if (cur.length > best.length) best = cur;
  }
  return best;
}

/** Douglas–Peucker simplification. Pure. */
export function simplifyDP(points: { x: number; y: number }[], epsilon: number): { x: number; y: number }[] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  const last = points.length - 1;
  keep[0] = 1;
  keep[last] = 1;
  const stack: [number, number][] = [];
  // Closed loop (first ≈ last): the base chord is degenerate, so seed a second
  // anchor at the point farthest from the start and split the ring in two.
  const closed = Math.hypot(points[0].x - points[last].x, points[0].y - points[last].y) < 1e-6;
  if (closed && points.length > 3) {
    let far = 1;
    let fd = -1;
    for (let i = 1; i < last; i++) {
      const d = Math.hypot(points[i].x - points[0].x, points[i].y - points[0].y);
      if (d > fd) { fd = d; far = i; }
    }
    keep[far] = 1;
    stack.push([0, far], [far, last]);
  } else {
    stack.push([0, last]);
  }
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    const A = points[a];
    const B = points[b];
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const len = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((points[i].x - A.x) * dy - (points[i].y - A.y) * dx) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > epsilon && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Wand: seed pixel → simplified region boundary (px) + mean color. Pure. */
export function wandTrace(
  rgb: Uint8ClampedArray,
  w: number,
  h: number,
  sx: number,
  sy: number,
  colorTol: number,
  maxNodes = 28,
): { nodes: { x: number; y: number }[]; rgb: [number, number, number] } | null {
  const mask = floodRegion(rgb, w, h, sx, sy, colorTol);
  let area = 0;
  let mr = 0;
  let mg = 0;
  let mb = 0;
  for (let i = 0; i < w * h; i++) if (mask[i]) { area++; mr += rgb[i * 4]; mg += rgb[i * 4 + 1]; mb += rgb[i * 4 + 2]; }
  if (area < 12) return null;
  const contour = traceLargestContour(mask, w, h);
  if (contour.length < 6) return null;
  // simplify: raise epsilon until node count is manageable
  let eps = 1;
  let nodes = simplifyDP(contour, eps);
  while (nodes.length > maxNodes && eps < 40) { eps *= 1.4; nodes = simplifyDP(contour, eps); }
  if (nodes.length >= 2 && Math.hypot(nodes[0].x - nodes[nodes.length - 1].x, nodes[0].y - nodes[nodes.length - 1].y) < 1.5) nodes = nodes.slice(0, -1);
  if (nodes.length < 3) return null;
  return { nodes, rgb: [mr / area, mg / area, mb / area] };
}

// ─── Component ───────────────────────────────────────────────────────────

const NAME = "bayside-studio";
const WORK_MM = 260; // base working-area width in mm (centred on origin)
const GRID_MM = 5;

let uid = 0;
const nextId = () => `o${++uid}`;

type RefImage = { canvas: HTMLCanvasElement; w: number; h: number; name: string; widthMm: number };

export default function StudioTool() {
  const units = useUnits();
  const [objects, setObjects] = useState<DigitObject[]>([]);
  const [current, setCurrent] = useState<{ type: StitchType; nodes: { x: number; y: number }[] } | null>(null);
  const [newType, setNewType] = useState<StitchType>("fill");
  const [newSmooth, setNewSmooth] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<number | null>(null);
  const [fabric, setFabric] = useState<FabricId>("canvas");
  const [snap, setSnap] = useState(false);
  const [cone, setCone] = useState(() => {
    const t = THREADS.find((x) => x.family === "Blue" && x.hex) ?? THREADS.find((x) => x.hex)!;
    return { hex: t.hex!, code: t.code, name: t.name };
  });
  const [ref, setRef] = useState<RefImage | null>(null);
  const [refOpacity, setRefOpacity] = useState(0.5);
  const [sampleMode, setSampleMode] = useState(false);
  const [wandMode, setWandMode] = useState(false);
  const [wandTol, setWandTol] = useState(38);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [zoom, setZoom] = useState(1);
  const panRef = useRef({ x: 0, y: 0 });
  const [, forceRerender] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ptr = useRef<{ mode: "idle" | "dragNode" | "pan"; nodeIdx: number; startX: number; startY: number; moved: boolean; panX: number; panY: number } | null>(null);

  // history (undo/redo) - snapshots of objects
  const undoRef = useRef<DigitObject[][]>([]);
  const redoRef = useRef<DigitObject[][]>([]);
  const commit = (next: DigitObject[]) => {
    undoRef.current.push(objects);
    if (undoRef.current.length > 60) undoRef.current.shift();
    redoRef.current = [];
    setObjects(next);
  };
  const undo = () => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    redoRef.current.push(objects);
    setObjects(prev);
    setSelectedNode(null);
  };
  const redo = () => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(objects);
    setObjects(next);
  };

  const selected = objects.find((o) => o.id === selectedId) ?? null;

  const built = useMemo(() => {
    const { groups, hexes } = objectsToGroups(objects);
    if (groups.length === 0) return { built: null, hexes: [] as string[] };
    const sampled = groups.map((g) => g.map((s) => resamplePath(s, 2.6, 0.3)));
    return { built: buildDesign(pathGroupsToStitches(sampled, 1), NAME), hexes };
  }, [objects]);

  // ── canvas transform (zoom + pan) ──
  const view = () => {
    const c = canvasRef.current;
    const w = c?.clientWidth ?? 560;
    const h = c?.clientHeight ?? 560;
    const scale = (Math.min(w, h) / WORK_MM) * zoom;
    return { scale, cx: w / 2 + panRef.current.x, cy: h / 2 + panRef.current.y, w, h };
  };
  const snapMm = (v: number) => (snap ? Math.round(v / GRID_MM) * GRID_MM : v);
  const toMm = (px: number, py: number) => {
    const { scale, cx, cy } = view();
    return { x: (px - cx) / scale, y: (py - cy) / scale };
  };
  const toPx = (x: number, y: number) => {
    const { scale, cx, cy } = view();
    return { x: cx + x * scale, y: cy + y * scale };
  };

  // ── render ──
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#f4f2ee";
    ctx.fillRect(0, 0, w, h);
    // reference image (trace-over), centred at its widthMm
    if (ref) {
      const tl = toPx(-ref.widthMm / 2, -(ref.widthMm * ref.h) / ref.w / 2);
      const br = toPx(ref.widthMm / 2, (ref.widthMm * ref.h) / ref.w / 2);
      ctx.globalAlpha = refOpacity;
      ctx.drawImage(ref.canvas, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.globalAlpha = 1;
    }
    // mm grid
    const { scale, cx, cy } = view();
    ctx.strokeStyle = "#e0ddd7";
    ctx.lineWidth = 0.5;
    const half = WORK_MM / 2;
    for (let m = -half; m <= half; m += 20) {
      const p = cx + m * scale;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, h); ctx.stroke();
      const q = cy + m * scale;
      ctx.beginPath(); ctx.moveTo(0, q); ctx.lineTo(w, q); ctx.stroke();
    }
    // DST stitches (the real file)
    if (built.built) {
      const pat = built.built.pattern;
      let bi = 0;
      let prev: { x: number; y: number } | null = null;
      let color = built.hexes[0] ?? "#1c1c1a";
      ctx.lineWidth = 1;
      ctx.lineCap = "round";
      for (const st of pat.stitches) {
        if (st.cmd === 5 || st.cmd === 3) { bi++; color = built.hexes[bi] ?? color; prev = null; continue; }
        const P = toPx(st.x / 10, st.y / 10);
        if (st.cmd === 0 && prev) { ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(P.x, P.y); ctx.stroke(); }
        if (st.cmd !== 4) prev = P;
      }
    }
    // editable overlay
    const drawObj = (nodes: { x: number; y: number }[], closed: boolean, sel: boolean, smooth: boolean) => {
      if (nodes.length === 0) return;
      const poly = smooth && nodes.length >= 3 ? catmullRom(nodes, closed) : (closed ? [...nodes, nodes[0]] : nodes);
      ctx.strokeStyle = sel ? "#082870" : "rgba(28,28,26,0.45)";
      ctx.lineWidth = sel ? 1.5 : 1;
      ctx.setLineDash(sel ? [] : [3, 3]);
      ctx.beginPath();
      poly.forEach((n, i) => { const p = toPx(n.x, n.y); i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y); });
      ctx.stroke();
      ctx.setLineDash([]);
      nodes.forEach((n, i) => {
        const p = toPx(n.x, n.y);
        const isSelNode = sel && i === selectedNode;
        ctx.fillStyle = isSelNode ? "#8a2020" : sel ? "#082870" : "#78766f";
        ctx.beginPath();
        ctx.arc(p.x, p.y, isSelNode ? 5 : sel ? 4 : 3, 0, Math.PI * 2);
        ctx.fill();
      });
    };
    for (const o of objects) drawObj(o.nodes, o.type === "fill", o.id === selectedId, o.smooth);
    if (current) drawObj(current.nodes, false, true, newSmooth);
  }, [objects, current, selectedId, selectedNode, built, ref, refOpacity, zoom, newSmooth]);

  // ── keyboard ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "SELECT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (e.key === "Enter" && current) { e.preventDefault(); finishObject(); return; }
      if (e.key === "Escape") { setCurrent(null); setSampleMode(false); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        if (selectedNode !== null) deleteNode();
        else deleteSelected();
      }
      if (e.key.toLowerCase() === "d" && selected) duplicateSelected();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ── node ops ──
  const nearestNode = (mm: { x: number; y: number }, o: DigitObject): number | null => {
    const { scale } = view();
    const rMm = 8 / scale;
    let bi = -1, bd = rMm;
    o.nodes.forEach((n, i) => { const d = Math.hypot(n.x - mm.x, n.y - mm.y); if (d < bd) { bd = d; bi = i; } });
    return bi >= 0 ? bi : null;
  };
  const segmentInsert = (mm: { x: number; y: number }, o: DigitObject): number | null => {
    const { scale } = view();
    const tolMm = 6 / scale;
    const closed = o.type === "fill";
    const nn = o.nodes;
    let best = -1, bd = tolMm;
    const m = closed ? nn.length : nn.length - 1;
    for (let i = 0; i < m; i++) {
      const a = nn[i], b = nn[(i + 1) % nn.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy || 1;
      let t = ((mm.x - a.x) * dx + (mm.y - a.y) * dy) / len2;
      t = Math.max(0.08, Math.min(0.92, t));
      const px = a.x + dx * t, py = a.y + dy * t;
      const d = Math.hypot(mm.x - px, mm.y - py);
      if (d < bd) { bd = d; best = i + 1; }
    }
    return best;
  };
  const deleteNode = () => {
    if (!selected || selectedNode === null) return;
    const min = selected.type === "fill" ? 3 : 2;
    if (selected.nodes.length <= min) return;
    commit(objects.map((o) => (o.id === selectedId ? { ...o, nodes: o.nodes.filter((_, i) => i !== selectedNode) } : o)));
    setSelectedNode(null);
  };
  const duplicateSelected = () => {
    if (!selected) return;
    const id = nextId();
    const copy: DigitObject = { ...selected, id, nodes: selected.nodes.map((n) => ({ x: n.x + 8, y: n.y + 8 })) };
    commit([...objects, copy]);
    setSelectedId(id);
    setSelectedNode(null);
  };

  // ── pointer ──
  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect();
    const rawMm = toMm(ev.clientX - rect.left, ev.clientY - rect.top);
    const mm = { x: snapMm(rawMm.x), y: snapMm(rawMm.y) };
    // eyedropper
    if (sampleMode && ref) {
      const ix = Math.round(((rawMm.x + ref.widthMm / 2) / ref.widthMm) * ref.w);
      const iy = Math.round(((rawMm.y + (ref.widthMm * ref.h) / ref.w / 2) / ((ref.widthMm * ref.h) / ref.w)) * ref.h);
      const rctx = ref.canvas.getContext("2d");
      if (rctx && ix >= 0 && ix < ref.w && iy >= 0 && iy < ref.h) {
        const d = rctx.getImageData(ix, iy, 1, 1).data;
        const t = nearestThreads("#" + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join(""), 1)[0].thread;
        if (t.hex) {
          setCone({ hex: t.hex, code: t.code, name: t.name });
          if (selected) commit(objects.map((o) => (o.id === selectedId ? { ...o, hex: t.hex!, code: t.code, name: t.name } : o)));
        }
      }
      setSampleMode(false);
      return;
    }
    // wand: trace a region of the reference into an editable fill object
    if (wandMode && ref) {
      const wImg = (ref.widthMm * ref.h) / ref.w;
      const ix = Math.round(((rawMm.x + ref.widthMm / 2) / ref.widthMm) * ref.w);
      const iy = Math.round(((rawMm.y + wImg / 2) / wImg) * ref.h);
      const rctx = ref.canvas.getContext("2d");
      if (rctx && ix >= 0 && ix < ref.w && iy >= 0 && iy < ref.h) {
        const data = rctx.getImageData(0, 0, ref.w, ref.h).data;
        const res = wandTrace(data, ref.w, ref.h, ix, iy, wandTol);
        if (res) {
          // image px → mm (reference is centred at widthMm)
          const nodes = res.nodes.map((p) => ({
            x: (p.x / ref.w) * ref.widthMm - ref.widthMm / 2,
            y: (p.y / ref.h) * wImg - wImg / 2,
          }));
          const t = nearestThreads("#" + res.rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join(""), 1)[0].thread;
          const c = t.hex ? { hex: t.hex, code: t.code, name: t.name } : cone;
          const id = nextId();
          commit([...objects, { id, nodes, ...defaultObject("fill", c) }]);
          setSelectedId(id);
          setSelectedNode(null);
        }
      }
      return;
    }
    // building
    if (current) { setCurrent({ ...current, nodes: [...current.nodes, mm] }); return; }
    // drag an existing node of the selected object
    if (selected) {
      const ni = nearestNode(rawMm, selected);
      if (ni !== null) {
        setSelectedNode(ni);
        ptr.current = { mode: "dragNode", nodeIdx: ni, startX: ev.clientX, startY: ev.clientY, moved: false, panX: 0, panY: 0 };
        undoRef.current.push(objects); // snapshot before drag
        redoRef.current = [];
        ev.currentTarget.setPointerCapture(ev.pointerId);
        return;
      }
      // insert a node on a segment of the selected object
      const seg = segmentInsert(rawMm, selected);
      if (seg !== null) {
        const nn = selected.nodes.slice();
        nn.splice(seg, 0, mm);
        commit(objects.map((o) => (o.id === selectedId ? { ...o, nodes: nn } : o)));
        setSelectedNode(seg);
        return;
      }
    }
    // else: begin pan-or-select
    ptr.current = { mode: "pan", nodeIdx: -1, startX: ev.clientX, startY: ev.clientY, moved: false, panX: panRef.current.x, panY: panRef.current.y };
    ev.currentTarget.setPointerCapture(ev.pointerId);
  };
  const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const st = ptr.current;
    if (!st) return;
    const dx = ev.clientX - st.startX;
    const dy = ev.clientY - st.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) st.moved = true;
    if (st.mode === "dragNode" && selected) {
      const rect = ev.currentTarget.getBoundingClientRect();
      const raw = toMm(ev.clientX - rect.left, ev.clientY - rect.top);
      const mm = { x: snapMm(raw.x), y: snapMm(raw.y) };
      setObjects((os) => os.map((o) => (o.id === selectedId ? { ...o, nodes: o.nodes.map((n, i) => (i === st.nodeIdx ? mm : n)) } : o)));
    } else if (st.mode === "pan") {
      panRef.current = { x: st.panX + dx, y: st.panY + dy };
      forceRerender((n) => n + 1);
    }
  };
  const onPointerUp = () => {
    const st = ptr.current;
    if (st && st.mode === "pan" && !st.moved) {
      // a click on empty space → select nearest object or deselect
      // (recompute against last pointer via a tiny trick: use current selection heuristics)
    }
    ptr.current = null;
  };
  const onPointerClick = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    if (current || sampleMode || wandMode) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const mm = toMm(ev.clientX - rect.left, ev.clientY - rect.top);
    // if we clicked a node of the currently selected object, keep it (handled in down)
    if (selected && nearestNode(mm, selected) !== null) return;
    if (selected && segmentInsert(mm, selected) !== null) return;
    // select nearest object
    let best: string | null = null, bd = Infinity;
    for (const o of objects) for (const n of o.nodes) { const d = Math.hypot(n.x - mm.x, n.y - mm.y); if (d < bd) { bd = d; best = o.id; } }
    const { scale } = view();
    if (bd < 14 / scale) { setSelectedId(best); setSelectedNode(null); } else { setSelectedId(null); setSelectedNode(null); }
  };
  const onWheel = (ev: React.WheelEvent<HTMLCanvasElement>) => {
    ev.preventDefault();
    const rect = ev.currentTarget.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const before = toMm(mx, my);
    const nz = Math.max(0.4, Math.min(6, zoom * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
    setZoom(nz);
    // keep the point under the cursor fixed
    requestAnimationFrame(() => {
      const after = toMm(mx, my);
      const { scale } = view();
      panRef.current = { x: panRef.current.x + (after.x - before.x) * scale, y: panRef.current.y + (after.y - before.y) * scale };
      forceRerender((n) => n + 1);
    });
  };

  const startNew = (type: StitchType) => { setNewType(type); setSelectedId(null); setSelectedNode(null); setCurrent({ type, nodes: [] }); };
  const finishObject = () => {
    if (!current) return;
    const min = current.type === "fill" ? 3 : 2;
    if (current.nodes.length >= min) {
      const id = nextId();
      commit([...objects, { id, nodes: current.nodes, ...defaultObject(current.type, cone), smooth: newSmooth }]);
      setSelectedId(id);
    }
    setCurrent(null);
  };
  const updateSelected = (patch: Partial<DigitObject>) => commit(objects.map((o) => (o.id === selectedId ? { ...o, ...patch } : o)));
  const deleteSelected = () => { commit(objects.filter((o) => o.id !== selectedId)); setSelectedId(null); setSelectedNode(null); };
  const move = (dir: -1 | 1) => {
    const i = objects.findIndex((o) => o.id === selectedId);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= objects.length) return;
    const copy = objects.slice();
    [copy[i], copy[j]] = [copy[j], copy[i]];
    commit(copy);
  };

  const loadRef = async (file: File) => {
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise<void>((res, rej) => { image.onload = () => res(); image.onerror = () => rej(); image.src = url; });
      const long = 600;
      const scale = long / Math.max(image.width, image.height);
      const w = Math.round(image.width * scale);
      const h = Math.round(image.height * scale);
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      cv.getContext("2d")!.drawImage(image, 0, 0, w, h);
      setRef({ canvas: cv, w, h, name: file.name, widthMm: 120 });
    } finally { URL.revokeObjectURL(url); }
  };

  const saveToLibrary = async () => {
    if (!built.built) return;
    setSaveState("saving");
    try {
      const thumb = document.createElement("canvas");
      thumb.width = 220; thumb.height = 220;
      const tctx = thumb.getContext("2d");
      if (tctx) { tctx.fillStyle = "#f4f2ee"; tctx.fillRect(0, 0, 220, 220); renderPattern(tctx, built.built.pattern, fitTransform(built.built.pattern, 220, 220, 12), { colors: built.hexes, sheen: false }); }
      await saveDesign({ id: crypto.randomUUID(), name: NAME, tool: "studio", createdAt: Date.now(), stitchCount: built.built.stats.realStitches, widthMm: built.built.stats.widthMm, heightMm: built.built.stats.heightMm, colors: built.hexes, thumbPng: thumb.toDataURL("image/png"), bytes: built.built.bytes });
      setSaveState("saved"); setTimeout(() => setSaveState("idle"), 1800);
    } catch { setSaveState("idle"); }
  };

  const stats = built.built?.stats;
  const overHoop = stats && !((stats.widthMm <= 330 && stats.heightMm <= 406) || (stats.widthMm <= 406 && stats.heightMm <= 330));

  return (
    <div className="flex flex-col-reverse gap-5 lg:grid lg:grid-cols-[320px_1fr]">
      <div className="space-y-4">
        <SectionBox eyebrow="New object">
          <ModeButtons options={[["fill", "Fill"], ["satin", "Satin"], ["run", "Run"]]} value={newType} onChange={(t) => startNew(t)} />
          <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer">
            <input type="checkbox" checked={newSmooth} onChange={(e) => setNewSmooth(e.target.checked)} className="accent-accent" />
            Curved (smooth through nodes)
          </label>
          <div className="text-[0.75rem] text-mid">
            Cone for new objects
            <div className="mt-1 flex items-center gap-2">
              <ThreadSelect value={cone.hex} onChange={(hex, code) => { const t = THREADS.find((x) => x.code === code)!; setCone({ hex, code, name: t.name }); }} />
              {ref && (
                <button onClick={() => setSampleMode((s) => !s)} title="Eyedropper: pick a cone from the reference" className={`border px-2 py-1 text-[0.75rem] ${sampleMode ? "border-fg bg-fg text-bg" : "border-hairline bg-bg text-fg hover:bg-card"}`}>⊙</button>
              )}
            </div>
          </div>
          {ref && (
            <div className="space-y-1.5 border-t border-hairline pt-2">
              <button onClick={() => { setWandMode((v) => !v); setSampleMode(false); }} className={`w-full border px-3 py-1.5 text-[0.8125rem] ${wandMode ? "border-fg bg-fg text-bg" : "border-hairline bg-bg text-fg hover:bg-card"}`}>
                🪄 Auto-trace region {wandMode ? "- click the reference" : ""}
              </button>
              {wandMode && <RangeRow label="Color tolerance" value={wandTol} min={10} max={90} onChange={setWandTol} fmt={(v) => `${v}`} />}
              <p className="text-[0.625rem] text-mid leading-relaxed">Click a color area on your reference - it becomes an editable fill you can then refine node by node.</p>
            </div>
          )}
          {current ? (
            <div className="flex gap-2">
              <button onClick={finishObject} className="flex-1 border border-fg bg-fg text-bg px-3 py-1.5 text-[0.8125rem] hover:opacity-85">Finish {current.type} ({current.nodes.length}) ⏎</button>
              <button onClick={() => setCurrent(null)} className="border border-hairline bg-bg px-3 py-1.5 text-[0.8125rem] text-fg hover:bg-card">Esc</button>
            </div>
          ) : (
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Pick a type, then click to drop nodes (fill needs 3+, closes). Select an
              object to drag its nodes, click a segment to insert one, or select a node and
              press Delete. ⌘Z undoes, D duplicates, scroll to zoom, drag empty space to pan.
            </p>
          )}
          <FabricSelect value={fabric} onChange={setFabric} />
          <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer">
            <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} className="accent-accent" />
            Snap to {GRID_MM} mm grid
          </label>
        </SectionBox>

        <SectionBox eyebrow="Reference image (trace over)">
          <label className="inline-block cursor-pointer border border-hairline bg-bg px-3 py-1.5 text-[0.8125rem] text-fg hover:bg-card">
            {ref ? `↻ ${ref.name}` : "Choose artwork"}
            <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.currentTarget.value = ""; if (f) void loadRef(f); }} />
          </label>
          {ref && (
            <>
              <RangeRow label="Reference width" value={ref.widthMm} min={40} max={300} onChange={(v) => setRef({ ...ref, widthMm: v })} fmt={(v) => fmtLen(v, units)} />
              <RangeRow label="Opacity" value={refOpacity} min={0} max={1} step={0.05} onChange={setRefOpacity} fmt={(v) => `${Math.round(v * 100)}%`} />
              <button onClick={() => setRef(null)} className="text-[0.6875rem] text-accent hover:underline">Remove reference</button>
              <p className="text-[0.6875rem] text-mid leading-relaxed">Drop your logo or drawing here and trace it - the ⊙ eyedropper pulls the nearest cone from any point you click.</p>
            </>
          )}
        </SectionBox>

        {selected && (
          <SectionBox eyebrow={`Selected · ${selected.type}${selected.smooth ? " · curved" : ""}`}>
            <div className="flex items-center gap-2">
              <ThreadSelect value={selected.hex} onChange={(hex, code) => { const t = THREADS.find((x) => x.code === code)!; updateSelected({ hex, code, name: t.name }); }} />
              {ref && <button onClick={() => setSampleMode(true)} title="Eyedropper for this object" className="border border-hairline bg-bg px-2 py-1 text-[0.75rem] text-fg hover:bg-card">⊙</button>}
            </div>
            <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer">
              <input type="checkbox" checked={selected.smooth} onChange={(e) => updateSelected({ smooth: e.target.checked })} className="accent-accent" />
              Curved
            </label>
            {selected.type === "run" && (<>
              <RangeRow label="Stitch length" value={selected.stitchLenMm} min={1.5} max={5} step={0.1} onChange={(v) => updateSelected({ stitchLenMm: v })} fmt={(v) => `${v.toFixed(1)} mm`} />
              <ModeButtons small options={[[1, "Run"], [3, "Bean ×3"]]} value={selected.bean} onChange={(v) => updateSelected({ bean: v })} />
            </>)}
            {selected.type === "satin" && (<>
              <RangeRow label="Width" value={selected.widthMm} min={1.5} max={10} step={0.25} onChange={(v) => updateSelected({ widthMm: v })} fmt={(v) => `${v.toFixed(2)} mm`} />
              <RangeRow label="Density" value={selected.densityMm} min={0.3} max={0.7} step={0.02} onChange={(v) => updateSelected({ densityMm: v })} fmt={(v) => `${v.toFixed(2)} mm`} />
              <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer"><input type="checkbox" checked={selected.underlay} onChange={(e) => updateSelected({ underlay: e.target.checked })} className="accent-accent" />Underlay</label>
            </>)}
            {selected.type === "fill" && (<>
              <RangeRow label="Angle" value={selected.angleDeg} min={-90} max={90} onChange={(v) => updateSelected({ angleDeg: v })} fmt={(v) => `${v}°`} />
              <RangeRow label="Spacing" value={selected.densityMm} min={0.3} max={0.7} step={0.02} onChange={(v) => updateSelected({ densityMm: v })} fmt={(v) => `${v.toFixed(2)} mm`} />
              <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer"><input type="checkbox" checked={selected.outline} onChange={(e) => updateSelected({ outline: e.target.checked })} className="accent-accent" />Run outline</label>
            </>)}
            <div className="flex flex-wrap gap-1.5 pt-1">
              <button onClick={() => move(-1)} className="border border-hairline bg-bg px-2 py-1 text-[0.6875rem] text-fg hover:bg-card">↑ earlier</button>
              <button onClick={() => move(1)} className="border border-hairline bg-bg px-2 py-1 text-[0.6875rem] text-fg hover:bg-card">↓ later</button>
              <button onClick={duplicateSelected} className="border border-hairline bg-bg px-2 py-1 text-[0.6875rem] text-fg hover:bg-card">Duplicate</button>
              {selectedNode !== null && <button onClick={deleteNode} className="border border-hairline bg-bg px-2 py-1 text-[0.6875rem] text-fg hover:bg-card">Del node</button>}
              <button onClick={deleteSelected} className="ml-auto border border-hairline bg-bg px-2 py-1 text-[0.6875rem] text-red-700 hover:bg-card">Delete</button>
            </div>
          </SectionBox>
        )}

        <SectionBox eyebrow={`Objects (${objects.length})`}>
          <div className="flex gap-2 mb-1">
            <button onClick={undo} disabled={undoRef.current.length === 0} className="border border-hairline bg-bg px-2.5 py-1 text-[0.75rem] text-fg disabled:opacity-40 hover:bg-card">↶ Undo</button>
            <button onClick={redo} disabled={redoRef.current.length === 0} className="border border-hairline bg-bg px-2.5 py-1 text-[0.75rem] text-fg disabled:opacity-40 hover:bg-card">↷ Redo</button>
          </div>
          {objects.length === 0 ? (
            <p className="text-[0.75rem] text-mid">None yet - pick a stitch type and start clicking.</p>
          ) : (
            <div className="space-y-1">
              {objects.map((o, i) => (
                <button key={o.id} onClick={() => { setSelectedId(o.id); setSelectedNode(null); setCurrent(null); }} className={`w-full flex items-center gap-2 border px-2 py-1 text-[0.75rem] text-left ${o.id === selectedId ? "border-fg bg-card" : "border-hairline bg-bg hover:bg-card"}`}>
                  <span className="text-mid tabular-nums w-4">{i + 1}</span>
                  <span className="w-3.5 h-3.5 border border-hairline shrink-0" style={{ background: o.hex }} />
                  <span className="text-fg">{o.type}{o.smooth ? " ~" : ""}</span>
                  <span className="text-mid ml-auto tabular-nums">{o.nodes.length} pts</span>
                </button>
              ))}
            </div>
          )}
          {objects.length > 0 && <button onClick={() => commit([])} className="text-[0.6875rem] text-accent hover:underline">Clear all</button>}
        </SectionBox>
      </div>

      <div className="min-w-0">
       <div className="space-y-3 sticky top-0 z-20 bg-bg pb-2 lg:top-4 lg:z-auto lg:pb-0">
        <canvas ref={canvasRef} className="w-full h-[40vh] min-h-[240px] lg:h-[clamp(340px,64vh,620px)] border border-hairline touch-none cursor-crosshair" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onClick={onPointerClick} onDoubleClick={finishObject} onWheel={onWheel} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {stats ? (
            <p className="text-[0.8125rem] text-mid tabular-nums">{stats.realStitches.toLocaleString()} stitches · {stats.widthMm.toFixed(0)}×{stats.heightMm.toFixed(0)} mm · {built.hexes.length} cone{built.hexes.length === 1 ? "" : "s"} · ~{formatMinutes(stats.runtimeMinutes)}</p>
          ) : (
            <p className="text-[0.8125rem] text-mid">Place objects to build a design. The lines under your nodes are the real DST.</p>
          )}
          <span className="ml-auto text-[0.6875rem] text-mid tabular-nums">zoom {(zoom * 100).toFixed(0)}%{zoom !== 1 ? " · " : ""}{zoom !== 1 && <button className="text-accent hover:underline" onClick={() => { setZoom(1); panRef.current = { x: 0, y: 0 }; forceRerender((n) => n + 1); }}>reset</button>}</span>
        </div>
        {overHoop && <Warning>{fmtSize(stats!.widthMm, stats!.heightMm, units)} exceeds the 13 × 16 in hoop in every orientation.</Warning>}
        {stats && stats.realStitches > 60000 && <Warning>Over 60k stitches - a long sew.</Warning>}
        {/* Mobile: stack the actions full-width instead of a cramped wrap */}
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="flex gap-2 min-w-0">
            <ExportButton built={built.built} colors={built.hexes} name="bayside-studio" />
            <button onClick={() => void saveToLibrary()} disabled={!built.built || saveState !== "idle"} className="border border-hairline bg-bg px-4 py-2 text-[0.875rem] text-fg disabled:opacity-40 hover:bg-card whitespace-nowrap">{saveState === "saved" ? "Saved ✓" : saveState === "saving" ? "Saving…" : "☆ Save"}</button>
          </div>
          <AnimExport built={built.built} colors={built.hexes} name="bayside-studio" />
        </div>
        <p className="text-[0.6875rem] text-mid leading-relaxed">The lines under your nodes are re-parsed from the exact DST bytes you'll download - what you see is the file the machine reads.</p>
       </div>
      </div>
    </div>
  );
}
