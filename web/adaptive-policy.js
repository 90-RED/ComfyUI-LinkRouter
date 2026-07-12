// Pure policy helpers for Adaptive drag mode.

export const DRAG_MODE_RANK = {
  none: 0,
  "freeze-others": 1,
  "freeze-others-strict": 2,
  "hide-self": 3,
};

export const LIVE_AVOIDANCE_LIMIT = 15;
export const HEAVY_WORKFLOW_NODE_LIMIT = 250;
export const HEAVY_WORKFLOW_LINK_LIMIT = 300;

function modeAtRank(rank) {
  return Object.keys(DRAG_MODE_RANK).find((key) => DRAG_MODE_RANK[key] === rank) || "none";
}

export function updateRouteCost(previous, sampleMs, weight = 0.3) {
  const sample = Math.max(0, +sampleMs || 0);
  if (!Number.isFinite(previous)) return sample;
  return previous * (1 - weight) + sample * weight;
}

export function chooseAdaptiveDragMode(activeLinks, predictedMs, currentMode = null) {
  const count = Math.max(0, activeLinks | 0);
  const cost = Math.max(0, +predictedMs || 0);
  let candidate;
  if (count <= 2) candidate = "none";
  else if (count <= LIVE_AVOIDANCE_LIMIT) candidate = "freeze-others";
  else if (count <= 30) candidate = "freeze-others-strict";
  else candidate = "hide-self";

  // Up to the synchronous-update limit, measured cost may freeze unaffected
  // lines but must never disable live collision avoidance.
  if (count <= LIVE_AVOIDANCE_LIMIT && cost > 70 && DRAG_MODE_RANK[candidate] < 1)
    candidate = "freeze-others";
  else if (count > LIVE_AVOIDANCE_LIMIT) {
    if (cost > 180) candidate = "hide-self";
    else if (cost > 100 && DRAG_MODE_RANK[candidate] < 2)
      candidate = "freeze-others-strict";
  }

  const maxRank = count <= LIVE_AVOIDANCE_LIMIT
    ? DRAG_MODE_RANK["freeze-others"]
    : count <= 30
      ? DRAG_MODE_RANK["freeze-others-strict"]
      : DRAG_MODE_RANK["hide-self"];
  const currentRank = Math.min(DRAG_MODE_RANK[currentMode] ?? -1, maxRank);
  if (currentRank > DRAG_MODE_RANK[candidate]) return modeAtRank(currentRank);
  return candidate;
}

// Pick the presentation mode once from links directly attached to the moved
// node(s). Collision density may change with drag direction, but must not make
// self-links suddenly disappear midway through the same gesture.
export function lockAdaptiveDragMode(currentMode, directLinks, _predictedMs) {
  if (currentMode && currentMode !== "adaptive") return currentMode;
  // The four presentation levels are count-defined. Historical timing may
  // throttle collision work, but must not change visibility semantics.
  return chooseAdaptiveDragMode(directLinks, 0);
}

// Mode 2 keeps a bounded amount of live collision avoidance. Direct links
// consume the same synchronous-work allowance; overflow collisions remain
// frozen until the held-pause queue or release pass processes them.
export function liveCollisionBudget(effectiveMode, directLinks) {
  if (effectiveMode === "none") return Infinity;
  if (effectiveMode !== "freeze-others") return 0;
  return Math.max(0, LIVE_AVOIDANCE_LIMIT - Math.max(0, directLinks | 0));
}

// Large workflows pay a substantial OVG build cost even before connector A*
// begins. Lock them into the deferred drag scheduler for the whole gesture;
// unlike collision-count promotion, this decision cannot change by direction.
export function shouldUseHeavyWorkflowDrag(nodeCount, linkCount) {
  return (
    Math.max(0, nodeCount | 0) >= HEAVY_WORKFLOW_NODE_LIMIT ||
    Math.max(0, linkCount | 0) >= HEAVY_WORKFLOW_LINK_LIMIT
  );
}

export function shouldActivateHeavyDrag(dragMode, nodeCount, linkCount) {
  if (dragMode === "heavy-deferred") return true;
  if (dragMode !== "adaptive") return false;
  return shouldUseHeavyWorkflowDrag(nodeCount, linkCount);
}

export function shouldStartHeavyDrag(
  dragMode,
  nodeCount,
  linkCount,
  pointerGeometryDragging,
) {
  return !!(
    pointerGeometryDragging &&
    shouldActivateHeavyDrag(dragMode, nodeCount, linkCount)
  );
}

export function shouldDeferHeavyGraphBuild(
  heavyDrag,
  pointerDown,
  pauseActive,
  hasStableRoutes,
) {
  return !!(heavyDrag && pointerDown && !pauseActive && hasStableRoutes);
}

export function escalateDragModeAfterFrame(currentMode, connectorMs, activeLinks = Infinity) {
  const mode = currentMode && currentMode !== "adaptive" ? currentMode : "none";
  const elapsed = Math.max(0, +connectorMs || 0);
  const n = Number(activeLinks);
  const count = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : Infinity;
  if (count <= LIVE_AVOIDANCE_LIMIT) {
    if (DRAG_MODE_RANK[mode] > DRAG_MODE_RANK["freeze-others"])
      return "freeze-others";
    if (elapsed > 45 && mode === "none") return "freeze-others";
    return mode;
  }
  if (elapsed > 90) return "hide-self";
  if (elapsed <= 45) return mode;
  const rank = Math.min(3, (DRAG_MODE_RANK[mode] ?? 0) + 1);
  return modeAtRank(rank);
}

export function shouldInvalidateAfterDrag(flags, collidesWithFinalNode) {
  return !!(
    flags?.affected ||
    flags?.draggedHidden ||
    flags?.sticky ||
    (flags?.frozen && collidesWithFinalNode)
  );
}
