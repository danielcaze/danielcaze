// One-off: converts a photo into a fixed-width ASCII (symbols-only) block,
// printed as a JS array literal to paste into generate.mjs as the ART constant.
// Not run by the Action — the art is static, only the stats refresh daily.
import { Jimp } from "jimp";

const SRC = process.argv[2];
const COLS = 50;
const ROWS = 32; // monospace glyphs are ~1.7x taller than wide, so more cols than rows

// short, coarse ramp (dark -> light) — fewer levels reads cleaner at low res
const RAMP = "@%#+=-:. ".split("");

function intToRGBA(hex) {
  return { r: (hex >> 24) & 255, g: (hex >> 16) & 255, b: (hex >> 8) & 255, a: hex & 255 };
}

let img = await Jimp.read(SRC);

// auto-crop transparent padding so the subject fills the frame
{
  const w = img.bitmap.width;
  const h = img.bitmap.height;
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = img.getPixelColor(x, y) & 255;
      if (a >= 40) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.04);
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  const cropW = Math.min(w - minX, maxX - minX + 1 + pad * 2);
  const cropH = Math.min(h - minY, maxY - minY + 1 + pad * 2);
  img = img.crop({ x: minX, y: minY, w: cropW, h: cropH });
}

img.resize({ w: COLS, h: ROWS });

// sample luminance + alpha per cell
const cells = [];
let lo = 1, hi = 0;
for (let y = 0; y < ROWS; y++) {
  const row = [];
  for (let x = 0; x < COLS; x++) {
    const { r, g, b, a } = intToRGBA(img.getPixelColor(x, y));
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (a >= 40) {
      lo = Math.min(lo, lum);
      hi = Math.max(hi, lum);
    }
    row.push({ lum, a });
  }
  cells.push(row);
}
const range = Math.max(0.05, hi - lo);

const lines = [];
for (let y = 0; y < ROWS; y++) {
  let row = "";
  for (let x = 0; x < COLS; x++) {
    const { lum, a } = cells[y][x];
    if (a < 40) {
      row += " ";
      continue;
    }
    const stretched = Math.min(1, Math.max(0, (lum - lo) / range)); // contrast stretch
    const idx = Math.min(RAMP.length - 1, Math.floor(stretched * RAMP.length));
    row += RAMP[idx];
  }
  lines.push(row.replace(/\s+$/, ""));
}

console.log("export const ART = " + JSON.stringify(lines, null, 2) + ";");
