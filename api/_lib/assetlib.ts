// The Lab's curated image-library core — pure functions and types, no DOM,
// shared by the server sync (api/flickr.ts), the client browser UI, and the
// unit tests. Flickr is ONE AssetSource behind a normalized model; museum
// APIs, uploads, or other archives can join without touching the UI.
//
// Design rules this module enforces:
//  - The whitelist is real: only enabled, explicitly configured sources ever
//    contribute assets. There is no fallback to Flickr-wide anything.
//  - Licensing is a central policy, not a UI decision. Unknown or
//    non-reusable licenses exclude a photo unless the source is marked as
//    our own content.
//  - Curator metadata (per-source category + tags, per-photo overrides)
//    outranks whatever the photographer typed. "IMG_4837" stays findable.

// ── source configuration (curated by the program, stored server-side) ────

export type LibrarySourceType = "album" | "gallery";

export type LibrarySource = {
  id: string; // Flickr photoset/gallery id
  type: LibrarySourceType;
  title: string; // how it appears in OUR UI (not Flickr's title)
  category: string; // browse chip, e.g. "Flowers & Plants"
  enabled: boolean;
  ownerId?: string; // Flickr NSID of the album owner (needed for photosets)
  /** curator tags applied to every photo in this source */
  tags?: string[];
  /** our own uploads: license allowlist does not apply */
  ownContent?: boolean;
};

// ── licensing (Flickr license ids → policy) ──────────────────────────────

export type LicenseInfo = {
  id: string;
  code: string; // short display: "CC BY", "Public Domain", …
  name: string;
  url: string;
  requiresAttribution: boolean;
  commercialOk: boolean;
  derivativesOk: boolean;
};

const L = (
  id: string,
  code: string,
  name: string,
  url: string,
  requiresAttribution: boolean,
  commercialOk: boolean,
  derivativesOk: boolean
): LicenseInfo => ({ id, code, name, url, requiresAttribution, commercialOk, derivativesOk });

export const FLICKR_LICENSES: Record<string, LicenseInfo> = {
  "0": L("0", "All rights reserved", "All Rights Reserved", "", true, false, false),
  "1": L("1", "CC BY-NC-SA", "Attribution-NonCommercial-ShareAlike", "https://creativecommons.org/licenses/by-nc-sa/2.0/", true, false, true),
  "2": L("2", "CC BY-NC", "Attribution-NonCommercial", "https://creativecommons.org/licenses/by-nc/2.0/", true, false, true),
  "3": L("3", "CC BY-NC-ND", "Attribution-NonCommercial-NoDerivs", "https://creativecommons.org/licenses/by-nc-nd/2.0/", true, false, false),
  "4": L("4", "CC BY", "Attribution", "https://creativecommons.org/licenses/by/2.0/", true, true, true),
  "5": L("5", "CC BY-SA", "Attribution-ShareAlike", "https://creativecommons.org/licenses/by-sa/2.0/", true, true, true),
  "6": L("6", "CC BY-ND", "Attribution-NoDerivs", "https://creativecommons.org/licenses/by-nd/2.0/", true, true, false),
  "7": L("7", "No known restrictions", "No known copyright restrictions", "https://www.flickr.com/commons/usage/", false, true, true),
  "8": L("8", "US Government work", "United States Government Work", "http://www.usa.gov/copyright.shtml", false, true, true),
  "9": L("9", "CC0", "Public Domain Dedication", "https://creativecommons.org/publicdomain/zero/1.0/", false, true, true),
  "10": L("10", "Public Domain", "Public Domain Mark", "https://creativecommons.org/publicdomain/mark/1.0/", false, true, true),
};

// Default policy: the kids may sell what they make, and they always remix —
// so commercial use AND derivatives must be allowed. That's CC BY, CC BY-SA,
// no-known-restrictions, US Gov, CC0, and Public Domain.
export const DEFAULT_ALLOWED_LICENSES = ["4", "5", "7", "8", "9", "10"];

export const licenseFor = (id: string | undefined | null): LicenseInfo | null =>
  id != null && FLICKR_LICENSES[String(id)] ? FLICKR_LICENSES[String(id)] : null;

export function isLicenseAllowed(
  licenseId: string | undefined | null,
  source: Pick<LibrarySource, "ownContent">,
  allowed: string[] = DEFAULT_ALLOWED_LICENSES
): boolean {
  if (source.ownContent) return true; // our own uploads — our call
  if (licenseId == null) return false; // unknown license = not usable
  return allowed.includes(String(licenseId));
}

// ── the normalized asset ─────────────────────────────────────────────────

export type MakerMetadata = {
  // reserved for cheap or curated production hints; searchable when present
  lineArt?: boolean;
  silhouette?: boolean;
  highContrast?: boolean;
  lowColorCount?: boolean;
  goodFor?: string[]; // "vinyl" | "embroidery" | "patches" | …
};

export type LibraryAsset = {
  id: string; // ours: "flickr-<photoId>"
  source: "flickr"; // AssetSource — museums/uploads join later
  sourceId: string; // Flickr photo id
  fromSource: string; // LibrarySource.id it came from
  category: string;
  title: string;
  description?: string;
  creator: string;
  creatorId?: string;
  pageUrl: string; // the photo's page (attribution link)
  thumbUrl: string; // grid browsing (~500px)
  imageUrl: string; // creative use (best available ≤2048px)
  width?: number;
  height?: number;
  orientation?: "portrait" | "landscape" | "square";
  license: LicenseInfo;
  ownContent?: boolean;
  flickrTags: string[];
  curatorTags: string[]; // source tags + any per-photo overrides
  maker?: MakerMetadata;
  uploadedAt?: number;
};

/** one-line attribution, youth-friendly: "Photo by X · CC BY · Flickr" */
export function attributionLine(a: Pick<LibraryAsset, "creator" | "license" | "ownContent">): string {
  if (a.ownContent) return a.creator ? `From our collection · ${a.creator}` : "From our collection";
  const parts = [a.creator ? `Photo by ${a.creator}` : "Flickr photo"];
  if (a.license.requiresAttribution || a.license.code) parts.push(a.license.code);
  parts.push("Flickr");
  return parts.join(" · ");
}

// ── Flickr photo → asset normalization ───────────────────────────────────

// The extras we request; url_* fields give sizes without extra API calls.
export const FLICKR_EXTRAS =
  "description,license,owner_name,tags,date_upload,o_dims,url_m,url_z,url_l,url_h,url_k,url_o";

type FlickrPhoto = Record<string, unknown>;

const s = (v: unknown): string => (v == null ? "" : String(v));
const n = (v: unknown): number | undefined => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : undefined;
};

/**
 * Pick the best size for creative use without assuming the original exists:
 * prefer ~2048 (k) → 1600 (h) → 1024 (l) → original → 640 (z) → 500 (m).
 * Original comes AFTER the large renders: it can be a 100MB scan, and 2048px
 * already prints well at garment scale.
 */
export function pickBestImage(p: FlickrPhoto): { url: string; width?: number; height?: number } | null {
  const tries: [string, string, string][] = [
    ["url_k", "width_k", "height_k"],
    ["url_h", "width_h", "height_h"],
    ["url_l", "width_l", "height_l"],
    ["url_o", "width_o", "height_o"],
    ["url_z", "width_z", "height_z"],
    ["url_m", "width_m", "height_m"],
  ];
  for (const [u, w, h] of tries) {
    if (typeof p[u] === "string" && p[u]) {
      return { url: String(p[u]), width: n(p[w]), height: n(p[h]) };
    }
  }
  return null;
}

export function pickThumb(p: FlickrPhoto): string | null {
  for (const key of ["url_m", "url_z", "url_l"]) {
    if (typeof p[key] === "string" && p[key]) return String(p[key]);
  }
  const best = pickBestImage(p);
  return best ? best.url : null;
}

export type NormalizeResult =
  | { ok: true; asset: LibraryAsset }
  | { ok: false; reason: "no-image" | "license" };

export function normalizeFlickrPhoto(
  p: FlickrPhoto,
  source: LibrarySource,
  opts: { fallbackOwnerId?: string; allowedLicenses?: string[]; perPhotoTags?: string[] } = {}
): NormalizeResult {
  const best = pickBestImage(p);
  const thumb = pickThumb(p);
  if (!best || !thumb) return { ok: false, reason: "no-image" };

  const licenseId = p.license != null ? String(p.license) : null;
  if (!isLicenseAllowed(licenseId, source, opts.allowedLicenses)) {
    return { ok: false, reason: "license" };
  }
  const license =
    licenseFor(licenseId) ??
    // ownContent with unknown license: treat as ours-all-rights
    FLICKR_LICENSES["0"];

  const ownerId = s(p.owner) || opts.fallbackOwnerId || source.ownerId || "";
  const photoId = s(p.id);
  const description =
    typeof p.description === "object" && p.description !== null
      ? s((p.description as { _content?: unknown })._content)
      : s(p.description);
  const width = best.width ?? n(p.o_width);
  const height = best.height ?? n(p.o_height);
  const orientation =
    width && height
      ? Math.abs(width - height) / Math.max(width, height) < 0.05
        ? "square"
        : width > height
          ? "landscape"
          : "portrait"
      : undefined;

  return {
    ok: true,
    asset: {
      id: `flickr-${photoId}`,
      source: "flickr",
      sourceId: photoId,
      fromSource: source.id,
      category: source.category,
      title: s(p.title) || "Untitled",
      description: description || undefined,
      creator: s(p.ownername),
      creatorId: ownerId || undefined,
      pageUrl: ownerId
        ? `https://www.flickr.com/photos/${ownerId}/${photoId}`
        : `https://www.flickr.com/photo.gne?id=${photoId}`,
      thumbUrl: thumb,
      imageUrl: best.url,
      width,
      height,
      orientation,
      license,
      ownContent: source.ownContent || undefined,
      flickrTags: s(p.tags).split(/\s+/).filter(Boolean).slice(0, 30),
      curatorTags: [...(source.tags ?? []), ...(opts.perPhotoTags ?? [])],
      uploadedAt: n(p.dateupload) ? n(p.dateupload)! * 1000 : undefined,
    },
  };
}

// ── library assembly (whitelist enforcement lives HERE) ──────────────────

export type SyncDiagnostics = {
  sourceId: string;
  title: string;
  fetched: number;
  kept: number;
  skippedLicense: number;
  skippedNoImage: number;
  error?: string;
};

export function assembleLibrary(
  sources: LibrarySource[],
  photosBySource: Record<string, FlickrPhoto[] | { error: string }>,
  opts: {
    allowedLicenses?: string[];
    perPhotoTags?: Record<string, string[]>;
    fallbackOwnerIds?: Record<string, string>;
  } = {}
): { assets: LibraryAsset[]; diagnostics: SyncDiagnostics[] } {
  const assets: LibraryAsset[] = [];
  const diagnostics: SyncDiagnostics[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (!source.enabled) continue; // the whitelist is real
    const entry = photosBySource[source.id];
    const diag: SyncDiagnostics = {
      sourceId: source.id,
      title: source.title,
      fetched: 0,
      kept: 0,
      skippedLicense: 0,
      skippedNoImage: 0,
    };
    if (!entry) {
      diag.error = "not fetched";
      diagnostics.push(diag);
      continue;
    }
    if (!Array.isArray(entry)) {
      diag.error = entry.error;
      diagnostics.push(diag);
      continue;
    }
    diag.fetched = entry.length;
    for (const p of entry) {
      const r = normalizeFlickrPhoto(p, source, {
        allowedLicenses: opts.allowedLicenses,
        perPhotoTags: opts.perPhotoTags?.[s(p.id)],
        fallbackOwnerId: opts.fallbackOwnerIds?.[source.id],
      });
      if (!r.ok) {
        if (r.reason === "license") diag.skippedLicense++;
        else diag.skippedNoImage++;
        continue;
      }
      if (seen.has(r.asset.id)) continue; // same photo in two albums
      seen.add(r.asset.id);
      assets.push(r.asset);
    }
    diag.kept = diag.fetched - diag.skippedLicense - diag.skippedNoImage;
    diagnostics.push(diag);
  }
  return { assets, diagnostics };
}

// ── search (ours — curator metadata outranks Flickr metadata) ────────────

const tokenize = (q: string): string[] =>
  q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);

export function searchAssets(
  assets: LibraryAsset[],
  query: string,
  opts: { category?: string | null; limit?: number } = {}
): LibraryAsset[] {
  const inCategory = opts.category
    ? assets.filter((a) => a.category === opts.category)
    : assets;
  const tokens = tokenize(query);
  if (!tokens.length) return inCategory.slice(0, opts.limit ?? inCategory.length);

  const scored: { a: LibraryAsset; score: number }[] = [];
  for (const a of inCategory) {
    const curator = a.curatorTags.join(" ").toLowerCase();
    const category = a.category.toLowerCase();
    const title = a.title.toLowerCase();
    const flickrTags = a.flickrTags.join(" ").toLowerCase();
    const description = (a.description ?? "").toLowerCase();
    const creator = a.creator.toLowerCase();
    const maker = (a.maker?.goodFor ?? []).join(" ").toLowerCase();
    let score = 0;
    for (const t of tokens) {
      // curator intent ranks highest — this is what fixes "IMG_4837"
      if (curator.includes(t)) score += 6;
      if (maker.includes(t)) score += 6;
      if (category.includes(t)) score += 5;
      if (title.includes(t)) score += 4;
      if (flickrTags.includes(t)) score += 3;
      if (description.includes(t)) score += 1;
      if (creator.includes(t)) score += 1;
    }
    // every token must land somewhere — partial matches feel broken
    const allMatched = tokens.every(
      (t) =>
        curator.includes(t) ||
        maker.includes(t) ||
        category.includes(t) ||
        title.includes(t) ||
        flickrTags.includes(t) ||
        description.includes(t) ||
        creator.includes(t)
    );
    if (score > 0 && allMatched) scored.push({ a, score });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, opts.limit ?? 60).map((x) => x.a);
}

export const categoriesOf = (assets: LibraryAsset[]): string[] =>
  [...new Set(assets.map((a) => a.category))].sort();
