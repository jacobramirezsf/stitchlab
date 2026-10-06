/** Photo tone over the existing hitomezashi phase lattice. An original machine
 * interpretation, not a claim to reproduce the reverse of hand sashiko.
 * Woven: continuous single-pass ground, narrow three-pass shadow ribbons.
 * Open: ordered tone screening selects separated dashes; gaps are actual jumps.
 */
import { beanify, resamplePath, type PathMm } from "./generators";
import { hitomezashi, phaseWord, type WordKind } from "./sashiko";

export type ToneImage = { w: number; h: number; lum: Float32Array };
export type ToneOptions = {
  sizeMm: number; pitchMm: number; gamma: number; invert: boolean;
  mode: "woven" | "open"; word: WordKind; seed: number; stitchMm: number;
};
export const TONE_DEFAULTS: ToneOptions = {
  sizeMm: 140, pitchMm: 3.5, gamma: 1, invert: false,
  mode: "woven", word: "alternate", seed: 11, stitchMm: 2,
};
const clamp = (n: number, lo: number, hi: number, fallback: number) =>
  Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : fallback));
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Procedural sources keep the tool useful before upload and make test sheets reproducible. */
export function toneSample(kind: "bloom" | "waves" | "ramp", size = 192): ToneImage {
  const w = size, h = size, lum = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const px = (x + 0.5) / w * 2 - 1, py = (y + 0.5) / h * 2 - 1;
    const r = Math.hypot(px, py), a = Math.atan2(py, px);
    let dark: number;
    if (kind === "ramp") dark = Math.floor((x / w) * 5) / 4;
    else if (kind === "waves") dark = r < 0.92 ? (0.5 + 0.5 * Math.sin(px * 9 + 2.5 * Math.sin(py * 3))) * (1 - Math.pow(r, 6)) : 0;
    else {
      const petal = 0.51 + 0.27 * Math.cos(a * 7);
      dark = r < petal ? 0.45 + 0.50 * (1 - r / Math.max(0.1, petal)) : 0;
      if (r < 0.18) dark = 0.95;
    }
    lum[y * w + x] = 1 - clamp(dark, 0, 1, 0);
  }
  return { w, h, lum };
}

export function sashikoTone(image: ToneImage, opts: ToneOptions) {
  if (!Number.isInteger(image.w) || !Number.isInteger(image.h) || image.w < 1 || image.h < 1
      || image.w > 2048 || image.h > 2048 || image.lum.length !== image.w * image.h) {
    throw new Error("Choose an image with valid dimensions (up to 2048 pixels per side).");
  }
  const size = clamp(opts.sizeMm, 50, 220, 140);
  const wantedPitch = clamp(opts.pitchMm, 2.5, 7, 3.5);
  const longCells = Math.max(6, Math.min(88, Math.floor(size / wantedPitch)));
  const pitch = size / longCells;
  const cols = Math.max(1, Math.round(longCells * image.w / Math.max(image.w, image.h)));
  const rows = Math.max(1, Math.round(longCells * image.h / Math.max(image.w, image.h)));
  const width = cols * pitch, height = rows * pitch;
  const gamma = clamp(opts.gamma, 0.4, 2.4, 1);
  const stitch = clamp(opts.stitchMm, 1, 3, 2);
  const grid = hitomezashi(cols, rows, pitch,
    phaseWord(opts.word, rows + 1, opts.seed), phaseWord(opts.word, cols + 1, opts.seed + 31));
  // Integral image: average a whole physical cell instead of one alias-prone pixel.
  const stride = image.w + 1;
  const sums = new Float64Array(stride * (image.h + 1));
  for (let y = 0; y < image.h; y++) {
    let total = 0;
    for (let x = 0; x < image.w; x++) {
      let dark = 1 - clamp(image.lum[y * image.w + x], 0, 1, 1);
      if (opts.invert) dark = 1 - dark;
      total += dark;
      sums[(y + 1) * stride + x + 1] = sums[y * stride + x + 1] + total;
    }
  }
  const toneAt = (cx: number, cy: number) => {
    const x0 = Math.max(0, Math.min(image.w - 1, Math.floor((cx - 0.5) / cols * image.w)));
    const y0 = Math.max(0, Math.min(image.h - 1, Math.floor((cy - 0.5) / rows * image.h)));
    const x1 = Math.max(x0 + 1, Math.min(image.w, Math.ceil((cx + 0.5) / cols * image.w)));
    const y1 = Math.max(y0 + 1, Math.min(image.h, Math.ceil((cy + 0.5) / rows * image.h)));
    const sum = sums[y1 * stride + x1] - sums[y0 * stride + x1] - sums[y1 * stride + x0] + sums[y0 * stride + x0];
    return Math.pow(clamp(sum / ((x1 - x0) * (y1 - y0)), 0, 1, 0), gamma);
  };
  const horizontal: PathMm[] = [], vertical: PathMm[] = [];
  let activeDashes = 0;
  const sewLine = (on: boolean[], lineIndex: number, verticalLine: boolean, sink: PathMm[]) => {
    const pointAt = (c: number) => verticalLine
      ? { x: lineIndex * pitch - width / 2, y: c * pitch - height / 2 }
      : { x: c * pitch - width / 2, y: lineIndex * pitch - height / 2 };
    const line: PathMm = [pointAt(0)];
    const fragments: PathMm[] = [];
    for (let c = 0; c < on.length; c++) {
      const tone = verticalLine ? toneAt(lineIndex, c + 0.5) : toneAt(c + 0.5, lineIndex);
      // Index on dash number (not cell parity), so all 16 screen thresholds are used.
      const threshold = (BAYER[((lineIndex + (verticalLine ? 1 : 0)) % 4) * 4 + (Math.floor(c / 2) % 4)] + 0.5) / 16;
      if (opts.mode === "open") {
        if (!on[c] || tone <= threshold) continue;
        // Leave clear intersections to avoid stacking horizontal/vertical tacks.
        fragments.push(beanify(resamplePath([pointAt(c + 0.12), pointAt(c + 0.88)], stitch), 3));
        activeDashes++;
      } else {
        const accented = on[c] && tone > threshold;
        const a = pointAt(c), b = pointAt(c + 1);
        if (accented) {
          activeDashes++;
          // Three full-length diagonal passes make a visible narrow ribbon,
          // instead of repeatedly punching identical holes. No tiny cross-steps.
          const half = Math.min(pitch * 0.22, 0.25 + tone * 0.50);
          const offset = (p: { x: number; y: number }, d: number) => ({
            x: clamp(p.x + (verticalLine ? d : 0), -width / 2, width / 2, p.x),
            y: clamp(p.y + (verticalLine ? 0 : d), -height / 2, height / 2, p.y),
          });
          const corners = [a, offset(b, half), offset(a, -half), b];
          for (let j = 1; j < corners.length; j++) {
            line.push(...resamplePath([corners[j - 1], corners[j]], stitch).slice(1));
          }
        } else line.push(...resamplePath([a, b], stitch).slice(1));
      }
    }
    // Serpentine order shortens row-to-row travel without stitching over the gaps.
    if (opts.mode === "woven") sink.push(lineIndex % 2 ? line.reverse() : line);
    else sink.push(...(lineIndex % 2 ? fragments.reverse().map((p) => p.reverse()) : fragments));
  };
  grid.hOn.forEach((on, r) => sewLine(on, r, false, horizontal));
  grid.vOn.forEach((on, c) => sewLine(on, c, true, vertical));
  return { horizontal, vertical, activeDashes, width, height, pitchMm: pitch, cols, rows };
}
