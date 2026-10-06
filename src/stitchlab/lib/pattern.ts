// Stitch Lab - shared stitch-pattern model.
//
// Model space follows pyembroidery's conventions so ported readers/writers
// stay literal: coordinates are absolute, in 0.1 mm machine units, y-down
// (screen-like). DST stores y-up on disk; its reader/writer flips.
//
// Format knowledge ported from pyembroidery (MIT, EmbroidePy/tatarize) and
// cross-checked against libembroidery (zlib). Thanks to both projects.

export const CMD = {
  STITCH: 0,
  JUMP: 1,
  TRIM: 2,
  STOP: 3,
  END: 4,
  COLOR_CHANGE: 5,
  SEQUIN_MODE: 6,
  SEQUIN_EJECT: 7,
} as const;

export type Cmd = (typeof CMD)[keyof typeof CMD];

export type Stitch = {
  x: number; // absolute, 0.1 mm units
  y: number; // absolute, 0.1 mm units, y-down
  cmd: Cmd;
};

export type ParsedPattern = {
  format: "dst" | "pes" | "pec";
  /** Design name from the file header, when present. */
  name: string | null;
  stitches: Stitch[];
  /**
   * One entry per color block. Hex like "#0a55a3" when the file carries
   * color info (PES/PEC via the Brother palette); null when it doesn't (DST).
   */
  blockColors: (string | null)[];
  meta: Record<string, string>;
};

export type ColorBlock = {
  index: number;
  /** Stitches in this block (all commands, in order). */
  stitches: Stitch[];
  /** Needle-down stitches only. */
  stitchCount: number;
  colorHex: string | null;
};

/** Split a pattern into color blocks at COLOR_CHANGE/STOP boundaries. */
export function colorBlocks(p: ParsedPattern): ColorBlock[] {
  const blocks: ColorBlock[] = [];
  let current: Stitch[] = [];
  let index = 0;
  const push = () => {
    if (current.some((s) => s.cmd === CMD.STITCH)) {
      blocks.push({
        index,
        stitches: current,
        stitchCount: current.filter((s) => s.cmd === CMD.STITCH).length,
        colorHex: p.blockColors[index] ?? null,
      });
      index++;
    }
  };
  for (const s of p.stitches) {
    if (s.cmd === CMD.COLOR_CHANGE || s.cmd === CMD.STOP) {
      current.push(s);
      push();
      current = [];
      continue;
    }
    current.push(s);
  }
  push();
  return blocks;
}

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

/** Bounds over needle-down stitches (falls back to all moves), 0.1 mm units. */
export function patternBounds(stitches: Stitch[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let sawStitch = false;
  for (const pass of [true, false]) {
    for (const s of stitches) {
      if (s.cmd === CMD.END) continue;
      if (pass && s.cmd !== CMD.STITCH) continue;
      if (s.x < minX) minX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.x > maxX) maxX = s.x;
      if (s.y > maxY) maxY = s.y;
      sawStitch = true;
    }
    if (sawStitch) break;
  }
  if (!sawStitch) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}
