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
 *
 * Live mode (the Delay Replay pilot) is on only when the page names the live
 * files' root, <body data-live-root>, which only the lab page does: see "live
 * mode" below. Without it nothing here polls, nothing is drawn live, and the
 * page behaves exactly as it always has.
 */
(function () {
  'use strict';

  var R = window.ReplayData;
  var DATA_ROOT = document.body.getAttribute('data-replay-root') || './';
  if (DATA_ROOT.slice(-1) !== '/') DATA_ROOT += '/';
  var LIVE_ROOT = document.body.getAttribute('data-live-root') || '';
  if (LIVE_ROOT && LIVE_ROOT.slice(-1) !== '/') LIVE_ROOT += '/';
  var LIVE = !!LIVE_ROOT;

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
    card: $('card'),
    liveBanner: $('live-banner'), liveControls: $('live-controls'), liveOverlay: $('live-overlay'),
  };

  // The buses are little buses (ngbus-buses.js; Claude Design, 19 Oct): the
  // route's usual deck, a purple triple decker on a night route, facing the
  // way it is going, grey when not in service. Ordinary windows: the trail
  // carries the bus's colour, and the ghosts showed the windows need not
  // (Neil, 2 Nov). Coloured dots only if the icon script failed to load. No choice
  // to remember, so nothing is stored in the browser: the site sets no
  // cookies and keeps no "preferences" (privacy page).
  var NB = window.NgbusBuses;
  var DECKS = {};                                   // route -> double | single | night | night-single
  (($('ngbus-decks') || {}).textContent || '').split(',').forEach(function (kv) {
    var i = kv.indexOf(':');
    if (i > 0) DECKS[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  });
  var busStyle = NB ? 'buses' : 'dots';
  var ICON_W = 30;                                  // a bus is this many pixels long
  // Per bus, keyed by registration, not by its place in the payload (vi),
  // which moves when a bus joins the live day: which way it faces, and where
  // it was last drawn.
  var facing = new Map(), lastX = new Map(), lastT = null, iconCache = {};

  function busKind(route) {
    var k = DECKS[String(route).toUpperCase()];
    return k === 'night' || k === 'night-single' ? 'triple' : k === 'single' ? 'single' : 'double';
  }
  // A night route's own deck, under the triple decker (N33 and N72 are single).
  function nightDeck(route) {
    return DECKS[String(route).toUpperCase()] === 'night-single' ? 'single' : 'double';
  }

  // Which way each bus faces: the way it last moved east or west, playing
  // forwards or back. A jump of more than two minutes (a click on the
  // timeline) says nothing about direction, so it keeps the old one. On a
  // live day, played in real time, a bus moves too little between frames to
  // tell, so there the way it faces is judged from where it was when last
  // judged, not from the frame before.
  function updateFacing(buses) {
    var dt = lastT == null ? 0 : simT - lastT;
    var slow = !!(cur && cur.live);
    buses.forEach(function (b) {
      var x = b.position[0], px = lastX.get(b.reg), turned = false;
      if (px != null && dt !== 0 && Math.abs(dt) <= 120) {
        var dx = (x - px) * (dt > 0 ? 1 : -1);
        if (Math.abs(dx) > 2e-6) { facing.set(b.reg, dx < 0 ? -1 : 1); turned = true; }
      }
      if (!slow || turned || px == null || Math.abs(dt) > 120) lastX.set(b.reg, x);
    });
    lastT = simT;
  }

  function busIcon(kind, d) {
    var west = facing.get(d.reg) < 0;
    var sp = specialIcon(kind, d);
    if (sp) return west ? sp.w : sp.e;
    var key = kind + (west ? 'w' : 'e') + (d.dead ? 'x' : '');
    return iconCache[key] || (iconCache[key] = NB.icon(kind, { flip: west, dead: d.dead }));
  }

  // Special-occasion buses: Hallowe'en's ghosts, and a witch on the night
  // routes (Neil, 30 Oct). The day's own file says which sprites it gets
  // (payload.specials: {occasion, name, sprites: {dd|sd|td: name}}, stamped by
  // the exporter from static/bus/sprites/specials.json), so a day keeps its
  // buses for good, saved files included. The sprites are drawn as the
  // catalogue there describes them. Anything missing, unreadable or slow
  // to arrive, and the day simply has the ordinary buses. A bus out of service
  // stays the ordinary grey one: grey means "not in service" on every day.
  var SPRITES = '/bus/sprites/';
  var DECK_CODE = { double: 'dd', single: 'sd', triple: 'td' };
  var specialsCat = null;                  // the catalogue, fetched once
  var special = null;                      // {name, key, icons: {dd|sd|td: {e, w, size, above}}}

  function specialIcon(kind, d) {
    return special && !d.dead && special.icons[DECK_CODE[kind]] || null;
  }

  // Which of the day's sprites a route wears: its deck's, and on a night route
  // the triple decker's (td), unless the occasion dresses night buses like the
  // day ones by giving td the dd sprite (Remembrance, Neil, 7 Nov): then the
  // night route's own deck's.
  function specialDeck(route, sprites) {
    var kind = busKind(route);
    if (kind !== 'triple') return DECK_CODE[kind];
    return sprites.td && sprites.td === sprites.dd ? DECK_CODE[nightDeck(route)] : 'td';
  }

  function plainSvg(name, text) {
    var doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    var root = doc.documentElement;
    if (!root || root.nodeName !== 'svg' || doc.getElementsByTagName('parsererror').length ||
        doc.querySelector('script, foreignObject')) throw new Error('sprite ' + name + ' is not a plain SVG');
    return root;
  }

  // One sprite as a pair of icons, as drawn (east) and mirrored (west), each
  // decoded once before use so a sprite that cannot be drawn is never chosen.
  function specialSprite(name, s, text) {
    var root = plainSvg(name, text);
    var vb = s.vb, an = s.anchor, k = 2;          // drawn at twice size, for sharp edges
    if (!vb || vb.length !== 4 || !an || an.length !== 2 || !(vb[2] > 0) || !(vb[3] > 0)) throw new Error('sprite ' + name + ' has no geometry');
    var inner = root.innerHTML;
    function url(flip) {
      var g = flip ? '<g transform="translate(' + (2 * vb[0] + vb[2]) + ' 0) scale(-1 1)">' + inner + '</g>' : inner;
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + vb.join(' ') + '" width="' + vb[2] * k +
        '" height="' + vb[3] * k + '">' + g + '</svg>');
    }
    function icon(flip) {
      var ax = (an[0] - vb[0]) * k;
      return { id: 'special-' + name + (flip ? '-w' : '-e'), url: url(flip), width: vb[2] * k, height: vb[3] * k,
               anchorX: flip ? vb[2] * k - ax : ax, anchorY: (an[1] - vb[1]) * k };
    }
    var pair = { e: icon(false), w: icon(true), size: vb[2] / 64, above: an[1] - vb[1] };
    return Promise.all([pair.e, pair.w].map(function (ic) {
      var img = new Image();
      img.src = ic.url;
      return img.decode();
    })).then(function () { return pair; });
  }

  // An animated sprite (Bonfire Night's fireworks, Neil, 5 Nov) also has a
  // strip of still frames baked from Design's animation: frames.count frames
  // side by side, each the top-level <g> of its file and vb wide, played in a
  // loop over frames.period seconds of real time, whatever the replay's
  // speed. They go onto one picture for the map, drawn and mirrored, before
  // the day uses them. Each bus starts the loop at its own frame, so the
  // fireworks don't all go off together. If the strip can't be had, or the
  // reader has asked for less motion, the sprite stays still.
  var FILM_PAD = 8;                        // pixels between frames on the picture
  function specialFilm(name, s, text) {
    var f = s.frames, vb = s.vb, an = s.anchor, k = 2;
    var cells = Array.prototype.slice.call(plainSvg(name, text).children);
    if (!f || !(f.count > 0) || f.count !== cells.length || !(f.period > 0)) throw new Error('sprite ' + name + ': frames do not match');
    var cw = vb[2] * k, ch = vb[3] * k, n = f.count;
    return Promise.all(cells.map(function (g, i) {
      var img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + [vb[0] + i * vb[2], vb[1], vb[2], vb[3]].join(' ') +
        '" width="' + cw + '" height="' + ch + '">' + g.outerHTML + '</svg>');
      return img.decode().then(function () { return img; });
    })).then(function (imgs) {
      var cols = Math.max(1, Math.floor(2048 / (cw + FILM_PAD)));
      var canvas = document.createElement('canvas');
      canvas.width = cols * (cw + FILM_PAD);
      canvas.height = Math.ceil(2 * n / cols) * (ch + FILM_PAD);
      var g = canvas.getContext('2d'), mapping = {};
      var ax = (an[0] - vb[0]) * k, ay = (an[1] - vb[1]) * k;
      imgs.forEach(function (img, i) {
        [false, true].forEach(function (flip) {
          var c = (flip ? n : 0) + i, x = (c % cols) * (cw + FILM_PAD), y = Math.floor(c / cols) * (ch + FILM_PAD);
          g.setTransform(flip ? -1 : 1, 0, 0, 1, flip ? x + cw : x, y);
          g.drawImage(img, 0, 0, cw, ch);
          mapping[(flip ? 'w' : 'e') + i] = { x: x, y: y, width: cw, height: ch,
                                              anchorX: flip ? cw - ax : ax, anchorY: ay };
        });
      });
      g.getImageData(0, 0, 1, 1);            // throws if the browser won't let the map have it
      return { atlas: canvas, mapping: mapping, count: n, period: f.period };
    });
  }
  function stillPlease() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  // Which frame a bus shows: the loop's frame now, moved on by the bus's own
  // (from its colour slot, so a bus keeps its place in the loop as others join).
  function filmTick(film) {
    return Math.floor(performance.now() / 1000 / film.period * film.count);
  }
  function filmIcon(film, d, tick) {
    return (facing.get(d.reg) < 0 ? 'w' : 'e') + ((tick + slots.get(d.reg) * 7) % film.count);
  }

  function loadSpecials(payload) {
    special = null;
    var mine = cur;
    var want = payload && payload.specials;
    if (!want || typeof want !== 'object' || !want.sprites || typeof want.sprites !== 'object') return;
    specialsCat = specialsCat || fetch(SPRITES + 'specials.json', { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('specials.json: HTTP ' + r.status);
      return r.json();
    });
    specialsCat.then(function (cat) {
      if (!cat || cat.format !== 'ng-bus-specials' || !cat.sprites) throw new Error('specials.json: not a catalogue');
      var decks = Object.keys(want.sprites).filter(function (dk) { return dk === 'dd' || dk === 'sd' || dk === 'td'; });
      return Promise.all(decks.map(function (dk) {
        var name = String(want.sprites[dk]), s = cat.sprites[name];
        if (!s || !/^[a-z0-9-]+\.svg$/.test(s.file || '')) return null;   // this deck: ordinary buses
        return fetch(SPRITES + s.file, { cache: 'no-cache' }).then(function (r) {
          if (!r.ok) throw new Error(s.file + ': HTTP ' + r.status);
          return r.text();
        }).then(function (text) { return specialSprite(name, s, text); })
          .then(function (pair) {
            pair.dk = dk;
            if (!s.frames || !/^[a-z0-9-]+\.svg$/.test(s.frames.file || '') || stillPlease() ||
                dk !== specialDeck(payload.route, want.sprites)) return pair;   // only this route's deck moves
            return fetch(SPRITES + s.frames.file, { cache: 'no-cache' }).then(function (r) {
              if (!r.ok) throw new Error(s.frames.file + ': HTTP ' + r.status);
              return r.text();
            }).then(function (text) { return specialFilm(name, s, text); })
              .then(function (film) { pair.film = film; return pair; }, function () { return pair; });
          })
          .catch(function () { return null; });
      }));
    }).then(function (pairs) {
      if (cur !== mine) return;                                // moved on meanwhile (a refresh is not a move)
      var icons = {}, n = 0;
      pairs.forEach(function (p) { if (p) { icons[p.dk] = p; n++; } });
      if (!n) return;
      var own = DECK_CODE[busKind(payload.route)], wear = specialDeck(payload.route, want.sprites);
      if (wear !== own && icons[wear]) icons[own] = icons[wear];   // a night route in its own deck's sprite
      special = { name: String(want.name || ''), key: String(want.occasion || '') + payload.date, icons: icons };
      render();
    }).catch(function () {
      specialsCat = null;                                      // try again on the next day opened
      special = null;
    });
  }

  // TfL notices for the route (ngbus-notices.js; spec: E:\Road Data\docs\
  // superpowers\specs\2026-10-17-tfl-notices-design.md, section 3). The
  // panel lists those in force on the day being watched, closed stops are
  // drawn hollow, and the date strip marks days with one.
  var NN = window.NgbusNotices;
  var NWORDS = {};
  try { NWORDS = JSON.parse(($('ngbus-notices-words') || {}).textContent || '{}'); } catch (e) {}
  var closedStops = [];      // drawn over the day's own stops, by stopLayers
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
  var cur = null;            // {payload, bytes, E, source, t0, t1}: one per day opened
  var simT = 0;              // seconds after cur.t0
  var playing = true;
  var speed = 60;
  var lastFrame = performance.now();
  var counts = null;         // buses seen per minute (timeline)
  var tlBase = null;         // pre-drawn timeline, playhead added per frame
  var mapMode = 'dark';
  var staticLayers = [];
  var markLayers = [];       // the worst-gap stop, when a link named one
  var trips = [];            // the trails, {reg, path, timestamps}
  var slots = new Map();     // registration -> colour slot (R.colourIndex)
  var colors = new Map();    // registration -> [r, g, b], from its slot

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

  /* ---- stops, and the card that says what something is --------------------- */

  // Stops are red, the buses' red, and closer in than STOP_LETTER_ZOOM each
  // grows into a disc carrying its flag letter, as on the pole (Neil, 2 Nov).
  // Tap a stop or a bus and a card says what it is: "Wallington Town Centre
  // / J", or a bus's registration and destination. On a phone there is no
  // hover, so the card stays put, beside the stop or going with the bus,
  // until a tap somewhere else; on a computer a click does the same, and
  // hovering shows the same words as a tooltip. Days exported before stops
  // carried letters (and files saved from them) give the name alone.
  var STOP_LETTER_ZOOM = 15;
  var STOP_RED = [214, 52, 44, 255];       // #D6342C, the buses' red
  var STOP_EDGE = [243, 246, 244, 255];    // the buses' window white
  var lettered = [];                       // the day's stops that have a letter
  var pinned = null;                       // {stop: object} or {reg: registration}
  var lastBuses = [];                      // the buses as last drawn, to find a pinned one
  var touched = false;                     // the last pointer was a finger: no hover tooltips
  var TIP_STYLE = {                        // the hover tooltip, dressed as the card (#card)
    background: '#1A2332', color: '#F3F6F4', fontFamily: "'DM Sans', system-ui, sans-serif",
    fontSize: '13px', lineHeight: '1.35', fontWeight: '600', padding: '7px 10px',
    borderRadius: '6px', boxShadow: '0 2px 10px rgba(0,0,0,.45)',
  };

  function stopLetter(s) {
    return s && typeof s.letter === 'string' && /^[A-Z0-9]{1,3}$/.test(s.letter) ? s.letter : '';
  }
  function stopName(s) {
    var l = stopLetter(s);
    return cleanName(s.name) + (l ? ' / ' + l : '');
  }
  function busText(o) {
    var dressed = cur && special && specialIcon(busKind(cur.payload.route), o);
    return R.plate(o.reg) + '\n' + (o.dead ? 'not in service: ' : 'to ') + cleanName(o.blind) +
      (dressed && special.name ? '\n' + special.name + ' bus' : '') +
      (o.held ? '\nlast report ' + ago(o.age) : '');       // only a live day holds a bus
  }
  function cardText(o) {
    if (o.reg) return busText(o);
    if (o.closed) return stopName(o) + ' \u2014 ' + (NWORDS.replay_closed || 'closed (TfL)');
    return o.name ? stopName(o) : '';
  }
  function isPinned(o) {
    return !!pinned && (o.reg ? pinned.reg === o.reg : pinned.stop === o);
  }

  var stopsNear = null;                    // how the stops were last drawn
  function stopLayers(p) {
    var near = stopsNear = currentCam().zoom >= STOP_LETTER_ZOOM;
    var pos = function (d) { return [d.lon, d.lat]; };
    var out = [new deck.ScatterplotLayer({
      id: 'stops-' + p.route + p.date, data: p.stops || [], getPosition: pos, pickable: true,
      stroked: true, filled: true, radiusUnits: 'pixels', lineWidthUnits: 'pixels',
      getRadius: near ? 9 : 4.5, getLineWidth: near ? 1.5 : 1,
      getFillColor: STOP_RED, getLineColor: STOP_EDGE,
      updateTriggers: { getRadius: near, getLineWidth: near },
    })];
    if (near && lettered.length) out.push(new deck.TextLayer({
      id: 'stop-letters-' + p.route + p.date, data: lettered, getPosition: pos,
      getText: stopLetter, getSize: function (d) { return d.letter.length > 1 ? 9 : 11; },
      getColor: STOP_EDGE, fontFamily: 'DM Sans, system-ui, sans-serif', fontWeight: 700,
      getTextAnchor: 'middle', getAlignmentBaseline: 'center',
    }));
    // TfL's closed stops, hollow, a size up so each covers its red stop
    if (closedStops.length) out.push(new deck.ScatterplotLayer({
      id: 'closed-' + p.route + p.date, data: closedStops, getPosition: pos, pickable: true,
      stroked: true, filled: true, radiusUnits: 'pixels', lineWidthUnits: 'pixels',
      getRadius: near ? 10 : 5.5, getLineWidth: 2,
      getFillColor: [17, 17, 17, 255], getLineColor: [150, 150, 150, 255],
      updateTriggers: { getRadius: near },
    }));
    return out;
  }

  // The card sits just above what it names, moved on every frame drawn.
  function placeCard() {
    var card = el.card;
    if (!card) return;
    var o = pinned && pinned.stop, lift = 14;
    if (pinned && pinned.reg) {
      for (var i = 0; i < lastBuses.length && !o; i++) if (lastBuses[i].reg === pinned.reg) o = lastBuses[i];
      if (!o) pinned = null;                 // its day's journeys are over
      else {
        var kind = busKind(cur.payload.route), sp = specialIcon(kind, o);
        lift = busStyle !== 'buses' ? 18 :
          Math.round((sp ? ICON_W * sp.above / 64 : ICON_W * NB.aspect(kind)) + 22);
      }
    }
    var vp = o && currentCam();
    if (!o || !vp.project) { card.hidden = true; return; }
    var xy = vp.project(o.position || [o.lon, o.lat]);
    card.textContent = cardText(o);
    card.style.left = Math.round(xy[0]) + 'px';
    card.style.top = Math.round(xy[1] - lift) + 'px';
    card.hidden = false;
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
    pickingRadius: 6,                      // a stop is small for a fingertip
    getTooltip: function (info) {
      var o = info.object;
      if (!o || touched || isPinned(o)) return null;   // a tap gets the card instead
      var text = cardText(o);
      return text ? { text: text, style: TIP_STYLE } : null;
    },
    onClick: function (info) {
      var o = info.object;
      pinned = !o ? null : o.reg ? { reg: o.reg } : o.name ? { stop: o } : null;
      placeCard();
    },
    onAfterRender: function () {
      syncBasemap();
      placeCard();
      // Zoomed across STOP_LETTER_ZOOM while paused: draw the stops again
      // (playing, the next frame does).
      if (cur && !playing && stopsNear !== null &&
          (currentCam().zoom >= STOP_LETTER_ZOOM) !== stopsNear) requestAnimationFrame(render);
    },
  });
  ['pointerdown', 'pointermove'].forEach(function (t) {
    $('map').addEventListener(t, function (e) { touched = e.pointerType === 'touch'; }, true);
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
    var hits = markLayersFor(payload, at);
    if (!hits) return false;
    var lon = hits.reduce(function (a, s) { return a + s.lon; }, 0) / hits.length;
    var lat = hits.reduce(function (a, s) { return a + s.lat; }, 0) / hits.length;
    fitBox(lon - 0.008, lat - 0.005, lon + 0.008, lat + 0.005, 15.5);
    el.badge.hidden = false;
    el.badge.textContent = (gap ? 'The ' + gap + '-minute gap' : 'The gap') +
      ' at ' + cleanName(at) + (t ? ', from ' + t : '') +
      '. The ring marks the stop; press play to watch it build.';
    return true;
  }

  // The ring and label at every stop named `at` (markLayers): the stops it
  // marks, or null for none.
  function markLayersFor(payload, at) {
    markLayers = [];
    if (!at) return null;
    var want = cleanName(at).toLowerCase();
    var hits = (payload.stops || []).filter(function (s) {
      return cleanName(s.name).toLowerCase() === want;
    });
    if (!hits.length) return null;
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
    return hits;
  }

  /* ---- a day arrives ----------------------------------------------------- */

  // A new day: the last day's buses, pin, badge and notices go, the camera
  // fits the route (unless this route and source are already shown), and the
  // clock starts where the day gets going, or where the link says. A live
  // day (opts.live: its service window {date, t0, t1}, from the head) starts
  // at the live edge unless the reader asked to start back.
  function start(payload, opts) {
    var prevRoute = cur && cur.payload.route;
    var prevSource = cur && cur.source;
    var was = cur;
    cur = { payload: payload, bytes: opts.bytes, source: opts.source };
    if (opts.live) { cur.live = opts.live; cur.liveInfo = opts.liveInfo || null; }
    try {
      refresh(payload, false, opts.live);
    } catch (e) {
      if (!cur.E) cur = was;           // a day that will not expand leaves the one shown as it was
      throw e;
    }
    var span = cur.t1 - cur.t0;
    facing = new Map(); lastX = new Map(); lastT = null; iconCache = {};
    loadSpecials(payload);
    staticLayers = routeLayers(payload);
    lettered = (payload.stops || []).filter(stopLetter);   // the stops: stopLayers, per frame
    pinned = null; lastBuses = [];

    el.badge.hidden = true;
    var marked = markStop(payload, opts.at, opts.gap, opts.t);
    if (marked && opts.live) cur.markAt = opts.at;           // redrawn if a live refresh moves the stops
    if (!marked && (prevRoute !== payload.route || camSource(prevSource) !== camSource(opts.source))) fitTo(payload);

    cur.liveTag = !!opts.live;
    setTitle();
    setBack(payload.route);
    if (!Array.prototype.some.call(el.route.options, function (o) { return o.value === payload.route; })) {
      var o = document.createElement('option');
      o.value = payload.route; o.textContent = payload.route + ' (your file)';
      el.route.appendChild(o);
    }
    el.route.value = payload.route;
    el.save.disabled = opts.source === 'live';             // a live day is not finished: nothing to keep yet
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
        if (e < cur.t0 && e + 86400 <= cur.t1) e += 86400;   // after midnight
        simT = Math.max(0, Math.min(span, e - cur.t0));
      }
    }
    if (opts.live) simT = live.pinned ? liveEdge() : Math.min(simT, liveEdge());
    drawTimelineBase();
    closedStops = [];
    if (el.notices) { el.notices.hidden = true; el.notices.innerHTML = ''; }
    el.hud.classList.remove('has-notices');
    renderDays();
    applyNotices(payload);
    updateURL(marked ? opts : null);
    say('');
    if (LIVE) liveDayShown();
    render();
    if (opts.source === 'server') prefetchAround(payload.route, payload.date);
  }

  // A live day and a server day of one route are one source to the camera:
  // stepping between them keeps the view.
  function camSource(s) { return s === 'live' ? 'server' : s; }

  // The route's drawn line, under everything else.
  function routeLayers(payload) {
    return [
      new deck.PathLayer({
        id: 'route-' + payload.route + payload.date, data: payload.shapes,
        getPath: function (d) { return d.path; }, getColor: [255, 255, 255, 60],
        getWidth: 12, widthMinPixels: 2, widthMaxPixels: 6,
      }),
    ];
  }

  /* The day's data, rebuilt from payload in place: cur.E, the trails, the
   * timeline's counts, each bus's colour, and the time base cur.t0/cur.t1.
   * Nothing else moves: not the camera, not simT, not a pinned bus, and the
   * notices are not loaded again, so a day can grow under the reader (the
   * live day). keep: each registration keeps its colour, and one new to the
   * day takes the next slot (R.colourIndex); without it, colours are dealt
   * afresh in the payload's order, as for a new day. It draws nothing: the
   * caller draws the timeline (drawTimelineBase) and the frame (render). The
   * route's line and the stops' letters are start's (a live refresh that
   * changes them redraws them: liveRedraw).
   *
   * It is all or nothing: everything is worked out first and only then put
   * in place, so a payload that throws anywhere changes nothing, and the day
   * shown (on a live day, the last good merge) stays as it was.
   *
   * cur.t0 is the payload's t0: R.expand times every point from it, and simT
   * counts from it. cur.t1 is the payload's t1 for a day from the server or
   * a file; on a live day, win ({t0, t1}, the head's service window) gives
   * cur.t0 and cur.t1 instead, the whole day, while the payload's own t1 is
   * its last ping. */
  function refresh(payload, keep, win) {
    var E = R.expand(payload);
    var t0 = payload.t0, t1 = win ? win.t1 : payload.t1;
    if (win && win.t0 !== t0) {
      throw new Error('the live day starts at ' + win.t0 + ' but its payload at ' + t0);
    }
    var nCounts = R.inServiceByMinute(E, t1 - t0);
    var nSlots = R.colourIndex(E.vehicles.map(function (v) { return v.reg; }), keep ? slots : null);
    var nColors = new Map();
    nSlots.forEach(function (i, reg) { nColors.set(reg, hsl2rgb((i * 137.5) % 360, 0.75, 0.6)); });
    var nTrips = E.segs.map(function (s) {
      var path = new Array(s.lon.length);
      for (var i = 0; i < path.length; i++) path[i] = [s.lon[i], s.lat[i]];
      return { reg: E.vehicles[s.vi].reg, path: path, timestamps: Array.from(s.t) };
    });
    cur.payload = payload;             // all in hand: only now does anything change
    cur.E = E;
    cur.t0 = t0;
    cur.t1 = t1;
    counts = nCounts;
    slots = nSlots;
    colors = nColors;
    trips = nTrips;
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
    var route = payload.route, day = payload.date, mine = cur;
    NN.load(DATA_ROOT, route).then(function (f) {
      if (cur !== mine) return;                              // moved on meanwhile (a refresh is not a move)
      var items = f ? f.notices.concat(f.closures) : [];
      var w = NN.serviceDay(day);
      var live = items.filter(function (it) { return NN.inEffect(it, w[0], w[1]); });
      var closed = live.filter(function (it) { return it.atco != null && it.lon != null; });
      var byId = {};                                         // a closed stop's letter
      (payload.stops || []).forEach(function (s) { if (s.id) byId[s.id] = s; });
      closedStops = closed.map(function (c) {
        return { name: c.name, letter: stopLetter(byId[c.atco]), lon: c.lon, lat: c.lat, closed: true,
                 atco: c.atco };
      });
      // A pinned closed stop is held by identity: on a live refresh these are
      // new objects, so find it again by its stop code, or let it go.
      if (pinned && pinned.stop && pinned.stop.closed) {
        var again = closedStops.filter(function (s) { return s.atco === pinned.stop.atco; })[0];
        pinned = again ? { stop: again } : null;
      }
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
      el.hud.classList.toggle('has-notices', !!(notes.length || closed.length));
      // the date strip: every day with a NOTICE in force (closed stops are
      // drawn on the map instead; a long closure would mark every day)
      var marks = {};
      var notices = f ? f.notices : [];
      stripDates(route).forEach(function (d) {
        var dw = NN.serviceDay(d);
        if (notices.some(function (it) { return NN.inEffect(it, dw[0], dw[1]); })) marks[d] = true;
      });
      noticeMarks = { route: route, days: marks };
      renderDays();
      render();
    }).catch(function () { /* no panel: the replay stands without it */ });
  }

  // The heading and the tab title. The day shown is "today" when its date is
  // today's in London (by the server's clock on the live page): no date, no
  // "live". Any other day keeps its date. Re-run by a timer, so a day change
  // under the viewer (the 05:00 handover, midnight) updates it too.
  function londonToday() {
    return new Date((LIVE ? serverNow() : Date.now() / 1000) * 1000).toLocaleDateString('en-CA', { timeZone: TZ });
  }
  function setTitle() {
    if (!cur) return;
    var payload = cur.payload, h, t;
    if (payload.date === londonToday()) {
      h = 'Route ' + payload.route + ' \u00b7 today';
      t = 'Route ' + payload.route + ', today: bus replay \u2014 Neil Garratt';
    } else {
      var liveTag = cur.liveTag ? ' \u00b7 live' : '';
      h = 'Route ' + payload.route + ' \u00b7 ' + fmtDay(payload.date, { year: 'numeric' }) + liveTag;
      t = 'Route ' + payload.route + ', ' + fmtDay(payload.date, { year: 'numeric' }) +
        liveTag + ': bus replay \u2014 Neil Garratt';
    }
    if (el.title.textContent !== h) el.title.textContent = h;
    if (document.title !== t) document.title = t;
  }
  setInterval(setTitle, 15000);

  function setBack(route) {
    if (LIVE) {
      el.back.href = '/labs/delay-replay/';
      el.back.textContent = '\u2190 Delay Replay';
    } else if (route && PAGES[route.toUpperCase()]) {
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
    if (cur && (cur.source === 'server' || cur.source === 'live')) {
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
    var listed = cur && (cur.source === 'server' || cur.source === 'live');
    var key = listed ? cur.payload.route : resolveRoute(el.route.value);
    var dates = key ? stripDates(key) : [];
    var liveSet = {};                                      // live mode: the head's days
    if (LIVE) {
      var ld = key ? liveDates(key) : [];
      ld.forEach(function (iso) { liveSet[iso] = true; });
      live.shownDates = ld.join(',');
    }
    var curIso = cur && cur.payload.date;
    el.daylabel.textContent = curIso ? fmtDay(curIso) : '';
    var inList = curIso && dates.indexOf(curIso) !== -1 && listed;
    el.prev.disabled = !inList || dates.indexOf(curIso) === 0;
    el.next.disabled = !inList || dates.indexOf(curIso) === dates.length - 1;
    if (!dates.length) return;
    var entries = routeDays[key] || {};
    for (var iso = dates[0]; iso <= dates[dates.length - 1]; iso = addDays(iso, 1)) {
      var b = document.createElement('button');
      b.className = 'day';
      var d = new Date(iso + 'T12:00:00Z');
      b.innerHTML = '<span class="wd">' + 'SMTWTFS'[d.getUTCDay()] + '</span>' + d.getUTCDate();
      var rec = entries[iso];
      if (liveSet[iso]) {
        // The day so far, from the live files: the head's until the
        // production replay lists it, even once i/ has it too.
        b.classList.add('live');
        b.insertAdjacentHTML('beforeend', '<span class="livedot" aria-hidden="true"></span>');
        b.title = fmtDay(iso, { year: 'numeric' }) + ' · live: the day so far';
        if (noticeMarks.route === key && noticeMarks.days[iso]) {
          b.insertAdjacentHTML('beforeend', '<span class="nmark" aria-hidden="true"></span>');
          b.title += ' · ' + (NWORDS.replay_day_mark || 'TfL notice in force');
        }
        b.onclick = (function (i) { return function () { openLiveDay(key, i); }; })(iso);
        if (cur && cur.live && cur.live.date === iso) b.classList.add('cur');
      } else if (rec) {
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
        if (iso === curIso && listed) b.classList.add('cur');
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
    if (!cur || (cur.source !== 'server' && cur.source !== 'live')) return;
    var dates = stripDates(cur.payload.route);
    var i = dates.indexOf(cur.payload.date) + n;
    if (i >= 0 && i < dates.length) openDay(cur.payload.route, dates[i]);
  }

  // A day of a route: from the live files while the head lists it, else
  // from the server.
  function openDay(key, iso, opts) {
    if (LIVE && isLiveDate(key, iso)) openLiveDay(key, iso, opts);
    else loadServerDay(key, iso, opts);
  }

  /* ---- timeline ----------------------------------------------------------- */

  function drawTimelineBase() {
    // hidden while the panel is collapsed: nothing to size, and redrawn on expanding
    if (!el.timeline.clientHeight) { tlBase = null; return; }
    var c = el.tl, dpr = window.devicePixelRatio || 1;
    var w = Math.max(1, el.timeline.clientWidth), h = el.timeline.clientHeight;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    tlBase = document.createElement('canvas');
    tlBase.width = c.width; tlBase.height = c.height;
    var g = tlBase.getContext('2d');
    g.scale(dpr, dpr);
    g.fillStyle = '#1c1f24'; g.fillRect(0, 0, w, h);
    if (!cur) return;
    var p = cur.payload, t0 = cur.t0, t1 = cur.t1, span = t1 - t0;
    // hour ticks, London time
    g.fillStyle = '#2c3138';
    var firstHour = Math.ceil(t0 / 3600) * 3600;
    for (var t = firstHour; t <= t1; t += 3600) {
      var x = (t - t0) / span * w;
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
      var x0 = Math.max(0, (hole[0] - t0) / span * w);
      var x1 = Math.min(w, (hole[1] - t0) / span * w);
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
    if (cur.live) liveHours(g, w, t0, span);
  }

  function drawTimeline() {
    if (!tlBase || !cur) return;
    var c = el.tl, g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(tlBase, 0, 0);
    var span = cur.t1 - cur.t0;
    if (cur.live) liveFuture(g, c, span);
    var x = Math.round(simT / span * c.width);
    g.fillStyle = '#fff';
    g.fillRect(x - 1, 0, 2 * (window.devicePixelRatio || 1), c.height);
  }

  function scrubTo(clientX) {
    if (!cur) return;
    var r = el.timeline.getBoundingClientRect();
    var f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    simT = f * (cur.t1 - cur.t0);
    if (LIVE) liveScrubbed();
    render();
  }

  /* ---- the frame ---------------------------------------------------------- */

  function holeAt(epoch) {
    var hs = (cur && cur.payload.holes) || [];
    for (var i = 0; i < hs.length; i++) if (hs[i][0] <= epoch && epoch < hs[i][1]) return hs[i];
    return null;
  }

  function specialKey() { return special ? special.key : ''; }

  var filmShown = null, filmShownTick = -1;   // the animated sprite last drawn, and its frame

  function render() {
    if (!cur) return;
    var p = cur.payload, E = cur.E;
    var hold = liveHold();                 // a running live day only: hold, never extrapolate
    var buses = R.positionsAt(E, p.blinds, simT, hold);
    var latest = !!hold && liveLatest();   // every bus at its last report, its age shown
    if (latest) liveGlide(buses, E, p);
    else if (hold) liveCatchUp(buses, E, p);   // Smooth: a late ping glides, not jumps
    var icons = busStyle === 'buses', kind = busKind(p.route);
    if (icons) updateFacing(buses);
    lastBuses = buses;
    var sp = icons && special && special.icons[DECK_CODE[kind]] || null;
    var film = filmShown = sp && sp.film || null, tick = filmShownTick = film ? filmTick(film) : -1;
    deckgl.setProps({ layers: staticLayers.concat(markLayers, [
      new deck.TripsLayer({
        id: 'trails', data: trips,
        getPath: function (d) { return d.path; },
        getTimestamps: function (d) { return d.timestamps; },
        getColor: function (d) { return colors.get(d.reg); },
        currentTime: simT, trailLength: TRAIL_S,
        widthMinPixels: 3, opacity: 0.6, fadeTrail: true,
      }),
    ], stopLayers(p), [                    // over the trails, so a letter stays clear
      icons ? new deck.IconLayer({
        id: 'bus-icons', pickable: true,
        data: film ? buses.filter(function (b) { return b.dead; }) : buses,   // the rest are on film
        getPosition: function (d) { return d.position; },
        getIcon: function (d) { return busIcon(kind, d); },
        sizeUnits: 'pixels', sizeBasis: 'width',
        getSize: function (d) { var sp = specialIcon(kind, d); return sp ? ICON_W * sp.size : ICON_W; },
        updateTriggers: { getPosition: simT, getIcon: [simT, kind, specialKey()], getSize: [simT, kind, specialKey()] },
      }) : new deck.ScatterplotLayer({
        id: 'buses', data: buses, pickable: true,
        getPosition: function (d) { return d.position; },
        getFillColor: function (d) { return d.dead ? [130, 130, 130, 220] : colors.get(d.reg).concat(255); },
        getLineColor: [255, 255, 255, 200], getLineWidth: 2, lineWidthUnits: 'pixels',
        stroked: true, getRadius: 40, radiusMinPixels: 5, radiusMaxPixels: 12,
        updateTriggers: { getPosition: simT, getFillColor: simT },
      }),
    ], film ? [new deck.IconLayer({
      id: 'bus-film', pickable: true,
      data: buses.filter(function (b) { return !b.dead; }),
      iconAtlas: film.atlas, iconMapping: film.mapping,
      getPosition: function (d) { return d.position; },
      getIcon: function (d) { return filmIcon(film, d, tick); },
      sizeUnits: 'pixels', sizeBasis: 'width', getSize: ICON_W * sp.size,
      updateTriggers: { getPosition: simT, getIcon: [simT, tick] },
    })] : [], [
      new deck.TextLayer(labelProps(buses, icons, kind, latest)),
    ]) });
    var now = cur.t0 + simT;
    el.clock.textContent = fmtClock(now);
    var dead = buses.filter(function (b) { return b.dead; }).length;
    el.meta.textContent = (buses.length - dead) + ' in service \u00b7 ' + dead +
      ' not in service \u00b7 ' + E.vehicles.length + (cur.live ? ' vehicles so far' : ' vehicles all day');
    el.slider.value = Math.round(1000 * simT / (cur.t1 - cur.t0));
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
    if (LIVE) liveFrame(buses);
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // The registrations over the buses. In Latest each also says how old its
  // report is, on a second line, so the block grows upwards off the bus.
  function labelProps(buses, icons, kind, latest) {
    var props = {
      id: 'labels', data: buses,
      getPosition: function (d) { return d.position; },
      getText: function (d) { return R.plate(d.reg); },
      getColor: [255, 255, 255, 200], getSize: 11,
      getPixelOffset: !icons ? [0, -16] : function (d) {
        var sp = specialIcon(kind, d);
        return [0, -Math.round(sp ? ICON_W * sp.above / 64 + 5 : ICON_W * NB.aspect(kind) + 5)];
      },
      fontFamily: 'DM Sans, system-ui, sans-serif',
      updateTriggers: { getPosition: simT, getPixelOffset: [simT, icons, kind, specialKey()] },
    };
    if (latest) {
      var off = props.getPixelOffset;
      props.getText = function (d) { return R.plate(d.reg) + '\n' + ago(d.age); };
      props.getAlignmentBaseline = 'bottom';
      props.getPixelOffset = function (d) {           // the first line's centre, as before, less half a line
        var o = typeof off === 'function' ? off(d) : off;
        return [o[0], o[1] + 6];
      };
      props.updateTriggers.getText = Math.floor(simT);
    }
    return props;
  }

  function tick(now) {
    requestAnimationFrame(tick);           // first: a throw below must never stop the loop
    try {
      if (LIVE && liveRunning()) {
        liveStep(now);                     // the live day: at the edge, or catching up to it
      } else if (LIVE && liveEnding()) {
        liveEnd(now);                      // its window just ended: hand over, or hold (Ruling 12)
      } else if (playing && cur) {
        // Cap the step: a frame that stalled (shader compile, background tab)
        // must not throw the replay minutes forward.
        simT += speed * Math.min(250, now - lastFrame) / 1000;
        if (simT > cur.t1 - cur.t0) simT = 0;
        render();
      } else if (cur && filmShown && filmTick(filmShown) !== filmShownTick) {
        render();                          // paused, the fireworks still go off
      }
    } catch (e) {
      loopFault(e);
    } finally {
      lastFrame = now;
    }
  }

  // A frame that throws: said once (per message) on the console, and on a
  // live page in the overlay too. The next frame tries again.
  var lastLoopFault = '';
  function loopFault(e) {
    var msg = (e && e.message) || String(e);
    if (msg !== lastLoopFault) { lastLoopFault = msg; console.error('replay: drawing failed:', e); }
    if (LIVE) liveFault(e, 'drawing');
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
    u.searchParams.set('t', fmtHM(cur.t0 + simT));
    if (speed !== 60) u.searchParams.set('speed', speed);
    var text = u.toString();
    var note = cur.source === 'file'
      ? ' (it opens the server copy, which may since have been removed)' : '';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { say('Link copied: route ' + cur.payload.route + ' at ' + fmtHM(cur.t0 + simT) + note + '.'); },
        function () { window.prompt('Copy this link:', text); });
    } else {
      window.prompt('Copy this link:', text);
    }
  }

  /* ---- live mode (the lab page only) -------------------------------------- */

  // The Delay Replay pilot (Road Data docs/superpowers/specs/2026-11-06-
  // delay-replay-pilot-design.md, section 4). For the pilot routes, NRG-1's
  // live writer (platform/live_bods.py) publishes under LIVE_ROOT:
  //   t/p.json.gz          the head, every 10 s: the last ten minutes of every
  //                        bus, and the keys of the two below (max-age=5)
  //   r/p/<time>.json.gz   recent: everything since `upto` (immutable)
  //   d/<R>/<date>/<md5>   the day so far, to upto: a v1 day file (immutable)
  // The live day is the three merged (R.mergeLive), drawn across its whole
  // service window, and it never loops. At the live edge the cursor is
  // server-now less the delay (Smooth: buses glide between real reports) or
  // server-now itself (Latest: every bus at its last report, a new one
  // reached by a brief glide along the road). A bus past its last ping is
  // held there while it is still reported on the route (R.positionsAt's
  // hold), never extrapolated. Scrubbed back, the day plays at the chosen
  // speed and rejoins the edge, at 1x, when it gets there. Earlier days come
  // from the Worker, exactly as on the production page. Nothing here runs
  // unless LIVE.

  var DEFAULT_DELAY_S = 120;     // Viewer Ruling 4: Smooth's delay, until the dry run measures it
  var LIVE_HEAD = 't/p.json.gz';
  var LIVE_FETCH_MS = 15000;     // a live fetch slower than this is given up, and tried again
  var NOT_YET = 'not yet available';
  var HOUR_COLOUR = { signed: '#8fb3d9', compacted: '#4f6a85', live: '#E0A24E' };

  var live = !LIVE ? null : {
    clock: null,                 // R.liveClock: server-now, from the heads' Date headers
    head: null,                  // the newest head
    files: new Map(),            // r/ and d/ key -> its object: immutable, so fetched once and kept
    getting: new Map(),          // key -> its fetch in flight
    route: null,                 // the route whose live days are merged
    days: new Map(),             // date -> its last good merge {inputs, payload, head, win, hours, upto}
    chain: Promise.resolve(),    // merges, one at a time
    mode: 'latest',              // 'smooth' only for ?mode=smooth (a lab comparison)
    delay: DEFAULT_DELAY_S,
    pinned: true,                // at the live edge, or scrubbed back
    back: false,                 // ?live=0: the first live day opened starts scrubbed back
    glide: new Map(),            // Latest: registration -> R.latestGlide state
    smooth: null,                // Smooth: R.smoothStep's state (held buses, glides under way)
    cause: null,                 // since the last frame: 'data' (a refresh landed) or 'jump' (the
                                 // reader moved the cursor, the day or the mode)
    handing: null,               // the live day being handed over to (Ruling 12), while it loads
    poll: { text: 'not yet', at: null }, error: null, errorAt: null,
    timer: null, polling: null, first: null, pending: null,
    shownDates: '', ctl: '', overlayAt: 0,
  };
  var STALE_REASON = 'a live file did not arrive';

  function serverNow() { return live.clock ? live.clock.now(performance.now()) : Date.now() / 1000; }
  function liveDelay() { return live.mode === 'latest' ? 0 : live.delay; }

  // A live day still running at the cursor's edge. Once its service window
  // is behind the edge (D-1 after 05:00) it has ended: see liveEnd.
  function liveRunning() {
    return !!(LIVE && cur && cur.live && live.clock && serverNow() - liveDelay() < cur.t1);
  }
  // A live day whose window has ended, not (yet) left to loop as a past day.
  function liveEnding() {
    return !!(cur && cur.live && live.clock && cur.liveEnd !== 'loop');
  }
  function liveJump() { live.cause = 'jump'; }   // every bus placed directly next frame
  function liveEdge() {           // the live edge, as simT
    return Math.max(0, Math.min(cur.t1 - cur.t0, serverNow() - liveDelay() - cur.t0));
  }
  function liveHold() {
    if (!liveRunning()) return undefined;
    return { seen: (cur.payload.live && cur.payload.live.seen) || {}, t0: cur.t0, maxGap: 900,
             edge: live.head ? live.head.to : undefined };
  }
  function liveLatest() { return live.mode === 'latest' && live.pinned && liveRunning(); }

  function ago(s) {
    s = Math.max(0, Math.round(s));
    return s < 90 ? s + ' s ago' : Math.round(s / 60) + ' min ago';
  }
  function lagText(s) {
    var a = Math.round(Math.abs(s)), r = a % 60;
    return (s < -0.5 ? '-' : '') + Math.floor(a / 60) + ':' + (r < 10 ? '0' : '') + r;
  }

  function liveHasRoute(key) {
    return !!(LIVE && key && live.head && live.head.routes &&
              Object.prototype.hasOwnProperty.call(live.head.routes, key));
  }
  function liveDates(key) {       // the head's days for this route
    if (!liveHasRoute(key)) return [];
    return R.liveDays(live.head, [], key).map(function (d) { return d.date; });
  }
  function isLiveDate(key, iso) { return liveDates(key).indexOf(iso) !== -1; }
  // The days the strip shows: the replay index's, and in live mode the head's too.
  function stripDates(key) {
    var dates = availableDates(key);
    if (!LIVE || !liveHasRoute(key)) return dates;
    return R.liveDays(live.head, dates, key).map(function (d) { return d.date; }).sort();
  }

  function liveFault(e, what) {
    var msg = (what ? what + ': ' : '') + ((e && e.message) || String(e));
    if (msg !== live.error) console.error('replay (live): ' + msg);
    live.error = msg;
    live.errorAt = serverNow();
  }

  /* -- fetching -- */

  function fetchLive(key) {       // {res, buf}; given up after LIVE_FETCH_MS
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, LIVE_FETCH_MS);
    return fetch(LIVE_ROOT + key, ctl ? { signal: ctl.signal } : undefined).then(function (res) {
      if (!res.ok) { var e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return res.arrayBuffer().then(function (buf) { return { res: res, buf: buf }; });
    }).finally(function () { clearTimeout(timer); });
  }

  // An r/ or d/ file: once, then kept. A failure is not kept, so the next
  // head that names the key tries it again (R.mergeInputs wants it again).
  function liveFile(key) {
    if (live.files.has(key)) return Promise.resolve(live.files.get(key));
    if (live.getting.has(key)) return live.getting.get(key);
    var day = key.charAt(0) === 'd';
    var p = fetchLive(key).then(function (got) {
      return day ? R.parse(got.buf) : R.parseLive(got.buf);
    }).then(function (obj) {
      if (!day && obj.kind !== 'recent') throw new Error('a ' + obj.kind + ' file, not a recent one');
      live.files.set(key, obj);
      return obj;
    });
    live.getting.set(key, p);
    p.then(function () { live.getting.delete(key); },
           function (e) { live.getting.delete(key); liveFault(e, key); });
    return p;
  }

  // The head, with plain fetch (it is max-age=5), then the files it names
  // and the merge, then the next poll: timed from the head's generated and
  // cadence (R.nextPollAt). The clock is set from the first head's Date
  // header and only ever moved forwards by later ones.
  function livePoll() {
    if (live.polling) return live.polling;
    clearTimeout(live.timer);
    var t = performance.now();
    var p = fetchLive(LIVE_HEAD).then(function (got) {
      var perf = performance.now();
      var date = Date.parse(got.res.headers.get('Date') || '');
      return R.parseLive(got.buf).then(function (head) {
        if (head.kind !== 'head') throw new Error(LIVE_HEAD + ' is a ' + head.kind + ' file, not a head');
        if (!isFinite(date)) {
          liveFault(new Error('no Date header on the head (is it exposed?): this device’s clock is used'));
          date = Date.now();
        }
        if (live.clock) live.clock.correct(date, perf); else live.clock = R.liveClock(date, perf);
        var newer = !live.head || head.generated > live.head.generated;
        if (newer) live.head = head;       // never back to an older copy, as a cache can give
        live.poll = { text: (newer ? 'new head' : 'same head') + ', ' + Math.round(perf - t) + ' ms',
                      at: serverNow() };
        return liveUpdate();
      });
    }).catch(function (e) {
      live.poll = { text: 'failed (' + ((e && e.message) || e) + ')', at: serverNow() };
      console.warn('replay (live): the head: ' + ((e && e.message) || e));
    }).then(function () {
      live.polling = null;
      var n = serverNow(), at = live.head ? R.nextPollAt(live.head, n) : n + 5;
      clearTimeout(live.timer);
      live.timer = setTimeout(livePoll, Math.max(0.5, at - n) * 1000);
      liveStrip();
    });
    live.polling = p;
    if (!live.first) live.first = p;
    return p;
  }

  // After each poll: the strip if the head's days have changed, and a live
  // day that could not be opened yet, tried again.
  function liveStrip() {
    var listed = cur && (cur.source === 'server' || cur.source === 'live');
    var key = listed ? cur.payload.route : resolveRoute(el.route.value);
    if ((key ? liveDates(key).join(',') : '') !== live.shownDates) renderDays();
    liveControls();
    if (live.pending && live.pending.token === loadToken) {
      var p = live.pending;
      live.pending = null;
      openLiveDay(p.key, p.iso, p.opts);
    }
    // A live day held at its end for want of a newer one hands over as soon
    // as the head lists one, unless the reader has moved off its end.
    if (cur && cur.live && cur.liveEnd === 'hold' && !playing && simT >= cur.t1 - cur.t0 - 1) {
      var d = R.whenLiveDayEnds(live.head, cur.live.date, true, cur.payload.route);
      if (d.act === 'switch') { cur.liveEnd = 'switch'; liveHandOver(d.date); }
    }
  }

  /* -- merging -- */

  // Merge live.route's live days that are wanted (the one shown, and
  // extra, a date being opened), one update at a time.
  function liveUpdate(extra) {
    var run = function () { return liveMerge(extra); };
    live.chain = live.chain.then(run, run);
    return live.chain.catch(function (e) { liveFault(e, 'update'); });
  }

  async function liveMerge(extra) {
    var head = live.head, route = live.route;
    if (!head || !liveHasRoute(route)) return;
    var want = {};
    if (cur && cur.live && cur.payload.route === route) want[cur.live.date] = true;
    if (extra) want[extra] = true;
    // In the shown day's last minute at the live edge, the day it will hand
    // over to (Ruling 12) is merged ahead, so the switch need not wait.
    if (cur && cur.live && cur.payload.route === route && live.pinned && liveRunning() &&
        cur.t1 - (serverNow() - liveDelay()) <= 60) {
      var next = R.whenLiveDayEnds(head, cur.live.date, true, route);
      if (next.act === 'switch') want[next.date] = true;
    }
    var plans = head.days.filter(function (d) { return want[d.date]; }).map(function (d) {
      var m = live.days.get(d.date);
      return { d: d, prev: m ? m.inputs : { route: route, date: d.date } };
    });
    var need = [];
    plans.forEach(function (p) {
      R.mergeInputs(p.prev, head, live.files).need.forEach(function (k) {
        if (need.indexOf(k) === -1) need.push(k);
      });
    });
    await Promise.all(need.map(function (k) {
      return liveFile(k).catch(function () { /* the last merge stands; the next head retries */ });
    }));
    if (route !== live.route) return;                       // moved on meanwhile
    plans.forEach(function (p) {
      var inp = R.mergeInputs(p.prev, head, live.files);
      if (inp.day === undefined || inp.recent === undefined) return;   // nothing in hand yet
      var m = live.days.get(p.d.date);
      if (m && m.head === head && m.inputs.day === inp.day && m.inputs.recent === inp.recent) return;
      // The set merged: the head's own, or (a named file not in hand) the
      // last one, whose head says what its upto and capping were.
      var setHead = inp.fresh ? head : (m && m.setHead) || head;
      try {
        var frags = [inp.recent.routes[route], head.routes[route]].filter(Boolean);
        var payload = R.mergeLive(inp.day, frags, route, p.d.t0, p.d.t1, []);
        notYet(payload, setHead, p.d);
        // A stale set's recent file can end before this head begins: no file
        // has that stretch, so it is a hole, and no pair that may hide missing
        // pings is drawn across it. The head's anchors say which pairs do not.
        if (!inp.fresh && inp.recent.to < head.from) {
          payload = R.splitAtHole(payload, Math.max(inp.recent.to, p.d.t0), Math.min(head.from, p.d.t1),
                                  STALE_REASON, head.routes[route]);
        }
        live.days.set(p.d.date, { inputs: inp, payload: payload, head: head, setHead: setHead,
                                  win: { date: p.d.date, t0: p.d.t0, t1: p.d.t1 },
                                  hours: inp.recent.hours || {}, upto: setHead.upto });
      } catch (e) {
        liveFault(e, 'route ' + route + ' on ' + p.d.date);   // the last good merge stays
      }
    });
    liveForget(head);
    liveShow();
  }

  // A capped recent file (compaction has stalled, so it starts 3 h back, not
  // at upto) leaves [upto, r.from) in no file at all: drawn as a hole, never
  // silently missing.
  function notYet(payload, head, d) {
    if (!head.r_capped || !head.r) return;
    var a = Math.max(head.upto, d.t0), b = Math.min(head.r.from, d.t1);
    if (b <= a) return;
    payload.holes = payload.holes.concat([[a, b, 'no-data', NOT_YET]])
      .sort(function (x, y) { return x[0] - y[0]; });
  }

  // Keep only the files the head names or a kept merge was made from.
  function liveForget(head) {
    var keep = {};
    if (head.r && head.r.key) keep[head.r.key] = true;
    head.days.forEach(function (d) {
      Object.keys(d.d || {}).forEach(function (r) { if (d.d[r]) keep[d.d[r]] = true; });
    });
    live.days.forEach(function (m) {
      if (m.inputs.dayKey) keep[m.inputs.dayKey] = true;
      if (m.inputs.recentKey) keep[m.inputs.recentKey] = true;
    });
    Array.from(live.files.keys()).forEach(function (k) { if (!keep[k]) live.files.delete(k); });
  }

  // The live day shown takes its new merge in place: refresh, then the
  // route's drawing if that moved, then the timeline and the frame. A merge
  // that cannot be drawn changes nothing (refresh is all or nothing): the
  // last good one stays on screen.
  function liveShow() {
    if (!cur || !cur.live || cur.payload.route !== live.route) return;
    var m = live.days.get(cur.live.date);
    if (!m || m.payload === cur.payload) return;
    var old = cur.payload;
    try {
      refresh(m.payload, true, m.win);
    } catch (e) {
      liveFault(e, 'refresh');
      return;
    }
    cur.liveInfo = { hours: m.hours, upto: m.upto };
    if (live.cause !== 'jump') live.cause = 'data';        // a held bus's next ping may be here
    try {
      liveRedraw(old, m.payload);
      drawTimelineBase();
      render();
    } catch (e) {
      liveFault(e, 'drawing');
    }
  }

  // The route's line and the stops' letters are start's. A live refresh
  // that changes the shapes, the stops or the route version (the register's
  // 06:15 flip, say) redraws them too; one that does not leaves them be.
  // New stop objects with the same stops (a new day file, an hour on) only
  // take over the letters and a pinned stop, which is held by identity.
  function liveRedraw(old, p) {
    var rv = function (x) { return (x.route_version || {}).id; };
    var same = function (a, b) { return a === b || JSON.stringify(a || []) === JSON.stringify(b || []); };
    var moved = rv(old) !== rv(p);
    var shapes = moved || !same(old.shapes, p.shapes);
    var stops = moved || !same(old.stops, p.stops);
    if (shapes) staticLayers = routeLayers(p);
    if (old.stops !== p.stops) {
      lettered = (p.stops || []).filter(stopLetter);
      if (pinned && pinned.stop && !pinned.stop.closed) {
        var i = (old.stops || []).indexOf(pinned.stop);
        var s = !stops && i !== -1 ? p.stops[i] : findStop(p.stops, pinned.stop);
        pinned = s ? { stop: s } : null;
      }
    }
    if (stops) {
      if (cur.markAt) markLayersFor(p, cur.markAt);
      applyNotices(p);                   // closed stops take their letters from the day's stops
    }
  }
  function findStop(stops, s) {
    return (stops || []).filter(function (x) {
      return s.id ? x.id === s.id : x.name === s.name && x.lon === s.lon && x.lat === s.lat;
    })[0] || null;
  }

  /* -- opening a live day -- */

  async function openLiveDay(key, iso, opts) {
    opts = opts || {};
    var token = ++loadToken;
    live.pending = null;
    if (live.route !== key) { live.route = key; live.days = new Map(); }
    say('Loading route ' + key + ', ' + fmtDay(iso) + ', live…');
    await liveUpdate(iso);
    if (token !== loadToken) return;
    var m = live.days.get(iso);
    if (!m) {
      live.pending = { key: key, iso: iso, opts: opts, token: loadToken };
      say('The live data for route ' + key + ', ' + fmtDay(iso) + ' is not in yet' +
          (live.error ? ' (' + live.error + ')' : '') + '. Trying again with the next update…');
      return;
    }
    live.pinned = !(opts.back || opts.t != null);
    live.glide = new Map();
    var keep = opts.handover ? pinned : null;     // a handover keeps the pinned bus or stop
    try {
      start(m.payload, { source: 'live', live: m.win, liveInfo: { hours: m.hours, upto: m.upto },
                         t: opts.t, at: opts.at, gap: opts.gap });
    } catch (e) {
      say(e.name === 'ReplayError' ? e.message : 'Something went wrong drawing that day (' + e.message + ').');
      console.error(e);
      return;
    }
    if (keep) {
      var s = keep.stop && findStop(cur.payload.stops, keep.stop);
      pinned = keep.reg ? { reg: keep.reg } : s ? { stop: s } : null;   // a bus no longer out lets go itself
      placeCard();
    }
  }

  // Ruling 12: the live day shown at the live edge has ended, and the head
  // lists a newer one: open it, still Live, in the same mode, the camera and
  // the pin kept. Until it is in, the ended day waits at its end (liveEnd).
  function liveHandOver(date) {
    live.handing = date;
    openLiveDay(cur.payload.route, date, { handover: true });
  }

  // At load: a pilot route opens on its newest live day (or the live day
  // the link names), once the first head is in, if it comes within 8 s.
  async function liveOpensFirst(key, date, q) {
    await Promise.race([live.first, new Promise(function (r) { setTimeout(r, 8000); })]);
    var dates = liveDates(key);
    var iso = date ? (dates.indexOf(date) !== -1 ? date : null) : dates[dates.length - 1];
    if (!iso) return false;
    var gap = q.get('gap');
    openLiveDay(key, iso, { t: q.get('t'), at: q.get('at'),
                            gap: gap && /^\d{1,4}$/.test(gap) ? gap : null, back: live.back });
    live.back = false;
    return true;
  }

  // The route picker chose a pilot route: its live day, unless an earlier
  // day is shown that the route also has (that day is kept, as for any route).
  function liveRouteChosen(key, dates) {
    var ld = liveDates(key);
    if (!ld.length) return false;
    var d = cur && cur.payload.date;
    if (d && !cur.live && dates.indexOf(d) !== -1 && ld.indexOf(d) === -1) return false;
    openLiveDay(key, d && ld.indexOf(d) !== -1 ? d : ld[ld.length - 1]);
    return true;
  }

  /* -- the cursor -- */

  function liveStep(now) {
    if (live.pinned) {
      simT = liveEdge();
    } else if (playing) {
      simT += speed * Math.min(250, now - lastFrame) / 1000;
      var edge = liveEdge();
      if (simT >= edge) { simT = edge; liveRejoin(); }     // caught up: Live again, at 1x
    }
    cur.liveRanPinned = live.pinned;      // whether the reader was at the edge when it ends
    render();
  }

  // Ruling 12: the live day's window has passed the edge. Decided once
  // (R.whenLiveDayEnds): at the live edge then, hand over to the newest live
  // day, or with none hold at the end, paused, and never loop; scrubbed back
  // or opened as a replay, it loops as any past day (the next frame takes
  // tick's own branch).
  function liveEnd(now) {
    var span = cur.t1 - cur.t0;
    if (!cur.liveEnd) {
      var d = R.whenLiveDayEnds(live.head, cur.live.date, !!cur.liveRanPinned, cur.payload.route);
      cur.liveEnd = d.act;
      if (d.act === 'loop') return;
      simT = span;
      if (d.act === 'switch') liveHandOver(d.date);
      else liveHeldAtEnd();
    }
    if (cur.liveEnd === 'switch') {
      simT = span;                          // waits at its end while the next day comes in
    } else if (playing) {                   // held, then played again by hand: to its end, never round
      simT = Math.min(span, simT + speed * Math.min(250, now - lastFrame) / 1000);
      if (simT >= span) liveHeldAtEnd();
    }
    render();
  }

  function liveHeldAtEnd() {
    playing = false;
    el.play.textContent = 'Play';
    el.play.classList.add('paused');
    liveControls();
  }

  function liveRejoin() {
    live.pinned = true;
    live.glide = new Map();
    liveJump();
    if (!playing) {
      playing = true;
      el.play.textContent = 'Pause';
      el.play.classList.remove('paused');
    }
    speed = 1;
    el.speed.value = '1';
    liveURL();                            // ?live=0 is spent: a reload opens at the edge
    liveControls();
  }

  function liveLeftEdge() {       // paused on a live day
    if (!liveRunning() || !live.pinned) return;
    live.pinned = false;
    live.glide = new Map();
    liveControls();
  }

  // The reader moved the cursor (the timeline, the slider, the arrow keys):
  // never past the live edge, and onto it is Live again.
  function liveScrubbed() {
    if (!liveRunning()) return;
    liveJump();
    var edge = liveEdge();
    if (simT >= edge) { simT = edge; liveRejoin(); }
    else if (live.pinned) { live.pinned = false; live.glide = new Map(); liveControls(); }
  }

  // The address follows the mode, and drops ?live=0 once at the edge.
  function liveURL() {
    var u = new URL(location.href);
    if (live.mode === 'smooth') u.searchParams.set('mode', 'smooth');
    else u.searchParams.delete('mode');
    if (live.pinned) u.searchParams.delete('live');
    var next = u.pathname + (u.search || '');
    if (next !== location.pathname + location.search) history.replaceState(null, '', next);
  }

  /* -- what a live day shows -- */

  // Latest: each bus at its last report, and a new report reached by a
  // glide along the track from where the bus is (R.latestGlide).
  function liveGlide(buses, E, p) {
    var perf = performance.now(), here = new Set();
    buses.forEach(function (b) {
      var last = Math.round(simT - b.age);         // its last ping, s after t0 (pings are whole seconds)
      var g = R.latestGlide(live.glide.get(b.reg), last, perf);
      live.glide.set(b.reg, g.state);
      here.add(b.reg);
      if (g.trackT === last) return;
      placeOnTrack(b, E, p, g.trackT);
    });
    live.glide.forEach(function (s, reg) { if (!here.has(reg)) live.glide.delete(reg); });
  }

  // Smooth (Ruling 13): a bus held at its last ping whose next ping has just
  // come in glides to the cursor rather than jumping there (R.smoothStep).
  // Glides start only when data lands; a scrub, a seek, a day or mode switch
  // or a rejoin ('jump') places every bus directly.
  function liveCatchUp(buses, E, p) {
    var r = R.smoothStep(live.smooth, buses.map(function (b) {
      return { reg: b.reg, held: b.held, last: Math.round(simT - b.age) };
    }), simT, performance.now(), live.cause);
    live.smooth = r.st;
    live.cause = null;
    buses.forEach(function (b) {
      if (Object.prototype.hasOwnProperty.call(r.trackT, b.reg)) placeOnTrack(b, E, p, r.trackT[b.reg]);
    });
  }

  // A bus drawn at track time t of its own track instead of the cursor's.
  function placeOnTrack(b, E, p, t) {
    var at = R.positionsAt(E, p.blinds, t);
    for (var i = 0; i < at.length; i++) {
      if (at[i].reg === b.reg) { b.position = at[i].position; b.gliding = true; return; }
    }
  }

  // On each frame of a live page: the banner, the controls, the overlay.
  function liveFrame(buses) {
    var running = liveRunning(), n = serverNow();
    // the banners belong to a running live day, and to one held at its end
    // for want of a newer one (often because the writer has stopped)
    var b = running || (cur && cur.live && cur.liveEnd === 'hold') ? R.bannerFor(live.head, n) : null;
    var text = !b ? '' : b.kind === 'data'
      ? 'Live data stopped at ' + fmtHM(b.at) + '. The buses stay where they were last reported, then drop out.'
      : 'Feed stopped at ' + fmtHM(b.at) + ': no new London bus positions have come in since.';
    if (el.liveBanner.textContent !== text) el.liveBanner.textContent = text;
    el.liveBanner.hidden = !text;
    liveControls();
    var perf = performance.now();
    if (perf - live.overlayAt < 250) return;      // four times a second is plenty
    live.overlayAt = perf;
    liveOverlay(buses, running, n);
    // Sit just above a banner showing at the bottom of the screen (narrow
    // screens), else in the corner.
    var lift = 12;
    [el.banner, el.liveBanner].forEach(function (bn) {
      if (bn.hidden) return;
      var r = bn.getBoundingClientRect();
      var vh = document.documentElement.clientHeight;      // the overlay's containing block, not innerHeight
      if (r.top > vh / 2) lift = Math.max(lift, Math.round(vh - r.top) + 6);
    });
    var bot = lift + 'px';
    if (el.liveOverlay.style.bottom !== bot) el.liveOverlay.style.bottom = bot;
  }

  // The lab overlay: how old the head is, how far behind server-now the
  // cursor is, the buses moving and held, the last poll, the last error.
  function liveOverlay(buses, running, n) {
    var h = live.head, lines = [];
    lines.push('now ' + fmtClock(n) + ' · head ' +
               (h ? Math.round(n - h.generated) + ' s old (to ' + fmtClock(h.to) + ')' : 'none yet'));
    lines.push('poll: ' + live.poll.text + (live.poll.at ? ' at ' + fmtClock(live.poll.at) : ''));
    if (cur && cur.live) {
      var held = buses.filter(function (x) { return x.held; }).length;
      var gliding = buses.filter(function (x) { return x.gliding; }).length;
      var over = cur.liveEnd === 'switch' ? 'the day is over: moving to ' + live.handing
        : cur.liveEnd === 'hold' ? 'the day is over: held at its end (no newer live day)'
        : 'the day is over: replayed as a past day';
      lines.push('cursor ' + lagText(n - (cur.t0 + simT)) + ' behind · ' +
                 (!running ? over : live.pinned ? live.mode + ', at the edge'
                   : 'scrubbed back, ' + speed + '×'));
      lines.push((buses.length - held) + ' moving · ' + held + ' held' +
                 (gliding ? ' · ' + gliding + ' gliding' : ''));
    } else {
      lines.push('not a live day');
    }
    if (live.error) lines.push('last error ' + ago(n - live.errorAt) + ' (' + fmtClock(live.errorAt) + '): ' + live.error);
    var text = lines.join('\n');
    if (el.liveOverlay.textContent !== text) el.liveOverlay.textContent = text;
  }

  // The timeline of a live day: along the top, each hour signed off,
  // compacted or live (after upto, to now); then, per frame, the part still
  // to come shaded.
  function liveHours(g, w, t0, span) {
    var info = cur.liveInfo || {}, hours = info.hours || {};
    function band(a, b, colour) {
      var x0 = Math.max(0, (a - t0) / span * w), x1 = Math.min(w, (b - t0) / span * w);
      if (x1 > x0) { g.fillStyle = colour; g.fillRect(x0, 0, x1 - x0, 3); }
    }
    Object.keys(hours).forEach(function (k) {
      band(+k, +k + 3600, HOUR_COLOUR[hours[k]] || HOUR_COLOUR.compacted);
    });
    if (info.upto != null) band(Math.max(info.upto, t0), Math.min(serverNow(), cur.t1), HOUR_COLOUR.live);
  }
  function liveFuture(g, c, span) {
    var x = Math.max(0, Math.round((serverNow() - cur.t0) / span * c.width));
    if (x >= c.width) return;
    g.fillStyle = 'rgba(17,17,17,.6)';
    g.fillRect(x, 0, c.width - x, c.height);
  }

  /* -- the controls -- */

  // Called at the end of every start on a live page.
  function liveDayShown() {
    var on = !!cur.live;
    live.handing = null;
    live.smooth = null;
    liveJump();                             // a new day: every bus placed directly
    liveSpeeds(on);
    if (on && live.pinned) liveRejoin();
    el.timeline.title = on ? 'The day so far, across its whole service window; the shaded end is ' +
      'still to come. Along the top, each hour: signed off (light), compacted (dark) or live ' +
      '(amber). Click or drag to go back; onto the live edge is Live again.' : timelineTitle;
    liveControls();
  }

  // 1x is a speed only on a live day (it is the live edge's own).
  function liveSpeeds(on) {
    var one = el.speed.querySelector('option[value="1"]');
    if (on && !one) {
      one = document.createElement('option');
      one.value = '1';
      one.textContent = '1×';
      el.speed.insertBefore(one, el.speed.firstChild);
    } else if (!on && one) {
      one.remove();
      if (speed === 1) speed = 60;
    }
    el.speed.value = String(speed);
  }

  function liveBuildControls() {
    el.liveControls.innerHTML = '<button id="live-go" class="btn"></button>';
    $('live-go').onclick = function () {
      if (liveRunning()) { liveRejoin(); simT = liveEdge(); render(); return; }
      var key = cur ? cur.payload.route : resolveRoute(el.route.value);
      var dates = liveDates(key), newest = dates[dates.length - 1];
      if (!newest) return;
      if (cur && cur.live && cur.liveEnd && cur.live.date === newest) return;   // held at its end: nothing newer
      openLiveDay(key, newest);
    };
  }

  function liveControls() {
    var key = cur ? cur.payload.route : resolveRoute(el.route.value);
    var has = liveDates(key).length > 0;
    var atEdge = !!(live.pinned && liveRunning());
    var sig = [has, atEdge].join();
    if (sig === live.ctl) return;
    live.ctl = sig;
    // At the live edge the cursor runs in real time whatever the menu says:
    // the menu is off there (it reads 1x), and on again once scrubbed back.
    el.speed.disabled = atEdge;
    if (atEdge) el.speed.title = 'Live plays in real time: go back to choose a speed';
    else el.speed.removeAttribute('title');
    el.liveControls.hidden = !has;
    var go = $('live-go');
    go.classList.toggle('on', atEdge);
    go.innerHTML = atEdge ? '<span class="dot" aria-hidden="true"></span>Live' : 'Go live';
    go.title = atEdge ? 'At the live edge' : 'To the live edge of the day so far';
  }

  // ?mode=smooth with ?delay=<s> (Smooth's delay: a lab comparison), ?live=0 (start scrubbed back).
  function liveInit(q) {
    var dl = q.get('delay');
    if (dl != null && /^\d{1,4}$/.test(dl)) live.delay = Math.min(3600, +dl);
    if (q.get('mode') === 'smooth') live.mode = 'smooth';
    live.back = q.get('live') === '0';
    liveBuildControls();
    el.liveOverlay.hidden = false;
    livePoll();
    // Back in front after the timer slept: poll now if the next head is due.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && R.pollDue(live.head, serverNow())) livePoll();
    });
  }

  /* ---- wiring ------------------------------------------------------------- */

  el.play.onclick = function () {
    playing = !playing;
    el.play.textContent = playing ? 'Pause' : 'Play';
    el.play.classList.toggle('paused', !playing);
    if (LIVE && !playing) liveLeftEdge();  // a paused live day is no longer at the live edge
  };
  el.speed.onchange = function () { speed = +el.speed.value; el.speed.blur(); };
  el.slider.oninput = function () {
    if (!cur) return;
    simT = (cur.t1 - cur.t0) * (+el.slider.value / 1000);
    if (LIVE) liveScrubbed();
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
    if (LIVE && liveRouteChosen(key, dates)) return;
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
  // Hiding the controls hides the TfL notices too, so the map is clear; an
  // amber dot on the button says there are notices to come back to.
  function setCollapsed(c) {
    el.hud.classList.toggle('collapsed', c);
    el.collapse.setAttribute('aria-expanded', String(!c));
    el.collapse.innerHTML = c ? 'Show controls <span aria-hidden="true">&#9662;</span>'
                              : 'Hide <span aria-hidden="true">&#9652;</span>';
    drawTimelineBase(); drawTimeline();
  }
  el.collapse.onclick = function () { setCollapsed(!el.hud.classList.contains('collapsed')); };
  // On a phone the full panel hides half the map, so a link to a route and
  // day (from a route page) starts with just the clock. Without one, the
  // panel starts open: the route picker is the first thing anyone needs, and
  // a closed panel hid it (Neil, on his phone, 19 Oct).
  setCollapsed(window.innerWidth < 600 && !!new URLSearchParams(location.search).get('route'));

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
      simT = Math.max(0, Math.min(cur.t1 - cur.t0, simT + d));
      if (LIVE) liveScrubbed();
      render();
    }
  });
  window.addEventListener('resize', function () { drawTimelineBase(); drawTimeline(); });
  var timelineTitle = el.timeline.title;

  window.__cam = function () {
    var v = currentCam();
    return [v.longitude, v.latitude, v.zoom, v.pitch || 0, v.bearing || 0];
  };
  window.__where = function (lon, lat) {   // where a place is on screen, for the smoke driver
    var v = currentCam();
    return v.project ? v.project([lon, lat]) : null;
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
      special: special ? { name: special.name, decks: Object.keys(special.icons),
        film: Object.keys(special.icons).filter(function (dk) { return special.icons[dk].film; }),
        frame: filmShown ? filmShownTick % filmShown.count : null } : null,
      card: el.card && !el.card.hidden ? el.card.textContent : null,
      buses: lastBuses.map(function (b) { return { reg: b.reg, position: b.position, dead: b.dead }; }),
      stops: (cur.payload.stops || []).length, lettered: lettered.length,
      closedStops: closedStops.length, stopsNear: stopsNear,
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
    if (LIVE) liveInit(q);                 // the first head is asked for now, beside the catalogue
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
    if (LIVE && await liveOpensFirst(key, date, q)) return;
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
