// Shared GIF encoding with an optional byte cap (Are.na allows <=25MB).
// Pure browser module - no React, no tool imports - so any tool chunk can
// pull it without dragging the Animator along.

/** Encode a GIF, optionally fitted under a byte cap (Are.na allows ≤25MB).
 *  Strategy preserves crispness: first thin frames (longer delays keep the
 *  duration), and only shrink resolution as a last resort. Returns the bytes
 *  plus a note describing any adjustment. */
export async function encodeGifFit(
  drawNative: (i: number) => CanvasImageSource,
  nativeW: number, nativeH: number, frames: number, delayMs: number, transparent: boolean,
  capBytes: number | null, onProgress: (m: string) => void, isCancelled?: () => boolean,
): Promise<{ bytes: Uint8Array; note: string | null }> {
  const { GIFEncoder, quantize, applyPalette } = await import("gifenc");
  const format = transparent ? "rgba4444" : "rgb565";
  const attempt = async (step: number, scale: number): Promise<Uint8Array> => {
    const w = Math.max(64, Math.round(nativeW * scale)), h = Math.max(64, Math.round(nativeH * scale));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    const gif = GIFEncoder();
    let count = 0;
    for (let i = 0; i < frames; i += step) count++;
    let done = 0;
    for (let i = 0; i < frames; i += step) {
      if (isCancelled?.()) throw new Error("cancelled");
      if (done % 6 === 0) { onProgress(`Encoding ${done + 1}/${count}…`); await new Promise((r) => setTimeout(r, 0)); }
      done++;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(drawNative(i), 0, 0, w, h);
      const { data } = ctx.getImageData(0, 0, w, h);
      const palette = quantize(data, 256, { format, oneBitAlpha: transparent });
      gif.writeFrame(applyPalette(data, palette, format), w, h, { palette, delay: Math.round(delayMs * step), transparent });
    }
    gif.finish();
    return new Uint8Array(gif.bytes());
  };
  let step = 1, scale = 1;
  let bytes = await attempt(step, scale);
  if (!capBytes || bytes.length <= capBytes) return { bytes, note: null };
  // 1) thin frames, duration preserved
  step = Math.min(3, Math.ceil(bytes.length / capBytes));
  onProgress("Over the cap - thinning frames…");
  bytes = await attempt(step, scale);
  if (bytes.length <= capBytes) return { bytes, note: `fit under cap: every ${step}${step === 2 ? "nd" : "rd"} frame, full resolution` };
  // 2) shrink resolution
  for (let tries = 0; tries < 3 && bytes.length > capBytes; tries++) {
    scale *= Math.max(0.6, Math.sqrt(capBytes / bytes.length) * 0.97);
    onProgress(`Still over - scaling to ${Math.round(nativeW * scale)}px…`);
    bytes = await attempt(step, scale);
  }
  return { bytes, note: `fit under cap: ${Math.round(nativeW * scale)}px wide, every ${step} frame(s)` };
}
