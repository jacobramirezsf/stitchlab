// String Art - the Vrellis-style greedy algorithm: pins around a frame,
// one continuous thread, each chord chosen to remove the most remaining
// darkness. The animation is the thread being wound, chord by chord -
// and the sequence is real: you could follow it on a physical board.

import { makePhotoAnimTool, PAPER, type LoadedImg } from "./photoAnim";
import { ModeButtons, RangeRow, SectionBox } from "./shared";
import { luminanceGrid, stringChords } from "../lib/interpret";

type P = {
  pins: number; lines: number; opacity: number;
  frame: "circle" | "rect";
  thread: string;
  invert: boolean;
  showPins: boolean;
};

export default makePhotoAnimTool<P>({
  defaults: { pins: 200, lines: 900, opacity: 0.18, frame: "circle", thread: "#26324d", invert: false, showPins: true },
  emptyHint: "Drop a photo - one continuous thread winds between pins until the picture appears. Faces work beautifully.",
  async build(img: LoadedImg, p, onProgress) {
    const like = { data: img.data, width: img.width, height: img.height };
    const lum = luminanceGrid(like, 160);
    const result = await stringChords(lum, {
      pins: p.pins,
      lines: p.lines,
      opacity: p.opacity,
      invert: p.invert,
      frame: p.frame,
      onProgress: (done, total) => onProgress(`Winding thread… ${done}/${total}`),
      yieldFn: () => new Promise((r) => setTimeout(r, 0)),
    });
    const aspect = img.height / img.width;
    const seq = result.sequence;
    return {
      aspect,
      info: `${p.pins} pins · ${seq.length.toLocaleString()} chords`,
      draw(ctx, W, t) {
        const H = Math.round(W * aspect);
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = PAPER;
        ctx.fillRect(0, 0, W, H);
        const sx = W / lum.cols, sy = H / lum.rows;
        if (p.showPins) {
          ctx.fillStyle = "#00000030";
          for (let i = 0; i < p.pins; i++) {
            ctx.beginPath();
            ctx.arc(result.pins[i * 2] * sx, result.pins[i * 2 + 1] * sy, Math.max(1, W / 700), 0, Math.PI * 2);
            ctx.fill();
          }
        }
        const at = Math.min(1, t);
        const upTo = Math.max(1, Math.round(seq.length * at));
        ctx.strokeStyle = p.thread;
        ctx.globalAlpha = Math.min(0.9, p.opacity * 2.4);
        ctx.lineWidth = Math.max(0.4, W / 1400);
        ctx.beginPath();
        ctx.moveTo(result.pins[0] * sx, result.pins[1] * sy);
        for (let i = 0; i < upTo; i++) {
          const pin = seq[i];
          ctx.lineTo(result.pins[pin * 2] * sx, result.pins[pin * 2 + 1] * sy);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      },
    };
  },
  Controls({ p, set }) {
    return (
      <>
        <SectionBox eyebrow="Thread">
          <RangeRow label="Pins" value={p.pins} min={80} max={300} step={10} onChange={(v) => set({ pins: v })} />
          <RangeRow label="Chords" value={p.lines} min={200} max={2000} step={50} onChange={(v) => set({ lines: v })} />
          <RangeRow label="Thread ink" value={p.opacity} min={0.06} max={0.4} step={0.02} onChange={(v) => set({ opacity: v })} fmt={(v) => v.toFixed(2)} />
          <ModeButtons
            options={[["circle", "Round board"], ["rect", "Square board"]] as const}
            value={p.frame} onChange={(v) => set({ frame: v })} small
          />
          <div className="flex items-center gap-2 text-[0.75rem] text-mid">
            Thread
            <input type="color" value={p.thread} onChange={(e) => set({ thread: e.target.value })} aria-label="Thread color" className="w-8 h-8 border border-hairline cursor-pointer" />
          </div>
          <label className="flex items-center gap-2 text-[0.75rem] text-mid cursor-pointer">
            <input type="checkbox" checked={p.showPins} onChange={(e) => set({ showPins: e.target.checked })} className="accent-fg" />
            Show the pins
          </label>
          <label className="flex items-center gap-2 text-[0.75rem] text-mid cursor-pointer">
            <input type="checkbox" checked={p.invert} onChange={(e) => set({ invert: e.target.checked })} className="accent-fg" />
            Light subject on dark photo
          </label>
          <p className="text-[0.6875rem] text-dim leading-snug">
            The chord order is a real winding sequence - a physical board with
            the same pins could follow it thread-for-thread.
          </p>
        </SectionBox>
      </>
    );
  },
});
