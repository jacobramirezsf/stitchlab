// Shatter - the photo itself, broken into Voronoi mosaic shards that fly
// into place (or blow apart). Full color: this one keeps the photograph.

import { makePhotoAnimTool, easeOut, type LoadedImg } from "./photoAnim";
import { ModeButtons, RangeRow, SectionBox } from "./shared";
import { rng, voronoiCells } from "../lib/interpret";

type P = {
  pieces: number;
  spread: number; // how far shards travel
  spin: number;
  direction: "in" | "out";
  order: "radial" | "shuffle" | "sweep";
  bg: "black" | "paper" | "white" | "transparent";
  seed: number;
};

export default makePhotoAnimTool<P>({
  defaults: { pieces: 120, spread: 0.6, spin: 0.5, direction: "in", order: "radial", bg: "black", seed: 7 },
  emptyHint: "Drop a photo - it shatters into mosaic shards, or assembles out of them.",
  build(img: LoadedImg, p) {
    const aspect = img.height / img.width;
    const cells = voronoiCells(p.pieces, aspect, p.seed);
    // the source photo as a drawable canvas
    const src = document.createElement("canvas");
    src.width = img.width; src.height = img.height;
    src.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    // per-shard flight vector + timing
    const rand = rng(p.seed * 7 + 1);
    const shards = cells.map((cell) => {
      const [cx, cy] = cell.seed;
      const outward = Math.atan2(cy - aspect / 2, cx - 0.5) + (rand() - 0.5) * 0.8;
      const dist = (0.4 + rand() * 0.8) * p.spread;
      const key =
        p.order === "radial" ? Math.hypot(cx - 0.5, cy - aspect / 2)
        : p.order === "sweep" ? cx + cy * 0.2
        : rand();
      return {
        cell,
        dx: Math.cos(outward) * dist,
        dy: Math.sin(outward) * dist,
        rot: (rand() - 0.5) * p.spin * 1.6,
        key,
      };
    });
    shards.sort((a, b) => a.key - b.key);
    const n = Math.max(1, shards.length - 1);
    const timed = shards.map((s, i) => ({ ...s, t0: (i / n) * 0.7 }));
    return {
      aspect,
      info: `${cells.length} shards`,
      draw(ctx, W, t) {
        const H = Math.round(W * aspect);
        ctx.clearRect(0, 0, W, H);
        if (p.bg !== "transparent") {
          ctx.fillStyle = p.bg === "black" ? "#0b0b10" : p.bg === "paper" ? "#f7f5f1" : "#ffffff";
          ctx.fillRect(0, 0, W, H);
        }
        const at = Math.min(1, t);
        for (const s of timed) {
          // progress of THIS shard within its stagger window
          let local = Math.max(0, Math.min(1, (at - s.t0) / 0.3));
          local = easeOut(local);
          const fly = p.direction === "in" ? 1 - local : local;
          if (p.direction === "out" && fly >= 1) continue;
          if (p.direction === "in" && local <= 0 && at < 1) continue;
          const [cx, cy] = s.cell.seed;
          ctx.save();
          ctx.translate((cx + s.dx * fly) * W, ((cy + s.dy * fly) / aspect) * H);
          ctx.rotate(s.rot * fly);
          ctx.translate(-cx * W, (-cy / aspect) * H);
          ctx.beginPath();
          s.cell.poly.forEach(([x, y], i) => {
            const X = x * W, Y = (y / aspect) * H;
            if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
          });
          ctx.closePath();
          ctx.clip();
          ctx.drawImage(src, 0, 0, W, H);
          ctx.restore();
        }
      },
    };
  },
  Controls({ p, set }) {
    return (
      <>
        <SectionBox eyebrow="Shatter">
          <RangeRow label="Pieces" value={p.pieces} min={20} max={400} step={10} onChange={(v) => set({ pieces: v })} />
          <RangeRow label="Spread" value={p.spread} min={0.1} max={1.5} step={0.05} onChange={(v) => set({ spread: v })} fmt={(v) => v.toFixed(2)} />
          <RangeRow label="Spin" value={p.spin} min={0} max={1.5} step={0.05} onChange={(v) => set({ spin: v })} fmt={(v) => v.toFixed(2)} />
          <RangeRow label="Seed" value={p.seed} min={1} max={99} step={1} onChange={(v) => set({ seed: v })} />
          <ModeButtons
            options={[["in", "Assemble in"], ["out", "Blow apart"]] as const}
            value={p.direction} onChange={(v) => set({ direction: v })} small
          />
          <ModeButtons
            options={[["radial", "From center"], ["sweep", "Sweep"], ["shuffle", "Shuffle"]] as const}
            value={p.order} onChange={(v) => set({ order: v })} small
          />
          <ModeButtons
            options={[["black", "Black"], ["paper", "Paper"], ["white", "White"], ["transparent", "Clear"]] as const}
            value={p.bg} onChange={(v) => set({ bg: v })} small
          />
        </SectionBox>
      </>
    );
  },
});
