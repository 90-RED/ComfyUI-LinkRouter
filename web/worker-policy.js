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
