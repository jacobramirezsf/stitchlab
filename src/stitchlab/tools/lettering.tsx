// Stitch Lab tool: Lettering - single-line Hershey stroke-font text, straight
// or bent along an arc. Names, jacket backs, labels. Every glyph is a set
// of pen strokes resampled to even running stitch, so the machine sews exactly
// the skeleton you see - no fills, no faking. The Satin weight hands each
// stroke to the satin engine instead, turning the skeleton into true zigzag
// columns with underlay. Strokes are travel-ordered before stitching, so the
// needle walks the word instead of hopscotching it.

import { useEffect, useMemo, useState } from "react";
import {
  ToolLayout,
  SectionBox,
  RangeRow,
  ModeButtons,
  ThreadRow,
  Warning,
  PreviewRail,
  DropZone,
  buildDesign,
  LABEL,
} from "./shared";
import { pathsToStitches, resamplePath, type PathMm } from "../lib/generators";
import { HERSHEY_FACES, HERSHEY_PICKER_IDS, type HersheyFaceId, type HersheyGlyph } from "./data/hershey";
import { satinAlongPath } from "./satin";
import { tatamiFill } from "./tatami";
import { layoutOutlineText, type OTFont } from "../lib/outlinefont";
import { THREADS } from "../../data/threads";
import { STAFF_FONTS } from "./data/staffFonts";
import { getRole } from "../account";
import { listUserFonts, syncUserFonts, addUserFont, fontBytes, type UserFont } from "../lib/fontlib";

// ─── Outline (real OTF/TTF) lettering ────────────────────────────────────

export type OutlineStyle = "outline" | "fill";

/** Build a Built from an uploaded outline font: running outline, or tatami fill
 *  with counters intact. Pure given the font. */
export function buildOutlineText(
  font: OTFont,
  o: {
    text: string;
    heightMm: number;
    letterSpacing: number;
    lineSpacing: number;
    style: OutlineStyle;
    fillAngleDeg: number;
    fillDensityMm: number;
    outlinePass: boolean;
    stitchLenMm: number;
    bean: 1 | 3 | 5;
    align?: "left" | "center" | "right";
    /** Section linking for fills: "boundary" sews cleanly on the machine;
     *  "jump" keeps renders free of visible travel stitches. */
    travel?: "boundary" | "jump";
  },
) {
  const L = layoutOutlineText(font, {
    text: o.text,
    heightMm: o.heightMm,
    letterSpacing: o.letterSpacing,
    lineSpacing: o.lineSpacing,
    stepMm: 0.4,
    align: o.align,
  });
  if (L.glyphs.length === 0) return null;
  const paths: PathMm[] = [];
  if (o.style === "outline") {
    for (const c of L.contours) paths.push(resamplePath([...c, c[0]], o.stitchLenMm, 0.4));
    return buildDesign(pathsToStitches(paths, o.bean), "bayside-lettering");
  }
  // fill: each glyph's rings (outer + counters) → tatami; optional outline pass
  for (const g of L.glyphs) {
    const fill = tatamiFill(g.rings, {
      angleDeg: o.fillAngleDeg,
      rowSpacingMm: o.fillDensityMm,
      stitchLenMm: 3,
      travel: o.travel ?? "boundary",
    });
    paths.push(...fill);
    if (o.outlinePass) for (const c of g.rings) paths.push(resamplePath([...c, c[0]], 2.2, 0.4));
  }
  return buildDesign(pathsToStitches(paths, 1), "bayside-lettering");
}

// ─── Pure layout ─────────────────────────────────────────────────────────

/**
 * Lay out text in a Hershey stroke face as mm paths (y-down), centered on the
 * origin. heightMm is CAP height. arcDeg bends each line along a circle:
 * positive arches upward, negative bows downward. Glyphs stay
 * rigid - each is placed on the circle and rotated to the local tangent.
 */
export function layoutText(opts: {
  text: string;
  faceId: HersheyFaceId;
  heightMm: number;
  letterSpacing?: number;
  lineSpacing?: number;
  arcDeg?: number;
  stitchLenMm?: number;
  /** Per-line justification for multi-line text. Arc-bent lines stay centered. */
  align?: "left" | "center" | "right";
}): PathMm[] {
  const face = HERSHEY_FACES[opts.faceId];
  if (!face || !(opts.heightMm > 0)) return [];
  const scale = opts.heightMm / face.capHeight;
  const letterSpacing = opts.letterSpacing ?? 1;
  const pitch = opts.heightMm * (opts.lineSpacing ?? 1.6);
  const arcDeg = opts.arcDeg ?? 0;
  const stitchLen = opts.stitchLenMm ?? 2.0;
  // Unsupported characters are SKIPPED with a space-width gap - never
  // silently replaced with "?" (missingGlyphs() lets the UI warn instead).
  const fallbackAdv = face.glyphs[" "]?.a ?? face.capHeight * 0.6;

  const strokes: PathMm[] = [];
  const lines = opts.text.replace(/\r\n?/g, "\n").split("\n");
  const align = opts.align ?? "center";
  // measure every line first so justification can offset against the widest
  const measured = lines.map((line) => {
    const placed: { glyph: HersheyGlyph | null; penX: number }[] = [];
    let pen = 0;
    for (const ch of line) {
      const glyph = face.glyphs[ch] ?? null;
      placed.push({ glyph, penX: pen });
      pen += (glyph ? glyph.a : fallbackAdv) * scale * letterSpacing;
    }
    return { placed, width: pen };
  });
  const maxW = Math.max(0, ...measured.map((m) => m.width));

  lines.forEach((_line, li) => {
    const { placed, width } = measured[li];
    if (width <= 0) return;
    const lineOff = align === "left" ? -(maxW - width) / 2 : align === "right" ? (maxW - width) / 2 : 0;

    const lineY = li * pitch; // lines stack downward (y-down model)
    const bend = Math.abs(arcDeg) >= 0.5;
    const arcRad = (arcDeg * Math.PI) / 180;
    const radius = bend ? width / arcRad : 0; // signed: <0 bows downward

    for (const { glyph, penX } of placed) {
      if (!glyph) continue;
      // Angle for this glyph's baseline x-position; whole glyph stays rigid.
      const phi = bend ? (penX / width - 0.5) * arcRad : 0;
      const cos = Math.cos(phi);
      const sin = Math.sin(phi);
      const ox = bend ? radius * sin : penX - width / 2 + lineOff;
      const oy = bend ? radius - radius * cos : 0;
      for (const flat of glyph.s) {
        if (flat.length < 4) continue;
        const stroke: PathMm = [];
        for (let i = 0; i + 1 < flat.length; i += 2) {
          const gx = flat[i] * scale;
          const gy = -flat[i + 1] * scale; // font y-up → model y-down
          stroke.push({
            x: ox + gx * cos - gy * sin,
            y: oy + gx * sin + gy * cos + lineY,
          });
        }
        strokes.push(stroke);
      }
    }
  });

  // Resample every stroke to even stitch lengths, then center the whole
  // design on the origin.
  const resampled = strokes
    .map((s) => resamplePath(s, stitchLen, 0.3))
    .filter((s) => s.length >= 2);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of resampled)
    for (const p of s) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  if (!isFinite(minX)) return [];
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return resampled.map((s) => s.map((p) => ({ x: p.x - cx, y: p.y - cy })));
}

// ─── Pure travel optimization ────────────────────────────────────────────

/** Sum of inter-stroke gaps: end of each stroke to the start of the next. */
/** Characters a Hershey face cannot draw - so the UI can say so BEFORE a
 *  name silently loses letters. */
export function missingGlyphs(text: string, faceId: HersheyFaceId): string[] {
  const face = HERSHEY_FACES[faceId];
  if (!face) return [];
  const missing = new Set<string>();
  for (const ch of text) {
    if (ch === "\n" || ch === "\r" || ch === " ") continue;
    if (!face.glyphs[ch]) missing.add(ch);
  }
  return [...missing];
}

export function strokeTravelMm(paths: PathMm[]): number {
  let sum = 0;
  for (let i = 1; i < paths.length; i++) {
    const prev = paths[i - 1];
    const cur = paths[i];
    if (prev.length === 0 || cur.length === 0) continue;
    const a = prev[prev.length - 1];
    const b = cur[0];
    sum += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return sum;
}

/**
 * Greedy nearest-endpoint stroke ordering with reversal. Start from the
 * stroke owning the leftmost endpoint (entering at that end), then repeatedly
 * append the unused stroke whose nearer endpoint is closest to the running
 * end - reversed when its tail is the nearer end. Same strokes in, same
 * strokes out; only order and direction change. On lettering this cuts
 * between-stroke travel by roughly a third, which the machine pays back as
 * shorter jumps and tidier trims.
 */
export function orderStrokes(paths: PathMm[]): PathMm[] {
  const strokes = paths.filter((p) => p.length > 0);
  const empties = paths.length - strokes.length;
  if (strokes.length <= 1) return paths.map((p) => p.slice());

  const n = strokes.length;
  const used: boolean[] = new Array(n).fill(false);
  const out: PathMm[] = [];

  // Seed: the stroke whose (either) endpoint sits leftmost; enter there.
  let seedIdx = 0;
  let seedRev = false;
  let seedX = Infinity;
  for (let i = 0; i < n; i++) {
    const s = strokes[i];
    const head = s[0];
    const tail = s[s.length - 1];
    if (head.x < seedX) {
      seedX = head.x;
      seedIdx = i;
      seedRev = false;
    }
    if (tail.x < seedX) {
      seedX = tail.x;
      seedIdx = i;
      seedRev = true;
    }
  }
  const take = (i: number, rev: boolean) => {
    used[i] = true;
    out.push(rev ? strokes[i].slice().reverse() : strokes[i].slice());
  };
  take(seedIdx, seedRev);

  for (let step = 1; step < n; step++) {
    const last = out[out.length - 1];
    const cur = last[last.length - 1];
    let bestIdx = -1;
    let bestRev = false;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const s = strokes[i];
      const head = s[0];
      const tail = s[s.length - 1];
      const dHead = Math.hypot(head.x - cur.x, head.y - cur.y);
      const dTail = Math.hypot(tail.x - cur.x, tail.y - cur.y);
      if (dHead < bestD) {
        bestD = dHead;
        bestIdx = i;
        bestRev = false;
      }
      if (dTail < bestD) {
        bestD = dTail;
        bestIdx = i;
        bestRev = true;
      }
    }
    take(bestIdx, bestRev);
  }
  for (let i = 0; i < empties; i++) out.push([]);
  return out;
}

// ─── Pure satin expansion ────────────────────────────────────────────────

/**
 * Expand centerline strokes into true satin columns. Narrow columns (under
 * 3 mm) ride a center-run underlay only; 3 mm and up add edge walks so the
 * rails stay put on knits. Returns underlay + satin passes chained per
 * stroke, ready for pathsToStitches(paths, 1). Feed it finely sampled
 * strokes (layoutText with stitchLenMm ≈ 0.8) so the columns follow every
 * curve of the glyph.
 */
export function letteringSatinPaths(strokes: PathMm[], widthMm: number): PathMm[] {
  const out: PathMm[] = [];
  for (const stroke of strokes) {
    const result = satinAlongPath(stroke, {
      widthMm,
      underlayCenter: true,
      underlayEdge: widthMm >= 3,
      underlayZigzag: false,
    });
    if (result.satin.length < 2) continue;
    out.push(...result.underlay, result.satin);
  }
  return out;
}

// ─── Component ───────────────────────────────────────────────────────────

const FACE_OPTIONS = HERSHEY_PICKER_IDS.map(
  (id) => [id, HERSHEY_FACES[id].name] as const,
);

const WEIGHT_OPTIONS = [
  ["1", "Run"],
  ["3", "Bean ×3"],
  ["5", "Bean ×5"],
  ["satin", "Satin"],
] as const;

type Weight = "1" | "3" | "5" | "satin";

const DEFAULT_THREAD = THREADS.find((t) => t.code === "1568")?.hex ?? "#082870";

export default function LetteringTool() {
  const [text, setText] = useState("BAYSIDE");
  const [faceId, setFaceId] = useState<HersheyFaceId>("sans");
  const [heightMm, setHeightMm] = useState(25);
  const [letterSpacing, setLetterSpacing] = useState(1);
  const [lineSpacing, setLineSpacing] = useState(1.6);
  const [arcDeg, setArcDeg] = useState(0);
  const [stitchLen, setStitchLen] = useState(2.0);
  const [weight, setWeight] = useState<Weight>("1");
  const [satinWidth, setSatinWidth] = useState(2.5);
  const [threadHex, setThreadHex] = useState(DEFAULT_THREAD);
  const [optimizeOrder, setOptimizeOrder] = useState(true);
  // Uploaded outline font (OTF/TTF/WOFF via opentype.js, loaded on demand).
  const [customFont, setCustomFont] = useState<OTFont | null>(null);
  const [myFonts, setMyFonts] = useState<UserFont[]>([]);
  useEffect(() => {
    listUserFonts().then(setMyFonts);
    syncUserFonts().then(setMyFonts).catch(() => {});
  }, []);
  const [customFontName, setCustomFontName] = useState("");
  const [fontError, setFontError] = useState<string | null>(null);
  const [outlineStyle, setOutlineStyle] = useState<OutlineStyle>("fill");
  const [fillAngle, setFillAngle] = useState(45);
  const [fillDensity, setFillDensity] = useState(0.45);
  const [outlinePass, setOutlinePass] = useState(true);

  // Characters the active font cannot draw. Built-in faces: table lookup.
  // Uploaded fonts: opentype maps unmapped codepoints to glyph 0 (.notdef).
  const missingChars = useMemo(() => {
    if (customFont) {
      const missing = new Set<string>();
      for (const ch of text) {
        if (ch === "\n" || ch === "\r" || ch === " ") continue;
        try {
          if ((customFont.charToGlyph(ch) as { index?: number }).index === 0) missing.add(ch);
        } catch {
          missing.add(ch);
        }
      }
      return [...missing];
    }
    return missingGlyphs(text, faceId);
  }, [text, faceId, customFont]);

  const loadFont = async (file: File) => {
    setFontError(null);
    try {
      const buf = await file.arrayBuffer();
      const opentype = await import("opentype.js");
      const parse = (opentype as unknown as { parse: (b: ArrayBuffer) => OTFont }).parse
        ?? (opentype as unknown as { default: { parse: (b: ArrayBuffer) => OTFont } }).default.parse;
      const font = parse(buf);
      // sanity: it must render a capital
      font.charToGlyph("A").getPath(0, 0, font.unitsPerEm);
      setCustomFont(font);
      setCustomFontName(file.name.replace(/\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/, ""));
      const bytes = new Uint8Array(buf);
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      void addUserFont(file.name, `data:font/ttf;base64,${btoa(bin)}`).then(() => listUserFonts().then(setMyFonts));
    } catch {
      setFontError("Couldn't read that font. Use a .ttf, .otf, or .woff file.");
      setCustomFont(null);
      setCustomFontName("");
    }
  };

  const loadFonts = async (files: File[]) => {
    let okCount = 0, fail = 0;
    for (const f of files) {
      try { await loadFont(f); okCount++; } catch { fail++; }
    }
    if (fail) setFontError(`${okCount} added, ${fail} couldn't be read.`);
  };


  // Satin columns need a finely sampled centerline to follow glyph curves;
  // run/bean sew the sampled points directly, so the slider rules there.
  const layoutStitchLen = weight === "satin" ? 0.8 : stitchLen;

  const layout = useMemo<{ paths: PathMm[]; error: string | null }>(() => {
    if (!text.replace(/\s/g, "")) return { paths: [], error: null };
    try {
      const paths = layoutText({
        text,
        faceId,
        heightMm,
        letterSpacing,
        lineSpacing,
        arcDeg,
        stitchLenMm: layoutStitchLen,
      });
      return { paths, error: null };
    } catch (err) {
      return {
        paths: [],
        error: err instanceof Error ? err.message : "Could not lay out that text.",
      };
    }
  }, [text, faceId, heightMm, letterSpacing, lineSpacing, arcDeg, layoutStitchLen]);

  // Travel-order the strokes so the needle walks the word left to right-ish
  // instead of hopscotching glyph internals. Optional: with optimization off,
  // strokes sew in reading order - longer hops between letters, which the
  // machine turns into per-letter trims. Some jobs want exactly that (clean
  // trim-per-letter fronts); some want the continuous minimal-travel sew.
  const ordered = useMemo(
    () => (optimizeOrder ? orderStrokes(layout.paths) : layout.paths),
    [layout, optimizeOrder],
  );
  const travel = useMemo(() => {
    const before = strokeTravelMm(layout.paths);
    const after = strokeTravelMm(ordered);
    return {
      before,
      after,
      savedPct: before > 0 ? ((before - after) / before) * 100 : 0,
    };
  }, [layout, ordered]);

  // The honest pipeline: paths → stitches → real DST bytes → re-parse.
  const built = useMemo(() => {
    if (customFont && text.replace(/\s/g, "")) {
      return buildOutlineText(customFont, {
        text,
        heightMm,
        letterSpacing,
        lineSpacing,
        style: outlineStyle,
        fillAngleDeg: fillAngle,
        fillDensityMm: fillDensity,
        outlinePass,
        stitchLenMm: stitchLen,
        bean: (weight === "satin" ? 3 : Number(weight)) as 1 | 3 | 5,
      });
    }
    if (ordered.length === 0) return null;
    if (weight === "satin") {
      const satinPaths = letteringSatinPaths(ordered, satinWidth);
      if (satinPaths.length === 0) return null;
      return buildDesign(pathsToStitches(satinPaths, 1), "bayside-lettering");
    }
    const bean = Number(weight) as 1 | 3 | 5;
    return buildDesign(pathsToStitches(ordered, bean), "bayside-lettering");
  }, [ordered, weight, satinWidth, customFont, text, heightMm, letterSpacing, lineSpacing, outlineStyle, fillAngle, fillDensity, outlinePass, stitchLen]);

  const penLifts = layout.paths.length;

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="words">
            <label className="block">
              <span className={LABEL}>Text - one line per row</span>
              <textarea
                value={text}
                onChange={(ev) => setText(ev.target.value)}
                rows={3}
                spellCheck={false}
                placeholder="BAYSIDE"
                className="mt-1.5 w-full border border-hairline bg-bg text-fg rounded-none px-2.5 py-2 text-[0.9375rem] font-serif resize-y"
              />
            </label>
            {missingChars.length > 0 && (
              <Warning>
                {customFont ? "This font" : "This lettering style"} can't draw{" "}
                <strong>{missingChars.join(" ")}</strong> - those characters are left out, not swapped.
                Pick another style or upload a font that includes them.
              </Warning>
            )}
            <div>
              <div className={`${LABEL} mb-1.5`}>Face</div>
              <div className={customFont ? "opacity-40 pointer-events-none" : ""}>
                <ModeButtons small options={FACE_OPTIONS} value={faceId} onChange={setFaceId} />
              </div>
            </div>
            <div className="border-t border-hairline pt-2.5 space-y-2">
              <div className={`${LABEL}`}>Or bring your own typeface</div>
              {customFont ? (
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-[0.8125rem] text-fg truncate">◈ {customFontName || "Custom font"}</span>
                  <button onClick={() => { setCustomFont(null); setCustomFontName(""); }} className="text-[0.75rem] text-mid hover:text-fg border border-hairline px-2 py-0.5">use a built-in face ✕</button>
                </div>
              ) : (
                <DropZone onFile={(f) => void loadFont(f)} onFiles={(fs) => void loadFonts(fs)} match={(f) => /\.(ttf|otf|woff2?)$/i.test(f.name) || f.type.includes("font")}>
                  <label className="block border border-dashed border-hairline hover:border-accent px-3 py-2 text-center text-[0.8125rem] text-mid cursor-pointer">
                    Upload an OTF / TTF / WOFF - or drop it here →
                    <input type="file" accept=".ttf,.otf,.woff,.woff2,font/*" multiple className="hidden" onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length > 1) void loadFonts(fs); else if (fs[0]) void loadFont(fs[0]); }} />
                  </label>
                </DropZone>
              )}
              {myFonts.length > 0 && !customFont && (
                <select
                  value=""
                  onChange={async (e) => {
                    const f = myFonts.find((x) => x.name === e.target.value);
                    if (!f) return;
                    try {
                      const buf = await fontBytes(f);
                      void loadFont(new File([buf], `${f.name}.ttf`));
                    } catch { /* stays on built-in faces */ }
                  }}
                  className="w-full border border-hairline bg-bg text-fg px-2 py-1.5 text-[0.8125rem]"
                >
                  <option value="">My fonts…</option>
                  {myFonts.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                </select>
              )}
              {["staff", "admin"].includes(getRole()) && !customFont && (
                <select
                  value=""
                  onChange={async (e) => {
                    const f = STAFF_FONTS.find((x) => x.name === e.target.value);
                    if (!f) return;
                    try {
                      const buf = await (await fetch(`/staff-fonts/${f.file}`)).arrayBuffer();
                      const blob = new File([buf], f.file);
                      void loadFont(blob);
                    } catch { /* fetch failed - leave the picker as-is */ }
                  }}
                  className="w-full border border-hairline bg-bg text-fg px-2 py-1.5 text-[0.8125rem]"
                >
                  <option value="">Studio fonts (staff)…</option>
                  {STAFF_FONTS.map((f) => <option key={f.file} value={f.name}>{f.name}</option>)}
                </select>
              )}
              {fontError && <p className="text-[0.75rem]" style={{ color: "#d0522b" }}>{fontError}</p>}
              <p className="text-[0.625rem] text-mid leading-relaxed">
                Any real typeface becomes embroidery - filled letters (counters kept open) or a running outline. Open faces: Google Fonts, the OFL/libre foundries. Your file never leaves the browser.
              </p>
            </div>
          </SectionBox>

          <SectionBox eyebrow="shape">
            <RangeRow
              label="Cap height"
              value={heightMm}
              min={6}
              max={80}
              step={1}
              onChange={setHeightMm}
              fmt={(v) => `${v} mm`}
            />
            <RangeRow
              label="Letter spacing"
              value={letterSpacing}
              min={0.7}
              max={1.6}
              step={0.05}
              onChange={setLetterSpacing}
              fmt={(v) => `×${v.toFixed(2)}`}
            />
            <RangeRow
              label="Line spacing"
              value={lineSpacing}
              min={1.1}
              max={2.2}
              step={0.05}
              onChange={setLineSpacing}
              fmt={(v) => `×${v.toFixed(2)}`}
            />
            {!customFont && (
              <RangeRow
                label="Arc"
                value={arcDeg}
                min={-180}
                max={180}
                step={5}
                onChange={setArcDeg}
                fmt={(v) => (v === 0 ? "straight" : `${v}°`)}
              />
            )}
          </SectionBox>

          <SectionBox eyebrow="stitches">
            {customFont && (
              <>
                <div>
                  <div className={`${LABEL} mb-1.5`}>Rendering</div>
                  <ModeButtons
                    small
                    options={[["fill", "Filled"], ["outline", "Outline"]] as const}
                    value={outlineStyle}
                    onChange={setOutlineStyle}
                  />
                </div>
                {outlineStyle === "fill" ? (
                  <>
                    <RangeRow label="Fill angle" value={fillAngle} min={0} max={180} step={5} onChange={setFillAngle} fmt={(v) => `${v}°`} />
                    <RangeRow label="Fill density" value={fillDensity} min={0.3} max={0.7} step={0.01} onChange={setFillDensity} fmt={(v) => `${v.toFixed(2)} mm`} />
                    <label className="flex items-start gap-2 text-[0.8125rem] text-fg cursor-pointer">
                      <input type="checkbox" checked={outlinePass} onChange={(e) => setOutlinePass(e.target.checked)} className="accent-accent mt-0.5" />
                      <span>Outline pass
                        <span className="block text-[0.6875rem] text-mid leading-relaxed">A running stitch around each letter's edge after the fill - crisps the shape.</span>
                      </span>
                    </label>
                    <p className="text-[0.6875rem] text-mid leading-relaxed">Solid-filled letters with counters (the holes in a, e, o) left open. Bigger caps fill best - 15&nbsp;mm+.</p>
                  </>
                ) : (
                  <>
                    <RangeRow label="Stitch length" value={stitchLen} min={1.5} max={5} step={0.1} onChange={setStitchLen} fmt={(v) => `${v.toFixed(1)} mm`} />
                    <div>
                      <div className={`${LABEL} mb-1.5`}>Line weight</div>
                      <ModeButtons small options={[["1", "Run"], ["3", "Bean ×3"], ["5", "Bean ×5"]] as const} value={weight === "satin" ? "1" : weight} onChange={(v) => setWeight(v)} />
                    </div>
                    <p className="text-[0.6875rem] text-mid leading-relaxed">A running stitch traces every letter's outline - light and fast, the drawn contour of the type.</p>
                  </>
                )}
                <ThreadRow hex={threadHex} onChange={(hex) => setThreadHex(hex)} />
              </>
            )}
            {!customFont && (
            <>
            {weight !== "satin" && (
              <RangeRow
                label="Stitch length"
                value={stitchLen}
                min={1.5}
                max={5}
                step={0.1}
                onChange={setStitchLen}
                fmt={(v) => `${v.toFixed(1)} mm`}
              />
            )}
            <div>
              <div className={`${LABEL} mb-1.5`}>Line weight</div>
              <ModeButtons
                small
                options={WEIGHT_OPTIONS}
                value={weight}
                onChange={(v) => setWeight(v)}
              />
            </div>
            {weight === "satin" && (
              <>
                <RangeRow
                  label="Satin width"
                  value={satinWidth}
                  min={1.5}
                  max={5}
                  step={0.1}
                  onChange={setSatinWidth}
                  fmt={(v) => `${v.toFixed(1)} mm`}
                />
                <p className="text-[0.6875rem] text-mid leading-relaxed">
                  Every stroke becomes a true satin column - zigzag penetrations
                  over underlay, not a thickened line. Under 3&nbsp;mm the column
                  rides a center run; at 3&nbsp;mm and up it gains edge walks so
                  the rails hold on knits.
                </p>
              </>
            )}
            <label className="flex items-start gap-2 text-[0.8125rem] text-fg cursor-pointer">
              <input
                type="checkbox"
                checked={optimizeOrder}
                onChange={(ev) => setOptimizeOrder(ev.target.checked)}
                className="accent-accent mt-0.5"
              />
              <span>
                Minimize travel between strokes
                <span className="block text-[0.6875rem] text-mid leading-relaxed">
                  On: strokes reorder for the shortest needle path - fewer, shorter
                  jumps, mostly continuous. Off: letters sew in reading order, so the
                  machine trims between letters - cleaner backs when jumps would
                  otherwise stay short enough to skip trimming.
                </span>
              </span>
            </label>
            <ThreadRow hex={threadHex} onChange={(hex) => setThreadHex(hex)} />
            </>
            )}
          </SectionBox>

          {heightMm < 8 && (
            <Warning>
              Small lettering may not stitch cleanly - consider 8&nbsp;mm+ caps.
            </Warning>
          )}
          {layout.error && <Warning>{layout.error}</Warning>}
          {built && built.stats.realStitches > 60000 && (
            <Warning>
              Over 60,000 stitches - that's a long, needy sew. Trim the text or drop the cap
              height.
            </Warning>
          )}

        </>
      }
      preview={
        <PreviewRail
          built={built}
          colors={[threadHex]}
          name="bayside-lettering"
          emptyHint="Type a word to lay out stitches."
        >
          {!customFont && built && penLifts > 0 && (
            <p className="text-[0.6875rem] text-mid tabular-nums">
              {penLifts} pen lift{penLifts === 1 ? "" : "s"} →{" "}
              {Math.max(0, penLifts - 1)} trim{penLifts - 1 === 1 ? "" : "s"} on the machine
            </p>
          )}
          {customFont && built && (
            <p className="text-[0.6875rem] text-mid tabular-nums">
              {customFontName || "Custom font"} · {outlineStyle === "fill" ? "tatami-filled" : "running outline"}
            </p>
          )}
          {!customFont && built && travel.before > 0 && (
            <p className="text-[0.6875rem] text-mid tabular-nums">
              travel:{" "}
              {optimizeOrder
                ? `${travel.after.toFixed(0)} mm (saved ${Math.max(0, Math.round(travel.savedPct))}%)`
                : `${travel.before.toFixed(0)} mm (reading order - trims between letters)`}
            </p>
          )}
        </PreviewRail>
      }
    />
  );
}
