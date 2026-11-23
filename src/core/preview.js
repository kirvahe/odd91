'use strict';
// Curve-independent preview cache (design 6.1) and preview rendering with the same halo engine.

const T = require('./transfer');
const S = require('./settings');
const H = require('./halo');
const { NOISE } = require('./bluenoise');

const NDX = [0, 23, 41];
const NDY = [0, 37, 11];
const ALPHA_TAB = new Float32Array(256);
for (let i = 0; i < 256; i++) ALPHA_TAB[i] = i / 255;
const SRGB_AUX = T.lutAux(T.SRGB_LUT);

function createPreviewBuilder(opts) {
  const width = opts.width | 0;
  const height = opts.height | 0;
  const maxLongSide = opts.maxLongSide > 0 ? opts.maxLongSide : 500;
  const block = Math.max(1, Math.ceil(Math.max(width, height) / maxLongSide));
  const pw = Math.ceil(width / block);
  const ph = Math.ceil(height / block);
  const n = pw * ph;
  const c255 = new Float32Array(n * 3);
  const dx255 = new Float32Array(n * 3); // sum of x offsets of 255-pixels from the block centre
  const dy255 = new Float32Array(n * 3);
  const sum = new Float64Array(n * 3);
  const cnt = new Float32Array(n);
  const asum = new Float32Array(n);
  let anyAlpha = false;
  const PX = new Int32Array(width);
  const DX = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    PX[x] = Math.floor(x / block);
    DX[x] = x - ((PX[x] + 0.5) * block - 0.5);
  }
  const lut = T.SRGB_LUT;

  return {
    width: pw,
    height: ph,
    block,
    // Every statistic is weighted by the pixel's alpha (the halo source is L * alpha), so a
    // transparent pixel never contributes light, whatever RGB it carries.
    push(data, comps, y0, rows) {
      const hasAlpha = comps === 4;
      for (let ry = 0; ry < rows; ry++) {
        const py = Math.floor((y0 + ry) / block);
        const prow = py * pw;
        const dy = y0 + ry - ((py + 0.5) * block - 0.5);
        let p = ry * width * comps;
        for (let x = 0; x < width; x++) {
          const bi = prow + PX[x];
          const b3 = bi * 3;
          cnt[bi] += 1;
          let a = 1;
          if (hasAlpha) {
            const al = data[p + 3];
            if (al < 255) anyAlpha = true;
            a = ALPHA_TAB[al];
          }
          asum[bi] += a;
          if (a > 0) {
            const v0 = data[p];
            const v1 = data[p + 1];
            const v2 = data[p + 2];
            const dxa = a * DX[x];
            const dya = a * dy;
            if (v0 === 255) { c255[b3] += a; dx255[b3] += dxa; dy255[b3] += dya; } else sum[b3] += a * lut[v0];
            if (v1 === 255) { c255[b3 + 1] += a; dx255[b3 + 1] += dxa; dy255[b3 + 1] += dya; } else sum[b3 + 1] += a * lut[v1];
            if (v2 === 255) { c255[b3 + 2] += a; dx255[b3 + 2] += dxa; dy255[b3 + 2] += dya; } else sum[b3 + 2] += a * lut[v2];
          }
          p += comps;
        }
      }
    },
    finish() {
      const f255 = new Float32Array(n * 3);
      const mean = new Float32Array(n * 3);
      const off255 = new Float32Array(n * 6); // centroid offset of 255-pixels, proxy px: (ox, oy) per channel
      const before = new Uint8Array(n * 3);
      const alpha = anyAlpha ? new Float32Array(n) : null;
      for (let i = 0; i < n; i++) {
        const k = cnt[i] || 1;
        const aw = asum[i]; // total alpha weight of the block
        if (alpha) alpha[i] = aw / k;
        for (let c = 0; c < 3; c++) {
          const j = i * 3 + c;
          const f = aw > 0 ? c255[j] / aw : 0;
          const rest = aw - c255[j];
          const m = rest > 1e-12 ? sum[j] / rest : 0;
          f255[j] = f;
          mean[j] = m;
          if (c255[j] > 0) {
            off255[i * 6 + c * 2] = dx255[j] / c255[j] / block;
            off255[i * 6 + c * 2 + 1] = dy255[j] / c255[j] / block;
          }
          before[j] = Math.round(T.linearToSrgb(f + (1 - f) * m) * 255);
        }
      }
      return { width: pw, height: ph, srcWidth: width, srcHeight: height, block, f255, mean, off255, alpha, before };
    },
  };
}

// Half-size proxy for the draft preview while a slider is being dragged (about 8x cheaper).
// Statistics combine exactly: f255 averages, the rest-mean is weighted by (1 - f255), the 255
// centroid is weighted by f255 (child centres sit at +-0.25 parent px).
function downscaleProxy(p) {
  const w = p.width;
  const h = p.height;
  const w2 = Math.ceil(w / 2);
  const h2 = Math.ceil(h / 2);
  const n2 = w2 * h2;
  const f255 = new Float32Array(n2 * 3);
  const mean = new Float32Array(n2 * 3);
  const off255 = new Float32Array(n2 * 6);
  const before = new Uint8Array(n2 * 3);
  const alpha = p.alpha ? new Float32Array(n2) : null;
  for (let y2 = 0; y2 < h2; y2++) {
    for (let x2 = 0; x2 < w2; x2++) {
      const o = y2 * w2 + x2;
      let cnt = 0;
      let asum = 0;
      const fs = [0, 0, 0];
      const rest = [0, 0, 0];
      const msum = [0, 0, 0];
      const ox = [0, 0, 0];
      const oy = [0, 0, 0];
      for (let dy = 0; dy < 2; dy++) {
        const y = 2 * y2 + dy;
        if (y >= h) continue;
        for (let dx = 0; dx < 2; dx++) {
          const x = 2 * x2 + dx;
          if (x >= w) continue;
          const i = y * w + x;
          cnt++;
          if (alpha) asum += p.alpha[i];
          for (let c = 0; c < 3; c++) {
            const f = p.f255[i * 3 + c];
            fs[c] += f;
            rest[c] += 1 - f;
            msum[c] += (1 - f) * p.mean[i * 3 + c];
            ox[c] += f * ((dx - 0.5) * 0.5 + (p.off255 ? p.off255[i * 6 + c * 2] : 0) / 2);
            oy[c] += f * ((dy - 0.5) * 0.5 + (p.off255 ? p.off255[i * 6 + c * 2 + 1] : 0) / 2);
          }
        }
      }
      if (alpha) alpha[o] = asum / cnt;
      for (let c = 0; c < 3; c++) {
        const f = fs[c] / cnt;
        const m = rest[c] > 0 ? msum[c] / rest[c] : 0;
        f255[o * 3 + c] = f;
        mean[o * 3 + c] = m;
        if (fs[c] > 0) {
          off255[o * 6 + c * 2] = ox[c] / fs[c];
          off255[o * 6 + c * 2 + 1] = oy[c] / fs[c];
        }
        before[o * 3 + c] = Math.round(T.linearToSrgb(f + (1 - f) * m) * 255);
      }
    }
  }
  return { width: w2, height: h2, srcWidth: p.srcWidth, srcHeight: p.srcHeight, block: p.block * 2, f255, mean, off255, alpha, before };
}

// Linear light of the proxy for the current curve: L = f255 + (1 - f255) * LUT_in[code(M)].
// Returns { L, Lrest }: L is the block's mean light for the curve, Lrest the light of its
// non-255 part (needed to display the block as the average of what its pixels would show).
function proxyLinear(proxy, settings, lut) {
  const n = proxy.width * proxy.height * 3;
  const L = new Float32Array(n);
  const Lrest = new Float32Array(n);
  const f = proxy.f255;
  const m = proxy.mean;
  if (settings.mode === 'srgb') {
    for (let i = 0; i < n; i++) {
      Lrest[i] = m[i];
      L[i] = f[i] + (1 - f[i]) * m[i];
    }
    return { L, Lrest };
  }
  const inv = T.srgbInverseTable();
  const N = T.SRGB_INV_N;
  for (let i = 0; i < n; i++) {
    const u = m[i] * N;
    const k = u >= N ? N - 1 : u | 0;
    const code = inv[k] + (u - k) * (inv[k + 1] - inv[k]);
    const ci = code >= 255 ? 254 : code | 0;
    const cf = code - ci;
    const lin = lut[ci] + cf * (lut[ci + 1] - lut[ci]);
    Lrest[i] = lin;
    L[i] = f[i] + (1 - f[i]) * lin;
  }
  return { L, Lrest };
}

// Curve light -> displayed (sRGB-linear) light of the dithered 8-bit output: the output mixes
// codes c and c+1 with probability t in curve light, so its mean display light is the lerp.
function displayLight(lut, R, v) {
  if (v >= 1) return 1;
  if (v <= 0) return 0;
  let lo = 0;
  let hi = 255;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (lut[mid] <= v) lo = mid;
    else hi = mid;
  }
  const t = (v - lut[lo]) * R[lo];
  return T.SRGB_LUT[lo] + t * (T.SRGB_LUT[lo + 1] - T.SRGB_LUT[lo]);
}

// 1D splat weights at proxy offsets (-1, 0, +1) with mean o and variance max(v, bilinear).
// v is the variance of the block box filter, which the averaged (non-255) part already has.
function splatWeights(o, v, out) {
  const a = Math.abs(o);
  if (a * (1 - a) >= v) {
    out[0] = o < 0 ? a : 0;
    out[1] = 1 - a;
    out[2] = o > 0 ? a : 0;
  } else {
    const s2 = v + o * o;
    out[0] = (s2 - o) / 2;
    out[1] = 1 - s2;
    out[2] = (s2 + o) / 2;
  }
}

// Linear value -> 8-bit code through LUT_in with blue-noise dither (binary search; preview only).
function encode(lut, R, v, noise) {
  if (v >= 1) return 255;
  if (v <= 0) return 0;
  let lo = 0;
  let hi = 255;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (lut[mid] <= v) lo = mid;
    else hi = mid;
  }
  return (v - lut[lo]) * R[lo] + noise >= 1 ? lo + 1 : lo;
}

// Linear light and halo field of the proxy for the given settings (shared with tests).
function previewFields(proxy, settings, opts) {
  const o = opts || {};
  const w = proxy.width;
  const h = proxy.height;
  const alpha = proxy.alpha;
  const phys = S.physics(settings);
  const s = phys.s;
  const lut = S.buildLutIn(s);
  const aux = T.lutAux(lut);
  const lin = proxyLinear(proxy, s, lut);
  const L = lin.L;
  const n = w * h;
  // Halo source: the 255-part of each block (light sources) is splatted bilinearly at its
  // sub-block centroid, so a small lamp's halo is centred where the lamp really is.
  const src = new Float32Array(n * 3);
  const f = proxy.f255;
  const off = proxy.off255;
  const blk = proxy.block;
  const vBox = (blk * blk - 1) / (12 * blk * blk);
  const wx = [0, 0, 0];
  const wy = [0, 0, 0];
  // Threshold (approximate per block): the non-255 part is weighted by the luminance of its mean
  // colour, the 255 part by the weight of white. The loupe shows the exact per-pixel result.
  const m = proxy.mean;
  const wRest = new Float32Array(n);
  const w255 = S.lumaWeight(phys, 1);
  for (let i = 0; i < n; i++) {
    wRest[i] = S.lumaWeight(phys, S.LUMA[0] * m[i * 3] + S.LUMA[1] * m[i * 3 + 1] + S.LUMA[2] * m[i * 3 + 2]);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const al = alpha ? alpha[i] : 1;
      for (let c = 0; c < 3; c++) {
        const j = i * 3 + c;
        const part = f[j] * al * w255; // 255 maps to linear 1 for every curve
        src[j] += (L[j] * al - f[j] * al) * wRest[i];
        if (part === 0) continue;
        splatWeights(off ? off[i * 6 + c * 2] : 0, vBox, wx);
        splatWeights(off ? off[i * 6 + c * 2 + 1] : 0, vBox, wy);
        for (let dy = -1; dy <= 1; dy++) {
          const wyv = wy[dy + 1];
          if (wyv === 0) continue;
          const yy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy;
          for (let dx = -1; dx <= 1; dx++) {
            const wxv = wx[dx + 1];
            if (wxv === 0) continue;
            const xx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx;
            src[(yy * w + xx) * 3 + c] += part * wxv * wyv;
          }
        }
      }
    }
  }
  const docLongSide = o.docLongSide > 0 ? o.docLongSide : Math.max(proxy.srcWidth, proxy.srcHeight);
  const field = phys.A === 0 ? src : H.runToEnd(H.haloForChannels(src, w, h, S.kernelGaussians(s, docLongSide, 1 / proxy.block)));
  return { phys, lut, aux, L, Lrest: lin.Lrest, field, wRest, w255 };
}

function renderPreview(fullProxy, settings, view, opts) {
  let proxy = fullProxy;
  if (opts && opts.draft) {
    if (!fullProxy._draft) fullProxy._draft = downscaleProxy(fullProxy);
    proxy = fullProxy._draft;
  }
  const w = proxy.width;
  const h = proxy.height;
  const out = new Uint8Array(w * h * 3);
  const alpha = proxy.alpha;
  if (view === 'before') {
    out.set(proxy.before);
  } else {
    // Each proxy pixel stands for a block: its non-255 part and its 255 part (sources) are
    // processed separately, turned into display light through the curve, and mixed in display
    // light. Mixing in curve light would let a thin white line (1/12 of a block) brighten the
    // whole block to white under a curve with a jump.
    const { phys, lut, aux, Lrest, field, wRest, w255 } = previewFields(proxy, settings, opts);
    const f = proxy.f255;
    const ex = phys.excess;
    const halo = view === 'halo';
    const srgb = phys.s.mode === 'srgb';
    const R = aux.R;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        for (let c = 0; c < 3; c++) {
          const j = i * 3 + c;
          const a = phys.a[c];
          const inv = phys.inv[c];
          const hv = field[j];
          const lr = Lrest[j];
          let e = hv - wRest[i] * lr;
          let o;
          if (halo) o = ex ? (e > 0 ? a * e : 0) : a * hv * inv;
          else o = ex ? (e > 0 ? lr + a * e : lr) : lr + a * e * inv;
          let disp = srgb ? (o >= 1 ? 1 : o <= 0 ? 0 : o) : displayLight(lut, R, o);
          const fj = f[j];
          if (fj > 0) {
            e = hv - w255; // the 255 part has linear light 1 for every curve
            if (halo) o = ex ? (e > 0 ? a * e : 0) : a * hv * inv;
            else o = ex ? (e > 0 ? 1 + a * e : 1) : 1 + a * e * inv;
            const d255 = srgb ? (o >= 1 ? 1 : o <= 0 ? 0 : o) : displayLight(lut, R, o);
            disp = fj * d255 + (1 - fj) * disp;
          }
          const noise = NOISE[(((y + NDY[c]) & 63) << 6) + ((x + NDX[c]) & 63)];
          out[j] = encode(T.SRGB_LUT, SRGB_AUX.R, disp, noise);
        }
      }
    }
  }
  if (alpha) {
    for (let i = 0; i < w * h; i++) {
      const al = alpha[i];
      for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(out[i * 3 + c] * al + 128 * (1 - al));
    }
  }
  return { data: out, width: w, height: h };
}

module.exports = { createPreviewBuilder, renderPreview, proxyLinear, previewFields, downscaleProxy };
