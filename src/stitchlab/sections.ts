// Curated tool groupings, shared by the staff overview page and the
// Workspace's all-tools gallery. Superseded versions (cross-stitch v1/v2,
// original blocks) stay reachable by direct link but out of these lists.
// The Composer was retired once the Workspace covered its job.

export const SECTIONS: { title: string; blurb: string; slugs: string[]; staffOnly?: boolean }[] = [
  {
    title: "From a photo",
    blurb: "Bring in a picture and turn it into stitches a few different ways.",
    slugs: ["crossstitch", "portrait", "oneline", "imagepack", "hatchtone", "halftone", "threadpaint", "directional", "redwork", "stringart", "flowink", "imagemaze", "turing", "sashikotone"],
  },
  {
    title: "Words, names & badges",
    blurb: "Lettering, monograms, and round crest-style patches.",
    slugs: ["lettering", "handfont", "monogram", "badge", "qrcode", "asciitext"],
  },
  {
    title: "Fills & textures",
    blurb: "Fill a shape solid, or give it a woven, quilted, or flowing texture.",
    slugs: [
      "blackwork", "tatami", "satin", "fermat", "quilting", "meander", "flowfield",
      "crosshatch", "plaid", "moire", "honeycomb", "waves", "dotgrid",
    ],
  },
  {
    title: "Patterns & shapes",
    blurb: "Geometric and generative patterns, from stars and roses to mazes and coral.",
    slugs: [
      "border", "star", "rose", "phyllotaxis", "harmonograph", "attractor", "maze", "truchet", "sashiko", "reaction", "growth", "fractal",
      "spirograph", "spiral", "lissajous", "superformula", "butterfly", "heart", "rosette", "timestable", "fractaltree",
      "web", "ripples", "topo", "circlepack", "rings", "polygons", "squares", "polygonring",
    ],
  },
  {
    // Parked from the public listings (Sept 2026) - staff-only experimental.
    title: "Make your own (experimental)",
    blurb: "Compose on a canvas, build a pattern from blocks, write code, or draw by hand.",
    slugs: ["workspace", "blocks2", "sketch", "studio"],
    staffOnly: true,
  },
];
