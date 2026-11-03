/* Draws one 1920x1080 frame of the replay on a canvas, and title/end cards. */
(function (root) {
  const M = root.ReplayModel;
  const W = 1920, H = 1080;
  const THEMES = {
    dark: { bg: '#1A2332', panel: '#243142', panelLine: '#3A4656', text: '#F3F6F4', sub: '#8A9490', track: '#3A4656',
            stnFill: '#1A2332', stnStroke: '#DDE3DF', train: '#4FA3E0', ghost: '#F3F6F4', ghostAlpha: 0.5,
            timer: '#8A9490', over: '#E0A24E', chip: '#E0A24E', chipText: '#1A2332', caption: '#0E1520', glow: true },
    light: { bg: '#F3F6F4', panel: '#FFFFFF', panelLine: '#DDE3DF', text: '#1A2332', sub: '#6B7570', track: '#B9C2BE',
             stnFill: '#FFFFFF', stnStroke: '#1A2332', train: '#0070BA', ghost: '#1A2332', ghostAlpha: 0.45,
             timer: '#8A9490', over: '#B5701E', chip: '#E0A24E', chipText: '#1A2332', caption: '#E2E8E4', glow: false },
  };
  const MAIN = { x0: 200, x1: 1740, nb: 470, sb: 700 };
  const STRIP = { x0: 300, x1: 1180, nb: 222, sb: 252 };
  const TL = { x0: 72, x1: 1848, y: 985, a: 7200, b: 79200 };          // 05:00 to 01:00
  const SOURCE = 'Source: TfL live arrivals feed, logged every 10 seconds; TfL Working Timetable 48 (Sep 2023); ' +
                 'TfL public timetable.';
  function estNote(day) {                                  // computed for the day, not typed
    const pc = Math.round(100 * (day && day.est_share || 0));
    return pc < 1 ? ' Under 1% of positions are estimated between sightings.'
                  : ' About ' + pc + '% of positions are estimated between sightings.';
  }
  const SANS = '"DM Sans", system-ui, sans-serif', SERIF = '"Libre Baskerville", Georgia, serif';
  const font = (px, w) => (w || 400) + ' ' + px + 'px ' + SANS;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
  function fit(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let s = text; while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s + '…';
  }
  function mapper(view) { const k = (MAIN.x1 - MAIN.x0) / (view[1] - view[0]); return { k, x: s => MAIN.x0 + (s - view[0]) * k }; }
  function tlx(t, a, b) { return TL.x0 + (clamp(t, a, b) - a) / (b - a) * (TL.x1 - TL.x0); }

  // Trains that ran, and what stands for them (the whole-line strip, the fleet
  // count, the timeline's progress, the legend), are in the line's own colour
  // (lines.py, in the data as line.colour); the theme's colour without one.
  function themeFor(R, theme) {
    const th = THEMES[theme || 'dark'], c = R && R.line && R.line.colour;
    return c ? Object.assign({}, th, { train: c }) : th;
  }

  function train(ctx, th, x, y, w, h, ghost, dir) {
    if (ghost) {
      ctx.save(); ctx.globalAlpha = th.ghostAlpha; ctx.setLineDash([8, 6]); ctx.lineWidth = 3; ctx.strokeStyle = th.ghost;
      rr(ctx, x - w / 2, y - h / 2, w, h, h / 4); ctx.stroke(); ctx.globalAlpha = 0.08; ctx.fillStyle = th.ghost; ctx.fill();
      ctx.restore(); return;
    }
    ctx.fillStyle = th.train; rr(ctx, x - w / 2, y - h / 2, w, h, h / 4); ctx.fill();
    ctx.save(); ctx.globalAlpha = 0.35; ctx.fillStyle = th.bg;                         // a window at the leading end
    rr(ctx, dir > 0 ? x + w / 2 - w * 0.2 : x - w / 2 + w * 0.08, y - h * 0.28, w * 0.12, h * 0.56, 2); ctx.fill(); ctx.restore();
  }

  const lineName = R => (R.line && R.line.name) || 'Bakerloo';
  const sourceOf = R => (R && R.line && R.line.source) || SOURCE;
  const dirLabel = (R, d) => (R.line && R.line.dir_labels ? R.line.dir_labels[d > 0 ? 0 : 1] : d > 0 ? 'Northbound' : 'Southbound');

  function header(ctx, th, R, day, st) {
    ctx.textAlign = 'left'; ctx.fillStyle = th.sub; ctx.font = font(28, 500);
    ctx.fillText((lineName(R) + ' line · ' + day.long_label).toUpperCase(), 72, 70);
    ctx.fillStyle = th.text; ctx.font = font(92, 700); ctx.fillText(M.clockText(st.t, day.tz), 68, 160);
    if (st.speedLabel) { ctx.fillStyle = th.sub; ctx.font = font(28); ctx.fillText(st.speedLabel, 370, 156); }
    const s = M.statusAt(day.status, st.t), good = s.status === 'Good Service';
    const text = 'TfL says: ' + s.status;
    ctx.font = font(30, 700);
    const w = clamp(ctx.measureText(text).width + 70, 420, 760), x = 1848 - w;
    rr(ctx, x, 86, w, 66, 33);
    if (good) { ctx.strokeStyle = th.chip; ctx.lineWidth = 3; ctx.stroke(); ctx.fillStyle = th.chip; }
    else { ctx.fillStyle = th.chip; ctx.fill(); ctx.fillStyle = th.chipText; }
    ctx.textAlign = 'center'; ctx.fillText(fit(ctx, text, w - 40), x + w / 2, 130);
    if (M.blindAt(day.blind, st.t)) {
      ctx.font = font(24, 700); const bw = 380, bx = x - bw - 20;
      rr(ctx, bx, 92, bw, 54, 27); ctx.fillStyle = th.panel; ctx.fill();
      ctx.fillStyle = th.text; ctx.fillText('No data logged', bx + bw / 2, 128);
    }
  }

  function strip(ctx, th, R, day, wtt, st) {
    const n = R.stations.length, px = s => STRIP.x0 + s * (STRIP.x1 - STRIP.x0) / (n - 1);
    ctx.fillStyle = th.sub; ctx.font = font(20, 500); ctx.textAlign = 'left'; ctx.fillText('WHOLE LINE', 72, 245);
    ctx.strokeStyle = th.track; ctx.lineWidth = 4; ctx.lineCap = 'round';
    for (const y of [STRIP.nb, STRIP.sb]) { ctx.beginPath(); ctx.moveTo(px(0) - 10, y); ctx.lineTo(px(n - 1) + 10, y); ctx.stroke(); }
    ctx.fillStyle = th.stnStroke;
    for (let s = 0; s < n; s++) for (const y of [STRIP.nb, STRIP.sb]) { ctx.beginPath(); ctx.arc(px(s), y, 2.5, 0, 7); ctx.fill(); }
    ctx.save(); ctx.globalAlpha = th.ghostAlpha; ctx.strokeStyle = th.ghost; ctx.lineWidth = 1.5;
    for (const g of M.ghostsAt(day, st.ghost, wtt, st.t)) ctx.strokeRect(px(g.x) - 6, (g.dir > 0 ? STRIP.nb : STRIP.sb) - 4, 12, 8);
    ctx.restore();
    ctx.fillStyle = th.train;
    for (const tr of M.trainsAt(day.trains, st.t)) ctx.fillRect(px(tr.x) - 6, (tr.dir > 0 ? STRIP.nb : STRIP.sb) - 4, 12, 8);
    const a = px(clamp(st.view[0], 0, n - 1)), b = px(clamp(st.view[1], 0, n - 1));
    ctx.strokeStyle = th.over; ctx.lineWidth = 2.5; rr(ctx, a - 8, STRIP.nb - 18, b - a + 16, STRIP.sb - STRIP.nb + 36, 8); ctx.stroke();
    ctx.fillStyle = th.sub; ctx.font = font(16); ctx.textAlign = 'center';
    for (const [s, lab] of R.landmarks) ctx.fillText(lab, px(s), STRIP.sb + 36);
  }

  function fleet(ctx, th, day, t) {
    const x = 1290, y = 186, w = 558, h = 120;
    rr(ctx, x, y, w, h, 14); ctx.fillStyle = th.panel; ctx.fill(); ctx.strokeStyle = th.panelLine; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.textAlign = 'left'; ctx.fillStyle = th.sub; ctx.font = font(20, 500); ctx.fillText('TRAINS IN SERVICE NOW', x + 26, y + 36);
    const a = M.minuteValue(day.in_service.actual, t), w48 = M.minuteValue(day.in_service.wtt48, t),
          td = M.hourValue(day.in_service.today_about, t);
    const big = a == null ? '–' : String(a);
    ctx.fillStyle = th.train; ctx.font = font(56, 700); ctx.fillText(big, x + 26, y + 98);
    const bw = ctx.measureText(big).width;
    ctx.fillStyle = th.text; ctx.font = font(22); ctx.fillText('running', x + 40 + bw, y + 96);
    ctx.fillStyle = th.sub;
    if (day.in_service.wtt48) ctx.fillText('WTT 48 needs ' + (w48 == null ? '–' : w48), x + 260, y + 72);
    if (day.in_service.today_about) ctx.fillText("today's timetable about " + (td == null ? '–' : td), x + 260, y + 102);
  }

  function names(ctx, th, R, mp, s0, s1) {
    const mid = (MAIN.nb + MAIN.sb) / 2;
    ctx.fillStyle = th.text; ctx.textAlign = 'center';
    if (mp.k >= 120) {
      const fs = clamp(mp.k * 0.17, 18, 26); ctx.font = font(fs, 600);
      for (let s = s0; s <= s1; s++) {
        let lines = R.stations[s].lines;                 // too wide for the spacing: the short name instead
        if (Math.max(...lines.map(l => ctx.measureText(l).width)) > mp.k * 0.92) lines = [R.stations[s].short];
        // a single word with no shorter form, still too wide ('Westminster', 'Bermondsey' on the
        // Jubilee): smaller type, not an ellipsis (names with a short form keep the clips' look)
        const w1 = lines.length === 1 && R.stations[s].short === R.stations[s].name ? ctx.measureText(lines[0]).width : 0;
        if (w1 > mp.k * 0.98) ctx.font = font(Math.max(14, fs * mp.k * 0.95 / w1), 600);   // a margin: widths round
        lines.forEach((ln, k) => ctx.fillText(fit(ctx, ln, mp.k * 0.98), mp.x(s), mid + 8 + (k - (lines.length - 1) / 2) * fs * 1.15));
        ctx.font = font(fs, 600);
      }
    } else {
      const fs = clamp(mp.k * 0.3, 14, 20); ctx.font = font(fs, 600);
      for (let s = s0; s <= s1; s++) {
        ctx.save(); ctx.translate(mp.x(s), mid + 6); ctx.rotate(-0.7); ctx.fillText(R.stations[s].short, 0, 0); ctx.restore();
      }
    }
  }

  function focusTally(ctx, th, R, day, st, mp) {
    const key = st.focus.s + ',' + st.focus.d, g = M.ghostKey(R, st.ghost);
    const t0 = st.tallyFrom != null ? st.tallyFrom : Math.max(0, st.t - 3600);
    const tl = M.tally(day.calls[key], (day.ghost_calls[g] || {})[key], t0, st.t);
    const a = R.stations[st.focus.s].name + ' ' + dirLabel(R, st.focus.d).toLowerCase() + ' since ' + M.clockText(t0, day.tz) + ': ';
    const b = tl.ran + ' of ' + tl.timetabled + ' timetabled';         // against the timetable chosen below
    ctx.font = font(22); const wa = ctx.measureText(a).width; ctx.font = font(22, 700); const wb = ctx.measureText(b).width;
    const w = wa + wb + 40, x = clamp(mp.x(st.focus.s) - w / 2, 260, 1848 - w), y = 826;
    rr(ctx, x, y, w, 44, 10); ctx.fillStyle = th.panel; ctx.fill();
    ctx.save(); ctx.globalAlpha = 0.7; ctx.strokeStyle = th.over; ctx.lineWidth = 2; ctx.stroke(); ctx.restore();
    ctx.textAlign = 'left'; ctx.fillStyle = th.text; ctx.font = font(22); ctx.fillText(a, x + 20, y + 30);
    ctx.fillStyle = th.over; ctx.font = font(22, 700); ctx.fillText(b, x + 20 + wa, y + 30);
    ctx.strokeStyle = th.over; ctx.lineWidth = 3; ctx.beginPath();
    ctx.arc(mp.x(st.focus.s), st.focus.d > 0 ? MAIN.nb : MAIN.sb, 24, 0, 7); ctx.stroke();
  }

  function main(ctx, th, R, day, wtt, st, hits) {
    const n = R.stations.length, mp = mapper(st.view);
    const tw = clamp(mp.k * 0.62, 26, 104), tht = clamp(tw * 0.36, 12, 38), r = clamp(tht * 0.4, 5, 15), tf = clamp(mp.k * 0.19, 15, 30);
    const s0 = Math.max(0, Math.floor(st.view[0])), s1 = Math.min(n - 1, Math.ceil(st.view[1]));
    ctx.save(); ctx.beginPath(); ctx.rect(MAIN.x0 - 90, 380, MAIN.x1 - MAIN.x0 + 180, 420); ctx.clip();
    ctx.strokeStyle = th.track; ctx.lineWidth = clamp(tht / 4, 4, 9); ctx.lineCap = 'round';
    for (const y of [MAIN.nb, MAIN.sb]) {
      ctx.beginPath(); ctx.moveTo(mp.x(Math.max(0, st.view[0] - 1)), y); ctx.lineTo(mp.x(Math.min(n - 1, st.view[1] + 1)), y); ctx.stroke();
    }
    for (const g of M.ghostsAt(day, st.ghost, wtt, st.t)) train(ctx, th, mp.x(g.x), g.dir > 0 ? MAIN.nb : MAIN.sb, tw, tht, true);
    for (let s = s0; s <= s1; s++) for (const y of [MAIN.nb, MAIN.sb]) {
      ctx.beginPath(); ctx.arc(mp.x(s), y, r, 0, 7); ctx.fillStyle = th.stnFill; ctx.fill();
      ctx.lineWidth = clamp(r / 2.5, 2, 5); ctx.strokeStyle = th.stnStroke; ctx.stroke();
    }
    for (const tr of M.trainsAt(day.trains, st.t)) {
      const x = mp.x(tr.x), y = tr.dir > 0 ? MAIN.nb : MAIN.sb;
      train(ctx, th, x, y, tw, tht, false, tr.dir);
      hits.push({ x: x - tw / 2, y: y - tht / 2, w: tw, h: tht, v: tr.v });
    }
    ctx.restore();
    names(ctx, th, R, mp, s0, s1);
    const g = M.ghostKey(R, st.ghost), gc = day.ghost_calls[g] || {}, timers = [];
    let best = null;
    for (let s = s0; s <= s1; s++) for (const d of [1, -1]) {
      const key = s + ',' + d, w = M.waitAt(day.calls[key], st.t, day.blind);
      if (w == null) continue;
      const tt = gc[key], iv = M.intervalAt(tt, st.t);
      if (iv == null && w > 1800) continue;                     // no service near now: no ever-growing timer
      const lv = M.waitLevel(w, iv, M.longestGapAt(tt, st.t)), od = lv === 2;
      timers.push({ s, d, w, od, late: lv === 1 });
      if (od && (!best || w > best.w)) best = { s, d, w };
    }
    ctx.textAlign = 'center';
    for (const tm of timers) {
      const big = best && tm.s === best.s && tm.d === best.d, size = tf * (big ? 1.6 : tm.od ? 1.2 : 1);
      ctx.font = font(size, tm.od || tm.late ? 700 : 500); ctx.fillStyle = tm.od ? th.over : tm.late ? th.text : th.timer;
      const y = tm.d > 0 ? MAIN.nb - tht / 2 - 18 : MAIN.sb + tht / 2 + size + 8;
      ctx.save(); if (tm.od && th.glow) { ctx.shadowColor = th.over; ctx.shadowBlur = big ? 22 : 12; }
      ctx.fillText(M.waitText(tm.w), mp.x(tm.s), y); ctx.restore();
    }
    ctx.textAlign = 'left'; ctx.fillStyle = th.sub; ctx.font = font(22);
    ctx.fillText(dirLabel(R, 1) + ' ▶', 72, 352); ctx.fillText('◀ ' + dirLabel(R, -1), 72, 812);
    if (st.focus) focusTally(ctx, th, R, day, st, mp);
  }

  function captionStrip(ctx, th, day, st) {
    let cap = st.caption;
    if (cap === undefined) {                                    // page: TfL's latest status change
      const i = M.lastIndexAtOrBefore(day.status, st.t, r => r[0]);
      cap = i < 0 ? null : { label: M.clockText(day.status[i][0], day.tz),
        text: 'TfL: ' + day.status[i][2] + (day.status[i][3] ? '. ' + day.status[i][3] : '') };
    }
    if (!cap) return;
    ctx.save(); ctx.globalAlpha = 0.94; ctx.fillStyle = th.caption; ctx.fillRect(0, 880, W, 70); ctx.restore();
    ctx.fillStyle = th.over; ctx.fillRect(0, 880, 10, 70);
    ctx.textAlign = 'left'; ctx.font = font(30, 700); const lab = cap.label ? cap.label + '  ' : '';
    ctx.fillText(lab, 48, 926); const lw = ctx.measureText(lab).width;
    ctx.font = font(30); ctx.fillStyle = th.text; ctx.fillText(fit(ctx, cap.text, W - 96 - lw), 48 + lw, 926);
  }

  function timeline(ctx, th, day, st) {
    const [a, b] = st.clipRange || day.timeline || [TL.a, TL.b];
    for (const [t0, t1, s] of day.status) {
      if (s === 'Good Service' || s === 'Service Closed' || t1 < a || t0 > b) continue;
      ctx.save(); ctx.globalAlpha = /Severe|Suspend|Closure/.test(s) ? 0.55 : 0.28; ctx.fillStyle = th.over;
      ctx.fillRect(tlx(t0, a, b), TL.y - 9, Math.max(2, tlx(t1, a, b) - tlx(t0, a, b)), 18); ctx.restore();
    }
    ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.strokeStyle = th.track; ctx.beginPath(); ctx.moveTo(TL.x0, TL.y); ctx.lineTo(TL.x1, TL.y); ctx.stroke();
    ctx.strokeStyle = th.train; ctx.beginPath(); ctx.moveTo(TL.x0, TL.y); ctx.lineTo(tlx(st.t, a, b), TL.y); ctx.stroke();
    if (!st.clipRange) for (const inc of day.incidents) { ctx.fillStyle = th.over; ctx.beginPath(); ctx.arc(tlx(inc[2], a, b), TL.y, 8, 0, 7); ctx.fill(); }
    ctx.fillStyle = th.text; ctx.beginPath(); ctx.arc(tlx(st.t, a, b), TL.y, 11, 0, 7); ctx.fill();
    ctx.fillStyle = th.sub; ctx.font = font(17);
    ctx.textAlign = 'left'; ctx.fillText(M.clockText(a, day.tz), TL.x0, TL.y + 27);
    ctx.textAlign = 'center'; ctx.fillText(M.clockText((a + b) / 2, day.tz), (TL.x0 + TL.x1) / 2, TL.y + 27);
    ctx.textAlign = 'right'; ctx.fillText(M.clockText(b, day.tz), TL.x1, TL.y + 27);
  }

  function legend(ctx, th, R, st) {
    let x = 72; const y = 1042;
    ctx.textAlign = 'left'; ctx.font = font(18);
    ctx.fillStyle = th.train; rr(ctx, x, y - 14, 40, 16, 4); ctx.fill(); x += 52;
    ctx.fillStyle = th.text; ctx.fillText('Train that ran', x, y); x += ctx.measureText('Train that ran').width + 36;
    if (st.ghost !== 'off') {
      ctx.save(); ctx.globalAlpha = th.ghostAlpha; ctx.strokeStyle = th.ghost; ctx.setLineDash([6, 4]); ctx.lineWidth = 2;
      rr(ctx, x, y - 14, 40, 16, 4); ctx.stroke(); ctx.restore(); x += 52;
      const labels = (R.ghosts && R.ghosts.labels) || {};
      const g = st.ghost === 'today' ? labels.today || "Ghost: today's timetable (temporary; no working timetable published)"
                                     : labels.wtt48 || 'Ghost: WTT 48, the last published working timetable';
      ctx.fillStyle = th.text; ctx.fillText(g, x, y); x += ctx.measureText(g).width + 36;
    }
    const say = (text, colour, weight) => {
      if (1848 - x < 30) return;
      ctx.fillStyle = colour; ctx.font = font(18, weight);
      const s = fit(ctx, text, 1848 - x); ctx.fillText(s, x, y); x += ctx.measureText(s).width;
    };
    say('Minutes since the last train: ', th.text, 400);
    say('4:10', th.text, 700); say(' longer than timetabled;  ', th.text, 400);
    say('12:34', th.over, 700); say(' at least twice the timetabled gap', th.text, 400);
  }

  // ---------------------------------------------------------------- portrait: an upright phone or tablet
  // The line runs top to bottom (layout.js): units are CSS pixels, outbound on the
  // right column, inbound on the left, names between, each timer outside its column.

  function pTrain(ctx, th, L, x, y, w, h, ghost, dir) {
    if (ghost) {
      ctx.save(); ctx.globalAlpha = th.ghostAlpha; ctx.setLineDash([5, 4]); ctx.lineWidth = 2; ctx.strokeStyle = th.ghost;
      rr(ctx, x - w / 2, y - h / 2, w, h, w / 4); ctx.stroke(); ctx.globalAlpha = 0.08; ctx.fillStyle = th.ghost; ctx.fill();
      ctx.restore(); return;
    }
    ctx.fillStyle = th.train; rr(ctx, x - w / 2, y - h / 2, w, h, w / 4); ctx.fill();
    const up = (dir > 0) === L.flip;                              // moving up the screen: the window at the top
    ctx.save(); ctx.globalAlpha = 0.35; ctx.fillStyle = th.bg;
    rr(ctx, x - w * 0.28, up ? y - h / 2 + h * 0.08 : y + h / 2 - h * 0.2, w * 0.56, h * 0.12, 2); ctx.fill(); ctx.restore();
  }

  function pHeader(ctx, th, R, day, st, L) {
    const W = L.W, p = L.pad;
    ctx.textAlign = 'left'; ctx.fillStyle = th.sub; ctx.font = font(L.fs(12), 600);
    ctx.fillText(fit(ctx, (lineName(R) + ' line · ' + day.long_label).toUpperCase(), W - 2 * p), p, 20);
    const clock = M.clockText(st.t, day.tz);
    ctx.fillStyle = th.text; ctx.font = font(40, 700); ctx.fillText(clock, p - 2, 62);
    const cw = ctx.measureText(clock).width;
    const s = M.statusAt(day.status, st.t), good = s.status === 'Good Service';
    ctx.font = font(L.fs(13), 700);
    const cwChip = Math.min(W - 2 * p - cw - 16, ctx.measureText(s.status).width + 28), cx = W - p - cwChip;
    rr(ctx, cx, 36, cwChip, 30, 15);
    if (good) { ctx.strokeStyle = th.chip; ctx.lineWidth = 2; ctx.stroke(); ctx.fillStyle = th.chip; }
    else { ctx.fillStyle = th.chip; ctx.fill(); ctx.fillStyle = th.chipText; }
    ctx.textAlign = 'center'; ctx.fillText(fit(ctx, s.status, cwChip - 16), cx + cwChip / 2, 56);
    if (st.speedLabel) {
      ctx.font = font(L.fs(12)); const sw = ctx.measureText(st.speedLabel).width;
      if (p + cw + 10 + sw < cx - 8) { ctx.textAlign = 'left'; ctx.fillStyle = th.sub; ctx.fillText(st.speedLabel, p + cw + 10, 60); }
    }
    // the fleet line, or a warning that nothing was logged
    ctx.textAlign = 'left'; ctx.font = font(L.fs(13));
    if (M.blindAt(day.blind, st.t)) { ctx.fillStyle = th.over; ctx.font = font(L.fs(13), 700); ctx.fillText('No data logged at this time', p, 88); }
    else {
      const a = M.minuteValue(day.in_service.actual, st.t), w48 = M.minuteValue(day.in_service.wtt48, st.t),
            td = M.hourValue(day.in_service.today_about, st.t);
      const n = v => (v == null ? '–' : v), long = [n(a) + ' trains running'], short = [n(a) + ' running'];
      if (day.in_service.wtt48) { long.push('WTT 48 needs ' + n(w48)); short.push('WTT 48 ' + n(w48)); }
      if (day.in_service.today_about) { long.push('timetable about ' + n(td)); short.push('timetable ' + n(td)); }
      let txt = long.join(' · ');
      if (ctx.measureText(txt).width > W - 2 * p) txt = short.join(' · ');      // a narrow phone
      ctx.fillStyle = th.text; ctx.fillText(fit(ctx, txt, W - 2 * p), p, 88);
    }
  }

  function pNames(ctx, th, R, L, mp, s0, s1) {
    const fs = L.fs(clamp(mp.k * 0.5, 12, 17)), every = mp.k >= fs * 1.25 ? 1 : 2, n = R.stations.length;
    ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.font = font(fs, 600);
    for (let s = s0; s <= s1; s++) {
      if (every > 1 && s % 2 && s !== 0 && s !== n - 1) continue;
      let name = R.stations[s].name;
      if (ctx.measureText(name).width > L.nameW) name = R.stations[s].short;
      ctx.fillText(fit(ctx, name, L.nameW), L.W / 2, mp.y(s) + fs * 0.35);
    }
  }

  function pTimers(ctx, th, R, day, st, L, mp, s0, s1, r) {
    const g = M.ghostKey(R, st.ghost), gc = day.ghost_calls[g] || {}, timers = [];
    let best = null;
    for (let s = s0; s <= s1; s++) for (const d of [1, -1]) {
      const key = s + ',' + d, w = M.waitAt(day.calls[key], st.t, day.blind);
      if (w == null) continue;
      const tt = gc[key], iv = M.intervalAt(tt, st.t);
      if (iv == null && w > 1800) continue;
      const lv = M.waitLevel(w, iv, M.longestGapAt(tt, st.t)), od = lv === 2;
      timers.push({ s, d, w, od, late: lv === 1 });
      if (od && (!best || w > best.w)) best = { s, d, w };
    }
    const tf = L.fs(clamp(mp.k * 0.45, 12, 15));
    for (const tm of timers) {
      const big = best && tm.s === best.s && tm.d === best.d, size = tf * (big ? 1.25 : 1);
      if (mp.k < size * 1.1 && !tm.od && !tm.late) continue;            // too tight: only the timers that matter
      ctx.font = font(size, tm.od || tm.late ? 700 : 500); ctx.fillStyle = tm.od ? th.over : tm.late ? th.text : th.timer;
      ctx.textAlign = tm.d > 0 ? 'left' : 'right';
      const x = tm.d > 0 ? L.xOut + r + 7 : L.xIn - r - 7;
      ctx.save(); if (tm.od && th.glow) { ctx.shadowColor = th.over; ctx.shadowBlur = big ? 14 : 8; }
      ctx.fillText(M.waitText(tm.w), x, mp.y(tm.s) + size * 0.35); ctx.restore();
    }
  }

  function pMain(ctx, th, R, day, wtt, st, L, hits) {
    const n = R.stations.length, mp = L.mapper(st.view);
    const len = clamp(mp.k * 0.7, 12, 56), wid = clamp(L.W * 0.024, 9, 22), r = clamp(mp.k * 0.14, 3, 8);
    const lo = Math.min(st.view[0], st.view[1]), hi = Math.max(st.view[0], st.view[1]);
    const s0 = Math.max(0, Math.floor(lo)), s1 = Math.min(n - 1, Math.ceil(hi));
    ctx.textAlign = 'left'; ctx.fillStyle = th.sub; ctx.font = font(L.fs(12), 500);
    ctx.fillText('↓ ' + dirLabel(R, -1), L.pad, L.yA - 18);
    ctx.textAlign = 'right'; ctx.fillText(dirLabel(R, 1) + ' ↑', L.W - L.pad, L.yA - 18);
    ctx.save(); ctx.beginPath(); ctx.rect(0, L.yA - 12, L.W, L.yB - L.yA + 24); ctx.clip();
    ctx.strokeStyle = th.track; ctx.lineWidth = clamp(wid / 4, 3, 6); ctx.lineCap = 'round';
    for (const d of [1, -1]) {
      ctx.beginPath(); ctx.moveTo(L.colX(d), mp.y(Math.max(0, lo - 1))); ctx.lineTo(L.colX(d), mp.y(Math.min(n - 1, hi + 1))); ctx.stroke();
    }
    for (const g of M.ghostsAt(day, st.ghost, wtt, st.t)) pTrain(ctx, th, L, L.colX(g.dir), mp.y(g.x), wid, len, true);
    for (let s = s0; s <= s1; s++) for (const d of [1, -1]) {
      ctx.beginPath(); ctx.arc(L.colX(d), mp.y(s), r, 0, 7); ctx.fillStyle = th.stnFill; ctx.fill();
      ctx.lineWidth = clamp(r / 2.5, 1.5, 3); ctx.strokeStyle = th.stnStroke; ctx.stroke();
    }
    for (const tr of M.trainsAt(day.trains, st.t)) {
      const x = L.colX(tr.dir), y = mp.y(tr.x);
      pTrain(ctx, th, L, x, y, wid, len, false, tr.dir);
      hits.push({ x: x - wid / 2, y: y - len / 2, w: wid, h: len, v: tr.v });
    }
    ctx.restore();
    pNames(ctx, th, R, L, mp, s0, s1);
    pTimers(ctx, th, R, day, st, L, mp, s0, s1, r);
    if (st.focus) {
      const key = st.focus.s + ',' + st.focus.d, g = M.ghostKey(R, st.ghost);
      const t0 = st.tallyFrom != null ? st.tallyFrom : Math.max(0, st.t - 3600);
      const tl = M.tally(day.calls[key], (day.ghost_calls[g] || {})[key], t0, st.t);
      ctx.strokeStyle = th.over; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(L.colX(st.focus.d), mp.y(st.focus.s), r + 7, 0, 7); ctx.stroke();
      const a = R.stations[st.focus.s].short + ' ' + dirLabel(R, st.focus.d).toLowerCase() + ' since ' + M.clockText(t0, day.tz) + ': ';
      const b = tl.ran + ' of ' + tl.timetabled + ' timetabled';
      ctx.textAlign = 'left'; ctx.font = font(L.fs(13)); const wa = ctx.measureText(a).width;
      ctx.fillStyle = th.text; ctx.fillText(fit(ctx, a, L.W - 2 * L.pad - 90), L.pad, 110);
      ctx.fillStyle = th.over; ctx.font = font(L.fs(13), 700); ctx.fillText(b, L.pad + Math.min(wa, L.W - 2 * L.pad - 90), 110);
    }
  }

  function pCaption(ctx, th, R, day, st, L) {
    const i = M.lastIndexAtOrBefore(day.status, st.t, r => r[0]);
    if (i < 0) return;
    const fs = L.fs(13), label = M.clockText(day.status[i][0], day.tz) + '  ';
    const text = 'TfL: ' + day.status[i][2] + (day.status[i][3] ? '. ' + day.status[i][3] : '');
    ctx.fillStyle = th.over; ctx.fillRect(0, L.capTop, 4, 40);
    ctx.textAlign = 'left'; ctx.font = font(fs, 700); ctx.fillText(label, L.pad, L.capTop + 15);
    const lw = ctx.measureText(label).width;
    ctx.font = font(fs); ctx.fillStyle = th.text;
    // two lines at most: the first beside the time, the rest under it
    const words = text.split(' '); let line = '', y = L.capTop + 15, x = L.pad + lw, maxW = L.W - L.pad - x, k = 0;
    for (; k < words.length; k++) {
      const t = line ? line + ' ' + words[k] : words[k];
      if (ctx.measureText(t).width > maxW && line) {
        if (y > L.capTop + 15) break;
        ctx.fillText(line, x, y); y += fs * 1.35; x = L.pad; maxW = L.W - 2 * L.pad; line = words[k];
      } else line = t;
    }
    ctx.fillText(fit(ctx, k < words.length ? line + ' ' + words.slice(k).join(' ') : line, maxW), x, y);
  }

  function pTimeline(ctx, th, day, st, L) {
    const tl = L.tl, [a, b] = day.timeline || [TL.a, TL.b];
    const px = t => tl.x0 + (clamp(t, a, b) - a) / (b - a) * (tl.x1 - tl.x0);
    for (const [t0, t1, s] of day.status) {
      if (s === 'Good Service' || s === 'Service Closed' || t1 < a || t0 > b) continue;
      ctx.save(); ctx.globalAlpha = /Severe|Suspend|Closure/.test(s) ? 0.55 : 0.28; ctx.fillStyle = th.over;
      ctx.fillRect(px(t0), tl.y - 7, Math.max(2, px(t1) - px(t0)), 14); ctx.restore();
    }
    ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.strokeStyle = th.track; ctx.beginPath(); ctx.moveTo(tl.x0, tl.y); ctx.lineTo(tl.x1, tl.y); ctx.stroke();
    ctx.strokeStyle = th.train; ctx.beginPath(); ctx.moveTo(tl.x0, tl.y); ctx.lineTo(px(st.t), tl.y); ctx.stroke();
    for (const inc of day.incidents) { ctx.fillStyle = th.over; ctx.beginPath(); ctx.arc(px(inc[2]), tl.y, 5, 0, 7); ctx.fill(); }
    ctx.fillStyle = th.text; ctx.beginPath(); ctx.arc(px(st.t), tl.y, 9, 0, 7); ctx.fill();
    ctx.fillStyle = th.sub; ctx.font = font(L.fs(12));
    ctx.textAlign = 'left'; ctx.fillText(M.clockText(a, day.tz), tl.x0, tl.y + 24);
    ctx.textAlign = 'center'; ctx.fillText(M.clockText((a + b) / 2, day.tz), (tl.x0 + tl.x1) / 2, tl.y + 24);
    ctx.textAlign = 'right'; ctx.fillText(M.clockText(b, day.tz), tl.x1, tl.y + 24);
  }

  function framePortrait(ctx, R, st, L) {
    const th = themeFor(R, st.theme), day = R.days[st.dayKey], wtt = R.wtt48[day.wtt_key], hits = [];
    ctx.save();
    ctx.fillStyle = th.bg; ctx.fillRect(0, 0, L.W, L.H);
    pHeader(ctx, th, R, day, st, L); pMain(ctx, th, R, day, wtt, st, L, hits);
    pCaption(ctx, th, R, day, st, L); pTimeline(ctx, th, day, st, L);
    ctx.restore();
    return hits;
  }

  // One frame. L: layout.js's layout for the canvas; without it (the clips, stills,
  // tests), the 1920x1080 landscape picture.
  function frame(ctx, R, st, L) {
    if (L && L.mode === 'portrait') return framePortrait(ctx, R, st, L);
    const th = themeFor(R, st.theme), day = R.days[st.dayKey], wtt = R.wtt48[day.wtt_key], hits = [];
    ctx.save();
    ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
    header(ctx, th, R, day, st); strip(ctx, th, R, day, wtt, st); fleet(ctx, th, day, st.t);
    main(ctx, th, R, day, wtt, st, hits); captionStrip(ctx, th, day, st); timeline(ctx, th, day, st); legend(ctx, th, R, st);
    ctx.textAlign = 'left'; ctx.fillStyle = th.sub; ctx.font = font(16); ctx.fillText(sourceOf(R) + estNote(day), 72, 1068);
    ctx.restore();
    return hits;
  }

  function wrap(ctx, text, x, y, maxW, lh) {
    let line = '';
    for (const w of String(text).split(' ')) {
      const t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && line) { ctx.fillText(line, x, y); y += lh; line = w; } else line = t;
    }
    if (line) { ctx.fillText(line, x, y); y += lh; }
    return y;
  }

  function card(ctx, theme, kicker, title, lines, day) {
    const th = THEMES[theme || 'dark'];
    ctx.save(); ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'left'; ctx.fillStyle = th.over; ctx.font = font(30, 700); ctx.fillText(String(kicker || '').toUpperCase(), 140, 360);
    ctx.fillStyle = th.text; ctx.font = '700 72px ' + SERIF; let y = wrap(ctx, title, 140, 460, 1640, 92) + 30;
    ctx.fillStyle = th.sub; ctx.font = font(36);
    for (const ln of lines || []) y = wrap(ctx, ln, 140, y, 1640, 52) + 14;
    ctx.font = font(18); ctx.fillText(sourceOf(root.REPLAY) + (day ? estNote(day) : ''), 140, 1000);
    ctx.restore();
  }

  root.ReplayDraw = { W, H, THEMES, MAIN, STRIP, TL, mapper, tlx, themeFor, frame, card };
})(window);
