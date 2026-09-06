/* ================================================================
   NeilGarratt.com — PNG export primitives
   The half of an image export that knows nothing about what is in
   the picture: wrap some text, rasterise an SVG, write PNG metadata,
   hand the file to the browser.

   WHY IT IS ITS OWN FILE. chart-export.js grew all of this for the 2D
   charts. The deck.gl maps need exactly the same metadata — the same
   iTXt chunks, the same XMP packet, the same local-time stamp — and a
   second implementation of a CRC-32 and a PNG chunk writer is precisely
   the drift this project keeps guarding against. So it moved here, and
   both exporters require it.

   NO DEPENDENCIES, deliberately. The map pages do not load chart-core.js
   and should not have to: they are self-contained single files with no
   external requests at all. That is why `esc` is restated here rather
   than borrowed from NGCore.

   Public API:
     NGPng.wrap(text, size, weight, family, maxW) -> string[]
     NGPng.block(lines, x, y, style, fill, family, extra) -> svg
     NGPng.measure / .text / .rect / .line / .attrs / .esc
     NGPng.toBlob(svg, scale)          -> Promise<Blob>
     NGPng.withMetadata(blob, meta)    -> Promise<Blob>
     NGPng.baseMeta(fields)            -> the standard metadata dict
     NGPng.isoLocal(date)              -> '2026-09-01T15:24:35+01:00'
     NGPng.save(blob, filename)
     NGPng.fontFaceCss()               -> Promise<string>  (fetches FONT_URLS)
     NGPng.FONT_URLS                   -> overridable, for tests
   ================================================================ */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ---------- fonts ----------
     Mirrors the @font-face block in main.css, weights included: Libre
     Baskerville ships one file served at both 400 and 700, DM Sans is variable
     across 300-700. Declaring the same mapping is what makes the exported text
     render as the page renders it rather than merely in the right typeface.

     Fetched once, lazily, on the first export — never on page load, because
     most readers never press the button. Cached as a promise so a double click
     does not fetch twice.

     A failure here is not fatal. An image in Helvetica is worth far more to
     someone trying to share a chart than an error message, so the fallback is
     to carry on with a system stack.

     A page that already HAS the faces base64-inlined — every deck.gl map does,
     via _font_css("inline") — should skip this entirely and pass its own CSS
     to the composer. There is nothing to fetch and nothing to fail.

     Overridable so a test can point them at a dead URL and prove the fallback. */
  var FONT_URLS = {
    'DM Sans': { url: '/fonts/dm-sans.woff2', weights: ['300 700'] },
    'Libre Baskerville': { url: '/fonts/libre-baskerville.woff2', weights: ['400', '700'] }
  };

  var fontsPromise = null;

  function fontFaceCss() {
    if (fontsPromise) return fontsPromise;
    fontsPromise = Promise.all(Object.keys(FONT_URLS).map(function (family) {
      var spec = FONT_URLS[family];
      return fetch(spec.url)
        .then(function (r) {
          if (!r.ok) throw new Error(r.status + ' ' + spec.url);
          return r.arrayBuffer();
        })
        .then(function (buf) {
          var src = "url(data:font/woff2;base64," + base64(buf) + ") format('woff2')";
          return spec.weights.map(function (w) {
            return "@font-face{font-family:'" + family + "';font-style:normal;"
                 + 'font-weight:' + w + ';src:' + src + ';}';
          }).join('');
        })
        .catch(function (err) {
          if (global.console) {
            console.warn('ng-png: could not embed ' + family
                         + ', falling back to a system font', err);
          }
          return '';
        });
    })).then(function (parts) { return parts.join(''); });
    return fontsPromise;
  }

  // btoa() needs a binary string, and String.fromCharCode.apply blows the
  // argument limit on a 37 KB font, so it goes across in chunks.
  function base64(buf) {
    var bytes = new Uint8Array(buf), out = '', CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return global.btoa(out);
  }

  /* ---------- text measurement ----------
     SVG has no line wrapping, and foreignObject rasterises unreliably in
     Safari, so the wrapping is done here and emitted as separate <text> lines.

     Measured with canvas rather than estimated: the page HAS the real fonts
     loaded, so measureText is exact, and a title is long enough that a
     character-width approximation would visibly misjudge it. */
  var ctx = null;
  function measure(text_, size, weight, family) {
    if (!ctx) ctx = document.createElement('canvas').getContext('2d');
    ctx.font = weight + ' ' + size + 'px ' + family;
    return ctx.measureText(text_).width;
  }

  function wrap(text_, size, weight, family, maxW) {
    var words = String(text_ || '').split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    var lines = [], line_ = words[0];
    for (var i = 1; i < words.length; i++) {
      var test = line_ + ' ' + words[i];
      if (measure(test, size, weight, family) <= maxW) line_ = test;
      else { lines.push(line_); line_ = words[i]; }
    }
    lines.push(line_);
    return lines;
  }

  /* ---------- small svg builders ---------- */
  function attrs(o) {
    var s = '';
    for (var k in o) if (o[k] != null && o[k] !== '') s += ' ' + k + '="' + o[k] + '"';
    return s;
  }
  function text(s, o) { return '<text' + attrs(o) + '>' + esc(s) + '</text>'; }
  function rect(o) { return '<rect' + attrs(o) + '/>'; }
  function line(o) { return '<line' + attrs(o) + '/>'; }

  function block(lines, x, y, style, fill, family, extra) {
    var out = '';
    for (var i = 0; i < lines.length; i++) {
      var o = {
        x: x, y: y + i * (style.line || style.size),
        'font-family': family, 'font-size': style.size,
        'font-weight': style.weight, fill: fill
      };
      for (var k in (extra || {})) o[k] = extra[k];
      out += text(lines[i], o);
    }
    return out;
  }

  /* ---------- rasterise ---------- */
  function toBlob(svg, scale) {
    var SC = scale || 1;
    return new Promise(function (resolve, reject) {
      var img = new Image();
      // A data: URL rather than a blob: URL — Safari taints the canvas for
      // blob-sourced SVG images, and a tainted canvas cannot be read back.
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      img.onload = function () {
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * SC);
        canvas.height = Math.round(img.height * SC);
        var c = canvas.getContext('2d');
        c.setTransform(SC, 0, 0, SC, 0, 0);
        c.drawImage(img, 0, 0);
        canvas.toBlob(function (blob) {
          blob ? resolve(blob) : reject(new Error('canvas produced no image'));
        }, 'image/png');
      };
      img.onerror = function () { reject(new Error('could not rasterise the image')); };
    });
  }

  /* Same as toBlob, but hands back the canvas instead of a blob, for a caller
     that has more to draw onto it — the map exporter paints the map into the
     frame rather than inlining a multi-megabyte data URI inside the SVG. */
  function toCanvas(svg, scale) {
    var SC = scale || 1;
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      img.onload = function () {
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * SC);
        canvas.height = Math.round(img.height * SC);
        var c = canvas.getContext('2d');
        c.setTransform(SC, 0, 0, SC, 0, 0);
        c.drawImage(img, 0, 0);
        resolve(canvas);
      };
      img.onerror = function () { reject(new Error('could not rasterise the frame')); };
    });
  }

  function save(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoked on the next turn, not immediately: some browsers have not started
    // reading the blob by the time click() returns.
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  /* ---------- metadata ----------
     Written into the PNG, not the SVG. The SVG is an intermediate that is
     rasterised and discarded, so anything put there would never leave the
     browser; the PNG is the file that travels, and PNG has a real metadata
     standard for exactly this.

     iTXt rather than tEXt: tEXt is Latin-1 only and this copy carries em
     dashes, middots and pound signs. iTXt is UTF-8 and just as widely read —
     ExifTool, ImageMagick, Pillow and most image viewers all handle it.

     The point is that a picture which has travelled far from this website can
     still say what it is, where the figures came from, when it was made, and
     which release of the data it was built on. Home Office revises its whole
     back-series every quarter, so a chart without its vintage cannot be
     reproduced even by us. */
  var CRC_TABLE = (function () {
    var t = [], c, n, k;
    for (n = 0; n < 256; n++) {
      c = n;
      for (k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function itxtChunk(keyword, body_) {
    var enc = new TextEncoder();
    // keyword \0 compressionFlag compressionMethod languageTag \0
    // translatedKeyword \0 text
    var head = enc.encode(keyword);
    var body = enc.encode(body_);
    var data = new Uint8Array(head.length + 5 + body.length);
    var o = 0;
    data.set(head, o); o += head.length;
    data[o++] = 0;      // null after keyword
    data[o++] = 0;      // not compressed
    data[o++] = 0;      // compression method (ignored when uncompressed)
    data[o++] = 0;      // empty language tag
    data[o++] = 0;      // empty translated keyword
    data.set(body, o);

    var type = enc.encode('iTXt');
    var chunk = new Uint8Array(12 + data.length);
    var dv = new DataView(chunk.buffer);
    dv.setUint32(0, data.length);
    chunk.set(type, 4);
    chunk.set(data, 8);
    var forCrc = new Uint8Array(4 + data.length);
    forCrc.set(type, 0);
    forCrc.set(data, 4);
    dv.setUint32(8 + data.length, crc32(forCrc));
    return chunk;
  }

  /* ---------- XMP ----------
     The iTXt chunks above are the PNG-native way to carry this, and a PNG
     reader will find every one of them. An OPERATING SYSTEM will not: Windows
     Explorer's Details tab, macOS's Get Info and most "image properties" panels
     read XMP and nothing else, so a file full of correct iTXt keywords shows up
     with nothing but its dimensions. Neil found exactly that.

     So the same facts go in twice. This is not duplication to be tidied away
     later — the two are read by different things, and dropping either loses a
     reader. The packet is an UNCOMPRESSED iTXt chunk keyed `XML:com.adobe.xmp`,
     which is where Adobe's PNG spec puts it and where Windows looks.

     Only the human-facing fields go in here. The picture's own figures stay in
     the iTXt chunks, where length costs nothing and no properties panel is
     going to render a hundred numbers anyway. */
  var XMP_KEY = 'XML:com.adobe.xmp';

  function xesc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // dc:title, dc:description and dc:rights are language alternatives, not plain
  // strings; a bare value is silently ignored by strict readers.
  function alt(tag, v) {
    return v ? '<' + tag + '><rdf:Alt><rdf:li xml:lang="x-default">' + xesc(v)
             + '</rdf:li></rdf:Alt></' + tag + '>' : '';
  }
  function seq(tag, kind, v) {
    return v ? '<' + tag + '><rdf:' + kind + '><rdf:li>' + xesc(v)
             + '</rdf:li></rdf:' + kind + '></' + tag + '>' : '';
  }
  function plain(tag, v) {
    return v ? '<' + tag + '>' + xesc(v) + '</' + tag + '>' : '';
  }

  function xmpPacket(meta) {
    var when = meta['Creation Time'] || '';
    var body =
        alt('dc:title', meta['Title'])
      + alt('dc:description', meta['Description'])
      + alt('dc:rights', meta['Copyright'])
      + seq('dc:creator', 'Seq', meta['Author'])
      + seq('dc:subject', 'Bag', meta['Category'])
      + plain('dc:source', meta['Source'])
      + plain('xmp:CreateDate', when)
      + plain('xmp:MetadataDate', when)
      + plain('xmp:CreatorTool', meta['Software'])
      + plain('photoshop:DateCreated', when)
      + plain('photoshop:Source', meta['Source'])
      + plain('photoshop:Credit', meta['Credit'])
      + plain('photoshop:Headline', meta['Title'])
      + alt('exif:UserComment', meta['Description']);
    return '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>'
         + '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="'
         + xesc(meta['Software'] || 'NeilGarratt.com') + '">'
         + '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
         + '<rdf:Description rdf:about=""'
         + ' xmlns:dc="http://purl.org/dc/elements/1.1/"'
         + ' xmlns:xmp="http://ns.adobe.com/xap/1.0/"'
         + ' xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"'
         + ' xmlns:exif="http://ns.adobe.com/exif/1.0/">'
         + body
         + '</rdf:Description></rdf:RDF></x:xmpmeta>'
         + '<?xpacket end="w"?>';
  }

  /* Inserted straight after IHDR, which the spec requires to be first and
     which is always 25 bytes: 8 signature + 4 length + 4 type + 13 data + 4
     CRC. Everything else is copied through untouched. */
  function withMetadata(blob, meta) {
    var keys = Object.keys(meta || {}).filter(function (k) { return meta[k]; });
    if (!keys.length) return Promise.resolve(blob);
    return blob.arrayBuffer().then(function (buf) {
      var png = new Uint8Array(buf);
      var head = png.subarray(0, 33);          // signature + IHDR
      var rest = png.subarray(33);
      var chunks = keys.map(function (k) { return itxtChunk(k, String(meta[k])); });
      chunks.unshift(itxtChunk(XMP_KEY, xmpPacket(meta)));
      var extra = chunks.reduce(function (n, c) { return n + c.length; }, 0);
      var out = new Uint8Array(head.length + extra + rest.length);
      var o = 0;
      out.set(head, o); o += head.length;
      chunks.forEach(function (c) { out.set(c, o); o += c.length; });
      out.set(rest, o);
      return new Blob([out], { type: 'image/png' });
    });
  }

  /* ISO 8601 in LOCAL time with an explicit offset — 2026-09-01T15:24:35+01:00
     — rather than the UTC form toISOString() gives.

     Both name the same instant, so both are correct, but they are not read the
     same way. Windows Explorer takes the wall-clock digits and ignores the zone
     entirely, so a chart made at 15:54 in British Summer Time was filed under
     14:54. The offset form survives that: a reader that honours the zone gets
     the right instant, and a reader that only looks at the digits gets the
     right local time. The Z form is only correct for the first kind.

     Nothing here is guessed from a locale — getTimezoneOffset is the machine's
     own answer, in minutes BEHIND UTC, hence the negation. */
  function isoLocal(d) {
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    var off = -d.getTimezoneOffset();
    var abs = Math.abs(off);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
         + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds())
         + (off < 0 ? '-' : '+') + p2(Math.floor(abs / 60)) + ':' + p2(abs % 60);
  }

  /* The standard field set, from whatever the caller could read off its own
     page. `software` is the one thing that differs between exporters — a chart
     tool and a map tool are not the same program. */
  function baseMeta(f) {
    var now = new Date();
    var tag = f.tag || 'NeilGarratt.com';
    return {
      'Title': f.title || '',
      'Author': 'Neil Garratt',
      'Copyright': '© ' + now.getFullYear() + ' Neil Garratt. ' + tag,
      // Full ISO rather than a bare date: XMP carries this to Explorer's
      // "Date taken", and a date-only value shows there as midnight. Local
      // with an offset rather than UTC — see isoLocal above.
      'Creation Time': isoLocal(now),
      'Description': f.description || '',
      'Source': (f.source || '').replace(/^Source:\s*/, ''),
      'Credit': tag,
      'Software': f.software || (tag + ' export')
    };
  }

  global.NGPng = {
    esc: esc, base64: base64,
    FONT_URLS: FONT_URLS, fontFaceCss: fontFaceCss,
    measure: measure, wrap: wrap, block: block,
    attrs: attrs, text: text, rect: rect, line: line,
    toBlob: toBlob, toCanvas: toCanvas, save: save,
    crc32: crc32, itxtChunk: itxtChunk, XMP_KEY: XMP_KEY,
    xmpPacket: xmpPacket, withMetadata: withMetadata,
    isoLocal: isoLocal, baseMeta: baseMeta,
    // Tests point FONT_URLS at a dead path to exercise the fallback; without
    // this the first export's cached promise would answer for the second.
    _resetFonts: function () { fontsPromise = null; }
  };
})(window);
