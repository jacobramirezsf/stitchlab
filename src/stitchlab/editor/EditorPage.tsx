// Stitch Lab project editor - the place where elements compose into one
// design you can keep editing. Desktop: canvas center, add/elements left,
// properties right, precise numerics, keyboard shortcuts. Mobile: canvas
// owns the screen, a labeled bottom toolbar opens focused sheets, touch
// handles are finger-sized, pinch zooms.
//
// The editing canvas draws element PATHS (fast, live). The export dialog
// renders the authoritative preview by re-parsing the exact DST bytes -
// the honesty loop the standalone tools established.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ADAPTERS, defaultParams, type Adapter } from "./adapters";
import { buildElement, bytesToB64, decodeImage, evictElement, type BuiltElement } from "./build";
import { placePaths, bboxPaths } from "./geometry";
import {
  composeProject,
  newElementId,
  newProject,
  stitchFileScale,
  type GeneratedElement,
  type Project,
  type ProjectElement,
} from "../lib/project";
import { canRedo, canUndo, createHistory, push as histPush, redo as histRedo, replace as histReplace, undo as histUndo, type History } from "../lib/history";
import { createAutosaver, getProject, putProjectLocal, type SaveResult } from "../lib/projects";
import { listDesigns, type SavedDesign } from "../lib/library";
import { buildDesign, useIsMobile, useUnits } from "../tools/shared";
import { AddPanel, ElementList, LibraryPicker, PropertiesPanel, ExportPanel, ProjectStats } from "./panels";

import { THREADS } from "../../data/threads";
const INK = "#26324d";
const DEFAULT_THREAD = THREADS.find((t) => t.name === "Black" && t.hex)?.hex ?? THREADS.find((t) => t.hex)?.hex ?? INK;
const FABRIC = "#f7f5f1";

// ── small helpers ──────────────────────────────────────────────────────────

const imgElCache = new Map<string, HTMLImageElement>();
function imageEl(dataUrl: string): HTMLImageElement {
  let el = imgElCache.get(dataUrl);
  if (!el) {
    el = new Image();
    el.src = dataUrl;
    imgElCache.set(dataUrl, el);
  }
  return el;
}

function elementLabel(el: ProjectElement): string {
  if (el.kind === "generated") return el.name || ADAPTERS[el.tool]?.title || el.tool;
  if (el.kind === "stitchfile") return el.name || el.sourceName || "Stitch file";
  return el.name || "Reference image";
}

/** Placed bounding box of an element on the hoop, mm. */
function placedBoxMm(el: ProjectElement, built: BuiltElement | null): { x: number; y: number; w: number; h: number } {
  const t = el.transform;
  if (el.kind === "image" || !built || !built.groups.length) {
    const w = el.kind === "image" ? el.sizeMm * (el.aspect >= 1 ? 1 : el.aspect) : el.sizeMm;
    const h = el.kind === "image" ? el.sizeMm * (el.aspect >= 1 ? 1 / el.aspect : 1) : el.sizeMm;
    return { x: t.xMm - w / 2, y: t.yMm - h / 2, w, h };
  }
  const scale = el.kind === "stitchfile" ? stitchFileScale(el) : 1;
  const sizeMm = el.kind === "stitchfile" ? Math.max(el.nativeWidthMm, el.nativeHeightMm) * scale : el.sizeMm;
  const placed = built.groups.flatMap((g) =>
    placePaths(g.paths, { cx: t.xMm, cy: t.yMm, sizeMm, rotDeg: t.rotDeg, flipX: el.flipX, flipY: el.flipY }),
  );
  const b = bboxPaths(placed);
  return { x: b.minX, y: b.minY, w: b.w, h: b.h };
}

let staggerN = 0;

// ── the page ───────────────────────────────────────────────────────────────

export default function EditorPage({ projectId, onExit }: { projectId: string; onExit: () => void }) {
  const mobile = useIsMobile();
  const units = useUnits();

  // ── project + history ──
  const [hist, setHist] = useState<History<Project> | null>(null);
  const project = hist?.present ?? null;
  const [loadState, setLoadState] = useState<"loading" | "ready" | "missing">("loading");

  useEffect(() => {
    let live = true;
    (async () => {
      const p = projectId === "new" ? newProject() : await getProject(projectId);
      if (!live) return;
      if (!p) { setLoadState("missing"); return; }
      if (projectId === "new") {
        await putProjectLocal(p);
        window.location.hash = `p/${p.id}`;
      }
      setHist(createHistory(p));
      setLoadState("ready");
    })();
    return () => { live = false; };
  }, [projectId]);

  // ── autosave with honest states ──
  const [saveInfo, setSaveInfo] = useState<SaveResult>({ state: "device" });
  const autosaver = useMemo(() => createAutosaver(setSaveInfo), []);
  const lastSavedRef = useRef<Project | null>(null);
  useEffect(() => {
    if (!project || project === lastSavedRef.current) return;
    lastSavedRef.current = project;
    autosaver.schedule({ ...project, thumbPng: thumbRef.current ?? project.thumbPng });
  }, [project, autosaver]);
  useEffect(() => () => { void autosaver.flushNow(); }, [autosaver]);

  // ── element builds (async, token-guarded, immutable state) ──
  const [builds, setBuilds] = useState<Map<string, BuiltElement | null>>(() => new Map());
  const buildToken = useRef(0);
  const [buildingIds, setBuildingIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!project) return;
    const token = ++buildToken.current;
    (async () => {
      await Promise.resolve(); // never set state synchronously inside the effect
      const slow = project.elements.filter(
        (e) => e.kind === "generated" && ADAPTERS[(e as GeneratedElement).tool]?.slow,
      );
      if (token !== buildToken.current) return;
      if (slow.length) setBuildingIds(new Set(slow.map((e) => e.id)));
      for (const el of project.elements) {
        if (el.kind === "image") continue;
        const built = await buildElement(el);
        if (buildToken.current !== token) return; // stale build - drop it
        setBuilds((prev) => {
          const next = new Map(prev);
          next.set(el.id, built);
          return next;
        });
        setBuildingIds((prev) => {
          if (!prev.has(el.id)) return prev;
          const next = new Set(prev);
          next.delete(el.id);
          return next;
        });
      }
      // drop builds for elements that no longer exist
      const ids = new Set(project.elements.map((e) => e.id));
      setBuilds((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const id of [...next.keys()]) if (!ids.has(id)) { next.delete(id); evictElement(id); changed = true; }
        return changed ? next : prev;
      });
    })();
  }, [project]);

  // ── selection (a stale id simply resolves to null - no pruning effect) ──
  const [selId, setSelId] = useState<string | null>(null);
  const sel = project?.elements.find((e) => e.id === selId) ?? null;

  // ── mutate helpers (history-aware) ──
  const commit = useCallback((up: (p: Project) => Project) => {
    setHist((h) => (h ? histPush(h, up(h.present)) : h));
  }, []);
  const live = useCallback((up: (p: Project) => Project) => {
    setHist((h) => (h ? histReplace(h, up(h.present)) : h));
  }, []);
  const gestureStart = useCallback(() => {
    setHist((h) => (h ? histPush(h, h.present) : h)); // snapshot; drag then replaces
  }, []);
  const patchEl = useCallback((id: string, patch: Partial<ProjectElement>, mode: "commit" | "live" = "commit") => {
    const up = (p: Project): Project => ({
      ...p,
      elements: p.elements.map((e) => (e.id === id ? ({ ...e, ...patch } as ProjectElement) : e)),
    });
    (mode === "commit" ? commit : live)(up);
  }, [commit, live]);

  const undoAct = () => setHist((h) => (h ? histUndo(h) : h));
  const redoAct = () => setHist((h) => (h ? histRedo(h) : h));

  // ── add elements ──
  const [startTab] = useState<string | null>(() => {
    try {
      const t = sessionStorage.getItem("stitchlab-editor-start");
      if (t) sessionStorage.removeItem("stitchlab-editor-start");
      return t;
    } catch { return null; }
  });
  const [panel, setPanel] = useState<null | "add" | "elements" | "edit" | "export">(() =>
    mobile ? (startTab ? "add" : null) : "add",
  );
  const addGenerated = (adapter: Adapter, extra?: Partial<GeneratedElement>) => {
    const id = newElementId();
    const off = (staggerN++ % 5) * 8 - 16;
    const el: GeneratedElement = {
      id,
      kind: "generated",
      name: adapter.title,
      tool: adapter.id,
      params: defaultParams(adapter),
      colors: [DEFAULT_THREAD],
      transform: { xMm: off, yMm: off, rotDeg: 0 },
      sizeMm: 100,
      hidden: false,
      locked: false,
      ...extra,
    };
    commit((p) => ({ ...p, elements: [...p.elements, el] }));
    setSelId(id);
    setPanel("edit");
  };

  const fileRef = useRef<HTMLInputElement | null>(null);
  const pendingPhotoAdapter = useRef<string | null>(null);
  const addPhoto = (adapterId: string) => {
    pendingPhotoAdapter.current = adapterId;
    fileRef.current?.click();
  };
  const onPhotoFile = async (f: File | undefined) => {
    if (!f) return;
    const adapterId = pendingPhotoAdapter.current ?? "oneline";
    const adapter = ADAPTERS[adapterId];
    const dataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = rej;
      r.readAsDataURL(f);
    });
    // store a SMALL image (220px) - projects must stay light enough to sync
    const img = await decodeImage(dataUrl);
    const cvs = document.createElement("canvas");
    cvs.width = img.w; cvs.height = img.h;
    const ctx = cvs.getContext("2d");
    let small = dataUrl;
    if (ctx) {
      const el = imageEl(dataUrl);
      await el.decode().catch(() => {});
      ctx.drawImage(el, 0, 0, img.w, img.h);
      small = cvs.toDataURL("image/jpeg", 0.82);
    }
    if (adapterId.startsWith("replace:")) {
      const targetId = adapterId.slice(8);
      patchEl(targetId, { imageDataUrl: small } as Partial<ProjectElement>);
      return;
    }
    if (adapterId === "reference") {
      const id = newElementId();
      commit((p) => ({
        ...p,
        elements: [...p.elements, {
          id, kind: "image", name: f.name.replace(/\.[a-z]+$/i, ""), dataUrl: small,
          aspect: img.w / img.h, referenceOnly: true,
          transform: { xMm: 0, yMm: 0, rotDeg: 0 }, sizeMm: 120, hidden: false, locked: false,
        }],
      }));
      setSelId(id);
      setPanel("edit");
      return;
    }
    if (!adapter) return;
    addGenerated(adapter, { imageDataUrl: small, name: `${adapter.title} photo` });
  };

  const [libraryDesigns, setLibraryDesigns] = useState<SavedDesign[] | null>(null);
  const loadLibrary = () => { void listDesigns().then(setLibraryDesigns).catch(() => setLibraryDesigns([])); };
  const addFromLibrary = (d: SavedDesign) => {
    const id = newElementId();
    commit((p) => ({
      ...p,
      elements: [...p.elements, {
        id, kind: "stitchfile", name: d.name.replace(/^bayside-/, ""), dstBase64: bytesToB64(d.bytes),
        colors: d.colors.length ? d.colors : [INK],
        nativeWidthMm: d.widthMm, nativeHeightMm: d.heightMm,
        sizeMm: Math.max(d.widthMm, d.heightMm),
        sourceName: d.name,
        transform: { xMm: 0, yMm: 0, rotDeg: 0 }, hidden: false, locked: false,
      }],
    }));
    setSelId(id);
    setPanel("edit");
  };

  // ── element ops ──
  const removeEl = (id: string) => commit((p) => ({ ...p, elements: p.elements.filter((e) => e.id !== id) }));
  const duplicateEl = (id: string) => {
    const src = project?.elements.find((e) => e.id === id);
    if (!src) return;
    const copy = { ...src, id: newElementId(), name: `${elementLabel(src)} copy`, transform: { ...src.transform, xMm: src.transform.xMm + 10, yMm: src.transform.yMm + 10 } } as ProjectElement;
    commit((p) => ({ ...p, elements: [...p.elements, copy] }));
    setSelId(copy.id);
  };
  const moveEl = (id: string, dir: 1 | -1) =>
    commit((p) => {
      const i = p.elements.findIndex((e) => e.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= p.elements.length) return p;
      const els = [...p.elements];
      [els[i], els[j]] = [els[j], els[i]];
      return { ...p, elements: els };
    });
  const alignEl = (id: string, how: "left" | "centerX" | "right" | "top" | "centerY" | "bottom") => {
    if (!project) return;
    const el = project.elements.find((e) => e.id === id);
    if (!el) return;
    const box = placedBoxMm(el, builds.get(id) ?? null);
    const { wMm, hMm } = project.hoop;
    const t = { ...el.transform };
    if (how === "left") t.xMm += -wMm / 2 - box.x;
    if (how === "right") t.xMm += wMm / 2 - (box.x + box.w);
    if (how === "centerX") t.xMm += -(box.x + box.w / 2);
    if (how === "top") t.yMm += -hMm / 2 - box.y;
    if (how === "bottom") t.yMm += hMm / 2 - (box.y + box.h);
    if (how === "centerY") t.yMm += -(box.y + box.h / 2);
    patchEl(id, { transform: t });
  };
  const variation = (el: GeneratedElement) => {
    const a = ADAPTERS[el.tool];
    const key = a?.seedKey ?? "seed";
    const spec = a?.params.find((q) => q.key === key);
    const max = spec && spec.kind === "range" ? spec.max : 99;
    const min = spec && spec.kind === "range" ? spec.min : 1;
    const cur = typeof el.params[key] === "number" ? (el.params[key] as number) : min;
    const next = cur + 1 > max ? min : cur + 1;
    patchEl(el.id, { params: { ...el.params, [key]: next } });
  };
  const resetParams = (el: GeneratedElement) => {
    const a = ADAPTERS[el.tool];
    if (a) patchEl(el.id, { params: defaultParams(a) });
  };

  // ── canvas view (pan/zoom, studio-style + pinch) ──
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const panRef = useRef({ x: 0, y: 0 });
  const [, forceView] = useState(0);
  const viewRef = useRef({ pxPerMm: 2, w: 0, h: 0 });

  const fitView = () => { setZoom(1); panRef.current = { x: 0, y: 0 }; forceView((n) => n + 1); };

  // draw
  useEffect(() => {
    const c = canvasRef.current;
    const wrap = wrapRef.current;
    if (!c || !wrap || !project) return;
    const draw = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = wrap.clientWidth, h = wrap.clientHeight;
      if (!w || !h) return;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = FABRIC;
      ctx.fillRect(0, 0, w, h);
      const fit = Math.min((w - 32) / project.hoop.wMm, (h - 32) / project.hoop.hMm);
      const pxPerMm = fit * zoom;
      viewRef.current = { pxPerMm, w, h };
      const X = (mmX: number) => mmX * pxPerMm + w / 2 + panRef.current.x;
      const Y = (mmY: number) => mmY * pxPerMm + h / 2 + panRef.current.y;

      // hoop
      ctx.strokeStyle = "#b9b4a8";
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 1;
      ctx.strokeRect(X(-project.hoop.wMm / 2), Y(-project.hoop.hMm / 2), project.hoop.wMm * pxPerMm, project.hoop.hMm * pxPerMm);
      ctx.setLineDash([]);

      for (const el of project.elements) {
        if (el.hidden) continue;
        const t = el.transform;
        if (el.kind === "image") {
          const img = imageEl(el.dataUrl);
          if (img.complete && img.naturalWidth) {
            const wMm = el.sizeMm * (el.aspect >= 1 ? 1 : el.aspect);
            const hMm = el.sizeMm * (el.aspect >= 1 ? 1 / el.aspect : 1);
            ctx.save();
            ctx.translate(X(t.xMm), Y(t.yMm));
            ctx.rotate((t.rotDeg * Math.PI) / 180);
            ctx.globalAlpha = 0.85;
            ctx.drawImage(img, (-wMm / 2) * pxPerMm, (-hMm / 2) * pxPerMm, wMm * pxPerMm, hMm * pxPerMm);
            ctx.restore();
          }
          continue;
        }
        const built = builds.get(el.id);
        if (!built) continue;
        const scale = el.kind === "stitchfile" ? stitchFileScale(el) : 1;
        const sizeMm = el.kind === "stitchfile" ? Math.max(el.nativeWidthMm, el.nativeHeightMm) * scale : el.sizeMm;
        const dim = selId && selId !== el.id;
        ctx.globalAlpha = dim ? 0.45 : 1;
        for (let gi = 0; gi < built.groups.length; gi++) {
          const g = built.groups[gi];
          const color = el.kind === "generated" ? (el.colors[gi % Math.max(1, el.colors.length)] ?? INK) : g.color;
          ctx.strokeStyle = color;
          ctx.lineWidth = Math.max(1, 0.45 * pxPerMm);
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          const placed = placePaths(g.paths, { cx: t.xMm, cy: t.yMm, sizeMm, rotDeg: t.rotDeg, flipX: el.flipX, flipY: el.flipY });
          for (const p of placed) {
            if (p.length < 2) continue;
            ctx.beginPath();
            ctx.moveTo(X(p[0].x), Y(p[0].y));
            for (let i = 1; i < p.length; i++) ctx.lineTo(X(p[i].x), Y(p[i].y));
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
      }

      // selection box + handles
      if (sel && !sel.hidden) {
        const box = placedBoxMm(sel, builds.get(sel.id) ?? null);
        const x0 = X(box.x), y0 = Y(box.y), bw = box.w * viewRef.current.pxPerMm, bh = box.h * viewRef.current.pxPerMm;
        ctx.strokeStyle = INK;
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.25;
        ctx.strokeRect(x0, y0, bw, bh);
        ctx.setLineDash([]);
        const hs = mobile ? 13 : 6; // handle radius, px
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = INK;
        for (const [hx, hy] of [[x0, y0], [x0 + bw, y0], [x0, y0 + bh], [x0 + bw, y0 + bh]] as const) {
          ctx.beginPath();
          ctx.arc(hx, hy, hs, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        // rotate handle above the top edge
        const rx = x0 + bw / 2, ry = y0 - (mobile ? 34 : 26);
        ctx.beginPath();
        ctx.moveTo(x0 + bw / 2, y0);
        ctx.lineTo(rx, ry);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(rx, ry, hs, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = INK;
        ctx.font = `${mobile ? 12 : 10}px system-ui`;
        ctx.textAlign = "center";
        ctx.fillText("⟳", rx, ry + 4);
      }

      // building indicator
      if (buildingIds.size) {
        ctx.fillStyle = "rgba(38,50,77,0.75)";
        ctx.font = "12px system-ui";
        ctx.textAlign = "left";
        ctx.fillText("Generating…", 12, 20);
      }
      if (!project.elements.length) {
        ctx.fillStyle = "#8b8677";
        ctx.font = "14px system-ui";
        ctx.textAlign = "center";
        ctx.fillText("Add a pattern, words, or a photo to start.", w / 2, h / 2);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [project, sel, selId, zoom, builds, buildingIds, mobile]);

  // ── pointer interactions (move / resize / rotate / pan / pinch) ──
  type Drag =
    | { mode: "move"; id: string; startX: number; startY: number; elX: number; elY: number }
    | { mode: "resize"; id: string; centerPx: { x: number; y: number }; startDist: number; startSize: number }
    | { mode: "rotate"; id: string; centerPx: { x: number; y: number }; startAngle: number; elRot: number }
    | { mode: "pan"; startX: number; startY: number; panX: number; panY: number }
    | null;
  const dragRef = useRef<Drag>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ dist: number; zoom: number } | null>(null);
  const movedRef = useRef(false);

  const toMm = (clientX: number, clientY: number) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    const { pxPerMm, w, h } = viewRef.current;
    return {
      x: (clientX - r.left - w / 2 - panRef.current.x) / pxPerMm,
      y: (clientY - r.top - h / 2 - panRef.current.y) / pxPerMm,
      px: clientX - r.left,
      py: clientY - r.top,
    };
  };

  const hitHandle = (px: number, py: number): "tl" | "tr" | "bl" | "br" | "rot" | null => {
    if (!sel || sel.hidden || sel.locked) return null;
    const box = placedBoxMm(sel, builds.get(sel.id) ?? null);
    const { pxPerMm, w, h } = viewRef.current;
    const X = (mm: number) => mm * pxPerMm + w / 2 + panRef.current.x;
    const Y = (mm: number) => mm * pxPerMm + h / 2 + panRef.current.y;
    const x0 = X(box.x), y0 = Y(box.y), bw = box.w * pxPerMm, bh = box.h * pxPerMm;
    const tol = mobile ? 24 : 12;
    const near = (hx: number, hy: number) => Math.hypot(px - hx, py - hy) <= tol;
    if (near(x0 + bw / 2, y0 - (mobile ? 34 : 26))) return "rot";
    if (near(x0, y0)) return "tl";
    if (near(x0 + bw, y0)) return "tr";
    if (near(x0, y0 + bh)) return "bl";
    if (near(x0 + bw, y0 + bh)) return "br";
    return null;
  };

  const hitElement = (mmX: number, mmY: number): string | null => {
    if (!project) return null;
    for (let i = project.elements.length - 1; i >= 0; i--) {
      const el = project.elements[i];
      if (el.hidden || el.locked) continue;
      const box = placedBoxMm(el, builds.get(el.id) ?? null);
      const pad = mobile ? 4 : 2;
      if (mmX >= box.x - pad && mmX <= box.x + box.w + pad && mmY >= box.y - pad && mmY <= box.y + box.h + pad) return el.id;
    }
    return null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    movedRef.current = false;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchRef.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom };
      dragRef.current = null;
      return;
    }
    const { x, y, px, py } = toMm(e.clientX, e.clientY);
    const handle = hitHandle(px, py);
    if (handle && sel) {
      const box = placedBoxMm(sel, builds.get(sel.id) ?? null);
      const { pxPerMm, w, h } = viewRef.current;
      const cx = (box.x + box.w / 2) * pxPerMm + w / 2 + panRef.current.x;
      const cy = (box.y + box.h / 2) * pxPerMm + h / 2 + panRef.current.y;
      gestureStart();
      if (handle === "rot") {
        dragRef.current = { mode: "rotate", id: sel.id, centerPx: { x: cx, y: cy }, startAngle: Math.atan2(py - cy, px - cx), elRot: sel.transform.rotDeg };
      } else {
        dragRef.current = {
          mode: "resize",
          id: sel.id,
          centerPx: { x: cx, y: cy },
          startDist: Math.max(8, Math.hypot(px - cx, py - cy)),
          startSize: sel.kind === "stitchfile" ? sel.sizeMm : sel.sizeMm,
        };
      }
      return;
    }
    const hitId = hitElement(x, y);
    if (hitId) {
      setSelId(hitId);
      const el = project!.elements.find((q) => q.id === hitId)!;
      gestureStart();
      dragRef.current = { mode: "move", id: hitId, startX: x, startY: y, elX: el.transform.xMm, elY: el.transform.yMm };
      return;
    }
    // empty space: pan (and deselect on tap without movement)
    dragRef.current = { mode: "pan", startX: e.clientX, startY: e.clientY, panX: panRef.current.x, panY: panRef.current.y };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinchRef.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      setZoom(Math.min(6, Math.max(0.5, (pinchRef.current.zoom * dist) / Math.max(20, pinchRef.current.dist))));
      return;
    }
    const d = dragRef.current;
    if (!d) return;
    movedRef.current = true;
    if (d.mode === "pan") {
      panRef.current = { x: d.panX + (e.clientX - d.startX), y: d.panY + (e.clientY - d.startY) };
      forceView((n) => n + 1);
      return;
    }
    const { x, y, px, py } = toMm(e.clientX, e.clientY);
    if (d.mode === "move") {
      const half = { w: (project?.hoop.wMm ?? 330) / 2 + 30, h: (project?.hoop.hMm ?? 406) / 2 + 30 };
      const nx = Math.max(-half.w, Math.min(half.w, d.elX + (x - d.startX)));
      const ny = Math.max(-half.h, Math.min(half.h, d.elY + (y - d.startY)));
      patchEl(d.id, { transform: { ...(project!.elements.find((q) => q.id === d.id)!.transform), xMm: nx, yMm: ny } }, "live");
    } else if (d.mode === "resize") {
      const dist = Math.hypot(px - d.centerPx.x, py - d.centerPx.y);
      const next = Math.max(8, Math.min((project?.hoop.wMm ?? 330) * 1.5, (d.startSize * dist) / d.startDist));
      patchEl(d.id, { sizeMm: Math.round(next * 10) / 10 }, "live");
    } else if (d.mode === "rotate") {
      const ang = Math.atan2(py - d.centerPx.y, px - d.centerPx.x);
      let deg = d.elRot + ((ang - d.startAngle) * 180) / Math.PI;
      deg = ((deg % 360) + 360) % 360;
      const el = project!.elements.find((q) => q.id === d.id)!;
      patchEl(d.id, { transform: { ...el.transform, rotDeg: Math.round(deg) } }, "live");
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchRef.current = null;
    const d = dragRef.current;
    if (d?.mode === "pan" && !movedRef.current) setSelId(null);
    // gesture snapshots were pushed on down; if nothing moved, drop the no-op
    // snapshot from the past (present is unchanged, so this is exact)
    if (d && d.mode !== "pan" && !movedRef.current) {
      setHist((h) => (h && h.past.length ? { ...h, past: h.past.slice(0, -1) } : h));
    }
    dragRef.current = null;
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.min(6, Math.max(0.5, z * (e.deltaY > 0 ? 0.9 : 1.1))));
  };

  // ── keyboard (desktop) ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redoAct(); else undoAct();
        return;
      }
      if (!sel) return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeEl(sel.id); }
      if (e.key === "Escape") setSelId(null);
      const step = e.shiftKey ? 5 : 1;
      const t2 = { ...sel.transform };
      if (e.key === "ArrowLeft") { t2.xMm -= step; patchEl(sel.id, { transform: t2 }); e.preventDefault(); }
      if (e.key === "ArrowRight") { t2.xMm += step; patchEl(sel.id, { transform: t2 }); e.preventDefault(); }
      if (e.key === "ArrowUp") { t2.yMm -= step; patchEl(sel.id, { transform: t2 }); e.preventDefault(); }
      if (e.key === "ArrowDown") { t2.yMm += step; patchEl(sel.id, { transform: t2 }); e.preventDefault(); }
      if (e.key.toLowerCase() === "d" && !e.metaKey && !e.ctrlKey) { duplicateEl(sel.id); e.preventDefault(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ── thumbnail for autosave/library ──
  const thumbRef = useRef<string | null>(null);
  useEffect(() => {
    if (!project) return;
    const t = setTimeout(() => {
      const cvs = document.createElement("canvas");
      cvs.width = 220; cvs.height = 220;
      const ctx = cvs.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = FABRIC;
      ctx.fillRect(0, 0, 220, 220);
      const fit = Math.min(200 / project.hoop.wMm, 200 / project.hoop.hMm);
      for (const el of project.elements) {
        if (el.hidden || el.kind === "image") continue;
        const built = builds.get(el.id);
        if (!built) continue;
        const scale = el.kind === "stitchfile" ? stitchFileScale(el) : 1;
        const sizeMm = el.kind === "stitchfile" ? Math.max(el.nativeWidthMm, el.nativeHeightMm) * scale : el.sizeMm;
        for (let gi = 0; gi < built.groups.length; gi++) {
          const g = built.groups[gi];
          ctx.strokeStyle = el.kind === "generated" ? (el.colors[gi % Math.max(1, el.colors.length)] ?? INK) : g.color;
          ctx.lineWidth = 1;
          for (const p of placePaths(g.paths, { cx: el.transform.xMm, cy: el.transform.yMm, sizeMm, rotDeg: el.transform.rotDeg, flipX: el.flipX, flipY: el.flipY })) {
            if (p.length < 2) continue;
            ctx.beginPath();
            ctx.moveTo(p[0].x * fit + 110, p[0].y * fit + 110);
            for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x * fit + 110, p[i].y * fit + 110);
            ctx.stroke();
          }
        }
      }
      thumbRef.current = cvs.toDataURL("image/png");
    }, 600);
    return () => clearTimeout(t);
  }, [project, builds]);

  // ── compose for export ──
  const composed = useMemo(() => {
    if (!project) return null;
    const map = new Map<string, { elementId: string; stitches: BuiltElement["stitches"]; colors: string[] }>();
    for (const el of project.elements) {
      const b = builds.get(el.id);
      if (b && b.stitches.length) map.set(el.id, { elementId: el.id, stitches: b.stitches, colors: b.colors });
    }
    const c = composeProject(project, map);
    if (!c.stitches.length) return null;
    return { ...c, built: buildDesign(c.stitches, project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 14) || "bayside") };
  }, [project, builds]);

  if (loadState === "loading") return <div className="py-20 text-center text-[0.875rem] text-mid">Opening the project…</div>;
  if (loadState === "missing" || !project) {
    return (
      <div className="py-20 text-center space-y-3">
        <p className="text-[0.875rem] text-mid">This project isn't on this device.</p>
        <button onClick={onExit} className="border border-fg px-4 py-2 text-[0.875rem]">Back to projects</button>
      </div>
    );
  }

  const saveLabel =
    saveInfo.state === "saving" ? "Saving…"
    : saveInfo.state === "cloud" ? "Saved · synced"
    : saveInfo.state === "device" ? "Saved on this device"
    : saveInfo.state === "sync-failed" ? `Saved here · sync failed${saveInfo.detail ? ` (${saveInfo.detail})` : ""}`
    : saveInfo.state === "conflict" ? "Edited elsewhere - your changes were kept as a copy"
    : "Couldn't save - storage is blocked or full";
  const saveTone = saveInfo.state === "cloud" || saveInfo.state === "device" || saveInfo.state === "saving" ? "text-mid" : "text-amber-800";

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
        onChange={(e) => { void onPhotoFile(e.target.files?.[0]); e.currentTarget.value = ""; }} />

      {/* top bar */}
      <div className="shrink-0 border-b border-hairline bg-bg px-2 sm:px-3 py-1.5 flex items-center gap-2 min-w-0">
        <button onClick={() => { void autosaver.flushNow().then(onExit); }} className="text-[0.8125rem] text-accent hover:underline shrink-0">← Projects</button>
        <input
          value={project.name}
          onChange={(e) => live((p) => ({ ...p, name: e.target.value }))}
          onBlur={(e) => commit((p) => ({ ...p, name: e.target.value.trim() || "Untitled project" }))}
          aria-label="Project name"
          className="min-w-0 flex-1 sm:flex-none sm:w-56 bg-transparent border border-transparent hover:border-hairline focus:border-fg px-1.5 py-0.5 text-[0.9375rem] font-serif text-fg outline-none"
        />
        <div className="flex items-center gap-1">
          <button onClick={undoAct} disabled={!hist || !canUndo(hist)} aria-label="Undo" title="Undo (Cmd+Z)" className="w-8 h-8 border border-hairline text-[0.9375rem] disabled:opacity-30 hover:border-fg">↶</button>
          <button onClick={redoAct} disabled={!hist || !canRedo(hist)} aria-label="Redo" title="Redo (Shift+Cmd+Z)" className="w-8 h-8 border border-hairline text-[0.9375rem] disabled:opacity-30 hover:border-fg">↷</button>
        </div>
        {!mobile && (
          <div className="flex items-center gap-1">
            <button onClick={() => setZoom((z) => Math.max(0.5, z / 1.25))} aria-label="Zoom out" className="w-8 h-8 border border-hairline hover:border-fg">−</button>
            <button onClick={fitView} className="h-8 px-2.5 border border-hairline text-[0.75rem] hover:border-fg">Fit</button>
            <button onClick={() => setZoom((z) => Math.min(6, z * 1.25))} aria-label="Zoom in" className="w-8 h-8 border border-hairline hover:border-fg">＋</button>
          </div>
        )}
        <span className={`ml-auto text-[0.6875rem] ${saveTone} truncate hidden sm:inline`} aria-live="polite">{saveLabel}</span>
        {!mobile && (
          <button onClick={() => setPanel(panel === "export" ? "add" : "export")} className={`shrink-0 border px-3 py-1.5 text-[0.8125rem] ${panel === "export" ? "border-fg bg-fg text-bg" : "border-fg hover:bg-fg hover:text-bg"}`}>
            Export
          </button>
        )}
      </div>

      {/* body */}
      <div className="flex-1 min-h-0 flex">
        {/* desktop left: add + elements */}
        {!mobile && (
          <div className="w-[250px] shrink-0 border-r border-hairline bg-bg flex flex-col min-h-0">
            <AddPanel onAdapter={(a) => addGenerated(a)} onPhoto={addPhoto} onLibrary={() => { loadLibrary(); setPanel("elements"); }} compact initialTab={startTab ?? undefined} />
            <div className="border-t border-hairline flex-1 min-h-0 overflow-y-auto">
              <ElementList
                project={project}
                selId={selId}
                onSelect={(id) => { setSelId(id); }}
                onToggle={(id, k) => { const el = project.elements.find((e) => e.id === id)!; patchEl(id, { [k]: !el[k] } as Partial<ProjectElement>); }}
                onMove={moveEl}
                onDuplicate={duplicateEl}
                onRemove={removeEl}
              />
              {libraryDesigns && (
                <LibraryPicker designs={libraryDesigns} onPick={addFromLibrary} onClose={() => setLibraryDesigns(null)} />
              )}
            </div>
          </div>
        )}

        {/* canvas */}
        <div ref={wrapRef} className="relative flex-1 min-w-0 min-h-0" style={{ background: FABRIC }}>
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full touch-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
          />
          <span className="absolute left-2 bottom-1.5 text-[0.625rem] text-mid/70 pointer-events-none select-none">
            editing view - export shows the exact stitch file
          </span>
          {mobile && (
            <div className="absolute right-2 top-2 flex flex-col gap-1">
              <button onClick={() => setZoom((z) => Math.min(6, z * 1.25))} aria-label="Zoom in" className="w-9 h-9 border border-hairline bg-bg/90 text-[1.0625rem]">＋</button>
              <button onClick={fitView} className="h-9 px-1.5 border border-hairline bg-bg/90 text-[0.625rem]">Fit</button>
              <button onClick={() => setZoom((z) => Math.max(0.5, z / 1.25))} aria-label="Zoom out" className="w-9 h-9 border border-hairline bg-bg/90 text-[1.0625rem]">−</button>
            </div>
          )}
        </div>

        {/* desktop right: properties / export */}
        {!mobile && (
          <div className="w-[300px] shrink-0 border-l border-hairline bg-bg overflow-y-auto">
            {panel === "export" ? (
              <ExportPanel project={project} composed={composed} units={units} />
            ) : sel ? (
              <PropertiesPanel
                el={sel}
                built={builds.get(sel.id) ?? null}
                onPatch={(patch, mode) => patchEl(sel.id, patch, mode)}
                onGesture={gestureStart}
                onAlign={(how) => alignEl(sel.id, how)}
                onVariation={sel.kind === "generated" ? () => variation(sel) : undefined}
                onReset={sel.kind === "generated" ? () => resetParams(sel) : undefined}
                onReplacePhoto={sel.kind === "generated" && ADAPTERS[sel.tool]?.needsImage ? () => addPhotoReplace(sel.id) : undefined}
              />
            ) : (
              <div className="p-4 text-[0.8125rem] text-mid leading-relaxed space-y-3">
                <p>Select an element on the canvas to edit its settings, size, and thread color.</p>
                <p>Drag to move. Corners resize. The top handle rotates. Scroll zooms; drag empty space to pan.</p>
                <ProjectStats composed={composed} project={project} units={units} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* mobile: save state + bottom toolbar + sheets */}
      {mobile && (
        <>
          <div className="shrink-0 border-t border-hairline bg-bg px-3 py-1 flex items-center">
            <span className={`text-[0.6875rem] ${saveTone} truncate`} aria-live="polite">{saveLabel}</span>
            <span className="ml-auto text-[0.6875rem] text-mid tabular-nums">
              {composed?.built ? `${composed.built.stats.realStitches.toLocaleString()} st` : "empty"}
            </span>
          </div>
          {panel && (
            <div className="shrink-0 max-h-[46dvh] border-t border-hairline bg-bg flex flex-col">
              <button onClick={() => setPanel(null)} aria-label="Close panel" className="shrink-0 w-full pt-1.5 pb-1 flex items-center justify-center">
                <span className="h-1 w-9 rounded-full bg-hairline" />
              </button>
              <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 pb-3">
                {panel === "add" && <AddPanel onAdapter={(a) => addGenerated(a)} onPhoto={addPhoto} onLibrary={loadLibrary} initialTab={startTab ?? undefined} />}
                {panel === "add" && libraryDesigns && <LibraryPicker designs={libraryDesigns} onPick={addFromLibrary} onClose={() => setLibraryDesigns(null)} />}
                {panel === "elements" && (
                  <ElementList
                    project={project}
                    selId={selId}
                    onSelect={(id) => { setSelId(id); setPanel("edit"); }}
                    onToggle={(id, k) => { const el = project.elements.find((e) => e.id === id)!; patchEl(id, { [k]: !el[k] } as Partial<ProjectElement>); }}
                    onMove={moveEl}
                    onDuplicate={duplicateEl}
                    onRemove={removeEl}
                  />
                )}
                {panel === "edit" && sel && (
                  <PropertiesPanel
                    el={sel}
                    built={builds.get(sel.id) ?? null}
                    onPatch={(patch, mode) => patchEl(sel.id, patch, mode)}
                    onGesture={gestureStart}
                    onAlign={(how) => alignEl(sel.id, how)}
                    onVariation={sel.kind === "generated" ? () => variation(sel) : undefined}
                    onReset={sel.kind === "generated" ? () => resetParams(sel) : undefined}
                    onReplacePhoto={sel.kind === "generated" && ADAPTERS[sel.tool]?.needsImage ? () => addPhotoReplace(sel.id) : undefined}
                  />
                )}
                {panel === "edit" && !sel && <p className="pt-2 text-[0.8125rem] text-mid">Tap an element on the canvas first.</p>}
                {panel === "export" && <ExportPanel project={project} composed={composed} units={units} />}
              </div>
            </div>
          )}
          <div className="shrink-0 border-t border-hairline bg-bg flex pb-[env(safe-area-inset-bottom)]">
            {([["add", "Add"], ["elements", "Elements"], ["edit", "Edit"], ["export", "Export"]] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setPanel((p) => (p === k ? null : k))}
                aria-expanded={panel === k}
                disabled={k === "edit" && !sel}
                className={`flex-1 py-3 text-[0.625rem] tracking-[0.08em] uppercase disabled:opacity-35 ${panel === k ? "bg-fg text-bg" : "text-mid active:bg-card"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );

  // replace the photo behind a generated element
  function addPhotoReplace(elementId: string) {
    pendingPhotoAdapter.current = `replace:${elementId}`;
    fileRef.current?.click();
  }
}
