'use strict';
// Full-resolution two-pass strip processor (design 5.5–5.6, appendices C–H) and processImage.
//
// Kernel split: Gaussians at least one base-grid pixel wide run on the pyramid (pass 1 averages
// the source into the base grid, blurSteps() blurs it); narrower ones ("fine") would collapse into
// the resampling kernel, so pass 2 computes them at full resolution from the strip itself, which
// needs `fineRadius` rows of context above and below each strip.

const T = require('./transfer');
const S = require('./settings');
const H = require('./halo');
const B = require('./blur');
const { NOISE } = require('./bluenoise');

const STRIP_PIXELS = 1000000;
const BASE_MAX_PIXELS = 6000000;  // memory cap for the base grid (design 5.7)
// Up to this size the base grid is full resolution (code review v1.0: 3 Mpx 12.3 s -> 6.5 s).
const FULL_RES_MAX = 1000000;
// Gaussians narrower than this many base-grid pixels are computed at full resolution in pass 2.
const FINE_SIGMA_BASE = 1.0;

// Dither tile offsets per channel (design 5.4).
const NDX = [0, 23, 41];
const NDY = [0, 37, 11];

// Variance (full-res px^2, per axis) added by averaging into the base grid (box F = 2^b) and the
// bilinear upsampling back in pass 2. Subtracted from each base Gaussian so the kernel stays exact.
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

function autoBaseLevel(w, h) {
  if (w * h <= FULL_RES_MAX) return 0;
  let b = 1;
  while (Math.ceil(w / (1 << b)) * Math.ceil(h / (1 << b)) > BASE_MAX_PIXELS) b++;
  return b;
}

// Splits the per-channel kernel into the pyramid part (sigma in base-grid px, compensated for the
// base resampling) and the full-resolution part: a list of {weight, sigma} per channel, kept as
// individual Gaussians (merging them into one changes the shape: up to 20 codes at x0.01).
function splitKernel(settings, docLongSide, b) {
  const scale = 1 << b;
  const extra = baseResampleVariance(b);
  const full = S.kernelGaussians(settings, docLongSide, 1);
  const base = [];
  const fine = [];
  for (const list of full) {
    const bl = [];
    const fl = [];
    for (const g of list) {
      if (b > 0 && g.sigma < FINE_SIGMA_BASE * scale) fl.push({ weight: g.weight, sigma: g.sigma });
      else {
        const v = g.sigma * g.sigma - extra;
        bl.push({ sigma: v > 0 ? Math.sqrt(v) / scale : 0, weight: g.weight, wide: g.wide });
      }
    }
    base.push(bl);
    fine.push(fl);
  }
  return { base, fine };
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
  const A3 = phys.a;
  const INV3 = phys.inv;
  const haloView = opts.view === 'halo';
  const identity = phys.A === 0 && !haloView;
  const ex = phys.excess;
  const WT = phys.wTab; // source weights by brightest-channel code, or null (threshold off)

  const b = opts.baseLevel != null ? opts.baseLevel | 0 : autoBaseLevel(w, h);
  const scale = 1 << b;
  const bw = Math.ceil(w / scale);
  const bh = Math.ceil(h / scale);
  const kern = identity ? { base: [[], [], []], fine: [[], [], []] } : splitKernel(settings, docLongSide, b);
  const FINE_DELTA = 0.2; // below this sigma (full-res px) a fine Gaussian is a delta
  // Per channel: delta weight plus a list of {weight, radius, taps} separable Gaussians.
  let fineRadius = 0;
  const FINEC = kern.fine.map((list) => {
    let delta = 0;
    const gs = [];
    for (const g of list) {
      if (g.sigma < FINE_DELTA) delta += g.weight;
      else {
        const r = Math.max(1, Math.ceil(3 * g.sigma));
        if (r > fineRadius) fineRadius = r;
        gs.push({ weight: g.weight, radius: r, taps: B.gaussWeights(g.sigma, r) });
      }
    }
    return { delta, gs, total: list.reduce((t, g) => t + g.weight, 0) };
  });
  const FINE = FINEC.some((f) => f.total > 0);

  let base = identity ? null : new Float32Array(bw * bh * 3);
  let wbase = identity || !WT ? null : new Float32Array(bw * bh * 3);
  let field = null;  // H on the base grid
  let wfield = null; // blurred source-weight map on the base grid (threshold only)

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

  // Linear value -> 8-bit code with dither, by binary search (halo-only view).
  function encodeLinear(v, noise) {
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
      if (WT) {
        for (let x = 0; x < w; x++) {
          const r = data[p];
          const g = data[p + 1];
          const bl = data[p + 2];
          let k = WT[r > g ? (r > bl ? r : bl) : g > bl ? g : bl];
          if (comps === 4) k *= ALPHA[data[p + 3]];
          const bi = brow + (x >> b) * 3;
          base[bi] += lut[r] * k;
          base[bi + 1] += lut[g] * k;
          base[bi + 2] += lut[bl] * k;
          wbase[bi] += k;
          wbase[bi + 1] += k;
          wbase[bi + 2] += k;
          p += comps;
        }
      } else if (comps === 4) {
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

  function normalizeBlocks(plane) {
    if (b === 0) return;
    for (let by = 0; by < bh; by++) {
      const cy = Math.min(scale, h - by * scale);
      for (let bx = 0; bx < bw; bx++) {
        const cx = Math.min(scale, w - bx * scale);
        const k = 1 / (cx * cy);
        const i = (by * bw + bx) * 3;
        plane[i] *= k;
        plane[i + 1] *= k;
        plane[i + 2] *= k;
      }
    }
  }

  function* blurSteps() {
    if (identity) {
      yield 1;
      return;
    }
    const t0 = Date.now();
    normalizeBlocks(base);
    if (wbase) normalizeBlocks(wbase);
    const parts = wbase ? 2 : 1;
    let gen = H.haloForChannels(base, bw, bh, kern.base);
    let r = gen.next();
    while (!r.done) {
      yield r.value / parts;
      r = gen.next();
    }
    field = r.value;
    base = null;
    if (wbase) {
      // The weight map uses the red channel's kernel (all channels share it unless radii differ).
      const wk = [kern.base[0], kern.base[0], kern.base[0]];
      gen = H.haloForChannels(wbase, bw, bh, wk);
      r = gen.next();
      while (!r.done) {
        yield 0.5 + r.value / 2;
        r = gen.next();
      }
      wfield = r.value;
      wbase = null;
    }
    timings.blur = Date.now() - t0;
  }

  // Full-resolution fine part for output rows [y0, y0+rows): Float32Array rows*w*NC holding, per
  // channel, sum_i weight_i * (G_i * S) + delta * S (the weight map, channel 3, uses channel 0's
  // Gaussians). Context rows come from data, clamped to the image.
  function fineRows(data, comps, dY0, dRows, y0, rows) {
    const NC = WT ? 4 : 3;
    const R2 = fineRadius;
    const nCtx = rows + 2 * R2;
    const lo = Math.max(0, dY0);
    const hi = Math.min(h, dY0 + dRows) - 1;
    const src = new Float32Array(nCtx * w * NC);
    for (let j = 0; j < nCtx; j++) {
      let y = y0 - R2 + j;
      y = y < lo ? lo : y > hi ? hi : y;
      let p = (y - dY0) * w * comps;
      let o = j * w * NC;
      for (let x = 0; x < w; x++) {
        const r = data[p];
        const g = data[p + 1];
        const bl = data[p + 2];
        let k = WT ? WT[r > g ? (r > bl ? r : bl) : g > bl ? g : bl] : 1;
        if (comps === 4) k *= ALPHA[data[p + 3]];
        src[o] = lut[r] * k;
        src[o + 1] = lut[g] * k;
        src[o + 2] = lut[bl] * k;
        if (NC === 4) src[o + 3] = k;
        p += comps;
        o += NC;
      }
    }
    const out = new Float32Array(rows * w * NC);
    const hor = new Float32Array(nCtx * w);
    for (let c = 0; c < NC; c++) {
      const spec = FINEC[c === 3 ? 0 : c];
      // delta part
      if (spec.delta > 0) {
        for (let ry = 0; ry < rows; ry++) {
          const s0 = (ry + R2) * w * NC + c;
          const o0 = ry * w * NC + c;
          for (let x = 0; x < w; x++) out[o0 + x * NC] += spec.delta * src[s0 + x * NC];
        }
      }
      for (const g of spec.gs) {
        const taps = g.taps;
        const r = g.radius;
        // horizontal on all context rows (clamped at the image's left/right edges)
        for (let j = 0; j < nCtx; j++) {
          const row = j * w * NC + c;
          const ho = j * w;
          for (let x = 0; x < w; x++) {
            let acc = 0;
            for (let t = -r; t <= r; t++) {
              let xx = x + t;
              xx = xx < 0 ? 0 : xx >= w ? w - 1 : xx;
              acc += taps[t + r] * src[row + xx * NC];
            }
            hor[ho + x] = acc;
          }
        }
        // vertical into the output rows
        const wt = g.weight;
        for (let ry = 0; ry < rows; ry++) {
          const o0 = ry * w * NC + c;
          for (let t = -r; t <= r; t++) {
            const hrow = (ry + R2 + t) * w;
            const k = wt * taps[t + r];
            for (let x = 0; x < w; x++) out[o0 + x * NC] += k * hor[hrow + x];
          }
        }
      }
    }
    return out;
  }

  function pass2(data, comps, y0, rows, out, ctx) {
    if (identity) {
      const dY0i = ctx && ctx.dataY0 != null ? ctx.dataY0 : y0;
      const off = (y0 - dY0i) * w * comps;
      out.set(data.subarray(off, off + rows * w * comps));
      return;
    }
    if (!field) throw new Error('pass2 before blurSteps finished');
    const dY0 = ctx && ctx.dataY0 != null ? ctx.dataY0 : y0;
    const dRows = ctx && ctx.dataRows != null ? ctx.dataRows : rows;
    if (dY0 > y0 || dY0 + dRows < y0 + rows) throw new Error('pass2: data does not cover the strip');
    const t0 = Date.now();
    const bstride = bw * 3;
    const rowBuf = new Float32Array(bstride);
    const rowW = wfield ? new Float32Array(bstride) : null;
    const Hf = field;
    const NC = WT ? 4 : 3;
    const fine = FINE ? fineRows(data, comps, dY0, dRows, y0, rows) : null;
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
      if (rowW) for (let i = 0; i < bstride; i++) rowW[i] = wa * wfield[oa + i] + fy * wfield[ob + i];
      const gy = originY + y;
      const nr = [((gy + NDY[0]) & 63) << 6, ((gy + NDY[1]) & 63) << 6, ((gy + NDY[2]) & 63) << 6];
      let p = (y - dY0) * w * comps;
      let q = ry * w * comps;
      let fo = ry * w * NC;
      for (let x = 0; x < w; x++, p += comps, q += comps, fo += NC) {
        if (comps === 4) {
          const al = data[p + 3];
          out[q + 3] = al;
          if (al === 0) {
            out[q] = haloView ? 0 : data[p];
            out[q + 1] = haloView ? 0 : data[p + 1];
            out[q + 2] = haloView ? 0 : data[p + 2];
            continue;
          }
        }
        const xa = XA[x];
        const xb = XB[x];
        const fx = XF[x];
        const gx = originX + x;
        // blurred source-weight map (1 without a threshold)
        let hw = 1;
        if (rowW) {
          hw = rowW[xa] + fx * (rowW[xb] - rowW[xa]);
          if (fine) hw += fine[fo + 3];
        }
        for (let c = 0; c < 3; c++) {
          const code = data[p + c];
          const L = lut[code];
          let hv = rowBuf[xa + c] + fx * (rowBuf[xb + c] - rowBuf[xa + c]);
          if (fine) hv += fine[fo + c];
          const a = A3[c];
          const e = hv - hw * L;
          let O;
          if (ex) {
            if (e > 0) O = a <= 1 ? L + a * e : L + e * (1 + ((a - 1) * e) / hv);
            else O = L;
          } else O = L + a * e * INV3[c];
          const noise = NOISE[nr[c] + ((gx + NDX[c]) & 63)];
          if (haloView) {
            out[q + c] = encodeLinear(ex ? O - L : a * hv * INV3[c], noise);
            continue;
          }
          const d = O - L;
          const t = TOL[code];
          if (d < t && d > -t) {
            out[q + c] = code;
          } else {
            let k = code;
            if (d > 0) { while (k < 255 && O >= lut[k + 1]) k++; } else { while (k > 0 && O < lut[k]) k--; }
            out[q + c] = k >= 255 ? 255 : ((O - lut[k]) * R[k] + noise >= 1 ? k + 1 : k);
          }
        }
      }
    }
    timings.pass2 += Date.now() - t0;
  }

  return {
    stripRows,
    fineRadius,
    pass1,
    blurSteps,
    pass2,
    get field() {
      return field;
    },
    get weightField() {
      return wfield;
    },
    get stats() {
      const plan = identity ? [] : H.planGaussians(kern.base[0], bw, bh);
      return {
        baseLevel: b,
        baseWidth: bw,
        baseHeight: bh,
        bytesBase: bw * bh * 3 * 4 * (WT ? 2 : 1),
        gaussians: plan,
        fine: FINEC.map((f) => ({ delta: f.delta, gaussians: f.gs.map((g) => ({ weight: g.weight, radius: g.radius })) })),
        fineRadius,
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
    view: o.view,
  });
  const rows = Math.max(1, o.stripRows || proc.stripRows);
  const rowBytes = width * components;
  for (let y = 0; y < height; y += rows) {
    const n = Math.min(rows, height - y);
    proc.pass1(data.subarray(y * rowBytes, (y + n) * rowBytes), components, y, n);
  }
  H.runToEnd(proc.blurSteps());
  const out = new Uint8Array(data.length);
  const R2 = proc.fineRadius;
  for (let y = 0; y < height; y += rows) {
    const n = Math.min(rows, height - y);
    const dY0 = Math.max(0, y - R2);
    const dEnd = Math.min(height, y + n + R2);
    proc.pass2(data.subarray(dY0 * rowBytes, dEnd * rowBytes), components, y, n, out.subarray(y * rowBytes, (y + n) * rowBytes), { dataY0: dY0, dataRows: dEnd - dY0 });
  }
  return out;
}

module.exports = { createProcessor, processImage, autoBaseLevel, splitKernel };
