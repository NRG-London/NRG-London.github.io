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
 */
(function (root) {
  'use strict';

  var FORMAT = 'ng-bus-replay';
  var VERSION = 1;
  var M_PER_DEG = 111320;

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

  async function parse(buf) {
    var text;
    try {
      text = await bytesToText(buf);
    } catch (e) {
      if (e.name === 'ReplayError') throw e;
      throw ReplayError('That file is damaged or is not a bus replay file.');
    }
    var obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      throw ReplayError('That file is not a bus replay file.');
    }
    validate(obj);
    return obj;
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

  /* -> { segs: [{vi, t: Float64Array (s after t0), lon, lat, b: blind idx}],
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
        });
      });
    });
    return {
      segs: segs,
      vehicles: p.vehicles.map(function (v) { return { reg: v.reg }; }),
      points: points,
    };
  }

  /* Every vehicle's position at time t (seconds after t0). */
  function positionsAt(E, blinds, t) {
    var out = [], seen = {};
    for (var i = 0; i < E.segs.length; i++) {
      var s = E.segs[i];
      if (t < s.t0 || t > s.t1 || seen[s.vi]) continue;
      var lo = 0, hi = s.t.length - 1;
      while (hi - lo > 1) {
        var mid = (lo + hi) >> 1;
        if (s.t[mid] <= t) lo = mid; else hi = mid;
      }
      var span = s.t[hi] - s.t[lo];
      var f = span > 0 ? (t - s.t[lo]) / span : 0;
      var blind = blinds[s.b[lo]] || '?';
      seen[s.vi] = true;
      out.push({
        vi: s.vi, reg: E.vehicles[s.vi].reg, blind: blind,
        dead: blind.indexOf('(') !== -1,     // "(tuk London)" etc: depot run
        position: [s.lon[lo] + f * (s.lon[hi] - s.lon[lo]),
                   s.lat[lo] + f * (s.lat[hi] - s.lat[lo])],
      });
    }
    return out;
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

  function filename(route, iso) {
    return 'london-bus-replay_route-' + route + '_' + iso + '.json.gz';
  }

  var api = {
    FORMAT: FORMAT, VERSION: VERSION,
    parse: parse, validate: validate, expand: expand,
    positionsAt: positionsAt, inServiceByMinute: inServiceByMinute,
    filename: filename, isGzip: isGzip,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReplayData = api;
})(typeof self !== 'undefined' ? self : this);
