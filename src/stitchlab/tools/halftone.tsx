// Stitch Lab tool: Halftone - a photo as modulated wavy lines. Parallel scan
// lines sweep the image; each one wiggles with an amplitude set by the local
// darkness, so shadows swell into thick ribbons and highlights stay flat (and
// bare fabric, where the line lifts off entirely). It's the "single-line
// halftone" / waveform-portrait look - graphic, bold, and kind to the machine
// because each line is one continuous run, trims only between rows.
//
// halftoneWaves is pure and deterministic (bilinear sampling, no DOM); the
// component loads the photo and renders the re-parsed DST.

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
import { pathsToStitches, resamplePath, fitPaths, type PathMm } from "../lib/generators";
import { THREADS } from "../../data/threads";

// ─── Pure generator ──────────────────────────────────────────────────────

/** Bilinear luminance sample (0..1). Out-of-bounds reads as white (1). */
function sampleLum(img: { w: number; h: number; lum: Float32Array }, x: number, y: number): number {
  const { w, h, lum } = img;
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 1;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = lum[y0 * w + x0], b = lum[y0 * w + x1], c = lum[y1 * w + x0], d = lum[y1 * w + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/**
 * Wavy-line halftone in image-pixel space (y-down). Parallel lines at `angleDeg`
 * spaced `spacingPx` apart; each samples darkness d = (invert ? lum : 1−lum)^gamma
 * and displaces perpendicular by up to `spacingPx·ampFrac·d·sin(travel/waveLenPx·2π)`.
 * Lines break wherever d falls below `floor`, so highlights leave bare fabric.
 * Pure and deterministic. Returns one polyline per continuous inked run.
 */
export function halftoneWaves(
  img: { w: number; h: number; lum: Float32Array },
  opts: {
    spacingPx: number;
    ampFrac?: number;
    waveLenPx?: number;
    angleDeg?: number;
    gamma?: number;
    invert?: boolean;
    floor?: number;
    stepPx?: number;
  },
): PathMm[] {
  const { w, h } = img;
  const spacing = Math.max(1, opts.spacingPx);
  const ampFrac = opts.ampFrac ?? 0.5;
  const waveLen = Math.max(2, opts.waveLenPx ?? spacing * 1.6);
  const gamma = opts.gamma ?? 1;
  const invert = opts.invert ?? false;
  const floor = opts.floor ?? 0.06;
  const step = Math.max(0.75, opts.stepPx ?? Math.min(2, waveLen / 8));
  const maxAmp = spacing * 0.5 * ampFrac;

  const rad = (opts.angleDeg ?? 0) * Math.PI / 180;
  const dir = { x: Math.cos(rad), y: Math.sin(rad) };
  const perp = { x: -Math.sin(rad), y: Math.cos(rad) };
  const cx = w / 2, cy = h / 2;
  const R = Math.hypot(w, h) / 2 + spacing;
  const k = (Math.PI * 2) / waveLen;

  const out: PathMm[] = [];
  for (let off = -R; off <= R; off += spacing) {
    const bx = cx + perp.x * off;
    const by = cy + perp.y * off;
    let seg: PathMm = [];
    for (let t = -R; t <= R; t += step) {
      const sx = bx + dir.x * t;
      const sy = by + dir.y * t;
      // inside the image? (with a small margin so lines end at the edge)
      if (sx < -1 || sy < -1 || sx > w || sy > h) {
        if (seg.length >= 2) out.push(seg);
        seg = [];
        continue;
      }
      const lum = sampleLum(img, sx, sy);
      let d = invert ? lum : 1 - lum;
      d = d <= 0 ? 0 : Math.pow(d, gamma);
      if (d < floor) {
        if (seg.length >= 2) out.push(seg);
        seg = [];
        continue;
      }
      const disp = maxAmp * d * Math.sin(t * k);
      seg.push({ x: sx + perp.x * disp, y: sy + perp.y * disp });
    }
    if (seg.length >= 2) out.push(seg);
  }
  return out;
}

// ─── Component ───────────────────────────────────────────────────────────

const DEFAULT_THREAD = THREADS.find((t) => t.code === "1000")?.hex ?? THREADS.find((t) => t.hex)?.hex ?? "#111111";

export default function HalftoneTool() {
  const units = useUnits();
  const [img, setImg] = useState<LumImg | null>(null);
  const [fileName, setFileName] = useState("");
  const [lines, setLines] = useState(46);
  const [amp, setAmp] = useState(0.55);
  const [waveLen, setWaveLen] = useState(1.6);
  const [angle, setAngle] = useState(0);
  const [gamma, setGamma] = useState(1.3);
  const [invert, setInvert] = useState(false);
  const [sizeMm, setSizeMm] = useState(150);
  const [stitchLen, setStitchLen] = useState(2);
  const [bold, setBold] = useState(false);
  const [threadHex, setThreadHex] = useState(DEFAULT_THREAD);

  // Physical line spacing drives how bold the sewn result reads. A 40wt line is
  // ~0.5mm wide with loft, so preview at that width to predict the stitch-out
  // (thinner rendering flatters the design with detail the machine won't hold).
  const spacingMm = sizeMm / lines;
  const renderThreadMm = bold ? 0.75 : Math.min(0.85, Math.max(0.5, spacingMm * 0.42));

  const genKey = useDebouncedKey([lines, amp, waveLen, angle, gamma, invert], 170);
  const segments = useMemo(() => {
    if (!img) return [];
    const spacingPx = Math.max(2, Math.min(img.w, img.h) / lines);
    return halftoneWaves(img, {
      spacingPx,
      ampFrac: amp,
      waveLenPx: spacingPx * waveLen,
      angleDeg: angle,
      gamma,
      invert,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, genKey]);

  const built = useMemo(() => {
    if (segments.length === 0) return null;
    const fitted = fitPaths(segments, sizeMm).map((p) => resamplePath(p, stitchLen, 0.4));
    // Bold = a second offset pass over each line, so it sews as a heavier band
    // (the dark, graphic look) instead of a single thin run.
    return buildDesign(pathsToStitches(fitted, bold ? 3 : 1), "bayside-halftone");
  }, [segments, sizeMm, stitchLen, bold]);

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="photo">
            <ImagePick onImage={(i, n) => { setImg(i); setFileName(n); }} fileName={fileName} longSide={240} hint="A high-contrast face or logo reads best." />
            {img && <p className="text-[0.75rem] text-mid">{fileName} - {img.w}×{img.h} px. Nothing uploads; it stays in your browser.</p>}
          </SectionBox>

          <SectionBox eyebrow="halftone">
            <RangeRow label="Lines" value={lines} min={16} max={72} step={1} onChange={setLines} fmt={(v) => `${v} · ${(sizeMm / v).toFixed(1)}mm apart`} />
            <RangeRow label="Amplitude" value={amp} min={0.15} max={0.9} step={0.05} onChange={setAmp} fmt={(v) => `${Math.round(v * 100)}%`} />
            <RangeRow label="Wave length" value={waveLen} min={0.8} max={4} step={0.1} onChange={setWaveLen} fmt={(v) => `×${v.toFixed(1)}`} />
            <RangeRow label="Angle" value={angle} min={0} max={180} step={5} onChange={setAngle} fmt={(v) => `${v}°`} />
            <RangeRow label="Contrast" value={gamma} min={0.6} max={3} step={0.1} onChange={setGamma} fmt={(v) => v.toFixed(1)} />
            <label className="flex items-center gap-2 text-[0.75rem] text-mid">
              <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} className="accent-accent" />
              stitch the light instead of the dark (for dark fabric)
            </label>
            <label className="flex items-center gap-2 text-[0.75rem] text-mid">
              <input type="checkbox" checked={bold} onChange={(e) => setBold(e.target.checked)} className="accent-accent" />
              bold lines (triple pass - heavier, graphic)
            </label>
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Each line swells where the photo is dark and lifts off the fabric where it's light. More lines = finer; higher amplitude = bolder shadows; angle turns the whole grain. The preview draws real ~{renderThreadMm.toFixed(2)} mm thread so it reads like the actual stitch-out, not thinner.
            </p>
          </SectionBox>

          <SectionBox eyebrow="stitch">
            <RangeRow label="Size" value={sizeMm} min={60} max={300} step={5} onChange={setSizeMm} fmt={(v) => fmtLen(v, units)} />
            <RangeRow label="Stitch length" value={stitchLen} min={1.5} max={3.5} step={0.1} onChange={setStitchLen} fmt={(v) => `${v.toFixed(1)} mm`} />
            <ThreadRow hex={threadHex} onChange={setThreadHex} />
          </SectionBox>

          {built && built.stats.realStitches > 45000 && (
            <Warning>Over 45,000 stitches - drop the line count or raise the stitch length.</Warning>
          )}
        </>
      }
      preview={
        <PreviewRail built={built} colors={[threadHex]} name="bayside-halftone" threadMm={renderThreadMm} emptyHint="Load a photo - it becomes wavy halftone lines.">
          {built && (
            <p className="text-[0.6875rem] text-mid tabular-nums">
              {segments.length} line{segments.length === 1 ? "" : "s"} · {built.stats.realStitches.toLocaleString()} stitches · {spacingMm.toFixed(1)} mm apart · trims only between rows
            </p>
          )}
        </PreviewRail>
      }
    />
  );
}
