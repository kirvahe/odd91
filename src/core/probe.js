'use strict';
// Speed probe for the diagnostics report (v1.1.2, plan review 2026-11-27 С3).
// A fixed, small workload shaped like the apply path: a table lookup over 1 MB of bytes
// (as in pass 1) and a separable 9-tap filter over a 512 x 512 Float32 image (as in the blur).
// The bridge runs it right before pass 1 and right after pass 2, so one report tells a slow
// machine from slow code: a slow session shows a slow probe on both sides.
// Only + and * on fixed inputs, so Node and UXP compute the same numbers: the checksum is
// printed in the report and pinned by a test (the work cannot be optimized away or changed
// unnoticed). Compare probe times only between reports from the same machine and Photoshop.

const N = 1 << 20;
const F = 512;
const TAPS = [0.0625, 0.125, 0.1875, 0.25]; // half of a symmetric 9-tap kernel without the centre
const CENTRE = 0.25;                        // (the sum is not 1; only the work matters)

let bytes = null;
let table = null;
let imgA = null;
let imgB = null;

function init() {
  bytes = new Uint8Array(N);
  let a = 12345;
  for (let i = 0; i < N; i++) {
    a = (Math.imul(a, 1103515245) + 12345) >>> 0;
    bytes[i] = a >>> 24;
  }
  table = new Float32Array(256);
  for (let i = 0; i < 256; i++) table[i] = (i * i) / 65536;
  imgA = new Float32Array(F * F);
  imgB = new Float32Array(F * F);
}

function work() {
  let s = 0;
  for (let i = 0; i < N; i++) s += table[bytes[i]];
  for (let i = 0; i < F * F; i++) imgA[i] = table[bytes[i]];
  // horizontal pass A -> B, vertical pass B -> A; borders are left as they are
  for (let y = 0; y < F; y++) {
    const row = y * F;
    for (let x = 4; x < F - 4; x++) {
      const p = row + x;
      let v = CENTRE * imgA[p];
      for (let k = 1; k <= 4; k++) v += TAPS[4 - k] * (imgA[p - k] + imgA[p + k]);
      imgB[p] = v;
    }
  }
  let f = 0;
  for (let y = 4; y < F - 4; y++) {
    const row = y * F;
    for (let x = 4; x < F - 4; x++) {
      const p = row + x;
      let v = CENTRE * imgB[p];
      for (let k = 1; k <= 4; k++) v += TAPS[4 - k] * (imgB[p - k * F] + imgB[p + k * F]);
      imgA[p] = v;
      f += v;
    }
  }
  return (Math.round(s) + Math.round(f * 16)) % 1000003;
}

/**
 * Runs the workload `repeats` times (default 3).
 * @param {function(): number} [nowFn] clock in milliseconds (default: performance.now or Date.now)
 * @returns {{first: number, min: number, sum: number}} times in ms and the checksum
 */
function speedProbe(nowFn, repeats) {
  const now = typeof nowFn === 'function' ? nowFn
    : typeof performance !== 'undefined' && performance && typeof performance.now === 'function' ? () => performance.now()
      : () => Date.now();
  if (!bytes) init();
  const n = repeats > 0 ? Math.floor(repeats) : 3;
  let first = 0;
  let min = Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = now();
    sum = work();
    const ms = now() - t;
    if (i === 0) first = ms;
    if (ms < min) min = ms;
  }
  return { first, min, sum };
}

module.exports = { speedProbe };
