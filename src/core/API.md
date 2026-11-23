# Halation core API (contract)

Pure JavaScript, no dependencies, no `require("photoshop")`, `require("uxp")` or Node APIs.

- **Node:** `const core = require("./src/core")` (CommonJS).
- **Browser / UXP:** `tools/bundle-core.mjs` writes `build/halation-core.js`, a single UMD file that defines the global `HalationCore` (and `module.exports` when available). The plugin build copies it into the plugin folder; `index.html` loads it with a `<script>` tag before the panel code.

All images are chunky 8-bit: `Uint8Array`, row-major, `components` = 3 (RGB) or 4 (RGBA).

## Settings

```js
{
  model: "excess" | "normalized",  // halo model, default "excess"
  mode: "srgb" | "curve" | "reinhard",
  reinhardLimit: 1.1,              // 1.01..4, mode "reinhard" only
  curvePoints: [[x, y], ...],      // interior points only; x = code 0..255, y = linear light 0..1
                                   // endpoints (0,0) and (255,1) are implicit; at most 12 points
  color: [r, g, b],                // glow color, sRGB 0..255; default [255, 144, 39]
  blurMul: 1,                      // 0.01..4 (legacy `blur` 0..100 accepted and converted)
  strength: 30,                    // percent 0..400
  threshold: 0,                    // 0..255 on the brightest channel; 0 = off
  softness: 32,                    // 0..255, width of the smooth transition
  radii: [1, 1, 1]                 // per-channel radius factors (advanced / demo only)
}
```

- `core.DEFAULTS`: frozen default settings.
- `core.normalizeSettings(partial)`: returns a complete, valid settings object and never throws. Unknown keys are dropped and values are clamped. An invalid curve falls back to `defaultCurvePoints()`; an invalid color falls back to the default.
- `core.defaultCurvePoints()`: interior points approximating the sRGB curve.
- `core.validateCurve(points)`: returns `{ ok, reason, points }`.
  - `points` is sorted and clamped.
  - `ok` is false when two points are less than 1 code apart in x, there are more than 12 points, or the resulting `LUT_in` is not strictly increasing in float32.
  - The UI must reject a drag or edit that yields `ok: false`.
- `core.curveSamples(points, n)`: returns a `Float32Array(n)` of linear y at `x = 255*i/(n-1)` (monotone Fritsch–Carlson spline), for drawing.
- `core.buildLutIn(settings)`: returns a `Float32Array(256)`, the code to linear table for the active mode.
- `core.blurMultiplier(blur)`: returns the number m.
- `core.colorGains(color)`: returns `[gR, gG, gB]`, the linearized color normalized to max = 1, or `null` if the max channel is below 1/255. The UI must reject such a color.

## Preview (cheap, curve-independent cache)

```js
const b = core.createPreviewBuilder({ width, height, maxLongSide: 500 });
b.push(data, components, y0, rows);   // full-width strips of the source, top to bottom
const proxy = b.finish();             // { width, height, srcWidth, srcHeight, f255, mean, alpha }
const img = core.renderPreview(proxy, settings, view, { docLongSide });
// view: "before" | "after" | "halo"
// img = { data: Uint8Array RGB (3 components), width, height }
```

- `proxy` stores, per pixel and channel, the fraction of source pixels at 255 (`f255`), their centroid inside the block (`off255`) and the sRGB-linear mean of the rest (`mean`). It does not depend on the curve or any other setting, so rebuild it only on panel show or the "Обновить" button.
- **Draft vs full** (measured with `node --jitless` on an M2 Pro, proxy 500×334):
  - `renderPreview(proxy, settings, view, { docLongSide, draft: true })` renders a half-size image in about 0.36 s. Use it while a slider or curve point is being dragged (`input` events, 100 ms debounce).
  - The full render takes about 1.5 s. Run it once the user stops, about 300 ms after the last change or on the `change` event.
  - Display either image scaled to the same box.
- Building the cache costs about 6 s per 24 Mpx without JIT, so show progress while it runs.
- `docLongSide` is the long side of the **document** in pixels. The radius is relative to it, so the preview matches the full result.

## Full-resolution processing (strips, two passes)

```js
const p = core.createProcessor({
  width, height,          // work area = layer bounds ∩ document
  originX, originY,       // work area offset in document pixels (dither coordinates)
  docLongSide,            // max(document width, height)
  settings
});
p.stripRows;              // recommended strip height (≈1 Mpx per strip)

// pass 1: every strip, top to bottom
p.pass1(data, components, y0, rows);

// blur: a generator; yield to the UI between steps
for (const progress of p.blurSteps()) { /* progress 0..1; await, check cancel */ }

// pass 2: every strip again (re-read the same pixels), top to bottom
const out = new Uint8Array(rows * width * components);
p.pass2(data, components, y0, rows, out);   // out has the same layout and alpha as data

p.stats;                  // { baseLevel, levels, bytes, gaussians: [...], timings: {...} }
```

- Strips must be full work-area width, with `rows * width * components` bytes. Pixels missing from `getPixels` (trimmed transparent areas) must be filled with alpha = 0 by the caller, which then passes `components = 4`.
- At strength 0, or for a flat field, `out` equals `data` bit for bit.
- Dither noise is indexed by absolute document coordinates `(originX + x, originY + y)`, so the result does not depend on the strip height.

## One-shot (tests, demo)

```js
const out = core.processImage(data, width, height, components, settings,
  { originX: 0, originY: 0, docLongSide: Math.max(width, height), stripRows: undefined });
```

This runs the same processor in one go.

`core.VERSION`: string.

## v1.1 additions

### Settings
- `blurMul`: blur multiplier 0.01..4, default 1. Canonical since v1.1. A legacy `blur` slider value (0..100) is still accepted when `blurMul` is absent and is converted as `2^((blur-50)/25)`. `normalizeSettings` returns `blurMul` and no `blur`.
- `strength`: percent 0..400, default 30. a_R = (p/100)² up to 100 %, then p/100 (400 % → a = 4).
- `threshold`: 0..255, default 0 (off). The code of the pixel's **brightest channel** from which it emits halo light. It is the brightest channel rather than luminance because saturated red neon and stop lights halate the most on film.
- `softness`: 0..255, default 32.
  - `w = smoothstep(e0, e1, max(R,G,B))` with `e1 = min(255, t + s/2)`, so white always has weight 1.
  - The halo source is `w·L·α`.
  - The pixel's own share uses the weight map blurred by the same kernel: `E = H − L·(K∗w)`. Flat fields stay unchanged, and noisy areas near the threshold don't turn into speckle (review v1.1, C4).
- Strength above 100 % in the excess model: `O = L + E·(1 + (a−1)·E/H)` (review v1.1, C5), so grain is not warmed. Thin dark details inside bright areas still glow at high strength; the remedy is a threshold above the background.

### Helpers
- `core.blurFromSlider(u)` / `core.blurToSlider(m)`: log mapping between a slider u ∈ 0..100 and m ∈ 0.01..4 (×1 sits at u ≈ 76.9).
- `core.blurMultiplier(settingsOrNumber)`: with a settings object, returns its normalized `blurMul`; with a number, applies the legacy 0..100 mapping.
- `core.strengthToA(percent)`.
- `core.baseLevelFor(width, height)`: the base level `createProcessor` picks for a work area. The loupe must use the apply's level, with its region origin aligned to `2^level`.
- `p.fineRadius` and `p.pass2(data, comps, y0, rows, out, { dataY0, dataRows })`: Gaussians narrower than one base-grid pixel are computed at full resolution in pass 2. They need `fineRadius` rows of context above and below each strip, so `data` covers `[dataY0, dataY0 + dataRows)`, while `out` covers exactly the strip. Without the options, `data` is the strip itself (clamped context).
- `core.loupeMargin(settings, docLongSide)`: integer pixels to read around a loupe region so the halo tail is complete. Capped at 1024.
- `core.processImage(..., { view: 'halo' })` and `createProcessor({ ..., view: 'halo' })`: output only the halo, encoded through the curve, as the preview's "Только ореол" does. The default view is `'after'`.
- `core.LOOKS`: an array of `{ id, name, description, settings }`, the built-in starting looks (names in Russian).
- `core.layerNameFor(settings)`: the result layer name, `"Halation · <short Russian summary> [h1:<token>]"`. It is at most 255 characters, and the token carries the full settings, curve points included.
- `core.settingsFromLayerName(name)`: settings, or null if the name carries no valid token. `core.isResultLayerName(name)`: true only for exactly "Halation" (v1.0) or a name ending with a parseable ` [h1:…]` token. A user layer such as "Halation glow", or a Photoshop copy ("… copy"), is not a result.
