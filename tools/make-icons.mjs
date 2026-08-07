// Generates the extension icons: a 2x2 status grid, matching the four states
// the popup renders. Run with `node tools/make-icons.mjs`.

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
const SIZES = [16, 32, 48, 128];

const BG = [22, 27, 34, 255];
const CELLS = [
  [63, 185, 80, 255], // green
  [219, 109, 40, 255], // orange
  [248, 81, 73, 255], // red
  [201, 209, 217, 255], // white
];

function render(size) {
  const px = (x, y) => (y * size + x) * 4;
  const data = new Uint8Array(size * size * 4);

  const radius = Math.max(2, Math.round(size * 0.18));
  const pad = Math.max(1, Math.round(size * 0.16));
  const gap = Math.max(1, Math.round(size * 0.08));
  const cell = (size - pad * 2 - gap) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = px(x, y);
      if (!insideRounded(x, y, size, radius)) continue; // transparent corners
      data.set(BG, i);

      const col = quadrant(x, pad, cell, gap);
      const row = quadrant(y, pad, cell, gap);
      if (col >= 0 && row >= 0) data.set(CELLS[row * 2 + col], i);
    }
  }
  return encodePng(size, size, data);
}

/** Which half of the grid a coordinate lands in, or -1 for padding/gap. */
function quadrant(v, pad, cell, gap) {
  if (v >= pad && v < pad + cell) return 0;
  if (v >= pad + cell + gap && v < pad + cell + gap + cell) return 1;
  return -1;
}

function insideRounded(x, y, size, r) {
  const cx = Math.min(Math.max(x, r), size - 1 - r);
  const cy = Math.min(Math.max(y, r), size - 1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// --- minimal PNG writer ----------------------------------------------------

function encodePng(width, height, rgba) {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from(raw), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  writeFileSync(join(OUT, `icon${size}.png`), render(size));
  console.log(`icons/icon${size}.png`);
}
