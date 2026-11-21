/* Halation panel: UI wiring (UXP).
 *
 * Start-up runs from the panel "show" callback, not from plugin.create (doc §6.3).
 * Photoshop is touched only on show, on "Обновить", on "Палитра…" and on "Применить";
 * document and layer changes only mark the preview stale (doc §6.1).
 */
(function () {
  "use strict";

  var PLUGIN_VERSION = "1.0.0"; // checked against manifest.json by tools/build-ccx.mjs
  var PANEL_ID = "halationPanel";
  var PREVIEW_MAX_SIDE = 500;
  // Two-stage preview (src/core/API.md): a half-size draft while something moves,
  // the full render once the user stops.
  var DRAFT_DEBOUNCE_MS = 100;
  var FULL_AFTER_INPUT_MS = 300;
  var FULL_AFTER_CHANGE_MS = 30;
  var SAVE_DEBOUNCE_MS = 300;
  var SHOW_FALLBACK_MS = 3000;

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
    pendingConfirm: null
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
    schedulePreview(stage === "draft" ? "draft" : "full");
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

  function renderSliders() {
    var s = state.settings;
    $("blur-slider").value = s.blur;
    $("strength-slider").value = s.strength;
    renderSliderLabels();
  }

  function renderSliderLabels() {
    var s = state.settings;
    var m = core.blurMultiplier(s.blur);
    $("blur-value").textContent = "×" + (m >= 10 ? m.toFixed(1) : m.toFixed(2));
    $("strength-value").textContent = String(Math.round(s.strength));
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

  async function displayPreview(img) {
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
    // Draft (half-size) and full images are scaled into the same box: the proxy's.
    sizePreview(state.proxy ? state.proxy.width : img.width, state.proxy ? state.proxy.height : img.height);
    show($("preview-placeholder"), false);
    show(el, true);
    updateStaleLabel();
    return how;
  }

  function sizePreview(w, h) {
    var wrap = $("preview-wrap");
    var cw = Math.max(120, (wrap && wrap.clientWidth ? wrap.clientWidth : 260) - 2);
    var scale = Math.min(cw / w, 320 / h);
    var el = $("preview-img");
    var dw = Math.max(1, Math.round(w * scale));
    var dh = Math.max(1, Math.round(h * scale));
    el.width = dw;
    el.height = dh;
    el.style.width = dw + "px";
    el.style.height = dh + "px";
  }

  async function rebuildPreview(reason) {
    if (!state.bridge) {
      setPreviewPlaceholder("Предпросмотр работает только в Photoshop.");
      return;
    }
    if (state.busy) return;
    var rep;
    try {
      rep = await state.bridge.inspect({ replacePrevious: false });
    } catch (e) {
      diag.error(e, "inspect (предпросмотр)");
      setPreviewPlaceholder("Не удалось прочитать документ — см. «Диагностика».");
      return;
    }
    diag.set("target", rep);
    if (rep.blocking.length) {
      state.proxy = null;
      updateStaleLabel();
      setPreviewPlaceholder(rep.blocking.join(" "));
      return;
    }
    if (rep.nothingToDo) {
      state.proxy = null;
      updateStaleLabel();
      setPreviewPlaceholder(rep.nothingMessage);
      return;
    }
    var plan = rep.plans.layer || rep.plans.composite;
    setBusy(true, "Предпросмотр…");
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
      diag.set("preview", res.stats);
      diag.log("Предпросмотр построен (" + reason + "): " + res.stats.proxySize + ", " + Math.round(res.stats.timings.total) + " мс");
      progressEl.textContent = "Пересчитываю…";
      // Let the label paint before the (blocking) full render.
      setTimeout(function () {
        show(progressEl, false);
        clearPreviewTimers();
        renderPreviewNow(false);
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
  }

  async function runApply(rep, plan, preflightMs) {
    hideConfirm();
    if (rep && rep.memoryWarning) state.memoryWarned = true;
    setBusy(true, "Обработка…");
    var head = "Обработка: " + plan.label + ". Отменить — Esc или кнопка в окне прогресса Photoshop.";
    showStatus("info", head);
    var lastPct = -1;
    var t0 = nowMs();
    try {
      var res = await state.bridge.apply({
        settings: state.settings,
        plan: plan,
        preflightMs: preflightMs,
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
      showStatus("ok", "Готово за " + sec + " с: создан слой «Halation» " +
        (plan.mode === "layer" ? "над исходным слоем." : "поверх всех слоёв.") +
        (res.stats.deletedPreviousId !== undefined ? " Прежний результат удалён." : ""));
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
    markStale("событие «" + eventName + "»");
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

    function sliderHandler(id, field) {
      function handler(stage) {
        var patch = {};
        patch[field] = Number($(id).value);
        updateSettings(patch, stage);
        renderSliderLabels();
      }
      $(id).addEventListener("input", function () { handler("draft"); });
      $(id).addEventListener("change", function () { handler("full"); });
    }
    sliderHandler("blur-slider", "blur");
    sliderHandler("strength-slider", "strength");

    $("view-group").addEventListener("change", function (e) {
      var v = radioValue($("view-group"), e);
      if (v !== "before" && v !== "after" && v !== "halo") return;
      updateUi({ view: v });
      renderView();
      schedulePreview("full");
    });

    $("btn-refresh").addEventListener("click", function () { rebuildPreview("кнопка «Обновить»"); });

    $("replace-checkbox").addEventListener("change", function () {
      updateUi({ replace: !!$("replace-checkbox").checked });
    });

    $("btn-apply").addEventListener("click", onApply);
    $("confirm-layer").addEventListener("click", function () {
      var p = state.pendingConfirm;
      if (p && p.rep.plans.layer) runApply(p.rep, p.rep.plans.layer, p.preflightMs);
    });
    $("confirm-composite").addEventListener("click", function () {
      var p = state.pendingConfirm;
      if (p && p.rep.plans.composite) runApply(p.rep, p.rep.plans.composite, p.preflightMs);
    });
    $("confirm-cancel").addEventListener("click", function () {
      hideConfirm();
      showStatus("info", "Применение отменено.");
    });

    $("diag-toggle").addEventListener("click", function () { toggleDiag(); });
    $("btn-copy-report").addEventListener("click", copyReport);

    var resizeTimer = null;
    window.addEventListener("resize", function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (state.settings.mode === "curve" && state.editor) state.editor.resize();
        if (state.proxy) sizePreview(state.proxy.width, state.proxy.height);
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
