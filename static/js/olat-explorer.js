/* OLAT Explorer — single-map interactive borough heatmap viewer. */
(function () {
  var root = document.getElementById('olat-explorer');
  if (!root) return;
  var img = document.getElementById('olat-img');
  var nameEl = document.getElementById('olat-name');
  var metaEl = document.getElementById('olat-meta');
  var select = document.getElementById('olat-select');
  var tooltip = document.getElementById('olat-tooltip');
  var paths = root.querySelectorAll('.olat-borough:not(.olat-nodata)');
  var selected = root.querySelector('.olat-borough.selected');
  var preloaded = {};

  function imgSrc(slug) {
    return '/images/olat/' + slug + '.webp';
  }

  function preload(slug) {
    if (preloaded[slug]) return;
    var i = new Image();
    i.src = imgSrc(slug);
    preloaded[slug] = true;
  }

  function moveTooltip(e) {
    tooltip.style.left = (e.clientX + 14) + 'px';
    tooltip.style.top = (e.clientY - 10) + 'px';
  }

  function choose(path) {
    if (selected) selected.classList.remove('selected');
    path.classList.add('selected');
    selected = path;
    var d = path.dataset;
    img.src = imgSrc(d.slug);
    img.alt = 'Heatmap of public transport journey times from ' + d.centre;
    nameEl.textContent = d.name;
    metaEl.textContent = 'Journey times from ' + d.centre + ' · Mean ' + d.mean + ' min';
    select.value = d.slug;
    tooltip.style.display = 'none';
  }

  paths.forEach(function (p) {
    p.addEventListener('click', function () { choose(this); });
    p.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(this); }
    });
    p.addEventListener('mouseenter', function () {
      preload(this.dataset.slug);
      tooltip.innerHTML = '<strong>' + this.dataset.name + '</strong><br>Mean ' +
        this.dataset.mean + ' min from ' + this.dataset.centre;
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

  select.addEventListener('change', function () {
    var p = root.querySelector('.olat-borough[data-slug="' + this.value + '"]');
    if (p) choose(p);
  });
})();
