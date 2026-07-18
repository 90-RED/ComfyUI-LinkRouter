import test from "node:test";
import assert from "node:assert/strict";

import {
  adaptiveToggleTarget,
  barLeftFor,
  barStoredXFor,
  FIXED_DRAG_MODES,
  isFixedDragMode,
} from "../web/ui-policy.js";

test("Adaptive toggles to the last fixed mode and back", () => {
  assert.equal(FIXED_DRAG_MODES.length, 5);
  assert.equal(adaptiveToggleTarget("adaptive", "hide-self"), "hide-self");
  assert.equal(adaptiveToggleTarget("adaptive", "invalid"), "freeze-others");
  assert.equal(adaptiveToggleTarget("freeze-others", "hide-self"), "adaptive");
  assert.equal(isFixedDragMode("heavy-deferred"), true);
  assert.equal(isFixedDragMode("adaptive"), false);
});

test("bar grows leftward: right edge anchored when a wider row opens", () => {
  // Collapsed: left equals the stored position.
  assert.equal(barLeftFor(500, 300, 300), 500);
  // Wider row open: left shifts left by the overflow; right edge is fixed.
  assert.equal(barLeftFor(500, 300, 460), 340);
  assert.equal(340 + 460, 500 + 300);
  // Impossible narrower input must not drift right (stale baseWidth guard).
  assert.equal(barLeftFor(500, 300, 250), 500);
  // Clamp at the left screen edge.
  assert.equal(barLeftFor(40, 300, 500), 0);
  // Drag normalization round-trips: stored position restores both states.
  const stored = barStoredXFor(340, 300, 460);
  assert.equal(stored, 500);
  assert.equal(barLeftFor(stored, 300, 460), 340); // rows open: same spot
  assert.equal(barLeftFor(stored, 300, 300), 500); // rows closed: basis left
});
