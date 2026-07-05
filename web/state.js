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
        { debug: false, btnX: null, btnY: null },
        JSON.parse(localStorage.getItem("linkrouter.state") || "{}"),
      );
    } catch {
      return { debug: false, btnX: null, btnY: null };
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
  prevRects: new Map(),
  pathCache: new Map(),   // linkId -> {ends, pts, sticky, segs, total}
  bounding: new Float32Array(4),
  settleTimer: null,

  // --- animation state ---
  animActive: false,
  rafId: 0,
  lastFrame: 0,

  // --- hover tracking ---
  mouseClient: null, // {x, y} in client space

  // --- floating bar DOM refs ---
  uiBox: null,   // DOM element
  barRefs: null, // {toggle, linkMode, anim, debug, setActive}

  // --- pure helpers (depend only on M.S) ---

  stubLen() {
    const m =
      this.S.marginMode === "uniform"
        ? +this.S.margin || 16
        : Math.max(+this.S.marginL || 16, +this.S.marginR || 16);
    return m + 6;
  },

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
    this.router = new OrthoRouter({
      margin: this.currentMargin(),
      bendPenalty: +this.S.bendPenalty || 40,
    });
    this.graphSig = "";
    this.prevRects = new Map();
    this.pathCache.clear();
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
