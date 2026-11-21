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

  function isCancelError(err) {
    if (!err) return false;
    if (err.halationCancelled) return true;
    if (err.name === "AbortError") return true;
    if (err.number === -128 || err.code === -128) return true;
    return /cancel|отмен/i.test(errorText(err));
  }

  function isModalBusyError(err) {
    if (!err || isCancelError(err)) return false;
    return /modal|busy|занят/i.test(errorText(err));
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

    var pairs = new Map();        // sourceKey ("doc:layerId" | "doc:composite") -> resultId
    var resultSource = new Map(); // "doc:resultId" -> sourceLayerId | "composite"

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

    function existingLayerId(doc, id) {
      if (id === undefined || id === null) return null;
      return findLayerById(doc, id) ? id : null;
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

    async function inspect(opts) {
      opts = opts || {};
      var t0 = now();
      var rep = {
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

      rep.plans.composite = {
        mode: "composite",
        docId: d.id,
        area: docBounds,
        docLongSide: docLongSide,
        sourceKey: compKey,
        previousResultId: opts.replacePrevious ? existingLayerId(doc, pairs.get(compKey)) : null,
        reselectId: activeLayer ? activeLayer.id : null,
        label: "видимое изображение"
      };

      if (active.length > 1) {
        rep.notes.push("Выбрано несколько слоёв (" + active.length + ") — обрабатывается «" +
          (safe(function () { return activeLayer.name; }) || "") + "».");
      }

      var sourceLayer = activeLayer;
      if (activeLayer) {
        var rs = resultSource.get(key(d.id, activeLayer.id));
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
            resultSource.delete(key(d.id, activeLayer.id));
            rep.warnings.push("Исходный слой этого результата не найден — будет обработан сам слой результата.");
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
        previousResultId: opts.replacePrevious ? existingLayerId(doc, pairs.get(srcKey)) : null,
        reselectId: sourceLayer.id,
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
            if (o && o.expectData) throw err;
            // Deliberate, narrow exception: Photoshop may report an entirely transparent
            // strip as an error instead of an empty result (doc §5.5: an empty strip is
            // not an error). The strip is treated as empty and logged; if every strip
            // fails, the caller rethrows the first error, and a strip that had data in
            // pass 1 must not fail in pass 2 (expectData).
            stats.toleratedErrors++;
            if (stats.toleratedMessages.length < 5) stats.toleratedMessages.push("y=" + req.top + ": " + errorText(err));
            if (!R.firstError) R.firstError = err;
            log("getPixels: ошибка на полосе y=" + req.top + " считается пустой полосой: " + errorText(err));
            return emptyStrip(h);
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

    async function createResultLayer(doc, plan) {
      var layer;
      if (typeof doc.createPixelLayer === "function") {
        layer = await doc.createPixelLayer({ name: RESULT_LAYER_NAME });
      } else if (typeof doc.createLayer === "function") {
        log("createPixelLayer недоступен — используется createLayer");
        layer = await doc.createLayer({ name: RESULT_LAYER_NAME });
      } else {
        throw new Error("В этой версии Photoshop нет createPixelLayer");
      }
      if (!layer) throw new Error("Photoshop не вернул созданный слой");
      if (plan.mode === "layer") {
        var src = findLayerById(doc, plan.sourceLayerId);
        if (!src) throw new Error("Исходный слой не найден");
        await layer.move(src, placeBefore());
      } else {
        var top = toArray(safe(function () { return doc.layers; }))[0];
        if (top && top.id !== layer.id) await layer.move(top, placeBefore());
      }
      return layer;
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

    function chooseRows(proc, W, H) {
      var r = stripRowsOverride || Math.floor(num(proc.stripRows));
      if (!(r >= 1)) r = Math.max(1, Math.floor(PREVIEW_STRIP_PIXELS / W));
      return Math.max(1, Math.min(r, H));
    }

    function procStats(proc) {
      if (!proc) return null;
      return safe(function () { return proc.stats; }) || null;
    }

    // ---- apply (doc §6.2, §5.5-5.6)

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
      try {
        await runModal(async function (ctx) {
          var doc = activeDocChecked(plan.docId);
          var hc = ctx && ctx.hostControl;
          var suspension = null;
          if (hc && typeof hc.suspendHistory === "function") {
            suspension = await hc.suspendHistory({ documentID: doc.id, name: RESULT_LAYER_NAME });
          }
          var report = progressReporter(ctx, args.onProgress);
          stats.layerOrder = { before: topLevelIds(doc), after: null };

          // The previous result goes away in the same history step. Before reading,
          // so a composite read does not include it.
          if (plan.previousResultId !== null && plan.previousResultId !== undefined) {
            var old = findLayerById(doc, plan.previousResultId);
            if (old) {
              await old.delete();
              stats.deletedPreviousId = plan.previousResultId;
            }
          }

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
          var reader = makeReader(doc.id, plan, area, stats, ctx, pool);
          var had = new Array(nStrips);
          var i, y0, h;

          // Pass 1: read strips, linearize and accumulate into the base grid.
          var t = now();
          for (i = 0; i < nStrips; i++) {
            y0 = i * rows;
            h = Math.min(rows, H - y0);
            var s1 = await reader.read(y0, h, { pass: 1 });
            had[i] = s1.hadData;
            proc.pass1(s1.data, s1.components, y0, h);
            report(WEIGHTS.read * (i + 1) / nStrips, "чтение");
            await checkpoint(ctx);
          }
          stats.timings.read = now() - t;
          if (had.indexOf(true) < 0) {
            if (reader.firstError) throw reader.firstError;
            throw nothingToDoError("В области слоя нет пикселей — нечего обрабатывать.");
          }

          // Blur on the pyramid, yielding between steps.
          t = now();
          for (var prog of proc.blurSteps()) {
            report(WEIGHTS.read + WEIGHTS.blur * clamp01(prog), "размытие");
            await checkpoint(ctx);
          }
          stats.timings.blur = now() - t;

          // New layer right above the source (or on top for the composite).
          t = now();
          var layer = await createResultLayer(doc, plan);
          resultId = layer.id;
          stats.timings.layer = now() - t;

          // Pass 2: re-read the same strips and write the output.
          t = now();
          for (i = 0; i < nStrips; i++) {
            y0 = i * rows;
            h = Math.min(rows, H - y0);
            var s2 = await reader.read(y0, h, { pass: 2, expectData: had[i] });
            var out = pool.get("out", h * W * s2.components);
            proc.pass2(s2.data, s2.components, y0, h, out);
            if (s2.hadData) await writeStrip(doc.id, resultId, out, W, s2, area, y0, reader.meta, stats, pool);
            report(WEIGHTS.read + WEIGHTS.blur + WEIGHTS.write * (i + 1) / nStrips, "запись");
            await checkpoint(ctx);
          }
          stats.timings.write = now() - t;

          // The source becomes active again before leaving the modal scope.
          var reselect = plan.reselectId !== null && plan.reselectId !== undefined && findLayerById(doc, plan.reselectId)
            ? plan.reselectId : resultId;
          await selectLayer(reselect);
          stats.reselectedId = reselect;
          stats.layerOrder.after = topLevelIds(doc);

          if (suspension !== null && suspension !== undefined) await hc.resumeHistory(suspension, true);
        }, COMMAND_NAME);
      } catch (err) {
        // Outside the modal scope: Photoshop has already rolled the document back.
        stats.timings.total = now() - t0;
        stats.cancelled = isCancelError(err);
        stats.error = errorText(err);
        stats.coreStats = procStats(proc);
        attach(err, "halationStats", stats);
        throw err;
      }
      stats.ok = true;
      stats.timings.total = now() - t0;
      stats.coreStats = procStats(proc);
      if (resultId !== null) {
        if (stats.deletedPreviousId !== undefined) resultSource.delete(key(plan.docId, stats.deletedPreviousId));
        pairs.set(plan.sourceKey, resultId);
        resultSource.set(key(plan.docId, resultId), plan.mode === "composite" ? "composite" : plan.sourceLayerId);
      }
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
      try {
        await runModal(async function (ctx) {
          var doc = activeDocChecked(plan.docId);
          var area = plan.area;
          var W = rectW(area), H = rectH(area);
          var b = core.createPreviewBuilder({ width: W, height: H, maxLongSide: maxLongSide });
          var rows = Math.max(1, Math.min(H, stripRowsOverride || Math.floor(PREVIEW_STRIP_PIXELS / W)));
          var n = Math.ceil(H / rows);
          stats.strips = n;
          stats.stripRows = rows;
          var reader = makeReader(doc.id, plan, area, stats, ctx, pool);
          var report = progressReporter(ctx, args.onProgress);
          var any = false;
          var t = now();
          for (var i = 0; i < n; i++) {
            var y0 = i * rows, h = Math.min(rows, H - y0);
            var s = await reader.read(y0, h, { pass: 1 });
            if (s.hadData) any = true;
            b.push(s.data, s.components, y0, h);
            report((i + 1) / n, "предпросмотр");
            await checkpoint(ctx);
          }
          if (!any && reader.firstError) throw reader.firstError;
          stats.timings.read = now() - t;
          t = now();
          proxy = b.finish();
          stats.timings.finish = now() - t;
        }, "Halation: предпросмотр");
      } catch (err) {
        stats.timings.total = now() - t0;
        stats.cancelled = isCancelError(err);
        stats.error = errorText(err);
        attach(err, "halationStats", stats);
        throw err;
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
      apply: apply,
      buildPreview: buildPreview,
      encodePreviewJpeg: encodePreviewJpeg,
      pickColor: pickColor,
      watchChanges: watchChanges,
      describeError: describeError,
      _pairs: pairs,
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
