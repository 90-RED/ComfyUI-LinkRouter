import test from "node:test";
import assert from "node:assert/strict";

import {
  orderHeldRouteCandidates,
  pathBounds,
  shouldFreezeHiddenModeLink,
  shouldQueueIdleCleanup,
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
