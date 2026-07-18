// routing.js — link routing core for LinkRouter.
//
// Reads shared state from M in state.js.
// Uses currentMargin() / resetRouter() from state.js.
// Exports routeAll for draw.js and nodeRect for ui.js.

import { app } from "../../scripts/app.js";
import { M } from "./state.js";
import { stretchPathPure } from "./stretch.js";
import { profiler } from "./profiler.js";
import {
  orderHeldRouteCandidates,
  pathBounds,
  pauseRevealCount,
  shouldFreezeHiddenModeLink,
  shouldQueueIdleCleanup,
  shouldRacePauseLink,
  shouldRouteHeldCollision,
  shouldStretchDragPath,
  shouldUseDragSettle,
} from "./drag-policy.js";
import {
  escalateLockedDragMode,
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
import {
  cancelWorkerBatch,
  dispatchWorkerBatch,
  initWorkerClient,
  workerRoutingUsable,
} from "./worker-client.js";

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

// Order-sensitive 52-bit rolling hash (two 26-bit lanes) used for change
// detection only.  Replaces the previous per-frame string concatenation,
// which allocated tens of KB of garbage every frame on large workflows.
function sigStep(h, v) {
  h.a = Math.imul(h.a ^ v, 16777619);
  h.b = Math.imul(h.b ^ v, 3347671);
}
function sigDone(h) {
  return (h.a & 0x3ffffff) * 67108864 + (h.b & 0x3ffffff);
}

function layoutSignature(nodes, rectCache) {
  const h = { a: 0x811c9dc5, b: 0x01000193 };
  for (const n of nodes) {
    const r = cachedNodeRect(n, rectCache);
    sigStep(h, n.id | 0);
    sigStep(h, r.x | 0);
    sigStep(h, r.y | 0);
    sigStep(h, r.w | 0);
    sigStep(h, r.h | 0);
  }
  return sigDone(h);
}

// Repaint-only frames should not collect every slot and rebuild the route
// result array when the workflow geometry has not changed.
function fastGraphSignature(graph, canvas) {
  const nodes = graph._nodes || [];
  const h = { a: 0x811c9dc5, b: 0x01000193 };
  sigStep(h, nodes.length);
  for (const n of nodes) {
    const p = n.pos || [0, 0];
    const z = n.size || [0, 0];
    sigStep(h, n.id | 0);
    sigStep(h, p[0] | 0);
    sigStep(h, p[1] | 0);
    sigStep(h, z[0] | 0);
    sigStep(h, z[1] | 0);
    sigStep(h, n.flags?.collapsed ? 1 : 0);
    sigStep(h, (n.inputs?.length || 0) | 0);
    sigStep(h, (n.outputs?.length || 0) | 0);
  }
  const links = graph.links;
  let count = 0;
  const add = (l) => {
    if (!l) return;
    count++;
    sigStep(h, l.id | 0);
    sigStep(h, l.origin_id | 0);
    sigStep(h, l.origin_slot | 0);
    sigStep(h, l.target_id | 0);
    sigStep(h, l.target_slot | 0);
  };
  if (links instanceof Map) for (const l of links.values()) add(l);
  else for (const id in links) add(links[id]);
  sigStep(h, count);

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
  for (const [id, node] of liveNodes) {
    try {
      const r = nodeRect(node);
      sigStep(h, id | 0);
      sigStep(h, r.x | 0);
      sigStep(h, r.y | 0);
      sigStep(h, r.w | 0);
      sigStep(h, r.h | 0);
    } catch {}
  }
  return sigDone(h);
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
    cancelDragPauseWorker();
    M._dragPauseActive = false;
    M._dragPausePending = false;
    M._dragPauseQueue = null;
    M._dragPauseCleanupLinkIds.clear();
    M._dragPauseAttemptedLinkIds.clear();
    M._dragPauseCompletedLinkIds.clear();
    clearPauseReveals(); // geometry moved on: queued paths are stale
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
      cancelDragPauseWorker();
      flushPauseReveals(); // pause geometry is final: apply pending reveals now
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

function rememberRouteCost(linkId, elapsedMs, onMainThread = false) {
  const previous = M.routeCostByLink.get(linkId);
  M.routeCostByLink.set(linkId, updateRouteCost(previous, elapsedMs));
  M.routeCostAverage = updateRouteCost(M.routeCostAverage, elapsedMs, 0.08);
  // The pause race only trusts costs measured on this thread: worker timings
  // come from a cold-JIT VM and do not predict main-thread route cost.
  if (onMainThread) {
    const prevMT = M.routeCostByLinkMT.get(linkId);
    M.routeCostByLinkMT.set(linkId, updateRouteCost(prevMT, elapsedMs));
  }
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
  clearWorkerRescue();
  if (M.routeBatch?.worker) cancelWorkerBatch();
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

// --- worker routing (Phase D) ---
//
// Only the stable (non-drag) path is eligible, and only for batches large
// enough that a worker round-trip beats same-frame latency. Drag routing and
// small interactive batches stay synchronous on the main thread — identical
// to previous behaviour. The worker runs the very same router.js with the
// same margin/bendPenalty and no heuristic opts, so worker routes are
// bit-identical to the sync stable path.

const WORKER_MIN_JOBS = 8;
const WORKER_MIN_MS = 24;

function workerEligibleFor(jobs) {
  if (!workerRoutingUsable()) return false;
  if (jobs.length >= WORKER_MIN_JOBS) return true;
  return predictedRouteCost(jobs.map((j) => j.entry.link.id)) >= WORKER_MIN_MS;
}

// The main-thread router is also the drag/stretch backend, so its build is
// deferred on stable worker frames. Any path that needs a fresh main router
// (sync routing, sticky validation with pending failures) forces it here.
function ensureMainRouterFresh(graph, entries, rectCache) {
  if (M._deferredGraphBuild) refreshGraph(graph, entries, rectCache, false);
}

function buildWorkerPayload(batch, rectCache) {
  const nodes = batch.graph._nodes || [];
  const rects = new Float64Array(nodes.length * 4);
  for (let i = 0; i < nodes.length; i++) {
    const rc = cachedNodeRect(nodes[i], rectCache);
    rects[4 * i] = rc.x;
    rects[4 * i + 1] = rc.y;
    rects[4 * i + 2] = rc.w;
    rects[4 * i + 3] = rc.h;
  }
  // Same terminal set as refreshGraph's main-thread build.
  const terminals = [];
  for (const e of batch.entries) {
    const ep = endpoints(e, rectCache);
    if (!ep) continue;
    terminals.push(
      ep.stubOut.x, ep.stubOut.y, ep.stubIn.x, ep.stubIn.y,
      ep.bodyOut.x, ep.bodyOut.y, ep.bodyIn.x, ep.bodyIn.y,
      ep.out.x, ep.out.y, ep.inp.x, ep.inp.y,
    );
  }
  const jobs = batch.jobs.map((job) => {
    const ep = job.ep;
    const old = M.pathCache.get(job.entry.link.id)?.pts;
    let oldPts = null;
    if (old && old.length >= 4) {
      oldPts = new Float64Array(old.length * 2);
      for (let i = 0; i < old.length; i++) {
        oldPts[2 * i] = old[i].x;
        oldPts[2 * i + 1] = old[i].y;
      }
    }
    return {
      id: job.entry.link.id,
      endsKey: job.endsKey,
      opts: job.opts || null,
      oldPts,
      pts: [
        ep.out.x, ep.out.y, ep.bodyOut.x, ep.bodyOut.y,
        ep.stubOut.x, ep.stubOut.y, ep.stubIn.x, ep.stubIn.y,
        ep.bodyIn.x, ep.bodyIn.y, ep.inp.x, ep.inp.y,
      ],
    };
  });
  const margin = M.currentMargin();
  const bendPenalty = +M.S.bendPenalty || 40;
  return {
    type: "route",
    graphRev: batch.fastSig,
    configKey: JSON.stringify({ margin, bendPenalty }),
    margin,
    bendPenalty,
    rects,
    terminals: new Float64Array(terminals),
    jobs,
  };
}

function tryDispatchWorkerBatch(batch, rectCache) {
  const jobRev = dispatchWorkerBatch(buildWorkerPayload(batch, rectCache));
  if (jobRev === false) return false;
  batch.worker = true;
  batch.jobRev = jobRev;
  M.routeBatch = batch;
  armWorkerRescue(batch);
  return true;
}

// --- stalled-worker rescue ---
// A healthy worker batch streams its first results within ~100-300ms. Hard
// exact searches can grind for seconds on the cold worker (measured ~16x
// slower per pop than the hot main thread), and while the canvas is idle no
// frames run — so a frame-driven check would never fire. Arm a timer: a
// batch with no new result for WORKER_RESCUE_MS is cancelled and continued
// on the main thread by the regular progressive machinery.
const WORKER_RESCUE_MS = 400;
let workerRescueTimer = 0;

function clearWorkerRescue() {
  clearTimeout(workerRescueTimer);
  workerRescueTimer = 0;
}

function rescueWorkerBatch(batch) {
  clearWorkerRescue();
  cancelWorkerBatch(); // rev-bump stales late results; the worker aborts at its chunk boundary
  batch.worker = false;
  batch.workerRescued = true;
  // Results that already streamed in stay valid; only the remainder is
  // re-queued for the main-thread progressive drain.
  batch.jobs = batch.jobs.filter((j) => !batch.resultsById.has(j.entry.link.id));
  batch.jobsById = new Map(batch.jobs.map((j) => [j.entry.link.id, j]));
  batch.index = 0;
  app.canvas?.setDirty(true, true);
}

function armWorkerRescue(batch) {
  clearWorkerRescue();
  workerRescueTimer = setTimeout(() => {
    if (M.routeBatch === batch && batch.worker) rescueWorkerBatch(batch);
  }, WORKER_RESCUE_MS);
}

// Held-pause race: while the worker chews through the pause queue, the main
// thread may immediately route links predicted cheaper than this — short
// pauses keep the old one-by-one feedback, heavy links stay off-thread.
const PAUSE_RACE_MAX_MS = 10;

// --- held-pause worker queue ---
// A held pause re-routes its queue across frames anyway (it is not per-frame
// interactive), so the whole queue can go to the worker: one heavy link no
// longer stalls the main thread for a 30-130ms frame at a time. Worker jobs
// use the very same {weight: 2.5, popsBudget: 80000} opts as the main-thread
// drain, on the same graph snapshot, so paths are bit-identical either way.

let pauseWorkerReroutes = 0;
let pauseWorkerMs = 0;

function cancelDragPauseWorker() {
  if (!M._dragPauseWorker) return;
  M._dragPauseWorker = null;
  cancelWorkerBatch();
}

function tryDispatchDragPauseWorker(graph, fastSig, entries, rectCache) {
  // The worker channel is shared with stable progressive batches. Cancel an
  // in-flight one first: the rev bump below would orphan it silently (its
  // results/done arrive stale and are dropped, leaving routeBatch stuck).
  if (M.routeBatch?.worker) {
    cancelProgressiveBatch();
    M.routeFastSig = "";
  }
  const byId = new Map(entries.map((e) => [e.link.id, e]));
  const jobs = [];
  for (const id of M._dragPauseQueue) {
    const entry = byId.get(id);
    if (!entry) continue;
    const ep = endpoints(entry, rectCache);
    if (!ep) continue;
    const endsKey =
      (ep.out.x | 0) + "," + (ep.out.y | 0) + "|" + (ep.inp.x | 0) + "," + (ep.inp.y | 0);
    jobs.push({ entry, ep, endsKey, opts: { weight: 2.5, popsBudget: 80000 } });
  }
  if (!workerEligibleFor(jobs)) return false;
  const batch = { graph, entries, jobs, fastSig };
  const jobRev = dispatchWorkerBatch(buildWorkerPayload(batch, rectCache));
  if (jobRev === false) return false;
  M._dragPauseWorker = {
    jobRev,
    jobsById: new Map(jobs.map((j) => [j.entry.link.id, j])),
  };
  return true;
}

function handleDragPauseWorkerResult(msg) {
  const job = M._dragPauseWorker?.jobsById.get(msg.id);
  if (!job) return;
  const linkId = msg.id;
  pauseWorkerReroutes++;
  pauseWorkerMs += msg.ms || 0;
  rememberRouteCost(linkId, msg.ms || 0);
  M._dragPauseAttemptedLinkIds.add(linkId);
  const qi = M._dragPauseQueue ? M._dragPauseQueue.indexOf(linkId) : -1;
  if (qi >= 0) M._dragPauseQueue.splice(qi, 1);
  M._dragPauseCleanupLinkIds.delete(linkId);
  if (msg.ok && msg.buf) {
    const pts = [];
    for (let i = 0; i < msg.buf.length; i += 2)
      pts.push({ x: msg.buf[i], y: msg.buf[i + 1] });
    M.failedRoutes.delete(linkId);
    const cached = { ends: job.endsKey, sticky: !!msg.sticky };
    setCachedPath(cached, pts);
    // Do not draw mid-pump: queue the path for the reveal pass below, which
    // drains on the next frame (fast-hit is suppressed while it is non-empty).
    M._dragPauseRevealQueue.push({ linkId, cached });
  } else {
    // Same bookkeeping as the main-thread drain: negative-cache the failure;
    // the link keeps its frozen/hidden placeholder until the release pass.
    rememberRouteFailure(linkId, job.endsKey, job.ep);
  }
  app.canvas?.setDirty(false, true);
}

// --- reveal of held-pause worker results ---
// A reveal is two Map writes and a Set add/delete: effectively free, so the
// whole pending queue drains in one frame (see pauseRevealCount).
// Lifecycle: entries are enqueued while the pause is active; resuming the
// drag (geometry changed) clears the queue because those paths were computed
// for the pre-move geometry; releasing the pointer flushes the remainder so
// the settle pass sees final paths.

function applyPauseReveal(item) {
  M.pathCache.set(item.linkId, item.cached);
  M._dragPauseCompletedLinkIds.add(item.linkId);
  M._dragHiddenLinkIds.delete(item.linkId);
}

function clearPauseReveals() {
  M._dragPauseRevealQueue.length = 0;
}

function flushPauseReveals() {
  const q = M._dragPauseRevealQueue;
  if (!q.length) return;
  for (const item of q) applyPauseReveal(item);
  q.length = 0;
}

function applyPauseRevealsForFrame() {
  const q = M._dragPauseRevealQueue;
  if (!q.length) return;
  if (!M._dragPauseActive) {
    // Pause state was reset without a clear/flush (defensive): never reveal
    // paths computed against geometry that no longer exists.
    q.length = 0;
    return;
  }
  const count = Math.min(pauseRevealCount(q.length), q.length);
  for (let i = 0; i < count; i++) applyPauseReveal(q.shift());
  // Keep frames coming while the queue drains.
  if (q.length) app.canvas?.setDirty(false, true);
}

initWorkerClient({
  onResult(msg) {
    if (M._dragPauseWorker && msg.jobRev === M._dragPauseWorker.jobRev) {
      handleDragPauseWorkerResult(msg);
      return;
    }
    const batch = M.routeBatch;
    if (!batch || !batch.worker || msg.jobRev !== batch.jobRev) return;
    const job = batch.jobsById.get(msg.id);
    if (!job) return;
    batch.workerResolved++;
    batch.workerMs += msg.ms || 0;
    rememberRouteCost(msg.id, msg.ms || 0);
    if (msg.stats) {
      batch.aStarPops += msg.stats.pops || 0;
      batch.simpleHits += msg.stats.simple || 0;
      if (msg.stats.level > 1) batch.winEscalations++;
    }
    if (msg.ok && msg.buf) {
      const pts = [];
      for (let i = 0; i < msg.buf.length; i += 2)
        pts.push({ x: msg.buf[i], y: msg.buf[i + 1] });
      M.failedRoutes.delete(msg.id);
      const cached = { ends: job.endsKey, sticky: !!msg.sticky };
      setCachedPath(cached, pts);
      M.pathCache.set(msg.id, cached);
      batch.resultsById.set(msg.id, { entry: job.entry, cached });
    } else {
      // The worker already attempted its own sticky stretch before failing.
      batch.routeFailures++;
      rememberRouteFailure(msg.id, job.endsKey, job.ep);
    }
    scheduleProgressiveBatch(); // throttled repaint with the new partial set
    armWorkerRescue(batch); // progress: push the rescue deadline out
  },
  onDone(jobRev) {
    if (M._dragPauseWorker && jobRev === M._dragPauseWorker.jobRev) {
      M._dragPauseWorker = null;
      M._dragPausePending = false;
      app.canvas?.setDirty(false, true);
      return;
    }
    const batch = M.routeBatch;
    if (!batch || !batch.worker || batch.jobRev !== jobRev) return;
    clearWorkerRescue();
    const results = orderedRouteResults(batch.entries, batch.resultsById);
    reportRouteProfile(batch.profileStarted, {
      fastHit: false,
      ...(batch.firstFrame ? batch.profile : { graphRebuilt: false }),
      progressive: true,
      worker: true,
      queuedLinks: batch.jobs.length,
      reroutedLinks: batch.workerResolved,
      connectorCalls: batch.workerResolved,
      connectorMs: roundedGeometry(batch.workerMs),
      routeFailures: batch.routeFailures,
      negativeSkips: batch.negativeSkips,
      aStarPops: batch.aStarPops,
      routeWindow: batch.winEscalations,
      routeSimple: batch.simpleHits,
      links: batch.entries.length,
    });
    finishStableRoutes(batch, results);
    app.canvas?.setDirty(true, true);
  },
  onFailed() {
    clearWorkerRescue();
    M._dragPauseWorker = null;
    // Drop the dead worker batch; the next frame re-routes synchronously.
    if (M.routeBatch?.worker) {
      M.routeBatch = null;
      app.canvas?.setDirty(true, true);
    }
  },
});

function cleanupDeadPaths(entries) {
  if (M.pathCache.size <= entries.length && M.failedRoutes.size <= entries.length) return;
  const alive = new Set(entries.map((e) => e.link.id));
  for (const id of M.pathCache.keys()) {
    if (alive.has(id)) continue;
    M.pathCache.delete(id);
    M.routeCostByLink.delete(id);
    M.routeCostByLinkMT.delete(id);
  }
  for (const id of M.failedRoutes.keys()) {
    if (!alive.has(id)) M.failedRoutes.delete(id);
  }
}

// --- route failure negative cache ---
// A link that fails to route (usually by exhausting the A* pop budget on a
// large graph) must not retry a full-priced search on every geometry change.
// Failures are remembered with exponential backoff; a failure is retried
// early only when its endpoints moved or a node moved near its corridor.
// Links without a successful route stay undrawn (unchanged behaviour) but
// no longer burn 50-150ms per retry per geometry change.

function failureBounds(ep) {
  return {
    x: Math.min(ep.out.x, ep.inp.x),
    y: Math.min(ep.out.y, ep.inp.y),
    x2: Math.max(ep.out.x, ep.inp.x),
    y2: Math.max(ep.out.y, ep.inp.y),
  };
}

function rectsHitBounds(rects, b) {
  if (!rects || !b) return false;
  for (const r of rects)
    if (r.x < b.x2 && r.x2 > b.x && r.y < b.y2 && r.y2 > b.y) return true;
  return false;
}

function rememberRouteFailure(linkId, endsKey, ep) {
  const prev = M.failedRoutes.get(linkId);
  const fails = (prev?.fails || 0) + 1;
  M.failedRoutes.set(linkId, {
    ends: endsKey,
    fails,
    retryAt: performance.now() + Math.min(500 * 2 ** Math.min(fails, 6), 15000),
    bounds: ep ? failureBounds(ep) : null,
  });
}

// True when this link's previous failure still applies and no nearby
// geometry change makes an early retry worthwhile.
function shouldSkipFailedRoute(linkId, endsKey, dirtyRects) {
  const neg = M.failedRoutes.get(linkId);
  if (!neg || neg.ends !== endsKey) return false;
  if (performance.now() >= neg.retryAt) return false;
  return !rectsHitBounds(dirtyRects, neg.bounds);
}

function finishStableRoutes(batch, results) {
  cleanupDeadPaths(batch.entries);
  M.routeBatch = null;
  M.routeGraph = batch.graph;
  M.routeFastSig = batch.fastSig;
  M.routeResults = results;
}

function continueStableRoutes(batch, profileStarted) {
  if (batch.worker) {
    // Worker batches are message-driven; frames only re-emit partial results.
    return orderedRouteResults(batch.entries, batch.resultsById);
  }
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
    rememberRouteCost(job.entry.link.id, elapsed, true);
    const st = M.router.lastStats;
    if (st) {
      batch.aStarPops += st.pops;
      batch.simpleHits += st.simple;
      if (st.level > 1) batch.winEscalations++;
    }
    if (!pts) {
      batch.routeFailures++;
      rememberRouteFailure(job.entry.link.id, job.endsKey, job.ep);
      // Degrade gracefully: keep the last legal path on screen, stretched
      // to the current endpoints, instead of making the link vanish.
      // stretchPath validates that no unexpected node body is crossed.
      const stickyPts = stretchPath(
        M.pathCache.get(job.entry.link.id)?.pts,
        job.ep,
      );
      if (stickyPts) {
        const sticky = { ends: job.endsKey, sticky: true };
        setCachedPath(sticky, stickyPts);
        M.pathCache.set(job.entry.link.id, sticky);
        return { entry: job.entry, cached: sticky };
      }
      return null;
    }
    M.failedRoutes.delete(job.entry.link.id);
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
    workerRescued: !!batch.workerRescued,
    queuedLinks: batch.jobs.length,
    batchRemaining: slice.remaining,
    reroutedLinks: slice.processed,
    connectorCalls: slice.processed,
    connectorMs: roundedGeometry(connectorMs),
    routeFailures: batch.routeFailures,
    negativeSkips: batch.negativeSkips,
    aStarPops: batch.aStarPops,
    routeWindow: batch.winEscalations,
    routeSimple: batch.simpleHits,
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
  // Sticky re-validation below uses the main-thread router; if failures are
  // in backoff the router must be fresh (stable worker frames defer it).
  if (M.failedRoutes.size > 0) ensureMainRouterFresh(graph, entries, rectCache);
  const resultsById = new Map();
  const jobs = [];
  let negativeSkips = 0;
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
    if (endsMoved || hitDirty) {
      // A previous failure under the same endpoints stays skipped until its
      // backoff elapses or a node moves near the link's corridor. The stale
      // cached pts are only a visual placeholder after a failure, so they
      // must not suppress the skip.
      if (
        endsMoved &&
        shouldSkipFailedRoute(entry.link.id, endsKey, dirty._rects)
      ) {
        negativeSkips++;
        // Backoff means "do not re-route yet", not "show nothing": keep the
        // last legal path on screen, re-stretched to the current endpoints.
        const stickyPts = stretchPath(cached?.pts, ep);
        if (stickyPts) {
          const sticky = { ends: endsKey, sticky: true };
          setCachedPath(sticky, stickyPts);
          M.pathCache.set(entry.link.id, sticky);
          resultsById.set(entry.link.id, { entry, cached: sticky });
        }
        continue;
      }
      jobs.push({ entry, ep, endsKey });
    } else if (cached?.pts) resultsById.set(entry.link.id, { entry, cached });
  }

  const progressive = shouldProgressivelyRoute(false, forceSync, jobs.length);
  const batch = {
    graph,
    fastSig,
    entries,
    jobs,
    jobsById: new Map(jobs.map((j) => [j.entry.link.id, j])),
    index: 0,
    resultsById,
    profile: dirty._profile,
    profileStarted,
    firstFrame: true,
    progressive,
    routeFailures: 0,
    negativeSkips,
    aStarPops: 0,
    winEscalations: 0,
    simpleHits: 0,
    worker: false,
    jobRev: 0,
    workerResolved: 0,
    workerMs: 0,
    workerRescued: false,
  };

  // Phase D: large stable batches route in the background worker. The first
  // frame returns only the already-cached results; worker results reveal
  // progressively as they arrive (same semantics as the sync progressive
  // path, but with zero main-thread search time).
  if (jobs.length > 0 && workerEligibleFor(jobs) && tryDispatchWorkerBatch(batch, rectCache)) {
    reportRouteProfile(profileStarted, {
      fastHit: false,
      ...batch.profile,
      progressive: true,
      worker: true,
      queuedLinks: jobs.length,
      batchRemaining: jobs.length,
      links: entries.length,
    });
    return orderedRouteResults(entries, resultsById);
  }

  // Sync routing needs the main-thread router; rebuild it now if a stable
  // worker frame deferred it. Also force a fresh build when failure backoff
  // may re-validate sticky paths below.
  ensureMainRouterFresh(graph, entries, rectCache);
  if (progressive) M.routeBatch = batch;
  return continueStableRoutes(batch, profileStarted);
}

// --- path stretch (drag anti-flicker) ---
// Shared implementation lives in stretch.js so the router worker can run the
// identical stretch against its own fresh OrthoRouter instance.

function stretchPath(oldPts, ep) {
  return stretchPathPure(M.router, oldPts, ep);
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
    cancelDragPauseWorker();
    M.graphSig = "";
    M.routeFastSig = "";
    M.routeResults = null;
    M.prevRects = new Map();
    M.pathCache.clear();
    M.failedRoutes.clear();
    M.routeCostByLink.clear();
    M.routeCostByLinkMT.clear();
    M.routeCostAverage = NaN;
    M._dragAdaptiveMode = null;
    M._dragHeavyActive = null;
    M._dragLastFastSig = "";
    M._deferredGraphBuild = false;
  }
  const fastSig = fastGraphSignature(graph, app.canvas);
  if (M.routeBatch) {
    if (M.routeBatch.graph === graph && M.routeBatch.fastSig === fastSig) {
      if (M.routeBatch.worker) {
        if (M.S.workerRouting !== false && !M._workerFailed) {
          // Worker-driven batch: frames just re-emit the latest partial set.
          return orderedRouteResults(M.routeBatch.entries, M.routeBatch.resultsById);
        }
        // Toggled off (or failed) mid-flight: abandon the worker batch and
        // fall through to a synchronous round below.
        cancelProgressiveBatch();
        M.routeFastSig = "";
      } else {
        return continueStableRoutes(M.routeBatch, profileStarted);
      }
    } else {
      if (M._pointerDown) M._dragInterruptedBatch = true;
      cancelProgressiveBatch();
      M.routeFastSig = "";
    }
  }
  // Pause reveals must not fast-hit: the reveal queue only drains on the full
  // path below, and revealed links only render when results are rebuilt. The
  // worker empties the compute queue quickly, which used to silence every
  // full-frame trigger and stranded 8-14 computed paths unseen until the drag
  // resumed and discarded them. Full rebuilds are cache reads (~1-2ms), so
  // keep taking the full path until the queue has fully played out.
  if (
    M.routeGraph === graph &&
    fastSig === M.routeFastSig &&
    M.routeResults &&
    !M._dragPauseRevealQueue.length
  ) {
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
    cancelDragPauseWorker();
    M._dragPauseActive = false;
    M._dragPausePending = false;
    M._dragPauseQueue = null;
    M._dragPauseCleanupLinkIds.clear();
    M._dragPauseAttemptedLinkIds.clear();
    M._dragPauseCompletedLinkIds.clear();
    clearPauseReveals(); // geometry moved on: queued paths are stale
  }
  const deferHeavyBuild = shouldDeferHeavyGraphBuild(
    M._dragHeavyActive,
    M._pointerDown,
    M._dragPauseActive,
    M.routeGraph === graph && !!M.routeResults,
  );
  const rectCache = new Map();
  // Stable frames on the worker path skip the main-thread OVG build; the
  // main router is only needed for drag/stretch/sync routing and is rebuilt
  // lazily via ensureMainRouterFresh. During a drag (or its settle window)
  // the build follows the existing drag rules instead.
  const deferForWorker =
    !M._pointerDown && M.settleTimer === null && workerRoutingUsable();
  const dirty = refreshGraph(graph, entries, rectCache, deferHeavyBuild || deferForWorker);
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
  // Held-pause re-routes are not per-frame interactive: hand the whole queue
  // to the worker so one heavy link cannot stall the main thread. While a
  // worker batch is in flight the per-frame main-thread drain below is
  // skipped; results stream back into pathCache between frames.
  if (
    M._dragPauseActive &&
    M._dragPauseQueue?.length &&
    !M._dragPauseWorker &&
    M.S.workerHeldPause !== false
  ) {
    tryDispatchDragPauseWorker(graph, fastSig, entries, rectCache);
  }
  // Reveal worker-computed paths as soon as they land (the queue drains in
  // one frame; see pauseRevealCount for why pacing was removed).
  applyPauseRevealsForFrame();
  // While the worker holds the pause queue, the main thread races ahead only
  // on links MEASURED cheap on this thread (routeCostByLinkMT). Unknown links
  // get an infinite fallback: they are exactly the ones that turned into
  // 19-49ms main-thread routes and long tasks when worker timings or the
  // session average were trusted instead.
  let pauseNextLinkId = null;
  if (M._dragPauseActive && M._dragPauseQueue?.length) {
    if (!M._dragPauseWorker) {
      pauseNextLinkId = M._dragPauseQueue[0];
    } else {
      for (const id of M._dragPauseQueue) {
        if (shouldRacePauseLink(M.routeCostByLinkMT.get(id), Infinity, PAUSE_RACE_MAX_MS)) {
          pauseNextLinkId = id;
          break;
        }
      }
    }
  }

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
  let aStarPops = 0;
  let winEscalations = 0;
  let simpleHits = 0;
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
      // A raced link can sit anywhere in the queue, not just at the head.
    const pauseQueueIdx = M._dragPauseQueue ? M._dragPauseQueue.indexOf(e.link.id) : -1;
    if (pauseQueueIdx >= 0) M._dragPauseQueue.splice(pauseQueueIdx, 1);
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
      // Same negative-cache rule as the stable path: a link that failed
      // under these endpoints does not retry until backoff elapses or the
      // geometry near it changed. Held-pause routes bypass the cache
      // because the user is explicitly waiting on that link. Stale cached
      // pts are only a visual placeholder and must not suppress the skip.
      if (
        !pauseRoute &&
        shouldSkipFailedRoute(e.link.id, endsKey, collisionRects || dirty._rects)
      ) {
        finishPauseRoute(false);
        continue;
      }
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
        // Interactive routing uses a weighted heuristic (bounded-suboptimal,
        // ~5x faster); the settle pass re-routes exact at weight 1.
        pts = M.router.routeConnector(
          ep.out,
          ep.bodyOut,
          ep.stubOut,
          ep.stubIn,
          ep.bodyIn,
          ep.inp,
          { weight: 2.5, popsBudget: 80000 },
        );
        const elapsed = performance.now() - connectorStarted;
        connectorCalls++;
        connectorMs += elapsed;
        rememberRouteCost(e.link.id, elapsed, true);
        const st = M.router.lastStats;
        if (st) {
          aStarPops += st.pops;
          simpleHits += st.simple;
          if (st.level > 1) winEscalations++;
        }
        if (pts) M.failedRoutes.delete(e.link.id);
      }
      // A physically overlapping layout can genuinely have no legal path.
      // Never replace that with a fallback which cuts through a node.
      if (!pts) {
        rememberRouteFailure(e.link.id, endsKey, ep);
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
  // Adaptive measured-cost escalation: the count-based lock can pick
  // freeze-others for a dense pocket where predictedMs underestimates the
  // real connector cost 2-4x, pinning the whole gesture at 60-130ms frames.
  // Escalate from the frame's measured connector time instead. Escalation is
  // one-way within a gesture (never re-shows hidden links mid-drag); the
  // lock resets when the gesture settles.
  if (
    dragMode === "adaptive" &&
    M.S.adaptiveEscalation !== false &&
    M._dragAdaptiveMode &&
    !M._dragHeavyActive &&
    connectorMs > 0
  ) {
    M._dragAdaptiveMode = escalateLockedDragMode(
      M._dragAdaptiveMode,
      connectorMs,
      activeLinkIds.size,
    );
  }
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
    pauseRevealRemaining: M._dragPauseRevealQueue.length,
    // Why a held pause did (or did not) go to the worker — makes fallback
    // frames self-explanatory in profiler reports.
    pauseWorkerGate: M._workerFailed
      ? "worker-failed"
      : M.S.workerRouting === false
        ? "worker-routing-off"
        : M.S.workerHeldPause === false
          ? "held-pause-off"
          : "on",
    heldWorkerReroutes: pauseWorkerReroutes,
    heldWorkerMs: roundedGeometry(pauseWorkerMs),
    hiddenDraggedLinks,
    visibleLinks: results.length,
    aStarPops,
    routeWindow: winEscalations,
    routeSimple: simpleHits,
    links: entries.length,
  });
  pauseWorkerReroutes = 0;
  pauseWorkerMs = 0;
  return results;
}
