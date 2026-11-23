/* Halation panel: settings and user presets in localStorage (JSON with a schema version).
 * Pure JS. Browser / UXP: window.HalationSettingsStore. Node: module.exports.
 *
 * Schema 2 (v1.1): settings carry blurMul instead of the 0..100 "blur" slider value.
 * Schema 1 (v1.0) is migrated on load: core.normalizeSettings converts "blur" to
 * "blurMul" and keeps every other value; the next save writes schema 2.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.HalationSettingsStore = api;
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function () {
  "use strict";

  var SCHEMA = 2;
  var KEY = "dev.halation.photoshop/settings";
  var PRESETS_KEY = "dev.halation.photoshop/presets";
  var PRESETS_SCHEMA = 1;
  var MAX_PRESETS = 100;
  var MAX_NAME = 60;

  var DEFAULT_UI = Object.freeze({
    yAxis: "linear",      // "linear" | "log"
    view: "after",        // "before" | "after" | "halo"
    previewMode: "frame", // "frame" | "loupe"
    zoom: 1,              // loupe zoom: 1 | 2
    replace: true,        // "Заменять прежний результат"
    k: "0.5",             // multiplier for interior curve points
    diagOpen: false
  });

  function sanitizeUi(ui) {
    var out = {};
    for (var k in DEFAULT_UI) if (Object.prototype.hasOwnProperty.call(DEFAULT_UI, k)) out[k] = DEFAULT_UI[k];
    if (!ui || typeof ui !== "object") return out;
    if (ui.yAxis === "linear" || ui.yAxis === "log") out.yAxis = ui.yAxis;
    if (ui.view === "before" || ui.view === "after" || ui.view === "halo") out.view = ui.view;
    if (ui.previewMode === "frame" || ui.previewMode === "loupe") out.previewMode = ui.previewMode;
    if (ui.zoom === 1 || ui.zoom === 2) out.zoom = ui.zoom;
    if (typeof ui.replace === "boolean") out.replace = ui.replace;
    if (typeof ui.k === "string" && ui.k.length < 32) out.k = ui.k;
    if (typeof ui.diagOpen === "boolean") out.diagOpen = ui.diagOpen;
    return out;
  }

  function cleanName(name) {
    return String(name === undefined || name === null ? "" : name).replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  }

  function create(opts) {
    var storage = opts && opts.storage;
    var core = opts && opts.core;
    var key = (opts && opts.key) || KEY;
    var presetsKey = (opts && opts.presetsKey) || PRESETS_KEY;

    function normalize(partial) {
      try {
        return core.normalizeSettings(partial || {});
      } catch (e) {
        // normalizeSettings must not throw; this is a last resort.
        return core.normalizeSettings({});
      }
    }

    function readJson(k) {
      var raw = storage ? storage.getItem(k) : null;
      return raw ? JSON.parse(raw) : null;
    }

    function load() {
      var parsed = null, error = null, migratedFrom = null;
      try {
        parsed = readJson(key);
      } catch (e) {
        error = e;
        parsed = null;
      }
      if (parsed && typeof parsed === "object" && parsed.schema === 1) {
        migratedFrom = 1; // v1.0: "blur" 0..100 -> blurMul by normalizeSettings
      } else if (parsed && (typeof parsed !== "object" || parsed.schema !== SCHEMA)) {
        error = error || new Error("Неизвестная версия схемы настроек: " + (parsed && parsed.schema));
        parsed = null;
      }
      return {
        settings: normalize(parsed ? parsed.settings : {}),
        ui: sanitizeUi(parsed ? parsed.ui : null),
        error: error,
        fromStorage: !!parsed,
        migratedFrom: migratedFrom
      };
    }

    function save(settings, ui) {
      if (!storage) return false;
      try {
        storage.setItem(key, JSON.stringify({
          schema: SCHEMA,
          savedAt: new Date().toISOString(),
          settings: settings,
          ui: sanitizeUi(ui)
        }));
        return true;
      } catch (e) {
        return false;
      }
    }

    // ---- user presets: [{ name, settings, savedAt }]

    function loadPresets() {
      var parsed = null;
      try {
        parsed = readJson(presetsKey);
      } catch (e) {
        return [];
      }
      if (!parsed || parsed.schema !== PRESETS_SCHEMA || !Array.isArray(parsed.presets)) return [];
      var out = [];
      parsed.presets.forEach(function (p) {
        var name = p && cleanName(p.name);
        if (!name || !p.settings || typeof p.settings !== "object") return;
        out.push({ name: name, settings: normalize(p.settings), savedAt: p.savedAt || null });
      });
      return out;
    }

    function writePresets(list) {
      if (!storage) return false;
      try {
        storage.setItem(presetsKey, JSON.stringify({ schema: PRESETS_SCHEMA, presets: list }));
        return true;
      } catch (e) {
        return false;
      }
    }

    /** Save (or overwrite, by name ignoring case) a preset. Returns { ok, presets, reason }. */
    function savePreset(name, settings) {
      var n = cleanName(name);
      if (!n) return { ok: false, presets: loadPresets(), reason: "Введите название пресета." };
      var list = loadPresets().filter(function (p) { return p.name.toLowerCase() !== n.toLowerCase(); });
      if (list.length >= MAX_PRESETS) return { ok: false, presets: list, reason: "Не больше " + MAX_PRESETS + " пресетов — удалите лишние." };
      list.push({ name: n, settings: normalize(settings), savedAt: new Date().toISOString() });
      list.sort(function (a, b) { return a.name.localeCompare(b.name); });
      var ok = writePresets(list);
      return { ok: ok, presets: list, name: n, reason: ok ? null : "Не удалось записать пресеты." };
    }

    function deletePreset(name) {
      var n = cleanName(name).toLowerCase();
      var before = loadPresets();
      var list = before.filter(function (p) { return p.name.toLowerCase() !== n; });
      var ok = list.length !== before.length && writePresets(list);
      return { ok: ok, presets: list };
    }

    return { load: load, save: save, key: key, loadPresets: loadPresets, savePreset: savePreset, deletePreset: deletePreset };
  }

  return {
    SCHEMA: SCHEMA,
    KEY: KEY,
    PRESETS_KEY: PRESETS_KEY,
    DEFAULT_UI: DEFAULT_UI,
    sanitizeUi: sanitizeUi,
    cleanName: cleanName,
    create: create
  };
});
