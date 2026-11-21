/* Halation panel: settings persistence in localStorage (one JSON with a schema version).
 * Pure JS. Browser / UXP: window.HalationSettingsStore. Node: module.exports.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.HalationSettingsStore = api;
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function () {
  "use strict";

  var SCHEMA = 1;
  var KEY = "dev.halation.photoshop/settings";

  var DEFAULT_UI = Object.freeze({
    yAxis: "linear",   // "linear" | "log"
    view: "after",     // "before" | "after" | "halo"
    replace: true,     // "Заменять прежний результат"
    k: "0.5",          // multiplier for interior curve points
    diagOpen: false
  });

  function sanitizeUi(ui) {
    var out = {
      yAxis: DEFAULT_UI.yAxis,
      view: DEFAULT_UI.view,
      replace: DEFAULT_UI.replace,
      k: DEFAULT_UI.k,
      diagOpen: DEFAULT_UI.diagOpen
    };
    if (!ui || typeof ui !== "object") return out;
    if (ui.yAxis === "linear" || ui.yAxis === "log") out.yAxis = ui.yAxis;
    if (ui.view === "before" || ui.view === "after" || ui.view === "halo") out.view = ui.view;
    if (typeof ui.replace === "boolean") out.replace = ui.replace;
    if (typeof ui.k === "string" && ui.k.length < 32) out.k = ui.k;
    if (typeof ui.diagOpen === "boolean") out.diagOpen = ui.diagOpen;
    return out;
  }

  function create(opts) {
    var storage = opts && opts.storage;
    var core = opts && opts.core;
    var key = (opts && opts.key) || KEY;

    function normalize(partial) {
      try {
        return core.normalizeSettings(partial || {});
      } catch (e) {
        // normalizeSettings must not throw; this is a last resort.
        return core.normalizeSettings({});
      }
    }

    function load() {
      var raw = null, parsed = null, error = null;
      try {
        raw = storage ? storage.getItem(key) : null;
        if (raw) parsed = JSON.parse(raw);
      } catch (e) {
        error = e;
        parsed = null;
      }
      if (parsed && (typeof parsed !== "object" || parsed.schema !== SCHEMA)) {
        error = error || new Error("Неизвестная версия схемы настроек: " + (parsed && parsed.schema));
        parsed = null;
      }
      return {
        settings: normalize(parsed ? parsed.settings : {}),
        ui: sanitizeUi(parsed ? parsed.ui : null),
        error: error,
        fromStorage: !!parsed
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

    return { load: load, save: save, key: key };
  }

  return { SCHEMA: SCHEMA, KEY: KEY, DEFAULT_UI: DEFAULT_UI, sanitizeUi: sanitizeUi, create: create };
});
