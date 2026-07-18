// draw.js — link drawing, flow animation, and hover tracking for LinkRouter.

import { app } from "../../scripts/app.js";
import { M } from "./state.js";
import { routeAll, nodeRect } from "./routing.js";
import { profiler } from "./profiler.js";
import { hoverDrawItems } from "./draw-policy.js";

// --- color helpers ---

function linkColor(canvas, link) {
  return (
    link.color ||
    canvas.default_connection_color_byType?.[link.type] ||
    LGraphCanvas.link_type_colors?.[link.type] ||
    canvas.default_link_color ||
    "#9A9"
  );
}

const darkenCache = new Map();
function darken(color, f = 0.3) {
  const key = color + "|" + f;
  let v = darkenCache.get(key);
  if (v) return v;
  let r = 128, g = 128, b = 128;
  if (/^#([0-9a-f]{3})$/i.test(color)) {
    r = parseInt(color[1] + color[1], 16);
    g = parseInt(color[2] + color[2], 16);
    b = parseInt(color[3] + color[3], 16);
  } else if (/^#([0-9a-f]{6})$/i.test(color)) {
    r = parseInt(color.slice(1, 3), 16);
    g = parseInt(color.slice(3, 5), 16);
    b = parseInt(color.slice(5, 7), 16);
  }
  v = `rgb(${(r * (1 - f)) | 0},${(g * (1 - f)) | 0},${(b * (1 - f)) | 0})`;
  darkenCache.set(key, v);
  return v;
}

// --- path tracing ---

function tracePath(ctx, pts) {
  // CanvasRenderingContext2D needs beginPath(); Path2D has no such method.
  if (typeof ctx.beginPath === "function") ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  if (M.S.cornerMode === "off" || M.S.cornerRadius <= 0) {
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    return;
  }
  let uniform = M.S.cornerRadius;
  if (M.S.cornerMode === "per-line") {
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i - 1], c = pts[i], n = pts[i + 1];
      uniform = Math.min(
        uniform,
        Math.hypot(c.x - p.x, c.y - p.y) / 2,
        Math.hypot(n.x - c.x, n.y - c.y) / 2,
      );
    }
  }
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1], c = pts[i], n = pts[i + 1];
    const r =
      M.S.cornerMode === "per-line"
        ? uniform
        : Math.min(
            M.S.cornerRadius,
            Math.hypot(c.x - p.x, c.y - p.y) / 2,
            Math.hypot(n.x - c.x, n.y - c.y) / 2,
          );
    ctx.arcTo(c.x, c.y, n.x, n.y, r);
  }
  ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
}

function cachedCanvasPath(cached) {
  if (typeof Path2D === "undefined") return null;
  const key = M.S.cornerMode + "|" + M.S.cornerRadius;
  if (cached._canvasPath && cached._canvasPathKey === key && cached._canvasPathPts === cached.pts)
    return cached._canvasPath;
  const path = new Path2D();
  tracePath(path, cached.pts);
  cached._canvasPath = path;
  cached._canvasPathKey = key;
  cached._canvasPathPts = cached.pts;
  return path;
}

function strokeCachedPath(ctx, cached) {
  const path = cachedCanvasPath(cached);
  if (path) ctx.stroke(path);
  else {
    tracePath(ctx, cached.pts);
    ctx.stroke();
  }
}

let staticBatchCache = null;

// Memoized 32-bit hash per color string — color values repeat heavily
// across links, so per-link hashing is just one Map lookup + one imul.
const colorCodeCache = new Map();
function colorCode(color) {
  let v = colorCodeCache.get(color);
  if (v === undefined) {
    v = 1;
    for (let c = 0; c < color.length; c++)
      v = Math.imul(v ^ color.charCodeAt(c), 16777619);
    colorCodeCache.set(color, v);
  }
  return v;
}

// --- viewport culling ---
//
// linkBounds/cullRectFor are exact: a stroked path can only reach its point
// bounds plus half the stroke width, so skipping out-of-rect links can never
// remove a visible pixel. The rect is snapped OUTWARD to 128px so small pans
// keep hitting the batch cache (the cached batch is a superset of the view).

function linkBounds(cached) {
  if (cached._pb && cached._pb.pts === cached.pts) return cached._pb;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of cached.pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  const b = { pts: cached.pts, x0, y0, x1, y1 };
  cached._pb = b;
  return b;
}

const CULL_SNAP = 128;
function cullRectFor(canvas) {
  // canvas.visible_area is litegraph's Rectangle [x, y, w, h] in graph
  // coordinates (verified in frontend 1.45.21: LGraphCanvas.visible_area ===
  // DragAndScale.visible_area, resized via resizeBottomRight).
  const va = canvas.visible_area;
  if (!va || va.length < 4 || !(va[2] > 0) || !(va[3] > 0)) return null;
  const m = (+M.S.lineWidth || 3) + (+M.S.outlineWidth || 2) + 2;
  return {
    x0: Math.floor((va[0] - m) / CULL_SNAP) * CULL_SNAP,
    y0: Math.floor((va[1] - m) / CULL_SNAP) * CULL_SNAP,
    x1: Math.ceil((va[0] + va[2] + m) / CULL_SNAP) * CULL_SNAP,
    y1: Math.ceil((va[1] + va[3] + m) / CULL_SNAP) * CULL_SNAP,
  };
}

function boundsOutside(b, r) {
  return b.x1 < r.x0 || b.x0 > r.x1 || b.y1 < r.y0 || b.y0 > r.y1;
}

function staticBatches(canvas, routed, cull) {
  const profileStarted = profiler.active ? performance.now() : 0;
  if (typeof Path2D === "undefined" || typeof Path2D.prototype.addPath !== "function") return null;
  const colors = [];
  let colorHash = 0x811c9dc5;
  for (const { entry } of routed) {
    const color = linkColor(canvas, entry.link);
    colors.push(color);
    colorHash = Math.imul(
      colorHash ^ ((entry.link.id | 0) ^ colorCode(color)),
      16777619,
    );
  }
  const pathKey = M.S.cornerMode + "|" + M.S.cornerRadius;
  const cullKey = cull ? cull.x0 + "," + cull.y0 + "," + cull.x1 + "," + cull.y1 : "";
  if (
    staticBatchCache?.routed === routed &&
    staticBatchCache.pathKey === pathKey &&
    staticBatchCache.colorHash === colorHash &&
    staticBatchCache.cullKey === cullKey
  ) {
    if (profiler.active)
      profiler.recordBatch({ hit: true, durationMs: Math.round((performance.now() - profileStarted) * 1000) / 1000 });
    return staticBatchCache;
  }

  const all = new Path2D();
  const byColor = new Map();
  for (let i = 0; i < routed.length; i++) {
    const { entry, cached } = routed[i];
    const pts = cached.pts;
    // Keep every link's center fresh for litegraph's tooltip hit-testing,
    // even for links culled out of the current viewport.
    const mid = pts[Math.floor(pts.length / 2)];
    entry.link._pos && ((entry.link._pos[0] = mid.x), (entry.link._pos[1] = mid.y));
    if (cull && boundsOutside(linkBounds(cached), cull)) continue;
    const path = cachedCanvasPath(cached);
    if (!path) return null;
    all.addPath(path);
    const color = colors[i];
    let batch = byColor.get(color);
    if (!batch) {
      batch = new Path2D();
      byColor.set(color, batch);
    }
    batch.addPath(path);
  }
  staticBatchCache = { routed, pathKey, colorHash, cullKey, all, byColor };
  if (profiler.active)
    profiler.recordBatch({ hit: false, durationMs: Math.round((performance.now() - profileStarted) * 1000) / 1000 });
  return staticBatchCache;
}

// --- marker shapes ---

function markerPath(ctx, style, x, y, ang, s) {
  ctx.beginPath();
  if (style === "dots") {
    ctx.arc(x, y, s / 2 + 0.5, 0, Math.PI * 2);
    return;
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  if (style === "pill") {
    const L = s * 2, R = s / 2;
    ctx.moveTo(-L / 2 + R, -R);
    ctx.lineTo(L / 2 - R, -R);
    ctx.arc(L / 2 - R, 0, R, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(-L / 2 + R, R);
    ctx.arc(-L / 2 + R, 0, R, Math.PI / 2, (3 * Math.PI) / 2);
  } else if (style === "arrow") {
    ctx.moveTo(s, 0);
    ctx.lineTo(-s * 0.7, -s * 0.7);
    ctx.lineTo(-s * 0.3, 0);
    ctx.lineTo(-s * 0.7, s * 0.7);
    ctx.closePath();
  } else if (style === "oval") {
    ctx.ellipse(0, 0, s, s * 0.55, 0, 0, Math.PI * 2);
  }
  ctx.restore();
}

// --- flow animation ---

function drawFlow(ctx, cached, t, baseColor, alpha, staticArrows = false) {
  const color =
    M.S.animColorUse && M.S.animColor ? M.S.animColor : darken(baseColor, 0.3);
  const gap = Math.max(10, +M.S.animGap || 36);
  const speed = +M.S.animSpeed || 60;
  const size = +M.S.animSize || 5;
  const style = staticArrows ? "arrow" : M.S.animStyle;

  if (style === "dash") {
    ctx.save();
    ctx.globalAlpha = Math.min(1, alpha + 0.2);
    if (M.S.animOutline) {
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.lineWidth = size * 0.6 + (+M.S.animOutlineWidth || 2);
      ctx.setLineDash([size * 2, gap]);
      ctx.lineDashOffset = -((t * speed) % (size * 2 + gap));
      strokeCachedPath(ctx, cached);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, size * 0.6);
    ctx.setLineDash([size * 2, gap]);
    ctx.lineDashOffset = -((t * speed) % (size * 2 + gap));
    strokeCachedPath(ctx, cached);
    ctx.restore();
    return;
  }

  const { segs, total } = cached;
  if (!segs || total < 4) return;
  const offset = (t * speed) % gap;

  ctx.save();
  ctx.globalAlpha = Math.min(1, alpha + 0.25);
  ctx.fillStyle = color;
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.lineWidth = +M.S.animOutlineWidth || 2;
  let si = 0;
  for (let d = offset; d < total; d += gap) {
    while (si < segs.length - 1 && d > segs[si].start + segs[si].len) si++;
    const s = segs[si];
    const f = s.len > 0 ? (d - s.start) / s.len : 0;
    const x = s.a.x + s.dx * f;
    const y = s.a.y + s.dy * f;
    markerPath(ctx, style, x, y, s.ang, size);
    if (M.S.animOutline) ctx.stroke();
    ctx.fill();
  }
  ctx.restore();
}

// --- overlay animation layer ---
//
// Animated flow markers render on a separate <canvas> stacked above the main
// canvas, so the ~30fps animation no longer forces a full graph redraw
// (setDirty) every frame — only the small overlay is repainted.
// Verified against frontend 1.45.21: the main canvas backing store is sized
// in CSS pixels (LGraphCanvas.resize uses parentElement.offsetWidth/Height),
// and the ctx transform during drawConnections is ds.toCanvasContext(ctx)
// (= scale(s,s) then translate(offset)). The frontend's own overlay uses the
// same recipe: setTransform(width/clientWidth) + ds.toCanvasContext.

function overlayUsable() {
  return (
    M.S.animOverlay !== false &&
    !M._overlayFailed &&
    typeof document !== "undefined"
  );
}

function ensureOverlay(main) {
  let ov = M._overlayCanvas;
  try {
    if (!ov) {
      ov = document.createElement("canvas");
      ov.dataset.linkrouterOverlay = "1";
      ov.style.cssText =
        "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;";
      M._overlayCanvas = ov;
      M._overlayCtx = ov.getContext("2d");
      if (!M._overlayCtx) throw new Error("2d context unavailable");
    }
    const parent = main?.parentElement;
    if (!parent) return null;
    if (ov.parentElement !== parent) {
      // The 100%-sized overlay aligns with the main canvas only when the
      // parent is a positioned ancestor (main canvas == parent size).
      if (getComputedStyle(parent).position === "static")
        parent.style.position = "relative";
      parent.appendChild(ov);
    }
    return ov;
  } catch (e) {
    M._overlayFailed = true;
    console.warn("[LinkRouter] overlay layer unavailable, legacy animation", e);
    return null;
  }
}

function clearOverlay() {
  const ov = M._overlayCanvas;
  const octx = M._overlayCtx;
  if (!ov || !octx) return;
  try {
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, ov.width, ov.height);
  } catch {}
}

function drawOverlayFrame(lgCanvas) {
  const main = lgCanvas?.canvas;
  if (!main || !ensureOverlay(main)) return;
  const ov = M._overlayCanvas;
  const octx = M._overlayCtx;
  try {
    // Keep the overlay the top-most sibling so markers stay visible even if
    // the frontend appends node layers later. No DOM write when already last.
    const parent = main.parentElement;
    if (parent && parent.lastElementChild !== ov) parent.appendChild(ov);
    if (ov.width !== main.width || ov.height !== main.height) {
      ov.width = main.width;
      ov.height = main.height;
    }
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, ov.width, ov.height);
    const links = M._animLinks;
    if (!links.length) return;
    const dpr = main.width / (main.clientWidth || main.width || 1);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ds = lgCanvas.ds;
    if (ds) {
      if (typeof ds.toCanvasContext === "function") ds.toCanvasContext(octx);
      else {
        octx.scale(ds.scale, ds.scale);
        octx.translate(ds.offset[0], ds.offset[1]);
      }
    }
    octx.lineJoin = "round";
    octx.lineCap = "round";
    const t = performance.now() / 1000;
    for (const it of links)
      drawFlow(octx, it.cached, t, it.color, it.alpha, false);
  } catch (e) {
    M._overlayFailed = true;
    console.warn("[LinkRouter] overlay draw failed, legacy animation", e);
  }
}

// --- animation loop ---

function stopAnimLoop() {
  M.animActive = false;
  if (M.rafId) cancelAnimationFrame(M.rafId);
  M.rafId = 0;
}

function animTick(now) {
  if (!M.animActive) return;
  const interval = 1000 / M.currentFPS();
  if (now - M.lastFrame >= interval) {
    M.lastFrame = now;
    if (M._overlayLoop) {
      // Overlay mode: repaint only the overlay layer. Self-terminate when the
      // plugin got disabled (drawAll no longer runs to stop us) or the
      // overlay failed (next drawAll will restart the legacy loop).
      if (M.S.enabled === false || M._overlayFailed) {
        stopAnimLoop();
        clearOverlay();
        return;
      }
      drawOverlayFrame(app.canvas);
    } else {
      app.canvas?.setDirty(true, true);
    }
  }
  M.rafId = requestAnimationFrame(animTick);
}

function ensureAnimLoop(need, useOverlay) {
  if (need && M.animActive && M._overlayLoop === useOverlay) return;
  const wasActive = M.animActive;
  const wasOverlay = M._overlayLoop;
  if (wasActive) stopAnimLoop();
  if (wasOverlay) clearOverlay(); // never leave a stale overlay frame behind
  if (need) {
    M.animActive = true;
    M._overlayLoop = useOverlay;
    M.lastFrame = 0;
    M.rafId = requestAnimationFrame(animTick);
  }
}

// --- hover detection ---

function hoverNodeId(canvas) {
  if (canvas.node_over) return canvas.node_over.id;
  if (!M.mouseClient || !canvas?.ds) return null;
  const el = canvas.canvas;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (
    M.mouseClient.x < rect.left ||
    M.mouseClient.x > rect.right ||
    M.mouseClient.y < rect.top ||
    M.mouseClient.y > rect.bottom
  )
    return null;
  const scale = canvas.ds.scale || 1;
  const gx = (M.mouseClient.x - rect.left) / scale - canvas.ds.offset[0];
  const gy = (M.mouseClient.y - rect.top) / scale - canvas.ds.offset[1];
  const graph = canvas.graph;
  // Prefer litegraph's own spatial query over the already-computed
  // visible_nodes list instead of scanning every node with getBounding.
  if (graph && typeof graph.getNodeOnPos === "function") {
    const n = graph.getNodeOnPos(gx, gy, canvas.visible_nodes || graph._nodes);
    return n ? n.id : null;
  }
  const nodes = graph?._nodes || [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const r = nodeRect(nodes[i]);
    if (gx >= r.x && gx <= r.x + r.w && gy >= r.y && gy <= r.y + r.h)
      return nodes[i].id;
  }
  return null;
}

// --- main draw hook ---

export function drawAll(canvas, ctx) {
  const graph = canvas.graph;
  if (!graph) return;
  // Guard: router not ready yet (settings may still be loading)
  if (!M.router) return false;
  const profileFrame = profiler.beginFrame(canvas);
  let routed;
  try {
    routed = routeAll(graph);
  } catch (err) {
    console.warn("[LinkRouter] routing failed, falling back", err?.message || err);
    M.S.enabled = false;
    profiler.endFrame(profileFrame, { fallback: true });
    return false;
  }
  if (routed === null) {
    profiler.endFrame(profileFrame, { fallback: true });
    return false;
  }

  const selIds = new Set(Object.keys(canvas.selected_nodes || {}).map(Number));
  const hovId = M.S.hoverAnim ? hoverNodeId(canvas) : null;
  const hoverId = hovId !== null && !selIds.has(hovId) ? hovId : null;
  const hasSel = M.S.selectHighlight && selIds.size > 0;
  const isDragging = M._nodeDragActive;
  const related = (link) => selIds.has(link.origin_id) || selIds.has(link.target_id);
  const hovered = (link) =>
    hoverId !== null && (link.origin_id === hoverId || link.target_id === hoverId);
  const animOK = M.animEnabledNow();

  // Overlay mode: animated markers are collected during the main pass and
  // drawn on the overlay layer afterwards (and by the rAF tick), instead of
  // being painted into the main canvas with a 30fps full redraw.
  M._animLinks.length = 0;
  const useOverlay =
    M.S.flowMode === "animated" &&
    overlayUsable() &&
    !!ensureOverlay(canvas.canvas);

  let animOn = false;
  let strokeCalls = 0;
  const t = performance.now() / 1000;

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  // Hover must not switch the entire workflow from color batches to per-link
  // drawing. Keep the unchanged batch as the base and overlay only links
  // attached to the hovered node so they genuinely render on top.
  // Low-zoom LOD (mirrors the frontend's own low-quality mode): when zoomed
  // far out, outlines and flow markers are visually indistinguishable but
  // still cost stroke/fill time — skip them. canvas.low_quality is the
  // frontend 1.45.21 getter (scale < min_font_size_for_lod/(text size*√dpr));
  // fall back to a fixed 0.6 threshold on older frontends.
  const lowQ =
    canvas.low_quality === true ||
    (canvas.low_quality === undefined && (canvas.ds?.scale ?? 1) < 0.6);
  const wantOutline = M.S.outline && !lowQ;

  const cull = cullRectFor(canvas);
  const batches = !hasSel ? staticBatches(canvas, routed, cull) : null;
  const drawItems = hoverDrawItems(routed, hoverId, !!batches);
  if (batches) {
    const w = +M.S.lineWidth || 3;
    if (wantOutline) {
      ctx.strokeStyle = `rgba(0,0,0,${+M.S.outlineAlpha || 0.5})`;
      ctx.lineWidth = w + (+M.S.outlineWidth || 2);
      ctx.stroke(batches.all);
      strokeCalls++;
    }
    ctx.lineWidth = w;
    for (const [color, path] of batches.byColor) {
      ctx.strokeStyle = color;
      ctx.stroke(path);
      strokeCalls++;
    }
  }
  for (const { entry, cached } of drawItems) {
    const pts = cached.pts;
    const link = entry.link;
    const mid = pts[Math.floor(pts.length / 2)];
    link._pos && ((link._pos[0] = mid.x), (link._pos[1] = mid.y));
    if (cull && boundsOutside(linkBounds(cached), cull)) continue;
    const isSel = hasSel && related(link);
    const isHov = M.S.hoverAnim && hovered(link);
    let alpha = 1;
    if (hasSel && !isSel) {
      // During drag, use a separate (less aggressive) dim value
      // so you can still see the canvas layout while dragging.
      alpha = isDragging && M.S.dragDimAlpha > 0
        ? +M.S.dragDimAlpha
        : +M.S.dimAlpha;
    }
    if (alpha <= 0.01) continue;

    ctx.globalAlpha = alpha;
    const w = (+M.S.lineWidth || 3) * (isSel ? +M.S.selectBoost || 1.35 : 1);
    const color = linkColor(canvas, link);

    if (wantOutline) {
      ctx.strokeStyle = `rgba(0,0,0,${+M.S.outlineAlpha || 0.5})`;
      ctx.lineWidth = w + (+M.S.outlineWidth || 2);
      strokeCachedPath(ctx, cached);
      strokeCalls++;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    strokeCachedPath(ctx, cached);
    strokeCalls++;

    if (!lowQ && ((isSel && M.S.selectAnim) || isHov)) {
      if (M.S.flowMode === "animated" && animOK) {
        animOn = true;
        if (useOverlay) M._animLinks.push({ cached, color, alpha });
        else drawFlow(ctx, cached, t, color, alpha, false);
      } else if (M.S.flowMode === "static" || (M.S.flowMode === "animated" && !animOK)) {
        drawFlow(ctx, cached, 0, color, alpha, true);
      }
    }
  }
  ctx.globalAlpha = 1;

  if (M.barState.debug) {
    const info = M.router.debugInfo();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,80,80,0.5)";
    for (const r of info.rects) ctx.strokeRect(r.x, r.y, r.x2 - r.x, r.y2 - r.y);
    ctx.fillStyle = "rgba(80,180,255,0.8)";
    for (const { cached } of routed)
      for (const p of cached.pts) ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
  }
  ctx.restore();

  ensureAnimLoop(animOn, useOverlay);
  if (useOverlay) {
    // Sync the overlay with the main canvas we just painted (pan/zoom stay
    // glued); empty animation set means the overlay must be blank.
    if (animOn) drawOverlayFrame(canvas);
    else clearOverlay();
  }
  profiler.endFrame(profileFrame, { links: routed.length, strokeCalls, batched: !!batches });
  return true;
}
