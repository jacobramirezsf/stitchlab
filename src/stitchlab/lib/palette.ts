// Brother PEC 64-color machine palette (index 0 unused), as shipped in
// pyembroidery's EmbThreadPec.py (MIT). PEC files store 1-byte indices into
// this fixed palette - no true RGB - so rendered PES/PEC colors are the
// machine's approximation of the real thread.

export type PecEntry = { hex: string; name: string } | null;

const e = (r: number, g: number, b: number, name: string): PecEntry => ({
  hex:
    "#" +
    r.toString(16).padStart(2, "0") +
    g.toString(16).padStart(2, "0") +
    b.toString(16).padStart(2, "0"),
  name,
});

export const PEC_PALETTE: PecEntry[] = [
  null,
  e(14, 31, 124, "Prussian Blue"),
  e(10, 85, 163, "Blue"),
  e(0, 135, 119, "Teal Green"),
  e(75, 107, 175, "Cornflower Blue"),
  e(237, 23, 31, "Red"),
  e(209, 92, 0, "Reddish Brown"),
  e(145, 54, 151, "Magenta"),
  e(228, 154, 203, "Light Lilac"),
  e(145, 95, 172, "Lilac"),
  e(158, 214, 125, "Mint Green"),
  e(232, 169, 0, "Deep Gold"),
  e(254, 186, 53, "Orange"),
  e(255, 255, 0, "Yellow"),
  e(112, 188, 31, "Lime Green"),
  e(186, 152, 0, "Brass"),
  e(168, 168, 168, "Silver"),
  e(125, 111, 0, "Russet Brown"),
  e(255, 255, 179, "Cream Brown"),
  e(79, 85, 86, "Pewter"),
  e(0, 0, 0, "Black"),
  e(11, 61, 145, "Ultramarine"),
  e(119, 1, 118, "Royal Purple"),
  e(41, 49, 51, "Dark Gray"),
  e(42, 19, 1, "Dark Brown"),
  e(246, 74, 138, "Deep Rose"),
  e(178, 118, 36, "Light Brown"),
  e(252, 187, 197, "Salmon Pink"),
  e(254, 55, 15, "Vermilion"),
  e(240, 240, 240, "White"),
  e(106, 28, 138, "Violet"),
  e(168, 221, 196, "Seacrest"),
  e(37, 132, 187, "Sky Blue"),
  e(254, 179, 67, "Pumpkin"),
  e(255, 243, 107, "Cream Yellow"),
  e(208, 166, 96, "Khaki"),
  e(209, 84, 0, "Clay Brown"),
  e(102, 186, 73, "Leaf Green"),
  e(19, 74, 70, "Peacock Blue"),
  e(135, 135, 135, "Gray"),
  e(216, 204, 198, "Warm Gray"),
  e(67, 86, 7, "Dark Olive"),
  e(253, 217, 222, "Flesh Pink"),
  e(249, 147, 188, "Pink"),
  e(0, 56, 34, "Deep Green"),
  e(178, 175, 212, "Lavender"),
  e(104, 106, 176, "Wisteria Violet"),
  e(239, 227, 185, "Beige"),
  e(247, 56, 102, "Carmine"),
  e(181, 75, 100, "Amber Red"),
  e(19, 43, 26, "Olive Green"),
  e(199, 1, 86, "Dark Fuchsia"),
  e(254, 158, 50, "Tangerine"),
  e(168, 222, 235, "Light Blue"),
  e(0, 103, 62, "Emerald Green"),
  e(78, 41, 144, "Purple"),
  e(47, 126, 32, "Moss Green"),
  e(255, 204, 204, "Flesh Pink"),
  e(255, 217, 17, "Harvest Gold"),
  e(9, 91, 166, "Electric Blue"),
  e(240, 249, 112, "Lemon Yellow"),
  e(227, 243, 91, "Fresh Green"),
  e(255, 153, 0, "Orange"),
  e(255, 240, 141, "Cream Yellow"),
  e(255, 200, 200, "Applique"),
];
