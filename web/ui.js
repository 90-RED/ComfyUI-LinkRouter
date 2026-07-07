// ui.js — floating button bar, hover tracking, and settings dialog for LinkRouter.

import { app } from "../../scripts/app.js";
import { M } from "./state.js";
import { nodeRect } from "./routing.js";
import { SETTINGS, applySetting } from "./settings.js";

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

const DRAG_MODES = [
  { emoji: "🔓", name: "Normal",       value: "none" },
  { emoji: "🧊", name: "Freeze+Check", value: "freeze-others" },
  { emoji: "🥶", name: "Freeze",       value: "freeze-others-strict" },
  { emoji: "👻", name: "Hide",         value: "hide-self" },
  { emoji: "🧠", name: "Adaptive",     value: "adaptive" },
];

function cycleDragMode() {
  const cur = M.S.dragMode || "adaptive";
  const idx = DRAG_MODES.findIndex((m) => m.value === cur);
  const next = DRAG_MODES[(idx + 1) % DRAG_MODES.length];
  applySetting("dragMode", next.value);
  try { app.ui.settings.setSettingValue(SETTINGS.dragMode[0], next.value); } catch {}
  refreshBar();
}

// ---------------------------------------------------- settings dialog

// Open ComfyUI settings, directly on the LinkRouter panel when possible.
function openSettings() {
  try {
    const dlg = app.extensionManager?.dialog;
    if (dlg?.showSettingsDialog) {
      dlg.showSettingsDialog({ props: { defaultPanel: "LinkRouter" } });
      return;
    }
  } catch {}
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
    if (app.ui?.settings?.show) { app.ui.settings.show(); return; }
  } catch {}
  try {
    if (app.ui?.settings?.element) {
      app.ui.settings.element.style.display = "block";
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
  M.barRefs.vueToggle.title = "2️⃣ Nodes 2.0: " + (isVueNodesEnabled() ? "ON" : "OFF");
  M.barRefs.vueToggle.style.display = M.S.showDebugButton ? "" : "none";
  const dragMode = M.S.dragMode || "adaptive";
  const dragInfo = DRAG_MODES.find((m) => m.value === dragMode) || DRAG_MODES[4];
  M.barRefs.dragBtn.textContent = dragInfo.emoji;
  M.barRefs.dragBtn.title =
    DRAG_MODES.map((d) => d.emoji + " " + d.name + (d.value === dragMode ? " ◀" : "")).join("\n");
  M.barRefs.setActive(M.barRefs.debug, M.barState.debug);
  M.barRefs.debug.style.display = M.S.showDebugButton ? "" : "none";
  const linkCur = getOfficialLinkMode();
  const m = LINK_MODES.find((l) => l.value === linkCur) || LINK_MODES[0];
  M.barRefs.linkMode.textContent = m.emoji;
  M.barRefs.linkMode.title =
    LINK_MODES.map((l) => l.emoji + " " + l.name + (l.value === linkCur ? " ◀" : "")).join("\n");
}

// ---------------------------------------------------- build UI

export function buildUI() {
  const box = (M.uiBox = document.createElement("div"));
  box.style.cssText =
    "position:fixed;z-index:9999;display:flex;gap:6px;align-items:center;" +
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

  const toggle     = mkBtn("🔀", "Route on/off");
  const linkMode   = mkBtn("🌊", "Link style");
  const anim       = mkBtn("✨", "Flow markers");
  const dragBtn    = mkBtn("🧠", "Drag mode");
  const settingsBtn = mkBtn("⚙️", "Settings");
  const vueToggle  = mkBtn("2️⃣", "Nodes 2.0 on/off");
  const debug      = mkBtn("🐞", "Debug overlay");
  const closeBtn   = mkBtn("✖", "Hide bar");
  const handle     = mkBtn("✥", "Move bar");
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
    M.barState.debug = !M.barState.debug;
    M.saveBarState();
    refreshBar();
    app.canvas?.setDirty(true, true);
  };
  vueToggle.onclick = () => {
    toggleVueNodes();
    refreshBar();
  };
  dragBtn.onclick = () => cycleDragMode();

  box.append(toggle, linkMode, anim, dragBtn, settingsBtn, vueToggle, debug, closeBtn, handle);
  M.barRefs = { toggle, linkMode, anim, vueToggle, dragBtn, debug, setActive };

  let drag = null;
  handle.addEventListener("pointerdown", (ev) => {
    drag = { dx: ev.clientX - box.offsetLeft, dy: ev.clientY - box.offsetTop };
    handle.setPointerCapture(ev.pointerId);
    handle.style.cursor = "grabbing";
    ev.preventDefault();
  });
  handle.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    M.barState.btnX = Math.max(0, Math.min(innerWidth - 60, ev.clientX - drag.dx));
    M.barState.btnY = Math.max(0, Math.min(innerHeight - 30, ev.clientY - drag.dy));
    box.style.left = M.barState.btnX + "px";
    box.style.top = M.barState.btnY + "px";
  });
  handle.addEventListener("pointerup", (ev) => {
    if (!drag) return;
    drag = null;
    handle.style.cursor = "grab";
    handle.releasePointerCapture(ev.pointerId);
    M.saveBarState();
  });

  document.body.appendChild(box);
  refreshBar();
}

// ---------------------------------------------------- hover tracking

// Track pointer at document level (works above DOM widget overlays like
// text areas) and repaint when the hovered node changes.
export function watchHover() {
  let lastHover = null;
  document.addEventListener(
    "pointermove",
    (ev) => {
      M.mouseClient = { x: ev.clientX, y: ev.clientY };
      if (!M.S.enabled || !M.S.hoverAnim) return;
      const canvas = app.canvas;
      if (!canvas) return;
      const cur = drawHoverNodeId(canvas);
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
  const gx = (M.mouseClient.x - rect.left) / scale - canvas.ds.offset[0];
  const gy = (M.mouseClient.y - rect.top) / scale - canvas.ds.offset[1];
  const nodes = canvas.graph?._nodes || [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const r = nodeRect(nodes[i]);
    if (gx >= r.x && gx <= r.x + r.w && gy >= r.y && gy <= r.y + r.h)
      return nodes[i].id;
  }
  return null;
}
