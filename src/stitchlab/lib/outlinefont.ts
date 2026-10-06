// Outline-font lettering - bring any real OTF/TTF/WOFF typeface into thread.
//
// The Lettering tool's built-in faces are single-line (Hershey/EMS): one stroke
// down the spine of each letter. Real typefaces are the opposite - filled
// shapes bounded by closed outlines (with counters: the hole in a "B", "o",
// "e"). This module turns an opentype.js Font into embroiderable geometry:
// flatten each glyph's bézier outline into closed polygon rings (grouped per
// glyph so counters pair with their letter), laid out as a line of text in mm.
//
// From there a caller can either stitch the rings as a running outline, or hand
// each glyph's rings to tatamiFill for a solid satin/tatami-filled letter.
//
// Pure and deterministic given a font. DOM-free. Node-validated against a real
// font file. opentype.js is passed in (its Font is deterministic) - this file
// never imports it, so it stays a pure geometry layer.

import type { PathMm } from "./generators";

// Minimal structural types for the slice of opentype.js we use - avoids a hard
// dependency and keeps this testable with a stand-in.
export type OTCommand = {
  type: "M" | "L" | "C" | "Q" | "Z";
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
};
export type OTGlyph = { advanceWidth?: number; getPath: (x: number, y: number, size: number) => { commands: OTCommand[] } };
export type OTFont = {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  charToGlyph: (ch: string) => OTGlyph;
};

const quad = (p0: number, p1: number, p2: number, t: number) => {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
};
const cubic = (p0: number, p1: number, p2: number, p3: number, t: number) => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

/**
 * Flatten one glyph's path commands into closed contours (polygon rings) in the
 * command coordinate space. Curves are subdivided so no chord exceeds ~stepU
 * units. `M` opens a contour; `Z` (or the next `M`) closes it.
 */
export function flattenCommands(commands: OTCommand[], stepU: number): { x: number; y: number }[][] {
  const contours: { x: number; y: number }[][] = [];
  let cur: { x: number; y: number }[] = [];
  let px = 0;
  let py = 0;
  const seg = (len: number) => Math.max(2, Math.min(48, Math.ceil(len / stepU)));
  const flush = () => {
    if (cur.length >= 3) contours.push(cur);
    cur = [];
  };
  for (const c of commands) {
    if (c.type === "M") {
      flush();
      px = c.x ?? 0;
      py = c.y ?? 0;
      cur = [{ x: px, y: py }];
    } else if (c.type === "L") {
      px = c.x ?? 0;
      py = c.y ?? 0;
      cur.push({ x: px, y: py });
    } else if (c.type === "Q") {
      const ex = c.x ?? 0;
      const ey = c.y ?? 0;
      const n = seg(Math.hypot(ex - px, ey - py) + Math.hypot((c.x1 ?? 0) - px, (c.y1 ?? 0) - py));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        cur.push({ x: quad(px, c.x1 ?? 0, ex, t), y: quad(py, c.y1 ?? 0, ey, t) });
      }
      px = ex;
      py = ey;
    } else if (c.type === "C") {
      const ex = c.x ?? 0;
      const ey = c.y ?? 0;
      const n = seg(Math.hypot(ex - px, ey - py) + Math.hypot((c.x1 ?? 0) - px, (c.y1 ?? 0) - py) + Math.hypot((c.x2 ?? 0) - (c.x1 ?? 0), (c.y2 ?? 0) - (c.y1 ?? 0)));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        cur.push({ x: cubic(px, c.x1 ?? 0, c.x2 ?? 0, ex, t), y: cubic(py, c.y1 ?? 0, c.y2 ?? 0, ey, t) });
      }
      px = ex;
      py = ey;
    } else if (c.type === "Z") {
      flush();
    }
  }
  flush();
  return contours;
}

/** Cap height in font units, measured from a capital's outline bbox. */
export function capHeightUnits(font: OTFont): number {
  for (const ch of ["H", "E", "X", "I", "O"]) {
    const cmds = font.charToGlyph(ch).getPath(0, 0, font.unitsPerEm).commands;
    const rings = flattenCommands(cmds, font.unitsPerEm / 40);
    let min = Infinity;
    let max = -Infinity;
    for (const r of rings)
      for (const p of r) {
        if (p.y < min) min = p.y;
        if (p.y > max) max = p.y;
      }
    if (isFinite(min) && max > min) return max - min;
  }
  return font.ascender - font.descender || font.unitsPerEm * 0.7;
}

export type OutlineGlyph = { char: string; rings: PathMm[] };
export type OutlineLayout = { glyphs: OutlineGlyph[]; contours: PathMm[]; widthMm: number; heightMm: number };

/**
 * Lay out a line (or lines) of text in an outline font as mm geometry, y-down
 * model space, centered on the origin. Curves are flattened to ~stepMm chords.
 * `heightMm` sets the cap height. Returns per-glyph rings (for fills, holes
 * intact) and a flat contour list (for outlines).
 */
export function layoutOutlineText(
  font: OTFont,
  opts: {
    text: string;
    heightMm: number;
    letterSpacing?: number;
    lineSpacing?: number;
    stepMm?: number;
    /** Per-line justification for multi-line text (default center). */
    align?: "left" | "center" | "right";
  },
): OutlineLayout {
  const capU = capHeightUnits(font);
  const scale = opts.heightMm / capU; // font units → mm
  const stepU = Math.max(1, (opts.stepMm ?? 0.4) / scale);
  const letterSpacing = opts.letterSpacing ?? 1;
  const lineH = opts.heightMm * (opts.lineSpacing ?? 1.6);
  const lines = opts.text.split("\n");

  const glyphs: OutlineGlyph[] = [];
  const contours: PathMm[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  const align = opts.align ?? "center";
  const lineWidthsU = lines.map((line) => {
    let pen = 0;
    for (const ch of line) pen += (font.charToGlyph(ch).advanceWidth ?? capU * 0.6) * letterSpacing;
    return pen;
  });
  const maxWU = Math.max(0, ...lineWidthsU);

  lines.forEach((line, li) => {
    let penU = align === "left" ? 0 : align === "right" ? maxWU - lineWidthsU[li] : (maxWU - lineWidthsU[li]) / 2;
    const yOffMm = li * lineH; // model y-down
    for (const ch of line) {
      const glyph = font.charToGlyph(ch);
      if (ch !== " ") {
        const cmds = glyph.getPath(0, 0, font.unitsPerEm).commands;
        const raw = flattenCommands(cmds, stepU);
        const rings: PathMm[] = raw.map((r) =>
          r.map((p) => ({
            x: (penU + p.x) * scale,
            // opentype's getPath() already returns canvas-space (y-down)
            // coordinates - ascenders come out negative. That matches the
            // y-down model space directly; negating here flipped every glyph
            // upside down around its own baseline.
            y: p.y * scale + yOffMm,
          })),
        );
        if (rings.length) {
          glyphs.push({ char: ch, rings });
          for (const r of rings) {
            contours.push(r);
            for (const p of r) {
              if (p.x < minX) minX = p.x;
              if (p.x > maxX) maxX = p.x;
              if (p.y < minY) minY = p.y;
              if (p.y > maxY) maxY = p.y;
            }
          }
        }
      }
      penU += (glyph.advanceWidth ?? capU * 0.6) * letterSpacing;
    }
  });

  if (!isFinite(minX)) return { glyphs: [], contours: [], widthMm: 0, heightMm: 0 };
  // Center the whole block on the origin.
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const shift = (p: { x: number; y: number }) => ({ x: p.x - cx, y: p.y - cy });
  for (const g of glyphs) g.rings = g.rings.map((r) => r.map(shift));
  const shiftedContours = contours.map((r) => r.map(shift));

  return { glyphs, contours: shiftedContours, widthMm: maxX - minX, heightMm: maxY - minY };
}
