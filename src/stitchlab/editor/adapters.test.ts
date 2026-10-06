// Adapter-level guarantees: deterministic generation (same params + seed →
// identical geometry), param spec sanity (defaults on the step grid), and
// composed export integrity (project → compose → real DST bytes → re-parse).
import { describe, expect, it } from "vitest";
import { ADAPTERS, ADAPTER_LIST, defaultParams } from "./adapters";
import { composeProject, newProject, type GeneratedElement } from "../lib/project";
import { pathGroupsToStitches, resamplePath, routeStrokes } from "../lib/generators";
import { placePaths } from "./geometry";
import { writeDst, parseDst } from "../lib/dst";
import { CMD } from "../lib/pattern";

describe("adapters", () => {
  it("registry has the core entry points", () => {
    for (const id of ["lettering", "oneline", "hatchtone", "halftone", "imagepack", "truchet"]) {
      expect(ADAPTERS[id], id).toBeTruthy();
    }
  });

  it("every range default sits on its step grid", () => {
    for (const a of ADAPTER_LIST) {
      for (const p of a.params) {
        if (p.kind !== "range") continue;
        const steps = (p.def - p.min) / p.step;
        expect(Math.abs(steps - Math.round(steps)), `${a.id}.${p.key} def=${p.def} min=${p.min} step=${p.step}`).toBeLessThan(1e-6);
      }
    }
  });

  it("every preset only uses declared params with in-range values", () => {
    for (const a of ADAPTER_LIST) {
      for (const preset of a.presets ?? []) {
        for (const [k, v] of Object.entries(preset.params)) {
          const spec = a.params.find((p) => p.key === k);
          expect(spec, `${a.id} preset "${preset.name}" sets undeclared param ${k}`).toBeTruthy();
          if (spec!.kind === "range" && typeof v === "number") {
            expect(v).toBeGreaterThanOrEqual(spec!.min);
            expect(v).toBeLessThanOrEqual(spec!.max);
          }
        }
      }
    }
  });

  it("seeded generation is deterministic and seed changes the result", () => {
    const a = ADAPTERS.truchet;
    const base = defaultParams(a);
    const g1 = a.generate(base, {});
    const g2 = a.generate({ ...base }, {});
    expect(g1.groups).toEqual(g2.groups);
    const seedKey = a.seedKey ?? "seed";
    const g3 = a.generate({ ...base, [seedKey]: (base[seedKey] as number) + 5 }, {});
    expect(JSON.stringify(g3.groups)).not.toEqual(JSON.stringify(g1.groups));
  });

  it("lettering flags characters the face cannot draw, without inventing them", () => {
    const a = ADAPTERS.lettering;
    const res = a.generate({ ...defaultParams(a), text: "Bay縫side" }, {});
    expect(res.warning).toMatch(/縫/);
    const clean = a.generate({ ...defaultParams(a), text: "Bayside" }, {});
    expect(clean.warning).toBeUndefined();
  });

  it("photo adapters refuse to run without an image instead of guessing", () => {
    const res = ADAPTERS.oneline.generate(defaultParams(ADAPTERS.oneline), {});
    expect(res.groups).toHaveLength(0);
    expect(res.warning).toBeTruthy();
  });
});

describe("composed export integrity", () => {
  it("project → element stitches → compose → DST bytes → re-parse round-trips", () => {
    // build one truchet element exactly the way the editor does
    const a = ADAPTERS.truchet;
    const el: GeneratedElement = {
      id: "e1",
      kind: "generated",
      name: "Truchet",
      tool: "truchet",
      params: defaultParams(a),
      colors: ["#112233"],
      transform: { xMm: 5, yMm: -8, rotDeg: 30 },
      sizeMm: 90,
      hidden: false,
      locked: false,
    };
    const groups = a.generate(el.params, {}).groups;
    expect(groups.length).toBeGreaterThan(0);
    const placed = groups.map((g) =>
      routeStrokes(placePaths(g.paths, { cx: 0, cy: 0, sizeMm: el.sizeMm, rotDeg: 0 }).filter((p) => p.length >= 2))
        .map((p) => resamplePath(p, 2.2, 0.4)),
    );
    const stitches = pathGroupsToStitches(placed, 1);
    const project = newProject("t");
    project.elements = [el];
    const composed = composeProject(project, new Map([["e1", { elementId: "e1", stitches, colors: el.colors }]]));
    expect(composed.colors).toEqual(["#112233"]);

    const bytes = writeDst(composed.stitches, "test");
    const parsed = parseDst(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const real = parsed.stitches.filter((s) => s.cmd === CMD.STITCH).length;
    expect(real).toBeGreaterThan(100);

    // rotation + translation are rigid: stitch lengths in the parsed file
    // stay within the machine range used at generation time
    let long = 0;
    let prev: { x: number; y: number } | null = null;
    for (const s of parsed.stitches) {
      if (s.cmd !== CMD.STITCH) { prev = null; continue; }
      if (prev) {
        const len = Math.hypot(s.x - prev.x, s.y - prev.y) / 10;
        if (len > long) long = len;
      }
      prev = { x: s.x, y: s.y };
    }
    expect(long).toBeLessThanOrEqual(3.5); // 2.2mm target, some chord tolerance
  });

  it("two elements sew in element order with a color change between", () => {
    const a = ADAPTERS.truchet;
    const mk = (id: string, hex: string): GeneratedElement => ({
      id, kind: "generated", name: id, tool: "truchet", params: defaultParams(a),
      colors: [hex], transform: { xMm: 0, yMm: 0, rotDeg: 0 }, sizeMm: 50, hidden: false, locked: false,
    });
    const groups = a.generate(defaultParams(a), {}).groups;
    const st = pathGroupsToStitches(
      groups.map((g) => routeStrokes(placePaths(g.paths, { cx: 0, cy: 0, sizeMm: 50, rotDeg: 0 })).map((p) => resamplePath(p, 2.2, 0.4))),
      1,
    );
    const project = newProject("t2");
    project.elements = [mk("a", "#aa0000"), mk("b", "#00aa00")];
    const composed = composeProject(project, new Map([
      ["a", { elementId: "a", stitches: st, colors: ["#aa0000"] }],
      ["b", { elementId: "b", stitches: st, colors: ["#00aa00"] }],
    ]));
    expect(composed.colors).toEqual(["#aa0000", "#00aa00"]);
    const changes = composed.stitches.filter((s) => s.cmd === CMD.COLOR_CHANGE).length;
    expect(changes).toBe(1);
  });
});
