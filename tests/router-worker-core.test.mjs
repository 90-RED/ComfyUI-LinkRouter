import test from "node:test";
import assert from "node:assert/strict";

import { createEngine } from "../web/router-worker-core.js";

// Minimal two-node layout with a clear straight corridor.
const RECTS = [
  { x: 0, y: 0, w: 100, h: 100 },
  { x: 400, y: 0, w: 100, h: 100 },
];
const out = { x: 100, y: 50 };
const stubOut = { x: 116, y: 50 };
const stubIn = { x: 384, y: 50 };
const inp = { x: 400, y: 50 };

function makeJob(id, opts = null) {
  return {
    id,
    endsKey: id + ":ends",
    opts,
    oldPts: null,
    pts: [
      out.x, out.y,
      out.x, out.y, // bodyOut
      stubOut.x, stubOut.y,
      stubIn.x, stubIn.y,
      inp.x, inp.y, // bodyIn
      inp.x, inp.y,
    ],
  };
}

function runBatch(jobs) {
  const messages = [];
  const engine = createEngine((msg) => messages.push(msg));
  engine.handleMessage({
    type: "route",
    jobRev: 7,
    graphRev: "g1",
    configKey: "k1",
    margin: 16,
    bendPenalty: 40,
    rects: new Float64Array(RECTS.flatMap((r) => [r.x, r.y, r.w, r.h])),
    // Same terminal layout buildWorkerPayload produces:
    // stubOut, stubIn, bodyOut, bodyIn, out, inp per entry.
    terminals: new Float64Array([
      stubOut.x, stubOut.y, stubIn.x, stubIn.y,
      out.x, out.y, inp.x, inp.y,
      out.x, out.y, inp.x, inp.y,
    ]),
    jobs,
  });
  return new Promise((resolve) => setTimeout(() => resolve(messages), 50));
}

test("worker routes jobs without opts exactly (weight 1) and streams results", async () => {
  const messages = await runBatch([makeJob(1), makeJob(2)]);
  const results = messages.filter((m) => m.type === "result");
  const done = messages.find((m) => m.type === "done");
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(r.jobRev, 7);
    assert.equal(r.ok, true);
    assert.ok(r.buf instanceof Float64Array);
    assert.equal(r.buf.length >= 4, true);
    assert.equal(r.sticky, false);
    assert.equal(r.stats.weight, 1);
  }
  assert.deepEqual(results.map((r) => r.id), [1, 2]);
  assert.ok(done, "expected a done message");
  assert.equal(done.jobRev, 7);
});

test("per-job opts pass through to the router (held-pause drag parity)", async () => {
  const messages = await runBatch([
    makeJob(11, { weight: 2.5, popsBudget: 80000 }),
    makeJob(12),
  ]);
  const byId = new Map(
    messages.filter((m) => m.type === "result").map((m) => [m.id, m]),
  );
  assert.equal(byId.get(11).stats.weight, 2.5, "held-pause opts must reach routeConnector");
  assert.equal(byId.get(12).stats.weight, 1, "stable jobs stay exact");
  assert.equal(byId.get(11).ok, true);
  assert.equal(byId.get(12).ok, true);
});

test("a newer batch supersedes an in-flight batch (no stale results)", async () => {
  const messages = [];
  let tick = 0;
  // Injected clock jumps 20ms per read so every job exceeds CHUNK_MS and the
  // pump yields after the first job — letting the second batch arrive
  // mid-flight deterministically.
  const engine = createEngine((msg) => messages.push(msg), () => (tick += 20));
  const payload = (jobRev, jobs) => ({
    type: "route",
    jobRev,
    graphRev: "g2",
    configKey: "k1",
    margin: 16,
    bendPenalty: 40,
    rects: new Float64Array(RECTS.flatMap((r) => [r.x, r.y, r.w, r.h])),
    terminals: new Float64Array([
      stubOut.x, stubOut.y, stubIn.x, stubIn.y,
      out.x, out.y, inp.x, inp.y,
      out.x, out.y, inp.x, inp.y,
    ]),
    jobs,
  });
  engine.handleMessage(payload(9, [makeJob(91), makeJob(92), makeJob(93)]));
  engine.handleMessage(payload(10, [makeJob(101)]));
  await new Promise((r) => setTimeout(r, 50));
  const results = messages.filter((m) => m.type === "result");
  assert.deepEqual(
    results.map((m) => m.id),
    [91, 101],
    "only the first in-flight job may complete before the newer batch takes over",
  );
  const dones = messages.filter((m) => m.type === "done").map((m) => m.jobRev);
  assert.deepEqual(dones, [10], "stale batch must not report done");
});
