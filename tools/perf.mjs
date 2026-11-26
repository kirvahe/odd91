// Speed regression check (perf plan review 2026-11-26, С5). Run: npm run perf
// Not part of `npm test`: it takes about a minute and depends on the machine. It is built so a
// change cannot pass by accident:
//  1. frames of real width (6240 px, Ilya's 26 Mpx Fuji; docLongSide and the base level are fixed),
//     832 rows, through the same path as ps-bridge (pass 1 strips -> blurSteps -> pass 2 strips
//     with fineRadius rows of context);
//  2. before timing, the fine path must be engaged with the expected Gaussians, and the output
//     must match the frozen v1.1.0 core within 1 code on at most 1e-5 of the values (no skipped work);
//  3. two measures, both in the same process (core timers, scene generation excluded), medians of 7
//     runs after one warm-up run: the ratio of small-blur time to x1 time of the same scene (the fine
//     path), and the ratio of x1 time to the frozen v1.1.0 core's x1 time (the shared pass-2 code,
//     which the first ratio cannot see: slowing it down makes the first ratio better; review v1.1.1 С2);
//  4. the bounds lie between v1.1.1 and v1.1.0, so the old code fails them.
// Usage: node tools/perf.mjs [--core <dir with index.js>]  (another core: calibration only)
import { createRequire } from 'node:module';
import { fillStrip } from './scenes.mjs';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const coreDir = args.indexOf('--core') >= 0 ? args[args.indexOf('--core') + 1] : '../src/core';
const core = require(coreDir.startsWith('.') ? new URL(coreDir + '/index.js', import.meta.url).pathname : coreDir + '/index.js');
const ref = require('../test/helpers/core-v110/index.js');

const W = 6240;
const H = 832;
const LV = { docLongSide: 6240, baseLevel: 2 };
const ILYA = { model: 'excess', mode: 'reinhard', reinhardLimit: 1.0494, color: [255, 144, 39], blurMul: 0.1456, strength: 100, threshold: 202, softness: 32 };

// Bounds lie between the two versions (Apple M2 Pro, Node 24, 2026-11-26).
// Small / x1, v1.1.1 vs v1.1.0: lamps x0.1 5.7-6.7 / 11.6; lamps x0.5 3.2-3.5 / 5.4;
// night with Ilya's settings 1.3-1.5 / 5.7 (zero-skip off: 3.1). x1 / v1.1.0 x1: lamps 0.87-0.95,
// night 0.80. Not guarded: the table-start code search (it saves about 0.5 s only on full frames with
// a strong halo; on these 832-row frames the old search still passes) — bit-exact tests cover its result.
const CASES = [
  { name: 'lamps x0.1', scene: 'lamps', s: { strength: 30, blurMul: 0.1 }, base: { strength: 30, blurMul: 1 }, radii: [2, 6, 10, 6], bound: 8.5, baseBound: 1.0 },
  { name: 'lamps x0.5', scene: 'lamps', s: { strength: 30, blurMul: 0.5 }, base: { strength: 30, blurMul: 1 }, radii: [10], bound: 4.4, baseBound: 1.0 },
  { name: 'night, Ilya (scene-linear, x0.15, threshold 202)', scene: 'night', s: ILYA, base: Object.assign({}, ILYA, { blurMul: 1 }), radii: [3, 8, 9], bound: 2.2, baseBound: 0.9 },
];

function run(c, settings, collect) {
  const proc = c.createProcessor(Object.assign({ width: W, height: H, originX: 0, originY: 0, settings }, LV));
  const rows = proc.stripRows;
  const fr = proc.fineRadius || 0;
  const buf = new Uint8Array((rows + 2 * fr) * W * 3);
  const out = collect ? new Uint8Array(W * H * 3) : new Uint8Array(rows * W * 3);
  for (let y = 0; y < H; y += rows) {
    const n = Math.min(rows, H - y);
    fillStrip(currentScene, buf, W, H, y, n);
    proc.pass1(buf.subarray(0, n * W * 3), 3, y, n);
  }
  for (const _ of proc.blurSteps()) { /* to the end */ }
  for (let y = 0; y < H; y += rows) {
    const n = Math.min(rows, H - y);
    const d0 = Math.max(0, y - fr);
    const d1 = Math.min(H, y + n + fr);
    fillStrip(currentScene, buf, W, H, d0, d1 - d0);
    const o = collect ? out.subarray(y * W * 3, (y + n) * W * 3) : out.subarray(0, n * W * 3);
    if (fr) proc.pass2(buf.subarray(0, (d1 - d0) * W * 3), 3, y, n, o, { dataY0: d0, dataRows: d1 - d0 });
    else proc.pass2(buf.subarray(0, (d1 - d0) * W * 3), 3, y, n, o);
  }
  const t = proc.stats.timings;
  return { ms: t.pass1 + t.blur + t.pass2, proc, out };
}

function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
}

let currentScene = 'lamps';
let failed = 0;
for (const c of CASES) {
  currentScene = c.scene;
  // 2. engaged and correct
  const probe = run(core, c.s, true);
  const radii = probe.proc.stats.fine[0].gaussians.map((g) => g.radius);
  const engaged = probe.proc.fineRadius > 0 && JSON.stringify(radii) === JSON.stringify(c.radii);
  const expect = run(ref, c.s, true).out;
  let n = 0;
  let max = 0;
  for (let i = 0; i < expect.length; i++) {
    const d = Math.abs(expect[i] - probe.out[i]);
    if (d) {
      n++;
      if (d > max) max = d;
    }
  }
  const correct = max <= 1 && n / expect.length <= 1e-5;
  // 3. ratios, medians of 7 after a warm-up
  run(core, c.base, false);
  run(core, c.s, false);
  run(ref, c.base, false);
  const tb = [];
  const ts = [];
  const tr = [];
  for (let i = 0; i < 7; i++) {
    tb.push(run(core, c.base, false).ms);
    ts.push(run(core, c.s, false).ms);
    tr.push(run(ref, c.base, false).ms);
  }
  const ratio = median(ts) / median(tb);
  const baseRatio = median(tb) / median(tr);
  const ok = engaged && correct && ratio <= c.bound && baseRatio <= c.baseBound;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: small/x1 ${ratio.toFixed(2)} (bound ${c.bound}), x1/v1.1.0 ${baseRatio.toFixed(2)} (bound ${c.baseBound}); ` +
    `small ${median(ts)} ms, x1 ${median(tb)} ms, v1.1.0 x1 ${median(tr)} ms; ` +
    `fine radii ${JSON.stringify(radii)}${engaged ? '' : ' (expected ' + JSON.stringify(c.radii) + ')'}; vs v1.1.0: ${n} values differ, max ${max}`);
}
if (failed) {
  console.log(`${failed} case(s) failed`);
  process.exit(1);
}
