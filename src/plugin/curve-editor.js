/* Halation: point curve editor on <canvas>.
 *
 * Free of UXP-only APIs so a browser demo page can reuse it. Defines
 * window.HalationCurveEditor (constructor); module.exports under Node.
 *
 * UXP canvas limits respected here: basic shapes only (no fillText, drawImage,
 * transforms, setLineDash); no clearRect and no gradients (broken on Windows),
 * so the canvas is cleared with fillRect. Labels are HTML elements.
 *
 * Curve model (see src/core/API.md): interior points [[x, y], ...] with
 * x = code 0..255 (integer) and y = linear light; endpoints (0,0) and (255,1)
 * are implicit. Every edit is checked with core.validateCurve and rejected
 * when it returns ok: false.
 */
(function (root, factory) {
  "use strict";
  var api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.HalationCurveEditor = api;
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function (root) {
  "use strict";

  var DARK = {
    background: "#1e1e1e",
    grid: "#363636",
    border: "#4a4a4a",
    reference: "#5f5f5f",
    curve: "#f29a4a",
    point: "#e6e6e6",
    pointStroke: "#1e1e1e",
    selected: "#ff6a1f",
    endpoint: "#7a7a7a"
  };

  var LIGHT = {
    background: "#fafafa",
    grid: "#dddddd",
    border: "#b8b8b8",
    reference: "#b0b0b0",
    curve: "#c4561a",
    point: "#2a2a2a",
    pointStroke: "#fafafa",
    selected: "#e0480a",
    endpoint: "#9a9a9a"
  };

  // validateCurve reason codes (src/core/transfer.js) in plain Russian.
  var REASONS = {
    "bad-format": "неверный формат точек",
    "too-many-points": "не больше 12 внутренних точек",
    "x-too-close": "точки должны отстоять по X хотя бы на 1 код",
    "not-increasing": "кривая должна возрастать: Y каждой точки больше, чем у соседки слева",
    "lut-not-increasing": "кривая слишком пологая: соседние коды сливаются в одно значение"
  };

  function reasonText(reason) {
    return REASONS[reason] || String(reason || "неизвестная причина");
  }

  var HIT_RADIUS = 8;        // CSS px
  var FRAME_TIMEOUT_MS = 250; // fallback when a requested animation frame does not come
  var DOUBLE_CLICK_MS = 400;
  var DOUBLE_CLICK_PX = 6;

  function defaultRequestFrame(cb) {
    if (typeof requestAnimationFrame === "function") return requestAnimationFrame(cb);
    return setTimeout(cb, 16);
  }

  function nowMs() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }

  function copyPoints(points) {
    var out = [];
    for (var i = 0; i < points.length; i++) out.push([points[i][0], points[i][1]]);
    return out;
  }

  function formatY(y) {
    if (!isFinite(y)) return "";
    return String(parseFloat(Number(y).toPrecision(6)));
  }

  function parseNumber(text) {
    if (text === null || text === undefined) return NaN;
    var s = String(text).trim().replace(",", ".");
    if (!s) return NaN;
    return Number(s);
  }

  function srgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function fieldValue(el) {
    if (!el) return "";
    return el.value !== undefined && el.value !== null ? String(el.value) : String(el.getAttribute("value") || "");
  }

  function setFieldValue(el, v) {
    if (!el) return;
    el.value = v;
    if (el.setAttribute && el.tagName && el.tagName.toLowerCase().indexOf("sp-") === 0) el.setAttribute("value", v);
  }

  function setDisabled(el, disabled) {
    if (!el) return;
    if (disabled) {
      el.setAttribute("disabled", "");
      el.disabled = true;
    } else {
      el.removeAttribute("disabled");
      el.disabled = false;
    }
  }

  function CurveEditor(opts) {
    if (!(this instanceof CurveEditor)) return new CurveEditor(opts);
    opts = opts || {};
    if (!opts.canvas) throw new Error("HalationCurveEditor: canvas is required");
    this.canvas = opts.canvas;
    this.ctx = this.canvas.getContext("2d");
    this.core = opts.core || (root && root.HalationCore);
    if (!this.core) throw new Error("HalationCurveEditor: HalationCore is not loaded");
    this.xLabels = opts.xLabels || null;
    this.yLabels = opts.yLabels || null;
    this.xField = opts.xField || null;
    this.yField = opts.yField || null;
    this.onChange = opts.onChange || function () {};
    this.onSelect = opts.onSelect || function () {};
    var rejectCb = opts.onReject || function () {};
    this.onReject = function (reason) { rejectCb(reasonText(reason)); };
    this.onLog = opts.onLog || function () {};
    this.colors = Object.assign({}, DARK, opts.colors || {});
    this.yAxis = opts.yAxis === "log" ? "log" : "linear";
    this.dpr = opts.devicePixelRatio || (root && root.devicePixelRatio) || 1;
    this.pad = 7; // CSS px around the plot
    this.fixedHeight = opts.height || 170;
    this.selected = -1;
    this.drag = null;
    this._lastDown = null;
    this._lastPointerEventAt = -Infinity;
    this._logMin = -4;
    this._loggedCaptureFallback = false;
    // One render per frame (v1.1 flicker fix). Tests pass requestFrame: cb => cb().
    this._requestFrame = opts.requestFrame || defaultRequestFrame;
    this._frameQueued = false;
    this._queuedAt = 0;
    this._frameToken = 0;
    this._labelKey = null;

    var init = this.core.validateCurve(opts.points || this.core.defaultCurvePoints());
    this.points = init.ok ? copyPoints(init.points) : copyPoints(this.core.validateCurve(this.core.defaultCurvePoints()).points);

    this._bind();
    this._recomputeLogRange();
    this.resize(opts.width, opts.height);
    this._syncFields();
  }

  CurveEditor.DARK = DARK;
  CurveEditor.LIGHT = LIGHT;
  CurveEditor.formatY = formatY;
  CurveEditor.parseNumber = parseNumber;
  CurveEditor.reasonText = reasonText;

  var P = CurveEditor.prototype;

  // ---------- public API ----------

  P.getPoints = function () {
    return copyPoints(this.points);
  };

  /** Replace all interior points. Returns the validateCurve result; nothing changes when ok is false. */
  P.setPoints = function (points, opts) {
    var res = this.core.validateCurve(points);
    if (!res.ok) return res;
    this.points = copyPoints(res.points);
    if (this.selected >= this.points.length) this.selected = -1;
    this._recomputeLogRange();
    this.render();
    this._syncFields();
    if (!opts || opts.silent !== true) this.onChange(this.getPoints(), { final: true, source: "set" });
    return res;
  };

  P.reset = function () {
    this.selected = -1;
    var res = this.setPoints(this.core.defaultCurvePoints(), { silent: true });
    this.onSelect(-1, null);
    this.onChange(this.getPoints(), { final: true, source: "reset" });
    return res;
  };

  /** Multiply the y of every interior point by k. */
  P.multiplyInterior = function (k) {
    k = Number(k);
    if (!(k > 0) || !isFinite(k)) {
      var bad = { ok: false, reason: "Коэффициент должен быть положительным числом" };
      this.onReject(bad.reason);
      return bad;
    }
    var cand = copyPoints(this.points);
    for (var i = 0; i < cand.length; i++) {
      var y = cand[i][1] * k;
      if (!(y < 1)) {
        var over = { ok: false, reason: "После умножения точка выходит за 1 — возьмите коэффициент меньше" };
        this.onReject(over.reason);
        return over;
      }
      cand[i][1] = y;
    }
    var res = this.core.validateCurve(cand);
    if (!res.ok) {
      this.onReject(res.reason);
      return res;
    }
    this.points = copyPoints(res.points);
    this._recomputeLogRange();
    this.render();
    this._syncFields();
    this.onChange(this.getPoints(), { final: true, source: "multiply" });
    return res;
  };

  P.setYAxis = function (mode) {
    this.yAxis = mode === "log" ? "log" : "linear";
    this._recomputeLogRange();
    this.render();
  };

  P.setColors = function (colors) {
    this.colors = Object.assign({}, DARK, colors || {});
    this.render();
  };

  P.select = function (index) {
    if (index < -1 || index >= this.points.length) index = -1;
    this.selected = index;
    this.render();
    this._syncFields();
    this.onSelect(index, index >= 0 ? [this.points[index][0], this.points[index][1]] : null);
  };

  P.removePoint = function (index) {
    if (index < 0 || index >= this.points.length) return { ok: false, reason: "Нет такой точки" };
    var cand = copyPoints(this.points);
    cand.splice(index, 1);
    var res = this.core.validateCurve(cand);
    if (!res.ok) {
      this.onReject(res.reason);
      return res;
    }
    this.points = copyPoints(res.points);
    this.selected = -1;
    this._recomputeLogRange();
    this.render();
    this._syncFields();
    this.onSelect(-1, null);
    this.onChange(this.getPoints(), { final: true, source: "remove" });
    return res;
  };

  /** Resize to the given CSS size; defaults to the parent's width and the configured height. */
  /** Resize to the given CSS size (default: the parent's width and the configured height).
   *  Assigning canvas.width clears the canvas, so it happens only when the integer size
   *  really changed (v1.1 flicker fix). Returns true when the canvas was resized. */
  P.resize = function (cssWidth, cssHeight) {
    var parent = this.canvas.parentNode;
    var w = cssWidth || (parent && parent.clientWidth) || this.cssWidth || 260;
    var h = cssHeight || this.fixedHeight;
    w = Math.max(120, Math.floor(w));
    h = Math.max(80, Math.floor(h));
    var pw = Math.round(w * this.dpr), ph = Math.round(h * this.dpr);
    var changed = !(w === this.cssWidth && h === this.cssHeight && this.canvas.width === pw && this.canvas.height === ph);
    if (changed) {
      this.cssWidth = w;
      this.cssHeight = h;
      this.canvas.width = pw;
      this.canvas.height = ph;
      this.canvas.style.width = w + "px";
      this.canvas.style.height = h + "px";
    }
    // Always draw synchronously: a resize after a stalled frame must still show the curve
    // (review v1.1 М4). Drawing without reassigning canvas.width does not flicker.
    this.renderNow();
    return changed;
  };

  P.destroy = function () {
    this._endDrag(null, true);
    this.canvas.removeEventListener("pointerdown", this._onPointerDown);
    this.canvas.removeEventListener("mousedown", this._onMouseDown);
    if (this.xField) {
      this.xField.removeEventListener("change", this._onFieldCommit);
      this.xField.removeEventListener("keydown", this._onFieldKey);
    }
    if (this.yField) {
      this.yField.removeEventListener("change", this._onFieldCommit);
      this.yField.removeEventListener("keydown", this._onFieldKey);
    }
  };

  // ---------- geometry ----------

  P._plot = function () {
    var d = this.dpr, pad = this.pad * d;
    return { x0: pad, y0: pad, x1: this.canvas.width - pad, y1: this.canvas.height - pad };
  };

  P._codeToPx = function (x, pl) {
    return pl.x0 + (x / 255) * (pl.x1 - pl.x0);
  };

  P._pxToCode = function (px, pl) {
    return ((px - pl.x0) / (pl.x1 - pl.x0)) * 255;
  };

  P._valToPx = function (y, pl) {
    var t;
    if (this.yAxis === "log") {
      var lmin = this._logMin;
      var ly = y > 0 ? Math.log(y) / Math.LN10 : lmin;
      if (ly < lmin) ly = lmin;
      t = (ly - lmin) / (0 - lmin);
    } else {
      t = y;
    }
    return pl.y1 - t * (pl.y1 - pl.y0);
  };

  P._pxToVal = function (py, pl) {
    var t = (pl.y1 - py) / (pl.y1 - pl.y0);
    if (this.yAxis === "log") {
      var lmin = this._logMin;
      return Math.pow(10, lmin + t * (0 - lmin));
    }
    return t;
  };

  P._recomputeLogRange = function () {
    if (this.drag) return; // keep the axis still while dragging
    var minPos = 1;
    for (var i = 0; i < this.points.length; i++) {
      if (this.points[i][1] > 0 && this.points[i][1] < minPos) minPos = this.points[i][1];
    }
    try {
      var s = this.core.curveSamples(this.points, 256);
      if (s && s.length > 1 && s[1] > 0 && s[1] < minPos) minPos = s[1];
    } catch (e) { /* drawing aid only */ }
    var l = Math.floor(Math.log(minPos * 0.5) / Math.LN10);
    if (l > -2) l = -2;
    if (l < -9) l = -9;
    this._logMin = l;
  };

  P._eventPos = function (e) {
    var rect = this.canvas.getBoundingClientRect();
    var sx = rect.width ? this.canvas.width / rect.width : this.dpr;
    var sy = rect.height ? this.canvas.height / rect.height : this.dpr;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  };

  P._hitTest = function (pos) {
    var pl = this._plot();
    var best = -1, bestD = HIT_RADIUS * this.dpr;
    for (var i = 0; i < this.points.length; i++) {
      var dx = this._codeToPx(this.points[i][0], pl) - pos.x;
      var dy = this._valToPx(this.points[i][1], pl) - pos.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  P._neighbors = function (points, index) {
    var prev = index > 0 ? points[index - 1] : [0, 0];
    var next = index < points.length - 1 ? points[index + 1] : [255, 1];
    return { prev: prev, next: next };
  };

  // Keep x between the neighbours (at least 1 code apart) and y strictly inside them.
  P._clampToCorridor = function (points, index, x, y) {
    var nb = this._neighbors(points, index);
    var xMin = nb.prev[0] + 1, xMax = nb.next[0] - 1;
    x = Math.round(x);
    if (x < xMin) x = xMin;
    if (x > xMax) x = xMax;
    var span = nb.next[1] - nb.prev[1];
    var eps = Math.max(span * 1e-4, 1e-12);
    if (!(y > nb.prev[1] + eps)) y = nb.prev[1] + eps;
    if (!(y < nb.next[1] - eps)) y = nb.next[1] - eps;
    return [x, y, xMin <= xMax];
  };

  // ---------- drawing ----------

  /** Schedule a redraw; several calls within one frame draw once. If the frame callback
   *  never comes (UXP may drop it for a hidden panel), a timer draws after FRAME_TIMEOUT_MS
   *  and a later render() call queues again (review v1.1 М4). */
  P.render = function () {
    var t = nowMs();
    if (this._frameQueued && t - this._queuedAt < FRAME_TIMEOUT_MS) return;
    this._frameQueued = true;
    this._queuedAt = t;
    var self = this;
    var token = ++this._frameToken;
    this._requestFrame(function () {
      if (self._frameQueued && self._frameToken === token) self.renderNow();
    });
    setTimeout(function () {
      if (self._frameQueued && self._frameToken === token) self.renderNow();
    }, FRAME_TIMEOUT_MS);
  };

  P.renderNow = function () {
    this._frameQueued = false;
    var ctx = this.ctx, c = this.colors, d = this.dpr;
    if (!ctx) return;
    var W = this.canvas.width, H = this.canvas.height;
    var pl = this._plot();
    var i;

    ctx.globalAlpha = 1;
    ctx.fillStyle = c.background;
    ctx.fillRect(0, 0, W, H); // no clearRect: broken on Windows UXP

    // grid
    ctx.lineWidth = Math.max(1, Math.round(d));
    ctx.strokeStyle = c.grid;
    ctx.beginPath();
    var xs = [64, 128, 192];
    for (i = 0; i < xs.length; i++) {
      var gx = Math.round(this._codeToPx(xs[i], pl)) + 0.5;
      ctx.moveTo(gx, pl.y0);
      ctx.lineTo(gx, pl.y1);
    }
    var yTicks = this._yTicks();
    for (i = 0; i < yTicks.length; i++) {
      if (yTicks[i].v <= 0 || yTicks[i].v >= 1) continue;
      var gy = Math.round(this._valToPx(yTicks[i].v, pl)) + 0.5;
      ctx.moveTo(pl.x0, gy);
      ctx.lineTo(pl.x1, gy);
    }
    ctx.stroke();

    // border
    ctx.strokeStyle = c.border;
    ctx.strokeRect(Math.round(pl.x0) + 0.5, Math.round(pl.y0) + 0.5, Math.round(pl.x1 - pl.x0), Math.round(pl.y1 - pl.y0));

    var n = Math.max(64, Math.min(512, Math.round((pl.x1 - pl.x0) / 2)));

    // reference: the standard sRGB curve
    ctx.strokeStyle = c.reference;
    ctx.lineWidth = Math.max(1, Math.round(d));
    ctx.beginPath();
    for (i = 0; i < n; i++) {
      var xr = (255 * i) / (n - 1);
      var px = this._codeToPx(xr, pl), py = this._valToPx(srgbToLinear(xr / 255), pl);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // active curve (spline from the core, drawn as a polyline)
    var samples = null;
    try {
      samples = this.core.curveSamples(this.points, n);
    } catch (e) {
      samples = null;
    }
    if (samples) {
      ctx.strokeStyle = c.curve;
      ctx.lineWidth = Math.max(2, Math.round(2 * d));
      ctx.beginPath();
      for (i = 0; i < samples.length; i++) {
        var cx = this._codeToPx((255 * i) / (samples.length - 1), pl);
        var cy = this._valToPx(samples[i], pl);
        if (i === 0) ctx.moveTo(cx, cy);
        else ctx.lineTo(cx, cy);
      }
      ctx.stroke();
    }

    // fixed endpoints
    this._dot(this._codeToPx(0, pl), this._valToPx(0, pl), 3 * d, c.endpoint, null);
    this._dot(this._codeToPx(255, pl), this._valToPx(1, pl), 3 * d, c.endpoint, null);

    // interior points
    for (i = 0; i < this.points.length; i++) {
      var sel = i === this.selected;
      this._dot(
        this._codeToPx(this.points[i][0], pl),
        this._valToPx(this.points[i][1], pl),
        (sel ? 5 : 4) * d,
        sel ? c.selected : c.point,
        c.pointStroke
      );
    }

    this._renderLabels(pl, yTicks);
  };

  P._dot = function (x, y, r, fill, stroke) {
    var ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.lineWidth = Math.max(1, Math.round(this.dpr));
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  };

  P._yTicks = function () {
    var ticks = [];
    if (this.yAxis === "log") {
      var lmin = this._logMin;
      var step = -lmin > 6 ? 2 : 1;
      for (var e = 0; e >= lmin; e -= step) {
        var v = Math.pow(10, e);
        var label = e === 0 ? "1" : e >= -2 ? String(v) : "1e" + e;
        ticks.push({ v: v, label: label });
      }
    } else {
      ticks = [
        { v: 1, label: "1" },
        { v: 0.75, label: "0.75" },
        { v: 0.5, label: "0.5" },
        { v: 0.25, label: "0.25" },
        { v: 0, label: "0" }
      ];
    }
    return ticks;
  };

  P._renderLabels = function (pl, yTicks) {
    var d = this.dpr, i, span;
    // Rebuild the HTML labels only when they change: rebuilding on every frame changed
    // the layout and fed the flicker (v1.1).
    var labelKey = this.yAxis + "|" + this._logMin + "|" + this.cssWidth + "|" + this.cssHeight;
    if (labelKey === this._labelKey) return;
    this._labelKey = labelKey;
    if (this.yLabels) {
      this.yLabels.innerHTML = "";
      this.yLabels.style.height = this.cssHeight + "px";
      for (i = 0; i < yTicks.length; i++) {
        span = document.createElement("span");
        span.className = "axis-label axis-label-y";
        span.textContent = yTicks[i].label;
        span.style.top = Math.round(this._valToPx(yTicks[i].v, pl) / d - 7) + "px";
        this.yLabels.appendChild(span);
      }
    }
    if (this.xLabels) {
      this.xLabels.innerHTML = "";
      var xs = [0, 64, 128, 192, 255];
      for (i = 0; i < xs.length; i++) {
        span = document.createElement("span");
        span.className = "axis-label axis-label-x";
        span.textContent = String(xs[i]);
        var left = this._codeToPx(xs[i], pl) / d;
        span.style.left = Math.round(left - (i === 0 ? 0 : i === xs.length - 1 ? 18 : 9)) + "px";
        this.xLabels.appendChild(span);
      }
    }
  };

  // ---------- pointer handling ----------

  P._bind = function () {
    var self = this;
    this._onPointerDown = function (e) { self._down(e, false); };
    this._onMouseDown = function (e) { self._down(e, true); };
    this._onMove = function (e) { self._move(e); };
    this._onUp = function (e) { self._endDrag(e, false); };
    this._onFieldCommit = function () { self._commitFields(); };
    this._onFieldKey = function (e) {
      if (e && (e.key === "Enter" || e.keyCode === 13)) self._commitFields();
    };
    this.canvas.addEventListener("pointerdown", this._onPointerDown);
    // Fallback for hosts without pointer events; ignored when pointer events arrive.
    this.canvas.addEventListener("mousedown", this._onMouseDown);
    if (this.xField) {
      this.xField.addEventListener("change", this._onFieldCommit);
      this.xField.addEventListener("keydown", this._onFieldKey);
    }
    if (this.yField) {
      this.yField.addEventListener("change", this._onFieldCommit);
      this.yField.addEventListener("keydown", this._onFieldKey);
    }
  };

  P._down = function (e, isMouse) {
    var t = nowMs();
    if (isMouse) {
      if (t - this._lastPointerEventAt < 1000 || this.drag) return;
    } else {
      this._lastPointerEventAt = t;
    }
    if (e.button !== undefined && e.button !== 0) return;
    if (e.preventDefault) e.preventDefault();
    var pos = this._eventPos(e);
    var hit = this._hitTest(pos);

    var last = this._lastDown;
    if (hit >= 0 && last && last.index === hit && t - last.t < DOUBLE_CLICK_MS &&
        Math.abs(last.x - pos.x) <= DOUBLE_CLICK_PX * this.dpr && Math.abs(last.y - pos.y) <= DOUBLE_CLICK_PX * this.dpr) {
      this._lastDown = null;
      this.removePoint(hit);
      return;
    }

    if (hit < 0) {
      var added = this._addAt(pos);
      if (!added.ok) {
        this._lastDown = null;
        this.onReject(added.reason);
        return;
      }
      hit = added.index;
    }
    this._lastDown = { t: t, index: hit, x: pos.x, y: pos.y };
    this.select(hit);
    this._startDrag(e, hit, isMouse);
  };

  P._addAt = function (pos) {
    var pl = this._plot();
    var x = Math.round(this._pxToCode(pos.x, pl));
    var y = this._pxToVal(pos.y, pl);
    if (x <= 0 || x >= 255) return { ok: false, reason: "Концы кривой закреплены — точку нужно ставить между ними" };
    if (this.points.length >= 12) return { ok: false, reason: "Не больше 12 внутренних точек" };
    var idx = 0;
    while (idx < this.points.length && this.points[idx][0] < x) idx++;
    if (idx < this.points.length && this.points[idx][0] === x) {
      return { ok: false, reason: "На этом коде уже есть точка" };
    }
    var cand = copyPoints(this.points);
    cand.splice(idx, 0, [x, y]);
    var cl = this._clampToCorridor(cand, idx, x, y);
    if (!cl[2]) return { ok: false, reason: "Слишком близко к соседней точке (нужен шаг не меньше 1 кода)" };
    cand[idx] = [cl[0], cl[1]];
    var res = this.core.validateCurve(cand);
    if (!res.ok) return { ok: false, reason: res.reason };
    this.points = copyPoints(res.points);
    var found = this._indexOfX(cl[0]);
    this.render();
    this.onChange(this.getPoints(), { final: true, source: "add" });
    return { ok: true, index: found };
  };

  P._indexOfX = function (x) {
    for (var i = 0; i < this.points.length; i++) if (this.points[i][0] === x) return i;
    return -1;
  };

  P._startDrag = function (e, index, isMouse) {
    if (index < 0) return;
    var captured = false;
    if (!isMouse && e.pointerId !== undefined && typeof this.canvas.setPointerCapture === "function") {
      try {
        this.canvas.setPointerCapture(e.pointerId);
        captured = true;
      } catch (err) {
        captured = false;
      }
    }
    if (!isMouse && !captured && !this._loggedCaptureFallback) {
      this._loggedCaptureFallback = true;
      this.onLog("setPointerCapture недоступен — перетаскивание через слушатели document");
    }
    var target = captured ? this.canvas : document;
    var moveEv = isMouse ? "mousemove" : "pointermove";
    var upEv = isMouse ? "mouseup" : "pointerup";
    target.addEventListener(moveEv, this._onMove);
    target.addEventListener(upEv, this._onUp);
    if (!isMouse) target.addEventListener("pointercancel", this._onUp);
    this.drag = {
      index: index,
      pointerId: e.pointerId,
      captured: captured,
      target: target,
      moveEv: moveEv,
      upEv: upEv,
      isMouse: isMouse,
      moved: false,
      lastReason: null
    };
  };

  P._move = function (e) {
    var dr = this.drag;
    if (!dr) return;
    if (!dr.isMouse && dr.pointerId !== undefined && e.pointerId !== undefined && e.pointerId !== dr.pointerId) return;
    if (e.preventDefault) e.preventDefault();
    var pl = this._plot();
    var pos = this._eventPos(e);
    var cand = copyPoints(this.points);
    var cl = this._clampToCorridor(cand, dr.index, this._pxToCode(pos.x, pl), this._pxToVal(pos.y, pl));
    if (cl[0] === cand[dr.index][0] && cl[1] === cand[dr.index][1]) return;
    cand[dr.index] = [cl[0], cl[1]];
    var res = this.core.validateCurve(cand);
    if (!res.ok) {
      if (res.reason !== dr.lastReason) {
        dr.lastReason = res.reason;
        this.onReject(res.reason);
      }
      return;
    }
    dr.lastReason = null;
    dr.moved = true;
    this.points = copyPoints(res.points);
    this.render();
    this._syncFields();
    this.onChange(this.getPoints(), { final: false, source: "drag" });
  };

  P._endDrag = function (e, silent) {
    var dr = this.drag;
    if (!dr) return;
    dr.target.removeEventListener(dr.moveEv, this._onMove);
    dr.target.removeEventListener(dr.upEv, this._onUp);
    if (!dr.isMouse) dr.target.removeEventListener("pointercancel", this._onUp);
    if (dr.captured && typeof this.canvas.releasePointerCapture === "function") {
      try {
        this.canvas.releasePointerCapture(dr.pointerId);
      } catch (err) { /* already released */ }
    }
    this.drag = null;
    this._recomputeLogRange();
    this.render();
    if (dr.moved && !silent) this.onChange(this.getPoints(), { final: true, source: "drag-end" });
  };

  // ---------- numeric fields ----------

  P._syncFields = function () {
    var has = this.selected >= 0 && this.selected < this.points.length;
    if (this.xField) {
      setFieldValue(this.xField, has ? String(this.points[this.selected][0]) : "");
      setDisabled(this.xField, !has);
    }
    if (this.yField) {
      setFieldValue(this.yField, has ? formatY(this.points[this.selected][1]) : "");
      setDisabled(this.yField, !has);
    }
  };

  P._commitFields = function () {
    var i = this.selected;
    if (i < 0 || i >= this.points.length) return;
    var cur = this.points[i];
    var x = this.xField ? parseNumber(fieldValue(this.xField)) : cur[0];
    var y = this.yField ? parseNumber(fieldValue(this.yField)) : cur[1];
    if (x === cur[0] && y === cur[1]) return;
    if (y === parseNumber(formatY(cur[1])) && x === cur[0]) return; // unchanged display value
    var reason = null;
    if (!isFinite(x) || Math.round(x) !== x || x < 0 || x > 255) reason = "X — целое число от 0 до 255";
    else if (x <= 0 || x >= 255) reason = "X внутренней точки — от 1 до 254";
    else if (!isFinite(y) || !(y > 0) || !(y < 1)) reason = "Y — число больше 0 и меньше 1";
    if (!reason) {
      var nb = this._neighbors(this.points, i);
      if (!(x > nb.prev[0] && x < nb.next[0])) reason = "Точки не меняются местами по X: X должен быть между " + nb.prev[0] + " и " + nb.next[0];
      else if (!(y > nb.prev[1] && y < nb.next[1])) reason = "Кривая должна возрастать: Y должен быть между " + formatY(nb.prev[1]) + " и " + formatY(nb.next[1]);
    }
    var res = null;
    if (!reason) {
      var cand = copyPoints(this.points);
      cand[i] = [x, y];
      res = this.core.validateCurve(cand);
      if (!res.ok) reason = res.reason;
    }
    if (reason) {
      this._syncFields();
      this.onReject(reason);
      return;
    }
    this.points = copyPoints(res.points);
    this._recomputeLogRange();
    this.render();
    this._syncFields();
    this.onChange(this.getPoints(), { final: true, source: "fields" });
  };

  return CurveEditor;
});
