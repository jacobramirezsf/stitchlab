// QR Studio - a fully client-side QR code generator. The link is encoded
// into the pattern itself (a STATIC code), so it never expires and no
// third-party service sits in the middle.
//
// Customization is deliberately limited to what scanners provably tolerate:
// decoders binarize dark-vs-light and find the three eyes, so module SHAPE,
// ink GRADIENTS between two dark colors, separate EYE color, connected
// "liquid" modules, a bounded module-size dial, and a frame/label OUTSIDE
// the quiet zone all keep codes readable. A contrast guard + an in-browser
// scan self-test back that up. Exports PNG, 300ppi print PNG, and SVG.
//
// Encoding: qrcode-generator (zero-dep). We only take the module matrix and
// draw everything ourselves - that's what makes the styling possible.
// Style state can be seeded from URL params (shareable presets).

import jsQR from "jsqr";
import { useEffect, useMemo, useRef, useState } from "react";
import qrcodegen from "qrcode-generator";
import { DropZone, ModeButtons, RangeRow, SectionBox, LABEL } from "./shared";
import { canvasToPngPpi } from "../lib/png";
import { saveBlob } from "../lib/native";

type Ec = "L" | "M" | "Q" | "H";
type ModuleShape = "square" | "rounded" | "dots" | "diamond" | "liquid";
type EyeShape = "square" | "rounded" | "round";
type Gradient = "none" | "linear" | "radial";
type Frame = "none" | "border" | "label";
type LogoPlate = "rounded" | "circle" | "none";

const luminance = (hex: string): number => {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
};

function buildMatrix(text: string, ec: Ec): boolean[][] | null {
  try {
    const qr = qrcodegen(0, ec);
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const m: boolean[][] = [];
    for (let r = 0; r < n; r++) {
      const row: boolean[] = [];
      for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
      m.push(row);
    }
    return m;
  } catch {
    return null;
  }
}

const inFinder = (r: number, c: number, n: number): boolean =>
  (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);

// Modules that must stay SOLID under halftoning: finders, the timing row/col,
// and the format-info strips beside the finders. Everything else can carry
// image subcells because decoders sample module centers (+ EC covers noise).
const keepSolid = (r: number, c: number, n: number): boolean =>
  inFinder(r, c, n) ||
  r === 6 ||
  c === 6 ||
  (r < 9 && c < 9) ||
  (r < 9 && c >= n - 8) ||
  (r >= n - 8 && c < 9);

// 3×3 Bayer matrix for ordered dithering of the halftone subcells
const BAYER3 = [
  [0, 7, 3],
  [6, 5, 2],
  [4, 1, 8],
];

/** Sample an image into an n*3 × n*3 luminance grid (0..1). */
function sampleLuma(img: HTMLImageElement, n: number): Float32Array {
  const size = n * 3;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  // cover-fit the image into the square
  const s = Math.max(size / img.naturalWidth, size / img.naturalHeight);
  const w = img.naturalWidth * s;
  const h = img.naturalHeight * s;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
  const d = ctx.getImageData(0, 0, size, size).data;
  const out = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    out[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
  }
  return out;
}

type Style = {
  moduleShape: ModuleShape;
  eyeShape: EyeShape;
  fg: string;
  fg2: string; // gradient end color
  gradient: Gradient;
  eyeColor: string; // "" = same as ink
  bg: string;
  transparent: boolean;
  quiet: number;
  moduleSize: number; // 0.7–1: fraction of nominal module footprint
  frame: Frame;
  label: string;
  logo: HTMLImageElement | null;
  logoScale: number;
  logoPlate: LogoPlate;
  halftoneImg: HTMLImageElement | null; // photo dithered into the modules
  halftoneBias: number; // -0.3..0.3 darkness bias
};

// frame geometry in module units (outside the quiet zone — never affects scan)
const FRAME_PAD_U = 1.6;
const LABEL_BAND_U = 3.4;

const frameUnits = (s: Style) => ({
  pad: s.frame === "none" ? 0 : FRAME_PAD_U,
  band: s.frame === "label" && s.label.trim() ? LABEL_BAND_U : 0,
});

/** True output dimensions for a requested TOTAL width: the frame pad and the
 *  label band are part of the artwork, so exports are sized (and named) by
 *  what actually lands in the file - never just the code body. */
function exportDims(matrixN: number, s: Style, totalWidthPx: number) {
  const totalUnits = matrixN + s.quiet * 2;
  const { pad, band } = frameUnits(s);
  // totalWidth = body + 2*pad*cell, cell = body/totalUnits
  const bodyPx = totalWidthPx / (1 + (2 * pad) / totalUnits);
  const cell = bodyPx / totalUnits;
  return {
    bodyPx,
    width: Math.round(bodyPx + pad * cell * 2),
    height: Math.round(bodyPx + pad * cell * 2 + band * cell),
  };
}

// ── canvas rendering ─────────────────────────────────────────────────────

function drawCanvas(canvas: HTMLCanvasElement, matrix: boolean[][], px: number, s: Style): void {
  const n = matrix.length;
  const total = n + s.quiet * 2;
  const cell = px / total;
  const { pad, band } = frameUnits(s);
  const padPx = pad * cell;
  const bandPx = band * cell;
  canvas.width = Math.round(px + padPx * 2);
  canvas.height = Math.round(px + padPx * 2 + bandPx);
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!s.transparent) {
    ctx.fillStyle = s.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  const inkFill = (): string | CanvasGradient => {
    if (s.gradient === "linear") {
      const g = ctx.createLinearGradient(padPx, padPx, padPx + px, padPx + px);
      g.addColorStop(0, s.fg);
      g.addColorStop(1, s.fg2);
      return g;
    }
    if (s.gradient === "radial") {
      const cx = padPx + px / 2;
      const g = ctx.createRadialGradient(cx, cx, px * 0.1, cx, cx, px * 0.62);
      g.addColorStop(0, s.fg);
      g.addColorStop(1, s.fg2);
      return g;
    }
    return s.fg;
  };
  ctx.fillStyle = inkFill();

  const at = (rc: number) => padPx + (rc + s.quiet) * cell;
  const m = Math.max(0.7, Math.min(1, s.moduleSize));

  // ── halftone mode: each free module = 3×3 subcells; center carries the QR
  // bit, the ring renders the dithered photo ──
  if (s.halftoneImg) {
    const luma = sampleLuma(s.halftoneImg, n);
    const size = n * 3;
    const sub = cell / 3;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (inFinder(r, c, n)) continue;
        const x = at(c);
        const y = at(r);
        if (keepSolid(r, c, n)) {
          if (matrix[r][c]) ctx.fillRect(x, y, cell + 0.5, cell + 0.5);
          continue;
        }
        // importance blending (the halftone-QR trick): where the photo and
        // the data AGREE, render the full module — where they disagree, the
        // photo lives in the ring and an oversized center carries the bit
        const li0 = (r * 3 + 1) * size + (c * 3 + 1);
        const modLuma =
          (luma[li0] + luma[li0 - 1] + luma[li0 + 1] + luma[li0 - size] + luma[li0 + size]) / 5 +
          s.halftoneBias;
        const dark = matrix[r][c];
        if (dark && modLuma < 0.5) {
          ctx.fillRect(x, y, cell + 0.4, cell + 0.4); // agree: solid dark
        } else if (!dark && modLuma >= 0.5) {
          // agree: leave light (ring stays empty)
        } else {
          // disagree: dithered ring + dominant center bit
          ctx.globalAlpha = 0.72;
          for (let sr = 0; sr < 3; sr++) {
            for (let sc = 0; sc < 3; sc++) {
              if (sr === 1 && sc === 1) continue;
              const li = (r * 3 + sr) * size + (c * 3 + sc);
              const threshold = (BAYER3[sr][sc] + 0.5) / 9;
              if (luma[li] + s.halftoneBias < threshold) {
                ctx.fillRect(x + sc * sub, y + sr * sub, sub + 0.4, sub + 0.4);
              }
            }
          }
          ctx.globalAlpha = 1;
          const dotW = cell * 0.58;
          if (dark) {
            ctx.fillRect(x + (cell - dotW) / 2, y + (cell - dotW) / 2, dotW, dotW);
          } else if (!s.transparent) {
            const keep: string | CanvasGradient | CanvasPattern = ctx.fillStyle;
            ctx.fillStyle = s.bg;
            ctx.fillRect(x + (cell - dotW) / 2, y + (cell - dotW) / 2, dotW, dotW);
            ctx.fillStyle = keep;
          } else {
            ctx.clearRect(x + (cell - dotW) / 2, y + (cell - dotW) / 2, dotW, dotW);
          }
        }
      }
    }
  } else
  // data modules
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!matrix[r][c] || inFinder(r, c, n)) continue;
      const x = at(c);
      const y = at(r);
      ctx.beginPath();
      if (s.moduleShape === "square") {
        const w = cell * m;
        const i = (cell - w) / 2;
        ctx.rect(x + i, y + i, w + (m === 1 ? 0.5 : 0), w + (m === 1 ? 0.5 : 0));
      } else if (s.moduleShape === "rounded") {
        const w = cell * 0.88 * m;
        const i = (cell - w) / 2;
        ctx.roundRect(x + i, y + i, w, w, w * 0.34);
      } else if (s.moduleShape === "dots") {
        ctx.arc(x + cell / 2, y + cell / 2, cell * 0.5 * 0.84 * Math.max(m, 0.9), 0, Math.PI * 2);
      } else if (s.moduleShape === "diamond") {
        const h = (cell / 2) * 0.92 * m;
        ctx.moveTo(x + cell / 2, y + cell / 2 - h);
        ctx.lineTo(x + cell / 2 + h, y + cell / 2);
        ctx.lineTo(x + cell / 2, y + cell / 2 + h);
        ctx.lineTo(x + cell / 2 - h, y + cell / 2);
      } else {
        // liquid: rounded module + bridges to dark right/down neighbors
        const w = cell * 0.9;
        const i = (cell - w) / 2;
        ctx.roundRect(x + i, y + i, w, w, w * 0.45);
        if (c + 1 < n && matrix[r][c + 1] && !inFinder(r, c + 1, n)) ctx.rect(x + cell / 2, y + i, cell, w);
        if (r + 1 < n && matrix[r + 1][c] && !inFinder(r + 1, c, n)) ctx.rect(x + i, y + cell / 2, w, cell);
      }
      ctx.fill();
    }
  }

  // eyes (optionally their own solid color)
  if (s.eyeColor) ctx.fillStyle = s.eyeColor;
  const eye = (er: number, ec2: number) => {
    const x = at(ec2);
    const y = at(er);
    const seven = cell * 7;
    const three = cell * 3;
    ctx.beginPath();
    if (s.eyeShape === "round") {
      ctx.roundRect(x, y, seven, seven, cell * 2.2);
      ctx.roundRect(x + cell, y + cell, seven - cell * 2, seven - cell * 2, cell * 1.5);
      ctx.fill("evenodd");
      ctx.beginPath();
      ctx.roundRect(x + cell * 2, y + cell * 2, three, three, cell * 1.1);
      ctx.fill();
    } else if (s.eyeShape === "rounded") {
      ctx.roundRect(x, y, seven, seven, cell * 1.6);
      ctx.roundRect(x + cell, y + cell, seven - cell * 2, seven - cell * 2, cell * 1.1);
      ctx.fill("evenodd");
      ctx.beginPath();
      ctx.roundRect(x + cell * 2, y + cell * 2, three, three, cell * 0.8);
      ctx.fill();
    } else {
      ctx.rect(x, y, seven, seven);
      ctx.rect(x + cell, y + cell, seven - cell * 2, seven - cell * 2);
      ctx.fill("evenodd");
      ctx.beginPath();
      ctx.rect(x + cell * 2, y + cell * 2, three, three);
      ctx.fill();
    }
  };
  eye(0, 0);
  eye(0, n - 7);
  eye(n - 7, 0);
  ctx.fillStyle = inkFill();

  // frame + label (fully outside the quiet zone)
  if (s.frame !== "none") {
    ctx.strokeStyle = s.eyeColor || s.fg;
    ctx.lineWidth = cell * 0.45;
    const off = ctx.lineWidth;
    ctx.strokeRect(off / 2, off / 2, canvas.width - off, canvas.height - off);
    if (s.frame === "label" && s.label.trim()) {
      ctx.fillStyle = s.eyeColor || s.fg;
      ctx.font = `700 ${bandPx * 0.52}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(s.label.trim().slice(0, 40), canvas.width / 2, px + padPx * 2 + bandPx * 0.42);
    }
  }

  // center logo on its plate
  if (s.logo) {
    const w = px * s.logoScale;
    const platePad = w * 0.12;
    const x = padPx + (px - w) / 2;
    if (s.logoPlate !== "none") {
      ctx.fillStyle = s.transparent ? "#ffffff" : s.bg;
      ctx.beginPath();
      if (s.logoPlate === "circle") ctx.arc(x + w / 2, x + w / 2, w / 2 + platePad, 0, Math.PI * 2);
      else ctx.roundRect(x - platePad, x - platePad, w + platePad * 2, w + platePad * 2, w * 0.18);
      ctx.fill();
    }
    ctx.drawImage(s.logo, x, x, w, w);
  }
}

// ── SVG rendering (same geometry, vector) ────────────────────────────────

function toSvg(matrix: boolean[][], s: Style): string {
  const n = matrix.length;
  const total = n + s.quiet * 2;
  const { pad, band } = frameUnits(s);
  const W = total + pad * 2;
  const H = total + pad * 2 + band;
  const ink = s.gradient === "none" ? s.fg : "url(#qg)";
  const eyeInk = s.eyeColor || (s.gradient === "none" ? s.fg : "url(#qg)");
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" shape-rendering="geometricPrecision">`,
  ];
  if (s.gradient !== "none") {
    parts.push(
      s.gradient === "linear"
        ? `<defs><linearGradient id="qg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${s.fg}"/><stop offset="1" stop-color="${s.fg2}"/></linearGradient></defs>`
        : `<defs><radialGradient id="qg" cx=".5" cy=".5" r=".65"><stop offset="0" stop-color="${s.fg}"/><stop offset="1" stop-color="${s.fg2}"/></radialGradient></defs>`
    );
  }
  if (!s.transparent) parts.push(`<rect width="${W}" height="${H}" fill="${s.bg}"/>`);
  const q = s.quiet + pad;
  const m = Math.max(0.7, Math.min(1, s.moduleSize));
  const els: string[] = [];
  if (s.halftoneImg) {
    const luma = sampleLuma(s.halftoneImg, n);
    const size = n * 3;
    const third = 1 / 3;
    const d: string[] = [];
    const solid: string[] = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (inFinder(r, c, n)) continue;
        const x = c + q;
        const y = r + q;
        if (keepSolid(r, c, n)) {
          if (matrix[r][c]) solid.push(`M${x} ${y}h1v1h-1z`);
          continue;
        }
        const li0 = (r * 3 + 1) * size + (c * 3 + 1);
        const modLuma =
          (luma[li0] + luma[li0 - 1] + luma[li0 + 1] + luma[li0 - size] + luma[li0 + size]) / 5 +
          s.halftoneBias;
        const dark = matrix[r][c];
        if (dark && modLuma < 0.5) {
          solid.push(`M${x} ${y}h1v1h-1z`);
        } else if (!dark && modLuma >= 0.5) {
          // agree-light: nothing
        } else {
          for (let sr = 0; sr < 3; sr++) {
            for (let sc = 0; sc < 3; sc++) {
              if (sr === 1 && sc === 1) continue;
              const li = (r * 3 + sr) * size + (c * 3 + sc);
              if (luma[li] + s.halftoneBias < (BAYER3[sr][sc] + 0.5) / 9) {
                d.push(`M${(x + sc * third).toFixed(3)} ${(y + sr * third).toFixed(3)}h${third.toFixed(3)}v${third.toFixed(3)}h-${third.toFixed(3)}z`);
              }
            }
          }
          if (dark) els.push(`<rect x="${(x + 0.21).toFixed(2)}" y="${(y + 0.21).toFixed(2)}" width=".58" height=".58" fill="${ink}"/>`);
          else if (!s.transparent)
            els.push(`<rect x="${(x + 0.21).toFixed(2)}" y="${(y + 0.21).toFixed(2)}" width=".58" height=".58" fill="${s.bg}"/>`);
        }
      }
    }
    // dark cells first, then light center plates on top
    els.unshift(`<path d="${solid.join("")}" fill="${ink}"/>`);
    els.unshift(`<path d="${d.join("")}" fill="${ink}" fill-opacity=".72"/>`);
    parts.push(els.join(""));
    els.length = 0;
  } else
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!matrix[r][c] || inFinder(r, c, n)) continue;
      const x = c + q;
      const y = r + q;
      if (s.moduleShape === "square") {
        const w = m;
        const i = (1 - w) / 2;
        els.push(`<rect x="${x + i}" y="${y + i}" width="${w}" height="${w}" fill="${ink}"/>`);
      } else if (s.moduleShape === "rounded") {
        const w = 0.88 * m;
        const i = (1 - w) / 2;
        els.push(`<rect x="${x + i}" y="${y + i}" width="${w}" height="${w}" rx="${w * 0.34}" fill="${ink}"/>`);
      } else if (s.moduleShape === "dots") {
        els.push(`<circle cx="${x + 0.5}" cy="${y + 0.5}" r="${0.5 * 0.84 * Math.max(m, 0.9)}" fill="${ink}"/>`);
      } else if (s.moduleShape === "diamond") {
        const h = 0.5 * 0.92 * m;
        els.push(
          `<path d="M${x + 0.5} ${y + 0.5 - h}L${x + 0.5 + h} ${y + 0.5}L${x + 0.5} ${y + 0.5 + h}L${x + 0.5 - h} ${y + 0.5}z" fill="${ink}"/>`
        );
      } else {
        const w = 0.9;
        const i = (1 - w) / 2;
        els.push(`<rect x="${x + i}" y="${y + i}" width="${w}" height="${w}" rx="${w * 0.45}" fill="${ink}"/>`);
        if (c + 1 < n && matrix[r][c + 1] && !inFinder(r, c + 1, n))
          els.push(`<rect x="${x + 0.5}" y="${y + i}" width="1" height="${w}" fill="${ink}"/>`);
        if (r + 1 < n && matrix[r + 1][c] && !inFinder(r + 1, c, n))
          els.push(`<rect x="${x + i}" y="${y + 0.5}" width="${w}" height="1" fill="${ink}"/>`);
      }
    }
  }
  parts.push(els.join(""));
  const eyeSvg = (er: number, ec2: number): string => {
    const x = ec2 + q;
    const y = er + q;
    if (s.eyeShape === "round")
      return (
        `<circle cx="${x + 3.5}" cy="${y + 3.5}" r="3" fill="none" stroke="${eyeInk}" stroke-width="1"/>` +
        `<circle cx="${x + 3.5}" cy="${y + 3.5}" r="1.5" fill="${eyeInk}"/>`
      );
    if (s.eyeShape === "rounded")
      return (
        `<rect x="${x + 0.5}" y="${y + 0.5}" width="6" height="6" rx="1.4" fill="none" stroke="${eyeInk}" stroke-width="1"/>` +
        `<rect x="${x + 2}" y="${y + 2}" width="3" height="3" rx=".8" fill="${eyeInk}"/>`
      );
    return (
      `<rect x="${x + 0.5}" y="${y + 0.5}" width="6" height="6" fill="none" stroke="${eyeInk}" stroke-width="1"/>` +
      `<rect x="${x + 2}" y="${y + 2}" width="3" height="3" fill="${eyeInk}"/>`
    );
  };
  parts.push(eyeSvg(0, 0), eyeSvg(0, n - 7), eyeSvg(n - 7, 0));
  if (s.frame !== "none") {
    parts.push(
      `<rect x="0.225" y="0.225" width="${W - 0.45}" height="${H - 0.45}" fill="none" stroke="${s.eyeColor || s.fg}" stroke-width="0.45"/>`
    );
    if (s.frame === "label" && s.label.trim()) {
      parts.push(
        `<text x="${W / 2}" y="${total + pad * 2 + band * 0.55}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-weight="700" font-size="${band * 0.52}" fill="${s.eyeColor || s.fg}">${s.label
          .trim()
          .slice(0, 40)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")}</text>`
      );
    }
  }
  parts.push("</svg>");
  return parts.join("");
}

// ── the tool ─────────────────────────────────────────────────────────────

const param = (k: string, fallback: string): string =>
  new URLSearchParams(window.location.search).get(k) ?? fallback;

export default function QrTool() {
  const [text, setText] = useState(() => param("text", "https://www.baysidesf.org"));
  const [ec, setEc] = useState<Ec>("M");
  const [moduleShape, setModuleShape] = useState<ModuleShape>(() => param("mod", "rounded") as ModuleShape);
  const [eyeShape, setEyeShape] = useState<EyeShape>(() => param("eye", "rounded") as EyeShape);
  const [fg, setFg] = useState(() => `#${param("ink", "26324d").replace("#", "")}`);
  const [fg2, setFg2] = useState(() => `#${param("ink2", "7c3aed").replace("#", "")}`);
  const [gradient, setGradient] = useState<Gradient>(() => param("grad", "none") as Gradient);
  const [eyeColor, setEyeColor] = useState(() => (param("eyec", "") ? `#${param("eyec", "").replace("#", "")}` : ""));
  const [bg, setBg] = useState("#ffffff");
  const [transparent, setTransparent] = useState(false);
  const [quiet, setQuiet] = useState(3);
  const [moduleSize, setModuleSize] = useState(() => Number(param("msize", "1")) || 1);
  const [frame, setFrame] = useState<Frame>(() => param("frame", "none") as Frame);
  const [labelText, setLabelText] = useState(() => param("label", "SCAN ME"));
  const [logo, setLogo] = useState<HTMLImageElement | null>(null);
  const [logoScale, setLogoScale] = useState(0.2);
  const [logoPlate, setLogoPlate] = useState<LogoPlate>("rounded");
  const [halftoneImg, setHalftoneImg] = useState<HTMLImageElement | null>(null);
  const [halftoneBias, setHalftoneBias] = useState(0);

  // hidden test hook: ?demo=halftone synthesizes a portrait-ish test image so
  // the halftone path can be exercised (and decode-verified) without an upload
  useEffect(() => {
    if (param("demo", "") !== "halftone") return;
    const c = document.createElement("canvas");
    c.width = 240;
    c.height = 240;
    const ctx = c.getContext("2d")!;
    const g = ctx.createRadialGradient(120, 100, 20, 120, 130, 160);
    g.addColorStop(0, "#f2f2f2");
    g.addColorStop(0.5, "#9a9a9a");
    g.addColorStop(1, "#1a1a1a");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 240, 240);
    const img = new Image();
    img.onload = () => setHalftoneImg(img);
    img.src = c.toDataURL();
  }, []);
  const [exportPx, setExportPx] = useState(1200);
  const [stillIn, setStillIn] = useState(3);
  const [busy, setBusy] = useState<string | null>(null);
  /** Scan self-test against the EXPORT raster (not the preview):
   *  pending → passed/failed, or unavailable when no decoder can run. */
  const [scan, setScan] = useState<"pending" | "passed" | "failed" | "unavailable">("pending");
  const scanToken = useRef(0);
  const previewRef = useRef<HTMLCanvasElement>(null);

  const effEc: Ec = logo || halftoneImg ? "H" : ec; // both eat modules — max EC
  const matrix = useMemo(() => buildMatrix(text.trim() || " ", effEc), [text, effEc]);
  const style: Style = useMemo(
    () => ({ moduleShape, eyeShape, fg, fg2, gradient, eyeColor, bg, transparent, quiet, moduleSize, frame, label: labelText, logo, logoScale, logoPlate, halftoneImg, halftoneBias }),
    [moduleShape, eyeShape, fg, fg2, gradient, eyeColor, bg, transparent, quiet, moduleSize, frame, labelText, logo, logoScale, logoPlate, halftoneImg, halftoneBias]
  );

  // contrast guard: EVERY ink involved must clear the background
  const bgLum = transparent ? 1 : luminance(bg);
  const inks = [fg, ...(gradient !== "none" ? [fg2] : []), ...(eyeColor ? [eyeColor] : [])];
  const contrastOk = inks.every((c) => Math.abs(luminance(c) - bgLum) > 0.4);

  useEffect(() => {
    const c = previewRef.current;
    if (!c || !matrix) return;
    drawCanvas(c, matrix, 560, style);
    // Validate the raster that will actually be exported, at the requested
    // export size - a code that reads at 560px preview can still fail small.
    const token = ++scanToken.current;
    setScan("pending");
    const t = setTimeout(async () => {
      const target = document.createElement("canvas");
      const dims = exportDims(matrix.length, style, exportPx);
      drawCanvas(target, matrix, dims.bodyPx, style);
      const want = text.trim();
      const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect: (i: HTMLCanvasElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
      let result: "passed" | "failed" | "unavailable" = "unavailable";
      if (BD) {
        try {
          const codes = await new BD({ formats: ["qr_code"] }).detect(target);
          result = codes.some((x) => x.rawValue === want) ? "passed" : "failed";
        } catch {
          result = "unavailable";
        }
      }
      if (result === "unavailable") {
        // fallback decoder so Firefox/Safari still get a real answer
        try {
          const ctx = target.getContext("2d");
          if (ctx) {
            const img = ctx.getImageData(0, 0, target.width, target.height);
            const hit = jsQR(img.data, img.width, img.height);
            result = hit ? (hit.data === want ? "passed" : "failed") : "failed";
          }
        } catch {
          result = "unavailable";
        }
      }
      // a newer design may have started scanning meanwhile - never let a
      // stale result describe it
      if (scanToken.current === token) setScan(result);
    }, 250);
    return () => clearTimeout(t);
  }, [matrix, style, text, exportPx]);

  const loadLogo = (f: File) => {
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      setLogo(img);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  const exportPng = async (ppi?: number) => {
    if (!matrix || busy) return;
    setBusy(ppi ? "Rendering 300ppi…" : "Rendering PNG…");
    try {
      const c = document.createElement("canvas");
      // Both sliders mean the TOTAL artwork width - frame and label included.
      const totalPx = ppi ? Math.round(stillIn * ppi) : exportPx;
      const dims = exportDims(matrix.length, style, totalPx);
      drawCanvas(c, matrix, dims.bodyPx, style);
      const blob = ppi ? await canvasToPngPpi(c, ppi) : await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej()), "image/png"));
      await saveBlob(blob, ppi ? `bayside-qr-${stillIn}in-wide-300ppi.png` : `bayside-qr-${dims.width}x${dims.height}px.png`);
    } catch {
      setBusy("Export failed - try again.");
    }
    setTimeout(() => setBusy(null), 1200);
  };

  const exportSvg = async () => {
    if (!matrix || busy) return;
    await saveBlob(new Blob([toSvg(matrix, style)], { type: "image/svg+xml" }), "bayside-qr.svg");
  };

  const copyPreset = () => {
    if (!matrix) return;
    const p = new URLSearchParams({
      text,
      mod: moduleShape,
      eye: eyeShape,
      ink: fg.slice(1),
      ...(gradient !== "none" ? { grad: gradient, ink2: fg2.slice(1) } : {}),
      ...(eyeColor ? { eyec: eyeColor.slice(1) } : {}),
      ...(moduleSize !== 1 ? { msize: String(moduleSize) } : {}),
      ...(frame !== "none" ? { frame, label: labelText } : {}),
    });
    void navigator.clipboard?.writeText(`${window.location.origin}/stitchlab?${p}#qrcode`);
    setBusy("Preset link copied.");
    setTimeout(() => setBusy(null), 1200);
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[340px_1fr]">
      <div className="min-w-0 space-y-2.5">
        <SectionBox eyebrow="Content">
          <textarea
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="https://… or any text"
            className="w-full bg-bg border border-hairline px-3 py-2 text-[0.875rem] text-fg outline-none focus:border-fg"
          />
          <p className="text-[0.6875rem] text-mid leading-relaxed">
            This is a static code: the link is baked into the pattern itself, so it never
            expires and no outside service is involved.
          </p>
          <div>
            <span className={LABEL}>Error correction</span>
            <div className="mt-1.5">
              <ModeButtons
                options={[["L", "L · small"], ["M", "M"], ["Q", "Q"], ["H", "H · sturdiest"]] as const}
                value={effEc}
                onChange={(v) => setEc(v)}
                small
              />
            </div>
            {logo ? <p className="mt-1 text-[0.6875rem] text-mid">Locked to H while a logo is set.</p> : null}
          </div>
        </SectionBox>

        <SectionBox eyebrow="Style">
          <span className={LABEL}>Modules</span>
          <ModeButtons
            options={[["square", "Square"], ["rounded", "Rounded"], ["dots", "Dots"], ["diamond", "Diamond"], ["liquid", "Liquid"]] as const}
            value={moduleShape}
            onChange={setModuleShape}
            small
          />
          {moduleShape !== "liquid" ? (
            <RangeRow label="Module size" value={moduleSize} min={0.7} max={1} step={0.02} onChange={setModuleSize} fmt={(v) => `${Math.round(v * 100)}%`} />
          ) : null}
          <span className={LABEL}>Eyes</span>
          <ModeButtons
            options={[["square", "Square"], ["rounded", "Rounded"], ["round", "Round"]] as const}
            value={eyeShape}
            onChange={setEyeShape}
            small
          />
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-2 text-[0.75rem] text-mid">
              Ink
              <input type="color" value={fg} onChange={(e) => setFg(e.target.value)} className="h-7 w-10 border border-hairline bg-bg" />
            </label>
            <label className="flex items-center gap-2 text-[0.75rem] text-mid">
              Eyes
              <input
                type="color"
                value={eyeColor || fg}
                onChange={(e) => setEyeColor(e.target.value)}
                className="h-7 w-10 border border-hairline bg-bg"
              />
            </label>
            {eyeColor ? (
              <button onClick={() => setEyeColor("")} className="text-[0.6875rem] text-mid underline underline-offset-2 hover:text-fg">
                match ink
              </button>
            ) : null}
          </div>
          <span className={LABEL}>Ink gradient</span>
          <ModeButtons
            options={[["none", "Solid"], ["linear", "Linear"], ["radial", "Radial"]] as const}
            value={gradient}
            onChange={setGradient}
            small
          />
          {gradient !== "none" ? (
            <label className="flex items-center gap-2 text-[0.75rem] text-mid">
              Second color
              <input type="color" value={fg2} onChange={(e) => setFg2(e.target.value)} className="h-7 w-10 border border-hairline bg-bg" />
            </label>
          ) : null}
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-2 text-[0.75rem] text-mid">
              Background
              <input type="color" value={bg} onChange={(e) => setBg(e.target.value)} disabled={transparent} className="h-7 w-10 border border-hairline bg-bg disabled:opacity-40" />
            </label>
            <label className="flex items-center gap-2 text-[0.75rem] text-mid cursor-pointer">
              <input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} className="accent-fg" />
              Transparent
            </label>
          </div>
          {!contrastOk ? (
            <p className="text-[0.6875rem] text-red-700">
              Low contrast — every ink (including gradient ends and eye color) needs to stand
              out from the background or phones will struggle.
            </p>
          ) : null}
          <RangeRow label="Quiet zone" value={quiet} min={0} max={8} step={1} onChange={setQuiet} fmt={(v) => `${v} modules`} />
        </SectionBox>

        <SectionBox eyebrow="Frame" defaultOpen={false}>
          <ModeButtons
            options={[["none", "None"], ["border", "Border"], ["label", "Border + label"]] as const}
            value={frame}
            onChange={setFrame}
            small
          />
          {frame === "label" ? (
            <input
              value={labelText}
              onChange={(e) => setLabelText(e.target.value)}
              placeholder="SCAN ME"
              className="w-full bg-bg border border-hairline px-3 py-2 text-[0.875rem] text-fg outline-none focus:border-fg"
            />
          ) : null}
          <p className="text-[0.6875rem] text-mid leading-relaxed">
            The frame sits outside the quiet zone, so it never affects scanning.
          </p>
        </SectionBox>

        <SectionBox eyebrow="Halftone photo" defaultOpen={false}>
          <DropZone onFile={(f) => {
            const url = URL.createObjectURL(f);
            const img = new Image();
            img.onload = () => { setHalftoneImg(img); URL.revokeObjectURL(url); };
            img.src = url;
          }} className="block">
            <label className="block border border-dashed border-hairline px-3 py-2.5 text-center text-[0.8125rem] text-mid cursor-pointer hover:border-fg">
              {halftoneImg ? "↻ Swap photo" : "Dither a photo into the code"}
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  const url = URL.createObjectURL(f);
                  const img = new Image();
                  img.onload = () => { setHalftoneImg(img); URL.revokeObjectURL(url); };
                  img.src = url;
                }}
              />
            </label>
          </DropZone>
          {halftoneImg ? (
            <>
              <RangeRow label="Darkness" value={halftoneBias} min={-0.3} max={0.3} step={0.02} onChange={setHalftoneBias} fmt={(v) => (v > 0 ? `+${Math.round(v * 100)}` : `${Math.round(v * 100)}`)} />
              <button onClick={() => setHalftoneImg(null)} className="text-[0.75rem] text-mid underline underline-offset-2 hover:text-fg">
                Remove photo
              </button>
              <p className="text-[0.6875rem] text-mid leading-relaxed">
                Each module's center still carries the real code (scanners sample module
                centers); the photo lives in the surrounding subcells. Error correction is
                locked to H, and module-shape settings don't apply while a photo is set.
                Faces and high-contrast images work best — check the scan test below.
              </p>
            </>
          ) : (
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              The classic halftone-QR trick: your photo dithered into the code itself,
              still scannable. Best with simple, high-contrast images.
            </p>
          )}
        </SectionBox>

        <SectionBox eyebrow="Center logo" defaultOpen={false}>
          <DropZone onFile={loadLogo} className="block">
            <label className="block border border-dashed border-hairline px-3 py-2.5 text-center text-[0.8125rem] text-mid cursor-pointer hover:border-fg">
              {logo ? "↻ Swap logo" : "Add a logo (optional)"}
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) loadLogo(f);
                }}
              />
            </label>
          </DropZone>
          {logo ? (
            <>
              <RangeRow label="Logo size" value={logoScale} min={0.12} max={0.26} step={0.01} onChange={setLogoScale} fmt={(v) => `${Math.round(v * 100)}%`} />
              <span className={LABEL}>Plate</span>
              <ModeButtons
                options={[["rounded", "Rounded"], ["circle", "Circle"], ["none", "None"]] as const}
                value={logoPlate}
                onChange={setLogoPlate}
                small
              />
              <button onClick={() => setLogo(null)} className="text-[0.75rem] text-mid underline underline-offset-2 hover:text-fg">
                Remove logo
              </button>
            </>
          ) : (
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Keep logos small — error correction covers the hidden modules, and the scan
              check tells you if it still reads.
            </p>
          )}
        </SectionBox>

        <SectionBox eyebrow="Export">
          <RangeRow label="PNG width" value={exportPx} min={400} max={3000} step={100} onChange={setExportPx} fmt={(v) => `${v}px total`} />
          <RangeRow label="Print width" value={stillIn} min={1} max={12} step={0.5} onChange={setStillIn} fmt={(v) => `${v}" total @300ppi`} />
          {matrix ? (() => {
            const d = exportDims(matrix.length, style, exportPx);
            const dp = exportDims(matrix.length, style, Math.round(stillIn * 300));
            return (
              <p className="text-[0.6875rem] text-mid leading-relaxed">
                PNG saves {d.width}×{d.height}px · print PNG saves {(dp.width / 300).toFixed(2)}×{(dp.height / 300).toFixed(2)}in
                {frameUnits(style).band ? " (label band included)" : frameUnits(style).pad ? " (frame included)" : ""}
              </p>
            );
          })() : null}
          <div className="flex flex-wrap gap-1.5">
            <button onClick={() => void exportPng()} className="border border-fg bg-fg text-bg px-3 py-1.5 text-[0.75rem] hover:opacity-85 disabled:opacity-40" disabled={!matrix || !!busy} title={!matrix ? "Shorten the content first - it exceeds QR capacity" : undefined}>
              PNG
            </button>
            <button onClick={() => void exportPng(300)} className="border border-hairline px-3 py-1.5 text-[0.75rem] hover:border-fg disabled:opacity-40" disabled={!matrix || !!busy} title={!matrix ? "Shorten the content first - it exceeds QR capacity" : undefined}>
              300ppi print PNG
            </button>
            <button onClick={() => void exportSvg()} className="border border-hairline px-3 py-1.5 text-[0.75rem] hover:border-fg disabled:opacity-40" disabled={!matrix || !!busy} title={!matrix ? "Shorten the content first - it exceeds QR capacity" : undefined}>
              SVG
            </button>
            <button onClick={copyPreset} className="border border-hairline px-3 py-1.5 text-[0.75rem] hover:border-fg disabled:opacity-40" disabled={!matrix || !!busy}>
              Copy preset link
            </button>
          </div>
          {busy ? <p className="text-[0.75rem] text-mid">{busy}</p> : null}
        </SectionBox>
      </div>

      <div className="min-w-0">
        <div className="lg:sticky lg:top-4 space-y-2">
          <div
            className="border border-hairline bg-card p-4 flex items-center justify-center"
            style={transparent ? { backgroundImage: "repeating-conic-gradient(#e5e2da 0 25%, transparent 0 50%)", backgroundSize: "16px 16px" } : undefined}
          >
            {matrix ? (
              <canvas ref={previewRef} className="max-w-full h-auto" style={{ width: "min(100%, 560px)" }} />
            ) : (
              <p className="text-[0.875rem] text-mid py-16 px-6 text-center">
                That's too much content for one QR code — shorten it (a URL is ideal).
              </p>
            )}
          </div>
          {matrix ? (
            <p className="text-[0.75rem] text-mid">
              {matrix.length}×{matrix.length} modules · EC {effEc}
              {scan === "pending" ? " · scan test running…" : ""}
              {scan === "passed" ? " · ✓ scan test passed at export size" : ""}
              {scan === "failed" ? " · ⚠ scan test FAILED at export size — raise contrast, module size, export size, or shrink the logo" : ""}
              {scan === "unavailable" ? " · scan test unavailable in this browser — test with a phone before printing" : ""}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
