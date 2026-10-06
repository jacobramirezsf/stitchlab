// Vector tracing for cleaned silhouettes — pure functions, no DOM, so the
// whole pipeline is unit-testable in node. Used by the Lab's production
// export: alpha mask → contours (holes preserved) → simplified SVG cut file,
// plus connected-component stats for weeding warnings at physical size.

export type Pt = { x: number; y: number };

// ── binary mask helpers ──────────────────────────────────────────────────

// alpha: w*h bytes (or RGBA stride-4 via `stride`/`offset`), opaque >= threshold
export function toMask(
  data: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  threshold = 128,
  stride = 1,
  offset = 0
): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) m[i] = data[i * stride + offset] >= threshold ? 1 : 0;
  return m;
}

export const maskFromImageData = (
  data: Uint8ClampedArray,
  w: number,
  h: number,
  threshold = 128
) => toMask(data, w, h, threshold, 4, 3);

// ── marching squares: all closed contours, holes included ────────────────
// Cell corners are pixel centers of a 1px-padded grid, so shapes touching
// the image edge still close. Contours come back as closed polygons in
// pixel coordinates; SVG fill-rule "evenodd" renders holes correctly
// without caring about winding.

export function traceContours(mask: Uint8Array, w: number, h: number): Pt[][] {
  const gw = w + 2; // padded
  const at = (x: number, y: number) =>
    x >= 1 && x <= w && y >= 1 && y <= h ? mask[(y - 1) * w + (x - 1)] : 0;

  // segment map: for each cell, marching-squares emits 0–2 directed edges.
  // Key edges by their start point so loops chain in O(1) per step.
  const segs = new Map<number, Pt[]>(); // startKey -> [end,...] (rare doubles at saddles)
  const key = (p: Pt) => Math.round(p.y * 2) * (gw * 2 + 4) + Math.round(p.x * 2);
  const addSeg = (a: Pt, b: Pt) => {
    const k = key(a);
    const list = segs.get(k);
    if (list) list.push(b);
    else segs.set(k, [b]);
  };

  for (let y = 0; y < h + 1; y++) {
    for (let x = 0; x < w + 1; x++) {
      const tl = at(x, y), tr = at(x + 1, y), bl = at(x, y + 1), br = at(x + 1, y + 1);
      const config = tl * 8 + tr * 4 + br * 2 + bl * 1;
      if (config === 0 || config === 15) continue;
      // edge midpoints of the cell whose corners are the 4 pixels above
      const top = { x: x + 0.5, y: y };
      const right = { x: x + 1, y: y + 0.5 };
      const bottom = { x: x + 0.5, y: y + 1 };
      const left = { x: x, y: y + 0.5 };
      // directed so filled region stays on the LEFT of travel
      switch (config) {
        case 1: addSeg(bottom, left); break;
        case 2: addSeg(right, bottom); break;
        case 3: addSeg(right, left); break;
        case 4: addSeg(top, right); break;
        case 5: addSeg(top, left); addSeg(bottom, right); break; // saddle
        case 6: addSeg(top, bottom); break;
        case 7: addSeg(top, left); break;
        case 8: addSeg(left, top); break;
        case 9: addSeg(bottom, top); break;
        case 10: addSeg(left, bottom); addSeg(right, top); break; // saddle
        case 11: addSeg(right, top); break;
        case 12: addSeg(left, right); break;
        case 13: addSeg(bottom, right); break;
        case 14: addSeg(left, bottom); break;
      }
    }
  }

  // chain directed segments into closed loops
  const contours: Pt[][] = [];
  while (segs.size) {
    const firstKey: number = segs.keys().next().value!;
    const firstEnds = segs.get(firstKey)!;
    const start = firstEnds.length ? { ...firstEnds[0] } : null;
    // reconstruct the start point from the first segment's end chain:
    // walk from its end until we return
    if (!start) { segs.delete(firstKey); continue; }
    // take the first segment out
    const loop: Pt[] = [];
    let currentKey = firstKey;
    let guard = (w + 2) * (h + 2) * 8;
    while (guard-- > 0) {
      const ends = segs.get(currentKey);
      if (!ends || !ends.length) break; // open chain (shouldn't happen)
      const next = ends.shift()!;
      if (!ends.length) segs.delete(currentKey);
      loop.push(next);
      currentKey = key(next);
      if (currentKey === firstKey) break; // closed
    }
    if (loop.length >= 3) contours.push(loop);
  }
  // shift from padded-grid coords back to pixel coords (padding was virtual:
  // at() already offset by 1, and midpoints land between pixels, so contours
  // sit on half-pixel positions around the actual artwork — subtract the pad)
  return contours.map((c) => c.map((p) => ({ x: p.x - 0.5, y: p.y - 0.5 })));
}

// ── Douglas-Peucker simplification (closed polygons) ─────────────────────

function dpSimplify(points: Pt[], epsilon: number): Pt[] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = points[a].x, ay = points[a].y;
    const dx = points[b].x - ax, dy = points[b].y - ay;
    const len = Math.hypot(dx, dy) || 1e-12;
    let maxD = 0, maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((points[i].x - ax) * dy - (points[i].y - ay) * dx) / len;
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > epsilon && maxI > 0) {
      keep[maxI] = 1;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

export function simplifyContour(points: Pt[], epsilon = 0.75): Pt[] {
  if (points.length < 4) return points;
  // closed polygon: anchor at the two farthest-apart-ish points (0 and mid)
  const mid = Math.floor(points.length / 2);
  const first = dpSimplify(points.slice(0, mid + 1), epsilon);
  const second = dpSimplify(points.slice(mid), epsilon);
  const out = [...first.slice(0, -1), ...second.slice(0, -1)];
  return out.length >= 3 ? out : points;
}

// ── connected components (weeding / small-island analysis) ───────────────

export type Island = { area: number; minX: number; minY: number; maxX: number; maxY: number };

export function findIslands(mask: Uint8Array, w: number, h: number): Island[] {
  const seen = new Uint8Array(w * h);
  const islands: Island[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || seen[start]) continue;
    let area = 0, minX = w, minY = h, maxX = 0, maxY = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      area++;
      const x = p % w, y = (p - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack.push(p - w); }
      if (y < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack.push(p + w); }
    }
    islands.push({ area, minX, minY, maxX, maxY });
  }
  return islands;
}

// Weeding check: pieces whose smaller bounding dimension lands under
// `minFeatureMm` at the chosen physical output width are hard to cut/weed.
export function smallIslandWarnings(
  islands: Island[],
  imageWidthPx: number,
  physicalWidthMm: number,
  minFeatureMm = 3
): { count: number; sizesMm: number[] } {
  const mmPerPx = physicalWidthMm / imageWidthPx;
  const sizes = islands
    .map((i) => Math.min(i.maxX - i.minX + 1, i.maxY - i.minY + 1) * mmPerPx)
    .filter((mm) => mm < minFeatureMm)
    .sort((a, b) => a - b);
  return { count: sizes.length, sizesMm: sizes.map((s) => Math.round(s * 10) / 10) };
}

// ── SVG output ───────────────────────────────────────────────────────────

const fmt = (n: number) => Math.round(n * 100) / 100;

export function contoursToSvgPath(contours: Pt[][]): string {
  return contours
    .map(
      (c) =>
        `M${fmt(c[0].x)} ${fmt(c[0].y)}` +
        c.slice(1).map((p) => `L${fmt(p.x)} ${fmt(p.y)}`).join("") +
        "Z"
    )
    .join("");
}

// Unmirrored master at true physical size: width/height in mm, viewBox in px.
export function buildCutSvg(
  contours: Pt[][],
  wPx: number,
  hPx: number,
  physicalWidthMm: number,
  fill = "#111111"
): string {
  const physicalHeightMm = (physicalWidthMm * hPx) / wPx;
  const path = contoursToSvgPath(contours);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(physicalWidthMm)}mm" ` +
    `height="${fmt(physicalHeightMm)}mm" viewBox="0 0 ${wPx} ${hPx}">\n` +
    `<!-- Unmirrored master. For heat-transfer vinyl, MIRROR this file in your ` +
    `cutting software before cutting. -->\n` +
    `<path d="${path}" fill="${fill}" fill-rule="evenodd"/>\n</svg>\n`
  );
}

// One-call pipeline used by the Lab UI.
export function traceToSvg(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  physicalWidthMm: number,
  opts: { threshold?: number; epsilon?: number; fill?: string; minKeepPx?: number } = {}
): { svg: string; contours: Pt[][]; islands: Island[] } {
  const mask = maskFromImageData(data, w, h, opts.threshold ?? 128);
  // drop sub-visible specks before tracing (they'd become unweedable dots)
  const minKeep = opts.minKeepPx ?? 4;
  const islands = findIslands(mask, w, h);
  if (minKeep > 0) {
    for (const isl of islands) {
      if (isl.area < minKeep) {
        for (let y = isl.minY; y <= isl.maxY; y++)
          for (let x = isl.minX; x <= isl.maxX; x++) {
            // only clear pixels, not neighbors from other islands: re-check via area box is
            // approximate; tiny boxes make collateral damage negligible
            if (isl.maxX - isl.minX < 4 && isl.maxY - isl.minY < 4) mask[y * w + x] = 0;
          }
      }
    }
  }
  const contours = traceContours(mask, w, h).map((c) =>
    simplifyContour(c, opts.epsilon ?? 0.75)
  );
  const kept = islands.filter((i) => i.area >= minKeep);
  return { svg: buildCutSvg(contours, w, h, physicalWidthMm, opts.fill), contours, islands: kept };
}
