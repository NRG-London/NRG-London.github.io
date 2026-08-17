/* ================================================================
   NeilGarratt.com — Chart export
   Turns the chart a reader is currently looking at into a PNG in
   their Downloads folder, entirely in the browser.

   WHY THIS EXISTS. People share these charts by screenshotting them,
   and the natural crop — title plus bars — used to leave the source
   line and the NeilGarratt.com tag behind. This produces the whole
   composition as one image, at one fixed size, so a phone and a
   desktop yield the same picture and nobody has to crop anything.

   HOW IT KEEPS FAITH WITH THE CHART. It does NOT redraw the bars. It
   clones the live <svg> the engine just rendered and composes a frame
   around it, so the exported geometry is the engine's own by
   construction rather than by agreement. A third renderer would be a
   third thing to keep in step with chart-core.js, and it would drift.

   THE TWO THINGS THAT MAKE THIS AWKWARD, both handled below:
     - A rasterised SVG cannot see the page's CSS, so every font size
       and family has to be written into the exported document.
     - It cannot see the page's FONTS either — canvas treats the SVG as
       an isolated document with no access to the parent's font set —
       so the woff2 files are fetched and base64-embedded on first use.

   REQUIRES chart-core.js (for INK/PAPER/DEEP and esc).

   Public API:
     NGExport.download(figure, filename) -> Promise<void>
     NGExport.compose(figure)            -> Promise<string>   (the SVG; tests)
     NGExport.FONT_URLS                  -> overridable, for tests
   ================================================================ */
(function (global) {
  'use strict';

  var C = global.NGCore;
  if (!C) throw new Error('chart-export.js requires chart-core.js');

  var SVG_NS = 'http://www.w3.org/2000/svg';

  /* ---------- composition geometry ----------
     Mirrors the .ng-chart card in ng-chart.css, in SVG units rather than rem.
     The chart itself is 760 wide, which is what sets the page width. */
  var PAD = 34;
  var W = 760 + PAD * 2;
  var SCALE = 2;                  // 828pt -> 1656px PNG

  var T = {
    eyebrow:  { size: 11,   weight: 700,  spacing: 1.1, gapAfter: 18 },
    title:    { size: 25,   weight: 700,  line: 33,     gapAfter: 10 },
    subtitle: { size: 15,   weight: 400,  line: 22,     gapAfter: 20 },
    note:     { size: 12.5, weight: 400,  line: 18,     gapAfter: 14 },
    foot:     { size: 12,   weight: 400,  gapBefore: 13 },
    legend:   { size: 13,   weight: 500,  gapBefore: 16, swatch: 12 }
  };

  var SANS = "'DM Sans', system-ui, sans-serif";
  var SERIF = "'Libre Baskerville', Georgia, serif";

  /* Mirrors the @font-face block in main.css, weights included: Libre
     Baskerville ships one file served at both 400 and 700, DM Sans is variable
     across 300-700. Declaring the same mapping is what makes the exported text
     render as the page renders it rather than merely in the right typeface.

     Overridable so a test can point them at a dead URL and prove the fallback. */
  var FONT_URLS = {
    'DM Sans': { url: '/fonts/dm-sans.woff2', weights: ['300 700'] },
    'Libre Baskerville': { url: '/fonts/libre-baskerville.woff2', weights: ['400', '700'] }
  };

  /* ---------- fonts ----------
     Fetched once, lazily, on the first export — never on page load, because
     most readers never press the button. Cached as a promise so a double click
     does not fetch twice.

     A failure here is not fatal. An image in Helvetica is worth far more to
     someone trying to share a chart than an error message, so the fallback is
     to carry on with a system stack. */
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
            console.warn('chart-export: could not embed ' + family
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
     Safari, so the wrapping is done here and emitted as <tspan> lines.

     Measured with canvas rather than estimated: the page HAS the real fonts
     loaded, so measureText is exact, and a title is long enough that
     chart-core's character-width approximation would visibly misjudge it. */
  var ctx = null;
  function measure(text, size, weight, family) {
    if (!ctx) ctx = document.createElement('canvas').getContext('2d');
    ctx.font = weight + ' ' + size + 'px ' + family;
    return ctx.measureText(text).width;
  }

  function wrap(text, size, weight, family, maxW) {
    var words = String(text || '').split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    var lines = [], line = words[0];
    for (var i = 1; i < words.length; i++) {
      var test = line + ' ' + words[i];
      if (measure(test, size, weight, family) <= maxW) line = test;
      else { lines.push(line); line = words[i]; }
    }
    lines.push(line);
    return lines;
  }

  /* ---------- small svg builders ---------- */
  function attrs(o) {
    var s = '';
    for (var k in o) if (o[k] != null && o[k] !== '') s += ' ' + k + '="' + o[k] + '"';
    return s;
  }
  function text(s, o) { return '<text' + attrs(o) + '>' + C.esc(s) + '</text>'; }
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

  /* ---------- reading the card ----------
     Everything comes off the live DOM, so the export cannot show a different
     crime type, period or caveat from the one on screen. */
  function readCard(figure) {
    function txt(sel) {
      var n = figure.querySelector(sel);
      return n ? n.textContent.trim() : '';
    }
    var legend = [];
    figure.querySelectorAll('.ngc-legend:not([hidden]) .ngc-legend__item')
      .forEach(function (item) {
        var sw = item.querySelector('.ngc-legend__swatch');
        legend.push({
          label: item.textContent.trim(),
          color: sw ? getComputedStyle(sw).backgroundColor : '#0070BA'
        });
      });
    return {
      dark: figure.getAttribute('data-tone') === 'bold',
      eyebrow: txt('.ng-chart__eyebrow'),
      title: txt('.ng-chart__title'),
      subtitle: txt('.ng-chart__subtitle'),
      note: txt('.ngl-note'),
      source: txt('.ng-chart__source'),
      tag: txt('.ng-chart__tag'),
      legend: legend,
      svg: figure.querySelector('.ngc-svg')
    };
  }

  /* The chart's own text is styled by ng-chart.css classes that do not travel
     with a cloned node, so the class rules are restated here as literal values.
     Keep in step with the .ngc-* block in ng-chart.css. */
  function chartCss(dark) {
    return '.ngc-t{font-family:' + SANS + ';}'
         + '.ngc-axis{font-size:13px;}'
         + '.ngc-cat{font-size:' + (dark ? 14.5 : 13.5) + 'px;font-weight:500;}'
         + '.ngc-val{font-size:' + (dark ? 16 : 14) + 'px;}';
  }

  /* ---------- compose ----------
     Same running order as the card on the page: eyebrow, title, subtitle,
     chart, legend, caveat note, rule, source and tag. The note is above the
     rule for the same reason it is on the page — a caveat that can be cropped
     away from the bars it qualifies is not a caveat. */
  function compose(figure) {
    var card = readCard(figure);
    if (!card.svg) return Promise.reject(new Error('no chart svg to export'));

    var ink = card.dark ? C.PAPER : C.INK;
    var paper = card.dark ? C.DEEP : '#ffffff';
    var sub = card.dark ? 'rgba(243,246,244,0.62)' : '#6B7670';
    var rule = card.dark ? 'rgba(243,246,244,0.15)' : '#dde3df';
    var accent = card.dark ? '#5a9fd4' : '#0070BA';
    var inner = W - PAD * 2;

    var body = '', y = PAD;

    if (card.eyebrow) {
      y += T.eyebrow.size;
      body += line({ x1: PAD, x2: PAD + 20, y1: y - 4, y2: y - 4,
                     stroke: accent, 'stroke-width': 2 });
      body += text(card.eyebrow.toUpperCase(), {
        x: PAD + 30, y: y, 'font-family': SANS, 'font-size': T.eyebrow.size,
        'font-weight': T.eyebrow.weight, 'letter-spacing': T.eyebrow.spacing,
        fill: accent
      });
      y += T.eyebrow.gapAfter;
    }

    var titleFamily = card.dark ? SANS : SERIF;
    var titleLines = wrap(card.title, T.title.size, T.title.weight, titleFamily, inner);
    y += T.title.size;
    body += block(titleLines, PAD, y, T.title, ink, titleFamily);
    y += (titleLines.length - 1) * T.title.line + T.title.gapAfter;

    var subLines = wrap(card.subtitle, T.subtitle.size, T.subtitle.weight, SANS, inner);
    if (subLines.length) {
      y += T.subtitle.size;
      body += block(subLines, PAD, y, T.subtitle, sub, SANS);
      y += (subLines.length - 1) * T.subtitle.line + T.subtitle.gapAfter;
    }

    /* The chart itself. Its viewBox height varies — rotated category labels add
       to it — so it is read rather than assumed.

       The svg's CHILDREN are lifted into a <g>, not the <svg> element itself. A
       nested <svg> without explicit width/height resolves them against the
       parent viewport, not its own viewBox, so cloning the element whole draws
       the chart at the full page size on top of the frame. Its coordinates are
       already in viewBox space, so a plain translate places them exactly. */
    var vb = (card.svg.getAttribute('viewBox') || '0 0 760 430').trim().split(/[\s,]+/);
    var vbX = parseFloat(vb[0]) || 0, vbY = parseFloat(vb[1]) || 0;
    var chartH = parseFloat(vb[3]) || 430;
    var kids = '';
    Array.prototype.forEach.call(card.svg.childNodes, function (n) {
      kids += new XMLSerializer().serializeToString(n);
    });
    body += '<g transform="translate(' + (PAD - vbX) + ',' + (y - vbY) + ')">'
          + kids + '</g>';
    y += chartH;

    if (card.legend.length) {
      y += T.legend.gapBefore + T.legend.size;
      var lx = PAD;
      card.legend.forEach(function (item) {
        body += rect({ x: lx, y: y - T.legend.swatch + 2, width: T.legend.swatch,
                       height: T.legend.swatch, rx: 1, fill: item.color });
        body += text(item.label, {
          x: lx + T.legend.swatch + 7, y: y, 'font-family': SANS,
          'font-size': T.legend.size, 'font-weight': T.legend.weight, fill: sub
        });
        lx += T.legend.swatch + 7
            + measure(item.label, T.legend.size, T.legend.weight, SANS) + 22;
      });
    }

    var noteLines = wrap(card.note, T.note.size, T.note.weight, SANS, inner);
    if (noteLines.length) {
      y += T.note.gapAfter + T.note.size;
      body += block(noteLines, PAD, y, T.note, sub, SANS, { 'font-style': 'italic' });
      y += (noteLines.length - 1) * T.note.line;
    }

    y += T.foot.gapBefore;
    body += line({ x1: PAD, x2: W - PAD, y1: y, y2: y, stroke: rule, 'stroke-width': 1 });
    y += T.foot.gapBefore + T.foot.size;
    body += text(card.source, {
      x: PAD, y: y, 'font-family': SANS, 'font-size': T.foot.size,
      'font-style': 'italic', fill: sub
    });
    body += text(card.tag, {
      x: W - PAD, y: y, 'text-anchor': 'end', 'font-family': SANS,
      'font-size': T.foot.size, 'font-weight': 600, 'letter-spacing': 0.7,
      fill: sub
    });
    var H = y + PAD;

    return fontFaceCss().then(function (faces) {
      return '<svg xmlns="' + SVG_NS + '" width="' + W + '" height="' + H
           + '" viewBox="0 0 ' + W + ' ' + H + '">'
           + '<style>' + faces + chartCss(card.dark) + '</style>'
           + rect({ x: 0, y: 0, width: W, height: H, fill: paper })
           + body
           + '</svg>';
    });
  }

  /* ---------- rasterise ---------- */
  function toBlob(svg) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      // A data: URL rather than a blob: URL — Safari taints the canvas for
      // blob-sourced SVG images, and a tainted canvas cannot be read back.
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      img.onload = function () {
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * SCALE);
        canvas.height = Math.round(img.height * SCALE);
        var c = canvas.getContext('2d');
        c.setTransform(SCALE, 0, 0, SCALE, 0, 0);
        c.drawImage(img, 0, 0);
        canvas.toBlob(function (blob) {
          blob ? resolve(blob) : reject(new Error('canvas produced no image'));
        }, 'image/png');
      };
      img.onerror = function () { reject(new Error('could not rasterise the chart')); };
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

  function download(figure, filename) {
    return compose(figure)
      .then(toBlob)
      .then(function (blob) { save(blob, filename || 'chart.png'); });
  }

  global.NGExport = {
    download: download, compose: compose, toBlob: toBlob,
    FONT_URLS: FONT_URLS, WIDTH: W, SCALE: SCALE,
    // Tests point FONT_URLS at a dead path to exercise the fallback; without
    // this the first export's cached promise would answer for the second.
    _resetFonts: function () { fontsPromise = null; }
  };
})(window);
