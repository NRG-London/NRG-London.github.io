/* The replay on neilgarratt.com: loads <line>/index.json (the line, its stations,
   the list of days, clips) from <body data-replay-root>, then the first day, then
   starts the page (ui.js). Each later day, with WTT 48's ghosts for its day type
   where the line has them, is fetched when it is chosen. The line comes from
   ?line= (or <body data-replay-line>). Files are written by `lu_replay.py export`
   (docs/replay-data-v2.md). Loaded before ui.js. */
window.REPLAY_WEB = true;
(function () {
  const FORMAT = 'ng-tube-replay', VERSION = 2;
  const body = document.body, base = body.dataset.replayRoot || 'data/', v = body.dataset.replayV || '';
  const line = (new URLSearchParams(location.search).get('line') || body.dataset.replayLine || 'bakerloo')
    .toLowerCase().replace(/[^a-z-]/g, '');
  const root = base + line + '/';
  const note = document.getElementById('loadnote');
  const say = text => { if (note) { note.textContent = text; note.hidden = !text; } };

  async function get(name, hash) {
    const q = hash ? 'h=' + hash : v ? 'v=' + encodeURIComponent(v) : '';
    const r = await fetch(root + name + (q ? '?' + q : ''));
    if (!r.ok) throw new Error(name + ': HTTP ' + r.status);
    if (!name.endsWith('.gz')) return r.json();
    // A .gz file usually arrives as gzip bytes; a server that sets Content-Encoding
    // hands over plain JSON instead. Look at the first two bytes to tell.
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (typeof DecompressionStream === 'undefined')
        throw new Error("This browser is too old to unpack the replay's files (it needs DecompressionStream).");
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      return JSON.parse(await new Response(stream).text());
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  const pending = {};
  window.ReplayLoadDay = function (key) {
    const R = window.REPLAY, day = R.days[key];
    if (!day) return Promise.reject(new Error('No such day: ' + key));
    if (day.trains) return Promise.resolve();
    if (!pending[key]) {
      say('Loading ' + day.long_label + '…');
      pending[key] = Promise.all([get('d/' + key + '.json.gz', day.h),
                                  !day.wtt_key || R.wtt48[day.wtt_key] ? null : get('w/' + day.wtt_key + '.json.gz')])
        .then(([d, w]) => {
          if (d.stations_sig !== R.stations_sig) throw new Error("its stations do not match the line's (reload the page)");
          if (w) R.wtt48[day.wtt_key] = w; Object.assign(day, d); say('');
        })
        .catch(e => { delete pending[key]; say('Could not load ' + day.long_label + '. ' + e.message); throw e; });
    }
    return pending[key];
  };

  // The line picker (<select id="line">, if the page has one): every line in lines.json.
  // Choosing one reloads the page for it; the day and moment start afresh.
  function linePicker(current) {
    const sel = document.getElementById('line');
    if (!sel) return;
    fetch(base + 'lines.json' + (v ? '?v=' + encodeURIComponent(v) : '')).then(r => r.ok ? r.json() : null).then(doc => {
      if (!doc || !doc.lines) return;
      sel.textContent = '';
      for (const l of doc.lines) {
        const o = document.createElement('option'); o.value = l.id; o.textContent = l.name + ' line';
        sel.appendChild(o);
      }
      sel.value = current;
      sel.hidden = doc.lines.length < 2;
      sel.onchange = () => { location.href = location.pathname + '?line=' + encodeURIComponent(sel.value); };
    }).catch(() => { /* no picker: the page still works for this line */ });
  }

  say('Loading the replay…');
  get('index.json').then(async idx => {
    if (idx.format !== FORMAT || idx.version !== VERSION)
      throw new Error('the data is in a format this page does not know (reload the page)');
    for (const el of document.querySelectorAll('[data-line-name]')) el.textContent = idx.line.name;
    // the line's first day, "15 October 2026" (lines are logged from different dates)
    const day0 = idx.day_list.length ? idx.day_list[0].long_label.replace(/^\S+ /, '') : '';
    for (const el of document.querySelectorAll('[data-line-first]')) if (day0) el.textContent = day0;
    linePicker(line);
    const R = window.REPLAY = Object.assign({}, idx, { days: {}, wtt48: {} });
    for (const d of idx.day_list) R.days[d.key] = Object.assign({}, d);
    const asked = new URLSearchParams(location.hash.slice(1)).get('day');
    const first = asked && R.days[asked] ? asked : idx.default_day;
    await window.ReplayLoadDay(first);
    R.default_day = first;
    window.ReplayStart();
  }).catch(e => say('The replay could not load. ' + e.message));
})();
