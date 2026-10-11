/* ================================================================
   Housing costs interactive — "Subsidised Not Affordable" campaign.
   Behaviour for layouts/shortcodes/housing-costs.html; styles in
   /css/housing-costs.css. Data: /interactive/housing-costs/housing.json,
   built by build_data.py + publish_campaign.py in housing-costs-lab/.

   The shortcode is placed once per part ("map", "spread", "calculator"),
   so prose can sit between the parts. This script wires whichever parts
   are on the page; any of them can be left out. They share one state:
     - one home size for the page (every size control shows the same one)
     - one borough in the calculator, set by clicking a borough anywhere
   No floating tooltips: the map feeds a fixed data box, the dumbbell
   labels the hovered row in place.

   Proven in the unlisted /labs/housing/page/ workbench.
   ================================================================ */
(function () {
  'use strict';

  // House sequential ramp (the census explorer's), light -> dark.
  const RAMP = ['#E2EEF7', '#B4D4EB', '#80B4DD', '#4A92CC', '#1877B8', '#004D80'];

  const SIZES = [
    { key: 'mix', label: 'All homes' },
    { key: '1', label: '1 bed' },
    { key: '2', label: '2 bed' },
    { key: '3', label: '3 bed' },
    { key: '4', label: '4+ bed' },
  ];

  const gbp = (v) => '£' + Math.round(v).toLocaleString('en-GB');
  const gbpK = (v) => v >= 1e6 ? '£' + (v / 1e6).toFixed(2) + 'm'
    : '£' + Math.round(v / 1000).toLocaleString('en-GB') + 'k';
  const gbpShortK = (v) => v >= 10000 ? '£' + Math.round(v / 1000) + 'k' : '£' + (v / 1000).toFixed(1) + 'k';
  const pct1 = (v) => v.toFixed(1) + '%';
  const pct0 = (v) => Math.round(v) + '%';
  const gbpM = (v) => v >= 1000 ? '£' + (v / 1000).toFixed(1) + 'bn' : '£' + Math.round(v) + 'm';

  // Menu order is the reading order: the two rents, then the gap and what it adds up to.
  // `note` takes the size key, so a note can name the home size selected.
  const BEDS = { mix: '', 1: '1-bedroom ', 2: '2-bedroom ', 3: '3-bedroom ', 4: '4+ bedroom ' };
  const METRICS = [
    { key: 'private', label: 'Private rent', fmt: gbp, fmtShort: gbp, fmtTick: gbpShortK, shared: 'rent',
      note: () => 'Typical private rent, £ a month. Same colour scale as social rent.' },
    { key: 'social', label: 'Social rent', fmt: gbp, fmtShort: gbp, fmtTick: gbpShortK, shared: 'rent',
      note: () => 'Social rent, £ a month, on the same colour scale as private rent.' },
    { key: 'gap', label: 'Monthly gap', fmt: gbp, fmtShort: gbp, fmtTick: gbpShortK,
      note: () => 'Typical private rent minus social rent, £ a month.' },
    { key: 'aggM', label: 'Borough total', fmt: gbpM, fmtShort: gbpM, fmtTick: gbpM,
      note: (size) => 'The notional total gap between all the borough’s ' + BEDS[size] +
        'social homes and the typical private rent, per year.' },
    { key: 'npv', label: 'Value over 25 years', fmt: gbpK, fmtShort: gbpK, fmtTick: gbpK,
      note: () => 'The total cash value of a 25-year social tenancy in today’s money (discounted at the Treasury Green Book 3.5%).' },
    // One figure per borough, not per home size: `val` returns it whatever size is chosen.
    { key: 'pctSocial', label: '% social housing', fmt: pct1, fmtShort: pct0, fmtTick: pct0,
      note: () => 'Share of households renting from a council or housing association (ONS estimate for 2024). The same whatever home size is chosen.' },
    { key: 'pctTA', label: '% temporary accommodation', fmt: pct1, fmtShort: pct1, fmtTick: pct1,
      note: () => 'Households in temporary accommodation arranged by the council (31 March 2026), as a share of all the borough’s households (2024). Counted by the council that placed them, which may be in another borough.' },
  ];

  // Most measures are keyed by home size; a few (Census tenure) are one number per borough.
  const val = (b, metric, size) => {
    const x = b[metric];
    if (x == null) return null;
    if (typeof x === 'number') return x;
    return x[size] == null ? null : x[size];
  };

  // Two significant figures: breaks a reader can say out loud.
  function nice(v) {
    if (v <= 0) return 0;
    const p = Math.pow(10, Math.floor(Math.log10(v)) - 1);
    return Math.round(v / p) * p;
  }
  function quantile(sorted, q) {
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }
  // Six classes by rounded quantile. Returns the inner thresholds.
  function breaksFor(values) {
    const s = values.filter((v) => v != null).sort((a, b) => a - b);
    const out = [];
    for (let k = 1; k < RAMP.length; k++) {
      const t = nice(quantile(s, k / RAMP.length));
      if (!out.length || t > out[out.length - 1]) out.push(t);
    }
    return out;
  }
  function scale(D, metric, size) {
    const m = METRICS.find((x) => x.key === metric);
    const src = m.shared === 'rent' ? 'private' : metric; // rents share the private scale
    const vals = D.boroughs.map((b) => val(b, src, size));
    const br = breaksFor(vals);
    const n = br.length + 1;
    // with fewer breaks than steps, spread the classes across the whole ramp
    const idx = (c) => Math.round(c * (RAMP.length - 1) / (n - 1));
    return {
      breaks: br, metric: m, missing: vals.some((v) => v == null),
      cls(v) { if (v == null) return -1; let c = 0; while (c < br.length && v >= br[c]) c++; return idx(c); },
      colour(v) { const c = this.cls(v); return c < 0 ? null : RAMP[c]; },
    };
  }
  function legendHTML(sc) {
    const n = sc.breaks.length + 1;
    const cols = Array.from({ length: n }, (_, c) => RAMP[Math.round(c * (RAMP.length - 1) / (n - 1))]);
    return '<div><div class="ramp">' + cols.map((c) => '<i style="background:' + c + '"></i>').join('') +
      '</div><div class="ticks">' + sc.breaks.map((b) => '<span>' + sc.metric.fmtTick(b) + '</span>').join('') + '<span></span></div></div>' +
      (sc.missing ? '<span class="nodata"><i></i>No data (City of London)</span>' : '');
  }
  // text colour that reads on a given ramp step
  const inkOn = (hex) => (RAMP.indexOf(hex) >= 3 ? 'light' : 'dark');

  function pills(el, items, current, onPick) {
    el.innerHTML = '';
    el.classList.add('pills');
    el.setAttribute('role', 'group');
    items.forEach((it) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = it.label;
      b.setAttribute('aria-pressed', String(it.key === current));
      b.addEventListener('click', () => onPick(it.key));
      el.appendChild(b);
    });
  }
  const press = (el, items, key) => [...el.children].forEach((btn, j) => btn.setAttribute('aria-pressed', String(items[j].key === key)));

  // Census 2021 tenure
  // `on` bolds the social share while the map is showing it
  const bold = (on, t) => (on ? '<b>' + t + '</b>' : t);
  const tenureLine = (b, metric) => 'Households renting (2024): ' + bold(metric === 'pctSocial', b.pctSocial + '% socially') +
    ', ' + b.pctPrivate + '% privately' +
    (b.pctTA == null ? '' : ' · ' + bold(metric === 'pctTA', (+b.pctTA).toFixed(1) + '% in temporary accommodation'));
  // The City's no-data explanation: most readers don't know how few people live there
  const cityNote = (b) => 'Only ' + b.population.toLocaleString('en-GB') + ' people live in the City of London (Census 2021). ' +
    'ONS publishes no private rent for it, and most of the City Corporation’s ' + b.units.mix.toLocaleString('en-GB') +
    ' council homes are on estates in other boroughs.';
  // Rough context, not a precise figure: a plain fraction first, the percentage after.
  const FRACTIONS = [[1, 2], [3, 5], [2, 3], [7, 10], [3, 4], [4, 5]];
  const helpLine = (b, isLon) => {
    if (b.helpPct == null) return '';
    const f = FRACTIONS.reduce((a, c) => (Math.abs(100 * c[0] / c[1] - b.helpPct) < Math.abs(100 * a[0] / a[1] - b.helpPct) ? c : a));
    return 'About ' + f[0] + ' in ' + f[1] + ' social-renting households ' + (isLon ? 'in London' : 'here') + ' (' + b.helpPct +
      '%) get help with rent through Housing Benefit or Universal Credit, covering some or all of their rent.';
  };

  // Present value of GBP1 a year for `years` years: mid-year payments, real
  // discount rate r, real growth g (decimals). From the data pack's README.
  function npvFactor(years, r, g) {
    const q = (1 + (g || 0)) / (1 + r);
    const sum = Math.abs(q - 1) < 1e-9 ? years : (1 - Math.pow(q, years)) / (1 - q);
    return sum / Math.sqrt(1 + r);
  }

  const SVGNS = 'http://www.w3.org/2000/svg';
  const $ = (id) => document.getElementById('hc-' + id);

  async function init() {
    const host = document.querySelector('[data-hc-src]');
    if (!host) return;
    const D = await (await fetch(host.dataset.hcSrc)).json();
    const S = { metric: 'gap', size: 'mix', hot: null, calc: 'E12000007' };
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const byCode = Object.fromEntries([...D.boroughs, D.london].map((b) => [b.code, b]));
    const sizeOf = (k) => SIZES.find((s) => s.key === k);
    const draw = []; // redraw functions of the parts present, run on size change / resize
    let setCalc = () => {};
    let redrawDb = () => {};

    // ================= 1. map =================
    if ($('map')) {
      // crowded inner boroughs take the 4-letter code; a few labels are nudged off their neighbours
      const small = new Set(['E09000001', 'E09000020', 'E09000013', 'E09000019', 'E09000033', 'E09000007', 'E09000012', 'E09000030']);
      const NUDGE = { E09000032: [-38, 12], E09000022: [8, 40], E09000030: [-6, 0], E09000020: [4, 6], E09000013: [-17, -53] };
      const svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('viewBox', '0 0 ' + D.svg.w + ' ' + D.svg.h);
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', 'Map of London boroughs coloured by the selected measure');
      svg.innerHTML = '<defs><pattern id="hc-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
        '<rect width="6" height="6" fill="#fff"/><rect width="2" height="6" fill="#c9d0cc"/></pattern></defs>';
      const gShapes = document.createElementNS(SVGNS, 'g');
      const gLabels = document.createElementNS(SVGNS, 'g');
      const gInner = document.createElementNS(SVGNS, 'path');
      gInner.setAttribute('d', D.svg.inner);
      gInner.setAttribute('class', 'inner-line');
      const gOutline = document.createElementNS(SVGNS, 'path');
      gOutline.setAttribute('d', D.svg.outline);
      gOutline.setAttribute('class', 'outline');
      svg.append(gShapes, gOutline, gInner, gLabels);
      $('map').appendChild(svg);

      const shapes = {}, labels = {};
      D.boroughs.forEach((b) => {
        const p = document.createElementNS(SVGNS, 'path');
        p.setAttribute('d', D.svg.paths[b.code]);
        p.setAttribute('class', 'b-shape');
        p.setAttribute('tabindex', '0');
        p.dataset.code = b.code;
        gShapes.appendChild(p);
        shapes[b.code] = p;
        const nd = NUDGE[b.code] || [0, 0];
        const x = D.svg.labels[b.code][0] + nd[0], y = D.svg.labels[b.code][1] + nd[1];
        const t = document.createElementNS(SVGNS, 'text');
        t.setAttribute('class', 'b-label');
        const isSmall = small.has(b.code);
        t.innerHTML = '<tspan class="n" x="' + x + '" y="' + (y - (isSmall ? 3 : 4)) + '"' + (isSmall ? ' style="font-size:13px"' : '') + '>' +
          (isSmall ? b.abbr : b.short) + '</tspan><tspan class="v" x="' + x + '" y="' + (y + (isSmall ? 12 : 16)) + '"' +
          (isSmall ? ' style="font-size:15px"' : '') + '></tspan>';
        if (b.code === 'E09000001') t.style.display = 'none';
        gLabels.appendChild(t);
        labels[b.code] = t;
      });

      // The data box: London until something is hovered, tapped or focused.
      const dataBox = () => {
        const b = byCode[S.hot] || D.london, k = S.size, isLon = b === D.london;
        const el = $('dbox');
        const head = '<div class="hd"><h3>' + (isLon ? 'London' : b.name) + '</h3><span class="io">' +
          (isLon ? 'All 32 boroughs' : b.io + ' London') + ' · ' + sizeOf(k).label.toLowerCase() + '</span>' +
          '<span class="hint">' + (isLon ? 'Hover or tap a borough' : 'Move off the map for London') + '</span></div>';
        if (b.private[k] == null) {
          el.innerHTML = head + '<div class="nd">' + cityNote(b) + '</div><div class="ft">' + tenureLine(b, S.metric) + '</div>';
          return;
        }
        const p = b.private[k], so = b.social[k], g = b.gap[k], units = b.units[k] || 0, share = Math.round(100 * so / p);
        const cell = (key, label, v, sub) => '<div class="cell' + (S.metric === key ? ' on' : '') + '"><div class="k">' + label +
          '</div><b>' + v + '</b><span>' + sub + '</span></div>';
        el.innerHTML = head + '<div class="cells">' +
          cell('private', '<span class="dot swatch-private"></span>Private', gbp(p), 'a month') +
          cell('social', '<span class="dot swatch-social"></span>Social', gbp(so), 'a month') +
          cell('gap', 'Gap', gbp(g), gbp(g * 12) + ' a year') +
          cell('aggM', 'Total', gbpM(b.aggM[k]), 'a year, ' + units.toLocaleString('en-GB') + ' homes') +
          cell('npv', '25 years', gbpK(b.npv[k]), 'per home, today’s £') +
          '</div><div class="bar"><i style="width:' + share + '%"></i></div>' +
          '<div class="ft">Social rent is ' + share + '% of the private rent' +
          (isLon ? '' : ' · gap ' + (g >= D.london.gap[k] ? '+' : '−') + gbp(Math.abs(g - D.london.gap[k])) + ' v London') +
          ' · ' + tenureLine(b, S.metric) + '</div>' +
          '<div class="ft">' + helpLine(b, isLon) + '</div>' +
          ($('calc') ? '<button type="button" class="go" data-code="' + b.code + '">Work out what a tenancy ' + (isLon ? 'in London' : 'here') + ' is worth ↓</button>' : '');
      };
      $('dbox').addEventListener('click', (e) => {
        const go = e.target.closest('.go');
        if (!go) return;
        setCalc(go.dataset.code);
        $('calc').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
      });

      const hover = (code) => {
        if (code === S.hot) return;
        S.hot = code;
        Object.values(shapes).forEach((p) => p.classList.toggle('hot', p.dataset.code === code));
        if (shapes[code]) gShapes.appendChild(shapes[code]); // raise so the outline isn't under neighbours
        $('rank').querySelectorAll('.rk').forEach((r) => r.classList.toggle('hot', r.dataset.code === code));
        dataBox();
      };
      // pointerdown too: a tap on a phone doesn't always produce a pointermove
      ['pointermove', 'pointerdown'].forEach((t) => gShapes.addEventListener(t, (e) => { const c = e.target.dataset.code; if (c) hover(c); }));
      gShapes.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hover(null); });
      gShapes.addEventListener('focusin', (e) => hover(e.target.dataset.code));
      gShapes.addEventListener('focusout', (e) => { if (!e.relatedTarget || !e.relatedTarget.closest('.dbox')) hover(null); });
      gShapes.addEventListener('click', (e) => { if (e.target.dataset.code) setCalc(e.target.dataset.code); });

      const rank = $('rank');
      const ROW = 18;
      const rows = {};
      const ref = document.createElement('div');
      ref.className = 'ref';
      [...D.boroughs, D.london].forEach((b) => {
        const r = document.createElement('div');
        r.className = 'rk' + (b === D.london ? ' lon' : '');
        r.dataset.code = b.code;
        r.innerHTML = '<span class="nm">' + (b === D.london ? 'London average' : b.name) + '</span><span class="tr"><span class="br"></span></span><span class="vl"></span>';
        r.addEventListener('pointermove', () => hover(b.code));
        r.addEventListener('pointerdown', () => hover(b.code));
        r.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hover(null); });
        r.addEventListener('click', () => setCalc(b.code));
        rank.appendChild(r);
        rows[b.code] = r;
      });
      rank.appendChild(ref);
      rank.style.height = (ROW * (D.boroughs.length + 1)) + 'px';

      const stats = () => {
        const L = D.london, k = S.size, sz = sizeOf(k);
        const scope = k === 'mix' ? 'per social home, London average' : 'per ' + sz.label + ' social home, London average';
        $('stats').innerHTML =
          '<div class="stat key"><b>' + gbp(L.gap[k]) + '</b><span>a month gap ' + scope + '</span></div>' +
          '<div class="stat"><b>' + gbpK(L.npv[k]) + '</b><span>worth over a 25-year tenancy</span></div>' +
          '<div class="stat"><b>' + gbpM(L.aggM[k]) + '</b><span>a year across ' + L.units[k].toLocaleString('en-GB') + ' ' + (k === 'mix' ? '' : sz.label + ' ') + 'social homes</span></div>';
      };

      const drawMap = () => {
        const sc = scale(D, S.metric, S.size), m = sc.metric;
        $('note').textContent = m.note(S.size);
        $('legend').innerHTML = legendHTML(sc);
        stats();
        D.boroughs.forEach((b) => {
          const v = val(b, S.metric, S.size), c = sc.colour(v), p = shapes[b.code];
          p.classList.toggle('nodata', c == null);
          p.style.fill = c || '';
          p.setAttribute('aria-label', b.name + ': ' + (v == null ? 'no data' : m.fmt(v)));
          const t = labels[b.code];
          t.setAttribute('class', 'b-label ' + (c ? inkOn(c) : 'dark'));
          t.lastChild.textContent = v == null ? '' : m.fmtShort(v);
        });
        // ranking: London row sits where its value falls; shared rent scale keeps social bars short
        const src = m.shared === 'rent' ? 'private' : S.metric;
        const max = Math.max(...D.boroughs.map((b) => val(b, src, S.size) || 0));
        const all = [...D.boroughs, D.london].map((b) => ({ b, v: val(b, S.metric, S.size) }));
        all.sort((a, z) => (z.v == null ? -1 : z.v) - (a.v == null ? -1 : a.v));
        let i = 0;
        all.forEach(({ b, v }) => {
          const r = rows[b.code];
          const hide = b === D.london && S.metric === 'aggM'; // a London total isn't comparable with a borough's
          r.style.visibility = hide ? 'hidden' : '';
          r.classList.toggle('nod', v == null);
          r.querySelector('.br').style.width = (v == null || hide ? 0 : 100 * v / max) + '%';
          r.querySelector('.vl').textContent = v == null ? 'no data' : m.fmtShort(v);
          if (!hide) { r.style.transform = 'translateY(' + (i * ROW) + 'px)'; i++; }
        });
        const lonV = val(D.london, S.metric, S.size);
        $('rank-title').textContent = 'Ranked · ' + m.label.toLowerCase();
        ref.style.display = S.metric === 'aggM' ? 'none' : '';
        const tr = rows[D.boroughs[0].code].querySelector('.tr');
        requestAnimationFrame(() => {
          const rr = rank.getBoundingClientRect(), tb = tr.getBoundingClientRect();
          ref.style.left = (tb.left - rr.left + tb.width * lonV / max) + 'px';
        });
        dataBox();
      };
      pills($('metric'), METRICS, S.metric, (k) => { S.metric = k; press($('metric'), METRICS, k); drawMap(); });
      draw.push(drawMap);
    }

    // ================= 2. dumbbell =================
    if ($('db')) {
      const DB_ROW = 22, DB_TOP = 26, DB_RIGHT = 62;
      const dbData = [...D.boroughs.filter((b) => b.private.mix != null), D.london];
      const db = $('db');
      const dsvg = document.createElementNS(SVGNS, 'svg');
      db.appendChild(dsvg);
      const axis = document.createElementNS(SVGNS, 'g');
      axis.setAttribute('class', 'db-axis');
      dsvg.appendChild(axis);
      const drows = {};
      dbData.forEach((b) => {
        const g = document.createElementNS(SVGNS, 'g');
        g.setAttribute('class', 'db-row' + (b === D.london ? ' lon' : ''));
        g.dataset.code = b.code;
        g.innerHTML = '<rect class="hit" x="0" y="0" height="' + DB_ROW + '" rx="3"/>' +
          '<text class="nm" x="6" y="15"></text>' +
          '<rect class="conn" y="8" height="6" rx="3"/><circle class="soc" cy="11" r="5.5"/><circle class="pri" cy="11" r="5.5"/>' +
          '<text class="vs" y="15" text-anchor="end"></text><text class="vp" y="15"></text>' +
          '<text class="gl" y="15" text-anchor="end"></text>';
        g.addEventListener('click', () => setCalc(b.code));
        dsvg.appendChild(g);
        drows[b.code] = g;
      });

      const drawDumbbell = () => {
        const W = db.clientWidth, H = DB_TOP + DB_ROW * dbData.length + 8, k = S.size;
        if (!W) return;
        dsvg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
        dsvg.setAttribute('height', H);
        const maxP = Math.max(...dbData.map((b) => b.private[k]));
        const step = maxP > 3000 ? 1000 : 500;
        const xmax = Math.ceil(maxP / step) * step;
        const narrow = W < 520;
        const left = narrow ? 112 : 170;
        const x = (v) => left + (W - left - DB_RIGHT - (narrow ? 0 : 50)) * v / xmax;
        let a = '';
        for (let t = 0; t <= xmax; t += step) {
          a += '<line x1="' + x(t) + '" x2="' + x(t) + '" y1="' + (DB_TOP - 6) + '" y2="' + (H - 6) + '"/>' +
            '<text x="' + x(t) + '" y="' + (DB_TOP - 11) + '" text-anchor="middle">' + (t === 0 ? '£0' : '£' + (t / 1000) + 'k') + '</text>';
        }
        axis.innerHTML = a;
        dbData.slice().sort((p, q) => q.gap[k] - p.gap[k]).forEach((b, i) => {
          const g = drows[b.code];
          g.style.transform = 'translateY(' + (DB_TOP + i * DB_ROW) + 'px)';
          g.querySelector('.hit').setAttribute('width', W);
          g.querySelector('.nm').textContent = b === D.london ? 'London' : (narrow ? b.short : b.name);
          const xs = x(b.social[k]), xp = x(b.private[k]);
          const c = g.querySelector('.conn');
          c.setAttribute('x', xs); c.setAttribute('width', Math.max(0, xp - xs));
          g.querySelector('.soc').setAttribute('cx', xs);
          g.querySelector('.pri').setAttribute('cx', xp);
          const vs = g.querySelector('.vs'), vp = g.querySelector('.vp');
          vs.setAttribute('x', xs - 9); vs.textContent = gbp(b.social[k]);
          vp.setAttribute('x', xp + 9); vp.textContent = gbp(b.private[k]);
          // on a phone the private label would collide with the gap column: hide it there
          vp.style.display = narrow ? 'none' : '';
          vs.style.display = narrow && xs - 9 < left + 30 ? 'none' : '';
          const gl = g.querySelector('.gl');
          gl.setAttribute('x', W - 4);
          gl.textContent = gbp(b.gap[k]);
          g.classList.toggle('sel', b.code === S.calc && b !== D.london);
        });
        const r = byCode[S.calc];
        $('db-read').hidden = !narrow;
        $('db-read').innerHTML = '<b>' + (r === D.london ? 'London' : r.name) + ':</b> social ' + gbp(r.social[k]) +
          ', private ' + gbp(r.private[k]) + ', gap <b>' + gbp(r.gap[k]) + '</b> a month';
      };
      draw.push(drawDumbbell);
      redrawDb = drawDumbbell;
    }

    // ================= 3. calculator =================
    let calc = () => {};
    if ($('calc')) {
      const sel = $('c-b');
      sel.innerHTML = '<option value="E12000007">London (all boroughs)</option>' +
        D.boroughs.filter((b) => b.private.mix != null).slice().sort((p, q) => p.name.localeCompare(q.name))
          .map((b) => '<option value="' + b.code + '">' + b.name + '</option>').join('');
      calc = () => {
        const b = byCode[S.calc], k = S.size, isLon = b === D.london, sz = sizeOf(k);
        const years = +$('c-y').value, r = +$('c-r').value / 100, gr = +$('c-g').value / 100;
        $('c-y-v').textContent = years + ' years';
        $('c-r-v').textContent = (r * 100).toFixed(1) + '% a year';
        $('c-g-v').textContent = (gr > 0 ? '+' : '') + (gr * 100).toFixed(1) + '% a year';
        const f = npvFactor(years, r, gr);
        const gapPa = b.gap[k] * 12, npv = gapPa * f, units = b.units[k] || 0;
        $('c-out').textContent = gbpK(npv);
        $('c-out-l').textContent = 'for one ' + (k === 'mix' ? 'typical' : sz.label) + ' social home in ' + (isLon ? 'London' : b.name) + ', over ' + years + ' years';
        $('c-steps').innerHTML =
          '<tr><td>Typical private rent<span class="s">ONS, August 2026</span></td><td>' + gbp(b.private[k]) + ' a month</td></tr>' +
          '<tr><td>Social rent<span class="s">2026/27</span></td><td>− ' + gbp(b.social[k]) + ' a month</td></tr>' +
          '<tr><td>Gap</td><td>' + gbp(b.gap[k]) + ' a month<br>' + gbp(gapPa) + ' a year</td></tr>' +
          '<tr><td>× value today of £1 a year for ' + years + ' years<span class="s">at ' + (r * 100).toFixed(1) + '%' +
            (gr ? ', gap growing ' + (gr * 100).toFixed(1) + '% a year' : ', gap constant in real terms') + '</span></td><td>× ' + f.toFixed(2) + '</td></tr>' +
          '<tr class="tot"><td>Value of one tenancy</td><td>' + gbpK(npv) + '</td></tr>' +
          '<tr><td>Across all ' + units.toLocaleString('en-GB') + ' ' + (k === 'mix' ? '' : sz.label + ' ') + 'social homes' + (isLon ? ' in London' : ' in the borough') +
            '<span class="s">notional: nobody could collect it</span></td><td>' + gbpM(npv * units / 1e6) + '</td></tr>';
      };
      sel.addEventListener('change', () => setCalc(sel.value));
      ['c-y', 'c-r', 'c-g'].forEach((id) => $(id).addEventListener('input', calc));
      $('calc').querySelectorAll('.presets button').forEach((b) => b.addEventListener('click', () => {
        if (b.dataset.y) $('c-y').value = b.dataset.y;
        if (b.dataset.r) $('c-r').value = b.dataset.r;
        calc();
      }));
      draw.push(calc);
    }

    // ================= 4. who lives in each tenure (PROTOTYPE) =================
    // Census 2021 composition by tenure, from who.json (fetch_who.py). Each bar is
    // 100% of one tenure's people or households; hovering a segment states the
    // numerator and denominator in words, because "a % of what?" is the whole risk.
    let setWhoArea = () => {};
    if ($('who')) {
      const W = await (await fetch($('who').dataset.hcWho)).json();
      const CAT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7']; // validated, light surface
      const DIV = { space: ['#E0A24E', '#c9d0cc', '#80B4DD', '#1877B8'] };
      const seqCols = (n, rev) => {
        const c = Array.from({ length: n }, (_, i) => RAMP[Math.round(i * (RAMP.length - 1) / (n - 1))]);
        return rev ? c.reverse() : c;
      };
      const colours = (t) => (t.scale === 'cat' ? CAT.slice(0, t.groups.length)
        : t.scale === 'div' ? DIV[t.id] : seqCols(t.groups.length, t.id === 'disability'));
      const lightText = (hex) => { const n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) < 150; };

      // how a reader should hear each group, in the plural; the households basis turns "were" into "was"
      const SAY = {
        hhtype: ['were people aged 66 or over living alone', 'were people under 66 living alone', 'were couples without children',
          'were couples with dependent children', 'were lone parents with dependent children', 'were families whose children are all grown up',
          'were other households, including sharers'],
        space: ['were overcrowded (fewer bedrooms than they need)', 'had just enough bedrooms', 'had one spare bedroom', 'had two or more spare bedrooms'],
        work: ['were in work', 'were unemployed', 'were retired', 'were students', 'were looking after home or family', 'were long-term sick or disabled', 'were otherwise not working'],
        disability: ['were disabled, with day-to-day activities limited a lot', 'were disabled, with day-to-day activities limited a little', 'were not disabled'],
        age: ['were under 16', 'were aged 16 to 24', 'were aged 25 to 44', 'were aged 45 to 64', 'were aged 65 to 74', 'were aged 75 or over'],
        birth: ['were born in the United Kingdom', 'were born in Ireland', 'were born elsewhere in Europe', 'were born in Africa',
          'were born in the Middle East or Asia', 'were born in the Americas or the Caribbean', 'were born in Oceania or elsewhere'],
        arrival: ['were born in the UK', 'had lived in the UK for 10 years or more', 'had lived in the UK for 5 to 10 years',
          'had lived in the UK for 2 to 5 years', 'had lived in the UK for under 2 years'],
        ethnicity: ['described themselves as White British', 'described themselves as from another White group', 'described themselves as Asian',
          'described themselves as Black', 'described themselves as Mixed', 'described themselves as from another ethnic group'],
        passport: ['held a UK passport', 'held a passport from another country only', 'held no passport'],
      };
      const HEAD = {
        hhtype: 'Lone parents with dependent children', space: 'Overcrowded', work: 'In work', disability: 'Disabled',
        age: 'Aged 65 or over', birth: 'Born outside the UK', arrival: 'In the UK for under 5 years', passport: 'Holding a UK passport',
      };
      const HEADSAY = { birth: 'were born outside the UK', arrival: 'had been in the UK for under 5 years',
        disability: 'were disabled', age: 'were aged 65 or over' };
      const TEN_PEOPLE = { 2: 'living in social homes', 0: 'living in homes owned outright', 1: 'living in homes with a mortgage or shared ownership',
        3: 'living in privately rented homes', all: 'living in all homes' };
      const TEN_HH = { 2: 'renting socially', 0: 'owning outright', 1: 'with a mortgage or shared ownership', 3: 'renting privately', all: '' };
      const ROWS = [...W.tenures.map((t) => t.id), 'all'];
      const LABEL = Object.fromEntries([...W.tenures.map((t) => [t.id, t.label]), ['all', 'All households']]);
      const areaName = (c) => (c === 'E12000007' ? 'London' : byCode[c].name);

      const T = { topic: 'birth', unit: 'households', area: 'E12000007', hl: null };
      const topicOf = () => W.topics.find((t) => t.id === T.topic);
      const unitFor = (t) => (t.units.includes(T.unit) ? T.unit : t.units[0]);

      const counts = (t, unit, row) => {
        const d = W.areas[T.area][unit][t.id];
        if (row !== 'all') return d[row];
        return t.groups.map((_, i) => Object.values(d).reduce((s, c) => s + c[i], 0));
      };
      const pct = (n, N) => (N ? 100 * n / N : 0);
      const fmtP = (p) => (p < 10 ? p.toFixed(1) : Math.round(p)) + '%';
      const nounFor = (t, unit) => (unit === 'people' ? (t.id === 'work' ? 'adults' : 'people') : 'households');

      // "Of the 790,959 households renting socially in London, 376,754 (47.6%) had a household reference person who was born outside..."
      const sentence = (t, unit, row, gis) => {
        const c = counts(t, unit, row), N = c.reduce((a, b) => a + b, 0), n = gis.reduce((s, i) => s + c[i], 0);
        const where = ' in ' + areaName(T.area);
        let say = gis.length === 1 ? SAY[t.id][gis[0]] : null;
        if (!say) say = HEADSAY[t.id];
        const nn = n.toLocaleString('en-GB'), NN = N.toLocaleString('en-GB'), p = pct(n, N).toFixed(1) + '%';
        if (unit === 'people') {
          return 'Of the ' + NN + ' ' + nounFor(t, unit) + (t.id === 'work' ? ' (aged 16+) ' : ' ') + TEN_PEOPLE[row] + where + ', <b>' + nn + ' (' + p + ') ' + say + '</b>.';
        }
        if (t.units.includes('people')) { // a person topic, counted by the household reference person
          return 'Of the ' + NN + ' households ' + (TEN_HH[row] ? TEN_HH[row] + ' ' : '') + where.trim() + ', <b>' + nn + ' (' + p +
            ') had a household reference person who ' + say.replace(/^were /, 'was ').replace(/^described themselves/, 'described themselves') + '</b>.';
        }
        return 'Of the ' + NN + ' households ' + (TEN_HH[row] ? TEN_HH[row] + ' ' : '') + where.trim() + ', <b>' + nn + ' (' + p + ') ' + say + '</b>.';
      };

      const sel = $('who-area');
      sel.innerHTML = '<option value="E12000007">London</option>' +
        D.boroughs.slice().sort((p, q) => p.name.localeCompare(q.name)).map((b) => '<option value="' + b.code + '">' + b.name + '</option>').join('');
      const UNITS = [{ key: 'people', label: 'People' }, { key: 'households', label: 'Households' }];

      const drawWho = () => {
        const t = topicOf(), unit = unitFor(t), cols = colours(t), noun = nounFor(t, unit);
        sel.value = T.area;
        press($('who-topic'), W.topics.map((x) => ({ key: x.id })), T.topic);
        press($('who-unit'), UNITS, unit);
        $('who-unit').children[0].disabled = !t.units.includes('people');
        $('who-unit').children[0].title = t.units.includes('people') ? '' : 'This topic describes the household itself, so it is counted by household only';
        $('who-note').innerHTML = unit === 'people'
          ? 'Each bar is 100% of the ' + noun + (t.id === 'work' ? ' aged 16 and over' : ', children included,') + ' living in that kind of home.'
          : (t.units.includes('people')
            ? 'Each bar is 100% of the households in that kind of home, each counted once by its <i>household reference person</i> &mdash; usually the oldest adult in work. This is the basis of most published figures.'
            : 'Each bar is 100% of the households in that kind of home.') +
            (T.area === 'E09000001' ? ' <b>Small numbers:</b> the City has about 730 social-renting households, so its shares are rough.' : '');
        // headline: social v all
        if (HEAD[t.id]) {
          const gis = t.head;
          const share = (row) => { const c = counts(t, unit, row); return pct(gis.reduce((s, i) => s + c[i], 0), c.reduce((a, b) => a + b, 0)); };
          $('who-head').innerHTML = '<b>' + HEAD[t.id] + ':</b> ' + share('2').toFixed(1) + '% of ' + noun + ' in social homes, against ' +
            share('all').toFixed(1) + '% of all ' + noun + ' in ' + areaName(T.area) + '.';
        } else $('who-head').textContent = '';
        $('who-legend').innerHTML = t.groups.map((g, i) => '<span data-g="' + i + '"><i style="background:' + cols[i] + '"></i>' + g + '</span>').join('');
        $('who-chart').innerHTML = ROWS.map((row) => {
          const c = counts(t, unit, row), N = c.reduce((a, b) => a + b, 0);
          return '<div class="who-row' + (row === '2' ? ' soc' : '') + (row === 'all' ? ' all' : '') + '" data-row="' + row + '">' +
            '<div class="who-rl"><b>' + LABEL[row] + '</b><span>' + N.toLocaleString('en-GB') + ' ' + noun + '</span></div>' +
            '<div class="who-bar">' + c.map((n, i) => {
              const p = pct(n, N);
              if (p <= 0) return '';
              return '<span class="who-seg" data-g="' + i + '" data-row="' + row + '" style="flex:' + p + ' 1 0;background:' + cols[i] +
                ';color:' + (lightText(cols[i]) ? '#fff' : '#1a2332') + '">' + (p >= 6 ? '<em>' + fmtP(p) + '</em>' : '') + '</span>';
            }).join('') + '</div></div>';
        }).join('');
        // table view: groups down, tenures across; each column sums to 100%
        $('who-tbl').innerHTML = '<table><thead><tr><th>' + t.label + '</th>' + ROWS.map((r) => '<th>' + LABEL[r] + '</th>').join('') + '</tr></thead><tbody>' +
          t.groups.map((g, i) => '<tr><td>' + g + '</td>' + ROWS.map((r) => { const c = counts(t, unit, r); return '<td>' + fmtP(pct(c[i], c.reduce((a, b) => a + b, 0))) + '</td>'; }).join('') + '</tr>').join('') +
          '<tr class="tot"><td>Total (' + noun + ')</td>' + ROWS.map((r) => '<td>' + counts(t, unit, r).reduce((a, b) => a + b, 0).toLocaleString('en-GB') + '</td>').join('') + '</tr></tbody></table>';
        read();
        // a label only stays inside its segment if it fits with room to spare
        requestAnimationFrame(() => $('who-chart').querySelectorAll('.who-seg em').forEach((em) => {
          em.style.visibility = em.offsetWidth > em.parentNode.clientWidth - 6 ? 'hidden' : '';
        }));
      };
      // the readout: London social row by default, or whatever segment is hovered or tapped
      const read = () => {
        const t = topicOf(), unit = unitFor(t);
        const h = T.hl || { row: '2', g: t.head.length ? t.head : [0] };
        $('who-read').innerHTML = sentence(t, unit, h.row, Array.isArray(h.g) ? h.g : [h.g]);
        $('who-chart').querySelectorAll('.who-seg').forEach((s) => s.classList.toggle('dim', T.hl != null && +s.dataset.g !== T.hl.g));
        $('who-legend').querySelectorAll('span').forEach((s) => s.classList.toggle('dim', T.hl != null && +s.dataset.g !== T.hl.g));
      };
      const pick = (e) => {
        const s = e.target.closest('.who-seg');
        if (!s) return;
        T.hl = { row: s.dataset.row, g: +s.dataset.g };
        read();
      };
      $('who-chart').addEventListener('pointermove', pick);
      $('who-chart').addEventListener('pointerdown', pick);
      $('who-chart').addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { T.hl = null; read(); } });
      $('who-legend').addEventListener('pointerover', (e) => {
        const s = e.target.closest('[data-g]'); if (!s) return; T.hl = { row: '2', g: +s.dataset.g }; read();
      });
      $('who-legend').addEventListener('pointerleave', () => { T.hl = null; read(); });
      pills($('who-topic'), W.topics.map((x) => ({ key: x.id, label: x.label })), T.topic, (k) => { T.topic = k; T.hl = null; drawWho(); });
      pills($('who-unit'), UNITS, T.unit, (k) => { T.unit = k; T.hl = null; drawWho(); });
      sel.addEventListener('change', () => { T.area = sel.value; T.hl = null; drawWho(); if (sel.value !== 'E09000001') setCalc(sel.value); });
      $('who-tbl-btn').addEventListener('click', () => {
        const open = $('who-tbl').hidden;
        $('who-tbl').hidden = !open;
        $('who-tbl-btn').setAttribute('aria-expanded', String(open));
        $('who-tbl-btn').textContent = open ? 'Hide the table' : 'Show as a table';
      });
      setWhoArea = (code) => { if (W.areas[code]) { T.area = code; T.hl = null; drawWho(); } };
      drawWho();
      draw.push(drawWho); // so a resize re-checks which labels fit
      window.__who = { state: () => T, draw: drawWho, set: (o) => { Object.assign(T, o); drawWho(); } };
    }

    // a click on a borough anywhere loads it into the calculator (and highlights it on the dumbbell)
    setCalc = (code) => {
      if (!byCode[code] || byCode[code].private.mix == null) return; // the City has no private rent
      S.calc = code;
      if ($('c-b')) $('c-b').value = code;
      calc();
      redrawDb();
      setWhoArea(code);
    };

    // ================= one home size for the whole page =================
    const sizeEls = [...document.querySelectorAll('.hc [data-hc-size]')];
    const setSize = (k) => {
      S.size = k;
      sizeEls.forEach((el) => press(el, SIZES, k)); // every size control shows the same choice
      draw.forEach((fn) => fn());
    };
    sizeEls.forEach((el) => pills(el, SIZES, S.size, setSize));
    setSize(S.size);
    let rz;
    addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => draw.forEach((fn) => fn()), 100); });

    window.__hc = { state: () => S, setCalc, setSize };
    window.__NG_DONE__ = true;
  }

  const go = () => init().catch((e) => { window.__NG_ERROR__ = String(e); console.error(e); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
})();
