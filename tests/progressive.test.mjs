import test from "node:test";
import assert from "node:assert/strict";

import {
  adaptiveBudgetMs,
  orderedRouteResults,
  processRouteSlice,
  progressiveItemLimit,
  shouldProgressivelyRoute,
} from "../web/progressive.js";
import { orderRouteCandidates } from "../web/drag-policy.js";

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

test("adaptiveBudgetMs clamps to [6, 14] and falls back without measures", () => {
  // light draw → headroom hits the 14ms cap
  assert.equal(
    adaptiveBudgetMs({ frameIntervalMs: 16.6, drawMsP95: 0.5 }),
    14,
  );
  // heavy draw → floor at 6ms (never starves to 0)
  assert.equal(
    adaptiveBudgetMs({ frameIntervalMs: 16.6, drawMsP95: 20 }),
    6,
  );
  // mid value passes through
  assert.ok(
    Math.abs(adaptiveBudgetMs({ frameIntervalMs: 16.6, drawMsP95: 4 }) - 10.6) < 1e-9,
  );
  // invalid / missing measures → fixed fallback 12
  assert.equal(adaptiveBudgetMs({ frameIntervalMs: NaN, drawMsP95: 2 }), 12);
  assert.equal(adaptiveBudgetMs({ frameIntervalMs: 16.6, drawMsP95: NaN }), 12);
  assert.equal(
    adaptiveBudgetMs({ frameIntervalMs: 0, drawMsP95: 1, fallbackMs: 12 }),
    12,
  );
  // never exceeds maxMs even on 30fps headroom
  assert.equal(
    adaptiveBudgetMs({ frameIntervalMs: 33, drawMsP95: 2, maxMs: 14 }),
    14,
  );
});

test("viewport job reorder does not change orderedRouteResults id sequence", () => {
  const entries = [entry(1), entry(2), entry(3), entry(4)];
  const viewport = { x: 0, y: 0, x2: 100, y2: 100 };
  // Jobs intentionally listed off-screen first; after viewport order, on-screen
  // jobs are processed first, but results still emit in entry order.
  const jobsRaw = [
    { entry: entries[2], bounds: { x: 500, y: 0, x2: 520, y2: 20 } },
    { entry: entries[0], bounds: { x: 10, y: 10, x2: 30, y2: 30 } },
    { entry: entries[3], bounds: { x: 200, y: 0, x2: 220, y2: 20 } },
    { entry: entries[1], bounds: { x: 40, y: 40, x2: 60, y2: 60 } },
  ];
  const orderedJobs = orderRouteCandidates(jobsRaw, viewport);
  // Visible first (ids 1,2), then near off-screen (4), then far (3).
  assert.deepEqual(
    orderedJobs.map((j) => j.entry.link.id),
    [1, 2, 4, 3],
  );
  const batch = {
    entries,
    jobs: orderedJobs,
    index: 0,
    resultsById: new Map(),
  };
  processRouteSlice(batch, (job) => ({ entry: job.entry, cached: { pts: [] } }), {
    maxItems: 99,
    budgetMs: Infinity,
    now: () => 0,
  });
  // Final emit order follows entries, not job processing order.
  assert.deepEqual(
    orderedRouteResults(entries, batch.resultsById).map((r) => r.entry.link.id),
    [1, 2, 3, 4],
  );
});
