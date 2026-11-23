/* Halation: bridge between the panel, the core and Photoshop (Imaging API, DOM, batchPlay).
 *
 * All Photoshop access goes through injected dependencies, so the logic loads in
 * Node with fake objects (test/bridge.test.js):
 *
 *   const bridge = HalationBridge.createBridge({
 *     photoshop: require("photoshop"),   // { app, core, action, imaging, constants }
 *     uxp: require("uxp"),               // optional, for versions
 *     os: require("os"),                 // optional
 *     core: HalationCore,
 *     color: HalationColor,
 *     log: (msg, data) => {}
 *   });
 *
 * Design doc: §5.5 (transparency, bounds), §5.6 (order of passes), §6.2 (apply),
 * §6.3 (pre-flight checks).
 *
 * Browser / UXP: window.HalationBridge. Node: module.exports.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.HalationBridge = api;
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function () {
  "use strict";

  var SRGB_PROFILE = "sRGB IEC61966-2.1";
  var RESULT_LAYER_NAME = "Halation";
  var COMMAND_NAME = "Halation";
  var PREVIEW_STRIP_PIXELS = 1 << 20; // ~1 Mpx per preview strip
  // Progress weights (doc §5.6): read 10 %, blur 35 %, write 55 %.
  var WEIGHTS = Object.freeze({ read: 0.10, blur: 0.35, write: 0.55 });

  // ---------------------------------------------------------------- errors

  function cancelledError(message) {
    var e = new Error(message || "Операция отменена пользователем");
    e.name = "HalationCancelled";
    e.halationCancelled = true;
    return e;
  }

  function nothingToDoError(message) {
    var e = new Error(message || "Нечего обрабатывать");
    e.name = "HalationNothingToDo";
    e.halationNothingToDo = true;
    return e;
  }

  function errorText(err) {
    if (!err) return "";
    if (typeof err === "string") return err;
    return String(err.message || err);
  }

  // Narrow on purpose (review М2): the reliable signal is executionContext.isCancelled,
  // which apply/buildPreview turn into the halationCancelled flag. Text is a fallback
  // and only matches messages that say the user cancelled.
  var CANCEL_TEXT = /cancel(?:l)?ed by (?:the )?user|user cancel|отменено пользователем/i;
  // "host is in a modal state", "... is currently in modal state", "is busy". Not
  // "requires a modal scope" / "only allowed from inside a modal scope" (a plugin bug).
  var BUSY_TEXT = /modal state|is busy|занят/i;

  function isCancelError(err) {
    if (!err) return false;
    if (err.halationCancelled) return true;
    if (err.number === -128 || err.code === -128) return true;
    return CANCEL_TEXT.test(errorText(err));
  }

  function isModalBusyError(err) {
    if (!err || isCancelError(err)) return false;
    var t = errorText(err);
    return BUSY_TEXT.test(t) && !/modal scope/i.test(t);
  }

  /** Set a flag on err; when err cannot carry it, wrap it in a new Error that does. */
  function flagError(err, flag, fallbackMessage) {
    if (err && typeof err === "object") {
      try {
        err[flag] = true;
        if (err[flag] === true) return err;
      } catch (e) { /* frozen */ }
    }
    var wrapped = new Error(fallbackMessage || errorText(err));
    wrapped[flag] = true;
    wrapped.cause = err;
    return wrapped;
  }

  /** Russian, user-facing description of an error thrown by apply / buildPreview / pickColor. */
  function describeError(err) {
    if (err && err.halationNothingToDo) return { kind: "nothing", text: errorText(err) };
    if (isCancelError(err)) return { kind: "cancelled", text: "Операция отменена. Документ не изменён." };
    if (isModalBusyError(err)) {
      return {
        kind: "busy",
        text: "Photoshop сейчас занят другой операцией (модальный режим): завершите трансформацию, " +
          "закройте открытый диалог или дождитесь окончания работы другого плагина и попробуйте снова. " +
          "Сообщение Photoshop: " + errorText(err)
      };
    }
    return { kind: "error", text: "Ошибка: " + errorText(err) + ". Документ не изменён. Подробности — в блоке «Диагностика»." };
  }

  // ---------------------------------------------------------------- pure helpers

  function num(v) {
    if (typeof v === "number") return v;
    if (v && typeof v === "object") {
      if (typeof v._value === "number") return v._value;
      if (typeof v.value === "number") return v.value;
    }
    var n = Number(v);
    return isFinite(n) ? n : NaN;
  }

  function normBounds(b) {
    if (!b) return null;
    return {
      left: Math.round(num(b.left)),
      top: Math.round(num(b.top)),
      right: Math.round(num(b.right)),
      bottom: Math.round(num(b.bottom))
    };
  }

  function rectW(r) { return r.right - r.left; }
  function rectH(r) { return r.bottom - r.top; }

  function isEmptyRect(r) {
    return !r || !(r.right > r.left) || !(r.bottom > r.top);
  }

  function intersect(a, b) {
    if (!a || !b) return null;
    var r = {
      left: Math.max(a.left, b.left),
      top: Math.max(a.top, b.top),
      right: Math.min(a.right, b.right),
      bottom: Math.min(a.bottom, b.bottom)
    };
    return isEmptyRect(r) ? null : r;
  }

  function sameRect(a, b) {
    return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
  }

  function clamp01(v) {
    v = Number(v);
    return v > 0 ? (v < 1 ? v : 1) : 0;
  }

  function parseVersion(s) {
    var m = String(s || "").match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
  }

  /** Photoshop 26.5-26.10: getData() memory leak reported on the Adobe forum. */
  function isLeakyVersion(v) {
    var p = parseVersion(v);
    return !!p && p[0] === 26 && p[1] >= 5 && p[1] <= 10;
  }

  function ScratchPool() {
    this.bufs = {};
  }
  // Exact-length buffers, reused while the length stays the same. Exact length matters
  // for createImageDataFromBuffer, which expects width*height*components elements.
  ScratchPool.prototype.get = function (name, len) {
    var b = this.bufs[name];
    if (!b || b.length !== len) {
      b = new Uint8Array(len);
      this.bufs[name] = b;
    }
    return b;
  };

  /**
   * Lay out getPixels output in a full-width strip buffer (doc §5.5).
   * raw/comps/ib: data, components and bounds returned by Photoshop (ib may be
   * smaller than requested: transparent margins are trimmed). req: requested strip.
   * Untrimmed data is copied as is; trimmed data goes into a zeroed RGBA buffer
   * (alpha 0 where nothing came back), so components becomes 4.
   * Returns { data, components, rect: {x,y,w,h} relative to the strip, full } or null.
   */
  function placeStrip(raw, comps, ib, req, pool) {
    if (comps !== 3 && comps !== 4) throw new Error("Неожиданное число компонент в данных Photoshop: " + comps);
    var W = rectW(req), H = rectH(req);
    var sb = intersect(ib, req);
    if (!sb) return null;
    pool = pool || new ScratchPool();
    if (sameRect(ib, req)) {
      var direct = pool.get("in", W * H * comps);
      direct.set(raw.length === direct.length ? raw : raw.subarray(0, direct.length));
      return { data: direct, components: comps, rect: { x: 0, y: 0, w: W, h: H }, full: true };
    }
    var buf = pool.get("in", W * H * 4);
    buf.fill(0);
    var ibW = rectW(ib);
    var sw = rectW(sb), sh = rectH(sb);
    var dx0 = sb.left - req.left, dy0 = sb.top - req.top;
    var sx0 = sb.left - ib.left, sy0 = sb.top - ib.top;
    for (var y = 0; y < sh; y++) {
      var s = ((sy0 + y) * ibW + sx0) * comps;
      var d = ((dy0 + y) * W + dx0) * 4;
      if (comps === 4) {
        buf.set(raw.subarray(s, s + sw * 4), d);
      } else {
        for (var x = 0; x < sw; x++, s += 3, d += 4) {
          buf[d] = raw[s];
          buf[d + 1] = raw[s + 1];
          buf[d + 2] = raw[s + 2];
          buf[d + 3] = 255;
        }
      }
    }
    return { data: buf, components: 4, rect: { x: dx0, y: dy0, w: sw, h: sh }, full: false };
  }

  /** Copy rect {x,y,w,h} out of a chunky buffer of width srcW. */
  function extractRect(src, srcW, comps, rect, pool) {
    var out = pool ? pool.get("rect", rect.w * rect.h * comps) : new Uint8Array(rect.w * rect.h * comps);
    var rowBytes = rect.w * comps;
    for (var y = 0; y < rect.h; y++) {
      var s = ((rect.y + y) * srcW + rect.x) * comps;
      out.set(src.subarray(s, s + rowBytes), y * rowBytes);
    }
    return out;
  }

  /** Is a notification relevant for the preview (document / layer / history change)? */
  function isRelevantEvent(name, desc) {
    if (name !== "select") return true;
    var t = desc && desc._target;
    var refs = Array.isArray(t) ? t : t ? [t] : [];
    for (var i = 0; i < refs.length; i++) {
      var r = refs[i] && refs[i]._ref;
      if (r === "layer" || r === "document" || r === "historyState" || r === "snapshotClass") return true;
    }
    return false; // tool selection and the like
  }

  function safe(fn) {
    try {
      return fn();
    } catch (e) {
      return undefined;
    }
  }

  function toArray(list) {
    if (!list) return [];
    var out = [];
    var n = num(list.length) || 0;
    for (var i = 0; i < n; i++) if (list[i]) out.push(list[i]);
    return out;
  }

  function key(docId, id) {
    return String(docId) + ":" + String(id);
  }

  function defaultNow() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }

  function defaultYield() {
    return new Promise(function (r) { setTimeout(r, 0); });
  }

  function attach(err, name, value) {
    if (err && typeof err === "object") {
      try { err[name] = value; } catch (e) { /* frozen error object */ }
    }
  }

  // ---------------------------------------------------------------- bridge

  function createBridge(deps) {
    deps = deps || {};
    var ps = deps.photoshop || {};
    var app = ps.app;
    var psCore = ps.core;
    var action = ps.action;
    var imaging = ps.imaging;
    var constants = ps.constants || {};
    var core = deps.core;
    var colorUtils = deps.color || null;
    var uxp = deps.uxp || null;
    var osMod = deps.os || null;
    var yieldFn = deps.yieldFn || defaultYield;
    var now = deps.now || defaultNow;
    var log = deps.log || function () {};
    var stripRowsOverride = deps.stripRows || 0; // tests only

    if (!core) throw new Error("HalationBridge: core is required");

    // Result layers made in this session. Nothing is removed from these maps: layer IDs
    // are never reused within a document, and an ID that vanished (deleted, or undone)
    // can come back with Undo/Redo. Every use filters by existence (liveResultIds), so
    // IDs of layers that no longer exist never reach a plan.
    var results = new Map();      // sourceKey ("doc:layerId" | "doc:composite") -> [resultId, ...] oldest first
    var resultSource = new Map(); // "doc:resultId" -> { docId, id, source: sourceLayerId | "composite" }
    var MAX_RESULTS_PER_SOURCE = 64;

    function rememberResult(plan, resultId) {
      var list = results.get(plan.sourceKey) || [];
      list.push(resultId);
      if (list.length > MAX_RESULTS_PER_SOURCE) list.splice(0, list.length - MAX_RESULTS_PER_SOURCE);
      results.set(plan.sourceKey, list);
      resultSource.set(key(plan.docId, resultId), {
        docId: plan.docId,
        id: resultId,
        source: plan.mode === "composite" ? "composite" : plan.sourceLayerId
      });
    }

    // ---- environment info

    function getHostInfo() {
      var h = { photoshop: null, uxp: null, pluginFromUxp: null, os: null, locale: null };
      h.photoshop = safe(function () { return app && app.version; }) || null;
      var v = safe(function () { return uxp && uxp.versions; });
      if (v) {
        h.uxp = v.uxp || null;
        h.pluginFromUxp = v.plugin || null;
      }
      var host = safe(function () { return uxp && uxp.host; });
      if (host) {
        h.locale = host.uiLocale || null;
        if (!h.photoshop) h.photoshop = host.version || null;
      }
      if (osMod) {
        h.os = safe(function () {
          return [osMod.platform && osMod.platform(), osMod.release && osMod.release(), osMod.arch && osMod.arch()]
            .filter(Boolean).join(" ");
        }) || null;
      }
      return h;
    }

    // ---- DOM helpers

    function constEq(value, group, name) {
      var g = constants[group];
      return !!g && g[name] !== undefined && value === String(g[name]);
    }

    function isRgbMode(m) {
      return constEq(m, "DocumentMode", "RGB") || /rgb/i.test(m);
    }

    function is8Bit(b) {
      return constEq(b, "BitsPerChannelType", "EIGHT") || /(^|\D)8(\D|$)/.test(b);
    }

    function modeLabel(m) {
      var s = String(m).toLowerCase();
      if (s.indexOf("rgb") >= 0) return "RGB";
      if (s.indexOf("cmyk") >= 0) return "CMYK";
      if (s.indexOf("gray") >= 0 || s.indexOf("grey") >= 0) return "Градации серого";
      if (s.indexOf("lab") >= 0) return "Lab";
      if (s.indexOf("index") >= 0) return "Индексированные цвета";
      if (s.indexOf("bitmap") >= 0) return "Битовый формат";
      if (s.indexOf("duotone") >= 0) return "Дуплекс";
      if (s.indexOf("multi") >= 0) return "Многоканальный";
      return String(m);
    }

    function bitsLabel(b) {
      var s = String(b);
      if (/32/.test(s)) return "32 бита";
      if (/16/.test(s)) return "16 бит";
      if (/(^|\D)8(\D|$)/.test(s)) return "8 бит";
      if (/(^|\D)1(\D|$)/.test(s)) return "1 бит";
      return s;
    }

    function isPixelKind(k) {
      if (k === "pixel" || k === "normal" || k === "background") return true;
      return constEq(k, "LayerKind", "NORMAL") || constEq(k, "LayerKind", "PIXEL");
    }

    function kindLabel(k) {
      var s = String(k).toLowerCase();
      if (s.indexOf("smart") >= 0) return "смарт-объект";
      if (s === "text") return "текстовый слой";
      if (s === "group") return "группа";
      if (s.indexOf("fill") >= 0 || s === "solidcolor") return "слой-заливка";
      if (s === "video") return "видеослой";
      if (s.indexOf("3d") >= 0 || s.indexOf("threed") >= 0) return "3D-слой";
      if (s === "undefined" || !s) return "слой неизвестного типа";
      return "корректирующий или особый слой (" + k + ")";
    }

    function isNormalBlend(bm) {
      return bm === "normal" || constEq(bm, "BlendMode", "NORMAL");
    }

    function findLayerById(container, id) {
      var layers = toArray(safe(function () { return container.layers; }));
      for (var i = 0; i < layers.length; i++) {
        var l = layers[i];
        if (l.id === id) return l;
        var inner = findLayerById(l, id);
        if (inner) return inner;
      }
      return null;
    }

    /** The layer list (doc.layers or a group's layers) that holds the layer with this id. */
    function containerList(container, id) {
      var layers = toArray(safe(function () { return container.layers; }));
      for (var i = 0; i < layers.length; i++) {
        if (layers[i].id === id) return layers;
        var inner = containerList(layers[i], id);
        if (inner) return inner;
      }
      return null;
    }

    /** True when `layer` already sits directly above `target` in the same list (review М3). */
    function isDirectlyAbove(doc, layer, target) {
      var list = containerList(doc, target.id);
      if (!list) return false;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === target.id) return i > 0 && list[i - 1].id === layer.id;
      }
      return false;
    }

    /** Layer ids in stacking order, top first (groups before their contents). */
    function stackOrder(container, out) {
      out = out || [];
      var layers = toArray(safe(function () { return container.layers; }));
      for (var i = 0; i < layers.length; i++) {
        out.push(layers[i].id);
        stackOrder(layers[i], out);
      }
      return out;
    }

    /** Result ids of a source that still exist in the document. */
    function liveResultIds(doc, sourceKey) {
      return (results.get(sourceKey) || []).filter(function (id) { return !!findLayerById(doc, id); });
    }

    /** The visually topmost of the given layer ids, or null. */
    function topmostLayer(doc, ids) {
      if (!ids.length) return null;
      var order = stackOrder(doc);
      for (var i = 0; i < order.length; i++) {
        if (ids.indexOf(order[i]) >= 0) return findLayerById(doc, order[i]);
      }
      return null;
    }

    /** Result layer by name: "Halation · … [h1:…]" (v1.1) or the plain v1.0 "Halation". */
    function isResultName(name) {
      if (typeof name !== "string") return false;
      if (typeof core.isResultLayerName === "function") return !!core.isResultLayerName(name);
      return name === RESULT_LAYER_NAME;
    }

    function layerName(l) {
      return safe(function () { return l.name; }) || "";
    }

    function isResultLayer(doc, l) {
      return !!l && (resultSource.has(key(doc.id, l.id)) || isResultName(layerName(l)));
    }

    function allLayers(container, out) {
      out = out || [];
      var layers = toArray(safe(function () { return container.layers; }));
      for (var i = 0; i < layers.length; i++) {
        out.push(layers[i]);
        allLayers(layers[i], out);
      }
      return out;
    }

    /** Every existing result layer of this document: our ID lists plus result-named layers
     *  (results from an earlier session or made before the panel was reloaded). */
    function resultLayersOf(doc) {
      var out = [];
      var seen = {};
      resultSource.forEach(function (r) {
        if (r.docId !== doc.id) return;
        var l = findLayerById(doc, r.id);
        if (l && !seen[l.id]) {
          seen[l.id] = true;
          out.push(l);
        }
      });
      allLayers(doc).forEach(function (l) {
        if (!seen[l.id] && isResultName(layerName(l))) {
          seen[l.id] = true;
          out.push(l);
        }
      });
      return out;
    }

    /** Result layers stacked directly above `source` in its list (a result keeps that place). */
    function resultsDirectlyAbove(doc, source) {
      var list = containerList(doc, source.id);
      if (!list) return [];
      var out = [];
      var i = 0;
      while (i < list.length && list[i].id !== source.id) i++;
      for (var j = i - 1; j >= 0 && isResultLayer(doc, list[j]); j--) out.push(list[j].id);
      return out;
    }

    /** First non-result layer below a result-named layer: its likely source. */
    function sourceBelow(doc, layer) {
      var list = containerList(doc, layer.id);
      if (!list) return null;
      var i = 0;
      while (i < list.length && list[i].id !== layer.id) i++;
      for (var j = i + 1; j < list.length; j++) if (!isResultLayer(doc, list[j])) return list[j];
      return null;
    }

    function resultIdsOfSource(doc, sourceKey, source) {
      var ids = liveResultIds(doc, sourceKey);
      if (source) {
        resultsDirectlyAbove(doc, source).forEach(function (id) {
          if (ids.indexOf(id) < 0) ids.push(id);
        });
      }
      return ids;
    }

    // Composite reads must not see earlier Halation results (review С4): hide the visible
    // ones for the read, inside the caller's modal scope, and give back their ids.
    function hideResultLayers(doc) {
      var hidden = [];
      resultLayersOf(doc).forEach(function (l) {
        if (safe(function () { return l.visible; }) !== false) {
          l.visible = false;
          hidden.push(l.id);
        }
      });
      if (hidden.length) log("Слои Halation скрыты на время чтения видимого изображения", hidden);
      return hidden;
    }

    function restoreVisibility(doc, ids) {
      for (var i = 0; i < ids.length; i++) {
        var l = findLayerById(doc, ids[i]);
        if (l) l.visible = true;
      }
    }

    function topLevelIds(doc) {
      return toArray(safe(function () { return doc.layers; })).map(function (l) { return l.id; });
    }

    function pxFromDesc(v, res) {
      if (typeof v === "number") return Math.round(v);
      if (v && typeof v === "object") {
        var val = num(v._value);
        if (!isFinite(val)) return 0;
        if (v._unit === "pixelsUnit") return Math.round(val);
        if (v._unit === "distanceUnit") return Math.round((val * res) / 72);
      }
      return 0;
    }

    async function batchGet(descs) {
      if (!action || typeof action.batchPlay !== "function") return null;
      return action.batchPlay(descs, {});
    }

    async function readDocInfo(doc) {
      var d = {
        id: doc.id,
        title: safe(function () { return doc.title || doc.name; }) || "",
        width: Math.round(num(safe(function () { return doc.width; }))),
        height: Math.round(num(safe(function () { return doc.height; }))),
        resolution: num(safe(function () { return doc.resolution; })),
        mode: String(safe(function () { return doc.mode; })),
        bits: String(safe(function () { return doc.bitsPerChannel; })),
        profile: safe(function () { return doc.colorProfileName; }) || "",
        sizeCheck: null
      };
      d.isRGB = isRgbMode(d.mode);
      d.is8 = is8Bit(d.bits);
      d.modeLabel = modeLabel(d.mode);
      d.bitsLabel = bitsLabel(d.bits);
      // Cross-check the pixel size with batchPlay (DOM width/height had unit bugs in old builds).
      try {
        var target = { _ref: "document", _id: doc.id };
        var r = await batchGet([
          { _obj: "get", _target: [{ _property: "width" }, target] },
          { _obj: "get", _target: [{ _property: "height" }, target] },
          { _obj: "get", _target: [{ _property: "resolution" }, target] }
        ]);
        if (r) {
          var res = num(r[2] && r[2].resolution) || d.resolution || 72;
          var bw = pxFromDesc(r[0] && r[0].width, res);
          var bh = pxFromDesc(r[1] && r[1].height, res);
          if (bw > 0 && bh > 0) {
            d.sizeCheck = bw + "×" + bh;
            if (!(d.width > 0 && d.height > 0) || Math.abs(bw - d.width) > 1 || Math.abs(bh - d.height) > 1) {
              log("Размер документа по DOM (" + d.width + "×" + d.height + ") и batchPlay (" + bw + "×" + bh + ") расходится — берётся batchPlay");
              d.width = bw;
              d.height = bh;
              d.sizeCheck += " (взят этот)";
            }
          }
        }
      } catch (e) {
        d.sizeCheck = "ошибка: " + errorText(e);
      }
      return d;
    }

    async function readLayerInfo(doc, layer) {
      var li = {
        id: layer.id,
        name: safe(function () { return layer.name; }) || "",
        kind: String(safe(function () { return layer.kind; })),
        isBackground: !!safe(function () { return layer.isBackgroundLayer; }),
        opacity: num(safe(function () { return layer.opacity; })),
        fillOpacity: num(safe(function () { return layer.fillOpacity; })),
        blendMode: String(safe(function () { return layer.blendMode; })),
        isClippingMask: !!safe(function () { return layer.isClippingMask; }),
        visible: safe(function () { return layer.visible; }),
        bounds: normBounds(safe(function () { return layer.boundsNoEffects; }) || safe(function () { return layer.bounds; })),
        hasUserMask: null,
        hasVectorMask: null
      };
      li.isPixel = isPixelKind(li.kind);
      if (li.isPixel && !li.isBackground) {
        try {
          var lref = { _ref: "layer", _id: layer.id };
          var dref = { _ref: "document", _id: doc.id };
          var r = await batchGet([
            { _obj: "get", _target: [{ _property: "hasUserMask" }, lref, dref] },
            { _obj: "get", _target: [{ _property: "hasVectorMask" }, lref, dref] }
          ]);
          if (r) {
            li.hasUserMask = r[0] && typeof r[0].hasUserMask === "boolean" ? r[0].hasUserMask : null;
            li.hasVectorMask = r[1] && typeof r[1].hasVectorMask === "boolean" ? r[1].hasVectorMask : null;
          }
        } catch (e) {
          log("Не удалось проверить маску слоя: " + errorText(e));
        }
      }
      return li;
    }

    // ---- pre-flight (doc §6.3); reads only, no modal scope

    /** Name of the layer and the settings its name carries (core.settingsFromLayerName). */
    function activeLayerInfoOf(layer) {
      if (!layer) return null;
      var name = layerName(layer);
      var parsed = null;
      if (typeof core.settingsFromLayerName === "function") {
        parsed = safe(function () { return core.settingsFromLayerName(name); }) || null;
      }
      return { id: layer.id, name: name, isResult: isResultName(name), settingsFromName: parsed };
    }

    /** Synchronous DOM read for the panel (no modal scope): the active layer's name info. */
    function activeLayerInfo() {
      var doc = safe(function () { return app.activeDocument; });
      if (!doc) return null;
      var layer = toArray(safe(function () { return doc.activeLayers; }))[0] || null;
      return activeLayerInfoOf(layer);
    }

    /** Bounds of the active selection, or null. DOM first (Document.selection), then batchPlay. */
    /** Read-only, no modal scope: active layer info and the selection, for the panel. */
    async function peek() {
      var doc = safe(function () { return app.activeDocument; });
      if (!doc) return { activeLayer: null, selection: null };
      var layer = toArray(safe(function () { return doc.activeLayers; }))[0] || null;
      return { activeLayer: activeLayerInfoOf(layer), selection: await readSelectionBounds(doc) };
    }

    async function readSelectionBounds(doc) {
      var sel = safe(function () { return doc.selection; });
      if (sel && typeof sel === "object" && "bounds" in sel) {
        var b = safe(function () { return sel.bounds; });
        var nb = b ? normBounds(b) : null;
        return nb && !isEmptyRect(nb) ? nb : null;
      }
      try {
        var r = await batchGet([{ _obj: "get", _target: [{ _property: "selection" }, { _ref: "document", _id: doc.id }] }]);
        var s = r && r[0] && r[0].selection;
        if (!s || typeof s !== "object") return null;
        var bb = normBounds({ left: s.left, top: s.top, right: s.right, bottom: s.bottom });
        return bb && !isEmptyRect(bb) ? bb : null;
      } catch (e) {
        return null; // no selection: Photoshop answers "get selection" with an error
      }
    }

    async function inspect(opts) {
      opts = opts || {};
      var t0 = now();
      var rep = {
        activeLayer: null,
        selection: null,
        blocking: [],
        warnings: [],
        notes: [],
        offerComposite: false,
        canUseLayer: false,
        nothingToDo: false,
        nothingMessage: null,
        memoryWarning: null,
        doc: null,
        layer: null,
        source: null,
        plans: { layer: null, composite: null },
        host: getHostInfo(),
        timingMs: 0
      };
      function done() {
        rep.timingMs = now() - t0;
        return rep;
      }
      var doc = safe(function () { return app.activeDocument; });
      if (!doc) {
        rep.blocking.push("Нет открытого документа.");
        return done();
      }
      var d = await readDocInfo(doc);
      rep.doc = d;
      if (!d.isRGB) rep.blocking.push("Документ в режиме «" + d.modeLabel + "», а нужен RGB: Изображение → Режим → RGB.");
      if (!d.is8) rep.blocking.push("Документ " + d.bitsLabel + " на канал, а нужно 8 бит: Изображение → Режим → 8 бит/канал.");
      if (!(d.width > 0 && d.height > 0)) rep.blocking.push("Не удалось определить размер документа.");
      if (rep.blocking.length) return done();

      if (!d.profile) {
        rep.warnings.push("У документа нет цветового профиля — он будет считаться sRGB.");
      } else if (d.profile !== SRGB_PROFILE) {
        rep.warnings.push("Профиль документа «" + d.profile + "», а не " + SRGB_PROFILE +
          ". Модель рассчитана на sRGB, поэтому результат будет приблизительным.");
      }
      if (isLeakyVersion(rep.host.photoshop)) {
        // The text itself, so the panel can show it once per session.
        rep.memoryWarning = "Photoshop " + rep.host.photoshop + ": в версиях 26.5–26.10 при повторных запусках может расти " +
          "занятая память (известная утечка чтения пикселей). Если Photoshop начнёт тормозить, перезапустите его.";
        rep.warnings.push(rep.memoryWarning);
      }

      var docBounds = { left: 0, top: 0, right: d.width, bottom: d.height };
      var docLongSide = Math.max(d.width, d.height);
      var active = toArray(safe(function () { return doc.activeLayers; }));
      var activeLayer = active[0] || null;
      var compKey = key(d.id, "composite");
      rep.activeLayer = activeLayerInfoOf(activeLayer);
      rep.selection = await readSelectionBounds(doc);

      rep.plans.composite = {
        mode: "composite",
        docId: d.id,
        area: docBounds,
        docLongSide: docLongSide,
        sourceKey: compKey,
        previousResultIds: opts.replacePrevious ? liveResultIds(doc, compKey) : [],
        reselectId: activeLayer ? activeLayer.id : null,
        label: "видимое изображение"
      };
      if (resultLayersOf(doc).length) {
        rep.compositeNote = "Слои Halation на время чтения видимого изображения скрываются, ореол не удвоится.";
      }

      if (active.length > 1) {
        rep.notes.push("Выбрано несколько слоёв (" + active.length + ") — обрабатывается «" +
          (safe(function () { return activeLayer.name; }) || "") + "».");
      }

      var sourceLayer = activeLayer;
      if (activeLayer) {
        var entry = resultSource.get(key(d.id, activeLayer.id));
        var rs = entry ? entry.source : undefined;
        if (rs === "composite") {
          rep.offerComposite = true;
          rep.canUseLayer = false;
          rep.notes.push("Активен слой результата, построенного по видимому изображению, — эффект снова будет применён к видимому изображению.");
          rep.source = { mode: "composite", viaResult: activeLayer.id };
          return done();
        }
        if (rs !== undefined) {
          var src = findLayerById(doc, rs);
          if (src) {
            sourceLayer = src;
            rep.notes.push("Активен слой результата — эффект будет применён к его исходному слою «" +
              (safe(function () { return src.name; }) || "") + "».");
          } else {
            rep.warnings.push("Исходный слой этого результата не найден — будет обработан сам слой результата.");
          }
        } else if (isResultName(layerName(activeLayer))) {
          // A result layer we did not make in this session (earlier session, reopened file):
          // results sit directly above their source, so take the first layer below.
          var below = sourceBelow(doc, activeLayer);
          if (below) {
            sourceLayer = below;
            rep.notes.push("Активен слой результата Halation — эффект будет применён к слою под ним «" + layerName(below) + "».");
          } else {
            rep.warnings.push("Активен слой результата Halation, а под ним нет исходного слоя — будет обработан сам этот слой.");
          }
        }
      }

      if (!sourceLayer) {
        rep.offerComposite = true;
        rep.warnings.push("Нет активного слоя. Эффект можно применить к видимому изображению.");
        return done();
      }

      var li = await readLayerInfo(doc, sourceLayer);
      rep.layer = li;
      if (!li.isPixel) {
        rep.offerComposite = true;
        rep.warnings.push("Слой «" + li.name + "» — " + kindLabel(li.kind) + ", а не пиксельный. " +
          "Эффект можно применить к видимому изображению: результат ляжет новым слоем наверх.");
        rep.source = { mode: "composite", reason: "non-pixel" };
        return done();
      }
      var area = li.bounds ? intersect(li.bounds, docBounds) : null;
      if (!area) {
        rep.nothingToDo = true;
        rep.nothingMessage = "Слой «" + li.name + "» пуст — нечего обрабатывать.";
        return done();
      }

      var issues = [];
      if (li.hasUserMask || li.hasVectorMask) issues.push("есть маска");
      if (isFinite(li.opacity) && li.opacity < 100) issues.push("непрозрачность " + Math.round(li.opacity) + " %");
      if (isFinite(li.fillOpacity) && li.fillOpacity < 100) issues.push("заливка " + Math.round(li.fillOpacity) + " %");
      if (li.blendMode !== "undefined" && !isNormalBlend(li.blendMode)) issues.push("режим наложения «" + li.blendMode + "»");
      if (li.isClippingMask) issues.push("слой обтравочный");
      if (issues.length) {
        rep.offerComposite = true;
        rep.warnings.push("У слоя «" + li.name + "»: " + issues.join(", ") + ". Новый слой не унаследует маску, " +
          "непрозрачность и режим наложения и откроет скрытые области. Можно применить эффект к видимому изображению.");
      }

      var srcKey = key(d.id, sourceLayer.id);
      rep.canUseLayer = true;
      rep.plans.layer = {
        mode: "layer",
        docId: d.id,
        sourceLayerId: sourceLayer.id,
        area: area,
        docLongSide: docLongSide,
        sourceKey: srcKey,
        previousResultIds: opts.replacePrevious ? resultIdsOfSource(doc, srcKey, sourceLayer) : [],
        reselectId: sourceLayer.id,
        layerBounds: li.bounds, // tight pixel bounds: its first and last rows hold pixels
        label: "слой «" + li.name + "»"
      };
      rep.source = { mode: "layer", layerId: sourceLayer.id, area: area, viaResult: sourceLayer !== activeLayer };
      return done();
    }

    // ---- modal helpers

    function runModal(fn, commandName, extra) {
      if (!psCore || typeof psCore.executeAsModal !== "function") {
        return Promise.reject(new Error("executeAsModal недоступен"));
      }
      var options = { commandName: commandName };
      if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) options[k] = extra[k];
      return psCore.executeAsModal(fn, options);
    }

    async function checkpoint(ctx) {
      await yieldFn();
      if (ctx && ctx.isCancelled) throw cancelledError();
    }

    // Reports to Photoshop's progress window and, optionally, to the panel.
    function progressReporter(ctx, onProgress) {
      var lastStage = null;
      return function (value, stage) {
        value = clamp01(value);
        if (typeof onProgress === "function") onProgress(value, stage);
        if (!ctx || typeof ctx.reportProgress !== "function") return;
        var arg = { value: value };
        if (stage !== lastStage) {
          arg.commandName = "Halation: " + stage;
          lastStage = stage;
        }
        ctx.reportProgress(arg);
      };
    }

    function activeDocChecked(docId) {
      var doc = safe(function () { return app.activeDocument; });
      if (!doc || doc.id !== docId) throw new Error("Активный документ сменился — нажмите кнопку ещё раз");
      return doc;
    }

    function newStats(kind, plan) {
      return {
        kind: kind,
        when: new Date().toISOString(),
        mode: plan.mode,
        area: plan.area,
        ok: false,
        cancelled: false,
        error: null,
        timings: {},
        getPixelsCalls: 0,
        bytesRead: 0,
        putPixelsCalls: 0,
        bytesWritten: 0,
        emptyStrips: 0,
        toleratedErrors: 0,
        toleratedMessages: [],
        strips: 0,
        stripRows: 0
      };
    }

    // Reads full-width strips of the work area (doc §5.5).
    function makeReader(docId, plan, area, stats, ctx, pool) {
      var W = rectW(area);
      var R = { firstError: null, meta: { colorProfile: null, colorSpace: null } };

      function emptyStrip(h) {
        var buf = pool.get("in", h * W * 4);
        buf.fill(0);
        return { data: buf, components: 4, hadData: false, rect: null, full: false };
      }

      R.read = async function (y0, h, o) {
        var req = { left: area.left, top: area.top + y0, right: area.right, bottom: area.top + y0 + h };
        var opts = { documentID: docId, sourceBounds: req, componentSize: 8, applyAlpha: false };
        if (plan.mode === "layer") opts.layerID = plan.sourceLayerId;
        var res = null, imageData = null;
        try {
          try {
            stats.getPixelsCalls++;
            res = await imaging.getPixels(opts);
          } catch (err) {
            if ((ctx && ctx.isCancelled) || isCancelError(err) || isModalBusyError(err)) throw err;
            if (!o || !o.tolerate) throw err;
            // Deliberate, narrow exception (review С5): Photoshop may report an entirely
            // transparent strip as an error instead of an empty result (doc §5.5: an empty
            // strip is not an error). The caller allows this only in layer mode, only for
            // strips the layer bounds do not prove to hold pixels, and only when pass 1
            // and pass 2 agree. The strip counts as empty; the panel warns about it.
            stats.toleratedErrors++;
            if (stats.toleratedMessages.length < 5) stats.toleratedMessages.push("y=" + req.top + ": " + errorText(err));
            if (!R.firstError) R.firstError = err;
            log("getPixels: ошибка на полосе y=" + req.top + " считается пустой полосой: " + errorText(err));
            var tolerated = emptyStrip(h);
            tolerated.tolerated = true;
            return tolerated;
          }
          imageData = res && res.imageData;
          if (!imageData) {
            stats.emptyStrips++;
            return emptyStrip(h);
          }
          var ib = res.sourceBounds ? normBounds(res.sourceBounds) : { left: req.left, top: req.top, right: req.right, bottom: req.bottom };
          var iw = num(imageData.width), ih = num(imageData.height);
          if (iw > 0 && ih > 0 && (rectW(ib) !== iw || rectH(ib) !== ih)) {
            log("sourceBounds не совпадает с размером imageData", { sourceBounds: ib, width: iw, height: ih });
            ib = { left: ib.left, top: ib.top, right: ib.left + iw, bottom: ib.top + ih };
          }
          if (isEmptyRect(ib) || !intersect(ib, req)) {
            stats.emptyStrips++;
            return emptyStrip(h);
          }
          var raw = await imageData.getData({ chunky: true });
          var len = raw ? raw.length : 0;
          stats.bytesRead += raw && raw.byteLength !== undefined ? raw.byteLength : len;
          var comps = num(imageData.components);
          if (!(comps > 0)) comps = len / (rectW(ib) * rectH(ib));
          if (len !== rectW(ib) * rectH(ib) * comps) {
            throw new Error("getPixels вернул " + len + " байт вместо " + rectW(ib) + "×" + rectH(ib) + "×" + comps);
          }
          if (R.meta.colorProfile === null) {
            R.meta.colorProfile = typeof imageData.colorProfile === "string" ? imageData.colorProfile : "";
            R.meta.colorSpace = imageData.colorSpace || "RGB";
          }
          var placed = placeStrip(raw, comps, ib, req, pool);
          if (!placed) {
            stats.emptyStrips++;
            return emptyStrip(h);
          }
          placed.hadData = true;
          placed.sourceBounds = ib;
          placed.width = W;
          return placed;
        } finally {
          if (imageData && typeof imageData.dispose === "function") imageData.dispose();
        }
      };
      return R;
    }

    async function writeStrip(docId, layerId, out, W, strip, area, y0, meta, stats, pool) {
      var comps = strip.components;
      var buf = out;
      var w = W;
      var h = out.length / (W * comps);
      var left = area.left;
      var top = area.top + y0;
      if (!strip.full) {
        var r = strip.rect;
        buf = extractRect(out, W, comps, r, pool);
        w = r.w;
        h = r.h;
        left += r.x;
        top += r.y;
      }
      var img = null;
      try {
        img = await imaging.createImageDataFromBuffer(buf, {
          width: w,
          height: h,
          components: comps,
          chunky: true,
          colorSpace: meta.colorSpace || "RGB",
          colorProfile: meta.colorProfile || ""
        });
        stats.putPixelsCalls++;
        await imaging.putPixels({
          documentID: docId,
          layerID: layerId,
          imageData: img,
          // false: strips are added to the new layer one by one. With true (the API default)
          // Photoshop discards the layer's existing pixels, so only the last strip would remain.
          replace: false,
          targetBounds: { left: left, top: top },
          commandName: COMMAND_NAME
        });
        stats.bytesWritten += buf.length;
      } finally {
        if (img && typeof img.dispose === "function") img.dispose();
      }
    }

    function placeBefore() {
      var ep = constants.ElementPlacement;
      return ep && ep.PLACEBEFORE !== undefined ? ep.PLACEBEFORE : "placeBefore";
    }

    async function createResultLayer(doc, plan, name) {
      var layer;
      name = name || RESULT_LAYER_NAME;
      if (typeof doc.createPixelLayer === "function") {
        layer = await doc.createPixelLayer({ name: name });
      } else if (typeof doc.createLayer === "function") {
        log("createPixelLayer недоступен — используется createLayer");
        layer = await doc.createLayer({ name: name });
      } else {
        throw new Error("В этой версии Photoshop нет createPixelLayer");
      }
      if (!layer) throw new Error("Photoshop не вернул созданный слой");
      var target, placedAbove;
      if (plan.mode === "layer") {
        // Above the topmost existing result of this source, so an earlier opaque result
        // never hides the new one (review С3); otherwise right above the source.
        var srcLayer = findLayerById(doc, plan.sourceLayerId);
        if (!srcLayer) throw new Error("Исходный слой не найден");
        var prev = topmostLayer(doc, resultIdsOfSource(doc, plan.sourceKey, srcLayer).filter(function (id) { return id !== layer.id; }));
        target = prev || srcLayer;
        placedAbove = prev ? "result" : "source";
      } else {
        target = toArray(safe(function () { return doc.layers; }))[0];
        placedAbove = "top";
      }
      var moved = false;
      if (target && target.id !== layer.id && !isDirectlyAbove(doc, layer, target)) {
        await layer.move(target, placeBefore());
        moved = true;
      }
      return { layer: layer, placedAbove: placedAbove, moved: moved };
    }

    async function selectLayer(id) {
      if (id === null || id === undefined) return;
      var res = await action.batchPlay([{
        _obj: "select",
        _target: [{ _ref: "layer", _id: id }],
        makeVisible: false,
        layerID: [id],
        _options: { dialogOptions: "dontDisplay" }
      }], {});
      var r0 = res && res[0];
      if (r0 && r0._obj === "error") throw new Error("Не удалось выбрать слой: " + (r0.message || r0.result));
    }

    /**
     * Which strips may come back as a getPixels error and still count as empty (review С5).
     * Never for the composite (it has no empty strips). In layer mode, boundsNoEffects is
     * tight, so the strip holding its first row and the strip holding its last row have
     * pixels whenever those rows lie inside the document.
     */
    function tolerancePolicy(plan, area, nStrips) {
      if (plan.mode !== "layer" || !plan.layerBounds) return function () { return false; };
      var topKnown = plan.layerBounds.top === area.top;
      var bottomKnown = plan.layerBounds.bottom === area.bottom;
      return function (i) {
        if (i === 0 && topKnown) return false;
        if (i === nStrips - 1 && bottomKnown) return false;
        return true;
      };
    }

    function chooseRows(proc, W, H) {
      var r = stripRowsOverride || Math.floor(num(proc.stripRows));
      if (!(r >= 1)) r = Math.max(1, Math.floor(PREVIEW_STRIP_PIXELS / W));
      return Math.max(1, Math.min(r, H));
    }

    function procStats(proc) {
      if (!proc) return null;
      return safe(function () { return proc.stats; }) || null;
    }

    // ---- v1.1 helpers: layer name, selection mask, reads that hide earlier results

    /** Result layer name with the settings token (core.layerNameFor), at most 255 characters. */
    function resultLayerName(settings) {
      if (typeof core.layerNameFor !== "function") return RESULT_LAYER_NAME;
      var n = safe(function () { return core.layerNameFor(settings); });
      return typeof n === "string" && n ? n.slice(0, 255) : RESULT_LAYER_NAME;
    }

    /**
     * The selection becomes the result layer's mask (best-practices §3.4), in two steps
     * (review v1.1 М2): readSelectionMask runs first, right after suspendHistory, so a
     * missing method or a lost selection fails before any pixel work; putSelectionMask
     * writes the mask at the end. The mask covers the whole work area in one call (black
     * outside the selection), so it never depends on what a new mask holds by default.
     * Returns { mask: Uint8Array | null, info }; mask is null (with info.warning) when the
     * selection does not reach the work area: then no mask is added and the panel warns.
     */
    async function readSelectionMask(docId, area, stats) {
      if (typeof imaging.getSelection !== "function" || typeof imaging.putLayerMask !== "function") {
        throw new Error("В этой версии Photoshop нет getSelection / putLayerMask — снимите галочку «Только в выделении»");
      }
      var W = rectW(area), H = rectH(area);
      var info = { selectionBounds: null, components: null, maskBytes: W * H, answer: null, warning: null };
      var sel = null, selData = null;
      var mask = new Uint8Array(W * H); // 0: hidden
      var any = false;
      try {
        sel = await imaging.getSelection({ documentID: docId, sourceBounds: area });
        selData = sel && sel.imageData;
        if (selData) {
          var iw = num(selData.width), ih = num(selData.height);
          var sb;
          if (iw === W && ih === H) {
            // Data the size of the request covers the request, whatever bounds come back
            // (Adobe does not document which of the two the answer carries).
            sb = { left: area.left, top: area.top, right: area.right, bottom: area.bottom };
            info.answer = "размер запроса";
          } else {
            var rb = sel.sourceBounds ? normBounds(sel.sourceBounds) : null;
            if (!rb || !(iw > 0 && ih > 0)) throw new Error("getSelection вернул данные без понятных границ");
            sb = { left: rb.left, top: rb.top, right: rb.left + iw, bottom: rb.top + ih };
            info.answer = "границы выделения";
          }
          var raw = await selData.getData({ chunky: true });
          var comps = num(selData.components) || 1;
          stats.bytesRead += raw.length;
          if (raw.length !== rectW(sb) * rectH(sb) * comps) {
            throw new Error("getSelection вернул " + raw.length + " байт вместо " + rectW(sb) + "×" + rectH(sb) + "×" + comps);
          }
          info.selectionBounds = sb;
          info.components = comps;
          var r = intersect(sb, area);
          if (r) {
            var sbW = rectW(sb);
            for (var y = r.top; y < r.bottom; y++) {
              var d = (y - area.top) * W + (r.left - area.left);
              var s = ((y - sb.top) * sbW + (r.left - sb.left)) * comps;
              for (var x = 0; x < rectW(r); x++) {
                var v = raw[s + x * comps];
                mask[d + x] = v;
                if (v) any = true;
              }
            }
          }
        }
      } finally {
        if (selData && typeof selData.dispose === "function") selData.dispose();
      }
      if (!any) {
        info.warning = "Выделение не пересекает обрабатываемую область — маска не добавлена, эффект применён ко всей области.";
        log("Маска из выделения: " + info.warning, info);
        return { mask: null, info: info };
      }
      log("Выделение прочитано для маски", info);
      return { mask: mask, info: info };
    }

    async function putSelectionMask(docId, layerId, area, mask) {
      var maskImg = null;
      try {
        maskImg = await imaging.createImageDataFromBuffer(mask, {
          width: rectW(area),
          height: rectH(area),
          components: 1,
          chunky: true,
          colorSpace: "Grayscale",
          colorProfile: "Gray Gamma 2.2"
        });
        await imaging.putLayerMask({
          documentID: docId,
          layerID: layerId,
          imageData: maskImg,
          replace: true, // one call covers the whole area
          targetBounds: { left: area.left, top: area.top },
          commandName: COMMAND_NAME
        });
        log("Маска из выделения записана");
      } finally {
        if (maskImg && typeof maskImg.dispose === "function") maskImg.dispose();
      }
    }

    // Composite reads: hide earlier results inside a suspended history that is then
    // discarded (resumeHistory(id, false)), so nothing lands in the History panel.
    async function hideForRead(ctx, doc, plan, historyName) {
      var st = { hidden: [], suspension: null, hc: ctx && ctx.hostControl };
      if (plan.mode !== "composite") return st;
      var visible = resultLayersOf(doc).filter(function (l) {
        return safe(function () { return l.visible; }) !== false;
      });
      if (!visible.length) return st;
      if (st.hc && typeof st.hc.suspendHistory === "function") {
        st.suspension = await st.hc.suspendHistory({ documentID: doc.id, name: historyName });
      }
      st.hidden = hideResultLayers(doc);
      return st;
    }

    async function unhideAfterRead(doc, st) {
      restoreVisibility(doc, st.hidden);
      if (st.suspension !== null && st.suspension !== undefined) await st.hc.resumeHistory(st.suspension, false);
    }

    /**
     * Loupe (v1.1): read one rectangle of the preview's source at full resolution.
     * Returns { data, components, width, height, left, top, hadData, stats }, with the
     * rectangle clamped to the plan's work area. Missing (trimmed) pixels are alpha 0.
     */
    async function readRegion(args) {
      args = args || {};
      var plan = args.plan;
      if (!plan) throw new Error("Нет источника для лупы");
      var rect = args.rect ? intersect(normBounds(args.rect), plan.area) : null;
      if (!rect) throw nothingToDoError("Место лупы вне обрабатываемой области — щёлкните по кадру в другом месте.");
      var stats = newStats("loupe", plan);
      stats.area = rect;
      var pool = new ScratchPool();
      var t0 = now();
      var region = null;
      var outcome = { cancelled: false, nothing: false };
      try {
        await runModal(async function (ctx) {
          try {
            var doc = activeDocChecked(plan.docId);
            var st = await hideForRead(ctx, doc, plan, "Halation: лупа");
            stats.hiddenDuringRead = st.hidden;
            var reader = makeReader(doc.id, plan, rect, stats, ctx, pool);
            var s = await reader.read(0, rectH(rect), { pass: 1, tolerate: plan.mode === "layer" });
            region = {
              data: s.data.slice(), // own copy: the pool buffer is reused
              components: s.components,
              width: rectW(rect),
              height: rectH(rect),
              left: rect.left,
              top: rect.top,
              hadData: s.hadData,
              // A read error counted as "transparent" must not pass silently (review v1.1 М1).
              warning: s.tolerated ? "Photoshop не отдал пиксели этой области: она прозрачна или слой изменился — нажмите «Обновить»." : null
            };
            await unhideAfterRead(doc, st);
          } finally {
            if (ctx && ctx.isCancelled) outcome.cancelled = true;
          }
        }, "Halation: лупа");
      } catch (err) {
        var e = classifyError(err, outcome);
        stats.timings.total = now() - t0;
        stats.cancelled = isCancelError(e);
        stats.error = errorText(e);
        attach(e, "halationStats", stats);
        throw e;
      }
      stats.ok = true;
      stats.timings.total = now() - t0;
      region.stats = stats;
      return region;
    }

    // ---- apply (doc §6.2, §5.5-5.6)

    // Errors leave the modal scope as they are (Photoshop rolls back). Outside it, mark
    // them from facts recorded inside: ctx.isCancelled and our own "nothing to do".
    function classifyError(err, outcome) {
      if (outcome.nothing && !(err && err.halationNothingToDo)) return flagError(err, "halationNothingToDo");
      if (outcome.cancelled && !isCancelError(err)) return flagError(err, "halationCancelled", "Операция отменена пользователем");
      return err;
    }

    /** Does the read hold any pixel (alpha > 0) in its rows [sy, sy + h)? */
    function stripHasPixels(s, sy, h) {
      if (!s.hadData || !s.rect) return false;
      var r = s.rect;
      var r0 = Math.max(r.y, sy), r1 = Math.min(r.y + r.h, sy + h);
      if (r1 <= r0) return false;
      if (s.components !== 4) return true;
      for (var y = r0; y < r1; y++) {
        for (var x = r.x; x < r.x + r.w; x++) {
          if (s.data[(y * s.width + x) * 4 + 3]) return true;
        }
      }
      return false;
    }

    /** The part of a read that falls on the strip's own rows, in strip coordinates. */
    function stripPart(s, sy, h, W) {
      var r = s.rect;
      var r0 = Math.max(r.y, sy), r1 = Math.min(r.y + r.h, sy + h);
      var rect = { x: r.x, y: r0 - sy, w: r.w, h: r1 - r0 };
      return { components: s.components, rect: rect, full: rect.x === 0 && rect.w === W && rect.y === 0 && rect.h === h };
    }

    function stripMismatch(req, hadBefore) {
      return new Error("Полоса y=" + req + " изменилась между проходами: в первом проходе " +
        (hadBefore ? "были пиксели, во втором их нет" : "пикселей не было, во втором они появились") +
        ". Документ не изменён; попробуйте ещё раз.");
    }

    async function apply(args) {
      args = args || {};
      var plan = args.plan;
      if (!plan) throw new Error("Нет плана применения");
      var settings = core.normalizeSettings(args.settings || {});
      var stats = newStats("apply", plan);
      if (args.preflightMs !== undefined) stats.timings.preflight = args.preflightMs;
      var pool = new ScratchPool();
      var t0 = now();
      var proc = null;
      var resultId = null;
      var outcome = { cancelled: false, nothing: false };
      try {
        await runModal(async function (ctx) {
          try {
            var doc = activeDocChecked(plan.docId);
            var hc = ctx && ctx.hostControl;
            var suspension = null;
            if (hc && typeof hc.suspendHistory === "function") {
              suspension = await hc.suspendHistory({ documentID: doc.id, name: RESULT_LAYER_NAME });
            }
            var report = progressReporter(ctx, args.onProgress);
            stats.layerOrder = { before: topLevelIds(doc), after: null };

            // The selection is read first (review v1.1 М2): a missing method or a lost
            // selection fails before any pixel work; an empty one means no mask + warning.
            var maskBuf = null;
            if (args.maskToSelection) {
              var sm = await readSelectionMask(doc.id, plan.area, stats);
              stats.mask = sm.info;
              maskBuf = sm.mask;
              if (!maskBuf) stats.maskWarning = sm.info.warning;
            }

            // Previous results go away in the same history step, before reading.
            var deleted = [];
            var prevIds = plan.previousResultIds || [];
            for (var p = 0; p < prevIds.length; p++) {
              var old = findLayerById(doc, prevIds[p]);
              if (old) {
                await old.delete();
                deleted.push(prevIds[p]);
              }
            }
            stats.deletedPreviousIds = deleted;

            // The composite must not include earlier results (review С4).
            var hidden = plan.mode === "composite" ? hideResultLayers(doc) : [];
            stats.hiddenDuringRead = hidden;

            var area = plan.area;
            var W = rectW(area), H = rectH(area);
            proc = core.createProcessor({
              width: W,
              height: H,
              originX: area.left,
              originY: area.top,
              docLongSide: plan.docLongSide,
              settings: settings
            });
            var rows = chooseRows(proc, W, H);
            var nStrips = Math.ceil(H / rows);
            stats.strips = nStrips;
            stats.stripRows = rows;
            var mayBeEmpty = tolerancePolicy(plan, area, nStrips);
            var reader = makeReader(doc.id, plan, area, stats, ctx, pool);
            var had = new Array(nStrips);
            var i, y0, h;

            // Pass 1: read strips, linearize and accumulate into the base grid.
            var t = now();
            stats.toleratedStrips = 0;
            for (i = 0; i < nStrips; i++) {
              y0 = i * rows;
              h = Math.min(rows, H - y0);
              var s1 = await reader.read(y0, h, { pass: 1, tolerate: mayBeEmpty(i) });
              had[i] = stripHasPixels(s1, 0, h);
              if (s1.tolerated) stats.toleratedStrips++;
              proc.pass1(s1.data, s1.components, y0, h);
              report(WEIGHTS.read * (i + 1) / nStrips, "чтение");
              await checkpoint(ctx);
            }
            stats.timings.read = now() - t;
            if (had.indexOf(true) < 0) {
              if (reader.firstError) throw reader.firstError;
              outcome.nothing = true;
              throw nothingToDoError("В области слоя нет пикселей — нечего обрабатывать.");
            }

            // Blur on the pyramid, yielding between steps.
            t = now();
            for (var prog of proc.blurSteps()) {
              report(WEIGHTS.read + WEIGHTS.blur * clamp01(prog), "размытие");
              await checkpoint(ctx);
            }
            stats.timings.blur = now() - t;

            // New layer above the source or its topmost earlier result (top for the composite).
            t = now();
            var made = await createResultLayer(doc, plan, resultLayerName(settings));
            resultId = made.layer.id;
            stats.layerName = layerName(made.layer);
            stats.placedAbove = made.placedAbove;
            stats.layerMoved = made.moved;
            stats.timings.layer = now() - t;

            // Pass 2: re-read the strips and write the output. Each strip must look the same
            // as in pass 1 (has pixels or not), otherwise the blur used other data.
            // Gaussians finer than the base grid run at full resolution here and need
            // proc.fineRadius rows of context above and below each strip (core v1.1).
            var fr = Math.max(0, Math.floor(num(safe(function () { return proc.fineRadius; })) || 0));
            stats.fineRadius = fr;
            t = now();
            for (i = 0; i < nStrips; i++) {
              y0 = i * rows;
              h = Math.min(rows, H - y0);
              var dY0 = Math.max(0, y0 - fr);
              var dEnd = Math.min(H, y0 + h + fr);
              var dRows = dEnd - dY0;
              // A read error may count as empty only if every strip it touches was empty.
              var tol = true;
              for (var j = Math.floor(dY0 / rows); j <= Math.floor((dEnd - 1) / rows); j++) {
                if (had[j] || !mayBeEmpty(j)) tol = false;
              }
              var s2 = await reader.read(dY0, dRows, { pass: 2, tolerate: tol });
              var sy = y0 - dY0; // the strip's rows inside the read
              var stripHas = stripHasPixels(s2, sy, h);
              if (stripHas !== had[i]) throw stripMismatch(area.top + y0, had[i]);
              var out = pool.get("out", h * W * s2.components);
              if (fr > 0) proc.pass2(s2.data, s2.components, y0, h, out, { dataY0: dY0, dataRows: dRows });
              else proc.pass2(s2.data, s2.components, y0, h, out);
              if (stripHas) await writeStrip(doc.id, resultId, out, W, stripPart(s2, sy, h, W), area, y0, reader.meta, stats, pool);
              report(WEIGHTS.read + WEIGHTS.blur + WEIGHTS.write * (i + 1) / nStrips, "запись");
              await checkpoint(ctx);
            }
            stats.timings.write = now() - t;

            // Only inside the selection: the selection becomes the result's layer mask,
            // in the same history step (v1.1).
            if (maskBuf) {
              t = now();
              await putSelectionMask(doc.id, resultId, area, maskBuf);
              stats.mask.written = true;
              stats.timings.mask = now() - t;
            }

            // Visibility back before committing, then the source becomes active again.
            restoreVisibility(doc, hidden);
            var reselect = plan.reselectId !== null && plan.reselectId !== undefined && findLayerById(doc, plan.reselectId)
              ? plan.reselectId : resultId;
            await selectLayer(reselect);
            stats.reselectedId = reselect;
            stats.layerOrder.after = topLevelIds(doc);

            if (suspension !== null && suspension !== undefined) await hc.resumeHistory(suspension, true);
          } finally {
            // Not a catch: errors still leave the modal scope untouched.
            if (ctx && ctx.isCancelled) outcome.cancelled = true;
          }
        }, COMMAND_NAME);
      } catch (err) {
        // Outside the modal scope: Photoshop has already rolled the document back.
        var e = classifyError(err, outcome);
        stats.timings.total = now() - t0;
        stats.cancelled = isCancelError(e);
        stats.error = errorText(e);
        stats.coreStats = procStats(proc);
        attach(e, "halationStats", stats);
        throw e;
      }
      stats.ok = true;
      stats.timings.total = now() - t0;
      stats.coreStats = procStats(proc);
      if (resultId !== null) rememberResult(plan, resultId);
      return { resultLayerId: resultId, stats: stats };
    }

    // ---- preview proxy (doc §6.1): built on panel show and the "Обновить" button only

    async function buildPreview(args) {
      args = args || {};
      var plan = args.plan;
      if (!plan) throw new Error("Нет источника для предпросмотра");
      var maxLongSide = args.maxLongSide || 500;
      var stats = newStats("preview", plan);
      var pool = new ScratchPool();
      var t0 = now();
      var proxy = null;
      var outcome = { cancelled: false, nothing: false };
      try {
        await runModal(async function (ctx) {
          try {
            var doc = activeDocChecked(plan.docId);
            // Composite: hide earlier results for the read (review С4). Inside a suspended
            // history that is discarded at the end, so nothing lands in the History panel;
            // on an exception Photoshop rolls the visibility back as well.
            var hideState = await hideForRead(ctx, doc, plan, "Halation: предпросмотр");
            stats.hiddenDuringRead = hideState.hidden;

            var area = plan.area;
            var W = rectW(area), H = rectH(area);
            var b = core.createPreviewBuilder({ width: W, height: H, maxLongSide: maxLongSide });
            var rows = Math.max(1, Math.min(H, stripRowsOverride || Math.floor(PREVIEW_STRIP_PIXELS / W)));
            var n = Math.ceil(H / rows);
            stats.strips = n;
            stats.stripRows = rows;
            stats.toleratedStrips = 0;
            var mayBeEmpty = tolerancePolicy(plan, area, n);
            var reader = makeReader(doc.id, plan, area, stats, ctx, pool);
            var report = progressReporter(ctx, args.onProgress);
            var any = false;
            var t = now();
            for (var i = 0; i < n; i++) {
              var y0 = i * rows, h = Math.min(rows, H - y0);
              var s = await reader.read(y0, h, { pass: 1, tolerate: mayBeEmpty(i) });
              if (s.hadData) any = true;
              if (s.tolerated) stats.toleratedStrips++;
              b.push(s.data, s.components, y0, h);
              report((i + 1) / n, "предпросмотр");
              await checkpoint(ctx);
            }
            if (!any && reader.firstError) throw reader.firstError;
            stats.timings.read = now() - t;

            await unhideAfterRead(doc, hideState);

            t = now();
            proxy = b.finish();
            stats.timings.finish = now() - t;
          } finally {
            if (ctx && ctx.isCancelled) outcome.cancelled = true;
          }
        }, "Halation: предпросмотр");
      } catch (err) {
        var e = classifyError(err, outcome);
        stats.timings.total = now() - t0;
        stats.cancelled = isCancelError(e);
        stats.error = errorText(e);
        attach(e, "halationStats", stats);
        throw e;
      }
      stats.ok = true;
      stats.timings.total = now() - t0;
      stats.proxySize = proxy ? proxy.width + "×" + proxy.height : "?";
      return { proxy: proxy, docLongSide: plan.docLongSide, label: plan.label, plan: plan, stats: stats };
    }

    /** Fallback preview display: JPEG data URL via imaging.encodeImageData. */
    async function encodePreviewJpeg(img) {
      var data = await imaging.createImageDataFromBuffer(img.data, {
        width: img.width,
        height: img.height,
        components: 3,
        chunky: true,
        colorSpace: "RGB",
        colorProfile: SRGB_PROFILE
      });
      try {
        var b64 = await imaging.encodeImageData({ imageData: data, base64: true });
        return "data:image/jpeg;base64," + b64;
      } finally {
        if (data && typeof data.dispose === "function") data.dispose();
      }
    }

    // ---- colour picker (doc §6.1)

    async function pickColor(rgb) {
      rgb = rgb || [255, 144, 39];
      var raw = null, error = null;
      try {
        await runModal(async function () {
          raw = await action.batchPlay([{
            _obj: "showColorPicker",
            _target: [{ _ref: "application" }],
            color: { _obj: "RGBColor", red: rgb[0], grain: rgb[1], blue: rgb[2] }
          }], {});
        }, "Halation: цвет", { interactive: true });
      } catch (e) {
        error = e; // outside the modal scope: an exception means "cancelled"
      }
      var parsed = error || !colorUtils
        ? { rgb: null, cancelled: true, format: error ? "exception" : "no parser" }
        : colorUtils.parseColorPickerResult(raw);
      return {
        rgb: parsed.rgb,
        cancelled: parsed.cancelled,
        format: parsed.format,
        raw: raw,
        error: error,
        busy: !!error && isModalBusyError(error)
      };
    }

    // ---- change notifications: only mark the preview stale, never touch Photoshop

    var WATCH_EVENTS = ["select", "open", "close", "make", "delete", "duplicate", "move", "set", "paste",
      "placedLayerEditContents", "newPlacedLayer", "mergeLayersNew", "mergeVisible", "flattenImage",
      "convertMode", "rasterizeLayer", "transform", "fill", "canvasSize", "imageSize", "crop"];

    function watchChanges(cb) {
      if (!action || typeof action.addNotificationListener !== "function") return function () {};
      var handler = function (eventName, descriptor) {
        if (isRelevantEvent(eventName, descriptor)) cb(eventName);
      };
      var p = safe(function () { return action.addNotificationListener(WATCH_EVENTS, handler); });
      if (p && typeof p.catch === "function") p.catch(function (e) { log("addNotificationListener: " + errorText(e)); });
      return function () {
        safe(function () { return action.removeNotificationListener(WATCH_EVENTS, handler); });
      };
    }

    return {
      getHostInfo: getHostInfo,
      inspect: inspect,
      activeLayerInfo: activeLayerInfo,
      peek: peek,
      readRegion: readRegion,
      apply: apply,
      buildPreview: buildPreview,
      encodePreviewJpeg: encodePreviewJpeg,
      pickColor: pickColor,
      watchChanges: watchChanges,
      describeError: describeError,
      _results: results,
      _resultSource: resultSource
    };
  }

  return {
    createBridge: createBridge,
    describeError: describeError,
    isCancelError: isCancelError,
    isModalBusyError: isModalBusyError,
    placeStrip: placeStrip,
    extractRect: extractRect,
    intersect: intersect,
    normBounds: normBounds,
    parseVersion: parseVersion,
    isLeakyVersion: isLeakyVersion,
    isRelevantEvent: isRelevantEvent,
    ScratchPool: ScratchPool,
    SRGB_PROFILE: SRGB_PROFILE,
    WEIGHTS: WEIGHTS
  };
});
