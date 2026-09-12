/* Literature map — literature-first landscape.
   Areas are transversal attributes: 16 precomputed anchors, each node attracted
   to the mean of its areas' anchors + real-edge links + collision. The layout
   settles once and freezes; interaction changes visibility, never position. */

(function () {
  "use strict";

  var DATA_URL = "../research/literature-graph.json";
  var RM = matchMedia("(prefers-reduced-motion: reduce)").matches;

  var $ = function (id) { return document.getElementById(id); };
  var stage = $("lit-stage");
  var statusEl = $("lit-status");

  fetch(DATA_URL)
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(init)
    .catch(function (err) {
      stage.innerHTML =
        '<div class="lit-error"><p><strong>Could not load the literature graph.</strong></p>' +
        "<p>" + String(err.message || err).replace(/[<>&]/g, "") + "</p>" +
        "<p>If you opened this page from disk, serve the site root instead:</p>" +
        "<p><code>python3 -m http.server</code> &nbsp;then open&nbsp; <code>http://localhost:8000/literature/</code></p></div>";
    });

  /* ------------------------------------------------------------------ */

  function init(data) {
    var nodes = data.nodes;
    var edges = data.edges;
    var areas = data.areas;

    var W = 1680, H = 1150;

    /* ---------- indexes ---------- */

    var byId = new Map();
    nodes.forEach(function (n) { byId.set(n.id, n); });

    var adj = new Map();
    nodes.forEach(function (n) { adj.set(n.id, []); });
    edges.forEach(function (e) {
      adj.get(e.source).push({ e: e, other: e.target, dir: "out" });
      adj.get(e.target).push({ e: e, other: e.source, dir: "in" });
    });
    nodes.forEach(function (n) { n.deg = adj.get(n.id).length; });

    var areaById = new Map();
    areas.forEach(function (a) { areaById.set(a.id, a); });

    /* ---------- intro counts ---------- */

    var counts = (data.meta && data.meta.counts) || {};
    var nByType = counts.nodesByType || {};
    var nonProject = (counts.nodes || nodes.length) - (nByType.project || 0);
    $("lit-count").textContent =
      nonProject + " papers, methods, datasets and open questions, linked by " +
      (counts.edges || edges.length) + " relations.";

    /* ---------- tiers: overview subset ---------- */

    var CORE = { method: 1, dataset: 1, concept: 1, gap: 1, question: 1, project: 1 };
    var primary = new Set();
    nodes.forEach(function (n) { if (CORE[n.type]) primary.add(n.id); });
    var papersRanked = nodes
      .filter(function (n) { return n.type === "paper"; })
      .sort(function (a, b) { return b.deg - a.deg || (b.year || 0) - (a.year || 0); });
    for (var pi = 0; pi < papersRanked.length && primary.size < 106; pi++) {
      primary.add(papersRanked[pi].id);
    }
    nodes.forEach(function (n) { if (n.seed) primary.add(n.id); });

    /* ---------- area anchors: golden-angle seed + co-membership force ---------- */

    var coCount = new Map();
    nodes.forEach(function (n) {
      var as = n.areas || [];
      for (var i = 0; i < as.length; i++)
        for (var j = i + 1; j < as.length; j++) {
          var k = as[i] < as[j] ? as[i] + "|" + as[j] : as[j] + "|" + as[i];
          coCount.set(k, (coCount.get(k) || 0) + 1);
        }
    });
    var maxCo = 1;
    coCount.forEach(function (v) { if (v > maxCo) maxCo = v; });

    var anchorNodes = areas.map(function (a, i) {
      var ang = i * 2.399963, r = 70 * Math.sqrt(i + 1);
      return { id: a.id, x: W / 2 + r * Math.cos(ang), y: H / 2 + r * Math.sin(ang) };
    });
    var anchorLinks = [];
    coCount.forEach(function (v, k) {
      var p = k.split("|");
      anchorLinks.push({ source: p[0], target: p[1], w: v / maxCo });
    });
    var aSim = d3.forceSimulation(anchorNodes)
      .force("link", d3.forceLink(anchorLinks).id(function (d) { return d.id; })
        .distance(function (l) { return 480 - 330 * l.w; })
        .strength(function (l) { return 0.25 + 0.6 * l.w; }))
      .force("charge", d3.forceManyBody().strength(-1400))
      .force("center", d3.forceCenter(W / 2, H / 2))
      .stop();
    for (var t = 0; t < 260; t++) aSim.tick();

    /* scale anchors into the frame */
    var ax0 = Infinity, ax1 = -Infinity, ay0 = Infinity, ay1 = -Infinity;
    anchorNodes.forEach(function (a) {
      ax0 = Math.min(ax0, a.x); ax1 = Math.max(ax1, a.x);
      ay0 = Math.min(ay0, a.y); ay1 = Math.max(ay1, a.y);
    });
    var anchor = new Map();
    anchorNodes.forEach(function (a) {
      anchor.set(a.id, {
        x: 0.14 * W + (a.x - ax0) / (ax1 - ax0 || 1) * 0.72 * W,
        y: 0.16 * H + (a.y - ay0) / (ay1 - ay0 || 1) * 0.68 * H
      });
    });

    /* ---------- node geometry ---------- */

    function nodeR(n) {
      switch (n.type) {
        case "paper": return 3 + Math.sqrt(n.deg) * 1.7;
        case "method": return 4.6;
        case "dataset": return 4.4;
        case "project": return 4.6;
        case "gap": return 5.6;
        case "question": return 4.4;
        case "concept": return 2.7;
        default: return 2.4; /* metric, task */
      }
    }

    nodes.forEach(function (n) {
      var as = (n.areas || []).filter(function (a) { return anchor.has(a); });
      var mx = 0, my = 0;
      if (as.length) {
        as.forEach(function (a) { mx += anchor.get(a).x; my += anchor.get(a).y; });
        mx /= as.length; my /= as.length;
      } else { mx = W / 2; my = H / 2; }
      n.ax = mx; n.ay = my;
      n.x = mx + (Math.random() - 0.5) * 150;
      n.y = my + (Math.random() - 0.5) * 150;
      n.r = nodeR(n);
    });

    /* ---------- main layout: settle then freeze ---------- */

    var simLinks = edges.map(function (e) { return { source: e.source, target: e.target }; });
    var sim = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(simLinks).id(function (d) { return d.id; })
        .distance(58).strength(0.35))
      .force("charge", d3.forceManyBody().strength(-34).distanceMax(320))
      .force("ax", d3.forceX(function (d) { return d.ax; }).strength(0.075))
      .force("ay", d3.forceY(function (d) { return d.ay; }).strength(0.075))
      .force("collide", d3.forceCollide(function (d) {
        return d.r + (primary.has(d.id) ? 7 : 3.5);
      }).iterations(2))
      .stop();
    for (var s = 0; s < 320; s++) sim.tick();

    /* area landmarks at the centroid of their (primary) members */
    var landmarks = areas.map(function (a) {
      var xs = 0, ys = 0, c = 0;
      nodes.forEach(function (n) {
        if ((n.areas || []).indexOf(a.id) >= 0 && primary.has(n.id)) {
          xs += n.x; ys += n.y; c++;
        }
      });
      if (!c) { var an = anchor.get(a.id); xs = an.x; ys = an.y; c = 1; }
      return { id: a.id, label: a.label, x: xs / c, y: ys / c };
    });
    /* gentle repel so landmark texts do not sit on each other */
    for (var it = 0; it < 60; it++) {
      for (var i = 0; i < landmarks.length; i++)
        for (var j = i + 1; j < landmarks.length; j++) {
          var A = landmarks[i], B = landmarks[j];
          var dx = B.x - A.x, dy = B.y - A.y;
          var d = Math.sqrt(dx * dx + dy * dy) || 1;
          var minD = 150;
          if (d < minD) {
            var push = (minD - d) / d * 0.5;
            A.x -= dx * push; A.y -= dy * push;
            B.x += dx * push; B.y += dy * push;
          }
        }
    }

    /* ---------- labels ---------- */

    function firstAuthor(a) {
      if (!a) return null;
      var f = a.split(/,|&| and /)[0].trim().replace(/\s+et al\.?$/, "");
      return f || null;
    }
    function truncate(s, n) {
      return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s;
    }
    function labelText(n) {
      if (n.type === "paper") {
        var fa = firstAuthor(n.authors);
        return fa ? fa + (n.year ? " " + n.year : "") : truncate(n.label, 24);
      }
      if (n.type === "question" || n.type === "gap") return truncate(n.label, 42);
      return truncate(n.label, 26);
    }
    nodes.forEach(function (n) { n.lbl = labelText(n); });

    /* ---------- svg scaffold ---------- */

    var svg = d3.select("#lit-svg");
    var root = svg.append("g").attr("class", "lit-root");
    var gAreas = root.append("g").attr("class", "layer-areas");
    var gEdges = root.append("g").attr("class", "layer-edges");
    var gNodes = root.append("g").attr("class", "layer-nodes");

    gAreas.selectAll("text").data(landmarks).enter()
      .append("text")
      .attr("class", "area-label")
      .attr("x", function (d) { return d.x; })
      .attr("y", function (d) { return d.y; })
      .text(function (d) { return d.label; });

    var edgeSel = gEdges.selectAll("g").data(edges).enter()
      .append("g")
      .attr("data-type", function (d) { return d.type; });
    edgeSel.append("line")
      .attr("class", "edge-line")
      .attr("x1", function (d) { return byId.get(d.source).x; })
      .attr("y1", function (d) { return byId.get(d.source).y; })
      .attr("x2", function (d) { return byId.get(d.target).x; })
      .attr("y2", function (d) { return byId.get(d.target).y; });
    edgeSel.append("line")
      .attr("class", "edge-hit")
      .attr("x1", function (d) { return byId.get(d.source).x; })
      .attr("y1", function (d) { return byId.get(d.source).y; })
      .attr("x2", function (d) { return byId.get(d.target).x; })
      .attr("y2", function (d) { return byId.get(d.target).y; });

    var nodeSel = gNodes.selectAll("g").data(nodes).enter()
      .append("g")
      .attr("transform", function (d) { return "translate(" + d.x + "," + d.y + ")"; })
      .attr("role", "button")
      .attr("tabindex", -1)
      .attr("aria-label", function (d) { return d.label + " (" + d.type + ")"; });

    nodeSel.each(function (d) {
      var g = d3.select(this);
      if (d.type === "dataset" || d.type === "project") {
        g.append("rect").attr("class", "shape")
          .attr("x", -d.r).attr("y", -d.r)
          .attr("width", d.r * 2).attr("height", d.r * 2);
      } else {
        g.append("circle").attr("class", "shape").attr("r", d.r);
      }
      g.append("text")
        .attr("class", "lbl")
        .attr("y", d.r + (d.type === "paper" ? 9.5 : 8.5))
        .text(d.lbl);
    });

    /* ---------- state ---------- */

    var state = {
      trail: [],            /* selection path, last = current */
      mode: null,           /* null | "gaps" | {area:id} */
      revealed: new Set(),  /* secondary nodes surfaced this session */
      showAll: false,
      history: [],
      filters: null
    };

    var yearsAll = nodes.map(function (n) { return n.year; })
      .filter(function (y) { return y != null; });
    var yMinData = Math.min.apply(null, yearsAll);
    var yMaxData = Math.max.apply(null, yearsAll);
    var ALL_TYPES = ["paper", "method", "dataset", "concept", "gap", "question", "metric", "task", "project"];
    state.filters = {
      types: new Set(ALL_TYPES),
      areas: new Set(),
      yMin: yMinData, yMax: yMaxData,
      review: "all"
    };

    function tierVisible(id) {
      return state.showAll || primary.has(id) || state.revealed.has(id);
    }
    function filtersActive() {
      var f = state.filters;
      return f.types.size < ALL_TYPES.length || f.areas.size > 0 ||
        f.yMin > yMinData || f.yMax < yMaxData || f.review !== "all";
    }
    function passesFilter(n) {
      var f = state.filters;
      if (!f.types.has(n.type)) return false;
      if (f.areas.size) {
        var hit = (n.areas || []).some(function (a) { return f.areas.has(a); });
        if (!hit) return false;
      }
      if (n.year != null && (n.year < f.yMin || n.year > f.yMax)) return false;
      if (f.review === "peer" && n.type === "paper" && n.peerReviewed !== true) return false;
      if (f.review === "preprint" && n.type === "paper" && n.peerReviewed !== false) return false;
      return true;
    }

    function surfacedSet() {
      if (state.trail.length) {
        var S = new Set();
        state.trail.forEach(function (id) {
          S.add(id);
          adj.get(id).forEach(function (a) { S.add(a.other); });
        });
        return S;
      }
      if (state.mode === "gaps") {
        var G = new Set();
        nodes.forEach(function (n) {
          if (n.type === "gap" || n.type === "question") {
            G.add(n.id);
            adj.get(n.id).forEach(function (a) { G.add(a.other); });
          }
        });
        return G;
      }
      return null;
    }

    function selectedId() {
      return state.trail.length ? state.trail[state.trail.length - 1] : null;
    }

    /* ---------- render ---------- */

    function render() {
      var S = surfacedSet();
      var areaMode = state.mode && typeof state.mode === "object" ? state.mode.area : null;
      var fActive = filtersActive();
      var sel = selectedId();

      nodeSel.attr("class", function (d) {
        var c = "node t-" + d.type + (d.seed ? " seed" : "");
        if (S) c += S.has(d.id) ? " on" : " off";
        else if (areaMode) {
          var member = (d.areas || []).indexOf(areaMode) >= 0;
          c += member ? (tierVisible(d.id) ? " on" : " mid") : " off";
        } else c += tierVisible(d.id) ? " base" : " ghost";
        if (fActive && !passesFilter(d) && !(S && S.has(d.id))) c += " fdim";
        if (d.id === sel) c += " selected";
        return c;
      });

      edgeSel.attr("class", function (d) {
        var c = "edge";
        var sOK, tOK;
        if (S) c += (S.has(d.source) && S.has(d.target)) ? " on" : " off";
        else if (areaMode) {
          sOK = (byId.get(d.source).areas || []).indexOf(areaMode) >= 0;
          tOK = (byId.get(d.target).areas || []).indexOf(areaMode) >= 0;
          c += (sOK && tOK) ? " on" : " off";
        } else {
          c += (tierVisible(d.source) && tierVisible(d.target)) ? " base" : " ghost";
        }
        if (fActive && !(S && S.has(d.source) && S.has(d.target)) &&
            (!passesFilter(byId.get(d.source)) || !passesFilter(byId.get(d.target)))) c += " fdim";
        return c;
      });

      stage.classList.toggle("has-focus", !!(S || areaMode));
      updateLabels();
      $("lit-back").disabled = state.history.length === 0;
      $("lit-gaps").setAttribute("aria-pressed", state.mode === "gaps" ? "true" : "false");
      $("lit-showall").setAttribute("aria-pressed", state.showAll ? "true" : "false");
      $("lit-showall").textContent = state.showAll ? "Show less" : "Show everything";
    }

    /* ---------- label decluttering (world-space, greedy by priority) ---------- */

    var zoomBand = "far";

    function labelPriority(d, S) {
      var p = d.deg;
      if (d.id === selectedId()) return 10000;
      if (S && S.has(d.id)) return 5000 + p;
      switch (d.type) {
        case "paper": return 900 + p * 10;
        case "gap": case "question": return 700 + p * 10;
        case "method": case "dataset": case "project": return 600 + p * 10;
        case "concept": return 300 + p * 10;
        default: return 100 + p * 10;
      }
    }
    function labelFs(d) {
      if (d.type === "paper") return 9.5;
      if (d.type === "concept" || d.type === "metric" || d.type === "task") return 7.5;
      return 8.2;
    }
    function labelEligible(d, S) {
      if (S) return S.has(d.id);
      if (state.mode && typeof state.mode === "object")
        return (d.areas || []).indexOf(state.mode.area) >= 0 && tierVisible(d.id);
      if (!tierVisible(d.id)) return false;
      if (d.type === "concept") return zoomBand !== "far" || d.deg >= 8;
      if (d.type === "metric" || d.type === "task") return zoomBand === "near";
      if (d.type === "paper" && !primary.has(d.id)) return zoomBand !== "far";
      return true;
    }

    function updateLabels() {
      var S = surfacedSet();
      var placed = [];
      var cands = [];
      nodeSel.each(function (d) {
        if (labelEligible(d, S)) cands.push(d);
        else d._lblOn = false;
      });
      cands.sort(function (a, b) { return labelPriority(b, S) - labelPriority(a, S); });
      cands.forEach(function (d) {
        var fs = labelFs(d);
        var w = d.lbl.length * fs * 0.56;
        var box = { x0: d.x - w / 2, x1: d.x + w / 2, y0: d.y + d.r + 2, y1: d.y + d.r + 2 + fs * 1.25 };
        var ok = true;
        for (var i = 0; i < placed.length; i++) {
          var b = placed[i];
          if (box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0) { ok = false; break; }
        }
        d._lblOn = ok;
        if (ok) placed.push(box);
      });
      nodeSel.select("text.lbl").attr("class", function (d) {
        return "lbl" + (d._lblOn ? "" : " lbl-hide");
      });
    }

    /* ---------- zoom / pan ---------- */

    var zoom = d3.zoom()
      .scaleExtent([0.25, 6])
      .on("zoom", function (ev) {
        root.attr("transform", ev.transform);
        var k = ev.transform.k;
        var band = k < 1.45 ? "far" : k < 2.35 ? "mid" : "near";
        if (band !== zoomBand) {
          zoomBand = band;
          stage.setAttribute("data-zoom", band);
          updateLabels();
        }
      });
    svg.call(zoom).on("dblclick.zoom", null);

    function stageSize() {
      var r = stage.getBoundingClientRect();
      return { w: r.width, h: r.height };
    }
    function zoomFit(subset, animate) {
      var list = subset && subset.length ? subset : nodes.filter(function (n) { return primary.has(n.id); });
      var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      list.forEach(function (n) {
        x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x);
        y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y);
      });
      if (!subset) {
        /* keep the area landmark texts inside the frame */
        landmarks.forEach(function (l) {
          var hw = l.label.length * 8;
          x0 = Math.min(x0, l.x - hw); x1 = Math.max(x1, l.x + hw);
          y0 = Math.min(y0, l.y - 22); y1 = Math.max(y1, l.y + 12);
        });
      }
      var sz = stageSize(), pad = 70;
      var k = Math.min((sz.w - pad) / (x1 - x0 || 1), (sz.h - pad) / (y1 - y0 || 1));
      k = Math.max(0.25, Math.min(k, 1.6));
      var tf = d3.zoomIdentity
        .translate(sz.w / 2 - k * (x0 + x1) / 2, sz.h / 2 - k * (y0 + y1) / 2)
        .scale(k);
      (animate && !RM ? svg.transition().duration(450) : svg).call(zoom.transform, tf);
    }
    function flyTo(n) {
      var sz = stageSize();
      var k = Math.max(d3.zoomTransform(svg.node()).k, 1.7);
      var tf = d3.zoomIdentity.translate(sz.w / 2 - k * n.x, sz.h / 2 - k * n.y).scale(k);
      (RM ? svg : svg.transition().duration(520)).call(zoom.transform, tf);
    }

    $("lit-zoom-in").addEventListener("click", function () {
      (RM ? svg : svg.transition().duration(180)).call(zoom.scaleBy, 1.45);
    });
    $("lit-zoom-out").addEventListener("click", function () {
      (RM ? svg : svg.transition().duration(180)).call(zoom.scaleBy, 1 / 1.45);
    });
    $("lit-zoom-fit").addEventListener("click", function () {
      var S = surfacedSet();
      zoomFit(S ? nodes.filter(function (n) { return S.has(n.id); }) : null, true);
    });

    /* ---------- history / selection ---------- */

    function snapshot() {
      return {
        trail: state.trail.slice(),
        mode: state.mode,
        revealed: new Set(state.revealed)
      };
    }
    function pushHistory() {
      state.history.push(snapshot());
      if (state.history.length > 60) state.history.shift();
    }

    function selectNode(id, opts) {
      opts = opts || {};
      var n = byId.get(id);
      if (!n) return;
      if (!opts.silentHistory) pushHistory();
      var S = surfacedSet();
      if (state.trail.length && S && S.has(id) && state.trail.indexOf(id) < 0) {
        state.trail.push(id); /* deepen the trail */
      } else {
        state.trail = [id];
      }
      state.mode = null;
      /* neighborhood surfaces: reveal hidden neighbors so they fade in */
      state.revealed.add(id);
      adj.get(id).forEach(function (a) {
        if (!primary.has(a.other)) state.revealed.add(a.other);
      });
      render();
      renderPanel(n);
      if (opts.fly) flyTo(n);
      announce(n.label + " selected. " + adj.get(id).length + " connections surfaced.");
    }

    function clearSelection() {
      state.trail = [];
      state.mode = null;
      render();
      panelEmpty();
    }

    $("lit-back").addEventListener("click", function () {
      var prev = state.history.pop();
      if (!prev) return;
      state.trail = prev.trail;
      state.mode = prev.mode;
      state.revealed = prev.revealed;
      render();
      var sel = selectedId();
      if (sel) renderPanel(byId.get(sel)); else panelEmpty();
    });

    $("lit-reset").addEventListener("click", function () {
      state.trail = [];
      state.mode = null;
      state.history = [];
      state.revealed = new Set();
      state.showAll = false;
      state.filters.types = new Set(ALL_TYPES);
      state.filters.areas = new Set();
      state.filters.yMin = yMinData;
      state.filters.yMax = yMaxData;
      state.filters.review = "all";
      syncFilterUI();
      closeFilters();
      searchInput.value = "";
      closeResults();
      render();
      panelEmpty();
      zoomFit(null, true);
      announce("View reset.");
    });

    document.addEventListener("keydown", function (ev) {
      if (ev.key === "/" && document.activeElement !== searchInput &&
          !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
        ev.preventDefault();
        searchInput.focus();
        searchInput.select();
      }
      if (ev.key === "Escape") {
        if (!resultsEl.hidden) { closeResults(); return; }
        if (state.trail.length || state.mode) clearSelection();
      }
    });

    /* node + edge interaction */

    nodeSel
      .on("click", function (ev, d) {
        ev.stopPropagation();
        selectNode(d.id);
      })
      .on("mouseenter", function (ev, d) {
        d3.select(this).classed("hl", true);
        edgeSel.classed("hl", function (e) { return e.source === d.id || e.target === d.id; });
      })
      .on("mouseleave", function () {
        d3.select(this).classed("hl", false);
        edgeSel.classed("hl", false);
      });

    svg.on("click", function () { if (state.trail.length || state.mode) clearSelection(); });

    var tooltip = $("lit-tooltip");
    edgeSel
      .on("mouseenter", function (ev, d) {
        d3.select(this).classed("hl", true);
        nodeSel.classed("hl", function (n) { return n.id === d.source || n.id === d.target; });
        tooltip.innerHTML = "";
        var tEl = document.createElement("span");
        tEl.className = "tt-type";
        tEl.textContent = byId.get(d.source).label + " " + relLabel(d.type, "out") + " " + byId.get(d.target).label;
        var xEl = document.createElement("span");
        xEl.className = "tt-expl";
        xEl.textContent = d.explanation || "";
        tooltip.appendChild(tEl);
        tooltip.appendChild(xEl);
        tooltip.hidden = false;
      })
      .on("mousemove", function (ev) {
        var r = stage.getBoundingClientRect();
        var x = ev.clientX - r.left, y = ev.clientY - r.top;
        tooltip.style.left = Math.min(x + 14, r.width - 290) + "px";
        tooltip.style.top = Math.min(y + 12, r.height - 90) + "px";
      })
      .on("mouseleave", function () {
        d3.select(this).classed("hl", false);
        nodeSel.classed("hl", false);
        tooltip.hidden = true;
      });

    /* ---------- gaps preset / show everything ---------- */

    $("lit-gaps").addEventListener("click", function () {
      pushHistory();
      if (state.mode === "gaps") { state.mode = null; render(); announce("Gaps view closed."); return; }
      state.trail = [];
      state.mode = "gaps";
      /* surface hidden members of gap/question neighborhoods */
      nodes.forEach(function (n) {
        if (n.type === "gap" || n.type === "question") {
          adj.get(n.id).forEach(function (a) {
            if (!primary.has(a.other)) state.revealed.add(a.other);
          });
        }
      });
      render();
      panelEmpty();
      var gs = nByType.gap || 0, qs = nByType.question || 0;
      announce("Showing " + gs + " gaps and " + qs + " open questions with their neighborhoods.");
    });

    $("lit-showall").addEventListener("click", function () {
      state.showAll = !state.showAll;
      render();
      announce(state.showAll ? "All " + nodes.length + " nodes shown." : "Back to the overview subset.");
    });

    function announce(msg) { statusEl.textContent = msg; }

    /* ---------- filters ---------- */

    var TYPE_LABEL = {
      paper: "Papers", method: "Methods", dataset: "Datasets", concept: "Concepts",
      gap: "Gaps", question: "Questions", metric: "Metrics", task: "Tasks", project: "Project"
    };

    buildFilters();
    function buildFilters() {
      var wrap = $("lit-filters");
      var fTypes = document.createElement("div");
      fTypes.className = "f-group";
      fTypes.appendChild(fLegend("Type"));
      ALL_TYPES.forEach(function (t) {
        fTypes.appendChild(chip("type", t, TYPE_LABEL[t], true));
      });
      var fAreas = document.createElement("div");
      fAreas.className = "f-group";
      fAreas.appendChild(fLegend("Area"));
      areas.forEach(function (a) {
        fAreas.appendChild(chip("area", a.id, a.label, false));
      });
      var fYear = document.createElement("div");
      fYear.className = "f-group f-year";
      fYear.appendChild(fLegend("Years"));
      fYear.appendChild(yearInput("lit-ymin", yMinData));
      var dash = document.createElement("span"); dash.textContent = "to"; dash.className = "f-sep";
      fYear.appendChild(dash);
      fYear.appendChild(yearInput("lit-ymax", yMaxData));
      var fRev = document.createElement("div");
      fRev.className = "f-group";
      fRev.appendChild(fLegend("Evidence"));
      [["all", "All"], ["peer", "Peer-reviewed"], ["preprint", "Preprints"]].forEach(function (o) {
        var l = document.createElement("label");
        l.className = "f-chip";
        var r = document.createElement("input");
        r.type = "radio"; r.name = "lit-review"; r.value = o[0]; r.checked = o[0] === "all";
        r.addEventListener("change", onFilterChange);
        l.appendChild(r);
        l.appendChild(document.createTextNode(o[1]));
        fRev.appendChild(l);
      });
      wrap.appendChild(fTypes); wrap.appendChild(fAreas); wrap.appendChild(fYear); wrap.appendChild(fRev);
      var done = document.createElement("button");
      done.type = "button";
      done.className = "f-close";
      done.textContent = "Done";
      done.setAttribute("aria-label", "Close filters");
      done.addEventListener("click", closeFilters);
      wrap.appendChild(done);
    }
    function closeFilters() {
      $("lit-filters").hidden = true;
      $("lit-filters-toggle").setAttribute("aria-expanded", "false");
    }
    function fLegend(t) {
      var s = document.createElement("span"); s.className = "f-legend"; s.textContent = t; return s;
    }
    function chip(kind, val, label, checked) {
      var l = document.createElement("label");
      l.className = "f-chip";
      var c = document.createElement("input");
      c.type = "checkbox"; c.checked = checked;
      c.dataset.kind = kind; c.dataset.val = val;
      c.addEventListener("change", onFilterChange);
      l.appendChild(c);
      l.appendChild(document.createTextNode(label));
      return l;
    }
    function yearInput(id, val) {
      var i = document.createElement("input");
      i.type = "number"; i.id = id; i.min = yMinData; i.max = yMaxData; i.value = val;
      i.setAttribute("aria-label", id === "lit-ymin" ? "From year" : "To year");
      i.addEventListener("change", onFilterChange);
      return i;
    }
    function onFilterChange() {
      var f = state.filters;
      f.types = new Set();
      f.areas = new Set();
      $("lit-filters").querySelectorAll("input[type=checkbox]").forEach(function (c) {
        if (!c.checked) return;
        if (c.dataset.kind === "type") f.types.add(c.dataset.val);
        else f.areas.add(c.dataset.val);
      });
      f.yMin = +($("lit-ymin").value || yMinData);
      f.yMax = +($("lit-ymax").value || yMaxData);
      var rv = $("lit-filters").querySelector("input[name=lit-review]:checked");
      f.review = rv ? rv.value : "all";
      render();
      if (filtersActive()) {
        var m = nodes.filter(passesFilter).length;
        announce(m + " of " + nodes.length + " nodes match the filters.");
      } else announce("Filters cleared.");
    }
    function syncFilterUI() {
      $("lit-filters").querySelectorAll("input[type=checkbox]").forEach(function (c) {
        c.checked = c.dataset.kind === "type";
      });
      $("lit-ymin").value = yMinData;
      $("lit-ymax").value = yMaxData;
      var all = $("lit-filters").querySelector("input[name=lit-review][value=all]");
      if (all) all.checked = true;
    }
    $("lit-filters-toggle").addEventListener("click", function () {
      var f = $("lit-filters");
      var open = f.hidden;
      f.hidden = !open;
      this.setAttribute("aria-expanded", open ? "true" : "false");
    });

    /* ---------- search ---------- */

    var searchInput = $("lit-search");
    var resultsEl = $("lit-search-results");
    var searchIdx = nodes.map(function (n) {
      var areaNames = (n.areas || []).map(function (a) {
        return (areaById.get(a) || {}).label || a;
      }).join(" ");
      return {
        n: n,
        label: n.label.toLowerCase(),
        rest: [(n.authors || ""), (n.venue || ""), areaNames, n.type, n.id].join(" ").toLowerCase()
      };
    });
    var activeResult = -1;
    var currentResults = [];

    function runSearch(q) {
      q = q.trim().toLowerCase();
      if (q.length < 2) { closeResults(); return; }
      var scored = [];
      searchIdx.forEach(function (s) {
        var sc = 0;
        if (s.label.indexOf(q) === 0) sc = 120;
        else if (s.label.indexOf(q) >= 0) sc = 80;
        else if (s.rest.indexOf(q) >= 0) sc = 40;
        if (sc) scored.push({ s: s, sc: sc + Math.min(s.n.deg, 20) });
      });
      scored.sort(function (a, b) { return b.sc - a.sc; });
      currentResults = scored.slice(0, 14).map(function (x) { return x.s.n; });
      paintResults();
    }
    function paintResults() {
      resultsEl.innerHTML = "";
      activeResult = -1;
      if (!currentResults.length) {
        var none = document.createElement("div");
        none.className = "sr-none";
        none.textContent = "No matches.";
        resultsEl.appendChild(none);
      } else {
        var groups = new Map();
        currentResults.forEach(function (n) {
          var g = TYPE_LABEL[n.type] || n.type;
          if (!groups.has(g)) groups.set(g, []);
          groups.get(g).push(n);
        });
        var idx = 0;
        groups.forEach(function (list, gname) {
          var h = document.createElement("div");
          h.className = "sr-group";
          h.textContent = gname;
          resultsEl.appendChild(h);
          list.forEach(function (n) {
            var o = document.createElement("div");
            o.className = "sr-item";
            o.setAttribute("role", "option");
            o.id = "sr-" + idx;
            o.dataset.idx = idx;
            o.dataset.node = n.id;
            var t = document.createElement("span");
            t.className = "sr-label";
            t.textContent = n.label;
            o.appendChild(t);
            var sub = document.createElement("span");
            sub.className = "sr-sub";
            sub.textContent = n.type === "paper"
              ? [firstAuthor(n.authors), n.year, n.venue].filter(Boolean).join(" · ")
              : (n.areas || []).slice(0, 3).map(function (a) {
                  return (areaById.get(a) || {}).label || a;
                }).join(" · ");
            o.appendChild(sub);
            o.addEventListener("mousedown", function (ev) {
              ev.preventDefault();
              chooseResult(n.id);
            });
            resultsEl.appendChild(o);
            idx++;
          });
        });
      }
      resultsEl.hidden = false;
      searchInput.setAttribute("aria-expanded", "true");
    }
    function closeResults() {
      resultsEl.hidden = true;
      searchInput.setAttribute("aria-expanded", "false");
      searchInput.removeAttribute("aria-activedescendant");
      activeResult = -1;
    }
    function chooseResult(id) {
      closeResults();
      searchInput.blur();
      selectNode(id, { fly: true });
    }
    searchInput.addEventListener("input", function () { runSearch(this.value); });
    searchInput.addEventListener("keydown", function (ev) {
      var items = resultsEl.querySelectorAll(".sr-item");
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        if (!items.length) return;
        ev.preventDefault();
        activeResult = ev.key === "ArrowDown"
          ? Math.min(activeResult + 1, items.length - 1)
          : Math.max(activeResult - 1, 0);
        items.forEach(function (elm, i) { elm.classList.toggle("active", i === activeResult); });
        searchInput.setAttribute("aria-activedescendant", "sr-" + activeResult);
        items[activeResult].scrollIntoView({ block: "nearest" });
      } else if (ev.key === "Enter") {
        if (activeResult >= 0 && items[activeResult]) chooseResult(items[activeResult].dataset.node);
        else if (items.length) chooseResult(items[0].dataset.node);
      } else if (ev.key === "Escape") {
        closeResults();
        this.blur();
      }
    });
    searchInput.addEventListener("blur", function () {
      setTimeout(closeResults, 120);
    });

    /* ---------- detail panel ---------- */

    var panel = $("lit-panel");
    var panelBody = $("lit-panel-body");

    var REL = {
      ADDRESSES: ["addresses", "addressed by"],
      BUILDS_ON: ["builds on", "built on by"],
      CITES: ["cites", "cited by"],
      COMPARES_WITH: ["compares with", "compared with"],
      CONTRADICTS: ["contradicts", "contradicted by"],
      COULD_VALIDATE: ["could validate", "could be validated by"],
      EVALUATES: ["evaluates", "evaluated by"],
      EXTENDS: ["extends", "extended by"],
      IDENTIFIES_LIMITATION_OF: ["identifies a limitation of", "limitation identified by"],
      INSPIRES: ["inspires", "inspired by"],
      INSTANCE_OF: ["instance of", "has instance"],
      INTRODUCES: ["introduces", "introduced by"],
      SUPPORTS: ["supports", "supported by"],
      SUPPORTS_TASK: ["supports task", "supported by"],
      USED_FOR: ["used for", "uses"],
      USES: ["uses", "used by"],
      USES_DATASET: ["uses dataset", "dataset used by"],
      USES_METRIC: ["uses metric", "metric used by"],
      VALIDATES: ["validates", "validated by"]
    };
    function relLabel(type, dir) {
      var r = REL[type];
      if (!r) return type.toLowerCase().replace(/_/g, " ");
      return dir === "out" ? r[0] : r[1];
    }

    function el(tag, cls, text) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }
    function section(title, cls) {
      var s = el("section", "p-section" + (cls ? " " + cls : ""));
      s.appendChild(el("h3", "p-h", title));
      return s;
    }

    function panelEmpty() {
      panelBody.innerHTML = "";
      panelBody.appendChild(el("p", "lit-panel-empty",
        "Select a node to read what it does, its findings and how it connects."));
      panel.classList.remove("open");
    }

    function renderPanel(n) {
      panelBody.innerHTML = "";

      var head = el("header", "p-head");
      head.appendChild(el("h2", "p-title", n.label));
      if (n.authors) head.appendChild(el("p", "p-authors", n.authors));
      var metaBits = [];
      if (n.year) metaBits.push(String(n.year));
      if (n.venue) metaBits.push(n.venue);
      if (metaBits.length) head.appendChild(el("p", "p-meta", metaBits.join(" · ")));
      var badges = el("p", "p-badges");
      if (n.type === "paper") {
        if (n.peerReviewed === true) badges.appendChild(el("span", "badge", "peer-reviewed"));
        else if (n.peerReviewed === false) badges.appendChild(el("span", "badge", "preprint"));
        else badges.appendChild(el("span", "badge", "unverified"));
      } else {
        badges.appendChild(el("span", "badge badge-type", n.type));
      }
      if (n.seed) badges.appendChild(el("span", "badge badge-seed", "seed"));
      if ((n.type === "gap" || n.type === "question") && n.priority)
        badges.appendChild(el("span", "badge badge-prio", n.priority + " priority"));
      head.appendChild(badges);
      if (n.url) {
        var link = el("p", "p-link");
        var a = el("a", null, n.url.replace(/^https?:\/\//, "").replace(/\/$/, ""));
        a.href = n.url; a.target = "_blank"; a.rel = "noopener";
        link.appendChild(a);
        head.appendChild(link);
      }
      panelBody.appendChild(head);

      if (n.summary) {
        var s1 = section("What it does");
        s1.appendChild(el("p", null, n.summary));
        panelBody.appendChild(s1);
      }

      if (n.areas && n.areas.length) {
        var s2 = section("Research areas");
        var chips = el("div", "p-chips");
        n.areas.forEach(function (aid) {
          var area = areaById.get(aid);
          if (!area) return;
          var b = el("button", "p-chip", area.label);
          b.type = "button";
          b.setAttribute("aria-label", "Highlight nodes in " + area.label);
          b.addEventListener("click", function () {
            pushHistory();
            state.mode = { area: aid };
            render();
            announce("Highlighting " + area.label + ".");
          });
          chips.appendChild(b);
        });
        s2.appendChild(chips);
        panelBody.appendChild(s2);
      }

      if (n.type === "paper") {
        var methods = [], datasets = [];
        adj.get(n.id).forEach(function (a) {
          var o = byId.get(a.other);
          if (o.type === "method" && methods.indexOf(o) < 0) methods.push(o);
          if (o.type === "dataset" && datasets.indexOf(o) < 0) datasets.push(o);
        });
        [["Methods", methods], ["Datasets", datasets]].forEach(function (pair) {
          if (!pair[1].length) return;
          var sx = section(pair[0]);
          var cw = el("div", "p-chips");
          pair[1].forEach(function (o) {
            var b = el("button", "p-chip", o.label);
            b.type = "button";
            b.addEventListener("click", function () { selectNode(o.id, { fly: true }); });
            cw.appendChild(b);
          });
          sx.appendChild(cw);
          panelBody.appendChild(sx);
        });
      }

      if (n.findings) {
        var s3 = section("Key findings");
        s3.appendChild(el("p", null, n.findings));
        panelBody.appendChild(s3);
      }
      if (n.limitations) {
        var s4 = section("Limitations");
        s4.appendChild(el("p", null, n.limitations));
        panelBody.appendChild(s4);
      }

      var conns = adj.get(n.id);
      if (conns.length) {
        var s5 = section("Connections");
        var groups = new Map();
        conns.forEach(function (a) {
          var key = relLabel(a.e.type, a.dir);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(a);
        });
        var shown = 0, LIMIT = 10, hiddenRows = [];
        groups.forEach(function (list, key) {
          var gEl = el("div", "p-conn-group");
          gEl.appendChild(el("h4", "p-conn-type", key));
          list.forEach(function (a) {
            var o = byId.get(a.other);
            var row = el("div", "p-conn");
            var b = el("button", "p-conn-target", o.label);
            b.type = "button";
            b.addEventListener("click", function () { selectNode(o.id, { fly: true }); });
            row.appendChild(b);
            if (a.e.explanation) row.appendChild(el("p", "p-conn-expl", a.e.explanation));
            if (a.e.evidence) row.appendChild(el("p", "p-conn-ev", a.e.evidence));
            shown++;
            if (shown > LIMIT) { row.classList.add("conn-hidden"); hiddenRows.push(row); }
            gEl.appendChild(row);
          });
          s5.appendChild(gEl);
        });
        if (hiddenRows.length) {
          var more = el("button", "p-more", hiddenRows.length + " more connections · show");
          more.type = "button";
          more.addEventListener("click", function () {
            hiddenRows.forEach(function (r) { r.classList.remove("conn-hidden"); });
            more.remove();
            /* reveal the corresponding nodes on the canvas too */
            conns.forEach(function (a) { state.revealed.add(a.other); });
            render();
          });
          s5.appendChild(more);
        }
        panelBody.appendChild(s5);
      }

      if (n.significance) {
        var s6 = section(n.type === "paper" ? "Why this paper matters" : "Why it matters");
        s6.appendChild(el("p", null, n.significance));
        panelBody.appendChild(s6);
      }

      if (n.application) {
        var s7 = section("Potential relevance to current research", "p-quiet");
        s7.appendChild(el("p", null, n.application));
        panelBody.appendChild(s7);
      }

      panel.classList.add("open");
      panel.focus({ preventScroll: true });
    }

    $("lit-panel-close").addEventListener("click", function () { clearSelection(); });

    /* ---------- boot ---------- */

    render();
    zoomFit(null, false);
    window.addEventListener("resize", function () {
      if (!state.trail.length && !state.mode) zoomFit(null, false);
    });
  }
})();
