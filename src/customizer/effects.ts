// Design effects for the Lab - canvas transforms applied to an uploaded
// design, producing a new PNG data URL. The set is drawn from the tools
// Jacob collects on are.na (halftone makers, ditherit, pixelators, etc.),
// rebuilt small so they run inline on any upload.

export type EffectId =
  | "silhouette"
  | "grain"
  | "halftone"
  | "dither"
  | "pixelate"
  | "posterize"
  | "invert"
  | "outline";

export const EFFECTS: { id: EffectId; label: string; hint: string }[] = [
  { id: "silhouette", label: "Silhouette", hint: "solid one-color shape - great for cutting and recoloring" },
  { id: "grain", label: "Grain", hint: "film-grain texture over the artwork" },
  { id: "halftone", label: "Halftone", hint: "luminance dots on a grid" },
  { id: "dither", label: "Dither", hint: "1-bit ordered dither" },
  { id: "pixelate", label: "Pixelate", hint: "chunky pixel grid" },
  { id: "posterize", label: "Posterize", hint: "flatten to 3 levels per channel" },
  { id: "invert", label: "Invert", hint: "flip lights and darks" },
  { id: "outline", label: "Outline", hint: "edges only, line-art style" },
];

const load = (src: string) =>
  new Promise<HTMLImageElement>((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });

function toCanvas(img: HTMLImageElement, maxSide = 1600) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * scale));
  c.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return { c, ctx };
}

const lum = (d: Uint8ClampedArray, i: number) =>
  0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

export async function applyEffect(dataURL: string, effect: EffectId): Promise<string> {
  const img = await load(dataURL);
  const { c, ctx } = toCanvas(img);
  const { width: w, height: h } = c;

  if (effect === "pixelate") {
    const block = Math.max(4, Math.round(Math.max(w, h) / 48));
    const small = document.createElement("canvas");
    small.width = Math.max(1, Math.round(w / block));
    small.height = Math.max(1, Math.round(h / block));
    const sctx = small.getContext("2d")!;
    sctx.drawImage(c, 0, 0, small.width, small.height);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, w, h);
    return c.toDataURL("image/png");
  }

  const image = ctx.getImageData(0, 0, w, h);
  const d = image.data;

  if (effect === "silhouette") {
    // Solid one-color shape. If the image already has real transparency, the
    // alpha IS the shape. Otherwise threshold luminance with Otsu so the dark
    // subject fills solid against a cleared background.
    let clear = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 30) clear++;
    const hasAlpha = clear / (d.length / 4) > 0.02;
    if (hasAlpha) {
      for (let i = 0; i < d.length; i += 4) {
        const keep = d[i + 3] >= 30;
        d[i] = d[i + 1] = d[i + 2] = 17;
        d[i + 3] = keep ? 255 : 0;
      }
    } else {
      // Otsu threshold over the luminance histogram
      const hist = new Array<number>(256).fill(0);
      for (let i = 0; i < d.length; i += 4) hist[Math.round(lum(d, i))]++;
      const total = d.length / 4;
      let sum = 0;
      for (let t = 0; t < 256; t++) sum += t * hist[t];
      let sumB = 0, wB = 0, best = 127, bestVar = -1;
      for (let t = 0; t < 256; t++) {
        wB += hist[t];
        if (!wB) continue;
        const wF = total - wB;
        if (!wF) break;
        sumB += t * hist[t];
        const mB = sumB / wB;
        const mF = (sum - sumB) / wF;
        const v = wB * wF * (mB - mF) * (mB - mF);
        if (v > bestVar) {
          bestVar = v;
          best = t;
        }
      }
      for (let i = 0; i < d.length; i += 4) {
        const keep = lum(d, i) < best;
        d[i] = d[i + 1] = d[i + 2] = 17;
        d[i + 3] = keep ? 255 : 0;
      }
    }
    ctx.putImageData(image, 0, 0);
    return c.toDataURL("image/png");
  }

  if (effect === "grain") {
    // speckled film grain, only where the artwork exists
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 30) continue;
      const n = (Math.random() - 0.5) * 84;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
      if (Math.random() < 0.04) d[i + 3] = Math.max(0, d[i + 3] - 190); // pinholes
    }
    ctx.putImageData(image, 0, 0);
    return c.toDataURL("image/png");
  }

  if (effect === "invert") {
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      d[i] = 255 - d[i];
      d[i + 1] = 255 - d[i + 1];
      d[i + 2] = 255 - d[i + 2];
    }
    ctx.putImageData(image, 0, 0);
    return c.toDataURL("image/png");
  }

  if (effect === "posterize") {
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      for (let ch = 0; ch < 3; ch++) {
        d[i + ch] = Math.round(d[i + ch] / 127.5) * 127.5;
      }
    }
    ctx.putImageData(image, 0, 0);
    return c.toDataURL("image/png");
  }

  if (effect === "dither") {
    // 4×4 Bayer ordered dither → opaque pixels become pure black or clear
    const bayer = [
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5],
    ];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (d[i + 3] < 30) continue;
        const threshold = ((bayer[y % 4][x % 4] + 0.5) / 16) * 255;
        const dark = lum(d, i) < threshold;
        d[i] = d[i + 1] = d[i + 2] = 0;
        d[i + 3] = dark ? 255 : 0;
      }
    }
    ctx.putImageData(image, 0, 0);
    return c.toDataURL("image/png");
  }

  if (effect === "halftone") {
    const cell = Math.max(6, Math.round(Math.max(w, h) / 70));
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const octx = out.getContext("2d")!;
    octx.fillStyle = "#111111";
    for (let cy = 0; cy < h; cy += cell) {
      for (let cx = 0; cx < w; cx += cell) {
        let total = 0;
        let alpha = 0;
        let n = 0;
        for (let y = cy; y < Math.min(cy + cell, h); y += 2) {
          for (let x = cx; x < Math.min(cx + cell, w); x += 2) {
            const i = (y * w + x) * 4;
            total += lum(d, i);
            alpha += d[i + 3];
            n++;
          }
        }
        if (!n || alpha / n < 30) continue;
        const darkness = 1 - total / n / 255;
        const r = (darkness * cell) / 1.9;
        if (r < 0.4) continue;
        octx.beginPath();
        octx.arc(cx + cell / 2, cy + cell / 2, r, 0, Math.PI * 2);
        octx.fill();
      }
    }
    return out.toDataURL("image/png");
  }

  if (effect === "outline") {
    // Sobel edge magnitude on luminance+alpha → black lines on transparent
    const g = new Float32Array(w * h);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      g[p] = d[i + 3] < 30 ? 255 : lum(d, i);
    }
    const out = ctx.createImageData(w, h);
    const o = out.data;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        const gx =
          -g[p - w - 1] - 2 * g[p - 1] - g[p + w - 1] +
          g[p - w + 1] + 2 * g[p + 1] + g[p + w + 1];
        const gy =
          -g[p - w - 1] - 2 * g[p - w] - g[p - w + 1] +
          g[p + w - 1] + 2 * g[p + w] + g[p + w + 1];
        const mag = Math.sqrt(gx * gx + gy * gy);
        const i = p * 4;
        if (mag > 90) {
          o[i] = o[i + 1] = o[i + 2] = 17;
          o[i + 3] = 255;
        }
      }
    }
    ctx.clearRect(0, 0, w, h);
    ctx.putImageData(out, 0, 0);
    return c.toDataURL("image/png");
  }

  return dataURL;
}
