/* The replay's bus icons: a double decker, a single decker and, for night
 * routes, a purple triple decker (Claude Design, 19 Oct 2026, from Neil's
 * spec). Generated from Design's SVGs by a script that keeps only the shapes
 * in the five named groups (body, windows, outline, wheels, hubs); edit the
 * SVGs and regenerate rather than editing this by hand.
 *
 * icon(kind, {flip, body, windows}) gives deck.gl's IconLayer an icon object
 * for auto-packing: an SVG data URL with the body and windows recoloured (not
 * in service: a grey body; in service: windows in the bus's trail colour) and
 * mirrored for a bus heading west, so it always drives forwards. All three
 * share their width, wheels and ground line, so the anchor is where the
 * wheels meet the road and swapping one for another never moves the bus.
 */
(function (root) {
  'use strict';
  var SHAPES = {
  "double": {
    "w": 64,
    "h": 40,
    "body": "<path d=\"M3 31 V6 Q3 3 6 3 H55 Q61 3 61 9 V31 Z\"/>",
    "colour": "#D6342C",
    "windows": "<path d=\"M6 6 H54 Q58 6 58 10 V13 H6 Z\"/><path d=\"M6 17 H58 V27 H52 V24 H6 Z\"/>",
    "outline": "<path d=\"M3 31 V6 Q3 3 6 3 H55 Q61 3 61 9 V31 Z\"/><circle cx=\"16\" cy=\"31\" r=\"6\"/><circle cx=\"47\" cy=\"31\" r=\"6\"/>",
    "wheels": "<circle cx=\"16\" cy=\"31\" r=\"6\"/><circle cx=\"47\" cy=\"31\" r=\"6\"/>",
    "hubs": "<circle cx=\"16\" cy=\"31\" r=\"2\"/><circle cx=\"47\" cy=\"31\" r=\"2\"/>",
    "ground": 37.0
  },
  "single": {
    "w": 64,
    "h": 30,
    "body": "<path d=\"M3 21 V6 Q3 3 6 3 H55 Q61 3 61 9 V21 Z\"/>",
    "colour": "#D6342C",
    "windows": "<path d=\"M6 6 H54 Q58 6 58 10 V16 H52 V13 H6 Z\"/>",
    "outline": "<path d=\"M3 21 V6 Q3 3 6 3 H55 Q61 3 61 9 V21 Z\"/><circle cx=\"16\" cy=\"21\" r=\"6\"/><circle cx=\"47\" cy=\"21\" r=\"6\"/>",
    "wheels": "<circle cx=\"16\" cy=\"21\" r=\"6\"/><circle cx=\"47\" cy=\"21\" r=\"6\"/>",
    "hubs": "<circle cx=\"16\" cy=\"21\" r=\"2\"/><circle cx=\"47\" cy=\"21\" r=\"2\"/>",
    "ground": 27.0
  },
  "triple": {
    "w": 64,
    "h": 50,
    "body": "<path d=\"M3 41 V6 Q3 3 6 3 H55 Q61 3 61 9 V41 Z\"/>",
    "colour": "#6B3FA0",
    "windows": "<path d=\"M6 6 H54 Q58 6 58 10 V12 H6 Z\"/><path d=\"M6 16 H58 V22 H6 Z\"/><path d=\"M6 26 H58 V36 H52 V33 H6 Z\"/>",
    "outline": "<path d=\"M3 41 V6 Q3 3 6 3 H55 Q61 3 61 9 V41 Z\"/><circle cx=\"16\" cy=\"41\" r=\"6\"/><circle cx=\"47\" cy=\"41\" r=\"6\"/>",
    "wheels": "<circle cx=\"16\" cy=\"41\" r=\"6\"/><circle cx=\"47\" cy=\"41\" r=\"6\"/>",
    "hubs": "<circle cx=\"16\" cy=\"41\" r=\"2\"/><circle cx=\"47\" cy=\"41\" r=\"2\"/>",
    "ground": 47.0
  }
};
  var INK = '#1A2332', PAPER = '#F3F6F4', GREY = '#8A9490';
  var SCALE = 2;                         // drawn at twice size, for sharp edges

  function svg(s, body, windows, flip) {
    var g = '<g fill="' + body + '">' + s.body + '</g>' +
      '<g fill="' + windows + '">' + s.windows + '</g>' +
      '<g fill="none" stroke="' + INK + '" stroke-width="2" stroke-linejoin="round">' + s.outline + '</g>' +
      '<g fill="' + INK + '">' + s.wheels + '</g>' +
      '<g fill="' + PAPER + '">' + s.hubs + '</g>';
    if (flip) g = '<g transform="translate(' + s.w + ' 0) scale(-1 1)">' + g + '</g>';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + s.w + ' ' + s.h +
      '" width="' + s.w * SCALE + '" height="' + s.h * SCALE + '">' + g + '</svg>';
  }

  function hex(c) {
    if (typeof c === 'string') return c;
    return '#' + c.slice(0, 3).map(function (v) { return ('0' + Math.round(v).toString(16)).slice(-2); }).join('');
  }

  // kind: 'double' | 'single' | 'triple'. opts.flip: heading west.
  // opts.dead: not in service (grey body, plain windows). opts.windows: the
  // trail colour as [r, g, b] or '#rrggbb'; plain if absent.
  function icon(kind, opts) {
    var s = SHAPES[kind] || SHAPES.double;
    opts = opts || {};
    var body = opts.dead ? GREY : s.colour;
    var win = opts.dead || !opts.windows ? PAPER : hex(opts.windows);
    return {
      id: [kind, opts.flip ? 'w' : 'e', body, win].join('|'),
      url: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg(s, body, win, !!opts.flip)),
      width: s.w * SCALE, height: s.h * SCALE,
      anchorX: s.w * SCALE / 2, anchorY: s.ground * SCALE,
    };
  }

  // the icon's height over its width, to place a label just above it
  function aspect(kind) { var s = SHAPES[kind] || SHAPES.double; return s.ground / s.w; }

  var api = { icon: icon, aspect: aspect, svg: svg, SHAPES: SHAPES };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NgbusBuses = api;
})(typeof self !== 'undefined' ? self : this);
