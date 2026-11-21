// Side-by-side: hotgluebanjo Proosa (faithful port) vs old normalized vs new excess, on a 230 square edge.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { encodePng } from './gen-icons.mjs';
const require = createRequire(import.meta.url);
const core = require('../src/core/index.js');
const T = core._internal.transfer;

const W = 240, H = 160;
const src = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) src[i * 4 + 3] = 255;
for (let y = 40; y < 120; y++) for (let x = 100; x < 240; x++) { const p = (y * W + x) * 4; src[p] = src[p + 1] = src[p + 2] = 230; }
// three small 255 lamps on the dark side
for (const [cx, cy] of [[40, 50], [60, 110], [30, 80]]) for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) { const p = ((cy + y) * W + cx + x) * 4; src[p] = src[p + 1] = src[p + 2] = 255; }

function proosa(size, colorG) {
  const lin = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) lin[i * 3 + c] = T.SRGB_LUT[src[i * 4 + c]];
  const R = Math.ceil(4.5 * size), kw = []; let ws = 0;
  for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) { const v = Math.exp(-Math.hypot(i, j) / size); kw.push(v); ws += v; }
  const out = new Uint8Array(W * H * 4), color = [1, colorG, 0];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let b = [0, 0, 0], k = 0;
    for (let j = -R; j <= R; j++) { const yy = Math.min(H - 1, Math.max(0, y + j)); for (let i = -R; i <= R; i++) { const xx = Math.min(W - 1, Math.max(0, x + i)); const q = (yy * W + xx) * 3, wt = kw[k++]; b[0] += wt * lin[q]; b[1] += wt * lin[q + 1]; b[2] += wt * lin[q + 2]; } }
    const p = y * W + x;
    for (let c = 0; c < 3; c++) out[p * 4 + c] = Math.round(T.linearToSrgb((lin[p * 3 + c] + (b[c] / ws) * color[c]) / (color[c] + 1)) * 255);
    out[p * 4 + 3] = 255;
  }
  return out;
}
const opts = { docLongSide: 1600 };
const panels = [
  ['Proosa SIZE 3 (hotgluebanjo)', proosa(3, 0.15)],
  ['old: normalized, strength 100', core.processImage(src, W, H, 4, { model: 'normalized', strength: 100, blur: 100 }, opts)],
  ['new: excess, strength 100', core.processImage(src, W, H, 4, { model: 'excess', strength: 100, blur: 100 }, opts)],
];
const Z = 3, GAP = 6, PW = 140; // crop x 30..170 around the edge, magnify 3x
const outW = panels.length * PW * Z + (panels.length - 1) * GAP, outH = H * Z;
const img = new Uint8Array(outW * outH * 4).fill(255);
panels.forEach(([, d], n) => {
  for (let y = 0; y < outH; y++) for (let x = 0; x < PW * Z; x++) {
    const sx = 30 + Math.floor(x / Z), sy = Math.floor(y / Z), s = (sy * W + sx) * 4;
    const t = (y * outW + n * (PW * Z + GAP) + x) * 4;
    img[t] = d[s]; img[t + 1] = d[s + 1]; img[t + 2] = d[s + 2]; img[t + 3] = 255;
  }
  const row = (y, x0) => { const p = (y * W + x0) * 4; return `${d[p]},${d[p + 1]},${d[p + 2]}`; };
  console.log(panels[n][0].padEnd(32), 'inner edge x=100..104:', [100, 101, 102, 103, 104].map((x) => row(80, x)).join(' '), '| lamp centre:', row(50, 40));
});
writeFileSync(new URL('../tmp/compare-models.png', import.meta.url), encodePng(outW, outH, img));
console.log('wrote tmp/compare-models.png', outW, 'x', outH);
