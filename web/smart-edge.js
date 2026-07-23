// ComfyUI-LinkRouter — object-avoiding orthogonal link routing.
//
// Links are routed with an Orthogonal Visibility Graph + A* search
// (Wybrow et al., GD'09 — the libavoid algorithm).
//
// All options live in ComfyUI Settings under the LinkRouter category.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

import { M } from "./state.js";
import { registerSettings, setRefreshBar } from "./settings.js";
import { drawAll } from "./draw.js";
import { buildUI, refreshBar, watchHover, linksHidden } from "./ui.js";
import { cancelDragPauseWorker } from "./routing.js";

// Wire the refresh-bar callback (settings.js => ui.js without circular import)
setRefreshBar(refreshBar);

// --- execution-state watcher ---

function watchExecution() {
  try {
    api.addEventListener("execution_start", () => { M.running = true; });
    const done = () => { M.running = false; };
    api.addEventListener("execution_success", done);
    api.addEventListener("execution_error", done);
    api.addEventListener("execution_interrupted", done);
    api.addEventListener("status", (ev) => {
      const q = ev?.detail?.exec_info?.queue_remaining;
      if (q === 0) M.running = false;
    });
  } catch (e) {
    console.warn("[LinkRouter] execution watch unavailable", e);
  }
}

// --- hook into ComfyUI ---

app.registerExtension({
  name: "LinkRouter",
  setup() {
    registerSettings();
    buildUI();
    watchHover();
    watchExecution();
    // Capture-phase tracking still sees gestures captured by Nodes 2.0.
    const beginPointer = () => {
      // A new gesture orphans the previous gesture's in-flight pause batch:
      // its late results would pass the jobRev check into the new reveal
      // queue, and a stale _dragPauseWorker would block the next dispatch.
      cancelDragPauseWorker();
      M._pointerDown = true;
      M._nodeDragActive = false;
      M._dragAdaptiveMode = null;
      M._dragHeavyActive = null;
      M._dragLastFastSig = M.routeFastSig || "";
      M._dragHiddenLinkIds.clear();
      M._dragAffectedLinkIds.clear();
      M._dragPauseActive = false;
      M._dragPausePending = false;
      M._dragPauseQueue = null;
      M._dragPauseCleanupLinkIds.clear();
      M._dragPauseAttemptedLinkIds.clear();
      M._dragPauseCompletedLinkIds.clear();
      M._dragPauseRevealQueue.length = 0;
      M._dragInterruptedBatch = false;
    };
    const releasePointer = () => { M._pointerDown = false; };
    window.addEventListener("pointerdown", beginPointer, true);
    window.addEventListener("pointermove", (ev) => {
      // Pointer capture can occasionally hide the original down event from an
      // extension, but the held-button state remains reliable.
      if (ev.buttons & 1) M._pointerDown = true;
    }, true);
    window.addEventListener("pointerup", releasePointer, true);
    window.addEventListener("pointercancel", releasePointer, true);
    window.addEventListener("blur", releasePointer);
    const proto = LGraphCanvas.prototype;
    const original = proto.drawConnections;
    proto.drawConnections = function (ctx) {
      // Mirror the native contract even on early exits: a frame that draws
      // no links must leave an empty hit-test set (LGraphCanvas.ts:5977).
      if (linksHidden(this)) {
        this.renderedPaths?.clear?.();
        return; // official "hide links" wins
      }
      if (!M.S.enabled) return original.call(this, ctx);
      if (drawAll(this, ctx) === false) return original.call(this, ctx);
    };
  },
});
