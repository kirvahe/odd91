"use strict";
// Fake `photoshop` module for the bridge tests.
//
// - Layers are stored as full-document RGBA canvases.
// - imaging.getPixels trims transparent margins of the requested bounds, like
//   Photoshop, and returns 3 components for opaque layers.
// - executeAsModal snapshots the document and rolls it back when the callback
//   throws; reportProgress can trigger cancellation; calls after cancellation throw.
// - Every PhotoshopImageData is tracked so the tests can check dispose().

const constants = {
  ElementPlacement: { PLACEBEFORE: "placeBefore", PLACEAFTER: "placeAfter", PLACEINSIDE: "placeInside" },
  LayerKind: { NORMAL: "pixel", SMARTOBJECT: "smartObject", TEXT: "text", GROUP: "group" },
  DocumentMode: { RGB: "RGBColorMode", CMYK: "CMYKColorMode" },
  BitsPerChannelType: { EIGHT: "bitDepth8", SIXTEEN: "bitDepth16" },
  BlendMode: { NORMAL: "normal", SCREEN: "screen" },
};

function createFakePhotoshop(opts = {}) {
  const W = opts.width || 64;
  const H = opts.height || 48;
  const profile = opts.profile === undefined ? "sRGB IEC61966-2.1" : opts.profile;
  const emptyMode = opts.emptyMode || "null"; // how an all-transparent request is answered: null | throw | zero
  const log = {
    getPixels: [],
    putPixels: [],
    imageDatas: [],
    created: [],
    deleted: [],
    moves: [],
    batchPlay: [],
    modal: [],
    progress: [],
    suspend: [],
    resume: [],
    rollbacks: 0,
    commits: 0,
  };
  const modal = { active: false, cancelled: false };
  let nextId = 100;
  let putCount = 0;
  const listeners = [];

  function guard(what) {
    if (modal.cancelled) throw new Error(`${what}: the operation was cancelled by the user`);
  }

  function bbox(store, rect) {
    const r = rect || { left: 0, top: 0, right: W, bottom: H };
    let l = Infinity, t = Infinity, rr = -Infinity, b = -Infinity;
    for (let y = r.top; y < r.bottom; y++) {
      for (let x = r.left; x < r.right; x++) {
        if (store[(y * W + x) * 4 + 3] > 0) {
          if (x < l) l = x;
          if (x > rr) rr = x;
          if (y < t) t = y;
          if (y > b) b = y;
        }
      }
    }
    if (l === Infinity) return null;
    return { left: l, top: t, right: rr + 1, bottom: b + 1 };
  }

  function makeLayer(spec) {
    const layer = {
      id: spec.id !== undefined ? spec.id : nextId++,
      name: spec.name || "Layer",
      kind: spec.kind || "pixel",
      opacity: spec.opacity !== undefined ? spec.opacity : 100,
      fillOpacity: spec.fillOpacity !== undefined ? spec.fillOpacity : 100,
      blendMode: spec.blendMode || "normal",
      isClippingMask: !!spec.isClippingMask,
      isBackgroundLayer: !!spec.isBackground,
      visible: true,
      _opaque: !!spec.opaque,
      _hasUserMask: !!spec.hasUserMask,
      _store: new Uint8Array(W * H * 4),
    };
    if (spec.pixels) {
      const p = spec.pixels; // { left, top, w, h, data: RGBA }
      for (let y = 0; y < p.h; y++) {
        for (let x = 0; x < p.w; x++) {
          const dx = p.left + x, dy = p.top + y;
          if (dx < 0 || dy < 0 || dx >= W || dy >= H) continue;
          const s = (y * p.w + x) * 4, d = (dy * W + dx) * 4;
          layer._store[d] = p.data[s];
          layer._store[d + 1] = p.data[s + 1];
          layer._store[d + 2] = p.data[s + 2];
          layer._store[d + 3] = p.data[s + 3];
        }
      }
    }
    Object.defineProperty(layer, "boundsNoEffects", {
      get() {
        return bbox(layer._store) || { left: 0, top: 0, right: 0, bottom: 0 };
      },
    });
    Object.defineProperty(layer, "bounds", { get() { return layer.boundsNoEffects; } });
    layer.move = async (rel, placement) => {
      guard("move");
      if (!modal.active) throw new Error("move requires a modal scope");
      log.moves.push({ id: layer.id, rel: rel.id, placement });
      const from = doc.layers.indexOf(layer);
      if (from >= 0) doc.layers.splice(from, 1);
      const to = doc.layers.indexOf(rel);
      if (to < 0) throw new Error("relative layer not found");
      doc.layers.splice(placement === constants.ElementPlacement.PLACEBEFORE ? to : to + 1, 0, layer);
    };
    layer.delete = async () => {
      guard("delete");
      if (!modal.active) throw new Error("delete requires a modal scope");
      log.deleted.push(layer.id);
      const i = doc.layers.indexOf(layer);
      if (i >= 0) doc.layers.splice(i, 1);
      doc._active = doc._active.filter((id) => id !== layer.id);
    };
    return layer;
  }

  const doc = {
    id: 1,
    title: "test.psd",
    width: W,
    height: H,
    resolution: 72,
    mode: opts.mode || constants.DocumentMode.RGB,
    bitsPerChannel: opts.bits || constants.BitsPerChannelType.EIGHT,
    colorProfileName: profile,
    layers: [], // top first
    _active: [],
  };
  Object.defineProperty(doc, "activeLayers", {
    get() {
      return doc._active.map((id) => doc.layers.find((l) => l.id === id)).filter(Boolean);
    },
  });
  doc.createPixelLayer = async ({ name }) => {
    guard("createPixelLayer");
    if (!modal.active) throw new Error("createPixelLayer requires a modal scope");
    const layer = makeLayer({ name, kind: "pixel" });
    const active = doc.activeLayers[0];
    const at = active ? doc.layers.indexOf(active) : 0;
    doc.layers.splice(Math.max(0, at), 0, layer);
    doc._active = [layer.id];
    log.created.push(layer.id);
    return layer;
  };

  for (const spec of opts.layers || []) doc.layers.push(makeLayer(spec));
  if (opts.activeId !== undefined) doc._active = [opts.activeId];
  else if (doc.layers.length) doc._active = [doc.layers[0].id];

  function findLayer(id) {
    return doc.layers.find((l) => l.id === id) || null;
  }

  function composite() {
    const out = new Uint8Array(W * H * 4);
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i];
      if (!l.visible) continue;
      const s = l._store;
      for (let p = 0; p < W * H * 4; p += 4) {
        const a = s[p + 3] / 255;
        if (a === 0) continue;
        const ba = out[p + 3] / 255;
        const oa = a + ba * (1 - a);
        for (let c = 0; c < 3; c++) out[p + c] = Math.round((s[p + c] * a + out[p + c] * ba * (1 - a)) / oa);
        out[p + 3] = Math.round(oa * 255);
      }
    }
    return out;
  }

  function makeImageData(w, h, comps, data) {
    const img = {
      width: w,
      height: h,
      components: comps,
      componentSize: 8,
      colorSpace: "RGB",
      colorProfile: profile,
      hasAlpha: comps === 4,
      _disposed: false,
      async getData() {
        if (img._disposed) throw new Error("getData after dispose");
        if (opts.failGetData) throw new Error("getData failed (injected)");
        return data.slice();
      },
      dispose() {
        img._disposed = true;
      },
    };
    log.imageDatas.push(img);
    return img;
  }

  const imaging = {
    async getPixels(o) {
      guard("getPixels");
      log.getPixels.push(JSON.parse(JSON.stringify(o)));
      const docR = { left: 0, top: 0, right: W, bottom: H };
      const sb = o.sourceBounds || docR;
      const req = {
        left: Math.max(0, sb.left),
        top: Math.max(0, sb.top),
        right: Math.min(W, sb.right),
        bottom: Math.min(H, sb.bottom),
      };
      let store, opaque;
      if (o.layerID !== undefined) {
        const l = findLayer(o.layerID);
        if (!l) throw new Error("getPixels: no such layer " + o.layerID);
        store = l._store;
        opaque = l._opaque;
      } else {
        store = composite();
        opaque = !!opts.compositeOpaque;
      }
      const tb = opaque ? req : bbox(store, req);
      if (!tb) {
        if (emptyMode === "throw") throw new Error("Could not get pixels: the requested area is empty");
        if (emptyMode === "zero") {
          return {
            imageData: makeImageData(0, 0, 4, new Uint8Array(0)),
            sourceBounds: { left: req.left, top: req.top, right: req.left, bottom: req.top },
            level: 0,
          };
        }
        return { imageData: null, sourceBounds: { left: req.left, top: req.top, right: req.left, bottom: req.top }, level: 0 };
      }
      const comps = opaque ? 3 : 4;
      const w = tb.right - tb.left, h = tb.bottom - tb.top;
      const data = new Uint8Array(w * h * comps);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const s = ((tb.top + y) * W + tb.left + x) * 4, d = (y * w + x) * comps;
          data[d] = store[s];
          data[d + 1] = store[s + 1];
          data[d + 2] = store[s + 2];
          if (comps === 4) data[d + 3] = store[s + 3];
        }
      }
      return { imageData: makeImageData(w, h, comps, data), sourceBounds: { ...tb }, level: 0 };
    },

    async createImageDataFromBuffer(buf, o) {
      guard("createImageDataFromBuffer");
      if (buf.length !== o.width * o.height * o.components) {
        throw new Error(`buffer has ${buf.length} elements, expected ${o.width}x${o.height}x${o.components}`);
      }
      // Strict: a standalone buffer of exactly that size (the bridge guarantees it).
      if (buf.byteOffset !== 0 || buf.buffer.byteLength !== buf.byteLength) {
        throw new Error("buffer is a view into a larger ArrayBuffer");
      }
      const img = makeImageData(o.width, o.height, o.components, buf.slice());
      img.colorProfile = o.colorProfile;
      img._fromBuffer = true;
      return img;
    },

    async putPixels(o) {
      guard("putPixels");
      if (!modal.active) throw new Error("putPixels requires a modal scope");
      putCount++;
      if (opts.failPutPixelsAt === putCount) throw new Error("putPixels failed (injected)");
      const l = findLayer(o.layerID);
      if (!l) throw new Error("putPixels: no such layer");
      if (l.kind !== "pixel") throw new Error("putPixels: target is not a pixel layer");
      const img = o.imageData;
      if (img._disposed) throw new Error("putPixels: imageData already disposed");
      const data = await img.getData();
      const tb = o.targetBounds || { left: 0, top: 0 };
      log.putPixels.push({ layerID: o.layerID, targetBounds: { ...tb }, width: img.width, height: img.height, components: img.components, colorProfile: img.colorProfile });
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          const dx = tb.left + x, dy = tb.top + y;
          if (dx < 0 || dy < 0 || dx >= W || dy >= H) throw new Error("putPixels outside the document");
          const s = (y * img.width + x) * img.components, d = (dy * W + dx) * 4;
          l._store[d] = data[s];
          l._store[d + 1] = data[s + 1];
          l._store[d + 2] = data[s + 2];
          l._store[d + 3] = img.components === 4 ? data[s + 3] : 255;
        }
      }
    },

    async encodeImageData() {
      return "QkFTRTY0";
    },
  };

  function snapshot() {
    return {
      order: doc.layers.slice(),
      stores: new Map(doc.layers.map((l) => [l, l._store.slice()])),
      active: doc._active.slice(),
    };
  }

  function restore(s) {
    doc.layers.length = 0;
    for (const l of s.order) {
      l._store = s.stores.get(l);
      doc.layers.push(l);
    }
    doc._active = s.active;
  }

  const psCore = {
    async executeAsModal(fn, options) {
      if (opts.modalBusy) throw new Error("Photoshop is in a modal state: plugin “Other” is busy");
      if (modal.active) throw new Error("host is in a modal state");
      log.modal.push(options);
      const snap = snapshot();
      modal.active = true;
      modal.cancelled = false;
      const ctx = {
        get isCancelled() {
          return modal.cancelled;
        },
        reportProgress(p) {
          log.progress.push(p.value);
          if (opts.cancelAtProgress !== undefined && p.value >= opts.cancelAtProgress) modal.cancelled = true;
        },
        hostControl: {
          async suspendHistory(o) {
            log.suspend.push(o);
            return 4242;
          },
          async resumeHistory(id, commit) {
            log.resume.push({ id, commit });
          },
        },
      };
      try {
        const r = await fn(ctx);
        log.commits++;
        return r;
      } catch (e) {
        restore(snap);
        log.rollbacks++;
        throw e;
      } finally {
        modal.active = false;
        modal.cancelled = false;
      }
    },
  };

  const action = {
    async batchPlay(descs) {
      log.batchPlay.push(JSON.parse(JSON.stringify(descs)));
      if (descs.length === 1 && descs[0]._obj === "showColorPicker") {
        if (opts.colorPickerThrows) throw new Error("color picker failed");
        // colorPickerResponse is the whole batchPlay result (an array), as Photoshop returns it
        return opts.colorPickerResponse !== undefined ? opts.colorPickerResponse : [{}];
      }
      return descs.map((d) => {
        if (d._obj === "select") {
          guard("select");
          if (!modal.active) throw new Error("select requires a modal scope");
          const id = d._target[0]._id;
          if (!findLayer(id)) return { _obj: "error", message: "no such layer", result: -25920 };
          doc._active = [id];
          return {};
        }
        if (d._obj === "get") {
          const prop = d._target[0]._property;
          const ref = d._target[1];
          if (ref._ref === "document") {
            if (prop === "width") return { width: { _unit: "distanceUnit", _value: (W * 72) / doc.resolution } };
            if (prop === "height") return { height: { _unit: "distanceUnit", _value: (H * 72) / doc.resolution } };
            if (prop === "resolution") return { resolution: doc.resolution };
          }
          if (ref._ref === "layer") {
            const l = findLayer(ref._id);
            if (prop === "hasUserMask") return { hasUserMask: !!(l && l._hasUserMask) };
            if (prop === "hasVectorMask") return { hasVectorMask: false };
          }
          return {};
        }
        return {};
      });
    },
    async addNotificationListener(events, handler) {
      listeners.push({ events, handler });
    },
    async removeNotificationListener() {},
  };

  const app = { activeDocument: opts.noDocument ? null : doc, version: opts.version || "26.0.0", documents: [doc] };

  return {
    photoshop: { app, core: psCore, action, imaging, constants },
    doc,
    log,
    makeLayer,
    findLayer,
    fire(name, desc) {
      for (const l of listeners) if (l.events.includes(name)) l.handler(name, desc);
    },
    cancelNow() {
      modal.cancelled = true;
    },
  };
}

module.exports = { createFakePhotoshop, constants };
