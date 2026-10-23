/* A clip's timing: title card, body (piecewise speeds), end card; captions and
   camera. Pure; mirrored in analysis/clips.py for checking scripts. */
(function (root) {
  const M = (typeof module !== 'undefined' && module.exports) ? require('./model.js') : root.ReplayModel;
  const FPS = 30, TITLE = 3, END = 4, FADE = 0.5;

  function segmentsOf(clip) {
    const start = M.parseClock(clip.start), end = M.parseClock(clip.end);
    const slows = (clip.slow || []).map(s => [M.parseClock(s.from), M.parseClock(s.to), s.speed]).sort((a, b) => a[0] - b[0]);
    const out = []; let t = start;
    for (const [a, b, sp] of slows) {
      const a2 = Math.max(a, t), b2 = Math.min(b, end);
      if (b2 <= a2) continue;
      if (a2 > t) out.push([t, a2, clip.speed]);
      out.push([a2, b2, sp]); t = b2;
    }
    if (t < end) out.push([t, end, clip.speed]);
    return out;
  }
  function videoAt(segs, t) {
    let v = 0;
    for (const [a, b, sp] of segs) { if (t <= a) break; v += (Math.min(t, b) - a) / sp; }
    return v;
  }
  function replayAt(segs, v) {
    let acc = 0;
    for (const [a, b, sp] of segs) { const len = (b - a) / sp; if (v <= acc + len) return a + (v - acc) * sp; acc += len; }
    return segs.length ? segs[segs.length - 1][1] : 0;
  }
  function bodySeconds(segs) { return segs.reduce((s, [a, b, sp]) => s + (b - a) / sp, 0); }
  function frameCount(clip) { return Math.round((TITLE + bodySeconds(segmentsOf(clip)) + END) * FPS); }

  function frameAt(clip, n) {
    const segs = segmentsOf(clip), body = bodySeconds(segs), v = n / FPS;
    if (v < TITLE) return { phase: 'title', alpha: Math.min(1, (TITLE - v) / FADE) };
    if (v < TITLE + body) {
      const bv = v - TITLE;
      return { phase: 'body', t: replayAt(segs, bv), bv, progress: bv / body, alpha: Math.min(1, bv / FADE, (body - bv) / FADE) };
    }
    return { phase: 'end', t: M.parseClock(clip.end), alpha: Math.min(1, (v - TITLE - body) / FADE) };
  }

  function captionAt(clip, t) {
    let cur = null;
    for (const c of clip.captions || []) { const at = M.parseClock(c.at); if (at <= t && (!cur || at >= cur.at)) cur = { at, text: c.text, label: c.at }; }
    return cur;
  }

  function viewAt(clip, segs, bv) {
    const toView = si => [si[0] - 0.6, si[1] + 0.6];
    let view = toView(clip.section_idx);
    const keys = (clip.camera || []).map(k => ({ at: M.parseClock(k.at), view: toView(k.section_idx), glide: k.glide || 1.5 }))
      .sort((a, b) => a.at - b.at);
    for (const k of keys) {
      const kv = videoAt(segs, k.at);
      if (bv < kv) break;
      const f = Math.min(1, (bv - kv) / k.glide);
      const e = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
      view = [view[0] + (k.view[0] - view[0]) * e, view[1] + (k.view[1] - view[1]) * e];
    }
    return view;
  }

  const api = { FPS, TITLE, END, FADE, segmentsOf, videoAt, replayAt, bodySeconds, frameCount, frameAt, captionAt, viewAt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ReplayClipTime = api;
})(typeof window !== 'undefined' ? window : globalThis);
