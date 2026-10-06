// Editor build pipeline: project elements → local geometry → local stitches.
//
// Caching mirrors the workspace prototype's proven design: geometry is keyed
// by everything that changes the LOCAL artwork (tool, params, source image),
// and deliberately NOT by position/rotation - dragging never regenerates.
// Stitches are additionally keyed by size and flips, because stitch routing
// and resampling happen at real physical scale (that is what keeps stitch
// lengths machine-correct when an element is resized).
//
// Builds are async (image decode) and token-guarded: a stale build result
// never overwrites a newer edit.

import { pathGroupsToStitches, resamplePath, routeStrokes } from "../lib/generators";
import { parseDst } from "../lib/dst";
import { CMD, type Stitch } from "../lib/pattern";
import type { GeneratedElement, ProjectElement, StitchFileElement } from "../lib/project";
import { ADAPTERS, geomKey, type AdapterImage } from "./adapters";
import { placePaths, bboxPaths, type Group } from "./geometry";

export type BuiltElement = {
  /** Local 0..100 groups (for fast canvas drawing via placePaths). */
  groups: Group[];
  /** Element-local stitches: sized (sizeMm) and flipped, centered on the
   *  element origin, rotation NOT applied (compose applies it rigidly). */
  stitches: Stitch[];
  colors: string[];
  warning?: string;
};

const STITCH_LEN = 2.2;

// ── caches (module-level like the workspace's, but evicted on delete) ──────

const groupsCache = new Map<string, { key: string; groups: Group[]; warning?: string }>();
const stitchCache = new Map<string, { key: string; stitches: Stitch[]; colors: string[] }>();
const imageCache = new Map<string, Promise<AdapterImage>>();

export function evictElement(id: string): void {
  groupsCache.delete(id);
  stitchCache.delete(id);
}

export function clearBuildCaches(): void {
  groupsCache.clear();
  stitchCache.clear();
}

/** Decode a stored data URL into the small luminance image adapters expect. */
export function decodeImage(dataUrl: string): Promise<AdapterImage> {
  const hit = imageCache.get(dataUrl);
  if (hit) return hit;
  const p = new Promise<AdapterImage>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const long = 220;
      const ar = img.width / img.height;
      const w = ar >= 1 ? long : Math.max(1, Math.round(long * ar));
      const h = ar >= 1 ? Math.max(1, Math.round(long / ar)) : long;
      const cvs = document.createElement("canvas");
      cvs.width = w;
      cvs.height = h;
      const ctx = cvs.getContext("2d");
      if (!ctx) return reject(new Error("no 2d context"));
      // flatten transparency onto white like ImagePick does
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      const lum = new Float32Array(w * h);
      for (let i = 0; i < lum.length; i++) {
        lum[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) / 255;
      }
      resolve({ w, h, lum });
    };
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = dataUrl;
  });
  imageCache.set(dataUrl, p);
  return p;
}

// ── generated elements ─────────────────────────────────────────────────────

async function generatedGroups(el: GeneratedElement): Promise<{ groups: Group[]; warning?: string }> {
  const adapter = ADAPTERS[el.tool];
  if (!adapter) return { groups: [], warning: `Unknown tool "${el.tool}" - this element can't regenerate in this version.` };
  const key = geomKey(el.tool, el.params, el.imageDataUrl);
  const hit = groupsCache.get(el.id);
  if (hit && hit.key === key) return { groups: hit.groups, warning: hit.warning };
  let image: AdapterImage | undefined;
  if (adapter.needsImage) {
    if (!el.imageDataUrl) return { groups: [], warning: "Add a photo to generate this element." };
    try {
      image = await decodeImage(el.imageDataUrl);
    } catch {
      return { groups: [], warning: "The stored photo couldn't be read." };
    }
  }
  const res = adapter.generate(el.params, { image });
  groupsCache.set(el.id, { key, groups: res.groups, warning: res.warning });
  return res;
}

function generatedStitches(el: GeneratedElement, groups: Group[]): { stitches: Stitch[]; colors: string[] } {
  const key = JSON.stringify([geomKey(el.tool, el.params, el.imageDataUrl), el.sizeMm, !!el.flipX, !!el.flipY, el.colors]);
  const hit = stitchCache.get(el.id);
  if (hit && hit.key === key) return { stitches: hit.stitches, colors: hit.colors };
  // place at real size, centered, unrotated - rotation is rigid and applied at
  // compose time so it never busts this cache
  const placement = { cx: 0, cy: 0, sizeMm: el.sizeMm, rotDeg: 0, flipX: el.flipX, flipY: el.flipY };
  const routedGroups: { paths: ReturnType<typeof placePaths> }[] = [];
  const colors: string[] = [];
  groups.forEach((g, i) => {
    const placed = placePaths(g.paths, placement).filter((p) => p.length >= 2);
    if (!placed.length) return;
    const routed = g.noResample
      ? placed
      : routeStrokes(placed).map((p) => resamplePath(p, STITCH_LEN, 0.4));
    routedGroups.push({ paths: routed });
    colors.push(el.colors[i % Math.max(1, el.colors.length)] ?? el.colors[0] ?? "#26324d");
  });
  const stitches = pathGroupsToStitches(routedGroups.map((g) => g.paths), 1);
  stitchCache.set(el.id, { key, stitches, colors });
  return { stitches, colors };
}

// ── stitch-file elements ───────────────────────────────────────────────────

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

function stitchFileBuilt(el: StitchFileElement): BuiltElement {
  const key = JSON.stringify(["dst", el.dstBase64.length, el.colors]);
  const hit = stitchCache.get(el.id);
  const hitG = groupsCache.get(el.id);
  if (hit && hit.key === key && hitG) return { groups: hitG.groups, stitches: hit.stitches, colors: hit.colors };
  try {
    const bytes = b64ToBytes(el.dstBase64);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const pat = parseDst(buf);
    // recenter on the design's bounds
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const st of pat.stitches) {
      if (st.cmd !== CMD.STITCH && st.cmd !== CMD.JUMP) continue;
      if (st.x < minX) minX = st.x;
      if (st.x > maxX) maxX = st.x;
      if (st.y < minY) minY = st.y;
      if (st.y > maxY) maxY = st.y;
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const stitches: Stitch[] = pat.stitches.map((st) => ({ x: st.x - cx, y: st.y - cy, cmd: st.cmd }));
    // groups for fast drawing (paths in the local 0..100 box)
    const paths: { x: number; y: number }[][] = [];
    let cur: { x: number; y: number }[] = [];
    let block = 0;
    const groups: Group[] = [];
    const flushPath = () => { if (cur.length >= 2) paths.push(cur); cur = []; };
    const flushBlock = () => {
      flushPath();
      if (paths.length) groups.push({ color: el.colors[block] ?? "#26324d", paths: [...paths], noResample: true });
      paths.length = 0;
    };
    for (const st of stitches) {
      if (st.cmd === CMD.STITCH) cur.push({ x: st.x, y: st.y });
      else if (st.cmd === CMD.COLOR_CHANGE) { flushBlock(); block++; }
      else flushPath();
    }
    flushBlock();
    // normalize groups into 0..100 with one shared transform
    const b = bboxPaths(groups.flatMap((g) => g.paths));
    const s = b.w > 0 || b.h > 0 ? 100 / Math.max(b.w, b.h) : 1;
    const localGroups = groups.map((g) => ({
      ...g,
      paths: g.paths.map((p) => p.map((q) => ({ x: (q.x - b.minX - b.w / 2) * s + 50, y: (q.y - b.minY - b.h / 2) * s + 50 }))),
    }));
    const colors = groups.map((g) => g.color);
    groupsCache.set(el.id, { key, groups: localGroups });
    stitchCache.set(el.id, { key, stitches, colors });
    return { groups: localGroups, stitches, colors };
  } catch {
    return { groups: [], stitches: [], colors: [], warning: "This stitch file couldn't be read." };
  }
}

// ── public: build one element ──────────────────────────────────────────────

export async function buildElement(el: ProjectElement): Promise<BuiltElement | null> {
  if (el.kind === "image") return null; // reference only - never stitches
  if (el.kind === "stitchfile") return stitchFileBuilt(el);
  const { groups, warning } = await generatedGroups(el);
  if (!groups.length) return { groups: [], stitches: [], colors: [], warning };
  const { stitches, colors } = generatedStitches(el, groups);
  return { groups, stitches, colors, warning };
}
