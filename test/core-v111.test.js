'use strict';
// v1.1.1: faster full-resolution ("fine") Gaussians, exact zero-skip under a threshold,
// unrolled pass 2. Acceptance (perf plan review 2026-11-26, С3): against the frozen v1.1.0
// core at most 1 code on at most 1e-5 of the values; strip height, zero-skip and the
// unrolled loop change nothing bit for bit.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');
const ref = require('./helpers/core-v110');

function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Night scene: noisy dark background, a mid-tone block, warm bokeh discs of many sizes,
// a thin bright line and single bright pixels. comps 4 adds a soft alpha ramp and a hole.
function scene(w, h, seed, comps) {
  const R = rng(seed);
  const d = new Uint8Array(w * h * comps);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * comps;
      const n = 20 + ((R() * 70) | 0);
      d[p] = n;
      d[p + 1] = (n * 0.8) | 0;
      d[p + 2] = (n * 0.6) | 0;
      if (comps === 4) d[p + 3] = x < w * 0.1 ? 0 : Math.min(255, ((x / w) * 400) | 0);
    }
  }
  const put = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = (y * w + x) * comps;
    d[p] = r;
    d[p + 1] = g;
    d[p + 2] = b;
  };
  for (let y = (h * 0.55) | 0; y < h * 0.8; y++) for (let x = (w * 0.4) | 0; x < w * 0.6; x++) put(x, y, 170, 140, 120);
  for (let i = 0; i < 40; i++) {
    const cx = (R() * w) | 0;
    const cy = (R() * h * 0.6) | 0;
    const rad = 1 + ((R() * 14) | 0);
    const v = 180 + ((R() * 76) | 0);
    for (let y = -rad; y <= rad; y++) for (let x = -rad; x <= rad; x++) if (x * x + y * y <= rad * rad) put(cx + x, cy + y, 255, v, (v * 0.5) | 0);
  }
  for (let x = 0; x < w; x++) put(x, (h * 0.9) | 0, 255, 255, 255);
  for (let i = 0; i < 25; i++) put((R() * w) | 0, (R() * h) | 0, 255, 255, 255);
  return d;
}

const ILYA = { model: 'excess', mode: 'reinhard', reinhardLimit: 1.0494, color: [255, 144, 39], blurMul: 0.1456, strength: 100, threshold: 202, softness: 32 };

function compare(a, b) {
  let n = 0;
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d) {
      n++;
      if (d > max) max = d;
    }
  }
  return { n, max, frac: n / a.length };
}

const W = 640;
const H = 427;
const L2 = { docLongSide: 6240, baseLevel: 2 }; // a 26 Mpx frame (Ilya's Fuji): fine radii 3, 8, 9 at x0.15
const L1 = { docLongSide: 6000, baseLevel: 1 };

const CASES = [
  ['Ilya: scene-linear, 100 %, x0.15, threshold 202/32', ILYA, L2, 3],
  ['sRGB 30 %, x0.3', { strength: 30, blurMul: 0.3 }, L2, 3],
  ['400 %, x0.1, threshold 120/40', { strength: 400, blurMul: 0.1, threshold: 120, softness: 40 }, L2, 3],
  ['Proosa, x0.05', { model: 'normalized', strength: 60, blurMul: 0.05 }, L2, 3],
  ['curve, x0.6', { mode: 'curve', strength: 80, blurMul: 0.6 }, L2, 3],
  ['radii differ (planar path), x0.2', { strength: 70, blurMul: 0.2, radii: [1, 0.7, 1.4] }, L2, 3],
  ['radii differ with a threshold', { strength: 70, blurMul: 0.2, radii: [1.3, 1, 0.8], threshold: 150, softness: 20 }, L2, 3],
  ['RGBA, threshold 180/30, x0.15', { strength: 100, blurMul: 0.15, threshold: 180, softness: 30 }, L2, 4],
  ['RGBA without a threshold (alpha in the shared pass)', { strength: 100, blurMul: 0.15 }, L2, 4],
  ['RGBA, radii differ (alpha in the planar pass)', { strength: 70, blurMul: 0.2, radii: [1, 0.7, 1.4] }, L2, 4],
  ['x0.01 (delta part)', { strength: 100, blurMul: 0.01 }, L2, 3],
  ['level 1, x0.1', { strength: 100, blurMul: 0.1 }, L1, 3],
  ['level 1, x0.1, threshold 200/30', { strength: 100, blurMul: 0.1, threshold: 200, softness: 30 }, L1, 3],
];

// At most 1 code; at most 1e-5 of the values, or a single value on frames under 100 000 values.
function assertClose(c, len, name) {
  assert.ok(c.max <= 1 && c.n <= Math.max(1, Math.floor(1e-5 * len)), `${name}: ${c.n} values differ (max ${c.max})`);
}

test('fine path: at most 1 code on at most 1e-5 of the values against v1.1.0', () => {
  for (const [name, s, lv, comps] of CASES) {
    const d = scene(W, H, 7, comps);
    const p = core.createProcessor(Object.assign({ width: W, height: H, settings: s }, lv));
    assert.ok(p.fineRadius > 0, name + ': the fine path must be engaged');
    const a = core.processImage(d, W, H, comps, s, lv);
    const b = ref.processImage(d, W, H, comps, s, lv);
    assertClose(compare(a, b), a.length, name);
  }
});

test('fine path: widths that are not a multiple of the 16-column tile, and narrower than one', () => {
  // review v1.1.1 С1: the last, partial tile must still get its fine halo
  const picks = [CASES[0], CASES[2], CASES[5], CASES[8], CASES[9]];
  for (const [w, h] of [[637, 211], [15, 33]]) {
    for (const [name, s, lv, comps] of picks) {
      const d = scene(w, h, 17, comps);
      const a = core.processImage(d, w, h, comps, s, lv);
      assertClose(compare(a, ref.processImage(d, w, h, comps, s, lv)), a.length, `${w}x${h} ${name}`);
    }
  }
});

test('halo-only view keeps matching v1.1.0', () => {
  for (const [name, s, lv, comps] of [CASES[0], CASES[2], CASES[7]]) {
    const d = scene(W, H, 11, comps);
    const o = Object.assign({ view: 'halo' }, lv);
    const c = compare(core.processImage(d, W, H, comps, s, o), ref.processImage(d, W, H, comps, s, o));
    assert.ok(c.max <= 1 && c.frac <= 1e-5, `${name}: ${c.n} values differ (max ${c.max})`);
  }
});

test('no fine Gaussians: bit-identical to v1.1.0 (unrolled pass 2 keeps the arithmetic)', () => {
  const variants = [
    { strength: 30 },
    { strength: 200, mode: 'reinhard', reinhardLimit: 1.05 },
    { model: 'normalized', strength: 100, mode: 'curve' },
    { strength: 80, threshold: 200, softness: 30, color: [255, 60, 20] },
    // large code jumps: the table-start code search must land on the same codes
    { strength: 400, mode: 'reinhard', reinhardLimit: 1.01, blurMul: 2 },
    { strength: 400, mode: 'curve', model: 'normalized', blurMul: 2 },
  ];
  for (const comps of [3, 4]) {
    const d = scene(W, H, 3, comps);
    for (const s of variants) {
      const p = core.createProcessor(Object.assign({ width: W, height: H, settings: s }, L1));
      assert.equal(p.fineRadius, 0);
      assert.deepEqual(core.processImage(d, W, H, comps, s, L1), ref.processImage(d, W, H, comps, s, L1), JSON.stringify(s));
    }
  }
});

test('zero-skip under a threshold is exact: same bytes as computing every tile', () => {
  const sets = [
    ILYA,
    { strength: 400, blurMul: 0.1, threshold: 120, softness: 40 },
    { strength: 100, blurMul: 0.6, threshold: 250, softness: 0 },
    { strength: 100, blurMul: 0.15, threshold: 255, softness: 0 }, // almost nothing emits
  ];
  for (const [w, h] of [[W, H], [637, 211], [15, 33]]) {
    for (const comps of [3, 4]) {
      const d = scene(w, h, 5, comps);
      for (const s of sets) {
        for (const stripRows of [undefined, 13]) {
          const o = Object.assign({ stripRows }, L2);
          const skip = core.processImage(d, w, h, comps, s, o);
          const full = core.processImage(d, w, h, comps, s, Object.assign({ _noSkip: true }, o));
          assert.deepEqual(skip, full, `${w}x${h} ${JSON.stringify(s)} comps ${comps} rows ${stripRows}`);
        }
      }
    }
  }
});

test('fine path at level 2: result independent of strip height', () => {
  for (const [s, comps] of [[ILYA, 3], [{ strength: 150, blurMul: 0.05 }, 4], [{ strength: 70, blurMul: 0.2, radii: [1, 0.7, 1.4] }, 3]]) {
    const d = scene(W, H, 9, comps);
    const a = core.processImage(d, W, H, comps, s, Object.assign({ stripRows: 7 }, L2));
    const b = core.processImage(d, W, H, comps, s, Object.assign({ stripRows: 64 }, L2));
    const c = core.processImage(d, W, H, comps, s, L2);
    assert.deepEqual(a, c);
    assert.deepEqual(b, c);
  }
});

test('level 2 accuracy against the exact full-resolution kernel is no worse than v1.1.0', () => {
  // v1.1.0 itself is up to 5-7 codes off at level 2 (perf review М4); v1.1.1 must not add to it.
  const w = 1200;
  const h = 800;
  const d = scene(w, h, 13, 3);
  for (const blurMul of [0.6, 0.3, 0.15, 0.05]) {
    const s = { strength: 100, blurMul };
    const exact = core.processImage(d, w, h, 3, s, { docLongSide: 6240, baseLevel: 0 });
    const now = compare(core.processImage(d, w, h, 3, s, L2), exact);
    const was = compare(ref.processImage(d, w, h, 3, s, L2), exact);
    assert.ok(now.max <= was.max, `x${blurMul}: ${now.max} codes now, ${was.max} in v1.1.0`);
  }
});

test('stats: fine Gaussians, fine timing and a cost estimate that follows them', () => {
  const p = core.createProcessor({ width: 6240, height: 4160, settings: ILYA });
  const st = p.stats;
  assert.equal(st.baseLevel, 2);
  assert.equal(p.fineRadius, 9);
  assert.deepEqual(st.fine[0].gaussians.map((g) => g.radius), [3, 8, 9]);
  assert.equal(typeof st.timings.fine, 'number');
  const small = p.costEstimate();
  const big = core.createProcessor({ width: 6240, height: 4160, settings: { strength: 30, blurMul: 1 } }).costEstimate();
  for (const c of [small, big]) for (const k of ['read', 'blur', 'write']) assert.ok(c[k] > 0, k);
  const share = (c) => c.write / (c.read + c.blur + c.write);
  assert.ok(share(small) > share(big), 'fine Gaussians make the write stage heavier');
  assert.ok(share(small) > 0.55);
});
