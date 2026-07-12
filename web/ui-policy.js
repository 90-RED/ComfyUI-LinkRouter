export const FIXED_DRAG_MODES = [
  { emoji: "🔓", name: "Normal", value: "none" },
  { emoji: "🧊", name: "Freeze+Check", value: "freeze-others" },
  { emoji: "🥶", name: "Freeze", value: "freeze-others-strict" },
  { emoji: "👻", name: "Hide", value: "hide-self" },
  { emoji: "🐘", name: "Heavy Deferred", value: "heavy-deferred" },
];

export function isFixedDragMode(value) {
  return FIXED_DRAG_MODES.some((mode) => mode.value === value);
}

export function adaptiveToggleTarget(currentMode, lastManualMode) {
  if (currentMode !== "adaptive") return "adaptive";
  return isFixedDragMode(lastManualMode) ? lastManualMode : "freeze-others";
}
