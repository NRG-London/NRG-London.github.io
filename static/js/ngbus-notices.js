/* TfL bus notices for the bus pages: read, judge "in force", and write out.
 *
 * NRG-1 rebuilds n/<ROUTE>.json every hour from its archive of TfL's feeds
 * (E:\Road Data\platform\notices.py) and the replay's Worker serves it. One
 * file serves both the route page's box and the replay's panel. A route with
 * nothing to say has no file: a 404 is "no notices", never an error.
 *
 * "In force" here is notices.in_force() exactly, so the two pages and the
 * back end's checks agree: an item counts over TfL's validity periods, a
 * closure's own from-to, and the windows it was SEEN; and once it has stopped
 * showing, TfL's dates are cut at its last sighting (an edited notice is a
 * new id, a revised closure a new row, so the old dates would otherwise run on
 * beside the replacement). Spec: E:\Road Data\docs\superpowers\specs\
 * 2026-10-17-tfl-notices-design.md.
 *
 * Buses are the record; notices are the explanation. Nothing here may say a
 * route WAS diverted: only that a TfL notice was in force. TfL's text is shown
 * exactly as sent (Neil, 17 Oct), escaped for HTML and nothing more.
 *
 * No DOM except in the render helpers, so Node can test the rule against the
 * Python one (E:\Road Data\platform\tests\test_notices_js.py).
 */
(function (root) {
  'use strict';

  var TZ = 'Europe/London';
  /* TfL's notice feeds are archived from here; days before it show only the
     notices that were still in force then. */
  var ARCHIVE_FROM = '2026-10-15';

  /* ---- the rule ----------------------------------------------------------- */

  // TfL's dated periods for an item (validity, or a closure's from-to), cut
  // at the last sighting once it has stopped showing: notices._windows
  // without the seen windows.
  function dated(item) {
    var seen = item.seen || [];
    var out = (item.validity || []).map(function (w) { return [w[0], w[1]]; });
    if (item.atco != null) out.push([item.from, item.to]);
    var ends = seen.map(function (w) { return w[1]; });
    if (ends.length && ends.indexOf(null) === -1) {
      var last = ends.reduce(function (x, y) { return x > y ? x : y; });
      out = out.filter(function (w) { return !(w[0] && w[0] > last); })
        .map(function (w) { return [w[0], (w[1] != null && w[1] < last) ? w[1] : last]; });
    }
    return out;
  }

  // Every window an item counts in, as notices._windows: the dated periods
  // above, and when it showed. ISO "...Z" strings compare as times.
  function windows(item) {
    return dated(item).concat((item.seen || []).map(function (w) { return [w[0], w[1]]; }));
  }

  // notices.in_force: does any window overlap [t0, t1)?
  function inForce(item, t0, t1) {
    return windows(item).some(function (w) {
      return w[0] && w[0] < t1 && (w[1] == null || w[1] > t0);
    });
  }

  function showing(item) {
    return (item.seen || []).some(function (w) { return w[1] == null; });
  }

  // In force (TfL is showing it) but every one of TfL's dated periods starts
  // later: works announced ahead, for the route page's "Coming up". Under the
  // cut rule an item that has stopped showing keeps no future dates, so
  // anything still to come is necessarily one TfL is showing now.
  function startsLater(item, now) {
    var d = dated(item);
    return d.length > 0 && d.every(function (w) { return w[0] && w[0] > now; });
  }

  function iso(ms) { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

  // [03:00 on the day, 05:00 the next morning), London: the replay's service day.
  function serviceDay(day) {
    return [londonISO(day, 3), londonISO(addDays(day, 1), 5)];
  }
  function addDays(day, n) {
    var d = new Date(day + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  // day at hour h, London time, as an ISO UTC string
  function londonISO(day, h) {
    var guess = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), h);
    return iso(guess - londonOffsetMs(guess));
  }
  function londonOffsetMs(ms) {
    var p = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour12: false, year: 'numeric',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = +x.value; });
    return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
  }

  /* ---- loading ------------------------------------------------------------ */

  var cache = {};
  // {notices, closures} for a route, or null when it has none; rejects only
  // on a network failure, which the pages treat the same as none.
  function load(dataRoot, route) {
    var key = String(route).toUpperCase();
    if (!cache[key]) {
      cache[key] = fetch(dataRoot + 'n/' + encodeURIComponent(key) + '.json', { cache: 'no-cache' })
        .then(function (res) {
          if (res.status === 404) return null;
          if (!res.ok) throw new Error('notices: HTTP ' + res.status);
          return res.json();
        })
        .then(function (f) {
          if (!f || f.format !== 'ng-bus-notices-route') return null;
          return { notices: f.notices || [], closures: f.closures || [] };
        });
      cache[key].catch(function () { delete cache[key]; });
    }
    return cache[key];
  }

  /* ---- writing it out ------------------------------------------------------ */

  function esc(t) {
    return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // A line of wording from data/buswords.yaml (`notices`), slots filled.
  // **bold** as on the pages; values escaped.
  function say(words, k, v) {
    var t = esc(words[k] == null ? '' : words[k]).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    for (var n in (v || {})) t = t.split('{' + n + '}').join(v[n] && v[n].__html ? v[n].__html : esc(v[n]));
    return t;
  }
  function html(s) { return { __html: s }; }

  function fmt(isoStr, opts) {
    return new Date(isoStr).toLocaleString('en-GB', Object.assign({ timeZone: TZ }, opts));
  }
  function hm(isoStr) { return fmt(isoStr, { hour: '2-digit', minute: '2-digit', hour12: false }); }
  function dayLabel(isoStr) { return fmt(isoStr, { weekday: 'short', day: 'numeric', month: 'short' }); }

  // "20:00 Wed 21 Oct"
  function when(isoStr) { return hm(isoStr) + ' ' + dayLabel(isoStr); }

  // The dates line for an item: its TfL periods as this rule reads them, or
  // a closure's from-to; "until further notice" for an open end.
  function datesText(words, item) {
    return dated(item).map(function (w) {
      return w[1] ? say(words, 'dates', { from: when(w[0]), to: when(w[1]) })
                  : say(words, 'dates_open', { from: when(w[0]) });
    }).join('; ');
  }

  // When TfL showed it. Unclipped (the route page): "shown since 08:49 Thu 15
  // Oct" while it still shows, else its span. Clipped to a service day
  // [t0, t1) (the replay): "shown 07:52–21:40" for a window inside the day,
  // "shown from 07:52" for one running past the day's end, "shown all day".
  function shownText(words, item, t0, t1) {
    var parts = [];
    (item.seen || []).forEach(function (w) {
      var a = w[0], b = w[1];
      if (t0 && t1) {
        if ((b != null && b <= t0) || a >= t1) return;
        var start = a < t0, past = b == null || b >= t1;
        if (start && past) parts.push(say(words, 'shown_all_day'));
        else if (past) parts.push(say(words, 'shown_from', { from: hm(a) }));
        else if (start) parts.push(say(words, 'shown_until', { to: hm(b) }));
        else parts.push(say(words, 'shown_day', { from: hm(a), to: hm(b) }));
      } else if (b == null) {
        parts.push(say(words, 'shown_since', { from: when(a) }));
      } else {
        parts.push(say(words, 'shown_span', { from: when(a), to: when(b) }));
      }
    });
    return parts.join('; ');
  }

  function kindText(words, item) {
    if (item.atco != null) return say(words, 'kind_closure');
    return say(words, { PlannedWork: 'kind_planned', RealTime: 'kind_unplanned',
                        Information: 'kind_information' }[item.category] || 'kind_information');
  }

  // One notice or closure as a list item.
  function itemHTML(words, item, t0, t1) {
    var head = item.atco != null
      ? say(words, 'closure_head', { stop: item.name })
      : '';
    var dates = datesText(words, item), shown = shownText(words, item, t0, t1);
    var meta = [kindText(words, item), dates, shown].filter(Boolean).join(' \u00b7 ');
    return '<li class="ngn-item' + (item.category === 'RealTime' ? ' ngn-item--unplanned' : '') + '">' +
      (head ? '<div class="ngn-head">' + head + '</div>' : '') +
      '<div class="ngn-text">' + esc(item.text) + '</div>' +
      '<div class="ngn-meta">' + meta + '</div></li>';
  }

  var api = {
    ARCHIVE_FROM: ARCHIVE_FROM,
    dated: dated, windows: windows, inForce: inForce, showing: showing, startsLater: startsLater,
    serviceDay: serviceDay, londonISO: londonISO, iso: iso, addDays: addDays,
    load: load, say: say, html: html, esc: esc, itemHTML: itemHTML,
    datesText: datesText, shownText: shownText, hm: hm, dayLabel: dayLabel,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NgbusNotices = api;
})(typeof self !== 'undefined' ? self : this);
