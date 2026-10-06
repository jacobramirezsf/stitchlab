// Experimental tools registry + host. Each tool is its own lazy chunk and its
// own hash route (#tools/<slug>) so it's linkable and the code stays modular.
// Every tool ends in a real, stitchable .DST download.

import { lazy, Suspense, useState, type ComponentType, type LazyExoticComponent } from "react";
import { EYEBROW } from "./shared";

const STATUS_LABEL: Record<string, string> = {
  candidate: "Candidate",
  "digitally-validated": "Digitally validated",
  "ready-for-stitch-testing": "Ready for stitch testing",
  "stitch-proven": "Stitch-proven",
};

/** Tool-page intro: plain description + an optional "About the method" toggle. */
export function ToolIntro({ tool }: { tool: ToolDef }) {
  const [showAbout, setShowAbout] = useState(false);
  return (
    <div className="max-w-[70ch] space-y-1.5">
      <p className="text-[0.875rem] text-mid leading-relaxed">{tool.blurb}</p>
      {tool.about && (
        <div>
          <button onClick={() => setShowAbout((v) => !v)} className="text-[0.6875rem] text-mid hover:text-accent">
            {showAbout ? "Hide the method ▴" : "About the method ▾"}
          </button>
          {showAbout && <p className="mt-1 text-[0.75rem] text-mid leading-relaxed border-l-2 border-hairline pl-3">{tool.about}</p>}
        </div>
      )}
    </div>
  );
}

/** Gallery card: plain "what you can make" copy, with the technical method
 *  tucked behind an optional toggle for those who want it. */
function ToolCard({ t, onNavigate }: { t: ToolDef; onNavigate: (slug: string) => void }) {
  const [showAbout, setShowAbout] = useState(false);
  return (
    <div className="border border-hairline bg-card hover:border-fg transition-colors flex flex-col">
      <button onClick={() => onNavigate(t.slug)} className="text-left px-4 pt-4 pb-3 group">
        <div className="flex items-center justify-between gap-2">
          <div className={EYEBROW}>/ {t.slug} /</div>
          {t.status && (
            <span className="text-[0.5625rem] tracking-[0.1em] uppercase text-mid border border-hairline px-1.5 py-0.5">{STATUS_LABEL[t.status]}</span>
          )}
        </div>
        <div className="mt-1 font-serif text-[1.25rem] text-fg group-hover:underline">{t.name}</div>
        <div className="mt-0.5 text-[0.8125rem] text-fg">{t.tagline}</div>
        <p className="mt-2 text-[0.75rem] text-mid leading-relaxed">{t.blurb}</p>
      </button>
      {t.about && (
        <div className="px-4 pb-3 mt-auto">
          <button onClick={() => setShowAbout((v) => !v)} className="text-[0.6875rem] text-mid hover:text-accent">
            {showAbout ? "Hide the method ▴" : "About the method ▾"}
          </button>
          {showAbout && <p className="mt-1.5 text-[0.6875rem] text-mid leading-relaxed border-t border-hairline pt-2">{t.about}</p>}
        </div>
      )}
    </div>
  );
}

export type ToolDef = {
  slug: string;
  name: string;
  /** Plain-language one-liner: what you can make with it. */
  tagline: string;
  /** Plain-language description - what it produces, for anyone. */
  blurb: string;
  /** Optional deeper "how it works" - the method, math, and sources. Surfaced
   *  behind an "About the method" toggle for those who want it, never required
   *  reading to understand what the tool makes. */
  about?: string;
  component: LazyExoticComponent<ComponentType>;
  /** Editor-style tools that want the wider page container. */
  wide?: boolean;
  /** App-shell tools that own the whole viewport below the header: no title
   *  block, no footer, no page scroll - the tool fills and manages its box. */
  fullscreen?: boolean;
  /**
   * Collection. "nextgen" = the focused, stitch-oriented flagship collection
   * developed to a higher standard. Undefined = the Experiments collection
   * (the broad existing suite - never demoted or hidden). "utility" = Library.
   */
  collection?: "nextgen" | "utility";
  /** Staff bench only: hidden from public listings and the direct link is gated. */
  staffOnly?: boolean;
  /**
   * Next Gen maturity - honest about physical proof. Never claim stitch-proven
   * until fabric testing has happened.
   */
  status?: "candidate" | "digitally-validated" | "ready-for-stitch-testing" | "stitch-proven";
};

// Tools that produce moving output - they live on their own /animation page.
export const ANIMATION_SLUGS = [
  "animdots", "animstipple", "animblobs", "animglyphs", "animriso",
  "animtrails", "animstrings", "animshatter", "animcontours", "animcutout",
  "letteranim", "photoreal", "animator", "animate",
];

export const TOOLS: ToolDef[] = [
  {
    slug: "sashikotone",
    name: "Sashiko Tone",
    tagline: "Turn picture shading into patterned running stitches",
    blurb: "A photo or sample becomes a geometric cloth texture. Woven tone uses heavier shadow dashes over a light ground; Open dashes leaves bare fabric between marks. Sew rows and columns in one or two colors.",
    about: "Extends the existing hitomezashi phase-word engine with image-cell averaging and tone screening, following the Sashiko photo direction in Engine Research. Inspired by Hayes and Seaton’s mathematical account of sashiko. This machine translation uses narrow three-pass ribbons or selected dashes; it does not reproduce the reverse of hand-worked sashiko.",
    component: lazy(() => import("./sashikotone")),
    status: "digitally-validated",
  },
  {
    slug: "blackwork",
    name: "Blackwork",
    tagline: "Fill any shape with a repeating geometric pattern",
    blurb:
      "Nine geometric patterns, tiled inside a heart, a letter, or your own outline and clipped to its edge. Add a border if you want one. Like old blackwork, it reads clean on both sides of the fabric.",
    about:
      "The Renaissance monochrome blackwork tradition, made parametric: a geometric lattice motif tiled across any shape (built-in or your SVG), clipped to its edge, and sewn in reversible double-running stitch so it reads clean on the front and the back. Nine motifs, a two-color frame option, and a routing engine that links the whole pattern into a handful of continuous strokes.",
    component: lazy(() => import("./blackwork")),
    collection: "nextgen",
    status: "ready-for-stitch-testing",
  },
  {
    slug: "badge",
    name: "Badge",
    tagline: "Make a round crest or patch with curved text and a center emblem",
    blurb:
      "Your words curve over the top and under the bottom, around a middle emblem (star, heart, crown, anchor, shield, and more) framed by rings. Good for team, club, event, and varsity patches, in one or two colors.",
    about:
      "A parametric crest layout. Top and bottom text sit tangent to a ring and stay upright, fitted into the band between concentric satin borders around a central motif. Serif Bold, Times Bold, Gothic, or Blackletter faces. Letters and borders are sewn as true satin.",
    component: lazy(() => import("./badge")),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "qrcode",
    name: "QR Studio",
    tagline: "Custom QR codes that never expire - shapes, gradients, halftone photos",
    blurb:
      "A QR code generator with real customization: rounded, dotted, or liquid modules, styled eyes, gradients, frames with labels, a center logo - even a photo halftoned into the code itself. The link is baked into the pattern, so it never expires.",
    about:
      "Encodes with the standard QR spec (error correction L-H), then draws every module ourselves so the styling is truly custom - including the classic halftone-QR trick, where module centers carry the data and the surrounding subcells render a dithered photo. Every style ships scan-verified against the same decoding engine phones use. Exports PNG, print-ready 300ppi PNG, and clean SVG.",
    component: lazy(() => import("./qrcode")),
  },
  {
    slug: "halftone",
    name: "Halftone",
    tagline: "A photo as a pattern of wavy lines",
    blurb:
      "The lines ripple where the photo is dark and flatten where it's light, so a face or logo reads as a bold graphic. You set how many lines, how wavy, and which direction they run.",
    about:
      "The single-line halftone (waveform-portrait) technique: parallel scan lines whose wave amplitude is driven by local darkness, breaking off in the highlights so bare fabric shows. Each line is one continuous run, so trims happen only between rows. The preview renders realistic thread width so it predicts the stitch-out.",
    component: lazy(() => import("./halftone")),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "handfont",
    name: "Handwriting",
    staffOnly: true,
    tagline: "Your own handwriting as a stitchable, animatable typeface",
    blurb:
      "Print the grid template, write one character per cell, photograph it, and every letter becomes a stroke glyph - the same skeleton form as the built-in faces. Then type anything: it renders in your hand, sews as running or bean stitch, and exports stitch files, transparent GIFs, and print-resolution PNGs. Faces save in this browser and export as small JSON files.",
    component: lazy(() => import("./handfont")),
  },
  {
    slug: "animdots",
    name: "Halftone Dots",
    tagline: "A photo as angled print screens that build themselves",
    blurb:
      "Real AM-screening: every color gets its own screen angle (15-degree separations, like print), a dot shape - round, square, diamond, or line - and dot gain. Watch the screens assemble, then export GIF, video, or a 300ppi still.",
    about:
      "Classic halftone theory made animate: k-means spot colors each drive a rotated dot lattice sampled from that color's soft coverage. Angles sit 30+ degrees apart so layers don't moire, gain applies a gamma to density, and every dot carries an assembly time.",
    component: lazy(() => import("./animdots")),
  },
  {
    slug: "animstipple",
    name: "Stipple",
    tagline: "Thousands of dots settle into a hand-stippled portrait",
    blurb:
      "The real stippling algorithm (weighted Voronoi, Secord 2002): dots are born at random in the photo's dark areas, then relax step by step into a perfectly even hand-stippled distribution. The settle IS the animation.",
    about:
      "Rejection sampling seeds points by darkness; Lloyd's algorithm then iterates each point toward the darkness-weighted centroid of its Voronoi cell (spatial-hashed for speed). Every relaxation step is kept, so the tool can animate the drift from noise to order.",
    component: lazy(() => import("./animstipple")),
  },
  {
    slug: "animblobs",
    name: "Blobs",
    tagline: "The photo melts together out of soft metaball blobs",
    blurb:
      "Dots grow and fuse into one another per spot color - the melt dial controls how far they merge. Organic, sticker-like shapes that assemble radially, by darkness, or shuffled.",
    about:
      "Metaballs by blur-and-threshold per color layer, computed at a capped working resolution on reused buffers so it stays smooth; the 300ppi still renders at full resolution.",
    component: lazy(() => import("./animblobs")),
  },
  {
    slug: "animglyphs",
    name: "Glyph Weave",
    tagline: "A photo re-typed as marks - or the letters of your own word",
    blurb:
      "The image becomes a woven texture of typographic marks that can follow its edges. Type a word and the photo is literally drawn with your own letters - a name, a brand, an inside joke.",
    about:
      "A darkness ramp picks the glyph per cell (or cycles the letters of your word), a Sobel flow field rotates marks along local edges, and spot colors come from k-means. Everything carries assembly order.",
    component: lazy(() => import("./animglyphs")),
  },
  {
    slug: "animriso",
    name: "Riso Print",
    tagline: "A Risograph that prints your photo one ink pass at a time",
    blurb:
      "Soft ink separations onto the classic riso ink chart - Fluor Pink, Teal, Bright Red and friends - with grain or dot screens, multiply overprint, loose registration, duotone presets, and cream or kraft paper. The animation is the machine printing, pass by pass.",
    about:
      "Per-layer coverage comes from inverse-distance color membership scaled by darkness; each layer maps to a real riso ink (nearest by default, overridable), renders once per resolution, and composites with multiply at ink translucency with per-pass misregistration.",
    component: lazy(() => import("./animriso")),
  },
  {
    slug: "animtrails",
    name: "Flow Trails",
    tagline: "Glowing particle trails trace the photo like a physics event display",
    blurb:
      "Hundreds of particles ride the photo's edge field, leaving dotted neon trails on black - the CERN detector-display look - or clean ink lines on paper. The subject emerges as the trails grow.",
    about:
      "A Sobel flow field (rotated to run along edges) blended with an adjustable swirl, advected with midpoint integration. Trails are polylines with per-point order, staggered so growth feels alive; neon mode composites additively with a glow.",
    component: lazy(() => import("./animtrails")),
  },
  {
    slug: "animstrings",
    name: "String Art",
    tagline: "One continuous thread winds between pins until the picture appears",
    blurb:
      "The real string-art algorithm: pins around a round or square board, and a single thread whose every chord is chosen to darken the picture most. Watch it wind - the sequence is real enough to follow on a physical board.",
    about:
      "The greedy residual method popularized by Petros Vrellis: at each step, score every candidate chord by the remaining darkness it crosses, pick the best, subtract the thread's opacity along it, repeat. Computation runs chunked so the page stays responsive.",
    component: lazy(() => import("./animstrings")),
  },
  {
    slug: "animshatter",
    name: "Shatter",
    tagline: "The photo assembles from flying mosaic shards - or blows apart",
    blurb:
      "Full-color: the photograph itself breaks into Voronoi mosaic pieces that spin into place from the edges, or explode outward. Great for reveals and title cards.",
    about:
      "Voronoi cells by half-plane clipping against nearest neighbors (no geometry library), each clipping the source photo into a shard with its own flight vector, spin, and staggered landing.",
    component: lazy(() => import("./animshatter")),
  },
  {
    slug: "animcontours",
    name: "Contours",
    tagline: "Light and shadow become elevation lines that plot themselves",
    blurb:
      "The photo as a topographic map: luminance sliced into bands, traced into smooth closed contour lines, drawn end to end like a pen plotter - in one ink, the photo's own colors, or neon.",
    about:
      "Marching-squares contours per luminance band (the same tracer behind the Lab's cut files), Douglas-Peucker simplified and Chaikin-smoothed, then drawn progressively by arc length, outer bands first.",
    component: lazy(() => import("./animcontours")),
  },
  {
    slug: "animcutout",
    name: "Cutout",
    tagline: "Cut-paper spot-color layers land in a stack, zine style",
    blurb:
      "The photo posterizes into crisp paper layers with halftone shading, paper grain, and drop shadows - each layer falling into place like cut paper on a zine spread. Cream, white, or kraft stock.",
    about:
      "Hard layer assignment from soft color membership (a cell belongs to the ink that covers it most), coarse halftone shading inside dark regions, soft-light grain, and a staggered drop-in with animated shadows.",
    component: lazy(() => import("./animcutout")),
  },
  {
    slug: "letteranim",
    name: "Animated Lettering",
    tagline: "A word that writes itself out - framed as a finished asset",
    blurb:
      "Type a word in a stroke or satin face (or your own font, filled or outlined) and it stitches itself out in reading order with real timing control: duration, easing, stroke-by-stroke snap, write-on, unstitch, or bounce. Frame it 1:1, 9:16, 4:5, or 16:9 at up to 2160px on transparent or fabric, and export a transparent GIF, video, PNG still, or the same build as a stitch file.",
    component: lazy(() => import("./letteranim")),
  },
  {
    slug: "monogram",
    name: "Monogram",
    tagline: "Stitch one to three initials as a classic monogram",
    blurb:
      "The middle initial sits larger in the traditional three-letter style, with an optional frame: circle, oval, diamond, or double ring. Set in bold, script, Times, or blackletter.",
    about:
      "Initials from a Hershey stroke face rendered as satin columns, ink-centered and group-centered so the mark sits centered in its frame no matter the letter widths. The center initial is enlarged in the three-letter arrangement. Optional satin-band frame in its own thread.",
    component: lazy(() => import("./monogram")),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "blocks2",
    staffOnly: true, // "Make your own" parked as staff-only experimental (Sept 2026)
    name: "Pattern Blocks",
    tagline: "Compose patterns on a hoop: spirals, flowers, mazes, and more",
    blurb:
      "No code. Add generators from a gallery of spirals, flowers, stars, mazes, waves, and dozens more, then move, scale, and rotate each one on the hoop. Every element gets its own thread color, and you pick the hoop size you'll actually stitch in.",
    about:
      "A no-code generative composer. 35 generator blocks share one drawing engine; each block's output is placed on the hoop with its own move, scale, rotation, and thread. The arrangement exports as a single DST that merges shared threads to cut down machine stops.",
    component: lazy(() => import("./blocks2")),
    wide: true,
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "blocks",
    name: "Pattern Blocks (classic)",
    tagline: "Build patterns by stacking blocks, no code needed",
    blurb:
      "Stack blocks, set their numbers with sliders, and change thread colors, no typing. This is the simpler, original version, before the drag-to-arrange canvas.",
    about:
      "The first no-code build, in the spirit of Scratch and Snap: a vertical stack of parameterized generator blocks drawn by the shared engine, grouped by color and exported as one DST. All blocks are centered (no per-block layout).",
    component: lazy(() => import("./blocks")),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "spiral",
    name: "Spiral",
    tagline: "One clean line spiraling out from the center",
    blurb:
      "Set the turns and the radius and it's ready. Works as a coaster-sized accent, a quilting motif, or a base layer under other stitching.",
    about:
      "An Archimedean spiral: radius grows linearly with angle, sampled fine and resampled to your stitch length so the curve stays smooth at machine scale.",
    component: lazy(() => import("./blockmini").then((m) => ({ default: m.SpiralTool }))),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "spirograph",
    name: "Spirograph",
    tagline: "Looping gear patterns, like the classic drawing toy",
    blurb:
      "Two gear sizes and a pen offset make looping wheels that close into one continuous line. Small changes to the gears give completely different wheels.",
    about:
      "A hypotrochoid: a point fixed to a small circle rolling inside a larger one. The curve closes after a number of revolutions set by the gear ratio, so the whole design sews as a single unbroken path.",
    component: lazy(() => import("./blockmini").then((m) => ({ default: m.SpirographTool }))),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "lissajous",
    name: "Lissajous",
    tagline: "A woven loop from two crossing waves",
    blurb:
      "Two frequencies and a phase, and the line weaves a closed figure. Whole-number ratios give tidy knots; nudge the phase to open or close the weave.",
    about:
      "x and y each follow their own sine wave and the figure is their product. Jules Lissajous drew them with mirrors on tuning forks in 1857.",
    component: lazy(() => import("./blockmini").then((m) => ({ default: m.LissajousTool }))),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "superformula",
    name: "Superformula",
    tagline: "One formula that morphs from flower to star to blob",
    blurb:
      "A handful of sliders steer a single equation through flowers, gears, starfish, and shield shapes.",
    about:
      "Johan Gielis's 2003 generalization of the circle equation. The m parameter sets the symmetry and the n exponents pinch or round the corners, which is why one formula covers so many natural-looking outlines.",
    component: lazy(() => import("./blockmini").then((m) => ({ default: m.SuperformulaTool }))),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "butterfly",
    name: "Butterfly Curve",
    tagline: "An organic winged loop from one equation",
    blurb:
      "A single continuous curve that folds into a butterfly. Adjust the loops, pick a thread, and it sews without a single trim.",
    about:
      "Temple Fay's 1989 transcendental plane curve. The radius mixes an exponential of cosine with sharp sine powers, which gives the wings their asymmetric, organic edge.",
    component: lazy(() => import("./blockmini").then((m) => ({ default: m.ButterflyTool }))),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "heart",
    name: "Heart",
    tagline: "A clean single-line heart outline",
    blurb:
      "A heart drawn as one path. Use it alone on a pocket or sleeve placket, or run it bean-stitch for a bolder line.",
    about:
      "A parametric heart curve, sampled evenly and resampled to stitch length so the lobes stay round and the point stays sharp.",
    component: lazy(() => import("./blockmini").then((m) => ({ default: m.HeartTool }))),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "rosette",
    name: "Rosette",
    tagline: "Overlapping circles in a ring, the flower-of-life look",
    blurb:
      "A ring of circles overlapping into petals. Six gives the classic rosette; more gives denser lacework.",
    about:
      "Circles of equal radius spaced around a shared center. Where they intersect they form the vesica petals seen in geometric ornament from Gothic tracery to barn quilts.",
    component: lazy(() => import("./blockmini").then((m) => ({ default: m.RosetteTool }))),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "timestable",
    name: "Times Table",
    tagline: "Cardioids woven from simple multiplication",
    blurb:
      "Chords connect each point on a circle to its multiple, and heart-shaped envelopes appear out of nowhere. Change the multiplier and whole new curves emerge.",
    about:
      "The modular multiplication table on a circle: point i connects to i times k, mod n. The chord envelope traces epicycloids; k of 2 draws the famous cardioid.",
    component: lazy(() => import("./blockmini").then((m) => ({ default: m.TimesTableTool }))),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "fractaltree",
    name: "Fractal Tree",
    tagline: "A branching tree that splits again and again",
    blurb:
      "Trunk, branch angle, shrink factor, and depth. Symmetric settings read as formal; skewed settings read as windswept.",
    about:
      "A recursive binary tree: each branch spawns two shorter branches at the set angle. Drawn depth-first so the machine walks out and back along each limb without trims.",
    component: lazy(() => import("./blockmini").then((m) => ({ default: m.FractalTreeTool }))),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "web",
    name: "Spider Web",
    tagline: "Concentric rings crossed by radial spokes",
    blurb:
      "Rings and spokes make an instant web, dartboard, or mandala scaffold. Handy as a layout guide under freeform stitching too.",
    about:
      "A polar grid: evenly spaced concentric rings plus radial lines from the center, merged into one thread block so it sews in one sitting.",
    component: lazy(() => import("./blockmini").then((m) => ({ default: m.WebTool }))),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "ripples",
    name: "Ripples",
    tagline: "Rings spreading from several centers, like rain on water",
    blurb:
      "A few drop points, each ringed with expanding circles that overlap and interfere. Looks best oversized on a jacket back or quilt block.",
    about:
      "Multiple centers each emit concentric rings; where the ring systems overlap the eye reads interference, the same look as raindrops settling on still water.",
    component: lazy(() => import("./blockmini").then((m) => ({ default: m.RipplesTool }))),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "topo",
    name: "Topographic",
    tagline: "Contour lines of an invisible landscape",
    blurb:
      "Iso-lines traced over smooth noise, like a topo map of terrain that doesn't exist. Roll the variation until the landscape feels right.",
    about:
      "Marching squares over layered value noise: each contour level traces where the field crosses a threshold. The same technique cartographers use, run on synthetic terrain.",
    component: lazy(() => import("./blockmini").then((m) => ({ default: m.TopoTool }))),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "circlepack",
    name: "Circle Packing",
    tagline: "Circles of every size packed until the space is full",
    blurb:
      "Big circles anchor the layout and smaller ones fill the gaps. Every run is different, so roll the variation until the arrangement sits well.",
    about:
      "Greedy stochastic packing: random candidate centers are kept when they clear every placed circle, with radii shrinking as space runs out.",
    component: lazy(() => import("./blockmini").then((m) => ({ default: m.CirclePackTool }))),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "rings",
    name: "Nested Rings",
    tagline: "Circles nested around a single center",
    blurb:
      "Count and gap are the whole interface. A quiet motif that works at any size, and a good first test stitch on a new fabric.",
    about:
      "Concentric circles at even spacing, each a closed path, sewn inside-out so the fabric is pulled evenly as the rings grow.",
    component: lazy(() => import("./blockmini").then((m) => ({ default: m.RingsTool }))),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "polygons",
    name: "Nested Polygons",
    tagline: "Polygons inside polygons, twisting as they shrink",
    blurb:
      "Pick the sides, the count, and a twist per step. Zero twist reads as an architectural frame; a few degrees turns it into a vortex.",
    about:
      "Regular n-gons scaled down step by step, each rotated by the twist angle. The rotation spirals the corners, the whirling-squares construction generalized to any polygon.",
    component: lazy(() => import("./blockmini").then((m) => ({ default: m.PolygonsTool }))),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "squares",
    name: "Nested Squares",
    tagline: "Squares in squares, from frames to diamonds",
    blurb:
      "The four-sided case, tuned for it: count, gap, and rotation. At 45 degrees it becomes diamonds in squares, an old quilt block in thread.",
    about:
      "Concentric squares with optional per-step rotation. Kept separate from Nested Polygons because the square case lands on quilting geometry that deserves its own defaults.",
    component: lazy(() => import("./blockmini").then((m) => ({ default: m.SquaresTool }))),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "polygonring",
    name: "Shape Ring",
    tagline: "Small shapes arranged in a circle",
    blurb:
      "Little polygons standing in a ring, like a wreath of triangles or hexagons. Adjust the count until neighbors just touch.",
    about:
      "Regular polygons placed at even angles around a center radius, each drawn closed, sewn around the ring in order to keep travel short.",
    component: lazy(() => import("./blockmini").then((m) => ({ default: m.PolygonRingTool }))),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "crosshatch",
    name: "Crosshatch",
    tagline: "Ruled lines crossing into a woven texture",
    blurb:
      "Line count for each of two crossing passes. Tight spacing reads as woven cloth; wide reads as graph paper.",
    about:
      "Two families of parallel lines clipped to the frame, drawn snake-wise so travel stitches between rows stay short.",
    component: lazy(() => import("./blockmini").then((m) => ({ default: m.CrosshatchTool }))),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "plaid",
    name: "Plaid",
    tagline: "Wavy crossing lines, a tartan in thread",
    blurb:
      "Horizontal and vertical bands with a touch of wave so it feels like cloth rather than a grid. Run it twice in two threads for a real tartan read.",
    about:
      "Sine-modulated line bands crossing at right angles. The slight amplitude keeps rows from reading as ruled lines and gives the weave its softness.",
    component: lazy(() => import("./blockmini").then((m) => ({ default: m.PlaidTool }))),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "moire",
    name: "Moiré",
    tagline: "Two line grids at a slight angle, shimmering",
    blurb:
      "Overlay two nearly identical grids and interference bands appear that neither grid contains. Small angle changes move the shimmer a lot.",
    about:
      "The moiré effect: two periodic patterns at a small relative angle produce beat frequencies far larger than either grid. Printers fight it; here it's the point.",
    component: lazy(() => import("./blockmini").then((m) => ({ default: m.MoireTool }))),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "honeycomb",
    name: "Honeycomb",
    tagline: "A clean tessellating field of hexagons",
    blurb:
      "Cell size sets the scale and the grid fills whatever design size you choose. A steady all-over texture that pairs well with a motif stitched on top.",
    about:
      "A hex tiling drawn edge by edge with shared walls deduplicated, so no wall sews twice and the whole field runs with minimal travel.",
    component: lazy(() => import("./blockmini").then((m) => ({ default: m.HoneycombTool }))),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "waves",
    name: "Wave Rows",
    tagline: "Stacked sine waves, ribbons of water",
    blurb:
      "Rows, amplitude, and frequency. Flatten it toward calm water or crank it into ribbon candy.",
    about:
      "Stacked sine curves resampled to even stitch length. Alternating rows sew in opposite directions so the machine never makes a long jump back.",
    component: lazy(() => import("./blockmini").then((m) => ({ default: m.WavesTool }))),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "dotgrid",
    name: "Circle Grid",
    tagline: "A repeating grid of small circles",
    blurb:
      "Columns, rows, and circle size, with an optional extra ring per dot. Polka dots at small sizes, portholes at large.",
    about:
      "Circles on a rectangular lattice, each closed and sewn in serpentine order across the grid to keep the connecting runs short.",
    component: lazy(() => import("./blockmini").then((m) => ({ default: m.DotGridTool }))),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "workspace",
    staffOnly: true, // "Make your own" parked as staff-only experimental (Sept 2026)
    name: "Workspace",
    tagline: "Shapes, photos, and text on one canvas",
    blurb:
      "A canvas-first studio: pick Shapes, Photos, or Text from the left rail, add elements from the bottom bar, arrange them as layers on the hoop, and export the whole design as one file.",
    component: lazy(() => import("./workspace")),
    wide: true,
    fullscreen: true,
    collection: "nextgen",
    status: "candidate",
  },
  {
    slug: "animate",
    staffOnly: true,
    name: "Animator",
    tagline: "Turn a rendering into a GIF or video",
    blurb:
      "Load a photo, pick a rendering (cross-stitch, portrait squiggle, or halftone), and animate a dial moving or the stitches appearing in sew order. Exports a clean GIF or video straight from the engine - no screen recording, cropping, or color fixing.",
    about:
      "Frames are built by the same engines as the tools and drawn with the standard stitch renderer at your chosen size and background (or transparent, for GIFs). GIF encoding runs in the browser (gifenc); video uses the browser's recorder - MP4 on Safari, WebM elsewhere. Filenames carry the rendering, dial, and range so exports sort cleanly.",
    component: lazy(() => import("./animate")),
    fullscreen: true,
    collection: "nextgen",
    status: "candidate",
  },
  {
    slug: "photoreal",
    name: "Photoreal",
    tagline: "A photo in real thread colors - animated, and stitchable",
    blurb:
      "The photo quantizes to real Madeira cones, then renders as color thread paint, a layered halftone, or fine cross-stitch. Watch the stitch-out animate, export it as a GIF or video, and download the same design as a real DST or PES file (keep detail moderate for a stitchable result).",
    about:
      "One build feeds everything: the image is quantized to a chosen number of cones (k-means over cells, matched to the Madeira Polyneon range), each cone becomes a color plane sewn darkest-first, and the geometry method (grain-following strokes, per-cone line screens, or counted crosses) runs per plane. The animation and the machine file come from the identical stitch sequence.",
    component: lazy(() => import("./photoreal")),
    fullscreen: true,
    collection: "nextgen",
    status: "candidate",
  },
  {
    slug: "border",
    name: "Borders",
    tagline: "Framed borders, from classic lines to art nouveau vines",
    blurb:
      "Pick a motif, set the width and height independently, and the repeats snap to fit each side evenly. Corner squares, diamonds, dots, or curls finish the frame, with plain lines inside or out.",
    about:
      "Each motif is engineered as one continuous line per edge, including the closed laurel leaves (drawn out along the tops and back along the bottoms), so edges sew without mid-run trims. Repeat counts round to whole numbers per side, which keeps the pattern resolved at the corners at any aspect ratio.",
    component: lazy(() => import("./border")),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "sketch",
    staffOnly: true, // "Make your own" parked as staff-only experimental (Sept 2026)
    name: "Sketch",
    tagline: "Write simple code that draws patterns to stitch",
    blurb:
      "Write a few lines of JavaScript that draw shapes and watch them become a stitch file. Good for spirals, waves, and generative experiments, with example sketches you can start from and change.",
    about:
      "A p5.js-spirit drawing environment. Your code runs against a small drawing API (line / circle / arc / polygon, a path builder, stroke() for thread color) plus seeded random() and value noise(), in a 100×100 space scaled to the hoop and exported as DST. This is the engine the no-code Pattern Blocks tool is built on.",
    component: lazy(() => import("./sketch")),
    collection: "nextgen",
    status: "digitally-validated",
  },
  {
    slug: "librarypage",
    name: "Library",
    tagline: "Everything you've saved, ready to re-download",
    collection: "utility",
    blurb:
      "Every design you save is kept here with its picture, colors, and exact stitch file. Signed in, your latest designs also back up to your account and follow you across browsers and devices.",
    about:
      "Saved designs are stored in the browser's IndexedDB with their exact DST bytes, a thumbnail, cone list, and stats. Nothing leaves your machine; hundreds of designs cost only a few megabytes.",
    component: lazy(() => import("./library")),
  },
  {
    slug: "lettering",
    name: "Lettering",
    tagline: "Stitch words and names in dozens of fonts",
    blurb:
      "29 built-in styles, from plain and bold to script, blackletter, Greek, and Cyrillic. Bend the text into an arc, fill the letters solid, or upload your own font.",
    about:
      "29 single-line stroke faces (the Hershey set + EMS family, plus blackletter, script, Times, cursive, Greek, Cyrillic) sewn as running stitch or true satin, with an arc option. Uploaded OTF/TTF/WOFF fonts are parsed with opentype.js and filled with tatami (counters left open) or run as an outline.",
    component: lazy(() => import("./lettering")),
  },
  {
    slug: "fractal",
    name: "Fractal Turtle",
    tagline: "Draw intricate maze-like curves that fill a space",
    blurb:
      "Hilbert, dragon, Gosper, and more, each folding to fill a square as one unbroken line. Pick a preset or write your own rule.",
    about:
      "A turtle interpreter for Lindenmayer systems (L-systems). Space-filling curves stitch as one continuous thread with zero trims. Presets plus a full custom rule editor.",
    component: lazy(() => import("./fractal")),
  },
  {
    slug: "portrait",
    name: "Thread Portrait",
    tagline: "A photo as one continuous stitched line",
    blurb:
      "One unbroken thread traces the light and shadow of a face and sews without stopping. Set brightness and contrast for the look, and pick one to three tones for depth.",
    about:
      "Darkness-weighted stippling (weighted Voronoi relaxation) drops the dots, and a traveling-salesman tour threads them into one unbroken running-stitch line. Brightness, contrast, and denoise shape the tones first. A Chaikin line-flow control rounds the tour into a smooth stroke. One to three tones, darkest thread first.",
    component: lazy(() => import("./portrait")),
  },
  {
    slug: "harmonograph",
    name: "Harmonograph",
    tagline: "Looping, spiral-like curves from a pendulum machine",
    blurb:
      "The overlapping loops an old Victorian pendulum machine drew. Every setting gives a different tangle, and randomize gives you a fresh one.",
    about:
      "Two decaying pendulums per axis trace dense, overlapping loops: the Victorian harmonograph, in thread. Continuous path, randomizable.",
    component: lazy(() => import("./harmonograph")),
  },
  {
    slug: "tatami",
    name: "Tatami Fill",
    tagline: "Fill a shape solid with neat rows of stitches",
    blurb:
      "Even rows at whatever angle you like, the standard way embroidery fills a solid area. Use a built-in shape or your own outline.",
    about:
      "Scanline fill of closed shapes at any angle, with serpentine row routing, brick-pattern stitch stagger, and an optional outline pass. Built-in shapes or your own SVG.",
    component: lazy(() => import("./tatami")),
  },
  {
    slug: "satin",
    name: "Satin Ribbon",
    tagline: "Make smooth, glossy satin lines and lettering",
    blurb:
      "The raised, shiny stitching used for lettering and borders, laid along any path or curve. It puts down proper backing so it holds up on knits.",
    about:
      "True satin columns along any path, with a chained underlay stack, pull compensation, and curvature-aware short-stitching. This is the core pro-digitizing primitive. Draw a stroke, pick a curve, or satin a Hershey monogram.",
    component: lazy(() => import("./satin")),
  },
  {
    slug: "phyllotaxis",
    name: "Phyllotaxis",
    tagline: "Sunflower and seed-head spiral patterns",
    blurb:
      "The spiral found in sunflowers and pinecones. One slider moves it from tight spirals to a loose web, and small changes reshape the whole thing.",
    about:
      "Vogel's seed-head model, sewable two ways: parastichy whorls (the spiral arms your eye picks out) or a continuous chord web. The divergence-angle slider is the control: 0.1 degree off the golden angle and the structure breaks up.",
    component: lazy(() => import("./phyllotaxis")),
  },
  {
    slug: "threadpaint",
    name: "Thread Painting",
    tagline: "A photo as painterly thread strokes",
    blurb:
      "The strokes follow the natural flow of the image in layers of light and dark thread, so it looks hand-painted. A digital take on traditional thread painting.",
    about:
      "Crewel needle-painting, automated: a structure tensor reads which way the photo's texture flows, and alternating long-short strokes follow it across two or three darkness layers, darkest cone first (Hertzmann-style painterly rendering with a needle).",
    component: lazy(() => import("./threadpaint")),
  },
  {
    slug: "animator",
    name: "Animate",
    tagline: "Any interpretation, or any saved design, as a stitch-out animation",
    blurb:
      "One place to make stitch-out GIFs and videos: load a photo and switch between the suite's interpretations - cross-stitch, portrait squiggle, halftone, thread paint, hedcut, engraving, contours, image maze - or animate a design saved from any tool. Transparent backgrounds, sew-order or left-to-right reveal, and the same build downloads as a real stitch file.",
    component: lazy(() => import("./animator")),
  },
  {
    slug: "flowink",
    name: "Flow Ink",
    tagline: "Hedcut dots, engraving strokes, or flowing contours from a photo",
    blurb:
      "Three ink looks steered by the photo's own flow: stipple dots that ridge along features like a newspaper portrait, short engraving strokes with a woodcut feel, or long combed contour lines whose spacing draws the picture.",
    about:
      "An edge-tangent flow field (the FDoG kind) steers all three modes: anisotropic dart-throwing chains hedcut dots along the flow, short streamlines become engraving strokes, and Jobard\u2013Lefer evenly-spaced streamlines with tone-driven separation become contours. Dots sew as small tack clusters; lines sew as running stitch, routed to minimize jumps.",
    component: lazy(() => import("./flowink")),
  },
  {
    slug: "imagemaze",
    name: "Image Maze",
    tagline: "Your photo as one connected labyrinth",
    blurb:
      "Darkness becomes maze density: the subject turns into tight corridors while the background stays open, and the whole picture is a single connected structure - it sews as a few long runs with almost no trims.",
    about:
      "A tone-driven quadtree places sites (dark regions subdivide finer), a minimum spanning tree with darkness-weighted edge costs joins them, and routeStrokes merges the tree into long corridors. The MST-halftone idea from Computers & Graphics 2009, tuned for thread.",
    component: lazy(() => import("./imagemaze")),
  },
  {
    slug: "turing",
    name: "Turing Skin",
    tagline: "A photo regrown as living reaction-diffusion patterns",
    blurb:
      "Gray-Scott chemistry runs only where your photo is dark, so the image re-forms as organic spots and worms - then the pattern is skeletonized into running-stitch paths. Slide between spots and worms, and comb the growth along the photo's own grain.",
    about:
      "The feed rate is mapped from local tone across the spot/worm/labyrinth regimes and the Laplacian is anisotropically weighted by the edge-tangent flow, so tone chooses the pattern's character and structure steers its direction. The B field is thresholded, thinned, and traced into polylines.",
    component: lazy(() => import("./turing")),
  },
  {
    slug: "directional",
    name: "Directional",
    tagline: "A photo drawn in flowing lines, darker where it's shaded",
    blurb:
      "The lines follow the picture's grain and bunch closer together in the shadows, so the image comes out of direction and density at once.",
    about:
      "Directionality-aware embroidery (Eurographics 2023): because thread is anisotropic, direction carries appearance. Streamlines trace the image's own grain while their spacing tightens with darkness.",
    component: lazy(() => import("./directional")),
  },
  {
    slug: "fermat",
    name: "Fermat Fill",
    tagline: "Fill any shape with a single continuous spiral",
    blurb:
      "One inward-and-back spiral gives a swirl texture and sews without stopping, a different look from plain row fills.",
    about:
      "Connected Fermat Spirals (SIGGRAPH 2016), a fill from layered-fabrication research: iso-contours of the shape, spiraled inward on even rings and back out on odd ones, both ends exiting at the boundary. Zero trims on spirallable shapes.",
    component: lazy(() => import("./fermat")),
  },
  {
    slug: "quilting",
    name: "Quilting",
    tagline: "Free-motion quilting patterns: stipple, pebbles, blooms",
    blurb:
      "The wandering, all-over patterns used in free-motion quilting: classic stipple, pebbles, or flower blooms. Each draws as a single path.",
    about:
      "The CMU quilting-pattern architecture: blue-noise samples, a spanning-tree skeleton, and a down-and-back walk that covers every branch as one closed line. Chaikin smoothing yields the classic free-motion stipple; pebbles and blooms graft on without breaking the thread.",
    component: lazy(() => import("./quilting")),
  },
  {
    slug: "reaction",
    name: "Reaction–Diffusion",
    tagline: "Organic stripe, maze, and spot patterns from nature",
    blurb:
      "The stripes, mazes, and spots you see on animal skin and coral, grown on a grid and stitched as flowing lines. Every run comes out a little different.",
    about:
      "Gray–Scott reaction-diffusion simmered on a grid until zebrafish-like stripes freeze out. Worm-regime stripes (near-constant width) are extracted as centerlines and sewn in bean stitch, or as cell-wall outlines. The math behind fingertip ridges, in thread.",
    component: lazy(() => import("./reaction")),
  },
  {
    slug: "meander",
    name: "Meander",
    tagline: "Fill any shape with a single maze-like wandering line",
    blurb:
      "One line wanders back and forth to cover the whole area, like a maze. Feed it a photo and the wandering follows the picture's features.",
    about:
      "Context-based space-filling curves (Eurographics 2000): a spanning tree over the region's cells, circumnavigated as a single Hamiltonian cycle. Any shape fills as one closed line; weight the tree with a photo and the maze follows its features.",
    component: lazy(() => import("./meander")),
  },
  {
    slug: "redwork",
    name: "Redwork Router",
    tagline: "A photo as a clean single-color line drawing",
    blurb:
      "It inks the photo the way an illustrator would, then sews it in a single color for the classic redwork look. Bold outlines, with as few jumps as possible.",
    about:
      "The antique single-color redwork tradition, automated: Coherent Line Drawing research (edge tangent flow plus flow-based difference-of-Gaussians) inks the photo, then skeleton tracing and travel ordering sew it as bold bean-stitch lines with minimal hops.",
    component: lazy(() => import("./redwork")),
  },
  {
    slug: "growth",
    name: "Differential Growth",
    tagline: "A loop that grows into coral-like, brainy shapes",
    blurb:
      "A simple loop grows and folds into rippling coral and brain forms. Stop it whenever you like; at every stage it's one clean line.",
    about:
      "Differential growth: nodes attract their neighbors, repel everyone else, and split when stretched, so the loop folds into coral and brain-coral forms while staying one non-crossing closed line at every step.",
    component: lazy(() => import("./growth")),
  },
  {
    slug: "stringart",
    name: "String Art",
    tagline: "A photo recreated as thread strung between pins",
    blurb:
      "Hundreds of straight threads stretched between pins around a circle, building the image up one line at a time.",
    about:
      "The computational string-art method (Eurographics 2018), chained so every chord starts where the last ended. A portrait becomes hundreds of straight passes between pins on a circle: one continuous line, a single tie-in and tie-off.",
    component: lazy(() => import("./stringart")),
  },
  {
    slug: "oneline",
    name: "One-Line",
    tagline: "A photo drawn with a single continuous line",
    blurb:
      "Your photo redrawn as one unbroken line - a field of dots, denser in the shadows, threaded together in the shortest path that visits them all. No trims, no jumps: exactly what an embroidery machine (or a pen plotter) wants.",
    about:
      "The 'TSP art' method (what finitecurve.com does): weighted blue-noise stippling places dots with density proportional to darkness, then a traveling-salesman route - grid nearest-neighbour construction refined by neighbour-list 2-opt - orders every dot into the shortest single tour. The whole image comes out as one continuous stroke, optionally closed into a loop.",
    component: lazy(() => import("./oneline")),
    status: "digitally-validated",
  },
  {
    slug: "imagepack",
    name: "Circle Pack",
    tagline: "A photo rebuilt from packed dots sized by tone",
    blurb:
      "Dots pack tightly across your photo without overlapping, each sized by how dark the image is beneath it - big in the shadows, small in the highlights, bare where it's brightest. Sew them as open rings or spiral-filled discs.",
    about:
      "A darkness-driven circle packing (the D3 circle-pack idea as tone): seeded dart-throwing on a spatial grid places non-overlapping discs whose radius is set by the local luminance. Each disc sews as a closed ring or a continuous Archimedean spiral, and the discs are travel-ordered to minimise machine hops.",
    component: lazy(() => import("./imagepack")),
    status: "digitally-validated",
  },
  {
    slug: "hatchtone",
    name: "Cross-Hatch",
    tagline: "A photo shaded with layered pencil-style hatching",
    blurb:
      "Shade a photo the way an ink sketch does: highlights stay bare, midtones get a pass or two, and the darkest areas stack every layer into dense cross-hatching. Long parallel runs the machine sews fast.",
    about:
      "Tonal cross-hatching by thresholded layers: for each layer a field of parallel lines at its own angle is swept, and a line only inks where the local darkness clears that layer's threshold, so darker regions accumulate more crossing layers. The runs are travel-ordered before stitching.",
    component: lazy(() => import("./hatchtone")),
    status: "digitally-validated",
  },
  {
    slug: "asciitext",
    name: "ASCII Art",
    tagline: "Turn a word or photo into typed-character art",
    blurb:
      "The FIGlet idea: type a word (or drop a photo) and it's rebuilt out of characters, densest where the source is dark. Copy the text for a banner or caption - or stitch it as a running-stitch dot-matrix of the art.",
    about:
      "Text is rasterized to a luminance grid on an offscreen canvas (or a photo is downsampled to one), then each cell is mapped to a character from a density ramp. For stitching, every inked cell becomes a small block, travel-ordered into a dot-matrix rendering of the art.",
    component: lazy(() => import("./asciitext")),
    collection: "utility",
  },
  {
    slug: "garment3d",
    name: "3D Garment",
    tagline: "Preview a design on a spinnable 3D version of a lab blank",
    blurb:
      "Pick a real blank from the design lab - hoodie, crew, tee, zip hoodie, tote, beanie, shorts - and a colorway, then drop a design onto a spinnable 3D version of it. Change the color, move and scale the art, and grab a snapshot. A quick way to feel how a print sits on the actual piece.",
    about:
      "A WebGL (three.js) previewer driven by the lab's garment catalog: each blank's silhouette is a procedural mesh (THREE.Shape + ExtrudeGeometry) recolored live from the real colorway hex, with the design mapped as a transparent panel on the chest. It's a visualization, not a stitch file - use it to judge placement and scale before you commit.",
    component: lazy(() => import("./garment3d")),
    collection: "utility",
    wide: true,
  },
  {
    slug: "rose",
    name: "Rose",
    tagline: "Flower and web patterns from two numbers",
    blurb:
      "Two numbers give a lot of range, from smooth flowers to straight-line webs. Each one closes into a single line.",
    about:
      "The rhodonea curve r = cos(nθ) and its Maurer-rose cousin, where big angular strides across the rose weave a geometric web. Two integers unfold into flowers, and the walk closes on itself.",
    component: lazy(() => import("./rose")),
  },
  {
    slug: "star",
    name: "Star",
    tagline: "Interlaced star patterns from Islamic geometry",
    blurb:
      "The interlaced shapes you see in Islamic geometric art. Draw one star, or a whole field of them linked into a single line.",
    about:
      "The one-stroke {n/m} star polygon: n points on a circle, connect every m-th. A grid of them chains corner to corner into a single continuous line, a field of interlaced stars with no trims.",
    component: lazy(() => import("./star")),
  },
  {
    slug: "attractor",
    name: "Attractor",
    tagline: "Dense, symmetrical thread webs from a repeating formula",
    blurb:
      "Delicate, symmetrical thread webs from 'strange attractor' math. Four numbers reshape the whole thing, so it's a good one to play with.",
    about:
      "Iterate a de Jong or Clifford strange attractor and connect its points in birth order: one unbroken thread scribbles a dense, symmetrical web, the strange-attractor cousin of the harmonograph. Four numbers reshape the whole thing.",
    component: lazy(() => import("./attractor")),
  },
  {
    slug: "maze",
    name: "Maze",
    tagline: "A real maze: stitch the walls or the solution path",
    blurb:
      "A proper maze with exactly one path through it. Stitch the walls, or trace the single winding solution from start to finish.",
    about:
      "A recursive-backtracker maze with exactly one path between any two cells. Stitch the walls, or trace the true solution from entrance to exit as one wandering continuous line, no trims.",
    component: lazy(() => import("./maze")),
  },
  {
    slug: "truchet",
    name: "Truchet",
    tagline: "Tile patterns that flow into looping labyrinths",
    blurb:
      "Simple curved tiles on a grid connect into long, looping labyrinths. One setting reshuffles the whole thing.",
    about:
      "Sébastien Truchet's 1704 idea: every cell of a grid flips between two tiles, and the arcs join across the grid into long continuous loops. One seed makes a new maze each time.",
    component: lazy(() => import("./truchet")),
  },
  {
    slug: "sashiko",
    name: "Hitomezashi",
    tagline: "Japanese sashiko stitch patterns from any word",
    blurb:
      "The running-stitch grids of Japanese sashiko. Type any phrase and it becomes a woven-looking texture, sewn as neat dashes.",
    about:
      "The Japanese one-stitch tradition, formalized: every pattern is two bit strings phasing the rows and columns. Fibonacci and Pell words give quasiperiodic textures, and any phrase becomes a pattern. It sews continuously as bean-weight dashes, no trims.",
    component: lazy(() => import("./sashiko")),
  },
  {
    slug: "flowfield",
    name: "Flow Field",
    tagline: "Evenly-flowing organic line textures",
    blurb:
      "Lines like wind or water currents, spaced more evenly than you could get by hand. A soft, even texture across the hoop.",
    about:
      "The Jobard–Lefér algorithm from flow-visualization research: streamlines traced through a seeded noise field, kept perfectly evenly spaced by an occupancy grid.",
    component: lazy(() => import("./flowfield")),
  },
  {
    slug: "studio",
    staffOnly: true, // "Make your own" parked as staff-only experimental (Sept 2026)
    name: "Digitizing Studio",
    tagline: "Draw your own design by placing points by hand",
    blurb:
      "Click to place points, shape them into lines and areas, and choose how each is stitched: a running line, a smooth satin, or a solid fill. You build it exactly the way you want.",
    about:
      "The classic object-based digitizing workflow, browser-native: drop nodes, build shapes, and apply a stitch type to each (running stitch, true satin column, or angled tatami fill), then edit nodes and tune density, angle, and underlay per object. Multi-color, reorderable sew sequence. The preview is re-parsed from the real DST.",
    component: lazy(() => import("./studio")),
    status: "digitally-validated",
  },
  {
    slug: "crossstitch3",
    name: "Cross-Stitch V3",
    tagline: "A cross-stitch chart from a photo, with full control and a cleaner file",
    blurb:
      "Adjust brightness, contrast, and saturation, set the number of colors, then swap any color's thread or merge two together. Add a backstitch outline for crisper edges. The crosses are ordered to sew with far fewer jumps than the earlier versions, and it exports as DST or Brother PES.",
    about:
      "Reuses V2's CIELAB quantizer and fractional-edge cross geometry, then improves the output: every color's crosses are ordered by a nearest-neighbour travel walk (V2 emitted each diagonal cold, jumping before every one), and an optional chained backstitch outline traces the color regions. Pre-adjust (brightness, contrast, saturation), palette swap and merge, and DST or PES export.",
    component: lazy(() => import("./crossstitch3")),
    status: "digitally-validated",
  },
  {
    slug: "crossstitch2",
    name: "Cross-Stitch V2",
    tagline: "A cross-stitch chart from a photo, with smoother color and detail",
    blurb:
      "Cleaner colors, less speckle, and part-stitches that smooth the diagonal edges for a finer result than the first version.",
    about:
      "Everything V1 does, taken further: colors clustered and cone-matched in CIELAB, isolated one-cell confetti absorbed into its surroundings, and three-quarter and quarter stitches smoothing every diagonal color boundary.",
    component: lazy(() => import("./crossstitch2")),
  },
  {
    slug: "crossstitch",
    name: "Cross-Stitch",
    tagline: "Counted cross-stitch from a photo, in your thread colors",
    blurb:
      "It matches your image to real Madeira Polyneon thread colors, and the preview shows exactly which colors to pull.",
    about:
      "Quantizes an image to a handful of Madeira Polyneon cones and sews serpentine X's per color.",
    component: lazy(() => import("./crossstitch")),
  },
];

export function ToolsHost({
  slug,
  onNavigate,
}: {
  slug: string | null;
  onNavigate: (slug: string | null) => void;
}) {
  const tool = slug ? TOOLS.find((t) => t.slug === slug) : undefined;

  if (!tool) {
    const nextgen = TOOLS.filter((t) => t.collection === "nextgen");
    const experiments = TOOLS.filter((t) => !t.collection);
    const utility = TOOLS.filter((t) => t.collection === "utility");
    return (
      <div className="space-y-8">
        <section className="space-y-3">
          <div className="flex items-baseline gap-3 flex-wrap">
            <h3 className="font-serif text-[1.5rem] text-fg">Next Gen</h3>
            <span className="text-[0.8125rem] text-mid">
              The tools I've built out the furthest and aimed most directly at real stitch-outs.
            </span>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {nextgen.map((t) => (
              <ToolCard key={t.slug} t={t} onNavigate={onNavigate} />
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-baseline gap-3 flex-wrap">
            <h3 className="font-serif text-[1.5rem] text-fg">Experiments</h3>
            <span className="text-[0.8125rem] text-mid">
              The full set of experiments: mathematical, generative, textile, and image-based. Every one
              exports a real .DST file.
            </span>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {experiments.map((t) => (
              <ToolCard key={t.slug} t={t} onNavigate={onNavigate} />
            ))}
          </div>
        </section>

        {utility.length > 0 && (
          <section className="space-y-3">
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {utility.map((t) => (
                <ToolCard key={t.slug} t={t} onNavigate={onNavigate} />
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }

  const Tool = tool.component;
  return (
    <div className="space-y-5">
      <div className="flex items-baseline gap-4 flex-wrap">
        <button
          onClick={() => onNavigate(null)}
          className="text-[0.8125rem] text-accent hover:underline"
        >
          ← All tools
        </button>
        <h2 className="font-serif text-[1.375rem] text-fg">{tool.name}</h2>
        <span className="text-[0.8125rem] text-mid">{tool.tagline}</span>
      </div>
      <ToolIntro tool={tool} />
      <Suspense
        fallback={<div className="text-[0.8125rem] text-mid py-12 text-center">Loading tool…</div>}
      >
        <Tool />
      </Suspense>
    </div>
  );
}
