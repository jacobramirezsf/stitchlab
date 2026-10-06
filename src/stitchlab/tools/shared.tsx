// Shared scaffolding for Stitch Lab experimental tools. Every tool builds the
// same honest pipeline: params → stitches → real DST bytes → re-parse →
// preview, so the preview is always rendered from the exact file you download.

import { Children, Fragment, cloneElement, isValidElement, useEffect, useMemo, useRef, useState } from "react";
import { saveDesignEverywhere, AUTH_EVENT } from "../lib/sync";
import { shapeRings, type Ring } from "./tatami";
import { svgToPaths } from "../lib/generators";
import type { RefObject, ReactNode, ReactElement } from "react";
import { THREADS, THREAD_FAMILIES, type Thread } from "../../data/threads";
import { CMD, type ParsedPattern, type Stitch } from "../lib/pattern";
import { parseDst, writeDst } from "../lib/dst";
import { writePes } from "../lib/pes";
import { writeJef } from "../lib/jef";
import { computeStats, type PatternStats } from "../lib/stats";
import { fitTransform, renderPattern, renderDensity } from "../lib/render";
import AnimExport from "./animexport";
import { saveBlob } from "../lib/native";

export const EYEBROW = "text-[0.6875rem] tracking-[0.18em] uppercase text-mid";
export const LABEL = "text-[0.6875rem] tracking-[0.14em] uppercase text-mid";

/** Jacob's machine hoops up to 13×16 in. */
export const HOOP_MM = { w: 330, h: 406 };

// ─── Units preference (inches by default, metric a toggle away) ──────────
// Geometry stays mm internally everywhere; only display formats change.

export type Units = "in" | "mm";
const UNITS_KEY = "stitchlab-units";
const UNITS_EVENT = "stitchlab:units";

export function getUnits(): Units {
  try { return localStorage.getItem(UNITS_KEY) === "mm" ? "mm" : "in"; } catch { return "in"; }
}
export function setUnits(u: Units): void {
  try { localStorage.setItem(UNITS_KEY, u); } catch { /* ignore */ }
  window.dispatchEvent(new Event(UNITS_EVENT));
}
/** Reactive units preference - every subscriber updates when any toggle flips. */
export function useUnits(): Units {
  const [u, setU] = useState<Units>(getUnits);
  useEffect(() => {
    const on = () => setU(getUnits());
    window.addEventListener(UNITS_EVENT, on);
    return () => window.removeEventListener(UNITS_EVENT, on);
  }, []);
  return u;
}

export function UnitsToggle() {
  const units = useUnits();
  return (
    <span className="flex border border-hairline" title="Units">
      {(["in", "mm"] as const).map((x) => (
        <button key={x} onClick={() => setUnits(x)}
          className={`px-1.5 py-0.5 text-[0.625rem] uppercase ${units === x ? "bg-fg text-bg" : "bg-bg text-mid hover:text-fg"}`}>
          {x}
        </button>
      ))}
    </span>
  );
}

export const fmtLen = (mm: number, u: Units, digits = 1): string =>
  u === "in" ? `${(mm / 25.4).toFixed(digits)} in` : `${mm.toFixed(0)} mm`;
export const fmtSize = (wMm: number, hMm: number, u: Units): string =>
  u === "in" ? `${(wMm / 25.4).toFixed(1)} × ${(hMm / 25.4).toFixed(1)} in` : `${wMm.toFixed(0)} × ${hMm.toFixed(0)} mm`;
/** Compact WxH for tight rows: 2.4×2.5″ / 60×63mm. */
export const fmtWH = (wMm: number, hMm: number, u: Units): string =>
  u === "in" ? `${(wMm / 25.4).toFixed(1)}×${(hMm / 25.4).toFixed(1)}″` : `${wMm.toFixed(0)}×${hMm.toFixed(0)}mm`;
export const fmtThread = (m: number, u: Units): string =>
  u === "in" ? `${(m / 0.9144).toFixed(1)} yd` : `${m.toFixed(1)} m`;

export function fitsHoop(widthMm: number, heightMm: number): boolean {
  return (
    (widthMm <= HOOP_MM.w && heightMm <= HOOP_MM.h) ||
    (widthMm <= HOOP_MM.h && heightMm <= HOOP_MM.w)
  );
}

export const FABRICS = [
  { name: "Bone", hex: "#f4f2ee" },
  { name: "Oat", hex: "#eceae5" },
  { name: "Navy", hex: "#22304f" },
  { name: "Charcoal", hex: "#191714" },
  { name: "White", hex: "#ffffff" },
];

// ─── Fabric presets ──────────────────────────────────────────────────────
// Encoded from manufacturer-primary sources (Madeira density table, Melco,
// Hatch/Wilcom docs) + practitioner consensus - see docs/stitchlab-research-
// frontiers.pdf §3. Values are starting points; the fabric always votes last.

export type FabricId = "canvas" | "tee" | "pique" | "fleece" | "leather";

export type FabricPreset = {
  name: string;
  satinSpacingMm: number;
  tatamiSpacingMm: number;
  pullCompMm: number;
  note: string;
};

export const FABRIC_PRESETS: Record<FabricId, FabricPreset> = {
  canvas: {
    name: "Stable woven",
    satinSpacingMm: 0.4,
    tatamiSpacingMm: 0.4,
    pullCompMm: 0.2,
    note: "Canvas, denim, drill - the baseline everything else adjusts from.",
  },
  tee: {
    name: "T-shirt knit",
    satinSpacingMm: 0.4,
    tatamiSpacingMm: 0.4,
    pullCompMm: 0.35,
    note: "Jersey stretches under the needle - compensation does the work here.",
  },
  pique: {
    name: "Polo piqué",
    satinSpacingMm: 0.4,
    tatamiSpacingMm: 0.42,
    pullCompMm: 0.3,
    note: "The waffle texture swallows thin elements - keep columns ≥2 mm.",
  },
  fleece: {
    name: "Fleece",
    satinSpacingMm: 0.32,
    tatamiSpacingMm: 0.38,
    pullCompMm: 0.4,
    note: "Thread sinks into the nap - denser cover, more comp, solid underlay.",
  },
  leather: {
    name: "Leather / vinyl",
    satinSpacingMm: 0.5,
    tatamiSpacingMm: 0.55,
    pullCompMm: 0.1,
    note: "Every needle hole is permanent - open the density, prefer runs to fills.",
  },
};

export function FabricSelect({
  value,
  onChange,
}: {
  value: FabricId;
  onChange: (id: FabricId) => void;
}) {
  return (
    <div>
      <div className={`${LABEL} mb-1.5`}>Fabric</div>
      <ModeButtons
        small
        options={(Object.keys(FABRIC_PRESETS) as FabricId[]).map(
          (id) => [id, FABRIC_PRESETS[id].name] as const,
        )}
        value={value}
        onChange={onChange}
      />
      <p className="mt-1.5 text-[0.6875rem] text-mid leading-relaxed">
        {FABRIC_PRESETS[value].note}
      </p>
    </div>
  );
}


// ─── Size control: slider + typed inches (Jacob's machine speaks inches) ──

/** Big-key number pad for entering a value on touch - no OS keyboard zoom, no
 *  tiny input. Types in the CURRENT units; commits clamped. */
function NumPad({
  label,
  unit,
  initial,
  minLabel,
  maxLabel,
  onCommit,
  onClose,
}: {
  label: string;
  unit: string;
  initial: string;
  minLabel: string;
  maxLabel: string;
  onCommit: (v: number) => void;
  onClose: () => void;
}) {
  // Start empty so the first digit replaces the old value (calculator feel);
  // the old value stays visible as a placeholder.
  const [typed, setTyped] = useState("");
  const shown = typed === "" ? initial : typed;
  const tap = (k: string) => {
    if (k === "⌫") { setTyped((t) => t.slice(0, -1)); return; }
    if (k === "." && (typed.includes(".") || unit === "mm")) return;
    setTyped((t) => (t + k).slice(0, 6));
  };
  const commit = () => {
    const v = parseFloat(shown);
    if (!Number.isNaN(v)) onCommit(v);
    onClose();
  };
  return (
    <>
      <div className="fixed inset-0 z-40 bg-fg/25" onClick={onClose} />
      <div className="fixed inset-x-0 bottom-0 z-50 border-t border-hairline bg-bg pb-[env(safe-area-inset-bottom)]">
        <div className="px-4 pt-3 pb-1 flex items-baseline justify-between">
          <span className={LABEL}>{label}</span>
          <span className="text-[0.6875rem] text-mid tabular-nums">{minLabel} – {maxLabel}</span>
        </div>
        <div className="px-4 pb-2">
          <div className={`border border-hairline px-3 py-2 text-right text-[1.5rem] tabular-nums leading-none ${typed === "" ? "text-mid" : "text-fg"}`}>
            {shown} <span className="text-[0.875rem] text-mid">{unit}</span>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-px bg-hairline border-t border-hairline">
          {["1","2","3","4","5","6","7","8","9",".","0","⌫"].map((k) => (
            <button
              key={k}
              onClick={() => tap(k)}
              disabled={k === "." && unit === "mm"}
              className="bg-bg py-3.5 text-[1.25rem] text-fg active:bg-card disabled:opacity-30"
            >
              {k}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 p-3">
          <button onClick={onClose} className="border border-hairline bg-bg py-2.5 text-[0.875rem] text-mid">Cancel</button>
          <button onClick={commit} className="border border-fg bg-fg text-bg py-2.5 text-[0.875rem]">Set {label.toLowerCase()}</button>
        </div>
      </div>
    </>
  );
}

export function SizeField({
  label = "Size",
  valueMm,
  min,
  max,
  onChange,
}: {
  label?: string;
  valueMm: number;
  min: number;
  max: number;
  onChange: (mm: number) => void;
}) {
  const units = useUnits();
  const mobile = useIsMobile();
  const [padOpen, setPadOpen] = useState(false);
  const toIn = (mm: number) => mm / 25.4;
  const clamp = (mm: number) => Math.max(min, Math.min(max, mm));
  const shownValue = units === "in" ? toIn(valueMm).toFixed(2) : String(Math.round(valueMm));
  // fine nudge: a real step in the current units, not one meaningless mm
  const nudge = (dir: 1 | -1) => onChange(clamp(valueMm + dir * (units === "in" ? 25.4 / 4 : 5)));
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className={LABEL}>{label}</span>
        {mobile ? (
          <button
            onClick={() => setPadOpen(true)}
            className="border border-hairline bg-bg px-3 py-1.5 text-[0.9375rem] text-fg tabular-nums"
          >
            {shownValue} <span className="text-[0.75rem] text-mid">{units} ✎</span>
          </button>
        ) : (
          <div className="flex items-center gap-1">
            <input
              type="number"
              value={shownValue}
              step={units === "in" ? 0.25 : 5}
              min={units === "in" ? toIn(min).toFixed(2) : Math.round(min)}
              max={units === "in" ? toIn(max).toFixed(2) : Math.round(max)}
              onChange={(ev) => {
                const v = parseFloat(ev.target.value);
                if (!Number.isNaN(v)) onChange(clamp(units === "in" ? v * 25.4 : v));
              }}
              className="w-16 border border-hairline bg-bg px-1.5 py-0.5 text-[0.8125rem] text-fg tabular-nums text-right"
            />
            <span className="text-[0.75rem] text-mid">{units}</span>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        {mobile && (
          <button onClick={() => nudge(-1)} aria-label={`Smaller ${label}`} className="shrink-0 w-9 h-9 border border-hairline bg-bg text-[1.125rem] text-fg active:bg-card">−</button>
        )}
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={valueMm}
          onChange={(ev) => onChange(Number(ev.target.value))}
          className="w-full min-w-0 accent-accent h-8 lg:h-auto touch-manipulation"
        />
        {mobile && (
          <button onClick={() => nudge(1)} aria-label={`Bigger ${label}`} className="shrink-0 w-9 h-9 border border-hairline bg-bg text-[1.125rem] text-fg active:bg-card">+</button>
        )}
      </div>
      <div className="text-[0.6875rem] text-mid tabular-nums">
        {toIn(valueMm).toFixed(2)} in · {valueMm.toFixed(0)} mm
      </div>
      {padOpen && (
        <NumPad
          label={label}
          unit={units}
          initial={shownValue}
          minLabel={units === "in" ? `${toIn(min).toFixed(2)} in` : `${Math.round(min)} mm`}
          maxLabel={units === "in" ? `${toIn(max).toFixed(2)} in` : `${Math.round(max)} mm`}
          onCommit={(v) => onChange(clamp(units === "in" ? v * 25.4 : v))}
          onClose={() => setPadOpen(false)}
        />
      )}
    </div>
  );
}

export function formatMinutes(min: number): string {
  if (min < 1) return `${Math.round(min * 60)}s`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ─── Build pipeline ──────────────────────────────────────────────────────

export type Built = {
  bytes: Uint8Array;
  pattern: ParsedPattern;
  stats: PatternStats;
};

/** stitches → DST bytes → re-parsed pattern + stats. Null when not sewable. */
export function buildDesign(stitches: Stitch[] | null, name: string): Built | null {
  if (!stitches || stitches.filter((s) => s.cmd === CMD.STITCH).length < 2) return null;
  try {
    const bytes = writeDst(stitches, name.slice(0, 16));
    const pattern = parseDst(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
    return { bytes, pattern, stats: computeStats(pattern) };
  } catch {
    return null;
  }
}

export function downloadBuilt(built: Built, name: string): void {
  downloadBytesAs(built.bytes, `${name}.dst`);
}

export type StitchFormat = "dst" | "pes" | "jef";

/** Download a built design as DST, PES or JEF. PES is re-encoded from the parsed
 *  stitch stream + the per-block colors (snapped to the Brother machine palette). */
export function downloadDesign(built: Built, colors: string[], name: string, format: StitchFormat): void {
  if (format === "jef") {
    downloadBytesAs(writeJef(built.pattern.stitches, colors), `${name}.jef`);
  } else if (format === "pes") {
    const bytes = writePes(built.pattern.stitches, colors, name);
    downloadBytesAs(bytes, `${name}.pes`);
  } else {
    downloadBytesAs(built.bytes, `${name}.dst`);
  }
}

/** Download button + DST/PES/JEF format toggle, for tools with their own preview
 *  (composer, studio, blocks) that don't use PreviewRail. */
export function ExportButton({ built, colors, name }: { built: Built | null; colors: string[]; name: string }) {
  const [fmt, setFmt] = useState<StitchFormat>("dst");
  return (
    <>
      <button
        onClick={() => built && downloadDesign(built, colors, name, fmt)}
        disabled={!built}
        className="flex-1 border border-fg bg-fg text-bg px-4 py-2 text-[0.875rem] disabled:opacity-40 hover:opacity-85"
      >
        <span className="lg:hidden">Download .{fmt}</span>
        <span className="hidden lg:inline">Download .{fmt}</span>
      </button>
      <div className="flex border border-hairline">
        {(["dst", "pes", "jef"] as const).map((f) => (
          <button key={f} onClick={() => setFmt(f)} className={`px-2.5 py-2 text-[0.75rem] uppercase ${fmt === f ? "bg-fg text-bg" : "bg-bg text-mid hover:text-fg"}`}>{f}</button>
        ))}
      </div>
    </>
  );
}

function downloadBytesAs(bytes: Uint8Array, filename: string): void {
  void saveBlob(new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }), filename);
}

// ─── Canvas ──────────────────────────────────────────────────────────────

export type CanvasDraw = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

export function useCanvas(draw: CanvasDraw | null, layoutKey?: string): RefObject<HTMLCanvasElement | null> {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !draw) return;
    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(ctx, w, h);
    };
    render();
    // Redraw when the element resizes (fixed app shells, rotation, sheet moves)
    const ro = new ResizeObserver(render);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [draw, layoutKey]);
  return ref;
}


/** True on phone/small-tablet widths. Drives the app-shell tool layout (pinned
 *  canvas + scrolling controls + sticky action bar), so mobile feels like the
 *  clothing lab studio rather than a long scroll of properties above the canvas. */
export function useIsMobile(query = "(max-width: 1023px)"): boolean {
  const [m, setM] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return m;
}

// ─── Debounce (polish: heavy generators recompute after the slider rests) ─

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * A debounced "key" for a set of slider/param values. Sliders stay bound to raw
 * state (so the thumb moves smoothly), while the returned string only changes
 * once the values have rested for `ms`. Use it as the sole dependency of a heavy
 * useMemo (generation + buildDesign) so the expensive work runs after the drag,
 * not on every event. The memo body reads the live params, which are current by
 * the time the key settles.
 *
 *   const key = useDebouncedKey([count, gamma, size]);
 *   const built = useMemo(() => heavyBuild(count, gamma, size), [key]);
 */
export function useDebouncedKey(values: unknown[], ms = 160): string {
  return useDebounced(JSON.stringify(values), ms);
}

// ─── Shape source: built-in shapes or an uploaded SVG ────────────────────

export type ShapeId = "circle" | "square" | "star" | "heart" | "ring";
const SHAPE_OPTIONS = [
  ["circle", "Circle"],
  ["square", "Square"],
  ["star", "Star"],
  ["heart", "Heart"],
  ["ring", "Ring"],
  ["svg", "Your SVG"],
] as const;

/**
 * Owns shape/SVG selection state and returns the region rings plus the
 * control UI. Closed SVG paths become rings (even-odd holes supported -
 * a shape inside a shape becomes a hole, same as the tatami tool).
 */
export function useShapeSource(
  sizeMm: number,
  initial: ShapeId = "circle",
): { rings: Ring[]; element: React.ReactNode; isSvg: boolean } {
  const [mode, setMode] = useState<ShapeId | "svg">(initial);
  const [svgText, setSvgText] = useState("");
  const [svgName, setSvgName] = useState("");
  const [svgError, setSvgError] = useState<string | null>(null);

  const rings = useMemo<Ring[]>(() => {
    try {
      setSvgError(null);
      if (mode === "svg") {
        if (!svgText.trim()) return [];
        return svgToPaths(svgText, sizeMm).filter((p) => p.length >= 3);
      }
      return shapeRings(mode, sizeMm);
    } catch (err) {
      setSvgError(err instanceof Error ? err.message : "Could not read that SVG.");
      return [];
    }
  }, [mode, svgText, sizeMm]);

  const element = (
    <div className="space-y-2">
      <ModeButtons small options={SHAPE_OPTIONS} value={mode} onChange={setMode} />
      {mode === "svg" && (
        <DropZone
          match={(f) => f.name.toLowerCase().endsWith(".svg") || f.type === "image/svg+xml"}
          onFile={(f) => {
            void f.text().then((t) => {
              setSvgText(t);
              setSvgName(f.name);
            });
          }}
          className="space-y-1.5 border border-dashed border-mid/50 px-3 py-3"
        >
          <label className="inline-block cursor-pointer border border-hairline bg-bg px-3 py-1.5 text-[0.8125rem] text-fg hover:bg-card">
            {svgName ? `↻ ${svgName}` : "Choose .svg"}
            <input
              type="file"
              accept=".svg,image/svg+xml"
              className="hidden"
              onChange={async (ev) => {
                const f = ev.target.files?.[0];
                if (f) {
                  setSvgText(await f.text());
                  setSvgName(f.name);
                }
                ev.target.value = "";
              }}
            />
          </label>
          {svgError && <p className="text-[0.75rem] text-red-700">{svgError}</p>}
          <p className="text-[0.6875rem] text-mid leading-relaxed">
            Closed outlines become the region; a shape inside a shape becomes a hole -
            or drop the .svg anywhere in this box.
          </p>
        </DropZone>
      )}
    </div>
  );
  return { rings, element, isSvg: mode === "svg" };
}


// ─── Drop zone (drag & drop for any file picker) ─────────────────────────

export function DropZone({
  onFile,
  onFiles,
  match,
  children,
  className,
}: {
  onFile: (f: File) => void;
  /** When provided, ALL matching dropped files are handed over (multi-drop). */
  onFiles?: (files: File[]) => void;
  /** Accept predicate; defaults to images. */
  match?: (f: File) => boolean;
  children: ReactNode;
  className?: string;
}) {
  const [over, setOver] = useState(false);
  const accepts = match ?? ((f: File) => f.type.startsWith("image/"));
  return (
    <div
      onDragOver={(ev) => {
        ev.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(ev) => {
        ev.preventDefault();
        setOver(false);
        const matching = Array.from(ev.dataTransfer.files).filter(accepts);
        if (!matching.length) return;
        if (onFiles && matching.length > 1) onFiles(matching);
        else onFile(matching[0]);
      }}
      className={`${className ?? ""} ${
        over ? "outline outline-2 outline-accent bg-card" : ""
      } transition-colors rounded-none`}
    >
      {children}
    </div>
  );
}

// ─── Image picker (shared by every photo tool) ───────────────────────────

export type LumImg = { w: number; h: number; lum: Float32Array; rgb: Uint8ClampedArray };

export function ImagePick({
  onImage,
  onFile,
  fileName,
  longSide = 200,
  hint,
}: {
  onImage: (img: LumImg, name: string) => void;
  /** Optional: also receive the raw file (e.g. for background removal). */
  onFile?: (f: File) => void;
  fileName: string;
  longSide?: number;
  hint?: string;
}) {
  const handle = async (f: File) => {
    onFile?.(f);
    const url = URL.createObjectURL(f);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Could not read that image."));
        image.src = url;
      });
      const scale = longSide / Math.max(image.width, image.height);
      const w = Math.max(32, Math.round(image.width * scale));
      const h = Math.max(32, Math.round(image.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      // Flatten transparency onto white: cutout PNGs should read as empty
      // fabric, not a stitched black background.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(image, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      const lum = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        lum[i] =
          (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
      }
      onImage({ w, h, lum, rgb: data }, f.name);
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  return (
    <DropZone onFile={(f) => void handle(f)} className="space-y-1.5 border border-dashed border-mid/50 px-3 py-3">
      <label className="inline-block cursor-pointer border border-hairline bg-bg px-4 py-1.5 text-[0.8125rem] text-fg hover:bg-card">
        {fileName ? `↻ ${fileName}` : "Choose image"}
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(ev) => {
            const f = ev.target.files?.[0];
            ev.target.value = "";
            if (f) void handle(f);
          }}
        />
      </label>
      <span className="ml-2 text-[0.6875rem] text-mid">or drop it here</span>
      {hint && <p className="text-[0.6875rem] text-mid leading-relaxed">{hint}</p>}
    </DropZone>
  );
}

// ─── Controls ────────────────────────────────────────────────────────────

export function SectionBox({
  eyebrow,
  children,
  defaultOpen = true,
}: {
  eyebrow: string;
  children: ReactNode;
  /** Fold rarely-touched groups by default to keep the rail short. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="sl-control-section border border-hairline bg-card px-3.5 py-2.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`${EYEBROW} w-full flex items-center justify-between gap-2 cursor-pointer text-left`}
      >
        <span>{eyebrow}</span>
        <span aria-hidden="true" className="text-[0.75rem] leading-none">{open ? "▾" : "▸"}</span>
      </button>
      {open ? <div className="mt-2.5 space-y-2">{children}</div> : null}
    </div>
  );
}

export function RangeRow({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  fmt,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  fmt?: (v: number) => string;
}) {
  return (
    <label
      className="sl-range grid grid-cols-[6.5rem_1fr_auto] items-center gap-x-2 text-[0.75rem] text-mid"
      title={label}
    >
      <span className="truncate">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(ev) => onChange(Number(ev.target.value))}
        className="w-full min-w-0 accent-accent h-8 lg:h-auto touch-manipulation"
      />
      <span className="tabular-nums text-fg text-right min-w-[2.5rem]">{fmt ? fmt(value) : value}</span>
    </label>
  );
}

export function ModeButtons<T extends string | number>({
  options,
  value,
  onChange,
  small,
}: {
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (v: T) => void;
  small?: boolean;
}) {
  return (
    <div className="sl-modes flex flex-wrap gap-1.5">
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          aria-pressed={value === v}
          className={`${small ? "px-2.5 py-1 text-[0.6875rem]" : "px-3 py-1 text-[0.75rem]"} border ${
            value === v ? "border-fg bg-fg text-bg" : "border-hairline bg-bg text-fg hover:bg-card"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function ThreadSelect({
  value,
  onChange,
}: {
  value: string; // hex
  onChange: (hex: string, code: string) => void;
}) {
  return (
    <select
      className="border border-hairline bg-bg text-fg rounded-none px-2 py-1.5 text-[0.8125rem] max-w-full"
      value={THREADS.find((t) => t.hex === value)?.code ?? ""}
      onChange={(ev) => {
        const t = THREADS.find((th) => th.code === ev.target.value);
        if (t?.hex) onChange(t.hex, t.code);
      }}
    >
      <option value="">Pick a cone…</option>
      {THREAD_FAMILIES.map((fam) => {
        const members = THREADS.filter((t) => t.family === fam && t.hex);
        if (members.length === 0) return null;
        return (
          <optgroup key={fam} label={fam}>
            {members.map((t) => (
              <option key={t.code} value={t.code}>
                {t.code} - {t.name}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}

export function ThreadRow({
  label,
  hex,
  onChange,
}: {
  label?: string;
  hex: string;
  onChange: (hex: string, code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<Thread | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const current = THREADS.find((t) => t.hex === hex);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("pointerdown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className="text-[0.75rem] text-mid" ref={boxRef}>
      {label ?? "Thread"}
      <div className="relative mt-1">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 border border-hairline bg-bg px-2 py-1.5 text-left hover:border-fg"
          aria-expanded={open}
        >
          <span className="w-5 h-5 border border-hairline shrink-0" style={{ background: hex }} />
          <span className="flex-1 truncate text-[0.8125rem] text-fg">
            {current ? `${current.name} · ${current.code}` : "Pick a cone…"}
          </span>
          <span className="text-mid">{open ? "▴" : "▾"}</span>
        </button>
        {open && (
          <div className="absolute left-0 right-0 z-40 mt-1 border border-hairline bg-bg shadow-xl">
            <div className="max-h-72 overflow-y-auto p-2 space-y-2">
              {THREAD_FAMILIES.map((fam) => {
                const members = THREADS.filter((t) => t.family === fam && t.hex);
                if (!members.length) return null;
                return (
                  <div key={fam}>
                    <div className="mb-1 text-[0.625rem] tracking-[0.12em] uppercase text-mid">{fam}</div>
                    <div className="grid grid-cols-10 gap-1">
                      {members.map((t) => (
                        <button
                          key={t.code}
                          title={`${t.name} · ${t.code}`}
                          aria-label={`${t.name} ${t.code}`}
                          onMouseEnter={() => setHover(t)}
                          onMouseLeave={() => setHover(null)}
                          onFocus={() => setHover(t)}
                          onClick={() => { if (t.hex) { onChange(t.hex, t.code); setOpen(false); } }}
                          className={`aspect-square w-full border ${t.hex === hex ? "border-fg ring-1 ring-fg" : "border-hairline hover:border-fg"}`}
                          style={{ background: t.hex ?? "#fff" }}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="border-t border-hairline px-2 py-1.5 text-[0.75rem] text-fg min-h-[2rem]">
              {hover ? `${hover.name} · ${hover.code}${hover.isMetallic ? " · metallic" : ""}` : current ? `${current.name} · ${current.code}` : "Hover a cone"}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="border border-amber-700/40 bg-amber-100/60 px-3 py-2 text-[0.75rem] text-amber-900">
      {children}
    </p>
  );
}

// ─── Preview rail ────────────────────────────────────────────────────────

export function PreviewRail({
  built,
  colors,
  name,
  emptyHint,
  showDensity,
  threadMm,
  previewPattern,
  previewColors,
  mobileControls,
  mobileGroups,
  mobileExtras,
  desktopControls,
  children,
}: {
  built: Built | null;
  colors: string[]; // per color block
  name: string;
  emptyHint: string;
  showDensity?: boolean;
  /** Rendered thread width in mm. Raise it (~0.55–0.7) for tools where dense
   *  running lines merge on fabric, so the preview predicts the real stitch-out
   *  instead of drawing a thinner, more delicate line than the machine sews. */
  threadMm?: number;
  /** Render this pattern on the canvas instead of `built.pattern` (download,
   *  save, stats still use `built`). For per-element highlighting. */
  previewPattern?: ParsedPattern;
  /** Per-color-block colors for `previewPattern`. */
  previewColors?: string[];
  /** When set (mobile only, injected by ToolLayout), PreviewRail renders the
   *  app-shell layout: canvas pinned to the top, these controls scrolling
   *  beneath, and Download/Save in a sticky bottom bar. */
  mobileControls?: ReactNode;
  /** When set (mobile, injected by ToolLayout), renders the TABBED app shell:
   *  each group is a bottom tab opening its own compact sheet (clothing-lab
   *  pattern), plus an Export tab with download/save/animate. */
  mobileGroups?: { label: string; content: ReactNode }[];
  /** Loose non-section controls (warnings etc.) - shown as always-visible
   *  notices above the tab bar. */
  mobileExtras?: ReactNode;
  /** When set (desktop, injected by ToolLayout), PreviewRail renders the
   *  editor-frame layout: the canvas fills the center of a viewport-height
   *  workspace, these controls live in an internally-scrolling sidebar, and
   *  stats + Download/Save sit in a bar under the canvas. The page never
   *  scrolls to reach a control, and the canvas never leaves the frame. */
  desktopControls?: ReactNode;
  children?: ReactNode;
}) {
  const [fabric, setFabric] = useState(FABRICS[0].hex);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "cloud" | "device" | "device-error">("idle");
  const [fmt, setFmt] = useState<StitchFormat>("dst");
  const units = useUnits();

  // Mobile controls. Tabbed shell: `tab` holds the open group's label (or
  // "export"). Opens the FIRST group once when the tool starts empty (the
  // photo picker / shape chooser is the first thing you need); generator tools
  // that build instantly land on a full-canvas result instead.
  // Lazy initial state: tools that mount empty open their first group (the
  // photo picker is the first thing you need); generator tools that build
  // synchronously mount with `built` set and land on a full-canvas result.
  const [sheetOpen, setSheetOpen] = useState(
    () => !built && mobileGroups === undefined && mobileControls !== undefined,
  );
  const [tab, setTab] = useState<string | null>(
    () => (!built && mobileGroups?.length ? mobileGroups[0].label : null),
  );

  const saveToLibrary = async () => {
    if (!built) return;
    setSaveState("saving");
    try {
      // Thumbnail: render the re-parsed pattern small, on bone.
      const thumb = document.createElement("canvas");
      thumb.width = 220;
      thumb.height = 220;
      const tctx = thumb.getContext("2d");
      if (tctx) {
        tctx.fillStyle = FABRICS[0].hex;
        tctx.fillRect(0, 0, 220, 220);
        renderPattern(tctx, built.pattern, fitTransform(built.pattern, 220, 220, 12), {
          colors,
          sheen: false,
          threadMm,
        });
      }
      const where = await saveDesignEverywhere({
        id: crypto.randomUUID(),
        name,
        tool: name.replace(/^bayside-/, ""),
        createdAt: Date.now(),
        stitchCount: built.stats.realStitches,
        widthMm: built.stats.widthMm,
        heightMm: built.stats.heightMm,
        colors,
        thumbPng: thumb.toDataURL("image/png"),
        bytes: built.bytes,
      });
      setSaveState(where);
      setTimeout(() => setSaveState("idle"), where === "cloud" ? 2200 : 7000);
    } catch {
      setSaveState("idle");
    }
  };

  const draw = useMemo<CanvasDraw | null>(() => {
    if (!built) return null;
    // The canvas may render a preview-only pattern (e.g. per-block, dimmed to
    // highlight one element) while download/save/stats keep using `built`.
    const pat = previewPattern ?? built.pattern;
    const cols = previewPattern ? previewColors ?? colors : colors;
    return (ctx, w, h) => {
      ctx.fillStyle = fabric;
      ctx.fillRect(0, 0, w, h);
      const view = fitTransform(pat, w, h);
      renderPattern(ctx, pat, view, { colors: cols, sheen: true, threadMm });
      if (showDensity) renderDensity(ctx, pat, view);
    };
  }, [built, colors, fabric, showDensity, threadMm, previewPattern, previewColors]);
  const canvasRef = useCanvas(draw, mobileGroups !== undefined ? "tabs" : mobileControls !== undefined ? "drawer" : desktopControls !== undefined ? "desktop" : "fallback");

  // ── Shared pieces, arranged differently for desktop vs the mobile shell ──
  const fabricSwatches = FABRICS.map((f) => (
    <button
      key={f.hex}
      title={f.name}
      onClick={() => setFabric(f.hex)}
      className={`w-6 h-6 border ${fabric === f.hex ? "border-accent border-2" : "border-hairline"}`}
      style={{ background: f.hex }}
    />
  ));

  const hoopWarning =
    built && !fitsHoop(built.stats.widthMm, built.stats.heightMm) ? (
      <Warning>
        {fmtSize(built.stats.widthMm, built.stats.heightMm, units)} exceeds the 13 × 16 in
        hoop in every orientation - shrink before stitching.
      </Warning>
    ) : null;

  const actionBar = (
    <div className="flex gap-2">
      <button
        onClick={() => built && downloadDesign(built, colors, name, fmt)}
        disabled={!built}
        className="flex-1 border border-fg bg-fg text-bg px-4 py-2 text-[0.875rem] disabled:opacity-40 hover:opacity-85"
      >
        <span className="lg:hidden">Download .{fmt}</span>
        <span className="hidden lg:inline">Download .{fmt}</span>
      </button>
      <div className="flex border border-hairline">
        {(["dst", "pes", "jef"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFmt(f)}
            className={`px-2.5 py-2 text-[0.75rem] uppercase ${fmt === f ? "bg-fg text-bg" : "bg-bg text-mid hover:text-fg"}`}
          >
            {f}
          </button>
        ))}
      </div>
      <button
        onClick={() => void saveToLibrary()}
        disabled={!built || saveState !== "idle"}
        className="border border-hairline bg-bg px-4 py-2 text-[0.875rem] text-fg disabled:opacity-40 hover:bg-card whitespace-nowrap"
      >
        {saveState === "cloud" ? "Saved ✓" : saveState === "device" || saveState === "device-error" ? "Saved ✓" : saveState === "saving" ? "Saving…" : "☆ Save"}
      </button>
    </div>
  );

  const saveHint =
    saveState === "cloud" ? (
      <p className="text-[0.6875rem] text-mid leading-snug">Saved to your library and synced to your account.</p>
    ) : saveState === "device" ? (
      <p className="text-[0.6875rem] text-mid leading-snug">
        Saved in this browser only.{" "}
        <button onClick={() => window.dispatchEvent(new Event(AUTH_EVENT))} className="text-accent underline">
          Make a free account
        </button>{" "}
        to keep your library safe anywhere.
      </p>
    ) : saveState === "device-error" ? (
      <p className="text-[0.6875rem] text-mid leading-snug">
        Saved in this browser - the account sync didn't go through. It retries on your next save.
      </p>
    ) : null;

  const explainer = (
    <p className="text-[0.6875rem] text-mid leading-relaxed">
      The preview is re-parsed from the exact DST bytes you'll download - what you see is the file
      your machine reads. Export as Tajima <span className="uppercase">dst</span> or Brother{" "}
      <span className="uppercase">pes</span>, or Janome JEF. PES/JEF colors snap to the machine palette. Check your machine’s supported hoop size before stitching.
    </p>
  );

  // ── Mobile TABBED app shell (the clothing-lab / collections pattern): the
  // canvas owns the screen, each control group is its own bottom tab opening a
  // compact in-layout sheet (the design stays visible and re-renders live
  // above it), and Export is a tab like any other. One thing at a time,
  // everything one thumb-tap away. ──
  if (mobileGroups !== undefined) {
    const activeGroup = tab && tab !== "export" ? mobileGroups.find((g) => g.label === tab) ?? null : null;
    const drawerOpen = tab === "export" || activeGroup !== null;
    const tabBtn = (key: string, label: ReactNode) => (
      <button
        key={key}
        onClick={() => setTab((t) => (t === key ? null : key))}
        aria-expanded={tab === key}
        className={`flex-1 min-w-0 px-1 py-3 text-[0.625rem] tracking-[0.08em] uppercase truncate ${
          tab === key ? "bg-fg text-bg" : "text-mid active:bg-card"
        }`}
      >
        {label}
      </button>
    );
    return (
      <div className="sl-mobile-tool h-[calc(100dvh-94px)] min-h-[380px] flex flex-col overflow-hidden">
        {/* canvas fills the leftover; the drawer below never covers it */}
        <div className="relative flex-1 min-h-[120px]" style={{ background: fabric }}>
          <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
          {!built && (
            <div className="absolute inset-0 flex items-center justify-center p-6 text-center pointer-events-none">
              <p className="text-[0.9375rem] text-mid leading-relaxed max-w-[28ch]">{emptyHint}</p>
            </div>
          )}
        </div>

        {/* occasional notices stay visible whatever tab is open */}
        {(hoopWarning || saveHint || mobileExtras) && (
          <div className="shrink-0 border-t border-hairline bg-bg px-3 py-1.5 space-y-1">
            {hoopWarning}
            {saveHint}
            {mobileExtras}
          </div>
        )}

        {/* slim stat strip */}
        <div className="shrink-0 border-t border-hairline bg-bg px-3 py-1.5 flex items-center gap-x-2.5">
          {built ? (
            <p className="min-w-0 truncate text-[0.75rem] text-mid tabular-nums leading-snug">
              {built.stats.realStitches.toLocaleString()} st ·{" "}
              {fmtSize(built.stats.widthMm, built.stats.heightMm, units)} · ~
              {formatMinutes(built.stats.runtimeMinutes)}
            </p>
          ) : (
            <p className="min-w-0 truncate text-[0.75rem] text-mid">Nothing to stitch yet</p>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1.5"><UnitsToggle />{fabricSwatches}</div>
        </div>

        {/* the open tab's sheet - in the layout, canvas visible above */}
        {drawerOpen && (
          <div className="shrink-0 max-h-[min(44dvh,380px)] border-t border-hairline bg-bg flex flex-col">
            <button
              onClick={() => setTab(null)}
              aria-label="Collapse controls"
              className="shrink-0 w-full pt-1.5 pb-1 flex items-center justify-center"
            >
              <span className="h-1 w-9 rounded-full bg-hairline" aria-hidden="true" />
            </button>
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 pb-3">
              {tab === "export" ? (
                <div className="space-y-3">
                  {children}
                  {actionBar}
                  <AnimExport built={built} colors={colors} name={name} threadMm={threadMm} />
                  {explainer}
                </div>
              ) : (
                <div className="space-y-2.5">{activeGroup?.content}</div>
              )}
            </div>
          </div>
        )}

        {/* bottom tab bar: one tab per control group + Export */}
        <div className="shrink-0 border-t border-hairline bg-bg flex pb-[env(safe-area-inset-bottom)]">
          {mobileGroups.map((g) => tabBtn(g.label, g.label))}
          {tabBtn("export", <>↓ Export</>)}
        </div>
      </div>
    );
  }

  // ── Mobile app shell (single-drawer fallback for tools whose controls don't
  // parse into sections): canvas on top, all controls in one in-layout drawer,
  // actions in a bottom bar. ──
  if (mobileControls !== undefined) {
    return (
      <div className="sl-mobile-tool h-[calc(100dvh-94px)] min-h-[380px] flex flex-col overflow-hidden">
        {/* canvas fills whatever the strips below leave - never less than a
            real preview band, so the design stays visible with the drawer open */}
        <div className="relative flex-1 min-h-[120px]" style={{ background: fabric }}>
          <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
          {!built && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-[0.9375rem] text-mid leading-relaxed max-w-[28ch]">{emptyHint}</p>
              {!sheetOpen && (
                <button
                  onClick={() => setSheetOpen(true)}
                  className="border border-fg bg-fg text-bg px-4 py-2 text-[0.875rem]"
                >
                  Get started
                </button>
              )}
            </div>
          )}
        </div>

        {/* slim stat strip: numbers + units + fabric */}
        <div className="shrink-0 border-t border-hairline bg-bg px-3 py-1.5 flex items-center gap-x-2.5">
          {built ? (
            <p className="min-w-0 truncate text-[0.75rem] text-mid tabular-nums leading-snug">
              {built.stats.realStitches.toLocaleString()} st ·{" "}
              {fmtSize(built.stats.widthMm, built.stats.heightMm, units)} · ~
              {formatMinutes(built.stats.runtimeMinutes)}
            </p>
          ) : (
            <p className="min-w-0 truncate text-[0.75rem] text-mid">Nothing to stitch yet</p>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1.5"><UnitsToggle />{fabricSwatches}</div>
        </div>

        {/* occasional notices stay visible even with the drawer closed */}
        {(hoopWarning || saveHint) && (
          <div className="shrink-0 border-t border-hairline bg-bg px-3 py-1.5 space-y-1">
            {hoopWarning}
            {saveHint}
          </div>
        )}

        {/* controls drawer - IN the layout, not over it: the canvas compresses
            above (and refits the whole design), so every slider change is
            visible live while you drag. Scrolls internally; never squeezes. */}
        {sheetOpen && (
          <div className="shrink-0 h-[min(46dvh,360px)] border-t border-hairline bg-bg flex flex-col">
            <button
              onClick={() => setSheetOpen(false)}
              aria-label="Collapse controls"
              className="shrink-0 w-full pt-1.5 pb-1 flex items-center justify-center"
            >
              <span className="h-1 w-9 rounded-full bg-hairline" aria-hidden="true" />
            </button>
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 pb-3 space-y-4">
              {mobileControls}
              {children}
              <AnimExport built={built} colors={colors} name={name} threadMm={threadMm} />
              {explainer}
            </div>
          </div>
        )}

        {/* action bar: adjust · download · format · save */}
        <div className="shrink-0 border-t border-hairline bg-bg px-3 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] flex gap-2">
          <button
            onClick={() => setSheetOpen((v) => !v)}
            aria-expanded={sheetOpen}
            className={`px-3.5 py-2.5 text-[0.875rem] border whitespace-nowrap ${sheetOpen ? "border-fg bg-fg text-bg" : "border-fg bg-bg text-fg"}`}
          >
            Adjust
          </button>
          <button
            onClick={() => built && downloadDesign(built, colors, name, fmt)}
            disabled={!built}
            className="flex-1 min-w-0 border border-fg bg-fg text-bg px-3 py-2.5 text-[0.875rem] disabled:opacity-40"
          >
            Download .{fmt}
          </button>
          <div className="flex border border-hairline">
            {(["dst", "pes", "jef"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFmt(f)}
                className={`px-2 py-2 text-[0.6875rem] uppercase ${fmt === f ? "bg-fg text-bg" : "bg-bg text-mid"}`}
              >
                {f}
              </button>
            ))}
          </div>
          <button
            onClick={() => void saveToLibrary()}
            disabled={!built || saveState !== "idle"}
            className="border border-hairline bg-bg px-3 py-2.5 text-[0.875rem] text-fg disabled:opacity-40 whitespace-nowrap"
          >
            {saveState === "saving" ? "…" : saveState !== "idle" ? "✓" : "☆"}
          </button>
        </div>

      </div>
    );
  }

  // ── Desktop editor frame: big canvas center, controls in an internally-
  // scrolling sidebar, stats + actions in a bar under the canvas. The page
  // itself never needs to scroll to reach a control. ──
  if (desktopControls !== undefined) {
    return (
      <div className="sl-editor-frame flex items-stretch border border-hairline bg-bg h-[max(480px,calc(100dvh-8rem))]">
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 min-h-0 bg-card/40 p-4 flex items-center justify-center">
            <canvas ref={canvasRef} className="w-full h-full border border-hairline" style={{ background: fabric }} />
          </div>
          <div className="shrink-0 border-t border-hairline px-3 py-2 space-y-1.5">
            {hoopWarning}
            {saveHint}
            {children}
            <details className="sl-extra-exports"><summary>Image & animation exports</summary><AnimExport built={built} colors={colors} name={name} threadMm={threadMm} /></details>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {built ? (
                <p className="min-w-0 text-[0.75rem] text-mid tabular-nums leading-snug">
                  {built.stats.realStitches.toLocaleString()} st · {fmtSize(built.stats.widthMm, built.stats.heightMm, units)} ·{" "}
                  {fmtThread(built.stats.stitchPathM, units)} thread ·{" "}
                  {built.stats.colorBlockCount > 1 ? `${built.stats.colorBlockCount} colors · ` : ""}~
                  {formatMinutes(built.stats.runtimeMinutes)}
                </p>
              ) : (
                <p className="min-w-0 text-[0.75rem] text-mid">{emptyHint}</p>
              )}
              <div className="flex items-center gap-1.5"><UnitsToggle />{fabricSwatches}</div>
              <div className="ml-auto flex gap-2">{actionBar}</div>
            </div>
          </div>
        </div>
        <aside className="sl-control-rail w-[360px] shrink-0 border-l border-hairline overflow-y-auto px-3 py-3 space-y-2.5 bg-bg">
          <div className="sl-rail-title">Make it yours<span>Adjust the design. Preview updates live.</span></div>
          {desktopControls}
          {explainer}
        </aside>
      </div>
    );
  }

  // ── Fallback (tools with a custom preview): canvas pinned at the top of
  // the preview column so it never scrolls out of frame. ──
  return (
    <div className="space-y-3">
      <div className="sticky top-0 z-10 bg-bg pb-1">
        <canvas
          ref={canvasRef}
          className="w-full h-[clamp(300px,52vh,460px)] border border-hairline"
          style={{ background: fabric }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {built ? (
          <p className="text-[0.8125rem] text-mid tabular-nums">
            {built.stats.realStitches.toLocaleString()} stitches ·{" "}
            {fmtSize(built.stats.widthMm, built.stats.heightMm, units)} ·{" "}
            {fmtThread(built.stats.stitchPathM, units)} thread ·{" "}
            {built.stats.colorBlockCount > 1 ? `${built.stats.colorBlockCount} colors · ` : ""}~
            {formatMinutes(built.stats.runtimeMinutes)} on machine
          </p>
        ) : (
          <p className="text-[0.8125rem] text-mid">{emptyHint}</p>
        )}
        <div className="flex items-center gap-1.5 ml-auto"><UnitsToggle />{fabricSwatches}</div>
      </div>
      {children}
      {hoopWarning}
      {actionBar}
      <AnimExport built={built} colors={colors} name={name} threadMm={threadMm} />
      {saveHint}
      {explainer}
    </div>
  );
}

export function ToolLayout({ controls, preview }: { controls: ReactNode; preview: ReactNode }) {
  const mobile = useIsMobile();

  // Mobile: hand the controls to PreviewRail as TAB GROUPS (the clothing-lab
  // pattern) - each SectionBox becomes a bottom tab that opens its own compact
  // sheet, so the canvas stays visible while you adjust one thing at a time.
  // Controls that don't parse into 2+ sections fall back to a single drawer.
  if (mobile) {
    if (isValidElement(preview) && preview.type === PreviewRail) {
      const list =
        isValidElement(controls) && controls.type === Fragment
          ? Children.toArray((controls.props as { children?: ReactNode }).children)
          : Children.toArray(controls);
      const groups: { label: string; content: ReactNode }[] = [];
      const extras: ReactNode[] = [];
      for (const el of list) {
        if (isValidElement(el) && el.type === SectionBox) {
          const p = el.props as { eyebrow: string; children: ReactNode };
          groups.push({ label: p.eyebrow, content: p.children });
        } else {
          // Children.toArray already drops null/undefined/booleans
          extras.push(el);
        }
      }
      if (groups.length >= 2) {
        return cloneElement(
          preview as ReactElement<{ mobileGroups?: { label: string; content: ReactNode }[]; mobileExtras?: ReactNode }>,
          { mobileGroups: groups, mobileExtras: extras.length ? <>{extras}</> : undefined },
        );
      }
      return cloneElement(preview as ReactElement<{ mobileControls?: ReactNode }>, {
        mobileControls: controls,
      });
    }
    return (
      <div className="space-y-4">
        {preview}
        {controls}
      </div>
    );
  }

  // Desktop: hand the controls to PreviewRail so it renders the editor frame
  // (big canvas center, sidebar controls with their own scroll, action bar
  // under the canvas). The page never scrolls to reach a control.
  if (isValidElement(preview) && preview.type === PreviewRail) {
    return cloneElement(preview as ReactElement<{ desktopControls?: ReactNode }>, {
      desktopControls: controls,
    });
  }

  // Fallback for tools with a custom preview (e.g. the composer): the classic
  // two-column grid with a sticky preview column.
  return (
    <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
      <div className="space-y-4 min-w-0">{controls}</div>
      <div className="min-w-0">
        <div className="lg:sticky lg:top-4 lg:max-h-[calc(100dvh-1.5rem)] lg:overflow-y-auto lg:overflow-x-hidden">
          {preview}
        </div>
      </div>
    </div>
  );
}
