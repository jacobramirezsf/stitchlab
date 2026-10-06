// PNG density tagging. Canvas toBlob() writes PNGs with no physical density;
// print tools then assume 72 PPI. This stamps a pHYs chunk (pixels-per-meter)
// right after IHDR so a 300 PPI export opens at its true physical size.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Return a copy of `png` with a pHYs chunk declaring `ppi`. */
export function tagPngPpi(png: Uint8Array, ppi: number): Uint8Array {
  // signature (8) + IHDR chunk (4 len + 4 type + 13 data + 4 crc) = 33 bytes
  const insertAt = 33;
  if (png.length < insertAt || png[12] !== 0x49 /* I */) return png;
  const ppm = Math.round(ppi / 0.0254);
  const chunk = new Uint8Array(4 + 4 + 9 + 4);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9); // data length
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  chunk[16] = 1; // unit: meter
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, insertAt), 0);
  out.set(chunk, insertAt);
  out.set(png.subarray(insertAt), insertAt + chunk.length);
  return out;
}

/** Canvas → PNG blob tagged at `ppi`. */
export async function canvasToPngPpi(c: HTMLCanvasElement, ppi: number): Promise<Blob> {
  const blob = await new Promise<Blob>((res, rej) =>
    c.toBlob((b) => (b ? res(b) : rej(new Error("png"))), "image/png"),
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return new Blob([new Uint8Array(tagPngPpi(bytes, ppi))], { type: "image/png" });
}

/** Pixels for `mm` at `ppi` (300 PPI ≈ 11.81 px/mm). */
export const mmToPx = (mm: number, ppi: number): number => Math.round((mm / 25.4) * ppi);
