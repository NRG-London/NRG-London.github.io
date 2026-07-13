/* OLAT Explorer v3 controller (BETA).
 * Reuses the v2 UX — borough map, district-centre chips, mode toggles — but
 * drives a <canvas> via OlatRenderer instead of swapping pre-rendered images.
 * Adds: difference maps (car / e-bike premium), an isochrone threshold, live
 * catchment stats and click-to-read. v2 is left completely untouched.
 */
(function () {
  "use strict";
  var root = document.getElementById("olat-explorer-v3");
  if (!root || typeof window.OlatRenderer === "undefined") return;

  var canvas = document.getElementById("olat3-canvas");
  var nameEl = document.getElementById("olat3-name");
  var metaEl = document.getElementById("olat3-meta");
  var select = document.getElementById("olat3-select");
  var tooltip = document.getElementById("olat3-tooltip");
  var readout = document.getElementById("olat3-readout");
  var legendEl = document.getElementById("olat3-legend");
  var statsEl = document.getElementById("olat3-stats");
  var toggleEbike = document.getElementById("olat3-toggle-ebike");
  var toggleCar = document.getElementById("olat3-toggle-car");
  var isoInput = document.getElementById("olat3-iso");
  var isoLabel = document.getElementById("olat3-iso-label");
  var mapEl = document.getElementById("olat3-map");
  var chipRows = root.querySelectorAll(".olat-chip-row");
  var viewBtns = root.querySelectorAll(".olat3-view");

  var selectedPath = root.querySelector(".olat-borough.selected");
  var activeChip = root.querySelector(".olat-chip.active");
  var ebike = false, car = false, view = "time", threshold = null;
  var finePointer = window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  var COLOURS = ["#2166AC", "#66BD63", "#D9EF8B", "#FEE08B", "#F46D43", "#A50026"];
  var TIME_LABELS = ["&lt; 15", "15–30", "30–45", "45–60", "60–90", "90+"];
  var DIFF_RAMP = ["#edf8e9", "#bae4b3", "#74c476", "#31a354", "#006d2c"];
  var DIFF_LABELS = ["&lt; 5", "5–10", "10–20", "20–30", "30+"];

  var r = new window.OlatRenderer(canvas, { base: root.dataset.base || "/olat/" });

  r.init().then(function () {
    var slug = activeChip ? activeChip.dataset.img : root.dataset.default;
    return r.setOrigin(slug);
  }).then(function () {
    updateHeader(); updateLegend(); updateStats();
    r.prefetchAll();
  }).catch(function (e) {
    if (statsEl) statsEl.textContent = "Could not load the map data (" + e.message + ").";
  });

  /* ---- header / legend / stats ------------------------------------------ */
  function modeText() { return "PT" + (ebike ? " + e-bike" : "") + (car ? " + car" : ""); }

  function updateHeader() {
    if (!activeChip) return;
    var d = activeChip.dataset;
    nameEl.innerHTML = '<span class="olat-proto-badge">Beta</span>' + d.name;
    var mean = r.mean();
    metaEl.textContent = d.cls + " centre in " + d.boroughName +
      (mean != null ? " · Mean " + mean + " min" : "") +
      (view === "time" && (ebike || car) ? " · " + modeText() : "");
    select.value = d.borough + ":" + d.slug;
  }

  function updateLegend() {
    var html = "";
    if (view === "time") {
      var iso = threshold != null;
      html = '<span class="olat-legend-title">Journey time (minutes)</span>';
      if (iso) {
        html += '<span class="olat-legend-item"><i style="background:' + r._threshColour(threshold) +
          '"></i>≤ ' + threshold + ' min</span>' +
          '<span class="olat-legend-item"><i style="background:#e8eef3"></i>beyond</span>';
      } else {
        for (var i = 0; i < 6; i++) {
          html += '<span class="olat-legend-item"><i style="background:' + COLOURS[i] +
            '"></i>' + TIME_LABELS[i] + "</span>";
        }
      }
    } else {
      var what = view === "diff-car" ? "car" : "e-bike";
      html = '<span class="olat-legend-title">Minutes saved by ' + what + ' (vs PT)</span>';
      for (var j = 0; j < 5; j++) {
        html += '<span class="olat-legend-item"><i style="background:' + DIFF_RAMP[j] +
          '"></i>' + DIFF_LABELS[j] + "</span>";
      }
      html += '<span class="olat-legend-item"><i style="background:#6a51a3"></i>newly reachable</span>' +
        '<span class="olat-legend-item"><i style="background:#eef1f4"></i>unreachable</span>';
    }
    legendEl.innerHTML = html;
  }

  function fmt(n) { return n.toLocaleString("en-GB"); }

  function updateStats() {
    if (!r._ch) return;
    if (view === "time") {
      var reach = r.reachableCount();
      var s = fmt(reach) + " of " + fmt(r.N) + " postcodes reachable (" +
        (reach / r.N * 100).toFixed(1) + "%)";
      if (threshold != null) {
        var c = r.catchmentWithin(threshold);
        s += " · " + c.pct.toFixed(1) + "% reachable within " + threshold + " min";
      }
      statsEl.textContent = s;
    } else {
      var st = diffStats(view);
      var what = view === "diff-car" ? "Car" : "E-bike";
      statsEl.textContent = what + " saves " + st.mean.toFixed(1) +
        " min on average across reachable postcodes · " +
        fmt(st.newly) + " postcodes made reachable that PT cannot reach";
    }
  }

  /* diff stats computed from the renderer's decoded channels */
  function diffStats(v) {
    var ch = r._ch, N = r.N, sent = r.sentinel;
    var ptv = ch.R, modev = v === "diff-car" ? ch.B : ch.G;
    var s = 0, c = 0, newly = 0;
    for (var i = 0; i < N; i++) {
      var m = modev[i], p = ptv[i];
      if (m >= sent) continue;
      if (p >= sent) { newly++; continue; }
      s += (p - m); c++;
    }
    return { mean: c ? s / c : 0, newly: newly };
  }

  /* ---- origin selection (borough map + chips + select) ------------------- */
  function moveTooltip(e) {
    tooltip.style.left = (e.clientX + 14) + "px";
    tooltip.style.top = (e.clientY - 10) + "px";
  }
  function firstChip(bslug) {
    var row = root.querySelector('.olat-chip-row[data-borough="' + bslug + '"]');
    return row ? row.firstElementChild : null;
  }
  function centreCountText(bslug) {
    var row = root.querySelector('.olat-chip-row[data-borough="' + bslug + '"]');
    var n = row ? row.children.length : 0;
    return n === 1 ? "1 town centre" : n + " town centres";
  }

  function chooseChip(chip) {
    if (activeChip) activeChip.classList.remove("active");
    chip.classList.add("active");
    activeChip = chip;
    canvas.setAttribute("aria-label", "Heatmap of journey times from " + chip.dataset.name);
    r.setOrigin(chip.dataset.img).then(function () {
      updateHeader(); updateStats();
    });
  }

  function chooseBorough(bslug, pickFirst) {
    chipRows.forEach(function (row) { row.hidden = row.dataset.borough !== bslug; });
    var path = root.querySelector('.olat-borough[data-slug="' + bslug + '"]');
    if (path && path !== selectedPath) {
      if (selectedPath) selectedPath.classList.remove("selected");
      path.classList.add("selected");
      selectedPath = path;
    }
    if (pickFirst) { var fc = firstChip(bslug); if (fc) chooseChip(fc); }
  }

  root.querySelectorAll(".olat-borough:not(.olat-nodata)").forEach(function (p) {
    p.addEventListener("click", function () { chooseBorough(this.dataset.slug, true); });
    p.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); chooseBorough(this.dataset.slug, true); }
    });
    p.addEventListener("mouseenter", function () {
      tooltip.innerHTML = "<strong>" + this.dataset.name + "</strong><br>" +
        centreCountText(this.dataset.slug) + " — click to choose";
      tooltip.style.display = "block";
    });
    p.addEventListener("mousemove", moveTooltip);
    p.addEventListener("mouseleave", function () { tooltip.style.display = "none"; });
  });

  root.querySelectorAll(".olat-nodata").forEach(function (p) {
    p.addEventListener("mouseenter", function () {
      tooltip.innerHTML = "<strong>" + this.dataset.name + "</strong><br><em>No OLAT data</em>";
      tooltip.style.display = "block";
    });
    p.addEventListener("mousemove", moveTooltip);
    p.addEventListener("mouseleave", function () { tooltip.style.display = "none"; });
  });

  root.querySelectorAll(".olat-chip").forEach(function (c) {
    c.addEventListener("click", function () { chooseChip(this); });
  });

  select.addEventListener("change", function () {
    var parts = this.value.split(":");
    chooseBorough(parts[0], false);
    var chip = root.querySelector('.olat-chip-row[data-borough="' + parts[0] +
      '"] .olat-chip[data-slug="' + parts[1] + '"]');
    if (chip) chooseChip(chip);
  });

  /* ---- mode toggles ------------------------------------------------------ */
  function bindToggle(btn, setter) {
    btn.addEventListener("click", function () {
      if (btn.disabled) return;
      var on = btn.getAttribute("aria-pressed") !== "true";
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.classList.toggle("active", on);
      setter(on);
      r.setModes(ebike, car);
      updateHeader(); updateStats();
    });
  }
  bindToggle(toggleEbike, function (v) { ebike = v; });
  bindToggle(toggleCar, function (v) { car = v; });

  /* ---- view switch (journey time / difference maps) ---------------------- */
  viewBtns.forEach(function (b) {
    b.addEventListener("click", function () {
      view = b.dataset.view;
      viewBtns.forEach(function (x) {
        var on = x === b;
        x.classList.toggle("active", on);
        x.setAttribute("aria-pressed", on ? "true" : "false");
      });
      var diff = view !== "time";
      [toggleEbike, toggleCar].forEach(function (t) { t.disabled = diff; t.classList.toggle("olat3-dim", diff); });
      isoInput.disabled = diff;
      r.setView(view);
      updateHeader(); updateLegend(); updateStats();
    });
  });

  /* ---- isochrone threshold ---------------------------------------------- */
  isoInput.addEventListener("input", function () {
    var v = parseInt(this.value, 10);
    threshold = v === 0 ? null : v;
    isoLabel.textContent = threshold == null ? "Isochrone: off" : "Isochrone: ≤ " + threshold + " min";
    r.setThreshold(threshold);
    updateLegend(); updateStats();
  });

  /* ---- click / hover to read the journey time anywhere ------------------- */
  function readAt(ev) {
    if (!r._ch) return;
    var p = r.eventToPx(ev);
    var hit = r.nearestAtPx(p[0], p[1]);
    if (!hit) { readout.hidden = true; return; }
    var mins = hit.minutes == null ? "unreachable" : hit.minutes + " min";
    readout.textContent = mins;
    readout.style.left = (ev.clientX) + "px";
    readout.style.top = (ev.clientY) + "px";
    readout.hidden = false;
  }
  if (finePointer) {
    canvas.addEventListener("mousemove", readAt);
    canvas.addEventListener("mouseleave", function () { readout.hidden = true; });
  }
  canvas.addEventListener("click", readAt);
  mapEl.addEventListener("mouseleave", function () { readout.hidden = true; });
})();
