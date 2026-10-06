// Stitch Lab: Workspace - a canvas-first studio shell. The canvas fills the
// whole window between the fixed toolbars: a left icon rail picks a mode
// (Shapes / Photos / Text / Settings), a fixed-height bottom toolbar
// re-populates for that mode, and the layers list floats semi-transparent ON
// the canvas. The hoop is a dashed reference outline (not a frame) - the
// working area is the screen, zoomable, and the design's real mm size is
// always shown. Everything composes into one DST/PES download.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  useIsMobile,
  RangeRow,
  ThreadSelect,
  ImagePick,
  buildDesign,
  downloadDesign,
  useCanvas,
  FABRICS,
  formatMinutes,
  useUnits,
  UnitsToggle,
  fmtLen,
  fmtSize,
  fmtWH,
  type StitchFormat,
  type LumImg,
  type CanvasDraw,
} from "./shared";
import { pathGroupsToStitches, resamplePath, routeStrokes, type PathMm } from "../lib/generators";
import { saveDesignEverywhere, LIBRARY_EVENT } from "../lib/sync";
import { getRole } from "../account";
import AnimExport from "./animexport";
import { listDesigns, type SavedDesign } from "../lib/library";
import { parseDst } from "../lib/dst";
import { CMD } from "../lib/pattern";
import { THREADS } from "../../data/threads";
import { runBlocks, BLOCK_DEFS, BLOCK_BY_TYPE, type BlockParam } from "./sketch";
import { layoutText } from "./lettering";
import { layoutOutlineText, type OTFont } from "../lib/outlinefont";
import { HERSHEY_FACES, HERSHEY_PICKER_IDS, type HersheyFaceId } from "./data/hershey";
import { stipplePoints, nnTour, chaikinSmooth, sobelGrad } from "./portrait";
import { quantizeToThreads, crossesFromGrid } from "./crossstitch";
import { TOOLS, type ToolDef } from "./index";
import { SECTIONS } from "../sections";
import { toolPreview } from "../toolPreviews";

let seq = 0;
const uid = () => `ws${seq++}`;
const INK = THREADS.find((t) => t.code === "1568")?.hex ?? "#0b1f3a";
const RUST = THREADS.find((t) => t.code === "1147")?.hex ?? "#b4472e";
const NAME = "bayside-workspace";
const FABRIC = FABRICS[0].hex; // bone - fixed canvas ground for now
const STITCH_LEN = 2.2;
const BEAN = 1 as const;
const SEED = 1;
const isNum = (p: BlockParam): p is Extract<BlockParam, { min: number }> => "min" in p;

const IN = 25.4;
type Hoop = { id: string; label: string; w: number; h: number; oval?: boolean };
const HOOPS: Hoop[] = [
  { id: "5x7", label: "5 × 7 in", w: 5 * IN, h: 7 * IN },
  { id: "8x8", label: "8 × 8 in", w: 8 * IN, h: 8 * IN },
  { id: "11x13", label: "11 × 13 in", w: 11 * IN, h: 13 * IN },
  { id: "13x16", label: "13 × 16 in", w: 13 * IN, h: 16 * IN },
  { id: "14x20oval", label: "14 × 20 in oval", w: 14 * IN, h: 20 * IN, oval: true },
];

// ─── Layers ──────────────────────────────────────────────────────────────

type Base = { id: string; color: string; cx: number; cy: number; scale: number; rot: number; flipX?: boolean; flipY?: boolean };
type ShapeLayer = Base & { kind: "shape"; type: string; params: Record<string, number | string> };
type CustomFont = { font: OTFont; name: string };
type TextLayer = Base & { kind: "text"; text: string; face: HersheyFaceId; spacing: number; custom?: CustomFont | null };
type PhotoMode = "portrait" | "halftone" | "crossstitch";
type PhotoLayer = Base & {
  kind: "photo";
  name: string;
  img: LumImg;
  mode: PhotoMode;
  rows: number; dark: number; invert: boolean; // halftone
  points: number; pgamma: number;              // portrait squiggle
  cells: number; cones: number; light: number; // cross-stitch
};
/** A design from the library, placed as a layer. Its geometry is the parsed
 *  DST converted to per-color path groups at add time, with original stitch
 *  sequencing preserved (no re-resampling on export). */
type DesignLayer = Base & { kind: "design"; name: string; src: Group[] };
type Layer = ShapeLayer | TextLayer | PhotoLayer | DesignLayer;

/** A layer's geometry: one or more thread-color groups in the 0..100 box.
 *  Shapes/text/most photos are one group in the layer's thread; cross-stitch
 *  carries a group per matched cone, straight from the photo. */
type Group = { color: string; paths: PathMm[]; noResample?: boolean };

type Tab = "shape" | "photo" | "text" | "saved" | "settings";

// ─── Local geometry (each layer draws into a 0..100 box) ─────────────────

function bboxPaths(paths: PathMm[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) for (const q of p) { if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x; if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y; }
  return isFinite(minX) ? { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY } : { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0 };
}

/** Fit arbitrary paths into the 0..100 box, centered, aspect preserved. */
function normalize(paths: PathMm[]): PathMm[] {
  const b = bboxPaths(paths);
  const s = b.w > 0 || b.h > 0 ? 100 / Math.max(b.w, b.h) : 1;
  const ox = 50 - (b.minX + b.w / 2) * s;
  const oy = 50 - (b.minY + b.h / 2) * s;
  return paths.map((p) => p.map((q) => ({ x: q.x * s + ox, y: q.y * s + oy })));
}

/** Wavy-line halftone of a photo, fitted into the 0..100 box. */
function halftonePaths(img: LumImg, rows: number, dark: number, invert: boolean): PathMm[] {
  const ar = img.w / img.h;
  const bw = ar >= 1 ? 100 : 100 * ar;
  const bh = ar >= 1 ? 100 / ar : 100;
  const x0 = (100 - bw) / 2, y0 = (100 - bh) / 2;
  const pitch = bh / rows;
  const out: PathMm[] = [];
  for (let r = 0; r < rows; r++) {
    const yC = y0 + (r + 0.5) * pitch;
    const seg: PathMm = [];
    const steps = 150;
    for (let i = 0; i <= steps; i++) {
      const x = x0 + (i / steps) * bw;
      const u = Math.min(img.w - 1, Math.floor((i / steps) * img.w));
      const v = Math.min(img.h - 1, Math.floor(((yC - y0) / bh) * img.h));
      let l = img.lum[v * img.w + u];
      if (invert) l = 1 - l;
      const amp = Math.pow(Math.max(0, 1 - l), dark) * pitch * 0.48;
      seg.push({ x, y: yC + Math.sin(i * 0.85) * amp });
    }
    out.push(r % 2 ? seg.reverse() : seg);
  }
  return out;
}

/** Normalize several groups with ONE shared transform so relative geometry
 *  (e.g. cross-stitch cell alignment across colors) is preserved. */
function normalizeGroups(groups: Group[]): Group[] {
  const all = groups.flatMap((g) => g.paths);
  const b = bboxPaths(all);
  const s = b.w > 0 || b.h > 0 ? 100 / Math.max(b.w, b.h) : 1;
  const ox = 50 - (b.minX + b.w / 2) * s;
  const oy = 50 - (b.minY + b.h / 2) * s;
  return groups.map((g) => ({ ...g, paths: g.paths.map((p) => p.map((q) => ({ x: q.x * s + ox, y: q.y * s + oy }))) }));
}

/** Parse a saved design's exact DST bytes into per-color-block path groups.
 *  Jumps and trims break paths; color changes start a new group. */
function designToGroups(d: SavedDesign): Group[] {
  try {
    const buf = d.bytes.buffer.slice(d.bytes.byteOffset, d.bytes.byteOffset + d.bytes.byteLength) as ArrayBuffer;
    const pat = parseDst(buf);
    const groups: Group[] = [];
    let block = 0;
    let path: PathMm = [];
    let paths: PathMm[] = [];
    const flushPath = () => { if (path.length >= 2) paths.push(path); path = []; };
    const flushBlock = () => { flushPath(); if (paths.length) groups.push({ color: d.colors[block] ?? INK, paths, noResample: true }); paths = []; };
    for (const st of pat.stitches) {
      if (st.cmd === CMD.STITCH) path.push({ x: st.x, y: st.y });
      else if (st.cmd === CMD.COLOR_CHANGE) { flushBlock(); block++; }
      else flushPath();
    }
    flushBlock();
    return normalizeGroups(groups);
  } catch {
    return [];
  }
}

function computeGroups(l: Layer): Group[] {
  if (l.kind === "shape") {
    try {
      return [{ color: l.color, paths: runBlocks([{ id: l.id, type: l.type, params: l.params }], { seed: SEED, defaultHex: INK }).groups.flat() }];
    } catch {
      return [];
    }
  }
  if (l.kind === "design") return l.src;
  if (l.kind === "text") {
    if (!l.text.trim()) return [];
    if (l.custom) {
      try {
        const L = layoutOutlineText(l.custom.font, { text: l.text, heightMm: 20, letterSpacing: l.spacing, stepMm: 0.4 });
        if (!L.contours.length) return [];
        return [{ color: l.color, paths: normalize(L.contours.map((c) => [...c, c[0]])) }];
      } catch {
        return [];
      }
    }
    return [{ color: l.color, paths: normalize(layoutText({ text: l.text, faceId: l.face, heightMm: 20, letterSpacing: l.spacing, stitchLenMm: 1 })) }];
  }
  if (l.mode === "halftone") return [{ color: l.color, paths: halftonePaths(l.img, l.rows, l.dark, l.invert) }];
  if (l.mode === "portrait") {
    // The one-continuous-line squiggle portrait - same engine as the Thread
    // Portrait tool (stipple → nearest-neighbor tour → smooth).
    const pts = stipplePoints(
      { w: l.img.w, h: l.img.h, lum: l.img.lum, grad: sobelGrad(l.img) },
      { count: l.points, gamma: l.pgamma, invert: l.invert, seed: 2, relaxPasses: 1, edgeBoost: 1 },
    );
    if (pts.length < 2) return [];
    const order = nnTour(pts, 30000);
    const path = chaikinSmooth(order.map((i) => pts[i]), 2);
    return [{ color: l.color, paths: normalize([path]) }];
  }
  // Cross-stitch: counted crosses in real matched thread cones, one group per cone.
  const q = quantizeToThreads(l.img, { cols: l.cells, k: l.cones, skipLight: true, lightThreshold: l.light });
  if (!q.palette.length) return [];
  const groups = crossesFromGrid(q, q.palette.length, 100 / q.cols);
  return normalizeGroups(
    groups.map((paths, i) => ({ color: q.palette[i].hex, paths })).filter((g) => g.paths.length),
  );
}

/** Geometry-affecting fingerprint (position/rotation/size excluded - those are
 *  applied per-frame by placePaths and must not bust the cache mid-drag). */
function geomKey(l: Layer): string {
  if (l.kind === "shape") return JSON.stringify(["s", l.type, l.params, l.color]);
  if (l.kind === "text") return JSON.stringify(["t", l.text, l.custom ? `custom:${l.custom.name}` : l.face, l.spacing, l.color]);
  if (l.kind === "design") return JSON.stringify(["d", l.id]);
  return JSON.stringify(["p", l.name, l.mode, l.rows, l.dark, l.invert, l.points, l.pgamma, l.cells, l.cones, l.light, l.color, l.img.w, l.img.h]);
}

const geomCache = new Map<string, { key: string; groups: Group[] }>();

function layerGroups(l: Layer): Group[] {
  const key = geomKey(l);
  const hit = geomCache.get(l.id);
  if (hit && hit.key === key) return hit.groups;
  const groups = computeGroups(l);
  geomCache.set(l.id, { key, groups });
  return groups;
}

/** 0..100 local box → world mm via the layer's center/scale/rotation. */
function placePaths(paths: PathMm[], l: Base): PathMm[] {
  const s = l.scale / 100;
  const a = (l.rot * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const fx = l.flipX ? -1 : 1, fy = l.flipY ? -1 : 1;
  return paths.map((p) => p.map((q) => {
    const x0 = (q.x - 50) * s * fx, y0 = (q.y - 50) * s * fy;
    return { x: l.cx + x0 * cos - y0 * sin, y: l.cy + x0 * sin + y0 * cos };
  }));
}

function pathLengthMm(paths: PathMm[]): number {
  let len = 0;
  for (const p of paths) for (let i = 1; i < p.length; i++) len += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
  return len;
}

// ─── Small pieces ────────────────────────────────────────────────────────

const SHAPE_THUMBS: Record<string, Group[]> = Object.fromEntries(
  BLOCK_DEFS.filter((d) => d.type !== "color").map((d) => [
    d.type,
    [{ color: INK, paths: runBlocks([{ id: "t", type: d.type, params: { ...d.defaults } }], { seed: 1, defaultHex: INK }).groups.flat() }],
  ]),
);

function Mini({ groups, size }: { groups: Group[]; size: number }) {
  const draw = useMemo<CanvasDraw>(() => (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const pad = 3;
    const s = (Math.min(w, h) - pad * 2) / 100;
    const ox = (w - 100 * s) / 2, oy = (h - 100 * s) / 2;
    ctx.lineWidth = 1; ctx.lineJoin = "round";
    for (const g of groups) {
      ctx.strokeStyle = g.color;
      for (const p of g.paths) { if (p.length < 2) continue; ctx.beginPath(); p.forEach((q, i) => (i ? ctx.lineTo(q.x * s + ox, q.y * s + oy) : ctx.moveTo(q.x * s + ox, q.y * s + oy))); ctx.stroke(); }
    }
  }, [groups, size]);
  return <canvas ref={useCanvas(draw)} style={{ width: size, height: size }} />;
}

const RAIL_ICONS: { tab: Tab; label: string; icon: React.ReactNode }[] = [
  {
    tab: "shape", label: "Shapes",
    icon: <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3.5" y="9.5" width="11" height="11" /><circle cx="15.5" cy="8" r="5" /></svg>,
  },
  {
    tab: "photo", label: "Photos",
    icon: <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3.5" y="4.5" width="17" height="15" /><circle cx="9" cy="10" r="1.8" /><path d="M4 17.5 10 12l4 3.5 3.5-3 3 2.8" /></svg>,
  },
  {
    tab: "text", label: "Text",
    icon: <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 6.5V4.5h14v2M12 4.5v15M9.5 19.5h5" /></svg>,
  },
  {
    tab: "saved", label: "Saved",
    icon: <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 3.5l2.47 5.26 5.53.72-4.06 3.95.99 5.57L12 16.3 7.07 19l.99-5.57L4 9.48l5.53-.72L12 3.5z" /></svg>,
  },
  {
    tab: "settings", label: "Settings",
    icon: <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="3.2" /><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1" /></svg>,
  },
];

const MICRO = "text-[0.6875rem] text-mid";

const BY_SLUG: Record<string, ToolDef> = Object.fromEntries(TOOLS.map((t) => [t.slug, t]));

/** Every tool in the lab, browsable from inside the Workspace. Picking one
 *  opens that tool in its own canvas (its direct link, #<slug>). */
function ToolsModal({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const match = (t: ToolDef) => !query || t.name.toLowerCase().includes(query) || t.tagline.toLowerCase().includes(query);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-8 bg-fg/40" onClick={onClose}>
      <div className="bg-bg border border-hairline w-full max-w-[900px] max-h-[88vh] flex flex-col shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-hairline">
          <span className="font-serif text-[1.125rem] text-fg">All tools</span>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tools…" className="flex-1 border border-hairline bg-bg text-fg px-2.5 py-1.5 text-[0.8125rem]" />
          <button onClick={onClose} className="text-mid hover:text-fg text-[0.8125rem] border border-hairline px-2.5 py-1.5">Close ✕</button>
        </div>
        <div className="overflow-y-auto px-4 py-3 space-y-5">
          <p className="text-[0.75rem] text-mid leading-relaxed">
            Each tool opens in its own canvas with its full set of dials. Save from any of them and the design lands in
            your library.
          </p>
          {SECTIONS.map((sec) => {
            const staffHere = ["staff", "admin"].includes(getRole());
            const tools = sec.slugs
              .filter((slug) => slug !== "workspace" && slug !== "librarypage")
              .map((slug) => BY_SLUG[slug])
              .filter((t): t is ToolDef => Boolean(t) && match(t) && (!t.staffOnly || staffHere));
            if (!tools.length) return null;
            return (
              <div key={sec.title}>
                <div className="text-[0.6875rem] tracking-[0.14em] uppercase text-mid mb-1.5">{sec.title}</div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                  {tools.map((t) => (
                    <button key={t.slug} onClick={() => { window.location.hash = t.slug; onClose(); }}
                      className="group border border-hairline bg-bg hover:border-accent overflow-hidden text-left">
                      <div className="flex items-center justify-center bg-card/50" style={{ height: 74 }}>
                        <Mini groups={[{ color: INK, paths: toolPreview(t.slug) }]} size={64} />
                      </div>
                      <div className="px-2 py-1.5 border-t border-hairline">
                        <div className="text-[0.75rem] text-fg font-medium leading-tight group-hover:text-accent">{t.name}</div>
                        <div className="text-[0.625rem] text-mid leading-tight mt-0.5 line-clamp-2">{t.tagline}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Starter composition so the canvas reads immediately. */
function starterLayers(): Layer[] {
  const s = Math.round(Math.min(HOOPS[0].w, HOOPS[0].h) * 0.62);
  return [
    { id: uid(), kind: "shape", type: "rose", params: { ...BLOCK_BY_TYPE.rose.defaults }, color: INK, cx: 0, cy: -16, scale: s, rot: 0 },
    { id: uid(), kind: "text", text: "Bayside", face: "script", spacing: 1, color: RUST, cx: 0, cy: 42, scale: Math.round(s * 0.75), rot: 0 },
  ];
}

// ─── Component ───────────────────────────────────────────────────────────

export default function WorkspaceTool() {
  const [tab, setTab] = useState<Tab>("shape");
  const [layers, setLayers] = useState<Layer[]>(starterLayers);
  const [selId, setSelId] = useState<string | null>(null);
  const [layersOpen, setLayersOpen] = useState<boolean>(() =>
    typeof window === "undefined" ? true : window.innerWidth >= 1024,
  );
  const [toolsOpen, setToolsOpen] = useState(false);
  const [saved, setSaved] = useState<SavedDesign[] | null>(null);
  useEffect(() => {
    if (tab !== "saved" || saved !== null) return;
    void listDesigns().then(setSaved).catch(() => setSaved([]));
  }, [tab, saved]);
  useEffect(() => {
    const on = () => setSaved(null); // reload next time the tab opens
    window.addEventListener(LIBRARY_EVENT, on);
    return () => window.removeEventListener(LIBRARY_EVENT, on);
  }, []);
  const [hoopId, setHoopId] = useState("5x7");
  const [zoom, setZoom] = useState(1.5); // 1 = whole hoop in view
  const [fmt, setFmt] = useState<StitchFormat>("dst");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "done">("idle");
  const [draftText, setDraftText] = useState("Bayside");
  const [draftFace, setDraftFace] = useState<HersheyFaceId>("sans");
  const [draftCustom, setDraftCustom] = useState<CustomFont | null>(null);
  const [fontError, setFontError] = useState<string | null>(null);
  const units = useUnits();
  const [hoopLandscape, setHoopLandscape] = useState(false);
  const hoopBase = HOOPS.find((h) => h.id === hoopId) ?? HOOPS[0];
  // Rotating the hoop 90° just swaps its dimensions - the dashed reference,
  // fit check, and oval ellipse all follow automatically.
  const hoop = hoopLandscape ? { ...hoopBase, w: hoopBase.h, h: hoopBase.w } : hoopBase;
  const hoopLabel = `${Math.round(hoop.w / IN)} × ${Math.round(hoop.h / IN)} in${hoop.oval ? " oval" : ""}`;
  const defaultScale = Math.round(Math.min(hoop.w, hoop.h) * 0.6);

  const patch = (id: string, p: Partial<Layer>) =>
    setLayers((ls) => ls.map((l) => (l.id === id ? ({ ...l, ...p } as Layer) : l)));

  const addLayer = (l: Layer) => {
    setLayers((ls) => [...ls, l]);
    setSelId(l.id);
  };
  const stagger = () => {
    const n = layers.length;
    return ((n % 4) - 1.5) * Math.min(hoop.w, hoop.h) * 0.08;
  };

  const addShape = (type: string) =>
    addLayer({ id: uid(), kind: "shape", type, params: { ...BLOCK_BY_TYPE[type].defaults }, color: INK, cx: stagger(), cy: stagger(), scale: defaultScale, rot: 0 });
  const addText = () =>
    addLayer({ id: uid(), kind: "text", text: draftText || "Bayside", face: draftFace, custom: draftCustom, spacing: 1, color: INK, cx: stagger(), cy: stagger(), scale: Math.round(defaultScale * 0.8), rot: 0 });
  const addPhoto = (img: LumImg, name: string) =>
    addLayer({
      id: uid(), kind: "photo", name, img, mode: "portrait",
      rows: 36, dark: 1.6, invert: false,
      points: 2200, pgamma: 1.8,
      cells: 48, cones: 4, light: 0.92,
      color: INK, cx: 0, cy: 0, scale: defaultScale, rot: 0,
    });

  // Uploaded OTF/TTF/WOFF via opentype.js (loaded on demand). Applies to the
  // selected text layer, or becomes the font for the next added text.
  const loadFont = async (file: File) => {
    setFontError(null);
    try {
      const buf = await file.arrayBuffer();
      const opentype = await import("opentype.js");
      const parse = (opentype as unknown as { parse: (b: ArrayBuffer) => OTFont }).parse
        ?? (opentype as unknown as { default: { parse: (b: ArrayBuffer) => OTFont } }).default.parse;
      const custom = { font: parse(buf), name: file.name.replace(/\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/, "") };
      if (sel?.layer.kind === "text") patch(sel.layer.id, { custom });
      else setDraftCustom(custom);
    } catch {
      setFontError("Couldn't read that font. Use a .ttf, .otf, or .woff file.");
    }
  };

  const addDesign = (d: SavedDesign) => {
    const src = designToGroups(d);
    if (!src.length) return;
    addLayer({
      id: uid(), kind: "design", name: d.name.replace(/^bayside-/, ""), src,
      color: INK, cx: stagger(), cy: stagger(),
      scale: Math.max(24, Math.round(Math.max(d.widthMm, d.heightMm))), rot: 0,
    });
  };

  const remove = (id: string) => { setLayers((ls) => ls.filter((l) => l.id !== id)); if (selId === id) setSelId(null); };
  // Duplicate = the "try another interpretation" move: the copy carries every param
  // (photo copies share the same immutable LumImg) and lands slightly offset.
  const duplicate = (id: string) => {
    setLayers((ls) => {
      const i = ls.findIndex((l) => l.id === id);
      if (i < 0) return ls;
      const copy = { ...ls[i], id: uid(), cx: ls[i].cx + 6, cy: ls[i].cy + 6 };
      const next = [...ls];
      next.splice(i + 1, 0, copy);
      setSelId(copy.id);
      return next;
    });
  };
  const move = (id: string, dir: -1 | 1) => setLayers((ls) => {
    const i = ls.findIndex((l) => l.id === id); const j = i + dir;
    if (i < 0 || j < 0 || j >= ls.length) return ls;
    const next = [...ls]; [next[i], next[j]] = [next[j], next[i]]; return next;
  });

  const select = (id: string | null) => {
    setSelId(id);
    const l = layers.find((x) => x.id === id);
    if (l) setTab(l.kind === "photo" ? "photo" : l.kind === "text" ? "text" : l.kind === "design" ? "saved" : "shape");
  };

  // Geometry
  const placed = useMemo(
    () => layers.map((l) => {
      const groups = layerGroups(l).map((g) => ({ ...g, paths: placePaths(g.paths, l) }));
      const all = groups.flatMap((g) => g.paths);
      return { layer: l, groups, bbox: bboxPaths(all), lenMm: pathLengthMm(all) };
    }),
    [layers],
  );
  const sel = placed.find((p) => p.layer.id === selId) ?? null;

  const built = useMemo(() => {
    // Generated geometry is routed (merge touching strokes + nearest-endpoint
    // order) per color before resampling - far fewer jumps/trims on the sew.
    // noResample groups (imported designs) keep their original stitch order.
    const order: string[] = [];
    const routable = new Map<string, PathMm[]>(); const frozen = new Map<string, PathMm[]>();
    for (const p of placed) {
      for (const g of p.groups) {
        if (!g.paths.length) continue;
        if (!routable.has(g.color)) { routable.set(g.color, []); frozen.set(g.color, []); order.push(g.color); }
        for (const path of g.paths) (g.noResample ? frozen : routable).get(g.color)!.push(path);
      }
    }
    if (!order.length) return { design: null, colors: [INK] };
    const groups = order.map((c) => [
      ...routeStrokes(routable.get(c)!).map((path) => resamplePath(path, STITCH_LEN, 0.4)),
      ...frozen.get(c)!,
    ]);
    return { design: buildDesign(pathGroupsToStitches(groups, BEAN), NAME), colors: order };
  }, [placed]);
  const design = built.design;
  // Position-aware fit check: the union bbox of everything on the canvas must
  // sit inside the hoop - for ovals, all four corners inside the ellipse.
  const overHoop = useMemo(() => {
    if (!design || !placed.length) return false;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of placed) { if (p.bbox.w || p.bbox.h) { minX = Math.min(minX, p.bbox.minX); minY = Math.min(minY, p.bbox.minY); maxX = Math.max(maxX, p.bbox.maxX); maxY = Math.max(maxY, p.bbox.maxY); } }
    if (!isFinite(minX)) return false;
    if (hoop.oval) {
      const a = hoop.w / 2 + 1, b = hoop.h / 2 + 1;
      return ([[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]] as [number, number][])
        .some(([x, y]) => (x * x) / (a * a) + (y * y) / (b * b) > 1);
    }
    return minX < -hoop.w / 2 - 1 || maxX > hoop.w / 2 + 1 || minY < -hoop.h / 2 - 1 || maxY > hoop.h / 2 + 1;
  }, [design, placed, hoop]);

  // ── Canvas: fills the whole region; the hoop is a dashed reference ──
  const viewRef = useRef<{ pxPerMm: number; w: number; h: number } | null>(null);
  const drag = useRef<{ id: string; mode: "move" | "scale"; ox: number; oy: number; startScale: number; startDist: number } | null>(null);

  const draw = useMemo<CanvasDraw>(() => (ctx, w, h) => {
    ctx.fillStyle = FABRIC; ctx.fillRect(0, 0, w, h);
    const fit = Math.min((w - 24) / hoop.w, (h - 24) / hoop.h); // zoom 1 = hoop fits
    const pxPerMm = fit * zoom;
    viewRef.current = { pxPerMm, w, h };
    const X = (mx: number) => mx * pxPerMm + w / 2;
    const Y = (my: number) => my * pxPerMm + h / 2;
    // hoop reference outline (dashed) + label - ovals draw as ellipses
    ctx.strokeStyle = "rgba(120,130,140,0.55)"; ctx.lineWidth = 1; ctx.setLineDash([6, 5]);
    if (hoop.oval) {
      ctx.beginPath();
      ctx.ellipse(X(0), Y(0), (hoop.w / 2) * pxPerMm, (hoop.h / 2) * pxPerMm, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.strokeRect(X(-hoop.w / 2), Y(-hoop.h / 2), hoop.w * pxPerMm, hoop.h * pxPerMm);
    }
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(120,130,140,0.85)";
    ctx.font = "11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(`${hoopLabel} hoop`, X(-hoop.w / 2) + 6, Math.max(14, Y(-hoop.h / 2) - 6));
    // layers
    for (const p of placed) {
      const dim = selId !== null && p.layer.id !== selId;
      ctx.globalAlpha = dim ? 0.3 : 1;
      ctx.lineWidth = p.layer.id === selId ? 1.5 : 1.1; ctx.lineJoin = "round";
      for (const g of p.groups) {
        ctx.strokeStyle = g.color;
        for (const path of g.paths) { if (path.length < 2) continue; ctx.beginPath(); path.forEach((q, i) => (i ? ctx.lineTo(X(q.x), Y(q.y)) : ctx.moveTo(X(q.x), Y(q.y)))); ctx.stroke(); }
      }
    }
    ctx.globalAlpha = 1;
    // selection box + handles + real size readout
    if (sel) {
      const b = sel.bbox;
      ctx.strokeStyle = "rgba(40,120,255,0.95)"; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.25;
      ctx.strokeRect(X(b.minX), Y(b.minY), b.w * pxPerMm, b.h * pxPerMm);
      ctx.setLineDash([]);
      ctx.fillStyle = "#2478ff";
      for (const [hx, hy] of [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]] as [number, number][]) ctx.fillRect(X(hx) - 4, Y(hy) - 4, 8, 8);
      const label = fmtSize(b.w, b.h, units);
      ctx.font = "11px sans-serif"; ctx.textAlign = "center";
      const ly = Math.min(h - 8, Y(b.maxY) + 16);
      const lw = ctx.measureText(label).width + 12;
      ctx.fillStyle = "rgba(36,120,255,0.92)";
      ctx.fillRect(X((b.minX + b.maxX) / 2) - lw / 2, ly - 11, lw, 16);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, X((b.minX + b.maxX) / 2), ly + 1);
    }
    if (!placed.length) {
      ctx.fillStyle = "rgba(100,105,115,0.8)";
      ctx.font = "13px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("Pick Shapes, Photos, or Text on the left, then add from the bottom bar.", w / 2, h / 2);
    }
  }, [placed, sel, selId, hoop, hoopLabel, zoom, units]);
  const canvasRef = useCanvas(draw);

  const toWorld = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect(); const v = viewRef.current;
    if (!v) return { x: 0, y: 0 };
    return { x: (e.clientX - r.left - v.w / 2) / v.pxPerMm, y: (e.clientY - r.top - v.h / 2) / v.pxPerMm };
  };
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const w = toWorld(e);
    const v = viewRef.current;
    if (sel && v) {
      const b = sel.bbox; const tol = 8 / v.pxPerMm;
      const onHandle = ([hx, hy]: [number, number]) => Math.abs(w.x - hx) < tol && Math.abs(w.y - hy) < tol;
      if (([[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]] as [number, number][]).some(onHandle)) {
        const l = sel.layer;
        drag.current = { id: l.id, mode: "scale", ox: 0, oy: 0, startScale: l.scale, startDist: Math.max(1, Math.hypot(w.x - l.cx, w.y - l.cy)) };
        e.currentTarget.setPointerCapture(e.pointerId); return;
      }
    }
    for (let i = placed.length - 1; i >= 0; i--) {
      const p = placed[i], b = p.bbox;
      if (w.x >= b.minX && w.x <= b.maxX && w.y >= b.minY && w.y <= b.maxY) {
        select(p.layer.id);
        drag.current = { id: p.layer.id, mode: "move", ox: p.layer.cx - w.x, oy: p.layer.cy - w.y, startScale: p.layer.scale, startDist: 0 };
        e.currentTarget.setPointerCapture(e.pointerId); return;
      }
    }
    setSelId(null);
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return;
    const w = toWorld(e); const d = drag.current;
    const v = viewRef.current;
    const cur = layers.find((x) => x.id === d.id); if (!cur || !v) return;
    // The whole visible area is workable - clamp to the screen, not the hoop.
    const halfW = v.w / (2 * v.pxPerMm) - 4;
    const halfH = v.h / (2 * v.pxPerMm) - 4;
    if (d.mode === "move") {
      patch(d.id, { cx: Math.max(-halfW, Math.min(halfW, w.x + d.ox)), cy: Math.max(-halfH, Math.min(halfH, w.y + d.oy)) });
    } else {
      const dist = Math.hypot(w.x - cur.cx, w.y - cur.cy);
      patch(d.id, { scale: Math.max(12, Math.min(Math.max(hoop.w, hoop.h) * 1.5, d.startScale * (dist / d.startDist))) });
    }
  };
  const onUp = () => { drag.current = null; };

  // Delete / Backspace removes the selected layer - unless you're typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (selId) { e.preventDefault(); remove(selId); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId]);

  const saveToLibrary = async () => {
    if (!design) return;
    setSaveState("saving");
    try {
      const c = document.createElement("canvas"); c.width = 220; c.height = 220; const tctx = c.getContext("2d");
      if (tctx) {
        tctx.fillStyle = FABRIC; tctx.fillRect(0, 0, 220, 220);
        const s = Math.min(200 / hoop.w, 200 / hoop.h);
        tctx.lineWidth = 1;
        for (const p of placed) for (const g of p.groups) { tctx.strokeStyle = g.color; for (const path of g.paths) { if (path.length < 2) continue; tctx.beginPath(); path.forEach((q, i) => (i ? tctx.lineTo(q.x * s + 110, q.y * s + 110) : tctx.moveTo(q.x * s + 110, q.y * s + 110))); tctx.stroke(); } }
      }
      await saveDesignEverywhere({ id: crypto.randomUUID(), name: NAME, tool: "workspace", createdAt: Date.now(), stitchCount: design.stats.realStitches, widthMm: design.stats.widthMm, heightMm: design.stats.heightMm, colors: built.colors, thumbPng: c.toDataURL("image/png"), bytes: design.bytes });
      setSaveState("done"); setTimeout(() => setSaveState("idle"), 1800);
    } catch { setSaveState("idle"); }
  };

  const layerLabel = (l: Layer) =>
    l.kind === "shape" ? BLOCK_BY_TYPE[(l as ShapeLayer).type].label
    : l.kind === "text" ? `“${(l as TextLayer).text.slice(0, 14)}”`
    : l.kind === "design" ? (l as DesignLayer).name
    : (l as PhotoLayer).name || "Photo";

  // ── Bottom bar: left third (per-tab gallery/input) ──
  const barLeft =
    tab === "shape" ? (
      <div className="h-full grid grid-rows-2 grid-flow-col auto-cols-[56px] gap-1 overflow-x-auto py-1.5 pr-2" style={{ scrollbarWidth: "thin" }}>
        {BLOCK_DEFS.filter((d) => d.type !== "color").map((d) => (
          <button key={d.type} onClick={() => addShape(d.type)} title={`${d.label} - ${d.hint}`} className="border border-hairline bg-bg hover:border-accent flex items-center justify-center">
            <Mini groups={SHAPE_THUMBS[d.type]} size={46} />
          </button>
        ))}
      </div>
    ) : tab === "photo" ? (
      <div className="h-full flex flex-col justify-center gap-1 py-1.5 pr-2">
        <ImagePick onImage={addPhoto} fileName="" longSide={220} />
        <p className={MICRO}>The photo lands as a layer - squiggle portrait, halftone lines, or counted cross-stitch in matched thread colors.</p>
      </div>
    ) : tab === "text" ? (
      <div className="h-full flex flex-col justify-center gap-1.5 py-1.5 pr-2">
        <input
          value={sel?.layer.kind === "text" ? (sel.layer as TextLayer).text : draftText}
          onChange={(e) => (sel?.layer.kind === "text" ? patch(sel.layer.id, { text: e.target.value }) : setDraftText(e.target.value))}
          placeholder="Type something…"
          className="border border-hairline bg-bg text-fg px-2 py-1.5 text-[0.875rem] w-full"
        />
        <div className="flex gap-1.5">
          <select
            value={sel?.layer.kind === "text" && !(sel.layer as TextLayer).custom ? (sel.layer as TextLayer).face : !draftCustom && sel?.layer.kind !== "text" ? draftFace : ""}
            onChange={(e) => {
              const f = e.target.value as HersheyFaceId;
              if (!f) return;
              if (sel?.layer.kind === "text") patch(sel.layer.id, { face: f, custom: null });
              else { setDraftFace(f); setDraftCustom(null); }
            }}
            className="flex-1 min-w-0 border border-hairline bg-bg text-fg px-1.5 py-1 text-[0.8125rem]"
          >
            {((sel?.layer.kind === "text" && (sel.layer as TextLayer).custom) || (sel?.layer.kind !== "text" && draftCustom)) && (
              <option value="">Your font (uploaded)</option>
            )}
            {HERSHEY_PICKER_IDS.map((id) => <option key={id} value={id}>{HERSHEY_FACES[id].name}</option>)}
          </select>
          <button onClick={addText} className="border border-fg bg-fg text-bg px-2.5 py-1 text-[0.8125rem] hover:opacity-85 whitespace-nowrap">＋ Add</button>
        </div>
        <div className="flex items-center gap-2">
          <label className="cursor-pointer border border-hairline bg-bg px-2 py-0.5 text-[0.6875rem] text-mid hover:text-fg whitespace-nowrap">
            Upload your font (.ttf / .otf)
            <input type="file" accept=".ttf,.otf,.woff,.woff2,font/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void loadFont(f); }} />
          </label>
          {(() => {
            const custom = sel?.layer.kind === "text" ? (sel.layer as TextLayer).custom : draftCustom;
            return custom ? (
              <span className="flex items-center gap-1 text-[0.6875rem] text-fg border border-hairline bg-card px-1.5 py-0.5 min-w-0">
                <span className="truncate max-w-[10rem]">{custom.name}</span>
                <button onClick={() => (sel?.layer.kind === "text" ? patch(sel.layer.id, { custom: null }) : setDraftCustom(null))}
                  className="text-mid hover:text-fg">✕</button>
              </span>
            ) : null;
          })()}
          {fontError && <span className="text-[0.6875rem]" style={{ color: "#c0392b" }}>{fontError}</span>}
        </div>
      </div>
    ) : tab === "saved" ? (
      <div className="h-full flex items-center gap-1.5 overflow-x-auto py-1.5 pr-2" style={{ scrollbarWidth: "thin" }}>
        {saved === null ? (
          <p className={MICRO}>Opening your library…</p>
        ) : saved.length === 0 ? (
          <p className={`${MICRO} leading-relaxed`}>
            Nothing saved yet - every tool's ☆ Save lands designs here, ready to place on the canvas.
          </p>
        ) : (
          saved.map((d) => (
            <button key={d.id} onClick={() => addDesign(d)} title={`${d.name} - add to the canvas`}
              className="shrink-0 border border-hairline bg-bg hover:border-accent overflow-hidden">
              <img src={d.thumbPng} alt={d.name} className="w-[72px] h-[72px] object-cover" />
            </button>
          ))
        )}
      </div>
    ) : (
      // Settings: the hoop you'll stitch in + the design totals.
      <div className="h-full flex flex-col justify-center gap-2 py-1.5 pr-2">
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-[0.75rem] text-mid">
            Hoop
            <select value={hoopId} onChange={(e) => setHoopId(e.target.value)} className="border border-hairline bg-bg text-fg px-1.5 py-1 text-[0.8125rem]">
              {HOOPS.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
            </select>
          </label>
          <button
            onClick={() => setHoopLandscape((v) => !v)}
            title="Rotate the hoop 90°"
            className="flex items-center gap-1.5 border border-hairline bg-bg px-2 py-1 text-[0.6875rem] text-mid hover:text-fg"
          >
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M4 9V5.5h9M20 15v3.5h-9M16.5 3 20 5.5 16.5 8M7.5 21 4 18.5 7.5 16" /></svg>
            {hoopLandscape ? "Landscape" : "Portrait"}
          </button>
          <label className="flex items-center gap-2 text-[0.75rem] text-mid">
            Units
            <UnitsToggle />
          </label>
        </div>
        <p className={`${MICRO} tabular-nums leading-relaxed`}>
          {design
            ? <>Design so far: <span className="text-fg">{design.stats.realStitches.toLocaleString()} stitches</span> · {fmtSize(design.stats.widthMm, design.stats.heightMm, units)} · ~{formatMinutes(design.stats.runtimeMinutes)} on machine</>
            : "Nothing on the canvas yet."}
        </p>
        {overHoop && design && (
          <p className="text-[0.6875rem] text-amber-900 bg-amber-100/70 border border-amber-700/40 px-2 py-1 leading-snug">
            {fmtSize(design.stats.widthMm, design.stats.heightMm, units)} is larger than this hoop - scale down or pick a bigger one.
          </p>
        )}
      </div>
    );

  // ── Bottom bar: center (selection parameters / settings overview) ──
  const selLayer = sel?.layer ?? null;
  const barCenter =
    tab === "settings" ? (
      placed.length ? (
        <div className="h-full flex items-center gap-1.5 overflow-x-auto py-1.5" style={{ scrollbarWidth: "thin" }}>
          {placed.map((p) => (
            <button key={p.layer.id} onClick={() => select(p.layer.id)}
              className={`shrink-0 border ${p.layer.id === selId ? "border-fg" : "border-hairline"} bg-bg hover:border-accent px-2 py-1 flex items-center gap-2 text-left`}>
              <span className="w-10 h-10 flex items-center justify-center"><Mini groups={layerGroups(p.layer)} size={40} /></span>
              <span className="pr-1">
                <span className="block text-[0.6875rem] text-fg leading-tight truncate max-w-[9rem]">{layerLabel(p.layer)}</span>
                <span className="block text-[0.625rem] text-mid tabular-nums leading-tight">
                  {fmtSize(p.bbox.w, p.bbox.h, units)} · ≈{Math.max(1, Math.round(p.lenMm / STITCH_LEN)).toLocaleString()} st
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="h-full flex items-center"><p className={MICRO}>Add something to the canvas and each piece shows up here with its size and stitch count.</p></div>
      )
    ) : !selLayer ? (
      <div className="h-full flex items-center">
        <p className={MICRO}>
          {tab === "shape" ? "Pick a shape on the left - it lands on the canvas as a layer you can drag, then its dials show here." :
           tab === "photo" ? "Choose a photo on the left. Its dials show here once it's on the canvas." :
           tab === "saved" ? "Tap a saved design on the left - it lands on the canvas with its original stitches and colors." :
           "Type on the left and hit Add. The lettering dials show here."}
        </p>
      </div>
    ) : selLayer.kind === "shape" ? (
      <div className="h-full grid grid-cols-2 gap-x-5 content-center">
        {BLOCK_BY_TYPE[selLayer.type].params.filter(isNum).slice(0, 4).map((p) => (
          <RangeRow key={p.key} label={p.label} value={Number((selLayer as ShapeLayer).params[p.key])} min={p.min} max={p.max} step={p.step}
            onChange={(v) => patch(selLayer.id, { params: { ...(selLayer as ShapeLayer).params, [p.key]: v } } as Partial<Layer>)}
            fmt={(v) => (p.step < 1 ? v.toFixed(1) : String(v))} />
        ))}
      </div>
    ) : selLayer.kind === "text" ? (
      <div className="h-full grid grid-cols-2 gap-x-5 content-center">
        <RangeRow label="Letter spacing" value={(selLayer as TextLayer).spacing} min={0.7} max={2} step={0.05} onChange={(v) => patch(selLayer.id, { spacing: v })} fmt={(v) => `×${v.toFixed(2)}`} />
        <p className={`${MICRO} self-center`}>Stroke lettering - every line sews as drawn. Edit the words on the left.</p>
      </div>
    ) : selLayer.kind === "design" ? (
      <div className="h-full flex items-center">
        <p className={MICRO}>
          A design from your library, placed with its original stitches and colors. Drag it on the canvas; size and
          rotate on the right.
        </p>
      </div>
    ) : (
      (() => {
        const ph = selLayer as PhotoLayer;
        return (
          <div className="h-full flex flex-col justify-center gap-1">
            <div className="flex gap-1">
              {([["portrait", "Portrait squiggle"], ["halftone", "Halftone lines"], ["crossstitch", "Cross-stitch"]] as const).map(([m, label]) => (
                <button key={m} onClick={() => patch(ph.id, { mode: m })}
                  className={`px-2 py-1 text-[0.6875rem] border ${ph.mode === m ? "border-fg bg-fg text-bg" : "border-hairline bg-bg text-mid hover:text-fg"}`}>
                  {label}
                </button>
              ))}
            </div>
            {ph.mode === "portrait" ? (
              <div className="grid grid-cols-2 gap-x-5">
                <RangeRow label="Detail" value={ph.points} min={800} max={4000} step={100} onChange={(v) => patch(ph.id, { points: v })} />
                <RangeRow label="Darkness" value={ph.pgamma} min={0.8} max={3} step={0.1} onChange={(v) => patch(ph.id, { pgamma: v })} fmt={(v) => v.toFixed(1)} />
              </div>
            ) : ph.mode === "halftone" ? (
              <div className="grid grid-cols-2 gap-x-5">
                <RangeRow label="Line rows" value={ph.rows} min={14} max={70} step={1} onChange={(v) => patch(ph.id, { rows: v })} />
                <RangeRow label="Darkness" value={ph.dark} min={0.6} max={3} step={0.1} onChange={(v) => patch(ph.id, { dark: v })} fmt={(v) => v.toFixed(1)} />
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-x-4">
                <RangeRow label="Detail" value={ph.cells} min={24} max={80} step={1} onChange={(v) => patch(ph.id, { cells: v })} />
                <RangeRow label="Thread colors" value={ph.cones} min={2} max={6} step={1} onChange={(v) => patch(ph.id, { cones: v })} fmt={(v) => `${v} cones`} />
                <RangeRow label="Skip light above" value={ph.light} min={0.7} max={0.98} step={0.01} onChange={(v) => patch(ph.id, { light: v })} fmt={(v) => v.toFixed(2)} />
              </div>
            )}
            {ph.mode !== "crossstitch" && (
              <label className="flex items-center gap-1.5 text-[0.6875rem] text-mid">
                <input type="checkbox" checked={ph.invert} onChange={(e) => patch(ph.id, { invert: e.target.checked })} className="accent-accent" />
                Stitch the light instead of the dark
              </label>
            )}
          </div>
        );
      })()
    );

  // ── Bottom bar: right (transform + export, constant) ──
  const barRight = (
    <div className="h-full w-[210px] sm:w-[300px] shrink-0 flex flex-col justify-center gap-1 pl-3">
      {selLayer ? (
        // Two RangeRows don't fit side by side on a phone - they overlap.
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
          <RangeRow label="Size" value={Math.round(selLayer.scale)} min={12} max={Math.round(Math.max(hoop.w, hoop.h) * 1.5)} step={1} onChange={(v) => patch(selLayer.id, { scale: v })} fmt={(v) => fmtLen(v, units)} />
          <RangeRow label="Rotate" value={selLayer.rot} min={0} max={359} step={1} onChange={(v) => patch(selLayer.id, { rot: v })} fmt={(v) => `${v}°`} />
        </div>
      ) : (
        <p className={`${MICRO} tabular-nums`}>
          {design
            ? `${design.stats.realStitches.toLocaleString()} st · ${fmtSize(design.stats.widthMm, design.stats.heightMm, units)} · ~${formatMinutes(design.stats.runtimeMinutes)}`
            : "Nothing on the canvas yet."}
        </p>
      )}
      {selLayer && sel && (
        <div className="flex items-center gap-1">
          <span className="text-[0.625rem] text-mid mr-0.5">Align</span>
          {(() => {
            const b = sel.bbox;
            const hw = hoop.w / 2, hh = hoop.h / 2;
            const mv = (dx: number, dy: number) => patch(selLayer.id, { cx: selLayer.cx + dx, cy: selLayer.cy + dy });
            const A = "w-6 h-6 border border-hairline bg-bg text-[0.625rem] text-mid hover:text-fg hover:border-fg";
            return (
              <>
                <button title="Align left edge of hoop" aria-label="Align left edge of hoop" className={A} onClick={() => mv(-hw - b.minX, 0)}>L</button>
                <button title="Center horizontally" aria-label="Center horizontally" className={A} onClick={() => mv(-(b.minX + b.maxX) / 2, 0)}>C</button>
                <button title="Align right edge of hoop" aria-label="Align right edge of hoop" className={A} onClick={() => mv(hw - b.maxX, 0)}>R</button>
                <span className="w-1" />
                <button title="Align top of hoop" aria-label="Align top of hoop" className={A} onClick={() => mv(0, -hh - b.minY)}>T</button>
                <button title="Center vertically" aria-label="Center vertically" className={A} onClick={() => mv(0, -(b.minY + b.maxY) / 2)}>M</button>
                <button title="Align bottom of hoop" aria-label="Align bottom of hoop" className={A} onClick={() => mv(0, hh - b.maxY)}>B</button>
                <span className="w-1" />
                <button title="Flip horizontally (mirror)" aria-label="Flip horizontally" className={A} onClick={() => patch(selLayer.id, { flipX: !selLayer.flipX })}>⇄</button>
                <button title="Flip vertically" aria-label="Flip vertically" className={A} onClick={() => patch(selLayer.id, { flipY: !selLayer.flipY })}>⇅</button>
              </>
            );
          })()}
        </div>
      )}
      {selLayer && selLayer.kind !== "design" && (selLayer.kind !== "photo" || (selLayer as PhotoLayer).mode !== "crossstitch") && (
        <div className="flex items-center gap-1.5">
          <span className="text-[0.6875rem] text-mid">Thread</span>
          <span className="w-4 h-4 border border-hairline shrink-0" style={{ background: selLayer.color }} />
          <div className="min-w-0 flex-1 [&_select]:w-full [&_select]:py-0.5 [&_select]:text-[0.75rem]">
            <ThreadSelect value={selLayer.color} onChange={(hex) => patch(selLayer.id, { color: hex })} />
          </div>
        </div>
      )}
      {selLayer?.kind === "photo" && (selLayer as PhotoLayer).mode === "crossstitch" && (
        <p className={MICRO}>Thread colors are matched from the photo, one cone per color.</p>
      )}
      {selLayer?.kind === "design" && (
        <p className={MICRO}>Colors come from the saved design.</p>
      )}
      <div className="flex gap-1.5 pt-0.5">
        <button onClick={() => design && downloadDesign(design, built.colors, NAME, fmt)} disabled={!design}
          className="flex-1 border border-fg bg-fg text-bg px-2 py-1.5 text-[0.75rem] disabled:opacity-40 hover:opacity-85 whitespace-nowrap">
          Download .{fmt}
        </button>
        <span className="flex border border-hairline">
          {(["dst", "pes", "jef"] as const).map((f) => (
            <button key={f} onClick={() => setFmt(f)} className={`px-1.5 py-1 text-[0.625rem] uppercase ${fmt === f ? "bg-fg text-bg" : "bg-bg text-mid"}`}>{f}</button>
          ))}
        </span>
        <button onClick={() => void saveToLibrary()} disabled={!design || saveState !== "idle"} aria-label="Save to library"
          className="border border-hairline bg-bg px-2 py-1.5 text-[0.75rem] text-fg disabled:opacity-40 hover:bg-card whitespace-nowrap">
          {saveState === "done" ? "Saved ✓" : saveState === "saving" ? "Saving…" : "☆ Save"}
        </button>
      </div>
      <AnimExport built={design} colors={built.colors} name={NAME} />
    </div>
  );

  const mobileShell = useIsMobile();

  // ── Shell (fills the fullscreen box the page gives it - no page scroll).
  // Mobile: the rail becomes a horizontal strip above the canvas and the
  // bottom toolbar stacks vertically in a fixed-height deck - the canvas
  // always owns the middle of the screen (the clothing-lab shell). ──
  return (
    <div className="h-full flex flex-col bg-bg overflow-hidden">
      <div className={mobileShell ? "flex flex-col flex-1 min-h-0" : "flex flex-1 min-h-0"}>
        {/* Icon rail - left column on desktop, top strip on mobile */}
        <div className={mobileShell
          ? "h-12 shrink-0 border-b border-hairline bg-card flex flex-row items-center px-1 gap-1 overflow-x-auto"
          : "w-14 shrink-0 border-r border-hairline bg-card flex flex-col items-center py-2 gap-1"}>
          <button onClick={() => setToolsOpen(true)} title="All tools - every tool opens in its own canvas"
            className="w-10 h-10 flex flex-col items-center justify-center gap-0.5 text-mid hover:text-fg hover:bg-bg mb-1">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="4" y="4" width="7" height="7" /><rect x="13" y="4" width="7" height="7" /><rect x="4" y="13" width="7" height="7" /><rect x="13" y="13" width="7" height="7" /></svg>
            <span className="text-[0.5rem] tracking-[0.06em] uppercase leading-none">Tools</span>
          </button>
          {RAIL_ICONS.map(({ tab: t, label, icon }) => (
            <button key={t} onClick={() => setTab(t)} title={label}
              className={`w-10 h-10 flex flex-col items-center justify-center gap-0.5 ${tab === t ? "bg-fg text-bg" : "text-mid hover:text-fg hover:bg-bg"}`}>
              {icon}
              <span className="text-[0.5rem] tracking-[0.06em] uppercase leading-none">{label}</span>
            </button>
          ))}
        </div>

        {/* Canvas - fills everything between the toolbars */}
        <div className="relative flex-1 min-h-0">
          <canvas ref={canvasRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
            className="absolute inset-0 w-full h-full touch-none cursor-move" style={{ background: FABRIC }} />

          {/* Zoom - bottom-left overlay */}
          <div className="absolute bottom-2 left-2 flex border border-hairline bg-bg/80 backdrop-blur-sm">
            <button onClick={() => setZoom((z) => Math.max(0.6, +(z / 1.25).toFixed(2)))} title="Zoom out" aria-label="Zoom out" className="w-8 h-8 text-fg hover:bg-card text-[1rem]">−</button>
            <button onClick={() => setZoom(1)} title="Show the whole hoop" className="px-2 h-8 text-[0.6875rem] text-mid hover:text-fg border-x border-hairline">Fit hoop</button>
            <button onClick={() => setZoom((z) => Math.min(3, +(z * 1.25).toFixed(2)))} title="Zoom in" aria-label="Zoom in" className="w-8 h-8 text-fg hover:bg-card text-[1rem]">＋</button>
          </div>

          {/* Layers - floating ON the canvas, semi-transparent */}
          <div className={`absolute top-2 right-2 ${mobileShell ? "w-44 max-h-[55%]" : "w-56 max-h-[70%]"} flex flex-col border border-hairline bg-bg/75 backdrop-blur-sm`}>
            <button onClick={() => setLayersOpen((v) => !v)} className="flex items-center justify-between px-2.5 py-1.5 text-[0.6875rem] tracking-[0.12em] uppercase text-mid hover:text-fg">
              Layers{layers.length ? ` · ${layers.length}` : ""}
              <span>{layersOpen ? "▾" : "▸"}</span>
            </button>
            {layersOpen && (
              <div className="overflow-y-auto border-t border-hairline divide-y divide-hairline/60">
                {!layers.length && <p className="px-2.5 py-2 text-[0.6875rem] text-mid">Nothing yet - add from the bottom bar.</p>}
                {[...placed].reverse().map((p) => {
                  const l = p.layer;
                  const active = l.id === selId;
                  return (
                    <div key={l.id} className={`flex items-center gap-1.5 px-1.5 py-1 ${active ? "bg-card/90 border-l-2 border-accent" : "border-l-2 border-transparent hover:bg-card/60"}`}>
                      <button onClick={() => select(active ? null : l.id)} className="flex items-center gap-1.5 flex-1 min-w-0 text-left">
                        <span className="w-3 h-3 border border-hairline shrink-0" style={{ background: p.groups[0]?.color ?? l.color }} />
                        <span className="flex-1 truncate text-[0.75rem] text-fg">{layerLabel(l)}</span>
                        <span className="text-[0.625rem] text-mid tabular-nums shrink-0">{fmtWH(p.bbox.w, p.bbox.h, units)}</span>
                      </button>
                      <button onClick={() => duplicate(l.id)} title="Duplicate layer" aria-label="Duplicate layer" className="text-mid hover:text-fg text-[0.75rem] px-1 py-1">⧉</button>
                      <button onClick={() => move(l.id, 1)} title="Sew later (up in stack)" aria-label="Sew later (up in stack)" className="text-mid hover:text-fg text-[0.75rem] px-1 py-1">↑</button>
                      <button onClick={() => move(l.id, -1)} title="Sew earlier (down in stack)" aria-label="Sew earlier (down in stack)" className="text-mid hover:text-fg text-[0.75rem] px-1 py-1">↓</button>
                      <button onClick={() => remove(l.id)} title="Delete layer" aria-label="Delete layer" className="text-mid hover:text-fg text-[0.75rem] px-1 py-1">✕</button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {toolsOpen && <ToolsModal onClose={() => setToolsOpen(false)} />}

      {/* Bottom toolbar - fixed height; three columns on desktop, a vertical
          scrolling deck on mobile so nothing pushes the canvas around */}
      {mobileShell ? (
        <div className="h-[15rem] shrink-0 border-t border-hairline bg-card overflow-y-auto px-3 py-2 space-y-3">
          <div>{barLeft}</div>
          <div>{barCenter}</div>
          <div className="border-t border-hairline/70 pt-2">{barRight}</div>
        </div>
      ) : (
        <div className="h-[8.75rem] shrink-0 border-t border-hairline bg-card flex items-stretch px-3 overflow-x-auto">
          <div className="w-[34%] min-w-[280px] shrink-0 border-r border-hairline/70 pr-1">{barLeft}</div>
          <div className="flex-1 min-w-[300px] px-3 border-r border-hairline/70">{barCenter}</div>
          {barRight}
        </div>
      )}
    </div>
  );
}
