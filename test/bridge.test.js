"use strict";
// Apply / preview / pre-flight logic of src/plugin/ps-bridge.js against a fake
// `photoshop` module (test/helpers/fake-photoshop.js) and the real core.

const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../src/core");
const Bridge = require("../src/plugin/ps-bridge.js");
const Color = require("../src/plugin/color-utils.js");
const { createFakePhotoshop } = require("./helpers/fake-photoshop.js");

const SETTINGS = core.normalizeSettings({ strength: 80, blur: 40 });

// ---------------------------------------------------------------- fixtures

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// RGBA image: random colours, a few 255 "light sources", transparent where hole(x, y).
function makePixels(w, h, { seed = 1, hole = () => false } = {}) {
  const r = rng(seed);
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (hole(x, y)) continue;
      const src = r() < 0.03;
      d[i] = src ? 255 : Math.floor(r() * 200);
      d[i + 1] = src ? 255 : Math.floor(r() * 200);
      d[i + 2] = src ? 240 : Math.floor(r() * 200);
      d[i + 3] = r() < 0.1 ? 128 : 255;
    }
  }
  return d;
}

// Spy around the real processor: records the order of calls.
function spyCore() {
  const events = [];
  const spy = Object.assign({}, core, {
    createProcessor(opts) {
      const p = core.createProcessor(opts);
      events.push(["create", opts]);
      return {
        get stripRows() { return p.stripRows; },
        get stats() { return p.stats; },
        pass1(d, c, y0, rows) {
          events.push(["pass1", y0, rows, c]);
          return p.pass1(d, c, y0, rows);
        },
        *blurSteps() {
          for (const v of p.blurSteps()) {
            events.push(["blur", v]);
            yield v;
          }
        },
        pass2(d, c, y0, rows, out) {
          events.push(["pass2", y0, rows, c]);
          return p.pass2(d, c, y0, rows, out);
        },
      };
    },
  });
  return { core: spy, events };
}

function makeBridge(fake, extra = {}) {
  const logs = [];
  const bridge = Bridge.createBridge({
    photoshop: fake.photoshop,
    core: extra.core || core,
    color: Color,
    yieldFn: () => Promise.resolve(),
    log: (m) => logs.push(m),
    stripRows: extra.stripRows,
  });
  return { bridge, logs };
}

function areaOf(store, docW, area, comps = 4) {
  const W = area.right - area.left, H = area.bottom - area.top;
  const out = new Uint8Array(W * H * comps);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = ((area.top + y) * docW + area.left + x) * 4, d = (y * W + x) * comps;
      for (let c = 0; c < comps; c++) out[d + c] = store[s + c];
    }
  }
  return out;
}

function assertAreaEquals(store, docW, docH, area, expected, comps, label) {
  const W = area.right - area.left;
  let mismatches = 0, first = null;
  for (let y = 0; y < docH; y++) {
    for (let x = 0; x < docW; x++) {
      const s = (y * docW + x) * 4;
      const inside = x >= area.left && x < area.right && y >= area.top && y < area.bottom;
      for (let c = 0; c < 4; c++) {
        let want;
        if (!inside) want = 0;
        else {
          const e = ((y - area.top) * W + (x - area.left)) * comps;
          want = c < comps ? expected[e + c] : 255;
        }
        // nothing was written where the source is fully transparent
        if (inside && comps === 4 && expected[((y - area.top) * W + (x - area.left)) * 4 + 3] === 0) want = 0;
        if (store[s + c] !== want) {
          mismatches++;
          if (!first) first = { x, y, c, got: store[s + c], want };
        }
      }
    }
  }
  assert.equal(mismatches, 0, `${label}: ${mismatches} mismatches, first ${JSON.stringify(first)}`);
}

function allDisposed(fake) {
  const live = fake.log.imageDatas.filter((d) => !d._disposed);
  assert.equal(live.length, 0, `${live.length} of ${fake.log.imageDatas.length} image data objects not disposed`);
}

// Doc 80x60; source layer offset (7, 5), 50x41, with a diagonal transparent edge,
// a fully transparent band (rows 18-25 of the layer) and transparent corners.
function offsetLayerFake(emptyMode, extra = {}) {
  const lw = 50, lh = 41;
  const hole = (x, y) => (y >= 18 && y < 26) || x + y < 6 || x > lw - 4 + (y % 3);
  const fake = createFakePhotoshop({
    ...extra,
    width: 80,
    height: 60,
    emptyMode,
    layers: [
      { id: 2, name: "Огни", pixels: { left: 7, top: 5, w: lw, h: lh, data: makePixels(lw, lh, { seed: 7, hole }) } },
      { id: 1, name: "Фон", opaque: true, isBackground: true, pixels: { left: 0, top: 0, w: 80, h: 60, data: makePixels(80, 60, { seed: 3 }).map((v, i) => (i % 4 === 3 ? 255 : v)) } },
    ],
    activeId: 2,
  });
  return fake;
}

// ---------------------------------------------------------------- apply

for (const emptyMode of ["null", "throw", "zero"]) {
  test(`apply: offset layer, trimmed strips, transparent band (empty strip answered as ${emptyMode})`, async () => {
    const fake = offsetLayerFake(emptyMode);
    const spy = spyCore();
    const { bridge } = makeBridge(fake, { core: spy.core, stripRows: 4 });
    const src = fake.findLayer(2);
    const srcBefore = src._store.slice();

    const rep = await bridge.inspect({ replacePrevious: true });
    assert.deepEqual(rep.blocking, []);
    assert.equal(rep.canUseLayer, true);
    const plan = rep.plans.layer;
    const area = plan.area;
    assert.ok(area.left > 7 || area.top >= 5, "area comes from boundsNoEffects");
    assert.equal(plan.docLongSide, 80);

    const progress = [];
    const res = await bridge.apply({ settings: SETTINGS, plan, onProgress: (v) => progress.push(v) });

    // output == the core's one-shot result on the same area, placed at the area offset
    const expected = core.processImage(areaOf(srcBefore, 80, area), area.right - area.left, area.bottom - area.top, 4, SETTINGS, {
      originX: area.left,
      originY: area.top,
      docLongSide: 80,
    });
    const result = fake.findLayer(res.resultLayerId);
    assert.equal(result.name, core.layerNameFor(SETTINGS), "the name carries the settings");
    const back = core.settingsFromLayerName(result.name);
    assert.ok(Math.abs(back.blurMul - SETTINGS.blurMul) < 1e-3, "blurMul survives the name token");
    assert.deepEqual([back.strength, back.mode, back.color], [SETTINGS.strength, SETTINGS.mode, SETTINGS.color]);
    assertAreaEquals(result._store, 80, 60, area, expected, 4, "result layer");
    assert.ok(src._store.every((v, i) => v === srcBefore[i]), "source layer untouched");

    // strips: full work-area width, consecutive, twice (pass 1 and pass 2)
    const H = area.bottom - area.top;
    const n = Math.ceil(H / 4);
    assert.equal(fake.log.getPixels.length, 2 * n);
    fake.log.getPixels.forEach((g, i) => {
      const k = i % n;
      assert.equal(g.layerID, 2);
      assert.equal(g.componentSize, 8);
      assert.deepEqual(g.sourceBounds, {
        left: area.left,
        right: area.right,
        top: area.top + k * 4,
        bottom: Math.min(area.bottom, area.top + k * 4 + 4),
      });
    });

    // writes land on the trimmed bounds Photoshop returned for that strip
    assert.ok(fake.log.putPixels.length > 0 && fake.log.putPixels.length < n, "empty strips are not written");
    for (const p of fake.log.putPixels) {
      assert.equal(p.layerID, res.resultLayerId);
      assert.equal(p.colorProfile, "sRGB IEC61966-2.1");
      // the written rectangle is exactly the non-transparent bbox of the source in that strip
      const k = Math.floor((p.targetBounds.top - area.top) / 4);
      const strip = { left: area.left, right: area.right, top: area.top + k * 4, bottom: Math.min(area.bottom, area.top + k * 4 + 4) };
      let l = Infinity, t = Infinity, r = -1, b = -1;
      for (let y = strip.top; y < strip.bottom; y++) for (let x = strip.left; x < strip.right; x++) {
        if (srcBefore[(y * 80 + x) * 4 + 3]) { l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); b = Math.max(b, y); }
      }
      assert.deepEqual({ ...p.targetBounds, w: p.width, h: p.height }, { left: l, top: t, w: r - l + 1, h: b - t + 1 });
    }
    assert.ok(res.stats.emptyStrips + res.stats.toleratedErrors > 0, "the transparent band produced empty strips");
    if (emptyMode === "throw") assert.ok(res.stats.toleratedErrors > 0);

    // order: every pass 1 strip, then every blur step, then every pass 2 strip
    const kinds = spy.events.map((e) => e[0]);
    const lastP1 = kinds.lastIndexOf("pass1"), firstBlur = kinds.indexOf("blur");
    const lastBlur = kinds.lastIndexOf("blur"), firstP2 = kinds.indexOf("pass2");
    assert.ok(lastP1 < firstBlur && lastBlur < firstP2, "pass1 < blur < pass2");
    assert.deepEqual(spy.events.filter((e) => e[0] === "pass1").map((e) => e[1]), Array.from({ length: n }, (_, i) => i * 4));
    assert.deepEqual(spy.events.filter((e) => e[0] === "pass2").map((e) => e[1]), Array.from({ length: n }, (_, i) => i * 4));
    assert.deepEqual(spy.events[0][1].originX, area.left);
    assert.deepEqual(spy.events[0][1].originY, area.top);

    // one modal scope, one history step
    assert.equal(fake.log.modal.length, 1);
    assert.equal(fake.log.modal[0].commandName, "Halation");
    assert.deepEqual(fake.log.suspend, [{ documentID: 1, name: "Halation" }]);
    assert.deepEqual(fake.log.resume, [{ id: 4242, commit: true }]);
    assert.equal(fake.log.rollbacks, 0);

    // progress: monotone, read ends at 10 %, blur at 45 %, done at 100 %
    for (let i = 1; i < fake.log.progress.length; i++) assert.ok(fake.log.progress[i] >= fake.log.progress[i - 1] - 1e-12);
    assert.ok(fake.log.progress.some((v) => Math.abs(v - 0.10) < 1e-9));
    assert.ok(fake.log.progress.some((v) => Math.abs(v - 0.45) < 1e-9));
    assert.ok(Math.abs(fake.log.progress.at(-1) - 1) < 1e-9);
    assert.deepEqual(progress, fake.log.progress);

    // the new layer sits right above the source, and the source is active again
    const ids = fake.doc.layers.map((l) => l.id);
    assert.equal(ids.indexOf(res.resultLayerId), ids.indexOf(2) - 1);
    // createPixelLayer already put it above the active source: no move call (review М3)
    assert.deepEqual(fake.log.moves, []);
    assert.equal(res.stats.layerMoved, false);
    assert.equal(res.stats.placedAbove, "source");
    assert.deepEqual(fake.doc._active, [2]);
    assert.equal(res.stats.reselectedId, 2);

    allDisposed(fake);
    assert.equal(res.stats.getPixelsCalls, 2 * n);
    assert.ok(res.stats.bytesRead > 0 && res.stats.bytesWritten > 0);
  });
}

test("apply: opaque layer gives 3-component strips written untrimmed (strip height does not divide H)", async () => {
  const fake = createFakePhotoshop({
    width: 45,
    height: 31,
    layers: [{ id: 1, name: "Фон", opaque: true, isBackground: true, pixels: { left: 0, top: 0, w: 45, h: 31, data: makePixels(45, 31, { seed: 11 }) } }],
  });
  const { bridge } = makeBridge(fake, { stripRows: 7 });
  const before = fake.findLayer(1)._store.slice();
  const rep = await bridge.inspect({});
  const res = await bridge.apply({ settings: SETTINGS, plan: rep.plans.layer });
  const area = { left: 0, top: 0, right: 45, bottom: 31 };
  const expected = core.processImage(areaOf(before, 45, area, 3), 45, 31, 3, SETTINGS, { originX: 0, originY: 0, docLongSide: 45 });
  assertAreaEquals(fake.findLayer(res.resultLayerId)._store, 45, 31, area, expected, 3, "opaque result");
  assert.equal(fake.log.putPixels.length, Math.ceil(31 / 7));
  for (const p of fake.log.putPixels) {
    assert.equal(p.components, 3);
    assert.equal(p.width, 45);
    assert.equal(p.targetBounds.left, 0);
  }
  assert.deepEqual(fake.doc.layers.map((l) => l.id), [res.resultLayerId, 1]);
  assert.deepEqual(fake.doc._active, [1]);
  allDisposed(fake);
});

test("apply: the default strip height from the core gives the same result", async () => {
  const a = offsetLayerFake("null");
  const b = offsetLayerFake("null");
  const ra = await makeBridge(a).bridge.inspect({}).then((rep) => makeBridge(a).bridge.apply({ settings: SETTINGS, plan: rep.plans.layer }));
  const bb = makeBridge(b, { stripRows: 3 }).bridge;
  const rb = await bb.apply({ settings: SETTINGS, plan: (await bb.inspect({})).plans.layer });
  assert.ok(a.findLayer(ra.resultLayerId)._store.every((v, i) => v === b.findLayer(rb.resultLayerId)._store[i]));
  assert.equal(ra.stats.strips, 1, "a small layer fits one ~1 Mpx strip");
});

// Stage weights follow core.costEstimate() since v1.1.1, so the cancel points are taken from them:
// the middle of the blur stage and the middle of the write stage (review v1.1.1 С3).
async function stageMiddle(stage) {
  const probe = offsetLayerFake("null");
  const plan = (await makeBridge(probe).bridge.inspect({})).plans.layer;
  const a = plan.area;
  const w = Bridge.stageWeights(core.createProcessor({ width: a.right - a.left, height: a.bottom - a.top, docLongSide: plan.docLongSide, settings: SETTINGS }));
  return stage === "blur" ? w.read + w.blur / 2 : w.read + w.blur + w.write / 2;
}
for (const [label, created] of [["blur", 0], ["write", 1]]) {
  test(`apply: cancellation during ${label} rolls back and disposes everything`, async () => {
    // the fake sets isCancelled once reported progress reaches cancelAt
    const cancelAt = await stageMiddle(label);
    const fake = offsetLayerFake("null", { cancelAtProgress: cancelAt });
    const { bridge } = makeBridge(fake, { stripRows: 4 });
    const plan = (await bridge.inspect({})).plans.layer;
    const strips = Math.ceil((plan.area.bottom - plan.area.top) / 4);
    const idsBefore = fake.doc.layers.map((l) => l.id);
    await assert.rejects(bridge.apply({ settings: SETTINGS, plan }), (err) => {
      assert.ok(Bridge.isCancelError(err), "cancel error: " + err.message);
      assert.equal(Bridge.describeError(err).kind, "cancelled");
      assert.ok(err.halationStats && err.halationStats.cancelled);
      return true;
    });
    assert.equal(fake.log.created.length, created);
    if (label === "write") assert.ok(fake.log.putPixels.length > 0 && fake.log.putPixels.length < strips, `stopped mid-write: ${fake.log.putPixels.length} of ${strips} strips`);
    assert.deepEqual(fake.doc.layers.map((l) => l.id), idsBefore, "document rolled back");
    assert.equal(fake.log.rollbacks, 1);
    assert.equal(fake.log.resume.length, 0, "history not committed");
    assert.equal(bridge._results.size, 0, "no result recorded");
    allDisposed(fake);
  });
}

test("apply: a putPixels failure propagates (not swallowed), rolls back and disposes", async () => {
  const fake = createFakePhotoshop({
    width: 40,
    height: 30,
    failPutPixelsAt: 2,
    layers: [{ id: 1, name: "Фон", opaque: true, pixels: { left: 0, top: 0, w: 40, h: 30, data: makePixels(40, 30) } }],
  });
  const { bridge } = makeBridge(fake, { stripRows: 8 });
  const plan = (await bridge.inspect({})).plans.layer;
  await assert.rejects(bridge.apply({ settings: SETTINGS, plan }), /putPixels failed \(injected\)/);
  assert.deepEqual(fake.doc.layers.map((l) => l.id), [1]);
  assert.equal(fake.log.rollbacks, 1);
  allDisposed(fake);
});

test("apply: a getData failure in pass 1 propagates and disposes", async () => {
  const fake = createFakePhotoshop({
    width: 20,
    height: 20,
    failGetData: true,
    layers: [{ id: 1, name: "Фон", opaque: true, pixels: { left: 0, top: 0, w: 20, h: 20, data: makePixels(20, 20) } }],
  });
  const { bridge } = makeBridge(fake);
  const plan = (await bridge.inspect({})).plans.layer;
  await assert.rejects(bridge.apply({ settings: SETTINGS, plan }), (err) => {
    assert.equal(Bridge.describeError(err).kind, "error");
    return /getData failed/.test(err.message);
  });
  assert.equal(fake.log.created.length, 0);
  allDisposed(fake);
});

test("re-apply from the result layer: source is used, previous result replaced in the same step, source reselected", async () => {
  const fake = offsetLayerFake("null");
  const { bridge } = makeBridge(fake, { stripRows: 8 });
  const first = await bridge.apply({ settings: SETTINGS, plan: (await bridge.inspect({ replacePrevious: true })).plans.layer });
  assert.deepEqual(fake.doc._active, [2]);

  // the user clicks the result layer, then applies again with other settings
  fake.doc._active = [first.resultLayerId];
  const rep = await bridge.inspect({ replacePrevious: true });
  assert.equal(rep.plans.layer.sourceLayerId, 2);
  assert.deepEqual(rep.plans.layer.previousResultIds, [first.resultLayerId]);
  assert.ok(rep.notes.some((n) => /исходному слою «Огни»/.test(n)));
  const second = await bridge.apply({ settings: core.normalizeSettings({ strength: 30 }), plan: rep.plans.layer });

  const ids = fake.doc.layers.map((l) => l.id);
  assert.ok(!ids.includes(first.resultLayerId), "previous result deleted");
  assert.equal(ids.filter((id) => core.isResultLayerName(fake.findLayer(id).name)).length, 1);
  assert.equal(ids.indexOf(second.resultLayerId), ids.indexOf(2) - 1);
  assert.deepEqual(fake.doc._active, [2]);
  assert.deepEqual(second.stats.deletedPreviousIds, [first.resultLayerId]);
  assert.equal(fake.log.modal.length, 2);
  assert.equal(fake.log.history.length, 2, "one history step per apply, deletion included");
  assert.equal(fake.log.deleted.length, 1);
  // the deleted result no longer reaches a plan
  assert.deepEqual((await bridge.inspect({ replacePrevious: true })).plans.layer.previousResultIds, [second.resultLayerId]);
});

test("re-apply with 'replace' off: the new result goes above the old one, not under it", async () => {
  const fake = offsetLayerFake("null");
  const { bridge } = makeBridge(fake, { stripRows: 8 });
  const r1 = await bridge.apply({ settings: SETTINGS, plan: (await bridge.inspect({ replacePrevious: false })).plans.layer });
  assert.deepEqual(fake.doc._active, [2]);
  // the source is active, so createPixelLayer puts R2 between the source and R1
  const rep = await bridge.inspect({ replacePrevious: false });
  assert.deepEqual(rep.plans.layer.previousResultIds, []);
  const r2 = await bridge.apply({ settings: core.normalizeSettings({ strength: 90 }), plan: rep.plans.layer });
  assert.deepEqual(fake.doc.layers.map((l) => l.id), [r2.resultLayerId, r1.resultLayerId, 2, 1]);
  assert.equal(r2.stats.placedAbove, "result");
  assert.equal(r2.stats.layerMoved, true);
  assert.deepEqual(fake.log.moves.at(-1), { id: r2.resultLayerId, rel: r1.resultLayerId, placement: "placeBefore", noop: false });
  assert.ok(fake.log.moves.every((m) => !m.noop), "no move that leaves the layer in place");
  // a third one lands on top again
  const r3 = await bridge.apply({ settings: SETTINGS, plan: (await bridge.inspect({ replacePrevious: false })).plans.layer });
  assert.equal(fake.doc.layers[0].id, r3.resultLayerId);
  assert.deepEqual(fake.doc._active, [2]);
});

test("after Undo the restored result is tracked again and IDs of undone layers are dropped", async () => {
  const fake = offsetLayerFake("null");
  const { bridge } = makeBridge(fake, { stripRows: 8 });
  const r1 = await bridge.apply({ settings: SETTINGS, plan: (await bridge.inspect({ replacePrevious: true })).plans.layer });
  const r2 = await bridge.apply({ settings: SETTINGS, plan: (await bridge.inspect({ replacePrevious: true })).plans.layer });
  assert.ok(!fake.findLayer(r1.resultLayerId));

  fake.undo(); // R1 is back with its ID, R2 is gone
  assert.ok(fake.findLayer(r1.resultLayerId) && !fake.findLayer(r2.resultLayerId));

  const rep = await bridge.inspect({ replacePrevious: true });
  assert.deepEqual(rep.plans.layer.previousResultIds, [r1.resultLayerId], "only layers that exist");
  // R1 is still recognised as a result layer
  fake.doc._active = [r1.resultLayerId];
  const viaResult = await bridge.inspect({ replacePrevious: true });
  assert.equal(viaResult.plans.layer.sourceLayerId, 2);

  const r3 = await bridge.apply({ settings: SETTINGS, plan: viaResult.plans.layer });
  assert.deepEqual(r3.stats.deletedPreviousIds, [r1.resultLayerId]);
  const halation = fake.doc.layers.filter((l) => core.isResultLayerName(l.name)).map((l) => l.id);
  assert.deepEqual(halation, [r3.resultLayerId]);
  const ids = fake.doc.layers.map((l) => l.id);
  assert.equal(ids.indexOf(r3.resultLayerId), ids.indexOf(2) - 1);
});

test("composite: a smart object offers the visible image; result goes on top, reads have no layerID", async () => {
  const fake = createFakePhotoshop({
    width: 36,
    height: 28,
    compositeOpaque: true,
    layers: [
      { id: 5, name: "Смарт", kind: "smartObject", pixels: { left: 4, top: 4, w: 10, h: 10, data: makePixels(10, 10, { seed: 5 }) } },
      { id: 1, name: "Фон", opaque: true, pixels: { left: 0, top: 0, w: 36, h: 28, data: makePixels(36, 28, { seed: 9 }).map((v, i) => (i % 4 === 3 ? 255 : v)) } },
    ],
    activeId: 5,
  });
  const { bridge } = makeBridge(fake, { stripRows: 5 });
  const rep = await bridge.inspect({ replacePrevious: true });
  assert.equal(rep.canUseLayer, false);
  assert.equal(rep.offerComposite, true);
  assert.equal(rep.plans.layer, null);
  assert.ok(rep.warnings.some((w) => /смарт-объект/.test(w)));

  // expected: the core on the visible image (composite) of the whole document
  const before = await fake.photoshop.imaging.getPixels({ documentID: 1, sourceBounds: { left: 0, top: 0, right: 36, bottom: 28 } });
  const compData = await before.imageData.getData();
  before.imageData.dispose();
  fake.log.getPixels.length = 0;

  const res = await bridge.apply({ settings: SETTINGS, plan: rep.plans.composite });
  assert.ok(fake.log.getPixels.every((g) => g.layerID === undefined));
  assert.equal(fake.doc.layers[0].id, res.resultLayerId, "result on top");
  assert.deepEqual(fake.doc._active, [5], "the originally active layer is reselected");
  const expected = core.processImage(compData, 36, 28, 3, SETTINGS, { originX: 0, originY: 0, docLongSide: 36 });
  assertAreaEquals(fake.findLayer(res.resultLayerId)._store, 36, 28, { left: 0, top: 0, right: 36, bottom: 28 }, expected, 3, "composite result");
  allDisposed(fake);

  // activating that result later points back to the composite
  fake.doc._active = [res.resultLayerId];
  const again = await bridge.inspect({ replacePrevious: true });
  assert.equal(again.plans.layer, null);
  assert.deepEqual(again.plans.composite.previousResultIds, [res.resultLayerId]);
  assert.match(again.compositeNote, /скрываются/);

  // preview cache: the earlier result is hidden for the read, nothing lands in history
  const historyBefore = fake.log.history.length;
  fake.log.getPixels.length = 0;
  const pv = await bridge.buildPreview({ plan: again.plans.composite });
  assert.ok(fake.log.getPixels.length > 0);
  assert.ok(fake.log.getPixels.every((g) => !g.visibleLayers.includes(res.resultLayerId)), "result hidden during the read");
  assert.deepEqual(pv.stats.hiddenDuringRead, [res.resultLayerId]);
  assert.equal(fake.findLayer(res.resultLayerId).visible, true, "visibility restored");
  assert.equal(fake.log.resume.at(-1).commit, false, "history suspension discarded");
  assert.equal(fake.log.history.length, historyBefore);

  // apply again with "replace" off: no double halation, the old result stays visible below
  fake.log.getPixels.length = 0;
  const off = await bridge.inspect({ replacePrevious: false });
  assert.deepEqual(off.plans.composite.previousResultIds, []);
  const res2 = await bridge.apply({ settings: SETTINGS, plan: off.plans.composite });
  assert.ok(fake.log.getPixels.every((g) => !g.visibleLayers.includes(res.resultLayerId)), "old result hidden while reading");
  assertAreaEquals(fake.findLayer(res2.resultLayerId)._store, 36, 28, { left: 0, top: 0, right: 36, bottom: 28 }, expected, 3, "second composite result");
  assert.equal(fake.findLayer(res.resultLayerId).visible, true, "old result visible again");
  assert.deepEqual(fake.doc.layers.slice(0, 2).map((l) => l.id), [res2.resultLayerId, res.resultLayerId]);
  assert.deepEqual(fake.doc._active, [res.resultLayerId], "the active layer is reselected");
  assert.equal(fake.log.history.length, historyBefore + 1);
  allDisposed(fake);
});

// ---------------------------------------------------------------- read errors (review С5)

// Offset layer from offsetLayerFake: area top 5, 41 rows; with 4-row strips, strip 3
// (doc rows 17-20) has pixels and lies between strips with pixels.
const MID = 5 + 3 * 4;

async function applyWithFailure(failGetPixels, extra = {}) {
  const fake = offsetLayerFake("null", { failGetPixels, ...extra });
  const { bridge } = makeBridge(fake, { stripRows: 4 });
  const plan = (await bridge.inspect({})).plans.layer;
  const idsBefore = fake.doc.layers.map((l) => l.id);
  return { fake, bridge, plan, idsBefore, run: () => bridge.apply({ settings: SETTINGS, plan }) };
}

test("read error: the first strip of a layer (bounds prove pixels) fails the apply", async () => {
  const t = await applyWithFailure((req, n) => n === 1);
  await assert.rejects(t.run(), /getPixels failed \(injected\)/);
  assert.deepEqual(t.fake.doc.layers.map((l) => l.id), t.idsBefore);
  assert.equal(t.fake.log.rollbacks, 1);
  allDisposed(t.fake);
});

test("read error: a middle strip failing only in pass 1 fails the apply (passes disagree)", async () => {
  let calls = 0;
  const t = await applyWithFailure((req) => req.top === MID && ++calls === 1);
  await assert.rejects(t.run(), (err) => {
    assert.match(err.message, /изменилась между проходами/);
    assert.equal(Bridge.describeError(err).kind, "error");
    return true;
  });
  assert.deepEqual(t.fake.doc.layers.map((l) => l.id), t.idsBefore);
});

test("read error: pass 2 returning nothing for a strip that had pixels fails the apply", async () => {
  let calls = 0;
  const t = await applyWithFailure((req) => (req.top === MID && ++calls === 2 ? "empty" : false));
  await assert.rejects(t.run(), /изменилась между проходами/);
  assert.equal(t.fake.log.rollbacks, 1);
});

test("read error: a middle strip failing in both passes is tolerated, counted and reported", async () => {
  const t = await applyWithFailure((req) => req.top === MID);
  const res = await t.run();
  assert.equal(res.stats.toleratedErrors, 2);
  assert.equal(res.stats.toleratedStrips, 1);
  assert.ok(res.stats.toleratedMessages[0].includes("y=" + MID));
  // nothing written for that strip
  assert.ok(!t.fake.log.putPixels.some((p) => p.targetBounds.top <= MID && p.targetBounds.top + p.height > MID));
});

test("read error: the composite never tolerates a read error", async () => {
  const fake = createFakePhotoshop({
    width: 30,
    height: 24,
    compositeOpaque: true,
    failGetPixels: (req, n) => n === 3,
    layers: [{ id: 1, name: "Фон", opaque: true, pixels: { left: 0, top: 0, w: 30, h: 24, data: makePixels(30, 24) } }],
  });
  const { bridge } = makeBridge(fake, { stripRows: 4 });
  await assert.rejects(bridge.apply({ settings: SETTINGS, plan: (await bridge.inspect({})).plans.composite }), /getPixels failed/);
  assert.deepEqual(fake.doc.layers.map((l) => l.id), [1]);
});

test("error classes: cancel and busy are detected narrowly", () => {
  assert.equal(Bridge.isModalBusyError(new Error("host is in a modal state")), true);
  assert.equal(Bridge.isModalBusyError(new Error("Photoshop is currently in modal state (plugin X)")), true);
  assert.equal(Bridge.isModalBusyError(new Error("putPixels requires a modal scope")), false);
  assert.equal(Bridge.isModalBusyError(new Error("only allowed from inside a modal scope")), false);
  assert.equal(Bridge.isCancelError(new Error("cancelled by the user")), true);
  assert.equal(Bridge.isCancelError(new Error("Cannot read 'cancelButton' of undefined")), false);
  assert.equal(Bridge.isCancelError(new Error("could not cancel the download")), false);
  const n = new Error("x");
  n.number = -128;
  assert.equal(Bridge.isCancelError(n), true);
});

test("cancellation is recognised from executionContext.isCancelled even with an unrelated message", async () => {
  // Photoshop's own call fails after the user pressed Esc, with a message we do not know
  const fake = offsetLayerFake("null", { cancelAtProgress: 0.05 });
  const real = fake.photoshop.imaging.getPixels;
  let n = 0;
  fake.photoshop.imaging.getPixels = async (o) => {
    if (++n === 2) throw new Error("Error 8007: something went wrong");
    return real(o);
  };
  const { bridge } = makeBridge(fake, { stripRows: 4 });
  const plan = (await bridge.inspect({})).plans.layer;
  await assert.rejects(bridge.apply({ settings: SETTINGS, plan }), (err) => {
    assert.equal(Bridge.describeError(err).kind, "cancelled", err.message);
    return true;
  });
});

// ---------------------------------------------------------------- pre-flight

function oneLayer(spec = {}, docOpts = {}) {
  return createFakePhotoshop({
    width: 20,
    height: 20,
    ...docOpts,
    layers: [{ id: 3, name: "Слой", pixels: { left: 0, top: 0, w: 20, h: 20, data: makePixels(20, 20) }, ...spec }],
  });
}

test("pre-flight: RGB and 8 bit are required, other profiles and Photoshop 26.5-26.10 warn", async () => {
  let rep = await makeBridge(oneLayer({}, { bits: "bitDepth16" })).bridge.inspect({});
  assert.ok(rep.blocking.some((b) => /16 бит/.test(b) && /8 бит/.test(b)));
  rep = await makeBridge(oneLayer({}, { mode: "CMYKColorMode" })).bridge.inspect({});
  assert.ok(rep.blocking.some((b) => /CMYK/.test(b) && /RGB/.test(b)));
  rep = await makeBridge(oneLayer({}, { noDocument: true })).bridge.inspect({});
  assert.deepEqual(rep.blocking, ["Нет открытого документа."]);

  rep = await makeBridge(oneLayer({}, { profile: "Adobe RGB (1998)" })).bridge.inspect({});
  assert.deepEqual(rep.blocking, []);
  assert.ok(rep.warnings.some((w) => /Adobe RGB \(1998\)/.test(w)));
  assert.ok(rep.plans.layer);

  for (const [v, warn] of [["26.7.1", true], ["26.5.0", true], ["26.10.0", true], ["26.11.2", false], ["26.4.0", false], ["27.3.0", false]]) {
    rep = await makeBridge(oneLayer({}, { version: v })).bridge.inspect({});
    assert.equal(!!rep.memoryWarning, warn, v);
    assert.equal(rep.warnings.includes(rep.memoryWarning), warn, v);
  }
});

test("pre-flight: mask, opacity, blend mode and clipping warn and offer the visible image", async () => {
  const rep = await makeBridge(oneLayer({ hasUserMask: true, opacity: 50, blendMode: "screen", isClippingMask: true })).bridge.inspect({});
  assert.equal(rep.canUseLayer, true);
  assert.equal(rep.offerComposite, true);
  const w = rep.warnings.join(" ");
  for (const part of ["маска", "непрозрачность 50 %", "screen", "обтравочный"]) assert.ok(w.includes(part), part);
  assert.ok(rep.plans.layer && rep.plans.composite);

  const clean = await makeBridge(oneLayer()).bridge.inspect({});
  assert.deepEqual(clean.warnings, []);
  assert.equal(clean.offerComposite, false);
});

test("pre-flight: an empty layer is 'nothing to do', not an error", async () => {
  const fake = createFakePhotoshop({ width: 20, height: 20, layers: [{ id: 3, name: "Пустой" }] });
  const rep = await makeBridge(fake).bridge.inspect({});
  assert.deepEqual(rep.blocking, []);
  assert.equal(rep.nothingToDo, true);
  assert.match(rep.nothingMessage, /пуст/);
});

test("modal busy: a readable Russian message", async () => {
  const fake = oneLayer({}, { modalBusy: true });
  const { bridge } = makeBridge(fake);
  const plan = (await bridge.inspect({})).plans.layer;
  await assert.rejects(bridge.apply({ settings: SETTINGS, plan }), (err) => {
    const d = Bridge.describeError(err);
    assert.equal(d.kind, "busy");
    assert.match(d.text, /занят/);
    return true;
  });
});

// ---------------------------------------------------------------- preview, colour, events

test("preview: built from full-width strips inside a modal scope, with progress and dispose", async () => {
  const fake = offsetLayerFake("throw");
  const { bridge } = makeBridge(fake, { stripRows: 6 });
  const plan = (await bridge.inspect({})).plans.layer;
  const seen = [];
  const res = await bridge.buildPreview({ plan, maxLongSide: 500, onProgress: (v) => seen.push(v) });
  assert.equal(fake.log.modal.length, 1);
  assert.equal(fake.log.modal[0].commandName, "Halation: предпросмотр");
  assert.ok(fake.log.getPixels.every((g) => g.sourceBounds.left === plan.area.left && g.sourceBounds.right === plan.area.right));
  assert.equal(res.proxy.srcWidth, plan.area.right - plan.area.left);
  assert.equal(res.docLongSide, 80);
  assert.ok(seen.length > 1 && Math.abs(seen.at(-1) - 1) < 1e-9);
  assert.equal(fake.log.created.length, 0, "preview does not change the document");
  allDisposed(fake);
  // draft and full renders from the cache (src/core/API.md)
  const full = core.renderPreview(res.proxy, SETTINGS, "after", { docLongSide: res.docLongSide });
  const draft = core.renderPreview(res.proxy, SETTINGS, "after", { docLongSide: res.docLongSide, draft: true });
  assert.ok(draft.width < full.width && draft.data.length === draft.width * draft.height * 3);
});

test("colour picker: runs in a modal scope, parses defensively, exceptions mean cancel", async () => {
  const cases = [
    [[{ RGBFloatColor: { _obj: "RGBColor", red: 1, grain: 0.5, blue: 0 } }], [255, 128, 0]],
    [[{ color: { _obj: "RGBColor", red: 200, green: 100, blue: 50 } }], [200, 100, 50]],
    [[{ color: { _obj: "RGBColor", red: 255, grain: 144, blue: 39 } }], [255, 144, 39]],
    [[{ color: { _obj: "labColor", luminance: 100, a: 0, b: 0 } }], [255, 255, 255]],
    [[{}], null],
    [[], null],
  ];
  for (const [response, want] of cases) {
    const fake = oneLayer({}, { colorPickerResponse: response });
    const res = await makeBridge(fake).bridge.pickColor([255, 144, 39]);
    assert.deepEqual(res.rgb, want, JSON.stringify(response));
    assert.equal(res.cancelled, want === null);
    assert.deepEqual(res.raw, response.length ? response : []);
    assert.equal(fake.log.modal[0].commandName, "Halation: цвет");
    const call = fake.log.batchPlay.at(-1)[0];
    assert.equal(call._obj, "showColorPicker");
    assert.deepEqual(call.color, { _obj: "RGBColor", red: 255, grain: 144, blue: 39 });
  }
  const thrown = await makeBridge(oneLayer({}, { colorPickerThrows: true })).bridge.pickColor([1, 2, 3]);
  assert.equal(thrown.cancelled, true);
  assert.ok(thrown.error);
  // colours the core rejects (black) must be rejected by the panel
  assert.equal(core.colorGains([0, 0, 0]), null);
});

test("change notifications only mark stale: tool selection ignored, layer/document events pass", async () => {
  const fake = oneLayer();
  const { bridge } = makeBridge(fake);
  const got = [];
  bridge.watchChanges((name) => got.push(name));
  fake.fire("select", { _target: [{ _ref: "moveTool" }] });
  fake.fire("select", { _target: [{ _ref: "layer", _name: "Слой" }] });
  fake.fire("select", { _target: [{ _ref: "document", _id: 2 }] });
  fake.fire("make", { _target: [{ _ref: "layer" }] });
  assert.deepEqual(got, ["select", "select", "make"]);
  assert.equal(fake.log.getPixels.length, 0);
  assert.equal(fake.log.modal.length, 0);
});

test("placeStrip: 3-component trimmed data is expanded to RGBA with alpha 0 around it", () => {
  const raw = new Uint8Array([10, 20, 30, 40, 50, 60]); // 2x1 RGB
  const placed = Bridge.placeStrip(raw, 3, { left: 6, top: 11, right: 8, bottom: 12 }, { left: 5, top: 10, right: 9, bottom: 12 });
  assert.equal(placed.components, 4);
  assert.equal(placed.full, false);
  assert.deepEqual(placed.rect, { x: 1, y: 1, w: 2, h: 1 });
  assert.deepEqual(Array.from(placed.data), [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 10, 20, 30, 255, 40, 50, 60, 255, 0, 0, 0, 0,
  ]);
  assert.equal(Bridge.placeStrip(raw, 3, { left: 0, top: 0, right: 2, bottom: 1 }, { left: 5, top: 10, right: 9, bottom: 12 }), null);
});

// ---------------------------------------------------------------- v1.1: mask, names, loupe

test("selection -> layer mask: written for the whole area in the same step, then disposed", async () => {
  const sel = { left: 20, top: 10, right: 40, bottom: 30 };
  const fake = offsetLayerFake("null", { selection: sel });
  const { bridge } = makeBridge(fake, { stripRows: 8 });
  const rep = await bridge.inspect({});
  assert.deepEqual(rep.selection, sel);
  const plan = rep.plans.layer;
  const a = plan.area;
  const res = await bridge.apply({ settings: SETTINGS, plan, maskToSelection: true });
  assert.deepEqual(fake.log.getSelection, [{ documentID: 1, sourceBounds: a }]);
  assert.equal(fake.log.putLayerMask.length, 1);
  assert.deepEqual(fake.log.putLayerMask[0], { layerID: res.resultLayerId, targetBounds: { left: a.left, top: a.top }, width: a.right - a.left, height: a.bottom - a.top, replace: true });
  const mask = fake.findLayer(res.resultLayerId)._mask;
  for (let y = a.top; y < a.bottom; y++) {
    for (let x = a.left; x < a.right; x++) {
      const inside = x >= sel.left && x < sel.right && y >= sel.top && y < sel.bottom;
      assert.equal(mask[y * 80 + x], inside ? 255 : 0, `mask at ${x},${y}`);
    }
  }
  assert.ok(res.stats.mask && res.stats.mask.selectionBounds);
  assert.equal(fake.log.history.length, 1, "one history step");
  allDisposed(fake);

  // without the option nothing touches the selection
  const fake2 = offsetLayerFake("null", { selection: sel });
  const b2 = makeBridge(fake2).bridge;
  await b2.apply({ settings: SETTINGS, plan: (await b2.inspect({})).plans.layer });
  assert.equal(fake2.log.getSelection.length, 0);
  assert.equal(fake2.log.putLayerMask.length, 0);
});

test("selection that misses the work area: no mask and a warning, never an invisible result", async () => {
  const fake = offsetLayerFake("null", { selection: { left: 70, top: 50, right: 80, bottom: 60 } });
  const { bridge } = makeBridge(fake);
  const plan = (await bridge.inspect({})).plans.layer;
  const res = await bridge.apply({ settings: SETTINGS, plan, maskToSelection: true });
  assert.equal(fake.log.putLayerMask.length, 0, "no mask");
  assert.match(res.stats.maskWarning, /не пересекает/);
  assert.equal(fake.findLayer(res.resultLayerId)._mask, undefined);
  // the selection was read before any pixel work
  const firstGetPixels = fake.log.getPixels.length;
  assert.ok(firstGetPixels > 0);
  const none = await makeBridge(offsetLayerFake("null")).bridge.inspect({});
  assert.equal(none.selection, null);
});

test("selection read first: a missing getSelection fails before any pixel is read", async () => {
  const fake = offsetLayerFake("null", { selection: { left: 20, top: 10, right: 40, bottom: 30 } });
  delete fake.photoshop.imaging.getSelection;
  const { bridge } = makeBridge(fake);
  const plan = (await bridge.inspect({})).plans.layer;
  await assert.rejects(bridge.apply({ settings: SETTINGS, plan, maskToSelection: true }), /getSelection/);
  assert.equal(fake.log.getPixels.length, 0, "no pixel read before the failure");
  assert.equal(fake.log.created.length, 0);
});

test("selection answered with data the size of the request: the mask is not shifted", async () => {
  const sel = { left: 20, top: 10, right: 40, bottom: 30 };
  const fake = offsetLayerFake("null", { selection: sel, selectionAnswer: "request" });
  const { bridge } = makeBridge(fake);
  const plan = (await bridge.inspect({})).plans.layer;
  const a = plan.area;
  const res = await bridge.apply({ settings: SETTINGS, plan, maskToSelection: true });
  assert.equal(res.stats.mask.answer, "размер запроса");
  const mask = fake.findLayer(res.resultLayerId)._mask;
  for (let y = a.top; y < a.bottom; y++) {
    for (let x = a.left; x < a.right; x++) {
      const inside = x >= sel.left && x < sel.right && y >= sel.top && y < sel.bottom;
      assert.equal(mask[y * 80 + x], inside ? 255 : 0, `mask at ${x},${y}`);
    }
  }
  allDisposed(fake);
});

test("result layers are recognised by name, also from an earlier session", async () => {
  const earlier = core.normalizeSettings({ strength: 150, blurMul: 0.5, threshold: 120 });
  const name = core.layerNameFor(earlier);
  const fake = offsetLayerFake("null");
  // an earlier result directly above the source, made before the panel was reloaded
  const old = fake.makeLayer({ id: 50, name, pixels: { left: 0, top: 0, w: 80, h: 60, data: new Uint8Array(80 * 60 * 4).fill(200) } });
  fake.doc.layers.unshift(old);
  fake.doc._active = [50];
  const { bridge } = makeBridge(fake, { stripRows: 8 });

  const rep = await bridge.inspect({ replacePrevious: true });
  assert.equal(rep.activeLayer.isResult, true);
  assert.equal(rep.activeLayer.settingsFromName.strength, 150);
  assert.equal(rep.activeLayer.settingsFromName.threshold, 120);
  assert.equal(rep.plans.layer.sourceLayerId, 2, "the layer below is the source");
  assert.ok(rep.notes.some((n) => /под ним «Огни»/.test(n)));
  assert.deepEqual(rep.plans.layer.previousResultIds, [50]);
  const res = await bridge.apply({ settings: SETTINGS, plan: rep.plans.layer });
  assert.ok(!fake.findLayer(50), "earlier result replaced");
  const ids = fake.doc.layers.map((l) => l.id);
  assert.equal(ids.indexOf(res.resultLayerId), ids.indexOf(2) - 1);

  // the plain v1.0 name counts too; without "replace" the new result goes above it
  const fake2 = offsetLayerFake("null");
  fake2.doc.layers.unshift(fake2.makeLayer({ id: 60, name: "Halation", pixels: { left: 0, top: 0, w: 80, h: 60, data: new Uint8Array(80 * 60 * 4).fill(90) } }));
  fake2.doc._active = [2];
  const b2 = makeBridge(fake2).bridge;
  const r2 = await b2.apply({ settings: SETTINGS, plan: (await b2.inspect({ replacePrevious: false })).plans.layer });
  assert.deepEqual(fake2.doc.layers.map((l) => l.id).slice(0, 3), [r2.resultLayerId, 60, 2]);
});

test("composite reads hide result-named layers from an earlier session as well", async () => {
  const fake = createFakePhotoshop({
    width: 30,
    height: 20,
    compositeOpaque: true,
    layers: [
      { id: 70, name: "Halation", pixels: { left: 0, top: 0, w: 30, h: 20, data: new Uint8Array(30 * 20 * 4).fill(255) } },
      { id: 1, name: "Фон", opaque: true, pixels: { left: 0, top: 0, w: 30, h: 20, data: makePixels(30, 20).map((v, i) => (i % 4 === 3 ? 255 : v)) } },
    ],
    activeId: 1,
  });
  const { bridge } = makeBridge(fake, { stripRows: 6 });
  const rep = await bridge.inspect({});
  await bridge.apply({ settings: SETTINGS, plan: rep.plans.composite });
  assert.ok(fake.log.getPixels.every((g) => !g.visibleLayers.includes(70)));
  assert.equal(fake.findLayer(70).visible, true);
});

test("loupe: readRegion clamps to the work area, keeps trimmed pixels transparent, hides results", async () => {
  const fake = offsetLayerFake("null");
  const { bridge } = makeBridge(fake);
  const plan = (await bridge.inspect({})).plans.layer;
  const a = plan.area;
  const want = { left: a.left - 10, top: a.top + 3, right: a.left + 20, bottom: a.top + 17 };
  const r = await bridge.readRegion({ plan, rect: want });
  assert.deepEqual([r.left, r.top, r.width, r.height], [a.left, a.top + 3, 20, 14]);
  assert.equal(r.components, 4);
  const store = fake.findLayer(2)._store;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      for (let c = 0; c < 4; c++) {
        const s = ((r.top + y) * 80 + r.left + x) * 4 + c;
        const got = r.data[(y * r.width + x) * 4 + c];
        const alpha = store[((r.top + y) * 80 + r.left + x) * 4 + 3];
        assert.equal(got, alpha === 0 ? 0 : store[s], `pixel ${x},${y},${c}`);
      }
    }
  }
  assert.equal(fake.log.modal.at(-1).commandName, "Halation: лупа");
  assert.equal(fake.log.created.length, 0);
  allDisposed(fake);
  // the same pixels run through the core give what the full apply gives there
  const out = core.processImage(r.data, r.width, r.height, 4, SETTINGS, { originX: r.left, originY: r.top, docLongSide: 80, view: "halo" });
  assert.equal(out.length, r.data.length);
  await assert.rejects(bridge.readRegion({ plan, rect: { left: 0, top: 0, right: 3, bottom: 3 } }), (err) => Bridge.describeError(err).kind === "nothing");

  // composite: earlier results hidden during the read, nothing committed to history
  const comp = createFakePhotoshop({
    width: 30,
    height: 20,
    compositeOpaque: true,
    layers: [
      { id: 70, name: "Halation", pixels: { left: 0, top: 0, w: 30, h: 20, data: new Uint8Array(30 * 20 * 4).fill(255) } },
      { id: 1, name: "Фон", opaque: true, pixels: { left: 0, top: 0, w: 30, h: 20, data: makePixels(30, 20).map((v, i) => (i % 4 === 3 ? 255 : v)) } },
    ],
    activeId: 1,
  });
  const cb = makeBridge(comp).bridge;
  const cplan = (await cb.inspect({})).plans.composite;
  const cr = await cb.readRegion({ plan: cplan, rect: { left: 5, top: 5, right: 15, bottom: 12 } });
  assert.equal(cr.components, 3);
  assert.ok(comp.log.getPixels.every((g) => !g.visibleLayers.includes(70)));
  assert.equal(comp.findLayer(70).visible, true);
  assert.equal(comp.log.resume.at(-1).commit, false);
  assert.equal(comp.log.history.length, 0);
  assert.deepEqual(cr.stats.hiddenDuringRead, [70]);
});

test("peek: active layer settings and selection without a modal scope", async () => {
  const s = core.normalizeSettings({ strength: 222 });
  const fake = offsetLayerFake("null", { selection: { left: 1, top: 2, right: 3, bottom: 4 } });
  fake.doc.layers.unshift(fake.makeLayer({ id: 80, name: core.layerNameFor(s) }));
  fake.doc._active = [80];
  const p = await makeBridge(fake).bridge.peek();
  assert.equal(p.activeLayer.settingsFromName.strength, 222);
  assert.deepEqual(p.selection, { left: 1, top: 2, right: 3, bottom: 4 });
  assert.equal(fake.log.modal.length, 0);
});

// ---------------------------------------------------------------- v1.1 review: names, fine radius

test("a user layer named «Halation …» is never treated as a result (review v1.1 С3)", async () => {
  for (const userName of ["Halation mask paint", "Halation copy", "Halation 2", "Halation — ретушь"]) {
    assert.equal(core.isResultLayerName(userName), false, userName);
    const fake = offsetLayerFake("null");
    fake.doc.layers.unshift(fake.makeLayer({ id: 90, name: userName, pixels: { left: 0, top: 0, w: 80, h: 60, data: new Uint8Array(80 * 60 * 4).fill(120) } }));
    fake.doc._active = [2];
    const { bridge } = makeBridge(fake, { stripRows: 8 });
    const rep = await bridge.inspect({ replacePrevious: true });
    assert.deepEqual(rep.plans.layer.previousResultIds, [], "not a previous result: " + userName);
    await bridge.apply({ settings: SETTINGS, plan: rep.plans.layer });
    assert.ok(fake.findLayer(90), "user layer kept: " + userName);
    // composite: the user layer stays visible in every read
    fake.log.getPixels.length = 0;
    const comp = (await bridge.inspect({ replacePrevious: false })).plans.composite;
    await bridge.apply({ settings: SETTINGS, plan: comp });
    assert.ok(fake.log.getPixels.every((g) => g.visibleLayers.includes(90)), "user layer read: " + userName);
    // active user layer named «Halation …» is processed itself, not the layer below
    fake.doc._active = [90];
    const own = await bridge.inspect({ replacePrevious: true });
    assert.equal(own.plans.layer.sourceLayerId, 90, "processed itself: " + userName);
    assert.ok(!own.notes.some((n) => /под ним/.test(n)));
  }
  assert.equal(core.isResultLayerName("Halation"), true);
  assert.equal(core.isResultLayerName(core.layerNameFor(SETTINGS)), true);
});

// A spy that reports a fine radius: pass 2 must read the strip with that many extra rows
// above and below (clamped to the work area) and hand them to pass2 as dataY0 / dataRows.
function fineRadiusCore(radius, calls) {
  return Object.assign({}, core, {
    createProcessor(opts) {
      const p = core.createProcessor(opts);
      return {
        get stripRows() { return p.stripRows; },
        get stats() { return p.stats; },
        get fineRadius() { return radius; },
        pass1: (...a) => p.pass1(...a),
        blurSteps: () => p.blurSteps(),
        pass2(data, comps, y0, rows, out, o) {
          calls.push({ y0, rows, dataY0: o && o.dataY0, dataRows: o && o.dataRows, len: data.length, comps });
          return p.pass2(data, comps, y0, rows, out, o);
        },
      };
    },
  });
}

test("pass 2 reads overlapping strips for core.fineRadius and passes dataY0 / dataRows", async () => {
  const fake = offsetLayerFake("null");
  const calls = [];
  const { bridge } = makeBridge(fake, { core: fineRadiusCore(3, calls), stripRows: 4 });
  const plan = (await bridge.inspect({})).plans.layer;
  const a = plan.area, H = a.bottom - a.top, n = Math.ceil(H / 4);
  const res = await bridge.apply({ settings: SETTINGS, plan });
  assert.equal(res.stats.fineRadius, 3);
  const pass2Reads = fake.log.getPixels.slice(n);
  assert.equal(pass2Reads.length, n);
  pass2Reads.forEach((g, i) => {
    const y0 = i * 4, end = Math.min(H, y0 + 4);
    assert.equal(g.sourceBounds.top, a.top + Math.max(0, y0 - 3), "top with context, strip " + i);
    assert.equal(g.sourceBounds.bottom, a.top + Math.min(H, end + 3), "bottom with context, strip " + i);
    const c = calls[i];
    assert.equal(c.y0, y0);
    assert.equal(c.dataY0, Math.max(0, y0 - 3));
    assert.equal(c.dataRows, Math.min(H, end + 3) - Math.max(0, y0 - 3));
    assert.equal(c.len, c.dataRows * (a.right - a.left) * c.comps);
  });
  // writes stay on each strip's own rows: nothing outside the area, nothing twice
  for (const p of fake.log.putPixels) {
    const k = Math.floor((p.targetBounds.top - a.top) / 4);
    assert.ok(p.targetBounds.top + p.height <= a.top + Math.min(H, k * 4 + 4), "write inside its strip");
  }
  // the result equals the one-shot core result (the transparent band stays empty)
  const expected = core.processImage(areaOf(fake.findLayer(2)._store, 80, a), a.right - a.left, H, 4, SETTINGS, {
    originX: a.left, originY: a.top, docLongSide: 80,
  });
  assertAreaEquals(fake.findLayer(res.resultLayerId)._store, 80, 60, a, expected, 4, "fine radius result");
  allDisposed(fake);
});

test("with the real core: a level-1 apply (fine gaussians in pass 2) matches processImage", async () => {
  const W = 1200, H = 900; // above the full-resolution limit: base level 1
  const level = typeof core.baseLevelFor === "function" ? core.baseLevelFor(W, H) : 0;
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const x = i % W, y = Math.floor(i / W);
    const v = (x % 53 > 45 && y % 47 > 40) || (x * 7 + y * 3) % 401 === 0 ? 255 : 50 + ((x + y) % 9);
    data.set([v, v - 10 > 0 ? v - 10 : 0, v - 30 > 0 ? v - 30 : 0, 255], i * 4);
  }
  const fake = createFakePhotoshop({ width: W, height: H, layers: [{ id: 1, name: "Фон", opaque: true, pixels: { left: 0, top: 0, w: W, h: H, data } }] });
  const s = core.normalizeSettings({ blurMul: 0.02, strength: 100, mode: "reinhard" });
  const { bridge } = makeBridge(fake, { stripRows: 37 });
  const res = await bridge.apply({ settings: s, plan: (await bridge.inspect({})).plans.layer });
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) rgb.set(data.subarray(i * 4, i * 4 + 3), i * 3);
  const expected = core.processImage(rgb, W, H, 3, s, { originX: 0, originY: 0, docLongSide: W });
  assertAreaEquals(fake.findLayer(res.resultLayerId)._store, W, H, { left: 0, top: 0, right: W, bottom: H }, expected, 3, "level " + level);
  if (level >= 1 && res.stats.fineRadius > 0) {
    assert.ok(fake.log.getPixels.slice(Math.ceil(H / 37)).some((g) => g.sourceBounds.bottom - g.sourceBounds.top > 37), "overlapping reads used");
  }
  // v1.1.1: progress weights from the core's cost estimate; fine Gaussians make writing the heavy stage
  const pw = res.stats.progressWeights;
  assert.ok(pw && Math.abs(pw.read + pw.blur + pw.write - 1) < 0.01, JSON.stringify(pw));
  assert.ok(pw.read >= 0.05 - 1e-9 && pw.blur >= 0.05 - 1e-9 && pw.write >= 0.05 - 1e-9, "each stage at least 5 %");
  if (res.stats.fineRadius > 0) assert.ok(pw.write > 0.55, "write weight " + pw.write);
  assert.ok(res.stats.io.getPixelsMs >= 0 && res.stats.io.putPixelsMs >= 0 && res.stats.yields.count > 0);
  const vals = fake.log.progress;
  for (let i = 1; i < vals.length; i++) assert.ok(vals[i] >= vals[i - 1], "progress never goes back");
  assert.ok(Math.abs(vals[vals.length - 1] - 1) < 1e-9, "progress ends at 1");
});
