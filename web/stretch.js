// stretch.js — endpoint-following "sticky" path stretch, shared by the main
// thread (drag/sync routing, fresh M.router) and the router worker (its own
// fresh OrthoRouter instance). Pure aside from the passed-in router.

import { stretchedPathCrossesUnexpectedNode } from "./router.js";

// Try to keep a previously routed path on screen by re-attaching its ends to
// the current endpoints. Returns null when the stretch would leave the
// orthogonal family or cross an unexpected node body — callers must then fall
// back to a full search (or draw nothing).
export function stretchPathPure(router, oldPts, ep) {
  if (!oldPts || oldPts.length < 4) return null;
  const pts = oldPts.map((p) => ({ x: p.x, y: p.y }));
  const oldN = pts.length;
  pts[0] = ep.out;
  pts[1] = { x: ep.stubOut.x, y: ep.stubOut.y };
  pts[oldN - 1] = ep.inp;
  pts[oldN - 2] = { x: ep.stubIn.x, y: ep.stubIn.y };

  // A formerly straight four-point connector becomes diagonal when one end
  // moves vertically.  Insert a temporary centre dogleg so it can remain
  // sticky instead of invoking A* on every drag frame.
  if (
    oldN === 4 &&
    Math.abs(pts[1].x - pts[2].x) > 0.6 &&
    Math.abs(pts[1].y - pts[2].y) > 0.6
  ) {
    const mx = (pts[1].x + pts[2].x) / 2;
    pts.splice(2, 0, { x: mx, y: pts[1].y }, { x: mx, y: pts[2].y });
  } else if (oldN >= 5) {
    const n = pts.length;
    const a = pts[1], b = pts[2];
    if (Math.abs(oldPts[1].y - oldPts[2].y) < 0.6) b.y = a.y;
    else b.x = a.x;
    const y = pts[n - 2], z = pts[n - 3];
    if (Math.abs(oldPts[n - 2].y - oldPts[n - 3].y) < 0.6) z.y = y.y;
    else z.x = y.x;
  }
  for (let k = 0; k < pts.length - 1; k++) {
    if (Math.abs(pts[k].x - pts[k + 1].x) > 0.6 && Math.abs(pts[k].y - pts[k + 1].y) > 0.6)
      return null;
  }
  const raw = router.raw || [];
  const sourceIndex = router._endpointRectIndex(ep.bodyOut, ep.stubOut, true);
  const targetIndex = router._endpointRectIndex(ep.bodyIn, ep.stubIn, false);
  if (stretchedPathCrossesUnexpectedNode(pts, raw, sourceIndex, targetIndex)) return null;
  return pts;
}
