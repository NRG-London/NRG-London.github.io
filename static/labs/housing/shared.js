/* Housing-costs lab — shared model, formatting, colour scale, controls and
   tooltip. Every prototype reads the same data/housing.json through this, so
   the numbers can't drift between them. */
(function () {
  'use strict';

  // House sequential ramp (the census explorer's), light -> dark.
  const RAMP = ['#E2EEF7', '#B4D4EB', '#80B4DD', '#4A92CC', '#1877B8', '#004D80'];

  const SIZES = [
    { key: 'mix', label: 'All homes', long: 'averaged over each borough’s own mix of social homes' },
    { key: '1', label: '1 bed', long: '1-bed homes (incl. studios)' },
    { key: '2', label: '2 bed', long: '2-bed homes' },
    { key: '3', label: '3 bed', long: '3-bed homes' },
    { key: '4', label: '4+ bed', long: '4-bed and larger homes' },
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

  function val(b, metric, size) {
    const v = b[metric][size];
    return v == null ? null : v;
  }

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
  // Six classes by rounded quantile. Returns the five inner thresholds.
  function breaksFor(values) {
    const s = values.filter((v) => v != null).sort((a, b) => a - b);
    const out = [];
    for (let k = 1; k < RAMP.length; k++) {
      const t = nice(quantile(s, k / RAMP.length));
      if (!out.length || t > out[out.length - 1]) out.push(t);
    }
    return out;
  }

  function scale(data, metric, size) {
    const m = METRICS.find((x) => x.key === metric);
    const src = m.shared === 'rent' ? 'private' : metric; // rents share the private scale
    const br = breaksFor(data.boroughs.map((b) => val(b, src, size)));
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
    const f = sc.metric.fmtTick;
    return '<div><div class="ramp">' + cols.map((c) => '<i style="background:' + c + '"></i>').join('') +
      '</div><div class="ticks">' + sc.breaks.map((b) => '<span>' + f(b) + '</span>').join('') + '<span></span></div></div>' +
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
      b.addEventListener('click', () => {
        el.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
        b.setAttribute('aria-pressed', 'true');
        onPick(it.key);
      });
      el.appendChild(b);
    });
    // test/automation hook: select by key as if clicked
    el.select = (key) => { const i = items.findIndex((it) => it.key === key); if (i >= 0) el.children[i].click(); };
  }

  function tipHTML(b, size, data) {
    const sz = SIZES.find((s) => s.key === size);
    if (b.private[size] == null) {
      return '<h3>' + b.name + '</h3><div class="io">' + b.io + ' London</div>' +
        '<div class="note">No figure: ONS publishes no private rent for the City, and most of the City Corporation’s ' +
        b.units.mix.toLocaleString('en-GB') + ' council homes are on estates in other boroughs.</div>';
    }
    const p = b.private[size], s = b.social[size], g = b.gap[size];
    const share = Math.round(100 * s / p);
    const lon = data && data.london.gap[size];
    const vsLon = lon ? (g >= lon ? '+' : '−') + gbp(Math.abs(g - lon)) + ' v London' : '';
    return '<h3>' + b.name + '</h3><div class="io">' + b.io + ' London · ' + sz.label.toLowerCase() + '</div>' +
      '<table>' +
      '<tr><td><span class="dot swatch-private"></span>Private rent</td><td>' + gbp(p) + ' /mo</td></tr>' +
      '<tr><td><span class="dot swatch-social"></span>Social rent</td><td>' + gbp(s) + ' /mo</td></tr>' +
      '<tr class="gap"><td>Gap</td><td>' + gbp(g) + ' /mo</td></tr>' +
      '<tr><td>a year</td><td>' + gbp(g * 12) + '</td></tr>' +
      '<tr><td>over 25 years</td><td>' + gbpK(b.npv[size]) + '</td></tr>' +
      '</table>' +
      '<div class="bar"><i style="width:' + share + '%"></i></div>' +
      '<div class="bar-l">Social rent is ' + share + '% of the private rent' + (vsLon ? ' · gap ' + vsLon : '') + '</div>' +
      '<div class="note">' + (b.units[size] || 0).toLocaleString('en-GB') + ' social homes' +
      (size === 'mix' ? '' : ' of this size') + ' · ' + b.pctSocial + '% of households rent socially</div>';
  }

  function tooltip() {
    const el = document.createElement('div');
    el.className = 'tip';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
    return {
      show(html, x, y) {
        el.innerHTML = html;
        el.classList.add('on');
        const r = el.getBoundingClientRect(), pad = 14;
        let left = x + pad, top = y + pad;
        if (left + r.width > innerWidth - 8) left = x - r.width - pad;
        if (top + r.height > innerHeight - 8) top = Math.max(8, y - r.height - pad);
        el.style.left = Math.max(8, left) + 'px';
        el.style.top = top + 'px';
      },
      hide() { el.classList.remove('on'); },
    };
  }

  // Present value of GBP1 a year for `years` years: mid-year payments, real
  // discount rate r, real growth g (decimals). From the data pack's README.
  function npvFactor(years, r, g = 0) {
    const q = (1 + g) / (1 + r);
    const sum = Math.abs(q - 1) < 1e-9 ? years : (1 - Math.pow(q, years)) / (1 - q);
    return sum / Math.sqrt(1 + r);
  }

  async function load() {
    const r = await fetch('../data/housing.json');
    return r.json();
  }

  window.HC = { RAMP, SIZES, METRICS, val, scale, legendHTML, inkOn, pills, tipHTML, tooltip,
    npvFactor, load, fmt: { gbp, gbpK, gbpM, gbpShortK } };
})();
