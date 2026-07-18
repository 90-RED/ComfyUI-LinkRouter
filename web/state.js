// state.js — shared mutable state for LinkRouter.
//
// All cross-module variables live in `M`. Other modules import `M` and
// read/write via `M.xxx` — no ES live-binding reassignment issues.
// state.js depends only on router.js and app.js (no other local deps).

import { OrthoRouter } from "./router.js";
import { app } from "../../scripts/app.js";

export const M = {
  // --- localStorage key ---
  LS_KEY: "linkrouter.state",

  // --- floating-bar persisted state ---
  barState: (() => {
    try {
      return Object.assign(
        {
          debug: false,
          debugPanel: false,
          lastFlowMode: "animated",
          lastCornerMode: "per-line",
          lastManualDragMode: "freeze-others",
          recordSeconds: 30,
          btnX: null,
          btnY: null,
        },
        JSON.parse(localStorage.getItem("linkrouter.state") || "{}"),
      );
    } catch {
      return {
        debug: false,
        debugPanel: false,
        lastFlowMode: "animated",
        lastCornerMode: "per-line",
        lastManualDragMode: "freeze-others",
        recordSeconds: 30,
        btnX: null,
        btnY: null,
      };
    }
  })(),
  saveBarState() {
    localStorage.setItem("linkrouter.state", JSON.stringify(this.barState));
  },

  // --- settings cache (filled initially by settings.js) ---
  S: {},

  ROUTER_KEYS: new Set([
    "margin", "marginL", "marginR", "marginT", "marginB",
    "marginMode", "bendPenalty",
  ]),

  // --- execution state ---
  running: false,

  // --- routing state ---
  router: null,
  graphSig: "",
  routeFastSig: "",
  routeGraph: null,
  routeResults: null,
  routeBatch: null,
  routeBatchRaf: 0,
  _deferredGraphBuild: false,
  routeCostByLink: new Map(),
  routeCostByLinkMT: new Map(), // main-thread-measured costs only (pause race gate)
  routeCostAverage: NaN,
  prevRects: new Map(),
  pathCache: new Map(),   // linkId -> {ends, pts, sticky, segs, total}
  failedRoutes: new Map(), // linkId -> {ends, fails, retryAt, bounds}
  bounding: new Float32Array(4),
  settleTimer: null,
  _dragMovedIds: null,
  _dragAdaptiveMode: null,
  _dragHeavyActive: null,
  _dragLastFastSig: "",
  _dragHiddenLinkIds: new Set(),
  _dragAffectedLinkIds: new Set(),
  _dragPauseActive: false,
  _dragPausePending: false,
  _dragPauseQueue: null,
  _dragPauseCleanupLinkIds: new Set(),
  _dragPauseAttemptedLinkIds: new Set(),
  _dragPauseCompletedLinkIds: new Set(),
  _dragPauseRevealQueue: [], // [{linkId, cached}] worker-computed, awaiting per-frame reveal
  _dragInterruptedBatch: false,
  _lastDragSettle: null,
  _lastDragMode: "none",
  _pointerDown: false,
  _nodeDragActive: false,

  // --- animation state ---
  animActive: false,
  rafId: 0,
  lastFrame: 0,

  // --- overlay animation layer ---
  _animLinks: [], // [{cached, color, alpha}] rebuilt by each drawAll
  _overlayCanvas: null,
  _overlayCtx: null,
  _overlayFailed: false,
  _overlayLoop: false,

  // --- router worker (Phase D) ---
  _worker: null,      // Worker instance (owned by worker-client.js)
  _workerFailed: false,
  _workerJobRev: 0,   // bumped on every dispatch/cancel; stale results die
  _dragPauseWorker: null, // { jobRev, jobsById } held-pause queue dispatched to worker

  // --- hover tracking ---
  mouseClient: null, // {x, y} in client space

  // --- floating bar DOM refs ---
  uiBox: null,   // DOM element
  barRefs: null, // floating-bar controls used by refreshBar()

  // --- pure helpers (depend only on M.S) ---

  currentMargin() {
    if (this.S.marginMode === "uniform") return +this.S.margin || 16;
    return {
      l: +this.S.marginL || 16,
      r: +this.S.marginR || 16,
      t: +this.S.marginT || 16,
      b: +this.S.marginB || 16,
    };
  },

  resetRouter() {
    if (this.routeBatchRaf) {
      const cancel = globalThis.cancelAnimationFrame || globalThis.clearTimeout;
      cancel?.(this.routeBatchRaf);
    }
    this.router = new OrthoRouter({
      margin: this.currentMargin(),
      bendPenalty: +this.S.bendPenalty || 40,
    });
    this.graphSig = "";
    this.routeFastSig = "";
    this.routeGraph = null;
    this.routeResults = null;
    this.routeBatch = null;
    this.routeBatchRaf = 0;
    this._deferredGraphBuild = false;
    this.routeCostByLink.clear();
    this.routeCostByLinkMT.clear();
    this.routeCostAverage = NaN;
    this.prevRects = new Map();
    this.pathCache.clear();
    this.failedRoutes.clear();
    this._dragAdaptiveMode = null;
    this._dragHeavyActive = null;
    this._dragLastFastSig = "";
    this._dragHiddenLinkIds.clear();
    this._dragAffectedLinkIds.clear();
    this._dragPauseActive = false;
    this._dragPausePending = false;
    this._dragPauseQueue = null;
    this._dragPauseCleanupLinkIds.clear();
    this._dragPauseAttemptedLinkIds.clear();
    this._dragPauseCompletedLinkIds.clear();
    this._dragPauseRevealQueue.length = 0;
    this._dragPauseWorker = null;
    this._dragInterruptedBatch = false;
    this._lastDragSettle = null;
    this._nodeDragActive = false;
    this._animLinks.length = 0;
    // Orphan any in-flight worker batch: bump the rev so its results are
    // discarded, and tell the worker to stop (worker-client owns the object).
    this._workerJobRev++;
    try {
      this._worker?.postMessage({ type: "cancel" });
    } catch {}
    app.canvas?.setDirty(true, true);
  },

  animEnabledNow() {
    if (this.running && this.S.animDuringRun === "off") return false;
    return true;
  },

  currentFPS() {
    if (this.running && this.S.animDuringRun === "low") return 10;
    return +this.S.animFPS || 30;
  },
};
