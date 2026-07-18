import test from "node:test";
import assert from "node:assert/strict";

import {
  chooseAdaptiveDragMode,
  escalateDragModeAfterFrame,
  escalateLockedDragMode,
  liveCollisionBudget,
  lockAdaptiveDragMode,
  shouldActivateHeavyDrag,
  shouldDeferHeavyGraphBuild,
  shouldStartHeavyDrag,
  shouldUseHeavyWorkflowDrag,
  shouldInvalidateAfterDrag,
  updateRouteCost,
} from "../web/adaptive-policy.js";

test("Adaptive always preserves live avoidance for small and medium drags", () => {
  assert.equal(chooseAdaptiveDragMode(1, 8), "none");
  assert.equal(chooseAdaptiveDragMode(3, 18), "freeze-others");
  assert.equal(chooseAdaptiveDragMode(7, 30), "freeze-others");
  assert.equal(chooseAdaptiveDragMode(15, 300), "freeze-others");
  assert.equal(chooseAdaptiveDragMode(2, 50), "none");
  assert.equal(chooseAdaptiveDragMode(2, 80), "freeze-others");
  assert.equal(chooseAdaptiveDragMode(4, 120), "freeze-others");
  assert.equal(chooseAdaptiveDragMode(16, 5), "freeze-others-strict");
  assert.equal(chooseAdaptiveDragMode(31, 5), "hide-self");
});

test("Adaptive mode locks to direct-link workload for the whole drag", () => {
  assert.equal(lockAdaptiveDragMode(null, 12, 40), "freeze-others");
  assert.equal(
    lockAdaptiveDragMode("freeze-others", 50, 500),
    "freeze-others",
    "collision growth must not promote an existing drag to hide-self",
  );
  assert.equal(lockAdaptiveDragMode(null, 20, 500), "freeze-others-strict");
  assert.equal(lockAdaptiveDragMode(null, 31, 40), "hide-self");
});

test("mode 2 bounds live collision work after direct links", () => {
  assert.equal(liveCollisionBudget("none", 2), Infinity);
  assert.equal(liveCollisionBudget("freeze-others", 12), 3);
  assert.equal(liveCollisionBudget("freeze-others", 15), 0);
  assert.equal(liveCollisionBudget("freeze-others-strict", 12), 0);
  assert.equal(liveCollisionBudget("hide-self", 12), 0);
});

test("heavy workflow scheduling is based on stable graph size", () => {
  assert.equal(shouldUseHeavyWorkflowDrag(145, 192), false);
  assert.equal(shouldUseHeavyWorkflowDrag(466, 573), true);
  assert.equal(shouldUseHeavyWorkflowDrag(250, 100), true);
  assert.equal(shouldUseHeavyWorkflowDrag(100, 300), true);
});

test("heavy deferred can be selected manually or activated by Adaptive", () => {
  assert.equal(shouldActivateHeavyDrag("heavy-deferred", 10, 10), true);
  assert.equal(shouldActivateHeavyDrag("adaptive", 466, 573), true);
  assert.equal(shouldActivateHeavyDrag("adaptive", 145, 192), false);
  assert.equal(shouldActivateHeavyDrag("hide-self", 466, 573), false);
});

test("pan and pointer-down alone never start Heavy Deferred", () => {
  assert.equal(shouldStartHeavyDrag("adaptive", 466, 573, false), false);
  assert.equal(shouldStartHeavyDrag("heavy-deferred", 10, 10, false), false);
  assert.equal(shouldStartHeavyDrag("adaptive", 466, 573, true), true);
  assert.equal(shouldStartHeavyDrag("heavy-deferred", 10, 10, true), true);
});

test("heavy graph builds defer only during continuous movement", () => {
  assert.equal(shouldDeferHeavyGraphBuild(true, true, false, true), true);
  assert.equal(shouldDeferHeavyGraphBuild(true, true, true, true), false);
  assert.equal(shouldDeferHeavyGraphBuild(true, false, false, true), false);
  assert.equal(shouldDeferHeavyGraphBuild(false, true, false, true), false);
  assert.equal(shouldDeferHeavyGraphBuild(true, true, false, false), false);
});

test("Adaptive caps an earlier escalation when live avoidance is affordable", () => {
  assert.equal(chooseAdaptiveDragMode(1, 5, "freeze-others-strict"), "freeze-others");
  assert.equal(chooseAdaptiveDragMode(20, 80, "freeze-others"), "freeze-others-strict");
});

test("drag cleanup reroutes every line touched during the drag", () => {
  assert.equal(shouldInvalidateAfterDrag({ frozen: true }, false), false);
  assert.equal(shouldInvalidateAfterDrag({ frozen: true }, true), true);
  assert.equal(shouldInvalidateAfterDrag({ affected: true }, false), true);
  assert.equal(shouldInvalidateAfterDrag({ draggedHidden: true }, false), true);
  assert.equal(shouldInvalidateAfterDrag({ sticky: true }, false), true);
});

test("route cost uses a stable moving average", () => {
  assert.equal(updateRouteCost(undefined, 10), 10);
  assert.equal(updateRouteCost(10, 20), 13);
});

test("an actually slow drag frame escalates only the following frames", () => {
  assert.equal(escalateDragModeAfterFrame("none", 20, 5), "none");
  assert.equal(escalateDragModeAfterFrame("none", 50, 5), "freeze-others");
  assert.equal(escalateDragModeAfterFrame("freeze-others", 100, 15), "freeze-others");
  assert.equal(escalateDragModeAfterFrame("freeze-others", 50, 20), "freeze-others-strict");
  assert.equal(escalateDragModeAfterFrame("none", 100, 20), "hide-self");
});

test("locked drag mode escalates one-way on measured cost (never downgrades mid-gesture)", () => {
  // 2026-07-18 profile: freeze-others pinned for 6.5s at 60-116ms frames
  // because predictedMs underestimated the real connector cost 2-4x.
  assert.equal(escalateLockedDragMode("freeze-others", 81, 56), "freeze-others-strict");
  assert.equal(escalateLockedDragMode("freeze-others-strict", 85, 56), "hide-self");
  assert.equal(escalateLockedDragMode("freeze-others", 116, 56), "hide-self");
  // Fast frames keep the locked mode.
  assert.equal(escalateLockedDragMode("freeze-others", 12, 56), "freeze-others");
  // Never downgrades, even where escalateDragModeAfterFrame alone would.
  assert.equal(escalateLockedDragMode("hide-self", 3, 4), "hide-self");
  assert.equal(escalateLockedDragMode("freeze-others-strict", 8, 3), "freeze-others-strict");
  // Small active sets keep live avoidance: never past freeze-others.
  assert.equal(escalateLockedDragMode("freeze-others", 100, 12), "freeze-others");
  // Null / adaptive pass through untouched.
  assert.equal(escalateLockedDragMode(null, 100, 56), null);
  assert.equal(escalateLockedDragMode("adaptive", 100, 56), "adaptive");
});
