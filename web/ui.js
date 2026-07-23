// ui.js — floating button bar, hover tracking, and settings dialog for LinkRouter.

import { app } from "../../scripts/app.js";
import { M } from "./state.js";
import { nodeRect } from "./routing.js";
import { SETTINGS, applySetting } from "./settings.js";
import { profiler } from "./profiler.js";
import {
  adaptiveToggleTarget,
  barLeftFor,
  barStoredXFor,
  FIXED_DRAG_MODES,
  isFixedDragMode,
} from "./ui-policy.js";
import { linkIdAtPoint, slotLinkIdsAt } from "./draw-policy.js";

// ---------------------------------------------------- link mode helpers

const LINK_MODES = [
  { emoji: "🌊", name: "Spline", value: 2 },
  { emoji: "📐", name: "Linear", value: 1 },
  { emoji: "➖", name: "Straight", value: 0 },
];

function getOfficialLinkMode() {
  try {
    const v = app.ui.settings.getSettingValue("Comfy.LinkRenderMode");
    if (v !== undefined && v !== null) return +v;
  } catch {}
  return app.canvas?.links_render_mode ?? 2;
}

function hiddenLinkValue() {
  return typeof LiteGraph !== "undefined" && LiteGraph.HIDDEN_LINK !== undefined
    ? LiteGraph.HIDDEN_LINK
    : 3;
}

export function linksHidden(canvas) {
  const mode = canvas?.links_render_mode ?? getOfficialLinkMode();
  return mode === hiddenLinkValue();
}

function setOfficialLinkMode(v) {
  try {
    app.ui.settings.setSettingValue("Comfy.LinkRenderMode", v);
  } catch {}
  if (app.canvas) app.canvas.links_render_mode = v;
  app.canvas?.setDirty(true, true);
}

// ---------------------------------------------------- drag mode

// ---------------------------------------------------- settings dialog

// Open ComfyUI settings, directly on the LinkRouter panel when possible.
// 1.45.x: the official path is the Comfy.ShowSettingsDialog command
// (useCoreCommands.ts); app.ui.settings.show() only opens an empty legacy
// dialog shell (scripts/ui/settings.ts is a deprecated compat shim), so those
// fallbacks were removed.
function openSettings() {
  try {
    const cmds = app.extensionManager?.command;
    if (cmds?.execute) {
      cmds.execute("Comfy.ShowSettingsDialog");
      setTimeout(() => {
        try {
          const items = document.querySelectorAll(
            ".settings-sidebar li, .p-listbox-option, [role='option'], .p-tree-node-label",
          );
          for (const el of items)
            if (el.textContent?.trim() === "LinkRouter") { el.click(); break; }
        } catch {}
      }, 120);
      return;
    }
  } catch {}
  try {
    const dlg = app.extensionManager?.dialog;
    if (dlg?.showSettingsDialog) {
      dlg.showSettingsDialog({ props: { defaultPanel: "LinkRouter" } });
      return;
    }
  } catch {}
  try {
    (
      document.querySelector("button.comfy-settings-btn") ||
      document.querySelector("[aria-label='Settings']") ||
      document.querySelector(".pi-cog")?.closest("button")
    )?.click();
  } catch {}
}

// ---------------------------------------------------- refresh bar

function isVueNodesEnabled() {
  return typeof LiteGraph !== "undefined" && LiteGraph.vueNodesMode === true;
}

function toggleVueNodes() {
  try {
    const next = !isVueNodesEnabled();
    if (typeof LiteGraph !== "undefined") LiteGraph.vueNodesMode = next;
    app.ui.settings.setSettingValue("Comfy.VueNodes.Enabled", next);
    M.resetRouter();
    app.canvas?.setDirty(true, true);
  } catch {}
}

export function refreshBar() {
  if (!M.uiBox || !M.barRefs) return;
  M.uiBox.style.display = M.S.showButton ? "flex" : "none";
  M.barRefs.setActive(M.barRefs.toggle, M.S.enabled);
  const flowEmoji = { animated: "✨", static: "➤", none: "◾" };
  M.barRefs.anim.textContent = flowEmoji[M.S.flowMode] || "✨";
  M.barRefs.setActive(M.barRefs.anim, M.S.flowMode !== "none");
  M.barRefs.anim.title =
    ["animated", "static", "none"]
      .map((v) => (v === M.S.flowMode ? "✨ " + v + " ◀" : "➤ " + v))
      .join("\n");
  M.barRefs.setActive(M.barRefs.vueToggle, isVueNodesEnabled());
  M.barRefs.vueToggle.title = "Nodes 2.0: " + (isVueNodesEnabled() ? "ON" : "OFF");
  M.barRefs.setActive(M.barRefs.workerBtn, !!M.S.workerRouting && !M._workerFailed);
  M.barRefs.workerBtn.title = M._workerFailed
    ? "Worker routing: unavailable (using main thread)"
    : "Worker routing: " + (M.S.workerRouting ? "ON" : "OFF");
  M.barRefs.setActive(M.barRefs.pauseWorkerBtn, !!M.S.workerHeldPause && !M._workerFailed);
  M.barRefs.pauseWorkerBtn.title = M._workerFailed
    ? "Held-pause worker: unavailable (using main thread)"
    : "Held-pause worker routing: " + (M.S.workerHeldPause ? "ON" : "OFF");
  M.barRefs.setActive(M.barRefs.escalateBtn, M.S.adaptiveEscalation !== false);
  M.barRefs.escalateBtn.title =
    "Adaptive measured-lag escalation: " + (M.S.adaptiveEscalation !== false ? "ON" : "OFF");
  const dragMode = M.S.dragMode || "adaptive";
  const adaptiveOn = dragMode === "adaptive";
  M.barRefs.dragBtn.textContent = "🧠";
  M.barRefs.dragBtn.title = "Adaptive drag mode: " + (adaptiveOn ? "ON" : "OFF");
  M.barRefs.setActive(M.barRefs.dragBtn, adaptiveOn);
  M.barRefs.dragModeRow.style.display = adaptiveOn ? "none" : "flex";
  for (const [value, button] of M.barRefs.dragModeButtons)
    M.barRefs.setActive(button, value === dragMode);
  const debugPanelOpen = M.S.showDebugButton && M.barState.debugPanel;
  M.barRefs.setActive(M.barRefs.debug, debugPanelOpen);
  M.barRefs.debug.style.display = M.S.showDebugButton ? "" : "none";
  M.barRefs.debug.title = debugPanelOpen ? "Close debug controls" : "Open debug controls";
  M.barRefs.debugRow.style.display = debugPanelOpen ? "flex" : "none";
  M.barRefs.setActive(M.barRefs.overlayBtn, M.barState.debug);
  M.barRefs.overlayBtn.title = "Routing debug overlay: " + (M.barState.debug ? "ON" : "OFF");
  M.barRefs.setActive(M.barRefs.flowBtn, M.S.flowMode !== "none");
  M.barRefs.flowBtn.title = "Flow markers: " + (M.S.flowMode !== "none" ? "ON" : "OFF");
  const animThr = +M.S.animAdaptiveThreshold || 10;
  M.barRefs.setActive(M.barRefs.densityBtn, M.S.animAdaptive !== false);
  M.barRefs.densityBtn.title = "Adaptive marker density: " + (M.S.animAdaptive !== false ? "ON" : "OFF") +
    " (>" + animThr + " animated links → half, >" + (animThr * 3) + " → 20%)";
  M.barRefs.setActive(M.barRefs.hoverBtn, M.S.hoverAnim);
  M.barRefs.hoverBtn.title = "Hover animation: " + (M.S.hoverAnim ? "ON" : "OFF");
  M.barRefs.setActive(M.barRefs.selectBtn, M.S.selectAnim);
  M.barRefs.selectBtn.title = "Selection animation: " + (M.S.selectAnim ? "ON" : "OFF");
  M.barRefs.setActive(M.barRefs.outlineBtn, M.S.outline);
  M.barRefs.outlineBtn.title = "Line outline: " + (M.S.outline ? "ON" : "OFF");
  M.barRefs.setActive(M.barRefs.cornerBtn, M.S.cornerMode !== "off");
  M.barRefs.cornerBtn.title = "Rounded corners: " + (M.S.cornerMode !== "off" ? "ON" : "OFF");
  M.barRefs.recordBtn.textContent = profiler.active ? "⏹" : "⏺";
  M.barRefs.setActive(M.barRefs.recordBtn, profiler.active);
  if (profiler.active) M.barRefs.recordBtn.style.background = "#b33";
  const recordSecs = M.barState.recordSeconds || 30;
  M.barRefs.recordBtn.title = profiler.active
    ? "Stop now and save the report to LinkRouter_log"
    : "Record LinkRouter performance for " + recordSecs + "s (auto-saves to LinkRouter_log)";
  // Duration cycler (was the copy button): reports auto-save on every stop.
  M.barRefs.durBtn.textContent = recordSecs + "s";
  M.barRefs.setActive(M.barRefs.durBtn, true);
  M.barRefs.durBtn.title =
    "Profiler duration: " + recordSecs + "s — click to cycle 15 / 30 / 45\n" +
    (profiler.saving
      ? "Saving report…"
      : profiler.lastSaveOk === false
        ? "⚠ Last save FAILED — restart ComfyUI so the backend endpoint loads"
        : profiler.lastSavedFile
          ? "Last saved: LinkRouter_log/" + profiler.lastSavedFile
          : "Reports auto-save to custom_nodes/.disabled/LinkRouter_log");
  const linkCur = getOfficialLinkMode();
  const m = LINK_MODES.find((l) => l.value === linkCur) || LINK_MODES[0];
  M.barRefs.linkMode.textContent = m.emoji;
  M.barRefs.linkMode.title =
    LINK_MODES.map((l) => l.emoji + " " + l.name + (l.value === linkCur ? " ◀" : "")).join("\n");
  // Grow leftward: anchor the collapsed bar's right edge so opening a wider
  // row (drag modes / debug controls) extends the box to the left instead of
  // pushing its right edge across the canvas. baseW is re-measured whenever
  // every extra row is hidden; btnX stays the collapsed-basis left edge
  // (adopt the build-time position once if it was never stored).
  const box = M.uiBox;
  const rowsHidden =
    M.barRefs.dragModeRow.style.display === "none" &&
    M.barRefs.debugRow.style.display === "none";
  if (M.barState.btnX == null && box.offsetWidth > 0)
    M.barState.btnX = parseFloat(box.style.left) || 0;
  if (rowsHidden) {
    if (box.offsetWidth > 0) M._barBaseW = box.offsetWidth;
    if (M.barState.btnX != null) box.style.left = M.barState.btnX + "px";
  } else {
    const baseW = M._barBaseW || box.offsetWidth;
    box.style.left = barLeftFor(M.barState.btnX ?? 0, baseW, box.offsetWidth) + "px";
  }
}

// ---------------------------------------------------- build UI

export function buildUI() {
  const box = (M.uiBox = document.createElement("div"));
  box.style.cssText =
    "position:fixed;z-index:9999;display:flex;flex-direction:column;gap:6px;align-items:stretch;" +
    "background:rgba(30,30,30,.88);border:1px solid #555;border-radius:10px;" +
    "padding:6px 8px;user-select:none;";
  const defX = Math.max(8, Math.round(innerWidth * 0.5 - 100));
  const defY = Math.max(8, Math.round(innerHeight * 0.35));
  box.style.left = (M.barState.btnX ?? defX) + "px";
  box.style.top = (M.barState.btnY ?? defY) + "px";

  const mkBtn = (emoji, title) => {
    const b = document.createElement("button");
    b.textContent = emoji;
    b.title = title;
    b.style.cssText =
      "border:1px solid #666;border-radius:8px;background:#333;color:#eee;" +
      "font-size:20px;line-height:1;padding:8px 10px;cursor:pointer;" +
      "transition:transform .08s ease, background .12s ease, box-shadow .12s ease;";
    b.addEventListener("pointerenter", () => {
      b.style.transform = "scale(1.12)";
      b.style.boxShadow = "0 0 6px rgba(120,220,160,.5)";
    });
    b.addEventListener("pointerleave", () => {
      b.style.transform = "scale(1)";
      b.style.boxShadow = "none";
    });
    b.addEventListener("pointerdown", () => (b.style.transform = "scale(0.88)"));
    b.addEventListener("pointerup", () => (b.style.transform = "scale(1.12)"));
    return b;
  };
  const setActive = (b, on) => {
    b.style.background = on ? "#2a6" : "#333";
  };

  // Rows right-align their buttons (justify-content:flex-end): when a wider
  // row opens and the box grows leftward (barLeftFor), the top row's buttons
  // stay pinned to the anchored right edge instead of travelling left.
  const mainRow = document.createElement("div");
  mainRow.style.cssText = "display:flex;gap:6px;align-items:center;justify-content:flex-end;";
  const dragModeRow = document.createElement("div");
  dragModeRow.style.cssText =
    "display:none;gap:6px;align-items:center;justify-content:flex-end;padding-top:6px;border-top:1px solid #555;";
  const debugRow = document.createElement("div");
  debugRow.style.cssText =
    "display:none;gap:6px;align-items:center;justify-content:flex-end;padding-top:6px;border-top:1px solid #555;";

  const setPluginSetting = (key, value) => {
    applySetting(key, value);
    try { app.ui.settings.setSettingValue(SETTINGS[key][0], value); } catch {}
    refreshBar();
  };

  const toggle     = mkBtn("🔀", "Route on/off");
  const linkMode   = mkBtn("🌊", "Link style");
  const anim       = mkBtn("✨", "Flow markers");
  const dragBtn    = mkBtn("🧠", "Drag mode");
  const dragModeButtons = new Map();
  for (const mode of FIXED_DRAG_MODES) {
    const button = mkBtn(mode.emoji, mode.name);
    button.style.fontSize = "17px";
    button.style.padding = "7px 9px";
    button.onclick = () => {
      M.barState.lastManualDragMode = mode.value;
      M.saveBarState();
      setPluginSetting("dragMode", mode.value);
    };
    dragModeButtons.set(mode.value, button);
    dragModeRow.append(button);
  }
  const settingsBtn = mkBtn("⚙️", "Settings");
  const debug      = mkBtn("🐞", "Open debug controls");
  const closeBtn   = mkBtn("✖", "Hide bar");
  const handle     = mkBtn("✥", "Move bar");
  const overlayBtn = mkBtn("🟥", "Routing debug overlay");
  const flowBtn    = mkBtn("✨", "Flow markers on/off");
  const densityBtn = mkBtn("🎚️", "Adaptive marker density on/off");
  const hoverBtn   = mkBtn("🖱️", "Hover animation on/off");
  const selectBtn  = mkBtn("🎯", "Selection animation on/off");
  const outlineBtn = mkBtn("◉", "Line outline on/off");
  const cornerBtn  = mkBtn("◜", "Rounded corners on/off");
  const vueToggle  = mkBtn("2️⃣", "Nodes 2.0 on/off");
  const workerBtn  = mkBtn("🧵", "Background worker routing on/off");
  const pauseWorkerBtn = mkBtn("✋", "Held-pause worker routing on/off");
  const escalateBtn = mkBtn("📈", "Adaptive measured-lag escalation on/off");
  const recordBtn  = mkBtn("⏺", "Record performance");
  const durBtn     = mkBtn((M.barState.recordSeconds || 30) + "s", "Profiler duration: click to cycle 15 / 30 / 45 seconds");
  for (const b of [overlayBtn, flowBtn, densityBtn, hoverBtn, selectBtn, outlineBtn, cornerBtn, vueToggle, workerBtn, pauseWorkerBtn, escalateBtn, recordBtn, durBtn]) {
    b.style.fontSize = "16px";
    b.style.padding = "7px 9px";
  }
  handle.style.cursor = "grab";
  handle.style.background = "transparent";
  handle.style.border = "none";

  toggle.onclick = () => {
    applySetting("enabled", !M.S.enabled);
    try { app.ui.settings.setSettingValue(SETTINGS.enabled[0], M.S.enabled); } catch {}
    refreshBar();
  };
  linkMode.onclick = () => {
    const cur = getOfficialLinkMode();
    const idx = LINK_MODES.findIndex((m) => m.value === cur);
    const next = LINK_MODES[(idx + 1) % LINK_MODES.length];
    setOfficialLinkMode(next.value);
    refreshBar();
  };
  anim.onclick = () => {
    const order = ["animated", "static", "none"];
    const next = order[(order.indexOf(M.S.flowMode) + 1) % order.length];
    applySetting("flowMode", next);
    try { app.ui.settings.setSettingValue(SETTINGS.flowMode[0], next); } catch {}
    refreshBar();
  };
  closeBtn.onclick = () => {
    applySetting("showButton", false);
    try { app.ui.settings.setSettingValue(SETTINGS.showButton[0], false); } catch {}
  };
  settingsBtn.onclick = () => {
    openSettings();
  };
  debug.onclick = () => {
    M.barState.debugPanel = !M.barState.debugPanel;
    M.saveBarState();
    refreshBar();
  };
  overlayBtn.onclick = () => {
    M.barState.debug = !M.barState.debug;
    M.saveBarState();
    refreshBar();
    app.canvas?.setDirty(true, true);
  };
  flowBtn.onclick = () => {
    if (M.S.flowMode === "none") {
      setPluginSetting("flowMode", M.barState.lastFlowMode || "animated");
    } else {
      M.barState.lastFlowMode = M.S.flowMode;
      M.saveBarState();
      setPluginSetting("flowMode", "none");
    }
  };
  densityBtn.onclick = () => setPluginSetting("animAdaptive", M.S.animAdaptive === false);
  hoverBtn.onclick = () => setPluginSetting("hoverAnim", !M.S.hoverAnim);
  selectBtn.onclick = () => setPluginSetting("selectAnim", !M.S.selectAnim);
  outlineBtn.onclick = () => setPluginSetting("outline", !M.S.outline);
  cornerBtn.onclick = () => {
    if (M.S.cornerMode === "off") {
      setPluginSetting("cornerMode", M.barState.lastCornerMode || "per-line");
    } else {
      M.barState.lastCornerMode = M.S.cornerMode;
      M.saveBarState();
      setPluginSetting("cornerMode", "off");
    }
  };
  vueToggle.onclick = () => {
    toggleVueNodes();
    refreshBar();
  };
  workerBtn.onclick = () => setPluginSetting("workerRouting", !M.S.workerRouting);
  pauseWorkerBtn.onclick = () => setPluginSetting("workerHeldPause", !M.S.workerHeldPause);
  escalateBtn.onclick = () => setPluginSetting("adaptiveEscalation", M.S.adaptiveEscalation === false);
  recordBtn.onclick = () => {
    if (profiler.active) profiler.stop("manual");
    else profiler.start((M.barState.recordSeconds || 30) * 1000);
    refreshBar();
  };
  durBtn.onclick = () => {
    const order = [15, 30, 45];
    const cur = M.barState.recordSeconds || 30;
    M.barState.recordSeconds = order[(order.indexOf(cur) + 1) % order.length];
    M.saveBarState();
    refreshBar();
  };
  dragBtn.onclick = () => {
    const current = M.S.dragMode || "adaptive";
    if (isFixedDragMode(current)) {
      M.barState.lastManualDragMode = current;
      M.saveBarState();
    }
    setPluginSetting(
      "dragMode",
      adaptiveToggleTarget(current, M.barState.lastManualDragMode),
    );
  };

  mainRow.append(toggle, linkMode, anim, dragBtn, settingsBtn, debug, closeBtn, handle);
  debugRow.append(overlayBtn, flowBtn, densityBtn, hoverBtn, selectBtn, outlineBtn, cornerBtn, vueToggle, workerBtn, pauseWorkerBtn, escalateBtn, recordBtn, durBtn);
  box.append(mainRow, dragModeRow, debugRow);
  M.barRefs = {
    toggle, linkMode, anim, vueToggle, workerBtn, pauseWorkerBtn, escalateBtn, dragBtn, dragModeRow, dragModeButtons, debug, debugRow,
    overlayBtn, flowBtn, densityBtn, hoverBtn, selectBtn, outlineBtn, cornerBtn,
    recordBtn, durBtn, setActive,
  };
  profiler.onChange = refreshBar;

  let drag = null;
  handle.addEventListener("pointerdown", (ev) => {
    drag = { dx: ev.clientX - box.offsetLeft, dy: ev.clientY - box.offsetTop };
    handle.setPointerCapture(ev.pointerId);
    handle.style.cursor = "grabbing";
    ev.preventDefault();
  });
  handle.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const rawX = Math.max(0, Math.min(innerWidth - 60, ev.clientX - drag.dx));
    const rawY = Math.max(0, Math.min(innerHeight - 30, ev.clientY - drag.dy));
    // The box tracks the pointer directly; barState stores the collapsed-
    // basis position so the left-growth anchor in refreshBar keeps holding.
    M.barState.btnX = barStoredXFor(rawX, M._barBaseW || box.offsetWidth, box.offsetWidth);
    M.barState.btnY = rawY;
    box.style.left = rawX + "px";
    box.style.top = rawY + "px";
  });
  handle.addEventListener("pointerup", (ev) => {
    if (!drag) return;
    drag = null;
    handle.style.cursor = "grab";
    handle.releasePointerCapture(ev.pointerId);
    M.saveBarState();
  });

  document.body.appendChild(box);
  // Measure the collapsed base width BEFORE the first refreshBar() can open
  // an extra row (debugPanel may be persisted open): both rows are still
  // display:none here, so offsetWidth is exactly the collapsed width. Without
  // this, a first load with the debug panel open measures nothing and the
  // bar does not grow leftward until every row is closed once.
  if (box.offsetWidth > 0) M._barBaseW = box.offsetWidth;
  refreshBar();
}

// ---------------------------------------------------- hover tracking

// Graph-space pointer position, or null when the pointer is outside the
// canvas element.
function pointerGraphPos(canvas) {
  if (!M.mouseClient || !canvas?.ds) return null;
  const el = canvas.canvas;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (
    M.mouseClient.x < rect.left ||
    M.mouseClient.x > rect.right ||
    M.mouseClient.y < rect.top ||
    M.mouseClient.y > rect.bottom
  )
    return null;
  const scale = canvas.ds.scale || 1;
  return {
    gx: (M.mouseClient.x - rect.left) / scale - canvas.ds.offset[0],
    gy: (M.mouseClient.y - rect.top) / scale - canvas.ds.offset[1],
    scale,
  };
}

function nodeAtPoint(canvas, p) {
  const nodes = canvas.graph?._nodes || [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const r = nodeRect(nodes[i]);
    if (p.gx >= r.x && p.gx <= r.x + r.w && p.gy >= r.y && p.gy <= r.y + r.h)
      return nodes[i];
  }
  return null;
}

// Slot-label hover: pointer over an input/output name or dot on the node
// under the cursor. Returns an array of connected link ids, or null when no
// linked slot is under the pointer (callers then fall back to link/node
// hover).
function hoverSlotLinkIdsAt(canvas) {
  const p = pointerGraphPos(canvas);
  if (!p) return null;
  const node = canvas.node_over || nodeAtPoint(canvas, p);
  if (!node) return null;
  return slotLinkIdsAt(node, p.gx, p.gy);
}

// Single-link hover: pointer directly over a link's drawn path. Tolerance is
// screen-relative (~9px) converted to graph units, min 3. Uses the routed set
// from the last drawn frame (M.routeResults) — exactly what is on screen.
function hoverLinkIdAt(canvas) {
  const p = pointerGraphPos(canvas);
  if (!p) return null;
  const tol = Math.max(3, 9 / p.scale);
  return linkIdAtPoint(M.routeResults || [], p.gx, p.gy, tol);
}

// Track pointer at document level (works above DOM widget overlays like
// text areas) and repaint when the hovered node changes.
export function watchHover() {
  let lastHover = null;
  let lastHoverLink = null;
  let lastHoverSlotKey = null;
  document.addEventListener(
    "pointermove",
    (ev) => {
      M.mouseClient = { x: ev.clientX, y: ev.clientY };
      if (!M.S.enabled || !M.S.hoverAnim) return;
      const canvas = app.canvas;
      if (!canvas) return;
      // Slot-label hover takes priority over link hover and node hover:
      // pointing at an input/output name or dot animates/thickens only that
      // slot's links. Skipped during a node drag, like link hover.
      const slotIds = M._nodeDragActive ? null : hoverSlotLinkIdsAt(canvas);
      const slotKey = slotIds ? slotIds.join(",") : null;
      if (slotKey !== lastHoverSlotKey) {
        lastHoverSlotKey = slotKey;
        M._hoverSlotLinkIds = slotIds ? new Set(slotIds) : null;
        canvas.setDirty(true, true);
      }
      // Single-link hover: pointing directly at a link animates/thickens just
      // that link. Suppressed while a slot hover is active.
      const curLink = slotIds || M._nodeDragActive ? null : hoverLinkIdAt(canvas);
      if (curLink !== lastHoverLink) {
        lastHoverLink = curLink;
        M._hoverLinkId = curLink;
        canvas.setDirty(true, true);
      }
      const cur = slotIds || curLink !== null ? null : drawHoverNodeId(canvas);
      if (cur !== lastHover) {
        lastHover = cur;
        canvas.setDirty(true, true);
      }
    },
    { passive: true },
  );
}

// Duplicated from draw.js hoverNodeId to avoid circular draw→ui import.
// (ui exports watchHover which is called from smart-edge.js setup, and
// draw.js also needs hoverNodeId for drawAll.  Keeping the detection
// logic here and using it in both places would require draw→ui which
// we don't want.  The ~20-line function is small enough to duplicate.)
function drawHoverNodeId(canvas) {
  if (canvas.node_over) return canvas.node_over.id;
  const p = pointerGraphPos(canvas);
  if (!p) return null;
  return nodeAtPoint(canvas, p)?.id ?? null;
}
