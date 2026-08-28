/* OLAT Explorer v3 controller (v3.2 — adds pan/zoom).
 * Reuses the v2 UX — borough map, district-centre chips, mode toggles — but
 * drives a <canvas> via OlatRenderer instead of swapping pre-rendered images.
 * "Mapping options" is one exclusive set of four displays: Journey time,
 * E-bike saving, Car saving, Isochrone (with a threshold slider). "Map layers"
 * overlays rail / street map / stations with a fade.
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
  var legendEl = document.getElementById("olat3-legend");
  var statsEl = document.getElementById("olat3-stats");
  var toggleEbike = document.getElementById("olat3-toggle-ebike");
  var toggleCar = document.getElementById("olat3-toggle-car");
  var isoWrap = document.getElementById("olat3-iso-wrap");
  var isoInput = document.getElementById("olat3-iso");
  var isoVal = document.getElementById("olat3-iso-val");
  var refWrap = document.getElementById("olat3-ref-layers");
  var fadeInput = document.getElementById("olat3-fade");
  var layerBtns = root.querySelectorAll(".olat3-layer");
  var chipRows = root.querySelectorAll(".olat-chip-row");
  var viewBtns = root.querySelectorAll(".olat3-view");
  var scenPanel = document.getElementById("olat3-scenpanel");
  var scenList = document.getElementById("olat3-scenarios");

  var selectedPath = root.querySelector(".olat-borough.selected");
  var activeChip = root.querySelector(".olat-chip.active");
  // view: "time" | "diff-ebike" | "diff-car" | "iso"
  var ebike = false, car = false, view = "time", threshold = null;
  var didPan = false;   // set during a pan/pinch so the trailing click doesn't select a borough
  var activeScenario = null;              // null = baseline network; else a manifest.scenarios entry
  var availEbike = true, availCar = true; // which mode channels the active network provides

  var COLOURS = ["#2166AC", "#66BD63", "#D9EF8B", "#FEE08B", "#F46D43", "#A50026"];
  var TIME_LABELS = ["&lt; 15", "15–30", "30–45", "45–60", "60–90", "90+"];
  var DIFF_RAMP = ["#edf8e9", "#bae4b3", "#74c476", "#31a354", "#006d2c"];
  var DIFF_LABELS = ["&lt; 5", "5–10", "10–20", "20–30", "30+"];

  var r = new window.OlatRenderer(canvas, { base: root.dataset.base || "/olat/" });

  r.init().then(function () {
    var slug = activeChip ? activeChip.dataset.img : root.dataset.default;
    return r.setOrigin(slug);
  }).then(function () {
    updateHeader(); updateLegend(); updateStats();
    buildScenarios();
    r.prefetchAll();
  }).catch(function (e) {
    if (statsEl) statsEl.textContent = "Could not load the map data (" + e.message + ").";
  });

  function modeText() { return "PT" + (ebike ? " + e-bike" : "") + (car ? " + car" : ""); }
  function isTime() { return view === "time" || view === "iso"; }

  function updateHeader() {
    if (!activeChip) return;
    var d = activeChip.dataset;
    nameEl.textContent = d.name;
    var mean = r.mean();
    metaEl.textContent = d.cls + " centre in " + d.boroughName +
      (mean != null ? " · Mean " + mean + " min" : "") +
      (isTime() && (ebike || car) ? " · " + modeText() : "");
    select.value = d.borough + ":" + d.slug;
  }

  function updateLegend() {
    var html = "";
    if (view === "iso") {
      html = '<span class="olat-legend-title">Reachable within threshold</span>' +
        '<span class="olat-legend-item"><i style="background:' + r._threshColour(threshold) +
        '"></i>≤ ' + threshold + ' min</span>' +
        '<span class="olat-legend-item"><i style="background:#e8eef3"></i>beyond</span>';
    } else if (view === "time") {
      html = '<span class="olat-legend-title">Journey time (minutes)</span>';
      for (var i = 0; i < 6; i++) {
        html += '<span class="olat-legend-item"><i style="background:' + COLOURS[i] +
          '"></i>' + TIME_LABELS[i] + "</span>";
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

  /* ---- access to jobs ----------------------------------------------------
     "Reachable postcodes" counts places; this counts what is actually AT those
     places. The weight vector is shared by every network, so the number follows
     the mode toggles and the scenario toggle with no extra data. 45 minutes is
     the headline cutoff; in the isochrone view the existing slider drives it,
     which turns that slider into the exploration control for the stat. */
  var JOBS_ANCHOR = 45;
  var statsToken = 0;

  function compact(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(n < 1e7 ? 2 : 1).replace(/\.?0+$/, "") + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "k";
    return Math.round(n).toLocaleString("en-GB");
  }

  function jobsCutoff() {
    return (view === "iso" && threshold != null) ? threshold : JOBS_ANCHOR;
  }

  function jobsClause() {
    var cut = jobsCutoff();
    var o = r.opportunityWithin(cut);
    if (!o) return "";                       // no weight layer deployed -> omit
    return " · " + compact(o.sum) + " London jobs within " + cut + " min" +
      (o.pct != null ? " (" + o.pct.toFixed(0) + "% of London's " +
        compact(o.total) + ")" : "");
  }

  /* With a scenario on, the change is the point -- "step-free costs this centre
     39% of its 45-minute job access". That needs the baseline image for the same
     origin, a second fetch, so it lands asynchronously and is dropped if the
     origin, mode, scenario or threshold moved on in the meantime. */
  function appendScenarioJobsDelta(baseText, token) {
    if (!activeScenario) return;
    var cut = jobsCutoff();
    var now = r.opportunityWithin(cut);
    if (!now) return;
    r.baselineOpportunityWithin(cut).then(function (was) {
      if (token !== statsToken || !was || !was.sum) return;
      var pct = (now.sum - was.sum) / was.sum * 100;
      if (Math.abs(pct) < 0.5) return;       // no story in a rounding-level change
      statsEl.textContent = baseText + " — " + (pct < 0 ? "down " : "up ") +
        Math.abs(pct).toFixed(0) + "% from " + compact(was.sum) +
        " on the full network";
    });
  }

  function updateStats() {
    if (!r._ch) return;
    var token = ++statsToken;
    if (isTime()) {
      var reach = r.reachableCount();
      var s = fmt(reach) + " of " + fmt(r.N) + " postcodes reachable (" +
        (reach / r.N * 100).toFixed(1) + "%)";
      if (view === "iso") {
        var c = r.catchmentWithin(threshold);
        s += " · " + c.pct.toFixed(1) + "% reachable within " + threshold + " min";
      }
      s += jobsClause();
      statsEl.textContent = s;
      appendScenarioJobsDelta(s, token);
    } else {
      var st = diffStats(view);
      var what = view === "diff-car" ? "Car" : "E-bike";
      statsEl.textContent = what + " saves " + st.mean.toFixed(1) +
        " min on average across reachable postcodes · " +
        fmt(st.newly) + " postcodes made reachable that PT cannot reach";
    }
  }

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

  function timeLabelAt(e) {
    if (!r._ch) return "";
    var p = r.eventToPx(e);
    var hit = r.nearestAtPx(p[0], p[1]);
    if (!hit) return "";
    return hit.minutes == null ? "unreachable" : "≈" + hit.minutes + " min";
  }

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
  function showBoroughTip(el, e, noData) {
    var t = timeLabelAt(e);
    var line2 = noData ? "<em>No OLAT data</em>" : centreCountText(el.dataset.slug) + " — click to choose";
    tooltip.innerHTML = "<strong>" + el.dataset.name + "</strong>" +
      (t ? " · " + t : "") + "<br>" + line2;
    tooltip.style.display = "block";
  }

  function chooseChip(chip) {
    if (activeChip) activeChip.classList.remove("active");
    chip.classList.add("active");
    activeChip = chip;
    canvas.setAttribute("aria-label", "Heatmap of journey times from " + chip.dataset.name);
    // The star snaps to the centre you picked; the colours glide to its journey times.
    r.beginTransition();
    r.setOrigin(chip.dataset.img).then(function () {
      r.commitTransition(); updateHeader(); updateStats();
    }).catch(function () { r.cancelTransition(); });
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
    p.addEventListener("click", function () { if (didPan) return; chooseBorough(this.dataset.slug, true); });
    p.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); chooseBorough(this.dataset.slug, true); }
    });
    p.addEventListener("mouseenter", function (e) { showBoroughTip(this, e, false); });
    p.addEventListener("mousemove", function (e) { moveTooltip(e); showBoroughTip(this, e, false); });
    p.addEventListener("mouseleave", function () { tooltip.style.display = "none"; });
  });

  root.querySelectorAll(".olat-nodata").forEach(function (p) {
    p.addEventListener("mouseenter", function (e) { showBoroughTip(this, e, true); });
    p.addEventListener("mousemove", function (e) { moveTooltip(e); showBoroughTip(this, e, true); });
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

  /* ---- mode toggles (+ e-bike / + car) ----------------------------------- */
  function bindToggle(btn, setter) {
    btn.addEventListener("click", function () {
      if (btn.disabled) return;
      var on = btn.getAttribute("aria-pressed") !== "true";
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.classList.toggle("active", on);
      setter(on);
      r.beginTransition();
      r.setModes(ebike, car);
      r.commitTransition();
      updateHeader(); updateStats();
    });
  }
  bindToggle(toggleEbike, function (v) { ebike = v; });
  bindToggle(toggleCar, function (v) { car = v; });

  /* ---- Mapping options: one exclusive set of four displays --------------- */
  function selectView(v) {
    view = v;
    viewBtns.forEach(function (x) {
      var on = x.dataset.view === v;
      x.classList.toggle("active", on);
      x.setAttribute("aria-checked", on ? "true" : "false");
    });
    isoWrap.hidden = (view !== "iso");
    if (view === "iso") { r.setView("time"); threshold = parseInt(isoInput.value, 10); }
    else if (view === "time") { r.setView("time"); threshold = null; }
    else { r.setView(view); threshold = null; }
    r.setThreshold(threshold);
    refreshModeAvailability();
    updateHeader(); updateLegend(); updateStats();
  }
  viewBtns.forEach(function (b) {
    b.addEventListener("click", function () { if (b.disabled) return; selectView(b.dataset.view); });
  });

  /* ---- network scenarios (What if..?) + graceful mode fail-over ------
     A network scenario changes public-transport routing, so its data set is
     separate and never composed client-side. Its journey-time channels can land
     incrementally (pt first, then car, then e-bike overnight), so each scenario
     advertises the channels it has now in manifest.scenarios[].modes; anything
     missing is greyed out and any active use of it falls back to plain PT. */
  function refreshModeAvailability() {
    var diff = (view === "diff-car" || view === "diff-ebike");
    toggleEbike.disabled = diff || !availEbike;
    toggleEbike.classList.toggle("olat3-dim", toggleEbike.disabled);
    // explain WHY e-bike is greyed when the active scenario doesn't model it (e.g.
    // step-free). Title goes on the wrapper span so it shows despite the disabled button.
    var ebikeTip = document.getElementById("olat3-ebike-tip");
    if (ebikeTip) {
      if (!availEbike && activeScenario)
        ebikeTip.title = "Not modelled for " + (activeScenario.label || activeScenario.id);
      else
        ebikeTip.removeAttribute("title");
    }
    toggleCar.disabled = diff || !availCar;
    toggleCar.classList.toggle("olat3-dim", toggleCar.disabled);
    viewBtns.forEach(function (b) {
      if (b.dataset.view === "diff-ebike") { b.disabled = !availEbike; b.classList.toggle("olat3-dim", !availEbike); }
      if (b.dataset.view === "diff-car")   { b.disabled = !availCar;   b.classList.toggle("olat3-dim", !availCar); }
    });
  }
  function forceToggleOff(btn, setter) {
    btn.setAttribute("aria-pressed", "false"); btn.classList.remove("active"); setter(false);
  }
  // Draw the selected scheme's line + stations as an SVG overlay (from its GeoJSON,
  // projected through the map frame). It lives inside the borough SVG, so it pans and
  // zooms with everything and sits above the map layers regardless of their toggles.
  // The outgoing scheme's line fades over the same 750 ms the colours take, rather
  // than being cut away: it is one gesture, so it should read as one. The group loses
  // its id at once so the next switch cannot find it, and is removed when the fade has
  // run. SCEN_FADE_MS must stay at or above the CSS transition in olat-v3-zoom.css.
  var SCEN_FADE_MS = 800;
  function fadeOutScenarioLine(g) {
    g.removeAttribute("id");
    g.setAttribute("class", "olat3-scenario-geo olat3-scen-out olat3-scen-fade");
    setTimeout(function () { if (g.parentNode) g.parentNode.removeChild(g); }, SCEN_FADE_MS);
  }
  function drawScenarioLine(scenario) {
    var svg = document.querySelector("#olat3-map svg");
    // clear any ghost still fading from an earlier switch, then fade the current one out
    if (svg) svg.querySelectorAll(".olat3-scen-out").forEach(function (g) { g.remove(); });
    var old = document.getElementById("olat3-scenario-geo");
    if (old) fadeOutScenarioLine(old);
    if (!svg || !scenario || !scenario.geojson || !r.manifest) return;
    var fr = r.manifest.frame, cv = r.manifest.canvas;
    if (!fr || !cv) return;
    var W = cv.width, H = cv.height, x0 = fr.xlim[0], x1 = fr.xlim[1], y0 = fr.ylim[0], y1 = fr.ylim[1];
    function proj(c) { return [((c[0] - x0) / (x1 - x0)) * W, (1 - (c[1] - y0) / (y1 - y0)) * H]; }
    var NS = "http://www.w3.org/2000/svg";
    fetch(r.base + scenario.geojson).then(function (res) { return res.json(); }).then(function (gj) {
      if (activeScenario !== scenario) return;               // user switched away while loading
      var g = document.createElementNS(NS, "g");
      g.setAttribute("id", "olat3-scenario-geo");
      g.setAttribute("class", "olat3-scenario-geo olat3-scen-fade");   // lifted below
      g.setAttribute("aria-hidden", "true");
      (gj.features || []).forEach(function (f) {
        if (!f.geometry || f.geometry.type !== "LineString") return;
        var d = f.geometry.coordinates.map(function (c, i) {
          var p = proj(c); return (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1);
        }).join(" ");
        ["casing", "core"].forEach(function (part) {
          var path = document.createElementNS(NS, "path");
          path.setAttribute("d", d);
          path.setAttribute("class", "olat3-scen-line-" + part);
          g.appendChild(path);
        });
      });
      (gj.features || []).forEach(function (f) {
        if (!f.geometry || f.geometry.type !== "Point") return;
        var p = proj(f.geometry.coordinates);
        var c = document.createElementNS(NS, "circle");
        c.setAttribute("cx", p[0].toFixed(1)); c.setAttribute("cy", p[1].toFixed(1));
        c.setAttribute("r", "13");
        c.setAttribute("class", "olat3-scen-stn");
        g.appendChild(c);
      });
      svg.appendChild(g);                                    // last child -> above borough lines
      // two frames: one to let the appended node settle at opacity 0, one to lift it,
      // so the browser has a start value to transition FROM rather than skipping it
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { g.setAttribute("class", "olat3-scenario-geo"); });
      });
    }).catch(function () {});
  }
  function applyScenario(scenario) {
    activeScenario = scenario || null;
    var modes = scenario ? (scenario.modes || ["pt"]) : ["pt", "pt-ebike", "pt-car"];
    availEbike = modes.indexOf("pt-ebike") >= 0;
    availCar = modes.indexOf("pt-car") >= 0;
    // Bracket the whole switch. Mode availability, the image directory and the origin
    // all change together and the data load is async, so hold the current frame until
    // the new set has landed and then glide to it once. Before this the map painted
    // here with the OLD scenario's data under the NEW toggles, then again on arrival.
    r.beginTransition();
    if (!availEbike && ebike) forceToggleOff(toggleEbike, function () { ebike = false; });
    if (!availCar && car) forceToggleOff(toggleCar, function () { car = false; });
    r.setModes(ebike, car);
    if ((view === "diff-ebike" && !availEbike) || (view === "diff-car" && !availCar)) selectView("time");
    refreshModeAvailability();
    r.setImageDir(activeScenario ? activeScenario.dir : null);
    var slug = activeChip ? activeChip.dataset.img : root.dataset.default;
    var target = activeScenario;
    r.setOrigin(slug).then(function () {
      if (activeScenario !== target) return;      // superseded while the data loaded
      // The line is drawn HERE, not before the fetch: scenario images are never
      // prefetched, so on a first switch the old line would otherwise fade out
      // several hundred ms before the colours moved. One gesture, one moment.
      r.commitTransition();
      drawScenarioLine(target);
      updateHeader(); updateLegend(); updateStats();
    }).catch(function () { r.cancelTransition(); });   // set isn't there -> leave the map up
  }
  function buildScenarios() {
    if (root.dataset.scenarios !== "on") return;               // feature off for this page
    var list = (r.manifest && r.manifest.scenarios) || [];
    if (!scenPanel || !scenList || !list.length) return;       // nothing to offer -> stays hidden
    scenList.innerHTML = "";
    var opts = [{ label: "London today", scenario: null }].concat(
      list.map(function (s) { return { label: s.label || s.id, scenario: s }; }));
    opts.forEach(function (o, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "olat3-scen" + (i === 0 ? " active" : "");
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", i === 0 ? "true" : "false");
      b.textContent = o.label;
      b.addEventListener("click", function () {
        var isActive = b.classList.contains("active");
        // Click-to-toggle: clicking the already-active scenario reverts to the
        // baseline ("London today", the first radio), so you can flick a
        // scenario on and off without moving the mouse off the map. Clicking the
        // active "London today" is a no-op. The group always keeps exactly one
        // radio checked, so radiogroup semantics still hold.
        if (isActive && o.scenario === null) return;
        var target = (isActive && o.scenario !== null)
          ? scenList.querySelector(".olat3-scen")   // first button = "London today"
          : b;
        scenList.querySelectorAll(".olat3-scen").forEach(function (x) {
          var on = x === target;
          x.classList.toggle("active", on);
          x.setAttribute("aria-checked", on ? "true" : "false");
        });
        applyScenario(target === b ? o.scenario : null);
      });
      scenList.appendChild(b);
    });
    scenPanel.hidden = false;                                  // reveal now we have real scenarios
  }
  var isoRaf = null;
  function isoApply() { isoRaf = null; r.setThreshold(threshold); updateLegend(); updateStats(); }
  isoInput.addEventListener("input", function () {
    isoVal.textContent = this.value + " min";
    if (view === "iso") {
      threshold = parseInt(this.value, 10);
      // coalesce rapid slider input to at most one redraw per frame
      if (!isoRaf) isoRaf = (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(isoApply);
    }
  });

  /* ---- Map layers (rail / map / stations / car ownership) + fade --------- */
  if (refWrap) refWrap.style.opacity = fadeInput.value / 100;
  layerBtns.forEach(function (b) {
    b.addEventListener("click", function () {
      var on = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.classList.toggle("active", on);
      var img = document.getElementById("olat3-ref-" + b.dataset.layer);
      if (img) {
        if (on && !img.getAttribute("src")) img.src = img.dataset.src;
        img.hidden = !on;
      }
      // a layer may carry a legend (e.g. the car-ownership choropleth); reveal it with the layer
      var legend = document.getElementById("olat3-legend-" + b.dataset.layer);
      if (legend) legend.hidden = !on;
      var anyOn = Array.prototype.some.call(layerBtns, function (x) {
        return x.getAttribute("aria-pressed") === "true";
      });
      fadeInput.disabled = !anyOn;
    });
  });
  fadeInput.addEventListener("input", function () {
    if (refWrap) refWrap.style.opacity = this.value / 100;
  });

  /* ---- expand the explorer to full browser width ------------------------ */
  var expandBtn = document.getElementById("olat3-expand");
  function setExpanded(on) {
    root.classList.toggle("olat3-expanded", on);
    document.body.style.overflow = on ? "hidden" : "";
    if (expandBtn) {
      expandBtn.setAttribute("aria-pressed", on ? "true" : "false");
      expandBtn.setAttribute("title", on ? "Exit full width" : "Expand to full width");
      expandBtn.setAttribute("aria-label", on ? "Exit full width" : "Expand to full width");
      expandBtn.textContent = on ? "×" : "⤢";       // "x" when expanded, expand-arrows otherwise
    }
    // re-fit the canvas to the new width once the layout has reflowed
    (window.requestAnimationFrame || setTimeout)(function () { r.resize(); });
  }
  if (expandBtn) expandBtn.addEventListener("click", function () {
    setExpanded(!root.classList.contains("olat3-expanded"));
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && root.classList.contains("olat3-expanded")) setExpanded(false);
  });
  var rszRaf = null;
  window.addEventListener("resize", function () {               // keep the canvas crisp on resize
    if (rszRaf) return;
    rszRaf = (window.requestAnimationFrame || function (f) { return setTimeout(f, 100); })(function () {
      rszRaf = null; r.resize();
    });
  });

  /* ===== zoom / pan (beta) ================================================
     Re-projects the heatmap to a viewport (scale z, centre uc/vc), keeps the
     borough SVG (viewBox) and reference rasters (CSS transform) in sync, and
     coalesces to one redraw per animation frame so dragging stays smooth. */
  var mapEl = document.getElementById("olat3-map");
  var svgEl = mapEl.querySelector("svg");
  var zoomInBtn = document.getElementById("olat3-zoom-in");
  var zoomOutBtn = document.getElementById("olat3-zoom-out");
  var zoomResetBtn = document.getElementById("olat3-zoom-reset");

  var pendingVP = null, vpRaf = null;
  function applyViewport(z, uc, vc) {
    pendingVP = [z, uc, vc];
    if (!vpRaf) vpRaf = (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(commitViewport);
  }
  function commitViewport() {
    vpRaf = null;
    if (!pendingVP) return;
    var vp = r.setViewport(pendingVP[0], pendingVP[1], pendingVP[2]);   // clamps + re-renders canvas
    // Drive the borough SVG with the SAME CSS transform as the reference rasters.
    // Updating the SVG viewBox instead leaves the outlines frozen on GPU-composited
    // browsers (the layer isn't invalidated); a CSS transform always repaints. The
    // viewBox stays static and --olat-z lets the CSS divide the stroke widths back
    // down so the lines stay crisp and ~constant rather than thickening (see CSS).
    var tf = "translate(" + ((0.5 - vp.z * vp.uc) * 100).toFixed(3) + "%," +
      ((0.5 - vp.z * vp.vc) * 100).toFixed(3) + "%) scale(" + vp.z + ")";
    if (svgEl) {
      svgEl.style.transformOrigin = "0 0";
      svgEl.style.transform = tf;
      svgEl.style.setProperty("--olat-z", vp.z);
    }
    if (refWrap) {
      refWrap.style.transformOrigin = "0 0";
      refWrap.style.transform = tf;
    }
    var atHome = vp.z <= 1.001;
    if (zoomResetBtn) zoomResetBtn.disabled = atHome;
    if (zoomOutBtn) zoomOutBtn.disabled = atHome;
  }

  function zoomAt(clientX, clientY, factor) {
    var rect = canvas.getBoundingClientRect();
    var fx = (clientX - rect.left) / rect.width, fy = (clientY - rect.top) / rect.height;
    var vp = r.getViewport();
    var u = vp.uc + (fx - 0.5) / vp.z, v = vp.vc + (fy - 0.5) / vp.z;   // world point under cursor
    var nz = Math.max(1, Math.min(8, vp.z * factor));
    applyViewport(nz, u - (fx - 0.5) / nz, v - (fy - 0.5) / nz);        // keep it under the cursor
  }
  function zoomCentre(factor) {
    var rect = canvas.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  // Ignore gestures that originate on the zoom controls, so a quick double-click on
  // the zoom-OUT button doesn't also fire the map's double-click-to-zoom-IN (which
  // looked like zoom-out occasionally zooming in). Zoom-in never showed it because
  // the stray zoom-in pushed the same direction.
  function onZoomCtl(e) { return !!(e.target && e.target.closest && e.target.closest(".olat3-zoom")); }

  mapEl.addEventListener("wheel", function (e) {
    if (onZoomCtl(e)) return;
    e.preventDefault(); zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.2 : 1 / 1.2);
  }, { passive: false });
  mapEl.addEventListener("dblclick", function (e) { if (onZoomCtl(e)) return; e.preventDefault(); zoomAt(e.clientX, e.clientY, 1.8); });

  var pointers = {}, panStart = null, pinchStart = null, moved = 0;
  mapEl.addEventListener("pointerdown", function (e) {
    if (onZoomCtl(e)) return;
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var ids = Object.keys(pointers);
    moved = 0; didPan = false;
    if (ids.length === 1) {
      var vp = r.getViewport();
      // Do NOT capture the pointer here. Capturing on pointerdown retargets the
      // following click to #olat3-map, which is why clicking a borough (to change
      // origin) and the zoom buttons stopped working. Capture only once a real
      // drag begins (see pointermove), so plain clicks reach their target.
      panStart = { x: e.clientX, y: e.clientY, uc: vp.uc, vc: vp.vc, z: vp.z, id: e.pointerId, captured: false };
    } else if (ids.length === 2) {
      panStart = null;
      var a = pointers[ids[0]], b = pointers[ids[1]], vp2 = r.getViewport(), rect = canvas.getBoundingClientRect();
      var fx = ((a.x + b.x) / 2 - rect.left) / rect.width, fy = ((a.y + b.y) / 2 - rect.top) / rect.height;
      pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, fx: fx, fy: fy,
        u: vp2.uc + (fx - 0.5) / vp2.z, v: vp2.vc + (fy - 0.5) / vp2.z, z: vp2.z };
    }
  });
  mapEl.addEventListener("pointermove", function (e) {
    if (!pointers[e.pointerId]) return;
    pointers[e.pointerId].x = e.clientX; pointers[e.pointerId].y = e.clientY;
    var ids = Object.keys(pointers), rect = canvas.getBoundingClientRect();
    if (ids.length >= 2 && pinchStart) {
      var a = pointers[ids[0]], b = pointers[ids[1]];
      var nz = Math.max(1, Math.min(8, pinchStart.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinchStart.dist)));
      applyViewport(nz, pinchStart.u - (pinchStart.fx - 0.5) / nz, pinchStart.v - (pinchStart.fy - 0.5) / nz);
      didPan = true;
    } else if (panStart && e.buttons !== 0) {
      var dx = e.clientX - panStart.x, dy = e.clientY - panStart.y;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 5) {
        if (!panStart.captured) {                                      // a real drag started:
          try { mapEl.setPointerCapture(panStart.id); } catch (err) {} // now grab the pointer so
          panStart.captured = true;                                    // it keeps tracking outside
        }                                                              // the box
        didPan = true;
        applyViewport(panStart.z, panStart.uc - (dx / rect.width) / panStart.z, panStart.vc - (dy / rect.height) / panStart.z);
      }
    }
  });
  function endPointer(e) {
    delete pointers[e.pointerId];
    var ids = Object.keys(pointers);
    if (ids.length < 2) pinchStart = null;
    if (ids.length === 0) panStart = null;
    try { mapEl.releasePointerCapture(e.pointerId); } catch (err) {}
  }
  mapEl.addEventListener("pointerup", endPointer);
  mapEl.addEventListener("pointercancel", endPointer);

  if (zoomInBtn) zoomInBtn.addEventListener("click", function () { zoomCentre(1.5); });
  if (zoomOutBtn) zoomOutBtn.addEventListener("click", function () { zoomCentre(1 / 1.5); });
  if (zoomResetBtn) zoomResetBtn.addEventListener("click", function () { applyViewport(1, 0.5, 0.5); });
})();
