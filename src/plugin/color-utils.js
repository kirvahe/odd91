/* Halation panel: colour helpers (pure JS, no UXP APIs).
 * Browser / UXP: defines window.HalationColor. Node: module.exports.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.HalationColor = api;
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function () {
  "use strict";

  // Presets inside the range of open models: green 0.07-0.35 of red, blue 0-0.1 (linear).
  var PRESETS = [
    { id: "cinestill", name: "CineStill", rgb: [255, 144, 39] },
    { id: "red", name: "Красный", rgb: [255, 89, 25] },
    { id: "deep-red", name: "Тёмно-красный", rgb: [255, 75, 0] },
    { id: "orange", name: "Оранжевый", rgb: [255, 160, 63] }
  ];

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function toByte(v) {
    return clamp(Math.round(v), 0, 255);
  }

  // h 0..360, s 0..100, v 0..100 -> [r, g, b] 0..255
  function hsvToRgb(h, s, v) {
    h = ((Number(h) % 360) + 360) % 360;
    s = clamp(Number(s) / 100, 0, 1);
    v = clamp(Number(v) / 100, 0, 1);
    var c = v * s;
    var hp = h / 60;
    var x = c * (1 - Math.abs((hp % 2) - 1));
    var r = 0, g = 0, b = 0;
    if (hp < 1) { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; }
    else if (hp < 5) { r = x; b = c; }
    else { r = c; b = x; }
    var m = v - c;
    return [toByte((r + m) * 255), toByte((g + m) * 255), toByte((b + m) * 255)];
  }

  // [r, g, b] 0..255 -> [h 0..360, s 0..100, v 0..100]
  function rgbToHsv(rgb) {
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var d = max - min;
    var h = 0;
    if (d > 0) {
      if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    var s = max === 0 ? 0 : d / max;
    return [Math.round(h), Math.round(s * 100), Math.round(max * 100)];
  }

  function rgbToCss(rgb) {
    return "rgb(" + toByte(rgb[0]) + ", " + toByte(rgb[1]) + ", " + toByte(rgb[2]) + ")";
  }

  function rgbToHex(rgb) {
    var s = "#";
    for (var i = 0; i < 3; i++) {
      var h = toByte(rgb[i]).toString(16);
      s += h.length < 2 ? "0" + h : h;
    }
    return s.toUpperCase();
  }

  function srgbEncode(lin) {
    lin = clamp(lin, 0, 1);
    return lin <= 0.0031308 ? 12.92 * lin : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055;
  }

  // CIE Lab (D50, as Photoshop uses) -> sRGB (D65) via Bradford adaptation.
  function labToRgb(L, a, b) {
    var fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    var e = 216 / 24389, k = 24389 / 27;
    function finv(t) { var t3 = t * t * t; return t3 > e ? t3 : (116 * t - 16) / k; }
    var X = 0.96422 * finv(fx);
    var Y = 1.0 * (L > k * e ? fy * fy * fy : L / k);
    var Z = 0.82521 * finv(fz);
    // Bradford D50 -> D65
    var X2 = 0.9555766 * X - 0.0230393 * Y + 0.0631636 * Z;
    var Y2 = -0.0282895 * X + 1.0099416 * Y + 0.0210077 * Z;
    var Z2 = 0.0122982 * X - 0.020483 * Y + 1.3299098 * Z;
    var r = 3.2404542 * X2 - 1.5371385 * Y2 - 0.4985314 * Z2;
    var g = -0.969266 * X2 + 1.8760108 * Y2 + 0.041556 * Z2;
    var bl = 0.0556434 * X2 - 0.2040259 * Y2 + 1.0572252 * Z2;
    return [toByte(srgbEncode(r) * 255), toByte(srgbEncode(g) * 255), toByte(srgbEncode(bl) * 255)];
  }

  function pickNum(o, keys) {
    if (!o || typeof o !== "object") return undefined;
    for (var i = 0; i < keys.length; i++) {
      var v = o[keys[i]];
      if (v && typeof v === "object" && typeof v._value === "number") v = v._value;
      if (typeof v === "number" && isFinite(v)) return v;
    }
    return undefined;
  }

  // Extract an sRGB 0..255 triplet from one colour descriptor, or null.
  function extractColor(c, keyHint) {
    if (!c || typeof c !== "object") return null;
    var cls = String(c._obj || c._class || "");
    var r = pickNum(c, ["red", "r"]);
    var g = pickNum(c, ["green", "grain", "g"]);
    var b = pickNum(c, ["blue", "b"]);
    if (r !== undefined && g !== undefined && b !== undefined && pickNum(c, ["luminance"]) === undefined) {
      var max = Math.max(r, g, b);
      // >1 can only be the 0..255 scale. Otherwise 0..1 (a 0..255 colour with all
      // channels <= 1 is black and gets rejected by colorGains anyway).
      var scale01 = !(max > 1.0001);
      var k = scale01 ? 255 : 1;
      return {
        rgb: [toByte(r * k), toByte(g * k), toByte(b * k)],
        format: (keyHint || cls || "rgb") + (scale01 ? " (0-1)" : " (0-255)")
      };
    }
    var L = pickNum(c, ["luminance", "lightness"]);
    var la = pickNum(c, ["a"]);
    var lb = pickNum(c, ["b"]);
    if (L !== undefined && la !== undefined && lb !== undefined) {
      return { rgb: labToRgb(L, la, lb), format: (keyHint || cls || "lab") + " (Lab)" };
    }
    var h = pickNum(c, ["hue", "h"]);
    var s = pickNum(c, ["saturation", "s"]);
    var v = pickNum(c, ["brightness", "v"]);
    if (h !== undefined && s !== undefined && v !== undefined) {
      return { rgb: hsvToRgb(h, s, v), format: (keyHint || cls || "hsb") + " (HSB)" };
    }
    return null;
  }

  /* Parse the batchPlay result of showColorPicker defensively.
   * Accepts RGBFloatColor or color, green or grain, 0..1 or 0..255, Lab, HSB.
   * Returns { rgb: [r,g,b] | null, cancelled: bool, format: string }.
   */
  function parseColorPickerResult(raw) {
    var r0 = Array.isArray(raw) ? raw[0] : raw;
    if (!r0 || typeof r0 !== "object") return { rgb: null, cancelled: true, format: "empty" };
    if (r0._obj === "error" || (typeof r0.result === "number" && r0.result !== 0 && !r0.color && !r0.RGBFloatColor)) {
      return { rgb: null, cancelled: true, format: "error: " + (r0.message || r0.result) };
    }
    var cands = [
      ["RGBFloatColor", r0.RGBFloatColor],
      ["rgbFloatColor", r0.rgbFloatColor],
      ["color", r0.color],
      ["foregroundColor", r0.foregroundColor],
      ["result", r0]
    ];
    for (var i = 0; i < cands.length; i++) {
      var got = extractColor(cands[i][1], cands[i][0]);
      if (got) return { rgb: got.rgb, cancelled: false, format: got.format };
    }
    return { rgb: null, cancelled: true, format: "no colour fields" };
  }

  return {
    PRESETS: PRESETS,
    hsvToRgb: hsvToRgb,
    rgbToHsv: rgbToHsv,
    rgbToCss: rgbToCss,
    rgbToHex: rgbToHex,
    labToRgb: labToRgb,
    parseColorPickerResult: parseColorPickerResult
  };
});
