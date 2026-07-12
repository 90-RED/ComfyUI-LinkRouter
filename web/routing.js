// routing.js — link routing core for LinkRouter.
//
// Reads shared state from M in state.js.
// Uses currentMargin() / resetRouter() from state.js.
// Exports routeAll for draw.js and nodeRect for ui.js.

import { app } from "../../scripts/app.js";
import { M } from "./state.js";
import { pathCrossesRects, stretchedPathCrossesUnexpectedNode } from "./router.js";
import { profiler } from "./profiler.js";
import {
  orderHeldRouteCandidates,
  pathBounds,
  shouldFreezeHiddenModeLink,
  shouldQueueIdleCleanup,
  shouldRouteHeldCollision,
  shouldStretchDragPath,
  shouldUseDragSettle,
} from "./drag-policy.js";
import {
  liveCollisionBudget,
  lockAdaptiveDragMode,
  shouldDeferHeavyGraphBuild,
  shouldStartHeavyDrag,
  shouldInvalidateAfterDrag,
  updateRouteCost,
} from "./adaptive-policy.js";
import {
  orderedRouteResults,
  processRouteSlice,
  progressiveItemLimit,
  shouldProgressivelyRoute,
} from "./progressive.js";

// Subgraph boundary IO virtual node ids (ComfyUI frontend convention).
const SUBGRAPH_INPUT_ID = -10;
const SUBGRAPH_OUTPUT_ID = -20;

// --- node helpers ---

export function nodeRect(node) {
  node.getBounding(M.bounding);
  return { x: M.bounding[0], y: M.bounding[1], w: M.bounding[2], h: M.bounding[3] };
}

function cachedNodeRect(node, cache) {
  let rect = cache.get(node);
  if (!rect) {
    rect = nodeRect(node);
    cache.set(node, rect);
  }
  return rect;
}

function resolveNode(graph, id) {
  if (id === SUBGRAPH_INPUT_ID) return graph.inputNode || null;
  if (id === SUBGRAPH_OUTPUT_ID) return graph.outputNode || null;
  return graph.getNodeById?.(id) || null;
}

function ioSlotPos(ioNode, slot) {
  const s = ioNode?.slots?.[slot];
  const p = s?.pos;
  if (!p || !isFinite(p[0]) || !isFinite(p[1])) return null;
  return [p[0], p[1]];
}

// --- link collection ---
// Returns { entries, ioUnresolved }. ioUnresolved counts links that
// reference subgraph virtual IO nodes (-10/-20) we failed to resolve —
// only those trigger a full fallback to the official renderer.
// Links pointing at plain missing nodes (stale links after node
// deletion, floating links with origin_id -1, etc.) are silently
// skipped, matching the official renderer's behaviour — they must NOT
// disable SmartEdge for the whole canvas.
function collectLinks(graph) {
  const out = [];
  let ioUnresolved = 0;
  const links = graph.links;
  const each = (link) => {
    if (!link) return;
    const a = resolveNode(graph, link.origin_id);
    const b = resolveNode(graph, link.target_id);
    if (!a || !b) {
      if (
        link.origin_id === SUBGRAPH_INPUT_ID ||
        link.origin_id === SUBGRAPH_OUTPUT_ID ||
        link.target_id === SUBGRAPH_INPUT_ID ||
        link.target_id === SUBGRAPH_OUTPUT_ID
      )
        ioUnresolved++;
      return;
    }
    out.push({ link, a, b });
  };
  if (links instanceof Map) for (const l of links.values()) each(l);
  else for (const id in links) each(links[id]);
  return { entries: out, ioUnresolved };
}

// --- endpoints ---

// Try the Node 2.0-compatible API first (works in both legacy & Vue mode);
// fall back to getConnectionPos on older ComfyUI builds.
function getSlotPos(node, isInput, slotIndex) {
  if (isInput && typeof node.getInputPos === "function")
    return node.getInputPos(slotIndex);
  if (!isInput && typeof node.getOutputPos === "function")
    return node.getOutputPos(slotIndex);
  return node.getConnectionPos(isInput, slotIndex, [0, 0]);
}

function endpoints(entry, rectCache) {
  const { link, a, b } = entry;
  let p1 = null, p2 = null;
  try {
    p1 =
      link.origin_id === SUBGRAPH_INPUT_ID
        ? ioSlotPos(a, link.origin_slot)
        : getSlotPos(a, false, link.origin_slot);
    p2 =
      link.target_id === SUBGRAPH_OUTPUT_ID
        ? ioSlotPos(b, link.target_slot)
        : getSlotPos(b, true, link.target_slot);
  } catch {
    return null;
  }
  if (!p1 || !p2 || !isFinite(p1[0]) || !isFinite(p2[0])) return null;
  const mg = M.currentMargin();
  const ml = typeof mg === "number" ? mg : mg.l;
  const mr = typeof mg === "number" ? mg : mg.r;
  let sourceRect = null,
    targetRect = null;
  try {
    sourceRect = cachedNodeRect(a, rectCache);
    targetRect = cachedNodeRect(b, rectCache);
  } catch {
    // Virtual subgraph IO nodes may not expose a normal bounding box.
  }
  const bodyOutX = sourceRect ? sourceRect.x + sourceRect.w : p1[0];
  const bodyInX = targetRect ? targetRect.x : p2[0];
  return {
    out: { x: p1[0], y: p1[1] },
    inp: { x: p2[0], y: p2[1] },
    bodyOut: { x: bodyOutX, y: p1[1] },
    bodyIn: { x: bodyInX, y: p2[1] },
    // These points sit on the endpoint nodes' own clearance frames.
    // Starting six pixels beyond the frame could place a terminal inside
    // a tightly packed neighbouring node.
    stubOut: { x: bodyOutX + mr, y: p1[1] },
    stubIn: { x: bodyInX - ml, y: p2[1] },
  };
}

// --- layout signature ---

function layoutSignature(nodes, rectCache) {
  let s = "";
  for (const n of nodes) {
    const r = cachedNodeRect(n, rectCache);
    s += n.id + ":" + (r.x | 0) + "," + (r.y | 0) + "," + (r.w | 0) + "," + (r.h | 0) + ";";
  }
  return s;
}

// Repaint-only frames should not collect every slot and rebuild the route
// result array when the workflow geometry has not changed.
function fastGraphSignature(graph, canvas) {
  const nodes = graph._nodes || [];
  let s = "n" + nodes.length + ":";
  for (const n of nodes) {
    const p = n.pos || [0, 0];
    const z = n.size || [0, 0];
    s +=
      n.id + "," + (p[0] | 0) + "," + (p[1] | 0) + "," +
      (z[0] | 0) + "," + (z[1] | 0) + "," +
      (n.flags?.collapsed ? 1 : 0) + "," +
      (n.inputs?.length || 0) + "," + (n.outputs?.length || 0) + ";";
  }
  const links = graph.links;
  let count = 0;
  const add = (l) => {
    if (!l) return;
    count++;
    s +=
      l.id + "," + l.origin_id + "," + l.origin_slot + "," +
      l.target_id + "," + l.target_slot + ";";
  };
  if (links instanceof Map) for (const l of links.values()) add(l);
  else for (const id in links) add(links[id]);

  // Nodes 2.0 moves selected nodes through its layout store before (and in
  // some builds without) synchronising node.pos. Track the live bounding box
  // of only the interactive nodes so a drag cannot be mistaken for a static
  // repaint, while idle/pan/zoom frames keep the cheap fast path.
  const liveNodes = new Map();
  const selected = canvas?.selected_nodes;
  const values = selected instanceof Map
    ? selected.values()
    : Object.values(selected || {});
  for (const node of values) if (node?.id != null) liveNodes.set(node.id, node);
  const resizing = canvas?.resizing_node;
  if (resizing?.id != null) liveNodes.set(resizing.id, resizing);
  let live = "";
  for (const [id, node] of liveNodes) {
    try {
      const r = nodeRect(node);
      live += id + ":" + (r.x | 0) + "," + (r.y | 0) + "," +
        (r.w | 0) + "," + (r.h | 0) + ";";
    } catch {}
  }
  return s + "l" + count + "|b" + live;
}

// --- collision checks ---

function segHitsRects(x1, y1, x2, y2, rects) {
  const ax = Math.min(x1, x2) - 1,
    ax2 = Math.max(x1, x2) + 1;
  const ay = Math.min(y1, y2) - 1,
    ay2 = Math.max(y1, y2) + 1;
  for (const r of rects) if (ax < r.x2 && ax2 > r.x && ay < r.y2 && ay2 > r.y) return true;
  return false;
}

function pathHitsRects(pts, rects) {
  for (let k = 0; k < pts.length - 1; k++)
    if (segHitsRects(pts[k].x, pts[k].y, pts[k + 1].x, pts[k + 1].y, rects)) return true;
  return false;
}

function currentViewportRect() {
  const canvas = app.canvas;
  const scale = Math.max(0.0001, +canvas?.ds?.scale || 1);
  const offset = canvas?.ds?.offset || [0, 0];
  const element = canvas?.canvas;
  const x = -(+offset[0] || 0);
  const y = -(+offset[1] || 0);
  return {
    x,
    y,
    x2: x + ((element?.width || globalThis.innerWidth || 1) / scale),
    y2: y + ((element?.height || globalThis.innerHeight || 1) / scale),
  };
}

// --- refresh OVG ---

function refreshGraph(graph, linkEntries, rectCache, deferBuild = false) {
  const nodes = graph._nodes || [];
  const sig = layoutSignature(nodes, rectCache);
  if (sig === M.graphSig && !(M._deferredGraphBuild && !deferBuild))
    return {
      _rects: null,
      _movedIds: new Set(),
      _positionMovedIds: new Set(),
      _profile: { graphRebuilt: false },
    };

  const mg = M.currentMargin();
  const ml = typeof mg === "number" ? mg : mg.l,
    mr = typeof mg === "number" ? mg : mg.r,
    mt = typeof mg === "number" ? mg : mg.t,
    mb = typeof mg === "number" ? mg : mg.b;

  const rawRects = [];
  const newRects = new Map();
  for (const n of nodes) {
    const rc = cachedNodeRect(n, rectCache);
    rawRects.push(rc);
    newRects.set(n.id, {
      x: rc.x - ml,
      y: rc.y - mt,
      x2: rc.x + rc.w + mr,
      y2: rc.y + rc.h + mb,
    });
  }

  let buildMs = 0;
  if (deferBuild) {
    M._deferredGraphBuild = true;
  } else {
    const terminals = [];
    for (const e of linkEntries) {
      const ep = endpoints(e, rectCache);
      if (!ep) continue;
      // Include frame, body-edge, and slot points for endpoint escape/retry.
      terminals.push(ep.stubOut, ep.stubIn, ep.bodyOut, ep.bodyIn, ep.out, ep.inp);
    }
    const buildStarted = profiler.active ? performance.now() : 0;
    M.router.build(rawRects, terminals);
    buildMs = buildStarted
      ? Math.round((performance.now() - buildStarted) * 1000) / 1000
      : 0;
    M._deferredGraphBuild = false;
  }

  const dirty = [];
  const movedIds = new Set();
  const positionMovedIds = new Set();
  const profile = {
    graphRebuilt: !deferBuild,
    graphDeferred: deferBuild,
    positionChanges: 0,
    sizeChanges: 0,
    newNodes: 0,
    deletedNodes: 0,
    buildMs,
    geometry: [],
  };
  for (const [id, rc] of newRects) {
    const o = M.prevRects.get(id);
    if (!o || o.x !== rc.x || o.y !== rc.y || o.x2 !== rc.x2 || o.y2 !== rc.y2) {
      dirty.push(rc);
      movedIds.add(id);
      if (o) {
        dirty.push(o);
        const dx = rc.x - o.x, dy = rc.y - o.y;
        const dw = (rc.x2 - rc.x) - (o.x2 - o.x);
        const dh = (rc.y2 - rc.y) - (o.y2 - o.y);
        if (dx || dy) {
          profile.positionChanges++;
          positionMovedIds.add(id);
        }
        if (dw || dh) profile.sizeChanges++;
        if (profiler.active && profile.geometry.length < 40)
          profile.geometry.push({ id, dx: roundedGeometry(dx), dy: roundedGeometry(dy), dw: roundedGeometry(dw), dh: roundedGeometry(dh) });
      } else {
        profile.newNodes++;
        if (profiler.active && profile.geometry.length < 40)
          profile.geometry.push({ id, added: true });
      }
    }
  }
  for (const [id, o] of M.prevRects) {
    if (newRects.has(id)) continue;
    dirty.push(o);
    profile.deletedNodes++;
    if (profiler.active && profile.geometry.length < 40)
      profile.geometry.push({ id, deleted: true });
  }
  M.prevRects = newRects;
  M.graphSig = sig;

  // Drag-settle keeps the presentation modes separate from background
  // progressive routing. On release, only hidden/sticky lines and frozen
  // lines that collide with the final node position are invalidated.
  const pointerHeld = M._pointerDown || !!app.canvas?.last_mouse_dragging;
  const interactiveChange = shouldUseDragSettle(pointerHeld, profile, app.canvas);
  if (interactiveChange) {
    M._nodeDragActive = true;
    M._dragPauseActive = false;
    M._dragPausePending = false;
    M._dragPauseQueue = null;
    M._dragPauseCleanupLinkIds.clear();
    M._dragPauseAttemptedLinkIds.clear();
    M._dragPauseCompletedLinkIds.clear();
    if (M.settleTimer) clearTimeout(M.settleTimer);
    const finishSettle = () => {
      if (M._pointerDown) {
        const firstPauseFrame = !M._dragPauseActive;
        M._dragPauseActive = true;
        if (firstPauseFrame || M._dragPausePending) {
          M.routeFastSig = "";
          app.canvas?.setDirty(false, true);
        }
        M.settleTimer = setTimeout(finishSettle, 80);
        return;
      }
      M.settleTimer = null;
      const movedIds = M._dragMovedIds || new Set();
      const finalRects = [];
      for (const id of movedIds) {
        const rect = M.prevRects.get(id);
        if (rect) finalRects.push(rect);
      }
      const hiddenIds = M._dragHiddenLinkIds;
      const affectedIds = M._dragAffectedLinkIds;
      let hiddenLinks = hiddenIds.size;
      let affectedLinks = affectedIds.size;
      let collisionLinks = 0;
      let stickyLinks = 0;
      let hadStale = M._dragInterruptedBatch || hiddenIds.size > 0 || affectedIds.size > 0;
      for (const [linkId, cached] of M.pathCache) {
        const collides = !!(
          cached._frozen &&
          cached.pts &&
          finalRects.length > 0 &&
          pathHitsRects(cached.pts, finalRects)
        );
        const draggedHidden = cached._draggedHidden || hiddenIds.has(linkId);
        if (cached.sticky) stickyLinks++;
        if (cached._frozen && collides) collisionLinks++;
        if (
          shouldInvalidateAfterDrag(
            {
              affected: affectedIds.has(linkId),
              draggedHidden,
              sticky: cached.sticky,
              frozen: cached._frozen,
            },
            collides,
          )
        ) {
          cached.ends = null;
          cached.sticky = false;
          hadStale = true;
        }
        delete cached._draggedHidden;
        delete cached._frozen;
      }
      M._dragMovedIds = null;
      M._dragAdaptiveMode = null;
      M._dragHeavyActive = null;
      M._dragLastFastSig = "";
      M._dragHiddenLinkIds = new Set();
      M._dragAffectedLinkIds = new Set();
      M._dragPauseActive = false;
      M._dragPausePending = false;
      M._dragPauseQueue = null;
      M._dragPauseCleanupLinkIds = new Set();
      M._dragPauseAttemptedLinkIds = new Set();
      M._dragPauseCompletedLinkIds = new Set();
      M._dragInterruptedBatch = false;
      M._nodeDragActive = false;
      M._lastDragSettle = { hiddenLinks, affectedLinks, collisionLinks, stickyLinks };
      if (hadStale) {
        M.routeFastSig = "";
      }
      // Redraw even when all routes remain valid: unrelated selected links
      // switch from drag opacity back to the normal selected opacity.
      app.canvas?.setDirty(false, true);
    };
    M.settleTimer = setTimeout(finishSettle, 180);
  }
  return {
    _rects: dirty,
    _movedIds: movedIds,
    _positionMovedIds: positionMovedIds,
    _profile: profile,
  };
}

function roundedGeometry(v) {
  return Math.round(v * 1000) / 1000;
}

function reportRouteProfile(startedAt, stats) {
  if (!startedAt) return;
  profiler.recordRoute({
    durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
    ...stats,
  });
}

function rememberRouteCost(linkId, elapsedMs) {
  const previous = M.routeCostByLink.get(linkId);
  M.routeCostByLink.set(linkId, updateRouteCost(previous, elapsedMs));
  M.routeCostAverage = updateRouteCost(M.routeCostAverage, elapsedMs, 0.08);
}

function predictedRouteCost(linkIds) {
  const fallback = Number.isFinite(M.routeCostAverage)
    ? Math.max(6, M.routeCostAverage)
    : 8;
  let total = 0;
  for (const id of linkIds) total += M.routeCostByLink.get(id) ?? fallback;
  return total;
}

const PROGRESSIVE_BUDGET_MS = 12;

function cancelProgressiveBatch() {
  if (M.routeBatchRaf) {
    const cancel = globalThis.cancelAnimationFrame || globalThis.clearTimeout;
    cancel?.(M.routeBatchRaf);
  }
  M.routeBatch = null;
  M.routeBatchRaf = 0;
}

function scheduleProgressiveBatch() {
  if (M.routeBatchRaf) return;
  const schedule = globalThis.requestAnimationFrame || ((fn) => setTimeout(fn, 0));
  M.routeBatchRaf = schedule(() => {
    M.routeBatchRaf = 0;
    if (M.routeBatch) app.canvas?.setDirty(false, true);
  });
}

function cleanupDeadPaths(entries) {
  if (M.pathCache.size <= entries.length) return;
  const alive = new Set(entries.map((e) => e.link.id));
  for (const id of M.pathCache.keys()) {
    if (alive.has(id)) continue;
    M.pathCache.delete(id);
    M.routeCostByLink.delete(id);
  }
}

function finishStableRoutes(batch, results) {
  cleanupDeadPaths(batch.entries);
  M.routeBatch = null;
  M.routeGraph = batch.graph;
  M.routeFastSig = batch.fastSig;
  M.routeResults = results;
}

function continueStableRoutes(batch, profileStarted) {
  let connectorMs = 0;
  const routeOne = (job) => {
    const started = performance.now();
    const pts = M.router.routeConnector(
      job.ep.out,
      job.ep.bodyOut,
      job.ep.stubOut,
      job.ep.stubIn,
      job.ep.bodyIn,
      job.ep.inp,
    );
    const elapsed = performance.now() - started;
    connectorMs += elapsed;
    rememberRouteCost(job.entry.link.id, elapsed);
    if (!pts) return null;
    const cached = { ends: job.endsKey, sticky: false };
    setCachedPath(cached, pts);
    M.pathCache.set(job.entry.link.id, cached);
    return { entry: job.entry, cached };
  };

  const maxItems = batch.progressive
    ? progressiveItemLimit(batch.jobs.length, M.S.routeBatchPercent)
    : Infinity;
  const slice = processRouteSlice(batch, routeOne, {
    maxItems,
    budgetMs: batch.progressive ? PROGRESSIVE_BUDGET_MS : Infinity,
  });
  const results = orderedRouteResults(batch.entries, batch.resultsById);
  const profile = batch.firstFrame ? batch.profile : { graphRebuilt: false };
  reportRouteProfile(profileStarted, {
    fastHit: false,
    ...profile,
    progressive: batch.progressive,
    queuedLinks: batch.jobs.length,
    batchRemaining: slice.remaining,
    reroutedLinks: slice.processed,
    connectorCalls: slice.processed,
    connectorMs: roundedGeometry(connectorMs),
    links: batch.entries.length,
  });
  batch.firstFrame = false;

  if (slice.done) finishStableRoutes(batch, results);
  else {
    M.routeBatch = batch;
    M.routeGraph = batch.graph;
    M.routeFastSig = "";
    M.routeResults = results;
    scheduleProgressiveBatch();
  }
  return results;
}

function prepareStableRoutes(graph, fastSig, entries, rectCache, dirty, profileStarted, forceSync) {
  const resultsById = new Map();
  const jobs = [];
  for (const entry of entries) {
    const ep = endpoints(entry, rectCache);
    if (!ep) {
      const io =
        entry.link.origin_id === SUBGRAPH_INPUT_ID ||
        entry.link.target_id === SUBGRAPH_OUTPUT_ID;
      if (io) {
        reportRouteProfile(profileStarted, {
          fastHit: false,
          ...dirty._profile,
          reroutedLinks: 0,
          fallback: "subgraph-endpoint",
        });
        return null;
      }
      continue;
    }
    const endsKey =
      (ep.out.x | 0) + "," + (ep.out.y | 0) + "|" + (ep.inp.x | 0) + "," + (ep.inp.y | 0);
    const cached = M.pathCache.get(entry.link.id);
    const endsMoved = !cached || cached.ends !== endsKey;
    const hitDirty = dirty._rects && cached?.pts && pathHitsRects(cached.pts, dirty._rects);
    if (endsMoved || hitDirty) jobs.push({ entry, ep, endsKey });
    else if (cached?.pts) resultsById.set(entry.link.id, { entry, cached });
  }

  const progressive = shouldProgressivelyRoute(false, forceSync, jobs.length);
  const batch = {
    graph,
    fastSig,
    entries,
    jobs,
    index: 0,
    resultsById,
    profile: dirty._profile,
    firstFrame: true,
    progressive,
  };
  if (progressive) M.routeBatch = batch;
  return continueStableRoutes(batch, profileStarted);
}

// --- path stretch (drag anti-flicker) ---

function stretchPath(oldPts, ep) {
  if (!oldPts || oldPts.length < 4) return null;
  const pts = oldPts.map((p) => ({ x: p.x, y: p.y }));
  const oldN = pts.length;
  pts[0] = ep.out;
  pts[1] = { x: ep.stubOut.x, y: ep.stubOut.y };
  pts[oldN - 1] = ep.inp;
  pts[oldN - 2] = { x: ep.stubIn.x, y: ep.stubIn.y };

  // A formerly straight four-point connector becomes diagonal when one end
  // moves vertically.  Insert a temporary centre dogleg so it can remain
  // sticky instead of invoking A* on every drag frame.
  if (
    oldN === 4 &&
    Math.abs(pts[1].x - pts[2].x) > 0.6 &&
    Math.abs(pts[1].y - pts[2].y) > 0.6
  ) {
    const mx = (pts[1].x + pts[2].x) / 2;
    pts.splice(2, 0, { x: mx, y: pts[1].y }, { x: mx, y: pts[2].y });
  } else if (oldN >= 5) {
    const n = pts.length;
    const a = pts[1], b = pts[2];
    if (Math.abs(oldPts[1].y - oldPts[2].y) < 0.6) b.y = a.y;
    else b.x = a.x;
    const y = pts[n - 2], z = pts[n - 3];
    if (Math.abs(oldPts[n - 2].y - oldPts[n - 3].y) < 0.6) z.y = y.y;
    else z.x = y.x;
  }
  for (let k = 0; k < pts.length - 1; k++) {
    if (Math.abs(pts[k].x - pts[k + 1].x) > 0.6 && Math.abs(pts[k].y - pts[k + 1].y) > 0.6)
      return null;
  }
  const raw = M.router.raw || [];
  const sourceIndex = M.router._endpointRectIndex(ep.bodyOut, ep.stubOut, true);
  const targetIndex = M.router._endpointRectIndex(ep.bodyIn, ep.stubIn, false);
  if (stretchedPathCrossesUnexpectedNode(pts, raw, sourceIndex, targetIndex)) return null;
  return pts;
}

// --- cache + precompute ---

export function setCachedPath(cached, pts) {
  cached.pts = pts;
  const segs = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x,
      dy = pts[i + 1].y - pts[i].y;
    const len = Math.abs(dx) + Math.abs(dy);
    segs.push({ a: pts[i], dx, dy, len, start: total, ang: Math.atan2(dy, dx) });
    total += len;
  }
  cached.segs = segs;
  cached.total = total;
}

// --- main routing entry point ---

export function routeAll(graph) {
  const profileStarted = profiler.active ? performance.now() : 0;
  if (M.routeGraph && M.routeGraph !== graph) {
    cancelProgressiveBatch();
    M.graphSig = "";
    M.routeFastSig = "";
    M.routeResults = null;
    M.prevRects = new Map();
    M.pathCache.clear();
    M.routeCostByLink.clear();
    M.routeCostAverage = NaN;
    M._dragAdaptiveMode = null;
    M._dragHeavyActive = null;
    M._dragLastFastSig = "";
    M._deferredGraphBuild = false;
  }
  const fastSig = fastGraphSignature(graph, app.canvas);
  if (M.routeBatch) {
    if (M.routeBatch.graph === graph && M.routeBatch.fastSig === fastSig)
      return continueStableRoutes(M.routeBatch, profileStarted);
    if (M._pointerDown) M._dragInterruptedBatch = true;
    cancelProgressiveBatch();
    M.routeFastSig = "";
  }
  if (M.routeGraph === graph && fastSig === M.routeFastSig && M.routeResults) {
    reportRouteProfile(profileStarted, { fastHit: true, graphRebuilt: false, reroutedLinks: 0 });
    return M.routeResults;
  }

  const { entries, ioUnresolved } = collectLinks(graph);
  if (ioUnresolved > 0) {
    reportRouteProfile(profileStarted, { fastHit: false, graphRebuilt: false, reroutedLinks: 0, fallback: "subgraph-io" });
    return null;
  }
  const dragMode = M.S.dragMode || "adaptive";
  const nodes = graph._nodes || [];
  if (
    M._dragHeavyActive &&
    M._pointerDown &&
    M._dragLastFastSig &&
    fastSig !== M._dragLastFastSig
  ) {
    // A held pause has resumed moving. Return to the deferred scheduler before
    // refreshGraph so the first resumed frame does not pay a full OVG build.
    M._dragPauseActive = false;
    M._dragPausePending = false;
    M._dragPauseQueue = null;
    M._dragPauseCleanupLinkIds.clear();
    M._dragPauseAttemptedLinkIds.clear();
    M._dragPauseCompletedLinkIds.clear();
  }
  const deferHeavyBuild = shouldDeferHeavyGraphBuild(
    M._dragHeavyActive,
    M._pointerDown,
    M._dragPauseActive,
    M.routeGraph === graph && !!M.routeResults,
  );
  const rectCache = new Map();
  const dirty = refreshGraph(graph, entries, rectCache, deferHeavyBuild);
  if (M._lastDragSettle) {
    dirty._profile.dragSettle = M._lastDragSettle;
    M._lastDragSettle = null;
  }
  const pointerGeometryDragging = M._pointerDown && (
    dirty._positionMovedIds.size > 0 || !!app.canvas?.resizing_node
  );
  if (M._dragHeavyActive === null && pointerGeometryDragging) {
    M._dragHeavyActive = shouldStartHeavyDrag(
      dragMode,
      nodes.length,
      entries.length,
      pointerGeometryDragging,
    );
  }
  if (pointerGeometryDragging) M._nodeDragActive = true;
  const rawDragging = M.settleTimer !== null || pointerGeometryDragging;

  // Persist only actual position changes (or an explicit resize handle).
  // Vue/DOM size settling must not inflate Adaptive's dragged-link count.
  const resizeIds = app.canvas?.resizing_node ? dirty._movedIds : new Set();
  const frameMovedIds = dirty._positionMovedIds.size > 0
    ? dirty._positionMovedIds
    : resizeIds;
  const prevMoved = M._dragMovedIds || frameMovedIds;
  const isBulkChange = !M._pointerDown && prevMoved && prevMoved.size > 0 &&
    (prevMoved.size > nodes.length * 0.6 || prevMoved.size > 15);
  if (rawDragging && frameMovedIds.size > 0 && !isBulkChange)
    M._dragMovedIds = new Set([...(M._dragMovedIds || []), ...frameMovedIds]);
  const movedIds = M._dragMovedIds || frameMovedIds;

  const draggedLinkIds = new Set();
  const collisionLinkIds = new Set();
  const heavyMoving = M._dragHeavyActive && M._pointerDown && !M._dragPauseActive;
  const collisionRects = heavyMoving
    ? null
    : M._dragPauseActive
    ? [...movedIds].map((id) => M.prevRects.get(id)).filter(Boolean)
    : dirty._rects;
  if (movedIds.size > 0) {
    for (const entry of entries) {
      const direct =
        movedIds.has(entry.link.origin_id) || movedIds.has(entry.link.target_id);
      if (direct) {
        draggedLinkIds.add(entry.link.id);
        continue;
      }
      const cached = M.pathCache.get(entry.link.id);
      if (collisionRects?.length && cached?.pts && pathHitsRects(cached.pts, collisionRects))
        collisionLinkIds.add(entry.link.id);
    }
  }
  const activeLinkIds = new Set([...draggedLinkIds, ...collisionLinkIds]);
  for (const linkId of collisionLinkIds) M._dragAffectedLinkIds.add(linkId);
  const predictedMs = predictedRouteCost(draggedLinkIds);

  let effectiveMode = dragMode;
  if (effectiveMode === "adaptive" && movedIds.size > 0 && !isBulkChange) {
    effectiveMode = lockAdaptiveDragMode(
      M._dragAdaptiveMode,
      draggedLinkIds.size,
      predictedMs,
    );
    M._dragAdaptiveMode = effectiveMode;
  }
  // Heavy workflows use the proven ghost presentation while the pointer is
  // held. The locked normal mode remains available for diagnostics and is
  // restored when the gesture settles.
  if (
    (dragMode === "adaptive" || dragMode === "heavy-deferred") &&
    M._dragHeavyActive &&
    M._pointerDown
  )
    effectiveMode = "hide-self";
  M._lastDragMode = effectiveMode;

  if (M._dragPauseActive && M._dragPauseQueue === null) {
    const primaryCandidates = [];
    const primaryIds = new Set();
    for (const entry of entries) {
      const direct = draggedLinkIds.has(entry.link.id);
      const collision = collisionLinkIds.has(entry.link.id);
      const includeDirect = effectiveMode === "hide-self" && direct;
      const includeCollision = shouldRouteHeldCollision(
        effectiveMode,
        true,
        collision,
        false,
      );
      if (!includeDirect && !includeCollision) continue;
      primaryIds.add(entry.link.id);
      primaryCandidates.push({
        id: entry.link.id,
        direct: includeDirect,
        bounds: pathBounds(M.pathCache.get(entry.link.id)?.pts),
      });
    }
    const cleanupCandidates = [];
    // Only Freeze+Check can live-reroute an unrelated collision while moving.
    // Once primary work is done, quietly restore those no-longer-colliding
    // paths to their shorter final route using the remaining idle budget.
    if (effectiveMode === "freeze-others") {
      for (const entry of entries) {
        const linkId = entry.link.id;
        if (!shouldQueueIdleCleanup(
          effectiveMode,
          M._dragAffectedLinkIds.has(linkId),
          primaryIds.has(linkId),
          !!M.pathCache.get(linkId)?.pts,
        )) continue;
        cleanupCandidates.push({
          id: linkId,
          direct: false,
          bounds: pathBounds(M.pathCache.get(linkId).pts),
        });
      }
    }
    const viewport = currentViewportRect();
    const primaryQueue = orderHeldRouteCandidates(primaryCandidates, viewport);
    const cleanupQueue = orderHeldRouteCandidates(cleanupCandidates, viewport);
    M._dragPauseCleanupLinkIds = new Set(cleanupQueue.map((item) => item.id));
    M._dragPauseQueue = [...primaryQueue, ...cleanupQueue].map((item) => item.id);
  }
  const pauseNextLinkId = M._dragPauseActive ? M._dragPauseQueue?.[0] : null;

  // Mode 4: pointer held down (even paused) keeps links hidden.
  const dragging = rawDragging ||
    (effectiveMode === "hide-self" && M._pointerDown);
  if (!dragging) {
    M._dragLastFastSig = fastSig;
    return prepareStableRoutes(
      graph,
      fastSig,
      entries,
      rectCache,
      dirty,
      profileStarted,
      false,
    );
  }

  const results = [];
  let reroutedLinks = 0;
  let connectorCalls = 0;
  let connectorMs = 0;
  let hiddenDraggedLinks = 0;
  let heldCollisionReroutes = 0;
  let heldDirectReroutes = 0;
  let heldCleanupReroutes = 0;
  let liveCollisionReroutes = 0;
  const collisionBudget = liveCollisionBudget(effectiveMode, draggedLinkIds.size);

  for (const e of entries) {
    let pauseRoute = false;
    let pauseDirect = false;
    // --- drag behaviour ---
    if (dragging && movedIds.size > 0) {
      const isDragged = draggedLinkIds.has(e.link.id);
      const existing = M.pathCache.get(e.link.id);
      const isCollision = collisionLinkIds.has(e.link.id);
      const isPauseNext = pauseNextLinkId === e.link.id;
      const heldDirect = isPauseNext && isDragged && effectiveMode === "hide-self";
      const heldCollision = isPauseNext && shouldRouteHeldCollision(
        effectiveMode,
        M._dragPauseActive,
        isCollision,
        M._dragPauseAttemptedLinkIds.has(e.link.id),
      );
      const heldCleanup = isPauseNext && M._dragPauseCleanupLinkIds.has(e.link.id);
      pauseRoute = heldDirect || heldCollision || heldCleanup;
      pauseDirect = heldDirect;
      const liveCollision =
        effectiveMode === "freeze-others" &&
        !M._dragPauseActive &&
        isCollision &&
        liveCollisionReroutes < collisionBudget;

      // A progressive queue may not have reached this unrelated link yet.
      // Never start background work merely because a drag interrupted it.
      if (!isDragged && !existing?.pts) continue;

      if (effectiveMode === "hide-self") {
        if (isDragged) {
          if (
            M._dragPauseActive &&
            M._dragPauseCompletedLinkIds.has(e.link.id) &&
            existing?.pts
          ) {
            results.push({ entry: e, cached: existing });
            continue;
          }
          if (heldDirect) {
            heldDirectReroutes++;
          } else {
            M._dragHiddenLinkIds.add(e.link.id);
            if (existing?.pts) existing._draggedHidden = true;
            hiddenDraggedLinks++;
            continue;
          }
        }
        if (shouldFreezeHiddenModeLink(isDragged, !!existing?.pts, heldCollision)) {
          existing._frozen = true;
          results.push({ entry: e, cached: existing });
          continue;
        }
      }
      if (effectiveMode === "freeze-others-strict" && !isDragged) {
        if (existing?.pts && !pauseRoute) {
          existing._frozen = true;
          results.push({ entry: e, cached: existing });
          continue;
        }
      }
      if (effectiveMode === "freeze-others" && !isDragged) {
        if (existing?.pts && !pauseRoute && !liveCollision) {
          existing._frozen = true;
          results.push({ entry: e, cached: existing });
          continue;
        }
        // A bounded number of collisions route live; held pauses route one.
      }
      // "none" → fall through to normal routing
      if (heldCollision) {
        heldCollisionReroutes++;
      } else if (heldCleanup) {
        heldCleanupReroutes++;
      } else if (liveCollision) {
        liveCollisionReroutes++;
      }
    }

    const finishPauseRoute = (completed, cached = null) => {
      if (!pauseRoute) return;
      M._dragPauseAttemptedLinkIds.add(e.link.id);
      if (M._dragPauseQueue?.[0] === e.link.id) M._dragPauseQueue.shift();
      if (!completed) return;
      M._dragPauseCompletedLinkIds.add(e.link.id);
      if (pauseDirect) {
        M._dragHiddenLinkIds.delete(e.link.id);
        if (cached) delete cached._draggedHidden;
      }
    };

    const ep = endpoints(e, rectCache);
    if (!ep) {
      const io =
        e.link.origin_id === SUBGRAPH_INPUT_ID ||
        e.link.target_id === SUBGRAPH_OUTPUT_ID;
      if (io) {
        reportRouteProfile(profileStarted, {
          fastHit: false,
          ...dirty._profile,
          reroutedLinks,
          connectorCalls,
          connectorMs: roundedGeometry(connectorMs),
          fallback: "subgraph-endpoint",
        });
        finishPauseRoute(false);
        return null;
      }
      finishPauseRoute(false);
      continue;
    }
    const endsKey =
      (ep.out.x | 0) + "," + (ep.out.y | 0) + "|" + (ep.inp.x | 0) + "," + (ep.inp.y | 0);
    let cached = M.pathCache.get(e.link.id);
    const endsMoved = !cached || cached.ends !== endsKey;
    const hitDirty = collisionLinkIds.has(e.link.id);

    if (endsMoved || hitDirty || pauseRoute) {
      reroutedLinks++;
      let pts = null, sticky = false;
      if (!pauseRoute && M.S.stickiness && shouldStretchDragPath({
        dragging,
        hasCachedPath: !!cached?.pts,
        endsMoved,
        hitDirty,
        effectiveMode,
      })) {
        pts = stretchPath(cached.pts, ep);
        sticky = !!pts;
      }
      if (!pts) {
        const connectorStarted = performance.now();
        pts = M.router.routeConnector(
          ep.out,
          ep.bodyOut,
          ep.stubOut,
          ep.stubIn,
          ep.bodyIn,
          ep.inp,
        );
        const elapsed = performance.now() - connectorStarted;
        connectorCalls++;
        connectorMs += elapsed;
        rememberRouteCost(e.link.id, elapsed);
      }
      // A physically overlapping layout can genuinely have no legal path.
      // Never replace that with a fallback which cuts through a node.
      if (!pts) {
        finishPauseRoute(false);
        continue;
      }
      cached = { ends: endsKey, sticky };
      setCachedPath(cached, pts);
      M.pathCache.set(e.link.id, cached);
    }
    finishPauseRoute(!!cached?.pts, cached);
    results.push({ entry: e, cached });
  }

  cleanupDeadPaths(entries);
  M._dragPausePending = !!(M._dragPauseActive && M._dragPauseQueue?.length);
  const nextDragMode = effectiveMode;
  M.routeGraph = graph;
  M.routeFastSig = fastSig;
  M._dragLastFastSig = fastSig;
  M.routeResults = results;
  reportRouteProfile(profileStarted, {
    fastHit: false,
    ...dirty._profile,
    reroutedLinks,
    connectorCalls,
    connectorMs: roundedGeometry(connectorMs),
    dragging: true,
    requestedDragMode: dragMode,
    effectiveDragMode: effectiveMode,
    lockedDragMode: M._dragAdaptiveMode,
    heavyDrag: !!M._dragHeavyActive,
    nextDragMode,
    draggedNodes: movedIds.size,
    draggedLinks: draggedLinkIds.size,
    collisionLinks: collisionLinkIds.size,
    activeLinks: activeLinkIds.size,
    predictedMs: roundedGeometry(predictedMs),
    liveCollisionBudget: Number.isFinite(collisionBudget) ? collisionBudget : "all",
    liveCollisionReroutes,
    heldCollisionReroutes,
    heldDirectReroutes,
    heldCleanupReroutes,
    pauseQueueRemaining: M._dragPauseQueue?.length || 0,
    hiddenDraggedLinks,
    visibleLinks: results.length,
    links: entries.length,
  });
  return results;
}
