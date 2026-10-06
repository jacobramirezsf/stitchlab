// Structure-tensor orientation field (Bigün & Granlund lineage) - the cheap,
// closed-form way to ask an image "which way does the texture run here, and
// how sure are you?" Averaging tensor *components* under a Gaussian (never
// angles) sidesteps the 180° ambiguity that wrecks naive angle averaging.
//
// theta      - fiber/edge direction (perpendicular to the gradient), radians
//              in [-π/2, π/2). Lay long-short "thread painting" stitches
//              along theta; set fill angles from region-averaged tensors.
// coherence  - (λmax−λmin)/(λmax+λmin) ∈ [0,1]: 1 = strongly oriented,
//              0 = isotropic (don't trust theta there; fall back to tatami).

export type LumImage = { w: number; h: number; lum: Float32Array };

export type OrientationField = {
  w: number;
  h: number;
  theta: Float32Array;
  coherence: Float32Array;
};

/** Separable Gaussian blur, reflective edges. */
function blurInPlace(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0) return src;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const tmp = new Float32Array(src.length);
  const reflect = (v: number, n: number) => (v < 0 ? -v : v >= n ? 2 * n - v - 2 : v);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += kernel[k + radius] * src[y * w + reflect(x + k, w)];
      tmp[y * w + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += kernel[k + radius] * tmp[reflect(y + k, h) * w + x];
      src[y * w + x] = acc;
    }
  }
  return src;
}

/**
 * Compute the orientation field at integration scale sigmaPx (2–8 px typical:
 * small = fine local texture, large = broad strokes).
 */
export function orientationField(img: LumImage, sigmaPx = 4): OrientationField {
  const { w, h, lum } = img;
  const n = w * h;
  const jxx = new Float32Array(n);
  const jxy = new Float32Array(n);
  const jyy = new Float32Array(n);

  const at = (x: number, y: number) =>
    lum[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Sobel
      const gx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) -
        at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const gy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) -
        at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      const i = y * w + x;
      jxx[i] = gx * gx;
      jxy[i] = gx * gy;
      jyy[i] = gy * gy;
    }
  }
  blurInPlace(jxx, w, h, sigmaPx);
  blurInPlace(jxy, w, h, sigmaPx);
  blurInPlace(jyy, w, h, sigmaPx);

  const theta = new Float32Array(n);
  const coherence = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const gradAngle = 0.5 * Math.atan2(2 * jxy[i], jxx[i] - jyy[i]);
    // Fiber direction = gradient + 90°, wrapped to [-π/2, π/2)
    let t = gradAngle + Math.PI / 2;
    if (t >= Math.PI / 2) t -= Math.PI;
    theta[i] = t;
    const tr = jxx[i] + jyy[i];
    const det = Math.sqrt(Math.max(0, (jxx[i] - jyy[i]) ** 2 + 4 * jxy[i] * jxy[i]));
    coherence[i] = tr > 1e-12 ? det / tr : 0;
  }
  return { w, h, theta, coherence };
}

/**
 * Average orientation over a set of pixel indices - tensor-averaged, so
 * opposing directions reinforce instead of cancelling. Returns the fiber
 * angle in radians plus mean coherence. Use for per-region fill angles.
 */
export function regionOrientation(
  field: OrientationField,
  indices: Iterable<number>,
): { thetaRad: number; coherence: number } {
  // Rebuild tensor components from theta/coherence in double-angle space.
  let sx = 0;
  let sy = 0;
  let cSum = 0;
  let count = 0;
  for (const i of indices) {
    const twoTheta = 2 * field.theta[i];
    const wgt = field.coherence[i];
    sx += Math.cos(twoTheta) * wgt;
    sy += Math.sin(twoTheta) * wgt;
    cSum += field.coherence[i];
    count++;
  }
  if (count === 0) return { thetaRad: 0, coherence: 0 };
  return { thetaRad: Math.atan2(sy, sx) / 2, coherence: cSum / count };
}
