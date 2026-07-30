// Pure decisions for worker-client.js, kept free of state.js/app imports so
// node tests can exercise them (the integration layer stays in
// worker-client.js / routing.js).

// An "error" message from the worker:
//  - stale jobRev      -> "ignore":  a cancelled batch's late error must not
//                        kill a worker that is already running a newer batch.
//  - too many in a row -> "fail":    systemic; disable the worker for the
//                        session (failWorker, main-thread routing from then on).
//  - otherwise         -> "degrade": drop this batch only; the main thread
//                        re-routes it and the worker stays enabled.
// Errors without a jobRev cannot be proven stale, so they count as current.
export function workerErrorAction(
  msgJobRev,
  currentJobRev,
  consecutiveErrors,
  maxConsecutive = 3,
) {
  if (
    msgJobRev !== undefined &&
    msgJobRev !== null &&
    msgJobRev !== currentJobRev
  )
    return "ignore";
  return consecutiveErrors + 1 >= maxConsecutive ? "fail" : "degrade";
}

// Watchdog timeout: a silent stable batch means the worker is hung (fatal —
// failWorker). A silent held-pause batch only drops that batch: the per-frame
// main-thread pause drain takes over, same degrade path as a manual cancel.
export function watchdogTimeoutAction({
  revMatches,
  stableWorkerBatch,
  pauseWorkerBatch,
}) {
  if (!revMatches) return "ignore";
  if (stableWorkerBatch) return "fail";
  if (pauseWorkerBatch) return "drop-pause";
  return "ignore";
}

// Worker prewarm (Phase D1). A tiny synthetic batch is posted right after
// worker creation so the module load and the OrthoRouter JIT/build path are
// warm before the first real batch. It uses a reserved NEGATIVE jobRev:
// real revs start at 0 and only increase (dispatch/cancel/resetRouter), so
// the existing stale-rev drop in handleMessage discards every warmup
// result/done/error — no watchdog, no failWorker, no pathCache writes, and
// no risk of staling a user batch.
export const WARMUP_JOB_REV = -1;

// Two nodes with a clear straight corridor, one exact (weight 1) job pair —
// the same code path a real stable batch exercises. Kept dependency-free so
// node tests can feed it straight into router-worker-core's engine.
export function buildWorkerWarmupPayload(margin = 16, bendPenalty = 40) {
  const pts = [
    100, 50, // out
    100, 50, // bodyOut
    116, 50, // stubOut
    384, 50, // stubIn
    400, 50, // bodyIn
    400, 50, // inp
  ];
  const job = (id) => ({ id, endsKey: "warmup", opts: null, oldPts: null, pts });
  return {
    type: "route",
    jobRev: WARMUP_JOB_REV,
    graphRev: "warmup",
    configKey: "warmup",
    margin,
    bendPenalty,
    rects: new Float64Array([0, 0, 100, 100, 400, 0, 100, 100]),
    terminals: new Float64Array([116, 50, 384, 50, 100, 50, 400, 50]),
    jobs: [job(1), job(2)],
  };
}
