// routing.js — link routing core for LinkRouter.
//
// Reads shared state from M in state.js.
// Uses stubLen() / currentMargin() / resetRouter() from state.js.
// Exports routeAll for draw.js and nodeRect for ui.js.

import { app } from "../../scripts/app.js";
import { M } from "./state.js";
import { DIR } from "./router.js";

// Subgraph boundary IO virtual node ids (ComfyUI frontend convention).
const SUBGRAPH_INPUT_ID = -10;
const SUBGRAPH_OUTPUT_ID = -20;

// --- node helpers ---

export function nodeRect(node) {
  node.getBounding(M.bounding);
  return { x: M.bounding[0], y: M.bounding[1], w: M.bounding[2], h: M.bounding[3] };
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

function endpoints(entry) {
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
  const st = M.stubLen();
  return {
    out: { x: p1[0], y: p1[1] },
    inp: { x: p2[0], y: p2[1] },
    stubOut: { x: p1[0] + st, y: p1[1] },
    stubIn: { x: p2[0] - st, y: p2[1] },
  };
}

// --- layout signature ---

function layoutSignature(nodes) {
  let s = "";
  for (const n of nodes) {
    const r = nodeRect(n);
    s += n.id + ":" + (r.x | 0) + "," + (r.y | 0) + "," + (r.w | 0) + "," + (r.h | 0) + ";";
  }
  return s;
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

// --- refresh OVG ---

function refreshGraph(graph, linkEntries) {
  const nodes = graph._nodes || [];
  const sig = layoutSignature(nodes);
  if (sig === M.graphSig) return { _rects: null, _movedIds: new Set() };

  const mg = M.currentMargin();
  const ml = typeof mg === "number" ? mg : mg.l,
    mr = typeof mg === "number" ? mg : mg.r,
    mt = typeof mg === "number" ? mg : mg.t,
    mb = typeof mg === "number" ? mg : mg.b;

  const rawRects = [];
  const newRects = new Map();
  for (const n of nodes) {
    const rc = nodeRect(n);
    rawRects.push(rc);
    newRects.set(n.id, {
      x: rc.x - ml,
      y: rc.y - mt,
      x2: rc.x + rc.w + mr,
      y2: rc.y + rc.h + mb,
    });
  }

  const terminals = [];
  for (const e of linkEntries) {
    const ep = endpoints(e);
    if (!ep) continue;
    terminals.push(ep.stubOut, ep.stubIn);
  }
  M.router.build(rawRects, terminals);

  const dirty = [];
  const movedIds = new Set();
  for (const [id, rc] of newRects) {
    const o = M.prevRects.get(id);
    if (!o || o.x !== rc.x || o.y !== rc.y || o.x2 !== rc.x2 || o.y2 !== rc.y2) {
      dirty.push(rc);
      movedIds.add(id);
      if (o) dirty.push(o);
    }
  }
  for (const [id, o] of M.prevRects) if (!newRects.has(id)) dirty.push(o);
  M.prevRects = newRects;
  M.graphSig = sig;

  if (M.S.stickiness) {
    if (M.settleTimer) clearTimeout(M.settleTimer);
    M.settleTimer = setTimeout(() => {
      M.settleTimer = null;
      M._dragMovedIds = null;

      if (M._lastDragMode === "hide-self") {
        // Staggered reveal: 4 phases at 25% each → no lag spike
        const frozen = [];
        for (const c of M.pathCache.values())
          if (c._frozen) frozen.push(c);
        if (frozen.length > 0) {
          const n = Math.ceil(frozen.length / 4);
          for (let i = 0; i < 4; i++) {
            const delay = i * 70; // 0, 70, 140, 210 ms
            setTimeout(() => {
              const a = i * n, b = Math.min(a + n, frozen.length);
              for (let j = a; j < b; j++) {
                frozen[j].ends = null;
                delete frozen[j]._frozen;
              }
              app.canvas?.setDirty(true, true);
            }, delay);
          }
          return;
        }
      }

      // Normal clear (non mode-4)
      let hadStale = false;
      for (const c of M.pathCache.values()) {
        if (c.sticky) { c.ends = null; hadStale = true; }
        if (c._frozen) { c.ends = null; hadStale = true; delete c._frozen; }
      }
      if (hadStale) app.canvas?.setDirty(true, true);
    }, 180);
  }
  return { _rects: dirty, _movedIds: movedIds };
}

// --- path stretch (drag anti-flicker) ---

function stretchPath(oldPts, ep) {
  if (!oldPts || oldPts.length < 4) return null;
  const pts = oldPts.map((p) => ({ x: p.x, y: p.y }));
  const n = pts.length;
  pts[0] = ep.out;
  pts[1] = { x: ep.stubOut.x, y: ep.stubOut.y };
  pts[n - 1] = ep.inp;
  pts[n - 2] = { x: ep.stubIn.x, y: ep.stubIn.y };
  if (n >= 5) {
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
  if (pathHitsRects(pts.slice(1, -1), M.router.raw || [])) return null;
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
  const { entries, ioUnresolved } = collectLinks(graph);
  if (ioUnresolved > 0) return null;
  const dirty = refreshGraph(graph, entries);
  const rawDragging = M.settleTimer !== null;
  const dragMode = M.S.dragMode || "adaptive";

  // Persist movedIds across frames within a drag session so hide/freeze
  // doesn't flicker when graphSig hasn't changed on a given frame.
  if (rawDragging && dirty._movedIds && dirty._movedIds.size > 0)
    M._dragMovedIds = dirty._movedIds;
  const movedIds = M._dragMovedIds || dirty._movedIds;

  // Compute effectiveMode early (needed for mode-4 pause detection below)
  let effectiveMode = dragMode;
  if (effectiveMode === "adaptive" && movedIds && movedIds.size > 0) {
    const draggedLinks = entries.filter((e) =>
      movedIds.has(e.link.origin_id) || movedIds.has(e.link.target_id)
    ).length;
    if (draggedLinks <= 1)      effectiveMode = "none";
    else if (draggedLinks <= 4) effectiveMode = "freeze-others";
    else if (draggedLinks <= 10) effectiveMode = "freeze-others-strict";
    else                         effectiveMode = "hide-self";
  }
  M._lastDragMode = effectiveMode;

  // Mode 4: pointer held down (even paused) keeps links hidden.
  const dragging = rawDragging ||
    (effectiveMode === "hide-self" && M._pointerDown);

  const results = [];

  for (const e of entries) {
    // --- drag behaviour ---
    if (dragging && movedIds && movedIds.size > 0) {
      const isDragged = movedIds.has(e.link.origin_id) ||
                        movedIds.has(e.link.target_id);

      if (effectiveMode === "hide-self") {
        if (isDragged) continue;        // hide dragged links
        // freeze others — use cached path if available
        const cached = M.pathCache.get(e.link.id);
        if (cached && cached.pts) {
          cached._frozen = true;
          results.push({ entry: e, cached });
          continue;
        }
      }
      if (effectiveMode === "freeze-others-strict" && !isDragged) {
        const cached = M.pathCache.get(e.link.id);
        if (cached && cached.pts) {
          cached._frozen = true;
          results.push({ entry: e, cached });
          continue;
        }
      }
      if (effectiveMode === "freeze-others" && !isDragged) {
        const cached = M.pathCache.get(e.link.id);
        if (cached && cached.pts && dirty._rects) {
          if (!pathHitsRects(cached.pts, dirty._rects)) {
            cached._frozen = true;
            results.push({ entry: e, cached });
            continue;
          }
          // collision → fall through to full re-route
        }
      }
      // "none" → fall through to normal routing
    }

    const ep = endpoints(e);
    if (!ep) {
      const io =
        e.link.origin_id === SUBGRAPH_INPUT_ID ||
        e.link.target_id === SUBGRAPH_OUTPUT_ID;
      if (io) return null;
      continue;
    }
    const endsKey =
      (ep.out.x | 0) + "," + (ep.out.y | 0) + "|" + (ep.inp.x | 0) + "," + (ep.inp.y | 0);
    let cached = M.pathCache.get(e.link.id);
    const endsMoved = !cached || cached.ends !== endsKey;
    const hitDirty = dirty._rects && cached && cached.pts && pathHitsRects(cached.pts, dirty._rects);

    if (endsMoved || hitDirty) {
      let pts = null, sticky = false;
      if (M.S.stickiness && dragging && cached && cached.pts) {
        pts = stretchPath(cached.pts, ep);
        sticky = !!pts;
      }
      if (!pts) {
        const mid = M.router.route(ep.stubOut, DIR.E, ep.stubIn, DIR.E);
        pts = mid ? [ep.out, ...mid, ep.inp] : fallbackPath(ep);
      }
      cached = { ends: endsKey, sticky };
      setCachedPath(cached, pts);
      M.pathCache.set(e.link.id, cached);
    }
    results.push({ entry: e, cached });
  }

  if (M.pathCache.size > entries.length) {
    const alive = new Set(entries.map((e) => e.link.id));
    for (const id of M.pathCache.keys()) if (!alive.has(id)) M.pathCache.delete(id);
  }
  return results;
}

function fallbackPath(ep) {
  const mx = (ep.stubOut.x + ep.stubIn.x) / 2;
  return [
    ep.out,
    ep.stubOut,
    { x: mx, y: ep.stubOut.y },
    { x: mx, y: ep.stubIn.y },
    ep.stubIn,
    ep.inp,
  ];
}
