import { describe, expect, it } from "vitest";
import { estimateProject } from "./pricing";

// The estimate feeds the composer ballpark and the inquiry summary. These lock
// down the customer-visible behavior: the minimum floor, the volume discount
// tiers, placement scaling, setup fees, and input coercion.

describe("estimateProject", () => {
  it("floors the total at the sourced-garment minimum ($500) for tiny orders", () => {
    const e = estimateProject({ complexity: "small", quantity: 1 });
    expect(e.minimum).toBe(500);
    expect(e.totalRange[0]).toBeGreaterThanOrEqual(500);
    expect(e.totalRange[1]).toBeGreaterThanOrEqual(500);
    expect(e.belowMinimum).toBe(true);
    expect(e.sourced).toBe(true);
  });

  it("uses the lower $300 minimum when the client provides garments", () => {
    const e = estimateProject({ complexity: "small", quantity: 1, sourced: false });
    expect(e.minimum).toBe(300);
    expect(e.totalRange[0]).toBeGreaterThanOrEqual(300);
  });

  it("applies volume discounts at 10 / 25 / 50 piece tiers", () => {
    expect(estimateProject({ complexity: "small", quantity: 5 }).discountPercent).toBe(0);
    expect(estimateProject({ complexity: "small", quantity: 10 }).discountPercent).toBe(10);
    expect(estimateProject({ complexity: "small", quantity: 25 }).discountPercent).toBe(15);
    expect(estimateProject({ complexity: "small", quantity: 50 }).discountPercent).toBe(20);
  });

  it("scales embroidery cost by number of placements", () => {
    const one = estimateProject({ complexity: "medium", quantity: 100, placements: 1 });
    const two = estimateProject({ complexity: "medium", quantity: 100, placements: 2 });
    expect(two.embroideryPerPiece[0]).toBe(one.embroideryPerPiece[0] * 2);
    expect(two.embroideryPerPiece[1]).toBe(one.embroideryPerPiece[1] * 2);
  });

  it("sets the one-time setup fee from artwork readiness", () => {
    expect(estimateProject({ complexity: "small", quantity: 1, artwork: "ready" }).setupFee).toEqual([75, 150]);
    expect(estimateProject({ complexity: "small", quantity: 1, artwork: "adapt" }).setupFee).toEqual([150, 300]);
    expect(estimateProject({ complexity: "small", quantity: 1, artwork: "original" }).setupFee).toEqual([300, 750]);
  });

  it("is not below minimum once volume is high enough", () => {
    const e = estimateProject({ complexity: "large", quantity: 100 });
    expect(e.belowMinimum).toBe(false);
    // total is the natural production+setup, above the floor
    expect(e.totalRange[1]).toBe(e.naturalRange[1]);
    expect(e.totalRange[1]).toBeGreaterThan(e.minimum);
  });

  it("coerces bad quantity/placements to at least 1 (no NaN / negatives)", () => {
    const e = estimateProject({ complexity: "small", quantity: 0, placements: -3 });
    expect(e.quantity).toBe(1);
    expect(e.placements).toBe(1);
    expect(Number.isFinite(e.totalRange[0])).toBe(true);
    expect(Number.isFinite(e.totalRange[1])).toBe(true);
  });

  it("keeps range ordering: low <= high everywhere", () => {
    for (const complexity of ["small", "medium", "large"] as const) {
      for (const quantity of [1, 12, 30, 80]) {
        const e = estimateProject({ complexity, quantity });
        expect(e.perPieceRange[0]).toBeLessThanOrEqual(e.perPieceRange[1]);
        expect(e.productionRange[0]).toBeLessThanOrEqual(e.productionRange[1]);
        expect(e.totalRange[0]).toBeLessThanOrEqual(e.totalRange[1]);
      }
    }
  });

  it("adds a known blank cost into per-piece pricing", () => {
    const noBlank = estimateProject({ complexity: "small", quantity: 100 });
    const withBlank = estimateProject({ complexity: "small", quantity: 100, blankCost: 12 });
    expect(withBlank.perPieceRange[0]).toBe(noBlank.perPieceRange[0] + 12);
  });
});
