// Unit tests for the curated image-library core. Everything runs against
// fixtures — no network, no Flickr dependency.

import { describe, expect, it } from "vitest";
import {
  assembleLibrary,
  attributionLine,
  categoriesOf,
  DEFAULT_ALLOWED_LICENSES,
  isLicenseAllowed,
  normalizeFlickrPhoto,
  pickBestImage,
  searchAssets,
  type LibrarySource,
} from "./assetlib";

const SRC: LibrarySource = {
  id: "72177720301234567",
  type: "album",
  title: "Flowers & Plants",
  category: "Flowers & Plants",
  enabled: true,
  ownerId: "12345678@N00",
  tags: ["flower", "plant", "floral"],
};

// a realistic photosets.getPhotos photo with url_* extras
const photo = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "54321",
  title: "Rose macro",
  ownername: "Some Photographer",
  license: "4", // CC BY
  tags: "rose red garden",
  description: { _content: "A red rose." },
  dateupload: "1700000000",
  url_m: "https://live.staticflickr.com/1/54321_m.jpg",
  width_m: 500,
  height_m: 333,
  url_l: "https://live.staticflickr.com/1/54321_l.jpg",
  width_l: 1024,
  height_l: 683,
  url_k: "https://live.staticflickr.com/1/54321_k.jpg",
  width_k: 2048,
  height_k: 1365,
  ...over,
});

describe("license policy", () => {
  it("allows only commercial+derivative licenses by default", () => {
    for (const ok of ["4", "5", "7", "8", "9", "10"])
      expect(isLicenseAllowed(ok, {})).toBe(true);
    for (const bad of ["0", "1", "2", "3", "6"])
      expect(isLicenseAllowed(bad, {})).toBe(false);
  });
  it("rejects missing licenses", () => {
    expect(isLicenseAllowed(undefined, {})).toBe(false);
    expect(isLicenseAllowed(null, {})).toBe(false);
  });
  it("ownContent bypasses the allowlist (our own uploads)", () => {
    expect(isLicenseAllowed("0", { ownContent: true })).toBe(true);
    expect(isLicenseAllowed(undefined, { ownContent: true })).toBe(true);
  });
  it("accepts a custom allowlist", () => {
    expect(isLicenseAllowed("2", {}, ["2"])).toBe(true);
    expect(isLicenseAllowed("4", {}, ["2"])).toBe(false);
  });
});

describe("size selection", () => {
  it("prefers 2048 over original and small sizes", () => {
    expect(pickBestImage(photo({ url_o: "https://live.staticflickr.com/1/54321_o.tif" }))!.url).toContain("_k");
  });
  it("falls back gracefully when large sizes are missing", () => {
    const p = photo();
    delete p.url_k;
    delete p.url_l;
    expect(pickBestImage(p)!.url).toContain("_m");
  });
  it("uses the original when it's the only large option", () => {
    const p = photo({ url_o: "https://live.staticflickr.com/1/54321_o.jpg", width_o: 4000, height_o: 3000 });
    delete p.url_k;
    delete p.url_l;
    const best = pickBestImage(p)!;
    expect(best.url).toContain("_o");
    expect(best.width).toBe(4000);
  });
  it("returns null when no urls exist at all", () => {
    expect(pickBestImage({ id: "1" })).toBeNull();
  });
});

describe("normalizeFlickrPhoto", () => {
  it("builds a complete asset", () => {
    const r = normalizeFlickrPhoto(photo(), SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = r.asset;
    expect(a.id).toBe("flickr-54321");
    expect(a.title).toBe("Rose macro");
    expect(a.creator).toBe("Some Photographer");
    expect(a.license.code).toBe("CC BY");
    expect(a.pageUrl).toContain("12345678@N00/54321");
    expect(a.curatorTags).toEqual(["flower", "plant", "floral"]);
    expect(a.flickrTags).toContain("rose");
    expect(a.orientation).toBe("landscape");
    expect(a.description).toBe("A red rose.");
    expect(a.category).toBe("Flowers & Plants");
  });
  it("rejects photos with unusable licenses", () => {
    const r = normalizeFlickrPhoto(photo({ license: "0" }), SRC);
    expect(r).toEqual({ ok: false, reason: "license" });
  });
  it("keeps all-rights photos from ownContent sources", () => {
    const r = normalizeFlickrPhoto(photo({ license: "0" }), { ...SRC, ownContent: true });
    expect(r.ok).toBe(true);
  });
  it("rejects photos with no image urls", () => {
    const r = normalizeFlickrPhoto({ id: "9", title: "x", license: "4" }, SRC);
    expect(r).toEqual({ ok: false, reason: "no-image" });
  });
  it("survives missing/odd fields (API drift)", () => {
    const r = normalizeFlickrPhoto(
      { id: "77", license: 4, url_m: "https://live.staticflickr.com/1/77_m.jpg", description: "plain string" },
      SRC
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.asset.title).toBe("Untitled");
    expect(r.asset.creator).toBe("");
    expect(r.asset.description).toBe("plain string");
    expect(r.asset.orientation).toBeUndefined();
  });
  it("merges per-photo curator tags", () => {
    const r = normalizeFlickrPhoto(photo(), SRC, { perPhotoTags: ["tattoo", "line art"] });
    if (!r.ok) throw new Error("expected ok");
    expect(r.asset.curatorTags).toEqual(["flower", "plant", "floral", "tattoo", "line art"]);
  });
});

describe("assembleLibrary (whitelist + diagnostics)", () => {
  const cars: LibrarySource = {
    id: "111",
    type: "album",
    title: "Cars & Lowriders",
    category: "Cars & Lowriders",
    enabled: true,
    tags: ["car", "lowrider"],
  };
  const disabled: LibrarySource = { ...SRC, id: "222", enabled: false };

  it("only includes enabled sources — disabled albums never leak", () => {
    const { assets, diagnostics } = assembleLibrary([cars, disabled], {
      "111": [photo({ id: "1" })],
      "222": [photo({ id: "2" })],
    });
    expect(assets).toHaveLength(1);
    expect(assets[0].fromSource).toBe("111");
    expect(diagnostics).toHaveLength(1); // disabled source isn't even reported
  });
  it("records per-source errors without failing the rest", () => {
    const { assets, diagnostics } = assembleLibrary([cars, { ...SRC, id: "333" }], {
      "111": [photo({ id: "1" })],
      "333": { error: "album unavailable" },
    });
    expect(assets).toHaveLength(1);
    expect(diagnostics.find((d) => d.sourceId === "333")?.error).toBe("album unavailable");
  });
  it("counts license and no-image skips", () => {
    const { diagnostics } = assembleLibrary([cars], {
      "111": [photo({ id: "1" }), photo({ id: "2", license: "0" }), { id: "3", license: "4" }],
    });
    expect(diagnostics[0]).toMatchObject({ fetched: 3, kept: 1, skippedLicense: 1, skippedNoImage: 1 });
  });
  it("dedupes the same photo appearing in two albums", () => {
    const { assets } = assembleLibrary([cars, { ...SRC, id: "444" }], {
      "111": [photo({ id: "1" })],
      "444": [photo({ id: "1" })],
    });
    expect(assets).toHaveLength(1);
  });
});

describe("searchAssets — curator metadata beats bad Flickr titles", () => {
  const lib = assembleLibrary(
    [
      { id: "a", type: "album", title: "Tattoo Flash", category: "Tattoo / Flash", enabled: true, tags: ["tattoo", "flash", "line art", "rose"] },
      { id: "b", type: "album", title: "Cars", category: "Cars & Lowriders", enabled: true, tags: ["car", "lowrider"] },
    ],
    {
      a: [photo({ id: "1", title: "IMG_4837", tags: "", description: { _content: "" } })],
      b: [photo({ id: "2", title: "Impala at sunset", tags: "chevy impala", description: { _content: "A classic car." } })],
    }
  ).assets;

  it("finds IMG_4837 by curator tag", () => {
    const hits = searchAssets(lib, "rose");
    expect(hits.map((a) => a.sourceId)).toEqual(["1"]);
  });
  it("finds by title and flickr tags", () => {
    expect(searchAssets(lib, "impala")[0].sourceId).toBe("2");
  });
  it("requires all tokens to match — no noisy partials", () => {
    expect(searchAssets(lib, "rose impala")).toHaveLength(0);
  });
  it("filters by category", () => {
    expect(searchAssets(lib, "", { category: "Cars & Lowriders" })).toHaveLength(1);
    expect(searchAssets(lib, "rose", { category: "Cars & Lowriders" })).toHaveLength(0);
  });
  it("empty query returns the (category-scoped) library", () => {
    expect(searchAssets(lib, "")).toHaveLength(2);
  });
  it("no results is just an empty list — never a fallback", () => {
    expect(searchAssets(lib, "zebra")).toEqual([]);
  });
});

describe("attribution", () => {
  it("credits creator, license, and Flickr", () => {
    const r = normalizeFlickrPhoto(photo(), SRC);
    if (!r.ok) throw new Error("expected ok");
    expect(attributionLine(r.asset)).toBe("Photo by Some Photographer · CC BY · Flickr");
  });
  it("labels our own collection without legal noise", () => {
    const r = normalizeFlickrPhoto(photo({ license: "0" }), { ...SRC, ownContent: true });
    if (!r.ok) throw new Error("expected ok");
    expect(attributionLine(r.asset)).toContain("From our collection");
  });
});

describe("categoriesOf", () => {
  it("lists distinct categories sorted", () => {
    const lib = assembleLibrary(
      [
        { id: "a", type: "album", title: "T", category: "Tattoo", enabled: true },
        { id: "b", type: "album", title: "C", category: "Cars", enabled: true },
      ],
      { a: [photo({ id: "1" })], b: [photo({ id: "2" })] }
    ).assets;
    expect(categoriesOf(lib)).toEqual(["Cars", "Tattoo"]);
  });
});

describe("default license list sanity", () => {
  it("never includes NC or ND licenses", () => {
    expect(DEFAULT_ALLOWED_LICENSES).not.toContain("1");
    expect(DEFAULT_ALLOWED_LICENSES).not.toContain("2");
    expect(DEFAULT_ALLOWED_LICENSES).not.toContain("3");
    expect(DEFAULT_ALLOWED_LICENSES).not.toContain("6");
  });
});
