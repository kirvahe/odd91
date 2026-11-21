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

test("panel: show builds the preview, sliders render draft then full, apply runs end to end", async () => {
  const html = fs.readFileSync(path.join(PLUGIN, "index.html"), "utf8");
  const dom = buildDom(html);
  const fake = createFakePhotoshop({
    width: 60,
    height: 40,
    version: "27.1.0",
    layers: [{ id: 1, name: "Фон", opaque: true, pixels: { left: 0, top: 0, w: 60, h: 40, data: rgbaNoise(60, 40) } }],
  });
  const panels = {};
  const blobs = [];
  const clipboard = [];
  const logs = [];
  const storage = new Map();
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

  // nothing touches Photoshop before show
  assert.equal(typeof panels.halationPanel.show, "function");
  assert.equal(fake.log.modal.length, 0);
  assert.equal(fake.log.getPixels.length, 0);

  panels.halationPanel.show();
  const state = ctx.HalationPanel.state;
  await waitFor(() => state.proxy && dom["preview-img"].src, "preview after show");
  assert.equal(fake.log.modal[0].commandName, "Halation: предпросмотр");
  assert.ok(dom["preview-img"].classList.contains("is-hidden") === false);
  assert.ok(dom["preview-progress"].classList.contains("is-hidden"));
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
  assert.equal(dom["strength-value"].textContent, "90");
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
  const result = fake.doc.layers.find((l) => l.name === "Halation");
  assert.ok(result, "result layer created");
  assert.deepEqual(fake.doc._active, [1]);
  assert.equal(fake.log.modal.at(-1).commandName, "Halation");
  assert.equal(applyCalls, 1, "one executeAsModal call for a double click");
  assert.equal(dom["btn-apply"].textContent, "Применить");
  assert.ok(!dom["btn-apply"].hasAttribute("disabled"));

  // settings persisted as one JSON with a schema version
  await new Promise((r) => setTimeout(r, 350));
  const saved = JSON.parse(storage.get("dev.halation.photoshop/settings"));
  assert.equal(saved.schema, 1);
  assert.equal(saved.settings.strength, 90);
  assert.equal(saved.settings.mode, "curve");

  // diagnostics report
  dom["btn-copy-report"].dispatch("click");
  await waitFor(() => clipboard.length === 1, "clipboard write");
  for (const part of ["Halation — отчёт диагностики", "Photoshop: 27.1.0", "uxp-8.1.0", "60×40", "getPixels:", "Последнее применение: успешно"]) {
    assert.ok(clipboard[0].includes(part), "report misses " + part);
  }
});
