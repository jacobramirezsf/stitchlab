// Stitch Lab tool: Meander - context-based space-filling curves (Dafner,
// Cohen-Or & Matias, Eurographics 2000). Lay a coarse grid over any shape,
// build a spanning tree over the cells, and the curve that circumnavigates
// the tree is a Hamiltonian cycle on the doubled grid: ONE closed line
// visiting every corner of the region, Hilbert-quality but for arbitrary
// masks. Weight the tree by an image and the corridors follow its structure -
// the curve literally meanders along your picture's features.
//
// The construction reduces to one local rule per cell: an internal subcell
// edge exists on a side exactly when NO tree edge crosses that side; where a
// tree edge crosses, the two facing subcells connect through instead. The
// resulting 2-regular graph is provably a single cycle.

import { useCallback, useMemo, useState } from "react";
import { THREADS } from "../../data/threads";
import type { PathMm } from "../lib/generators";
import { pathsToStitches, resamplePath } from "../lib/generators";
import type { Ring } from "./tatami";
import {
  buildDesign,
  DropZone,
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

export type MeanderOpts = {
  spacingMm?: number; // final curve spacing (cell pitch = 2×), default 2
  seed?: number;
  /**
   * Optional context image (grayscale, mapped over the shape's bbox): tree
   * edges between similar-luminance cells get low weight, so corridors follow
   * the image's structure - Dafner's "context-based" weighting.
   */
  context?: { w: number; h: number; lum: Float32Array } | null;
  contextStrength?: number; // 0..1 blend with random weights, default 0.85
};

/** One closed space-filling curve over the shape. Returns [] if too small. */
export function meanderCurve(rings: Ring[], opts: MeanderOpts = {}): PathMm {
  const spacing = Math.max(1, opts.spacingMm ?? 2);
  const pitch = spacing * 2;
  const rand = mulberry32(opts.seed ?? 1);
  const ctx = opts.context ?? null;
  const strength = Math.max(0, Math.min(1, opts.contextStrength ?? 0.85));

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
  const cols = Math.max(2, Math.floor((maxX - minX) / pitch));
  const rows = Math.max(2, Math.floor((maxY - minY) / pitch));

  const cellIdx = new Int32Array(cols * rows).fill(-1);
  const cells: { cx: number; cy: number; x: number; y: number }[] = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x = minX + (cx + 0.5) * pitch;
      const y = minY + (cy + 0.5) * pitch;
      if (insideRings(rings, x, y)) {
        cellIdx[cy * cols + cx] = cells.length;
        cells.push({ cx, cy, x, y });
      }
    }
  }
  if (cells.length < 3) return [];

  const lumAt = (x: number, y: number): number => {
    if (!ctx) return 0.5;
    const u = Math.min(ctx.w - 1, Math.max(0, Math.round(((x - minX) / (maxX - minX)) * (ctx.w - 1))));
    const v = Math.min(ctx.h - 1, Math.max(0, Math.round(((y - minY) / (maxY - minY)) * (ctx.h - 1))));
    return ctx.lum[v * ctx.w + u];
  };

  // Edges between orthogonally adjacent inside-cells, weighted.
  type Edge = { a: number; b: number; w: number };
  const edges: Edge[] = [];
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
    ] as const) {
      const nx = c.cx + dx;
      const ny = c.cy + dy;
      if (nx >= cols || ny >= rows) continue;
      const j = cellIdx[ny * cols + nx];
      if (j < 0) continue;
      const rw = rand();
      const cw = ctx ? Math.abs(lumAt(c.x, c.y) - lumAt(cells[j].x, cells[j].y)) : rw;
      edges.push({ a: i, b: j, w: ctx ? cw * strength + rw * (1 - strength) : rw });
    }
  }

  // Kruskal MST with union–find.
  edges.sort((e1, e2) => e1.w - e2.w);
  const parent = new Int32Array(cells.length).map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) {
      const nx = parent[i];
      parent[i] = r;
      i = nx;
    }
    return r;
  };
  // Tree edges by direction per cell: [right, down, left, up]
  const treeEdge = cells.map(() => [false, false, false, false]);
  for (const e of edges) {
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra === rb) continue;
    parent[ra] = rb;
    const A = cells[e.a];
    const B = cells[e.b];
    if (B.cx === A.cx + 1) {
      treeEdge[e.a][0] = true;
      treeEdge[e.b][2] = true;
    } else {
      treeEdge[e.a][1] = true;
      treeEdge[e.b][3] = true;
    }
  }
  // (Disconnected shapes: each component becomes its own cycle; we keep the
  // largest below.)

  // Doubled grid: subpoints per cell at ±pitch/4. Local rule connections.
  const q = pitch / 4;
  const subId = (cell: number, corner: number) => cell * 4 + corner; // 0 TL,1 TR,2 BR,3 BL
  const adj = new Map<number, number[]>();
  const link = (u: number, v: number) => {
    const au = adj.get(u);
    if (au) au.push(v);
    else adj.set(u, [v]);
    const av = adj.get(v);
    if (av) av.push(u);
    else adj.set(v, [u]);
  };
  const neighborOf = (i: number, dir: number): number => {
    const c = cells[i];
    const nx = c.cx + [1, 0, -1, 0][dir];
    const ny = c.cy + [0, 1, 0, -1][dir];
    if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) return -1;
    return cellIdx[ny * cols + nx];
  };
  for (let i = 0; i < cells.length; i++) {
    const [right, down, left, up] = treeEdge[i];
    // Internal edges on sides with no tree edge:
    if (!up) link(subId(i, 0), subId(i, 1)); // TL-TR
    if (!right) link(subId(i, 1), subId(i, 2)); // TR-BR
    if (!down) link(subId(i, 2), subId(i, 3)); // BR-BL
    if (!left) link(subId(i, 3), subId(i, 0)); // BL-TL
    // Crossings where tree edges exist (emit from the lower index only):
    if (right) {
      const j = neighborOf(i, 0);
      if (j > i) {
        link(subId(i, 1), subId(j, 0)); // TR - neighbor TL
        link(subId(i, 2), subId(j, 3)); // BR - neighbor BL
      }
    }
    if (down) {
      const j = neighborOf(i, 1);
      if (j > i) {
        link(subId(i, 3), subId(j, 0)); // BL - neighbor TL
        link(subId(i, 2), subId(j, 1)); // BR - neighbor TR
      }
    }
    if (left) {
      const j = neighborOf(i, 2);
      if (j > i) {
        link(subId(i, 0), subId(j, 1));
        link(subId(i, 3), subId(j, 2));
      }
    }
    if (up) {
      const j = neighborOf(i, 3);
      if (j > i) {
        link(subId(i, 0), subId(j, 3));
        link(subId(i, 1), subId(j, 2));
      }
    }
  }

  const subPoint = (id: number): { x: number; y: number } => {
    const cell = cells[Math.floor(id / 4)];
    const corner = id % 4;
    const sx = corner === 1 || corner === 2 ? q : -q;
    const sy = corner === 2 || corner === 3 ? q : -q;
    return { x: cell.x + sx, y: cell.y + sy };
  };

  // Walk cycles; keep the longest (handles accidental disconnection).
  const visited = new Set<number>();
  let best: PathMm = [];
  for (const start of adj.keys()) {
    if (visited.has(start)) continue;
    const cycle: PathMm = [];
    let prev = -1;
    let cur = start;
    for (;;) {
      visited.add(cur);
      cycle.push(subPoint(cur));
      const ns = adj.get(cur) ?? [];
      const next = ns[0] === prev ? ns[1] : ns[0];
      if (next === undefined) break;
      prev = cur;
      cur = next;
      if (cur === start) break;
    }
    if (cycle.length > best.length) best = cycle;
  }
  if (best.length > 2) best.push(best[0]); // close the loop
  return best;
}

// ─── Component ───────────────────────────────────────────────────────────

const NAME = "bayside-meander";

export default function MeanderTool() {
  const [sizeMm, setSizeMm] = useState(90);
  const [spacing, setSpacing] = useState(2);
  const [seed, setSeed] = useState(2000); // Dafner vintage
  const [img, setImg] = useState<{ w: number; h: number; lum: Float32Array } | null>(null);
  const [fileName, setFileName] = useState("");
  const [stitchLen, setStitchLen] = useState(2.4);
  const [bean, setBean] = useState<1 | 3>(1);
  const [threadHex, setThreadHex] = useState(
    THREADS.find((t) => t.family === "Purple" && t.hex)?.hex ??
      THREADS.find((t) => t.hex)?.hex ??
      "#082870",
  );

  const loadFile = useCallback(async (file: File) => {
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Could not read that image."));
        image.src = url;
      });
      const long = 120;
      const scale = long / Math.max(image.width, image.height);
      const w = Math.max(24, Math.round(image.width * scale));
      const h = Math.max(24, Math.round(image.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const c2d = canvas.getContext("2d");
      if (!c2d) return;
      c2d.drawImage(image, 0, 0, w, h);
      const data = c2d.getImageData(0, 0, w, h).data;
      const lum = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        lum[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
      }
      setImg({ w, h, lum });
      setFileName(file.name);
    } finally {
      URL.revokeObjectURL(url);
    }
  }, []);

  const dSize = useDebounced(sizeMm);
  const dSpacing = useDebounced(spacing);
  const { rings, element: shapeElement } = useShapeSource(dSize, "circle");

  const built = useMemo(() => {
    if (rings.length === 0) return null;
    const curve = meanderCurve(rings, { spacingMm: dSpacing, seed, context: img });
    if (curve.length < 8) return null;
    return buildDesign(pathsToStitches([resamplePath(curve, stitchLen, 0.4)], bean), NAME);
  }, [rings, dSpacing, seed, img, stitchLen, bean]);

  const stitchCount = built?.stats.realStitches ?? 0;

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="Region">
            {shapeElement}
            <SizeField valueMm={sizeMm} min={40} max={330} onChange={setSizeMm} />
            <RangeRow label="Curve spacing" value={spacing} min={1.5} max={6} step={0.25} onChange={setSpacing} fmt={(v) => `${v.toFixed(2)} mm`} />
            <button
              onClick={() => setSeed(Math.floor(Math.random() * 100000))}
              className="border border-hairline bg-bg px-3 py-1 text-[0.75rem] text-fg hover:bg-card"
            >
              New maze (seed {seed})
            </button>
          </SectionBox>

          <SectionBox eyebrow="Context image (optional)">
            <DropZone onFile={(f) => void loadFile(f)} className="border border-dashed border-mid/50 px-3 py-3">
              <label className="inline-block cursor-pointer border border-hairline bg-bg px-4 py-1.5 text-[0.8125rem] text-fg hover:bg-card">
                {fileName ? `↻ ${fileName}` : "Choose image"}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(ev) => {
                    const f = ev.target.files?.[0];
                    if (f) void loadFile(f);
                    ev.target.value = "";
                  }}
                />
              </label>
              <span className="ml-2 text-[0.6875rem] text-mid">or drop it here</span>
            </DropZone>
            {img && (
              <button onClick={() => { setImg(null); setFileName(""); }} className="ml-2 text-[0.75rem] text-accent hover:underline">
                clear
              </button>
            )}
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              The Dafner trick: weight the spanning tree by an image and the meander's
              corridors follow its features - your picture, drawn as one maze-like line.
            </p>
          </SectionBox>

          <SectionBox eyebrow="Stitches">
            <RangeRow label="Stitch length" value={stitchLen} min={1.5} max={4} step={0.1} onChange={setStitchLen} fmt={(v) => `${v.toFixed(1)} mm`} />
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
          emptyHint="Pick a shape or drop an SVG."
        >
          {built && (
            <p className="text-[0.75rem] text-mid tabular-nums">
              one closed space-filling line · zero trims · every seed is a different maze
            </p>
          )}
          {stitchCount > 60000 && (
            <Warning>Over 60k stitches - widen the spacing or shrink the region.</Warning>
          )}
        </PreviewRail>
      }
    />
  );
}
