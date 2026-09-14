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
   week before an outage to the first week after it would invent weeks of
   steady service out of a period when nothing was recorded at all — the exact
   claim the whole page is built to avoid making. Runs of missing weeks break
   the line and are shaded and labelled instead.

   THE X AXIS IS TIME, NOT POSITION IN THE LIST
   --------------------------------------------
   `weeks` is not a contiguous run of Sundays: the sweep leaves out a week it
   has nothing at all for (22 Feb 2026; 9, 16 and 23 Aug 2026). Spacing points
   by their index drew 2 Aug and 30 Aug as neighbours and made a four-week gap
   vanish. Points are placed by date, and any week absent from the list is
   shaded as "no data" like any other.

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

  var DAY = 864e5;
  var WEEK = 7 * DAY;
  var times = weeks.map(function (w) { return Date.parse(w); });

  /* The SVG scales to the column, so its viewBox sets how large the axis text
     is RELATIVE to the plot. One fixed box means that on a phone the labels
     shrink with everything else until they are unreadable. A narrower box on a
     narrow screen keeps the type at a sensible size. `b` leaves room for two
     rows of labels: months, and the year under the first month of each year. */
  var WIDE = { W: 760, H: 316, t: 14, r: 16, b: 54, l: 48, ticks: 5, dot: 3 };
  var NARROW = { W: 420, H: 316, t: 12, r: 10, b: 50, l: 40, ticks: 4, dot: 2.6 };
  /* A week can be published on much less than a full week's collection. Below
     this share it still counts — the publish gate is 0.6 and lives in the data —
     but it rests on visibly thinner evidence than its neighbours, and the chart
     says so. */
  var FULL = 0.9;
  /* How long the pointer has to rest before the readout appears. Without it,
     sweeping across the chart fired a tooltip for every week passed over. */
  var HOVER_DELAY = 300;

  /* Rolling spans, counted back from the week the page reports on
     (`week_ending`), not from the last week in the record: the sweep carries
     partial weeks after it that are under the publish threshold, and counting
     from those filled a third of "Last 3 months" with "no data". "All data"
     still runs to the very end. In weeks rather than calendar months so every
     span holds a whole number of the points it plots. */
  var RANGES = { all: null, '12m': 52, '3m': 13 };

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

  /* The page decides which measure and span open, because the measure depends
     on the route: a frequent route leads with long waits, a timetabled one with
     punctuality. */
  function pressedValue(attr, fallback) {
    var b = host.querySelector('[data-' + attr + '][aria-pressed="true"]');
    return b ? b.getAttribute('data-' + attr) : fallback;
  }
  var metric = pressedValue('metric', 'ewt');
  var range = pressedValue('range', 'all');
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
    ot: 'Share of departures leaving on time at each terminus.',
    p: 'Share of waiting time spent inside a gap longer than ten minutes.',
    cur: 'Share of journeys turned back before the end of the line.'
  };
  var ARIA = {
    ewt: 'excess wait time',
    ot: 'share of departures on time',
    p: 'share of waits over ten minutes',
    cur: 'share of journeys cut short'
  };

  /* ---- which weeks are on show -------------------------------------------- */

  function visibleIndices() {
    var n = RANGES[range];
    var last = Date.parse(spec.current || '');
    if (isNaN(last)) last = times[times.length - 1];
    var out = [];
    for (var i = 0; i < weeks.length; i++) {
      if (n == null || (times[i] > last - n * WEEK && times[i] <= last)) out.push(i);
    }
    return out;
  }

  /* ---- which weeks have nothing to show ----------------------------------
     Derived from coverage, NOT from the `holes` list. Most holes are partial
     days — two or three hours missing from an otherwise ordinary Tuesday — and
     the week they fall in publishes perfectly good data. So the band means one
     thing only: no terminus on this route cleared the publish threshold that
     week (or the week is missing from the record altogether). Why that happened
     is a separate question, and `holes` answers it in the tooltip. */

  function isMissing(i) {
    var thr = spec.threshold != null ? spec.threshold : 0.6;
    return !series.some(function (s) {
      var c = (s.coverage || [])[i];
      return c != null && c >= thr;
    });
  }

  /* Every declared gap touching this week, whatever its size. A two-hour
     partial day is worth naming on a week that published: it is the difference
     between "this week looks odd" and "the archive was down that morning". */
  function holesFor(i) {
    var end = times[i];
    var start = end - 6 * DAY;
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

  /* The weakest evidence behind a week: the lowest coverage across termini. */
  function coverageAt(i) {
    var lo = null;
    series.forEach(function (s) {
      var c = (s.coverage || [])[i];
      if (c == null) return;
      if (lo == null || c < lo) lo = c;
    });
    return lo;
  }

  /* Merge [x1, x2] intervals that touch, so a run of empty weeks is one band
     with one label rather than a stack of slivers. */
  function merge(spans) {
    spans.sort(function (a, b) { return a[0] - b[0]; });
    var out = [];
    spans.forEach(function (s) {
      var last = out[out.length - 1];
      if (last && s[0] <= last[1] + 0.5) last[1] = Math.max(last[1], s[1]);
      else out.push([s[0], s[1]]);
    });
    return out;
  }

  /* ---- scales ------------------------------------------------------------ */

  var T0, T1;   // the time domain on show

  function x(i) { return xt(times[i]); }
  function xt(t) { return T1 > T0 ? G.l + ((t - T0) / (T1 - T0)) * IW : G.l + IW / 2; }
  function halfWeek() { return T1 > T0 ? (WEEK / 2 / (T1 - T0)) * IW : IW / 2; }
  function clampX(v) { return Math.max(G.l, Math.min(G.l + IW, v)); }

  function domain(vis) {
    var hi = 0, any = false;
    series.forEach(function (s) {
      vis.forEach(function (i) {
        var v = (s[metric] || [])[i];
        if (v != null) { any = true; if (v > hi) hi = v; }
      });
    });
    if (!any) return null;
    /* Punctuality is a share with a ceiling, and a route at 95% should look
       near the top of its range, not at the top of a rescaled one. */
    if (metric === 'ot') return { lo: 0, hi: 1, step: 1 / G.ticks };
    /* Zero-based. Excess wait has a real, meaningful zero — a route running
       exactly to its headway — so cropping the axis would exaggerate ordinary
       week-to-week wobble into a crisis. */
    if (hi <= 0) hi = 1;
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

  var cursor = null;

  function draw() {
    pickGeom();
    hide();
    var vis = visibleIndices();
    plot.textContent = '';
    if (legend) legend.textContent = '';
    if (!vis.length) return;

    T0 = times[vis[0]];
    T1 = times[vis[vis.length - 1]];

    var dom = domain(vis);
    if (!dom) {
      var p = document.createElement('p');
      p.className = 'ngbus-empty';
      p.textContent = range === 'all'
        ? 'No week in the record has enough data for this route to plot.'
        : 'No week in this period has enough data for this route to plot.';
      plot.appendChild(p);
      return;
    }

    var y = function (v) { return G.t + IH - ((v - dom.lo) / (dom.hi - dom.lo)) * IH; };
    var hw = halfWeek();

    var svg = el('svg', {
      viewBox: '0 0 ' + G.W + ' ' + G.H,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': 'Weekly ' + (ARIA[metric] || metric) +
                    ' for route ' + spec.route + '. The same figures are listed in the table below.'
    });

    /* Weeks with nothing publishable, behind everything: those in the record
       that no terminus cleared, and those missing from the record entirely. */
    var empty = [];
    vis.forEach(function (i, k) {
      if (isMissing(i)) empty.push([clampX(x(i) - hw), clampX(x(i) + hw)]);
      if (k > 0) {
        var prev = vis[k - 1];
        if (times[i] - times[prev] > WEEK + DAY) {
          empty.push([clampX(x(prev) + hw), clampX(x(i) - hw)]);
        }
      }
    });
    var anyHole = empty.length > 0;
    merge(empty).forEach(function (r) {
      svg.appendChild(el('rect', {
        'class': 'ngbus-hole', x: r[0], y: G.t, width: Math.max(r[1] - r[0], 2), height: IH
      }));
      if (r[1] - r[0] > 46) {
        var t = el('text', {
          'class': 'ngbus-hole__label', x: (r[0] + r[1]) / 2, y: G.t + 14, 'text-anchor': 'middle'
        });
        t.textContent = 'no data';
        svg.appendChild(t);
      }
    });

    /* Weeks that published on thin evidence, lighter than an outage band — a
       fainter version of the same mark, because it is a weaker version of the
       same problem. */
    var anyThin = false;
    vis.forEach(function (i) {
      var c = coverageAt(i);
      if (isMissing(i) || c == null || c >= FULL) return;
      anyThin = true;
      var x1 = clampX(x(i) - hw), x2 = clampX(x(i) + hw);
      svg.appendChild(el('rect', {
        'class': 'ngbus-thin', x: x1, y: G.t, width: Math.max(x2 - x1, 1), height: IH
      }));
    });

    /* y grid and ticks */
    for (var g = 0; g <= G.ticks; g++) {
      var v = dom.lo + dom.step * g;
      svg.appendChild(el('line', {
        'class': g === 0 ? 'ngbus-base' : 'ngbus-grid',
        x1: G.l, x2: G.l + IW, y1: y(v), y2: y(v)
      }));
      var lab = el('text', { 'class': 'ngbus-ax', x: G.l - 8, y: y(v) + 4, 'text-anchor': 'end' });
      lab.textContent = axisLabel(v);
      svg.appendChild(lab);
    }

    /* x labels: one per month, at the first week ending in it, and the year
       beneath the first month shown in each year — the leftmost label, then
       every January. A month label is dropped if it would run into the one
       before, except when it starts a new year: the year has to sit under the
       month it belongs to, so there the earlier label gives way instead. */
    var labels = [];
    var seenMonth = '';
    vis.forEach(function (i) {
      var m = weeks[i].slice(0, 7);
      if (m === seenMonth) return;
      seenMonth = m;
      labels.push({ i: i, year: weeks[i].slice(0, 4), month: Number(weeks[i].slice(5, 7)) });
    });
    var minGap = G === NARROW ? 30 : 26;
    var kept = [];
    labels.forEach(function (lb, k) {
      var prev = kept[kept.length - 1];
      lb.newYear = k === 0 || lb.year !== labels[k - 1].year;
      if (prev && x(lb.i) - x(prev.i) < minGap) {
        if (lb.newYear && !prev.newYear) kept.pop();
        else return;
      }
      kept.push(lb);
    });
    var baseY = G.t + IH;
    kept.forEach(function (lb) {
      var t = el('text', { 'class': 'ngbus-ax', x: x(lb.i), y: baseY + 20, 'text-anchor': 'middle' });
      t.textContent = MONTHS[lb.month - 1];
      svg.appendChild(t);
      if (lb.newYear) {
        var yr = el('text', { 'class': 'ngbus-ax ngbus-ax--year', x: x(lb.i), y: baseY + 36, 'text-anchor': 'middle' });
        yr.textContent = lb.year;
        svg.appendChild(yr);
      }
    });

    /* The week being read, marked so the readout — which sits to one side
       rather than over the pointer — is visibly tied to a place on the axis. */
    cursor = el('line', { 'class': 'ngbus-cursor', x1: 0, x2: 0, y1: G.t, y2: G.t + IH, visibility: 'hidden' });
    svg.appendChild(cursor);

    /* one polyline per unbroken run of weeks, per terminus */
    series.forEach(function (s, si) {
      var cls = ['a', 'b', 'c'][Math.min(si, 2)];
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
      vis.forEach(function (i, k) {
        var v = vals[i];
        /* Break on a missing value, and on a week missing from the record. */
        if (v == null || (k > 0 && times[i] - times[vis[k - 1]] > WEEK + DAY)) flush();
        if (v != null) run.push([x(i), y(v)]);
      });
      flush();
      /* Fewer points, room for bigger dots. */
      var dot = vis.length > 30 ? G.dot : G.dot + 0.8;
      vis.forEach(function (i) {
        if (vals[i] == null) return;
        svg.appendChild(el('circle', {
          'class': 'ngbus-dot--' + cls, cx: x(i), cy: y(vals[i]), r: dot
        }));
      });

      if (legend) {
        var item = document.createElement('span');
        item.className = 'ngbus-legend__item';
        var sw = document.createElement('span');
        sw.className = 'ngbus-legend__swatch';
        sw.style.background = ['var(--bus-line-a, #b48544)', 'var(--bus-line-b, #4A5A6B)',
                               'var(--bus-line-c, #3F8E7E)'][Math.min(si, 2)];
        item.appendChild(sw);
        item.appendChild(document.createTextNode(s.name));
        legend.appendChild(item);
      }
    });

    if (legend) {
      [[anyHole, 'ngbus-hole', 'no data this week'],
       [anyThin, 'ngbus-thin', 'thinner week (data for under ' + Math.round(FULL * 100) + '% of it)']
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
    wireHover(svg, vis, hw);
  }

  /* ---- hover readout ------------------------------------------------------
     Two rules, both from using it. It waits HOVER_DELAY before appearing, so
     passing the pointer across the chart does not fire a readout per week; once
     it is up, moving along the weeks updates it straight away. And it pins to
     the top of the card on the side AWAY from the pointer, so it never covers
     the weeks being looked at — centred over the pointer, it could hide most of
     the plot. */

  var tip, timer = null;

  function wireHover(svg, vis, hw) {
    vis.forEach(function (i) {
      var x1 = clampX(x(i) - hw), x2 = clampX(x(i) + hw);
      var hit = el('rect', {
        x: x1, y: G.t, width: Math.max(x2 - x1, 1), height: IH,
        fill: 'transparent', 'class': 'ngbus-hit'
      });
      hit.addEventListener('mouseenter', function () {
        window.clearTimeout(timer);
        if (tip && !tip.hidden) { show(i); return; }
        timer = window.setTimeout(function () { show(i); }, HOVER_DELAY);
      });
      svg.appendChild(hit);
    });
    svg.addEventListener('mouseleave', hide);
  }

  function show(i) {
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'ngbus-tip';
      host.appendChild(tip);
    }
    var lines = ['<strong>Week ending ' + shortDate(weeks[i]) + ' ' + weeks[i].slice(0, 4) + '</strong>'];
    series.forEach(function (s) {
      lines.push(esc(s.name) + ': ' + fmt((s[metric] || [])[i]));
    });
    /* Always shown, not only when low: a reader comparing two weeks needs to
       know how much evidence each rests on, and a figure that appears only
       sometimes is a figure nobody learns to look for. Coverage is one
       network-wide number per week, so it is labelled as that. */
    var c = coverageAt(i);
    if (c != null) {
      lines.push('<span class="ngl2-cov">Data collected for ' + Math.round(c * 100) +
                 '% of the week</span>');
    }
    holesFor(i).forEach(function (h) {
      lines.push('<span class="ngl2-gap"><strong>' + esc(holeLabel(h)) + '</strong> ' +
                 esc(h.reason) + '</span>');
    });
    tip.innerHTML = lines.join('<br>');
    tip.hidden = false;

    /* Which half of the card the week is in decides which side the readout
       takes, aligned with the plot's own edge. Measured against the card: the
       tooltip is positioned inside `.ngbus-chart`, whose padding box starts to
       the left of the SVG. */
    var hostBox = host.getBoundingClientRect();
    var plotBox = plot.getBoundingClientRect();
    var px = (plotBox.left - hostBox.left) + (x(i) / G.W) * plotBox.width;
    var inset = plotBox.left - hostBox.left;
    tip.style.top = (plotBox.top - hostBox.top) + 'px';
    if (px < hostBox.width / 2) {
      tip.style.left = '';
      tip.style.right = inset + 'px';
    } else {
      tip.style.right = '';
      tip.style.left = inset + 'px';
    }
    if (cursor) {
      cursor.setAttribute('x1', x(i));
      cursor.setAttribute('x2', x(i));
      cursor.setAttribute('visibility', 'visible');
    }
  }

  function hide() {
    window.clearTimeout(timer);
    if (tip) tip.hidden = true;
    if (cursor) cursor.setAttribute('visibility', 'hidden');
  }

  /* ---- wiring -------------------------------------------------------------- */

  function wireChips(attr, apply) {
    host.querySelectorAll('[data-' + attr + ']').forEach(function (b) {
      b.addEventListener('click', function () {
        apply(b.getAttribute('data-' + attr));
        host.querySelectorAll('[data-' + attr + ']').forEach(function (o) {
          o.setAttribute('aria-pressed', String(o === b));
        });
        draw();
      });
    });
  }

  wireChips('metric', function (v) {
    metric = v;
    if (sub && TITLES[metric]) sub.textContent = TITLES[metric];
  });
  wireChips('range', function (v) { range = v; });

  /* Redraw only when the geometry actually changes bucket, not on every pixel
     of a resize. */
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
