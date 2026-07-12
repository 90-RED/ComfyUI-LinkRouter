import test from "node:test";
import assert from "node:assert/strict";

import {
  adaptiveToggleTarget,
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
