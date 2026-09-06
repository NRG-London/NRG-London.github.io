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

   THE TWO THINGS THAT MAKE THIS AWKWARD, both handled in ng-png.js:
     - A rasterised SVG cannot see the page's CSS, so every font size
       and family has to be written into the exported document.
     - It cannot see the page's FONTS either — canvas treats the SVG as
       an isolated document with no access to the parent's font set —
       so the woff2 files are fetched and base64-embedded on first use.

   WHAT IS LEFT HERE is only what knows about charts: the card's
   geometry, its typography, reading the .ng-chart DOM, and the running
   order of the composition. Everything that merely turns text and
   pixels into a PNG — wrapping, rasterising, the iTXt chunks, the XMP
   packet, the local-time stamp — moved to ng-png.js when the deck.gl
   maps needed the same thing. Two copies of a CRC-32 would have been a
   second implementation nobody rebuilds.

   REQUIRES chart-core.js (for INK/PAPER/DEEP) and ng-png.js.

   Public API:
     NGExport.download(figure, filename, meta) -> Promise<void>
     NGExport.compose(figure)            -> Promise<string>   (the SVG; tests)
     NGExport.FONT_URLS                  -> overridable, for tests
   ================================================================ */
(function (global) {
  'use strict';

  var C = global.NGCore;
  if (!C) throw new Error('chart-export.js requires chart-core.js');
  var P = global.NGPng;
  if (!P) throw new Error('chart-export.js requires ng-png.js');

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

  /* Text and rasterising live in ng-png.js; these are the chart's own names
     for them, so the composition below reads as it always did. */
  var measure = P.measure, wrap = P.wrap, block = P.block;
  var text = P.text, rect = P.rect, line = P.line;
  var fontFaceCss = P.fontFaceCss;

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
     chart, legend, rule, source and tag, caveat note.

     The note comes AFTER the attribution, which is the opposite of where it
     started. When the source line moved up above the selection pills — so that
     a reader cropping a screenshot to the title and the bars still takes the
     provenance with them — the page put the note below it, and this file was
     not moved with it. The two then disagreed for a release: the page read
     rule / source / note and the downloaded PNG read note / rule / source. The
     export exists to be the same picture as the page, so it follows the page. */
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

    y += T.foot.gapBefore;
    body += line({ x1: PAD, x2: W - PAD, y1: y, y2: y, stroke: rule, 'stroke-width': 1 });
    y += T.foot.gapBefore + T.foot.size;
    body += text(card.source, {
      x: PAD, y: y, 'font-family': SANS, 'font-size': T.foot.size,
      'font-style': 'italic', fill: sub
    });
    // The tag stays camel-case here while the page sets it in caps. That is
    // deliberate and not a drift: on screen the all-caps reads as a mark, but a
    // PNG can end up on a printout or a slide, where NeilGarratt.com is a URL
    // somebody has to type. Do not "fix" one to match the other.
    body += text(card.tag, {
      x: W - PAD, y: y, 'text-anchor': 'end', 'font-family': SANS,
      'font-size': T.foot.size, 'font-weight': 600, 'letter-spacing': 0.7,
      fill: sub
    });

    var noteLines = wrap(card.note, T.note.size, T.note.weight, SANS, inner);
    if (noteLines.length) {
      y += T.note.gapAfter + T.note.size;
      body += block(noteLines, PAD, y, T.note, sub, SANS, { 'font-style': 'italic' });
      y += (noteLines.length - 1) * T.note.line;
    }
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

  /* What the exporter can work out for itself, from the card it just drew.
     The standard fields come from ng-png; the chart supplies what it alone
     knows — that the caption is the subtitle plus the caveat note, and that
     the program that made this was the chart tool rather than the map one. */
  function baseMetadata(figure) {
    var card = readCard(figure);
    var tag = card.tag || 'NeilGarratt.com';
    return P.baseMeta({
      title: card.title,
      description: [card.subtitle, card.note].filter(Boolean).join(' '),
      source: card.source,
      tag: tag,
      software: tag + ' chart tool'
    });
  }

  function toBlob(svg) { return P.toBlob(svg, SCALE); }

  function download(figure, filename, meta) {
    var info = baseMetadata(figure);
    if (meta) {
      Object.keys(meta).forEach(function (k) { if (meta[k]) info[k] = meta[k]; });
    }
    return compose(figure)
      .then(toBlob)
      .then(function (blob) { return P.withMetadata(blob, info); })
      .then(function (blob) { P.save(blob, filename || 'chart.png'); });
  }

  global.NGExport = {
    download: download, compose: compose, toBlob: toBlob,
    withMetadata: P.withMetadata, baseMetadata: baseMetadata,
    // The SAME object ng-png holds, not a copy: a test that reassigns
    // NGExport.FONT_URLS['DM Sans'].url has to reach the fetch that uses it.
    FONT_URLS: P.FONT_URLS, WIDTH: W, SCALE: SCALE,
    _resetFonts: P._resetFonts
  };
})(window);
