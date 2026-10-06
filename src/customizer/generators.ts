// Generative design sources for the Lab — small rebuilds of the generator
// tools on the studio are.na channels (fffuel's SVG makers, Space Type
// Generator). Every run returns a fresh random variant, drawn in near-black
// so thread recolor and blend passes treat it like any upload.

const INK = "#111111";
const TAU = Math.PI * 2;
const SIZE = 1200;

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const randInt = (lo: number, hi: number) => Math.round(rand(lo, hi));
// coin flip weighted to `p` true; and uniform pick from a list
const chance = (p = 0.5) => Math.random() < p;
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

function makeCanvas(w = SIZE, h = SIZE) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = INK;
  ctx.strokeStyle = INK;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  return { c, ctx };
}

// Crop to the inked bounding box (+pad) so placement inches are honest.
function trim(c: HTMLCanvasElement, pad = 30) {
  const ctx = c.getContext("2d")!;
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let minX = c.width, minY = c.height, maxX = 0, maxY = 0;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (data[(y * c.width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX <= minX || maxY <= minY) return { dataURL: c.toDataURL("image/png"), aspect: c.height / c.width };
  const w = maxX - minX + 1 + pad * 2;
  const h = maxY - minY + 1 + pad * 2;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d")!.drawImage(c, minX - pad, minY - pad, w, h, 0, 0, w, h);
  return { dataURL: out.toDataURL("image/png"), aspect: h / w };
}

export type GeneratorId =
  | "blob"
  | "burst"
  | "badge"
  | "rings"
  | "waves"
  | "scribble"
  | "dots"
  | "star"
  | "flower"
  | "spiral"
  | "zigzag"
  | "frame"
  | "arch"
  | "grid"
  | "paisley"
  | "wreath"
  | "bolt"
  | "heart"
  | "moon"
  | "eye"
  | "flame"
  | "smiley"
  | "orbit"
  | "arrow"
  | "fruit"
  | "compass"
  | "constellation"
  | "chain"
  | "dither"
  | "pixelframe"
  | "oswindow"
  | "wireship"
  | "mosaic";

export const GENERATORS: { id: GeneratorId; label: string; hint: string }[] = [
  { id: "blob", label: "Blob", hint: "organic blob shape" },
  { id: "burst", label: "Burst", hint: "sunburst rays" },
  { id: "badge", label: "Badge", hint: "scalloped patch ring" },
  { id: "rings", label: "Rings", hint: "concentric arcs" },
  { id: "waves", label: "Waves", hint: "stacked wave lines" },
  { id: "scribble", label: "Scribble", hint: "one-line scribble" },
  { id: "dots", label: "Dots", hint: "dot fields & halftones" },
  { id: "star", label: "Star", hint: "star or sparkle" },
  { id: "flower", label: "Flower", hint: "petal rosette" },
  { id: "spiral", label: "Spiral", hint: "hand-drawn spiral" },
  { id: "zigzag", label: "Zigzag", hint: "stacked zigzag lines" },
  { id: "frame", label: "Frame", hint: "decorative border" },
  { id: "arch", label: "Arch", hint: "arches & rainbows" },
  { id: "grid", label: "Grid", hint: "plaid & crosshatch" },
  { id: "paisley", label: "Paisley", hint: "teardrop paisley" },
  { id: "wreath", label: "Wreath", hint: "laurels & mark rings" },
  { id: "bolt", label: "Bolt", hint: "lightning strikes" },
  { id: "heart", label: "Heart", hint: "hearts, pierced & broken" },
  { id: "moon", label: "Moon", hint: "crescents & phases" },
  { id: "eye", label: "Eye", hint: "eyes & evil eyes" },
  { id: "flame", label: "Flame", hint: "licks of fire" },
  { id: "smiley", label: "Smiley", hint: "round faces" },
  { id: "orbit", label: "Orbit", hint: "atoms & planets" },
  { id: "arrow", label: "Arrow", hint: "fletched arrows" },
  { id: "fruit", label: "Fruit", hint: "cherries & citrus" },
  { id: "compass", label: "Compass", hint: "nautical roses" },
  { id: "constellation", label: "Stars", hint: "connected night sky" },
  { id: "chain", label: "Chain", hint: "linked rings" },
  // "browser is already a game engine" channel — dither/pixel/vector-era tools
  { id: "dither", label: "Dither", hint: "ordered-dither shading" },
  { id: "pixelframe", label: "Pixel border", hint: "9-patch pixel frames" },
  { id: "oswindow", label: "Window", hint: "retro OS chrome" },
  { id: "wireship", label: "Rocket", hint: "vector-game wireframes" },
  { id: "mosaic", label: "Mosaic", hint: "pixel-block patchwork" },
];

// ── shared drawing helpers ───────────────────────────────────────────────

// filled star/sparkle polygon centered at (cx,cy)
function starPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  points: number,
  outer: number,
  inner: number,
  rot: number,
  round: boolean
) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / (points * 2)) * TAU - Math.PI / 2 + rot;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else if (round) {
      const pa = ((i - 0.5) / (points * 2)) * TAU - Math.PI / 2 + rot;
      const pr = inner * 0.72;
      ctx.quadraticCurveTo(cx + pr * Math.cos(pa), cy + pr * Math.sin(pa), x, y);
    } else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// a single teardrop/paisley leaf pointing along +x, drawn at the origin
function leafPath(ctx: CanvasRenderingContext2D, len: number, fat: number, hook = 0) {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(len * 0.35, -fat, len * (0.9 + hook * 0.2), -fat * hook * 0.4);
  ctx.quadraticCurveTo(len * 1.05, 0, len * (0.9 + hook * 0.2), fat * (0.6 + hook));
  ctx.quadraticCurveTo(len * 0.35, fat, 0, 0);
  ctx.closePath();
}

// draw one small mark used by dots/wreath: dot, ring, star, cross, leaf, square
type Mark = "dot" | "ring" | "star" | "cross" | "leaf" | "square" | "diamond";
function drawMark(ctx: CanvasRenderingContext2D, kind: Mark, r: number, rot = 0) {
  ctx.save();
  ctx.rotate(rot);
  if (kind === "dot") {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();
  } else if (kind === "ring") {
    ctx.lineWidth = Math.max(3, r * 0.34);
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.82, 0, TAU);
    ctx.stroke();
  } else if (kind === "star") {
    starPath(ctx, 0, 0, 5, r, r * 0.44, 0, false);
    ctx.fill();
  } else if (kind === "cross") {
    ctx.lineWidth = Math.max(3, r * 0.4);
    ctx.beginPath();
    ctx.moveTo(-r, 0);
    ctx.lineTo(r, 0);
    ctx.moveTo(0, -r);
    ctx.lineTo(0, r);
    ctx.stroke();
  } else if (kind === "leaf") {
    leafPath(ctx, r * 1.9, r * 0.75, 0.3);
    ctx.fill();
  } else if (kind === "square") {
    ctx.fillRect(-r * 0.8, -r * 0.8, r * 1.6, r * 1.6);
  } else if (kind === "diamond") {
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r, 0);
    ctx.lineTo(0, r);
    ctx.lineTo(-r, 0);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// knock a circular hole in whatever has been drawn
function punch(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// parametric heart centered at origin, half-width ~r; jitter loosens the lobes
function heartPath(ctx: CanvasRenderingContext2D, r: number, jitter = 0) {
  const j = (f: number) => f * (1 + rand(-jitter, jitter));
  ctx.beginPath();
  ctx.moveTo(0, r * 0.95);
  ctx.bezierCurveTo(-r * j(1.6), -r * j(0.1), -r * j(0.9), -r * j(1.1), 0, -r * 0.38);
  ctx.bezierCurveTo(r * j(0.9), -r * j(1.1), r * j(1.6), -r * j(0.1), 0, r * 0.95);
  ctx.closePath();
}

// classic 7-point lightning bolt pointing down, centered, height h
function boltPath(ctx: CanvasRenderingContext2D, h: number, w: number, jitter = 0.12) {
  const j = (f: number) => f + rand(-jitter, jitter);
  ctx.beginPath();
  ctx.moveTo(w * j(-0.12), -h / 2);
  ctx.lineTo(w * j(0.5), -h / 2);
  ctx.lineTo(w * j(0.08), h * j(-0.08));
  ctx.lineTo(w * j(0.42), h * j(-0.06));
  ctx.lineTo(w * j(-0.38), h / 2);
  ctx.lineTo(w * j(-0.02), h * j(0.1));
  ctx.lineTo(w * j(-0.48), h * j(0.08));
  ctx.closePath();
}


export function runGenerator(id: GeneratorId): { dataURL: string; aspect: number } {
  const { c, ctx } = makeCanvas();
  const cx = SIZE / 2;
  const cy = SIZE / 2;

  if (id === "blob") {
    // mode sets the harmonic character: round, lumpy, spiky, or pinched
    const mode = pick(["round", "lumpy", "spiky", "pinched"] as const);
    const spec = {
      round: { harm: [2, 3] as const, amp: [0.04, 0.1] as const, freq: [2, 4] as const },
      lumpy: { harm: [3, 5] as const, amp: [0.08, 0.18] as const, freq: [3, 7] as const },
      spiky: { harm: [4, 7] as const, amp: [0.12, 0.26] as const, freq: [6, 12] as const },
      pinched: { harm: [2, 4] as const, amp: [0.14, 0.3] as const, freq: [2, 3] as const },
    }[mode];
    const drawBlob = (bx: number, by: number, R: number) => {
      const waves = Array.from({ length: randInt(spec.harm[0], spec.harm[1]) }, () => ({
        a: rand(spec.amp[0], spec.amp[1]),
        n: randInt(spec.freq[0], spec.freq[1]),
        p: rand(0, TAU),
      }));
      ctx.beginPath();
      for (let i = 0; i <= 260; i++) {
        const t = (i / 260) * TAU;
        const r = R * (1 + waves.reduce((s, w) => s + w.a * Math.sin(w.n * t + w.p), 0));
        const x = bx + r * Math.cos(t);
        const y = by + r * Math.sin(t);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    };
    const clusters = chance(0.35) ? randInt(2, 3) : 1;
    for (let k = 0; k < clusters; k++) {
      const off = clusters === 1 ? 0 : rand(120, 230);
      const ang = rand(0, TAU);
      drawBlob(cx + Math.cos(ang) * off, cy + Math.sin(ang) * off, rand(240, 380) / (clusters > 1 ? 1.3 : 1));
    }
    if (clusters === 1 && chance(0.3)) punch(ctx, cx, cy, rand(80, 180)); // ring blob
    if (chance(0.25)) {
      // outline-only: keep just a thick rim
      punch(ctx, cx, cy, 320);
    }
    if (clusters === 1 && chance(0.3)) {
      // splat: satellite droplets flung off the body
      for (let i = 0; i < randInt(3, 7); i++) {
        const a = rand(0, TAU);
        const d = rand(340, 480);
        ctx.beginPath();
        ctx.ellipse(cx + d * Math.cos(a), cy + d * Math.sin(a), rand(16, 46), rand(10, 30), a, 0, TAU);
        ctx.fill();
      }
    }
    if (clusters === 1 && chance(0.18)) {
      // eclipse: a crescent bite out of one side
      const a = rand(0, TAU);
      punch(ctx, cx + 200 * Math.cos(a), cy + 200 * Math.sin(a), rand(180, 280));
    }
  }

  if (id === "burst") {
    // distinct ray systems so re-rolls read differently, never a solid disc
    const rayKind = pick(["needle", "wedge", "petal", "pinwheel", "spike"] as const);
    // needles pack tight; wedges/petals stay sparse enough to keep gaps
    const n =
      rayKind === "needle" ? randInt(24, 80) :
      rayKind === "pinwheel" ? randInt(6, 14) :
      randInt(9, 22);
    const r0 = rayKind === "pinwheel" ? rand(0, 60) : rand(0, 150);
    const r1 = rand(470, 570);
    const rot = rand(0, TAU);
    const alt = rayKind !== "pinwheel" && chance(0.45); // alternate long/short
    const skew = rayKind === "pinwheel" ? rand(0.4, 1.0) : 0; // swept blades
    const wobble = chance(0.3) ? rand(0, 40) : 0; // ragged tips
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rot;
      const long = !alt || i % 2 === 0;
      const tip = (long ? r1 : r1 * rand(0.45, 0.68)) + rand(-wobble, wobble);
      const w = (TAU / n) * (long ? rand(0.3, 0.5) : rand(0.18, 0.32));
      if (rayKind === "needle" || rayKind === "spike") {
        ctx.lineWidth = rayKind === "spike" ? rand(10, 22) : rand(3, 9);
        ctx.beginPath();
        ctx.moveTo(cx + r0 * Math.cos(a), cy + r0 * Math.sin(a));
        ctx.lineTo(cx + tip * Math.cos(a), cy + tip * Math.sin(a));
        ctx.stroke();
      } else if (rayKind === "petal") {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(a);
        leafPath(ctx, tip, tip * rand(0.08, 0.16), 0);
        ctx.fill();
        ctx.restore();
      } else if (rayKind === "pinwheel") {
        // curved swept blade
        ctx.beginPath();
        ctx.moveTo(cx + r0 * Math.cos(a), cy + r0 * Math.sin(a));
        const midA = a + skew * 0.5;
        const tipA = a + skew;
        ctx.quadraticCurveTo(
          cx + tip * 0.6 * Math.cos(midA), cy + tip * 0.6 * Math.sin(midA),
          cx + tip * Math.cos(tipA), cy + tip * Math.sin(tipA)
        );
        ctx.quadraticCurveTo(
          cx + tip * 0.55 * Math.cos(midA - w), cy + tip * 0.55 * Math.sin(midA - w),
          cx + r0 * Math.cos(a - w * 0.4), cy + r0 * Math.sin(a - w * 0.4)
        );
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(cx + r0 * Math.cos(a - w / 2), cy + r0 * Math.sin(a - w / 2));
        ctx.lineTo(cx + r0 * Math.cos(a + w / 2), cy + r0 * Math.sin(a + w / 2));
        ctx.lineTo(cx + tip * Math.cos(a), cy + tip * Math.sin(a));
        ctx.closePath();
        ctx.fill();
      }
    }
    // center hub: filled dot, ring, or hollow
    const hub = pick(["dot", "ring", "star", "none"] as const);
    const hr = r0 > 40 ? r0 * rand(0.6, 0.95) : rand(55, 130);
    if (hub === "dot") { ctx.beginPath(); ctx.arc(cx, cy, hr, 0, TAU); ctx.fill(); }
    else if (hub === "ring") { ctx.lineWidth = rand(10, 24); ctx.beginPath(); ctx.arc(cx, cy, hr, 0, TAU); ctx.stroke(); }
    else if (hub === "star") { starPath(ctx, cx, cy, randInt(5, 8), hr, hr * 0.45, rot, false); ctx.fill(); }
  }

  if (id === "badge") {
    const R = rand(500, 560);
    const rim = pick(["scallop", "point", "gear", "rope", "wave", "plain"] as const);
    // frequency + depth are fixed per badge (bug fix: previously re-rolled
    // every degree, which shredded the edge into noise)
    const n = randInt(10, 26);
    const depth = rand(26, 70);
    const edgeR = (t: number): number => {
      if (rim === "scallop") return R - depth * (0.5 + 0.5 * Math.cos(n * t));
      if (rim === "wave") return R - depth * 0.5 * (1 + Math.sin(n * t));
      if (rim === "point") {
        // even triangular teeth: distance to nearest tooth crest
        const saw = Math.abs((((n * t) / TAU) % 1) - 0.5) * 2; // 0..1 triangle
        return R - depth * saw;
      }
      if (rim === "gear") {
        // square castellations
        return R - (Math.cos(n * t) > 0 ? 0 : depth);
      }
      return R;
    };
    ctx.beginPath();
    const steps = 720;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * TAU;
      const r = edgeR(t);
      const x = cx + r * Math.cos(t);
      const y = cy + r * Math.sin(t);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    if (rim === "rope") {
      // stud the outer edge with beads
      const studs = randInt(22, 44);
      const br = rand(10, 16);
      for (let i = 0; i < studs; i++) {
        const a = (i / studs) * TAU;
        ctx.beginPath();
        ctx.arc(cx + (R + br * 0.4) * Math.cos(a), cy + (R + br * 0.4) * Math.sin(a), br, 0, TAU);
        ctx.fill();
      }
    }
    // knock out the middle to leave a patch-border ring
    const trough = R - depth;
    const bandW = rand(55, 120);
    punch(ctx, cx, cy, trough - bandW);
    // inner detailing on the punched field
    const inner = trough - bandW - rand(18, 55);
    const detail = pick(["keyline", "double", "dotted", "stars", "ticks", "none"] as const);
    if (detail === "keyline") {
      ctx.lineWidth = rand(8, 16);
      ctx.beginPath();
      ctx.arc(cx, cy, inner, 0, TAU);
      ctx.stroke();
    } else if (detail === "double") {
      for (const rr of [inner, inner - rand(24, 40)]) {
        ctx.lineWidth = rand(6, 12);
        ctx.beginPath();
        ctx.arc(cx, cy, rr, 0, TAU);
        ctx.stroke();
      }
    } else if (detail === "ticks") {
      const m = randInt(24, 48);
      ctx.lineWidth = rand(5, 10);
      for (let i = 0; i < m; i++) {
        const a = (i / m) * TAU;
        ctx.beginPath();
        ctx.moveTo(cx + inner * Math.cos(a), cy + inner * Math.sin(a));
        ctx.lineTo(cx + (inner - rand(16, 30)) * Math.cos(a), cy + (inner - rand(16, 30)) * Math.sin(a));
        ctx.stroke();
      }
    } else if (detail === "dotted" || detail === "stars") {
      const m = randInt(10, 22);
      for (let i = 0; i < m; i++) {
        const a = (i / m) * TAU;
        ctx.save();
        ctx.translate(cx + inner * Math.cos(a), cy + inner * Math.sin(a));
        drawMark(ctx, detail === "stars" ? "star" : "dot", rand(10, 20), a);
        ctx.restore();
      }
    }
    // sometimes a device in the very center
    if (chance(0.4)) {
      const dev = pick(["star", "ring", "dot"] as const);
      if (dev === "star") { starPath(ctx, cx, cy, randInt(5, 8), inner * rand(0.4, 0.6), inner * rand(0.18, 0.28), rand(0, TAU), false); ctx.fill(); }
      else if (dev === "ring") { ctx.lineWidth = rand(10, 20); ctx.beginPath(); ctx.arc(cx, cy, inner * rand(0.35, 0.5), 0, TAU); ctx.stroke(); }
      else { ctx.beginPath(); ctx.arc(cx, cy, inner * rand(0.2, 0.32), 0, TAU); ctx.fill(); }
    }
  }

  if (id === "rings") {
    const style = pick(["solid", "arc", "dashed", "dotted", "orbit", "target"] as const);
    if (style === "orbit") {
      // gyroscope: rotated ellipse orbits
      const m = randInt(3, 6);
      ctx.lineWidth = rand(10, 22);
      for (let i = 0; i < m; i++) {
        ctx.beginPath();
        ctx.ellipse(cx, cy, rand(360, 540), rand(90, 260), (i / m) * Math.PI + rand(-0.15, 0.15), 0, TAU);
        ctx.stroke();
      }
      if (chance(0.5)) {
        ctx.beginPath();
        ctx.arc(cx, cy, rand(40, 90), 0, TAU);
        ctx.fill();
      }
    } else if (style === "target") {
      // solid concentric target bands
      let rr = rand(430, 540);
      while (rr > 60) {
        ctx.beginPath();
        ctx.arc(cx, cy, rr, 0, TAU);
        ctx.fill();
        const band = rand(45, 105);
        punch(ctx, cx, cy, rr - band);
        rr -= band + rand(45, 105);
      }
    }
    const n = style === "orbit" || style === "target" ? 0 : randInt(3, 9);
    let r = rand(50, 120);
    for (let i = 0; i < n && r < 560; i++) {
      const lw = rand(8, 40);
      ctx.lineWidth = lw;
      if (style === "dotted") {
        const m = Math.round((TAU * r) / rand(40, 80));
        for (let k = 0; k < m; k++) {
          const a = (k / m) * TAU;
          ctx.beginPath();
          ctx.arc(cx + r * Math.cos(a), cy + r * Math.sin(a), lw * 0.5, 0, TAU);
          ctx.fill();
        }
      } else {
        if (style === "dashed") ctx.setLineDash([rand(30, 70), rand(20, 50)]);
        const start = style === "arc" ? rand(0, TAU) : 0;
        const span = style === "arc" ? rand(0.4, 0.95) * TAU : TAU;
        ctx.beginPath();
        ctx.arc(cx, cy, r, start, start + span);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      r += lw / 2 + rand(34, 90);
    }
    if (chance(0.3)) {
      ctx.beginPath();
      ctx.arc(cx, cy, rand(20, 45), 0, TAU);
      ctx.fill();
    }
  }

  if (id === "waves") {
    const wmode = pick(["classic", "classic", "crest", "interference"] as const);
    if (wmode === "crest") {
      // curling ocean crests: offset rows of scallop arcs
      const rows2 = randInt(4, 8);
      const rr = (SIZE - 260) / (rows2 * 2);
      ctx.lineWidth = rand(10, 18);
      for (let row = 0; row < rows2; row++) {
        const y = 170 + row * rr * 2;
        const off = row % 2 ? rr : 0;
        for (let x = 130 + off; x < SIZE - 130; x += rr * 2) {
          ctx.beginPath();
          ctx.arc(x, y, rr, Math.PI, TAU);
          ctx.stroke();
          if (chance(0.22)) {
            // curl the lip of this crest
            ctx.beginPath();
            ctx.arc(x + rr * 0.55, y - rr * 0.4, rr * 0.45, Math.PI * 0.9, Math.PI * 1.9);
            ctx.stroke();
          }
        }
      }
    } else if (wmode === "interference") {
      // two wave sets crossing at a shallow angle — moiré fabric feel
      for (const ang of [rand(-0.28, -0.1), rand(0.1, 0.28)]) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(ang);
        const rows2 = randInt(5, 9);
        const amp2 = rand(18, 40);
        const freq2 = rand(2, 4);
        ctx.lineWidth = rand(6, 12);
        for (let row = 0; row < rows2; row++) {
          const y0 = -SIZE / 2 + 150 + (row / (rows2 - 1)) * (SIZE - 300);
          ctx.beginPath();
          let first = true;
          for (let x = -SIZE / 2 + 110; x <= SIZE / 2 - 110; x += 8) {
            const y = y0 + amp2 * Math.sin((x / SIZE) * TAU * freq2 + row);
            first ? (ctx.moveTo(x, y), (first = false)) : ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        ctx.restore();
      }
    } else {
    const vertical = chance(0.3);
    const rows = randInt(5, 14);
    const baseAmp = rand(16, 58);
    const freq = rand(1.2, 4.5);
    const phaseStep = rand(0, 1.6);
    const envelope = chance(0.4); // amplitude packet across the width
    const taper = chance(0.35); // amplitude grows/shrinks down the rows
    const filled = chance(0.28); // filled bands instead of lines
    ctx.lineWidth = rand(7, 20);
    for (let row = 0; row < rows; row++) {
      const rowAmp = baseAmp * (taper ? 0.3 + (row / rows) * 1.4 : 1);
      const y0 = 120 + (row / Math.max(1, rows - 1)) * (SIZE - 240);
      const trace = (yBase: number) => {
        let first = true;
        for (let x = 80; x <= SIZE - 80; x += 6) {
          const env = envelope ? Math.sin((x / SIZE) * Math.PI) : 1;
          const off = rowAmp * env * Math.sin((x / SIZE) * TAU * freq + row * phaseStep);
          const px = vertical ? yBase + off : x;
          const py = vertical ? x : yBase + off;
          if (first) (ctx.moveTo(px, py), (first = false));
          else ctx.lineTo(px, py);
        }
      };
      if (filled) {
        ctx.beginPath();
        trace(y0);
        ctx.lineTo(vertical ? y0 : SIZE - 80, vertical ? SIZE - 80 : y0 + baseAmp * 2.2);
        ctx.lineTo(vertical ? y0 : 80, vertical ? 80 : y0 + baseAmp * 2.2);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        trace(y0);
        ctx.stroke();
      }
    }
    }
  }

  if (id === "scribble") {
    const smode = pick(["free", "free", "tornado", "hatch"] as const);
    if (smode === "tornado") {
      // coiled scribble spiraling outward
      ctx.lineWidth = rand(10, 18);
      ctx.beginPath();
      const turns = rand(3, 5.5);
      for (let a = 0; a < turns * TAU; a += 0.08) {
        const rr = 55 + (a / (turns * TAU)) * rand(380, 460) + rand(-16, 16);
        const x = cx + rr * Math.cos(a);
        const y = cy + rr * Math.sin(a) * rand(0.96, 1.04);
        a === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else if (smode === "hatch") {
      // loose parallel hand-strokes at an angle
      const ang = rand(0, Math.PI);
      const m = randInt(8, 16);
      ctx.lineWidth = rand(10, 20);
      for (let i = 0; i < m; i++) {
        const off = (i - m / 2) * rand(46, 62);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(ang);
        ctx.beginPath();
        ctx.moveTo(-rand(300, 430), off + rand(-14, 14));
        ctx.quadraticCurveTo(0, off + rand(-40, 40), rand(300, 430), off + rand(-14, 14));
        ctx.stroke();
        ctx.restore();
      }
    } else {
    const strokes = randInt(1, 3);
    const loopy = chance(0.4);
    for (let s = 0; s < strokes; s++) {
      const pts = Array.from({ length: randInt(7, 16) }, () => ({
        x: rand(140, SIZE - 140),
        y: rand(140, SIZE - 140),
      }));
      ctx.lineWidth = rand(9, 24);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      if (loopy) {
        // bezier through points for rounder loop-de-loops
        for (let i = 1; i < pts.length - 1; i++) {
          const c1x = pts[i].x + rand(-90, 90);
          const c1y = pts[i].y + rand(-90, 90);
          ctx.quadraticCurveTo(c1x, c1y, pts[i + 1].x, pts[i + 1].y);
        }
      } else {
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = (pts[i].x + pts[i + 1].x) / 2;
          const my = (pts[i].y + pts[i + 1].y) / 2;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
        }
      }
      if (chance(0.3)) ctx.closePath();
      ctx.stroke();
    }
    }
  }

  if (id === "dots") {
    const layout = pick(["square", "hex", "jitter", "radial", "phyllo", "phyllo"] as const);
    const falloff = pick(["radial", "linear", "ring", "flat"] as const);
    const mark: Mark = pick(["dot", "dot", "dot", "ring", "diamond", "cross"] as const);
    const cols = randInt(10, 22);
    const cell = (SIZE - 200) / cols;
    const fx = rand(150, SIZE - 150);
    const fy = rand(150, SIZE - 150);
    const maxDist = Math.hypot(SIZE, SIZE) * rand(0.45, 0.85);
    const maxR = cell * rand(0.3, 0.5);
    const pow = rand(0.8, 2.4);
    const ringR = rand(0.25, 0.5) * SIZE;
    const lin = rand(0, TAU);
    if (layout === "phyllo") {
      // sunflower spiral: golden-angle placement, size drifts along the spiral
      const N = randInt(160, 320);
      const GA = Math.PI * (3 - Math.sqrt(5));
      const spread = rand(15, 19);
      const grow = chance(0.5);
      for (let i = 0; i < N; i++) {
        const rr = spread * Math.sqrt(i);
        if (rr > SIZE / 2 - 90) break;
        const a = i * GA;
        ctx.save();
        ctx.translate(cx + rr * Math.cos(a), cy + rr * Math.sin(a));
        drawMark(ctx, mark, Math.max(3, maxR * (grow ? i / N : 1 - i / N) + 5), a);
        ctx.restore();
      }
    } else if (layout === "radial") {
      const rings = randInt(4, 9);
      for (let ri = 1; ri <= rings; ri++) {
        const rr = (ri / rings) * (SIZE / 2 - 90);
        const m = Math.max(1, Math.round((TAU * rr) / (cell * 0.9)));
        for (let k = 0; k < m; k++) {
          const a = (k / m) * TAU;
          const x = cx + rr * Math.cos(a);
          const y = cy + rr * Math.sin(a);
          const rad = maxR * (1 - ri / (rings + 1)) ** (pow * 0.4) + maxR * 0.2;
          ctx.save();
          ctx.translate(x, y);
          drawMark(ctx, mark, Math.max(2, rad));
          ctx.restore();
        }
      }
    } else {
      for (let gy = 0; gy <= cols; gy++) {
        for (let gx = 0; gx <= cols; gx++) {
          let x = 100 + gx * cell + (layout === "hex" && gy % 2 ? cell / 2 : 0);
          let y = 100 + gy * cell;
          if (layout === "jitter") {
            x += rand(-cell * 0.3, cell * 0.3);
            y += rand(-cell * 0.3, cell * 0.3);
          }
          if (x > SIZE - 60) continue;
          let f: number;
          if (falloff === "radial") f = Math.max(0, 1 - Math.hypot(x - fx, y - fy) / maxDist) ** pow;
          else if (falloff === "linear")
            f = Math.max(0, Math.min(1, 0.5 + 0.5 * Math.cos(lin) * ((x - cx) / SIZE) + 0.5 * Math.sin(lin) * ((y - cy) / SIZE)));
          else if (falloff === "ring")
            f = Math.max(0, 1 - Math.abs(Math.hypot(x - cx, y - cy) - ringR) / (ringR * 0.6));
          else f = 1;
          const r = maxR * f;
          if (r < 2) continue;
          ctx.save();
          ctx.translate(x, y);
          drawMark(ctx, mark, r);
          ctx.restore();
        }
      }
    }
  }

  if (id === "star") {
    const mode = pick(["classic", "sparkle", "burststar", "outline", "nested", "shooting"] as const);
    if (mode === "shooting") {
      const R2 = rand(200, 290);
      const sx = cx + rand(120, 220);
      const sy = cy - rand(60, 160);
      starPath(ctx, sx, sy, pick([4, 5] as const), R2, R2 * rand(0.4, 0.5), rand(0, TAU), chance(0.5));
      ctx.fill();
      // motion trails streaking down-left
      const ta = Math.PI * rand(0.72, 0.85);
      for (let i = 0; i < 3; i++) {
        const off = (i - 1) * R2 * 0.45;
        const ox = sx + Math.cos(ta + Math.PI / 2) * off - Math.cos(ta) * R2 * 0.8;
        const oy = sy + Math.sin(ta + Math.PI / 2) * off - Math.sin(ta) * R2 * 0.8;
        ctx.lineWidth = rand(16, 26) - i * 4;
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(ox + Math.cos(ta) * rand(-560, -380) * -1, oy + Math.sin(ta) * rand(380, 560));
        ctx.stroke();
      }
    } else {
    const points = mode === "sparkle" ? 4 : randInt(5, 12);
    const outer = rand(500, 560);
    const inner = outer * (mode === "sparkle" ? rand(0.16, 0.3) : mode === "burststar" ? rand(0.35, 0.6) : rand(0.32, 0.52));
    const rot = rand(0, TAU);
    const round = mode === "sparkle" || chance(0.3);
    starPath(ctx, cx, cy, points, outer, inner, rot, round);
    if (mode === "outline") {
      ctx.fill();
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      starPath(ctx, cx, cy, points, outer - rand(40, 70), inner - rand(30, 55), rot, round);
      ctx.fill();
      ctx.restore();
    } else {
      ctx.fill();
      if (mode === "nested") {
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        starPath(ctx, cx, cy, points, outer * 0.62, inner * 0.62, rot, round);
        ctx.fill();
        ctx.restore();
        starPath(ctx, cx, cy, points, outer * 0.4, inner * 0.4, rot, round);
        ctx.fill();
      }
    }
    // sparkle: add tiny satellite sparkles
    if (mode === "sparkle" && chance(0.6)) {
      for (let k = 0; k < randInt(1, 3); k++) {
        const a = rand(0, TAU);
        const d = rand(360, 520);
        starPath(ctx, cx + d * Math.cos(a), cy + d * Math.sin(a), 4, rand(50, 110), rand(14, 30), rot, true);
        ctx.fill();
      }
    }
    }
  }

  if (id === "flower") {
    const petals = randInt(4, 14);
    const shape = pick(["ellipse", "teardrop", "pointed", "rounded"] as const);
    const layers = chance(0.4) ? 2 : 1;
    const drawRing = (len: number, wid: number, phase: number) => {
      for (let i = 0; i < petals; i++) {
        const a = (i / petals) * TAU + phase;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(a);
        if (shape === "ellipse") {
          ctx.beginPath();
          ctx.ellipse(len / 2 + 60, 0, len / 2, wid, 0, 0, TAU);
          ctx.fill();
        } else if (shape === "rounded") {
          ctx.beginPath();
          ctx.roundRect?.(60, -wid, len, wid * 2, wid);
          if (!ctx.roundRect) ctx.rect(60, -wid, len, wid * 2);
          ctx.fill();
        } else {
          // teardrop / pointed leaf
          leafPath(ctx, len + 60, wid, shape === "pointed" ? 0 : 0.5);
          ctx.fill();
        }
        ctx.restore();
      }
    };
    const petalLen = rand(300, 470);
    const petalWid = (TAU / petals) * rand(0.3, 0.7) * 90;
    drawRing(petalLen, petalWid, 0);
    if (layers === 2) drawRing(petalLen * rand(0.5, 0.72), petalWid * 0.7, Math.PI / petals);
    // center treatment
    const cr = rand(50, 120);
    const centre = pick(["dot", "ring", "seeds", "hole"] as const);
    if (centre === "hole") punch(ctx, cx, cy, cr);
    else if (centre === "ring") {
      punch(ctx, cx, cy, cr);
      ctx.beginPath();
      ctx.arc(cx, cy, cr * 0.55, 0, TAU);
      ctx.fill();
    } else if (centre === "seeds") {
      punch(ctx, cx, cy, cr);
      const s = randInt(6, 12);
      for (let i = 0; i < s; i++) {
        const a = (i / s) * TAU;
        ctx.beginPath();
        ctx.arc(cx + cr * 0.5 * Math.cos(a), cy + cr * 0.5 * Math.sin(a), rand(8, 16), 0, TAU);
        ctx.fill();
      }
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy, cr, 0, TAU);
      ctx.fill();
    }
    if (petalLen < 380 && chance(0.35)) {
      // put the head on a stem with a leaf or two
      ctx.lineWidth = rand(18, 28);
      ctx.beginPath();
      ctx.moveTo(cx, cy + petalLen * 0.9);
      ctx.quadraticCurveTo(cx + rand(-60, 60), cy + petalLen + 200, cx, SIZE - 70);
      ctx.stroke();
      for (const s of [-1, 1]) {
        if (chance(0.3)) continue;
        ctx.save();
        ctx.translate(cx, cy + petalLen + rand(150, 260));
        ctx.rotate(s > 0 ? rand(-0.9, -0.5) : -Math.PI + rand(0.5, 0.9));
        leafPath(ctx, rand(120, 190), rand(40, 60), 0.2);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  if (id === "spiral") {
    const mode = pick(["archimedean", "log", "square", "double"] as const);
    const wobble = rand(0, 16);
    ctx.lineWidth = rand(12, 32);
    const drawSpiral = (dir: number, phase: number) => {
      if (mode === "square") {
        // rectangular spiral of segments
        let x = cx;
        let y = cy;
        let len = rand(30, 55);
        let ang = phase;
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let i = 0; i < randInt(14, 26); i++) {
          x += Math.cos(ang) * len * dir;
          y += Math.sin(ang) * len * dir;
          ctx.lineTo(x, y);
          ang += Math.PI / 2;
          len += rand(24, 40);
          if (Math.hypot(x - cx, y - cy) > 560) break;
        }
        ctx.stroke();
        return;
      }
      const turns = rand(2.5, 5.5);
      const b = mode === "log" ? rand(0.14, 0.24) : 0;
      const growth = 520 / (turns * TAU);
      ctx.beginPath();
      for (let a = 0; a <= turns * TAU; a += 0.05) {
        const r =
          (mode === "log" ? 22 * Math.exp(b * a) : growth * a) + rand(-wobble, wobble);
        if (r > 560) break;
        const x = cx + r * Math.cos(a * dir + phase);
        const y = cy + r * Math.sin(a * dir + phase);
        a === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    drawSpiral(1, 0);
    if (mode === "double") drawSpiral(1, Math.PI);
  }

  if (id === "zigzag") {
    const mode = pick(["lines", "filled", "chevron", "herringbone", "lattice"] as const);
    const rows = randInt(3, 10);
    const teeth = randInt(5, 16);
    const amp = rand(28, 90);
    ctx.lineWidth = rand(9, 24);
    const step = (SIZE - 200) / teeth;
    if (mode === "herringbone") {
      const cell = (SIZE - 160) / randInt(5, 9);
      for (let y = 80; y < SIZE - 80; y += cell) {
        for (let x = 80; x < SIZE - 80; x += cell) {
          ctx.beginPath();
          const up = ((x / cell) | 0) % 2 === 0;
          ctx.moveTo(x, up ? y + cell : y);
          ctx.lineTo(x + cell / 2, up ? y : y + cell);
          ctx.lineTo(x + cell, up ? y + cell : y);
          ctx.stroke();
        }
      }
    } else if (mode === "lattice") {
      // diamond lattice of crossing diagonals, clipped to a square
      const cell2 = (SIZE - 240) / randInt(4, 8);
      ctx.lineWidth = rand(8, 16);
      ctx.save();
      ctx.beginPath();
      ctx.rect(120, 120, SIZE - 240, SIZE - 240);
      ctx.clip();
      for (let d = -(SIZE - 240); d < (SIZE - 240) * 2; d += cell2) {
        ctx.beginPath();
        ctx.moveTo(120 + d, 120);
        ctx.lineTo(120 + d + (SIZE - 240), SIZE - 120);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(120 + d, 120);
        ctx.lineTo(120 + d - (SIZE - 240), SIZE - 120);
        ctx.stroke();
      }
      ctx.restore();
    } else {
      for (let row = 0; row < rows; row++) {
        const y0 = 140 + (row / Math.max(1, rows - 1)) * (SIZE - 280);
        const rowAmp = mode === "chevron" ? amp * (1 + row * 0.04) : amp;
        ctx.beginPath();
        for (let t = 0; t <= teeth; t++) {
          const x = 100 + t * step;
          const y = y0 + (t % 2 === 0 ? -rowAmp : rowAmp);
          t === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        if (mode === "filled") {
          ctx.lineTo(SIZE - 100, y0 + amp * 2.4);
          ctx.lineTo(100, y0 + amp * 2.4);
          ctx.closePath();
          ctx.fill();
        } else ctx.stroke();
      }
    }
  }

  if (id === "frame") {
    const shape = pick(["rect", "round", "circle", "archtop", "stamp"] as const);
    const w = rand(0.6, 1) * (SIZE - 240);
    const h = shape === "circle" ? w : rand(0.55, 1) * (SIZE - 240);
    const x0 = cx - w / 2;
    const y0 = cy - h / 2;
    if (shape === "stamp") {
      // postage stamp: filled block, perforated edges, hollow middle
      ctx.fillRect(x0, y0, w, h);
      const per = rand(36, 50);
      for (let x = x0; x <= x0 + w + 1; x += per) {
        punch(ctx, x, y0, per * 0.38);
        punch(ctx, x, y0 + h, per * 0.38);
      }
      for (let y = y0; y <= y0 + h + 1; y += per) {
        punch(ctx, x0, y, per * 0.38);
        punch(ctx, x0 + w, y, per * 0.38);
      }
      const band = rand(70, 130);
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillRect(x0 + band, y0 + band, w - band * 2, h - band * 2);
      ctx.restore();
      if (chance(0.5)) {
        ctx.lineWidth = rand(6, 12);
        ctx.strokeRect(x0 + band + 20, y0 + band + 20, w - band * 2 - 40, h - band * 2 - 40);
      }
      return trim(c);
    }
    const bands = randInt(1, 3);
    let inset = 0;
    for (let i = 0; i < bands; i++) {
      ctx.lineWidth = rand(9, 32);
      if (i === 1 && chance(0.5)) ctx.setLineDash([rand(26, 60), rand(18, 40)]);
      ctx.beginPath();
      if (shape === "circle") {
        ctx.arc(cx, cy, w / 2 - inset, 0, TAU);
      } else if (shape === "round") {
        const rr = rand(40, 110);
        if (ctx.roundRect) ctx.roundRect(x0 + inset, y0 + inset, w - inset * 2, h - inset * 2, rr);
        else ctx.rect(x0 + inset, y0 + inset, w - inset * 2, h - inset * 2);
      } else if (shape === "archtop") {
        const l = x0 + inset;
        const r = x0 + w - inset;
        const b = y0 + h - inset;
        const t = y0 + inset;
        ctx.moveTo(l, b);
        ctx.lineTo(l, t + (w - inset * 2) / 2);
        ctx.arc(cx, t + (w - inset * 2) / 2, (w - inset * 2) / 2, Math.PI, TAU);
        ctx.lineTo(r, b);
        ctx.closePath();
      } else {
        ctx.rect(x0 + inset, y0 + inset, w - inset * 2, h - inset * 2);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      inset += ctx.lineWidth + rand(14, 42);
    }
    const corner = pick(["ticks", "dots", "none", "none"] as const);
    if (corner !== "none" && shape !== "circle") {
      ctx.lineWidth = rand(9, 18);
      for (const [sx, sy] of [[x0, y0], [x0 + w, y0], [x0, y0 + h], [x0 + w, y0 + h]]) {
        const dx = sx === x0 ? 1 : -1;
        const dy = sy === y0 ? 1 : -1;
        if (corner === "dots") {
          ctx.beginPath();
          ctx.arc(sx + dx * 30, sy + dy * 30, rand(14, 24), 0, TAU);
          ctx.fill();
        } else {
          const t = rand(40, 90);
          ctx.beginPath();
          ctx.moveTo(sx + dx * (t + 30), sy + dy * 30);
          ctx.lineTo(sx + dx * 30, sy + dy * 30);
          ctx.lineTo(sx + dx * 30, sy + dy * (t + 30));
          ctx.stroke();
        }
      }
    }
  }

  if (id === "arch") {
    // concentric arches / rainbow bands, optionally sunset stripes under
    const bands = randInt(3, 7);
    const baseR = rand(260, 380);
    const gap = rand(28, 60);
    const cyy = cy + rand(60, 180);
    const filled = chance(0.4);
    for (let i = 0; i < bands; i++) {
      const r = baseR + i * gap;
      ctx.lineWidth = filled ? 0 : rand(14, 30);
      if (filled) {
        ctx.beginPath();
        ctx.arc(cx, cyy, r, Math.PI, TAU);
        ctx.arc(cx, cyy, r - gap * 0.6, TAU, Math.PI, true);
        ctx.closePath();
        if (i % 2 === 0) ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(cx, cyy, r, Math.PI, TAU);
        ctx.stroke();
      }
    }
    if (chance(0.5)) {
      // sun/dot centered under the arch
      ctx.beginPath();
      ctx.arc(cx, cyy - baseR * rand(0.1, 0.4), rand(50, 110), 0, TAU);
      ctx.fill();
    }
    if (chance(0.4)) {
      // rays under the arch line
      const n = randInt(6, 12);
      ctx.lineWidth = rand(8, 16);
      for (let i = 0; i < n; i++) {
        const a = Math.PI + (i / (n - 1)) * Math.PI;
        ctx.beginPath();
        ctx.moveTo(cx + (baseR - gap) * Math.cos(a), cyy + (baseR - gap) * Math.sin(a));
        ctx.lineTo(cx + (baseR - gap * 3) * Math.cos(a), cyy + (baseR - gap * 3) * Math.sin(a));
        ctx.stroke();
      }
    }
  }

  if (id === "grid") {
    // plaid / crosshatch / tartan of varying line weights
    const mode = pick(["plaid", "crosshatch", "check", "weave", "iso"] as const);
    const pad = 120;
    const span = SIZE - pad * 2;
    if (mode === "check") {
      const n = randInt(4, 9);
      const cell = span / n;
      for (let gy = 0; gy < n; gy++)
        for (let gx = 0; gx < n; gx++)
          if ((gx + gy) % 2 === 0) ctx.fillRect(pad + gx * cell, pad + gy * cell, cell, cell);
    } else if (mode === "weave") {
      const n = randInt(5, 10);
      const cell = span / n;
      const bar = cell * rand(0.4, 0.7);
      for (let gy = 0; gy < n; gy++)
        for (let gx = 0; gx < n; gx++) {
          const on = (gx + gy) % 2 === 0;
          if (on) ctx.fillRect(pad + gx * cell, pad + gy * cell + (cell - bar) / 2, cell, bar);
          else ctx.fillRect(pad + gx * cell + (cell - bar) / 2, pad + gy * cell, bar, cell);
        }
    } else if (mode === "iso") {
      // isometric triangle lattice
      const cell2 = span / randInt(5, 9);
      ctx.lineWidth = rand(6, 12);
      ctx.save();
      ctx.beginPath();
      ctx.rect(pad, pad, span, span);
      ctx.clip();
      for (let y = pad; y <= SIZE - pad + 1; y += cell2) {
        ctx.beginPath();
        ctx.moveTo(pad, y);
        ctx.lineTo(SIZE - pad, y);
        ctx.stroke();
      }
      for (const dir of [1, -1]) {
        for (let x = pad - span; x <= SIZE - pad + span; x += cell2) {
          ctx.beginPath();
          ctx.moveTo(x, pad);
          ctx.lineTo(x + dir * span * 0.577, SIZE - pad);
          ctx.stroke();
        }
      }
      ctx.restore();
    } else {
      const lines = mode === "plaid" ? randInt(4, 8) : randInt(8, 16);
      const positions = Array.from({ length: lines }, () => rand(pad, SIZE - pad));
      const drawSet = (horizontal: boolean, angle = 0) => {
        for (const p of positions.length ? positions : [0]) {
          ctx.lineWidth = mode === "plaid" ? rand(6, 34) : rand(4, 10);
          ctx.beginPath();
          if (angle) {
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(angle);
            ctx.moveTo(-span, p - cy);
            ctx.lineTo(span, p - cy);
            ctx.stroke();
            ctx.restore();
          } else if (horizontal) {
            ctx.moveTo(pad, p);
            ctx.lineTo(SIZE - pad, p);
            ctx.stroke();
          } else {
            ctx.moveTo(p, pad);
            ctx.lineTo(p, SIZE - pad);
            ctx.stroke();
          }
        }
      };
      if (mode === "crosshatch") {
        drawSet(false, Math.PI / 4);
        drawSet(false, -Math.PI / 4);
      } else {
        drawSet(true);
        drawSet(false);
      }
    }
  }

  if (id === "paisley") {
    // A boteh built procedurally: a hooked teardrop whose curl, girth and
    // tail-length vary, drawn as a filled body or an outlined shell, with a
    // choice of interior fill (seed row, inner boteh, veins, dots). Composed
    // one big / mirrored pair / scattered field.
    const bodyStyle = pick(["filled", "outline", "outline"] as const);
    const curl = rand(0.8, 1.7); // how hard the tail hooks back
    const girth = rand(0.7, 1.25); // fatness of the bulb
    const tail = rand(0.85, 1.35); // tail length
    // inner boteh over an outlined shell reads as a tangled figure-8 — only
    // allow it inside filled bodies
    const inFill =
      bodyStyle === "filled"
        ? pick(["seeds", "boteh", "veins", "dots", "none"] as const)
        : pick(["seeds", "veins", "dots", "none"] as const);
    const strokeW = rand(12, 26);

    // Build the boteh outline as a Path2D-free bezier chain pointing "up",
    // bulb centered near origin, tip curling to the right.
    const botehPath = () => {
      const B = 190 * girth; // bulb radius-ish
      const T = 250 * tail; // how far the tip reaches up
      ctx.beginPath();
      ctx.moveTo(0, B * 0.9);
      // left flank up to the tip
      ctx.bezierCurveTo(-B * 1.15, B * 0.7, -B * 1.05, -T * 0.35, -B * 0.15, -T * 0.72);
      // the hook: tip curls to the right
      ctx.bezierCurveTo(B * 0.5 * curl, -T, B * 1.5 * curl, -T * 0.5, B * 0.62 * curl, -T * 0.12);
      // right flank back down to the bulb base
      ctx.bezierCurveTo(B * 0.2 * curl, -T * 0.02, B * 1.2, -B * 0.1, B * 1.05, B * 0.4);
      ctx.bezierCurveTo(B * 0.95, B * 0.85, B * 0.5, B * 1.05, 0, B * 0.9);
      ctx.closePath();
    };

    const drawBoteh = (px: number, py: number, scale: number, rot: number, mirror = false) => {
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(rot);
      ctx.scale(mirror ? -scale : scale, scale);
      if (bodyStyle === "filled") {
        botehPath();
        ctx.fill();
        // punch an inner shell so a border reads, then re-fill motifs inside
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        ctx.save();
        ctx.scale(0.72, 0.72);
        ctx.translate(0, 20);
        botehPath();
        ctx.fill();
        ctx.restore();
        ctx.restore();
      } else {
        botehPath();
        ctx.lineWidth = strokeW / scale;
        ctx.stroke();
      }
      // interior detailing lives inside the shell
      ctx.save();
      ctx.scale(0.62, 0.62);
      ctx.translate(0, 24);
      if (inFill === "seeds" || inFill === "dots") {
        const s = randInt(5, 9);
        for (let i = 0; i < s; i++) {
          const f = i / (s - 1);
          ctx.beginPath();
          ctx.arc(-10 + f * 30, 150 - f * 380, (inFill === "dots" ? 22 : 30) * (1 - f * 0.6), 0, TAU);
          ctx.fill();
        }
      } else if (inFill === "boteh") {
        ctx.scale(0.5, 0.5);
        ctx.translate(0, 40);
        botehPath();
        ctx.lineWidth = strokeW * 1.6;
        ctx.stroke();
      } else if (inFill === "veins") {
        ctx.lineWidth = 14;
        for (let k = -1; k <= 1; k++) {
          ctx.beginPath();
          ctx.moveTo(k * 40, 150);
          ctx.quadraticCurveTo(k * 90 - 60, -60, -20, -250);
          ctx.stroke();
        }
      }
      ctx.restore();
      ctx.restore();
    };

    const comp = pick(["single", "single", "mirror", "scatter"] as const);
    if (comp === "scatter") {
      const n = randInt(3, 6);
      for (let i = 0; i < n; i++)
        drawBoteh(rand(300, SIZE - 300), rand(300, SIZE - 300), rand(0.5, 0.95), rand(0, TAU), chance(0.5));
    } else if (comp === "mirror") {
      const s = rand(0.85, 1.1);
      drawBoteh(cx - 265, cy, s, rand(-0.15, 0.15), false);
      drawBoteh(cx + 265, cy, s, rand(-0.15, 0.15), true);
    } else {
      drawBoteh(cx, cy, rand(1.5, 2.0), rand(-0.4, 0.4));
    }
  }

  if (id === "wreath") {
    const wstyle = pick(["ring", "ring", "laurel"] as const);
    if (wstyle === "laurel") {
      // two leaf branches sweeping up from the bottom — classic laurel
      const R2 = rand(330, 420);
      for (const s of [-1, 1]) {
        const steps = randInt(7, 11);
        for (let i = 0; i < steps; i++) {
          const a = Math.PI / 2 + s * (0.3 + (i / steps) * 1.8);
          const x = cx + R2 * Math.cos(a);
          const y = cy + R2 * Math.sin(a);
          const tangent = a + (s > 0 ? -Math.PI / 2 : Math.PI / 2);
          for (const side of [-0.55, 0.55]) {
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(tangent + side * (s > 0 ? 1 : -1));
            leafPath(ctx, rand(85, 135) * (1 - i / (steps * 1.7)) + 35, rand(26, 40), 0.15);
            ctx.fill();
            ctx.restore();
          }
        }
        ctx.lineWidth = rand(8, 12);
        ctx.beginPath();
        ctx.arc(cx, cy, R2, Math.PI / 2 + s * 0.18, Math.PI / 2 + s * 2.05, s < 0);
        ctx.stroke();
      }
      if (chance(0.4)) {
        starPath(ctx, cx, cy, 5, rand(80, 140), rand(32, 58), 0, false);
        ctx.fill();
      }
      return trim(c);
    }
    // ring of repeated small marks — laurel, dots, stars, leaves
    const R = rand(320, 420);
    const n = randInt(10, 28);
    const mark: Mark = pick(["leaf", "dot", "star", "diamond", "leaf"] as const);
    const facing = chance(0.6); // marks tangent to the ring vs pointing out
    const gapTop = chance(0.4) ? rand(0.15, 0.4) : 0; // open-top laurel
    for (let i = 0; i < n; i++) {
      const frac = i / n;
      if (gapTop && (frac < gapTop / 2 || frac > 1 - gapTop / 2)) continue;
      const a = frac * TAU - Math.PI / 2;
      ctx.save();
      ctx.translate(cx + R * Math.cos(a), cy + R * Math.sin(a));
      const rot = facing ? a + Math.PI / 2 : a;
      drawMark(ctx, mark, rand(28, 52), rot);
      ctx.restore();
    }
    // optional inner ring or a small centered star
    if (chance(0.5)) {
      ctx.lineWidth = rand(6, 14);
      ctx.beginPath();
      ctx.arc(cx, cy, R - rand(50, 90), 0, TAU);
      ctx.stroke();
    }
    if (chance(0.35)) {
      starPath(ctx, cx, cy, 5, rand(70, 130), rand(28, 55), 0, false);
      ctx.fill();
    }
  }

  if (id === "bolt") {
    const mode = pick(["single", "double", "shower", "charged"] as const);
    const h = rand(560, 900);
    const w = h * rand(0.42, 0.6);
    const drawBolt = (px: number, py: number, s: number, rot: number, outline: boolean) => {
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(rot);
      ctx.scale(s, s);
      boltPath(ctx, h, w, rand(0.06, 0.16));
      if (outline) {
        ctx.lineWidth = rand(14, 24) / s;
        ctx.stroke();
      } else ctx.fill();
      ctx.restore();
    };
    if (mode === "single") {
      drawBolt(cx, cy, 1, rand(-0.25, 0.25), chance(0.3));
    } else if (mode === "double") {
      drawBolt(cx - w * 0.42, cy, rand(0.8, 0.95), rand(-0.3, -0.05), false);
      drawBolt(cx + w * 0.42, cy + rand(-60, 60), rand(0.55, 0.75), rand(0.05, 0.3), chance(0.5));
    } else if (mode === "shower") {
      const n = randInt(3, 5);
      for (let i = 0; i < n; i++)
        drawBolt(rand(240, SIZE - 240), rand(240, SIZE - 240), rand(0.28, 0.5), rand(-0.4, 0.4), chance(0.3));
    } else {
      // charged: one bolt with speed-lines / sparks around it
      drawBolt(cx, cy, rand(0.8, 1), rand(-0.2, 0.2), false);
      const sparks = randInt(4, 8);
      ctx.lineWidth = rand(8, 14);
      for (let i = 0; i < sparks; i++) {
        const a = rand(0, TAU);
        const r0 = rand(340, 430);
        const r1 = r0 + rand(50, 130);
        ctx.beginPath();
        ctx.moveTo(cx + r0 * Math.cos(a), cy + r0 * Math.sin(a));
        ctx.lineTo(cx + r1 * Math.cos(a), cy + r1 * Math.sin(a));
        ctx.stroke();
      }
    }
  }

  if (id === "heart") {
    const mode = pick(["solid", "outline", "nested", "pierced", "broken", "sparked", "row"] as const);
    const R = rand(300, 420);
    const tilt = rand(-0.18, 0.18);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(tilt);
    if (mode === "row") {
      ctx.restore();
      const n = randInt(3, 5);
      for (let i = 0; i < n; i++) {
        ctx.save();
        ctx.translate(200 + (i / (n - 1)) * (SIZE - 400), cy + rand(-40, 40));
        ctx.rotate(rand(-0.25, 0.25));
        heartPath(ctx, rand(90, 150), 0.08);
        chance(0.5) ? ctx.fill() : ((ctx.lineWidth = rand(12, 20)), ctx.stroke());
        ctx.restore();
      }
    } else if (mode === "outline") {
      heartPath(ctx, R, 0.05);
      ctx.lineWidth = rand(16, 34);
      ctx.stroke();
      ctx.restore();
    } else if (mode === "nested") {
      for (let i = 0; i < randInt(3, 5); i++) {
        heartPath(ctx, R * (1 - i * 0.22), 0.03);
        ctx.lineWidth = rand(10, 18);
        i % 2 === 0 ? ctx.stroke() : ctx.fill();
      }
      ctx.restore();
    } else {
      heartPath(ctx, R, 0.05);
      ctx.fill();
      if (mode === "broken") {
        // zigzag crack punched out of the middle
        ctx.globalCompositeOperation = "destination-out";
        ctx.lineWidth = rand(26, 44);
        ctx.beginPath();
        let y = -R * 0.5;
        ctx.moveTo(rand(-30, 30), y);
        while (y < R) {
          y += R * rand(0.2, 0.32);
          ctx.lineTo(rand(-R * 0.22, R * 0.22), y);
        }
        ctx.stroke();
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.restore();
      if (mode === "pierced") {
        // arrow through: line behind, head + fletching outside the heart
        const a = rand(-0.5, -0.2);
        const dx = Math.cos(a), dy = Math.sin(a);
        const L = R * 1.9;
        ctx.lineWidth = rand(16, 24);
        ctx.beginPath();
        ctx.moveTo(cx - dx * L, cy - dy * L);
        ctx.lineTo(cx + dx * L, cy + dy * L);
        ctx.stroke();
        // head
        ctx.save();
        ctx.translate(cx + dx * L, cy + dy * L);
        ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(-90, -45);
        ctx.lineTo(-60, 0);
        ctx.lineTo(-90, 45);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        // fletching
        ctx.save();
        ctx.translate(cx - dx * L, cy - dy * L);
        ctx.rotate(a);
        ctx.lineWidth = 14;
        for (const off of [0, 55, 110]) {
          ctx.beginPath();
          ctx.moveTo(off, 0);
          ctx.lineTo(off + 70, -60);
          ctx.moveTo(off, 0);
          ctx.lineTo(off + 70, 60);
          ctx.stroke();
        }
        ctx.restore();
      } else if (mode === "sparked") {
        const n = randInt(5, 9);
        for (let i = 0; i < n; i++) {
          const a = rand(0, TAU);
          const d = R * rand(1.25, 1.6);
          starPath(ctx, cx + d * Math.cos(a), cy + d * Math.sin(a), 4, rand(30, 60), rand(10, 20), rand(0, TAU), true);
          ctx.fill();
        }
      }
    }
  }

  if (id === "moon") {
    const mode = pick(["crescent", "phases", "full", "starlit"] as const);
    if (mode === "phases") {
      const n = pick([3, 5] as const);
      const r = (SIZE - 300) / (n * 2.4);
      for (let i = 0; i < n; i++) {
        const px = 170 + r + (i / (n - 1)) * (SIZE - 340 - r * 2);
        const f = i / (n - 1); // 0 new → 1 full
        ctx.beginPath();
        ctx.arc(px, cy, r, 0, TAU);
        ctx.fill();
        // punch the shadow: offset circle sweeping across
        const off = (1 - f) * r * 2.2;
        if (off > 2) punch(ctx, px - off + r * 0.1, cy, r);
      }
    } else {
      const R = rand(320, 430);
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.fill();
      if (mode !== "full") {
        const off = R * rand(0.45, 0.75);
        const a = rand(-0.7, 0.2);
        punch(ctx, cx + off * Math.cos(a), cy + off * Math.sin(a), R * rand(0.82, 0.95));
      } else {
        // cratered full moon
        for (let i = 0; i < randInt(4, 8); i++) {
          const a = rand(0, TAU);
          const d = rand(0, R * 0.7);
          punch(ctx, cx + d * Math.cos(a), cy + d * Math.sin(a), rand(16, 52));
        }
      }
      if (mode === "starlit" || (mode === "crescent" && chance(0.5))) {
        const n = randInt(3, 7);
        for (let i = 0; i < n; i++) {
          const a = rand(0, TAU);
          const d = R * rand(1.15, 1.5);
          starPath(ctx, cx + d * Math.cos(a), cy + d * Math.sin(a), 4, rand(26, 60), rand(9, 20), rand(0, TAU), true);
          ctx.fill();
        }
      }
    }
  }

  if (id === "eye") {
    const mode = pick(["classic", "evil", "winged", "teary"] as const);
    const W = rand(380, 480); // half-width of the almond
    const H = W * rand(0.42, 0.58);
    // almond: two arcs
    const lid = (sign: number, scale = 1) => {
      ctx.beginPath();
      ctx.moveTo(-W * scale, 0);
      ctx.quadraticCurveTo(0, -H * 1.9 * sign * scale, W * scale, 0);
      ctx.quadraticCurveTo(0, H * 1.9 * sign * scale, -W * scale, 0);
      ctx.closePath();
    };
    ctx.save();
    ctx.translate(cx, cy);
    if (mode === "evil") {
      // concentric filled rings, iris-forward — classic nazar
      lid(1);
      ctx.fill();
      punch(ctx, 0, 0, H * 0.92);
      for (const [r, on] of [[H * 0.85, true], [H * 0.62, false], [H * 0.4, true]] as const) {
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, TAU);
        if (on) ctx.fill();
        else punch(ctx, 0, 0, r);
      }
    } else {
      lid(1);
      ctx.lineWidth = rand(18, 30);
      ctx.stroke();
      // iris + pupil
      const ir = H * rand(0.55, 0.75);
      ctx.beginPath();
      ctx.arc(0, 0, ir, 0, TAU);
      chance(0.5) ? ctx.fill() : ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, ir * rand(0.35, 0.5), 0, TAU);
      ctx.fill();
      // glint
      punch(ctx, ir * 0.3, -ir * 0.3, ir * 0.18);
      // lashes on the top lid
      const lashes = randInt(0, 3) && mode !== "teary" ? randInt(3, 7) : 0;
      ctx.lineWidth = rand(10, 16);
      for (let i = 0; i < lashes; i++) {
        const t = (i + 1) / (lashes + 1);
        const lx = -W + t * W * 2;
        const ly = -H * 1.9 * (1 - (2 * t - 1) ** 2) * 0.5;
        ctx.beginPath();
        ctx.moveTo(lx, ly);
        ctx.lineTo(lx + (t - 0.5) * 90, ly - rand(50, 100));
        ctx.stroke();
      }
      if (mode === "winged") {
        ctx.lineWidth = rand(20, 30);
        ctx.beginPath();
        ctx.moveTo(W * 0.96, -4);
        ctx.quadraticCurveTo(W * 1.3, -H * 0.5, W * 1.5, -H * 0.9);
        ctx.stroke();
      }
      if (mode === "teary") {
        ctx.beginPath();
        ctx.moveTo(0, H * 1.15);
        ctx.quadraticCurveTo(-60, H * 1.8, 0, H * 2.15);
        ctx.quadraticCurveTo(60, H * 1.8, 0, H * 1.15);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  if (id === "flame") {
    const mode = pick(["single", "triple", "row", "ball"] as const);
    const lick = (px: number, py: number, h: number, lean: number) => {
      // flickering teardrop with 1-2 side licks
      const w = h * rand(0.34, 0.48);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.bezierCurveTo(px - w, py - h * 0.25, px - w * rand(0.5, 0.9), py - h * rand(0.55, 0.75), px + lean * w, py - h);
      ctx.bezierCurveTo(px + w * rand(0.55, 0.95), py - h * rand(0.5, 0.7), px + w, py - h * 0.22, px, py);
      ctx.closePath();
      ctx.fill();
      if (chance(0.55)) punch(ctx, px + lean * w * 0.3, py - h * rand(0.28, 0.42), w * rand(0.28, 0.42));
    };
    if (mode === "single") lick(cx, cy + 320, rand(560, 720), rand(-0.5, 0.5));
    else if (mode === "triple") {
      lick(cx - 190, cy + 300, rand(320, 430), rand(-0.7, -0.2));
      lick(cx + 190, cy + 300, rand(320, 430), rand(0.2, 0.7));
      lick(cx, cy + 330, rand(520, 660), rand(-0.25, 0.25));
    } else if (mode === "row") {
      const n = randInt(4, 7);
      for (let i = 0; i < n; i++) {
        const px = 160 + (i / (n - 1)) * (SIZE - 320);
        lick(px, cy + 260, rand(220, 420), rand(-0.4, 0.4));
      }
    } else {
      // fireball: circle with licks coming off the top
      ctx.beginPath();
      ctx.arc(cx, cy + 140, 240, 0, TAU);
      ctx.fill();
      for (let i = 0; i < randInt(3, 5); i++)
        lick(cx + rand(-170, 170), cy + 40, rand(220, 380), rand(-0.5, 0.5));
    }
  }

  if (id === "smiley") {
    const R = rand(340, 440);
    const outline = chance(0.45);
    const mood = pick(["grin", "flat", "wink", "starry", "sleepy"] as const);
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    if (outline) {
      ctx.lineWidth = rand(22, 38);
      ctx.stroke();
    } else ctx.fill();
    const ink = !outline; // features punched from a filled face, drawn on an outline
    const feature = (draw: () => void) => {
      if (ink) {
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        draw();
        ctx.restore();
      } else draw();
    };
    const ey = cy - R * 0.28;
    const ex = R * 0.38;
    // eyes
    feature(() => {
      const er = R * rand(0.08, 0.13);
      const eyeShape = mood === "starry" ? "star" : mood === "sleepy" ? "line" : "dot";
      for (const s of [-1, 1]) {
        if (mood === "wink" && s === 1) {
          ctx.lineWidth = R * 0.07;
          ctx.beginPath();
          ctx.moveTo(cx + ex - er * 1.4, ey);
          ctx.lineTo(cx + ex + er * 1.4, ey);
          ctx.stroke();
          continue;
        }
        if (eyeShape === "star") {
          starPath(ctx, cx + s * ex, ey, 4, er * 2, er * 0.8, 0, true);
          ctx.fill();
        } else if (eyeShape === "line") {
          ctx.lineWidth = R * 0.06;
          ctx.beginPath();
          ctx.arc(cx + s * ex, ey - er, er * 1.5, 0.15 * Math.PI, 0.85 * Math.PI);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(cx + s * ex, ey, er, 0, TAU);
          ctx.fill();
        }
      }
    });
    // mouth
    feature(() => {
      ctx.lineWidth = R * rand(0.07, 0.1);
      ctx.beginPath();
      if (mood === "flat") {
        ctx.moveTo(cx - R * 0.4, cy + R * 0.35);
        ctx.lineTo(cx + R * 0.4, cy + R * 0.35);
      } else {
        ctx.arc(cx, cy + R * 0.05, R * 0.55, 0.2 * Math.PI, 0.8 * Math.PI);
      }
      ctx.stroke();
    });
  }

  if (id === "orbit") {
    const mode = pick(["atom", "saturn", "system"] as const);
    if (mode === "atom") {
      const n = randInt(2, 4);
      ctx.lineWidth = rand(12, 20);
      for (let i = 0; i < n; i++) {
        const rot = (i / n) * Math.PI + rand(-0.1, 0.1);
        ctx.beginPath();
        ctx.ellipse(cx, cy, rand(420, 520), rand(120, 200), rot, 0, TAU);
        ctx.stroke();
        // electron on this orbit
        if (chance(0.8)) {
          const t = rand(0, TAU);
          const ex = 470 * Math.cos(t), ey0 = 160 * Math.sin(t);
          const rx = ex * Math.cos(rot) - ey0 * Math.sin(rot);
          const ry = ex * Math.sin(rot) + ey0 * Math.cos(rot);
          ctx.beginPath();
          ctx.arc(cx + rx, cy + ry, rand(22, 36), 0, TAU);
          ctx.fill();
        }
      }
      ctx.beginPath();
      ctx.arc(cx, cy, rand(50, 90), 0, TAU);
      ctx.fill();
    } else if (mode === "saturn") {
      const R = rand(240, 330);
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.fill();
      const tilt = rand(-0.35, -0.1);
      ctx.lineWidth = rand(26, 44);
      // ring passes "behind": draw full ellipse, punch the half hidden by the planet
      ctx.beginPath();
      ctx.ellipse(cx, cy, R * rand(1.6, 1.9), R * rand(0.35, 0.5), tilt, 0, TAU);
      ctx.stroke();
      if (chance(0.6)) {
        for (let i = 0; i < randInt(2, 5); i++) {
          const a = rand(0, TAU), d = R * rand(1.9, 2.4);
          starPath(ctx, cx + d * Math.cos(a), cy + d * Math.sin(a), 4, rand(24, 50), rand(9, 18), rand(0, TAU), true);
          ctx.fill();
        }
      }
    } else {
      // little solar system: sun + orbit arcs + planets
      ctx.beginPath();
      ctx.arc(cx, cy, rand(70, 110), 0, TAU);
      ctx.fill();
      const n = randInt(2, 4);
      ctx.lineWidth = rand(6, 10);
      for (let i = 0; i < n; i++) {
        const r = 190 + i * rand(110, 150);
        ctx.beginPath();
        ctx.arc(cx, cy, r, rand(0, TAU), rand(0, TAU) + rand(0.9, 1.6) * TAU);
        ctx.stroke();
        const a = rand(0, TAU);
        ctx.beginPath();
        ctx.arc(cx + r * Math.cos(a), cy + r * Math.sin(a), rand(20, 44), 0, TAU);
        ctx.fill();
      }
    }
  }

  if (id === "arrow") {
    const mode = pick(["single", "crossed", "bundle", "circular"] as const);
    const drawArrow = (x0: number, y0: number, x1: number, y1: number, lw: number) => {
      const a = Math.atan2(y1 - y0, x1 - x0);
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      // head
      ctx.save();
      ctx.translate(x1, y1);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-110, -55);
      ctx.lineTo(-75, 0);
      ctx.lineTo(-110, 55);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      // fletching
      ctx.save();
      ctx.translate(x0, y0);
      ctx.rotate(a);
      ctx.lineWidth = lw * 0.8;
      for (const off of [10, 70, 130]) {
        ctx.beginPath();
        ctx.moveTo(off, 0);
        ctx.lineTo(off + 80, -70);
        ctx.moveTo(off, 0);
        ctx.lineTo(off + 80, 70);
        ctx.stroke();
      }
      ctx.restore();
    };
    if (mode === "single") {
      const a = rand(0, TAU);
      const L = rand(420, 520);
      drawArrow(cx - L * Math.cos(a), cy - L * Math.sin(a), cx + L * Math.cos(a), cy + L * Math.sin(a), rand(14, 22));
    } else if (mode === "crossed") {
      const L = rand(400, 480);
      for (const a of [rand(0.5, 0.8), rand(2.3, 2.6)]) {
        drawArrow(cx - L * Math.cos(a), cy - L * Math.sin(a), cx + L * Math.cos(a), cy + L * Math.sin(a), rand(14, 20));
      }
    } else if (mode === "bundle") {
      const n = randInt(3, 4);
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * rand(130, 170);
        drawArrow(cx - 440, cy + off + rand(-30, 30), cx + 440, cy + off + rand(-30, 30), rand(12, 18));
      }
    } else {
      // circular: arrow bent along an arc, head at the end
      const R = rand(300, 400);
      const start = rand(0, TAU);
      const span = rand(1.2, 1.7) * Math.PI;
      ctx.lineWidth = rand(20, 32);
      ctx.beginPath();
      ctx.arc(cx, cy, R, start, start + span);
      ctx.stroke();
      const end = start + span;
      ctx.save();
      ctx.translate(cx + R * Math.cos(end), cy + R * Math.sin(end));
      ctx.rotate(end + Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(0, 60);
      ctx.lineTo(-70, -50);
      ctx.lineTo(70, -50);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  if (id === "fruit") {
    const kind = pick(["cherries", "citrus", "strawberry", "apple"] as const);
    if (kind === "cherries") {
      const r = rand(130, 180);
      const spread = rand(150, 210);
      const stemTop = cy - rand(280, 360);
      for (const s of [-1, 1]) {
        const bx = cx + s * spread;
        const by = cy + rand(80, 160);
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, TAU);
        ctx.fill();
        punch(ctx, bx - r * 0.3, by - r * 0.3, r * 0.22); // shine
        ctx.lineWidth = rand(16, 24);
        ctx.beginPath();
        ctx.moveTo(bx, by - r);
        ctx.quadraticCurveTo(bx + s * 30, cy - 120, cx, stemTop);
        ctx.stroke();
      }
      // leaf at the stem join
      ctx.save();
      ctx.translate(cx, stemTop);
      ctx.rotate(rand(-0.6, -0.2));
      leafPath(ctx, rand(150, 210), rand(50, 75), 0.2);
      ctx.fill();
      ctx.restore();
    } else if (kind === "citrus") {
      const R = rand(330, 420);
      const wedges = randInt(8, 12);
      ctx.lineWidth = rand(18, 28);
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.82, 0, TAU);
      chance(0.5) ? ctx.stroke() : void 0;
      for (let i = 0; i < wedges; i++) {
        const a0 = (i / wedges) * TAU + 0.05;
        const a1 = ((i + 1) / wedges) * TAU - 0.05;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, R * 0.75, a0, a1);
        ctx.closePath();
        ctx.fill();
      }
      punch(ctx, cx, cy, R * 0.12);
    } else if (kind === "strawberry") {
      // heart-ish berry with punched seeds + leaf crown
      ctx.save();
      ctx.translate(cx, cy + 40);
      ctx.rotate(rand(-0.15, 0.15));
      heartPath(ctx, rand(280, 360), 0.06);
      ctx.fill();
      for (let i = 0; i < randInt(8, 14); i++)
        punch(ctx, rand(-180, 180), rand(-160, 220), rand(12, 22));
      // crown
      for (const a of [-0.9, -0.45, 0, 0.45, 0.9]) {
        ctx.save();
        ctx.translate(0, -320);
        ctx.rotate(a - Math.PI / 2);
        leafPath(ctx, rand(110, 160), rand(34, 50), 0.15);
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    } else {
      // apple: two lobes + stem + leaf
      const R = rand(280, 350);
      ctx.beginPath();
      ctx.arc(cx - R * 0.35, cy + 60, R * 0.72, 0, TAU);
      ctx.arc(cx + R * 0.35, cy + 60, R * 0.72, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(cx, cy + 60 + R * 0.25, R * 0.7, R * 0.55, 0, 0, TAU);
      ctx.fill();
      ctx.lineWidth = rand(18, 26);
      ctx.beginPath();
      ctx.moveTo(cx, cy - R * 0.28);
      ctx.quadraticCurveTo(cx + 30, cy - R * 0.75, cx + 10, cy - R * 0.95);
      ctx.stroke();
      ctx.save();
      ctx.translate(cx + 40, cy - R * 0.8);
      ctx.rotate(rand(0.2, 0.6));
      leafPath(ctx, rand(140, 190), rand(45, 65), 0.25);
      ctx.fill();
      ctx.restore();
      punch(ctx, cx - R * 0.4, cy - 20, R * 0.16); // shine
    }
  }

  if (id === "compass") {
    const mode = pick(["rose", "ring", "needle"] as const);
    const R = rand(380, 470);
    const rose = (outer: number, inner: number, points: number, rot: number) => {
      for (let i = 0; i < points; i++) {
        const a = (i / points) * TAU + rot;
        // each cardinal point is a split diamond: light/dark halves read as one ink shape here
        ctx.beginPath();
        ctx.moveTo(cx + outer * Math.cos(a), cy + outer * Math.sin(a));
        ctx.lineTo(cx + inner * Math.cos(a + 0.35), cy + inner * Math.sin(a + 0.35));
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx + inner * Math.cos(a - 0.35), cy + inner * Math.sin(a - 0.35));
        ctx.closePath();
        ctx.fill();
      }
    };
    if (mode === "rose" || mode === "ring") {
      rose(R * 0.95, R * 0.28, 4, -Math.PI / 2);
      rose(R * 0.6, R * 0.2, 4, -Math.PI / 2 + Math.PI / 4);
      punch(ctx, cx, cy, R * 0.09);
      if (mode === "ring") {
        ctx.lineWidth = rand(10, 18);
        ctx.beginPath();
        ctx.arc(cx, cy, R * 1.06, 0, TAU);
        ctx.stroke();
        // degree ticks
        const ticks = randInt(24, 60);
        ctx.lineWidth = rand(5, 9);
        for (let i = 0; i < ticks; i++) {
          const a = (i / ticks) * TAU;
          const len = i % (ticks / 4) === 0 ? 40 : 18;
          ctx.beginPath();
          ctx.moveTo(cx + R * 1.06 * Math.cos(a), cy + R * 1.06 * Math.sin(a));
          ctx.lineTo(cx + (R * 1.06 - len) * Math.cos(a), cy + (R * 1.06 - len) * Math.sin(a));
          ctx.stroke();
        }
      }
    } else {
      // needle: circle + one long two-tone diamond needle
      ctx.lineWidth = rand(16, 26);
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.9, 0, TAU);
      ctx.stroke();
      const a = rand(0, TAU);
      ctx.beginPath();
      ctx.moveTo(cx + R * 0.72 * Math.cos(a), cy + R * 0.72 * Math.sin(a));
      ctx.lineTo(cx + R * 0.14 * Math.cos(a + Math.PI / 2), cy + R * 0.14 * Math.sin(a + Math.PI / 2));
      ctx.lineTo(cx + R * 0.72 * Math.cos(a + Math.PI), cy + R * 0.72 * Math.sin(a + Math.PI));
      ctx.lineTo(cx + R * 0.14 * Math.cos(a - Math.PI / 2), cy + R * 0.14 * Math.sin(a - Math.PI / 2));
      ctx.closePath();
      ctx.fill();
      punch(ctx, cx, cy, R * 0.07);
    }
  }

  if (id === "constellation") {
    const n = randInt(5, 9);
    const pts: { x: number; y: number; r: number }[] = [];
    // random-walk placement keeps it readable (no long crisscrossing)
    let px = rand(220, SIZE - 220);
    let py = rand(220, SIZE - 220);
    for (let i = 0; i < n; i++) {
      pts.push({ x: px, y: py, r: rand(14, 40) });
      const a = rand(0, TAU);
      const d = rand(160, 300);
      px = Math.min(SIZE - 160, Math.max(160, px + d * Math.cos(a)));
      py = Math.min(SIZE - 160, Math.max(160, py + d * Math.sin(a)));
    }
    ctx.lineWidth = rand(5, 9);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (chance(0.3)) ctx.closePath();
    ctx.stroke();
    for (const p of pts) {
      if (chance(0.35)) {
        starPath(ctx, p.x, p.y, 4, p.r * 2.2, p.r * 0.8, rand(0, TAU), true);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, TAU);
        ctx.fill();
      }
    }
    // faint extra stars scattered around
    for (let i = 0; i < randInt(4, 10); i++) {
      ctx.beginPath();
      ctx.arc(rand(140, SIZE - 140), rand(140, SIZE - 140), rand(5, 12), 0, TAU);
      ctx.fill();
    }
  }

  if (id === "chain") {
    const mode = pick(["ringOfLinks", "strip", "arc"] as const);
    const linkW = rand(120, 170);
    const linkH = linkW * rand(0.55, 0.7);
    const lw = rand(18, 30);
    const link = (px: number, py: number, rot: number) => {
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(rot);
      ctx.lineWidth = lw;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(-linkW / 2, -linkH / 2, linkW, linkH, linkH / 2);
      else ctx.ellipse(0, 0, linkW / 2, linkH / 2, 0, 0, TAU);
      ctx.stroke();
      ctx.restore();
    };
    if (mode === "ringOfLinks") {
      const R = rand(300, 400);
      const n = Math.max(8, Math.round((TAU * R) / (linkW * 0.82)));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        link(cx + R * Math.cos(a), cy + R * Math.sin(a), a + Math.PI / 2 + (i % 2 ? Math.PI / 2 : 0));
      }
    } else if (mode === "strip") {
      const rows = chance(0.4) ? 2 : 1;
      for (let rI = 0; rI < rows; rI++) {
        const y = cy + (rI - (rows - 1) / 2) * linkH * 2.2;
        const n = Math.ceil((SIZE - 200) / (linkW * 0.8));
        for (let i = 0; i < n; i++)
          link(140 + i * linkW * 0.8, y, i % 2 ? Math.PI / 2 : 0);
      }
    } else {
      // draped arc of links
      const R = rand(420, 520);
      const cyy = cy - R * rand(0.4, 0.7);
      const span = rand(0.5, 0.75) * Math.PI;
      const start = Math.PI / 2 - span / 2;
      const n = Math.round((span * R) / (linkW * 0.8));
      for (let i = 0; i <= n; i++) {
        const a = start + (i / n) * span;
        link(cx + R * Math.cos(a), cyy + R * Math.sin(a), a + Math.PI / 2 + (i % 2 ? Math.PI / 2 : 0));
      }
    }
  }

  if (id === "dither") {
    // Bayer-matrix ordered dither, Dither-it! style — shading as a pixel grid
    const B = [
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5],
    ];
    const mode = pick(["sphere", "ramp", "diamond"] as const);
    const cell = pick([20, 26, 34]);
    const dot = chance(0.45); // round pixels read softer than squares
    const px = (x: number, y: number, s: number) => {
      if (dot) {
        ctx.beginPath();
        ctx.arc(x + s / 2, y + s / 2, s * 0.42, 0, TAU);
        ctx.fill();
      } else ctx.fillRect(x, y, s, s);
    };
    const R = rand(380, 460);
    const w = mode === "ramp" ? SIZE - 240 : R * 2;
    const h = mode === "ramp" ? rand(360, 620) : R * 2;
    const x0 = cx - w / 2;
    const y0 = cy - h / 2;
    const lx = cx - R * 0.38; // sphere light point, upper left
    const ly = cy - R * 0.42;
    const vert = chance();
    for (let gy = 0; gy * cell < h; gy++) {
      for (let gx = 0; gx * cell < w; gx++) {
        const x = x0 + gx * cell;
        const y = y0 + gy * cell;
        const mx = x + cell / 2;
        const my = y + cell / 2;
        let v: number; // 0 = light → sparse, 1 = shadow → dense
        if (mode === "sphere") {
          if (Math.hypot(mx - cx, my - cy) > R) continue;
          v = Math.min(1, Math.hypot(mx - lx, my - ly) / (R * 1.5));
        } else if (mode === "ramp") {
          v = vert ? (my - y0) / h : (mx - x0) / w;
        } else {
          const d = (Math.abs(mx - cx) + Math.abs(my - cy)) / (R * 1.15);
          if (d > 1) continue;
          v = d;
        }
        if (v > B[gy % 4][gx % 4] / 16) px(x, y, cell);
      }
    }
  }

  if (id === "pixelframe") {
    // broider-style 9-patch pixel border: a repeating edge tile + solid corners
    const cellN = pick([14, 16, 18]);
    const cell = (SIZE - 240) / cellN;
    const x0 = 120;
    const y0 = 120;
    const depth = pick([2, 3]); // border thickness in cells
    const patLen = pick([2, 3, 4]);
    const pattern = Array.from({ length: patLen }, () =>
      Array.from({ length: depth }, (_, d) => (d === 0 ? true : chance(0.6)))
    );
    const put = (i: number, j: number) =>
      ctx.fillRect(x0 + i * cell + 1, y0 + j * cell + 1, cell - 2, cell - 2);
    for (let i = depth; i < cellN - depth; i++) {
      const p = pattern[i % patLen];
      for (let d = 0; d < depth; d++) {
        if (!p[d]) continue;
        put(i, d); // top
        put(i, cellN - 1 - d); // bottom
        put(d, i); // left
        put(cellN - 1 - d, i); // right
      }
    }
    for (let a = 0; a < depth; a++)
      for (let b = 0; b < depth; b++) {
        put(a, b);
        put(cellN - 1 - a, b);
        put(a, cellN - 1 - b);
        put(cellN - 1 - a, cellN - 1 - b);
      }
  }

  if (id === "oswindow") {
    // 98.css-style retro OS chrome: window, dialog, or error box
    const mode = pick(["window", "dialog", "error"] as const);
    const w = rand(760, 920);
    const h = mode === "window" ? rand(560, 760) : rand(420, 540);
    const x0 = cx - w / 2;
    const y0 = cy - h / 2;
    ctx.lineWidth = 14;
    ctx.strokeRect(x0, y0, w, h);
    const bar = rand(88, 110);
    ctx.fillRect(x0, y0, w, bar);
    // knock the title text + window buttons out of the solid bar
    const btn = bar * 0.52;
    const nBtn = mode === "window" ? 3 : 1;
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillRect(x0 + 30, y0 + bar * 0.36, rand(180, 300), bar * 0.28);
    for (let i = 0; i < nBtn; i++)
      ctx.fillRect(x0 + w - (i + 1) * (btn + 20) - 8, y0 + (bar - btn) / 2, btn, btn);
    ctx.restore();
    ctx.lineWidth = 9;
    for (let i = 0; i < nBtn; i++) {
      const bx = x0 + w - (i + 1) * (btn + 20) - 8;
      const by = y0 + (bar - btn) / 2;
      ctx.strokeRect(bx, by, btn, btn);
      if (i === 0) {
        // close button gets its ×
        ctx.beginPath();
        ctx.moveTo(bx + btn * 0.28, by + btn * 0.28);
        ctx.lineTo(bx + btn * 0.72, by + btn * 0.72);
        ctx.moveTo(bx + btn * 0.72, by + btn * 0.28);
        ctx.lineTo(bx + btn * 0.28, by + btn * 0.72);
        ctx.stroke();
      }
    }
    const bodyTop = y0 + bar;
    if (mode === "window") {
      // text lines + an image placeholder with an X through it
      const lines = randInt(3, 5);
      for (let i = 0; i < lines; i++)
        ctx.fillRect(x0 + 50, bodyTop + 50 + i * 70, rand(0.35, 0.8) * (w - 100), 26);
      const ix = x0 + 50;
      const iy = bodyTop + 50 + lines * 70 + 20;
      const iw = rand(0.35, 0.5) * w;
      const ih = y0 + h - iy - 50;
      if (ih > 80) {
        ctx.strokeRect(ix, iy, iw, ih);
        ctx.beginPath();
        ctx.moveTo(ix, iy);
        ctx.lineTo(ix + iw, iy + ih);
        ctx.moveTo(ix + iw, iy);
        ctx.lineTo(ix, iy + ih);
        ctx.stroke();
      }
    } else {
      if (mode === "error") {
        // alert badge: circle with an ×
        const r = rand(70, 90);
        const ex = x0 + 90 + r / 2;
        const ey = bodyTop + (h - bar) * 0.36;
        ctx.beginPath();
        ctx.arc(ex, ey, r, 0, TAU);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(ex - r * 0.45, ey - r * 0.45);
        ctx.lineTo(ex + r * 0.45, ey + r * 0.45);
        ctx.moveTo(ex + r * 0.45, ey - r * 0.45);
        ctx.lineTo(ex - r * 0.45, ey + r * 0.45);
        ctx.stroke();
        for (let i = 0; i < 2; i++)
          ctx.fillRect(ex + r + 50, ey - 30 + i * 52, rand(0.3, 0.45) * w, 24);
      } else {
        for (let i = 0; i < 2; i++)
          ctx.fillRect(x0 + 60, bodyTop + 50 + i * 60, rand(0.4, 0.7) * (w - 120), 24);
      }
      // OK / Cancel buttons, first one double-struck as the default
      const bw = rand(170, 210);
      const bh = 76;
      const by = y0 + h - bh - 44;
      const nB = mode === "dialog" ? 2 : 1;
      for (let i = 0; i < nB; i++) {
        const bx = cx - (nB * bw + (nB - 1) * 30) / 2 + i * (bw + 30);
        ctx.strokeRect(bx, by, bw, bh);
        if (i === 0) ctx.strokeRect(bx + 10, by + 10, bw - 20, bh - 20);
        else ctx.fillRect(bx + bw * 0.25, by + bh / 2 - 10, bw * 0.5, 20);
      }
    }
  }

  if (id === "wireship") {
    // Spacewar!-era vector display: thin wireframes on a starfield
    const mode = pick(["rocket", "orbit", "asteroids"] as const);
    // starfield hugs the subject so the trimmed motif stays subject-sized
    for (let i = randInt(28, 60); i > 0; i--) {
      const a = rand(0, TAU);
      const d = rand(120, 470);
      ctx.beginPath();
      ctx.arc(cx + d * Math.cos(a), cy + d * Math.sin(a), rand(4, 8), 0, TAU);
      ctx.fill();
    }
    ctx.lineWidth = rand(8, 12);
    const tri = (tx: number, ty: number, r: number, rot: number) => {
      ctx.save();
      ctx.translate(tx, ty);
      ctx.rotate(rot);
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.65, r * 0.75);
      ctx.lineTo(0, r * 0.35);
      ctx.lineTo(-r * 0.65, r * 0.75);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    };
    if (mode === "rocket") {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rand(-0.5, 0.5));
      const L = rand(400, 500);
      const W = rand(140, 190);
      ctx.beginPath();
      ctx.moveTo(0, -L / 2);
      ctx.quadraticCurveTo(W / 2, -L / 6, W / 2, L / 3);
      ctx.lineTo(-W / 2, L / 3);
      ctx.quadraticCurveTo(-W / 2, -L / 6, 0, -L / 2);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath(); // fins
      ctx.moveTo(W / 2, L / 8);
      ctx.lineTo(W, L / 2.2);
      ctx.lineTo(W / 2, L / 3);
      ctx.moveTo(-W / 2, L / 8);
      ctx.lineTo(-W, L / 2.2);
      ctx.lineTo(-W / 2, L / 3);
      ctx.stroke();
      ctx.beginPath(); // porthole
      ctx.arc(0, -L / 8, W * 0.22, 0, TAU);
      ctx.stroke();
      for (let i = 0; i < 3; i++) {
        // thrust dashes
        ctx.beginPath();
        ctx.moveTo((i - 1) * W * 0.25, L / 3 + 24);
        ctx.lineTo((i - 1) * W * 0.32, L / 3 + rand(80, 150));
        ctx.stroke();
      }
      ctx.restore();
    } else if (mode === "orbit") {
      const R = rand(150, 210);
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.stroke();
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rand(-0.6, 0.6));
      const ox = R * rand(1.7, 2.2);
      const oy = R * rand(0.5, 0.75);
      ctx.beginPath();
      ctx.ellipse(0, 0, ox, oy, 0, 0, TAU);
      ctx.stroke();
      const a = rand(0, TAU); // tiny craft riding the orbit
      tri(ox * Math.cos(a), oy * Math.sin(a), 46, a + Math.PI / 2);
      ctx.restore();
    } else {
      tri(cx, cy, rand(80, 110), rand(0, TAU));
      for (let k = randInt(3, 5); k > 0; k--) {
        const ax = rand(160, SIZE - 160);
        const ay = rand(160, SIZE - 160);
        if (Math.hypot(ax - cx, ay - cy) < 260) continue;
        const ar = rand(60, 130);
        ctx.beginPath();
        for (let i = 0; i <= 9; i++) {
          const t = (i / 9) * TAU;
          const rr = ar * rand(0.7, 1.15);
          const x = ax + rr * Math.cos(t);
          const y = ay + rr * Math.sin(t);
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
      }
    }
  }

  if (id === "mosaic") {
    // Million Dollar Homepage patchwork: packed pixel-ad blocks with gaps
    const n = pick([8, 10, 12]);
    const cell = (SIZE - 240) / n;
    const x0 = 120;
    const y0 = 120;
    const used = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        if (used[j][i] || chance(0.22)) continue;
        const spanW = chance(0.3) && i < n - 1 && !used[j][i + 1] ? 2 : 1;
        const spanH =
          chance(0.3) && j < n - 1 && !used[j + 1][i] && (spanW === 1 || !used[j + 1][i + 1])
            ? 2
            : 1;
        for (let b = 0; b < spanH; b++)
          for (let a = 0; a < spanW; a++) used[j + b][i + a] = true;
        const pad = cell * 0.08;
        const x = x0 + i * cell + pad;
        const y = y0 + j * cell + pad;
        const w = cell * spanW - pad * 2;
        const h = cell * spanH - pad * 2;
        if (chance(0.55)) ctx.fillRect(x, y, w, h);
        else {
          ctx.lineWidth = rand(8, 16);
          ctx.strokeRect(x + 8, y + 8, w - 16, h - 16);
        }
      }
  }

  return trim(c);
}

// ── type generator: random font × setting × case, Space Type-style ──────

export async function runTypeGenerator(
  text: string,
  fontPool: string[]
): Promise<{ dataURL: string; aspect: number; recipe: string }> {
  const word = text.trim() || "Bayside";
  const font = fontPool[Math.floor(Math.random() * fontPool.length)] ?? "Georgia";
  const styles: TextStyle[] = ["straight", "arch", "wave", "circle", "stack"];
  const style = styles[Math.floor(Math.random() * styles.length)];
  const casing = Math.random() < 0.45 ? "upper" : Math.random() < 0.5 ? "lower" : "as-is";
  const cased =
    casing === "upper" ? word.toUpperCase() : casing === "lower" ? word.toLowerCase() : word;
  const out = await renderText(cased, font, style);
  return { ...out, recipe: `${font} · ${style}` };
}

// ── Space Type-style text setting ────────────────────────────────────────

export type TextStyle = "straight" | "arch" | "wave" | "circle" | "stack";

export const TEXT_STYLES: { id: TextStyle; label: string }[] = [
  { id: "straight", label: "Straight" },
  { id: "arch", label: "Arch" },
  { id: "wave", label: "Wave" },
  { id: "circle", label: "Circle" },
  { id: "stack", label: "Stack" },
];


/** Clean up a photographed pencil/pen drawing into a crisp transparent
 *  graphic: Otsu threshold on luminance, speckle removal, solid ink. The
 *  free version of the "turn my drawing into a graphic" job. */
export async function cleanDrawing(dataURL: string): Promise<string> {
  const img = new Image();
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("img")); img.src = dataURL; });
  const s = Math.min(1, 1400 / Math.max(img.width, img.height));
  const w = Math.max(2, Math.round(img.width * s)), h = Math.max(2, Math.round(img.height * s));
  const { c, ctx } = makeCanvas(w, h);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const im = ctx.getImageData(0, 0, w, h);
  const d = im.data;
  const n = w * h;
  // luminance + histogram
  const lum = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const v = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
    lum[i] = v;
    hist[v]++;
  }
  // Otsu threshold
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 127, bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > bestVar) { bestVar = v; best = t; }
  }
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) ink[i] = lum[i] < best ? 1 : 0;
  // speckle removal: drop connected ink components smaller than ~0.02% of the image
  const minKeep = Math.max(12, Math.round(n * 0.0002));
  const label = new Int32Array(n).fill(0);
  const stack: number[] = [];
  let comp = 0;
  for (let i = 0; i < n; i++) {
    if (!ink[i] || label[i]) continue;
    comp++;
    let size = 0;
    const members: number[] = [];
    stack.push(i);
    label[i] = comp;
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      members.push(p);
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && ink[p - 1] && !label[p - 1]) { label[p - 1] = comp; stack.push(p - 1); }
      if (x < w - 1 && ink[p + 1] && !label[p + 1]) { label[p + 1] = comp; stack.push(p + 1); }
      if (y > 0 && ink[p - w] && !label[p - w]) { label[p - w] = comp; stack.push(p - w); }
      if (y < h - 1 && ink[p + w] && !label[p + w]) { label[p + w] = comp; stack.push(p + w); }
    }
    if (size < minKeep) for (const m of members) ink[m] = 0;
  }
  // solid ink on transparency
  for (let i = 0; i < n; i++) {
    if (ink[i]) { d[i * 4] = 17; d[i * 4 + 1] = 17; d[i * 4 + 2] = 17; d[i * 4 + 3] = 255; }
    else d[i * 4 + 3] = 0;
  }
  ctx.putImageData(im, 0, 0);
  return trim(c).dataURL;
}

export async function renderText(
  text: string,
  font: string,
  style: TextStyle,
  curveDeg = 126,
  outline = false,
): Promise<{ dataURL: string; aspect: number }> {
  const FS = 220;
  await document.fonts.load(`${FS}px "${font}"`).catch(() => {});
  const setFont = (ctx: CanvasRenderingContext2D) => {
    ctx.font = `${FS}px "${font}"`;
    ctx.fillStyle = INK;
    ctx.strokeStyle = INK;
    ctx.lineWidth = FS * 0.055; // outline mode: letterforms as strokes
    ctx.lineJoin = "round";
  };
  // outline = letterforms drawn as strokes only (open centers) — a real
  // vinyl-friendly style that stays recolorable like everything else
  const draw = (ctx: CanvasRenderingContext2D, ch: string, x: number, y: number) =>
    outline ? ctx.strokeText(ch, x, y) : ctx.fillText(ch, x, y);

  if (style === "straight" || style === "stack") {
    const lines =
      style === "stack"
        ? Array.from({ length: 5 }, () => text.replace(/\n/g, " "))
        : text.split("\n");
    const leading = style === "stack" ? FS * 0.92 : FS * 1.18;
    const measure = document.createElement("canvas").getContext("2d")!;
    setFont(measure);
    const w = Math.ceil(Math.max(...lines.map((l) => measure.measureText(l).width))) + 80;
    const h = Math.ceil(lines.length * leading + FS * 0.4) + 80;
    const { c, ctx } = makeCanvas(w, h);
    setFont(ctx);
    ctx.textBaseline = "top";
    lines.forEach((l, i) => draw(ctx, l, 40, 40 + i * leading));
    return trim(c);
  }

  // path styles work on a single line. Split into GRAPHEME CLUSTERS, not
  // UTF-16 units - emoji, flags, and combining accents are one drawn glyph
  // (indexing the string directly split surrogate pairs into two boxes).
  const line = text.replace(/\n/g, " ");
  const glyphs =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line)].map((g) => g.segment)
      : [...line];
  const measure = document.createElement("canvas").getContext("2d")!;
  setFont(measure);
  const widths = glyphs.map((ch) => measure.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0);

  const big = Math.max(2400, Math.ceil(total * 1.2));
  const { c, ctx } = makeCanvas(big, big);
  setFont(ctx);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const cx = big / 2;
  const cy = big / 2;

  if (style === "arch") {
    // positive curve = rainbow (∩); negative = valley (∪), the classic
    // tattoo-script layout where the ends sweep upward
    const down = curveDeg < 0;
    const span = Math.max(0.35, Math.min(Math.PI * 1.8, (Math.abs(curveDeg) * Math.PI) / 180));
    const R = Math.max(total / span, FS * 1.6);
    if (down) {
      let a = Math.PI / 2 + span / 2;
      for (let i = 0; i < glyphs.length; i++) {
        const half = (widths[i] / 2 / total) * span;
        a -= half;
        ctx.save();
        ctx.translate(cx + R * Math.cos(a), cy - FS + R * Math.sin(a));
        ctx.rotate(a - Math.PI / 2);
        draw(ctx, glyphs[i], 0, 0);
        ctx.restore();
        a -= half;
      }
    } else {
      let a = -Math.PI / 2 - span / 2;
      for (let i = 0; i < glyphs.length; i++) {
        const half = (widths[i] / 2 / total) * span;
        a += half;
        ctx.save();
        ctx.translate(cx + R * Math.cos(a), cy + FS + R * Math.sin(a));
        ctx.rotate(a + Math.PI / 2);
        draw(ctx, glyphs[i], 0, 0);
        ctx.restore();
        a += half;
      }
    }
  }

  if (style === "circle") {
    const R = Math.max(total / TAU, FS * 1.2);
    let a = -Math.PI / 2;
    for (let i = 0; i < glyphs.length; i++) {
      const half = (widths[i] / 2 / R) * 1;
      a += half;
      ctx.save();
      ctx.translate(cx + R * Math.cos(a), cy + R * Math.sin(a));
      ctx.rotate(a + Math.PI / 2);
      draw(ctx, glyphs[i], 0, 0);
      ctx.restore();
      a += half;
    }
  }

  if (style === "wave") {
    const amp = FS * 0.32;
    const freq = TAU / total;
    let x = cx - total / 2;
    for (let i = 0; i < glyphs.length; i++) {
      const xc = x + widths[i] / 2;
      const rel = xc - (cx - total / 2);
      const y = cy + amp * Math.sin(rel * freq);
      const slope = amp * freq * Math.cos(rel * freq);
      ctx.save();
      ctx.translate(xc, y);
      ctx.rotate(Math.atan(slope));
      draw(ctx, glyphs[i], 0, 0);
      ctx.restore();
      x += widths[i];
    }
  }

  return trim(c);
}
