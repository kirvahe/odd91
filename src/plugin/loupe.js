/* Halation panel: loupe geometry and display (pure JS, no UXP APIs).
 * Browser / UXP: window.HalationLoupe. Node: module.exports (tests).
 *
 * The loupe shows a full-resolution region and recomputes it with core.processImage.
 * To match "Применить" exactly (review v1.1 С1) it must use the apply's base level and
 * read a region whose origin lies on the same block grid as the apply's work area.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.HalationLoupe = api;
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function () {
  "use strict";

  // Pyramid blocks of every level up to 6 line up when the region origin is a multiple
  // of 64 from the work-area origin; deeper base levels need 2^level.
  var MIN_ALIGN = 64;
  var ZOOMS = [0.5, 1, 2];

  function rectW(r) { return r.right - r.left; }
  function rectH(r) { return r.bottom - r.top; }

  function rectContains(outer, inner) {
    return !!outer && !!inner && outer.left <= inner.left && outer.top <= inner.top &&
      outer.right >= inner.right && outer.bottom >= inner.bottom;
  }

  function normZoom(z) {
    z = Number(z);
    return ZOOMS.indexOf(z) >= 0 ? z : 1;
  }

  function alignUnit(baseLevel) {
    var l = Math.max(0, Math.floor(Number(baseLevel) || 0));
    return Math.max(MIN_ALIGN, Math.pow(2, l));
  }

  /** Document rectangle shown: (box size)/zoom around the centre, inside the work area. */
  function viewRect(center, area, box, zoom) {
    var z = normZoom(zoom);
    var rw = Math.max(1, Math.min(Math.floor(box.w / z), rectW(area)));
    var rh = Math.max(1, Math.min(Math.floor(box.h / z), rectH(area)));
    var left = Math.round(center.x - rw / 2);
    var top = Math.round(center.y - rh / 2);
    left = Math.max(area.left, Math.min(area.right - rw, left));
    top = Math.max(area.top, Math.min(area.bottom - rh, top));
    return { left: left, top: top, right: left + rw, bottom: top + rh };
  }

  /** The view plus the halo margin, inside the work area. The origin goes down and the
   *  far edge up to the block grid of the apply (alignUnit) counted from the area origin. */
  function readRect(view, margin, area, baseLevel) {
    var u = alignUnit(baseLevel);
    var m = Math.max(0, Math.ceil(Number(margin) || 0));
    var left = Math.max(area.left, view.left - m);
    var top = Math.max(area.top, view.top - m);
    var right = Math.min(area.right, view.right + m);
    var bottom = Math.min(area.bottom, view.bottom + m);
    left = area.left + Math.floor((left - area.left) / u) * u;
    top = area.top + Math.floor((top - area.top) / u) * u;
    right = Math.min(area.right, area.left + Math.ceil((right - area.left) / u) * u);
    bottom = Math.min(area.bottom, area.top + Math.ceil((bottom - area.top) / u) * u);
    return { left: left, top: top, right: right, bottom: bottom };
  }

  /** Copy a sub-rectangle out of a region { data, components, width, height, left, top }. */
  function cropRegion(region, rect) {
    var c = region.components;
    var w = rectW(rect), h = rectH(rect);
    if (rect.left === region.left && rect.top === region.top && w === region.width && h === region.height) {
      return { data: region.data, components: c, width: w, height: h };
    }
    var out = new Uint8Array(w * h * c);
    for (var y = 0; y < h; y++) {
      var s = ((rect.top - region.top + y) * region.width + (rect.left - region.left)) * c;
      out.set(region.data.subarray(s, s + w * c), y * w * c);
    }
    return { data: out, components: c, width: w, height: h };
  }

  /** Crop to the view, flatten alpha over a checkerboard, enlarge ×2 by nearest neighbour.
   *  Zoom ½ and ×1 give the view at one image pixel per document pixel; the panel shows
   *  ½ in an element half that size. */
  function displayRgb(data, comps, srcW, srcRect, view, zoom) {
    var k = normZoom(zoom) >= 2 ? 2 : 1;
    var vw = rectW(view), vh = rectH(view);
    var W = vw * k, H = vh * k;
    var out = new Uint8Array(W * H * 3);
    for (var y = 0; y < H; y++) {
      var dyDoc = Math.floor(y / k);
      var sy = view.top - srcRect.top + dyDoc;
      for (var x = 0; x < W; x++) {
        var dxDoc = Math.floor(x / k);
        var s = (sy * srcW + (view.left - srcRect.left + dxDoc)) * comps;
        var d = (y * W + x) * 3;
        if (comps === 4 && data[s + 3] < 255) {
          var a = data[s + 3] / 255;
          var bg = ((((view.left + dxDoc) >> 3) + ((view.top + dyDoc) >> 3)) & 1) ? 150 : 104;
          out[d] = Math.round(data[s] * a + bg * (1 - a));
          out[d + 1] = Math.round(data[s + 1] * a + bg * (1 - a));
          out[d + 2] = Math.round(data[s + 2] * a + bg * (1 - a));
        } else {
          out[d] = data[s];
          out[d + 1] = data[s + 1];
          out[d + 2] = data[s + 2];
        }
      }
    }
    return { data: out, width: W, height: H };
  }

  /** Size of the <img> element for a display image at this zoom. */
  function displaySize(img, zoom) {
    var z = normZoom(zoom);
    if (z < 1) return { w: Math.max(1, Math.round(img.width * z)), h: Math.max(1, Math.round(img.height * z)) };
    return { w: img.width, h: img.height };
  }

  return {
    ZOOMS: ZOOMS,
    normZoom: normZoom,
    alignUnit: alignUnit,
    rectContains: rectContains,
    viewRect: viewRect,
    readRect: readRect,
    cropRegion: cropRegion,
    displayRgb: displayRgb,
    displaySize: displaySize
  };
});
