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

  function train(ctx, th, x, y, w, h, ghost, est, showEst, dir) {
    if (ghost) {
      ctx.save(); ctx.globalAlpha = th.ghostAlpha; ctx.setLineDash([8, 6]); ctx.lineWidth = 3; ctx.strokeStyle = th.ghost;
      rr(ctx, x - w / 2, y - h / 2, w, h, h / 4); ctx.stroke(); ctx.globalAlpha = 0.08; ctx.fillStyle = th.ghost; ctx.fill();
      ctx.restore(); return;
    }
    ctx.fillStyle = th.train; rr(ctx, x - w / 2, y - h / 2, w, h, h / 4); ctx.fill();
    ctx.save(); ctx.globalAlpha = 0.35; ctx.fillStyle = th.bg;                         // a window at the leading end
    rr(ctx, dir > 0 ? x + w / 2 - w * 0.2 : x - w / 2 + w * 0.08, y - h * 0.28, w * 0.12, h * 0.56, 2); ctx.fill(); ctx.restore();
    if (est && showEst) {
      ctx.save(); rr(ctx, x - w / 2, y - h / 2, w, h, h / 4); ctx.clip();
      ctx.strokeStyle = th.bg; ctx.globalAlpha = 0.55; ctx.lineWidth = 3;
      for (let k = -h; k < w; k += 9) { ctx.beginPath(); ctx.moveTo(x - w / 2 + k, y + h / 2); ctx.lineTo(x - w / 2 + k + h, y - h / 2); ctx.stroke(); }
      ctx.restore();
    }
  }

  function header(ctx, th, day, st) {
    ctx.textAlign = 'left'; ctx.fillStyle = th.sub; ctx.font = font(28, 500);
    ctx.fillText(('Bakerloo line · ' + day.long_label).toUpperCase(), 72, 70);
    ctx.fillStyle = th.text; ctx.font = font(92, 700); ctx.fillText(M.clockText(st.t), 68, 160);
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
    ctx.fillText('WTT 48 needs ' + (w48 == null ? '–' : w48), x + 260, y + 72);
    ctx.fillText("today's timetable about " + (td == null ? '–' : td), x + 260, y + 102);
  }

  function names(ctx, th, R, mp, s0, s1) {
    const mid = (MAIN.nb + MAIN.sb) / 2;
    ctx.fillStyle = th.text; ctx.textAlign = 'center';
    if (mp.k >= 120) {
      const fs = clamp(mp.k * 0.17, 18, 26); ctx.font = font(fs, 600);
      for (let s = s0; s <= s1; s++) {
        let lines = R.stations[s].lines;                 // too wide for the spacing: the short name instead
        if (Math.max(...lines.map(l => ctx.measureText(l).width)) > mp.k * 0.92) lines = [R.stations[s].short];
        lines.forEach((ln, k) => ctx.fillText(fit(ctx, ln, mp.k * 0.98), mp.x(s), mid + 8 + (k - (lines.length - 1) / 2) * fs * 1.15));
      }
    } else {
      const fs = clamp(mp.k * 0.3, 14, 20); ctx.font = font(fs, 600);
      for (let s = s0; s <= s1; s++) {
        ctx.save(); ctx.translate(mp.x(s), mid + 6); ctx.rotate(-0.7); ctx.fillText(R.stations[s].short, 0, 0); ctx.restore();
      }
    }
  }

  function focusTally(ctx, th, R, day, st, mp) {
    const key = st.focus.s + ',' + st.focus.d, g = st.ghost === 'today' ? 'today' : 'wtt48';
    const t0 = st.tallyFrom != null ? st.tallyFrom : Math.max(0, st.t - 3600);
    const tl = M.tally(day.calls[key], day.ghost_calls[g][key], t0, st.t);
    const a = R.stations[st.focus.s].name + (st.focus.d > 0 ? ' northbound' : ' southbound') + ' since ' + M.clockText(t0) + ': ';
    const b = tl.ran + ' of ' + tl.timetabled + ' timetabled' + (g === 'today' ? " (today's)" : ' (WTT 48)');
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
      train(ctx, th, x, y, tw, tht, false, tr.est, st.showEst, tr.dir);
      hits.push({ x: x - tw / 2, y: y - tht / 2, w: tw, h: tht, v: tr.v });
    }
    ctx.restore();
    names(ctx, th, R, mp, s0, s1);
    const g = st.ghost === 'today' ? 'today' : 'wtt48', timers = [];
    let best = null;
    for (let s = s0; s <= s1; s++) for (const d of [1, -1]) {
      const key = s + ',' + d, w = M.waitAt(day.calls[key], st.t, day.blind);
      if (w == null) continue;
      const tt = day.ghost_calls[g][key], iv = M.intervalAt(tt, st.t);
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
    ctx.fillText('Northbound ▶', 72, 352); ctx.fillText('◀ Southbound', 72, 812);
    if (st.focus) focusTally(ctx, th, R, day, st, mp);
  }

  function captionStrip(ctx, th, day, st) {
    let cap = st.caption;
    if (cap === undefined) {                                    // page: TfL's latest status change
      const i = M.lastIndexAtOrBefore(day.status, st.t, r => r[0]);
      cap = i < 0 ? null : { label: M.clockText(day.status[i][0]),
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
    const [a, b] = st.clipRange || [TL.a, TL.b];
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
    ctx.textAlign = 'left'; ctx.fillText(M.clockText(a), TL.x0, TL.y + 27);
    ctx.textAlign = 'center'; ctx.fillText(M.clockText((a + b) / 2), (TL.x0 + TL.x1) / 2, TL.y + 27);
    ctx.textAlign = 'right'; ctx.fillText(M.clockText(b), TL.x1, TL.y + 27);
  }

  function legend(ctx, th, st) {
    let x = 72; const y = 1042;
    ctx.textAlign = 'left'; ctx.font = font(18);
    ctx.fillStyle = th.train; rr(ctx, x, y - 14, 40, 16, 4); ctx.fill(); x += 52;
    ctx.fillStyle = th.text; ctx.fillText('Train that ran', x, y); x += ctx.measureText('Train that ran').width + 36;
    if (st.ghost !== 'off') {
      ctx.save(); ctx.globalAlpha = th.ghostAlpha; ctx.strokeStyle = th.ghost; ctx.setLineDash([6, 4]); ctx.lineWidth = 2;
      rr(ctx, x, y - 14, 40, 16, 4); ctx.stroke(); ctx.restore(); x += 52;
      const g = st.ghost === 'today' ? "Ghost: today's timetable (temporary; no working timetable published)"
                                     : 'Ghost: WTT 48, the last published working timetable';
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

  function frame(ctx, R, st) {
    const th = THEMES[st.theme || 'dark'], day = R.days[st.dayKey], wtt = R.wtt48[day.wtt_key], hits = [];
    ctx.save();
    ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
    header(ctx, th, day, st); strip(ctx, th, R, day, wtt, st); fleet(ctx, th, day, st.t);
    main(ctx, th, R, day, wtt, st, hits); captionStrip(ctx, th, day, st); timeline(ctx, th, day, st); legend(ctx, th, st);
    ctx.textAlign = 'left'; ctx.fillStyle = th.sub; ctx.font = font(16); ctx.fillText(SOURCE + estNote(day), 72, 1068);
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
    ctx.font = font(18); ctx.fillText(SOURCE + (day ? estNote(day) : ''), 140, 1000);
    ctx.restore();
  }

  root.ReplayDraw = { W, H, THEMES, MAIN, STRIP, TL, mapper, tlx, frame, card };
})(window);
