'use strict';
// v1.1.2 changes no arithmetic in the core: timers, counters, the halo radii for the panel and
// the speed probe for the diagnostics report. The output must stay bit-identical to v1.1.1.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');
const v111 = require('./helpers/core-v111');

function scene(w, h, seed, comps) {
  let a = seed >>> 0;
  const R = () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 4294967296;
  };
  const d = new Uint8Array(w * h * comps);
  for (let i = 0; i < w * h; i++) {
    const n = 20 + ((R() * 70) | 0);
    d[i * comps] = n;
    d[i * comps + 1] = (n * 0.8) | 0;
    d[i * comps + 2] = (n * 0.6) | 0;
    if (comps === 4) d[i * comps + 3] = i % w < w * 0.1 ? 0 : Math.min(255, (((i % w) / w) * 400) | 0);
  }
  for (let k = 0; k < 30; k++) {
    const cx = (R() * w) | 0;
    const cy = (R() * h) | 0;
    const rad = 1 + ((R() * 12) | 0);
    for (let y = Math.max(0, cy - rad); y <= Math.min(h - 1, cy + rad); y++) {
      for (let x = Math.max(0, cx - rad); x <= Math.min(w - 1, cx + rad); x++) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > rad * rad) continue;
        const p = (y * w + x) * comps;
        d[p] = 255;
        d[p + 1] = 200;
        d[p + 2] = 110;
      }
    }
  }
  return d;
}

const L2 = { docLongSide: 6240, baseLevel: 2 };
const SETS = [
  [{ model: 'excess', mode: 'reinhard', reinhardLimit: 1.0296, color: [255, 144, 39], blurMul: 0.1456, strength: 159, threshold: 198, softness: 32 }, L2],
  [{ mode: 'srgb', color: [255, 96, 32], blurMul: 0.2, strength: 50, threshold: 220, softness: 130 }, L2],
  [{ strength: 100, blurMul: 0.15 }, L2],
  [{ strength: 70, blurMul: 0.2, radii: [1, 0.7, 1.4] }, L2],
  [{ model: 'normalized', mode: 'curve', strength: 60, blurMul: 0.05 }, L2],
  [{ strength: 30, blurMul: 1 }, { docLongSide: 6000, baseLevel: 1 }],
  [{ strength: 400, blurMul: 2, mode: 'reinhard', reinhardLimit: 1.01 }, {}],
];

test('v1.1.2 output is bit-identical to v1.1.1 (after and halo views, RGB and RGBA, any strip height)', () => {
  for (const [w, h] of [[640, 427], [637, 211]]) {
    for (const comps of [3, 4]) {
      const d = scene(w, h, 21, comps);
      for (const [s, lv] of SETS) {
        for (const view of ['after', 'halo']) {
          const o = Object.assign({ view }, lv);
          assert.deepEqual(core.processImage(d, w, h, comps, s, o), v111.processImage(d, w, h, comps, s, o), `${w}x${h} comps ${comps} ${view} ${JSON.stringify(s)}`);
        }
        const o13 = Object.assign({ stripRows: 13 }, lv);
        assert.deepEqual(core.processImage(d, w, h, comps, s, o13), v111.processImage(d, w, h, comps, s, lv), 'strip height');
      }
    }
  }
});

test('halo radii: r50 and r90 follow from the kernel itself and scale with the frame', () => {
  const f = core.haloRadiusFactors();
  // independent check: light of the kernel's Gaussians inside the radius, at lambda = 1
  const gs = core._internal.kernelGaussians({ blurMul: 1 }, 1 / core.LAMBDA_FRACTION, 1)[0];
  const total = gs.reduce((a, g) => a + g.weight, 0);
  const inside = (r) => gs.reduce((a, g) => a + g.weight * (1 - Math.exp((-r * r) / (2 * g.sigma * g.sigma))), 0) / total;
  assert.ok(Math.abs(inside(f.r50) - 0.5) < 1e-9, 'half of the light inside r50');
  assert.ok(Math.abs(inside(f.r90) - 0.9) < 1e-9, '90 % of the light inside r90');
  // the numbers the panel text and the docs quote; a change of LOBES/EXP_FIT must revisit them
  assert.ok(Math.abs(f.r50 - 2.5104) < 5e-4 && Math.abs(f.r90 - 8.958) < 5e-3, JSON.stringify(f));
  assert.ok(Math.abs(100 * f.r50 * core.LAMBDA_FRACTION - 0.45) < 0.005, 'x1: half of the light within 0.45 % of the long side');

  const a = core.haloRadii({ blurMul: 0.1456 }, 6240);
  assert.ok(Math.abs(a.r50 - 4.105) < 0.01 && Math.abs(a.r90 - 14.65) < 0.02, JSON.stringify(a));
  // the blur is a share of the frame: twice the long side, twice the pixels
  const b = core.haloRadii({ blurMul: 0.1456 }, 12480);
  assert.ok(Math.abs(b.r50 / a.r50 - 2) < 1e-12 && Math.abs(b.r90 / a.r90 - 2) < 1e-12);
  // and the kernel the processor uses agrees: every sigma doubles
  const k1 = core._internal.kernelGaussians({ blurMul: 0.1456 }, 6240, 1)[0];
  const k2 = core._internal.kernelGaussians({ blurMul: 0.1456 }, 12480, 1)[0];
  k1.forEach((g, i) => assert.ok(Math.abs(k2[i].sigma / g.sigma - 2) < 1e-12));
  assert.deepEqual(core.haloRadii({ blurMul: 1 }, 0), { lambda: 0, r50: 0, r90: 0 });
  assert.equal(core.haloRadii({}, undefined).r50, 0);
});

test('speed probe: fixed checksum, the same on every run, times from the given clock', () => {
  const p = core.speedProbe();
  assert.equal(p.sum, 372855, 'the workload changed: reports are no longer comparable with older ones');
  assert.ok(p.min > 0 && p.min <= p.first);
  let t = 0;
  const q = core.speedProbe(() => (t += 7), 4);
  assert.deepEqual(q, { first: 7, min: 7, sum: 372855 });
  assert.equal(core.speedProbe(null, 1).sum, 372855);
});

test('blur timer counts only the steps, not the pauses between them', async () => {
  const w = 640;
  const h = 427;
  const d = scene(w, h, 5, 3);
  const proc = core.createProcessor({ width: w, height: h, docLongSide: 6240, baseLevel: 0, settings: { strength: 100, blurMul: 1 } });
  proc.pass1(d, 3, 0, h);
  const t0 = Date.now();
  let steps = 0;
  for (const _ of proc.blurSteps()) {
    steps++;
    await new Promise((r) => setTimeout(r, 15)); // what the bridge does between steps: progress and a yield
  }
  const wall = Date.now() - t0;
  assert.ok(steps >= 2, 'several steps');
  const blur = proc.stats.timings.blur;
  assert.ok(blur >= 0 && blur <= wall - steps * 10, `blur ${blur} ms must exclude ${steps} pauses of 15 ms (wall ${wall} ms)`);
});

test('fine tiles: counted under a threshold only, fewer computed when less of the frame emits', () => {
  const w = 640;
  const h = 427;
  const d = scene(w, h, 9, 3);
  const run = (s) => {
    const proc = core.createProcessor(Object.assign({ width: w, height: h, settings: s }, L2));
    proc.pass1(d, 3, 0, h);
    for (const _ of proc.blurSteps()) { /* to the end */ }
    proc.pass2(d, 3, 0, h, new Uint8Array(w * h * 3), { dataY0: 0, dataRows: h });
    return proc.stats.fineTiles;
  };
  assert.equal(run({ strength: 100, blurMul: 0.15 }), null, 'no threshold: no zero-skip, nothing to count');
  const low = run({ strength: 100, blurMul: 0.15, threshold: 60, softness: 0 });
  const high = run({ strength: 100, blurMul: 0.15, threshold: 250, softness: 0 });
  assert.ok(low.total > 0 && low.total === high.total);
  assert.ok(low.computed <= low.total && high.computed < low.computed && high.computed > 0, JSON.stringify({ low, high }));
});

test('an interrupted blur keeps the time of the steps it did (cancel in the middle)', () => {
  const w = 1280;
  const h = 854;
  const d = scene(w, h, 5, 3);
  const proc = core.createProcessor({ width: w, height: h, docLongSide: 6240, baseLevel: 0, settings: { strength: 100, blurMul: 2 } });
  proc.pass1(d, 3, 0, h);
  const gen = proc.blurSteps();
  let n = 0;
  for (let r = gen.next(); !r.done && n < 3; r = gen.next()) n++;
  assert.equal(n, 3);
  assert.ok(proc.stats.timings.blur > 0, 'three steps of a 1 Mpx blur take measurable time: ' + proc.stats.timings.blur);
});
