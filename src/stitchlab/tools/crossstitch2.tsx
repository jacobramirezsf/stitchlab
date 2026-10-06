// Stitch Lab tool: Cross-Stitch V2 - everything V1 does, pushed on three
// quality axes that matter on fabric:
//   • Perceptual color. Clustering and cone-matching happen in CIELAB, not
//     RGB, so the palette groups colors the way an eye does.
//   • Confetti cleanup. Isolated one-cell islands (the noise that makes a
//     chart look busy and adds needless color jumps) get absorbed into their
//     surrounding color.
//   • Fractional edges. Where colors meet on a diagonal, three-quarter and
//     quarter stitches smooth the staircase - the technique that separates a
//     fine cross-stitch from a blocky one.
// V1 is untouched; this is a parallel tool.

import { useMemo, useState } from "react";
import { THREADS, type Thread } from "../../data/threads";
import type { PathMm } from "../lib/generators";
import { pathGroupsToStitches } from "../lib/generators";
import {
  buildDesign,
  DropZone,
  PreviewRail,
  RangeRow,
  SectionBox,
  SizeField,
  ThreadSelect,
  ToolLayout,
  useDebounced,
} from "./shared";

// ─── Color: sRGB → CIELAB ────────────────────────────────────────────────

type Lab = [number, number, number];

function srgbToLab(r: number, g: number, b: number): Lab {
  // sRGB → linear → XYZ (D65) → Lab
  const lin = (c: number) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const rl = lin(r);
  const gl = lin(g);
  const bl = lin(b);
  const x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
  const y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722;
  const z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const dLab = (a: Lab, b: Lab) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

// Precompute cone LABs once.
const CONES: { thread: Thread; lab: Lab }[] = THREADS.filter((t) => t.hex).map((t) => {
  const [r, g, b] = hexToRgb(t.hex!);
  return { thread: t, lab: srgbToLab(r, g, b) };
});

function nearestConeLab(lab: Lab, exclude: Set<string>): { thread: Thread; lab: Lab } {
  let best = CONES[0];
  let bd = Infinity;
  for (const c of CONES) {
    if (exclude.has(c.thread.code)) continue;
    const d = dLab(lab, c.lab);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

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

// ─── Quantize (LAB k-means++), confetti cleanup ──────────────────────────

export type PaletteEntry = { hex: string; code: string; name: string };

export type QuantV2 = {
  cols: number;
  rows: number;
  /** Full-cell cone index per cell, or -1 for bare fabric. */
  grid: Int16Array;
  /** 2×2 sub-cell cone index (for fractional edges). Length 4·cols·rows. */
  sub: Int16Array;
  palette: PaletteEntry[];
};

export function quantizeV2(
  img: { w: number; h: number; rgb: Uint8ClampedArray },
  opts: { cols: number; k: number; skipLight?: boolean; lightThreshold?: number; cleanup?: boolean },
): QuantV2 {
  const { w, h, rgb } = img;
  const cols = Math.max(8, Math.round(opts.cols));
  const rows = Math.max(4, Math.round((cols * h) / w));
  const k = Math.max(2, Math.min(16, Math.round(opts.k)));
  const skipLight = opts.skipLight ?? true;
  const lightT = opts.lightThreshold ?? 0.92;

  // Sample 2×2 sub-cells (supersample → smoother cell color + fractional data).
  const sw = cols * 2;
  const sh = rows * 2;
  const subLab: Lab[] = new Array(sw * sh);
  const subLum = new Float32Array(sw * sh);
  for (let sy = 0; sy < sh; sy++) {
    for (let sx = 0; sx < sw; sx++) {
      // average the image block for this sub-cell
      const x0 = Math.floor((sx * w) / sw);
      const x1 = Math.max(x0 + 1, Math.floor(((sx + 1) * w) / sw));
      const y0 = Math.floor((sy * h) / sh);
      const y1 = Math.max(y0 + 1, Math.floor(((sy + 1) * h) / sh));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          r += rgb[i];
          g += rgb[i + 1];
          b += rgb[i + 2];
          n++;
        }
      r /= n;
      g /= n;
      b /= n;
      subLab[sy * sw + sx] = srgbToLab(r, g, b);
      subLum[sy * sw + sx] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    }
  }

  // Which sub-cells participate (skip bare-fabric light).
  const active: number[] = [];
  for (let i = 0; i < sw * sh; i++) if (!skipLight || subLum[i] <= lightT) active.push(i);
  if (active.length < k) {
    return { cols, rows, grid: new Int16Array(cols * rows).fill(-1), sub: new Int16Array(sw * sh).fill(-1), palette: [] };
  }

  // k-means++ init in LAB.
  const rand = mulberry32(1);
  const centers: Lab[] = [subLab[active[0]]];
  while (centers.length < k) {
    const d2 = active.map((i) => {
      let m = Infinity;
      for (const c of centers) m = Math.min(m, dLab(subLab[i], c));
      return m;
    });
    const total = d2.reduce((s, v) => s + v, 0);
    let r = rand() * total;
    let pick = active[0];
    for (let j = 0; j < active.length; j++) {
      r -= d2[j];
      if (r <= 0) {
        pick = active[j];
        break;
      }
    }
    centers.push(subLab[pick]);
  }
  // Lloyd iterations.
  const assign = new Int16Array(sw * sh).fill(-1);
  for (let it = 0; it < 14; it++) {
    for (const i of active) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = dLab(subLab[i], centers[c]);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      assign[i] = best;
    }
    const sum = centers.map(() => [0, 0, 0, 0] as [number, number, number, number]);
    for (const i of active) {
      const c = assign[i];
      sum[c][0] += subLab[i][0];
      sum[c][1] += subLab[i][1];
      sum[c][2] += subLab[i][2];
      sum[c][3]++;
    }
    for (let c = 0; c < centers.length; c++) {
      if (sum[c][3] > 0) centers[c] = [sum[c][0] / sum[c][3], sum[c][1] / sum[c][3], sum[c][2] / sum[c][3]];
    }
  }

  // Snap each cluster to a unique nearest cone in LAB.
  const used = new Set<string>();
  const clusterCone: PaletteEntry[] = [];
  const clusterToPalette: number[] = [];
  const paletteByCode = new Map<string, number>();
  for (let c = 0; c < centers.length; c++) {
    const cone = nearestConeLab(centers[c], used).thread;
    used.add(cone.code);
    let pi = paletteByCode.get(cone.code);
    if (pi === undefined) {
      pi = clusterCone.length;
      clusterCone.push({ hex: cone.hex!, code: cone.code, name: cone.name });
      paletteByCode.set(cone.code, pi);
    }
    clusterToPalette[c] = pi;
  }

  const sub = new Int16Array(sw * sh).fill(-1);
  for (const i of active) sub[i] = clusterToPalette[assign[i]];

  // Full-cell grid = majority vote of the 4 sub-cells.
  const grid = new Int16Array(cols * rows).fill(-1);
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const counts = new Map<number, number>();
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const v = sub[(gy * 2 + dy) * sw + (gx * 2 + dx)];
          if (v >= 0) counts.set(v, (counts.get(v) ?? 0) + 1);
        }
      let best = -1;
      let bc = 0;
      for (const [v, c] of counts) if (c > bc) {
        bc = c;
        best = v;
      }
      grid[gy * cols + gx] = best;
    }
  }

  // Confetti cleanup: any cell whose 4-neighbourhood contains no same-color
  // neighbor is reassigned to its most common neighbor.
  if (opts.cleanup ?? true) {
    const src = Int16Array.from(grid);
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        const c = src[gy * cols + gx];
        if (c < 0) continue;
        const nb: number[] = [];
        if (gx > 0) nb.push(src[gy * cols + gx - 1]);
        if (gx < cols - 1) nb.push(src[gy * cols + gx + 1]);
        if (gy > 0) nb.push(src[(gy - 1) * cols + gx]);
        if (gy < rows - 1) nb.push(src[(gy + 1) * cols + gx]);
        if (nb.some((v) => v === c)) continue; // has a same-color neighbor - keep
        const counts = new Map<number, number>();
        for (const v of nb) if (v >= 0) counts.set(v, (counts.get(v) ?? 0) + 1);
        let best = c;
        let bc = 0;
        for (const [v, cn] of counts) if (cn > bc) {
          bc = cn;
          best = v;
        }
        grid[gy * cols + gx] = best;
      }
    }
  }

  return { cols, rows, grid, sub, palette: clusterCone };
}

// ─── Stitch geometry: full cross + fractional edges ──────────────────────

export function crossesV2(
  q: QuantV2,
  cellMm: number,
  paletteLength: number,
  fractional: boolean,
): PathMm[][] {
  const { cols, rows, grid, sub } = q;
  const ox = (cols * cellMm) / 2;
  const oy = (rows * cellMm) / 2;
  const groups: PathMm[][] = Array.from({ length: paletteLength }, () => []);

  // Full cross for a cell corner box.
  const corners = (gx: number, gy: number) => {
    const x0 = gx * cellMm - ox;
    const y0 = gy * cellMm - oy;
    const x1 = x0 + cellMm;
    const y1 = y0 + cellMm;
    return {
      bl: { x: x0, y: y1 },
      tr: { x: x1, y: y0 },
      tl: { x: x0, y: y0 },
      br: { x: x1, y: y1 },
      c: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 },
    };
  };

  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const cell = grid[gy * cols + gx];
      if (cell < 0) continue;
      const k = corners(gx, gy);
      // Detect a fractional boundary: the 4 sub-cells split between the cell's
      // color and one other. If so, majority gets a three-quarter, the
      // minority corner gets a quarter - smoothing the diagonal.
      let frac: { minority: number; corner: 0 | 1 | 2 | 3 } | null = null;
      if (fractional) {
        const s = [
          sub[(gy * 2) * (cols * 2) + gx * 2], // TL
          sub[(gy * 2) * (cols * 2) + gx * 2 + 1], // TR
          sub[(gy * 2 + 1) * (cols * 2) + gx * 2 + 1], // BR
          sub[(gy * 2 + 1) * (cols * 2) + gx * 2], // BL
        ];
        const other = s.filter((v) => v >= 0 && v !== cell);
        if (other.length === 1) {
          const minority = other[0];
          const corner = s.indexOf(minority) as 0 | 1 | 2 | 3;
          if (minority < paletteLength) frac = { minority, corner };
        }
      }

      if (!frac) {
        // Full cross: bl→tr, tl→br.
        groups[cell].push([k.bl, k.tr]);
        groups[cell].push([k.tl, k.br]);
      } else {
        // Three-quarter of the cell color + quarter of the minority in its
        // corner. The three-quarter = one full diagonal + a half-leg to center
        // from the corner opposite the minority; the quarter = minority corner
        // to center.
        const cornerPt = [k.tl, k.tr, k.br, k.bl][frac.corner];
        const oppPt = [k.br, k.bl, k.tl, k.tr][frac.corner];
        // full diagonal of the cell color (the one NOT touching the minority corner)
        const diagA = frac.corner === 0 || frac.corner === 2 ? [k.bl, k.tr] : [k.tl, k.br];
        groups[cell].push(diagA as PathMm);
        groups[cell].push([oppPt, k.c]); // three-quarter leg
        groups[frac.minority].push([cornerPt, k.c]); // quarter
      }
    }
  }

  // Serpentine order within each color to keep the needle local.
  return groups.map((g) => g);
}

// ─── Component ───────────────────────────────────────────────────────────

const NAME = "bayside-crossstitch2";

export default function CrossStitchV2Tool() {
  const [img, setImg] = useState<{ w: number; h: number; rgb: Uint8ClampedArray } | null>(null);
  const [fileName, setFileName] = useState("");
  const [cols, setCols] = useState(70);
  const [k, setK] = useState(6);
  const [cellMm, setCellMm] = useState(2.5);
  const [skipLight, setSkipLight] = useState(true);
  const [lightThreshold, setLightThreshold] = useState(0.92);
  const [cleanup, setCleanup] = useState(true);
  const [fractional, setFractional] = useState(true);
  const [overrides, setOverrides] = useState<Record<number, string>>({});

  const loadImage = async (file: File) => {
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise<void>((res, rej) => {
        image.onload = () => res();
        image.onerror = () => rej();
        image.src = url;
      });
      const long = 260;
      const scale = long / Math.max(image.width, image.height);
      const w = Math.max(32, Math.round(image.width * scale));
      const h = Math.max(32, Math.round(image.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      // Composite over white so transparent PNG areas read as bare fabric and
      // get removed by "skip light", instead of reading as black and stitching.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(image, 0, 0, w, h);
      setImg({ w, h, rgb: ctx.getImageData(0, 0, w, h).data });
      setFileName(file.name);
      setOverrides({});
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const dCols = useDebounced(cols, 300);
  const dK = useDebounced(k, 300);

  const quant = useMemo(
    () => (img ? quantizeV2(img, { cols: dCols, k: dK, skipLight, lightThreshold, cleanup }) : null),
    [img, dCols, dK, skipLight, lightThreshold, cleanup],
  );

  const built = useMemo(() => {
    if (!quant || quant.palette.length === 0) return { built: null, hexes: [] as string[] };
    const groups = crossesV2(quant, cellMm, quant.palette.length, fractional);
    const hexes = quant.palette.map((p, i) => overrides[i] ?? p.hex);
    return { built: buildDesign(pathGroupsToStitches(groups, 1), NAME), hexes };
  }, [quant, cellMm, fractional, overrides]);

  const designW = quant ? quant.cols * cellMm : 0;
  const designH = quant ? quant.rows * cellMm : 0;

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="Photo">
            <DropZone onFile={(f) => void loadImage(f)} className="border border-dashed border-mid/50 px-3 py-3">
              <label className="inline-block cursor-pointer border border-hairline bg-bg px-4 py-1.5 text-[0.8125rem] text-fg hover:bg-card">
                {fileName ? `↻ ${fileName}` : "Choose image"}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(ev) => {
                    const f = ev.target.files?.[0];
                    ev.target.value = "";
                    if (f) void loadImage(f);
                  }}
                />
              </label>
              <span className="ml-2 text-[0.6875rem] text-mid">or drop it here</span>
            </DropZone>
          </SectionBox>

          <SectionBox eyebrow="Chart">
            <RangeRow label="Stitches across" value={cols} min={24} max={200} onChange={setCols} fmt={(v) => `${v} stitches`} />
            <RangeRow label="Thread colors" value={k} min={2} max={14} onChange={setK} fmt={(v) => `${v} cones`} />
            <div>
              <div className="text-[0.6875rem] tracking-[0.14em] uppercase text-mid mb-1">
                Stitch size (drives finished size)
              </div>
              <SizeField
                label="Finished"
                valueMm={designW}
                min={40}
                max={406}
                onChange={(mm) => setCellMm(Math.max(1.2, Math.min(4, mm / Math.max(1, cols))))}
              />
              <p className="text-[0.6875rem] text-mid mt-1 tabular-nums">
                {cellMm.toFixed(2)} mm/stitch · {designW.toFixed(0)}×{designH.toFixed(0)} mm chart
              </p>
            </div>
          </SectionBox>

          <SectionBox eyebrow="Quality">
            {(
              [
                ["Skip light areas (bare fabric)", skipLight, setSkipLight],
                ["Confetti cleanup", cleanup, setCleanup],
                ["Fractional edges (smooth diagonals)", fractional, setFractional],
              ] as const
            ).map(([label, val, set]) => (
              <label key={label} className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer">
                <input type="checkbox" checked={val} onChange={(ev) => set(ev.target.checked)} className="accent-accent" />
                {label}
              </label>
            ))}
            {skipLight && (
              <RangeRow
                label="Light threshold"
                value={lightThreshold}
                min={0.5}
                max={1}
                step={0.01}
                onChange={setLightThreshold}
                fmt={(v) => `${Math.round(v * 100)}%`}
              />
            )}
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Colors are grouped the way the eye sees them, so the palette clusters
              the way an eye does. Fractional edges add three-quarter and quarter stitches
              where colors meet on a diagonal - the fine-cross-stitch smoothing trick.
            </p>
          </SectionBox>

          {quant && quant.palette.length > 0 && (
            <SectionBox eyebrow="Cones to pull">
              {quant.palette.map((p, i) => (
                <div key={i} className="border border-hairline bg-bg px-2.5 py-2 space-y-1">
                  <div className="flex items-center gap-2 text-[0.75rem] text-fg">
                    <span className="w-4 h-4 border border-hairline shrink-0" style={{ background: overrides[i] ?? p.hex }} />
                    {p.code} {p.name}
                  </div>
                  <ThreadSelect value={overrides[i] ?? p.hex} onChange={(hex) => setOverrides((o) => ({ ...o, [i]: hex }))} />
                </div>
              ))}
            </SectionBox>
          )}
        </>
      }
      preview={
        <PreviewRail built={built.built} colors={built.hexes} name={NAME} emptyHint="Drop a photo to chart it.">
          {quant && built.built && (
            <p className="text-[0.75rem] text-mid tabular-nums">
              {quant.cols}×{quant.rows} chart · {quant.palette.length} cones ·{" "}
              {fractional ? "fractional edges on" : "full crosses"} · perceptual color
            </p>
          )}
        </PreviewRail>
      }
    />
  );
}
