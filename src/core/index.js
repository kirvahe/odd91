'use strict';
// Public API of the halation core. See API.md.

const T = require('./transfer');
const S = require('./settings');
const P = require('./processor');
const V = require('./preview');
const PR = require('./presets');

module.exports = {
  VERSION: '1.1.2',
  DEFAULTS: S.DEFAULTS,
  normalizeSettings: S.normalizeSettings,
  defaultCurvePoints: T.defaultCurvePoints,
  validateCurve: T.validateCurve,
  curveSamples: T.curveSamples,
  buildLutIn: S.buildLutIn,
  blurMultiplier: S.blurMultiplier,
  blurFromSlider: S.blurFromSlider,
  blurToSlider: S.blurToSlider,
  strengthToA: S.strengthToA,
  colorGains: S.colorGains,
  loupeMargin: S.loupeMargin,
  LAMBDA_FRACTION: S.LAMBDA_FRACTION,
  haloRadiusFactors: S.haloRadiusFactors,
  haloRadii: S.haloRadii,
  speedProbe: require('./probe').speedProbe,
  createPreviewBuilder: V.createPreviewBuilder,
  renderPreview: V.renderPreview,
  createProcessor: P.createProcessor,
  processImage: P.processImage,
  baseLevelFor: P.autoBaseLevel,
  LOOKS: PR.LOOKS,
  settingsToToken: PR.settingsToToken,
  settingsFromToken: PR.settingsFromToken,
  describeSettings: PR.describeSettings,
  layerNameFor: PR.layerNameFor,
  settingsFromLayerName: PR.settingsFromLayerName,
  isResultLayerName: PR.isResultLayerName,
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
