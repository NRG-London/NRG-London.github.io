/* ================================================================
   NeilGarratt.com — Live chart engine
   Animated, interactive bars in the house style. The 2D companion to
   the deck.gl viz: chip buttons, and a cubic swoosh between views.

   ngc2-static.js renders by building an SVG string and assigning innerHTML,
   which destroys every element on every render — nothing can tween.
   This engine keeps a stable, keyed DOM instead and interpolates it.
   Both read palettes, scales, formatters and geometry from
   ngc2-core.js, so a live chart and a published PNG of the same data
   are the same picture.

   REQUIRES ngc2-core.js. Chart types: vbar (one series), gbar (two).

   Public API:
     NGC2Live.mount(hostId, spec)   -> instance
     instance.set(dim, key)
     instance.view()              -> current selection
     window.__ngc2SetView / __ngc2SetTransition  (capture-driver hooks)
   ================================================================ */
(function (global) {
  'use strict';

  var C = global.NGC2Core;
  if (!C) throw new Error('ngc2-live.js requires ngc2-core.js to be loaded first');

  var SVG_NS = 'http://www.w3.org/2000/svg';

  var reducedMotion = global.matchMedia
    && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var DEFAULT_DURATION = reducedMotion ? 0 : 750;

  function easeCubicInOut(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  /* ---------- small helpers ---------- */
  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVG_NS, tag);
    if (attrs) for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    return n;
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerpColor(a, b, t) {
    var ra = C.hexToRgb(a), rb = C.hexToRgb(b);
    return C.rgbToHex([lerp(ra[0], rb[0], t), lerp(ra[1], rb[1], t), lerp(ra[2], rb[2], t)]);
  }

  /* ================================================================
     SPEC SHAPE
     The dims array always drove the chip UI generically, but the
     reducer underneath used to name its four dimensions. A spec now
     says which dims compose a dataset key and which one `copy` and
     `availability` hang off, so the engine never has to know what a
     dimension MEANS.

     interactive.py computes both of these the same way. If they drift,
     the baked no-JS view and the live view show different data.
     ================================================================ */
  function datasetKeyDims(spec) {
    // No declaration means the first two dims, which is what the original
    // hardcoded `view.crime + '|' + view.period` amounted to.
    if (spec.datasetKey && spec.datasetKey.length) return spec.datasetKey;
    return spec.dims.slice(0, 2).map(function (d) { return d.key; });
  }

  function datasetFor(spec, view) {
    var key = datasetKeyDims(spec).map(function (d) { return view[d]; }).join('|');
    return spec.datasets[key];
  }

  function primaryDim(spec) {
    for (var i = 0; i < spec.dims.length; i++) {
      if (spec.dims[i].primary) return spec.dims[i].key;
    }
    return spec.dims[0].key;
  }

  function initialView(spec) {
    var out = {};
    spec.dims.forEach(function (d) {
      out[d.key] = spec.initial[d.key] != null ? spec.initial[d.key]
                                               : d.options[0].key;
    });
    return out;
  }

  /* Which series the emphasis form picks out: everything else is context. */
  function focusName(spec, view) {
    return spec.emphasis ? view[spec.emphasis.dim] : null;
  }

  /* ================================================================
     ENCODINGS
     Facts ship; every other encoding is a pure function of them,
     derived here so adding one never means rebuilding the data.
     ================================================================ */
  function deriveValues(dataset, seriesIndex, encoding, spec) {
    var raw = dataset.series[seriesIndex].values;
    if (encoding === 'index') {
      var base = raw[0];
      if (!base) return raw.map(function () { return null; });
      return raw.map(function (v) { return v == null ? null : v / base * 100; });
    }
    if (encoding === 'rate') {
      var denom = (dataset.denominators || [])[seriesIndex];
      if (!denom) return raw.map(function () { return null; });
      return raw.map(function (v, i) {
        var d = denom.values[i];
        return (v == null || !d) ? null : v / d * 1000;
      });
    }
    if (encoding === 'rolling') {
      return rolling(raw, (spec && spec.rollingWindow) || 13);
    }
    return raw.slice();
  }

  /* Trailing mean over `window` points.
     Railway performance is strongly seasonal - autumn leaf fall and winter
     weather move every operator together - so a period-on-period line is
     mostly season. A 13-period trailing mean is one whole rail year, which is
     what ORR's own moving annual average uses, so the shape matches the
     published MAA rather than inventing a smoother.

     Leading points have no full window behind them and are null rather than
     averaged over what happens to be there: a "12-month average" computed from
     three periods is not one, and drawing it would put a confident line where
     there is no evidence. */
  function rolling(values, window) {
    var out = [];
    for (var i = 0; i < values.length; i++) {
      if (i + 1 < window) { out.push(null); continue; }
      var sum = 0, n = 0;
      for (var j = i - window + 1; j <= i; j++) {
        if (values[j] == null) { n = -1; break; }
        sum += values[j]; n++;
      }
      out.push(n === window ? sum / window : null);
    }
    return out;
  }

  /* A rate series can be any order of magnitude: London's robbery rate is ~3.9
     per 1,000, its homicide rate ~0.012. Fixing one decimal renders the second
     as "0.0" on every bar and an axis of five zeroes, so the precision comes
     from the axis step - exactly enough to tell adjacent ticks apart. */
  function formatValue(v, encoding, step, decimals) {
    if (v == null) return '';
    // An explicit decimal count wins: a punctuality figure of 68.4% rounded to
    // "68%" throws away the precision ORR publishes and makes two operators a
    // third of a point apart look identical.
    if (decimals != null) return v.toFixed(decimals);
    if (encoding === 'index') return Math.round(v).toString();
    if (encoding === 'rate') return v.toFixed(C.decimalsFor(step));
    return C.fmtCompact(Math.round(v), '');
  }
  function formatTick(v, encoding, step, unit) {
    // The unit belongs on the axis, not only in the tooltip. The static engine
    // puts it there (fmtCompact carries opts.unit), so leaving it off here made
    // the baked view read "100%" and the live view "100" - the same chart
    // disagreeing with itself across the JavaScript handover.
    if (encoding === 'rate') return v.toFixed(C.decimalsFor(step)) + (unit || '');
    return C.fmtCompact(v, unit || '');
  }

  /* ================================================================
     LAYOUT
     Pure: view -> pixel geometry. Everything the animator needs, keyed.
     ================================================================ */
  function computeLayout(spec, view, theme) {
    var dataset = datasetFor(spec, view);
    // A spec asks for grouping by naming the dim and value that means "show the
    // comparison series", rather than the engine testing for a magic string.
    var gw = spec.groupWhen;
    var grouped = !!gw && view[gw.dim] === gw.value && dataset.series.length > 1;
    var G = grouped ? C.GEOM.gbar : C.GEOM.vbar;
    var W = G.W, H = G.H, m = G.m;
    var iw = W - m.l - m.r, ih = H - m.t - m.b;

    var nS = grouped ? dataset.series.length : 1;
    var values = [];
    for (var s = 0; s < nS; s++) {
      values.push(deriveValues(dataset, s, view.encoding, spec));
    }

    var all = [];
    values.forEach(function (col) {
      col.forEach(function (v) { if (v != null) all.push(v); });
    });
    var maxV = all.length ? Math.max.apply(null, all) : 1;
    // Bars are read by comparing lengths, so their axis starts at zero and the
    // spec does not get to turn that off. Only the line renderer honours
    // zeroBaseline. See the note on axis bands in layoutLine.
    var sc = C.niceScale(0, maxV, G.ticks);
    var y = C.lin(sc.min, sc.max, m.t + ih, m.t);
    var baseline = y(0);

    var cats = dataset.categories;
    var n = cats.length;
    var bars = [], catLabels = [];

    // How much horizontal room each tick actually has, and therefore which
    // label form fits. Computed identically in ngc2-static.js, so the baked SVG and
    // the live render agree.
    var slot = iw / n;
    var catFont = theme.dark ? 14.5 : 13.5;
    var fit = C.fitCategoryLabels(cats, slot, catFont);
    H += fit.extraBottom;

    if (grouped) {
      var gstep = iw / n, gpad = gstep * G.gpadFrac;
      var inner = gstep - gpad, bw = inner / nS;
      cats.forEach(function (cat, ci) {
        var gx = m.l + gstep * ci + gpad / 2;
        for (var si = 0; si < nS; si++) {
          var v = values[si][ci];
          bars.push(makeBar(cat + '|' + si, gx + bw * si + G.gutter, bw - G.gutter * 2,
                            v, y, baseline, seriesColor(theme, si, dataset, ci, view),
                            ci, si, cat, dataset));
        }
        catLabels.push({ key: cat, x: gx + inner / 2, y: m.t + ih + G.catDy,
                         label: fit.labels[ci], rotate: fit.rotate });
      });
    } else {
      var step = iw / n, bwv = Math.min(step * G.barFrac, G.barCap);
      cats.forEach(function (cat, ci) {
        var cx = m.l + step * ci + step / 2;
        bars.push(makeBar(cat + '|0', cx - bwv / 2, bwv, values[0][ci], y, baseline,
                          seriesColor(theme, 0, dataset, ci, view), ci, 0, cat, dataset));
        catLabels.push({ key: cat, x: cx, y: m.t + ih + G.catDy,
                         label: fit.labels[ci], rotate: fit.rotate });
      });
    }

    return {
      W: W, H: H, m: m, iw: iw, ih: ih, grouped: grouped, baseline: baseline,
      step: sc.step,
      ticks: sc.ticks.map(function (t) {
        return { key: String(t), value: t, y: y(t),
                 label: formatTick(t, view.encoding, sc.step, spec.unit) };
      }),
      bars: bars, cats: catLabels, dataset: dataset, values: values,
      showValueLabels: !grouped && n <= 14,
      seriesNames: dataset.series.slice(0, nS).map(function (s) { return s.name; }),
      seriesColors: dataset.series.slice(0, nS).map(function (_, i) {
        return theme.series[i % theme.series.length];
      })
    };
  }

  function makeBar(key, x, w, v, y, baseline, fill, ci, si, cat, dataset) {
    var has = v != null;
    return {
      key: key, x: x, w: w,
      y: has ? y(v) : baseline,
      h: has ? Math.max(0, baseline - y(v)) : 0,
      fill: fill, value: has ? v : null, catIndex: ci, seriesIndex: si, cat: cat
    };
  }

  /* Bars whose period is short of data get the quiet treatment rather than a
     footnote the reader has to go and find:
       - coverage.material   a force didn't file; the bar is genuinely low
       - provisionalFrom     the population denominator is carried forward
       - complete === false  a part-period being shown under --partial flag   */
  /* Coverage is read from THIS series, never merged across the group. A London
     bar must not go grey because Lincolnshire failed to file — there is no
     Lincolnshire data on screen — and in a grouped chart only the affected
     series should be flagged. */
  function coverageAt(dataset, si, ci) {
    var series = dataset.series[si];
    return series && series.coverage ? series.coverage[ci] : null;
  }

  function seriesColor(theme, si, dataset, ci, view) {
    var base = theme.series[si % theme.series.length];

    // A missing force means the bar's HEIGHT is wrong — drop the hue entirely,
    // because the value itself should not be read.
    var cov = coverageAt(dataset, si, ci);
    if (cov && cov.material) return theme.mutedStrong;
    if (dataset.complete && dataset.complete[ci] === false) return theme.muted;

    // A carried-forward denominator is a weaker caveat: the height is about
    // right, the divisor is estimated. Keep the series hue and lighten it, so
    // "which series is this?" survives. Going grey here would encode two very
    // different problems identically AND lose the series distinction in a
    // grouped chart.
    if (view.encoding === 'rate' && dataset.provisionalFrom != null
        && ci >= dataset.provisionalFrom) {
      return C.mix(base, theme.dark ? C.DEEP : '#ffffff', 0.45);
    }
    return base;
  }

  /* ================================================================
     LINE LAYOUT
     Pure: view -> pixel geometry, same contract as computeLayout.

     WHY A BAND RATHER THAN A LINE PER OPERATOR
     Twenty-five operators drawn as grey context lines behind the
     selected one looks like the obvious "emphasis" form, and it is
     wrong here. Recorded punctuality across all operators spans about
     23% to 96%, so an axis wide enough to hold every line squashes the
     one line the reader actually came for into a flat wiggle - and the
     other twenty-four lines carry no information they can use, because
     none of them is labelled.

     So peers become a shaded band (the range across the operator's own
     sector) with the sector average as a line. Three marks instead of
     twenty-six, a tight axis, no palette-capacity problem, and it
     answers the two questions directly: the focus line against its own
     past is "better or worse", and the band is "compared to whom".

     WHY THE AXIS NEED NOT START AT ZERO
     A line encodes position, not length, so reading it does not depend
     on the baseline the way a bar does. On Time sits between roughly
     55% and 80% for most operators; a zero-based axis spends two
     thirds of the plot on empty space and hides every movement that
     matters. The axis is banded instead, and the subtitle says so.
     ================================================================ */
  function seriesRole(s) { return s.role || 'operator'; }

  function layoutLine(spec, view, theme) {
    var dataset = datasetFor(spec, view);
    var G = C.GEOM.line;
    var W = G.W, H = G.H, m = { t: G.m.t, r: G.m.r, b: G.m.b, l: G.m.l };

    var focus = focusName(spec, view);
    var cats = dataset.categories;
    var long = dataset.categoriesLong || cats;

    // Visible window: the spec ships the whole history and a `span` dim chooses
    // how much of the tail to show, so extending the range is a chip rather
    // than another dataset.
    var span = spec.spans && spec.spans[view[spec.spanDim]] ;
    var from = (span && span > 0) ? Math.max(0, cats.length - span) : 0;
    var n = cats.length - from;

    // Which marks this view draws.
    var byName = {};
    dataset.series.forEach(function (s) { byName[s.name] = s; });
    var focusSeries = byName[focus] || dataset.series[0];

    var compare = spec.compareDim ? view[spec.compareDim] : null;
    var band = null, reference = null;
    if (compare && compare !== 'none') {
      var wanted = compare === 'sector'
        ? (focusSeries && focusSeries.sector)
        : (spec.nationalSeries || 'Great Britain');
      var candidate = byName[wanted];
      if (candidate) {
        reference = candidate;
        if (candidate.lo && candidate.hi) band = candidate;
      }
    }

    var drawn = [focusSeries, reference].filter(Boolean);

    // Domain from everything actually drawn, band edges included, so a peer
    // range never runs off the top of the plot.
    var all = [];
    var seriesValues = {};
    drawn.forEach(function (s) {
      var idx = dataset.series.indexOf(s);
      var vals = deriveValues(dataset, idx, view.encoding, spec);
      seriesValues[s.name] = vals;
      for (var i = from; i < cats.length; i++) if (vals[i] != null) all.push(vals[i]);
    });
    if (band) {
      var lo = encodeEdge(band.lo, dataset, view, spec);
      var hi = encodeEdge(band.hi, dataset, view, spec);
      seriesValues['__lo'] = lo;
      seriesValues['__hi'] = hi;
      for (var k = from; k < cats.length; k++) {
        if (lo[k] != null) all.push(lo[k]);
        if (hi[k] != null) all.push(hi[k]);
      }
    }

    var minV = all.length ? Math.min.apply(null, all) : 0;
    var maxV = all.length ? Math.max.apply(null, all) : 1;
    var zeroBased = spec.zeroBaseline !== false;
    // A little air above and below so the line never touches the frame.
    var pad = Math.max((maxV - minV) * 0.06, 0.4);
    var sc = zeroBased ? C.niceScale(0, maxV, G.ticks)
                       : C.tightScale(minV - pad, maxV + pad);

    // The right margin is whatever the direct end-labels need. Series are
    // labelled at the line rather than in a legend, and "London and South East"
    // does not fit in the margin "c2c" needs.
    m.r = C.endLabelMargin(drawn.map(function (s) { return s.name; }),
                           13.5, G.m.r * 0.5) + C.GEOM.line.endDx;

    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var y = C.lin(sc.min, sc.max, m.t + ih, m.t);
    var x = C.lin(0, Math.max(1, n - 1), m.l, m.l + iw);

    // Axis ticks: one per rail year rather than one per period. 160 period
    // labels cannot be drawn, and thinning "every other" would land on an
    // arbitrary period rather than a year boundary a reader can orient by.
    var axisLabels = dataset.categoriesAxis || cats;
    var marks = (dataset.yearMarks || []).filter(function (i) { return i >= from; });
    if (!marks.length) {
      var everyK = Math.max(1, Math.ceil(n / 8));
      for (var mi = from; mi < cats.length; mi += everyK) marks.push(mi);
    }
    // Thin to whatever actually fits. Twelve rail years of "2014/15" labels do
    // not, and drawing them anyway produces a smear rather than an axis.
    marks = C.thinLabels(marks, axisLabels, function (i) { return x(i - from); }, 13.5);

    var catLabels = marks.map(function (ci) {
      return {
        key: cats[ci], index: ci, x: x(ci - from),
        y: m.t + ih + G.catDy, label: axisLabels[ci], rotate: 0
      };
    });

    var provFrom = dataset.provisionalFrom;
    var lines = drawn.map(function (s) {
      var role = s === focusSeries ? 'focus' : 'reference';
      return buildLine(s, seriesValues[s.name], from, cats.length, x, y,
                       role, theme, spec, provFrom);
    });

    return {
      kind: 'line', W: W, H: H, m: m, iw: iw, ih: ih,
      step: sc.step, zeroBased: zeroBased,
      ticks: sc.ticks.map(function (t) {
        return { key: String(t), value: t, y: y(t),
                 label: formatTick(t, view.encoding, sc.step, spec.unit) };
      }),
      cats: catLabels, lines: lines,
      band: band ? buildBand(seriesValues['__lo'], seriesValues['__hi'],
                             from, cats.length, x, y, band, theme) : null,
      from: from, n: n, x: x, y: y,
      dataset: dataset, categoriesLong: long,
      focus: focusSeries ? focusSeries.name : null,
      reference: reference ? reference.name : null,
      seriesValues: seriesValues,
      provisionalFrom: provFrom
    };
  }

  /* A band edge is a plain array on the series, so it needs the same encoding
     treatment as a values array - otherwise switching to a rolling average
     smooths the line and leaves the band jagged around it. */
  function encodeEdge(edge, dataset, view, spec) {
    if (view.encoding === 'rolling') {
      return rolling(edge, (spec && spec.rollingWindow) || 13);
    }
    return edge.slice();
  }

  function buildLine(series, values, from, end, x, y, role, theme, spec, provFrom) {
    var points = [];
    for (var i = from; i < end; i++) {
      if (values[i] == null) continue;
      points.push({ i: i, x: x(i - from), y: y(values[i]), v: values[i] });
    }
    // The provisional tail is drawn as its own dashed path rather than a dashed
    // whole line: the reader has to be able to see WHERE the figures stop being
    // final, and a uniformly dashed series would say the entire history is
    // provisional.
    var solid = points, dashed = [];
    if (provFrom != null && role === 'focus') {
      solid = points.filter(function (p) { return p.i <= provFrom; });
      dashed = points.filter(function (p) { return p.i >= provFrom; });
    }
    return {
      key: series.name, name: series.name, role: role,
      color: role === 'focus' ? theme.lineFocus : theme.lineReference,
      width: role === 'focus' ? C.GEOM.line.firstW : C.GEOM.line.restW,
      points: points,
      // Carried on the line rather than read back off the instance's `layout`,
      // which during a render still holds the OUTGOING view.
      provFrom: role === 'focus' ? provFrom : null,
      d: pathOf(solid),
      dashed: dashed.length > 1 ? pathOf(dashed) : null,
      last: points.length ? points[points.length - 1] : null
    };
  }

  function buildBand(lo, hi, from, end, x, y, series, theme) {
    var top = [], bottom = [];
    for (var i = from; i < end; i++) {
      if (lo[i] == null || hi[i] == null) continue;
      top.push({ x: x(i - from), y: y(hi[i]) });
      bottom.push({ x: x(i - from), y: y(lo[i]) });
    }
    if (top.length < 2) return null;
    bottom.reverse();
    return {
      name: series.name,
      d: pathOf(top) + ' L' + bottom.map(function (p) {
        return p.x.toFixed(1) + ' ' + p.y.toFixed(1);
      }).join(' L') + ' Z',
      fill: theme.bandFill
    };
  }

  function pathOf(points) {
    if (!points.length) return '';
    return points.map(function (p, i) {
      return (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1);
    }).join(' ');
  }

  /* ================================================================
     THE INSTANCE
     ================================================================ */
  function mount(hostId, spec) {
    var host = typeof hostId === 'string' ? document.getElementById(hostId) : hostId;
    if (!host) throw new Error('NGC2Live.mount: no element ' + hostId);

    var figure = host.closest ? host.closest('.ngc2-chart') : null;
    var theme = C.resolveTheme(spec.tone || 'editorial', spec.palette || 'mono');
    var duration = DEFAULT_DURATION;

    var isLine = spec.chartType === 'line';
    var view = initialView(spec);
    var PRIMARY = primaryDim(spec);

    // live DOM, keyed
    var nodes = { bars: {}, ticks: {}, cats: {}, grid: {} };
    var layout = null;
    var raf = null;
    var pendingFinish = null;

    /* ---------- scaffold ---------- */
    host.textContent = '';
    var svg = svgEl('svg', {
      'class': 'ngc2-svg', width: '100%',
      preserveAspectRatio: 'xMidYMid meet', role: 'img'
    });
    var gGrid = svgEl('g', { 'class': 'ngl2-grid' });
    var gBand = svgEl('g', { 'class': 'ngl2-band' });
    var gLines = svgEl('g', { 'class': 'ngl2-lines' });
    var gBars = svgEl('g', { 'class': 'ngl2-bars' });
    var gCats = svgEl('g', { 'class': 'ngl2-cats' });
    var gTicks = svgEl('g', { 'class': 'ngl2-ticks' });
    var gHover = svgEl('g', { 'class': 'ngl2-hover' });
    var baselineEl = svgEl('line', {
      stroke: theme.axisColor, 'stroke-width': C.GEOM.vbar.baseW
    });
    svg.appendChild(gGrid);
    svg.appendChild(baselineEl);
    // Band first so lines draw over it; the hover layer sits on top of both.
    svg.appendChild(gBand);
    svg.appendChild(gBars);
    svg.appendChild(gLines);
    svg.appendChild(gCats);
    svg.appendChild(gTicks);
    svg.appendChild(gHover);
    host.appendChild(svg);

    // Reuse the slot the shortcode renders, so the legend does not ENTER the
    // layout on load. Creating it here appended it inside the plot box and
    // grew the box by a line - a 34px shift the moment JavaScript arrived,
    // which is exactly what baking the SVG is meant to avoid.
    var legend = (figure && figure.querySelector('.ngc2-legend'))
              || host.querySelector('.ngc2-legend');
    if (!legend) {
      legend = document.createElement('div');
      legend.className = 'ngc2-legend';
      host.appendChild(legend);
    }

    var tooltip = document.createElement('div');
    tooltip.className = 'ngl2-tooltip';
    tooltip.setAttribute('role', 'status');
    (figure || host).appendChild(tooltip);

    var live = document.createElement('div');
    live.className = 'ngl2-sr';
    live.setAttribute('aria-live', 'polite');
    (figure || host).appendChild(live);

    /* ---------- chips ---------- */
    var controls = buildControls();

    function buildControls() {
      var existing = figure && figure.querySelector('.ngl2-controls');
      var box = existing || document.createElement('div');
      box.className = 'ngl2-controls';
      box.textContent = '';
      var rows = {};

      spec.dims.forEach(function (dim) {
        var row = document.createElement('div');
        row.className = 'ngl2-chiprow' + (dim.primary ? '' : ' ngl2-chiprow--sub');
        row.setAttribute('role', 'group');
        var labelId = spec.id + '-dim-' + dim.key;
        var lab = document.createElement('span');
        lab.className = 'ngl2-chiprow__label';
        lab.id = labelId;
        lab.textContent = dim.label;
        row.setAttribute('aria-labelledby', labelId);
        row.appendChild(lab);

        dim.options.forEach(function (opt) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'ngl2-chip';
          b.textContent = opt.label;
          b.dataset.dim = dim.key;
          b.dataset.key = opt.key;
          b.setAttribute('aria-pressed', String(view[dim.key] === opt.key));
          b.addEventListener('click', function () { set(dim.key, opt.key); });
          row.appendChild(b);
        });

        // Roving arrow-key navigation within a row, so a keyboard user isn't
        // tabbing through 11 crime types to reach the period chips.
        row.addEventListener('keydown', function (e) {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          var btns = [].slice.call(row.querySelectorAll('.ngl2-chip:not(:disabled)'));
          var i = btns.indexOf(document.activeElement);
          if (i === -1) return;
          e.preventDefault();
          btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length].focus();
        });

        rows[dim.key] = row;
        box.appendChild(row);
      });

      if (!existing && figure) {
        var plot = figure.querySelector('.ngc2-chart__plot');
        if (plot && plot.parentNode) plot.parentNode.insertBefore(box, plot.nextSibling);
        else figure.appendChild(box);
      } else if (!existing) {
        host.appendChild(box);
      }
      box.hidden = false;
      return { box: box, rows: rows };
    }

    var noteEl = document.createElement('p');
    noteEl.className = 'ngl2-note';
    (figure || host).insertBefore(noteEl, controls.box.nextSibling);

    /* ---------- state ---------- */
    function availableFor(dim) {
      var avail = spec.availability[view[PRIMARY]] || {};
      return avail[dim] || null;
    }

    function set(dim, key) { setMany(defineOne(dim, key)); }

    function defineOne(dim, key) { var o = {}; o[dim] = key; return o; }

    /* Apply a whole view change as ONE transition.
       Setting dimensions one at a time would start a separate animation per
       dimension, and each new one cancels its predecessor mid-flight — which
       is how exiting nodes get orphaned. A view change is one change. */
    function setMany(changes) {
      // Build the whole candidate view first, THEN validate it. Validating each
      // dimension as it arrives makes the result depend on key iteration order:
      // a change to two dims at once would check the second against the
      // OUTGOING value of the first and silently drop it. Callers should not
      // have to know the order matters, so it doesn't.
      var next = {};
      Object.keys(view).forEach(function (dim) { next[dim] = view[dim]; });
      Object.keys(changes || {}).forEach(function (dim) {
        if (dim in next) next[dim] = changes[dim];
      });

      // A choice of primary option can rule out values of another dim - the
      // combination has no data behind it - so fall back rather than render an
      // empty series.
      var avail = spec.availability[next[PRIMARY]] || {};
      Object.keys(avail).forEach(function (dim) {
        var allowed = avail[dim];
        if (allowed && allowed.indexOf(next[dim]) === -1) next[dim] = allowed[0];
      });

      var dirty = false;
      Object.keys(next).forEach(function (dim) {
        if (view[dim] !== next[dim]) { view[dim] = next[dim]; dirty = true; }
      });
      if (!dirty) return;                            // never restart a transition
      refresh();
    }

    function syncChips() {
      spec.dims.forEach(function (dim) {
        var btns = controls.rows[dim.key].querySelectorAll('.ngl2-chip');
        for (var i = 0; i < btns.length; i++) {
          var b = btns[i];
          var on = view[dim.key] === b.dataset.key;
          b.setAttribute('aria-pressed', String(on));
          var allowed = availableFor(dim.key);
          if (allowed) {
            var ok = allowed.indexOf(b.dataset.key) !== -1;
            b.disabled = !ok;
            // Say WHY it is disabled. A dead chip with no explanation reads as
            // a broken page rather than as an absence of data.
            b.title = ok ? '' : ((spec.strings && spec.strings.unavailable)
                                 || 'No data for this combination');
          }
        }
      });
    }

    /* ---------- render ---------- */
    function refresh() {
      var target = isLine ? layoutLine(spec, view, theme)
                          : computeLayout(spec, view, theme);
      svg.setAttribute('viewBox', '0 0 ' + target.W + ' ' + target.H);

      // A line chart's axis need not start at zero, so there is no baseline to
      // draw; a bar chart's baseline is load-bearing and always drawn.
      if (isLine) {
        baselineEl.setAttribute('opacity', 0);
      } else {
        baselineEl.setAttribute('opacity', 1);
        baselineEl.setAttribute('x1', target.m.l);
        baselineEl.setAttribute('x2', target.m.l + target.iw);
        baselineEl.setAttribute('y1', target.baseline);
        baselineEl.setAttribute('y2', target.baseline);
      }

      syncChips();
      renderCopy(target);
      renderLegend(target);
      if (isLine) renderLine(target); else animate(target);
      layout = target;
    }

    function renderCopy(target) {
      var copy = spec.copy[view[PRIMARY]] || {};
      var title = titleFor(copy);
      if (figure) {
        var t = figure.querySelector('.ngc2-chart__title');
        if (t) t.textContent = title;
        var sub = figure.querySelector('.ngc2-chart__subtitle');
        if (sub) sub.textContent = subtitleFor(target);
        var src = figure.querySelector('.ngc2-chart__source');
        if (src && copy.source) src.textContent = 'Source: ' + copy.source;
      }
      noteEl.textContent = notesFor(target);
      svg.setAttribute('aria-label', (title || 'Chart') + '. ' + subtitleFor(target));
      live.textContent = title + '. ' + subtitleFor(target);
    }

    /* The emphasised series belongs in the title, not only in the legend: with
       25 operators to choose from, "which one am I looking at" is the first
       thing a reader needs and the last thing they should have to hunt for. */
    function titleFor(copy) {
      var base = copy.title || '';
      var focus = focusName(spec, view);
      if (!focus || !spec.strings || !spec.strings.title) return base;
      return spec.strings.title
        .replace('{title}', base)
        .replace('{focus}', focus);
    }

    /* Every word of this comes from the spec. The engine used to carry
       crime-specific English here AND in interactive.py, and keeping two copies
       of a sentence in step by hand is a bug waiting for a quiet afternoon. */
    function subtitleFor(target) {
      var strings = spec.strings || {};
      if (!strings.subtitle) return '';
      var ds = target.dataset;
      // Short labels, not the tooltip's long ones: the subtitle names a range,
      // and two full "Period 3, 2026/27 - 31 May to 27 June 2026" strings in
      // one sentence is a paragraph.
      var cats = ds.categoriesShort || ds.categoriesLong || ds.categories;
      if (!cats.length) return '';
      var from = target.from || 0;

      var values = {
        span: cats[from] + ' to ' + cats[cats.length - 1],
        first: String(cats[from]),
        last: String(cats[cats.length - 1]),
        focus: focusName(spec, view) || ''
      };
      Object.keys(strings).forEach(function (name) {
        var table = strings[name];
        if (name === 'subtitle' || !table || typeof table !== 'object') return;
        values[name] = table[view[name]] || '';
      });

      var out = strings.subtitle;
      Object.keys(values).forEach(function (name) {
        out = out.split('{' + name + '}').join(values[name]);
      });
      return out;
    }

    /* Caveats attach to the thing that triggers them.
       `notes` is a map; a note fires when its key matches a current dim value,
       or when it is one of the structural triggers below. Nothing is hardcoded
       to a particular dataset's vocabulary. */
    function notesFor(target) {
      var notes = spec.notes || {};
      var out = [];
      Object.keys(view).forEach(function (dim) {
        var note = notes[view[dim]];
        if (note && out.indexOf(note) === -1) out.push(note);
      });
      if (target.provisionalFrom != null && notes.provisional) {
        out.push(notes.provisional);
      }
      if (isLine && !target.zeroBased && notes.axis) out.push(notes.axis);
      if (isLine && target.band && notes.band) out.push(notes.band);
      if (notes.recency) out.push(notes.recency);
      return out.join(' ');
    }

    function renderLegend(target) {
      legend.textContent = '';
      var items = [];

      if (isLine) {
        // One series needs no legend box - the title names it. Two or more
        // always get one, so identity is never carried by colour alone.
        if (target.focus) items.push({ label: target.focus, color: theme.lineFocus });
        if (target.reference) {
          items.push({ label: target.reference, color: theme.lineReference });
        }
        if (target.band) {
          items.push({ label: (spec.strings && spec.strings.bandLabel)
                              || 'Range across peers', color: theme.bandFill });
        }
        if (items.length < 2) { legend.hidden = true; return; }
      } else {
        if (!target.grouped) { legend.hidden = true; return; }
        target.seriesNames.forEach(function (name, i) {
          items.push({ label: name, color: target.seriesColors[i] });
        });
      }

      legend.hidden = false;
      items.forEach(function (it) {
        var item = document.createElement('span');
        item.className = 'ngc2-legend__item';
        item.style.color = theme.sub;
        var sw = document.createElement('span');
        sw.className = 'ngc2-legend__swatch';
        sw.style.background = it.color;
        item.appendChild(sw);
        item.appendChild(document.createTextNode(it.label));
        legend.appendChild(item);
      });
    }

    /* ================================================================
       LINE RENDER

       The bar engine keeps a keyed rect per bar and diffs it. A line is
       one node carrying every point, so the same trick does not apply:
       what gets interpolated is the point array, and the path is
       rebuilt from it each frame.

       The axis is rebuilt outright rather than diffed. It is five ticks
       and a dozen year labels - cheap - and rebuilding removes the whole
       class of orphaned-node bugs the bar path has to guard against.
       ================================================================ */
    var lineNodes = {};     // series name -> { path, dashed, dot, label, points }
    var lineRaf = null;

    function renderLine(target) {
      if (lineRaf) { cancelAnimationFrame(lineRaf); lineRaf = null; }

      /* --- axis --- */
      gGrid.textContent = '';
      gTicks.textContent = '';
      gCats.textContent = '';
      var m = target.m;

      target.ticks.forEach(function (t) {
        if (theme.grid) {
          gGrid.appendChild(svgEl('line', {
            x1: m.l, x2: m.l + target.iw, y1: t.y, y2: t.y,
            stroke: theme.gridColor, 'stroke-width': C.GEOM.line.gridW
          }));
        }
        var lab = svgEl('text', {
          'class': 'ngc2-axis', x: m.l + C.GEOM.line.tickDx,
          y: t.y + C.GEOM.line.tickDy, fill: theme.sub, 'text-anchor': 'end'
        });
        lab.textContent = t.label;
        gTicks.appendChild(lab);
      });

      target.cats.forEach(function (c) {
        var lab = svgEl('text', {
          'class': 'ngc2-cat', x: c.x, y: c.y,
          fill: theme.sub, 'text-anchor': 'middle'
        });
        lab.textContent = c.label;
        gCats.appendChild(lab);
      });

      /* --- peer band --- */
      gBand.textContent = '';
      if (target.band) {
        gBand.appendChild(svgEl('path', {
          d: target.band.d, fill: target.band.fill, stroke: 'none'
        }));
      }

      /* --- lines --- */
      var wanted = {};
      target.lines.forEach(function (L) { wanted[L.key] = L; });

      Object.keys(lineNodes).forEach(function (key) {
        if (!wanted[key]) {
          var n = lineNodes[key];
          [n.path, n.dashed, n.dot, n.label].forEach(function (el) {
            if (el && el.parentNode) el.parentNode.removeChild(el);
          });
          delete lineNodes[key];
        }
      });

      var tweens = [];
      target.lines.forEach(function (L) {
        var node = lineNodes[L.key];
        if (!node) {
          node = lineNodes[L.key] = {
            path: gLines.appendChild(svgEl('path', {
              fill: 'none', 'stroke-linejoin': 'round', 'stroke-linecap': 'round'
            })),
            dashed: gLines.appendChild(svgEl('path', {
              fill: 'none', 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
              'stroke-dasharray': '4 3'
            })),
            dot: gLines.appendChild(svgEl('circle', { r: C.GEOM.line.dotR })),
            label: gLines.appendChild(svgEl('text', {
              'class': 'ngc2-end', 'font-weight': 600
            })),
            points: L.points
          };
        }
        node.path.setAttribute('stroke', L.color);
        node.path.setAttribute('stroke-width', L.width);
        node.dashed.setAttribute('stroke', L.color);
        node.dashed.setAttribute('stroke-width', L.width);
        node.dot.setAttribute('fill', L.color);
        node.label.setAttribute('fill', L.color);
        node.label.textContent = L.name;

        // Interpolate point-for-point when the count is stable (a value change
        // or an axis rescale); jump when it is not (the window changed, so
        // there is no correspondence between old and new points to tween).
        var from = node.points;
        if (duration > 0 && from && from.length === L.points.length) {
          tweens.push({ node: node, from: from, to: L, line: L });
        } else {
          applyLine(node, L, L.points);
        }
        node.points = L.points;
      });

      if (!tweens.length) { buildHover(target); return; }

      var start = null;
      lineRaf = requestAnimationFrame(function step(ts) {
        if (start == null) start = ts;
        var t = Math.min(1, (ts - start) / duration);
        var e = easeCubicInOut(t);
        tweens.forEach(function (tw) {
          var pts = tw.to.points.map(function (p, i) {
            var q = tw.from[i];
            return { i: p.i, x: lerp(q.x, p.x, e), y: lerp(q.y, p.y, e), v: p.v };
          });
          applyLine(tw.node, tw.line, pts);
        });
        if (t < 1) { lineRaf = requestAnimationFrame(step); }
        else { lineRaf = null; buildHover(target); }
      });
    }

    function applyLine(node, L, points) {
      var provFrom = L.provFrom;
      var solid = points, dashed = [];
      if (provFrom != null) {
        solid = points.filter(function (p) { return p.i <= provFrom; });
        dashed = points.filter(function (p) { return p.i >= provFrom; });
      }
      node.path.setAttribute('d', pathOf(solid));
      node.dashed.setAttribute('d', dashed.length > 1 ? pathOf(dashed) : '');

      var last = points.length ? points[points.length - 1] : null;
      if (!last) {
        node.dot.setAttribute('opacity', 0);
        node.label.setAttribute('opacity', 0);
        return;
      }
      node.dot.setAttribute('opacity', 1);
      node.dot.setAttribute('cx', last.x);
      node.dot.setAttribute('cy', last.y);
      // A hollow end dot on a provisional final point, matching the dashed
      // segment: the figure is there, it is just not final yet.
      var provisional = provFrom != null && last.i >= provFrom;
      node.dot.setAttribute('fill', provisional ? (theme.dark ? C.DEEP : '#ffffff')
                                                : L.color);
      node.dot.setAttribute('stroke', provisional ? L.color : 'none');
      node.dot.setAttribute('stroke-width', provisional ? 2 : 0);

      node.label.setAttribute('opacity', 1);
      node.label.setAttribute('x', last.x + C.GEOM.line.endDx);
      node.label.setAttribute('y', last.y + C.GEOM.line.endDy);
    }

    /* ---------- crosshair ----------
       A line chart with 160 points has no mark big enough to hover, so the
       whole plot is one hit target and the nearest period is picked by x.
       Keyboard reaches it too: the rect is focusable and arrow keys step
       period by period, because a tooltip only a mouse can open is a tooltip
       half the readers never see. */
    var hoverIndex = null;

    function buildHover(target) {
      gHover.textContent = '';
      if (!target.lines.length) return;
      var m = target.m;

      var rule = svgEl('line', {
        stroke: theme.axisColor, 'stroke-width': 1, opacity: 0,
        y1: m.t, y2: m.t + target.ih
      });
      gHover.appendChild(rule);

      var marks = target.lines.map(function () {
        var c = svgEl('circle', {
          r: 4.5, opacity: 0, stroke: theme.dark ? C.DEEP : '#ffffff',
          'stroke-width': 2
        });
        gHover.appendChild(c);
        return c;
      });

      var hit = svgEl('rect', {
        x: m.l, y: m.t, width: target.iw, height: target.ih,
        fill: 'transparent', tabindex: 0, 'class': 'ngl2-hit'
      });
      gHover.appendChild(hit);

      function nearest(clientX) {
        var box = svg.getBoundingClientRect();
        var scale = target.W / box.width;
        var px = (clientX - box.left) * scale;
        var step = target.n > 1 ? target.iw / (target.n - 1) : target.iw;
        var i = Math.round((px - m.l) / step);
        return Math.max(0, Math.min(target.n - 1, i));
      }

      function show(local) {
        hoverIndex = local;
        var absolute = target.from + local;
        var step = target.n > 1 ? target.iw / (target.n - 1) : 0;
        var px = m.l + step * local;
        rule.setAttribute('x1', px);
        rule.setAttribute('x2', px);
        rule.setAttribute('opacity', 1);

        var rows = [];
        target.lines.forEach(function (L, i) {
          var p = null;
          for (var k = 0; k < L.points.length; k++) {
            if (L.points[k].i === absolute) { p = L.points[k]; break; }
          }
          if (!p) { marks[i].setAttribute('opacity', 0); return; }
          marks[i].setAttribute('opacity', 1);
          marks[i].setAttribute('cx', p.x);
          marks[i].setAttribute('cy', p.y);
          marks[i].setAttribute('fill', L.color);
          rows.push({ name: L.name, value: p.v, color: L.color });
        });
        showLineTip(target, absolute, rows, px);
      }

      function hide() {
        hoverIndex = null;
        rule.setAttribute('opacity', 0);
        marks.forEach(function (c) { c.setAttribute('opacity', 0); });
        hideTip();
      }

      hit.addEventListener('mousemove', function (e) { show(nearest(e.clientX)); });
      hit.addEventListener('mouseleave', hide);
      hit.addEventListener('focus', function () { show(hoverIndex == null ? target.n - 1 : hoverIndex); });
      hit.addEventListener('blur', hide);
      hit.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { hide(); return; }
        var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        var next = (hoverIndex == null ? target.n - 1 : hoverIndex) + d;
        show(Math.max(0, Math.min(target.n - 1, next)));
      });
    }

    function showLineTip(target, absolute, rows, px) {
      var ds = target.dataset;
      var label = (ds.categoriesLong || ds.categories)[absolute];
      var html = '<span class="ngl2-tooltip__key">' + C.esc(label) + '</span>';
      rows.forEach(function (r) {
        html += '<div class="ngl2-tooltip__val">'
             + '<span class="ngc2-legend__swatch" style="background:' + r.color + '"></span>'
             + C.esc(r.name) + ' '
             + formatValue(r.value, view.encoding, target.step, spec.valueDecimals)
             + (spec.unit || '') + '</div>';
      });
      if (target.provisionalFrom != null && absolute >= target.provisionalFrom
          && spec.strings && spec.strings.provisionalTip) {
        html += '<div class="ngl2-tooltip__note">'
             + C.esc(spec.strings.provisionalTip) + '</div>';
      }
      tooltip.innerHTML = html;
      tooltip.setAttribute('data-show', '1');
      positionTip(px, target);
    }

    function positionTip(px, target) {
      var box = svg.getBoundingClientRect();
      var scale = box.width / target.W;
      var host = (figure || svg.parentNode).getBoundingClientRect();
      var left = box.left - host.left + px * scale;
      tooltip.style.left = Math.round(left) + 'px';
      tooltip.style.top = Math.round(box.top - host.top + target.m.t * scale) + 'px';
    }

    /* ---------- the swoosh ----------
       Interpolate in PIXEL space, not data space. The y-scale changes between
       views (robbery to violence is an order of magnitude), so tweening final
       geometry is what makes an axis rescale read as a morph rather than a jump.

       Entering bars appear at their FINAL x and width with zero height on the
       baseline and grow; exiting bars shrink to the baseline and are removed.
       That is what lets the bar count change without the chart flickering.     */
    function animate(target) {
      // An in-flight transition must be FINISHED, not merely cancelled. Its
      // cleanup is what removes exiting nodes; dropping it on the floor leaves
      // them in the DOM and in the key maps, and they accumulate every time a
      // reader clicks a second chip before the first settles.
      if (pendingFinish) pendingFinish();
      if (raf) { cancelAnimationFrame(raf); raf = null; }

      var frames = [];
      var byKey = {};
      (layout ? layout.bars : []).forEach(function (b) { byKey[b.key] = b; });
      var targetKeys = {};

      target.bars.forEach(function (b) {
        targetKeys[b.key] = 1;
        var prev = byKey[b.key];
        var node = nodes.bars[b.key] || createBar(b);
        var from = prev
          ? { x: prev.x, w: prev.w, y: prev.y, h: prev.h, fill: prev.fill, value: prev.value }
          : { x: b.x, w: b.w, y: target.baseline, h: 0, fill: b.fill, value: 0 };
        frames.push({ node: node, from: from, to: b, exiting: false });
      });

      (layout ? layout.bars : []).forEach(function (b) {
        if (targetKeys[b.key]) return;
        var node = nodes.bars[b.key];
        if (!node) return;
        frames.push({
          node: node, from: b, exiting: true,
          to: { x: b.x, w: b.w, y: target.baseline, h: 0, fill: b.fill, value: 0, key: b.key }
        });
      });

      var tickFrames = diffAxis(target.ticks, layout ? layout.ticks : [], nodes.ticks,
                                createTick, ['y']);
      var gridFrames = diffAxis(target.ticks, layout ? layout.ticks : [], nodes.grid,
                                createGrid, ['y']);
      // Category labels move in BOTH axes. vbar puts them at y=398 and gbar at
      // y=406, so a label created in one mode and reused in the other kept its
      // old baseline while newly created ones took the new one - half a line
      // out, and only visible when a transition changed the chart type AND the
      // category set at once, which is why it would not reproduce on demand.
      var catFrames = diffAxis(target.cats, layout ? layout.cats : [], nodes.cats,
                               createCat, ['x', 'y']);

      var done = false;
      function finish() {
        if (done) return;                            // idempotent: may be called
        done = true;                                 // by the next transition
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        pendingFinish = null;

        frames.forEach(function (f) { applyBar(f, 1, target); });
        tickFrames.forEach(function (f) { applyAxis(f, 1); });
        gridFrames.forEach(function (f) { applyAxis(f, 1); });
        catFrames.forEach(function (f) { applyAxis(f, 1); });

        frames.forEach(function (f) {
          if (f.exiting && f.node.parentNode) {
            f.node.parentNode.removeChild(f.node);
            if (nodes.bars[f.to.key] === f.node) delete nodes.bars[f.to.key];
          }
        });
        [[tickFrames, nodes.ticks], [gridFrames, nodes.grid], [catFrames, nodes.cats]]
          .forEach(function (pair) {
            pair[0].forEach(function (f) {
              if (f.exiting && f.node.parentNode) {
                f.node.parentNode.removeChild(f.node);
                if (pair[1][f.key] === f.node) delete pair[1][f.key];
              }
            });
          });
      }
      pendingFinish = finish;

      var start = null;
      function step(ts) {
        if (done) return;
        if (start === null) start = ts;
        var t = duration <= 0 ? 1 : Math.min((ts - start) / duration, 1);
        var e = easeCubicInOut(t);

        frames.forEach(function (f) { applyBar(f, e, target); });
        tickFrames.forEach(function (f) { applyAxis(f, e); });
        gridFrames.forEach(function (f) { applyAxis(f, e); });
        catFrames.forEach(function (f) { applyAxis(f, e); });

        if (t < 1) { raf = requestAnimationFrame(step); return; }
        raf = null;
        finish();
      }
      raf = requestAnimationFrame(step);
    }

    /* Axis pieces are keyed by VALUE, not position. An entering tick fades in
       already at its final y — sliding it in from nowhere would read as data
       moving when only the scale changed. */
    function diffAxis(targetItems, prevItems, store, create, attrs) {
      var prevByKey = {};
      prevItems.forEach(function (p) { prevByKey[p.key] = p; });
      var seen = {}, out = [];

      function pick(source) {
        var o = {};
        attrs.forEach(function (a) { o[a] = source[a]; });
        return o;
      }

      targetItems.forEach(function (item) {
        seen[item.key] = 1;
        var prev = prevByKey[item.key];
        var node = store[item.key] || create(item);
        // A surviving node keeps its key but may need new text: the same period
        // reads "2023/24" on a roomy axis and "23/24" on a crowded one.
        if (item.label != null && node.textContent !== item.label) {
          node.textContent = item.label;
        }
        out.push({
          node: node, key: item.key, exiting: false, item: item, attrs: attrs,
          from: pick(prev || item), to: pick(item),
          fromOpacity: prev ? 1 : 0, toOpacity: 1
        });
      });

      prevItems.forEach(function (p) {
        if (seen[p.key]) return;
        var node = store[p.key];
        if (!node) return;
        out.push({
          node: node, key: p.key, exiting: true, item: p, attrs: attrs,
          from: pick(p), to: pick(p), fromOpacity: 1, toOpacity: 0
        });
      });
      return out;
    }

    function applyAxis(f, e) {
      var n = f.node;
      var pos = {};
      f.attrs.forEach(function (a) { pos[a] = lerp(f.from[a], f.to[a], e); });

      if (n.tagName === 'line') {
        if (pos.y != null) { n.setAttribute('y1', pos.y); n.setAttribute('y2', pos.y); }
      } else {
        f.attrs.forEach(function (a) { n.setAttribute(a, pos[a]); });
        // The rotation pivot is the label's own anchor, which moves with it.
        if (f.item.rotate) {
          n.setAttribute('transform',
            'rotate(' + f.item.rotate + ' ' + pos.x + ' ' + pos.y + ')');
          n.setAttribute('text-anchor', 'end');
        } else if (n.hasAttribute('transform')) {
          n.removeAttribute('transform');
          n.setAttribute('text-anchor', 'middle');
        }
      }
      n.setAttribute('opacity', lerp(f.fromOpacity, f.toOpacity, e));
    }

    function applyBar(f, e, target) {
      var to = f.to, from = f.from;
      var x = lerp(from.x, to.x, e), w = lerp(from.w, to.w, e);
      var y = lerp(from.y, to.y, e), h = lerp(from.h, to.h, e);
      var rect = f.node.firstChild;
      rect.setAttribute('x', x);
      rect.setAttribute('width', Math.max(0, w));
      rect.setAttribute('y', y);
      rect.setAttribute('height', Math.max(0, h));
      rect.setAttribute('fill', lerpColor(from.fill, to.fill, e));

      var label = f.node.querySelector('.ngl2-vallabel');
      if (!label) return;
      if (f.exiting || !target.showValueLabels || to.value == null) {
        label.setAttribute('opacity', f.exiting ? 1 - e : 0);
        return;
      }
      // Tween the number itself, reformatting each frame — a bar that grows
      // while its label sits at the old figure looks broken.
      var v = lerp(from.value == null ? 0 : from.value, to.value, e);
      label.textContent = formatValue(v, view.encoding, target.step);
      label.setAttribute('x', x + w / 2);
      // Placement follows the animated geometry, so a bar that grows past the
      // point where its label fits above the cap moves it inside as it goes.
      var place = C.valueLabelPlacement(y, h, C.GEOM.vbar);
      label.setAttribute('y', place.y);
      label.setAttribute('fill', place.inside
        ? C.readableOn(lerpColor(from.fill, to.fill, e))
        : theme.text);
      label.setAttribute('opacity', e);
    }

    /* ---------- node factories ---------- */
    function createBar(b) {
      // data-key mirrors the internal key ("<period>|<seriesIndex>"). The DOM
      // order of a keyed structure is creation order, not visual order, so
      // tests and debugging need the key rather than an index.
      var g = svgEl('g', {
        'class': 'ngl2-bar', tabindex: '0', role: 'img', 'data-key': b.key
      });
      g.appendChild(svgEl('rect', { rx: C.GEOM.vbar.rx, fill: b.fill }));
      var label = svgEl('text', {
        'class': 'ngc2-t ngc2-val ngl2-vallabel', 'text-anchor': 'middle',
        fill: theme.text, 'font-weight': 600, opacity: 0
      });
      g.appendChild(label);
      g.addEventListener('mouseenter', function () { showTip(b.key, g); });
      g.addEventListener('focus', function () { showTip(b.key, g); });
      g.addEventListener('mouseleave', hideTip);
      g.addEventListener('blur', hideTip);
      gBars.appendChild(g);
      nodes.bars[b.key] = g;
      return g;
    }

    function createTick(t) {
      var n = svgEl('text', {
        'class': 'ngc2-t ngc2-axis', 'text-anchor': 'end', fill: theme.sub,
        x: layoutM().l + C.GEOM.vbar.tickDx, y: t.y + C.GEOM.vbar.tickDy, opacity: 0
      });
      n.textContent = t.label;
      gTicks.appendChild(n);
      nodes.ticks[t.key] = n;
      return n;
    }

    function createGrid(t) {
      if (!theme.grid) {
        var blank = svgEl('line', { opacity: 0 });
        gGrid.appendChild(blank);
        nodes.grid[t.key] = blank;
        return blank;
      }
      var m = layoutM();
      var n = svgEl('line', {
        x1: m.l, x2: m.l + (C.GEOM.vbar.W - m.l - m.r),
        y1: t.y, y2: t.y, stroke: theme.gridColor,
        'stroke-width': C.GEOM.vbar.gridW, opacity: 0
      });
      gGrid.appendChild(n);
      nodes.grid[t.key] = n;
      return n;
    }

    function createCat(c) {
      var n = svgEl('text', {
        'class': 'ngc2-t ngc2-cat', 'text-anchor': 'middle', fill: theme.sub,
        x: c.x, y: c.y, opacity: 0
      });
      n.textContent = c.label;
      gCats.appendChild(n);
      nodes.cats[c.key] = n;
      return n;
    }

    function layoutM() { return (layout || computeLayout(spec, view, theme)).m; }

    /* ---------- tooltip ---------- */
    function showTip(key, node) {
      var bar = null;
      layout.bars.forEach(function (b) { if (b.key === key) bar = b; });
      if (!bar) return;
      var ds = layout.dataset;
      var cov = coverageAt(ds, bar.seriesIndex, bar.catIndex);
      var name = layout.seriesNames[bar.seriesIndex] || '';
      // The axis tick is abbreviated to fit; the tooltip has room for the full
      // period, which is where "Jun 26" gets spelled out.
      var when = (ds.categoriesLong || ds.categories)[bar.catIndex];

      var html = '<span class="ngl2-tooltip__key">' + C.esc(when) + '</span><br>';
      if (layout.grouped) html += C.esc(name) + ': ';
      html += '<span class="ngl2-tooltip__val">'
            + (bar.value == null ? 'no data' : formatValue(bar.value, view.encoding))
            + (view.encoding === 'rate' ? ' per 1,000' : '')
            + '</span>';
      if (view.encoding !== 'count') {
        var rawv = ds.series[bar.seriesIndex].values[bar.catIndex];
        html += '<br><span class="ngl2-tooltip__val">' + C.fmtNum(rawv) + '</span> recorded';
      }
      if (cov && cov.material && cov.missing && cov.missing.length) {
        html += '<div class="ngl2-tooltip__note">Undercounts: '
             + C.esc(cov.missing.join(', ')) + ' did not file.</div>';
      }
      if (view.encoding === 'rate' && ds.provisionalFrom != null
          && bar.catIndex >= ds.provisionalFrom) {
        html += '<div class="ngl2-tooltip__note">Population carried forward '
             + 'from the last published estimate.</div>';
      }
      tooltip.innerHTML = html;
      tooltip.setAttribute('data-show', '1');

      var hostBox = (figure || host).getBoundingClientRect();
      var box = node.getBoundingClientRect();
      tooltip.style.left = Math.max(0, box.left - hostBox.left + box.width / 2
                                    - tooltip.offsetWidth / 2) + 'px';
      tooltip.style.top = (box.top - hostBox.top - tooltip.offsetHeight - 8) + 'px';
    }
    function hideTip() { tooltip.setAttribute('data-show', '0'); }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') hideTip();
    });

    /* ---------- go ---------- */
    refresh();

    var instance = {
      set: set,
      setMany: setMany,
      view: function () { return JSON.parse(JSON.stringify(view)); },
      setTransition: function (ms) { duration = ms; },
      refresh: refresh
    };

    // Capture-driver hooks, matching the 3D pages. __ngc2SetTransition(1) rather
    // than 0 — a literal zero divides by zero in the frame maths.
    // One view change = one transition, so a driven multi-dimension change
    // animates once rather than four times.
    global.__ngc2SetView = setMany;
    global.__ngc2SetTransition = instance.setTransition;
    global.__ngc2Live = instance;
    return instance;
  }

  global.NGC2Live = { mount: mount, easeCubicInOut: easeCubicInOut };
})(window);
