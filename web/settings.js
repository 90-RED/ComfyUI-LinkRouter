// settings.js — ComfyUI settings registration for LinkRouter.

import { app } from "../../scripts/app.js";
import { M } from "./state.js";

// key -> [settingId, label, type, default, attrs?, options?]
// The id's middle segment renders as a group header, so related options
// share a section.  Sections: General / Routing / Lines / Corners /
// Highlight / Marker Animation.
const SETTINGS = {
  enabled: ["LinkRouter.General.Enabled", "Enable LinkRouter routing", "boolean", true],
  showButton: ["LinkRouter.General.FloatingBar", "Show floating button bar", "boolean", true],

  marginMode: [
    "LinkRouter.Routing.ClearanceMode",
    "Clearance mode",
    "combo",
    "uniform",
    null,
    [
      { value: "uniform", text: "uniform (one value)" },
      { value: "per-side", text: "per side (L/R/T/B)" },
    ],
  ],
  margin: ["LinkRouter.Routing.Clearance", "Clearance (uniform)", "slider", 16, { min: 4, max: 120, step: 1 }],
  marginL: ["LinkRouter.Routing.ClearanceLeft", "Clearance left", "slider", 16, { min: 4, max: 120, step: 1 }],
  marginR: ["LinkRouter.Routing.ClearanceRight", "Clearance right", "slider", 16, { min: 4, max: 120, step: 1 }],
  marginT: ["LinkRouter.Routing.ClearanceTop", "Clearance top", "slider", 16, { min: 4, max: 120, step: 1 }],
  marginB: ["LinkRouter.Routing.ClearanceBottom", "Clearance bottom", "slider", 16, { min: 4, max: 120, step: 1 }],
  bendPenalty: [
    "LinkRouter.Routing.BendPenalty",
    "Bend penalty (higher = straighter routes)",
    "slider",
    40,
    { min: 10, max: 150, step: 5 },
  ],
  stickiness: [
    "LinkRouter.Routing.DragStickiness",
    "Keep link shape while dragging (anti-flicker)",
    "boolean",
    true,
  ],

  lineWidth: ["LinkRouter.Lines.Width", "Line width", "slider", 3, { min: 1, max: 16, step: 0.5 }],
  selectBoost: [
    "LinkRouter.Lines.SelectBoost",
    "Highlighted line width multiplier",
    "slider",
    1.35,
    { min: 1, max: 3, step: 0.05 },
  ],
  outline: ["LinkRouter.Lines.Outline", "Dark outline around lines", "boolean", true],
  outlineWidth: [
    "LinkRouter.Lines.OutlineWidth",
    "Line outline width",
    "slider",
    4,
    { min: 0.5, max: 16, step: 0.5 },
  ],
  outlineAlpha: [
    "LinkRouter.Lines.OutlineOpacity",
    "Line outline opacity",
    "slider",
    0.5,
    { min: 0.05, max: 1, step: 0.05 },
  ],

  cornerMode: [
    "LinkRouter.Line Corners.Mode",
    "Rounded corners",
    "combo",
    "per-line",
    null,
    [
      { value: "per-line", text: "uniform within each line" },
      { value: "per-corner", text: "adapt per corner" },
      { value: "off", text: "off (sharp corners)" },
    ],
  ],
  cornerRadius: ["LinkRouter.Line Corners.Radius", "Corner radius", "slider", 8, { min: 0, max: 24, step: 1 }],

  hoverAnim: ["LinkRouter.Highlight.HoverAnimation", "Flow animation on hovered node's links", "boolean", true],
  selectHighlight: [
    "LinkRouter.Highlight.SelectHighlight",
    "Highlight selected node's links (dim others)",
    "boolean",
    true,
  ],
  selectAnim: ["LinkRouter.Highlight.SelectAnimation", "Flow animation on selected node's links", "boolean", true],
  dimAlpha: [
    "LinkRouter.Highlight.DimOpacity",
    "Unrelated links opacity when dimmed",
    "slider",
    0.06,
    { min: 0, max: 0.6, step: 0.02 },
  ],
  dragDimAlpha: [
    "LinkRouter.Highlight.DragDimOpacity",
    "Unrelated links opacity while dragging (0 = same as dim)",
    "slider",
    0.15,
    { min: 0, max: 0.6, step: 0.02 },
  ],

  flowMode: [
    "LinkRouter.Marker Animation.Mode",
    "Flow markers on highlighted links",
    "combo",
    "animated",
    null,
    [
      { value: "animated", text: "animated (flowing)" },
      { value: "static", text: "static arrows (no motion)" },
      { value: "none", text: "none (line only)" },
    ],
  ],
  animStyle: [
    "LinkRouter.Marker Animation.Style",
    "Marker style",
    "combo",
    "pill",
    null,
    [
      { value: "dots", text: "dots" },
      { value: "pill", text: "pills" },
      { value: "arrow", text: "arrows" },
      { value: "oval", text: "ovals" },
      { value: "dash", text: "dashes" },
    ],
  ],
  animSize: ["LinkRouter.Marker Animation.Size", "Marker size", "slider", 6, { min: 1, max: 14, step: 0.5 }],
  animGap: ["LinkRouter.Marker Animation.Spacing", "Marker spacing", "slider", 72, { min: 10, max: 200, step: 2 }],
  animSpeed: ["LinkRouter.Marker Animation.Speed", "Flow speed", "slider", 60, { min: 10, max: 240, step: 10 }],
  animColorUse: [
    "LinkRouter.Marker Animation.UseCustomColor",
    "Use custom marker color (off = auto darker link color)",
    "boolean",
    true,
  ],
  animColor: [
    "LinkRouter.Marker Animation.Color",
    "Custom marker color",
    "color",
    "#ffffff",
  ],
  animOutline: ["LinkRouter.Marker Animation.MarkerOutline", "Dark outline around markers", "boolean", true],
  animOutlineWidth: [
    "LinkRouter.Marker Animation.MarkerOutlineWidth",
    "Marker outline width",
    "slider",
    4,
    { min: 0.5, max: 16, step: 0.5 },
  ],
  animFPS: ["LinkRouter.Marker Animation.MaxFPS", "Animation max FPS (lower = less CPU)", "slider", 30, { min: 5, max: 60, step: 1 }],
  animDuringRun: [
    "LinkRouter.Marker Animation.WhileRunning",
    "Animation while workflow is running",
    "combo",
    "off",
    null,
    [
      { value: "off", text: "off (pause during run)" },
      { value: "low", text: "low fps (10)" },
      { value: "on", text: "unchanged" },
    ],
  ],
  dragMode: [
    "LinkRouter.Routing.DragBehavior",
    "Link behavior while dragging a node",
    "combo",
    "adaptive",
    null,
    [
      { value: "none", text: "1 — normal (no change)" },
      { value: "freeze-others", text: "2 — freeze others, re-route on collision" },
      { value: "freeze-others-strict", text: "3 — freeze others, skip collision check" },
      { value: "hide-self", text: "4 — freeze others, hide dragged links" },
      { value: "adaptive", text: "5 — adaptive (auto-pick 1-4 by complexity, default)" },
    ],
  ],
  routeBatchPercent: [
    "LinkRouter.Routing.RouteBatchPercent",
    "Gradual reveal: % of links per frame (lower = smoother, higher = faster)",
    "slider",
    10,
    { min: 2, max: 100, step: 1 },
  ],
  showDebugButton: ["LinkRouter.View.ShowDebugButton", "Show Debug button in floating bar", "boolean", false],
};

// Fill S from defaults
for (const key in SETTINGS) M.S[key] = SETTINGS[key][3];

// ------------------------------------------------------------

let _refreshBarFn = null;
export function setRefreshBar(fn) { _refreshBarFn = fn; }

function maybeRefreshBar() {
  if (_refreshBarFn && M.uiBox && M.barRefs) _refreshBarFn();
}

function applySetting(key, v) {
  M.S[key] = v === undefined || v === null ? SETTINGS[key][3] : v;
  // color widgets on some frontends return hex without the leading "#"
  if (key === "animColor" && typeof M.S[key] === "string" && /^[0-9a-f]{3,8}$/i.test(M.S[key]))
    M.S[key] = "#" + M.S[key];
  if (M.ROUTER_KEYS.has(key)) M.resetRouter();
  else app.canvas?.setDirty(true, true);
  if ((key === "showButton" || key === "showDebugButton") && M.uiBox) maybeRefreshBar();
  if (key === "showDebugButton" && !M.S.showDebugButton && M.barState.debug) {
    M.barState.debug = false;
    M.saveBarState();
    app.canvas?.setDirty(true, true);
  }
  if (key === "marginMode") updateClearanceRows();
}

function registerSettings() {
  for (const key in SETTINGS) {
    const [id, name, type, def, attrs, options] = SETTINGS[key];
    const spec = {
      id,
      name,
      type,
      defaultValue: def,
      onChange: (v) => applySetting(key, v),
    };
    if (attrs) spec.attrs = attrs;
    if (options) spec.options = options;
    try {
      app.ui.settings.addSetting(spec);
    } catch (e) {
      console.warn("[LinkRouter] addSetting failed for", id, e);
    }
    let v;
    try {
      v = app.ui.settings.getSettingValue(id, def);
    } catch {
      v = def;
    }
    M.S[key] = v === undefined || v === null ? def : v;
  }

  // "Reset to defaults" button
  try {
    app.ui.settings.addSetting({
      id: "LinkRouter.General.AAResetDefaults",
      name: "Reset all LinkRouter settings to defaults",
      type: () => {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 2;
        const btn = document.createElement("button");
        btn.textContent = "↩ Reset LinkRouter to defaults";
        btn.style.cssText = "padding:4px 12px;cursor:pointer;";
        btn.onclick = () => {
          if (confirm("Reset all LinkRouter settings to defaults?")) resetAllSettings();
        };
        cell.appendChild(btn);
        row.appendChild(cell);
        return row;
      },
      defaultValue: false,
      onChange: (v) => {
        if (v === true) {
          resetAllSettings();
          try {
            app.ui.settings.setSettingValue("LinkRouter.General.AAResetDefaults", false);
          } catch {}
        }
      },
    });
  } catch (e) {
    console.warn("[LinkRouter] reset button setting failed", e);
  }

  M.resetRouter();
}

function resetAllSettings() {
  for (const key in SETTINGS) {
    const [id, , , def] = SETTINGS[key];
    M.S[key] = def;
    try {
      app.ui.settings.setSettingValue(id, def);
    } catch {}
  }
  M.resetRouter();
  maybeRefreshBar();
}

// Best-effort visual cue: dim inactive clearance sliders
function updateClearanceRows() {
  try {
    const uniformOn = M.S.marginMode === "uniform";
    const dim = (labelText, on) => {
      const nodes = document.querySelectorAll("div, td, label, span");
      for (const el of nodes) {
        if (el.childElementCount > 4) continue;
        if (el.textContent?.trim() === labelText) {
          const row = el.closest("tr, .setting-item, .p-card, div[class*='setting']") || el.parentElement;
          if (row) {
            row.style.opacity = on ? "1" : "0.35";
            row.style.pointerEvents = on ? "" : "none";
          }
          break;
        }
      }
    };
    dim("Clearance (uniform)", uniformOn);
    dim("Clearance left", !uniformOn);
    dim("Clearance right", !uniformOn);
    dim("Clearance top", !uniformOn);
    dim("Clearance bottom", !uniformOn);
  } catch {}
}

export { SETTINGS, registerSettings, applySetting, resetAllSettings };
