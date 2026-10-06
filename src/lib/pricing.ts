// Bayside. Pricing engine.
// TODO: confirm pricing assumptions with Jacob (ranges below are internal
// guides used only to produce an honest ballpark, never shown as a final quote).

import type { Garment } from "../data/garments";
import type { ConfigState, DesignSize } from "../components/BlanksVisualizer.types";

export type PriceBreakdown = {
  garmentCost: number;
  embroideryRange: [number, number]; // sum across active designs, per piece
  quantity: number;
  discountPercent: number;
  perPieceRange: [number, number];
  totalRange: [number, number];
};

const EMBROIDERY_RANGES: Record<DesignSize, [number, number]> = {
  small: [12, 18],
  medium: [18, 28],
  large: [28, 45],
};

function quantityDiscount(qty: number): number {
  if (qty >= 50) return 0.2;
  if (qty >= 25) return 0.15;
  if (qty >= 10) return 0.1;
  return 0;
}

// ─── Ballpark estimate for the composer + inquiry summary ────────────────
// Honest ballpark from real ranges: per-piece embroidery production × quantity,
// plus a one-time setup/design file fee, floored at the project minimum. Blank
// cost is only added when we actually have a price (most blanks are still 0).

// Per-piece embroidery production by composer complexity bucket (per placement).
const EMBROIDERY_PER_PIECE: Record<DesignSize, [number, number]> = {
  small: [20, 35], // small logo, roughly under 6k stitches
  medium: [35, 55], // medium chest, ~6k–15k
  large: [85, 160], // large/dense back or illustration, 30k+
};

// One-time setup / design file fee, by how ready the artwork is.
export type ArtworkReadiness = "ready" | "adapt" | "original";
const SETUP_FEE: Record<ArtworkReadiness, [number, number]> = {
  ready: [75, 150], // clean supplied logo
  adapt: [150, 300], // artwork cleanup / adaptation / layout
  original: [300, 750], // custom concept / original artwork
};

// Project minimums.
const MIN_PROVIDED_GARMENT = 300;
const MIN_SOURCED_GARMENT = 500;

export type Estimate = {
  complexity: DesignSize;
  quantity: number;
  placements: number;
  sourced: boolean;
  discountPercent: number;
  blankCost: number; // 0 when unknown
  embroideryPerPiece: [number, number]; // per piece, all placements, post-discount
  perPieceRange: [number, number]; // garment + embroidery per piece
  productionRange: [number, number]; // per piece × quantity
  setupFee: [number, number]; // one-time
  minimum: number;
  totalRange: [number, number]; // max(production + setup, minimum)
  naturalRange: [number, number]; // production + setup, before the minimum floor
  belowMinimum: boolean; // true when even the top of the estimate is under the minimum
  quantityForMinimum: number; // ~pieces needed for the estimate to reach the minimum
};

export function estimateProject(args: {
  complexity: DesignSize;
  quantity: number;
  blankCost?: number;
  sourced?: boolean; // Bayside sources the blank (default true)
  placements?: number; // number of embroidery placements (default 1)
  artwork?: ArtworkReadiness; // drives setup fee (default "adapt")
}): Estimate {
  const quantity = Math.max(1, Math.floor(args.quantity) || 1);
  const placements = Math.max(1, Math.floor(args.placements ?? 1) || 1);
  const sourced = args.sourced ?? true;
  const artwork = args.artwork ?? "adapt";
  const blankCost = args.blankCost && args.blankCost > 0 ? args.blankCost : 0;

  const [embLo, embHi] = EMBROIDERY_PER_PIECE[args.complexity];
  const discount = quantityDiscount(quantity);
  const embPerPieceLo = embLo * placements * (1 - discount);
  const embPerPieceHi = embHi * placements * (1 - discount);

  const perLo = blankCost + embPerPieceLo;
  const perHi = blankCost + embPerPieceHi;
  const prodLo = perLo * quantity;
  const prodHi = perHi * quantity;

  const [setupLo, setupHi] = SETUP_FEE[artwork];
  const minimum = sourced ? MIN_SOURCED_GARMENT : MIN_PROVIDED_GARMENT;

  // Is the minimum the binding floor (even the top of the estimate is under it)?
  const belowMinimum = prodHi + setupHi < minimum;
  // Roughly how many pieces would bring the estimate up to the minimum.
  const quantityForMinimum = Math.max(
    1,
    Math.ceil((minimum - setupHi) / Math.max(1, perHi))
  );

  const round = (n: number) => Math.round(n);
  return {
    complexity: args.complexity,
    quantity,
    placements,
    sourced,
    discountPercent: discount * 100,
    blankCost,
    embroideryPerPiece: [round(embPerPieceLo), round(embPerPieceHi)],
    perPieceRange: [round(perLo), round(perHi)],
    productionRange: [round(prodLo), round(prodHi)],
    setupFee: [setupLo, setupHi],
    minimum,
    totalRange: [
      Math.max(round(prodLo + setupLo), minimum),
      Math.max(round(prodHi + setupHi), minimum),
    ],
    naturalRange: [round(prodLo + setupLo), round(prodHi + setupHi)],
    belowMinimum,
    quantityForMinimum,
  };
}

export function computePrice(
  state: ConfigState,
  garment: Garment
): PriceBreakdown {
  const activeDesigns = Object.values(state.designs).filter(
    (d): d is NonNullable<typeof d> => !!d && d.text.trim() !== ""
  );

  let embLow = 0;
  let embHigh = 0;
  for (const d of activeDesigns) {
    const [lo, hi] = EMBROIDERY_RANGES[d.size];
    embLow += lo;
    embHigh += hi;
  }

  const discount = quantityDiscount(state.quantity);
  const adjustedEmbLow = embLow * (1 - discount);
  const adjustedEmbHigh = embHigh * (1 - discount);

  const perPieceLow = garment.blankCost + adjustedEmbLow;
  const perPieceHigh = garment.blankCost + adjustedEmbHigh;

  return {
    garmentCost: garment.blankCost,
    embroideryRange: [embLow, embHigh],
    quantity: state.quantity,
    discountPercent: discount * 100,
    perPieceRange: [perPieceLow, perPieceHigh],
    totalRange: [perPieceLow * state.quantity, perPieceHigh * state.quantity],
  };
}
