// Nearest-Madeira-Polyneon matching over the studio's 126-cone inventory,
// using the "redmean" perceptual color distance (compuphase.com formula, as
// used by pyembroidery's EmbThread for nearest-color work).

import { THREADS, type Thread } from "../../data/threads";

function hexToRgb(hex: string): [number, number, number] | null {
  let h = hex.replace("#", "");
  if (h.length === 3)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function redmeanDistance(hexA: string, hexB: string): number {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (!a || !b) return Infinity;
  const rMean = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(
    (2 + rMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rMean) / 256) * db * db,
  );
}

export type ThreadMatch = { thread: Thread; distance: number };

/** Closest Polyneon cones to a target color, best first. */
export function nearestThreads(hex: string, count = 3): ThreadMatch[] {
  const scored: ThreadMatch[] = [];
  for (const thread of THREADS) {
    if (!thread.hex) continue;
    scored.push({ thread, distance: redmeanDistance(hex, thread.hex) });
  }
  scored.sort((a, b) => a.distance - b.distance);
  return scored.slice(0, count);
}

export function threadByCode(code: string): Thread | undefined {
  return THREADS.find((t) => t.code === code);
}

/** Pleasant default rotation for files that carry no color (DST). */
export const DEFAULT_ROTATION_CODES = [
  "1640", // deep navy-ish blue family pick, falls back below if absent
  "1747",
  "1801",
  "1651",
  "1981",
  "1592",
];

export function defaultHexForBlock(index: number): string {
  const withHex = THREADS.filter((t) => t.hex && !t.isMetallic);
  const preferred = DEFAULT_ROTATION_CODES.map((c) => withHex.find((t) => t.code === c)).filter(
    (t): t is Thread => !!t,
  );
  const pool = preferred.length >= 3 ? preferred : withHex;
  const pick = pool[index % pool.length];
  return pick?.hex ?? "#1c1c1a";
}
