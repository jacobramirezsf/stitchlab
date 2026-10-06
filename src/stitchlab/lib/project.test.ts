import { describe, expect, it } from "vitest";
import {
  PROJECT_SCHEMA_VERSION,
  newProject,
  migrateProject,
  serializeProject,
  deserializeProject,
  transformStitches,
  composeProject,
  elementBoundsMm,
  type GeneratedElement,
  type Project,
} from "./project";
import { CMD, type Stitch } from "./pattern";

const st = (x: number, y: number, cmd: number = CMD.STITCH): Stitch => ({ x, y, cmd: cmd as Stitch["cmd"] });

const genEl = (over: Partial<GeneratedElement> = {}): GeneratedElement => ({
  id: "el1",
  name: "Truchet",
  kind: "generated",
  tool: "truchet",
  params: { seed: 7, grid: 8 },
  colors: ["#26324d"],
  transform: { xMm: 0, yMm: 0, rotDeg: 0 },
  sizeMm: 120,
  hidden: false,
  locked: false,
  ...over,
});

describe("project serialization + migration", () => {
  it("round-trips a project losslessly", () => {
    const p = newProject("Test");
    p.elements.push(genEl());
    p.favorite = true;
    p.collection = "Fall ideas";
    const back = deserializeProject(serializeProject(p));
    expect(back).toEqual(p);
  });

  it("fills defaults for missing fields (pre-versioned blobs)", () => {
    const p = migrateProject({ name: "Old", elements: [] });
    expect(p.schema).toBe(PROJECT_SCHEMA_VERSION);
    expect(p.id).toBeTruthy();
    expect(p.hoop.wMm).toBeGreaterThan(0);
    expect(p.rev).toBe(0);
  });

  it("drops corrupt elements instead of crashing", () => {
    const p = migrateProject({
      elements: [genEl(), { kind: "generated" /* missing tool */ }, null, { kind: "mystery" }],
    });
    expect(p.elements).toHaveLength(1);
    expect(p.elements[0].kind).toBe("generated");
  });

  it("keeps generator params, seed, and colors through storage", () => {
    const p = newProject();
    p.elements.push(genEl({ sizeMm: 90, params: { seed: 42, detail: 900 }, colors: ["#aa0000", "#00aa00"] }));
    const back = deserializeProject(serializeProject(p));
    const el = back.elements[0] as GeneratedElement;
    expect(el.params.seed).toBe(42);
    expect(el.sizeMm).toBe(90);
    expect(el.colors).toEqual(["#aa0000", "#00aa00"]);
  });

  it("refuses blobs from a NEWER schema rather than lossily rewriting", () => {
    expect(() => migrateProject({ schema: PROJECT_SCHEMA_VERSION + 1 })).toThrow(/newer/);
  });

  it("keeps reference images referenceOnly through migration", () => {
    const p = migrateProject({
      elements: [{ kind: "image", dataUrl: "data:image/png;base64,x", aspect: 1.33, referenceOnly: false }],
    });
    expect(p.elements[0]).toMatchObject({ kind: "image", referenceOnly: true });
  });
});

describe("transformStitches", () => {
  it("translates without changing stitch lengths", () => {
    const out = transformStitches([st(0, 0), st(100, 0)], { xMm: 5, yMm: -3, rotDeg: 0 });
    expect(out[0]).toMatchObject({ x: 50, y: -30 });
    expect(out[1].x - out[0].x).toBeCloseTo(100);
  });

  it("rotates 90deg preserving length", () => {
    const out = transformStitches([st(0, 0), st(100, 0)], { xMm: 0, yMm: 0, rotDeg: 90 });
    expect(out[1].x).toBeCloseTo(0, 5);
    expect(out[1].y).toBeCloseTo(100, 5);
    const len = Math.hypot(out[1].x - out[0].x, out[1].y - out[0].y);
    expect(len).toBeCloseTo(100);
  });

  it("applies uniform scale only when asked (stitch-file path)", () => {
    const out = transformStitches([st(0, 0), st(100, 0)], { xMm: 0, yMm: 0, rotDeg: 0 }, 1.1);
    expect(out[1].x - out[0].x).toBeCloseTo(110);
  });
});

describe("composeProject", () => {
  const builtA = { elementId: "a", stitches: [st(0, 0, CMD.JUMP), st(0, 0), st(100, 0)], colors: ["#111111"] };
  const builtB = { elementId: "b", stitches: [st(0, 0, CMD.JUMP), st(0, 0), st(0, 100)], colors: ["#222222"] };

  const proj = (): Project => {
    const p = newProject();
    p.elements = [
      genEl({ id: "a" }),
      genEl({ id: "b", transform: { xMm: 10, yMm: 0, rotDeg: 0 } }),
    ];
    return p;
  };

  it("joins elements in order with COLOR_CHANGE between blocks and one END", () => {
    const c = composeProject(proj(), new Map([["a", builtA], ["b", builtB]]));
    expect(c.colors).toEqual(["#111111", "#222222"]);
    const cmds = c.stitches.map((s) => s.cmd);
    expect(cmds.filter((x) => x === CMD.COLOR_CHANGE)).toHaveLength(1);
    expect(cmds.filter((x) => x === CMD.END)).toHaveLength(1);
    expect(cmds[cmds.length - 1]).toBe(CMD.END);
    // element b translated +10mm = +100 units
    const bStitches = c.stitches.filter((s) => s.cmd === CMD.STITCH).slice(2);
    expect(bStitches[0].x).toBeCloseTo(100);
  });

  it("skips hidden elements and reference images", () => {
    const p = proj();
    p.elements[0].hidden = true;
    p.elements.push({
      id: "img",
      name: "ref",
      kind: "image",
      dataUrl: "data:,x",
      aspect: 1,
      referenceOnly: true,
      transform: { xMm: 0, yMm: 0, rotDeg: 0 },
      sizeMm: 10,
      hidden: false,
      locked: false,
    });
    const c = composeProject(p, new Map([["a", builtA], ["b", builtB]]));
    expect(c.colors).toEqual(["#222222"]);
    expect(c.blocks.every((b) => b.elementId === "b")).toBe(true);
  });

  it("reordering elements changes sew order", () => {
    const p = proj();
    p.elements.reverse();
    const c = composeProject(p, new Map([["a", builtA], ["b", builtB]]));
    expect(c.colors).toEqual(["#222222", "#111111"]);
  });

  it("preserves multi-block elements' internal color count", () => {
    const multi = {
      elementId: "a",
      stitches: [st(0, 0), st(50, 0), st(50, 0, CMD.COLOR_CHANGE), st(50, 50), st(0, 50)],
      colors: ["#111111", "#333333"],
    };
    const p = proj();
    p.elements = [p.elements[0]];
    const c = composeProject(p, new Map([["a", multi]]));
    expect(c.colors).toEqual(["#111111", "#333333"]);
  });
});

describe("elementBoundsMm", () => {
  it("measures transformed bounds in mm", () => {
    const b = elementBoundsMm([st(-50, -50), st(50, 50)], { xMm: 10, yMm: 0, rotDeg: 0 });
    expect(b).not.toBeNull();
    expect(b!.w).toBeCloseTo(10);
    expect(b!.h).toBeCloseTo(10);
    expect(b!.x).toBeCloseTo(5); // -5mm + 10mm offset
  });
});
