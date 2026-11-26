'use strict';
// Separable filters on interleaved RGB Float32 planes (3 floats per pixel), clamp-to-edge.
// Running sums live in JS numbers (doubles) or Float64Array; only results go to Float32Array.
// Written without inner function calls: UXP runs JavaScript without a JIT.

// erf, Abramowitz–Stegun 7.1.26 (|error| < 1.5e-7)
function erf(x) {
  const s = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}

// Discrete Gaussian: weight of tap i = integral of the Gaussian over the pixel [i-0.5, i+0.5].
function gaussWeights(sigma, radius) {
  const w = new Float64Array(2 * radius + 1);
  const k = 1 / (sigma * Math.SQRT2);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = 0.5 * (erf((i + 0.5) * k) - erf((i - 0.5) * k));
    w[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < w.length; i++) w[i] /= sum;
  return w;
}

// Horizontal FIR. src and dst may be the same array (each row is copied to pad first).
// Symmetric taps are summed in pairs: half the multiplies and weight loads.
function firH3(src, dst, w, h, wts, radius, pad) {
  const stride = w * 3;
  const w0 = wts[radius];
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    let po = 0;
    for (let x = -radius; x < w + radius; x++) {
      const sx = x < 0 ? 0 : x >= w ? w - 1 : x;
      const so = row + sx * 3;
      pad[po] = src[so];
      pad[po + 1] = src[so + 1];
      pad[po + 2] = src[so + 2];
      po += 3;
    }
    let o = row;
    for (let x = 0; x < w; x++) {
      const pc = (x + radius) * 3;
      let a0 = w0 * pad[pc];
      let a1 = w0 * pad[pc + 1];
      let a2 = w0 * pad[pc + 2];
      let l = pc - 3;
      let r = pc + 3;
      for (let k = 1; k <= radius; k++) {
        const wk = wts[radius + k];
        a0 += wk * (pad[l] + pad[r]);
        a1 += wk * (pad[l + 1] + pad[r + 1]);
        a2 += wk * (pad[l + 2] + pad[r + 2]);
        l -= 3;
        r += 3;
      }
      dst[o] = a0;
      dst[o + 1] = a1;
      dst[o + 2] = a2;
      o += 3;
    }
  }
}

// Vertical FIR. src !== dst. acc: Float64Array(w*3).
function firV3(src, dst, w, h, wts, radius, acc) {
  const stride = w * 3;
  const hm = h - 1;
  const w0 = wts[radius];
  for (let y = 0; y < h; y++) {
    const oc = y * stride;
    for (let i = 0; i < stride; i++) acc[i] = w0 * src[oc + i];
    for (let k = 1; k <= radius; k++) {
      const ya = y - k < 0 ? 0 : y - k;
      const yb = y + k > hm ? hm : y + k;
      const oa = ya * stride;
      const ob = yb * stride;
      const wk = wts[radius + k];
      for (let i = 0; i < stride; i++) acc[i] += wk * (src[oa + i] + src[ob + i]);
    }
    for (let i = 0; i < stride; i++) dst[oc + i] = acc[i];
  }
}

// Extended box (Gwosdek et al.): radius r plus fractional end weight alpha, so that three
// passes reproduce the target variance exactly.
function boxParams(sigma, passes) {
  const v = (sigma * sigma) / passes;
  let r = Math.max(0, Math.floor((Math.sqrt(12 * v + 1) - 1) / 2));
  while (((r + 1) * (r + 2)) / 3 <= v) r++;
  while (r > 0 && (r * (r + 1)) / 3 > v) r--;
  const alpha = ((2 * r + 1) * ((r * (r + 1)) / 3 - v)) / (2 * (v - (r + 1) * (r + 1)));
  return { r, alpha, norm: 1 / (2 * r + 1 + 2 * alpha) };
}

// Horizontal extended box. src and dst may be the same array. pad: Float32Array((w+2r+2)*3).
function boxH3(src, dst, w, h, bp, pad) {
  const r = bp.r;
  const alpha = bp.alpha;
  const norm = bp.norm;
  const P = r + 1;
  const stride = w * 3;
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    let po = 0;
    for (let x = -P; x < w + P; x++) {
      const sx = x < 0 ? 0 : x >= w ? w - 1 : x;
      const so = row + sx * 3;
      pad[po] = src[so];
      pad[po + 1] = src[so + 1];
      pad[po + 2] = src[so + 2];
      po += 3;
    }
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    for (let i = 1; i <= 2 * r + 1; i++) {
      s0 += pad[i * 3];
      s1 += pad[i * 3 + 1];
      s2 += pad[i * 3 + 2];
    }
    let o = row;
    for (let x = 0; x < w; x++) {
      const qa = x * 3;                 // pad index of x - r - 1
      const qb = (x + 2 * r + 2) * 3;   // pad index of x + r + 1
      dst[o] = (s0 + alpha * (pad[qa] + pad[qb])) * norm;
      dst[o + 1] = (s1 + alpha * (pad[qa + 1] + pad[qb + 1])) * norm;
      dst[o + 2] = (s2 + alpha * (pad[qa + 2] + pad[qb + 2])) * norm;
      s0 += pad[qb] - pad[qa + 3];
      s1 += pad[qb + 1] - pad[qa + 4];
      s2 += pad[qb + 2] - pad[qa + 5];
      o += 3;
    }
  }
}

// Vertical extended box. src !== dst. sum: Float64Array(w*3).
function boxV3(src, dst, w, h, bp, sum) {
  const r = bp.r;
  const alpha = bp.alpha;
  const norm = bp.norm;
  const stride = w * 3;
  const hm = h - 1;
  sum.fill(0);
  for (let i = -r; i <= r; i++) {
    const sy = i < 0 ? 0 : i > hm ? hm : i;
    const so = sy * stride;
    for (let k = 0; k < stride; k++) sum[k] += src[so + k];
  }
  for (let y = 0; y < h; y++) {
    let ya = y - r - 1;
    ya = ya < 0 ? 0 : ya > hm ? hm : ya;
    let yb = y + r + 1;
    yb = yb < 0 ? 0 : yb > hm ? hm : yb;
    let yr = y - r;
    yr = yr < 0 ? 0 : yr > hm ? hm : yr;
    const oa = ya * stride;
    const ob = yb * stride;
    const orr = yr * stride;
    const o = y * stride;
    for (let k = 0; k < stride; k++) {
      dst[o + k] = (sum[k] + alpha * (src[oa + k] + src[ob + k])) * norm;
      sum[k] += src[ob + k] - src[orr + k];
    }
  }
}

module.exports = { erf, gaussWeights, firH3, firV3, boxParams, boxH3, boxV3 };
