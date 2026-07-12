import test from "node:test";
import assert from "node:assert/strict";

import {
  orderedRouteResults,
  processRouteSlice,
  progressiveItemLimit,
  shouldProgressivelyRoute,
} from "../web/progressive.js";

const entry = (id) => ({ link: { id } });

test("progressive routing keeps result order while revealing slices", () => {
  const entries = [entry(1), entry(2), entry(3), entry(4)];
  const batch = {
    entries,
    jobs: entries.map((e) => ({ entry: e })),
    index: 0,
    resultsById: new Map(),
  };
  const routeOne = (job) => ({ entry: job.entry, cached: { pts: [] } });
  const first = processRouteSlice(batch, routeOne, { maxItems: 2, budgetMs: Infinity, now: () => 0 });
  assert.deepEqual(first, { processed: 2, done: false, remaining: 2 });
  assert.deepEqual(orderedRouteResults(entries, batch.resultsById).map((r) => r.entry.link.id), [1, 2]);
  const second = processRouteSlice(batch, routeOne, { maxItems: 2, budgetMs: Infinity, now: () => 0 });
  assert.equal(second.done, true);
  assert.deepEqual(orderedRouteResults(entries, batch.resultsById).map((r) => r.entry.link.id), [1, 2, 3, 4]);
});

test("progressive policy leaves small and drag-settle passes synchronous", () => {
  assert.equal(shouldProgressivelyRoute(false, false, 20), true);
  assert.equal(shouldProgressivelyRoute(true, false, 20), false);
  assert.equal(shouldProgressivelyRoute(false, true, 20), false);
  assert.equal(shouldProgressivelyRoute(false, false, 15), false);
  assert.equal(shouldProgressivelyRoute(false, false, 16), true);
  assert.equal(progressiveItemLimit(573, 10), 58);
});

test("a route slice yields after its time budget", () => {
  const entries = [entry(1), entry(2), entry(3), entry(4)];
  const batch = {
    entries,
    jobs: entries.map((e) => ({ entry: e })),
    index: 0,
    resultsById: new Map(),
  };
  let time = 0;
  const slice = processRouteSlice(
    batch,
    (job) => {
      time += 7;
      return { entry: job.entry, cached: { pts: [] } };
    },
    { maxItems: 10, budgetMs: 12, now: () => time },
  );
  assert.deepEqual(slice, { processed: 2, done: false, remaining: 2 });
});
