// The photo-animation tool factory: image input, live preview with
// play/scrub, shared motion timing, and GIF / video / 300ppi-PNG exports -
// each tool supplies its parameters, its control panel, and a build()
// that turns (image, params) into a resolution-independent draw(ctx, W, t).
// Builds may be async (string art computes for seconds) with progress text.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { DropZone, RangeRow, SectionBox, useIsMobile } from "./shared";
import { encodeGifFit } from "../lib/gif";
import { canvasToPngPpi } from "../lib/png";
import { saveBlob } from "../lib/native";

export const PAPER = "#f7f5f1";

export type LoadedImg = {
  name: string;
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

export type AnimModel = {
  aspect: number; // height / width
  draw: (ctx: CanvasRenderingContext2D, W: number, t: number, fullRes?: boolean) => void;
  /** small caption under the preview, e.g. "1,204 dots" */
  info?: string;
};

export type AnimDef<P extends object> = {
  defaults: P;
  /** may be async; report progress for slow computations */
  build: (img: LoadedImg, p: P, onProgress: (msg: string) => void) => AnimModel | Promise<AnimModel>;
  Controls: (props: { p: P; set: (patch: Partial<P>) => void; img: LoadedImg | null }) => ReactNode;
  emptyHint: string;
};

export function makePhotoAnimTool<P extends object>(def: AnimDef<P>) {
  return function PhotoAnimTool() {
    const mobile = useIsMobile();
    const [img, setImg] = useState<LoadedImg | null>(null);
    const [p, setP] = useState<P>(def.defaults);
    const set = (patch: Partial<P>) => setP((cur) => ({ ...cur, ...patch }));

    const [durationS, setDurationS] = useState(3);
    const [holdS, setHoldS] = useState(1.4);

    const [model, setModel] = useState<AnimModel | null>(null);
    const [building, setBuilding] = useState<string | null>(null);
    const buildTag = useRef(0);

    const [exportPx, setExportPx] = useState(900);
    const [fps, setFps] = useState(24);
    const [transparentOk, setTransparentOk] = useState(false);
    const [stillIn, setStillIn] = useState(8);
    const [busy, setBusy] = useState<string | null>(null);
    const cancelRef = useRef(false);

    const [loadingPhoto, setLoadingPhoto] = useState(false);
    const [photoError, setPhotoError] = useState<string | null>(null);
    const loadFile = async (f: File) => {
      setPhotoError(null);
      setLoadingPhoto(true); // instant feedback — a phone camera photo takes a beat to decode
      try {
        // Phones: a smaller working canvas. Decode + every per-frame pass costs
        // ~2.5x less at 1000px than 1600px — the difference between "the tool
        // froze" and "it just works" when swapping photos on an iPhone.
        const maxSide = mobile ? 1000 : 1600;
        let w = 0;
        let h = 0;
        let source: CanvasImageSource;
        let bitmap: ImageBitmap | null = null;
        if (typeof createImageBitmap === "function") {
          bitmap = await createImageBitmap(f); // decodes off the main thread
          w = bitmap.width;
          h = bitmap.height;
          source = bitmap;
        } else {
          const url = URL.createObjectURL(f);
          try {
            const el = new Image();
            await new Promise<void>((resolve, reject) => {
              el.onload = () => resolve();
              el.onerror = () => reject(new Error("bad image"));
              el.src = url;
            });
            w = el.naturalWidth;
            h = el.naturalHeight;
            source = el;
          } finally {
            URL.revokeObjectURL(url);
          }
        }
        const s = Math.min(1, maxSide / Math.max(w, h));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(w * s));
        c.height = Math.max(1, Math.round(h * s));
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(source, 0, 0, c.width, c.height);
        bitmap?.close();
        setImg({
          name: f.name.replace(/\.[a-z0-9]+$/i, ""),
          width: c.width,
          height: c.height,
          data: ctx.getImageData(0, 0, c.width, c.height).data,
        });
      } catch {
        setPhotoError("Couldn't read that photo - try a different one (JPG, PNG, and phone photos all work).");
      } finally {
        setLoadingPhoto(false);
      }
    };

    // rebuild the model when the image or params change (debounced a beat)
    useEffect(() => {
      if (!img) { setModel(null); return; }
      const tag = ++buildTag.current;
      const timer = setTimeout(async () => {
        try {
          setBuilding("Working…");
          const m = await def.build(img, p, (msg) => {
            if (buildTag.current === tag) setBuilding(msg);
          });
          if (buildTag.current === tag) { setModel(m); setBuilding(null); }
        } catch {
          if (buildTag.current === tag) setBuilding("That combination failed - try different settings.");
        }
      }, 180);
      return () => clearTimeout(timer);
       
    }, [img, p]);

    // preview: play / scrub
    const previewRef = useRef<HTMLCanvasElement>(null);
    const [playing, setPlaying] = useState(true);
    const [scrub, setScrub] = useState(1);
    useEffect(() => {
      const c = previewRef.current;
      if (!c || !model) return;
      const W = Math.min(760, c.parentElement?.clientWidth ?? 640);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = W * dpr;
      c.height = Math.round(W * model.aspect) * dpr;
      c.style.width = `${W}px`;
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      let raf = 0;
      const t0 = performance.now();
      const cycle = Math.max(0.5, durationS + holdS);
      const frame = (now: number) => {
        const t = playing ? (((now - t0) / 1000) % cycle) / durationS : scrub;
        model.draw(ctx, W, t);
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
      return () => cancelAnimationFrame(raf);
    }, [model, playing, scrub, durationS, holdS]);

    const frameCount = () => Math.max(8, Math.round(fps * (durationS + holdS)));
    const timeAt = (i: number, n: number) => ((i / (n - 1)) * (durationS + holdS)) / durationS;

    // Device-safe export dimensions. iOS Safari refuses canvases past ~16.7M px
    // (it silently blanks or throws), so hi-res exports clamp by AREA while
    // keeping the aspect — a 3000px-wide square fits everywhere, an extreme
    // panorama gets capped instead of failing. Stills get the full budget
    // (one canvas, one frame); ANIMATED exports on phones get a tighter one,
    // because N frames × per-tool layer caches multiply the memory.
    const exportDims = (wantW: number, kind: "still" | "anim" = "anim") => {
      const aspect = model?.aspect ?? 1;
      const maxArea = !mobile ? 32_000_000 : kind === "still" ? 12_000_000 : 6_000_000;
      const areaW = Math.floor(Math.sqrt(maxArea / Math.max(aspect, 0.0001)));
      const W = Math.max(64, Math.min(wantW, areaW));
      return { W, H: Math.round(W * aspect), clamped: W < wantW };
    };

    const exportGif = async () => {
      if (!model || busy) return;
      setBusy("Rendering GIF…");
      cancelRef.current = false;
      try {
        const { W, H } = exportDims(exportPx);
        const c = document.createElement("canvas");
        c.width = W; c.height = H;
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        const n = frameCount();
        const { bytes, note } = await encodeGifFit(
          (i) => { model.draw(ctx, W, timeAt(i, n)); return c; },
          c.width, c.height, n, Math.round(1000 / fps), transparentOk,
          null, (m) => setBusy(m), () => cancelRef.current
        );
        await saveBlob(new Blob([bytes as BlobPart], { type: "image/gif" }), `${img?.name ?? "photo"}-anim.gif`);
        if (note) setBusy(note);
      } catch { setBusy("GIF export failed - try a smaller size."); }
      setTimeout(() => setBusy(null), 1400);
    };

    const exportVideo = async () => {
      if (!model || busy) return;
      setBusy("Recording video…");
      try {
        const { W, H } = exportDims(exportPx);
        const c = document.createElement("canvas");
        c.width = W; c.height = H;
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        model.draw(ctx, W, 0);
        const stream = c.captureStream(fps);
        const mime = MediaRecorder.isTypeSupported("video/mp4") ? "video/mp4" : "video/webm";
        // scale the bitrate with the pixel count so 3000px video doesn't smear
        const bitrate = Math.min(40_000_000, Math.round(8_000_000 * Math.max(1, (W * H) / (900 * 900))));
        const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
        const chunks: Blob[] = [];
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        const done = new Promise<void>((res) => { rec.onstop = () => res(); });
        rec.start();
        const n = frameCount();
        for (let i = 0; i < n; i++) {
          model.draw(ctx, W, timeAt(i, n));
          await new Promise((r) => setTimeout(r, 1000 / fps));
        }
        rec.stop();
        await done;
        await saveBlob(new Blob(chunks, { type: mime }), `${img?.name ?? "photo"}-anim.${mime.includes("mp4") ? "mp4" : "webm"}`);
      } catch { setBusy("Video export failed on this browser."); }
      setTimeout(() => setBusy(null), 1400);
    };

    const exportStill = async () => {
      if (!model || busy) return;
      setBusy("Rendering 300ppi still…");
      try {
        // Always true 300ppi: if the device canvas cap shrinks the pixel size,
        // the physical print size shrinks with it — the density never lies.
        const { W, H, clamped } = exportDims(Math.round(stillIn * 300), "still");
        const c = document.createElement("canvas");
        c.width = W; c.height = H;
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        model.draw(ctx, W, 10, true);
        const blob = await canvasToPngPpi(c, 300);
        const inches = (W / 300).toFixed(1).replace(/\.0$/, "");
        await saveBlob(blob, `${img?.name ?? "photo"}-${inches}in-300ppi.png`);
        if (clamped) setBusy(`Device cap: exported ${inches}" wide - still true 300ppi.`);
      } catch { setBusy("Still export failed - try a smaller size."); }
      setTimeout(() => setBusy(null), 1400);
    };

    // sr-only, NOT hidden/display:none — iOS Safari won't open the file picker
    // for a display:none input tapped via its label. value reset lets the same
    // file be re-picked.
    const fileInput = (
      <input
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void loadFile(f);
        }}
      />
    );

    const controls = (
      <div className="space-y-2.5">
        <SectionBox eyebrow="Photo">
          {mobile ? (
            // Phones can't drag-and-drop: one big obvious button, no drop copy.
            <label className="block w-full border border-fg bg-fg text-bg px-4 py-3.5 text-center text-[0.9375rem] cursor-pointer active:opacity-80 select-none">
              {loadingPhoto ? "Loading photo…" : img ? "↻ Swap photo" : "Choose a photo"}
              {fileInput}
            </label>
          ) : (
            <DropZone onFile={(f) => void loadFile(f)} className="block">
              <label className="block border border-dashed border-hairline px-3 py-3 text-center text-[0.8125rem] text-mid cursor-pointer hover:border-fg">
                {loadingPhoto
                  ? "Loading photo…"
                  : img
                    ? `${img.name} - drop another to swap`
                    : "Drop a photo, or click to choose"}
                {fileInput}
              </label>
            </DropZone>
          )}
          {img && mobile ? (
            <p className="text-[0.6875rem] text-mid truncate">{img.name}</p>
          ) : null}
          {photoError ? (
            <p className="text-[0.75rem] text-red-700">{photoError}</p>
          ) : null}
        </SectionBox>

        {def.Controls({ p, set, img })}

        <SectionBox eyebrow="Motion">
          <RangeRow label="Duration" value={durationS} min={1} max={10} step={0.5} onChange={setDurationS} fmt={(v) => `${v}s`} />
          <RangeRow label="Hold" value={holdS} min={0} max={5} step={0.2} onChange={setHoldS} fmt={(v) => `${v}s`} />
        </SectionBox>

        <SectionBox eyebrow="Export">
          <RangeRow label="Export size" value={exportPx} min={480} max={3000} step={20} onChange={setExportPx} fmt={(v) => `${v}px`} />
          <RangeRow label="FPS" value={fps} min={12} max={30} step={2} onChange={setFps} />
          <label className="flex items-center gap-2 text-[0.75rem] text-mid cursor-pointer">
            <input type="checkbox" checked={transparentOk} onChange={(e) => setTransparentOk(e.target.checked)} className="accent-fg" />
            Transparent GIF (when the tool draws no background)
          </label>
          <div className="flex flex-wrap gap-1.5">
            <button onClick={() => void exportGif()} disabled={!model || !!busy} className="border border-fg bg-fg text-bg px-3 py-1.5 text-[0.75rem] disabled:opacity-40">GIF</button>
            <button onClick={() => void exportVideo()} disabled={!model || !!busy} className="border border-fg px-3 py-1.5 text-[0.75rem] hover:bg-fg hover:text-bg disabled:opacity-40">Video</button>
            <button onClick={() => void exportStill()} disabled={!model || !!busy} className="border border-fg px-3 py-1.5 text-[0.75rem] hover:bg-fg hover:text-bg disabled:opacity-40">PNG 300ppi</button>
          </div>
          <RangeRow label="Still width" value={stillIn} min={3} max={16} step={1} onChange={setStillIn} fmt={(v) => `${v}" · ${v * 300}px`} />
          {busy && <div className="text-[0.75rem] text-mid">{busy}</div>}
        </SectionBox>
      </div>
    );

    const preview = (
      <div className="space-y-2">
        <div className="border border-hairline bg-card flex items-center justify-center min-h-[280px] p-2 relative">
          {img && model ? (
            <canvas ref={previewRef} />
          ) : loadingPhoto ? (
            <div className="text-[0.875rem] text-mid py-20 text-center px-6">Loading photo…</div>
          ) : img && building ? (
            <div className="text-[0.875rem] text-mid py-20 text-center px-6">{building}</div>
          ) : (
            <div className="text-[0.875rem] text-mid py-20 text-center px-6">
              {mobile
                ? def.emptyHint.replace(/^Drop a photo/, "Choose a photo below")
                : def.emptyHint}
            </div>
          )}
          {img && model && building ? (
            <div className="absolute top-2 right-2 bg-bg/90 border border-hairline px-2 py-1 text-[0.6875rem] text-mid">{building}</div>
          ) : null}
        </div>
        {img && model && (
          <div className="flex items-center gap-2.5">
            <button onClick={() => setPlaying((v) => !v)} className="border border-hairline px-3 py-1.5 text-[0.75rem] hover:border-fg">
              {playing ? "Pause" : "Play"}
            </button>
            <input
              type="range" min={0} max={1} step={0.005} value={scrub}
              onChange={(e) => { setPlaying(false); setScrub(Number(e.target.value)); }}
              aria-label="Scrub the animation" className="flex-1 accent-fg"
            />
            {model.info && <span className="text-[0.6875rem] text-mid tabular-nums whitespace-nowrap">{model.info}</span>}
          </div>
        )}
      </div>
    );

    if (mobile) return <div className="space-y-4">{preview}{controls}</div>;
    return (
      <div className="grid gap-5 lg:grid-cols-[340px_1fr]">
        <div className="min-w-0">{controls}</div>
        <div className="min-w-0"><div className="lg:sticky lg:top-4">{preview}</div></div>
      </div>
    );
  };
}

export const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
export const hexToRgb = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
