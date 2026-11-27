'use strict';
// 2x pyramid on interleaved RGB Float32 planes. Pixel i of level k is centred at
// (i + 0.5) * 2^k - 0.5 in level-0 pixels. Edges replicate the last pixel.
//
// Downsampling uses the [1,3,3,1]/8 filter, the adjoint of the bilinear 2x upsampling below.
// Unlike a 2x2 box it preserves the centre of mass of a point source exactly, so the halo of a
// one-pixel lamp is not shifted by up to half a coarse block. Each down+up round trip at level j
// adds a variance of 1.5 * 4^j (level-0 px^2, per axis), which halo.js compensates.

const ROUND_TRIP_VARIANCE = 1.5;

function downsample2(src, w, h) {
  const w2 = (w + 1) >> 1;
  const h2 = (h + 1) >> 1;
  const tmp = new Float32Array(w2 * h * 3);
  const wm = w - 1;
  // horizontal: coarse j <- fine 2j-1, 2j, 2j+1, 2j+2 with weights 1,3,3,1 (/8)
  for (let y = 0; y < h; y++) {
    const r = y * w * 3;
    let o = y * w2 * 3;
    for (let j = 0; j < w2; j++) {
      const xa = 2 * j - 1 < 0 ? 0 : 2 * j - 1;
      const xb = 2 * j > wm ? wm : 2 * j;
      const xc = 2 * j + 1 > wm ? wm : 2 * j + 1;
      const xd = 2 * j + 2 > wm ? wm : 2 * j + 2;
      const a = r + xa * 3;
      const b = r + xb * 3;
      const c = r + xc * 3;
      const d = r + xd * 3;
      tmp[o] = 0.125 * (src[a] + src[d]) + 0.375 * (src[b] + src[c]);
      tmp[o + 1] = 0.125 * (src[a + 1] + src[d + 1]) + 0.375 * (src[b + 1] + src[c + 1]);
      tmp[o + 2] = 0.125 * (src[a + 2] + src[d + 2]) + 0.375 * (src[b + 2] + src[c + 2]);
      o += 3;
    }
  }
  // vertical
  const out = new Float32Array(w2 * h2 * 3);
  const s2 = w2 * 3;
  const hm = h - 1;
  for (let j = 0; j < h2; j++) {
    const ya = (2 * j - 1 < 0 ? 0 : 2 * j - 1) * s2;
    const yb = (2 * j > hm ? hm : 2 * j) * s2;
    const yc = (2 * j + 1 > hm ? hm : 2 * j + 1) * s2;
    const yd = (2 * j + 2 > hm ? hm : 2 * j + 2) * s2;
    const o = j * s2;
    for (let i = 0; i < s2; i++) {
      out[o + i] = 0.125 * (tmp[ya + i] + tmp[yd + i]) + 0.375 * (tmp[yb + i] + tmp[yc + i]);
    }
  }
  return { data: out, w: w2, h: h2 };
}

// dst (level k, dw x dh) += bilinear 2x upsample of src (level k+1, sw x sh).
// Weights are the constants 0.25 / 0.75 because of the centre convention above.
function upsample2Add(src, sw, sh, dst, dw, dh) {
  const sstride = sw * 3;
  const row = new Float32Array(sstride);
  const smax = sw - 1;
  const hmax = sh - 1;
  let o = 0;
  for (let y = 0; y < dh; y++) {
    const j = y >> 1;
    let ya;
    let yb;
    let wa;
    let wb;
    if ((y & 1) === 0) {
      ya = j - 1 < 0 ? 0 : j - 1;
      yb = j > hmax ? hmax : j;
      wa = 0.25;
      wb = 0.75;
    } else {
      ya = j > hmax ? hmax : j;
      yb = j + 1 > hmax ? hmax : j + 1;
      wa = 0.75;
      wb = 0.25;
    }
    const oa = ya * sstride;
    const ob = yb * sstride;
    for (let i = 0; i < sstride; i++) row[i] = wa * src[oa + i] + wb * src[ob + i];
    for (let x = 0; x < dw; x++) {
      const i = x >> 1;
      let xa;
      let xb;
      let ua;
      let ub;
      if ((x & 1) === 0) {
        xa = (i - 1 < 0 ? 0 : i - 1) * 3;
        xb = (i > smax ? smax : i) * 3;
        ua = 0.25;
        ub = 0.75;
      } else {
        xa = (i > smax ? smax : i) * 3;
        xb = (i + 1 > smax ? smax : i + 1) * 3;
        ua = 0.75;
        ub = 0.25;
      }
      dst[o] += ua * row[xa] + ub * row[xb];
      dst[o + 1] += ua * row[xa + 1] + ub * row[xb + 1];
      dst[o + 2] += ua * row[xa + 2] + ub * row[xb + 2];
      o += 3;
    }
  }
}

module.exports = { downsample2, upsample2Add, ROUND_TRIP_VARIANCE };
