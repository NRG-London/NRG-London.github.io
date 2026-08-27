/* ============================================================================
   ngbus-chart.js — the week-by-week timeline on a bus route page.

   Reads the inline payload written by layouts/bus/single.html: week labels, one
   series per terminus, and the known collection outages.

   Progressive enhancement. The page already carries every one of these numbers
   in a real table; this draws their shape. If the script never arrives the
   reader loses a picture, not the facts.

   THE ONE RULE THIS FILE EXISTS TO KEEP
   -------------------------------------
   A missing week is never joined across. Drawing a straight line from the last
   week before an outage to the first week after it would invent five weeks of
   steady service out of a month when nothing was recorded at all — the exact
   claim the whole page is built to avoid making. Runs of missing weeks break
   the line and are shaded and labelled instead.

   OWNED BY THIS REPO — nothing outside the Hugo site writes this file.
   ========================================================================== */

(function () {
  'use strict';

  var host = document.getElementById('ngbus-chart');
  var dataEl = document.getElementById('ngbus-chart-data');
  var plot = document.getElementById('ngbus-chart-plot');
  if (!host || !dataEl || !plot) return;

  var spec;
  try {
    spec = JSON.parse(dataEl.textContent);
  } catch (err) {
    if (window.console) console.error('ngbus-chart: bad payload', err);
    return;
  }

  var weeks = spec.weeks || [];
  var series = spec.series || [];
  if (!weeks.length || !series.length) return;

  /* The SVG scales to the column, so its viewBox sets how large the axis text
     is RELATIVE to the plot. One fixed 760x300 box means that on a phone the
     labels shrink with everything else until they are unreadable. A narrower,
     taller box on a narrow screen keeps the type at a sensible size and gives
     the lines room to separate. */
  var WIDE = { W: 760, H: 300, t: 14, r: 16, b: 38, l: 48, ticks: 5, dot: 3 };
  var NARROW = { W: 420, H: 300, t: 12, r: 10, b: 34, l: 40, ticks: 4, dot: 2.6 };
  var G, IW, IH;
  var NS = 'http://www.w3.org/2000/svg';

  function pickGeom() {
    var next = (plot.clientWidth || 760) < 520 ? NARROW : WIDE;
    var changed = next !== G;
    G = next;
    IW = G.W - G.l - G.r;
    IH = G.H - G.t - G.b;
    return changed;
  }

  var metric = 'ewt';
  var legend = document.getElementById('ngbus-chart-legend');
  var sub = document.getElementById('ngbus-chart-sub');

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function el(name, attrs) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    return n;
  }

  function shortDate(iso) {
    var p = String(iso).split('-');
    return Number(p[2]) + ' ' + MONTHS[Number(p[1]) - 1];
  }

  function fmt(v) {
    if (v == null) return 'no data';
    return metric === 'ewt' ? v.toFixed(1) + ' min' : Math.round(v * 100) + '%';
  }

  /* ---- which weeks the outages cover -------------------------------------
     Computed from the published `holes` list, not inferred from missing values.
     Inference cannot tell "nothing was collected" from "this route did not run
     that week", and those two deserve different words on the page. */

  function holeWeeks() {
    var flags = weeks.map(function () { return false; });
    (spec.holes || []).forEach(function (h) {
      var hs = Date.parse(h.start), he = Date.parse(h.end);
      if (isNaN(hs) || isNaN(he)) return;
      weeks.forEach(function (w, i) {
        var end = Date.parse(w);
        var start = end - 6 * 864e5;             // the week ending on this Sunday
        if (start <= he && end >= hs) flags[i] = true;
      });
    });
    return flags;
  }

  /* Contiguous runs of true, as [from, to] index pairs. */
  function runs(flags) {
    var out = [], start = -1;
    for (var i = 0; i <= flags.length; i++) {
      if (i < flags.length && flags[i]) {
        if (start < 0) start = i;
      } else if (start >= 0) {
        out.push([start, i - 1]);
        start = -1;
      }
    }
    return out;
  }

  /* ---- scales ------------------------------------------------------------ */

  function x(i) { return G.l + (weeks.length > 1 ? (i / (weeks.length - 1)) * IW : IW / 2); }

  function domain() {
    var hi = 0, any = false;
    series.forEach(function (s) {
      (s[metric] || []).forEach(function (v) {
        if (v != null) { any = true; if (v > hi) hi = v; }
      });
    });
    if (!any) return null;
    /* Zero-based. Excess wait has a real, meaningful zero — a route running
       exactly to its headway — so cropping the axis would exaggerate ordinary
       week-to-week wobble into a crisis. The rail page starts its axis above
       zero for the opposite and equally good reason: percentage punctuality
       never goes near it. */
    var step = niceStep(hi / G.ticks);
    return { lo: 0, hi: step * G.ticks, step: step };
  }

  function niceStep(raw) {
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    return mult * mag;
  }

  /* ---- draw --------------------------------------------------------------- */

  function draw() {
    pickGeom();
    var dom = domain();
    plot.textContent = '';
    if (legend) legend.textContent = '';

    if (!dom) {
      var p = document.createElement('p');
      p.className = 'ngbus-empty';
      p.textContent = 'No week in the record has enough data for this route to plot.';
      plot.appendChild(p);
      return;
    }

    var y = function (v) { return G.t + IH - ((v - dom.lo) / (dom.hi - dom.lo)) * IH; };

    var svg = el('svg', {
      viewBox: '0 0 ' + G.W + ' ' + G.H,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': 'Weekly ' + (metric === 'ewt' ? 'excess wait time' : 'share of waits over ten minutes') +
                    ' for route ' + spec.route + '. The same figures are listed in the table below.'
    });

    /* outages, behind everything */
    runs(holeWeeks()).forEach(function (r) {
      var x1 = x(r[0]) - (r[0] === 0 ? 0 : (x(1) - x(0)) / 2);
      var x2 = x(r[1]) + (r[1] === weeks.length - 1 ? 0 : (x(1) - x(0)) / 2);
      svg.appendChild(el('rect', {
        'class': 'ngbus-hole', x: x1, y: G.t, width: Math.max(x2 - x1, 2), height: IH
      }));
      var mid = (x1 + x2) / 2;
      if (x2 - x1 > 46) {
        var t = el('text', {
          'class': 'ngbus-hole__label', x: mid, y: G.t + 14, 'text-anchor': 'middle'
        });
        t.textContent = 'no data';
        svg.appendChild(t);
      }
    });

    /* y grid and ticks */
    for (var i = 0; i <= G.ticks; i++) {
      var v = dom.lo + dom.step * i;
      svg.appendChild(el(i === 0 ? 'line' : 'line', {
        'class': i === 0 ? 'ngbus-base' : 'ngbus-grid',
        x1: G.l, x2: G.l + IW, y1: y(v), y2: y(v)
      }));
      var lab = el('text', { 'class': 'ngbus-ax', x: G.l - 8, y: y(v) + 4, 'text-anchor': 'end' });
      lab.textContent = metric === 'ewt' ? v.toFixed(1) : Math.round(v * 100) + '%';
      svg.appendChild(lab);
    }

    /* x labels: one per month, at the first week ending in it. Dropped if the
       previous label would run into it — a month name overlapping its neighbour
       is worse than no month name. */
    var seenMonth = '', lastX = -1e9;
    var minGap = G === NARROW ? 30 : 24;
    weeks.forEach(function (w, i) {
      var m = w.slice(0, 7);
      if (m === seenMonth) return;
      seenMonth = m;
      if (x(i) - lastX < minGap) return;
      lastX = x(i);
      var t = el('text', { 'class': 'ngbus-ax', x: x(i), y: G.H - 16, 'text-anchor': 'middle' });
      t.textContent = MONTHS[Number(w.slice(5, 7)) - 1];
      svg.appendChild(t);
    });

    /* one polyline per unbroken run of weeks, per terminus */
    series.forEach(function (s, si) {
      var cls = si === 0 ? 'a' : 'b';
      var vals = s[metric] || [];
      var run = [];
      var flush = function () {
        if (run.length > 1) {
          svg.appendChild(el('polyline', {
            'class': 'ngbus-line ngbus-line--' + cls,
            points: run.map(function (pt) { return pt[0] + ',' + pt[1]; }).join(' ')
          }));
        }
        run = [];
      };
      vals.forEach(function (v, i) {
        if (v == null) { flush(); return; }
        run.push([x(i), y(v)]);
      });
      flush();
      vals.forEach(function (v, i) {
        if (v == null) return;
        svg.appendChild(el('circle', {
          'class': 'ngbus-dot--' + cls, cx: x(i), cy: y(v), r: G.dot
        }));
      });

      if (legend) {
        var item = document.createElement('span');
        item.className = 'ngbus-legend__item';
        var sw = document.createElement('span');
        sw.className = 'ngbus-legend__swatch';
        sw.style.background = si === 0
          ? 'var(--bus-line-a, #b48544)' : 'var(--bus-line-b, #4A5A6B)';
        item.appendChild(sw);
        item.appendChild(document.createTextNode(s.name));
        legend.appendChild(item);
      }
    });

    plot.appendChild(svg);
    wireHover(svg, y);
  }

  /* ---- hover readout ------------------------------------------------------ */

  var tip;

  function wireHover(svg, y) {
    var step = weeks.length > 1 ? (x(1) - x(0)) : IW;
    weeks.forEach(function (w, i) {
      var hit = el('rect', {
        x: x(i) - step / 2, y: G.t, width: step, height: IH,
        fill: 'transparent', 'class': 'ngbus-hit'
      });
      hit.addEventListener('mouseenter', function () { show(i, x(i)); });
      hit.addEventListener('mouseleave', hide);
      svg.appendChild(hit);
    });
    svg.addEventListener('mouseleave', hide);
  }

  function show(i, cx) {
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'ngbus-tip';
      host.appendChild(tip);
    }
    var lines = ['<strong>Week ending ' + shortDate(weeks[i]) + '</strong>'];
    series.forEach(function (s) {
      lines.push(s.name + ': ' + fmt((s[metric] || [])[i]));
    });
    tip.innerHTML = lines.join('<br>');
    tip.hidden = false;
    /* Positioned as a fraction of the plot, so it tracks the SVG however the
       page has scaled it. */
    tip.style.left = ((cx / G.W) * 100) + '%';
  }

  function hide() { if (tip) tip.hidden = true; }

  /* ---- wiring -------------------------------------------------------------- */

  host.querySelectorAll('[data-metric]').forEach(function (b) {
    b.addEventListener('click', function () {
      metric = b.dataset.metric;
      host.querySelectorAll('[data-metric]').forEach(function (o) {
        o.setAttribute('aria-pressed', String(o === b));
      });
      if (sub) {
        sub.textContent = metric === 'ewt'
          ? 'Excess wait time at each terminus, in minutes.'
          : 'Share of waiting time spent inside a gap longer than ten minutes.';
      }
      hide();
      draw();
    });
  });

  /* Redraw only when the geometry actually changes bucket, not on every pixel
     of a resize: rebuilding ~90 SVG nodes on each of a drag's frames is work
     nobody sees. */
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () {
      var was = G;
      pickGeom();
      if (G !== was) draw();
    }, 150);
  });

  draw();
})();
