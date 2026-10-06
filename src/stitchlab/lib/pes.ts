// Brother .PES / .PEC writer, ported from pyembroidery (MIT) PecWriter.py /
// PesWriter.py / PecGraphics.py. PES is a container whose stitches live in an
// embedded PEC block; we emit a truncated PES v1 (`#PES0001` + a 22-byte
// pointer header + the PEC block), which every reader from PE-Design on down
// accepts. The PEC block carries a 1-byte palette index per color into the
// fixed 64-color Brother machine palette (no true RGB), plus the required
// thumbnail bitmaps. Coordinates are 0.1 mm, y-down - the same model space our
// Stitch[] already uses, and (unlike DST) PEC stores y-down, so no flip.
//
// Validated by round-tripping through parsePes (our PecReader port).

import { CMD, patternBounds, type Stitch } from "./pattern";
import { PEC_PALETTE } from "./palette";

// ─── Color → Brother palette index (red-mean, no reuse) ──────────────────

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
// Perceptual-ish "redmean" distance pyembroidery uses for palette matching.
function redMean(a: [number, number, number], b: [number, number, number]): number {
  const rm = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
}
function nearestIndex(rgb: [number, number, number], chart: (([number, number, number]) | null)[]): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < chart.length; i++) {
    const c = chart[i];
    if (!c) continue;
    const d = redMean(rgb, c);
    if (d <= bd) { bd = d; best = i; }
  }
  return best;
}

/** One PEC palette index per color block (pyembroidery build_unique_palette). */
export function buildUniquePalette(colorHexes: string[]): number[] {
  const paletteRgb: (([number, number, number]) | null)[] = PEC_PALETTE.map((e) => (e ? hexRgb(e.hex) : null));
  const chart: (([number, number, number]) | null)[] = new Array(PEC_PALETTE.length).fill(null);
  // Assign each distinct requested color to a unique nearest palette slot.
  const seen = new Set<string>();
  for (const hex of colorHexes) {
    if (seen.has(hex)) continue;
    seen.add(hex);
    const idx = nearestIndex(hexRgb(hex), paletteRgb);
    if (paletteRgb[idx] == null) break;
    chart[idx] = paletteRgb[idx];
    paletteRgb[idx] = null; // may not be reused
  }
  // Each block → nearest index among the assigned chart entries.
  return colorHexes.map((hex) => nearestIndex(hexRgb(hex), chart));
}

// ─── Byte sink ───────────────────────────────────────────────────────────

class Bytes {
  data: number[] = [];
  u8(v: number) { this.data.push(v & 0xff); }
  u16(v: number) { this.data.push(v & 0xff, (v >> 8) & 0xff); }
  u24(v: number) { this.data.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff); }
  u32(v: number) { this.data.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff); }
  str(s: string) { for (let i = 0; i < s.length; i++) this.data.push(s.charCodeAt(i) & 0xff); }
  raw(arr: number[]) { for (const b of arr) this.data.push(b & 0xff); }
  get length() { return this.data.length; }
}

// ─── PEC stitch encoding ─────────────────────────────────────────────────

const MASK_07 = 0b01111111;
const JUMP_CODE = 0b00010000;
const TRIM_CODE = 0b00100000;

function writeValue(out: Bytes, value: number, long: boolean, flag: number) {
  if (!long && value > -64 && value < 63) {
    out.u8(value & MASK_07);
  } else {
    let v = value & 0b0000111111111111;
    v |= 0b1000000000000000;
    v |= flag << 8;
    out.u8((v >> 8) & 0xff);
    out.u8(v & 0xff);
  }
}

/** Encode absolute-coordinate stitches into the PEC delta stream. Long moves
 *  are split so no delta exceeds the 12-bit (±2047) record limit. */
function pecEncode(out: Bytes, stitches: Stitch[]) {
  let xx = 0;
  let yy = 0;
  let colorTwo = true;
  let jumping = true;
  let init = true;
  const MAX = 2047;

  const step = (tx: number, ty: number, kind: "stitch" | "jump" | "trimjump") => {
    // split long absolute moves into ≤MAX chunks (as jumps), then the final
    let dx = Math.round(tx) - xx;
    let dy = Math.round(ty) - yy;
    while (Math.abs(dx) > MAX || Math.abs(dy) > MAX) {
      const sx = Math.max(-MAX, Math.min(MAX, dx));
      const sy = Math.max(-MAX, Math.min(MAX, dy));
      writeValue(out, sx, true, JUMP_CODE);
      writeValue(out, sy, true, JUMP_CODE);
      xx += sx; yy += sy;
      dx = Math.round(tx) - xx; dy = Math.round(ty) - yy;
    }
    if (kind === "stitch") {
      const lng = false;
      writeValue(out, dx, lng, 0);
      writeValue(out, dy, lng, 0);
    } else if (kind === "jump") {
      writeValue(out, dx, true, JUMP_CODE);
      writeValue(out, dy, true, JUMP_CODE);
    } else {
      writeValue(out, dx, true, TRIM_CODE);
      writeValue(out, dy, true, TRIM_CODE);
    }
    xx += dx; yy += dy;
  };

  for (const s of stitches) {
    const cmd = s.cmd;
    if (cmd === CMD.STITCH) {
      if (jumping) {
        // a 0,0 stitch seats the needle after a jump when both deltas moved
        if (Math.round(s.x) - xx !== 0 && Math.round(s.y) - yy !== 0) step(xx, yy, "stitch");
        jumping = false;
      }
      step(s.x, s.y, "stitch");
    } else if (cmd === CMD.JUMP || cmd === CMD.TRIM) {
      jumping = true;
      step(s.x, s.y, init ? "jump" : "trimjump");
    } else if (cmd === CMD.COLOR_CHANGE || cmd === CMD.STOP) {
      if (jumping) { step(xx, yy, "stitch"); jumping = false; }
      out.u8(0xfe); out.u8(0xb0);
      out.u8(colorTwo ? 0x02 : 0x01);
      colorTwo = !colorTwo;
    } else if (cmd === CMD.END) {
      out.u8(0xff);
      break;
    }
    init = false;
  }
}

// ─── PEC thumbnail bitmaps (48×38, 6-byte stride) ────────────────────────

// The border template pyembroidery ships (get_blank): a 6×38 framed rectangle.
const BLANK: number[] = [
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x08, 0x00, 0x00, 0x00, 0x00, 0x10,
  0x04, 0x00, 0x00, 0x00, 0x00, 0x20, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x02, 0x00, 0x00, 0x00, 0x00, 0x40,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x40, 0x04, 0x00, 0x00, 0x00, 0x00, 0x20, 0x08, 0x00, 0x00, 0x00, 0x00, 0x10,
  0xf0, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];
const STRIDE = 6;
const ICON_H = 38;
const ICON_W = 48;

function markBit(g: number[], x: number, y: number) {
  if (x < 0 || x >= ICON_W || y < 0 || y >= ICON_H) return;
  g[y * STRIDE + (x >> 3)] |= 1 << (x & 7);
}
function drawScaled(bounds: { minX: number; minY: number; maxX: number; maxY: number }, pts: Stitch[], g: number[], buffer: number) {
  const dw = Math.max(1, bounds.maxX - bounds.minX);
  const dh = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min((ICON_W - buffer) / dw, (ICON_H - buffer) / dh);
  const cx = (bounds.maxX + bounds.minX) / 2;
  const cy = (bounds.maxY + bounds.minY) / 2;
  const tx = -cx * scale + ICON_W / 2;
  const ty = -cy * scale + ICON_H / 2;
  for (const p of pts) markBit(g, Math.floor(p.x * scale + tx), Math.floor(p.y * scale + ty));
}

// ─── Assemble PEC + PES ──────────────────────────────────────────────────

function writePecBlock(out: Bytes, stitches: Stitch[], colorHexes: string[]) {
  const name = "Untitled";
  // header
  out.str("LA:" + name.slice(0, 16).padEnd(16, " ") + "\r");
  out.raw([0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0xff, 0x00]);
  out.u8(ICON_W / 8); // stride
  out.u8(ICON_H);
  const idx = buildUniquePalette(colorHexes);
  const count = idx.length;
  if (count !== 0) {
    out.raw([0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20]);
    out.u8((count - 1) & 0xff); // color changes
    for (const i of idx) out.u8(i & 0xff);
    for (let i = count; i < 463; i++) out.u8(0x20);
  } else {
    out.raw([0x20, 0x20, 0x20, 0x20, 0x64, 0x20, 0x00, 0x20, 0x00, 0x20, 0x20, 0x20, 0xff]);
    for (let i = 0; i < 463; i++) out.u8(0x20);
  }

  // stitch block (with a back-patched length)
  const bounds = patternBounds(stitches);
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const blockStart = out.length;
  out.u16(0x0000);
  out.u24(0); // length placeholder
  out.raw([0x31, 0xff, 0xf0]);
  out.u16(Math.round(width));
  out.u16(Math.round(height));
  out.u16(0x1e0);
  out.u16(0x1b0);
  pecEncode(out, stitches);
  const blockLen = out.length - blockStart;
  out.data[blockStart + 2] = blockLen & 0xff;
  out.data[blockStart + 3] = (blockLen >> 8) & 0xff;
  out.data[blockStart + 4] = (blockLen >> 16) & 0xff;

  // graphics: one overall thumbnail, then one per color block
  const overall = BLANK.slice();
  drawScaled(bounds, stitches.filter((s) => s.cmd === CMD.STITCH), overall, 4);
  out.raw(overall);
  // per-color-block stitch groups
  let block: Stitch[] = [];
  const flush = () => { const g = BLANK.slice(); drawScaled(bounds, block.filter((s) => s.cmd === CMD.STITCH), g, 5); out.raw(g); block = []; };
  for (const s of stitches) {
    if (s.cmd === CMD.COLOR_CHANGE || s.cmd === CMD.STOP) { flush(); continue; }
    if (s.cmd === CMD.END) break;
    block.push(s);
  }
  flush();
}

/** Write a truncated PES v1 file (with embedded PEC) for these stitches. */
export function writePes(stitches: Stitch[], colorHexes: string[], _name = "bayside"): Uint8Array {
  const out = new Bytes();
  out.str("#PES0001");
  // 22-byte pointer header: PEC block begins at offset 0x16 (=22).
  out.raw([0x16, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  writePecBlock(out, stitches, colorHexes.length ? colorHexes : ["#000000"]);
  return new Uint8Array(out.data);
}
