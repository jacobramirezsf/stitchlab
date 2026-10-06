// Stitch Lab tool: Redwork Router - a photo becomes continuous line
// embroidery, the antique single-color tradition. Pipeline: Coherent Line
// Drawing (Kang–Lee–Chui edge tangent flow + flow-based DoG) extracts clean
// connected lines; Zhang–Suen thinning reduces them to one-pixel skeletons;
// junction-aware tracing turns skeletons into polylines; endpoint merging +
// nearest-endpoint ordering (the same travel optimizer the lettering tool
// uses) sews them with as few hops as possible.

import { useCallback, useMemo, useState } from "react";
import { THREADS } from "../../data/threads";
import type { PathMm } from "../lib/generators";
import { pathsToStitches, resamplePath } from "../lib/generators";
import {
  edgeTangentFlow,
  flowDoG,
  mergePolylines,
  normalizeContrast,
  thin,
  traceSkeleton,
  type LumImage,
} from "../lib/lineart";
import { orderStrokes } from "./lettering";
import {
  buildDesign,
  DropZone,
  useDebounced,
  ModeButtons,
  PreviewRail,
  RangeRow,
  SectionBox,
  ThreadRow,
  ToolLayout,
  Warning,
  SizeField,
} from "./shared";

// ─── Pure pipeline (image → mm paths) ────────────────────────────────────

export type RedworkOpts = {
  detail?: number; // ETF radius 3–7, default 5 (smaller = finer detail)
  sensitivity?: number; // FDoG tau 0.2–0.9, default 0.5 (higher = more lines)
  sizeMm?: number; // long side, default 110
  minSegMm?: number; // drop specks shorter than this, default 2.5
  stitchLenMm?: number; // default 2.2
};

export function redworkPaths(input: LumImage, opts: RedworkOpts = {}): PathMm[] {
  const detail = Math.round(opts.detail ?? 5);
  const tau = opts.sensitivity ?? 0.5;
  const sizeMm = opts.sizeMm ?? 110;
  const minSegMm = opts.minSegMm ?? 2.5;
  const stitchLen = opts.stitchLenMm ?? 2.2;

  // Contrast-normalize so washed-out or crushed photos present a comparable
  // signal to the edge detector.
  const img = normalizeContrast(input);
  const etf = edgeTangentFlow(img, detail, 2);
  const edges = flowDoG(img, etf, { tau });
  const skel = thin(edges, img.w, img.h);
  const traced = traceSkeleton(skel, img.w, img.h);
  const merged = mergePolylines(traced, 1.6);

  // Pixel → mm scale on the long side, centered.
  const scale = sizeMm / Math.max(img.w, img.h);
  const cx = img.w / 2;
  const cy = img.h / 2;
  const inMm = merged.map((p) =>
    p.map((q) => ({ x: (q.x - cx) * scale, y: (q.y - cy) * scale })),
  );

  // Drop specks, resample, order for minimal travel.
  const len = (p: PathMm) => {
    let L = 0;
    for (let i = 1; i < p.length; i++) L += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
    return L;
  };
  const kept = inMm.filter((p) => len(p) >= minSegMm);
  const sampled = kept.map((p) => resamplePath(p, stitchLen, 0.4)).filter((p) => p.length >= 2);
  return orderStrokes(sampled);
}

// ─── Component ───────────────────────────────────────────────────────────

const NAME = "bayside-redwork";

export default function RedworkTool() {
  const [img, setImg] = useState<LumImage | null>(null);
  const [fileName, setFileName] = useState("");
  const [detail, setDetail] = useState(5);
  const [sensitivity, setSensitivity] = useState(0.5);
  const [minSeg, setMinSeg] = useState(2.5);
  const [sizeMm, setSizeMm] = useState(110);
  const [stitchLen, setStitchLen] = useState(2.2);
  const [bean, setBean] = useState<1 | 3>(3);
  const [threadHex, setThreadHex] = useState(
    THREADS.find((t) => t.family === "Red" && t.hex && !t.isMetallic)?.hex ??
      THREADS.find((t) => t.hex)?.hex ??
      "#8a2020",
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
      const long = 320;
      const scale = long / Math.max(image.width, image.height);
      const w = Math.max(64, Math.round(image.width * scale));
      const h = Math.max(64, Math.round(image.height * scale));
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

  const dDetail = useDebounced(detail);
  const dSens = useDebounced(sensitivity);
  const dMinSeg = useDebounced(minSeg);
  const dSize = useDebounced(sizeMm);
  const paths = useMemo(
    () =>
      img
        ? redworkPaths(img, { detail: dDetail, sensitivity: dSens, sizeMm: dSize, minSegMm: dMinSeg, stitchLenMm: stitchLen })
        : null,
    [img, dDetail, dSens, dSize, dMinSeg, stitchLen],
  );

  const built = useMemo(() => {
    if (!paths || paths.length === 0) return null;
    return buildDesign(pathsToStitches(paths, bean), NAME);
  }, [paths, bean]);

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
            <p className="text-[0.6875rem] text-mid leading-relaxed">
              Clear subjects with strong edges work best - the flow-based filter finds
              coherent lines the way an illustrator would ink them, and drops the
              noise a plain edge detector would keep.
            </p>
          </SectionBox>

          <SectionBox eyebrow="Line extraction">
            <RangeRow label="Detail" value={detail} min={3} max={7} onChange={setDetail} fmt={(v) => (v <= 4 ? `${v} - fine` : v >= 6 ? `${v} - broad` : `${v}`)} />
            <RangeRow label="Line sensitivity" value={sensitivity} min={0.2} max={0.9} step={0.05} onChange={setSensitivity} fmt={(v) => v.toFixed(2)} />
            <RangeRow label="Drop specks under" value={minSeg} min={1} max={8} step={0.5} onChange={setMinSeg} fmt={(v) => `${v.toFixed(1)} mm`} />
          </SectionBox>

          <SectionBox eyebrow="Stitches">
            <SizeField valueMm={sizeMm} min={50} max={330} onChange={setSizeMm} />
            <RangeRow label="Stitch length" value={stitchLen} min={1.5} max={5} step={0.1} onChange={setStitchLen} fmt={(v) => `${v.toFixed(1)} mm`} />
            <div>
              <div className="text-[0.75rem] text-mid mb-1.5">Line weight</div>
              <ModeButtons
                small
                options={[
                  [1, "Run"],
                  [3, "Bean ×3"],
                ]}
                value={bean}
                onChange={setBean}
              />
              <p className="mt-1.5 text-[0.6875rem] text-mid leading-relaxed">
                Traditional redwork uses a bold outline stitch - bean ×3 is the
                machine equivalent.
              </p>
            </div>
            <ThreadRow hex={threadHex} onChange={(hex) => setThreadHex(hex)} />
          </SectionBox>
        </>
      }
      preview={
        <PreviewRail
          built={built}
          colors={[threadHex]}
          name={NAME}
          emptyHint="Drop a photo to ink it in thread."
        >
          {paths && built && (
            <p className="text-[0.75rem] text-mid tabular-nums">
              {paths.length} line{paths.length === 1 ? "" : "s"} after merging ·
              travel-ordered · {built.stats.stitchPathM.toFixed(1)} m of line work
            </p>
          )}
          {img && paths && paths.length === 0 && (
            <Warning>
              No lines survived - raise the sensitivity or lower the speck filter.
            </Warning>
          )}
          {stitchCount > 60000 && (
            <Warning>Over 60k stitches - drop sensitivity or shrink the size.</Warning>
          )}
        </PreviewRail>
      }
    />
  );
}
