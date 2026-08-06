/* ================================================================
   NeilGarratt.com — Chart engine (static)
   A small, dependency-free SVG renderer that produces editorial
   charts in the site's "Sage Mist + Conservative Blue" language.

   Renders by building SVG strings and assigning innerHTML. That is
   the right shape for a static PNG and the wrong one for animation —
   the animated engine is charts-live.js, which builds keyed DOM.
   Both read their palettes, scales, formatters and geometry from
   chart-core.js so the two cannot drift apart.

   REQUIRES chart-core.js to be loaded first.

   Public API:
     NGCharts.state            -> { tone, palette }
     NGCharts.setTone(name)
     NGCharts.setPalette(name)
     NGCharts.register(id, spec)   spec = { type, data, opts }
     NGCharts.renderAll()
     NGCharts.theme()          -> resolved colours for current state
   ================================================================ */
(function (global) {
  'use strict';

  var C = global.NGCore;
  if (!C) throw new Error('charts.js requires chart-core.js to be loaded first');

  /* ---------- shared tokens & maths (see chart-core.js) ---------- */
  var INK = C.INK;
  var SEQ = C.SEQ, DIV = C.DIV;
  var PALETTES = C.PALETTES, TONES = C.TONES;
  var GEOM = C.GEOM;
  var state = C.state;              // shared object: mutating it here is intended
  var hexToRgb = C.hexToRgb, mix = C.mix;
  var theme = C.theme;
  var lin = C.lin, niceScale = C.niceScale;
  var fmtCompact = C.fmtCompact, fmtNum = C.fmtNum;
  var esc = C.esc;

  var registry = {};

  /* ---------- svg helpers ---------- */
  function el(tag, attrs, inner) {
    var a = '';
    for (var k in attrs) if (attrs[k] != null) a += ' ' + k + '="' + attrs[k] + '"';
    return '<' + tag + a + '>' + (inner || '') + '</' + tag + '>';
  }
  function txt(x, y, s, cls, attrs) {
    attrs = attrs || {};
    attrs.x = x; attrs.y = y; attrs.class = 'ngc-t' + (cls ? ' ' + cls : '');
    return el('text', attrs, esc(s));
  }

  /* ================================================================
     VERTICAL BAR
     data: [{label, value, highlight?, note?}]
       value: null/undefined renders a zero-height gap. With a note it shows
              that text (e.g. "No data"); with neither, the bar is blank
              (no label) — useful for future years left as a runway.
       note:  text shown where the value label goes, instead of the number
              (e.g. "No data" on a gap bar). Reads as a quiet annotation.
     opts: { unit, max, valueLabels, source,
             targets: [{ value, from, to, label, labelAt, color }] }
       targets: horizontal reference lines (e.g. a performance target). Each
              spans data indices from..to at height `value`, with a marker at
              the `to` bar (the "target year", whose x-label is emphasised),
              and `label` text anchored above the line at index `labelAt`.
     ================================================================ */
  function vbar(data, opts) {
    opts = opts || {};
    var th = theme();
    var G = GEOM.vbar;
    var W = G.W, H = G.H, m = G.m;
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var maxV = opts.max || Math.max.apply(null, data.map(function (d) { return d.value || 0; }));
    var sc = niceScale(0, maxV, G.ticks);
    var y = lin(sc.min, sc.max, m.t + ih, m.t);
    var n = data.length;
    var step = iw / n, bw = Math.min(step * G.barFrac, G.barCap);
    // Same ladder as charts-live.js: full label, shortened, then rotated. Both
    // engines compute it from the same inputs, so the baked SVG and the live
    // render always choose the same form.
    var fit = C.fitCategoryLabels(data.map(function (d) { return d.label; }),
                                  step, th.dark ? 14.5 : 13.5);
    H += fit.extraBottom;
    var svg = '';

    // gridlines + y axis labels
    sc.ticks.forEach(function (tk) {
      var yy = y(tk);
      if (th.grid) svg += el('line', { x1: m.l, x2: m.l + iw, y1: yy, y2: yy, stroke: th.gridColor, 'stroke-width': G.gridW });
      svg += txt(m.l + G.tickDx, yy + G.tickDy, fmtCompact(tk, opts.unit), 'ngc-axis', { fill: th.sub, 'text-anchor': 'end' });
    });
    // baseline
    svg += el('line', { x1: m.l, x2: m.l + iw, y1: y(0), y2: y(0), stroke: th.axisColor, 'stroke-width': G.baseW });

    function cxOf(i) { return m.l + step * i + step / 2; }
    var targetYears = {};
    (opts.targets || []).forEach(function (tg) { if (tg.to != null) targetYears[tg.to] = 1; });

    data.forEach(function (d, i) {
      var cx = cxOf(i);
      var bx = cx - bw / 2;
      var hasVal = d.value != null;
      var v = hasVal ? d.value : 0;
      var by = y(v), bh = y(0) - by;
      var isNote = d.note != null;
      var fill = d.highlight ? th.highlight : (opts.mono ? th.series[0] : th.series[i % th.series.length]);
      if (opts.dimOthers && !d.highlight) fill = th.muted;
      svg += el('rect', { x: bx, y: by, width: bw, height: Math.max(0, bh), fill: fill, rx: G.rx });
      if (opts.valueLabels !== false && (hasVal || isNote)) {
        var lab = isNote ? d.note : fmtCompact(v, opts.unit);
        // A bar near the axis maximum has no room above its cap, and the
        // label's ascenders would be clipped by the top of the viewBox
        // (e.g. 99.0k against a 100k axis). Drop it inside the bar instead.
        var place = C.valueLabelPlacement(by, bh, G);
        var labFill = place.inside ? C.readableOn(fill)
          : (isNote ? th.sub : (d.highlight ? fill : th.text));
        svg += txt(cx, place.y, lab, 'ngc-val', {
          fill: labFill, 'text-anchor': 'middle',
          'font-weight': isNote ? 500 : (d.highlight ? 700 : 600)
        });
      }
      var tgYear = targetYears[i];
      var catY = m.t + ih + G.catDy;
      svg += txt(cx, catY, fit.labels[i], 'ngc-cat', {
        fill: tgYear ? th.text : th.sub,
        'text-anchor': fit.rotate ? 'end' : 'middle',
        transform: fit.rotate ? 'rotate(' + fit.rotate + ' ' + cx + ' ' + catY + ')' : null,
        'font-weight': tgYear ? 700 : null
      });
    });

    // target reference lines (drawn over the bars)
    (opts.targets || []).forEach(function (tg) {
      var col = tg.color || th.highlight;
      var ty = y(tg.value);
      var x0 = cxOf(tg.from || 0), x1 = cxOf(tg.to != null ? tg.to : n - 1);
      svg += el('line', { x1: x0, x2: x1, y1: ty, y2: ty, stroke: col,
        'stroke-width': 2, 'stroke-dasharray': '6 4', 'stroke-linecap': 'round' });
      svg += el('circle', { cx: x1, cy: ty, r: 4, fill: col });
      if (tg.label)
        svg += txt(cxOf(tg.labelAt != null ? tg.labelAt : (tg.to != null ? tg.to : n - 1)),
          ty - 10, tg.label, 'ngc-val', { fill: col, 'text-anchor': 'middle', 'font-weight': 600 });
    });
    return wrapSVG(W, H, svg);
  }

  /* ================================================================
     GROUPED / CLUSTERED BAR
     data: { categories:[...], series:[{name, values:[...]}] }
     ================================================================ */
  function gbar(data, opts) {
    opts = opts || {};
    var th = theme();
    var G = GEOM.gbar;
    var W = G.W, H = G.H, m = G.m;
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var allV = [];
    data.series.forEach(function (s) { allV = allV.concat(s.values); });
    var sc = niceScale(0, opts.max || Math.max.apply(null, allV), G.ticks);
    var y = lin(sc.min, sc.max, m.t + ih, m.t);
    var nC = data.categories.length, nS = data.series.length;
    var gstep = iw / nC, gpad = gstep * G.gpadFrac;
    var inner = gstep - gpad, bw = inner / nS;
    var fit = C.fitCategoryLabels(data.categories, gstep, th.dark ? 14.5 : 13.5);
    H += fit.extraBottom;
    var svg = '';

    sc.ticks.forEach(function (tk) {
      var yy = y(tk);
      if (th.grid) svg += el('line', { x1: m.l, x2: m.l + iw, y1: yy, y2: yy, stroke: th.gridColor, 'stroke-width': G.gridW });
      svg += txt(m.l + G.tickDx, yy + G.tickDy, fmtCompact(tk, opts.unit), 'ngc-axis', { fill: th.sub, 'text-anchor': 'end' });
    });
    svg += el('line', { x1: m.l, x2: m.l + iw, y1: y(0), y2: y(0), stroke: th.axisColor, 'stroke-width': G.baseW });

    data.categories.forEach(function (cat, ci) {
      var gx = m.l + gstep * ci + gpad / 2;
      data.series.forEach(function (s, si) {
        var bx = gx + bw * si, by = y(s.values[ci]), bh = y(0) - by;
        svg += el('rect', { x: bx + G.gutter, y: by, width: bw - G.gutter * 2, height: Math.max(0, bh), fill: th.series[si % th.series.length], rx: G.rx });
      });
      var catX = gx + inner / 2, catY = m.t + ih + G.catDy;
      svg += txt(catX, catY, fit.labels[ci], 'ngc-cat', {
        fill: th.sub,
        'text-anchor': fit.rotate ? 'end' : 'middle',
        transform: fit.rotate ? 'rotate(' + fit.rotate + ' ' + catX + ' ' + catY + ')' : null
      });
    });
    return wrapSVG(W, H, svg) + legend(data.series.map(function (s, i) {
      return { name: s.name, color: th.series[i % th.series.length] };
    }));
  }

  /* ================================================================
     LINE / TIME SERIES  (with direct end-labels)
     data: { x:[...labels], series:[{name, values:[...]}] }
     ================================================================ */
  function line(data, opts) {
    opts = opts || {};
    var th = theme();
    var G = GEOM.line;
    var W = G.W, H = G.H, m = G.m;
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var allV = [];
    data.series.forEach(function (s) { allV = allV.concat(s.values); });
    var lo = Math.min.apply(null, allV), hi = Math.max.apply(null, allV);
    if (opts.zero !== false) lo = Math.min(0, lo);
    var sc = niceScale(lo, hi, G.ticks);
    var y = lin(sc.min, sc.max, m.t + ih, m.t);
    var n = data.x.length;
    var x = lin(0, n - 1, m.l, m.l + iw);
    var svg = '';

    sc.ticks.forEach(function (tk) {
      var yy = y(tk);
      if (th.grid) svg += el('line', { x1: m.l, x2: m.l + iw, y1: yy, y2: yy, stroke: th.gridColor, 'stroke-width': G.gridW });
      svg += txt(m.l + G.tickDx, yy + G.tickDy, fmtCompact(tk, opts.unit), 'ngc-axis', { fill: th.sub, 'text-anchor': 'end' });
    });
    // zero emphasis
    if (sc.min < 0) svg += el('line', { x1: m.l, x2: m.l + iw, y1: y(0), y2: y(0), stroke: th.axisColor, 'stroke-width': G.baseW });

    // x labels
    data.x.forEach(function (lab, i) {
      if (n > G.thinAbove && i % 2 !== 0 && i !== n - 1) return;
      svg += txt(x(i), m.t + ih + G.catDy, lab, 'ngc-cat', { fill: th.sub, 'text-anchor': 'middle' });
    });

    data.series.forEach(function (s, si) {
      var col = th.series[si % th.series.length];
      var d = s.values.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); }).join(' ');
      svg += el('path', { d: d, fill: 'none', stroke: col, 'stroke-width': si === 0 ? G.firstW : G.restW, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
      // end point + label
      var lx = x(n - 1), ly = y(s.values[n - 1]);
      svg += el('circle', { cx: lx, cy: ly, r: G.dotR, fill: col });
      svg += txt(lx + G.endDx, ly + G.endDy, s.name, 'ngc-end', { fill: col, 'font-weight': 600 });
    });
    return wrapSVG(W, H, svg);
  }

  /* ================================================================
     HORIZONTAL RANKING BAR
     data: [{label, value, highlight?}]
     ================================================================ */
  function ranking(data, opts) {
    opts = opts || {};
    var th = theme();
    var G = GEOM.ranking;
    var rows = data.slice().sort(function (a, b) { return b.value - a.value; });
    var rowH = G.rowH, gap = G.gap;
    var W = G.W, m = G.m;
    var ih = rows.length * (rowH + gap) - gap;
    var H = m.t + ih + m.b;
    var iw = W - m.l - m.r;
    var maxV = opts.max || Math.max.apply(null, rows.map(function (d) { return d.value; }));
    var sc = niceScale(0, maxV, G.ticks);
    var x = lin(0, sc.max, m.l, m.l + iw);
    var svg = '';

    if (th.grid) sc.ticks.forEach(function (tk) {
      if (tk === 0) return;
      svg += el('line', { x1: x(tk), x2: x(tk), y1: m.t - 2, y2: m.t + ih, stroke: th.gridColor, 'stroke-width': G.gridW });
      svg += txt(x(tk), m.t + ih + G.axisDy, fmtCompact(tk, opts.unit), 'ngc-axis', { fill: th.sub, 'text-anchor': 'middle' });
    });
    svg += el('line', { x1: m.l, x2: m.l, y1: m.t - 2, y2: m.t + ih, stroke: th.axisColor, 'stroke-width': G.baseW });

    rows.forEach(function (d, i) {
      var ry = m.t + i * (rowH + gap);
      var fill = d.highlight ? th.highlight : (opts.dimOthers ? th.muted : th.series[0]);
      svg += el('rect', { x: m.l, y: ry, width: Math.max(0, x(d.value) - m.l), height: rowH, fill: fill, rx: G.rx });
      svg += txt(m.l + G.labelDx, ry + rowH / 2 + G.textDy, d.label, 'ngc-cat', {
        fill: d.highlight ? th.text : th.sub, 'text-anchor': 'end',
        'font-weight': d.highlight ? 600 : 400
      });
      svg += txt(x(d.value) + G.valueDx, ry + rowH / 2 + G.textDy, fmtCompact(d.value, opts.unit), 'ngc-val', {
        fill: th.text, 'text-anchor': 'start', 'font-weight': d.highlight ? 700 : 600
      });
    });
    return wrapSVG(W, H, svg);
  }

  /* ================================================================
     LONDON BOROUGH TILE-GRID CHOROPLETH
     data: { values: { CODE: number }, unit, highlight:[CODE..] }
     Schematic "grid map" — one square per borough, roughly geographic.
     ================================================================ */
  var BOROUGHS = [
    ['EN', 'Enfield', 4, 0], ['BNT', 'Barnet', 3, 1], ['HGY', 'Haringey', 4, 1],
    ['WF', 'Waltham F.', 5, 1], ['RB', 'Redbridge', 6, 1], ['HV', 'Havering', 7, 1],
    ['HRW', 'Harrow', 1, 2], ['BRE', 'Brent', 2, 2], ['CMD', 'Camden', 3, 2],
    ['ISL', 'Islington', 4, 2], ['HCK', 'Hackney', 5, 2], ['NWM', 'Newham', 6, 2],
    ['BD', 'Bark. & Dag.', 7, 2], ['HIL', 'Hillingdon', 0, 3], ['EAL', 'Ealing', 1, 3],
    ['HF', 'Ham. & Ful.', 2, 3], ['WST', 'Westminster', 3, 3], ['COL', 'City', 4, 3],
    ['TH', 'Tower H.', 5, 3], ['GRN', 'Greenwich', 6, 3], ['BXL', 'Bexley', 7, 3],
    ['HNS', 'Hounslow', 1, 4], ['KC', 'Kens. & Chel.', 2, 4], ['WND', 'Wandsworth', 3, 4],
    ['LBH', 'Lambeth', 4, 4], ['SWK', 'Southwark', 5, 4], ['LEW', 'Lewisham', 6, 4],
    ['RIC', 'Richmond', 2, 5], ['MRT', 'Merton', 3, 5], ['BRO', 'Bromley', 6, 5],
    ['KNG', 'Kingston', 2, 6], ['STN', 'Sutton', 3, 6], ['CRY', 'Croydon', 4, 6]
  ];

  function tilemap(data, opts) {
    opts = opts || {};
    var th = theme();
    var G = GEOM.tilemap;
    var cell = G.cell, pad = G.pad;
    var cols = G.cols, rows = G.rows;
    var W = cols * cell, H = rows * cell;
    var vals = data.values;
    var present = Object.keys(vals).map(function (k) { return vals[k]; });
    var lo = Math.min.apply(null, present), hi = Math.max.apply(null, present);
    var seq = th.seq;
    function colorFor(v) {
      var t = (v - lo) / (hi - lo || 1);
      var idx = t * (seq.length - 1);
      var i = Math.floor(idx), f = idx - i;
      if (i >= seq.length - 1) return seq[seq.length - 1];
      return mix(seq[i], seq[i + 1], f);
    }
    function readable(bg) {
      var r = hexToRgb(bg);
      var lum = (0.299 * r[0] + 0.587 * r[1] + 0.114 * r[2]) / 255;
      return lum > 0.6 ? INK : '#ffffff';
    }
    var hl = (opts.highlight || []).reduce(function (o, c) { o[c] = 1; return o; }, {});
    var svg = '';
    BOROUGHS.forEach(function (b) {
      var code = b[0], name = b[1], cx = b[2] * cell, cy = b[3] * cell;
      var has = vals[code] != null;
      var fill = has ? colorFor(vals[code]) : (th.dark ? 'rgba(243,246,244,0.06)' : '#EDF1EF');
      var fg = has ? readable(fill) : th.sub;
      svg += el('rect', {
        x: cx + pad / 2, y: cy + pad / 2, width: cell - pad, height: cell - pad,
        fill: fill, rx: G.rx,
        stroke: hl[code] ? th.highlight : 'none', 'stroke-width': hl[code] ? G.hlW : 0
      });
      svg += txt(cx + cell / 2, cy + cell / 2 + G.codeDy, code, 'ngc-tile-code', { fill: fg, 'text-anchor': 'middle', 'font-weight': 700 });
      if (has) svg += txt(cx + cell / 2, cy + cell / 2 + G.valDy, fmtCompact(vals[code], opts.unit), 'ngc-tile-val', { fill: fg, 'text-anchor': 'middle', opacity: 0.9 });
    });
    return wrapSVG(W, H, svg) + seqLegend(lo, hi, opts.unit, th);
  }

  /* ================================================================
     SPARKLINE (for KPI callouts)  -> small inline svg string
     ================================================================ */
  function sparkline(values, opts) {
    opts = opts || {};
    var th = theme();
    var G = GEOM.spark;
    var W = G.W, H = G.H, m = G.m;
    var lo = Math.min.apply(null, values), hi = Math.max.apply(null, values);
    var x = lin(0, values.length - 1, m, W - m);
    var y = lin(lo, hi, H - m, m);
    var col = opts.color || th.highlight;
    var d = values.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); }).join(' ');
    var area = d + ' L' + x(values.length - 1).toFixed(1) + ' ' + (H - m) + ' L' + x(0).toFixed(1) + ' ' + (H - m) + ' Z';
    var svg = el('path', { d: area, fill: col, opacity: G.areaOpacity }) +
      el('path', { d: d, fill: 'none', stroke: col, 'stroke-width': G.lineW, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }) +
      el('circle', { cx: x(values.length - 1), cy: y(values[values.length - 1]), r: G.dotR, fill: col });
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" class="ngc-spark" preserveAspectRatio="xMidYMid meet">' + svg + '</svg>';
  }

  /* ---------- shared chrome ---------- */
  function wrapSVG(W, H, inner) {
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet" class="ngc-svg" role="img">' + inner + '</svg>';
  }
  function legend(items) {
    var th = theme();
    var s = '<div class="ngc-legend">';
    items.forEach(function (it) {
      s += '<span class="ngc-legend__item" style="color:' + th.sub + '">' +
        '<span class="ngc-legend__swatch" style="background:' + it.color + '"></span>' + esc(it.name) + '</span>';
    });
    return s + '</div>';
  }
  function seqLegend(lo, hi, unit, th) {
    var stops = th.seq.map(function (c, i) { return c + ' ' + (i / (th.seq.length - 1) * 100) + '%'; }).join(', ');
    return '<div class="ngc-seqlegend">' +
      '<span class="ngc-seqlegend__lab" style="color:' + th.sub + '">' + fmtCompact(lo, unit) + '</span>' +
      '<span class="ngc-seqlegend__bar" style="background:linear-gradient(90deg,' + stops + ')"></span>' +
      '<span class="ngc-seqlegend__lab" style="color:' + th.sub + '">' + fmtCompact(hi, unit) + '</span>' +
      '</div>';
  }

  var RENDERERS = { vbar: vbar, gbar: gbar, line: line, ranking: ranking, tilemap: tilemap };

  /* ---------- public ---------- */
  function register(id, spec) { registry[id] = spec; }
  function renderOne(id) {
    var spec = registry[id];
    var node = document.getElementById(id);
    if (!spec || !node) return;
    var fig = node.closest('.ng-chart');
    if (fig) fig.setAttribute('data-tone', state.tone);
    node.innerHTML = RENDERERS[spec.type](spec.data, spec.opts || {});
  }
  function renderAll() { Object.keys(registry).forEach(renderOne); document.dispatchEvent(new CustomEvent('ngcharts:render')); }
  function setTone(t) { if (TONES[t]) { state.tone = t; renderAll(); } }
  function setPalette(p) { if (PALETTES[p]) { state.palette = p; renderAll(); } }

  global.NGCharts = {
    state: state, setTone: setTone, setPalette: setPalette,
    register: register, renderAll: renderAll, renderOne: renderOne,
    theme: theme, sparkline: sparkline, fmtCompact: fmtCompact, fmtNum: fmtNum,
    PALETTES: PALETTES, TONES: TONES, BOROUGHS: BOROUGHS
  };
})(window);
