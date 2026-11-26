// Speed and memory benchmark of the core. Run: npm run bench (with a JIT: UXP in Photoshop has one,
// Ilya's v1.0 apply took 3.6 s) or npm run bench:jitless (worst case, the v1.0 design target).
// Strips are generated on the fly (tools/scenes.mjs), so the arrayBuffers peak is the core's own
// memory; times are the core's own pass timers, scene generation excluded.
// Usage: node tools/bench.mjs [sizes...]   default: 6000x4000 6240x4160 8256x5504
import { createRequire } from 'node:module';
import { runApply, fillStrip } from './scenes.mjs';

const require = createRequire(import.meta.url);
const core = require('../src/core/index.js');
const sizes = process.argv.slice(2).length ? process.argv.slice(2) : ['6000x4000', '6240x4160', '8256x5504'];
const ILYA = { model: 'excess', mode: 'reinhard', reinhardLimit: 1.0494, color: [255, 144, 39], blurMul: 0.1456, strength: 100, threshold: 202, softness: 32 };
const CASES = [
  ['lamps', 'x1', { strength: 30, blurMul: 1 }],
  ['lamps', 'x0.5', { strength: 30, blurMul: 0.5 }],
  ['lamps', 'x0.3', { strength: 30, blurMul: 0.3 }],
  ['lamps', 'x0.1', { strength: 30, blurMul: 0.1 }],
  ['lamps', 'x0.03', { strength: 30, blurMul: 0.03 }],
  ['night', 'Ilya x1', Object.assign({}, ILYA, { blurMul: 1 })],
  ['night', 'Ilya x0.15', ILYA],
];

console.log(`node ${process.version}, ${process.execArgv.includes('--jitless') ? 'jitless' : 'JIT'}`);
for (const s of sizes) {
  const [w, h] = s.split('x').map(Number);
  for (const [scene, label, settings] of CASES) {
    let peak = 0;
    const base0 = process.memoryUsage().arrayBuffers;
    const sample = () => {
      const m = process.memoryUsage().arrayBuffers;
      if (m > peak) peak = m;
    };
    const { proc } = runApply(core, scene, w, h, settings, { onStrip: sample });
    const st = proc.stats;
    const t = st.timings;
    console.log([
      s.padEnd(10), scene.padEnd(6), label.padEnd(11),
      `core ${((t.pass1 + t.blur + t.pass2) / 1000).toFixed(2)} s`,
      `(pass1 ${t.pass1}, blur ${t.blur}, pass2 ${t.pass2}, of it fine ${t.fine} ms)`,
      `base L${st.baseLevel}, fine radii ${JSON.stringify(st.fine[0].gaussians.map((g) => g.radius))}`,
      `peak ${Math.round((peak - base0) / 1048576)} MB`,
    ].join('  '));
  }
  // preview: build the cache from strips, then time re-renders
  const rows = Math.max(1, Math.floor(1e6 / w));
  const strip = new Uint8Array(rows * w * 3);
  const t0 = Date.now();
  const pb = core.createPreviewBuilder({ width: w, height: h, maxLongSide: 500 });
  for (let y = 0; y < h; y += rows) {
    const n = Math.min(rows, h - y);
    fillStrip('lamps', strip, w, h, y, n);
    pb.push(strip.subarray(0, n * w * 3), 3, y, n);
  }
  const proxy = pb.finish();
  const t1 = Date.now();
  core.renderPreview(proxy, { strength: 30 }, 'after', { docLongSide: Math.max(w, h) });
  const t2 = Date.now();
  core.renderPreview(proxy, { strength: 30 }, 'after', { docLongSide: Math.max(w, h), draft: true });
  const t3 = Date.now();
  console.log(`${s.padEnd(10)} preview: build ${((t1 - t0) / 1000).toFixed(2)} s (generation included), render ${t2 - t1} ms, draft ${t3 - t2} ms, ${proxy.width}x${proxy.height}`);
}
