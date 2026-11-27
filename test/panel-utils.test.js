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
  for (const part of ["Плагин: 1.0.0", "Photoshop: 26.7.0", "uxp-8.1.0", "6000×4000", "8 бит", "48 вызовов", "192.0 МБ", "размытие с паузами (blur) 9000 мс", "проход 2 (write) 15.0 с", "RGBFloatColor", "boom", "Стек:",
    "getPixels 310 мс", "putPixels 840 мс", "уступок управления 77", "Веса прогресса", "\"write\":0.84"]) {
    assert.ok(r.includes(part), "report misses: " + part);
  }
});

// v1.1.2 (Ilya: "why does write take 7 s?"): the `write` stage is the whole second pass. The report
// and the short summary say who spent the time: Photoshop (read, write, layer) or the plugin.
function applyStats(over) {
  return Object.assign({
    kind: "apply", ok: true, mode: "layer", area: { left: 0 },
    timings: { preflight: 58, read: 1464, blur: 2009, layer: 416, write: 7272, total: 11200 },
    getPixelsCalls: 52, bytesRead: 156.6 * 1048576, putPixelsCalls: 26, bytesWritten: 74.3 * 1048576,
    io: { getPixelsMs: 554, getDataMs: 1308, putPixelsMs: 1083, createMs: 40 },
    passIo: [{ ms: 857, bytes: 74.3 * 1048576 }, { ms: 1005, bytes: 82.3 * 1048576 }],
    yields: { count: 66, ms: 25 },
    stripMs: { pass1: { first: 60, median: 22, max: 61 }, pass2: { first: 190, median: 188, max: 240 } },
    probe: { before: { first: 16.8, min: 4.8, sum: 372855, ms: 29 }, after: { first: 5.1, min: 4.7, sum: 372855, ms: 15 } },
    memory: { before: 6 * 1073741824, after: 5.5 * 1073741824 },
    coreStats: { timings: { pass1: 607, blur: 1900, pass2: 4991, fine: 2226 }, fineTiles: { total: 1000, computed: 380 } },
  }, over || {});
}

test("diagnostics v1.1.2: the apply time is split by who did the work, parts add up to the total", () => {
  const p = Diagnostics.applyParts(applyStats());
  assert.equal(p.psRead, 1862);
  assert.equal(p.psWrite, 1123);
  assert.equal(p.layer, 416);
  assert.equal(p.core, 607 + 1900 + 4991);
  assert.equal(p.probe, 44);
  // the mask and the selection read belong to «слой»
  assert.equal(Diagnostics.applyParts(applyStats({ timings: { layer: 416, mask: 30, selection: 12, total: 11200 } })).layer, 458);
  assert.ok(Math.abs(p.psRead + p.psWrite + p.layer + p.core + p.other - p.total) < 1e-6, "parts add up");
  // stats of v1.1.1 (no per-pass reads): the totals are used
  const old = applyStats();
  delete old.passIo;
  assert.equal(Diagnostics.applyParts(old).psRead, 554 + 1308);
  assert.equal(Diagnostics.applyParts({ ok: false }), null);
  // parts measured longer than the total never give a negative remainder
  assert.equal(Diagnostics.applyParts(applyStats({ timings: { total: 100 } })).other, 0);
});

test("diagnostics v1.1.2: the panel summary is four plain lines; before any apply it says so", () => {
  const d = Diagnostics.create({ pluginVersion: "1.1.2" });
  assert.deepEqual(d.summary(), ["Применений ещё не было."]);
  d.set("apply", applyStats());
  assert.deepEqual(d.summary(), [
    "Последнее применение: 11,2 с",
    "Photoshop: чтение 1,9 с · запись 1,1 с · слой 0,4 с",
    "Расчёт плагина: 7,5 с (сетка 0,6 с · размытие 1,9 с · ореол 5,0 с)",
    "Прочее: 0,3 с",
  ]);
  d.set("apply", { ok: false, cancelled: true, timings: { read: 300, total: 320 }, io: { getPixelsMs: 100, getDataMs: 50, putPixelsMs: 0 } });
  assert.match(d.summary()[0], /^Последнее применение \(отменено\): 0,3 с$/);
  d.set("apply", { ok: false, error: "boom" });
  assert.deepEqual(d.summary(), ["Последнее применение (ошибка): нет данных о времени."]);
});

test("diagnostics v1.1.2: report lines for stages, read speed, strips, speed probe, memory, tiles and the history", () => {
  const d = Diagnostics.create({ pluginVersion: "1.1.2" });
  d.set("apply", applyStats());
  d.set("apply", applyStats({ timings: { read: 500, blur: 700, layer: 90, write: 4000, total: 5400 } }));
  const r = d.report();
  for (const part of [
    "Этапы: проход 1 (read) 500 мс, размытие с паузами (blur) 700 мс, слой (layer) 90 мс, проход 2 (write) 4000 мс, всего (total) 5400 мс",
    "По исполнителю: Photoshop — чтение 1862 мс (проход 1: 857 мс, повторное в проходе 2: 1005 мс), запись 1123 мс",
    "расчёт плагина — сетка 607 мс, размытие 1900 мс, ореол 4991 мс",
    "создание ImageData 40 мс",
    "Скорость чтения: проход 1 — 74.3 МБ за 857 мс (11.5 мс/МБ); проход 2 — 82.3 МБ за 1005 мс (12.2 мс/МБ); запись — 15.1 мс/МБ",
    "Расчёт по полосам, мс: проход 1 — первая 60, медиана 22, макс 61; проход 2 — первая 190, медиана 188, макс 240",
    "Эталон скорости (одна и та же работа до и после применения): до — первый 16.8, лучший 4.8 мс; после — первый 5.1, лучший 4.7 мс; сумма 372855",
    "Свободная память: до 6.0 ГБ, после 5.5 ГБ",
    "Мелкое размытие: посчитано 38 % плиток (380 из 1000)",
    "История применений",
  ]) assert.ok(r.includes(part), "report misses: " + part + "\n" + r);
  const hist = r.split("\n").filter((l) => /^ {2}\[\d\d:\d\d:\d\d\.\d{3}\] всего /.test(l));
  assert.equal(hist.length, 2, "one history line per apply");
  assert.match(hist[0], /\] всего 11\.2 с: проход 1 1464, размытие с паузами 2009, слой 416, проход 2 7272 мс; ядро 607\/1900\/4991; эталон 4\.8\/4\.7$/);
  assert.ok(r.includes("проверка (preflight)") === false, "the second apply had no preflight time");
  // the stage line says that the check before the apply is not part of the total
  const d3 = Diagnostics.create({ pluginVersion: "1.1.2" });
  d3.set("apply", applyStats());
  assert.ok(d3.report().includes("ореол 4991 мс; прочее 301 мс (из них эталон скорости 44 мс)"));
  assert.ok(d3.report().includes("Этапы: проверка (preflight) 58 мс, проход 1 (read) 1464 мс, размытие с паузами (blur) 2009 мс, слой (layer) 416 мс, проход 2 (write) 7272 мс, всего (total) 11.2 с (проверка во «всего» не входит)"));
  // a cancelled apply is «отменено», a failed one «ошибка»; no empty stage list after a cancel in pass 1
  d3.set("apply", { ok: false, cancelled: true, timings: { read: 30, total: 30 } });
  d3.set("apply", { ok: false, error: "x", timings: { total: 12 } });
  const h3 = d3.report().split("\n").filter((l) => /^ {2}\[\d\d:\d\d:\d\d\.\d{3}\] /.test(l) && /всего/.test(l));
  assert.match(h3[1], /\] отменено, всего 30 мс: проход 1 30 мс$/);
  assert.match(h3[2], /\] ошибка, всего 12 мс$/);
  // at most five lines are kept; a preview or loupe run adds none
  for (let i = 0; i < 7; i++) d.set("apply", applyStats());
  d.set("preview", { ok: true, timings: { read: 10, total: 12 } });
  assert.equal(d.report().split("\n").filter((l) => /^ {2}\[\d\d:\d\d:\d\d\.\d{3}\] всего /.test(l)).length, 5);
  // a preview block has no breakdown by performer
  const d2 = Diagnostics.create({ pluginVersion: "1.1.2" });
  d2.set("preview", { ok: true, timings: { read: 10, finish: 2, total: 12 }, passIo: [{ ms: 1, bytes: 0.2 * 1048576 }, { ms: 0, bytes: 0 }] });
  const r2 = d2.report();
  assert.ok(r2.includes("проход 1 (read) 10 мс, сборка (finish) 2 мс"));
  assert.ok(!r2.includes("По исполнителю") && !r2.includes("История применений"));
  // one read only: no «проход 2 — 0 МБ» (code review v1.1.2 М7)
  assert.ok(r2.includes("  Скорость чтения: 0.2 МБ за 1 мс (5.0 мс/МБ)") && !r2.includes("проход 2 —"), r2);
});
