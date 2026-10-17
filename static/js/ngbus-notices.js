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

  /* ---- works announced ahead ------------------------------------------------ */

  // TfL books planned works' validity from the day it publishes the notice,
  // not the day the works start: route 100's Saturday-and-Sunday road closure
  // on 21-22 Nov is valid from 14 Sep. Its text says when ("from 21 Nov
  // 08:00", "From 0001 Saturday 24 October", "From 25/10 20:00"), so the
  // works' start is read from the first date in the text, when the words
  // before it make it a start (from, between, on...; not until, to). A date
  // counts only if it falls after the notice's first validity start and by its
  // last end, which also settles a year the text leaves out. Anything else is
  // null, and the notice reads as TfL's dates say.
  var MONTH = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  var WDAY = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  var WD = '(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*';
  var MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  var CLOCK = '(?:\\d{1,2}[:.]\\d{2}|\\d{4}|\\d{1,2}\\s*[ap]m)';
  // "(Friday) 23 / Saturday 24 October" (a night: the first), "5 August
  // (2026)", "25/10"; the weekday before the day is captured to check the year
  var DATE_SRC = '\\b(?:(' + WD + ')[,\\s]+)?(\\d{1,2})(?:st|nd|rd|th)?' +
    '(?:\\s*\\/\\s*(?:' + WD + '\\s+)?\\d{1,2}(?:st|nd|rd|th)?)?\\s+' + MON + '\\b(?:,?\\s+(\\d{4}))?' +
    '|\\b(\\d{1,2})\\/(\\d{1,2})\\b(?!\\/)';
  // what may stand between the keyword and the date: a time ("07:00 on")
  var LEAD_RE = new RegExp('(?:(' + CLOCK + ')\\s*,?\\s*(?:(?:on|at)\\s+)?)?(?:the\\s+)?$', 'i');
  var KEY_RE = /(from|between|starting|commencing|of|on|until|till|to|by|and|-|–|—)\s*$/i;
  var START_KEYS = { from: 1, between: 1, starting: 1, commencing: 1, of: 1, on: 1 };
  var AFTER_RE = new RegExp('^\\s*,?\\s*(?:at\\s+)?(' + CLOCK + ')', 'i');

  function clock(s) {
    if (!s) return [0, 0];
    var m = /^(\d{1,2})\s*([ap])m$/i.exec(s.trim());
    if (m) return [(+m[1] % 12) + (m[2].toLowerCase() === 'p' ? 12 : 0), 0];
    var d = s.replace(/[:.]/, '');
    return [+d.slice(0, d.length - 2), +d.slice(-2)];
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // When the works start, by the notice's text: ISO UTC, or null. The first
  // date with a keyword before it decides: a start, or (until, to) none. A
  // date with no keyword ("route 4 may be diverted") is passed over.
  function worksFrom(item) {
    if (item.atco != null || !item.text) return null;
    if (item._worksFrom !== undefined) return item._worksFrom;
    var out = null, text = String(item.text), re = new RegExp(DATE_SRC, 'gi'), m;
    var periods = (item.validity || []).filter(function (w) { return w[0]; });
    while (periods.length && (m = re.exec(text))) {
      var before = text.slice(Math.max(0, m.index - 60), m.index);
      var lead = LEAD_RE.exec(before);
      var key = KEY_RE.exec(before.slice(0, lead.index));
      if (!key) continue;
      if (START_KEYS[key[1].toLowerCase()]) out = fromMatch(m, lead[1], text, periods);
      break;
    }
    item._worksFrom = out;
    return out;
  }

  // The match as a time inside the notice's validity (after its first start,
  // by its last end), trying the years from the first start's on; or null.
  function fromMatch(m, leadClock, text, periods) {
    var wd = m[1] ? WDAY[m[1].slice(0, 3).toLowerCase()] : null;
    var day = +(m[2] || m[5]), month = m[3] ? MONTH[m[3].slice(0, 3).toLowerCase()] : +m[6];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    var after = AFTER_RE.exec(text.slice(m.index + m[0].length));
    var hm = clock(leadClock || (after && after[1]));
    if (hm[0] > 24 || hm[1] > 59) return null;
    var first = periods.map(function (w) { return w[0]; }).sort()[0];
    var last = periods.some(function (w) { return w[1] == null; }) ? null
      : periods.map(function (w) { return w[1]; }).sort().slice(-1)[0];
    var y0 = +first.slice(0, 4), years = m[4] ? [+m[4]] : [y0, y0 + 1];
    for (var i = 0; i < years.length; i++) {
      var d = years[i] + '-' + pad(month) + '-' + pad(day), noon = new Date(d + 'T12:00:00Z');
      if (noon.getUTCDate() !== day) continue;                     // 31 September
      if (wd != null && noon.getUTCDay() !== wd) continue;
      var t = londonISO(d, hm[0], hm[1]);
      if (t > first && (last == null || t <= last)) return t;
    }
    return null;
  }

  // Announced ahead of t: every one of TfL's dates starts after t, or the
  // text's works start does. The route page lists these as "Coming up".
  function ahead(item, t) {
    if (startsLater(item, t)) return true;
    var wf = worksFrom(item);
    return wf != null && wf > t;
  }

  // In force over [t0, t1) once the works had started: in force, but not
  // counting the time a notice was up ahead of its works. For the page's week,
  // the chart's and the replay's day marks, and the replay's panel.
  function inEffect(item, t0, t1) {
    if (ahead(item, t1)) return false;
    var wf = worksFrom(item);
    return inForce(item, wf != null && wf > t0 ? wf : t0, t1);
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
  // day at h:min, London time, as an ISO UTC string
  function londonISO(day, h, min) {
    var guess = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), h, min || 0);
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
    if (item.names && item.names.length > 1) return say(words, 'kind_closures');
    if (item.atco != null) return say(words, 'kind_closure');
    return say(words, { PlannedWork: 'kind_planned', RealTime: 'kind_unplanned',
                        Information: 'kind_information' }[item.category] || 'kind_information');
  }

  // One notice or closure as a list item. With opts.ahead (the route page's
  // "Coming up"), a start read from the text replaces TfL's dates, which run
  // from the day the notice went up.
  function itemHTML(words, item, t0, t1, opts) {
    var head = item.names && item.names.length > 1
      ? say(words, 'closures_head', { stops: item.names.join(', ') })
      : item.atco != null ? say(words, 'closure_head', { stop: item.name }) : '';
    var wf = opts && opts.ahead ? worksFrom(item) : null;
    var dates = wf ? say(words, 'starts', { from: when(wf) }) : datesText(words, item);
    var shown = shownText(words, item, t0, t1);
    var meta = [kindText(words, item), dates, shown].filter(Boolean).join(' \u00b7 ');
    return '<li class="ngn-item' + (item.category === 'RealTime' ? ' ngn-item--unplanned' : '') + '">' +
      (head ? '<div class="ngn-head">' + head + '</div>' : '') +
      '<div class="ngn-text">' + esc(item.text) + '</div>' +
      '<div class="ngn-meta">' + meta + '</div></li>';
  }

  // Closed stops that say the same thing, over the same dates, shown over the
  // same windows, as one item: a diversion shuts a run of stops at once, each
  // stop is two (a code per direction), and TfL sends each as its own row.
  // Its `names` lists each stop once, A to Z; everything else is the first
  // row's, which by the key is every row's. Notices pass through as they are,
  // and the order is kept (a merged item stands where its first row stood).
  function rollUp(words, items, t0, t1) {
    var out = [], at = {};
    items.forEach(function (it) {
      if (it.atco == null) { out.push(it); return; }
      var key = (it.text || '') + '|' + datesText(words, it) + '|' + shownText(words, it, t0, t1);
      var g = at[key];
      if (!g) {
        g = at[key] = Object.assign({}, it, { names: [] });
        out.push(g);
      }
      if (g.names.indexOf(it.name) === -1) g.names.push(it.name);
    });
    out.forEach(function (g) {
      if (g.names) g.names.sort(function (a, b) { return String(a).localeCompare(String(b)); });
    });
    return out;
  }

  var api = {
    ARCHIVE_FROM: ARCHIVE_FROM,
    dated: dated, windows: windows, inForce: inForce, showing: showing, startsLater: startsLater,
    worksFrom: worksFrom, ahead: ahead, inEffect: inEffect,
    serviceDay: serviceDay, londonISO: londonISO, iso: iso, addDays: addDays,
    load: load, say: say, html: html, esc: esc, itemHTML: itemHTML, rollUp: rollUp,
    datesText: datesText, shownText: shownText, hm: hm, dayLabel: dayLabel,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NgbusNotices = api;
})(typeof self !== 'undefined' ? self : this);
