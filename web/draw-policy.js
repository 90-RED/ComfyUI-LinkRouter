export function linkTouchesNode(item, nodeId) {
  const link = item?.entry?.link;
  return !!(
    link &&
    nodeId !== null &&
    nodeId !== undefined &&
    (link.origin_id === nodeId || link.target_id === nodeId)
  );
}

// With a Path2D base batch, only hovered links need an overlay pass. Without
// batching, preserve all unrelated ordering and move only hovered links last.
export function hoverDrawItems(routed, hoverId, baseBatched) {
  if (hoverId === null || hoverId === undefined)
    return baseBatched ? [] : routed;
  const normal = [];
  const hovered = [];
  for (const item of routed) {
    (linkTouchesNode(item, hoverId) ? hovered : normal).push(item);
  }
  return baseBatched ? hovered : normal.concat(hovered);
}
