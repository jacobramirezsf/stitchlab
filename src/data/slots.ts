// Bayside. Placement slots per garment.
// Coordinates are normalized fractions (0 to 1) of the image's width and height.
// These are starting estimates. Jacob will adjust by eye.

export type SlotId =
  | "left-chest"
  | "right-chest"
  | "center-chest"
  | "full-back"
  | "left-sleeve"
  | "right-sleeve";

export type SlotDefinition = {
  id: SlotId;
  label: string;
  x: number; // 0 to 1, fraction of image width (center of slot)
  y: number; // 0 to 1, fraction of image height (center of slot)
  maxWidth: number; // 0 to 1, max design width
};

export const SLOTS_BY_GARMENT: Record<string, SlotDefinition[]> = {
  "la-apparel-hf09": [
    { id: "left-chest", label: "Left chest", x: 0.36, y: 0.35, maxWidth: 0.15 },
    { id: "right-chest", label: "Right chest", x: 0.64, y: 0.35, maxWidth: 0.15 },
    { id: "center-chest", label: "Center chest", x: 0.5, y: 0.4, maxWidth: 0.4 },
    { id: "full-back", label: "Full back", x: 0.5, y: 0.5, maxWidth: 0.7 },
    { id: "left-sleeve", label: "Left sleeve", x: 0.18, y: 0.55, maxWidth: 0.12 },
    { id: "right-sleeve", label: "Right sleeve", x: 0.82, y: 0.55, maxWidth: 0.12 },
  ],
  // TODO: tune slot coordinates for this garment
  "la-apparel-mineralwash-hf09": [
    { id: "left-chest", label: "Left chest", x: 0.36, y: 0.35, maxWidth: 0.15 },
    { id: "right-chest", label: "Right chest", x: 0.64, y: 0.35, maxWidth: 0.15 },
    { id: "center-chest", label: "Center chest", x: 0.5, y: 0.4, maxWidth: 0.4 },
    { id: "full-back", label: "Full back", x: 0.5, y: 0.5, maxWidth: 0.7 },
    { id: "left-sleeve", label: "Left sleeve", x: 0.18, y: 0.55, maxWidth: 0.12 },
    { id: "right-sleeve", label: "Right sleeve", x: 0.82, y: 0.55, maxWidth: 0.12 },
  ],
  // TODO: tune slot coordinates for this garment
  "independent-trading-co-eightpointfiveounce": [
    { id: "left-chest", label: "Left chest", x: 0.36, y: 0.35, maxWidth: 0.15 },
    { id: "right-chest", label: "Right chest", x: 0.64, y: 0.35, maxWidth: 0.15 },
    { id: "center-chest", label: "Center chest", x: 0.5, y: 0.4, maxWidth: 0.4 },
    { id: "full-back", label: "Full back", x: 0.5, y: 0.5, maxWidth: 0.7 },
    { id: "left-sleeve", label: "Left sleeve", x: 0.18, y: 0.55, maxWidth: 0.12 },
    { id: "right-sleeve", label: "Right sleeve", x: 0.82, y: 0.55, maxWidth: 0.12 },
  ],
  // TODO: tune slot coordinates for this garment
  "independent-trading-co-ind420": [
    { id: "left-chest", label: "Left chest", x: 0.36, y: 0.35, maxWidth: 0.15 },
    { id: "right-chest", label: "Right chest", x: 0.64, y: 0.35, maxWidth: 0.15 },
    { id: "center-chest", label: "Center chest", x: 0.5, y: 0.4, maxWidth: 0.4 },
    { id: "full-back", label: "Full back", x: 0.5, y: 0.5, maxWidth: 0.7 },
    { id: "left-sleeve", label: "Left sleeve", x: 0.18, y: 0.55, maxWidth: 0.12 },
    { id: "right-sleeve", label: "Right sleeve", x: 0.82, y: 0.55, maxWidth: 0.12 },
  ],
  // TODO: tune slot coordinates for this garment. Zip hoodie: no center-chest.
  "independent-trading-co-ind280zip": [
    { id: "left-chest", label: "Left chest", x: 0.36, y: 0.35, maxWidth: 0.15 },
    { id: "right-chest", label: "Right chest", x: 0.64, y: 0.35, maxWidth: 0.15 },
    { id: "full-back", label: "Full back", x: 0.5, y: 0.5, maxWidth: 0.7 },
    { id: "left-sleeve", label: "Left sleeve", x: 0.18, y: 0.55, maxWidth: 0.12 },
    { id: "right-sleeve", label: "Right sleeve", x: 0.82, y: 0.55, maxWidth: 0.12 },
  ],
  // TODO: tune slot coordinates for this garment. Zip hoodie: no center-chest.
  "independent-trading-co-ind420zip": [
    { id: "left-chest", label: "Left chest", x: 0.36, y: 0.35, maxWidth: 0.15 },
    { id: "right-chest", label: "Right chest", x: 0.64, y: 0.35, maxWidth: 0.15 },
    { id: "full-back", label: "Full back", x: 0.5, y: 0.5, maxWidth: 0.7 },
    { id: "left-sleeve", label: "Left sleeve", x: 0.18, y: 0.55, maxWidth: 0.12 },
    { id: "right-sleeve", label: "Right sleeve", x: 0.82, y: 0.55, maxWidth: 0.12 },
  ],
};
