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

  // "11,2 с" / "0,4 с": seconds with one decimal, for the short summary in the panel
  function fmtSec(ms) {
    if (ms === undefined || ms === null || !isFinite(ms)) return "—";
    return (Math.max(0, ms) / 1000).toFixed(1).replace(".", ",") + " с";
  }

  function fmtGB(bytes) {
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " ГБ";
  }

  // Stage names follow the order of work and do not repeat the words of the «По исполнителю»
  // line: «чтение» there is Photoshop's time alone, while pass 1 is reading plus computing
  // (code review v1.1.2 М2).
  var STAGE_NAMES = {
    preflight: "проверка", selection: "выделение", read: "проход 1", blur: "размытие с паузами", layer: "слой",
    write: "проход 2", mask: "маска", finish: "сборка", total: "всего"
  };

  /**
   * Where the time of one apply went, by who did the work (v1.1.2). The stage called `write`
   * is the whole second pass (re-read, compute, write), so stage times alone mislead.
   * Returns null when the stats carry no timings.
   */
  function applyParts(s) {
    if (!s || !s.timings || !(s.timings.total >= 0)) return null;
    var tm = s.timings, io = s.io || {}, pio = s.passIo || null;
    var ct = (s.coreStats && s.coreStats.timings) || {};
    var read1 = pio ? pio[0].ms : null;
    var read2 = pio ? pio[1].ms : null;
    var psRead = pio ? read1 + read2 : (io.getPixelsMs || 0) + (io.getDataMs || 0);
    var psWrite = (io.putPixelsMs || 0) + (io.createMs || 0);
    var layer = (tm.layer || 0) + (tm.mask || 0) + (tm.selection || 0);
    var core1 = ct.pass1 || 0, coreBlur = ct.blur || 0, core2 = ct.pass2 || 0;
    var known = psRead + psWrite + layer + core1 + coreBlur + core2;
    var probe = s.probe ? ((s.probe.before && s.probe.before.ms) || 0) + ((s.probe.after && s.probe.after.ms) || 0) : 0;
    return {
      total: tm.total,
      probe: probe,
      psRead: psRead, read1: read1, read2: read2, psWrite: psWrite, layer: layer,
      core: core1 + coreBlur + core2, core1: core1, coreBlur: coreBlur, core2: core2,
      other: Math.max(0, tm.total - known)
    };
  }

  /** Short lines for the panel: what the last apply spent its time on. */
  function summaryLines(s) {
    if (!s) return ["Применений ещё не было."];
    var p = applyParts(s);
    var state = s.ok ? "" : s.cancelled ? " (отменено)" : " (ошибка)";
    if (!p) return ["Последнее применение" + state + ": нет данных о времени."];
    return [
      "Последнее применение" + state + ": " + fmtSec(p.total),
      "Photoshop: чтение " + fmtSec(p.psRead) + " · запись " + fmtSec(p.psWrite) + " · слой " + fmtSec(p.layer),
      "Расчёт плагина: " + fmtSec(p.core) + " (сетка " + fmtSec(p.core1) + " · размытие " + fmtSec(p.coreBlur) +
        " · ореол " + fmtSec(p.core2) + ")",
      "Прочее: " + fmtSec(p.other)
    ];
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
    var applyHistory = []; // one line per apply, newest last (v1.1.2: first and later applies side by side)
    var MAX_HISTORY = 5;

    function historyLine(s) {
      var tm = s.timings || {};
      var ct = (s.coreStats && s.coreStats.timings) || {};
      var parts = [];
      var keys = ["read", "blur", "layer", "write"];
      for (var i = 0; i < keys.length; i++) {
        if (tm[keys[i]] !== undefined) parts.push(STAGE_NAMES[keys[i]] + " " + Math.round(tm[keys[i]]));
      }
      return "[" + stamp(new Date()) + "] " + (s.ok ? "" : s.cancelled ? "отменено, " : "ошибка, ") +
        "всего " + fmtMs(tm.total) + (parts.length ? ": " + parts.join(", ") + " мс" : "") +
        (ct.pass2 !== undefined ? "; ядро " + Math.round(ct.pass1 || 0) + "/" + Math.round(ct.blur || 0) + "/" + Math.round(ct.pass2 || 0) : "") +
        (s.probe && s.probe.before ? "; эталон " + s.probe.before.min + (s.probe.after ? "/" + s.probe.after.min : "") : "");
    }

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
      if (section === "apply" && value && value.timings && value.timings.total !== undefined) {
        applyHistory.push(historyLine(value));
        if (applyHistory.length > MAX_HISTORY) applyHistory.splice(0, applyHistory.length - MAX_HISTORY);
      }
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
      for (var k in tm) {
        if (Object.prototype.hasOwnProperty.call(tm, k)) parts.push((STAGE_NAMES[k] ? STAGE_NAMES[k] + " (" + k + ")" : k) + " " + fmtMs(tm[k]));
      }
      if (parts.length) {
        out.push("  Этапы: " + parts.join(", ") +
          (tm.preflight !== undefined && tm.total !== undefined ? " (проверка во «всего» не входит)" : ""));
      }
      var ap = s.coreStats ? applyParts(s) : null;
      if (ap) {
        // «расчёт и запись» is the whole second pass, not the write alone (Ilya, v1.1.1)
        out.push("  По исполнителю: Photoshop — чтение " + fmtMs(ap.psRead) +
          (ap.read1 !== null ? " (проход 1: " + fmtMs(ap.read1) + ", повторное в проходе 2: " + fmtMs(ap.read2) + ")" : "") +
          ", запись " + fmtMs(ap.psWrite) + ", слой и маска " + fmtMs(ap.layer) +
          "; расчёт плагина — сетка " + fmtMs(ap.core1) + ", размытие " + fmtMs(ap.coreBlur) + ", ореол " + fmtMs(ap.core2) +
          "; прочее " + fmtMs(ap.other) + (ap.probe ? " (из них эталон скорости " + fmtMs(ap.probe) + ")" : ""));
      }
      out.push("  getPixels: " + (s.getPixelsCalls || 0) + " вызовов, прочитано " + fmtMB(s.bytesRead) +
        "; putPixels: " + (s.putPixelsCalls || 0) + " вызовов, записано " + fmtMB(s.bytesWritten));
      if (s.io && (s.io.getPixelsMs || s.io.putPixelsMs)) {
        out.push("  Photoshop: getPixels " + fmtMs(s.io.getPixelsMs) + ", getData " + fmtMs(s.io.getDataMs) +
          ", putPixels " + fmtMs(s.io.putPixelsMs) +
          (s.io.createMs !== undefined ? ", создание ImageData " + fmtMs(s.io.createMs) : "") +
          (s.yields ? "; уступок управления " + s.yields.count + " (" + fmtMs(s.yields.ms) + ")" : ""));
      }
      if (s.passIo && (s.passIo[0].bytes || s.passIo[1].bytes)) {
        var rate = function (q) { return q.bytes ? (q.ms / (q.bytes / 1048576)).toFixed(1) + " мс/МБ" : "—"; };
        var one = function (q) { return fmtMB(q.bytes) + " за " + fmtMs(q.ms) + " (" + rate(q) + ")"; };
        // a preview or a loupe reads once: no «проход 2 — 0 МБ» there (code review v1.1.2 М7)
        out.push("  Скорость чтения: " + (s.passIo[1].bytes ? "проход 1 — " + one(s.passIo[0]) + "; проход 2 — " + one(s.passIo[1]) : one(s.passIo[0])) +
          (s.bytesWritten ? "; запись — " + ((((s.io.putPixelsMs || 0) + (s.io.createMs || 0)) / (s.bytesWritten / 1048576)).toFixed(1)) + " мс/МБ" : ""));
      }
      if (s.stripMs && (s.stripMs.pass1 || s.stripMs.pass2)) {
        var sm = function (q) { return q ? "первая " + q.first + ", медиана " + q.median + ", макс " + q.max : "—"; };
        out.push("  Расчёт по полосам, мс: проход 1 — " + sm(s.stripMs.pass1) + "; проход 2 — " + sm(s.stripMs.pass2));
      }
      if (s.probe && (s.probe.before || s.probe.after)) {
        var pr = function (q) { return q ? "первый " + q.first + ", лучший " + q.min + " мс" : "—"; };
        var q0 = s.probe.before || s.probe.after;
        out.push("  Эталон скорости (одна и та же работа до и после применения): до — " + pr(s.probe.before) +
          "; после — " + pr(s.probe.after) + "; сумма " + q0.sum);
      }
      if (s.memory && (s.memory.before !== null || s.memory.after !== null)) {
        out.push("  Свободная память: до " + (s.memory.before !== null ? fmtGB(s.memory.before) : "—") +
          ", после " + (s.memory.after !== null && s.memory.after !== undefined ? fmtGB(s.memory.after) : "—"));
      }
      var ft = s.coreStats && s.coreStats.fineTiles;
      if (ft && ft.total > 0) {
        out.push("  Мелкое размытие: посчитано " + Math.round(100 * ft.computed / ft.total) + " % плиток (" + ft.computed + " из " + ft.total + ")");
      }
      if (s.progressWeights) out.push("  Веса прогресса: " + safeJson(s.progressWeights));
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
      if (applyHistory.length) {
        lines.push("История применений (до " + MAX_HISTORY + " последних; этапы в мс, ядро: сетка/размытие/ореол, эталон: до/после):");
        for (var h = 0; h < applyHistory.length; h++) lines.push("  " + applyHistory[h]);
      }
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
      report: report,
      summary: function () { return summaryLines(info.apply); }
    };
  }

  return { create: create, safeJson: safeJson, fmtMB: fmtMB, fmtMs: fmtMs, fmtSec: fmtSec, applyParts: applyParts, summaryLines: summaryLines };
});
