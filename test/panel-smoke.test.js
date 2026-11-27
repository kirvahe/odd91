"use strict";
// End-to-end smoke test of panel.js: the scripts from index.html run in a VM with a
// minimal fake DOM, a fake `uxp` and the fake `photoshop`. Drives show -> preview ->
// slider (draft, then full render) -> stale mark -> apply -> copy report.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createFakePhotoshop } = require("./helpers/fake-photoshop.js");
const HalationCoreNode = require("../src/core");

const ROOT = path.join(__dirname, "..");
const PLUGIN = path.join(ROOT, "src", "plugin");
const CORE_BUNDLE = path.join(ROOT, "build", "halation-core.js");

function makeElement(tag, id) {
  const listeners = {};
  const classes = new Set();
  let children = [];
  const el = {
    tagName: tag.toUpperCase(),
    id,
    style: {},
    attrs: {},
    value: "",
    checked: false,
    textContent: "",
    clientWidth: 280,
    parentNode: null,
    width: 0,
    height: 0,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    get className() { return [...classes].join(" "); },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    get innerHTML() { return ""; },
    set innerHTML(v) { if (v === "") children = []; },
    get children() { return children; },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
    removeAttribute(k) { delete el.attrs[k]; },
    hasAttribute(k) { return k in el.attrs; },
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener(t, f) { listeners[t] = (listeners[t] || []).filter((g) => g !== f); },
    dispatch(t, e = {}) { for (const f of (listeners[t] || []).slice()) f({ target: el, preventDefault() {}, ...e }); },
    appendChild(c) { children.push(c); c.parentNode = el; return c; },
    querySelectorAll(sel) { return children.filter((c) => c.tagName.toLowerCase() === sel); },
    getBoundingClientRect() { return { left: 0, top: 0, width: el.width || 280, height: el.height || 170 }; },
    getContext() { return new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => ((t[k] = v), true) }); },
    focus() {},
    select() {},
  };
  return el;
}

// Build the element tree from index.html: every element with an id, plus radios.
function buildDom(html) {
  const byId = {};
  for (const m of html.matchAll(/<([a-z][a-z0-9-]*)([^>]*)\sid="([^"]+)"([^>]*)>/g)) {
    const [, tag, a1, id, a2] = m;
    const attrs = a1 + a2;
    const el = makeElement(tag, id);
    const cls = /class="([^"]*)"/.exec(attrs);
    if (cls) el.className = cls[1];
    const val = /\svalue="([^"]*)"/.exec(attrs);
    if (val) { el.value = val[1]; el.attrs.value = val[1]; }
    if (/\schecked/.test(attrs)) el.checked = true;
    byId[id] = el;
  }
  for (const m of html.matchAll(/<sp-radio-group[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/sp-radio-group>/g)) {
    for (const r of m[2].matchAll(/<sp-radio value="([^"]+)"([^>]*)>/g)) {
      const radio = makeElement("sp-radio");
      radio.attrs.value = r[1];
      radio.checked = /checked/.test(r[2]);
      byId[m[1]].appendChild(radio);
    }
  }
  byId["curve-canvas-wrap"].appendChild(byId["curve-canvas"]);
  return byId;
}

async function waitFor(cond, what, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for " + what);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function rgbaNoise(w, h) {
  const d = new Uint8Array(w * h * 4);
  for (let i = 0; i < d.length; i += 4) {
    const v = (i * 2654435761) >>> 24;
    d[i] = v; d[i + 1] = (v * 3) & 255; d[i + 2] = (v * 7) & 255; d[i + 3] = 255;
    if (i % 97 === 0) d[i] = d[i + 1] = d[i + 2] = 255;
  }
  return d;
}

// Load index.html's scripts into a VM with a fake DOM, fake uxp and the fake photoshop.
function loadPanel(fakeOpts, initialStorage) {
  const html = fs.readFileSync(path.join(PLUGIN, "index.html"), "utf8");
  const dom = buildDom(html);
  const fake = createFakePhotoshop(fakeOpts || {
    width: 60,
    height: 40,
    version: "27.1.0",
    layers: [{ id: 1, name: "Фон", opaque: true, pixels: { left: 0, top: 0, w: 60, h: 40, data: rgbaNoise(60, 40) } }],
  });
  const panels = {};
  const blobs = [];
  const clipboard = [];
  const logs = [];
  const storage = new Map(Object.entries(initialStorage || {}));
  const ctx = {
    console: { log: (...a) => logs.push(a.join(" ")), warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    performance,
    navigator: { clipboard: { writeText: async (t) => clipboard.push(t) } },
    localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, v) },
    ImageBlob: function (data, opts) { blobs.push({ length: data.length, width: opts.width, height: opts.height }); },
    URL: { createObjectURL: () => "blob:" + blobs.length, revokeObjectURL() {} },
    require(name) {
      if (name === "photoshop") return fake.photoshop;
      if (name === "uxp") {
        return {
          entrypoints: { setup: (cfg) => Object.assign(panels, cfg.panels) },
          versions: { uxp: "uxp-8.1.0", plugin: "1.0.0" },
          host: { name: "Photoshop", version: "27.1.0", uiLocale: "ru_RU" },
        };
      }
      if (name === "os") return { platform: () => "darwin", release: () => "25.0", arch: () => "arm64" };
      throw new Error("no module " + name);
    },
  };
  ctx.window = ctx;
  ctx.document = {
    getElementById: (id) => dom[id] || null,
    createElement: (tag) => makeElement(tag),
    addEventListener() {},
    removeEventListener() {},
    body: makeElement("body"),
    theme: { getCurrent: () => "light", onUpdated: { addListener() {} } },
  };
  ctx.addEventListener = () => {};
  vm.createContext(ctx);
  const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  for (const s of scripts) {
    const file = s === "halation-core.js" ? CORE_BUNDLE : path.join(PLUGIN, s);
    vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: s });
  }
  return { dom, fake, panels, blobs, clipboard, storage, ctx };
}

test("panel: show builds the preview, sliders render draft then full, apply runs end to end", async () => {
  const { dom, fake, panels, blobs, clipboard, storage, ctx } = loadPanel();

  // nothing touches Photoshop before show
  assert.equal(typeof panels.halationPanel.show, "function");
  assert.equal(fake.log.modal.length, 0);
  assert.equal(fake.log.getPixels.length, 0);

  panels.halationPanel.show();
  const state = ctx.HalationPanel.state;
  // v1.1.2: before a document is read the blur line explains the unit without pixel numbers
  assert.equal(dom["blur-hint"].textContent, "Размытие ×1.00 считается от размера кадра, не в пикселях: при ×1 половина света ореола лежит в пределах 0,45 % длинной стороны от источника, 90 % — в пределах 1,6 %. На файлах разного размера ореол выглядит одинаково.");
  await waitFor(() => state.proxy && dom["preview-img"].src, "preview after show");
  // with a document: the size in pixels on this frame (60 px long side, ×1: r50 = 0.27 px, r90 = 0.97 px)
  assert.equal(dom["blur-hint"].textContent, "Размытие ×1.00 считается от размера кадра, не в пикселях. На этом кадре (длинная сторона 60 px) половина света ореола лежит в пределах 0,3 px от источника, 90 % — в пределах 1,0 px. На файле другого размера ореол займёт ту же долю кадра.");
  assert.equal(fake.log.modal[0].commandName, "Halation: предпросмотр");
  assert.ok(dom["preview-img"].classList.contains("is-hidden") === false);
  // v1.1.2: the progress line keeps its place and is blank when idle (no jump of the layout)
  assert.ok(!dom["preview-progress"].classList.contains("is-hidden"));
  assert.equal(dom["preview-progress"].textContent, "\u00a0");
  assert.equal(ctx.document.body.className, "theme-light");
  const fullW = blobs.at(-1).width;
  assert.equal(fullW, state.proxy.width);

  // slider moving: draft (half size) first, then the full render
  const before = blobs.length;
  dom["strength-slider"].value = 90;
  dom["strength-slider"].dispatch("input");
  await waitFor(() => blobs.length >= before + 2, "draft and full renders");
  assert.ok(blobs[before].width < fullW, "first render is the draft");
  assert.equal(blobs.at(-1).width, fullW, "then the full render");
  assert.equal(state.settings.strength, 90);
  assert.equal(dom["strength-field"].value, "90 %");
  // change right after: same settings, the full render is not repeated
  const n = blobs.length;
  dom["strength-slider"].dispatch("change");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(blobs.length, n);

  // a layer event marks the preview stale without touching Photoshop
  const modalsBefore = fake.log.modal.length;
  state.quietUntil = 0;
  fake.fire("select", { _target: [{ _ref: "layer", _id: 1 }] });
  assert.ok(!dom["preview-stale"].classList.contains("is-hidden"));
  assert.equal(fake.log.modal.length, modalsBefore);
  // v1.1.2: the journal says what the event was about and how long after the panel's own work it came
  assert.match(ctx.HalationPanel.diag.entries.at(-1), /Предпросмотр устарел: событие «select» \(layer#1\), через \d+ мс после работы панели$/);
  // and the blur line no longer claims the size is this frame's: the preview may belong to another document
  assert.match(dom["blur-hint"].textContent, /\. На кадре последнего предпросмотра \(длинная сторона 60 px\) /);

  // 8-bit -> scene-linear mode shows the limit slider; the slider maps to reinhardLimit
  dom["mode-group"].children.forEach((r, i) => { r.checked = i === 2; });
  dom["mode-group"].dispatch("change");
  assert.equal(state.settings.mode, "reinhard");
  assert.ok(!dom["reinhard-section"].classList.contains("is-hidden"));
  assert.ok(dom["curve-section"].classList.contains("is-hidden"));
  assert.equal(dom["reinhard-value"].textContent, "1.10");
  dom["reinhard-slider"].value = 0;
  dom["reinhard-slider"].dispatch("change");
  assert.ok(Math.abs(state.settings.reinhardLimit - 1.01) < 1e-9);
  assert.match(dom["reinhard-hint"].textContent, /×101/);

  // method switch: Proosa = the normalized model
  dom["method-group"].children.forEach((r, i) => { r.checked = i === 1; });
  dom["method-group"].dispatch("change");
  assert.equal(state.settings.model, "normalized");
  assert.match(dom["method-hint"].textContent, /hotgluebanjo/);
  dom["method-group"].children.forEach((r, i) => { r.checked = i === 0; });
  dom["method-group"].dispatch("change");
  assert.equal(state.settings.model, "excess");

  // curve mode shows the editor
  dom["mode-group"].children.forEach((r, i) => { r.checked = i === 1; });
  dom["mode-group"].dispatch("change");
  assert.equal(state.settings.mode, "curve");
  assert.ok(!dom["curve-section"].classList.contains("is-hidden"));
  assert.ok(dom["reinhard-section"].classList.contains("is-hidden"));

  // apply
  const realModal = fake.photoshop.core.executeAsModal;
  let applyCalls = 0;
  fake.photoshop.core.executeAsModal = (fn, o) => {
    if (o.commandName === "Halation") applyCalls++;
    return realModal(fn, o);
  };
  dom["btn-apply"].dispatch("click");
  dom["btn-apply"].dispatch("click"); // double click: must not start a second modal (review М1)
  await waitFor(() => /Готово/.test(dom.status.textContent) || /Ошибка/.test(dom.status.textContent), "apply result");
  assert.match(dom.status.textContent, /Готово/);
  const result = fake.doc.layers.find((l) => HalationCoreNode.isResultLayerName(l.name));
  assert.ok(result, "result layer created");
  assert.deepEqual(fake.doc._active, [1]);
  assert.equal(fake.log.modal.at(-1).commandName, "Halation");
  assert.equal(applyCalls, 1, "one executeAsModal call for a double click");
  assert.equal(dom["btn-apply"].textContent, "Применить");
  assert.ok(!dom["btn-apply"].hasAttribute("disabled"));

  // settings persisted as one JSON with a schema version
  await new Promise((r) => setTimeout(r, 350));
  const saved = JSON.parse(storage.get("dev.halation.photoshop/settings"));
  assert.equal(saved.schema, 2);
  assert.equal(saved.settings.strength, 90);
  assert.equal(saved.settings.mode, "curve");

  // diagnostics report
  dom["btn-copy-report"].dispatch("click");
  await waitFor(() => clipboard.length === 1, "clipboard write");
  for (const part of ["Halation — отчёт диагностики", "Photoshop: 27.1.0", "uxp-8.1.0", "60×40", "getPixels:", "Последнее применение: успешно",
    "По исполнителю: Photoshop — чтение", "Эталон скорости", "Расчёт по полосам", "История применений"]) {
    assert.ok(clipboard[0].includes(part), "report misses " + part);
  }
  await waitFor(() => dom["copy-message"].textContent, "copy message");
  assert.equal(dom["copy-message"].textContent, "Отчёт скопирован в буфер обмена (строк: " + clipboard[0].split("\n").length + "). Вставьте его в сообщение.");
  assert.ok(!dom["copy-message"].classList.contains("is-hidden"));
  assert.equal(dom["diag-fallback"].children.length, 0, "no text field when copying worked");

  // v1.1.2: «Диагностика» shows a plain-text summary of the last apply instead of a text field
  assert.equal(dom["diag-text"], undefined, "the always-visible report field is gone");
  dom["diag-toggle"].dispatch("click");
  const sum = dom["diag-summary"].children.map((c) => c.textContent);
  assert.equal(sum.length, 4);
  assert.match(sum[0], /^Последнее применение: \d+,\d с$/);
  assert.match(sum[1], /^Photoshop: чтение \d+,\d с · запись \d+,\d с · слой \d+,\d с$/);
  assert.match(sum[2], /^Расчёт плагина: /);
  assert.ok(sum.every((t, i) => dom["diag-summary"].children[i].className === "diag-line"));
  // the status line and the summary quote the same total
  const total = ctx.HalationPanel.diag.info.apply.timings.total;
  assert.ok(dom.status.textContent.includes("Готово за " + (total / 1000).toFixed(1).replace(".", ",") + " с"), dom.status.textContent);
  assert.equal(sum[0], "Последнее применение: " + (total / 1000).toFixed(1).replace(".", ",") + " с");

  // the full report as plain lines on request, long lines cut into pieces
  assert.ok(dom["diag-view"].classList.contains("is-hidden"));
  dom["btn-show-report"].dispatch("click");
  assert.ok(!dom["diag-view"].classList.contains("is-hidden"));
  assert.equal(dom["btn-show-report"].textContent, "Скрыть текст");
  const viewLines = dom["diag-view"].children.map((c) => c.textContent);
  assert.equal(viewLines[0], "Halation — отчёт диагностики");
  // cut to the block's width (280 px in the fake DOM: 43 characters), not to a fixed 96 (code review С2)
  assert.ok(viewLines.length > 40 && viewLines.every((l) => l.length <= 43), "longest " + Math.max(...viewLines.map((l) => l.length)));
  // the open view follows the journal
  ctx.HalationPanel.diag.log("строка журнала для вида");
  await waitFor(() => dom["diag-view"].children.some((c) => c.textContent.includes("строка журнала для вида")), "view refresh");
  const whole = (text) => text.split("\n").map((l) => l || " ").join("").replace(/Время: \S+/, "Время: T");
  assert.equal(dom["diag-view"].children.map((c) => c.textContent).join("").replace(/Время: \S+/, "Время: T"), whole(ctx.HalationPanel.diag.report()), "nothing lost by the wrapping");
  dom["btn-show-report"].dispatch("click");
  assert.ok(dom["diag-view"].classList.contains("is-hidden"));

  // copying failed: the report appears as plain lines and in a field created at that moment
  ctx.navigator.clipboard.writeText = async () => { throw new Error("denied"); };
  dom["btn-copy-report"].dispatch("click");
  await waitFor(() => dom["diag-fallback"].children.length === 1, "fallback field");
  const ta = dom["diag-fallback"].children[0];
  assert.equal(ta.tagName, "TEXTAREA");
  assert.equal(ta.className, "diag-text");
  assert.ok(!ta.hasAttribute("readonly"));
  assert.ok(ta.value.startsWith("Halation — отчёт диагностики") && ta.value.includes("clipboard.writeText: denied"));
  assert.ok(!dom["diag-view"].classList.contains("is-hidden"), "plain lines shown as well");
  await waitFor(() => /не вышло/.test(dom["copy-message"].textContent), "failure message");
  // and a later successful copy removes the field again
  ctx.navigator.clipboard.writeText = async (t) => clipboard.push(t);
  dom["btn-copy-report"].dispatch("click");
  await waitFor(() => clipboard.length === 2 && /скопирован/.test(dom["copy-message"].textContent), "second clipboard write");
  assert.equal(dom["diag-fallback"].children.length, 0);
});

function pickRadio(group, value) {
  group.children.forEach((r) => { r.checked = r.attrs.value === value; });
  group.dispatch("change");
}

test("panel v1.1: migration, presets, exact fields, threshold, loupe, settings from a layer, selection mask", async () => {
  const W = 400, H = 300;
  const v10 = { schema: 1, settings: { blur: 75, strength: 60, color: [255, 144, 39] }, ui: { view: "after" } };
  const { dom, fake, panels, blobs, storage, ctx } = loadPanel({
    width: W,
    height: H,
    version: "27.1.0",
    layers: [{ id: 1, name: "Фон", opaque: true, pixels: { left: 0, top: 0, w: W, h: H, data: rgbaNoise(W, H) } }],
  }, { "dev.halation.photoshop/settings": JSON.stringify(v10) });
  const core = ctx.HalationCore;
  // record the options the loupe passes to processImage
  const procOpts = [];
  const realProcess = core.processImage;
  core.processImage = (...a) => { procOpts.push(a[5]); return realProcess(...a); };
  panels.halationPanel.show();
  const state = ctx.HalationPanel.state;
  await waitFor(() => state.proxy && dom["preview-img"].src, "preview after show");

  // v1.0 settings migrated: blur 75 -> x2, strength kept, schema 2 written at once
  assert.ok(Math.abs(state.settings.blurMul - 2) < 1e-9);
  assert.equal(state.settings.strength, 60);
  assert.equal(dom["blur-field"].value, "×2.00");
  assert.equal(JSON.parse(storage.get("dev.halation.photoshop/settings")).schema, 2);

  // presets: the built-in looks are listed; load one
  const items = () => dom["preset-menu"].children;
  assert.ok(items().length >= core.LOOKS.length);
  const look = core.LOOKS[core.LOOKS.length - 1];
  const lookItem = items().find((it) => it.attrs.value === "look:" + look.id);
  dom["preset-picker"].dispatch("change", { target: lookItem });
  assert.equal(dom["preset-description"].textContent, look.description || "");
  assert.ok(dom["btn-preset-delete"].hasAttribute("disabled"), "built-in looks cannot be deleted");
  dom["btn-preset-load"].dispatch("click");
  assert.deepEqual(state.settings, core.normalizeSettings(look.settings));

  // save as a user preset, then delete it
  dom["btn-preset-save"].dispatch("click");
  assert.ok(!dom["preset-save-row"].classList.contains("is-hidden"));
  dom["preset-name"].value = "Мой свет";
  dom["btn-preset-save-ok"].dispatch("click");
  const savedPresets = JSON.parse(storage.get("dev.halation.photoshop/presets"));
  assert.deepEqual(savedPresets.presets.map((p) => p.name), ["Мой свет"]);
  assert.ok(items().some((it) => it.attrs.value === "user:Мой свет" && it.textContent === "★ Мой свет"));
  assert.ok(!dom["btn-preset-delete"].hasAttribute("disabled"));
  dom["btn-preset-delete"].dispatch("click");
  assert.deepEqual(JSON.parse(storage.get("dev.halation.photoshop/presets")).presets, []);
  assert.ok(!items().some((it) => it.attrs.value === "user:Мой свет"));

  // review v1.1 С7: a built-in look keeps the user's curve
  pickRadio(dom["mode-group"], "curve");
  const myCurve = [[100, 0.1], [200, 0.6]];
  state.editor.setPoints(myCurve);
  assert.equal(JSON.stringify(state.settings.curvePoints), JSON.stringify(myCurve));
  const cine = items().find((it) => it.attrs.value === "look:" + core.LOOKS[1].id);
  dom["preset-picker"].dispatch("change", { target: cine });
  dom["btn-preset-load"].dispatch("click");
  assert.equal(JSON.stringify(state.settings.curvePoints), JSON.stringify(myCurve), "look loaded, curve kept");
  assert.equal(state.settings.mode, core.normalizeSettings(core.LOOKS[1].settings).mode);

  // exact entry: blur multiplier and strength %, validated and clamped
  dom["blur-field"].value = "0,05";
  dom["blur-field"].dispatch("change");
  assert.ok(Math.abs(state.settings.blurMul - 0.05) < 1e-9);
  assert.equal(dom["blur-field"].value, "×0.050");
  assert.ok(Math.abs(dom["blur-slider"].value - core.blurToSlider(0.05)) < 0.06);
  dom["strength-field"].value = "500";
  dom["strength-field"].dispatch("change");
  assert.equal(state.settings.strength, 400);
  assert.equal(dom["strength-field"].value, "400 %");
  assert.match(dom["slider-message"].textContent, /ограничено/);
  dom["strength-field"].value = "abc";
  dom["strength-field"].dispatch("keydown", { key: "Enter" });
  assert.equal(dom["strength-field"].value, "400 %");
  assert.match(dom["slider-message"].textContent, /введите число/);
  // review v1.1 С5: the hint shows above 100 % only
  assert.ok(!dom["strength-hint"].classList.contains("is-hidden"), "hint at 400 %");
  dom["strength-field"].value = "100";
  dom["strength-field"].dispatch("change");
  assert.ok(dom["strength-hint"].classList.contains("is-hidden"), "no hint at 100 %");
  dom["strength-slider"].value = 101;
  dom["strength-slider"].dispatch("input");
  assert.ok(!dom["strength-hint"].classList.contains("is-hidden"), "hint at 101 %");

  // threshold and softness
  dom["threshold-slider"].value = 128;
  dom["threshold-slider"].dispatch("change");
  dom["softness-field"].value = "20";
  dom["softness-field"].dispatch("change");
  assert.equal(state.settings.threshold, 128);
  assert.equal(state.settings.softness, 20);
  assert.equal(dom["threshold-field"].value, "128");

  // loupe: a click on the thumbnail opens a 1:1 region there, read once
  await new Promise((r) => setTimeout(r, 60));
  const readsBefore = fake.log.modal.filter((m) => m.commandName === "Halation: лупа").length;
  const img = dom["preview-img"];
  dom["preview-img"].dispatch("click", { clientX: img.width * 0.5, clientY: img.height * 0.5 });
  assert.equal(state.ui.previewMode, "loupe");
  assert.ok(!dom["zoom-group"].classList.contains("is-hidden"));
  await waitFor(() => fake.log.modal.filter((m) => m.commandName === "Halation: лупа").length === readsBefore + 1 && blobs.at(-1).width === 278, "loupe ×1");
  assert.equal(blobs.at(-1).height, 278);
  assert.match(dom["preview-source"].textContent, /Лупа ×1/);
  assert.ok(Math.abs(state.loupe.center.x - W / 2) <= 1 && Math.abs(state.loupe.center.y - H / 2) <= 1);

  // a setting change re-renders from the cache: no new read
  const nBlobs = blobs.length;
  dom["strength-slider"].value = 150;
  dom["strength-slider"].dispatch("change");
  await waitFor(() => blobs.length > nBlobs, "loupe re-render");
  assert.equal(fake.log.modal.filter((m) => m.commandName === "Halation: лупа").length, readsBefore + 1);

  // ×2 shows half the region, twice as large: still from the cache
  // the loupe computes at the apply's base level, from a read aligned to the block grid
  const loupeOpts = procOpts.filter((o) => o && o.originX !== undefined).at(-1);
  assert.equal(loupeOpts.baseLevel, core.baseLevelFor(W, H));
  const loupeRead = fake.log.getPixels.at(-1);
  assert.equal(loupeRead.sourceBounds.left % 64, 0);
  assert.equal(loupeRead.sourceBounds.top % 64, 0);
  pickRadio(dom["zoom-group"], "2");
  await waitFor(() => blobs.at(-1).width === 278 && state.ui.zoom === 2, "loupe ×2");
  assert.match(dom["preview-source"].textContent, /Лупа ×2/);
  assert.equal(fake.log.modal.filter((m) => m.commandName === "Halation: лупа").length, readsBefore + 1);

  // ½: twice the area at one image pixel per document pixel, shown at half size
  pickRadio(dom["zoom-group"], "0.5");
  await waitFor(() => blobs.at(-1).width === W && state.ui.zoom === 0.5, "loupe ½");
  assert.equal(dom["preview-img"].width, W / 2);
  assert.match(dom["preview-source"].textContent, /Лупа ½/);
  pickRadio(dom["zoom-group"], "1");
  await waitFor(() => blobs.at(-1).width === 278, "loupe ×1 again");

  // back to the frame: the loupe area is outlined on the thumbnail
  pickRadio(dom["preview-mode-group"], "frame");
  await waitFor(() => blobs.at(-1).width === state.proxy.width, "frame again");
  assert.ok(!dom["loupe-frame"].classList.contains("is-hidden"));
  assert.ok(parseInt(dom["loupe-frame"].style.width, 10) > 0);

  // apply with a selection: the checkbox appears (on) and the result gets a mask
  fake.doc._selection = { left: 10, top: 10, right: 200, bottom: 150 };
  state.quietUntil = 0;
  fake.fire("set", { _target: [{ _ref: "channel", _property: "selection" }] });
  await waitFor(() => !dom["mask-checkbox"].classList.contains("is-hidden"), "mask checkbox");
  assert.equal(dom["mask-checkbox"].checked, true);
  dom["btn-apply"].dispatch("click");
  await waitFor(() => /Готово|Ошибка/.test(dom.status.textContent), "apply result");
  assert.match(dom.status.textContent, /Маска слоя — по выделению/);
  assert.equal(fake.log.putLayerMask.length, 1);
  const result = fake.doc.layers.find((l) => core.isResultLayerName(l.name));
  assert.ok(result && result._mask);

  // the result layer's name carries the settings: «Взять настройки из слоя»
  const applied = JSON.parse(JSON.stringify(state.settings));
  dom["strength-field"].value = "5";
  dom["strength-field"].dispatch("change");
  assert.equal(state.settings.strength, 5);
  fake.doc._active = [result.id];
  state.quietUntil = 0;
  fake.fire("select", { _target: [{ _ref: "layer", _id: result.id }] });
  await waitFor(() => !dom["from-layer-row"].classList.contains("is-hidden"), "settings-from-layer button");
  dom["btn-from-layer"].dispatch("click");
  assert.equal(state.settings.strength, applied.strength);
  assert.equal(state.settings.threshold, 128);
  assert.match(dom["preset-message"].textContent, /слой/);
  assert.equal(JSON.stringify(state.settings.curvePoints), JSON.stringify(myCurve), "settings from a non-curve layer keep the curve");

  // review v1.1 М5: a blocking check drops the loupe's plan and pixels
  fake.doc.bitsPerChannel = "bitDepth16";
  dom["btn-refresh"].dispatch("click");
  await waitFor(() => /8 бит/.test(dom["preview-placeholder"].textContent), "blocking message");
  assert.equal(state.previewPlan, null);
  assert.equal(state.loupe.raw, null);
});
