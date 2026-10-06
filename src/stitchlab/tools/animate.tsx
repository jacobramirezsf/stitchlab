// Stitch Lab: Animator - render a tool's output as an animation and export it
// as a GIF or video, straight from the engine. Replaces the screen-record →
// crop → color-correct → convert pipeline: frames are drawn directly from the
// same build the tools use, at a clean size, on the background you choose
// (or transparent for GIFs).
//
// Two animation types:
//   • Parameter sweep - one dial moves from A to B (the slider-recording look)
//   • Stitch-out draw - fixed design, stitches appear in sew order
//
// Sources reuse the real engines: Cross-Stitch (quantize → crosses), Thread
// Portrait (stipple → tour), and Halftone lines.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  SectionBox,
  useIsMobile,
  RangeRow,
  ModeButtons,
  ImagePick,
  buildDesign,
  downloadDesign,
  useDebouncedKey,
  useUnits,
  fmtSize,
  FABRICS,
  LABEL,
  type Built,
  type LumImg,
} from "./shared";
import { pathGroupsToStitches, resamplePath, type PathMm } from "../lib/generators";
import { encodeGifFit } from "../lib/gif";
import { saveBlob, apiBase } from "../lib/native";
import { canvasToPngPpi } from "../lib/png";
export { encodeGifFit };
import { renderPattern, type ViewTransform } from "../lib/render";
import { quantizeToThreads, crossesFromGrid } from "./crossstitch";
import { stipplePoints, nnTour, chaikinSmooth, sobelGrad } from "./portrait";
import { THREADS } from "../../data/threads";

const INK = THREADS.find((t) => t.code === "1568")?.hex ?? "#0b1f3a";
const NAME = "bayside-animator";

type Mode = "crossstitch" | "portrait" | "halftone" | "threadpaint";
type AnimType = "sweep" | "stitchout";

type ParamDef = { key: string; label: string; min: number; max: number; step: number };
const PARAMS: Record<Mode, ParamDef[]> = {
  crossstitch: [
    { key: "cells", label: "Grid cells", min: 10, max: 220, step: 1 },
    { key: "cones", label: "Thread cones", min: 1, max: 6, step: 1 },
    { key: "light", label: "Light threshold", min: 0.7, max: 0.98, step: 0.01 },
  ],
  portrait: [
    { key: "points", label: "Detail (points)", min: 300, max: 3200, step: 50 },
    { key: "pgamma", label: "Darkness", min: 0.8, max: 3, step: 0.05 },
  ],
  halftone: [
    { key: "rows", label: "Line rows", min: 8, max: 70, step: 1 },
    { key: "dark", label: "Darkness", min: 0.6, max: 3, step: 0.05 },
  ],
  threadpaint: [
    { key: "grain", label: "Stroke grid", min: 20, max: 80, step: 1 },
    { key: "tdark", label: "Darkness", min: 0.6, max: 3, step: 0.05 },
  ],
};
const MODE_LABEL: Record<Mode, string> = { crossstitch: "Cross-stitch", portrait: "Portrait squiggle", halftone: "Halftone lines", threadpaint: "Thread paint" };

// Defaults used for the params that are NOT animating.
const DEFAULTS: Record<string, number> = { cells: 48, cones: 4, light: 0.92, points: 2000, pgamma: 1.8, rows: 36, dark: 1.6, grain: 44, tdark: 1.6 };

// ─── Frame geometry (same engines as the tools) ──────────────────────────

function halftonePaths(img: LumImg, rows: number, dark: number): PathMm[] {
  const ar = img.w / img.h;
  const bw = ar >= 1 ? 100 : 100 * ar;
  const bh = ar >= 1 ? 100 / ar : 100;
  const x0 = (100 - bw) / 2, y0 = (100 - bh) / 2;
  const pitch = bh / rows;
  const out: PathMm[] = [];
  for (let r = 0; r < rows; r++) {
    const yC = y0 + (r + 0.5) * pitch;
    const seg: PathMm = [];
    for (let i = 0; i <= 150; i++) {
      const x = x0 + (i / 150) * bw;
      const u = Math.min(img.w - 1, Math.floor((i / 150) * img.w));
      const v = Math.min(img.h - 1, Math.floor(((yC - y0) / bh) * img.h));
      const amp = Math.pow(Math.max(0, 1 - img.lum[v * img.w + u]), dark) * pitch * 0.48;
      seg.push({ x, y: yC + Math.sin(i * 0.85) * amp });
    }
    out.push(r % 2 ? seg.reverse() : seg);
  }
  return out;
}

export type Frame = { built: Built; colors: string[]; threadMm?: number };

/** Build one frame at the given param values. Sized to ~140mm so stitch
 *  density reads like the real tools. */
export function buildFrame(mode: Mode, img: LumImg, v: Record<string, number>): Frame | null {
  const SIZE = 140;
  if (mode === "crossstitch") {
    const q = quantizeToThreads(img, { cols: Math.round(v.cells), k: Math.round(v.cones), skipLight: true, lightThreshold: v.light });
    if (!q.palette.length) return null;
    const cellMm = SIZE / q.cols;
    const groups = crossesFromGrid(q, q.palette.length, cellMm);
    const order: string[] = []; const paths: PathMm[][] = [];
    // Cross legs are already exact stitch segments (cell corner to corner).
    // Resampling them at a fixed 2.2mm cut the corners off fine-grid X's -
    // keep every vertex so each cross stays a cross at any grid size.
    groups.forEach((g, i) => { if (g.length) { order.push(q.palette[i].hex); paths.push(g); } });
    if (!order.length) return null;
    const built = buildDesign(pathGroupsToStitches(paths, 1), NAME);
    // V1-tool parity: real floss is ~0.42mm regardless of count - the same
    // width the Cross-Stitch tool renders with. Coarse grids show fabric
    // between crosses; fine grids close up into dense coverage, like cloth.
    void cellMm;
    const threadMm = 0.42;
    return built ? { built, colors: order, threadMm } : null;
  }
  const scale = SIZE / Math.max(img.w, img.h);
  if (mode === "portrait") {
    const pts = stipplePoints({ w: img.w, h: img.h, lum: img.lum, grad: sobelGrad(img) }, { count: Math.round(v.points), gamma: v.pgamma, seed: 2, relaxPasses: 1, edgeBoost: 1 });
    if (pts.length < 2) return null;
    const order = nnTour(pts, 12000);
    const path = chaikinSmooth(order.map((i) => pts[i]), 2).map((p) => ({ x: p.x * scale, y: p.y * scale }));
    const built = buildDesign(pathGroupsToStitches([[resamplePath(path, 2.2, 0.4)]], 1), NAME);
    return built ? { built, colors: [INK] } : null;
  }
  if (mode === "threadpaint") {
    // Short strokes following the image grain (perpendicular to the gradient),
    // longer/denser where the photo is dark.
    const g = sobelGrad(img);
    const n = Math.round(v.grain);
    const ar = img.w / img.h;
    const bw = ar >= 1 ? 100 : 100 * ar, bh = ar >= 1 ? 100 / ar : 100;
    const x0 = (100 - bw) / 2, y0 = (100 - bh) / 2;
    const cellW = bw / n, rowsN = Math.max(2, Math.round(n / ar));
    const strokes: PathMm[] = [];
    for (let gy = 0; gy < rowsN; gy++) for (let gx = 0; gx < n; gx++) {
      const px = Math.min(img.w - 1, Math.floor(((gx + 0.5) / n) * img.w));
      const py = Math.min(img.h - 1, Math.floor(((gy + 0.5) / rowsN) * img.h));
      const dkn = Math.pow(Math.max(0, 1 - img.lum[py * img.w + px]), v.tdark);
      if (dkn < 0.06) continue;
      const a = Math.atan2(g[(py * img.w + px) * 2 + 1] ?? 0, g[(py * img.w + px) * 2] ?? 1) + Math.PI / 2;
      const len = cellW * (0.5 + dkn * 0.9);
      const cx = x0 + (gx + 0.5) * cellW, cy = y0 + (gy + 0.5) * (bh / rowsN);
      strokes.push([{ x: cx - Math.cos(a) * len / 2, y: cy - Math.sin(a) * len / 2 }, { x: cx + Math.cos(a) * len / 2, y: cy + Math.sin(a) * len / 2 }]);
    }
    const sc = SIZE / 100;
    const tp = strokes.map((st) => st.map((q) => ({ x: q.x * sc, y: q.y * sc })));
    const built = buildDesign(pathGroupsToStitches([tp], 1), NAME);
    return built ? { built, colors: [INK] } : null;
  }
  const paths = halftonePaths(img, Math.round(v.rows), v.dark).map((p) => p.map((q) => ({ x: q.x * (SIZE / 100), y: q.y * (SIZE / 100) })));
  const built = buildDesign(pathGroupsToStitches([paths.map((p) => resamplePath(p, 2.2, 0.4))], 1), NAME);
  return built ? { built, colors: [INK] } : null;
}

/** One shared view across all frames so the framing never jitters. */
export function sharedView(frames: Frame[], W: number, H: number, pad = 26): ViewTransform {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of frames) for (const s of f.built.pattern.stitches) {
    if (s.x < minX) minX = s.x; if (s.x > maxX) maxX = s.x;
    if (s.y < minY) minY = s.y; if (s.y > maxY) maxY = s.y;
  }
  if (!isFinite(minX)) return { scale: 1, offsetX: 0, offsetY: 0 };
  const scale = Math.min((W - pad * 2) / Math.max(1, maxX - minX), (H - pad * 2) / Math.max(1, maxY - minY));
  return {
    scale,
    offsetX: W / 2 - ((minX + maxX) / 2) * scale,
    offsetY: H / 2 - ((minY + maxY) / 2) * scale,
  };
}

/** Playback order: sweep forward (+ optional bounce) or stitch-out reveal. */
function buildSequence(
  frames: Frame[],
  anim: AnimType,
  frameCount: number,
  bounce: boolean,
  holdEnd: number,
): { idx: number; upTo?: number }[] {
  if (!frames.length) return [];
  if (anim === "stitchout") {
    const total = frames[0].built.stats.realStitches;
    const seq: { idx: number; upTo?: number }[] = [];
    for (let i = 0; i < frameCount; i++) seq.push({ idx: 0, upTo: Math.max(2, Math.round(((i + 1) / frameCount) * total)) });
    for (let i = 0; i < holdEnd; i++) seq.push({ idx: 0 });
    return seq;
  }
  const fwd: { idx: number; upTo?: number }[] = frames.map((_, i) => ({ idx: i }));
  const seq: { idx: number; upTo?: number }[] = [...fwd];
  for (let i = 0; i < holdEnd; i++) seq.push({ idx: frames.length - 1 });
  if (bounce) {
    seq.push(...[...fwd].reverse().slice(1));
    for (let i = 0; i < Math.min(holdEnd, 4); i++) seq.push({ idx: 0 });
  }
  return seq;
}


/** Store-only ZIP (GIFs don't recompress) - one download for a whole batch. */
export function zipStore(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (d: Uint8Array) => { let c = 0xffffffff; for (let i = 0; i < d.length; i++) c = table[(c ^ d[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: number) => new Uint8Array([v & 255, (v >> 8) & 255]);
  const u32 = (v: number) => new Uint8Array([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]);
  const cat = (...parts: Uint8Array[]) => { const n = parts.reduce((a, b) => a + b.length, 0); const o = new Uint8Array(n); let p0 = 0; for (const pt of parts) { o.set(pt, p0); p0 += pt.length; } return o; };
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const local = cat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(e.data.length), u32(e.data.length), u16(name.length), u16(0), name, e.data);
    chunks.push(local);
    central.push(cat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(e.data.length), u32(e.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name));
    offset += local.length;
  }
  const cd = cat(...central);
  const end = cat(u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(offset), u16(0));
  return cat(...chunks, cd, end);
}

function drawFrame(ctx: CanvasRenderingContext2D, f: Frame, view: ViewTransform, W: number, H: number, bg: string, upTo?: number) {
  ctx.clearRect(0, 0, W, H);
  if (bg !== "transparent") { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }
  renderPattern(ctx, f.built.pattern, view, { colors: f.colors, sheen: bg !== "transparent", threadMm: f.threadMm ?? 0.55, upTo });
}

const download = (blob: Blob, filename: string) => { void saveBlob(blob, filename); };

// ─── Component ───────────────────────────────────────────────────────────

export default function AnimateTool() {
  const units = useUnits();
  const [img, setImg] = useState<LumImg | null>(null);
  const [imgName, setImgName] = useState("");
  const [srcDataUrl, setSrcDataUrl] = useState<string | null>(null);
  const [bgRemoving, setBgRemoving] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("crossstitch");
  const [anim, setAnim] = useState<AnimType>("sweep");
  const [paramKey, setParamKey] = useState("cells");
  const [from, setFrom] = useState(12);
  const [to, setTo] = useState(72);
  const [frameCount, setFrameCount] = useState(36);
  const [bounce, setBounce] = useState(true);
  const [reveal, setReveal] = useState(true);      // photo fades out as stitches draw (stitch-out)
  const [kenburns, setKenburns] = useState(false); // slow push-in
  const [overlay, setOverlay] = useState(false);   // stitch counter + thread legend
  const [caption, setCaption] = useState("");
  const [sound, setSound] = useState(false);       // machine hum on video
  const [arena, setArena] = useState(false);       // fit GIFs under Are.na's 25MB
  const [srcCanvas, setSrcCanvas] = useState<HTMLCanvasElement | null>(null);
  const [holdEnd, setHoldEnd] = useState(8);
  const [res, setRes] = useState(1080);   // long side, px
  const [aspect, setAspect] = useState<"1:1" | "9:16" | "4:5" | "16:9">(() =>
    typeof window !== "undefined" && window.matchMedia?.("(max-width: 1023px)").matches ? "9:16" : "1:1");
  const AR: Record<string, [number, number]> = { "1:1": [1, 1], "9:16": [9, 16], "4:5": [4, 5], "16:9": [16, 9] };
  const [arw, arh] = AR[aspect];
  const W = arw >= arh ? res : Math.round((res * arw) / arh);
  const H = arw >= arh ? Math.round((res * arh) / arw) : res;
  const [bg, setBg] = useState("transparent"); // GIFs export transparent by default
  const [customBg, setCustomBg] = useState("#f4f2ee");
  const [fps, setFps] = useState(18);

  const [frames, setFrames] = useState<Frame[] | null>(null);
  const [previewF, setPreviewF] = useState<Frame | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playRef = useRef<number>(0);
  const [scrub, setScrub] = useState<number | null>(null); // null = playing

  useEffect(() => {
    if (!img) { setSrcCanvas(null); return; }
    const c = document.createElement("canvas");
    c.width = img.w; c.height = img.h;
    c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(img.rgb), img.w, img.h), 0, 0);
    setSrcCanvas(c);
  }, [img]);

  /** Decode a data URL to LumImg, flattened onto white (transparent = bare fabric). */
  const dataUrlToLum = (url: string) =>
    new Promise<LumImg>((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const sc = 800 / Math.max(image.width, image.height);
        const w = Math.max(32, Math.round(image.width * sc));
        const h = Math.max(32, Math.round(image.height * sc));
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = c.getContext("2d");
        if (!ctx) { reject(new Error("no canvas")); return; }
        ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(image, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        const lum = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) lum[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
        resolve({ w, h, lum, rgb: data });
      };
      image.onerror = () => reject(new Error("bad image"));
      image.src = url;
    });

  // Same background removal as the clothing customizer (server-side key).
  const removeBackground = async () => {
    if (!srcDataUrl || bgRemoving) return;
    setBgRemoving("Removing background…");
    try {
      const res = await fetch(`${apiBase()}/api/removebg`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: srcDataUrl }),
      });
      const body = (await res.json().catch(() => ({}))) as { dataURL?: string; error?: string };
      if (!res.ok || !body.dataURL) throw new Error(body.error || "Couldn't remove the background.");
      setSrcDataUrl(body.dataURL);
      setImg(await dataUrlToLum(body.dataURL));
      setFrames(null);
      setBgRemoving(null);
    } catch (e) {
      setBgRemoving(e instanceof Error ? e.message : "Couldn't remove the background.");
      setTimeout(() => setBgRemoving(null), 3200);
    }
  };

  const param = PARAMS[mode].find((p) => p.key === paramKey) ?? PARAMS[mode][0];
  useEffect(() => {
    // Mode switched: snap to its first param and its full range.
    const p = PARAMS[mode][0];
    setParamKey(p.key); setFrom(p.min); setTo(p.max);
    setFrames(null);
  }, [mode]);

  const pickParam = (key: string) => {
    const p = PARAMS[mode].find((x) => x.key === key)!;
    setParamKey(key); setFrom(p.min); setTo(p.max); setFrames(null);
  };

  // ── Frame generation (async, cancellable) ──
  const generate = async () => {
    if (!img) return;
    cancelRef.current = false;
    setFrames(null);
    const out: Frame[] = [];
    const n = anim === "sweep" ? frameCount : 1;
    for (let i = 0; i < n; i++) {
      if (cancelRef.current) { setProgress(null); return; }
      setProgress(`Rendering frame ${i + 1} of ${n}…`);
      await new Promise((r) => setTimeout(r, 0)); // keep the page alive
      const t = n === 1 ? 1 : i / (n - 1);
      const v: Record<string, number> = { ...DEFAULTS };
      if (anim === "sweep") v[param.key] = from + (to - from) * t;
      const f = buildFrame(mode, img, v);
      if (f) out.push(f);
    }
    setProgress(null);
    setFrames(out.length ? out : null);
    setScrub(null);
  };

  // Instant preview: one frame at the sweep's end value, so the canvas is
  // never empty - upload and slider moves show immediately, before the full
  // animation render.
  const previewKey = useDebouncedKey([mode, anim, param.key, to, imgName], 300);
  useEffect(() => {
    if (!img || frames) return;
    const v: Record<string, number> = { ...DEFAULTS };
    if (anim === "sweep") v[param.key] = to;
    setPreviewF(buildFrame(mode, img, v));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, img, frames]);

  // Sequence of frame indices for playback/export (bounce + end hold).
  const sequence = useMemo(
    () => (frames ? buildSequence(frames, anim, frameCount, bounce, holdEnd) : []),
    [frames, anim, frameCount, bounce, holdEnd],
  );

  const effBg = bg === "custom" ? customBg : bg;
  const view = useMemo(() => (frames ? sharedView(frames, W, H) : null), [frames, W, H]);

  // ── Live preview loop (or the instant single-frame preview) ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (!frames || !view || !sequence.length) {
      if (previewF) drawFrame(ctx, previewF, sharedView([previewF], W, H), W, H, effBg);
      else { ctx.clearRect(0, 0, W, H); if (effBg !== "transparent") { ctx.fillStyle = effBg; ctx.fillRect(0, 0, W, H); } }
      return;
    }
    let step = 0;
    let last = 0;
    const tick = (ts: number) => {
      playRef.current = requestAnimationFrame(tick);
      if (scrub !== null) {
        const si = Math.min(scrub, sequence.length - 1);
        const s = sequence[si];
        drawStyled(ctx, frames[s.idx], view, W, H, effBg, si, sequence.length, s.upTo);
        return;
      }
      if (ts - last < 1000 / fps) return;
      last = ts;
      const si = step % sequence.length;
      const s = sequence[si];
      drawStyled(ctx, frames[s.idx], view, W, H, effBg, si, sequence.length, s.upTo);
      step++;
    };
    playRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(playRef.current);
  }, [frames, view, sequence, W, H, effBg, fps, scrub, previewF]);

  const baseName = () => {
    const src = imgName.replace(/\.[a-z0-9]+$/i, "").slice(0, 24) || "photo";
    return anim === "stitchout"
      ? `${mode}-stitchout-${src}`
      : `${mode}-${param.key}-${from}-${to}-${src}`.replace(/\.+/g, "_");
  };

  // ── GIF export (gifenc - direct, no screen recording) ──
  const exportGif = async () => {
    if (!frames || !view || exporting) return;
    cancelRef.current = false;
    setExporting("Encoding GIF…");
    try {
      const c = document.createElement("canvas");
      c.width = W; c.height = H;
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      const transparent = effBg === "transparent";
      const { bytes, note } = await encodeGifFit(
        (i) => { const s = sequence[i]; drawStyled(ctx, frames[s.idx], view, W, H, effBg, i, sequence.length, s.upTo); return c; },
        W, H, sequence.length, 1000 / fps, transparent,
        arena ? 25 * 1024 * 1024 : null,
        (m) => setExporting(m),
        () => cancelRef.current,
      );
      download(new Blob([new Uint8Array(bytes)], { type: "image/gif" }), `${baseName()}.gif`);
      if (note) { setExporting(`Are.na ${note}`); setTimeout(() => setExporting(null), 3600); return; }
      setExporting(null);
    } catch (e) {
      setExporting(null);
      if ((e as Error).message !== "cancelled") throw e;
    }
  };

  // ── Video export (canvas stream → MediaRecorder; mp4 on Safari, webm elsewhere) ──
  const exportVideo = async () => {
    if (!frames || !view || exporting) return;
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d")!;
    const mime = ["video/mp4", "video/webm;codecs=vp9", "video/webm"].find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m));
    if (!mime) { setExporting("Video isn't supported in this browser - use the GIF export."); setTimeout(() => setExporting(null), 3200); return; }
    const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
    // WebM (VP8/9) carries alpha in Chrome - transparent stays transparent.
    // MP4 has no alpha, so Safari gets white behind a transparent choice.
    const videoBg = effBg === "transparent" ? (ext === "webm" ? "transparent" : "#ffffff") : effBg;
    cancelRef.current = false;
    setExporting("Recording video…");
    const stream = c.captureStream(fps);
    // Procedural sewing-machine hum: filtered noise pulsed at needle rhythm,
    // mixed into the recording when Sound is on.
    let ac: AudioContext | null = null;
    if (sound) {
      try {
        ac = new AudioContext();
        const dest = ac.createMediaStreamDestination();
        const len = ac.sampleRate * 2;
        const buf = ac.createBuffer(1, len, ac.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) {
          const t = i / ac.sampleRate;
          const pulse = Math.max(0, Math.sin(2 * Math.PI * 13 * t)) ** 6; // needle strikes ~13/s
          d[i] = (Math.random() * 2 - 1) * 0.28 * (0.25 + pulse) ;
        }
        const src = ac.createBufferSource();
        src.buffer = buf; src.loop = true;
        const lp = ac.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1400;
        const gain = ac.createGain(); gain.gain.value = 0.5;
        src.connect(lp); lp.connect(gain); gain.connect(dest);
        src.start();
        stream.addTrack(dest.stream.getAudioTracks()[0]);
      } catch { /* silent video if audio init fails */ }
    }
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    const chunks: BlobPart[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise<void>((res) => { rec.onstop = () => res(); });
    rec.start();
    let cancelled = false;
    for (let i = 0; i < sequence.length; i++) {
      if (cancelRef.current) { cancelled = true; break; }
      setExporting(`Recording video ${i + 1}/${sequence.length}…`);
      const s = sequence[i];
      drawStyled(ctx, frames[s.idx], view, W, H, videoBg, i, sequence.length, s.upTo);
      await new Promise((r) => setTimeout(r, 1000 / fps));
    }
    rec.stop();
    await done;
    void ac?.close();
    if (!cancelled) download(new Blob(chunks, { type: mime.split(";")[0] }), `${baseName()}.${ext}`);
    setExporting(null);
  };

  /** drawFrame plus the director layer: Ken Burns, photo reveal, overlay, caption. */
  const drawStyled = (
    ctx: CanvasRenderingContext2D, f: Frame, view0: { scale: number; offsetX: number; offsetY: number },
    w: number, h: number, bg: string, si: number, sn: number, upTo?: number,
  ) => {
    let v = view0;
    if (kenburns && sn > 1) {
      const k = 1 + 0.14 * (si / (sn - 1));
      v = { scale: view0.scale * k, offsetX: w / 2 - (w / 2 - view0.offsetX) * k, offsetY: h / 2 - (h / 2 - view0.offsetY) * k };
    }
    ctx.clearRect(0, 0, w, h);
    if (bg !== "transparent") { ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h); }
    const total = f.built.stats.realStitches;
    if (reveal && srcCanvas && upTo !== undefined && total > 0) {
      const a = Math.max(0, 1 - (upTo / total) * 1.35);
      if (a > 0.01) {
        const dw = f.built.stats.widthMm * 10 * v.scale, dh = f.built.stats.heightMm * 10 * v.scale;
        const fit = Math.min(dw / srcCanvas.width, dh / srcCanvas.height);
        const iw = srcCanvas.width * fit, ih = srcCanvas.height * fit;
        ctx.globalAlpha = a;
        ctx.drawImage(srcCanvas, w / 2 - iw / 2, h / 2 - ih / 2, iw, ih);
        ctx.globalAlpha = 1;
      }
    }
    renderPattern(ctx, f.built.pattern, v, { colors: f.colors, sheen: bg !== "transparent", threadMm: f.threadMm ?? 0.55, upTo });
    if (overlay) {
      const shown = Math.min(upTo ?? total, total);
      const pad = Math.round(w * 0.03);
      ctx.font = `${Math.round(w * 0.026)}px ui-monospace, Menlo, monospace`;
      ctx.textAlign = "left";
      ctx.fillStyle = bg === "transparent" ? "#555" : "rgba(40,40,40,0.85)";
      ctx.fillText(`${shown.toLocaleString()} / ${total.toLocaleString()} st`, pad, h - pad);
      const chip = Math.round(w * 0.022);
      f.colors.slice(0, 6).forEach((cHex, ci) => {
        ctx.fillStyle = cHex;
        ctx.fillRect(pad + ci * (chip + 4), h - pad - chip * 2.4, chip, chip);
      });
    }
    if (caption.trim()) {
      ctx.font = `${Math.round(w * 0.032)}px Georgia, serif`;
      ctx.textAlign = "center";
      ctx.fillStyle = bg === "transparent" ? "#444" : "rgba(30,30,30,0.9)";
      ctx.fillText(caption.trim(), w / 2, h - Math.round(w * 0.08));
    }
  };

  // Batch (desktop): every photo runs through the current settings and the
  // results download as one ZIP - one GIF per photo, named by source.
  const runBatch = async (files: File[]) => {
    if (!files.length || progress || exporting) return;
    cancelRef.current = false;
    const zipEntries: { name: string; data: Uint8Array }[] = [];
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    const transparent = effBg === "transparent";
    try {
      for (let fi = 0; fi < files.length; fi++) {
        const file = files[fi];
        const base = file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 32);
        const dataUrl: string = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error("read")); r.readAsDataURL(file); });
        const lum = await dataUrlToLum(dataUrl);
        const bf: Frame[] = [];
        const n = anim === "sweep" ? frameCount : 1;
        for (let i = 0; i < n; i++) {
          if (cancelRef.current) { setProgress(null); return; }
          setProgress(`Photo ${fi + 1}/${files.length} - frame ${i + 1}/${n}…`);
          await new Promise((r) => setTimeout(r, 0));
          const t = n === 1 ? 1 : i / (n - 1);
          const v: Record<string, number> = { ...DEFAULTS };
          if (anim === "sweep") v[param.key] = from + (to - from) * t;
          const f = buildFrame(mode, lum, v);
          if (f) bf.push(f);
        }
        if (!bf.length) continue;
        const seq = buildSequence(bf, anim, frameCount, bounce, holdEnd);
        const bview = sharedView(bf, W, H);
        const { bytes } = await encodeGifFit(
          (i) => { const sq = seq[i]; drawFrame(ctx, bf[sq.idx], bview, W, H, effBg, sq.upTo); return c; },
          W, H, seq.length, 1000 / fps, transparent,
          arena ? 25 * 1024 * 1024 : null,
          (m) => setProgress(`Photo ${fi + 1}/${files.length} - ${m}`),
          () => cancelRef.current,
        );
        if (cancelRef.current) { setProgress(null); return; }
        const suffix = anim === "stitchout" ? `${mode}-stitchout` : `${mode}-${param.key}-${from}-${to}`;
        zipEntries.push({ name: `${base}-${suffix}.gif`, data: bytes });
      }
      if (zipEntries.length) {
        const zipName = anim === "stitchout" ? `animator-batch-${mode}-stitchout.zip` : `animator-batch-${mode}-${param.key}-${from}-${to}.zip`;
        download(new Blob([new Uint8Array(zipStore(zipEntries))], { type: "application/zip" }), zipName);
      }
    } catch (e) {
      if ((e as Error).message !== "cancelled") throw e;
    } finally {
      setProgress(null);
    }
  };

  // ── Collage: a library of rendered clips composed on one canvas ──
  type Clip = { id: string; name: string; frames: Frame[]; seq: { idx: number; upTo?: number }[]; fps: number };
  type PlacedClip = { id: string; clipId: string; x: number; y: number; w: number }; // fractions of canvas
  const [clips, setClips] = useState<Clip[]>([]);
  const [placedC, setPlacedC] = useState<PlacedClip[]>([]);
  const [selC, setSelC] = useState<string | null>(null);
  const [collage, setCollage] = useState(false);
  const collageRef = useRef<HTMLCanvasElement>(null);
  const dragC = useRef<{ id: string; ox: number; oy: number } | null>(null);

  const addToLibrary = () => {
    if (!frames || !sequence.length) return;
    const clip: Clip = { id: `c${Date.now()}`, name: baseName(), frames, seq: sequence, fps };
    setClips((cs) => [...cs, clip]);
    setPlacedC((ps) => [...ps, { id: `p${Date.now()}`, clipId: clip.id, x: 0.5, y: 0.25 + (placedC.length % 3) * 0.25, w: 0.55 }]);
    setCollage(true);
  };

  // Live collage playback: each clip loops at its own fps; frames render into
  // per-clip offscreens, re-drawn only when their frame index changes.
  useEffect(() => {
    if (!collage) return;
    const canvas = collageRef.current;
    if (!canvas) return;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const off = new Map<string, { c: HTMLCanvasElement; frame: number }>();
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = (performance.now() - t0) / 1000;
      ctx.clearRect(0, 0, W, H);
      if (effBg !== "transparent") { ctx.fillStyle = effBg; ctx.fillRect(0, 0, W, H); }
      for (const pl of placedC) {
        const clip = clips.find((c) => c.id === pl.clipId);
        if (!clip) continue;
        const fi = Math.floor(t * clip.fps) % clip.seq.length;
        const pw = Math.max(24, Math.round(pl.w * W));
        let o = off.get(pl.id);
        if (!o || o.c.width !== pw) { const c2 = document.createElement("canvas"); c2.width = pw; c2.height = pw; o = { c: c2, frame: -1 }; off.set(pl.id, o); }
        if (o.frame !== fi) {
          const sq = clip.seq[fi];
          const c2x = o.c.getContext("2d")!;
          drawFrame(c2x, clip.frames[sq.idx], sharedView([clip.frames[sq.idx]], pw, pw, 6), pw, pw, "transparent", sq.upTo);
          o.frame = fi;
        }
        ctx.drawImage(o.c, Math.round(pl.x * W - pw / 2), Math.round(pl.y * H - pw / 2));
        if (pl.id === selC) {
          ctx.strokeStyle = "rgba(40,120,255,0.9)"; ctx.setLineDash([5, 4]); ctx.lineWidth = 2;
          ctx.strokeRect(pl.x * W - pw / 2, pl.y * H - pw / 2, pw, pw);
          ctx.setLineDash([]);
        }
      }
      if (!placedC.length) {
        ctx.fillStyle = "rgba(100,105,115,0.8)"; ctx.font = "13px sans-serif"; ctx.textAlign = "center";
        ctx.fillText("Render a clip, then “Add to collage” - arrange several here.", W / 2, H / 2);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [collage, placedC, clips, selC, W, H, effBg]);

  const collagePt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const onCDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pt = collagePt(e);
    for (let i = placedC.length - 1; i >= 0; i--) {
      const pl = placedC[i];
      const hw = (pl.w * W) / 2 / W, hh = (pl.w * W) / 2 / H;
      if (Math.abs(pt.x - pl.x) < hw && Math.abs(pt.y - pl.y) < hh) {
        setSelC(pl.id);
        dragC.current = { id: pl.id, ox: pl.x - pt.x, oy: pl.y - pt.y };
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
    }
    setSelC(null);
  };
  const onCMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragC.current) return;
    const pt = collagePt(e); const d = dragC.current;
    setPlacedC((ps) => ps.map((pl) => (pl.id === d.id ? { ...pl, x: Math.min(1, Math.max(0, pt.x + d.ox)), y: Math.min(1, Math.max(0, pt.y + d.oy)) } : pl)));
  };
  const onCUp = () => { dragC.current = null; };

  // Composed export: duration = the longest clip loop, stepped at the export fps.
  const collageFrameCount = () => {
    const secs = Math.max(1, ...placedC.map((pl) => { const c = clips.find((x) => x.id === pl.clipId); return c ? c.seq.length / c.fps : 1; }));
    return Math.min(600, Math.round(secs * fps));
  };
  const drawCollageAt = (ctx: CanvasRenderingContext2D, t: number, bg: string) => {
    ctx.clearRect(0, 0, W, H);
    if (bg !== "transparent") { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }
    for (const pl of placedC) {
      const clip = clips.find((c) => c.id === pl.clipId);
      if (!clip) continue;
      const fi = Math.floor(t * clip.fps) % clip.seq.length;
      const sq = clip.seq[fi];
      const pw = Math.max(24, Math.round(pl.w * W));
      const c2 = document.createElement("canvas"); c2.width = pw; c2.height = pw;
      const c2x = c2.getContext("2d")!;
      drawFrame(c2x, clip.frames[sq.idx], sharedView([clip.frames[sq.idx]], pw, pw, 6), pw, pw, "transparent", sq.upTo);
      ctx.drawImage(c2, Math.round(pl.x * W - pw / 2), Math.round(pl.y * H - pw / 2));
    }
  };
  const exportCollageGif = async () => {
    if (!placedC.length || exporting) return;
    setExporting("Encoding collage GIF…");
    try {
      const { GIFEncoder, quantize, applyPalette } = await import("gifenc");
      const c = document.createElement("canvas"); c.width = W; c.height = H;
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      const gif = GIFEncoder();
      const transparent = effBg === "transparent";
      const format = transparent ? "rgba4444" : "rgb565";
      const n = collageFrameCount();
      for (let i = 0; i < n; i++) {
        setExporting(`Encoding collage GIF ${i + 1}/${n}…`);
        await new Promise((r) => setTimeout(r, 0));
        drawCollageAt(ctx, i / fps, effBg);
        const { data } = ctx.getImageData(0, 0, W, H);
        const palette = quantize(data, 256, { format, oneBitAlpha: transparent });
        gif.writeFrame(applyPalette(data, palette, format), W, H, { palette, delay: Math.round(1000 / fps), transparent });
      }
      gif.finish();
      download(new Blob([new Uint8Array(gif.bytes())], { type: "image/gif" }), "animator-collage.gif");
    } finally { setExporting(null); }
  };
  const exportCollageVideo = async () => {
    if (!placedC.length || exporting) return;
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d")!;
    const mime = ["video/mp4", "video/webm;codecs=vp9", "video/webm"].find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m));
    if (!mime) { setExporting("Video isn't supported here - use the GIF export."); setTimeout(() => setExporting(null), 3200); return; }
    const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
    const vbg = effBg === "transparent" ? (ext === "webm" ? "transparent" : "#ffffff") : effBg;
    setExporting("Recording collage video…");
    const stream = c.captureStream(fps);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    const chunks: BlobPart[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise<void>((res) => { rec.onstop = () => res(); });
    rec.start();
    const n = collageFrameCount();
    for (let i = 0; i < n; i++) {
      setExporting(`Recording collage ${i + 1}/${n}…`);
      drawCollageAt(ctx, i / fps, vbg);
      await new Promise((r) => setTimeout(r, 1000 / fps));
    }
    rec.stop(); await done;
    download(new Blob(chunks, { type: mime.split(";")[0] }), `animator-collage.${ext}`);
    setExporting(null);
  };

  const first = frames?.[0];
  const mobile = useIsMobile();
  const [mtab, setMtab] = useState<"source" | "animation" | "director" | "look">("source");

  // ── Control groups (shared between the desktop sidebar and mobile tabs) ──
  const srcBox = (
    <SectionBox eyebrow="source">
      <ImagePick
        onImage={(im, n) => { setImg(im); setImgName(n); setFrames(null); }}
        onFile={(f) => { const r = new FileReader(); r.onload = () => setSrcDataUrl(String(r.result)); r.readAsDataURL(f); }}
        fileName={imgName} longSide={800}
        hint="Cutout photos keep their transparency - only the subject stitches." />
      {img && (
        <button onClick={() => void removeBackground()} disabled={!!bgRemoving}
          className="border border-hairline bg-bg px-2.5 py-1 text-[0.75rem] text-fg disabled:opacity-50 hover:bg-card">
          {bgRemoving ?? "Remove background"}
        </button>
      )}
      {(
        <div className="border-t border-hairline pt-2">
          <label className="inline-block cursor-pointer border border-hairline bg-bg px-2.5 py-1 text-[0.75rem] text-fg hover:bg-card">
            Batch: run several photos
            <input type="file" accept="image/*" multiple className="hidden"
              onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ""; if (fs.length) void runBatch(fs); }} />
          </label>
          <p className="mt-1 text-[0.6875rem] text-mid leading-relaxed">
            Every photo runs through the current settings and downloads as one ZIP - a GIF per photo, named by source.
          </p>
        </div>
      )}
      <div>
        <div className={`${LABEL} mb-1.5`}>Rendering</div>
        <ModeButtons small options={(Object.keys(PARAMS) as Mode[]).map((m) => [m, MODE_LABEL[m]] as const)} value={mode}
          onChange={(m) => { setMode(m); }} />
      </div>
    </SectionBox>
  );

  const animBox = (
    <SectionBox eyebrow="animation">
      <div>
        <div className={`${LABEL} mb-1.5`}>Type</div>
        <ModeButtons small options={[["sweep", "Parameter sweep"], ["stitchout", "Stitch-out draw"]] as const} value={anim}
          onChange={(a) => { setAnim(a); setFrames(null); }} />
      </div>
      {anim === "sweep" ? (
        <>
          <div>
            <div className={`${LABEL} mb-1.5`}>Moving dial</div>
            <ModeButtons small options={PARAMS[mode].map((p) => [p.key, p.label] as const)} value={param.key} onChange={pickParam} />
          </div>
          <div className="grid grid-cols-2 gap-x-4">
            <RangeRow label="From" value={from} min={param.min} max={param.max} step={param.step} onChange={(v) => { setFrom(v); setFrames(null); }} fmt={(v) => (param.step < 1 ? v.toFixed(2) : String(v))} />
            <RangeRow label="To" value={to} min={param.min} max={param.max} step={param.step} onChange={(v) => { setTo(v); setFrames(null); }} fmt={(v) => (param.step < 1 ? v.toFixed(2) : String(v))} />
          </div>
          <label className="flex items-center gap-1.5 text-[0.75rem] text-mid">
            <input type="checkbox" checked={bounce} onChange={(e) => setBounce(e.target.checked)} className="accent-accent" />
            Bounce back (loops smoothly)
          </label>
        </>
      ) : (
        <>
          <p className="text-[0.75rem] text-mid leading-relaxed">
            The design stays fixed and its stitches appear in sew order - like watching the machine run.
          </p>
        </>
      )}
      <div className="grid grid-cols-2 gap-x-4">
        <RangeRow label="Frames" value={frameCount} min={12} max={96} step={1} onChange={(v) => { setFrameCount(v); if (anim === "sweep") setFrames(null); }} />
        <RangeRow label="Hold end" value={holdEnd} min={0} max={24} step={1} onChange={setHoldEnd} fmt={(v) => `${v}`} />
      </div>
    </SectionBox>
  );

  const lookBox = (
    <SectionBox eyebrow="look">
      <div>
        <div className={`${LABEL} mb-1.5`}>Aspect</div>
        <ModeButtons small options={[["1:1", "1:1"], ["9:16", "9:16 (TikTok/Reels)"], ["4:5", "4:5 (IG)"], ["16:9", "16:9"]] as const} value={aspect} onChange={(v) => setAspect(v as typeof aspect)} />
      </div>
      <div>
        <div className={`${LABEL} mb-1.5`}>Resolution (long side)</div>
        <ModeButtons small options={[["768", "768"], ["1080", "1080"], ["1440", "1440"], ["2160", "2160"]] as const} value={String(res)} onChange={(v) => setRes(Number(v))} />
      </div>
      <div>
        <div className={`${LABEL} mb-1.5`}>Background</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {FABRICS.map((f) => (
            <button key={f.hex} title={f.name} onClick={() => setBg(f.hex)}
              className={`w-6 h-6 border ${bg === f.hex ? "border-accent border-2" : "border-hairline"}`} style={{ background: f.hex }} />
          ))}
          <button title="Transparent (GIF only)" onClick={() => setBg("transparent")}
            className={`w-6 h-6 border ${bg === "transparent" ? "border-accent border-2" : "border-hairline"}`}
            style={{ background: "repeating-conic-gradient(#ddd 0% 25%, #fff 0% 50%) 0 0 / 8px 8px" }} />
          <label className={`w-6 h-6 border cursor-pointer overflow-hidden ${bg === "custom" ? "border-accent border-2" : "border-hairline"}`}>
            <input type="color" value={customBg} onChange={(e) => { setCustomBg(e.target.value); setBg("custom"); }} className="w-8 h-8 -m-1 cursor-pointer" />
          </label>
        </div>
        {bg === "transparent" && (
          <p className="mt-1 text-[0.6875rem] text-mid">GIF and WebM video keep the transparency; MP4 (Safari) uses white.</p>
        )}
      </div>
      <RangeRow label="Speed" value={fps} min={6} max={30} step={1} onChange={setFps} fmt={(v) => `${v} fps`} />
    </SectionBox>
  );

  const dirBox = (
    <SectionBox eyebrow="director">
      <label className="flex items-center gap-1.5 text-[0.75rem] text-mid">
        <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} className="accent-accent" />
        Photo reveal - the photo fades away as stitching arrives (stitch-out)
      </label>
      <label className="flex items-center gap-1.5 text-[0.75rem] text-mid">
        <input type="checkbox" checked={kenburns} onChange={(e) => setKenburns(e.target.checked)} className="accent-accent" />
        Slow push-in (Ken Burns)
      </label>
      <label className="flex items-center gap-1.5 text-[0.75rem] text-mid">
        <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} className="accent-accent" />
        Stitch counter + thread legend
      </label>
      <label className="flex items-center gap-1.5 text-[0.75rem] text-mid">
        <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} className="accent-accent" />
        Machine sound (video exports)
      </label>
      <label className="flex items-center gap-1.5 text-[0.75rem] text-mid">
        <input type="checkbox" checked={arena} onChange={(e) => setArena(e.target.checked)} className="accent-accent" />
        Fit GIFs for Are.na (≤25 MB - thins frames first, resolution last)
      </label>
      <input value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={60} placeholder="Caption (optional) - e.g. @baysidesf"
        className="w-full border border-hairline bg-bg text-fg px-2 py-1 text-[0.8125rem]" />
    </SectionBox>
  );

  const playback = frames && sequence.length > 1 ? (
    <div className="flex items-center gap-2 min-w-0 flex-1">
      <button onClick={() => setScrub(scrub === null ? 0 : null)} className="border border-hairline bg-bg px-2 py-1 text-[0.75rem] text-fg hover:bg-card w-14 shrink-0">
        {scrub === null ? "Pause" : "Play"}
      </button>
      <input type="range" min={0} max={sequence.length - 1} value={scrub ?? 0} disabled={scrub === null}
        onChange={(e) => setScrub(Number(e.target.value))} className="flex-1 min-w-0 accent-accent disabled:opacity-40" />
    </div>
  ) : (
    <p className="flex-1 min-w-0 truncate text-[0.75rem] text-mid">
      {first
        ? `${frames!.length} frames · ${(sequence.length / fps).toFixed(1)}s loop · ${fmtSize(first.built.stats.widthMm, first.built.stats.heightMm, units)}`
        : img ? (previewF ? "Previewing the last frame - Render frames to animate." : "Rendering preview…") : "Load a photo to begin."}
    </p>
  );

  const actions = progress ? (
    <div className="flex items-center gap-2">
      <p className="text-[0.75rem] text-mid truncate max-w-[16rem]">{progress}</p>
      <button onClick={() => { cancelRef.current = true; }} className="border border-hairline bg-bg px-2.5 py-1.5 text-[0.75rem] text-fg hover:bg-card shrink-0">Cancel</button>
    </div>
  ) : (
    <div className="flex flex-wrap items-center justify-end gap-1.5 shrink-0">
      {exporting && <p className="text-[0.6875rem] text-mid truncate max-w-[10rem]">{exporting}</p>}
      {exporting && (
        <button onClick={() => { cancelRef.current = true; }} title="Stop this export"
          className="border border-hairline bg-bg px-2 py-1 text-[0.75rem] text-fg hover:bg-card shrink-0">
          Cancel
        </button>
      )}
      <button onClick={() => void generate()} disabled={!img}
        className="border border-fg bg-fg text-bg px-3 py-1.5 text-[0.8125rem] disabled:opacity-40 hover:opacity-85 whitespace-nowrap">
        {frames ? "Re-render" : "Render frames"}
      </button>
      <button onClick={() => void exportGif()} disabled={!frames || !!exporting}
        className="border border-hairline bg-bg px-3 py-1.5 text-[0.8125rem] text-fg disabled:opacity-40 hover:bg-card whitespace-nowrap">
        GIF
      </button>
      <button onClick={() => void exportVideo()} disabled={!frames || !!exporting}
        className="border border-hairline bg-bg px-3 py-1.5 text-[0.8125rem] text-fg disabled:opacity-40 hover:bg-card whitespace-nowrap">
        Video
      </button>
      <button onClick={addToLibrary} disabled={!frames}
        className="border border-hairline bg-bg px-3 py-1.5 text-[0.8125rem] text-fg disabled:opacity-40 hover:bg-card whitespace-nowrap"
        title="Save this render as a clip and arrange several on one canvas">
        ＋ Collage
      </button>
      <button
        onClick={async () => {
          if (!frames || !view || exporting) return;
          const c = document.createElement("canvas"); c.width = W; c.height = H;
          const ctx = c.getContext("2d", { willReadFrequently: true })!;
          drawStyled(ctx, frames[sequence.length ? sequence[sequence.length - 1].idx : 0], view, W, H, effBg, sequence.length - 1, sequence.length, undefined);
          void saveBlob(await canvasToPngPpi(c, 300), `${baseName()}.png`);
        }}
        disabled={!frames || !!exporting}
        className="border border-hairline bg-bg px-3 py-1.5 text-[0.8125rem] text-fg disabled:opacity-40 hover:bg-card whitespace-nowrap"
        title="The final styled frame as a 300 PPI PNG">
        PNG
      </button>
      <button
        onClick={() => {
          const f = (frames && frames.length
            ? (scrub !== null && sequence[scrub] ? frames[sequence[scrub].idx] : frames[frames.length - 1])
            : previewF);
          if (f) downloadDesign(f.built, f.colors, "bayside-animate", "dst");
        }}
        disabled={!frames && !previewF}
        className="border border-hairline bg-bg px-3 py-1.5 text-[0.8125rem] text-fg disabled:opacity-40 hover:bg-card whitespace-nowrap"
        title="The frame currently shown, as a real stitch file">
        Download .dst
      </button>
    </div>
  );

  const canvasZone = (
    <div className="flex-1 min-h-0 flex items-center justify-center p-2">
      <canvas ref={canvasRef} className="border border-hairline"
        style={{ maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto", aspectRatio: `${W} / ${H}`,
          background: effBg === "transparent" ? "repeating-conic-gradient(#eee 0% 25%, #fff 0% 50%) 0 0 / 16px 16px" : effBg }} />
    </div>
  );

  const topBar = (
    <div className="shrink-0 border-b border-hairline bg-card px-3 py-1.5 flex items-baseline gap-3">
      <button onClick={() => { window.location.hash = ""; }} className="text-[0.75rem] text-accent hover:underline shrink-0">← Workspace</button>
      <span className="font-serif text-[1.0625rem] text-fg">Animator</span>
      <span className="text-[0.75rem] text-mid truncate hidden sm:inline">renderings → GIF / video, straight from the engine</span>
      <span className="ml-auto flex border border-hairline">
        {([[false, "Editor"], [true, `Collage${clips.length ? ` · ${clips.length}` : ""}`]] as const).map(([v, label]) => (
          <button key={label} onClick={() => setCollage(v)}
            className={`px-2.5 py-0.5 text-[0.6875rem] uppercase tracking-[0.06em] ${collage === v ? "bg-fg text-bg" : "bg-bg text-mid hover:text-fg"}`}>
            {label}
          </button>
        ))}
      </span>
    </div>
  );

  const selPlaced = placedC.find((pl) => pl.id === selC) ?? null;
  const collageZone = (
    <div className="flex-1 min-h-0 flex items-center justify-center p-2">
      <canvas ref={collageRef} onPointerDown={onCDown} onPointerMove={onCMove} onPointerUp={onCUp} onPointerCancel={onCUp}
        className="border border-hairline touch-none cursor-move"
        style={{ maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto", aspectRatio: `${W} / ${H}`,
          background: effBg === "transparent" ? "repeating-conic-gradient(#eee 0% 25%, #fff 0% 50%) 0 0 / 16px 16px" : effBg }} />
    </div>
  );
  const collageBar = (
    <div className="shrink-0 border-t border-hairline px-3 py-2 flex items-center gap-3 flex-wrap">
      {selPlaced ? (
        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <span className="text-[0.6875rem] text-mid shrink-0">Size</span>
          <input type="range" min={0.12} max={1} step={0.01} value={selPlaced.w}
            onChange={(e) => setPlacedC((ps) => ps.map((pl) => (pl.id === selPlaced.id ? { ...pl, w: Number(e.target.value) } : pl)))}
            className="flex-1 min-w-0 accent-accent" />
          <button onClick={() => { setPlacedC((ps) => ps.filter((pl) => pl.id !== selPlaced.id)); setSelC(null); }}
            className="border border-hairline bg-bg px-2 py-1 text-[0.75rem] text-fg hover:bg-card shrink-0">Remove</button>
        </div>
      ) : (
        <p className="flex-1 min-w-[200px] text-[0.75rem] text-mid">
          {placedC.length ? "Drag clips to arrange; tap one to resize. Each loops at its own speed." : "Render a clip in the Editor, then ＋ Collage."}
        </p>
      )}
      {exporting && <p className="text-[0.6875rem] text-mid truncate max-w-[12rem]">{exporting}</p>}
      <div className="flex items-center gap-1.5 shrink-0">
        <button onClick={() => void exportCollageGif()} disabled={!placedC.length || !!exporting}
          className="border border-fg bg-fg text-bg px-3 py-1.5 text-[0.8125rem] disabled:opacity-40 hover:opacity-85">GIF</button>
        <button onClick={() => void exportCollageVideo()} disabled={!placedC.length || !!exporting}
          className="border border-hairline bg-bg px-3 py-1.5 text-[0.8125rem] text-fg disabled:opacity-40 hover:bg-card">Video</button>
      </div>
    </div>
  );

  // ── Zero-scroll shells ──
  if (mobile) {
    return (
      <div className="h-full flex flex-col bg-bg overflow-hidden">
        {topBar}
        {collage ? collageZone : canvasZone}
        {collage ? collageBar : <div className="shrink-0 border-t border-hairline px-3 py-1.5">{playback}</div>}
        <div className="shrink-0 border-t border-hairline flex">
          {([["source", "Source"], ["animation", "Animation"], ["director", "Director"], ["look", "Look"]] as const).map(([id, label]) => (
            <button key={id} onClick={() => setMtab(id)}
              className={`flex-1 py-1.5 text-[0.6875rem] uppercase tracking-[0.06em] ${mtab === id ? "bg-fg text-bg" : "bg-card text-mid"}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="shrink-0 h-[200px] overflow-y-auto overscroll-contain px-2 py-2">
          {mtab === "source" ? srcBox : mtab === "animation" ? animBox : mtab === "director" ? dirBox : lookBox}
        </div>
        <div className="shrink-0 border-t border-hairline bg-bg px-3 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] flex justify-end">{actions}</div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-bg overflow-hidden">
      {topBar}
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        <div className="flex-1 min-h-0 flex flex-col bg-card/40">
          {collage ? collageZone : canvasZone}
        </div>
        {collage ? collageBar : (
          <>
            <div className="shrink-0 border-t border-hairline bg-bg px-3 py-1.5 flex items-center gap-4">
              {playback}
              {actions}
            </div>
            {/* control deck - every section visible at once, fixed height */}
            <div className="shrink-0 h-[280px] border-t border-hairline bg-bg grid grid-cols-4 divide-x divide-hairline overflow-hidden">
              <div className="overflow-y-auto p-2">{srcBox}</div>
              <div className="overflow-y-auto p-2">{animBox}</div>
              <div className="overflow-y-auto p-2">{dirBox}</div>
              <div className="overflow-y-auto p-2">{lookBox}</div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
