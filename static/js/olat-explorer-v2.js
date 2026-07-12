/* OLAT Explorer v2 (prototype) — borough map + district-centre chips. */
(function () {
  var root = document.getElementById('olat-explorer');
  if (!root || !root.classList.contains('olat-v2')) return;
  var img = document.getElementById('olat-img');
  var nameEl = document.getElementById('olat-name');
  var metaEl = document.getElementById('olat-meta');
  var select = document.getElementById('olat-select');
  var tooltip = document.getElementById('olat-tooltip');
  var chipRows = root.querySelectorAll('.olat-chip-row');
  var selectedPath = root.querySelector('.olat-borough.selected');
  var activeChip = root.querySelector('.olat-chip.active');
  var preloaded = {};
  var finePointer = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  function preload(imgSlug) {
    if (!finePointer || preloaded[imgSlug]) return;
    var i = new Image();
    i.src = '/images/olat/' + imgSlug + '.webp';
    preloaded[imgSlug] = true;
  }

  function moveTooltip(e) {
    tooltip.style.left = (e.clientX + 14) + 'px';
    tooltip.style.top = (e.clientY - 10) + 'px';
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

  function chooseChip(chip) {
    if (activeChip) activeChip.classList.remove('active');
    chip.classList.add('active');
    activeChip = chip;
    var d = chip.dataset;
    img.src = '/images/olat/' + d.img + '.webp';
    img.alt = 'Heatmap of public transport journey times from ' + d.name;
    nameEl.textContent = d.name;
    metaEl.textContent = d.cls + ' centre in ' + d.boroughName +
      (d.mean ? ' · Mean ' + d.mean + ' min' : '');
    select.value = d.borough + ':' + d.slug;
    tooltip.style.display = 'none';
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
      var row = root.querySelector('.olat-chip-row[data-borough="' + bslug + '"]');
      if (row && row.firstElementChild) chooseChip(row.firstElementChild);
    }
  }

  root.querySelectorAll('.olat-borough:not(.olat-nodata)').forEach(function (p) {
    p.addEventListener('click', function () { chooseBorough(this.dataset.slug, true); });
    p.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseBorough(this.dataset.slug, true); }
    });
    p.addEventListener('mouseenter', function () {
      var fc = firstChip(this.dataset.slug);
      if (fc) preload(fc.dataset.img);
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
    c.addEventListener('mouseenter', function () { preload(this.dataset.img); });
  });

  select.addEventListener('change', function () {
    var parts = this.value.split(':');
    chooseBorough(parts[0], false);
    var chip = root.querySelector('.olat-chip-row[data-borough="' + parts[0] + '"] .olat-chip[data-slug="' + parts[1] + '"]');
    if (chip) chooseChip(chip);
  });
})();
