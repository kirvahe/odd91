'use strict';
// Transfer curves: sRGB, the user point curve (monotone PCHIP spline) and LUT helpers.
// x is an 8-bit code (0..255), y is linear light (0..1).

const MAX_POINTS = 12;

function srgbToLinear(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(l) {
  if (l <= 0) return 0;
  if (l >= 1) return 1;
  return l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
}

const SRGB_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) SRGB_LUT[i] = srgbToLinear(i / 255);
SRGB_LUT[0] = 0;
SRGB_LUT[255] = 1;

// Linear [0,1] -> fractional sRGB code (0..255). Used only by the preview cache.
const SRGB_INV_N = 65536;
let srgbInv = null;
function srgbInverseTable() {
  if (!srgbInv) {
    srgbInv = new Float32Array(SRGB_INV_N + 1);
    for (let i = 0; i <= SRGB_INV_N; i++) srgbInv[i] = linearToSrgb(i / SRGB_INV_N) * 255;
  }
  return srgbInv;
}

function defaultCurvePoints() {
  // 10 points: max relative error vs sRGB 0.75 % (codes >= 8); leaves room for a point at 254.
  const xs = [2, 6, 12, 22, 38, 62, 96, 140, 190, 240];
  return xs.map((x) => [x, srgbToLinear(x / 255)]);
}

function endSlope(h0, h1, d0, d1) {
  let s = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
  if (Math.sign(s) !== Math.sign(d0)) s = 0;
  else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(s) > Math.abs(3 * d0)) s = 3 * d0;
  return s;
}

// PCHIP (Fritsch–Butland) tangents: monotone data -> monotone Hermite spline.
function pchipTangents(xs, ys) {
  const n = xs.length;
  const h = new Array(n - 1);
  const d = new Array(n - 1);
  for (let k = 0; k < n - 1; k++) {
    h[k] = xs[k + 1] - xs[k];
    d[k] = (ys[k + 1] - ys[k]) / h[k];
  }
  const m = new Array(n).fill(0);
  if (n === 2) {
    m[0] = m[1] = d[0];
    return m;
  }
  for (let k = 1; k < n - 1; k++) {
    if (d[k - 1] * d[k] <= 0) {
      m[k] = 0;
    } else {
      const w1 = 2 * h[k] + h[k - 1];
      const w2 = h[k] + 2 * h[k - 1];
      m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k]);
    }
  }
  m[0] = endSlope(h[0], h[1], d[0], d[1]);
  m[n - 1] = endSlope(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
  return m;
}

function makeSpline(points) {
  const xs = [0];
  const ys = [0];
  for (const p of points) {
    xs.push(p[0]);
    ys.push(p[1]);
  }
  xs.push(255);
  ys.push(1);
  return { xs, ys, m: pchipTangents(xs, ys) };
}

function evalSpline(sp, x) {
  const xs = sp.xs;
  if (x <= 0) return 0;
  if (x >= 255) return 1;
  let k = 0;
  while (k < xs.length - 2 && x > xs[k + 1]) k++;
  const h = xs[k + 1] - xs[k];
  const t = (x - xs[k]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * sp.ys[k] + h10 * h * sp.m[k] + h01 * sp.ys[k + 1] + h11 * h * sp.m[k + 1];
}

function lutFromPoints(points) {
  const sp = makeSpline(points);
  const lut = new Float32Array(256);
  for (let c = 0; c < 256; c++) lut[c] = evalSpline(sp, c);
  lut[0] = 0;
  lut[255] = 1;
  return lut;
}

function sanitizePoints(points) {
  if (!Array.isArray(points)) return null;
  const out = [];
  for (const p of points) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.push([Math.min(254, Math.max(1, x)), Math.min(1, Math.max(0, y))]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

function validateCurve(points) {
  const pts = sanitizePoints(points);
  if (!pts) return { ok: false, reason: 'bad-format', points: [] };
  if (pts.length > MAX_POINTS) return { ok: false, reason: 'too-many-points', points: pts };
  let px = 0;
  let py = 0;
  for (const p of pts) {
    if (p[0] - px < 1) return { ok: false, reason: 'x-too-close', points: pts };
    if (!(p[1] > py)) return { ok: false, reason: 'not-increasing', points: pts };
    px = p[0];
    py = p[1];
  }
  if (255 - px < 1) return { ok: false, reason: 'x-too-close', points: pts };
  if (!(1 > py)) return { ok: false, reason: 'not-increasing', points: pts };
  const lut = lutFromPoints(pts);
  for (let c = 0; c < 255; c++) {
    if (!(lut[c + 1] > lut[c])) return { ok: false, reason: 'lut-not-increasing', points: pts };
  }
  return { ok: true, reason: null, points: pts };
}

function curveSamples(points, n) {
  const pts = sanitizePoints(points) || defaultCurvePoints();
  const sp = makeSpline(pts);
  const count = Math.max(2, n | 0);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = evalSpline(sp, (255 * i) / (count - 1));
  return out;
}

// Auxiliary tables for the inverse transfer done directly on LUT_in (design 5.4).
// R[c] = 1/(lut[c+1]-lut[c]); T[c] = 0.02 * that step (the "unchanged" tolerance).
function lutAux(lut) {
  const R = new Float32Array(256);
  const T = new Float32Array(256);
  for (let c = 0; c < 255; c++) {
    const gap = lut[c + 1] - lut[c];
    R[c] = 1 / gap;
    T[c] = 0.02 * gap;
  }
  R[255] = R[254];
  T[255] = T[254];
  return { R, T };
}

module.exports = {
  MAX_POINTS,
  srgbToLinear,
  linearToSrgb,
  SRGB_LUT,
  SRGB_INV_N,
  srgbInverseTable,
  defaultCurvePoints,
  makeSpline,
  evalSpline,
  lutFromPoints,
  validateCurve,
  curveSamples,
  lutAux,
};
