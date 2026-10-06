// Editor adapters - the bridge between the existing generators and editable
// project elements. Each adapter declares its parameters (so the editor can
// build controls and presets from data) and produces color groups in the
// LOCAL 0..100 box; the editor places, routes, and resamples them at real
// physical size, so stitch geometry stays machine-correct at any element size.
//
// Adapters REUSE the tools' exported pure generators - no algorithm is
// rewritten here. Tools without an adapter still work as standalone tools;
// their results join projects as placed stitch files (honest, non-editable).

import { BLOCK_BY_TYPE, runBlocks } from "../tools/sketch";
import { layoutText, missingGlyphs } from "../tools/lettering";
import type { HersheyFaceId } from "../tools/data/hershey";
import { halftoneWaves } from "../tools/halftone";
import { stipple, routeTour } from "../tools/oneline";
import { hatchShade } from "../tools/hatchtone";
import { packCircles } from "../tools/imagepack";
import { chaikinSmooth } from "../tools/portrait";
import type { PathMm } from "../lib/generators";
import type { ParamValue } from "../lib/project";
import { normalize, normalizeGroups, type Group } from "./geometry";

/** Minimal luminance image (matches shared.tsx LumImg's essentials). */
export type AdapterImage = { w: number; h: number; lum: Float32Array };

export type ParamSpec =
  | { key: string; label: string; kind: "range"; min: number; max: number; step: number; def: number; unit?: string; advanced?: boolean }
  | { key: string; label: string; kind: "select"; options: { value: string; label: string }[]; def: string; advanced?: boolean }
  | { key: string; label: string; kind: "text"; def: string; placeholder?: string; multiline?: boolean; advanced?: boolean }
  | { key: string; label: string; kind: "toggle"; def: boolean; advanced?: boolean };

export type Preset = { name: string; params: Record<string, ParamValue> };

export type GenerateResult = { groups: Group[]; warning?: string };

export type Adapter = {
  id: string;
  title: string;
  category: "patterns" | "words" | "photo";
  /** Requires a source image on the element. */
  needsImage?: boolean;
  /** Uses randomness - `seedKey` names the param that "Make a variation"
   *  bumps (default "seed"). */
  usesSeed?: boolean;
  seedKey?: string;
  /** Noticeably heavy - the editor shows progress and debounces harder. */
  slow?: boolean;
  params: ParamSpec[];
  presets?: Preset[];
  generate: (params: Record<string, ParamValue>, ctx: { image?: AdapterImage }) => GenerateResult;
};

export function defaultParams(a: Adapter): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const p of a.params) out[p.key] = p.def;
  if (a.usesSeed && out.seed === undefined) out.seed = 1;
  return out;
}

const numOf = (p: Record<string, ParamValue>, k: string, d: number): number =>
  typeof p[k] === "number" && Number.isFinite(p[k] as number) ? (p[k] as number) : d;
const strOf = (p: Record<string, ParamValue>, k: string, d: string): string =>
  typeof p[k] === "string" ? (p[k] as string) : d;
const boolOf = (p: Record<string, ParamValue>, k: string, d: boolean): boolean =>
  typeof p[k] === "boolean" ? (p[k] as boolean) : d;

// ── pattern adapters, derived from the Pattern-Blocks factory ──────────────

const RANDOM_BLOCKS = new Set(["truchet", "flowField", "contours", "circlePack"]);

/** Curated, visually strong subset of the block library. */
const BLOCK_ADAPTER_TYPES: { type: string; title?: string; presets?: Preset[] }[] = [
  { type: "truchet", presets: [
    { name: "Classic maze", params: { cells: 8, variation: 3 } },
    { name: "Fine weave", params: { cells: 14, variation: 7 } },
  ] },
  { type: "spirograph" },
  { type: "phyllotaxis" },
  { type: "rose" },
  { type: "maurerRose", title: "Maurer rose" },
  { type: "starPolygon", title: "Star" },
  { type: "honeycomb" },
  { type: "moire", title: "Moire rings" },
  { type: "ripples" },
  { type: "superformula" },
  { type: "lissajous" },
  { type: "waveRows", title: "Waves" },
  { type: "concentricRings", title: "Rings" },
  { type: "spiral" },
  { type: "flowField", title: "Flow field" },
  { type: "contours", title: "Contours" },
  { type: "circlePack", title: "Circle pack" },
  { type: "hilbert", title: "Hilbert path" },
  { type: "starburst" },
  { type: "sierpinski" },
];

function blockAdapter(type: string, title?: string, presets?: Preset[]): Adapter | null {
  const def = BLOCK_BY_TYPE[type];
  if (!def) return null;
  const usesSeed = RANDOM_BLOCKS.has(type);
  const params: ParamSpec[] = def.params
    .filter((p): p is Extract<typeof p, { min: number }> => !("kind" in p))
    .map((p) => ({ key: p.key, label: p.label, kind: "range" as const, min: p.min, max: p.max, step: p.step, def: (def.defaults[p.key] as number) ?? p.min }));
  // some blocks already expose their own randomness knob - reuse it as the
  // seed instead of stacking a second "Variation" slider
  const ownSeed = params.find((q) => q.key === "variation" || q.key === "seed");
  if (usesSeed && !ownSeed) params.push({ key: "seed", label: "Variation", kind: "range", min: 1, max: 99, step: 1, def: 1 });
  return {
    id: type,
    title: title ?? def.label,
    category: "patterns",
    usesSeed,
    seedKey: ownSeed?.key ?? "seed",
    params,
    presets,
    generate(p) {
      const blockParams: Record<string, number | string> = {};
      for (const spec of params) if (spec.key !== "seed") blockParams[spec.key] = numOf(p, spec.key, spec.kind === "range" ? spec.def : 0);
      const seed = numOf(p, "seed", 1);
      const res = runBlocks([{ id: "b", type, params: blockParams }], { seed, defaultHex: "#26324d" });
      const paths = res.groups.flat().filter((path) => path.length >= 2);
      return { groups: paths.length ? [{ color: "#26324d", paths }] : [] };
    },
  };
}

// ── lettering adapter (with honest missing-glyph handling) ────────────────

const FACE_OPTIONS: { value: HersheyFaceId; label: string }[] = [
  { value: "sans", label: "Sans" },
  { value: "serif", label: "Serif" },
  { value: "serifBold", label: "Serif bold" },
  { value: "script", label: "Script" },
  { value: "scriptBold", label: "Script bold" },
  { value: "cursive", label: "Cursive" },
  { value: "futuram", label: "Futura" },
  { value: "tech", label: "Tech" },
];

const letteringAdapter: Adapter = {
  id: "lettering",
  title: "Lettering",
  category: "words",
  params: [
    { key: "text", label: "Text", kind: "text", def: "Bayside", placeholder: "Type something", multiline: true },
    { key: "face", label: "Font", kind: "select", options: FACE_OPTIONS, def: "sans" },
    { key: "spacing", label: "Letter spacing", kind: "range", min: 0.8, max: 1.6, step: 0.05, def: 1 },
    { key: "arc", label: "Arc", kind: "range", min: -180, max: 180, step: 5, def: 0, advanced: true },
  ],
  presets: [
    { name: "Clean sans", params: { face: "sans", spacing: 1, arc: 0 } },
    { name: "Script", params: { face: "script", spacing: 1.05, arc: 0 } },
    { name: "Arched serif", params: { face: "serifBold", spacing: 1.1, arc: 60 } },
  ],
  generate(p) {
    const text = strOf(p, "text", "");
    if (!text.trim()) return { groups: [] };
    const face = strOf(p, "face", "sans") as HersheyFaceId;
    const missing = missingGlyphs(text, face);
    const paths = layoutText({
      text,
      faceId: face,
      heightMm: 20,
      letterSpacing: numOf(p, "spacing", 1),
      arcDeg: numOf(p, "arc", 0),
      stitchLenMm: 1,
    });
    if (!paths.length) return { groups: [] };
    return {
      groups: [{ color: "#26324d", paths: normalize(paths) }],
      warning: missing.length
        ? `This font can't draw: ${missing.join(" ")} - pick another font or remove those characters.`
        : undefined,
    };
  },
};

// ── photo adapters (image required) ────────────────────────────────────────

/** Fit image-pixel paths into the local box, preserving image aspect. */
function normalizeImagePaths(paths: PathMm[], img: AdapterImage): PathMm[] {
  const ar = img.w / img.h;
  const bw = ar >= 1 ? 100 : 100 * ar;
  const bh = ar >= 1 ? 100 / ar : 100;
  const sx = bw / img.w, sy = bh / img.h;
  const ox = (100 - bw) / 2, oy = (100 - bh) / 2;
  return paths.map((p) => p.map((q) => ({ x: q.x * sx + ox, y: q.y * sy + oy })));
}

const onelineAdapter: Adapter = {
  id: "oneline",
  title: "One line",
  category: "photo",
  needsImage: true,
  usesSeed: true,
  slow: true,
  params: [
    { key: "detail", label: "Detail", kind: "range", min: 200, max: 2400, step: 50, def: 900 },
    { key: "contrast", label: "Contrast", kind: "range", min: 0.6, max: 3, step: 0.1, def: 1.5 },
    { key: "invert", label: "Trace the light (dark fabric)", kind: "toggle", def: false, advanced: true },
    { key: "seed", label: "Variation", kind: "range", min: 1, max: 12, step: 1, def: 1 },
  ],
  presets: [
    { name: "Portrait", params: { detail: 1200, contrast: 1.6 } },
    { name: "Quick sketch", params: { detail: 500, contrast: 1.3 } },
  ],
  generate(p, ctx) {
    if (!ctx.image) return { groups: [], warning: "Add a photo first." };
    const pts = stipple(ctx.image, {
      count: numOf(p, "detail", 900),
      gamma: numOf(p, "contrast", 1.5),
      invert: boolOf(p, "invert", false),
      seed: numOf(p, "seed", 1),
    });
    if (pts.length < 3) return { groups: [], warning: "Not enough dark areas - raise contrast." };
    const tour = routeTour(pts);
    const smooth = chaikinSmooth(tour.map((q) => ({ x: q.x, y: q.y })), 1);
    return { groups: [{ color: "#26324d", paths: normalizeImagePaths([smooth], ctx.image) }] };
  },
};

const hatchAdapter: Adapter = {
  id: "hatchtone",
  title: "Cross-hatch",
  category: "photo",
  needsImage: true,
  params: [
    { key: "layers", label: "Hatch layers", kind: "range", min: 1, max: 6, step: 1, def: 4 },
    { key: "lines", label: "Fineness", kind: "range", min: 24, max: 110, step: 2, def: 60 },
    { key: "contrast", label: "Contrast", kind: "range", min: 0.6, max: 3, step: 0.1, def: 1.3 },
    { key: "invert", label: "Hatch the light (dark fabric)", kind: "toggle", def: false, advanced: true },
  ],
  generate(p, ctx) {
    if (!ctx.image) return { groups: [], warning: "Add a photo first." };
    const spacingPx = Math.max(2, Math.min(ctx.image.w, ctx.image.h) / numOf(p, "lines", 60));
    const paths = hatchShade(ctx.image, {
      layers: numOf(p, "layers", 4),
      spacingPx,
      gamma: numOf(p, "contrast", 1.3),
      invert: boolOf(p, "invert", false),
    });
    if (!paths.length) return { groups: [], warning: "Nothing dark enough to hatch - raise contrast." };
    return { groups: [{ color: "#26324d", paths: normalizeImagePaths(paths, ctx.image) }] };
  },
};

const halftoneAdapter: Adapter = {
  id: "halftone",
  title: "Wave halftone",
  category: "photo",
  needsImage: true,
  params: [
    { key: "lines", label: "Lines", kind: "range", min: 16, max: 72, step: 1, def: 46 },
    { key: "amp", label: "Wave strength", kind: "range", min: 0.15, max: 0.9, step: 0.05, def: 0.55 },
    { key: "angle", label: "Angle", kind: "range", min: 0, max: 180, step: 5, def: 0, advanced: true },
    { key: "contrast", label: "Contrast", kind: "range", min: 0.6, max: 3, step: 0.1, def: 1.3 },
    { key: "invert", label: "Stitch the light (dark fabric)", kind: "toggle", def: false, advanced: true },
  ],
  generate(p, ctx) {
    if (!ctx.image) return { groups: [], warning: "Add a photo first." };
    const spacingPx = Math.max(2, Math.min(ctx.image.w, ctx.image.h) / numOf(p, "lines", 46));
    const paths = halftoneWaves(ctx.image, {
      spacingPx,
      ampFrac: numOf(p, "amp", 0.55),
      waveLenPx: spacingPx * 1.6,
      angleDeg: numOf(p, "angle", 0),
      gamma: numOf(p, "contrast", 1.3),
      invert: boolOf(p, "invert", false),
    });
    if (!paths.length) return { groups: [], warning: "Nothing to draw - raise contrast." };
    return { groups: [{ color: "#26324d", paths: normalizeImagePaths(paths, ctx.image) }] };
  },
};

const circlepackAdapter: Adapter = {
  id: "imagepack",
  title: "Dot pack",
  category: "photo",
  needsImage: true,
  usesSeed: true,
  params: [
    { key: "maxDot", label: "Biggest dot", kind: "range", min: 4, max: 16, step: 0.5, def: 9 },
    { key: "range", label: "Size range", kind: "range", min: 1.5, max: 8, step: 0.5, def: 4 },
    { key: "contrast", label: "Contrast", kind: "range", min: 0.6, max: 3, step: 0.1, def: 1.4 },
    { key: "invert", label: "Size by the light (dark fabric)", kind: "toggle", def: false, advanced: true },
    { key: "seed", label: "Variation", kind: "range", min: 1, max: 12, step: 1, def: 1 },
  ],
  generate(p, ctx) {
    if (!ctx.image) return { groups: [], warning: "Add a photo first." };
    const img = ctx.image;
    const maxR = (Math.min(img.w, img.h) * (numOf(p, "maxDot", 9) / 100)) / 2;
    const minR = Math.max(1, maxR / Math.max(1.5, numOf(p, "range", 4)));
    const circles = packCircles(img, {
      minR, maxR, gap: minR * 0.35,
      gamma: numOf(p, "contrast", 1.4),
      invert: boolOf(p, "invert", false),
      floor: 0.06,
      seed: numOf(p, "seed", 1),
      density: 1.1,
    });
    if (!circles.length) return { groups: [], warning: "No dots landed - raise contrast." };
    const paths = circles.map((c) => {
      const segs = Math.max(10, Math.round(c.r * 1.6));
      const ring: PathMm = [];
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        ring.push({ x: c.x + Math.cos(a) * c.r, y: c.y + Math.sin(a) * c.r });
      }
      return ring;
    });
    return { groups: [{ color: "#26324d", paths: normalizeImagePaths(paths, ctx.image) }] };
  },
};

// ── registry ───────────────────────────────────────────────────────────────

const list: Adapter[] = [
  letteringAdapter,
  onelineAdapter,
  hatchAdapter,
  halftoneAdapter,
  circlepackAdapter,
  ...BLOCK_ADAPTER_TYPES.map(({ type, title, presets }) => blockAdapter(type, title, presets)).filter(
    (a): a is Adapter => a !== null,
  ),
];

export const ADAPTERS: Record<string, Adapter> = Object.fromEntries(list.map((a) => [a.id, a]));
export const ADAPTER_LIST = list;

export function adaptersByCategory(cat: Adapter["category"]): Adapter[] {
  return list.filter((a) => a.category === cat);
}

/** Cache fingerprint for an element's generated geometry: everything that
 *  changes the LOCAL artwork (position/rotation/size are applied later and
 *  must not bust this). */
export function geomKey(tool: string, params: Record<string, ParamValue>, imageRef?: string): string {
  return JSON.stringify([tool, params, imageRef ?? ""]);
}

export { normalizeGroups };
