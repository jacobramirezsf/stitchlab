import type { SlotId } from "../data/slots";

export type DesignSize = "small" | "medium" | "large";

export type TextDesign = {
  type: "text";
  text: string;
  font: string;
  threadCode: string;
  size: DesignSize;
};

export type ConfigState = {
  garmentId: string;
  colorSlug: string;
  size: string;
  quantity: number;
  activeSlot: SlotId;
  designs: Partial<Record<SlotId, TextDesign>>;
};

export type ConfigAction =
  | { type: "SET_GARMENT"; garmentId: string; colorSlug: string }
  | { type: "SET_COLOR"; colorSlug: string }
  | { type: "SET_SIZE"; size: string }
  | { type: "SET_QUANTITY"; quantity: number }
  | { type: "SET_ACTIVE_SLOT"; slot: SlotId }
  | { type: "UPDATE_DESIGN"; patch: Partial<TextDesign> }
  | { type: "CLEAR_DESIGN" };
