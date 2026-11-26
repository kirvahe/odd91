"use strict";
// Settings persistence (one JSON with a schema version) and the diagnostics report.

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../src/core");
const Store = require("../src/plugin/settings-store.js");
const Diagnostics = require("../src/plugin/diagnostics.js");

function memoryStorage(initial) {
  const m = new Map(initial ? Object.entries(initial) : []);
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    raw: m,
  };
}

test("settings: round trip with a schema version", () => {
  const storage = memoryStorage();
  const store = Store.create({ storage, core });
  const s = core.normalizeSettings({ mode: "curve", strength: 70, color: [255, 89, 25] });
  const ui = { yAxis: "log", view: "halo", previewMode: "loupe", zoom: 2, replace: false, k: "0.1", diagOpen: true };
  assert.equal(store.save(s, ui), true);
  const saved = JSON.parse(storage.raw.get(Store.KEY));
  assert.equal(saved.schema, Store.SCHEMA);
  const loaded = store.load();
  assert.equal(loaded.error, null);
  assert.equal(loaded.fromStorage, true);
  assert.deepEqual(loaded.settings, s);
  assert.deepEqual(loaded.ui, ui);
  assert.equal(loaded.migratedFrom, null);
});

test("settings: a v1.0 record (schema 1, blur 0..100) is migrated and keeps the user's values", () => {
  const v10 = {
    schema: 1,
    settings: { mode: "curve", blur: 75, strength: 60, color: [255, 89, 25], curvePoints: [[128, 0.2]] },
    ui: { yAxis: "log", view: "halo", replace: false, k: "0.25", diagOpen: false },
  };
  const storage = memoryStorage({ [Store.KEY]: JSON.stringify(v10) });
  const store = Store.create({ storage, core });
  const loaded = store.load();
  assert.equal(loaded.error, null);
  assert.equal(loaded.migratedFrom, 1);
  assert.ok(Math.abs(loaded.settings.blurMul - Math.pow(2, (75 - 50) / 25)) < 1e-9, "blur 75 -> x2");
  assert.equal("blur" in loaded.settings, false);
  assert.equal(loaded.settings.strength, 60);
  assert.equal(loaded.settings.mode, "curve");
  assert.deepEqual(loaded.settings.color, [255, 89, 25]);
  assert.deepEqual(loaded.settings.curvePoints, [[128, 0.2]]);
  assert.equal(loaded.ui.yAxis, "log");
  assert.equal(loaded.ui.k, "0.25");
  // saved again as schema 2
  store.save(loaded.settings, loaded.ui);
  assert.equal(JSON.parse(storage.raw.get(Store.KEY)).schema, 2);
  assert.equal(store.load().migratedFrom, null);
});

test("presets: save, overwrite by name, load and delete in localStorage", () => {
  const storage = memoryStorage();
  const store = Store.create({ storage, core });
  assert.deepEqual(store.loadPresets(), []);
  const a = core.normalizeSettings({ strength: 120, threshold: 200, softness: 10 });
  let r = store.savePreset("  Мой   свет ", a);
  assert.equal(r.ok, true);
  assert.equal(r.name, "Мой свет");
  r = store.savePreset("Другой", core.normalizeSettings({ blurMul: 0.05 }));
  r = store.savePreset("мой свет", core.normalizeSettings({ strength: 7 })); // same name, other case: overwrite
  const list = store.loadPresets();
  assert.deepEqual(list.map((p) => p.name), ["Другой", "мой свет"]);
  assert.equal(list[1].settings.strength, 7);
  assert.ok(Math.abs(list[0].settings.blurMul - 0.05) < 1e-12);
  assert.equal(store.savePreset("   ", a).ok, false);
  assert.equal(store.deletePreset("Другой").ok, true);
  assert.deepEqual(store.loadPresets().map((p) => p.name), ["мой свет"]);
  assert.equal(store.deletePreset("нет такого").ok, false);
  // a corrupt presets record reads as an empty list
  assert.deepEqual(Store.create({ storage: memoryStorage({ [Store.PRESETS_KEY]: "{oops" }), core }).loadPresets(), []);
});

test("settings: corrupt JSON, another schema or missing storage fall back to normalizeSettings defaults", () => {
  const defaults = core.normalizeSettings({});
  for (const raw of ["{not json", JSON.stringify({ schema: 99, settings: { strength: 5 } }), JSON.stringify("x")]) {
    const loaded = Store.create({ storage: memoryStorage({ [Store.KEY]: raw }), core }).load();
    assert.ok(loaded.error, "error reported for " + raw);
    assert.deepEqual(loaded.settings, defaults);
    assert.deepEqual(loaded.ui, Store.sanitizeUi(null));
  }
  const none = Store.create({ storage: null, core });
  assert.deepEqual(none.load().settings, defaults);
  assert.equal(none.save(defaults, {}), false);
  // out-of-range values are clamped by the core, unknown UI values dropped
  const odd = Store.create({
    storage: memoryStorage({ [Store.KEY]: JSON.stringify({ schema: 2, settings: { strength: 500 }, ui: { view: "weird", zoom: 3 } }) }),
    core,
  }).load();
  assert.equal(odd.settings.strength, 400);
  assert.equal(odd.ui.zoom, 1);
  assert.equal(odd.ui.view, "after");
});

test("diagnostics: report has versions, document, timings, read counters, raw picker answer and the error stack", () => {
  const d = Diagnostics.create({ pluginVersion: "1.0.0" });
  d.set("host", { photoshop: "26.7.0", uxp: "uxp-8.1.0", os: "darwin" });
  d.set("core", "1.0.0");
  d.set("target", {
    doc: { id: 1, title: "a.psd", width: 6000, height: 4000, modeLabel: "RGB", bitsLabel: "8 бит", profile: "sRGB IEC61966-2.1" },
    layer: { id: 3, name: "Слой", kind: "pixel", bounds: { left: 0, top: 0, right: 10, bottom: 10 }, opacity: 100, fillOpacity: 100, blendMode: "normal" },
    warnings: ["w1"],
  });
  d.set("apply", { ok: true, mode: "layer", area: { left: 0 }, timings: { read: 1200, blur: 9000, write: 15000 }, getPixelsCalls: 48, bytesRead: 192 * 1048576, putPixelsCalls: 24, bytesWritten: 96 * 1048576,
    io: { getPixelsMs: 310, getDataMs: 120, putPixelsMs: 840 }, yields: { count: 77, ms: 15 }, progressWeights: { read: 0.08, blur: 0.08, write: 0.84 } });
  d.set("colorRaw", [{ RGBFloatColor: { red: 1, grain: 0.5, blue: 0 } }]);
  const err = new Error("boom");
  d.error(err, "apply");
  const r = d.report();
  for (const part of ["Плагин: 1.0.0", "Photoshop: 26.7.0", "uxp-8.1.0", "6000×4000", "8 бит", "48 вызовов", "192.0 МБ", "blur 9000 мс", "RGBFloatColor", "boom", "Стек:",
    "getPixels 310 мс", "putPixels 840 мс", "уступок управления 77", "Веса прогресса", "\"write\":0.84"]) {
    assert.ok(r.includes(part), "report misses: " + part);
  }
});
