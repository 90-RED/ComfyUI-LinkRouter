import test from "node:test";
import assert from "node:assert/strict";

import { hoverDrawItems, linkIdAtPoint, animDensityScale, slotLinkIdsAt } from "../web/draw-policy.js";

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


// --- single-link hover hit test ---

const seg = (id, pts) => ({
  entry: { link: { id, origin_id: 0, target_id: 0 } },
  cached: { pts },
});

test("linkIdAtPoint hits a polyline within tolerance", () => {
  const routed = [seg(1, [{ x: 0, y: 0 }, { x: 100, y: 0 }])];
  assert.equal(linkIdAtPoint(routed, 50, 3, 5), 1);
  assert.equal(linkIdAtPoint(routed, 0, 0, 5), 1); // endpoint
  assert.equal(linkIdAtPoint(routed, 50, 6, 5), null); // just outside tol
  assert.equal(linkIdAtPoint(routed, 200, 0, 5), null); // outside bounds
  assert.equal(linkIdAtPoint(routed, 50, 1, 0), null); // zero tol, off the line
});

test("linkIdAtPoint returns the topmost (last drawn) link on overlap", () => {
  const routed = [
    seg(1, [{ x: 0, y: 0 }, { x: 100, y: 0 }]),
    seg(2, [{ x: 0, y: 2 }, { x: 100, y: 2 }]),
  ];
  assert.equal(linkIdAtPoint(routed, 50, 1, 5), 2);
  assert.equal(linkIdAtPoint([], 50, 1, 5), null);
});

// --- adaptive marker density ---

test("animDensityScale keeps full density at or below threshold", () => {
  assert.equal(animDensityScale(0, 10), 1);
  assert.equal(animDensityScale(10, 10), 1);
});

test("animDensityScale halves above threshold, drops to 20% past 3x", () => {
  assert.equal(animDensityScale(11, 10), 2);
  assert.equal(animDensityScale(30, 10), 2);
  assert.equal(animDensityScale(31, 10), 5);
});

test("animDensityScale disabled or zero threshold stays full", () => {
  assert.equal(animDensityScale(100, 10, false), 1);
  assert.equal(animDensityScale(100, 0), 1);
});

// --- hoverDrawItems with single-link hover ---

test("hoverDrawItems honors hoveredLinkId without node hover", () => {
  const routed = [item(1, 1, 2), item(2, 3, 4), item(3, 5, 1)];
  assert.deepEqual(
    hoverDrawItems(routed, null, true, 2).map((x) => x.entry.link.id),
    [2],
  );
  assert.deepEqual(
    hoverDrawItems(routed, null, false, 2).map((x) => x.entry.link.id),
    [1, 3, 2],
  );
});

test("hoverDrawItems combines node hover and link hover", () => {
  const routed = [item(1, 1, 2), item(2, 3, 4), item(3, 5, 1)];
  // Hovered items keep their original relative order (routed order).
  assert.deepEqual(
    hoverDrawItems(routed, 1, true, 2).map((x) => x.entry.link.id),
    [1, 2, 3],
  );
  // Fallback, node hover only: unrelated link stays first, related last.
  assert.deepEqual(
    hoverDrawItems(routed, 1, false, null).map((x) => x.entry.link.id),
    [2, 1, 3],
  );
});


// --- slot-label hover hit test ---

const slotNode = () => ({
  inputs: [
    { name: "model", link: 42 },
    { name: "clip", link: null },
  ],
  outputs: [{ name: "MODEL", links: [7, 9] }],
  getInputPos: (i) => [100, 100 + i * 25],
  getOutputPos: () => [200, 100],
});

test("slotLinkIdsAt hits input dot and label text", () => {
  const n = slotNode();
  assert.deepEqual(slotLinkIdsAt(n, 95, 100), [42]); // dot area
  assert.deepEqual(slotLinkIdsAt(n, 130, 100), [42]); // label text ("model" = 5 chars → w 55, x in [90,145))
  assert.equal(slotLinkIdsAt(n, 146, 100), null); // past the label
  assert.equal(slotLinkIdsAt(n, 95, 112), null); // between rows
});

test("slotLinkIdsAt on unconnected input returns null (falls back to node hover)", () => {
  const n = slotNode();
  assert.equal(slotLinkIdsAt(n, 95, 125), null); // "clip" dot, no link
  assert.equal(slotLinkIdsAt(n, 125, 125), null); // "clip" label, no link
});

test("slotLinkIdsAt hits output label left of the dot and fans out to all links", () => {
  const n = slotNode();
  assert.deepEqual(slotLinkIdsAt(n, 205, 100), [7, 9]); // dot area
  assert.deepEqual(slotLinkIdsAt(n, 165, 100), [7, 9]); // label text ("MODEL" → w 55, x in (155,210])
  assert.equal(slotLinkIdsAt(n, 154, 100), null); // past the label
});

test("slotLinkIdsAt tolerates missing geometry helpers", () => {
  assert.equal(slotLinkIdsAt({}, 0, 0), null);
  assert.equal(slotLinkIdsAt(null, 0, 0), null);
  assert.equal(slotLinkIdsAt({ inputs: [{ name: "x", link: 1 }] }, 0, 0), null); // no getInputPos
});

// --- hoverDrawItems with slot hover ---

test("hoverDrawItems honors hoveredSlotIds set", () => {
  const routed = [item(1, 1, 2), item(2, 3, 4), item(3, 5, 6), item(4, 7, 8)];
  const slotIds = new Set([2, 4]);
  assert.deepEqual(
    hoverDrawItems(routed, null, true, null, slotIds).map((x) => x.entry.link.id),
    [2, 4],
  );
  assert.deepEqual(
    hoverDrawItems(routed, null, false, null, slotIds).map((x) => x.entry.link.id),
    [1, 3, 2, 4],
  );
  // Empty set behaves like no slot hover.
  assert.deepEqual(hoverDrawItems(routed, null, true, null, new Set()), []);
});
