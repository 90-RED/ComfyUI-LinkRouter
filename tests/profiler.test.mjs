import test from "node:test";
import assert from "node:assert/strict";

import { buildProfilerReport } from "../web/profiler.js";

test("profiler summary separates idle, pan, and zoom activity", () => {
  const session = {
    startedAt: performance.now() - 1000,
    startedWall: Date.now() - 1000,
    maxEventLoopDelayMs: 22,
    events: [{ kind: "long-task", durationMs: 51 }],
    samples: [
      { phase: "idle", drawMs: 2, strokeCalls: 24, route: { durationMs: 0.1, fastHit: true, graphDeferred: true } },
      { phase: "pan", drawMs: 20, strokeCalls: 24, route: { durationMs: 12, graphRebuilt: true, sizeChanges: 3, reroutedLinks: 8, buildMs: 2, connectorMs: 9, connectorCalls: 8, progressive: true, dragging: true, effectiveDragMode: "freeze-others", hiddenDraggedLinks: 2, heldDirectReroutes: 1, heldCollisionReroutes: 1, heldCleanupReroutes: 1, pauseQueueRemaining: 4 } },
      { phase: "zoom", drawMs: 8, strokeCalls: 24, route: { durationMs: 0.2, fastHit: true } },
    ],
  };
  const report = buildProfilerReport(session, "test");
  assert.equal(report.summary.canvasDraws, 3);
  assert.equal(report.summary.graphRebuilds, 1);
  assert.equal(report.summary.deferredGraphFrames, 1);
  assert.equal(report.summary.heldDirectReroutes, 1);
  assert.equal(report.summary.heldCollisionReroutes, 1);
  assert.equal(report.summary.heldCleanupReroutes, 1);
  assert.equal(report.summary.maxPauseQueueRemaining, 4);
  assert.equal(report.summary.sizeChanges, 3);
  assert.equal(report.summary.reroutedLinks, 8);
  assert.equal(report.summary.longTasks, 1);
  assert.equal(report.summary.routerBuildMs, 2);
  assert.equal(report.summary.connectorMs, 9);
  assert.equal(report.summary.connectorCalls, 8);
  assert.equal(report.summary.progressiveFrames, 1);
  assert.equal(report.summary.dragFrames, 1);
  assert.equal(report.summary.maxHiddenDraggedLinks, 2);
  assert.equal(report.byPhase.pan.graphRebuilds, 1);
  assert.equal(report.byPhase.idle.deferredGraphFrames, 1);
  assert.equal(report.byPhase.pan.connectorMs, 9);
  assert.equal(report.byPhase.zoom.frames, 1);
});
