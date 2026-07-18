import test from "node:test";
import assert from "node:assert/strict";

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
} from "../web/drag-policy.js";

test("passive Vue node size updates do not enter drag-settle mode", () => {
  assert.equal(
    shouldUseDragSettle(true, { positionChanges: 0, sizeChanges: 1 }, {}),
    false,
  );
});

test("held reroutes prioritize self, viewport, then expand outward", () => {
  const viewport = { x: 0, y: 0, x2: 100, y2: 100 };
  const ordered = orderHeldRouteCandidates([
    { id: "far", direct: false, bounds: { x: 300, y: 0, x2: 320, y2: 20 } },
    { id: "visible", direct: false, bounds: { x: 20, y: 20, x2: 40, y2: 40 } },
    { id: "self", direct: true, bounds: { x: 500, y: 500, x2: 520, y2: 520 } },
    { id: "near", direct: false, bounds: { x: 120, y: 0, x2: 140, y2: 20 } },
  ], viewport);
  assert.deepEqual(ordered.map((item) => item.id), ["self", "visible", "near", "far"]);
  assert.deepEqual(pathBounds([{ x: 5, y: 9 }, { x: -2, y: 20 }]), {
    x: -2, y: 9, x2: 5, y2: 20,
  });
});

test("a held direct link bypasses the unrelated-link freeze branch", () => {
  assert.equal(shouldFreezeHiddenModeLink(true, true, false), false);
  assert.equal(shouldFreezeHiddenModeLink(false, true, false), true);
  assert.equal(shouldFreezeHiddenModeLink(false, true, true), false);
});

test("idle cleanup only queues stale Freeze+Check paths after primary work", () => {
  assert.equal(shouldQueueIdleCleanup("freeze-others", true, false, true), true);
  assert.equal(shouldQueueIdleCleanup("freeze-others", true, true, true), false);
  assert.equal(shouldQueueIdleCleanup("freeze-others-strict", true, false, true), false);
  assert.equal(shouldQueueIdleCleanup("freeze-others", false, false, true), false);
});

test("frozen modes slowly route collisions while held still", () => {
  assert.equal(shouldRouteHeldCollision("none", true, true), false);
  assert.equal(shouldRouteHeldCollision("freeze-others", true, true), true);
  assert.equal(shouldRouteHeldCollision("freeze-others-strict", false, true), false);
  assert.equal(shouldRouteHeldCollision("freeze-others-strict", true, false), false);
  assert.equal(shouldRouteHeldCollision("freeze-others-strict", true, true), true);
  assert.equal(shouldRouteHeldCollision("hide-self", true, true), true);
  assert.equal(shouldRouteHeldCollision("hide-self", true, true, true), false);
});

test("real node movement and resize handles still use drag settle", () => {
  assert.equal(shouldUseDragSettle(true, { positionChanges: 1 }, {}), true);
  assert.equal(
    shouldUseDragSettle(true, { positionChanges: 0, sizeChanges: 1 }, { resizing_node: {} }),
    true,
  );
  assert.equal(shouldUseDragSettle(false, { positionChanges: 1 }, {}), false);
});

test("sticky stretching never masks live avoidance for a collided link", () => {
  assert.equal(
    shouldStretchDragPath({
      dragging: true,
      hasCachedPath: true,
      endsMoved: false,
      hitDirty: true,
      effectiveMode: "freeze-others",
    }),
    false,
  );
  assert.equal(
    shouldStretchDragPath({
      dragging: true,
      hasCachedPath: true,
      endsMoved: true,
      hitDirty: false,
      effectiveMode: "freeze-others-strict",
    }),
    true,
  );
  assert.equal(
    shouldStretchDragPath({
      dragging: true,
      hasCachedPath: true,
      endsMoved: true,
      hitDirty: true,
      effectiveMode: "freeze-others-strict",
    }),
    false,
  );
});

test("small and medium live modes may stretch only after geometry validates the path", () => {
  for (const effectiveMode of ["none", "freeze-others"]) {
    assert.equal(
      shouldStretchDragPath({
        dragging: true,
        hasCachedPath: true,
        endsMoved: true,
        hitDirty: false,
        effectiveMode,
      }),
      true,
      `${effectiveMode} should keep a collision-free path stable`,
    );
  }
});


test("pause reveal drains the whole queue in one frame", () => {
  assert.equal(pauseRevealCount(0), 0);
  assert.equal(pauseRevealCount(-3), 0);
  assert.equal(pauseRevealCount(1), 1);
  assert.equal(pauseRevealCount(17), 17);
  assert.equal(pauseRevealCount(500), 500);
  const framesToDrain = (n) => {
    let remaining = n;
    let frames = 0;
    while (remaining > 0) {
      remaining -= Math.min(pauseRevealCount(remaining), remaining);
      frames++;
    }
    return frames;
  };
  // Pacing was removed: measured pauses last ~100-130ms, so trickled reveals
  // never reached the tail links before the drag resumed and discarded them.
  for (let n = 1; n <= 500; n++)
    assert.equal(framesToDrain(n), 1, `queue ${n} should drain in one frame`);
});

test("held-pause race only takes predicted-cheap links", () => {
  assert.equal(shouldRacePauseLink(3, 8, 10), true);
  assert.equal(shouldRacePauseLink(9.9, 8, 10), true);
  assert.equal(shouldRacePauseLink(10, 8, 10), false); // boundary: not cheaper
  assert.equal(shouldRacePauseLink(42, 8, 10), false);
  // Unknown links fall back to the session average (usually cheap).
  assert.equal(shouldRacePauseLink(undefined, 8, 10), true);
  assert.equal(shouldRacePauseLink(undefined, 10, 10), false);
  // The race call site now passes an infinite fallback: links without a
  // main-thread-measured cost are never raced (worker timings and session
  // averages mis-predicted 19-49ms routes as cheap).
  assert.equal(shouldRacePauseLink(undefined, Infinity, 10), false);
  assert.equal(shouldRacePauseLink(3, Infinity, 10), true);
});
