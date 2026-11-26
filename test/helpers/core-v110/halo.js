'use strict';
// H = K ⊛ S on a pyramid (design 5.6 steps 2–3). A generator: yields progress 0..1 after
// every filter pass so the caller can await, report progress and honour cancellation.
// Returns H on the base grid (interleaved RGB Float32Array, same size as src).

const B = require('./blur');
const P = require('./pyramid');

const SIGMA_MIN_LEVEL = 1.25; // choose the coarsest level where the compensated sigma >= 1.25 px
const SIGMA_BOX = 2;         // box passes only from 2 px up (narrowest Gaussian only)
const SIGMA_DELTA = 0.3;     // below this a Gaussian is a delta

// Sigma to use at pyramid level k (relative to the base grid) so that the blur plus the
// variance added by k down/up round trips equals the requested variance.
function levelSigma(sigma, k) {
  const extra = (P.ROUND_TRIP_VARIANCE * (Math.pow(4, k) - 1)) / 3;
  const v = sigma * sigma - extra;
  return v > 0 ? Math.sqrt(v) / Math.pow(2, k) : 0;
}

function planGaussians(gaussians, bw, bh) {
  return gaussians.map((g) => {
    if (g.sigma < SIGMA_DELTA) return { weight: g.weight, level: 0, s: g.sigma, kind: 'delta' };
    let k = 0;
    let w = bw;
    let h = bh;
    while (levelSigma(g.sigma, k + 1) >= SIGMA_MIN_LEVEL && ((w + 1) >> 1) >= 2 && ((h + 1) >> 1) >= 2) {
      k++;
      w = (w + 1) >> 1;
      h = (h + 1) >> 1;
    }
    const s = k === 0 ? g.sigma : levelSigma(g.sigma, k);
    let kind;
    if (s < SIGMA_BOX) kind = g.wide ? 'fir35' : 'fir3';
    else kind = g.wide ? 'fir35' : 'box';
    return { weight: g.weight, level: k, s, kind };
  });
}

function passCount(plan, levels) {
  let n = 0;
  for (const g of plan) n += g.kind === 'delta' ? 1 : 2;
  return n + levels;
}

function* haloGenerator(src, bw, bh, gaussians) {
  const plan = planGaussians(gaussians, bw, bh);
  let maxLevel = 0;
  for (const g of plan) if (g.level > maxLevel) maxLevel = g.level;

  const levels = [{ data: src, w: bw, h: bh }];
  for (let k = 1; k <= maxLevel; k++) levels.push(P.downsample2(levels[k - 1].data, levels[k - 1].w, levels[k - 1].h));
  const acc = levels.map((L) => new Float32Array(L.w * L.h * 3));

  let maxN = 0;
  let maxW = 0;
  for (const g of plan) {
    if (g.kind === 'delta') continue;
    const L = levels[g.level];
    if (L.w * L.h > maxN) maxN = L.w * L.h;
    if (L.w > maxW) maxW = L.w;
  }
  const work = maxN ? new Float32Array(maxN * 3) : null;
  const tmp = maxN ? new Float32Array(maxN * 3) : null;
  const rowAcc = maxW ? new Float64Array(maxW * 3) : null;

  const total = passCount(plan, maxLevel);
  let done = 0;
  const order = plan.slice().sort((a, b) => b.level - a.level);

  for (const g of order) {
    const L = levels[g.level];
    const n = L.w * L.h * 3;
    const target = acc[g.level];
    const wgt = g.weight;
    if (g.kind === 'delta') {
      for (let i = 0; i < n; i++) target[i] += wgt * L.data[i];
      done++;
      yield done / total;
      continue;
    }
    if (g.kind === 'box') {
      const bp = B.boxParams(g.s, 3);
      const pad = new Float32Array((L.w + 2 * bp.r + 2) * 3);
      B.boxH3(L.data, work, L.w, L.h, bp, pad);
      B.boxH3(work, work, L.w, L.h, bp, pad);
      B.boxH3(work, work, L.w, L.h, bp, pad);
      done++;
      yield done / total;
      B.boxV3(work, tmp, L.w, L.h, bp, rowAcc);
      B.boxV3(tmp, work, L.w, L.h, bp, rowAcc);
      B.boxV3(work, tmp, L.w, L.h, bp, rowAcc);
    } else {
      const radius = Math.max(1, Math.ceil((g.kind === 'fir35' ? 3.5 : 3) * g.s));
      const wts = B.gaussWeights(g.s, radius);
      const pad = new Float32Array((L.w + 2 * radius) * 3);
      B.firH3(L.data, work, L.w, L.h, wts, radius, pad);
      done++;
      yield done / total;
      B.firV3(work, tmp, L.w, L.h, wts, radius, rowAcc);
    }
    for (let i = 0; i < n; i++) target[i] += wgt * tmp[i];
    done++;
    yield done / total;
  }

  for (let k = maxLevel; k >= 1; k--) {
    P.upsample2Add(acc[k], levels[k].w, levels[k].h, acc[k - 1], levels[k - 1].w, levels[k - 1].h);
    acc[k] = null;
    levels[k] = null;
    done++;
    yield done / total;
  }
  return acc[0];
}

// Runs the generator for each distinct per-channel radius and merges channels.
function* haloForChannels(src, bw, bh, gaussiansPerChannel) {
  const keys = gaussiansPerChannel.map((list) => list.map((g) => g.sigma.toFixed(6)).join(','));
  const distinct = Array.from(new Set(keys));
  if (distinct.length === 1) {
    return yield* haloGenerator(src, bw, bh, gaussiansPerChannel[0]);
  }
  const H = new Float32Array(bw * bh * 3);
  for (let d = 0; d < distinct.length; d++) {
    const c0 = keys.indexOf(distinct[d]);
    const gen = haloGenerator(src, bw, bh, gaussiansPerChannel[c0]);
    let r = gen.next();
    while (!r.done) {
      yield (d + r.value) / distinct.length;
      r = gen.next();
    }
    const part = r.value;
    for (let c = 0; c < 3; c++) {
      if (keys[c] !== distinct[d]) continue;
      for (let i = c; i < H.length; i += 3) H[i] = part[i];
    }
  }
  return H;
}

function runToEnd(gen) {
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}

module.exports = { planGaussians, levelSigma, haloGenerator, haloForChannels, runToEnd };
