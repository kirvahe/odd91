'use strict';
// v1.1 core features: source threshold, ranges, halo view, layer-name token, looks, loupe margin.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');
const S = core._internal.settings;
const T = core._internal.transfer;

function fill(w, h, v) {
  return new Uint8Array(w * h * 3).fill(v);
}
function rect(d, w, x0, y0, x1, y1, v) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = (y * w + x) * 3; d[p] = d[p + 1] = d[p + 2] = v; }
}

test('flat fields stay unchanged with a threshold (both models, base 0 and 1)', () => {
  for (const model of ['excess', 'normalized']) {
    for (const th of [{ threshold: 128, softness: 0 }, { threshold: 128, softness: 64 }, { threshold: 250, softness: 10 }]) {
      for (const baseLevel of [0, 1]) {
        for (const v of [0, 50, 127, 128, 129, 200, 255]) {
          const d = fill(11, 9, v);
          const out = core.processImage(d, 11, 9, 3, Object.assign({ model, strength: 400, blurMul: 4, mode: 'reinhard' }, th), { baseLevel });
          for (let i = 0; i < d.length; i++) if (out[i] !== v) assert.fail(`${model} ${JSON.stringify(th)} base ${baseLevel} code ${v} -> ${out[i]}`);
        }
      }
    }
  }
});

test('threshold: sources below it do not glow, sources above do', () => {
  const w = 200;
  const h = 80;
  const d = fill(w, h, 0);
  rect(d, w, 20, 20, 60, 60, 150);   // grey square
  rect(d, w, 140, 30, 150, 40, 255); // lamp
  const opts = { docLongSide: 2000 };
  const on = core.processImage(d, w, h, 3, { strength: 100, blurMul: 2, threshold: 200, softness: 0 }, opts);
  const off = core.processImage(d, w, h, 3, { strength: 100, blurMul: 2, threshold: 0 }, opts);
  const nearGrey = (16 * w + 40) * 3 + 0; // just above the grey square
  const nearLamp = (26 * w + 145) * 3 + 0; // just above the lamp
  assert.equal(on[nearGrey], 0, 'no glow above a grey square under the threshold');
  assert.ok(off[nearGrey] > 0, 'without threshold the grey square glows');
  assert.ok(on[nearLamp] > 0, 'the lamp still glows');
});

test('threshold weight: smoothstep on the brightest channel, step when softness is 0, white always 1', () => {
  const tab = S.weightTable({ threshold: 128, softness: 64 });
  assert.equal(tab.length, 256);
  let prev = -1;
  for (const v of tab) { assert.ok(v >= prev - 1e-7); prev = v; }
  const phys = S.physics({ threshold: 128, softness: 64 });
  assert.equal(S.pixelWeight(phys, 80, 80, 80), 0);
  assert.equal(S.pixelWeight(phys, 170, 10, 10), 1, 'a saturated red pixel counts by its red channel');
  assert.ok(Math.abs(S.pixelWeight(phys, 128, 0, 0) - 0.5) < 1e-6);
  const hard = S.physics({ threshold: 128, softness: 0 });
  assert.equal(S.pixelWeight(hard, 127, 127, 127), 0);
  assert.equal(S.pixelWeight(hard, 128, 0, 0), 1);
  const top = S.physics({ threshold: 250, softness: 40 });
  assert.equal(S.pixelWeight(top, 255, 255, 255), 1, 'the window is clamped to 255');
  assert.equal(S.weightTable({ threshold: 0 }), null);
});

test('ranges: blur x0.01..x4 on a log slider, legacy blur, strength up to 400 %', () => {
  assert.ok(Math.abs(core.blurFromSlider(0) - 0.01) < 1e-12);
  assert.ok(Math.abs(core.blurFromSlider(100) - 4) < 1e-12);
  for (const m of [0.01, 0.05, 0.25, 1, 2.5, 4]) assert.ok(Math.abs(core.blurFromSlider(core.blurToSlider(m)) - m) < 1e-9);
  assert.ok(Math.abs(core.blurFromSlider(core.blurToSlider(1)) - 1) < 1e-12);
  assert.equal(core.normalizeSettings({ blur: 50 }).blurMul, 1);
  assert.equal(core.normalizeSettings({ blur: 100 }).blurMul, 4);
  assert.equal(core.normalizeSettings({ blurMul: 0.001 }).blurMul, 0.01);
  assert.ok(!('blur' in core.normalizeSettings({ blur: 30 })));
  assert.equal(core.strengthToA(400), 4);
  assert.equal(core.strengthToA(100), 1);
  assert.ok(Math.abs(core.strengthToA(30) - 0.09) < 1e-12);
  assert.equal(core.normalizeSettings({ strength: 999 }).strength, 400);
});

test('view "halo": zero away from edges and inside bright areas, positive on the dark side', () => {
  const w = 120;
  const h = 40;
  const d = fill(w, h, 0);
  rect(d, w, 60, 0, w, h, 255);
  const out = core.processImage(d, w, h, 3, { strength: 100, blurMul: 0.5 }, { view: 'halo', docLongSide: 1500 });
  assert.equal(out[(20 * w + 5) * 3], 0, 'far from the edge');
  assert.equal(out[(20 * w + 100) * 3], 0, 'inside the bright area (excess model)');
  assert.ok(out[(20 * w + 58) * 3] > 0, 'next to the edge on the dark side');
});

test('layer name token round-trips every setting and fits 255 characters', () => {
  const pts = Array.from({ length: 12 }, (_, i) => [8 + i * 20, T.srgbToLinear((8 + i * 20) / 255) / 37.123456]);
  const cases = [
    {},
    { mode: 'reinhard', reinhardLimit: 1.037, threshold: 231, softness: 17, strength: 275, blurMul: 0.013, color: [250, 100, 7], model: 'normalized' },
    { mode: 'curve', curvePoints: pts, strength: 55, blurMul: 3.21, radii: [1, 0.55, 0.35] },
  ];
  for (const c of cases) {
    const s = core.normalizeSettings(c);
    const name = core.layerNameFor(s);
    assert.ok(name.length <= 255, `length ${name.length}`);
    assert.ok(core.isResultLayerName(name));
    const back = core.settingsFromLayerName(name);
    assert.ok(back, 'parses');
    for (const k of ['mode', 'model', 'color', 'threshold', 'softness', 'radii']) assert.deepEqual(back[k], s[k], k);
    for (const k of ['strength', 'blurMul', 'reinhardLimit']) assert.ok(Math.abs(back[k] - s[k]) / Math.max(1e-9, s[k]) < 1e-3, k);
    if (s.mode === 'curve') {
      const a = core.buildLutIn(s);
      const b = core.buildLutIn(back);
      for (let i = 0; i < 256; i++) assert.ok(Math.abs(a[i] - b[i]) <= 1e-4 * Math.max(a[i], 1e-6) + 1e-7, `lut ${i}`);
    }
  }
  assert.equal(core.isResultLayerName('Halation'), true);
  assert.equal(core.isResultLayerName('Background'), false);
  assert.equal(core.isResultLayerName('Halation copy 2'), false);
  assert.equal(core.isResultLayerName('Halation glow'), false);
  assert.equal(core.isResultLayerName(core.layerNameFor({}) + ' copy'), false);
  assert.equal(core.settingsFromLayerName('Halation'), null);
  assert.equal(core.settingsFromLayerName('Layer [h1:garbage]'), null);
});

test('built-in looks are valid settings and round-trip through layer names', () => {
  assert.ok(core.LOOKS.length >= 3);
  const ids = new Set();
  for (const look of core.LOOKS) {
    assert.ok(look.id && look.name && look.description);
    assert.ok(!ids.has(look.id));
    ids.add(look.id);
    const s = core.normalizeSettings(look.settings);
    const back = core.settingsFromLayerName(core.layerNameFor(s));
    assert.equal(back.mode, s.mode);
    assert.equal(back.threshold, s.threshold);
  }
});

test('loupe margin grows with blur, covers the widest Gaussian and is capped', () => {
  const a = core.loupeMargin({ blurMul: 1 }, 6000);
  const b = core.loupeMargin({ blurMul: 2 }, 6000);
  assert.ok(b > a && a >= 8);
  const widest = 2.7684 * 3.3 * 0.0018 * 6000;
  assert.ok(a >= 3.5 * widest - 1);
  assert.equal(core.loupeMargin({ blurMul: 4 }, 60000), 1024);
});

function rng(seed) {
  let x = seed >>> 0;
  return () => { x = (x + 0x6d2b79f5) | 0; let t = Math.imul(x ^ (x >>> 15), 1 | x); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function noisy(w, h, mean, amp, seed) {
  const r = rng(seed);
  const d = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const v = Math.max(0, Math.min(255, Math.round(mean + (r() * 2 - 1) * amp)));
    d[i * 3] = d[i * 3 + 1] = d[i * 3 + 2] = v;
  }
  return d;
}
function stats(out, ch) {
  let s = 0, s2 = 0, n = 0;
  for (let i = ch; i < out.length; i += 3) { s += out[i]; s2 += out[i] * out[i]; n++; }
  const m = s / n;
  return { mean: m, sd: Math.sqrt(s2 / n - m * m) };
}

test('no speckle near the threshold: a noisy field at the threshold barely changes', () => {
  const w = 300, h = 200;
  const d = noisy(w, h, 128, 3.5, 7);
  const before = stats(d, 0);
  for (const softness of [0, 8, 32]) {
    const out = core.processImage(d, w, h, 3, { strength: 100, threshold: 128, softness }, { docLongSide: 3000 });
    const after = stats(out, 0);
    assert.ok(Math.abs(after.mean - before.mean) < 1.5, `softness ${softness}: mean ${after.mean.toFixed(2)} vs ${before.mean.toFixed(2)}`);
    assert.ok(after.sd < before.sd + 1.5, `softness ${softness}: sd ${after.sd.toFixed(2)} vs ${before.sd.toFixed(2)}`);
  }
});

test('strength above 100 %: grain is not warmed; a threshold keeps thin dark lines dark', () => {
  const w = 300, h = 200;
  const d = noisy(w, h, 128, 10, 11);
  const before = stats(d, 0);
  const out = core.processImage(d, w, h, 3, { strength: 400 }, { docLongSide: 3000 });
  assert.ok(stats(out, 0).mean - before.mean < 4, 'red mean shift on grain at 400 %');
  const line = fill(w, h, 150);
  rect(line, w, 150, 0, 151, h, 40);
  // Above a = 1 any dark detail inside a bright area glows (it cannot be told apart from the dark
  // side of a lamp locally); the remedy, hinted in the panel, is a threshold above the background.
  const o2 = core.processImage(line, w, h, 3, { strength: 400, threshold: 200, softness: 20 }, { docLongSide: 3000 });
  const p = (100 * w + 150) * 3;
  assert.equal(o2[p], 40, 'with a threshold above the background the dark line stays dark');
});

test('small blur on a >1 Mpx image matches the exact full-resolution kernel', () => {
  const w = 1600, h = 1000; // 1.6 Mpx -> base level 1
  assert.equal(core.baseLevelFor(w, h), 1);
  const d = fill(w, h, 60);
  rect(d, w, 300, 300, 340, 340, 255);
  rect(d, w, 800, 100, 801, 900, 255);
  rect(d, w, 1200, 500, 1203, 503, 255);
  for (const blurMul of [0.01, 0.03, 0.05, 0.1, 0.25]) {
    const s = { strength: 100, blurMul };
    const apply = core.processImage(d, w, h, 3, s, { docLongSide: 6000 });
    const exact = core.processImage(d, w, h, 3, s, { docLongSide: 6000, baseLevel: 0 });
    let maxd = 0;
    for (let i = 0; i < d.length; i++) maxd = Math.max(maxd, Math.abs(apply[i] - exact[i]));
    assert.ok(maxd <= 4, `x${blurMul}: max difference ${maxd} codes`);
  }
});

test('fine-kernel strips: result independent of strip height; pass2 without context still works', () => {
  const w = 1300, h = 900;
  const d = noisy(w, h, 90, 60, 5);
  rect(d, w, 400, 400, 410, 410, 255);
  const s = { strength: 150, blurMul: 0.02, threshold: 100, softness: 30 };
  const ref = core.processImage(d, w, h, 3, s, { stripRows: 512, docLongSide: 6000 });
  const p = core.createProcessor({ width: w, height: h, docLongSide: 6000, settings: s });
  assert.ok(p.fineRadius > 0);
  const other = core.processImage(d, w, h, 3, s, { stripRows: 7, docLongSide: 6000 });
  assert.deepEqual(other, ref);
  p.pass1(d, 3, 0, h);
  core._internal.halo.runToEnd(p.blurSteps());
  const out = new Uint8Array(w * 50 * 3);
  p.pass2(d.subarray(100 * w * 3, 150 * w * 3), 3, 100, 50, out); // no context: clamped, no throw
});
