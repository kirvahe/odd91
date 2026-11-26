// Synthetic test frames for tools/bench.mjs and tools/perf.mjs, generated strip by strip so no
// full-size image is ever held in memory. Deterministic: the same strip always has the same bytes.
//  'lamps' — dark gradient with 6x6 white lamps every 500 px (the v1.0 benchmark scene);
//  'night' — a night portrait like Ilya's test frame: noisy dark background, warm bokeh discs
//            (radius 4-50 px) in the upper 60 %, a mid-tone face/shirt block and white specular
//            points. With a threshold around 200 only a small part of it emits light.

function hash(x, y, s) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const CELL = 180;
const discCache = new Map();

function discs(w, h) {
  const key = w + 'x' + h;
  if (discCache.has(key)) return discCache.get(key);
  const list = [];
  for (let cy = 0; cy * CELL < h * 0.6; cy++) {
    for (let cx = 0; cx * CELL < w; cx++) {
      if (hash(cx, cy, 1) >= 0.5) continue;
      const r = 4 + Math.floor(hash(cx, cy, 2) * 46);
      list.push({
        x: Math.floor(cx * CELL + hash(cx, cy, 3) * CELL),
        y: Math.floor(cy * CELL + hash(cx, cy, 4) * CELL),
        r,
        g: 150 + Math.floor(hash(cx, cy, 5) * 100),
        b: 40 + Math.floor(hash(cx, cy, 6) * 60),
      });
    }
  }
  discCache.set(key, list);
  return list;
}

function fillLamps(buf, w, y0, rows, comps) {
  let p = 0;
  for (let ry = 0; ry < rows; ry++) {
    const y = y0 + ry;
    for (let x = 0; x < w; x++) {
      const lamp = x % 500 < 6 && y % 500 < 6;
      const g = (x * 7 + y * 3) & 127;
      buf[p] = lamp ? 255 : g;
      buf[p + 1] = lamp ? 255 : g >> 1;
      buf[p + 2] = lamp ? 255 : g >> 2;
      if (comps === 4) buf[p + 3] = 255;
      p += comps;
    }
  }
}

function fillNight(buf, w, h, y0, rows, comps) {
  const fx0 = Math.floor(w * 0.38);
  const fx1 = Math.floor(w * 0.62);
  const fy0 = Math.floor(h * 0.35);
  for (let ry = 0; ry < rows; ry++) {
    const y = y0 + ry;
    let p = ry * w * comps;
    for (let x = 0; x < w; x++, p += comps) {
      let r, g, b;
      if (x >= fx0 && x < fx1 && y >= fy0) {
        const n = 120 + Math.floor(hash(x, y, 7) * 70);
        r = n;
        g = Math.floor(n * 0.82);
        b = Math.floor(n * 0.7);
      } else {
        const n = 18 + Math.floor(hash(x, y, 8) * 60);
        r = n;
        g = Math.floor(n * 0.8);
        b = Math.floor(n * 0.6);
      }
      if (hash(x >> 2, y >> 2, 9) > 0.9993) r = g = b = 255;
      buf[p] = r;
      buf[p + 1] = g;
      buf[p + 2] = b;
      if (comps === 4) buf[p + 3] = 255;
    }
  }
  for (const d of discs(w, h)) {
    const ya = Math.max(y0, d.y - d.r);
    const yb = Math.min(y0 + rows - 1, d.y + d.r);
    for (let y = ya; y <= yb; y++) {
      const dy = y - d.y;
      const half = Math.floor(Math.sqrt(d.r * d.r - dy * dy));
      const xa = Math.max(0, d.x - half);
      const xb = Math.min(w - 1, d.x + half);
      let p = ((y - y0) * w + xa) * comps;
      for (let x = xa; x <= xb; x++, p += comps) {
        buf[p] = 255;
        buf[p + 1] = d.g;
        buf[p + 2] = d.b;
      }
    }
  }
}

export function fillStrip(scene, buf, w, h, y0, rows, comps = 3) {
  if (scene === 'night') fillNight(buf, w, h, y0, rows, comps);
  else fillLamps(buf, w, y0, rows, comps);
}

// Runs the apply path exactly as ps-bridge does: pass 1 over strips, blurSteps, pass 2 over
// strips with fineRadius rows of context. Returns the processor (its stats hold the timings)
// and, if asked, an FNV-1a checksum of the output.
export function runApply(core, scene, w, h, settings, opts = {}) {
  const proc = core.createProcessor({
    width: w,
    height: h,
    originX: 0,
    originY: 0,
    docLongSide: opts.docLongSide || Math.max(w, h),
    baseLevel: opts.baseLevel,
    settings,
  });
  const rows = proc.stripRows;
  const fr = proc.fineRadius || 0;
  const buf = new Uint8Array((rows + 2 * fr) * w * 3);
  const out = new Uint8Array(rows * w * 3);
  let hsum = 0x811c9dc5;
  for (let y = 0; y < h; y += rows) {
    const n = Math.min(rows, h - y);
    fillStrip(scene, buf, w, h, y, n);
    proc.pass1(buf.subarray(0, n * w * 3), 3, y, n);
    if (opts.onStrip) opts.onStrip();
  }
  for (const _ of proc.blurSteps()) if (opts.onStrip) opts.onStrip();
  for (let y = 0; y < h; y += rows) {
    const n = Math.min(rows, h - y);
    const d0 = Math.max(0, y - fr);
    const d1 = Math.min(h, y + n + fr);
    fillStrip(scene, buf, w, h, d0, d1 - d0);
    const o = out.subarray(0, n * w * 3);
    if (fr) proc.pass2(buf.subarray(0, (d1 - d0) * w * 3), 3, y, n, o, { dataY0: d0, dataRows: d1 - d0 });
    else proc.pass2(buf.subarray(0, (d1 - d0) * w * 3), 3, y, n, o);
    if (opts.checksum) for (let i = 0; i < o.length; i++) hsum = Math.imul(hsum ^ o[i], 16777619);
    if (opts.onStrip) opts.onStrip();
  }
  return { proc, checksum: hsum >>> 0 };
}

// Core time of one run (generation excluded): the processor's own pass timers.
export function coreMs(proc) {
  const t = proc.stats.timings;
  return t.pass1 + t.blur + t.pass2;
}
