'use strict';
// Public API of the halation core. See API.md.

const T = require('./transfer');
const S = require('./settings');
const P = require('./processor');
const V = require('./preview');

module.exports = {
  VERSION: '1.0.0',
  DEFAULTS: S.DEFAULTS,
  normalizeSettings: S.normalizeSettings,
  defaultCurvePoints: T.defaultCurvePoints,
  validateCurve: T.validateCurve,
  curveSamples: T.curveSamples,
  buildLutIn: S.buildLutIn,
  blurMultiplier: S.blurMultiplier,
  colorGains: S.colorGains,
  createPreviewBuilder: V.createPreviewBuilder,
  renderPreview: V.renderPreview,
  createProcessor: P.createProcessor,
  processImage: P.processImage,
  // internals exposed for tests and the demo page
  _internal: {
    transfer: T,
    settings: S,
    kernelGaussians: S.kernelGaussians,
    autoBaseLevel: P.autoBaseLevel,
    previewFields: V.previewFields,
    halo: require('./halo'),
  },
};
