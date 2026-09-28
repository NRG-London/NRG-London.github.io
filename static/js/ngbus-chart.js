/* ============================================================================
   ngbus-chart.js — the timeline on a bus route page.

   Reads the inline payload written by layouts/bus/single.html: week labels, one
   series per direction, the daily figures for the last 35 days, and the known
   collection outages.

   Progressive enhancement. The page already carries every one of these numbers
   in a real table; this draws their shape. If the script never arrives the
   reader loses a picture, not the facts.

   THE ONE RULE THIS FILE EXISTS TO KEEP
   -------------------------------------
   A missing week is never joined across. Drawing a straight line from the last
   week before an outage to the first week after it would invent weeks of
   steady service out of a period when nothing was recorded at all — the exact
   claim the whole page is built to avoid making. Runs of missing points break
   the line and are shaded and labelled instead.

   THE X AXIS IS TIME, NOT POSITION IN THE LIST
   --------------------------------------------
   `weeks` has not always been a contiguous run: the sweep used to leave out a
   week it had nothing for, and spacing points by index drew 2 Aug and 30 Aug as
   neighbours, making a four-week gap vanish. Points are placed by date, and any
   absent point is shaded as "no data" like any other. The same code then draws
   the daily views without a special case.

   WEEKS AND DAYS ARE THE SAME CHART
   ---------------------------------
   The span chips choose between two sources: the weekly series (all data, 12
   months, 3 months) and the daily series (last month, last week), which the
   sweep supplies for the most recent 35 days. Everything below works from a
   `view()` object, so neither source needs its own drawing code.

   THE TIMETABLE LINE
   ------------------
   For "wait over 10 minutes" each series carries what the timetable alone would
   give, drawn dashed in the same colour. Without it a thin Sunday timetable
   reads as a bad Sunday service — the figure jumps every weekend on every
   route in London.

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

  var daily = (spec.daily && spec.daily.days && spec.daily.days.length &&
               spec.daily.series && spec.daily.series.length) ? spec.daily : null;

  var DAY = 864e5;
  var WEEK = 7 * DAY;

  /* The SVG scales to the column, so its viewBox sets how large the axis text
     is RELATIVE to the plot. One fixed box means that on a phone the labels
     shrink with everything else until they are unreadable. A narrower box on a
     narrow screen keeps the type at a sensible size. `b` leaves room for two
     rows of labels: the date, and the year under the first label of each year. */
  var WIDE = { W: 760, H: 316, t: 14, r: 16, b: 54, l: 48, ticks: 5, dot: 3 };
  var NARROW = { W: 420, H: 316, t: 12, r: 10, b: 50, l: 40, ticks: 4, dot: 2.6 };
  /* A week can be published on much less than a full week's collection. Below
     this share it still counts — the publish gate is 0.6 and lives in the data —
     but it rests on visibly thinner evidence than its neighbours, and the chart
     says so. */
  var FULL = 0.9;
  /* How long the pointer has to rest before the readout appears. Without it,
     sweeping across the chart fired a tooltip for every point passed over. */
  var HOVER_DELAY = 300;

  /* Rolling spans, counted back from the period the page reports on. The weekly
     ones are in weeks, so each holds a whole number of the points it plots; the
     daily ones are in days and read the sweep's 35-day series. */
  var RANGES = { all: null, '12m': 52, '3m': 13 };
  var DAY_RANGES = { month: 35, week: 7 };

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
  var title = document.getElementById('ngbus-chart-title');
  /* The heading says what span is on show, because the chart now opens on the
     last week, and "Week by week" over seven daily points would be wrong. */
  var SPAN_TITLES = { week: 'The last week, day by day', month: 'The last month, day by day',
                      '3m': 'The last three months, week by week',
                      '12m': 'The last twelve months, week by week', all: 'Week by week' };

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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
     decimal place where the wait figures do not — rounded to whole percent,
     most routes would read a flat 0% and the chart would look broken rather
     than good. */
  function fmt(v) {
    if (v == null) return 'no data';
    if (metric === 'ewt' || metric === 'tsw') return v.toFixed(1) + ' min';
    /* Two decimals only while the figure is under 1%: a weekly route-wide rate
       of 0.34% needs them, a day on the 38 at 45.50% does not. */
    if (metric === 'cur') return (v * 100).toFixed(v < 0.01 ? 2 : 1) + '%';
    return Math.round(v * 100) + '%';
  }

  function axisLabel(v) {
    if (metric === 'ewt' || metric === 'tsw') return v.toFixed(1);
    if (metric === 'cur') return (v * 100).toFixed(axisStep < 0.01 ? 1 : 0) + '%';
    return Math.round(v * 100) + '%';
  }

  var TITLES = {
    ewt: 'Excess wait time in each direction, in minutes.',
    ot: 'Share of departures leaving on time.',
    p: 'Share of waiting time spent inside a gap longer than ten minutes.',
    cur: 'Share of journeys turned back before the end of the line.',
    tsw: 'Wait added by buses cut short, at each day\u2019s hardest-hit stop, in minutes.'
  };
  var ARIA = {
    ewt: 'excess wait time',
    ot: 'share of departures on time',
    p: 'share of waits over ten minutes',
    cur: 'share of journeys cut short',
    tsw: 'wait added by buses cut short at the hardest-hit stop'
  };

  /* ---- the view: weeks or days ------------------------------------------- */

  function dayMode() { return !!(daily && DAY_RANGES[range]); }

  /* One object describing what is on show, so the drawing code below never has
     to know which source it came from. */
  function view() {
    if (dayMode()) {
      var n = DAY_RANGES[range];
      var days = daily.days;
      var from = Math.max(0, days.length - n);
      var idx = [];
      for (var i = from; i < days.length; i++) idx.push(i);
      return {
        mode: 'day', step: DAY, labels: days, series: daily.series, idx: idx,
        times: days.map(function (d) { return Date.parse(d); }),
        cov: function (i) { var c = (daily.coverage || [])[i]; return c == null ? null : c; },
        /* A day is "missing" when nothing could be drawn for it. The sweep
           nulls a day with less than its stated minimum of collection, so the
           blank is already the honest signal; coverage alone would band days
           that published perfectly good figures on a short evening outage. */
        missing: function (i) {
          return !daily.series.some(function (s) {
            var v = (s[metric] || [])[i];
            return v != null;
          });
        }
      };
    }
    var span = RANGES[range];
    var last = Date.parse(spec.current || '');
    var times = weeks.map(function (w) { return Date.parse(w); });
    if (isNaN(last)) last = times[times.length - 1];
    var wi = [];
    for (var k = 0; k < weeks.length; k++) {
      if (span == null || (times[k] > last - span * WEEK && times[k] <= last)) wi.push(k);
    }
    var thr = spec.threshold != null ? spec.threshold : 0.6;
    return {
      mode: 'week', step: WEEK, labels: weeks, series: series, idx: wi, times: times,
      cov: function (i) {
        var lo = null;
        series.forEach(function (s) {
          var c = (s.coverage || [])[i];
          if (c == null) return;
          if (lo == null || c < lo) lo = c;
        });
        return lo;
      },
      /* Derived from coverage, NOT from the `holes` list: most holes are partial
         days in weeks that publish perfectly good data. The band means one thing
         only — no direction on this route cleared the publish threshold that
         week. `holes` supplies the reason, never the verdict. */
      missing: function (i) {
        return !series.some(function (s) {
          var c = (s.coverage || [])[i];
          return c != null && c >= thr;
        });
      }
    };
  }

  function hasMetric(V, m) {
    return V.series.some(function (s) {
      return (s[m] || []).some(function (v, i) { return v != null && V.idx.indexOf(i) !== -1; });
    });
  }

  /* Every declared gap touching this point, whatever its size. A two-hour
     partial day is worth naming on a week that published: it is the difference
     between "this week looks odd" and "the archive was down that morning". */
  function holesFor(V, i) {
    var end = V.times[i];
    var start = V.mode === 'week' ? end - 6 * DAY : end;
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

  /* Merge [x1, x2] intervals that touch, so a run of empty points is one band
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

  var T0, T1, STEP;

  function xt(t) { return T1 > T0 ? G.l + ((t - T0) / (T1 - T0)) * IW : G.l + IW / 2; }
  function halfStep() { return T1 > T0 ? (STEP / 2 / (T1 - T0)) * IW : IW / 2; }
  function clampX(v) { return Math.max(G.l, Math.min(G.l + IW, v)); }

  /* The timetable line shares the axis with the measure it is compared against,
     so it counts towards the domain. */
  function domain(V) {
    var hi = 0, any = false;
    var withTt = metric === 'p';
    V.series.forEach(function (s) {
      V.idx.forEach(function (i) {
        var v = (s[metric] || [])[i];
        if (v != null) { any = true; if (v > hi) hi = v; }
        if (withTt) {
          var t = (s.tt || [])[i];
          if (t != null && t > hi) hi = t;
        }
      });
    });
    if (!any) return null;
    /* Punctuality is a share with a ceiling, and a route at 95% should look
       near the top of its range, not at the top of a rescaled one. */
    if (metric === 'ot') return { lo: 0, hi: 1, step: 1 / G.ticks };
    /* Zero-based. Excess wait has a real, meaningful zero — a route running
       exactly to its headway — so cropping the axis would exaggerate ordinary
       wobble into a crisis. */
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
  var current = null;
  var axisStep = 1;        // tick spacing, so axis labels carry only the decimals they need      // the view being drawn, for the hover readout

  function draw() {
    pickGeom();
    hide();
    var V = view();

    /* Not every measure exists in both sources — the daily series carry no
       curtailment figure — so rather than an empty chart, the chart falls back
       to the measure the span can draw and moves the chip to match. The chips
       it cannot draw are disabled, so the fallback reads as the span's limit
       rather than as a button that ignored the click. */
    if (!hasMetric(V, metric)) {
      var alt = ['p', 'ot', 'ewt', 'cur', 'tsw'].filter(function (m) { return m !== metric && hasMetric(V, m); })[0];
      if (alt) {
        metric = alt;
        if (sub && TITLES[metric]) sub.textContent = TITLES[metric];
      }
    }
    host.querySelectorAll('[data-metric]').forEach(function (b) {
      var m = b.getAttribute('data-metric');
      var ok = hasMetric(V, m);
      b.disabled = !ok;
      b.setAttribute('aria-pressed', String(ok && m === metric));
      if (!ok) b.title = V.mode === 'day'
        ? 'Not measured day by day — try a longer span'
        : 'Nothing to draw for this route in this period';
      else b.removeAttribute('title');
    });

    current = V;
    if (title) title.textContent = V.mode === 'day' ? SPAN_TITLES[range]
                                 : (SPAN_TITLES[range] && range !== 'week' && range !== 'month'
                                    ? SPAN_TITLES[range] : 'Week by week');
    plot.textContent = '';
    if (legend) legend.textContent = '';
    if (!V.idx.length) return;

    STEP = V.step;
    T0 = V.times[V.idx[0]];
    T1 = V.times[V.idx[V.idx.length - 1]];

    var dom = domain(V);
    if (!dom) {
      var p = document.createElement('p');
      p.className = 'ngbus-empty';
      p.textContent = range === 'all'
        ? 'No week in the record has enough data for this route to plot.'
        : 'Nothing was recorded for this route in this period.';
      plot.appendChild(p);
      return;
    }

    var y = function (v) { return G.t + IH - ((v - dom.lo) / (dom.hi - dom.lo)) * IH; };
    var hw = halfStep();
    axisStep = dom.step;

    var svg = el('svg', {
      viewBox: '0 0 ' + G.W + ' ' + G.H,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': (V.mode === 'day' ? 'Daily ' : 'Weekly ') + (ARIA[metric] || metric) +
                    ' for route ' + spec.route + '. The same figures are listed in the table below.'
    });

    /* Points with nothing publishable, behind everything: those in the record
       that cleared nothing, and those missing from the record entirely. */
    var empty = [];
    V.idx.forEach(function (i, k) {
      if (V.missing(i)) empty.push([clampX(xt(V.times[i]) - hw), clampX(xt(V.times[i]) + hw)]);
      if (k > 0) {
        var prev = V.idx[k - 1];
        if (V.times[i] - V.times[prev] > STEP * 1.5) {
          empty.push([clampX(xt(V.times[prev]) + hw), clampX(xt(V.times[i]) - hw)]);
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

    /* Points that published on thin evidence, lighter than an outage band — a
       fainter version of the same mark, because it is a weaker version of the
       same problem. */
    var anyThin = false;
    V.idx.forEach(function (i) {
      var c = V.cov(i);
      if (V.missing(i) || c == null || c >= FULL) return;
      anyThin = true;
      var x1 = clampX(xt(V.times[i]) - hw), x2 = clampX(xt(V.times[i]) + hw);
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

    drawXLabels(svg, V);

    /* The point being read, marked so the readout — which sits to one side
       rather than over the pointer — is visibly tied to a place on the axis. */
    cursor = el('line', { 'class': 'ngbus-cursor', x1: 0, x2: 0, y1: G.t, y2: G.t + IH, visibility: 'hidden' });
    svg.appendChild(cursor);

    var anyTt = false;

    V.series.forEach(function (s, si) {
      var cls = ['a', 'b', 'c'][Math.min(si, 2)];

      /* The timetable line first, so the measured line draws over it. */
      if (metric === 'p' && (s.tt || []).some(function (t) { return t != null; })) {
        anyTt = true;
        line(svg, V, s.tt, y, 'ngbus-line ngbus-line--' + cls + ' ngbus-line--tt');
      }
      line(svg, V, s[metric] || [], y, 'ngbus-line ngbus-line--' + cls);

      /* Fewer points, room for bigger dots. */
      var dot = V.idx.length > 30 ? G.dot : G.dot + 0.8;
      var vals = s[metric] || [];
      V.idx.forEach(function (i) {
        if (vals[i] == null) return;
        svg.appendChild(el('circle', {
          'class': 'ngbus-dot--' + cls, cx: xt(V.times[i]), cy: y(vals[i]), r: dot
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
      if (anyTt) {
        var tItem = document.createElement('span');
        tItem.className = 'ngbus-legend__item';
        var tSw = document.createElement('span');
        tSw.className = 'ngbus-legend__swatch ngbus-legend__swatch--tt';
        tItem.appendChild(tSw);
        tItem.appendChild(document.createTextNode('dashed: the same figure if every bus ran to the timetable'));
        legend.appendChild(tItem);
      }
      [[anyHole, 'ngbus-hole', V.mode === 'day' ? 'no data this day' : 'no data this week'],
       [anyThin, 'ngbus-thin', 'thinner ' + (V.mode === 'day' ? 'day' : 'week') +
                               ' (data for under ' + Math.round(FULL * 100) + '% of it)']
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
    wireHover(svg, V, hw);
  }

  /* One polyline per unbroken run: a null, or a gap in the record wider than
     one step, ends the run. */
  function line(svg, V, vals, y, cls) {
    var run = [];
    var flush = function () {
      if (run.length > 1) {
        svg.appendChild(el('polyline', {
          'class': cls, points: run.map(function (pt) { return pt[0] + ',' + pt[1]; }).join(' ')
        }));
      }
      run = [];
    };
    V.idx.forEach(function (i, k) {
      var v = vals[i];
      if (v == null || (k > 0 && V.times[i] - V.times[V.idx[k - 1]] > STEP * 1.5)) flush();
      if (v != null) run.push([xt(V.times[i]), y(v)]);
    });
    flush();
  }

  /* x labels: the date, and the year beneath the first label shown in each
     year. Weekly, that is one per month at the first week ending in it; daily,
     an evenly spaced handful. A label is dropped if it would run into the one
     before, except when it starts a new year — the year has to sit under the
     date it belongs to, so there the earlier label gives way instead. */
  function drawXLabels(svg, V) {
    var labels = [];
    if (V.mode === 'week') {
      var seenMonth = '';
      V.idx.forEach(function (i) {
        var m = V.labels[i].slice(0, 7);
        if (m === seenMonth) return;
        seenMonth = m;
        labels.push({ i: i, year: V.labels[i].slice(0, 4), text: MONTHS[Number(V.labels[i].slice(5, 7)) - 1] });
      });
    } else {
      var every = Math.max(1, Math.ceil(V.idx.length / 7));
      V.idx.forEach(function (i, k) {
        if (k % every !== 0 && k !== V.idx.length - 1) return;
        labels.push({ i: i, year: V.labels[i].slice(0, 4), text: shortDate(V.labels[i]) });
      });
    }
    var minGap = (G === NARROW ? 30 : 26) * (V.mode === 'day' ? 1.6 : 1);
    var kept = [];
    labels.forEach(function (lb, k) {
      var prev = kept[kept.length - 1];
      lb.newYear = k === 0 || lb.year !== labels[k - 1].year;
      if (prev && xt(V.times[lb.i]) - xt(V.times[prev.i]) < minGap) {
        if (lb.newYear && !prev.newYear) kept.pop();
        else return;
      }
      kept.push(lb);
    });
    var baseY = G.t + IH;
    kept.forEach(function (lb) {
      /* A label centred on the last point overhangs the plot and is clipped by
         the card ("26 Se"), so one near the right edge is right-aligned. */
      var lx = xt(V.times[lb.i]);
      var anchor = lx > G.l + IW - 18 ? 'end' : 'middle';
      var t = el('text', { 'class': 'ngbus-ax', x: lx, y: baseY + 20, 'text-anchor': anchor });
      t.textContent = lb.text;
      svg.appendChild(t);
      if (lb.newYear) {
        var yr = el('text', {
          'class': 'ngbus-ax ngbus-ax--year', x: xt(V.times[lb.i]), y: baseY + 36, 'text-anchor': 'middle'
        });
        yr.textContent = lb.year;
        svg.appendChild(yr);
      }
    });
  }

  /* ---- hover readout ------------------------------------------------------
     Two rules, both from using it. It waits HOVER_DELAY before appearing, so
     passing the pointer across the chart does not fire a readout per point;
     once it is up, moving along updates it straight away. And it pins to the
     top of the card on the side AWAY from the pointer, so it never covers the
     part being looked at. */

  var tip, timer = null;

  function wireHover(svg, V, hw) {
    V.idx.forEach(function (i) {
      var x1 = clampX(xt(V.times[i]) - hw), x2 = clampX(xt(V.times[i]) + hw);
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
    var V = current;
    if (!V) return;
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'ngbus-tip';
      host.appendChild(tip);
    }
    var iso = V.labels[i];
    var head = V.mode === 'day'
      ? DAYS[new Date(V.times[i]).getUTCDay()] + ' ' + shortDate(iso) + ' ' + iso.slice(0, 4)
      : 'Week ending ' + shortDate(iso) + ' ' + iso.slice(0, 4);
    var lines = ['<strong>' + head + '</strong>'];
    V.series.forEach(function (s) {
      var row = esc(s.name) + ': ' + fmt((s[metric] || [])[i]);
      if (metric === 'p') {
        var t = (s.tt || [])[i];
        if (t != null) row += ' <span class="ngl2-tt">(timetable ' + Math.round(t * 100) + '%)</span>';
      }
      /* Which stop it was — the figure is the day's worst stop, not the route. */
      if (metric === 'tsw') {
        var pl = (s.tswp || [])[i];
        if (pl && (s.tsw || [])[i] != null) row += ' <span class="ngl2-tt">at ' + esc(pl) + '</span>';
      }
      lines.push(row);
    });
    /* Always shown, not only when low: a reader comparing two points needs to
       know how much evidence each rests on, and a figure that appears only
       sometimes is a figure nobody learns to look for. Coverage is one
       network-wide number, so it is labelled as that. */
    var c = V.cov(i);
    if (c != null) {
      lines.push('<span class="ngl2-cov">Data collected for ' + Math.round(c * 100) +
                 '% of the ' + (V.mode === 'day' ? 'day' : 'week') + '</span>');
    }
    holesFor(V, i).forEach(function (h) {
      lines.push('<span class="ngl2-gap"><strong>' + esc(holeLabel(h)) + '</strong> ' +
                 esc(h.reason) + '</span>');
    });
    tip.innerHTML = lines.join('<br>');
    tip.hidden = false;

    /* Which half of the card the point is in decides which side the readout
       takes, aligned with the plot's own edge. Measured against the card: the
       tooltip is positioned inside `.ngbus-chart`, whose padding box starts to
       the left of the SVG. */
    var hostBox = host.getBoundingClientRect();
    var plotBox = plot.getBoundingClientRect();
    var px = (plotBox.left - hostBox.left) + (xt(V.times[i]) / G.W) * plotBox.width;
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
      cursor.setAttribute('x1', xt(V.times[i]));
      cursor.setAttribute('x2', xt(V.times[i]));
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
