// Drag-settle is only for interactive geometry changes. Vue/DOM nodes may
// report new sizes while panning or zooming; treating those as a drag causes a
// second, unnecessary route pass when sticky paths are released.
export function shouldUseDragSettle(pointerDown, geometry, canvas) {
  if (!pointerDown) return false;
  return (geometry?.positionChanges || 0) > 0 || !!canvas?.resizing_node;
}

// Sticky stretching is only safe when a link endpoint moved. If an unrelated
// link was hit by the dragged node, stretching would preserve the same old
// path through the node and suppress the live avoidance re-route.
export function shouldStretchDragPath({
  dragging,
  hasCachedPath,
  endsMoved,
  hitDirty,
}) {
  return !!(dragging && hasCachedPath && endsMoved && !hitDirty);
}

export function shouldRouteHeldCollision(effectiveMode, pauseActive, collides, attempted = false) {
  return !!(
    pauseActive &&
    collides &&
    !attempted &&
    (
      effectiveMode === "freeze-others" ||
      effectiveMode === "freeze-others-strict" ||
      effectiveMode === "hide-self"
    )
  );
}

export function shouldFreezeHiddenModeLink(isDragged, hasCachedPath, heldCollision) {
  return !!(!isDragged && hasCachedPath && !heldCollision);
}

export function shouldQueueIdleCleanup(effectiveMode, affected, primary, hasCachedPath) {
  return !!(
    effectiveMode === "freeze-others" &&
    affected &&
    !primary &&
    hasCachedPath
  );
}

export function pathBounds(points) {
  if (!points?.length) return null;
  let x = Infinity, y = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const p of points) {
    x = Math.min(x, p.x);
    y = Math.min(y, p.y);
    x2 = Math.max(x2, p.x);
    y2 = Math.max(y2, p.y);
  }
  return { x, y, x2, y2 };
}

function intersects(a, b) {
  return !!(a && b && a.x < b.x2 && a.x2 > b.x && a.y < b.y2 && a.y2 > b.y);
}

function distanceFromViewport(bounds, viewport) {
  if (!bounds || !viewport) return Infinity;
  const dx = bounds.x2 < viewport.x
    ? viewport.x - bounds.x2
    : bounds.x > viewport.x2
      ? bounds.x - viewport.x2
      : 0;
  const dy = bounds.y2 < viewport.y
    ? viewport.y - bounds.y2
    : bounds.y > viewport.y2
      ? bounds.y - viewport.y2
      : 0;
  return dx + dy;
}

// Worker-computed held-pause paths are revealed the very next frame after
// arrival, all at once. Pacing made sense when compute lived on the main
// thread (the one-by-one appearance doubled as progress feedback), but the
// worker now delivers in clumps spread across the whole pause — measured
// pauses last ~100-130ms while 17 paced reveals need another ~280ms, so the
// tail links were discarded on resume without ever showing. A reveal is only
// a couple of Map writes and can never stall the main thread, so the whole
// pending queue drains in a single frame.
export function pauseRevealCount(remaining) {
  if (!(remaining > 0)) return 0;
  return remaining;
}

// Held-pause race: while the worker chews through the whole pause queue,
// the main thread may immediately route links predicted to be cheap, so
// short pauses get the old one-by-one feedback. Unknown links use the
// session-average fallback (usually cheap) — a mis-predicted link costs one
// frame at most, and its true cost is learned for next time.
export function shouldRacePauseLink(costMs, fallbackMs, maxMs) {
  return (costMs === undefined ? fallbackMs : costMs) < maxMs;
}

// Freeze this order when a held pause begins: direct links first, then links
// visible in the current viewport, then off-screen links expanding outward.
export function orderHeldRouteCandidates(candidates, viewport) {
  return candidates
    .map((candidate, index) => {
      const visible = intersects(candidate.bounds, viewport);
      return {
        ...candidate,
        _priority: candidate.direct ? 0 : visible ? 1 : 2,
        _distance: candidate.direct ? 0 : distanceFromViewport(candidate.bounds, viewport),
        _index: index,
      };
    })
    .sort((a, b) =>
      a._priority - b._priority ||
      a._distance - b._distance ||
      a._index - b._index
    )
    .map(({ _priority, _distance, _index, ...candidate }) => candidate);
}
