# Stitch Lab as a Creative System

*Product/architecture investigation, August 2026. Grounded in the actual implementation
(file references are to `src/stitchlab/`). Analysis only — no architectural changes were
made as part of this work.*

The question this document answers: **how do the capabilities we've already built become
parts of one creative system, instead of ~60 isolated tools?**

The one-paragraph answer, up front: the system is already far closer to coherent than the
menu suggests. The generation engines are shared library code, the Workspace already
converts everything into one geometry currency and composes it into a real machine file,
and the renderer/animator are universal over any design from any source. What's missing
is not abstraction — it's **memory and passage**: compositions don't persist, saved
designs forget how they were made, and no result can travel to another surface except by
flattening through the library. The highest-leverage work is closing those three gaps,
not building new infrastructure.

---

## 1. Capability model

### 1.1 The representations that actually exist

The system is shaped like an hourglass. Upstream of the waist, representations are
diverse and creative; the waist is a deliberate DST round-trip; downstream, everything
consumes one parsed form.

| Representation | Shape | Where | Status |
|---|---|---|---|
| **Source image** | `LumImg { w, h, lum: Float32Array, rgb }` | `shared.tsx:488` | Clean type, but its only constructor lives inside the `ImagePick` React component; `lineart.ts` and `orientation.ts` each re-declare their own narrower copy. |
| **Thread palette** | `ConeEntry[] { hex, code, name }` from `threadPalette()` | `lib/quantize.ts:143` | Clean and thread-first (clusters snap to real Madeira cones). Degrades to a bare `string[]` of hexes the moment it crosses into the stitch layer. |
| **Geometric paths (mm)** | `PathMm = {x,y}[]`; color-grouped as `PathMm[][]` or the Workspace's `Group[] { color, paths, noResample }` | `lib/generators.ts:10`, `workspace.tsx:90` | **The creative currency.** Fully pure, DOM-free, produced by every engine, transformable, and already the interchange the Workspace uses. |
| **Machine stitches** | `Stitch { x, y, cmd }` with `CMD` (JUMP/TRIM/COLOR_CHANGE…) | `lib/pattern.ts:10` | Pure, canonical model space (0.1 mm ints). |
| **Serialized bytes** | DST / PES / PEC `Uint8Array` | `lib/dst.ts`, `pes.ts`, `pec.ts` | DST carries **no color** and approximates TRIM/STOP; PES snaps colors to the 64-slot Brother palette. Lossy by format design. |
| **Parsed pattern** | `ParsedPattern { stitches, blockColors, format, name, meta }` | `lib/pattern.ts:29` | **The read-side hub.** Everything downstream consumes this and only this. |
| **The waist** | `Built { bytes, pattern, stats }` from `buildDesign()` | `shared.tsx:229,236` | Every tool (43 importers) funnels through: stitches → `writeDst` → `parseDst` → stats. Deliberate: the preview *is* the re-parsed file. WYSIWYG-to-machine is a core honesty guarantee — keep it. |
| **Stats / sewability** | `PatternStats` (26 fields), `Sewability` (density grid, score, warnings) | `lib/stats.ts:38`, `analysis.ts:45` | Pure functions over `ParsedPattern`. Recomputed, never persisted whole. |
| **Saved design** | `SavedDesign { id, name, tool, stitchCount, w/h, colors, thumbPng, bytes }` | `lib/library.ts:5` | **An export artifact, not a document.** No source image, no parameters, no layer structure. The `tool` field is a label, not a re-open handle. |
| **Workspace layer** | `Layer = Shape \| Text \| Photo \| Design` union | `workspace.tsx:67-85` | In-memory only. Photo layers are the system's best object: source pixels retained + all three interpretations' params live simultaneously. Design layers are the worst: frozen geometry, nothing editable but transform. |
| **Animation frame / clip** | `Frame { built, colors, threadMm }`, `Clip { frames, seq, fps }` | `animate.tsx:92,665` | The frame is source-agnostic (just a `Built`); the only *constructor* is photo-bound. |
| **Rendered imagery / GIF / video** | canvas pixels, encoded bytes | `lib/render.ts` | Terminal outputs. `renderPattern`/`StitchAnimator` need **only a `ParsedPattern`** — any design from any source renders and animates identically (`render.ts:62,220`). |

### 1.2 What is lost at each boundary (this determines what "editing later" can mean)

- **paths → stitches**: path grouping collapses (groups survive only as COLOR_CHANGE
  boundaries); per-path identity and curvature intent are gone (`generators.ts:133-163`).
- **stitches → DST**: all color identity, TRIM-vs-jump, STOP-vs-COLOR_CHANGE.
- **anything → SavedDesign**: **parameters, source image, and composition structure.**
  This is the decisive loss in the whole system. Nothing anywhere can reopen a design
  with its sliders restored — by construction, not by accident.
- **Workspace session → reload**: *everything*. The composition is pure React state
  (`workspace.tsx:369`); there is no persistence of the layer tree at all.
- **design → Workspace re-import**: `designToGroups` (`workspace.tsx:150`) lifts DST
  bytes back to per-color polyline groups — the one backward flow in the system — but
  arrives frozen: no recolor, no reinterpret, transform-only.

### 1.3 The engines (7, not 60)

The ~60 tools are React shells over roughly seven engines, graded honestly:

| Engine | Pure logic | Grade | Already reused by |
|---|---|---|---|
| Cross-stitch quantizer (V1+V2) | `crossstitch.tsx:71,325,407`; `crossstitch2.tsx:104,275` | **A** | workspace, animate, photoreal, crossstitch3 |
| Portrait/stipple | `portrait.tsx:60-425` (sobel, stipple, tour, chaikin) | **A** | workspace, animate, photoreal |
| Block engine | `sketch.tsx:203,438` (`BLOCK_DEFS`, `runBlocks`) — a serializable `Block[]` program | **A** (region-clip would be **C**) | 23 factory tools, blocks, blocks2, workspace, previews |
| Lettering (Hershey + uploaded outline) | `lettering.tsx:84,194,268`; `lib/outlinefont.ts:126` | **A** | workspace, monogram, badge, blackwork, redwork, reaction |
| Digitizer stack (tatami fill, satin, orientation field, line-art trace) | `tatami.tsx:248,411`; `satin.tsx:114`; `lib/orientation.ts:56`; `lib/lineart.ts` | **A** — `tatamiFill(rings, opts)` fills *any* closed rings from anywhere | ~10 tools each |
| Transform/compose | `lib/compose.ts:16-103` (`Placement`, `placeStitches`, `composeLayers`) | **A but under-adopted** — only the retired Composer uses it; the Workspace re-implements placement in path space | composer only |
| Path→stitch spine | `lib/generators.ts` (resample, beanify, fit, groups→stitches) | **A** (universal, 43 importers) | everyone |

Generative one-offs (attractor, reaction, growth, flowfield, …) keep their math inside
component bodies: **B** where the core loop is extractable (fractal, flowfield,
attractor), **D** for the tiny parametric ones (rose, star) — extracting those adds
complexity without creative payoff. Several already exist as block defs, so their
standalone versions partly duplicate the block engine.

**The important conclusion:** the reuse the "one system" vision needs *mostly already
exists at the engine level*. The Workspace is a thin compositor over shared engines. The
friction is not in the math — it's in state, persistence, and passage.

---

## 2. Architecture friction

Ranked by how much they block the creative-system goal, not by code ugliness:

1. **No persisted composition.** The Workspace — the flagship — forgets everything on
   reload. Everything else on this list matters less while this is true. The layer
   union is almost entirely serializable today (shape/text/design layers trivially;
   photo layers need the pixels stored — a dataURL alongside `LumImg`; uploaded fonts
   need their bytes kept).
2. **SavedDesign is an artifact, not a document.** No `params`, no source, no structure.
   "Re-editing" can only ever mean re-importing frozen geometry until a save records
   *how* the thing was made. Note the asymmetry: the Workspace photo layer already IS
   the right shape (`source + params, re-runnable`) — it just evaporates instead of
   persisting.
3. **The Animator's front door is photo-only.** `buildFrame` is hardwired to `LumImg`
   (`animate.tsx:96`), but `drawFrame`, `buildSequence` (stitch-out), `sharedView`,
   collage, and both encoders are already generic over any `Built`. One thin
   `Built → Frame` adapter unlocks "animate any design" — workspace compositions,
   library designs, photoreal outputs. There is no architectural blocker, only a
   missing constructor.
4. **The library is the only inter-tool bus, and its page is a dead end.** Cross-tool
   data movement is exclusively save → IndexedDB → Workspace-import. The library page
   itself offers download-DST / delete / look — no "Open in Workspace," no "Animate,"
   no PES. The bus exists; it has no verbs.
5. **Navigation carries no state.** Every cross-tool jump is a bare `location.hash =
   slug`; no tool can hand another tool anything at runtime.
6. **Two rival transform implementations.** `lib/compose.ts` (stitch-space, clean,
   Node-validated) vs. the Workspace's inline path-space placement. The Workspace won;
   compose.ts's only consumer is the retired Composer.
7. **Photoreal duplicates the Animator.** Two stitch-out loops, two MediaRecorder
   stacks, two batch pipelines; they share only `encodeGifFit`/`zipStore`.
8. **Small inconsistencies that matter to the bus:** Studio and Composer save
   *local-only* (`saveDesign` direct — never syncs to the account, unlike every other
   tool); `LumImg` construction is trapped in `ImagePick`; the `geomCache` photo key
   fingerprints only `name/w/h` (two same-named same-size images collide); `ToolDef`
   declares zero input/output metadata, so nothing can ask "which tools accept a
   design?"

Deliberately **not** listed as friction: the DST round-trip waist. It's lossy on
purpose — it is the honesty guarantee that the preview is the file. Any "recipe" layer
should sit *beside* it, not replace it.

---

## 3. Creative flow map

### Already possible but hidden

- **Any tool → library → Workspace → combined patch → DST/PES.** Fully implemented.
  Discoverability is the entire problem: it requires knowing that ☆ Save feeds the
  Workspace's "Saved" tab. The ToolsModal copy hints at it; nothing teaches it.
- **Animate any design's stitch-out.** `StitchAnimator`/`renderPattern(upTo)` work on
  any `ParsedPattern` — every tool's preview already proves it. Only the Animator's
  *input* hides this generality.
- **Uploaded DST/PES as source material.** `parseDst`/`parsePes` exist and are robust
  (StitchLabPage uses them); no user-facing "bring your own stitch file into the
  Workspace" exists, yet `designToGroups` would accept it today.

### Small connection (modest plumbing, big payoff)

- **`Built → Frame` adapter + "Animate this"** from Workspace and library (see
  prototypes). This is the single cheapest new *capability* in the system.
- **Duplicate layer** in the Workspace. There is no clone affordance; duplicating a
  photo layer and switching the copy's mode is the natural "try two interpretations"
  move and everything under it already works (params live per-layer).
- **Library verbs**: Open in Workspace (the code path exists — it's the Workspace's
  own `addDesign`), Animate, PES export. Turns the bus terminal into a hub.
- **Workspace autosave** to IndexedDB (session restore, not multi-project management).
- **Empty-canvas photo drop** in the Workspace → creates a photo layer and opens the
  interpretation panel. Already flagged in the usability audit; through this lens it's
  promoted from UX nicety to *the* front-door statement of the product model.

### High-value architectural possibility (needs a deliberate decision)

- **Recipes: record how designs are made.** Extend saves with an optional
  `{ tool, params, source? }` sidecar (locally at first; cloud has a 4 MB record cap).
  Start by *recording* — even before any "reopen" UI exists — because provenance can't
  be added retroactively. Then let the Workspace reopen its own compositions, and
  photo tools reopen their saves. This is the document model, grown incrementally, not
  a project-file system built up front.
- **Fill-a-shape-with-X.** `tatamiFill(rings, opts)` already fills arbitrary rings;
  text outlines and shape silhouettes produce rings. Letting a selected Workspace
  shape/text layer take a *fill treatment* (tatami, and eventually a clipped block
  pattern) would be a genuinely new creative capability, not plumbing. Block-engine
  clipping is real work (grade C) — tatami is not.
- **Tools as operations on a selection.** The photo layer already demonstrates the
  model (three interpretations over one retained source). Growing it — more
  interpretations, fills on shapes/text — gradually converts "tools" into
  "things you can do to what's selected." Worth doing engine-by-engine, never as a
  generic framework.

### Bad connections (technically possible, would make the product worse)

- **Generic parameter-sweep animation of arbitrary tools.** The Animator's sweep is
  photo-mode-bound; generalizing it means serializing every tool's param space into a
  universal automation system — a workflow engine in disguise. The stitch-out is the
  universal animation; sweeps stay native to the photo tools.
- **Making every representation importable everywhere** (GIF frames as sources,
  stitch files back into photo interpreters, etc.). Round-tripping through lossy
  boundaries produces mush and teaches users nothing true.
- **Exposing the block engine's `Block[]` program in the Workspace UI.** It's the most
  serialization-ready engine, which makes it tempting — but that's Sketch's job;
  surfacing programs inside the Workspace turns the studio into an IDE.

---

## 4. The product grammar (as found, not as wished)

Watching what the code actually lets people do, the recurring verbs are:

- **Bring in** — a photo, text, a shape, a saved design (Workspace); a photo (tools).
- **Interpret** — run a source through an engine with live parameters (photo modes,
  every photo tool). *Re-runnable* inside the Workspace; one-shot elsewhere.
- **Generate** — parametric geometry from nothing (blocks, generative tools).
- **Arrange** — move/scale/rotate/flip/align/order (Workspace only).
- **Combine** — merge layers into one design (Workspace `built`).
- **Inspect** — the honest preview: re-parsed stitches, stats, hoop fit, stitch-out.
- **Save** — flatten to the library (the system's connective act, currently lossy).
- **Export** — DST/PES; GIF/video (Animator/Photoreal).

The grammar users can learn today: **bring in → interpret/generate → arrange → combine
→ inspect → save/export.** That's a real, teachable model — the Workspace already
embodies it end-to-end.

The verbs that are *missing or broken*, in grammar terms:

- **Duplicate** (no clone anywhere) — variation is the heart of creative work.
- **Reopen** (SavedDesign forgets its recipe) — "save" currently means "stop."
- **Send to** (no passage between surfaces) — "animate this," "open this here."

Recommendation: don't rename anything yet, but let these verbs drive the next moves.
Every proposed change below either strengthens an existing verb or adds one of the
three missing ones. When navigation/labels are eventually revisited, name things by
verb ("Animate this," "Open in Workspace," "Duplicate") rather than by tool.

### Progressive disclosure, through this lens

The photo layer is the exemplar: strong defaults, mode choice, 2–3 sliders surfaced,
everything re-tunable, nothing destructive. Current violations worth noting (not
fixing here): Workspace text height is a baked constant (hidden control that *should*
exist); shape layers expose only the first 4 params of engines that have more
(hidden depth with no "more" affordance); cross-stitch cone colors are locked with no
override (over-simplification — a per-group thread swap is creative control, not
complexity); design layers offer no per-group recolor even though groups carry color.

### Output honesty, without warning-noise

A vocabulary already exists: `ToolDef.status` (`candidate` / `digitally-validated` /
`ready-for-stitch-testing` / `stitch-proven`) describes *tools*. What the product
model needs is the same idea for *outputs*, derivable at render time from data we
already compute (`fitsHoop`, stitch count, `analyzeSewability`): roughly
**machine-ready · needs a stitch test · visual artwork**. One small shared chip near
the export actions could replace scattered warnings and stay calm. Documented as a
possibility — build only if the workflows below make it earn its place.

---

## 5. Concrete workflow examples

**W1 — The boat patch (works today; fragile).**
Photo of a boat → Workspace photo layer → cross-stitch mode, tune cells/cones → add
text layer with the boat's name → align, arrange → inspect stats/hoop → Download DST +
☆ Save.
`photo → LumImg → grid+palette → Group[] → merged Built → DST`.
*Friction:* a page reload at any point loses the composition; text height is fixed at
20 mm; saving flattens — tomorrow the patch can't be re-tuned, only re-imported frozen.

**W2 — Two interpretations of one photo (blocked by one missing button).**
Same portrait interpreted as squiggle *and* as cross-stitch, side by side, pick the
winner or keep both.
*Today:* re-upload the same photo as a second layer and re-tune from defaults.
*Blocker:* no Duplicate. Everything else — per-layer params, independent modes —
already works. This is the cheapest workflow unlock in the system.

**W3 — Animate the finished composition (blocked by one missing adapter).**
Finish W1's patch → watch/export the stitch-out of the *combined* design as a GIF for
Are.na (transparent, ≤25 MB).
`merged Built → Frame → buildSequence(stitchout) → encodeGifFit`.
*Blocker:* the Animator only accepts photos. Every downstream stage is already
generic. Requires: a `Built → Frame` constructor + a way to hand the design across
the hash navigation (or an "Animate" affordance in the Workspace itself).

**W4 — The lettering patch via the library bus (works today; nobody would find it).**
Lettering tool: uploaded brand font, tatami-filled, ☆ Save → Workspace: Saved tab →
add as layer → compose over a badge ring from Shapes → export.
*Friction:* pure discoverability (nothing suggests Save feeds the Workspace), and the
imported lettering is frozen — a typo means starting over in the Lettering tool
(recipe problem, again).

**W5 — Batch flowers to collage (works today, recently completed).**
33 flower photos → Animator batch → ZIP of transparent GIFs → best ones added as clips
→ 9:16 collage → video; the favorite frame → Download .dst → stitch it.
*Friction:* none blocking since the batch/collage/dst work landed; the underlying
designs still never reach the library (Animator has no ☆ Save), so the "stitch the
favorite" path exists only as a raw file download.

---

## 6. Highest-leverage next moves

Ranked by expected product learning + leverage, not implementation ease:

1. **Workspace autosave** (restore last session from IndexedDB). Foundation for the
   document model; also the single biggest trust fix. *Learning: do people build
   things worth keeping? Do sessions continue?*
2. **Duplicate layer.** Trivial, unlocks W2, directly tests whether variation-making
   is a real behavior. *Learning: do people compare interpretations?*
3. **"Animate this" via a `Built → Frame` adapter** — from the Workspace first
   (library second). Unlocks W3. *Learning: is design→animation a wanted passage, or
   do people only animate photos?*
4. **Library verbs: Open in Workspace · Animate · PES.** Makes the one existing bus
   visible and useful; near-zero new machinery (Open-in-Workspace is a hash nav +
   the Workspace's own `addDesign`). *Learning: does the library become a hub when
   given verbs, or is it a graveyard regardless?*
5. **Start recording recipes on save** — a `{ tool, params }` sidecar (plus source
   dataURL where feasible, locally only at first). No reopen UI yet. This is the
   irreversible-if-skipped one: provenance can't be back-filled. *Learning: none
   immediately — it's the wedge that makes moves 6+ possible.*
6. **Reopen for the Workspace's own saves** (recipe → layers instead of frozen
   groups). The first true "save means pause, not stop." *Learning: does re-editing
   change how people save?*
7. **Photo drop on the empty Workspace canvas** → photo layer + interpretation panel
   open. The front-door statement of the model (reframes the audit's finding).
8. **Fill-a-shape-with-tatami on selection** — the first "operation on selected
   object" beyond photos, using the already-general `tatamiFill(rings)`. *Learning:
   does the operations-on-selection model resonate before we invest in more of it?*
9. **Unify transforms** (retire the Workspace's inline placement onto `compose.ts`,
   or bless the Workspace's and delete compose.ts with the dead Composer). Code
   health; do it opportunistically when touching the Workspace.
10. **Merge Photoreal's export stack into the Animator's utilities.** Code health;
    prevents the two animation surfaces from drifting further.

(1–4 are independent and individually shippable; 5–6 are a pair; nothing here
requires a framework.)

## 7. Prototype recommendations

The three smallest experiments that answer the biggest open questions:

- **P1 — Duplicate layer** (one button in the layers panel; clone with new id, slight
  offset). Zero risk, immediately visible behavior signal. *This one is small enough
  that it's been implemented in this commit — a single button, trivially removable.*
- **P2 — "Animate this" behind the `?dev` flag.** A module-level handoff
  (`pendingDesign: { bytes, colors, name }`), set by a dev-only button in the
  Workspace action bar, consumed by the Animator on mount via a `frameFromBuilt()`
  adapter (stitch-out mode only; sweep/director stay photo-only). ~40 lines, no
  persistence, reversible. Answers: does the passage feel meaningful?
- **P3 — Autosave behind the `?dev` flag.** Serialize layers (photos as dataURLs) to
  IndexedDB on change, offer "Restore last session?" on load. Answers: what breaks in
  serialization (fonts, big photos), what does restore need to feel right — before
  committing to the recipe format.

Explicitly *not* prototyping: recipes (needs a small design decision first — see §6.5),
fill-on-selection (worth a real design pass), any registry/plugin refactor.

## 8. User-test script (10–20 minutes, first-time users)

Setup: /stitchlab on a laptop, a phone photo of theirs ready. Say only: *"This makes
embroidery designs. Make something you'd want stitched."* Then be quiet and take notes.

1. **Cold open (3 min).** They land in the Workspace. Watch: do they add anything
   within a minute? Do they understand the left rail unprompted? Does the starter
   content help or read as "already done"?
2. **"Put your photo in it." (3 min.)** Watch: do they try dragging it onto the
   canvas (currently does nothing — count how many try)? Do they find Photos? Do
   they touch the interpretation modes or accept the default?
3. **"Make a second version of it that looks different." (3 min.)** The duplicate
   probe. Do they look for copy/duplicate? Re-upload? Give up?
4. **"Add the word ___ to it." (2 min.)** Text discoverability + do they expect to
   resize it (height is currently fixed)?
5. **"Save it so you could come back tomorrow." (2 min.)** Do they find ☆ Save? Do
   they *believe* it? Ask directly: "what do you think saved — the picture, the
   file, or your whole setup?" (Tests the artifact-vs-document mental model.)
6. **"What would you do with this now?" (2 min.)** Open-ended. Count: download /
   animate / share / stitch / "am I done?". Reveals which exits people actually want.
7. **If time — "here's a design someone saved earlier; change its color."**
   (Impossible today. Watch what they try; that's the recolor design brief.)

Note throughout: every icon they hover-and-abandon, every word they read aloud with a
question mark, and the first moment they smile.

## 9. Things not to build yet

- **A node graph / visual programming surface.** The grammar has ~6 verbs and one
  compositor; a graph would formalize passage before we've validated that people want
  even one passage (P2 tests that for a fraction of the cost).
- **A universal workflow/automation engine** (generic parameter sweeps, batch
  pipelines over arbitrary tools). The Animator's sweep works *because* it's narrow.
- **A plugin/registry framework for layer kinds or tools.** The Workspace's extension
  surface is ~8 inline sites — annoying, but two more layer kinds' worth of evidence
  is cheaper than a framework, and will teach us what the registry actually needs.
- **A full project-file system** (named projects, cloud project sync, version
  history). Autosave-restore first; recipes second; projects only if users demonstrate
  multi-composition behavior. Cloud caps (4 MB/user record) make this a real design
  problem, not a checkbox.
- **Region-clipped block patterns** (fill arbitrary silhouettes with any generator).
  Genuinely exciting, genuinely C-grade work. Do tatami-fill-on-selection first; let
  demand pull the general version.
- **A global command palette of every operation.** Sixty commands is the menu problem
  restated vertically.
- **Universal import of every representation everywhere.** Honesty about lossy
  boundaries is a feature; mush is not.

### Appendix: how this reframes the open audit items

- **Tool discovery** → mostly dissolves into the Workspace model: the question becomes
  "are operations discoverable in context" (photo drop, interpretation panel, library
  verbs), not "can people browse 60 tools." The staff-only gallery can stay staff-only.
- **Library DST-only export / library verbs** → promoted sharply (the library is the
  bus — §6.4).
- **Save/library icon identity** → promoted: "Save" is the system's connective act and
  its icon should say so consistently in both shells.
- **Workspace mobile** → unchanged, still the biggest accessibility gap for the front
  door.
- **Drop-photo-on-canvas** → promoted from UX nicety to model statement (§6.7).
- **Shared action bar** → aligns with the grammar (export verbs live in one place);
  unchanged priority.
- **Zoom unification, heavy-build feedback, preview thumbnails** → unchanged, honest
  polish; none are load-bearing for the system model.
