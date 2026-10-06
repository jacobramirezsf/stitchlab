// Pure-logic tests for the project store: cloud merge, conflict detection,
// and library organization. (The IndexedDB layer is thin plumbing; the logic
// that can lose someone's work lives here.)
import { describe, expect, it } from "vitest";
import { mergeCloudProjects, organizeProjects, collectionsOf } from "./projects";
import { newProject, serializeProject, type Project } from "./project";

const proj = (over: Partial<Project>): Project => ({ ...newProject("P"), ...over });
const cloudRec = (p: Project) => ({ t: "project", id: p.id, updatedAt: p.updatedAt, p: JSON.parse(serializeProject(p)) });

describe("mergeCloudProjects", () => {
  it("passes non-project records (mirrored designs) through untouched", () => {
    const design = { id: "d1", name: "old design", bytesB64: "xx" };
    const { merged } = mergeCloudProjects([design], [], new Map());
    expect(merged).toContainEqual(design);
  });

  it("keeps the newer side by updatedAt when there is no divergence", () => {
    const base = proj({ id: "a", updatedAt: 100, rev: 1 });
    const newerLocal = { ...base, updatedAt: 200, rev: 2, name: "local newer" };
    const { merged, conflict } = mergeCloudProjects([cloudRec(base)], [newerLocal], new Map([["a", 1]]));
    expect(conflict).toBeNull();
    const rec = merged.find((r) => r.t === "project") as { p: { name: string } };
    expect(rec.p.name).toBe("local newer");
  });

  it("cloud-only projects survive the push (no accidental deletion)", () => {
    const cloudOnly = proj({ id: "c", updatedAt: 100 });
    const { merged } = mergeCloudProjects([cloudRec(cloudOnly)], [], new Map());
    expect(merged.filter((r) => r.t === "project")).toHaveLength(1);
  });

  it("detects a genuine two-device conflict (both sides advanced)", () => {
    // this device loaded rev 1, edited to rev 2; cloud moved to rev 3 meanwhile
    const local = proj({ id: "a", rev: 2, updatedAt: 300, name: "mine" });
    const cloud = proj({ id: "a", rev: 3, updatedAt: 250, name: "other device" });
    const { conflict } = mergeCloudProjects([cloudRec(cloud)], [local], new Map([["a", 1]]));
    expect(conflict).not.toBeNull();
    expect(conflict!.cloud.name).toBe("other device");
  });

  it("no conflict when only the cloud advanced (we just adopt it)", () => {
    const local = proj({ id: "a", rev: 1, updatedAt: 100 });
    const cloud = proj({ id: "a", rev: 3, updatedAt: 250 });
    const { conflict, merged } = mergeCloudProjects([cloudRec(cloud)], [local], new Map([["a", 1]]));
    expect(conflict).toBeNull();
    const rec = merged.find((r) => r.t === "project") as { p: { rev: number } };
    expect(rec.p.rev).toBe(3);
  });

  it("tombstoned (soft-deleted) projects sync like updates", () => {
    const local = proj({ id: "a", rev: 2, updatedAt: 300, deletedAt: 300 });
    const cloud = proj({ id: "a", rev: 1, updatedAt: 100 });
    const { merged } = mergeCloudProjects([cloudRec(cloud)], [local], new Map([["a", 1]]));
    const rec = merged.find((r) => r.t === "project") as { p: { deletedAt?: number } };
    expect(rec.p.deletedAt).toBe(300);
  });
});

describe("organizeProjects", () => {
  const mk = (name: string, over: Partial<Project> = {}) => proj({ id: name, name, ...over });
  const all = [
    mk("Alpha", { updatedAt: 3, createdAt: 1, favorite: true, collection: "Fall" }),
    mk("Beta", { updatedAt: 1, createdAt: 3 }),
    mk("Gamma", { updatedAt: 2, createdAt: 2, collection: "Fall" }),
    mk("Gone", { updatedAt: 9, deletedAt: 5 }),
  ];

  it("hides soft-deleted by default, shows them in the deleted view", () => {
    expect(organizeProjects(all, {}).map((p) => p.name)).not.toContain("Gone");
    expect(organizeProjects(all, { deleted: true }).map((p) => p.name)).toEqual(["Gone"]);
  });

  it("sorts by recent, created, and name", () => {
    expect(organizeProjects(all, { sort: "recent" }).map((p) => p.name)).toEqual(["Alpha", "Gamma", "Beta"]);
    expect(organizeProjects(all, { sort: "created" }).map((p) => p.name)).toEqual(["Beta", "Gamma", "Alpha"]);
    expect(organizeProjects(all, { sort: "name" }).map((p) => p.name)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("filters by search, collection, favorites", () => {
    expect(organizeProjects(all, { query: "gam" }).map((p) => p.name)).toEqual(["Gamma"]);
    expect(organizeProjects(all, { collection: "Fall" })).toHaveLength(2);
    expect(organizeProjects(all, { favoritesOnly: true }).map((p) => p.name)).toEqual(["Alpha"]);
  });

  it("lists collections", () => {
    expect(collectionsOf(all)).toEqual(["Fall"]);
  });
});
