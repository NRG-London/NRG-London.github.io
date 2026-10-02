/* Bus replay lab — one route, one day, every bus, from BODS positions.
 *
 * Data files are made by E:\Road Data\platform\prototypes\export_replay.py
 * (format `ng-bus-replay` v1; reading and expanding them is replay-data.js).
 * The page is otherwise the offline replay_template.html, moved onto the
 * site's vector basemap and taught to navigate, save and open files.
 *
 * Deep link: ?route=127&date=2026-07-22[&t=08:15][&speed=60]
 */
(function () {
  'use strict';

  var R = window.ReplayData;

  /* Where the data lives: the export_replay.py output directory, i.e.
     <root>/index.json and <root>/d/<ROUTE>/<YYYY-MM-DD>.json.gz. The lab
     serves a sample from the site itself; the production store (R2 or
     similar) is a change to this one line. */
  var DATA_ROOT = './';
  var DEFAULT_ROUTE = '60';

  var CARTO_KEY = 'cb1_2jwn_1_b719f4820b3d9fc06421d20e';
  var STYLES = {
    dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json?key=' + CARTO_KEY,
    street: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json?key=' + CARTO_KEY,
  };
  // Map brightness is a CSS filter on the basemap layer. Streets is a colour
  // map: dimmed and desaturated so the buses still lead. Dark can be pushed
  // past 100% — CARTO's dark style is low-contrast on some screens.
  var BRIGHT = { dark: 100, street: 70 };
  var SATURATE = { dark: 1, street: 0.7 };
  var TRAIL_S = 900;
  var TZ = 'Europe/London';

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    hud: $('hud'), title: $('title'), badge: $('badge'), route: $('route'),
    routes: $('routes'), prev: $('prev'), next: $('next'), daylabel: $('daylabel'),
    days: $('days'), clock: $('clock'), meta: $('meta'), timeline: $('timeline'),
    tl: $('tl'), slider: $('slider'), play: $('play'), speed: $('speed'),
    copylink: $('copylink'), save: $('save'), open: $('open'), file: $('file'),
    mapstyle: $('mapstyle'), mapbright: $('mapbright'), msg: $('msg'),
    banner: $('banner'), drop: $('drop'), collapse: $('collapse'),
  };

  var index = null;          // index.json
  var routeKey = {};         // UPPER -> key as stored
  var cur = null;            // {payload, bytes, E, source, routeChanged}
  var simT = 0;              // seconds after payload.t0
  var playing = true;
  var speed = 60;
  var lastFrame = performance.now();
  var counts = null;         // buses seen per minute (timeline)
  var tlBase = null;         // pre-drawn timeline, playhead added per frame
  var mapMode = 'dark';
  var staticLayers = [];
  var trips = [];
  var colors = [];

  /* ---- time, in London ---------------------------------------------------- */

  function fmtClock(epoch) {
    return new Date(epoch * 1000).toLocaleTimeString('en-GB', { timeZone: TZ, hour12: false });
  }
  function fmtHM(epoch) {
    return new Date(epoch * 1000).toLocaleTimeString('en-GB',
      { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' });
  }
  function fmtDay(iso, opts) {
    return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', Object.assign(
      { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }, opts || {}));
  }
  function londonOffset(epoch) {
    var parts = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour12: false, year: 'numeric',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(epoch * 1000))
      .forEach(function (p) { parts[p.type] = +p.value; });
    var asUTC = Date.UTC(parts.year, parts.month - 1, parts.day,
                         parts.hour % 24, parts.minute, parts.second) / 1000;
    return asUTC - epoch;
  }
  function londonEpoch(iso, h, m) {
    var guess = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), h, m) / 1000;
    return guess - londonOffset(guess);
  }
  function addDays(iso, n) {
    var d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /* ---- messages ----------------------------------------------------------- */

  function say(text, action) {
    el.msg.textContent = text || '';
    if (action) {
      var b = document.createElement('button');
      b.className = 'btn';
      b.textContent = action.label;
      b.onclick = action.run;
      el.msg.appendChild(b);
    }
  }

  /* ---- deck.gl + the passive vector basemap ------------------------------ */

  var LONDON = { longitude: -0.11, latitude: 51.48, zoom: 9.6, pitch: 0, bearing: 0 };

  var deckgl = new deck.DeckGL({
    container: 'map',
    /* map: false is NOT optional once maplibre-gl.js is on the page: deck
       otherwise builds its own styleless base map inside this container
       (see crime-hotspots for the full story). */
    map: false,
    initialViewState: LONDON,
    controller: true,
    getTooltip: function (info) {
      var o = info.object;
      if (!o) return null;
      if (o.reg) return { text: o.reg + '\nblind: ' + o.blind };
      if (o.name) return { text: o.name };
      return null;
    },
    onAfterRender: syncBasemap,
  });

  var base = null;
  function keyRequest(url) {
    // CARTO's style.json pulls tiles, glyphs and sprites from URLs that do
    // not carry the key; add it, so key enforcement does not blank the map.
    if (url.indexOf('cartocdn.com') === -1 || url.indexOf('key=') !== -1) return { url: url };
    return { url: url + (url.indexOf('?') === -1 ? '?' : '&') + 'key=' + CARTO_KEY };
  }
  function currentCam() {
    // getViewports() asserts before deck's first frame; before it, the
    // camera is whatever we asked for.
    try {
      var vp = deckgl.getViewports && deckgl.getViewports()[0];
      if (vp) return vp;
    } catch (e) { /* not drawn yet */ }
    return lastView || LONDON;
  }
  var lastCamKey = '';
  function syncBasemap() {
    if (!base) return;
    var vp = currentCam();
    var k = [vp.longitude, vp.latitude, vp.zoom, vp.pitch, vp.bearing].join(',');
    if (k === lastCamKey) return;
    lastCamKey = k;
    base.jumpTo({ center: [vp.longitude, vp.latitude], zoom: vp.zoom,
                  bearing: vp.bearing, pitch: vp.pitch });
  }
  function mountBasemap() {
    if (typeof maplibregl === 'undefined') {
      console.warn('replay: maplibre-gl.js did not load; plain dark ground');
      return;
    }
    if (base) { base.setStyle(STYLES[mapMode]); return; }
    var vp = currentCam();
    try {
      base = new maplibregl.Map({
        container: 'basemap', style: STYLES[mapMode],
        center: [vp.longitude, vp.latitude], zoom: vp.zoom,
        bearing: vp.bearing, pitch: vp.pitch,
        interactive: false, attributionControl: false,
        transformRequest: keyRequest,
      });
      base.on('error', function (e) {
        console.warn('replay basemap:', (e && e.error && e.error.message) || e);
      });
    } catch (e) {
      console.warn('replay: basemap failed to mount:', e && e.message);
      base = null;
    }
  }
  function applyBright() {
    var b = BRIGHT[mapMode] / 100, s = SATURATE[mapMode];
    document.getElementById('basemap').style.filter =
      (b === 1 && s === 1) ? '' : 'brightness(' + b + ') saturate(' + s + ')';
    el.mapbright.value = BRIGHT[mapMode];
  }

  var lastView = null;
  function fitTo(payload) {
    var minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
    function fit(p) {
      if (p[0] < minLon) minLon = p[0]; if (p[0] > maxLon) maxLon = p[0];
      if (p[1] < minLat) minLat = p[1]; if (p[1] > maxLat) maxLat = p[1];
    }
    payload.shapes.forEach(function (s) { s.path.forEach(fit); });
    if (minLon > maxLon) trips.forEach(function (t) { t.path.forEach(fit); });
    if (minLon > maxLon) return;
    var w = window.innerWidth, h = window.innerHeight;
    var wide = w >= 900;
    var pad = wide
      ? { left: el.hud.offsetWidth + 40, right: 40, top: 40, bottom: 40 }
      : { left: 20, right: 20, top: Math.min(el.hud.offsetHeight + 20, h * 0.55), bottom: 20 };
    var vs;
    try {
      vs = new deck.WebMercatorViewport({ width: w, height: h })
        .fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: pad, maxZoom: 15 });
    } catch (e) {
      vs = { longitude: (minLon + maxLon) / 2, latitude: (minLat + maxLat) / 2, zoom: 12 };
    }
    lastView = { longitude: vs.longitude, latitude: vs.latitude,
                 zoom: Math.min(15, vs.zoom), pitch: 0, bearing: 0 };
    deckgl.setProps({ initialViewState: Object.assign({}, lastView) });
  }

  /* ---- colours ----------------------------------------------------------- */

  function hsl2rgb(h, s, l) {
    var a = s * Math.min(l, 1 - l);
    var f = function (n) {
      var k = (n + h / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  }

  /* ---- a day arrives ----------------------------------------------------- */

  function start(payload, opts) {
    var E = R.expand(payload);
    var prevRoute = cur && cur.payload.route;
    var prevSource = cur && cur.source;
    cur = { payload: payload, bytes: opts.bytes, E: E, source: opts.source };
    var span = payload.t1 - payload.t0;
    counts = R.inServiceByMinute(E, span);
    colors = E.vehicles.map(function (v, i) { return hsl2rgb((i * 137.5) % 360, 0.75, 0.6); });
    trips = E.segs.map(function (s) {
      var path = new Array(s.lon.length);
      for (var i = 0; i < path.length; i++) path[i] = [s.lon[i], s.lat[i]];
      return { vi: s.vi, path: path, timestamps: Array.from(s.t) };
    });
    staticLayers = [
      new deck.PathLayer({
        id: 'route-' + payload.route + payload.date, data: payload.shapes,
        getPath: function (d) { return d.path; }, getColor: [255, 255, 255, 60],
        getWidth: 12, widthMinPixels: 2, widthMaxPixels: 6,
      }),
      new deck.ScatterplotLayer({
        id: 'stops-' + payload.route + payload.date, data: payload.stops || [],
        getPosition: function (d) { return [d.lon, d.lat]; },
        getFillColor: [255, 255, 255, 120],
        getRadius: 15, radiusMinPixels: 2, radiusMaxPixels: 5, pickable: true,
      }),
    ];
    if (prevRoute !== payload.route || prevSource !== opts.source) fitTo(payload);

    el.title.textContent = 'Route ' + payload.route + ' \u00b7 ' +
      fmtDay(payload.date, { year: 'numeric' });
    document.title = '[LAB] Bus replay: route ' + payload.route + ', ' + payload.date;
    el.route.value = payload.route;
    el.save.disabled = false;
    if (opts.source === 'file') {
      el.badge.hidden = false;
      el.badge.textContent = 'From your file \u00b7 made ' +
        (payload.generated ? fmtDay(payload.generated.slice(0, 10), { year: 'numeric' }) : 'earlier');
    } else {
      el.badge.hidden = true;
    }

    simT = defaultStart();
    if (opts.t != null) {
      var m = /^(\d{1,2}):?(\d{2})$/.exec(opts.t);
      if (m) {
        var e = londonEpoch(payload.date, +m[1], +m[2]);
        if (e < payload.t0 && e + 86400 <= payload.t1) e += 86400;   // after midnight
        simT = Math.max(0, Math.min(span, e - payload.t0));
      }
    }
    drawTimelineBase();
    renderDays();
    updateURL();
    say('');
    render();
  }

  // Start where the day gets going: the first minute with half the day's
  // peak count of buses on the road, rather than the first lone 04:00 bus.
  function defaultStart() {
    var peak = 0, i;
    for (i = 0; i < counts.length; i++) if (counts[i] > peak) peak = counts[i];
    for (i = 0; i < counts.length; i++) if (counts[i] >= peak / 2) return i * 60;
    return 0;
  }

  /* ---- loading ------------------------------------------------------------ */

  function routeEntries(key) {
    return (index && index.routes && index.routes[key]) || null;
  }
  function resolveRoute(r) {
    return routeKey[String(r || '').trim().toUpperCase()] || null;
  }

  var loadToken = 0;
  async function loadServerDay(key, iso, opts) {
    var token = ++loadToken;
    say('Loading route ' + key + ', ' + fmtDay(iso) + '\u2026');
    var url = DATA_ROOT + 'd/' + encodeURIComponent(key) + '/' + iso + '.json.gz';
    var res;
    try {
      res = await fetch(url);
    } catch (e) {
      if (token === loadToken) say('Could not reach the server. Check your connection and try again.');
      return;
    }
    if (token !== loadToken) return;
    if (!res.ok) {
      notOnServer(key, iso);
      return;
    }
    try {
      var bytes = await res.arrayBuffer();
      var payload = await R.parse(bytes);
      if (token !== loadToken) return;
      start(payload, Object.assign({ bytes: bytes, source: 'server' }, opts || {}));
    } catch (e) {
      if (token === loadToken) say(e.name === 'ReplayError' ? e.message
        : 'Something went wrong drawing that day (' + e.message + ').');
      console.error(e);
    }
  }

  function notOnServer(key, iso) {
    say('Route ' + key + ' on ' + fmtDay(iso, { year: 'numeric' }) +
        " isn't on the server any more. If you saved it, open the file here.",
        { label: 'Open a saved day\u2026', run: function () { el.file.click(); } });
  }

  async function loadFile(file) {
    ++loadToken;
    say('Opening ' + file.name + '\u2026');
    try {
      var bytes = await file.arrayBuffer();
      var payload = await R.parse(bytes);
      start(payload, { bytes: bytes, source: 'file' });
    } catch (e) {
      say(e.name === 'ReplayError' ? e.message : 'Could not open that file.');
      console.error(e);
    }
  }

  function updateURL() {
    var u = new URL(location.href);
    if (cur && cur.source === 'server') {
      u.searchParams.set('route', cur.payload.route);
      u.searchParams.set('date', cur.payload.date);
    } else {
      u.searchParams.delete('route');
      u.searchParams.delete('date');
    }
    u.searchParams.delete('t');
    history.replaceState(null, '', u.pathname + (u.search || ''));
  }

  /* ---- the day strip ------------------------------------------------------ */

  function gapFor(iso) {
    var g = (index && index.missing) || [];
    for (var i = 0; i < g.length; i++) if (g[i].start <= iso && iso <= g[i].end) return g[i];
    return null;
  }

  function availableDates(key) {
    var e = routeEntries(key);
    return e ? Object.keys(e).sort() : [];
  }

  function describe(iso, rec) {
    var bits = [fmtDay(iso, { year: 'numeric' })];
    if (rec.journeys != null && rec.cut_short != null && rec.journeys > 0) {
      bits.push('Cut short ' + Math.round(100 * rec.cut_short / rec.journeys) + '% (' +
                rec.cut_short + ' of ' + rec.journeys + ' journeys' +
                (rec.dirs === 1 ? ', one direction measured' : '') + ')');
    } else {
      bits.push('No cut-short figure for this day');
    }
    if (rec.ewt_min != null) bits.push('excess wait ' + rec.ewt_min.toFixed(1) + ' min');
    if (rec.holes_min) bits.push('no data for ' + rec.holes_min + ' min');
    if (rec.pinned) bits.push('kept: ' + rec.pinned);
    return bits.join(' \u00b7 ');
  }

  function renderDays() {
    el.days.innerHTML = '';
    var key = cur && cur.source === 'server' ? cur.payload.route : resolveRoute(el.route.value);
    var dates = key ? availableDates(key) : [];
    var curIso = cur && cur.payload.date;
    el.daylabel.textContent = curIso ? fmtDay(curIso) : '';
    var inList = curIso && dates.indexOf(curIso) !== -1 && cur.source === 'server';
    el.prev.disabled = !inList || dates.indexOf(curIso) === 0;
    el.next.disabled = !inList || dates.indexOf(curIso) === dates.length - 1;
    if (!dates.length) return;
    var entries = routeEntries(key);
    for (var iso = dates[0]; iso <= dates[dates.length - 1]; iso = addDays(iso, 1)) {
      var b = document.createElement('button');
      b.className = 'day';
      var d = new Date(iso + 'T12:00:00Z');
      b.innerHTML = '<span class="wd">' + 'SMTWTFS'[d.getUTCDay()] + '</span>' + d.getUTCDate();
      var rec = entries[iso];
      if (rec) {
        var share = (rec.journeys > 0 && rec.cut_short != null) ? rec.cut_short / rec.journeys : null;
        if (share == null) {
          b.classList.add('nofig');
        } else {
          // Absolute, not relative to the route: a route that never cuts
          // anything short must not get an invented "worst day". Square root
          // so 4% vs 15% still reads; 40%+ is full strength.
          var a = 0.08 + 0.82 * Math.sqrt(Math.min(1, share / 0.4));
          b.style.background = 'rgba(224,162,78,' + a.toFixed(2) + ')';
          if (a > 0.5) b.classList.add('dark-text');
        }
        if (rec.pinned) b.insertAdjacentHTML('beforeend', '<span class="pin" aria-hidden="true">\u25cf</span>');
        b.title = describe(iso, rec);
        b.onclick = (function (i) { return function () { loadServerDay(key, i); }; })(iso);
        if (iso === curIso && cur.source === 'server') b.classList.add('cur');
      } else {
        var g = gapFor(iso);
        b.disabled = true;
        if (g && g.kind === 'no-service') {
          b.classList.add('gap', 'noservice');
          b.title = fmtDay(iso, { year: 'numeric' }) + ' \u00b7 No buses ran: ' + g.reason;
        } else if (g) {
          b.classList.add('gap');
          b.title = fmtDay(iso, { year: 'numeric' }) + ' \u00b7 No data: ' + g.reason;
        } else {
          b.classList.add('absent');
          b.title = fmtDay(iso, { year: 'numeric' }) + ' \u00b7 not on the server';
        }
      }
      el.days.appendChild(b);
    }
    var curEl = el.days.querySelector('.cur');
    if (curEl) curEl.scrollIntoView({ block: 'nearest', inline: 'center' });
    else el.days.scrollLeft = el.days.scrollWidth;
  }

  function stepDay(n) {
    if (!cur || cur.source !== 'server') return;
    var dates = availableDates(cur.payload.route);
    var i = dates.indexOf(cur.payload.date) + n;
    if (i >= 0 && i < dates.length) loadServerDay(cur.payload.route, dates[i]);
  }

  /* ---- timeline ----------------------------------------------------------- */

  function drawTimelineBase() {
    var c = el.tl, dpr = window.devicePixelRatio || 1;
    var w = Math.max(1, el.timeline.clientWidth), h = el.timeline.clientHeight;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    tlBase = document.createElement('canvas');
    tlBase.width = c.width; tlBase.height = c.height;
    var g = tlBase.getContext('2d');
    g.scale(dpr, dpr);
    g.fillStyle = '#1c1f24'; g.fillRect(0, 0, w, h);
    if (!cur) return;
    var p = cur.payload, span = p.t1 - p.t0;
    // hour ticks, London time
    g.fillStyle = '#2c3138';
    var firstHour = Math.ceil(p.t0 / 3600) * 3600;
    for (var t = firstHour; t <= p.t1; t += 3600) {
      var x = (t - p.t0) / span * w;
      var hr = +fmtHM(t).slice(0, 2);
      g.fillRect(Math.round(x), hr % 6 === 0 ? 0 : h - 6, 1, hr % 6 === 0 ? h : 6);
    }
    // buses seen, per minute
    var peak = 1;
    for (var i = 0; i < counts.length; i++) if (counts[i] > peak) peak = counts[i];
    g.beginPath(); g.moveTo(0, h);
    for (i = 0; i < counts.length; i++) {
      g.lineTo(i * 60 / span * w, h - 2 - (h - 6) * counts[i] / peak);
    }
    g.lineTo(w, h); g.closePath();
    g.fillStyle = 'rgba(120,170,220,.45)'; g.fill();
    // holes: hatched — absence of data must not read as absence of buses
    (p.holes || []).forEach(function (hole) {
      var x0 = Math.max(0, (hole[0] - p.t0) / span * w);
      var x1 = Math.min(w, (hole[1] - p.t0) / span * w);
      g.save();
      g.beginPath(); g.rect(x0, 0, Math.max(2, x1 - x0), h); g.clip();
      g.fillStyle = hole[2] === 'no-service' ? 'rgba(61,90,122,.55)' : 'rgba(122,90,34,.55)';
      g.fillRect(x0, 0, x1 - x0, h);
      g.strokeStyle = hole[2] === 'no-service' ? '#8fb3d9' : '#f0c27a';
      g.lineWidth = 1;
      for (var k = x0 - h; k < x1 + h; k += 5) { g.moveTo(k, h); g.lineTo(k + h, 0); }
      g.stroke();
      g.restore();
    });
  }

  function drawTimeline() {
    if (!tlBase || !cur) return;
    var c = el.tl, g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(tlBase, 0, 0);
    var span = cur.payload.t1 - cur.payload.t0;
    var x = Math.round(simT / span * c.width);
    g.fillStyle = '#fff';
    g.fillRect(x - 1, 0, 2 * (window.devicePixelRatio || 1), c.height);
  }

  function scrubTo(clientX) {
    if (!cur) return;
    var r = el.timeline.getBoundingClientRect();
    var f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    simT = f * (cur.payload.t1 - cur.payload.t0);
    render();
  }

  /* ---- the frame ---------------------------------------------------------- */

  function holeAt(epoch) {
    var hs = (cur && cur.payload.holes) || [];
    for (var i = 0; i < hs.length; i++) if (hs[i][0] <= epoch && epoch < hs[i][1]) return hs[i];
    return null;
  }

  function render() {
    if (!cur) return;
    var p = cur.payload, E = cur.E;
    var buses = R.positionsAt(E, p.blinds, simT);
    deckgl.setProps({ layers: staticLayers.concat([
      new deck.TripsLayer({
        id: 'trails', data: trips,
        getPath: function (d) { return d.path; },
        getTimestamps: function (d) { return d.timestamps; },
        getColor: function (d) { return colors[d.vi]; },
        currentTime: simT, trailLength: TRAIL_S,
        widthMinPixels: 3, opacity: 0.6, fadeTrail: true,
      }),
      new deck.ScatterplotLayer({
        id: 'buses', data: buses, pickable: true,
        getPosition: function (d) { return d.position; },
        getFillColor: function (d) { return d.dead ? [130, 130, 130, 220] : colors[d.vi].concat(255); },
        getLineColor: [255, 255, 255, 200], getLineWidth: 2, lineWidthUnits: 'pixels',
        stroked: true, getRadius: 40, radiusMinPixels: 5, radiusMaxPixels: 12,
        updateTriggers: { getPosition: simT, getFillColor: simT },
      }),
      new deck.TextLayer({
        id: 'labels', data: buses,
        getPosition: function (d) { return d.position; },
        getText: function (d) { return d.reg; },
        getColor: [255, 255, 255, 200], getSize: 11,
        getPixelOffset: [0, -16], fontFamily: 'DM Sans, system-ui, sans-serif',
        updateTriggers: { getPosition: simT },
      }),
    ]) });
    var now = p.t0 + simT;
    el.clock.textContent = fmtClock(now);
    var dead = buses.filter(function (b) { return b.dead; }).length;
    el.meta.textContent = (buses.length - dead) + ' in service \u00b7 ' + dead +
      ' not in service \u00b7 ' + E.vehicles.length + ' vehicles all day';
    el.slider.value = Math.round(1000 * simT / (p.t1 - p.t0));
    drawTimeline();
    var h = holeAt(now);
    if (h) {
      el.banner.hidden = false;
      el.banner.classList.toggle('noservice', h[2] === 'no-service');
      el.banner.textContent = h[2] === 'no-service'
        ? cap(h[3]) + '.'
        : 'No data ' + fmtHM(h[0]) + '\u2013' + fmtHM(h[1]) + ': ' + h[3] +
          '. Buses were running; we just can\u2019t see them.';
    } else {
      el.banner.hidden = true;
    }
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function tick(now) {
    if (playing && cur) {
      simT += speed * (now - lastFrame) / 1000;
      if (simT > cur.payload.t1 - cur.payload.t0) simT = 0;
      render();
    }
    lastFrame = now;
    requestAnimationFrame(tick);
  }

  /* ---- save / open -------------------------------------------------------- */

  async function saveDay() {
    if (!cur || !cur.bytes) return;
    var bytes = new Uint8Array(cur.bytes);
    // A store that sent Content-Encoding: gzip hands us plain JSON; save the
    // same .json.gz everyone else gets.
    if (!R.isGzip(bytes) && typeof CompressionStream !== 'undefined') {
      var s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
      bytes = new Uint8Array(await new Response(s).arrayBuffer());
    }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/gzip' }));
    a.download = R.filename(cur.payload.route, cur.payload.date);
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    say('Saved as ' + a.download + '. Open it here any time with \u201cOpen a saved day\u201d.');
  }

  function copyLink() {
    if (!cur) return;
    var u = new URL(location.origin + location.pathname);
    u.searchParams.set('route', cur.payload.route);
    u.searchParams.set('date', cur.payload.date);
    u.searchParams.set('t', fmtHM(cur.payload.t0 + simT));
    if (speed !== 60) u.searchParams.set('speed', speed);
    var text = u.toString();
    var note = cur.source === 'file'
      ? ' (it opens the server copy, which may since have been removed)' : '';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { say('Link copied: route ' + cur.payload.route + ' at ' + fmtHM(cur.payload.t0 + simT) + note + '.'); },
        function () { window.prompt('Copy this link:', text); });
    } else {
      window.prompt('Copy this link:', text);
    }
  }

  /* ---- wiring ------------------------------------------------------------- */

  el.play.onclick = function () {
    playing = !playing;
    el.play.textContent = playing ? 'Pause' : 'Play';
    el.play.classList.toggle('paused', !playing);
  };
  el.speed.onchange = function () { speed = +el.speed.value; };
  el.slider.oninput = function () {
    if (!cur) return;
    simT = (cur.payload.t1 - cur.payload.t0) * (+el.slider.value / 1000);
    render();
  };
  var scrubbing = false;
  el.timeline.addEventListener('pointerdown', function (e) {
    scrubbing = true; el.timeline.setPointerCapture(e.pointerId); scrubTo(e.clientX);
  });
  el.timeline.addEventListener('pointermove', function (e) { if (scrubbing) scrubTo(e.clientX); });
  el.timeline.addEventListener('pointerup', function () { scrubbing = false; });
  el.prev.onclick = function () { stepDay(-1); };
  el.next.onclick = function () { stepDay(1); };
  el.route.addEventListener('change', function () {
    var key = resolveRoute(el.route.value);
    if (!key) {
      say(el.route.value.trim()
        ? 'No replays on the server for route ' + el.route.value.trim().toUpperCase() + '.'
        : '');
      return;
    }
    var dates = availableDates(key);
    var keep = cur && dates.indexOf(cur.payload.date) !== -1 ? cur.payload.date : dates[dates.length - 1];
    loadServerDay(key, keep);
  });
  el.save.onclick = saveDay;
  el.open.onclick = function () { el.file.click(); };
  el.file.onchange = function () { if (el.file.files[0]) loadFile(el.file.files[0]); el.file.value = ''; };
  el.copylink.onclick = copyLink;
  el.mapstyle.onchange = function () {
    mapMode = el.mapstyle.value; applyBright(); mountBasemap();
  };
  el.mapbright.oninput = function () {
    BRIGHT[mapMode] = +el.mapbright.value; applyBright();
  };
  function setCollapsed(c) {
    el.hud.classList.toggle('collapsed', c);
    el.collapse.setAttribute('aria-expanded', String(!c));
    el.collapse.innerHTML = c ? '&#9656;' : '&#9662;';
    drawTimelineBase(); drawTimeline();
  }
  el.collapse.onclick = function () { setCollapsed(!el.hud.classList.contains('collapsed')); };
  // On a phone the full panel hides half the map: start with just the clock.
  if (window.innerWidth < 600) setCollapsed(true);

  // drop a saved file anywhere
  var dragDepth = 0;
  window.addEventListener('dragenter', function (e) {
    if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') !== -1) {
      dragDepth++; el.drop.hidden = false; e.preventDefault();
    }
  });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('dragleave', function () {
    if (--dragDepth <= 0) { dragDepth = 0; el.drop.hidden = true; }
  });
  window.addEventListener('drop', function (e) {
    e.preventDefault(); dragDepth = 0; el.drop.hidden = true;
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  window.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || !cur) return;
    if (e.key === ' ') { e.preventDefault(); el.play.click(); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      var d = (e.shiftKey ? 600 : 60) * (e.key === 'ArrowRight' ? 1 : -1);
      simT = Math.max(0, Math.min(cur.payload.t1 - cur.payload.t0, simT + d));
      render();
    }
  });
  window.addEventListener('resize', function () { drawTimelineBase(); drawTimeline(); });

  // For the smoke driver (and the curious): what the page thinks it is showing.
  window.__replay = function () {
    return cur ? {
      route: cur.payload.route, date: cur.payload.date, source: cur.source,
      clock: el.clock.textContent, simT: simT, playing: playing,
      points: cur.E.points, vehicles: cur.E.vehicles.length,
      banner: el.banner.hidden ? null : el.banner.textContent,
      msg: el.msg.textContent, days: el.days.children.length,
      url: location.search,
    } : { msg: el.msg.textContent, days: el.days.children.length };
  };

  /* ---- go ----------------------------------------------------------------- */

  applyBright();
  mountBasemap();
  requestAnimationFrame(tick);

  (async function init() {
    var q = new URLSearchParams(location.search);
    var sp = +q.get('speed');
    if ([10, 30, 60, 120, 300, 600].indexOf(sp) !== -1) { speed = sp; el.speed.value = String(sp); }
    try {
      var res = await fetch(DATA_ROOT + 'index.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      index = await res.json();
    } catch (e) {
      say('Could not load the list of replays. You can still open a saved day.',
          { label: 'Open a saved day\u2026', run: function () { el.file.click(); } });
      return;
    }
    Object.keys(index.routes || {}).forEach(function (k) {
      routeKey[k.toUpperCase()] = k;
      var o = document.createElement('option');
      o.value = k;
      el.routes.appendChild(o);
    });
    var want = q.get('route');
    var key = resolveRoute(want || DEFAULT_ROUTE) || Object.keys(routeKey).map(function (k) { return routeKey[k]; })[0];
    if (want && !resolveRoute(want)) {
      say('No replays on the server for route ' + want.toUpperCase() + '.');
      return;
    }
    if (!key) { say('No replays on the server yet.'); return; }
    var dates = availableDates(key);
    var date = q.get('date');
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) date = null;
    if (date && dates.indexOf(date) === -1) {
      el.route.value = key;
      renderDays();
      var g = gapFor(date);
      if (g) say(fmtDay(date, { year: 'numeric' }) + ': ' +
                 (g.kind === 'no-service' ? 'no buses ran (' + g.reason + ').' : 'no data (' + g.reason + ').'));
      else notOnServer(key, date);
      return;
    }
    loadServerDay(key, date || dates[dates.length - 1], { t: q.get('t') });
  })();
})();
