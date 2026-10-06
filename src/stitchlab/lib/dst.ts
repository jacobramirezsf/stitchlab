// Tajima .DST reader + writer, ported from pyembroidery (MIT) DstReader.py /
// DstWriter.py, cross-checked against libembroidery's format notes.
//
// DST on disk: 512-byte ASCII header ("XX:value\r" fields), then 3-byte
// stitch records. Each record packs dx/dy as sums of ±1/±3/±9/±27/±81
// (0.1 mm units, so max ±12.1 mm per record) plus command flags in byte 2.
// Y is stored flipped relative to our y-down model space. DST has no native
// trim (machines infer from jump runs) and cannot distinguish STOP from
// COLOR_CHANGE (both 0xC3).

import { CMD, patternBounds, type ParsedPattern, type Stitch } from "./pattern";

const bit = (b: number, pos: number) => (b >> pos) & 1;

function decodeDx(b0: number, b1: number, b2: number): number {
  return (
    bit(b2, 2) * 81 -
    bit(b2, 3) * 81 +
    bit(b1, 2) * 27 -
    bit(b1, 3) * 27 +
    bit(b0, 2) * 9 -
    bit(b0, 3) * 9 +
    bit(b1, 0) * 3 -
    bit(b1, 1) * 3 +
    bit(b0, 0) -
    bit(b0, 1)
  );
}

function decodeDy(b0: number, b1: number, b2: number): number {
  const y =
    bit(b2, 5) * 81 -
    bit(b2, 4) * 81 +
    bit(b1, 5) * 27 -
    bit(b1, 4) * 27 +
    bit(b0, 5) * 9 -
    bit(b0, 4) * 9 +
    bit(b1, 7) * 3 -
    bit(b1, 6) * 3 +
    bit(b0, 7) -
    bit(b0, 6);
  return -y; // disk is y-up; model is y-down
}

export function parseDst(buf: ArrayBuffer): ParsedPattern {
  const bytes = new Uint8Array(buf);
  if (bytes.length < 512) throw new Error("Not a DST file (shorter than the 512-byte header).");

  // Header: CR/LF-delimited "XX:value" lines. Parsed defensively - real-world
  // files sometimes contain stray bytes (libembroidery documents a known
  // missing-CR bug), so anything that doesn't look like a field is skipped.
  const meta: Record<string, string> = {};
  let name: string | null = null;
  let lineStart = 0;
  for (let i = 0; i < 512; i++) {
    if (bytes[i] === 0x0d || bytes[i] === 0x0a || i === 511) {
      const end = i === 511 ? 512 : i;
      if (end - lineStart >= 4) {
        let line = "";
        for (let j = lineStart; j < end; j++) {
          const c = bytes[j];
          if (c >= 0x20 && c < 0x7f) line += String.fromCharCode(c);
        }
        line = line.trim();
        if (line.length > 3 && line[2] === ":") {
          const key = line.slice(0, 2).trim();
          const value = line.slice(3).trim();
          if (key === "LA") name = value || null;
          else if (value) meta[key] = value;
        }
      }
      lineStart = i + 1;
    }
  }

  const stitches: Stitch[] = [];
  let x = 0;
  let y = 0;
  let sequinMode = false;
  for (let i = 512; i + 3 <= bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const dx = decodeDx(b0, b1, b2);
    const dy = decodeDy(b0, b1, b2);
    // Flag tests must run in this order (END → COLOR_CHANGE → SEQUIN → JUMP).
    if ((b2 & 0b11110011) === 0b11110011) {
      stitches.push({ x, y, cmd: CMD.END });
      break;
    } else if ((b2 & 0b11000011) === 0b11000011) {
      x += dx;
      y += dy;
      stitches.push({ x, y, cmd: CMD.COLOR_CHANGE });
    } else if ((b2 & 0b01000011) === 0b01000011) {
      x += dx;
      y += dy;
      sequinMode = !sequinMode;
      stitches.push({ x, y, cmd: CMD.SEQUIN_MODE });
    } else if ((b2 & 0b10000011) === 0b10000011) {
      x += dx;
      y += dy;
      stitches.push({ x, y, cmd: sequinMode ? CMD.SEQUIN_EJECT : CMD.JUMP });
    } else {
      x += dx;
      y += dy;
      stitches.push({ x, y, cmd: CMD.STITCH });
    }
  }
  if (stitches.length === 0 || stitches[stitches.length - 1].cmd !== CMD.END) {
    stitches.push({ x, y, cmd: CMD.END });
  }

  const colorChanges = stitches.filter((s) => s.cmd === CMD.COLOR_CHANGE).length;
  return {
    format: "dst",
    name,
    stitches,
    blockColors: new Array(colorChanges + 1).fill(null),
    meta,
  };
}

// ─── Writer ──────────────────────────────────────────────────────────────

const MAX_DELTA = 121;

function encodeRecord(dx: number, dy: number, cmd: number): [number, number, number] {
  let x = dx;
  let y = -dy; // model y-down → disk y-up
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  if (cmd === CMD.JUMP) b2 |= 1 << 7;
  if (cmd === CMD.STITCH || cmd === CMD.JUMP) {
    b2 |= 0b11;
    if (x > 40) { b2 |= 1 << 2; x -= 81; }
    if (x < -40) { b2 |= 1 << 3; x += 81; }
    if (x > 13) { b1 |= 1 << 2; x -= 27; }
    if (x < -13) { b1 |= 1 << 3; x += 27; }
    if (x > 4) { b0 |= 1 << 2; x -= 9; }
    if (x < -4) { b0 |= 1 << 3; x += 9; }
    if (x > 1) { b1 |= 1 << 0; x -= 3; }
    if (x < -1) { b1 |= 1 << 1; x += 3; }
    if (x > 0) { b0 |= 1 << 0; x -= 1; }
    if (x < 0) { b0 |= 1 << 1; x += 1; }
    if (x !== 0) throw new Error(`dx ${dx} exceeds the DST record maximum`);
    if (y > 40) { b2 |= 1 << 5; y -= 81; }
    if (y < -40) { b2 |= 1 << 4; y += 81; }
    if (y > 13) { b1 |= 1 << 5; y -= 27; }
    if (y < -13) { b1 |= 1 << 4; y += 27; }
    if (y > 4) { b0 |= 1 << 5; y -= 9; }
    if (y < -4) { b0 |= 1 << 4; y += 9; }
    if (y > 1) { b1 |= 1 << 7; y -= 3; }
    if (y < -1) { b1 |= 1 << 6; y += 3; }
    if (y > 0) { b0 |= 1 << 7; y -= 1; }
    if (y < 0) { b0 |= 1 << 6; y += 1; }
    if (y !== 0) throw new Error(`dy ${dy} exceeds the DST record maximum`);
  } else if (cmd === CMD.COLOR_CHANGE || cmd === CMD.STOP) {
    b2 = 0b11000011;
  } else if (cmd === CMD.END) {
    b2 = 0b11110011;
  }
  return [b0, b1, b2];
}

/** Split a move into chunks the 3-byte record can hold. */
function* splitDelta(dx: number, dy: number): Generator<[number, number]> {
  let steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps <= MAX_DELTA) {
    yield [dx, dy];
    return;
  }
  const n = Math.ceil(steps / MAX_DELTA);
  let px = 0;
  let py = 0;
  for (let i = 1; i <= n; i++) {
    const tx = Math.round((dx * i) / n);
    const ty = Math.round((dy * i) / n);
    yield [tx - px, ty - py];
    px = tx;
    py = ty;
  }
}

/**
 * Encode stitches (absolute 0.1 mm, y-down model space) as a .DST file.
 * Over-long moves are subdivided; needle-down over-long moves become jumps
 * ending in a stitch, matching standard writer behavior.
 */
export function writeDst(stitches: Stitch[], designName: string): Uint8Array {
  const records: number[] = [];
  let x = 0;
  let y = 0;
  let stitchCount = 0;
  let colorChanges = 0;

  for (const s of stitches) {
    if (s.cmd === CMD.END) break;
    if (s.cmd === CMD.COLOR_CHANGE || s.cmd === CMD.STOP) {
      records.push(...encodeRecord(0, 0, CMD.COLOR_CHANGE));
      colorChanges++;
      continue;
    }
    if (s.cmd !== CMD.STITCH && s.cmd !== CMD.JUMP && s.cmd !== CMD.TRIM) continue;
    const dx = Math.round(s.x) - x;
    const dy = Math.round(s.y) - y;
    const chunks = [...splitDelta(dx, dy)];
    chunks.forEach(([cx, cy], i) => {
      const last = i === chunks.length - 1;
      const cmd = s.cmd === CMD.STITCH && last ? CMD.STITCH : CMD.JUMP;
      records.push(...encodeRecord(cx, cy, cmd));
      if (cmd === CMD.STITCH) stitchCount++;
      x += cx;
      y += cy;
    });
    if (chunks.length === 0 && s.cmd === CMD.STITCH) {
      records.push(...encodeRecord(0, 0, CMD.STITCH));
      stitchCount++;
    }
  }
  records.push(...encodeRecord(0, 0, CMD.END));

  const b = patternBounds(stitches);
  const header =
    `LA:${designName.slice(0, 16).padEnd(16, " ")}\r` +
    `ST:${String(stitchCount).padStart(7, " ")}\r` +
    `CO:${String(colorChanges).padStart(3, " ")}\r` +
    `+X:${String(Math.abs(Math.round(b.maxX))).padStart(5, " ")}\r` +
    `-X:${String(Math.abs(Math.round(b.minX))).padStart(5, " ")}\r` +
    // Disk space is y-up: +Y is our min y magnitude, -Y our max.
    `+Y:${String(Math.abs(Math.round(b.minY))).padStart(5, " ")}\r` +
    `-Y:${String(Math.abs(Math.round(b.maxY))).padStart(5, " ")}\r` +
    `AX:+    0\rAY:+    0\rMX:+    0\rMY:+    0\rPD:******\r`;

  const out = new Uint8Array(512 + records.length);
  out.fill(0x20, 0, 512);
  for (let i = 0; i < header.length; i++) out[i] = header.charCodeAt(i);
  out[header.length] = 0x1a;
  out.set(records, 512);
  return out;
}
