/* Halation panel: UI wiring (UXP).
 *
 * Start-up runs from the panel "show" callback, not from plugin.create (doc §6.3).
 * Photoshop is touched only on show, on "Обновить", on "Палитра…" and on "Применить";
 * document and layer changes only mark the preview stale (doc §6.1).
 */
(function () {
  "use strict";

  var PLUGIN_VERSION = "1.1.0"; // checked against manifest.json by tools/build-ccx.mjs
  var PANEL_ID = "halationPanel";
  var PREVIEW_MAX_SIDE = 500;
  // Two-stage preview (src/core/API.md): a half-size draft while something moves,
  // the full render once the user stops.
  var DRAFT_DEBOUNCE_MS = 100;
  var FULL_AFTER_INPUT_MS = 300;
  var FULL_AFTER_CHANGE_MS = 30;
  var SAVE_DEBOUNCE_MS = 300;
  var SHOW_FALLBACK_MS = 3000;
  var PREVIEW_BOX_H = 280;      // fixed preview box height, keep in sync with .preview-wrap
  var LOUPE_DEBOUNCE_MS = 150;  // loupe re-render after a setting change
  var RESIZE_MIN_DELTA = 8;     // window-resize width changes below this are ignored

  function tryRequire(name) {
    try {
      return typeof require === "function" ? require(name) : null;
    } catch (e) {
      return null;
    }
  }

  function $(id) {
    return document.getElementById(id);
  }

  function nowMs() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }

  function show(el, visible) {
    if (!el) return;
    if (visible) el.classList.remove("is-hidden");
    else el.classList.add("is-hidden");
  }

  function setDisabled(el, disabled) {
    if (!el) return;
    if (disabled) el.setAttribute("disabled", "");
    else el.removeAttribute("disabled");
  }

  // Value of a radio group: the radio the event came from, else the checked radio,
  // else the group's own "selected" (exact UXP behaviour is uncertain, so all three).
  function radioValue(group, evt) {
    if (!group) return null;
    var radios = group.querySelectorAll("sp-radio");
    var values = [];
    for (var i = 0; i < radios.length; i++) values.push(radios[i].getAttribute("value"));
    var t = evt && evt.target;
    if (t && t !== group && t.tagName && String(t.tagName).toLowerCase() === "sp-radio") {
      var tv = t.getAttribute("value");
      if (values.indexOf(tv) >= 0) return tv;
    }
    for (var j = 0; j < radios.length; j++) {
      if (radios[j].checked) return radios[j].getAttribute("value");
    }
    var sel = group.selected;
    if (typeof sel === "string" && values.indexOf(sel) >= 0) return sel;
    return null;
  }

  function setRadio(group, value) {
    if (!group) return;
    var radios = group.querySelectorAll("sp-radio");
    for (var i = 0; i < radios.length; i++) {
      var on = radios[i].getAttribute("value") === value;
      radios[i].checked = on;
      if (on) radios[i].setAttribute("checked", "");
      else radios[i].removeAttribute("checked");
    }
    // Only when the widget has the property: an expando would go stale after a click.
    if ("selected" in group) {
      try {
        group.selected = value;
      } catch (e) { /* read-only in some UXP versions */ }
    }
  }

  function safeStorage() {
    try {
      return window.localStorage || null;
    } catch (e) {
      return null;
    }
  }

  var uxp = tryRequire("uxp");
  var photoshop = tryRequire("photoshop");
  var osMod = tryRequire("os");
  var core = window.HalationCore;
  var Color = window.HalationColor;
  var Bridge = window.HalationBridge;
  var Editor = window.HalationCurveEditor;
  var Store = window.HalationSettingsStore;
  var Loupe = window.HalationLoupe;
  var diag = window.HalationDiagnostics.create({ pluginVersion: PLUGIN_VERSION });

  var state = {
    initialized: false,
    showCount: 0,
    settings: null,
    ui: null,
    store: null,
    bridge: null,
    editor: null,
    proxy: null,
    proxyDocLongSide: 0,
    proxyLabel: "",
    previewStale: true,
    busy: false,
    quietUntil: 0,
    draftTimer: null,
    fullTimer: null,
    lastFullKey: null,
    saveTimer: null,
    diagTimer: null,
    blobUrl: null,
    imageBlobFailed: false,
    displaySeq: 0,
    memoryWarned: false,
    pendingConfirm: null,
    previewPlan: null,      // source of the preview cache, reused by the loupe
    previewDisplay: null,   // { dw, dh } of the frame thumbnail, for clicks and the frame overlay
    loupe: { center: null, raw: null, timer: null, needsRead: false },
    presets: [],            // user presets from the settings store
    presetValue: null,      // selected picker value: "look:<id>" | "user:<name>"
    maskChoice: null,       // "Только в выделении": null = default (on), else the user's choice
    layerSettings: null,    // settings carried by the active layer's name
    lastWindowWidth: null
  };

  // ------------------------------------------------------------------ status

  function showStatus(kind, text) {
    var el = $("status");
    if (!el) return;
    el.className = "message" + (kind === "ok" ? " message-ok" : kind === "warn" ? " message-warn" : kind === "error" ? " message-error" : "");
    el.textContent = text;
    show(el, !!text);
  }

  function setMessage(id, text) {
    var el = $(id);
    if (!el) return;
    el.textContent = text || "";
    show(el, !!text);
  }

  function setBusy(busy, label) {
    state.busy = busy;
    if (!busy) state.quietUntil = nowMs() + 800;
    if (!busy && state.loupe && state.loupe.needsRead && state.ui && state.ui.previewMode === "loupe") {
      // An update skipped while the panel was busy runs now (review М5).
      setTimeout(function () { if (!state.busy) updateLoupe(true, "после занятости"); }, 0);
    }
    var apply = $("btn-apply");
    setDisabled(apply, busy);
    if (apply) apply.textContent = busy && label ? label : "Применить";
    setDisabled($("btn-refresh"), busy);
    setDisabled($("btn-pick-color"), busy);
  }

  // ------------------------------------------------------------------ settings

  function scheduleSave() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () {
      state.saveTimer = null;
      if (state.store) state.store.save(state.settings, state.ui);
      diag.set("settings", state.settings);
    }, SAVE_DEBOUNCE_MS);
  }

  // stage: "draft" while a control is moving (input events), "full" on change.
  function updateSettings(patch, stage) {
    var next = {};
    var k;
    for (k in state.settings) if (Object.prototype.hasOwnProperty.call(state.settings, k)) next[k] = state.settings[k];
    for (k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = patch[k];
    state.settings = core.normalizeSettings(next);
    scheduleSave();
    scheduleRender(stage === "draft" ? "draft" : "full");
  }

  // Only the visible view is recomputed: the frame preview or the loupe.
  function scheduleRender(stage) {
    if (state.ui && state.ui.previewMode === "loupe") scheduleLoupe(stage);
    else schedulePreview(stage);
  }

  function updateUi(patch) {
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) state.ui[k] = patch[k];
    scheduleSave();
  }

  // ------------------------------------------------------------------ theme

  function currentTheme() {
    try {
      return document.theme && typeof document.theme.getCurrent === "function" ? document.theme.getCurrent() : null;
    } catch (e) {
      return null;
    }
  }

  function isLightTheme() {
    var t = currentTheme();
    return t === "light" || t === "lightest";
  }

  function applyTheme() {
    var t = currentTheme() || "dark";
    document.body.className = "theme-" + t;
    if (state.editor) state.editor.setColors(isLightTheme() ? Editor.LIGHT : Editor.DARK);
  }

  function watchTheme() {
    try {
      if (document.theme && document.theme.onUpdated && document.theme.onUpdated.addListener) {
        document.theme.onUpdated.addListener(function () { applyTheme(); });
      }
    } catch (e) {
      diag.log("Нет подписки на смену темы: " + e.message);
    }
  }

  // ------------------------------------------------------------------ controls

  // ×0.010 … ×4.00: three decimals below 0.1, two above.
  function formatBlur(m) {
    return "×" + (m < 0.1 ? m.toFixed(3) : m.toFixed(2));
  }

  function parseFieldNumber(text) {
    var t = String(text === undefined || text === null ? "" : text).replace(/[×x%\s]/gi, "").replace(",", ".");
    if (!t) return NaN;
    return Number(t);
  }

  // Numeric fields next to the sliders (v1.1): range, settings patch and display.
  var NUMBER_FIELDS = {
    "blur-field": {
      min: 0.01, max: 4, label: "Размытие",
      patch: function (v) { return { blurMul: v }; },
      text: function (s) { return formatBlur(s.blurMul); }
    },
    "strength-field": {
      min: 0, max: 400, label: "Сила",
      patch: function (v) { return { strength: v }; },
      text: function (s) { return Math.round(s.strength) + " %"; }
    },
    "threshold-field": {
      min: 0, max: 255, label: "Порог",
      patch: function (v) { return { threshold: Math.round(v) }; },
      text: function (s) { return String(Math.round(s.threshold)); }
    },
    "softness-field": {
      min: 0, max: 255, label: "Плавность",
      patch: function (v) { return { softness: Math.round(v) }; },
      text: function (s) { return String(Math.round(s.softness)); }
    }
  };

  function setField(id, text) {
    var el = $(id);
    if (!el) return;
    el.value = text;
    el.setAttribute("value", text);
  }

  function renderSliders() {
    var s = state.settings;
    $("blur-slider").value = Math.round(core.blurToSlider(s.blurMul) * 10) / 10;
    $("strength-slider").value = s.strength;
    $("threshold-slider").value = s.threshold;
    $("softness-slider").value = s.softness;
    renderSliderLabels();
  }

  function renderSliderLabels() {
    var s = state.settings;
    // review v1.1 С5: above 100 % thin dark details next to light ones glow too
    show($("strength-hint"), s.strength > 100);
    for (var id in NUMBER_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(NUMBER_FIELDS, id)) setField(id, NUMBER_FIELDS[id].text(s));
    }
  }

  function commitNumberField(id) {
    var f = NUMBER_FIELDS[id];
    var v = parseFieldNumber($(id).value);
    if (!isFinite(v)) {
      setMessage("slider-message", f.label + ": введите число от " + f.min + " до " + f.max + ".");
      renderSliderLabels();
      return;
    }
    var clamped = Math.min(f.max, Math.max(f.min, v));
    setMessage("slider-message", clamped !== v ? f.label + ": значение ограничено диапазоном " + f.min + "–" + f.max + "." : "");
    updateSettings(f.patch(clamped), "full");
    renderSliders();
  }

  function renderMode() {
    var mode = state.settings.mode;
    var curve = mode === "curve";
    setRadio($("mode-group"), mode);
    show($("curve-section"), curve);
    show($("reinhard-section"), mode === "reinhard");
    if (curve && state.editor) state.editor.resize();
    renderReinhard();
  }

  // Limit slider 0..100 on a log scale: 1.01 .. 4.0 (default 1.1 at ~40).
  var REINHARD_MIN = 1.01;
  var REINHARD_MAX = 4;
  function limitFromSlider(u) {
    var t = Math.min(100, Math.max(0, Number(u) || 0)) / 100;
    return 1 + (REINHARD_MIN - 1) * Math.pow((REINHARD_MAX - 1) / (REINHARD_MIN - 1), t);
  }
  function sliderFromLimit(limit) {
    var l = Math.min(REINHARD_MAX, Math.max(REINHARD_MIN, Number(limit) || 1.1));
    return (100 * Math.log((l - 1) / (REINHARD_MIN - 1))) / Math.log((REINHARD_MAX - 1) / (REINHARD_MIN - 1));
  }
  function renderReinhardLabels() {
    var l = state.settings.reinhardLimit;
    var headroom = l / (l - 1);
    $("reinhard-value").textContent = l.toFixed(2);
    $("reinhard-hint").textContent = "Как 8-битный режим гизмо Halation для Nuke: обратная кривая Reinhard возвращает светам запас над белым. Код 255 ярче белого в ×" +
      (headroom >= 10 ? Math.round(headroom) : headroom.toFixed(1)) + ".";
  }
  function renderReinhard() {
    $("reinhard-slider").value = Math.round(sliderFromLimit(state.settings.reinhardLimit));
    renderReinhardLabels();
  }

  var METHOD_HINTS = {
    excess: "Свечение только с тёмной стороны границ; светлое и источники не меняются.",
    normalized: "Как hotgluebanjo/halation-dctl: энергия сохраняется, но светлые края и мелкие источники теряют красный (голубоватая кайма). Лучше вместе с режимом «8 бит → scene-linear»."
  };
  function renderMethod() {
    var m = state.settings.model;
    setRadio($("method-group"), m);
    $("method-hint").textContent = METHOD_HINTS[m] || "";
  }

  function renderColor() {
    var rgb = state.settings.color;
    $("color-swatch").style.backgroundColor = Color.rgbToCss(rgb);
    $("color-hex").textContent = Color.rgbToHex(rgb) + "  (" + rgb.join(", ") + ")";
  }

  function syncHsvSliders() {
    var hsv = Color.rgbToHsv(state.settings.color);
    $("hue-slider").value = hsv[0];
    $("sat-slider").value = hsv[1];
    $("val-slider").value = hsv[2];
    renderHsvLabels(hsv);
  }

  function renderHsvLabels(hsv) {
    $("hue-value").textContent = Math.round(hsv[0]) + "°";
    $("sat-value").textContent = String(Math.round(hsv[1]));
    $("val-value").textContent = String(Math.round(hsv[2]));
  }

  function renderView() {
    setRadio($("view-group"), state.ui.view);
    show($("halo-caption"), state.ui.view === "halo");
  }

  function setColor(rgb, source, stage) {
    var c = [Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2])];
    if (!core.colorGains(c)) {
      setMessage("color-message", "Цвет " + Color.rgbToHex(c) + " слишком тёмный: самый яркий канал после перевода в линейную гамму меньше 1/255. Выберите более яркий цвет.");
      return false;
    }
    var same = c[0] === state.settings.color[0] && c[1] === state.settings.color[1] && c[2] === state.settings.color[2];
    updateSettings({ color: c }, stage);
    renderColor();
    if (source !== "hsv") syncHsvSliders();
    setMessage("color-message", "");
    if (!same && stage !== "draft") diag.log("Цвет ореола " + Color.rgbToHex(c) + " (" + source + ")");
    return true;
  }

  function buildPresets() {
    var box = $("color-presets");
    box.innerHTML = "";
    Color.PRESETS.forEach(function (p) {
      var el = document.createElement("div");
      el.className = "preset";
      el.title = Color.rgbToHex(p.rgb);
      var dot = document.createElement("div");
      dot.className = "preset-dot";
      dot.style.backgroundColor = Color.rgbToCss(p.rgb);
      var label = document.createElement("span");
      label.textContent = p.name;
      el.appendChild(dot);
      el.appendChild(label);
      el.addEventListener("click", function () { setColor(p.rgb, "пресет «" + p.name + "»"); });
      box.appendChild(el);
    });
  }

  function onHsvEvent(stage) {
    var h = Number($("hue-slider").value);
    var s = Number($("sat-slider").value);
    var v = Number($("val-slider").value);
    renderHsvLabels([h, s, v]);
    setColor(Color.hsvToRgb(h, s, v), "hsv", stage);
  }

  async function onPickColor() {
    if (!state.bridge || state.busy) return;
    setDisabled($("btn-pick-color"), true);
    try {
      var res = await state.bridge.pickColor(state.settings.color);
      diag.set("colorRaw", res.raw !== null && res.raw !== undefined ? res.raw : res.error ? "исключение: " + res.error.message : null);
      diag.set("colorParsed", { rgb: res.rgb, cancelled: res.cancelled, format: res.format });
      diag.log("Палитра: " + (res.cancelled ? "отмена" : Color.rgbToHex(res.rgb)) + ", формат: " + res.format);
      if (res.error) diag.error(res.error, "showColorPicker");
      if (res.busy) {
        setMessage("color-message", Bridge.describeError(res.error).text);
        return;
      }
      if (res.cancelled || !res.rgb) {
        if (res.error) {
          setMessage("color-message", "Палитра Photoshop не открылась — выберите цвет вручную ниже.");
          toggleManual(true);
        }
        return;
      }
      setColor(res.rgb, "палитра");
    } finally {
      setDisabled($("btn-pick-color"), state.busy);
    }
  }

  function toggleManual(force) {
    var box = $("color-manual");
    var open = typeof force === "boolean" ? force : box.classList.contains("is-hidden");
    show(box, open);
    $("btn-color-manual").textContent = open ? "Вручную ▾" : "Вручную ▸";
    if (open) syncHsvSliders();
  }

  // ------------------------------------------------------------------ curve editor

  function createEditor() {
    state.editor = new Editor({
      canvas: $("curve-canvas"),
      core: core,
      points: state.settings.curvePoints,
      yAxis: state.ui.yAxis,
      xLabels: $("curve-x-labels"),
      yLabels: $("curve-y-labels"),
      xField: $("point-x"),
      yField: $("point-y"),
      height: 170,
      colors: isLightTheme() ? Editor.LIGHT : Editor.DARK,
      onChange: function (points, info) {
        var final = !!(info && info.final);
        updateSettings({ curvePoints: points }, final ? "full" : "draft");
        if (final) setMessage("curve-message", "");
      },
      onReject: function (reason) {
        setMessage("curve-message", "Правка отклонена: " + reason);
      },
      onLog: function (msg) { diag.log(msg); }
    });
  }

  // ------------------------------------------------------------------ preview

  function setPreviewPlaceholder(text) {
    var ph = $("preview-placeholder");
    ph.textContent = text;
    show(ph, true);
    show($("preview-img"), false);
  }

  function updateStaleLabel() {
    show($("preview-stale"), !!state.proxy && state.previewStale);
    if (state.ui && state.ui.previewMode === "loupe") return; // the loupe writes its own caption
    $("preview-source").textContent = state.proxy ? "Источник: " + state.proxyLabel : "";
  }

  function markStale(reason) {
    if (!state.proxy || state.previewStale) {
      state.previewStale = true;
      return;
    }
    state.previewStale = true;
    diag.log("Предпросмотр устарел: " + reason);
    updateStaleLabel();
  }

  function clearPreviewTimers() {
    if (state.draftTimer) clearTimeout(state.draftTimer);
    if (state.fullTimer) clearTimeout(state.fullTimer);
    state.draftTimer = null;
    state.fullTimer = null;
  }

  /* "draft": half-size render 100 ms after the last input event, full render
   * 300 ms after it. "full": full render right away (change events). */
  function schedulePreview(stage) {
    if (!state.proxy) return;
    clearPreviewTimers();
    if (stage === "draft") {
      state.draftTimer = setTimeout(function () {
        state.draftTimer = null;
        renderPreviewNow(true);
      }, DRAFT_DEBOUNCE_MS);
      state.fullTimer = setTimeout(function () {
        state.fullTimer = null;
        renderPreviewNow(false);
      }, FULL_AFTER_INPUT_MS);
    } else {
      state.fullTimer = setTimeout(function () {
        state.fullTimer = null;
        renderPreviewNow(false);
      }, FULL_AFTER_CHANGE_MS);
    }
  }

  function renderKey() {
    return JSON.stringify([state.settings, state.ui.view, state.proxyDocLongSide]);
  }

  function renderPreviewNow(draft) {
    if (!state.proxy) return;
    if (state.ui.previewMode === "loupe") return; // only the visible view is computed
    var keyNow = renderKey();
    if (!draft && keyNow === state.lastFullKey) return; // already showing this full render
    var t0 = nowMs();
    var img;
    try {
      img = core.renderPreview(state.proxy, state.settings, state.ui.view, {
        docLongSide: state.proxyDocLongSide,
        draft: !!draft
      });
    } catch (e) {
      diag.error(e, "renderPreview" + (draft ? " (черновик)" : ""));
      setPreviewPlaceholder("Ошибка расчёта предпросмотра — см. «Диагностика».");
      return;
    }
    var renderMs = nowMs() - t0;
    state.lastFullKey = draft ? null : keyNow;
    displayPreview(img).then(function (how) {
      var p = diag.info.preview;
      if (p) {
        if (draft) p.draftMs = renderMs;
        else p.renderMs = renderMs;
        p.display = how || "не показан";
        diag.set("preview", p);
      }
    });
  }

  function makeImageBlob(img) {
    var opts = {
      width: img.width,
      height: img.height,
      colorSpace: "RGB",
      colorProfile: "",
      pixelFormat: "RGB",
      components: 3,
      componentSize: 8,
      hasAlpha: false,
      type: "image/uncompressed"
    };
    try {
      return new ImageBlob(img.data, opts);
    } catch (e) {
      diag.log("ImageBlob не принял Uint8Array, пробую ArrayBuffer: " + e.message);
      var d = img.data;
      return new ImageBlob(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength), opts);
    }
  }

  // fit: displayed size { w, h } in CSS px (the loupe); default: the proxy fitted to the box.
  async function displayPreview(img, fit) {
    var seq = ++state.displaySeq;
    var url = null;
    var how = null;
    if (!state.imageBlobFailed && typeof ImageBlob === "function" && typeof URL !== "undefined" && URL.createObjectURL) {
      try {
        url = URL.createObjectURL(makeImageBlob(img));
        how = "ImageBlob";
      } catch (e) {
        state.imageBlobFailed = true;
        diag.error(e, "ImageBlob (переход на encodeImageData)");
      }
    }
    if (!url && state.bridge) {
      try {
        url = await state.bridge.encodePreviewJpeg(img);
        how = "encodeImageData";
      } catch (e) {
        diag.error(e, "encodeImageData");
      }
    }
    if (seq !== state.displaySeq) {
      if (how === "ImageBlob") URL.revokeObjectURL(url);
      return how;
    }
    if (!url) {
      setPreviewPlaceholder("Не удалось показать предпросмотр — см. «Диагностика».");
      return null;
    }
    var el = $("preview-img");
    var old = state.blobUrl;
    el.src = url;
    state.blobUrl = how === "ImageBlob" ? url : null;
    if (old) {
      try { URL.revokeObjectURL(old); } catch (e) { /* already revoked */ }
    }
    if (fit) {
      setImgSize(fit.w, fit.h);
    } else {
      // Draft (half-size) and full images are scaled into the same box: the proxy's.
      sizePreview(state.proxy ? state.proxy.width : img.width, state.proxy ? state.proxy.height : img.height);
    }
    updateFrameOverlay();
    show($("preview-placeholder"), false);
    show(el, true);
    updateStaleLabel();
    return how;
  }

  /** Inner size of the fixed preview box in CSS px. */
  function boxSize() {
    var wrap = $("preview-wrap");
    return { w: Math.max(120, (wrap && wrap.clientWidth ? wrap.clientWidth : 280) - 2), h: PREVIEW_BOX_H - 2 };
  }

  function fitToBox(w, h) {
    var b = boxSize();
    var scale = Math.min(b.w / w, b.h / h);
    return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
  }

  function setImgSize(dw, dh) {
    var el = $("preview-img");
    el.width = dw;
    el.height = dh;
    el.style.width = dw + "px";
    el.style.height = dh + "px";
  }

  function sizePreview(w, h) {
    var f = fitToBox(w, h);
    setImgSize(f.w, f.h);
    state.previewDisplay = f;
  }

  async function rebuildPreview(reason) {
    if (!state.bridge) {
      setPreviewPlaceholder("Предпросмотр работает только в Photoshop.");
      return;
    }
    if (state.busy) return;
    // Busy before the first await, so a second click cannot start a second modal (review М1).
    setBusy(true, "Предпросмотр…");
    var rep;
    try {
      rep = await state.bridge.inspect({ replacePrevious: false });
    } catch (e) {
      diag.error(e, "inspect (предпросмотр)");
      setPreviewPlaceholder("Не удалось прочитать документ — см. «Диагностика».");
      setBusy(false);
      return;
    }
    if (rep.blocking.length || rep.nothingToDo) setBusy(false);
    diag.set("target", rep);
    updateFromLayer(rep.activeLayer);
    updateMaskCheckbox(rep.selection);
    if (rep.blocking.length || rep.nothingToDo) {
      // No source now: drop the frame cache and the loupe's plan and pixels (review М5).
      state.proxy = null;
      state.previewPlan = null;
      state.loupe.raw = null;
      state.loupe.needsRead = false;
      updateStaleLabel();
      setPreviewPlaceholder(rep.blocking.length ? rep.blocking.join(" ") : rep.nothingMessage);
      return;
    }
    var plan = rep.plans.layer || rep.plans.composite;
    var progressEl = $("preview-progress");
    var lastPct = -1;
    progressEl.textContent = "Готовлю предпросмотр…";
    show(progressEl, true);
    if (!state.proxy) setPreviewPlaceholder("Готовлю предпросмотр…");
    try {
      var res = await state.bridge.buildPreview({
        plan: plan,
        maxLongSide: PREVIEW_MAX_SIDE,
        onProgress: function (value) {
          var pct = Math.floor(value * 100);
          if (pct === lastPct) return;
          lastPct = pct;
          progressEl.textContent = "Готовлю предпросмотр… " + pct + " %";
        }
      });
      state.proxy = res.proxy;
      state.proxyDocLongSide = res.docLongSide;
      state.proxyLabel = res.label;
      state.previewStale = false;
      state.lastFullKey = null;
      // The loupe reads the same source; its cache belongs to the old one.
      var c = state.loupe.center;
      if (c && !(c.x >= plan.area.left && c.x < plan.area.right && c.y >= plan.area.top && c.y < plan.area.bottom)) {
        state.loupe.center = null;
      }
      state.previewPlan = plan;
      state.loupe.raw = null;
      diag.set("preview", res.stats);
      diag.log("Предпросмотр построен (" + reason + "): " + res.stats.proxySize + ", " + Math.round(res.stats.timings.total) + " мс");
      progressEl.textContent = "Пересчитываю…";
      // Let the label paint before the (blocking) full render.
      setTimeout(function () {
        show(progressEl, false);
        clearPreviewTimers();
        if (state.ui.previewMode === "loupe") updateLoupe(true, reason);
        else renderPreviewNow(false);
      }, 0);
    } catch (e) {
      show(progressEl, false);
      var d = Bridge.describeError(e);
      if (d.kind === "cancelled") diag.log("Построение предпросмотра отменено");
      else diag.error(e, "buildPreview");
      diag.set("preview", e && e.halationStats ? e.halationStats : null);
      setPreviewPlaceholder(
        d.kind === "busy" ? "Photoshop занят — предпросмотр не построен. Нажмите «Обновить», когда он освободится."
          : d.kind === "cancelled" ? "Построение предпросмотра отменено. Нажмите «Обновить»."
            : d.text
      );
    } finally {
      setBusy(false);
      updateStaleLabel();
    }
  }

  // ------------------------------------------------------------------ loupe (v1.1)
  // A full-resolution region around a chosen point. The raw pixels (view + halo margin)
  // are read once per centre / document / layer; every setting change re-runs
  // core.processImage on the cached pixels at the apply's base level (review С1), so a
  // halo a few pixels wide looks exactly as after «Применить». Geometry: loupe.js.

  function loupeZoom() {
    return Loupe.normZoom(state.ui.zoom);
  }

  function regionRect(region) {
    return { left: region.left, top: region.top, right: region.left + region.width, bottom: region.top + region.height };
  }

  /** Base level «Применить» uses for the work area (core.baseLevelFor). */
  function applyBaseLevel() {
    var a = state.previewPlan && state.previewPlan.area;
    if (!a || typeof core.baseLevelFor !== "function") return 0;
    var l = Number(core.baseLevelFor(a.right - a.left, a.bottom - a.top));
    return isFinite(l) && l > 0 ? Math.floor(l) : 0;
  }

  function loupeViewRect() {
    var plan = state.previewPlan;
    if (!plan || !state.loupe.center) return null;
    return Loupe.viewRect(state.loupe.center, plan.area, boxSize(), loupeZoom());
  }

  function loupeMarginNow() {
    var m = Number(core.loupeMargin(state.settings, state.proxyDocLongSide || 1));
    return isFinite(m) && m > 0 ? Math.ceil(m) : 0;
  }

  function scheduleLoupe(stage) {
    if (state.ui.previewMode !== "loupe") return;
    if (state.loupe.timer) clearTimeout(state.loupe.timer);
    state.loupe.timer = setTimeout(function () {
      state.loupe.timer = null;
      updateLoupe(stage !== "draft", "настройки");
    }, LOUPE_DEBOUNCE_MS);
  }

  /* Render the loupe from the cache. Read from Photoshop only when allowRead is set and
   * the cache does not cover the view plus the current margin (new centre, zoom out,
   * larger blur). Whatever cannot run now (a drag, or the panel is busy) leaves
   * needsRead set; setBusy(false) and the next final change pick it up (review М5). */
  async function updateLoupe(allowRead, reason) {
    if (state.ui.previewMode !== "loupe") return;
    var plan = state.previewPlan;
    if (!plan) {
      state.loupe.needsRead = false;
      setPreviewPlaceholder("Лупа появится после построения предпросмотра — нажмите «Обновить».");
      return;
    }
    if (!state.loupe.center) {
      state.loupe.center = { x: (plan.area.left + plan.area.right) / 2, y: (plan.area.top + plan.area.bottom) / 2 };
    }
    var level = applyBaseLevel();
    var view = loupeViewRect();
    var need = Loupe.readRect(view, loupeMarginNow(), plan.area, level);
    var raw = state.loupe.raw;
    if (!(raw && Loupe.rectContains(regionRect(raw), need))) {
      if (allowRead && !state.busy) {
        if (!(await readLoupe(need, reason))) return;
      } else {
        state.loupe.needsRead = true;
        if (!raw || !Loupe.rectContains(regionRect(raw), view)) return; // nothing usable yet
        // otherwise draw with the margin we have; the read follows
      }
    }
    renderLoupe(view, need, level);
  }

  async function readLoupe(rect, reason) {
    if (!state.bridge) return false;
    if (state.busy) {
      state.loupe.needsRead = true;
      return false;
    }
    setBusy(true, "Лупа…");
    var progressEl = $("preview-progress");
    progressEl.textContent = "Читаю область для лупы…";
    show(progressEl, true);
    try {
      var region = await state.bridge.readRegion({ plan: state.previewPlan, rect: rect });
      state.loupe.raw = region;
      state.loupe.needsRead = false;
      diag.set("loupe", region.stats);
      diag.log("Лупа: прочитано " + region.width + "×" + region.height + " с (" + region.left + ", " + region.top + ") — " + (reason || ""));
      if (region.warning) diag.log("Лупа: " + region.warning);
      return true;
    } catch (e) {
      state.loupe.needsRead = false; // no retry loop on errors
      var d = Bridge.describeError(e);
      if (d.kind === "cancelled") diag.log("Чтение для лупы отменено");
      else diag.error(e, "лупа: readRegion");
      diag.set("loupe", e && e.halationStats ? e.halationStats : null);
      setPreviewPlaceholder(d.kind === "busy" ? "Photoshop занят — лупа не построена. Нажмите «Обновить», когда он освободится." : d.text);
      return false;
    } finally {
      show(progressEl, false);
      setBusy(false);
    }
  }

  function renderLoupe(view, need, level) {
    var raw = state.loupe.raw;
    var have = regionRect(raw);
    var proc = {
      left: Math.max(need.left, have.left),
      top: Math.max(need.top, have.top),
      right: Math.min(need.right, have.right),
      bottom: Math.min(need.bottom, have.bottom)
    };
    var src = Loupe.cropRegion(raw, proc);
    var v = state.ui.view;
    var t0 = nowMs();
    var out;
    try {
      out = v === "before" ? src.data : core.processImage(src.data, src.width, src.height, src.components, state.settings, {
        originX: proc.left,
        originY: proc.top,
        docLongSide: state.proxyDocLongSide,
        baseLevel: level, // the apply's level, not the one a small region would get
        view: v === "halo" ? "halo" : "after"
      });
    } catch (e) {
      diag.error(e, "лупа: processImage");
      setPreviewPlaceholder("Ошибка расчёта лупы — см. «Диагностика».");
      return;
    }
    var ms = nowMs() - t0;
    var zoom = loupeZoom();
    var img = Loupe.displayRgb(out, src.components, src.width, proc, view, zoom);
    var p = diag.info.loupe;
    if (p) {
      p.renderMs = ms;
      p.proxySize = src.width + "×" + src.height + " (обработка, уровень " + level + "), вид " + (view.right - view.left) + "×" + (view.bottom - view.top);
      diag.set("loupe", p);
    }
    var zoomLabel = zoom === 0.5 ? "½" : "×" + zoom;
    $("preview-source").textContent = raw.warning
      ? "Лупа: Photoshop не отдал пиксели этой области — она прозрачна или слой изменился. Нажмите «Обновить»."
      : "Лупа " + zoomLabel + ": x " + view.left + "–" + view.right + ", y " + view.top + "–" + view.bottom + " (" + (state.proxyLabel || "") + ")";
    displayPreview(img, Loupe.displaySize(img, zoom));
  }

  function updateFrameOverlay() {
    var fr = $("loupe-frame");
    if (!fr) return;
    var plan = state.previewPlan, d = state.previewDisplay;
    if (state.ui.previewMode !== "frame" || !state.loupe.center || !plan || !d || !state.proxy) {
      show(fr, false);
      return;
    }
    var view = loupeViewRect();
    var a = plan.area;
    var wrap = $("preview-wrap");
    var cw = wrap && wrap.clientWidth ? wrap.clientWidth : d.w + 2;
    var sx = d.w / (a.right - a.left), sy = d.h / (a.bottom - a.top);
    var offX = (cw - d.w) / 2, offY = (PREVIEW_BOX_H - d.h) / 2; // the image is centred in the box
    fr.style.left = Math.round(offX + (view.left - a.left) * sx) + "px";
    fr.style.top = Math.round(offY + (view.top - a.top) * sy) + "px";
    fr.style.width = Math.max(3, Math.round((view.right - view.left) * sx)) + "px";
    fr.style.height = Math.max(3, Math.round((view.bottom - view.top) * sy)) + "px";
    show(fr, true);
  }

  function renderPreviewMode() {
    var mode = state.ui.previewMode;
    setRadio($("preview-mode-group"), mode);
    setRadio($("zoom-group"), String(loupeZoom()));
    show($("zoom-group"), mode === "loupe");
    $("loupe-hint").textContent = mode === "loupe"
      ? "Лупа. «½» на экране Retina — это 100 % Photoshop (UXP рисует панель в двойном масштабе). Другое место — щелчок по картинке в режиме «Кадр»."
      : "В режиме «Кадр» щёлкните по картинке — там откроется лупа.";
    updateFrameOverlay();
  }

  function setPreviewMode(mode, reason) {
    if (mode !== "frame" && mode !== "loupe") return;
    updateUi({ previewMode: mode });
    renderPreviewMode();
    if (mode === "loupe") {
      updateLoupe(true, reason || "режим «Лупа»");
    } else {
      clearPreviewTimers();
      state.lastFullKey = null;
      if (state.proxy) renderPreviewNow(false);
      updateStaleLabel();
    }
  }

  /** Click on the frame thumbnail: the loupe centre in document coordinates. */
  function onPreviewClick(e) {
    if (state.ui.previewMode !== "frame" || !state.previewPlan || !state.previewDisplay || !state.proxy) return;
    var img = $("preview-img");
    var r = img.getBoundingClientRect();
    var w = r.width || state.previewDisplay.w, h = r.height || state.previewDisplay.h;
    var fx = (e.clientX - r.left) / w, fy = (e.clientY - r.top) / h;
    if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) return;
    var a = state.previewPlan.area;
    state.loupe.center = { x: a.left + fx * (a.right - a.left), y: a.top + fy * (a.bottom - a.top) };
    state.loupe.raw = null; // new centre: read again
    diag.log("Лупа: центр (" + Math.round(state.loupe.center.x) + ", " + Math.round(state.loupe.center.y) + ")");
    setPreviewMode("loupe", "щелчок по кадру");
  }

  // ------------------------------------------------------------------ presets and settings from a layer (v1.1)

  function presetEntries() {
    var out = [];
    (Array.isArray(core.LOOKS) ? core.LOOKS : []).forEach(function (l) {
      out.push({ value: "look:" + l.id, name: l.name, description: l.description || "", settings: l.settings, builtIn: true });
    });
    state.presets.forEach(function (p) {
      out.push({ value: "user:" + p.name, name: p.name, description: "Свой пресет", settings: p.settings, builtIn: false });
    });
    return out;
  }

  function findPreset(value) {
    var all = presetEntries();
    for (var i = 0; i < all.length; i++) if (all[i].value === value) return all[i];
    return null;
  }

  function buildPresetMenu() {
    var menu = $("preset-menu");
    menu.innerHTML = "";
    presetEntries().forEach(function (e) {
      var it = document.createElement("sp-menu-item");
      it.setAttribute("value", e.value);
      it.textContent = e.builtIn ? e.name : "★ " + e.name;
      if (e.value === state.presetValue) it.setAttribute("selected", "");
      menu.appendChild(it);
    });
    renderPresetSelection();
  }

  // Selected value: the item the event came from, the picker's value or selectedIndex,
  // else an item marked selected (exact sp-picker behaviour in UXP is uncertain).
  function pickerValue(evt) {
    var picker = $("preset-picker");
    var items = $("preset-menu").querySelectorAll("sp-menu-item");
    var values = [];
    for (var i = 0; i < items.length; i++) values.push(items[i].getAttribute("value"));
    var t = evt && evt.target;
    if (t && t.tagName && String(t.tagName).toLowerCase() === "sp-menu-item" && values.indexOf(t.getAttribute("value")) >= 0) {
      return t.getAttribute("value");
    }
    if (typeof picker.value === "string" && values.indexOf(picker.value) >= 0) return picker.value;
    if (typeof picker.selectedIndex === "number" && picker.selectedIndex >= 0 && picker.selectedIndex < items.length) {
      return values[picker.selectedIndex];
    }
    for (var j = 0; j < items.length; j++) if (items[j].selected) return values[j];
    return null;
  }

  function renderPresetSelection() {
    var p = state.presetValue ? findPreset(state.presetValue) : null;
    $("preset-description").textContent = p ? p.description : "";
    setDisabled($("btn-preset-delete"), !(p && !p.builtIn));
    setDisabled($("btn-preset-load"), !p);
  }

  /** Put a settings object into the panel (preset, layer name). keepCurve: keep the
   *  user's curve points when the loaded settings do not carry their own (review С7). */
  function loadSettings(settings, label, opts) {
    var next = {};
    for (var k in settings) if (Object.prototype.hasOwnProperty.call(settings, k)) next[k] = settings[k];
    if (opts && opts.keepCurve) next.curvePoints = state.settings.curvePoints;
    state.settings = core.normalizeSettings(next);
    if (state.editor) state.editor.setPoints(state.settings.curvePoints, { silent: true });
    applyStateToControls();
    scheduleSave();
    state.lastFullKey = null;
    scheduleRender("full");
    diag.log("Загружены настройки: " + label);
    setMessage("preset-message", "Загружено: " + label + ".");
  }

  function onPresetLoad() {
    var p = state.presetValue ? findPreset(state.presetValue) : null;
    if (!p) {
      setMessage("preset-message", "Сначала выберите пресет в списке.");
      return;
    }
    // Built-in looks carry no curve: keep the user's points unless the look is a curve
    // look or brings its own points. User presets restore their curve on purpose.
    var carriesCurve = !!p.settings && (p.settings.mode === "curve" || Array.isArray(p.settings.curvePoints));
    loadSettings(p.settings, "пресет «" + p.name + "»", { keepCurve: p.builtIn && !carriesCurve });
  }

  function onPresetSave() {
    var name = Store.cleanName($("preset-name").value);
    var res = state.store.savePreset(name, state.settings);
    if (!res.ok) {
      setMessage("preset-message", res.reason || "Не удалось сохранить пресет.");
      return;
    }
    state.presets = res.presets;
    state.presetValue = "user:" + res.name;
    buildPresetMenu();
    show($("preset-save-row"), false);
    setMessage("preset-message", "Пресет «" + res.name + "» сохранён.");
    diag.log("Сохранён пресет «" + res.name + "»");
  }

  function onPresetDelete() {
    var p = state.presetValue ? findPreset(state.presetValue) : null;
    if (!p || p.builtIn) return;
    var res = state.store.deletePreset(p.name);
    state.presets = res.presets;
    state.presetValue = null;
    buildPresetMenu();
    setMessage("preset-message", res.ok ? "Пресет «" + p.name + "» удалён." : "Не удалось удалить пресет.");
  }

  /** «Взять настройки из слоя»: shown when the active layer's name carries settings. */
  function updateFromLayer(info) {
    state.layerSettings = info && info.settingsFromName ? { settings: info.settingsFromName, name: info.name } : null;
    show($("from-layer-row"), !!state.layerSettings);
  }

  function maskOn() {
    return state.maskChoice === null ? true : !!state.maskChoice;
  }

  /** «Только в выделении»: visible while the document has a selection, on by default. */
  function updateMaskCheckbox(selection) {
    var box = $("mask-checkbox");
    show(box, !!selection);
    box.checked = maskOn();
    if (maskOn()) box.setAttribute("checked", "");
    else box.removeAttribute("checked");
  }

  // Cheap reads after document events: active layer name and selection (no modal scope).
  var peekTimer = null;
  function schedulePeek() {
    if (!state.bridge || peekTimer) return;
    peekTimer = setTimeout(async function () {
      peekTimer = null;
      try {
        var p = await state.bridge.peek();
        updateFromLayer(p.activeLayer);
        updateMaskCheckbox(p.selection);
      } catch (e) {
        diag.log("Не удалось прочитать активный слой: " + e.message);
      }
    }, 300);
  }

  // ------------------------------------------------------------------ apply

  function hideConfirm() {
    state.pendingConfirm = null;
    show($("confirm-box"), false);
  }

  function showConfirm(rep, lines, preflightMs) {
    state.pendingConfirm = { rep: rep, preflightMs: preflightMs };
    var text = $("confirm-text");
    text.innerHTML = "";
    lines.forEach(function (line) {
      var div = document.createElement("div");
      div.className = "confirm-line";
      div.textContent = "• " + line;
      text.appendChild(div);
    });
    var layerBtn = $("confirm-layer");
    var compBtn = $("confirm-composite");
    layerBtn.textContent = rep.offerComposite ? "Применить к слою" : "Продолжить";
    show(layerBtn, !!rep.plans.layer);
    show(compBtn, !!rep.offerComposite && !!rep.plans.composite);
    compBtn.setAttribute("variant", rep.plans.layer ? "secondary" : "cta");
    show($("confirm-box"), true);
  }

  async function onApply() {
    if (!state.bridge) {
      showStatus("error", "Применение работает только в Photoshop.");
      return;
    }
    if (state.busy) return;
    // Busy before the first await, so a double click cannot start two modals (review М1).
    setBusy(true, "Проверка…");
    try {
      hideConfirm();
      showStatus("info", "");
      var t0 = nowMs();
      var rep;
      try {
        rep = await state.bridge.inspect({ replacePrevious: state.ui.replace });
      } catch (e) {
        diag.error(e, "inspect");
        showStatus("error", Bridge.describeError(e).text);
        return;
      }
      var preflightMs = nowMs() - t0;
      diag.set("target", rep);
      updateFromLayer(rep.activeLayer);
      updateMaskCheckbox(rep.selection);
      if (rep.selection && maskOn()) {
        rep.notes.push("Есть выделение: эффект останется только в нём (маска слоя). Чтобы обработать всё, снимите «Только в выделении».");
      }
      if (rep.blocking.length) {
        showStatus("error", rep.blocking.join(" "));
        return;
      }
      if (rep.nothingToDo) {
        showStatus("info", rep.nothingMessage);
        return;
      }
      var warnings = rep.warnings.filter(function (w) {
        return !(state.memoryWarned && rep.memoryWarning && w === rep.memoryWarning);
      });
      if (warnings.length || !rep.plans.layer) {
        showConfirm(rep, rep.notes.concat(warnings), preflightMs);
        return;
      }
      if (rep.notes.length) showStatus("info", rep.notes.join(" "));
      await runApply(rep, rep.plans.layer, preflightMs);
    } finally {
      setBusy(false);
    }
  }

  // From the confirmation box: same synchronous busy guard.
  async function startConfirmedApply(rep, plan, preflightMs) {
    if (state.busy || !plan) return;
    setBusy(true, "Обработка…");
    try {
      await runApply(rep, plan, preflightMs);
    } finally {
      setBusy(false);
    }
  }

  // Caller holds the busy flag.
  async function runApply(rep, plan, preflightMs) {
    hideConfirm();
    if (rep && rep.memoryWarning) state.memoryWarned = true;
    setBusy(true, "Обработка…");
    var head = "Обработка: " + plan.label + ". Отменить — Esc или кнопка в окне прогресса Photoshop.";
    showStatus("info", head);
    var lastPct = -1;
    var t0 = nowMs();
    var useMask = !!(rep && rep.selection) && maskOn();
    try {
      var res = await state.bridge.apply({
        settings: state.settings,
        plan: plan,
        preflightMs: preflightMs,
        maskToSelection: useMask,
        onProgress: function (value, stage) {
          var pct = Math.floor(value * 100);
          if (pct === lastPct) return;
          lastPct = pct;
          showStatus("info", head + " " + pct + " % (" + stage + ")");
        }
      });
      diag.set("apply", res.stats);
      var sec = ((nowMs() - t0) / 1000).toFixed(1);
      diag.log("Применено: " + plan.label + ", " + sec + " с, слой id " + res.resultLayerId);
      var placed = plan.mode !== "layer" ? "поверх всех слоёв."
        : res.stats.placedAbove === "result" ? "над прежним результатом." : "над исходным слоем.";
      var removed = res.stats.deletedPreviousIds && res.stats.deletedPreviousIds.length ? " Прежний результат удалён." : "";
      if (res.stats.toleratedStrips > 0) {
        // review С5: never a plain "Готово" when some strips could not be read
        diag.log("Применено с пропущенными полосами: " + res.stats.toleratedStrips, res.stats.toleratedMessages);
        showStatus("warn", "Готово за " + sec + " с, но " + res.stats.toleratedStrips +
          " полос(ы) Photoshop не отдал и они сочтены прозрачными. Если там слой не прозрачный, результат неполный: " +
          "отмените (Cmd/Ctrl+Z) и примените ещё раз. Подробности — в «Диагностике».");
      } else if (res.stats.maskWarning) {
        // review v1.1 М2: an empty selection answer never ends in a plain «Готово»
        diag.log("Маска не добавлена: " + res.stats.maskWarning);
        showStatus("warn", "Готово за " + sec + " с: создан слой Halation " + placed + removed + " " + res.stats.maskWarning);
      } else {
        var masked = !!(res.stats.mask && res.stats.mask.written);
        showStatus("ok", "Готово за " + sec + " с: создан слой Halation " + placed + removed +
          (masked ? " Маска слоя — по выделению." : ""));
      }
    } catch (e) {
      var d = Bridge.describeError(e);
      if (d.kind === "cancelled") diag.log("Применение отменено");
      else diag.error(e, "apply");
      diag.set("apply", e && e.halationStats ? e.halationStats : { ok: false, error: e && e.message });
      showStatus(d.kind === "error" || d.kind === "busy" ? "error" : "info", d.text);
    } finally {
      setBusy(false);
    }
  }

  function onDocChange(eventName) {
    if (state.busy || nowMs() < state.quietUntil) return;
    // The frame cache and the loupe cache stay until «Обновить» (or a new loupe centre).
    markStale("событие «" + eventName + "»");
    schedulePeek();
    if (state.pendingConfirm) {
      hideConfirm();
      showStatus("warn", "Документ изменился — нажмите «Применить» ещё раз.");
    }
  }

  // ------------------------------------------------------------------ diagnostics

  function renderDiag() {
    state.diagTimer = null;
    if (!state.ui || !state.ui.diagOpen) return;
    $("diag-text").value = diag.report();
  }

  function scheduleDiag() {
    if (state.diagTimer) return;
    state.diagTimer = setTimeout(renderDiag, 300);
  }

  function toggleDiag(force) {
    var open = typeof force === "boolean" ? force : !state.ui.diagOpen;
    updateUi({ diagOpen: open });
    show($("diag-block"), open);
    $("diag-toggle").textContent = (open ? "▾" : "▸") + " Диагностика";
    if (open) {
      refreshHostInfo();
      renderDiag();
    }
  }

  async function copyReport() {
    var text = diag.report();
    var ta = $("diag-text");
    ta.value = text;
    var ok = false;
    var clip = typeof navigator !== "undefined" ? navigator.clipboard : null;
    if (clip && typeof clip.writeText === "function") {
      try {
        await clip.writeText(text);
        ok = true;
      } catch (e) {
        diag.log("clipboard.writeText: " + e.message);
      }
    }
    if (!ok && clip && typeof clip.setContent === "function") {
      try {
        await clip.setContent({ "text/plain": text });
        ok = true;
      } catch (e) {
        diag.log("clipboard.setContent: " + e.message);
      }
    }
    var msg = $("copy-message");
    if (ok) {
      msg.textContent = "Отчёт скопирован в буфер обмена.";
    } else {
      try { ta.focus(); ta.select(); } catch (e) { /* selection unsupported */ }
      msg.textContent = "Скопировать автоматически не вышло: выделите текст ниже и нажмите Cmd+C (Ctrl+C).";
    }
    show(msg, true);
  }

  function refreshHostInfo() {
    if (state.bridge) diag.set("host", state.bridge.getHostInfo());
  }

  // ------------------------------------------------------------------ binding

  function bindControls() {
    $("mode-group").addEventListener("change", function (e) {
      var v = radioValue($("mode-group"), e);
      if (v !== "srgb" && v !== "curve" && v !== "reinhard") return;
      updateSettings({ mode: v });
      renderMode();
    });

    $("method-group").addEventListener("change", function (e) {
      var v = radioValue($("method-group"), e);
      if (v !== "excess" && v !== "normalized") return;
      updateSettings({ model: v });
      renderMethod();
    });

    function reinhardHandler(stage) {
      updateSettings({ reinhardLimit: limitFromSlider($("reinhard-slider").value) }, stage);
      renderReinhardLabels();
    }
    $("reinhard-slider").addEventListener("input", function () { reinhardHandler("draft"); });
    $("reinhard-slider").addEventListener("change", function () { reinhardHandler("full"); });

    $("axis-group").addEventListener("change", function (e) {
      var v = radioValue($("axis-group"), e);
      if (v !== "linear" && v !== "log") return;
      updateUi({ yAxis: v });
      state.editor.setYAxis(v);
    });

    $("btn-multiply").addEventListener("click", function () {
      var k = Editor.parseNumber($("k-field").value);
      updateUi({ k: String($("k-field").value) });
      var res = state.editor.multiplyInterior(k);
      if (res.ok) setMessage("curve-message", "");
    });

    $("btn-curve-reset").addEventListener("click", function () {
      state.editor.reset();
      setMessage("curve-message", "");
    });

    $("color-swatch").addEventListener("click", onPickColor);
    $("btn-pick-color").addEventListener("click", onPickColor);
    $("btn-color-manual").addEventListener("click", function () { toggleManual(); });
    ["hue-slider", "sat-slider", "val-slider"].forEach(function (id) {
      $(id).addEventListener("input", function () { onHsvEvent("draft"); });
      $(id).addEventListener("change", function () { onHsvEvent("full"); });
    });

    function sliderHandler(id, toPatch) {
      function handler(stage) {
        updateSettings(toPatch(Number($(id).value)), stage);
        renderSliderLabels();
      }
      $(id).addEventListener("input", function () { handler("draft"); });
      $(id).addEventListener("change", function () { handler("full"); });
    }
    sliderHandler("blur-slider", function (u) { return { blurMul: core.blurFromSlider(u) }; });
    sliderHandler("strength-slider", function (v) { return { strength: v }; });
    sliderHandler("threshold-slider", function (v) { return { threshold: Math.round(v) }; });
    sliderHandler("softness-slider", function (v) { return { softness: Math.round(v) }; });

    Object.keys(NUMBER_FIELDS).forEach(function (id) {
      $(id).addEventListener("change", function () { commitNumberField(id); });
      $(id).addEventListener("keydown", function (e) {
        if (e && (e.key === "Enter" || e.keyCode === 13)) commitNumberField(id);
      });
    });

    // preview: frame / loupe, zoom, click on the thumbnail
    $("preview-mode-group").addEventListener("change", function (e) {
      setPreviewMode(radioValue($("preview-mode-group"), e), "переключатель");
    });
    $("zoom-group").addEventListener("change", function (e) {
      var z = Number(radioValue($("zoom-group"), e));
      if (Loupe.ZOOMS.indexOf(z) < 0) return;
      updateUi({ zoom: z });
      renderPreviewMode();
      updateLoupe(true, "масштаб " + z);
    });
    $("preview-img").addEventListener("click", onPreviewClick);

    // presets
    $("preset-picker").addEventListener("change", function (e) {
      state.presetValue = pickerValue(e);
      renderPresetSelection();
    });
    $("btn-preset-load").addEventListener("click", onPresetLoad);
    $("btn-preset-save").addEventListener("click", function () {
      show($("preset-save-row"), true);
      setMessage("preset-message", "");
      try { $("preset-name").focus(); } catch (err) { /* focus unsupported */ }
    });
    $("btn-preset-save-ok").addEventListener("click", onPresetSave);
    $("preset-name").addEventListener("keydown", function (e) {
      if (e && (e.key === "Enter" || e.keyCode === 13)) onPresetSave();
    });
    $("btn-preset-save-cancel").addEventListener("click", function () { show($("preset-save-row"), false); });
    $("btn-preset-delete").addEventListener("click", onPresetDelete);
    $("btn-from-layer").addEventListener("click", function () {
      var l = state.layerSettings;
      // The name token carries curve points only for curve mode.
      if (l) loadSettings(l.settings, "слой «" + (l.name.length > 40 ? l.name.slice(0, 40) + "…" : l.name) + "»", { keepCurve: l.settings.mode !== "curve" });
    });

    $("mask-checkbox").addEventListener("change", function () {
      state.maskChoice = !!$("mask-checkbox").checked;
    });

    $("view-group").addEventListener("change", function (e) {
      var v = radioValue($("view-group"), e);
      if (v !== "before" && v !== "after" && v !== "halo") return;
      updateUi({ view: v });
      renderView();
      scheduleRender("full");
    });

    $("btn-refresh").addEventListener("click", function () { rebuildPreview("кнопка «Обновить»"); });

    $("replace-checkbox").addEventListener("change", function () {
      updateUi({ replace: !!$("replace-checkbox").checked });
    });

    $("btn-apply").addEventListener("click", onApply);
    $("confirm-layer").addEventListener("click", function () {
      var p = state.pendingConfirm;
      if (p) startConfirmedApply(p.rep, p.rep.plans.layer, p.preflightMs);
    });
    $("confirm-composite").addEventListener("click", function () {
      var p = state.pendingConfirm;
      if (p) startConfirmedApply(p.rep, p.rep.plans.composite, p.preflightMs);
    });
    $("confirm-cancel").addEventListener("click", function () {
      hideConfirm();
      showStatus("info", "Применение отменено.");
    });

    $("diag-toggle").addEventListener("click", function () { toggleDiag(); });
    $("btn-copy-report").addEventListener("click", copyReport);

    // Width changes under RESIZE_MIN_DELTA px are ignored: tiny layout jitter must not
    // resize (and clear) the curve canvas (v1.1 flicker fix).
    var resizeTimer = null;
    window.addEventListener("resize", function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        var wrap = $("preview-wrap");
        var width = (typeof window.innerWidth === "number" && window.innerWidth) || (wrap && wrap.clientWidth) || 0;
        if (state.lastWindowWidth !== null && Math.abs(width - state.lastWindowWidth) < RESIZE_MIN_DELTA) return;
        state.lastWindowWidth = width;
        if (state.settings.mode === "curve" && state.editor) state.editor.resize();
        if (state.ui.previewMode === "loupe") updateLoupe(true, "размер панели");
        else if (state.proxy) {
          sizePreview(state.proxy.width, state.proxy.height);
          updateFrameOverlay();
        }
      }, 120);
    });
  }

  function applyStateToControls() {
    renderMode();
    renderMethod();
    renderSliders();
    renderColor();
    syncHsvSliders();
    renderView();
    $("replace-checkbox").checked = !!state.ui.replace;
    if (state.ui.replace) $("replace-checkbox").setAttribute("checked", "");
    else $("replace-checkbox").removeAttribute("checked");
    $("k-field").value = state.ui.k;
    setRadio($("axis-group"), state.ui.yAxis);
    renderPreviewMode();
  }

  // ------------------------------------------------------------------ start-up

  function fatal(text) {
    var el = $("fatal");
    if (el) {
      el.textContent = text;
      show(el, true);
    }
  }

  function initUi(origin) {
    if (state.initialized) return true;
    state.initialized = true;
    try {
      if (!core || typeof core.normalizeSettings !== "function") {
        fatal("Не загружено ядро halation-core.js — переустановите плагин.");
        diag.log("HalationCore не найден");
        return false;
      }
      diag.set("core", core.VERSION || "?");
      state.store = window.HalationSettingsStore.create({ storage: safeStorage(), core: core });
      var loaded = state.store.load();
      state.settings = loaded.settings;
      state.ui = loaded.ui;
      if (loaded.error) diag.log("Сохранённые настройки не прочитаны, взяты значения по умолчанию: " + loaded.error.message);
      if (loaded.migratedFrom) {
        // v1.0 record: blur 0..100 became blurMul; keep the converted values right away.
        state.store.save(state.settings, state.ui);
        diag.log("Настройки версии 1.0 перенесены в схему " + Store.SCHEMA);
      }
      state.presets = state.store.loadPresets();
      diag.set("settings", state.settings);

      if (photoshop) {
        state.bridge = Bridge.createBridge({
          photoshop: photoshop,
          uxp: uxp,
          os: osMod,
          core: core,
          color: Color,
          log: diag.log
        });
      } else {
        diag.log("require(\"photoshop\") недоступен — панель открыта вне Photoshop");
      }

      buildPresets();
      bindControls();
      buildPresetMenu();
      state.lastWindowWidth = typeof window.innerWidth === "number" ? window.innerWidth : null;
      createEditor();
      applyStateToControls();
      applyTheme();
      watchTheme();
      if (state.bridge) state.bridge.watchChanges(onDocChange);
      diag.onChange(scheduleDiag);
      refreshHostInfo();
      toggleDiag(state.ui.diagOpen);
      setPreviewPlaceholder("Предпросмотр строится при показе панели и по кнопке «Обновить».");
      diag.log("Панель запущена (" + (origin || "?") + ")");
      return true;
    } catch (e) {
      diag.error(e, "initUi");
      fatal("Ошибка запуска панели: " + e.message);
      return false;
    }
  }

  function onShow() {
    state.showCount++;
    var ok = initUi("show");
    if (!ok) return;
    refreshHostInfo();
    if (state.settings.mode === "curve" && state.editor) state.editor.resize();
    rebuildPreview(state.showCount === 1 ? "показ панели" : "повторный показ панели");
  }

  var setupDone = false;
  if (uxp && uxp.entrypoints && typeof uxp.entrypoints.setup === "function") {
    try {
      uxp.entrypoints.setup({
        panels: {
          halationPanel: {
            show: function () { onShow(); },
            hide: function () { diag.log("Панель скрыта"); }
          }
        }
      });
      setupDone = true;
    } catch (e) {
      diag.error(e, "entrypoints.setup");
    }
  }

  if (!setupDone) {
    // Outside UXP (or setup failed): start the UI without reading the document.
    initUi("без entrypoints");
  } else {
    // Safety net: some UXP builds do not call show for a panel that is already open
    // at start-up. Start the UI only (no Photoshop reads, no modal scope).
    setTimeout(function () {
      if (!state.initialized) {
        initUi("таймер: show не вызван за " + SHOW_FALLBACK_MS / 1000 + " с");
        diag.log("show не вызван — интерфейс запущен по таймеру, предпросмотр по кнопке «Обновить»");
      }
    }, SHOW_FALLBACK_MS);
  }

  // Exposed for debugging in the UXP Developer Tool console.
  window.HalationPanel = { state: state, diag: diag, version: PLUGIN_VERSION, panelId: PANEL_ID };
})();
