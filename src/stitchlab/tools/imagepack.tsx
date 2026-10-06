// Stitch Lab tool: Circle Pack - a photo rebuilt from packed dots whose SIZE
// tracks the image. Dark areas fill with big dots, highlights with small ones
// (or bare fabric), and no two dots overlap - a darkness-driven circle packing,
// the D3 "circle pack" idea turned into tone. Each dot sews as either an outline
// ring or a spiral-filled disc; the dots are travel-ordered so the machine
// hops between them efficiently.
//
// packCircles is pure and deterministic (seeded dart-throwing on a spatial
// grid). The component turns the circles into stitch paths.

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
  useDebouncedKey,
  ImagePick,
  type LumImg,
  fmtLen, useUnits,
} from "./shared";
import { pathsToStitches, resamplePath, fitPaths, routeStrokes, type PathMm } from "../lib/generators";
import { THREADS } from "../../data/threads";

// ─── Pure generator ──────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function areaLum(img: { w: number; h: number; lum: Float32Array }, x: number, y: number, r: number): number {
  // average a few taps inside the disc so a single dot reflects its whole footprint
  const { w, h, lum } = img;
  let sum = 0, cnt = 0;
  const step = Math.max(1, r / 2);
  for (let dy = -r; dy <= r; dy += step) {
    for (let dx = -r; dx <= r; dx += step) {
      if (dx * dx + dy * dy > r * r) continue;
      const xi = (x + dx) | 0, yi = (y + dy) | 0;
      if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
      sum += lum[yi * w + xi]; cnt++;
    }
  }
  return cnt ? sum / cnt : 1;
}

export type Circle = { x: number; y: number; r: number };

/**
 * Darkness-driven circle packing by dart-throwing. Each dart samples the local
 * tone, turns it into a target radius (dark -> big), and is kept only if the
 * disc clears every neighbour (a grid keyed to the max radius makes the overlap
 * test O(1)). Highlights below `floor` are left bare.
 */
export function packCircles(
  img: { w: number; h: number; lum: Float32Array },
  opts: { minR: number; maxR: number; gap: number; gamma: number; invert: boolean; floor: number; seed: number; density: number },
): Circle[] {
  const { w, h } = img;
  const { minR, maxR, gap, gamma, invert, floor } = opts;
  const rnd = mulberry32(opts.seed);
  const cell = Math.max(2, maxR + gap);
  const gw = Math.max(1, Math.ceil(w / cell));
  const gh = Math.max(1, Math.ceil(h / cell));
  const grid: number[][] = Array.from({ length: gw * gh }, () => []);
  const circles: Circle[] = [];

  const fits = (x: number, y: number, r: number): boolean => {
    const cx = Math.min(gw - 1, (x / cell) | 0);
    const cy = Math.min(gh - 1, (y / cell) | 0);
    const reach = Math.ceil((r + maxR + gap) / cell);
    for (let j = cy - reach; j <= cy + reach; j++) {
      if (j < 0 || j >= gh) continue;
      for (let i = cx - reach; i <= cx + reach; i++) {
        if (i < 0 || i >= gw) continue;
        for (const idx of grid[j * gw + i]) {
          const c = circles[idx];
          const dx = c.x - x, dy = c.y - y;
          const need = c.r + r + gap;
          if (dx * dx + dy * dy < need * need) return false;
        }
      }
    }
    return true;
  };

  // more darts than we could ever place -> tight packing; density scales the try budget
  const maxDarts = Math.round((w * h) / (minR * minR) * opts.density);
  for (let d = 0; d < maxDarts; d++) {
    const x = rnd() * w;
    const y = rnd() * h;
    const probe = areaLum(img, x, y, minR);
    let dark = invert ? probe : 1 - probe;
    dark = dark <= 0 ? 0 : Math.pow(dark, gamma);
    if (dark < floor) continue;
    const r = minR + (maxR - minR) * dark;
    if (!fits(x, y, r)) continue;
    const idx = circles.length;
    circles.push({ x, y, r });
    const cx = Math.min(gw - 1, (x / cell) | 0);
    const cy = Math.min(gh - 1, (y / cell) | 0);
    grid[cy * gw + cx].push(idx);
  }
  return circles;
}

/** One circle outline as a closed polyline (segments scale with radius). */
function ring(c: Circle): PathMm {
  const segs = Math.max(10, Math.round(c.r * 1.6));
  const out: PathMm = [];
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    out.push({ x: c.x + Math.cos(a) * c.r, y: c.y + Math.sin(a) * c.r });
  }
  return out;
}

/** Spiral-filled disc: one continuous Archimedean spiral out to the radius. */
function spiralDisc(c: Circle, pitchPx: number): PathMm {
  const out: PathMm = [];
  const turns = Math.max(1, c.r / pitchPx);
  const maxT = turns * Math.PI * 2;
  const step = Math.PI / 8;
  for (let t = 0; t <= maxT; t += step) {
    const rr = (t / maxT) * c.r;
    out.push({ x: c.x + Math.cos(t) * rr, y: c.y + Math.sin(t) * rr });
  }
  // one clean lap at full radius so the edge reads crisp
  return out.concat(ring(c));
}

// ─── Component ───────────────────────────────────────────────────────────

const DEFAULT_THREAD = THREADS.find((t) => t.code === "1000")?.hex ?? THREADS.find((t) => t.hex)?.hex ?? "#111111";

export default function CirclePackTool() {
  const units = useUnits();
  const [img, setImg] = useState<LumImg | null>(null);
  const [fileName, setFileName] = useState("");
  const [maxDot, setMaxDot] = useState(9);
  const [range, setRange] = useState(4);
  const [gamma, setGamma] = useState(1.4);
  const [invert, setInvert] = useState(false);
  const [seed, setSeed] = useState(1);
  const [fill, setFill] = useState<"ring" | "spiral">("ring");
  const [sizeMm, setSizeMm] = useState(170);
  const [stitchLen, setStitchLen] = useState(2.2);
  const [threadHex, setThreadHex] = useState(DEFAULT_THREAD);

  const genKey = useDebouncedKey([maxDot, range, gamma, invert, seed, fill], 220);
  const { paths, dots } = useMemo(() => {
    if (!img) return { paths: [] as PathMm[], dots: 0 };
    // work in image px; maxDot is the biggest dot as a fraction of the frame
    const maxR = (Math.min(img.w, img.h) * (maxDot / 100)) / 2;
    const minR = Math.max(1, maxR / Math.max(1.5, range));
    const circles = packCircles(img, {
      minR, maxR, gap: minR * 0.35, gamma, invert, floor: 0.06, seed, density: 1.1,
    });
    const pitchPx = Math.max(0.8, minR * 0.9);
    const out = circles.map((c) => (fill === "spiral" ? spiralDisc(c, pitchPx) : ring(c)));
    return { paths: out, dots: circles.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, genKey]);

  const built = useMemo(() => {
    if (paths.length === 0) return null;
    const fitted = fitPaths(paths, sizeMm);
    // travel-order the dots so the machine doesn't criss-cross the hoop
    const routed = routeStrokes(fitted, { mergeTolMm: 0.01, orOptMs: 200 }).map((p) => resamplePath(p, stitchLen, 0.4));
    return buildDesign(pathsToStitches(routed, 1), "bayside-circlepack");
  }, [paths, sizeMm, stitchLen]);

  const renderThreadMm = 0.5;

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="photo">
            <ImagePick onImage={(i, n) => { setImg(i); setFileName(n); }} fileName={fileName} longSide={200} hint="Bold shapes and clear light/dark read best." />
            {img && <p className="text-[0.75rem] text-mid">{fileName} - {img.w}×{img.h} px. Nothing uploads; it stays in your browser.</p>}
          </SectionBox>

          <SectionBox eyebrow="dots">
            <RangeRow label="Biggest dot" value={maxDot} min={4} max={16} step={0.5} onChange={setMaxDot} fmt={(v) => `${v}% of frame`} />
            <RangeRow label="Size range" value={range} min={1.5} max={8} step={0.5} onChange={setRange} fmt={(v) => `${v.toFixed(1)}×`} />
            <RangeRow label="Contrast" value={gamma} min={0.6} max={3} step={0.1} onChange={setGamma} fmt={(v) => v.toFixed(1)} />
            <RangeRow label="Variation" value={seed} min={1} max={12} step={1} onChange={setSeed} fmt={(v) => `#${v}`} />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[0.75rem] text-mid">Each dot</span>
              <ModeButtons options={[["ring", "Outline"], ["spiral", "Filled"]] as const} value={fill} onChange={setFill} small />
            </div>
            <label className="flex items-center gap-2 text-[0.75rem] text-mid">
              <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} className="accent-accent" />
              size by the light instead of the dark (for dark fabric)
            </label>
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Dots pack in tight without overlapping; each is sized by how dark the photo is beneath it. Outline sews a fast open ring; Filled spirals each dot in for solid coverage (heavier). Highlights stay bare.
            </p>
          </SectionBox>

          <SectionBox eyebrow="stitch">
            <RangeRow label="Size" value={sizeMm} min={80} max={300} step={5} onChange={setSizeMm} fmt={(v) => fmtLen(v, units)} />
            <RangeRow label="Stitch length" value={stitchLen} min={1.5} max={3.5} step={0.1} onChange={setStitchLen} fmt={(v) => `${v.toFixed(1)} mm`} />
            <ThreadRow hex={threadHex} onChange={setThreadHex} />
          </SectionBox>

          {built && built.stats.realStitches > 45000 && (
            <Warning>Over 45,000 stitches - fewer/smaller dots, use Outline, or raise the stitch length.</Warning>
          )}
        </>
      }
      preview={
        <PreviewRail built={built} colors={[threadHex]} name="bayside-circlepack" threadMm={renderThreadMm} emptyHint="Load a photo - it becomes packed dots sized by tone.">
          {built && (
            <p className="text-[0.6875rem] text-mid tabular-nums">
              {dots.toLocaleString()} dots · {built.stats.realStitches.toLocaleString()} stitches · {fill === "ring" ? "outlines" : "spiral-filled"}
            </p>
          )}
        </PreviewRail>
      }
    />
  );
}
