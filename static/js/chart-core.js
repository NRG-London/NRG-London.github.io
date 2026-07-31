/* ================================================================
   NeilGarratt.com — Chart core
   Everything the static engine (charts.js) and the live engine
   (charts-live.js) must agree on, or the house style drifts:
   palettes, tones, theme resolution, scales, tick maths, number
   formatting, and the geometry constants.

   This file holds NO rendering. charts.js builds SVG strings;
   charts-live.js builds keyed DOM. They share these numbers so a
   live chart and a published PNG of the same data are the same
   picture.

   Public API:
     NGCore.state                    -> { tone, palette }   (shared default)
     NGCore.theme()                  -> resolved colours for NGCore.state
     NGCore.resolveTheme(tone, pal)  -> resolved colours, pure
     NGCore.lin(d0,d1,r0,r1)         -> linear scale fn
     NGCore.niceScale(min,max,n)     -> { min, max, step, ticks }
     NGCore.fmtCompact(v, unit) / fmtNum(v) / esc(s)
     NGCore.valueLabelPlacement(barTop, barHeight, geom)
     NGCore.readableOn(bgHex)
     NGCore.mix(a,b,t) / hexToRgb / rgbToHex
     NGCore.GEOM                     -> per-chart-type geometry
     NGCore.PALETTES / TONES / SEQ / DIV / INK / PAPER / DEEP
   ================================================================ */
(function (global) {
  'use strict';

  /* ---------- brand constants ---------- */
  var INK = '#1a2332', PAPER = '#f3f6f4', DEEP = '#243142';

  // Sequential blue ramp (light -> dark) for choropleths & heat
  var SEQ = ['#E2EEF7', '#B4D4EB', '#80B4DD', '#4A92CC', '#1877B8', '#004D80'];

  // Diverging amber <-> blue (politically neutral; avoids red/green)
  var DIV = ['#B5701E', '#E0A24E', '#EBC79A', '#DDE3DF', '#9CC2E0', '#4A92CC', '#0070BA'];

  var PALETTES = {
    mono: {
      label: 'Monochrome blue',
      note: 'Tints and shades of the brand blue. Calmest, most neutral.',
      series: ['#0070BA', '#5A9FD4', '#A9CFE9', '#004D80', '#7FB6DD', '#08324F'],
      highlight: '#0070BA'
    },
    amber: {
      label: 'Blue + amber accent',
      note: 'Blue does the work; warm amber pulls out the one number that matters.',
      series: ['#0070BA', '#E0A24E', '#5A9FD4', '#B5701E', '#08324F', '#A9CFE9'],
      highlight: '#E0A24E'
    },
    categorical: {
      label: 'Full categorical',
      note: 'Five distinct, muted hues derived from the brand for many-series data.',
      series: ['#0070BA', '#1A2332', '#E0A24E', '#3F8E7E', '#8A9490', '#5A9FD4'],
      highlight: '#0070BA'
    }
  };

  var TONES = {
    editorial: { label: 'Editorial', serifTitle: true, grid: true, dark: false, weight: 'comfortable' },
    minimal:   { label: 'Minimal',   serifTitle: false, grid: false, dark: false, weight: 'airy' },
    bold:      { label: 'Bold / social', serifTitle: false, grid: false, dark: true, weight: 'punchy' }
  };

  // Shared default selection. charts.js mutates this via setTone/setPalette;
  // charts-live.js passes tone/palette explicitly instead, so several cards on
  // one page can carry different tones.
  var state = { tone: 'editorial', palette: 'mono' };

  /* ---------- geometry ----------
     Extracted from the renderers so the live engine cannot drift from the
     static one. Changing a number here changes both. */
  var GEOM = {
    vbar: {
      W: 760, H: 430, m: { t: 14, r: 16, b: 54, l: 56 },
      barFrac: 0.62,   // bar width as a share of the slot
      barCap: 84,      // ...but never wider than this
      rx: 1,
      ticks: 5,
      gridW: 1, baseW: 1.5,
      valDy: -9,       // value label baseline, relative to bar cap
      valAscent: 13,   // space the label's ascenders need above that baseline
      valInsideDy: 19, // ...or this far BELOW the cap, when it won't fit above
      catDy: 22,       // category label, below the baseline
      tickDx: -10, tickDy: 4
    },
    gbar: {
      W: 760, H: 440, m: { t: 14, r: 16, b: 56, l: 56 },
      gpadFrac: 0.22,  // padding as a share of the group slot
      gutter: 1,       // px inset each side of a bar within its group
      rx: 1,
      ticks: 5,
      gridW: 1, baseW: 1.5,
      catDy: 22,
      tickDx: -10, tickDy: 4
    },
    line: {
      W: 760, H: 440, m: { t: 16, r: 132, b: 48, l: 56 },  // r: room for end-labels
      ticks: 5,
      gridW: 1, baseW: 1.5,
      catDy: 22,
      tickDx: -10, tickDy: 4,
      firstW: 3, restW: 2.25, dotR: 3.5, endDx: 10, endDy: 4,
      thinAbove: 8    // thin x labels to every other above this many points
    },
    ranking: {
      W: 760, m: { t: 8, r: 70, b: 8, l: 170 },
      rowH: 30, gap: 10,
      rx: 1,
      ticks: 4,
      gridW: 1, baseW: 1.5,
      labelDx: -12, valueDx: 9, textDy: 4,
      axisDy: 18
    },
    tilemap: {
      cell: 78, pad: 7, cols: 8, rows: 7,
      rx: 2,
      codeDy: -4, valDy: 16,
      hlW: 2.5
    },
    spark: { W: 132, H: 40, m: 4, areaOpacity: 0.10, lineW: 2, dotR: 3 }
  };

  /* ---------- colour helpers ---------- */
  function hexToRgb(h) {
    h = h.replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function rgbToHex(r) {
    return '#' + r.map(function (v) {
      var s = Math.max(0, Math.min(255, Math.round(v))).toString(16);
      return s.length === 1 ? '0' + s : s;
    }).join('');
  }
  function mix(a, b, t) {
    var ra = hexToRgb(a), rb = hexToRgb(b);
    return rgbToHex([0, 1, 2].map(function (i) { return ra[i] + (rb[i] - ra[i]) * t; }));
  }

  /* ---------- theme ----------
     resolveTheme is pure; theme() applies it to the shared default state. */
  function resolveTheme(toneName, paletteName) {
    var p = PALETTES[paletteName] || PALETTES.mono;
    var t = TONES[toneName] || TONES.editorial;
    var dark = t.dark;
    var adj = function (c) { return dark ? mix(c, '#ffffff', 0.18) : c; };
    return {
      dark: dark,
      grid: t.grid,
      serifTitle: t.serifTitle,
      series: p.series.map(adj),
      highlight: adj(p.highlight),
      muted: dark ? 'rgba(243,246,244,0.20)' : '#D2DAD6',
      mutedStrong: dark ? 'rgba(243,246,244,0.38)' : '#AEB9B4',
      text: dark ? '#F3F6F4' : INK,
      sub: dark ? 'rgba(243,246,244,0.62)' : '#6B7670',
      gridColor: dark ? 'rgba(243,246,244,0.10)' : '#E7ECE9',
      axisColor: dark ? 'rgba(243,246,244,0.26)' : '#C7D0CB',
      seq: SEQ,
      div: DIV
    };
  }
  function theme() { return resolveTheme(state.tone, state.palette); }

  /* ---------- scale + ticks ---------- */
  function lin(d0, d1, r0, r1) {
    return function (v) { return r0 + (v - d0) / (d1 - d0) * (r1 - r0); };
  }
  function niceNum(range, round) {
    var exp = Math.floor(Math.log10(range));
    var f = range / Math.pow(10, exp), nf;
    if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
    else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return nf * Math.pow(10, exp);
  }
  function niceScale(min, max, maxTicks) {
    maxTicks = maxTicks || 5;
    if (min === max) max = min + 1;
    var range = niceNum(max - min, false);
    var step = niceNum(range / (maxTicks - 1), true);
    var nMin = Math.floor(min / step) * step;
    var nMax = Math.ceil(max / step) * step;
    var ticks = [];
    for (var v = nMin; v <= nMax + step * 1e-6; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return { min: nMin, max: nMax, step: step, ticks: ticks };
  }

  /* ---------- formatting ---------- */
  function fmtCompact(v, unit) {
    unit = unit || '';
    var n = Math.abs(v), s = v < 0 ? '-' : '', out;
    if (n >= 1e9) out = (n / 1e9).toFixed(n % 1e9 ? 1 : 0) + 'bn';
    else if (n >= 1e6) out = (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'm';
    else if (n >= 1e3) out = (n / 1e3).toFixed(n % 1e3 ? 1 : 0) + 'k';
    else out = String(n);
    return s + (unit === '£' ? '£' : '') + out + (unit && unit !== '£' ? unit : '');
  }
  function fmtNum(v) { return v.toLocaleString('en-GB'); }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ---------- value-label placement ----------
     A bar whose value is close to the axis maximum leaves no room above its cap
     for the number, and the label's ascenders get clipped by the top of the
     viewBox (e.g. 99.0k against a 100k axis). When that happens, put the label
     INSIDE the bar just below the cap instead, in a colour that reads against
     the fill. Only ever inside a bar tall enough to hold it; otherwise clamp
     down to the first row that fits.

     Shared so the static and live engines place labels identically — the baked
     no-JS SVG has to match what the engine draws over it. */
  function valueLabelPlacement(barTop, barHeight, geom) {
    var above = barTop + geom.valDy;
    if (above - geom.valAscent >= 0) return { y: above, inside: false };
    var inside = barTop + geom.valInsideDy;
    if (inside <= barTop + barHeight) return { y: inside, inside: true };
    return { y: geom.valAscent, inside: false };
  }

  /* Ink or white, whichever reads on `bg`. */
  function readableOn(bg) {
    var r = hexToRgb(bg);
    var lum = (0.299 * r[0] + 0.587 * r[1] + 0.114 * r[2]) / 255;
    return lum > 0.6 ? INK : '#ffffff';
  }

  global.NGCore = {
    INK: INK, PAPER: PAPER, DEEP: DEEP, SEQ: SEQ, DIV: DIV,
    PALETTES: PALETTES, TONES: TONES, state: state, GEOM: GEOM,
    hexToRgb: hexToRgb, rgbToHex: rgbToHex, mix: mix,
    theme: theme, resolveTheme: resolveTheme,
    lin: lin, niceNum: niceNum, niceScale: niceScale,
    fmtCompact: fmtCompact, fmtNum: fmtNum, esc: esc,
    valueLabelPlacement: valueLabelPlacement, readableOn: readableOn
  };
})(window);
