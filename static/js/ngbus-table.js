/* ============================================================================
   ngbus-table.js — the all-London bus league table.

   Progressive enhancement, not a fallback. `bus-league.html` has already
   rendered the twenty longest waits as real HTML, sparklines included. This
   script takes over with all ~600 routes, plus sorting, searching and the view
   chips — and draws every row with the same geometry the server used, so the
   handover is invisible.

   If this file never arrives, the reader still has a correct, complete,
   house-styled table of the twenty worst routes. That is the whole point of
   rendering them server-side, and it is why nothing here creates structure the
   markup does not already have.

   OWNED BY THIS REPO. Unlike ngc2-*.js, nothing outside the Hugo site writes
   this file; E:\Road Data writes data/bus/*.json and nothing else.

   Payload row format, set in bus-league.html. One-letter keys, so the two must
   agree:

       r  route     "157"
       e  ewt       excess wait, minutes, or null
       p  p         P(wait > 10 min), 0-1, or null
       d  delta     change in EWT against the comparison week, or null
       f  from      week_ending of that comparison week, or null
       c  coverage  0-1
       s  spark     array of weekly EWT, nulls allowed
       w  where     "Terminus A ↔ Terminus B"

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

  var R = { ROUTE: 'r', EWT: 'e', P: 'p', DELTA: 'd', FROM: 'f', COV: 'c', SPARK: 's', WHERE: 'w',
            CURT: 'cu', CURTN: 'cn', CFLAG: 'cx' };

  /* Curtailments are additive: the column, the chip and the sort key all exist
     only when the data carries them. Until the sweep emits the fields this file
     behaves exactly as it did. */
  var hasCurt = !!spec.hasCurt;
  var COLS = spec.cols || 7;
  var rows = spec.rows || [];
  var body = document.getElementById('ngbus-body');
  var countEl = document.getElementById('ngbus-count');
  var query = document.getElementById('ngbus-q');
  var table = root.querySelector('.ngbus-table');

  /* Must match bus-spark.html, or a sorted table would visibly re-draw. */
  var SPARK = { W: 78, H: 22, PAD: 2 };
  var BAR_MAX = 46;                       // px, matches the server-rendered bar
  var TOP_N = 20;                         // rows the chip views show
  var DEAD = 0.05;                        // minutes: below this, "no change"

  var state = { view: 'worst', sort: 'ewt', dir: 'desc', q: '' };

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
     `route_sort_key` in scripts/make_bus_sample.py sorts identically. Change
     one and you must change the other, or the server rows and the JS rows
     disagree about what "first" means. */
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

  function rowHtml(r, rank) {
    var ewt = r[R.EWT], p = r[R.P], d = r[R.DELTA];
    var out = ['<tr data-href="/bus/' + slug(r[R.ROUTE]) + '/">'];

    out.push('<td class="ngbus-rank">' + (rank == null ? '' : rank) + '</td>');

    out.push('<td class="ngbus-route"><a href="/bus/' + slug(r[R.ROUTE]) +
             '/">' + esc(r[R.ROUTE]) + '</a>' +
             (r[R.WHERE] ? '<span class="ngbus-route__where">' + esc(r[R.WHERE]) + '</span>' : '') +
             '</td>');

    if (ewt == null) {
      out.push('<td class="ngbus-metric">' +
               nd('Too little data this week to publish a figure') + '</td>');
    } else {
      var w = Math.round((ewt / spec.max) * BAR_MAX);
      out.push('<td class="ngbus-metric ngbus-metric--lead">' +
               '<span class="ngbus-metric__bar" style="width:' + w + 'px"></span>' +
               '<span class="ngbus-metric__val">' + ewt.toFixed(1) + ' min</span></td>');
    }

    out.push('<td>' + (p == null ? nd('Too little data this week') :
                       Math.round(p * 100) + '%') + '</td>');

    if (d == null) {
      out.push('<td>' + nd('No comparable earlier week') + '</td>');
    } else {
      /* The comparison week is named, not assumed. Four weeks back can land
         inside a collection outage, and "vs 4 weeks ago" would then be a lie. */
      var t = 'Compared with the week ending ' + shortDate(r[R.FROM]);
      var cls = d > DEAD ? 'up' : d < -DEAD ? 'down' : 'flat';
      var txt = d > DEAD ? '+' + d.toFixed(2) : d < -DEAD ? d.toFixed(2) : 'no change';
      out.push('<td><span class="ngbus-delta ngbus-delta--' + cls + '" title="' + esc(t) +
               '">' + txt + '</span></td>');
    }

    out.push('<td>' + spark(r[R.SPARK] || [], 0, spec.max,
                            'Weekly excess wait for route ' + r[R.ROUTE]) + '</td>');

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

  function reporting(list) {
    return list.filter(function (r) { return r[R.EWT] != null; });
  }

  function select() {
    var list = rows;

    if (state.q) {
      var q = state.q.toLowerCase();
      list = list.filter(function (r) {
        return r[R.ROUTE].toLowerCase().indexOf(q) === 0 ||
               (r[R.WHERE] || '').toLowerCase().indexOf(q) !== -1;
      });
      /* A search is a search: show every match, ranked by the current column,
         rather than the top twenty of it. */
      return { list: list.slice().sort(comparator()), ranked: false,
               note: list.length + (list.length === 1 ? ' route matches ' : ' routes match ') +
                     '“' + state.q + '”.' };
    }

    if (state.view === 'worst') {
      list = reporting(list).sort(byNumber(R.EWT, 'desc')).slice(0, TOP_N);
      return { list: list, ranked: true,
               note: 'The ' + list.length + ' longest waits of ' +
                     reporting(rows).length + ' routes reporting.' };
    }
    if (state.view === 'best') {
      list = reporting(list).sort(byNumber(R.EWT, 'asc')).slice(0, TOP_N);
      return { list: list, ranked: true,
               note: 'The ' + list.length + ' shortest waits of ' +
                     reporting(rows).length + ' routes reporting.' };
    }
    if (state.view === 'curtailed') {
      /* Ranked by rate rather than by count, so a busy trunk route does not top
         the list simply for being busy. Routes with no figure are excluded
         outright rather than sorted to the bottom. */
      list = list.filter(function (r) { return r[R.CURT] != null; })
                 .sort(byNumber(R.CURT, 'desc')).slice(0, TOP_N);
      return { list: list, ranked: true,
               note: list.length
                 ? 'The ' + list.length + ' routes turning back the largest share of ' +
                   'their journeys before the end of the line.'
                 : 'No route has a curtailment figure this week.' };
    }
    if (state.view === 'improved') {
      /* Improvement means a shorter wait than the comparison week. Routes with
         no comparison are excluded outright rather than treated as unchanged —
         a five-week hole in the record is not evidence of steadiness. */
      list = list.filter(function (r) { return r[R.DELTA] != null && r[R.DELTA] < -DEAD; })
                 .sort(byNumber(R.DELTA, 'asc')).slice(0, TOP_N);
      return { list: list, ranked: true,
               note: list.length
                 ? 'The ' + list.length + ' biggest falls in excess wait against each ' +
                   'route’s last comparable week.'
                 : 'No route has a clean earlier week to compare with yet.' };
    }

    list = list.slice().sort(comparator());
    return { list: list, ranked: false,
             note: 'All ' + list.length + ' routes. ' +
                   (rows.length - reporting(rows).length) +
                   ' had too little data this week to publish.' };
  }

  function comparator() {
    if (state.sort === 'route') {
      return state.dir === 'asc' ? byNatural : function (a, b) { return byNatural(b, a); };
    }
    var key = { ewt: R.EWT, p: R.P, delta: R.DELTA, coverage: R.COV, curt: R.CURT }[state.sort];
    return key == null ? byNatural : byNumber(key, state.dir);
  }

  /* ---- render ------------------------------------------------------------ */

  function render() {
    var sel = select();
    if (!sel.list.length) {
      body.innerHTML = '<tr><td colspan="' + COLS + '" class="ngbus-empty">' +
                       'No routes match. Try a route number, or a terminus name.</td></tr>';
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

  /* ---- wiring ------------------------------------------------------------ */

  root.querySelectorAll('[data-view]').forEach(function (b) {
    b.addEventListener('click', function () {
      state.view = b.dataset.view;
      state.q = '';
      if (query) query.value = '';
      /* Each view carries the sort it means, so the header arrows never
         contradict the chip that is lit. */
      state.sort = state.view === 'improved' ? 'delta'
                 : state.view === 'curtailed' ? 'curt' : 'ewt';
      state.dir = (state.view === 'best' || state.view === 'improved') ? 'asc' : 'desc';
      render();
    });
  });

  /* Sort buttons are created here rather than in the markup: with no
     JavaScript they would be controls that do nothing. */
  table.querySelectorAll('thead th[data-sort]').forEach(function (th) {
    var label = th.textContent.trim();
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.setAttribute('aria-label', 'Sort by ' + label.toLowerCase());
    btn.addEventListener('click', function () {
      var key = th.dataset.sort;
      if (state.sort === key) {
        state.dir = state.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort = key;
        /* Route reads best A-Z; every measure reads best worst-first. */
        state.dir = key === 'route' ? 'asc' : 'desc';
      }
      if (!state.q) state.view = 'all';
      render();
    });
    th.textContent = '';
    th.appendChild(btn);
  });

  /* ---- the whole row navigates -------------------------------------------
     Three testers out of three clicked the row rather than the route number:
     the hover highlight promises a target the size of the row, so the row is
     what has to respond.

     Delegated rather than per-row, because the body is rewritten on every sort,
     search and view change — a listener per row would have to be re-attached
     616 times a keystroke.

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

  /* Middle-click opens a new tab, the way a link does. Without this the row is
     a link that behaves like one only for left-handed clicks. */
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
        render();
      }, 120);
    });
    /* Enter on an unambiguous search goes straight to the route page — the
       fastest path to "how is my bus doing", which is the question the page
       exists to answer. */
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
