/* The TfL notices box on a bus route page (/bus/<route>/).
 *
 * The page is built once a week; notices change by the hour. So the box is
 * filled here, in the browser, from n/<ROUTE>.json (ngbus-notices.js), and a
 * notice that went up this morning is on the page this morning. With nothing
 * to show, or if the file cannot be had, the box stays hidden: an empty box
 * would read as "TfL says all is well", which is not ours to say.
 *
 * Three groups, in the order a reader needs them:
 *   In force now        what TfL is showing now (in force, not starting later)
 *   During the week     in force during the week the page's figures cover, but
 *                       not now: the likely explanation for those figures
 *   Coming up           shown now, but every one of TfL's dates starts later
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

  function group(heading, items, extraClass) {
    if (!items.length) return '';
    return '<h3 class="ngn-group' + (extraClass || '') + '">' + heading + '</h3><ul class="ngn-list">' +
      items.map(function (it) { return N.itemHTML(words, it); }).join('') + '</ul>';
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
    var weekFrom = N.londonISO(N.addDays(weekEnding, -6), 0);
    var weekTo = N.londonISO(N.addDays(weekEnding, 1), 0);

    var current = [], later = [], week = [];
    items.forEach(function (it) {
      if (N.inForce(it, now, now)) (N.startsLater(it, now) ? later : current).push(it);
      else if (weekEnding && N.inForce(it, weekFrom, weekTo)) week.push(it);
    });
    current.sort(newest); week.sort(newest);
    later.sort(function (a, b) { return -newest(a, b); });     // soonest first

    // The chart's day marks: every day of its daily span with a NOTICE in
    // force. Not closed stops: one stop shut for a month would mark every day
    // and the marks would stop meaning anything (spec: "days with a notice").
    var marked = {};
    chartDays.forEach(function (d) {
      var w = N.serviceDay(d);
      if (f.notices.some(function (it) { return N.inForce(it, w[0], w[1]) && !N.startsLater(it, w[1]); })) marked[d] = true;
    });
    window.ngbusNoticeDays = marked;
    document.dispatchEvent(new CustomEvent('ngbus:notice-days', { detail: marked }));

    if (!current.length && !week.length && !later.length) return;
    box.innerHTML =
      '<h2 class="ngn-title">' + N.say(words, 'title') + '</h2>' +
      group(N.say(words, 'now'), current) +
      group(N.say(words, 'this_week', { week: weekLabel(weekEnding) }), week) +
      group(N.say(words, 'coming_up'), later, ' ngn-group--later') +
      '<p class="ngn-source">' + N.say(words, 'source') + '</p>';
    box.hidden = false;
  }).catch(function () { /* no box: the page stands without it */ });
})();
