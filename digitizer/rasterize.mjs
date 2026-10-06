// Rasterize an SVG to a high-res PNG (black artwork on white) via headless
// Chrome, at a resolution tied to physical size: px-per-mm pixels per mm.
// Usage: node rasterize.mjs <input.svg> <output.png> <design-size-mm> <px-per-mm>
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [svgPath, outPath, sizeMmArg, ppmArg] = process.argv.slice(2);
const sizeMm = Number(sizeMmArg ?? 50.8);
const ppm = Number(ppmArg ?? 16);

const svgText = readFileSync(svgPath, "utf-8");
const vb = svgText.match(/viewBox="([\d.\s+-]+)"/)?.[1].trim().split(/\s+/).map(Number);
if (!vb || vb.length !== 4) throw new Error("no viewBox in " + svgPath);
const [, , vbW, vbH] = vb;
// The design fits a sizeMm × sizeMm square: the longer side gets sizeMm.
const scaleMm = sizeMm / Math.max(vbW, vbH);
const wPx = Math.round(vbW * scaleMm * ppm);
const hPx = Math.round(vbH * scaleMm * ppm);

const dir = mkdtempSync(join(tmpdir(), "rast-"));
const html = `<!doctype html><html><body style="margin:0;background:#ffffff">
<div style="width:${wPx}px;height:${hPx}px">${svgText.replace("<svg", `<svg width="${wPx}" height="${hPx}"`)}</div>
</body></html>`;
writeFileSync(join(dir, "page.html"), html);

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const proc = spawn(CHROME, [
  "--headless=new", "--disable-gpu", `--window-size=${wPx},${hPx}`,
  "--force-device-scale-factor=1", "--default-background-color=FFFFFFFF",
  `--screenshot=${outPath}`, `file://${join(dir, "page.html")}`,
], { stdio: "ignore" });
proc.on("exit", (code) => {
  rmSync(dir, { recursive: true, force: true });
  // Geometry on stdout for the digitizer.
  console.log(JSON.stringify({ wPx, hPx, mmPerPx: 1 / ppm, code }));
});
