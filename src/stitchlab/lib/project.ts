// Stitch Lab - editable project model.
//
// A project is a composition of ELEMENTS the user can keep editing: generated
// patterns (tool + parameters + seed - regenerated, never flattened), placed
// stitch files (legacy library designs - already-encoded stitches, rigidly
// transformed), and reference images (visual only, never stitched).
//
// Design rules this module enforces:
// - Generated elements store their generator parameters; resizing changes the
//   physical size PARAMETER and regenerates, so stitch lengths and density
//   stay correct. Stitches are never naively scaled.
// - Stitch-file elements may only be rigidly transformed (move/rotate).
//   Scaling them rescales real stitch lengths, so it is limited and flagged.
// - Reference images never become stitches.
// - Sew order = element order. Composition emits COLOR_CHANGE between color
//   blocks and preserves each element's internal jumps/trims.
// - Every persisted blob carries `schema`; migrateProject() is the single
//   entry point for reading any stored project.

import { CMD, type Stitch } from "./pattern";

export const PROJECT_SCHEMA_VERSION = 1;

// ── element types ──────────────────────────────────────────────────────────

export type ElementTransform = {
  /** Center offset from hoop center, mm (y-down). */
  xMm: number;
  yMm: number;
  /** Rotation, degrees clockwise. */
  rotDeg: number;
};

type ElementBase = {
  id: string;
  name: string;
  transform: ElementTransform;
  /** Long side of the element, mm. For generated elements this regenerates
   *  geometry at the new physical size (stitch lengths stay correct); for
   *  stitch files it implies a rigid scale vs the native size (bounded). */
  sizeMm: number;
  flipX?: boolean;
  flipY?: boolean;
  hidden: boolean;
  locked: boolean;
};

/** A parameter value a generator adapter understands. */
export type ParamValue = number | string | boolean;

export type GeneratedElement = ElementBase & {
  kind: "generated";
  /** Adapter id (usually the tool slug). */
  tool: string;
  /** Full parameter set, including sizeMm and seed where applicable. */
  params: Record<string, ParamValue>;
  /** Thread hex per color block. */
  colors: string[];
  /** Optional source image (small data URL) for photo-driven generators. */
  imageDataUrl?: string;
};

export type StitchFileElement = ElementBase & {
  kind: "stitchfile";
  /** Raw DST bytes, base64. The original file is the source of truth. */
  dstBase64: string;
  colors: string[];
  /** Native size parsed from the DST, mm. sizeMm / nativeLongMm is the rigid
   *  scale actually applied; outside SCALE_SAFE the UI must warn (scaling
   *  rescales real stitch lengths). */
  nativeWidthMm: number;
  nativeHeightMm: number;
  sourceName?: string;
};

export type ImageElement = ElementBase & {
  kind: "image";
  dataUrl: string;
  /** Aspect ratio (w/h) of the source image; sizeMm is the long side. */
  aspect: number;
  /** Always true: reference images never stitch. Kept explicit and serialized
   *  so nothing downstream can quietly decide otherwise. */
  referenceOnly: true;
};

export type ProjectElement = GeneratedElement | StitchFileElement | ImageElement;

/** Rigid scale range considered safe for already-encoded stitches. */
export const SCALE_SAFE = { min: 0.85, max: 1.15 };

/** The rigid scale a stitch-file element's target size implies. */
export function stitchFileScale(el: { sizeMm: number; nativeWidthMm: number; nativeHeightMm: number }): number {
  const nativeLong = Math.max(el.nativeWidthMm, el.nativeHeightMm, 0.1);
  return el.sizeMm / nativeLong;
}

// ── project ────────────────────────────────────────────────────────────────

export type Project = {
  schema: typeof PROJECT_SCHEMA_VERSION;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Monotonic revision, bumped on every persisted save. Used to detect
   *  conflicting edits from another device (never silently overwrite a
   *  project whose stored rev is newer than the one we loaded). */
  rev: number;
  hoop: { wMm: number; hMm: number };
  /** Draw order AND sew order (index 0 sews first). */
  elements: ProjectElement[];
  collection?: string;
  favorite?: boolean;
  /** Soft delete: kept, hidden from the library, recoverable. */
  deletedAt?: number;
  /** Small PNG data URL for the library grid. */
  thumbPng?: string;
};

export const DEFAULT_HOOP = { wMm: 330, hMm: 406 };

export function newProject(name = "Untitled project"): Project {
  const now = Date.now();
  return {
    schema: PROJECT_SCHEMA_VERSION,
    id: crypto.randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
    rev: 0,
    hoop: { ...DEFAULT_HOOP },
    elements: [],
  };
}

export function newElementId(): string {
  return crypto.randomUUID();
}

// ── validation + migration ─────────────────────────────────────────────────

const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string): string => (typeof v === "string" ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);

function migrateTransform(raw: unknown): ElementTransform {
  const t = (raw ?? {}) as Record<string, unknown>;
  return { xMm: num(t.xMm, 0), yMm: num(t.yMm, 0), rotDeg: num(t.rotDeg, 0) };
}

function migrateElement(raw: unknown): ProjectElement | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const base: ElementBase = {
    id: str(e.id, crypto.randomUUID()),
    name: str(e.name, "Element"),
    transform: migrateTransform(e.transform),
    sizeMm: Math.max(1, num(e.sizeMm, 100)),
    hidden: bool(e.hidden, false),
    locked: bool(e.locked, false),
  };
  if (e.flipX === true) base.flipX = true;
  if (e.flipY === true) base.flipY = true;
  switch (e.kind) {
    case "generated": {
      const params = (e.params && typeof e.params === "object" ? e.params : {}) as Record<string, ParamValue>;
      const colors = Array.isArray(e.colors) ? e.colors.filter((c): c is string => typeof c === "string") : [];
      if (typeof e.tool !== "string" || !e.tool) return null;
      return {
        ...base,
        kind: "generated",
        tool: e.tool,
        params,
        colors: colors.length ? colors : ["#26324d"],
        ...(typeof e.imageDataUrl === "string" ? { imageDataUrl: e.imageDataUrl } : {}),
      };
    }
    case "stitchfile": {
      if (typeof e.dstBase64 !== "string" || !e.dstBase64) return null;
      const colors = Array.isArray(e.colors) ? e.colors.filter((c): c is string => typeof c === "string") : [];
      const nativeW = Math.max(0.1, num(e.nativeWidthMm, base.sizeMm));
      const nativeH = Math.max(0.1, num(e.nativeHeightMm, base.sizeMm));
      return {
        ...base,
        kind: "stitchfile",
        dstBase64: e.dstBase64,
        colors: colors.length ? colors : ["#26324d"],
        nativeWidthMm: nativeW,
        nativeHeightMm: nativeH,
        ...(typeof e.sourceName === "string" ? { sourceName: e.sourceName } : {}),
      };
    }
    case "image": {
      if (typeof e.dataUrl !== "string" || !e.dataUrl) return null;
      return {
        ...base,
        kind: "image",
        dataUrl: e.dataUrl,
        aspect: Math.max(0.05, num(e.aspect, 1)),
        referenceOnly: true,
      };
    }
    default:
      return null; // unknown element kinds are dropped, never guessed at
  }
}

/**
 * Single entry point for reading a stored project of ANY schema version.
 * Unknown/corrupt elements are dropped rather than crashing the project;
 * missing fields get safe defaults. Throws only if the blob isn't a project
 * at all.
 */
export function migrateProject(raw: unknown): Project {
  if (!raw || typeof raw !== "object") throw new Error("not a project");
  const p = raw as Record<string, unknown>;
  const schema = num(p.schema, 0);
  if (schema > PROJECT_SCHEMA_VERSION) {
    // Newer than this build understands. Refuse rather than lossily rewrite.
    throw new Error(`project schema ${schema} is newer than supported (${PROJECT_SCHEMA_VERSION})`);
  }
  // v0/v1 → v1 (v0 = anything pre-versioning; same field layout with defaults)
  const elementsRaw = Array.isArray(p.elements) ? p.elements : [];
  const hoop = (p.hoop ?? {}) as Record<string, unknown>;
  const proj: Project = {
    schema: PROJECT_SCHEMA_VERSION,
    id: str(p.id, crypto.randomUUID()),
    name: str(p.name, "Untitled project"),
    createdAt: num(p.createdAt, Date.now()),
    updatedAt: num(p.updatedAt, Date.now()),
    rev: num(p.rev, 0),
    hoop: { wMm: num(hoop.wMm, DEFAULT_HOOP.wMm), hMm: num(hoop.hMm, DEFAULT_HOOP.hMm) },
    elements: elementsRaw.map(migrateElement).filter((e): e is ProjectElement => e !== null),
  };
  if (typeof p.collection === "string" && p.collection) proj.collection = p.collection;
  if (p.favorite === true) proj.favorite = true;
  if (typeof p.deletedAt === "number") proj.deletedAt = p.deletedAt;
  if (typeof p.thumbPng === "string") proj.thumbPng = p.thumbPng;
  return proj;
}

export function serializeProject(p: Project): string {
  return JSON.stringify(p);
}

export function deserializeProject(json: string): Project {
  return migrateProject(JSON.parse(json));
}

// ── composition: elements → one stitch stream ──────────────────────────────

/** Rigid transform (rotate then translate, optional uniform scale) applied to
 *  stitches in 0.1 mm units. Rotation/translation never change stitch lengths;
 *  scale is only used for stitch-file elements, within SCALE_SAFE ideally. */
export function transformStitches(
  stitches: Stitch[],
  t: ElementTransform,
  scale = 1,
): Stitch[] {
  const rad = (t.rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const dx = t.xMm * 10, dy = t.yMm * 10;
  return stitches.map((s) => ({
    x: (s.x * cos - s.y * sin) * scale + dx,
    y: (s.x * sin + s.y * cos) * scale + dy,
    cmd: s.cmd,
  }));
}

export type ElementStitches = {
  elementId: string;
  /** Element-local stitches, centered on the element origin (0.1 mm units). */
  stitches: Stitch[];
  colors: string[];
};

export type ComposedBlock = { elementId: string; color: string };

export type Composed = {
  stitches: Stitch[];
  /** Hex per color block, in sew order. */
  colors: string[];
  /** Which element produced each block (for highlighting / sew-order UI). */
  blocks: ComposedBlock[];
};

/** Split element-local stitches into per-color-block runs. */
function splitBlocks(stitches: Stitch[]): Stitch[][] {
  const out: Stitch[][] = [];
  let cur: Stitch[] = [];
  for (const s of stitches) {
    if (s.cmd === CMD.COLOR_CHANGE || s.cmd === CMD.STOP) {
      if (cur.length) out.push(cur);
      cur = [];
      continue; // block boundary markers are re-inserted by compose
    }
    if (s.cmd === CMD.END) continue;
    cur.push(s);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Compose visible, stitchable elements into one machine-ready stream:
 * per-element stitches are rigidly transformed into hoop space, joined in
 * element order with COLOR_CHANGE between blocks, a JUMP opening each block,
 * and a single END. Hidden elements and reference images contribute nothing
 * (callers simply don't pass them).
 */
export function composeProject(
  project: Project,
  generated: Map<string, ElementStitches>,
): Composed {
  const stitches: Stitch[] = [];
  const colors: string[] = [];
  const blocks: ComposedBlock[] = [];

  for (const el of project.elements) {
    if (el.hidden || el.kind === "image") continue;
    const built = generated.get(el.id);
    if (!built || built.stitches.length === 0) continue;
    const scale = el.kind === "stitchfile" ? stitchFileScale(el) : 1;
    const placed = transformStitches(built.stitches, el.transform, scale);
    const parts = splitBlocks(placed);
    parts.forEach((part, i) => {
      if (part.length === 0) return;
      if (stitches.length > 0) {
        // new color block: color change at the current position
        const prev = stitches[stitches.length - 1];
        stitches.push({ x: prev.x, y: prev.y, cmd: CMD.COLOR_CHANGE });
      }
      // travel to the block start without sewing
      stitches.push({ x: part[0].x, y: part[0].y, cmd: CMD.JUMP });
      stitches.push(...part);
      colors.push(built.colors[Math.min(i, built.colors.length - 1)] ?? "#26324d");
      blocks.push({ elementId: el.id, color: colors[colors.length - 1] });
    });
  }

  if (stitches.length) {
    const last = stitches[stitches.length - 1];
    stitches.push({ x: last.x, y: last.y, cmd: CMD.END });
  }
  return { stitches, colors, blocks };
}

/** Bounds of element-local stitches after transform, in mm. */
export function elementBoundsMm(
  built: Stitch[],
  t: ElementTransform,
  scale = 1,
): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const rad = (t.rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  for (const s of built) {
    if (s.cmd !== CMD.STITCH && s.cmd !== CMD.JUMP) continue;
    const x = (s.x * cos - s.y * sin) * scale + t.xMm * 10;
    const y = (s.x * sin + s.y * cos) * scale + t.yMm * 10;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (minX === Infinity) return null;
  return { x: minX / 10, y: minY / 10, w: (maxX - minX) / 10, h: (maxY - minY) / 10 };
}
