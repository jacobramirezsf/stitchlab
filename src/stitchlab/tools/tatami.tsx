// Stitch Lab tool: Tatami Fill - real angled fill stitches for closed shapes.
//
// The first step past outline art. Two tricks make machine fill read as
// fabric instead of scan lines: serpentine row routing (rows alternate
// direction, so the thread walks the shape instead of dragging back across
// it) and brick-pattern stagger (each row's needle points shift by a fraction
// of a stitch, so penetrations never line up into visible seams). The
// scanline fill is even-odd, so holes come free - a ring inside a ring
// stitches out as an annulus.
//
// Three deeper digitizing moves on top of that base:
// - Gradient spacing (PEmbroider's ramp fills): row spacing can ease from one
//   value at the fill's start edge to another at the far edge, so a single
//   fill shades from dense to open.
// - Texture stagger (stitchjs PatternFill, distilled): the per-row phase of
//   the needle points can run as brickwork, an unwrapped twill diagonal, a
//   diamond triangle-wave, or a seeded random scatter - each reads as a
//   different weave in thread.
// - Boundary travel (Ink/Stitch's trim-killer): multi-section fills can walk
//   between sections along the shape's own outline instead of jumping, so a
//   star or annulus stitches out with zero trims.

import { useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import {
  FabricSelect,
  FABRIC_PRESETS,
  type FabricId,
  ToolLayout,
  SectionBox,
  RangeRow,
  ModeButtons,
  ThreadRow,
  Warning,
  PreviewRail,
  buildDesign,
  LABEL,
  SizeField,
} from "./shared";
import { fitPaths, pathsToStitches, resamplePath, svgToPaths } from "../lib/generators";
import type { PathMm } from "../lib/generators";
import { THREADS } from "../../data/threads";

// ─── Pure geometry (importable in node, no DOM) ──────────────────────────

/** Closed polygon, mm, y-down. The last point need not repeat the first. */
export type Ring = { x: number; y: number }[];

/** How each row's needle-point lattice shifts against its neighbors. */
export type TatamiTexture = "brick" | "twill" | "diamond" | "random";

/** How disconnected fill sections are linked: machine jumps, or a walk along the outline. */
export type TatamiTravel = "jump" | "boundary";

export type TatamiOpts = {
  angleDeg?: number; // fill row direction, default 45
  rowSpacingMm?: number; // distance between rows, default 0.5
  stitchLenMm?: number; // stitch length along each row, default 3
  stagger?: number; // per-row phase shift as a fraction of stitch length, default 1/3
  rowSpacingEndMm?: number; // if set, spacing ramps linearly to this at the far edge (gradient fill)
  texture?: TatamiTexture; // per-row phase pattern, default "brick" (the classic behavior)
  travel?: TatamiTravel; // how sections connect, default "jump" (the classic behavior)
  seed?: number; // PRNG seed for the "random" texture, default 0x51ab
};

/** Deterministic PRNG (mulberry32) - keeps the "random" texture reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function circleRing(radiusMm: number, segments: number): Ring {
  const pts: Ring = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    pts.push({ x: radiusMm * Math.cos(t), y: radiusMm * Math.sin(t) });
  }
  return pts;
}

/** Built-in test shapes, centered on the origin, long side = sizeMm. */
export function shapeRings(
  shape: "circle" | "square" | "star" | "heart" | "ring",
  sizeMm: number,
): Ring[] {
  if (shape === "circle") return [circleRing(sizeMm / 2, 128)];
  if (shape === "square") {
    const h = sizeMm / 2;
    return [
      [
        { x: -h, y: -h },
        { x: h, y: -h },
        { x: h, y: h },
        { x: -h, y: h },
      ],
    ];
  }
  // Annulus: outer + inner ring; the even-odd fill turns the inner into a hole.
  if (shape === "ring") return [circleRing(sizeMm / 2, 128), circleRing(sizeMm * 0.3, 128)];
  if (shape === "star") {
    const pts: Ring = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 1 : 0.42;
      const a = -Math.PI / 2 + (i * Math.PI) / 5; // y-down: point at the top
      pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
    }
    return fitPaths([pts], sizeMm);
  }
  // Heart - the classic parametric curve, flipped for y-down so the lobes sit on top.
  const pts: Ring = [];
  for (let i = 0; i < 192; i++) {
    const t = (i / 192) * Math.PI * 2;
    pts.push({
      x: 16 * Math.sin(t) ** 3,
      y: -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)),
    });
  }
  return fitPaths([pts], sizeMm);
}

// ── Boundary-travel geometry (Ink/Stitch-style section linking) ──────────

type RingGeom = { ring: Ring; cum: number[]; total: number };

function ringGeomOf(ring: Ring): RingGeom {
  const cum: number[] = [0];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    cum.push(cum[i] + Math.hypot(b.x - a.x, b.y - a.y));
  }
  return { ring, cum, total: cum[ring.length] };
}

/** Closest point on the ring's polyline: arc position, the point, and the distance to it. */
function projectOntoRing(
  g: RingGeom,
  p: { x: number; y: number },
): { arc: number; pt: { x: number; y: number }; dist: number } {
  const { ring, cum } = g;
  let bestArc = 0;
  let bestPt = ring[0];
  let bestD2 = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = a.x + dx * t;
    const qy = a.y + dy * t;
    const d2 = (p.x - qx) * (p.x - qx) + (p.y - qy) * (p.y - qy);
    if (d2 < bestD2) {
      bestD2 = d2;
      bestPt = { x: qx, y: qy };
      bestArc = cum[i] + Math.sqrt(len2) * t;
    }
  }
  return { arc: bestArc, pt: bestPt, dist: Math.sqrt(bestD2) };
}

/** Ring vertices strictly between two arc positions, taking the shorter way around. */
function walkAlongRing(
  g: RingGeom,
  arcA: number,
  arcB: number,
): { pts: PathMm; len: number } {
  const { ring, cum, total } = g;
  const n = ring.length;
  const fwd = (((arcB - arcA) % total) + total) % total;
  const bwd = total - fwd;
  const hits: { arc: number; idx: number }[] = [];
  if (fwd <= bwd) {
    for (let i = 0; i < n; i++) {
      let c = cum[i];
      while (c <= arcA) c += total; // smallest vertex arc past arcA going forward
      if (c < arcA + fwd) hits.push({ arc: c, idx: i });
    }
    hits.sort((a, b) => a.arc - b.arc);
    return { pts: hits.map((h) => ring[h.idx]), len: fwd };
  }
  for (let i = 0; i < n; i++) {
    let c = cum[i];
    while (c >= arcA) c -= total; // largest vertex arc before arcA going backward
    if (c > arcA - bwd) hits.push({ arc: c, idx: i });
  }
  hits.sort((a, b) => b.arc - a.arc);
  return { pts: hits.map((h) => ring[h.idx]), len: bwd };
}

/**
 * Link consecutive section paths by walking along the nearest ring's outline
 * (resampled at 2 mm) instead of jumping. If the detour would run longer than
 * 4× the direct hop, that junction falls back to a break - a jump is cheaper
 * than a hike. Connected sections merge into one path.
 */
function mergeByBoundary(paths: PathMm[], rings: Ring[]): PathMm[] {
  const geoms = rings.map(ringGeomOf).filter((g) => g.total > 0);
  if (geoms.length === 0 || paths.length < 2) return paths;
  const out: PathMm[] = [];
  let cur = paths[0].slice();
  for (let i = 1; i < paths.length; i++) {
    const prevEnd = cur[cur.length - 1];
    const nextStart = paths[i][0];
    const direct = Math.hypot(nextStart.x - prevEnd.x, nextStart.y - prevEnd.y);
    // Nearest ring: the one closest to both junction endpoints combined.
    let best: { g: RingGeom; a: ReturnType<typeof projectOntoRing>; b: ReturnType<typeof projectOntoRing> } | null =
      null;
    for (const g of geoms) {
      const a = projectOntoRing(g, prevEnd);
      const b = projectOntoRing(g, nextStart);
      if (!best || a.dist + b.dist < best.a.dist + best.b.dist) best = { g, a, b };
    }
    let connected = false;
    if (best) {
      const walk = walkAlongRing(best.g, best.a.arc, best.b.arc);
      const walkLen = best.a.dist + walk.len + best.b.dist;
      if (walkLen <= 4 * direct) {
        const conn = resamplePath([prevEnd, best.a.pt, ...walk.pts, best.b.pt, nextStart], 2);
        for (let k = 1; k < conn.length; k++) cur.push(conn[k]);
        for (let k = 1; k < paths[i].length; k++) cur.push(paths[i][k]);
        connected = true;
      }
    }
    if (!connected) {
      out.push(cur);
      cur = paths[i].slice();
    }
  }
  out.push(cur);
  return out;
}

/**
 * Tatami scanline fill with section detection, serpentine routing, and
 * textured stagger. Returns one PathMm per contiguous section (fewer when
 * boundary travel links them) plus the row/section counts for the readout -
 * sectionCount always reports the raw sections found, before any linking.
 * Even-odd rule: nested rings are holes.
 */
export function tatamiFillInfo(
  rings: Ring[],
  opts: TatamiOpts,
): { paths: PathMm[]; rowCount: number; sectionCount: number } {
  const angle = ((opts.angleDeg ?? 45) * Math.PI) / 180;
  const spacing = Math.max(0.1, opts.rowSpacingMm ?? 0.5);
  const len = Math.max(0.5, opts.stitchLenMm ?? 3);
  const stag = opts.stagger ?? 1 / 3;
  const END_EPS = 0.4; // keep interior needle points this far (mm) off span ends

  // 1. Rotate everything by −angle so rows become horizontal scanlines.
  const ci = Math.cos(-angle);
  const si = Math.sin(-angle);
  const rot = rings
    .filter((r) => r.length >= 3)
    .map((r) => r.map((p) => ({ x: p.x * ci - p.y * si, y: p.x * si + p.y * ci })));
  if (rot.length === 0) return { paths: [], rowCount: 0, sectionCount: 0 };

  let minY = Infinity;
  let maxY = -Infinity;
  for (const r of rot)
    for (const p of r) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  if (!(maxY > minY)) return { paths: [], rowCount: 0, sectionCount: 0 };

  type SpanRow = { row: number; y: number; lo: number; hi: number };
  type Section = { rows: SpanRow[] };
  const done: Section[] = [];
  let open: Section[] = [];
  let rowCount = 0;

  // Row positions along the scan direction. With rowSpacingEndMm set, the
  // spacing ramps linearly from `spacing` at the start edge to the end value
  // at the far edge - a shading gradient inside a single fill.
  const rowYs: number[] = [];
  if (opts.rowSpacingEndMm === undefined) {
    const nRows = Math.ceil((maxY - minY) / spacing);
    for (let row = 0; row < nRows; row++) {
      const y = minY + spacing / 2 + row * spacing;
      if (y >= maxY) break;
      rowYs.push(y);
    }
  } else {
    const endSpacing = Math.max(0.1, opts.rowSpacingEndMm);
    const extent = maxY - minY;
    let y = minY + spacing / 2;
    while (y < maxY && rowYs.length < 20000) {
      rowYs.push(y);
      const t = Math.min(1, Math.max(0, (y - minY) / extent));
      y += spacing + (endSpacing - spacing) * t;
    }
  }

  // 2–4. Scanlines → even-odd spans → sections grouped across rows.
  for (let row = 0; row < rowYs.length; row++) {
    const y = rowYs[row];

    // Intersections against every edge, half-open rule (skip horizontals).
    const xs: number[] = [];
    for (const ring of rot) {
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i];
        const q = ring[(i + 1) % ring.length];
        if (p.y === q.y) continue;
        if (Math.min(p.y, q.y) <= y && y < Math.max(p.y, q.y)) {
          xs.push(p.x + ((y - p.y) / (q.y - p.y)) * (q.x - p.x));
        }
      }
    }
    xs.sort((a, b) => a - b);
    const spans: { lo: number; hi: number }[] = [];
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] >= 0.1) spans.push({ lo: xs[i], hi: xs[i + 1] });
    }
    if (spans.length > 0) rowCount++;

    // Match spans to open sections: qualify at ≥20% overlap of the narrower
    // interval, then assign greedily best-overlap-first so a section keeps
    // its best-matching span and the rest start new sections.
    const pairs: { sec: number; span: number; ov: number }[] = [];
    open.forEach((sec, secIdx) => {
      const last = sec.rows[sec.rows.length - 1];
      spans.forEach((sp, spanIdx) => {
        const ov = Math.min(last.hi, sp.hi) - Math.max(last.lo, sp.lo);
        const narrower = Math.min(last.hi - last.lo, sp.hi - sp.lo);
        if (ov >= 0.2 * narrower) pairs.push({ sec: secIdx, span: spanIdx, ov });
      });
    });
    pairs.sort((a, b) => b.ov - a.ov);
    const secTaken = new Set<number>();
    const spanTaken = new Set<number>();
    for (const pr of pairs) {
      if (secTaken.has(pr.sec) || spanTaken.has(pr.span)) continue;
      secTaken.add(pr.sec);
      spanTaken.add(pr.span);
      open[pr.sec].rows.push({ row, y, lo: spans[pr.span].lo, hi: spans[pr.span].hi });
    }
    const next: Section[] = [];
    open.forEach((sec, secIdx) => {
      if (secTaken.has(secIdx)) next.push(sec);
      else done.push(sec); // unmatched sections close
    });
    spans.forEach((sp, spanIdx) => {
      if (!spanTaken.has(spanIdx)) next.push({ rows: [{ row, y, lo: sp.lo, hi: sp.hi }] });
    });
    open = next;
  }
  done.push(...open);

  // 5–6. Serpentine each section with textured needle points, rotate back.
  // The texture is the per-row phase of the stitch lattice: brick wraps the
  // classic rowIndex·stagger shift; twill lets the same shift run unwrapped so
  // the diagonal keeps climbing; diamond runs a triangle wave (up three rows,
  // back down) over a 6-row cycle; random scatters each row with a seeded PRNG.
  const texture = opts.texture ?? "brick";
  const seed = (opts.seed ?? 0x51ab) >>> 0;
  const phaseFor = (row: number): number => {
    if (texture === "twill") return row * stag * len;
    if (texture === "diamond") {
      const c = row % 6;
      return (c <= 3 ? c : 6 - c) * stag * len;
    }
    if (texture === "random") return mulberry32((seed + Math.imul(row + 1, 0x9e3779b9)) >>> 0)() * len;
    return (((row * stag * len) % len) + len) % len; // brick - the classic
  };
  const cb = Math.cos(angle);
  const sb = Math.sin(angle);
  const paths: PathMm[] = [];
  for (const sec of done) {
    const path: PathMm = [];
    for (const r of sec.rows) {
      const phase = phaseFor(r.row);
      const ptsX: number[] = [r.lo];
      let k = Math.ceil((r.lo + END_EPS - phase) / len);
      let x = phase + k * len;
      while (x <= r.hi - END_EPS) {
        ptsX.push(x);
        k++;
        x = phase + k * len;
      }
      ptsX.push(r.hi);
      if (r.row % 2 === 1) ptsX.reverse(); // serpentine: alternate direction
      for (const px of ptsX) path.push({ x: px * cb - r.y * sb, y: px * sb + r.y * cb });
    }
    if (path.length >= 2) paths.push(path);
  }
  const sectionCount = paths.length;
  const merged =
    (opts.travel ?? "jump") === "boundary" && paths.length > 1
      ? mergeByBoundary(
          paths,
          rings.filter((r) => r.length >= 3),
        )
      : paths;
  return { paths: merged, rowCount, sectionCount };
}

/**
 * Tatami fill of closed rings - one PathMm per contiguous section (fewer when
 * `travel: "boundary"` walks sections together along the outline).
 */
export function tatamiFill(rings: Ring[], opts: TatamiOpts): PathMm[] {
  return tatamiFillInfo(rings, opts).paths;
}

/**
 * Sweep angles 0°, 15°, … 165° and return the one that splits the shape into
 * the fewest fill sections (ties break toward fewer rows - the shorter sit at
 * the machine). Fewer sections means fewer jumps and trims before boundary
 * travel even gets involved.
 */
export function autoAngle(rings: Ring[], opts?: { rowSpacingMm?: number }): number {
  let bestAngle = 0;
  let bestSections = Infinity;
  let bestRows = Infinity;
  for (let a = 0; a < 180; a += 15) {
    const info = tatamiFillInfo(rings, {
      angleDeg: a,
      rowSpacingMm: opts?.rowSpacingMm ?? 0.5,
    });
    if (
      info.sectionCount < bestSections ||
      (info.sectionCount === bestSections && info.rowCount < bestRows)
    ) {
      bestSections = info.sectionCount;
      bestRows = info.rowCount;
      bestAngle = a;
    }
  }
  return bestAngle;
}

// ─── Component ───────────────────────────────────────────────────────────

type Mode = "circle" | "square" | "star" | "heart" | "ring" | "svg";

const MODE_OPTIONS = [
  ["circle", "Circle"],
  ["square", "Square"],
  ["star", "Star"],
  ["heart", "Heart"],
  ["ring", "Ring"],
  ["svg", "SVG"],
] as const;

const TEXTURE_OPTIONS = [
  ["brick", "Brick"],
  ["twill", "Twill"],
  ["diamond", "Diamond"],
  ["random", "Random"],
] as const;

const DEFAULT_HEX = THREADS.find((t) => t.code === "1568")?.hex ?? "#5C6753";

function ToggleRow({
  checked,
  onChange,
  title,
  note,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  note: string;
}) {
  return (
    <label className="flex items-start gap-2 text-[0.75rem] text-mid leading-relaxed cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(ev) => onChange(ev.target.checked)}
        className="accent-accent mt-[3px]"
      />
      <span>
        <span className="text-fg">{title}</span> - {note}
      </span>
    </label>
  );
}

export default function TatamiTool() {
  const [mode, setMode] = useState<Mode>("circle");
  const [sizeMm, setSizeMm] = useState(70);
  const [angleDeg, setAngleDeg] = useState(45);
  const [spacing, setSpacing] = useState(0.5);
  const [fabric, setFabricId] = useState<FabricId>("canvas");
  const applyFabric = (id: FabricId) => {
    setFabricId(id);
    setSpacing(FABRIC_PRESETS[id].tatamiSpacingMm);
  };
  const [rowLen, setRowLen] = useState(3);
  const [stagger, setStagger] = useState(0.33);
  const [gradientOn, setGradientOn] = useState(false);
  const [spacingEnd, setSpacingEnd] = useState(1.5);
  const [texture, setTexture] = useState<TatamiTexture>("brick");
  const [boundaryTravel, setBoundaryTravel] = useState(false);
  const [underlayOn, setUnderlayOn] = useState(true);
  const [outlineOn, setOutlineOn] = useState(true);
  const [densityOn, setDensityOn] = useState(false);
  const [threadHex, setThreadHex] = useState(DEFAULT_HEX);
  const [svgText, setSvgText] = useState("");
  const [svgName, setSvgName] = useState<string | null>(null);

  const onFile = (ev: ChangeEvent<HTMLInputElement>) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    f.text().then((t) => {
      setSvgText(t);
      setSvgName(f.name);
    });
  };

  // Params → rings → fill sections.
  const gen = useMemo<{
    rings: Ring[];
    fill: { paths: PathMm[]; rowCount: number; sectionCount: number } | null;
    error: string | null;
  }>(() => {
    try {
      let rings: Ring[];
      if (mode === "svg") {
        if (!svgText.trim()) return { rings: [], fill: null, error: null };
        rings = svgToPaths(svgText, sizeMm).filter((p) => p.length >= 3);
        if (rings.length === 0) {
          return { rings: [], fill: null, error: "That SVG had no closed outlines I could fill." };
        }
      } else {
        rings = shapeRings(mode, sizeMm);
      }
      const fill = tatamiFillInfo(rings, {
        angleDeg,
        rowSpacingMm: spacing,
        rowSpacingEndMm: gradientOn ? spacingEnd : undefined,
        stitchLenMm: rowLen,
        stagger,
        texture,
        travel: boundaryTravel ? "boundary" : "jump",
      });
      return { rings, fill, error: null };
    } catch (err) {
      return {
        rings: [],
        fill: null,
        error: err instanceof Error ? err.message : "Something went wrong generating the fill.",
      };
    }
  }, [
    mode,
    svgText,
    sizeMm,
    angleDeg,
    spacing,
    gradientOn,
    spacingEnd,
    rowLen,
    stagger,
    texture,
    boundaryTravel,
  ]);

  // Sections → stitches: underlay first, then the top fill, then the outline.
  const stitches = useMemo(() => {
    const { rings, fill } = gen;
    if (!fill || fill.paths.length === 0) return null;
    const ordered: PathMm[] = [];
    if (underlayOn) {
      // Sparse pre-fill at 90° to the top stitching, coarse and light.
      ordered.push(
        ...tatamiFill(rings, { angleDeg: angleDeg + 90, rowSpacingMm: 3, stitchLenMm: 4, stagger }),
      );
    }
    ordered.push(...fill.paths);
    if (outlineOn) {
      for (const r of rings) ordered.push(resamplePath([...r, r[0]], 2.5));
    }
    return pathsToStitches(ordered);
  }, [gen, underlayOn, outlineOn, angleDeg, stagger]);

  // Stitches → real DST bytes → re-parsed preview.
  const built = useMemo(
    () => (stitches ? buildDesign(stitches, "bayside-tatami") : null),
    [stitches],
  );

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="Shape">
            <ModeButtons options={MODE_OPTIONS} value={mode} onChange={setMode} small />
            {mode === "svg" && (
              <div className="space-y-2">
                <div className={LABEL}>Your artwork</div>
                <input
                  type="file"
                  accept=".svg,image/svg+xml"
                  onChange={onFile}
                  className="block w-full text-[0.75rem] text-mid file:mr-3 file:border file:border-hairline file:bg-bg file:text-fg file:px-3 file:py-1 file:text-[0.75rem]"
                />
                {svgName && <p className="text-[0.75rem] text-fg">{svgName}</p>}
                <p className="text-[0.6875rem] text-mid leading-relaxed">
                  Shapes must be closed outlines. The fill uses the even-odd rule, so a shape
                  drawn inside another becomes a hole - good for counters and cutouts.
                </p>
              </div>
            )}
          </SectionBox>

          <SectionBox eyebrow="Fill">
            <FabricSelect value={fabric} onChange={applyFabric} />
            <SizeField valueMm={sizeMm} min={30} max={330} onChange={setSizeMm} />
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <RangeRow
                  label="Fill angle"
                  value={angleDeg}
                  min={-90}
                  max={90}
                  step={1}
                  onChange={setAngleDeg}
                  fmt={(v) => `${v}°`}
                />
              </div>
              <button
                onClick={() => {
                  if (gen.rings.length === 0) return;
                  const a = autoAngle(gen.rings, { rowSpacingMm: spacing });
                  setAngleDeg(a > 90 ? a - 180 : a);
                }}
                title="Sweep 0–165° and pick the angle that splits this shape into the fewest sections"
                className="mb-1 border border-hairline bg-bg px-2.5 py-1 text-[0.6875rem] text-fg hover:bg-card"
              >
                Auto
              </button>
            </div>
            <RangeRow
              label={gradientOn ? "Start spacing" : "Row spacing"}
              value={spacing}
              min={0.35}
              max={1.2}
              step={0.05}
              onChange={setSpacing}
              fmt={(v) => `${v.toFixed(2)} mm`}
            />
            {spacing < 0.4 && (
              <Warning>Very dense - rows this tight pile up thread. Test on a stable garment.</Warning>
            )}
            <ToggleRow
              checked={gradientOn}
              onChange={setGradientOn}
              title="Gradient"
              note="row spacing eases from the value above at the first rows to an end value at the far edge - dense-to-open shading in a single fill."
            />
            {gradientOn && (
              <RangeRow
                label="End spacing"
                value={spacingEnd}
                min={0.35}
                max={2.5}
                step={0.05}
                onChange={setSpacingEnd}
                fmt={(v) => `${v.toFixed(2)} mm`}
              />
            )}
            <RangeRow
              label="Row stitch length"
              value={rowLen}
              min={2}
              max={5}
              step={0.1}
              onChange={setRowLen}
              fmt={(v) => `${v.toFixed(1)} mm`}
            />
            <RangeRow
              label="Stagger"
              value={stagger}
              min={0}
              max={1}
              step={0.01}
              onChange={setStagger}
              fmt={(v) => v.toFixed(2)}
            />
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Stagger shifts each row's needle points like brickwork. At 0 the penetrations line
              up into visible seams; around a third they melt into the fabric.
            </p>
            <div className="space-y-2">
              <div className={LABEL}>Texture</div>
              <ModeButtons options={TEXTURE_OPTIONS} value={texture} onChange={setTexture} small />
              <p className="text-[0.6875rem] text-mid leading-relaxed">
                How the stagger repeats. Brick wraps like masonry, twill runs one long diagonal,
                diamond zigzags up and back over six rows, random scatters each row - the same
                pattern every build, so what you preview is what stitches.
              </p>
            </div>
          </SectionBox>

          <SectionBox eyebrow="Passes">
            <ToggleRow
              checked={underlayOn}
              onChange={setUnderlayOn}
              title="Underlay"
              note="a sparse pre-fill at 90° to the top stitching, sewn first. It stabilizes the fabric so the top fill lies flat instead of sinking in."
            />
            <ToggleRow
              checked={outlineOn}
              onChange={setOutlineOn}
              title="Outline"
              note="a running-stitch pass around each ring after the fill, to sharpen the edge."
            />
            <ToggleRow
              checked={boundaryTravel}
              onChange={setBoundaryTravel}
              title="Boundary travel"
              note="when the fill splits into sections - star points, the two sides of a ring - walk between them along the shape's own edge instead of jumping. No jumps, no trims to bury; the outline pass covers the tracks."
            />
            <ToggleRow
              checked={densityOn}
              onChange={setDensityOn}
              title="Density view"
              note="heat-map the needle penetrations to spot overworked areas before the machine finds them."
            />
          </SectionBox>

          <SectionBox eyebrow="Thread">
            <ThreadRow hex={threadHex} onChange={(hex) => setThreadHex(hex)} />
          </SectionBox>
        </>
      }
      preview={
        <PreviewRail
          built={built}
          colors={[threadHex]}
          name="bayside-tatami"
          emptyHint={
            mode === "svg"
              ? "Upload an SVG with closed outlines and the fill builds itself."
              : "Adjust the shape and fill - the preview follows along."
          }
          showDensity={densityOn}
        >
          {gen.error && <Warning>{gen.error}</Warning>}
            {gen.fill && built && (
              <p className="text-[0.75rem] text-mid tabular-nums">
                {gen.fill.sectionCount} section{gen.fill.sectionCount === 1 ? "" : "s"}
                {boundaryTravel && gen.fill.paths.length < gen.fill.sectionCount
                  ? ` walked into ${gen.fill.paths.length} path${
                      gen.fill.paths.length === 1 ? "" : "s"
                    }`
                  : ""}{" "}
                · {gen.fill.rowCount} rows · est. {built.stats.realStitches.toLocaleString()}{" "}
                stitches
              </p>
            )}
            {built && built.stats.realStitches > 60000 && (
              <Warning>
                Over 60,000 stitches - that's a long sit at the machine and a stiff patch of
                fabric. Shrink the size or open up the row spacing.
              </Warning>
            )}
        </PreviewRail>
      }
    />
  );
}
