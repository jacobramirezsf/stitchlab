// Stitch Lab tool: Pattern Blocks - a small layout editor for generative
// embroidery. Generators from the shared block engine land as layers on a
// real hoop; each layer has its own thread color, position, scale, and
// rotation, tuned in a pinned inspector. The chrome deliberately reads as an
// editor (toolbar / canvas / layers panel / action bar) rather than a page of
// stacked sections - usability first, site branding second.

import { useEffect, useMemo, useRef, useState } from "react";
import AnimExport from "./animexport";
import {
  RangeRow,
  ModeButtons,
  ThreadRow,
  Warning,
  buildDesign,
  ExportButton,
  useCanvas,
  useIsMobile,
  FABRICS,
  formatMinutes,
  useUnits,
  UnitsToggle,
  fmtLen,
  fmtSize,
  LABEL,
  type CanvasDraw,
} from "./shared";
import { pathGroupsToStitches, resamplePath, type PathMm } from "../lib/generators";
import { saveDesignEverywhere, AUTH_EVENT } from "../lib/sync";
import { THREADS } from "../../data/threads";
import { runBlocks, BLOCK_DEFS, BLOCK_BY_TYPE, type BlockParam } from "./sketch";

let seq = 0;
const uid = () => `v2b${seq++}`;
const INK = THREADS.find((t) => t.code === "1568")?.hex ?? "#0b1f3a";
const RUST = THREADS.find((t) => t.code === "1147")?.hex ?? "#b4472e";
const WALKTHROUGH_KEY = "stitchlab-blocks2-walkthrough";
const isNum = (p: BlockParam): p is Extract<BlockParam, { min: number }> => "min" in p;

// ─── Hoops ───────────────────────────────────────────────────────────────

type Hoop = { id: string; label: string; w: number; h: number }; // mm
const IN = 25.4;
const HOOPS: Hoop[] = [
  { id: "5x7", label: "5 × 7 in", w: 5 * IN, h: 7 * IN },
  { id: "11x13", label: "11 × 13 in", w: 11 * IN, h: 13 * IN },
  { id: "13x16", label: "13 × 16 in", w: 13 * IN, h: 16 * IN },
  ...Array.from({ length: 9 }, (_, i) => {
    const n = i + 2;
    return { id: `${n}x${n}`, label: `${n} × ${n} in`, w: n * IN, h: n * IN };
  }),
];

// ─── Elements (layers) ───────────────────────────────────────────────────

type Elem = {
  id: string;
  type: string;
  params: Record<string, number | string>;
  color: string; // thread hex
  cx: number;    // mm from hoop center
  cy: number;
  scale: number; // mm side of the block's 0..100 box
  rot: number;   // degrees
};

const el = (type: string, over: Partial<Elem> = {}): Elem => ({
  id: uid(),
  type,
  params: { ...BLOCK_BY_TYPE[type].defaults },
  color: INK,
  cx: 0,
  cy: 0,
  scale: 100,
  rot: 0,
  ...over,
});

const CATEGORIES: { label: string; types: string[] }[] = [
  { label: "Curves & spirals", types: ["spiral", "rose", "lissajous", "spirograph", "superformula", "maurerRose", "harmonograph", "butterfly", "heart", "starPolygon"] },
  { label: "Rings & radial", types: ["concentricRings", "concentricPolygons", "concentricSquares", "polarGrid", "rosette", "ripples", "phyllotaxis", "starburst", "polygonRing", "timesTable"] },
  { label: "Grids & weaves", types: ["grid", "plaid", "moire", "honeycomb", "circleGrid", "waveRows"] },
  { label: "Fractals", types: ["hilbert", "koch", "sierpinski", "tree", "dragon"] },
  { label: "Fields & organic", types: ["flowField", "contours", "circlePack", "truchet"] },
];

const EXAMPLES: { name: string; make: (s: number) => Elem[] }[] = [
  { name: "Bloom", make: (s) => [el("rose", { params: { petals: 5, radius: 44 }, color: RUST, scale: s }), el("concentricRings", { params: { count: 3, gap: 3 }, scale: s })] },
  { name: "Mandala", make: (s) => [el("polygonRing", { params: { count: 12, sides: 6, r: 8, radius: 34 }, scale: s }), el("starburst", { params: { points: 48, skip: 17, radius: 44 }, color: RUST, scale: s })] },
  { name: "Tide", make: (s) => [el("waveRows", { params: { rows: 24, amp: 6, freq: 3 }, scale: s })] },
  { name: "Starfield", make: (s) => [el("starburst", { params: { points: 90, skip: 41, radius: 46 }, scale: s })] },
];

// ─── Geometry ────────────────────────────────────────────────────────────

/** Map a block's 0..100 output into hoop mm space: scale, rotate, translate. */
function placePaths(paths: PathMm[], e: Elem): PathMm[] {
  const s = e.scale / 100;
  const a = (e.rot * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  return paths.map((path) =>
    path.map((p) => {
      const x0 = (p.x - 50) * s, y0 = (p.y - 50) * s;
      return { x: e.cx + x0 * cos - y0 * sin, y: e.cy + x0 * sin + y0 * cos };
    }),
  );
}
function bboxOf(paths: PathMm[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const path of paths) for (const p of path) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
  return isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
}

// ─── Thumbnails ──────────────────────────────────────────────────────────

const THUMBS: Record<string, PathMm[]> = Object.fromEntries(
  BLOCK_DEFS.filter((d) => d.type !== "color").map((d) => [
    d.type,
    runBlocks([{ id: "t", type: d.type, params: { ...d.defaults } }], { seed: 1, defaultHex: INK }).groups.flat(),
  ]),
);

function MiniPreview({ paths, color, height }: { paths: PathMm[]; color: string; height: number }) {
  const draw = useMemo<CanvasDraw>(
    () => (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      const pad = Math.max(3, h * 0.08);
      const s = (Math.min(w, h) - 2 * pad) / 100;
      const ox = (w - 100 * s) / 2, oy = (h - 100 * s) / 2;
      ctx.lineWidth = 1; ctx.lineJoin = "round"; ctx.strokeStyle = color;
      for (const path of paths) { if (path.length < 2) continue; ctx.beginPath(); path.forEach((p, j) => (j ? ctx.lineTo(p.x * s + ox, p.y * s + oy) : ctx.moveTo(p.x * s + ox, p.y * s + oy))); ctx.stroke(); }
    },
    [paths, color],
  );
  return <canvas ref={useCanvas(draw)} className="w-full" style={{ height }} />;
}

// ─── Add-block gallery ───────────────────────────────────────────────────

function AddModal({ onAdd, onClose }: { onAdd: (type: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const match = (type: string) => { const d = BLOCK_BY_TYPE[type]; return !query || d.label.toLowerCase().includes(query) || d.hint.toLowerCase().includes(query); };
  useEffect(() => { const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-8 bg-fg/40" onClick={onClose}>
      <div className="bg-bg border border-hairline w-full max-w-[860px] max-h-[86vh] flex flex-col shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-hairline">
          <span className="font-serif text-[1.125rem] text-fg">Add a block</span>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search generators…" className="flex-1 border border-hairline bg-bg text-fg px-2.5 py-1.5 text-[0.8125rem]" />
          <button onClick={onClose} className="text-mid hover:text-fg text-[0.8125rem] border border-hairline px-2.5 py-1.5">Close ✕</button>
        </div>
        <div className="overflow-y-auto px-4 py-3 space-y-5">
          {CATEGORIES.map((cat) => {
            const types = cat.types.filter(match);
            if (!types.length) return null;
            return (
              <div key={cat.label}>
                <div className={`${LABEL} mb-1.5`}>{cat.label}</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {types.map((type) => {
                    const def = BLOCK_BY_TYPE[type];
                    return (
                      <button key={type} onClick={() => onAdd(type)} title={def.hint} className="group border border-hairline bg-bg hover:border-accent overflow-hidden text-left">
                        <MiniPreview paths={THUMBS[type]} color={INK} height={96} />
                        <div className="px-2 py-1.5 border-t border-hairline">
                          <div className="text-[0.75rem] text-fg font-medium leading-tight group-hover:text-accent">＋ {def.label}</div>
                          <div className="text-[0.625rem] text-mid leading-tight mt-0.5">{def.hint}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Walkthrough({ onClose }: { onClose: () => void }) {
  const steps = [
    ["1", "Add blocks", "“＋ Add block” opens the gallery - every tile shows what it draws."],
    ["2", "Arrange on the hoop", "Drag a layer to move it, corner-drag to scale. Its sliders live in the panel."],
    ["3", "Color each layer", "Every layer carries its own thread. Layers sew in list order, top first."],
    ["4", "Pick a hoop, download", "Choose the hoop you'll stitch in - the whole arrangement exports as one file."],
  ];
  return (
    <div className="border border-accent/50 bg-card px-3 py-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="font-serif text-[1.0625rem] text-fg">How Pattern Blocks works</span>
        <button onClick={onClose} className="text-[0.6875rem] text-mid hover:text-fg border border-hairline px-2 py-0.5">Got it ✕</button>
      </div>
      <div className="grid sm:grid-cols-2 gap-x-5 gap-y-2">
        {steps.map(([nStep, title, body]) => (
          <div key={nStep} className="flex gap-2.5">
            <span className="shrink-0 w-5 h-5 rounded-full bg-fg text-bg text-[0.6875rem] flex items-center justify-center font-medium">{nStep}</span>
            <div><div className="text-[0.8125rem] text-fg font-medium leading-tight">{title}</div><div className="text-[0.6875rem] text-mid leading-relaxed">{body}</div></div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────

export default function BlocksV2Tool() {
  const mobile = useIsMobile();
  const [hoopId, setHoopId] = useState("5x7");
  const units = useUnits();
  const hoop = HOOPS.find((h) => h.id === hoopId) ?? HOOPS[0];
  const defaultScale = Math.round(Math.min(hoop.w, hoop.h) * 0.7);

  const [elems, setElems] = useState<Elem[]>(() => EXAMPLES[0].make(Math.round(Math.min(HOOPS[0].w, HOOPS[0].h) * 0.7)));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [seed, setSeed] = useState(1);
  const [stitchLen, setStitchLen] = useState(2.2);
  const [bean, setBean] = useState<1 | 3>(1);
  const [fabric, setFabric] = useState(FABRICS[0].hex);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "cloud" | "device" | "device-error">("idle");
  const [showHelp, setShowHelp] = useState(() => { try { return localStorage.getItem(WALKTHROUGH_KEY) !== "done"; } catch { return true; } });
  const dismissHelp = () => { setShowHelp(false); try { localStorage.setItem(WALKTHROUGH_KEY, "done"); } catch { /* ignore */ } };

  const patch = (id: string, p: Partial<Elem>) => setElems((es) => es.map((e) => (e.id === id ? { ...e, ...p } : e)));
  const patchParam = (id: string, key: string, value: number | string) =>
    setElems((es) => es.map((e) => (e.id === id ? { ...e, params: { ...e.params, [key]: value } } : e)));

  // Switching hoop: keep every element inside the new frame.
  const switchHoop = (id: string) => {
    const nh = HOOPS.find((h) => h.id === id);
    if (!nh) return;
    setHoopId(id);
    setElems((es) => es.map((e) => ({
      ...e,
      cx: Math.max(-nh.w / 2, Math.min(nh.w / 2, e.cx)),
      cy: Math.max(-nh.h / 2, Math.min(nh.h / 2, e.cy)),
      scale: Math.min(e.scale, Math.max(nh.w, nh.h)),
    })));
  };

  // Per-element geometry in hoop space.
  const placed = useMemo(
    () => elems.map((e) => {
      const raw = runBlocks([{ id: e.id, type: e.type, params: e.params }], { seed, defaultHex: e.color }).groups.flat();
      const world = placePaths(raw, e);
      return { elem: e, raw, world, bbox: bboxOf(world) };
    }),
    [elems, seed],
  );
  const selected = placed.find((p) => p.elem.id === selectedId) ?? null;

  // Compose all layers (merge shared threads) → one design.
  const { built, downloadColors } = useMemo(() => {
    const order: string[] = []; const byColor = new Map<string, PathMm[]>();
    for (const p of placed) {
      if (!p.world.length) continue;
      if (!byColor.has(p.elem.color)) { byColor.set(p.elem.color, []); order.push(p.elem.color); }
      for (const path of p.world) byColor.get(p.elem.color)!.push(resamplePath(path, stitchLen, 0.4));
    }
    if (!order.length) return { built: null, downloadColors: [INK] };
    return { built: buildDesign(pathGroupsToStitches(order.map((c) => byColor.get(c)!), bean), "bayside-blocks"), downloadColors: order };
  }, [placed, stitchLen, bean]);

  const overflow = built && (built.stats.widthMm > hoop.w + 1 || built.stats.heightMm > hoop.h + 1);

  // ── Interactive canvas ──
  const viewRef = useRef<{ pxPerMm: number; w: number; h: number } | null>(null);
  const drag = useRef<{ id: string; mode: "move" | "scale"; ox: number; oy: number; startScale: number; startDist: number } | null>(null);

  const draw = useMemo<CanvasDraw>(() => (ctx, w, h) => {
    ctx.fillStyle = fabric; ctx.fillRect(0, 0, w, h);
    const pad = 14;
    const pxPerMm = Math.min((w - pad * 2) / hoop.w, (h - pad * 2) / hoop.h);
    viewRef.current = { pxPerMm, w, h };
    const X = (mx: number) => mx * pxPerMm + w / 2;
    const Y = (my: number) => my * pxPerMm + h / 2;
    // hoop frame + center ticks
    ctx.strokeStyle = "rgba(120,130,140,0.55)"; ctx.lineWidth = 1.5;
    ctx.strokeRect(X(-hoop.w / 2), Y(-hoop.h / 2), hoop.w * pxPerMm, hoop.h * pxPerMm);
    ctx.strokeStyle = "rgba(120,130,140,0.28)"; ctx.lineWidth = 1;
    const tick = 5 * pxPerMm;
    ctx.beginPath();
    ctx.moveTo(X(0) - tick, Y(0)); ctx.lineTo(X(0) + tick, Y(0));
    ctx.moveTo(X(0), Y(0) - tick); ctx.lineTo(X(0), Y(0) + tick);
    ctx.stroke();
    // layers
    for (const p of placed) {
      const dim = selectedId !== null && p.elem.id !== selectedId;
      ctx.globalAlpha = dim ? 0.26 : 1;
      ctx.strokeStyle = p.elem.color; ctx.lineWidth = p.elem.id === selectedId ? 1.6 : 1; ctx.lineJoin = "round";
      for (const path of p.world) { if (path.length < 2) continue; ctx.beginPath(); path.forEach((pt, j) => (j ? ctx.lineTo(X(pt.x), Y(pt.y)) : ctx.moveTo(X(pt.x), Y(pt.y)))); ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
    // selection box + corner handles
    if (selected) {
      const b = selected.bbox;
      ctx.strokeStyle = "rgba(40,120,255,0.95)"; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.25;
      ctx.strokeRect(X(b.minX), Y(b.minY), (b.maxX - b.minX) * pxPerMm, (b.maxY - b.minY) * pxPerMm);
      ctx.setLineDash([]);
      ctx.fillStyle = "#2478ff";
      for (const [hx, hy] of [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]] as [number, number][]) ctx.fillRect(X(hx) - 4, Y(hy) - 4, 8, 8);
    }
  }, [placed, selected, selectedId, fabric, hoop]);
  const canvasRef = useCanvas(draw);

  const toWorld = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect(); const v = viewRef.current;
    if (!v) return { x: 0, y: 0 };
    return { x: (e.clientX - r.left - v.w / 2) / v.pxPerMm, y: (e.clientY - r.top - v.h / 2) / v.pxPerMm };
  };
  const handleAt = (wx: number, wy: number) => {
    const v = viewRef.current; if (!selected || !v) return false;
    const b = selected.bbox; const tol = 8 / v.pxPerMm;
    return ([[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]] as [number, number][]).some(([hx, hy]) => Math.abs(wx - hx) < tol && Math.abs(wy - hy) < tol);
  };
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const wpt = toWorld(e);
    if (selected && handleAt(wpt.x, wpt.y)) {
      const s = selected.elem;
      drag.current = { id: s.id, mode: "scale", ox: 0, oy: 0, startScale: s.scale, startDist: Math.max(1, Math.hypot(wpt.x - s.cx, wpt.y - s.cy)) };
      e.currentTarget.setPointerCapture(e.pointerId); return;
    }
    for (let i = placed.length - 1; i >= 0; i--) {
      const p = placed[i], b = p.bbox;
      if (wpt.x >= b.minX && wpt.x <= b.maxX && wpt.y >= b.minY && wpt.y <= b.maxY) {
        setSelectedId(p.elem.id);
        drag.current = { id: p.elem.id, mode: "move", ox: p.elem.cx - wpt.x, oy: p.elem.cy - wpt.y, startScale: p.elem.scale, startDist: 0 };
        e.currentTarget.setPointerCapture(e.pointerId); return;
      }
    }
    setSelectedId(null);
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return;
    const wpt = toWorld(e); const d = drag.current;
    const cur = elems.find((x) => x.id === d.id); if (!cur) return;
    if (d.mode === "move") {
      patch(d.id, {
        cx: Math.max(-hoop.w / 2, Math.min(hoop.w / 2, wpt.x + d.ox)),
        cy: Math.max(-hoop.h / 2, Math.min(hoop.h / 2, wpt.y + d.oy)),
      });
    } else {
      const dist = Math.hypot(wpt.x - cur.cx, wpt.y - cur.cy);
      patch(d.id, { scale: Math.max(15, Math.min(Math.max(hoop.w, hoop.h), d.startScale * (dist / d.startDist))) });
    }
  };
  const onUp = () => { drag.current = null; };

  // ── Layer ops ──
  const addBlock = (type: string) => {
    const nDrawing = elems.length;
    const off = ((nDrawing % 4) - 1.5) * Math.min(hoop.w, hoop.h) * 0.1;
    const e = el(type, { scale: defaultScale, cx: off, cy: off });
    setElems((es) => [...es, e]);
    setSelectedId(e.id);
    setAdding(false);
  };
  const remove = (id: string) => { setElems((es) => es.filter((e) => e.id !== id)); if (selectedId === id) setSelectedId(null); };
  const duplicate = (id: string) => setElems((es) => {
    const i = es.findIndex((e) => e.id === id); if (i < 0) return es;
    const c = { ...es[i], id: uid(), params: { ...es[i].params }, cx: es[i].cx + 12, cy: es[i].cy + 12 };
    const next = [...es]; next.splice(i + 1, 0, c); setSelectedId(c.id); return next;
  });
  const move = (id: string, dir: -1 | 1) => setElems((es) => {
    const i = es.findIndex((e) => e.id === id); const j = i + dir;
    if (i < 0 || j < 0 || j >= es.length) return es;
    const next = [...es]; [next[i], next[j]] = [next[j], next[i]]; return next;
  });
  const rollParams = (e: Elem): Record<string, number | string> => {
    const def = BLOCK_BY_TYPE[e.type]; const out = { ...e.params };
    for (const p of def.params) if (isNum(p)) { const steps = Math.max(1, Math.round((p.max - p.min) / p.step)); out[p.key] = +(p.min + Math.round(Math.random() * steps) * p.step).toFixed(3); }
    return out;
  };
  const shuffleAll = () => setElems((es) => es.map((e) => ({ ...e, params: rollParams(e) })));
  const loadExample = (name: string) => {
    const ex = EXAMPLES.find((x) => x.name === name); if (!ex) return;
    setElems(ex.make(defaultScale)); setSelectedId(null);
  };

  const saveToLibrary = async () => {
    if (!built) return; setSaveState("saving");
    try {
      const c = document.createElement("canvas"); c.width = 220; c.height = 220; const tctx = c.getContext("2d");
      if (tctx) {
        tctx.fillStyle = FABRICS[0].hex; tctx.fillRect(0, 0, 220, 220);
        const s = Math.min(200 / hoop.w, 200 / hoop.h);
        tctx.lineWidth = 1;
        for (const p of placed) { tctx.strokeStyle = p.elem.color; for (const path of p.world) { if (path.length < 2) continue; tctx.beginPath(); path.forEach((pt, j) => (j ? tctx.lineTo(pt.x * s + 110, pt.y * s + 110) : tctx.moveTo(pt.x * s + 110, pt.y * s + 110))); tctx.stroke(); } }
      }
      const where = await saveDesignEverywhere({ id: crypto.randomUUID(), name: "bayside-blocks", tool: "blocks", createdAt: Date.now(), stitchCount: built.stats.realStitches, widthMm: built.stats.widthMm, heightMm: built.stats.heightMm, colors: downloadColors, thumbPng: c.toDataURL("image/png"), bytes: built.bytes });
      setSaveState(where); setTimeout(() => setSaveState("idle"), where === "cloud" ? 2200 : 7000);
    } catch { setSaveState("idle"); }
  };

  // ── UI pieces ──
  const fabricDots = (
    <div className="flex items-center gap-1">
      {FABRICS.map((f) => (
        <button key={f.hex} title={f.name} onClick={() => setFabric(f.hex)} className={`w-5 h-5 border ${fabric === f.hex ? "border-accent border-2" : "border-hairline"}`} style={{ background: f.hex }} />
      ))}
    </div>
  );

  const toolbar = (
    <div className="flex items-center gap-2 overflow-x-auto px-3 py-2 border-b border-hairline bg-card" style={{ scrollbarWidth: "none" }}>
      <button onClick={() => setAdding(true)} className="shrink-0 border border-fg bg-fg text-bg px-3 py-1.5 text-[0.8125rem] hover:opacity-85">＋ Add block</button>
      <button onClick={shuffleAll} title="Randomize every layer's sliders" className="shrink-0 border border-hairline bg-bg text-fg px-2.5 py-1.5 text-[0.8125rem] hover:bg-card">🎲</button>
      <label className="shrink-0 flex items-center gap-1.5 text-[0.75rem] text-mid">
        Hoop
        <select value={hoopId} onChange={(e) => switchHoop(e.target.value)} className="border border-hairline bg-bg text-fg px-1.5 py-1 text-[0.8125rem]">
          {HOOPS.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
        </select>
      </label>
      <label className="shrink-0 flex items-center gap-1.5 text-[0.75rem] text-mid">
        Example
        <select value="" onChange={(e) => { if (e.target.value) loadExample(e.target.value); e.target.value = ""; }} className="border border-hairline bg-bg text-fg px-1.5 py-1 text-[0.8125rem]">
          <option value="">Load…</option>
          {EXAMPLES.map((ex) => <option key={ex.name} value={ex.name}>{ex.name}</option>)}
        </select>
      </label>
      {!showHelp && <button onClick={() => setShowHelp(true)} className="shrink-0 text-[0.75rem] text-mid hover:text-fg border border-hairline w-6 h-6">?</button>}
      <div className="ml-auto shrink-0 hidden sm:flex items-center gap-2"><UnitsToggle />{fabricDots}</div>
    </div>
  );

  const canvasBox = (maxVh: number) => (
    <div className="flex items-center justify-center p-3 lg:p-5">
      <div
        className="relative w-full"
        style={{ width: `min(100%, calc(${maxVh}vh * ${(hoop.w / hoop.h).toFixed(4)}))`, aspectRatio: `${hoop.w} / ${hoop.h}` }}
      >
        <canvas
          ref={canvasRef}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          className="absolute inset-0 w-full h-full border border-hairline touch-none cursor-move"
          style={{ background: fabric }}
        />
      </div>
    </div>
  );

  const layerRows = (
    <div className="divide-y divide-hairline">
      {placed.map((p, i) => {
        const e = p.elem; const def = BLOCK_BY_TYPE[e.type]; const sel = e.id === selectedId;
        return (
          <div key={e.id} className={`flex items-center gap-2 px-2 py-1.5 ${sel ? "bg-card border-l-2 border-accent" : "border-l-2 border-transparent hover:bg-card/60"}`}>
            <button onClick={() => setSelectedId(sel ? null : e.id)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
              <span className="w-8 h-8 border border-hairline shrink-0 overflow-hidden bg-bg"><MiniPreview paths={p.raw} color={e.color} height={32} /></span>
              <span className="flex-1 truncate text-[0.8125rem] text-fg">{def.label}</span>
              <span className="w-3.5 h-3.5 border border-hairline shrink-0" style={{ background: e.color }} title="Thread" />
            </button>
            <button onClick={() => move(e.id, -1)} disabled={i === 0} title="Sew earlier" className="text-mid hover:text-fg disabled:opacity-25 text-[0.7rem] px-0.5">↑</button>
            <button onClick={() => move(e.id, 1)} disabled={i === placed.length - 1} title="Sew later" className="text-mid hover:text-fg disabled:opacity-25 text-[0.7rem] px-0.5">↓</button>
            <button onClick={() => remove(e.id)} title="Delete layer" className="text-mid hover:text-fg text-[0.7rem] px-0.5">✕</button>
          </div>
        );
      })}
    </div>
  );

  const inspector = selected ? (
    <div className="px-3 py-2.5 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.8125rem] text-fg font-medium">{BLOCK_BY_TYPE[selected.elem.type].label}</span>
        <div className="flex gap-1.5">
          <button onClick={() => patch(selected.elem.id, { params: rollParams(selected.elem) } as Partial<Elem>)} title="Randomize" className="text-[0.6875rem] text-mid hover:text-fg border border-hairline px-1.5 py-0.5">🎲</button>
          <button onClick={() => duplicate(selected.elem.id)} title="Duplicate" className="text-[0.6875rem] text-mid hover:text-fg border border-hairline px-1.5 py-0.5">⧉</button>
          <button onClick={() => patch(selected.elem.id, { cx: 0, cy: 0 })} className="text-[0.6875rem] text-mid hover:text-fg border border-hairline px-1.5 py-0.5">Center</button>
        </div>
      </div>
      {BLOCK_BY_TYPE[selected.elem.type].params.filter(isNum).map((p) => (
        <RangeRow key={p.key} label={p.label} value={Number(selected.elem.params[p.key])} min={p.min} max={p.max} step={p.step} onChange={(v) => patchParam(selected.elem.id, p.key, v)} fmt={(v) => (p.step < 1 ? v.toFixed(1) : String(v))} />
      ))}
      <RangeRow label="Size" value={Math.round(selected.elem.scale)} min={15} max={Math.round(Math.max(hoop.w, hoop.h))} step={1} onChange={(v) => patch(selected.elem.id, { scale: v })} fmt={(v) => fmtLen(v, units)} />
      <RangeRow label="Rotation" value={selected.elem.rot} min={0} max={359} step={1} onChange={(v) => patch(selected.elem.id, { rot: v })} fmt={(v) => `${v}°`} />
      <ThreadRow label="Thread" hex={selected.elem.color} onChange={(hex) => patch(selected.elem.id, { color: hex })} />
      <p className="text-[0.625rem] text-mid leading-relaxed pt-0.5">{BLOCK_BY_TYPE[selected.elem.type].hint} Drag on the hoop to move, corner-drag to scale.</p>
    </div>
  ) : (
    <div className="px-3 py-3 text-[0.75rem] text-mid leading-relaxed">
      Select a layer to tune it - tap it on the hoop or in the list. Each layer has its own sliders, size, rotation, and thread.
    </div>
  );

  const stitchSettings = (
    <details className="group">
      <summary className="cursor-pointer list-none px-3 py-2 border-t border-hairline flex items-center justify-between">
        <span className={LABEL}>Stitch settings</span>
        <span className="text-mid text-[0.7rem] group-open:rotate-180 transition-transform">▾</span>
      </summary>
      <div className="px-3 pb-2.5 space-y-1">
        <RangeRow label="Seed" value={seed} min={1} max={99} step={1} onChange={setSeed} />
        <RangeRow label="Stitch length" value={stitchLen} min={1.5} max={4} step={0.1} onChange={setStitchLen} fmt={(v) => `${v.toFixed(1)} mm`} />
        <div>
          <div className={`${LABEL} mb-1.5`}>Line weight</div>
          <ModeButtons small options={[["1", "Run"], ["3", "Bean ×3"]] as const} value={String(bean)} onChange={(v) => setBean(Number(v) as 1 | 3)} />
        </div>
      </div>
    </details>
  );

  const stats = built ? (
    <p className="text-[0.75rem] text-mid tabular-nums leading-snug">
      {placed.length} layer{placed.length === 1 ? "" : "s"} · {built.stats.realStitches.toLocaleString()} st · {fmtSize(built.stats.widthMm, built.stats.heightMm, units)} · ~{formatMinutes(built.stats.runtimeMinutes)}
    </p>
  ) : (
    <p className="text-[0.75rem] text-mid">Add a block - it lands on the hoop as a layer you can drag.</p>
  );

  const actionBar = (
    <div className="flex gap-2">
      <ExportButton built={built} colors={downloadColors} name="bayside-blocks" />
      <AnimExport built={built} colors={downloadColors} name="bayside-blocks" />
      <button onClick={() => void saveToLibrary()} disabled={!built || saveState !== "idle"} className="border border-hairline bg-bg px-4 py-2 text-[0.875rem] text-fg disabled:opacity-40 hover:bg-card whitespace-nowrap">
        {saveState === "saving" ? "Saving…" : saveState === "idle" ? "☆ Save" : "Saved ✓"}
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
        Saved in this browser - the account sync didn\'t go through. It retries on your next save.
      </p>
    ) : null;

  const overflowWarning = overflow && built ? (
    <Warning>
      {fmtSize(built.stats.widthMm, built.stats.heightMm, units)} spills past the {hoop.label} hoop - scale layers down, move them closer, or pick a bigger hoop.
    </Warning>
  ) : null;

  // ── Mobile: pinned canvas, scrolling panel, sticky action bar ──
  if (mobile) {
    return (
      <>
        <div>
          <div className="sticky top-0 z-20 -mx-pad border-b border-hairline bg-bg px-pad pt-1 pb-2">
            {canvasBox(34)}
            <div className="flex items-center gap-x-3">
              <div className="min-w-0">{stats}</div>
              <div className="ml-auto shrink-0">{fabricDots}</div>
            </div>
          </div>
          <div className="pt-3 pb-4 space-y-3">
            {showHelp && <Walkthrough onClose={dismissHelp} />}
            <div className="border border-hairline bg-bg">
              {toolbar}
              {overflowWarning && <div className="px-3 pt-2">{overflowWarning}</div>}
              <div className="border-b border-hairline px-3 py-1.5 flex items-center justify-between">
                <span className={LABEL}>Layers</span>
                <button onClick={() => setAdding(true)} className="text-[0.6875rem] text-mid hover:text-fg border border-hairline px-1.5 py-0.5">＋</button>
              </div>
              {layerRows}
              <div className="border-t border-hairline">{inspector}</div>
              {stitchSettings}
            </div>
          </div>
          <div className="sticky bottom-0 z-20 -mx-pad border-t border-hairline bg-bg/95 px-pad py-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))] backdrop-blur space-y-1.5">
            {saveHint}
            {actionBar}
          </div>
        </div>
        {adding && <AddModal onAdd={addBlock} onClose={() => setAdding(false)} />}
      </>
    );
  }

  // ── Desktop: editor frame - toolbar / canvas + panel / action bar ──
  return (
    <>
      <div className="space-y-3">
        {showHelp && <Walkthrough onClose={dismissHelp} />}
        <div className="border border-hairline bg-bg">
          {toolbar}
          <div className="lg:flex lg:items-stretch">
            <div className="lg:flex-1 min-w-0 bg-card/30">{canvasBox(64)}</div>
            <div className="lg:w-[340px] shrink-0 border-t lg:border-t-0 lg:border-l border-hairline flex flex-col">
              <div className="px-3 py-1.5 border-b border-hairline flex items-center justify-between">
                <span className={LABEL}>Layers · sew top first</span>
                <button onClick={() => setAdding(true)} className="text-[0.6875rem] text-mid hover:text-fg border border-hairline px-1.5 py-0.5">＋ Add</button>
              </div>
              <div className="max-h-[240px] overflow-y-auto">{layerRows}</div>
              <div className="border-t border-hairline flex-1">{inspector}</div>
              {stitchSettings}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hairline px-3 py-2.5">
            {stats}
            {saveHint}
            <div className="ml-auto flex items-center gap-2">{actionBar}</div>
          </div>
        </div>
        {overflowWarning}
        <p className="text-[0.6875rem] text-mid leading-relaxed">
          Layers sew in list order and share threads where colors match, so the machine stops as little as possible. The export is the exact file your machine reads.
        </p>
      </div>
      {adding && <AddModal onAdd={addBlock} onClose={() => setAdding(false)} />}
    </>
  );
}
