// Speed and memory benchmark of the core. Run with: node --jitless tools/bench.mjs [sizes]
// Strips are generated on the fly (no full-size source in memory), so the arrayBuffers peak
// is the core's own memory. Usage: node --jitless tools/bench.mjs 6000x4000 9504x6336
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../src/core/index.js');

const sizes = process.argv.slice(2).length ? process.argv.slice(2) : ['6000x4000', '9504x6336'];

function fillStrip(buf, w, y0, rows) {
  // dark gradient with bright "lamps" every 500 px
  let p = 0;
  for (let ry = 0; ry < rows; ry++) {
    const y = y0 + ry;
    for (let x = 0; x < w; x++) {
      const lamp = (x % 500) < 6 && (y % 500) < 6;
      const g = (x * 7 + y * 3) & 127;
      buf[p] = lamp ? 255 : g;
      buf[p + 1] = lamp ? 255 : (g >> 1);
      buf[p + 2] = lamp ? 255 : (g >> 2);
      p += 3;
    }
  }
}

let peak = 0;
function sample() {
  const m = process.memoryUsage().arrayBuffers;
  if (m > peak) peak = m;
}

for (const s of sizes) {
  const [w, h] = s.split('x').map(Number);
  peak = 0;
  const base0 = process.memoryUsage().arrayBuffers;
  const t0 = Date.now();
  const proc = core.createProcessor({ width: w, height: h, originX: 0, originY: 0, docLongSide: Math.max(w, h), settings: { strength: 30, blur: 50 } });
  const rows = proc.stripRows;
  const strip = new Uint8Array(rows * w * 3);
  const out = new Uint8Array(rows * w * 3);
  for (let y = 0; y < h; y += rows) {
    const n = Math.min(rows, h - y);
    fillStrip(strip, w, y, n);
    proc.pass1(strip.subarray(0, n * w * 3), 3, y, n);
    sample();
  }
  const t1 = Date.now();
  let steps = 0;
  for (const _ of proc.blurSteps()) { steps++; sample(); }
  const t2 = Date.now();
  for (let y = 0; y < h; y += rows) {
    const n = Math.min(rows, h - y);
    fillStrip(strip, w, y, n);
    proc.pass2(strip.subarray(0, n * w * 3), 3, y, n, out.subarray(0, n * w * 3));
    sample();
  }
  const t3 = Date.now();
  // preview: build the cache from strips, then time one re-render
  const pb = core.createPreviewBuilder({ width: w, height: h, maxLongSide: 500 });
  for (let y = 0; y < h; y += rows) {
    const n = Math.min(rows, h - y);
    fillStrip(strip, w, y, n);
    pb.push(strip.subarray(0, n * w * 3), 3, y, n);
  }
  const proxy = pb.finish();
  const t4 = Date.now();
  core.renderPreview(proxy, { strength: 30 }, 'after', { docLongSide: Math.max(w, h) });
  const t5 = Date.now();
  core.renderPreview(proxy, { strength: 30, mode: 'curve' }, 'after', { docLongSide: Math.max(w, h) });
  const t6 = Date.now();
  core.renderPreview(proxy, { strength: 30 }, 'after', { docLongSide: Math.max(w, h), draft: true });
  const t7 = Date.now();
  core.renderPreview(proxy, { strength: 40 }, 'after', { docLongSide: Math.max(w, h), draft: true });
  const t8 = Date.now();
  const st = proc.stats;
  console.log(JSON.stringify({
    size: s,
    mpx: +(w * h / 1e6).toFixed(1),
    jitless: process.execArgv.includes('--jitless'),
    baseLevel: st.baseLevel,
    gaussians: st.gaussians.map((g) => `${g.kind}@L${g.level}:${g.s.toFixed(2)}`).join(' '),
    blurSteps: steps,
    pass1_s: (t1 - t0) / 1000,
    blur_s: (t2 - t1) / 1000,
    pass2_s: (t3 - t2) / 1000,
    total_s: (t3 - t0) / 1000,
    peakArrayBuffersMB: Math.round((peak - base0) / 1048576),
    previewBuild_s: (t4 - t3) / 1000,
    previewRender_ms: t5 - t4,
    previewRenderCurve_ms: t6 - t5,
    draftFirst_ms: t7 - t6,
    draftRender_ms: t8 - t7,
    previewSize: `${proxy.width}x${proxy.height}`,
  }));
}
