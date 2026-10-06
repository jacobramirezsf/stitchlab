// AnimExport - stitch-out animation export for ANY tool's Built design.
// Frames are the design revealing itself stitch by stitch (renderPattern's
// upTo) on a TRANSPARENT canvas. GIF keeps transparency everywhere; video
// keeps it in WebM (Chrome et al.) and falls back to white behind MP4
// (Safari can't carry alpha). Optional Are.na fit keeps GIFs ≤25 MB by
// thinning frames first, shrinking resolution only as a last resort.
// Mounted automatically by PreviewRail, so every standard tool has it.
// NOTE: imports from shared are type-only - PreviewRail imports this file,
// so a runtime import of shared would be a cycle.

import { useRef, useState } from "react";
import type { Built } from "./shared";
import { fitTransform, renderPattern } from "../lib/render";
import { CMD, type ParsedPattern, type Stitch } from "../lib/pattern";
import { encodeGifFit } from "../lib/gif";
import { canvasToPngPpi, mmToPx } from "../lib/png";
import { saveBlob } from "../lib/native";

/** Reorder the reveal to reading order (left to right, top lines first)
 *  WITHOUT touching the real file: runs of stitches are kept intact and
 *  sorted by position - within each color block, so colors stay correct.
 *  Presentation-only; the downloadable DST/PES is unchanged. */
export function readingOrderPattern(p: ParsedPattern): ParsedPattern {
  const out: Stitch[] = [];
  let block: Stitch[][] = [];
  let run: Stitch[] = [];
  const flushRun = () => { if (run.length) { block.push(run); run = []; } };
  const flushBlock = (boundary?: Stitch) => {
    flushRun();
    block.sort((a, b) => {
      const key = (r: Stitch[]) => {
        let mx = Infinity, my = Infinity;
        for (const st of r) { if (st.x < mx) mx = st.x; if (st.y < my) my = st.y; }
        return [mx, my] as const;
      };
      const [ax, ay] = key(a), [bx, by] = key(b);
      return ax - bx || ay - by;
    });
    for (const r of block) {
      r.forEach((st, i) => out.push({ x: st.x, y: st.y, cmd: i === 0 ? CMD.JUMP : CMD.STITCH }));
    }
    block = [];
    if (boundary) out.push(boundary);
  };
  for (const st of p.stitches) {
    if (st.cmd === CMD.COLOR_CHANGE || st.cmd === CMD.STOP || st.cmd === CMD.END) { flushBlock(st); continue; }
    if (st.cmd === CMD.JUMP || st.cmd === CMD.TRIM) { flushRun(); }
    if (st.cmd === CMD.STITCH || st.cmd === CMD.JUMP) run.push(st);
  }
  flushBlock();
  return { ...p, stitches: out };
}


/** Writing order: strokes sorted by line then left-to-right. Lines are found
 *  by quantizing each run's center-y against the KNOWN line pitch (in pattern
 *  units, 0.1mm) - y-clustering fails when ascenders/descenders of adjacent
 *  lines overlap. Pass the pitch the layout actually used. */
export function writingOrderPattern(p: ParsedPattern, pitchUnits: number, lines: number): ParsedPattern {
  const base = readingOrderPattern(p);
  if (lines <= 1) return base;
  type Run = { st: Stitch[]; minX: number; cy: number };
  const runs: Run[] = [];
  let cur: Stitch[] = [];
  const flush = () => {
    if (!cur.length) return;
    let minX = Infinity, minY = Infinity, maxY = -Infinity;
    for (const q of cur) { if (q.x < minX) minX = q.x; if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y; }
    runs.push({ st: cur, minX, cy: (minY + maxY) / 2 });
    cur = [];
  };
  for (const q of base.stitches) {
    if (q.cmd === CMD.JUMP) flush();
    cur.push(q);
  }
  flush();
  if (runs.length < 2) return base;
  // 1D k-means with k = the KNOWN line count, seeded one pitch apart. Handles
  // script faces whose ascenders/descenders overlap neighboring lines.
  const cys = runs.map((r) => r.cy);
  const mn = Math.min(...cys), mx = Math.max(...cys);
  const centers: number[] = [];
  for (let i = 0; i < lines; i++) centers.push(lines === 1 ? (mn + mx) / 2 : mn + ((mx - mn) * i) / (lines - 1));
  void pitchUnits;
  const assign = new Array<number>(runs.length).fill(0);
  for (let it = 0; it < 8; it++) {
    for (let i = 0; i < runs.length; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < centers.length; c++) { const d = Math.abs(cys[i] - centers[c]); if (d < bd) { bd = d; best = c; } }
      assign[i] = best;
    }
    for (let c = 0; c < centers.length; c++) {
      const mine = cys.filter((_, i) => assign[i] === c);
      if (mine.length) centers[c] = mine.reduce((x, y) => x + y, 0) / mine.length;
    }
  }
  const order = runs.map((_, i) => i);
  order.sort((i, j) => assign[i] - assign[j] || runs[i].minX - runs[j].minX);
  const out: Stitch[] = [];
  for (const i of order) for (const q of runs[i].st) out.push(q);
  return { ...base, stitches: out };
}

const FRAMES = 48;
const HOLD = 12;
const FPS = 16;

function download(blob: Blob, filename: string) {
  void saveBlob(blob, filename);
}

const BTN = "border border-hairline bg-bg px-2.5 py-1 text-[0.75rem] text-fg disabled:opacity-40 hover:bg-card whitespace-nowrap";

export default function AnimExport({ built, colors, name, threadMm = 0.42 }: {
  built: Built | null;
  colors: string[];
  name: string;
  threadMm?: number;
}) {
  const [exporting, setExporting] = useState<string | null>(null);
  const [arena, setArena] = useState(false);
  const [reveal, setReveal] = useState<"sew" | "reading">("sew");
  const cancelRef = useRef(false);

  const makeDrawer = () => {
    if (!built) return null;
    const W = 1080;
    const ar = built.stats.widthMm / Math.max(1, built.stats.heightMm);
    const H = Math.round(W / Math.max(0.35, Math.min(3, ar)));
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    const pattern = reveal === "reading" ? readingOrderPattern(built.pattern) : built.pattern;
    const view = fitTransform(pattern, W, H, 40);
    const total = pattern.stitches.length;
    const drawI = (i: number, bg: string | null) => {
      ctx.clearRect(0, 0, W, H);
      if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }
      const upTo = i < FRAMES ? Math.max(2, Math.round(((i + 1) / FRAMES) * total)) : undefined;
      renderPattern(ctx, pattern, view, { colors, sheen: true, threadMm, upTo });
      return c;
    };
    return { c, drawI, W, H };
  };

  const exportGif = async () => {
    const d = makeDrawer();
    if (!d || exporting) return;
    cancelRef.current = false;
    setExporting("Encoding GIF…");
    try {
      const { bytes, note } = await encodeGifFit(
        (i) => d.drawI(i, null),
        d.W, d.H, FRAMES + HOLD, 1000 / FPS, true,
        arena ? 25 * 1024 * 1024 : null,
        (m) => setExporting(m),
        () => cancelRef.current,
      );
      download(new Blob([new Uint8Array(bytes)], { type: "image/gif" }), `${name}-stitchout.gif`);
      if (note) { setExporting(`Are.na ${note}`); setTimeout(() => setExporting(null), 3600); return; }
      setExporting(null);
    } catch (e) {
      setExporting(null);
      if ((e as Error).message !== "cancelled") throw e;
    }
  };


  const exportPng = async () => {
    if (!built || exporting) return;
    // true physical size at 300 PPI, ~7mm margin, capped at 4096px long side
    const marginMm = 7;
    let W = mmToPx(built.stats.widthMm + 2 * marginMm, 300);
    let H = mmToPx(built.stats.heightMm + 2 * marginMm, 300);
    const cap = 4096 / Math.max(W, H);
    if (cap < 1) { W = Math.round(W * cap); H = Math.round(H * cap); }
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, W, H);
    renderPattern(ctx, built.pattern, fitTransform(built.pattern, W, H, mmToPx(marginMm, 300) * Math.min(1, cap)), { colors, sheen: true, threadMm });
    setExporting("Writing PNG…");
    try { void saveBlob(await canvasToPngPpi(c, 300), `${name}.png`); } finally { setExporting(null); }
  };

  const exportVideo = async () => {
    const d = makeDrawer();
    if (!d || exporting) return;
    cancelRef.current = false;
    const mime = ["video/webm;codecs=vp9", "video/webm", "video/mp4"]
      .find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m));
    if (!mime) { setExporting("Video isn't supported in this browser - use the GIF."); setTimeout(() => setExporting(null), 3200); return; }
    const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
    const bg = ext === "webm" ? null : "#ffffff"; // MP4 can't carry alpha
    setExporting("Recording…");
    const stream = d.c.captureStream(FPS);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    const chunks: BlobPart[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise<void>((res) => { rec.onstop = () => res(); });
    rec.start();
    let cancelled = false;
    for (let i = 0; i < FRAMES + HOLD; i++) {
      if (cancelRef.current) { cancelled = true; break; }
      setExporting(`Recording ${i + 1}/${FRAMES + HOLD}…`);
      d.drawI(i, bg);
      await new Promise((r) => setTimeout(r, 1000 / FPS));
    }
    rec.stop();
    await done;
    if (!cancelled) download(new Blob(chunks, { type: mime.split(";")[0] }), `${name}-stitchout.${ext}`);
    setExporting(null);
  };

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span className="text-[0.6875rem] tracking-[0.12em] uppercase text-mid">Animate</span>
      <button onClick={() => void exportGif()} disabled={!built || !!exporting} className={BTN}
        title="The design stitches itself out on a transparent background">
        Stitch-out GIF
      </button>
      <button onClick={() => void exportVideo()} disabled={!built || !!exporting} className={BTN}
        title="Transparent WebM video (MP4 with white background on Safari)">
        Video
      </button>
      <button onClick={() => void exportPng()} disabled={!built || !!exporting} className={BTN}
        title="The finished render as a print-resolution PNG - 300 PPI at the design's real size, transparent">
        PNG 300ppi
      </button>
      <span className="flex border border-hairline" title="How the design reveals: true machine sew order, or left to right as it reads">
        {([["sew", "Sew order"], ["reading", "Left to right"]] as const).map(([v, label]) => (
          <button key={v} onClick={() => setReveal(v)}
            className={`px-2 py-1 text-[0.6875rem] ${reveal === v ? "bg-fg text-bg" : "bg-bg text-mid hover:text-fg"}`}>
            {label}
          </button>
        ))}
      </span>
      <label className="flex items-center gap-1 text-[0.6875rem] text-mid" title="Keep GIFs under Are.na's 25 MB cap - thins frames first, resolution last">
        <input type="checkbox" checked={arena} onChange={(e) => setArena(e.target.checked)} className="accent-accent" />
        ≤25 MB (Are.na)
      </label>
      {exporting && (
        <>
          <span className="text-[0.6875rem] text-mid truncate max-w-[11rem]">{exporting}</span>
          <button onClick={() => { cancelRef.current = true; }} title="Stop this export" className={BTN}>Cancel</button>
        </>
      )}
    </div>
  );
}
