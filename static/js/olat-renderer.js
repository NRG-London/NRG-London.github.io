/* olat-renderer.js  --  OLAT Explorer v3 client-side data renderer.
 *
 * Replaces the v2 image-swap path. Instead of fetching one pre-rendered map per
 * (origin, mode), it fetches ONE small RGB data image per origin (R=pt, G=pt-ebike,
 * B=pt-car, ~40 kB) plus a shared coords.bin + overlay.png, and draws the heatmap
 * into a <canvas>. Mode 4 (pt+ebike+car) is min(G,B), computed here. See
 * OLAT_data_renderer_spec.md.
 *
 * Public modes unlocked beyond v2: live difference maps, a continuous isochrone
 * threshold, live catchment %, and click-to-read journey times.
 *
 * No dependencies. Exposes window.OlatRenderer.
 */
(function () {
  "use strict";

  var TAU = Math.PI * 2;

  function hexToRgb(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }

  var OlatRenderer = function (canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.base = (opts.base || "/olat/").replace(/\/?$/, "/");
    this.manifest = null;
    this.coords = null;                 // {lon:Float32Array, lat:Float32Array}
    this.px = null; this.py = null;     // pixel coords at canvas resolution
    this.overlay = null;                // HTMLImageElement
    this.cache = {};                    // slug -> {R,G,B} Uint8Array(N)
    this.pending = {};                  // slug -> Promise
    this.origin = null;                 // current origin record
    this.ebike = false; this.car = false;
    this.view = "time";                 // 'time' | 'diff-car' | 'diff-ebike'
    this.threshold = null;              // isochrone minutes, or null
    this.separateUnreachable = false;
    this.onReadout = opts.onReadout || null;
    this._times = null;                 // Uint8 per-destination current mode
  };

  /* ---- load manifest + coords + overlay (once) --------------------------- */
  OlatRenderer.prototype.init = function () {
    var self = this;
    return fetch(this.base + "manifest.json")
      .then(function (r) { return r.json(); })
      .then(function (m) {
        self.manifest = m;
        self.N = m.N;
        self.W = m.canvas.width; self.H = m.canvas.height;
        self.gridW = m.grid.w; self.gridH = m.grid.h;
        self.sentinel = m.sentinel;
        self.xlim = m.frame.xlim; self.ylim = m.frame.ylim;
        self.colours = m.colours.map(hexToRgb);
        self.bins = m.bins;                       // lower edges
        self.originBySlug = {};
        m.origins.forEach(function (o) { self.originBySlug[o.slug] = o; });
        self._buildBinLut();
        // canvas backing store matches the production canvas exactly -> the
        // spec transform is 1:1, the overlay composites 1:1, radius = ref.
        self.canvas.width = self.W; self.canvas.height = self.H;
        self.R = m.dotRadiusRef;                  // 3.84 px at 2200 wide
        return Promise.all([self._loadCoords(), self._loadOverlay()]);
      })
      .then(function () { self._project(); return self; });
  };

  OlatRenderer.prototype._loadCoords = function () {
    var self = this;
    return fetch(this.base + this.manifest.coords)
      .then(function (r) { return r.arrayBuffer(); })
      .then(function (buf) {
        var dv = new DataView(buf);
        var magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
        if (magic !== "OLC1") throw new Error("coords.bin: bad magic " + magic);
        var n = dv.getUint32(4, true);
        if (n !== self.N) throw new Error("coords.bin N " + n + " != manifest N " + self.N);
        // index-hash guard: first 8 bytes of the hash are stamped in the header
        // and must match the manifest. A stale coords file + fresh images would
        // otherwise render a plausible-but-wrong map.
        var hh = "";
        for (var b = 8; b < 16; b++) hh += ("0" + dv.getUint8(b).toString(16)).slice(-2);
        if (self.manifest.indexHash.slice(0, 16) !== hh)
          throw new Error("coords.bin index hash mismatch -- rebuild coords + images together");
        var u16 = new Uint16Array(buf, 16, n * 2);
        var lon = new Float32Array(n), lat = new Float32Array(n);
        var dlon = self.xlim[1] - self.xlim[0], dlat = self.ylim[1] - self.ylim[0];
        for (var i = 0; i < n; i++) {
          lon[i] = self.xlim[0] + (u16[i * 2] / 65535) * dlon;
          lat[i] = self.ylim[0] + (u16[i * 2 + 1] / 65535) * dlat;
        }
        self.coords = { lon: lon, lat: lat };
      });
  };

  OlatRenderer.prototype._loadOverlay = function () {
    var self = this;
    return new Promise(function (res, rej) {
      var img = new Image();
      img.onload = function () { self.overlay = img; res(); };
      img.onerror = rej;
      img.src = self.base + self.manifest.overlay;
    });
  };

  /* ---- the verified transform (spec 4.1): lon/lat -> pixel --------------- */
  OlatRenderer.prototype._project = function () {
    var n = this.N, lon = this.coords.lon, lat = this.coords.lat;
    var px = new Float32Array(n), py = new Float32Array(n);
    var x0 = this.xlim[0], xr = this.xlim[1] - this.xlim[0];
    var y0 = this.ylim[0], yr = this.ylim[1] - this.ylim[0];
    var W = this.W, H = this.H;
    for (var i = 0; i < n; i++) {
      px[i] = (lon[i] - x0) / xr * W;
      py[i] = (1 - (lat[i] - y0) / yr) * H;
    }
    this.px = px; this.py = py;
  };

  OlatRenderer.prototype.lonLatToPx = function (lon, lat) {
    return [(lon - this.xlim[0]) / (this.xlim[1] - this.xlim[0]) * this.W,
            (1 - (lat - this.ylim[0]) / (this.ylim[1] - this.ylim[0])) * this.H];
  };
  OlatRenderer.prototype.pxToLonLat = function (x, y) {
    return [this.xlim[0] + x / this.W * (this.xlim[1] - this.xlim[0]),
            this.ylim[0] + (1 - y / this.H) * (this.ylim[1] - this.ylim[0])];
  };

  /* ---- per-origin data image -------------------------------------------- */
  OlatRenderer.prototype._loadImage = function (slug) {
    var self = this;
    if (this.cache[slug]) return Promise.resolve(this.cache[slug]);
    if (this.pending[slug]) return this.pending[slug];
    var url = this.base + this.manifest.images.replace("{slug}", slug);
    var p = fetch(url)
      .then(function (r) { return r.blob(); })
      .then(function (blob) {
        // decode with colour management + premultiply OFF (spec 4.4). Our PNGs
        // are opaque RGB with no colour chunks, so bytes survive intact.
        if (self._canBitmap === undefined) self._canBitmap = typeof createImageBitmap === "function";
        if (self._canBitmap) {
          return createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" })
            .then(function (bm) { return self._readChannels(bm); })
            .catch(function () { self._canBitmap = false; return self._decodeViaImg(url); });
        }
        return self._decodeViaImg(url);
      })
      .then(function (ch) { self.cache[slug] = ch; delete self.pending[slug]; return ch; });
    this.pending[slug] = p;
    return p;
  };

  OlatRenderer.prototype._readChannels = function (bitmap) {
    var w = this.gridW, h = this.gridH, N = this.N;
    if (!this._dec) {
      this._dec = document.createElement("canvas");
      this._dec.width = w; this._dec.height = h;
      this._decCtx = this._dec.getContext("2d", { willReadFrequently: true });
    }
    this._decCtx.clearRect(0, 0, w, h);
    this._decCtx.drawImage(bitmap, 0, 0);
    if (bitmap.close) bitmap.close();
    var d = this._decCtx.getImageData(0, 0, w, h).data;   // RGBA row-major
    var R = new Uint8Array(N), G = new Uint8Array(N), B = new Uint8Array(N);
    for (var i = 0; i < N; i++) {
      var o = i * 4;
      R[i] = d[o]; G[i] = d[o + 1]; B[i] = d[o + 2];
    }
    return { R: R, G: G, B: B };
  };

  OlatRenderer.prototype._decodeViaImg = function (url) {
    var self = this;
    return new Promise(function (res, rej) {
      var img = new Image();
      img.onload = function () { res(self._readChannels(img)); };
      img.onerror = rej;
      img.src = url;
    });
  };

  /* ---- state setters ----------------------------------------------------- */
  OlatRenderer.prototype.setOrigin = function (slug) {
    var self = this;
    var rec = this.originBySlug[slug];
    if (!rec) return Promise.reject(new Error("unknown origin " + slug));
    return this._loadImage(slug).then(function (ch) {
      self.origin = rec; self._ch = ch; self._recompute(); self.render();
      return rec;
    });
  };
  OlatRenderer.prototype.setModes = function (ebike, car) {
    this.ebike = !!ebike; this.car = !!car;
    if (this._ch) { this._recompute(); this.render(); }
  };
  OlatRenderer.prototype.setView = function (v) { this.view = v; if (this._ch) this.render(); };
  OlatRenderer.prototype.setThreshold = function (t) { this.threshold = t; if (this._ch) this.render(); };
  OlatRenderer.prototype.setSeparateUnreachable = function (b) {
    this.separateUnreachable = !!b; if (this._ch) this.render();
  };

  OlatRenderer.prototype.modeKey = function () {
    return "pt" + (this.ebike ? "-ebike" : "") + (this.car ? "-car" : "");
  };

  /* per-destination minutes for the current mode, from the composed channels */
  OlatRenderer.prototype._recompute = function () {
    var ch = this._ch, N = this.N;
    var t = this._times || (this._times = new Uint8Array(N));
    var R = ch.R, G = ch.G, B = ch.B;
    if (this.ebike && this.car) { for (var i = 0; i < N; i++) t[i] = G[i] < B[i] ? G[i] : B[i]; }
    else if (this.ebike) { t.set(G); }
    else if (this.car) { t.set(B); }
    else { t.set(R); }
  };

  /* ---- colour LUTs ------------------------------------------------------- */
  OlatRenderer.prototype._buildBinLut = function () {
    // minute (0..120) -> bin index 0..5 ; sentinel handled at draw time
    var lut = new Uint8Array(this.sentinel + 1);
    var edges = this.bins;                       // [0,15,30,45,60,90]
    for (var v = 0; v <= this.sentinel; v++) {
      var b = edges.length - 1;
      for (var e = 1; e < edges.length; e++) { if (v < edges[e]) { b = e - 1; break; } }
      lut[v] = b;
    }
    this.binLut = lut;
  };

  /* ---- render ------------------------------------------------------------ */
  OlatRenderer.prototype.render = function () {
    if (!this._ch) return;
    var t0 = (performance && performance.now) ? performance.now() : 0;
    var ctx = this.ctx, W = this.W, H = this.H;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, H);

    if (this.view === "time") this._renderTime(ctx);
    else this._renderDiff(ctx);

    ctx.drawImage(this.overlay, 0, 0, W, H);
    this._drawStar(ctx);
    this._lastRenderMs = ((performance && performance.now) ? performance.now() : 0) - t0;
  };

  OlatRenderer.prototype._renderTime = function (ctx) {
    var N = this.N, t = this._times, px = this.px, py = this.py, R = this.R;
    var sent = this.sentinel, lut = this.binLut, thr = this.threshold;
    var paths = [new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    var unreach = this.separateUnreachable ? new Path2D() : null;
    for (var i = 0; i < N; i++) {
      var v = t[i];
      var b;
      if (v >= sent) { if (unreach) { addDot(unreach, px[i], py[i], R); continue; } b = 5; }
      else b = lut[v];
      addDot(paths[b], px[i], py[i], R);
    }
    if (thr == null) {
      // categorical 6-bin map, drawn 90+ first so near beats far (spec 4.2)
      for (var k = 5; k >= 0; k--) { ctx.fillStyle = rgbCss(this.colours[k]); ctx.fill(paths[k]); }
    } else {
      // isochrone: within threshold vs beyond, two fills
      var inP = new Path2D(), outP = new Path2D();
      for (var j = 0; j < N; j++) {
        var vv = t[j];
        if (vv >= sent) { if (!unreach) addDot(outP, px[j], py[j], R); continue; }
        addDot(vv <= thr ? inP : outP, px[j], py[j], R);
      }
      ctx.fillStyle = "#e8eef3"; ctx.fill(outP);
      ctx.fillStyle = this._threshColour(thr); ctx.fill(inP);
    }
    if (unreach) { ctx.fillStyle = "#c9b8d6"; ctx.fill(unreach); }
  };

  OlatRenderer.prototype._threshColour = function (thr) {
    // colour the catchment by the band that ENDS at the threshold (round down):
    // 15 -> <15 (blue), 45 -> 30-45 (pale green). Use thr-1 so an edge value
    // lands in the band below it rather than the one above.
    var b = this.binLut[Math.max(0, Math.min(this.sentinel, (thr | 0) - 1))];
    return rgbCss(this.colours[b]);
  };

  OlatRenderer.prototype._renderDiff = function (ctx) {
    var N = this.N, px = this.px, py = this.py, R = this.R, sent = this.sentinel;
    var ptv = this._ch.R;
    var modev = this.view === "diff-car" ? this._ch.B : this._ch.G;
    // buckets: newly-reachable, both-unreachable, and savings bands (<5..30+)
    var newly = new Path2D(), none = new Path2D();
    var bands = [new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    var bandEdges = [1, 5, 10, 20, 30];     // minutes saved
    for (var i = 0; i < N; i++) {
      var m = modev[i], p = ptv[i];
      if (m >= sent) { addDot(none, px[i], py[i], R); continue; }       // unreachable both ways
      if (p >= sent) { addDot(newly, px[i], py[i], R); continue; }      // add-on makes it reachable
      var save = p - m;
      var bi = 0;
      for (var e = bandEdges.length - 1; e >= 0; e--) { if (save >= bandEdges[e]) { bi = e; break; } }
      addDot(bands[bi], px[i], py[i], R);
    }
    // sequential "minutes saved" ramp (light -> dark green), then specials
    var ramp = ["#edf8e9", "#bae4b3", "#74c476", "#31a354", "#006d2c"];
    ctx.fillStyle = "#eef1f4"; ctx.fill(none);
    for (var k = 0; k < bands.length; k++) { ctx.fillStyle = ramp[k]; ctx.fill(bands[k]); }
    ctx.fillStyle = "#6a51a3"; ctx.fill(newly);     // newly reachable stands out
  };

  OlatRenderer.prototype._drawStar = function (ctx) {
    if (!this.origin) return;
    var p = this.lonLatToPx(this.origin.lon, this.origin.lat);
    var cx = p[0], cy = p[1];
    var outer = this.W / 2200 * 22, inner = outer * 0.42;
    ctx.beginPath();
    for (var i = 0; i < 10; i++) {
      var ang = -Math.PI / 2 + i * Math.PI / 5;
      var r = (i % 2 === 0) ? outer : inner;
      var x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.lineJoin = "round";
    ctx.lineWidth = this.W / 2200 * 3.2;
    ctx.strokeStyle = "#ffffff"; ctx.stroke();
    ctx.fillStyle = "#000000"; ctx.fill();
  };

  /* ---- derived stats (live, never stored) ------------------------------- */
  OlatRenderer.prototype.mean = function () {
    var t = this._times, N = this.N, sent = this.sentinel, s = 0, c = 0;
    for (var i = 0; i < N; i++) { if (t[i] < sent) { s += t[i]; c++; } }
    return c ? Math.round(s / c) : null;
  };
  OlatRenderer.prototype.catchmentWithin = function (minutes) {
    var t = this._times, N = this.N, c = 0;
    for (var i = 0; i < N; i++) if (t[i] <= minutes) c++;
    return { count: c, pct: c / N * 100 };
  };
  OlatRenderer.prototype.reachableCount = function () {
    var t = this._times, N = this.N, sent = this.sentinel, c = 0;
    for (var i = 0; i < N; i++) if (t[i] < sent) c++;
    return c;
  };

  /* nearest destination to a canvas-space point -> {minutes, lon, lat, dist} */
  OlatRenderer.prototype.nearestAtPx = function (x, y) {
    var px = this.px, py = this.py, N = this.N, best = -1, bd = Infinity;
    for (var i = 0; i < N; i++) {
      var dx = px[i] - x, dy = py[i] - y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) return null;
    var v = this._times[best];
    return {
      idx: best, minutes: v >= this.sentinel ? null : v,
      lon: this.coords.lon[best], lat: this.coords.lat[best],
      distPx: Math.sqrt(bd)
    };
  };

  /* map a CSS-pixel event position on the canvas element to backing-store px */
  OlatRenderer.prototype.eventToPx = function (ev) {
    var r = this.canvas.getBoundingClientRect();
    return [(ev.clientX - r.left) / r.width * this.W, (ev.clientY - r.top) / r.height * this.H];
  };

  /* background-prefetch every origin so the network is touched once (spec 6) */
  OlatRenderer.prototype.prefetchAll = function () {
    var self = this, slugs = this.manifest.origins.map(function (o) { return o.slug; });
    var i = 0;
    (function next() {
      if (i >= slugs.length) return;
      var s = slugs[i++];
      (self.cache[s] ? Promise.resolve() : self._loadImage(s)).then(function () {
        (window.requestIdleCallback || window.setTimeout)(next, window.requestIdleCallback ? undefined : 60);
      }).catch(function () { setTimeout(next, 120); });
    })();
  };

  function addDot(path, x, y, r) { path.moveTo(x + r, y); path.arc(x, y, r, 0, TAU); }
  function rgbCss(c) { return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")"; }

  window.OlatRenderer = OlatRenderer;
})();
