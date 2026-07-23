export function linkTouchesNode(item, nodeId) {
  const link = item?.entry?.link;
  return !!(
    link &&
    nodeId !== null &&
    nodeId !== undefined &&
    (link.origin_id === nodeId || link.target_id === nodeId)
  );
}

// With a Path2D base batch, only hovered links need an overlay pass. Without
// batching, preserve all unrelated ordering and move only hovered links last.
// hoveredLinkId (single-link hover) is matched by link id; hoverId (node
// hover) by endpoint node ids. Either may be null.
export function hoverDrawItems(routed, hoverId, baseBatched, hoveredLinkId = null, hoveredSlotIds = null) {
  const hasNode = hoverId !== null && hoverId !== undefined;
  const hasLink = hoveredLinkId !== null && hoveredLinkId !== undefined;
  const hasSlot = !!hoveredSlotIds && hoveredSlotIds.size > 0;
  if (!hasNode && !hasLink && !hasSlot) return baseBatched ? [] : routed;
  const normal = [];
  const hovered = [];
  for (const item of routed) {
    const id = item?.entry?.link?.id;
    const isHoveredLink = (hasLink && id === hoveredLinkId) || (hasSlot && hoveredSlotIds.has(id));
    (isHoveredLink || linkTouchesNode(item, hoverId) ? hovered : normal).push(item);
  }
  return baseBatched ? hovered : normal.concat(hovered);
}

// --- slot-label hover (input/output name or dot on a node) ---

// Label-aware slot hit test. Mirrors litegraph 1.47's own approximation
// (width = 20 + name length * 7) but applied to BOTH sides — litegraph only
// covers label text on inputs. Rects extend right from input dots and left
// from output dots. Uses the long-stable getInputPos/getOutputPos API so it
// works across frontend versions.
// Returns an array of link ids connected to the hit slot (one for inputs,
// possibly several for outputs), or null when no slot is hit or the hit slot
// has no links (caller then falls back to node hover).
export function slotLinkIdsAt(node, gx, gy) {
  const inputs = node?.inputs;
  if (inputs && node.getInputPos) {
    for (const [i, inp] of inputs.entries()) {
      const pos = node.getInputPos(i);
      if (!pos) continue;
      const len =
        inp.label?.length ?? inp.localized_name?.length ?? inp.name?.length;
      const w = 20 + (len || 3) * 7;
      if (gx >= pos[0] - 10 && gx < pos[0] - 10 + w && gy >= pos[1] - 10 && gy < pos[1] + 10)
        return inp.link !== null && inp.link !== undefined ? [inp.link] : null;
    }
  }
  const outputs = node?.outputs;
  if (outputs && node.getOutputPos) {
    for (const [i, out] of outputs.entries()) {
      const pos = node.getOutputPos(i);
      if (!pos) continue;
      const len =
        out.label?.length ?? out.localized_name?.length ?? out.name?.length;
      const w = 20 + (len || 3) * 7;
      if (gx <= pos[0] + 10 && gx > pos[0] + 10 - w && gy >= pos[1] - 10 && gy < pos[1] + 10)
        return out.links?.length ? [...out.links] : null;
    }
  }
  return null;
}

// --- single-link hover hit test ---

// Bounds cached on cached._pb, same convention as draw.js linkBounds.
function boundsOf(cached) {
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

function segDist2(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = a.x + dx * t, cy = a.y + dy * t;
  const ox = px - cx, oy = py - cy;
  return ox * ox + oy * oy;
}

// Topmost link (drawn last = later in the array) whose polyline passes within
// tol graph units of (x, y). Bounds prefilter keeps this sub-millisecond on
// large workflows; only links actually drawn last frame are in `routed`.
export function linkIdAtPoint(routed, x, y, tol) {
  const tol2 = tol * tol;
  for (let i = routed.length - 1; i >= 0; i--) {
    const { entry, cached } = routed[i];
    const pts = cached?.pts;
    if (!entry?.link || !pts || pts.length < 2) continue;
    const b = boundsOf(cached);
    if (x < b.x0 - tol || x > b.x1 + tol || y < b.y0 - tol || y > b.y1 + tol)
      continue;
    for (let s = 0; s < pts.length - 1; s++)
      if (segDist2(x, y, pts[s], pts[s + 1]) <= tol2) return entry.link.id;
  }
  return null;
}

// Few animated links keep full marker density; past the threshold the spacing
// doubles (half density), past 3x the threshold it drops to 20%. The returned
// value multiplies the configured marker gap.
export function animDensityScale(count, threshold, enabled = true) {
  if (!enabled || !threshold || count <= threshold) return 1;
  return count <= threshold * 3 ? 2 : 5;
}
