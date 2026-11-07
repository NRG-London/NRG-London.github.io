/* Bus replay data: read, check and expand an `ng-bus-replay` v1 file.
 *
 * No DOM here, so the same code runs in the page and under Node (the tests
 * in E:\Road Data compare it with the Python reference decoder).
 *
 * The file stores raw pings, delta-encoded, plus for each pair of pings the
 * stretch of drawn road that joins them: br = [dj, k, a, b] — after ping j
 * (a delta from the previous bridge's j), drawn path k (k < 0: path -k-1,
 * travelled against its drawing direction), vertices a..b. Python decided
 * WHETHER and WHERE to snap (replay_route.bridge_range); this only fills the
 * vertices in and times them by distance from each ping's foot on the road.
 *
 * Times come back RELATIVE TO t0, in seconds. deck.gl's TripsLayer keeps
 * timestamps as float32, and epoch seconds (~1.8e9) in float32 are only good
 * to 128 s — the trails would step in two-minute jumps.
 *
 * Live mode (the Delay Replay pilot, Road Data spec 2026-11-06 §4.4) reads
 * two more files, an `ng-bus-live` head and recent file (parseLive), and
 * merges their per-route fragments into the day so far (mergeLive). The merge
 * must give exactly what Road Data's live_layers.merge_live gives; a Node test
 * there (tests/test_live_js.py) holds it to that. positionsAt's `hold` keeps a
 * bus at its last ping while it is still reported on the route.
 */
(function (root) {
  'use strict';

  var FORMAT = 'ng-bus-replay';
  var VERSION = 1;
  var M_PER_DEG = 111320;
  var LIVE_FORMAT = 'ng-bus-live';
  var LIVE_VERSION = 1;
  var LIVE_NEED = {                // each kind, and the keys the viewer reads from it
    head: ['generated', 'to', 'routes', 'days', 'r'],
    recent: ['from', 'to', 'routes'],
  };
  var GAP_SPLIT_S = 900;       // replay_core.GAP_SPLIT_S: a longer gap splits a track
  var EDGE_LAG_S = 30;         // Viewer Ruling 1: presence judged at the edge less this

  function ReplayError(message) {
    var e = new Error(message);
    e.name = 'ReplayError';
    return e;
  }

  /* ---- bytes -> object -------------------------------------------------- */

  function isGzip(u8) {
    return u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b;
  }

  // Some stores send Content-Encoding: gzip and the browser has already
  // unpacked the body; GitHub Pages and R2 (by default) send the raw .gz.
  // Sniff the magic bytes rather than trusting the URL.
  async function bytesToText(buf) {
    var u8 = new Uint8Array(buf);
    if (!isGzip(u8)) return new TextDecoder('utf-8').decode(u8);
    if (typeof DecompressionStream === 'undefined') {
      throw ReplayError('This browser cannot unpack the replay file ' +
                        '(no DecompressionStream). Try a current Chrome, ' +
                        'Edge, Firefox or Safari.');
    }
    var stream = new Blob([u8]).stream()
      .pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  }

  // Bytes -> a checked object: unpacked, parsed, then check(obj). damaged and
  // notJson are the messages for bytes that will not unpack or parse.
  async function readChecked(buf, damaged, notJson, check) {
    var text;
    try {
      text = await bytesToText(buf);
    } catch (e) {
      if (e.name === 'ReplayError') throw e;
      throw ReplayError(damaged);
    }
    var obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      throw ReplayError(notJson);
    }
    check(obj);
    return obj;
  }

  async function parse(buf) {
    return readChecked(buf, 'That file is damaged or is not a bus replay file.',
                       'That file is not a bus replay file.', validate);
  }

  function validate(p) {
    if (!p || typeof p !== 'object' || p.format !== FORMAT) {
      throw ReplayError('That file is not a bus replay file.');
    }
    if (p.version > VERSION) {
      throw ReplayError('That replay file was made by a newer version of ' +
                        'this page. Reload the page and try again.');
    }
    if (p.version !== VERSION) {
      throw ReplayError('That replay file is in an old format this page ' +
                        'no longer reads.');
    }
    var need = ['route', 'date', 't0', 't1', 'shapes', 'vehicles', 'blinds'];
    for (var i = 0; i < need.length; i++) {
      if (p[need[i]] === undefined) {
        throw ReplayError('That replay file is incomplete (no ' + need[i] + ').');
      }
    }
  }

  /* A live head or recent file (`ng-bus-live`), unpacked as parse unpacks a
     day file. The day-so-far files are ordinary v1 day files: use parse. */
  async function parseLive(buf) {
    return readChecked(buf, 'The live data is damaged or is not a live bus file.',
                       'The live data is not a live bus file.', validateLive);
  }

  function validateLive(p) {
    if (!p || typeof p !== 'object' || p.format !== LIVE_FORMAT) {
      throw ReplayError('The live data is not a live bus file.');
    }
    if (p.version > LIVE_VERSION) {
      throw ReplayError('The live data was made by a newer version of this ' +
                        'page. Reload the page and try again.');
    }
    if (p.version !== LIVE_VERSION) {
      throw ReplayError('The live data is in an old format this page no ' +
                        'longer reads.');
    }
    var need = Object.prototype.hasOwnProperty.call(LIVE_NEED, p.kind) ? LIVE_NEED[p.kind] : null;
    if (!need) {
      throw ReplayError('The live data is of a kind this page does not read (' +
                        p.kind + ').');
    }
    for (var i = 0; i < need.length; i++) {
      if (p[need[i]] == null) {
        throw ReplayError('The live data is incomplete (no ' + need[i] + ').');
      }
    }
  }

  /* ---- expansion -------------------------------------------------------- */

  function undelta(a) {
    var out = new Array(a.length), acc = 0;
    for (var i = 0; i < a.length; i++) { acc += a[i]; out[i] = acc; }
    return out;
  }

  // Metres from point p's foot on segment a->b to b, in a local flat metric.
  // The foot always lies on the segment beside the first (or last) inserted
  // vertex, so this reproduces Python's chainage without choosing a segment.
  function footGap(px, py, ax, ay, bx, by, kx) {
    var sx = (bx - ax) * kx, sy = by - ay;
    var vx = (px - ax) * kx, vy = py - ay;
    var L2 = sx * sx + sy * sy;
    var t = L2 === 0 ? 0 : Math.min(1, Math.max(0, (vx * sx + vy * sy) / L2));
    return Math.hypot((1 - t) * sx, (1 - t) * sy) * M_PER_DEG;
  }

  function dist(ax, ay, bx, by, kx) {
    return Math.hypot((bx - ax) * kx, by - ay) * M_PER_DEG;
  }

  /* -> { segs: [{vi, t: Float64Array (s after t0), lon, lat, b: blind idx,
   *              t0, t1, pt: the pings' own times (s after t0)}],
   *      vehicles: [{reg}], points } */
  function expand(p) {
    var shapes = p.shapes.map(function (s) { return s.path; });
    var segs = [], points = 0;
    p.vehicles.forEach(function (v, vi) {
      v.segs.forEach(function (s) {
        var t = undelta(s.t), x = undelta(s.x), y = undelta(s.y), bl = s.b;
        var bridges = {}, j = 0, br = s.br || [];
        for (var i = 0; i < br.length; i += 4) {
          j += br[i];
          bridges[j] = [br[i + 1], br[i + 2], br[i + 3]];
        }
        var ot = [], ox = [], oy = [], ob = [];
        for (var n = 0; n < t.length; n++) {
          var lon = x[n] / 1e5, lat = y[n] / 1e5;
          ot.push(t[n] - p.t0); ox.push(lon); oy.push(lat); ob.push(bl[n]);
          var B = bridges[n];
          if (!B || n + 1 >= t.length) continue;
          var k = B[0], a = B[1], b = B[2];
          var step = k >= 0 ? 1 : -1;
          var sh = shapes[k >= 0 ? k : -k - 1];
          if (!sh || !sh[a] || !sh[b]) continue;      // a bad file draws straight
          var lon2 = x[n + 1] / 1e5, lat2 = y[n + 1] / 1e5;
          var kx = Math.cos(lat * Math.PI / 180);
          var pa = a - step, pb = b + step;
          var d0 = (pa >= 0 && pa < sh.length)
            ? footGap(lon, lat, sh[pa][0], sh[pa][1], sh[a][0], sh[a][1], kx)
            : dist(lon, lat, sh[a][0], sh[a][1], kx);
          var d1 = (pb >= 0 && pb < sh.length)
            ? footGap(lon2, lat2, sh[pb][0], sh[pb][1], sh[b][0], sh[b][1], kx)
            : dist(lon2, lat2, sh[b][0], sh[b][1], kx);
          var idx = [];
          for (var q = a; step > 0 ? q <= b : q >= b; q += step) idx.push(q);
          var cum = [d0];
          for (var m = 1; m < idx.length; m++) {
            var P = sh[idx[m - 1]], Q = sh[idx[m]];
            cum.push(cum[m - 1] + dist(P[0], P[1], Q[0], Q[1], kx));
          }
          var total = (cum[cum.length - 1] + d1) || 1;
          var gap = t[n + 1] - t[n];
          for (m = 0; m < idx.length; m++) {
            var V = sh[idx[m]];
            ot.push(t[n] - p.t0 + gap * cum[m] / total);
            ox.push(V[0]); oy.push(V[1]); ob.push(bl[n]);
          }
        }
        points += ot.length;
        segs.push({
          vi: vi,
          t: Float64Array.from(ot),
          lon: Float64Array.from(ox),
          lat: Float64Array.from(oy),
          b: ob,
          t0: ot[0], t1: ot[ot.length - 1],
          pt: Float64Array.from(t, function (tp) { return tp - p.t0; }),
        });
      });
    });
    return {
      segs: segs,
      vehicles: p.vehicles.map(function (v) { return { reg: v.reg }; }),
      points: points,
    };
  }

  /* Every vehicle's position at time t (seconds after t0).
   *
   * hold (live day only; omit it for a finished day, which then draws exactly
   * as it always has): {seen: {reg: epoch}, t0: the epoch t is counted from,
   * maxGap: 900, edge: the newest head's `to` (optional)}. Past its last ping,
   * a bus is drawn AT that ping, never beyond it (spec §4.4), while
   *   - seen[reg] >= min(c, edge - 30), c = t0 + t: it was still reported on
   *     this route (with no edge, seen >= c). Every seen is earlier than
   *     server-now, so Latest (c = server-now) judges it at the edge; in
   *     Smooth c is well before the edge and this is seen >= c;
   *   - c - its last ping <= maxGap.
   * With a hold, each bus also says `held` and `age`, the seconds since its
   * last ping. */
  function positionsAt(E, blinds, t, hold) {
    var out = [], seen = {};
    for (var i = 0; i < E.segs.length; i++) {
      var s = E.segs[i];
      if (hold && t > s.t1 && !seen[s.vi] && lastSegOf(E, i)) {
        var h = heldAt(E, blinds, s, t, hold);
        if (h) { seen[s.vi] = true; out.push(h); }
        continue;
      }
      if (t < s.t0 || t > s.t1 || seen[s.vi]) continue;
      var lo = 0, hi = s.t.length - 1;
      while (hi - lo > 1) {
        var mid = (lo + hi) >> 1;
        if (s.t[mid] <= t) lo = mid; else hi = mid;
      }
      var span = s.t[hi] - s.t[lo];
      var f = span > 0 ? (t - s.t[lo]) / span : 0;
      seen[s.vi] = true;
      var bus = busRecord(E, blinds, s, lo,
                          [s.lon[lo] + f * (s.lon[hi] - s.lon[lo]),
                           s.lat[lo] + f * (s.lat[hi] - s.lat[lo])]);
      if (hold) { bus.held = false; bus.age = t - lastPingBy(s, t); }
      out.push(bus);
    }
    return out;
  }

  // What positionsAt says of one bus: s's vehicle under the blind of point
  // bi, at position.
  function busRecord(E, blinds, s, bi, position) {
    var blind = blinds[s.b[bi]] || '?';
    return {
      vi: s.vi, reg: E.vehicles[s.vi].reg, blind: blind,
      dead: blind.indexOf('(') !== -1,       // "(tuk London)" etc: depot run
      position: position,
    };
  }

  // Segments come vehicle by vehicle, each vehicle's in time order (expand
  // keeps the file's order, and build_route and mergeLive write it so).
  function lastSegOf(E, i) {
    return i + 1 === E.segs.length || E.segs[i + 1].vi !== E.segs[i].vi;
  }

  // The time of s's last ping at or before t (s.t0 <= t).
  function lastPingBy(s, t) {
    var pt = s.pt, lo = 0, hi = pt.length - 1;
    if (pt[hi] <= t) return pt[hi];
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (pt[mid] <= t) lo = mid; else hi = mid;
    }
    return pt[lo];
  }

  // The bus at s's last ping, if the hold keeps it there at t (> s.t1).
  function heldAt(E, blinds, s, t, hold) {
    var reg = E.vehicles[s.vi].reg;
    var age = t - s.t1;
    var maxGap = hold.maxGap != null ? hold.maxGap : GAP_SPLIT_S;
    if (age > maxGap) return null;
    var c = hold.t0 + t;
    var need = hold.edge != null ? Math.min(c, hold.edge - EDGE_LAG_S) : c;
    var sn = hold.seen && Object.prototype.hasOwnProperty.call(hold.seen, reg)
      ? hold.seen[reg] : null;
    if (sn == null || !(sn >= need)) return null;
    var n = s.t.length - 1;
    var bus = busRecord(E, blinds, s, n, [s.lon[n], s.lat[n]]);
    bus.held = true;
    bus.age = age;
    return bus;
  }

  /* Vehicles seen, per minute, across [0, t1-t0] — the timeline's shape. */
  function inServiceByMinute(E, span) {
    var n = Math.ceil(span / 60) + 1;
    var counts = new Uint16Array(n);
    var byVehicle = {};
    E.segs.forEach(function (s) {
      (byVehicle[s.vi] = byVehicle[s.vi] || []).push(s);
    });
    Object.keys(byVehicle).forEach(function (vi) {
      var mark = new Uint8Array(n);
      byVehicle[vi].forEach(function (s) {
        var a = Math.max(0, Math.floor(s.t0 / 60));
        var b = Math.min(n - 1, Math.floor(s.t1 / 60));
        for (var m = a; m <= b; m++) mark[m] = 1;
      });
      for (var m = 0; m < n; m++) counts[m] += mark[m];
    });
    return counts;
  }

  /* ---- live: the day so far plus the fragments -------------------------- */

  function delta(a) {
    var out = new Array(a.length);
    for (var i = 0; i < a.length; i++) out[i] = i ? a[i] - a[i - 1] : a[0];
    return out;
  }

  function orNull(v) { return v === undefined ? null : v; }

  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  // export_replay._merge: sorted, then overlapping or touching holes that
  // share kind and reason joined.
  function joinHoles(hs) {
    var out = [];
    hs.slice().sort(function (p, q) {
      return cmp(p[0], q[0]) || cmp(p[1], q[1]) || cmp(p[2], q[2]) || cmp(p[3], q[3]);
    }).forEach(function (h) {
      var last = out[out.length - 1];
      if (last && h[0] <= last[1] && last[2] === h[2] && last[3] === h[3]) {
        last[1] = Math.max(last[1], h[1]);
      } else {
        out.push([h[0], h[1], h[2], h[3]]);
      }
    });
    return out;
  }

  var LONDON = null;
  function londonDate(epoch) {           // the London date at epoch, YYYY-MM-DD
    LONDON = LONDON || new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit'});
    var d = {};
    LONDON.formatToParts(new Date(epoch * 1000)).forEach(function (x) { d[x.type] = x.value; });
    return d.year + '-' + d.month + '-' + d.day;
  }

  // The merge fails loudly, as merge_live does: a key it needs that is
  // missing, or an index past the end of its list, throws rather than
  // defaulting, because a bus quietly missing from the live day is worse than
  // no live day. Only what merge_live treats as optional is defaulted.
  function malformed(what) {
    return ReplayError('The live data is malformed (' + what + ').');
  }

  function list(v, what) {
    if (!Array.isArray(v)) throw malformed(what);
    return v;
  }

  // obj[key] when it is there (and then it must be a list); [] when it is
  // not, as Python's obj.get(key, []).
  function optList(obj, key, what) {
    return obj[key] === undefined ? [] : list(obj[key], what);
  }

  function hole(h, what) {
    if (!Array.isArray(h) || h.length !== 4) {
      throw malformed(what + ': a hole is not [a, b, kind, reason]');
    }
    return h;
  }

  // live_layers._decode: src's pings into pings, reg -> Map(t -> [x, y,
  // blind]) with x and y in 1e-5 degrees; and, when bridges is given, its
  // bridges into bridges, reg -> Map('t,t_next' -> [k, a, b]). The first copy
  // of each wins: copies are one report, so they agree. `blinds` is optional
  // (`src.get("blinds") or []`); vehicles, reg, segs, t, x, y and b are not,
  // nor is br when the bridges are kept (merge_live reads it only then).
  function decodeInto(src, pings, bridges, what) {
    var blinds = src.blinds || [];
    list(src.vehicles, what + ': no vehicles').forEach(function (v) {
      if (!v || v.reg === undefined) throw malformed(what + ': a bus with no reg');
      var name = what + ', ' + v.reg;
      var mine = pings.get(v.reg), mineBr = null;
      if (!mine) pings.set(v.reg, mine = new Map());
      if (bridges) {
        mineBr = bridges.get(v.reg);
        if (!mineBr) bridges.set(v.reg, mineBr = new Map());
      }
      list(v.segs, name + ': no segs').forEach(function (s) {
        var t = undelta(list(s.t, name + ': no t')), x = undelta(list(s.x, name + ': no x'));
        var y = undelta(list(s.y, name + ': no y')), b = list(s.b, name + ': no b');
        if (x.length !== t.length || y.length !== t.length || b.length !== t.length) {
          throw malformed(name + ': t, x, y and b differ in length');
        }
        for (var i = 0; i < t.length; i++) {
          if (!(Number.isInteger(b[i]) && b[i] >= 0 && b[i] < blinds.length)) {
            throw malformed(name + ': blind ' + b[i] + ' of ' + blinds.length);
          }
          if (!mine.has(t[i])) mine.set(t[i], [x[i], y[i], blinds[b[i]]]);
        }
        if (!mineBr) return;
        var br = list(s.br, name + ': no br'), j = 0;
        if (br.length % 4) throw malformed(name + ': br is not [dj, k, a, b] runs');
        for (var k = 0; k < br.length; k += 4) {
          j += br[k];
          if (!(j >= 0 && j + 1 < t.length)) throw malformed(name + ': a bridge past its pings');
          var key = t[j] + ',' + t[j + 1];
          if (!mineBr.has(key)) mineBr.set(key, [br[k + 1], br[k + 2], br[k + 3]]);
        }
      });
    });
  }

  /* The live day for route as one v1 payload, exactly as Road Data's
   * live_layers.merge_live builds it (read its docstring; this follows it
   * step for step):
   *   1. decode the day file, then each fragment (recent, then the head), and
   *      take the union of pings by (reg, t), the first copy winning;
   *   2. keep pings in [t0, t1), the service day's window;
   *   3. split each bus's pings at gaps over 900 s, and drop one-ping
   *      segments;
   *   4. keep the day file's bridges, and a fragment's only when its
   *      route_version equals the day file's route_version id; with no day
   *      file (day == null) no bridge at all, and shapes are the argument's;
   *   5. re-encode as build_route does: buses by registration, blinds in
   *      order of first use. t1 is the last ping (t0 if none). Holes are the
   *      day file's plus the fragments' clipped to [t0, t1), joined. All else
   *      the day file says is carried over, bar its stats.
   * Plus live.seen, {reg: the latest seen in the fragments}, for the hold.
   * Malformed input throws a ReplayError (see malformed above). */
  function mergeLive(day, fragments, route, t0, t1, shapes) {
    var pings = new Map(), bridges = new Map(), rv = null;
    list(fragments, 'the fragments are not a list');
    if (day != null) {
      if (day.shapes === undefined) throw malformed('the day file: no shapes');
      decodeInto(day, pings, bridges, 'the day file');
      rv = orNull((day.route_version || {}).id);
    }
    fragments.forEach(function (fr, n) {
      if (!fr || typeof fr !== 'object') throw malformed('fragment ' + n + ' is not an object');
      var same = day != null && orNull(fr.route_version) === rv;
      decodeInto(fr, pings, same ? bridges : null, 'fragment ' + n);
    });

    var regs = Array.from(pings.keys()).sort();
    var blinds = [], blindIx = new Map(), vehicles = [], last = t0;
    regs.forEach(function (reg) {
      var pts = [];
      pings.get(reg).forEach(function (p, t) {
        if (t0 <= t && t < t1) pts.push([t, p[0], p[1], p[2]]);
      });
      if (!pts.length) return;
      pts.sort(function (a, b) { return a[0] - b[0]; });
      var runs = [], run = [pts[0]];
      for (var i = 1; i < pts.length; i++) {
        if (pts[i][0] - run[run.length - 1][0] > GAP_SPLIT_S) { runs.push(run); run = []; }
        run.push(pts[i]);
      }
      runs.push(run);
      var regBr = bridges.get(reg), segs = [];
      runs.forEach(function (run) {
        if (run.length < 2) return;
        var ts = [], xs = [], ys = [], bl = [];
        run.forEach(function (p) {
          ts.push(p[0]); xs.push(p[1]); ys.push(p[2]);
          if (!blindIx.has(p[3])) { blindIx.set(p[3], blinds.length); blinds.push(p[3]); }
          bl.push(blindIx.get(p[3]));
        });
        var br = [], lastJ = 0;
        for (var j = 0; j < ts.length - 1; j++) {
          var hit = regBr && regBr.get(ts[j] + ',' + ts[j + 1]);
          if (hit) { br.push(j - lastJ, hit[0], hit[1], hit[2]); lastJ = j; }
        }
        segs.push({t: delta(ts), x: delta(xs), y: delta(ys), b: bl, br: br});
        last = Math.max(last, ts[ts.length - 1]);
      });
      if (segs.length) vehicles.push({reg: reg, segs: segs});
    });

    // holes are optional in both, as (day or {}).get("holes", []) and
    // fr.get("holes", []); each one present must be [a, b, kind, reason]
    var hs = (day != null ? optList(day, 'holes', 'the day file: holes is not a list') : [])
      .map(function (h) { return hole(h, 'the day file').slice(); });
    var seen = {};
    fragments.forEach(function (fr, n) {
      var what = 'fragment ' + n;
      optList(fr, 'holes', what + ': holes is not a list').forEach(function (h) {
        hole(h, what);
        if (h[0] < t1 && h[1] > t0) hs.push([Math.max(h[0], t0), Math.min(h[1], t1), h[2], h[3]]);
      });
      // merge_live never reads seen, but live_layers.fragment always writes
      // it: a bus without one would silently never be held
      fr.vehicles.forEach(function (v) {
        if (typeof v.seen !== 'number') throw malformed(what + ', ' + v.reg + ': no seen');
        if (!Object.prototype.hasOwnProperty.call(seen, v.reg) || v.seen > seen[v.reg]) {
          seen[v.reg] = v.seen;
        }
      });
    });

    var out = {};
    if (day != null) {
      Object.keys(day).forEach(function (k) { if (k !== 'stats') out[k] = day[k]; });
    }
    out.format = FORMAT;
    out.version = VERSION;
    out.route = route;
    out.date = londonDate(t0);
    out.t0 = t0;
    out.t1 = last;
    out.holes = joinHoles(hs);
    out.shapes = day != null ? day.shapes : shapes;
    out.stops = day != null && day.stops !== undefined ? day.stops : [];
    out.blinds = blinds;
    out.vehicles = vehicles;
    out.live = Object.assign({}, day != null ? day.live : null, {seen: seen});
    return out;
  }

  /* Each registration's colour slot. prior's are kept as they are, and a
     registration new to it takes the next slot, so a bus keeps its colour
     as others join the live day (its vi, its place in the payload, does
     not). prior is not changed. */
  function colourIndex(regs, prior) {
    var out = new Map(prior || []), next = 0;
    out.forEach(function (ix) { if (ix >= next) next = ix + 1; });
    for (var i = 0; i < regs.length; i++) {
      if (!out.has(regs[i])) out.set(regs[i], next++);
    }
    return out;
  }

  /* A registration as the plate shows it. BODS sends 'LY26ABC'; the plate
     reads 'LY26 ABC', and a route's buses are often registered as a block,
     so the letters after the space are what tell them apart. Current
     (LY26 ABC), prefix (E17 HCT), suffix (ABC 123D) and dateless (LTZ 1342,
     WLT 676, 593 CLT) formats; anything else is shown as sent. */
  var PLATES = [
    /^([A-Z]{2}\d{2})([A-Z]{3})$/,
    /^([A-Z]\d{1,3})([A-Z]{3})$/,
    /^([A-Z]{3})(\d{1,3}[A-Z])$/,
    /^([A-Z]{1,3})(\d{1,4})$/,
    /^(\d{1,4})([A-Z]{1,3})$/,
  ];

  function plate(reg) {
    var s = String(reg || '');
    for (var i = 0; i < PLATES.length; i++) {
      var m = PLATES[i].exec(s);
      if (m) return m[1] + ' ' + m[2];
    }
    return s;
  }

  function filename(route, iso) {
    return 'london-bus-replay_route-' + route + '_' + iso + '.json.gz';
  }

  var api = {
    FORMAT: FORMAT, VERSION: VERSION,
    parse: parse, validate: validate, expand: expand,
    positionsAt: positionsAt, inServiceByMinute: inServiceByMinute,
    filename: filename, isGzip: isGzip, plate: plate,
    LIVE_FORMAT: LIVE_FORMAT, LIVE_VERSION: LIVE_VERSION,
    parseLive: parseLive, validateLive: validateLive, mergeLive: mergeLive,
    colourIndex: colourIndex,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReplayData = api;
})(typeof self !== 'undefined' ? self : this);
