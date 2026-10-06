// Bayside. Thread inventory data.
// Source: Madeira Polyneon catalog (cone photo color sampling) + studio inventory.

export type Thread = {
  code: string;
  family: string;
  name: string;
  hex: string | null;
  isMetallic: boolean;
};

export const THREAD_FAMILIES: string[] = [
  "Green",
  "Blue",
  "Red",
  "Purple",
  "Pink",
  "Brown",
  "Yellow",
  "Orange",
  "White",
  "Grey",
  "Black",
  "Special",
];

export const THREADS: Thread[] = [
  // Green (20)
  { code: "1568", family: "Green", name: "Granite Green", hex: "#5C6753", isMetallic: false },
  { code: "1578", family: "Green", name: "Faded Jade", hex: "#779D8C", isMetallic: false },
  { code: "1650", family: "Green", name: "Fresh Pine", hex: "#3D6C36", isMetallic: false },
  { code: "1668", family: "Green", name: "Silver Sage", hex: "#64766A", isMetallic: false },
  { code: "1702", family: "Green", name: "Spearmint", hex: "#57B47F", isMetallic: false },
  { code: "1706", family: "Green", name: "Guacamole", hex: "#948949", isMetallic: false },
  { code: "1748", family: "Green", name: "Margarita Lime", hex: "#9BD254", isMetallic: false },
  { code: "1749", family: "Green", name: "Green Thumb", hex: "#028212", isMetallic: false },
  { code: "1750", family: "Green", name: "Christmas Green", hex: "#29684D", isMetallic: false },
  { code: "1768", family: "Green", name: "Celery", hex: "#9CB16D", isMetallic: false },
  { code: "1770", family: "Green", name: "Christmas Green", hex: "#1E3E14", isMetallic: false },
  { code: "1798", family: "Green", name: "Bass Green", hex: "#3F4034", isMetallic: false },
  { code: "1848", family: "Green", name: "Lime Green", hex: "#4A872F", isMetallic: false },
  { code: "1900", family: "Green", name: "Nile", hex: "#8FB289", isMetallic: false },
  { code: "1902", family: "Green", name: "Spruce Green", hex: "#28352C", isMetallic: false },
  { code: "1905", family: "Green", name: "Emerald Ink", hex: "#363E32", isMetallic: false },
  { code: "1940", family: "Green", name: "Key Lime", hex: "#CDD123", isMetallic: false },
  { code: "1968", family: "Green", name: "Dark Olive", hex: "#6B9659", isMetallic: false },
  { code: "1979", family: "Green", name: "Frosty Spruce", hex: "#1C503B", isMetallic: false },
  { code: "1988", family: "Green", name: "Kelly Green", hex: "#2D8746", isMetallic: false },

  // Blue (21)
  { code: "1532", family: "Blue", name: "Little Boy Blue", hex: "#73AAE2", isMetallic: false },
  { code: "1545", family: "Blue", name: "Winter Mint", hex: "#B7C8C9", isMetallic: false },
  { code: "1550", family: "Blue", name: "Light Periwinkle", hex: "#AFBAD5", isMetallic: false },
  { code: "1628", family: "Blue", name: "Worn Denim", hex: "#72A0C0", isMetallic: false },
  { code: "1642", family: "Blue", name: "Lapis", hex: "#082870", isMetallic: false },
  { code: "1671", family: "Blue", name: "Country Kitchen Blue", hex: "#557CA5", isMetallic: false },
  { code: "1674", family: "Blue", name: "Light Denim", hex: "#81ACD4", isMetallic: false },
  { code: "1676", family: "Blue", name: "Hanukkah Blue", hex: "#12276E", isMetallic: false },
  { code: "1685", family: "Blue", name: "Tree Frog", hex: "#016D85", isMetallic: false },
  { code: "1692", family: "Blue", name: "Limestone", hex: "#91BFBE", isMetallic: false },
  { code: "1694", family: "Blue", name: "Robin's Egg", hex: "#2C98AA", isMetallic: false },
  { code: "1733", family: "Blue", name: "Blue Jay", hex: "#195499", isMetallic: false },
  { code: "1766", family: "Blue", name: "Sailor Blue", hex: "#01044A", isMetallic: false },
  { code: "1775", family: "Blue", name: "Dark Federal Blue", hex: "#446E97", isMetallic: false },
  { code: "1828", family: "Blue", name: "Work Shirt", hex: "#5184AB", isMetallic: false },
  { code: "1830", family: "Blue", name: "Pea Coat", hex: "#5971B3", isMetallic: false },
  { code: "1842", family: "Blue", name: "China Blue", hex: "#022D8C", isMetallic: false },
  { code: "1871", family: "Blue", name: "Porcelain Blue", hex: "#73B0D3", isMetallic: false },
  { code: "1960", family: "Blue", name: "Dusty Blue", hex: "#6E8DA2", isMetallic: false },
  { code: "1967", family: "Blue", name: "Indigo", hex: "#061238", isMetallic: false },
  { code: "1977", family: "Blue", name: "Peacock Blue", hex: "#0159A8", isMetallic: false },

  // Red (13)
  { code: "1635", family: "Red", name: "Burgundy", hex: "#230105", isMetallic: false },
  { code: "1637", family: "Red", name: "Christmas Red", hex: "#8B0001", isMetallic: false },
  { code: "1747", family: "Red", name: "Tomato Red", hex: "#670002", isMetallic: false },
  { code: "1781", family: "Red", name: "Radish", hex: "#560105", isMetallic: false },
  { code: "1784", family: "Red", name: "Merlot", hex: "#2C0103", isMetallic: false },
  { code: "1835", family: "Red", name: "Bordeaux", hex: "#4B010E", isMetallic: false },
  { code: "1838", family: "Red", name: "Foxy Red", hex: "#9B2323", isMetallic: false },
  { code: "1839", family: "Red", name: "Lipstick", hex: "#700001", isMetallic: false },
  { code: "1878", family: "Red", name: "Salsa", hex: "#940101", isMetallic: false },
  { code: "1899", family: "Red", name: "Henna", hex: "#5E0903", isMetallic: false },
  { code: "1974", family: "Red", name: "Cinnamon Stick", hex: "#540D0D", isMetallic: false },
  { code: "4214", family: "Red", name: "Metallic", hex: null, isMetallic: true },
  { code: "7747", family: "Red", name: "Metallic", hex: null, isMetallic: true },

  // Purple (17)
  { code: "1627", family: "Purple", name: "Dusty Lilac", hex: "#6D5C7F", isMetallic: false },
  { code: "1631", family: "Purple", name: "Velvet Violet", hex: "#7E6398", isMetallic: false },
  { code: "1632", family: "Purple", name: "Plum Pudding", hex: "#1B0E25", isMetallic: false },
  { code: "1710", family: "Purple", name: "Magenta", hex: "#610136", isMetallic: false },
  { code: "1711", family: "Purple", name: "Lavender", hex: "#9987B3", isMetallic: false },
  { code: "1712", family: "Purple", name: "Lilac", hex: "#8F538A", isMetallic: false },
  { code: "1720", family: "Purple", name: "Plum", hex: "#2B041D", isMetallic: false },
  { code: "1766", family: "Purple", name: "Sailor Blue", hex: "#01044A", isMetallic: false },
  { code: "1767", family: "Purple", name: "Ultramarine", hex: "#010541", isMetallic: false },
  { code: "1785", family: "Purple", name: "Eggplant", hex: "#532F3B", isMetallic: false },
  { code: "1831", family: "Purple", name: "Purple Pansy", hex: "#91649C", isMetallic: false },
  { code: "1833", family: "Purple", name: "Heliotrope", hex: "#3D013E", isMetallic: false },
  { code: "1880", family: "Purple", name: "Deep Lilac", hex: "#624274", isMetallic: false },
  { code: "1911", family: "Purple", name: "Lilac", hex: "#BFA9CD", isMetallic: false },
  { code: "1922", family: "Purple", name: "Regal Purple", hex: "#43337A", isMetallic: false },
  { code: "1930", family: "Purple", name: "Sailor Blue", hex: "#171C6E", isMetallic: false },
  { code: "1943", family: "Purple", name: "Dark Periwinkle", hex: "#6073B9", isMetallic: false },

  // Pink (14)
  { code: "1616", family: "Pink", name: "Cinnabar", hex: "#D86D67", isMetallic: false },
  { code: "1653", family: "Pink", name: "Peach Blossom", hex: "#E0AB93", isMetallic: false },
  { code: "1681", family: "Pink", name: "Azalea", hex: "#890217", isMetallic: false },
  { code: "1752", family: "Pink", name: "Cantalope", hex: "#E09764", isMetallic: false },
  { code: "1787", family: "Pink", name: "Cherry Pie", hex: "#A8426E", isMetallic: false },
  { code: "1815", family: "Pink", name: "Baby Pink", hex: "#E9C1D5", isMetallic: false },
  { code: "1817", family: "Pink", name: "Pleasant Peach", hex: "#E9967B", isMetallic: false },
  { code: "1820", family: "Pink", name: "Peach Tea", hex: "#E88B70", isMetallic: false },
  { code: "1882", family: "Pink", name: "Apricot", hex: "#E6B18F", isMetallic: false },
  { code: "1917", family: "Pink", name: "Dusty Rose", hex: "#C06170", isMetallic: false },
  { code: "1919", family: "Pink", name: "English Rose", hex: "#914B57", isMetallic: false },
  { code: "1941", family: "Pink", name: "Mauve", hex: "#B68888", isMetallic: false },
  { code: "1984", family: "Pink", name: "Mince Pie", hex: "#81011B", isMetallic: false },
  { code: "1990", family: "Pink", name: "Fuchsia", hex: "#B82668", isMetallic: false },

  // Brown (19)
  { code: "1557", family: "Brown", name: "Mud Facial", hex: "#7E6E5F", isMetallic: false },
  { code: "1558", family: "Brown", name: "Mud Pie", hex: "#5C4B3F", isMetallic: false },
  { code: "1654", family: "Brown", name: "Cocoa", hex: "#664F4C", isMetallic: false },
  { code: "1656", family: "Brown", name: "Fawn", hex: "#BF9A88", isMetallic: false },
  { code: "1657", family: "Brown", name: "Coffee Bean", hex: "#875B43", isMetallic: false },
  { code: "1658", family: "Brown", name: "Mocha", hex: "#794639", isMetallic: false },
  { code: "1663", family: "Brown", name: "Clove", hex: "#6E6355", isMetallic: false },
  { code: "1726", family: "Brown", name: "Light Brown Sugar", hex: "#B5805A", isMetallic: false },
  { code: "1729", family: "Brown", name: "Fawn", hex: "#967B6C", isMetallic: false },
  { code: "1745", family: "Brown", name: "Toasted Marshmellow", hex: "#765D53", isMetallic: false },
  { code: "1773", family: "Brown", name: "Autumn Gold", hex: "#B06632", isMetallic: false },
  { code: "1854", family: "Brown", name: "Cocoa", hex: "#9C8480", isMetallic: false },
  { code: "1859", family: "Brown", name: "Bittersweet Chocolate", hex: "#4B3F3E", isMetallic: false },
  { code: "1872", family: "Brown", name: "Brunette", hex: "#635142", isMetallic: false },
  { code: "1884", family: "Brown", name: "Burly Wood", hex: "#C5A98D", isMetallic: false },
  { code: "1927", family: "Brown", name: "Shiny Penny", hex: "#DCB192", isMetallic: false },
  { code: "1938", family: "Brown", name: "Doe Skin", hex: "#B9A999", isMetallic: false },
  { code: "1942", family: "Brown", name: "Rose Gold", hex: "#8F5653", isMetallic: false },
  { code: "1945", family: "Brown", name: "Sienna", hex: "#724F46", isMetallic: false },

  // Yellow (3)
  { code: "1623", family: "Yellow", name: "Pumpkin Chiffon", hex: "#F2DD03", isMetallic: false },
  { code: "1670", family: "Yellow", name: "Khaki", hex: "#D5A768", isMetallic: false },
  { code: "1772", family: "Yellow", name: "Military Gold", hex: "#C48901", isMetallic: false },

  // Orange (2)
  { code: "1678", family: "Orange", name: "Pumpkin", hex: "#CA2801", isMetallic: false },
  { code: "1765", family: "Orange", name: "Pumpkin", hex: "#D26201", isMetallic: false },

  // White (5)
  { code: "1661", family: "White", name: "Light Apricot", hex: "#E1D8BE", isMetallic: false },
  { code: "1801", family: "White", name: "Snow White", hex: "#B8BECF", isMetallic: false },
  { code: "1802", family: "White", name: "Natural White", hex: "#ECEDFF", isMetallic: false },
  { code: "1803", family: "White", name: "Cream White", hex: "#EDECDF", isMetallic: false },
  { code: "1949", family: "White", name: "Moonbeam", hex: "#F0E7D4", isMetallic: false },

  // Grey (7)
  { code: "1615", family: "Grey", name: "Iron Gray", hex: "#707676", isMetallic: false },
  { code: "1718", family: "Grey", name: "Chrome", hex: "#919BA2", isMetallic: false },
  { code: "1741", family: "Grey", name: "Gun Metal", hex: "#747573", isMetallic: false },
  { code: "1811", family: "Grey", name: "Weimaraner", hex: "#A9B0B1", isMetallic: false },
  { code: "1812", family: "Grey", name: "Pussy Willow", hex: "#A9AAA4", isMetallic: false },
  { code: "1840", family: "Grey", name: "Fluorescent White", hex: "#747D87", isMetallic: false },
  { code: "1918", family: "Grey", name: "Sterling Silver", hex: "#8A8B8E", isMetallic: false },

  // Black (4)
  { code: "1500", family: "Black", name: "Black (off-shade)", hex: "#1A1A1A", isMetallic: false },
  { code: "1560", family: "Black", name: "Espresso", hex: "#3A2A1F", isMetallic: false },
  { code: "1800", family: "Black", name: "Black", hex: "#030305", isMetallic: false },
  { code: "1844", family: "Black", name: "Indigo", hex: "#030208", isMetallic: false },

  // Special (1)
  { code: "7946", family: "Special", name: "Supertwist Metallic", hex: null, isMetallic: true },
];
