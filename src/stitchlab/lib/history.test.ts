import { describe, expect, it } from "vitest";
import { canRedo, canUndo, createHistory, push, redo, replace, undo } from "./history";

describe("history", () => {
  it("push/undo/redo round trip", () => {
    let h = createHistory(1);
    h = push(h, 2);
    h = push(h, 3);
    expect(h.present).toBe(3);
    h = undo(h);
    expect(h.present).toBe(2);
    expect(canRedo(h)).toBe(true);
    h = redo(h);
    expect(h.present).toBe(3);
    expect(canRedo(h)).toBe(false);
  });

  it("push clears the redo stack", () => {
    let h = push(push(createHistory(1), 2), 3);
    h = undo(h);
    h = push(h, 9);
    expect(canRedo(h)).toBe(false);
    expect(undo(h).present).toBe(2);
  });

  it("replace updates present without an undo step (mid-gesture)", () => {
    let h = push(createHistory(1), 2);
    h = replace(h, 99);
    expect(h.present).toBe(99);
    h = undo(h);
    expect(h.present).toBe(1); // gesture start, not intermediate values
  });

  it("undo at the floor and redo at the ceiling are no-ops", () => {
    const h = createHistory(1);
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
    expect(canUndo(h)).toBe(false);
  });

  it("respects the history limit", () => {
    let h = createHistory(0);
    for (let i = 1; i <= 150; i++) h = push(h, i, 100);
    expect(h.past.length).toBe(100);
    expect(h.present).toBe(150);
  });
});
