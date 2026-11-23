/* Halation panel: diagnostics collector and report text (pure JS).
 * Browser / UXP: window.HalationDiagnostics. Node: module.exports.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.HalationDiagnostics = api;
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function () {
  "use strict";

  var MAX_LOG = 80;
  var MAX_RAW = 4000;

  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function pad3(n) { return n < 10 ? "00" + n : n < 100 ? "0" + n : String(n); }

  function stamp(d) {
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()) + "." + pad3(d.getMilliseconds());
  }

  function fmtMB(bytes) {
    if (!bytes) return "0 МБ";
    return (bytes / (1024 * 1024)).toFixed(1) + " МБ";
  }

  function fmtMs(ms) {
    if (ms === undefined || ms === null || !isFinite(ms)) return "—";
    return ms >= 10000 ? (ms / 1000).toFixed(1) + " с" : Math.round(ms) + " мс";
  }

  function safeJson(v, max) {
    var s;
    try {
      s = JSON.stringify(v, function (k, val) {
        if (val && typeof val === "object" && typeof val.length === "number" && val.BYTES_PER_ELEMENT) {
          return "[" + val.constructor.name + " " + val.length + "]";
        }
        return val;
      });
    } catch (e) {
      s = String(v);
    }
    if (s === undefined) s = String(v);
    max = max || MAX_RAW;
    return s.length > max ? s.slice(0, max) + "…(обрезано)" : s;
  }

  function create(opts) {
    var pluginVersion = (opts && opts.pluginVersion) || "?";
    var entries = [];
    var info = {
      host: null,
      core: null,
      target: null,
      apply: null,
      preview: null,
      loupe: null,
      colorRaw: null,
      colorParsed: null,
      lastError: null,
      settings: null
    };
    var listeners = [];

    function changed() {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](); } catch (e) { /* listener errors must not break logging */ }
      }
    }

    function log(msg, data) {
      var line = "[" + stamp(new Date()) + "] " + msg + (data !== undefined ? " " + safeJson(data, 600) : "");
      entries.push(line);
      if (entries.length > MAX_LOG) entries.splice(0, entries.length - MAX_LOG);
      if (typeof console !== "undefined" && console.log) console.log("[Halation] " + line);
      changed();
    }

    function error(err, context) {
      var e = err || {};
      info.lastError = {
        when: new Date().toISOString(),
        context: context || "",
        name: e.name || "Error",
        message: e.message !== undefined ? String(e.message) : String(err),
        number: e.number,
        code: e.code,
        stack: e.stack ? String(e.stack) : ""
      };
      log("ОШИБКА (" + (context || "?") + "): " + info.lastError.message);
    }

    function set(section, value) {
      info[section] = value;
      changed();
    }

    function onChange(fn) {
      listeners.push(fn);
    }

    function hostLines() {
      var h = info.host || {};
      return [
        "Плагин: " + pluginVersion + (h.pluginFromUxp ? " (UXP сообщает " + h.pluginFromUxp + ")" : "") +
          "; ядро: " + (info.core || "?"),
        "Photoshop: " + (h.photoshop || "?") + "; UXP: " + (h.uxp || "?") +
          "; ОС: " + (h.os || "?") + "; язык: " + (h.locale || "?")
      ];
    }

    function targetLines() {
      var t = info.target;
      if (!t) return ["Документ: нет сведений (ещё не было проверки)"];
      var out = [];
      var d = t.doc;
      if (d) {
        out.push("Документ: «" + d.title + "» id " + d.id + ", " + d.width + "×" + d.height + " px, " +
          d.modeLabel + ", " + d.bitsLabel + ", профиль «" + (d.profile || "нет") + "»" +
          (d.resolution ? ", " + d.resolution + " ppi" : "") +
          (d.sizeCheck ? "; проверка размера: " + d.sizeCheck : ""));
      } else {
        out.push("Документ: нет");
      }
      var l = t.layer;
      if (l) {
        out.push("Слой: «" + l.name + "» id " + l.id + ", тип " + l.kind + (l.isBackground ? " (фон)" : "") +
          ", границы " + safeJson(l.bounds) + ", непрозрачность " + l.opacity + ", заливка " + l.fillOpacity +
          ", режим " + l.blendMode + ", обтравочный " + l.isClippingMask +
          ", маска " + l.hasUserMask + ", векторная маска " + l.hasVectorMask);
      }
      if (t.source) out.push("Источник: " + safeJson(t.source));
      if (t.blocking && t.blocking.length) out.push("Блокирует: " + t.blocking.join(" | "));
      if (t.warnings && t.warnings.length) out.push("Предупреждения: " + t.warnings.join(" | "));
      if (t.notes && t.notes.length) out.push("Заметки: " + t.notes.join(" | "));
      return out;
    }

    function statsLines(title, s) {
      if (!s) return [title + ": ещё не запускалось"];
      var out = [title + ": " + (s.ok ? "успешно" : s.cancelled ? "отменено" : s.error ? "ошибка" : "?") +
        (s.when ? " (" + s.when + ")" : "")];
      if (s.area) out.push("  Рабочая область: " + safeJson(s.area) + ", режим " + s.mode);
      var tm = s.timings || {};
      var parts = [];
      for (var k in tm) if (Object.prototype.hasOwnProperty.call(tm, k)) parts.push(k + " " + fmtMs(tm[k]));
      if (parts.length) out.push("  Этапы: " + parts.join(", "));
      out.push("  getPixels: " + (s.getPixelsCalls || 0) + " вызовов, прочитано " + fmtMB(s.bytesRead) +
        "; putPixels: " + (s.putPixelsCalls || 0) + " вызовов, записано " + fmtMB(s.bytesWritten));
      if (s.strips) out.push("  Полосы: " + s.strips + " по " + s.stripRows + " строк; пустых " + (s.emptyStrips || 0) +
        "; терпимых ошибок чтения " + (s.toleratedErrors || 0));
      if (s.toleratedMessages && s.toleratedMessages.length) out.push("  Ошибки пустых полос: " + s.toleratedMessages.join(" | "));
      if (s.layerOrder) out.push("  Порядок слоёв (до → после): " + safeJson(s.layerOrder));
      if (s.layerName) out.push("  Имя слоя: " + s.layerName);
      if (s.mask) out.push("  Маска из выделения: " + safeJson(s.mask));
      if (s.hiddenDuringRead && s.hiddenDuringRead.length) out.push("  Скрыты на время чтения: " + safeJson(s.hiddenDuringRead));
      if (s.coreStats) out.push("  Ядро: " + safeJson(s.coreStats, 1500));
      if (s.renderMs !== undefined || s.draftMs !== undefined) {
        out.push("  Пересчёт предпросмотра: полный " + fmtMs(s.renderMs) + ", черновик " + fmtMs(s.draftMs) +
          (s.display ? "; вывод: " + s.display : ""));
      }
      if (s.proxySize) out.push("  Копия: " + s.proxySize);
      return out;
    }

    function report() {
      var lines = [];
      lines.push("Halation — отчёт диагностики");
      lines.push("Время: " + new Date().toISOString());
      Array.prototype.push.apply(lines, hostLines());
      Array.prototype.push.apply(lines, targetLines());
      Array.prototype.push.apply(lines, statsLines("Последнее применение", info.apply));
      Array.prototype.push.apply(lines, statsLines("Предпросмотр", info.preview));
      Array.prototype.push.apply(lines, statsLines("Лупа", info.loupe));
      lines.push("Настройки: " + (info.settings ? safeJson(info.settings, 1200) : "—"));
      lines.push("Палитра цвета, сырой ответ: " + (info.colorRaw !== null ? safeJson(info.colorRaw) : "—"));
      if (info.colorParsed) lines.push("Палитра цвета, разбор: " + safeJson(info.colorParsed));
      var le = info.lastError;
      if (le) {
        lines.push("Последняя ошибка (" + le.when + ", " + le.context + "): " + le.name + ": " + le.message +
          (le.number !== undefined ? " [number " + le.number + "]" : "") + (le.code !== undefined ? " [code " + le.code + "]" : ""));
        if (le.stack) lines.push("Стек:\n" + le.stack);
      } else {
        lines.push("Последняя ошибка: нет");
      }
      lines.push("Журнал:");
      for (var i = 0; i < entries.length; i++) lines.push("  " + entries[i]);
      return lines.join("\n");
    }

    return {
      log: log,
      error: error,
      set: set,
      info: info,
      entries: entries,
      onChange: onChange,
      report: report
    };
  }

  return { create: create, safeJson: safeJson, fmtMB: fmtMB, fmtMs: fmtMs };
});
