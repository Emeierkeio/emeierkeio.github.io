/* Literature map — view-state machine over a research knowledge graph.
   Views: overview (full organic network) · area · node neighborhood · gaps.
   The full graph stays in memory; the stage renders only what the view needs. */
(function () {
"use strict";

/* ---------------------------------------------------------------- helpers */

function $(id) { return document.getElementById(id); }

var REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
var FADE = REDUCED ? 0 : 220;

var measureCtx = document.createElement("canvas").getContext("2d");
function textW(s, font) {
  measureCtx.font = font;
  return measureCtx.measureText(String(s == null ? "" : s)).width * 1.06;
}
var F_SERIF = '11px Newsreader, Georgia, serif';
var F_SANS = '11px Geist, -apple-system, sans-serif';
var F_AREA = '13.5px Geist, -apple-system, sans-serif';
var F_AREA_SM = '11px Geist, -apple-system, sans-serif';
var F_MONO = '10.5px ui-monospace, Menlo, monospace';

var NARROW_W = 560;
function isNarrow(W) { return W < NARROW_W; }
function areaFont(W) { return isNarrow(W) ? F_AREA_SM : F_AREA; }
function areaText(a, W) {
  if (!isNarrow(W) || a.label.length <= 18) return a.label;
  return a.label.slice(0, 17).replace(/\s+$/, "") + "…";
}

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

/* deterministic small jitter from a string id */
function hashJitter(s) {
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 8) % 1000) / 1000 - 0.5;
}

/* ------------------------------------------------------------ vocabulary */

var REL = {
  INTRODUCES: ["introduces", "introduced by"],
  USES: ["uses", "used by"],
  SUPPORTS: ["supports", "supported by"],
  INSPIRES: ["informs", "informed by"],
  USES_METRIC: ["uses metric", "metric used by"],
  EXTENDS: ["extends", "extended by"],
  USES_DATASET: ["uses dataset", "dataset used by"],
  BUILDS_ON: ["builds on", "built on by"],
  COMPARES_WITH: ["compares with", "compared with"],
  CITES: ["cites", "cited by"],
  IDENTIFIES_LIMITATION_OF: ["finds limits of", "limits found by"],
  ADDRESSES: ["addresses", "addressed by"],
  VALIDATES: ["validates", "validated by"],
  EVALUATES: ["evaluates", "evaluated by"],
  COULD_VALIDATE: ["could validate", "could be validated by"],
  CONTRADICTS: ["contradicts", "contradicted by"],
  USED_FOR: ["used for", "approached with"],
  INSTANCE_OF: ["instance of", "instantiated by"],
  SUPPORTS_TASK: ["supports task", "supported by"]
};
function relPhrase(type, dir) {
  var p = REL[type] || [String(type).toLowerCase().replace(/_/g, " "),
                        String(type).toLowerCase().replace(/_/g, " ")];
  return dir === "in" ? p[1] : p[0];
}

var ROLE_RANK = { foundational: 0, benchmark: 1, dataset: 2, review: 3, method: 4, application: 5 };

function paperRadius(n) {
  if (n.type !== "paper") return 4.5;
  if (n.role === "foundational") return 6.5;
  if (n.role === "benchmark" || n.role === "dataset") return 5.4;
  return 4.4;
}

function nodeImportance(n, degree) {
  var s = degree.get(n.id) || 0;
  if (n.type === "paper") s += 20 - 3 * (ROLE_RANK[n.role] != null ? ROLE_RANK[n.role] : 5);
  if (n.seed) s += 8;
  if (n.priority === "high") s += 10; else if (n.priority === "medium") s += 5;
  return s;
}

function typeGroup(t) {
  if (t === "concept" || t === "metric" || t === "task") return "concept";
  if (t === "gap" || t === "question") return "gap";
  if (t === "project") return "paper";
  return t; // paper, method, dataset
}
var TYPE_GROUP_LABELS = {
  paper: "Papers", method: "Methods", dataset: "Datasets",
  concept: "Concepts & metrics", gap: "Gaps & questions"
};

/* ------------------------------------------------------------------ state */

var G = null; // graph model
var S = {
  view: "overview",       // overview | area | node | gaps
  areaId: null,
  nodeId: null,
  trail: [],              // stack of previous {view, areaId, nodeId}
  expandedId: null,       // neighbor with a visible second ring
  panelOpen: window.innerWidth > 768,
  filters: { types: null, area: "", yearMin: null, yearMax: null, review: "all" }
};

var svg = d3.select("#lit-svg");
var zoomRoot = svg.append("g").attr("class", "zoomroot");
var zoom = d3.zoom().scaleExtent([0.4, 4]).on("zoom", function (ev) {
  zoomRoot.attr("transform", ev.transform);
});
svg.call(zoom).on("dblclick.zoom", null);

var layoutCache = {}; // area anchor layouts keyed by stage size

/* ------------------------------------------------------------- data model */

function buildModel(data) {
  var nodesById = new Map();
  data.nodes.forEach(function (n) { nodesById.set(n.id, n); });
  var edges = data.edges.filter(function (e) {
    return nodesById.has(e.source) && nodesById.has(e.target);
  });
  var neighbors = new Map();
  var degree = new Map();
  edges.forEach(function (e) {
    if (!neighbors.has(e.source)) neighbors.set(e.source, []);
    if (!neighbors.has(e.target)) neighbors.set(e.target, []);
    neighbors.get(e.source).push({ edge: e, other: e.target, dir: "out" });
    neighbors.get(e.target).push({ edge: e, other: e.source, dir: "in" });
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  });

  var areas = (data.areas || []).map(function (a) {
    return Object.assign({}, a, {
      representatives: (a.representatives || []).filter(function (id) { return nodesById.has(id); })
    });
  });
  var areasById = new Map();
  areas.forEach(function (a) { areasById.set(a.id, a); });

  // co-membership between area pairs
  var co = new Map();
  data.nodes.forEach(function (n) {
    var as = (n.areas || []).filter(function (id) { return areasById.has(id); });
    for (var i = 0; i < as.length; i++) for (var j = i + 1; j < as.length; j++) {
      var k = [as[i], as[j]].sort().join("|");
      co.set(k, (co.get(k) || 0) + 1);
    }
  });
  var pairSeen = new Set(), pairs = [];
  areas.forEach(function (a) {
    (a.adjacent || []).forEach(function (b) {
      if (!areasById.has(b)) return;
      var k = [a.id, b].sort().join("|");
      if (pairSeen.has(k)) return;
      pairSeen.add(k);
      var mutual = (areasById.get(b).adjacent || []).indexOf(a.id) >= 0;
      pairs.push({ a: k.split("|")[0], b: k.split("|")[1], co: co.get(k) || 0, mutual: mutual });
    });
  });

  // representative -> areas that curate it
  var repAreas = new Map();
  areas.forEach(function (a) {
    a.representatives.forEach(function (id) {
      if (!repAreas.has(id)) repAreas.set(id, []);
      repAreas.get(id).push(a.id);
    });
  });

  return {
    nodes: data.nodes, edges: edges, areas: areas,
    nodesById: nodesById, areasById: areasById,
    neighbors: neighbors, degree: degree,
    areaPairs: pairs, repAreas: repAreas
  };
}

/* ---------------------------------------------------------------- filters */

function passes(n) {
  var f = S.filters;
  if (f.types && !f.types.has(typeGroup(n.type))) return false;
  if (f.area && (!n.areas || n.areas.indexOf(f.area) < 0)) return false;
  if (f.yearMin != null && n.year != null && n.year < f.yearMin) return false;
  if (f.yearMax != null && n.year != null && n.year > f.yearMax) return false;
  if ((f.yearMin != null || f.yearMax != null) && n.year == null && n.type === "paper") return false;
  if (f.review !== "all" && n.type === "paper") {
    if (f.review === "peer" && n.peerReviewed !== true) return false;
    if (f.review === "preprint" && n.peerReviewed === true) return false;
  }
  return true;
}
function filtersActive() {
  var f = S.filters;
  return !!(f.types || f.area || f.yearMin != null || f.yearMax != null || f.review !== "all");
}

/* ------------------------------------------------------------- navigation */

function sameDesc(a, b) {
  return a.view === b.view && a.areaId === b.areaId && a.nodeId === b.nodeId;
}
function currentDesc() { return { view: S.view, areaId: S.areaId, nodeId: S.nodeId }; }
function applyDesc(d) { S.view = d.view; S.areaId = d.areaId || null; S.nodeId = d.nodeId || null; }

function navigate(desc) {
  if (sameDesc(desc, currentDesc())) return;
  S.trail.push(currentDesc());
  if (S.trail.length > 24) S.trail.shift();
  applyDesc(desc);
  render();
}
function goBack() {
  var d = S.trail.pop();
  if (!d) return;
  applyDesc(d);
  render();
}
function goTrail(i) {
  var d = S.trail[i];
  if (!d) return;
  S.trail = S.trail.slice(0, i);
  applyDesc(d);
  render();
}
function gotoOverview() { navigate({ view: "overview", areaId: null, nodeId: null }); }
function gotoArea(id) { navigate({ view: "area", areaId: id, nodeId: null }); }
function gotoNode(id) {
  navigate({ view: "node", nodeId: id, areaId: S.areaId });
}

/* ------------------------------------------------------------ label logic */

function occlude(items) {
  // items: {x (center), y (top), w, h, pri}; greedy keep in priority order
  var kept = [];
  items.slice().sort(function (a, b) { return b.pri - a.pri; }).forEach(function (it) {
    var hit = kept.some(function (b) {
      return !(it.x + it.w / 2 < b.x - b.w / 2 || it.x - it.w / 2 > b.x + b.w / 2 ||
               it.y + it.h < b.y || it.y > b.y + b.h);
    });
    it.visible = !hit;
    if (!hit) kept.push(it);
  });
}

function shortLabel(n) { return n.short || n.label || n.id; }

/* horizontal shift keeping a centered label inside the stage */
function edgeShift(x, w, W) {
  var lo = x - w / 2, hi = x + w / 2;
  if (lo < 8) return 8 - lo;
  if (hi > W - 8) return (W - 8) - hi;
  return 0;
}

/* ----------------------------------------------------------- node drawing */

function drawShape(g, n, scale) {
  var k = scale || 1;
  if (n.type === "paper") {
    var r = paperRadius(n) * k;
    if (n.seed) g.append("circle").attr("class", "seed-ring").attr("r", r + 3);
    g.append("circle").attr("class", "shape sh-paper").attr("r", r);
  } else if (n.type === "method") {
    g.append("circle").attr("class", "shape sh-method").attr("r", 4.6 * k);
  } else if (n.type === "dataset") {
    var s = 8.4 * k;
    g.append("rect").attr("class", "shape sh-dataset")
      .attr("x", -s / 2).attr("y", -s / 2).attr("width", s).attr("height", s);
  } else if (n.type === "project") {
    var sp = 8.4 * k;
    g.append("rect").attr("class", "shape sh-project")
      .attr("x", -sp / 2).attr("y", -sp / 2).attr("width", sp).attr("height", sp);
  } else if (n.type === "gap") {
    g.append("circle").attr("class", "shape sh-gap").attr("r", 5.4 * k);
  } else if (n.type === "question") {
    g.append("circle").attr("class", "shape sh-question").attr("r", 5.4 * k);
  } else { // concept, metric, task
    g.append("circle").attr("class", "shape sh-concept").attr("r", 2.4 * k);
  }
}

function labelClass(n) {
  if (n.type === "paper") return "nlabel nlabel-serif";
  if (n.type === "concept" || n.type === "metric" || n.type === "task") return "nlabel nlabel-mono";
  return "nlabel nlabel-sans";
}
function labelFont(n) {
  if (n.type === "paper") return F_SERIF;
  if (n.type === "concept" || n.type === "metric" || n.type === "task") return F_MONO;
  return F_SANS;
}

function nodeGroup(parent, n, x, y, scale) {
  var g = parent.append("g")
    .attr("class", "node t-" + n.type)
    .attr("data-id", n.id)
    .attr("transform", "translate(" + x + "," + y + ")")
    .attr("tabindex", 0)
    .attr("role", "button")
    .attr("aria-label", (n.label || n.id) + ", " + n.type);
  g.append("circle").attr("class", "hit").attr("r", 13 * (scale || 1));
  drawShape(g, n, scale);
  g.on("click", function (ev) { ev.stopPropagation(); gotoNode(n.id); })
   .on("keydown", function (ev) {
     if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); gotoNode(n.id); }
   })
   .on("mouseenter", function (ev) {
     showTip(ev, (n.label || n.id), n.type + (n.year ? " · " + n.year : ""));
   })
   .on("mousemove", moveTip)
   .on("mouseleave", hideTip);
  return g;
}

/* ---------------------------------------------------------------- tooltip */

var tipEl = $("lit-tooltip");
function showTip(ev, title, sub) {
  tipEl.innerHTML = "";
  tipEl.appendChild(el("strong", null, title));
  if (sub) tipEl.appendChild(el("span", null, sub));
  tipEl.hidden = false;
  moveTip(ev);
}
function moveTip(ev) {
  if (tipEl.hidden) return;
  var r = $("lit-stage").getBoundingClientRect();
  var x = ev.clientX - r.left + 14, y = ev.clientY - r.top + 10;
  if (x + tipEl.offsetWidth > r.width - 8) x = ev.clientX - r.left - tipEl.offsetWidth - 10;
  if (y + tipEl.offsetHeight > r.height - 8) y = ev.clientY - r.top - tipEl.offsetHeight - 8;
  tipEl.style.left = x + "px";
  tipEl.style.top = y + "px";
}
function hideTip() { tipEl.hidden = true; }

/* ---------------------------------------------------------------- layouts */

function stageSize() {
  var r = $("lit-stage").getBoundingClientRect();
  return { W: Math.max(320, r.width), H: Math.max(360, r.height) };
}

function fitPositions(pts, W, H, pad) {
  if (!pts.length) return;
  var xs = pts.map(function (p) { return p.x; }), ys = pts.map(function (p) { return p.y; });
  var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
  var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
  var sx = (W - 2 * pad) / Math.max(1, x1 - x0), sy = (H - 2 * pad) / Math.max(1, y1 - y0);
  pts.forEach(function (p) {
    p.x = pad + (p.x - x0) * sx;
    p.y = pad + (p.y - y0) * sy;
  });
}

function computeAreaLayout(W, H) {
  var key = "areas|" + Math.round(W) + "x" + Math.round(H);
  if (layoutCache[key]) return layoutCache[key];
  var nodes = G.areas.map(function (a, i) {
    var ang = (i / Math.max(1, G.areas.length)) * 2 * Math.PI;
    return { id: a.id, area: a, x: Math.cos(ang) * 320, y: Math.sin(ang) * 220 };
  });
  var links = G.areaPairs.map(function (p) {
    return { source: p.a, target: p.b, co: p.co, mutual: p.mutual };
  });
  var sim = d3.forceSimulation(nodes)
    .force("charge", d3.forceManyBody().strength(-1050))
    .force("link", d3.forceLink(links).id(function (d) { return d.id; })
      .distance(function (l) { return 235 - Math.min(70, l.co * 4); })
      .strength(function (l) { return l.mutual ? 0.5 : 0.16; }))
    .force("x", d3.forceX(0).strength(0.055))
    .force("y", d3.forceY(0).strength(0.11))
    .force("collide", d3.forceCollide(function (d) {
      return textW(areaText(d.area, W), areaFont(W)) / 2 + (isNarrow(W) ? 20 : 30);
    }).strength(0.9))
    .stop();
  for (var i = 0; i < 340; i++) sim.tick();
  fitPositions(nodes, W, H, 78);
  var pos = new Map();
  nodes.forEach(function (n) { pos.set(n.id, { x: n.x, y: n.y }); });
  layoutCache[key] = pos;
  return pos;
}

/* Full organic network layout for the overview: every node attracted to the
   mean of its areas' anchors + real-edge links + collision, settled once and
   frozen. Cached by stage size. No area labels — areas live in the panel. */
function computeFullLayout(W, H) {
  var key = "full|" + Math.round(W) + "x" + Math.round(H);
  if (layoutCache[key]) return layoutCache[key];
  var areaPos = computeAreaLayout(W, H);

  var nodes = G.nodes.map(function (n) {
    var as = (n.areas || []).filter(function (id) { return areaPos.has(id); });
    var ax = 0, ay = 0;
    if (as.length) {
      as.forEach(function (id) { var p = areaPos.get(id); ax += p.x; ay += p.y; });
      ax /= as.length; ay /= as.length;
    } else { ax = W / 2; ay = H / 2; }
    var d = { id: n.id, n: n, ax: ax, ay: ay,
              x: ax + hashJitter(n.id) * 150, y: ay + hashJitter(n.id + "y") * 150 };
    return d;
  });
  var byId = new Map();
  nodes.forEach(function (d) { byId.set(d.id, d); });
  var links = G.edges.filter(function (e) {
    return byId.has(e.source) && byId.has(e.target);
  }).map(function (e) { return { source: e.source, target: e.target }; });

  var sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(function (d) { return d.id; })
      .distance(52).strength(0.32))
    .force("charge", d3.forceManyBody().strength(-32).distanceMax(300))
    .force("ax", d3.forceX(function (d) { return d.ax; }).strength(0.08))
    .force("ay", d3.forceY(function (d) { return d.ay; }).strength(0.08))
    .force("collide", d3.forceCollide(function (d) {
      return overviewRadius(d.n) + 3.5;
    }).iterations(2))
    .stop();
  for (var i = 0; i < 320; i++) sim.tick();
  fitPositions(nodes, W, H, 46);

  var pos = new Map();
  nodes.forEach(function (d) { pos.set(d.id, { x: d.x, y: d.y }); });
  layoutCache[key] = pos;
  return pos;
}

function overviewRadius(n) {
  if (n.type === "paper") return paperRadius(n);
  if (n.type === "method") return 4.6;
  if (n.type === "dataset" || n.type === "project") return 4.2;
  if (n.type === "gap" || n.type === "question") return 4.8;
  return 2.6; // concept, metric, task
}

/* which nodes carry a readable label on the overview */
function overviewLabelSet() {
  var ids = new Set();
  G.areas.forEach(function (a) {
    a.representatives.forEach(function (id) { ids.add(id); });
  });
  G.nodes.forEach(function (n) {
    if (n.seed || n.role === "foundational") ids.add(n.id);
  });
  return ids;
}

/* upper-cased sans label for method/dataset/concept-style reps; papers stay
   serif; gaps/questions keep plain sans sentence case (truncated) */
function overviewUpper(n) {
  return n.type === "method" || n.type === "dataset" || n.type === "project" ||
         n.type === "concept" || n.type === "metric" || n.type === "task";
}
function overviewLabelText(n) {
  var s = String(shortLabel(n));
  if (overviewUpper(n)) return s.toUpperCase();
  if (n.type === "gap" || n.type === "question") {
    return s.length > 26 ? s.slice(0, 25).replace(/\s+\S*$/, "") + "…" : s;
  }
  return s; // papers
}
function overviewLabelClass(n) {
  if (n.type === "paper") return "nlabel nlabel-serif";
  if (n.type === "concept" || n.type === "metric" || n.type === "task")
    return "nlabel nlabel-mono nlabel-up";
  if (n.type === "gap" || n.type === "question") return "nlabel nlabel-sans";
  return "nlabel nlabel-sans nlabel-up";
}
function overviewLabelFont(n) {
  if (n.type === "paper") return F_SERIF;
  if (n.type === "concept" || n.type === "metric" || n.type === "task") return F_MONO;
  return F_SANS;
}

/* ---------------------------------------------------------- view: overview */

function renderOverview(scene, W, H) {
  var pos = computeFullLayout(W, H);
  var labelIds = overviewLabelSet();

  // hairline edges between every pair present on stage
  var edgesG = scene.append("g").attr("class", "edges edges-overview");
  G.edges.forEach(function (e) {
    var a = pos.get(e.source), b = pos.get(e.target);
    if (!a || !b) return;
    var dashed = (e.type === "CONTRADICTS" || e.type === "IDENTIFIES_LIMITATION_OF");
    edgesG.append("line")
      .attr("class", "edge edge-ghost" + (dashed ? " edge-dashed" : ""))
      .attr("x1", a.x).attr("y1", a.y).attr("x2", b.x).attr("y2", b.y);
  });

  var nodesG = scene.append("g").attr("class", "overview-nodes");

  // place all nodes; ghost dots for the bulk, full shape for labeled ones
  var labelCandidates = [];
  G.nodes.forEach(function (n) {
    if (!passes(n)) return;
    var p = pos.get(n.id);
    if (!p) return;
    var labeled = labelIds.has(n.id);
    var g = nodeGroup(nodesG, n, p.x, p.y, 1);
    if (!labeled) {
      g.classed("ghost", true);
      return;
    }
    var txt = overviewLabelText(n);
    var w = textW(txt, overviewLabelFont(n));
    var sx = edgeShift(p.x, w, W);
    labelCandidates.push({
      g: g, n: n, txt: txt, sx: sx,
      x: p.x + sx, y: p.y + overviewRadius(n) + 4, w: w, h: 13,
      pri: nodeImportance(n, G.degree)
    });
  });

  // collision-managed labels: keep in priority order, drop the rest
  occlude(labelCandidates);
  labelCandidates.forEach(function (c) {
    if (!c.visible) return;
    c.g.append("text").attr("class", overviewLabelClass(c.n))
      .attr("x", c.sx)
      .attr("y", overviewRadius(c.n) + 13.5)
      .text(c.txt);
  });
}

/* -------------------------------------------------------------- view: gaps */

function renderGaps(scene, W, H) {
  var areaPos = computeAreaLayout(W, H);
  var items = G.nodes.filter(function (n) {
    return (n.type === "gap" || n.type === "question") && passes(n);
  }).map(function (n) {
    var as = (n.areas || []).filter(function (a) { return areaPos.has(a); });
    var cx = W / 2, cy = H / 2;
    if (as.length) {
      cx = 0; cy = 0;
      as.forEach(function (a) { var p = areaPos.get(a); cx += p.x; cy += p.y; });
      cx /= as.length; cy /= as.length;
    }
    return { n: n, tx: cx, ty: cy,
             x: cx + hashJitter(n.id) * 90, y: cy + hashJitter(n.id + "y") * 70 };
  });
  var sim = d3.forceSimulation(items)
    .force("x", d3.forceX(function (d) { return d.tx; }).strength(0.2))
    .force("y", d3.forceY(function (d) { return d.ty; }).strength(0.2))
    .force("collide", d3.forceCollide(function (d) {
      return clamp(textW(shortLabel(d.n), F_SANS) / 2 * 0.8, 18, 56);
    }).strength(0.95))
    .stop();
  for (var i = 0; i < 200; i++) sim.tick();

  var faintAreas = scene.append("g").attr("class", "areas areas-faint");
  G.areas.forEach(function (a) {
    var p = areaPos.get(a.id);
    var g = faintAreas.append("g").attr("class", "area-label area-label-faint")
      .attr("transform", "translate(" + p.x + "," + p.y + ")")
      .attr("tabindex", 0).attr("role", "button").attr("aria-label", a.label + " area");
    g.append("text").attr("class", "area-name").text(areaText(a, W));
    g.on("click", function (ev) { ev.stopPropagation(); gotoArea(a.id); })
     .on("keydown", function (ev) {
       if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); gotoArea(a.id); }
     });
  });

  var gg = scene.append("g");
  items.forEach(function (it) {
    it.x = clamp(it.x, 30, W - 30);
    it.y = clamp(it.y, 46, H - 50);
  });
  var labels = items.map(function (it) {
    var w = textW(shortLabel(it.n), F_SANS);
    var sx = edgeShift(it.x, w, W);
    return { x: it.x + sx, y: it.y + 7, w: w, h: 13, sx: sx,
             pri: nodeImportance(it.n, G.degree) };
  });
  occlude(labels);
  items.forEach(function (it, i) {
    var g = nodeGroup(gg, it.n, it.x, it.y, 1);
    if (it.n.priority === "high") g.select(".shape").classed("prio-high", true);
    if (labels[i].visible) {
      g.append("text").attr("class", labelClass(it.n))
        .attr("x", labels[i].sx).attr("y", 17).text(shortLabel(it.n));
    }
  });
}

/* -------------------------------------------------------------- view: area */

function areaMembers(area) {
  return G.nodes.filter(function (n) {
    return n.areas && n.areas.indexOf(area.id) >= 0 && passes(n);
  });
}

function pickAreaVisible(members) {
  if (members.length <= 40) return members.slice();
  var keep = members.filter(function (n) {
    return n.type === "method" || n.type === "dataset" || n.type === "gap" || n.type === "question";
  }).slice(0, 40);
  var papers = members.filter(function (n) { return n.type === "paper"; })
    .sort(function (a, b) {
      var ra = ROLE_RANK[a.role] != null ? ROLE_RANK[a.role] : 6;
      var rb = ROLE_RANK[b.role] != null ? ROLE_RANK[b.role] : 6;
      if (ra !== rb) return ra - rb;
      if (!!b.seed !== !!a.seed) return (b.seed ? 1 : 0) - (a.seed ? 1 : 0);
      return (b.year || 0) - (a.year || 0);
    });
  return keep.concat(papers.slice(0, Math.max(6, 40 - keep.length)));
}

function renderArea(scene, W, H) {
  var area = G.areasById.get(S.areaId);
  if (!area) { renderOverview(scene, W, H); return; }
  var members = areaMembers(area);
  var visible = pickAreaVisible(members);
  var visIds = new Set(visible.map(function (n) { return n.id; }));

  var simNodes = visible.map(function (n) {
    return { n: n, x: hashJitter(n.id) * 240, y: hashJitter(n.id + "y") * 180 };
  });
  var links = G.edges.filter(function (e) { return visIds.has(e.source) && visIds.has(e.target); })
    .map(function (e) { return { source: e.source, target: e.target, edge: e }; });

  var sim = d3.forceSimulation(simNodes)
    .force("charge", d3.forceManyBody().strength(-240))
    .force("link", d3.forceLink(links).id(function (d) { return d.n.id; })
      .distance(105).strength(0.14))
    .force("x", d3.forceX(0).strength(0.065))
    .force("y", d3.forceY(0).strength(0.1))
    .force("collide", d3.forceCollide(function (d) {
      return clamp(textW(shortLabel(d.n), labelFont(d.n)) / 2 * 0.78, 16, 52);
    }).strength(0.95))
    .stop();
  for (var i = 0; i < 280; i++) sim.tick();
  fitPositions(simNodes, W, H, 88);

  // intra-area edges, hairline
  var edgesG = scene.append("g").attr("class", "edges");
  links.forEach(function (l) {
    edgesG.append("line").attr("class", "edge")
      .attr("x1", l.source.x).attr("y1", l.source.y)
      .attr("x2", l.target.x).attr("y2", l.target.y);
  });

  // members (the area name and counts live in the breadcrumb and side panel,
  // so no title, count, or adjacent-area labels are drawn on the canvas)
  var nodesG = scene.append("g");
  var labels = simNodes.map(function (s) {
    var w = textW(shortLabel(s.n), labelFont(s.n));
    var sx = edgeShift(s.x, w, W);
    return { x: s.x + sx, y: s.y + paperRadius(s.n) + 4, w: w, h: 13, sx: sx,
             pri: nodeImportance(s.n, G.degree) };
  });
  occlude(labels);
  simNodes.forEach(function (s, idx) {
    var g = nodeGroup(nodesG, s.n, s.x, s.y, 1);
    if (labels[idx].visible) {
      g.append("text").attr("class", labelClass(s.n))
        .attr("x", labels[idx].sx)
        .attr("y", paperRadius(s.n) + 13.5).text(shortLabel(s.n));
    }
  });
}

/* -------------------------------------------------------------- view: node */

function neighborEntries(id) {
  return (G.neighbors.get(id) || []).filter(function (x) {
    var n = G.nodesById.get(x.other);
    return n && passes(n);
  });
}

function groupNeighbors(entries) {
  var m = new Map();
  entries.forEach(function (x) {
    var caption = relPhrase(x.edge.type, x.dir);
    if (!m.has(caption)) m.set(caption, { caption: caption, items: [] });
    m.get(caption).items.push(x);
  });
  var groups = Array.from(m.values());
  groups.forEach(function (g) {
    g.items.sort(function (a, b) {
      return nodeImportance(G.nodesById.get(b.other), G.degree) -
             nodeImportance(G.nodesById.get(a.other), G.degree);
    });
  });
  groups.sort(function (a, b) { return b.items.length - a.items.length; });
  return groups;
}

function truncateGroups(groups, maxTotal) {
  var total = groups.reduce(function (s, g) { return s + g.items.length; }, 0);
  if (total <= maxTotal) {
    groups.forEach(function (g) { g.shown = g.items; g.hidden = 0; });
    return;
  }
  groups.forEach(function (g) {
    g.quota = Math.max(1, Math.floor(maxTotal * g.items.length / total));
  });
  var used = groups.reduce(function (s, g) { return s + g.quota; }, 0);
  var guard = 100;
  while (used > maxTotal && guard--) {
    var big = groups.reduce(function (a, b) { return b.quota > a.quota ? b : a; });
    if (big.quota <= 1) break;
    big.quota--; used--;
  }
  guard = 100;
  while (used < maxTotal && guard--) {
    var most = groups.reduce(function (a, b) {
      return (b.items.length - b.quota) > (a.items.length - a.quota) ? b : a;
    });
    if (most.items.length <= most.quota) break;
    most.quota++; used++;
  }
  groups.forEach(function (g) {
    g.shown = g.items.slice(0, g.quota);
    g.hidden = g.items.length - g.shown.length;
  });
}

function renderNode(scene, W, H) {
  var c = G.nodesById.get(S.nodeId);
  if (!c) { renderOverview(scene, W, H); return; }
  var cx = W / 2, cy = H / 2 + 8;
  var groups = groupNeighbors(neighborEntries(c.id));
  truncateGroups(groups, 18);
  var shownTotal = groups.reduce(function (s, g) { return s + g.shown.length; }, 0);

  var R = clamp(Math.min(W, H) / 2 - 96, 140, 235);
  if (shownTotal <= 6) R = Math.min(R, 178);

  // angular sectors proportional to group size, minimum width, with gaps
  var gapA = 14 * Math.PI / 180;
  var free = Math.max(0.5, 2 * Math.PI - groups.length * gapA);
  var minA = 30 * Math.PI / 180;
  var spans = groups.map(function (g) {
    return Math.max(minA, free * g.shown.length / Math.max(1, shownTotal));
  });
  var spanSum = spans.reduce(function (a, b) { return a + b; }, 0) || 1;
  spans = spans.map(function (s) { return s * free / spanSum; });

  var edgesG = scene.append("g").attr("class", "edges");
  var ringG = scene.append("g").attr("class", "ring2");
  var nodesG = scene.append("g");
  var capsG = scene.append("g").attr("class", "captions");

  var a0 = -Math.PI / 2;
  var placed = [];
  var neighborPos = new Map();

  groups.forEach(function (g, gi) {
    var a1 = a0 + spans[gi];
    var mid = (a0 + a1) / 2;

    // mono caption between center and ring
    capsG.append("text").attr("class", "rel-caption")
      .attr("x", cx + Math.cos(mid) * R * 0.58)
      .attr("y", cy + Math.sin(mid) * R * 0.58)
      .text(g.caption);

    g.shown.forEach(function (x, i) {
      var t = g.shown.length === 1 ? 0.5 : i / (g.shown.length - 1);
      var pad = Math.min(0.16, spans[gi] * 0.18);
      var ang = a0 + pad + (spans[gi] - 2 * pad) * t;
      var nx = cx + Math.cos(ang) * R, ny = cy + Math.sin(ang) * R;
      var n = G.nodesById.get(x.other);
      neighborPos.set(n.id, { x: nx, y: ny });

      var line = edgesG.append("line").attr("class", "edge edge-hop")
        .attr("x1", cx).attr("y1", cy).attr("x2", nx).attr("y2", ny);
      var hit = edgesG.append("line").attr("class", "edge-hit")
        .attr("x1", cx).attr("y1", cy).attr("x2", nx).attr("y2", ny);
      hit.on("mouseenter", function (ev) {
        line.classed("edge-hover", true)
            .attr("marker-end", x.dir === "out" ? "url(#lit-arrow)" : null)
            .attr("marker-start", x.dir === "in" ? "url(#lit-arrow-rev)" : null);
        var s = x.dir === "out" ? c : n, tgt = x.dir === "out" ? n : c;
        showTip(ev, shortLabel(s) + " " + relPhrase(x.edge.type, "out") + " " + shortLabel(tgt),
                x.edge.explanation ? String(x.edge.explanation).slice(0, 140) : "");
      }).on("mousemove", moveTip)
        .on("mouseleave", function () {
          line.classed("edge-hover", false).attr("marker-end", null).attr("marker-start", null);
          hideTip();
        });

      var ng = nodeGroup(nodesG, n, nx, ny, 1);
      var right = Math.cos(ang) >= 0;
      var lw = textW(shortLabel(n), labelFont(n));
      var lx = Math.cos(ang) * 13, ly = Math.sin(ang) * 13 + 4;
      placed.push({
        box: { x: nx + lx + (right ? lw / 2 : -lw / 2), y: ny + ly - 10, w: lw, h: 13,
               pri: nodeImportance(n, G.degree) },
        g: ng, n: n, lx: lx, ly: ly, right: right
      });

      // expand affordance: second ring behind this neighbor
      var ex = ng.append("g").attr("class", "expander")
        .attr("transform", "translate(0,-17)")
        .attr("tabindex", 0).attr("role", "button")
        .attr("aria-label", "Show top connections of " + shortLabel(n));
      ex.append("circle").attr("r", 7);
      ex.append("path").attr("d", "M-3,0H3M0,-3V3");
      function fire(ev) {
        ev.stopPropagation();
        toggleSecondRing(n, neighborPos.get(n.id), ringG, cx, cy);
      }
      ex.on("click", fire).on("keydown", function (ev) {
        if (ev.key === "Enter") { ev.preventDefault(); fire(ev); }
      });
    });
    a0 = a1 + gapA;
  });

  occlude(placed.map(function (p) { return p.box; }));
  placed.forEach(function (p) {
    if (!p.box.visible) return;
    p.g.append("text").attr("class", labelClass(p.n))
      .attr("x", p.lx).attr("y", p.ly)
      .attr("text-anchor", p.right ? "start" : "end")
      .text(shortLabel(p.n));
  });

  // center node
  var cg = nodeGroup(nodesG, c, cx, cy, 1.5);
  cg.classed("center", true).attr("aria-label", (c.label || c.id) + ", selected " + c.type);
  cg.on("click", function (ev) { ev.stopPropagation(); });
  cg.append("text").attr("class", labelClass(c) + " center-label")
    .attr("y", paperRadius(c) * 1.5 + 19).text(shortLabel(c));
  var sub = [c.year, c.venue].filter(Boolean).join(" · ");
  if (sub) cg.append("text").attr("class", "center-sub")
    .attr("y", paperRadius(c) * 1.5 + 34).text(sub);
}

function toggleSecondRing(n, pos, ringG, cx, cy) {
  if (S.expandedId === n.id) {
    S.expandedId = null;
    ringG.selectAll("*").remove();
    return;
  }
  S.expandedId = n.id;
  ringG.selectAll("*").remove();
  var onStage = new Set([S.nodeId]);
  svg.selectAll("g.node").each(function () {
    onStage.add(this.getAttribute("data-id"));
  });
  var second = neighborEntries(n.id)
    .filter(function (x) { return !onStage.has(x.other); })
    .sort(function (a, b) {
      return nodeImportance(G.nodesById.get(b.other), G.degree) -
             nodeImportance(G.nodesById.get(a.other), G.degree);
    })
    .slice(0, 10);
  if (!second.length) return;
  var sz = stageSize();
  var outAng = Math.atan2(pos.y - cy, pos.x - cx);
  var spread = Math.min(Math.PI * 0.9, 0.5 + second.length * 0.22);
  second.forEach(function (x, i) {
    var t = second.length === 1 ? 0.5 : i / (second.length - 1);
    var ang = outAng - spread / 2 + spread * t;
    var nx = clamp(pos.x + Math.cos(ang) * 86, 20, sz.W - 20);
    var ny = clamp(pos.y + Math.sin(ang) * 86, 30, sz.H - 34);
    var nn = G.nodesById.get(x.other);
    ringG.append("line").attr("class", "edge edge-faint")
      .attr("x1", pos.x).attr("y1", pos.y).attr("x2", nx).attr("y2", ny);
    var g = nodeGroup(ringG, nn, nx, ny, 0.85);
    g.classed("second", true);
    g.append("text").attr("class", labelClass(nn) + " second-label")
      .attr("x", Math.cos(ang) * 11)
      .attr("y", Math.sin(ang) * 11 + 4)
      .attr("text-anchor", Math.cos(ang) >= 0 ? "start" : "end")
      .text(shortLabel(nn));
  });
}

/* ------------------------------------------------------------- breadcrumb */

function crumbLabel(d) {
  if (d.view === "overview") return "Overview";
  if (d.view === "gaps") return "Gaps & questions";
  if (d.view === "area") {
    var a = G.areasById.get(d.areaId);
    return a ? a.label : "Area";
  }
  var n = G.nodesById.get(d.nodeId);
  return n ? shortLabel(n) : "Node";
}

function renderCrumbs() {
  var nav = $("lit-crumbs");
  nav.innerHTML = "";
  if (!S.trail.length) { nav.hidden = true; return; }
  nav.hidden = false;
  var back = el("button", "crumb-back", "←");
  back.type = "button";
  back.setAttribute("aria-label", "Back one step");
  back.addEventListener("click", goBack);
  nav.appendChild(back);
  var path = S.trail.concat([currentDesc()]);
  var start = Math.max(0, path.length - 5);
  if (start > 0) {
    var first = el("button", "crumb", crumbLabel(path[0]));
    first.type = "button";
    first.addEventListener("click", function () { goTrail(0); });
    nav.appendChild(first);
    nav.appendChild(el("span", "crumb-sep", "→ …"));
  }
  path.slice(start).forEach(function (d, i) {
    var idx = start + i;
    if (i > 0 || start > 0) nav.appendChild(el("span", "crumb-sep", "→"));
    if (idx === path.length - 1) {
      var cur = el("span", "crumb crumb-current", crumbLabel(d));
      cur.setAttribute("aria-current", "page");
      nav.appendChild(cur);
    } else {
      var b = el("button", "crumb", crumbLabel(d));
      b.type = "button";
      b.addEventListener("click", function () { goTrail(idx); });
      nav.appendChild(b);
    }
  });
}

/* ------------------------------------------------------------------ panel */

function panelLink(node) {
  var b = el("button", "p-nodelink");
  b.type = "button";
  b.appendChild(el("span", "p-nodelink-name", shortLabel(node)));
  var meta = [node.year, node.venue].filter(Boolean).join(" · ");
  if (meta) b.appendChild(el("span", "p-nodelink-meta", meta));
  b.addEventListener("click", function () { gotoNode(node.id); });
  return b;
}

function panelAreaIndex(body) {
  var list = el("div", "p-areaindex");
  G.areas.forEach(function (a) {
    var b = el("button", "p-arealink");
    b.type = "button";
    b.appendChild(el("span", "p-arealink-name", a.label));
    b.appendChild(el("span", "p-arealink-count", String(a.count)));
    b.addEventListener("click", function () { gotoArea(a.id); });
    list.appendChild(b);
  });
  body.appendChild(list);
}

function renderPanelEmpty(body) {
  body.appendChild(el("h2", "p-title", "Explore the landscape"));
  body.appendChild(el("p", "p-body", "Search, or pick an area."));
  panelAreaIndex(body);
}

function renderPanelGaps(body) {
  body.appendChild(el("h2", "p-title", "Gaps & questions"));
  var items = G.nodes.filter(function (n) {
    return (n.type === "gap" || n.type === "question") && passes(n);
  });
  ["high", "medium", "low", null].forEach(function (prio) {
    var group = items.filter(function (n) { return (n.priority || null) === prio; });
    if (!group.length) return;
    body.appendChild(el("h3", "p-section", prio ? prio + " priority" : "unranked"));
    group.forEach(function (n) {
      var b = el("button", "p-nodelink");
      b.type = "button";
      b.appendChild(el("span", "p-nodelink-name", n.label));
      b.addEventListener("click", function () { gotoNode(n.id); });
      body.appendChild(b);
    });
  });
}

function renderPanelArea(body) {
  var area = G.areasById.get(S.areaId);
  if (!area) return;
  body.appendChild(el("h2", "p-title", area.label));
  if (area.description) body.appendChild(el("p", "p-body", area.description));

  var members = areaMembers(area);
  var byGroup = { paper: [], method: [], dataset: [], concept: [], gap: [] };
  members.forEach(function (n) { byGroup[typeGroup(n.type)].push(n); });
  var countsLine = Object.keys(byGroup)
    .filter(function (k) { return byGroup[k].length; })
    .map(function (k) { return byGroup[k].length + " " + TYPE_GROUP_LABELS[k].toLowerCase(); })
    .join(" · ");
  body.appendChild(el("p", "p-mono", countsLine));

  byGroup.paper.sort(function (a, b) {
    var ra = ROLE_RANK[a.role] != null ? ROLE_RANK[a.role] : 6;
    var rb = ROLE_RANK[b.role] != null ? ROLE_RANK[b.role] : 6;
    return ra - rb || (b.year || 0) - (a.year || 0);
  });
  [["paper", "Papers"], ["method", "Methods"], ["dataset", "Datasets"],
   ["concept", "Concepts & metrics"], ["gap", "Gaps & questions"]].forEach(function (pair) {
    var group = byGroup[pair[0]];
    if (!group.length) return;
    body.appendChild(el("h3", "p-section", pair[1]));
    group.forEach(function (n) { body.appendChild(panelLink(n)); });
  });
}

function badge(text, cls) { return el("span", "p-badge" + (cls ? " " + cls : ""), text); }

function renderPanelNode(body) {
  var n = G.nodesById.get(S.nodeId);
  if (!n) return;

  body.appendChild(el("h2", "p-title", n.label || n.id));
  if (n.authors) body.appendChild(el("p", "p-authors", n.authors));
  var metaP = el("p", "p-mono", [n.year, n.venue, n.type].filter(Boolean).join(" · "));
  if (n.url) {
    metaP.appendChild(document.createTextNode("  "));
    var a = el("a", "p-extlink", "open ↗");
    a.href = n.url; a.target = "_blank"; a.rel = "noopener";
    metaP.appendChild(a);
  }
  body.appendChild(metaP);

  var badges = el("p", "p-badges");
  if (n.type === "paper") {
    if (n.peerReviewed === true) badges.appendChild(badge("peer-reviewed"));
    else if (n.peerReviewed === false) badges.appendChild(badge("preprint"));
    else badges.appendChild(badge("unverified"));
  }
  if (n.seed) badges.appendChild(badge("seed"));
  if (n.role) badges.appendChild(badge(n.role, "p-badge-role"));
  if (n.priority && (n.type === "gap" || n.type === "question"))
    badges.appendChild(badge(n.priority + " priority", n.priority === "high" ? "p-badge-accent" : ""));
  if (badges.childNodes.length) body.appendChild(badges);

  if (n.summary) {
    body.appendChild(el("h3", "p-section", "What it does"));
    body.appendChild(el("p", "p-body", n.summary));
  }

  var nodeAreas = (n.areas || []).map(function (id) { return G.areasById.get(id); }).filter(Boolean);
  if (nodeAreas.length) {
    body.appendChild(el("h3", "p-section", "Research areas"));
    var chips = el("p", "p-chips");
    nodeAreas.forEach(function (a2) {
      var b = el("button", "p-chip", a2.label);
      b.type = "button";
      b.addEventListener("click", function () { gotoArea(a2.id); });
      chips.appendChild(b);
    });
    body.appendChild(chips);
  }

  // methods / datasets from typed edges
  var entries = G.neighbors.get(n.id) || [];
  var usedMethods = [], usedDatasets = [];
  entries.forEach(function (x) {
    if (x.dir !== "out") return;
    var other = G.nodesById.get(x.other);
    if (!other) return;
    if (other.type === "method" &&
        (x.edge.type === "USES" || x.edge.type === "INTRODUCES" || x.edge.type === "EXTENDS"))
      usedMethods.push({ n: other, e: x.edge });
    if (other.type === "dataset" &&
        (x.edge.type === "USES_DATASET" || x.edge.type === "USES" ||
         x.edge.type === "INTRODUCES" || x.edge.type === "EVALUATES"))
      usedDatasets.push({ n: other, e: x.edge });
  });
  [[usedMethods, "Methods"], [usedDatasets, "Datasets"]].forEach(function (pair) {
    if (!pair[0].length) return;
    body.appendChild(el("h3", "p-section", pair[1]));
    pair[0].forEach(function (m) {
      var b = el("button", "p-nodelink");
      b.type = "button";
      b.appendChild(el("span", "p-nodelink-name", m.n.label));
      if (m.e.type === "INTRODUCES") b.appendChild(el("span", "p-nodelink-meta", "introduced here"));
      b.addEventListener("click", function () { gotoNode(m.n.id); });
      body.appendChild(b);
    });
  });

  if (n.findings) {
    body.appendChild(el("h3", "p-section", "Key findings"));
    body.appendChild(el("p", "p-body", n.findings));
  }
  if (n.limitations) {
    body.appendChild(el("h3", "p-section", "Limitations"));
    body.appendChild(el("p", "p-body", n.limitations));
  }

  // connections grouped by relation, complete list
  var groups = groupNeighbors(neighborEntries(n.id));
  truncateGroups(groups, 18);
  if (groups.length) {
    body.appendChild(el("h3", "p-section", "Connections"));
    groups.forEach(function (g) {
      body.appendChild(el("p", "p-conn-caption",
        g.caption + (g.hidden ? "  ·  +" + g.hidden + " not on map" : "")));
      g.items.forEach(function (x) {
        var other = G.nodesById.get(x.other);
        var b = el("button", "p-conn");
        b.type = "button";
        b.appendChild(el("span", "p-nodelink-name", shortLabel(other)));
        if (x.edge.explanation)
          b.appendChild(el("span", "p-conn-expl", x.edge.explanation));
        b.addEventListener("click", function () { gotoNode(other.id); });
        body.appendChild(b);
      });
    });
  }

  if (n.significance) {
    body.appendChild(el("h3", "p-section", "Why it matters"));
    body.appendChild(el("p", "p-body", n.significance));
  }

  if (n.application) {
    var det = document.createElement("details");
    det.className = "p-application";
    var sum = document.createElement("summary");
    sum.textContent = "Application context";
    det.appendChild(sum);
    det.appendChild(el("p", "p-body", n.application));
    body.appendChild(det);
  }
}

function renderPanel() {
  var body = $("lit-panel-body");
  body.innerHTML = "";
  if (S.view === "node") renderPanelNode(body);
  else if (S.view === "area") renderPanelArea(body);
  else if (S.view === "gaps") renderPanelGaps(body);
  else renderPanelEmpty(body);
  $("lit-panel").scrollTop = 0;
}

function setPanelOpen(open) {
  S.panelOpen = open;
  $("lit-layout").classList.toggle("panel-closed", !open);
  $("lit-panel-open").hidden = open;
  requestAnimationFrame(function () { render(false); });
}

/* ----------------------------------------------------------------- render */

function ensureDefs() {
  if (!svg.select("defs").empty()) return;
  var defs = svg.append("defs");
  defs.append("marker").attr("id", "lit-arrow")
    .attr("viewBox", "0 0 8 8").attr("refX", 7).attr("refY", 4)
    .attr("markerWidth", 7).attr("markerHeight", 7).attr("orient", "auto")
    .append("path").attr("d", "M0,0.6L7,4L0,7.4").attr("class", "arrowhead");
  defs.append("marker").attr("id", "lit-arrow-rev")
    .attr("viewBox", "0 0 8 8").attr("refX", 1).attr("refY", 4)
    .attr("markerWidth", 7).attr("markerHeight", 7).attr("orient", "auto")
    .append("path").attr("d", "M8,0.6L1,4L8,7.4").attr("class", "arrowhead");
}

function render(withPanel) {
  if (!G) return;
  S.expandedId = null;
  hideTip();
  ensureDefs();
  svg.call(zoom.transform, d3.zoomIdentity);
  var sz = stageSize(), W = sz.W, H = sz.H;
  svg.attr("viewBox", "0 0 " + W + " " + H);
  zoomRoot.selectAll("*").remove();
  var scene = zoomRoot.append("g").attr("class", "scene");
  if (FADE) {
    scene.style("opacity", 0);
    scene.transition().duration(FADE).style("opacity", 1);
  }
  if (S.view === "overview") renderOverview(scene, W, H);
  else if (S.view === "gaps") renderGaps(scene, W, H);
  else if (S.view === "area") renderArea(scene, W, H);
  else renderNode(scene, W, H);

  renderCrumbs();
  if (withPanel !== false) renderPanel();
  updateStatus();
  $("lit-gaps").setAttribute("aria-pressed", S.view === "gaps" ? "true" : "false");
}

/* ----------------------------------------------------------------- status */

function viewUniverse() {
  if (S.view === "area") {
    var area = G.areasById.get(S.areaId);
    if (!area) return [];
    return G.nodes.filter(function (n) { return n.areas && n.areas.indexOf(area.id) >= 0; });
  }
  if (S.view === "node") {
    return (G.neighbors.get(S.nodeId) || [])
      .map(function (x) { return G.nodesById.get(x.other); }).filter(Boolean);
  }
  if (S.view === "gaps") {
    return G.nodes.filter(function (n) { return n.type === "gap" || n.type === "question"; });
  }
  // overview shows the whole graph
  return G.nodes;
}

function updateStatus() {
  var st = $("lit-status");
  if (!filtersActive()) { st.textContent = ""; return; }
  var uni = viewUniverse();
  var shown = uni.filter(passes).length;
  st.textContent = shown + " of " + uni.length + " shown";
}

/* ----------------------------------------------------------------- search */

var searchIndex = [];
function buildSearchIndex() {
  searchIndex = [];
  G.areas.forEach(function (a) {
    searchIndex.push({
      kind: "area", ref: a, name: a.label,
      hay: (a.label + " " + a.id.replace(/-/g, " ")).toLowerCase(),
      strong: a.label.toLowerCase()
    });
  });
  G.nodes.forEach(function (n) {
    var areaNames = (n.areas || []).map(function (id) {
      var a = G.areasById.get(id); return a ? a.label : "";
    }).join(" ");
    searchIndex.push({
      kind: typeGroup(n.type), ref: n, name: n.label || n.id,
      hay: [n.label, n.short, n.authors, n.venue, areaNames]
        .filter(Boolean).join(" ").toLowerCase(),
      strong: ((n.label || "") + " " + (n.short || "")).toLowerCase()
    });
  });
}

function scoreEntry(entry, tokens, q) {
  for (var i = 0; i < tokens.length; i++) {
    if (entry.hay.indexOf(tokens[i]) < 0) return -1;
  }
  var s = 0;
  var name = (entry.name || "").toLowerCase();
  var short = entry.ref.short ? String(entry.ref.short).toLowerCase() : "";
  if (name === q || short === q) s += 130;
  if (entry.strong.indexOf(q) === 0) s += 55;
  var allInStrong = tokens.every(function (t) { return entry.strong.indexOf(t) >= 0; });
  if (allInStrong) s += 30;
  if (entry.kind === "area" && allInStrong) s += 45;
  tokens.forEach(function (t) {
    var esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp("(^|[^a-z0-9])" + esc).test(entry.strong)) s += 8;
  });
  if (entry.ref.role === "foundational" || entry.ref.seed) s += 3;
  return s;
}

var searchState = { open: false, flat: [], active: -1 };

function runSearch(q) {
  q = q.trim().toLowerCase();
  var box = $("lit-search-results");
  if (q.length < 2) { closeSearch(); return; }
  var tokens = q.split(/\s+/);
  var hits = [];
  searchIndex.forEach(function (entry) {
    var s = scoreEntry(entry, tokens, q);
    if (s >= 0) hits.push({ entry: entry, score: s });
  });
  hits.sort(function (a, b) { return b.score - a.score; });
  var GROUP_ORDER = ["paper", "method", "dataset", "concept", "area", "gap"];
  var GROUP_NAMES = { paper: "Papers", method: "Methods", dataset: "Datasets",
                      concept: "Concepts & metrics", area: "Areas", gap: "Gaps & questions" };
  var grouped = {};
  hits.forEach(function (h) {
    (grouped[h.entry.kind] = grouped[h.entry.kind] || []).push(h);
  });
  box.innerHTML = "";
  searchState.flat = [];
  var best = hits.length ? hits[0] : null;
  GROUP_ORDER.forEach(function (k) {
    var list = (grouped[k] || []).slice(0, 5);
    if (!list.length) return;
    box.appendChild(el("div", "sr-group", GROUP_NAMES[k]));
    list.forEach(function (h) {
      var d = el("div", "sr-item");
      d.setAttribute("role", "option");
      d.id = "sr-" + searchState.flat.length;
      d.appendChild(el("span", "sr-name", h.entry.name));
      var meta = h.entry.kind === "area"
        ? h.entry.ref.count + " items"
        : [h.entry.ref.short !== h.entry.name ? h.entry.ref.short : null,
           h.entry.ref.year, h.entry.ref.venue].filter(Boolean).join(" · ");
      if (meta) d.appendChild(el("span", "sr-meta", meta));
      var idx = searchState.flat.length;
      d.addEventListener("mousedown", function (ev) { ev.preventDefault(); activateSearch(idx); });
      searchState.flat.push({ el: d, hit: h });
      box.appendChild(d);
    });
  });
  if (!searchState.flat.length) box.appendChild(el("div", "sr-empty", "No matches."));
  box.hidden = false;
  searchState.open = true;
  $("lit-search").setAttribute("aria-expanded", "true");
  // pre-highlight the globally best result, wherever its group sits
  var bi = 0;
  if (best) {
    searchState.flat.some(function (f, i) {
      if (f.hit.entry === best.entry) { bi = i; return true; }
      return false;
    });
  }
  setSearchActive(searchState.flat.length ? bi : -1);
}

function setSearchActive(i) {
  searchState.active = i;
  searchState.flat.forEach(function (f, j) {
    f.el.classList.toggle("sr-active", j === i);
    f.el.setAttribute("aria-selected", j === i ? "true" : "false");
  });
  var input = $("lit-search");
  if (i >= 0) {
    input.setAttribute("aria-activedescendant", searchState.flat[i].el.id);
    searchState.flat[i].el.scrollIntoView({ block: "nearest" });
  } else input.removeAttribute("aria-activedescendant");
}

function activateSearch(i) {
  var f = searchState.flat[i];
  if (!f) return;
  closeSearch();
  $("lit-search").value = "";
  var entry = f.hit.entry;
  if (entry.kind === "area") gotoArea(entry.ref.id);
  else gotoNode(entry.ref.id);
}

function closeSearch() {
  var box = $("lit-search-results");
  box.hidden = true;
  box.innerHTML = "";
  searchState.open = false;
  searchState.flat = [];
  searchState.active = -1;
  $("lit-search").setAttribute("aria-expanded", "false");
}

/* ---------------------------------------------------------------- filters */

function buildFiltersUI() {
  var host = $("lit-filters");
  host.innerHTML = "";

  var typeWrap = el("div", "f-group");
  typeWrap.appendChild(el("span", "f-label", "Type"));
  Object.keys(TYPE_GROUP_LABELS).forEach(function (k) {
    var lab = el("label", "f-check");
    var cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = true; cb.dataset.type = k;
    cb.addEventListener("change", applyFilterInputs);
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(TYPE_GROUP_LABELS[k]));
    typeWrap.appendChild(lab);
  });
  host.appendChild(typeWrap);

  var areaWrap = el("div", "f-group");
  var areaLab = el("label", "f-label", "Area");
  var sel = document.createElement("select");
  sel.id = "f-area";
  sel.appendChild(new Option("All areas", ""));
  G.areas.forEach(function (a) { sel.appendChild(new Option(a.label, a.id)); });
  sel.addEventListener("change", applyFilterInputs);
  areaLab.appendChild(sel);
  areaWrap.appendChild(areaLab);
  host.appendChild(areaWrap);

  var yearWrap = el("div", "f-group");
  var yl = el("label", "f-label", "Years");
  var y1 = document.createElement("input");
  y1.type = "number"; y1.id = "f-ymin"; y1.placeholder = "from";
  var y2 = document.createElement("input");
  y2.type = "number"; y2.id = "f-ymax"; y2.placeholder = "to";
  [y1, y2].forEach(function (y) {
    y.min = 1950; y.max = 2030;
    y.setAttribute("aria-label", y === y1 ? "Year from" : "Year to");
    y.addEventListener("change", applyFilterInputs);
  });
  yl.appendChild(y1);
  yl.appendChild(document.createTextNode("–"));
  yl.appendChild(y2);
  yearWrap.appendChild(yl);
  host.appendChild(yearWrap);

  var revWrap = el("div", "f-group");
  var rl = el("label", "f-label", "Review");
  var rsel = document.createElement("select");
  rsel.id = "f-review";
  rsel.appendChild(new Option("All", "all"));
  rsel.appendChild(new Option("Peer-reviewed", "peer"));
  rsel.appendChild(new Option("Preprint", "preprint"));
  rsel.addEventListener("change", applyFilterInputs);
  rl.appendChild(rsel);
  revWrap.appendChild(rl);
  host.appendChild(revWrap);

  var clear = el("button", "f-clear", "Clear");
  clear.type = "button";
  clear.addEventListener("click", function () { resetFilterInputs(); applyFilterInputs(); });
  host.appendChild(clear);
}

function resetFilterInputs() {
  var host = $("lit-filters");
  host.querySelectorAll("input[type=checkbox]").forEach(function (cb) { cb.checked = true; });
  var fa = $("f-area"), fy1 = $("f-ymin"), fy2 = $("f-ymax"), fr = $("f-review");
  if (fa) fa.value = "";
  if (fy1) fy1.value = "";
  if (fy2) fy2.value = "";
  if (fr) fr.value = "all";
}

function applyFilterInputs() {
  var checked = new Set();
  $("lit-filters").querySelectorAll("input[type=checkbox]").forEach(function (cb) {
    if (cb.checked) checked.add(cb.dataset.type);
  });
  S.filters.types = checked.size === Object.keys(TYPE_GROUP_LABELS).length ? null : checked;
  S.filters.area = $("f-area").value;
  var ymin = parseInt($("f-ymin").value, 10), ymax = parseInt($("f-ymax").value, 10);
  S.filters.yearMin = isNaN(ymin) ? null : ymin;
  S.filters.yearMax = isNaN(ymax) ? null : ymax;
  S.filters.review = $("f-review").value;
  render();
}

/* -------------------------------------------------------------- top level */

function showLoadError(err) {
  var stage = $("lit-stage");
  var box = el("div", "lit-error");
  box.appendChild(el("p", "lit-error-title", "Couldn't load the literature data."));
  box.appendChild(el("p", "lit-error-body",
    "This page reads ../research/literature-graph.json and needs to be served over HTTP. From the site root, run:"));
  box.appendChild(el("pre", "lit-error-code", "python3 -m http.server"));
  box.appendChild(el("p", "lit-error-body", "then open http://localhost:8000/literature/."));
  stage.appendChild(box);
  $("lit-status").textContent =
    "Data failed to load" + (err && err.message ? ": " + err.message : ".");
}

function countLine() {
  var papers = 0, methods = 0, datasets = 0, open = 0;
  G.nodes.forEach(function (n) {
    if (n.type === "paper") papers++;
    else if (n.type === "method") methods++;
    else if (n.type === "dataset") datasets++;
    else if (n.type === "gap" || n.type === "question") open++;
  });
  return papers + " papers, " + methods + " methods, " + datasets + " datasets, " +
         open + " open questions · " + G.edges.length + " relations.";
}

function toggleFilters(open) {
  $("lit-filters").hidden = !open;
  $("lit-filters-toggle").setAttribute("aria-expanded", open ? "true" : "false");
}

function bindUI() {
  var input = $("lit-search");
  input.addEventListener("input", function () { runSearch(input.value); });
  input.addEventListener("keydown", function (ev) {
    if (!searchState.open) {
      if (ev.key === "ArrowDown" && input.value.trim().length >= 2) {
        runSearch(input.value);
        ev.preventDefault();
      }
      return;
    }
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setSearchActive(Math.min(searchState.flat.length - 1, searchState.active + 1));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setSearchActive(Math.max(0, searchState.active - 1));
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      if (searchState.active >= 0) activateSearch(searchState.active);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      closeSearch();
      input.blur();
    }
  });
  input.addEventListener("blur", function () { setTimeout(closeSearch, 150); });

  document.addEventListener("keydown", function (ev) {
    if (ev.key === "/" && document.activeElement !== input &&
        !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      ev.preventDefault();
      input.focus();
    } else if (ev.key === "Escape") {
      // Consume Escape only when it drives an in-app "go back" step, so the
      // browser does not treat it as an exit-fullscreen shortcut mid-navigation.
      var acted = false;
      if (searchState.open) { closeSearch(); acted = true; }
      else if (!$("lit-filters").hidden) { toggleFilters(false); acted = true; }
      else if (S.trail.length) { goBack(); acted = true; }
      if (acted) { ev.preventDefault(); ev.stopPropagation(); }
    }
  });

  $("lit-filters-toggle").addEventListener("click", function () {
    toggleFilters($("lit-filters").hidden);
  });

  $("lit-gaps").addEventListener("click", function () {
    if (S.view === "gaps") goBack();
    else navigate({ view: "gaps", areaId: null, nodeId: null });
  });

  $("lit-reset").addEventListener("click", function () {
    S.trail = [];
    S.filters = { types: null, area: "", yearMin: null, yearMax: null, review: "all" };
    resetFilterInputs();
    applyDesc({ view: "overview", areaId: null, nodeId: null });
    closeSearch();
    $("lit-search").value = "";
    render();
  });

  $("lit-panel-close").addEventListener("click", function () { setPanelOpen(false); });
  $("lit-panel-open").addEventListener("click", function () { setPanelOpen(true); });

  $("lit-zoom-in").addEventListener("click", function () {
    svg.transition().duration(FADE).call(zoom.scaleBy, 1.35);
  });
  $("lit-zoom-out").addEventListener("click", function () {
    svg.transition().duration(FADE).call(zoom.scaleBy, 1 / 1.35);
  });
  $("lit-zoom-fit").addEventListener("click", function () {
    svg.transition().duration(FADE).call(zoom.transform, d3.zoomIdentity);
  });

  var resizeTimer = null, lastW = stageSize().W;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      var w = stageSize().W;
      if (Math.abs(w - lastW) > 4) { lastW = w; layoutCache = {}; render(); }
    }, 180);
  });
}

function init(data) {
  G = buildModel(data);
  $("lit-count").textContent = countLine();
  buildSearchIndex();
  buildFiltersUI();
  bindUI();
  if (window.innerWidth <= 768) setPanelOpen(false);
  else render();
}

var DATA_URL = new URLSearchParams(location.search).get("data") ||
               "../research/literature-graph.json";
fetch(DATA_URL)
  .then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  })
  .then(init)
  .catch(showLoadError);

})();
