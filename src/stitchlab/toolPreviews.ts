// Small line-art previews for the public tool gallery, so most cards show what
// the tool makes rather than just words. Generative/geometric tools reuse the
// block engine (the same generators the tools run on); photo, text, fill, and
// editor tools get a compact hand-drawn "signature" of their output. Everything
// is drawn in a 0..100 space and rendered on a tiny canvas.

import { runBlocks, BLOCK_BY_TYPE } from "./tools/sketch";

export type Pt = { x: number; y: number };
export type Preview = Pt[][];
const TAU = Math.PI * 2;
const P = (x: number, y: number): Pt => ({ x, y });

function ring(cx: number, cy: number, r: number, n = 64): Pt[] {
  const o: Pt[] = [];
  for (let i = 0; i <= n; i++) { const a = (i / n) * TAU; o.push(P(cx + Math.cos(a) * r, cy + Math.sin(a) * r)); }
  return o;
}
function param(fn: (t: number) => Pt, t0: number, t1: number, dt: number): Pt[] {
  const o: Pt[] = [];
  for (let t = t0; t <= t1 + 1e-9; t += dt) o.push(fn(t));
  return o;
}
function star(cx: number, cy: number, r: number, points = 5): Pt[] {
  const o: Pt[] = [];
  for (let i = 0; i <= points * 2; i++) { const a = -Math.PI / 2 + (i * Math.PI) / points; const rr = i % 2 ? r * 0.42 : r; o.push(P(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr)); }
  return o;
}
const rect = (x: number, y: number, w: number, h: number): Pt[] => [P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h), P(x, y)];

// Generative/geometric tools → a block generator (same math the tool uses).
// `params` is merged over the generator's defaults, so entries only list what
// they want to override; `{}` means "render the defaults".
const BLOCK_PREVIEW: Record<string, { type: string; params: Record<string, number> }> = {
  // Standalone single-generator tools (blockmini) - defaults, tweaked sparingly.
  spiral: { type: "spiral", params: {} },
  spirograph: { type: "spirograph", params: {} },
  lissajous: { type: "lissajous", params: {} },
  superformula: { type: "superformula", params: {} },
  butterfly: { type: "butterfly", params: {} },
  heart: { type: "heart", params: {} },
  rosette: { type: "rosette", params: {} },
  timestable: { type: "timesTable", params: {} },
  fractaltree: { type: "tree", params: {} },
  web: { type: "polarGrid", params: {} },
  ripples: { type: "ripples", params: {} },
  topo: { type: "contours", params: {} },
  circlepack: { type: "circlePack", params: {} },
  rings: { type: "concentricRings", params: {} },
  polygons: { type: "concentricPolygons", params: {} },
  squares: { type: "concentricSquares", params: {} },
  polygonring: { type: "polygonRing", params: {} },
  crosshatch: { type: "grid", params: {} },
  plaid: { type: "plaid", params: {} },
  moire: { type: "moire", params: {} },
  honeycomb: { type: "honeycomb", params: {} },
  waves: { type: "waveRows", params: {} },
  dotgrid: { type: "circleGrid", params: {} },
  phyllotaxis: { type: "phyllotaxis", params: { count: 120, spread: 3.6, dot: 1.5 } },
  harmonograph: { type: "harmonograph", params: { freqX: 3, freqY: 2, phase: 90, damping: 0.006 } },
  attractor: { type: "harmonograph", params: { freqX: 5, freqY: 4, phase: 60, damping: 0.001 } },
  rose: { type: "maurerRose", params: { petals: 6, degree: 71 } },
  star: { type: "starPolygon", params: { points: 8, skip: 3, radius: 44 } },
  maze: { type: "truchet", params: { cells: 8, variation: 3 } },
  truchet: { type: "truchet", params: { cells: 9, variation: 6 } },
  flowfield: { type: "flowField", params: { lines: 90, steps: 46, scale: 4, variation: 7 } },
  meander: { type: "hilbert", params: { order: 4 } },
  fractal: { type: "hilbert", params: { order: 5 } },
  reaction: { type: "contours", params: { detail: 24, levels: 8, scale: 3, variation: 5 } },
  fermat: { type: "spiral", params: { turns: 13, radius: 44 } },
  quilting: { type: "flowField", params: { lines: 34, steps: 64, scale: 3, variation: 12 } },
  blackwork: { type: "honeycomb", params: { size: 9 } },
  sashiko: { type: "grid", params: { cols: 13, rows: 13 } },
  stringart: { type: "starburst", params: { points: 56, skip: 27, radius: 46 } },
  sketch: { type: "lissajous", params: { a: 3, b: 4, radius: 44 } },
  blocks2: { type: "rose", params: { petals: 5, radius: 42 } },
  blocks: { type: "spiral", params: { turns: 10, radius: 42 } },
  growth: { type: "superformula", params: { m: 8, n1: 0.6, n2: 0.35, n3: 0.35 } },
};

function custom(slug: string): Preview {
  switch (slug) {
    case "sashikotone": {
      const out: Preview = [];
      for (let y = 12; y < 90; y += 6) for (let x = 12; x < 90; x += 6) {
        if (Math.hypot(x - 50, y - 50) > 37 || (x + y) % 12 !== 0) continue;
        out.push([P(x - 2, y), P(x + 2, y)], [P(x, y - 2), P(x, y + 2)]);
      }
      return out;
    }
    case "halftone": {
      const out: Preview = [];
      for (let r = 0; r < 11; r++) {
        const y0 = 12 + r * 7.4;
        const seg: Pt[] = [];
        for (let x = 8; x <= 92; x += 2) {
          const d = Math.max(0, 1 - Math.hypot(x - 50, y0 - 48) / 46);
          seg.push(P(x, y0 + Math.sin(x * 0.5) * 3.2 * d));
        }
        out.push(seg);
      }
      return out;
    }
    case "portrait":
      return [param((t) => { const r = 30 + 6 * Math.sin(5 * t) + 3 * Math.sin(11 * t); return P(50 + Math.cos(t) * r, 47 + Math.sin(t) * (r + 5)); }, 0, TAU, 0.03)];
    case "crossstitch":
    case "crossstitch2":
    case "crossstitch3": {
      const out: Preview = []; const n = 9; const step = 78 / n;
      for (let gy = 0; gy < n; gy++) for (let gx = 0; gx < n; gx++) {
        const cx = 11 + gx * step + step / 2, cy = 11 + gy * step + step / 2;
        if (Math.hypot(cx - 50, cy - 50) > 37) continue;
        const h = step * 0.34;
        out.push([P(cx - h, cy - h), P(cx + h, cy + h)]);
        out.push([P(cx - h, cy + h), P(cx + h, cy - h)]);
      }
      return out;
    }
    case "threadpaint": {
      const out: Preview = [];
      for (let gy = 0; gy < 8; gy++) for (let gx = 0; gx < 8; gx++) {
        const cx = 14 + gx * 10, cy = 14 + gy * 10;
        const a = 0.6 + 0.5 * Math.sin(cx * 0.08) + 0.4 * Math.cos(cy * 0.09);
        out.push([P(cx - Math.cos(a) * 5, cy - Math.sin(a) * 5), P(cx + Math.cos(a) * 5, cy + Math.sin(a) * 5)]);
      }
      return out;
    }
    case "flowink": {
      // curved rows of dot-ticks that follow an arc - a hedcut signature
      const out: Preview = [];
      for (let r = 0; r < 7; r++) {
        const rad = 18 + r * 9;
        for (let a = 0.6; a < 2.5; a += 0.16 + r * 0.012) {
          const cx = 50 + Math.cos(a) * rad * 0.9, cy = 96 - Math.sin(a) * rad;
          out.push([P(cx - 1.1, cy), P(cx + 1.1, cy)]);
        }
      }
      return out;
    }
    case "animator": {
      // three film frames of a motif resolving - the animate signature
      const out: Preview = [];
      for (let f = 0; f < 3; f++) {
        const x0 = 8 + f * 30;
        out.push([P(x0, 30), P(x0 + 24, 30), P(x0 + 24, 70), P(x0, 70), P(x0, 30)]);
        const n = 3 + f * 3;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          out.push([P(x0 + 12, 50), P(x0 + 12 + Math.cos(a) * 9, 50 + Math.sin(a) * 14)]);
        }
      }
      return out;
    }
    case "handfont": {
      // a loose hand-drawn "a" beside grid cells
      const out: Preview = [];
      for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++)
        out.push([P(8 + c * 20, 30 + r * 20), P(28 + c * 20, 30 + r * 20), P(28 + c * 20, 50 + r * 20), P(8 + c * 20, 50 + r * 20), P(8 + c * 20, 30 + r * 20)]);
      out.push(param((t) => P(68 + Math.cos(t * 6.3) * 11 + (t > 0.8 ? (t - 0.8) * 60 : 0), 55 + Math.sin(t * 6.3) * 12 + (t > 0.8 ? (t - 0.8) * 55 : 0)), 0, 1, 0.04));
      return out;
    }
    case "letteranim": {
      // a script-like line writing on, with motion ticks trailing it
      const out: Preview = [];
      out.push(param((t) => P(10 + t * 62, 55 + Math.sin(t * 11) * 12 * Math.sin(t * 2.2)), 0, 1, 0.02));
      for (let i = 0; i < 4; i++) out.push([P(76 + i * 5, 50), P(79 + i * 5, 50)]);
      return out;
    }
    case "imagemaze": {
      // concentric maze corridors with gaps - a labyrinth signature
      const out: Preview = [];
      for (let r = 1; r <= 5; r++) {
        const rad = r * 9;
        for (let a = 0; a < Math.PI * 2; a += 0.22) {
          if ((Math.floor(a * 3 + r * 2) % 5) === 0) continue;
          out.push([
            P(50 + Math.cos(a) * rad, 50 + Math.sin(a) * rad),
            P(50 + Math.cos(a + 0.2) * rad, 50 + Math.sin(a + 0.2) * rad),
          ]);
        }
      }
      return out;
    }
    case "turing": {
      // wandering worm strokes
      const out: Preview = [];
      for (let r = 0; r < 9; r++) {
        out.push(param((t) => P(
          12 + t * 76 + Math.sin(t * 9 + r * 2.1) * 5,
          14 + r * 9 + Math.cos(t * 7 + r) * 4,
        ), 0, 1, 0.05));
      }
      return out;
    }
    case "directional": {
      const out: Preview = [];
      for (let r = 0; r < 12; r++) {
        const y0 = 14 + r * 6.5;
        out.push(param((x) => P(x, y0 + Math.sin(x * 0.06 + r) * (2 + r * 0.4)), 8, 92, 3));
      }
      return out;
    }
    case "redwork": // simple leaf / contour line-drawing
      return [
        param((t) => P(50 + 26 * Math.sin(t), 50 - 34 * Math.cos(t) * (0.5 + 0.5 * Math.abs(Math.sin(t)))), 0, TAU, 0.04),
        [P(50, 84), P(50, 20)],
      ];
    case "lettering": // a flowing script line + baseline
      return [
        param((t) => P(12 + (t / (TAU * 3)) * 76, 50 + 11 * Math.sin(t * 3) + 4 * Math.sin(t)), 0, TAU * 3, 0.03),
        [P(12, 66), P(88, 66)],
      ];
    case "monogram":
      return [ring(50, 50, 40), [P(34, 66), P(34, 34), P(50, 52), P(66, 34), P(66, 66)]];
    case "badge": {
      const out: Preview = [ring(50, 50, 43), ring(50, 50, 35), star(50, 50, 11)];
      for (let i = 0; i < 24; i++) { const a = (i / 24) * TAU; out.push([P(50 + Math.cos(a) * 37, 50 + Math.sin(a) * 37), P(50 + Math.cos(a) * 41, 50 + Math.sin(a) * 41)]); }
      return out;
    }
    case "tatami": {
      // a square filled with angled parallel rows
      const out: Preview = [rect(14, 14, 72, 72)];
      for (let d = -60; d < 76; d += 6) {
        const seg: Pt[] = [];
        for (let x = 16; x <= 84; x += 4) { const y = x + d; if (y >= 16 && y <= 84) seg.push(P(x, y)); }
        if (seg.length >= 2) out.push(seg);
      }
      return out;
    }
    case "satin": {
      const rail = (o: number) => param((t) => { const x = 14 + (t / TAU) * 72; return P(x, 50 + o + 14 * Math.sin(t)); }, 0, TAU, 0.06);
      const out: Preview = [rail(-7), rail(7)];
      for (let t = 0; t <= TAU; t += 0.22) { const x = 14 + (t / TAU) * 72; const y = 50 + 14 * Math.sin(t); out.push([P(x, y - 7), P(x, y + 7)]); }
      return out;
    }
    case "studio": {
      const shape = param((t) => P(50 + 30 * Math.cos(t), 50 + 24 * Math.sin(t) + 6 * Math.sin(2 * t)), 0, TAU, 0.1);
      const out: Preview = [shape];
      for (const p of shape.filter((_, i) => i % 3 === 0)) out.push(rect(p.x - 1.6, p.y - 1.6, 3.2, 3.2));
      return out;
    }
    case "animate": {
      // Three film frames, the motif resolving across them.
      const out: Preview = [];
      for (let f = 0; f < 3; f++) {
        const x0 = 8 + f * 30;
        out.push(rect(x0, 30, 26, 40));
        const n = 2 + f * 2;
        const cell = 18 / n;
        for (let gy = 0; gy < n; gy++) for (let gx = 0; gx < n; gx++) {
          const cx = x0 + 4 + gx * cell + cell / 2, cy = 41 + gy * cell + cell / 2, h = cell * 0.32;
          out.push([P(cx - h, cy - h), P(cx + h, cy + h)]);
          out.push([P(cx - h, cy + h), P(cx + h, cy - h)]);
        }
      }
      return out;
    }
    case "border": {
      // Double frame with a scallop band and corner dots.
      const out: Preview = [rect(12, 16, 76, 68), rect(22, 26, 56, 48)];
      const scal = (x0: number, y0: number, x1: number, y1: number): Pt[] => {
        const seg: Pt[] = []; const dx = x1 - x0, dy = y1 - y0; const L = Math.hypot(dx, dy);
        const nrm = { x: -dy / L, y: dx / L }; const n = Math.round(L / 11);
        for (let i = 0; i < n; i++) for (let t = 0; t <= 8; t++) {
          const u = (i + t / 8) / n; const h = Math.sin((t / 8) * Math.PI) * 3.4;
          seg.push(P(x0 + dx * u + nrm.x * h, y0 + dy * u + nrm.y * h));
        }
        return seg;
      };
      out.push(scal(22, 21, 78, 21), scal(78, 79, 22, 79));
      for (const [cx, cy] of [[17, 21], [83, 21], [83, 79], [17, 79]] as const) out.push(ring(cx, cy, 2.6, 14));
      return out;
    }
    case "workspace": {
      // The studio shell in miniature: rail, canvas with a rose + baseline text.
      const out: Preview = [rect(6, 10, 88, 80), [P(16, 10), P(16, 90)]];
      out.push(param((t) => { const r = 16 * Math.cos(5 * t); return P(56 + Math.cos(t) * r, 42 + Math.sin(t) * r); }, 0, TAU, 0.03));
      out.push(param((t) => P(38 + (t / (TAU * 2)) * 36, 72 + 4 * Math.sin(t * 2.4)), 0, TAU * 2, 0.05));
      return out;
    }
    case "composer":
      return [rect(8, 12, 84, 76), ring(35, 46, 15), star(66, 56, 13)];
    case "librarypage":
      return [rect(18, 22, 40, 40), rect(30, 34, 40, 40), rect(42, 46, 40, 40)];
    case "oneline":
      // one continuous meandering line - the TSP-art look
      return [param((t) => P(
        50 + (Math.cos(t) * (34 - t * 3.4)) + 4 * Math.sin(7 * t),
        50 + (Math.sin(t) * (34 - t * 3.4)) + 4 * Math.cos(5 * t),
      ), 0, TAU * 1.35, 0.02)];
    case "imagepack": {
      // packed dots of varying size (darkness-driven circle packing)
      const dots: [number, number, number][] = [
        [30, 32, 12], [55, 25, 8], [72, 40, 10], [38, 56, 9], [58, 52, 6],
        [26, 72, 6], [46, 74, 8], [68, 68, 7], [78, 22, 4], [70, 82, 4],
      ];
      return dots.map(([x, y, r]) => ring(x, y, r, 28));
    }
    case "hatchtone": {
      // layered cross-hatch: two angled families, denser lower-right
      const out: Preview = [];
      for (let i = 0; i < 7; i++) out.push([P(12 + i * 12, 88), P(12 + i * 12 + 22, 66 - i * 3)]);
      for (let i = 0; i < 7; i++) out.push([P(88 - i * 12, 88), P(88 - i * 12 - 22, 66 - i * 3)]);
      for (let i = 0; i < 5; i++) out.push([P(20, 20 + i * 8), P(80, 20 + i * 8)]);
      return out;
    }
    case "asciitext":
      // rows of "characters": short dashes of varying length
      return [
        [P(20, 26), P(44, 26)], [P(52, 26), P(60, 26)], [P(66, 26), P(80, 26)],
        [P(16, 40), P(30, 40)], [P(36, 40), P(64, 40)], [P(72, 40), P(84, 40)],
        [P(22, 54), P(50, 54)], [P(58, 54), P(78, 54)],
        [P(18, 68), P(38, 68)], [P(46, 68), P(56, 68)], [P(64, 68), P(82, 68)],
      ];
    case "garment3d":
      // a tee silhouette with a chest mark
      return [
        [P(38, 22), P(30, 26), P(16, 34), P(22, 46), P(30, 42), P(30, 80), P(70, 80), P(70, 42), P(78, 46), P(84, 34), P(70, 26), P(62, 22), P(56, 28), P(44, 28), P(38, 22)],
        ring(50, 48, 8),
      ];
    default:
      return [ring(50, 50, 36), ring(50, 50, 22), ring(50, 50, 8)];
  }
}

// photomotion: a dot-grid figure signature (a circle emerging from dots)
function photomotionPreview(): Preview {
  const out: Preview = [];
  for (let gy = 0; gy < 11; gy++) {
    for (let gx = 0; gx < 11; gx++) {
      const x = 8 + gx * 8.4, y = 8 + gy * 8.4;
      const d = Math.hypot(x - 50, y - 46);
      const r = Math.max(0, 3.4 - d / 14) + (d < 26 ? 0.8 : 0);
      if (r < 0.7) continue;
      out.push(ring(x, y, r, 10));
    }
  }
  return out;
}

const cache = new Map<string, Preview>();

// compact signatures for the photo-animation suite
const ANIM_PREVIEWS: Record<string, () => Preview> = {
  animdots: photomotionPreview,
  animstipple: () => {
    const out: Preview = [];
    let sx = 12, sy = 33;
    for (let i = 0; i < 130; i++) {
      sx = (sx * 97 + 31) % 89; sy = (sy * 71 + 17) % 83;
      const x = 12 + (sx / 89) * 76, y = 12 + (sy / 83) * 76;
      const d = Math.hypot(x - 50, y - 48);
      if (d < 34) out.push(ring(x, y, 1.1 + Math.max(0, 1.6 - d / 22), 6));
    }
    return out;
  },
  animblobs: () => [ring(40, 44, 17), ring(58, 50, 13), ring(50, 62, 11), ring(62, 36, 8)],
  animglyphs: () => {
    const out: Preview = [];
    for (let gy = 0; gy < 6; gy++)
      for (let gx = 0; gx < 6; gx++) {
        const x = 16 + gx * 13.5, y = 16 + gy * 13.5;
        if (Math.hypot(x - 50, y - 48) > 36) continue;
        out.push([P(x - 3, y - 3), P(x + 3, y + 3)], [P(x + 3, y - 3), P(x - 3, y + 3)]);
      }
    return out;
  },
  animriso: () => [ring(46, 46, 24), ring(54, 52, 24)],
  animtrails: () => {
    const out: Preview = [];
    for (let i = 0; i < 7; i++) {
      const a0 = (i / 7) * TAU;
      out.push(param((t) => P(50 + Math.cos(a0 + t * 1.8) * (12 + t * 26), 50 + Math.sin(a0 + t * 1.4) * (10 + t * 24)), 0, 1, 0.05));
    }
    return out;
  },
  animstrings: () => {
    const out: Preview = [ring(50, 50, 40, 60)];
    let pin = 3;
    for (let i = 0; i < 26; i++) {
      const next = (pin * 7 + 11) % 40;
      const a1 = (pin / 40) * TAU, a2 = (next / 40) * TAU;
      out.push([P(50 + Math.cos(a1) * 40, 50 + Math.sin(a1) * 40), P(50 + Math.cos(a2) * 40, 50 + Math.sin(a2) * 40)]);
      pin = next;
    }
    return out;
  },
  animshatter: () => [
    [P(12, 20), P(45, 12), P(38, 42), P(14, 48), P(12, 20)],
    [P(50, 14), P(86, 22), P(72, 46), P(44, 44), P(50, 14)],
    [P(16, 54), P(46, 50), P(52, 84), P(20, 80), P(16, 54)],
    [P(56, 52), P(84, 50), P(80, 84), P(58, 86), P(56, 52)],
  ],
  animcontours: () => [ring(50, 50, 38), ring(52, 48, 29), ring(48, 50, 21), ring(50, 52, 13), ring(51, 49, 6)],
  animcutout: () => [rect(18, 18, 56, 56), rect(28, 30, 44, 44), rect(40, 40, 30, 32)],
};

export function toolPreview(slug: string): Preview {
  const hit = cache.get(slug);
  if (hit) return hit;
  const gen = ANIM_PREVIEWS[slug];
  if (gen) {
    const p = gen();
    cache.set(slug, p);
    return p;
  }
  let out: Preview;
  const b = BLOCK_PREVIEW[slug];
  if (b) {
    try {
      const params = { ...(BLOCK_BY_TYPE[b.type]?.defaults ?? {}), ...b.params };
      out = runBlocks([{ id: "p", type: b.type, params }], { seed: 2, defaultHex: "#000000" }).groups.flat();
    } catch {
      out = custom(slug);
    }
  } else {
    out = custom(slug);
  }
  cache.set(slug, out);
  return out;
}
