"use strict";
// Loupe geometry (src/plugin/loupe.js) against the core (review v1.1 С1): a region read
// with the halo margin, aligned to the apply's block grid and computed at the apply's
// base level, must equal the same place of the full apply.

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../src/core");
const Loupe = require("../src/plugin/loupe.js");

// Dark background with white squares, thin lines and single bright pixels: the halo of
// small sources is where a wrong base level shows most.
function scene(W, H) {
  const d = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      let v = 60 + ((x * 7 + y * 13) % 7);
      if (x % 97 > 80 && y % 89 > 70) v = 255; // squares
      if (x % 61 === 0 || y % 53 === 0) v = 250; // 1-px lines
      if ((x * 31 + y * 17) % 997 === 0) v = 255; // dots
      d[i] = v;
      d[i + 1] = Math.max(0, v - 10);
      d[i + 2] = Math.max(0, v - 25);
    }
  }
  return d;
}

function maxDiffInView(full, W, out, read, view) {
  const rw = read.right - read.left;
  let max = 0;
  for (let y = view.top; y < view.bottom; y++) {
    for (let x = view.left; x < view.right; x++) {
      for (let c = 0; c < 3; c++) {
        const a = full[(y * W + x) * 3 + c];
        const b = out[((y - read.top) * rw + (x - read.left)) * 3 + c];
        max = Math.max(max, Math.abs(a - b));
      }
    }
  }
  return max;
}

const W = 700, H = 520;
const IMG = scene(W, H);
const AREA = { left: 0, top: 0, right: W, bottom: H };

for (const level of [1, 2]) {
  for (const blurMul of [0.05, 0.25, 1]) {
    test(`loupe equals the apply at base level ${level}, blur ×${blurMul}`, () => {
      const s = core.normalizeSettings({ mode: "reinhard", strength: 100, blurMul });
      const opts = { originX: 0, originY: 0, docLongSide: W, baseLevel: level };
      const full = core.processImage(IMG, W, H, 3, s, opts);
      for (const center of [{ x: 333, y: 251 }, { x: 20, y: 500 }, { x: 690, y: 7 }]) {
        const view = Loupe.viewRect(center, AREA, { w: 140, h: 120 }, 1);
        const read = Loupe.readRect(view, core.loupeMargin(s, W), AREA, level);
        assert.ok(Loupe.rectContains(read, view));
        assert.equal((read.left - AREA.left) % Loupe.alignUnit(level), 0);
        assert.equal((read.top - AREA.top) % Loupe.alignUnit(level), 0);
        const region = Loupe.cropRegion({ data: IMG, components: 3, width: W, height: H, left: 0, top: 0 }, read);
        const out = core.processImage(region.data, region.width, region.height, 3, s, {
          originX: read.left, originY: read.top, docLongSide: W, baseLevel: level,
        });
        assert.equal(maxDiffInView(full, W, out, read, view), 0, `centre ${center.x},${center.y}`);
      }
    });
  }
}

test("control: a wrong base level or an unaligned origin does not match the apply", () => {
  const s = core.normalizeSettings({ mode: "reinhard", strength: 100, blurMul: 1 });
  const full = core.processImage(IMG, W, H, 3, s, { originX: 0, originY: 0, docLongSide: W, baseLevel: 1 });
  const view = Loupe.viewRect({ x: 333, y: 251 }, AREA, { w: 140, h: 120 }, 1);
  const good = Loupe.readRect(view, core.loupeMargin(s, W), AREA, 1);
  function run(read, level) {
    const region = Loupe.cropRegion({ data: IMG, components: 3, width: W, height: H, left: 0, top: 0 }, read);
    const out = core.processImage(region.data, region.width, region.height, 3, s, {
      originX: read.left, originY: read.top, docLongSide: W, baseLevel: level,
    });
    return maxDiffInView(full, W, out, read, view);
  }
  assert.equal(run(good, 1), 0);
  assert.ok(run(good, 0) > 1, "a small region at its own level 0 differs");
  assert.ok(run({ ...good, left: good.left + 3, top: good.top + 3 }, 1) > 1, "an origin off the block grid differs");
});

test("loupe geometry: view clamped to the area, zoom ½ shows twice the area, display sizes", () => {
  const area = { left: 10, top: 20, right: 410, bottom: 320 };
  const box = { w: 278, h: 278 };
  assert.deepEqual(Loupe.viewRect({ x: 15, y: 25 }, area, box, 1), { left: 10, top: 20, right: 288, bottom: 298 });
  assert.deepEqual(Loupe.viewRect({ x: 200, y: 200 }, area, box, 0.5), { left: 10, top: 20, right: 410, bottom: 320 });
  const v2 = Loupe.viewRect({ x: 200, y: 200 }, area, box, 2);
  assert.equal(v2.right - v2.left, 139);
  const img1 = Loupe.displayRgb(new Uint8Array(400 * 300 * 3), 3, 400, area, { left: 10, top: 20, right: 410, bottom: 320 }, 0.5);
  assert.deepEqual([img1.width, img1.height], [400, 300]);
  assert.deepEqual(Loupe.displaySize(img1, 0.5), { w: 200, h: 150 });
  const img2 = Loupe.displayRgb(new Uint8Array(139 * 139 * 3), 3, 139, v2, v2, 2);
  assert.deepEqual([img2.width, img2.height], [278, 278]);
  assert.equal(Loupe.normZoom(3), 1);
  // far edge rounded up to the block grid, clamped to the area
  const r = Loupe.readRect({ left: 100, top: 100, right: 150, bottom: 150 }, 10, area, 1);
  assert.deepEqual(r, { left: 10 + 64, top: 20 + 64, right: 10 + 192, bottom: 20 + 192 });
});
