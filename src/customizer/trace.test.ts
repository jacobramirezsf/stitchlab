// Unit tests for the silhouette-tracing pipeline (pure functions, no DOM).
// Run with `npm test` (vitest).

import { describe, expect, it } from "vitest";
import {
  buildCutSvg,
  contoursToSvgPath,
  findIslands,
  maskFromImageData,
  simplifyContour,
  smallIslandWarnings,
  toMask,
  traceContours,
  traceToSvg,
} from "./trace";

// build a w×h mask from ascii art rows ("#" = opaque)
const mask = (rows: string[]): { m: Uint8Array; w: number; h: number } => {
  const h = rows.length;
  const w = rows[0].length;
  const m = new Uint8Array(w * h);
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) m[y * w + x] = row[x] === "#" ? 1 : 0;
  });
  return { m, w, h };
};

// mask → fake RGBA (alpha channel drives everything)
const rgba = (m: Uint8Array): Uint8ClampedArray => {
  const d = new Uint8ClampedArray(m.length * 4);
  for (let i = 0; i < m.length; i++) d[i * 4 + 3] = m[i] ? 255 : 0;
  return d;
};

const polygonArea = (pts: { x: number; y: number }[]): number => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(a) / 2;
};

describe("toMask / maskFromImageData", () => {
  it("thresholds an alpha channel", () => {
    const d = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 10]);
    expect([...maskFromImageData(d, 2, 1)]).toEqual([1, 0]);
  });
  it("supports stride-1 grayscale", () => {
    expect([...toMask(new Uint8Array([200, 10]), 2, 1)]).toEqual([1, 0]);
  });
});

describe("traceContours", () => {
  it("traces a solid square as one closed contour", () => {
    const { m, w, h } = mask([
      "....",
      ".##.",
      ".##.",
      "....",
    ]);
    const contours = traceContours(m, w, h);
    expect(contours).toHaveLength(1);
    // the contour encloses roughly the 2×2 pixel block
    const area = polygonArea(contours[0]);
    expect(area).toBeGreaterThan(2);
    expect(area).toBeLessThan(7);
  });

  it("preserves holes (donut → two contours)", () => {
    const { m, w, h } = mask([
      ".......",
      ".#####.",
      ".#...#.",
      ".#...#.",
      ".#####.",
      ".......",
    ]);
    const contours = traceContours(m, w, h);
    expect(contours).toHaveLength(2);
  });

  it("closes shapes touching the image edge", () => {
    const { m, w, h } = mask([
      "##..",
      "##..",
      "....",
    ]);
    const contours = traceContours(m, w, h);
    expect(contours).toHaveLength(1);
    // closed loop: last point chains back to the first segment's start
    expect(contours[0].length).toBeGreaterThanOrEqual(4);
  });

  it("separates disconnected pieces", () => {
    const { m, w, h } = mask([
      "#..#",
      "....",
      "#..#",
    ]);
    expect(traceContours(m, w, h)).toHaveLength(4);
  });
});

describe("simplifyContour", () => {
  it("collapses collinear runs", () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ x: i, y: 0 }));
    pts.push({ x: 19, y: 10 }, { x: 0, y: 10 });
    const out = simplifyContour(pts, 0.5);
    expect(out.length).toBeLessThan(pts.length);
    expect(out.length).toBeGreaterThanOrEqual(3);
  });
  it("keeps tiny polygons intact", () => {
    const tri = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 2, y: 3 },
    ];
    expect(simplifyContour(tri, 0.5)).toEqual(tri);
  });
});

describe("findIslands / smallIslandWarnings", () => {
  it("counts components with correct areas", () => {
    const { m, w, h } = mask([
      "##...",
      "##..#",
      ".....",
    ]);
    const islands = findIslands(m, w, h).sort((a, b) => b.area - a.area);
    expect(islands).toHaveLength(2);
    expect(islands[0].area).toBe(4);
    expect(islands[1].area).toBe(1);
  });

  it("flags pieces under the minimum feature size at physical scale", () => {
    const { m, w, h } = mask([
      "#####....",
      "#####..#.",
      "#####....",
    ]);
    const islands = findIslands(m, w, h);
    // 9px wide image printed at 18mm → 2mm per px: the 1px dot = 2mm < 3mm
    const warn = smallIslandWarnings(islands, w, 18);
    expect(warn.count).toBe(1);
    expect(warn.sizesMm[0]).toBeCloseTo(2, 1);
    // at 90mm wide → 10mm per px: 5px block is 50mm, dot is 10mm, none flagged
    expect(smallIslandWarnings(islands, w, 90).count).toBe(0);
  });
});

describe("SVG output", () => {
  it("emits a closed evenodd path with physical mm dimensions", () => {
    const { m, w, h } = mask([
      ".....",
      ".###.",
      ".#.#.",
      ".###.",
      ".....",
    ]);
    const contours = traceContours(m, w, h);
    const svg = buildCutSvg(contours, w, h, 50);
    expect(svg).toContain('width="50mm"');
    expect(svg).toContain('height="50mm"'); // square image → square physical
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).toContain("MIRROR");
    const path = contoursToSvgPath(contours);
    expect(path.startsWith("M")).toBe(true);
    expect(path.endsWith("Z")).toBe(true);
  });

  it("traceToSvg drops sub-visible specks but keeps real pieces", () => {
    const { m, w, h } = mask([
      "########..",
      "########..",
      "########..",
      "########.#",
      "########..",
    ]);
    const { islands, svg } = traceToSvg(rgba(m), w, h, 100, { minKeepPx: 4 });
    // the lone 1px speck is dropped from both the trace and the island report
    expect(islands).toHaveLength(1);
    expect(svg).toContain("<path");
  });

  it("end-to-end: letter O keeps its counter", () => {
    const { m, w, h } = mask([
      "..........",
      "..######..",
      "..#....#..",
      "..#....#..",
      "..#....#..",
      "..######..",
      "..........",
    ]);
    const { contours } = traceToSvg(rgba(m), w, h, 80);
    expect(contours.length).toBe(2); // outer ring + counter
  });
});
