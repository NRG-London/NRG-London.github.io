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
  ];

  const val = (b, metric, size) => { const v = b[metric][size]; return v == null ? null : v; };

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
    const br = breaksFor(D.boroughs.map((b) => val(b, src, size)));
    const n = br.length + 1;
    // with fewer breaks than steps, spread the classes across the whole ramp
    const idx = (c) => Math.round(c * (RAMP.length - 1) / (n - 1));
    return {
      breaks: br, metric: m,
      cls(v) { if (v == null) return -1; let c = 0; while (c < br.length && v >= br[c]) c++; return idx(c); },
      colour(v) { const c = this.cls(v); return c < 0 ? null : RAMP[c]; },
    };
  }
  function legendHTML(sc) {
    const n = sc.breaks.length + 1;
    const cols = Array.from({ length: n }, (_, c) => RAMP[Math.round(c * (RAMP.length - 1) / (n - 1))]);
    return '<div><div class="ramp">' + cols.map((c) => '<i style="background:' + c + '"></i>').join('') +
      '</div><div class="ticks">' + sc.breaks.map((b) => '<span>' + sc.metric.fmtTick(b) + '</span>').join('') + '<span></span></div></div>' +
      '<span class="nodata"><i></i>No data (City of London)</span>';
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
  const tenureLine = (b) => 'Households renting: ' + b.pctSocial + '% socially, ' + b.pctPrivate + '% privately';
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
          el.innerHTML = head + '<div class="nd">' + cityNote(b) + '</div>';
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
          ' · ' + tenureLine(b) + '</div>' +
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
        const lonV = D.london[S.metric][S.size];
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

    // a click on a borough anywhere loads it into the calculator (and highlights it on the dumbbell)
    setCalc = (code) => {
      if (!byCode[code] || byCode[code].private.mix == null) return; // the City has no private rent
      S.calc = code;
      if ($('c-b')) $('c-b').value = code;
      calc();
      redrawDb();
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
