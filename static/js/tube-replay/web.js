/* The replay on neilgarratt.com: loads index.json (stations, the list of days,
   clips) from <body data-replay-root>, then the first day, then starts the page
   (ui.js). Each later day, with WTT 48's ghosts for its day type, is fetched when
   it is chosen. Files are written by `lu_replay.py export`. Loaded before ui.js. */
window.REPLAY_WEB = true;
(function () {
  const body = document.body, root = body.dataset.replayRoot || 'data/', v = body.dataset.replayV || '';
  const note = document.getElementById('loadnote');
  const say = text => { if (note) { note.textContent = text; note.hidden = !text; } };

  async function get(name) {
    const r = await fetch(root + name + (v ? '?v=' + encodeURIComponent(v) : ''));
    if (!r.ok) throw new Error(name + ': HTTP ' + r.status);
    if (!name.endsWith('.gz')) return r.json();
    // A .gz file usually arrives as gzip bytes; a server that sets Content-Encoding
    // hands over plain JSON instead. Look at the first two bytes to tell.
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
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
      pending[key] = Promise.all([get('d/' + key + '.json.gz'),
                                  R.wtt48[day.wtt_key] ? null : get('w/' + day.wtt_key + '.json.gz')])
        .then(([d, w]) => { if (w) R.wtt48[day.wtt_key] = w; Object.assign(day, d); say(''); })
        .catch(e => { delete pending[key]; say('Could not load ' + day.long_label + '. ' + e.message); throw e; });
    }
    return pending[key];
  };

  say('Loading the replay…');
  get('index.json').then(async idx => {
    const R = window.REPLAY = Object.assign({}, idx, { days: {}, wtt48: {} });
    for (const d of idx.day_list) R.days[d.key] = Object.assign({}, d);
    const asked = new URLSearchParams(location.hash.slice(1)).get('day');
    const first = asked && R.days[asked] ? asked : idx.default_day;
    await window.ReplayLoadDay(first);
    R.default_day = first;
    window.ReplayStart();
  }).catch(e => say('The replay could not load. ' + e.message));
})();
