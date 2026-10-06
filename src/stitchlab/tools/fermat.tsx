// Stitch Lab tool: Fermat Fill - Connected Fermat Spirals (Zhao, Gu, Huang
// et al., SIGGRAPH 2016), the crown-jewel fill: any region filled by ONE
// continuous, non-crossing spiral whose both ends exit at the outer
// boundary. The trick that makes it connectable: instead of spiraling to the
// center and dying there (ordinary spiral), the curve spirals inward on the
// EVEN iso-contours and returns outward on the ODD ones, all cuts aligned
// along a common corridor - like the two arms of a Fermat spiral r² = a²θ.
//
// Pipeline: exact Euclidean distance transform (Felzenszwalb & Huttenlocher
// two-pass) → marching-squares iso-contours every `spacing` mm → nesting
// forest → maximal spirallable chains → per-chain Fermat construction →
// chains sewn in DFS order. Fully spirallable shapes (circle, heart, blobs)
// come out as ONE line; branched shapes (star, ring) come out as one line
// per lobe with a hop between.

import { useMemo, useState } from "react";
import { THREADS } from "../../data/threads";
import type { PathMm } from "../lib/generators";
import { pathsToStitches, resamplePath } from "../lib/generators";
import { mergePolylines } from "../lib/lineart";
import type { Ring } from "./tatami";
import {
  buildDesign,
  PreviewRail,
  RangeRow,
  SectionBox,
  ThreadRow,
  ToolLayout,
  useDebounced,
  useShapeSource,
  Warning,
  SizeField,
} from "./shared";

// ─── Distance field ──────────────────────────────────────────────────────

function insideRings(rings: Ring[], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** Felzenszwalb 1-D squared-distance transform. */
function edt1d(f: Float64Array, n: number, out: Float64Array): void {
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const d = q - v[k];
    out[q] = d * d + f[v[k]];
  }
}

export type DistField = {
  gw: number;
  gh: number;
  cellMm: number;
  minX: number;
  minY: number;
  /** Distance to the region boundary in mm; 0 outside. */
  d: Float32Array;
};

export function distanceField(rings: Ring[], cellMm: number): DistField {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rings)
    for (const p of r) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  minX -= cellMm * 2;
  minY -= cellMm * 2;
  const gw = Math.max(8, Math.ceil((maxX - minX) / cellMm) + 4);
  const gh = Math.max(8, Math.ceil((maxY - minY) / cellMm) + 4);
  const INF = 1e12;
  const g = new Float64Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const wx = minX + (x + 0.5) * cellMm;
      const wy = minY + (y + 0.5) * cellMm;
      g[y * gw + x] = insideRings(rings, wx, wy) ? INF : 0;
    }
  }
  // Columns then rows.
  const col = new Float64Array(gh);
  const outCol = new Float64Array(gh);
  for (let x = 0; x < gw; x++) {
    for (let y = 0; y < gh; y++) col[y] = g[y * gw + x];
    edt1d(col, gh, outCol);
    for (let y = 0; y < gh; y++) g[y * gw + x] = outCol[y];
  }
  const row = new Float64Array(gw);
  const outRow = new Float64Array(gw);
  const d = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) row[x] = g[y * gw + x];
    edt1d(row, gw, outRow);
    for (let x = 0; x < gw; x++) d[y * gw + x] = Math.sqrt(outRow[x]) * cellMm;
  }
  return { gw, gh, cellMm, minX, minY, d };
}

/** Marching-squares closed contours of the distance field at `levelMm`. */
export function fieldContours(field: DistField, levelMm: number): PathMm[] {
  const { gw, gh, cellMm, minX, minY, d } = field;
  const segs: PathMm[] = [];
  const v = (x: number, y: number) => d[y * gw + x];
  const pt = (gx: number, gy: number) => ({
    x: minX + (gx + 0.5) * cellMm,
    y: minY + (gy + 0.5) * cellMm,
  });
  const lerp = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    va: number,
    vb: number,
  ) => {
    const t = (levelMm - va) / (vb - va || 1e-9);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
  for (let y = 0; y < gh - 1; y++) {
    for (let x = 0; x < gw - 1; x++) {
      const tl = v(x, y);
      const tr = v(x + 1, y);
      const br = v(x + 1, y + 1);
      const bl = v(x, y + 1);
      const code =
        (tl > levelMm ? 8 : 0) | (tr > levelMm ? 4 : 0) | (br > levelMm ? 2 : 0) | (bl > levelMm ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const Ptl = pt(x, y);
      const Ptr = pt(x + 1, y);
      const Pbr = pt(x + 1, y + 1);
      const Pbl = pt(x, y + 1);
      const top = lerp(Ptl, Ptr, tl, tr);
      const right = lerp(Ptr, Pbr, tr, br);
      const bottom = lerp(Pbl, Pbr, bl, br);
      const left = lerp(Ptl, Pbl, tl, bl);
      const add = (a: { x: number; y: number }, b: { x: number; y: number }) => segs.push([a, b]);
      switch (code) {
        case 1: add(left, bottom); break;
        case 2: add(bottom, right); break;
        case 3: add(left, right); break;
        case 4: add(top, right); break;
        case 5: add(left, top); add(bottom, right); break;
        case 6: add(top, bottom); break;
        case 7: add(left, top); break;
        case 8: add(top, left); break;
        case 9: add(top, bottom); break;
        case 10: add(top, right); add(bottom, left); break;
        case 11: add(top, right); break;
        case 12: add(right, left); break;
        case 13: add(right, bottom); break;
        case 14: add(bottom, left); break;
      }
    }
  }
  // Chain into closed loops; drop unclosed slivers and tiny rings.
  const merged = mergePolylines(segs, cellMm * 0.05);
  return merged.filter((p) => {
    if (p.length < 8) return false;
    const gap = Math.hypot(p[0].x - p[p.length - 1].x, p[0].y - p[p.length - 1].y);
    return gap < cellMm * 2;
  });
}

// ─── Fermat construction ─────────────────────────────────────────────────

type Contour = {
  pts: PathMm; // closed CCW, last≈first removed
  level: number;
  parent: number; // contour index at level-1, or -1
  children: number[];
};

const pathLength = (p: PathMm): number => {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
  return L;
};

function centroid(p: PathMm): { x: number; y: number } {
  let sx = 0;
  let sy = 0;
  for (const q of p) {
    sx += q.x;
    sy += q.y;
  }
  return { x: sx / p.length, y: sy / p.length };
}

function makeCCW(p: PathMm): PathMm {
  let area = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    area += (p[j].x - p[i].x) * (p[j].y + p[i].y);
  }
  return area > 0 ? p : p.slice().reverse();
}

/** Traverse a closed contour from index ia around to index ib (skipping the gap ib→ia). */
function arcFrom(pts: PathMm, ia: number, ib: number, reverse: boolean): PathMm {
  const n = pts.length;
  const out: PathMm = [];
  if (!reverse) {
    for (let k = ib; ; k = (k + 1) % n) {
      out.push(pts[k]);
      if (k === ia) break;
    }
  } else {
    for (let k = ia; ; k = (k - 1 + n) % n) {
      out.push(pts[k]);
      if (k === ib) break;
    }
  }
  return out;
}

export type FermatResult = { pieces: PathMm[]; levels: number; chains: number };

export function fermatFill(
  rings: Ring[],
  opts: { spacingMm?: number } = {},
): FermatResult {
  const spacing = Math.max(0.5, opts.spacingMm ?? 0.8);
  const cell = Math.min(0.6, spacing / 2.5);
  const field = distanceField(rings, cell);

  // Iso-contours at every level.
  const contours: Contour[] = [];
  let maxD = 0;
  for (const v of field.d) if (v > maxD) maxD = v;
  const levels = Math.max(1, Math.floor((maxD - spacing * 0.5) / spacing) + 1);
  const perLevel: number[][] = [];
  for (let k = 0; k < levels; k++) {
    const L = spacing * 0.5 + k * spacing;
    const found = fieldContours(field, L).filter((p) => pathLength(p) > spacing * 4);
    const ids: number[] = [];
    for (const raw of found) {
      const pts = makeCCW(raw[raw.length - 1] === raw[0] ? raw.slice(0, -1) : raw);
      contours.push({ pts, level: k, parent: -1, children: [] });
      ids.push(contours.length - 1);
    }
    perLevel.push(ids);
  }
  if (contours.length === 0) return { pieces: [], levels: 0, chains: 0 };

  // Spirallable chains via ADJACENCY (the paper's formulation): two contours
  // chain when they run ~spacing apart, regardless of nesting direction. This
  // is what lets an annulus fill as ONE spiral - the outer contour family
  // runs inward, meets the inner family at the medial ridge, and comes back
  // out - where a containment forest would shatter it into per-level pieces.
  const nc = contours.length;
  const near = (A: Contour, B: Contour): boolean => {
    const step = (p: PathMm) => Math.max(1, Math.floor(p.length / 48));
    const sa = step(A.pts);
    const sb = step(B.pts);
    let best = Infinity;
    for (let i = 0; i < A.pts.length; i += sa) {
      for (let j = 0; j < B.pts.length; j += sb) {
        const d = Math.hypot(A.pts[i].x - B.pts[j].x, A.pts[i].y - B.pts[j].y);
        if (d < best) best = d;
        if (best < spacing * 1.6) return true;
      }
    }
    return best < spacing * 1.6;
  };
  const adj: number[][] = Array.from({ length: nc }, () => []);
  for (let i = 0; i < nc; i++) {
    for (let j = i + 1; j < nc; j++) {
      const dl = Math.abs(contours[i].level - contours[j].level);
      if (dl > 1) continue; // only same or consecutive depth can be a lap apart
      if (near(contours[i], contours[j])) {
        adj[i].push(j);
        adj[j].push(i);
      }
    }
  }

  // Hubs (≥3 neighbors) are branch points: they become 1-contour chains and
  // terminate their neighbors' chains. Non-hub nodes form simple paths.
  const isHub = adj.map((a) => a.length >= 3);
  const visited = new Uint8Array(nc);
  const chains: Contour[][] = [];
  for (let s = 0; s < nc; s++) {
    if (visited[s] || isHub[s]) continue;
    const nonHub = (i: number) => adj[i].filter((j) => !isHub[j] && !visited[j]);
    // Walk to one end of this path component.
    let start = s;
    {
      let prev = -1;
      let cur = s;
      let guard = 0;
      for (;;) {
        const next = adj[cur].filter((j) => !isHub[j] && j !== prev);
        if (next.length === 0 || guard++ > nc) break;
        prev = cur;
        cur = next[0];
        if (cur === s) break; // cycle - start anywhere
      }
      start = cur;
    }
    const chain: Contour[] = [];
    let prev = -1;
    let cur = start;
    for (;;) {
      visited[cur] = 1;
      chain.push(contours[cur]);
      const next = nonHub(cur).filter((j) => j !== prev);
      if (next.length === 0) break;
      prev = cur;
      cur = next[0];
    }
    // Orient outer-first so the Fermat endpoints exit at the shallow end
    // (the region boundary), not the middle.
    if (chain.length > 1 && chain[0].level > chain[chain.length - 1].level) chain.reverse();
    chains.push(chain);
  }
  for (let i = 0; i < nc; i++) {
    if (isHub[i] && !visited[i]) {
      visited[i] = 1;
      chains.push([contours[i]]);
    }
  }

  const pieces = chains.map((chain) => fermatChain(chain, spacing));
  return { pieces: pieces.filter((p) => p.length > 4), levels, chains: chains.length };
}

/** The aligned-cut Fermat spiral over one spirallable chain (outer→inner). */
function fermatChain(chain: Contour[], spacing: number): PathMm {
  const n = chain.length;
  if (n === 0) return [];
  if (n === 1) {
    const p = chain[0].pts;
    return [...p, p[0]];
  }
  // Aligned cut corridor: the innermost contour cuts anywhere; each outer
  // contour cuts at the vertex nearest its inner neighbor's cut - a radial
  // corridor for ANY shape (nearest-to-centroid fails on circles, where every
  // vertex ties).
  const cuts: { a: number; b: number }[] = new Array(n);
  const cutAt = (pts: PathMm, target: { x: number; y: number }): number => {
    let a = 0;
    let bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(pts[i].x - target.x, pts[i].y - target.y);
      if (d < bd) {
        bd = d;
        a = i;
      }
    }
    return a;
  };
  const gapEnd = (pts: PathMm, a: number): number => {
    let b = a;
    let walked = 0;
    while (walked < spacing * 1.6) {
      const next = (b + 1) % pts.length;
      walked += Math.hypot(pts[next].x - pts[b].x, pts[next].y - pts[b].y);
      b = next;
      if (b === a) break;
    }
    return b;
  };
  {
    const innerA = cutAt(chain[n - 1].pts, centroid(chain[n - 1].pts));
    cuts[n - 1] = { a: innerA, b: gapEnd(chain[n - 1].pts, innerA) };
    for (let i = n - 2; i >= 0; i--) {
      const target = chain[i + 1].pts[cuts[i + 1].a];
      const a = cutAt(chain[i].pts, target);
      cuts[i] = { a, b: gapEnd(chain[i].pts, a) };
    }
  }

  const out: PathMm = [];
  // Inward arm: even contours, full loop minus gap (b → … → a).
  const evens: number[] = [];
  const odds: number[] = [];
  for (let i = 0; i < n; i++) (i % 2 === 0 ? evens : odds).push(i);
  for (const i of evens) {
    out.push(...arcFrom(chain[i].pts, cuts[i].a, cuts[i].b, false));
  }
  // Outward arm: odd contours from deepest back out, reversed traversal.
  for (let k = odds.length - 1; k >= 0; k--) {
    const i = odds[k];
    out.push(...arcFrom(chain[i].pts, cuts[i].a, cuts[i].b, true));
  }
  return out;
}

// ─── Component ───────────────────────────────────────────────────────────

const NAME = "bayside-fermat";

export default function FermatTool() {
  const [sizeMm, setSizeMm] = useState(80);
  const [spacing, setSpacing] = useState(0.8);
  const [stitchLen, setStitchLen] = useState(2.6);
  const [underlayOn, setUnderlayOn] = useState(false);
  const [threadHex, setThreadHex] = useState(
    THREADS.find((t) => t.family === "Red" && t.hex && !t.isMetallic)?.hex ??
      THREADS.find((t) => t.hex)?.hex ??
      "#8a2020",
  );

  const dSize = useDebounced(sizeMm);
  const dSpacing = useDebounced(spacing);
  const { rings, element: shapeElement } = useShapeSource(dSize, "heart");

  const built = useMemo(() => {
    const paths: PathMm[] = [];
    if (rings.length === 0) return { built: null, info: null };
    if (underlayOn) {
      const under = fermatFill(rings, { spacingMm: Math.max(2.5, dSpacing * 4) });
      for (const p of under.pieces) paths.push(resamplePath(p, 3.5, 0.5));
    }
    const fill = fermatFill(rings, { spacingMm: dSpacing });
    if (fill.pieces.length === 0) return { built: null, info: null };
    for (const p of fill.pieces) paths.push(resamplePath(p, stitchLen, 0.4));
    return {
      built: buildDesign(pathsToStitches(paths, 1), NAME),
      info: { chains: fill.chains, levels: fill.levels },
    };
  }, [rings, dSpacing, stitchLen, underlayOn]);

  const stitchCount = built.built?.stats.realStitches ?? 0;

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="Region">
            {shapeElement}
            <SizeField valueMm={sizeMm} min={40} max={330} onChange={setSizeMm} />
          </SectionBox>

          <SectionBox eyebrow="Spiral">
            <RangeRow label="Spacing" value={spacing} min={0.6} max={2.5} step={0.1} onChange={setSpacing} fmt={(v) => `${v.toFixed(1)} mm`} />
            <RangeRow label="Stitch length" value={stitchLen} min={1.5} max={5} step={0.1} onChange={setStitchLen} fmt={(v) => `${v.toFixed(1)} mm`} />
            <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer">
              <input
                type="checkbox"
                checked={underlayOn}
                onChange={(ev) => setUnderlayOn(ev.target.checked)}
                className="accent-accent"
              />
              Spiral underlay (same construction, 4× spacing)
            </label>
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Tight spacing (≤0.8&nbsp;mm) reads as a solid fill with a swirl grain no
              straight row fill can make; wide spacing reads as an engraved spiral texture. Both
              ends of every spiral exit at the region's edge - that's the Fermat trick.
            </p>
          </SectionBox>

          <SectionBox eyebrow="Thread">
            <ThreadRow hex={threadHex} onChange={(hex) => setThreadHex(hex)} />
          </SectionBox>
        </>
      }
      preview={
        <PreviewRail
          built={built.built}
          colors={[threadHex]}
          name={NAME}
          emptyHint="Pick a shape or drop an SVG."
          showDensity={false}
        >
          {built.info && built.built && (
            <p className="text-[0.75rem] text-mid tabular-nums">
              {built.info.levels} rings deep ·{" "}
              {built.info.chains === 1
                ? "fully spirallable - ONE continuous line"
                : `${built.info.chains} spiral lobes (one hop between lobes)`}
            </p>
          )}
          {stitchCount > 60000 && (
            <Warning>Over 60k stitches - widen the spacing or shrink the region.</Warning>
          )}
        </PreviewRail>
      }
    />
  );
}
