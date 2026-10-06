// Stitch Lab: Photoreal - photorealistic image interpretation that animates
// AND stitches. The photo is quantized to real Madeira cones (1–12 color
// planes); each method turns those planes into stitch geometry:
//   • Thread paint - grain-following strokes, per-stroke cone color
//   • Layered halftone - a wavy line screen per cone, darkest first
//   • Fine cross-stitch - counted crosses per cone (V1 engine)
// Preview animates the stitch-out; exports: GIF, video, and real DST/PES.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  SectionBox, RangeRow, ModeButtons, ImagePick, SizeField,
  buildDesign, downloadDesign, useDebouncedKey, useIsMobile,
  fmtSize, useUnits, LABEL, Warning, fitsHoop,
  type Built, type LumImg, type StitchFormat,
} from "./shared";
import { saveDesignEverywhere, AUTH_EVENT } from "../lib/sync";
import { saveBlob } from "../lib/native";
import { canvasToPngPpi, mmToPx } from "../lib/png";
import { pathGroupsToStitches, resamplePath, type PathMm } from "../lib/generators";
import { renderPattern, fitTransform } from "../lib/render";
import { quantizeToThreads, crossesFromGrid } from "./crossstitch";
import { zipStore, encodeGifFit } from "./animate";
import { writePes } from "../lib/pes";
import { writeJef } from "../lib/jef";
import { sobelGrad } from "./portrait";

const NAME = "bayside-photoreal";
type Method = "threadpaint" | "halftone" | "crossstitch";
const METHODS: readonly (readonly [Method, string])[] = [
  ["crossstitch", "Fine cross-stitch"], ["threadpaint", "Thread paint"], ["halftone", "Layered halftone"],
];

/** Quantize the photo into cone planes, then build per-method geometry.
 *  Returns per-cone path groups (darkest planes sew first). */
function buildPhotoreal(
  img: LumImg, method: Method, cones: number, density: number, sizeMm: number, detail?: number,
): { built: Built; colors: string[] } | null {
  const cols = method === "crossstitch" ? Math.round(detail ?? 90) : 96;
  const q = quantizeToThreads(img, { cols, k: cones, skipLight: true, lightThreshold: 0.94 });
  if (!q.palette.length) return null;
  const cellMm = sizeMm / q.cols;
  const luma = (hex: string) => parseInt(hex.slice(1, 3), 16) * 0.299 + parseInt(hex.slice(3, 5), 16) * 0.587 + parseInt(hex.slice(5, 7), 16) * 0.114;
  const order = q.palette.map((_, i) => i).sort((a, b) => luma(q.palette[a].hex) - luma(q.palette[b].hex));

  const planes: PathMm[][] = [];
  const colors: string[] = [];

  if (method === "crossstitch") {
    const groups = crossesFromGrid(q, q.palette.length, cellMm);
    for (const i of order) if (groups[i].length) { planes.push(groups[i]); colors.push(q.palette[i].hex); }
  } else if (method === "halftone") {
    // One wavy screen per cone: rows pass through cells owned by that cone.
    const rowsPerCell = 1 + Math.round(density * 0.4);
    for (const pi of order) {
      const paths: PathMm[] = [];
      for (let r = 0; r < q.rows * rowsPerCell; r++) {
        const y = ((r + 0.5) / rowsPerCell) * cellMm - (q.rows * cellMm) / 2 + ((pi % rowsPerCell) * cellMm) / rowsPerCell;
        const row = Math.floor(r / rowsPerCell);
        let seg: PathMm = [];
        for (let cx = 0; cx < q.cols; cx++) {
          const own = q.grid[row * q.cols + cx] === pi;
          const x = (cx + 0.5) * cellMm - (q.cols * cellMm) / 2;
          if (own) { for (let k = 0; k < 3; k++) seg.push({ x: x + ((k - 1) * cellMm) / 3, y: y + Math.sin((cx * 3 + k) * 0.9 + pi) * cellMm * 0.3 }); }
          else if (seg.length) { if (seg.length >= 2) paths.push(seg); seg = []; }
        }
        if (seg.length >= 2) paths.push(seg);
      }
      if (paths.length) { planes.push(paths.map((p) => resamplePath(p, 2.4, 0.4))); colors.push(q.palette[pi].hex); }
    }
  } else {
    // Thread paint: dense grain-following strokes; each stroke takes the cone
    // of the cell under it - the closest thing to painting with thread.
    const g = sobelGrad(img);
    const n = Math.round(70 + density * 26);
    const rowsN = Math.max(2, Math.round((n * img.h) / img.w));
    const stepX = (q.cols * cellMm) / n, stepY = (q.rows * cellMm) / rowsN;
    const byCone = new Map<number, PathMm[]>();
    for (let gy = 0; gy < rowsN; gy++) for (let gx = 0; gx < n; gx++) {
      const px = Math.min(img.w - 1, Math.floor(((gx + 0.5) / n) * img.w));
      const py = Math.min(img.h - 1, Math.floor(((gy + 0.5) / rowsN) * img.h));
      const cell = q.grid[Math.min(q.rows - 1, Math.floor(((gy + 0.5) / rowsN) * q.rows)) * q.cols + Math.min(q.cols - 1, Math.floor(((gx + 0.5) / n) * q.cols))];
      if (cell < 0) continue;
      const a = Math.atan2(g[(py * img.w + px) * 2 + 1] ?? 0, g[(py * img.w + px) * 2] ?? 1) + Math.PI / 2;
      const dkn = 1 - img.lum[py * img.w + px];
      const len = Math.max(stepX * 0.8, stepX * (0.7 + dkn * 1.3));
      const cx = (gx + 0.5) * stepX - (n * stepX) / 2, cy = (gy + 0.5) * stepY - (rowsN * stepY) / 2;
      const st: PathMm = [
        { x: cx - (Math.cos(a) * len) / 2, y: cy - (Math.sin(a) * len) / 2 },
        { x: cx + (Math.cos(a) * len) / 2, y: cy + (Math.sin(a) * len) / 2 },
      ];
      if (!byCone.has(cell)) byCone.set(cell, []);
      byCone.get(cell)!.push(st);
    }
    for (const pi of order) {
      const paths = byCone.get(pi);
      if (paths?.length) { planes.push(paths); colors.push(q.palette[pi].hex); }
    }
  }
  if (!planes.length) return null;
  const built = buildDesign(pathGroupsToStitches(planes, 1), NAME);
  return built ? { built, colors } : null;
}

export default function PhotorealTool() {
  const units = useUnits();
  const mobile = useIsMobile();
  const [img, setImg] = useState<LumImg | null>(null);
  const [imgName, setImgName] = useState("");
  const [method, setMethod] = useState<Method>("crossstitch");
  const [detail, setDetail] = useState(90);      // live-preview grid (the slider)
  const [fromD, setFromD] = useState(24);        // sweep start
  const [sweepN, setSweepN] = useState(30);      // sweep frames
  const [sweep, setSweep] = useState<{ built: Built; colors: string[] }[] | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const [cones, setCones] = useState(8);
  const [density, setDensity] = useState(5);
  const [sizeMm, setSizeMm] = useState(160);
  const [fmt, setFmt] = useState<StitchFormat>("dst");
  const [playing, setPlaying] = useState(true);
  const [arena, setArena] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "cloud" | "device" | "device-error">("idle");
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const key = useDebouncedKey([imgName, method, cones, density, sizeMm, detail], 250);
  const result = useMemo(() => {
    if (!img) return null;
    try { return buildPhotoreal(img, method, cones, density, sizeMm, detail); } catch { return null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, img]);
  useEffect(() => { setSweep(null); setScrub(null); }, [key, img]);

  // Render the detail sweep: coarse → fine, each frame a full re-quantize -
  // the "sliding the slider" effect, exportable.
  const renderSweep = async () => {
    if (!img || progress) return;
    cancelRef.current = false;
    const out: { built: Built; colors: string[] }[] = [];
    for (let i = 0; i < sweepN; i++) {
      if (cancelRef.current) { setProgress(null); return; }
      setProgress(`Rendering ${i + 1}/${sweepN}…`);
      await new Promise((r) => setTimeout(r, 0));
      const d = fromD + ((detail - fromD) * i) / Math.max(1, sweepN - 1);
      const f = buildPhotoreal(img, method, cones, density, sizeMm, d);
      if (f) out.push(f);
    }
    setProgress(null);
    setSweep(out.length ? out : null);
    setScrub(null);
  };
  // bounce order for playback/export
  const sweepSeq = useMemo(() => {
    if (!sweep) return [];
    const fwd = sweep.map((_, i) => i);
    return [...fwd, ...Array(6).fill(sweep.length - 1), ...[...fwd].reverse().slice(1), ...Array(3).fill(0)];
  }, [sweep]);

  // Animated stitch-out preview (loops); paused shows the finished piece.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !result) return;
    const W = 900;
    const ar = result.built.stats.widthMm / Math.max(1, result.built.stats.heightMm);
    const H = Math.round(W / Math.max(0.4, Math.min(2.5, ar)));
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const total = result.built.stats.realStitches;
    // shared fit
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const st of result.built.pattern.stitches) { if (st.x < minX) minX = st.x; if (st.x > maxX) maxX = st.x; if (st.y < minY) minY = st.y; if (st.y > maxY) maxY = st.y; }
    const sc = Math.min((W - 40) / Math.max(1, maxX - minX), (H - 40) / Math.max(1, maxY - minY));
    const view = { scale: sc, offsetX: W / 2 - ((minX + maxX) / 2) * sc, offsetY: H / 2 - ((minY + maxY) / 2) * sc };
    let raf = 0; const t0 = performance.now(); let last = -1;
    const FPS = 14;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (sweep && sweepSeq.length) {
        const si = scrub !== null ? Math.min(scrub, sweepSeq.length - 1) : Math.floor(((performance.now() - t0) / 1000) * FPS) % sweepSeq.length;
        if (si === last) return;
        last = si;
        const f = sweep[sweepSeq[si]];
        // per-frame fit so coarse and fine frames share the framing of the finest
        ctx.fillStyle = "#f4f2ee"; ctx.fillRect(0, 0, W, H);
        renderPattern(ctx, f.built.pattern, view, { colors: f.colors, sheen: true, threadMm: 0.42 });
        return;
      }
      const upTo = playing ? Math.max(2, Math.round(((performance.now() - t0) % 9000) / 9000 * total)) : total;
      ctx.fillStyle = "#f4f2ee"; ctx.fillRect(0, 0, W, H);
      renderPattern(ctx, result.built.pattern, view, { colors: result.colors, sheen: true, threadMm: 0.42, upTo: playing ? upTo : undefined });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [result, playing, sweep, sweepSeq, scrub]);

  // GIF / video of the stitch-out (fixed 48 frames + hold).
  const exportAnim = async (kind: "gif" | "video") => {
    if (!result || exporting) return;
    const W = 1080;
    const ar = result.built.stats.widthMm / Math.max(1, result.built.stats.heightMm);
    const H = Math.round(W / Math.max(0.4, Math.min(2.5, ar)));
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const st of result.built.pattern.stitches) { if (st.x < minX) minX = st.x; if (st.x > maxX) maxX = st.x; if (st.y < minY) minY = st.y; if (st.y > maxY) maxY = st.y; }
    const sc = Math.min((W - 50) / Math.max(1, maxX - minX), (H - 50) / Math.max(1, maxY - minY));
    const view = { scale: sc, offsetX: W / 2 - ((minX + maxX) / 2) * sc, offsetY: H / 2 - ((minY + maxY) / 2) * sc };
    const total = result.built.stats.realStitches;
    const useSweep = sweep && sweepSeq.length > 0;
    const FR = useSweep ? sweepSeq.length : 48, HOLD = useSweep ? 0 : 10, fps = useSweep ? 14 : 16;
    const drawI = (i: number, bg: string | null = "#f4f2ee") => {
      ctx.clearRect(0, 0, W, H);
      if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }
      if (useSweep) {
        const f = sweep![sweepSeq[Math.min(i, sweepSeq.length - 1)]];
        renderPattern(ctx, f.built.pattern, view, { colors: f.colors, sheen: true, threadMm: 0.42 });
        return;
      }
      const upTo = i < FR ? Math.max(2, Math.round(((i + 1) / FR) * total)) : undefined;
      renderPattern(ctx, result.built.pattern, view, { colors: result.colors, sheen: true, threadMm: 0.42, upTo });
    };
    const dl = (blob: Blob, ext: string) => { void saveBlob(blob, `${NAME}-${method}.${ext}`); };
    cancelRef.current = false;
    try {
      if (kind === "gif") {
        setExporting("Encoding GIF…");
        const { bytes, note } = await encodeGifFit(
          (i) => { drawI(i, null); return c; },
          W, H, FR + HOLD, 1000 / fps, true,
          arena ? 25 * 1024 * 1024 : null,
          (m) => setExporting(m),
          () => cancelRef.current,
        );
        dl(new Blob([new Uint8Array(bytes)], { type: "image/gif" }), "gif");
        if (note) { setExporting(`Are.na ${note}`); setTimeout(() => setExporting(null), 3600); }
      } else {
        const mime = ["video/mp4", "video/webm;codecs=vp9", "video/webm"].find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m));
        if (!mime) { setExporting("Video isn't supported here - use GIF."); setTimeout(() => setExporting(null), 3000); return; }
        setExporting("Recording video…");
        const stream = c.captureStream(fps);
        const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
        const chunks: BlobPart[] = [];
        rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        const done = new Promise<void>((res) => { rec.onstop = () => res(); });
        rec.start();
        let cancelled = false;
        for (let i = 0; i < FR + HOLD; i++) {
          if (cancelRef.current) { cancelled = true; break; }
          drawI(i); await new Promise((r) => setTimeout(r, 1000 / fps));
        }
        rec.stop(); await done;
        if (!cancelled) dl(new Blob(chunks, { type: mime.split(";")[0] }), mime.startsWith("video/mp4") ? "mp4" : "webm");
      }
    } catch (e) {
      if ((e as Error).message !== "cancelled") throw e;
    } finally { setExporting(null); }
  };

  // Batch (desktop): every photo → its detail-sweep GIF + stitch file, one ZIP.
  const runBatch = async (files: File[]) => {
    if (!files.length || progress || exporting) return;
    cancelRef.current = false;
    const entries: { name: string; data: Uint8Array }[] = [];
    const W = 1080;
    try {
      for (let fi = 0; fi < files.length; fi++) {
        const file = files[fi];
        const base = file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 32);
        const dataUrl: string = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error("read")); r.readAsDataURL(file); });
        const image = new Image();
        await new Promise<void>((res, rej) => { image.onload = () => res(); image.onerror = () => rej(new Error("img")); image.src = dataUrl; });
        const sc = 1200 / Math.max(image.width, image.height);
        const w = Math.max(32, Math.round(image.width * sc)), h = Math.max(32, Math.round(image.height * sc));
        const c0 = document.createElement("canvas"); c0.width = w; c0.height = h;
        const x0 = c0.getContext("2d")!;
        x0.fillStyle = "#fff"; x0.fillRect(0, 0, w, h); x0.drawImage(image, 0, 0, w, h);
        const data = x0.getImageData(0, 0, w, h).data;
        const lum = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) lum[i] = (0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2]) / 255;
        const lumImg = { w, h, lum, rgb: data };
        // sweep frames
        const frames: { built: Built; colors: string[] }[] = [];
        for (let i = 0; i < sweepN; i++) {
          if (cancelRef.current) { setProgress(null); return; }
          setProgress(`Photo ${fi + 1}/${files.length} - frame ${i + 1}/${sweepN}…`);
          await new Promise((r) => setTimeout(r, 0));
          const d = fromD + ((detail - fromD) * i) / Math.max(1, sweepN - 1);
          const f = buildPhotoreal(lumImg, method, cones, density, sizeMm, d);
          if (f) frames.push(f);
        }
        if (!frames.length) continue;
        const fine = frames[frames.length - 1];
        // fit from the finest frame
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const st of fine.built.pattern.stitches) { if (st.x < minX) minX = st.x; if (st.x > maxX) maxX = st.x; if (st.y < minY) minY = st.y; if (st.y > maxY) maxY = st.y; }
        const ar2 = Math.max(0.4, Math.min(2.5, (maxX - minX) / Math.max(1, maxY - minY)));
        const H2 = Math.round(W / ar2);
        const scv = Math.min((W - 50) / Math.max(1, maxX - minX), (H2 - 50) / Math.max(1, maxY - minY));
        const view = { scale: scv, offsetX: W / 2 - ((minX + maxX) / 2) * scv, offsetY: H2 / 2 - ((minY + maxY) / 2) * scv };
        const c = document.createElement("canvas"); c.width = W; c.height = H2;
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        const fwd = frames.map((_, i) => i);
        const seq = [...fwd, ...Array(6).fill(frames.length - 1), ...[...fwd].reverse().slice(1), ...Array(3).fill(0)];
        const { bytes: gifBytes } = await encodeGifFit(
          (i) => {
            const f = frames[seq[i]];
            ctx.clearRect(0, 0, W, H2);
            renderPattern(ctx, f.built.pattern, view, { colors: f.colors, sheen: true, threadMm: 0.42 });
            return c;
          },
          W, H2, seq.length, 1000 / 14, true,
          arena ? 25 * 1024 * 1024 : null,
          (m) => setProgress(`Photo ${fi + 1}/${files.length} - ${m}`),
          () => cancelRef.current,
        );
        if (cancelRef.current) { setProgress(null); return; }
        entries.push({ name: `${base}-photoreal-${method}-sweep.gif`, data: gifBytes });
        // stitch file at the set detail (the finest frame)
        entries.push({
          name: `${base}-photoreal-${method}.${fmt}`,
          data: fmt === "jef" ? new Uint8Array(writeJef(fine.built.pattern.stitches, fine.colors)) : fmt === "pes" ? new Uint8Array(writePes(fine.built.pattern.stitches, fine.colors, base)) : new Uint8Array(fine.built.bytes),
        });
      }
      if (entries.length) {
        const blob = new Blob([new Uint8Array(zipStore(entries))], { type: "application/zip" });
        void saveBlob(blob, `photoreal-batch-${method}-${fromD}-${detail}.zip`);
      }
    } catch (e) {
      if ((e as Error).message !== "cancelled") throw e;
    } finally { setProgress(null); }
  };

  const saveToLibrary = async () => {
    if (!result) return;
    setSaveState("saving");
    try {
      const thumb = document.createElement("canvas");
      thumb.width = 220; thumb.height = 220;
      const tctx = thumb.getContext("2d");
      if (tctx) {
        tctx.fillStyle = "#f4f2ee";
        tctx.fillRect(0, 0, 220, 220);
        renderPattern(tctx, result.built.pattern, fitTransform(result.built.pattern, 220, 220, 12), {
          colors: result.colors, sheen: false, threadMm: 0.42,
        });
      }
      const where = await saveDesignEverywhere({
        id: crypto.randomUUID(),
        name: NAME,
        tool: "photoreal",
        createdAt: Date.now(),
        stitchCount: result.built.stats.realStitches,
        widthMm: result.built.stats.widthMm,
        heightMm: result.built.stats.heightMm,
        colors: result.colors,
        thumbPng: thumb.toDataURL("image/png"),
        bytes: result.built.bytes,
      });
      setSaveState(where);
      setTimeout(() => setSaveState("idle"), where === "cloud" ? 2200 : 7000);
    } catch {
      setSaveState("idle");
    }
  };

  const controls = (
    <>
      <SectionBox eyebrow="photo">
        <ImagePick onImage={(im, n) => { setImg(im); setImgName(n); }} fileName={imgName} longSide={1200}
          hint="The photo's colors are reduced to real Madeira thread cones - the closer the photo's palette, the closer the match." />
        <div>
          <div className={`${LABEL} mb-1.5`}>Method</div>
          <ModeButtons small options={METHODS} value={method} onChange={setMethod} />
        </div>
        {(
          <div className="border-t border-hairline pt-2">
            <label className="inline-block cursor-pointer border border-hairline bg-bg px-2.5 py-1 text-[0.75rem] text-fg hover:bg-card">
              Batch: run several photos
              <input type="file" accept="image/*" multiple className="hidden"
                onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ""; if (fs.length) void runBatch(fs); }} />
            </label>
            <p className="mt-1 text-[0.6875rem] text-mid leading-relaxed">
              Each photo gets its detail-sweep GIF and its stitch file, downloaded together as one ZIP.
            </p>
          </div>
        )}
      </SectionBox>
      <SectionBox eyebrow="interpretation">
        <RangeRow label="Thread colors" value={cones} min={1} max={12} step={1} onChange={setCones} fmt={(v) => `${v} ${v === 1 ? "cone" : "cones"}`} />
        {method === "crossstitch" ? (
          <RangeRow label="Detail" value={detail} min={16} max={400} step={1} onChange={setDetail} />
        ) : (
          <RangeRow label="Coverage" value={density} min={1} max={10} step={1} onChange={setDensity} />
        )}
        <SizeField valueMm={sizeMm} min={60} max={330} onChange={setSizeMm} />
      </SectionBox>
      <SectionBox eyebrow="detail sweep">
        <p className="text-[0.6875rem] text-mid leading-relaxed">
          Animate the Detail slider: the rendering resolves from coarse to the detail set above, then bounces back.
        </p>
        <div className="grid grid-cols-2 gap-x-4">
          <RangeRow label="Start at" value={fromD} min={8} max={120} step={1} onChange={setFromD} />
          <RangeRow label="Frames" value={sweepN} min={12} max={60} step={1} onChange={setSweepN} />
        </div>
        {progress ? (
          <div className="flex gap-2">
            <p className="flex-1 text-[0.75rem] text-mid">{progress}</p>
            <button onClick={() => { cancelRef.current = true; }} className="border border-hairline bg-bg px-2 py-1 text-[0.75rem]">Cancel</button>
          </div>
        ) : (
          <button onClick={() => void renderSweep()} disabled={!img}
            className="border border-fg bg-fg text-bg px-3 py-1.5 text-[0.8125rem] disabled:opacity-40 hover:opacity-85">
            {sweep ? "Re-render sweep" : "Render sweep"}
          </button>
        )}
      </SectionBox>
      <SectionBox eyebrow="export">
        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => void exportAnim("gif")} disabled={!result || !!exporting}
            className="border border-hairline bg-bg px-3 py-1.5 text-[0.8125rem] text-fg disabled:opacity-40 hover:bg-card">GIF</button>
          <button onClick={() => void exportAnim("video")} disabled={!result || !!exporting}
            className="border border-hairline bg-bg px-3 py-1.5 text-[0.8125rem] text-fg disabled:opacity-40 hover:bg-card">Video</button>
          <button onClick={() => result && downloadDesign(result.built, result.colors, NAME, fmt)} disabled={!result}
            className="border border-fg bg-fg text-bg px-3 py-1.5 text-[0.8125rem] disabled:opacity-40 hover:opacity-85">
            Download {NAME}.{fmt}
          </button>
          <span className="flex border border-hairline">
            {(["dst", "pes", "jef"] as const).map((f) => (
              <button key={f} onClick={() => setFmt(f)} className={`px-2 py-1 text-[0.6875rem] uppercase ${fmt === f ? "bg-fg text-bg" : "bg-bg text-mid"}`}>{f}</button>
            ))}
          </span>
          <button
            onClick={async () => {
              if (!result || exporting) return;
              const marginMm = 7;
              let Wp = mmToPx(result.built.stats.widthMm + 2 * marginMm, 300);
              let Hp = mmToPx(result.built.stats.heightMm + 2 * marginMm, 300);
              const cap = 4096 / Math.max(Wp, Hp);
              if (cap < 1) { Wp = Math.round(Wp * cap); Hp = Math.round(Hp * cap); }
              const c = document.createElement("canvas"); c.width = Wp; c.height = Hp;
              const ctx = c.getContext("2d")!;
              ctx.clearRect(0, 0, Wp, Hp);
              renderPattern(ctx, result.built.pattern, fitTransform(result.built.pattern, Wp, Hp, mmToPx(marginMm, 300) * Math.min(1, cap)), { colors: result.colors, sheen: true, threadMm: 0.42 });
              setExporting("Writing PNG…");
              try { void saveBlob(await canvasToPngPpi(c, 300), `${NAME}-${method}.png`); } finally { setExporting(null); }
            }}
            disabled={!result || !!exporting}
            className="border border-hairline bg-bg px-3 py-1.5 text-[0.8125rem] text-fg disabled:opacity-40 hover:bg-card"
            title="The finished render as a print-resolution PNG - 300 PPI at the design's real size, transparent">
            PNG 300ppi
          </button>
          <button onClick={() => void saveToLibrary()} disabled={!result || saveState !== "idle"}
            className="border border-hairline bg-bg px-3 py-1.5 text-[0.8125rem] text-fg disabled:opacity-40 hover:bg-card whitespace-nowrap">
            {saveState === "saving" ? "Saving…" : saveState === "idle" ? "☆ Save" : "Saved ✓"}
          </button>
        </div>
        {saveState === "device" && (
          <p className="text-[0.6875rem] text-mid leading-snug">
            Saved in this browser only.{" "}
            <button onClick={() => window.dispatchEvent(new Event(AUTH_EVENT))} className="text-accent underline">
              Make a free account
            </button>{" "}
            to keep your library safe anywhere.
          </p>
        )}
        {saveState === "device-error" && (
          <p className="text-[0.6875rem] text-mid leading-snug">
            Saved in this browser - the account sync didn't go through. It retries on your next save.
          </p>
        )}
        <label className="flex items-center gap-1.5 text-[0.75rem] text-mid">
          <input type="checkbox" checked={arena} onChange={(e) => setArena(e.target.checked)} className="accent-accent" />
          Fit GIFs for Are.na (≤25 MB - thins frames first, resolution last)
        </label>
        {exporting && (
          <div className="flex items-center gap-2">
            <p className="flex-1 text-[0.75rem] text-mid">{exporting}</p>
            <button onClick={() => { cancelRef.current = true; }} title="Stop this export"
              className="border border-hairline bg-bg px-2 py-1 text-[0.75rem]">Cancel</button>
          </div>
        )}
        <p className="text-[0.6875rem] text-mid leading-relaxed">
          The stitch file is the exact design in the preview - the same build feeds the animation and the machine.
        </p>
        {result && result.built.stats.realStitches > 60000 && (
          <Warning>
            Over 60k stitches - at this detail the file is a visual artwork, too dense to sew cleanly.
            Lower Detail or shrink the size before stitching.
          </Warning>
        )}
        {result && !fitsHoop(result.built.stats.widthMm, result.built.stats.heightMm) && (
          <Warning>
            {fmtSize(result.built.stats.widthMm, result.built.stats.heightMm, units)} exceeds the 13 × 16 in
            hoop in every orientation - shrink before stitching.
          </Warning>
        )}
      </SectionBox>
    </>
  );

  const preview = (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 flex items-center justify-center p-2">
        <canvas ref={canvasRef} className="border border-hairline"
          style={{ maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto", background: "#f4f2ee" }} />
      </div>
      <div className="shrink-0 border-t border-hairline px-3 py-1.5 flex items-center gap-3">
        <button onClick={() => (sweep ? setScrub(scrub === null ? 0 : null) : setPlaying((v) => !v))} disabled={!result}
          className="border border-hairline bg-bg px-2.5 py-1 text-[0.75rem] text-fg disabled:opacity-40 hover:bg-card w-24">
          {sweep ? (scrub === null ? "Pause" : "Play") : playing ? "Show finished" : "Play stitch-out"}
        </button>
        {sweep && sweepSeq.length > 1 && (
          <input type="range" min={0} max={sweepSeq.length - 1} value={scrub ?? 0} disabled={scrub === null}
            onChange={(e) => setScrub(Number(e.target.value))} className="flex-1 min-w-0 accent-accent disabled:opacity-40" />
        )}
        <p className="text-[0.75rem] text-mid tabular-nums truncate">
          {result
            ? `${result.built.stats.realStitches.toLocaleString()} st · ${result.colors.length} cones · ${fmtSize(result.built.stats.widthMm, result.built.stats.heightMm, units)}`
            : img ? "Interpreting…" : "Load a photo to begin."}
        </p>
      </div>
    </div>
  );

  const topBar = (
    <div className="shrink-0 border-b border-hairline bg-card px-3 py-1.5 flex items-baseline gap-3">
      <button onClick={() => { window.location.hash = ""; }} className="text-[0.75rem] text-accent hover:underline shrink-0">← Workspace</button>
      <span className="font-serif text-[1.0625rem] text-fg">Photoreal</span>
      <span className="text-[0.75rem] text-mid truncate hidden sm:inline">fine cross-stitch from a photo - animate it, stitch it</span>
    </div>
  );

  if (mobile) {
    // Canvas pinned, controls in a fixed-height deck below - the canvas never
    // scrolls out of frame.
    return (
      <div className="h-full flex flex-col overflow-hidden bg-bg">
        {topBar}
        <div className="flex-1 min-h-0 bg-card/40">{preview}</div>
        <div className="h-[240px] shrink-0 border-t border-hairline overflow-y-auto p-3 space-y-3">{controls}</div>
      </div>
    );
  }
  return (
    <div className="h-full flex flex-col overflow-hidden bg-bg">
      {topBar}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 bg-card/40">{preview}</div>
        <aside className="w-[330px] shrink-0 border-l border-hairline overflow-y-auto p-3 space-y-3">{controls}</aside>
      </div>
    </div>
  );
}
