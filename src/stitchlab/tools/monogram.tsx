// Stitch Lab tool: Monogram - the classic embroidered mark. One to three
// initials in a stroke face, set as bold satin columns (the center initial
// enlarged in the three-letter arrangement), inside an optional frame - circle,
// oval, diamond, or double ring, itself a satin band. The single most-asked-for
// piece of custom embroidery, made parametric and exported as real DST.
//
// The layout geometry (monogramSkeleton) is pure and Node-tested; the component
// satins the skeleton and renders the re-parsed DST.

import { useMemo, useState } from "react";
import {
  ToolLayout,
  SectionBox,
  RangeRow,
  ModeButtons,
  ThreadRow,
  PreviewRail,
  buildDesign,
  LABEL,
  fmtLen, useUnits,
} from "./shared";
import { pathGroupsToStitches, resamplePath, type PathMm } from "../lib/generators";
import { layoutText, letteringSatinPaths } from "./lettering";
import { satinAlongPath } from "./satin";
import { HERSHEY_FACES, type HersheyFaceId } from "./data/hershey";
import { THREADS } from "../../data/threads";

export type FrameKind = "none" | "circle" | "oval" | "diamond" | "double";

// ─── Pure layout ─────────────────────────────────────────────────────────

function translate(paths: PathMm[], dx: number, dy: number): PathMm[] {
  return paths.map((p) => p.map((pt) => ({ x: pt.x + dx, y: pt.y + dy })));
}
function bbox(paths: PathMm[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) for (const pt of p) {
    if (pt.x < minX) minX = pt.x; if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y; if (pt.y > maxY) maxY = pt.y;
  }
  return isFinite(minX) ? { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY } : { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0 };
}
/** Re-origin a glyph's strokes so its own ink bbox is centered on (0,0). */
function centerInk(paths: PathMm[]): PathMm[] {
  const b = bbox(paths);
  return translate(paths, -(b.minX + b.maxX) / 2, -(b.minY + b.maxY) / 2);
}

function ring(cx: number, cy: number, rx: number, ry: number, segs = 96): PathMm {
  const out: PathMm = [];
  for (let i = 0; i <= segs; i++) { const a = (i / segs) * Math.PI * 2 - Math.PI / 2; out.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry }); }
  return out;
}
function diamond(cx: number, cy: number, rx: number, ry: number): PathMm {
  return [{ x: cx, y: cy - ry }, { x: cx + rx, y: cy }, { x: cx, y: cy + ry }, { x: cx - rx, y: cy }, { x: cx, y: cy - ry }];
}

export type MonogramSkeleton = { letters: PathMm[]; frame: PathMm[]; widthMm: number; heightMm: number };

/**
 * Position 1–3 initials (center enlarged for three) as stroke paths, plus the
 * chosen frame rings sized to enclose them. Pure. Letters come from the Hershey
 * face `faceId`; the caller satins or runs them.
 */
export function monogramSkeleton(opts: {
  text: string;
  faceId: HersheyFaceId;
  heightMm: number;
  sideScale?: number;
  frame?: FrameKind;
  framePad?: number;
}): MonogramSkeleton {
  const chars = [...opts.text.replace(/\s/g, "")].slice(0, 3);
  const H = opts.heightMm;
  const sideScale = opts.sideScale ?? 0.7;
  const gap = H * 0.14;
  const face = HERSHEY_FACES[opts.faceId] ? opts.faceId : ("serif" as HersheyFaceId);
  // Each glyph, ink-centered on the origin (so widths/heights don't skew it).
  const glyph = (ch: string, h: number) => centerInk(layoutText({ text: ch, faceId: face, heightMm: h, stitchLenMm: 0.8 }));

  // Lay letters left-to-right, vertically centered on a shared mid-line, then
  // center the whole group horizontally - so the mark sits dead-center in its
  // frame regardless of how wide or narrow each initial is.
  const letters: PathMm[] = [];
  const heights = chars.length === 3 ? [H * sideScale, H, H * sideScale] : chars.map(() => H);
  const glyphs = chars.map((ch, i) => glyph(ch, heights[i]));
  const widths = glyphs.map((g) => bbox(g).w);
  const total = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, chars.length - 1);
  let penX = -total / 2;
  for (let i = 0; i < glyphs.length; i++) {
    letters.push(...translate(glyphs[i], penX + widths[i] / 2, 0));
    penX += widths[i] + gap;
  }

  // Frame sized to enclose the letters.
  const frame: PathMm[] = [];
  const kind = opts.frame ?? "none";
  if (kind !== "none" && letters.length) {
    let rad = 0;
    for (const p of letters) for (const pt of p) rad = Math.max(rad, Math.hypot(pt.x, pt.y));
    const pad = opts.framePad ?? H * 0.35;
    const R = rad + pad;
    if (kind === "circle") frame.push(ring(0, 0, R, R));
    else if (kind === "oval") frame.push(ring(0, 0, R * 1.32, R * 1.02));
    else if (kind === "diamond") frame.push(diamond(0, 0, R * 1.15, R * 1.28));
    else if (kind === "double") { frame.push(ring(0, 0, R, R)); frame.push(ring(0, 0, R * 1.1, R * 1.1)); }
  }

  const all = [...letters, ...frame];
  const b = bbox(all);
  return { letters, frame, widthMm: b.w, heightMm: b.h };
}

// ─── Component ───────────────────────────────────────────────────────────

const FACE_CHOICES: [HersheyFaceId, string][] = [
  ["serifBold", "Serif Bold"],
  ["timesrb", "Times Bold"],
  ["scriptc", "Formal Script"],
  ["gothiceng", "Blackletter"],
  ["serif", "Serif"],
  ["gothic", "Gothic"],
];
const LETTER_HEX = THREADS.find((t) => t.code === "1568")?.hex ?? "#0b1f3a";
const FRAME_HEX = THREADS.find((t) => t.code === "1371")?.hex ?? THREADS.find((t) => t.hex)?.hex ?? "#8a6d3b";

export default function MonogramTool() {
  const units = useUnits();
  const [text, setText] = useState("ABC");
  const [faceId, setFaceId] = useState<HersheyFaceId>("serifBold");
  const [heightMm, setHeightMm] = useState(38);
  const [render, setRender] = useState<"satin" | "run">("satin");
  const [satinWidth, setSatinWidth] = useState(2.4);
  const [frame, setFrame] = useState<FrameKind>("circle");
  const [frameWidth, setFrameWidth] = useState(2.6);
  const [letterHex, setLetterHex] = useState(LETTER_HEX);
  const [frameHex, setFrameHex] = useState(FRAME_HEX);

  const skel = useMemo(
    () => monogramSkeleton({ text, faceId, heightMm, frame }),
    [text, faceId, heightMm, frame],
  );

  const built = useMemo(() => {
    if (skel.letters.length === 0) return null;
    const letterStitch = render === "satin" ? letteringSatinPaths(skel.letters, satinWidth) : skel.letters.map((p) => resamplePath(p, 2, 0.4));
    const groups: PathMm[][] = [letterStitch];
    if (skel.frame.length) {
      const frameStitch: PathMm[] = [];
      for (const r of skel.frame) {
        const s = satinAlongPath(r, { widthMm: frameWidth, densityMm: 0.4, underlayCenter: true, underlayEdge: frameWidth >= 3 });
        frameStitch.push(...s.underlay, s.satin);
      }
      groups.push(frameStitch);
    }
    return buildDesign(pathGroupsToStitches(groups, 1), "bayside-monogram");
  }, [skel, render, satinWidth, frameWidth]);

  const colors = skel.frame.length ? [letterHex, frameHex] : [letterHex];

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="initials">
            <label className="block">
              <span className={LABEL}>Up to 3 letters</span>
              <input
                value={text}
                onChange={(e) => setText(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3))}
                spellCheck={false}
                placeholder="ABC"
                className="mt-1.5 w-full border border-hairline bg-bg text-fg rounded-none px-2.5 py-2 text-[1.125rem] font-serif tracking-[0.2em] text-center"
              />
            </label>
            <div>
              <div className={`${LABEL} mb-1.5`}>Face</div>
              <ModeButtons small options={FACE_CHOICES} value={faceId} onChange={setFaceId} />
            </div>
            {text.length === 3 && (
              <p className="text-[0.6875rem] text-mid leading-relaxed">Three letters: the center initial (the surname, traditionally) sews larger, flanked by the other two.</p>
            )}
          </SectionBox>

          <SectionBox eyebrow="frame">
            <ModeButtons small options={[["none", "None"], ["circle", "Circle"], ["oval", "Oval"], ["diamond", "Diamond"], ["double", "Double"]] as const} value={frame} onChange={setFrame} />
            {frame !== "none" && <RangeRow label="Frame width" value={frameWidth} min={1.5} max={5} step={0.1} onChange={setFrameWidth} fmt={(v) => `${v.toFixed(1)} mm`} />}
            {frame !== "none" && <ThreadRow label="Frame thread" hex={frameHex} onChange={setFrameHex} />}
          </SectionBox>

          <SectionBox eyebrow="stitch">
            <RangeRow label="Cap height" value={heightMm} min={16} max={90} step={1} onChange={setHeightMm} fmt={(v) => fmtLen(v, units)} />
            <div>
              <div className={`${LABEL} mb-1.5`}>Letters</div>
              <ModeButtons small options={[["satin", "Satin"], ["run", "Outline run"]] as const} value={render} onChange={setRender} />
            </div>
            {render === "satin" && <RangeRow label="Satin width" value={satinWidth} min={1.2} max={4} step={0.1} onChange={setSatinWidth} fmt={(v) => `${v.toFixed(1)} mm`} />}
            <ThreadRow label="Letter thread" hex={letterHex} onChange={setLetterHex} />
          </SectionBox>
        </>
      }
      preview={
        <PreviewRail built={built} colors={colors} name="bayside-monogram" emptyHint="Type initials to build a monogram.">
          {built && (
            <p className="text-[0.6875rem] text-mid tabular-nums">
              {skel.widthMm.toFixed(0)} × {skel.heightMm.toFixed(0)} mm · {colors.length} thread{colors.length === 1 ? "" : "s"}{frame !== "none" ? " · framed" : ""}
            </p>
          )}
        </PreviewRail>
      }
    />
  );
}
