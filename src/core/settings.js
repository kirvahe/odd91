'use strict';
// Settings normalization, slider mappings, glow color, source threshold and the halation kernel.

const T = require('./transfer');

const DEFAULT_COLOR = [255, 144, 39];
const LAMBDA_FRACTION = 0.0018;       // core lambda = 0.18 % of the document long side at x1
const LOBES = [[0.6, 1.0], [0.4, 3.3]]; // [weight, lambda factor]: core + tail exponentials
// exp(-r/lambda) in 2D as a sum of isotropic Gaussians: [amplitude, sigma/lambda] (spektrafilm fit)
const EXP_FIT = [[0.1633, 0.536], [0.6496, 1.5236], [0.187, 2.7684]];

const BLUR_MIN = 0.01;
const BLUR_MAX = 4;
const STRENGTH_MAX = 400;

// Halation model (E = H - w*L: halo light received minus the pixel's own emitted share):
//  'excess'     O = L + a * max(E, 0). Only light arriving in excess of what a flat field gives
//               itself is added: no global cast, nothing ever loses light (no cyan rims, small
//               255 sources stay 255). Calibration on a flat field plus a film shoulder that hides
//               the negative part on the bright side of edges.
//  'normalized' O = L + a * E / (1 + a), i.e. (L + a*H)/(1 + a) without a threshold (spektrafilm,
//               ENS, hotgluebanjo Proosa). In 8-bit display-referred images bright edges and small
//               sources lose red (cyan rims).
const MODELS = ['excess', 'normalized'];

const DEFAULTS = Object.freeze({
  model: 'excess',
  mode: 'srgb',          // 'srgb' | 'curve' | 'reinhard' (8-bit -> scene-linear, inverse Reinhard)
  reinhardLimit: 1.1,
  curvePoints: Object.freeze(T.defaultCurvePoints().map((p) => Object.freeze(p))),
  color: Object.freeze(DEFAULT_COLOR.slice()),
  blurMul: 1,            // 0.01 .. 4
  strength: 30,          // percent, 0 .. 400
  threshold: 0,          // display-luminance code 0..255; 0 = every pixel emits
  softness: 32,          // transition width in codes
  radii: Object.freeze([1, 1, 1]),
});

function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function legacyBlurToMul(blur) {
  return Math.pow(2, (clampNum(blur, 0, 100, 50) - 50) / 25);
}

// Log slider: u 0..100 <-> m 0.01..4 (x1 at u ~ 76.9).
function blurFromSlider(u) {
  const t = clampNum(u, 0, 100, 76.87) / 100;
  return BLUR_MIN * Math.pow(BLUR_MAX / BLUR_MIN, t);
}

function blurToSlider(m) {
  const v = clampNum(m, BLUR_MIN, BLUR_MAX, 1);
  return (100 * Math.log(v / BLUR_MIN)) / Math.log(BLUR_MAX / BLUR_MIN);
}

// With a settings object: its normalized multiplier. With a number: the v1.0 slider mapping.
function blurMultiplier(x) {
  if (x && typeof x === 'object') return normalizeSettings(x).blurMul;
  return legacyBlurToMul(x);
}

// Percent -> a_R: quadratic up to 100 % (30 -> 0.09, near measured film values; 100 -> 1, the
// Proosa level), linear above (400 % -> 4).
function strengthToA(percent) {
  const u = clampNum(percent, 0, STRENGTH_MAX, 30) / 100;
  return u <= 1 ? u * u : u;
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
  let blurMul = 1;
  if (s.blurMul !== undefined && Number.isFinite(Number(s.blurMul))) blurMul = clampNum(s.blurMul, BLUR_MIN, BLUR_MAX, 1);
  else if (s.blur !== undefined) blurMul = clampNum(legacyBlurToMul(s.blur), BLUR_MIN, BLUR_MAX, 1);
  return {
    model: MODELS.indexOf(s.model) >= 0 ? s.model : 'excess',
    mode,
    curvePoints,
    color,
    blurMul,
    strength: clampNum(s.strength, 0, STRENGTH_MAX, 30),
    reinhardLimit: clampNum(s.reinhardLimit, 1.01, 4, 1.1),
    threshold: clampNum(s.threshold, 0, 255, 0),
    softness: clampNum(s.softness, 0, 255, 32),
    radii,
  };
}

function buildLutIn(settings) {
  const s = normalizeSettings(settings);
  if (s.mode === 'srgb') return new Float32Array(T.SRGB_LUT);
  if (s.mode === 'reinhard') return reinhardLut(s.reinhardLimit);
  return T.lutFromPoints(s.curvePoints);
}

// Source weight by display luminance: w = smoothstep(thr - soft/2, thr + soft/2, Y'), where
// Y' = sRGB-encoded Rec.709 luminance in codes. Tabulated over linear luminance Y (4096 bins,
// index = Y * 4095). Returns null when the threshold is off (w = 1 everywhere).
const WEIGHT_N = 4095;
function weightTable(settings) {
  const s = normalizeSettings(settings);
  if (!(s.threshold > 0)) return null;
  const tab = new Float32Array(WEIGHT_N + 1);
  const e0 = s.threshold - s.softness / 2;
  const e1 = s.threshold + s.softness / 2;
  for (let i = 0; i <= WEIGHT_N; i++) {
    const code = T.linearToSrgb(i / WEIGHT_N) * 255;
    let w;
    if (e1 <= e0) w = code >= s.threshold ? 1 : 0;
    else {
      const t = Math.min(1, Math.max(0, (code - e0) / (e1 - e0)));
      w = t * t * (3 - 2 * t);
    }
    tab[i] = w;
  }
  return tab;
}

const LUMA = [0.2126, 0.7152, 0.0722];

// Per-channel list of Gaussians {sigma, weight, wide}. sigma is in pixels of a grid where
// one pixel = 1/scale document pixels (scale = 1 for full resolution).
function kernelGaussians(settings, docLongSide, scale) {
  const s = normalizeSettings(settings);
  const lambda = LAMBDA_FRACTION * docLongSide * s.blurMul * scale;
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

// Pixels to read around a region so the halo tail inside it is complete (widest Gaussian x 3.5).
function loupeMargin(settings, docLongSide) {
  const s = normalizeSettings(settings);
  const lambda = LAMBDA_FRACTION * Math.max(1, docLongSide) * s.blurMul * Math.max(s.radii[0], s.radii[1], s.radii[2]);
  const widest = EXP_FIT[2][1] * LOBES[1][1] * lambda;
  return Math.max(8, Math.min(1024, Math.ceil(3.5 * widest)));
}

// Physics parameters shared by the processor and the preview.
function physics(settings) {
  const s = normalizeSettings(settings);
  const g = colorGains(s.color);
  const A = strengthToA(s.strength);
  const a = [A * g[0], A * g[1], A * g[2]];
  return { s, A, a, inv: a.map((x) => 1 / (1 + x)), excess: s.model === 'excess', wTab: weightTable(s) };
}

// Weight of a pixel from its 8-bit codes (1 when the threshold is off).
function pixelWeight(phys, r, g, b) {
  if (!phys.wTab) return 1;
  const Y = LUMA[0] * T.SRGB_LUT[r] + LUMA[1] * T.SRGB_LUT[g] + LUMA[2] * T.SRGB_LUT[b];
  return phys.wTab[(Y * WEIGHT_N + 0.5) | 0];
}

// Weight from a linear luminance value (preview blocks).
function lumaWeight(phys, Y) {
  if (!phys.wTab) return 1;
  const k = Y <= 0 ? 0 : Y >= 1 ? WEIGHT_N : (Y * WEIGHT_N + 0.5) | 0;
  return phys.wTab[k];
}

// Output linear light of one channel (reference implementation; hot loops inline this).
function combine(phys, c, L, H, w) {
  const e = H - (w === undefined ? 1 : w) * L;
  if (phys.excess) return e > 0 ? L + phys.a[c] * e : L;
  return L + phys.a[c] * e * phys.inv[c];
}

// The halo part alone, for "halo only" views.
function haloOnly(phys, c, L, H, w) {
  if (phys.excess) {
    const e = H - (w === undefined ? 1 : w) * L;
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
  BLUR_MIN,
  BLUR_MAX,
  STRENGTH_MAX,
  LUMA,
  WEIGHT_N,
  normalizeSettings,
  blurMultiplier,
  blurFromSlider,
  blurToSlider,
  strengthToA,
  colorGains,
  buildLutIn,
  weightTable,
  kernelGaussians,
  loupeMargin,
  physics,
  pixelWeight,
  lumaWeight,
  combine,
  haloOnly,
  MODELS,
};
