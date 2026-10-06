// Brother .PES / .PEC reader, ported from pyembroidery (MIT) PesReader.py /
// PecReader.py. PES is a container: the stitches always live in an embedded
// PEC block, so we read the PEC pointer at offset 8 and skip the
// version-specific PES headers entirely (v1 through v10 all work this way -
// the same shortcut njcrawford/EmbroideryReader uses). Colors come from PEC's
// 1-byte indices into the fixed 64-color Brother palette, so they are
// approximations of the real thread, not true RGB.

import { CMD, type ParsedPattern, type Stitch } from "./pattern";
import { PEC_PALETTE } from "./palette";

const JUMP_CODE = 0x10;
const TRIM_CODE = 0x20;
const FLAG_LONG = 0x80;

function signed12(b: number): number {
  b &= 0xfff;
  return b > 0x7ff ? -0x1000 + b : b;
}

function signed7(b: number): number {
  return b > 63 ? -128 + b : b;
}

class Cursor {
  bytes: Uint8Array;
  pos: number;
  constructor(bytes: Uint8Array, pos = 0) {
    this.bytes = bytes;
    this.pos = pos;
  }
  u8(): number | null {
    return this.pos < this.bytes.length ? this.bytes[this.pos++] : null;
  }
  u24le(): number | null {
    const a = this.u8();
    const b = this.u8();
    const c = this.u8();
    if (a === null || b === null || c === null) return null;
    return a | (b << 8) | (c << 16);
  }
  u32le(at: number): number {
    return new DataView(this.bytes.buffer, this.bytes.byteOffset).getUint32(at, true);
  }
  ascii(n: number): string {
    let s = "";
    for (let i = 0; i < n && this.pos < this.bytes.length; i++, this.pos++) {
      const c = this.bytes[this.pos];
      if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c);
    }
    return s;
  }
  skip(n: number) {
    this.pos += n;
  }
}

export function parsePes(buf: ArrayBuffer): ParsedPattern {
  const bytes = new Uint8Array(buf);
  const cur = new Cursor(bytes);
  const signature = cur.ascii(8);

  if (signature.startsWith("#PEC")) {
    return readPec(cur, "pec");
  }
  if (!signature.startsWith("#PES")) {
    throw new Error("Not a PES/PEC file (bad signature).");
  }
  const pecBlockPosition = cur.u32le(8);
  if (pecBlockPosition <= 0 || pecBlockPosition >= bytes.length) {
    throw new Error("PES file has an invalid PEC block pointer.");
  }
  cur.pos = pecBlockPosition;
  const pattern = readPec(cur, "pes");
  pattern.meta.pesVersion = signature.slice(4);
  return pattern;
}

function readPec(cur: Cursor, format: "pes" | "pec"): ParsedPattern {
  cur.skip(3); // "LA:"
  const name = cur.ascii(16).trim() || null;
  cur.skip(0x0f);
  cur.skip(2); // thumbnail byte stride + icon height
  cur.skip(0x0c);
  const colorChangesByte = cur.u8();
  if (colorChangesByte === null) throw new Error("Truncated PEC block.");
  // 0xFF means zero colors; otherwise count = changes + 1.
  const countColors = colorChangesByte === 0xff ? 0 : colorChangesByte + 1;
  const paletteIndices: number[] = [];
  for (let i = 0; i < countColors; i++) {
    const v = cur.u8();
    if (v === null) throw new Error("Truncated PEC palette.");
    paletteIndices.push(v);
  }
  cur.skip(0x1d0 - (colorChangesByte === 0xff ? 0 : colorChangesByte));
  cur.u24le(); // stitch block length (we read to the END marker instead)
  cur.skip(0x0b);

  const stitches: Stitch[] = [];
  let x = 0;
  let y = 0;
  for (;;) {
    let val1 = cur.u8();
    let val2 = cur.u8();
    if (val1 === null || val2 === null || (val1 === 0xff && val2 === 0x00)) break;
    if (val1 === 0xfe && val2 === 0xb0) {
      cur.skip(1);
      stitches.push({ x, y, cmd: CMD.COLOR_CHANGE });
      continue;
    }
    let jump = false;
    let trim = false;
    let dx: number;
    if (val1 & FLAG_LONG) {
      if (val1 & TRIM_CODE) trim = true;
      if (val1 & JUMP_CODE) jump = true;
      dx = signed12((val1 << 8) | val2);
      val2 = cur.u8();
      if (val2 === null) break;
    } else {
      dx = signed7(val1);
    }
    let dy: number;
    if (val2 & FLAG_LONG) {
      if (val2 & TRIM_CODE) trim = true;
      if (val2 & JUMP_CODE) jump = true;
      const val3 = cur.u8();
      if (val3 === null) break;
      dy = signed12((val2 << 8) | val3);
    } else {
      dy = signed7(val2);
    }
    if (trim) stitches.push({ x, y, cmd: CMD.TRIM });
    x += dx;
    y += dy;
    stitches.push({ x, y, cmd: jump || trim ? CMD.JUMP : CMD.STITCH });
  }
  stitches.push({ x, y, cmd: CMD.END });

  const blockColors = paletteIndices.map((idx) => {
    const entry = PEC_PALETTE[idx % PEC_PALETTE.length];
    return entry ? entry.hex : null;
  });
  if (blockColors.length === 0) blockColors.push(null);

  return { format, name, stitches, blockColors, meta: {} };
}
