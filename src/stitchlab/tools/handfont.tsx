// Handwriting - your own writing as a stitchable, animatable typeface.
// Print the grid template, write a character in each cell, photograph it
// straight-on (crop to the grid edges), and each cell is skeletonized with
// the production line-tracing engine (thin + traceSkeleton) into a stroke
// glyph - the same skeleton form as the built-in Hershey faces. Then type
// anything: it renders in your hand, sews as running/bean stitch, and the
// standard rail exports the stitch file, transparent GIF, and 300 PPI PNG.
// Faces persist in this browser and export/import as small JSON files.

import { useMemo, useRef, useState } from "react";
import {
  ToolLayout,
  SectionBox,
  RangeRow,
  ModeButtons,
  DropZone,
  ThreadRow,
  PreviewRail,
  Warning,
  buildDesign,
  useDebouncedKey,
  useUnits,
  fmtLen,
  LABEL,
} from "./shared";
import { pathsToStitches, resamplePath, routeStrokes, type PathMm } from "../lib/generators";
import { normalizeContrast, thin, traceSkeleton, mergePolylines } from "../lib/lineart";
import { saveBlob } from "../lib/native";
import { THREADS } from "../../data/threads";

const NAME = "bayside-handfont";
const DEFAULT_THREAD = THREADS.find((t) => t.code === "1568")?.hex ?? "#26324d";
const STORE_KEY = "stitchlab-handfont-face";

// ── Grid layout: 9 rows × 8 cols, baseline at 72% of cell height ──
export const GRID_ROWS: string[] = [
  "ABCDEFGH", "IJKLMNOP", "QRSTUVWX", "YZabcdef",
  "ghijklmn", "opqrstuv", "wxyz0123", "456789.,", "!?'-&",
];
const ROWS = GRID_ROWS.length;
const COLS = 8;
const BASELINE_FRAC = 0.72;
const XHEIGHT_FRAC = 0.44;

export type HandGlyph = { s: PathMm[]; a: number }; // strokes (y=0 at baseline, y-down), advance
export type HandFace = { name: string; cap: number; glyphs: Record<string, HandGlyph> };

/** The printable template as an SVG string. Guides and labels are light gray
 *  so the ink threshold ignores them when the photo comes back. */
export function templateSvg(): string {
  const CELL = 120, PAD = 40;
  const W = COLS * CELL + PAD * 2, H = ROWS * CELL + PAD * 2 + 40;
  const p: string[] = [
    `<rect width="100%" height="100%" fill="white"/>`,
    `<text x="${PAD}" y="${PAD - 12}" font-family="Helvetica" font-size="16" fill="#999">Bayside handwriting template - write one character per cell, on the line. Photograph straight-on and crop to the outer box.</text>`,
    `<rect x="${PAD}" y="${PAD}" width="${COLS * CELL}" height="${ROWS * CELL}" fill="none" stroke="#000" stroke-width="4"/>`,
  ];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = PAD + c * CELL, y = PAD + r * CELL;
      p.push(`<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" fill="none" stroke="#d8d8d8" stroke-width="1"/>`);
      p.push(`<line x1="${x + 6}" y1="${y + CELL * BASELINE_FRAC}" x2="${x + CELL - 6}" y2="${y + CELL * BASELINE_FRAC}" stroke="#d0d0d0" stroke-width="1"/>`);
      p.push(`<line x1="${x + 6}" y1="${y + CELL * XHEIGHT_FRAC}" x2="${x + CELL - 6}" y2="${y + CELL * XHEIGHT_FRAC}" stroke="#e6e6e6" stroke-width="1" stroke-dasharray="3,3"/>`);
      const ch = GRID_ROWS[r][c];
      if (ch) p.push(`<text x="${x + 7}" y="${y + 18}" font-family="Helvetica" font-size="13" fill="#c0c0c0">${ch === "&" ? "&amp;" : ch === "'" ? "&#39;" : ch}</text>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${p.join("")}</svg>`;
}

/** Slice a straight-on photo of the filled grid into a stroke face. */
export function faceFromGrid(img: { w: number; h: number; lum: Float32Array }, name: string): { face: HandFace; captured: number } {
  const { w, h } = img;
  const { lum } = normalizeContrast(img);
  const cellW = w / COLS, cellH = h / ROWS;
  const face: HandFace = { name, cap: 100, glyphs: {} };
  let captured = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const ch = GRID_ROWS[r][c];
      if (!ch) continue;
      // cell region with margins: generous top margin skips the corner label
      const x0 = Math.floor(c * cellW + cellW * 0.06), x1 = Math.floor((c + 1) * cellW - cellW * 0.05);
      const y0 = Math.floor(r * cellH + cellH * 0.17), y1 = Math.floor((r + 1) * cellH - cellH * 0.04);
      const cw = x1 - x0, chh = y1 - y0;
      if (cw < 8 || chh < 8) continue;
      const binary = new Uint8Array(cw * chh);
      let ink = 0;
      for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) {
        const v = lum[(y0 + y) * w + (x0 + x)];
        if (v < 0.52) { binary[y * cw + x] = 1; ink++; }
      }
      if (ink < cw * chh * 0.004) continue; // empty cell
      const skel = thin(binary, cw, chh);
      let strokes = mergePolylines(traceSkeleton(skel, cw, chh), 2.5)
        .filter((p) => {
          let len = 0;
          for (let i = 1; i < p.length; i++) len += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
          return len > chh * 0.06;
        });
      if (!strokes.length) continue;
      strokes = routeStrokes(strokes, { mergeTolMm: 2.5, orOptMs: 20 });
      // normalize: baseline y=0 (y-down), cap height = 100 units. The template's
      // baseline sits at BASELINE_FRAC of the FULL cell; our crop starts at 17%.
      const baselinePx = (BASELINE_FRAC - 0.17) / (1 - 0.17 - 0.04) * chh;
      const scale = 100 / (baselinePx - chh * ((0.24 - 0.17) / (1 - 0.17 - 0.04))); // cap top ≈ 24% of full cell
      let mnx = Infinity, mxx = -Infinity;
      for (const p of strokes) for (const q of p) { if (q.x < mnx) mnx = q.x; if (q.x > mxx) mxx = q.x; }
      const glyph: HandGlyph = {
        s: strokes.map((p) => p.map((q) => ({ x: (q.x - mnx) * scale, y: (q.y - baselinePx) * scale }))),
        a: (mxx - mnx) * scale + 18,
      };
      face.glyphs[ch] = glyph;
      captured++;
    }
  }
  return { face, captured };
}

/** Lay out text in a captured face as mm paths, centered on the origin. */
export function layoutHand(face: HandFace, text: string, capMm: number, letterSpacing: number, lineSpacing: number): PathMm[] {
  const scale = capMm / face.cap;
  const out: PathMm[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const pitch = capMm * lineSpacing * 1.6;
  lines.forEach((line, li) => {
    let pen = 0;
    const placed: { g: HandGlyph; x: number }[] = [];
    for (const ch of line) {
      if (ch === " ") { pen += face.cap * 0.42 * scale * letterSpacing; continue; }
      const g = face.glyphs[ch] ?? face.glyphs[ch.toUpperCase()] ?? face.glyphs[ch.toLowerCase()];
      if (!g) { pen += face.cap * 0.3 * scale * letterSpacing; continue; }
      placed.push({ g, x: pen });
      pen += g.a * scale * letterSpacing;
    }
    const width = pen;
    for (const { g, x } of placed) {
      for (const s of g.s) {
        out.push(s.map((q) => ({ x: x + q.x * scale - width / 2, y: q.y * scale + li * pitch })));
      }
    }
  });
  // center vertically
  let mny = Infinity, mxy = -Infinity;
  for (const p of out) for (const q of p) { if (q.y < mny) mny = q.y; if (q.y > mxy) mxy = q.y; }
  const cy = (mny + mxy) / 2;
  return out.map((p) => p.map((q) => ({ x: q.x, y: q.y - cy })));
}

export default function HandFontTool() {
  const units = useUnits();
  const [face, setFace] = useState<HandFace | null>(() => {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) ?? "null"); } catch { return null; }
  });
  const [captured, setCaptured] = useState<number | null>(null);
  const [text, setText] = useState("hello");
  const [capMm, setCapMm] = useState(24);
  const [spacing, setSpacing] = useState(1);
  const [lineSpacing, setLineSpacing] = useState(1);
  const [weight, setWeight] = useState<1 | 3 | 5>(3);
  const [threadHex, setThreadHex] = useState(DEFAULT_THREAD);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const downloadTemplate = async () => {
    const svg = templateSvg();
    const c = document.createElement("canvas");
    const im = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    await new Promise<void>((res, rej) => { im.onload = () => res(); im.onerror = () => rej(new Error("svg")); im.src = url; });
    c.width = im.width * 2; c.height = im.height * 2;
    c.getContext("2d")!.drawImage(im, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    c.toBlob((b) => { if (b) void saveBlob(b, "bayside-handwriting-template.png"); }, "image/png");
  };

  const loadPhoto = async (file: File) => {
    setErr(null);
    try {
      const url = URL.createObjectURL(file);
      const im = new Image();
      await new Promise<void>((res, rej) => { im.onload = () => res(); im.onerror = () => rej(new Error("img")); im.src = url; });
      const W = 1400;
      const s = Math.min(1, W / im.width);
      const c = document.createElement("canvas");
      c.width = Math.round(im.width * s); c.height = Math.round(im.height * s);
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(im, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const lum = new Float32Array(c.width * c.height);
      for (let i = 0; i < lum.length; i++) lum[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
      const { face: f, captured: n } = faceFromGrid({ w: c.width, h: c.height, lum }, file.name.replace(/\.[a-z]+$/i, ""));
      if (n < 3) { setErr("Only found ink in a couple of cells - crop the photo to the grid's outer box and keep it straight-on."); return; }
      setFace(f); setCaptured(n);
      try { localStorage.setItem(STORE_KEY, JSON.stringify(f)); } catch { /* full */ }
    } catch {
      setErr("Couldn't read that photo.");
    }
  };

  const genKey = useDebouncedKey([text, capMm, spacing, lineSpacing, weight, face?.name, captured], 220);
  const built = useMemo(() => {
    if (!face || !text.trim()) return null;
    const strokes = layoutHand(face, text, capMm, spacing, lineSpacing);
    if (!strokes.length) return null;
    const paths = routeStrokes(strokes).map((p) => resamplePath(p, 1.8, 0.3));
    return buildDesign(pathsToStitches(paths, weight), NAME);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genKey, face]);

  const missing = useMemo(() => {
    if (!face) return "";
    const need = new Set<string>();
    for (const ch of text) {
      if (ch === " " || ch === "\n") continue;
      if (!face.glyphs[ch] && !face.glyphs[ch.toUpperCase()] && !face.glyphs[ch.toLowerCase()]) need.add(ch);
    }
    return [...need].join(" ");
  }, [face, text]);

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="capture">
            <button onClick={() => void downloadTemplate()}
              className="border border-hairline bg-bg px-3 py-1.5 text-[0.8125rem] text-fg hover:bg-card">
              1 · Download the template
            </button>
            <DropZone onFile={(f) => void loadPhoto(f)}>
            <label className="block border border-dashed border-hairline hover:border-accent px-3 py-2 text-center text-[0.8125rem] text-mid cursor-pointer">
              2 · Upload a photo of your filled grid - or drop it here →
              <input ref={fileRef} type="file" accept="image/*" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; e.currentTarget.value = ""; if (f) void loadPhoto(f); }} />
            </label>
            </DropZone>
            {face && (
              <p className="text-[0.75rem] text-mid">
                Face “{face.name}” · {Object.keys(face.glyphs).length} characters{captured !== null ? ` (${captured} captured this time)` : ""}
              </p>
            )}
            {err && <Warning>{err}</Warning>}
            <div className="flex flex-wrap gap-1.5">
              <button disabled={!face}
                onClick={() => { if (face) void saveBlob(new Blob([JSON.stringify(face)], { type: "application/json" }), `${face.name || "handwriting"}-face.json`); }}
                className="border border-hairline bg-bg px-2.5 py-1 text-[0.75rem] text-fg disabled:opacity-40 hover:bg-card">
                Export face
              </button>
              <label className="cursor-pointer border border-hairline bg-bg px-2.5 py-1 text-[0.75rem] text-fg hover:bg-card">
                Import face
                <input type="file" accept=".json" className="hidden" onChange={async (e) => {
                  const f = e.target.files?.[0]; e.currentTarget.value = "";
                  if (!f) return;
                  try {
                    const parsed = JSON.parse(await f.text()) as HandFace;
                    if (!parsed.glyphs) throw new Error("bad");
                    setFace(parsed); setCaptured(null);
                    localStorage.setItem(STORE_KEY, JSON.stringify(parsed));
                  } catch { setErr("That file isn't a handwriting face."); }
                }} />
              </label>
            </div>
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Print it, write one character per cell sitting on the line, photograph it
              straight-on, and crop to the outer box before uploading. Pen or fine
              marker beats pencil.
            </p>
          </SectionBox>
          <SectionBox eyebrow="type">
            <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={200} rows={2}
              className="w-full border border-hairline bg-bg text-fg px-2.5 py-2 text-[1rem] font-serif leading-snug resize-y" />
            {missing && <p className="text-[0.6875rem] text-mid">Not in your grid yet: {missing}</p>}
            <RangeRow label="Cap height" value={capMm} min={8} max={60} step={1} onChange={setCapMm} fmt={(v) => fmtLen(v, units)} />
            <RangeRow label="Letter spacing" value={spacing} min={0.7} max={1.8} step={0.05} onChange={setSpacing} fmt={(v) => `×${v.toFixed(2)}`} />
            {text.includes("\n") && (
              <RangeRow label="Line spacing" value={lineSpacing} min={0.8} max={2} step={0.05} onChange={setLineSpacing} fmt={(v) => `×${v.toFixed(2)}`} />
            )}
            <div>
              <div className={`${LABEL} mb-1.5`}>Weight</div>
              <ModeButtons small options={[[1, "Single"], [3, "Bean ×3"], [5, "Bean ×5"]] as [1 | 3 | 5, string][]} value={weight} onChange={setWeight} />
            </div>
            <ThreadRow hex={threadHex} onChange={setThreadHex} />
          </SectionBox>
          {built && built.stats.realStitches > 60000 && (
            <Warning>Over 60k stitches - shorter text or a smaller cap height before stitching.</Warning>
          )}
        </>
      }
      preview={
        <PreviewRail built={built} colors={[threadHex]} name={NAME}
          emptyHint={face ? "Type a word - it renders in your handwriting." : "Capture your handwriting first: template → write → photograph → upload."} />
      }
    />
  );
}
