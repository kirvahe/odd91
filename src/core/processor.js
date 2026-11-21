'use strict';
// Full-resolution two-pass strip processor (design 5.5–5.6) and the one-shot processImage.

const T = require('./transfer');
const S = require('./settings');
const H = require('./halo');
const { NOISE } = require('./bluenoise');

const STRIP_PIXELS = 1000000;
const BASE_MAX_PIXELS = 6000000;  // memory cap for the base grid (design 5.7: <= 400 MB)
// Up to this size the base grid is full resolution. Code review: 3 Mpx took 12.3 s at full
// resolution vs 6.7 s at base level 1, with at most 3 codes of difference.
const FULL_RES_MAX = 1000000;

// Dither tile offsets per channel (design 5.4).
const NDX = [0, 23, 41];
const NDY = [0, 37, 11];

// Variance (full-res px^2, per axis) added by averaging into the base grid (box F = 2^b) and the
// bilinear upsampling back in pass 2. Subtracted from each Gaussian so the kernel stays exact.
function baseResampleVariance(b) {
  if (b === 0) return 0;
  const F = 1 << b;
  let m = 0;
  for (let i = 0; i < F; i++) {
    const u = (i + 0.5) / F;
    m += u * (1 - u);
  }
  return (F * F - 1) / 12 + (F * F * m) / F;
}

function baseGaussians(settings, docLongSide, b) {
  const scale = 1 << b;
  const extra = baseResampleVariance(b);
  return S.kernelGaussians(settings, docLongSide, 1).map((list) =>
    list.map((g) => {
      const v = g.sigma * g.sigma - extra;
      return { sigma: v > 0 ? Math.sqrt(v) / scale : 0, weight: g.weight, wide: g.wide };
    })
  );
}

function autoBaseLevel(w, h) {
  if (w * h <= FULL_RES_MAX) return 0;
  let b = 1;
  while (Math.ceil(w / (1 << b)) * Math.ceil(h / (1 << b)) > BASE_MAX_PIXELS) b++;
  return b;
}

function createProcessor(opts) {
  const w = opts.width | 0;
  const h = opts.height | 0;
  if (!(w > 0 && h > 0)) throw new Error('createProcessor: empty work area');
  const originX = opts.originX | 0;
  const originY = opts.originY | 0;
  const docLongSide = opts.docLongSide > 0 ? opts.docLongSide : Math.max(w, h);
  const phys = S.physics(opts.settings);
  const settings = phys.s;
  const lut = S.buildLutIn(settings);
  const aux = T.lutAux(lut);
  const R = aux.R;
  const TOL = aux.T;
  const a0 = phys.a[0];
  const a1 = phys.a[1];
  const a2 = phys.a[2];
  const inv0 = phys.inv[0];
  const inv1 = phys.inv[1];
  const inv2 = phys.inv[2];
  const identity = phys.A === 0;
  const ex = phys.excess;

  const b = opts.baseLevel != null ? opts.baseLevel | 0 : autoBaseLevel(w, h);
  const scale = 1 << b;
  const bw = Math.ceil(w / scale);
  const bh = Math.ceil(h / scale);
  let base = identity ? null : new Float32Array(bw * bh * 3);
  let field = null; // H on the base grid after blurSteps()

  // Precomputed horizontal mapping full-res x -> base grid (bilinear, centre convention).
  const XA = new Int32Array(w);
  const XB = new Int32Array(w);
  const XF = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const u = (x + 0.5) / scale - 0.5;
    const i0 = Math.floor(u);
    const f = u - i0;
    const ia = i0 < 0 ? 0 : i0 >= bw ? bw - 1 : i0;
    const ib = i0 + 1 < 0 ? 0 : i0 + 1 >= bw ? bw - 1 : i0 + 1;
    XA[x] = ia * 3;
    XB[x] = ib * 3;
    XF[x] = f;
  }
  const ALPHA = new Float32Array(256);
  for (let i = 0; i < 256; i++) ALPHA[i] = i / 255;

  const timings = { pass1: 0, blur: 0, pass2: 0 };
  const stripRows = Math.max(1, Math.min(h, Math.floor(STRIP_PIXELS / w)));

  function pass1(data, comps, y0, rows) {
    if (identity) return;
    const t0 = Date.now();
    const bstride = bw * 3;
    for (let ry = 0; ry < rows; ry++) {
      const y = y0 + ry;
      const brow = (y >> b) * bstride;
      let p = ry * w * comps;
      if (comps === 4) {
        for (let x = 0; x < w; x++) {
          const al = ALPHA[data[p + 3]];
          const bi = brow + (x >> b) * 3;
          base[bi] += lut[data[p]] * al;
          base[bi + 1] += lut[data[p + 1]] * al;
          base[bi + 2] += lut[data[p + 2]] * al;
          p += 4;
        }
      } else {
        for (let x = 0; x < w; x++) {
          const bi = brow + (x >> b) * 3;
          base[bi] += lut[data[p]];
          base[bi + 1] += lut[data[p + 1]];
          base[bi + 2] += lut[data[p + 2]];
          p += 3;
        }
      }
    }
    timings.pass1 += Date.now() - t0;
  }

  function* blurSteps() {
    if (identity) {
      yield 1;
      return;
    }
    const t0 = Date.now();
    if (b > 0) {
      // sums -> averages (partial edge blocks average the available pixels)
      for (let by = 0; by < bh; by++) {
        const cy = Math.min(scale, h - by * scale);
        for (let bx = 0; bx < bw; bx++) {
          const cx = Math.min(scale, w - bx * scale);
          const k = 1 / (cx * cy);
          const i = (by * bw + bx) * 3;
          base[i] *= k;
          base[i + 1] *= k;
          base[i + 2] *= k;
        }
      }
    }
    const gaussians = baseGaussians(settings, docLongSide, b);
    const gen = H.haloForChannels(base, bw, bh, gaussians);
    let r = gen.next();
    let elapsed = 0;
    while (!r.done) {
      elapsed += Date.now() - t0;
      yield r.value;
      r = gen.next();
    }
    field = r.value;
    base = null;
    timings.blur = Date.now() - t0;
  }

  function pass2(data, comps, y0, rows, out) {
    if (identity) {
      out.set(data.subarray(0, rows * w * comps));
      return;
    }
    if (!field) throw new Error('pass2 before blurSteps finished');
    const t0 = Date.now();
    const bstride = bw * 3;
    const rowBuf = new Float32Array(bstride);
    const Hf = field;
    for (let ry = 0; ry < rows; ry++) {
      const y = y0 + ry;
      const u = (y + 0.5) / scale - 0.5;
      const i0 = Math.floor(u);
      const fy = u - i0;
      const ya = i0 < 0 ? 0 : i0 >= bh ? bh - 1 : i0;
      const yb = i0 + 1 < 0 ? 0 : i0 + 1 >= bh ? bh - 1 : i0 + 1;
      const oa = ya * bstride;
      const ob = yb * bstride;
      const wa = 1 - fy;
      for (let i = 0; i < bstride; i++) rowBuf[i] = wa * Hf[oa + i] + fy * Hf[ob + i];
      const gy = originY + y;
      const nr0 = ((gy + NDY[0]) & 63) << 6;
      const nr1 = ((gy + NDY[1]) & 63) << 6;
      const nr2 = ((gy + NDY[2]) & 63) << 6;
      let p = ry * w * comps;
      for (let x = 0; x < w; x++) {
        if (comps === 4) {
          const al = data[p + 3];
          out[p + 3] = al;
          if (al === 0) {
            out[p] = data[p];
            out[p + 1] = data[p + 1];
            out[p + 2] = data[p + 2];
            p += 4;
            continue;
          }
        }
        const xa = XA[x];
        const xb = XB[x];
        const fx = XF[x];
        const gx = originX + x;
        let code;
        let L;
        let O;
        let d;
        let t;
        let c;
        let hv;

        // R
        code = data[p];
        L = lut[code];
        hv = rowBuf[xa] + fx * (rowBuf[xb] - rowBuf[xa]);
        if (ex) { d = hv - L; O = d > 0 ? L + a0 * d : L; } else O = (L + a0 * hv) * inv0;
        d = O - L;
        t = TOL[code];
        if (d < t && d > -t) {
          out[p] = code;
        } else {
          c = code;
          if (d > 0) { while (c < 255 && O >= lut[c + 1]) c++; } else { while (c > 0 && O < lut[c]) c--; }
          out[p] = c >= 255 ? 255 : ((O - lut[c]) * R[c] + NOISE[nr0 + ((gx + NDX[0]) & 63)] >= 1 ? c + 1 : c);
        }
        // G
        code = data[p + 1];
        L = lut[code];
        hv = rowBuf[xa + 1] + fx * (rowBuf[xb + 1] - rowBuf[xa + 1]);
        if (ex) { d = hv - L; O = d > 0 ? L + a1 * d : L; } else O = (L + a1 * hv) * inv1;
        d = O - L;
        t = TOL[code];
        if (d < t && d > -t) {
          out[p + 1] = code;
        } else {
          c = code;
          if (d > 0) { while (c < 255 && O >= lut[c + 1]) c++; } else { while (c > 0 && O < lut[c]) c--; }
          out[p + 1] = c >= 255 ? 255 : ((O - lut[c]) * R[c] + NOISE[nr1 + ((gx + NDX[1]) & 63)] >= 1 ? c + 1 : c);
        }
        // B
        code = data[p + 2];
        L = lut[code];
        hv = rowBuf[xa + 2] + fx * (rowBuf[xb + 2] - rowBuf[xa + 2]);
        if (ex) { d = hv - L; O = d > 0 ? L + a2 * d : L; } else O = (L + a2 * hv) * inv2;
        d = O - L;
        t = TOL[code];
        if (d < t && d > -t) {
          out[p + 2] = code;
        } else {
          c = code;
          if (d > 0) { while (c < 255 && O >= lut[c + 1]) c++; } else { while (c > 0 && O < lut[c]) c--; }
          out[p + 2] = c >= 255 ? 255 : ((O - lut[c]) * R[c] + NOISE[nr2 + ((gx + NDX[2]) & 63)] >= 1 ? c + 1 : c);
        }
        p += comps;
      }
    }
    timings.pass2 += Date.now() - t0;
  }

  return {
    stripRows,
    pass1,
    blurSteps,
    pass2,
    get field() {
      return field;
    },
    get stats() {
      const plan = identity ? [] : H.planGaussians(baseGaussians(settings, docLongSide, b)[0], bw, bh);
      return {
        baseLevel: b,
        baseWidth: bw,
        baseHeight: bh,
        bytesBase: bw * bh * 3 * 4,
        gaussians: plan,
        timings: Object.assign({}, timings),
        identity,
      };
    },
  };
}

function processImage(data, width, height, components, settings, opts) {
  const o = opts || {};
  const proc = createProcessor({
    width,
    height,
    originX: o.originX || 0,
    originY: o.originY || 0,
    docLongSide: o.docLongSide || Math.max(width, height),
    settings,
    baseLevel: o.baseLevel,
  });
  const rows = Math.max(1, o.stripRows || proc.stripRows);
  const rowBytes = width * components;
  for (let y = 0; y < height; y += rows) {
    const n = Math.min(rows, height - y);
    proc.pass1(data.subarray(y * rowBytes, (y + n) * rowBytes), components, y, n);
  }
  H.runToEnd(proc.blurSteps());
  const out = new Uint8Array(data.length);
  for (let y = 0; y < height; y += rows) {
    const n = Math.min(rows, height - y);
    proc.pass2(data.subarray(y * rowBytes, (y + n) * rowBytes), components, y, n, out.subarray(y * rowBytes, (y + n) * rowBytes));
  }
  return out;
}

module.exports = { createProcessor, processImage, autoBaseLevel };
