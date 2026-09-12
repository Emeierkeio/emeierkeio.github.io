/* Literature Knowledge Graph Explorer.
   Vanilla JS + d3 v7 (global, loaded from CDN). No other dependencies.
   Sections: config · state · boot · visibility model · simulation ·
   rendering · interaction · context panel · filters · search · keyboard. */
(function () {
  "use strict";

  /* ================= config ================= */

  const DATA_URL = "../research/literature-graph.json";

  const TYPE_LABELS = {
    component: "Component",
    paper: "Paper",
    method: "Method",
    dataset: "Dataset",
    metric: "Metric",
    task: "Task",
    concept: "Concept",
    gap: "Gap",
    experiment: "Experiment",
    contribution: "Contribution",
    groundtruth: "Ground truth"
  };
  const GAPS_PRESET_TYPES = new Set(["gap", "experiment", "contribution"]);
  const ACCENT_EDGES = new Set(["FILLS_GAP", "TARGETS_COMPONENT", "COULD_VALIDATE"]);
  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ================= state ================= */

  const state = {
    nodes: [],
    edges: [],
    byId: new Map(),
    adj: new Map(),        // id -> Set of neighbor ids
    degree: new Map(),     // id -> degree in full graph
    componentIds: [],
    expanded: new Set(),   // ids whose neighbors are revealed
    pinned: new Set(),     // ids revealed via search / edge navigation
    visible: new Set(),
    parentOf: new Map(),   // newly revealed id -> revealer id (for warm-start positions)
    showAll: false,
    gapsMode: false,
    selected: null,
    history: [],
    filters: {
      types: new Set(),
      areas: new Set(),
      yearMin: 0,
      peerOnly: false,
      epistemics: new Set(["evidence", "interpretation", "recommendation"])
    },
    yearFloor: 0
  };

  const simCache = new Map(); // id -> persistent simulation node object

  /* d3 handles, assigned in initGraph */
  let svg, gRoot, gLinks, gNodes, zoom, sim;
  let nodeSel = null, linkSel = null;
  let stageEl, tooltipEl, panelEl;
  let pendingFit = false; /* re-fit once the force layout settles */

  /* ================= boot ================= */

  document.addEventListener("DOMContentLoaded", () => {
    stageEl = document.getElementById("lit-stage");
    tooltipEl = document.getElementById("lit-tooltip");
    panelEl = document.getElementById("lit-panel");

    fetch(DATA_URL)
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then((data) => {
        indexData(data);
        buildFilters();
        initGraph();
        initToolbar();
        initSearch();
        initKeyboard();
        refresh({ fit: true });
      })
      .catch((err) => {
        stageEl.querySelector("#lit-svg").remove();
        const div = document.createElement("div");
        div.className = "lit-error";
        div.innerHTML =
          "<p>Could not load the graph data (" + escapeHtml(String(err.message || err)) +
          ").</p><p>If you are previewing this page from the local filesystem, serve it over HTTP first, e.g. <code>python3 -m http.server</code> in the site root, then open <code>http://localhost:8000/literature/</code>.</p>";
        stageEl.appendChild(div);
      });
  });

  function indexData(data) {
    state.nodes = data.nodes;
    state.edges = data.edges.map((e, i) => Object.assign({ _i: i }, e));
    state.nodes.forEach((n) => {
      state.byId.set(n.id, n);
      state.adj.set(n.id, new Set());
      state.degree.set(n.id, 0);
    });
    state.edges.forEach((e) => {
      if (!state.byId.has(e.source) || !state.byId.has(e.target)) return;
      state.adj.get(e.source).add(e.target);
      state.adj.get(e.target).add(e.source);
      state.degree.set(e.source, state.degree.get(e.source) + 1);
      state.degree.set(e.target, state.degree.get(e.target) + 1);
    });
    state.componentIds = state.nodes.filter((n) => n.type === "component").map((n) => n.id);

    const years = state.nodes.map((n) => n.year).filter((y) => y != null);
    state.yearFloor = Math.min.apply(null, years);
    state.filters.yearMin = state.yearFloor;
    Object.keys(TYPE_LABELS).forEach((t) => state.filters.types.add(t));
    state.nodes.forEach((n) => state.filters.areas.add(n.area));

    document.querySelector(".lit-count-total").textContent = String(state.nodes.length);
  }

  /* ================= visibility model ================= */

  /* Progressive disclosure: the 8 components are always the anchor set.
     A node in `expanded` reveals its direct neighbors. `pinned` holds nodes
     revealed by search or edge navigation. Closure is recomputed from
     scratch so collapsing a branch cannot strand orphans. */
  function computeVisible() {
    const vis = new Set();
    state.parentOf = new Map();

    if (state.showAll) {
      state.nodes.forEach((n) => vis.add(n.id));
      state.visible = vis;
      return;
    }

    if (state.gapsMode) {
      state.nodes.forEach((n) => {
        if (GAPS_PRESET_TYPES.has(n.type)) {
          vis.add(n.id);
          state.adj.get(n.id).forEach((nb) => {
            if (!vis.has(nb)) state.parentOf.set(nb, n.id);
            vis.add(nb);
          });
        }
      });
      state.pinned.forEach((id) => vis.add(id));
      if (state.selected) vis.add(state.selected);
      state.visible = vis;
      return;
    }

    state.componentIds.forEach((id) => vis.add(id));
    state.pinned.forEach((id) => vis.add(id));
    if (state.selected) vis.add(state.selected);

    let grew = true;
    while (grew) {
      grew = false;
      for (const id of Array.from(vis)) {
        if (!state.expanded.has(id)) continue;
        for (const nb of state.adj.get(id)) {
          if (!vis.has(nb)) {
            vis.add(nb);
            state.parentOf.set(nb, id);
            grew = true;
          }
        }
      }
    }
    state.visible = vis;
  }

  function matchesFilters(n) {
    const f = state.filters;
    if (n.id === state.selected) return true; // never break the selected path
    if (!f.types.has(n.type)) return false;
    if (!f.areas.has(n.area)) return false;
    if (n.year != null && n.year < f.yearMin) return false;
    if (f.peerOnly && n.type === "paper" && n.peerReviewed !== true) return false;
    if (n.epistemics && !f.epistemics.has(n.epistemics)) return false;
    return true;
  }

  function hiddenNeighborCount(id) {
    if (state.showAll) return 0;
    let k = 0;
    state.adj.get(id).forEach((nb) => { if (!state.visible.has(nb)) k += 1; });
    return k;
  }

  /* ================= simulation ================= */

  function nodeRadius(n) {
    if (n.type === "component") return 16;
    if (n.type === "paper") {
      return Math.min(11, 4.5 + Math.sqrt(state.degree.get(n.id) || 1) * 1.1);
    }
    if (n.type === "gap" || n.type === "experiment" || n.type === "contribution") return 8;
    if (n.type === "dataset" || n.type === "groundtruth") return 7;
    return 6;
  }

  function linkDistance(l) {
    const s = l.source.data.type, t = l.target.data.type;
    if (s === "component" && t === "component") return 165;
    if (s === "component" || t === "component") return 95;
    return 58;
  }

  function initGraph() {
    svg = d3.select("#lit-svg");
    gRoot = svg.append("g").attr("class", "lit-root");
    gLinks = gRoot.append("g").attr("class", "lit-links");
    gNodes = gRoot.append("g").attr("class", "lit-nodes");

    zoom = d3.zoom()
      .scaleExtent([0.15, 4])
      .on("zoom", (event) => {
        gRoot.attr("transform", event.transform);
        svg.classed("labels-all", event.transform.k >= 1.25);
      });
    svg.call(zoom).on("dblclick.zoom", null);

    svg.on("click", (event) => {
      if (event.defaultPrevented) return;
      if (event.target === svg.node()) deselect();
    });

    sim = d3.forceSimulation()
      .force("link", d3.forceLink().id((d) => d.id).strength(0.45))
      .force("charge", d3.forceManyBody().strength(-190).distanceMax(420))
      .force("x", d3.forceX(0).strength(0.045))
      .force("y", d3.forceY(0).strength(0.055))
      .force("collide", d3.forceCollide()
        /* components carry always-visible labels: reserve room for them */
        .radius((d) => nodeRadius(d.data) + (d.data.type === "component" ? 24 : 7)))
      .on("tick", ticked)
      .on("end", () => {
        if (pendingFit) { pendingFit = false; fitView(true); }
      });
    sim.stop();
  }

  function simNode(id) {
    let s = simCache.get(id);
    if (!s) {
      s = { id: id, data: state.byId.get(id) };
      const parent = simCache.get(state.parentOf.get(id));
      const a = Math.random() * 2 * Math.PI;
      if (parent && parent.x != null) {
        s.x = parent.x + Math.cos(a) * 40;
        s.y = parent.y + Math.sin(a) * 40;
      } else {
        s.x = Math.cos(a) * 120;
        s.y = Math.sin(a) * 120;
      }
      simCache.set(id, s);
    }
    return s;
  }

  function restartSim(simNodes, simLinks) {
    sim.nodes(simNodes);
    sim.force("link").links(simLinks).distance(linkDistance);
    if (REDUCED) {
      /* render the settled layout without animation */
      sim.alpha(1);
      for (let i = 0; i < 300; i += 1) sim.tick();
      sim.stop();
      ticked();
    } else {
      sim.alpha(0.65).restart(); /* decays and freezes on its own */
    }
  }

  /* ================= rendering ================= */

  function refresh(opts) {
    computeVisible();

    const simNodes = Array.from(state.visible, simNode);
    const idSet = state.visible;
    const simLinks = state.edges
      .filter((e) => idSet.has(e.source) && idSet.has(e.target))
      .map((e) => ({ i: e._i, data: e, source: simCache.get(e.source), target: simCache.get(e.target) }));

    linkSel = gLinks.selectAll("line.lit-link")
      .data(simLinks, (d) => d.i)
      .join((enter) => enter.append("line")
        .attr("class", (d) => "lit-link edge-" + d.data.type.toLowerCase().replace(/_/g, "-")));

    nodeSel = gNodes.selectAll("g.lit-node")
      .data(simNodes, (d) => d.id)
      .join((enter) => {
        const g = enter.append("g")
          .attr("class", (d) => "lit-node t-" + d.data.type)
          .attr("tabindex", -1);
        g.each(function (d) { drawShape(d3.select(this), d.data); });
        g.append("text").attr("class", "lit-count");
        g.append("text")
          .attr("class", (d) => "lit-label" + (d.data.type === "component" ? " lit-label-comp" : ""))
          .attr("dy", (d) => nodeRadius(d.data) + 11)
          .text((d) => trimLabel(d.data.label));
        g.on("click", onNodeClick)
          .on("dblclick", onNodeDblClick)
          .on("mouseover", onNodeOver)
          .on("mousemove", onNodeMove)
          .on("mouseout", onNodeOut);
        return g;
      });

    nodeSel.select("text.lit-count")
      .attr("x", (d) => nodeRadius(d.data) + 1)
      .attr("y", (d) => -nodeRadius(d.data) - 1)
      .text((d) => {
        const k = hiddenNeighborCount(d.id);
        return k > 0 ? "+" + k : "";
      });

    updateClasses();
    updateStatus();
    restartSim(simNodes, simLinks);
    if (opts && opts.fit) {
      fitView(!REDUCED);
      if (!REDUCED) pendingFit = true;
    }
  }

  function drawShape(g, n) {
    const r = nodeRadius(n);
    if (n.seed) g.append("circle").attr("class", "lit-ring").attr("r", r + 3.5);
    if (n.type === "dataset" || n.type === "groundtruth") {
      g.insert("rect", ".lit-ring")
        .attr("class", "shape")
        .attr("x", -r).attr("y", -r).attr("width", 2 * r).attr("height", 2 * r);
    } else if (n.type === "experiment" || n.type === "contribution") {
      g.insert("path", ".lit-ring")
        .attr("class", "shape")
        .attr("d", "M0," + (-r) + " L" + r + ",0 L0," + r + " L" + (-r) + ",0 Z");
    } else {
      g.insert("circle", ".lit-ring").attr("class", "shape").attr("r", r);
    }
  }

  function trimLabel(label) {
    return label.length > 34 ? label.slice(0, 32) + "…" : label;
  }

  function ticked() {
    if (linkSel) {
      linkSel
        .attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x).attr("y2", (d) => d.target.y);
    }
    if (nodeSel) {
      nodeSel.attr("transform", (d) => "translate(" + d.x + "," + d.y + ")");
    }
  }

  function updateClasses() {
    const sel = state.selected;
    const selNbs = sel ? state.adj.get(sel) : null;
    svg.classed("has-sel", !!sel);
    nodeSel
      .classed("is-dimmed", (d) => !matchesFilters(d.data))
      .classed("is-selected", (d) => d.id === sel)
      .classed("is-sel-nb", (d) => !!selNbs && selNbs.has(d.id));
    linkSel
      .classed("is-dimmed", (d) => !matchesFilters(d.source.data) || !matchesFilters(d.target.data))
      .classed("is-sel-link", (d) => !!sel && (d.data.source === sel || d.data.target === sel));
  }

  function updateStatus() {
    const shown = state.visible.size;
    let match = 0;
    state.nodes.forEach((n) => { if (matchesFilters(n)) match += 1; });
    document.getElementById("lit-status").textContent =
      shown + " shown · " + match + "/" + state.nodes.length + " match filters";
  }

  /* ================= zoom helpers ================= */

  function stageSize() {
    const b = stageEl.getBoundingClientRect();
    return [b.width, b.height];
  }

  function fitView(animate) {
    const nodes = sim.nodes();
    if (!nodes.length) return;
    const [w, h] = stageSize();
    const xs = nodes.map((d) => d.x), ys = nodes.map((d) => d.y);
    const x0 = Math.min.apply(null, xs) - 40, x1 = Math.max.apply(null, xs) + 40;
    const y0 = Math.min.apply(null, ys) - 40, y1 = Math.max.apply(null, ys) + 40;
    const k = Math.min(1.6, w / (x1 - x0), h / (y1 - y0));
    const t = d3.zoomIdentity
      .translate(w / 2 - k * (x0 + x1) / 2, h / 2 - k * (y0 + y1) / 2)
      .scale(k);
    (animate ? svg.transition().duration(350) : svg).call(zoom.transform, t);
  }

  function centerOn(id) {
    const s = simCache.get(id);
    if (!s) return;
    const [w, h] = stageSize();
    const k = Math.max(d3.zoomTransform(svg.node()).k, 0.9);
    const t = d3.zoomIdentity.translate(w / 2 - k * s.x, h / 2 - k * s.y).scale(k);
    (REDUCED ? svg : svg.transition().duration(350)).call(zoom.transform, t);
  }

  /* ================= interaction ================= */

  function onNodeClick(event, d) {
    event.stopPropagation();
    selectNode(d.id, { push: true, center: false });
  }

  function onNodeDblClick(event, d) {
    event.stopPropagation();
    collapseNode(d.id);
  }

  function onNodeOver(event, d) {
    svg.classed("has-hover", true);
    const nbs = state.adj.get(d.id);
    nodeSel.classed("is-hot", (o) => o.id === d.id || nbs.has(o.id));
    linkSel.classed("is-hot", (o) => o.data.source === d.id || o.data.target === d.id);
    tooltipEl.innerHTML =
      "<span class='tt-type'>" + escapeHtml(TYPE_LABELS[d.data.type] || d.data.type) +
      "</span><br>" + escapeHtml(d.data.label);
    tooltipEl.hidden = false;
    onNodeMove(event);
  }

  function onNodeMove(event) {
    const b = stageEl.getBoundingClientRect();
    let x = event.clientX - b.left + 14;
    let y = event.clientY - b.top + 10;
    if (x + 260 > b.width) x -= 280;
    if (y + 60 > b.height) y -= 70;
    tooltipEl.style.left = x + "px";
    tooltipEl.style.top = y + "px";
  }

  function onNodeOut() {
    svg.classed("has-hover", false);
    nodeSel.classed("is-hot", false);
    linkSel.classed("is-hot", false);
    tooltipEl.hidden = true;
  }

  function selectNode(id, opts) {
    opts = opts || {};
    if (opts.push && state.selected && state.selected !== id) {
      state.history.push(state.selected);
    }
    state.selected = id;
    state.pinned.add(id);
    state.expanded.add(id); /* click = select + expand */
    refresh();
    renderPanel(id);
    panelEl.classList.add("open");
    if (opts.center) centerOn(id);
  }

  function collapseNode(id) {
    state.expanded.delete(id);
    refresh();
    if (state.selected === id) renderPanel(id);
  }

  function deselect() {
    if (!state.selected) return;
    state.selected = null;
    refresh();
    renderPanelEmpty();
    panelEl.classList.remove("open");
  }

  function resetAll() {
    state.expanded.clear();
    state.pinned.clear();
    state.history = [];
    state.selected = null;
    state.showAll = false;
    state.gapsMode = false;
    state.filters.types = new Set(Object.keys(TYPE_LABELS));
    state.filters.areas = new Set(state.nodes.map((n) => n.area));
    state.filters.yearMin = state.yearFloor;
    state.filters.peerOnly = false;
    state.filters.epistemics = new Set(["evidence", "interpretation", "recommendation"]);
    syncControls();
    renderPanelEmpty();
    panelEl.classList.remove("open");
    refresh({ fit: true });
  }

  function syncControls() {
    document.getElementById("lit-showall").checked = state.showAll;
    document.getElementById("lit-gaps").setAttribute("aria-pressed", String(state.gapsMode));
    document.getElementById("lit-peer").checked = state.filters.peerOnly;
    const yr = document.getElementById("lit-year");
    yr.value = String(state.filters.yearMin);
    document.getElementById("lit-year-out").textContent = String(state.filters.yearMin);
    document.querySelectorAll("#lit-filter-types input").forEach((cb) => {
      cb.checked = state.filters.types.has(cb.value);
    });
    document.querySelectorAll("#lit-filter-areas input").forEach((cb) => {
      cb.checked = state.filters.areas.has(cb.value);
    });
    document.querySelectorAll("#lit-filter-epistemics input").forEach((cb) => {
      cb.checked = state.filters.epistemics.has(cb.value);
    });
  }

  /* ================= context panel ================= */

  function renderPanelEmpty() {
    const body = document.getElementById("lit-panel-body");
    body.innerHTML = "";
    const p = document.createElement("p");
    p.className = "lit-panel-empty";
    p.textContent = "Select a node to see its details: summary, why it matters for ParliamentRAG, and its connections.";
    body.appendChild(p);
    document.getElementById("lit-back").disabled = state.history.length === 0;
    document.getElementById("lit-collapse").disabled = true;
  }

  function renderPanel(id) {
    const n = state.byId.get(id);
    const body = document.getElementById("lit-panel-body");
    body.innerHTML = "";

    const h = document.createElement("h2");
    h.textContent = n.label;
    body.appendChild(h);

    const badges = document.createElement("div");
    badges.className = "lit-badges";
    badges.appendChild(badge(TYPE_LABELS[n.type] || n.type, "b-type"));
    badges.appendChild(badge(n.area));
    if (n.year != null) badges.appendChild(badge(String(n.year)));
    if (n.type === "paper") {
      if (n.peerReviewed === true) badges.appendChild(badge("peer-reviewed", "b-peer-yes"));
      else if (n.peerReviewed === false) badges.appendChild(badge("preprint", "b-peer-no"));
      else badges.appendChild(badge("unverified", "b-peer-null"));
    }
    if (n.epistemics) badges.appendChild(badge(n.epistemics, "b-ep-" + n.epistemics));
    if (n.priority) badges.appendChild(badge("priority: " + n.priority));
    if (n.seed) badges.appendChild(badge("seed"));
    body.appendChild(badges);

    if (n.venue) {
      const v = document.createElement("p");
      v.className = "lit-venue";
      v.textContent = n.venue;
      body.appendChild(v);
    }

    if (n.summary) {
      const s = document.createElement("p");
      s.className = "lit-summary";
      s.textContent = n.summary;
      body.appendChild(s);
    }

    if (n.relevance) {
      const wh = document.createElement("p");
      wh.className = "lit-why-h";
      wh.textContent = "Why it matters for ParliamentRAG";
      body.appendChild(wh);
      const w = document.createElement("p");
      w.className = "lit-why";
      w.textContent = n.relevance;
      body.appendChild(w);
    }

    if (n.url) {
      const p = document.createElement("p");
      p.className = "lit-url";
      const a = document.createElement("a");
      a.href = n.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Source ↗";
      p.appendChild(a);
      body.appendChild(p);
    }

    /* edges grouped by type */
    const groups = new Map();
    state.edges.forEach((e) => {
      if (e.source !== id && e.target !== id) return;
      if (!groups.has(e.type)) groups.set(e.type, []);
      groups.get(e.type).push(e);
    });
    const wrap = document.createElement("div");
    wrap.className = "lit-edges";
    Array.from(groups.keys()).sort().forEach((type) => {
      const h3 = document.createElement("h3");
      h3.textContent = humanizeEdge(type) + " (" + groups.get(type).length + ")";
      wrap.appendChild(h3);
      groups.get(type).forEach((e) => {
        const otherId = e.source === id ? e.target : e.source;
        const other = state.byId.get(otherId);
        if (!other) return;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "lit-edge-item";
        btn.setAttribute("aria-label", "Go to " + other.label);
        const dir = document.createElement("span");
        dir.className = "lit-edge-dir";
        dir.textContent = e.source === id ? "→ " : "← ";
        const tgt = document.createElement("span");
        tgt.className = "lit-edge-target";
        tgt.textContent = other.label;
        btn.appendChild(dir);
        btn.appendChild(tgt);
        if (e.explanation) {
          const ex = document.createElement("span");
          ex.className = "lit-edge-expl";
          ex.textContent = e.explanation;
          btn.appendChild(ex);
        }
        btn.addEventListener("click", () => {
          selectNode(otherId, { push: true, center: true });
        });
        wrap.appendChild(btn);
      });
    });
    body.appendChild(wrap);

    document.getElementById("lit-back").disabled = state.history.length === 0;
    document.getElementById("lit-collapse").disabled = !state.expanded.has(id);
    body.scrollTop = 0;
  }

  function badge(text, cls) {
    const s = document.createElement("span");
    s.className = "lit-badge" + (cls ? " " + cls : "");
    s.textContent = text;
    return s;
  }

  function humanizeEdge(type) {
    const t = type.toLowerCase().replace(/_/g, " ");
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  /* ================= toolbar ================= */

  function initToolbar() {
    document.getElementById("lit-back").addEventListener("click", () => {
      const prev = state.history.pop();
      if (prev) selectNode(prev, { push: false, center: true });
    });
    document.getElementById("lit-collapse").addEventListener("click", () => {
      if (state.selected) collapseNode(state.selected);
    });
    document.getElementById("lit-panel-close").addEventListener("click", () => {
      panelEl.classList.remove("open");
    });
    document.getElementById("lit-reset").addEventListener("click", resetAll);

    document.getElementById("lit-showall").addEventListener("change", (e) => {
      state.showAll = e.target.checked;
      if (state.showAll) {
        state.gapsMode = false;
        document.getElementById("lit-gaps").setAttribute("aria-pressed", "false");
      }
      refresh({ fit: true });
    });

    document.getElementById("lit-gaps").addEventListener("click", (e) => {
      state.gapsMode = !state.gapsMode;
      e.currentTarget.setAttribute("aria-pressed", String(state.gapsMode));
      if (state.gapsMode) {
        state.showAll = false;
        document.getElementById("lit-showall").checked = false;
      }
      refresh({ fit: true });
    });

    const filtersEl = document.getElementById("lit-filters");
    document.getElementById("lit-filters-toggle").addEventListener("click", (e) => {
      const open = filtersEl.classList.toggle("open");
      e.currentTarget.setAttribute("aria-expanded", String(open));
    });

    document.getElementById("lit-zoom-in").addEventListener("click", () => {
      svg.transition().duration(200).call(zoom.scaleBy, 1.4);
    });
    document.getElementById("lit-zoom-out").addEventListener("click", () => {
      svg.transition().duration(200).call(zoom.scaleBy, 1 / 1.4);
    });
    document.getElementById("lit-zoom-fit").addEventListener("click", () => fitView(!REDUCED));
  }

  /* ================= filters ================= */

  function buildFilters() {
    const typeCounts = new Map(), areaCounts = new Map();
    state.nodes.forEach((n) => {
      typeCounts.set(n.type, (typeCounts.get(n.type) || 0) + 1);
      areaCounts.set(n.area, (areaCounts.get(n.area) || 0) + 1);
    });

    const typesHost = document.getElementById("lit-filter-types");
    Object.keys(TYPE_LABELS).forEach((t) => {
      if (!typeCounts.has(t)) return;
      typesHost.appendChild(checkbox(t, TYPE_LABELS[t], typeCounts.get(t), (val, on) => {
        if (on) state.filters.types.add(val); else state.filters.types.delete(val);
        onFilterChange();
      }));
    });

    const areasHost = document.getElementById("lit-filter-areas");
    Array.from(areaCounts.keys()).sort().forEach((a) => {
      areasHost.appendChild(checkbox(a, a, areaCounts.get(a), (val, on) => {
        if (on) state.filters.areas.add(val); else state.filters.areas.delete(val);
        onFilterChange();
      }));
    });

    const epHost = document.getElementById("lit-filter-epistemics");
    ["evidence", "interpretation", "recommendation"].forEach((ep) => {
      const count = state.nodes.filter((n) => n.epistemics === ep).length;
      epHost.appendChild(checkbox(ep, ep, count, (val, on) => {
        if (on) state.filters.epistemics.add(val); else state.filters.epistemics.delete(val);
        onFilterChange();
      }));
    });

    const years = state.nodes.map((n) => n.year).filter((y) => y != null);
    const yr = document.getElementById("lit-year");
    yr.min = String(Math.min.apply(null, years));
    yr.max = String(Math.max.apply(null, years));
    yr.value = yr.min;
    document.getElementById("lit-year-out").textContent = yr.min;
    yr.addEventListener("input", () => {
      state.filters.yearMin = Number(yr.value);
      document.getElementById("lit-year-out").textContent = yr.value;
      onFilterChange();
    });

    document.getElementById("lit-peer").addEventListener("change", (e) => {
      state.filters.peerOnly = e.target.checked;
      onFilterChange();
    });
  }

  function checkbox(value, label, count, onChange) {
    const lab = document.createElement("label");
    lab.className = "lit-check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = true;
    input.value = value;
    input.addEventListener("change", () => onChange(value, input.checked));
    lab.appendChild(input);
    lab.appendChild(document.createTextNode(" " + label + " "));
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = String(count);
    lab.appendChild(n);
    return lab;
  }

  function onFilterChange() {
    /* filters only dim; visibility set is unchanged, so no sim restart */
    updateClasses();
    updateStatus();
  }

  /* ================= search ================= */

  function initSearch() {
    const input = document.getElementById("lit-search");
    const list = document.getElementById("lit-search-results");

    function close() {
      list.hidden = true;
      list.innerHTML = "";
      input.setAttribute("aria-expanded", "false");
    }

    function run() {
      const q = input.value.trim().toLowerCase();
      list.innerHTML = "";
      if (q.length < 2) { close(); return; }
      const hits = state.nodes.filter((n) => {
        return n.label.toLowerCase().includes(q) ||
          (n.venue && n.venue.toLowerCase().includes(q));
      }).slice(0, 9);
      if (!hits.length) {
        const d = document.createElement("div");
        d.className = "lit-search-empty";
        d.textContent = "No matching nodes.";
        list.appendChild(d);
      } else {
        hits.forEach((n) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "lit-search-item";
          btn.setAttribute("role", "option");
          btn.textContent = n.label;
          const meta = document.createElement("span");
          meta.className = "meta";
          meta.textContent = (TYPE_LABELS[n.type] || n.type) +
            (n.year ? " · " + n.year : "") + (n.venue ? " · " + n.venue : "");
          btn.appendChild(meta);
          btn.addEventListener("click", () => {
            close();
            input.value = "";
            selectNode(n.id, { push: true, center: true });
          });
          list.appendChild(btn);
        });
      }
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
    }

    input.addEventListener("input", run);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { close(); input.blur(); }
      if (e.key === "ArrowDown") {
        const first = list.querySelector(".lit-search-item");
        if (first) { first.focus(); e.preventDefault(); }
      }
      if (e.key === "Enter") {
        const first = list.querySelector(".lit-search-item");
        if (first) first.click();
      }
    });
    list.addEventListener("keydown", (e) => {
      const items = Array.from(list.querySelectorAll(".lit-search-item"));
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown" && i < items.length - 1) { items[i + 1].focus(); e.preventDefault(); }
      if (e.key === "ArrowUp") {
        if (i > 0) items[i - 1].focus(); else input.focus();
        e.preventDefault();
      }
      if (e.key === "Escape") { close(); input.focus(); }
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".lit-search-wrap")) close();
    });
  }

  /* ================= keyboard ================= */

  function initKeyboard() {
    document.addEventListener("keydown", (e) => {
      const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (e.key === "Escape" && !inField) deselect();
      if (e.key === "/" && !inField) {
        e.preventDefault();
        document.getElementById("lit-search").focus();
      }
    });
  }

  /* ================= util ================= */

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }
}());
