/* The TfL notices box on a bus route page (/bus/<route>/).
 *
 * The page is built once a week; notices change by the hour. So the box is
 * filled here, in the browser, from n/<ROUTE>.json (ngbus-notices.js), and a
 * notice that went up this morning is on the page this morning. With nothing
 * to show, or if the file cannot be had, the box stays hidden: an empty box
 * would read as "TfL says all is well", which is not ours to say.
 *
 * Four groups, in the order a reader needs them:
 *   In force now        what TfL is showing now (in force, not starting later)
 *   Since the week      in force after the week the figures cover, but not
 *                       now. The page is rebuilt weekly: without this, a
 *                       notice that came and went on a Wednesday would vanish
 *                       until the next rebuild put it in the week (Neil, 17 Oct)
 *   During the week     in force during the week the page's figures cover, but
 *                       not now: the likely explanation for those figures
 *   Coming up           shown now, but the works start later: every one of
 *                       TfL's dates does, or its text says so (TfL dates
 *                       planned works from the day the notice goes up)
 * The past groups count a notice only once its works had started.
 *
 * It also tells the chart which days had a notice in force, so its day view
 * can mark them (ngbus-chart.js listens for "ngbus:notice-days").
 */
(function () {
  'use strict';
  var N = window.NgbusNotices;
  var box = document.getElementById('ngbus-notices');
  if (!N || !box) return;
  var words = {};
  try { words = JSON.parse(document.getElementById('ngbus-notices-words').textContent); } catch (e) {}

  var root = box.getAttribute('data-root') || '';
  if (root && root.slice(-1) !== '/') root += '/';
  var route = box.getAttribute('data-route');
  var weekEnding = box.getAttribute('data-week-ending');      // a Saturday
  var chartDays = [];
  try { chartDays = JSON.parse(box.getAttribute('data-days') || '[]'); } catch (e) {}

  function weekLabel(iso) {
    return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB',
      { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  function group(heading, items, extraClass, opts) {
    if (!items.length) return '';
    return '<h3 class="ngn-group' + (extraClass || '') + '">' + heading + '</h3><ul class="ngn-list">' +
      N.rollUp(words, items).map(function (it) { return N.itemHTML(words, it, null, null, opts); }).join('') + '</ul>';
  }

  // TfL revises by replacing: an edited notice is a new notice, a closure
  // whose end moves is a new row. The one replaced has stopped showing, so it
  // would sit in a past group beside its replacement in "In force now" (the
  // 386, 15 Oct: the same diversion and the same eleven stops, twice). A past
  // item is left out when a current one is its revision: a closure at the same
  // stop from the same time, or a notice headed with the same place in TfL's
  // "DURSLEY ROAD, SE3:" style (a street in capitals, a comma, the area).
  var PLACE_RE = /^([A-Z0-9][A-Z0-9 '&.\/()-]+,[^:]{2,40}):/;
  function revisedBy(current) {
    var stops = {}, places = {};
    current.forEach(function (it) {
      if (it.atco != null) stops[it.atco + '|' + it.from] = true;
      else { var m = PLACE_RE.exec(it.text || ''); if (m) places[m[1]] = true; }
    });
    return function (it) {
      if (it.atco != null) return !!stops[it.atco + '|' + it.from];
      var m = PLACE_RE.exec(it.text || '');
      return !!(m && places[m[1]]);
    };
  }

  // When an item's works start, for "Coming up" (soonest first).
  function starts(it) {
    return N.worksFrom(it) || (N.dated(it).map(function (w) { return w[0]; }).sort()[0]) || it.created || '';
  }

  // Newest first within a group: the notice a reader came about is usually the latest.
  function newest(a, b) {
    var x = a.created || a.from || '', y = b.created || b.from || '';
    return x < y ? 1 : x > y ? -1 : 0;
  }

  N.load(root, route).then(function (f) {
    if (!f) return;
    var items = f.notices.concat(f.closures);
    var now = N.iso(Date.now());
    // a route with no figures yet has no week: only "now" and "Coming up"
    var weekFrom = weekEnding ? N.londonISO(N.addDays(weekEnding, -6), 0) : null;
    var weekTo = weekEnding ? N.londonISO(N.addDays(weekEnding, 1), 0) : null;

    var current = [], since = [], week = [], later = [];
    items.forEach(function (it) {
      if (N.inForce(it, now, now)) (N.ahead(it, now) ? later : current).push(it);
      else if (!weekEnding) return;
      else if (N.inEffect(it, weekFrom, weekTo)) week.push(it);
      else if (N.inEffect(it, weekTo, now)) since.push(it);
    });
    var revised = revisedBy(current.concat(later));
    since = since.filter(function (it) { return !revised(it); });
    week = week.filter(function (it) { return !revised(it); });
    current.sort(newest); since.sort(newest); week.sort(newest);
    later.sort(function (a, b) { return starts(a) < starts(b) ? -1 : starts(a) > starts(b) ? 1 : 0; });

    // The chart's day marks: every day of its daily span with a NOTICE in
    // force. Not closed stops: one stop shut for a month would mark every day
    // and the marks would stop meaning anything (spec: "days with a notice").
    var marked = {};
    chartDays.forEach(function (d) {
      var w = N.serviceDay(d);
      if (f.notices.some(function (it) { return N.inEffect(it, w[0], w[1]); })) marked[d] = true;
    });
    window.ngbusNoticeDays = marked;
    document.dispatchEvent(new CustomEvent('ngbus:notice-days', { detail: marked }));

    if (!current.length && !since.length && !week.length && !later.length) return;
    box.innerHTML =
      '<h2 class="ngn-title">' + N.say(words, 'title') + '</h2>' +
      group(N.say(words, 'now'), current) +
      (since.length ? group(N.say(words, 'since_week', { from: weekLabel(N.addDays(weekEnding, 1)) }), since) : '') +
      (week.length ? group(N.say(words, 'this_week', { week: weekLabel(weekEnding) }), week) : '') +
      group(N.say(words, 'coming_up'), later, ' ngn-group--later', { ahead: true }) +
      '<p class="ngn-source">' + N.say(words, 'source') + '</p>';
    box.hidden = false;
  }).catch(function () { /* no box: the page stands without it */ });
})();
