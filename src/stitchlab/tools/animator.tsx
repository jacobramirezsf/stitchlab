// Animate - one place to turn ANY interpretation into a stitch-out animation.
// Pick a source (any photo interpretation from across the suite, or a saved
// design from your library), and the standard preview/export rail does the
// rest: transparent GIF / video, sew-order or reading-order reveal, Are.na
// fit, plus the usual DST/PES download of the same build.
// The engines are the real ones, imported from their tools.

import { useEffect, useMemo, useState } from "react";
import {
  ToolLayout,
  SectionBox,
  RangeRow,
  ModeButtons,
  ImagePick,
  PreviewRail,
  buildDesign,
  useDebouncedKey,
  type Built,
  type LumImg,
} from "./shared";
import { pathsToStitches, resamplePath, fitPaths, routeStrokes } from "../lib/generators";
import { normalizeContrast, edgeTangentFlow } from "../lib/lineart";
import { computeStats } from "../lib/stats";
import { parseDst } from "../lib/dst";
import { listDesigns, type SavedDesign } from "../lib/library";
import { buildFrame } from "./animate";
import { hedcut, engraving, contours, dotToTack } from "./flowink";
import { mazeFromImage } from "./imagemaze";
import { THREADS } from "../../data/threads";

const NAME = "bayside-animate";
const INK = THREADS.find((t) => t.code === "1568")?.hex ?? "#0b1f3a";
const SIZE = 150;

type SourceId =
  | "crossstitch" | "portrait" | "halftone" | "threadpaint"
  | "hedcut" | "engraving" | "contours" | "imagemaze" | "library";

const SOURCES: [SourceId, string][] = [
  ["crossstitch", "Cross-stitch"],
  ["portrait", "Portrait squiggle"],
  ["halftone", "Halftone lines"],
  ["threadpaint", "Thread paint"],
  ["hedcut", "Hedcut dots"],
  ["engraving", "Engraving"],
  ["contours", "Contours"],
  ["imagemaze", "Image maze"],
  ["library", "Saved design"],
];

/** Per-source main dial: label + range, applied as `level` 1..10. */
const DIAL: Record<Exclude<SourceId, "library">, string> = {
  crossstitch: "Grid detail",
  portrait: "Detail",
  halftone: "Line rows",
  threadpaint: "Stroke grid",
  hedcut: "Density",
  engraving: "Density",
  contours: "Density",
  imagemaze: "Detail",
};

function buildFromImage(source: Exclude<SourceId, "library">, img: LumImg, level: number): { built: Built; colors: string[]; threadMm?: number } | null {
  if (source === "crossstitch" || source === "portrait" || source === "halftone" || source === "threadpaint") {
    const v: Record<string, number> = {
      cells: 20 + level * 12, cones: 4, light: 0.92,
      points: 400 + level * 280, pgamma: 1.8,
      rows: 10 + level * 6, dark: 1.6,
      grain: 22 + level * 6, tdark: 1.6,
    };
    return buildFrame(source, img, v);
  }
  const norm = normalizeContrast({ w: img.w, h: img.h, lum: img.lum });
  if (source === "imagemaze") {
    const edges = mazeFromImage(norm, level, 1);
    if (!edges.length) return null;
    const fitted = routeStrokes(fitPaths(edges, SIZE), { orOptMs: 120 }).map((p) => resamplePath(p, 2.2, 0.4));
    const built = buildDesign(pathsToStitches(fitted, 1), NAME);
    return built ? { built, colors: [INK] } : null;
  }
  const etf = edgeTangentFlow(norm, 5, 2);
  const paths =
    source === "hedcut" ? hedcut(norm, etf, level, 1.15).map((d) => dotToTack(d.x, d.y, d.r))
    : source === "engraving" ? engraving(norm, etf, level, 16)
    : contours(norm, etf, level);
  if (!paths.length) return null;
  const fitted = fitPaths(paths, SIZE);
  const finished = source === "hedcut" ? fitted : routeStrokes(fitted).map((p) => resamplePath(p, 2, 0.4));
  const built = buildDesign(pathsToStitches(finished, 1), NAME);
  return built ? { built, colors: [INK] } : null;
}

export default function AnimatorTool() {
  const [img, setImg] = useState<LumImg | null>(null);
  const [fileName, setFileName] = useState("");
  const [source, setSource] = useState<SourceId>("crossstitch");
  const [level, setLevel] = useState(5);
  const [designs, setDesigns] = useState<SavedDesign[]>([]);
  const [designId, setDesignId] = useState<string | null>(null);

  useEffect(() => {
    if (source !== "library") return;
    listDesigns().then(setDesigns).catch(() => setDesigns([]));
  }, [source]);

  const genKey = useDebouncedKey([fileName, source, level, designId], 260);
  const result = useMemo(() => {
    if (source === "library") {
      const d = designs.find((x) => x.id === designId) ?? designs[0];
      if (!d) return null;
      try {
        const buf = d.bytes.buffer.slice(d.bytes.byteOffset, d.bytes.byteOffset + d.bytes.byteLength) as ArrayBuffer;
        const pattern = parseDst(buf);
        const stats = computeStats(pattern);
        const built: Built = { bytes: d.bytes, pattern, stats };
        return { built, colors: d.colors.length ? d.colors : [INK] };
      } catch { return null; }
    }
    if (!img) return null;
    try { return buildFromImage(source, img, level); } catch { return null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genKey, img, designs]);

  return (
    <ToolLayout
      controls={
        <>
          <SectionBox eyebrow="source">
            <ModeButtons small options={SOURCES} value={source} onChange={setSource} />
            {source !== "library" ? (
              <>
                <ImagePick onImage={(i, n) => { setImg(i); setFileName(n); }} fileName={fileName} longSide={300}
                  hint="One photo, every interpretation - switch sources to compare." />
                <RangeRow label={DIAL[source]} value={level} min={1} max={10} step={1} onChange={setLevel} />
              </>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {designs.length === 0 && (
                  <p className="col-span-3 text-[0.75rem] text-mid">Nothing saved yet - ☆ Save from any tool and it appears here.</p>
                )}
                {designs.slice(0, 24).map((d) => (
                  <button key={d.id} onClick={() => setDesignId(d.id)}
                    className={`border p-1 text-left ${designId === d.id || (!designId && d === designs[0]) ? "border-fg" : "border-hairline hover:border-fg/50"}`}>
                    <img src={d.thumbPng} alt={d.name} className="w-full aspect-square object-contain" />
                    <span className="block truncate text-[0.625rem] text-mid mt-0.5">{d.name}</span>
                  </button>
                ))}
              </div>
            )}
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Every source is the real engine from its tool. The bar under the preview
              exports the stitch-out as a transparent GIF or video - choose sew order or
              left-to-right reveal - and the same build downloads as a stitch file.
            </p>
          </SectionBox>
        </>
      }
      preview={
        <PreviewRail
          built={result?.built ?? null}
          colors={result?.colors ?? [INK]}
          name={NAME}
          threadMm={result && "threadMm" in result ? (result as { threadMm?: number }).threadMm : undefined}
          emptyHint={source === "library" ? "Pick a saved design to animate." : "Load a photo, pick an interpretation."}
        />
      }
    />
  );
}
