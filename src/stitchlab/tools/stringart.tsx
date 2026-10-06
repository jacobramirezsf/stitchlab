// Stitch Lab tool: String Art - a photo becomes one continuous thread
// stretched between pins on the hoop's edge, after Birsak, Rist, Wonka &
// Musialski, "String Art: Towards Computational Fabrication of String
// Images" (Eurographics 2018). Their pipeline picks an unordered chord set
// and then finds an Eulerian ordering; we use the chained variant - every
// chord starts at the pin where the last one ended - so the result is one
// unbroken thread by construction: pure greedy, no post-pass, sews with a
// single tie-in and tie-off.
//
// Greedy scoring: keep a residual darkness image; each step picks the chord
// from the current pin that covers the most remaining darkness per unit
// length, then subtracts the thread's contribution along it. Deterministic -
// same photo + settings = same file, always.

import { useCallback, useMemo, useState } from "react";
import { THREADS } from "../../data/threads";
import type { PathMm } from "../lib/generators";
import { pathsToStitches, resamplePath } from "../lib/generators";
import {
  buildDesign,
  DropZone,
  useDebounced,
  PreviewRail,
  RangeRow,
  SectionBox,
  ThreadRow,
  ToolLayout,
  Warning,
  SizeField,
} from "./shared";

// ─── Pure logic ──────────────────────────────────────────────────────────

export type LumImage = { w: number; h: number; lum: Float32Array };

export type StringArtOpts = {
  pins?: number; // pins around the circle, default 240
  maxChords?: number; // default 900
  lineWeight?: number; // darkness one thread pass deposits, default 0.22
  minPinGap?: number; // skip chords between pins closer than this many pins, default 12
  invert?: boolean; // stitch the light instead of the dark
  stopThreshold?: number; // stop when best mean residual falls below, default 0.04
};

export type StringArtResult = {
  /** Pin index sequence; consecutive entries are the chords, in sew order. */
  sequence: number[];
  chords: number;
  /** Fraction of initial darkness mass covered (0..1) - quality readout. */
  coverage: number;
};

/**
 * Chained greedy chord selection over a circular pin ring inscribed in the
 * image's central square. Runs in O(chords × pins × diameter) - comfortably
 * under a second at default sizes.
 */
export function stringArt(img: LumImage, opts: StringArtOpts = {}): StringArtResult {
  const pins = Math.max(24, Math.min(400, Math.round(opts.pins ?? 240)));
  const maxChords = Math.max(10, Math.min(4000, Math.round(opts.maxChords ?? 900)));
  const lineWeight = opts.lineWeight ?? 0.22;
  const minPinGap = Math.max(1, Math.round(opts.minPinGap ?? 12));
  const stopThreshold = opts.stopThreshold ?? 0.04;
  const { w, h, lum } = img;

  // Residual darkness, clipped to the inscribed circle.
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) / 2 - 1;
  const residual = new Float32Array(w * h);
  let initialMass = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (Math.hypot(x - cx, y - cy) > radius) continue;
      const d = opts.invert ? lum[i] : 1 - lum[i];
      // Vignette: fade darkness toward the rim so a busy background can't
      // out-compete a centered subject for chords (subjects sit centered).
      const rr = Math.hypot(x - cx, y - cy) / radius;
      const vig = 1 - 0.55 * Math.max(0, rr - 0.4) / 0.6;
      residual[i] = Math.max(0, d * vig);
      initialMass += residual[i];
    }
  }

  const pinX = new Float64Array(pins);
  const pinY = new Float64Array(pins);
  for (let p = 0; p < pins; p++) {
    const a = (p / pins) * Math.PI * 2 - Math.PI / 2;
    pinX[p] = cx + radius * Math.cos(a);
    pinY[p] = cy + radius * Math.sin(a);
  }

  /** Walk the chord's pixels; cb returns accumulated value. */
  const walkChord = (a: number, b: number, cb: (idx: number) => void): number => {
    const x0 = pinX[a];
    const y0 = pinY[a];
    const x1 = pinX[b];
    const y1 = pinY[b];
    const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = Math.round(x0 + (x1 - x0) * t);
      const y = Math.round(y0 + (y1 - y0) * t);
      if (x >= 0 && x < w && y >= 0 && y < h) cb(y * w + x);
    }
    return steps + 1;
  };

  const sequence: number[] = [0];
  let current = 0;
  let covered = 0;
  // Avoid immediately re-walking the same chord back and forth.
  let previous = -1;

  for (let c = 0; c < maxChords; c++) {
    let bestPin = -1;
    let bestScore = 0;
    for (let p = 0; p < pins; p++) {
      const gap = Math.min(Math.abs(p - current), pins - Math.abs(p - current));
      if (gap < minPinGap || p === previous) continue;
      let sum = 0;
      let n = 0;
      walkChord(current, p, (idx) => {
        sum += residual[idx];
        n++;
      });
      const score = n > 0 ? sum / n : 0;
      if (score > bestScore) {
        bestScore = score;
        bestPin = p;
      }
    }
    if (bestPin < 0 || bestScore < stopThreshold) break;
    walkChord(current, bestPin, (idx) => {
      const take = Math.min(residual[idx], lineWeight);
      residual[idx] -= take;
      covered += take;
    });
    sequence.push(bestPin);
    previous = current;
    current = bestPin;
  }

  return {
    sequence,
    chords: sequence.length - 1,
    coverage: initialMass > 0 ? covered / initialMass : 0,
  };
}

/** Pin sequence → mm path on a circle of the given diameter, centered. */
export function sequenceToPath(sequence: number[], pins: number, diameterMm: number): PathMm {
  const r = diameterMm / 2;
  return sequence.map((p) => {
    const a = (p / pins) * Math.PI * 2 - Math.PI / 2;
    return { x: r * Math.cos(a), y: r * Math.sin(a) };
  });
}

// ─── Component ───────────────────────────────────────────────────────────

const NAME = "bayside-stringart";

export default function StringArtTool() {
  const [img, setImg] = useState<LumImage | null>(null);
  const [fileName, setFileName] = useState("");
  const [pins, setPins] = useState(240);
  const [maxChords, setMaxChords] = useState(2200);
  const [lineWeight, setLineWeight] = useState(0.13);
  const [minPinGap, setMinPinGap] = useState(12);
  const [invert, setInvert] = useState(false);
  const [sizeMm, setSizeMm] = useState(140);
  const [stitchLen, setStitchLen] = useState(3);
  const [threadHex, setThreadHex] = useState(
    THREADS.find((t) => t.family === "Black" && t.hex)?.hex ??
      THREADS.find((t) => t.hex)?.hex ??
      "#1c1c1a",
  );

  const loadFile = useCallback(async (file: File) => {
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Could not read that image."));
        image.src = url;
      });
      const long = 150;
      const scale = long / Math.max(image.width, image.height);
      const w = Math.max(40, Math.round(image.width * scale));
      const h = Math.max(40, Math.round(image.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(image, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      const lum = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        lum[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
      }
      setImg({ w, h, lum });
      setFileName(file.name);
    } finally {
      URL.revokeObjectURL(url);
    }
  }, []);

  const dPins = useDebounced(pins);
  const dChords = useDebounced(maxChords);
  const dWeight = useDebounced(lineWeight);
  const dGap = useDebounced(minPinGap);
  const result = useMemo(
    () => (img ? stringArt(img, { pins: dPins, maxChords: dChords, lineWeight: dWeight, minPinGap: dGap, invert }) : null),
    [img, dPins, dChords, dWeight, dGap, invert],
  );

  const built = useMemo(() => {
    if (!result || result.chords < 3) return null;
    const path = sequenceToPath(result.sequence, pins, sizeMm);
    return buildDesign(pathsToStitches([resamplePath(path, stitchLen)], 1), NAME);
  }, [result, pins, sizeMm, stitchLen]);

  const stitchCount = built?.stats.realStitches ?? 0;

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="Photo">
            <DropZone onFile={(f) => void loadFile(f)} className="border border-dashed border-mid/50 px-3 py-3">
              <label className="inline-block cursor-pointer border border-hairline bg-bg px-4 py-1.5 text-[0.8125rem] text-fg hover:bg-card">
                {fileName ? `↻ ${fileName}` : "Choose image"}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(ev) => {
                    const f = ev.target.files?.[0];
                    if (f) void loadFile(f);
                    ev.target.value = "";
                  }}
                />
              </label>
              <span className="ml-2 text-[0.6875rem] text-mid">or drop it here</span>
            </DropZone>
            <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer">
              <input
                type="checkbox"
                checked={invert}
                onChange={(ev) => setInvert(ev.target.checked)}
                className="accent-accent"
              />
              Stitch the light (for dark garments)
            </label>
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              High-contrast portraits and single subjects work best - the whole image
              becomes straight chords between {pins} pins on a circle.
            </p>
          </SectionBox>

          <SectionBox eyebrow="Strings">
            <RangeRow label="Pins" value={pins} min={120} max={360} step={8} onChange={setPins} />
            <RangeRow label="Max chords" value={maxChords} min={500} max={4000} step={100} onChange={setMaxChords} />
            <RangeRow
              label="Thread darkness"
              value={lineWeight}
              min={0.06}
              max={0.3}
              step={0.01}
              onChange={setLineWeight}
              fmt={(v) => v.toFixed(2)}
            />
            <RangeRow label="Min pin gap" value={minPinGap} min={4} max={40} step={2} onChange={setMinPinGap} />
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Lower darkness = more, finer passes before a region saturates. Min gap
              keeps chords crossing the middle instead of hugging the rim.
            </p>
          </SectionBox>

          <SectionBox eyebrow="Stitches">
            <SizeField label="Hoop circle" valueMm={sizeMm} min={60} max={330} onChange={setSizeMm} />
            <RangeRow label="Stitch length" value={stitchLen} min={2} max={5} step={0.1} onChange={setStitchLen} fmt={(v) => `${v.toFixed(1)} mm`} />
            <ThreadRow hex={threadHex} onChange={(hex) => setThreadHex(hex)} />
          </SectionBox>
        </>
      }
      preview={
        <PreviewRail
          built={built}
          colors={[threadHex]}
          name={NAME}
          emptyHint="Drop a photo. High-contrast images read best."
        >
          {result && built && (
            <p className="text-[0.75rem] text-mid tabular-nums">
              {result.chords.toLocaleString()} chords · {(result.coverage * 100).toFixed(0)}%
              of the image's darkness covered · one continuous thread - a single tie-in
              and tie-off
            </p>
          )}
          {result && result.chords < maxChords && result.chords >= 3 && (
            <p className="text-[0.6875rem] text-mid">
              Stopped at {result.chords} chords - remaining darkness fell below the
              threshold. Lower thread darkness for more passes.
            </p>
          )}
          {stitchCount > 60000 && (
            <Warning>
              Over 60k stitches - fewer chords or a smaller circle will spare the
              garment (string art is thread-hungry by nature).
            </Warning>
          )}
        </PreviewRail>
      }
    />
  );
}
