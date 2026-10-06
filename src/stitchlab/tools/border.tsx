// Stitch Lab tool: Borders - rectangular frame borders built from repeating
// motifs, from plain multi-line frames through scallops and Greek-adjacent
// scrolls to art nouveau vine curls. Width and height are set independently,
// so the frame takes any aspect ratio; motif repeats snap to a whole count
// per side so the pattern always resolves cleanly at the corners. Every
// motif is engineered as a continuous line per edge (no mid-edge trims).

import { useMemo, useState } from "react";
import {
  ToolLayout,
  SectionBox,
  RangeRow,
  ModeButtons,
  ThreadRow,
  SizeField,
  PreviewRail,
  buildDesign,
  useDebouncedKey,
  LABEL,
} from "./shared";
import { pathGroupsToStitches, resamplePath, type PathMm } from "../lib/generators";
import { THREADS } from "../../data/threads";

const NAME = "bayside-border";
const INK = THREADS.find((t) => t.code === "1568")?.hex ?? "#0b1f3a";
const TAU = Math.PI * 2;

// ─── Motifs ──────────────────────────────────────────────────────────────
// Each motif draws one edge in local coordinates: x runs 0..len along the
// edge, y+ is outward from the frame. Repeats have length rl (len = n·rl).
// b is the band height. Everything returns polylines; most are one line.

type MotifFn = (n: number, rl: number, b: number) => PathMm[];

const MOTIFS: { id: string; label: string; fn: MotifFn }[] = [
  { id: "plain", label: "Plain", fn: () => [] },
  {
    id: "scallop", label: "Scallop",
    fn: (n, rl, b) => {
      const pts: PathMm[number][] = [];
      for (let i = 0; i < n; i++) for (let t = 0; t <= 14; t++) { const th = (t / 14) * Math.PI; pts.push({ x: i * rl + (rl * th) / Math.PI, y: b * 0.9 * Math.sin(th) }); }
      return [pts];
    },
  },
  {
    id: "wave", label: "Wave",
    fn: (n, rl, b) => {
      const pts: PathMm[number][] = [];
      const steps = n * 16;
      for (let t = 0; t <= steps; t++) { const x = (t / steps) * n * rl; pts.push({ x, y: (b / 2) * Math.sin((TAU * x) / rl) }); }
      return [pts];
    },
  },
  {
    id: "zigzag", label: "Zigzag",
    fn: (n, rl, b) => {
      const pts: PathMm[number][] = [];
      for (let k = 0; k <= n * 2; k++) pts.push({ x: (k * rl) / 2, y: k % 2 ? b / 2 : -b / 2 });
      return [pts];
    },
  },
  {
    id: "scroll", label: "Scroll",
    fn: (n, rl, b) => {
      // Running scroll (Vitruvian wave): a cycloid that loops once per repeat.
      const a = b * 0.45;
      const pts: PathMm[number][] = [];
      for (let i = 0; i < n; i++) for (let t = 0; t <= 22; t++) { const th = (t / 22) * TAU; pts.push({ x: i * rl + (rl * th) / TAU - a * Math.sin(th), y: a - a * Math.cos(th) }); }
      return [pts];
    },
  },
  {
    id: "vine", label: "Vine",
    fn: (n, rl, b) => {
      // Art nouveau whiplash: curls alternate above and below the stem line.
      const a = b * 0.42;
      const pts: PathMm[number][] = [];
      for (let i = 0; i < n; i++) { const s = i % 2 ? -1 : 1; for (let t = 0; t <= 22; t++) { const th = (t / 22) * TAU; pts.push({ x: i * rl + (rl * th) / TAU - a * Math.sin(th), y: s * (a - a * Math.cos(th)) }); } }
      return [pts];
    },
  },
  {
    id: "braid", label: "Braid",
    fn: (n, rl, b) => {
      const mk = (phase: number) => { const pts: PathMm[number][] = []; const steps = n * 16; for (let t = 0; t <= steps; t++) { const x = (t / steps) * n * rl; pts.push({ x, y: (b / 2) * Math.sin((TAU * x) / rl + phase) }); } return pts; };
      return [mk(0), mk(Math.PI)];
    },
  },
  {
    id: "castle", label: "Castle",
    fn: (n, rl, b) => {
      const h = b * 0.9;
      const pts: PathMm[number][] = [{ x: 0, y: 0 }];
      for (let i = 0; i < n; i++) { const x0 = i * rl; pts.push({ x: x0, y: h }, { x: x0 + rl / 2, y: h }, { x: x0 + rl / 2, y: 0 }, { x: x0 + rl, y: 0 }); }
      return [pts];
    },
  },
  {
    id: "beads", label: "Beads",
    fn: (n, rl, b) => {
      // A line threading through a circle per repeat: bead-and-line.
      const r = Math.min(b * 0.45, rl * 0.4);
      const pts: PathMm[number][] = [{ x: 0, y: 0 }];
      for (let i = 0; i < n; i++) {
        const mid = i * rl + rl / 2;
        pts.push({ x: mid - r, y: 0 });
        for (let t = 0; t <= 18; t++) { const th = Math.PI + (t / 18) * TAU; pts.push({ x: mid + r * Math.cos(th), y: r * Math.sin(th) }); }
        pts.push({ x: (i + 1) * rl, y: 0 });
      }
      return [pts];
    },
  },
  {
    id: "laurel", label: "Laurel",
    fn: (n, rl, b) => {
      // Leaves chained tip to tip: out along the tops, back along the bottoms,
      // so every leaf closes and the whole edge stays one continuous line.
      const h = b * 0.55;
      const pts: PathMm[number][] = [];
      for (let i = 0; i < n; i++) for (let t = 0; t <= 12; t++) { const th = (t / 12) * Math.PI; pts.push({ x: i * rl + (rl * th) / Math.PI, y: h * Math.sin(th) }); }
      for (let i = n - 1; i >= 0; i--) for (let t = 12; t >= 0; t--) { const th = (t / 12) * Math.PI; pts.push({ x: i * rl + (rl * th) / Math.PI, y: -h * Math.sin(th) }); }
      return [pts];
    },
  },
];
const MOTIF_BY_ID = Object.fromEntries(MOTIFS.map((m) => [m.id, m]));

// ─── Corners ─────────────────────────────────────────────────────────────

type CornerId = "none" | "square" | "diamond" | "dot" | "curl";
const CORNERS: readonly (readonly [CornerId, string])[] = [
  ["none", "Flow through"], ["square", "Square"], ["diamond", "Diamond"], ["dot", "Dot"], ["curl", "Curl"],
];

/** Corner element centered at (cx, cy), sized from the band height. */
function cornerPaths(kind: CornerId, cx: number, cy: number, b: number): PathMm[] {
  const s = b * 0.62;
  switch (kind) {
    case "square":
      return [[{ x: cx - s, y: cy - s }, { x: cx + s, y: cy - s }, { x: cx + s, y: cy + s }, { x: cx - s, y: cy + s }, { x: cx - s, y: cy - s }]];
    case "diamond":
      return [[{ x: cx, y: cy - s * 1.2 }, { x: cx + s * 1.2, y: cy }, { x: cx, y: cy + s * 1.2 }, { x: cx - s * 1.2, y: cy }, { x: cx, y: cy - s * 1.2 }]];
    case "dot": {
      const pts: PathMm[number][] = [];
      for (let t = 0; t <= 24; t++) { const th = (t / 24) * TAU; pts.push({ x: cx + s * 0.75 * Math.cos(th), y: cy + s * 0.75 * Math.sin(th) }); }
      return [pts];
    }
    case "curl": {
      const pts: PathMm[number][] = [];
      const turns = 2.2;
      for (let t = 0; t <= 40; t++) { const th = (t / 40) * turns * TAU; const r = s * 1.15 * (1 - t / 44); pts.push({ x: cx + r * Math.cos(th), y: cy + r * Math.sin(th) }); }
      return [pts];
    }
    default:
      return [];
  }
}

// ─── Component ───────────────────────────────────────────────────────────

export default function BorderTool() {
  const [style, setStyle] = useState("scallop");
  const [widthMm, setWidthMm] = useState(140);
  const [heightMm, setHeightMm] = useState(100);
  const [band, setBand] = useState(10);
  const [repeat, setRepeat] = useState(20);
  const [face, setFace] = useState<"out" | "in">("out");
  const [corner, setCorner] = useState<CornerId>("none");
  const [outerLines, setOuterLines] = useState(1);
  const [innerLines, setInnerLines] = useState(0);
  const [lineGap, setLineGap] = useState(3);
  const [stitchLen, setStitchLen] = useState(2.2);
  const [bean, setBean] = useState<1 | 3>(1);
  const [threadHex, setThreadHex] = useState(INK);

  const key = useDebouncedKey([style, widthMm, heightMm, band, repeat, face, corner, outerLines, innerLines, lineGap, stitchLen, bean]);
  const built = useMemo(() => {
    const W = widthMm, H = heightMm, b = band;
    const paths: PathMm[] = [];
    const faceSign = face === "out" ? 1 : -1;

    // Clockwise edges: start corner, tangent, outward normal.
    const edges = [
      { sx: -W / 2, sy: -H / 2, tx: 1, ty: 0, nx: 0, ny: -1, len: W }, // top
      { sx: W / 2, sy: -H / 2, tx: 0, ty: 1, nx: 1, ny: 0, len: H },   // right
      { sx: W / 2, sy: H / 2, tx: -1, ty: 0, nx: 0, ny: 1, len: W },   // bottom
      { sx: -W / 2, sy: H / 2, tx: 0, ty: -1, nx: -1, ny: 0, len: H }, // left
    ];

    const cpad = corner === "none" ? 0 : b * 1.15 + 2;
    const motif = MOTIF_BY_ID[style];
    for (const e of edges) {
      const effLen = e.len - 2 * cpad;
      if (effLen < 8) continue;
      const n = Math.max(1, Math.round(effLen / repeat));
      const rl = effLen / n;
      for (const local of motif.fn(n, rl, b)) {
        paths.push(local.map((p) => ({
          x: e.sx + e.tx * (cpad + p.x) + e.nx * p.y * faceSign,
          y: e.sy + e.ty * (cpad + p.x) + e.ny * p.y * faceSign,
        })));
      }
    }

    // Frame lines: closed rectangles nested outside / inside the motif band.
    const rail = (o: number): PathMm => {
      const hw = W / 2 + o, hh = H / 2 + o;
      return [{ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }, { x: -hw, y: -hh }];
    };
    const base = style === "plain" ? 0 : b; // rails clear the motif band fully
    for (let k = 1; k <= outerLines; k++) paths.push(rail(base + k * lineGap));
    for (let k = 1; k <= innerLines; k++) { const o = -(base + k * lineGap); if (W / 2 + o > 6 && H / 2 + o > 6) paths.push(rail(o)); }
    if (style === "plain" && outerLines === 0 && innerLines === 0) paths.push(rail(0));

    // Corner elements at the four frame corners.
    if (corner !== "none") {
      for (const [cx, cy] of [[-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2]] as [number, number][]) {
        paths.push(...cornerPaths(corner, cx, cy, b));
      }
    }

    const resampled = paths.filter((p) => p.length >= 2).map((p) => resamplePath(p, stitchLen, 0.4));
    if (!resampled.length) return null;
    return buildDesign(pathGroupsToStitches([resampled], bean), NAME);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="border">
            <div>
              <div className={`${LABEL} mb-1.5`}>Style</div>
              <ModeButtons small options={MOTIFS.map((m) => [m.id, m.label] as const)} value={style} onChange={setStyle} />
            </div>
            {style !== "plain" && (
              <>
                <RangeRow label="Repeat length" value={repeat} min={8} max={60} step={1} onChange={setRepeat} fmt={(v) => `${v} mm`} />
                <RangeRow label="Band height" value={band} min={4} max={24} step={0.5} onChange={setBand} fmt={(v) => `${v.toFixed(1)} mm`} />
                <div>
                  <div className={`${LABEL} mb-1.5`}>Face</div>
                  <ModeButtons small options={[["out", "Outward"], ["in", "Inward"]] as const} value={face} onChange={setFace} />
                </div>
              </>
            )}
            <div>
              <div className={`${LABEL} mb-1.5`}>Corners</div>
              <ModeButtons small options={CORNERS} value={corner} onChange={setCorner} />
            </div>
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Repeats snap to a whole count per side, so the pattern always resolves at the corners no matter the size.
            </p>
          </SectionBox>
          <SectionBox eyebrow="frame lines">
            <RangeRow label="Outer lines" value={outerLines} min={0} max={3} step={1} onChange={setOuterLines} />
            <RangeRow label="Inner lines" value={innerLines} min={0} max={3} step={1} onChange={setInnerLines} />
            {(outerLines > 0 || innerLines > 0) && (
              <RangeRow label="Line spacing" value={lineGap} min={1.5} max={6} step={0.5} onChange={setLineGap} fmt={(v) => `${v.toFixed(1)} mm`} />
            )}
          </SectionBox>
          <SectionBox eyebrow="size">
            <SizeField label="Width" valueMm={widthMm} min={30} max={330} onChange={setWidthMm} />
            <SizeField label="Height" valueMm={heightMm} min={30} max={400} onChange={setHeightMm} />
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Width and height are independent - size it to a placket, a frame, a napkin corner, or a full jacket back.
            </p>
          </SectionBox>
          <SectionBox eyebrow="stitch">
            <RangeRow label="Stitch length" value={stitchLen} min={1.5} max={4} step={0.1} onChange={setStitchLen} fmt={(v) => `${v.toFixed(1)} mm`} />
            <div>
              <div className={`${LABEL} mb-1.5`}>Line weight</div>
              <ModeButtons small options={[["1", "Run"], ["3", "Bean ×3"]] as const} value={String(bean)} onChange={(v) => setBean(Number(v) as 1 | 3)} />
            </div>
            <ThreadRow hex={threadHex} onChange={setThreadHex} />
          </SectionBox>
        </>
      }
      preview={
        <PreviewRail
          built={built}
          colors={[threadHex]}
          name={NAME}
          emptyHint="Pick a style and size - the border appears as soon as it's sewable."
        />
      }
    />
  );
}
