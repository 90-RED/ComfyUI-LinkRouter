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
    const proto = LGraphCanvas.prototype;
    const original = proto.drawConnections;
    proto.drawConnections = function (ctx) {
      if (linksHidden(this)) return; // official "hide links" wins
      if (!M.S.enabled) return original.call(this, ctx);
      if (drawAll(this, ctx) === false) return original.call(this, ctx);
    };
  },
});
