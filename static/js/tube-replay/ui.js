/* The interactive page: state, the play loop, and every control. Does nothing in
   render mode (#render=<clip>), where clip.js takes over.

   Two hosts. The self-contained page (replay.html) has every day built in and
   starts at once. The website (web.js) sets window.REPLAY_WEB, loads the list
   of days and the first day, then calls ReplayStart(); later days are fetched
   by window.ReplayLoadDay(key) before the page switches to them. */
window.ReplayStart = function () {
  if (/[#&]render=/.test(location.hash)) return;
  const M = window.ReplayModel, D = window.ReplayDraw, R = REPLAY;
  const load = window.ReplayLoadDay || (() => Promise.resolve());
  const $ = id => document.getElementById(id);
  const cv = $('c'), ctx = cv.getContext('2d'), tip = $('tip'), menu = $('menu');
  const readout = $('readout');      // the website shows train numbers here: no floating tooltips
  const N = R.stations.length, SPEEDS = [1, 10, 30, 60, 120], WHOLE = [-0.6, N - 0.4];
  const S = { dayKey: R.default_day, t: 4 * 3600, speed: 30, playing: false, ghost: 'wtt48', showEst: false,
              view: R.default_view.slice(), target: null, focus: null, tallyFrom: null, theme: 'dark' };
  let hits = [], last = 0, prevView = null, drag = null, hashDirty = true;

  function writeHash() {
    const p = new URLSearchParams();
    p.set('day', S.dayKey); p.set('t', String(Math.round(S.t)));
    p.set('x0', S.view[0].toFixed(2)); p.set('x1', S.view[1].toFixed(2));
    p.set('sp', String(S.speed)); p.set('g', S.ghost);
    if (S.showEst) p.set('est', '1');
    if (S.focus) p.set('f', S.focus.s + ',' + S.focus.d);
    history.replaceState(null, '', '#' + p.toString());
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.get('day') && R.days[p.get('day')]) S.dayKey = p.get('day');
    if (p.get('t')) S.t = Number(p.get('t'));
    if (p.get('x0') && p.get('x1')) S.view = M.clampView([Number(p.get('x0')), Number(p.get('x1'))], N);
    if (p.get('sp')) S.speed = Number(p.get('sp'));
    if (['wtt48', 'today', 'off'].includes(p.get('g'))) S.ghost = p.get('g');
    S.showEst = p.get('est') === '1';
    if (p.get('f')) { const [s, d] = p.get('f').split(',').map(Number); S.focus = { s, d }; }
    return p.has('day');
  }

  function resize() {
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(r.width * dpr)); cv.height = Math.max(1, Math.round(r.height * dpr));
  }
  function draw() {
    ctx.setTransform(cv.width / D.W, 0, 0, cv.height / D.H, 0, 0);
    hits = D.frame(ctx, R, Object.assign({}, S, { speedLabel: (S.playing ? '▶ ' : '❚❚ ') + S.speed + '× real time' }));
  }
  function drawState(st) {
    const w = cv.width, h = cv.height;
    cv.width = D.W; cv.height = D.H; ctx.setTransform(1, 0, 0, 1, 0, 0); D.frame(ctx, R, st);
    const url = cv.toDataURL('image/png'); cv.width = w; cv.height = h; return url;
  }
  function tick(now) {
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0; last = now;
    if (S.playing) { S.t = Math.min(S.t + dt * S.speed, 24 * 3600 - 1); hashDirty = true; }
    if (S.target) {
      const e = Math.min(1, dt * 6);
      S.view = [S.view[0] + (S.target[0] - S.view[0]) * e, S.view[1] + (S.target[1] - S.view[1]) * e];
      if (Math.abs(S.view[0] - S.target[0]) + Math.abs(S.view[1] - S.target[1]) < 0.003) { S.view = S.target; S.target = null; }
      hashDirty = true;
    }
    draw();
    requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------- pointer
  function logical(ev) { const r = cv.getBoundingClientRect(); return [(ev.clientX - r.left) / r.width * D.W, (ev.clientY - r.top) / r.height * D.H]; }
  const viewNow = () => S.target || S.view;
  function stationAt(x) { const v = viewNow(); return v[0] + (x - D.MAIN.x0) * (v[1] - v[0]) / (D.MAIN.x1 - D.MAIN.x0); }
  function stripStation(x) { return (x - D.STRIP.x0) / (D.STRIP.x1 - D.STRIP.x0) * (N - 1); }
  function region(x, y) {
    if (Math.abs(y - D.TL.y) < 28 && x >= D.TL.x0 - 10 && x <= D.TL.x1 + 10) return 'timeline';
    if (y > D.STRIP.nb - 30 && y < D.STRIP.sb + 30 && x >= D.STRIP.x0 - 20 && x <= D.STRIP.x1 + 20) return 'strip';
    if (y > D.MAIN.nb - 140 && y < D.MAIN.sb + 140) return 'main';
    return null;
  }
  function scrub(x) { S.t = D.TL.a + Math.max(0, Math.min(1, (x - D.TL.x0) / (D.TL.x1 - D.TL.x0))) * (D.TL.b - D.TL.a); hashDirty = true; }
  function centreOn(s) { const v = viewNow(), w = v[1] - v[0]; S.target = M.clampView([s - w / 2, s + w / 2], N); }
  function clickMain(x, y) {
    const s = Math.round(stationAt(x)); if (s < 0 || s >= N) return;
    const d = Math.abs(y - D.MAIN.nb) < 70 ? 1 : Math.abs(y - D.MAIN.sb) < 70 ? -1 : 0; if (!d) return;
    S.focus = S.focus && S.focus.s === s && S.focus.d === d ? null : { s, d }; S.tallyFrom = null; hashDirty = true;
  }
  function clickIncident(x) {
    for (const inc of R.days[S.dayKey].incidents) {
      if (Math.abs(D.tlx(inc[2], D.TL.a, D.TL.b) - x) < 12) {
        S.t = Math.max(0, inc[2] - 600); S.tallyFrom = S.t;
        S.target = M.clampView([Math.min(inc[4], inc[5]) - 1, Math.max(inc[4], inc[5]) + 1], N);
        S.focus = { s: inc[7], d: inc[1] }; hashDirty = true; return;
      }
    }
  }
  function hover(ev, x, y) {
    const h = hits.find(b => x >= b.x - 4 && x <= b.x + b.w + 4 && y >= b.y - 4 && y <= b.y + b.h + 4);
    if (readout) { readout.textContent = h ? 'Train ' + h.v : ''; return; }
    if (!h) { tip.style.display = 'none'; return; }
    const r = cv.getBoundingClientRect();
    tip.textContent = 'Train ' + h.v; tip.style.display = 'block';
    tip.style.left = (ev.clientX - r.left + 14) + 'px'; tip.style.top = (ev.clientY - r.top + 14) + 'px';
  }
  cv.addEventListener('wheel', ev => {
    const [x, y] = logical(ev); if (region(x, y) !== 'main') return;
    ev.preventDefault();
    const v = viewNow(), c = stationAt(x), f = Math.exp(ev.deltaY * 0.0015);
    S.target = M.clampView([c - (c - v[0]) * f, c + (v[1] - c) * f], N); hashDirty = true;
  }, { passive: false });
  cv.addEventListener('pointerdown', ev => {
    const [x, y] = logical(ev), reg = region(x, y); if (!reg) return;
    cv.setPointerCapture(ev.pointerId);
    drag = { reg, x0: x, view0: viewNow().slice(), moved: false };
    if (reg === 'timeline') scrub(x);
    if (reg === 'strip') centreOn(stripStation(x));
  });
  cv.addEventListener('pointermove', ev => {
    const [x, y] = logical(ev);
    if (!drag) { hover(ev, x, y); return; }
    if (Math.abs(x - drag.x0) > 4) drag.moved = true;
    if (drag.reg === 'timeline') scrub(x);
    else if (drag.reg === 'strip') centreOn(stripStation(x));
    else if (drag.reg === 'main') {
      const dv = -(x - drag.x0) * (drag.view0[1] - drag.view0[0]) / (D.MAIN.x1 - D.MAIN.x0);
      S.target = null; S.view = M.clampView([drag.view0[0] + dv, drag.view0[1] + dv], N); hashDirty = true;
    }
  });
  cv.addEventListener('pointerup', ev => {
    const [x, y] = logical(ev);
    if (drag && !drag.moved) { if (drag.reg === 'main') clickMain(x, y); if (drag.reg === 'timeline') clickIncident(x); }
    drag = null;
  });

  // ---------------------------------------------------------------- keys and buttons
  function toggleWhole() {
    const v = viewNow();
    if (v[1] - v[0] > N - 1) S.target = prevView || R.default_view.slice();
    else { prevView = v.slice(); S.target = WHOLE.slice(); }
    hashDirty = true;
  }
  document.addEventListener('keydown', ev => {
    if (ev.target.tagName === 'SELECT') return;
    if (ev.key === ' ') { ev.preventDefault(); S.playing = !S.playing; }
    else if (ev.key === 'ArrowRight') S.t = Math.min(S.t + (ev.shiftKey ? 600 : 60), 86399);
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
    const o = document.createElement('option'); o.value = k; o.textContent = R.days[k].label + (R.days[k].complete ? '' : ' (partial)'); daySel.appendChild(o);
  }
  daySel.onchange = () => {
    const k = daySel.value;
    load(k).then(() => { S.dayKey = k; hashDirty = true; }, () => { daySel.value = S.dayKey; });
  };
  $('ghost').onchange = () => { S.ghost = $('ghost').value; hashDirty = true; };
  $('est').onclick = () => { S.showEst = !S.showEst; hashDirty = true; };
  $('whole').onclick = toggleWhole;
  $('featured').onclick = () => { menu.style.display = menu.style.display === 'block' ? 'none' : 'block'; };
  $('fs').onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else $('stage').requestFullscreen(); };
  function syncBar() {
    $('play').textContent = S.playing ? '❚❚ Pause' : '▶ Play';
    document.querySelectorAll('[data-speed]').forEach(b => b.classList.toggle('on', Number(b.dataset.speed) === S.speed));
    daySel.value = S.dayKey; $('ghost').value = S.ghost; $('est').classList.toggle('on', S.showEst);
  }

  // ---------------------------------------------------------------- featured moments
  function loadClip(c) {
    return load(c.day).then(() => {
      S.dayKey = c.day; S.t = M.parseClock(c.start); S.speed = c.speed; S.ghost = c.ghost || 'wtt48';
      S.target = M.clampView([c.section_idx[0] - 0.6, c.section_idx[1] + 0.6], N);
      S.focus = c.focus_idx ? { s: c.focus_idx[0], d: c.focus_idx[1] } : null;
      S.tallyFrom = M.parseClock(c.tally_from || c.start); S.playing = true; hashDirty = true;
    });
  }
  function buildMenu() {
    const h = document.createElement('h2'); h.textContent = 'Featured moments'; menu.appendChild(h);
    let n = 0;
    for (const c of R.clips || []) {
      if (!R.days[c.day]) continue;
      const it = document.createElement('div'); it.className = 'item';
      const a = document.createElement('div'); a.textContent = c.title;
      const b = document.createElement('div'); b.className = 'sub'; b.textContent = c.subtitle || '';
      it.append(a, b); it.onclick = () => { loadClip(c); menu.style.display = 'none'; };
      menu.appendChild(it); n++;
    }
    const ex = document.createElement('div'); ex.className = 'item'; ex.textContent = 'Or explore any day: close this and pick a day below.';
    ex.onclick = () => { menu.style.display = 'none'; }; menu.appendChild(ex);
    return n;
  }

  // ---------------------------------------------------------------- start
  window.addEventListener('resize', resize);
  document.addEventListener('fullscreenchange', resize);
  const featured = buildMenu();
  const fromLink = readHash();
  if (!fromLink && featured) menu.style.display = 'block';
  setInterval(() => { if (hashDirty) { writeHash(); hashDirty = false; } syncBar(); }, 500);
  window.ReplayUI = { state: S, drawState, draw };
  Promise.all(['400 20px "DM Sans"', '700 20px "DM Sans"', '700 20px "Libre Baskerville"'].map(f => document.fonts.load(f)))
    .finally(() => { resize(); requestAnimationFrame(tick); });
};
if (!window.REPLAY_WEB) window.ReplayStart();
