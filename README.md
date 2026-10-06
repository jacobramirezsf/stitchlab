# Stitch Lab

Embroidery and garment design tools from [Bayside](https://connect.baysidesf.org). This repo is a standalone copy so you can run and build on them without the rest of the Bayside site.

| Path | What it is |
|---|---|
| `/stitchlab` | **Stitch Lab**: about 60 embroidery tools (generators, digitizing, lettering, cross-stitch, sashiko, QR, …) with DST / PES / JEF export |
| `/stitchlab?dev` | Test bench: every tool and experiment, plus a stitch-file inspector |
| `/animation` | Photo and stitch animation tools |
| `/customize` | Clothing customizer: place a design on a blank garment |
| `/lab` | Customizer Lab: the full garment mock-up studio |

## Run it

```sh
npm install
npm run dev      # http://localhost:5173
npm test         # vitest
npm run build    # typecheck + production build
```

## Layout

```
src/stitchlab/          Stitch Lab
  lib/                  engines + file formats (dst, pes/pec, jef, routing, render, palette…)
  tools/                one React component per tool; tools/index.tsx is the registry
  editor/               the stitch editor
  CREATIVE-SYSTEM.md    architecture: the 7 shared engines behind the ~60 tools
  ENGINE-RESEARCH.md    engine experiments and results
src/customizer/         clothing customizer (/customize) and Lab (/lab)
src/data/               garments, thread library, shapes
public/garments/        blank garment photos
public/shapes/          SVG shape library
digitizer/              Python auto-digitizer (see below)
```

### The engines

Most tools are thin React shells over seven shared engines. `src/stitchlab/CREATIVE-SYSTEM.md` §1.3 has the full table:

- **Cross-stitch quantizer:** `tools/crossstitch.tsx`, `tools/crossstitch2.tsx`
- **Portrait / stipple:** `tools/portrait.tsx`
- **Block engine:** `tools/sketch.tsx` (`BLOCK_DEFS`, `runBlocks`)
- **Lettering:** `tools/lettering.tsx`, `lib/outlinefont.ts`
- **Digitizer stack:** `tools/tatami.tsx`, `tools/satin.tsx`, `lib/orientation.ts`, `lib/lineart.ts`
- **Transform / compose:** `lib/compose.ts`
- **Path → stitch spine:** `lib/generators.ts`

## Python digitizer (`digitizer/`)

A separate auto-digitizer (artwork → stitch file). It has a v5 object-model compiler with fill, satin, run and underlay generation. `digitizer/v5/RESEARCH.md` explains the approach.

```sh
cd digitizer
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt pytest
python -m pytest v5/tests
python -m v5.cli raster/pear.png --formats dst,pes -o v5/output
```

`app.py` is a small WSGI service (deployed on Vercel). `v5/director.py` is optional and needs `ANTHROPIC_API_KEY`.

## What's different from the Bayside site

- **No backend.** Accounts, saved-project sync, background removal, art search and the customizer's inquiry form call Bayside's `/api/*` routes, which aren't included here. If they aren't reachable, those features are unavailable and everything else works locally. To use a backend, set `VITE_API_BASE` (see `.env.example`).
- **No studio fonts.** Bayside's font collection isn't redistributable. Upload your own fonts in the lettering tools, or list files in `src/stitchlab/tools/data/staffFonts.ts` and put them in `public/staff-fonts/`.
- **No client files.** The digitizer's reference stitch files and sample outputs aren't included. `digitizer/reference/README.md` explains how to add your own.

The Bayside site (`jacob-site`) is still the source of truth. This repo is a snapshot copy, so changes made on either side don't sync automatically.
