'use strict';
// Settings normalization, slider mappings, glow color and the halation kernel definition.

const T = require('./transfer');

const DEFAULT_COLOR = [255, 144, 39];
const MAX_STRENGTH_A = 0.25;          // strength 100 -> A = 0.25
const LAMBDA_FRACTION = 0.0018;       // core lambda = 0.18 % of the document long side at x1
const LOBES = [[0.6, 1.0], [0.4, 3.3]]; // [weight, lambda factor]: core + tail exponentials
// exp(-r/lambda) in 2D as a sum of isotropic Gaussians: [amplitude, sigma/lambda] (spektrafilm fit)
const EXP_FIT = [[0.1633, 0.536], [0.6496, 1.5236], [0.187, 2.7684]];

// Halation model:
//  'excess'     O = L + a * max(H - L, 0). Only light arriving in excess of what a flat field
//               gives itself is added: no global cast, nothing ever loses light (no cyan rims,
//               small 255 sources stay 255). Equivalent to calibrating on a flat field plus a
//               film shoulder that hides the negative part on the bright side of edges.
//  'normalized' O = (L + a * H) / (1 + a) (spektrafilm / ENS). In 8-bit display-referred images
//               without a film shoulder it makes bright edges and small sources lose red (cyan).
const MODELS = ['excess', 'normalized'];

const DEFAULTS = Object.freeze({
  model: 'excess',
  mode: 'srgb',
  curvePoints: Object.freeze(T.defaultCurvePoints().map((p) => Object.freeze(p))),
  color: Object.freeze(DEFAULT_COLOR.slice()),
  blur: 50,
  strength: 30,
  radii: Object.freeze([1, 1, 1]),
});

function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function blurMultiplier(blur) {
  return Math.pow(2, (clampNum(blur, 0, 100, 50) - 50) / 25);
}

function strengthToA(strength) {
  return (MAX_STRENGTH_A * clampNum(strength, 0, 100, 30)) / 100;
}

// Linearized glow color normalized to max = 1, or null when the color is (near) black.
function colorGains(color) {
  if (!Array.isArray(color) || color.length < 3) return null;
  const c = [0, 1, 2].map((i) => clampNum(color[i], 0, 255, NaN));
  if (c.some((v) => Number.isNaN(v))) return null;
  if (Math.max(c[0], c[1], c[2]) < 1) return null;
  const l = c.map((v) => T.srgbToLinear(v / 255));
  const mx = Math.max(l[0], l[1], l[2]);
  if (!(mx > 0)) return null;
  return [l[0] / mx, l[1] / mx, l[2] / mx];
}

function normalizeSettings(partial) {
  const s = partial && typeof partial === 'object' ? partial : {};
  const mode = s.mode === 'curve' ? 'curve' : 'srgb';
  let curvePoints = T.defaultCurvePoints();
  if (s.curvePoints !== undefined) {
    const v = T.validateCurve(s.curvePoints);
    if (v.ok) curvePoints = v.points;
  }
  let color = DEFAULT_COLOR.slice();
  if (Array.isArray(s.color) && colorGains(s.color)) {
    color = [0, 1, 2].map((i) => Math.round(clampNum(s.color[i], 0, 255, 0)));
  }
  let radii = [1, 1, 1];
  if (Array.isArray(s.radii) && s.radii.length === 3 && s.radii.every((r) => Number.isFinite(Number(r)))) {
    radii = s.radii.map((r) => clampNum(r, 0.1, 4, 1));
  }
  return {
    model: MODELS.indexOf(s.model) >= 0 ? s.model : 'excess',
    mode,
    curvePoints,
    color,
    blur: clampNum(s.blur, 0, 100, 50),
    strength: clampNum(s.strength, 0, 100, 30),
    radii,
  };
}

function buildLutIn(settings) {
  const s = normalizeSettings(settings);
  if (s.mode === 'srgb') return new Float32Array(T.SRGB_LUT);
  return T.lutFromPoints(s.curvePoints);
}

// Per-channel list of Gaussians {sigma, weight, wide}. sigma is in pixels of a grid where
// one pixel = 1/scale document pixels (scale = 1 for full resolution).
function kernelGaussians(settings, docLongSide, scale) {
  const s = normalizeSettings(settings);
  const lambda = LAMBDA_FRACTION * docLongSide * blurMultiplier(s.blur) * scale;
  let fitSum = 0;
  for (const f of EXP_FIT) fitSum += f[0];
  return s.radii.map((r) => {
    const list = [];
    for (const lobe of LOBES) {
      EXP_FIT.forEach((f, i) => {
        list.push({ sigma: f[1] * lobe[1] * lambda * r, weight: (lobe[0] * f[0]) / fitSum, wide: i > 0 });
      });
    }
    return list;
  });
}

// Physics parameters shared by the processor and the preview.
function physics(settings) {
  const s = normalizeSettings(settings);
  const g = colorGains(s.color);
  const A = strengthToA(s.strength);
  const a = [A * g[0], A * g[1], A * g[2]];
  return { s, A, a, inv: a.map((x) => 1 / (1 + x)), excess: s.model === 'excess' };
}

// Output linear light of one channel (reference implementation; hot loops inline this).
function combine(phys, c, L, H) {
  if (phys.excess) {
    const e = H - L;
    return e > 0 ? L + phys.a[c] * e : L;
  }
  return (L + phys.a[c] * H) * phys.inv[c];
}

// The halo part alone, for the "halo only" preview.
function haloOnly(phys, c, L, H) {
  if (phys.excess) {
    const e = H - L;
    return e > 0 ? phys.a[c] * e : 0;
  }
  return phys.a[c] * H * phys.inv[c];
}

module.exports = {
  DEFAULTS,
  DEFAULT_COLOR,
  LAMBDA_FRACTION,
  LOBES,
  EXP_FIT,
  normalizeSettings,
  blurMultiplier,
  strengthToA,
  colorGains,
  buildLutIn,
  kernelGaussians,
  physics,
  combine,
  haloOnly,
  MODELS,
};
