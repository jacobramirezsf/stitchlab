// Bayside. Garment inventory data.

export type Tier = "Everyday" | "Studio" | "Premium";

export type GarmentColor = {
  slug: string;
  name: string;
  hex: string;
  imageFront: string;
  imageBack?: string;
};

export type Garment = {
  id: string;
  tier: Tier;
  type: string;
  name: string;
  brand: string;
  weight?: string;
  composition?: string;
  sizes: string[];
  colors: GarmentColor[];
  blankCost: number;
  note?: string;
};

export const TIER_ORDER: Tier[] = ["Everyday", "Studio", "Premium"];

export const GARMENTS: Garment[] = [
  // Tier 01. Everyday
  {
    id: "everyday-crewneck",
    tier: "Everyday",
    type: "Crewneck",
    name: "Heavy Blend Crewneck",
    brand: "Gildan",
    weight: "8 oz",
    composition: "50/50 cotton/poly",
    sizes: ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"],
    colors: [], // TODO: backfill colors (was "40+" in old schema)
    blankCost: 8, // Gildan crew — per Jacob, Jul 2026
    note: "Cost-conscious crewneck. Smooth knit face for clean stitching.",
  },
  {
    id: "everyday-hoodie",
    tier: "Everyday",
    type: "Hoodie",
    name: "Heavy Blend Hoodie",
    brand: "Gildan",
    weight: "8 oz",
    composition: "50/50 cotton/poly",
    sizes: ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"],
    colors: [], // TODO: backfill colors (was "45+" in old schema)
    blankCost: 10.5, // Gildan hoodie — per Jacob, Jul 2026
    note: "Workhorse hoodie. Wide color range, reliable fit, accessible price.",
  },

  // Tier 02. Studio
  {
    id: "studio-hoodie-ind",
    tier: "Studio",
    type: "Hoodie",
    name: "Boulevard Pullover Hood",
    brand: "Independent Trading",
    weight: "10 oz",
    composition: "Ring-spun cotton/poly",
    sizes: ["XS", "S", "M", "L", "XL", "2XL", "3XL"],
    colors: [], // TODO: backfill colors (was "14" in old schema)
    blankCost: 0, // TODO: fill blankCost
    note: "Drop shoulder, no drawcord. Modern silhouette in a midweight fleece.",
  },
  {
    id: "studio-crewneck-cc",
    tier: "Studio",
    type: "Crewneck",
    name: "Garment-Dyed Crewneck",
    brand: "Comfort Colors",
    weight: "9.5 oz",
    composition: "80/20 ring-spun cotton",
    sizes: ["S", "M", "L", "XL", "2XL", "3XL"],
    colors: [], // TODO: backfill colors (was "19" in old schema)
    blankCost: 0, // TODO: fill blankCost
    note: "Pre-dyed for a lived-in feel. Relaxed fit, rolled forward shoulder.",
  },
  {
    id: "independent-trading-co-eightpointfiveounce",
    tier: "Studio",
    type: "Hoodie",
    name: "Avenue Midweight Pullover Hood",
    brand: "Independent Trading Co.",
    weight: "8.5 oz",
    composition: "80% cotton, 20% polyester (heathers vary)",
    sizes: ["S", "M", "L", "XL"],
    blankCost: 12.75, // pigment black runs 17.25 — per Jacob, Jul 2026
    note: "IND280SL. Premium 8.5 oz / 280gm 3-end fleece, ring spun cotton, pre-laundered. Boxy fit, drop shoulder, no drawcord, double-layer 1-piece hood, blindstitch sewing on all seams. Heathers: Grey Heather 52/48 cotton-poly, Ash Heather 75/25 cotton-poly. Heather colorways lack 100% cotton face yarn, so screen printing requires testing. 2X and up: stock check required.",
    colors: [
      {
        slug: "ashheather",
        name: "Ash Heather",
        hex: "#DDDFEA",
        imageFront: "/garments/independent-trading-co-eightpointfiveounce/IND_8p5_ashheather.webp",
      },
      {
        slug: "azure",
        name: "Azure",
        hex: "#037AB1",
        imageFront: "/garments/independent-trading-co-eightpointfiveounce/IND_8p5_azure.webp",
      },
      {
        slug: "black",
        name: "Black",
        hex: "#1C1A1F",
        imageFront: "/garments/independent-trading-co-eightpointfiveounce/IND_8p5_black.webp",
      },
      {
        slug: "cherry",
        name: "Cherry",
        hex: "#D43D4A",
        imageFront: "/garments/independent-trading-co-eightpointfiveounce/IND_8p5_cherry.webp",
      },
      {
        slug: "clay",
        name: "Clay",
        hex: "#856C64",
        imageFront: "/garments/independent-trading-co-eightpointfiveounce/IND_8p5_clay.webp",
      },
      {
        slug: "greyheather",
        name: "Grey Heather",
        hex: "#B9BDC9",
        imageFront: "/garments/independent-trading-co-eightpointfiveounce/IND_8p5_greyheather.webp",
      },
      {
        slug: "honeydew",
        name: "Honeydew",
        hex: "#D5D7C0",
        imageFront: "/garments/independent-trading-co-eightpointfiveounce/IND_8p5_honeydew.webp",
      },
      {
        slug: "ivory",
        name: "Ivory",
        hex: "#D8D1CB",
        imageFront: "/garments/independent-trading-co-eightpointfiveounce/IND_8p5_ivory.webp",
      },
      {
        slug: "lime",
        name: "Lime",
        hex: "#02945E",
        imageFront: "/garments/independent-trading-co-eightpointfiveounce/IND_8p5_lime.webp",
      },
      {
        slug: "magicblue",
        name: "Magic Blue",
        hex: "#687D87",
        imageFront: "/garments/independent-trading-co-eightpointfiveounce/IND_8p5_magicblue.webp",
      },
      {
        slug: "melon",
        name: "Melon",
        hex: "#F19B69",
        imageFront: "/garments/independent-trading-co-eightpointfiveounce/IND_8p5_melon.webp",
      },
      {
        slug: "navy",
        name: "Navy",
        hex: "#2D3041",
        imageFront: "/garments/independent-trading-co-eightpointfiveounce/IND_8p5_navy.webp",
      },
      {
        slug: "olive",
        name: "Olive",
        hex: "#74695A",
        imageFront: "/garments/independent-trading-co-eightpointfiveounce/IND_8p5_olive.webp",
      },
      {
        slug: "orchid",
        name: "Orchid",
        hex: "#AB8991",
        imageFront: "/garments/independent-trading-co-eightpointfiveounce/IND_8p5_orchid.webp",
      },
      {
        slug: "pigmentblack",
        name: "Pigment Black",
        hex: "#363537",
        imageFront: "/garments/independent-trading-co-eightpointfiveounce/IND_8p5_pigmentblack.webp",
      },
      {
        slug: "sand",
        name: "Sand",
        hex: "#B7A088",
        imageFront: "/garments/independent-trading-co-eightpointfiveounce/IND_8p5_sand.webp",
      },
      {
        slug: "seafoam",
        name: "Seafoam",
        hex: "#73C7BF",
        imageFront: "/garments/independent-trading-co-eightpointfiveounce/IND_8p5_seafoam.webp",
      },
      {
        slug: "violet",
        name: "Violet",
        hex: "#8C7CAE",
        imageFront: "/garments/independent-trading-co-eightpointfiveounce/IND_8p5_violet.webp",
      },
      {
        slug: "watermelon",
        name: "Watermelon",
        hex: "#EA606E",
        imageFront: "/garments/independent-trading-co-eightpointfiveounce/IND_8p5_watermelon.webp",
      },
    ],
  },
  {
    id: "independent-trading-co-ind420",
    tier: "Studio",
    type: "Hoodie",
    name: "Premium Heavyweight Pullover Hood",
    brand: "Independent Trading Co.",
    weight: "12.5 oz",
    composition: "75% cotton, 25% polyester",
    sizes: ["S", "M", "L", "XL"],
    blankCost: 17, // pigment black runs 22 — per Jacob, Jul 2026
    note: "IND420. Premium heavyweight 12.5 oz / 420gm 3-end fleece. Boxy fit, drop shoulder, no drawcord, double-layer 1-piece hood, blindstitch sewing. Pre-laundered to reduce shrinkage. Pigment Dye Black has unique character; allow for slight variation in production and washing. 2X and up: stock check required.",
    colors: [
      {
        slug: "black",
        name: "Black",
        hex: "#1C1B1F",
        imageFront: "/garments/independent-trading-co-ind420/ind420hoodie_black.webp",
      },
      {
        slug: "blue_magic",
        name: "Blue Magic",
        hex: "#687D86",
        // Source filename uses ind429hoodie_ prefix (typo). Preserved here so the asset resolves.
        imageFront: "/garments/independent-trading-co-ind420/ind429hoodie_blue_magic.webp",
      },
      {
        slug: "brown",
        name: "Brown",
        hex: "#45332B",
        imageFront: "/garments/independent-trading-co-ind420/ind420hoodie_brown.webp",
      },
      {
        slug: "classic_navy",
        name: "Classic Navy",
        hex: "#313141",
        imageFront: "/garments/independent-trading-co-ind420/ind420hoodie_classic_navy.webp",
      },
      {
        slug: "grey_heather",
        name: "Grey Heather",
        hex: "#B9BCC9",
        imageFront: "/garments/independent-trading-co-ind420/ind420hoodie_grey_heather.webp",
      },
      {
        slug: "ivory",
        name: "Ivory",
        hex: "#D8D1CB",
        imageFront: "/garments/independent-trading-co-ind420/ind420hoodie_ivory.webp",
      },
      {
        slug: "olive",
        name: "Olive",
        hex: "#73695A",
        imageFront: "/garments/independent-trading-co-ind420/ind420hoodie_olive.webp",
      },
      {
        slug: "pigmentblack",
        name: "Pigment Black",
        hex: "#363636",
        imageFront: "/garments/independent-trading-co-ind420/ind420hoodie_pigmentblack.webp",
      },
    ],
  },
  {
    id: "independent-trading-co-ind280zip",
    tier: "Studio",
    type: "Zip Hoodie",
    name: "Avenue Midweight Zip Hood",
    brand: "Independent Trading Co.",
    weight: "8.5 oz",
    composition: "80% cotton, 20% polyester (heathers may vary)", // TODO: confirm ratio
    sizes: ["S", "M", "L", "XL"],
    blankCost: 15.25, // Avenue 280gm zip hood — per Jacob, Jul 2026
    note: "IND280ZIP. Midweight 8.5 oz / 280gm 3-end fleece. Boxy fit, drop shoulder, no drawcord, #5 nickel kissing zipper, double-layer 1-piece hood, blindstitch sewing. Ring spun cotton. 2X and up: stock check required.",
    colors: [
      {
        slug: "ash",
        name: "Ash",
        hex: "#D6DAE6",
        imageFront: "/garments/independent-trading-co-ind280zip/IND280ZIP_ash.webp",
      },
      {
        slug: "black",
        name: "Black",
        hex: "#242328",
        imageFront: "/garments/independent-trading-co-ind280zip/IND280ZIP_black.webp",
      },
    ],
  },
  {
    id: "independent-trading-co-ind420zip",
    tier: "Studio",
    type: "Zip Hoodie",
    name: "Heavyweight Zip Hood",
    brand: "Independent Trading Co.",
    weight: "12.5 oz",
    composition: "75% cotton, 25% polyester", // TODO: confirm ratio
    sizes: ["S", "M", "L", "XL"],
    blankCost: 0, // TODO: confirm with Jacob
    note: "IND420ZIP. Heavyweight 12.5 oz / 420gm 3-end fleece. Boxy fit, drop shoulder, no drawcord, #5 nickel kissing zipper, double-layer 1-piece hood, blindstitch sewing. Pre-laundered to reduce shrinkage. 2X and up: stock check required.",
    colors: [
      {
        slug: "black",
        name: "Black",
        hex: "#242328",
        imageFront: "/garments/independent-trading-co-ind420zip/IND420ZIP_black.webp",
      },
      {
        slug: "heather_grey",
        name: "Heather Grey",
        hex: "#C8CAD4",
        imageFront: "/garments/independent-trading-co-ind420zip/IND420ZIP_heather_grey.webp",
      },
      {
        slug: "pigment_black",
        name: "Pigment Black",
        hex: "#403F44",
        imageFront: "/garments/independent-trading-co-ind420zip/IND420ZIP_pigment_black.webp",
      },
    ],
  },

  // Tier 03. Premium
  {
    id: "premium-hoodie-ind",
    tier: "Premium",
    type: "Hoodie",
    name: "Mainstreet Heavyweight Hood",
    brand: "Independent Trading",
    weight: "12.5 oz",
    composition: "75/25 cotton/poly",
    sizes: ["XS", "S", "M", "L", "XL", "2XL", "3XL"],
    colors: [], // TODO: backfill colors (was "8" in old schema)
    blankCost: 0, // TODO: fill blankCost
    note: "Streetwear-weight pullover. Oversized fit, blindstitch construction.",
  },
  {
    id: "premium-zip-ind",
    tier: "Premium",
    type: "Zip Hoodie",
    name: "Mainstreet Heavyweight Zip",
    brand: "Independent Trading",
    weight: "12.5 oz",
    composition: "Cotton/poly blend",
    sizes: ["XS", "S", "M", "L", "XL", "2XL", "3XL"],
    colors: [], // TODO: backfill colors (was "3" in old schema)
    blankCost: 0, // TODO: fill blankCost
    note: "Same body as the pullover, with a nickel kissing zipper.",
  },
  {
    id: "premium-crewneck-laa",
    tier: "Premium",
    type: "Crewneck",
    name: "Heavy Fleece Crewneck",
    brand: "Los Angeles Apparel",
    weight: "14 oz",
    composition: "Heavyweight cotton fleece",
    sizes: ["XS", "S", "M", "L", "XL", "2XL", "3XL"],
    colors: [], // TODO: backfill colors (was "20+" in old schema)
    blankCost: 0, // TODO: fill blankCost
    note: "14oz crewneck knitted, cut, and sewn in Los Angeles.",
  },
  {
    id: "premium-hoodie-laa-gd",
    tier: "Premium",
    type: "Hoodie",
    name: "Heavy Fleece Hood, Garment-Dyed",
    brand: "Los Angeles Apparel",
    weight: "14 oz",
    composition: "Heavyweight cotton fleece",
    sizes: ["XS", "S", "M", "L", "XL", "2XL", "3XL"],
    colors: [], // TODO: backfill colors (was "20+" in old schema)
    blankCost: 0, // TODO: fill blankCost
    note: "Dyed after construction so the seams and ribbing dye with the body.",
  },
  {
    id: "premium-hoodie-laa-mw",
    tier: "Premium",
    type: "Hoodie",
    name: "Heavy Fleece Hood, Mineral Wash",
    brand: "Los Angeles Apparel",
    weight: "14 oz",
    composition: "Heavyweight cotton fleece",
    sizes: ["XS", "S", "M", "L", "XL", "2XL"],
    colors: [], // TODO: backfill colors (was "7" in old schema)
    blankCost: 42, // LAA 14oz mineral wash — per Jacob, Jul 2026
    note: "Mineral-washed for a soft, worn-in finish.",
  },

  // Tier 03. Premium. HF-09 photographed inventory.
  // Hex values below are best-read estimates from color names + LAA swatch references.
  // Verify after seeing the swatches render and edit any that look off.
  {
    id: "la-apparel-hf09",
    tier: "Premium",
    type: "Hoodie",
    name: "Heavy Fleece Pullover Hood",
    brand: "Los Angeles Apparel",
    weight: "14 oz",
    composition: "100% cotton",
    sizes: ["XS", "S", "M", "L", "XL"],
    blankCost: 41, // LAA 14oz — per Jacob, Jul 2026
    colors: [
      {
        slug: "army",
        name: "Army",
        hex: "#4F5D3A",
        imageFront: "/garments/la-apparel-hf09/LAA_14oz_army.webp",
      },
      {
        slug: "beige",
        name: "Beige",
        hex: "#C8B79A",
        imageFront: "/garments/la-apparel-hf09/LAA_14oz_beige.webp",
      },
      {
        slug: "blackedge",
        name: "Black Edge",
        hex: "#1F1E1B",
        imageFront: "/garments/la-apparel-hf09/LAA_14oz_blackedge.webp",
      },
      {
        slug: "brass",
        name: "Brass",
        hex: "#B89762",
        imageFront: "/garments/la-apparel-hf09/LAA_14oz_brass.webp",
      },
      {
        slug: "brightorange",
        name: "Bright Orange",
        hex: "#E25C1E",
        imageFront: "/garments/la-apparel-hf09/LAA_14oz_brightorange.webp",
      },
      {
        slug: "chocolate",
        name: "Chocolate",
        hex: "#4B342A",
        imageFront: "/garments/la-apparel-hf09/LAA_14oz_chocolate.webp",
      },
      {
        slug: "clove",
        name: "Clove",
        hex: "#6B4032",
        imageFront: "/garments/la-apparel-hf09/LAA_14oz_clove.webp",
      },
      {
        slug: "cobaltblue",
        name: "Cobalt Blue",
        hex: "#1F3B7C",
        imageFront: "/garments/la-apparel-hf09/LAA_14oz_cobaltblue.webp",
      },
      {
        slug: "cream",
        name: "Cream",
        hex: "#EDE2C8",
        imageFront: "/garments/la-apparel-hf09/LAA_14oz_cream.webp",
      },
      {
        slug: "darkred",
        name: "Dark Red",
        hex: "#6E1B1B",
        imageFront: "/garments/la-apparel-hf09/LAA_14oz_darkred.webp",
      },
      {
        slug: "dolphinblue",
        name: "Dolphin Blue",
        hex: "#6B8395",
        imageFront: "/garments/la-apparel-hf09/LAA_14oz_dolphinblue.webp",
      },
      {
        slug: "ivy",
        name: "Ivy",
        hex: "#2C4A2E",
        imageFront: "/garments/la-apparel-hf09/LAA_14oz_ivy.webp",
      },
      {
        slug: "mushroom",
        name: "Mushroom",
        hex: "#8C7C6E",
        imageFront: "/garments/la-apparel-hf09/LAA_14oz_mushroom.webp",
      },
      {
        slug: "navy",
        name: "Navy",
        hex: "#1B2A4A",
        imageFront: "/garments/la-apparel-hf09/LAA_14oz_navy.webp",
      },
      {
        slug: "offblack",
        name: "Off Black",
        hex: "#232323",
        imageFront: "/garments/la-apparel-hf09/LAA_14oz_offblack.webp",
      },
      {
        slug: "patchouli",
        name: "Patchouli",
        hex: "#5D5036",
        imageFront: "/garments/la-apparel-hf09/LAA_14oz_patchouli.webp",
      },
      {
        slug: "rosequartz",
        name: "Rose Quartz",
        hex: "#D9B7B5",
        imageFront: "/garments/la-apparel-hf09/LAA_14oz_rosequartz.webp",
      },
      {
        slug: "sage",
        name: "Sage",
        hex: "#8B9A82",
        imageFront: "/garments/la-apparel-hf09/LAA_14oz_sage.webp",
      },
      {
        slug: "vintageblack",
        name: "Vintage Black",
        hex: "#3E3A37",
        imageFront: "/garments/la-apparel-hf09/LAA_14oz_vintageblack.webp",
      },
    ],
  },
  {
    id: "la-apparel-mineralwash-hf09",
    tier: "Premium",
    type: "Hoodie",
    name: "MW Heavy Fleece Pullover Hood, 14 oz",
    brand: "Los Angeles Apparel",
    weight: "14 oz",
    composition: "100% cotton",
    sizes: ["S", "M", "L", "XL"],
    blankCost: 42, // LAA 14oz mineral wash — per Jacob, Jul 2026
    note: "HF-09 MW. Mineral-washed finish, dyed after sewn for even coloring including stitching and ribbing. Shades vary within the same style and size. Color transfer may occur when wet; wash separately in cold water. 2X and up: stock check required. Made in Los Angeles.",
    colors: [
      {
        slug: "arctic",
        name: "Arctic",
        hex: "#8295B1",
        imageFront: "/garments/la-apparel-mineralwash-hf09/LAA_14oz_mineral_arctic.webp",
      },
      {
        slug: "carbon",
        name: "Carbon",
        hex: "#2D2C32",
        imageFront: "/garments/la-apparel-mineralwash-hf09/LAA_14oz_mineral_carbon.webp",
      },
      {
        slug: "cocoa",
        name: "Cocoa",
        hex: "#655651",
        imageFront: "/garments/la-apparel-mineralwash-hf09/LAA_14oz_mineral_cocoa.webp",
      },
      {
        slug: "icegrey",
        name: "Ice Grey",
        hex: "#ABB0B3",
        imageFront: "/garments/la-apparel-mineralwash-hf09/LAA_14oz_mineral_icegrey.webp",
      },
      {
        slug: "indigo",
        name: "Indigo",
        hex: "#354C6D",
        imageFront: "/garments/la-apparel-mineralwash-hf09/LAA_14oz_mineral_indigo.webp",
      },
      {
        slug: "limestone",
        name: "Limestone",
        hex: "#AAACA4",
        imageFront: "/garments/la-apparel-mineralwash-hf09/LAA_14oz_mineral_limestone.webp",
      },
      {
        slug: "matcha",
        name: "Matcha",
        hex: "#878F6B",
        imageFront: "/garments/la-apparel-mineralwash-hf09/LAA_14oz_mineral_matcha.webp",
      },
    ],
  },
  {
    id: "beanie",
    tier: "Studio",
    type: "Beanie",
    name: "Cuffed Knit Beanie",
    brand: "Los Angeles Apparel", // per the vendor folder Jacob dropped (LAA beanie)
    sizes: ["One size"],
    colors: [
          {
                "slug": "golden-olive-heather",
                "name": "Golden Olive Heather",
                "hex": "#745f1e",
                "imageFront": "/garments/beanie/Golden Olive Heather.webp"
          },
          {
                "slug": "grey-heather",
                "name": "Grey Heather",
                "hex": "#8a8c8e",
                "imageFront": "/garments/beanie/Grey Heather.webp"
          },
          {
                "slug": "hot-orange",
                "name": "Hot Orange",
                "hex": "#f7772c",
                "imageFront": "/garments/beanie/Hot Orange.webp"
          },
          {
                "slug": "light-grey",
                "name": "Light Grey",
                "hex": "#97979a",
                "imageFront": "/garments/beanie/Light Grey.webp"
          },
          {
                "slug": "oatmeal-heather",
                "name": "Oatmeal Heather",
                "hex": "#baab8f",
                "imageFront": "/garments/beanie/Oatmeal Heather.webp"
          },
          {
                "slug": "olive-heather",
                "name": "Olive Heather",
                "hex": "#3a3825",
                "imageFront": "/garments/beanie/Olive Heather.webp"
          },
          {
                "slug": "alabaster-heather",
                "name": "Alabaster Heather",
                "hex": "#b7aca6",
                "imageFront": "/garments/beanie/alabasterheather.webp"
          },
          {
                "slug": "black",
                "name": "Black",
                "hex": "#171513",
                "imageFront": "/garments/beanie/black.webp"
          },
          {
                "slug": "bleached",
                "name": "Bleached",
                "hex": "#e0e0e3",
                "imageFront": "/garments/beanie/bleached.webp"
          },
          {
                "slug": "brown",
                "name": "Brown",
                "hex": "#30201a",
                "imageFront": "/garments/beanie/brown.webp"
          },
          {
                "slug": "brown-heather",
                "name": "Brown Heather",
                "hex": "#7e716d",
                "imageFront": "/garments/beanie/brownheather.webp"
          },
          {
                "slug": "bubblegum",
                "name": "Bubblegum",
                "hex": "#f6bdc5",
                "imageFront": "/garments/beanie/bubblegum.webp"
          },
          {
                "slug": "burgundy",
                "name": "Burgundy",
                "hex": "#491a23",
                "imageFront": "/garments/beanie/burgundy.webp"
          },
          {
                "slug": "burgundy-heather",
                "name": "Burgundy Heather",
                "hex": "#491317",
                "imageFront": "/garments/beanie/burgundyheather.webp"
          },
          {
                "slug": "chive",
                "name": "Chive",
                "hex": "#788629",
                "imageFront": "/garments/beanie/chive.webp"
          },
          {
                "slug": "cobalt-blue",
                "name": "Cobalt Blue",
                "hex": "#1341bc",
                "imageFront": "/garments/beanie/cobaltblue.webp"
          },
          {
                "slug": "dark-brown-heather",
                "name": "Dark Brown Heather",
                "hex": "#523f36",
                "imageFront": "/garments/beanie/darkbrownheather.webp"
          },
          {
                "slug": "dark-grey",
                "name": "Dark Grey",
                "hex": "#4f535a",
                "imageFront": "/garments/beanie/darkgrey.webp"
          },
          {
                "slug": "dark-heather-grey",
                "name": "Dark Heather Grey",
                "hex": "#383538",
                "imageFront": "/garments/beanie/darkheathergrey.webp"
          },
          {
                "slug": "dark-navy",
                "name": "Dark Navy",
                "hex": "#161c2a",
                "imageFront": "/garments/beanie/darknavy.webp"
          },
          {
                "slug": "denim-heather",
                "name": "Denim Heather",
                "hex": "#3f425d",
                "imageFront": "/garments/beanie/denimheather.webp"
          },
          {
                "slug": "forest-green",
                "name": "Forest Green",
                "hex": "#324e40",
                "imageFront": "/garments/beanie/forestgreen.webp"
          },
          {
                "slug": "hunter-green",
                "name": "Hunter Green",
                "hex": "#162c2c",
                "imageFront": "/garments/beanie/huntergreen.webp"
          },
          {
                "slug": "kelly",
                "name": "Kelly",
                "hex": "#0e8f42",
                "imageFront": "/garments/beanie/kelly.webp"
          },
          {
                "slug": "light-blue",
                "name": "Light Blue",
                "hex": "#acdcec",
                "imageFront": "/garments/beanie/lightblue.webp"
          },
          {
                "slug": "mulberry",
                "name": "Mulberry",
                "hex": "#30234f",
                "imageFront": "/garments/beanie/mulberry.webp"
          },
          {
                "slug": "natural",
                "name": "Natural",
                "hex": "#deddcb",
                "imageFront": "/garments/beanie/natural.webp"
          },
          {
                "slug": "navy",
                "name": "Navy",
                "hex": "#332e42",
                "imageFront": "/garments/beanie/navy.webp"
          },
          {
                "slug": "neon-green",
                "name": "Neon Green",
                "hex": "#abf02f",
                "imageFront": "/garments/beanie/neongreen.webp"
          },
          {
                "slug": "neon-yellow",
                "name": "Neon Yellow",
                "hex": "#def54b",
                "imageFront": "/garments/beanie/neonyellow.webp"
          },
          {
                "slug": "olive",
                "name": "Olive",
                "hex": "#3e412a",
                "imageFront": "/garments/beanie/olive.webp"
          },
          {
                "slug": "red",
                "name": "Red",
                "hex": "#c00d22",
                "imageFront": "/garments/beanie/red.webp"
          },
          {
                "slug": "rust",
                "name": "Rust",
                "hex": "#80291a",
                "imageFront": "/garments/beanie/rust.webp"
          },
          {
                "slug": "stone",
                "name": "Stone",
                "hex": "#c0af98",
                "imageFront": "/garments/beanie/stone.webp"
          }
      ],
    blankCost: 0, // TODO: confirm with Jacob
    note: "Embroidery sits on the fold-up cuff. 34 colorways, front view only.",
  },
  {
    id: "laa-fleece-shorts",
    tier: "Studio",
    type: "Shorts",
    name: "12 oz Fleece Shorts",
    brand: "Los Angeles Apparel",
    weight: "12 oz",
    composition: "",
    sizes: ["One size"],
    colors: [
      { slug: "scour", name: "Scour", hex: "#dad0c5", imageFront: "/garments/laa-fleece-shorts/scour.webp", imageBack: "/garments/laa-fleece-shorts/scour-back.webp" },
    ],
    blankCost: 0, // TODO: confirm with Jacob
    note: "Imported Jul 2026 from vendor drop \"12oz Fleece Mens Shorts - la-apparel\".",
  },
  {
    id: "laa-dripdye-hood",
    tier: "Studio",
    type: "Hoodie",
    name: "Heavy Fleece Hood, Drip Dye",
    brand: "Los Angeles Apparel",
    weight: "14 oz",
    composition: "",
    sizes: ["One size"],
    colors: [
      { slug: "black-camo", name: "Black Camo", hex: "#414141", imageFront: "/garments/laa-dripdye-hood/black-camo.webp" },
      { slug: "olive-camo", name: "Olive Camo", hex: "#4a4538", imageFront: "/garments/laa-dripdye-hood/olive-camo.webp" },
    ],
    blankCost: 0, // TODO: confirm with Jacob
    note: "Imported Jul 2026 from vendor drop \"LAA 14OZ FLEECE PULLOVER DRIPDYE\".",
  },
  {
    id: "laa-dripdye-crew",
    tier: "Studio",
    type: "Crewneck",
    name: "Heavy Fleece Crew, Drip Dye",
    brand: "Los Angeles Apparel",
    weight: "14 oz",
    composition: "",
    sizes: ["One size"],
    colors: [
      { slug: "black-camo", name: "Black Camo", hex: "#3e3e3e", imageFront: "/garments/laa-dripdye-crew/black-camo.webp" },
      { slug: "olive-camo", name: "Olive Camo", hex: "#474335", imageFront: "/garments/laa-dripdye-crew/olive-camo.webp" },
    ],
    blankCost: 0, // TODO: confirm with Jacob
    note: "Imported Jul 2026 from vendor drop \"LAA 14oz Fleece Crewneck Drip Dye\".",
  },
  {
    id: "laa-1801gd",
    tier: "Studio",
    type: "T-Shirt",
    name: "1801GD Garment-Dyed Tee",
    brand: "Los Angeles Apparel",
    weight: "6.5 oz",
    composition: "",
    sizes: ["One size"],
    colors: [
      { slug: "army", name: "Army", hex: "#555943", imageFront: "/garments/laa-1801gd/army.webp", imageBack: "/garments/laa-1801gd/army-back.webp" },
      { slug: "ash", name: "Ash", hex: "#babec4", imageFront: "/garments/laa-1801gd/ash.webp", imageBack: "/garments/laa-1801gd/ash-back.webp" },
      { slug: "atlantic-green", name: "Atlantic Green", hex: "#78968f", imageFront: "/garments/laa-1801gd/atlantic-green.webp" },
      { slug: "beige", name: "Beige", hex: "#dcc9b5", imageFront: "/garments/laa-1801gd/beige.webp", imageBack: "/garments/laa-1801gd/beige-back.webp" },
      { slug: "black", name: "Black", hex: "#19191b", imageFront: "/garments/laa-1801gd/black.webp", imageBack: "/garments/laa-1801gd/black-back.webp" },
      { slug: "black-edge", name: "Black Edge", hex: "#232428", imageFront: "/garments/laa-1801gd/black-edge.webp", imageBack: "/garments/laa-1801gd/black-edge-back.webp" },
      { slug: "blue-moon", name: "Blue Moon", hex: "#427aa3", imageFront: "/garments/laa-1801gd/blue-moon.webp", imageBack: "/garments/laa-1801gd/blue-moon-back.webp" },
      { slug: "brass", name: "Brass", hex: "#86623a", imageFront: "/garments/laa-1801gd/brass.webp", imageBack: "/garments/laa-1801gd/brass-back.webp" },
      { slug: "brightorange", name: "Brightorange", hex: "#d3362a", imageFront: "/garments/laa-1801gd/brightorange.webp" },
      { slug: "cement", name: "Cement", hex: "#d9d7ce", imageFront: "/garments/laa-1801gd/cement.webp", imageBack: "/garments/laa-1801gd/cement-back.webp" },
      { slug: "charcoal", name: "Charcoal", hex: "#626365", imageFront: "/garments/laa-1801gd/charcoal.webp", imageBack: "/garments/laa-1801gd/charcoal-back.webp" },
      { slug: "chocolate", name: "Chocolate", hex: "#2b201e", imageFront: "/garments/laa-1801gd/chocolate.webp", imageBack: "/garments/laa-1801gd/chocolate-back.webp" },
      { slug: "clear-blue", name: "Clear Blue", hex: "#86a0bb", imageFront: "/garments/laa-1801gd/clear-blue.webp", imageBack: "/garments/laa-1801gd/clear-blue-back.webp" },
      { slug: "clove", name: "Clove", hex: "#473d3b", imageFront: "/garments/laa-1801gd/clove.webp" },
      { slug: "cobaltblue", name: "Cobaltblue", hex: "#2425a0", imageFront: "/garments/laa-1801gd/cobaltblue.webp", imageBack: "/garments/laa-1801gd/cobaltblue-back.webp" },
      { slug: "creme", name: "Creme", hex: "#ddd8cf", imageFront: "/garments/laa-1801gd/creme.webp", imageBack: "/garments/laa-1801gd/creme-back.webp" },
      { slug: "dark-red", name: "Dark Red", hex: "#850e24", imageFront: "/garments/laa-1801gd/dark-red.webp", imageBack: "/garments/laa-1801gd/dark-red-back.webp" },
      { slug: "dark-teal", name: "Dark Teal", hex: "#247080", imageFront: "/garments/laa-1801gd/dark-teal.webp", imageBack: "/garments/laa-1801gd/dark-teal-back.webp" },
      { slug: "dolphinblue", name: "Dolphinblue", hex: "#3c3f45", imageFront: "/garments/laa-1801gd/dolphinblue.webp", imageBack: "/garments/laa-1801gd/dolphinblue-back.webp" },
      { slug: "fuchsia", name: "Fuchsia", hex: "#f3347b", imageFront: "/garments/laa-1801gd/fuchsia.webp", imageBack: "/garments/laa-1801gd/fuchsia-back.webp" },
      { slug: "gold", name: "Gold", hex: "#df9710", imageFront: "/garments/laa-1801gd/gold.webp", imageBack: "/garments/laa-1801gd/gold-back.webp" },
      { slug: "ivy", name: "Ivy", hex: "#283a2b", imageFront: "/garments/laa-1801gd/ivy.webp" },
      { slug: "light-blue", name: "Light Blue", hex: "#cbd6df", imageFront: "/garments/laa-1801gd/light-blue.webp" },
      { slug: "light-grey", name: "Light Grey", hex: "#b7bbba", imageFront: "/garments/laa-1801gd/light-grey.webp" },
      { slug: "lotus", name: "Lotus", hex: "#ed629e", imageFront: "/garments/laa-1801gd/lotus.webp", imageBack: "/garments/laa-1801gd/lotus-back.webp" },
      { slug: "mauve", name: "Mauve", hex: "#805d67", imageFront: "/garments/laa-1801gd/mauve.webp" },
      { slug: "mushroom", name: "Mushroom", hex: "#c2bca5", imageFront: "/garments/laa-1801gd/mushroom.webp", imageBack: "/garments/laa-1801gd/mushroom-back.webp" },
      { slug: "navy", name: "Navy", hex: "#1a1d28", imageFront: "/garments/laa-1801gd/navy.webp" },
      { slug: "offwhite", name: "Offwhite", hex: "#e6e3de", imageFront: "/garments/laa-1801gd/offwhite.webp", imageBack: "/garments/laa-1801gd/offwhite-back.webp" },
      { slug: "patchouli", name: "Patchouli", hex: "#7f6964", imageFront: "/garments/laa-1801gd/patchouli.webp", imageBack: "/garments/laa-1801gd/patchouli-back.webp" },
      { slug: "pink", name: "Pink", hex: "#e0c8eb", imageFront: "/garments/laa-1801gd/pink.webp" },
      { slug: "pool", name: "Pool", hex: "#59bbd1", imageFront: "/garments/laa-1801gd/pool.webp", imageBack: "/garments/laa-1801gd/pool-back.webp" },
      { slug: "purple", name: "Purple", hex: "#392f53", imageFront: "/garments/laa-1801gd/purple.webp", imageBack: "/garments/laa-1801gd/purple-back.webp" },
      { slug: "rosequartz", name: "Rosequartz", hex: "#bf9c8d", imageFront: "/garments/laa-1801gd/rosequartz.webp", imageBack: "/garments/laa-1801gd/rosequartz-back.webp" },
      { slug: "sage", name: "Sage", hex: "#a1a59d", imageFront: "/garments/laa-1801gd/sage.webp", imageBack: "/garments/laa-1801gd/sage-back.webp" },
      { slug: "tomato", name: "Tomato", hex: "#b72532", imageFront: "/garments/laa-1801gd/tomato.webp", imageBack: "/garments/laa-1801gd/tomato-back.webp" },
      { slug: "vintageblack", name: "Vintageblack", hex: "#333130", imageFront: "/garments/laa-1801gd/vintageblack.webp", imageBack: "/garments/laa-1801gd/vintageblack-back.webp" },
      { slug: "white", name: "White", hex: "#dce0e3", imageFront: "/garments/laa-1801gd/white.webp", imageBack: "/garments/laa-1801gd/white-back.webp" },
    ],
    blankCost: 0, // TODO: confirm with Jacob
    note: "Imported Jul 2026 from vendor drop \"LAA 1801gd - Garment Dyed Crew 6.5oz\".",
  },
  {
    id: "laa-1801mw",
    tier: "Studio",
    type: "T-Shirt",
    name: "1801MW Mineral Wash Tee",
    brand: "Los Angeles Apparel",
    weight: "6.5 oz",
    composition: "",
    sizes: ["One size"],
    colors: [
      { slug: "arctic", name: "Arctic", hex: "#b2c6ea", imageFront: "/garments/laa-1801mw/arctic.webp", imageBack: "/garments/laa-1801mw/arctic-back.webp" },
      { slug: "carbon", name: "Carbon", hex: "#2e2f33", imageFront: "/garments/laa-1801mw/carbon.webp", imageBack: "/garments/laa-1801mw/carbon-back.webp" },
      { slug: "cocoa", name: "Cocoa", hex: "#49413f", imageFront: "/garments/laa-1801mw/cocoa.webp", imageBack: "/garments/laa-1801mw/cocoa-back.webp" },
      { slug: "ice-grey", name: "Ice Grey", hex: "#b9bac7", imageFront: "/garments/laa-1801mw/ice-grey.webp", imageBack: "/garments/laa-1801mw/ice-grey-back.webp" },
      { slug: "indigo", name: "Indigo", hex: "#4e6c92", imageFront: "/garments/laa-1801mw/indigo.webp", imageBack: "/garments/laa-1801mw/indigo-back.webp" },
      { slug: "limestone", name: "Limestone", hex: "#b3b6b2", imageFront: "/garments/laa-1801mw/limestone.webp", imageBack: "/garments/laa-1801mw/limestone-back.webp" },
      { slug: "matcha", name: "Matcha", hex: "#86947b", imageFront: "/garments/laa-1801mw/matcha.webp", imageBack: "/garments/laa-1801mw/matcha-back.webp" },
    ],
    blankCost: 0, // TODO: confirm with Jacob
    note: "Imported Jul 2026 from vendor drop \"LAA 1801mw - Mineral Wash Crew 6.5oz\".",
  },
  {
    id: "laa-tote",
    tier: "Studio",
    type: "Bag",
    name: "Bull Denim Tote",
    brand: "Los Angeles Apparel",
    weight: "14 oz bull denim",
    composition: "",
    sizes: ["One size"],
    colors: [
      { slug: "clear-blue", name: "Clear Blue", hex: "#849bb1", imageFront: "/garments/laa-tote/clear-blue.webp" },
    ],
    blankCost: 0, // TODO: confirm with Jacob
    note: "Imported Jul 2026 from vendor drop \"LAA Bull Denim Tote Bag\".",
  },
  {
    id: "laa-gym-bag",
    tier: "Studio",
    type: "Bag",
    name: "Diagonal Strap Gym Bag",
    brand: "Los Angeles Apparel",
    weight: "bull denim",
    composition: "",
    sizes: ["One size"],
    colors: [
      { slug: "light-pink", name: "Light Pink", hex: "#f3e5de", imageFront: "/garments/laa-gym-bag/light-pink.webp" },
      { slug: "natural-canvas", name: "Natural Canvas", hex: "#e4d7c6", imageFront: "/garments/laa-gym-bag/natural-canvas.webp" },
    ],
    blankCost: 0, // TODO: confirm with Jacob
    note: "Imported Jul 2026 from vendor drop \"LAA Diagonal Strap Gym Bag\".",
  },
  {
    id: "laa-zip-14oz",
    tier: "Studio",
    type: "Hoodie",
    name: "Heavy Fleece Zip Hood",
    brand: "Los Angeles Apparel",
    weight: "14 oz",
    composition: "",
    sizes: ["One size"],
    colors: [
      { slug: "ash", name: "Ash", hex: "#d0d0d0", imageFront: "/garments/laa-zip-14oz/ash.webp" },
      { slug: "navy", name: "Navy", hex: "#272b31", imageFront: "/garments/laa-zip-14oz/navy.webp" },
      { slug: "white", name: "White", hex: "#d7d7d7", imageFront: "/garments/laa-zip-14oz/white.webp" },
    ],
    blankCost: 0, // TODO: confirm with Jacob
    note: "Imported Jul 2026 from vendor drop \"LAA Heavy Fleece Zip Up 14 oz\".",
  },
  {
    id: "laa-thermal-shorts",
    tier: "Studio",
    type: "Shorts",
    name: "Heavy Thermal Shorts, Garment-Dyed",
    brand: "Los Angeles Apparel",
    weight: "heavy thermal",
    composition: "",
    sizes: ["One size"],
    colors: [
      { slug: "black", name: "Black", hex: "#272729", imageFront: "/garments/laa-thermal-shorts/black.webp", imageBack: "/garments/laa-thermal-shorts/black-back.webp" },
      { slug: "blue", name: "Blue", hex: "#3c3e45", imageFront: "/garments/laa-thermal-shorts/blue.webp", imageBack: "/garments/laa-thermal-shorts/blue-back.webp" },
      { slug: "creme", name: "Creme", hex: "#e0dbd2", imageFront: "/garments/laa-thermal-shorts/creme.webp", imageBack: "/garments/laa-thermal-shorts/creme-back.webp" },
      { slug: "white", name: "White", hex: "#e3e4e6", imageFront: "/garments/laa-thermal-shorts/white.webp", imageBack: "/garments/laa-thermal-shorts/white-back.webp" },
    ],
    blankCost: 0, // TODO: confirm with Jacob
    note: "Imported Jul 2026 from vendor drop \"LAA Hvy Thermal Garmnt Dye Shorts\".",
  },
];
