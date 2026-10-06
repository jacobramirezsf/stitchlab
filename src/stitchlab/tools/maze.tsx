// Stitch Lab tool: Maze - a proper perfect maze (recursive-backtracker carve),
// stitchable two ways. "Walls" gives the iconic puzzle. "Solution" traces the
// one true path from entrance to exit as a single unbroken line - a wandering
// continuous stitch with zero trims, the answer sewn in thread.

import { useMemo, useState } from "react";
import { THREADS } from "../../data/threads";
import type { PathMm } from "../lib/generators";
import { pathsToStitches, resamplePath } from "../lib/generators";
import { mergePolylines } from "../lib/lineart";
import { orderStrokesByTravel } from "../lib/routing";
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

export type MazeOpts = {
  cols?: number; // default 12
  rows?: number; // default 12
  sizeMm?: number; // long side, default 120
  render?: "walls" | "solution";
  seed?: number;
  /** Opt-in: travel-order the wall runs (shorter carries, cleaner back;
   *  no added thread). Default off preserves the original stroke order. */
  connect?: boolean;
};

// Wall bitmask per cell: 1=N 2=E 4=S 8=W (set = wall present).
export function carveMaze(cols: number, rows: number, seed: number): Uint8Array {
  const walls = new Uint8Array(cols * rows).fill(0b1111);
  const visited = new Uint8Array(cols * rows);
  const rand = mulberry32(seed);
  const stack: number[] = [0];
  visited[0] = 1;
  const dirs = [
    [0, -1, 1, 4], // N: dx,dy,thisWall,neighborWall
    [1, 0, 2, 8], // E
    [0, 1, 4, 1], // S
    [-1, 0, 8, 2], // W
  ];
  while (stack.length) {
    const cur = stack[stack.length - 1];
    const cx = cur % cols;
    const cy = Math.floor(cur / cols);
    // Shuffle directions (seeded).
    const order = [0, 1, 2, 3];
    for (let i = 3; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    let moved = false;
    for (const di of order) {
      const [dx, dy, wThis, wNbr] = dirs[di];
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const nbr = ny * cols + nx;
      if (visited[nbr]) continue;
      walls[cur] &= ~wThis;
      walls[nbr] &= ~wNbr;
      visited[nbr] = 1;
      stack.push(nbr);
      moved = true;
      break;
    }
    if (!moved) stack.pop();
  }
  return walls;
}

/** Unique passage path between two cells of a perfect maze (it's a tree). */
export function solveMaze(
  walls: Uint8Array,
  cols: number,
  rows: number,
  start: number,
  goal: number,
): number[] {
  const prev = new Int32Array(cols * rows).fill(-2);
  prev[start] = -1;
  const queue = [start];
  const dirs = [
    [0, -1, 1],
    [1, 0, 2],
    [0, 1, 4],
    [-1, 0, 8],
  ];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === goal) break;
    const cx = cur % cols;
    const cy = Math.floor(cur / cols);
    for (const [dx, dy, w] of dirs) {
      if (walls[cur] & w) continue; // wall blocks
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const nbr = ny * cols + nx;
      if (prev[nbr] !== -2) continue;
      prev[nbr] = cur;
      queue.push(nbr);
    }
  }
  const path: number[] = [];
  let c = goal;
  while (c !== -1 && c !== -2) {
    path.push(c);
    c = prev[c];
  }
  return path.reverse();
}

export function mazePaths(opts: MazeOpts = {}): PathMm[] {
  const cols = Math.max(3, Math.min(60, Math.round(opts.cols ?? 12)));
  const rows = Math.max(3, Math.min(60, Math.round(opts.rows ?? 12)));
  const size = opts.sizeMm ?? 120;
  const render = opts.render ?? "walls";
  const cell = size / Math.max(cols, rows);
  const halfW = (cols * cell) / 2;
  const halfH = (rows * cell) / 2;
  const walls = carveMaze(cols, rows, opts.seed ?? 1);

  if (render === "solution") {
    const path = solveMaze(walls, cols, rows, 0, cols * rows - 1);
    const line: PathMm = path.map((c) => ({
      x: (c % cols) * cell + cell / 2 - halfW,
      y: Math.floor(c / cols) * cell + cell / 2 - halfH,
    }));
    // Lead in/out through the entrance and exit gaps.
    if (line.length > 1) {
      line.unshift({ x: line[0].x, y: -halfH - cell * 0.4 });
      line.push({ x: line[line.length - 1].x, y: halfH + cell * 0.4 });
    }
    return [line];
  }

  // Walls: emit each present wall exactly once with the N+W convention (a
  // cell's N wall == the cell-above's S wall, so emitting only N and W covers
  // every interior wall without doubling; E and S are drawn only on the far
  // borders). The entrance gap removes cell 0's W wall, the exit gap the last
  // cell's E wall.
  const segs: PathMm[] = [];
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const c = gy * cols + gx;
      const x0 = gx * cell - halfW;
      const y0 = gy * cell - halfH;
      const x1 = x0 + cell;
      const y1 = y0 + cell;
      if (walls[c] & 1) segs.push([{ x: x0, y: y0 }, { x: x1, y: y0 }]); // N
      const isEntrance = gx === 0 && gy === 0;
      if (walls[c] & 8 && !isEntrance) segs.push([{ x: x0, y: y0 }, { x: x0, y: y1 }]); // W
      const isExit = gx === cols - 1 && gy === rows - 1;
      if (gx === cols - 1 && walls[c] & 2 && !isExit) segs.push([{ x: x1, y: y0 }, { x: x1, y: y1 }]); // E border
      if (gy === rows - 1 && walls[c] & 4) segs.push([{ x: x0, y: y1 }, { x: x1, y: y1 }]); // S border
    }
  }
  const merged = mergePolylines(segs, cell * 0.06);
  // Opt-in: reorder the wall runs to minimise the carry between them (shorter
  // jumps → cleaner back, no long exposed carries). Zero added thread - the
  // wall network's many dead-ends make full Eulerisation too thread-costly to
  // be worth the trim saving, so we optimise travel instead of forcing one line.
  return opts.connect ? orderStrokesByTravel(merged) : merged;
}

// ─── Component ───────────────────────────────────────────────────────────

const NAME = "bayside-maze";

export default function MazeTool() {
  const [render, setRender] = useState<"walls" | "solution">("walls");
  const [cols, setCols] = useState(12);
  const [sizeMm, setSizeMm] = useState(120);
  const [seed, setSeed] = useState(42);
  const [connect, setConnect] = useState(false);
  const [stitchLen, setStitchLen] = useState(2.2);
  const [bean, setBean] = useState<1 | 3>(1);
  const [threadHex, setThreadHex] = useState(
    THREADS.find((t) => t.family === "Black" && t.hex)?.hex ??
      THREADS.find((t) => t.hex)?.hex ??
      "#1c1c1a",
  );

  const dCols = useDebounced(cols);
  const dSize = useDebounced(sizeMm);

  const built = useMemo(() => {
    const raw = mazePaths({ cols: dCols, rows: dCols, sizeMm: dSize, render, seed, connect: render === "walls" ? connect : false });
    if (raw.length === 0) return null;
    const sampled = raw.map((p) => resamplePath(p, stitchLen, 0.3)).filter((p) => p.length >= 2);
    return buildDesign(pathsToStitches(sampled, bean), NAME);
  }, [dCols, dSize, render, seed, stitchLen, bean, connect]);

  const stitchCount = built?.stats.realStitches ?? 0;

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="Maze">
            <ModeButtons
              options={[
                ["walls", "Walls (the puzzle)"],
                ["solution", "Solution (one line)"],
              ]}
              value={render}
              onChange={setRender}
            />
            <RangeRow label="Grid" value={cols} min={4} max={40} onChange={setCols} fmt={(v) => `${v}×${v}`} />
            <button
              onClick={() => setSeed(Math.floor(Math.random() * 100000))}
              className="border border-hairline bg-bg px-3 py-1 text-[0.75rem] text-fg hover:bg-card"
            >
              New maze (seed {seed})
            </button>
            {render === "walls" && (
              <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer">
                <input type="checkbox" checked={connect} onChange={(ev) => setConnect(ev.target.checked)} className="accent-accent" />
                Optimize routing (shorter carries)
              </label>
            )}
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              {render === "solution"
                ? "The one true path from top-left to bottom-right, sewn as a single wandering line - zero trims."
                : "A perfect maze: exactly one path between any two cells. Entrance top-left, exit bottom-right."}
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
        <PreviewRail built={built} colors={[threadHex]} name={NAME} emptyHint="Carve a maze.">
          {built && (
            <p className="text-[0.75rem] text-mid tabular-nums">
              {render === "solution"
                ? "one continuous solution line · zero trims"
                : `${built.pattern.blockColors.length} wall runs`}
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
