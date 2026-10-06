// Animated Lettering - lettering as a motion asset. Type a word (Hershey
// stroke/satin faces, or your own OTF/TTF outlined or filled), and the design
// writes itself out in reading order with real timing control: duration, fps,
// easing, stroke-snap, forward/reverse/bounce, hold. Frame it for the asset
// you're making (1:1, 9:16, 4:5, 16:9 at up to 2160px), on transparent or
// fabric, and export a transparent GIF, video, PNG still - or the same build
// as a real DST/PES stitch file.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ToolLayout,
  useIsMobile,
  SectionBox,
  RangeRow,
  ModeButtons,
  DropZone,
  ThreadRow,
  Warning,
  buildDesign,
  downloadDesign,
  useDebouncedKey,
  LABEL,
  FABRICS,
  type Built,
} from "./shared";
import { pathsToStitches, resamplePath } from "../lib/generators";
import { renderPattern } from "../lib/render";
import { CMD } from "../lib/pattern";
import { encodeGifFit } from "../lib/gif";
import { saveBlob } from "../lib/native";
import { canvasToPngPpi } from "../lib/png";
import { layoutText, letteringSatinPaths, orderStrokes, buildOutlineText } from "./lettering";
import { writingOrderPattern } from "./animexport";
import { HERSHEY_PICKER_IDS, HERSHEY_FACES, type HersheyFaceId } from "./data/hershey";
import { layoutOutlineText, type OTFont } from "../lib/outlinefont";
import { THREADS } from "../../data/threads";
import { STAFF_FONTS } from "./data/staffFonts";
import { getRole } from "../account";
import { listUserFonts, syncUserFonts, addUserFont, removeUserFont, clearUserFonts, fontBytes, type UserFont } from "../lib/fontlib";

const NAME = "bayside-letteranim";
const DEFAULT_THREAD = THREADS.find((t) => t.code === "1568")?.hex ?? "#26324d";
void layoutOutlineText;

type Style = "stroke" | "satin" | "outline" | "fill";
type Ease = "linear" | "easeInOut" | "easeOut";
type Direction = "forward" | "reverse" | "inout";
type Aspect = "1:1" | "9:16" | "4:5" | "16:9";
const ASPECTS: Record<Aspect, number> = { "1:1": 1, "9:16": 9 / 16, "4:5": 4 / 5, "16:9": 16 / 9 };

const ease = (t: number, kind: Ease): number =>
  kind === "linear" ? t
  : kind === "easeOut" ? 1 - (1 - t) * (1 - t)
  : t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;

export default function LetterAnimTool() {
  // ── Text & style ──
  const [text, setText] = useState("Bayside");
  const [faceId, setFaceId] = useState<HersheyFaceId>("script");
  const [style, setStyle] = useState<Style>("stroke");
  const [heightMm, setHeightMm] = useState(30);
  const [spacing, setSpacing] = useState(1);
  const [lineSpacing, setLineSpacing] = useState(1.4);
  const [textAlign, setTextAlign] = useState<"left" | "center" | "right">("center");
  const [arcDeg, setArcDeg] = useState(0);
  const [satinWidth, setSatinWidth] = useState(2.2);
  const [threadHex, setThreadHex] = useState(DEFAULT_THREAD);
  const [customFont, setCustomFont] = useState<OTFont | null>(null);
  const [customName, setCustomName] = useState("");
  const [fontError, setFontError] = useState<string | null>(null);
  const [myFonts, setMyFonts] = useState<UserFont[]>([]);
  useEffect(() => {
    listUserFonts().then(setMyFonts);
    syncUserFonts().then(setMyFonts).catch(() => {});
  }, []);
  // ── Motion ──
  const [durS, setDurS] = useState(2.5);
  const [fps, setFps] = useState(24);
  const [holdS, setHoldS] = useState(1);
  const [easeKind, setEaseKind] = useState<Ease>("easeInOut");
  const [snap, setSnap] = useState(false);
  const [order, setOrder] = useState<"writing" | "sew">("writing");
  const [direction, setDirection] = useState<Direction>("forward");
  const [holdEmptyS, setHoldEmptyS] = useState(0.5);
  const [exitOrder, setExitOrder] = useState<"retract" | "sweep">("retract");
  // ── Frame ──
  const [aspect, setAspect] = useState<Aspect>("1:1");
  const [res, setRes] = useState(1080);
  const [padPct, setPadPct] = useState(10);
  const [scalePct, setScalePct] = useState(80);
  const [bg, setBg] = useState<string>("transparent");
  const [hAlign, setHAlign] = useState<"left" | "center" | "right">("center");
  const [vAlign, setVAlign] = useState<"top" | "middle" | "bottom">("middle");
  // ── Export ──
  const [arena, setArena] = useState(false);
  const [formats, setFormats] = useState<Set<string>>(new Set(["gif"]));
  const toggleFormat = (f: string) =>
    setFormats((cur) => { const n = new Set(cur); if (n.has(f)) n.delete(f); else n.add(f); return n; });
  const [exporting, setExporting] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const loadFont = async (file: File) => {
    setFontError(null);
    try {
      const buf = await file.arrayBuffer();
      const opentype = await import("opentype.js");
      const parse = (opentype as unknown as { parse: (b: ArrayBuffer) => OTFont }).parse
        ?? (opentype as unknown as { default: { parse: (b: ArrayBuffer) => OTFont } }).default.parse;
      const font = parse(buf);
      font.charToGlyph("A").getPath(0, 0, font.unitsPerEm);
      setCustomFont(font);
      setCustomName(file.name.replace(/\.(ttf|otf|woff2?)$/i, ""));
      setStyle("fill");
      // persist: dataURL into the shared font library (local + account)
      const bytes = new Uint8Array(buf);
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      void addUserFont(file.name, `data:font/ttf;base64,${btoa(bin)}`).then(() => listUserFonts().then(setMyFonts));
    } catch {
      setFontError("Couldn't read that font - use a .ttf, .otf, or .woff file.");
      setCustomFont(null);
    }
  };


  const loadFonts = async (files: File[]) => {
    let okCount = 0, fail = 0;
    for (const f of files) {
      // last successful file stays active; every good one lands in the library
      try {
        await loadFont(f);
        okCount++;
      } catch { fail++; }
    }
    if (fail) setFontError(`${okCount} added, ${fail} couldn't be read.`);
  };

  const genKey = useDebouncedKey([text, faceId, style, heightMm, spacing, lineSpacing, textAlign, arcDeg, satinWidth, customName], 220);
  const builds = useMemo<{ machine: Built; visual: Built } | null>(() => {
    if (!text.trim()) return null;
    if (customFont && (style === "outline" || style === "fill")) {
      const opts = {
        text, heightMm, letterSpacing: spacing, lineSpacing, align: textAlign,
        style: (style === "fill" ? "fill" : "outline") as "fill" | "outline",
        fillAngleDeg: 45, fillDensityMm: 0.45, outlinePass: style === "fill", stitchLenMm: 2, bean: 1 as const,
      };
      const machine = buildOutlineText(customFont, opts);
      if (!machine) return null;
      // fills link sections with real boundary-travel stitches (correct on the
      // machine, hidden under the outline) - the visual build uses jumps so
      // GIF/video/PNG renders stay clean
      const visual = style === "fill" ? buildOutlineText(customFont, { ...opts, travel: "jump" }) ?? machine : machine;
      return { machine, visual };
    }
    const strokes = orderStrokes(layoutText({ text, faceId, heightMm, letterSpacing: spacing, lineSpacing, arcDeg, align: textAlign, stitchLenMm: 1.6 }));
    if (!strokes.length) return null;
    const paths = style === "satin"
      ? letteringSatinPaths(strokes, satinWidth)
      : strokes.map((p) => resamplePath(p, 1.8, 0.3));
    const b = buildDesign(pathsToStitches(paths, style === "stroke" ? 3 : 1), NAME);
    return b ? { machine: b, visual: b } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genKey, customFont]);
  const built = builds?.visual ?? null;

  // Reveal pattern + stroke boundaries for snap mode. Writing order sorts
  // strokes by line then left-to-right; lines are found by quantizing each
  // stroke's center-y against the KNOWN line pitch (y-clustering failed for
  // script faces whose ascenders/descenders overlap between lines). Sew order
  // uses the design's true machine order untouched.
  const anim = useMemo(() => {
    if (!built) return null;
    const pattern = order === "writing"
      ? writingOrderPattern(built.pattern, heightMm * 10 * lineSpacing, text.split("\n").filter((l) => l.trim()).length)
      : built.pattern;
    const runEnds: number[] = [];
    for (let i = 1; i < pattern.stitches.length; i++)
      if (pattern.stitches[i].cmd === CMD.JUMP || pattern.stitches[i].cmd === CMD.TRIM) runEnds.push(i);
    runEnds.push(pattern.stitches.length);
    // Reversed pattern for "sweep" exits: run order and in-run order flipped,
    // jump flags rebuilt, so drawing its prefix shows the TAIL of the text -
    // i.e. the first letters leave first.
    const runs: (typeof pattern.stitches)[] = [];
    let cur: typeof pattern.stitches = [];
    for (const q of pattern.stitches) {
      if (q.cmd === CMD.JUMP && cur.length) { runs.push(cur); cur = []; }
      cur.push(q);
    }
    if (cur.length) runs.push(cur);
    const rev: typeof pattern.stitches = [];
    for (let r = runs.length - 1; r >= 0; r--) {
      const run = runs[r];
      for (let i = run.length - 1; i >= 0; i--) {
        const q = run[i];
        rev.push({ x: q.x, y: q.y, cmd: i === run.length - 1 ? CMD.JUMP : CMD.STITCH });
      }
    }
    const reversed = { ...pattern, stitches: rev };
    return { pattern, reversed, runEnds, total: pattern.stitches.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [built, order]);

  const W = Math.round(ASPECTS[aspect] >= 1 ? res : res * ASPECTS[aspect]);
  const H = Math.round(ASPECTS[aspect] >= 1 ? res / ASPECTS[aspect] : res);
  const FR = Math.max(4, Math.round(durS * fps));
  const HOLD = Math.round(holdS * fps);
  const HOLDE = Math.round(holdEmptyS * fps);
  const CYCLE = direction === "inout" ? FR * 2 + HOLD + HOLDE : FR + HOLD;

  /** Frame index → what to draw: which pattern and how many stitches. */
  const frameState = (i: number): { pat: "fwd" | "rev"; upTo: number | undefined } => {
    if (!anim) return { pat: "fwd", upTo: undefined };
    const shape = (t: number): number | undefined => {
      const p = ease(Math.max(0, Math.min(1, t)), easeKind);
      let upTo = Math.max(2, Math.round(p * anim.total));
      if (snap) {
        let snapped = 2;
        for (const e of anim.runEnds) { if (e <= upTo) snapped = e; else break; }
        upTo = p >= 1 ? anim.total : snapped;
      }
      return upTo >= anim.total ? undefined : upTo;
    };
    if (direction === "inout") {
      if (i < FR) return { pat: "fwd", upTo: shape(i / (FR - 1)) };                 // write on
      if (i < FR + HOLD) return { pat: "fwd", upTo: undefined };                    // hold full
      if (i < FR * 2 + HOLD) {
        const t2 = (i - FR - HOLD) / (FR - 1);                                      // stitch out
        const remaining = shape(1 - t2);
        if (exitOrder === "retract") return { pat: "fwd", upTo: remaining ?? undefined };
        return { pat: "rev", upTo: remaining ?? undefined };
      }
      return { pat: "fwd", upTo: 0 };                                               // hold empty
    }
    const j = Math.min(i, FR - 1);
    let t = j / (FR - 1);
    if (direction === "reverse") t = 1 - t;
    if (i >= FR) t = direction === "reverse" ? 0 : 1;
    return { pat: "fwd", upTo: shape(t) };
  };

  const drawFrame = (ctx: CanvasRenderingContext2D, i: number, forceBg?: string | null) => {
    ctx.clearRect(0, 0, W, H);
    const b = forceBg === undefined ? (bg === "transparent" ? null : bg) : forceBg;
    if (b) { ctx.fillStyle = b; ctx.fillRect(0, 0, W, H); }
    if (!anim) return;
    // fit into the padded box, then anchor per alignment
    const pad = (padPct / 100) * Math.min(W, H);
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (const q of anim.pattern.stitches) { if (q.x < mnx) mnx = q.x; if (q.x > mxx) mxx = q.x; if (q.y < mny) mny = q.y; if (q.y > mxy) mxy = q.y; }
    const bw = Math.max(1, mxx - mnx), bh = Math.max(1, mxy - mny);
    const scale = Math.min((W - 2 * pad) / bw, (H - 2 * pad) / bh) * (scalePct / 100);
    const slackX = W - 2 * pad - bw * scale, slackY = H - 2 * pad - bh * scale;
    const view = {
      scale,
      offsetX: pad - mnx * scale + (hAlign === "left" ? 0 : hAlign === "right" ? slackX : slackX / 2),
      offsetY: pad - mny * scale + (vAlign === "top" ? 0 : vAlign === "bottom" ? slackY : slackY / 2),
    };
    const fs = frameState(i);
    if (fs.upTo === 0) return; // hold-empty frames show bare background
    renderPattern(ctx, fs.pat === "rev" ? anim.reversed : anim.pattern, view, { colors: [threadHex], sheen: true, threadMm: style === "satin" ? 0.5 : 0.42, upTo: fs.upTo });
  };

  // Live looping preview.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = W; c.height = H;
    const ctx = c.getContext("2d")!;
    let raf = 0; let last = 0; let frame = 0;
    const step = (ts: number) => {
      if (ts - last >= 1000 / fps) { last = ts; drawFrame(ctx, frame % CYCLE); frame++; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anim, W, H, fps, CYCLE, threadHex, bg, padPct, easeKind, snap, direction, hAlign, vAlign, exitOrder, scalePct]);

  const exportGif = async () => {
    if (!anim || exporting) return;
    cancelRef.current = false;
    setExporting("Encoding GIF…");
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    try {
      const { bytes, note } = await encodeGifFit(
        (i) => { drawFrame(ctx, i); return c; },
        W, H, CYCLE, 1000 / fps, bg === "transparent",
        arena ? 25 * 1024 * 1024 : null,
        (m) => setExporting(m), () => cancelRef.current,
      );
      void saveBlob(new Blob([new Uint8Array(bytes)], { type: "image/gif" }), `${NAME}-${text.slice(0, 12)}.gif`);
      if (note) { setExporting(`Are.na ${note}`); setTimeout(() => setExporting(null), 3600); return; }
      setExporting(null);
    } catch (e) {
      setExporting(null);
      if ((e as Error).message !== "cancelled") throw e;
    }
  };

  const exportVideo = async () => {
    if (!anim || exporting) return;
    cancelRef.current = false;
    const mime = ["video/webm;codecs=vp9", "video/webm", "video/mp4"].find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m));
    if (!mime) { setExporting("Video isn't supported here - use the GIF."); setTimeout(() => setExporting(null), 3000); return; }
    const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d")!;
    setExporting("Recording…");
    const stream = c.captureStream(fps);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
    const chunks: BlobPart[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise<void>((r) => { rec.onstop = () => r(); });
    rec.start();
    let cancelled = false;
    for (let i = 0; i < CYCLE; i++) {
      if (cancelRef.current) { cancelled = true; break; }
      setExporting(`Recording ${i + 1}/${CYCLE}…`);
      drawFrame(ctx, i, bg === "transparent" ? (ext === "webm" ? null : "#ffffff") : bg);
      await new Promise((r) => setTimeout(r, 1000 / fps));
    }
    rec.stop(); await done;
    if (!cancelled) void saveBlob(new Blob(chunks, { type: mime.split(";")[0] }), `${NAME}-${text.slice(0, 12)}.${ext}`);
    setExporting(null);
  };

  const exportPng = async () => {
    if (!anim) return;
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    drawFrame(c.getContext("2d")!, CYCLE + 1);
    void saveBlob(await canvasToPngPpi(c, 300), `${NAME}-${text.slice(0, 12)}.png`);
  };


  const exportSelected = async () => {
    if (!built || exporting) return;
    if (formats.has("gif")) await exportGif();
    if (formats.has("video")) await exportVideo();
    if (formats.has("png")) await exportPng();
    if (builds && formats.has("dst")) downloadDesign(builds.machine, [threadHex], NAME, "dst");
    if (builds && formats.has("jef")) downloadDesign(builds.machine, [threadHex], NAME, "jef");
    if (builds && formats.has("pes")) downloadDesign(builds.machine, [threadHex], NAME, "pes");
  };

  const faceOptions = HERSHEY_PICKER_IDS.map((id) => [id, HERSHEY_FACES[id].name] as [HersheyFaceId, string]);

  const mobile = useIsMobile();
  const controls = (
        <>
          <SectionBox eyebrow="text">
            <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={240} rows={2}
              placeholder="One line - or several"
              className="w-full border border-hairline bg-bg text-fg px-2.5 py-2 text-[1rem] font-serif leading-snug resize-y" />
            {!customFont && (
              <>
                <div>
                  <div className={`${LABEL} mb-1.5`}>Face</div>
                  <select value={faceId} onChange={(e) => setFaceId(e.target.value as HersheyFaceId)}
                    className="w-full border border-hairline bg-bg text-fg px-2 py-1.5 text-[0.8125rem]">
                    {faceOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                  </select>
                </div>
                <ModeButtons small options={[["stroke", "Stroke"], ["satin", "Satin"]] as [Style, string][]} value={style} onChange={setStyle} />
                {style === "satin" && <RangeRow label="Satin width" value={satinWidth} min={1.2} max={4} step={0.1} onChange={setSatinWidth} fmt={(v) => `${v.toFixed(1)} mm`} />}
                <RangeRow label="Arc" value={arcDeg} min={-120} max={120} step={5} onChange={setArcDeg} fmt={(v) => `${v}°`} />
              </>
            )}
            {customFont && (
              <ModeButtons small options={[["fill", "Filled"], ["outline", "Outline"]] as [Style, string][]} value={style} onChange={setStyle} />
            )}
            <RangeRow label="Cap height" value={heightMm} min={10} max={80} step={1} onChange={setHeightMm} fmt={(v) => `${v} mm`} />
            <RangeRow label="Letter spacing" value={spacing} min={0.7} max={1.8} step={0.05} onChange={setSpacing} fmt={(v) => `×${v.toFixed(2)}`} />
            {text.includes("\n") && (
              <>
                <RangeRow label="Line spacing" value={lineSpacing} min={1} max={2.4} step={0.05} onChange={setLineSpacing} fmt={(v) => `×${v.toFixed(2)}`} />
                <div>
                  <div className={`${LABEL} mb-1.5`}>Text align</div>
                  <ModeButtons small options={[["left", "Left"], ["center", "Center"], ["right", "Right"]] as ["left" | "center" | "right", string][]} value={textAlign} onChange={setTextAlign} />
                </div>
              </>
            )}
            {myFonts.length > 0 && (
              <div>
                <div className={`${LABEL} mb-1.5`}>My fonts</div>
                <div className="flex items-center gap-1.5">
                  <select
                    value={customName && myFonts.some((f) => f.name === customName) ? customName : ""}
                    onChange={async (e) => {
                      const f = myFonts.find((x) => x.name === e.target.value);
                      if (!f) return;
                      try {
                        const buf = await fontBytes(f);
                        const opentype = await import("opentype.js");
                        const parse = (opentype as unknown as { parse: (b: ArrayBuffer) => OTFont }).parse
                          ?? (opentype as unknown as { default: { parse: (b: ArrayBuffer) => OTFont } }).default.parse;
                        setCustomFont(parse(buf));
                        setCustomName(f.name);
                        setStyle("fill");
                        setFontError(null);
                      } catch { setFontError(`Couldn't load "${f.name}" - remove it below if it keeps failing.`); }
                    }}
                    className="flex-1 border border-hairline bg-bg text-fg px-2 py-1.5 text-[0.8125rem]"
                  >
                    <option value="">Pick a saved font…</option>
                    {myFonts.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                  </select>
                  {customName && myFonts.some((f) => f.name === customName) && (
                    <button title="Remove from my fonts" aria-label="Remove from my fonts"
                      onClick={() => { void removeUserFont(customName).then(() => listUserFonts().then(setMyFonts)); }}
                      className="border border-hairline bg-bg px-2 py-1.5 text-[0.75rem] text-mid hover:text-fg">✕</button>
                  )}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <select value="" onChange={(e) => {
                      const n = e.target.value;
                      if (n) void removeUserFont(n).then(() => listUserFonts().then(setMyFonts));
                    }}
                    className="border border-hairline bg-bg text-mid px-2 py-1 text-[0.6875rem]">
                    <option value="">Remove a saved font…</option>
                    {myFonts.map((f) => <option key={f.name} value={f.name}>✕ {f.name}</option>)}
                  </select>
                  <button onClick={() => { void clearUserFonts().then(() => listUserFonts().then(setMyFonts)); }}
                    className="border border-hairline bg-bg px-2 py-1 text-[0.6875rem] text-mid hover:text-fg">
                    Clear all saved fonts
                  </button>
                </div>
              </div>
            )}
            {["staff", "admin"].includes(getRole()) && (
              <div>
                <div className={`${LABEL} mb-1.5`}>Studio fonts (staff)</div>
                <select
                  value={customName && STAFF_FONTS.some((f) => f.name === customName) ? customName : ""}
                  onChange={async (e) => {
                    const f = STAFF_FONTS.find((x) => x.name === e.target.value);
                    if (!f) return;
                    try {
                      const buf = await (await fetch(`/staff-fonts/${f.file}`)).arrayBuffer();
                      const opentype = await import("opentype.js");
                      const parse = (opentype as unknown as { parse: (b: ArrayBuffer) => OTFont }).parse
                        ?? (opentype as unknown as { default: { parse: (b: ArrayBuffer) => OTFont } }).default.parse;
                      const font = parse(buf);
                      setCustomFont(font);
                      setCustomName(f.name);
                      setStyle("fill");
                      setFontError(null);
                    } catch {
                      setFontError("Couldn't load that studio font.");
                    }
                  }}
                  className="w-full border border-hairline bg-bg text-fg px-2 py-1.5 text-[0.8125rem]"
                >
                  <option value="">Pick a studio font…</option>
                  {STAFF_FONTS.map((f) => <option key={f.file} value={f.name}>{f.name}</option>)}
                </select>
              </div>
            )}
            <DropZone onFile={(f) => void loadFont(f)} onFiles={(fs) => void loadFonts(fs)} match={(f) => /\.(ttf|otf|woff2?)$/i.test(f.name) || f.type.includes("font")}>
            <label className="inline-block cursor-pointer border border-hairline bg-bg px-2.5 py-1 text-[0.75rem] text-fg hover:bg-card">
              {customFont ? `${customName} ✕ (remove)` : "Upload your own font (.ttf/.otf) - or drop it here"}
              <input type="file" accept=".ttf,.otf,.woff,.woff2" multiple className="hidden"
                onClick={(e) => { if (customFont) { e.preventDefault(); setCustomFont(null); setCustomName(""); setStyle("stroke"); } }}
                onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.currentTarget.value = ""; if (fs.length > 1) void loadFonts(fs); else if (fs[0]) void loadFont(fs[0]); }} />
            </label>
            </DropZone>
            {fontError && <Warning>{fontError}</Warning>}
            <ThreadRow hex={threadHex} onChange={setThreadHex} />
          </SectionBox>

          <SectionBox eyebrow="motion">
            <RangeRow label="Duration" value={durS} min={0.5} max={8} step={0.25} onChange={setDurS} fmt={(v) => `${v.toFixed(2)} s`} />
            <RangeRow label="Frame rate" value={fps} min={12} max={30} step={2} onChange={setFps} fmt={(v) => `${v} fps`} />
            <RangeRow label="Hold at end" value={holdS} min={0} max={4} step={0.25} onChange={setHoldS} fmt={(v) => `${v.toFixed(2)} s`} />
            <ModeButtons small options={[["linear", "Linear"], ["easeInOut", "Ease in-out"], ["easeOut", "Ease out"]] as [Ease, string][]} value={easeKind} onChange={setEaseKind} />
            <ModeButtons small options={[["forward", "Write on"], ["reverse", "Unstitch"], ["inout", "In & out"]] as [Direction, string][]} value={direction} onChange={setDirection} />
            {direction === "inout" && (
              <>
                <RangeRow label="Hold empty" value={holdEmptyS} min={0} max={2} step={0.25} onChange={setHoldEmptyS} fmt={(v) => `${v.toFixed(2)} s`} />
                <ModeButtons small options={[["retract", "Exit: last letters first"], ["sweep", "Exit: first letters first"]] as ["retract" | "sweep", string][]} value={exitOrder} onChange={setExitOrder} />
              </>
            )}
            <ModeButtons small options={[["writing", "Writing order"], ["sew", "Sew order"]] as ["writing" | "sew", string][]} value={order} onChange={setOrder} />
            <label className="flex items-center gap-2 text-[0.75rem] text-mid">
              <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} className="accent-accent" />
              snap stroke by stroke (each stroke lands whole - a pen-lift feel)
            </label>
          </SectionBox>

          <SectionBox eyebrow="frame">
            <ModeButtons small options={(Object.keys(ASPECTS) as Aspect[]).map((a) => [a, a] as [Aspect, string])} value={aspect} onChange={setAspect} />
            <ModeButtons small options={[[768, "768"], [1080, "1080"], [1440, "1440"], [2160, "2160"]] as [number, string][]} value={res} onChange={setRes} />
            <RangeRow label="Padding" value={padPct} min={2} max={25} step={1} onChange={setPadPct} fmt={(v) => `${v}%`} />
            <RangeRow label="Scale" value={scalePct} min={20} max={100} step={5} onChange={setScalePct} fmt={(v) => `${v}%`} />
            <div className={`${LABEL} -mb-1`}>Position</div>
            {scalePct >= 100 && (
              <p className="text-[0.6875rem] text-mid leading-snug">
                At 100% scale the design fills the frame, so position can’t move it -
                lower Scale to place it.
              </p>
            )}
            <ModeButtons small options={[["left", "Left"], ["center", "Center"], ["right", "Right"]] as ["left" | "center" | "right", string][]} value={hAlign} onChange={setHAlign} />
            <ModeButtons small options={[["top", "Top"], ["middle", "Middle"], ["bottom", "Bottom"]] as ["top" | "middle" | "bottom", string][]} value={vAlign} onChange={setVAlign} />
            <div>
              <div className={`${LABEL} mb-1.5`}>Background</div>
              <div className="flex flex-wrap items-center gap-1.5">
                <button onClick={() => setBg("transparent")} title="Transparent"
                  className={`w-6 h-6 border ${bg === "transparent" ? "border-accent border-2" : "border-hairline"}`}
                  style={{ background: "repeating-conic-gradient(#ddd 0% 25%, #fff 0% 50%) 0 0 / 8px 8px" }} />
                {FABRICS.map((f) => (
                  <button key={f.hex} title={f.name} onClick={() => setBg(f.hex)}
                    className={`w-6 h-6 border ${bg === f.hex ? "border-accent border-2" : "border-hairline"}`}
                    style={{ background: f.hex }} />
                ))}
              </div>
            </div>
          </SectionBox>

          <SectionBox eyebrow="export">
            <div className="flex flex-wrap items-center gap-1.5">
              {([["gif", "GIF"], ["video", "Video"], ["png", "PNG still"], ["dst", ".dst"], ["pes", ".pes"], ["jef", ".jef"]] as const).map(([f, label]) => (
                <button key={f} onClick={() => toggleFormat(f)} aria-pressed={formats.has(f)}
                  className={`border px-2.5 py-1.5 text-[0.75rem] ${formats.has(f) ? "border-fg bg-fg text-bg" : "border-hairline bg-bg text-mid hover:text-fg"}`}>
                  {formats.has(f) ? "✓ " : ""}{label}
                </button>
              ))}
              <button onClick={() => void exportSelected()} disabled={!built || !!exporting || formats.size === 0}
                className="border border-fg bg-fg text-bg px-3 py-1.5 text-[0.8125rem] disabled:opacity-40 hover:opacity-85 whitespace-nowrap">
                Export selected{formats.size > 1 ? ` (${formats.size})` : ""}
              </button>
            </div>
            <label className="flex items-center gap-1.5 text-[0.75rem] text-mid">
              <input type="checkbox" checked={arena} onChange={(e) => setArena(e.target.checked)} className="accent-accent" />
              Fit GIFs for Are.na (≤25 MB - thins frames first, resolution last)
            </label>
            {exporting && (
              <div className="flex items-center gap-2">
                <p className="flex-1 text-[0.75rem] text-mid">{exporting}</p>
                <button onClick={() => { cancelRef.current = true; }} className="border border-hairline bg-bg px-2 py-1 text-[0.75rem]">Cancel</button>
              </div>
            )}
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              GIFs keep the transparent background everywhere; video keeps it as WebM
              (MP4 on Safari gets white). The stitch file is the same build the
              animation draws.
            </p>
          </SectionBox>

          {built && built.stats.realStitches > 60000 && (
            <Warning>Over 60k stitches - shorter text, lower cap height, or lighter style before stitching.</Warning>
          )}
        </>
  );
  const preview = (
        <div className={mobile ? "flex flex-col items-center gap-1.5 h-full min-h-0 justify-center" : "flex flex-col items-center gap-2 lg:sticky lg:top-4"}>
          <canvas ref={canvasRef}
            className="border border-hairline max-w-full"
            style={{ maxHeight: mobile ? "100%" : "70vh", width: "auto", height: "auto",
              background: bg === "transparent" ? "repeating-conic-gradient(#eee 0% 25%, #fff 0% 50%) 0 0 / 16px 16px" : bg }} />
          <p className="text-[0.75rem] text-mid tabular-nums">
            {built ? `${built.stats.realStitches.toLocaleString()} stitches · ${W}×${H} · ${(CYCLE / fps).toFixed(1)}s loop` : "Type a word to animate it."}
          </p>
        </div>
  );
  if (mobile) {
    // Clothing-lab shell: the canvas never leaves the frame - it owns the top
    // of the screen while every control scrolls in a fixed-height deck below.
    return (
      <div className="h-[calc(100dvh-8.5rem)] min-h-[420px] flex flex-col overflow-hidden">
        <div className="flex-1 min-h-0 bg-card/40 p-2">{preview}</div>
        <div className="h-[46%] max-h-[340px] shrink-0 border-t border-hairline overflow-y-auto p-3 space-y-3 bg-bg">
          {controls}
        </div>
      </div>
    );
  }
  return <ToolLayout controls={controls} preview={preview} />;
}
