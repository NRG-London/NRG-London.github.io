/* Touch and pointer gestures on the replay's line: the arithmetic only, so it can
   be tested without a browser. ui.js tracks the pointers and calls these.

   A gesture works on one axis, the line's: x in landscape, y in portrait. A
   position on that axis is given as a fraction of the drawn line, 0 at its
   start and 1 at its end, already flipped by the caller where the line runs
   backwards (portrait, outbound end at the top), so that a fraction f is the
   station view[0] + f * (view[1] - view[0]). */
(function (root) {
  const TAP_MOVE = 8;                 // CSS px a finger may wander and still tap
  const TAP_TIME = 600;               // ms

  /* Two fingers: the station under their midpoint stays under it, and the view
     widens or narrows with the distance between them. f0, f1: the midpoint at
     the start and now; d0, d1: the distance between the fingers then and now. */
  function pinchView(view0, f0, f1, d0, d1) {
    const w0 = view0[1] - view0[0], s = view0[0] + f0 * w0;
    const w1 = w0 * Math.max(0.05, d0) / Math.max(0.05, d1);
    const a = s - f1 * w1;
    return [a, a + w1];
  }

  /* One finger dragging the line: df, how far it moved as a fraction of the line. */
  function panView(view0, df) {
    const w = view0[1] - view0[0];
    return [view0[0] - df * w, view0[1] - df * w];
  }

  /* A wheel or trackpad step: zoom about the station at fraction f. */
  function zoomView(view, f, factor) {
    const w = view[1] - view[0], s = view[0] + f * w, w1 = w * factor;
    return [s - f * w1, s - f * w1 + w1];
  }

  /* The hit box nearest (x, y) within r, or null. Boxes: {x, y, w, h, ...}. */
  function tapTarget(hits, x, y, r) {
    let best = null, bd = Infinity;
    for (const b of hits || []) {
      const dx = Math.max(b.x - x, 0, x - (b.x + b.w)), dy = Math.max(b.y - y, 0, y - (b.y + b.h));
      const d = Math.hypot(dx, dy);
      if (d <= r && d < bd) { best = b; bd = d; }
    }
    return best;
  }

  /* Was a press a tap? down/up: {x, y, t} in CSS px and ms. A cancelled press never is. */
  function isTap(down, up, cancelled) {
    return !cancelled && Math.hypot(up.x - down.x, up.y - down.y) <= TAP_MOVE && up.t - down.t <= TAP_TIME;
  }

  /* House glide (cubic-bezier(0.65, 0, 0.35, 1), easeInOutCubic), 0..1 -> 0..1. */
  function ease(x) {
    x = Math.max(0, Math.min(1, x));
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  }

  const api = { TAP_MOVE, TAP_TIME, pinchView, panView, zoomView, tapTarget, isTap, ease };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ReplayGestures = api;
})(typeof window !== 'undefined' ? window : globalThis);
