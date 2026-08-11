/* ================================================================
   NeilGarratt.com — Chart core
   Everything the static engine (ngc2-static.js) and the live engine
   (ngc2-live.js) must agree on, or the house style drifts:
   palettes, tones, theme resolution, scales, tick maths, number
   formatting, and the geometry constants.

   This file holds NO rendering. ngc2-static.js builds SVG strings;
   ngc2-live.js builds keyed DOM. They share these numbers so a
   live chart and a published PNG of the same data are the same
   picture.

   Public API:
     NGC2Core.state                    -> { tone, palette }   (shared default)
     NGC2Core.theme()                  -> resolved colours for NGC2Core.state
     NGC2Core.resolveTheme(tone, pal)  -> resolved colours, pure
     NGC2Core.lin(d0,d1,r0,r1)         -> linear scale fn
     NGC2Core.niceScale(min,max,n)     -> { min, max, step, ticks }
     NGC2Core.fmtCompact(v, unit) / fmtNum(v) / esc(s)
     NGC2Core.valueLabelPlacement(barTop, barHeight, geom)
     NGC2Core.readableOn(bgHex)
     NGC2Core.decimalsFor(step)
     NGC2Core.fitCategoryLabels(labels, slotWidth, fontSize)
     NGC2Core.mix(a,b,t) / hexToRgb / rgbToHex
     NGC2Core.GEOM                     -> per-chart-type geometry
     NGC2Core.PALETTES / TONES / SEQ / DIV / INK / PAPER / DEEP
   ================================================================ */
(function (global) {
  'use strict';

  /* ---------- brand constants ---------- */
  var INK = '#1a2332', PAPER = '#f3f6f4', DEEP = '#243142';

  // Sequential blue ramp (light -> dark) for choropleths & heat
  var SEQ = ['#E2EEF7', '#B4D4EB', '#80B4DD', '#4A92CC', '#1877B8', '#004D80'];

  // Diverging amber <-> blue (politically neutral; avoids red/green)
  var DIV = ['#B5701E', '#E0A24E', '#EBC79A', '#DDE3DF', '#9CC2E0', '#4A92CC', '#0070BA'];

  /* LINE COLOURS ARE NOT THE BAR COLOURS.
     A filled bar is a large block: #E0A24E on the pale ground reads fine. A
     2-3px line is not, and the same amber comes in at 2.17:1 against the
     surface - below the 3:1 floor, which for the single most important mark on
     the chart is not good enough even with direct labels to fall back on.

     So each palette carries a validated trio for line charts:
       focus      the emphasised series
       reference  the comparison series
       band       the peer-range fill, a region rather than a mark

     These values are PINNED, not derived. Darkening the highlight toward the
     ink gets close (#b48648) but drops below the chroma floor at 0.097, so it
     reads grey; the hand-picked #b48544 clears both.

     THE REFERENCE MUST NOT OUT-SHOUT THE FOCUS. The first fix here paired the
     amber focus with the house blue #0070BA. Every check passed - and the
     chart was wrong, because a saturated blue at full strength pulls the eye
     harder than a darkened amber, so the comparison line read as the subject
     and the reader's own operator as background. Distinguishable is not the
     same as correctly ranked. The reference is a recessive slate instead: a
     neutral hue recedes while the warm accent advances, and they still
     separate at dE 23.2 normal / 19.7 protan.

     Validated with dataviz/validate_palette.js, August 2026:
       light  #b48544 + #4A5A6B  -> dE 23.2 normal, 19.7 CVD, both >= 3:1
       dark   lightened 0.36 / 0.10 against #243142 -> dE 27.5, both >= 3:1
              (an equal lightening collapses them to dE 14.8, hence the
              asymmetry)

     The band deliberately fails the categorical chroma and contrast checks and
     should: it is a shaded region behind the lines, not a mark anyone has to
     identify. A new palette needs the validator run over its own trio. */
  var PALETTES = {
    mono: {
      label: 'Monochrome blue',
      note: 'Tints and shades of the brand blue. Calmest, most neutral.',
      series: ['#0070BA', '#5A9FD4', '#A9CFE9', '#004D80', '#7FB6DD', '#08324F'],
      highlight: '#0070BA',
      line: { focus: '#0d5d94', reference: '#6E7A76', band: '#DDE3DF' }
    },
    amber: {
      label: 'Blue + amber accent',
      note: 'Blue does the work; warm amber pulls out the one number that matters.',
      series: ['#0070BA', '#E0A24E', '#5A9FD4', '#B5701E', '#08324F', '#A9CFE9'],
      highlight: '#E0A24E',
      line: { focus: '#b48544', reference: '#4A5A6B', band: '#DDE3DF' }
    },
    categorical: {
      label: 'Full categorical',
      note: 'Five distinct, muted hues derived from the brand for many-series data.',
      series: ['#0070BA', '#1A2332', '#E0A24E', '#3F8E7E', '#8A9490', '#5A9FD4'],
      highlight: '#0070BA',
      line: { focus: '#0d5d94', reference: '#6E7A76', band: '#DDE3DF' }
    }
  };

  var TONES = {
    editorial: { label: 'Editorial', serifTitle: true, grid: true, dark: false, weight: 'comfortable' },
    minimal:   { label: 'Minimal',   serifTitle: false, grid: false, dark: false, weight: 'airy' },
    bold:      { label: 'Bold / social', serifTitle: false, grid: false, dark: true, weight: 'punchy' }
  };

  // Shared default selection. ngc2-static.js mutates this via setTone/setPalette;
  // ngc2-live.js passes tone/palette explicitly instead, so several cards on
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
    // On the dark tone the ground is #243142, so the line trio is lightened
    // rather than darkened - the contrast problem inverts.
    var ln = p.line || { focus: p.highlight, reference: p.series[0], band: '#DDE3DF' };
    // Lightened ASYMMETRICALLY on the dark ground. Raising both by the same
    // amount walks them toward white together and collapses their separation
    // to dE 14.8; pulling the focus up further than the reference keeps the
    // hierarchy and the distinguishability at once.
    var adjFocus = function (c) { return dark ? mix(c, '#ffffff', 0.36) : c; };
    var adjRef = function (c) { return dark ? mix(c, '#ffffff', 0.10) : c; };
    return {
      dark: dark,
      grid: t.grid,
      serifTitle: t.serifTitle,
      series: p.series.map(adj),
      highlight: adj(p.highlight),
      lineFocus: adjFocus(ln.focus),
      lineReference: adjRef(ln.reference),
      bandFill: dark ? 'rgba(243,246,244,0.14)' : ln.band,
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

  /* ---------- a tighter scale for banded axes ----------
     niceScale takes a tick count and rounds outward to it. That is right for a
     bar chart, whose axis starts at zero anyway, but wasteful for a line chart
     on a band: On Time across a sector runs about 59% to 88%, and asking for
     five ticks yields a step of 10 and an axis of 50 to 100 - a third of the
     plot empty at each end, and the movement that matters squashed into the
     middle.

     niceScale cannot simply be asked for more ticks to fix this, because it
     rounds the RANGE to a nice number BEFORE dividing it: 35.3 becomes 50, and
     every tick count from four to eight then lands back on 50 to 100. So
     search the step directly - 1, 2, 2.5, 5 and 10 at each power of ten - and
     take the smallest that does not overrun the tick budget. */
  var _STEP_MANTISSAS = [1, 2, 2.5, 5, 10];

  function tightScale(min, max, maxTicks) {
    maxTicks = maxTicks || 9;
    if (min === max) { max = min + 1; }
    var span = max - min;
    var exp = Math.floor(Math.log10(span)) - 1;

    for (var e = exp; e <= exp + 3; e++) {
      var pow = Math.pow(10, e);
      for (var i = 0; i < _STEP_MANTISSAS.length; i++) {
        var step = _STEP_MANTISSAS[i] * pow;
        var lo = Math.floor(min / step) * step;
        var hi = Math.ceil(max / step) * step;
        var count = Math.round((hi - lo) / step) + 1;
        if (count <= maxTicks) {
          var ticks = [];
          for (var k = 0; k < count; k++) {
            // Rebuilt from the index rather than accumulated, so a fractional
            // step like 2.5 does not drift into 7.500000000000001.
            ticks.push(Math.round((lo + step * k) * 1e6) / 1e6);
          }
          return { min: lo, max: hi, step: step, ticks: ticks };
        }
      }
    }
    return niceScale(min, max, maxTicks);
  }

  /* ---------- room for direct end-labels ----------
     A line chart labels its series at the right-hand end instead of in a
     legend, so the right margin has to be whatever the longest label needs.
     A fixed margin either clips "London and South East" or wastes plot width
     on charts whose series are called "c2c".

     Computed from character widths rather than measured, for the same reason
     fitCategoryLabels is: the static engine builds a string and cannot measure
     before it commits, and both engines must reach the same answer or the
     baked SVG and the live render disagree. */
  function endLabelMargin(names, fontSize, base) {
    var widest = 0;
    for (var i = 0; i < names.length; i++) {
      widest = Math.max(widest, estimateTextWidth(names[i], fontSize || 13.5));
    }
    // endDx before the text, a little air after it, and never so wide that the
    // plot is squeezed to nothing.
    return Math.min(240, Math.max(base || 40, Math.ceil(widest) + 24));
  }

  /* ---------- thinning axis marks ----------
     A line over 159 four-week periods is labelled at its rail-year boundaries,
     which is thirteen "2014/15"-shaped labels across 760px. They collide.

     Rather than drop to every other year - which reads as arbitrary, because
     nothing distinguishes the years that survive - keep every k-th where k is
     the smallest divisor that makes the widest label fit its slot. The first
     mark is always kept so the axis starts where the data does.

     Shared by both engines, and computed from character widths rather than
     measured, for the same reason fitCategoryLabels is: the static engine
     builds a string and cannot measure before it commits. */
  function thinLabels(marks, labels, xOf, fontSize) {
    if (marks.length < 2) return marks.slice();
    var widest = 0;
    for (var i = 0; i < marks.length; i++) {
      widest = Math.max(widest, estimateTextWidth(labels[marks[i]], fontSize || 13.5));
    }
    var gap = Math.abs(xOf(marks[1]) - xOf(marks[0]));
    if (gap <= 0) return [marks[0]];
    // A little breathing room: labels are centred on the tick, so neighbours
    // meet at half a label each side.
    var need = widest * 1.15;
    var k = Math.max(1, Math.ceil(need / gap));
    var out = [];
    for (var j = 0; j < marks.length; j += k) out.push(marks[j]);
    return out;
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

  /* ---------- decimal places ----------
     How many decimals a value needs, given the axis step it sits on. A rate
     series can be any order of magnitude: London's robbery rate is ~3.9 per
     1,000, its homicide rate ~0.012. A fixed single decimal renders the second
     as "0.0" for every bar, and the axis as five zeroes.

     Derived from the step rather than the value so every tick and every label
     on one chart agree, and so the precision is exactly enough to distinguish
     adjacent ticks. */
  function decimalsFor(step) {
    if (!(step > 0)) return 0;
    return Math.max(0, Math.min(6, Math.ceil(-Math.log10(step))));
  }

  /* ---------- category label fitting ----------
     Axis ticks have to share the plot width. "2023/24" across fourteen
     financial years overlaps its neighbours and the whole axis blurs into a
     smear, while "2024" across thirteen calendar years has room to spare - so
     the decision has to follow the data rather than be fixed.

     A ladder, tried in order: the full label, then a shortened form, then
     shortened and rotated. The decision is computed from character widths and
     slot width, NOT measured from the DOM, because the static engine builds a
     string and cannot measure before it commits. Both engines run the same
     function on the same inputs and therefore reach the same answer, which is
     what keeps the baked no-JS SVG identical to what the live engine draws. */

  // Advance widths as a fraction of font size, DM Sans. Approximate, and only
  // ever used to choose between strategies with a margin - never to position.
  function _charWidth(ch) {
    if (ch >= '0' && ch <= '9') return 0.58;
    if (ch === '/' || ch === '.') return 0.32;
    if (ch === ' ') return 0.26;
    if (ch >= 'A' && ch <= 'Z') return 0.68;
    return 0.53;
  }
  function estimateTextWidth(s, fontSize) {
    var w = 0;
    s = String(s);
    for (var i = 0; i < s.length; i++) w += _charWidth(s.charAt(i));
    return w * fontSize;
  }

  /* "2023/24" -> "23/24". Anything else is returned unchanged, so a label with
     no shorter form simply skips that rung of the ladder. */
  function shortenLabel(s) {
    return String(s).replace(/^\d{2}(\d{2})\/(\d{2})$/, '$1/$2');
  }

  var _FIT = 0.95;          // of the slot; leaves a hairline between neighbours
  var _ROTATE_DEG = -45;

  function fitCategoryLabels(labels, slot, fontSize) {
    function widest(list) {
      var w = 0;
      for (var i = 0; i < list.length; i++) {
        w = Math.max(w, estimateTextWidth(list[i], fontSize));
      }
      return w;
    }
    var room = slot * _FIT;
    if (widest(labels) <= room) {
      return { labels: labels, rotate: 0, extraBottom: 0 };
    }
    var short = labels.map(shortenLabel);
    if (widest(short) <= room) {
      return { labels: short, rotate: 0, extraBottom: 0 };
    }
    // Rotated about the tick with text-anchor:end, so the label trails down and
    // to the left and needs vertical room it would not otherwise have.
    var rad = Math.abs(_ROTATE_DEG) * Math.PI / 180;
    return {
      labels: short, rotate: _ROTATE_DEG,
      extraBottom: Math.ceil(widest(short) * Math.sin(rad))
    };
  }

  /* Ink or white, whichever reads on `bg`. */
  function readableOn(bg) {
    var r = hexToRgb(bg);
    var lum = (0.299 * r[0] + 0.587 * r[1] + 0.114 * r[2]) / 255;
    return lum > 0.6 ? INK : '#ffffff';
  }

  global.NGC2Core = {
    INK: INK, PAPER: PAPER, DEEP: DEEP, SEQ: SEQ, DIV: DIV,
    PALETTES: PALETTES, TONES: TONES, state: state, GEOM: GEOM,
    hexToRgb: hexToRgb, rgbToHex: rgbToHex, mix: mix,
    theme: theme, resolveTheme: resolveTheme,
    lin: lin, niceNum: niceNum, niceScale: niceScale,
    tightScale: tightScale, endLabelMargin: endLabelMargin,
    thinLabels: thinLabels,
    fmtCompact: fmtCompact, fmtNum: fmtNum, esc: esc,
    valueLabelPlacement: valueLabelPlacement, readableOn: readableOn,
    decimalsFor: decimalsFor, fitCategoryLabels: fitCategoryLabels,
    shortenLabel: shortenLabel, estimateTextWidth: estimateTextWidth
  };
})(window);
