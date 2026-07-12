import test from "node:test";
import assert from "node:assert/strict";

import { hoverDrawItems } from "../web/draw-policy.js";

const item = (id, origin, target) => ({
  entry: { link: { id, origin_id: origin, target_id: target } },
});

test("batched hover overlays only related links", () => {
  const routed = [item(1, 1, 2), item(2, 3, 4), item(3, 5, 1)];
  assert.deepEqual(
    hoverDrawItems(routed, 1, true).map((x) => x.entry.link.id),
    [1, 3],
  );
  assert.deepEqual(hoverDrawItems(routed, null, true), []);
});

test("fallback hover preserves unrelated order and draws related links last", () => {
  const routed = [item(1, 1, 2), item(2, 3, 4), item(3, 5, 1), item(4, 6, 7)];
  assert.deepEqual(
    hoverDrawItems(routed, 1, false).map((x) => x.entry.link.id),
    [2, 4, 1, 3],
  );
  assert.equal(hoverDrawItems(routed, null, false), routed);
});
