// Stitch Lab tool: Cross-Hatch - a photo shaded the way a pen sketch is, with
// layers of straight hatching. The lightest tones get no lines; as the image
// darkens, more hatch layers switch on, each at its own angle, so shadows build
// up into dense cross-hatching. It's the classic plotter/ink-shading look, and
// every layer is a set of long parallel runs the machine sews fast.
//
// hatchShade is pure and deterministic. The component routes the layers to keep
// travel down and turns them into stitches.

import { useMemo, useState } from "react";
import {
  ToolLayout,
  SectionBox,
  RangeRow,
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

function sampleLum(img: { w: number; h: number; lum: Float32Array }, x: number, y: number): number {
  const { w, h, lum } = img;
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 1;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = lum[y0 * w + x0], b = lum[y0 * w + x1], c = lum[y1 * w + x0], dd = lum[y1 * w + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + dd * fx) * fy;
}

// hatch angles switched on in this order as the image gets darker
const ANGLES = [45, -45, 0, 90, 22.5, -22.5];

/**
 * Layered tonal hatching. For each active layer k (0..layers-1) a field of
 * parallel lines at ANGLES[k] is swept; a line only inks where the local
 * darkness clears that layer's threshold ((k+1)/(layers+1)), so darker regions
 * accumulate more crossing layers. Returns one polyline per continuous run.
 */
export function hatchShade(
  img: { w: number; h: number; lum: Float32Array },
  opts: { layers: number; spacingPx: number; gamma: number; invert: boolean; stepPx?: number },
): PathMm[] {
  const { w, h } = img;
  const spacing = Math.max(1.2, opts.spacingPx);
  const step = Math.max(0.75, opts.stepPx ?? Math.min(2, spacing / 2));
  const layers = Math.max(1, Math.min(ANGLES.length, opts.layers | 0));
  const cx = w / 2, cy = h / 2;
  const R = Math.hypot(w, h) / 2 + spacing;
  const out: PathMm[] = [];

  const darkAt = (x: number, y: number): number => {
    const l = sampleLum(img, x, y);
    const d = opts.invert ? l : 1 - l;
    return d <= 0 ? 0 : Math.pow(d, opts.gamma);
  };

  for (let k = 0; k < layers; k++) {
    const thresh = (k + 1) / (layers + 1);
    const rad = (ANGLES[k] * Math.PI) / 180;
    const dir = { x: Math.cos(rad), y: Math.sin(rad) };
    const perp = { x: -Math.sin(rad), y: Math.cos(rad) };
    for (let off = -R; off <= R; off += spacing) {
      const bx = cx + perp.x * off, by = cy + perp.y * off;
      let seg: PathMm = [];
      for (let t = -R; t <= R; t += step) {
        const sx = bx + dir.x * t, sy = by + dir.y * t;
        if (sx < -1 || sy < -1 || sx > w || sy > h || darkAt(sx, sy) < thresh) {
          if (seg.length >= 2) out.push(seg);
          seg = [];
          continue;
        }
        seg.push({ x: sx, y: sy });
      }
      if (seg.length >= 2) out.push(seg);
    }
  }
  return out;
}

// ─── Component ───────────────────────────────────────────────────────────

const DEFAULT_THREAD = THREADS.find((t) => t.code === "1000")?.hex ?? THREADS.find((t) => t.hex)?.hex ?? "#111111";

export default function CrossHatchTool() {
  const units = useUnits();
  const [img, setImg] = useState<LumImg | null>(null);
  const [fileName, setFileName] = useState("");
  const [layers, setLayers] = useState(4);
  const [lines, setLines] = useState(60);
  const [gamma, setGamma] = useState(1.3);
  const [invert, setInvert] = useState(false);
  const [sizeMm, setSizeMm] = useState(170);
  const [stitchLen, setStitchLen] = useState(2.2);
  const [threadHex, setThreadHex] = useState(DEFAULT_THREAD);

  const spacingMm = sizeMm / lines;

  const genKey = useDebouncedKey([layers, lines, gamma, invert], 200);
  const segments = useMemo(() => {
    if (!img) return [];
    const spacingPx = Math.max(2, Math.min(img.w, img.h) / lines);
    return hatchShade(img, { layers, spacingPx, gamma, invert });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, genKey]);

  const built = useMemo(() => {
    if (segments.length === 0) return null;
    const fitted = fitPaths(segments, sizeMm);
    const routed = routeStrokes(fitted, { mergeTolMm: 0.4, orOptMs: 220 }).map((p) => resamplePath(p, stitchLen, 0.4));
    return buildDesign(pathsToStitches(routed, 1), "bayside-crosshatch");
  }, [segments, sizeMm, stitchLen]);

  const renderThreadMm = Math.min(0.75, Math.max(0.5, spacingMm * 0.42));

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="photo">
            <ImagePick onImage={(i, n) => { setImg(i); setFileName(n); }} fileName={fileName} longSide={240} hint="Portraits and strong-light subjects shade beautifully." />
            {img && <p className="text-[0.75rem] text-mid">{fileName} - {img.w}×{img.h} px. Nothing uploads; it stays in your browser.</p>}
          </SectionBox>

          <SectionBox eyebrow="shading">
            <RangeRow label="Hatch layers" value={layers} min={1} max={6} step={1} onChange={setLayers} fmt={(v) => `${v} · ${v === 1 ? "one direction" : "cross-hatched"}`} />
            <RangeRow label="Fineness" value={lines} min={24} max={110} step={2} onChange={setLines} fmt={(v) => `${v} lines · ${(sizeMm / v).toFixed(1)}mm`} />
            <RangeRow label="Contrast" value={gamma} min={0.6} max={3} step={0.1} onChange={setGamma} fmt={(v) => v.toFixed(1)} />
            <label className="flex items-center gap-2 text-[0.75rem] text-mid">
              <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} className="accent-accent" />
              hatch the light instead of the dark (for dark fabric)
            </label>
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Highlights stay bare; midtones get one or two passes; the darkest areas stack every layer into solid cross-hatching. More layers = deeper blacks and more crossing angles; finer = more, closer lines. The preview draws real ~{renderThreadMm.toFixed(2)} mm thread.
            </p>
          </SectionBox>

          <SectionBox eyebrow="stitch">
            <RangeRow label="Size" value={sizeMm} min={80} max={300} step={5} onChange={setSizeMm} fmt={(v) => fmtLen(v, units)} />
            <RangeRow label="Stitch length" value={stitchLen} min={1.5} max={3.5} step={0.1} onChange={setStitchLen} fmt={(v) => `${v.toFixed(1)} mm`} />
            <ThreadRow hex={threadHex} onChange={setThreadHex} />
          </SectionBox>

          {built && built.stats.realStitches > 45000 && (
            <Warning>Over 45,000 stitches - fewer layers, coarser lines, or a longer stitch.</Warning>
          )}
        </>
      }
      preview={
        <PreviewRail built={built} colors={[threadHex]} name="bayside-crosshatch" threadMm={renderThreadMm} emptyHint="Load a photo - it becomes layered pencil-style hatching.">
          {built && (
            <p className="text-[0.6875rem] text-mid tabular-nums">
              {layers} layer{layers === 1 ? "" : "s"} · {segments.length.toLocaleString()} runs · {built.stats.realStitches.toLocaleString()} stitches
            </p>
          )}
        </PreviewRail>
      }
    />
  );
}
