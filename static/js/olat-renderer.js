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
 * No dependencies. Exposes window.OlatRenderer. Includes viewport zoom/pan (v3.2).
 */
(function () {
  "use strict";

  var TAU = Math.PI * 2;

  function hexToRgb(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }

  /* ---- transition timing (matches the crime maps and the crime charts) ----
     750 ms cubic-in-out on every change that only moves the NUMBERS behind the
     dots: a new origin, a new scenario, e-bike/car on or off. Changes that alter
     what the map MEANS -- the mapping options, the isochrone threshold, the
     reference layers, zoom -- stay a hard cut, so the legend and the map never
     disagree even for a frame. */
  var reducedMotion = window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var TRANSITION = reducedMotion ? 0 : 750;
  // ?ease=<ms> shortens or disables the glide without a rebuild; ?ease=0 is exactly
  // the pre-easing behaviour, which is what the capture harness wants for stills.
  var easeQ = /[?&]ease=(\d+)/.exec(window.location.search);
  if (easeQ) TRANSITION = parseInt(easeQ[1], 10);

  function easeCubicInOut(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
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
    this.cache = {};                    // image URL -> {R,G,B} Uint8Array(N)
    this.pending = {};                  // image URL -> Promise
    this._imgTpl = null;                // null = baseline (manifest.images); else scenario dir
    this.origin = null;                 // current origin record
    this.ebike = false; this.car = false;
    this.view = "time";                 // 'time' | 'diff-car' | 'diff-ebike'
    this.threshold = null;              // isochrone minutes, or null
    this.separateUnreachable = false;
    this.onReadout = opts.onReadout || null;
    this._times = null;                 // Uint8 per-destination current mode
    this.z = 1; this.uc = 0.5; this.vc = 0.5;   // viewport: scale + centre (0..1)
    this.u = null; this.v = null;               // normalised frame coords (0..1)
    // colour transition: _colFrom/_colTo hold a per-point RGB triple each, _ord is the
    // far->near draw permutation for the target state. _suppress holds the last painted
    // frame while a bracketed change (which may await a fetch) assembles itself.
    this._suppress = false;
    this._brToken = 0; this._brTimer = null;
    this._tw = { active: false, token: 0, t0: 0, dur: 0, e: 0, raf: null, samples: null };
    this._colFrom = null; this._colTo = null; this._ord = null; this._ordN = 0;
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
        // adaptive backing resolution: match the on-screen size x device pixel
        // ratio, capped at the production width, so lower-powered phones don't
        // fill a needlessly huge canvas. Everything scales off self.W / self.H.
        var cssW = self.canvas.getBoundingClientRect().width || (window.innerWidth || 800);
        var dpr = window.devicePixelRatio || 1;
        var backW = Math.max(760, Math.min(m.canvas.width, Math.round(cssW * dpr)));
        self.W = backW; self.H = Math.round(backW * m.canvas.height / m.canvas.width);
        self.canvas.width = self.W; self.canvas.height = self.H;
        self.R = m.dotRadiusRef * (self.W / m.canvas.width);
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
    var u = new Float32Array(n), v = new Float32Array(n);
    var x0 = this.xlim[0], xr = this.xlim[1] - this.xlim[0];
    var y0 = this.ylim[0], yr = this.ylim[1] - this.ylim[0];
    for (var i = 0; i < n; i++) {
      u[i] = (lon[i] - x0) / xr;          // 0..1 across the frame
      v[i] = 1 - (lat[i] - y0) / yr;
    }
    this.u = u; this.v = v;
    this.px = new Float32Array(n); this.py = new Float32Array(n);
    this._reproject();
  };

  // recompute pixel positions for the current viewport (scale z, centre uc/vc)
  OlatRenderer.prototype._reproject = function () {
    var n = this.N, u = this.u, v = this.v, px = this.px, py = this.py;
    var z = this.z, uc = this.uc, vc = this.vc, W = this.W, H = this.H, hw = W / 2, hh = H / 2;
    for (var i = 0; i < n; i++) {
      px[i] = (u[i] - uc) * z * W + hw;
      py[i] = (v[i] - vc) * z * H + hh;
    }
  };

  // Re-fit the canvas backing to its current on-screen width (e.g. after the explorer
  // expands to full width, or the window resizes) and re-render crisply. Everything
  // scales off this.W / this.H, so recompute px/py and rebuild the buffers.
  OlatRenderer.prototype.resize = function () {
    if (!this.manifest || !this.u) return;               // coords not projected yet
    var m = this.manifest;
    var cssW = this.canvas.getBoundingClientRect().width || (window.innerWidth || 800);
    var dpr = window.devicePixelRatio || 1;
    var backW = Math.max(760, Math.min(m.canvas.width, Math.round(cssW * dpr)));
    if (backW === this.W) return;                        // width unchanged -> nothing to do
    this.W = backW; this.H = Math.round(backW * m.canvas.height / m.canvas.width);
    this.canvas.width = this.W; this.canvas.height = this.H;
    this.R = m.dotRadiusRef * (this.W / m.canvas.width);
    this._buf = null; this._offs = null; this._offsForZ = null;   // rebuild for the new size
    this._reproject();
    if (this._ch) this.render();
  };

  // set the viewport (clamped so the window stays within the frame); re-render
  OlatRenderer.prototype.setViewport = function (z, uc, vc) {
    z = Math.max(1, Math.min(8, z));
    var half = 0.5 / z;
    uc = Math.max(half, Math.min(1 - half, uc));
    vc = Math.max(half, Math.min(1 - half, vc));
    this.z = z; this.uc = uc; this.vc = vc;
    if (this._ch) { this._reproject(); this.render(); }
    return { z: z, uc: uc, vc: vc, half: half };
  };
  OlatRenderer.prototype.getViewport = function () { return { z: this.z, uc: this.uc, vc: this.vc, half: 0.5 / this.z }; };

  OlatRenderer.prototype.lonLatToPx = function (lon, lat) {
    var u = (lon - this.xlim[0]) / (this.xlim[1] - this.xlim[0]);
    var v = 1 - (lat - this.ylim[0]) / (this.ylim[1] - this.ylim[0]);
    return [(u - this.uc) * this.z * this.W + this.W / 2,
            (v - this.vc) * this.z * this.H + this.H / 2];
  };
  OlatRenderer.prototype.pxToLonLat = function (x, y) {
    var u = (x - this.W / 2) / (this.z * this.W) + this.uc;
    var v = (y - this.H / 2) / (this.z * this.H) + this.vc;
    return [this.xlim[0] + u * (this.xlim[1] - this.xlim[0]),
            this.ylim[0] + (1 - v) * (this.ylim[1] - this.ylim[0])];
  };

  /* ---- per-origin data image -------------------------------------------- */
  OlatRenderer.prototype._imgUrl = function (slug) {
    return this.base + (this._imgTpl || this.manifest.images).replace("{slug}", slug);
  };
  // Point value-image loads at a scenario directory ("scenarios/<combo>") or back at
  // the baseline (null). Cache is keyed by full URL, so baseline and each scenario
  // coexist without collision.
  OlatRenderer.prototype.setImageDir = function (dir) {
    this._imgTpl = dir ? dir.replace(/\/?$/, "/") + "{slug}.png" : null;
  };
  OlatRenderer.prototype._loadImage = function (slug) {
    var self = this;
    var url = this._imgUrl(slug);
    if (this.cache[url]) return Promise.resolve(this.cache[url]);
    if (this.pending[url]) return this.pending[url];
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
      .then(function (ch) { self.cache[url] = ch; delete self.pending[url]; return ch; });
    this.pending[url] = p;
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
  // setView/setThreshold change what the colours MEAN, so they land any glide in
  // flight first (its _colTo was built for the old mapping) and then cut, as before.
  OlatRenderer.prototype.setView = function (v) {
    this._endTween(false); this.view = v; if (this._ch) this.render();
  };
  OlatRenderer.prototype.setThreshold = function (t) {
    this._endTween(false); this.threshold = t; if (this._ch) this.render();
  };
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
  // Pixel-buffer renderer: plot dots straight into an RGBA buffer and blit once
  // with putImageData, bypassing the canvas Path2D fill (which some Android
  // browsers software-rasterise pathologically slowly). ~100x faster there.
  OlatRenderer.prototype.render = function () {
    if (!this._ch || this._suppress) return;
    var t0 = (performance && performance.now) ? performance.now() : 0;
    var ctx = this.ctx, W = this.W, H = this.H;
    this._ensureBuf();
    this._ensureStamp();
    var data = this._buf.data, no = this._offs.length, m = this._offsR;
    data.fill(255);                               // opaque white background
    if (this._tw.active) this._drawTween(data, no, m);
    else this._drawGroups(data, no, m);
    ctx.putImageData(this._buf, 0, 0);
    // Draw the baked borough/boundary overlay through the SAME viewport as the dots:
    // a source sub-rectangle -> full canvas, so it zooms and pans with everything
    // else instead of staying frozen at full extent. At z=1 this is the full image.
    var oW = this.overlay.naturalWidth || W, oH = this.overlay.naturalHeight || H, oh = 0.5 / this.z;
    ctx.drawImage(this.overlay,
      (this.uc - oh) * oW, (this.vc - oh) * oH, oW / this.z, oH / this.z,
      0, 0, W, H);                                 // borough/boundary lines on top
    this._drawStar(ctx);
    this._lastRenderMs = ((performance && performance.now) ? performance.now() : 0) - t0;
  };

  // resting path: one flat colour per group, drawn far -> near
  OlatRenderer.prototype._drawGroups = function (data, no, m) {
    var W = this.W, H = this.H, N = this.N, px = this.px, py = this.py, offs = this._offs;
    var res = this._groups();
    var grp = res.grp, cols = res.colours, order = res.order;
    for (var oi = 0; oi < order.length; oi++) {
      var g = order[oi], col = cols[g];
      if (!col) continue;
      var cr = col[0], cg = col[1], cb = col[2];
      for (var i = 0; i < N; i++) {
        if (grp[i] !== g) continue;
        var x = px[i] | 0, y = py[i] | 0;
        if (x < -m || y < -m || x > W + m || y > H + m) continue;   // cull off-screen (zoom)
        for (var o = 0; o < no; o++) {
          var xx = x + offs[o][0], yy = y + offs[o][1];
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          var kk = (yy * W + xx) * 4;
          data[kk] = cr; data[kk + 1] = cg; data[kk + 2] = cb;
        }
      }
    }
  };

  // transition path: every point carries its own colour AND its own place in the draw
  // order, both lerped from the outgoing state to the incoming one at the eased
  // fraction. One pass over the freshly ordered points, so the group filter -- six
  // passes over N at rest -- disappears and a glide frame costs about a resting frame.
  OlatRenderer.prototype._drawTween = function (data, no, m) {
    var W = this.W, H = this.H, px = this.px, py = this.py, offs = this._offs;
    var e = this._tw.e;
    this._orderFrame(e);
    var ord = this._ord, n = this._ordN, cf = this._colFrom, ct = this._colTo;
    for (var k = 0; k < n; k++) {
      var i = ord[k], j = i * 3;
      var x = px[i] | 0, y = py[i] | 0;
      if (x < -m || y < -m || x > W + m || y > H + m) continue;   // cull off-screen (zoom)
      var cr = (cf[j] + (ct[j] - cf[j]) * e + 0.5) | 0;
      var cg = (cf[j + 1] + (ct[j + 1] - cf[j + 1]) * e + 0.5) | 0;
      var cb = (cf[j + 2] + (ct[j + 2] - cf[j + 2]) * e + 0.5) | 0;
      for (var o = 0; o < no; o++) {
        var xx = x + offs[o][0], yy = y + offs[o][1];
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        var kk = (yy * W + xx) * 4;
        data[kk] = cr; data[kk + 1] = cg; data[kk + 2] = cb;
      }
    }
  };

  OlatRenderer.prototype._ensureBuf = function () {
    if (this._buf && this._buf.width === this.W && this._buf.height === this.H) return;
    this._buf = this.ctx.createImageData(this.W, this.H);
    this._grp = new Uint8Array(this.N);
  };

  // The dot "stamp" (a filled disc of pixel offsets) grows with the zoom level so the
  // dots fatten as you zoom in, countering the way they spread apart. z=1 is the
  // touching baseline; the 0.83 exponent lets them spread a little (a sense of
  // zooming) while max zoom (8x) still covers ~half the area rather than going sparse.
  OlatRenderer.prototype.DOT_GROWTH = 0.83;
  OlatRenderer.prototype._ensureStamp = function () {
    if (this._offs && this._offsForZ === this.z) return;
    var r = Math.max(1, Math.round(this.R * Math.pow(this.z, this.DOT_GROWTH)));
    var offs = [];
    for (var dy = -r; dy <= r; dy++)
      for (var dx = -r; dx <= r; dx++)
        if (dx * dx + dy * dy <= r * r + r) offs.push([dx, dy]);   // filled disc
    this._offs = offs;
    this._offsR = r;
    this._offsForZ = this.z;
  };

  // group each destination + give a colour table and a far->near draw order
  OlatRenderer.prototype._groups = function () {
    return (this.view === "time") ? this._groupsTime() : this._groupsDiff();
  };

  OlatRenderer.prototype._groupsTime = function () {
    var N = this.N, t = this._times, sent = this.sentinel, lut = this.binLut, thr = this.threshold;
    var grp = this._grp, sep = this.separateUnreachable, i;
    if (thr == null) {
      for (i = 0; i < N; i++) { var v = t[i]; grp[i] = (v >= sent) ? (sep ? 6 : 5) : lut[v]; }
      var cols = this.colours.slice(); cols[6] = [201, 184, 214];         // #c9b8d6
      return { grp: grp, colours: cols, order: sep ? [6, 5, 4, 3, 2, 1, 0] : [5, 4, 3, 2, 1, 0] };
    }
    for (i = 0; i < N; i++) { var vv = t[i]; grp[i] = (vv >= sent) ? (sep ? 2 : 0) : (vv <= thr ? 1 : 0); }
    var bi = lut[Math.max(0, Math.min(sent, (thr | 0) - 1))];
    var c2 = [[232, 238, 243], this.colours[bi]];                         // 0 beyond, 1 within
    if (sep) c2[2] = [201, 184, 214];
    return { grp: grp, colours: c2, order: sep ? [2, 0, 1] : [0, 1] };
  };

  OlatRenderer.prototype._groupsDiff = function () {
    var N = this.N, sent = this.sentinel, ptv = this._ch.R;
    var modev = this.view === "diff-car" ? this._ch.B : this._ch.G;
    var grp = this._grp, edges = [1, 5, 10, 20, 30];
    for (var i = 0; i < N; i++) {
      var m = modev[i], p = ptv[i];
      if (m >= sent) { grp[i] = 6; continue; }          // both unreachable
      if (p >= sent) { grp[i] = 5; continue; }          // newly reachable
      var save = p - m, bi = 0;
      for (var e = edges.length - 1; e >= 0; e--) { if (save >= edges[e]) { bi = e; break; } }
      grp[i] = bi;
    }
    var cols = [[237, 248, 233], [186, 228, 179], [116, 196, 118], [49, 163, 84], [0, 109, 44]];
    cols[5] = [106, 81, 163];                            // #6a51a3 newly reachable
    cols[6] = [238, 241, 244];                           // #eef1f4 unreachable
    return { grp: grp, colours: cols, order: [6, 0, 1, 2, 3, 4, 5] };
  };

  /* ---- colour transitions ------------------------------------------------
     The map has no GPU layer to hand a transition to -- it plots every dot itself --
     so the glide is hand-rolled. It tweens the RENDERED COLOUR of each point, not the
     minutes behind it: _times is committed the instant the change is made, so the mean,
     the catchment %, the reachable count and the hover readout are right from the first
     frame while the picture catches up. Tweening colour also makes this palette-blind,
     so an origin change inside a difference map or the isochrone glides for free.  */

  OlatRenderer.prototype._ensureTweenBufs = function () {
    var N = this.N;
    if (this._colFrom && this._colFrom.length === N * 3) return;
    this._colFrom = new Uint8Array(N * 3);
    this._colTo = new Uint8Array(N * 3);
    this._rkFrom = new Float32Array(N);
    this._rkTo = new Float32Array(N);
    this._bin = new Uint8Array(N);
    this._ord = new Int32Array(N);
  };

  // per-point RGB for a grouping result, flattened into out[i*3..]
  OlatRenderer.prototype._fillColours = function (res, out) {
    var N = this.N, grp = res.grp, cols = res.colours;
    var tbl = new Uint8Array(256 * 3);           // flatten once; keep the inner loop flat
    for (var g = 0; g < cols.length; g++) {
      var c = cols[g]; if (!c) continue;
      tbl[g * 3] = c[0]; tbl[g * 3 + 1] = c[1]; tbl[g * 3 + 2] = c[2];
    }
    for (var i = 0; i < N; i++) {
      var b = grp[i] * 3, j = i * 3;
      out[j] = tbl[b]; out[j + 1] = tbl[b + 1]; out[j + 2] = tbl[b + 2];
    }
  };

  /* Draw ORDER has to be tweened too, not just colour.
     Overlaps resolve best-last, so which dot wins a contested pixel depends on the
     ranking. Holding the target's ranking for the whole glide made the first frame
     show, at every contested pixel, the outgoing colour of whichever dot will be best
     in the INCOMING state -- which is worse than or equal to the dot that is best in
     the outgoing state, never better. So a glide opened with a brief systematic step
     backwards (some yellow flicking to orange) before improving. Interpolating the
     rank alongside the colour makes e=0 the outgoing frame and e=1 the incoming frame,
     both exactly, with nothing between them to explain away.

     Ranks are normalised to 0..1 so a from-state and a to-state with different band
     counts (six journey-time bands vs the isochrone's two) stay comparable, and -1
     marks a point the target does not draw. */
  OlatRenderer.prototype._fillRanks = function (res, out) {
    var N = this.N, grp = res.grp, order = res.order, K = order.length;
    var rank = new Float32Array(256), i;
    for (i = 0; i < 256; i++) rank[i] = -1;
    var div = K > 1 ? K - 1 : 1;
    for (i = 0; i < K; i++) if (res.colours[order[i]]) rank[order[i]] = i / div;
    for (i = 0; i < N; i++) out[i] = rank[grp[i]];
  };

  /* Order the points for one frame at eased fraction e.
     Quantising the interpolated rank into QBINS lets this be a counting sort -- O(N)
     with a 64-entry histogram -- instead of sorting 35,650 floats every frame. The
     bins are far enough apart that at e=0 and e=1 the quantisation is exact, so both
     ends reproduce the resting group order (and therefore the resting frame) exactly;
     the sort is stable in index order, which is what the resting group loop does too.
     Rank ties break by index, so dots only ever swap when their ranks actually cross,
     and at a crossing their interpolated colours are at their closest. */
  OlatRenderer.prototype.QBINS = 64;
  OlatRenderer.prototype._orderFrame = function (e) {
    var N = this.N, rf = this._rkFrom, rt = this._rkTo, bin = this._bin, ord = this._ord;
    var QB = this.QBINS, sc = QB - 1, i, b, a;
    var counts = this._qc || (this._qc = new Int32Array(QB + 1));
    counts.fill(0);
    for (i = 0; i < N; i++) {
      if (rt[i] < 0) { bin[i] = 255; continue; }        // the target does not draw it
      a = rf[i]; if (a < 0) a = rt[i];                  // new to the picture: don't move it
      b = ((a + (rt[i] - a) * e) * sc + 0.5) | 0;
      if (b < 0) b = 0; else if (b > sc) b = sc;
      bin[i] = b; counts[b + 1]++;
    }
    for (i = 0; i < QB; i++) counts[i + 1] += counts[i];
    this._ordN = counts[QB];
    for (i = 0; i < N; i++) { b = bin[i]; if (b !== 255) ord[counts[b]++] = i; }
  };

  // Collapse an in-flight glide into its from-buffer, so the next one starts from
  // exactly what is on screen rather than snapping back to the last resting state.
  OlatRenderer.prototype._freezeFrom = function (e) {
    var cf = this._colFrom, ct = this._colTo, n = this.N * 3, j;
    for (j = 0; j < n; j++) cf[j] = (cf[j] + (ct[j] - cf[j]) * e + 0.5) | 0;
    var rf = this._rkFrom, rt = this._rkTo, N = this.N, i;
    for (i = 0; i < N; i++) {
      if (rt[i] < 0) continue;
      rf[i] = rf[i] < 0 ? rt[i] : rf[i] + (rt[i] - rf[i]) * e;
    }
  };

  // Land the glide: cancel the frame, drop back to the resting group path, and (unless
  // the caller is about to repaint anyway) render once, so the settled frame always
  // comes out of the original renderer and no drift can accumulate.
  OlatRenderer.prototype._endTween = function (repaint) {
    var tw = this._tw;
    if (!tw.active && !tw.raf) return;
    tw.token++;
    if (tw.raf) { cancelAnimationFrame(tw.raf); tw.raf = null; }
    tw.active = false; tw.e = 1;
    window.__olatEasing = false;
    if (repaint !== false) this.render();
  };

  /* A state change can touch several things at once -- a scenario switch changes mode
     availability, the image directory and the origin together -- and the origin load is
     async. So bracket it: beginTransition snapshots what is on screen and HOLDS that
     frame, the caller mutates whatever it likes, and commitTransition glides to the
     result. One paint, of the truth, instead of a flash of half-applied state. */
  OlatRenderer.prototype.beginTransition = function () {
    if (!this._ch) return;                       // nothing on screen yet -> plain first paint
    this._ensureTweenBufs();
    var tw = this._tw;
    if (tw.active) {
      this._freezeFrom(tw.e);                    // supersession: carry on from the live frame
      tw.token++;
      if (tw.raf) { cancelAnimationFrame(tw.raf); tw.raf = null; }
      tw.active = false;
    } else {
      this._ensureBuf();                         // _grp must exist before _groups()
      var from = this._groups();
      this._fillColours(from, this._colFrom);
      this._fillRanks(from, this._rkFrom);
    }
    this._suppress = true;
    // watchdog: never leave the map frozen if a fetch neither resolves nor rejects
    var self = this, tok = ++this._brToken;
    clearTimeout(this._brTimer);
    this._brTimer = setTimeout(function () {
      if (self._suppress && tok === self._brToken) self.cancelTransition();
    }, 4000);
  };

  OlatRenderer.prototype.commitTransition = function () {
    this._brToken++; clearTimeout(this._brTimer);
    this._suppress = false;
    if (!this._ch) return;
    if (!this._colFrom || !TRANSITION) { this._endTween(false); this.render(); return; }
    this._ensureBuf();
    var res = this._groups();
    this._fillColours(res, this._colTo);
    this._fillRanks(res, this._rkTo);
    var tw = this._tw, self = this;
    tw.active = true; tw.e = 0; tw.dur = TRANSITION; tw.samples = [];
    tw.t0 = (performance && performance.now) ? performance.now() : Date.now();
    var tok = ++tw.token;
    window.__olatEasing = true;
    (function step() {
      tw.raf = requestAnimationFrame(function () {
        if (tok !== tw.token) return;            // superseded: the newer glide owns the map
        var now = (performance && performance.now) ? performance.now() : Date.now();
        var t = tw.dur > 0 ? Math.min((now - tw.t0) / tw.dur, 1) : 1;
        tw.e = easeCubicInOut(t);
        self.render();
        // Frame budget. A big canvas honestly costs ~25 ms a frame and reads fine, so
        // this only catches a slideshow: below ~20fps, land it now, because an honest
        // cut beats a stutter. The first sample is dropped -- it carries the click
        // handler's own work rather than the steady-state cost of a frame.
        if (tw.samples && tw.samples.length < 4) {
          tw.samples.push(self._lastRenderMs || 0);
          if (tw.samples.length === 4 &&
              (tw.samples[1] + tw.samples[2] + tw.samples[3]) / 3 > 50) {
            self._endTween(); return;
          }
        }
        if (t < 1) { step(); return; }
        self._endTween();
      });
    })();
  };

  // Abandon the bracket without gliding (the data never arrived): unfreeze and repaint.
  OlatRenderer.prototype.cancelTransition = function () {
    this._brToken++; clearTimeout(this._brTimer);
    this._suppress = false;
    if (this._ch) this.render();
  };

  OlatRenderer.prototype._threshColour = function (thr) {
    // colour the catchment by the band that ENDS at the threshold (round down):
    // 15 -> <15 (blue), 45 -> 30-45 (pale green). Use thr-1 so an edge value
    // lands in the band below it rather than the one above.
    var b = this.binLut[Math.max(0, Math.min(this.sentinel, (thr | 0) - 1))];
    return rgbCss(this.colours[b]);
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
      (self.cache[self._imgUrl(s)] ? Promise.resolve() : self._loadImage(s)).then(function () {
        (window.requestIdleCallback || window.setTimeout)(next, window.requestIdleCallback ? undefined : 60);
      }).catch(function () { setTimeout(next, 120); });
    })();
  };

  function addDot(path, x, y, r) { path.moveTo(x + r, y); path.arc(x, y, r, 0, TAU); }
  function rgbCss(c) { return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")"; }

  // Capture/test hooks, matching the other interactives: __olatEasing is true while a
  // glide is in flight, __olatEaseMs(n) overrides the duration (0 = the old hard cut).
  window.__olatEasing = false;
  window.__olatEaseMs = function (n) { TRANSITION = Math.max(0, n | 0); return TRANSITION; };

  window.OlatRenderer = OlatRenderer;
})();
