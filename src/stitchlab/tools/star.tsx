// Stitch Lab tool: Star - the {n/m} star polygon, that one-stroke geometry
// where you place n points on a circle and connect every m-th, is the atom of
// Islamic geometric art. Here a grid of them is chained corner to corner into
// a single continuous line - a field of interlaced stars sewn without a trim.

import { useMemo, useState } from "react";
import { THREADS } from "../../data/threads";
import type { PathMm } from "../lib/generators";
import { pathsToStitches, resamplePath } from "../lib/generators";
import {
  buildDesign,
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

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export type StarOpts = {
  n?: number; // points, default 8
  m?: number; // skip, default 3 (auto-snapped coprime to n)
  cols?: number; // grid, default 4
  sizeMm?: number; // long side, default 120
};

/** {n/m} star polygon as one closed stroke around (cx,cy), radius R. */
export function starPolygon(cx: number, cy: number, R: number, n: number, m: number): PathMm {
  const pts: PathMm = [];
  for (let k = 0; k <= n; k++) {
    const idx = (k * m) % n;
    const a = -Math.PI / 2 + (2 * Math.PI * idx) / n;
    pts.push({ x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
  }
  return pts;
}

/** Snap m to the nearest value coprime with n in [2, n/2] (one-stroke stars). */
export function snapSkip(n: number, m: number): number {
  const want = Math.max(2, Math.min(Math.floor(n / 2), Math.round(m)));
  for (let off = 0; off < n; off++) {
    for (const cand of [want - off, want + off]) {
      if (cand >= 2 && cand <= n - 2 && gcd(n, cand) === 1) return cand;
    }
  }
  return 2;
}

/** Grid of stars chained in snake order into one continuous path. */
export function starField(opts: StarOpts = {}): PathMm {
  const n = Math.max(5, Math.min(16, Math.round(opts.n ?? 8)));
  const m = snapSkip(n, opts.m ?? 3);
  const cols = Math.max(1, Math.min(10, Math.round(opts.cols ?? 4)));
  const size = opts.sizeMm ?? 120;
  const cell = size / cols;
  const R = cell * 0.48;
  const half = size / 2;
  const line: PathMm = [];
  for (let gy = 0; gy < cols; gy++) {
    const rowCols = gy % 2 === 0 ? [...Array(cols).keys()] : [...Array(cols).keys()].reverse();
    for (const gx of rowCols) {
      const cx = gx * cell + cell / 2 - half;
      const cy = gy * cell + cell / 2 - half;
      const star = starPolygon(cx, cy, R, n, m);
      // Chain: connect from the previous star's last point to this star's
      // first (a short lattice connector), then trace the star.
      line.push(...star);
    }
  }
  return line;
}

// ─── Component ───────────────────────────────────────────────────────────

const NAME = "bayside-star";

export default function StarTool() {
  const [n, setN] = useState(8);
  const [m, setM] = useState(3);
  const [cols, setCols] = useState(4);
  const [sizeMm, setSizeMm] = useState(140);
  const [stitchLen, setStitchLen] = useState(2.2);
  const [threadHex, setThreadHex] = useState(
    THREADS.find((t) => t.family === "Blue" && t.hex)?.hex ??
      THREADS.find((t) => t.hex)?.hex ??
      "#082870",
  );

  const dN = useDebounced(n);
  const dM = useDebounced(m);
  const dCols = useDebounced(cols);
  const dSize = useDebounced(sizeMm);

  const snapped = snapSkip(dN, dM);

  const built = useMemo(() => {
    const line = starField({ n: dN, m: dM, cols: dCols, sizeMm: dSize });
    if (line.length < 4) return null;
    return buildDesign(pathsToStitches([resamplePath(line, stitchLen, 0.3)], 1), NAME);
  }, [dN, dM, dCols, dSize, stitchLen]);

  const stitchCount = built?.stats.realStitches ?? 0;

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="Star">
            <RangeRow label="Points (n)" value={n} min={5} max={16} onChange={setN} />
            <RangeRow label="Skip (m)" value={m} min={2} max={7} onChange={setM} fmt={(v) => `${v} → {${dN}/${snapped}}`} />
            <RangeRow label="Grid" value={cols} min={1} max={8} onChange={setCols} fmt={(v) => `${v}×${v}`} />
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              n points on a circle, connect every m-th, drawn without lifting the needle.
              m is snapped to keep the star a single stroke. A grid of them chains into
              one continuous line - {"{8/3}"} is the classic Islamic eight-point star.
            </p>
          </SectionBox>

          <SectionBox eyebrow="Stitches">
            <SizeField valueMm={sizeMm} min={40} max={330} onChange={setSizeMm} />
            <RangeRow label="Stitch length" value={stitchLen} min={1.5} max={4} step={0.1} onChange={setStitchLen} fmt={(v) => `${v.toFixed(1)} mm`} />
            <ThreadRow hex={threadHex} onChange={(hex) => setThreadHex(hex)} />
          </SectionBox>
        </>
      }
      preview={
        <PreviewRail built={built} colors={[threadHex]} name={NAME} emptyHint="Set the points.">
          {built && (
            <p className="text-[0.75rem] text-mid tabular-nums">
              {dCols * dCols} × {"{"}
              {dN}/{snapped}
              {"}"} stars · one continuous line
            </p>
          )}
          {stitchCount > 60000 && <Warning>Over 60k stitches - smaller grid or size.</Warning>}
        </PreviewRail>
      }
    />
  );
}
