import test from "node:test";
import assert from "node:assert/strict";

import {
  WARMUP_JOB_REV,
  buildWorkerWarmupPayload,
  watchdogTimeoutAction,
  workerErrorAction,
} from "../web/worker-policy.js";

// --- workerErrorAction ---

test("a stale-batch error is ignored and cannot kill the worker", () => {
  assert.equal(workerErrorAction(3, 4, 0), "ignore");
  assert.equal(workerErrorAction(1, 4, 2), "ignore");
});

test("an error without a jobRev counts as current (cannot be proven stale)", () => {
  assert.equal(workerErrorAction(undefined, 4, 0), "degrade");
  assert.equal(workerErrorAction(null, 4, 0), "degrade");
});

test("a current-batch error degrades only that batch", () => {
  assert.equal(workerErrorAction(4, 4, 0), "degrade");
  assert.equal(workerErrorAction(4, 4, 1), "degrade");
});

test("repeated consecutive batch errors disable the worker (backstop)", () => {
  // maxConsecutive defaults to 3: the third error in a row fails the worker.
  assert.equal(workerErrorAction(4, 4, 2), "fail");
  assert.equal(workerErrorAction(4, 4, 5), "fail");
});

test("custom maxConsecutive threshold is honored", () => {
  assert.equal(workerErrorAction(4, 4, 0, 1), "fail");
  assert.equal(workerErrorAction(4, 4, 4, 10), "degrade");
});

// --- watchdogTimeoutAction ---

test("a rev mismatch means the batch was superseded: ignore", () => {
  assert.equal(
    watchdogTimeoutAction({
      revMatches: false,
      stableWorkerBatch: true,
      pauseWorkerBatch: true,
    }),
    "ignore",
  );
});

test("a silent stable batch is fatal (worker hung)", () => {
  assert.equal(
    watchdogTimeoutAction({
      revMatches: true,
      stableWorkerBatch: true,
      pauseWorkerBatch: false,
    }),
    "fail",
  );
});

test("a silent held-pause batch only drops that batch", () => {
  assert.equal(
    watchdogTimeoutAction({
      revMatches: true,
      stableWorkerBatch: false,
      pauseWorkerBatch: true,
    }),
    "drop-pause",
  );
});

test("no live batch at timeout: nothing to do", () => {
  assert.equal(
    watchdogTimeoutAction({
      revMatches: true,
      stableWorkerBatch: false,
      pauseWorkerBatch: false,
    }),
    "ignore",
  );
});

test("worker warmup payload uses reserved negative jobRev and tiny jobs", () => {
  assert.equal(WARMUP_JOB_REV, -1);
  assert.ok(WARMUP_JOB_REV < 0);
  const payload = buildWorkerWarmupPayload();
  assert.equal(payload.type, "route");
  assert.equal(payload.jobRev, WARMUP_JOB_REV);
  assert.ok(payload.jobs.length >= 1 && payload.jobs.length <= 2);
  assert.equal(payload.rects.length % 4, 0);
  assert.ok(payload.rects.length / 4 >= 2);
  // Warmup errors must not kill the worker: rev never matches live (≥0).
  assert.equal(workerErrorAction(WARMUP_JOB_REV, 0, 0), "ignore");
  assert.equal(workerErrorAction(WARMUP_JOB_REV, 5, 2), "ignore");
});
