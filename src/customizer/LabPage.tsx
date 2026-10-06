import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiBase, saveBlob } from "../stitchlab/lib/native";
import { GARMENTS } from "../data/garments";
import { THREADS, THREAD_FAMILIES } from "../data/threads";
import { STAFF_LAB_GARMENTS } from "./staffLabGarments";
import { SHAPE_LIBRARY } from "./shapeLibrary";
import { EFFECTS, applyEffect } from "./effects";
import {
  GENERATORS,
  TEXT_STYLES,
  renderText,
  cleanDrawing,
  runGenerator,
  runTypeGenerator,
  type GeneratorId,
  type TextStyle,
} from "./generators";
import LabToolbox from "./LabToolbox";
import {
  clearAllLocal,
  clearDraft,
  deleteIdea,
  getDraft,
  listIdeas,
  putDraft,
  putIdea,
  type Idea,
  type IdeaThread,
  type SavedPlacement,
  type SavedUpload,
} from "./labdb";
import { smallIslandWarnings, traceToSvg } from "./trace";
import {
  attributionLine,
  categoriesOf,
  searchAssets,
  type LibraryAsset,
  type LibrarySource,
} from "./assetlib";

// Customizer Lab - internal studio tool for ideation and production planning.
// Studio: upload artwork, place/scale/flip/recolor/blend on real blanks.
// Pipeline: saved ideas, collections, and a per-brand order plan.
// Sign in (email code) to sync ideas + a design library across devices and
// unlock the staff-only visualization blanks.

const LABEL =
  "text-[0.6875rem] tracking-[0.14em] uppercase text-dim font-medium";
const FIELD =
  "w-full bg-bg border border-hairline px-3 py-2 text-[0.875rem] text-fg placeholder:text-dim outline-none focus:border-fg";

// ── unified Lab garment model (studio blanks + staff-only vendor blanks) ──

type LabColor = { slug: string; name: string; hex: string; front: string; back?: string };
// Recommended embroidery zones - VISUAL GUIDES ONLY. Never snapped to,
// never placed from, never exported (DOM overlay only; composite() knows
// nothing about them). x/y are the zone CENTER as fractions of the garment
// photo, width/height are fractional spans - same space as placements.
type EmbroideryZone = {
  id: string;
  label: string;
  view: "front" | "back";
  x: number;
  y: number;
  width: number;
  height: number;
};

type LabGarment = {
  id: string;
  label: string;
  sub: string; // brand / source line
  spec: string; // objective facts only
  colors: LabColor[];
  staffOnly: boolean;
  orderable: boolean;
  defaultCost: number; // wholesale blank cost - surfaces only in the staff order plan
  colorCosts?: Record<string, number>; // per-color-slug exceptions (pigment dyes)
  brand: string;
  widthIn?: number; // laid-flat garment width - scales placements (default 24)
  embroideryZones?: EmbroideryZone[]; // per-garment tuned guides (else generic)
};

// Blank costs per Jacob, Jul 2026. A defaultCost of 0 means "price unknown,
// fill it in on the order plan" - IND420ZIP has no confirmed source price yet.
const SPECS: Record<
  string,
  {
    label: string;
    spec: string;
    defaultCost: number;
    brand?: string;
    colorCosts?: Record<string, number>;
    widthIn?: number;
  }
> = {
  beanie: {
    label: "Beanie",
    spec: "Cuffed knit beanie · one size · embroidery sits on the cuff",
    defaultCost: 0,
    widthIn: 10.5, // a beanie is ~10.5\" laid flat, not 24 - keeps inches honest
  },
  "independent-trading-co-eightpointfiveounce": {
    label: "Midweight Hoodie",
    spec: "IND280SL · 8.5 oz / 280 gsm 3-end fleece · 80/20 cotton-poly · classic fit",
    defaultCost: 12.75,
    colorCosts: { pigmentblack: 17.25 },
  },
  "independent-trading-co-ind420": {
    label: "Heavyweight Hoodie",
    spec: "IND420 · 12.5 oz / 420 gsm 3-end fleece · 75/25 cotton-poly · boxy fit",
    defaultCost: 17,
    colorCosts: { pigmentblack: 22 },
  },
  "independent-trading-co-ind280zip": {
    label: "Midweight Zip Hoodie",
    spec: "Avenue 280 gsm zip hood · 8.5 oz 3-end fleece · full zip",
    defaultCost: 15.25,
    brand: "Avenue",
  },
  "independent-trading-co-ind420zip": {
    label: "Heavyweight Zip Hoodie",
    spec: "IND420ZIP · 12.5 oz / 420 gsm 3-end fleece · 75/25 cotton-poly · boxy fit · full zip",
    defaultCost: 0,
  },
  "la-apparel-hf09": {
    label: "LA Apparel Heavy Fleece",
    spec: "HF-09 · 14 oz heavy fleece · 100% cotton · made in Los Angeles",
    defaultCost: 41,
  },
  "la-apparel-mineralwash-hf09": {
    label: "LA Apparel Mineral Wash",
    spec: "HF-09 MW · 14 oz heavy fleece · 100% cotton · mineral-washed finish",
    defaultCost: 42,
  },
  // LAA vendor drop, Jul 2026 - costs TODO with Jacob (0 = fill in on order plan)
  "laa-fleece-shorts": {
    label: "Fleece Shorts",
    spec: "LA Apparel 12 oz fleece shorts · garment-dyed",
    defaultCost: 0,
    widthIn: 22,
  },
  "laa-dripdye-hood": {
    label: "Drip Dye Hood",
    spec: "LA Apparel 14 oz heavy fleece hood · drip-dye finish",
    defaultCost: 0,
  },
  "laa-dripdye-crew": {
    label: "Drip Dye Crew",
    spec: "LA Apparel 14 oz heavy fleece crew · drip-dye finish",
    defaultCost: 0,
  },
  "laa-1801gd": {
    label: "Garment-Dyed Tee",
    spec: "LA Apparel 1801GD · 6.5 oz heavy jersey · garment-dyed · front + back",
    defaultCost: 0,
    widthIn: 22,
  },
  "laa-1801mw": {
    label: "Mineral Wash Tee",
    spec: "LA Apparel 1801MW · 6.5 oz heavy jersey · mineral-washed · front + back",
    defaultCost: 0,
    widthIn: 22,
  },
  "laa-tote": {
    label: "Bull Denim Tote",
    spec: "LA Apparel bull denim tote bag · made in Los Angeles",
    defaultCost: 0,
    widthIn: 14,
  },
  "laa-gym-bag": {
    label: "Gym Bag",
    spec: "LA Apparel diagonal-strap gym bag · bull denim",
    defaultCost: 0,
    widthIn: 20,
  },
  "laa-zip-14oz": {
    label: "Heavy Fleece Zip",
    spec: "LA Apparel 14 oz heavy fleece · full zip",
    defaultCost: 0,
  },
  "laa-thermal-shorts": {
    label: "Thermal Shorts",
    spec: "LA Apparel heavy thermal shorts · garment-dyed",
    defaultCost: 0,
    widthIn: 22,
  },
};

// wholesale cost for a specific colorway (pigment dyes cost more)
const costFor = (g: LabGarment, colorSlug: string) =>
  g.colorCosts?.[colorSlug] ?? g.defaultCost;

const STUDIO_GARMENTS: LabGarment[] = GARMENTS.filter((g) => g.colors.length > 0).map(
  (g) => ({
    id: g.id,
    label: SPECS[g.id]?.label ?? g.name,
    sub: [SPECS[g.id]?.brand ?? g.brand, g.weight, `${g.colors.length} colors`]
      .filter(Boolean)
      .join(" · "),
    spec: SPECS[g.id]?.spec ?? [g.weight, g.composition].filter(Boolean).join(" · "),
    colors: g.colors.map((c) => ({
      slug: c.slug,
      name: c.name,
      hex: c.hex,
      front: c.imageFront,
      back: c.imageBack,
    })),
    staffOnly: false,
    orderable: true,
    defaultCost: SPECS[g.id]?.defaultCost ?? g.blankCost ?? 0,
    colorCosts: SPECS[g.id]?.colorCosts,
    brand: SPECS[g.id]?.brand ?? g.brand,
    widthIn: SPECS[g.id]?.widthIn,
  })
);

// The vendor-mockup blanks. Hoodie/crew/tee are priced against Gildan blanks
// (the tee photos are Alstyle 1501s, discontinued - Gildan is the stand-in
// source). Sweatpants have no blank source yet, so no pricing.
const STAFF_SPECS: Record<
  string,
  { label: string; spec: string; orderable: boolean; defaultCost: number; brand: string }
> = {
  "staff-hoodie": {
    label: "Gildan Hoodie",
    spec: "Gildan heavy blend fleece hoodie · 50/50 cotton-poly",
    orderable: true,
    defaultCost: 10.5,
    brand: "Gildan",
  },
  "staff-sweatshirt": {
    label: "Gildan Crew",
    spec: "Gildan heavy blend crewneck · 50/50 cotton-poly",
    orderable: true,
    defaultCost: 8,
    brand: "Gildan",
  },
  "staff-tshirt": {
    label: "T-Shirt",
    spec: "Alstyle 1501 silhouette (discontinued) · sourced + priced as Gildan tee",
    orderable: true,
    defaultCost: 3,
    brand: "Gildan",
  },
  "staff-sweatpants": {
    label: "Sweatpants",
    spec: "Vendor mockup blank · no blank source yet · visualization only",
    orderable: false,
    defaultCost: 0,
    brand: "Vendor blanks",
  },
};

const STAFF_GARMENTS: LabGarment[] = STAFF_LAB_GARMENTS.map((g) => {
  const s = STAFF_SPECS[g.id];
  return {
    id: g.id,
    label: s?.label ?? g.label,
    sub: `${s?.brand ?? "Vendor blank"} · ${g.colors.length} colors · front + back`,
    spec: s?.spec ?? "Vendor mockup blank",
    colors: g.colors,
    staffOnly: true,
    orderable: s?.orderable ?? false,
    defaultCost: s?.defaultCost ?? 0,
    brand: s?.brand ?? "Vendor blanks",
  };
});

const garmentById = (id: string) =>
  [...STUDIO_GARMENTS, ...STAFF_GARMENTS].find((g) => g.id === id);

// garment fills ~70% of the photo width; widthIn converts inches → fraction
const inchFraction = (g: { widthIn?: number }) => 0.7 / (g.widthIn ?? 24);
const MIN_IN = 0.5;
const MAX_IN = 16;
const BOUNDS = { minX: 0.05, maxX: 0.95, minY: 0.03, maxY: 0.97 };

// ── per-garment print areas ────────────────────────────────────────────────
// The usable decoration zone per garment side, as fractions of the photo
// (x/y = zone center, w/h = span - the same space as placements). Drives
// where new designs land, how placements translate when switching garments,
// and the dashed guide shown while a design is selected. Dragging anywhere
// stays allowed - this steers, it never restricts.
type PrintArea = { x: number; y: number; w: number; h: number };
const AREA_TOP_FRONT: PrintArea = { x: 0.5, y: 0.42, w: 0.44, h: 0.36 };
const AREA_TOP_BACK: PrintArea = { x: 0.5, y: 0.4, w: 0.46, h: 0.42 };
// zip-front garments: default to the left-chest panel (viewer right) so
// nothing lands across the zipper; drag across it deliberately if you want
const AREA_ZIP_FRONT: PrintArea = { x: 0.63, y: 0.4, w: 0.2, h: 0.24 };
const PRINT_AREAS: Record<string, { front: PrintArea; back?: PrintArea }> = {
  "laa-tote": { front: { x: 0.5, y: 0.63, w: 0.52, h: 0.34 } }, // below the handles
  "laa-gym-bag": { front: { x: 0.5, y: 0.58, w: 0.46, h: 0.3 } },
  beanie: { front: { x: 0.5, y: 0.66, w: 0.42, h: 0.2 } }, // the cuff
  "laa-fleece-shorts": {
    front: { x: 0.62, y: 0.5, w: 0.2, h: 0.24 }, // leg panel, off the center seam
    back: { x: 0.62, y: 0.48, w: 0.22, h: 0.26 },
  },
  "laa-thermal-shorts": {
    front: { x: 0.62, y: 0.5, w: 0.2, h: 0.24 },
    back: { x: 0.62, y: 0.48, w: 0.22, h: 0.26 },
  },
  "staff-sweatpants": { front: { x: 0.52, y: 0.38, w: 0.2, h: 0.24 } }, // thigh
  "independent-trading-co-ind280zip": { front: AREA_ZIP_FRONT, back: AREA_TOP_BACK },
  "independent-trading-co-ind420zip": { front: AREA_ZIP_FRONT, back: AREA_TOP_BACK },
  "laa-zip-14oz": { front: AREA_ZIP_FRONT, back: AREA_TOP_BACK },
};
function printAreaFor(g: { id: string }, view: "front" | "back"): PrintArea {
  const entry = PRINT_AREAS[g.id];
  if (entry) return view === "back" ? entry.back ?? entry.front : entry.front;
  return view === "back" ? AREA_TOP_BACK : AREA_TOP_FRONT;
}
/** Largest design (inches) that fits the area's width on this garment
 *  (a placement's width fraction is inches * 0.7 / widthIn). */
function areaMaxInches(g: { widthIn?: number }, area: PrintArea): number {
  return Math.max(1, (area.w * (g.widthIn ?? 24)) / 0.7 * 0.92);
}
const API = `${apiBase()}/api/lab`;

type Upload = SavedUpload & { url: string };
type Placement = SavedPlacement & { view: "front" | "back" };
type LabFont = { name: string; family: string; dataURL: string };

// ── youth/facility policy ────────────────────────────────────────────────
// One typed object per mode instead of `youth ?` ternaries scattered through
// the component. A facility-specific configuration edits THIS, not the JSX.
type LabPolicy = {
  presetShapes: boolean; // studio silhouette library
  photoRemoval: boolean; // remove.bg photo cutouts (proxied via /api/removebg)
  toolbox: boolean; // Are.na creative-resources tab (external links)
  requireAccount: boolean; // block the studio until signed in
  purgeOnSignOut: boolean; // shared devices: wipe local work on sign-out
  idleTimeoutMs: number | null; // auto sign-out after inactivity
  onboardKey: string; // localStorage key for walkthrough completion
};
const LAB_POLICY: LabPolicy = {
  presetShapes: true,
  photoRemoval: true,
  toolbox: true,
  requireAccount: false,
  purgeOnSignOut: false,
  idleTimeoutMs: null,
  onboardKey: "bayside-lab-onboarded",
};
const YOUTH_POLICY: LabPolicy = {
  presetShapes: false, // library holds weapons/police imagery - their own art is the point
  photoRemoval: true, // kept per program need; requires a signed-in session server-side
  toolbox: false, // no external link surface in the facility edition
  requireAccount: true, // every mockup traces to a student account
  purgeOnSignOut: true,
  idleTimeoutMs: 30 * 60 * 1000,
  onboardKey: "bayside-makers-onboarded",
};
const OWNER_KEY = "bayside-lab-owner"; // which account the local store belongs to

// Typical small-shop decoration cost ranges for the youth cost explorer.
// PLACEHOLDER RANGES - Jacob: replace with real studio numbers. Setup is
// one-time per design; piece is per garment decorated.
const COST_METHODS = {
  vinyl: {
    label: "Heat-transfer vinyl",
    setupLo: 0,
    setupHi: 10,
    pieceLo: 5,
    pieceHi: 10,
    how: "No screens or files to prepare - cost is vinyl material plus the time to cut, weed, and press each piece. Simple designs press fast; lots of tiny pieces take longer.",
  },
  screen: {
    label: "Screen printing",
    setupLo: 25,
    setupHi: 50,
    pieceLo: 3,
    pieceHi: 8,
    how: "Each color needs its own screen burned once (the setup). After that, every print is fast and cheap - which is why bigger runs cost so much less per piece.",
  },
  embroidery: {
    label: "Embroidery",
    setupLo: 20,
    setupHi: 60,
    pieceLo: 8,
    pieceHi: 15,
    how: "The design is digitized once into a stitch file (the setup). Per-piece cost follows stitch count - a small chest logo stitches quickly, a full back takes machine-hours.",
  },
} as const;

// Curated Bayside library - the primary picker. Mac/iOS ship most of these;
// elsewhere they fall back to the browser's serif/sans equivalents.
const DEFAULT_FONTS = [
  "Georgia",
  "Times New Roman",
  "Baskerville",
  "Palatino",
  "Playfair Display",
  "EB Garamond",
  "American Typewriter",
  "Courier New",
  "Helvetica Neue",
  "Arial",
  "DM Sans",
  "Futura",
  "Gill Sans",
  "Optima",
  "Impact",
  "Marker Felt",
];

// Open-source display library, served from Google Fonts (already in the CSP
// and the facility allow-list). One stylesheet request; WOFF2 files load
// lazily per family as they're actually used.
const GOOGLE_FONTS: { group: string; families: string[] }[] = [
  {
    group: "Bold & blocky",
    families: ["Anton", "Archivo Black", "Bebas Neue", "Alfa Slab One", "Righteous", "Russo One", "Bangers", "Luckiest Guy", "Titan One", "Passion One"],
  },
  {
    group: "Clean",
    families: ["Inter", "Montserrat", "Poppins", "Oswald", "Raleway", "Work Sans", "Barlow Condensed"],
  },
  {
    group: "Serif & classic",
    families: ["Abril Fatface", "Cinzel", "Cormorant Garamond", "Libre Baskerville", "Merriweather", "DM Serif Display"],
  },
  {
    group: "Script & hand",
    families: ["Pacifico", "Lobster", "Dancing Script", "Caveat", "Permanent Marker", "Rock Salt", "Satisfy", "Great Vibes", "Amatic SC", "Shadows Into Light"],
  },
  {
    group: "Decorative",
    families: ["Monoton", "Rye", "Special Elite", "Press Start 2P", "Orbitron", "Audiowide", "Bungee", "Fredericka the Great"],
  },
  { group: "Mono", families: ["Space Mono", "IBM Plex Mono"] },
];
const GOOGLE_FONT_FAMILIES = GOOGLE_FONTS.flatMap((g) => g.families);

// System-font access exists only in Chromium (queryLocalFonts) - everywhere
// else the control is hidden rather than left to fail silently.
const SYSTEM_FONTS_SUPPORTED =
  typeof window !== "undefined" && "queryLocalFonts" in window;

const fontFamilyFor = (fileName: string) =>
  "lab-" + fileName.replace(/\.(otf|ttf|woff2?)$/i, "").replace(/[^a-zA-Z0-9]+/g, "-");

const capturePointer = (e: { target: EventTarget | null; pointerId: number }) => {
  try {
    (e.target as Element)?.setPointerCapture?.(e.pointerId);
  } catch {
    /* capture is best-effort */
  }
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const uid = () => Math.random().toString(36).slice(2, 9);

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });

// (the old collapsible <Section> accordion was replaced by the desktop tool
// cards - see the controls column in the studio layout)

// ── mobile studio: fixed editor shell (canvas / secondary row / drawer /
//    primary tab bar), modeled on mobile photo editors ────────────────────

type SheetId =
  | "blanks"
  | "designs"
  | "shapes"
  | "generators"
  | "text"
  | "artlib"
  | "save"
  | "design";

type TabId = "blanks" | "designs" | "artlib" | "text" | "generators" | "save";

const MOBILE_TABS: { id: TabId; label: string; icon: SheetId; aria: string }[] = [
  { id: "blanks", label: "Blanks", icon: "blanks", aria: "Blanks - garment and color" },
  { id: "designs", label: "Designs", icon: "designs", aria: "Designs - upload, your library, studio designs" },
  { id: "artlib", label: "Find art", icon: "artlib", aria: "Find art - free public-domain and openly licensed images" },
  { id: "text", label: "Text", icon: "text", aria: "Text tool" },
  { id: "generators", label: "Shapes", icon: "generators", aria: "Shapes - playful generated designs" },
  { id: "save", label: "Save", icon: "save", aria: "Save idea" },
];

const toolIcon = (d: string) => (
  <svg
    viewBox="0 0 24 24"
    className="w-5 h-5"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);

const PANEL_ICONS: Record<SheetId, React.ReactNode> = {
  blanks: toolIcon(
    "M16 3a4 4 0 0 1-8 0L3.5 4.8a1.5 1.5 0 0 0-.9 1.9l1.1 3a1 1 0 0 0 1.2.6L7 9.7V20a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9.7l2.1.6a1 1 0 0 0 1.2-.6l1.1-3a1.5 1.5 0 0 0-.9-1.9L16 3Z"
  ),
  designs: toolIcon(
    "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm6 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm12 6-4.6-4.6a2 2 0 0 0-2.8 0L5 19"
  ),
  shapes: toolIcon(
    "M12 2.5l2.6 5.7 6.2.7-4.6 4.2 1.2 6.1-5.4-3-5.4 3 1.2-6.1L3.2 8.9l6.2-.7L12 2.5Z"
  ),
  generators: toolIcon(
    "M8 9.5a3.5 3.5 0 1 0 .01 0M13.5 5.5h5.5v5.5h-5.5zM4.5 17.5c1.6-2.2 3.2-2.2 4.8 0s3.2 2.2 4.8 0 3.2-2.2 4.8 0"
  ),
  text: toolIcon("M5 7V5h14v2M12 5v14M9.5 19h5"),
  save: toolIcon("M18 21l-6-3.5L6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16Z"),
  design: toolIcon(
    "M4 6h9M17 6h3M17 4v4M4 12h3M11 12h9M11 10v4M4 18h13M17 16v4M20 18h.5"
  ),
  artlib: (
    <span aria-hidden="true" className="text-[1.0625rem] leading-none">◫</span>
  ),
};

// small stroke icons for each motif style - hand shapes, no AI sparkle
const MOTIF_ICONS: Record<string, React.ReactNode> = {
  blob: toolIcon(
    "M12 4.5c2.8-.4 5.6.8 6.4 3.2s-.3 4.6-1.6 6.6-3.2 3.9-5.8 3.6-4.9-2-5.6-4.5.1-5 1.9-6.7 2.7-1.9 4.7-2.2Z"
  ),
  burst: toolIcon(
    "M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4M5.2 5.2l2.8 2.8M16 16l2.8 2.8M18.8 5.2 16 8M8 16l-2.8 2.8"
  ),
  badge: toolIcon(
    "M12 3.5l1.7 1.2 2-.5 1 1.8 2 .5v2l1.5 1.5-.7 1.9.7 1.9-1.5 1.5v2l-2 .5-1 1.8-2-.5-1.7 1.2-1.7-1.2-2 .5-1-1.8-2-.5v-2l-1.5-1.5.7-1.9-.7-1.9 1.5-1.5v-2l2-.5 1-1.8 2 .5L12 3.5ZM12 9.5a2.5 2.5 0 1 0 .01 0"
  ),
  rings: toolIcon("M12 4a8 8 0 1 0 .01 0M12 8.5a3.5 3.5 0 1 0 .01 0"),
  waves: toolIcon(
    "M3.5 9c1.7-2.4 3.4-2.4 5.1 0s3.4 2.4 5.1 0 3.4-2.4 5.1 0M3.5 15c1.7-2.4 3.4-2.4 5.1 0s3.4 2.4 5.1 0 3.4-2.4 5.1 0"
  ),
  scribble: toolIcon("M5 16c1.5-6 4.5-9 6-6.5s-3 8 0 8 5.5-7 8-5.5"),
  dots: toolIcon(
    "M6 6a1.3 1.3 0 1 0 .01 0M12 6a1.3 1.3 0 1 0 .01 0M18 6a1.3 1.3 0 1 0 .01 0M6 12a1.3 1.3 0 1 0 .01 0M12 12a1.3 1.3 0 1 0 .01 0M18 12a1.3 1.3 0 1 0 .01 0M6 18a1.3 1.3 0 1 0 .01 0M12 18a1.3 1.3 0 1 0 .01 0M18 18a1.3 1.3 0 1 0 .01 0"
  ),
  star: toolIcon(
    "M12 3.5l2.2 4.9 5.3.6-4 3.6 1.1 5.2L12 15.2l-4.6 2.6 1.1-5.2-4-3.6 5.3-.6L12 3.5Z"
  ),
  flower: toolIcon(
    "M12 12a2 2 0 1 0 .01 0M12 6.5a2 2 0 1 0 .01 0M12 17.5a2 2 0 1 0 .01 0M6.5 12a2 2 0 1 0 .01 0M17.5 12a2 2 0 1 0 .01 0"
  ),
  spiral: toolIcon(
    "M12 12.5a1.5 1.5 0 0 0 3 0c0-2-1.8-3.5-3.8-3.3S7.5 11.5 7.7 14s2.5 4.4 5.3 4.2 5.5-2.7 5.5-6-2.6-6.7-6.5-6.7"
  ),
  zigzag: toolIcon("M3.5 14.5 7 9.5l3.5 5 3.5-5 3.5 5 3-4.5"),
  frame: toolIcon("M4.5 4.5h15v15h-15zM8 8h8v8H8z"),
  arch: toolIcon("M4.5 19.5v-7a7.5 7.5 0 0 1 15 0v7M8 19.5v-7a4 4 0 0 1 8 0v7"),
  grid: toolIcon("M4 9h16M4 15h16M9 4v16M15 4v16"),
  paisley: toolIcon(
    "M9 20c-4 0-6-3.5-4.5-7S11 7 11 3.5c4 1 6 5 4 8.5s-6 3-5.5-.5"
  ),
  wreath: toolIcon(
    "M12 4a8 8 0 0 0-3 15.4M12 4a8 8 0 0 1 3 15.4M9 8.5l-1.5 1M9 12l-1.5 1M15 8.5l1.5 1M15 12l1.5 1"
  ),
  bolt: toolIcon("M13 2.5 5.5 13H10l-2 8.5L15.5 11H11l2-8.5Z"),
  heart: toolIcon(
    "M12 20s-7.2-4.6-8.6-9C2.2 7.4 4.3 5 7 5c2 0 3.6 1.1 5 3.1C13.4 6.1 15 5 17 5c2.7 0 4.8 2.4 3.6 6-1.4 4.4-8.6 9-8.6 9Z"
  ),
  moon: toolIcon("M19.5 14A8.5 8.5 0 0 1 10 4.5 8.5 8.5 0 1 0 19.5 14Z"),
  eye: toolIcon(
    "M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12ZM12 9.6a2.4 2.4 0 1 0 .01 0"
  ),
  flame: toolIcon(
    "M12 21.5c-3.9 0-6.5-2.6-6.5-6 0-2.7 1.7-4.6 3.1-6.4C9.8 7.6 10.3 5.4 10 3c3.2 1.4 4.6 4 4.2 6.4 1-.5 1.8-1.4 2.3-2.8 1.5 2 2 4.3 2 6.9 0 3.4-2.6 6-6.5 6Z"
  ),
  smiley: toolIcon(
    "M12 3a9 9 0 1 0 .01 0M8.6 9.8a.9.9 0 1 0 .01 0M15.4 9.8a.9.9 0 1 0 .01 0M8 14.3c1 1.5 2.4 2.3 4 2.3s3-.8 4-2.3"
  ),
  orbit: toolIcon(
    "M12 9.6a2.4 2.4 0 1 0 .01 0M12 8.2c5 0 9 1.7 9 3.8s-4 3.8-9 3.8-9-1.7-9-3.8 4-3.8 9-3.8Z"
  ),
  arrow: toolIcon("M4 20 20 4M20 4h-6.5M20 4v6.5M4 20l1.2-5.2M4 20l5.2-1.2"),
  fruit: toolIcon(
    "M8.8 14a3.1 3.1 0 1 0 .01 0M15.8 15.3a3.1 3.1 0 1 0 .01 0M8.8 14c.2-4 2.2-7 5.2-9M15.8 15.3C15.3 11 14.6 8 14 5M14 5c1.6-1.2 3.6-1.2 5.2.3"
  ),
  compass: toolIcon("M12 2.5 14 10l7.5 2L14 14l-2 7.5L10 14l-7.5-2L10 10 12 2.5Z"),
  constellation: toolIcon(
    "M4.5 18.5l4.5-4 5 2 5.5-8.5M4.5 18.5a1 1 0 1 0 .01 0M9 14.5a1 1 0 1 0 .01 0M14 16.5a1 1 0 1 0 .01 0M19.5 8a1 1 0 1 0 .01 0"
  ),
  chain: toolIcon(
    "M6.8 8.8h4.4a3.2 3.2 0 0 1 0 6.4H6.8a3.2 3.2 0 0 1 0-6.4ZM12.8 8.8h4.4a3.2 3.2 0 0 1 0 6.4h-4.4"
  ),
  dither: toolIcon(
    "M5 5a1.6 1.6 0 1 0 .01 0M11 5a1.6 1.6 0 1 0 .01 0M17 5a1.2 1.2 0 1 0 .01 0M5 11a1.6 1.6 0 1 0 .01 0M11 11a1.2 1.2 0 1 0 .01 0M17 11a.8.8 0 1 0 .01 0M5 17a1.2 1.2 0 1 0 .01 0M11 17a.8.8 0 1 0 .01 0M17 17a.5.5 0 1 0 .01 0"
  ),
  pixelframe: toolIcon(
    "M4 4h3v3H4zM10.5 4h3v3h-3zM17 4h3v3h-3zM4 10.5h3v3H4zM17 10.5h3v3h-3zM4 17h3v3H4zM10.5 17h3v3h-3zM17 17h3v3h-3z"
  ),
  oswindow: toolIcon("M4 5h16v14H4zM4 9h16M17.5 7h.01M14.5 7h.01M6.5 7h4"),
  wireship: toolIcon(
    "M12 3c2.2 2.4 3 6.2 3 10h-6c0-3.8.8-7.6 3-10ZM9 13l-2.5 4.5M15 13l2.5 4.5M10.5 15.5l.5 4M13.5 15.5l-.5 4M12 8.5a1.3 1.3 0 1 0 .01 0"
  ),
  mosaic: toolIcon("M4 4h6v6H4zM12 4h8v4h-8zM4 12h4v8H4zM10 12h10v8H10z"),
  type: toolIcon("M6.5 8V6h11v2M12 6v12M9.5 18h5"),
};

export default function LabPage({ youth = false }: { youth?: boolean } = {}) {
  const policy = youth ? YOUTH_POLICY : LAB_POLICY;
  const [tab, setTab] = useState<"studio" | "pipeline" | "costs" | "toolbox" | "overview">(
    "studio"
  );
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const refreshIdeas = () => listIdeas().then(setIdeas).catch(() => {});
  useEffect(() => {
    refreshIdeas();
  }, []);

  // ── auth + sync ──────────────────────────────────────────────────────
  const [authToken, setAuthToken] = useState<string | null>(() => {
    try {
      return localStorage.getItem("bayside-lab-token");
    } catch {
      return null;
    }
  });
  const [authEmail, setAuthEmail] = useState<string | null>(() => {
    try {
      return localStorage.getItem("bayside-lab-email");
    } catch {
      return null;
    }
  });
  const [loginEmail, setLoginEmail] = useState("");
  const [loginCode, setLoginCode] = useState("");
  const [loginStage, setLoginStage] = useState<"idle" | "busy">("idle");
  const [authView, setAuthView] = useState<"signin" | "signup" | "code" | "reset" | "resetcode">("signin");
  const [loginPassword, setLoginPassword] = useState("");
  const [codeNote, setCodeNote] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [showLogin, setShowLogin] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const signOutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [library, setLibrary] = useState<SavedUpload[]>([]);
  const [fonts, setFonts] = useState<LabFont[]>([]);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fontSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ids of ideas deleted locally but not yet confirmed to the server. The
  // server merges ideas by id (so a create on another device isn't clobbered),
  // which means a delete must be sent explicitly or it would resurrect. Cleared
  // once a save that carried them succeeds.
  const pendingDeletes = useRef<Set<string>>(new Set());
  // once true, we've told the user their content is too large to sync (so we
  // don't nag on every autosave); reset when they next sign in
  const sizeWarned = useRef(false);
  // showNotice is declared later; the sync helpers reach it through this ref
  // (assigned in an effect below) to avoid a forward reference.
  const showNoticeRef = useRef<(m: string) => void>(() => {});
  // visible save state: local writes always land first (IndexedDB), then the
  // debounced account sync reports honestly - never claim "synced" on faith
  const [syncState, setSyncState] = useState<"idle" | "saving" | "synced" | "local">("idle");
  // HARD gate on pushing to the account: false from the moment a session
  // token appears until the post-sign-in load (and its owner check) has
  // finished. Without this, the autosave/sync debounce can race the owner
  // wipe and push the PREVIOUS account's local ideas into the new account.
  const syncReady = useRef(false);

  // staff → pipeline/queue/cost planning; admin → Overview tab (user grants)
  const [role, setRole] = useState<{ staff: boolean; admin: boolean }>(() => {
    try {
      return JSON.parse(localStorage.getItem("bayside-lab-role") || "") as {
        staff: boolean;
        admin: boolean;
      };
    } catch {
      return { staff: false, admin: false };
    }
  });
  // The preset silhouette library is a STAFF bench everywhere now: the youth
  // edition never ships it (weapons imagery in the set), and the public /lab
  // keeps students'/clients' focus on their own artwork. Staff still browse it.
  const presetsVisible = policy.presetShapes && (role.staff || role.admin);
  const SHAPES_AVAILABLE = presetsVisible ? SHAPE_LIBRARY : [];

  const applyRole = (staff: boolean, admin: boolean) => {
    setRole({ staff, admin });
    try {
      localStorage.setItem("bayside-lab-role", JSON.stringify({ staff, admin }));
    } catch {
      /* ignore */
    }
  };

  // load the Google Fonts library stylesheet once (font files fetch lazily)
  useEffect(() => {
    const id = "lab-google-fonts";
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?" +
      GOOGLE_FONT_FAMILIES.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}`).join("&") +
      "&display=swap";
    document.head.appendChild(link);
  }, []);

  // register account fonts with the document so canvas + previews can use them
  useEffect(() => {
    for (const f of fonts) {
      const face = new FontFace(f.family, `url(${f.dataURL})`);
      face
        .load()
        .then((ff) => document.fonts.add(ff))
        .catch(() => {});
    }
  }, [fonts]);

  const api = async (payload: Record<string, unknown>) => {
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Request failed");
    return json;
  };

  // distinguish an over-the-size-limit rejection (content won't sync until it's
  // trimmed - the user needs to know) from ordinary offline (local copy stands)
  const handleSyncError = (e: unknown, what: string) => {
    const msg = String((e as Error)?.message ?? e);
    if (msg.toLowerCase().includes("too large")) {
      setSyncState("local");
      if (!sizeWarned.current) {
        sizeWarned.current = true;
        showNoticeRef.current(
          what === "fonts"
            ? "Your uploaded fonts are too large to save to your account - remove one to sync the rest."
            : "This project is too large to save to your account - remove a few heavy uploads."
        );
      }
    } else {
      // offline is fine - local copy stands; say so instead of pretending
      setSyncState("local");
    }
  };

  // push designs + library to the server, debounced. Fonts sync SEPARATELY
  // (scheduleFontSync) so a heavy font set can't push this over the limit and
  // drop the youth's actual designs.
  const scheduleSync = (nextLibrary?: SavedUpload[]) => {
    if (!authToken || !syncReady.current) return;
    if (syncTimer.current) clearTimeout(syncTimer.current);
    setSyncState("saving");
    syncTimer.current = setTimeout(async () => {
      try {
        const allIdeas = await listIdeas();
        // walkthrough state rides along so it follows the account, not the device
        let onboarded: string | null = null;
        try {
          onboarded = localStorage.getItem(policy.onboardKey);
        } catch { /* private mode */ }
        const deletedIds = [...pendingDeletes.current];
        await api({
          action: "save",
          token: authToken,
          ideas: allIdeas,
          ...(deletedIds.length ? { deletedIds } : {}),
          library: nextLibrary ?? library,
          ...(onboarded ? { prefs: { onboarded } } : {}),
        });
        // only clear tombstones the server actually acked (new deletes during
        // the request stay queued for the next sync)
        for (const id of deletedIds) pendingDeletes.current.delete(id);
        setSyncState("synced");
      } catch (e) {
        handleSyncError(e, "designs");
      }
    }, 1500);
  };

  // uploaded fonts sync to their own account blob (own size budget)
  const scheduleFontSync = (nextFonts?: LabFont[]) => {
    if (!authToken || !syncReady.current) return;
    if (fontSyncTimer.current) clearTimeout(fontSyncTimer.current);
    setSyncState("saving");
    fontSyncTimer.current = setTimeout(async () => {
      try {
        await api({
          action: "save-fonts",
          token: authToken,
          fonts: nextFonts ?? fonts,
        });
        setSyncState("synced");
      } catch (e) {
        handleSyncError(e, "fonts");
      }
    }, 1500);
  };

  // canvas reset is defined further down (it touches studio state); effects
  // above it reach it through this ref so declaration order stays clean
  const resetCanvasRef = useRef<() => void>(() => {});
  // cancels any pending debounced writes (sync/autosave/draft) - MUST run
  // before a sign-out purge, or a queued timer can fire after the wipe and
  // push empty arrays over the account's cloud copy
  const cancelPendingWritesRef = useRef<() => void>(() => {});

  // on sign-in / arrival with token: merge server data into local
  useEffect(() => {
    // Close the gate and cancel any writer armed for a prior token before the
    // owner check re-runs, so a stale debounced save can't fire mid-swap.
    syncReady.current = false;
    cancelPendingWritesRef.current();
    sizeWarned.current = false;
    if (!authToken) return;
    (async () => {
      try {
        const data = await api({ action: "load", token: authToken });
        setAuthEmail(data.email);
        applyRole(Boolean(data.staff), Boolean(data.admin));
        // Shared-device guard: if this device's local store belongs to a
        // DIFFERENT account, wipe it before merging - one participant must
        // never inherit another's projects, draft, or undo state.
        try {
          const prevOwner = localStorage.getItem(OWNER_KEY);
          if (prevOwner && prevOwner !== data.email) {
            await clearAllLocal();
            resetCanvasRef.current();
            setIdeas([]);
          }
          localStorage.setItem(OWNER_KEY, data.email);
        } catch { /* private mode */ }
        // walkthrough completion follows the account
        if (typeof data.prefs?.onboarded === "string") {
          try {
            localStorage.setItem(policy.onboardKey, data.prefs.onboarded);
          } catch { /* private mode */ }
        }
        const local = await listIdeas();
        const byId = new Map(local.map((i) => [i.id, i]));
        for (const remote of (data.ideas ?? []) as Idea[]) {
          const mine = byId.get(remote.id);
          if (!mine || remote.updatedAt > mine.updatedAt) await putIdea(remote);
        }
        await refreshIdeas();
        setLibrary((data.library ?? []) as SavedUpload[]);
        setFonts((data.fonts ?? []) as LabFont[]);
        // owner check + merge are done - pushing is safe from here on
        syncReady.current = true;
        // push the merged view back so the server has any local-only ideas.
        // Fonts sync separately; this also migrates any legacy inline fonts
        // into their own blob.
        scheduleSync((data.library ?? []) as SavedUpload[]);
        scheduleFontSync((data.fonts ?? []) as LabFont[]);
      } catch (e) {
        if (String(e).includes("expired") || String(e).includes("Sign in")) {
          setAuthToken(null);
          try {
            localStorage.removeItem("bayside-lab-token");
          } catch {
            /* ignore */
          }
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);

  const finishAuth = async (data: { token: string; email: string; staff?: unknown; admin?: unknown }) => {
    // Shared-device guard, part 1 (synchronous with sign-in): if this device's
    // local work belongs to a DIFFERENT account, wipe it before the new
    // session activates - nothing of the previous account can ride along.
    try {
      const prevOwner = localStorage.getItem(OWNER_KEY);
      if (prevOwner && prevOwner !== data.email) {
        // Switching accounts: STOP any in-flight/debounced writes for the
        // previous account and close the sync gate BEFORE wiping local state.
        // Otherwise a queued save fires after the wipe and overwrites the
        // previous account's cloud data with empty arrays.
        cancelPendingWritesRef.current();
        syncReady.current = false;
        await clearAllLocal().catch(() => {});
        resetCanvasRef.current();
        setIdeas([]);
        // don't let the previous account's library/fonts linger under the new
        // one until the network load resolves
        setLibrary([]);
        setFonts([]);
      }
      localStorage.setItem(OWNER_KEY, data.email);
    } catch { /* private mode */ }
    setAuthToken(data.token);
    setAuthEmail(data.email);
    applyRole(Boolean(data.staff), Boolean(data.admin));
    try {
      localStorage.setItem("bayside-lab-token", data.token);
      localStorage.setItem("bayside-lab-email", data.email);
    } catch {
      /* ignore */
    }
    setShowLogin(false);
    setAuthView("signin");
    setLoginStage("idle");
    setLoginCode("");
    setLoginPassword("");
    setCodeNote(null);
  };

  const runAuth = async (
    action: string,
    payload: Record<string, unknown>,
    onNeedsCode?: (message?: string) => void
  ) => {
    setLoginStage("busy");
    setLoginError(null);
    try {
      const data = await api({ action, ...payload });
      if (data.token) {
        finishAuth(data as { token: string; email: string });
      } else if (data.needsCode && onNeedsCode) {
        onNeedsCode(typeof data.message === "string" ? data.message : undefined);
        setLoginStage("idle");
      } else {
        setLoginStage("idle");
      }
    } catch (e) {
      setLoginError(String((e as Error).message));
      setLoginStage("idle");
    }
  };

  const doSignin = () =>
    runAuth("login", { email: loginEmail, password: loginPassword }, (message) => {
      setCodeNote(
        message ??
          "We emailed you a 6-digit code to confirm it's you."
      );
      setAuthView("code");
    });

  const doSignup = () =>
    runAuth("signup", { email: loginEmail, password: loginPassword }, () => {
      setCodeNote("We emailed you a 6-digit code to confirm your email.");
      setAuthView("code");
    });

  const doCodeVerify = () =>
    runAuth("signup-verify", { email: loginEmail, code: loginCode });

  const doResetRequest = () =>
    runAuth("reset-request", { email: loginEmail }, () => {
      setCodeNote("We emailed you a reset code - enter it with your new password.");
      setAuthView("resetcode");
    });

  const doResetVerify = () =>
    runAuth("reset-verify", {
      email: loginEmail,
      code: loginCode,
      password: loginPassword,
    });

  const signOut = () => {
    // 1) stop every queued write NOW - a debounced sync firing after the
    // purge below would overwrite the account's cloud copy with empty data
    cancelPendingWritesRef.current();
    syncReady.current = false;
    // 2) revoke the session server-side - best-effort, never blocks sign-out
    if (authToken) {
      void api({ action: "signout", token: authToken }).catch(() => {});
    }
    setAuthToken(null);
    setAuthEmail(null);
    setLibrary([]);
    setFonts([]);
    setRole({ staff: false, admin: false });
    setTab("studio");
    setSyncState("idle");
    try {
      localStorage.removeItem("bayside-lab-token");
      localStorage.removeItem("bayside-lab-email");
      localStorage.removeItem("bayside-lab-role");
    } catch {
      /* ignore */
    }
    if (policy.purgeOnSignOut) {
      // Shared facility devices: leave nothing of this account behind -
      // projects, live draft, walkthrough state, undo history, thumbnails.
      void clearAllLocal().catch(() => {});
      setIdeas([]);
      resetCanvasRef.current();
      try {
        localStorage.removeItem(policy.onboardKey);
        localStorage.removeItem(OWNER_KEY);
        sessionStorage.removeItem("bayside-lab-intro");
      } catch {
        /* ignore */
      }
    }
  };

  // first-visit tldr (once per session) + full guide behind the ? button
  const [showIntro, setShowIntro] = useState(() => {
    try {
      return sessionStorage.getItem("bayside-lab-intro") !== "seen";
    } catch {
      return true;
    }
  });
  const [showGuide, setShowGuide] = useState(false);
  // youth guided tour - a real, paged walkthrough of every tool (the compact
  // action-driven banner stays as reinforcement after it). null = closed.
  const [tour, setTour] = useState<number | null>(null);
  const [tourRequired, setTourRequired] = useState(false);
  // Youth first visit: the tour is part of arriving. Once signed in (and the
  // intro isn't up), it opens automatically and can't be skipped until it's
  // been completed once. Reopens from "?" stay skippable.
  const tourAutoOpened = useRef(false);
  useEffect(() => {
    if (!youth || !authToken || showIntro || tourAutoOpened.current) return;
    let seen: string | null = null;
    try {
      seen = localStorage.getItem(policy.onboardKey);
    } catch { /* private mode */ }
    if (!seen) {
      tourAutoOpened.current = true;
      setTourRequired(true);
      setTour(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [youth, authToken, showIntro]);

  // standalone identity: the youth edition is "Design Studio", start to finish
  useEffect(() => {
    if (youth) document.title = "Design Studio";
  }, [youth]);

  // Youth edition requires an account - every mockup traces to a student.
  const authRequired = policy.requireAccount && !authToken;

  // Escape dismisses the sign-in dialog (unless this session requires auth) -
  // keyboard users get the same exit as the backdrop and the ✕.
  useEffect(() => {
    if (!showLogin || authRequired) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowLogin(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showLogin, authRequired]);
  useEffect(() => {
    if (authRequired) setShowLogin(true);
  }, [authRequired]);
  const [showAbout, setShowAbout] = useState(false);

  // ── first-use onboarding ──────────────────────────────────────────────
  // Four compact steps advanced by real actions (not Next buttons). step is
  // "the thing to do next"; null = off. Completion/dismissal persists.
  const [onboardStep, setOnboardStep] = useState<number | null>(null);
  const dismissOnboarding = (how: "done" | "dismissed") => {
    setOnboardStep(null);
    try {
      localStorage.setItem(policy.onboardKey, how);
    } catch { /* private mode */ }
    scheduleSync(); // walkthrough state follows the account
  };
  // jump forward to `step` if onboarding is active and behind it; >4 = done
  const onboardTo = (step: number) => {
    setOnboardStep((s) => {
      if (s === null || s >= step) return s;
      if (step > 4) {
        try {
          localStorage.setItem(policy.onboardKey, "done");
        } catch { /* private mode */ }
        scheduleSync();
        return null;
      }
      return step;
    });
  };

  // ── mobile view navigation mode ───────────────────────────────────────
  // On touch, panning is an explicit mode (the hand button) so dragging can
  // never grab the garment when the user meant to move artwork.
  const [panMode, setPanMode] = useState(false);


  // ── upload background-removal review ─────────────────────────────────
  // Raster uploads pause here before placement: the user sees original vs
  // removed over a checkerboard and explicitly picks one. Never silently
  // claim a removal worked. The only in-browser remover today targets SOLID
  // backgrounds (flat-color threshold) - labeled accordingly; the flow is
  // structured so a stronger photo remover can slot in later.
  const [bgReview, setBgReview] = useState<{
    upload: Upload; // already in uploads (original art preserved either way)
    status: "idle" | "working" | "done" | "failed";
    removedURL: string | null;
  } | null>(null);
  const dismissIntro = () => {
    setShowIntro(false);
    try {
      sessionStorage.setItem("bayside-lab-intro", "seen");
    } catch {
      /* private mode */
    }
  };

  // ── studio state ─────────────────────────────────────────────────────
  // every blank is open to everyone; staff status gates the queue/costs side
  const visibleGarments = useMemo(
    () => [...STUDIO_GARMENTS, ...STAFF_GARMENTS],
    []
  );
  const [garmentId, setGarmentId] = useState(STUDIO_GARMENTS[0].id);
  const garment = garmentById(garmentId) ?? STUDIO_GARMENTS[0];
  const [colorSlug, setColorSlug] = useState(garment.colors[0].slug);
  const color = garment.colors.find((c) => c.slug === colorSlug) ?? garment.colors[0];
  const [view, setView] = useState<"front" | "back">("front");
  const viewImage = view === "back" && color.back ? color.back : color.front;
  // floating garment-color palette over the canvas - always reachable, never
  // scrolls away with the Blanks panel; opens on garment switch
  const [colorPop, setColorPop] = useState(false);
  const [colorHover, setColorHover] = useState<string | null>(null);

  const [uploads, setUploads] = useState<Upload[]>([]);
  const [armed, setArmed] = useState<string | null>(null);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = (msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2600);
  };

  // Shared-device idle timeout: after a stretch with no interaction, sign
  // out (with purge, per policy) so an abandoned seat never exposes work.
  useEffect(() => {
    if (!policy.idleTimeoutMs || !authToken) return;
    let last = Date.now();
    let warned = false;
    const bump = () => {
      last = Date.now();
      warned = false;
    };
    const events: (keyof WindowEventMap)[] = ["pointerdown", "keydown", "pointermove", "touchstart"];
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const iv = setInterval(() => {
      const idle = Date.now() - last;
      if (idle >= policy.idleTimeoutMs!) {
        signOut();
        showNotice("Signed out after a quiet half hour to keep your work private.");
      } else if (idle >= policy.idleTimeoutMs! - 60_000 && !warned) {
        warned = true;
        showNotice("Still there? You'll be signed out in a minute to keep your work private.");
      }
    }, 10_000);
    return () => {
      clearInterval(iv);
      events.forEach((e) => window.removeEventListener(e, bump));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken, policy.idleTimeoutMs]);


  const [editingId, setEditingId] = useState<string | null>(null);
  const [ideaName, setIdeaName] = useState("");
  const [collection, setCollection] = useState("");
  const [qty, setQty] = useState("1");
  const [ideaNotes, setIdeaNotes] = useState("");
  // "Next time I want to…" - a note to your future self, surfaced on return
  const [nextNote, setNextNote] = useState("");
  // placement currently being re-edited in the text tool (words/style/curve)
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [ideaThreads, setIdeaThreads] = useState<IdeaThread[]>([]);
  const [threadQuery, setThreadQuery] = useState("");
  const [saving, setSaving] = useState(false);

  const previewRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const resizeRef = useRef<{
    id: string;
    startDist: number;
    startIn: number;
  } | null>(null);
  const dragRef = useRef<{
    id: string; startX: number; startY: number; origX: number; origY: number;
    moved: boolean;
  } | null>(null);
  const recolorCache = useRef(new Map<string, string>());

  // Corner-drag is the one way to resize (Jacob's UX review: the slider and
  // the Corners toggle were confusing - dragging a corner is intuitive on its
  // own). Kept as a constant so the handle-rendering conditions read the same.
  const resizeMode = "handles" as const;

  // first-visit canvas hint - a clearly dismissible popup instead of small
  // fine print; the persistent line under the canvas remains as a reminder
  const [canvasHint, setCanvasHint] = useState(() => {
    try {
      return localStorage.getItem("bayside-lab-canvas-hint") !== "seen";
    } catch {
      return true;
    }
  });
  const dismissCanvasHint = () => {
    setCanvasHint(false);
    try {
      localStorage.setItem("bayside-lab-canvas-hint", "seen");
    } catch { /* private mode */ }
  };
  // first time two designs stack: explain the layers strip (top chip = on top)
  const [layersHint, setLayersHint] = useState(() => {
    try {
      return localStorage.getItem("bayside-lab-layers-hint") !== "seen";
    } catch {
      return true;
    }
  });
  // "bring your own font" explainer - opened from the text tool
  const [showFontsGuide, setShowFontsGuide] = useState(false);
  const dismissLayersHint = () => {
    setLayersHint(false);
    try {
      localStorage.setItem("bayside-lab-layers-hint", "seen");
    } catch { /* private mode */ }
  };

  // preview zoom - scale + pan applied to the garment AND its placements
  // together so the fraction-based placement math stays valid
  const MAX_ZOOM = 3;
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 }); // fractions of the preview box
  const panRef = useRef<{
    startX: number; startY: number; origX: number; origY: number; moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false); // a pan gesture shouldn't also place/deselect
  const clampPan = (p: { x: number; y: number }, z: number) => {
    const lim = (z - 1) / (2 * z); // garment always covers the frame
    return { x: clamp(p.x, -lim, lim), y: clamp(p.y, -lim, lim) };
  };
  const zoomBy = (delta: number) => {
    const next = clamp(Math.round((zoom + delta) * 2) / 2, 1, MAX_ZOOM);
    setZoom(next);
    setPan((p) => (next === 1 ? { x: 0, y: 0 } : clampPan(p, next)));
    if (next === 1) setPanMode(false);
  };
  const resetZoom = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setPanMode(false);
  };
  // pan is re-clamped at render time so zooming back out never strands it
  const shownPan = zoom > 1 ? clampPan(pan, zoom) : { x: 0, y: 0 };

  const uploadById = useMemo(() => new Map(uploads.map((u) => [u.id, u])), [uploads]);
  const collections = useMemo(
    () => [...new Set(ideas.map((i) => i.collection).filter(Boolean))],
    [ideas]
  );

  // Remove a flat background from an upload. Rather than a global white
  // threshold (which eats a logo's interior whites and only handles pure
  // white), we sample the actual corner color and flood-fill inward from the
  // edges, clearing only background connected to the border and feathering the
  // frontier for a soft, anti-aliased cutout. Works on white *and* solid
  // colored backgrounds; leaves interior fills and dark artwork intact.
  const stripBackground = (img: HTMLImageElement): string => {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    if (w < 2 || h < 2) return c.toDataURL("image/png");
    const image = ctx.getImageData(0, 0, w, h);
    const px = image.data;

    // Reference background = average of the four corners.
    let br = 0, bg = 0, bb = 0, n = 0;
    for (const [sx, sy] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) {
      const i = (sy * w + sx) * 4;
      if (px[i + 3] < 8) continue; // already transparent corner
      br += px[i];
      bg += px[i + 1];
      bb += px[i + 2];
      n++;
    }
    if (!n) return c.toDataURL("image/png"); // fully transparent already
    br /= n;
    bg /= n;
    bb /= n;

    const dist = (i: number) =>
      Math.abs(px[i] - br) + Math.abs(px[i + 1] - bg) + Math.abs(px[i + 2] - bb);
    const tolLo = 46; // ≤ this: certainly background → fully clear
    const tolHi = 140; // > this: certainly foreground → keep, don't cross

    // Flood fill from every border pixel; feather the frontier via partial alpha.
    const visited = new Uint8Array(w * h);
    const stack: number[] = [];
    for (let x = 0; x < w; x++) {
      stack.push(x, (h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
      stack.push(y * w, y * w + w - 1);
    }
    while (stack.length) {
      const p = stack.pop()!;
      if (visited[p]) continue;
      visited[p] = 1;
      const i = p * 4;
      const d = dist(i);
      if (d > tolHi) continue; // foreground edge - keep opaque, stop spreading
      px[i + 3] = d <= tolLo ? 0 : Math.round((255 * (d - tolLo)) / (tolHi - tolLo));
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0) stack.push(p - 1);
      if (x < w - 1) stack.push(p + 1);
      if (y > 0) stack.push(p - w);
      if (y < h - 1) stack.push(p + w);
    }
    ctx.putImageData(image, 0, 0);
    return c.toDataURL("image/png");
  };

  // Solid recolor to a thread color, preserving alpha - for single-color
  // artwork this is exactly "what it looks like stitched in that thread".
  const recolorTo = async (upload: SavedUpload, hex: string): Promise<string> => {
    const key = upload.id + hex;
    const cached = recolorCache.current.get(key);
    if (cached) return cached;
    const img = await loadImage(upload.dataURL);
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, c.width, c.height);
    const url = c.toDataURL("image/png");
    recolorCache.current.set(key, url);
    return url;
  };

  // rendered URL per placement (original or thread-recolored)
  const [renderUrls, setRenderUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    (async () => {
      const next: Record<string, string> = {};
      for (const p of placements) {
        const u = uploadById.get(p.uploadId);
        if (!u) continue;
        next[p.id] = p.thread ? await recolorTo(u, p.thread.hex) : u.url;
      }
      if (live) setRenderUrls(next);
    })();
    return () => {
      live = false;
    };
  }, [placements, uploadById]);

  const fileToDataURL = (f: File) =>
    new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result as string);
      r.onerror = rej;
      r.readAsDataURL(f);
    });

  // run the solid-background remover for the review dialog. Success is
  // judged by actual transparency in the result - never by assumption.
  const runBgRemoval = async (up: Upload) => {
    setBgReview((r) => (r && r.upload.id === up.id ? { ...r, status: "working" } : r));
    await new Promise((res) => setTimeout(res, 30)); // let the spinner paint
    try {
      const img = await loadImage(up.dataURL);
      const removed = stripBackground(img);
      const probe = await loadImage(removed);
      const c = document.createElement("canvas");
      const scale = Math.min(1, 300 / Math.max(probe.naturalWidth || 1, probe.naturalHeight || 1));
      c.width = Math.max(1, Math.round((probe.naturalWidth || 1) * scale));
      c.height = Math.max(1, Math.round((probe.naturalHeight || 1) * scale));
      const ctx = c.getContext("2d")!;
      ctx.drawImage(probe, 0, 0, c.width, c.height);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let clear = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] < 128) clear++;
      const worked = clear / (d.length / 4) >= 0.01; // ≥1% actually transparent
      setBgReview((r) =>
        r && r.upload.id === up.id
          ? worked
            ? { ...r, status: "done", removedURL: removed }
            : { ...r, status: "failed", removedURL: null }
          : r
      );
    } catch {
      setBgReview((r) =>
        r && r.upload.id === up.id ? { ...r, status: "failed", removedURL: null } : r
      );
    }
  };

  // photographed pencil/pen drawings → crisp transparent graphic, entirely
  // on-device (Otsu threshold + speckle removal). Same review contract.
  const runDrawingCleanup = async (up: Upload) => {
    setBgReview((r) => (r && r.upload.id === up.id ? { ...r, status: "working" } : r));
    try {
      const cleaned = await cleanDrawing(up.dataURL);
      setBgReview((r) =>
        r && r.upload.id === up.id ? { ...r, status: "done", removedURL: cleaned } : r
      );
    } catch {
      setBgReview((r) =>
        r && r.upload.id === up.id ? { ...r, status: "failed", removedURL: null } : r
      );
    }
  };

  // photo backgrounds go through remove.bg (proxied server-side); same
  // review contract as the solid remover - the user always sees and picks.
  const removingBgRef = useRef(false);
  // Anonymous quota identity: a random device id (the server tracks the free
  // trial against it; signed-in accounts get a monthly allowance instead).
  const rbDeviceId = (): string => {
    try {
      let id = localStorage.getItem("bayside-rb-device");
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem("bayside-rb-device", id);
      }
      return id;
    } catch {
      return crypto.randomUUID();
    }
  };

  const runPhotoRemoval = async (up: Upload) => {
    // Ref guard: the button's disabled state doesn't repaint fast enough to stop
    // a double-click, and this endpoint spends paid credits per call.
    if (removingBgRef.current) return;
    removingBgRef.current = true;
    setBgReview((r) => (r && r.upload.id === up.id ? { ...r, status: "working" } : r));
    try {
      const res = await fetch(`${apiBase()}/api/removebg`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // paid credits: the server quotas by account (10/month) or device trial (3)
        body: JSON.stringify({ image: up.dataURL, token: authToken, deviceId: rbDeviceId() }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        dataURL?: string;
        error?: string;
        code?: string;
        remaining?: number;
      };
      if (!res.ok || !body.dataURL) {
        showNotice(body.error || "Photo removal failed - try again.");
        if (body.code === "anon-cap" && !authToken) setShowLogin(true);
        setBgReview((r) =>
          r && r.upload.id === up.id ? { ...r, status: "failed", removedURL: null } : r
        );
        return;
      }
      if (typeof body.remaining === "number" && body.remaining <= 3) {
        showNotice(
          body.remaining === 0
            ? authToken
              ? "That was your last removal this month - resets on the 1st."
              : "That was your last free removal - sign in for more each month."
            : `${body.remaining} background removal${body.remaining === 1 ? "" : "s"} left${authToken ? " this month" : " - sign in for more"}.`
        );
      }
      setBgReview((r) =>
        r && r.upload.id === up.id
          ? { ...r, status: "done", removedURL: body.dataURL! }
          : r
      );
    } catch {
      showNotice("Couldn't reach the photo removal service.");
      setBgReview((r) =>
        r && r.upload.id === up.id ? { ...r, status: "failed", removedURL: null } : r
      );
    } finally {
      removingBgRef.current = false;
    }
  };

  // place the chosen version; the removed version becomes its own upload so
  // the original stays available in My designs
  const finishBgReview = (useRemoved: boolean) => {
    setBgReview((r) => {
      if (!r) return null;
      if (useRemoved && r.removedURL) {
        const cut: Upload = {
          id: uid(),
          name: r.upload.name.replace(/\.(png|jpe?g|webp)$/i, "") + " · cutout",
          dataURL: r.removedURL,
          url: r.removedURL,
          aspect: r.upload.aspect,
        };
        setUploads((u) => [...u, cut]);
        addToLibrary({ id: cut.id, name: cut.name, dataURL: cut.dataURL, aspect: cut.aspect });
        placeCentered(cut.id);
      } else {
        placeCentered(r.upload.id);
      }
      if (!isMobile) revealPreview();
      return null;
    });
  };

  const addToLibrary = (up: SavedUpload) => {
    if (!authToken) return;
    setLibrary((lib) => {
      if (lib.some((x) => x.name === up.name && x.dataURL.length === up.dataURL.length))
        return lib;
      const next = [...lib, up];
      scheduleSync(next);
      return next;
    });
  };

  // Validate by CONTENT, not just extension: sniff magic bytes, cap size,
  // and re-encode rasters through a canvas - which drops EXIF/GPS metadata
  // before anything is stored locally or synced to an account.
  const MAX_UPLOAD_BYTES = 12_000_000;
  const sniffKind = async (f: File): Promise<"raster" | "svg" | null> => {
    const head = new Uint8Array(await f.slice(0, 64).arrayBuffer());
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "raster"; // PNG
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "raster"; // JPEG
    const ascii = new TextDecoder().decode(head);
    if (ascii.slice(0, 4) === "RIFF" && ascii.slice(8, 12) === "WEBP") return "raster";
    if (ascii.replace(/^\uFEFF/, "").trimStart().startsWith("<")) return "svg";
    return null;
  };
  const reencodeRaster = async (raw: string, preferJpeg: boolean): Promise<string> => {
    const img = await loadImage(raw);
    // 2400px is plenty for a 16" print at production resolution; also keeps
    // the 4MB account-sync budget honest for phone photos
    const maxSide = 2400;
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
    c.height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL(preferJpeg ? "image/jpeg" : "image/png", 0.92);
  };
  const addFiles = async (files: FileList | File[], origin?: SavedUpload["origin"]) => {
    let placedFromBatch = false; // on mobile, auto-place the first file only
    for (const f of Array.from(files)) {
      if (!/\.(png|svg|jpe?g|webp)$/i.test(f.name)) {
        showNotice(`Skipped ${f.name} - PNG, SVG, JPG, or WEBP only.`);
        continue;
      }
      if (f.size > MAX_UPLOAD_BYTES) {
        showNotice(`Skipped ${f.name} - over 12 MB.`);
        continue;
      }
      try {
        const extSvg = /\.svg$/i.test(f.name);
        const kind = await sniffKind(f);
        if (kind === null || (kind === "svg") !== extSvg) {
          showNotice(`Skipped ${f.name} - the file contents don't match its type.`);
          continue;
        }
        const isSvg = kind === "svg";
        let raw = await fileToDataURL(f);
        if (!isSvg) raw = await reencodeRaster(raw, /\.jpe?g$/i.test(f.name));
        const img = await loadImage(raw);
        const aspect = img.naturalWidth > 0 ? img.naturalHeight / img.naturalWidth : 1;
        const up: Upload = { id: uid(), name: f.name, dataURL: raw, url: raw, aspect, ...(origin ? { origin } : {}) };
        setUploads((u) => [...u, up]);
        addToLibrary({ id: up.id, name: up.name, dataURL: up.dataURL, aspect: up.aspect, ...(origin ? { origin } : {}) });
        if (!placedFromBatch) {
          placedFromBatch = true;
          if (isSvg) {
            // SVGs are transparent already - straight onto the garment
            placeCentered(up.id);
            if (!isMobile) revealPreview();
          } else {
            setBgReview({ upload: up, status: "idle", removedURL: null });
          }
        }
      } catch {
        showNotice(`Couldn't read ${f.name}.`);
      }
    }
  };

  // desktop tools are CARDS, not a stacked accordion - one tool open at a
  // time, like the mobile tab bar. blanks starts open; save surfaces on the
  // first placement.
  const [activePanel, setActivePanel] = useState<
    "blanks" | "designs" | "shapes" | "generators" | "text" | "artlib" | "save" | null
  >("blanks");
  const setSection = (k: string, v: boolean) =>
    setActivePanel((cur) =>
      v ? (k as NonNullable<typeof activePanel>) : cur === k ? null : cur
    );

  // Between md and lg the accordion column sits below the preview - arming
  // a design scrolls the garment back into view there. The mobile shell
  // (<md) has no page scroll, and desktop (lg+) is side-by-side: both skip.
  const revealPreview = () => {
    const w = window.innerWidth;
    if (w < 768 || w >= 1024 || !previewRef.current) return;
    previewRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // ── mobile studio: fixed editor shell (below md) ─────────────────────
  // Touch shell: phones by width, plus touch-first devices (iPad, Pencil)
  // without hover up to 1100px - they need big targets, not a shrunken
  // desktop. Mouse/trackpad devices keep the desktop layout from 768px up.
  const SHELL_MQ =
    "(max-width: 767px), ((pointer: coarse) and (hover: none) and (max-width: 1099px))";
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia(SHELL_MQ).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(SHELL_MQ);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // shell navigation: a primary tab, at most one open detail beneath it.
  // Selecting a placed design overrides the row with design controls; the
  // pre-selection tab/detail is stashed and restored on deselect.
  const [activeTab, setActiveTab] = useState<TabId | null>(null);
  const [activeDetail, setActiveDetail] = useState<string | null>(null);
  const stashedNav = useRef<{ tab: TabId | null; detail: string | null } | null>(null);
  const toggleDetail = (id: string) =>
    setActiveDetail((d) => (d === id ? null : id));

  // canvas letterboxing: measure the region, size the preview box to fit -
  // placement math keeps working because the box IS the image, exactly
  const canvasRegionRef = useRef<HTMLDivElement>(null);
  const [regionSize, setRegionSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!isMobile || tab !== "studio") return;
    const el = canvasRegionRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setRegionSize({ w: e.contentRect.width, h: e.contentRect.height })
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, [isMobile, tab]);
  const [imgDims, setImgDims] = useState({ w: 4, h: 5 });

  // placement history - snapshots of `placements`, pushed once per discrete
  // action (place, remove, thread, blend, passes, flip; one per drag or
  // resize gesture). Undo/redo swap snapshots back into the same state the
  // desktop accordions read, so nothing is forked.
  const histRef = useRef<{ past: Placement[][]; future: Placement[][] }>({
    past: [],
    future: [],
  });
  const placementsNow = useRef<Placement[]>([]);
  useEffect(() => {
    placementsNow.current = placements;
  }, [placements]);
  const [, bumpHist] = useState(0); // re-render undo/redo disabled states
  const [announce, setAnnounce] = useState("");
  const pushHistory = () => {
    const h = histRef.current;
    h.past.push(placementsNow.current.map((p) => ({ ...p })));
    if (h.past.length > 50) h.past.shift();
    h.future = [];
    bumpHist((v) => v + 1);
  };
  const clearHistory = useCallback(() => {
    histRef.current = { past: [], future: [] };
    bumpHist((v) => v + 1);
  }, []);

  // wipe the working canvas back to a fresh state (owner switch / purge);
  // published through resetCanvasRef for the effects declared above
  const resetCanvas = () => {
    setUploads([]);
    setPlacements([]);
    setSelected(null);
    setArmed(null);
    setEditingId(null);
    setIdeaName("");
    setCollection("");
    setQty("1");
    setIdeaNotes("");
    setNextNote("");
    setIdeaThreads([]);
    setEditingTextId(null);
    clearHistory();
  };
  useEffect(() => {
    resetCanvasRef.current = resetCanvas;
  });
  const undo = () => {
    const h = histRef.current;
    const prev = h.past.pop();
    if (!prev) return;
    h.future.push(placementsNow.current.map((p) => ({ ...p })));
    setPlacements(prev);
    setSelected(null);
    bumpHist((v) => v + 1);
    setAnnounce("Undid the last change");
  };
  const redo = () => {
    const h = histRef.current;
    const next = h.future.pop();
    if (!next) return;
    h.past.push(placementsNow.current.map((p) => ({ ...p })));
    setPlacements(next);
    setSelected(null);
    bumpHist((v) => v + 1);
    setAnnounce("Redid the change");
  };

  // remove needs a confirm tap (no dialog); it disarms itself after 3s
  const [confirmRemove, setConfirmRemove] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tapTab = (t: TabId) => {
    stashedNav.current = null;
    const leavingCtx = Boolean(selected);
    setSelected(null); // leaving the design-controls context, if any
    if (!leavingCtx && activeTab === t) {
      // same tab again → collapse everything, full canvas back
      setActiveTab(null);
      setActiveDetail(null);
    } else {
      setActiveTab(t);
      setActiveDetail(t === "text" ? "font" : null);
    }
  };

  // ── built-in shapes, generators + text tool ──────────────────────────
  const [shapeQuery, setShapeQuery] = useState("");
  const [textValue, setTextValue] = useState("");
  const [textStyle, setTextStyle] = useState<TextStyle>("straight");
  const [textCurve, setTextCurve] = useState(126); // arch span, degrees
  const [archDown, setArchDown] = useState(false); // ∪ valley (ends sweep up)
  const [textOutline, setTextOutline] = useState(false); // letterforms as strokes
  const [fontChoice, setFontChoice] = useState("Georgia");
  const [fontGroupFilter, setFontGroupFilter] = useState("All");
  const signedCurve = archDown ? -textCurve : textCurve;
  // live preview of the ACTUAL styled render - arch/wave/outline visibly work
  // before anything is added to the garment
  const [textPreview, setTextPreview] = useState<string | null>(null);
  useEffect(() => {
    const text = textValue.trim();
    let live = true;
    const t = setTimeout(() => {
      if (!text) {
        setTextPreview(null);
        return;
      }
      renderText(text, fontChoice, textStyle, signedCurve, textOutline)
        .then((r) => {
          if (live) setTextPreview(r.dataURL);
        })
        .catch(() => {
          if (live) setTextPreview(null);
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [textValue, fontChoice, textStyle, signedCurve, textOutline]);
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const fontFileRef = useRef<HTMLInputElement>(null);

  // every selectable font (account fonts first) - feeds the text tool, the
  // Abc tiles, and the placed-text font editor
  const fontChoices: { family: string; name: string }[] = [
    ...fonts.map((f) => ({ family: f.family, name: f.name })),
    ...DEFAULT_FONTS.map((f) => ({ family: f, name: f })),
    ...GOOGLE_FONT_FAMILIES.map((f) => ({ family: f, name: f })),
    ...systemFonts.map((f) => ({ family: f, name: f })),
  ];
  // grouped view for the picker: your uploads first, then the library
  const fontGroups: { group: string; fonts: { family: string; name: string }[] }[] = [
    ...(fonts.length
      ? [{ group: "Your fonts", fonts: fonts.map((f) => ({ family: f.family, name: f.name })) }]
      : []),
    { group: "Classics", fonts: DEFAULT_FONTS.map((f) => ({ family: f, name: f })) },
    ...GOOGLE_FONTS.map((g) => ({
      group: g.group,
      fonts: g.families.map((f) => ({ family: f, name: f })),
    })),
    ...(systemFonts.length
      ? [{ group: "This device", fonts: systemFonts.map((f) => ({ family: f, name: f })) }]
      : []),
  ];

  const shownShapes = useMemo(() => {
    const q = shapeQuery.trim().toLowerCase();
    return q
      ? SHAPES_AVAILABLE.filter((s) => s.name.toLowerCase().includes(q))
      : SHAPES_AVAILABLE;
  }, [shapeQuery]);

  // Rasterize any image source to a PNG data URL so recolor/blend behave
  // uniformly (SVGs without intrinsic size get a 1200px canvas).
  const rasterize = async (src: string): Promise<{ dataURL: string; aspect: number }> => {
    const img = await loadImage(src);
    const w = img.naturalWidth || 1200;
    const h = img.naturalHeight || 1200;
    const scale = Math.min(1, 1600 / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.round(w * scale);
    c.height = Math.round(h * scale);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return { dataURL: c.toDataURL("image/png"), aspect: c.height / c.width };
  };

  const addShape = async (asset: { id: string; name: string; url: string }) => {
    try {
      const existing = uploads.find((u) => u.name === asset.name);
      if (existing) {
        placeCentered(existing.id); // lands on the garment directly - drag from there
        if (!isMobile) revealPreview();
        return;
      }
      const res = await fetch(asset.url);
      const blob = await res.blob();
      const raw = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = reject;
        r.readAsDataURL(blob);
      });
      const { dataURL, aspect } = await rasterize(raw);
      const finalUrl = /\.png$/i.test(asset.url)
        ? stripBackground(await loadImage(dataURL))
        : dataURL;
      const up: Upload = {
        id: uid(),
        name: asset.name,
        dataURL: finalUrl,
        url: finalUrl,
        aspect,
      };
      setUploads((u) => [...u, up]);
      placeCentered(up.id);
      if (!isMobile) revealPreview();
    } catch {
      showNotice(`Couldn't load ${asset.name}.`);
    }
  };

  const loadSystemFonts = async () => {
    try {
      const query = (
        window as unknown as {
          queryLocalFonts?: () => Promise<{ family: string }[]>;
        }
      ).queryLocalFonts;
      if (!query) {
        showNotice("System font access needs Chrome or Edge on desktop.");
        return;
      }
      const found = await query();
      setSystemFonts([...new Set(found.map((f) => f.family))].sort());
      showNotice("System fonts loaded into the font picker.");
    } catch {
      showNotice("Couldn't read system fonts - permission denied?");
    }
  };

  const addFontFiles = async (files: FileList) => {
    for (const f of Array.from(files)) {
      if (!/\.(otf|ttf|woff2?)$/i.test(f.name)) {
        showNotice(`Skipped ${f.name} - OTF, TTF, or WOFF only.`);
        continue;
      }
      try {
        const dataURL = await fileToDataURL(f);
        const family = fontFamilyFor(f.name);
        const face = new FontFace(family, `url(${dataURL})`);
        await face.load();
        document.fonts.add(face);
        setFonts((fs) => {
          if (fs.some((x) => x.family === family)) return fs;
          const next = [...fs, { name: f.name, family, dataURL }];
          scheduleFontSync(next);
          return next;
        });
        setFontChoice(family);
        showNotice(`${f.name} ready in the font picker.`);
      } catch {
        showNotice(`Couldn't load ${f.name} as a font.`);
      }
    }
  };

  const removeFont = (family: string) => {
    setFonts((fs) => {
      const next = fs.filter((x) => x.family !== family);
      scheduleFontSync(next);
      return next;
    });
    if (fontChoice === family) setFontChoice("Georgia");
  };

  const addText = async () => {
    const text = textValue.trim();
    if (!text) return;
    try {
      const { dataURL, aspect } = await renderText(text, fontChoice, textStyle, signedCurve, textOutline);
      const up: Upload = {
        id: uid(),
        name: `text: ${text.slice(0, 18)}${textStyle !== "straight" ? ` · ${textStyle}` : ""}`,
        dataURL,
        url: dataURL,
        aspect,
        textMeta: { text, style: textStyle, font: fontChoice, curve: signedCurve, outline: textOutline },
      };
      setUploads((u) => [...u, up]);
      addToLibrary({
        id: up.id,
        name: up.name,
        dataURL,
        aspect: up.aspect,
        textMeta: up.textMeta,
      });
      // editing a placed text? swap it in place instead of adding a copy
      const editTarget = editingTextId ? placements.find((p) => p.id === editingTextId) : null;
      if (editTarget) {
        pushHistory();
        update(editTarget.id, { uploadId: up.id });
        setEditingTextId(null);
        setTextValue("");
        showNotice("Text updated.");
        return;
      }
      setTextValue("");
      placeCentered(up.id);
      if (!isMobile) revealPreview();
    } catch {
      showNotice("Couldn't render that text.");
    }
  };

  // reopen a placed text design in the text tool with its settings restored
  const editPlacedText = (p: Placement) => {
    const u = uploadById.get(p.uploadId);
    if (!u?.textMeta) return;
    setTextValue(u.textMeta.text);
    setTextStyle((u.textMeta.style as TextStyle) ?? "straight");
    setFontChoice(u.textMeta.font);
    setTextCurve(Math.abs(u.textMeta.curve ?? 126));
    setArchDown((u.textMeta.curve ?? 126) < 0);
    setTextOutline(Boolean(u.textMeta.outline));
    setEditingTextId(p.id);
    if (isMobile) {
      // Must exit the selection first: while a placement is selected the mobile
      // drawer stays on the design-controls branch, so the text tool would never
      // actually show. Deselecting lets the "text" tab render.
      setSelected(null);
      setActiveTab("text");
      setActiveDetail(null);
    } else {
      setActivePanel("text");
    }
  };

  // fffuel-style generators - each tap mints a fresh random variant
  const genCounts = useRef<Record<string, number>>({});
  const [lastGen, setLastGen] = useState<{
    id: GeneratorId | "type";
    label: string;
    uploadId: string;
  } | null>(null);
  const [genWord, setGenWord] = useState("");
  // mobile motif flow: generate → preview in the drawer → commit explicitly.
  // Nothing touches uploads/placements until "Place it" or "Save for later".
  const [genPreview, setGenPreview] = useState<{
    id: GeneratorId | "type";
    label: string;
    dataURL: string;
    aspect: number;
  } | null>(null);

  // No auto-scroll here (unlike shapes/text): the fun is tapping "another"
  // repeatedly - the panel shows the fresh result inline instead.
  const pushGenerated = (name: string, dataURL: string, aspect: number) => {
    const up: Upload = { id: uid(), name, dataURL, url: dataURL, aspect };
    setUploads((u) => [...u, up]);
    addToLibrary({ id: up.id, name: up.name, dataURL, aspect: up.aspect });
    return up.id;
  };

  // Motifs land on the garment immediately. If the previously generated
  // motif is still the selected placement, a new roll REPLACES it in place
  // (reroll), instead of stacking a copy per tap.
  const placeGenerated = (uploadId: string) => {
    const selPl = placements.find((p) => p.id === selected);
    if (
      lastGen &&
      selPl &&
      selPl.uploadId === lastGen.uploadId
    ) {
      pushHistory();
      update(selPl.id, { uploadId });
      return;
    }
    placeCentered(uploadId, 3.5);
  };


  // type generator: random font × setting × case on the seed word
  const addTypeGenerated = async () => {
    try {
      const pool = [
        ...DEFAULT_FONTS,
        ...fonts.map((f) => f.family),
        ...systemFonts,
      ];
      const seed = genWord.trim() || textValue.trim() || "Bayside";
      const { dataURL, aspect, recipe } = await runTypeGenerator(seed, pool);
      const n = (genCounts.current.type = (genCounts.current.type ?? 0) + 1);
      const uploadId = pushGenerated(`type ${n} · ${recipe}`, dataURL, aspect);
      placeGenerated(uploadId);
      setLastGen({ id: "type", label: "Type", uploadId });
    } catch {
      showNotice("Couldn't generate that - try again.");
    }
  };

  const previewMotif = (id: GeneratorId, label: string) => {
    try {
      const { dataURL, aspect } = runGenerator(id);
      setGenPreview({ id, label, dataURL, aspect });
      if (isMobile) setActiveDetail("motif");
    } catch {
      showNotice("Couldn't generate that - try again.");
    }
  };
  const previewTypeMotif = async () => {
    try {
      const pool = [...DEFAULT_FONTS, ...fonts.map((f) => f.family), ...systemFonts];
      const seed = genWord.trim() || textValue.trim() || "Bayside";
      const { dataURL, aspect } = await runTypeGenerator(seed, pool);
      setGenPreview({ id: "type", label: "Type", dataURL, aspect });
    } catch {
      showNotice("Couldn't generate that - try again.");
    }
  };
  const anotherMotif = () => {
    if (!genPreview) return;
    if (genPreview.id === "type") void previewTypeMotif();
    else previewMotif(genPreview.id, genPreview.label);
  };
  const commitMotif = (placeIt: boolean) => {
    if (!genPreview) return;
    const n = (genCounts.current[genPreview.id] =
      (genCounts.current[genPreview.id] ?? 0) + 1);
    const up: Upload = {
      id: uid(),
      name: `${genPreview.label.toLowerCase()} · ${n}`,
      dataURL: genPreview.dataURL,
      url: genPreview.dataURL,
      aspect: genPreview.aspect,
    };
    setUploads((u) => [...u, up]);
    addToLibrary({ id: up.id, name: up.name, dataURL: up.dataURL, aspect: up.aspect });
    if (placeIt) placeCentered(up.id);
    else
      showNotice(
        authToken
          ? "Saved to your design library."
          : "Saved to My designs - sign in to keep it everywhere."
      );
  };

  // desktop Shapes panel: 4 rows visible, the rest behind "See X more"
  const [motifsExpanded, setMotifsExpanded] = useState(false);

  // ── Find art: public-domain search (proxied server-side) ─────────────
  type ArtResult = { id: string; title: string; artist: string; date: string; source: string; thumb: string; image: string };
  const [artQuery, setArtQuery] = useState("");
  const [artResults, setArtResults] = useState<ArtResult[] | null>(null);
  const [artBusy, setArtBusy] = useState(false);
  const [artError, setArtError] = useState<string | null>(null);
  const searchArt = async () => {
    const q = artQuery.trim();
    if (q.length < 2 || artBusy) return;
    setArtBusy(true);
    setArtError(null);
    try {
      const res = await fetch(`${apiBase()}/api/art?action=search&q=${encodeURIComponent(q)}`);
      const body = (await res.json()) as { results?: ArtResult[]; error?: string };
      if (!res.ok) throw new Error(body.error || "Search failed");
      setArtResults(body.results ?? []);
    } catch (e) {
      setArtError(String((e as Error).message));
      setArtResults(null);
    }
    setArtBusy(false);
  };
  const [artFetching, setArtFetching] = useState<string | null>(null);

  // ── curated library (Flickr-backed; youth never see Flickr concepts) ──
  const [artView, setArtView] = useState<"library" | "museums">("library");
  // the big scrolling browser - collections deserve more room than the panel
  const [browseOpen, setBrowseOpen] = useState<null | "library" | "museums">(null);
  const [libAssets, setLibAssets] = useState<LibraryAsset[] | null>(null);
  const [libError, setLibError] = useState<string | null>(null);
  const [libEmptyReason, setLibEmptyReason] = useState<string | null>(null);
  const [libQuery, setLibQuery] = useState("");
  const [libCategory, setLibCategory] = useState<string | null>(null);
  const libLoading = useRef(false);
  const loadLibrary = async () => {
    if (libLoading.current || libAssets) return;
    libLoading.current = true;
    setLibError(null);
    try {
      const res = await fetch(`${apiBase()}/api/flickr?action=library`);
      const body = (await res.json()) as {
        assets?: LibraryAsset[];
        notConfigured?: boolean;
        error?: string;
      };
      if (!res.ok) throw new Error(body.error || "load failed");
      setLibAssets(body.assets ?? []);
      if (body.notConfigured) setLibEmptyReason("The library isn't set up yet.");
      else if (!body.assets?.length) setLibEmptyReason("The library is empty right now - check back soon.");
    } catch {
      setLibError("Couldn't load the library - check the connection and try again.");
    }
    libLoading.current = false;
  };
  useEffect(() => {
    // desktop opens the panel via the rail (activePanel); mobile via the tab bar
    if (activePanel !== "artlib" && activeTab !== "artlib") return;
    const t = setTimeout(() => void loadLibrary(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePanel, activeTab]);
  const libCategories = useMemo(
    () => (libAssets ? categoriesOf(libAssets) : []),
    [libAssets]
  );
  const libResults = useMemo(
    () => (libAssets ? searchAssets(libAssets, libQuery, { category: libCategory, limit: 80 }) : []),
    [libAssets, libQuery, libCategory]
  );
  const relayUrl = (u: string) => `${apiBase()}/api/art?action=image&url=${encodeURIComponent(u)}`;
  const importLibraryAsset = async (a: LibraryAsset) => {
    if (artFetching) return;
    setArtFetching(a.id);
    try {
      const res = await fetch(relayUrl(a.imageUrl));
      if (!res.ok) throw new Error("fetch failed");
      const blob = await res.blob();
      const safe = a.title.replace(/[^\w -]+/g, "").trim().slice(0, 40) || "image";
      const ext = blob.type.includes("png") ? "png" : "jpg";
      await addFiles([new File([blob], `${safe}.${ext}`, { type: blob.type })], {
        source: "flickr",
        id: a.sourceId,
        title: a.title,
        creator: a.creator,
        license: a.license.code,
        url: a.pageUrl,
      });
    } catch {
      showNotice("Couldn't load that image - try another.");
    }
    setArtFetching(null);
  };
  const downloadLibraryAsset = async (a: LibraryAsset) => {
    try {
      const res = await fetch(relayUrl(a.imageUrl));
      if (!res.ok) throw new Error("fetch failed");
      const blob = await res.blob();
      const safe = a.title.replace(/[^\w -]+/g, "").trim().slice(0, 40) || "image";
      void saveBlob(blob, `${safe}.${blob.type.includes("png") ? "png" : "jpg"}`);
    } catch {
      showNotice("Couldn't download that image.");
    }
  };
  const importArtwork = async (a: ArtResult) => {
    if (artFetching) return;
    setArtFetching(a.id);
    try {
      const res = await fetch(`${apiBase()}/api/art?action=image&url=${encodeURIComponent(a.image)}`);
      if (!res.ok) throw new Error("fetch failed");
      const blob = await res.blob();
      const safe = a.title.replace(/[^\w -]+/g, "").trim().slice(0, 40) || "artwork";
      const ext = blob.type.includes("png") ? "png" : "jpg";
      // route through the normal upload pipeline: sniff, EXIF strip, review
      await addFiles([new File([blob], `${safe}.${ext}`, { type: blob.type })], {
        source: "museum",
        title: a.title,
        creator: a.artist || a.source,
        license: "Public domain",
      });
    } catch {
      showNotice("Couldn't load that artwork - try another.");
    }
    setArtFetching(null);
  };

  const [applyingEffect, setApplyingEffect] = useState(false);
  const runEffect = async (effectId: (typeof EFFECTS)[number]["id"]) => {
    const selPl = placements.find((p) => p.id === selected);
    const target = uploads.find((u) => u.id === (selPl?.uploadId ?? armed));
    if (!target) {
      showNotice("Tap a placed design first, then pick an effect.");
      return;
    }
    setApplyingEffect(true);
    try {
      const dataURL = await applyEffect(target.dataURL, effectId);
      const img = await loadImage(dataURL);
      const up: Upload = {
        id: uid(),
        name: `${target.name.replace(/\.(png|svg|jpe?g|webp)$/i, "")} · ${effectId}`,
        dataURL,
        url: dataURL,
        aspect: img.naturalHeight / img.naturalWidth || target.aspect,
      };
      setUploads((u) => [...u, up]);
      addToLibrary({ id: up.id, name: up.name, dataURL, aspect: up.aspect });
      const selNow = placements.find((p) => p.id === selected);
      if (selNow) {
        pushHistory();
        update(selNow.id, { uploadId: up.id });
      } else {
        placeCentered(up.id);
      }
      showNotice(`${effectId} applied - original kept in My designs.`);
    } catch {
      showNotice("Effect failed on that image.");
    }
    setApplyingEffect(false);
  };

  const addFromLibrary = (item: SavedUpload) => {
    const existing = uploads.find((u) => u.id === item.id);
    if (existing) {
      placeCentered(existing.id);
      if (!isMobile) revealPreview();
      return;
    }
    const up: Upload = { ...item, url: item.dataURL };
    setUploads((u) => [...u, up]);
    setTab("studio");
    placeCentered(up.id);
    if (!isMobile) revealPreview();
  };

  const removeFromLibrary = (id: string) => {
    setLibrary((lib) => {
      const next = lib.filter((x) => x.id !== id);
      scheduleSync(next);
      return next;
    });
  };

  const removeUpload = (id: string) => {
    // Removing an upload also drops every placement using it - snapshot first so
    // Undo can bring the lost artwork back (matches remove() for a placement).
    if (placements.some((p) => p.uploadId === id)) pushHistory();
    setPlacements((ps) => ps.filter((p) => p.uploadId !== id));
    setUploads((us) => us.filter((x) => x.id !== id));
    if (armed === id) setArmed(null);
  };

  const switchGarment = (g: LabGarment) => {
    onboardTo(2);
    // Carry placements into the NEW garment's usable area: a chest design on
    // a shirt shouldn't float between a tote's handles. Position maps
    // relative to the old side's print area; size clamps to fit the new one.
    if (g.id !== garment.id && placementsNow.current.length) {
      pushHistory();
      setPlacements((ps) =>
        ps.map((pl) => {
          const from = printAreaFor(garment, pl.view);
          const to = printAreaFor(g, pl.view);
          const nx = to.x + ((pl.x - from.x) / Math.max(0.01, from.w)) * to.w;
          const ny = to.y + ((pl.y - from.y) / Math.max(0.01, from.h)) * to.h;
          return {
            ...pl,
            x: clamp(nx, to.x - to.w / 2, to.x + to.w / 2),
            y: clamp(ny, to.y - to.h / 2, to.y + to.h / 2),
            inches: Math.min(pl.inches, areaMaxInches(g, to)),
          };
        })
      );
    }
    setGarmentId(g.id);
    const same = g.colors.find((c) => c.slug === colorSlug);
    setColorSlug((same ?? g.colors[0]).slug);
    setView("front");
    resetZoom();
    // color choice happens in the floating palette over the canvas - pop it
    // open whenever the new blank actually has colors to choose between
    if (!isMobile) setColorPop(g.colors.length > 1);
  };

  const place = (clientX: number, clientY: number) => {
    if (!armed || !previewRef.current) return;
    const r = previewRef.current.getBoundingClientRect();
    const fx = clamp((clientX - r.left) / r.width, BOUNDS.minX, BOUNDS.maxX);
    const fy = clamp((clientY - r.top) / r.height, BOUNDS.minY, BOUNDS.maxY);
    onboardTo(3);
    pushHistory();
    const id = uid();
    setPlacements((p) => {
      if (p.length === 0) {
        // blank choice is settled once designing starts - fold it
        setSection("blanks", false);
      }
      return [...p, { id, uploadId: armed, x: fx, y: fy, inches: 4, flip: false, view }];
    });
    setSelected(id);
    setArmed(null);
  };

  // skips the arm step - the design lands in this garment's print area
  const placeCentered = (uploadId: string, inches = 4) => {
    onboardTo(3);
    pushHistory();
    const id = uid();
    const area = printAreaFor(garment, view);
    const eff = Math.min(inches, areaMaxInches(garment, area));
    setPlacements((p) => {
      if (p.length === 0) {
        // blank choice is settled once designing starts - fold it
        setSection("blanks", false);
      }
      return [...p, { id, uploadId, x: area.x, y: area.y, inches: eff, flip: false, view }];
    });
    setSelected(id);
    setArmed(null);
  };

  // re-render a placed text design in a different font (same word + setting)
  const changeTextFont = async (p: Placement, family: string) => {
    const u = uploadById.get(p.uploadId);
    if (!u?.textMeta) return;
    try {
      const { dataURL, aspect } = await renderText(
        u.textMeta.text,
        family,
        u.textMeta.style as TextStyle,
        u.textMeta.curve ?? 126,
        Boolean(u.textMeta.outline)
      );
      const up: Upload = {
        id: uid(),
        name: u.name,
        dataURL,
        url: dataURL,
        aspect,
        textMeta: { ...u.textMeta, font: family },
      };
      setUploads((us) => [...us, up]);
      pushHistory();
      update(p.id, { uploadId: up.id });
    } catch {
      showNotice("Couldn't re-render that text.");
    }
  };

  const startDrag = (e: React.PointerEvent, p: Placement) => {
    if (isMobile && panMode) {
      startPan(e);
      return;
    }
    e.preventDefault();
    capturePointer(e);
    dragRef.current = {
      id: p.id, startX: e.clientX, startY: e.clientY, origX: p.x, origY: p.y,
      moved: false,
    };
  };
  const onDrag = (e: React.PointerEvent) => {
    if (isMobile && panMode && panRef.current) {
      onPan(e);
      return;
    }
    const d = dragRef.current;
    if (!d || !previewRef.current) return;
    const r = previewRef.current.getBoundingClientRect();
    const dx = (e.clientX - d.startX) / r.width;
    const dy = (e.clientY - d.startY) / r.height;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 0.004) {
      d.moved = true;
      onboardTo(4);
      pushHistory(); // one undo step per reposition gesture
    }
    setPlacements((ps) =>
      ps.map((p) =>
        p.id === d.id
          ? {
              ...p,
              x: clamp(d.origX + dx, BOUNDS.minX, BOUNDS.maxX),
              y: clamp(d.origY + dy, BOUNDS.minY, BOUNDS.maxY),
            }
          : p
      )
    );
  };
  const endDrag = (p: Placement) => {
    if (isMobile && panMode && panRef.current) {
      endPan();
      return;
    }
    const d = dragRef.current;
    dragRef.current = null;
    if (d && !d.moved) {
      // shell: tapping a placed design selects it and the secondary row
      // switches to its controls; deselect happens on empty-canvas taps
      if (isMobile) setSelected(p.id);
      else setSelected(selected === p.id ? null : p.id);
    }
  };

  // pan the zoomed preview - drag anywhere that isn't a placement
  const startPan = (e: React.PointerEvent) => {
    if (zoom <= 1) return;
    if (isMobile && !panMode) return; // touch pans only in Move-view mode
    capturePointer(e);
    panRef.current = {
      startX: e.clientX, startY: e.clientY, origX: pan.x, origY: pan.y,
      moved: false,
    };
  };
  const onPan = (e: React.PointerEvent) => {
    const d = panRef.current;
    if (!d || !previewRef.current) return;
    const r = previewRef.current.getBoundingClientRect(); // scaled rect
    const dx = (e.clientX - d.startX) / r.width;
    const dy = (e.clientY - d.startY) / r.height;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 0.004) d.moved = true;
    setPan(clampPan({ x: d.origX + dx, y: d.origY + dy }, zoom));
  };
  const endPan = () => {
    if (panRef.current?.moved) suppressClick.current = true;
    panRef.current = null;
  };

  // corner-handle resize on the selected placement (mobile shell)
  const startResize = (e: React.PointerEvent, p: Placement) => {
    e.stopPropagation();
    e.preventDefault();
    if (p.locked) return;
    capturePointer(e);
    if (!previewRef.current) return;
    const r = previewRef.current.getBoundingClientRect();
    const cx = r.left + p.x * r.width;
    const cy = r.top + p.y * r.height;
    pushHistory(); // one undo step per resize gesture
    resizeRef.current = {
      id: p.id,
      startDist: Math.max(8, Math.hypot(e.clientX - cx, e.clientY - cy)),
      startIn: p.inches,
    };
  };
  const onResizeMove = (e: React.PointerEvent) => {
    const rz = resizeRef.current;
    if (!rz || !previewRef.current) return;
    onboardTo(4);
    const pl = placements.find((x) => x.id === rz.id);
    if (!pl) return;
    const r = previewRef.current.getBoundingClientRect();
    const cx = r.left + pl.x * r.width;
    const cy = r.top + pl.y * r.height;
    const dist = Math.hypot(e.clientX - cx, e.clientY - cy);
    update(rz.id, {
      inches: clamp(rz.startIn * (dist / rz.startDist), MIN_IN, MAX_IN),
    });
  };
  const endResize = () => {
    resizeRef.current = null;
  };

  const update = (id: string, patch: Partial<Placement>) =>
    setPlacements((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const remove = (id: string) => {
    pushHistory();
    setPlacements((ps) => ps.filter((p) => p.id !== id));
    if (selected === id) setSelected(null);
  };

  const applyThreadToPlacement = (p: Placement, t: IdeaThread | null) => {
    pushHistory();
    update(p.id, { thread: t ?? undefined });
    if (t && !ideaThreads.some((x) => x.code === t.code && x.name === t.name)) {
      setIdeaThreads((x) => [...x, t]); // keep the idea's thread list in sync
    }
  };

  const sel = placements.find((p) => p.id === selected) ?? null;
  const viewPlacements = placements.filter((p) => (p.view ?? "front") === view);

  // live effect previews: each tile in the inspector shows the ACTUAL result
  // of that effect on the selected artwork (rendered small, cached per upload)
  const [effectPreviews, setEffectPreviews] = useState<Record<string, Record<string, string>>>({});
  const selUploadId = sel?.uploadId ?? null;
  useEffect(() => {
    if (!selUploadId) return;
    const u = uploadById.get(selUploadId);
    if (!u || effectPreviews[selUploadId]) return;
    let live = true;
    (async () => {
      try {
        const img = await loadImage(u.dataURL);
        const scale = Math.min(1, 140 / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
        c.height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
        c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
        const small = c.toDataURL("image/png");
        const out: Record<string, string> = {};
        for (const e of EFFECTS) {
          try {
            out[e.id] = await applyEffect(small, e.id);
          } catch { /* skip that tile */ }
        }
        if (live) setEffectPreviews((prev) => ({ ...prev, [selUploadId]: out }));
      } catch { /* no previews - tiles fall back to labels */ }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selUploadId]);


  // z-order: placements render in array order, so reordering the array is
  // the whole feature - one step forward/back per press
  const reorderSelected = (dir: 1 | -1) => {
    if (!sel) return;
    const i = placements.findIndex((p) => p.id === sel.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= placements.length) return;
    pushHistory();
    setPlacements((ps) => {
      const next = [...ps];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  // ── production files: trace the selected design to a real cut file ────
  const [prodExport, setProdExport] = useState<null | {
    name: string;
    svg: string;
    widthIn: number;
    heightIn: number;
    pieces: number;
    smallCount: number;
    smallSizes: number[];
    artworkURL: string;
  }>(null);
  const openProduction = async (target?: Placement) => {
    const p = target ?? sel;
    if (!p) return;
    const u = uploadById.get(p.uploadId);
    if (!u) return;
    try {
      const src = p.thread ? await recolorTo(u, p.thread.hex) : u.dataURL;
      const img = await loadImage(src);
      const maxSide = 1200; // tracing resolution - plenty for cut paths
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
      c.height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      const widthMm = p.inches * 25.4;
      const { svg, islands } = traceToSvg(data, c.width, c.height, widthMm, {
        fill: p.thread?.hex ?? "#111111",
      });
      const warn = smallIslandWarnings(islands, c.width, widthMm);
      setProdExport({
        name: (u.name || "design").replace(/\.[a-z0-9]+$/i, "").replace(/[^\w-]+/g, "-").slice(0, 40) || "design",
        svg,
        widthIn: p.inches,
        heightIn: Math.round(p.inches * u.aspect * 100) / 100,
        pieces: islands.length,
        smallCount: warn.count,
        smallSizes: warn.sizesMm.slice(0, 6),
        artworkURL: src,
      });
    } catch {
      showNotice("Couldn't trace that design - try a cleaned-up version.");
    }
  };
  const downloadCutSvg = () => {
    if (!prodExport) return;
    saveBlob(
      new Blob([prodExport.svg], { type: "image/svg+xml" }),
      `${prodExport.name}-cut-${prodExport.widthIn}in.svg`
    );
  };
  const downloadArtworkPng = async () => {
    if (!prodExport) return;
    try {
      // Rasterize through a canvas instead of re-fetching the source URL:
      // generated shapes and imported SVGs arrive as SVG data URLs (fetching
      // those saved an SVG mislabeled .png, or failed outright in some
      // browsers). Drawing guarantees a true transparent PNG at the stated
      // physical size, tagged 300ppi.
      const img = await loadImage(prodExport.artworkURL).catch(() => {
        throw new Error("the artwork image didn't load");
      });
      const aspect = (img.naturalHeight || 1) / (img.naturalWidth || 1);
      const wPx = Math.max(4, Math.min(4000, Math.round(prodExport.widthIn * 300)));
      const hPx = Math.max(4, Math.round(wPx * aspect));
      const c = document.createElement("canvas");
      c.width = wPx;
      c.height = hPx;
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("no canvas context");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, wPx, hPx);
      const blob = await new Promise<Blob>((res, rej) => {
        try {
          c.toBlob((b) => (b && b.size > 100 ? res(b) : rej(new Error("empty image"))), "image/png");
        } catch (e) {
          rej(e);
        }
      });
      const { tagPngPpi } = await import("../stitchlab/lib/png");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const tagged = new Blob([tagPngPpi(bytes, 300) as BlobPart], { type: "image/png" });
      await saveBlob(tagged, `${prodExport.name}-artwork-${prodExport.widthIn}in-300ppi.png`);
      showNotice("Artwork PNG downloaded.");
    } catch (e) {
      const why = e instanceof Error && e.message ? ` (${e.message.slice(0, 50)})` : "";
      showNotice(`Couldn't export the artwork${why} - try again.`);
    }
  };

  // ── production warnings - informational, never blocking ──────────────
  const selWarnings: string[] = [];
  if (sel) {
    if (sel.inches > 12) {
      selWarnings.push(
        "This is a large design area - production at this size may need special setup."
      );
    }
    if (uploadById.get(sel.uploadId)?.textMeta && sel.inches < 2.5) {
      selWarnings.push(
        "Lettering this small can be hard to produce cleanly - consider sizing up."
      );
    }
  }
  const warningsBlock = selWarnings.length ? (
    <div className="flex flex-col gap-1">
      {selWarnings.map((w) => (
        <p key={w} className="text-[0.6875rem] text-mid leading-snug">
          ⚠ {w}
        </p>
      ))}
    </div>
  ) : null;



  // desktop keyboard: ⌘/Ctrl-Z undo (shift = redo); with a selection, arrows
  // nudge, delete removes, escape deselects - ref keeps closures fresh without
  // re-registering the listener every render
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  const lastNudgePush = useRef(0);
  keyHandlerRef.current = (e: KeyboardEvent) => {
    if (isMobile || tab !== "studio") return;
    // A modal/dialog is open: never let canvas shortcuts (Delete, arrow-nudge,
    // undo) act on the artwork hidden behind it. Several of these dialogs have
    // no text field to absorb the keypress, so without this guard pressing
    // Backspace over the dialog silently deletes the selected design.
    if (
      showLogin || showGuide || showAbout || tour !== null ||
      bgReview || browseOpen || prodExport || newConfirm || saveMenu
    )
      return;
    const t = e.target as HTMLElement | null;
    if (
      t &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.tagName === "SELECT" ||
        t.isContentEditable)
    )
      return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (!sel) return;
    if (e.key === "Escape") {
      setSelected(null);
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      remove(sel.id);
      return;
    }
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const a = arrows[e.key];
    if (a) {
      e.preventDefault();
      const step = e.shiftKey ? 0.02 : 0.004;
      const now = Date.now();
      if (now - lastNudgePush.current > 800) pushHistory(); // one undo step per burst
      lastNudgePush.current = now;
      update(sel.id, {
        x: clamp(sel.x + a[0] * step, BOUNDS.minX, BOUNDS.maxX),
        y: clamp(sel.y + a[1] * step, BOUNDS.minY, BOUNDS.maxY),
      });
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // selecting a placed design switches the secondary row to its controls;
  // deselecting restores whatever tool was open before
  const hasSel = Boolean(sel);
  useEffect(() => {
    if (!isMobile) return;
    setConfirmRemove(false);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    if (hasSel) {
      if (!stashedNav.current)
        stashedNav.current = { tab: activeTab, detail: activeDetail };
      setActiveDetail("size"); // the most-used control opens immediately
    } else if (stashedNav.current) {
      setActiveTab(stashedNav.current.tab);
      setActiveDetail(stashedNav.current.detail);
      stashedNav.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSel, isMobile]);


  // Mobile Safari caps canvas *area* (~16.7M px on modern iOS, less on older
  // devices); a 4000px-wide portrait garment (~19M px) silently produces a
  // blank/failed encode -> "Snapshot failed". Clamp export area in addition
  // to the width cap.
  const MAX_CANVAS_AREA = 12_000_000;
  const compositeCanvas = async (
    maxWidth: number,
    forView: "front" | "back",
    background: "transparent" | "white" = "transparent"
  ): Promise<HTMLCanvasElement> => {
    const img = forView === "back" && color.back ? color.back : color.front;
    const base = await loadImage(img).catch(() => {
      throw new Error("garment image didn't load");
    });
    const aspect = base.naturalHeight / base.naturalWidth;
    const areaCapWidth = Math.sqrt(MAX_CANVAS_AREA / Math.max(aspect, 0.0001));
    const scale = Math.min(1, maxWidth / base.naturalWidth, areaCapWidth / base.naturalWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(base.naturalWidth * scale);
    canvas.height = Math.round(base.naturalHeight * scale);
    const ctx = canvas.getContext("2d")!;
    if (background === "white") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
    for (const p of placements.filter((x) => (x.view ?? "front") === forView)) {
      const u = uploadById.get(p.uploadId);
      if (!u) continue;
      // durable-first loading: thread recolor -> plain dataURL -> url; a
      // single bad variant must not sink the whole export
      let src = u.dataURL || u.url;
      if (p.thread) src = await recolorTo(u, p.thread.hex).catch(() => u.dataURL || u.url);
      const art = await loadImage(src).catch(() =>
        loadImage(u.url).catch(() => {
          throw new Error("a placed design didn't load");
        })
      );
      const w = p.inches * inchFraction(garment) * canvas.width;
      const h = w * u.aspect;
      const passes = p.blend && p.blend !== "normal" ? (p.passes ?? 3) : 1;
      for (let i = 0; i < passes; i++) {
        ctx.save();
        ctx.globalCompositeOperation =
          p.blend && p.blend !== "normal"
            ? (p.blend as GlobalCompositeOperation)
            : "source-over";
        ctx.translate(p.x * canvas.width, p.y * canvas.height);
        if (p.rotation) ctx.rotate((p.rotation * Math.PI) / 180);
        if (p.flip) ctx.scale(-1, 1);
        ctx.drawImage(art, -w / 2, -h / 2, w, h);
        ctx.restore();
      }
    }
    return canvas;
  };

  // dataURL variant for thumbnails (small sizes only)
  const composite = async (maxWidth: number, forView: "front" | "back"): Promise<string> => {
    const canvas = await compositeCanvas(maxWidth, forView);
    const out = canvas.toDataURL("image/png", 0.9);
    // Safari returns "data:," (or a stub) when it silently fails the encode.
    if (out.length < 100) throw new Error("canvas encode failed");
    return out;
  };

  // canvas -> PNG blob, verified non-empty (Safari can silently produce null
  // or a stub blob past its canvas limits — treat that as a retryable failure)
  const canvasBlob = (c: HTMLCanvasElement): Promise<Blob> =>
    new Promise((res, rej) => {
      try {
        c.toBlob((b) => (b && b.size > 200 ? res(b) : rej(new Error("empty encode"))), "image/png");
      } catch (e) {
        rej(e);
      }
    });

  // Try progressively smaller exports so a device canvas limit degrades to a
  // slightly smaller file instead of a hard failure. Blob path (no giant
  // base64 strings). PNG keeps the transparent background and is tagged as a
  // true 300ppi print file; JPEG flattens onto white (no alpha in JPEG).
  const compositeSafeBlob = async (
    forView: "front" | "back",
    format: "png" | "jpeg"
  ): Promise<Blob> => {
    let lastErr: unknown;
    // Phones start smaller: a 4000px multi-layer composite can take long
    // enough that the share sheet's user-gesture window expires.
    for (const w of isMobile ? [2400, 1600, 1000] : [4000, 2400, 1600, 1000]) {
      try {
        const canvas = await compositeCanvas(w, forView, format === "jpeg" ? "white" : "transparent");
        if (format === "jpeg") {
          return await new Promise<Blob>((res, rej) => {
            try {
              canvas.toBlob((b) => (b && b.size > 200 ? res(b) : rej(new Error("empty encode"))), "image/jpeg", 0.92);
            } catch (e) {
              rej(e);
            }
          });
        }
        const blob = await canvasBlob(canvas);
        const { tagPngPpi } = await import("../stitchlab/lib/png");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return new Blob([tagPngPpi(bytes, 300) as BlobPart], { type: "image/png" });
      } catch (e) {
        lastErr = e;
        // asset-load failures won't improve at smaller sizes - fail fast with
        // the real reason instead of retrying four times
        if (e instanceof Error && /didn't load/.test(e.message)) throw e;
      }
    }
    throw lastErr ?? new Error("snapshot failed");
  };

  const exportSnapshot = async (format: "png" | "jpeg" = "png") => {
    try {
      const blob = await compositeSafeBlob(view, format);
      const name =
        format === "jpeg"
          ? `bayside-${garment.id}-${color.slug}-${view}.jpg`
          : `bayside-${garment.id}-${color.slug}-${view}-300ppi.png`;
      // On touch devices, the share sheet is the only web path into the
      // photo library ("Save Image" on iOS) - fall back to a download.
      const nav = navigator as Navigator & {
        canShare?: (d: { files: File[] }) => boolean;
      };
      if (isMobile && typeof nav.canShare === "function") {
        try {
          const file = new File([blob], name, { type: format === "jpeg" ? "image/jpeg" : "image/png" });
          if (nav.canShare({ files: [file] })) {
            await navigator.share({ files: [file] } as ShareData);
            onboardTo(5);
            showNotice("Shared - choose Save Image to keep it in Photos.");
            return;
          }
        } catch (e) {
          if ((e as Error).name === "AbortError") {
            showNotice("Export canceled."); // explicit, so a closed sheet isn't a mystery
            return;
          }
          // share exists but refused (expired gesture, unsupported type):
          // say so and fall through to a normal download
          showNotice("Sharing isn't available here - downloading instead.");
        }
      }
      await saveBlob(blob, name);
      onboardTo(5);
      showNotice(isMobile ? "Image downloaded - check your Files/Downloads." : "Image downloaded.");
    } catch (e) {
      // surface the actual reason - "failed, try again" told us nothing
      const why = e instanceof Error && e.message ? ` (${e.message.slice(0, 60)})` : "";
      showNotice(`Snapshot failed${why} - try again.`);
    }
  };

  // ── draft autosave: the live canvas survives anything ────────────────
  // Refresh, crash, expired session, a week between visits - the working
  // state snapshots to IndexedDB a beat after every change and is restored
  // on the next open. Explicit "save idea" remains the durable, synced copy.
  const draftReady = useRef(false); // block writes until the restore attempt ran
  useEffect(() => {
    (async () => {
      try {
        const d = await getDraft();
        if (d && d.placements.length) {
          setGarmentId(d.garmentId);
          setColorSlug(d.colorSlug);
          setView(d.view);
          setUploads(d.uploads.map((u) => ({ ...u, url: u.dataURL })));
          setPlacements(d.placements.map((p) => ({ ...p, view: p.view ?? "front" })));
          setEditingId(d.editingId);
          setIdeaName(d.ideaName);
          setCollection(d.collection);
          setQty(d.qty);
          setIdeaNotes(d.ideaNotes);
          setNextNote(d.nextNote ?? "");
          setIdeaThreads(d.threads);
          showNotice(
            d.nextNote
              ? `Continuing where you left off. Your note: ${d.nextNote}`
              : "Continuing where you left off."
          );
        }
      } catch {
        /* no draft is fine */
      } finally {
        draftReady.current = true;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // silent library autosave - a beat slower than the device draft
  useEffect(() => {
    if (!draftReady.current || !placements.length) return;
    if (authToken && !syncReady.current) return; // post-sign-in load not done yet
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      void saveIdeaRef.current(true);
    }, 4000);
    return () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placements, uploads, garmentId, colorSlug, ideaName, collection, qty, ideaNotes, nextNote, ideaThreads]);
  useEffect(() => {
    cancelPendingWritesRef.current = () => {
      if (syncTimer.current) clearTimeout(syncTimer.current);
      if (fontSyncTimer.current) clearTimeout(fontSyncTimer.current);
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
    showNoticeRef.current = showNotice;
  });
  useEffect(() => {
    if (!draftReady.current) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      const usedIds = new Set(placements.map((p) => p.uploadId));
      void putDraft({
        id: "current",
        garmentId,
        colorSlug,
        view,
        // only placed artwork - bounds the draft; unplaced uploads live in
        // the account library anyway
        uploads: uploads
          .filter((u) => usedIds.has(u.id))
          .map(({ id, name, dataURL, aspect, textMeta }) => ({
            id,
            name,
            dataURL,
            aspect,
            ...(textMeta ? { textMeta } : {}),
          })),
        placements,
        editingId,
        ideaName,
        collection,
        qty,
        ideaNotes,
        nextNote,
        threads: ideaThreads,
        updatedAt: Date.now(),
      }).catch(() => {});
    }, 2000);
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, [placements, uploads, garmentId, colorSlug, view, editingId, ideaName, collection, qty, ideaNotes, nextNote, ideaThreads]);

  // ── save / load ideas ────────────────────────────────────────────────
  // Saving is automatic: the canvas persists itself into the library a few
  // seconds after every change (silent). The manual button (mobile drawer)
  // calls the same path with feedback.
  // "Save design" sheet: library save (with account upsell) + PNG/JPEG export
  const [saveMenu, setSaveMenu] = useState(false);
  const [saveMenuBusy, setSaveMenuBusy] = useState<null | "library" | "png" | "jpeg">(null);

  const savingRef = useRef(false);
  const saveIdea = async (silent = false): Promise<boolean> => {
    if (!placements.length) {
      if (!silent) showNotice("Place something first.");
      return false;
    }
    // Re-entrancy guard shared by the manual button AND the silent autosave.
    // Without it, a manual save and an autosave firing at the same instant both
    // read editingId===null and each mint a different id -> two records for one
    // design. Whichever save is already running will persist the current state.
    if (savingRef.current) return false;
    savingRef.current = true;
    if (!silent) setSaving(true);
    try {
      const usedIds = new Set(placements.map((p) => p.uploadId));
      const existing = editingId ? ideas.find((i) => i.id === editingId) : null;
      const idea: Idea = {
        id: editingId ?? uid(),
        name: ideaName.trim() || `Idea ${new Date().toLocaleDateString()}`,
        collection: collection.trim(),
        status: existing?.status ?? "idea",
        qty: Math.max(1, parseInt(qty, 10) || 1),
        garmentId,
        colorSlug,
        placements,
        uploads: uploads
          .filter((u) => usedIds.has(u.id))
          // keep textMeta so reopened text stays editable (font/style/word)
          .map(({ id, name, dataURL, aspect, textMeta }) => ({
            id,
            name,
            dataURL,
            aspect,
            ...(textMeta ? { textMeta } : {}),
          })),
        threads: ideaThreads,
        notes: ideaNotes,
        nextNote: nextNote.trim() || undefined,
        // the thumbnail is nice-to-have - a failed render must never kill the save
        thumb: await composite(480, "front").catch(() => existing?.thumb ?? ""),
        costEach: existing?.costEach,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      };
      await putIdea(idea);
      setEditingId(idea.id);
      await refreshIdeas();
      scheduleSync();
      onboardTo(5);
      if (!silent) {
        showNotice(
          existing
            ? "Saved."
            : authToken
              ? "Saved and synced to your account."
              : "Saved on this device - sign in to access it on other devices."
        );
      }
      if (!silent) setSaving(false);
      return true;
    } catch (e) {
      console.error("[lab] save failed:", e);
      if (!silent) {
        showNotice("Save failed - try again. If it keeps happening, download an image so nothing is lost.");
        setSaving(false);
      }
      return false;
    } finally {
      savingRef.current = false;
    }
  };
  // keep a stable reference for the autosave timer below
  const saveIdeaRef = useRef(saveIdea);
  useEffect(() => {
    saveIdeaRef.current = saveIdea;
  });

  // "Save design" sheet actions: library save (with account upsell) + PNG/JPEG export
  const saveMenuAction = async (kind: "library" | "png" | "jpeg") => {
    if (saveMenuBusy) return;
    setSaveMenuBusy(kind);
    try {
      if (kind === "library") {
        const ok = await saveIdea(true);
        if (!ok) {
          showNotice("Place something on the garment first.");
          return;
        }
        setSaveMenu(false);
        if (authToken) {
          showNotice("Saved to your library.");
        } else {
          // Local saves complete on their own - never interrupt with the
          // sign-in modal. Syncing stays an explicit choice (the save panel's
          // "Sign in to sync" button).
          showNotice("Saved on this device. Sign in any time to sync it across devices.");
        }
      } else {
        await exportSnapshot(kind); // reports its own success/failure
        setSaveMenu(false);
      }
    } finally {
      setSaveMenuBusy(null);
    }
  };

  const loadIdea = (idea: Idea) => {
    setGarmentId(idea.garmentId);
    setColorSlug(idea.colorSlug);
    setUploads(idea.uploads.map((u) => ({ ...u, url: u.dataURL })));
    setPlacements(idea.placements.map((p) => ({ ...p, view: p.view ?? "front" })));
    setEditingId(idea.id);
    setIdeaName(idea.name);
    setCollection(idea.collection);
    setQty(String(idea.qty));
    setIdeaNotes(idea.notes);
    setNextNote(idea.nextNote ?? "");
    setIdeaThreads(idea.threads);
    setSelected(null);
    setArmed(null);
    setView("front");
    setTab("studio");
    clearHistory(); // fresh idea, fresh undo timeline
    if (idea.nextNote) showNotice(`Your note: ${idea.nextNote}`);
  };

  const newIdea = async () => {
    // flush the design being left so its last few seconds of edits are saved,
    // and cancel queued timers so nothing fires after the canvas clears
    cancelPendingWritesRef.current();
    if (placements.length) await saveIdea(true);
    clearHistory();
    setEditingId(null);
    setIdeaName("");
    setCollection("");
    setQty("1");
    setIdeaNotes("");
    setNextNote("");
    setIdeaThreads([]);
    setPlacements([]);
    setSelected(null);
    setUploads((us) => us); // uploads stay - they're the student's materials
    void clearDraft().catch(() => {});
    showNotice("Fresh canvas - your last design is safe in Saved ideas.");
  };

  // "Start new" is a two-step ceremony: offer to save the current design,
  // then a separate explicit button clears the canvas. (A silent flush still
  // runs underneath as a seatbelt - the dialog is about clarity, not risk.)
  const [newConfirm, setNewConfirm] = useState<null | { saved: boolean }>(null);
  const startNewFlow = () => {
    if (!placements.length) {
      void newIdea();
      return;
    }
    setNewConfirm({ saved: false });
  };

  // copy a project (e.g. to try the same design on a different garment)
  const duplicateIdea = async (idea: Idea) => {
    const copy: Idea = {
      ...idea,
      id: uid(),
      name: `${idea.name} copy`,
      status: "idea",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await putIdea(copy);
    await refreshIdeas();
    scheduleSync();
    showNotice(`Duplicated as "${copy.name}".`);
  };

  const setStatus = async (idea: Idea, status: "idea" | "queued") => {
    await putIdea({ ...idea, status, updatedAt: Date.now() });
    await refreshIdeas();
    scheduleSync();
  };

  const setCost = async (idea: Idea, costEach: number) => {
    await putIdea({ ...idea, costEach, updatedAt: idea.updatedAt });
    await refreshIdeas();
    scheduleSync();
  };

  const removeIdea = async (idea: Idea) => {
    if (!confirm(`Delete "${idea.name}"? This can't be undone.`)) return;
    await deleteIdea(idea.id);
    pendingDeletes.current.add(idea.id); // tombstone so the delete propagates
    if (editingId === idea.id) setEditingId(null);
    await refreshIdeas();
    scheduleSync();
  };

  // thread searches (idea-level and placement-level share the data)
  const searchThreads = (q: string, exclude: IdeaThread[] = []) => {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    return THREADS.filter(
      (t) =>
        t.hex &&
        (t.code.includes(query) || t.name.toLowerCase().includes(query)) &&
        !exclude.some((x) => x.code === t.code && x.name === t.name)
    ).slice(0, 8);
  };
  const threadMatches = useMemo(
    () => searchThreads(threadQuery, ideaThreads),
    [threadQuery, ideaThreads]
  );
  // palette for recoloring the selected placement, grouped by family
  const paletteFamilies = useMemo(
    () =>
      THREAD_FAMILIES.map((family) => ({
        family,
        threads: THREADS.filter((t) => t.family === family && t.hex),
      })).filter((f) => f.threads.length),
    []
  );

  const queued = ideas.filter((i) => i.status === "queued");
  const orderPlan = useMemo(() => {
    const brands = new Map<
      string,
      {
        lines: Map<
          string,
          { garment: LabGarment; variant?: string; qty: number; cost: number; ideas: Idea[] }
        >;
      }
    >();
    for (const idea of queued) {
      const g = garmentById(idea.garmentId);
      if (!g) continue;
      // pigment-dye colorways cost more - give them their own order line
      const special = g.colorCosts?.[idea.colorSlug] != null;
      const key = special ? `${g.id}:${idea.colorSlug}` : g.id;
      const b = brands.get(g.brand) ?? { lines: new Map() };
      const line = b.lines.get(key) ?? {
        garment: g,
        variant: special
          ? g.colors.find((c) => c.slug === idea.colorSlug)?.name
          : undefined,
        qty: 0,
        cost: idea.costEach ?? costFor(g, idea.colorSlug),
        ideas: [],
      };
      line.qty += idea.qty;
      if (idea.costEach != null) line.cost = idea.costEach;
      line.ideas.push(idea);
      b.lines.set(key, line);
      brands.set(g.brand, b);
    }
    return brands;
  }, [queued]);

  const [pipelineFilter, setPipelineFilter] = useState<string | null>(null);
  const shownIdeas = pipelineFilter
    ? ideas.filter((i) => i.collection === pipelineFilter)
    : ideas;

  // ── cost explorer (youth) - how clothing pricing actually works ──────
  // Teaching tool, not a quote: real blank costs where the data exists,
  // clearly-labeled typical ranges for decoration. Tune COST_METHODS with
  // real studio numbers as they're confirmed.
  const [costIdeaId, setCostIdeaId] = useState<string | null>(null);
  const [costMethod, setCostMethod] = useState<"vinyl" | "screen" | "embroidery">("vinyl");
  const [costQty, setCostQty] = useState(12);
  const [costSell, setCostSell] = useState(40);
  const [costGarmentId, setCostGarmentId] = useState<string | null>(null);
  const costGarment = garmentById(costGarmentId ?? garmentId) ?? garment;
  const costBlank =
    costGarment.colorCosts?.[costGarment.id === garment.id ? colorSlug : ""] ??
    costGarment.defaultCost ??
    0;
  const costModel = COST_METHODS[costMethod];
  const costSetupMid = (costModel.setupLo + costModel.setupHi) / 2;
  const costPieceMid = (costModel.pieceLo + costModel.pieceHi) / 2;
  const costPerPiece =
    costBlank + costPieceMid + (costQty > 0 ? costSetupMid / costQty : 0);
  const costTotal = costPerPiece * costQty;

  // ── admin overview: signups + staff grants ───────────────────────────
  type OverviewUser = { email: string; created: number; staff: boolean; admin: boolean };
  const [overviewUsers, setOverviewUsers] = useState<OverviewUser[] | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  useEffect(() => {
    if (tab !== "overview" || !authToken || !role.admin) return;
    setOverviewError(null);
    api({ action: "users", token: authToken })
      .then((d) => setOverviewUsers((d.users ?? []) as OverviewUser[]))
      .catch((e) => setOverviewError(String((e as Error).message)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, authToken, role.admin]);

  type WorkView = { email: string; ideas: { id: string; name: string; thumb?: string; qty?: number; status?: string }[]; libraryCount: number; stitchlabCount: number };
  const [workView, setWorkView] = useState<WorkView | null>(null);
  const viewWork = async (email: string) => {
    try {
      const d = (await api({ action: "user-work", token: authToken, email })) as unknown as Omit<WorkView, "email">;
      setWorkView({ email, ideas: (d.ideas ?? []) as WorkView["ideas"], libraryCount: d.libraryCount ?? 0, stitchlabCount: d.stitchlabCount ?? 0 });
    } catch (e) {
      showNotice(String((e as Error).message));
    }
  };

  // ── admin: curated image-library sources (Flickr albums/galleries) ────
  const [srcCfg, setSrcCfg] = useState<LibrarySource[] | null>(null);
  const [srcConfigured, setSrcConfigured] = useState(true);
  const [srcBusy, setSrcBusy] = useState(false);
  const [syncReport, setSyncReport] = useState<string | null>(null);
  const [newSrc, setNewSrc] = useState({ id: "", ownerId: "", title: "", category: "", tags: "", type: "album", ownContent: false });
  useEffect(() => {
    if (tab !== "overview" || !authToken || !role.admin || srcCfg) return;
    fetch(`${apiBase()}/api/flickr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "sources", token: authToken }),
    })
      .then((r) => r.json())
      .then((d) => {
        setSrcCfg((d.sources ?? []) as LibrarySource[]);
        setSrcConfigured(Boolean(d.configured));
      })
      .catch(() => setSrcCfg([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, authToken, role.admin]);
  const saveSources = async (next: LibrarySource[]) => {
    setSrcBusy(true);
    try {
      const r = await fetch(`${apiBase()}/api/flickr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-sources", token: authToken, sources: next }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "save failed");
      setSrcCfg(d.sources as LibrarySource[]);
      setLibAssets(null); // youth view refetches next open
      showNotice("Library sources saved.");
    } catch (e) {
      showNotice(String((e as Error).message));
    }
    setSrcBusy(false);
  };
  const runLibrarySync = async () => {
    setSrcBusy(true);
    setSyncReport(null);
    try {
      const r = await fetch(`${apiBase()}/api/flickr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync", token: authToken }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "sync failed");
      const diags = (d.diagnostics ?? []) as { title: string; kept: number; fetched: number; skippedLicense: number; error?: string }[];
      setSyncReport(
        `${d.total} images live. ` +
          diags
            .map((x) => `${x.title}: ${x.kept}/${x.fetched}${x.skippedLicense ? ` (${x.skippedLicense} skipped for license)` : ""}${x.error ? ` - ERROR: ${x.error}` : ""}`)
            .join(" · ")
      );
      setLibAssets(null);
    } catch (e) {
      setSyncReport(String((e as Error).message));
    }
    setSrcBusy(false);
  };

  const setStaffFor = async (email: string, staff: boolean) => {
    try {
      const d = await api({ action: "set-staff", token: authToken, email, staff });
      setOverviewUsers((d.users ?? []) as OverviewUser[]);
    } catch (e) {
      showNotice(String((e as Error).message));
    }
  };

  // ─────────────────────────────────────────────────────────────────────
  // shared tool-panel bodies - the desktop accordion column and the mobile
  // bottom sheets render the same content; only one tree is mounted at a time
  // uniform control chip - filled when active, quiet otherwise
  const chip = (active?: boolean, extra = "") =>
    `inline-flex items-center gap-1.5 border px-2.5 py-1.5 text-[0.75rem] whitespace-nowrap cursor-pointer transition-colors ${
      active
        ? "border-fg bg-fg text-bg"
        : "border-hairline text-mid hover:border-fg hover:text-fg"
    } ${extra}`;
  const stepInches = (d: number) => {
    if (!sel || sel.locked) return;
    pushHistory();
    update(sel.id, {
      inches: clamp(Math.round((sel.inches + d) * 10) / 10, MIN_IN, MAX_IN),
    });
  };

  const selControlsBody = sel ? (
    <>
                {/* what's selected - bigger thumb, real dimensions, Remove */}
                <div className="flex items-center gap-3 pb-2 border-b border-hairline">
                  <span className="w-14 h-14 shrink-0 border border-hairline bg-card p-1.5">
                    <img
                      src={renderUrls[sel.id] ?? uploadById.get(sel.uploadId)?.url}
                      alt=""
                      className="w-full h-full object-contain"
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block font-medium truncate text-[0.9375rem]">
                      {uploadById.get(sel.uploadId)?.name}
                    </strong>
                    <span className="block mt-0.5 text-[0.75rem] text-mid">
                      {sel.inches}&Prime; ×{" "}
                      {Math.round(sel.inches * (uploadById.get(sel.uploadId)?.aspect ?? 1) * 10) / 10}
                      &Prime; · {(sel.view ?? "front") === "front" ? "front" : "back"}
                      {sel.locked ? " · size locked" : ""}
                    </span>
                  </span>
                  <button
                    type="button"
                    title="Remove this design from the garment (it stays in My designs)"
                    onClick={() => remove(sel.id)}
                    className="shrink-0 inline-flex items-center gap-1.5 border border-[#c0392b]/40 px-2.5 py-2 text-[0.75rem] text-[#c0392b] whitespace-nowrap hover:bg-[#c0392b] hover:border-[#c0392b] hover:text-white cursor-pointer transition-colors"
                  >
                    Remove ×
                  </button>
                </div>

                {/* ── size & position ── */}
                <div className="flex flex-col gap-2">
                  <span className={LABEL}>Size &amp; position</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-stretch border border-hairline">
                      <button
                        type="button"
                        aria-label="Smaller"
                        disabled={Boolean(sel.locked) || sel.inches <= MIN_IN}
                        onClick={() => stepInches(-0.5)}
                        className="w-9 text-[1rem] text-mid hover:text-fg disabled:opacity-35 cursor-pointer"
                      >
                        −
                      </button>
                      <input
                        type="number"
                        min={MIN_IN}
                        max={MAX_IN}
                        step={0.1}
                        value={sel.inches}
                        disabled={Boolean(sel.locked)}
                        onFocus={pushHistory}
                        onChange={(e) =>
                          update(sel.id, {
                            inches: clamp(Number(e.target.value) || MIN_IN, MIN_IN, MAX_IN),
                          })
                        }
                        aria-label="Width (inches)"
                        className="w-16 bg-bg border-x border-hairline px-1 py-2 text-center text-[0.9375rem] text-fg outline-none focus:border-fg disabled:opacity-40 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                      <button
                        type="button"
                        aria-label="Larger"
                        disabled={Boolean(sel.locked) || sel.inches >= MAX_IN}
                        onClick={() => stepInches(0.5)}
                        className="w-9 text-[1rem] text-mid hover:text-fg disabled:opacity-35 cursor-pointer"
                      >
                        +
                      </button>
                    </span>
                    <span className="text-[0.8125rem] text-mid">inches wide</span>
                    <button
                      type="button"
                      aria-pressed={Boolean(sel.locked)}
                      title="Lock this size - stops accidental resizing; dragging only moves the design"
                      onClick={() => {
                        pushHistory();
                        update(sel.id, { locked: !sel.locked });
                      }}
                      className={`ml-auto ${chip(Boolean(sel.locked))}`}
                    >
                      {sel.locked ? "✓ Size locked" : "Lock size"}
                    </button>
                  </div>
                  <p className="text-[0.6875rem] text-dim">
                    {sel.locked
                      ? "Size is locked - dragging only moves the design."
                      : "You can also drag a corner of the design on the garment."}
                  </p>
                  <div className="flex items-center gap-2.5">
                    <input
                      type="range"
                      min={-180}
                      max={180}
                      step={1}
                      value={sel.rotation ?? 0}
                      onPointerDown={pushHistory}
                      onChange={(e) => update(sel.id, { rotation: Number(e.target.value) })}
                      aria-label="Rotation in degrees"
                      className="flex-1 min-w-[5rem] accent-fg"
                    />
                    <span className="w-10 text-right text-[0.8125rem] text-mid tabular-nums">
                      {Math.round(sel.rotation ?? 0)}°
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={!sel.rotation}
                      onClick={() => {
                        pushHistory();
                        update(sel.id, { rotation: 0 });
                      }}
                      className={chip(false, "disabled:opacity-35")}
                    >
                      Straighten
                    </button>
                    <button
                      type="button"
                      title="Mirror the design horizontally"
                      onClick={() => update(sel.id, { flip: !sel.flip })}
                      className={chip(Boolean(sel.flip))}
                    >
                      ↔ Flip
                    </button>
                  </div>
                  {warningsBlock}
                </div>

                {/* ── color - swatch strip always visible, no accordion ── */}
                <div className="flex flex-col gap-2 border-t border-hairline pt-3">
                  <div className="flex items-center gap-2">
                    <span className={LABEL}>Color</span>
                    {sel.thread ? (
                      <span className="flex items-center gap-1.5 text-[0.75rem] text-mid min-w-0">
                        <span
                          className="w-3.5 h-3.5 shrink-0 rounded-full border border-hairline"
                          style={{ backgroundColor: sel.thread.hex }}
                        />
                        <span className="truncate">{sel.thread.name}</span>
                        <button
                          type="button"
                          aria-label="Back to the original colors"
                          title="Back to the original colors"
                          onClick={() => applyThreadToPlacement(sel, null)}
                          className="text-mid hover:text-fg cursor-pointer"
                        >
                          ×
                        </button>
                      </span>
                    ) : (
                      <span className="text-[0.75rem] text-dim">original colors</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 overflow-x-auto pb-1.5">
                    <button
                      type="button"
                      aria-label="Back to original colors"
                      title="Original colors"
                      onClick={() => applyThreadToPlacement(sel, null)}
                      className={`w-8 h-8 shrink-0 rounded-full border text-[0.5625rem] text-mid cursor-pointer ${
                        sel.thread ? "border-hairline hover:border-fg" : "border-fg ring-1 ring-fg"
                      }`}
                    >
                      orig
                    </button>
                    {paletteFamilies.map(({ family, threads }) => (
                      <div key={family} className="flex items-center gap-1.5">
                        <span className="shrink-0 text-[0.5625rem] tracking-[0.1em] uppercase text-dim [writing-mode:vertical-rl] rotate-180 py-0.5">
                          {family}
                        </span>
                        {threads.map((t) => {
                          const active = sel.thread?.code === t.code && sel.thread?.hex === t.hex;
                          return (
                            <button
                              key={`${t.code}-${t.family}`}
                              type="button"
                              title={`${t.code} ${t.name}`}
                              aria-label={`Color ${t.code} ${t.name}`}
                              onClick={() =>
                                applyThreadToPlacement(sel, { code: t.code, name: t.name, hex: t.hex! })
                              }
                              className={`w-8 h-8 shrink-0 rounded-full border cursor-pointer ${
                                active
                                  ? "border-fg ring-2 ring-fg ring-offset-1 ring-offset-bg"
                                  : "border-hairline hover:border-fg"
                              }`}
                              style={{ backgroundColor: t.hex! }}
                            />
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>

                {/* ── effects - live previews of THIS design ── */}
                <div className="flex flex-col gap-2 border-t border-hairline pt-3">
                  <span className={LABEL}>Effects</span>
                  <div className="grid grid-cols-3 gap-1.5">
                    {EFFECTS.map((e) => {
                      const preview = effectPreviews[sel.uploadId]?.[e.id];
                      return (
                        <button
                          key={e.id}
                          type="button"
                          disabled={applyingEffect}
                          title={`${e.hint} - applies in place; the original stays in My designs`}
                          onClick={() => runEffect(e.id)}
                          className="border border-hairline hover:border-fg disabled:opacity-40 cursor-pointer p-1.5 flex flex-col items-center gap-1 transition-colors"
                        >
                          <span className="w-full aspect-square bg-card flex items-center justify-center overflow-hidden">
                            {preview ? (
                              <img src={preview} alt="" className="max-w-full max-h-full object-contain" />
                            ) : (
                              <span className="text-[0.9375rem] text-dim">…</span>
                            )}
                          </span>
                          <span className="text-[0.6875rem] text-mid leading-none">
                            {applyingEffect ? "…" : e.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[0.6875rem] text-dim">
                    Tap to apply - the original stays in My designs. Undo brings it back.
                  </p>
                </div>

                {/* ── text - only when this design came from the text tool ── */}
                {uploadById.get(sel.uploadId)?.textMeta ? (
                  <div className="flex flex-col gap-2 border-t border-hairline pt-3">
                    <span className={LABEL}>Text</span>
                    <button
                      type="button"
                      title="Reopen this text in the text tool - edit the words, style, curve, or outline"
                      onClick={() => editPlacedText(sel)}
                      className="w-full inline-flex items-center justify-center px-4 py-2.5 border border-fg text-[0.75rem] tracking-[0.06em] uppercase hover:bg-fg hover:text-bg transition-colors cursor-pointer"
                    >
                      ✎ Edit the words &amp; style
                    </button>
                    <div className="flex items-center gap-2">
                      <span className="text-[0.75rem] text-mid shrink-0">Font</span>
                      <select
                        value={uploadById.get(sel.uploadId)!.textMeta!.font}
                        onChange={(e) => void changeTextFont(sel, e.target.value)}
                        aria-label="Change text font"
                        className="flex-1 min-w-0 bg-bg border border-hairline px-2.5 py-2 text-[0.875rem] text-fg outline-none focus:border-fg"
                        style={{ fontFamily: `"${uploadById.get(sel.uploadId)!.textMeta!.font}"` }}
                      >
                        {fontChoices.map((f) => (
                          <option key={f.family} value={f.family}>
                            {f.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                ) : null}

                {/* ── files ── */}
                <div className="flex items-center gap-2 border-t border-hairline pt-3">
                  <button
                    type="button"
                    title="Trace this design into an SVG at its real size - a starting point for cutting or printing"
                    onClick={() => void openProduction()}
                    className={chip()}
                  >
                    Design files
                  </button>
                  <span className="text-[0.6875rem] text-dim">
                    SVG tracing &amp; transparent PNG
                  </span>
                </div>
    </>
  ) : null;

  const panelBody: Record<Exclude<SheetId, "design">, React.ReactNode> = {
    blanks: (
      <>
              {/* color choice lives in the floating palette on the canvas -
                  this is just the current state + a way to reopen it */}
              <div className="flex flex-wrap items-center gap-2">
                <span className={LABEL}>Color - {color.name}</span>
                {garment.colors.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => setColorPop(true)}
                    className="flex items-center gap-1.5 border border-hairline px-2 py-1 text-[0.75rem] text-mid hover:border-fg cursor-pointer"
                  >
                    <span
                      className="w-3.5 h-3.5 rounded-full border border-hairline"
                      style={{ backgroundColor: color.hex }}
                    />
                    Change color
                  </button>
                ) : null}
              </div>
              <p className="mt-2.5 text-[0.8125rem] text-mid leading-[1.6] border-l-2 border-hairline pl-3">
                <strong className="text-fg font-medium">{garment.label}.</strong>{" "}
                {garment.spec}
              </p>
              <span className={`mt-4 block ${LABEL}`}>Switch blank</span>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {visibleGarments.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => switchGarment(g)}
                    className={`flex items-center gap-2.5 text-left border p-2 cursor-pointer transition-colors ${
                      g.id === garment.id
                        ? "border-fg ring-1 ring-fg"
                        : "border-hairline hover:border-fg"
                    }`}
                  >
                    <img
                      src={g.colors[0].front}
                      alt=""
                      loading="lazy"
                      className="w-11 h-11 object-cover shrink-0 bg-card"
                    />
                    <span>
                      <span className="block text-[0.8125rem] leading-snug">
                        {g.label}
                      </span>
                      <span className="block mt-0.5 text-[0.6875rem] text-mid">{g.sub}</span>
                    </span>
                  </button>
                ))}
              </div>
      </>
    ),
    designs: (
      <>
              <div
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  addFiles(e.dataTransfer.files);
                }}
                className="mt-2 border-[1.5px] border-dashed border-hairline hover:border-fg transition-colors cursor-pointer p-4 text-center text-[0.8125rem] text-mid"
              >
                <strong className="text-fg font-medium">Drop PNGs or SVGs here</strong>{" "}
                or click to choose
              </div>
              {uploads.length ? (
                <div className="mt-3 grid grid-cols-4 sm:grid-cols-5 gap-2">
                  {uploads.map((u) => (
                    <div key={u.id} className="relative group">
                      <button
                        type="button"
                        title={u.name}
                        aria-pressed={armed === u.id}
                        onClick={() => {
                          placeCentered(u.id);
                          if (!isMobile) revealPreview();
                        }}
                        className={`w-full aspect-square border p-1.5 cursor-pointer bg-card transition-colors ${
                          armed === u.id
                            ? "border-fg ring-[1.5px] ring-fg ring-offset-2 ring-offset-bg"
                            : "border-hairline hover:border-fg"
                        }`}
                      >
                        <img src={u.url} alt={u.name} className="w-full h-full object-contain" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${u.name}`}
                        onClick={() => removeUpload(u.id)}
                        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-fg text-bg text-[0.6875rem] leading-none opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 transition-opacity cursor-pointer"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              {/* design library */}
              {authToken ? (
                <div className="mt-4">
                  <h3 className={LABEL}>Design library</h3>
                  {library.length === 0 ? (
                    <p className="mt-1.5 text-[0.75rem] text-dim">
                      Uploads save here automatically - reuse them in any idea.
                    </p>
                  ) : (
                    <div className="mt-2 grid grid-cols-5 sm:grid-cols-6 gap-1.5">
                      {library.map((item) => (
                        <div key={item.id} className="relative group">
                          <button
                            type="button"
                            title={`${item.name} - add to this session`}
                            onClick={() => addFromLibrary(item)}
                            className="w-full aspect-square border border-hairline hover:border-fg p-1 bg-card cursor-pointer"
                          >
                            <img
                              src={item.dataURL}
                              alt={item.name}
                              className="w-full h-full object-contain"
                            />
                          </button>
                          <button
                            type="button"
                            aria-label={`Remove ${item.name} from library`}
                            onClick={() => removeFromLibrary(item.id)}
                            className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-fg text-bg text-[0.625rem] leading-none opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 transition-opacity cursor-pointer"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <p className="mt-3 text-[0.75rem] text-dim">
                  Sign in and every upload lands in a design library you can
                  reuse across ideas and devices.
                </p>
              )}
      </>
    ),
    shapes: (
      <>
              <input
                value={shapeQuery}
                onChange={(e) => setShapeQuery(e.target.value)}
                placeholder="Search shapes…"
                aria-label="Search shapes"
                className={FIELD}
              />
              <div className="mt-2 grid grid-cols-5 sm:grid-cols-6 gap-1.5 max-h-56 max-md:max-h-none overflow-y-auto pr-1">
                {shownShapes.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    title={`${s.name} - add to designs`}
                    onClick={() => addShape(s)}
                    className="aspect-square border border-hairline hover:border-fg p-1 bg-card cursor-pointer"
                  >
                    <img
                      src={s.url}
                      alt={s.name}
                      loading="lazy"
                      className="w-full h-full object-contain"
                    />
                  </button>
                ))}
              </div>
      </>
    ),
    generators: (
      <>
              {genPreview && genPreview.id !== "type" ? (
                <div className="mb-2.5 border border-fg bg-card p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className={LABEL}>{genPreview.label} - preview</span>
                    <button
                      type="button"
                      aria-label="Discard this preview"
                      onClick={() => setGenPreview(null)}
                      className="text-mid hover:text-fg cursor-pointer text-[0.9375rem] leading-none"
                    >
                      ×
                    </button>
                  </div>
                  <div className="mt-2 flex items-stretch gap-2.5">
                    <span className="w-24 h-24 shrink-0 border border-hairline bg-bg p-1.5">
                      <img
                        src={genPreview.dataURL}
                        alt={`${genPreview.label} preview`}
                        className="w-full h-full object-contain"
                      />
                    </span>
                    <span className="flex-1 min-w-0 flex flex-col gap-1.5">
                      <button
                        type="button"
                        onClick={anotherMotif}
                        className="inline-flex items-center justify-center gap-2 px-3 py-2 border border-fg text-[0.75rem] tracking-[0.04em] uppercase hover:bg-fg hover:text-bg transition-colors cursor-pointer"
                      >
                        ↻ Another take
                      </button>
                      <button
                        type="button"
                        onClick={() => commitMotif(true)}
                        className="inline-flex items-center justify-center gap-2 px-3 py-2 bg-fg text-bg text-[0.75rem] tracking-[0.04em] uppercase hover:opacity-85 cursor-pointer"
                      >
                        Insert on garment
                      </button>
                      <button
                        type="button"
                        onClick={() => commitMotif(false)}
                        className="text-[0.75rem] text-mid underline underline-offset-2 hover:text-fg cursor-pointer"
                      >
                        Save for later instead
                      </button>
                    </span>
                  </div>
                </div>
              ) : (
                <p className="mb-2.5 text-[0.8125rem] text-mid leading-[1.5]">
                  Tap a style below to generate one - it shows up here first.
                  Keep rolling new takes; nothing lands on the garment until
                  you insert it.
                </p>
              )}
              {(() => {
                const tiles: React.ReactNode[] = GENERATORS.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    aria-pressed={genPreview?.id === g.id}
                    title={`Generate a ${g.label.toLowerCase()} - preview first, insert when you like one`}
                    onClick={() => previewMotif(g.id, g.label)}
                    className={`border p-2.5 text-left cursor-pointer transition-colors ${
                      genPreview?.id === g.id
                        ? "border-fg ring-1 ring-fg"
                        : "border-hairline hover:border-fg"
                    }`}
                  >
                    <span className="block text-[0.8125rem]">{g.label} ↻</span>
                    <span className="block mt-0.5 text-[0.6875rem] text-mid leading-snug">
                      {g.hint}
                    </span>
                  </button>
                ));
                const VISIBLE = 12; // 4 rows at the 3-column width
                const hidden = tiles.length - VISIBLE;
                return (
                  <>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {motifsExpanded ? tiles : tiles.slice(0, VISIBLE)}
                    </div>
                    {hidden > 0 ? (
                      <button
                        type="button"
                        aria-expanded={motifsExpanded}
                        onClick={() => setMotifsExpanded((x) => !x)}
                        className="mt-2 w-full border border-hairline px-3 py-2 text-[0.75rem] tracking-[0.06em] uppercase text-mid hover:border-fg hover:text-fg cursor-pointer transition-colors"
                      >
                        {motifsExpanded
                          ? "Show fewer shapes"
                          : `See ${hidden} more shapes`}
                      </button>
                    ) : null}
                  </>
                );
              })()}
              <p className="mt-2 text-[0.6875rem] text-dim">
                Generated designs work like any upload - place them, recolor
                them to a thread, run effects, and they save to your library.
              </p>
      </>
    ),
    artlib: (
      <>
              <div className="flex items-center gap-1.5">
                {(["library", "museums"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={artView === v}
                    onClick={() => setArtView(v)}
                    className={`border px-3 py-1.5 text-[0.75rem] tracking-[0.04em] uppercase cursor-pointer ${
                      artView === v ? "border-fg bg-fg text-bg" : "border-hairline text-mid hover:border-fg"
                    }`}
                  >
                    {v === "library" ? "Image library" : "Museums"}
                  </button>
                ))}
              </div>
              {artView === "library" ? (
                <>
                  <p className="mt-2 text-[0.8125rem] text-mid leading-[1.55]">
                    A collection picked for making things - tap an image to
                    bring it into your design.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      void loadLibrary();
                      setBrowseOpen("library");
                    }}
                    className="mt-2 w-full inline-flex items-center justify-center px-5 py-2.5 bg-fg text-bg text-[0.8125rem] tracking-[0.06em] uppercase hover:opacity-85 cursor-pointer"
                  >
                    Browse the collections
                  </button>
                  <input
                    value={libQuery}
                    onChange={(e) => setLibQuery(e.target.value)}
                    placeholder="Search images…"
                    aria-label="Search the image library"
                    className={`mt-2 ${FIELD}`}
                  />
                  {libCategories.length ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        aria-pressed={libCategory === null}
                        onClick={() => setLibCategory(null)}
                        className={`border px-2.5 py-1 text-[0.75rem] cursor-pointer ${
                          libCategory === null ? "border-fg bg-fg text-bg" : "border-hairline text-mid hover:border-fg"
                        }`}
                      >
                        All
                      </button>
                      {libCategories.map((c) => (
                        <button
                          key={c}
                          type="button"
                          aria-pressed={libCategory === c}
                          onClick={() => setLibCategory(libCategory === c ? null : c)}
                          className={`border px-2.5 py-1 text-[0.75rem] cursor-pointer ${
                            libCategory === c ? "border-fg bg-fg text-bg" : "border-hairline text-mid hover:border-fg"
                          }`}
                        >
                          {c}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {libError ? (
                    <p className="mt-3 text-[0.8125rem] text-mid">
                      {libError}{" "}
                      <button
                        type="button"
                        onClick={() => {
                          setLibAssets(null);
                          void loadLibrary();
                        }}
                        className="underline underline-offset-2 hover:text-fg cursor-pointer"
                      >
                        Retry
                      </button>
                    </p>
                  ) : libAssets === null ? (
                    <p className="mt-3 text-[0.8125rem] text-mid">Loading the library…</p>
                  ) : libResults.length === 0 ? (
                    <p className="mt-3 text-[0.8125rem] text-mid">
                      {libAssets.length === 0
                        ? libEmptyReason ?? "The library is empty right now."
                        : "No images found. Try another search."}
                    </p>
                  ) : (
                    <div className="mt-2.5 grid grid-cols-2 gap-2 max-h-[26rem] overflow-y-auto pr-1">
                      {libResults.map((a) => (
                        <div key={a.id} className="relative group border border-hairline hover:border-fg transition-colors">
                          <button
                            type="button"
                            disabled={artFetching !== null}
                            title={`${a.title} - tap to use in your design`}
                            onClick={() => void importLibraryAsset(a)}
                            className="block w-full text-left cursor-pointer disabled:opacity-50"
                          >
                            <span className="block aspect-square bg-card overflow-hidden">
                              <img
                                src={relayUrl(a.thumbUrl)}
                                alt={a.title}
                                loading="lazy"
                                className="w-full h-full object-cover"
                              />
                            </span>
                            <span className="block px-1.5 py-1">
                              <span className="block text-[0.6875rem] leading-tight truncate">
                                {artFetching === a.id ? "Adding to your design…" : a.title}
                              </span>
                              <span className="block text-[0.5625rem] text-dim truncate">
                                {attributionLine(a)}
                              </span>
                            </span>
                          </button>
                          <button
                            type="button"
                            aria-label={`Download ${a.title}`}
                            title="Download this image file"
                            onClick={() => void downloadLibraryAsset(a)}
                            className="absolute top-1 right-1 w-7 h-7 border border-hairline bg-bg/90 text-mid text-[0.8125rem] leading-none opacity-0 group-hover:opacity-100 focus:opacity-100 hover:border-fg hover:text-fg cursor-pointer"
                          >
                            ↓
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <p className="mt-2 text-[0.8125rem] text-mid leading-[1.55]">
                    Search free public-domain and openly licensed art from The Met, the Art Institute
                    of Chicago, the Cleveland Museum of Art, SMK Denmark, Wikimedia
                    Commons, and more - yours to use in your designs.
                  </p>
                  <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
                    <input
                      value={artQuery}
                      onChange={(e) => setArtQuery(e.target.value)}
                      placeholder="Try: tiger, dragon, roses, waves, skull…"
                      aria-label="Search public-domain and openly licensed art"
                      className={FIELD}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void searchArt();
                      }}
                    />
                    <button
                      type="button"
                      disabled={artBusy || artQuery.trim().length < 2}
                      onClick={() => void searchArt()}
                      className="px-4 py-2 border border-fg text-[0.75rem] tracking-[0.06em] uppercase hover:bg-fg hover:text-bg transition-colors disabled:opacity-40 cursor-pointer"
                    >
                      {artBusy ? "Searching…" : "Search"}
                    </button>
                  </div>
                  {artError ? (
                    <p className="mt-2 text-[0.75rem] text-mid">{artError}</p>
                  ) : null}
                  {artResults && artResults.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => setBrowseOpen("museums")}
                      className="mt-2 w-full inline-flex items-center justify-center px-4 py-2 border border-hairline text-[0.75rem] tracking-[0.04em] uppercase text-mid hover:border-fg hover:text-fg cursor-pointer"
                    >
                      See results bigger
                    </button>
                  ) : null}
                  {artResults ? (
                    artResults.length === 0 ? (
                      <p className="mt-2 text-[0.8125rem] text-mid">
                        Nothing found - try a different word.
                      </p>
                    ) : (
                      <div className="mt-2.5 grid grid-cols-2 gap-2 max-h-[24rem] overflow-y-auto pr-1">
                        {artResults.map((a) => (
                          <button
                            key={a.id}
                            type="button"
                            disabled={artFetching !== null}
                            title={`${a.title}${a.artist ? ` - ${a.artist}` : ""} (${a.source})`}
                            onClick={() => void importArtwork(a)}
                            className="border border-hairline hover:border-fg text-left cursor-pointer disabled:opacity-50 transition-colors"
                          >
                            <span className="block aspect-square bg-card overflow-hidden">
                              <img
                                src={`${apiBase()}/api/art?action=image&url=${encodeURIComponent(a.thumb)}`}
                                alt={a.title}
                                loading="lazy"
                                className="w-full h-full object-cover"
                              />
                            </span>
                            <span className="block px-1.5 py-1">
                              <span className="block text-[0.6875rem] leading-tight truncate">
                                {artFetching === a.id ? "Loading…" : a.title}
                              </span>
                              <span className="block text-[0.5625rem] text-dim truncate">
                                {a.date ? `${a.date} · ` : ""}{a.source}
                              </span>
                            </span>
                          </button>
                        ))}
                      </div>
                    )
                  ) : (
                    <p className="mt-2 text-[0.75rem] text-dim leading-snug">
                      Tap a result to bring it into your designs - then crop it
                      down with effects like Silhouette, or clean it up like any
                      upload.
                    </p>
                  )}
                </>
              )}
      </>
    ),
    text: (
      <>
              <div className="flex flex-col gap-2">
                {/* the core: type box + the ACTUAL rendered result, up top */}
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <input
                    value={textValue}
                    onChange={(e) => setTextValue(e.target.value)}
                    placeholder="Type something…"
                    aria-label="Text to add"
                    className={FIELD}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addText();
                    }}
                  />
                  <button
                    type="button"
                    onClick={addText}
                    disabled={!textValue.trim()}
                    className="px-4 py-2 border border-fg text-[0.75rem] tracking-[0.06em] uppercase hover:bg-fg hover:text-bg transition-colors disabled:opacity-40 cursor-pointer"
                  >
                    {editingTextId ? "Update" : "Add"}
                  </button>
                </div>
                {editingTextId ? (
                  <p className="text-[0.6875rem] text-mid">
                    Editing the selected text - Update replaces it in place.{" "}
                    <button
                      type="button"
                      onClick={() => {
                        setEditingTextId(null);
                        setTextValue("");
                      }}
                      className="underline underline-offset-2 hover:text-fg cursor-pointer"
                    >
                      Cancel
                    </button>
                  </p>
                ) : null}
                <div className="border border-hairline bg-card min-h-[6.5rem] px-3 py-2.5 flex items-center justify-center">
                  {textPreview ? (
                    <img
                      src={textPreview}
                      alt="Preview of your styled text"
                      className="max-h-28 max-w-full"
                    />
                  ) : (
                    <span className="text-[0.8125rem] text-dim">
                      Your text appears here as you type
                    </span>
                  )}
                </div>

                {/* style, curve, outline: one compact cluster */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {TEXT_STYLES.map((st) => (
                    <button
                      key={st.id}
                      type="button"
                      aria-pressed={textStyle === st.id}
                      onClick={() => setTextStyle(st.id)}
                      className={`border px-2.5 py-1 text-[0.75rem] cursor-pointer ${
                        textStyle === st.id
                          ? "border-fg bg-fg text-bg"
                          : "border-hairline text-mid hover:border-fg"
                      }`}
                    >
                      {st.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    aria-pressed={textOutline}
                    title="Letterforms as strokes only, open centers"
                    onClick={() => setTextOutline((v) => !v)}
                    className={`border px-2.5 py-1 text-[0.75rem] cursor-pointer ${
                      textOutline ? "border-fg bg-fg text-bg" : "border-hairline text-mid hover:border-fg"
                    }`}
                  >
                    Outline
                  </button>
                </div>
                {textStyle === "arch" && (
                  <div className="flex items-center gap-2 text-[0.75rem] text-mid">
                    <button
                      type="button"
                      aria-pressed={!archDown}
                      title="Arch up"
                      onClick={() => setArchDown(false)}
                      className={`border px-2 py-1 cursor-pointer ${!archDown ? "border-fg bg-fg text-bg" : "border-hairline hover:border-fg"}`}
                    >
                      ∩
                    </button>
                    <button
                      type="button"
                      aria-pressed={archDown}
                      title="Arch down"
                      onClick={() => setArchDown(true)}
                      className={`border px-2 py-1 cursor-pointer ${archDown ? "border-fg bg-fg text-bg" : "border-hairline hover:border-fg"}`}
                    >
                      ∪
                    </button>
                    <input type="range" min={30} max={320} step={5} value={textCurve}
                      onChange={(e) => setTextCurve(Number(e.target.value))}
                      className="flex-1 min-w-0 accent-fg" aria-label="Curve amount" />
                    <span className="tabular-nums w-9 text-right">{textCurve}°</span>
                  </div>
                )}

                {/* fonts: browse by group, one grid - every tile previews your words */}
                <div className="border-t border-hairline pt-2 flex flex-col gap-1.5">
                  <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                    {["All", ...fontGroups.map((g) => g.group)].map((g) => (
                      <button
                        key={g}
                        type="button"
                        aria-pressed={fontGroupFilter === g}
                        onClick={() => setFontGroupFilter(g)}
                        className={`shrink-0 border px-2.5 py-1 text-[0.6875rem] whitespace-nowrap cursor-pointer ${
                          fontGroupFilter === g
                            ? "border-fg bg-fg text-bg"
                            : "border-hairline text-mid hover:border-fg"
                        }`}
                      >
                        {g}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-1.5 max-h-44 overflow-y-auto overscroll-contain pr-1">
                    {(fontGroupFilter === "All"
                      ? fontGroups.flatMap((g) => g.fonts)
                      : fontGroups.find((g) => g.group === fontGroupFilter)?.fonts ?? []
                    ).map((f) => (
                      <button
                        key={f.family}
                        type="button"
                        aria-label={`Font ${f.name}`}
                        aria-pressed={fontChoice === f.family}
                        onClick={() => setFontChoice(f.family)}
                        className={`min-w-[5rem] border px-2 py-1.5 text-left cursor-pointer ${
                          fontChoice === f.family
                            ? "border-fg ring-1 ring-fg"
                            : "border-hairline hover:border-fg"
                        }`}
                      >
                        <span
                          className="block text-[1.125rem] leading-none whitespace-nowrap max-w-[8rem] overflow-hidden"
                          style={{ fontFamily: `"${f.family}"` }}
                        >
                          {(textValue.trim() || "Abc").slice(0, 12)}
                        </span>
                        <span className="mt-1 block text-[0.5625rem] text-mid truncate max-w-[7rem]">
                          {f.name}
                        </span>
                      </button>
                    ))}
                  </div>
                  {fontGroupFilter === "Your fonts" && fonts.length ? (
                    <div className="flex flex-wrap gap-1.5">
                      {fonts.map((f) => (
                        <span
                          key={f.family}
                          className="flex items-center gap-1.5 bg-card border border-hairline px-2 py-1 text-[0.6875rem]"
                        >
                          {f.name}
                          <button
                            type="button"
                            aria-label={`Remove font ${f.name}`}
                            onClick={() => removeFont(f.family)}
                            className="text-mid hover:text-fg cursor-pointer"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>

                {/* quiet utility row */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.75rem]">
                  <button
                    type="button"
                    disabled={!textValue.trim()}
                    onClick={() => void addTypeGenerated()}
                    title="Rolls your words in a random font and setting - each roll replaces the last until you tap away"
                    className="border border-hairline px-2.5 py-1.5 text-mid hover:border-fg hover:text-fg disabled:opacity-40 cursor-pointer"
                  >
                    ↻ Surprise me
                  </button>
                  <button
                    type="button"
                    onClick={() => fontFileRef.current?.click()}
                    className="text-mid underline underline-offset-2 hover:text-fg cursor-pointer"
                  >
                    Upload a font file
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowFontsGuide(true)}
                    className="text-mid underline underline-offset-2 hover:text-fg cursor-pointer"
                  >
                    Want a font that isn't here?
                  </button>
                  {SYSTEM_FONTS_SUPPORTED ? (
                    <button
                      type="button"
                      onClick={loadSystemFonts}
                      className="text-mid underline underline-offset-2 hover:text-fg cursor-pointer"
                    >
                      This device's fonts
                    </button>
                  ) : null}
                </div>
              </div>
      </>
    ),
    save: (
      <>
              <button
                type="button"
                onClick={startNewFlow}
                disabled={!placements.length}
                className="w-full inline-flex items-center justify-center px-6 py-2.5 border border-fg text-[0.8125rem] tracking-[0.08em] uppercase hover:bg-fg hover:text-bg transition-colors disabled:opacity-40 cursor-pointer"
              >
                + Start a new design
              </button>
              <div className="mt-1 flex flex-col gap-2.5">
                {/* actions inline - no nested sheet on mobile; this panel only
                    renders on touch (desktop saves from the rail) */}
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    disabled={!!saveMenuBusy || saving}
                    onClick={() => void saveMenuAction("library")}
                    className="w-full inline-flex flex-col items-center justify-center px-6 py-3 bg-fg text-bg cursor-pointer hover:opacity-85 disabled:opacity-50"
                  >
                    <span className="text-[0.8125rem] tracking-[0.08em] uppercase">
                      {saveMenuBusy === "library" || saving
                        ? "Saving…"
                        : editingId
                          ? "Update in my library"
                          : "Save to my library"}
                    </span>
                    <span className="text-[0.625rem] opacity-75">
                      {authToken ? "synced to your account" : "on this device - an account keeps it everywhere"}
                    </span>
                  </button>
                  <span className="pt-1 text-[0.625rem] tracking-[0.12em] uppercase text-dim">Export</span>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={!!saveMenuBusy || !placements.length}
                      onClick={() => void saveMenuAction("png")}
                      className="inline-flex flex-col items-center justify-center px-4 py-2.5 border border-fg cursor-pointer hover:bg-fg hover:text-bg transition-colors disabled:opacity-50"
                    >
                      <span className="text-[0.8125rem] tracking-[0.08em] uppercase">
                        {saveMenuBusy === "png" ? "Rendering…" : "Download PNG"}
                      </span>
                      <span className="text-[0.5625rem] opacity-75">transparent · 300ppi</span>
                    </button>
                    <button
                      type="button"
                      disabled={!!saveMenuBusy || !placements.length}
                      onClick={() => void saveMenuAction("jpeg")}
                      className="inline-flex flex-col items-center justify-center px-4 py-2.5 border border-fg cursor-pointer hover:bg-fg hover:text-bg transition-colors disabled:opacity-50"
                    >
                      <span className="text-[0.8125rem] tracking-[0.08em] uppercase">
                        {saveMenuBusy === "jpeg" ? "Rendering…" : "Download JPEG"}
                      </span>
                      <span className="text-[0.5625rem] opacity-75">white bg · easy to share</span>
                    </button>
                  </div>
                  <p className="text-[0.6875rem] text-dim leading-snug">
                    Your work also autosaves. Downloads open the share sheet - choose Save Image for your Photos.
                  </p>
                </div>
                {!authToken ? (
                  <div className="flex flex-col gap-1.5">
                    <button
                      type="button"
                      onClick={() => setShowLogin(true)}
                      className="w-full inline-flex items-center justify-center px-6 py-2.5 border border-fg text-[0.8125rem] tracking-[0.08em] uppercase hover:bg-fg hover:text-bg transition-colors cursor-pointer"
                    >
                      Sign in to sync
                    </button>
                    <p className="text-[0.6875rem] text-dim leading-snug">
                      Access your ideas on other devices and protect them if
                      this browser is cleared.
                    </p>
                  </div>
                ) : null}
                <span className="pt-1 text-[0.625rem] tracking-[0.12em] uppercase text-dim border-t border-hairline">
                  Details - all optional
                </span>
                <div className="grid grid-cols-[1fr_6rem] gap-2.5">
                  <input
                    value={ideaName}
                    onChange={(e) => setIdeaName(e.target.value)}
                    placeholder="Name"
                    aria-label="Idea name"
                    className={FIELD}
                  />
                  <input
                    type="number"
                    min={1}
                    value={qty}
                    onChange={(e) => setQty(e.target.value)}
                    aria-label="Quantity"
                    title="How many pieces this idea would be"
                    className={FIELD}
                  />
                </div>
                <input
                  value={collection}
                  onChange={(e) => setCollection(e.target.value)}
                  placeholder="Collection"
                  aria-label="Collection"
                  list="lab-collections"
                  className={FIELD}
                />
                <datalist id="lab-collections">
                  {collections.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>

                {role.staff ? (
                <div>
                  <input
                    value={threadQuery}
                    onChange={(e) => setThreadQuery(e.target.value)}
                    placeholder="Add thread colors - search code or name"
                    aria-label="Thread search"
                    className={FIELD}
                  />
                  {threadMatches.length ? (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {threadMatches.map((t) => (
                        <button
                          key={`${t.code}-${t.family}`}
                          type="button"
                          onClick={() => {
                            setIdeaThreads((x) => [
                              ...x,
                              { code: t.code, name: t.name, hex: t.hex! },
                            ]);
                            setThreadQuery("");
                          }}
                          className="flex items-center gap-1.5 border border-hairline px-2 py-1 text-[0.75rem] hover:border-fg cursor-pointer"
                        >
                          <span
                            className="w-3.5 h-3.5 rounded-full border border-hairline"
                            style={{ backgroundColor: t.hex! }}
                          />
                          {t.code} {t.name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {ideaThreads.length ? (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {ideaThreads.map((t, i) => (
                        <span
                          key={`${t.code}-${i}`}
                          className="flex items-center gap-1.5 bg-card border border-hairline px-2 py-1 text-[0.75rem]"
                        >
                          <span
                            className="w-3.5 h-3.5 rounded-full border border-hairline"
                            style={{ backgroundColor: t.hex }}
                          />
                          {t.code} {t.name}
                          <button
                            type="button"
                            aria-label={`Remove thread ${t.code}`}
                            onClick={() => setIdeaThreads((x) => x.filter((_, j) => j !== i))}
                            className="text-mid hover:text-fg cursor-pointer"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
                ) : null}

                <input
                  value={ideaNotes}
                  onChange={(e) => setIdeaNotes(e.target.value)}
                  placeholder="Notes"
                  aria-label="Notes"
                  className={FIELD}
                />
                <input
                  value={nextNote}
                  onChange={(e) => setNextNote(e.target.value)}
                  placeholder="Next time I want to…"
                  aria-label="Note to yourself for next session"
                  title="A note to your future self - it greets you when you reopen this project"
                  className={FIELD}
                />

              </div>
      </>
    ),
  };

  // cost explorer opens from a saved piece in the library ("Costs")
  const costExplorer = (
            <section className="border border-hairline bg-card p-4">
              <div className="flex flex-wrap items-baseline gap-2">
                <h2 className={LABEL}>
                  What it costs - estimates
                  {costIdeaId
                    ? ` · ${ideas.find((i) => i.id === costIdeaId)?.name ?? ""}`
                    : ""}
                </h2>
              </div>
              <p className="mt-2 text-[0.8125rem] text-mid leading-[1.6] max-w-[38rem]">
                Every piece of clothing has three costs: the{" "}
                <strong className="text-fg font-medium">blank</strong> (the garment itself),
                the <strong className="text-fg font-medium">setup</strong> (one-time work to
                prepare a design for production), and the{" "}
                <strong className="text-fg font-medium">per-piece</strong> work of decorating
                each one. Setup spreads across the run - that's why bigger runs cost less
                per piece.
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-3">
                  <label className="flex flex-col gap-1">
                    <span className={LABEL}>Blank</span>
                    <select
                      value={costGarment.id}
                      onChange={(e) => setCostGarmentId(e.target.value)}
                      aria-label="Blank to price"
                      className="bg-bg border border-hairline px-2.5 py-1.5 text-[0.8125rem] text-fg outline-none focus:border-fg"
                    >
                      {visibleGarments.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.label} - {g.brand}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div>
                    <span className={LABEL}>Method</span>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {(Object.keys(COST_METHODS) as (keyof typeof COST_METHODS)[]).map((m) => (
                        <button
                          key={m}
                          type="button"
                          aria-pressed={costMethod === m}
                          onClick={() => setCostMethod(m)}
                          className={`border px-2.5 py-1.5 text-[0.75rem] cursor-pointer ${
                            costMethod === m
                              ? "border-fg bg-fg text-bg"
                              : "border-hairline text-mid hover:border-fg"
                          }`}
                        >
                          {COST_METHODS[m].label}
                        </button>
                      ))}
                    </div>
                    <p className="mt-2 text-[0.75rem] text-mid leading-[1.55]">
                      {costModel.how}
                    </p>
                  </div>
                  <div>
                    <span className={LABEL}>How many</span>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {[1, 6, 12, 24, 48].map((q) => (
                        <button
                          key={q}
                          type="button"
                          aria-pressed={costQty === q}
                          onClick={() => setCostQty(q)}
                          className={`border px-3 py-1.5 text-[0.75rem] tabular-nums cursor-pointer ${
                            costQty === q
                              ? "border-fg bg-fg text-bg"
                              : "border-hairline text-mid hover:border-fg"
                          }`}
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="border border-hairline bg-bg p-3.5 flex flex-col gap-2 text-[0.8125rem]">
                  <div className="flex justify-between gap-3">
                    <span className="text-mid">Blank ({costGarment.label})</span>
                    <span className="tabular-nums">
                      {costBlank > 0 ? `$${costBlank.toFixed(2)} each` : "not priced yet"}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-mid">Setup - one time</span>
                    <span className="tabular-nums">
                      ${costModel.setupLo}–{costModel.setupHi}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-mid">Decoration per piece</span>
                    <span className="tabular-nums">
                      ${costModel.pieceLo}–{costModel.pieceHi}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3 border-t border-hairline pt-2 mt-1">
                    <span className="text-fg font-medium">
                      ≈ estimated cost per piece at {costQty}
                    </span>
                    <span className="tabular-nums text-fg font-medium">
                      ${costPerPiece.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-mid">Whole run</span>
                    <span className="tabular-nums">${costTotal.toFixed(2)}</span>
                  </div>
                  <label className="flex items-center justify-between gap-3 border-t border-hairline pt-2 mt-1">
                    <span className="text-mid">If you sell each at</span>
                    <span className="inline-flex items-center gap-1">
                      <span className="text-dim">$</span>
                      <input
                        type="number"
                        min={0}
                        value={costSell}
                        onChange={(e) => setCostSell(Number(e.target.value) || 0)}
                        aria-label="Your selling price"
                        className="w-16 bg-bg border border-hairline px-2 py-1 text-right tabular-nums outline-none focus:border-fg"
                      />
                    </span>
                  </label>
                  <div className="flex justify-between gap-3">
                    <span className="text-mid">You keep per piece</span>
                    <span
                      className={`tabular-nums font-medium ${costSell - costPerPiece < 0 ? "text-[#c0392b]" : "text-fg"}`}
                    >
                      ${(costSell - costPerPiece).toFixed(2)}
                      {costSell - costPerPiece < 0 ? " (losing money)" : ""}
                    </span>
                  </div>
                  <p className="text-[0.6875rem] text-dim leading-snug pt-1">
                    Every number here is an estimate for planning and learning -
                    not a quote. Real pricing comes from the studio and depends
                    on the design.
                  </p>
                </div>
              </div>
            </section>
  );

  // ── youth guided tour content ────────────────────────────────────────
  // One page per tool area: what it is, what it does, what the buttons do.
  // Wording adapts to where the tools physically live in each shell.
  const where = isMobile ? "in the tabs along the bottom" : "in the rail on the left";
  const TOUR_PAGES: { title: string; tag?: string; body: string; points?: [string, string][] }[] = [
    {
      title: "Welcome to the Design Studio",
      body:
        "A real design studio in your browser. You build clothing mockups from your own ideas - nothing here is a template. This tour walks through every tool; reopen it any time with the ? button in the corner.",
      points: [
        ["Autosave", "Your canvas saves itself as you work. Refresh, crash, come back next week - it's still here."],
        ["Your account", "Saved projects live in your account and follow you to any computer you sign into."],
        ["Private", "Nobody else can see your work. Signing out clears this computer completely."],
      ],
    },
    {
      title: "Blanks",
      tag: `first tool ${where}`,
      body:
        "Choose what you're making - hoodie, crewneck, tee, zip-up, beanie - and its color. Real garments with real specs.",
      points: [
        ["Color palette", "Picking a blank opens a palette of every color it comes in, right beside the garment. Tap swatches to try them live."],
        ["Switch blank", "Move your whole design to a different garment any time - nothing is lost."],
        ["Front / back", "Flip the garment over and design both sides."],
      ],
    },
    {
      title: "Designs",
      tag: "your artwork",
      body:
        "Upload your own images - PNG, JPG, or SVG. Everything you upload stays in your library so you can reuse it across projects.",
      points: [
        ["Upload", "Pick a file or drag it in. It lands on the garment ready to arrange."],
        ["Cleanup choices", "When an image arrives you choose: remove a solid background, clean a photographed drawing into a crisp graphic, or cut out a photo background. You always see the result before deciding."],
        ["My designs", "Your library - everything you've uploaded or made, ready to place again."],
      ],
    },
    {
      title: "Shapes",
      tag: "quick graphics",
      body:
        "Instant abstract graphics - stars, bursts, hearts, and more. Every tap generates a brand-new one.",
      points: [
        ["Tap a style", "A fresh shape appears as a preview - nothing lands on the garment yet."],
        ["Another take", "Keep rolling until one feels right."],
        ["Insert", "Put the one you like on the garment, or save it for later."],
      ],
    },
    {
      title: "Text",
      tag: "wordmarks & lettering",
      body:
        "Type anything and shape it. This is where logos and wordmarks happen.",
      points: [
        ["Fonts", "A curated set, plus upload your own font file if you have one."],
        ["Layouts", "Straight, arch, wave, circle, or stacked - arch has a curve dial from gentle to full circle."],
        ["Outline", "Letterforms as strokes with open centers - a classic vinyl look."],
        ["Still editable", "Select placed text later and hit Edit text to change the words, style, or curve."],
      ],
    },
    {
      title: "Arranging",
      tag: "on the canvas",
      body:
        "Tap a placed design to select it - its controls appear. Everything is undoable.",
      points: [
        ["Move & size", "Drag to move. Drag a corner to resize. Sizes are real inches."],
        ["Rotate / Flip", "Tilt it or mirror it."],
        ["Recolor", "Swap a design to any of 126 colors."],
        ["Effects", "Halftone, pixelate, outline, and more - one tap makes a new version; the original stays in My designs."],
        ["Overlap", "When designs stack, choose which sits on top."],
        ["Undo", "The arrows (or ⌘Z) step backward through everything you did."],
      ],
    },
    {
      title: "Saving & files",
      tag: "make it real",
      body:
        "Nothing to remember here - your work saves itself to your library as you design.",
      points: [
        ["Autosave", "A few seconds after every change, the project lands in Saved ideas under your account."],
        ["Your library", "Open Saved ideas to rename projects, duplicate one onto another garment, or pick up where you left off."],
        ...(role.staff
          ? ([["Costs", "Tap Costs on any saved piece to explore what making it would run - blanks, methods, quantities."]] as [string, string][])
          : []),
        ["Files", "Download a mockup image from the canvas (↓ Save), or Design files on any selected design for SVG tracings."],
        ["Sign out", "Wipes this computer. Your account keeps everything."],
      ],
    },
  ];
  const closeTour = (finished: boolean) => {
    setTour(null);
    setTourRequired(false);
    if (finished) {
      try {
        if (!localStorage.getItem(policy.onboardKey)) {
          localStorage.setItem(policy.onboardKey, "toured");
          scheduleSync();
        }
      } catch { /* private mode */ }
      // reinforce with the compact follow-along banner on a first run
      let seen: string | null = null;
      try {
        seen = localStorage.getItem(policy.onboardKey);
      } catch { /* private mode */ }
      if (!seen) setOnboardStep(1);
    }
  };

  // ── onboarding banner (rendered in both paths) ───────────────────────
  const ONBOARD_STEPS: [string, string][] = youth
    ? [
        ["Choose a garment", "Pick a hoodie, crew, or tee and a color."],
        ["Add your artwork", "Upload a design - or photograph a paper drawing and the Lab cleans it up. Text works too."],
        ["Arrange it", "Drag to move it. Use the controls below to resize and rotate."],
        ["It saves itself", "Your work goes to your library automatically. Download an image any time to share it."],
      ]
    : [
        ["Choose a garment", "Pick a style and color to begin."],
        ["Add something", "Upload artwork, add text, or choose a studio design."],
        ["Arrange it", "Drag the design to move it. Use the controls below to change its size."],
        ["It saves itself", "Your work lands in Saved ideas automatically. Download an image any time."],
      ];
  // "Your projects" continuation strip - when someone arrives with an empty
  // canvas but saved work, the fastest path back in is one tap. Youth mode
  // leads with this (weekly sessions, shared devices); /lab gets it too.
  const [continueDismissed, setContinueDismissed] = useState(false);
  const recentIdeas = ideas.slice(0, 3);
  const continueBanner =
    !continueDismissed &&
    tab === "studio" &&
    placements.length === 0 &&
    !editingId &&
    !onboardStep &&
    recentIdeas.length > 0 ? (
      <div className="shrink-0 flex items-center gap-2.5 border border-hairline bg-bg px-3 py-2 overflow-x-auto">
        <span className="shrink-0 text-[0.625rem] tracking-[0.12em] uppercase text-dim whitespace-nowrap">
          Your projects
        </span>
        {recentIdeas.map((idea) => (
          <button
            key={idea.id}
            type="button"
            onClick={() => loadIdea(idea)}
            title={idea.nextNote ? `Continue - your note: ${idea.nextNote}` : "Continue this project"}
            className="shrink-0 flex items-center gap-2 border border-hairline hover:border-fg px-1.5 py-1 cursor-pointer"
          >
            <img src={idea.thumb} alt="" className="w-8 h-8 object-cover bg-card" />
            <span className="text-left">
              <span className="block text-[0.75rem] leading-tight max-w-[9rem] truncate">
                {idea.name}
              </span>
              <span className="block text-[0.625rem] text-mid leading-tight">
                Continue →
              </span>
            </span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => setTab("pipeline")}
          className="shrink-0 text-[0.75rem] text-mid underline underline-offset-2 hover:text-fg cursor-pointer whitespace-nowrap"
        >
          All projects
        </button>
        <button
          type="button"
          aria-label="Dismiss your projects strip"
          onClick={() => setContinueDismissed(true)}
          className="shrink-0 ml-auto w-7 h-7 text-mid hover:text-fg cursor-pointer text-[1rem] leading-none"
        >
          ×
        </button>
      </div>
    ) : null;

  const onboardBanner =
    onboardStep && tab === "studio" ? (
      <div className="shrink-0 flex items-center gap-3 border border-hairline bg-bg px-3 py-2.5">
        <span className="shrink-0 text-[0.625rem] tracking-[0.12em] uppercase text-dim whitespace-nowrap">
          {onboardStep} of 4
        </span>
        <p className="flex-1 min-w-0 text-[0.8125rem] leading-snug">
          <strong className="text-fg font-medium">
            {ONBOARD_STEPS[onboardStep - 1][0]}
          </strong>{" "}
          <span className="text-mid">{ONBOARD_STEPS[onboardStep - 1][1]}</span>
        </p>
        <button
          type="button"
          aria-label="Dismiss the walkthrough"
          onClick={() => dismissOnboarding("dismissed")}
          className="shrink-0 w-8 h-8 text-mid hover:text-fg cursor-pointer text-[1rem] leading-none"
        >
          ×
        </button>
      </div>
    ) : null;

  // ── mobile shell derivations ──────────────────────────────────────────
  const designCtx = isMobile && hasSel;

  const canvasScale = Math.max(
    0,
    Math.min((regionSize.w - 16) / imgDims.w, (regionSize.h - 16) / imgDims.h)
  );
  const canvasBox = {
    w: Math.floor(imgDims.w * canvasScale),
    h: Math.floor(imgDims.h * canvasScale),
  };
  const chromeFaded = regionSize.h > 0 && regionSize.h < 300;

  const glyph = (g: string) => (
    <span aria-hidden="true" className="text-[0.9375rem] leading-none">
      {g}
    </span>
  );

  type SecondaryItem = {
    id: string;
    label: string;
    aria?: string;
    icon: React.ReactNode;
    active?: boolean;
    danger?: boolean; // active state renders red (e.g. remove confirm)
    onTap: () => void;
  };
  const secondaryItems: SecondaryItem[] = !isMobile
    ? []
    : designCtx
      ? [
          { id: "size", label: "Size", icon: glyph("⤢"), active: activeDetail === "size", onTap: () => toggleDetail("size") },
          { id: "rotate", label: "Rotate", icon: glyph("⟳"), active: activeDetail === "rotate", onTap: () => toggleDetail("rotate") },
          {
            id: "thread",
            label: "Color",
            icon: (
              <span
                aria-hidden="true"
                className="w-4 h-4 rounded-full border border-hairline"
                style={{ backgroundColor: sel?.thread?.hex ?? "#1c1c1a" }}
              />
            ),
            active: activeDetail === "thread",
            onTap: () => toggleDetail("thread"),
          },
          {
            id: "effects",
            label: "Effects",
            aria: "Effects - halftone, pixelate, outline and more",
            icon: glyph("✦"),
            active: activeDetail === "effects",
            onTap: () => toggleDetail("effects"),
          },
          ...(sel && uploadById.get(sel.uploadId)?.textMeta
            ? [
                {
                  id: "font-edit",
                  label: "Font",
                  icon: glyph("Aa"),
                  active: activeDetail === "font-edit",
                  onTap: () => toggleDetail("font-edit"),
                },
                {
                  id: "text-edit",
                  label: "Edit text",
                  aria: "Edit the words, style, curve, or outline of this text",
                  icon: glyph("✎"),
                  onTap: () => {
                    if (sel) editPlacedText(sel);
                  },
                },
              ]
            : []),
          {
            id: "flip",
            label: "Flip",
            aria: "Flip the design horizontally",
            icon: glyph("↔"),
            onTap: () => {
              if (!sel) return;
              pushHistory();
              update(sel.id, { flip: !sel.flip });
            },
          },
          {
            id: "lock",
            label: sel?.locked ? "Locked" : "Lock",
            aria: sel?.locked
              ? "Unlock the size"
              : "Lock the size so dragging only moves it",
            icon: glyph(sel?.locked ? "🔒" : "🔓"),
            active: Boolean(sel?.locked),
            onTap: () => {
              if (!sel) return;
              pushHistory();
              update(sel.id, { locked: !sel.locked });
            },
          },
          {
            id: "remove",
            label: confirmRemove ? "Confirm" : "Remove",
            aria: confirmRemove ? "Confirm remove" : "Remove this design",
            icon: glyph("✕"),
            active: confirmRemove,
            danger: confirmRemove,
            onTap: () => {
              if (!sel) return;
              if (!confirmRemove) {
                setConfirmRemove(true);
                if (confirmTimer.current) clearTimeout(confirmTimer.current);
                confirmTimer.current = setTimeout(() => setConfirmRemove(false), 3000);
              } else {
                setConfirmRemove(false);
                remove(sel.id);
              }
            },
          },
        ]
      : activeTab === "designs"
        ? [
            { id: "upload", label: "Upload", aria: "Upload a PNG or SVG", icon: glyph("⇧"), onTap: () => fileRef.current?.click() },
            { id: "mine", label: "My designs", icon: glyph("▣"), active: activeDetail === "mine", onTap: () => toggleDetail("mine") },
            ...(presetsVisible
              ? [{ id: "studio", label: "Studio", aria: "Studio design library", icon: glyph("★"), active: activeDetail === "studio", onTap: () => toggleDetail("studio") }]
              : []),
          ]
        : activeTab === "text"
          ? [
              { id: "font", label: "Font", icon: glyph("Aa"), active: activeDetail === "font", onTap: () => toggleDetail("font") },
              { id: "style", label: "Style", icon: glyph("〜"), active: activeDetail === "style", onTap: () => toggleDetail("style") },
              {
                id: "type",
                label: "Random",
                aria: "Random type - your word, random font and layout",
                icon: MOTIF_ICONS.type,
                active: activeDetail === "type",
                onTap: () => toggleDetail("type"),
              },
            ]
          : activeTab === "generators"
            ? GENERATORS.map((g) => ({
                id: g.id,
                label: g.label,
                aria: `${g.label} shape - ${g.hint}`,
                icon: MOTIF_ICONS[g.id],
                active: activeDetail === "motif" && genPreview?.id === g.id,
                onTap: () => previewMotif(g.id, g.label),
              }))
            : [];

  const motifPreviewBlock = genPreview ? (
    <div className="flex flex-col gap-2">
      <div className="flex items-stretch gap-3">
        <span className="w-24 h-24 shrink-0 border border-hairline bg-card p-1.5">
          <img
            src={genPreview.dataURL}
            alt={`${genPreview.label} preview`}
            className="w-full h-full object-contain"
          />
        </span>
        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          <button
            type="button"
            onClick={anotherMotif}
            className="flex-1 px-3 py-2 bg-fg text-bg text-[0.75rem] tracking-[0.06em] uppercase cursor-pointer"
          >
            ↻ Another one
          </button>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => commitMotif(true)}
              className="flex-1 border border-fg px-2 py-2 text-[0.6875rem] tracking-[0.04em] uppercase cursor-pointer hover:bg-fg hover:text-bg transition-colors"
            >
              Place it
            </button>
            <button
              type="button"
              onClick={() => commitMotif(false)}
              className="flex-1 border border-hairline px-2 py-2 text-[0.6875rem] tracking-[0.04em] uppercase text-mid cursor-pointer"
            >
              Save for later
            </button>
          </div>
        </div>
      </div>
      <p className="text-[0.6875rem] text-dim">
        Nothing is kept until you place it or save it - keep rerolling.
      </p>
    </div>
  ) : null;

  const drawerOpen =
    isMobile &&
    (designCtx
      ? ["size", "rotate", "thread", "font-edit"].includes(activeDetail ?? "")
      : activeTab === "blanks" ||
        activeTab === "save" ||
        activeTab === "artlib" ||
        (activeTab === "designs" && (activeDetail === "mine" || activeDetail === "studio")) ||
        (activeTab === "text" &&
          (activeDetail === "font" ||
            activeDetail === "style" ||
            activeDetail === "type")) ||
        (activeTab === "generators" && activeDetail === "motif"));


  return (
    <div className="lab-root min-h-screen bg-bg text-fg">
      {/* shared hidden file inputs - used by both the desktop accordions and
          the mobile shell, so they live outside either tree */}
      <input
        ref={fileRef}
        type="file"
        accept=".png,.svg,.jpg,.jpeg,.webp"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={fontFileRef}
        type="file"
        accept=".otf,.ttf,.woff,.woff2"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) addFontFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {youth && !showIntro && !authRequired && tour === null && (
        <button
          type="button"
          aria-label="Help - open the guided tour"
          title="Help - guided tour of every tool"
          onClick={() => setTour(0)}
          className="fixed bottom-4 right-4 z-40 w-11 h-11 rounded-full border border-fg bg-bg text-fg text-[1.125rem] shadow-lg hover:bg-fg hover:text-bg transition-colors cursor-pointer"
        >
          ?
        </button>
      )}
      {showIntro && !showGuide ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Welcome to the Lab"
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <div className="absolute inset-0 bg-fg/40" onClick={dismissIntro} />
          <div className="cf-fade-in relative w-full max-w-[22rem] bg-bg border border-fg p-[clamp(1.25rem,5vw,2rem)]">
            <h2 className="font-serif text-[1.375rem] leading-snug">
              {youth ? "Design your clothing" : "Mock up a clothing idea"}
            </h2>
            <p className="mt-3 text-[0.9375rem] text-mid leading-[1.6]">
              {youth
                ? "Pick a hoodie, crew, or tee, add your artwork or text, and build a real mockup of your idea."
                : "Choose a garment, add artwork or text, and arrange it on the piece."}
            </p>
            <p className="mt-2 text-[0.8125rem] text-dim leading-[1.6]">
              {youth
                ? "Your work saves to your account - it's waiting for you next session, on any computer."
                : "No account needed to start. A free account unlocks your ideas on any device, a saved design library, and more background removals."}
            </p>
            <button
              type="button"
              onClick={() => {
                dismissIntro();
                if (isMobile) {
                  setActiveTab("blanks");
                  setActiveDetail(null);
                } else {
                  setActivePanel("blanks");
                }
                if (youth) {
                  // youth: the big paged tour is the walkthrough - required
                  // until it's been completed once
                  let seen: string | null = null;
                  try {
                    seen = localStorage.getItem(policy.onboardKey);
                  } catch { /* private mode */ }
                  if (!seen) {
                    setTourRequired(true);
                    setTour(0);
                  }
                  return;
                }
                let seen: string | null = null;
                try {
                  seen = localStorage.getItem(policy.onboardKey);
                } catch { /* private mode */ }
                if (!seen) setOnboardStep(1);
              }}
              className="mt-5 w-full inline-flex items-center justify-center px-7 py-3.5 bg-fg text-bg text-[0.8125rem] tracking-[0.08em] uppercase hover:opacity-85 cursor-pointer"
            >
              Start with a blank
            </button>
            <button
              type="button"
              onClick={() => {
                dismissIntro();
                if (!youth) dismissOnboarding("dismissed");
                // youth: the first-visit tour still comes - the auto-open
                // effect takes over once the intro closes
              }}
              className="mt-2.5 w-full text-center text-[0.8125rem] text-mid underline underline-offset-2 hover:text-fg cursor-pointer"
            >
              Skip introduction
            </button>
          </div>
        </div>
      ) : null}

      {tour !== null ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Guided tour of the Design Studio"
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <div className="absolute inset-0 bg-fg/50" />
          <div className="cf-fade-in relative w-full max-w-[30rem] bg-bg border border-fg p-[clamp(1.5rem,5vw,2.25rem)] max-h-[92vh] overflow-y-auto flex flex-col">
            <div className="flex items-baseline justify-between gap-3">
              <span className={LABEL}>
                {tour + 1} of {TOUR_PAGES.length}
              </span>
              {!tourRequired ? (
                <button
                  type="button"
                  onClick={() => closeTour(true)}
                  className="text-[0.75rem] text-mid underline underline-offset-2 hover:text-fg cursor-pointer"
                >
                  Skip the tour
                </button>
              ) : (
                <span className="text-[0.6875rem] text-dim">First-time tour</span>
              )}
            </div>
            <h2 className="mt-3 font-serif text-[1.625rem] leading-snug">
              {TOUR_PAGES[tour].title}
            </h2>
            {TOUR_PAGES[tour].tag ? (
              <p className={`mt-1 ${LABEL}`}>{TOUR_PAGES[tour].tag}</p>
            ) : null}
            <p className="mt-3 text-[0.9375rem] text-mid leading-[1.65]">
              {TOUR_PAGES[tour].body}
            </p>
            {TOUR_PAGES[tour].points ? (
              <div className="mt-4 flex flex-col gap-2.5">
                {TOUR_PAGES[tour].points!.map(([label, desc]) => (
                  <div key={label} className="grid grid-cols-[6.5rem_1fr] gap-3 items-baseline">
                    <span className="text-[0.75rem] tracking-[0.06em] uppercase text-fg font-medium">
                      {label}
                    </span>
                    <span className="text-[0.8125rem] text-mid leading-[1.55]">{desc}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="mt-6 pt-4 border-t border-hairline flex items-center gap-3">
              <button
                type="button"
                onClick={() => setTour((t) => Math.max(0, (t ?? 0) - 1))}
                disabled={tour === 0}
                className="px-4 py-2.5 border border-hairline text-[0.75rem] tracking-[0.06em] uppercase text-mid hover:border-fg disabled:opacity-30 cursor-pointer"
              >
                Back
              </button>
              <span className="flex-1 flex items-center justify-center gap-1.5" aria-hidden="true">
                {TOUR_PAGES.map((_, i) => (
                  <span
                    key={i}
                    className={`w-1.5 h-1.5 rounded-full ${i === tour ? "bg-fg" : "bg-hairline"}`}
                  />
                ))}
              </span>
              {tour < TOUR_PAGES.length - 1 ? (
                <button
                  type="button"
                  onClick={() => setTour((t) => (t ?? 0) + 1)}
                  className="px-6 py-2.5 bg-fg text-bg text-[0.75rem] tracking-[0.06em] uppercase hover:opacity-85 cursor-pointer"
                >
                  Next
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => closeTour(true)}
                  className="px-6 py-2.5 bg-fg text-bg text-[0.75rem] tracking-[0.06em] uppercase hover:opacity-85 cursor-pointer"
                >
                  Start designing
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {showFontsGuide ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Using your own fonts"
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <div className="absolute inset-0 bg-fg/40" onClick={() => setShowFontsGuide(false)} />
          <div className="cf-fade-in relative w-full max-w-[24rem] bg-bg border border-fg p-[clamp(1.25rem,5vw,2rem)]">
            <h2 className="font-serif text-[1.375rem] leading-snug">Bring any font</h2>
            <p className="mt-3 text-[0.875rem] text-mid leading-[1.65]">
              The picker has a big open-source library built in, but you can use
              any font you can get as a file.
            </p>
            <ol className="mt-3 flex flex-col gap-2 text-[0.875rem] text-mid leading-[1.55] list-decimal pl-5">
              <li>
                Find a font on a free-font site - DaFont, Font Squirrel, and
                Google Fonts are good places to look.
              </li>
              <li>Download it and unzip if needed - you want a .ttf or .otf file.</li>
              <li>
                Back here, choose{" "}
                <strong className="text-fg font-medium">Upload a font file</strong>{" "}
                in the text tool and pick that file.
              </li>
            </ol>
            <p className="mt-3 text-[0.8125rem] text-dim leading-[1.6]">
              Uploaded fonts stay in your account library, so they're ready on
              any computer you sign into. Check a font's license if you plan to
              sell what you make with it.
            </p>
            <button
              type="button"
              onClick={() => setShowFontsGuide(false)}
              className="mt-5 w-full inline-flex items-center justify-center px-7 py-3 bg-fg text-bg text-[0.8125rem] tracking-[0.08em] uppercase hover:opacity-85 cursor-pointer"
            >
              Got it
            </button>
          </div>
        </div>
      ) : null}

      {bgReview ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Review your upload"
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <div className="absolute inset-0 bg-fg/40" />
          <div className="cf-fade-in relative w-full max-w-[26rem] max-h-[92vh] overflow-y-auto bg-bg border border-fg p-[clamp(1.25rem,5vw,1.75rem)]">
            <h2 className="font-serif text-[1.25rem] leading-snug">
              Add this artwork
            </h2>
            <p className="mt-2 text-[0.8125rem] text-mid leading-[1.6]">
              {bgReview.status === "done"
                ? "Compare the two versions and pick one to place."
                : "Place it as-is, or try removing a solid background first."}
            </p>

            <div className="mt-4 grid grid-cols-2 gap-2.5">
              <div>
                <span className="text-[0.625rem] tracking-[0.12em] uppercase text-dim">
                  Original
                </span>
                <div
                  className="mt-1 aspect-square border border-hairline p-2 flex items-center justify-center"
                  style={{
                    backgroundImage:
                      "repeating-conic-gradient(#e5e2dc 0% 25%, #f4f2ee 0% 50%)",
                    backgroundSize: "16px 16px",
                  }}
                >
                  <img
                    src={bgReview.upload.url}
                    alt="Original upload"
                    className="max-w-full max-h-full"
                  />
                </div>
              </div>
              <div>
                <span className="text-[0.625rem] tracking-[0.12em] uppercase text-dim">
                  Background removed
                </span>
                <div
                  className="mt-1 aspect-square border border-hairline p-2 flex items-center justify-center"
                  style={{
                    backgroundImage:
                      "repeating-conic-gradient(#e5e2dc 0% 25%, #f4f2ee 0% 50%)",
                    backgroundSize: "16px 16px",
                  }}
                >
                  {bgReview.status === "done" && bgReview.removedURL ? (
                    <img
                      src={bgReview.removedURL}
                      alt="Upload with background removed"
                      className="max-w-full max-h-full"
                    />
                  ) : bgReview.status === "working" ? (
                    <span className="text-[0.6875rem] text-mid">Working…</span>
                  ) : bgReview.status === "failed" ? (
                    <span className="px-2 text-center text-[0.6875rem] text-mid leading-snug">
                      That didn't work - try the other remover
                    </span>
                  ) : (
                    <span className="px-2 text-center text-[0.6875rem] text-dim leading-snug">
                      Not tried yet
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-col gap-2">
              {bgReview.status === "done" && bgReview.removedURL ? (
                <button
                  type="button"
                  onClick={() => finishBgReview(true)}
                  className="w-full inline-flex items-center justify-center px-6 py-3 bg-fg text-bg text-[0.8125rem] tracking-[0.08em] uppercase hover:opacity-85 cursor-pointer"
                >
                  Use removed version
                </button>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {policy.photoRemoval ? (
                    <button
                      type="button"
                      disabled={bgReview.status === "working"}
                      onClick={() => void runPhotoRemoval(bgReview.upload)}
                      className="w-full inline-flex flex-col items-center justify-center px-6 py-2.5 bg-fg text-bg cursor-pointer hover:opacity-85 disabled:opacity-50"
                    >
                      <span className="text-[0.8125rem] tracking-[0.08em] uppercase">
                        {bgReview.status === "working" ? "Removing…" : "Remove background"}
                      </span>
                      <span className="text-[0.625rem] opacity-75">
                        photos, people, products &amp; logos - best quality
                      </span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={bgReview.status === "working"}
                    onClick={() => void runBgRemoval(bgReview.upload)}
                    className={`w-full inline-flex flex-col items-center justify-center px-6 py-2.5 cursor-pointer disabled:opacity-50 ${
                      policy.photoRemoval
                        ? "border border-fg hover:bg-fg hover:text-bg transition-colors"
                        : "bg-fg text-bg hover:opacity-85"
                    }`}
                  >
                    <span className="text-[0.8125rem] tracking-[0.08em] uppercase">
                      {bgReview.status === "working" && !policy.photoRemoval
                        ? "Removing…"
                        : "Remove a solid background"}
                    </span>
                    <span className="text-[0.625rem] opacity-75">
                      logos &amp; drawings on flat colors - instant
                    </span>
                  </button>
                  <button
                    type="button"
                    disabled={bgReview.status === "working"}
                    onClick={() => void runDrawingCleanup(bgReview.upload)}
                    className="w-full inline-flex flex-col items-center justify-center px-6 py-2.5 border border-fg cursor-pointer hover:bg-fg hover:text-bg transition-colors disabled:opacity-50"
                  >
                    <span className="text-[0.8125rem] tracking-[0.08em] uppercase">
                      Clean up a drawing
                    </span>
                    <span className="text-[0.625rem] opacity-75">
                      photographed sketches → crisp graphic - instant
                    </span>
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={() => finishBgReview(false)}
                className="w-full inline-flex items-center justify-center px-6 py-3 border border-fg text-[0.8125rem] tracking-[0.08em] uppercase hover:bg-fg hover:text-bg transition-colors cursor-pointer"
              >
                Use original
              </button>
            </div>
            <p className="mt-3 text-[0.6875rem] text-dim leading-snug">
              Remove background handles anything - photos, people, products,
              logos. The instant options work fully on-device for flat-color
              art and photographed sketches. Either way you'll see the result
              before anything is placed.
            </p>
          </div>
        </div>
      ) : null}

      {browseOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Browse the image collections"
          className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6"
        >
          <div className="absolute inset-0 bg-fg/50" onClick={() => setBrowseOpen(null)} />
          <div className="cf-fade-in relative w-full max-w-[64rem] h-[88vh] bg-bg border border-fg flex flex-col overflow-hidden">
            <div className="shrink-0 flex flex-wrap items-center gap-2.5 px-4 py-3 border-b border-hairline">
              <h2 className="font-serif text-[1.25rem] leading-none">
                {browseOpen === "library" ? "Image library" : "Museum results"}
              </h2>
              {browseOpen === "library" ? (
                <input
                  value={libQuery}
                  onChange={(e) => setLibQuery(e.target.value)}
                  placeholder="Search within the collections…"
                  aria-label="Search the image library"
                  className="flex-1 min-w-[10rem] max-w-[22rem] bg-bg border border-hairline px-3 py-1.5 text-[0.875rem] text-fg placeholder:text-dim outline-none focus:border-fg"
                />
              ) : (
                <span className="text-[0.8125rem] text-mid truncate">“{artQuery.trim()}”</span>
              )}
              <button
                type="button"
                aria-label="Close the browser"
                onClick={() => setBrowseOpen(null)}
                className="ml-auto w-8 h-8 text-mid hover:text-fg cursor-pointer text-[1.125rem] leading-none"
              >
                ×
              </button>
            </div>
            {browseOpen === "library" ? (
              <>
                {libCategories.length ? (
                  <div className="shrink-0 flex gap-1.5 overflow-x-auto px-4 py-2.5 border-b border-hairline">
                    <button
                      type="button"
                      aria-pressed={libCategory === null}
                      onClick={() => setLibCategory(null)}
                      className={`shrink-0 border px-3 py-1.5 text-[0.8125rem] cursor-pointer ${
                        libCategory === null ? "border-fg bg-fg text-bg" : "border-hairline text-mid hover:border-fg"
                      }`}
                    >
                      All collections
                    </button>
                    {libCategories.map((c) => (
                      <button
                        key={c}
                        type="button"
                        aria-pressed={libCategory === c}
                        onClick={() => setLibCategory(libCategory === c ? null : c)}
                        className={`shrink-0 border px-3 py-1.5 text-[0.8125rem] whitespace-nowrap cursor-pointer ${
                          libCategory === c ? "border-fg bg-fg text-bg" : "border-hairline text-mid hover:border-fg"
                        }`}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4">
                  {libAssets === null ? (
                    <p className="text-[0.875rem] text-mid">Loading the library…</p>
                  ) : libResults.length === 0 ? (
                    <p className="text-[0.875rem] text-mid">
                      {libAssets.length === 0
                        ? libEmptyReason ?? "The library is empty right now."
                        : "No images found. Try another search."}
                    </p>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                      {searchAssets(libAssets, libQuery, { category: libCategory, limit: 400 }).map((a) => (
                        <div key={a.id} className="relative group border border-hairline hover:border-fg transition-colors">
                          <button
                            type="button"
                            disabled={artFetching !== null}
                            title={`${a.title} - tap to use in your design`}
                            onClick={() =>
                              void importLibraryAsset(a).then(() => setBrowseOpen(null))
                            }
                            className="block w-full text-left cursor-pointer disabled:opacity-50"
                          >
                            <span className="block aspect-square bg-card overflow-hidden">
                              <img
                                src={relayUrl(a.thumbUrl)}
                                alt={a.title}
                                loading="lazy"
                                className="w-full h-full object-cover"
                              />
                            </span>
                            <span className="block px-2 py-1.5">
                              <span className="block text-[0.75rem] leading-tight truncate">
                                {artFetching === a.id ? "Adding to your design…" : a.title}
                              </span>
                              <span className="block text-[0.625rem] text-dim truncate">
                                {attributionLine(a)}
                              </span>
                            </span>
                          </button>
                          <button
                            type="button"
                            aria-label={`Download ${a.title}`}
                            title="Download this image file"
                            onClick={() => void downloadLibraryAsset(a)}
                            className="absolute top-1.5 right-1.5 w-8 h-8 border border-hairline bg-bg/90 text-mid text-[0.875rem] leading-none opacity-0 group-hover:opacity-100 focus:opacity-100 hover:border-fg hover:text-fg cursor-pointer"
                          >
                            ↓
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4">
                {!artResults || artResults.length === 0 ? (
                  <p className="text-[0.875rem] text-mid">No results to show - run a search first.</p>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                    {artResults.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        disabled={artFetching !== null}
                        title={`${a.title}${a.artist ? ` - ${a.artist}` : ""} (${a.source})`}
                        onClick={() => void importArtwork(a).then(() => setBrowseOpen(null))}
                        className="border border-hairline hover:border-fg text-left cursor-pointer disabled:opacity-50 transition-colors"
                      >
                        <span className="block aspect-square bg-card overflow-hidden">
                          <img
                            src={`${apiBase()}/api/art?action=image&url=${encodeURIComponent(a.thumb)}`}
                            alt={a.title}
                            loading="lazy"
                            className="w-full h-full object-cover"
                          />
                        </span>
                        <span className="block px-2 py-1.5">
                          <span className="block text-[0.75rem] leading-tight truncate">
                            {artFetching === a.id ? "Loading…" : a.title}
                          </span>
                          <span className="block text-[0.625rem] text-dim truncate">
                            {a.date ? `${a.date} · ` : ""}{a.source}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {saveMenu ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Save and export"
          className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4"
        >
          <div className="absolute inset-0 bg-fg/40" onClick={() => !saveMenuBusy && setSaveMenu(false)} />
          <div className="cf-fade-in relative w-full max-w-none sm:max-w-[22rem] bg-bg border-t sm:border border-fg rounded-t-2xl sm:rounded-none px-5 pt-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:p-[clamp(1.25rem,5vw,2rem)]">
            {/* grab handle - reads as a bottom sheet on touch */}
            <div className="sm:hidden mx-auto mb-3 h-1 w-9 rounded-full bg-hairline" aria-hidden="true" />
            <h2 className="font-serif text-[1.375rem] leading-snug">Save & export</h2>
            <div className="mt-4 flex flex-col gap-2 sm:gap-1.5">
              <button
                type="button"
                disabled={!!saveMenuBusy}
                onClick={() => void saveMenuAction("library")}
                className="w-full inline-flex flex-col items-center justify-center px-6 py-3.5 sm:py-2.5 bg-fg text-bg cursor-pointer hover:opacity-85 disabled:opacity-50"
              >
                <span className="text-[0.8125rem] tracking-[0.08em] uppercase">
                  {saveMenuBusy === "library" ? "Saving…" : "Save to my library"}
                </span>
                <span className="text-[0.625rem] opacity-75">
                  {authToken ? "synced to your account" : "on this device - an account keeps it everywhere"}
                </span>
              </button>
              <button
                type="button"
                disabled={!!saveMenuBusy}
                onClick={() => void saveMenuAction("png")}
                className="w-full inline-flex flex-col items-center justify-center px-6 py-3.5 sm:py-2.5 border border-fg cursor-pointer hover:bg-fg hover:text-bg transition-colors disabled:opacity-50"
              >
                <span className="text-[0.8125rem] tracking-[0.08em] uppercase">
                  {saveMenuBusy === "png" ? "Rendering…" : "Download PNG"}
                </span>
                <span className="text-[0.625rem] opacity-75">transparent background · 300ppi print quality</span>
              </button>
              <button
                type="button"
                disabled={!!saveMenuBusy}
                onClick={() => void saveMenuAction("jpeg")}
                className="w-full inline-flex flex-col items-center justify-center px-6 py-3.5 sm:py-2.5 border border-fg cursor-pointer hover:bg-fg hover:text-bg transition-colors disabled:opacity-50"
              >
                <span className="text-[0.8125rem] tracking-[0.08em] uppercase">
                  {saveMenuBusy === "jpeg" ? "Rendering…" : "Download JPEG"}
                </span>
                <span className="text-[0.625rem] opacity-75">white background · easy to share</span>
              </button>
              <button
                type="button"
                disabled={!!saveMenuBusy}
                onClick={() => setSaveMenu(false)}
                className="w-full inline-flex items-center justify-center px-6 py-2.5 text-[0.8125rem] tracking-[0.08em] uppercase text-mid hover:text-fg cursor-pointer"
              >
                Close
              </button>
            </div>
            {isMobile ? (
              <p className="mt-2 text-[0.6875rem] text-dim leading-snug">
                Downloads open the share sheet - choose Save Image to add it to your Photos.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {newConfirm ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Start a new design"
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <div className="absolute inset-0 bg-fg/40" onClick={() => setNewConfirm(null)} />
          <div className="cf-fade-in relative w-full max-w-[22rem] bg-bg border border-fg p-[clamp(1.25rem,5vw,2rem)]">
            <h2 className="font-serif text-[1.375rem] leading-snug">Start a new design?</h2>
            <p className="mt-2 text-[0.875rem] text-mid leading-[1.6]">
              {ideaName.trim() ? (
                <>
                  <strong className="text-fg font-medium">{ideaName.trim()}</strong> is on the
                  canvas.
                </>
              ) : (
                "Your current design is on the canvas."
              )}{" "}
              Save it to your projects first - then start fresh.
            </p>
            <div className="mt-4 flex flex-col gap-1.5">
              <button
                type="button"
                disabled={saving || newConfirm.saved}
                onClick={() => {
                  void saveIdea().then((ok) => {
                    if (ok) setNewConfirm((c) => (c ? { saved: true } : c));
                  });
                }}
                className="w-full inline-flex items-center justify-center px-6 py-3 border border-fg text-[0.8125rem] tracking-[0.08em] uppercase hover:bg-fg hover:text-bg transition-colors disabled:opacity-60 cursor-pointer"
              >
                {newConfirm.saved ? "✓ Saved to your projects" : saving ? "Saving…" : "Save current project"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setNewConfirm(null);
                  void newIdea();
                }}
                className="w-full inline-flex items-center justify-center px-6 py-3 bg-fg text-bg text-[0.8125rem] tracking-[0.08em] uppercase hover:opacity-85 cursor-pointer"
              >
                Start new design
              </button>
              <button
                type="button"
                onClick={() => setNewConfirm(null)}
                className="w-full text-center text-[0.75rem] text-mid underline underline-offset-2 hover:text-fg cursor-pointer py-1"
              >
                Cancel - keep working on this one
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {prodExport ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Design files"
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <div className="absolute inset-0 bg-fg/40" onClick={() => setProdExport(null)} />
          <div className="cf-fade-in relative w-full max-w-[26rem] bg-bg border border-fg p-[clamp(1.25rem,5vw,2rem)] max-h-[90vh] overflow-y-auto">
            <h2 className="font-serif text-[1.375rem] leading-snug">Design files</h2>
            <p className="mt-2 text-[0.8125rem] text-mid leading-[1.6]">
              Traced at{" "}
              <strong className="text-fg font-medium">
                {prodExport.widthIn}&Prime; × {prodExport.heightIn}&Prime;
              </strong>{" "}
              - the size it sits on the garment. {prodExport.pieces}{" "}
              {prodExport.pieces === 1 ? "piece" : "pieces"} to cut.
            </p>
            <div className="mt-3 border border-hairline bg-card p-2 flex items-center justify-center">
              <img
                src={`data:image/svg+xml;base64,${btoa(prodExport.svg)}`}
                alt="Traced cut paths preview"
                className="max-h-48 max-w-full"
              />
            </div>
            {prodExport.smallCount > 0 ? (
              <div className="mt-3 border-l-2 border-fg pl-3 text-[0.75rem] text-mid leading-[1.6]">
                <strong className="text-fg font-medium">
                  {prodExport.smallCount}{" "}
                  {prodExport.smallCount === 1 ? "piece is" : "pieces are"} smaller than 3&nbsp;mm
                </strong>{" "}
                at this size ({prodExport.smallSizes.join(", ")}&nbsp;mm). Tiny pieces are
                hard to cut and weed in vinyl - consider making the design larger,
                simplifying small details, or letting them go. You can still export as-is.
              </div>
            ) : (
              <p className="mt-3 text-[0.75rem] text-mid">
                No pieces under 3&nbsp;mm - this should cut and weed cleanly at this size.
              </p>
            )}
            <p className="mt-3 text-[0.6875rem] text-dim leading-snug">
              The SVG is the unmirrored master. For heat-transfer vinyl, mirror it in the
              cutting software before cutting - a note inside the file says the same.
              These are working files to design and plan with - not final production
              files. The studio checks and preps everything before anything is made.
            </p>
            <div className="mt-4 flex flex-col gap-1.5">
              <button
                type="button"
                onClick={downloadCutSvg}
                className="w-full inline-flex items-center justify-center px-6 py-3 bg-fg text-bg text-[0.8125rem] tracking-[0.08em] uppercase hover:opacity-85 cursor-pointer"
              >
                Download SVG cut file
              </button>
              <button
                type="button"
                onClick={() => void downloadArtworkPng()}
                className="w-full inline-flex items-center justify-center px-6 py-3 border border-fg text-[0.8125rem] tracking-[0.08em] uppercase hover:bg-fg hover:text-bg transition-colors cursor-pointer"
              >
                Download artwork PNG (transparent)
              </button>
              <button
                type="button"
                onClick={() => setProdExport(null)}
                className="w-full text-center text-[0.75rem] text-mid underline underline-offset-2 hover:text-fg cursor-pointer py-1"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showAbout ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="About Bayside"
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <div className="absolute inset-0 bg-fg/40" onClick={() => setShowAbout(false)} />
          <div className="cf-fade-in relative w-full max-w-[24rem] bg-bg border border-fg p-[clamp(1.25rem,5vw,2rem)]">
            <h2 className="font-serif text-[1.375rem] leading-snug">Bayside</h2>
            <p className="mt-3 text-[0.875rem] text-mid leading-[1.65]">
              Bayside is a design studio in San Francisco. We run workshops
              across a wide variety of creative mediums &amp; create custom
              clothing for clients. This &ldquo;Lab&rdquo; tool is the
              studio&rsquo;s design playground - use it to experiment with
              ideas for your own merch, or something you&rsquo;d like to work
              with us on bringing to life.
            </p>
            <p className="mt-3 text-[0.875rem] text-mid leading-[1.65]">
              Want something made?{" "}
              <a
                href="/"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-fg"
              >
                Start a project on the main site
              </a>{" "}
              (opens in a new tab), or find us at{" "}
              <a
                href="https://instagram.com/baysidesf"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-fg"
              >
                @baysidesf
              </a>{" "}
              - or{" "}
              <a
                href="https://instagram.com/jakestitches"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-fg"
              >
                @jakestitches
              </a>
              , Jacob&rsquo;s personal embroidery practice.
            </p>
            <button
              type="button"
              onClick={() => setShowAbout(false)}
              className="mt-5 w-full inline-flex items-center justify-center px-7 py-3 bg-fg text-bg text-[0.8125rem] tracking-[0.08em] uppercase hover:opacity-85 cursor-pointer"
            >
              Back to the editor
            </button>
          </div>
        </div>
      ) : null}

      {showGuide ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Lab guide"
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <div className="absolute inset-0 bg-fg/40" onClick={() => setShowGuide(false)} />
          <div className="cf-fade-in relative w-full max-w-[30rem] max-h-[88vh] overflow-y-auto bg-bg border border-fg p-[clamp(1.25rem,5vw,2rem)]">
            <h2 className="font-serif text-[1.375rem] leading-snug">Lab guide</h2>
            <div className="mt-4 flex flex-col gap-4 text-[0.875rem] text-mid leading-[1.65]">
              <div>
                <h3 className={LABEL}>Getting around</h3>
                <p className="mt-1">
                  <strong className="text-fg font-medium">Studio</strong> is where
                  you design. <strong className="text-fg font-medium">Saved
                  ideas</strong> holds everything you&rsquo;ve saved, grouped by
                  collection.{" "}
                  <strong className="text-fg font-medium">Creative
                  resources</strong> (below) is the studio&rsquo;s collection
                  of references and links. On a computer the
                  Studio fills the window: garment on the left, tool cards on
                  the right (one open at a time), and layer thumbnails along
                  the garment&rsquo;s edge for switching between placed
                  designs. On a phone it works like a photo editor: tools in
                  the tab bar at the bottom, panels opening under the garment,
                  and tapping a placed design brings up its controls. Reopen
                  this guide anytime with the{" "}
                  <strong className="text-fg font-medium">?</strong> button.
                </p>
              </div>
              <div>
                <h3 className={LABEL}>Designing</h3>
                <p className="mt-1">
                  Pick a blank and a color under{" "}
                  <strong className="text-fg font-medium">Blanks</strong>. Drop
                  in a PNG or SVG, tap it to select, then tap the garment to
                  place it. Tap any placed design to move it, scale it in real
                  inches (slider or corner-drag - your choice, and you can
                  lock the size), rotate it, flip it, recolor it to a Madeira
                  thread, or run effects on it (halftone, dither…). The + / −
                  controls on the canvas zoom in for fine placement.
                </p>
              </div>
              <div>
                <h3 className={LABEL}>Designs, motifs &amp; text</h3>
                <p className="mt-1">
                  Anything you upload is saved to your own design library, and
                  the <strong className="text-fg font-medium">Find art</strong>{" "}
                  tool brings in free public-domain and openly licensed images - each shows its license and credit.
                  The <strong className="text-fg font-medium">Text</strong> tool
                  renders type as a placeable design - straight, arched, waved,
                  circled, or stacked - from a curated font library, with your
                  own OTF/TTF files under{" "}
                  <strong className="text-fg font-medium">More fonts</strong>.
                  Feeling lucky? The{" "}
                  <strong className="text-fg font-medium">Random</strong> roll
                  sets your words in a surprise font and layout - keep rolling
                  until it clicks.
                </p>
              </div>
              <div>
                <h3 className={LABEL}>Without an account</h3>
                <p className="mt-1">
                  Everything above works signed out - ideas save to this browser
                  only.
                </p>
              </div>
              <div>
                <h3 className={LABEL}>With an account</h3>
                <p className="mt-1">
                  <strong className="text-fg font-medium">Sign in</strong> (top
                  right) with your email and password - creating an account
                  takes a minute and a one-time email confirmation. That
                  unlocks: ideas synced across devices, a personal design
                  library that keeps every upload, and your imported fonts on
                  any machine.
                </p>
              </div>
              <div>
                <h3 className={LABEL}>Saving &amp; ordering</h3>
                <p className="mt-1">
                  Save an idea with a name, quantity, collection, and thread
                  picks - they live in <strong className="text-fg font-medium">
                  Saved ideas</strong>. Staff accounts also see queuing and the
                  per-brand blank order plan there, with editable costs.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="mt-6 w-full inline-flex items-center justify-center px-7 py-3 bg-fg text-bg text-[0.8125rem] tracking-[0.08em] uppercase hover:opacity-85 cursor-pointer"
            >
              Close
            </button>
            {policy.toolbox ? (
              <button
                type="button"
                onClick={() => {
                  setShowGuide(false);
                  setTab("toolbox");
                }}
                className="mt-2.5 w-full text-center text-[0.75rem] text-mid underline underline-offset-2 hover:text-fg cursor-pointer"
              >
                Creative resources - references, links, and design resources
                collected by Bayside
              </button>
            ) : null}
            {!youth ? (
              <button
                type="button"
                onClick={() => {
                  setShowGuide(false);
                  setShowAbout(true);
                }}
                className="mt-2.5 w-full text-center text-[0.75rem] text-mid underline underline-offset-2 hover:text-fg cursor-pointer"
              >
                About the studio
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {showLogin ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Sign in or create an account"
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <div className="absolute inset-0 bg-fg/40" onClick={() => { if (!authRequired) setShowLogin(false); }} />
          <div className="cf-fade-in relative w-full max-w-[22rem] bg-bg border border-fg p-[clamp(1.25rem,5vw,2rem)]">
            {!authRequired ? (
              <button
                type="button"
                onClick={() => setShowLogin(false)}
                aria-label="Close sign-in"
                className="absolute top-2 right-2 w-8 h-8 text-[1rem] leading-none text-mid hover:text-fg cursor-pointer"
              >
                ✕
              </button>
            ) : null}
            <h2 className="font-serif text-[1.375rem] leading-snug">
              {authView === "signup"
                ? "Create your Lab account"
                : authView === "reset" || authView === "resetcode"
                  ? "Reset your password"
                  : authView === "code"
                    ? "Check your email"
                    : "Sign in to the Lab"}
            </h2>
            <p className="mt-2 text-[0.8125rem] text-mid leading-[1.6]">
              {authView === "signup"
                ? "Your ideas and design library sync to your account on any device."
                : authView === "code"
                  ? codeNote ?? "We emailed you a 6-digit code."
                  : authView === "reset"
                    ? "Enter your account email and we'll send a reset code."
                    : authView === "resetcode"
                      ? codeNote ?? "Enter the emailed code and your new password."
                      : ""}
            </p>
            <div className="mt-4 flex flex-col gap-2.5">
              {authView !== "code" ? (
                <input
                  type="email"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder="you@email.com"
                  aria-label="Email"
                  autoComplete="email"
                  disabled={loginStage === "busy" || authView === "resetcode"}
                  className={FIELD}
                />
              ) : null}
              {authView === "signin" || authView === "signup" || authView === "resetcode" ? (
                <input
                  type="password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder={
                    authView === "resetcode"
                      ? "New password (8+ characters)"
                      : authView === "signup"
                        ? "Choose a password (8+ characters)"
                        : "Password"
                  }
                  aria-label={authView === "resetcode" ? "New password" : "Password"}
                  autoComplete={authView === "signin" ? "current-password" : "new-password"}
                  disabled={loginStage === "busy"}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && authView === "signin") doSignin();
                    if (e.key === "Enter" && authView === "signup") doSignup();
                  }}
                  className={FIELD}
                />
              ) : null}
              {authView === "code" || authView === "resetcode" ? (
                <input
                  value={loginCode}
                  onChange={(e) => setLoginCode(e.target.value)}
                  placeholder="6-digit code from your email"
                  aria-label="Code"
                  inputMode="numeric"
                  disabled={loginStage === "busy"}
                  className={FIELD}
                />
              ) : null}
              {loginError ? (
                <p className="text-[0.8125rem] text-red-700" role="alert">
                  {loginError}
                </p>
              ) : null}
              <button
                type="button"
                disabled={loginStage === "busy"}
                onClick={
                  authView === "signin"
                    ? doSignin
                    : authView === "signup"
                      ? doSignup
                      : authView === "code"
                        ? doCodeVerify
                        : authView === "reset"
                          ? doResetRequest
                          : doResetVerify
                }
                className="inline-flex items-center justify-center px-6 py-2.5 bg-fg text-bg text-[0.8125rem] tracking-[0.08em] uppercase hover:opacity-85 disabled:opacity-50 cursor-pointer"
              >
                {loginStage === "busy"
                  ? "Working…"
                  : authView === "signin"
                    ? "Sign in"
                    : authView === "signup"
                      ? "Create account"
                      : authView === "code"
                        ? "Verify code"
                        : authView === "reset"
                          ? "Send reset code"
                          : "Set new password"}
              </button>
              {authView === "signin" ? (
                <div className="flex items-center justify-between text-[0.75rem]">
                  <button
                    type="button"
                    onClick={() => {
                      setAuthView("signup");
                      setLoginError(null);
                    }}
                    className="text-mid underline underline-offset-2 hover:text-fg cursor-pointer"
                  >
                    Create an account
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAuthView("reset");
                      setLoginError(null);
                    }}
                    className="text-mid underline underline-offset-2 hover:text-fg cursor-pointer"
                  >
                    Forgot password?
                  </button>
                </div>
              ) : authView !== "code" ? (
                <button
                  type="button"
                  onClick={() => {
                    setAuthView("signin");
                    setLoginError(null);
                    setLoginCode("");
                  }}
                  className="self-start text-[0.75rem] text-mid underline underline-offset-2 hover:text-fg cursor-pointer"
                >
                  Back to sign in
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setAuthView("signin");
                    setLoginError(null);
                    setLoginCode("");
                  }}
                  className="self-start text-[0.75rem] text-mid underline underline-offset-2 hover:text-fg cursor-pointer"
                >
                  Start over
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <nav className="sticky top-0 z-30 h-nav flex items-center bg-bg/90 backdrop-blur-md border-b border-hairline">
        <div className="w-full max-w-site mx-auto px-pad flex items-center justify-between gap-3">
          <span
            className="text-fg select-none"
            style={{
              fontFamily: "'Playfair Display', var(--font-serif)",
              fontWeight: 500,
              letterSpacing: "-0.005em",
              fontSize: "clamp(1.0625rem, 1.5vw, 1.25rem)",
            }}
          >
            {youth ? "Design Studio" : "Bayside"}
          </span>
          <div
            className="flex items-center gap-1.5 sm:gap-2 min-w-0 overflow-x-auto"
            style={{ scrollbarWidth: "none" }}
          >
            {(
              [
                ["studio", "Studio", "Studio"],
                [
                  "pipeline",
                  `Saved ideas${ideas.length ? ` (${ideas.length})` : ""}`,
                  // "Saved ideas" overflows a phone nav - shorten it there
                  `Ideas${ideas.length ? ` (${ideas.length})` : ""}`,
                ],
                // cost estimator is a staff-only planning tool for now
                ...(role.staff
                  ? ([["costs", "Cost estimator", "Costs"]] as const)
                  : []),
                ...(role.admin
                  ? ([["overview", "Overview", "Users"]] as const)
                  : []),
              ] as [typeof tab, string, string][]
            ).map(([t, label, short]) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`px-2 sm:px-3 py-1.5 text-[0.6875rem] sm:text-[0.75rem] tracking-[0.04em] sm:tracking-[0.08em] uppercase border cursor-pointer whitespace-nowrap ${
                  tab === t
                    ? "border-fg bg-fg text-bg"
                    : "border-hairline text-mid hover:border-fg"
                }`}
              >
                <span className="sm:hidden">{short}</span>
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
            {authEmail && syncState !== "idle" ? (
              <span
                aria-live="polite"
                className="hidden md:inline-flex items-center px-1.5 py-1.5 text-[0.6875rem] text-mid whitespace-nowrap"
                title={
                  syncState === "local"
                    ? "Your work is saved on this device and will sync to your account when the connection returns."
                    : undefined
                }
              >
                {syncState === "saving"
                  ? "Saving…"
                  : syncState === "synced"
                    ? "✓ Saved · synced"
                    : "Saved on this device - will sync"}
              </span>
            ) : null}
            {authEmail ? (
              <button
                type="button"
                onClick={() => {
                  if (confirmSignOut) {
                    setConfirmSignOut(false);
                    if (signOutTimer.current) clearTimeout(signOutTimer.current);
                    signOut();
                  } else {
                    setConfirmSignOut(true);
                    if (signOutTimer.current) clearTimeout(signOutTimer.current);
                    signOutTimer.current = setTimeout(
                      () => setConfirmSignOut(false),
                      3000
                    );
                  }
                }}
                title={
                  confirmSignOut
                    ? "Click again to sign out"
                    : `Signed in as ${authEmail}`
                }
                className={`px-2 sm:px-3 py-1.5 text-[0.75rem] border cursor-pointer max-w-[10rem] truncate ${
                  confirmSignOut
                    ? "border-[#c0392b] text-[#c0392b]"
                    : "border-hairline text-mid hover:border-fg"
                }`}
              >
                {confirmSignOut ? (
                  <span className="uppercase tracking-[0.04em]">Sign out?</span>
                ) : (
                  <>
                    <span className="sm:hidden uppercase">{authEmail[0]}</span>
                    <span className="hidden sm:inline">{authEmail}</span>
                  </>
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setShowLogin(true)}
                className="px-2 sm:px-3 py-1.5 text-[0.6875rem] sm:text-[0.75rem] tracking-[0.04em] sm:tracking-[0.08em] uppercase border border-hairline text-mid hover:border-fg cursor-pointer whitespace-nowrap"
              >
                Sign in
              </button>
            )}
            <button
              type="button"
              onClick={() => (youth ? setTour(0) : setShowGuide(true))}
              aria-label={youth ? "Open the guided tour" : "Open the Lab guide"}
              className="w-7 h-7 shrink-0 border border-hairline text-mid hover:border-fg rounded-full text-[0.8125rem] cursor-pointer"
            >
              ?
            </button>
          </div>
        </div>
      </nav>

      {tab === "studio" ? (
        isMobile ? (
          /* ── fixed editor shell: canvas / secondary row / drawer / tabs ── */
          <div className="h-[calc(100dvh-var(--spacing-nav))] flex flex-col overflow-hidden">
            {/* canvas - owns the leftover height, garment letterboxes inside */}
            <div
              ref={canvasRegionRef}
              className="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden"
            >
              <div
                ref={previewRef}
                onClick={(e) => {
                  if (suppressClick.current) {
                    suppressClick.current = false; // that was a pan, not a tap
                    return;
                  }
                  if (armed) place(e.clientX, e.clientY);
                  else if (selected) setSelected(null); // empty tap → deselect
                }}
                onPointerDown={startPan}
                onPointerMove={onPan}
                onPointerUp={endPan}
                className={`relative bg-card border border-hairline select-none ${
                  armed ? "cursor-crosshair" : zoom > 1 ? "touch-none" : ""
                }`}
                style={{
                  width: canvasBox.w || undefined,
                  height: canvasBox.h || undefined,
                  transform:
                    zoom > 1
                      ? `scale(${zoom}) translate(${shownPan.x * 100}%, ${shownPan.y * 100}%)`
                      : undefined,
                }}
              >
                <img
                  src={viewImage}
                  alt={`${garment.label} in ${color.name} (${view})`}
                  onLoad={(e) => {
                    const im = e.currentTarget;
                    if (im.naturalWidth)
                      setImgDims({ w: im.naturalWidth, h: im.naturalHeight });
                  }}
                  className="block w-full h-full pointer-events-none"
                  draggable={false}
                />
                {(selected || armed) ? (() => {
                  const area = printAreaFor(garment, view);
                  return (
                    <div
                      aria-hidden="true"
                      className="absolute border border-dashed border-fg/30 pointer-events-none"
                      style={{
                        left: `${(area.x - area.w / 2) * 100}%`,
                        top: `${(area.y - area.h / 2) * 100}%`,
                        width: `${area.w * 100}%`,
                        height: `${area.h * 100}%`,
                      }}
                    >
                      <span className="absolute -top-4 left-0 text-[0.5625rem] uppercase tracking-[0.08em] text-fg/40">
                        print area
                      </span>
                    </div>
                  );
                })() : null}
                {viewPlacements.map((p) => {
                  const u = uploadById.get(p.uploadId);
                  if (!u) return null;
                  const src = renderUrls[p.id] ?? u.url;
                  const passes = p.blend && p.blend !== "normal" ? (p.passes ?? 3) : 1;
                  const isSel = selected === p.id;
                  return (
                    <div
                      key={p.id}
                      role="button"
                      aria-label={`${u.name} - drag to move, tap for controls`}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        startDrag(e, p);
                      }}
                      onPointerMove={onDrag}
                      onPointerUp={() => endDrag(p)}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute cursor-grab active:cursor-grabbing touch-none"
                      style={{
                        left: `${p.x * 100}%`,
                        top: `${p.y * 100}%`,
                        width: `${p.inches * inchFraction(garment) * 100}%`,
                        transform: `translate(-50%, -50%) rotate(${p.rotation || 0}deg)`,
                      }}
                    >
                      {Array.from({ length: passes }).map((_, i) => (
                        <img
                          key={i}
                          src={src}
                          alt=""
                          draggable={false}
                          className={`block w-full pointer-events-none ${
                            i > 0 ? "absolute inset-0" : ""
                          }`}
                          style={{
                            transform: p.flip ? "scaleX(-1)" : undefined,
                            mixBlendMode:
                              p.blend && p.blend !== "normal"
                                ? (p.blend as React.CSSProperties["mixBlendMode"])
                                : undefined,
                          }}
                        />
                      ))}
                      {isSel ? (
                        <>
                          <span
                            aria-hidden="true"
                            className="absolute -inset-1 border border-fg/60 pointer-events-none"
                          />
                          {p.locked ? (
                            <span
                              aria-hidden="true"
                              className="absolute -top-3 -right-3 text-[0.75rem] pointer-events-none"
                            >
                              🔒
                            </span>
                          ) : null}
                          {p.locked || resizeMode !== "handles" ||
                          (isMobile && p.inches * inchFraction(garment) < 0.16)
                            ? null
                            : (["nw", "ne", "sw", "se"] as const).map((corner) => (
                                <span
                                  key={corner}
                                  role="button"
                                  aria-label="Resize"
                                  onPointerDown={(e) => startResize(e, p)}
                                  onPointerMove={onResizeMove}
                                  onPointerUp={endResize}
                                  className={`absolute w-12 h-12 touch-none flex items-center justify-center ${
                                    corner === "nw"
                                      ? "-top-6 -left-6"
                                      : corner === "ne"
                                        ? "-top-6 -right-6"
                                        : corner === "sw"
                                          ? "-bottom-6 -left-6"
                                          : "-bottom-6 -right-6"
                                  }`}
                                >
                                  <span className="w-3 h-3 bg-bg border border-fg rounded-full" />
                                </span>
                              ))}
                        </>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {/* front/back chips */}
              {color.back ? (
                <div className="absolute top-2 inset-x-0 flex justify-center gap-1 pointer-events-none">
                  {(["front", "back"] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={view === v}
                      onClick={() => setView(v)}
                      className={`pointer-events-auto px-2.5 py-1 text-[0.6875rem] uppercase tracking-[0.06em] border backdrop-blur-sm cursor-pointer ${
                        view === v
                          ? "border-fg bg-fg text-bg"
                          : "border-hairline bg-bg/85 text-mid"
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              ) : null}

              {/* placement hint - a design is loaded but not placed yet */}
              {armed ? (
                <div className="absolute top-11 inset-x-0 flex justify-center pointer-events-none">
                  <span className="px-2.5 py-1 text-[0.6875rem] uppercase tracking-[0.06em] border border-hairline bg-bg/85 backdrop-blur-sm text-fg">
                    Tap the garment to place it
                  </span>
                </div>
              ) : null}
              {notice ? (
                <div className="absolute bottom-2 inset-x-0 flex justify-center pointer-events-none">
                  <span className="bg-fg text-bg text-[0.6875rem] px-2.5 py-1">{notice}</span>
                </div>
              ) : null}

              {/* placed-design chips, right gutter - top chip = on top */}
              {viewPlacements.length ? (
                <div
                  className={`absolute right-1.5 top-1/2 -translate-y-1/2 flex flex-col items-center gap-1.5 transition-opacity ${
                    chromeFaded ? "opacity-0 pointer-events-none" : ""
                  }`}
                >
                  {viewPlacements.length > 1 ? (
                    <button
                      type="button"
                      aria-label="Move the selected design up a layer (on top)"
                      disabled={!sel}
                      onClick={() => reorderSelected(1)}
                      className="w-11 h-8 shrink-0 border border-hairline bg-bg/90 text-fg text-[0.9375rem] disabled:opacity-35 cursor-pointer"
                    >
                      ↑
                    </button>
                  ) : null}
                  <div className="flex flex-col gap-1.5 max-h-[14.5rem] overflow-y-auto">
                    {[...viewPlacements].reverse().map((p) => {
                      const u = uploadById.get(p.uploadId);
                      return u ? (
                        <button
                          key={p.id}
                          type="button"
                          aria-label={`Select ${u.name}`}
                          onClick={() => setSelected(p.id)}
                          className={`w-11 h-11 shrink-0 bg-bg/90 border p-1 cursor-pointer ${
                            selected === p.id
                              ? "border-fg ring-1 ring-fg"
                              : "border-hairline"
                          }`}
                        >
                          <img
                            src={renderUrls[p.id] ?? u.url}
                            alt=""
                            className="w-full h-full object-contain"
                          />
                        </button>
                      ) : null;
                    })}
                  </div>
                  {viewPlacements.length > 1 ? (
                    <button
                      type="button"
                      aria-label="Move the selected design down a layer (behind)"
                      disabled={!sel}
                      onClick={() => reorderSelected(-1)}
                      className="w-11 h-8 shrink-0 border border-hairline bg-bg/90 text-fg text-[0.9375rem] disabled:opacity-35 cursor-pointer"
                    >
                      ↓
                    </button>
                  ) : null}
                  <button
                    type="button"
                    aria-label="Add a design"
                    onClick={() => {
                      setSelected(null);
                      stashedNav.current = null;
                      setActiveTab("designs");
                      setActiveDetail("studio");
                    }}
                    className="w-11 h-11 shrink-0 border border-hairline bg-bg/90 text-mid text-[1.125rem] leading-none cursor-pointer"
                  >
                    +
                  </button>
                </div>
              ) : null}

              {/* undo / redo */}
              <div
                className={`absolute left-2 bottom-2 flex gap-1.5 transition-opacity ${
                  chromeFaded ? "opacity-0 pointer-events-none" : ""
                }`}
              >
                <button
                  type="button"
                  aria-label="Undo"
                  disabled={!histRef.current.past.length}
                  onClick={undo}
                  className="w-11 h-11 border border-hairline bg-bg/90 text-fg text-[1.125rem] disabled:opacity-35 cursor-pointer"
                >
                  ↺
                </button>
                <button
                  type="button"
                  aria-label="Redo"
                  disabled={!histRef.current.future.length}
                  onClick={redo}
                  className="w-11 h-11 border border-hairline bg-bg/90 text-fg text-[1.125rem] disabled:opacity-35 cursor-pointer"
                >
                  ↻
                </button>
              </div>

              {/* zoom in / out on the garment */}
              <div
                className={`absolute right-1.5 bottom-2 flex gap-1.5 transition-opacity ${
                  chromeFaded ? "opacity-0 pointer-events-none" : ""
                }`}
              >
                {zoom > 1 ? (
                  <>
                    <button
                      type="button"
                      aria-pressed={panMode}
                      aria-label={panMode ? "Done moving the view" : "Move the view"}
                      onClick={() => setPanMode((m) => !m)}
                      className={`h-11 px-2.5 border text-[0.6875rem] uppercase tracking-[0.04em] cursor-pointer ${
                        panMode
                          ? "border-fg bg-fg text-bg"
                          : "border-hairline bg-bg/90 text-mid"
                      }`}
                    >
                      {panMode ? "Done" : "Move view"}
                    </button>
                    <button
                      type="button"
                      aria-label="Reset zoom"
                      onClick={resetZoom}
                      className="h-11 px-2 border border-hairline bg-bg/90 text-mid text-[0.6875rem] uppercase tracking-[0.04em] cursor-pointer"
                    >
                      Fit
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  aria-label="Zoom out"
                  disabled={zoom <= 1}
                  onClick={() => zoomBy(-0.5)}
                  className="w-11 h-11 border border-hairline bg-bg/90 text-fg text-[1.125rem] disabled:opacity-35 cursor-pointer"
                >
                  −
                </button>
                <button
                  type="button"
                  aria-label="Zoom in"
                  disabled={zoom >= MAX_ZOOM}
                  onClick={() => zoomBy(0.5)}
                  className="w-11 h-11 border border-hairline bg-bg/90 text-fg text-[1.125rem] disabled:opacity-35 cursor-pointer"
                >
                  +
                </button>
              </div>
              <span className="sr-only" role="status" aria-live="polite">
                {announce}
              </span>
            </div>

            {onboardBanner}
            {continueBanner}

            {/* contextual secondary row */}
            {secondaryItems.length ? (
              <div className="shrink-0 h-16 border-t border-hairline bg-bg">
                <div
                  className="h-full flex items-stretch gap-0.5 overflow-x-auto px-1"
                  style={{ scrollbarWidth: "none" }}
                >
                  {secondaryItems.map((it) => (
                    <button
                      key={it.id}
                      type="button"
                      aria-label={it.aria ?? it.label}
                      aria-pressed={Boolean(it.active)}
                      onClick={it.onTap}
                      className={`flex flex-col items-center justify-center gap-1 min-w-[4rem] px-2 cursor-pointer ${
                        it.danger && it.active
                          ? "text-[#c0392b]"
                          : it.active
                            ? "text-fg"
                            : "text-mid"
                      }`}
                    >
                      <span
                        className={`flex items-center justify-center w-8 h-8 border ${
                          it.danger && it.active
                            ? "border-[#c0392b] bg-[#c0392b] text-white"
                            : it.active
                              ? "border-fg bg-fg text-bg"
                              : "border-hairline bg-card"
                        }`}
                      >
                        {it.icon}
                      </span>
                      <span className="text-[0.5625rem] tracking-[0.06em] uppercase whitespace-nowrap">
                        {it.label}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {/* drawer - expands in place, shrinking the canvas above */}
            <div
              className="shrink-0 overflow-hidden border-t border-hairline bg-bg transition-[max-height] duration-200 ease-out"
              style={{ maxHeight: drawerOpen ? "35dvh" : 0 }}
            >
              <div className="max-h-[35dvh] overflow-y-auto overscroll-contain px-3 py-3">
                {designCtx && sel ? (
                  activeDetail === "size" ? (
                    <div className="flex flex-col gap-2.5">
                      {sel.locked ? (
                        <p className="text-[0.8125rem] text-mid">
                          🔒 Size is locked - dragging only moves the design.
                          Tap Lock below to unlock.
                        </p>
                      ) : (
                        <div className="flex items-center gap-2.5">
                          <button
                            type="button"
                            aria-label="Smaller"
                            disabled={sel.inches <= MIN_IN}
                            onClick={() => stepInches(-0.5)}
                            className="w-11 h-11 shrink-0 border border-hairline bg-card text-fg text-[1.125rem] disabled:opacity-35 cursor-pointer"
                          >
                            −
                          </button>
                          <input
                            type="range"
                            min={MIN_IN}
                            max={MAX_IN}
                            step={0.1}
                            value={sel.inches}
                            onPointerDown={pushHistory}
                            onChange={(e) => {
                              onboardTo(4);
                              update(sel.id, { inches: Number(e.target.value) });
                            }}
                            aria-label="Design width in inches"
                            className="flex-1 accent-fg"
                          />
                          <button
                            type="button"
                            aria-label="Larger"
                            disabled={sel.inches >= MAX_IN}
                            onClick={() => stepInches(0.5)}
                            className="w-11 h-11 shrink-0 border border-hairline bg-card text-fg text-[1.125rem] disabled:opacity-35 cursor-pointer"
                          >
                            +
                          </button>
                          <span className="text-[0.8125rem] text-fg tabular-nums whitespace-nowrap">
                            {sel.inches.toFixed(1)}&Prime;
                          </span>
                        </div>
                      )}
                      {warningsBlock}
                    </div>
                  ) : activeDetail === "rotate" ? (
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={-180}
                        max={180}
                        step={1}
                        value={sel.rotation ?? 0}
                        onPointerDown={pushHistory}
                        onChange={(e) => update(sel.id, { rotation: Number(e.target.value) })}
                        aria-label="Rotation in degrees"
                        className="flex-1 accent-fg"
                      />
                      <span className="w-11 text-right text-[0.8125rem] text-mid tabular-nums">
                        {Math.round(sel.rotation ?? 0)}°
                      </span>
                      <button
                        type="button"
                        disabled={!sel.rotation}
                        onClick={() => {
                          pushHistory();
                          update(sel.id, { rotation: 0 });
                        }}
                        className="border border-hairline px-2.5 py-1.5 text-[0.6875rem] uppercase tracking-[0.04em] text-mid disabled:opacity-40 cursor-pointer"
                      >
                        Straighten
                      </button>
                    </div>
                  ) : activeDetail === "thread" ? (
                    <div className="flex flex-col gap-1.5">
                      <span className="text-[0.75rem] text-mid">
                        {sel.thread
                          ? `${sel.thread.code} ${sel.thread.name}`
                          : "Original colors - tap a swatch to recolor"}
                      </span>
                      <div className="flex items-center gap-2 overflow-x-auto pb-1">
                        <button
                          type="button"
                          aria-label="Back to original colors"
                          onClick={() => applyThreadToPlacement(sel, null)}
                          className={`w-11 h-11 shrink-0 rounded-full border text-[0.625rem] text-mid cursor-pointer ${
                            sel.thread ? "border-hairline" : "border-fg ring-1 ring-fg"
                          }`}
                        >
                          orig
                        </button>
                        {paletteFamilies.map(({ family, threads }) => (
                          <div key={family} className="flex items-center gap-1.5">
                            <span className="sticky left-0 z-10 bg-bg shrink-0 text-[0.5625rem] tracking-[0.1em] uppercase text-dim [writing-mode:vertical-rl] rotate-180 py-0.5">
                              {family}
                            </span>
                            {threads.map((t) => {
                              const active =
                                sel.thread?.code === t.code && sel.thread?.hex === t.hex;
                              return (
                                <button
                                  key={`${t.code}-${t.family}`}
                                  type="button"
                                  aria-label={`Thread ${t.code} ${t.name}`}
                                  onClick={() =>
                                    applyThreadToPlacement(sel, {
                                      code: t.code,
                                      name: t.name,
                                      hex: t.hex!,
                                    })
                                  }
                                  className={`w-11 h-11 shrink-0 rounded-full border cursor-pointer ${
                                    active
                                      ? "border-fg ring-2 ring-fg ring-offset-1 ring-offset-bg"
                                      : "border-hairline"
                                  }`}
                                  style={{ backgroundColor: t.hex! }}
                                />
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : activeDetail === "effects" ? (
                    <div className="flex flex-col gap-1.5">
                      <span className="text-[0.75rem] text-mid">
                        One tap makes a new version in place - the original
                        stays in My designs.
                      </span>
                      <div className="flex gap-1.5 overflow-x-auto pb-1">
                        {EFFECTS.map((e) => (
                          <button
                            key={e.id}
                            type="button"
                            disabled={applyingEffect}
                            onClick={() => runEffect(e.id)}
                            className="shrink-0 border border-hairline px-3 py-2.5 text-[0.75rem] text-mid disabled:opacity-40 cursor-pointer"
                          >
                            {applyingEffect ? "…" : e.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : activeDetail === "font-edit" && uploadById.get(sel.uploadId)?.textMeta ? (
                    <div className="flex flex-col gap-1.5">
                      <span className="text-[0.75rem] text-mid">
                        Same word, different font - tap to swap it in place
                      </span>
                      <div className="flex gap-1.5 overflow-x-auto pb-1">
                        {fontChoices.map((f) => {
                          const meta = uploadById.get(sel.uploadId)!.textMeta!;
                          return (
                            <button
                              key={f.family}
                              type="button"
                              aria-label={`Font ${f.name}`}
                              aria-pressed={meta.font === f.family}
                              onClick={() => void changeTextFont(sel, f.family)}
                              className={`shrink-0 min-w-[4.5rem] border px-2 py-1.5 text-left cursor-pointer ${
                                meta.font === f.family
                                  ? "border-fg ring-1 ring-fg"
                                  : "border-hairline"
                              }`}
                            >
                              <span
                                className="block text-[1.125rem] leading-none whitespace-nowrap max-w-[7rem] overflow-hidden"
                                style={{ fontFamily: `"${f.family}"` }}
                              >
                                {meta.text.slice(0, 10)}
                              </span>
                              <span className="mt-1 block text-[0.5625rem] text-mid truncate max-w-[5rem]">
                                {f.name}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null
                ) : activeTab === "blanks" ? (
                  <div className="flex flex-col gap-2.5">
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {visibleGarments.map((g) => (
                        <button
                          key={g.id}
                          type="button"
                          aria-label={`${g.label} - ${g.sub}`}
                          onClick={() => switchGarment(g)}
                          className={`shrink-0 w-[5.5rem] border p-1.5 text-left cursor-pointer ${
                            g.id === garment.id
                              ? "border-fg ring-1 ring-fg"
                              : "border-hairline"
                          }`}
                        >
                          <img
                            src={g.colors[0].front}
                            alt=""
                            loading="lazy"
                            className="w-full aspect-square object-cover bg-card"
                          />
                          <span className="mt-1 block text-[0.625rem] leading-tight truncate">
                            {g.label}
                          </span>
                          <span className="block text-[0.5625rem] text-dim truncate">
                            {g.colors.length} colors
                          </span>
                        </button>
                      ))}
                    </div>
                    <div>
                      <span className={LABEL}>Color - {color.name}</span>
                      <div className="mt-1.5 flex gap-1.5 overflow-x-auto pb-1">
                        {garment.colors.map((c) => (
                          <button
                            key={c.slug}
                            type="button"
                            aria-label={`Color ${c.name}`}
                            title={c.name}
                            onClick={() => {
                              onboardTo(2);
                              setColorSlug(c.slug);
                            }}
                            className={`w-11 h-11 shrink-0 rounded-full border cursor-pointer transition-all duration-150 ${
                              c.slug === color.slug
                                ? "border-bg ring-2 ring-accent ring-offset-2 ring-offset-bg shadow-[0_0_10px_2px_rgba(8,40,112,0.45)] scale-110"
                                : "border-hairline"
                            }`}
                            style={{ backgroundColor: c.hex }}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                ) : activeTab === "designs" && activeDetail === "mine" ? (
                  <div className="flex flex-col gap-2">
                    {uploads.length === 0 && library.length === 0 ? (
                      <p className="text-[0.8125rem] text-mid">
                        Nothing here yet - upload a PNG or SVG, or grab a studio
                        design.
                      </p>
                    ) : null}
                    {uploads.length ? (
                      <div className="flex gap-2 overflow-x-auto pb-1 pt-1.5">
                        {uploads.map((u) => (
                          <div key={u.id} className="relative shrink-0">
                            <button
                              type="button"
                              aria-label={`Place ${u.name}`}
                              onClick={() => placeCentered(u.id)}
                              className="w-14 h-14 border border-hairline bg-card p-1 cursor-pointer"
                            >
                              <img
                                src={u.url}
                                alt={u.name}
                                className="w-full h-full object-contain"
                              />
                            </button>
                            <button
                              type="button"
                              aria-label={`Delete ${u.name}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                removeUpload(u.id);
                              }}
                              className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-fg text-bg text-[0.6875rem] leading-none cursor-pointer"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {authToken && library.length ? (
                      <>
                        <span className={LABEL}>Library</span>
                        <div className="flex gap-2 overflow-x-auto pb-1 pt-1.5">
                          {library.map((item) => (
                            <div key={item.id} className="relative shrink-0">
                              <button
                                type="button"
                                aria-label={`Place ${item.name}`}
                                onClick={() => addFromLibrary(item)}
                                className="w-14 h-14 border border-hairline bg-card p-1 cursor-pointer"
                              >
                                <img
                                  src={item.dataURL}
                                  alt={item.name}
                                  loading="lazy"
                                  className="w-full h-full object-contain"
                                />
                              </button>
                              <button
                                type="button"
                                aria-label={`Remove ${item.name} from library`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  removeFromLibrary(item.id);
                                }}
                                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-fg text-bg text-[0.6875rem] leading-none cursor-pointer"
                              >
                                ×
                              </button>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : null}
                  </div>
                ) : activeTab === "designs" && activeDetail === "studio" ? (
                  <div className="flex flex-col gap-2">
                    <input
                      value={shapeQuery}
                      onChange={(e) => setShapeQuery(e.target.value)}
                      placeholder="Search designs…"
                      aria-label="Search studio designs"
                      className={FIELD}
                    />
                    <div className="grid grid-rows-2 grid-flow-col auto-cols-[4rem] gap-1.5 overflow-x-auto pb-1">
                      {shownShapes.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          aria-label={`Place ${s.name}`}
                          onClick={() => addShape(s)}
                          className="w-16 h-16 border border-hairline bg-card p-1 cursor-pointer"
                        >
                          <img
                            src={s.url}
                            alt={s.name}
                            loading="lazy"
                            className="w-full h-full object-contain"
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                ) : activeTab === "text" && activeDetail !== "type" ? (
                  <div className="flex flex-col gap-2.5">
                    <div className="grid grid-cols-[1fr_auto] gap-2">
                      <input
                        value={textValue}
                        onChange={(e) => setTextValue(e.target.value)}
                        placeholder="Type something…"
                        aria-label="Text to add"
                        className={FIELD}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") addText();
                        }}
                      />
                      <button
                        type="button"
                        onClick={addText}
                        disabled={!textValue.trim()}
                        className="px-4 py-2 border border-fg text-[0.75rem] tracking-[0.06em] uppercase disabled:opacity-40 cursor-pointer"
                      >
                        {editingTextId ? "Update" : "Add"}
                      </button>
                    </div>
                    {textPreview ? (
                      <div className="border border-hairline bg-card px-2 py-1.5 flex items-center justify-center">
                        <img src={textPreview} alt="Preview of your styled text" className="max-h-14 max-w-full" />
                      </div>
                    ) : null}
                    {activeDetail === "style" ? (
                      <div className="flex flex-col gap-2">
                      <div className="flex gap-1.5 overflow-x-auto pb-1">
                        {TEXT_STYLES.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            aria-pressed={textStyle === s.id}
                            onClick={() => setTextStyle(s.id)}
                            className={`shrink-0 border px-3 py-2.5 text-[0.75rem] cursor-pointer ${
                              textStyle === s.id
                                ? "border-fg bg-fg text-bg"
                                : "border-hairline text-mid"
                            }`}
                          >
                            {s.label}
                          </button>
                        ))}
                      </div>
                      {textStyle === "arch" ? (
                        <>
                          <label className="flex items-center gap-2 text-[0.75rem] text-mid">
                            Curve
                            <input type="range" min={30} max={320} step={5} value={textCurve}
                              onChange={(e) => setTextCurve(Number(e.target.value))}
                              className="flex-1 accent-fg" aria-label="Curve amount" />
                            <span className="tabular-nums w-10 text-right">{textCurve}°</span>
                          </label>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              aria-pressed={!archDown}
                              onClick={() => setArchDown(false)}
                              className={`border px-3 py-2 text-[0.75rem] cursor-pointer ${!archDown ? "border-fg bg-fg text-bg" : "border-hairline text-mid"}`}
                            >
                              ∩ Up
                            </button>
                            <button
                              type="button"
                              aria-pressed={archDown}
                              onClick={() => setArchDown(true)}
                              className={`border px-3 py-2 text-[0.75rem] cursor-pointer ${archDown ? "border-fg bg-fg text-bg" : "border-hairline text-mid"}`}
                            >
                              ∪ Down
                            </button>
                          </div>
                        </>
                      ) : null}
                      <label className="flex items-center gap-2 text-[0.75rem] text-mid cursor-pointer">
                        <input
                          type="checkbox"
                          checked={textOutline}
                          onChange={(e) => setTextOutline(e.target.checked)}
                          className="accent-fg"
                        />
                        Outline letters
                      </label>
                      </div>
                    ) : (
                      <div className="flex gap-1.5 overflow-x-auto pb-1">
                        {fontChoices.map((f) => (
                          <button
                            key={f.family}
                            type="button"
                            aria-label={`Font ${f.name}`}
                            aria-pressed={fontChoice === f.family}
                            onClick={() => setFontChoice(f.family)}
                            className={`shrink-0 min-w-[4.5rem] border px-2 py-1.5 text-left cursor-pointer ${
                              fontChoice === f.family
                                ? "border-fg ring-1 ring-fg"
                                : "border-hairline"
                            }`}
                          >
                            <span
                              className="block text-[1.25rem] leading-none whitespace-nowrap max-w-[7rem] overflow-hidden"
                              style={{ fontFamily: `"${f.family}"` }}
                            >
                              {(textValue.trim() || "Abc").slice(0, 10)}
                            </span>
                            <span className="mt-1 block text-[0.5625rem] text-mid truncate max-w-[5rem]">
                              {f.name}
                            </span>
                          </button>
                        ))}
                        <button
                          type="button"
                          onClick={() => fontFileRef.current?.click()}
                          className="shrink-0 border border-dashed border-hairline px-3 text-[0.6875rem] text-mid cursor-pointer"
                        >
                          Upload font
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowFontsGuide(true)}
                          className="shrink-0 border border-hairline px-3 text-[0.6875rem] text-mid cursor-pointer"
                        >
                          Font sites?
                        </button>
                        {SYSTEM_FONTS_SUPPORTED ? (
                          <button
                            type="button"
                            onClick={loadSystemFonts}
                            className="shrink-0 border border-hairline px-3 text-[0.6875rem] text-mid cursor-pointer"
                          >
                            This device's fonts
                          </button>
                        ) : null}
                      </div>
                    )}
                  </div>
                ) : activeTab === "generators" && activeDetail === "motif" ? (
                  motifPreviewBlock ?? (
                    <p className="text-[0.875rem] text-mid">
                      Tap a shape style above to roll one.
                    </p>
                  )
                ) : activeTab === "text" && activeDetail === "type" ? (
                  <div className="flex flex-col gap-2">
                    <div className="grid grid-cols-[1fr_auto] gap-2">
                      <input
                        value={genWord}
                        onChange={(e) => setGenWord(e.target.value)}
                        placeholder="Your word - e.g. Bayside"
                        aria-label="Type motif word"
                        className={FIELD}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void previewTypeMotif();
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => void previewTypeMotif()}
                        className="px-4 py-2 bg-fg text-bg text-[0.75rem] tracking-[0.06em] uppercase cursor-pointer"
                      >
                        Roll it
                      </button>
                    </div>
                    {genPreview?.id === "type" ? (
                      motifPreviewBlock
                    ) : (
                      <p className="text-[0.6875rem] text-dim">
                        Your word set in a random font and layout - reroll until
                        it clicks.
                      </p>
                    )}
                  </div>
                ) : activeTab === "artlib" ? (
                  <div className="flex flex-col gap-3">{panelBody.artlib}</div>
                ) : activeTab === "save" ? (
                  placements.length === 0 ? (
                    <p className="text-[0.875rem] text-mid">
                      Place something on the garment first - then name it and
                      save it here.
                    </p>
                  ) : (
                    <div className="flex flex-col">{panelBody.save}</div>
                  )
                ) : null}
              </div>
            </div>

            {/* primary tab bar */}
            <div
              role="tablist"
              aria-label="Studio tools"
              className="shrink-0 flex border-t border-hairline bg-card pb-[env(safe-area-inset-bottom)]"
            >
              {MOBILE_TABS.map((t) => {
                const active = activeTab === t.id && !designCtx;
                return (
                  <button
                    key={t.id}
                    role="tab"
                    aria-selected={active}
                    aria-label={t.aria}
                    onClick={() => tapTab(t.id)}
                    className={`flex-1 flex flex-col items-center gap-1 py-2 cursor-pointer ${
                      active ? "bg-fg text-bg" : "text-mid"
                    }`}
                  >
                    {PANEL_ICONS[t.icon]}
                    <span className="text-[0.5625rem] tracking-[0.08em] uppercase">
                      {t.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
        <main className="flex h-[calc(100dvh-var(--spacing-nav))] overflow-hidden">
          {/* left icon rail - pick a tool, its panel opens in the sidebar
              (Stitch Lab workspace parity) */}
          <div className="w-[4.5rem] shrink-0 border-r border-hairline bg-card flex flex-col items-center py-2.5 gap-1.5">
            {([["blanks", "Blanks"], ["designs", "Designs"], ...(presetsVisible ? [["shapes", "Studio"] as const] : []), ["generators", "Shapes"], ["text", "Text"], ["artlib", "Find art"]] as const).map(([id, label]) => {
              const railActive = (activePanel ?? "blanks") === id;
              return (
                <button
                  key={id}
                  type="button"
                  title={label}
                  aria-pressed={railActive}
                  onClick={() => setActivePanel(id)}
                  className={`w-14 h-14 flex flex-col items-center justify-center gap-1 cursor-pointer ${
                    railActive ? "bg-fg text-bg" : "text-mid hover:text-fg hover:bg-bg"
                  }`}
                >
                  <span className="w-6 h-6 flex items-center justify-center [&>svg]:w-6 [&>svg]:h-6">{PANEL_ICONS[id]}</span>
                  <span className="text-[0.625rem] tracking-[0.05em] uppercase leading-none">{label}</span>
                </button>
              );
            })}
            {/* actions, not tools: new design, quick save, image download.
                Work autosaves anyway - Save is the reassurance button. */}
            <div className="w-full border-t border-hairline my-1" />
            <button
              type="button"
              title="Start a new design"
              onClick={startNewFlow}
              className="w-14 h-14 flex flex-col items-center justify-center gap-1 text-mid hover:text-fg hover:bg-bg cursor-pointer"
            >
              <span aria-hidden="true" className="text-[1.25rem] leading-none">+</span>
              <span className="text-[0.625rem] tracking-[0.05em] uppercase leading-none">New</span>
            </button>
            <button
              type="button"
              title="Save now - your work also saves itself automatically"
              disabled={!placements.length || saving}
              onClick={() => void saveIdea()}
              className="w-14 h-14 flex flex-col items-center justify-center gap-1 text-mid hover:text-fg hover:bg-bg disabled:opacity-35 cursor-pointer"
            >
              <span className="w-6 h-6 flex items-center justify-center [&>svg]:w-6 [&>svg]:h-6">{PANEL_ICONS.save}</span>
              <span className="text-[0.625rem] tracking-[0.05em] uppercase leading-none">{saving ? "…" : "Save idea"}</span>
            </button>
            <button
              type="button"
              title="Save to your library or export an image"
              disabled={!placements.length}
              onClick={() => setSaveMenu(true)}
              className="w-14 h-14 flex flex-col items-center justify-center gap-1 text-mid hover:text-fg hover:bg-bg disabled:opacity-35 cursor-pointer"
            >
              <span aria-hidden="true" className="text-[1.125rem] leading-none">↓</span>
              <span className="text-[0.625rem] tracking-[0.05em] uppercase leading-none">Export</span>
            </button>
          </div>

          {/* preview - the canvas owns the center; the garment letterboxes
              into the leftover space and the page never scrolls */}
          <section className="relative flex-1 min-w-0 min-h-0 flex flex-col">
            <div className="relative overflow-hidden bg-card select-none flex-1 min-h-0 flex items-center justify-center">
              {/* zoomed layer - garment + placements scale together so the
                  fraction-based placement math stays valid at any zoom */}
              <div
                ref={previewRef}
                onClick={(e) => {
                  if (suppressClick.current) {
                    suppressClick.current = false; // that was a pan, not a click
                    return;
                  }
                  if (armed) place(e.clientX, e.clientY);
                  else if (selected) setSelected(null); // empty click → deselect
                }}
                onPointerDown={startPan}
                onPointerMove={onPan}
                onPointerUp={endPan}
                className={`relative scroll-mt-[calc(var(--spacing-nav)+0.75rem)] h-full w-fit max-w-full ${
                  armed
                    ? "cursor-crosshair"
                    : zoom > 1
                      ? "cursor-grab active:cursor-grabbing touch-none"
                      : ""
                }`}
                style={{
                  transform:
                    zoom > 1
                      ? `scale(${zoom}) translate(${shownPan.x * 100}%, ${shownPan.y * 100}%)`
                      : undefined,
                }}
              >
              <img
                src={viewImage}
                alt={`${garment.label} in ${color.name} (${view})`}
                className="block pointer-events-none w-auto h-full"
                draggable={false}
              />
              {(selected || armed) ? (() => {
                  const area = printAreaFor(garment, view);
                  return (
                    <div
                      aria-hidden="true"
                      className="absolute border border-dashed border-fg/30 pointer-events-none"
                      style={{
                        left: `${(area.x - area.w / 2) * 100}%`,
                        top: `${(area.y - area.h / 2) * 100}%`,
                        width: `${area.w * 100}%`,
                        height: `${area.h * 100}%`,
                      }}
                    >
                      <span className="absolute -top-4 left-0 text-[0.5625rem] uppercase tracking-[0.08em] text-fg/40">
                        print area
                      </span>
                    </div>
                  );
                })() : null}
                {viewPlacements.map((p) => {
                const u = uploadById.get(p.uploadId);
                if (!u) return null;
                const src = renderUrls[p.id] ?? u.url;
                const passes = p.blend && p.blend !== "normal" ? (p.passes ?? 3) : 1;
                return (
                  <div
                    key={p.id}
                    role="button"
                    aria-label={`${u.name} - drag to move, tap to select`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      startDrag(e, p);
                    }}
                    onPointerMove={onDrag}
                    onPointerUp={() => endDrag(p)}
                    onClick={(e) => e.stopPropagation()}
                    className={`absolute cursor-grab active:cursor-grabbing touch-none ${
                      selected === p.id
                        ? "outline outline-2 outline-fg/70 outline-offset-2"
                        : ""
                    }`}
                    style={{
                      left: `${p.x * 100}%`,
                      top: `${p.y * 100}%`,
                      width: `${p.inches * inchFraction(garment) * 100}%`,
                      transform: `translate(-50%, -50%) rotate(${p.rotation || 0}deg)`,
                    }}
                  >
                    {Array.from({ length: passes }).map((_, i) => (
                      <img
                        key={i}
                        src={src}
                        alt=""
                        draggable={false}
                        className={`block w-full pointer-events-none ${
                          i > 0 ? "absolute inset-0" : ""
                        }`}
                        style={{
                          transform: p.flip ? "scaleX(-1)" : undefined,
                          mixBlendMode:
                            p.blend && p.blend !== "normal"
                              ? (p.blend as React.CSSProperties["mixBlendMode"])
                              : undefined,
                        }}
                      />
                    ))}
                    {selected === p.id && p.locked ? (
                      <span
                        aria-hidden="true"
                        className="absolute -top-3 -right-3 text-[0.75rem] pointer-events-none"
                      >
                        🔒
                      </span>
                    ) : null}
                    {selected === p.id && resizeMode === "handles" && !p.locked
                      ? (["nw", "ne", "sw", "se"] as const).map((corner) => (
                          <span
                            key={corner}
                            role="button"
                            aria-label="Resize"
                            onPointerDown={(e) => startResize(e, p)}
                            onPointerMove={onResizeMove}
                            onPointerUp={endResize}
                            className={`absolute w-6 h-6 touch-none flex items-center justify-center ${
                              corner === "nw"
                                ? "-top-3 -left-3 cursor-nwse-resize"
                                : corner === "ne"
                                  ? "-top-3 -right-3 cursor-nesw-resize"
                                  : corner === "sw"
                                    ? "-bottom-3 -left-3 cursor-nesw-resize"
                                    : "-bottom-3 -right-3 cursor-nwse-resize"
                            }`}
                          >
                            <span className="w-2.5 h-2.5 bg-bg border border-fg rounded-full" />
                          </span>
                        ))
                      : null}
                  </div>
                );
              })}
              </div>

              {/* front/back chips - overlaid like the mobile shell */}
              {color.back ? (
                <div className="absolute top-2 inset-x-0 flex justify-center gap-1 pointer-events-none">
                  {(["front", "back"] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={view === v}
                      onClick={() => setView(v)}
                      className={`pointer-events-auto px-2.5 py-1 text-[0.6875rem] uppercase tracking-[0.06em] border backdrop-blur-sm cursor-pointer ${
                        view === v
                          ? "border-fg bg-fg text-bg"
                          : "border-hairline bg-bg/85 text-mid hover:border-fg"
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              ) : null}

              {/* selected design - a floating inspector pinned to the canvas,
                  so the sidebar keeps showing the tool you're using and the
                  garment stays in view (same pattern as the color palette) */}
              {sel ? (
                <div className="absolute right-2 top-2 bottom-2 w-[19.5rem] z-20 bg-bg border border-fg shadow-lg flex flex-col">
                  <div className="shrink-0 flex items-center justify-between px-3 pt-2.5 pb-2 border-b border-hairline">
                    <span className={LABEL}>Selected design</span>
                    <button
                      type="button"
                      onClick={() => setSelected(null)}
                      className="text-[0.8125rem] text-mid underline underline-offset-2 hover:text-fg cursor-pointer"
                    >
                      Done
                    </button>
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-3 flex flex-col gap-2.5 text-[0.8125rem]">
                    {selControlsBody}
                  </div>
                </div>
              ) : null}

              {/* garment color - floating palette pinned to the canvas so it
                  never scrolls away with the Blanks panel */}
              {!sel && garment.colors.length > 1 ? (
                <div className="absolute right-2 top-2 z-10 flex flex-col items-end">
                  <button
                    type="button"
                    aria-expanded={colorPop}
                    title={`Item color - this changes the ${garment.label.toLowerCase()}'s color (${color.name})`}
                    onClick={() => setColorPop((o) => !o)}
                    className="flex items-center gap-2 border border-hairline bg-bg/90 backdrop-blur-sm px-2.5 py-1.5 text-[0.6875rem] uppercase tracking-[0.06em] text-mid hover:border-fg cursor-pointer"
                  >
                    <span
                      className="w-4 h-4 rounded-full border border-hairline"
                      style={{ backgroundColor: color.hex }}
                    />
                    Item color
                  </button>
                  {colorPop ? (
                    <div className="mt-1.5 w-[15.5rem] border border-hairline bg-bg shadow-lg p-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className={LABEL}>
                          {colorHover ?? color.name}
                        </span>
                        <button
                          type="button"
                          aria-label="Close the color palette"
                          onClick={() => {
                            setColorPop(false);
                            setColorHover(null);
                          }}
                          className="text-mid hover:text-fg cursor-pointer text-[0.9375rem] leading-none"
                        >
                          ×
                        </button>
                      </div>
                      <div
                        className="mt-2 flex flex-wrap gap-1.5 max-h-[13rem] overflow-y-auto overscroll-contain"
                        onMouseLeave={() => setColorHover(null)}
                      >
                        {garment.colors.map((c) => (
                          <button
                            key={c.slug}
                            type="button"
                            title={c.name}
                            aria-label={`Color ${c.name}`}
                            aria-pressed={c.slug === color.slug}
                            onClick={() => {
                              onboardTo(2);
                              setColorSlug(c.slug);
                            }}
                            onMouseEnter={() => setColorHover(c.name)}
                            className={`w-5 h-8 rounded-[4px] border cursor-pointer transition-all duration-150 ${
                              c.slug === color.slug
                                ? "relative z-10 border-bg ring-2 ring-accent ring-offset-1 ring-offset-bg shadow-[0_0_8px_2px_rgba(8,40,112,0.45)] scale-110"
                                : "border-black/10 hover:border-fg"
                            }`}
                            style={{ backgroundColor: c.hex }}
                          />
                        ))}
                      </div>
                      <p className="mt-2 text-[0.625rem] text-dim leading-snug">
                        Tap swatches to try them on the garment.
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {armed ? (
                <div className="absolute inset-x-0 top-11 flex justify-center pointer-events-none">
                  <span className="bg-fg text-bg text-[0.75rem] px-3 py-1.5">
                    Tap the garment to place it
                  </span>
                </div>
              ) : null}
              {notice ? (
                <div className="absolute inset-x-0 bottom-3 flex justify-center pointer-events-none">
                  <span className="bg-fg text-bg text-[0.75rem] px-3 py-1.5">{notice}</span>
                </div>
              ) : null}

              {/* zoom in / out on the garment */}
              <div className="absolute right-2 bottom-2 flex gap-1.5">
                {zoom > 1 ? (
                  <button
                    type="button"
                    aria-label="Reset zoom"
                    onClick={resetZoom}
                    className="h-9 px-2.5 border border-hairline bg-bg/90 text-mid text-[0.6875rem] uppercase tracking-[0.04em] hover:border-fg cursor-pointer"
                  >
                    Fit
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label="Zoom out"
                  disabled={zoom <= 1}
                  onClick={() => zoomBy(-0.5)}
                  className="w-9 h-9 border border-hairline bg-bg/90 text-fg text-[1rem] disabled:opacity-35 hover:border-fg cursor-pointer"
                >
                  −
                </button>
                <button
                  type="button"
                  aria-label="Zoom in"
                  disabled={zoom >= MAX_ZOOM}
                  onClick={() => zoomBy(0.5)}
                  className="w-9 h-9 border border-hairline bg-bg/90 text-fg text-[1rem] disabled:opacity-35 hover:border-fg cursor-pointer"
                >
                  +
                </button>
              </div>

              {/* undo / redo - big enough to be a landmark, not furniture */}
              <div className="absolute left-2 bottom-2 flex gap-2">
                <button
                  type="button"
                  aria-label="Undo"
                  title="Undo (⌘Z)"
                  disabled={!histRef.current.past.length}
                  onClick={undo}
                  className="w-12 h-12 border border-hairline bg-bg/90 text-fg text-[1.375rem] disabled:opacity-35 hover:border-fg cursor-pointer"
                >
                  ↺
                </button>
                <button
                  type="button"
                  aria-label="Redo"
                  title="Redo (⇧⌘Z)"
                  disabled={!histRef.current.future.length}
                  onClick={redo}
                  className="w-12 h-12 border border-hairline bg-bg/90 text-fg text-[1.375rem] disabled:opacity-35 hover:border-fg cursor-pointer"
                >
                  ↻
                </button>
              </div>

              {/* first-time editing hint - a real, dismissible popup */}
              {canvasHint && placements.length > 0 ? (
                <div className="absolute left-2 bottom-16 z-10 w-[19rem] border border-fg bg-bg shadow-lg p-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <strong className="text-[0.875rem] font-medium leading-snug">
                      Editing your design
                    </strong>
                    <button
                      type="button"
                      aria-label="Dismiss this hint"
                      onClick={dismissCanvasHint}
                      className="text-mid hover:text-fg cursor-pointer text-[1rem] leading-none -mt-0.5"
                    >
                      ×
                    </button>
                  </div>
                  <ul className="mt-2 flex flex-col gap-1 text-[0.8125rem] text-mid leading-[1.5]">
                    <li>Click a design to select it - its controls open on the right.</li>
                    <li>Drag to move. Drag a corner to resize.</li>
                    <li>Arrow keys nudge. Delete removes.</li>
                    <li>The ↺ button (or ⌘Z) undoes anything.</li>
                  </ul>
                  <button
                    type="button"
                    onClick={dismissCanvasHint}
                    className="mt-3 w-full px-4 py-2 bg-fg text-bg text-[0.75rem] tracking-[0.06em] uppercase hover:opacity-85 cursor-pointer"
                  >
                    Got it
                  </button>
                </div>
              ) : null}

              {/* layers - placed-design chips, right gutter. TOP chip = on
                  top of the stack; arrows move the selected design up/down */}
              {viewPlacements.length ? (
                <div className={`absolute top-1/2 -translate-y-1/2 flex flex-col items-center gap-1.5 ${sel ? "right-[20.5rem]" : "right-2"}`}>
                  {viewPlacements.length > 1 ? (
                    <button
                      type="button"
                      aria-label="Move the selected design up a layer (on top)"
                      title="Move the selected design up - on top of the design above it"
                      disabled={!sel}
                      onClick={() => reorderSelected(1)}
                      className="w-10 h-8 border border-hairline bg-bg/90 text-fg text-[0.9375rem] disabled:opacity-35 hover:border-fg cursor-pointer"
                    >
                      ↑
                    </button>
                  ) : null}
                  <div className="flex flex-col gap-1.5 max-h-[16rem] overflow-y-auto p-1.5 -m-1.5">
                    {[...viewPlacements].reverse().map((p) => {
                      const u = uploadById.get(p.uploadId);
                      return u ? (
                        <div key={p.id} className="relative shrink-0">
                          <button
                            type="button"
                            aria-label={`Select ${u.name}`}
                            title={u.name}
                            onClick={() => setSelected(p.id)}
                            className={`w-10 h-10 bg-bg/90 border p-1 cursor-pointer ${
                              selected === p.id
                                ? "border-fg ring-1 ring-fg"
                                : "border-hairline hover:border-fg"
                            }`}
                          >
                            <img
                              src={renderUrls[p.id] ?? u.url}
                              alt=""
                              className="w-full h-full object-contain"
                            />
                          </button>
                          {selected === p.id ? (
                            <button
                              type="button"
                              aria-label={`Remove ${u.name}`}
                              title="Remove from garment"
                              onClick={(e) => {
                                e.stopPropagation();
                                remove(p.id);
                              }}
                              className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-fg text-bg text-[0.6875rem] leading-none cursor-pointer"
                            >
                              ×
                            </button>
                          ) : null}
                        </div>
                      ) : null;
                    })}
                  </div>
                  {viewPlacements.length > 1 ? (
                    <button
                      type="button"
                      aria-label="Move the selected design down a layer (behind)"
                      title="Move the selected design down - behind the design below it"
                      disabled={!sel}
                      onClick={() => reorderSelected(-1)}
                      className="w-10 h-8 border border-hairline bg-bg/90 text-fg text-[0.9375rem] disabled:opacity-35 hover:border-fg cursor-pointer"
                    >
                      ↓
                    </button>
                  ) : null}
                  <button
                    type="button"
                    aria-label="Add a design"
                    title="Add a design"
                    onClick={() => {
                      setSelected(null);
                      setActivePanel("designs");
                    }}
                    className="w-10 h-10 shrink-0 border border-hairline bg-bg/90 text-mid text-[1rem] leading-none hover:border-fg cursor-pointer"
                  >
                    +
                  </button>
                </div>
              ) : null}

              {/* first time designs stack: explain the layer strip */}
              {layersHint && viewPlacements.length > 1 ? (
                <div className="absolute right-16 top-1/2 -translate-y-1/2 z-10 w-[17rem] border border-fg bg-bg shadow-lg p-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <strong className="text-[0.875rem] font-medium leading-snug">
                      Layers
                    </strong>
                    <button
                      type="button"
                      aria-label="Dismiss the layers hint"
                      onClick={dismissLayersHint}
                      className="text-mid hover:text-fg cursor-pointer text-[1rem] leading-none -mt-0.5"
                    >
                      ×
                    </button>
                  </div>
                  <p className="mt-2 text-[0.8125rem] text-mid leading-[1.55]">
                    These chips are your designs, stacked the way they sit on the
                    garment - the top chip is on top. Select a design, then use the
                    ↑ and ↓ arrows to move it above or below another design.
                  </p>
                  <button
                    type="button"
                    onClick={dismissLayersHint}
                    className="mt-3 w-full px-4 py-2 bg-fg text-bg text-[0.75rem] tracking-[0.06em] uppercase hover:opacity-85 cursor-pointer"
                  >
                    Got it
                  </button>
                </div>
              ) : null}
            </div>

            {onboardBanner ? <div className="shrink-0 px-3 py-2 border-t border-hairline">{onboardBanner}</div> : null}
            {continueBanner ? <div className="shrink-0 px-3 py-2 border-t border-hairline">{continueBanner}</div> : null}
            {placements.length && canvasHint ? (
              <p className="shrink-0 px-3 py-2 text-[0.875rem] text-mid border-t border-hairline">
                Click a design to edit it - arrow keys nudge, ⌘Z undoes, Delete
                removes.
              </p>
            ) : null}
          </section>

          {/* sidebar - the active tool's panel, scrolling internally */}
          <aside className="w-[380px] shrink-0 border-l border-hairline bg-bg overflow-y-auto overscroll-contain">
            <div className="p-3 flex flex-col gap-3">
            {/* tool cards - pick a tool, its panel opens below */}
            {(() => {
              const cards: {
                id: "blanks" | "designs" | "shapes" | "generators" | "text" | "artlib" | "save";
                title: string;
                summary: React.ReactNode;
              }[] = [
                {
                  id: "blanks",
                  title: "Blanks",
                  summary: (
                    <span className="flex items-center gap-1.5 min-w-0">
                      <img
                        src={color.front}
                        alt=""
                        className="w-4 h-4 object-cover shrink-0 bg-card"
                      />
                      <span className="truncate">
                        {garment.label} · {color.name}
                      </span>
                    </span>
                  ),
                },
                {
                  id: "designs",
                  title: "Designs",
                  summary: uploads.length
                    ? `${uploads.length} loaded${armed ? " · one selected" : ""}`
                    : "upload artwork",
                },
                ...(presetsVisible ? [{
                  id: "shapes" as const,
                  title: "Studio designs",
                  summary: `${SHAPES_AVAILABLE.length} to browse`,
                }] : []),
                {
                  id: "generators",
                  title: "Shapes",
                  summary: "new one each roll",
                },
                {
                  id: "text",
                  title: "Text",
                  summary: "straight, arched, waved",
                },
                {
                  id: "artlib",
                  title: "Find art",
                  summary: "public-domain & openly licensed",
                },
              ];
              const current = activePanel ?? "blanks";
              const card = cards.find((t) => t.id === current) ?? cards[0];
              return (
                <div className="flex flex-col gap-3">
                  <div className="flex items-baseline justify-between gap-2 border-b border-hairline pb-2">
                    <h3 className="font-serif text-[1.0625rem] text-fg leading-none">{card.title}</h3>
                    <span className="text-[0.6875rem] text-dim truncate max-w-[13rem]">{card.summary}</span>
                  </div>
                  <div className="flex flex-col gap-3">{panelBody[current]}</div>
                </div>
              );
            })()}
            </div>
          </aside>

        </main>
        )
      ) : tab === "costs" ? (
        /* ── cost estimator - its own tab; estimates, never quotes ── */
        <main className="max-w-site mx-auto px-pad py-[clamp(1.5rem,4vw,2.5rem)] flex flex-col gap-5">
          <div>
            <h2 className="font-serif text-[1.5rem] leading-none">Cost estimator</h2>
            <p className="mt-2 text-[0.8125rem] text-mid leading-[1.6] max-w-[38rem]">
              Rough numbers to plan and learn with -{" "}
              <strong className="text-fg font-medium">every figure is an estimate, not a quote.</strong>{" "}
              Pick a blank and method below, or start from one of your saved pieces.
            </p>
          </div>
          {ideas.length ? (
            <div className="flex flex-col gap-1.5">
              <span className={LABEL}>Start from a saved piece</span>
              <div className="flex items-center gap-2 overflow-x-auto pb-1.5">
                {ideas.map((idea) => (
                  <button
                    key={idea.id}
                    type="button"
                    title={`Estimate ${idea.name}`}
                    onClick={() => {
                      setCostGarmentId(idea.garmentId);
                      setCostQty(Math.max(1, idea.qty));
                      setCostIdeaId(idea.id);
                    }}
                    className={`shrink-0 flex items-center gap-2 border px-1.5 py-1 cursor-pointer ${
                      costIdeaId === idea.id
                        ? "border-fg ring-1 ring-fg"
                        : "border-hairline hover:border-fg"
                    }`}
                  >
                    <img src={idea.thumb} alt="" className="w-9 h-9 object-cover bg-card" />
                    <span className="text-left pr-1">
                      <span className="block text-[0.75rem] leading-tight max-w-[9rem] truncate">
                        {idea.name}
                      </span>
                      <span className="block text-[0.625rem] text-mid leading-tight">
                        {idea.qty}× {garmentById(idea.garmentId)?.label ?? ""}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-[0.8125rem] text-mid">
              Save a piece in the studio and it&rsquo;ll appear here to estimate.
            </p>
          )}
          {costExplorer}
        </main>
      ) : tab === "toolbox" && policy.toolbox ? (
        <LabToolbox />
      ) : tab === "overview" ? (
        /* ── admin overview: every signup, staff grants ── */
        <main className="max-w-site mx-auto px-pad py-[clamp(1.5rem,4vw,2.5rem)] flex flex-col gap-4">
          <div>
            <h2 className={LABEL}>
              Lab accounts{overviewUsers ? ` - ${overviewUsers.length}` : ""}
            </h2>
            <p className="mt-1.5 text-[0.8125rem] text-mid leading-[1.6] max-w-[38rem]">
              Everyone who has signed in to the Lab. Staff accounts get queuing
              and the per-brand cost plan inside Saved ideas; everyone else has
              plain saved ideas. New signups also land in the studio inbox.
            </p>
          </div>
          {overviewError ? (
            <p className="text-[0.875rem] text-mid">{overviewError}</p>
          ) : overviewUsers === null ? (
            <p className="text-[0.875rem] text-mid">Loading accounts…</p>
          ) : overviewUsers.length === 0 ? (
            <p className="text-[0.875rem] text-mid">
              No accounts yet - they&rsquo;ll appear here as people sign in.
            </p>
          ) : (
            <div className="flex flex-col border border-hairline bg-card divide-y divide-hairline">
              {overviewUsers.map((u) => (
                <div
                  key={u.email}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5 text-[0.8125rem]"
                >
                  <span className="truncate">{u.email}</span>
                  {u.admin ? (
                    <span className="text-[0.625rem] tracking-[0.06em] uppercase bg-fg text-bg px-1.5 py-0.5">
                      admin
                    </span>
                  ) : u.staff ? (
                    <span className="text-[0.625rem] tracking-[0.06em] uppercase border border-fg px-1.5 py-0.5">
                      staff
                    </span>
                  ) : null}
                  <span className="ml-auto text-[0.6875rem] text-dim">
                    joined{" "}
                    {new Date(u.created).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </span>
                  <button
                    type="button"
                    onClick={() => void viewWork(u.email)}
                    className="border border-hairline px-2.5 py-1 text-[0.75rem] text-mid hover:border-fg cursor-pointer"
                  >
                    View work
                  </button>
                  {!u.admin ? (
                    <button
                      type="button"
                      onClick={() => setStaffFor(u.email, !u.staff)}
                      className="border border-hairline px-2.5 py-1 text-[0.75rem] text-mid hover:border-fg cursor-pointer"
                    >
                      {u.staff ? "Remove staff" : "Make staff"}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
          {workView && (
            <section className="border border-fg bg-bg p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-[0.875rem]">
                  <span className="text-mid">Saved work - </span>{workView.email}
                  <span className="text-mid"> · {workView.ideas.length} idea{workView.ideas.length === 1 ? "" : "s"}
                    {workView.stitchlabCount ? ` · ${workView.stitchlabCount} stitch designs` : ""}</span>
                </h3>
                <button type="button" onClick={() => setWorkView(null)}
                  className="text-mid underline underline-offset-2 hover:text-fg cursor-pointer text-[0.8125rem]">Close</button>
              </div>
              {workView.ideas.length === 0 ? (
                <p className="mt-3 text-[0.8125rem] text-mid">Nothing saved yet.</p>
              ) : (
                <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2.5">
                  {workView.ideas.map((idea) => (
                    <figure key={idea.id} className="border border-hairline bg-card p-1.5">
                      {idea.thumb ? (
                        <img src={idea.thumb} alt={idea.name} className="w-full aspect-square object-contain" />
                      ) : (
                        <div className="w-full aspect-square flex items-center justify-center text-[0.6875rem] text-dim">no preview</div>
                      )}
                      <figcaption className="mt-1 text-[0.6875rem] leading-snug truncate">{idea.name || "Untitled"}</figcaption>
                    </figure>
                  ))}
                </div>
              )}
            </section>
          )}

          <section className="border border-hairline bg-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className={LABEL}>Image library sources</h2>
              <button
                type="button"
                disabled={srcBusy}
                onClick={() => void runLibrarySync()}
                className="border border-fg px-2.5 py-1 text-[0.75rem] tracking-[0.04em] uppercase hover:bg-fg hover:text-bg transition-colors disabled:opacity-40 cursor-pointer"
              >
                {srcBusy ? "Working…" : "Sync now"}
              </button>
            </div>
            <p className="mt-1.5 text-[0.75rem] text-mid leading-[1.6] max-w-[40rem]">
              Only albums listed AND enabled here appear in the youth library.
              Curate the album contents on Flickr; the library refreshes itself
              twice a day, or immediately with Sync now.
              {!srcConfigured ? " FLICKR_API_KEY isn't set in Vercel yet - sync won't run until it is." : ""}
            </p>
            {syncReport ? (
              <p className="mt-2 text-[0.75rem] leading-[1.6] border-l-2 border-fg pl-2.5">{syncReport}</p>
            ) : null}
            {srcCfg === null ? (
              <p className="mt-3 text-[0.8125rem] text-mid">Loading…</p>
            ) : (
              <div className="mt-3 flex flex-col gap-1.5">
                {srcCfg.length === 0 ? (
                  <p className="text-[0.8125rem] text-mid">No sources yet - add your first album below.</p>
                ) : (
                  srcCfg.map((src, i) => (
                    <div key={src.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border border-hairline bg-bg px-2.5 py-2 text-[0.8125rem]">
                      <strong className="font-medium">{src.title}</strong>
                      <span className="text-mid">{src.category}</span>
                      <span className="text-dim text-[0.6875rem]">{src.type} {src.id}{src.ownContent ? " · ours" : ""}</span>
                      {src.tags?.length ? (
                        <span className="text-dim text-[0.6875rem]">tags: {src.tags.join(", ")}</span>
                      ) : null}
                      <span className="ml-auto flex items-center gap-2">
                        <button
                          type="button"
                          disabled={srcBusy}
                          onClick={() =>
                            void saveSources(srcCfg.map((x, j) => (j === i ? { ...x, enabled: !x.enabled } : x)))
                          }
                          className={`border px-2 py-1 text-[0.6875rem] uppercase tracking-[0.04em] cursor-pointer ${
                            src.enabled ? "border-fg bg-fg text-bg" : "border-hairline text-mid"
                          }`}
                        >
                          {src.enabled ? "Enabled" : "Disabled"}
                        </button>
                        <button
                          type="button"
                          disabled={srcBusy}
                          onClick={() => {
                            if (confirm(`Remove "${src.title}" from the library?`))
                              void saveSources(srcCfg.filter((_, j) => j !== i));
                          }}
                          className="text-mid hover:text-fg text-[0.75rem] cursor-pointer"
                        >
                          Remove
                        </button>
                      </span>
                    </div>
                  ))
                )}
                <div className="mt-2 grid gap-2 sm:grid-cols-2 border-t border-hairline pt-3">
                  <input value={newSrc.id} onChange={(e) => setNewSrc({ ...newSrc, id: e.target.value })} placeholder="Album (photoset) ID - from the album URL" aria-label="Flickr album ID" className={FIELD} />
                  <input value={newSrc.ownerId} onChange={(e) => setNewSrc({ ...newSrc, ownerId: e.target.value })} placeholder="Owner NSID (e.g. 12345678@N00)" aria-label="Owner ID" className={FIELD} />
                  <input value={newSrc.title} onChange={(e) => setNewSrc({ ...newSrc, title: e.target.value })} placeholder="Title shown in our UI" aria-label="Display title" className={FIELD} />
                  <input value={newSrc.category} onChange={(e) => setNewSrc({ ...newSrc, category: e.target.value })} placeholder="Category chip (e.g. Cars & Lowriders)" aria-label="Category" className={FIELD} />
                  <input value={newSrc.tags} onChange={(e) => setNewSrc({ ...newSrc, tags: e.target.value })} placeholder="Curator tags, comma-separated" aria-label="Curator tags" className={FIELD} />
                  <div className="flex items-center gap-3">
                    <select value={newSrc.type} onChange={(e) => setNewSrc({ ...newSrc, type: e.target.value })} aria-label="Source type" className={FIELD}>
                      <option value="album">Album</option>
                      <option value="gallery">Gallery</option>
                    </select>
                    <label className="flex items-center gap-1.5 text-[0.75rem] text-mid whitespace-nowrap cursor-pointer">
                      <input type="checkbox" checked={newSrc.ownContent} onChange={(e) => setNewSrc({ ...newSrc, ownContent: e.target.checked })} className="accent-fg" />
                      our own images
                    </label>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={srcBusy || newSrc.id.trim().length < 4 || !newSrc.title.trim()}
                  onClick={() => {
                    void saveSources([
                      ...srcCfg,
                      {
                        id: newSrc.id.trim(),
                        type: newSrc.type === "gallery" ? "gallery" : "album",
                        title: newSrc.title.trim(),
                        category: newSrc.category.trim() || "Library",
                        enabled: true,
                        ownerId: newSrc.ownerId.trim() || undefined,
                        tags: newSrc.tags.split(",").map((t) => t.trim()).filter(Boolean),
                        ownContent: newSrc.ownContent || undefined,
                      },
                    ]);
                    setNewSrc({ id: "", ownerId: "", title: "", category: "", tags: "", type: "album", ownContent: false });
                  }}
                  className="self-start border border-fg px-3 py-2 text-[0.75rem] tracking-[0.06em] uppercase hover:bg-fg hover:text-bg transition-colors disabled:opacity-40 cursor-pointer"
                >
                  + Add source
                </button>
              </div>
            )}
          </section>
        </main>
      ) : (
        /* ── pipeline ── */
        <main className="max-w-site mx-auto px-pad py-[clamp(1.5rem,4vw,2.5rem)] flex flex-col gap-8">
          {role.staff && queued.length ? (
            <section className="border border-hairline bg-card p-4">
              <h2 className={LABEL}>
                Order plan - {queued.length} queued idea{queued.length === 1 ? "" : "s"}
              </h2>
              <div className="mt-3 flex flex-col gap-4">
                {[...orderPlan.entries()].map(([brand, b]) => {
                  const lines = [...b.lines.values()];
                  const orderable = lines.some((l) => l.garment.orderable);
                  const blanksTotal = lines
                    .filter((l) => l.garment.orderable)
                    .reduce((s, l) => s + l.qty * l.cost, 0);
                  return (
                    <div key={brand}>
                      <h3 className="text-[0.9375rem] font-medium">{brand}</h3>
                      <ul className="mt-1.5 flex flex-col gap-1 text-[0.875rem] text-mid">
                        {lines.map((l) => (
                          <li
                            key={`${l.garment.id}-${l.variant ?? "base"}`}
                            className="flex items-center gap-2 flex-wrap"
                          >
                            <span>
                              {l.qty}× {l.garment.label}
                              {l.variant ? ` (${l.variant})` : ""}
                            </span>
                            {l.garment.orderable ? (
                              <>
                                <label className="flex items-center gap-1">
                                  <span className="text-dim">$</span>
                                  <input
                                    type="number"
                                    min={0}
                                    value={l.cost}
                                    onChange={(e) =>
                                      l.ideas.forEach((i) =>
                                        setCost(i, Number(e.target.value) || 0)
                                      )
                                    }
                                    aria-label={`Cost each for ${l.garment.label}`}
                                    className="w-16 bg-bg border border-hairline px-1.5 py-0.5 text-fg outline-none focus:border-fg"
                                  />
                                  <span className="text-dim">each</span>
                                </label>
                                <span className="ml-auto">${(l.qty * l.cost).toFixed(0)}</span>
                              </>
                            ) : (
                              <span className="ml-auto text-dim">
                                visualization only - no pricing
                              </span>
                            )}
                          </li>
                        ))}
                        {orderable ? (
                          <>
                            <li className="flex justify-between text-dim text-[0.8125rem]">
                              <span>+ shipping (rough)</span>
                              <span>$15</span>
                            </li>
                            <li className="flex justify-between border-t border-hairline pt-1 text-fg">
                              <span>{brand} order</span>
                              <span>${(blanksTotal + 15).toFixed(0)}</span>
                            </li>
                          </>
                        ) : null}
                      </ul>
                    </div>
                  );
                })}
                <p className="text-[0.75rem] text-dim">
                  Planning numbers only - edit the per-blank costs inline. Shipping
                  is a flat $15 guess per brand order.
                </p>
              </div>
            </section>
          ) : null}

          <section>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className={LABEL}>Ideas</h2>
              <button
                type="button"
                onClick={() => {
                  setTab("studio");
                  startNewFlow();
                }}
                className="border border-fg px-2.5 py-1 text-[0.75rem] tracking-[0.04em] uppercase hover:bg-fg hover:text-bg transition-colors cursor-pointer"
              >
                + New design
              </button>
              <button
                type="button"
                onClick={() => setPipelineFilter(null)}
                className={`border px-2.5 py-1 text-[0.75rem] cursor-pointer ${
                  pipelineFilter === null
                    ? "border-fg bg-fg text-bg"
                    : "border-hairline text-mid hover:border-fg"
                }`}
              >
                All
              </button>
              {collections.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setPipelineFilter(pipelineFilter === c ? null : c)}
                  className={`border px-2.5 py-1 text-[0.75rem] cursor-pointer ${
                    pipelineFilter === c
                      ? "border-fg bg-fg text-bg"
                      : "border-hairline text-mid hover:border-fg"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
            {shownIdeas.length === 0 ? (
              <p className="mt-6 text-[0.9375rem] text-mid">
                Nothing saved yet - build something in the Studio and hit
                &ldquo;Save idea.&rdquo;
              </p>
            ) : (
              <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {shownIdeas.map((idea) => (
                  <div key={idea.id} className="border border-hairline bg-card flex flex-col">
                    <button
                      type="button"
                      onClick={() => loadIdea(idea)}
                      title="Open in Studio"
                      className="cursor-pointer"
                    >
                      <img
                        src={idea.thumb}
                        alt={idea.name}
                        className="block w-full aspect-square object-cover"
                      />
                    </button>
                    <div className="px-2.5 py-2 flex flex-col gap-1 grow">
                      <div className="flex items-center gap-1.5">
                        <input
                          defaultValue={idea.name}
                          aria-label={`Rename ${idea.name}`}
                          title="Click to rename"
                          onBlur={(e) => {
                            const name = e.target.value.trim();
                            if (name && name !== idea.name) {
                              void putIdea({ ...idea, name, updatedAt: Date.now() }).then(() => {
                                void refreshIdeas();
                                scheduleSync();
                              });
                            } else {
                              e.target.value = idea.name;
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          }}
                          className="min-w-0 flex-1 bg-transparent text-[0.8125rem] leading-snug truncate outline-none border-b border-transparent focus:border-fg"
                        />
                        {role.staff && idea.status === "queued" ? (
                          <span className="ml-auto shrink-0 bg-fg text-bg text-[0.625rem] tracking-[0.06em] uppercase px-1.5 py-0.5">
                            Queued
                          </span>
                        ) : null}
                      </div>
                      <span className="text-[0.6875rem] text-mid">
                        {idea.qty}× {garmentById(idea.garmentId)?.label ?? idea.garmentId}
                        {idea.collection ? ` · ${idea.collection}` : ""}
                      </span>
                      {idea.threads.length ? (
                        <span className="flex gap-1">
                          {idea.threads.slice(0, 6).map((t, i) => (
                            <span
                              key={i}
                              title={`${t.code} ${t.name}`}
                              className="w-3 h-3 rounded-full border border-hairline"
                              style={{ backgroundColor: t.hex }}
                            />
                          ))}
                        </span>
                      ) : null}
                      {idea.nextNote ? (
                        <span className="text-[0.6875rem] text-mid italic leading-snug">
                          Next: {idea.nextNote}
                        </span>
                      ) : null}
                      <div className="mt-auto pt-1.5 flex gap-2 text-[0.75rem]">
                        {role.staff ? (
                          <button
                            type="button"
                            onClick={() =>
                              setStatus(idea, idea.status === "queued" ? "idea" : "queued")
                            }
                            className="text-mid underline underline-offset-2 hover:text-fg cursor-pointer"
                          >
                            {idea.status === "queued" ? "Unqueue" : "Queue"}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => loadIdea(idea)}
                          className="text-mid underline underline-offset-2 hover:text-fg cursor-pointer"
                        >
                          Open
                        </button>
                        <button
                          type="button"
                          onClick={() => void duplicateIdea(idea)}
                          className="text-mid underline underline-offset-2 hover:text-fg cursor-pointer"
                        >
                          Duplicate
                        </button>
                        {role.staff ? (
                          <button
                            type="button"
                            title="Open the cost estimator for this piece"
                            onClick={() => {
                              setCostGarmentId(idea.garmentId);
                              setCostQty(Math.max(1, idea.qty));
                              setCostIdeaId(idea.id);
                              setTab("costs");
                            }}
                            className="text-mid underline underline-offset-2 hover:text-fg cursor-pointer"
                          >
                            Costs
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => removeIdea(idea)}
                          className="ml-auto text-mid hover:text-fg cursor-pointer"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-4 text-[0.75rem] text-dim">
              {authToken
                ? `Synced to ${authEmail}.`
                : "Ideas are stored in this browser - sign in to sync across devices."}
            </p>
          </section>
        </main>
      )}
    </div>
  );
}
