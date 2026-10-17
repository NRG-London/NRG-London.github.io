/*
 * /labs/licensing/ — London's cumulative impact zones.
 *
 * The panel (stats, filters, the notice card, the authority list, permalinks)
 * is the Cowork page's code, nearly unchanged (E:\London Licensing\ciz\scripts\
 * page_template.html). The map is MapLibre on its own — no deck.gl — so it owns
 * its camera and input. Two base maps:
 *   Streets   CARTO Positron vector tiles (keyed); the zones sit under its labels
 *   Boroughs  our own borough outlines and Thames on a blank style: no external calls
 * No floating tooltips: hovering a zone names it in the fixed strip top left.
 *
 * Data (static/labs/licensing/data/, written by site/export_lab.py in
 * E:\London Licensing): zones.json (largest first, so small zones draw on top),
 * boroughs.json, thames.json; the authorities come inline from Hugo data.
 */
(function () {
  'use strict';

  const CARTO_KEY = 'cb1_2jwn_1_b719f4820b3d9fc06421d20e';
  const POSITRON = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json?key=' + CARTO_KEY;
  const BLANK = { version: 8, sources: {}, layers: [{ id: 'land', type: 'background', paint: { 'background-color': '#e9eeeb' } }] };
  const C = { all: '#b3123a', off: '#0b7a83', lnr: '#c27a00', former: '#3b3b3b',
              borough: '#ffffff', edge: '#b3bdb8', water: '#c9dcef' };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ROOT = document.body.dataset.dataRoot;
  const V = document.body.dataset.dataV;
  const AUTH = JSON.parse($('auth').textContent);

  const SCOPES = [
    { key: 'all', label: 'Pubs, bars, clubs and shops', hint: 'on-trade and off-licences (some exclude restaurants)' },
    { key: 'off', label: 'Off-licences only', hint: 'shops and supermarkets selling alcohol to take away' },
    { key: 'lnr', label: 'Late-night takeaways only', hint: 'hot food after 11pm' },
  ];
  const KINDS = [
    { key: 'cia', label: 'Cumulative impact zone (statutory)' },
    { key: 'softer', label: 'Other licensing policy area' },
    { key: 'proposed', label: 'Proposed' },
    { key: 'former', label: 'Westminster\u2019s West End zone before 1 October 2026' },
  ];
  const PREC = { 'exact': 'exact', 'georeferenced': 'matched to council map', 'street-traced': 'traced from description', 'approximate': 'approximate' };
  const SCOPE_LABEL = { all: 'Pubs, bars, clubs and shops', off: 'Off-licences only', lnr: 'Late-night takeaways only' };
  const KIND_LABEL = { cia: 'Cumulative impact zone', softer: 'Other licensing policy area', proposed: 'Proposed zone', former: 'Former boundary' };
  const on = { scope: { all: true, off: true, lnr: true }, kind: { cia: true, softer: true, proposed: true, former: false } };
  // Inner boroughs are small on the overview, so their names wait until zoomed in a little.
  const INNER = new Set(['City of London', 'Westminster', 'Camden', 'Islington', 'Hackney', 'Tower Hamlets', 'Kensington and Chelsea', 'Hammersmith and Fulham', 'Lambeth', 'Southwark']);
  const LABEL_AT = { 'City of London': [-0.0922, 51.5155], 'Westminster': [-0.1600, 51.5115], 'Tower Hamlets': [-0.0360, 51.5150], 'Kensington and Chelsea': [-0.1940, 51.4990], 'Hammersmith and Fulham': [-0.2230, 51.4920], 'Islington': [-0.1100, 51.5470], 'Hackney': [-0.0550, 51.5480], 'Camden': [-0.1650, 51.5470], 'Lambeth': [-0.1180, 51.4600], 'Southwark': [-0.0780, 51.4730] };

  let ZONES, BOROUGHS, THAMES, map, mode = 'street', selected = null, hovered = null;
  let byId = {}, feats = [];

  const getJSON = (name) => fetch(ROOT + name + '?v=' + V).then((r) => {
    if (!r.ok) throw new Error(name + ': HTTP ' + r.status);
    return r.json();
  });

  function fail(msg) {
    const d = document.createElement('div');
    d.className = 'readout';
    d.style.maxWidth = 'calc(100% - 24px)';
    d.textContent = msg;
    document.querySelector('.mapwrap').appendChild(d);
  }

  /* ---------- map ---------- */
  function keyRequest(url) {
    // CARTO's style.json pulls tiles, glyphs and sprites from URLs that do not
    // carry the key; add it, so key enforcement does not blank the map.
    if (url.indexOf('cartocdn.com') === -1 || url.indexOf('key=') !== -1) return { url: url };
    return { url: url + (url.indexOf('?') === -1 ? '?' : '&') + 'key=' + CARTO_KEY };
  }

  function unionBox(boxes) {
    return boxes.reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
  }
  const toBounds = (b) => [[b[0], b[1]], [b[2], b[3]]];
  function fit(box, maxZoom, padding) {
    map.fitBounds(toBounds(box), { padding: padding ?? 40, maxZoom: maxZoom, duration: reduced() ? 0 : 800 });
  }

  // The selected zone gets its own pair of layers on top, so it is never hidden
  // under a neighbour; hover thickens the outline through feature-state.
  const isSel = ['boolean', ['feature-state', 'hover'], false];
  const colour = ['case', ['==', ['get', 'kind'], 'former'], C.former,
    ['match', ['get', 'scope'], 'off', C.off, 'lnr', C.lnr, C.all]];
  const LINES = [
    // id, which zones, base width, dash pattern (in line widths)
    ['zone-line', ['all', ['==', ['get', 'kind'], 'cia'], ['!=', ['get', 'method'], 'borough']], 1.6, null],
    ['zone-line-borough', ['==', ['get', 'method'], 'borough'], 2.5, [4.8, 1.2, 0.8, 1.2]],
    ['zone-line-softer', ['==', ['get', 'kind'], 'softer'], 1.6, [3, 2.5]],
    ['zone-line-proposed', ['==', ['get', 'kind'], 'proposed'], 2.2, [0.7, 1.8]],
    ['zone-line-former', ['==', ['get', 'kind'], 'former'], 2.2, [3.6, 2.3]],
  ];
  const fillOpacity = (sel) => ['case',
    ['==', ['get', 'method'], 'borough'], sel ? 0.14 : 0.06,
    ['==', ['get', 'kind'], 'cia'], sel ? 0.55 : 0.38,
    ['==', ['get', 'kind'], 'softer'], sel ? 0.3 : 0.12,
    ['==', ['get', 'kind'], 'proposed'], sel ? 0.2 : 0.04,
    0];

  function visibleFilter() {
    return ['all',
      ['in', ['get', 'scope'], ['literal', Object.keys(on.scope).filter((k) => on.scope[k])]],
      ['in', ['get', 'kind'], ['literal', Object.keys(on.kind).filter((k) => on.kind[k])]]];
  }

  function addOverlay() {
    if (map.getSource('zones')) return;
    // Zones go above every road and building but under the labels that follow
    // them. Not simply "before the first symbol layer": Positron has a waterway
    // label early on, which would put the zones under the streets.
    let firstLabel;
    if (mode === 'street') {
      const layers = map.getStyle().layers;
      let last = -1;
      layers.forEach((l, i) => { if (l.type !== 'symbol') last = i; });
      firstLabel = layers[last + 1] && layers[last + 1].id;
    }
    map.addSource('boroughs', { type: 'geojson', data: BOROUGHS });
    map.addSource('zones', { type: 'geojson', data: ZONES, promoteId: 'id' });
    if (mode === 'boroughs') {
      map.addSource('thames', { type: 'geojson', data: THAMES });
      map.addLayer({ id: 'borough-fill', type: 'fill', source: 'boroughs', paint: { 'fill-color': C.borough } });
      map.addLayer({ id: 'thames', type: 'fill', source: 'thames', paint: { 'fill-color': C.water } });
    }
    map.addLayer({ id: 'borough-line', type: 'line', source: 'boroughs',
      paint: { 'line-color': mode === 'street' ? '#8a9490' : C.edge, 'line-width': mode === 'street' ? 0.9 : 1, 'line-opacity': mode === 'street' ? 0.7 : 1 } }, firstLabel);
    map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zones',
      paint: { 'fill-color': colour, 'fill-opacity': fillOpacity(false) } }, firstLabel);
    LINES.forEach(([id, which, w, dash]) => {
      const paint = { 'line-color': colour, 'line-width': ['case', isSel, 3, w] };
      if (dash) paint['line-dasharray'] = dash;
      map.addLayer({ id: id, type: 'line', source: 'zones', filter: which, paint: paint }, firstLabel);
    });
    map.addLayer({ id: 'sel-fill', type: 'fill', source: 'zones', filter: ['==', ['get', 'id'], ''],
      paint: { 'fill-color': colour, 'fill-opacity': fillOpacity(true) } }, firstLabel);
    map.addLayer({ id: 'sel-line', type: 'line', source: 'zones', filter: ['==', ['get', 'id'], ''],
      paint: { 'line-color': colour, 'line-width': ['case', ['==', ['get', 'method'], 'borough'], 4, 3.5] } }, firstLabel);
    applyFilters();
    paintSelection();
  }

  function applyFilters() {
    if (!map || !map.getLayer('zone-fill')) return;
    const vis = visibleFilter();
    map.setFilter('zone-fill', vis);
    LINES.forEach(([id, which]) => map.setFilter(id, ['all', which, vis]));
  }

  function paintSelection() {
    if (!map || !map.getLayer('sel-fill')) return;
    const f = ['==', ['get', 'id'], selected || ''];
    map.setFilter('sel-fill', f);
    map.setFilter('sel-line', f);
  }

  function setHover(id) {
    if (hovered === id) return;
    if (hovered && map.getSource('zones')) map.setFeatureState({ source: 'zones', id: hovered }, { hover: false });
    hovered = id;
    if (id) map.setFeatureState({ source: 'zones', id: id }, { hover: true });
    const p = id && byId[id];
    $('readout').innerHTML = p ? `${esc(p.name)} <span class="b">&middot; ${esc(p.borough)}</span>` : '';
    map.getCanvas().style.cursor = id ? 'pointer' : '';
  }

  // Borough names in Boroughs mode, as HTML so the blank style needs no font server.
  let blabels = [];
  function makeBoroughLabels() {
    blabels = BOROUGHS.features.map((f) => {
      const name = f.properties.name, b = f.properties.bbox;
      const el = document.createElement('div');
      el.className = 'blabel';
      el.textContent = name.replace(' and ', ' & ').replace(' upon Thames', '');
      const at = LABEL_AT[name] || [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
      return { inner: INNER.has(name), marker: new maplibregl.Marker({ element: el }).setLngLat(at), shown: false };
    });
  }
  function syncLabels() {
    const z = map.getZoom();
    blabels.forEach((l) => {
      const show = mode === 'boroughs' && z < 13.5 && (l.inner ? z >= 11.75 : z >= 9.5);
      if (show && !l.shown) l.marker.addTo(map);
      if (!show && l.shown) l.marker.remove();
      l.shown = show;
    });
  }

  function setAttribution() {
    $('attrib').innerHTML = mode === 'street'
      ? '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a> &middot; OS and ONS data &copy; Crown copyright 2026'
      : 'Contains OS and ONS data &copy; Crown copyright 2026';
  }

  function setMode(m) {
    if (m === mode && map.getSource('zones')) return;
    mode = m;
    hovered = null;
    document.querySelectorAll('.mapbar [data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    setAttribution();
    map.setStyle(m === 'street' ? POSITRON : BLANK, { diff: false });
    syncLabels();
  }

  function initMap() {
    const london = unionBox(BOROUGHS.features.map((f) => f.properties.bbox));
    map = new maplibregl.Map({
      container: 'map', style: POSITRON, bounds: toBounds(london), fitBoundsOptions: { padding: 10 },
      minZoom: 9, maxZoom: 18, maxPitch: 0, dragRotate: false, pitchWithRotate: false, touchPitch: false,
      attributionControl: false, transformRequest: keyRequest,
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.on('style.load', addOverlay);
    map.on('error', (e) => console.warn('licensing map:', (e && e.error && e.error.message) || e));
    // Plain map events rather than layer-scoped ones: while a base-map switch
    // reloads the style the zone layers briefly do not exist.
    const zoneAt = (pt) => {
      if (!map.getLayer('zone-fill')) return null;
      const f = map.queryRenderedFeatures(pt, { layers: ['zone-fill'] });
      return f.length ? f[0].properties.id : null;   // topmost first: the smallest zone
    };
    map.on('mousemove', (e) => setHover(zoneAt(e.point)));
    map.getCanvas().addEventListener('mouseleave', () => setHover(null));
    // A fly-to moves the map under a still pointer: drop the name rather than leave it stale.
    map.on('movestart', (e) => { if (!e.originalEvent) setHover(null); });
    map.on('click', (e) => { const id = zoneAt(e.point); if (id) select(id, false); });
    map.on('zoomend', syncLabels);
    makeBoroughLabels();
    setAttribution();
    document.querySelectorAll('.mapbar [data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    $('zoomIn').addEventListener('click', () => map.zoomIn({ duration: reduced() ? 0 : 300 }));
    $('zoomOut').addEventListener('click', () => map.zoomOut({ duration: reduced() ? 0 : 300 }));
  }

  /* ---------- panel ---------- */
  function visible(p) { return on.scope[p.scope] && on.kind[p.kind]; }
  const count = (fn) => feats.filter(fn).length;

  function stats() {
    const nCIA = AUTH.reduce((t, a) => t + a.cia, 0);
    const authWith = AUTH.filter((a) => a.cia > 0).length;
    const nOff = AUTH.reduce((t, a) => t + (a.cia_off || 0), 0);
    $('stats').innerHTML =
      `<div class="stat"><b>${nCIA}</b><span>statutory cumulative impact zones in force</span></div>` +
      `<div class="stat"><b>${authWith}<small> / ${AUTH.length}</small></b><span>licensing authorities have at least one</span></div>` +
      `<div class="stat"><b>${nOff}</b><span>of the ${nCIA} restrict off-licences only</span></div>`;
    $('maptag').innerHTML = `<b>${nCIA} statutory zones</b> in ${authWith} of London\u2019s ${AUTH.length} licensing authorities. Filled = statutory zone; dashed = other policy area. Colour shows what the zone restricts.`;
    const nm = AUTH.filter((a) => a.unmapped).map((a) => `${a.name} (${a.unmapped})`);
    if (nm.length) $('notmapped').innerHTML = `<b>Listed but not drawn:</b> ${esc(nm.join('; '))}.`;
  }

  function filterRow(group, item, n) {
    const id = `f-${group}-${item.key}`;
    const lab = document.createElement('label');
    lab.className = 'filter';
    lab.dataset.on = on[group][item.key];
    lab.innerHTML = `<input type="checkbox" id="${id}" ${on[group][item.key] ? 'checked' : ''}><span class="sw ${item.key}"></span>` +
      `<span>${esc(item.label)}${item.hint ? `<br><span class="hint">${esc(item.hint)}</span>` : ''}</span><span class="n">${n}</span>`;
    const input = lab.querySelector('input');
    input.addEventListener('change', () => { on[group][item.key] = input.checked; lab.dataset.on = input.checked; applyFilters(); });
    return lab;
  }
  function syncFilterBoxes() {
    document.querySelectorAll('.filter').forEach((el) => {
      const i = el.querySelector('input');
      const [, g, k] = i.id.split('-');
      i.checked = on[g][k];
      el.dataset.on = on[g][k];
    });
  }

  function noticeFor(p) {
    const link = (url, text) => url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text);
    const rows = [
      ['Designation', esc(p.term || KIND_LABEL[p.kind])],
      ['Restricts', `<span class="chip ${p.scope}">${SCOPE_LABEL[p.scope]}</span><br>${esc(p.covers || '')}`],
      p.presumption ? ['Policy', esc(p.presumption)] : null,
      p.from ? ['In force', esc(p.from)] : null,
      p.review ? ['Review', esc(p.review)] : null,
      ['Area', `${p.ha.toLocaleString('en-GB')} hectares`],
      ['Boundary', `<span class="prec">${esc(PREC[p.precision] || p.precision)}</span> &middot; ${esc(p.provenance || '')}`],
      ['Source', `${link(p.policy_url, p.policy || 'Statement of licensing policy')}${p.doc && p.doc !== p.policy ? `<br>${link(p.doc_url, p.doc)}${p.pages ? ', p.' + esc(p.pages) : ''}` : ''}`],
      p.notes ? ['Note', esc(p.notes)] : null,
    ].filter(Boolean);
    return `<button class="close" id="closeNotice" aria-label="Clear selection">&times;</button>
      <div class="kicker">${esc(KIND_LABEL[p.kind])} &middot; ${esc(p.authority || p.borough)}</div>
      <h3>${esc(p.name)}</h3>
      <div class="where">${esc(p.borough)}</div>
      <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  }

  let emptyNotice = '';
  function clearSel() {
    selected = null;
    paintSelection();
    $('notice').innerHTML = emptyNotice;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  }
  function select(id, fly) {
    const p = byId[id];
    if (!p) return;
    if (!visible(p)) { on.scope[p.scope] = true; on.kind[p.kind] = true; syncFilterBoxes(); applyFilters(); }
    selected = id;
    paintSelection();
    $('notice').innerHTML = noticeFor(p);
    $('closeNotice').addEventListener('click', clearSel);
    if (fly) fit(p.bbox, 16);
    try { history.replaceState(null, '', '#' + id); } catch (e) { /* ignore */ }
    // The card sits below the filters, out of sight on most screens: bring it in.
    $('notice').scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
  }

  function authorityList() {
    const al = $('authlist');
    AUTH.slice().sort((a, b) => (b.cia + b.other) - (a.cia + a.other) || a.name.localeCompare(b.name)).forEach((a) => {
      const b = document.createElement('button');
      const has = a.cia + a.other > 0;
      b.className = 'auth' + (has ? '' : ' none');
      const zs = [a.cia ? `${a.cia} zone${a.cia > 1 ? 's' : ''}` : 'none', a.other ? `+${a.other} other` : ''].filter(Boolean).join(' ');
      b.innerHTML = `<span class="nm">${esc(a.name)}</span><span class="ct">${zs} &middot; ${a.ho ?? '\u2013'}</span>${a.note ? `<span class="nt">${esc(a.note)}</span>` : ''}`;
      b.addEventListener('click', () => {
        const mine = feats.filter((p) => p.borough === a.borough && visible(p));
        const bf = BOROUGHS.features.find((f) => f.properties.name === a.borough);
        if (mine.length) {
          fit(unionBox(mine.map((p) => p.bbox)), 15);
          if (mine.length === 1) select(mine[0].id, false);
        } else if (bf) fit(bf.properties.bbox, 15, 30);
        if (matchMedia('(max-width: 860px)').matches) document.querySelector('.mapwrap').scrollIntoView({ block: 'nearest' });
      });
      al.appendChild(b);
    });
  }

  function fromHash() {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id && byId[id] && id !== selected) select(id, true);
  }

  function init([zones, boroughs, thames]) {
    ZONES = zones; BOROUGHS = boroughs; THAMES = thames;
    feats = ZONES.features.map((f) => f.properties);
    feats.forEach((p) => { byId[p.id] = p; });
    emptyNotice = $('notice').innerHTML;
    stats();
    SCOPES.forEach((s) => $('scopeFilters').appendChild(filterRow('scope', s, count((p) => p.scope === s.key && p.kind !== 'former'))));
    KINDS.forEach((k) => $('kindFilters').appendChild(filterRow('kind', k, count((p) => p.kind === k.key))));
    authorityList();
    if (typeof maplibregl === 'undefined') { fail('The map could not load. The zone details below still work.'); return; }
    try { initMap(); } catch (e) { fail('This browser could not draw the map (WebGL is needed).'); console.warn(e); return; }
    map.once('load', fromHash);
    window.addEventListener('hashchange', fromHash);
    // Hooks for the headless checks.
    window.__lic = { map: () => map, select: select, on: on, applyFilters: applyFilters, setMode: setMode, mode: () => mode, selected: () => selected };
  }

  Promise.all([getJSON('zones.json'), getJSON('boroughs.json'), getJSON('thames.json')])
    .then(init)
    .catch((e) => { console.error(e); fail('The zone data could not be loaded. Please try again later.'); });
})();
