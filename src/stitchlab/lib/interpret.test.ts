// Tests for the photo-interpretation core - fabricated pixel buffers, no DOM.

import { describe, expect, it } from "vitest";
import {
  colorGrid,
  flowField,
  hex,
  kmeansPalette,
  luminanceGrid,
  nearestRisoInk,
  orderMarks,
  rng,
  softColorWeights,
  styleMarks,
  type ImgLike,
  type Mark,
} from "./interpret";

/** Build an image from a paint function (x, y) → [r,g,b,a]. */
const img = (w: number, h: number, paint: (x: number, y: number) => [number, number, number, number]): ImgLike => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = paint(x, y);
      const i = (y * w + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  return { data, width: w, height: h };
};

const halfDark = img(40, 20, (x) => (x < 20 ? [0, 0, 0, 255] : [255, 255, 255, 255]));

describe("rng", () => {
  it("is deterministic per seed", () => {
    const a = rng(42), b = rng(42), c = rng(43);
    expect([a(), a()]).toEqual([b(), b()]);
    expect(a()).not.toEqual(c());
  });
});

describe("luminanceGrid", () => {
  it("measures dark and light halves", () => {
    const g = luminanceGrid(halfDark, 8);
    expect(g.rows).toBe(4);
    expect(g.v[0]).toBeLessThan(0.1); // left = black
    expect(g.v[7]).toBeGreaterThan(0.9); // right = white
    expect(g.alpha[0]).toBeCloseTo(1, 1);
  });
  it("reads transparent regions as light with zero alpha", () => {
    const t = img(20, 20, () => [0, 0, 0, 0]);
    const g = luminanceGrid(t, 4);
    expect(g.v[0]).toBeCloseTo(1, 3);
    expect(g.alpha[0]).toBeCloseTo(0, 3);
  });
});

describe("kmeansPalette", () => {
  it("recovers the two colors of a two-color image, dark first", () => {
    const p = kmeansPalette(halfDark, 2);
    expect(p).toHaveLength(2);
    expect(p[0][0]).toBeLessThan(60); // near black
    expect(p[1][0]).toBeGreaterThan(200); // near white
  });
  it("caps k at the sample variety and never returns empty", () => {
    const solid = img(10, 10, () => [200, 30, 30, 255]);
    const p = kmeansPalette(solid, 5);
    expect(p.length).toBeGreaterThanOrEqual(1);
    expect(hex(p[0]).startsWith("#")).toBe(true);
  });
  it("ignores transparent pixels", () => {
    const ghost = img(10, 10, (x) => (x < 5 ? [0, 255, 0, 255] : [255, 0, 0, 0]));
    const p = kmeansPalette(ghost, 2);
    // only green sampled: every center is green-dominant
    for (const c of p) expect(c[1]).toBeGreaterThan(c[0]);
  });
});

describe("colorGrid", () => {
  it("maps cells to nearest palette entries", () => {
    const g = colorGrid(halfDark, 8, [[0, 0, 0], [255, 255, 255]]);
    expect(g.v[0]).toBe(0);
    expect(g.v[7]).toBe(1);
  });
});

describe("flowField", () => {
  it("returns an angle per cell", () => {
    const g = luminanceGrid(halfDark, 8);
    const f = flowField(g);
    expect(f).toHaveLength(g.cols * g.rows);
    // at the vertical black/white boundary the gradient is horizontal, so the
    // along-edge angle is vertical (± π/2 from atan2(0, ±))
    expect(Number.isFinite(f[3])).toBe(true);
  });
});

const OPTS = { cutoff: 0.15, invert: false, minR: 0.1, maxR: 0.45, jitter: 0, density: 1, glyphs: ["-", "x"], seed: 5 };

describe("styleMarks", () => {
  const lum = luminanceGrid(halfDark, 8);
  const col = colorGrid(halfDark, 8, [[0, 0, 0], [255, 255, 255]]);
  const flow = flowField(lum);

  it("dotgrid: only dark cells produce marks, sized by darkness", () => {
    const marks = styleMarks("dotgrid", lum, col, flow, OPTS);
    expect(marks.length).toBe(16); // 4 rows × 4 dark columns
    for (const m of marks) {
      expect(m.x).toBeLessThan(0.5);
      expect(m.r).toBeGreaterThan(0);
      expect(m.colorIdx).toBe(0);
    }
  });
  it("invert flips which side speaks", () => {
    const marks = styleMarks("dotgrid", lum, col, flow, { ...OPTS, invert: true });
    for (const m of marks) expect(m.x).toBeGreaterThan(0.5);
  });
  it("scatter density scales the count deterministically", () => {
    const a = styleMarks("scatter", lum, col, flow, OPTS);
    const b = styleMarks("scatter", lum, col, flow, { ...OPTS, density: 3 });
    const a2 = styleMarks("scatter", lum, col, flow, OPTS);
    expect(b.length).toBeGreaterThan(a.length);
    expect(a2.length).toBe(a.length); // same seed, same result
  });
  it("marks style assigns glyphs", () => {
    const marks = styleMarks("marks", lum, col, flow, OPTS);
    expect(marks.every((m) => m.glyph === "-" || m.glyph === "x")).toBe(true);
  });
  it("cutoff = 1 silences everything", () => {
    expect(styleMarks("dotgrid", lum, col, flow, { ...OPTS, cutoff: 1 })).toHaveLength(0);
  });
});

describe("orderMarks", () => {
  const marks: Mark[] = [
    { x: 0.9, y: 0.5, r: 0.01, colorIdx: 0, order: 0 },
    { x: 0.1, y: 0.5, r: 0.03, colorIdx: 0, order: 0 },
    { x: 0.5, y: 0.5, r: 0.02, colorIdx: 0, order: 0 },
  ];
  it("sweep orders left to right, normalized 0..1", () => {
    const o = orderMarks(marks, "sweep");
    const xs = o.map((m) => m.x);
    expect(xs).toEqual([0.1, 0.5, 0.9]);
    expect(o[0].order).toBe(0);
    expect(o[2].order).toBe(1);
  });
  it("darkness mode puts the biggest marks first", () => {
    const o = orderMarks(marks, "darkness");
    expect(o[0].r).toBe(0.03);
  });
  it("radial grows from the center", () => {
    const o = orderMarks(marks, "radial");
    expect(o[0].x).toBe(0.5);
  });
  it("shuffle is deterministic per seed", () => {
    const a = orderMarks(marks, "shuffle", 9).map((m) => m.x);
    const b = orderMarks(marks, "shuffle", 9).map((m) => m.x);
    expect(a).toEqual(b);
  });
});

describe("softColorWeights (riso separations)", () => {
  const two = img(40, 20, (x) => (x < 20 ? [200, 30, 30, 255] : [30, 30, 200, 255]));
  it("assigns each half mostly to its own ink", () => {
    const sep = softColorWeights(two, 8, [[200, 30, 30], [30, 30, 200]]);
    expect(sep.w).toHaveLength(2);
    expect(sep.w[0][0]).toBeGreaterThan(sep.w[1][0]); // left cell: red ink wins
    expect(sep.w[1][7]).toBeGreaterThan(sep.w[0][7]); // right cell: blue wins
  });
  it("carries little ink on light cells", () => {
    const light = img(20, 20, () => [250, 250, 250, 255]);
    const sep = softColorWeights(light, 4, [[0, 0, 0]]);
    expect(sep.w[0][0]).toBeLessThan(0.1);
  });
  it("weights never exceed 1 per cell", () => {
    const sep = softColorWeights(two, 8, [[200, 30, 30], [30, 30, 200]]);
    for (let i = 0; i < sep.w[0].length; i++) {
      expect(sep.w[0][i] + sep.w[1][i]).toBeLessThanOrEqual(1.001);
    }
  });
});

describe("riso inks", () => {
  it("nearestRisoInk maps pinks to Fluor Pink and blacks to Black", () => {
    expect(nearestRisoInk([255, 70, 175])).toBe("#ff48b0");
    expect(nearestRisoInk([10, 10, 10])).toBe("#000000");
  });
  it("styleMarks yields nothing for riso (separation-rendered)", () => {
    const lum = luminanceGrid(halfDark, 8);
    const col = colorGrid(halfDark, 8, [[0, 0, 0]]);
    expect(styleMarks("riso", lum, col, flowField(lum), OPTS)).toHaveLength(0);
  });
});

describe("stippleLloyd (weighted Voronoi)", () => {
  const lum = luminanceGrid(halfDark, 32);
  it("places all points in the dark half and keeps every relaxation frame", async () => {
    const { stippleLloyd } = await import("./interpret");
    const r = stippleLloyd(lum, 120, 3, 5);
    expect(r.frames).toHaveLength(4); // initial + 3 iterations
    expect(r.count).toBeGreaterThan(80);
    const last = r.frames[3];
    for (let i = 0; i < r.count; i++) expect(last[i * 2]).toBeLessThan(17); // dark half of 32 cols (+margin)
  });
  it("relaxation moves points (settle animation has something to show)", async () => {
    const { stippleLloyd } = await import("./interpret");
    const r = stippleLloyd(lum, 80, 2, 5);
    let moved = 0;
    for (let i = 0; i < r.count * 2; i++) moved += Math.abs(r.frames[2][i] - r.frames[0][i]);
    expect(moved).toBeGreaterThan(1);
  });
});

describe("stringChords (greedy residual)", () => {
  it("computes a deterministic chord sequence that favors the dark half", async () => {
    const { stringChords } = await import("./interpret");
    const lum = luminanceGrid(halfDark, 40);
    const r = await stringChords(lum, { pins: 40, lines: 30, opacity: 0.5 });
    expect(r.pins).toHaveLength(80);
    expect(r.sequence.length).toBeGreaterThan(10);
    // chords should concentrate on left-side pins: average pin x below center
    let avgX = 0;
    for (const p of r.sequence) avgX += r.pins[p * 2];
    avgX /= r.sequence.length;
    expect(avgX).toBeLessThan(20);
  });
  it("stops early when no chord still earns ink", async () => {
    const { stringChords } = await import("./interpret");
    const white = luminanceGrid(
      { data: new Uint8ClampedArray(40 * 20 * 4).fill(255), width: 40, height: 20 },
      40
    );
    const r = await stringChords(white, { pins: 30, lines: 50, opacity: 0.5 });
    expect(r.sequence.length).toBe(0);
  });
});

describe("advectTrails", () => {
  it("seeds trails in dark regions and stays in bounds", async () => {
    const { advectTrails } = await import("./interpret");
    const lum = luminanceGrid(halfDark, 40);
    const col = colorGrid(halfDark, 40, [[0, 0, 0]]);
    const trails = advectTrails(lum, flowField(lum), col, { count: 30, steps: 40, stepLen: 0.8, swirl: 0.3, seed: 4 });
    expect(trails.length).toBeGreaterThan(5);
    for (const t of trails) {
      expect(t.pts[0]).toBeLessThan(21); // starts dark side
      for (let i = 0; i < t.pts.length; i += 2) {
        expect(t.pts[i]).toBeGreaterThanOrEqual(0);
        expect(t.pts[i]).toBeLessThan(40);
      }
    }
  });
});

describe("voronoiCells", () => {
  it("produces convex-ish polygons covering distinct seeds", async () => {
    const { voronoiCells } = await import("./interpret");
    const cells = voronoiCells(40, 1, 3);
    expect(cells.length).toBeGreaterThan(35);
    for (const c of cells) {
      expect(c.poly.length).toBeGreaterThanOrEqual(3);
      for (const [x, y] of c.poly) {
        expect(x).toBeGreaterThanOrEqual(-0.001);
        expect(x).toBeLessThanOrEqual(1.001);
        expect(y).toBeGreaterThanOrEqual(-0.001);
        expect(y).toBeLessThanOrEqual(1.001);
      }
    }
  });
  it("is deterministic per seed", async () => {
    const { voronoiCells } = await import("./interpret");
    expect(JSON.stringify(voronoiCells(10, 1, 8))).toBe(JSON.stringify(voronoiCells(10, 1, 8)));
  });
});

describe("chaikin", () => {
  it("smooths and multiplies points", async () => {
    const { chaikin } = await import("./interpret");
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const out = chaikin(sq, 2);
    expect(out.length).toBe(16);
    for (const p of out) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(10);
    }
  });
});
