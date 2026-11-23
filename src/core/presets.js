'use strict';
// Built-in looks and the settings token stored in the result layer name.

const S = require('./settings');

// Starting points chosen by eye on test images, not measurements of the named stocks.
const LOOKS = Object.freeze([
  Object.freeze({
    id: 'default',
    name: 'По умолчанию',
    description: 'Нейтральная отправная точка: sRGB, без каймы, сила 30 %.',
    settings: Object.freeze({ model: 'excess', mode: 'srgb', color: [255, 144, 39], blurMul: 1, strength: 30, threshold: 0, softness: 32 }),
  }),
  Object.freeze({
    id: 'cinestill-800t',
    name: 'CineStill 800T',
    description: 'Сильное красно-оранжевое свечение вокруг ламп, как у плёнки без противоореольного слоя.',
    settings: Object.freeze({ model: 'excess', mode: 'reinhard', reinhardLimit: 1.05, color: [255, 96, 32], blurMul: 1.6, strength: 70, threshold: 0, softness: 32 }),
  }),
  Object.freeze({
    id: 'vision3-soft',
    name: 'Vision3 — мягко',
    description: 'Едва заметный тёплый ореол, как у кинонегатива с противоореольным слоем.',
    settings: Object.freeze({ model: 'excess', mode: 'reinhard', reinhardLimit: 1.1, color: [255, 144, 39], blurMul: 0.6, strength: 30, threshold: 0, softness: 32 }),
  }),
  Object.freeze({
    id: 'lamps-only',
    name: 'Только лампы',
    description: 'Светятся только самые яркие источники, остальное изображение не трогается.',
    settings: Object.freeze({ model: 'excess', mode: 'reinhard', reinhardLimit: 1.02, color: [255, 120, 40], blurMul: 1, strength: 80, threshold: 235, softness: 20 }),
  }),
]);

const TOKEN_PREFIX = 'h1:';
const NAME_MAX = 255;

function hex2(v) {
  return Math.round(v).toString(16).padStart(2, '0').toUpperCase();
}

function num(v, digits) {
  // Compact number: fixed or exponent form, whichever is shorter, without trailing zeros.
  const p = Number(v).toPrecision(digits);
  const n = Number(p);
  const a = String(n);
  const b = n.toExponential(Math.max(0, digits - 1)).replace(/\.?0+e/, 'e');
  return a.length <= b.length ? a : b;
}

function encodeToken(settings, yDigits) {
  const s = S.normalizeSettings(settings);
  const parts = [
    'm=' + (s.mode === 'srgb' ? 's' : s.mode === 'curve' ? 'c' : 'r'),
    'o=' + (s.model === 'excess' ? 'e' : 'n'),
    'c=' + hex2(s.color[0]) + hex2(s.color[1]) + hex2(s.color[2]),
    's=' + num(s.strength, 4),
    'b=' + num(s.blurMul, 4),
  ];
  if (s.mode === 'reinhard') parts.push('L=' + num(s.reinhardLimit, 4));
  if (s.threshold > 0) parts.push('t=' + num(s.threshold, 4), 'f=' + num(s.softness, 4));
  if (s.mode === 'curve') parts.push('k=' + s.curvePoints.map((p) => num(p[0], 5) + ',' + num(p[1], yDigits)).join('|'));
  if (s.radii[0] !== 1 || s.radii[1] !== 1 || s.radii[2] !== 1) parts.push('r=' + s.radii.map((r) => num(r, 3)).join(','));
  return TOKEN_PREFIX + parts.join(';');
}

function settingsToToken(settings) {
  return encodeToken(settings, 6);
}

function settingsFromToken(token) {
  if (typeof token !== 'string' || token.indexOf(TOKEN_PREFIX) !== 0) return null;
  const out = {};
  const body = token.slice(TOKEN_PREFIX.length);
  for (const part of body.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i);
    const v = part.slice(i + 1);
    if (k === 'm') out.mode = v === 'c' ? 'curve' : v === 'r' ? 'reinhard' : 'srgb';
    else if (k === 'o') out.model = v === 'n' ? 'normalized' : 'excess';
    else if (k === 'c' && /^[0-9A-Fa-f]{6}$/.test(v)) out.color = [0, 2, 4].map((j) => parseInt(v.slice(j, j + 2), 16));
    else if (k === 's') out.strength = Number(v);
    else if (k === 'b') out.blurMul = Number(v);
    else if (k === 'L') out.reinhardLimit = Number(v);
    else if (k === 't') out.threshold = Number(v);
    else if (k === 'f') out.softness = Number(v);
    else if (k === 'k') {
      const pts = v.split('|').map((pt) => pt.split(',').map(Number));
      if (!S.normalizeSettings({}).curvePoints || !require('./transfer').validateCurve(pts).ok) return null;
      out.curvePoints = pts;
    }
    else if (k === 'r') out.radii = v.split(',').map(Number);
  }
  if (!out.mode) return null;
  return S.normalizeSettings(out);
}

function describeSettings(settings) {
  const s = S.normalizeSettings(settings);
  const mode = s.mode === 'srgb' ? 'sRGB' : s.mode === 'curve' ? 'кривая' : '8 бит L' + s.reinhardLimit.toFixed(2);
  const bits = [
    mode,
    s.model === 'excess' ? 'без каймы' : 'Proosa',
    'сила ' + Math.round(s.strength) + '%',
    '×' + (s.blurMul < 0.1 ? s.blurMul.toFixed(3) : s.blurMul.toFixed(2)),
    '#' + hex2(s.color[0]) + hex2(s.color[1]) + hex2(s.color[2]),
  ];
  if (s.threshold > 0) bits.push('порог ' + Math.round(s.threshold) + '/' + Math.round(s.softness));
  return bits.join(' · ');
}

function layerNameFor(settings) {
  for (const digits of [6, 5, 4, 3]) {
    const token = encodeToken(settings, digits);
    const full = 'Halation · ' + describeSettings(settings) + ' [' + token + ']';
    if (full.length <= NAME_MAX) return full;
    const short = 'Halation [' + token + ']';
    if (short.length <= NAME_MAX) return short;
  }
  return 'Halation';
}

function settingsFromLayerName(name) {
  if (typeof name !== 'string') return null;
  const m = /\[(h1:[^\]]*)\]\s*$/.exec(name);
  return m ? settingsFromToken(m[1]) : null;
}

// Only names this plugin produces: exactly "Halation" (v1.0) or "Halation[ · summary] [h1:token]"
// with a token that parses. A user layer such as "Halation glow" is never treated as a result.
function isResultLayerName(name) {
  if (typeof name !== 'string') return false;
  if (name === 'Halation') return true;
  return /^Halation( · .*)? \[h1:[^\]]*\]$/.test(name) && settingsFromLayerName(name) !== null;
}

module.exports = { LOOKS, settingsToToken, settingsFromToken, describeSettings, layerNameFor, settingsFromLayerName, isResultLayerName };
