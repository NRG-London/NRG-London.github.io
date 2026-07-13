/* OLAT Explorer v2 — borough map, district-centre chips, mode toggles, compare slider. */
(function () {
  var root = document.getElementById('olat-explorer');
  if (!root || !root.classList.contains('olat-v2')) return;
  var img = document.getElementById('olat-img');
  var imgBase = document.getElementById('olat-img-base');
  var nameEl = document.getElementById('olat-name');
  var metaEl = document.getElementById('olat-meta');
  var select = document.getElementById('olat-select');
  var tooltip = document.getElementById('olat-tooltip');
  var chipRows = root.querySelectorAll('.olat-chip-row');
  var selectedPath = root.querySelector('.olat-borough.selected');
  var activeChip = root.querySelector('.olat-chip.active');
  var toggleEbike = document.getElementById('olat-toggle-ebike');
  var toggleCar = document.getElementById('olat-toggle-car');
  var compareBtn = document.getElementById('olat-compare');
  var compareUI = document.getElementById('olat-compare-ui');
  var compareGrab = document.getElementById('olat-compare-grab');
  var compareDivider = document.getElementById('olat-compare-divider');
  var mapEl = document.getElementById('olat-map');
  var compareTagRight = document.getElementById('olat-compare-tag-right');
  var modes = (root.dataset.modes || 'pt').split(',');
  var ebike = false, car = false, comparing = false;
  var preloaded = {};
  var finePointer = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  function modeKey() {
    var k = 'pt' + (ebike ? '-ebike' : '') + (car ? '-car' : '');
    return modes.indexOf(k) !== -1 ? k : 'pt';
  }

  function modeText() {
    return 'PT' + (ebike ? ' + e-bike' : '') + (car ? ' + car' : '');
  }

  function src(mode, slug) {
    return '/images/olat/' + mode + '/' + slug + '.webp';
  }

  function preload(mode, slug) {
    var u = src(mode, slug);
    if (preloaded[u]) return;
    var i = new Image();
    i.src = u;
    preloaded[u] = true;
  }

  function firstChip(bslug) {
    var row = root.querySelector('.olat-chip-row[data-borough="' + bslug + '"]');
    return row ? row.firstElementChild : null;
  }

  function centreCountText(bslug) {
    var row = root.querySelector('.olat-chip-row[data-borough="' + bslug + '"]');
    var n = row ? row.children.length : 0;
    return n === 1 ? '1 town centre' : n + ' town centres';
  }

  function moveTooltip(e) {
    tooltip.style.left = (e.clientX + 14) + 'px';
    tooltip.style.top = (e.clientY - 10) + 'px';
  }

  function render() {
    if (!activeChip) return;
    var d = activeChip.dataset;
    var mode = modeKey();
    img.src = src(mode, d.img);
    img.alt = 'Heatmap of journey times from ' + d.name + ' (' + modeText() + ')';
    nameEl.textContent = d.name;
    var means = {};
    try { means = JSON.parse(d.means || '{}'); } catch (err) {}
    var mean = means[mode];
    metaEl.textContent = d.cls + ' centre in ' + d.boroughName +
      (mean ? ' · Mean ' + mean + ' min' : '') +
      (mode !== 'pt' ? ' · ' + modeText() : '');
    select.value = d.borough + ':' + d.slug;
    if (compareBtn) {
      compareBtn.hidden = (mode === 'pt');
      if (mode === 'pt' && comparing) setComparing(false);
    }
    if (comparing) {
      imgBase.src = src('pt', d.img);
      compareTagRight.textContent = modeText();
    }
    tooltip.style.display = 'none';
  }

  function setComparing(on) {
    comparing = on;
    compareBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    compareBtn.classList.toggle('active', on);
    compareUI.hidden = !on;
    imgBase.hidden = !on;
    if (on) {
      applyClip(50);
      render();
    } else {
      img.style.clipPath = '';
    }
  }

  function applyClip(pct) {
    /* base (PT-only) shows left of the divider, current mode right */
    pct = Math.max(0, Math.min(100, pct));
    img.style.clipPath = 'inset(0 0 0 ' + pct + '%)';
    compareDivider.style.left = pct + '%';
    compareGrab.style.left = pct + '%';
    compareGrab.setAttribute('aria-valuenow', Math.round(pct));
  }

  function chooseChip(chip) {
    if (activeChip) activeChip.classList.remove('active');
    chip.classList.add('active');
    activeChip = chip;
    render();
  }

  function chooseBorough(bslug, pickFirst) {
    chipRows.forEach(function (row) {
      row.hidden = row.dataset.borough !== bslug;
    });
    var path = root.querySelector('.olat-borough[data-slug="' + bslug + '"]');
    if (path && path !== selectedPath) {
      if (selectedPath) selectedPath.classList.remove('selected');
      path.classList.add('selected');
      selectedPath = path;
    }
    if (pickFirst) {
      var fc = firstChip(bslug);
      if (fc) chooseChip(fc);
    }
  }

  root.querySelectorAll('.olat-borough:not(.olat-nodata)').forEach(function (p) {
    p.addEventListener('click', function () { chooseBorough(this.dataset.slug, true); });
    p.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseBorough(this.dataset.slug, true); }
    });
    p.addEventListener('mouseenter', function () {
      var fc = firstChip(this.dataset.slug);
      if (fc && finePointer) preload(modeKey(), fc.dataset.img);
      tooltip.innerHTML = '<strong>' + this.dataset.name + '</strong><br>' +
        centreCountText(this.dataset.slug) + ' — click to choose';
      tooltip.style.display = 'block';
    });
    p.addEventListener('mousemove', moveTooltip);
    p.addEventListener('mouseleave', function () { tooltip.style.display = 'none'; });
  });

  root.querySelectorAll('.olat-nodata').forEach(function (p) {
    p.addEventListener('mouseenter', function () {
      tooltip.innerHTML = '<strong>' + this.dataset.name + '</strong><br><em>No OLAT data</em>';
      tooltip.style.display = 'block';
    });
    p.addEventListener('mousemove', moveTooltip);
    p.addEventListener('mouseleave', function () { tooltip.style.display = 'none'; });
  });

  root.querySelectorAll('.olat-chip').forEach(function (c) {
    c.addEventListener('click', function () { chooseChip(this); });
    c.addEventListener('mouseenter', function () {
      if (finePointer) preload(modeKey(), this.dataset.img);
    });
  });

  select.addEventListener('change', function () {
    var parts = this.value.split(':');
    chooseBorough(parts[0], false);
    var chip = root.querySelector('.olat-chip-row[data-borough="' + parts[0] + '"] .olat-chip[data-slug="' + parts[1] + '"]');
    if (chip) chooseChip(chip);
  });

  function bindToggle(btn, setter) {
    if (!btn) return;
    btn.addEventListener('click', function () {
      var on = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('active', on);
      setter(on);
      render();
    });
    btn.addEventListener('mouseenter', function () {
      if (activeChip && finePointer) {
        var e = toggleEbike && toggleEbike.getAttribute('aria-pressed') === 'true';
        var c = toggleCar && toggleCar.getAttribute('aria-pressed') === 'true';
        if (btn === toggleEbike) e = !e; else c = !c;
        var k = 'pt' + (e ? '-ebike' : '') + (c ? '-car' : '');
        if (modes.indexOf(k) !== -1) preload(k, activeChip.dataset.img);
      }
    });
  }
  bindToggle(toggleEbike, function (v) { ebike = v; });
  bindToggle(toggleCar, function (v) { car = v; });

  if (compareBtn) {
    compareBtn.addEventListener('click', function () { setComparing(!comparing); });

    var dragging = false;
    function dragTo(clientX) {
      var rect = mapEl.getBoundingClientRect();
      applyClip((clientX - rect.left) / rect.width * 100);
    }
    compareGrab.addEventListener('pointerdown', function (e) {
      dragging = true;
      compareGrab.setPointerCapture(e.pointerId);
      dragTo(e.clientX);
      e.preventDefault();
    });
    compareGrab.addEventListener('pointermove', function (e) {
      if (dragging) dragTo(e.clientX);
    });
    compareGrab.addEventListener('pointerup', function () { dragging = false; });
    compareGrab.addEventListener('pointercancel', function () { dragging = false; });
    compareGrab.addEventListener('keydown', function (e) {
      var pct = parseFloat(compareGrab.getAttribute('aria-valuenow'));
      var step = e.shiftKey ? 10 : 2;
      if (e.key === 'ArrowLeft') { applyClip(pct - step); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { applyClip(pct + step); e.preventDefault(); }
      else if (e.key === 'Home') { applyClip(0); e.preventDefault(); }
      else if (e.key === 'End') { applyClip(100); e.preventDefault(); }
    });
  }
})();
