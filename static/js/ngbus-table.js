/* ============================================================================
   ngbus-table.js — the all-London bus league table.

   Progressive enhancement, not a fallback. `bus-league.html` has already
   rendered the twenty longest waits as real HTML, sparklines included. This
   script takes over with every route, the frequent / timetabled tabs, sorting,
   searching and the view chips — and draws every row with the same geometry the
   server used, so the handover is invisible.

   If this file never arrives, the reader still has a correct, complete,
   house-styled table of the twenty worst frequent routes. That is the whole
   point of rendering them server-side.

   TWO KINDS OF ROUTE
   ------------------
   Frequent routes are judged by excess wait, timetabled routes by the share of
   departures on time — the split TfL itself makes. They are never ranked in one
   list: excess wait goes negative on timetabled routes and would crown them the
   best in London. Each tab has its own columns, its own "worst" direction (long
   waits are bad; low punctuality is bad) and its own chip labels. Night routes
   are carried in the payload only so a search can say where they went.

   OWNED BY THIS REPO. Unlike ngc2-*.js, nothing outside the Hugo site writes
   this file; E:\Road Data writes data/bus/*.json and nothing else.

   Payload row format, set in bus-league.html. One-letter keys, so the two must
   agree:

       r  route     "157"
       k  kind      "f" frequent | "t" timetabled | "n" night
       w  where     "Terminus A ↔ Terminus B"
       d  delta     change against the comparison week, or null
                    (minutes of excess wait on f; share on time on t)
       f  from      week_ending of that comparison week, or null
       c  coverage  0-1
       s  spark     weekly lead measure, nulls allowed
     frequent only:
       e  ewt       excess wait, minutes, or null
       p  p         P(wait > 10 min), 0-1, or null
     timetabled only:
       o  ontime    share of departures on time, 0-1, or null

   Present only once the sweep emits curtailments (spec.hasCurt says so):
       cu curtailment_rate  0-1, or null
       cn curtailments      journeys cut short this week
       cx flagged           route tripped the backend's reporting threshold
   ========================================================================== */

(function () {
  'use strict';

  var root = document.getElementById('ngbus-league');
  var dataEl = document.getElementById('ngbus-league-data');
  if (!root || !dataEl) return;

  var spec;
  try {
    spec = JSON.parse(dataEl.textContent);
  } catch (err) {
    if (window.console) console.error('ngbus-table: bad payload', err);
    return;   // leave the server-rendered rows exactly as they are
  }

  var R = { ROUTE: 'r', KIND: 'k', EWT: 'e', P: 'p', OT: 'o', DELTA: 'd', FROM: 'f',
            COV: 'c', SPARK: 's', WHERE: 'w', CURT: 'cu', CURTN: 'cn', CFLAG: 'cx' };

  /* Curtailments are additive: the column, the chip and the sort key all exist
     only when the data carries them. */
  var hasCurt = !!spec.hasCurt;
  var rows = spec.rows || [];
  var body = document.getElementById('ngbus-body');
  var countEl = document.getElementById('ngbus-count');
  var noteEl = document.getElementById('ngbus-tabnote');
  var query = document.getElementById('ngbus-q');
  var table = root.querySelector('.ngbus-table');
  var caption = table.querySelector('caption');

  /* Must match bus-spark.html, or a sorted table would visibly re-draw. */
  var SPARK = { W: 78, H: 22, PAD: 2 };
  var BAR_MAX = 46;                       // px, matches the server-rendered bar
  var TOP_N = 20;                         // rows the chip views show
  var DEAD = { f: 0.05, t: 0.005 };       // below this, "no change": 3 seconds; half a point

  /* ---- the two kinds ------------------------------------------------------
     Everything that differs between the tabs lives here, so the rest of the
     file reads the same for both. `lead` is the headline measure; `worse` is
     the sort direction that puts the worst route first. */
  var KINDS = {
    f: {
      lead: 'ewt', worse: 'desc',
      name: 'frequent',
      note: 'Buses at least every twelve minutes or so. People turn up and wait, so ' +
            'these routes are judged by how long the wait is.',
      caption: 'Frequent bus route performance',
      views: { worst: 'Longest waits', best: 'Shortest waits', improved: 'Most improved',
               curtailed: 'Most cut short', all: 'Every route' },
      worstNote: function (n, of) { return 'The ' + n + ' longest waits of ' + of + ' frequent routes reporting.'; },
      bestNote: function (n, of) { return 'The ' + n + ' shortest waits of ' + of + ' frequent routes reporting.'; },
      improvedNote: 'biggest falls in excess wait',
      cols: [
        { label: '#', cls: 'ngbus-rank' },
        { label: 'Route', sort: 'route' },
        { label: 'Excess wait', sort: 'ewt' },
        { label: 'Wait > 10 min', sort: 'p' },
        { label: 'Change', sort: 'delta' },
        { label: 'Trend' },
        { label: 'Cut short', sort: 'curt', curt: true,
          title: 'Share of journeys turned back before the end of the route' },
        { label: 'Coverage', sort: 'coverage' }
      ]
    },
    t: {
      lead: 'ot', worse: 'asc',
      name: 'timetabled',
      note: 'Less frequent routes, where people go by the timetable — so these are judged ' +
            'by whether the bus left on time.',
      caption: 'Timetabled bus route punctuality',
      views: { worst: 'Least punctual', best: 'Most punctual', improved: 'Most improved',
               curtailed: 'Most cut short', all: 'Every route' },
      worstNote: function (n, of) { return 'The ' + n + ' least punctual of ' + of + ' timetabled routes reporting.'; },
      bestNote: function (n, of) { return 'The ' + n + ' most punctual of ' + of + ' timetabled routes reporting.'; },
      improvedNote: 'biggest rises in departures on time',
      cols: [
        { label: '#', cls: 'ngbus-rank' },
        { label: 'Route', sort: 'route' },
        { label: 'On time', sort: 'ot',
          title: 'Share of departures leaving ' + (spec.otWords || 'on time') },
        { label: 'Change', sort: 'delta' },
        { label: 'Trend' },
        { label: 'Cut short', sort: 'curt', curt: true,
          title: 'Share of journeys turned back before the end of the route' },
        { label: 'Coverage', sort: 'coverage' }
      ]
    }
  };

  var SORT_KEY = { ewt: R.EWT, p: R.P, ot: R.OT, delta: R.DELTA, coverage: R.COV, curt: R.CURT };

  var state = { kind: 'f', view: 'worst', sort: 'ewt', dir: 'desc', q: '' };

  function K() { return KINDS[state.kind]; }
  function cols() { return K().cols.filter(function (c) { return !c.curt || hasCurt; }); }

  /* The direction that reads "worst first" for a column on the current tab. On
     frequent routes a bigger number is worse everywhere; on timetabled routes a
     smaller on-time share, and a bigger fall in it, are worse. */
  function worstDir(key) {
    if (key === 'route') return 'asc';
    if (state.kind === 't' && (key === 'ot' || key === 'delta')) return 'asc';
    return 'desc';
  }

  /* ---- helpers ---------------------------------------------------------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* Hugo lowercases page paths, so route 157 lives at /bus/157/ and N136 at
     /bus/n136/. The templates use `lower`; this must match or every link from a
     JS-rendered row 404s while the server-rendered ones work. */
  function slug(route) { return encodeURIComponent(String(route).toLowerCase()); }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function shortDate(iso) {
    if (!iso) return '';
    var p = String(iso).split('-');
    if (p.length !== 3) return iso;
    return Number(p[2]) + ' ' + MONTHS[Number(p[1]) - 1] + ' ' + p[0];
  }

  /* Natural order: 9 before 18, letter-prefixed routes after the numbers.
     The sweep writes weekly.json in the same order. */
  function naturalKey(route) {
    var head = route.replace(/[^A-Za-z]/g, '');
    var tail = route.replace(/[^0-9]/g, '');
    return [head ? 1 : 0, head, tail ? parseInt(tail, 10) : 0];
  }

  function byNatural(a, b) {
    var ka = naturalKey(a[R.ROUTE]), kb = naturalKey(b[R.ROUTE]);
    return ka[0] - kb[0] || (ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0) || ka[2] - kb[2];
  }

  /* Missing values sort to the end whichever way the column is pointing. A null
     is not a small number and it is not a large one; it must never win a
     "shortest waits" ranking by being absent. */
  function byNumber(key, dir) {
    var sign = dir === 'asc' ? 1 : -1;
    return function (a, b) {
      var x = a[key], y = b[key];
      if (x == null && y == null) return byNatural(a, b);
      if (x == null) return 1;
      if (y == null) return -1;
      return (x - y) * sign || byNatural(a, b);
    };
  }

  /* ---- the sparkline, geometry-identical to bus-spark.html --------------- */

  function spark(values, lo, hi, label) {
    var n = values.length;
    if (!n) return '';
    var span = (hi - lo) || 1;
    var step = n > 1 ? (SPARK.W - SPARK.PAD * 2) / (n - 1) : 0;
    /* Rounded to 2dp, matching bus-spark.html, so a server-rendered row and a
       JS-rendered one are byte-identical rather than merely similar. */
    var r2 = function (n) { return Math.round(n * 100) / 100; };
    var x = function (i) { return r2(SPARK.PAD + step * i); };
    var y = function (v) {
      return r2((SPARK.H - SPARK.PAD) - ((v - lo) / span) * (SPARK.H - SPARK.PAD * 2));
    };

    var out = ['<svg class="ngbus-spark" viewBox="0 0 78 22" role="img" ' +
               'preserveAspectRatio="none" focusable="false" aria-label="' + esc(label) + '">'];
    var gapW = Math.max(step, 3);
    for (var i = 0; i < n; i++) {
      if (values[i] == null) {
        out.push('<rect class="ngbus-spark__gap" x="' + r2(x(i) - step / 2) +
                 '" y="0" width="' + r2(gapW) + '" height="' + SPARK.H + '"/>');
      }
    }
    for (var j = 0; j < n - 1; j++) {
      if (values[j] == null || values[j + 1] == null) continue;
      out.push('<line class="ngbus-spark__line" x1="' + x(j) + '" y1="' + y(values[j]) +
               '" x2="' + x(j + 1) + '" y2="' + y(values[j + 1]) + '"/>');
    }
    if (values[n - 1] != null) {
      out.push('<circle class="ngbus-spark__dot" cx="' + (SPARK.W - SPARK.PAD) +
               '" cy="' + y(values[n - 1]) + '" r="1.9"/>');
    }
    out.push('</svg>');
    return out.join('');
  }

  /* ---- one row ----------------------------------------------------------- */

  var nd = function (title) {
    return '<span class="ngbus-nd" title="' + esc(title) + '">no data</span>';
  };

  function leadCell(r) {
    if (state.kind === 't') {
      var o = r[R.OT];
      if (o == null) return '<td class="ngbus-metric">' + nd('Too little data this week to publish a figure') + '</td>';
      return '<td class="ngbus-metric ngbus-metric--lead">' +
             '<span class="ngbus-metric__bar" style="width:' + Math.round(o * BAR_MAX) + 'px"></span>' +
             '<span class="ngbus-metric__val">' + Math.round(o * 100) + '%</span></td>';
    }
    var ewt = r[R.EWT];
    if (ewt == null) return '<td class="ngbus-metric">' + nd('Too little data this week to publish a figure') + '</td>';
    var w = Math.round((ewt / spec.max) * BAR_MAX);
    return '<td class="ngbus-metric ngbus-metric--lead">' +
           '<span class="ngbus-metric__bar" style="width:' + w + 'px"></span>' +
           '<span class="ngbus-metric__val">' + ewt.toFixed(1) + ' min</span></td>';
  }

  function deltaCell(r) {
    var d = r[R.DELTA];
    if (d == null) return '<td>' + nd('No comparable earlier week') + '</td>';
    /* The comparison week is named, not assumed. Four weeks back can land
       inside a collection outage, and "vs 4 weeks ago" would then be a lie. */
    var t = 'Compared with the week ending ' + shortDate(r[R.FROM]);
    var dead = DEAD[state.kind];
    var cls, txt;
    if (state.kind === 't') {
      /* In points of on-time share, and coloured by what it means rather than
         which way the number moved: on these routes up is good. */
      var pts = Math.round(Math.abs(d) * 100);
      cls = d > dead ? 'better' : d < -dead ? 'worse' : 'flat';
      txt = d > dead ? '+' + pts + ' pts' : d < -dead ? '−' + pts + ' pts' : 'no change';
    } else {
      cls = d > dead ? 'up' : d < -dead ? 'down' : 'flat';
      txt = d > dead ? '+' + d.toFixed(2) : d < -dead ? d.toFixed(2) : 'no change';
    }
    return '<td><span class="ngbus-delta ngbus-delta--' + cls + '" title="' + esc(t) +
           '">' + txt + '</span></td>';
  }

  function rowHtml(r, rank) {
    var out = ['<tr data-href="/bus/' + slug(r[R.ROUTE]) + '/">'];

    out.push('<td class="ngbus-rank">' + (rank == null ? '' : rank) + '</td>');

    out.push('<td class="ngbus-route"><a href="/bus/' + slug(r[R.ROUTE]) +
             '/">' + esc(r[R.ROUTE]) + '</a>' +
             (r[R.WHERE] ? '<span class="ngbus-route__where">' + esc(r[R.WHERE]) + '</span>' : '') +
             '</td>');

    out.push(leadCell(r));

    if (state.kind === 'f') {
      var p = r[R.P];
      out.push('<td>' + (p == null ? nd('Too little data this week') :
                         Math.round(p * 100) + '%') + '</td>');
    }

    out.push(deltaCell(r));

    out.push('<td>' + (state.kind === 't'
      ? spark(r[R.SPARK] || [], 0, 1, 'Weekly share of departures on time for route ' + r[R.ROUTE])
      : spark(r[R.SPARK] || [], 0, spec.max, 'Weekly excess wait for route ' + r[R.ROUTE])) + '</td>');

    if (hasCurt) {
      var cu = r[R.CURT];
      /* `cu == null` and not `!cu`: nought journeys cut short is a real
         measurement, and the commonest one. */
      out.push('<td class="ngbus-curt' + (r[R.CFLAG] ? ' ngbus-curt--flagged' : '') + '">' +
        (cu == null
          ? nd('Too little data this week')
          : '<span title="' + (r[R.CURTN] || 0) + ' journeys cut short in the week">' +
            (cu * 100).toFixed(1) + '%</span>') +
        '</td>');
    }

    out.push('<td>' + Math.round((r[R.COV] || 0) * 100) + '%</td>');
    out.push('</tr>');
    return out.join('');
  }

  /* ---- selection --------------------------------------------------------- */

  function ofKind(list, kind) {
    return list.filter(function (r) { return r[R.KIND] === kind; });
  }

  function reporting(list) {
    var key = SORT_KEY[K().lead];
    return list.filter(function (r) { return r[key] != null; });
  }

  function matches(r, q) {
    return r[R.ROUTE].toLowerCase().indexOf(q) === 0 ||
           (r[R.WHERE] || '').toLowerCase().indexOf(q) !== -1;
  }

  function select() {
    var k = K();
    var mine = ofKind(rows, state.kind);
    var lead = SORT_KEY[k.lead];
    var list = mine;

    if (state.q) {
      var q = state.q.toLowerCase();
      list = mine.filter(function (r) { return matches(r, q); });
      /* A search is a search: show every match, ranked by the current column,
         rather than the top twenty of it. Matches the other tab holds, and night
         routes this table does not list, are named rather than silently lost. */
      var note = list.length + (list.length === 1 ? ' ' + k.name + ' route matches ' :
                 ' ' + k.name + ' routes match ') + '“' + state.q + '”.';
      var other = state.kind === 'f' ? 't' : 'f';
      var elsewhere = ofKind(rows, other).filter(function (r) { return matches(r, q); }).length;
      if (elsewhere) {
        note += ' ' + elsewhere + ' more under ' + KINDS[other].name + ' routes.';
      }
      var night = ofKind(rows, 'n').filter(function (r) { return matches(r, q); });
      if (night.length) {
        note += ' ' + night.slice(0, 3).map(function (r) { return r[R.ROUTE]; }).join(', ') +
                (night.length > 3 ? ' and others' : '') +
                (night.length === 1 ? ' is a night route' : ' are night routes') +
                ', measured separately.';
      }
      return { list: list.slice().sort(comparator()), ranked: false, note: note };
    }

    var of = reporting(mine).length;

    if (state.view === 'worst') {
      list = reporting(list).sort(byNumber(lead, k.worse)).slice(0, TOP_N);
      return { list: list, ranked: true, note: k.worstNote(list.length, of) };
    }
    if (state.view === 'best') {
      list = reporting(list).sort(byNumber(lead, k.worse === 'desc' ? 'asc' : 'desc')).slice(0, TOP_N);
      return { list: list, ranked: true, note: k.bestNote(list.length, of) };
    }
    if (state.view === 'curtailed') {
      /* Ranked by rate rather than by count, so a busy trunk route does not top
         the list simply for being busy. Routes with no figure are excluded
         outright rather than sorted to the bottom. */
      list = list.filter(function (r) { return r[R.CURT] != null; })
                 .sort(byNumber(R.CURT, 'desc')).slice(0, TOP_N);
      return { list: list, ranked: true,
               note: list.length
                 ? 'The ' + list.length + ' ' + k.name + ' routes turning back the largest ' +
                   'share of their journeys before the end of the line.'
                 : 'No ' + k.name + ' route has a curtailment figure this week.' };
    }
    if (state.view === 'improved') {
      /* Improvement means a shorter wait, or more buses on time, than the
         comparison week. Routes with no comparison are excluded outright rather
         than treated as unchanged — a hole in the record is not evidence of
         steadiness. */
      var dead = DEAD[state.kind];
      var better = state.kind === 't'
        ? function (r) { return r[R.DELTA] != null && r[R.DELTA] > dead; }
        : function (r) { return r[R.DELTA] != null && r[R.DELTA] < -dead; };
      list = list.filter(better)
                 .sort(byNumber(R.DELTA, state.kind === 't' ? 'desc' : 'asc')).slice(0, TOP_N);
      return { list: list, ranked: true,
               note: list.length
                 ? 'The ' + list.length + ' ' + k.improvedNote + ' against each ' +
                   'route’s last comparable week.'
                 : 'No ' + k.name + ' route has improved against a clean earlier week.' };
    }

    list = list.slice().sort(comparator());
    return { list: list, ranked: false,
             note: 'All ' + list.length + ' ' + k.name + ' routes. ' +
                   (mine.length - of) + ' had too little data this week to publish.' };
  }

  function comparator() {
    if (state.sort === 'route') {
      return state.dir === 'asc' ? byNatural : function (a, b) { return byNatural(b, a); };
    }
    var key = SORT_KEY[state.sort];
    return key == null ? byNatural : byNumber(key, state.dir);
  }

  /* ---- render ------------------------------------------------------------ */

  /* The head is rebuilt when the tab changes, because the columns do. Sort
     buttons are created here rather than in the markup: with no JavaScript they
     would be controls that do nothing. */
  var headKind = null;

  function renderHead() {
    if (headKind === state.kind) return;
    headKind = state.kind;
    var tr = table.querySelector('thead tr');
    tr.textContent = '';
    cols().forEach(function (c) {
      var th = document.createElement('th');
      th.scope = 'col';
      if (c.cls) th.className = c.cls;
      if (c.title) th.title = c.title;
      if (!c.sort) {
        th.textContent = c.label;
      } else {
        th.dataset.sort = c.sort;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = c.label;
        btn.setAttribute('aria-label', 'Sort by ' + c.label.toLowerCase());
        btn.addEventListener('click', function () {
          if (state.sort === c.sort) {
            state.dir = state.dir === 'asc' ? 'desc' : 'asc';
          } else {
            state.sort = c.sort;
            /* Route reads best A-Z; every measure reads worst first. */
            state.dir = worstDir(c.sort);
          }
          if (!state.q) state.view = 'all';
          render();
        });
        th.appendChild(btn);
      }
      tr.appendChild(th);
    });
    if (caption) {
      caption.textContent = K().caption + ' for the week ending ' + shortDate(spec.week);
    }
    if (noteEl) noteEl.textContent = K().note;
    root.querySelectorAll('[data-view]').forEach(function (b) {
      var label = K().views[b.dataset.view];
      if (label) b.textContent = label;
    });
  }

  function render() {
    renderHead();
    var sel = select();
    if (!sel.list.length) {
      body.innerHTML = '<tr><td colspan="' + cols().length + '" class="ngbus-empty">' +
                       'No ' + K().name + ' routes match. Try a route number, or a terminus name.</td></tr>';
    } else {
      var html = [];
      for (var i = 0; i < sel.list.length; i++) {
        html.push(rowHtml(sel.list[i], sel.ranked ? i + 1 : null));
      }
      body.innerHTML = html.join('');
    }
    if (countEl) {
      countEl.textContent = sel.note;
    }
    root.querySelectorAll('[data-kind]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.kind === state.kind));
    });
    root.querySelectorAll('[data-view]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(!state.q && b.dataset.view === state.view));
    });
    table.querySelectorAll('thead th[data-sort]').forEach(function (th) {
      if (th.dataset.sort === state.sort) {
        th.setAttribute('aria-sort', state.dir === 'asc' ? 'ascending' : 'descending');
      } else {
        th.removeAttribute('aria-sort');
      }
    });
  }

  /* Each view carries the sort it means, so the header arrows never contradict
     the chip that is lit. */
  function applyView(view) {
    state.view = view;
    var k = K();
    if (view === 'improved') {
      state.sort = 'delta';
      state.dir = state.kind === 't' ? 'desc' : 'asc';
    } else if (view === 'curtailed') {
      state.sort = 'curt'; state.dir = 'desc';
    } else {
      state.sort = k.lead;
      state.dir = view === 'best' ? (k.worse === 'desc' ? 'asc' : 'desc') : k.worse;
    }
  }

  /* ---- wiring ------------------------------------------------------------ */

  root.querySelectorAll('[data-kind]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (state.kind === b.dataset.kind) return;
      state.kind = b.dataset.kind;
      /* The search survives a change of tab — someone looking for "Croydon"
         wants it looked for on both. The view resets to that tab's worst. */
      applyView(state.q ? 'all' : 'worst');
      render();
    });
  });

  root.querySelectorAll('[data-view]').forEach(function (b) {
    b.addEventListener('click', function () {
      state.q = '';
      if (query) query.value = '';
      applyView(b.dataset.view);
      render();
    });
  });

  /* ---- the whole row navigates -------------------------------------------
     Three testers out of three clicked the row rather than the route number:
     the hover highlight promises a target the size of the row, so the row is
     what has to respond.

     Delegated rather than per-row, because the body is rewritten on every sort,
     search and view change.

     Deliberately NOT done by stretching the anchor across the row with an
     absolutely-positioned ::after, which is the usual trick. That overlay sits
     above the cells, and it would swallow both the `title` tooltips that explain
     "no data" and which week a change is measured against, and any attempt to
     select a number to copy. A click handler leaves the cells alone. */
  body.addEventListener('click', function (e) {
    var tr = e.target.closest ? e.target.closest('tr[data-href]') : null;
    if (!tr) return;

    /* The real anchor handles itself, including ctrl/cmd-click. */
    if (e.target.closest('a')) return;

    /* Someone dragging across a figure to copy it is not clicking a row. */
    var sel = window.getSelection && window.getSelection();
    if (sel && String(sel).length > 0) return;

    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      window.open(tr.dataset.href, '_blank', 'noopener');
      return;
    }
    window.location.href = tr.dataset.href;
  });

  /* Middle-click opens a new tab, the way a link does. */
  body.addEventListener('auxclick', function (e) {
    if (e.button !== 1) return;
    var tr = e.target.closest ? e.target.closest('tr[data-href]') : null;
    if (!tr || e.target.closest('a')) return;
    e.preventDefault();
    window.open(tr.dataset.href, '_blank', 'noopener');
  });

  if (query) {
    var timer = null;
    query.addEventListener('input', function () {
      window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        state.q = query.value.trim();
        /* If the route is only on the other tab, go there: someone typing "S4"
           wants the S4, not a message that it lives somewhere else. */
        if (state.q) {
          var q = state.q.toLowerCase();
          var other = state.kind === 'f' ? 't' : 'f';
          var here = ofKind(rows, state.kind).some(function (r) { return matches(r, q); });
          var there = ofKind(rows, other).some(function (r) { return matches(r, q); });
          if (!here && there) {
            state.kind = other;
            applyView('all');
          }
        }
        render();
      }, 120);
    });
    /* Enter on an unambiguous search goes straight to the route page — the
       fastest path to "how is my bus doing", which is the question the page
       exists to answer. Night routes included: their pages exist. */
    query.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var q = query.value.trim().toLowerCase();
      var hit = rows.filter(function (r) { return r[R.ROUTE].toLowerCase() === q; });
      if (hit.length === 1) {
        e.preventDefault();
        window.location.href = '/bus/' + slug(hit[0][R.ROUTE]) + '/';
      }
    });
  }

  render();
})();
