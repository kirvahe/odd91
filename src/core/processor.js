'use strict';
// Full-resolution two-pass strip processor (design 5.5–5.6, appendices C–H) and processImage.
//
// Kernel split: Gaussians at least one base-grid pixel wide run on the pyramid (pass 1 averages
// the source into the base grid, blurSteps() blurs it); narrower ones ("fine") would collapse into
// the resampling kernel, so pass 2 computes them at full resolution from the strip itself, which
// needs `fineRadius` rows of context above and below each strip. v1.1.1: that part runs in one
// interleaved pass with paired taps and padded edges, and with a threshold it skips tiles whose
// sources are all zero (exact); pass 2 has its three channels unrolled.

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
// Zero-skip tile width in columns (threshold only), as a power of two.
const FINE_TILE_SHIFT = 4;
const FINE_TILE = 1 << FINE_TILE_SHIFT;

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
  // One kernel for every channel (radii equal): the fine part runs as one interleaved pass.
  const FINE_SHARED = FINE && FINEC.every((f) => f.delta === FINEC[0].delta && f.gs.length === FINEC[0].gs.length &&
    f.gs.every((g, i) => g.radius === FINEC[0].gs[i].radius && g.weight === FINEC[0].gs[i].weight &&
      g.taps.every((v, k) => v === FINEC[0].gs[i].taps[k])));
  // With a threshold most sources are exactly zero; `_noSkip` (tests only) turns the skip off.
  const SKIP = FINE_SHARED && !!WT && !opts._noSkip;

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

  // Largest code k with lut[k] <= v (0 below lut[0]): the code a step-by-step search from the
  // source code ends on. Pass 2 calls it only for jumps of two codes or more; in the scene-linear
  // mode the dark codes are dense and a strong halo moves them by tens of codes (v1.1.1: the
  // step-by-step loop, then a binary search, cost about 1 s per 26 Mpx). A table over sqrt(v)
  // gives a start at most a code or two away; the two loops then land on the exact code.
  const INV_N = 4096;
  const INV = new Uint8Array(INV_N + 1);
  for (let i = 0, k = 0; i <= INV_N; i++) {
    const v = (i / INV_N) * (i / INV_N);
    while (k < 255 && v >= lut[k + 1]) k++;
    INV[i] = k;
  }
  function codeAt(v) {
    let k = v > 0 ? INV[v >= 1 ? INV_N : (Math.sqrt(v) * INV_N) | 0] : 0;
    // The start is the left edge of the bin, so this loop runs only when sqrt rounded up onto it.
    while (k > 0 && v < lut[k]) k--;
    if (k < 255 && v >= lut[k + 1]) {
      if (k < 254 && v >= lut[k + 2]) {
        // A curve with a nearly flat stretch: the table cannot tell those codes apart, so a
        // binary search finds the largest code with lut[code] <= v (review v1.1.1 М7).
        let lo = k + 2;
        let hi = 256;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (lut[mid] > v) hi = mid;
          else lo = mid + 1;
        }
        k = lo - 1;
      } else k++;
    }
    return k;
  }

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

  const timings = { pass1: 0, blur: 0, pass2: 0, fine: 0 };
  // v1.1.2: 16-column tiles of the fine vertical pass under a threshold (zero-skip): how many
  // there were and how many had to be computed. Tells how much of the frame carries a fine halo.
  const fineTiles = { total: 0, computed: 0 };
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
    // v1.1.2 (plan review С2): only the time inside the steps counts. What the caller does
    // between two steps (progress window, yields) used to be added to this timer.
    // It is added step by step, so a cancelled or failed blur still reports its time (code review С1).
    timings.blur = 0;
    let t0 = Date.now();
    normalizeBlocks(base);
    if (wbase) normalizeBlocks(wbase);
    const parts = wbase ? 2 : 1;
    let gen = H.haloForChannels(base, bw, bh, kern.base);
    let r = gen.next();
    timings.blur += Date.now() - t0;
    while (!r.done) {
      yield r.value / parts;
      t0 = Date.now();
      r = gen.next();
      timings.blur += Date.now() - t0;
    }
    field = r.value;
    base = null;
    if (wbase) {
      // The weight map uses the red channel's kernel (all channels share it unless radii differ).
      const wk = [kern.base[0], kern.base[0], kern.base[0]];
      t0 = Date.now();
      gen = H.haloForChannels(wbase, bw, bh, wk);
      r = gen.next();
      timings.blur += Date.now() - t0;
      while (!r.done) {
        yield 0.5 + r.value / 2;
        t0 = Date.now();
        r = gen.next();
        timings.blur += Date.now() - t0;
      }
      wfield = r.value;
      wbase = null;
    }
  }

  // ---- Full-resolution fine part (v1.1.1: perf plan review 2026-11-26).
  // Output for rows [y0, y0+rows): per channel sum_i weight_i * (G_i * S) + delta * S, where S is
  // linear light times the source weight (channel 3 holds the weight itself with a threshold and
  // uses channel 0's Gaussians). Context rows come from data, clamped to the image; columns are
  // padded with the edge values, so the inner loops have no bounds checks. Symmetric taps are
  // summed in pairs. Buffers live in the closure and are reused by every strip: the returned
  // array is valid until the next call.
  let fSrc = null;
  let fHor = null;
  let fOut = null;
  let fAcc = null;
  let fSrcT = null;
  let fHorT = null;
  let fCnt = null;
  let fRowNZ = null;
  function reuse(cur, n, Ctor) {
    return cur && cur.length >= n ? cur : new Ctor(n);
  }

  // One row segment [x0, x1) of the horizontal pass, interleaved NC values per pixel.
  function horSegment(src, hor, srow, hrow, x0, x1, NC, taps, r) {
    const w0 = taps[r];
    let pc = srow + x0 * NC;
    let o = hrow + x0 * NC;
    if (NC === 3) {
      for (let x = x0; x < x1; x++, pc += 3, o += 3) {
        let a0 = w0 * src[pc];
        let a1 = w0 * src[pc + 1];
        let a2 = w0 * src[pc + 2];
        let l = pc - 3;
        let q = pc + 3;
        for (let k = 1; k <= r; k++, l -= 3, q += 3) {
          const wk = taps[r + k];
          a0 += wk * (src[l] + src[q]);
          a1 += wk * (src[l + 1] + src[q + 1]);
          a2 += wk * (src[l + 2] + src[q + 2]);
        }
        hor[o] = a0;
        hor[o + 1] = a1;
        hor[o + 2] = a2;
      }
    } else {
      for (let x = x0; x < x1; x++, pc += 4, o += 4) {
        let a0 = w0 * src[pc];
        let a1 = w0 * src[pc + 1];
        let a2 = w0 * src[pc + 2];
        let a3 = w0 * src[pc + 3];
        let l = pc - 4;
        let q = pc + 4;
        for (let k = 1; k <= r; k++, l -= 4, q += 4) {
          const wk = taps[r + k];
          a0 += wk * (src[l] + src[q]);
          a1 += wk * (src[l + 1] + src[q + 1]);
          a2 += wk * (src[l + 2] + src[q + 2]);
          a3 += wk * (src[l + 3] + src[q + 3]);
        }
        hor[o] = a0;
        hor[o + 1] = a1;
        hor[o + 2] = a2;
        hor[o + 3] = a3;
      }
    }
  }

  // One output row segment [i0, i1) (array indices, NC values per pixel) of the vertical pass.
  // The sum stays in a register per value (a Float64 accumulator array cost 40 % more).
  function vertSegment(hor, out, hc, o0, i0, i1, st, taps, r, wt) {
    const w0 = taps[r];
    for (let i = i0; i < i1; i++) {
      let a = w0 * hor[hc + i];
      let up = hc + i - st;
      let dn = hc + i + st;
      for (let t = 1; t <= r; t++, up -= st, dn += st) a += taps[r + t] * (hor[up] + hor[dn]);
      out[o0 + i] += wt * a;
    }
  }

  // All channels share one kernel (radii equal): one interleaved pass. With a threshold, tiles
  // of FINE_TILE columns whose neighbourhood holds only zero sources are skipped: their result is
  // exactly zero either way, so skipping changes no bit (test 'zero-skip ... is exact').
  function fineShared(data, comps, dY0, dRows, y0, rows) {
    const NC = WT ? 4 : 3;
    const R2 = fineRadius;
    const nCtx = rows + 2 * R2;
    const ps = (w + 2 * R2) * NC;
    const st = w * NC;
    const lo = Math.max(0, dY0);
    const hi = Math.min(h, dY0 + dRows) - 1;
    fSrc = reuse(fSrc, nCtx * ps, Float32Array);
    fHor = reuse(fHor, nCtx * st, Float32Array);
    fOut = reuse(fOut, rows * st, Float32Array);
    const src = fSrc;
    const hor = fHor;
    const out = fOut;
    out.fill(0, 0, rows * st);
    const nT = Math.ceil(w / FINE_TILE);
    let srcT = null;
    let horT = null;
    let cnt = null;
    let rowNZ = null;
    if (SKIP) {
      fSrcT = reuse(fSrcT, nCtx * nT, Uint8Array);
      fHorT = reuse(fHorT, nCtx * nT, Uint8Array);
      fCnt = reuse(fCnt, (nCtx + 1) * nT, Int32Array);
      fRowNZ = reuse(fRowNZ, nCtx, Uint8Array);
      srcT = fSrcT;
      horT = fHorT;
      cnt = fCnt;
      rowNZ = fRowNZ;
      srcT.fill(0, 0, nCtx * nT);
      rowNZ.fill(0, 0, nCtx);
    }
    for (let j = 0; j < nCtx; j++) {
      let y = y0 - R2 + j;
      y = y < lo ? lo : y > hi ? hi : y;
      let p = (y - dY0) * w * comps;
      const row = j * ps;
      let o = row + R2 * NC;
      if (NC === 3 && comps === 3) {
        for (let x = 0; x < w; x++, p += 3, o += 3) {
          src[o] = lut[data[p]];
          src[o + 1] = lut[data[p + 1]];
          src[o + 2] = lut[data[p + 2]];
        }
      } else {
        const tb = j * nT;
        let any = 0;
        for (let x = 0; x < w; x++, p += comps, o += NC) {
          const r = data[p];
          const g = data[p + 1];
          const bl = data[p + 2];
          let k = WT ? WT[r > g ? (r > bl ? r : bl) : g > bl ? g : bl] : 1;
          if (comps === 4) k *= ALPHA[data[p + 3]];
          src[o] = lut[r] * k;
          src[o + 1] = lut[g] * k;
          src[o + 2] = lut[bl] * k;
          if (NC === 4) {
            src[o + 3] = k;
            if (SKIP && k !== 0) {
              srcT[tb + (x >> FINE_TILE_SHIFT)] = 1;
              any = 1;
            }
          }
        }
        if (SKIP) rowNZ[j] = any;
      }
      const first = row + R2 * NC;
      const last = first + (w - 1) * NC;
      for (let i = 0; i < R2; i++) {
        for (let c = 0; c < NC; c++) {
          src[row + i * NC + c] = src[first + c];
          src[last + (i + 1) * NC + c] = src[last + c];
        }
      }
    }
    const spec = FINEC[0];
    if (spec.delta > 0) {
      const dl = spec.delta;
      for (let ry = 0; ry < rows; ry++) {
        const s0 = (ry + R2) * ps + R2 * NC;
        const o0 = ry * st;
        for (let i = 0; i < st; i++) out[o0 + i] += dl * src[s0 + i];
      }
    }
    for (const g of spec.gs) {
      const taps = g.taps;
      const r = g.radius;
      const wt = g.weight;
      const j0 = R2 - r; // rows outside [j0, j1) are never read by this Gaussian
      const j1 = nCtx - (R2 - r);
      const dt = Math.ceil(r / FINE_TILE);
      for (let j = j0; j < j1; j++) {
        const srow = j * ps + R2 * NC;
        const hrow = j * st;
        if (!SKIP) {
          horSegment(src, hor, srow, hrow, 0, w, NC, taps, r);
          continue;
        }
        const tb = j * nT;
        if (!rowNZ[j]) {
          hor.fill(0, hrow, hrow + st);
          horT.fill(0, tb, tb + nT);
          continue;
        }
        for (let t = 0; t < nT; t++) {
          const ua = t - dt < 0 ? 0 : t - dt;
          const ub = t + dt >= nT ? nT - 1 : t + dt;
          let any = 0;
          for (let u = ua; u <= ub; u++) {
            if (srcT[tb + u]) {
              any = 1;
              break;
            }
          }
          horT[tb + t] = any;
          const x0 = t << FINE_TILE_SHIFT;
          const x1 = x0 + FINE_TILE < w ? x0 + FINE_TILE : w;
          if (any) horSegment(src, hor, srow, hrow, x0, x1, NC, taps, r);
          else hor.fill(0, hrow + x0 * NC, hrow + x1 * NC);
        }
      }
      if (SKIP) {
        // cnt[j*nT + t] = number of non-zero horizontal tiles t in rows j0 .. j-1
        for (let t = 0; t < nT; t++) cnt[j0 * nT + t] = 0;
        for (let j = j0; j < j1; j++) {
          const a = j * nT;
          const b2 = a + nT;
          for (let t = 0; t < nT; t++) cnt[b2 + t] = cnt[a + t] + horT[a + t];
        }
      }
      for (let ry = 0; ry < rows; ry++) {
        const hc = (ry + R2) * st;
        const o0 = ry * st;
        if (!SKIP) {
          vertSegment(hor, out, hc, o0, 0, st, st, taps, r, wt);
          continue;
        }
        const ca = (ry + R2 - r) * nT;
        const cb = (ry + R2 + r + 1) * nT;
        fineTiles.total += nT;
        for (let t = 0; t < nT; t++) {
          if (cnt[cb + t] === cnt[ca + t]) continue;
          fineTiles.computed++;
          const x0 = t << FINE_TILE_SHIFT;
          const x1 = x0 + FINE_TILE < w ? x0 + FINE_TILE : w;
          vertSegment(hor, out, hc, o0, x0 * NC, x1 * NC, st, taps, r, wt);
        }
      }
    }
    return out;
  }

  // Channels with different kernels (radii differ): planar layout, one plane per channel,
  // same padding and paired taps, no zero-skip.
  function finePlanar(data, comps, dY0, dRows, y0, rows) {
    const NC = WT ? 4 : 3;
    const R2 = fineRadius;
    const nCtx = rows + 2 * R2;
    const pw = w + 2 * R2;
    const lo = Math.max(0, dY0);
    const hi = Math.min(h, dY0 + dRows) - 1;
    const plane = nCtx * pw;
    const oplane = rows * w;
    fSrc = reuse(fSrc, plane * NC, Float32Array);
    fOut = reuse(fOut, oplane * NC, Float32Array);
    fHor = reuse(fHor, nCtx * w, Float32Array);
    fAcc = reuse(fAcc, w, Float64Array);
    const src = fSrc;
    const out = fOut;
    const hor = fHor;
    const acc = fAcc;
    out.fill(0, 0, oplane * NC);
    const p1 = plane;
    const p2 = 2 * plane;
    const p3 = 3 * plane;
    for (let j = 0; j < nCtx; j++) {
      let y = y0 - R2 + j;
      y = y < lo ? lo : y > hi ? hi : y;
      let p = (y - dY0) * w * comps;
      let o = j * pw + R2;
      for (let x = 0; x < w; x++, p += comps, o++) {
        const r = data[p];
        const g = data[p + 1];
        const bl = data[p + 2];
        let k = WT ? WT[r > g ? (r > bl ? r : bl) : g > bl ? g : bl] : 1;
        if (comps === 4) k *= ALPHA[data[p + 3]];
        src[o] = lut[r] * k;
        src[o + p1] = lut[g] * k;
        src[o + p2] = lut[bl] * k;
        if (NC === 4) src[o + p3] = k;
      }
      for (let c = 0; c < NC; c++) {
        const b0 = c * plane + j * pw;
        const L = src[b0 + R2];
        const Rr = src[b0 + R2 + w - 1];
        for (let i = 0; i < R2; i++) {
          src[b0 + i] = L;
          src[b0 + R2 + w + i] = Rr;
        }
      }
    }
    for (let c = 0; c < NC; c++) {
      const spec = FINEC[c === 3 ? 0 : c];
      const cs = c * plane;
      const co = c * oplane;
      if (spec.delta > 0) {
        const dl = spec.delta;
        for (let ry = 0; ry < rows; ry++) {
          const s0 = cs + (ry + R2) * pw + R2;
          const o0 = co + ry * w;
          for (let x = 0; x < w; x++) out[o0 + x] += dl * src[s0 + x];
        }
      }
      for (const g of spec.gs) {
        const taps = g.taps;
        const r = g.radius;
        const wt = g.weight;
        const w0 = taps[r];
        for (let j = R2 - r; j < nCtx - (R2 - r); j++) {
          const b0 = cs + j * pw + R2;
          for (let x = 0; x < w; x++) acc[x] = w0 * src[b0 + x];
          for (let t = 1; t <= r; t++) {
            const k = taps[r + t];
            const a = b0 - t;
            const b2 = b0 + t;
            for (let x = 0; x < w; x++) acc[x] += k * (src[a + x] + src[b2 + x]);
          }
          const ho = j * w;
          for (let x = 0; x < w; x++) hor[ho + x] = acc[x];
        }
        for (let ry = 0; ry < rows; ry++) {
          const o0 = co + ry * w;
          const hc = (ry + R2) * w;
          for (let x = 0; x < w; x++) acc[x] = w0 * hor[hc + x];
          for (let t = 1; t <= r; t++) {
            const k = taps[r + t];
            const a = hc - t * w;
            const b2 = hc + t * w;
            for (let x = 0; x < w; x++) acc[x] += k * (hor[a + x] + hor[b2 + x]);
          }
          for (let x = 0; x < w; x++) out[o0 + x] += wt * acc[x];
        }
      }
    }
    return out;
  }

  // Pass 2: the halo field upsampled from the base grid plus the fine part, combined with the
  // source (combine() in settings.js is the reference) and encoded back to 8 bit with dither.
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
    let fine = null;
    if (FINE) {
      const tf = Date.now();
      fine = FINE_SHARED ? fineShared(data, comps, dY0, dRows, y0, rows) : finePlanar(data, comps, dY0, dRows, y0, rows);
      timings.fine += Date.now() - tf;
    }
    // Index of channel c of pixel i in `fine`: i*fS + c*fC (interleaved or planar).
    const fS = FINE_SHARED ? NC : 1;
    const fC = FINE_SHARED ? 1 : rows * w;
    const a0 = A3[0];
    const a1 = A3[1];
    const a2 = A3[2];
    const inv0 = INV3[0];
    const inv1 = INV3[1];
    const inv2 = INV3[2];
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
      const nr0 = ((gy + NDY[0]) & 63) << 6;
      const nr1 = ((gy + NDY[1]) & 63) << 6;
      const nr2 = ((gy + NDY[2]) & 63) << 6;
      let p = (y - dY0) * w * comps;
      let q = ry * w * comps;
      let fo = ry * w;
      if (haloView) {
        const nr = [nr0, nr1, nr2];
        for (let x = 0; x < w; x++, p += comps, q += comps, fo++) {
          if (comps === 4) {
            const al = data[p + 3];
            out[q + 3] = al;
            if (al === 0) {
              out[q] = 0;
              out[q + 1] = 0;
              out[q + 2] = 0;
              continue;
            }
          }
          const xa = XA[x];
          const xb = XB[x];
          const fx = XF[x];
          const gx = originX + x;
          let hw = 1;
          if (rowW) {
            hw = rowW[xa] + fx * (rowW[xb] - rowW[xa]);
            if (fine) hw += fine[fo * fS + 3 * fC];
          }
          for (let c = 0; c < 3; c++) {
            const L = lut[data[p + c]];
            let hv = rowBuf[xa + c] + fx * (rowBuf[xb + c] - rowBuf[xa + c]);
            if (fine) hv += fine[fo * fS + c * fC];
            const a = A3[c];
            const e = hv - hw * L;
            let O;
            if (ex) {
              if (e > 0) O = a <= 1 ? L + a * e : L + e * (1 + ((a - 1) * e) / hv);
              else O = L;
            } else O = L + a * e * INV3[c];
            out[q + c] = encodeLinear(ex ? O - L : a * hv * INV3[c], NOISE[nr[c] + ((gx + NDX[c]) & 63)]);
          }
        }
        continue;
      }
      // Normal view, three channels unrolled (perf review С4: the generic channel loop cost
      // 37-65 % of pass 2 with a JIT). Same formulas and order as combine() in settings.js.
      let code, L, hv, e, O, d, t, k;
      for (let x = 0; x < w; x++, p += comps, q += comps, fo++) {
        if (comps === 4) {
          const al = data[p + 3];
          out[q + 3] = al;
          if (al === 0) {
            out[q] = data[p];
            out[q + 1] = data[p + 1];
            out[q + 2] = data[p + 2];
            continue;
          }
        }
        const xa = XA[x];
        const xb = XB[x];
        const fx = XF[x];
        const gx = originX + x;
        const fi = fo * fS;
        let hw = 1;
        if (rowW) {
          hw = rowW[xa] + fx * (rowW[xb] - rowW[xa]);
          if (fine) hw += fine[fi + 3 * fC];
        }
        // red
        code = data[p];
        L = lut[code];
        hv = rowBuf[xa] + fx * (rowBuf[xb] - rowBuf[xa]);
        if (fine) hv += fine[fi];
        e = hv - hw * L;
        if (ex) O = e > 0 ? (a0 <= 1 ? L + a0 * e : L + e * (1 + ((a0 - 1) * e) / hv)) : L;
        else O = L + a0 * e * inv0;
        d = O - L;
        t = TOL[code];
        if (d < t && d > -t) out[q] = code;
        else {
          k = code;
          if (d > 0) { if (k < 255 && O >= lut[k + 1]) k = k < 254 && O >= lut[k + 2] ? codeAt(O) : k + 1; } else if (k > 0 && O < lut[k]) k = k > 1 && O < lut[k - 1] ? codeAt(O) : k - 1;
          out[q] = k >= 255 ? 255 : ((O - lut[k]) * R[k] + NOISE[nr0 + ((gx + NDX[0]) & 63)] >= 1 ? k + 1 : k);
        }
        // green
        code = data[p + 1];
        L = lut[code];
        hv = rowBuf[xa + 1] + fx * (rowBuf[xb + 1] - rowBuf[xa + 1]);
        if (fine) hv += fine[fi + fC];
        e = hv - hw * L;
        if (ex) O = e > 0 ? (a1 <= 1 ? L + a1 * e : L + e * (1 + ((a1 - 1) * e) / hv)) : L;
        else O = L + a1 * e * inv1;
        d = O - L;
        t = TOL[code];
        if (d < t && d > -t) out[q + 1] = code;
        else {
          k = code;
          if (d > 0) { if (k < 255 && O >= lut[k + 1]) k = k < 254 && O >= lut[k + 2] ? codeAt(O) : k + 1; } else if (k > 0 && O < lut[k]) k = k > 1 && O < lut[k - 1] ? codeAt(O) : k - 1;
          out[q + 1] = k >= 255 ? 255 : ((O - lut[k]) * R[k] + NOISE[nr1 + ((gx + NDX[1]) & 63)] >= 1 ? k + 1 : k);
        }
        // blue
        code = data[p + 2];
        L = lut[code];
        hv = rowBuf[xa + 2] + fx * (rowBuf[xb + 2] - rowBuf[xa + 2]);
        if (fine) hv += fine[fi + 2 * fC];
        e = hv - hw * L;
        if (ex) O = e > 0 ? (a2 <= 1 ? L + a2 * e : L + e * (1 + ((a2 - 1) * e) / hv)) : L;
        else O = L + a2 * e * inv2;
        d = O - L;
        t = TOL[code];
        if (d < t && d > -t) out[q + 2] = code;
        else {
          k = code;
          if (d > 0) { if (k < 255 && O >= lut[k + 1]) k = k < 254 && O >= lut[k + 2] ? codeAt(O) : k + 1; } else if (k > 0 && O < lut[k]) k = k > 1 && O < lut[k - 1] ? codeAt(O) : k - 1;
          out[q + 2] = k >= 255 ? 255 : ((O - lut[k]) * R[k] + NOISE[nr2 + ((gx + NDX[2]) & 63)] >= 1 ? k + 1 : k);
        }
      }
    }
    timings.pass2 += Date.now() - t0;
  }

  // Rough stage costs (ms with a JIT, Photoshop I/O included) for progress weights only.
  // Calibrated on Ilya's report (26 Mpx, Windows, PS 24.7) and Node measurements.
  function costEstimate() {
    const mpx = (w * h) / 1e6;
    const parts = WT ? 2 : 1;
    let fineUnits = 0; // mean over the three channels (radii may differ, review v1.1.1 М4)
    if (FINE) for (let c = 0; c < 3; c++) for (const g of FINEC[c].gs) fineUnits += (2 * (g.radius + 1)) / 3;
    const nc = WT ? 4 : 3;
    return {
      read: 20 * mpx,
      blur: 150 * ((bw * bh) / 1e6) * parts,
      write: mpx * (70 + 1.5 * fineUnits * nc * (SKIP ? 0.5 : 1)),
    };
  }

  return {
    stripRows,
    fineRadius,
    pass1,
    blurSteps,
    pass2,
    costEstimate,
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
        fineTiles: SKIP ? Object.assign({}, fineTiles) : null,
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
    _noSkip: o._noSkip,
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
