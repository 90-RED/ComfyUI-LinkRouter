// draw.js — link drawing, flow animation, and hover tracking for LinkRouter.

import { app } from "../../scripts/app.js";
import { M } from "./state.js";
import { routeAll, nodeRect } from "./routing.js";

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
  ctx.beginPath();
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
      tracePath(ctx, cached.pts);
      ctx.stroke();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, size * 0.6);
    ctx.setLineDash([size * 2, gap]);
    ctx.lineDashOffset = -((t * speed) % (size * 2 + gap));
    tracePath(ctx, cached.pts);
    ctx.stroke();
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

// --- animation loop ---

function ensureAnimLoop(need) {
  if (need && !M.animActive) {
    M.animActive = true;
    const tick = (now) => {
      if (!M.animActive) return;
      const interval = 1000 / M.currentFPS();
      if (now - M.lastFrame >= interval) {
        M.lastFrame = now;
        app.canvas?.setDirty(true, true);
      }
      M.rafId = requestAnimationFrame(tick);
    };
    M.rafId = requestAnimationFrame(tick);
  } else if (!need && M.animActive) {
    M.animActive = false;
    cancelAnimationFrame(M.rafId);
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
  const nodes = canvas.graph?._nodes || [];
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
  let routed;
  try {
    routed = routeAll(graph);
  } catch (err) {
    console.warn("[LinkRouter] routing failed, falling back", err);
    M.S.enabled = false;
    return false;
  }
  if (routed === null) return false;

  const selIds = new Set(Object.keys(canvas.selected_nodes || {}).map(Number));
  const hovId = M.S.hoverAnim ? hoverNodeId(canvas) : null;
  const hoverId = hovId !== null && !selIds.has(hovId) ? hovId : null;
  const hasSel = M.S.selectHighlight && selIds.size > 0;
  const related = (link) => selIds.has(link.origin_id) || selIds.has(link.target_id);
  const hovered = (link) =>
    hoverId !== null && (link.origin_id === hoverId || link.target_id === hoverId);
  const animOK = M.animEnabledNow();

  let animOn = false;
  const t = performance.now() / 1000;

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const { entry, cached } of routed) {
    const pts = cached.pts;
    const link = entry.link;
    const isSel = hasSel && related(link);
    const isHov = M.S.hoverAnim && hovered(link);
    let alpha = 1;
    if (hasSel && !isSel) alpha = +M.S.dimAlpha;
    if (alpha <= 0.01) continue;

    ctx.globalAlpha = alpha;
    const w = (+M.S.lineWidth || 3) * (isSel ? +M.S.selectBoost || 1.35 : 1);
    const color = linkColor(canvas, link);

    if (M.S.outline) {
      ctx.strokeStyle = `rgba(0,0,0,${+M.S.outlineAlpha || 0.5})`;
      ctx.lineWidth = w + (+M.S.outlineWidth || 2);
      tracePath(ctx, pts);
      ctx.stroke();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    tracePath(ctx, pts);
    ctx.stroke();

    if ((isSel && M.S.selectAnim) || isHov) {
      if (M.S.flowMode === "animated" && animOK) {
        animOn = true;
        drawFlow(ctx, cached, t, color, alpha, false);
      } else if (M.S.flowMode === "static" || (M.S.flowMode === "animated" && !animOK)) {
        drawFlow(ctx, cached, 0, color, alpha, true);
      }
    }

    const mid = pts[Math.floor(pts.length / 2)];
    link._pos && ((link._pos[0] = mid.x), (link._pos[1] = mid.y));
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

  ensureAnimLoop(animOn);
  return true;
}
