/* ================================================================
   NeilGarratt.com — Live chart engine
   Animated, interactive bars in the house style. The 2D companion to
   the deck.gl viz: chip buttons, and a cubic swoosh between views.

   charts.js renders by building an SVG string and assigning innerHTML,
   which destroys every element on every render — nothing can tween.
   This engine keeps a stable, keyed DOM instead and interpolates it.
   Both read palettes, scales, formatters and geometry from
   chart-core.js, so a live chart and a published PNG of the same data
   are the same picture.

   REQUIRES chart-core.js. Chart types: vbar (one series), gbar (two).

   Public API:
     NGLive.mount(hostId, spec)   -> instance
     instance.set(dim, key)
     instance.view()              -> current selection
     window.__setView / __setTransition  (capture-driver hooks)
   ================================================================ */
(function (global) {
  'use strict';

  var C = global.NGCore;
  if (!C) throw new Error('charts-live.js requires chart-core.js to be loaded first');

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
     ENCODINGS
     Counts ship; index and rate are pure functions of them, derived
     here so adding an encoding never means rebuilding the data.
     ================================================================ */
  function deriveValues(dataset, seriesIndex, encoding) {
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
    return raw.slice();
  }

  /* A rate series can be any order of magnitude: London's robbery rate is ~3.9
     per 1,000, its homicide rate ~0.012. Fixing one decimal renders the second
     as "0.0" on every bar and an axis of five zeroes, so the precision comes
     from the axis step - exactly enough to tell adjacent ticks apart. */
  /* `fmt` is chosen once per chart by valueLabelFit: { decimals, coarse }. */
  function formatValue(v, encoding, fmt) {
    if (v == null) return '';
    if (encoding === 'index') return Math.round(v).toString();
    if (encoding === 'rate') return v.toFixed(fmt.decimals);
    return C.fmtCompact(Math.round(v), '', fmt.coarse ? 0 : null);
  }

  /* Ticks keep taking their precision from the axis step, and should: they sit
     on round numbers by construction, so 0, 1, 2, 3 is exactly right and "4.00"
     would be noise. Bar labels are a different problem — see rateFormat. */
  function formatTick(v, encoding, step) {
    if (encoding === 'rate') return v.toFixed(C.decimalsFor(step));
    return C.fmtCompact(v, '');
  }

  /* How many decimals a RATE series needs on its bars.
     Not decimalsFor(step), which is what the bars used to use and which reads
     the axis rather than the data. London's robbery rate runs 3.2 to 4.5 per
     1,000; that axis has a step of 1, so every bar rendered as a flat "4". The
     axis was right and the bars were useless.

     Three significant figures at the magnitude of the largest bar. The largest
     rather than each bar's own, because one precision has to serve the whole
     chart, and because keying off the smallest would let a near-zero value push
     the big ones to "400.00000". */
  function rateDecimals(values) {
    var max = 0;
    values.forEach(function (v) { if (v != null) max = Math.max(max, Math.abs(v)); });
    return C.decimalsForSig(max, 3);
  }

  /* The exact figure, for the tooltip only.
     The bar-top label is abbreviated so a long series still fits — that is the
     ladder's whole job — which only works if the precise number is one hover
     away. So the two do different jobs: the label carries the shape, this
     carries the figure.

     It also takes no axis step, which is what fixes a real defect: showTip used
     to call formatValue WITHOUT one, so decimalsFor(undefined) returned 0 and
     every rate rendered with no decimals at all. London's homicide rate read as
     "0". Significant figures are the right unit here anyway — a tooltip shows
     one number and has no neighbouring ticks to stay consistent with. */
  function formatExact(v, encoding) {
    if (v == null) return 'no data';
    if (encoding === 'index') return v.toFixed(1);
    if (encoding === 'rate') return v.toFixed(C.decimalsForSig(v, 3));
    return C.fmtNum(Math.round(v));
  }

  /* ---------- the value-label ladder ----------
     Build the rungs this encoding can offer and let chart-core pick the first
     that fits. Full precision, then coarse, then coarse a size down, then none.

     The coarse rung is withheld — a null the ladder skips — when it would render
     a value that is genuinely there as a flat zero. That is the homicide rate at
     0.012: coarsened it reads 0.00, which is not a rounder version of the truth
     but a different and wrong claim. */
  function valueLabelRungs(values, encoding, size) {
    var dec = encoding === 'rate' ? rateDecimals(values) : 0;
    var fmts = [
      { decimals: dec, coarse: false },
      { decimals: Math.max(0, dec - 1), coarse: true }
    ];
    function labels(fmt) {
      return values.map(function (v) { return formatValue(v, encoding, fmt); });
    }
    var full = labels(fmts[0]);
    var coarse = labels(fmts[1]);

    var collapses = values.some(function (v, i) {
      return v != null && v !== 0 && parseFloat(coarse[i]) === 0;
    });
    if (collapses) coarse = null;

    return [
      { labels: full, fontSize: size, fmt: fmts[0] },
      coarse && { labels: coarse, fontSize: size, fmt: fmts[1] },
      coarse && { labels: coarse, fontSize: size - 2, fmt: fmts[1] }
    ];
  }

  // Matches .ngc-val in ng-chart.css, including the bold tone's larger size.
  // The small rung steps down rather than shrinking away: two points still sits
  // comfortably against the category labels, where less starts to read as a
  // footnote rather than a value.
  function valFontSize(theme) { return theme.dark ? 16 : 14; }

  /* ================================================================
     LAYOUT
     Pure: view -> pixel geometry. Everything the animator needs, keyed.
     ================================================================ */
  function computeLayout(spec, view, theme) {
    var dataset = spec.datasets[view.crime + '|' + view.period];
    var grouped = view.compare === 'rew' && dataset.series.length > 1;
    var G = grouped ? C.GEOM.gbar : C.GEOM.vbar;
    var W = G.W, H = G.H, m = G.m;
    var iw = W - m.l - m.r, ih = H - m.t - m.b;

    var nS = grouped ? dataset.series.length : 1;
    var values = [];
    for (var s = 0; s < nS; s++) values.push(deriveValues(dataset, s, view.encoding));

    var all = [];
    values.forEach(function (col) {
      col.forEach(function (v) { if (v != null) all.push(v); });
    });
    var maxV = all.length ? Math.max.apply(null, all) : 1;
    var sc = C.niceScale(0, maxV, G.ticks);
    var y = C.lin(sc.min, sc.max, m.t + ih, m.t);
    var baseline = y(0);

    var cats = dataset.categories;
    var n = cats.length;
    var bars = [], catLabels = [];

    // How much horizontal room each tick actually has, and therefore which
    // label form fits. Computed identically in charts.js, so the baked SVG and
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
                 label: formatTick(t, view.encoding, sc.step) };
      }),
      bars: bars, cats: catLabels, dataset: dataset, values: values,
      encoding: view.encoding,
      valueLabels: valueLabelFit(grouped, values[0], view.encoding, slot, theme),
      seriesNames: dataset.series.slice(0, nS).map(function (s) { return s.name; }),
      seriesColors: dataset.series.slice(0, nS).map(function (_, i) {
        return theme.series[i % theme.series.length];
      })
    };
  }

  /* Grouped bars stay label-free, and that is a decision rather than a fitting
     outcome. Two series to a slot halves the room, but the real reason is that a
     comparison chart is read as two shapes against each other — twenty-six
     numbers competing across it is the clutter, not the information. The legend
     and the tooltip carry the detail. */
  function valueLabelFit(grouped, values, encoding, slot, theme) {
    if (grouped) return { show: false };
    var rungs = valueLabelRungs(values, encoding, valFontSize(theme));
    var fit = C.fitValueLabels(rungs, slot);
    fit.fmt = fit.rung >= 0 ? rungs[fit.rung].fmt : { decimals: 0, coarse: false };
    return fit;
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
     THE INSTANCE
     ================================================================ */
  function mount(hostId, spec) {
    var host = typeof hostId === 'string' ? document.getElementById(hostId) : hostId;
    if (!host) throw new Error('NGLive.mount: no element ' + hostId);

    var figure = host.closest ? host.closest('.ng-chart') : null;
    var theme = C.resolveTheme(spec.tone || 'editorial', spec.palette || 'mono');
    var duration = DEFAULT_DURATION;

    var view = {
      crime: spec.initial.crime, period: spec.initial.period,
      compare: spec.initial.compare, encoding: spec.initial.encoding
    };

    // live DOM, keyed
    var nodes = { bars: {}, ticks: {}, cats: {}, grid: {} };
    var layout = null;
    var raf = null;
    var pendingFinish = null;

    /* ---------- scaffold ---------- */
    host.textContent = '';
    var svg = svgEl('svg', {
      'class': 'ngc-svg', width: '100%',
      preserveAspectRatio: 'xMidYMid meet', role: 'img'
    });
    var gGrid = svgEl('g', { 'class': 'ngl-grid' });
    var gBars = svgEl('g', { 'class': 'ngl-bars' });
    var gCats = svgEl('g', { 'class': 'ngl-cats' });
    var gTicks = svgEl('g', { 'class': 'ngl-ticks' });
    var baselineEl = svgEl('line', {
      stroke: theme.axisColor, 'stroke-width': C.GEOM.vbar.baseW
    });
    svg.appendChild(gGrid);
    svg.appendChild(baselineEl);
    svg.appendChild(gBars);
    svg.appendChild(gCats);
    svg.appendChild(gTicks);
    host.appendChild(svg);

    var legend = document.createElement('div');
    legend.className = 'ngc-legend';
    host.appendChild(legend);

    var tooltip = document.createElement('div');
    tooltip.className = 'ngl-tooltip';
    tooltip.setAttribute('role', 'status');
    (figure || host).appendChild(tooltip);

    var live = document.createElement('div');
    live.className = 'ngl-sr';
    live.setAttribute('aria-live', 'polite');
    (figure || host).appendChild(live);

    /* ---------- chips ---------- */
    var controls = buildControls();

    function buildControls() {
      var existing = figure && figure.querySelector('.ngl-controls');
      var box = existing || document.createElement('div');
      box.className = 'ngl-controls';
      box.textContent = '';
      var rows = {};

      spec.dims.forEach(function (dim) {
        var row = document.createElement('div');
        row.className = 'ngl-chiprow' + (dim.primary ? '' : ' ngl-chiprow--sub');
        row.setAttribute('role', 'group');
        var labelId = spec.id + '-dim-' + dim.key;
        var lab = document.createElement('span');
        lab.className = 'ngl-chiprow__label';
        lab.id = labelId;
        lab.textContent = dim.label;
        row.setAttribute('aria-labelledby', labelId);
        row.appendChild(lab);

        dim.options.forEach(function (opt) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'ngl-chip';
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
          var btns = [].slice.call(row.querySelectorAll('.ngl-chip:not(:disabled)'));
          var i = btns.indexOf(document.activeElement);
          if (i === -1) return;
          e.preventDefault();
          btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length].focus();
        });

        rows[dim.key] = row;
        box.appendChild(row);
      });

      // LAST in the figure, below the source line — not between the plot and
      // the foot, where they used to go. A reader screenshotting the chart crops
      // to the title and the bars, which left the source and the NeilGarratt.com
      // tag stranded below the controls and out of the picture. Putting the
      // chrome after the rule means the tidy crop is also the honest one.
      if (!existing && figure) {
        figure.appendChild(box);
      } else if (!existing) {
        host.appendChild(box);
      }
      box.hidden = false;
      return { box: box, rows: rows };
    }

    // The caveats travel with the chart for the same reason: above the rule, so
    // "recent periods are provisional" cannot be cropped away from the bars it
    // is about.
    var noteEl = document.createElement('p');
    noteEl.className = 'ngl-note';
    var foot = figure && figure.querySelector('.ng-chart__foot');
    if (foot) figure.insertBefore(noteEl, foot);
    else (figure || host).insertBefore(noteEl, controls.box);

    /* ---------- download ----------
       Only built when chart-export.js is present, the same bargain the controls
       make: no script, no dead button. */
    var downloadBtn = global.NGExport && figure ? buildDownload() : null;

    function buildDownload() {
      var b = figure.querySelector('.ngl-download') || document.createElement('button');
      b.className = 'ngl-download';
      b.type = 'button';
      // An inline arrow rather than the ⬇ character, which arrives at a
      // different weight on every platform and is an emoji on some.
      b.innerHTML =
        '<svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true" '
        + 'fill="none" stroke="currentColor" stroke-width="1.7" '
        + 'stroke-linecap="round" stroke-linejoin="round">'
        + '<path d="M10 3v9m0 0 3.5-3.5M10 12 6.5 8.5"/>'
        + '<path d="M3.5 14v2.5h13V14"/></svg>'
        + '<span class="ngl-sr">Download this chart as an image</span>';
      b.setAttribute('aria-label', 'Download this chart as an image');
      b.title = 'Download this chart as an image';
      b.addEventListener('click', runDownload);
      if (!b.parentNode) figure.appendChild(b);
      return b;
    }

    function runDownload() {
      if (downloadBtn.disabled) return;
      // Land the transition first. A chart caught mid-swoosh still holds the
      // OUTGOING ticks and bars — they are only removed when the transition
      // finishes — so exporting during one produces a chart with two y-axes
      // fading through each other. The reader asked for the view they chose,
      // which is where the animation is going, not a frame of it.
      if (pendingFinish) pendingFinish();
      downloadBtn.disabled = true;
      downloadBtn.setAttribute('data-busy', '1');
      global.NGExport.download(figure, downloadFilename())
        .catch(function (err) {
          if (global.console) console.error('chart download failed', err);
          live.textContent = 'Sorry — the chart could not be downloaded.';
        })
        .then(function () {
          downloadBtn.disabled = false;
          downloadBtn.removeAttribute('data-busy');
        });
    }

    /* Named from the chips the reader actually chose, so the file says what it
       is once it is sitting in a Downloads folder among fifty others. */
    function downloadFilename() {
      var parts = [spec.id];
      spec.dims.forEach(function (dim) {
        var chosen = null;
        dim.options.forEach(function (o) { if (o.key === view[dim.key]) chosen = o.label; });
        if (chosen) parts.push(chosen);
      });
      return parts.join('-').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '.png';
    }

    /* ---------- state ---------- */
    function availableFor(dim) {
      var avail = spec.availability[view.crime] || {};
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
      // {compare:'rew', crime:'asb'} would check 'rew' against the OUTGOING
      // crime type and silently drop it. Callers should not have to know the
      // order matters, so it doesn't.
      var next = {
        crime: view.crime, period: view.period,
        compare: view.compare, encoding: view.encoding
      };
      Object.keys(changes || {}).forEach(function (dim) {
        if (dim in next) next[dim] = changes[dim];
      });

      // A Met-only crime type has no national twin, so its comparison falls
      // back rather than rendering an empty second series.
      var allowed = (spec.availability[next.crime] || {}).compare;
      if (allowed && allowed.indexOf(next.compare) === -1) next.compare = allowed[0];

      var dirty = false;
      Object.keys(next).forEach(function (dim) {
        if (view[dim] !== next[dim]) { view[dim] = next[dim]; dirty = true; }
      });
      if (!dirty) return;                            // never restart a transition
      refresh();
    }

    function syncChips() {
      spec.dims.forEach(function (dim) {
        var btns = controls.rows[dim.key].querySelectorAll('.ngl-chip');
        for (var i = 0; i < btns.length; i++) {
          var b = btns[i];
          var on = view[dim.key] === b.dataset.key;
          b.setAttribute('aria-pressed', String(on));
          if (dim.key === 'compare') {
            var allowed = availableFor('compare');
            var ok = !allowed || allowed.indexOf(b.dataset.key) !== -1;
            b.disabled = !ok;
            b.title = ok ? '' : 'No national comparison for this crime type';
          }
        }
      });
    }

    /* ---------- render ---------- */
    function refresh() {
      var target = computeLayout(spec, view, theme);
      svg.setAttribute('viewBox', '0 0 ' + target.W + ' ' + target.H);
      baselineEl.setAttribute('x1', target.m.l);
      baselineEl.setAttribute('x2', target.m.l + target.iw);
      baselineEl.setAttribute('y1', target.baseline);
      baselineEl.setAttribute('y2', target.baseline);

      syncChips();
      renderCopy(target);
      renderLegend(target);
      animate(target);
      layout = target;
    }

    function renderCopy(target) {
      var copy = spec.copy[view.crime] || {};
      if (figure) {
        var t = figure.querySelector('.ng-chart__title');
        if (t) t.textContent = copy.title || '';
        var sub = figure.querySelector('.ng-chart__subtitle');
        if (sub) sub.textContent = subtitleFor(target);
        var src = figure.querySelector('.ng-chart__source');
        if (src && copy.source) src.textContent = 'Source: ' + copy.source;
      }
      noteEl.textContent = notesFor(target);
      svg.setAttribute('aria-label', (copy.title || 'Chart') + '. ' + subtitleFor(target));
      live.textContent = (copy.title || '') + '. ' + subtitleFor(target);
    }

    function subtitleFor(target) {
      var ds = target.dataset;
      var n = ds.categories.length;
      if (!n) return '';
      var long = ds.categoriesLong || ds.categories;

      // The abbreviated ticks are for the axis. Spelling the span out of them
      // gives "Jun 18 to Jun 26", which reads as a range inside one month.
      var basis, span;
      if (view.period === 'r12') {
        basis = 'rolling 12-month periods ending';
        span = strip12m(long[0]) + ' to ' + strip12m(long[n - 1]);
      } else {
        basis = view.period === 'fy' ? 'financial years' : 'calendar years';
        span = ds.categories[0] + ' to ' + ds.categories[n - 1];
      }
      var what = view.encoding === 'rate' ? 'Recorded offences per 1,000 residents'
        : view.encoding === 'index' ? 'Recorded offences, indexed to ' + ds.categories[0] + ' = 100'
        : 'Recorded offences';
      return what + ', ' + basis + ' ' + span + '.';
    }

    function strip12m(s) { return String(s).replace(/^12 months to /, ''); }

    function notesFor(target) {
      var out = [];
      if (view.compare === 'rew' && target.grouped && spec.notes.rew) out.push(spec.notes.rew);
      if (view.encoding === 'rate' && target.dataset.provisionalFrom != null
          && spec.notes.rate) out.push(spec.notes.rate);
      var shown = target.grouped ? target.dataset.series
                                 : target.dataset.series.slice(0, 1);
      var flagged = [];
      shown.forEach(function (s) {
        (s.coverage || []).forEach(function (c) { if (c.material) flagged.push(c); });
      });
      if (flagged.length) {
        out.push('Paler bars are periods where at least one force did not file; '
                 + 'hover or focus a bar for detail.');
      }
      if (spec.notes.recency) out.push(spec.notes.recency);
      return out.join(' ');
    }

    function renderLegend(target) {
      legend.textContent = '';
      if (!target.grouped) { legend.hidden = true; return; }
      legend.hidden = false;
      target.seriesNames.forEach(function (name, i) {
        var item = document.createElement('span');
        item.className = 'ngc-legend__item';
        item.style.color = theme.sub;
        var sw = document.createElement('span');
        sw.className = 'ngc-legend__swatch';
        sw.style.background = target.seriesColors[i];
        item.appendChild(sw);
        item.appendChild(document.createTextNode(name));
        legend.appendChild(item);
      });
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

      /* Bar HEIGHTS always tween — in pixel space, which is what makes an axis
         rescale read as a morph. The NUMBER on the cap is a different matter:
         it may only tween while it stays the same kind of number.

         Counts to per-1,000 moves a bar from 30,069 to 3.56. Interpolating that
         walks through 15,018 and prints it as a rate, so for half a second the
         chart states a figure that is not true in either unit. On an encoding
         change the label therefore holds its final value and simply fades in
         over the moving bar. */
      var unitChanged = !layout || layout.encoding !== target.encoding;

      target.bars.forEach(function (b) {
        targetKeys[b.key] = 1;
        var prev = byKey[b.key];
        var node = nodes.bars[b.key] || createBar(b);
        var from = prev
          ? { x: prev.x, w: prev.w, y: prev.y, h: prev.h, fill: prev.fill, value: prev.value }
          : { x: b.x, w: b.w, y: target.baseline, h: 0, fill: b.fill, value: 0 };
        if (unitChanged) from.value = b.value;
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

      var label = f.node.querySelector('.ngl-vallabel');
      if (!label) return;
      var vl = target.valueLabels;
      if (f.exiting || !vl.show || to.value == null) {
        label.setAttribute('opacity', f.exiting ? 1 - e : 0);
        return;
      }
      // Tween the number itself, reformatting each frame — a bar that grows
      // while its label sits at the old figure looks broken. The precision and
      // size are the TARGET's throughout: a transition that changes rung would
      // otherwise reformat mid-flight, and the width the ladder was chosen to
      // respect is the width at the end.
      var v = lerp(from.value == null ? 0 : from.value, to.value, e);
      label.textContent = formatValue(v, view.encoding, vl.fmt);
      // style, not the font-size attribute: .ngc-val in ng-chart.css sets a size
      // and a CSS declaration beats a presentation attribute, so the attribute
      // would be silently ignored and the small rung would render at 14px.
      label.style.fontSize = vl.fontSize + 'px';
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
        'class': 'ngl-bar', tabindex: '0', role: 'img', 'data-key': b.key
      });
      g.appendChild(svgEl('rect', { rx: C.GEOM.vbar.rx, fill: b.fill }));
      var label = svgEl('text', {
        'class': 'ngc-t ngc-val ngl-vallabel', 'text-anchor': 'middle',
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
        'class': 'ngc-t ngc-axis', 'text-anchor': 'end', fill: theme.sub,
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
        'class': 'ngc-t ngc-cat', 'text-anchor': 'middle', fill: theme.sub,
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

      var html = '<span class="ngl-tooltip__key">' + C.esc(when) + '</span><br>';
      if (layout.grouped) html += C.esc(name) + ': ';
      html += '<span class="ngl-tooltip__val">'
            + formatExact(bar.value, view.encoding)
            + (view.encoding === 'rate' && bar.value != null ? ' per 1,000' : '')
            + '</span>';
      if (view.encoding !== 'count') {
        var rawv = ds.series[bar.seriesIndex].values[bar.catIndex];
        // fmtNum calls toLocaleString, which throws on null. A gap in the series
        // should read as a gap, not take the tooltip down with it.
        if (rawv != null) {
          html += '<br><span class="ngl-tooltip__val">' + C.fmtNum(rawv)
                + '</span> recorded';
        }
      }
      if (cov && cov.material && cov.missing && cov.missing.length) {
        html += '<div class="ngl-tooltip__note">Undercounts: '
             + C.esc(cov.missing.join(', ')) + ' did not file.</div>';
      }
      if (view.encoding === 'rate' && ds.provisionalFrom != null
          && bar.catIndex >= ds.provisionalFrom) {
        html += '<div class="ngl-tooltip__note">Population carried forward '
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
      // Jump any in-flight transition to its end state, removing the exiting
      // nodes. Anything that reads the DOM rather than watches it — the export,
      // a capture driver — wants the settled chart, not a frame of the swoosh.
      settle: function () { if (pendingFinish) pendingFinish(); },
      refresh: refresh
    };

    // Capture-driver hooks, matching the 3D pages. __setTransition(1) rather
    // than 0 — a literal zero divides by zero in the frame maths.
    // One view change = one transition, so a driven multi-dimension change
    // animates once rather than four times.
    global.__setView = setMany;
    global.__setTransition = instance.setTransition;
    global.__ngLive = instance;
    return instance;
  }

  global.NGLive = { mount: mount, easeCubicInOut: easeCubicInOut };
})(window);
