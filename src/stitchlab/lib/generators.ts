// Stitch-path generators for the Create bench. Everything works in mm point
// paths, gets resampled to an even stitch length (the running-stitch
// fundamental - same resample-to-length idea as stitchjs's Run and
// stitchcode's flatten), optionally beaned (each segment sewn
// forward-back-forward like a bean stitch for a bolder line), then converted
// to machine units for the DST writer.

import { CMD, type Stitch } from "./pattern";

export type PathMm = { x: number; y: number }[];

/** Resample a polyline to (near-)even stitch lengths, keeping corners. */
export function resamplePath(points: PathMm, stitchLenMm: number, minLenMm = 0.4): PathMm {
  if (points.length < 2) return points.slice();
  const out: PathMm = [points[0]];
  let since = 0; // distance walked since the last emitted stitch point
  for (let i = 1; i < points.length; i++) {
    let ax = points[i - 1].x;
    let ay = points[i - 1].y;
    const b = points[i];
    let seg = Math.hypot(b.x - ax, b.y - ay);
    if (seg === 0) continue;
    while (since + seg >= stitchLenMm) {
      const need = stitchLenMm - since;
      const t = need / seg;
      const p = { x: ax + (b.x - ax) * t, y: ay + (b.y - ay) * t };
      out.push(p);
      ax = p.x;
      ay = p.y;
      seg -= need;
      since = 0;
    }
    since += seg;
  }
  const last = points[points.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.y - tail.y) >= minLenMm) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

/**
 * Curvature-adaptive resampling via the chord-height (sagitta) formula:
 * a chord of length L on radius r deviates by ε = r − √(r² − L²/4), so the
 * longest stitch keeping deviation under ε is L = 2√(2rε − ε²). Straights get
 * long stitches, curves get short ones. Local radius is estimated per input
 * vertex by Menger curvature (circumradius of three consecutive points), so
 * this works on any dense polyline - no analytic derivatives needed.
 */
export function resampleAdaptive(
  points: PathMm,
  opts: { chordErrorMm?: number; minLenMm?: number; maxLenMm?: number } = {},
): PathMm {
  const eps = opts.chordErrorMm ?? 0.15;
  const minLen = opts.minLenMm ?? 1.0;
  const maxLen = opts.maxLenMm ?? 4.0;
  if (points.length < 3) return resamplePath(points, maxLen, minLen * 0.5);

  // Per-vertex stitch-length target from Menger curvature.
  const target = new Float64Array(points.length).fill(maxLen);
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    const ab = Math.hypot(b.x - a.x, b.y - a.y);
    const bc = Math.hypot(c.x - b.x, c.y - b.y);
    const ca = Math.hypot(a.x - c.x, a.y - c.y);
    const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    if (area2 < 1e-9 || ab < 1e-9 || bc < 1e-9) continue; // straight → maxLen
    const r = (ab * bc * ca) / (2 * area2); // circumradius
    const L = 2 * Math.sqrt(Math.max(0, 2 * r * eps - eps * eps));
    target[i] = Math.max(minLen, Math.min(maxLen, L));
  }
  target[0] = target[1];
  target[points.length - 1] = target[points.length - 2];

  // Arc-length walk with a position-dependent step.
  const out: PathMm = [points[0]];
  let since = 0;
  let want = target[0];
  for (let i = 1; i < points.length; i++) {
    let ax = points[i - 1].x;
    let ay = points[i - 1].y;
    const b = points[i];
    let seg = Math.hypot(b.x - ax, b.y - ay);
    if (seg === 0) continue;
    // Entering tighter curvature mid-step: shrink the pending step so a long
    // straight-section stitch can't cut the upcoming corner. If we've already
    // walked past the tighter target, emit here and restart the step.
    if (target[i] < want) {
      if (since >= target[i]) {
        out.push({ x: ax, y: ay });
        since = 0;
      }
      want = target[i];
    }
    while (since + seg >= want) {
      const need = want - since;
      const t = need / seg;
      const p = { x: ax + (b.x - ax) * t, y: ay + (b.y - ay) * t };
      out.push(p);
      ax = p.x;
      ay = p.y;
      seg -= need;
      since = 0;
      want = target[i]; // re-read local target at the emission point
    }
    since += seg;
  }
  const last = points[points.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.y - tail.y) >= minLen * 0.4) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

/** Bean stitch: sew each segment forward, back, forward. */
export function beanify(points: PathMm, passes: 1 | 3 | 5 = 3): PathMm {
  if (passes === 1 || points.length < 2) return points;
  const out: PathMm = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    for (let p = 0; p < passes; p++) out.push(p % 2 === 0 ? b : a);
  }
  return out;
}

/**
 * Multicolor: convert groups of mm paths to stitches with a COLOR_CHANGE
 * between groups (group order = thread order in the assignment UI).
 */
export function pathGroupsToStitches(groups: PathMm[][], beanPasses: 1 | 3 | 5 = 1): Stitch[] {
  const out: Stitch[] = [];
  for (const paths of groups) {
    const chunk = pathsToStitches(paths, beanPasses);
    if (chunk.length === 0) continue;
    const body = chunk[chunk.length - 1].cmd === CMD.END ? chunk.slice(0, -1) : chunk;
    if (body.length === 0) continue;
    if (out.length > 0) {
      const prev = out[out.length - 1];
      out.push({ x: prev.x, y: prev.y, cmd: CMD.COLOR_CHANGE });
    }
    out.push(...body);
  }
  if (out.length > 0) out.push({ ...out[out.length - 1], cmd: CMD.END });
  return out;
}

/** Convert mm paths to machine stitches (0.1 mm ints), jumping between paths. */
export function pathsToStitches(paths: PathMm[], beanPasses: 1 | 3 | 5 = 1): Stitch[] {
  const stitches: Stitch[] = [];
  for (const path of paths) {
    if (path.length < 2) continue;
    const pts = beanify(path, beanPasses);
    pts.forEach((p, i) => {
      stitches.push({
        x: Math.round(p.x * 10),
        y: Math.round(p.y * 10),
        cmd: i === 0 ? CMD.JUMP : CMD.STITCH,
      });
    });
  }
  if (stitches.length > 0) {
    stitches.push({ ...stitches[stitches.length - 1], cmd: CMD.END });
  }
  return stitches;
}

/** Center paths on the origin and scale the long side to sizeMm. */
export function fitPaths(paths: PathMm[], sizeMm: number): PathMm[] {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of paths)
    for (const pt of p) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
  const w = maxX - minX;
  const h = maxY - minY;
  if (!(w > 0 || h > 0)) return paths;
  const s = sizeMm / Math.max(w, h);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return paths.map((p) => p.map((pt) => ({ x: (pt.x - cx) * s, y: (pt.y - cy) * s })));
}

// ─── Spirograph ──────────────────────────────────────────────────────────

export type SpiroParams = {
  kind: "hypo" | "epi";
  R: number; // fixed ring radius
  r: number; // rolling circle radius
  d: number; // pen offset as a fraction of r (0..1.5)
  sizeMm: number;
  stitchLenMm: number;
};

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** Closed hypotrochoid/epitrochoid, auto-run to closure (capped). */
export function spirograph(p: SpiroParams): PathMm[] {
  const R = Math.max(1, Math.round(p.R));
  const r = Math.max(1, Math.round(p.r));
  const d = r * p.d;
  const revs = Math.min(120, r / gcd(R, r));
  const total = revs * Math.PI * 2;
  const steps = Math.max(600, Math.min(24000, Math.round(revs * 260)));
  const pts: PathMm = [];
  for (let i = 0; i <= steps; i++) {
    const t = (total * i) / steps;
    let x: number;
    let y: number;
    if (p.kind === "hypo") {
      const k = R - r;
      x = k * Math.cos(t) + d * Math.cos((k / r) * t);
      y = k * Math.sin(t) - d * Math.sin((k / r) * t);
    } else {
      const k = R + r;
      x = k * Math.cos(t) - d * Math.cos((k / r) * t);
      y = k * Math.sin(t) - d * Math.sin((k / r) * t);
    }
    pts.push({ x, y });
  }
  const fitted = fitPaths([pts], p.sizeMm);
  return [resamplePath(fitted[0], p.stitchLenMm)];
}

// ─── SVG sampling ────────────────────────────────────────────────────────

/**
 * Sample every geometry element of an SVG into mm paths using the browser's
 * own path engine (getPointAtLength), honoring element transforms. Output is
 * fit to widthMm. Fills are NOT generated - this is running-stitch outline
 * art, the honest v1.
 */
export function svgToPaths(svgText: string, widthMm: number, sampleStepMm = 0.6): PathMm[] {
  // Parse the (untrusted) SVG in an inert document first (DOMParser runs no
  // scripts and loads no resources), then strip anything that could execute or
  // fetch once it's in the live DOM — <script>, resource-loading elements, and
  // every on* handler / external href. This function only needs geometry, so
  // removing those can't affect the output.
  const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
  if (parsed.querySelector("parsererror")) throw new Error("Could not parse the SVG.");
  const parsedSvg = parsed.querySelector("svg");
  if (!parsedSvg) throw new Error("No <svg> element found.");
  parsedSvg
    .querySelectorAll("script, image, foreignObject, use, a, iframe")
    .forEach((el) => el.remove());
  parsedSvg.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      if (n.startsWith("on") || n === "href" || n === "xlink:href") el.removeAttribute(attr.name);
    }
  });
  const host = document.createElement("div");
  host.style.position = "absolute";
  host.style.visibility = "hidden";
  host.style.width = "0";
  host.style.height = "0";
  host.style.overflow = "hidden";
  document.body.appendChild(host);
  try {
    host.appendChild(document.importNode(parsedSvg, true));
    const svg = host.querySelector("svg");
    if (!svg) throw new Error("No <svg> element found.");
    const geoms = svg.querySelectorAll<SVGGeometryElement>(
      "path, line, polyline, polygon, circle, ellipse, rect",
    );
    if (geoms.length === 0) throw new Error("SVG has no drawable geometry elements.");

    const raw: PathMm[] = [];
    let unitMax = 1;
    for (const el of Array.from(geoms)) {
      let total: number;
      try {
        total = el.getTotalLength();
      } catch {
        continue;
      }
      if (!isFinite(total) || total <= 0) continue;
      unitMax = Math.max(unitMax, total);
    }
    // First pass told us rough scale; sample densely relative to it so the
    // mm re-fit keeps detail. ~4 samples per eventual stitch.
    for (const el of Array.from(geoms)) {
      let total: number;
      try {
        total = el.getTotalLength();
      } catch {
        continue;
      }
      if (!isFinite(total) || total <= 0) continue;
      const ctm = el.getCTM();
      const steps = Math.max(8, Math.min(4000, Math.ceil(total / (unitMax / 800))));
      const path: PathMm = [];
      for (let i = 0; i <= steps; i++) {
        const pt = el.getPointAtLength((total * i) / steps);
        let x = pt.x;
        let y = pt.y;
        if (ctm) {
          const tp = new DOMPoint(x, y).matrixTransform(ctm);
          x = tp.x;
          y = tp.y;
        }
        path.push({ x, y });
      }
      raw.push(path);
    }
    if (raw.length === 0) throw new Error("Could not sample any geometry from the SVG.");
    const fitted = fitPaths(raw, widthMm);
    return fitted.map((p) => resamplePath(p, sampleStepMm));
  } finally {
    host.remove();
  }
}

/**
 * Route strokes for sewing: merge strokes whose endpoints touch (within
 * `mergeTolMm`, with reversal), then order them greedily from nearest endpoint
 * (reversing where that helps) and refine the order with a time-budgeted
 * windowed Or-opt. Geometry is unchanged - only connectivity and sew order -
 * so line work looks identical but sews with far fewer jumps and trims.
 * Measured on block patterns + lettering: 32-97% less inter-stroke travel,
 * up to 93% fewer trim-length gaps (scripts/research-exp3.ts).
 */
export function routeStrokes(
  paths: PathMm[],
  opts?: { mergeTolMm?: number; orOptMs?: number },
): PathMm[] {
  const tol = opts?.mergeTolMm ?? 0.5;
  const orOptMs = opts?.orOptMs ?? 250;
  const D = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);

  // 1) linemerge with reversal
  const strokes = paths.filter((p) => p.length > 1).map((p) => p.slice());
  if (strokes.length <= 1) return strokes;
  const used = new Array(strokes.length).fill(false);
  const merged: PathMm[] = [];
  for (let i = 0; i < strokes.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let cur = strokes[i];
    let extended = true;
    while (extended) {
      extended = false;
      const tail = cur[cur.length - 1];
      const head = cur[0];
      for (let j = 0; j < strokes.length; j++) {
        if (used[j]) continue;
        const s = strokes[j];
        const s0 = s[0];
        const s1 = s[s.length - 1];
        if (D(tail, s0) <= tol) { cur = cur.concat(s.slice(1)); used[j] = true; extended = true; break; }
        if (D(tail, s1) <= tol) { cur = cur.concat(s.slice().reverse().slice(1)); used[j] = true; extended = true; break; }
        if (D(head, s1) <= tol) { cur = s.slice(0, -1).concat(cur); used[j] = true; extended = true; break; }
        if (D(head, s0) <= tol) { cur = s.slice().reverse().slice(0, -1).concat(cur); used[j] = true; extended = true; break; }
      }
    }
    merged.push(cur);
  }
  if (merged.length <= 2) return merged;

  // 2) greedy nearest-endpoint order with reversal
  const rem = merged.map((_, i) => i);
  const out: PathMm[] = [merged[0]];
  rem.splice(0, 1);
  while (rem.length) {
    const tail = out[out.length - 1][out[out.length - 1].length - 1];
    let bi = 0;
    let brev = false;
    let bd = Infinity;
    for (let k = 0; k < rem.length; k++) {
      const p = merged[rem[k]];
      const d0 = D(tail, p[0]);
      const d1 = D(tail, p[p.length - 1]);
      if (d0 < bd) { bd = d0; bi = k; brev = false; }
      if (d1 < bd) { bd = d1; bi = k; brev = true; }
    }
    out.push(brev ? merged[rem[bi]].slice().reverse() : merged[rem[bi]]);
    rem.splice(bi, 1);
  }

  // 3) windowed Or-opt on the order (relocate runs of 1-2 strokes)
  const t0 = Date.now();
  const gap = (i: number, j: number) => D(out[i][out[i].length - 1], out[j][0]);
  let improved = true;
  while (improved && Date.now() - t0 < orOptMs) {
    improved = false;
    for (let seg = 1; seg <= 2; seg++) {
      for (let i = 1; i + seg < out.length - 1; i++) {
        const before = gap(i - 1, i) + gap(i + seg - 1, i + seg);
        for (let j = Math.max(0, i - 25); j < Math.min(out.length - 1, i + 25); j++) {
          if (j >= i - 1 && j <= i + seg) continue;
          const gainRemove = before - gap(i - 1, i + seg);
          const addCost = gap(j, i) + gap(i + seg - 1, j + 1) - gap(j, j + 1);
          if (gainRemove - addCost > 1e-9) {
            const s = out.splice(i, seg);
            out.splice(j < i ? j + 1 : j + 1 - seg, 0, ...s);
            improved = true;
            break;
          }
        }
      }
    }
  }
  return out;
}
