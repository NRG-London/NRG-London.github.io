/* The interactive page: state, the play loop, and every control. Does nothing in
   render mode (#render=<clip>), where clip.js takes over.

   Two hosts. The self-contained page (replay.html) has every day built in and
   starts at once. The website (web.js) sets window.REPLAY_WEB, loads the list
   of days and the first day, then calls ReplayStart(); later days are fetched
   by window.ReplayLoadDay(key) before the page switches to them.

   Any screen (layout.js): wider than tall, the 1920x1080 picture scaled evenly;
   an upright phone or tablet, the line drawn top to bottom. Mouse, touch and pen
   share one set of gestures (gestures.js): drag pans, two fingers pinch, the
   wheel or a trackpad pinch zooms, a tap names a train or counts a platform's
   trains. Camera moves glide (750 ms, the house curve), or jump if the reader
   asks for reduced motion. */
window.ReplayStart = function () {
  if (/[#&]render=/.test(location.hash)) return;
  const M = window.ReplayModel, D = window.ReplayDraw, G = window.ReplayGestures, LY = window.ReplayLayout, R = REPLAY;
  const load = window.ReplayLoadDay || (() => Promise.resolve());
  const $ = id => document.getElementById(id);
  const cv = $('c'), ctx = cv.getContext('2d'), tip = $('tip'), menu = $('menu'), stage = $('stage');
  const readout = $('readout');      // the website shows train numbers here: no floating tooltips
  const N = R.stations.length, SPEEDS = [1, 10, 30, 60, 120], WHOLE = LY.wholeView(N);
  const GHOSTS = (R.ghosts ? R.ghosts.available : ['wtt48', 'today']).concat('off');
  const GHOST0 = R.ghosts ? R.ghosts.default : 'wtt48';
  const reduced = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const S = { dayKey: R.default_day, t: 4 * 3600, speed: 30, playing: false, ghost: GHOST0,
              view: R.default_view.slice(), target: null, focus: null, tallyFrom: null, theme: 'dark' };
  let L = LY.layout(0, 0, N, R.portrait_top), hits = [], last = 0, prevView = null, hashDirty = true, glide = null;
  let viewFromLink = false, laidOut = false;

  function writeHash() {
    const p = new URLSearchParams();
    p.set('day', S.dayKey); p.set('t', String(Math.round(S.t)));
    p.set('x0', S.view[0].toFixed(2)); p.set('x1', S.view[1].toFixed(2));
    p.set('sp', String(S.speed)); p.set('g', S.ghost);
    if (S.focus) p.set('f', S.focus.s + ',' + S.focus.d);
    history.replaceState(null, '', location.pathname + location.search + '#' + p.toString());
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.get('day') && R.days[p.get('day')]) S.dayKey = p.get('day');
    if (p.get('t')) S.t = Number(p.get('t'));
    if (p.get('x0') && p.get('x1')) { S.view = M.clampView([Number(p.get('x0')), Number(p.get('x1'))], N); viewFromLink = true; }
    if (p.get('sp')) S.speed = Number(p.get('sp'));
    if (GHOSTS.includes(p.get('g'))) S.ghost = p.get('g');
    if (p.get('f')) { const [s, d] = p.get('f').split(',').map(Number); S.focus = { s, d }; }
    return p.has('day');
  }

  // ---------------------------------------------------------------- size and drawing
  // The canvas takes every gesture on it (touch-action: none, as a map does): a
  // pinch must never turn into a page scroll halfway. The page scrolls from the
  // controls and margins around it.
  function resize() {
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    L = LY.layout(r.width, r.height, N, R.portrait_top);
    cv.width = Math.max(1, Math.round(r.width * dpr)); cv.height = Math.max(1, Math.round(r.height * dpr));
    if (!laidOut && L.mode === 'portrait' && !viewFromLink) S.view = WHOLE.slice();
    laidOut = true;
    document.body.classList.toggle('portrait', L.mode === 'portrait');
  }
  function draw() {
    const dpr = cv.width / Math.max(1, L.cssW);
    const st = Object.assign({}, S, { speedLabel: (S.playing ? '▶ ' : '❚❚ ') + S.speed + '× real time' });
    if (L.mode === 'portrait') {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      hits = D.frame(ctx, R, st, L);
    } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = D.THEMES[S.theme].bg; ctx.fillRect(0, 0, cv.width, cv.height);
      const k = L.scale * dpr;
      ctx.setTransform(k, 0, 0, k, L.ox * dpr, L.oy * dpr);
      hits = D.frame(ctx, R, st);
    }
  }
  function drawState(st) {
    const w = cv.width, h = cv.height;
    cv.width = D.W; cv.height = D.H; ctx.setTransform(1, 0, 0, 1, 0, 0); D.frame(ctx, R, st);
    const url = cv.toDataURL('image/png'); cv.width = w; cv.height = h; return url;
  }
  const dayLen = () => R.days[S.dayKey].len || 24 * 3600;
  const tlRange = () => R.days[S.dayKey].timeline || [D.TL.a, D.TL.b];
  function tick(now) {
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0; last = now;
    if (S.playing) { S.t = Math.min(S.t + dt * S.speed, dayLen() - 1); hashDirty = true; }
    if (S.target) {                                   // the house glide: 750 ms, cubic-bezier(0.65, 0, 0.35, 1)
      if (!glide || glide.to !== S.target) glide = { from: S.view.slice(), to: S.target, t0: now };
      const e = reduced() ? 1 : G.ease((now - glide.t0) / 750);
      S.view = [glide.from[0] + (S.target[0] - glide.from[0]) * e, glide.from[1] + (S.target[1] - glide.from[1]) * e];
      if (e >= 1) { S.view = S.target; S.target = null; glide = null; }
      hashDirty = true;
    }
    draw();
    requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------- where a pointer is
  function css(ev) { const r = cv.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; }
  function logical(ev) {
    const [x, y] = css(ev);
    return L.mode === 'portrait' ? [x, y] : [(x - L.ox) / L.scale, (y - L.oy) / L.scale];
  }
  const viewNow = () => S.target || S.view;
  function axisFrac(x, y) {                           // how far along the drawn line, 0 at its start
    if (L.mode === 'portrait') { const f = (y - L.yA) / (L.yB - L.yA); return L.flip ? 1 - f : f; }
    return (x - D.MAIN.x0) / (D.MAIN.x1 - D.MAIN.x0);
  }
  function stationAt(x, y) { const v = viewNow(); return v[0] + axisFrac(x, y) * (v[1] - v[0]); }
  function stripStation(x) { return (x - D.STRIP.x0) / (D.STRIP.x1 - D.STRIP.x0) * (N - 1); }
  function region(x, y) {
    if (L.mode === 'portrait') {
      if (y > L.tl.y - 26 && y < L.H) return 'timeline';
      if (y >= L.yA - 24 && y <= L.yB + 24) return 'main';
      return null;
    }
    if (Math.abs(y - D.TL.y) < Math.max(28, L.touch) && x >= D.TL.x0 - 10 && x <= D.TL.x1 + 10) return 'timeline';
    if (y > D.STRIP.nb - 30 && y < D.STRIP.sb + 30 && x >= D.STRIP.x0 - 20 && x <= D.STRIP.x1 + 20) return 'strip';
    if (y > D.MAIN.nb - 140 && y < D.MAIN.sb + 140) return 'main';
    return null;
  }
  function scrub(x) {
    const [a, b] = tlRange(), x0 = L.mode === 'portrait' ? L.tl.x0 : D.TL.x0, x1 = L.mode === 'portrait' ? L.tl.x1 : D.TL.x1;
    S.t = a + Math.max(0, Math.min(1, (x - x0) / (x1 - x0))) * (b - a); hashDirty = true;
  }
  function centred(s) { const v = viewNow(), w = v[1] - v[0]; return M.clampView([s - w / 2, s + w / 2], N); }
  function timelineX(t) {
    if (L.mode !== 'portrait') return D.tlx(t, ...tlRange());
    const [a, b] = tlRange(), tl = L.tl;
    return tl.x0 + (Math.max(a, Math.min(b, t)) - a) / (b - a) * (tl.x1 - tl.x0);
  }

  // ---------------------------------------------------------------- what a tap or click does
  function clickMain(x, y) {
    const s = Math.round(stationAt(x, y)); if (s < 0 || s >= N) return;
    let d = 0;
    if (L.mode === 'portrait') {
      const reach = Math.max(30, (L.xOut - L.xIn) / 4);
      d = Math.abs(x - L.xOut) < reach ? 1 : Math.abs(x - L.xIn) < reach ? -1 : 0;
    } else d = Math.abs(y - D.MAIN.nb) < 70 ? 1 : Math.abs(y - D.MAIN.sb) < 70 ? -1 : 0;
    if (!d) return;
    S.focus = S.focus && S.focus.s === s && S.focus.d === d ? null : { s, d }; S.tallyFrom = null; hashDirty = true;
  }
  function clickIncident(x) {
    const reach = L.mode === 'portrait' ? L.touch : Math.max(12, L.touch);
    for (const inc of R.days[S.dayKey].incidents) {
      if (Math.abs(timelineX(inc[2]) - x) < reach) {
        S.t = Math.max(0, inc[2] - 600); S.tallyFrom = S.t;
        S.target = M.clampView([Math.min(inc[4], inc[5]) - 1, Math.max(inc[4], inc[5]) + 1], N);
        S.focus = { s: inc[7], d: inc[1] }; hashDirty = true; return true;
      }
    }
    return false;
  }
  function identify(h, ev) {
    if (readout) { readout.textContent = h ? 'Train ' + h.v : ''; return; }
    if (!h) { tip.style.display = 'none'; return; }
    const r = cv.getBoundingClientRect();
    tip.textContent = 'Train ' + h.v; tip.style.display = 'block';
    tip.style.left = (ev.clientX - r.left + 14) + 'px'; tip.style.top = (ev.clientY - r.top + 14) + 'px';
  }
  function hover(ev, x, y) {
    identify(hits.find(b => x >= b.x - 4 && x <= b.x + b.w + 4 && y >= b.y - 4 && y <= b.y + b.h + 4), ev);
  }
  function tap(ev, reg, x, y) {
    if (reg === 'main') {
      // a finger on a train names it (within 8 px: trains crowd the platforms on an upright
      // phone); anywhere else, or a mouse (which hovers for that), counts the platform's trains
      const h = ev.pointerType === 'mouse' ? null : G.tapTarget(hits, x, y, 8 / L.scale);
      if (h) { identify(h, ev); return; }
      clickMain(x, y);
    } else if (reg === 'timeline') {
      if (!clickIncident(x)) scrub(x);
    }
  }

  // ---------------------------------------------------------------- pointers: drag, pinch, tap
  const ptrs = new Map();
  let gest = null;
  function pair() {
    const [a, b] = [...ptrs.values()];
    return { f: axisFrac((a.x + b.x) / 2, (a.y + b.y) / 2), d: Math.hypot(a.cx - b.cx, a.cy - b.cy) };
  }
  cv.addEventListener('pointerdown', ev => {
    const [x, y] = logical(ev), [cx, cy] = css(ev);
    ptrs.set(ev.pointerId, { x, y, cx, cy });
    try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* the pointer has already gone */ }
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      if (region(a.x, a.y) === 'main' || region(b.x, b.y) === 'main') {
        const p = pair(); gest = { kind: 'pinch', view0: viewNow().slice(), f0: p.f, d0: p.d };
        S.target = null; glide = null;
      } else gest = { kind: 'done' };
      return;
    }
    if (ptrs.size > 2) { gest = { kind: 'done' }; return; }
    const reg = region(x, y);
    if (!reg) { gest = null; return; }
    gest = { kind: 'drag', reg, down: { x: cx, y: cy, t: ev.timeStamp }, view0: viewNow().slice(), f0: axisFrac(x, y), moved: false };
    if (reg === 'timeline') scrub(x);
    if (reg === 'strip') { S.target = null; S.view = centred(stripStation(x)); hashDirty = true; }
    if (reg === 'main') { S.target = null; glide = null; }
  });
  cv.addEventListener('pointermove', ev => {
    const [x, y] = logical(ev), [cx, cy] = css(ev);
    if (!ptrs.has(ev.pointerId)) { if (ev.pointerType === 'mouse') hover(ev, x, y); return; }
    ptrs.set(ev.pointerId, { x, y, cx, cy });
    if (!gest) return;
    if (gest.kind === 'pinch' && ptrs.size >= 2) {
      const p = pair();
      S.view = M.clampView(G.pinchView(gest.view0, gest.f0, p.f, gest.d0, p.d), N); hashDirty = true;
      return;
    }
    if (gest.kind !== 'drag') return;
    if (Math.hypot(cx - gest.down.x, cy - gest.down.y) > G.TAP_MOVE) gest.moved = true;
    if (gest.reg === 'timeline') scrub(x);
    else if (gest.reg === 'strip') { S.view = centred(stripStation(x)); hashDirty = true; }
    else if (gest.reg === 'main' && gest.moved) {
      S.view = M.clampView(G.panView(gest.view0, axisFrac(x, y) - gest.f0), N); hashDirty = true;
    }
  });
  function endPointer(ev, cancelled) {
    if (!ptrs.has(ev.pointerId)) return;
    ptrs.delete(ev.pointerId);
    if (gest && gest.kind === 'drag' && ptrs.size === 0) {
      const [x, y] = logical(ev), [cx, cy] = css(ev);
      if (!gest.moved && G.isTap(gest.down, { x: cx, y: cy, t: ev.timeStamp }, cancelled)) tap(ev, gest.reg, x, y);
    } else if (gest && gest.kind === 'pinch' && ptrs.size === 1) gest = { kind: 'done' };   // one finger lifted: not a pan
    if (ptrs.size === 0) gest = null;
  }
  cv.addEventListener('pointerup', ev => endPointer(ev, false));
  cv.addEventListener('pointercancel', ev => endPointer(ev, true));     // the browser took over (a page scroll)
  cv.addEventListener('wheel', ev => {
    const [x, y] = logical(ev); if (region(x, y) !== 'main') return;
    ev.preventDefault();
    // ctrl+wheel is how browsers report a trackpad pinch
    const f = Math.exp(ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015));
    S.target = null; glide = null;
    S.view = M.clampView(G.zoomView(S.view, axisFrac(x, y), f), N); hashDirty = true;
  }, { passive: false });

  // ---------------------------------------------------------------- keys and buttons
  function toggleWhole() {
    const v = viewNow();
    if (v[1] - v[0] > N - 1) S.target = prevView || (L.mode === 'portrait' ? M.clampView([v[0] + 3, v[1] - 3], N) : R.default_view.slice());
    else { prevView = v.slice(); S.target = WHOLE.slice(); }
    hashDirty = true;
  }
  document.addEventListener('keydown', ev => {
    if (ev.target.tagName === 'SELECT') return;
    if (ev.key === ' ') { ev.preventDefault(); S.playing = !S.playing; }
    else if (ev.key === 'ArrowRight') S.t = Math.min(S.t + (ev.shiftKey ? 600 : 60), dayLen() - 1);
    else if (ev.key === 'ArrowLeft') S.t = Math.max(S.t - (ev.shiftKey ? 600 : 60), 0);
    else if (ev.key === '+' || ev.key === '=') S.speed = SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(S.speed) + 1)];
    else if (ev.key === '-') S.speed = SPEEDS[Math.max(0, SPEEDS.indexOf(S.speed) - 1)];
    else if (ev.key === 'w') toggleWhole();
    else return;
    hashDirty = true;
  });
  $('play').onclick = () => { S.playing = !S.playing; };
  document.querySelectorAll('[data-speed]').forEach(b => { b.onclick = () => { S.speed = Number(b.dataset.speed); hashDirty = true; }; });
  const daySel = $('day');
  for (const k of Object.keys(R.days).sort()) {
    const dd = R.days[k], o = document.createElement('option'); o.value = k;
    o.textContent = dd.label + (dd.complete ? '' : ' (partial)') + (dd.quality === 'warn' ? ' *' : '');
    if (dd.note) o.title = dd.note;
    daySel.appendChild(o);
  }
  daySel.onchange = () => {
    const k = daySel.value;
    load(k).then(() => { S.dayKey = k; S.t = Math.min(S.t, dayLen() - 1); hashDirty = true; }, () => { daySel.value = S.dayKey; });
  };
  for (const o of [...$('ghost').options]) if (!GHOSTS.includes(o.value)) o.remove();
  // a line with no working timetable: its public timetable is not a stand-in for one
  if (!GHOSTS.includes('wtt48') && R.ghosts && R.ghosts.labels.today)
    for (const o of $('ghost').options) if (o.value === 'today') o.textContent = R.ghosts.labels.today;
  $('ghost').onchange = () => { S.ghost = $('ghost').value; hashDirty = true; };
  $('whole').onclick = toggleWhole;
  $('featured').onclick = () => { menu.style.display = menu.style.display === 'block' ? 'none' : 'block'; };
  // full screen where the browser allows it (not on an iPhone, which has no element full screen)
  const requestFS = stage.requestFullscreen || stage.webkitRequestFullscreen;
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  if (!requestFS) $('fs').hidden = true;
  $('fs').onclick = () => {
    if (fsElement()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else requestFS.call(stage);
  };
  function syncBar() {
    $('play').textContent = S.playing ? '❚❚ Pause' : '▶ Play';
    document.querySelectorAll('[data-speed]').forEach(b => b.classList.toggle('on', Number(b.dataset.speed) === S.speed));
    daySel.value = S.dayKey; $('ghost').value = S.ghost;
  }

  // ---------------------------------------------------------------- featured moments
  function loadClip(c) {
    return load(c.day).then(() => {
      const tz = R.days[c.day].tz;
      S.dayKey = c.day; S.t = M.parseClock(c.start, tz); S.speed = c.speed; S.ghost = GHOSTS.includes(c.ghost) ? c.ghost : GHOST0;
      S.target = M.clampView([c.section_idx[0] - 0.6, c.section_idx[1] + 0.6], N);
      S.focus = c.focus_idx ? { s: c.focus_idx[0], d: c.focus_idx[1] } : null;
      S.tallyFrom = M.parseClock(c.tally_from || c.start, tz); S.playing = true; hashDirty = true;
    });
  }
  function buildMenu() {
    const h = document.createElement('h2'); h.textContent = 'Featured moments'; menu.appendChild(h);
    let n = 0;
    for (const c of R.clips || []) {
      if (!R.days[c.day]) continue;
      const it = document.createElement('button'); it.type = 'button'; it.className = 'item';
      const a = document.createElement('div'); a.textContent = c.title;
      const b = document.createElement('div'); b.className = 'sub'; b.textContent = c.subtitle || '';
      it.append(a, b); it.onclick = () => { loadClip(c); menu.style.display = 'none'; };
      menu.appendChild(it); n++;
    }
    const ex = document.createElement('button'); ex.type = 'button'; ex.className = 'item';
    ex.textContent = 'Or explore any day: close this and pick a day below.';
    ex.onclick = () => { menu.style.display = 'none'; }; menu.appendChild(ex);
    return n;
  }

  // ---------------------------------------------------------------- start
  window.addEventListener('resize', resize);
  document.addEventListener('fullscreenchange', resize);
  document.addEventListener('webkitfullscreenchange', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(cv);
  // The featured moments open from their button only: the page starts on the line itself.
  $('featured').hidden = !buildMenu();
  readHash();
  // the line's colour for its trains, here as in the drawing (draw.js themeFor)
  if (R.line && R.line.colour) document.documentElement.style.setProperty('--train', R.line.colour);
  setInterval(() => { if (hashDirty) { writeHash(); hashDirty = false; } syncBar(); }, 500);
  window.ReplayUI = { state: S, drawState, draw, layout: () => L, hits: () => hits };
  Promise.all(['400 20px "DM Sans"', '700 20px "DM Sans"', '700 20px "Libre Baskerville"'].map(f => document.fonts.load(f)))
    .finally(() => { resize(); requestAnimationFrame(tick); });
};
if (!window.REPLAY_WEB) window.ReplayStart();
