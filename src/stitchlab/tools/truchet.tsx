// Stitch Lab tool: Truchet - a grid where every cell drops one of two tiles at
// a random flip, and out of that coin-toss emerge flowing labyrinths. Smith's
// curved tiles (quarter-circle arcs meeting at edge midpoints) join across the
// whole grid into a handful of long continuous loops - endless variation from
// one seed, and it sews like the space-filling curves that stitched so well.

import { useMemo, useState } from "react";
import { THREADS } from "../../data/threads";
import type { PathMm } from "../lib/generators";
import { pathsToStitches, resamplePath } from "../lib/generators";
import { mergePolylines } from "../lib/lineart";
import {
  buildDesign,
  ModeButtons,
  PreviewRail,
  RangeRow,
  SectionBox,
  ThreadRow,
  ToolLayout,
  useDebounced,
  Warning,
  SizeField,
} from "./shared";

// ─── Pure logic ──────────────────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type TruchetSet = "curved" | "diagonal" | "maze";

export type TruchetOpts = {
  cols?: number; // grid columns, default 8
  sizeMm?: number; // long side, default 100
  set?: TruchetSet;
  seed?: number;
};

/** Quarter-circle arc around (cx,cy), from startDeg to endDeg (y-down). */
function quarterArc(cx: number, cy: number, r: number, startDeg: number, endDeg: number): PathMm {
  const pts: PathMm = [];
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const a = ((startDeg + (endDeg - startDeg) * (i / steps)) * Math.PI) / 180;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

/** Truchet tiling → continuous loops (merged across the whole grid). */
export function truchetPaths(opts: TruchetOpts = {}): PathMm[] {
  const cols = Math.max(2, Math.min(40, Math.round(opts.cols ?? 8)));
  const size = opts.sizeMm ?? 100;
  const cell = size / cols;
  const r = cell / 2;
  const rand = mulberry32(opts.seed ?? 1);
  const set = opts.set ?? "curved";
  const half = size / 2;
  const segs: PathMm[] = [];

  for (let gy = 0; gy < cols; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const ox = gx * cell - half;
      const oy = gy * cell - half;
      const flip = rand() < 0.5;
      if (set === "curved") {
        if (!flip) {
          segs.push(quarterArc(ox, oy, r, 0, 90)); // TL corner
          segs.push(quarterArc(ox + cell, oy + cell, r, 180, 270)); // BR
        } else {
          segs.push(quarterArc(ox + cell, oy, r, 90, 180)); // TR
          segs.push(quarterArc(ox, oy + cell, r, 270, 360)); // BL
        }
      } else if (set === "diagonal") {
        if (!flip) segs.push([{ x: ox, y: oy }, { x: ox + cell, y: oy + cell }]);
        else segs.push([{ x: ox + cell, y: oy }, { x: ox, y: oy + cell }]);
      } else {
        // maze: one of the two "wall" diagonals plus the perpendicular edge
        // midline - reads as a woven labyrinth.
        const mx = ox + cell / 2;
        const my = oy + cell / 2;
        if (!flip) {
          segs.push([{ x: mx, y: oy }, { x: mx, y: oy + cell }]); // vertical
          segs.push([{ x: ox, y: my }, { x: ox + cell / 2, y: my }]); // half horizontal
        } else {
          segs.push([{ x: ox, y: my }, { x: ox + cell, y: my }]); // horizontal
          segs.push([{ x: mx, y: oy }, { x: mx, y: oy + cell / 2 }]); // half vertical
        }
      }
    }
  }
  return mergePolylines(segs, cell * 0.06);
}

// ─── Component ───────────────────────────────────────────────────────────

const NAME = "bayside-truchet";

export default function TruchetTool() {
  const [set, setSet] = useState<TruchetSet>("curved");
  const [cols, setCols] = useState(8);
  const [sizeMm, setSizeMm] = useState(120);
  const [seed, setSeed] = useState(1721); // Sébastien Truchet, 1704 + a nudge
  const [stitchLen, setStitchLen] = useState(2.4);
  const [bean, setBean] = useState<1 | 3>(1);
  const [threadHex, setThreadHex] = useState(
    THREADS.find((t) => t.family === "Blue" && t.hex)?.hex ??
      THREADS.find((t) => t.hex)?.hex ??
      "#082870",
  );

  const dCols = useDebounced(cols);
  const dSize = useDebounced(sizeMm);

  const built = useMemo(() => {
    const raw = truchetPaths({ cols: dCols, sizeMm: dSize, set, seed });
    if (raw.length === 0) return null;
    const sampled = raw.map((p) => resamplePath(p, stitchLen, 0.4)).filter((p) => p.length >= 2);
    return buildDesign(pathsToStitches(sampled, bean), NAME);
  }, [dCols, dSize, set, seed, stitchLen, bean]);

  const loops = built ? built.pattern.blockColors.length : 0;
  const stitchCount = built?.stats.realStitches ?? 0;

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="Tiles">
            <ModeButtons
              options={[
                ["curved", "Curved"],
                ["diagonal", "Diagonal"],
                ["maze", "Maze"],
              ]}
              value={set}
              onChange={setSet}
            />
            <RangeRow label="Grid" value={cols} min={3} max={24} onChange={setCols} fmt={(v) => `${v}×${v}`} />
            <button
              onClick={() => setSeed(Math.floor(Math.random() * 100000))}
              className="border border-hairline bg-bg px-3 py-1 text-[0.75rem] text-fg hover:bg-card"
            >
              Reshuffle (seed {seed})
            </button>
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Every cell flips a coin between two tiles. Curved tiles flow into long
              continuous loops; diagonal and maze read as woven labyrinths. Reshuffle
              endlessly - no two seeds alike.
            </p>
          </SectionBox>

          <SectionBox eyebrow="Stitches">
            <SizeField valueMm={sizeMm} min={50} max={330} onChange={setSizeMm} />
            <RangeRow label="Stitch length" value={stitchLen} min={1.5} max={4} step={0.1} onChange={setStitchLen} fmt={(v) => `${v.toFixed(1)} mm`} />
            <ModeButtons
              small
              options={[
                [1, "Run"],
                [3, "Bean ×3"],
              ]}
              value={bean}
              onChange={setBean}
            />
            <ThreadRow hex={threadHex} onChange={(hex) => setThreadHex(hex)} />
          </SectionBox>
        </>
      }
      preview={
        <PreviewRail built={built} colors={[threadHex]} name={NAME} emptyHint="Roll the tiles.">
          {built && (
            <p className="text-[0.75rem] text-mid tabular-nums">
              {loops} continuous loop{loops === 1 ? "" : "s"} · one seed, endless mazes
            </p>
          )}
          {stitchCount > 60000 && (
            <Warning>Over 60k stitches - coarser grid or smaller size.</Warning>
          )}
        </PreviewRail>
      }
    />
  );
}
