// Minimal ambient types for opentype.js (no @types package). We only use
// parse() + the glyph path API; the outlinefont lib defines the precise shapes.
declare module "opentype.js" {
  const opentype: {
    parse: (buffer: ArrayBuffer) => unknown;
  };
  export default opentype;
  export function parse(buffer: ArrayBuffer): unknown;
}
