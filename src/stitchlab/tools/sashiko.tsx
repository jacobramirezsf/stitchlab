// Stitch Lab tool: Hitomezashi Sashiko - the entire pattern is two binary
// words (Hayes & Seaton, Bridges 2020). Row i's dashes phase-shift by word
// A[i]; column j's by word B[j]. That's it - and out of those two bit strings
// fall lattices, crosses, staircases, and (with Fibonacci or Pell-style
// words) quasiperiodic textures that never repeat.
//
// Machine translation is the design problem: true hitomezashi has gaps, but
// gaps mean trims. Two modes:
//   weight - one continuous pass per line; dashes sew ×3 (bean, bold), gaps
//            sew once (light). Zero trims, both sides clean, pattern reads
//            through weight contrast. Our invention; test it on the machine.
//   gaps   - dashes only, jumps between. The purist look; the machine trims.

import { useMemo, useState } from "react";
import { THREADS } from "../../data/threads";
import { pathGroupsToStitches, pathsToStitches } from "../lib/generators";
import {
  buildDesign,
  useDebouncedKey,
  ModeButtons,
  PreviewRail,
  RangeRow,
  SectionBox,
  ThreadRow,
  ToolLayout,
  Warning,
  SizeField,
} from "./shared";

// ─── Pure logic ──────────────────────────────────────────────────────────

export { mulberry32, phaseWord, hitomezashi, sashikoPaths } from "../lib/sashiko";
export type { WordKind, SashikoGrid } from "../lib/sashiko";
import { phaseWord, hitomezashi, sashikoPaths, type WordKind } from "../lib/sashiko";

// ─── Component ───────────────────────────────────────────────────────────

const WORD_OPTIONS = [
  ["random", "Random"],
  ["fibonacci", "Fibonacci"],
  ["pell", "Pell-style"],
  ["alternate", "Alternate"],
  ["text", "From text"],
] as const;

function WordControl({
  label,
  kind,
  setKind,
  seed,
  setSeed,
  text,
  setText,
}: {
  label: string;
  kind: WordKind;
  setKind: (k: WordKind) => void;
  seed: number;
  setSeed: (n: number) => void;
  text: string;
  setText: (s: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-[0.75rem] text-mid">{label}</div>
      <ModeButtons small options={WORD_OPTIONS} value={kind} onChange={setKind} />
      {kind === "random" && (
        <button
          onClick={() => setSeed(Math.floor(Math.random() * 100000))}
          className="border border-hairline bg-bg px-3 py-1 text-[0.75rem] text-fg hover:bg-card"
        >
          Reroll (seed {seed})
        </button>
      )}
      {kind === "text" && (
        <input
          value={text}
          onChange={(ev) => setText(ev.target.value)}
          placeholder="Any words become cloth…"
          className="w-full border border-hairline bg-bg px-2 py-1 text-[0.8125rem] text-fg"
        />
      )}
    </div>
  );
}

export default function SashikoTool() {
  const [sizeMm, setSizeMm] = useState(100);
  const [pitch, setPitch] = useState(3);
  const [mode, setMode] = useState<"weight" | "gaps">("weight");
  const [kindA, setKindA] = useState<WordKind>("random");
  const [kindB, setKindB] = useState<WordKind>("random");
  const [seedA, setSeedA] = useState(11);
  const [seedB, setSeedB] = useState(47);
  const [textA, setTextA] = useState("");
  const [textB, setTextB] = useState("");
  const [twoTone, setTwoTone] = useState(false);
  const [threadHex, setThreadHex] = useState(
    THREADS.find((t) => t.family === "White" && t.hex)?.hex ??
      THREADS.find((t) => t.hex)?.hex ??
      "#f4f2ee",
  );
  const [threadHexB, setThreadHexB] = useState(
    THREADS.find((t) => t.family === "Blue" && t.hex)?.hex ?? "#082870",
  );

  const genKey = useDebouncedKey([sizeMm, pitch, mode, kindA, kindB, seedA, seedB, textA, textB, twoTone], 170);
  const built = useMemo(() => {
    const cells = Math.max(6, Math.round(sizeMm / pitch));
    const wordA = phaseWord(kindA, cells + 1, seedA, textA);
    const wordB = phaseWord(kindB, cells + 1, seedB, textB);
    const grid = hitomezashi(cells, cells, pitch, wordA, wordB);
    const { horizontal, vertical } = sashikoPaths(grid, mode);
    const stitches = twoTone
      ? pathGroupsToStitches([horizontal, vertical], 1)
      : pathsToStitches([...horizontal, ...vertical], 1);
    return buildDesign(stitches, "bayside-sashiko");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genKey]);

  const stitchCount = built?.stats.realStitches ?? 0;

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="Phase words">
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              The whole pattern is two bit strings - one phasing the rows, one the
              columns. Fibonacci and Pell-style words give quasiperiodic cloth that
              never repeats; "From text" turns any words into their stitch pattern.
            </p>
            <WordControl label="Row word" kind={kindA} setKind={setKindA} seed={seedA} setSeed={setSeedA} text={textA} setText={setTextA} />
            <WordControl label="Column word" kind={kindB} setKind={setKindB} seed={seedB} setSeed={setSeedB} text={textB} setText={setTextB} />
          </SectionBox>

          <SectionBox eyebrow="Cloth">
            <SizeField valueMm={sizeMm} min={40} max={330} onChange={setSizeMm} />
            <RangeRow label="Stitch pitch" value={pitch} min={2} max={8} step={0.25} onChange={setPitch} fmt={(v) => `${v.toFixed(2)} mm`} />
            <div>
              <div className="text-[0.75rem] text-mid mb-1.5">Dash rendering</div>
              <ModeButtons
                small
                options={[
                  ["weight", "Continuous (bean dashes)"],
                  ["gaps", "True gaps (trims)"],
                ]}
                value={mode}
                onChange={setMode}
              />
              <p className="mt-1.5 text-[0.6875rem] text-mid leading-relaxed">
                {mode === "weight"
                  ? "Dashes sew triple-weight, gaps sew once, every line is one pass - zero trims. The pattern reads through contrast."
                  : "Only the dashes sew; the machine jumps and trims between them. Authentic look, busy back."}
              </p>
            </div>
          </SectionBox>

          <SectionBox eyebrow="Thread">
            <ThreadRow label={twoTone ? "Rows" : "Thread"} hex={threadHex} onChange={(hex) => setThreadHex(hex)} />
            <label className="flex items-center gap-2 text-[0.8125rem] text-fg cursor-pointer">
              <input
                type="checkbox"
                checked={twoTone}
                onChange={(ev) => setTwoTone(ev.target.checked)}
                className="accent-accent"
              />
              Two-tone (rows vs columns)
            </label>
            {twoTone && <ThreadRow label="Columns" hex={threadHexB} onChange={(hex) => setThreadHexB(hex)} />}
          </SectionBox>
        </>
      }
      preview={
        <PreviewRail
          built={built}
          colors={twoTone ? [threadHex, threadHexB] : [threadHex]}
          name="bayside-sashiko"
          emptyHint="Pick your words."
        >
          {mode === "gaps" && (
            <Warning>
              True-gap mode jumps between every dash - expect many trims and a slower
              sew. Continuous mode keeps the look with zero trims.
            </Warning>
          )}
          {stitchCount > 60000 && (
            <Warning>Over 60k stitches - raise the pitch or shrink the cloth.</Warning>
          )}
        </PreviewRail>
      }
    />
  );
}
