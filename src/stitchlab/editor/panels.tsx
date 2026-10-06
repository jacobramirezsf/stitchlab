// Editor panels: add elements, the element list (select / reorder / hide /
// lock / duplicate / delete - list order IS sew order), per-element
// properties driven by adapter param specs, and the export flow with the
// authoritative re-parsed preview.

import { useEffect, useRef, useState } from "react";
import { ADAPTERS, adaptersByCategory, defaultParams, type Adapter, type ParamSpec } from "./adapters";
import type { Group } from "./geometry";
import type { BuiltElement } from "./build";
import {
  SCALE_SAFE,
  stitchFileScale,
  type GeneratedElement,
  type Project,
  type ProjectElement,
  type ParamValue,
} from "../lib/project";
import type { SavedDesign } from "../lib/library";
import {
  RangeRow,
  ThreadRow,
  Warning,
  downloadDesign,
  fitsHoop,
  fmtSize,
  formatMinutes,
  type Built,
  type StitchFormat,
  type Units,
} from "../tools/shared";
import { renderPattern, fitTransform } from "../lib/render";

const INK = "#26324d";

// ── adapter thumbnails (real generated geometry, cached) ──────────────────

const thumbCache = new Map<string, Group[]>();
function adapterGroups(a: Adapter): Group[] {
  let g = thumbCache.get(a.id);
  if (!g) {
    try {
      g = a.needsImage ? [] : a.generate(defaultParams(a), {}).groups;
    } catch {
      g = [];
    }
    thumbCache.set(a.id, g);
  }
  return g;
}

export function AdapterThumb({ adapter, size = 52 }: { adapter: Adapter; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#f7f5f1";
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 0.9;
    const groups = adapterGroups(adapter);
    const pad = size * 0.12;
    const s = (size - pad * 2) / 100;
    for (const g of groups) {
      for (const p of g.paths) {
        if (p.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(p[0].x * s + pad, p[0].y * s + pad);
        for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x * s + pad, p[i].y * s + pad);
        ctx.stroke();
      }
    }
    if (adapter.needsImage) {
      ctx.fillStyle = "#8b8677";
      ctx.font = `${size * 0.5}px system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("▦", size / 2, size / 2);
    }
    if (adapter.id === "lettering") {
      ctx.fillStyle = INK;
      ctx.font = `600 ${size * 0.42}px Georgia, serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.clearRect(0, 0, size, size);
      ctx.fillStyle = "#f7f5f1";
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = INK;
      ctx.fillText("Aa", size / 2, size / 2 + 1);
    }
  }, [adapter, size]);
  return <canvas ref={ref} style={{ width: size, height: size }} aria-hidden="true" />;
}

// ── add panel ──────────────────────────────────────────────────────────────

const PHOTO_STYLES: { id: string; label: string }[] = [
  { id: "oneline", label: "One line" },
  { id: "hatchtone", label: "Cross-hatch" },
  { id: "halftone", label: "Waves" },
  { id: "imagepack", label: "Dots" },
  { id: "reference", label: "Reference only" },
];

export function AddPanel({
  onAdapter,
  onPhoto,
  onLibrary,
  compact,
  initialTab,
}: {
  onAdapter: (a: Adapter) => void;
  onPhoto: (adapterId: string) => void;
  onLibrary: () => void;
  compact?: boolean;
  initialTab?: string;
}) {
  const [tab, setTab] = useState<"patterns" | "words" | "photo" | "more">(
    initialTab === "words" || initialTab === "photo" || initialTab === "more" ? initialTab : "patterns",
  );
  const patterns = adaptersByCategory("patterns");
  return (
    <div className={compact ? "p-2.5" : "pt-1"}>
      <div className="flex flex-wrap gap-1 mb-2">
        {([["patterns", "Patterns"], ["words", "Words"], ["photo", "Photo"], ["more", "More"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-2 py-1 text-[0.6875rem] uppercase tracking-[0.06em] ${tab === k ? "bg-fg text-bg" : "text-mid border border-hairline"}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === "patterns" && (
        <div className="grid grid-cols-3 gap-1.5">
          {patterns.map((a) => (
            <button key={a.id} onClick={() => onAdapter(a)} title={`Add ${a.title}`}
              className="border border-hairline hover:border-fg p-1 flex flex-col items-center gap-0.5">
              <AdapterThumb adapter={a} />
              <span className="text-[0.625rem] leading-tight text-center text-fg truncate w-full">{a.title}</span>
            </button>
          ))}
        </div>
      )}
      {tab === "words" && (
        <div className="space-y-1.5">
          {adaptersByCategory("words").map((a) => (
            <button key={a.id} onClick={() => onAdapter(a)}
              className="w-full border border-hairline hover:border-fg p-2 flex items-center gap-2.5 text-left">
              <AdapterThumb adapter={a} size={40} />
              <span className="text-[0.8125rem] text-fg">{a.title}</span>
            </button>
          ))}
          <p className="text-[0.6875rem] text-mid leading-relaxed">Single-stroke lettering. Monograms and badges are available as standalone tools for now.</p>
        </div>
      )}
      {tab === "photo" && (
        <div className="space-y-1.5">
          <p className="text-[0.6875rem] text-mid leading-relaxed">Pick a style - you'll choose the photo next. It stays on your device.</p>
          {PHOTO_STYLES.map((s) => (
            <button key={s.id} onClick={() => onPhoto(s.id)}
              className="w-full border border-hairline hover:border-fg px-2.5 py-2 flex items-center justify-between text-left">
              <span className="text-[0.8125rem] text-fg">{s.label}</span>
              {s.id === "reference" && <span className="text-[0.625rem] text-mid">won't stitch</span>}
            </button>
          ))}
        </div>
      )}
      {tab === "more" && (
        <div className="space-y-1.5">
          <button onClick={onLibrary} className="w-full border border-hairline hover:border-fg px-2.5 py-2 text-left text-[0.8125rem] text-fg">
            From my library (stitch files)
          </button>
          <p className="text-[0.6875rem] text-mid leading-relaxed">
            Anything saved from the standalone tools joins as a placed stitch file: it moves and rotates
            freely, but its stitches are already encoded, so resizing is limited and its settings aren't
            editable here.
          </p>
        </div>
      )}
    </div>
  );
}

export function LibraryPicker({ designs, onPick, onClose }: { designs: SavedDesign[]; onPick: (d: SavedDesign) => void; onClose: () => void }) {
  return (
    <div className="p-2.5 border-t border-hairline">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[0.6875rem] uppercase tracking-[0.08em] text-mid">My library</span>
        <button onClick={onClose} className="text-[0.6875rem] text-mid hover:text-fg">Close</button>
      </div>
      {designs.length === 0 ? (
        <p className="text-[0.75rem] text-mid">Nothing saved yet - save a design from any tool first.</p>
      ) : (
        <div className="grid grid-cols-3 gap-1.5 max-h-56 overflow-y-auto">
          {designs.map((d) => (
            <button key={d.id} onClick={() => onPick(d)} title={d.name} className="border border-hairline hover:border-fg p-1">
              <img src={d.thumbPng} alt={d.name} className="w-full aspect-square object-cover" />
              <span className="block text-[0.5625rem] text-mid truncate">{d.name.replace(/^bayside-/, "")}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── element list ───────────────────────────────────────────────────────────

export function ElementList({
  project,
  selId,
  onSelect,
  onToggle,
  onMove,
  onDuplicate,
  onRemove,
}: {
  project: Project;
  selId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string, key: "hidden" | "locked") => void;
  onMove: (id: string, dir: 1 | -1) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  if (!project.elements.length) {
    return <p className="p-3 text-[0.75rem] text-mid">No elements yet - add one from the Add panel.</p>;
  }
  return (
    <div className="py-1">
      <p className="px-3 py-1 text-[0.625rem] uppercase tracking-[0.08em] text-mid">Elements · top sews first</p>
      {project.elements.map((el, i) => {
        const label = el.kind === "generated" ? ADAPTERS[el.tool]?.title ?? el.tool : el.kind === "stitchfile" ? "Stitch file" : "Reference";
        return (
          <div key={el.id}
            className={`px-2 py-1.5 flex items-center gap-1.5 cursor-pointer ${selId === el.id ? "bg-card" : "hover:bg-card/60"}`}
            onClick={() => onSelect(el.id)}>
            <span className="flex-1 min-w-0">
              <span className={`block text-[0.8125rem] truncate ${el.hidden ? "text-mid line-through" : "text-fg"}`}>{el.name || label}</span>
              <span className="block text-[0.625rem] text-mid">{label}{el.kind === "image" ? " · won't stitch" : ""}</span>
            </span>
            <button onClick={(e) => { e.stopPropagation(); onMove(el.id, -1); }} disabled={i === 0} aria-label="Sew earlier" title="Sew earlier"
              className="w-7 h-7 text-[0.8125rem] text-mid hover:text-fg disabled:opacity-25">↑</button>
            <button onClick={(e) => { e.stopPropagation(); onMove(el.id, 1); }} disabled={i === project.elements.length - 1} aria-label="Sew later" title="Sew later"
              className="w-7 h-7 text-[0.8125rem] text-mid hover:text-fg disabled:opacity-25">↓</button>
            <button onClick={(e) => { e.stopPropagation(); onToggle(el.id, "hidden"); }} aria-label={el.hidden ? "Show" : "Hide"} title={el.hidden ? "Show" : "Hide"}
              className="w-7 h-7 text-[0.8125rem] text-mid hover:text-fg">{el.hidden ? "○" : "●"}</button>
            <button onClick={(e) => { e.stopPropagation(); onToggle(el.id, "locked"); }} aria-label={el.locked ? "Unlock" : "Lock"} title={el.locked ? "Unlock" : "Lock"}
              className={`w-7 h-7 text-[0.8125rem] hover:text-fg ${el.locked ? "text-fg" : "text-mid"}`}>{el.locked ? "🔒" : "🔓"}</button>
            <button onClick={(e) => { e.stopPropagation(); onDuplicate(el.id); }} aria-label="Duplicate" title="Duplicate"
              className="w-7 h-7 text-[0.8125rem] text-mid hover:text-fg">⧉</button>
            <button onClick={(e) => { e.stopPropagation(); onRemove(el.id); }} aria-label="Delete" title="Delete"
              className="w-7 h-7 text-[0.8125rem] text-mid hover:text-fg">✕</button>
          </div>
        );
      })}
    </div>
  );
}

// ── properties panel ───────────────────────────────────────────────────────

function ParamControl({
  spec,
  value,
  onChange,
  onGesture,
}: {
  spec: ParamSpec;
  value: ParamValue;
  onChange: (v: ParamValue, mode: "commit" | "live") => void;
  onGesture: () => void;
}) {
  if (spec.kind === "range") {
    return (
      <div onPointerDown={onGesture}>
        <RangeRow
          label={spec.label}
          value={typeof value === "number" ? value : spec.def}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          onChange={(v) => onChange(v, "live")}
        />
      </div>
    );
  }
  if (spec.kind === "select") {
    return (
      <label className="grid grid-cols-[6.5rem_1fr] items-center gap-x-2 text-[0.75rem] text-mid">
        <span className="truncate">{spec.label}</span>
        <select
          value={typeof value === "string" ? value : spec.def}
          onChange={(e) => onChange(e.target.value, "commit")}
          className="border border-hairline bg-bg px-1.5 py-1 text-[0.8125rem] text-fg"
        >
          {spec.options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
    );
  }
  if (spec.kind === "toggle") {
    return (
      <label className="flex items-center gap-2 text-[0.75rem] text-mid">
        <input type="checkbox" checked={typeof value === "boolean" ? value : spec.def}
          onChange={(e) => onChange(e.target.checked, "commit")} />
        {spec.label}
      </label>
    );
  }
  return (
    <label className="block text-[0.75rem] text-mid">
      {spec.label}
      {spec.multiline ? (
        <textarea
          value={typeof value === "string" ? value : spec.def}
          onChange={(e) => onChange(e.target.value, "live")}
          onBlur={(e) => onChange(e.target.value, "commit")}
          rows={2}
          placeholder={spec.placeholder}
          className="mt-1 w-full border border-hairline bg-bg px-2 py-1.5 text-[0.9375rem] text-fg resize-y"
        />
      ) : (
        <input
          value={typeof value === "string" ? value : spec.def}
          onChange={(e) => onChange(e.target.value, "live")}
          onBlur={(e) => onChange(e.target.value, "commit")}
          placeholder={spec.placeholder}
          className="mt-1 w-full border border-hairline bg-bg px-2 py-1.5 text-[0.9375rem] text-fg"
        />
      )}
    </label>
  );
}

function NumField({ label, value, unit, onCommit }: { label: string; value: number; unit: string; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="flex items-center gap-1 text-[0.6875rem] text-mid">
      <span className="w-4">{label}</span>
      <input
        inputMode="decimal"
        value={draft ?? String(Math.round(value * 10) / 10)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null) {
            const v = parseFloat(draft);
            if (!Number.isNaN(v)) onCommit(v);
          }
          setDraft(null);
        }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        className="w-14 border border-hairline bg-bg px-1 py-0.5 text-[0.75rem] text-fg tabular-nums text-right"
      />
      <span>{unit}</span>
    </label>
  );
}

export function PropertiesPanel({
  el,
  built,
  onPatch,
  onGesture,
  onAlign,
  onVariation,
  onReset,
  onReplacePhoto,
}: {
  el: ProjectElement;
  built: BuiltElement | null;
  onPatch: (patch: Partial<ProjectElement>, mode?: "commit" | "live") => void;
  onGesture: () => void;
  onAlign: (how: "left" | "centerX" | "right" | "top" | "centerY" | "bottom") => void;
  onVariation?: () => void;
  onReset?: () => void;
  onReplacePhoto?: () => void;
}) {
  const adapter = el.kind === "generated" ? ADAPTERS[el.tool] : undefined;
  const [showAdvanced, setShowAdvanced] = useState(false);
  const scale = el.kind === "stitchfile" ? stitchFileScale(el) : 1;
  const scaleRisky = el.kind === "stitchfile" && (scale < SCALE_SAFE.min || scale > SCALE_SAFE.max);

  return (
    <div className="p-3 space-y-3">
      <input
        value={el.name}
        onChange={(e) => onPatch({ name: e.target.value }, "live")}
        onBlur={(e) => onPatch({ name: e.target.value.trim() || elFallbackName(el) })}
        aria-label="Element name"
        className="w-full bg-transparent border border-transparent hover:border-hairline focus:border-fg px-1 py-0.5 font-serif text-[1rem] text-fg outline-none"
      />

      {built?.warning && <Warning>{built.warning}</Warning>}
      {el.kind === "image" && (
        <p className="text-[0.6875rem] text-amber-800 border border-amber-700/30 bg-amber-100/50 px-2 py-1.5">
          Reference only - this image is a guide and will not stitch.
        </p>
      )}
      {scaleRisky && (
        <Warning>
          Resized to {Math.round(scale * 100)}% of its original stitches - lengths and density change with it.
          Between {Math.round(SCALE_SAFE.min * 100)}% and {Math.round(SCALE_SAFE.max * 100)}% is safe; beyond that,
          re-make the design at the size you need.
        </Warning>
      )}

      {/* placement */}
      <div className="space-y-1.5">
        <p className="text-[0.625rem] uppercase tracking-[0.08em] text-mid">Place</p>
        <div className="flex flex-wrap gap-x-3 gap-y-1.5">
          <NumField label="X" value={el.transform.xMm} unit="mm" onCommit={(v) => onPatch({ transform: { ...el.transform, xMm: v } })} />
          <NumField label="Y" value={el.transform.yMm} unit="mm" onCommit={(v) => onPatch({ transform: { ...el.transform, yMm: v } })} />
          <NumField label="⟳" value={el.transform.rotDeg} unit="°" onCommit={(v) => onPatch({ transform: { ...el.transform, rotDeg: ((v % 360) + 360) % 360 } })} />
          <NumField label="↔" value={el.sizeMm} unit="mm" onCommit={(v) => onPatch({ sizeMm: Math.max(5, Math.min(500, v)) })} />
        </div>
        <div className="flex gap-1">
          {([["left", "⇤"], ["centerX", "↔"], ["right", "⇥"], ["top", "⤒"], ["centerY", "↕"], ["bottom", "⤓"]] as const).map(([how, glyph]) => (
            <button key={how} onClick={() => onAlign(how)} title={`Align ${how}`} aria-label={`Align ${how}`}
              className="w-8 h-8 border border-hairline text-[0.8125rem] text-mid hover:border-fg hover:text-fg">{glyph}</button>
          ))}
          <button onClick={() => onPatch({ flipX: !el.flipX })} title="Flip horizontally" aria-label="Flip horizontally"
            className={`w-8 h-8 border text-[0.8125rem] ${el.flipX ? "border-fg text-fg" : "border-hairline text-mid"}`}>⇋</button>
        </div>
      </div>

      {/* thread color (single-thread elements v1) */}
      {el.kind === "generated" && (
        <ThreadRow hex={el.colors[0] ?? INK} onChange={(hex) => onPatch({ colors: [hex] })} />
      )}

      {/* generator settings */}
      {el.kind === "generated" && adapter && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[0.625rem] uppercase tracking-[0.08em] text-mid">{adapter.title} settings</p>
            {onReset && <button onClick={onReset} className="text-[0.6875rem] text-mid hover:text-fg underline underline-offset-2">Reset</button>}
          </div>
          {adapter.presets?.length ? (
            <div className="flex flex-wrap gap-1">
              {adapter.presets.map((pr) => (
                <button key={pr.name}
                  onClick={() => onPatch({ params: { ...defaultParams(adapter), ...(el as GeneratedElement).params, ...pr.params } })}
                  className="border border-hairline px-2 py-1 text-[0.6875rem] text-mid hover:border-fg hover:text-fg">
                  {pr.name}
                </button>
              ))}
            </div>
          ) : null}
          {adapter.params.filter((s) => !s.advanced).map((spec) => (
            <ParamControl
              key={spec.key}
              spec={spec}
              value={(el as GeneratedElement).params[spec.key] ?? spec.def}
              onGesture={onGesture}
              onChange={(v, mode) => onPatch({ params: { ...(el as GeneratedElement).params, [spec.key]: v } }, mode)}
            />
          ))}
          {adapter.params.some((s) => s.advanced) && (
            <>
              <button onClick={() => setShowAdvanced((v) => !v)} className="text-[0.6875rem] text-mid hover:text-fg">
                {showAdvanced ? "Fewer settings ▴" : "More settings ▾"}
              </button>
              {showAdvanced && adapter.params.filter((s) => s.advanced).map((spec) => (
                <ParamControl
                  key={spec.key}
                  spec={spec}
                  value={(el as GeneratedElement).params[spec.key] ?? spec.def}
                  onGesture={onGesture}
                  onChange={(v, mode) => onPatch({ params: { ...(el as GeneratedElement).params, [spec.key]: v } }, mode)}
                />
              ))}
            </>
          )}
          <div className="flex gap-1.5">
            {onVariation && (
              <button onClick={onVariation} className="border border-hairline px-2.5 py-1.5 text-[0.75rem] text-mid hover:border-fg hover:text-fg">
                ↻ Make a variation
              </button>
            )}
            {onReplacePhoto && (
              <button onClick={onReplacePhoto} className="border border-hairline px-2.5 py-1.5 text-[0.75rem] text-mid hover:border-fg hover:text-fg">
                Replace photo
              </button>
            )}
          </div>
        </div>
      )}

      {el.kind === "stitchfile" && (
        <p className="text-[0.6875rem] text-mid leading-relaxed">
          A placed stitch file{el.sourceName ? ` (${el.sourceName})` : ""}. Its stitches are already encoded -
          move and rotate freely; settings from the original tool aren't editable here.
        </p>
      )}
    </div>
  );
}

function elFallbackName(el: ProjectElement): string {
  if (el.kind === "generated") return ADAPTERS[el.tool]?.title ?? el.tool;
  if (el.kind === "stitchfile") return el.sourceName ?? "Stitch file";
  return "Reference image";
}

// ── project stats + export ─────────────────────────────────────────────────

type ComposedForExport = {
  colors: string[];
  built: Built | null;
} | null;

export function ProjectStats({ composed, project, units }: { composed: ComposedForExport; project: Project; units: Units }) {
  if (!composed?.built) return <p className="text-[0.75rem] text-mid">Nothing stitchable yet.</p>;
  const s = composed.built.stats;
  return (
    <p className="text-[0.75rem] text-mid tabular-nums leading-relaxed">
      {s.realStitches.toLocaleString()} stitches · {fmtSize(s.widthMm, s.heightMm, units)} ·{" "}
      {composed.colors.length} color{composed.colors.length === 1 ? "" : "s"} · ~{formatMinutes(s.runtimeMinutes)}
      <br />
      hoop {fmtSize(project.hoop.wMm, project.hoop.hMm, units)}
    </p>
  );
}

export function ExportPanel({ project, composed, units }: { project: Project; composed: ComposedForExport; units: Units }) {
  const [fmt, setFmt] = useState<StitchFormat>("dst");
  const ref = useRef<HTMLCanvasElement>(null);
  const built = composed?.built ?? null;

  // authoritative preview: rendered from the re-parsed DST bytes
  useEffect(() => {
    const c = ref.current;
    if (!c || !built) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth || 260;
    const h = Math.round(w * 0.9);
    c.width = w * dpr;
    c.height = h * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#f7f5f1";
    ctx.fillRect(0, 0, w, h);
    renderPattern(ctx, built.pattern, fitTransform(built.pattern, w, h, 14), {
      colors: composed?.colors ?? [],
      sheen: true,
      threadMm: 0.5,
    });
  }, [built, composed]);

  if (!built) {
    return <div className="p-4"><p className="text-[0.8125rem] text-mid">Add something stitchable first - reference images alone can't export.</p></div>;
  }
  const s = built.stats;
  const over = !fitsHoop(s.widthMm, s.heightMm);
  const name = project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 24) || "bayside-project";

  return (
    <div className="p-3 space-y-2.5">
      <p className="text-[0.625rem] uppercase tracking-[0.08em] text-mid">Export - machine embroidery</p>
      <canvas ref={ref} className="w-full border border-hairline" />
      <p className="text-[0.6875rem] text-mid">
        This preview is re-parsed from the exact bytes you'll download.
      </p>
      <p className="text-[0.75rem] text-fg tabular-nums">
        {s.realStitches.toLocaleString()} stitches · {fmtSize(s.widthMm, s.heightMm, units)} ·{" "}
        {composed!.colors.length} color{composed!.colors.length === 1 ? "" : "s"} · ~{formatMinutes(s.runtimeMinutes)}
      </p>
      {over && (
        <Warning>
          {fmtSize(s.widthMm, s.heightMm, units)} exceeds the {fmtSize(project.hoop.wMm, project.hoop.hMm, units)} hoop
          in every orientation - shrink before stitching.
        </Warning>
      )}
      {s.realStitches > 60000 && <Warning>Over 60,000 stitches - a long sew.</Warning>}
      <div className="flex gap-1.5">
        <button
          onClick={() => downloadDesign(built, composed!.colors, name, fmt)}
          className="flex-1 border border-fg bg-fg text-bg px-3 py-2 text-[0.8125rem] hover:opacity-85"
        >
          Download .{fmt}
        </button>
        <div className="flex border border-hairline">
          {(["dst", "pes", "jef"] as const).map((f) => (
            <button key={f} onClick={() => setFmt(f)}
              className={`px-2.5 py-2 text-[0.6875rem] uppercase ${fmt === f ? "bg-fg text-bg" : "bg-bg text-mid"}`}>{f}</button>
          ))}
        </div>
      </div>
      {(fmt === "pes" || fmt === "jef") && (
        <p className="text-[0.6875rem] text-mid leading-relaxed">
          {fmt === "jef" ? "JEF uses the Janome palette; check your machine’s supported hoop size." : "PES uses the Brother palette."} On-machine colors can differ from this preview.
        </p>
      )}
      <p className="text-[0.6875rem] text-mid leading-relaxed">
        The editable project itself autosaves to your library - this download is the machine file.
      </p>
    </div>
  );
}
