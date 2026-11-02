/* Where things go on the replay's canvas, for any size of screen. Pure: loaded by
   the page and by Node for tests.

   Two modes, chosen from the canvas's own shape:
   - landscape (wider than tall): the 1920x1080 picture the clips use, scaled
     evenly to fit and centred (never stretched). Its coordinates are draw.js's
     constants; nothing here changes them.
   - portrait (an upright phone or tablet): the line runs top to bottom, one
     column for each direction, station names between them and each platform's
     timer outside its column. Units are CSS pixels, so text sizes are real sizes
     and nothing is drawn smaller than 12 px. The header, fleet line, caption and
     timeline sit above and below the line, on the same canvas.

   Station positions are on the same axis as everywhere else: index 0 is the
   outbound origin, a view is [first, last] in station units. `top` is the
   station index drawn at the top (the outbound end for the Bakerloo, Harrow). */
(function (root) {
  const LW = 1920, LH = 1080;
  const MIN_TEXT = 12;                       // CSS px: nothing smaller in portrait
  const TOUCH = 22;                          // CSS px: half a 44 px touch target
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function landscape(cssW, cssH) {
    const scale = Math.min(cssW / LW, cssH / LH);
    return { mode: 'landscape', W: LW, H: LH, scale, ox: (cssW - LW * scale) / 2, oy: (cssH - LH * scale) / 2,
             cssW, cssH, touch: TOUCH / scale };
  }

  function portrait(cssW, cssH, n, top) {
    const W = cssW, H = cssH, pad = 14;
    const hdr = 118;                                        // kicker, clock, status, fleet and tally lines
    const tl = { x0: pad + 4, x1: W - pad - 4, y: H - 30, h: 48 };
    const capTop = tl.y - 24 - 40;                          // two caption lines above the timeline
    const yA = hdr + 30, yB = capTop - 16;                  // the line, first station to last
    const xIn = Math.round(clamp(W * 0.17, 48, 120)), xOut = W - xIn;
    const flip = top === n - 1;                             // the outbound end at the top
    function mapper(view) {
      const k = (yB - yA) / Math.max(1e-6, view[1] - view[0]);
      const y = flip ? s => yA + (view[1] - s) * k : s => yA + (s - view[0]) * k;
      return { k, y, station: py => flip ? view[1] - (py - yA) / k : view[0] + (py - yA) / k };
    }
    return { mode: 'portrait', W, H, scale: 1, ox: 0, oy: 0, cssW, cssH, touch: TOUCH, pad, hdr, tl, capTop,
             yA, yB, xIn, xOut, nameW: xOut - xIn - 30, flip, mapper,
             colX: d => (d > 0 ? xOut : xIn),               // outbound (up the screen) on the right
             fs: px => Math.max(MIN_TEXT, px) };
  }

  /* n: stations on the line; top: the station drawn at the top in portrait. */
  function layout(cssW, cssH, n, top) {
    if (!(cssW > 0 && cssH > 0)) return landscape(LW, LH);
    return cssH > cssW * 1.05 ? portrait(cssW, cssH, n, top == null ? n - 1 : top) : landscape(cssW, cssH);
  }

  // The view an upright phone opens on: the whole line.
  const wholeView = n => [-0.6, n - 0.4];

  const api = { LW, LH, MIN_TEXT, TOUCH, layout, wholeView };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ReplayLayout = api;
})(typeof window !== 'undefined' ? window : globalThis);
