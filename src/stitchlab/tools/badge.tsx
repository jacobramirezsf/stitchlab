// Stitch Lab tool: Badge - the crest / patch layout. Text curves around the top
// and bottom of a ring (top reads left-to-right along the arc; bottom stays
// upright too), between concentric satin bands, around a central motif - a
// star, diamond, ring, or your own SVG-ish shape. The staple of team, club,
// event, and varsity merch, made parametric and exported as real DST.
//
// textOnRing + the motif geometry are pure and Node-tested; the component
// satins the pieces and renders the re-parsed DST.

import { missingGlyphs } from "./lettering";
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
  Warning,
  fmtLen, useUnits,
} from "./shared";
import { pathGroupsToStitches, resamplePath, type PathMm } from "../lib/generators";
import { letteringSatinPaths } from "./lettering";
import { satinAlongPath } from "./satin";
import { HERSHEY_FACES, type HersheyFaceId } from "./data/hershey";
import { THREADS } from "../../data/threads";

// ─── Pure geometry ───────────────────────────────────────────────────────

/**
 * Lay a string of text around a circle of radius `radiusMm`, centered on the
 * top (position "top") or bottom (position "bottom") of the ring, each glyph
 * rotated tangent to the circle and staying upright/readable. Returns world
 * stroke paths (mm, y-down, centered on the ring's center). Pure.
 */
export function textOnRing(
  text: string,
  faceId: HersheyFaceId,
  radiusMm: number,
  heightMm: number,
  position: "top" | "bottom",
  letterSpacing = 1,
): PathMm[] {
  const face = HERSHEY_FACES[faceId] ?? HERSHEY_FACES.serif;
  const scale = heightMm / face.capHeight;
  const chars = [...text];
  if (chars.length === 0 || radiusMm <= 0) return [];
  const glyphs = chars.map((ch) => face.glyphs[ch] ?? face.glyphs[" "]);
  const adv = glyphs.map((g) => (g?.a ?? face.capHeight * 0.6) * scale * letterSpacing);
  const totalAdv = adv.reduce((a, b) => a + b, 0);

  const top = position === "top";
  const centerAngle = top ? -Math.PI / 2 : Math.PI / 2;
  const swirl = top ? 1 : -1;
  const R = radiusMm;

  const out: PathMm[] = [];
  let cum = 0;
  for (let i = 0; i < chars.length; i++) {
    const g = glyphs[i];
    const a = adv[i];
    const midAdv = cum + a / 2 - totalAdv / 2; // signed arc distance from center
    cum += a;
    if (!g || g.s.length === 0) continue;

    const theta = centerAngle + swirl * (midAdv / R);
    const P = { x: Math.cos(theta) * R, y: Math.sin(theta) * R };
    const t = { x: -Math.sin(theta), y: Math.cos(theta) }; // tangent (increasing θ)
    const n = { x: Math.cos(theta), y: Math.sin(theta) }; // outward radial
    // Reading direction and "up": flipped on the bottom so letters stay upright.
    const xdir = top ? t : { x: -t.x, y: -t.y };
    const ydir = top ? n : { x: -n.x, y: -n.y };

    // glyph horizontal center in font units
    let gmin = Infinity, gmax = -Infinity;
    for (const s of g.s) for (let j = 0; j < s.length; j += 2) { if (s[j] < gmin) gmin = s[j]; if (s[j] > gmax) gmax = s[j]; }
    const gcx = isFinite(gmin) ? (gmin + gmax) / 2 : 0;

    for (const s of g.s) {
      const path: PathMm = [];
      for (let j = 0; j < s.length; j += 2) {
        const lx = (s[j] - gcx) * scale;
        const ly = s[j + 1] * scale; // font y-up
        path.push({
          x: P.x + lx * xdir.x + ly * ydir.x,
          y: P.y + lx * xdir.y + ly * ydir.y,
        });
      }
      if (path.length >= 2) out.push(path);
    }
  }
  return out;
}

function ring(rx: number, ry: number, segs = 120): PathMm {
  const out: PathMm = [];
  for (let i = 0; i <= segs; i++) { const a = (i / segs) * Math.PI * 2 - Math.PI / 2; out.push({ x: Math.cos(a) * rx, y: Math.sin(a) * ry }); }
  return out;
}

export type MotifKind =
  | "none" | "star" | "diamond" | "ring" | "burst"
  | "heart" | "crown" | "shield" | "anchor" | "chevron" | "laurel" | "fleur";

/** Scale a set of points so the design's bounding radius is exactly r, centered. */
function fitRadius(paths: PathMm[], r: number): PathMm[] {
  let mx = 0;
  for (const p of paths) for (const pt of p) mx = Math.max(mx, Math.hypot(pt.x, pt.y));
  if (mx < 1e-6) return paths;
  const s = r / mx;
  return paths.map((p) => p.map((pt) => ({ x: pt.x * s, y: pt.y * s })));
}

/** Central motif polylines (mm, centered), sized to fit radius `rMm`. Pure. */
export function motifPaths(kind: MotifKind, rMm: number): PathMm[] {
  if (kind === "none" || rMm <= 0) return [];
  if (kind === "ring") return [ring(rMm, rMm)];
  if (kind === "diamond") return [[{ x: 0, y: -rMm }, { x: rMm, y: 0 }, { x: 0, y: rMm }, { x: -rMm, y: 0 }, { x: 0, y: -rMm }]];
  if (kind === "star") {
    const pts: PathMm = [];
    for (let i = 0; i <= 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5; const rr = i % 2 === 0 ? rMm : rMm * 0.42; pts.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr }); }
    return [pts];
  }
  if (kind === "burst") {
    const out: PathMm[] = [];
    const n = 16;
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; out.push([{ x: 0, y: 0 }, { x: Math.cos(a) * rMm, y: Math.sin(a) * rMm }]); }
    return out;
  }
  if (kind === "heart") {
    const pts: PathMm = [];
    for (let t = 0; t <= Math.PI * 2 + 0.05; t += 0.1) {
      pts.push({ x: 16 * Math.sin(t) ** 3, y: -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) });
    }
    return fitRadius([pts], rMm);
  }
  if (kind === "crown") {
    const b = 0.55, m = -0.1, top = -1.0;
    const outline: PathMm = [
      { x: -1, y: b }, { x: -1, y: m }, { x: -0.55, y: top }, { x: -0.28, y: -0.1 },
      { x: 0, y: top * 1.15 }, { x: 0.28, y: -0.1 }, { x: 0.55, y: top }, { x: 1, y: m }, { x: 1, y: b }, { x: -1, y: b },
    ];
    const band: PathMm = [{ x: -1, y: b * 0.45 }, { x: 1, y: b * 0.45 }];
    const jewels: PathMm[] = [[{ x: -0.55, y: top }], [{ x: 0, y: top * 1.15 }], [{ x: 0.55, y: top }]].map(([c]) => ring(0.12, 0.12).map((p) => ({ x: p.x + c.x, y: p.y + c.y })));
    return fitRadius([outline, band, ...jewels], rMm);
  }
  if (kind === "shield") {
    const pts: PathMm = [{ x: -0.85, y: -0.95 }, { x: 0.85, y: -0.95 }, { x: 0.85, y: -0.1 }];
    // right side curving down to the bottom point, then mirror back up the left
    for (let t = 0; t <= 1.001; t += 0.1) pts.push({ x: 0.85 * (1 - t), y: -0.1 + 1.1 * Math.sin((t * Math.PI) / 2) });
    for (let t = 1; t >= -0.001; t -= 0.1) pts.push({ x: -0.85 * (1 - t), y: -0.1 + 1.1 * Math.sin((t * Math.PI) / 2) });
    pts.push({ x: -0.85, y: -0.95 });
    return fitRadius([pts], rMm);
  }
  if (kind === "anchor") {
    const strokes: PathMm[] = [];
    strokes.push(ring(0.18, 0.18).map((p) => ({ x: p.x, y: p.y - 0.85 }))); // top ring
    strokes.push([{ x: 0, y: -0.67 }, { x: 0, y: 0.85 }]); // shank
    strokes.push([{ x: -0.5, y: -0.35 }, { x: 0.5, y: -0.35 }]); // stock (crossbar)
    // flukes (curved arms at bottom)
    const arm: PathMm = [];
    for (let t = 0; t <= 1.001; t += 0.1) { const a = Math.PI * (0.5 + 0.5 * t); arm.push({ x: Math.cos(a) * 0.7, y: 0.85 + Math.sin(a) * 0.55 - 0.55 }); }
    strokes.push(arm);
    strokes.push(arm.map((p) => ({ x: -p.x, y: p.y })));
    return fitRadius(strokes, rMm);
  }
  if (kind === "chevron") {
    const out: PathMm[] = [];
    for (let k = 0; k < 3; k++) { const o = k * 0.42; out.push([{ x: -1, y: -0.3 + o }, { x: 0, y: 0.45 + o }, { x: 1, y: -0.3 + o }]); }
    return fitRadius(out, rMm);
  }
  if (kind === "fleur") {
    // fleur-de-lis: center petal + two side petals + a band
    const center: PathMm = [{ x: 0, y: 0.9 }, { x: 0, y: -0.9 }];
    const petalL: PathMm = [];
    for (let t = 0; t <= 1.001; t += 0.08) { const a = Math.PI * (0.5 + 0.6 * t); petalL.push({ x: Math.cos(a) * 0.6 - 0.0, y: -0.2 + Math.sin(a) * 0.7 }); }
    const petalR = petalL.map((p) => ({ x: -p.x, y: p.y }));
    const band: PathMm = [{ x: -0.4, y: 0.35 }, { x: 0.4, y: 0.35 }];
    return fitRadius([center, petalL, petalR, band], rMm);
  }
  // laurel: two symmetric arcs with leaf ticks
  const branches: PathMm[] = [];
  for (const side of [-1, 1]) {
    const arc: PathMm = [];
    for (let t = 0; t <= 1.001; t += 0.06) { const a = Math.PI * (0.5 + 0.42 * t) * side + (side < 0 ? 0 : Math.PI); arc.push({ x: Math.cos(a), y: Math.sin(a) }); }
    branches.push(arc);
    // leaves
    for (let i = 1; i < arc.length - 1; i += 2) {
      const p = arc[i], q = arc[i + 1];
      const nx = -(q.y - p.y), ny = q.x - p.x;
      const L = Math.hypot(nx, ny) || 1;
      branches.push([p, { x: p.x + (nx / L) * 0.28 * side, y: p.y + (ny / L) * 0.28 * side }]);
    }
  }
  return fitRadius(branches, rMm);
}

// ─── Component ───────────────────────────────────────────────────────────

const FACE_CHOICES: [HersheyFaceId, string][] = [
  ["serifBold", "Serif Bold"],
  ["timesrb", "Times Bold"],
  ["gothic", "Gothic"],
  ["gothiceng", "Blackletter"],
  ["sans", "Sans"],
];
const INK = THREADS.find((t) => t.code === "1568")?.hex ?? "#0b1f3a";
const ACCENT = THREADS.find((t) => t.code === "1147")?.hex ?? THREADS.find((t) => t.hex)?.hex ?? "#b4472e";

export default function BadgeTool() {
  const units = useUnits();
  const [topText, setTopText] = useState("BAYSIDE");
  const [bottomText, setBottomText] = useState("EST 2026");
  const [faceId, setFaceId] = useState<HersheyFaceId>("serifBold");
  const [diameter, setDiameter] = useState(90);
  const [textHeight, setTextHeight] = useState(11);
  const [motif, setMotif] = useState<MotifKind>("star");
  const [inkHex, setInkHex] = useState(INK);
  const [accentHex, setAccentHex] = useState(ACCENT);
  const [twoColor, setTwoColor] = useState(true);

  const skeleton = useMemo(() => {
    const Rout = diameter / 2;
    const satinHalf = 2.2 / 2; // ring satin half-width (matches build)
    const margin = Math.max(1.2, textHeight * 0.28); // clearance text↔ring
    // The text lives in an annular band whose outer edge clears the outer ring.
    const bandOuterEdge = Rout - satinHalf - margin;
    // Top text grows outward from its baseline; bottom grows inward. Placing the
    // top baseline textHeight inside the edge and the bottom baseline on the
    // edge makes both occupy the SAME band [bandOuterEdge − textHeight, bandOuterEdge].
    const rTopBaseline = bandOuterEdge - textHeight;
    const rBotBaseline = bandOuterEdge;
    const bandInnerEdge = bandOuterEdge - textHeight;
    const rInner = bandInnerEdge - margin - satinHalf; // inner ring just inside the band

    const topStrokes = topText ? textOnRing(topText, faceId, rTopBaseline, textHeight, "top") : [];
    const botStrokes = bottomText ? textOnRing(bottomText, faceId, rBotBaseline, textHeight, "bottom") : [];
    const rings = [ring(Rout, Rout), ring(rInner, rInner)];
    // Small star separators at 3 and 9 o'clock, sitting in the text band.
    const sep: PathMm[] = [];
    if (topText && bottomText) {
      const sepR = textHeight * 0.42;
      const bandMid = (bandOuterEdge + bandInnerEdge) / 2;
      for (const side of [-1, 1]) {
        const star = motifPaths("star", sepR)[0];
        sep.push(star.map((p) => ({ x: p.x + side * bandMid, y: p.y })));
      }
    }
    const motifR = Math.max(2, (rInner - satinHalf) * 0.72);
    const motifStrokes = motifPaths(motif, motifR);
    return { text: [...topStrokes, ...botStrokes, ...sep], rings, motif: motifStrokes, Rout };
  }, [topText, bottomText, faceId, diameter, textHeight, motif]);

  const built = useMemo(() => {
    const textStitch = letteringSatinPaths(skeleton.text, Math.max(1.4, textHeight * 0.16));
    const ringStitch: PathMm[] = [];
    for (const r of skeleton.rings) {
      const s = satinAlongPath(r, { widthMm: 2.2, densityMm: 0.4, underlayCenter: true });
      ringStitch.push(...s.underlay, s.satin);
    }
    const motifStitch = skeleton.motif.map((p) => resamplePath([...p], 2, 0.4));
    if (textStitch.length + ringStitch.length + motifStitch.length === 0) return null;
    // Group: ink = text + rings; accent = motif (when two-color)
    const groups: PathMm[][] = twoColor && motifStitch.length
      ? [[...textStitch, ...ringStitch], motifStitch]
      : [[...textStitch, ...ringStitch, ...motifStitch]];
    return buildDesign(pathGroupsToStitches(groups, 1), "bayside-badge");
  }, [skeleton, textHeight, twoColor]);

  const colors = twoColor && skeleton.motif.length ? [inkHex, accentHex] : [inkHex];

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="text">
            <label className="block">
              <span className={LABEL}>Top (arcs over)</span>
              <input value={topText} onChange={(e) => setTopText(e.target.value.toUpperCase().slice(0, 22))} spellCheck={false} className="mt-1.5 w-full border border-hairline bg-bg text-fg rounded-none px-2.5 py-1.5 text-[0.9375rem] font-serif tracking-[0.12em] text-center" />
            </label>
            <label className="block">
              <span className={LABEL}>Bottom (arcs under)</span>
              <input value={bottomText} onChange={(e) => setBottomText(e.target.value.toUpperCase().slice(0, 22))} spellCheck={false} className="mt-1.5 w-full border border-hairline bg-bg text-fg rounded-none px-2.5 py-1.5 text-[0.9375rem] font-serif tracking-[0.12em] text-center" />
            </label>
            <div>
              <div className={`${LABEL} mb-1.5`}>Face</div>
              <ModeButtons small options={FACE_CHOICES} value={faceId} onChange={setFaceId} />
            </div>
            {(() => {
              const missing = missingGlyphs(topText + bottomText, faceId);
              return missing.length ? (
                <Warning>
                  This face can't draw <strong>{missing.join(" ")}</strong> - those characters are left
                  out. Try another face.
                </Warning>
              ) : null;
            })()}
          </SectionBox>

          <SectionBox eyebrow="center">
            <ModeButtons small options={[
              ["star", "Star"], ["diamond", "Diamond"], ["heart", "Heart"], ["crown", "Crown"],
              ["shield", "Shield"], ["anchor", "Anchor"], ["laurel", "Laurel"], ["fleur", "Fleur"],
              ["chevron", "Chevron"], ["burst", "Burst"], ["ring", "Ring"], ["none", "None"],
            ] as const} value={motif} onChange={setMotif} />
            {motif !== "none" && (
              <label className="flex items-center gap-2 text-[0.75rem] text-mid">
                <input type="checkbox" checked={twoColor} onChange={(e) => setTwoColor(e.target.checked)} className="accent-accent" />
                center motif in a second thread
              </label>
            )}
          </SectionBox>

          <SectionBox eyebrow="stitch">
            <RangeRow label="Diameter" value={diameter} min={45} max={180} step={1} onChange={setDiameter} fmt={(v) => fmtLen(v, units)} />
            <RangeRow label="Text height" value={textHeight} min={5} max={20} step={0.5} onChange={setTextHeight} fmt={(v) => `${v.toFixed(1)} mm`} />
            <ThreadRow label="Main thread" hex={inkHex} onChange={setInkHex} />
            {twoColor && motif !== "none" && <ThreadRow label="Motif thread" hex={accentHex} onChange={setAccentHex} />}
          </SectionBox>
        </>
      }
      preview={
        <PreviewRail built={built} colors={colors} name="bayside-badge" emptyHint="Set the text to build a badge.">
          {built && (
            <p className="text-[0.6875rem] text-mid tabular-nums">
              {(skeleton.Rout * 2).toFixed(0)} mm crest · {colors.length} thread{colors.length === 1 ? "" : "s"} · {built.stats.realStitches.toLocaleString()} stitches
            </p>
          )}
        </PreviewRail>
      }
    />
  );
}
