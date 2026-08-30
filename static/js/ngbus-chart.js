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
  /* A week can be published on much less than a full week's watching. Below this
     share of expected observations it still counts — the publish gate is 0.6 and
     lives in the data — but it rests on visibly thinner evidence than its
     neighbours, and the chart says so. 39% of published week-cells in the live
     data sit between 0.6 and 0.98, so this is the common case, not an edge one.
     Gaps large and small are a permanent feature of the source: the national
     archive has been down for a month, for a day, and for part of a day. */
  var FULL = 0.9;

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

  /* Curtailment rates live around a few tenths of a percent, so they need a
     decimal place where P(wait>10) does not — rounded to whole percent, most
     routes would read a flat 0% and the chart would look broken rather than
     good. */
  function fmt(v) {
    if (v == null) return 'no data';
    if (metric === 'ewt') return v.toFixed(1) + ' min';
    if (metric === 'cur') return (v * 100).toFixed(2) + '%';
    return Math.round(v * 100) + '%';
  }

  function axisLabel(v) {
    if (metric === 'ewt') return v.toFixed(1);
    if (metric === 'cur') return (v * 100).toFixed(1) + '%';
    return Math.round(v * 100) + '%';
  }

  var TITLES = {
    ewt: 'Excess wait time at each terminus, in minutes.',
    p: 'Share of waiting time spent inside a gap longer than ten minutes.',
    cur: 'Share of journeys turned back before the end of the line.'
  };
  var ARIA = {
    ewt: 'excess wait time',
    p: 'share of waits over ten minutes',
    cur: 'share of journeys cut short'
  };

  /* ---- which weeks have nothing to show ----------------------------------
     Derived from coverage, NOT from the `holes` list, and that changed once the
     sweep started generating holes properly. Nineteen of the twenty-four are
     partial days — two or three hours missing from an otherwise ordinary
     Tuesday — and the week they fall in publishes perfectly good data. Banding
     any week that touched a hole blacked out 16 of 44 weeks on the 157, several
     of them at 98% coverage.

     So the band means one thing only: no terminus on this route cleared the
     publish threshold that week. Why that happened is a separate question, and
     `holes` answers it in the tooltip. */

  function missingWeeks() {
    var thr = spec.threshold != null ? spec.threshold : 0.6;
    return weeks.map(function (w, i) {
      return !series.some(function (s) {
        var c = (s.coverage || [])[i];
        return c != null && c >= thr;
      });
    });
  }

  /* Every declared gap touching this week, whatever its size. A two-hour
     partial day is worth naming on a week that published: it is the difference
     between "this week looks odd" and "the archive was down that morning". */
  function holesFor(i) {
    var end = Date.parse(weeks[i]);
    var start = end - 6 * 864e5;
    return (spec.holes || []).filter(function (h) {
      var hs = Date.parse(h.start), he = Date.parse(h.end);
      return !isNaN(hs) && !isNaN(he) && hs <= end && he >= start;
    });
  }

  function holeLabel(h) {
    return h.start === h.end ? shortDate(h.start)
                             : shortDate(h.start) + '–' + shortDate(h.end);
  }

  function esc(t) {
    return String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* The weakest evidence behind each week: the lower of the two termini, because
     a route is only as well observed as its worse-watched end. */
  function weekCoverage() {
    return weeks.map(function (w, i) {
      var lo = null;
      series.forEach(function (s) {
        var c = (s.coverage || [])[i];
        if (c == null) return;
        if (lo == null || c < lo) lo = c;
      });
      return lo;
    });
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
      'aria-label': 'Weekly ' + (ARIA[metric] || metric) +
                    ' for route ' + spec.route + '. The same figures are listed in the table below.'
    });

    /* weeks with nothing publishable, behind everything */
    var holes = missingWeeks();
    runs(holes).forEach(function (r) {
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

    /* Weeks that published on thin evidence, marked behind the grid and lighter
       than an outage band — a fainter version of the same idea, because it is a
       weaker version of the same problem. Hole weeks are skipped: they already
       carry the stronger band and would otherwise be shaded twice. */
    var cov = weekCoverage();
    var halfStep = weeks.length > 1 ? (x(1) - x(0)) / 2 : IW / 2;
    cov.forEach(function (c, i) {
      if (holes[i] || c == null || c >= FULL) return;
      var x1 = Math.max(G.l, x(i) - halfStep);
      var x2 = Math.min(G.l + IW, x(i) + halfStep);
      svg.appendChild(el('rect', {
        'class': 'ngbus-thin', x: x1, y: G.t, width: Math.max(x2 - x1, 1), height: IH
      }));
    });

    /* y grid and ticks */
    for (var i = 0; i <= G.ticks; i++) {
      var v = dom.lo + dom.step * i;
      svg.appendChild(el(i === 0 ? 'line' : 'line', {
        'class': i === 0 ? 'ngbus-base' : 'ngbus-grid',
        x1: G.l, x2: G.l + IW, y1: y(v), y2: y(v)
      }));
      var lab = el('text', { 'class': 'ngbus-ax', x: G.l - 8, y: y(v) + 4, 'text-anchor': 'end' });
      lab.textContent = axisLabel(v);
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

    if (legend) {
      var anyThin = cov.some(function (c, i) { return !holes[i] && c != null && c < FULL; });
      var anyHole = holes.some(Boolean);
      [[anyHole, 'ngbus-hole', 'no data this week'],
       [anyThin, 'ngbus-thin', 'thinner week (under ' + Math.round(FULL * 100) + '% coverage)']
      ].forEach(function (k) {
        if (!k[0]) return;
        var item = document.createElement('span');
        item.className = 'ngbus-legend__item';
        var sw = document.createElement('span');
        sw.className = 'ngbus-legend__band ' + k[1];
        item.appendChild(sw);
        item.appendChild(document.createTextNode(k[2]));
        legend.appendChild(item);
      });
    }

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
    /* Always shown, not only when low: a reader comparing two weeks needs to
       know how much watching each rests on, and a figure that appears only
       sometimes is a figure nobody learns to look for. */
    var cs = series.map(function (s) { return (s.coverage || [])[i]; })
                   .filter(function (c) { return c != null; });
    if (cs.length) {
      var lo = Math.min.apply(null, cs), hi = Math.max.apply(null, cs);
      var pct = function (v) { return Math.round(v * 100) + '%'; };
      lines.push('<span class="ngl2-cov">Coverage ' +
        (Math.abs(hi - lo) < 0.005 ? pct(lo) : pct(lo) + '–' + pct(hi)) + '</span>');
    }

    /* The specific gap behind this week, rather than a page-long list at the
       bottom that nobody reads and nobody can match to a dip in the line. */
    holesFor(i).forEach(function (h) {
      lines.push('<span class="ngl2-gap"><strong>' + esc(holeLabel(h)) + '</strong> ' +
                 esc(h.reason) + '</span>');
    });
    tip.innerHTML = lines.join('<br>');
    /* Positioned against the plot's real width rather than as a percentage, and
       then clamped. The tooltip is centred on the week it describes, so near
       either end half of it used to hang outside the card and get clipped —
       which is where the interesting weeks tend to be, the record starting and
       ending in a gap. */
    tip.hidden = false;                      // measurable only once displayed
    /* Measured against the card, not the plot: the tooltip is absolutely
       positioned inside `.ngbus-chart`, whose padding box starts a rem and a
       quarter to the left of where the SVG does. */
    var hostBox = host.getBoundingClientRect();
    var plotBox = plot.getBoundingClientRect();
    var half = tip.offsetWidth / 2;
    var px = (plotBox.left - hostBox.left) + (cx / G.W) * plotBox.width;
    tip.style.left = Math.max(half + 4, Math.min(px, hostBox.width - half - 4)) + 'px';
  }

  function hide() { if (tip) tip.hidden = true; }

  /* ---- wiring -------------------------------------------------------------- */

  host.querySelectorAll('[data-metric]').forEach(function (b) {
    b.addEventListener('click', function () {
      metric = b.dataset.metric;
      host.querySelectorAll('[data-metric]').forEach(function (o) {
        o.setAttribute('aria-pressed', String(o === b));
      });
      if (sub && TITLES[metric]) sub.textContent = TITLES[metric];
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
