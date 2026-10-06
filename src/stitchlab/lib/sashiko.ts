// Shared phase-word and hitomezashi geometry. Extracted unchanged from the original Sashiko tool.
import type { PathMm } from "./generators";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type WordKind = "random" | "fibonacci" | "pell" | "alternate" | "text";

/** Generate a phase word of length n. */
export function phaseWord(kind: WordKind, n: number, seed = 1, text = ""): boolean[] {
  if (kind === "alternate") return Array.from({ length: n }, (_, i) => i % 2 === 0);
  if (kind === "random") {
    const rand = mulberry32(seed);
    return Array.from({ length: n }, () => rand() < 0.5);
  }
  if (kind === "text") {
    const src = text.replace(/\s/g, "");
    // Empty input falls back to the Fibonacci word (clearly a pattern, clearly
    // not your text yet). Each character is hash-mixed with its position -
    // plain charcode parity is case-blind (upper/lower differ by 32), which
    // made "BAYSIDE" invisibly identical to the old default.
    if (!src) return phaseWord("fibonacci", n);
    return Array.from({ length: n }, (_, i) => {
      const c = src.charCodeAt(i % src.length);
      let x = (Math.imul(c, 2654435761) + Math.imul(i + 1, 40503)) >>> 0;
      x ^= x >>> 13;
      x = Math.imul(x, 0x5bd1e995) >>> 0;
      x ^= x >>> 15;
      return (x & 1) === 1;
    });
  }
  // Substitution words: Fibonacci 0→01, 1→0 · Pell-style 0→001, 1→0.
  let w = "0";
  while (w.length < n) {
    let next = "";
    for (const c of w) {
      if (kind === "fibonacci") next += c === "0" ? "01" : "0";
      else next += c === "0" ? "001" : "0";
    }
    w = next;
    if (w.length > 100000) break;
  }
  return Array.from({ length: n }, (_, i) => w[i % w.length] === "1");
}

export type SashikoGrid = {
  cols: number;
  rows: number;
  pitchMm: number;
  /** Per horizontal line: dash-on flags per cell. */
  hOn: boolean[][];
  /** Per vertical line: dash-on flags per cell. */
  vOn: boolean[][];
};

/** The hitomezashi rule: line phase = its word bit; dashes alternate. */
export function hitomezashi(
  cols: number,
  rows: number,
  pitchMm: number,
  wordA: boolean[],
  wordB: boolean[],
): SashikoGrid {
  const hOn: boolean[][] = [];
  for (let r = 0; r <= rows; r++) {
    const phase = wordA[r % wordA.length] ? 1 : 0;
    hOn.push(Array.from({ length: cols }, (_, c) => (c + phase) % 2 === 0));
  }
  const vOn: boolean[][] = [];
  for (let c = 0; c <= cols; c++) {
    const phase = wordB[c % wordB.length] ? 1 : 0;
    vOn.push(Array.from({ length: rows }, (_, r) => (r + phase) % 2 === 0));
  }
  return { cols, rows, pitchMm, hOn, vOn };
}

/**
 * Convert the grid to stitch paths.
 * weight mode: one continuous path per line; ON cells repeated fwd/back/fwd.
 * gaps mode: each ON dash is its own 2-point path (jump between dashes).
 * Grid is centered on the origin. Returns horizontal and vertical path sets
 * separately so two-tone sewing can split them.
 */
export function sashikoPaths(
  grid: SashikoGrid,
  mode: "weight" | "gaps",
): { horizontal: PathMm[]; vertical: PathMm[] } {
  const { cols, rows, pitchMm: p, hOn, vOn } = grid;
  const ox = (cols * p) / 2;
  const oy = (rows * p) / 2;
  const horizontal: PathMm[] = [];
  const vertical: PathMm[] = [];

  const line = (
    on: boolean[],
    pointAt: (cell: number) => { x: number; y: number },
    sink: PathMm[],
  ) => {
    if (mode === "gaps") {
      for (let c = 0; c < on.length; c++) {
        if (on[c]) sink.push([pointAt(c), pointAt(c + 1)]);
      }
      return;
    }
    const path: PathMm = [pointAt(0)];
    for (let c = 0; c < on.length; c++) {
      const b = pointAt(c + 1);
      if (on[c]) {
        const a = pointAt(c);
        path.push(b, a, b); // bean the dash: fwd, back, fwd
      } else {
        path.push(b); // light single pass through the gap
      }
    }
    sink.push(path);
  };

  for (let r = 0; r <= rows; r++) {
    const y = r * p - oy;
    line(hOn[r], (c) => ({ x: c * p - ox, y }), horizontal);
  }
  for (let c = 0; c <= cols; c++) {
    const x = c * p - ox;
    line(vOn[c], (r) => ({ x, y: r * p - oy }), vertical);
  }
  return { horizontal, vertical };
}

