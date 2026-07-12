// profiler.js — opt-in 30-second performance recorder for LinkRouter.

const STORAGE_KEY = "linkrouter.profiler.last";
const DEFAULT_DURATION_MS = 30000;
const MAX_SAMPLES = 5000;
const MAX_EVENTS = 500;

const clock = () => globalThis.performance?.now?.() ?? Date.now();
const rounded = (v) => Math.round((v || 0) * 1000) / 1000;

function average(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function phaseSummary(samples, phase) {
  const rows = samples.filter((s) => s.phase === phase);
  const draw = rows.map((s) => s.drawMs);
  const route = rows.map((s) => s.route?.durationMs || 0);
  return {
    frames: rows.length,
    avgDrawMs: rounded(average(draw)),
    maxDrawMs: rounded(Math.max(0, ...draw)),
    avgRouteMs: rounded(average(route)),
    routerBuildMs: rounded(rows.reduce((n, s) => n + (s.route?.buildMs || 0), 0)),
    connectorMs: rounded(rows.reduce((n, s) => n + (s.route?.connectorMs || 0), 0)),
    progressiveFrames: rows.filter((s) => s.route?.progressive).length,
    dragFrames: rows.filter((s) => s.route?.dragging).length,
    graphRebuilds: rows.filter((s) => s.route?.graphRebuilt).length,
    deferredGraphFrames: rows.filter((s) => s.route?.graphDeferred).length,
    heldDirectReroutes: rows.reduce((n, s) => n + (s.route?.heldDirectReroutes || 0), 0),
    heldCollisionReroutes: rows.reduce((n, s) => n + (s.route?.heldCollisionReroutes || 0), 0),
    heldCleanupReroutes: rows.reduce((n, s) => n + (s.route?.heldCleanupReroutes || 0), 0),
    reroutedLinks: rows.reduce((n, s) => n + (s.route?.reroutedLinks || 0), 0),
  };
}

export function buildProfilerReport(session, reason = "manual") {
  const samples = session.samples || [];
  const routes = samples.map((s) => s.route).filter(Boolean);
  const drawTimes = samples.map((s) => s.drawMs);
  const routeTimes = routes.map((r) => r.durationMs || 0);
  const longTasks = (session.events || []).filter((e) => e.kind === "long-task");
  const startedAt = session.startedWall || Date.now();
  const endedAt = Date.now();
  return {
    version: 1,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    stoppedBy: reason,
    durationMs: Math.round(Math.max(0, clock() - (session.startedAt || clock()))),
    privacy: "Timings, viewport values, cache state, node IDs and geometry deltas only.",
    summary: {
      canvasDraws: samples.length,
      avgDrawMs: rounded(average(drawTimes)),
      p95DrawMs: rounded(percentile(drawTimes, 0.95)),
      maxDrawMs: rounded(Math.max(0, ...drawTimes)),
      avgRouteMs: rounded(average(routeTimes)),
      maxRouteMs: rounded(Math.max(0, ...routeTimes)),
      routerBuildMs: rounded(routes.reduce((n, r) => n + (r.buildMs || 0), 0)),
      connectorMs: rounded(routes.reduce((n, r) => n + (r.connectorMs || 0), 0)),
      connectorCalls: routes.reduce((n, r) => n + (r.connectorCalls || 0), 0),
      progressiveFrames: routes.filter((r) => r.progressive).length,
      dragFrames: routes.filter((r) => r.dragging).length,
      maxHiddenDraggedLinks: Math.max(0, ...routes.map((r) => r.hiddenDraggedLinks || 0)),
      routeCalls: routes.length,
      routeFastHits: routes.filter((r) => r.fastHit).length,
      graphRebuilds: routes.filter((r) => r.graphRebuilt).length,
      deferredGraphFrames: routes.filter((r) => r.graphDeferred).length,
      heldDirectReroutes: routes.reduce((n, r) => n + (r.heldDirectReroutes || 0), 0),
      heldCollisionReroutes: routes.reduce((n, r) => n + (r.heldCollisionReroutes || 0), 0),
      heldCleanupReroutes: routes.reduce((n, r) => n + (r.heldCleanupReroutes || 0), 0),
      maxPauseQueueRemaining: Math.max(0, ...routes.map((r) => r.pauseQueueRemaining || 0)),
      reroutedLinks: routes.reduce((n, r) => n + (r.reroutedLinks || 0), 0),
      positionChanges: routes.reduce((n, r) => n + (r.positionChanges || 0), 0),
      sizeChanges: routes.reduce((n, r) => n + (r.sizeChanges || 0), 0),
      batchHits: samples.filter((s) => s.batch?.hit).length,
      batchBuilds: samples.filter((s) => s.batch && !s.batch.hit && !s.batch.unsupported).length,
      strokeCalls: samples.reduce((n, s) => n + (s.strokeCalls || 0), 0),
      longTasks: longTasks.length,
      longTaskTotalMs: rounded(longTasks.reduce((n, e) => n + e.durationMs, 0)),
      maxEventLoopDelayMs: rounded(session.maxEventLoopDelayMs || 0),
    },
    byPhase: {
      idle: phaseSummary(samples, "idle"),
      pan: phaseSummary(samples, "pan"),
      zoom: phaseSummary(samples, "zoom"),
    },
    events: session.events || [],
    samples,
  };
}

class LinkRouterProfiler {
  constructor() {
    this.active = false;
    this.onChange = null;
    this.lastReport = this.loadLastReport();
    this.session = null;
    this._timer = null;
    this._lagTimer = null;
    this._observer = null;
    this._currentFrame = null;
  }

  loadLastReport() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch {
      return null;
    }
  }

  start(durationMs = DEFAULT_DURATION_MS) {
    if (this.active) return;
    this.active = true;
    this.session = {
      startedAt: clock(),
      startedWall: Date.now(),
      durationMs,
      samples: [],
      events: [],
      lastViewport: null,
      maxEventLoopDelayMs: 0,
    };
    this._timer = setTimeout(() => this.stop("automatic-30s"), durationMs);
    let expected = clock() + 100;
    this._lagTimer = setInterval(() => {
      const now = clock();
      const delay = Math.max(0, now - expected);
      expected = now + 100;
      if (this.session) this.session.maxEventLoopDelayMs = Math.max(this.session.maxEventLoopDelayMs, delay);
      if (delay >= 16) this.addEvent({ kind: "event-loop-delay", durationMs: rounded(delay) });
    }, 100);
    try {
      this._observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          this.addEvent({ kind: "long-task", durationMs: rounded(e.duration) });
      });
      this._observer.observe({ entryTypes: ["longtask"] });
    } catch {}
    this.onChange?.();
  }

  stop(reason = "manual") {
    if (!this.active || !this.session) return this.lastReport;
    this.active = false;
    clearTimeout(this._timer);
    clearInterval(this._lagTimer);
    this._observer?.disconnect?.();
    this._timer = this._lagTimer = this._observer = null;
    this._currentFrame = null;
    this.lastReport = buildProfilerReport(this.session, reason);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.lastReport)); } catch {}
    console.info("[LinkRouter Profiler] recording complete", this.lastReport);
    this.session = null;
    this.onChange?.();
    return this.lastReport;
  }

  addEvent(event) {
    if (!this.active || !this.session || this.session.events.length >= MAX_EVENTS) return;
    this.session.events.push({ atMs: rounded(clock() - this.session.startedAt), ...event });
  }

  beginFrame(canvas) {
    if (!this.active || !this.session) return null;
    const scale = +(canvas?.ds?.scale || 1);
    const offset = canvas?.ds?.offset || [0, 0];
    const viewport = { scale, x: +offset[0] || 0, y: +offset[1] || 0 };
    const last = this.session.lastViewport;
    let phase = "idle";
    if (last) {
      if (Math.abs(scale - last.scale) > 0.0001) phase = "zoom";
      else if (Math.abs(viewport.x - last.x) > 0.01 || Math.abs(viewport.y - last.y) > 0.01)
        phase = "pan";
    }
    this.session.lastViewport = viewport;
    const frame = {
      startedAt: clock(),
      atMs: rounded(clock() - this.session.startedAt),
      phase,
      scale: rounded(scale),
      offset: [rounded(viewport.x), rounded(viewport.y)],
      route: null,
      batch: null,
    };
    this._currentFrame = frame;
    return frame;
  }

  recordRoute(stats) {
    if (!this.active || !this._currentFrame) return;
    this._currentFrame.route = stats;
    if (stats.graphRebuilt) {
      this.addEvent({
        kind: "graph-rebuild",
        phase: this._currentFrame.phase,
        durationMs: stats.durationMs,
        positionChanges: stats.positionChanges || 0,
        sizeChanges: stats.sizeChanges || 0,
        newNodes: stats.newNodes || 0,
        deletedNodes: stats.deletedNodes || 0,
        reroutedLinks: stats.reroutedLinks || 0,
        routerBuildMs: stats.buildMs || 0,
        connectorMs: stats.connectorMs || 0,
        connectorCalls: stats.connectorCalls || 0,
        progressive: !!stats.progressive,
        queuedLinks: stats.queuedLinks || 0,
        batchRemaining: stats.batchRemaining || 0,
        requestedDragMode: stats.requestedDragMode || null,
        effectiveDragMode: stats.effectiveDragMode || null,
        draggedNodes: stats.draggedNodes || 0,
        draggedLinks: stats.draggedLinks || 0,
        collisionLinks: stats.collisionLinks || 0,
        activeLinks: stats.activeLinks || 0,
        predictedMs: stats.predictedMs || 0,
        hiddenDraggedLinks: stats.hiddenDraggedLinks || 0,
        geometry: stats.geometry || [],
      });
    }
  }

  recordBatch(stats) {
    if (this.active && this._currentFrame) this._currentFrame.batch = stats;
  }

  endFrame(frame, stats = {}) {
    if (!frame || !this.active || !this.session) return;
    frame.drawMs = rounded(clock() - frame.startedAt);
    frame.links = stats.links || 0;
    frame.strokeCalls = stats.strokeCalls || 0;
    frame.batched = !!stats.batched;
    if (stats.fallback) frame.fallback = true;
    delete frame.startedAt;
    if (this.session.samples.length < MAX_SAMPLES) this.session.samples.push(frame);
    if (frame.drawMs >= 16)
      this.addEvent({ kind: "slow-link-frame", phase: frame.phase, durationMs: frame.drawMs });
    if (this._currentFrame === frame) this._currentFrame = null;
  }

  reportText() {
    return this.lastReport ? JSON.stringify(this.lastReport, null, 2) : "";
  }

  async copyLastReport() {
    const text = this.reportText();
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export const profiler = new LinkRouterProfiler();
