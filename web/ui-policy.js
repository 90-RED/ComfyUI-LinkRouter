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

// The bar is positioned by its left edge, so a wider second row (drag-mode
// buttons / debug controls) used to grow rightward. Anchor the right edge
// instead: btnX stays the collapsed-basis left edge (measured while every
// extra row is hidden), and opening a wider row shifts the box left so its
// right edge does not move. Clamp at 0 so a wide row near the left screen
// edge cannot push the bar off-screen.
export function barLeftFor(btnX, baseWidth, currentWidth) {
  // min(): never drift right, even if a stale baseWidth exceeds currentWidth.
  return Math.max(0, Math.min(btnX, btnX + baseWidth - currentWidth));
}

// Inverse of barLeftFor for dragging: the pointer tracks the box's actual
// (possibly shifted) left edge, while barState keeps the collapsed-basis
// position so the anchor survives row toggles and reloads.
export function barStoredXFor(rawLeft, baseWidth, currentWidth) {
  return rawLeft + Math.max(0, currentWidth - baseWidth);
}
