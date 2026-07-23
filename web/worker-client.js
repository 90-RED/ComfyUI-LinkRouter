// worker-client.js — main-thread transport for the router worker.
//
// Owns the Worker instance, the job revision counter (stale results are
// discarded by rev), and the failure watchdog. Fatal failures (construction,
// runtime error, unresponsive stable batch, repeated batch errors)
// permanently fall back to main-thread routing for the session — the sync
// path in routing.js is always intact. A single failed batch only degrades
// that batch to the main thread (see worker-policy.js).
//
// routing.js injects its handlers via initWorkerClient() so this module
// never needs to import routing.js (no import cycle).

import { M } from "./state.js";
import { watchdogTimeoutAction, workerErrorAction } from "./worker-policy.js";

const WATCHDOG_MS = 3000;

let worker = null;
let watchdog = 0;
let handlers = null; // { onResult(msg), onDone(jobRev), onFailed(), onBatchError(msg), onPauseTimeout() }
let consecutiveBatchErrors = 0; // backstop: N in a row -> failWorker

export function initWorkerClient(h) {
  handlers = h;
}

export function workerRoutingUsable() {
  if (M.S.workerRouting === false || M._workerFailed) return false;
  if (typeof Worker === "undefined" || typeof document === "undefined") return false;
  return true;
}

function ensureWorker() {
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./router-worker.js", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (ev) => handleMessage(ev.data);
    worker.onerror = (e) => {
      failWorker("worker error: " + (e?.message || "unknown"));
    };
    M._worker = worker;
    return worker;
  } catch (e) {
    failWorker("worker creation failed: " + (e?.message || e));
    return null;
  }
}

function failWorker(reason) {
  if (!M._workerFailed)
    console.warn("[LinkRouter]", reason, "— falling back to main-thread routing");
  M._workerFailed = true;
  clearTimeout(watchdog);
  try {
    worker?.terminate();
  } catch {}
  worker = null;
  M._worker = null;
  handlers?.onFailed?.();
}

function armWatchdog(jobRev) {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    const action = watchdogTimeoutAction({
      revMatches: M._workerJobRev === jobRev,
      stableWorkerBatch: !!M.routeBatch?.worker,
      pauseWorkerBatch: !!M._dragPauseWorker,
    });
    if (action === "fail") failWorker("worker unresponsive");
    // Held-pause batches are not fatal: routing.js drops the batch and lets
    // the per-frame main-thread pause drain take over.
    else if (action === "drop-pause") handlers?.onPauseTimeout?.(jobRev);
  }, WATCHDOG_MS);
}

function handleMessage(msg) {
  if (!msg) return;
  if (msg.type === "result") {
    if (msg.jobRev !== M._workerJobRev) return; // stale job
    consecutiveBatchErrors = 0; // any progress proves the worker is alive
    armWatchdog(msg.jobRev);
    handlers?.onResult?.(msg);
  } else if (msg.type === "done") {
    if (msg.jobRev !== M._workerJobRev) return;
    consecutiveBatchErrors = 0;
    clearTimeout(watchdog);
    handlers?.onDone?.(msg.jobRev);
  } else if (msg.type === "error") {
    const action = workerErrorAction(
      msg.jobRev,
      M._workerJobRev,
      consecutiveBatchErrors,
    );
    if (action === "ignore") return; // late error from a cancelled batch
    if (action === "fail") {
      failWorker("worker reported repeated batch errors: " + msg.message);
      return;
    }
    consecutiveBatchErrors++;
    clearTimeout(watchdog); // the batch is dead; stop waiting on it
    handlers?.onBatchError?.(msg);
  }
}

// Returns the new jobRev on success, false when the worker is unavailable.
export function dispatchWorkerBatch(payload) {
  const w = ensureWorker();
  if (!w) return false;
  const jobRev = ++M._workerJobRev;
  payload.jobRev = jobRev;
  try {
    w.postMessage(payload);
  } catch (e) {
    failWorker("dispatch failed: " + (e?.message || e));
    return false;
  }
  armWatchdog(jobRev);
  return jobRev;
}

export function cancelWorkerBatch() {
  M._workerJobRev++;
  clearTimeout(watchdog);
  try {
    worker?.postMessage({ type: "cancel" });
  } catch {}
}
