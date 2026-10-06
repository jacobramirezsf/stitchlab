// JEF byte layout follows pyembroidery JefWriter.py (MIT; see docs/pyembroidery-LICENSE.txt).
// Input: absolute 0.1mm coordinates, y down. JEF deltas use y up.
import { CMD, type Stitch } from "./pattern";
import { JEF_PALETTE } from "./jefPalette";

function nearestColor(hex: string, exclude = -1): number {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  const rgb = [n >> 16 & 255, n >> 8 & 255, n & 255];
  let best = 1, distance = Infinity;
  JEF_PALETTE.forEach((color, i) => {
    if (!color || i === exclude) return;
    const c = Number.parseInt(color.slice(1), 16);
    const r = c >> 16 & 255, g = c >> 8 & 255, b = c & 255;
    const mean = (rgb[0] + r) / 2;
    const d = (2 + mean / 256) * (rgb[0] - r) ** 2 + 4 * (rgb[1] - g) ** 2 + (2 + (255 - mean) / 256) * (rgb[2] - b) ** 2;
    if (d < distance) { distance = d; best = i; }
  });
  return best;
}

/** Encode a Janome JEF. Long moves subdivide without changing their command type.
 * TRIM uses the conventional three zero-length jumps; machine trim behavior varies.
 * Hoop metadata describes extents but does not certify a particular machine's hoop support.
 */
export function writeJef(stitches: Stitch[], colors: string[], date = new Date()): Uint8Array {
  const stream: number[] = [];
  const palette = [nearestColor(colors[0] ?? "#000000")];
  let x = 0, y = 0, color = 0, lastColor = palette[0];
  let left = 0, right = 0, top = 0, bottom = 0;
  const emit = (tx: number, ty: number, jump: boolean) => {
    tx = Math.round(tx); ty = Math.round(ty);
    const sx = x, sy = y;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(tx - x), Math.abs(ty - y)) / 127));
    if (steps > 100000) throw new Error("JEF move is too large.");
    for (let i = 1; i <= steps; i++) {
      const nx = Math.round(sx + (tx - sx) * i / steps), ny = Math.round(sy + (ty - sy) * i / steps);
      if (jump) stream.push(0x80, 0x02);
      stream.push((nx - x) & 255, (y - ny) & 255);
      x = nx; y = ny;
      left = Math.max(left, -x); right = Math.max(right, x); top = Math.max(top, -y); bottom = Math.max(bottom, y);
    }
  };
  for (const s of stitches) {
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) throw new Error("JEF coordinates must be finite.");
    if (s.cmd === CMD.END) break;
    if (s.cmd === CMD.STITCH || s.cmd === CMD.JUMP) emit(s.x, s.y, s.cmd === CMD.JUMP);
    else if (s.cmd === CMD.COLOR_CHANGE || s.cmd === CMD.STOP) {
      if (Math.round(s.x) !== x || Math.round(s.y) !== y) emit(s.x, s.y, true);
      if (s.cmd === CMD.STOP) palette.push(0);
      else {
        const previous = colors[color] ?? "#000000";
        const next = colors[++color] ?? previous;
        let index = nearestColor(next);
        if (index === lastColor && next.toLowerCase() !== previous.toLowerCase()) index = nearestColor(next, lastColor);
        lastColor = index; palette.push(index);
      }
      stream.push(0x80, 0x01, 0, 0);
    } else if (s.cmd === CMD.TRIM) {
      for (let i = 0; i < 3; i++) stream.push(0x80, 0x02, 0, 0);
    } else throw new Error("This command cannot be represented in JEF.");
  }
  stream.push(0x80, 0x10);
  const offset = 0x74 + palette.length * 8;
  const bytes = new Uint8Array(offset + stream.length);
  const view = new DataView(bytes.buffer);
  const u32 = (at: number, value: number) => view.setInt32(at, value, true);
  u32(0, offset); u32(4, 0x14);
  const timestamp = date.toISOString().replace(/\D/g, "").slice(0, 14);
  bytes.set(new TextEncoder().encode(timestamp), 8);
  u32(24, palette.length); u32(28, stream.length / 2);
  const hw = Math.max(left, right), hh = Math.max(top, bottom);
  const hoop = hw <= 250 && hh <= 250 ? 1 : hw <= 550 && hh <= 550 ? 0 : hw <= 630 && hh <= 550 ? 3 : hw <= 700 && hh <= 1000 ? 2 : 4;
  u32(32, hoop);
  [left, top, right, bottom].forEach((v, i) => u32(36 + i * 4, v));
  [[550, 550], [250, 250], [700, 1000], [1000, 1000]].forEach(([w, h], j) => {
    const fits = hw <= w && hh <= h;
    [w - left, h - top, w - right, h - bottom].forEach((v, i) => u32(52 + j * 16 + i * 4, fits ? v : -1));
  });
  palette.forEach((v, i) => { u32(116 + i * 4, v); u32(116 + palette.length * 4 + i * 4, 0x0d); });
  bytes.set(stream, offset);
  return bytes;
}
