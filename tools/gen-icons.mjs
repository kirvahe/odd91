#!/usr/bin/env node
// Generates the plugin icons (a warm glowing dot) as RGBA PNGs, no dependencies.
// Output: src/plugin/icons/{plugin,panel-dark,panel-light}{,@1x,@2x}.png
// The unsuffixed file is a copy of @1x, kept as a fallback for hosts that
// ignore the "scale" suffix convention.
//
// Usage: node tools/gen-icons.mjs

import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "plugin", "icons");

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy
      ? rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
      : raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// A bright warm core with an orange-red halo that fades out.
// `rim` adds a thin darker ring so the dot stays visible on light themes.
function drawDot(size, { rim = false } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const ss = 4; // supersampling per axis
  const c = size / 2;
  const R = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const dx = (x + (sx + 0.5) / ss - c) / R;
          const dy = (y + (sy + 0.5) / ss - c) / R;
          const r = Math.sqrt(dx * dx + dy * dy);
          // core disc
          const coreA = r < 0.30 ? 1 : r < 0.36 ? (0.36 - r) / 0.06 : 0;
          // halo: exponential falloff, cut at the icon edge
          const haloA = r < 0.98 ? Math.min(1, 0.95 * Math.exp(-(r - 0.25) / 0.20)) * (r > 0.25 ? 1 : 1) : 0;
          let cr = 255, cg = 104, cb = 28, ca = haloA; // halo colour
          if (rim && r > 0.84 && r < 0.95) {
            const t = 1 - Math.abs(r - 0.895) / 0.055;
            cr = 150; cg = 52; cb = 14; ca = Math.max(ca, 0.85 * t);
          }
          // composite core over halo
          const coreR = 255, coreG = 238, coreB = 205;
          const oa = coreA + ca * (1 - coreA);
          if (oa > 0) {
            ar += (coreR * coreA + cr * ca * (1 - coreA));
            ag += (coreG * coreA + cg * ca * (1 - coreA));
            ab += (coreB * coreA + cb * ca * (1 - coreA));
            aa += oa;
          }
        }
      }
      const n = ss * ss;
      const a = aa / n;
      const i = (y * size + x) * 4;
      if (a > 0) {
        px[i] = Math.round(ar / aa);
        px[i + 1] = Math.round(ag / aa);
        px[i + 2] = Math.round(ab / aa);
        px[i + 3] = Math.round(a * 255);
      }
    }
  }
  return px;
}

const SETS = [
  { name: "plugin", base: 24, rim: false },
  { name: "panel-dark", base: 23, rim: false },
  { name: "panel-light", base: 23, rim: true },
];

export function generateIcons(outDir = OUT) {
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const s of SETS) {
    for (const scale of [1, 2]) {
      const size = s.base * scale;
      const png = encodePng(size, size, drawDot(size, { rim: s.rim }));
      const file = join(outDir, `${s.name}@${scale}x.png`);
      writeFileSync(file, png);
      written.push(file);
      if (scale === 1) {
        const plain = join(outDir, `${s.name}.png`);
        writeFileSync(plain, png);
        written.push(plain);
      }
    }
  }
  return written;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("gen-icons.mjs")) {
  const files = generateIcons();
  for (const f of files) console.log("icon:", f.replace(ROOT + "/", ""));
}
