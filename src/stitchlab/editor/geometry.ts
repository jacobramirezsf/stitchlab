// Editor geometry core - extracted from the workspace prototype (its proven
// pieces): every element's artwork lives in a LOCAL 0..100 box; placement
// scales it to physical mm, flips, rotates, and translates. Because stitch
// resampling happens AFTER placement (at real size), stitch lengths stay
// machine-correct at any element size - resizing regenerates, never stretches
// stitches.

import type { PathMm } from "../lib/generators";
import { parseDst } from "../lib/dst";
import { CMD } from "../lib/pattern";

/** One color's worth of paths. noResample marks pre-digitized stitches
 *  (placed DST files) that must pass through untouched. */
export type Group = { color: string; paths: PathMm[]; noResample?: boolean };

export type Placement = {
  /** Center, mm from hoop center (y-down). */
  cx: number;
  cy: number;
  /** Long side of the element, mm. */
  sizeMm: number;
  /** Degrees clockwise. */
  rotDeg: number;
  flipX?: boolean;
  flipY?: boolean;
};

export function bboxPaths(paths: PathMm[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) for (const q of p) {
    if (q.x < minX) minX = q.x;
    if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y;
    if (q.y > maxY) maxY = q.y;
  }
  return isFinite(minX)
    ? { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY }
    : { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0 };
}

/** Fit arbitrary paths into the 0..100 box, centered, aspect preserved. */
export function normalize(paths: PathMm[]): PathMm[] {
  const b = bboxPaths(paths);
  const s = b.w > 0 || b.h > 0 ? 100 / Math.max(b.w, b.h) : 1;
  const ox = 50 - (b.minX + b.w / 2) * s;
  const oy = 50 - (b.minY + b.h / 2) * s;
  return paths.map((p) => p.map((q) => ({ x: q.x * s + ox, y: q.y * s + oy })));
}

/** Normalize several groups with ONE shared transform so relative geometry
 *  (e.g. cross-stitch cell alignment across colors) is preserved. */
export function normalizeGroups(groups: Group[]): Group[] {
  const all = groups.flatMap((g) => g.paths);
  const b = bboxPaths(all);
  const s = b.w > 0 || b.h > 0 ? 100 / Math.max(b.w, b.h) : 1;
  const ox = 50 - (b.minX + b.w / 2) * s;
  const oy = 50 - (b.minY + b.h / 2) * s;
  return groups.map((g) => ({
    ...g,
    paths: g.paths.map((p) => p.map((q) => ({ x: q.x * s + ox, y: q.y * s + oy }))),
  }));
}

/** 0..100 local box → world mm via the element's placement. */
export function placePaths(paths: PathMm[], pl: Placement): PathMm[] {
  const s = pl.sizeMm / 100;
  const a = (pl.rotDeg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const fx = pl.flipX ? -1 : 1, fy = pl.flipY ? -1 : 1;
  return paths.map((p) => p.map((q) => {
    const x0 = (q.x - 50) * s * fx, y0 = (q.y - 50) * s * fy;
    return { x: pl.cx + x0 * cos - y0 * sin, y: pl.cy + x0 * sin + y0 * cos };
  }));
}

/** Parse DST bytes into per-color-block path groups (normalized to the local
 *  box). Jumps/trims break paths; color changes start a new group. The
 *  original size in mm is returned so placement can default to true size. */
export function dstToGroups(bytes: Uint8Array, colors: string[], fallback = "#26324d"): {
  groups: Group[];
  widthMm: number;
  heightMm: number;
} {
  try {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const pat = parseDst(buf);
    const groups: Group[] = [];
    let block = 0;
    let path: PathMm = [];
    let paths: PathMm[] = [];
    const flushPath = () => { if (path.length >= 2) paths.push(path); path = []; };
    const flushBlock = () => {
      flushPath();
      if (paths.length) groups.push({ color: colors[block] ?? fallback, paths, noResample: true });
      paths = [];
    };
    for (const st of pat.stitches) {
      if (st.cmd === CMD.STITCH) path.push({ x: st.x, y: st.y });
      else if (st.cmd === CMD.COLOR_CHANGE) { flushBlock(); block++; }
      else flushPath();
    }
    flushBlock();
    const b = bboxPaths(groups.flatMap((g) => g.paths));
    return { groups: normalizeGroups(groups), widthMm: b.w / 10, heightMm: b.h / 10 };
  } catch {
    return { groups: [], widthMm: 0, heightMm: 0 };
  }
}

export function pathLengthMm(paths: PathMm[]): number {
  let len = 0;
  for (const p of paths)
    for (let i = 1; i < p.length; i++) len += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
  return len;
}
