/* Replay model: pure functions of the data and a moment; no drawing. Loaded by
   the page and by Node for tests. Times are seconds since the service day's
   03:00 local. Trains' points are [station, arrive, depart, direction, estimated]. */
(function (root) {
  const LAY = 1800;          // standing longer than this between points: out of service
  const EDGE = 120;          // drawn this long before its first point and after its last
  const GHOST_DWELL = 20;

  function lastIndexAtOrBefore(arr, t, key) {
    let lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((key ? key(arr[mid]) : arr[mid]) <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function trainAt(pts, t) {
    if (!pts.length) return null;
    const first = pts[0], last = pts[pts.length - 1];
    if (t < first[1] - EDGE || t > last[2] + EDGE) return null;
    if (t < first[1]) return { x: first[0], dir: first[3], est: !!first[4], standing: true };
    if (t > last[2]) return { x: last[0], dir: last[3], est: !!last[4], standing: true };
    const i = lastIndexAtOrBefore(pts, t, p => p[1]);
    const a = pts[i];
    if (t <= a[2]) return { x: a[0], dir: a[3], est: !!a[4], standing: true };
    const b = pts[i + 1];
    const gap = b[1] - a[2];
    if (gap > LAY) return null;
    const est = !!(a[4] || b[4]);
    if (a[0] === b[0]) return { x: a[0], dir: b[3], est, standing: true };
    return { x: a[0] + (b[0] - a[0]) * (t - a[2]) / Math.max(1, gap), dir: b[0] > a[0] ? 1 : -1, est, standing: false };
  }

  function trainsAt(trains, t) {
    const out = [];
    for (const tr of trains) {
      const p = trainAt(tr.pts, t);
      if (p) { if (tr.v !== undefined) p.v = tr.v; out.push(p); }
    }
    return out;
  }

  function departuresAt(rows, t) {
    const out = [];
    let k = lastIndexAtOrBefore(rows, t - 900, r => r[2]) + 1;
    for (; k < rows.length && rows[k][2] <= t + GHOST_DWELL; k++) {
      const [s, d, dep, run] = rows[k];
      if (t < dep - GHOST_DWELL || t >= dep + run) continue;
      out.push(t < dep ? { x: s, dir: d, standing: true } : { x: s + d * (t - dep) / Math.max(1, run), dir: d, standing: false });
    }
    return out;
  }

  function ghostsAt(day, ghost, wtt, t) {
    if (ghost === 'wtt48') return trainsAt(wtt.trains, t);
    if (ghost === 'today') return departuresAt(day.today, t);
    return [];
  }

  function blindBetween(blind, a, b) {
    let s = 0;
    for (const [x0, x1] of blind || []) s += Math.max(0, Math.min(b, x1) - Math.max(a, x0));
    return s;
  }
  function blindAt(blind, t) { return (blind || []).some(([x0, x1]) => t >= x0 && t < x1); }

  function waitAt(calls, t, blind) {
    if (!calls || !calls.length) return null;
    const i = lastIndexAtOrBefore(calls, t);
    if (i < 0) return null;
    return Math.max(0, t - calls[i] - blindBetween(blind, calls[i], t));
  }

  function gapsAround(tt, t) {                                // timetabled gaps within half an hour, sorted
    if (!tt || tt.length < 2) return null;
    const lo = lastIndexAtOrBefore(tt, t - 1800) + 1, hi = lastIndexAtOrBefore(tt, t + 1800);
    if (hi - lo < 1) return null;
    const gaps = [];
    for (let k = lo + 1; k <= hi; k++) gaps.push(tt[k] - tt[k - 1]);
    return gaps.sort((a, b) => a - b);
  }

  function intervalAt(tt, t) {
    const gaps = gapsAround(tt, t);
    if (!gaps) return null;
    const m = gaps.length >> 1;
    return gaps.length % 2 ? gaps[m] : (gaps[m - 1] + gaps[m]) / 2;
  }

  function longestGapAt(tt, t) {
    const gaps = gapsAround(tt, t);
    return gaps ? gaps[gaps.length - 1] : null;
  }

  function overdue(wait, interval) {
    if (wait == null || interval == null) return false;
    return wait >= Math.max(2 * interval, interval + 240);
  }

  // 0: within the timetable; 1: longer than any timetabled gap nearby (bold);
  // 2: overdue (amber). The longest gap, not the median, so an uneven timetable
  // (3, 3, 4 minutes) does not mark a train running to time.
  function waitLevel(wait, interval, longest) {
    if (overdue(wait, interval)) return 2;
    return wait != null && longest != null && wait > longest ? 1 : 0;
  }

  function tally(calls, tt, t0, t) {
    const n = arr => arr ? Math.max(0, lastIndexAtOrBefore(arr, t) - lastIndexAtOrBefore(arr, t0 - 1e-6)) : 0;
    return { ran: n(calls), timetabled: n(tt) };
  }

  function minuteValue(arr, t) { const i = Math.floor(t / 60); return arr && i >= 0 && i < arr.length ? arr[i] : null; }
  function hourValue(arr, t) { const i = Math.floor(t / 3600); return arr && i >= 0 && i < arr.length ? arr[i] : null; }

  function statusAt(status, t) {
    const i = lastIndexAtOrBefore(status || [], t, r => r[0]);
    return i < 0 ? { status: 'Good Service', reason: '' } : { status: status[i][2], reason: status[i][3] || '' };
  }

  const pad = n => String(n).padStart(2, '0');
  function clockText(t) { const m = Math.floor(t / 60) + 180; return pad(Math.floor(m / 60) % 24) + ':' + pad(m % 60); }
  function waitText(s) { return Math.floor(s / 60) + ':' + pad(Math.floor(s % 60)); }
  function parseClock(hhmm) {
    const [h, m, s] = String(hhmm).split(':').map(Number);
    return ((h < 3 ? h + 24 : h) - 3) * 3600 + m * 60 + (s || 0);
  }

  function clampView(v, n) {
    const lo = -0.6, hi = n - 0.4;
    let w = Math.min(hi - lo, Math.max(2.5, v[1] - v[0]));
    let c = (v[0] + v[1]) / 2, a = c - w / 2, b = c + w / 2;
    if (a < lo) { b += lo - a; a = lo; }
    if (b > hi) { a -= b - hi; b = hi; }
    return [a, b];
  }

  const api = { LAY, EDGE, lastIndexAtOrBefore, trainAt, trainsAt, departuresAt, ghostsAt, blindBetween, blindAt,
                waitAt, intervalAt, longestGapAt, overdue, waitLevel, tally, minuteValue, hourValue, statusAt, clockText, waitText, parseClock, clampView };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ReplayModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
