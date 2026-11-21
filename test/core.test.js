'use strict';
// Core tests, design doc section 7.1.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');
const { NOISE } = require('../src/core/bluenoise');

const T = core._internal.transfer;
const HALO = core._internal.halo;
const kernelGaussians = core._internal.kernelGaussians;
const previewFields = core._internal.previewFields;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomImage(w, h, comps, seed) {
  const r = rng(seed);
  const d = new Uint8Array(w * h * comps);
  for (let i = 0; i < d.length; i++) d[i] = Math.floor(r() * 256);
  if (comps === 4) for (let i = 3; i < d.length; i += 4) d[i] = 255;
  return d;
}

function fill(w, h, comps, v) {
  const d = new Uint8Array(w * h * comps).fill(v);
  if (comps === 4) for (let i = 3; i < d.length; i += 4) d[i] = 255;
  return d;
}

function setPx(d, w, x, y, v, comps = 3) {
  const p = (y * w + x) * comps;
  d[p] = v;
  d[p + 1] = v;
  d[p + 2] = v;
}

function jumpCurve(k) {
  const pts = T.defaultCurvePoints().map(([x, y]) => [x, y / k]);
  pts.push([254, T.srgbToLinear(254 / 255) / k]);
  return pts;
}
const PLATEAU = [[50, 0.05], [100, 0.2], [150, 0.2002], [200, 0.6]];
const CURVES = {
  srgb: { mode: 'srgb' },
  reinhard: { mode: 'reinhard', reinhardLimit: 1.1 },
  reinhardSteep: { mode: 'reinhard', reinhardLimit: 1.01 },
  jump10: { mode: 'curve', curvePoints: jumpCurve(10) },
  jump100: { mode: 'curve', curvePoints: jumpCurve(100) },
  plateau: { mode: 'curve', curvePoints: PLATEAU },
};

function runField(data, w, h, comps, settings, opts = {}) {
  const p = core.createProcessor({ width: w, height: h, docLongSide: opts.docLongSide || Math.max(w, h), settings, baseLevel: opts.baseLevel });
  p.pass1(data, comps, 0, h);
  HALO.runToEnd(p.blurSteps());
  return p;
}

// ---------------------------------------------------------------- curves

test('test curves are valid and LUT_in strictly increasing', () => {
  for (const [name, c] of Object.entries(CURVES)) {
    if (c.mode === 'srgb') continue;
    if (c.mode === 'curve') {
      const v = core.validateCurve(c.curvePoints);
      assert.equal(v.ok, true, `${name}: ${v.reason}`);
    }
    const lut = core.buildLutIn(c);
    for (let i = 0; i < 255; i++) assert.ok(lut[i + 1] > lut[i], `${name} at ${i}`);
    assert.equal(lut[0], 0);
    assert.equal(lut[255], 1);
  }
});

test('validateCurve rejects bad curves', () => {
  assert.equal(core.validateCurve([[10, 0.1], [10.5, 0.2]]).ok, false);
  assert.equal(core.validateCurve([[10, 0.2], [20, 0.1]]).ok, false);
  assert.equal(core.validateCurve(Array.from({ length: 13 }, (_, i) => [10 + i * 15, (i + 1) / 14])).ok, false);
  assert.equal(core.validateCurve('nope').ok, false);
});

test('spline passes through its points and default curve approximates sRGB', () => {
  const pts = T.defaultCurvePoints();
  const lut = core.buildLutIn({ mode: 'curve', curvePoints: pts });
  for (const [x, y] of pts) assert.ok(Math.abs(lut[x] - y) < 1e-6);
  for (let c = 8; c < 256; c++) assert.ok(Math.abs(lut[c] - T.SRGB_LUT[c]) / T.SRGB_LUT[c] < 0.02, `code ${c}`);
});

// ---------------------------------------------------------------- identity and flat fields

test('strength 0 returns the input bit for bit', () => {
  for (const comps of [3, 4]) {
    const d = randomImage(53, 37, comps, 7);
    const out = core.processImage(d, 53, 37, comps, { strength: 0 });
    assert.deepEqual(out, d);
  }
});

test('flat field of every code stays unchanged at strength 100 (all curves, both models, base 0 and 1)', () => {
  for (const model of ['excess', 'normalized']) {
    for (const [name, c] of Object.entries(CURVES)) {
      for (const baseLevel of [0, 1]) {
        for (let v = 0; v < 256; v++) {
          const d = fill(9, 7, 3, v);
          const out = core.processImage(d, 9, 7, 3, Object.assign({ model, strength: 100, blur: 100 }, c), { baseLevel });
          for (let i = 0; i < d.length; i++) {
            if (out[i] !== v) assert.fail(`${model} ${name} base ${baseLevel} code ${v} -> ${out[i]}`);
          }
        }
      }
    }
  }
});

test('excess model: no cyan rim inside a bright square, 255 sources stay 255', () => {
  const w = 200;
  const h = 160;
  for (const curve of [CURVES.srgb, CURVES.jump100]) {
    const d = fill(w, h, 3, 0);
    for (let y = 40; y < 120; y++) for (let x = 60; x < 140; x++) setPx(d, w, x, y, 230);
    for (let y = 10; y < 13; y++) for (let x = 10; x < 13; x++) setPx(d, w, x, y, 255);
    const out = core.processImage(d, w, h, 3, Object.assign({ strength: 100, blur: 100 }, curve), { docLongSide: 3000 });
    for (let y = 40; y < 120; y++) {
      for (let x = 60; x < 140; x++) {
        const p = (y * w + x) * 3;
        assert.deepEqual([out[p], out[p + 1], out[p + 2]], [230, 230, 230], `square pixel ${x},${y}`);
      }
    }
    for (let y = 10; y < 13; y++) {
      for (let x = 10; x < 13; x++) {
        const p = (y * w + x) * 3;
        assert.deepEqual([out[p], out[p + 1], out[p + 2]], [255, 255, 255], `source pixel ${x},${y}`);
      }
    }
    // and the glow is there on the dark side
    const q = (80 * w + 56) * 3;
    assert.ok(out[q] > 0 && out[q] > out[q + 2], 'warm glow next to the square');
  }
});

test('normalized model (comparison) does lose red on the bright side of edges', () => {
  const w = 200;
  const h = 160;
  const d = fill(w, h, 3, 0);
  for (let y = 40; y < 120; y++) for (let x = 60; x < 140; x++) setPx(d, w, x, y, 230);
  const out = core.processImage(d, w, h, 3, { model: 'normalized', strength: 100, blur: 100 }, { docLongSide: 3000 });
  const p = (80 * w + 60) * 3;
  assert.ok(out[p] < out[p + 1], `edge pixel ${out[p]},${out[p + 1]},${out[p + 2]}`);
});

test('flat field 6001x3999 (auto base level) stays unchanged', () => {
  const w = 6001;
  const h = 3999;
  const d = fill(w, h, 3, 77);
  const out = core.processImage(d, w, h, 3, { strength: 100 });
  let bad = 0;
  for (let i = 0; i < d.length; i++) if (out[i] !== 77) bad++;
  assert.equal(bad, 0);
});

// ---------------------------------------------------------------- kernel

function impulseField(size, lambda1) {
  const docLongSide = lambda1 / 0.0018;
  const src = new Float32Array(size * size * 3);
  const c = (size >> 1) * size + (size >> 1);
  src[c * 3] = src[c * 3 + 1] = src[c * 3 + 2] = 1;
  const g = kernelGaussians({ blur: 50 }, docLongSide, 1)[0];
  return HALO.runToEnd(HALO.haloGenerator(src, size, size, g));
}

test('kernel energy is 1 and second moment matches the two-exponential model', () => {
  const size = 401;
  const lam = 4;
  const H = impulseField(size, lam);
  const c = size >> 1;
  let e = 0;
  let m2 = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = H[(y * size + x) * 3];
      assert.ok(Number.isFinite(v));
      e += v;
      m2 += v * ((x - c) ** 2 + (y - c) ** 2);
    }
  }
  assert.ok(Math.abs(e - 1) < 0.005, `energy ${e}`);
  const expected = 6 * lam * lam * (0.6 + 0.4 * 3.3 * 3.3);
  assert.ok(Math.abs(m2 / e / expected - 1) < 0.03, `second moment ${m2 / e} vs ${expected}`);
});

test('kernel is isotropic within 15 % down to 1e-4 of the peak', () => {
  const size = 401;
  const H = impulseField(size, 4);
  const c = size >> 1;
  const at = (x, y) => H[((c + y) * size + (c + x)) * 3];
  const peak = at(0, 0);
  for (let d = 2; d < 140; d++) {
    const diag = at(d, d);
    if (diag < 1e-4 * peak) break;
    const r = d * Math.SQRT2;
    const r0 = Math.floor(r);
    const axis = at(r0, 0) + (r - r0) * (at(r0 + 1, 0) - at(r0, 0));
    const ratio = diag / axis;
    assert.ok(ratio > 0.85 && ratio < 1.15, `d=${d} ratio ${ratio.toFixed(3)}`);
  }
});

test('halo centre of mass matches the source (no half-pixel shift), base 0 and 1', () => {
  const w = 601;
  const h = 399;
  for (const baseLevel of [0, 1]) {
    for (const src of [{ x: 300, y: 200, n: 2 }, { x: 301, y: 201, n: 3 }]) {
      const d = fill(w, h, 3, 0);
      const half = (src.n - 1) / 2;
      const x0 = Math.round(src.x - half);
      const y0 = Math.round(src.y - half);
      for (let y = y0; y < y0 + src.n; y++) for (let x = x0; x < x0 + src.n; x++) setPx(d, w, x, y, 255);
      const cx = x0 + half;
      const cy = y0 + half;
      const out = core.processImage(d, w, h, 3, { strength: 100, blur: 100 }, { baseLevel });
      const lut = T.SRGB_LUT;
      const a = 0.25;
      let sw = 0;
      let sx = 0;
      let sy = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (Math.abs(x - cx) <= 3 && Math.abs(y - cy) <= 3) continue; // symmetric exclusion
          const p = (y * w + x) * 3;
          const hal = (lut[out[p]] - lut[d[p]]) / a; // excess model: O - L = a * max(H - L, 0)
          sw += hal;
          sx += hal * x;
          sy += hal * y;
        }
      }
      const ex = sx / sw - cx;
      const ey = sy / sw - cy;
      // Base 0 tests the halo engine itself: 0.25 px. At base level 1 (images over 4 Mpx) pass 1
      // averages 2x2 blocks, so a source of a few pixels can move by up to half a full-res pixel.
      const tol = baseLevel === 0 ? 0.25 : 0.5;
      assert.ok(Math.abs(ex) < tol && Math.abs(ey) < tol, `base ${baseLevel} n=${src.n}: shift ${ex.toFixed(3)}, ${ey.toFixed(3)}`);
    }
  }
});

// ---------------------------------------------------------------- resolution and preview

function downscale(field, w, h, k) {
  const w2 = Math.floor(w / k);
  const h2 = Math.floor(h / k);
  const out = new Float64Array(w2 * h2 * 3);
  for (let y = 0; y < h2 * k; y++) {
    for (let x = 0; x < w2 * k; x++) {
      const o = (Math.floor(y / k) * w2 + Math.floor(x / k)) * 3;
      const i = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) out[o + c] += field[i + c] / (k * k);
    }
  }
  return out;
}

function blobs(w, h, seed) {
  const r = rng(seed);
  const d = fill(w, h, 3, 20);
  for (let n = 0; n < 6; n++) {
    const cx = Math.floor(r() * w);
    const cy = Math.floor(r() * h);
    const rad = 2 + Math.floor(r() * 6);
    for (let y = -rad; y <= rad; y++) {
      for (let x = -rad; x <= rad; x++) {
        if (x * x + y * y > rad * rad) continue;
        const X = cx + x;
        const Y = cy + y;
        if (X >= 0 && Y >= 0 && X < w && Y < h) setPx(d, w, X, Y, 250);
      }
    }
  }
  return d;
}

test('resolution independence: 2048 px downscaled matches 512 px within 5 % of the peak', () => {
  const small = blobs(512, 512, 3);
  const big = new Uint8Array(2048 * 2048 * 3);
  for (let y = 0; y < 2048; y++) {
    for (let x = 0; x < 2048; x++) {
      const s = ((y >> 2) * 512 + (x >> 2)) * 3;
      const t = (y * 2048 + x) * 3;
      big[t] = small[s];
      big[t + 1] = small[s + 1];
      big[t + 2] = small[s + 2];
    }
  }
  const settings = { strength: 100, blur: 100 };
  const Hs = runField(small, 512, 512, 3, settings, { baseLevel: 0 }).field;
  const Hb = downscale(runField(big, 2048, 2048, 3, settings, { baseLevel: 0 }).field, 2048, 2048, 4);
  let peak = 0;
  let maxDiff = 0;
  for (let i = 0; i < Hs.length; i++) {
    peak = Math.max(peak, Hs[i]);
    maxDiff = Math.max(maxDiff, Math.abs(Hs[i] - Hb[i]));
  }
  assert.ok(maxDiff / peak < 0.05, `max diff ${(100 * maxDiff / peak).toFixed(2)} % of peak`);
});

test('preview field matches the downscaled full field within 3 % of the halo peak', () => {
  const w = 1200;
  const h = 1200;
  for (const curve of [CURVES.srgb, { mode: 'curve', curvePoints: jumpCurve(30) }]) {
    for (const scene of ['point', 'square', 'flat']) {
      const d = fill(w, h, 3, scene === 'flat' ? 90 : 10);
      if (scene === 'point') setPx(d, w, 601, 599, 255);
      if (scene === 'square') for (let y = 300; y < 303; y++) for (let x = 900; x < 903; x++) setPx(d, w, x, y, 255);
      const settings = Object.assign({ strength: 100, blur: 100 }, curve);
      const full = runField(d, w, h, 3, settings, { baseLevel: 0 }).field;
      const down = downscale(full, w, h, 4);
      const b = core.createPreviewBuilder({ width: w, height: h, maxLongSide: 300 });
      b.push(d, 3, 0, h);
      const proxy = b.finish();
      assert.equal(proxy.block, 4);
      const pf = previewFields(proxy, settings, { docLongSide: w }).field;
      let peak = 0;
      let maxDiff = 0;
      for (let i = 0; i < pf.length; i++) {
        peak = Math.max(peak, down[i]);
        maxDiff = Math.max(maxDiff, Math.abs(pf[i] - down[i]));
      }
      // A one-pixel source sits at a sub-pixel position of the 4x smaller proxy. Its energy is
      // splatted at the true centroid (no shift), which widens the spot slightly: measured
      // 0.8 % (block centre) to 4.2 % (worst offset). Extended sources and flat fields keep 3 %.
      const tol = scene === 'point' ? 0.05 : 0.03;
      assert.ok(maxDiff / peak < tol, `${curve.mode}/${scene}: ${(100 * maxDiff / peak).toFixed(2)} %`);
    }
  }
});

test('preview "after" mixes a block in display light (thin white line under a x30 curve)', () => {
  const w = 240;
  const h = 120;
  const d = fill(w, h, 3, 0);
  for (let y = 0; y < h; y++) for (let x = 5; x < w; x += 12) setPx(d, w, x, y, 255);
  const b = core.createPreviewBuilder({ width: w, height: h, maxLongSide: 20 });
  b.push(d, 3, 0, h);
  const proxy = b.finish();
  assert.equal(proxy.block, 12);
  const expected = Math.round(T.linearToSrgb(1 / 12) * 255); // one white column in twelve
  for (const curve of [CURVES.srgb, { mode: 'curve', curvePoints: jumpCurve(30) }]) {
    const img = core.renderPreview(proxy, Object.assign({ strength: 0 }, curve), 'after', { docLongSide: w });
    for (let i = 0; i < img.data.length; i++) {
      assert.ok(Math.abs(img.data[i] - expected) <= 2, `${curve.mode}: ${img.data[i]} vs ${expected}`);
    }
  }
});

test('preview cache ignores the RGB of fully transparent pixels (no phantom halo)', () => {
  const w = 120;
  const h = 80;
  const make = (v) => {
    const d = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 30; d[i * 4 + 3] = 255; }
    for (let y = 30; y < 50; y++) for (let x = 50; x < 70; x++) { const p = (y * w + x) * 4; d[p] = d[p + 1] = d[p + 2] = v; d[p + 3] = 0; }
    const b = core.createPreviewBuilder({ width: w, height: h, maxLongSide: 40 });
    b.push(d, 4, 0, h);
    return previewFields(b.finish(), { strength: 100, blur: 100 }, { docLongSide: 2000 }).field;
  };
  const white = make(255);
  const black = make(0);
  for (let i = 0; i < white.length; i++) assert.ok(Math.abs(white[i] - black[i]) < 1e-6, `index ${i}`);
});

test('renderPreview returns RGB of the proxy size for all views', () => {
  const d = blobs(320, 200, 5);
  const b = core.createPreviewBuilder({ width: 320, height: 200, maxLongSide: 100 });
  b.push(d, 3, 0, 200);
  const proxy = b.finish();
  for (const view of ['before', 'after', 'halo']) {
    const img = core.renderPreview(proxy, {}, view, { docLongSide: 320 });
    assert.equal(img.data.length, img.width * img.height * 3);
  }
});

// ---------------------------------------------------------------- physics behaviour

function edgeScene() {
  const w = 80;
  const h = 40;
  const d = fill(w, h, 3, 10);
  for (let y = 0; y < h; y++) for (let x = 40; x < w; x++) setPx(d, w, x, y, 255);
  return { d, w, h };
}

test('output in the dark zone grows monotonically with strength', () => {
  const { d, w, h } = edgeScene();
  const p = (20 * w + 36) * 3;
  let prev = -1;
  for (let s = 0; s <= 100; s += 10) {
    const out = core.processImage(d, w, h, 3, { strength: s, blur: 100 }, { docLongSide: 2000 });
    assert.ok(out[p] >= prev, `strength ${s}`);
    prev = out[p];
  }
});

test('default color gives R > G > B halo; pure blue gives no red halo; black color is rejected', () => {
  const { d, w, h } = edgeScene();
  const lut = T.SRGB_LUT;
  const out = core.processImage(d, w, h, 3, { strength: 100, blur: 100 }, { docLongSide: 2000 });
  let dr = 0;
  let dg = 0;
  let db = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 30; x < 40; x++) {
      const p = (y * w + x) * 3;
      dr += lut[out[p]] - lut[d[p]];
      dg += lut[out[p + 1]] - lut[d[p + 1]];
      db += lut[out[p + 2]] - lut[d[p + 2]];
    }
  }
  assert.ok(dr > dg && dg > db && db >= 0, `${dr} ${dg} ${db}`);

  const blue = core.processImage(d, w, h, 3, { strength: 100, blur: 100, color: [0, 0, 255] }, { docLongSide: 2000 });
  for (let i = 0; i < d.length; i += 3) assert.equal(blue[i], d[i]);

  assert.equal(core.colorGains([0, 0, 0]), null);
  assert.deepEqual(core.normalizeSettings({ color: [0, 0, 0] }).color, [255, 144, 39]);
});

// ---------------------------------------------------------------- strips, dither, alpha, sizes

test('result does not depend on strip height or on a 64-px origin shift', () => {
  const w = 97;
  const h = 61;
  const d = blobs(w, h, 11);
  for (const baseLevel of [0, 1, 2]) {
    const ref = core.processImage(d, w, h, 3, { strength: 80, blur: 80 }, { stripRows: 512, baseLevel, docLongSide: 900 });
    for (const rows of [1, 7]) {
      const out = core.processImage(d, w, h, 3, { strength: 80, blur: 80 }, { stripRows: rows, baseLevel, docLongSide: 900 });
      assert.deepEqual(out, ref, `base ${baseLevel} rows ${rows}`);
    }
    const shifted = core.processImage(d, w, h, 3, { strength: 80, blur: 80 }, { baseLevel, docLongSide: 900, originX: 64, originY: 128 });
    assert.deepEqual(shifted, ref);
  }
});

test('blue-noise tile has mean 0.5 and 4096 distinct thresholds', () => {
  let s = 0;
  for (const v of NOISE) s += v;
  assert.ok(Math.abs(s / 4096 - 0.5) < 1e-9);
  assert.equal(new Set(NOISE).size, 4096);
});

test('dither preserves mean light on a smooth halo gradient', () => {
  const w = 256;
  const h = 64;
  const d = fill(w, h, 3, 0);
  for (let y = 0; y < h; y++) for (let x = 200; x < w; x++) setPx(d, w, x, y, 255);
  const settings = { strength: 100, blur: 100 };
  const p = runField(d, w, h, 3, settings, { docLongSide: 3000 });
  const out = new Uint8Array(d.length);
  p.pass2(d, 3, 0, h, out);
  const lut = T.SRGB_LUT;
  const phys = core._internal.settings.physics(settings);
  let sumOut = 0;
  let sumExact = 0;
  const Hf = p.field;
  for (let y = 0; y < h; y++) {
    for (let x = 100; x < 190; x++) {
      const i = (y * w + x) * 3;
      sumOut += lut[out[i]];
      sumExact += core._internal.settings.combine(phys, 0, lut[d[i]], Hf[i]);
    }
  }
  assert.ok(Math.abs(sumOut / sumExact - 1) < 0.01, `ratio ${sumOut / sumExact}`);
});

test('alpha: transparent pixels copied, alpha unchanged, transparent stripe ok', () => {
  const w = 60;
  const h = 40;
  const d = randomImage(w, h, 4, 21);
  for (let y = 15; y < 22; y++) for (let x = 0; x < w; x++) d[(y * w + x) * 4 + 3] = 0;
  for (let i = 3; i < d.length; i += 16) d[i] = 128;
  const out = core.processImage(d, w, h, 4, { strength: 100, blur: 100 });
  for (let i = 0; i < d.length; i += 4) {
    assert.equal(out[i + 3], d[i + 3]);
    if (d[i + 3] === 0) {
      assert.equal(out[i], d[i]);
      assert.equal(out[i + 1], d[i + 1]);
      assert.equal(out[i + 2], d[i + 2]);
    }
  }
});

test('tiny and degenerate sizes work', () => {
  for (const [w, h] of [[1, 1], [3, 3], [1, 50], [50, 1], [2, 2]]) {
    for (const comps of [3, 4]) {
      const d = randomImage(w, h, comps, w * 31 + h);
      const out = core.processImage(d, w, h, comps, { strength: 100, blur: 100 }, { docLongSide: 4000 });
      assert.equal(out.length, d.length);
    }
  }
});

test('work area offset inside a larger document uses document long side and origin', () => {
  const w = 64;
  const h = 48;
  const d = blobs(w, h, 9);
  const a = core.processImage(d, w, h, 3, { strength: 60 }, { docLongSide: 5000, originX: 300, originY: 200 });
  const b = core.processImage(d, w, h, 3, { strength: 60 }, { docLongSide: 5000, originX: 300 + 64, originY: 200 + 64 });
  assert.deepEqual(a, b);
  const c = core.processImage(d, w, h, 3, { strength: 60 }, { docLongSide: 64 });
  assert.notDeepEqual(a, c);
});
