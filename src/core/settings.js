'use strict';
// Settings normalization, slider mappings, glow color and the halation kernel definition.

const T = require('./transfer');

const DEFAULT_COLOR = [255, 144, 39];
const MAX_STRENGTH_A = 1.0;           // strength 100 -> A = 1 (quadratic slider, see strengthToA)
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
  mode: 'srgb',          // 'srgb' | 'curve' | 'reinhard' (8-bit -> scene-linear, inverse Reinhard)
  reinhardLimit: 1.1,
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

// Quadratic slider: 30 -> 0.09 (near the measured film values 0.05-0.12), 50 -> 0.25,
// 100 -> 1.0 (the strength of hotgluebanjo's Proosa method, a_R = 1).
function strengthToA(strength) {
  const u = clampNum(strength, 0, 100, 30) / 100;
  return MAX_STRENGTH_A * u * u;
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

// Inverse Reinhard expansion for display-referred 8-bit input (as in the Nuke "Halation" gizmo's
// 8-bit mode): x = sRGB-linear display value, y = x*Lim/(Lim - x) is scene-linear with headroom
// (Lim = 1.1 -> code 255 is 11x scene white). Normalized so code 255 -> 1; re-encoding through
// the same table is the forward Reinhard, i.e. a film-like shoulder on output.
function reinhardLut(limit) {
  const lut = new Float32Array(256);
  const top = limit / (limit - 1);
  for (let c = 0; c < 256; c++) {
    const x = T.SRGB_LUT[c];
    lut[c] = (x * limit) / (limit - x) / top;
  }
  lut[0] = 0;
  lut[255] = 1;
  return lut;
}

function normalizeSettings(partial) {
  const s = partial && typeof partial === 'object' ? partial : {};
  const mode = s.mode === 'curve' || s.mode === 'reinhard' ? s.mode : 'srgb';
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
    reinhardLimit: clampNum(s.reinhardLimit, 1.01, 4, 1.1),
    radii,
  };
}

function buildLutIn(settings) {
  const s = normalizeSettings(settings);
  if (s.mode === 'srgb') return new Float32Array(T.SRGB_LUT);
  if (s.mode === 'reinhard') return reinhardLut(s.reinhardLimit);
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
