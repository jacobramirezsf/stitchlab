// Image Maze - a photo as one connected labyrinth. Tone-driven quadtree sites
// (dark → finer subdivision) are joined by a minimum spanning tree whose edge
// costs prefer dark regions, so the subject emerges as dense maze and the
// background stays open. The whole picture is ONE connected tree - after
// routeStrokes it sews as a handful of long corridors with almost no trims.
// Validated in scripts/research-exp6.ts.

import { useMemo, useState } from "react";
import {
  ToolLayout,
  SectionBox,
  RangeRow,
  ImagePick,
  ThreadRow,
  PreviewRail,
  Warning,
  buildDesign,
  useDebouncedKey,
  useUnits,
  fmtLen,
  type LumImg,
} from "./shared";
import { THREADS } from "../../data/threads";
import { pathsToStitches, resamplePath, fitPaths, routeStrokes, type PathMm } from "../lib/generators";
import { normalizeContrast } from "../lib/lineart";

const NAME = "bayside-imagemaze";
const DEFAULT_THREAD = THREADS.find((t) => t.code === "1000")?.hex ?? "#111111";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Site = { x: number; y: number };

export function mazeFromImage(img: { w: number; h: number; lum: Float32Array }, detail: number, jitter: number): PathMm[] {
  const { w, h, lum } = img;
  const rand = mulberry32(9);
  // detail 1..10 → finest cell 6.5..3, coarsest 26..12
  const minCell = 6.8 - detail * 0.38;
  const maxCell = 27 - detail * 1.5;
  const sites: Site[] = [];
  const subdivide = (x0: number, y0: number, size: number) => {
    let sum = 0, n = 0;
    const step = Math.max(1, Math.floor(size / 6));
    for (let y = Math.floor(y0); y < Math.min(h, y0 + size); y += step)
      for (let x = Math.floor(x0); x < Math.min(w, x0 + size); x += step) { sum += 1 - lum[y * w + x]; n++; }
    const dark = n ? sum / n : 0;
    const want = maxCell - (maxCell - minCell) * Math.pow(dark, 0.55);
    if (size > want && size >= minCell * 2) {
      const half = size / 2;
      subdivide(x0, y0, half); subdivide(x0 + half, y0, half);
      subdivide(x0, y0 + half, half); subdivide(x0 + half, y0 + half, half);
    } else {
      const j = size * 0.3 * jitter;
      const cx = x0 + size / 2 + (rand() - 0.5) * j, cy = y0 + size / 2 + (rand() - 0.5) * j;
      if (cx >= 0 && cx < w && cy >= 0 && cy < h) sites.push({ x: cx, y: cy });
    }
  };
  subdivide(0, 0, Math.max(w, h));
  const n = sites.length;
  if (n < 2) return [];

  // Prim MST over a hashed neighbor graph; cost prefers dark midpoints.
  const cell = 24;
  const gw = Math.ceil((w + 1) / cell);
  const grid = new Map<number, number[]>();
  const key = (x: number, y: number) =>
    Math.max(0, Math.floor(y / cell)) * gw + Math.max(0, Math.min(gw - 1, Math.floor(x / cell)));
  sites.forEach((s, i) => {
    const k = key(s.x, s.y);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(i);
  });
  const near = (i: number): number[] => {
    const s = sites[i];
    const out: number[] = [];
    for (let R = 1; R <= 6; R++) {
      out.length = 0;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const b = grid.get(key(s.x + dx * cell, s.y + dy * cell));
        if (b) out.push(...b);
      }
      if (out.length >= 8) break;
    }
    return out;
  };
  const cost = (a: number, b: number) => {
    const sa = sites[a], sb = sites[b];
    const mx = Math.min(w - 1, Math.floor((sa.x + sb.x) / 2)), my = Math.min(h - 1, Math.floor((sa.y + sb.y) / 2));
    return Math.hypot(sa.x - sb.x, sa.y - sb.y) * (0.4 + 1.1 * lum[my * w + mx]) * (0.85 + 0.3 * rand());
  };
  const inTree = new Uint8Array(n);
  const dist = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  dist[0] = 0;
  const paths: PathMm[] = [];
  for (let it = 0; it < n; it++) {
    let u = -1, bd = Infinity;
    for (let i = 0; i < n; i++) if (!inTree[i] && dist[i] < bd) { bd = dist[i]; u = i; }
    if (u < 0) break;
    inTree[u] = 1;
    if (parent[u] >= 0) paths.push([{ x: sites[parent[u]].x, y: sites[parent[u]].y }, { x: sites[u].x, y: sites[u].y }]);
    for (const v of near(u)) {
      if (inTree[v] || v === u) continue;
      const c = cost(u, v);
      if (c < dist[v]) { dist[v] = c; parent[v] = u; }
    }
  }
  return paths;
}

export default function ImageMazeTool() {
  const units = useUnits();
  const [img, setImg] = useState<LumImg | null>(null);
  const [fileName, setFileName] = useState("");
  const [detail, setDetail] = useState(6);
  const [jitter, setJitter] = useState(1);
  const [sizeMm, setSizeMm] = useState(150);
  const [threadHex, setThreadHex] = useState(DEFAULT_THREAD);

  const genKey = useDebouncedKey([fileName, detail, jitter], 220);
  const edges = useMemo(() => {
    if (!img) return [];
    const norm = normalizeContrast({ w: img.w, h: img.h, lum: img.lum });
    return mazeFromImage(norm, detail, jitter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, genKey]);

  const built = useMemo(() => {
    if (!edges.length) return null;
    // routeStrokes merges the tree's edges into long corridors - the maze sews
    // as a few continuous runs instead of thousands of two-point jumps.
    const fitted = routeStrokes(fitPaths(edges, sizeMm), { orOptMs: 120 })
      .map((p) => resamplePath(p, 2.2, 0.4));
    return buildDesign(pathsToStitches(fitted, 1), NAME);
  }, [edges, sizeMm]);

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="photo">
            <ImagePick onImage={(i, n) => { setImg(i); setFileName(n); }} fileName={fileName} longSide={300}
              hint="Bold shapes and portraits work best - darkness becomes maze density." />
          </SectionBox>
          <SectionBox eyebrow="maze">
            <RangeRow label="Detail" value={detail} min={1} max={10} step={1} onChange={setDetail} />
            <RangeRow label="Wobble" value={jitter} min={0} max={2} step={0.1} onChange={setJitter} fmt={(v) => v.toFixed(1)} />
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              The picture becomes one connected labyrinth: dark areas turn into dense
              corridors, light areas open up. Zero wobble is strict and architectural;
              more wobble grows fur.
            </p>
          </SectionBox>
          <SectionBox eyebrow="stitch">
            <RangeRow label="Size" value={sizeMm} min={60} max={300} step={5} onChange={setSizeMm} fmt={(v) => fmtLen(v, units)} />
            <ThreadRow hex={threadHex} onChange={setThreadHex} />
          </SectionBox>
          {built && built.stats.realStitches > 60000 && (
            <Warning>Over 60k stitches - lower the detail or shrink the size before stitching.</Warning>
          )}
        </>
      }
      preview={
        <PreviewRail built={built} colors={[threadHex]} name={NAME} emptyHint="Load a photo - it becomes a labyrinth.">
          {built && (
            <p className="text-[0.6875rem] text-mid tabular-nums">
              {edges.length.toLocaleString()} corridors · {built.stats.realStitches.toLocaleString()} stitches · one connected structure
            </p>
          )}
        </PreviewRail>
      }
    />
  );
}
