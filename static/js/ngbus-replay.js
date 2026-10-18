/* Bus replay — one route, one day, every bus, from BODS positions.
 *
 * /bus/replay/ (layouts/bus/replay.html). The data comes from the R2 bucket
 * behind the Worker named in hugo.toml (params.busReplayData), written daily
 * by NRG-1's export_replay.py (E:\Road Data\platform). Reading and expanding
 * a day file is ngbus-replay-data.js.
 *
 * Links: ?route=60[&date=2026-10-01][&t=08:15][&at=<stop name>][&gap=56][&speed=60]
 *   at + gap  come from a route page's worst gap ("watch it happen"): the map
 *             zooms to that stop and marks it.
 *
 * Loading is sized for a phone that came to watch one route: routes.json (the
 * route list, a few KB), i/<ROUTE>.json (that route's days, ~3 KB), then the
 * day itself (~100 KB). The days either side are fetched in the background so
 * stepping through them does not wait. If the per-route files are missing
 * (an older Worker), it falls back to the full index.json once.
 */
(function () {
  'use strict';

  var R = window.ReplayData;
  var DATA_ROOT = document.body.getAttribute('data-replay-root') || './';
  if (DATA_ROOT.slice(-1) !== '/') DATA_ROOT += '/';

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
  var PREFETCH_KEEP = 6;

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    hud: $('hud'), title: $('title'), badge: $('badge'), route: $('route'),
    back: $('back'), prev: $('prev'), next: $('next'), daylabel: $('daylabel'),
    days: $('days'), clock: $('clock'), meta: $('meta'), timeline: $('timeline'),
    tl: $('tl'), slider: $('slider'), play: $('play'), speed: $('speed'),
    copylink: $('copylink'), save: $('save'), open: $('open'), file: $('file'),
    mapstyle: $('mapstyle'), mapbright: $('mapbright'), msg: $('msg'),
    banner: $('banner'), drop: $('drop'), collapse: $('collapse'), notices: $('notices'),
  };

  // TfL notices for the route (ngbus-notices.js; spec: E:\Road Data\docs\
  // superpowers\specs\2026-10-17-tfl-notices-design.md, section 3). The
  // panel lists those in force on the day being watched, closed stops are
  // drawn hollow, and the date strip marks days with one.
  var NN = window.NgbusNotices;
  var NWORDS = {};
  try { NWORDS = JSON.parse(($('ngbus-notices-words') || {}).textContent || '{}'); } catch (e) {}
  var closedLayers = [];
  var noticeMarks = { route: null, days: {} };

  // Routes that have a performance page, so "back" can go there (others
  // fall back to the A-Z). Written into the page by the layout.
  var PAGES = {};
  try {
    JSON.parse(($('ngbus-replay-pages') || {}).textContent || '[]')
      .forEach(function (r) { PAGES[String(r).toUpperCase()] = true; });
  } catch (e) { /* no list: every back link is the A-Z */ }

  var catalogue = null;      // {routes: {KEY: [first, last, n]}, missing: [...]}
  var routeDays = {};        // KEY -> {iso: record}, loaded per route
  var fullIndex = null;      // only if the per-route files are unavailable
  var routeKey = {};         // UPPER -> key as stored
  var cur = null;            // {payload, bytes, E, source}
  var simT = 0;              // seconds after payload.t0
  var playing = true;
  var speed = 60;
  var lastFrame = performance.now();
  var counts = null;         // buses seen per minute (timeline)
  var tlBase = null;         // pre-drawn timeline, playhead added per frame
  var mapMode = 'dark';
  var staticLayers = [];
  var markLayers = [];       // the worst-gap stop, when a link named one
  var trips = [];
  var colors = [];

  /* ---- names, as a reader should see them --------------------------------- */

  // TfL's stop names carry interchange markup: "Aldgate Station <>",
  // "Anerley Station #", ">t<" tram, ">lol<" Overground, "[dlr]". Stripped for
  // display, exactly as layouts/partials/bus-place.html does on the route
  // pages, so a stop reads the same on both.
  function cleanName(s) {
    return String(s || '')
      .replace(/>[a-z]+</gi, ' ')
      .replace(/\[[a-z]+\]/gi, ' ')
      .replace(/<>/g, ' ')
      .replace(/#/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s*\/\s*/g, ' / ')
      .replace(/^[\s/]+/, '')
      .replace(/[\s/]+$/, '');
  }

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

  var LONDON = { longitude: -0.11, latitude: 51.48, zoom: 9.6, pitch: 0, bearing: 0,
                 maxPitch: 0 };

  var deckgl = new deck.DeckGL({
    container: 'map',
    /* map: false is NOT optional once maplibre-gl.js is on the page: deck
       otherwise builds its own styleless base map inside this container
       (see crime-hotspots for the full story). */
    map: false,
    initialViewState: LONDON,
    /* A flat, north-up map: no tilt, no rotation. keyboard: false because
       deck's keyboard controller pans on the arrow keys, which here step
       the replay a minute at a time. */
    controller: { dragRotate: false, touchRotate: false, keyboard: false },
    getTooltip: function (info) {
      var o = info.object;
      if (!o) return null;
      if (o.reg) return { text: R.plate(o.reg) + '\n' + (o.dead ? 'not in service: ' : 'to ') + cleanName(o.blind) };
      if (o.closed) return { text: cleanName(o.name) + ' \u2014 ' + (NWORDS.replay_closed || 'closed (TfL)') };
      if (o.name) return { text: cleanName(o.name) };
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
  function fitBox(minLon, minLat, maxLon, maxLat, maxZoom) {
    var w = window.innerWidth, h = window.innerHeight;
    var wide = w >= 900;
    var pad = wide
      ? { left: el.hud.offsetWidth + 40, right: 40, top: 40, bottom: 40 }
      : { left: 20, right: 20, top: Math.min(el.hud.offsetHeight + 20, h * 0.55), bottom: 20 };
    var vs;
    try {
      vs = new deck.WebMercatorViewport({ width: w, height: h })
        .fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: pad, maxZoom: maxZoom });
    } catch (e) {
      vs = { longitude: (minLon + maxLon) / 2, latitude: (minLat + maxLat) / 2, zoom: 12 };
    }
    lastView = { longitude: vs.longitude, latitude: vs.latitude,
                 zoom: Math.min(maxZoom, vs.zoom), pitch: 0, bearing: 0, maxPitch: 0 };
    deckgl.setProps({ initialViewState: Object.assign({}, lastView) });
  }
  function fitTo(payload) {
    var minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
    function fit(p) {
      if (p[0] < minLon) minLon = p[0]; if (p[0] > maxLon) maxLon = p[0];
      if (p[1] < minLat) minLat = p[1]; if (p[1] > maxLat) maxLat = p[1];
    }
    payload.shapes.forEach(function (s) { s.path.forEach(fit); });
    if (minLon > maxLon) trips.forEach(function (t) { t.path.forEach(fit); });
    if (minLon > maxLon) return;
    fitBox(minLon, minLat, maxLon, maxLat, 15);
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

  /* ---- the worst-gap stop -------------------------------------------------- */

  // A route page's "watch it happen" link names the stop where the gap was.
  // Every stop of that name is marked (usually one each side of the road)
  // and the map closes in on them, about a kilometre across.
  function markStop(payload, at, gap, t) {
    markLayers = [];
    if (!at) return false;
    var want = cleanName(at).toLowerCase();
    var hits = (payload.stops || []).filter(function (s) {
      return cleanName(s.name).toLowerCase() === want;
    });
    if (!hits.length) return false;
    markLayers = [
      new deck.ScatterplotLayer({
        id: 'mark', data: hits, stroked: true, filled: true,
        getPosition: function (d) { return [d.lon, d.lat]; },
        getFillColor: [224, 162, 78, 60], getLineColor: [224, 162, 78, 255],
        getRadius: 60, radiusMinPixels: 12, radiusMaxPixels: 26,
        lineWidthUnits: 'pixels', getLineWidth: 3,
      }),
      new deck.TextLayer({
        id: 'mark-label', data: [hits[0]],
        getPosition: function (d) { return [d.lon, d.lat]; },
        getText: function () { return cleanName(at); },
        getColor: [255, 226, 176, 255], getSize: 13, getPixelOffset: [0, 26],
        fontFamily: 'DM Sans, system-ui, sans-serif', fontWeight: 600,
        outlineWidth: 3, outlineColor: [17, 17, 17, 230], fontSettings: { sdf: true },
      }),
    ];
    var lon = hits.reduce(function (a, s) { return a + s.lon; }, 0) / hits.length;
    var lat = hits.reduce(function (a, s) { return a + s.lat; }, 0) / hits.length;
    fitBox(lon - 0.008, lat - 0.005, lon + 0.008, lat + 0.005, 15.5);
    el.badge.hidden = false;
    el.badge.textContent = (gap ? 'The ' + gap + '-minute gap' : 'The gap') +
      ' at ' + cleanName(at) + (t ? ', from ' + t : '') +
      '. The ring marks the stop; press play to watch it build.';
    return true;
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

    el.badge.hidden = true;
    var marked = markStop(payload, opts.at, opts.gap, opts.t);
    if (!marked && (prevRoute !== payload.route || prevSource !== opts.source)) fitTo(payload);

    el.title.textContent = 'Route ' + payload.route + ' \u00b7 ' +
      fmtDay(payload.date, { year: 'numeric' });
    document.title = 'Route ' + payload.route + ', ' + fmtDay(payload.date, { year: 'numeric' }) +
      ': bus replay \u2014 Neil Garratt';
    setBack(payload.route);
    if (!Array.prototype.some.call(el.route.options, function (o) { return o.value === payload.route; })) {
      var o = document.createElement('option');
      o.value = payload.route; o.textContent = payload.route + ' (your file)';
      el.route.appendChild(o);
    }
    el.route.value = payload.route;
    el.save.disabled = false;
    if (opts.source === 'file') {
      el.badge.hidden = false;
      el.badge.textContent = 'From your file \u00b7 made ' +
        (payload.generated ? fmtDay(payload.generated.slice(0, 10), { year: 'numeric' }) : 'earlier');
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
    closedLayers = [];
    if (el.notices) { el.notices.hidden = true; el.notices.innerHTML = ''; }
    renderDays();
    applyNotices(payload);
    updateURL(marked ? opts : null);
    say('');
    render();
    if (opts.source === 'server') prefetchAround(payload.route, payload.date);
  }

  // Start where the day gets going: the first minute with half the day's
  // peak count of buses on the road, rather than the first lone 04:00 bus.
  function defaultStart() {
    var peak = 0, i;
    for (i = 0; i < counts.length; i++) if (counts[i] > peak) peak = counts[i];
    for (i = 0; i < counts.length; i++) if (counts[i] >= peak / 2) return i * 60;
    return 0;
  }

  /* ---- TfL notices --------------------------------------------------------- */

  // Notices in force on the service day, closed stops on the map, and the
  // marks in the date strip. Loaded once per route; a route with no file has
  // nothing to show, and a failed fetch shows nothing rather than an error.
  // Works announced ahead (every TfL date starts after the day, or the text's
  // start does) do not count for a day: they are the route page's "Coming
  // up", not that day's notice; nor do the days a notice was up before them.
  function applyNotices(payload) {
    if (!NN) return;
    var route = payload.route, day = payload.date;
    NN.load(DATA_ROOT, route).then(function (f) {
      if (!cur || cur.payload !== payload) return;           // moved on meanwhile
      var items = f ? f.notices.concat(f.closures) : [];
      var w = NN.serviceDay(day);
      var live = items.filter(function (it) { return NN.inEffect(it, w[0], w[1]); });
      var closed = live.filter(function (it) { return it.atco != null && it.lon != null; });
      closedLayers = closed.length ? [new deck.ScatterplotLayer({
        id: 'closed-' + route + day,
        data: closed.map(function (c) { return { name: c.name, lon: c.lon, lat: c.lat, closed: true }; }),
        getPosition: function (d) { return [d.lon, d.lat]; },
        stroked: true, filled: true, getFillColor: [17, 17, 17, 255],
        getLineColor: [150, 150, 150, 255], lineWidthUnits: 'pixels', getLineWidth: 2,
        getRadius: 18, radiusMinPixels: 4, radiusMaxPixels: 8, pickable: true,
      })] : [];
      var notes = live.filter(function (it) { return it.atco == null; });
      var parts = [];
      if (notes.length || closed.length) {
        parts.push('<div class="nt-title">' + NN.say(NWORDS, 'replay_title') + '</div>');
        parts.push('<ul class="nt-list">' + NN.rollUp(NWORDS, notes.concat(closed), w[0], w[1]).map(function (it) {
          return NN.itemHTML(NWORDS, it, w[0], w[1]);
        }).join('') + '</ul>');
      }
      if (day < NN.ARCHIVE_FROM) {
        parts.push('<div class="nt-foot">' + NN.say(NWORDS, 'replay_before_archive') + '</div>');
      }
      if (el.notices) {
        el.notices.innerHTML = parts.join('');
        el.notices.hidden = !parts.length;
      }
      // the date strip: every day with a NOTICE in force (closed stops are
      // drawn on the map instead; a long closure would mark every day)
      var marks = {};
      var notices = f ? f.notices : [];
      availableDates(route).forEach(function (d) {
        var dw = NN.serviceDay(d);
        if (notices.some(function (it) { return NN.inEffect(it, dw[0], dw[1]); })) marks[d] = true;
      });
      noticeMarks = { route: route, days: marks };
      renderDays();
      render();
    }).catch(function () { /* no panel: the replay stands without it */ });
  }

  function setBack(route) {
    if (route && PAGES[route.toUpperCase()]) {
      el.back.href = '/bus/' + route.toLowerCase() + '/';
      el.back.textContent = '\u2190 Route ' + route + ' performance';
    } else {
      el.back.href = '/bus/';
      el.back.textContent = '\u2190 All bus routes';
    }
  }

  /* ---- what the server holds ---------------------------------------------- */

  function resolveRoute(r) {
    return routeKey[String(r || '').trim().toUpperCase()] || null;
  }

  async function getJSON(path) {
    var res = await fetch(DATA_ROOT + path, { cache: 'no-cache' });
    if (!res.ok) { var e = new Error(path + ': HTTP ' + res.status); e.status = res.status; throw e; }
    return res.json();
  }

  // The full index, once, for a Worker that does not serve the small files.
  async function loadFullIndex() {
    if (!fullIndex) {
      fullIndex = await getJSON('index.json');
      Object.keys(fullIndex.routes || {}).forEach(function (k) { routeDays[k] = fullIndex.routes[k]; });
    }
    return fullIndex;
  }

  async function loadCatalogue() {
    try {
      catalogue = await getJSON('routes.json');
    } catch (e) {
      if (e.status !== 404) throw e;
      var full = await loadFullIndex();
      var routes = {};
      Object.keys(full.routes).forEach(function (k) {
        var isos = Object.keys(full.routes[k]).sort();
        routes[k] = [isos[0], isos[isos.length - 1], isos.length];
      });
      catalogue = { routes: routes, missing: full.missing || [] };
    }
    Object.keys(catalogue.routes || {}).forEach(function (k) {
      routeKey[k.toUpperCase()] = k;
      var o = document.createElement('option');
      o.value = k; o.textContent = k;
      el.route.appendChild(o);
    });
  }

  async function ensureRoute(key) {
    if (routeDays[key]) return routeDays[key];
    try {
      routeDays[key] = (await getJSON('i/' + encodeURIComponent(key) + '.json')).days || {};
    } catch (e) {
      if (e.status !== 404) throw e;
      await loadFullIndex();
      routeDays[key] = routeDays[key] || {};
    }
    return routeDays[key];
  }

  function availableDates(key) {
    var e = routeDays[key];
    return e ? Object.keys(e).sort() : [];
  }

  /* ---- day files, with the neighbours fetched ahead ------------------------ */

  var dayCache = new Map();   // url -> Promise<ArrayBuffer>, newest last

  function dayURL(key, iso) {
    return DATA_ROOT + 'd/' + encodeURIComponent(key) + '/' + iso + '.json.gz';
  }

  function getDayBytes(url) {
    if (dayCache.has(url)) {
      var p = dayCache.get(url);
      dayCache.delete(url); dayCache.set(url, p);       // most recently used
      return p;
    }
    var q = fetch(url).then(function (res) {
      if (!res.ok) { var e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return res.arrayBuffer();
    });
    q.catch(function () { dayCache.delete(url); });     // never cache a failure
    dayCache.set(url, q);
    while (dayCache.size > PREFETCH_KEEP) dayCache.delete(dayCache.keys().next().value);
    return q;
  }

  // The days either side, so the arrows and the day strip feel instant. Not
  // on a connection that has asked to save data.
  function prefetchAround(key, iso) {
    if (navigator.connection && navigator.connection.saveData) return;
    var dates = availableDates(key), i = dates.indexOf(iso);
    [i - 1, i + 1].forEach(function (j) {
      if (j >= 0 && j < dates.length) getDayBytes(dayURL(key, dates[j])).catch(function () {});
    });
  }

  var loadToken = 0;
  async function loadServerDay(key, iso, opts) {
    var token = ++loadToken;
    say('Loading route ' + key + ', ' + fmtDay(iso) + '\u2026');
    var bytes;
    try {
      bytes = await getDayBytes(dayURL(key, iso));
    } catch (e) {
      if (token !== loadToken) return;
      if (e.status) notOnServer(key, iso);
      else say('Could not reach the server. Check your connection and try again.');
      return;
    }
    if (token !== loadToken) return;
    try {
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

  // The address bar follows the route and day. A "watch it happen" link keeps
  // its stop and gap while the reader stays on that day; anything else drops them.
  function updateURL(keep) {
    var u = new URL(location.href);
    ['route', 'date', 't', 'at', 'gap'].forEach(function (k) { u.searchParams.delete(k); });
    if (cur && cur.source === 'server') {
      u.searchParams.set('route', cur.payload.route);
      u.searchParams.set('date', cur.payload.date);
      if (keep && keep.at) {
        u.searchParams.set('at', keep.at);
        if (keep.gap) u.searchParams.set('gap', keep.gap);
        if (keep.t) u.searchParams.set('t', keep.t);
      }
    }
    history.replaceState(null, '', u.pathname + (u.search || ''));
  }

  /* ---- the day strip ------------------------------------------------------ */

  function gapFor(iso) {
    var g = (catalogue && catalogue.missing) || [];
    for (var i = 0; i < g.length; i++) if (g[i].start <= iso && iso <= g[i].end) return g[i];
    return null;
  }

  function describe(iso, rec) {
    var bits = [fmtDay(iso, { year: 'numeric' })];
    if (rec.journeys != null && rec.cut_short != null && rec.journeys > 0) {
      bits.push('Cut short ' + Math.round(100 * rec.cut_short / rec.journeys) + '% (' +
                rec.cut_short + ' of ' + rec.journeys + ' journeys' +
                (rec.dirs === 1 ? ', one direction measured' : '') + ')');
    } else {
      bits.push('No cut-short figure for this day yet: they come with the weekly update');
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
    var entries = routeDays[key];
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
          // so 4% vs 15% still reads; 40%+ is full strength. Even 0% keeps a
          // tint, so a day with a figure never looks like one without (18 Oct:
          // the week since the last weekly update read as a flawless week).
          var a = 0.18 + 0.72 * Math.sqrt(Math.min(1, share / 0.4));
          b.style.background = 'rgba(224,162,78,' + a.toFixed(2) + ')';
          if (a > 0.5) b.classList.add('dark-text');
        }
        if (rec.pinned) b.insertAdjacentHTML('beforeend', '<span class="pin" aria-hidden="true">\u25cf</span>');
        b.title = describe(iso, rec);
        if (noticeMarks.route === key && noticeMarks.days[iso]) {
          b.insertAdjacentHTML('beforeend', '<span class="nmark" aria-hidden="true"></span>');
          b.title += ' \u00b7 ' + (NWORDS.replay_day_mark || 'TfL notice in force');
        }
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
    deckgl.setProps({ layers: staticLayers.concat(closedLayers, markLayers, [
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
        getText: function (d) { return R.plate(d.reg); },
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
      // Cap the step: a frame that stalled (shader compile, background tab)
      // must not throw the replay minutes forward.
      simT += speed * Math.min(250, now - lastFrame) / 1000;
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
  el.speed.onchange = function () { speed = +el.speed.value; el.speed.blur(); };
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
  el.route.addEventListener('change', async function () {
    var key = resolveRoute(el.route.value);
    el.route.blur();
    if (!key) { say('No replays on the server for route ' + el.route.value + '.'); return; }
    say('Loading route ' + key + '\u2026');
    try {
      await ensureRoute(key);
    } catch (e) {
      say('Could not load the days for route ' + key + '. Check your connection and try again.');
      return;
    }
    var dates = availableDates(key);
    if (!dates.length) { say('No replays on the server for route ' + key + '.'); return; }
    var keep = cur && dates.indexOf(cur.payload.date) !== -1 ? cur.payload.date : dates[dates.length - 1];
    loadServerDay(key, keep);
  });
  el.save.onclick = saveDay;
  el.open.onclick = function () { el.file.click(); };
  el.file.onchange = function () { if (el.file.files[0]) loadFile(el.file.files[0]); el.file.value = ''; };
  el.copylink.onclick = copyLink;
  el.mapstyle.onchange = function () {
    mapMode = el.mapstyle.value; applyBright(); mountBasemap(); el.mapstyle.blur();
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

  /* Keyboard: space = play/pause, arrows = a minute (shift: ten), wherever
     focus is except a dropdown or the brightness slider. A button clicked
     with the mouse gives its focus up, or space would press it AND toggle
     play — two toggles, nothing seen to happen. The time slider is ours:
     its own arrow-key step (1/1000 of the day) is replaced by a minute. */
  el.hud.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button');
    if (b && e.detail > 0) b.blur();
  });
  el.slider.addEventListener('pointerup', function () { el.slider.blur(); });
  window.addEventListener('keydown', function (e) {
    var t = e.target || {};
    if (!cur || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t === el.mapbright ||
        (t.tagName === 'INPUT' && t.type !== 'range')) return;
    // a button reached by Tab keeps its own space/enter (on Play, that IS play)
    if (t.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
    if (e.key === ' ') { e.preventDefault(); el.play.click(); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      var d = (e.shiftKey ? 600 : 60) * (e.key === 'ArrowRight' ? 1 : -1);
      simT = Math.max(0, Math.min(cur.payload.t1 - cur.payload.t0, simT + d));
      render();
    }
  });
  window.addEventListener('resize', function () { drawTimelineBase(); drawTimeline(); });

  window.__cam = function () {
    var v = currentCam();
    return [v.longitude, v.latitude, v.zoom, v.pitch || 0, v.bearing || 0];
  };
  // For the smoke driver (and the curious): what the page thinks it is showing.
  window.__replay = function () {
    return cur ? {
      route: cur.payload.route, date: cur.payload.date, source: cur.source,
      clock: el.clock.textContent, simT: simT, playing: playing,
      points: cur.E.points, vehicles: cur.E.vehicles.length,
      banner: el.banner.hidden ? null : el.banner.textContent,
      badge: el.badge.hidden ? null : el.badge.textContent,
      marked: markLayers.length > 0, back: el.back.getAttribute('href'),
      msg: el.msg.textContent, days: el.days.children.length,
      url: location.search, cached: Array.from(dayCache.keys()),
      fullIndex: !!fullIndex,
    } : { msg: el.msg.textContent, days: el.days.children.length,
          routes: el.route.options.length, fullIndex: !!fullIndex };
  };

  /* ---- go ----------------------------------------------------------------- */

  applyBright();
  mountBasemap();
  requestAnimationFrame(tick);
  setBack(null);

  (async function init() {
    var q = new URLSearchParams(location.search);
    var sp = +q.get('speed');
    if ([10, 30, 60, 120, 300, 600].indexOf(sp) !== -1) { speed = sp; el.speed.value = String(sp); }
    try {
      await loadCatalogue();
    } catch (e) {
      say('Could not load the list of replays. You can still open a saved day.',
          { label: 'Open a saved day\u2026', run: function () { el.file.click(); } });
      return;
    }
    var want = q.get('route');
    if (!want) {
      say('Choose a route to watch a day of its buses.');
      return;
    }
    var key = resolveRoute(want);
    if (!key) {
      say('No replays on the server for route ' + want.toUpperCase() + '.');
      return;
    }
    el.route.value = key;
    setBack(key);
    try {
      await ensureRoute(key);
    } catch (e) {
      say('Could not load the days for route ' + key + '. Check your connection and try again.');
      return;
    }
    var dates = availableDates(key);
    var date = q.get('date');
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) date = null;
    if (date && dates.indexOf(date) === -1) {
      renderDays();
      var g = gapFor(date);
      if (g) say(fmtDay(date, { year: 'numeric' }) + ': ' +
                 (g.kind === 'no-service' ? 'no buses ran (' + g.reason + ').' : 'no data (' + g.reason + ').'));
      else notOnServer(key, date);
      return;
    }
    if (!dates.length) { say('No replays on the server for route ' + key + '.'); return; }
    var gap = q.get('gap');
    loadServerDay(key, date || dates[dates.length - 1], {
      t: q.get('t'), at: q.get('at'),
      gap: gap && /^\d{1,4}$/.test(gap) ? gap : null,
    });
  })();
})();
