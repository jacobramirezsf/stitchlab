import { describe, expect, it } from "vitest";
import { TONE_DEFAULTS, sashikoTone, toneSample } from "./sashikoTone";
import { pathGroupsToStitches, type PathMm } from "./generators";
import { CMD, type Stitch } from "./pattern";
import { parseDst, writeDst } from "./dst";
import { parsePes } from "./pec";
import { writePes } from "./pes";
import { computeStats } from "./stats";
import { phaseWord, hitomezashi, sashikoPaths } from "./sashiko";

function validate(stitches: Stitch[], colors = ["#173f45"]) {
  const dst = writeDst(stitches, "research-test");
  const parsed = parseDst(dst.buffer.slice(dst.byteOffset, dst.byteOffset + dst.byteLength) as ArrayBuffer);
  const stats = computeStats(parsed);
  expect(stats.realStitches).toBeGreaterThan(5);
  expect(stats.widthMm).toBeLessThanOrEqual(220.1);
  expect(stats.heightMm).toBeLessThanOrEqual(220.1);
  expect(stats.maxStitchMm).toBeLessThanOrEqual(3.6);
  expect(parsed.stitches.every((s) => Number.isFinite(s.x) && Number.isFinite(s.y))).toBe(true);
  expect(parsed.stitches.at(-1)?.cmd).toBe(CMD.END);
  const pes = writePes(parsed.stitches, colors, "research-test");
  const restored = parsePes(pes.buffer.slice(pes.byteOffset, pes.byteOffset + pes.byteLength) as ArrayBuffer);
  const pesStats = computeStats(restored);
  // The PEC encoder may add zero-length seating stitches after diagonal jumps.
  // Compare the actual nonzero needle-down segments, not raw record counts.
  const sewnSegments = (items: Stitch[]) => items.flatMap((s, i) => {
    const before = items[i - 1];
    return before && s.cmd === CMD.STITCH && (s.x !== before.x || s.y !== before.y)
      ? [[before.x, before.y, s.x, s.y]] : [];
  });
  expect(sewnSegments(restored.stitches)).toEqual(sewnSegments(parsed.stitches));
  expect(pesStats.widthMm).toBeCloseTo(stats.widthMm, 1);
  expect(pesStats.colorBlockCount).toBe(stats.colorBlockCount);
  return stats;
}

describe("Sashiko Tone: tone, routing, formats", () => {
  for (const mode of ["woven", "open"] as const) for (const word of ["alternate", "random", "fibonacci"] as const)
    it(`${mode}/${word}: valid two-color exports`, () => {
      const result = sashikoTone(toneSample("bloom"), { ...TONE_DEFAULTS, mode, word });
      const stats = validate(pathGroupsToStitches([result.horizontal, result.vertical]), ["#173f45", "#ac513a"]);
      expect(stats.colorBlockCount).toBe(2);
      expect(stats.realStitches).toBeLessThan(60000);
    });
  it("open mode leaves white entirely empty and gives dark tones more coverage", () => {
    const count = (lum: number) => {
      const img = { w: 32, h: 32, lum: new Float32Array(1024).fill(lum) };
      return sashikoTone(img, { ...TONE_DEFAULTS, mode: "open" }).activeDashes;
    };
    expect(count(1)).toBe(0);
    expect(count(0.7)).toBeGreaterThan(0);
    expect(count(0)).toBeGreaterThan(count(0.7));
  });
  it("inversion is equivalent to complementing source luminance", () => {
    const source = toneSample("ramp");
    const reverse = { ...source, lum: source.lum.map((v) => 1 - v) };
    expect(sashikoTone(source, { ...TONE_DEFAULTS, invert: true })).toEqual(sashikoTone(reverse, TONE_DEFAULTS));
  });
  it("woven route has one path per row/column, far fewer travels than open dashes", () => {
    const image = { w: 16, h: 16, lum: new Float32Array(256) };
    const woven = sashikoTone(image, TONE_DEFAULTS), open = sashikoTone(image, { ...TONE_DEFAULTS, mode: "open" });
    expect(woven.horizontal.length).toBe(woven.rows + 1);
    expect(woven.vertical.length).toBe(woven.cols + 1);
    expect(open.horizontal.length + open.vertical.length).toBeGreaterThan(10 * (woven.horizontal.length + woven.vertical.length));
  });
  it("handles portrait, landscape, one-pixel sources and malformed input", () => {
    for (const [w, h] of [[1, 1], [1, 100], [100, 1], [80, 160], [160, 80]]) {
      const result = sashikoTone({ w, h, lum: new Float32Array(w * h).fill(0.1) }, TONE_DEFAULTS);
      validate(pathGroupsToStitches([[...result.horizontal, ...result.vertical]]));
      expect(result.pitchMm).toBeGreaterThanOrEqual(TONE_DEFAULTS.pitchMm);
    }
    expect(() => sashikoTone({ w: 0, h: 10, lum: new Float32Array(0) }, TONE_DEFAULTS)).toThrow();
    expect(() => sashikoTone({ w: 10, h: 10, lum: new Float32Array(1) }, TONE_DEFAULTS)).toThrow();
  });
});

describe("Original Sashiko phase extraction regression", () => {
  it("keeps the original phase and exact bean sequence", () => {
    expect(phaseWord("fibonacci", 8)).toEqual([false, true, false, false, true, false, true, false]);
    const grid = hitomezashi(2, 2, 3, [false], [true]);
    expect(grid.hOn).toEqual([[true, false], [true, false], [true, false]]);
    const first: PathMm = [{ x: -3, y: -3 }, { x: 0, y: -3 }, { x: -3, y: -3 }, { x: 0, y: -3 }, { x: 3, y: -3 }];
    expect(sashikoPaths(grid, "weight").horizontal[0]).toEqual(first);
  });
});
