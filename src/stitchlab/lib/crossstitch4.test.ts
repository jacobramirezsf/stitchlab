import { describe, expect, it } from "vitest";
import {
  assignLabels, buildChart, buildLabels, ciede2000, coneMasks, countIslands, linToOklab,
  planStitches, prepareImage, routeConsistent, sampleCells, selectPalette, type Chart,
} from "./crossstitch4";

/** RGBA image from a per-pixel color function. */
function img(w: number, h: number, f: (x: number, y: number) => [number, number, number]) {
  const rgb = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = f(x, y);
      const i = (y * w + x) * 4;
      rgb[i] = r; rgb[i + 1] = g; rgb[i + 2] = b; rgb[i + 3] = 255;
    }
  return prepareImage({ w, h, rgb });
}

describe("color", () => {
  it("OKLab maps white and black to the ends of L", () => {
    const w = linToOklab(1, 1, 1), k = linToOklab(0, 0, 0);
    expect(w[0]).toBeCloseTo(1, 3);
    expect(Math.hypot(w[1], w[2])).toBeLessThan(1e-3);
    expect(k[0]).toBeCloseTo(0, 6);
  });
  it("CIEDE2000 matches Sharma, Wu & Dalal (2005) test pairs", () => {
    expect(ciede2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3);
    expect(ciede2000([50, -1.3802, -84.2814], [50, 0, -82.7485])).toBeCloseTo(1.0, 3);
    expect(ciede2000([2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514])).toBeCloseTo(0.9082, 3);
  });
});

describe("sampling", () => {
  it("averages in linear light, so a half-black half-white cell is 50% luminance", () => {
    // 2-px-wide cells of alternating black/white columns
    const t = sampleCells(img(8, 8, (x) => (x % 2 ? [255, 255, 255] : [0, 0, 0])), 4, 0);
    expect(t.lin[0]).toBeCloseTo(0.5, 2); // gamma-space averaging would give ≈0.21
  });
  it("sharpness pulls a mixed cell toward its majority color", () => {
    // each 4-px-wide cell: 3 px red, 1 px blue
    const p = img(16, 4, (x) => (x % 4 === 3 ? [0, 0, 255] : [255, 0, 0]));
    const soft = sampleCells(p, 4, 0), crisp = sampleCells(p, 4, 1);
    expect(crisp.lin[0]).toBeGreaterThan(soft.lin[0]); // more red
    expect(crisp.lin[2]).toBeLessThan(soft.lin[2]); // less blue
  });
});

describe("palette", () => {
  const red = img(20, 20, () => [200, 20, 30]);
  it("picks a red cone for a red photo", () => {
    const [c] = selectPalette(sampleCells(red, 10, 0), { k: 1 });
    const n = parseInt(c.hex.slice(1), 16);
    expect((n >> 16) & 255).toBeGreaterThan(((n >> 8) & 255) + 60);
  });
  it("keeps locked cones and never returns excluded ones", () => {
    const t = sampleCells(red, 10, 0);
    const first = selectPalette(t, { k: 1 })[0].code;
    const pal = selectPalette(t, { k: 3, locked: ["1800"], excluded: [first] });
    expect(pal.map((c) => c.code)).toContain("1800");
    expect(pal.map((c) => c.code)).not.toContain(first);
    expect(pal).toHaveLength(3);
  });
});

describe("assignment", () => {
  // Noisy two-tone photo: dark left / light right, with salt-and-pepper speckle.
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const noisy = img(40, 40, (x) => {
    const base = x < 20 ? 40 : 210;
    const v = rnd() < 0.15 ? 255 - base : base;
    return [v, v, v];
  });
  const t = sampleCells(noisy, 40, 0);
  const pal = selectPalette(t, { k: 2 });
  const labels = buildLabels(pal, {});

  it("smoothness removes confetti", () => {
    const raw = assignLabels(t, labels, { smoothness: 0 });
    const smooth = assignLabels(t, labels, { smoothness: 1 });
    expect(countIslands(t.cols, t.rows, smooth, labels)).toBeLessThan(countIslands(t.cols, t.rows, raw, labels) / 4);
  });
  it("min region leaves no region smaller than asked", () => {
    const out = assignLabels(t, labels, { minRegion: 4 });
    expect(countIslands(t.cols, t.rows, out, labels)).toBe(0);
  });
  it("blends are only built between nearby cones", () => {
    const far = buildLabels([{ code: "a", name: "", hex: "#ff0000" }, { code: "b", name: "", hex: "#00ff00" }], { blends: true });
    expect(far.some((l) => l.kind === "blend")).toBe(false);
    const near = buildLabels([{ code: "a", name: "", hex: "#ff0000" }, { code: "b", name: "", hex: "#e01010" }], { blends: true });
    expect(near.some((l) => l.kind === "blend")).toBe(true);
  });
});

describe("routing", () => {
  // A 6×4 solid block of one cone, nothing else.
  const solid: Chart = (() => {
    const p = img(60, 40, () => [30, 60, 160]);
    return buildChart(p, { cols: 6, k: 1, fractional: false });
  })();

  /** Every mask half-leg must appear between consecutive stroke points. */
  function covered(ch: Chart, route: "continuous" | "consistent") {
    const plan = planStitches(ch, { cellMm: 2.5, route, locks: false });
    const seen = new Set<string>();
    const key = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const k = (p: { x: number; y: number }) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
      return [k(a), k(b)].sort().join("|");
    };
    for (const g of plan.groups) for (const st of g) for (let i = 1; i < st.length; i++) seen.add(key(st[i - 1], st[i]));
    const masks = coneMasks(ch, 2.5);
    const ox = (-ch.cols * 2.5) / 2, oy = (-ch.rows * 2.5) / 2;
    const off = [[0, 0], [2, 0], [2, 2], [0, 2]];
    let missing = 0;
    masks.forEach((m) => m.forEach((bits, c) => {
      const x = c % ch.cols, y = (c / ch.cols) | 0;
      const ctr = { x: ox + (x + 0.5) * 2.5, y: oy + (y + 0.5) * 2.5 };
      for (let k = 0; k < 4; k++) if (bits & (1 << k)) {
        const cp = { x: ox + (x + off[k][0] / 2) * 2.5, y: oy + (y + off[k][1] / 2) * 2.5 };
        if (!seen.has(key(cp, ctr))) missing++;
      }
    }));
    return { missing, plan };
  }

  it("continuous mode sews a solid block as ONE stroke and covers every half-leg", () => {
    const { missing, plan } = covered(solid, "continuous");
    expect(missing).toBe(0);
    expect(plan.strokes).toBe(1);
  });
  it("consistent mode sews a solid block as ONE stroke and covers every half-leg", () => {
    const { missing, plan } = covered(solid, "consistent");
    expect(missing).toBe(0);
    expect(plan.strokes).toBe(1);
  });
  it("consistent mode lays every cell's \\ leg after its / leg", () => {
    const m = coneMasks(solid, 2.5)[0];
    const { strokes } = routeConsistent(m, solid.cols, solid.rows, 1, true);
    const st = strokes[0];
    // first time each cell's full "\" (TL→center→BR or reverse) completes vs its "/"
    const lastFwd = new Map<number, number>(), lastBack = new Map<number, number>();
    for (let i = 2; i < st.length / 2; i++) {
      const [ax, ay, cx, cy, bx, by] = st.slice((i - 2) * 2, i * 2 + 2);
      if (!(cx & 1) || ax === bx) continue; // not a corner-center-corner straight leg
      if (ax + bx !== 2 * cx || ay + by !== 2 * cy) continue;
      const cell = ((cy - 1) >> 1) * solid.cols + ((cx - 1) >> 1);
      const isFwd = (bx - ax) * (by - ay) < 0;
      (isFwd ? lastFwd : lastBack).set(cell, i);
    }
    for (const [cell, f] of lastFwd) expect(lastBack.get(cell)!).toBeGreaterThan(f);
  });
  it("two passes keep every stitch within one leg length", () => {
    const plan = planStitches(solid, { cellMm: 2.5, passes: 2 });
    for (const g of plan.groups) for (const st of g) for (let i = 1; i < st.length; i++)
      expect(Math.hypot(st[i].x - st[i - 1].x, st[i].y - st[i - 1].y)).toBeLessThanOrEqual(2.5 * Math.SQRT1_2 + 1e-6);
  });
});

describe("chart", () => {
  it("lists only cones that are actually sewn", () => {
    // a two-tone photo asked for 6 cones: unused picks must be dropped
    const p = img(40, 20, (x) => (x < 20 ? [30, 40, 120] : [220, 200, 60]));
    const ch = buildChart(p, { cols: 20, k: 6, blends: true, useFabric: true });
    const used = new Set<number>();
    for (const v of ch.cell) { const l = ch.labels[v]; if (l.fwd >= 0) used.add(l.fwd); if (l.back >= 0) used.add(l.back); }
    expect(used.size).toBe(ch.palette.length);
    expect(Math.min(...ch.cell)).toBeGreaterThanOrEqual(0);
  });
});
