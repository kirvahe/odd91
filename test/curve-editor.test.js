"use strict";
// Curve editor logic with a fake canvas (no DOM): add, drag, double-click removal,
// field edits, multiply, validation, and only UXP-safe canvas calls.

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../src/core");
const CurveEditor = require("../src/plugin/curve-editor.js");

const FORBIDDEN = new Set([
  "clearRect", "fillText", "strokeText", "drawImage", "putImageData", "getImageData",
  "createLinearGradient", "createRadialGradient", "setLineDash", "save", "restore",
  "translate", "scale", "rotate", "setTransform", "transform",
]);

function fakeCanvas({ capture = true } = {}) {
  const calls = [];
  const store = {};
  const ctx = new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      return (...args) => calls.push([k, ...args]);
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
  });
  const listeners = {};
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    parentNode: { clientWidth: 300 },
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }),
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener(t, f) { listeners[t] = (listeners[t] || []).filter((g) => g !== f); },
    dispatch(t, e) { for (const f of (listeners[t] || []).slice()) f(e); },
  };
  if (capture) {
    canvas.setPointerCapture = (id) => { canvas.captured = id; };
    canvas.releasePointerCapture = () => { canvas.captured = null; };
  }
  return { canvas, calls };
}

function fakeField() {
  const l = {};
  return {
    value: "",
    disabled: false,
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(t, f) { (l[t] = l[t] || []).push(f); },
    removeEventListener() {},
    fire(t, e = {}) { for (const f of l[t] || []) f(e); },
  };
}

// plot geometry for a 300x170 canvas, padding 7, dpr 1
const px = (code) => 7 + (code / 255) * 286;
const py = (y) => 163 - y * 156;

function setup(extra = {}) {
  const { canvas, calls } = fakeCanvas(extra);
  const events = [];
  const xField = fakeField();
  const yField = fakeField();
  const ed = new CurveEditor({
    canvas,
    core,
    devicePixelRatio: 1,
    requestFrame: (cb) => cb(), // deterministic: draw at once
    height: 170,
    xField,
    yField,
    onChange: (p, info) => events.push(["change", info.source, info.final, p.length]),
    onReject: (r) => events.push(["reject", r]),
    onSelect: (i) => events.push(["select", i]),
  });
  let t = 0;
  const pointer = (type, code, y, dt = 600) => {
    t += dt;
    canvas.dispatch(type, { clientX: px(code), clientY: py(y), pointerId: 1, button: 0, preventDefault() {}, timeStamp: t });
  };
  return { ed, canvas, calls, events, xField, yField, pointer };
}

test("curve editor: draws with UXP-safe calls only and clears with fillRect", () => {
  const { ed, calls } = setup();
  ed.setYAxis("log");
  ed.setYAxis("linear");
  const used = new Set(calls.map((c) => c[0]));
  for (const f of used) assert.ok(!FORBIDDEN.has(f), "forbidden canvas call " + f);
  assert.equal(calls.find((c) => c[0] === "fillRect")[1], 0, "first fillRect clears from 0,0");
  assert.ok(used.has("arc") && used.has("lineTo") && used.has("stroke"));
});

test("curve editor: click adds a point, drag moves it within its neighbours, double-click removes it", async () => {
  const { ed, events, pointer, canvas } = setup();
  const n0 = ed.getPoints().length;
  assert.equal(n0, core.defaultCurvePoints().length);

  pointer("pointerdown", 118, 0.18);
  assert.equal(ed.getPoints().length, n0 + 1);
  const idx = ed.selected;
  assert.equal(ed.getPoints()[idx][0], 118);
  assert.ok(Math.abs(ed.getPoints()[idx][1] - 0.18) < 0.01);
  assert.equal(canvas.captured, 1, "pointer captured");

  pointer("pointermove", 125, 0.2, 10);
  assert.equal(ed.getPoints()[idx][0], 125);
  pointer("pointermove", 200, 0.2, 10); // past the next neighbour (140): clamped to 139
  assert.equal(ed.getPoints()[idx][0], 139);
  pointer("pointerup", 139, 0.2, 10);
  assert.deepEqual(events.filter((e) => e[0] === "change").at(-1), ["change", "drag-end", true, n0 + 1]);
  assert.ok(core.validateCurve(ed.getPoints()).ok);

  // double-click on the point removes it
  const p = ed.getPoints()[idx];
  pointer("pointerdown", p[0], p[1], 1000);
  pointer("pointerup", p[0], p[1], 50);
  pointer("pointerdown", p[0], p[1], 100);
  assert.equal(ed.getPoints().length, n0);
  assert.equal(ed.selected, -1);
});

test("curve editor: rejects points on the fixed ends, a 13th point and invalid field values", () => {
  const { ed, events, pointer, xField, yField } = setup();
  pointer("pointerdown", 0, 0.5);
  assert.match(events.at(-1)[1], /Концы кривой закреплены/);

  // fill up to 12 interior points, then one more is refused
  for (const code of [80, 160]) pointer("pointerdown", code, core.curveSamples(ed.getPoints(), 256)[code]), pointer("pointerup", code, 0, 10);
  assert.equal(ed.getPoints().length, 12);
  pointer("pointerdown", 210, core.curveSamples(ed.getPoints(), 256)[210]);
  assert.match(events.at(-1)[1], /12/);
  assert.equal(ed.getPoints().length, 12);

  // fields: select a point and edit it
  ed.select(5);
  const [x5, y5] = ed.getPoints()[5];
  assert.equal(xField.value, String(x5));
  assert.equal(yField.value, CurveEditor.formatY(y5));
  yField.value = "abc";
  yField.fire("change");
  assert.match(events.at(-1)[1], /Y —/);
  assert.equal(yField.value, CurveEditor.formatY(y5), "field restored after a rejected edit");
  const [, prevY] = ed.getPoints()[4];
  const mid = (prevY + y5) / 2;
  yField.value = String(mid).replace(".", ",");
  yField.fire("change");
  assert.ok(Math.abs(ed.getPoints()[5][1] - mid) < 1e-12, "comma decimal accepted");
  xField.value = "250";
  xField.fire("keydown", { key: "Enter" });
  assert.match(events.at(-1)[1], /не меняются местами/);
  assert.equal(ed.getPoints()[5][0], x5);
});

test("curve editor: multiply interior points by k, with rejection when a point would reach 1", () => {
  const { ed, events } = setup();
  const before = ed.getPoints();
  assert.ok(ed.multiplyInterior(0.25).ok);
  ed.getPoints().forEach((p, i) => assert.ok(Math.abs(p[1] - before[i][1] * 0.25) < 1e-12));
  const mid = ed.getPoints();
  assert.equal(ed.multiplyInterior(10).ok, false);
  assert.deepEqual(ed.getPoints(), mid, "unchanged after a rejected multiply");
  assert.equal(ed.multiplyInterior(-1).ok, false);
  assert.equal(events.filter((e) => e[0] === "reject").length, 2);
  ed.reset();
  assert.deepEqual(ed.getPoints(), core.validateCurve(core.defaultCurvePoints()).points);
});

test("curve editor: falls back to document listeners without setPointerCapture", () => {
  const docListeners = {};
  global.document = {
    addEventListener(t, f) { (docListeners[t] = docListeners[t] || []).push(f); },
    removeEventListener(t, f) { docListeners[t] = (docListeners[t] || []).filter((g) => g !== f); },
  };
  try {
    const { ed, canvas } = setup({ capture: false });
    canvas.dispatch("pointerdown", { clientX: px(118), clientY: py(0.18), pointerId: 1, button: 0, preventDefault() {} });
    const idx = ed.selected;
    assert.ok(docListeners.pointermove && docListeners.pointermove.length === 1);
    docListeners.pointermove[0]({ clientX: px(122), clientY: py(0.19), pointerId: 1, preventDefault() {} });
    assert.equal(ed.getPoints()[idx][0], 122);
    docListeners.pointerup[0]({ clientX: px(122), clientY: py(0.19), pointerId: 1 });
    assert.equal(docListeners.pointermove.length, 0, "listeners removed after the drag");
  } finally {
    delete global.document;
  }
});

test("curve editor: core reason codes are shown in Russian", () => {
  assert.match(CurveEditor.reasonText("not-increasing"), /возрастать/);
  assert.match(CurveEditor.reasonText("x-too-close"), /1 код/);
  assert.equal(CurveEditor.reasonText("Своя причина"), "Своя причина");
});

test("curve editor (v1.1 flicker fix): same-size resize does not clear the canvas; renders coalesce per frame", () => {
  const { canvas, calls } = fakeCanvas();
  let widthSets = 0;
  let w = 0;
  Object.defineProperty(canvas, "width", {
    get: () => w,
    set: (v) => { widthSets++; w = v; },
  });
  const frames = [];
  const ed = new CurveEditor({ canvas, core, devicePixelRatio: 1, height: 170, requestFrame: (cb) => frames.push(cb) });
  assert.equal(widthSets, 1, "sized once on creation");
  assert.equal(ed.resize(), false, "same size: nothing to do");
  assert.equal(ed.resize(300.6, 170.2), false, "same integer size");
  assert.equal(widthSets, 1, "canvas.width not reassigned (that would clear it)");
  assert.equal(ed.resize(320), true);
  assert.equal(widthSets, 2);

  const clears = () => calls.filter((c) => c[0] === "fillRect" && c[1] === 0 && c[2] === 0).length;
  const before = clears();
  frames.length = 0;
  ed.render();
  ed.render();
  ed.setYAxis("log"); // also renders
  assert.equal(frames.length, 1, "one frame requested for three render calls");
  assert.equal(clears(), before, "nothing drawn before the frame");
  frames[0]();
  assert.equal(clears(), before + 1, "drawn once");
  ed.render();
  assert.equal(frames.length, 2, "a new frame after the previous one ran");
});

test("curve editor (review v1.1 М4): a dropped frame still draws; resize() draws at once", async () => {
  const { canvas, calls } = fakeCanvas();
  const clears = () => calls.filter((c) => c[0] === "fillRect" && c[1] === 0 && c[2] === 0).length;
  const ed = new CurveEditor({ canvas, core, devicePixelRatio: 1, height: 170, requestFrame: () => {} }); // frames never come
  const c0 = clears();
  assert.equal(ed.resize(), false, "same size");
  assert.equal(clears(), c0 + 1, "drawn synchronously anyway");
  ed.render();
  ed.render();
  assert.equal(clears(), c0 + 1, "queued, not drawn yet");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(clears(), c0 + 2, "the timeout drew the dropped frame once");
  ed.render(); // queues again after the fallback ran
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(clears(), c0 + 3);
});
