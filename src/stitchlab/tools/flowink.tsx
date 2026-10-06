// Flow Ink - three ink interpretations of a photo, all steered by its
// edge-tangent flow (the same field behind the FDoG line tools):
//   hedcut    - stipple dots chained tightly ALONG the flow, wide across it,
//               so ridges of dots follow features (the newspaper-portrait look);
//               each dot sews as a small tack cluster
//   engraving - short flow-following strokes, thickness by tone; woodcut air
//   contours  - long evenly-spaced streamlines (Jobard–Lefer), separation set
//               by tone, so the image emerges from line density alone
// Validated in scripts/research-exp5.ts / research-exp9.ts before becoming a
// tool; the geometry here is the same code adapted to mm output.

import { useMemo, useState } from "react";
import {
  ToolLayout,
  SectionBox,
  RangeRow,
  ModeButtons,
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

const DEFAULT_THREAD = THREADS.find((t) => t.code === "1000")?.hex ?? "#111111";
import { pathsToStitches, resamplePath, fitPaths, routeStrokes, type PathMm } from "../lib/generators";
import { normalizeContrast, edgeTangentFlow, type Etf } from "../lib/lineart";

const NAME = "bayside-flowink";

type Mode = "hedcut" | "engraving" | "contours";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hedcut: anisotropic dart-throwing. Returns dot centers + radii in px. */
export function hedcut(img: { w: number; h: number; lum: Float32Array }, etf: Etf, density: number, gamma: number): { x: number; y: number; r: number }[] {
  const { w, h, lum } = img;
  const rand = mulberry32(7);
  const base = 9.5 - density * 0.55; // density 1..10 → base spacing 8.95..4
  const cell = Math.max(2, base);
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const grid: number[][] = Array.from({ length: gw * gh }, () => []);
  const dots: { x: number; y: number; r: number }[] = [];
  for (let t = 0; t < w * h * 2; t++) {
    const x = rand() * w, y = rand() * h;
    const i = Math.min(w * h - 1, Math.floor(y) * w + Math.floor(x));
    const dark = 1 - lum[i];
    if (rand() > Math.pow(dark, gamma) * 0.95 + 0.02) continue;
    const tx = etf.tx[i], ty = etf.ty[i];
    const along = base * (0.6 + 0.9 * (1 - dark));
    const across = along * 2.1;
    let ok = true;
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    const R = Math.ceil(across / cell) + 1;
    for (let dy = -R; dy <= R && ok; dy++) for (let dx = -R; dx <= R && ok; dx++) {
      const cx = gx + dx, cy = gy + dy;
      if (cx < 0 || cx >= gw || cy < 0 || cy >= gh) continue;
      for (const di of grid[cy * gw + cx]) {
        const d = dots[di];
        const vx = d.x - x, vy = d.y - y;
        const a = vx * tx + vy * ty, c = -vx * ty + vy * tx;
        if ((a * a) / (along * along) + (c * c) / (across * across) < 1) { ok = false; break; }
      }
    }
    if (!ok) continue;
    grid[gy * gw + gx].push(dots.length);
    dots.push({ x, y, r: 0.5 + 1.6 * Math.pow(dark, 0.85) });
  }
  return dots;
}

/** Engraving: short streamline dashes with layered occupancy. Paths in px. */
export function engraving(img: { w: number; h: number; lum: Float32Array }, etf: Etf, density: number, lenSteps: number): PathMm[] {
  const { w, h, lum } = img;
  const rand = mulberry32(11);
  const cell = 8 - density * 0.35; // density 1..10 → 7.65..4.5
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const occupied = new Float32Array(gw * gh);
  const out: PathMm[] = [];
  for (let t = 0; t < w * h; t++) {
    const x0 = rand() * w, y0 = rand() * h;
    const i0 = Math.min(w * h - 1, Math.floor(y0) * w + Math.floor(x0));
    const dark = 1 - lum[i0];
    if (dark < 0.22 || rand() > Math.pow(dark, 1.6)) continue;
    const gx = Math.floor(x0 / cell), gy = Math.floor(y0 / cell);
    if (occupied[gy * gw + gx] > 0.35 + 0.9 * dark) continue;
    const pts: PathMm = [{ x: x0, y: y0 }];
    for (const dir of [1, -1]) {
      let x = x0, y = y0;
      for (let s = 0; s < lenSteps; s++) {
        const i = Math.min(w * h - 1, Math.floor(y) * w + Math.floor(x));
        let tx = etf.tx[i] * dir, ty = etf.ty[i] * dir;
        const m = Math.hypot(tx, ty);
        if (m < 1e-4) break;
        tx /= m; ty /= m;
        x += tx * 1.6; y += ty * 1.6;
        if (x < 0 || x >= w || y < 0 || y >= h) break;
        if (dir === 1) pts.push({ x, y }); else pts.unshift({ x, y });
      }
    }
    if (pts.length < 4) continue;
    for (const p of pts) {
      const cgx = Math.floor(p.x / cell), cgy = Math.floor(p.y / cell);
      if (cgx >= 0 && cgx < gw && cgy >= 0 && cgy < gh) occupied[cgy * gw + cgx] += 0.34;
    }
    out.push(pts);
  }
  return out;
}

/** Contours: evenly-spaced streamlines, separation by tone. Paths in px. */
export function contours(img: { w: number; h: number; lum: Float32Array }, etf: Etf, density: number): PathMm[] {
  const { w, h, lum } = img;
  const lumAt = (x: number, y: number) =>
    lum[Math.max(0, Math.min(h - 1, Math.floor(y))) * w + Math.max(0, Math.min(w - 1, Math.floor(x)))];
  const fine = 4.4 - density * 0.22; // density 1..10 → 4.18..2.2
  const sepAt = (x: number, y: number) => fine + fine * 4.4 * Math.pow(lumAt(x, y), 1.6);
  const cell = fine;
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const occ: { x: number; y: number }[][] = Array.from({ length: gw * gh }, () => []);
  const tooClose = (x: number, y: number, sep: number): boolean => {
    const R = Math.ceil(sep / cell);
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const cx = gx + dx, cy = gy + dy;
      if (cx < 0 || cx >= gw || cy < 0 || cy >= gh) continue;
      for (const p of occ[cy * gw + cx]) if (Math.hypot(p.x - x, p.y - y) < sep) return true;
    }
    return false;
  };
  const mark = (x: number, y: number) => {
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    if (gx >= 0 && gx < gw && gy >= 0 && gy < gh) occ[gy * gw + gx].push({ x, y });
  };
  const trace = (x0: number, y0: number): PathMm => {
    const line: PathMm = [{ x: x0, y: y0 }];
    for (const dir of [1, -1]) {
      let x = x0, y = y0, px = 0, py = 0;
      for (let s = 0; s < 700; s++) {
        const i = Math.max(0, Math.min(h - 1, Math.floor(y))) * w + Math.max(0, Math.min(w - 1, Math.floor(x)));
        let tx = etf.tx[i] * dir, ty = etf.ty[i] * dir;
        const m = Math.hypot(tx, ty);
        if (m < 1e-4) break;
        tx /= m; ty /= m;
        if (px * tx + py * ty < -0.2) { tx = -tx; ty = -ty; }
        px = tx; py = ty;
        x += tx * 1.35; y += ty * 1.35;
        if (x < 1 || x >= w - 1 || y < 1 || y >= h - 1) break;
        if (tooClose(x, y, sepAt(x, y) * 0.55)) break;
        if (dir === 1) line.push({ x, y }); else line.unshift({ x, y });
      }
    }
    return line;
  };
  const lines: PathMm[] = [];
  const lattice: { x: number; y: number; d: number }[] = [];
  for (let y = 3; y < h - 3; y += 5) for (let x = 3; x < w - 3; x += 5)
    lattice.push({ x, y, d: 1 - lumAt(x, y) });
  lattice.sort((a, b) => b.d - a.d);
  const seeds: { x: number; y: number }[] = lattice.map((s) => ({ x: s.x, y: s.y }));
  let si = 0;
  while (si < seeds.length && lines.length < 3600) {
    const s = seeds[si++];
    // leave near-white paper empty - the image should come from density
    if (lumAt(s.x, s.y) > 0.93) continue;
    if (tooClose(s.x, s.y, sepAt(s.x, s.y))) continue;
    const line = trace(s.x, s.y);
    if (line.length < 8) continue;
    for (const p of line) mark(p.x, p.y);
    lines.push(line);
    for (let k = 0; k < line.length; k += 4) {
      const p = line[k];
      const i = Math.max(0, Math.min(h - 1, Math.floor(p.y))) * w + Math.max(0, Math.min(w - 1, Math.floor(p.x)));
      const nx = -etf.ty[i], ny = etf.tx[i];
      const d = sepAt(p.x, p.y);
      seeds.push({ x: p.x + nx * d, y: p.y + ny * d }, { x: p.x - nx * d, y: p.y - ny * d });
    }
  }
  return lines;
}

/** A dot as a sewable tack cluster: a tiny 3-armed star of short stitches. */
export function dotToTack(x: number, y: number, r: number): PathMm {
  const arm = Math.max(0.5, r);
  const pts: PathMm = [];
  for (const a of [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3]) {
    pts.push({ x: x - Math.cos(a) * arm, y: y - Math.sin(a) * arm });
    pts.push({ x: x + Math.cos(a) * arm, y: y + Math.sin(a) * arm });
    pts.push({ x, y });
  }
  return pts;
}

const MODES: [Mode, string][] = [
  ["hedcut", "Hedcut dots"],
  ["engraving", "Engraving"],
  ["contours", "Contours"],
];

export default function FlowInkTool() {
  const units = useUnits();
  const [img, setImg] = useState<LumImg | null>(null);
  const [fileName, setFileName] = useState("");
  const [mode, setMode] = useState<Mode>("hedcut");
  const [density, setDensity] = useState(6);
  const [gamma, setGamma] = useState(1.15);
  const [strokeLen, setStrokeLen] = useState(16);
  const [sizeMm, setSizeMm] = useState(150);
  const [threadHex, setThreadHex] = useState(DEFAULT_THREAD);

  const genKey = useDebouncedKey([fileName, mode, density, gamma, strokeLen], 220);
  const geometry = useMemo(() => {
    if (!img) return null;
    const norm = normalizeContrast({ w: img.w, h: img.h, lum: img.lum });
    const etf = edgeTangentFlow(norm, 5, 2);
    if (mode === "hedcut") {
      const dots = hedcut(norm, etf, density, gamma);
      return { paths: dots.map((d) => dotToTack(d.x, d.y, d.r)), count: dots.length, tack: true };
    }
    const paths = mode === "engraving" ? engraving(norm, etf, density, strokeLen) : contours(norm, etf, density);
    return { paths, count: paths.length, tack: false };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, genKey]);

  const built = useMemo(() => {
    if (!geometry || !geometry.paths.length) return null;
    const fitted = fitPaths(geometry.paths, sizeMm);
    const finished = geometry.tack
      ? fitted // tack clusters must keep their exact tiny geometry
      : routeStrokes(fitted).map((p) => resamplePath(p, 2, 0.4));
    return buildDesign(pathsToStitches(finished, 1), NAME);
  }, [geometry, sizeMm]);

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="photo">
            <ImagePick onImage={(i, n) => { setImg(i); setFileName(n); }} fileName={fileName} longSide={330}
              hint="Faces and single subjects read best - the flow field follows their features." />
          </SectionBox>
          <SectionBox eyebrow="ink">
            <ModeButtons small options={MODES} value={mode} onChange={setMode} />
            <RangeRow label="Density" value={density} min={1} max={10} step={1} onChange={setDensity} />
            {mode === "hedcut" && (
              <RangeRow label="Contrast" value={gamma} min={0.6} max={2.2} step={0.05} onChange={setGamma} fmt={(v) => v.toFixed(2)} />
            )}
            {mode === "engraving" && (
              <RangeRow label="Stroke length" value={strokeLen} min={6} max={30} step={1} onChange={setStrokeLen} fmt={(v) => `${v} steps`} />
            )}
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              {mode === "hedcut"
                ? "Dots chain tightly along the photo's flow and spread apart across it, so ridges of stipple follow the features - the newspaper-portrait look. Each dot sews as a small tack."
                : mode === "engraving"
                  ? "Short strokes follow the photo's grain, heavier where it's dark - a woodcut feel in running stitch."
                  : "Long evenly-spaced lines comb along the image; spacing tightens in the shadows, so the picture appears from line density alone."}
            </p>
          </SectionBox>
          <SectionBox eyebrow="stitch">
            <RangeRow label="Size" value={sizeMm} min={60} max={300} step={5} onChange={setSizeMm} fmt={(v) => fmtLen(v, units)} />
            <ThreadRow hex={threadHex} onChange={setThreadHex} />
          </SectionBox>
          {built && built.stats.realStitches > 60000 && (
            <Warning>Over 60k stitches - lower the density or shrink the size before stitching.</Warning>
          )}
        </>
      }
      preview={
        <PreviewRail built={built} colors={[threadHex]} name={NAME} emptyHint="Load a photo - its flow becomes ink.">
          {built && geometry && (
            <p className="text-[0.6875rem] text-mid tabular-nums">
              {geometry.count.toLocaleString()} {geometry.tack ? "dots" : "strokes"} · {built.stats.realStitches.toLocaleString()} stitches
            </p>
          )}
        </PreviewRail>
      }
    />
  );
}
