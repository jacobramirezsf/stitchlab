// Stitch Lab tool: ASCII Art - the FIGlet idea. Type a word (or drop a photo)
// and it's rebuilt out of typed characters, densest where the source is dark.
// Copy the text for a caption, a README banner, a chat - or stitch it: every
// filled cell becomes a dot, travel-ordered into a running-stitch dot-matrix of
// the art.
//
// Rasterizing text needs a canvas, so the luminance grid is built in the
// component (client-only); asciiFromGrid / dotsFromGrid are pure.

import { useMemo, useRef, useState } from "react";
import {
  ToolLayout,
  SectionBox,
  RangeRow,
  ModeButtons,
  ThreadRow,
  PreviewRail,
  buildDesign,
  ImagePick,
  type LumImg,
  fmtLen, useUnits,
} from "./shared";
import { pathsToStitches, resamplePath, fitPaths, routeStrokes, type PathMm } from "../lib/generators";
import { THREADS } from "../../data/threads";

// ─── Pure core ─────────────────────────────────────────────────────────────

const RAMPS: Record<string, string> = {
  blocks: " .:-=+*#%@",
  fine: " .'`^\",:;Il!i~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
  dots: " ·:∴∷▪▩█",
  hash: "  ..::##@@",
};

/** Build the character grid from a luminance grid (0..1, row-major). */
export function asciiFromGrid(lum: Float32Array, cols: number, rows: number, ramp: string, invert: boolean): string[] {
  const chars = RAMPS[ramp] ?? RAMPS.blocks;
  const last = chars.length - 1;
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      const l = lum[r * cols + c];
      let dark = invert ? l : 1 - l;
      dark = dark < 0 ? 0 : dark > 1 ? 1 : dark;
      line += chars[Math.round(dark * last)];
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  // trim fully-blank leading/trailing rows
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

/** One dot per inked cell, in mm-ish grid units (fit later). */
export function dotsFromGrid(lum: Float32Array, cols: number, rows: number, invert: boolean, floor: number): PathMm[] {
  const out: PathMm[] = [];
  const cellW = 1, cellH = 2; // monospace cells read ~2:1 tall
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const l = lum[r * cols + c];
      const dark = invert ? l : 1 - l;
      if (dark < floor) continue;
      const x = c * cellW, y = r * cellH;
      const rad = 0.28 + dark * 0.34; // darker cell = slightly fatter dot
      // a tiny square stitch-out reads better than a single point
      out.push([
        { x: x - rad, y: y - rad }, { x: x + rad, y: y - rad },
        { x: x + rad, y: y + rad }, { x: x - rad, y: y + rad }, { x: x - rad, y: y - rad },
      ]);
    }
  }
  return out;
}

/** Rasterize a string of text to a luminance grid via an offscreen canvas. */
function textToGrid(text: string, cols: number): { lum: Float32Array; cols: number; rows: number } | null {
  const lines = text.split("\n");
  const cvs = document.createElement("canvas");
  const ctx = cvs.getContext("2d");
  if (!ctx) return null;
  const fontPx = 100;
  ctx.font = `700 ${fontPx}px "Arial Black", Impact, system-ui, sans-serif`;
  let textW = 1;
  for (const ln of lines) textW = Math.max(textW, ctx.measureText(ln || " ").width);
  const lineH = fontPx * 1.1;
  const W = Math.ceil(textW) + 40;
  const H = Math.ceil(lineH * lines.length) + 40;
  cvs.width = W; cvs.height = H;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#000";
  ctx.textBaseline = "top";
  ctx.font = `700 ${fontPx}px "Arial Black", Impact, system-ui, sans-serif`;
  lines.forEach((ln, i) => ctx.fillText(ln, 20, 20 + i * lineH));

  const rows = Math.max(1, Math.round((cols * (H / W)) * 0.5)); // 0.5 for cell aspect
  const grid = new Float32Array(cols * rows);
  const img = ctx.getImageData(0, 0, W, H).data;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // average-sample the source block for this cell
      const x0 = Math.floor((c / cols) * W), x1 = Math.floor(((c + 1) / cols) * W);
      const y0 = Math.floor((r / rows) * H), y1 = Math.floor(((r + 1) / rows) * H);
      let sum = 0, cnt = 0;
      for (let y = y0; y < Math.max(y0 + 1, y1); y += 2) {
        for (let x = x0; x < Math.max(x0 + 1, x1); x += 2) {
          const p = (y * W + x) * 4;
          sum += (img[p] * 0.299 + img[p + 1] * 0.587 + img[p + 2] * 0.114) / 255;
          cnt++;
        }
      }
      grid[r * cols + c] = cnt ? sum / cnt : 1;
    }
  }
  return { lum: grid, cols, rows };
}

/** Resample an uploaded photo's luminance to a cols×rows grid. */
function imgToGrid(img: LumImg, cols: number): { lum: Float32Array; cols: number; rows: number } {
  const rows = Math.max(1, Math.round((cols * (img.h / img.w)) * 0.5));
  const grid = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const sx = Math.min(img.w - 1, Math.floor((c + 0.5) / cols * img.w));
      const sy = Math.min(img.h - 1, Math.floor((r + 0.5) / rows * img.h));
      grid[r * cols + c] = img.lum[sy * img.w + sx];
    }
  }
  return { lum: grid, cols, rows };
}

// ─── Component ───────────────────────────────────────────────────────────

const DEFAULT_THREAD = THREADS.find((t) => t.code === "1000")?.hex ?? THREADS.find((t) => t.hex)?.hex ?? "#111111";

export default function AsciiArtTool() {
  const units = useUnits();
  const [mode, setMode] = useState<"text" | "photo">("text");
  const [text, setText] = useState("BAYSIDE");
  const [img, setImg] = useState<LumImg | null>(null);
  const [fileName, setFileName] = useState("");
  const [cols, setCols] = useState(60);
  const [ramp, setRamp] = useState<keyof typeof RAMPS>("blocks");
  const [invert, setInvert] = useState(false);
  const [sizeMm, setSizeMm] = useState(180);
  const [stitchLen, setStitchLen] = useState(2);
  const [threadHex, setThreadHex] = useState(DEFAULT_THREAD);
  const [copied, setCopied] = useState(false);

  const grid = useMemo(() => {
    if (mode === "text") return text.trim() ? textToGrid(text, cols) : null;
    return img ? imgToGrid(img, cols) : null;
  }, [mode, text, img, cols]);

  const lines = useMemo(
    () => (grid ? asciiFromGrid(grid.lum, grid.cols, grid.rows, ramp, invert) : []),
    [grid, ramp, invert],
  );
  const asciiText = lines.join("\n");

  const built = useMemo(() => {
    if (!grid) return null;
    const dots = dotsFromGrid(grid.lum, grid.cols, grid.rows, invert, 0.35);
    if (dots.length < 2) return null;
    const fitted = fitPaths(dots, sizeMm);
    const routed = routeStrokes(fitted, { mergeTolMm: 0.01, orOptMs: 200 }).map((p) => resamplePath(p, stitchLen, 0.4));
    return buildDesign(pathsToStitches(routed, 1), "bayside-ascii");
  }, [grid, invert, sizeMm, stitchLen]);

  const copyRef = useRef<number | null>(null);
  const copy = () => {
    navigator.clipboard?.writeText(asciiText).then(() => {
      setCopied(true);
      if (copyRef.current) window.clearTimeout(copyRef.current);
      copyRef.current = window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  // Render the ASCII itself to a crisp monochrome PNG (dark glyphs on white, or
  // the reverse when inverted so it reads on a dark background).
  const downloadPng = () => {
    if (!lines.length) return;
    const cvs = document.createElement("canvas");
    const ctx = cvs.getContext("2d"); if (!ctx) return;
    const cell = 12; // px per character cell (crisp at 1:1)
    const font = `${cell}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
    ctx.font = font;
    const chW = ctx.measureText("M").width || cell * 0.6;
    const pad = cell;
    const maxLen = lines.reduce((m, l) => Math.max(m, l.length), 0);
    const W = Math.ceil(maxLen * chW + pad * 2);
    const H = Math.ceil(lines.length * cell + pad * 2);
    cvs.width = W; cvs.height = H;
    ctx.fillStyle = invert ? "#111318" : "#ffffff";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = invert ? "#f2f0ea" : "#111318";
    ctx.font = font;
    ctx.textBaseline = "top";
    lines.forEach((ln, i) => ctx.fillText(ln, pad, pad + i * cell));
    const a = document.createElement("a");
    a.href = cvs.toDataURL("image/png");
    a.download = "bayside-ascii.png";
    a.click();
  };

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="source">
            <ModeButtons options={[["text", "Type text"], ["photo", "From a photo"]] as const} value={mode} onChange={setMode} />
            {mode === "text" ? (
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={2}
                placeholder="Type a word or two…"
                className="w-full bg-card border border-hairline px-2 py-1.5 text-[0.875rem] resize-y"
              />
            ) : (
              <>
                <ImagePick onImage={(i, n) => { setImg(i); setFileName(n); }} fileName={fileName} longSide={200} hint="Choose or drop a photo - bold, simple images read best small." />
                {img && <p className="text-[0.75rem] text-mid">{fileName} - {img.w}×{img.h} px.</p>}
              </>
            )}
          </SectionBox>

          <SectionBox eyebrow="ascii">
            <RangeRow label="Width" value={cols} min={20} max={140} step={2} onChange={setCols} fmt={(v) => `${v} chars`} />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[0.75rem] text-mid">Character set</span>
              <ModeButtons options={[["blocks", "Blocks"], ["fine", "Fine"], ["hash", "Hash"]] as const} value={ramp === "dots" ? "blocks" : ramp} onChange={(v) => setRamp(v as keyof typeof RAMPS)} small />
            </div>
            <label className="flex items-center gap-2 text-[0.75rem] text-mid">
              <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} className="accent-accent" />
              invert (for dark backgrounds)
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={copy}
                disabled={!asciiText}
                className="border border-hairline px-3 py-1.5 text-[0.75rem] text-mid hover:border-fg hover:text-fg disabled:opacity-40"
              >
                {copied ? "Copied ✓" : "Copy text"}
              </button>
              <button
                type="button"
                onClick={downloadPng}
                disabled={!asciiText}
                className="border border-hairline px-3 py-1.5 text-[0.75rem] text-mid hover:border-fg hover:text-fg disabled:opacity-40"
              >
                Download PNG
              </button>
            </div>
          </SectionBox>

          <SectionBox eyebrow="stitch (dot-matrix)">
            <RangeRow label="Stitched size" value={sizeMm} min={80} max={300} step={5} onChange={setSizeMm} fmt={(v) => fmtLen(v, units)} />
            <RangeRow label="Stitch length" value={stitchLen} min={1.5} max={3.5} step={0.1} onChange={setStitchLen} fmt={(v) => `${v.toFixed(1)} mm`} />
            <ThreadRow hex={threadHex} onChange={setThreadHex} />
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Every inked character becomes a small stitched block, routed into a running-stitch dot-matrix - the art rendered in thread. Keep the width modest so the dots don't get too fine to sew.
            </p>
          </SectionBox>
        </>
      }
      preview={
        <div className="flex flex-col gap-4">
          <div className="border border-hairline bg-card overflow-auto">
            <pre className="text-fg leading-[1.0] p-3 m-0 whitespace-pre" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.5rem" }}>
              {asciiText || "Type a word - it becomes ASCII art."}
            </pre>
          </div>
          <PreviewRail built={built} colors={[threadHex]} name="bayside-ascii" threadMm={0.6} emptyHint="The dot-matrix stitch version shows here.">
            {built && (
              <p className="text-[0.6875rem] text-mid tabular-nums">
                {lines.length} rows · {built.stats.realStitches.toLocaleString()} stitches
              </p>
            )}
          </PreviewRail>
        </div>
      }
    />
  );
}
