// router.js — Orthogonal Visibility Graph + A* connector routing.
//
// Implementation of: Wybrow, Marriott, Stuckey — "Orthogonal Connector
// Routing" (Graph Drawing 2009). Same algorithm family as libavoid
// (used by Inkscape / JointJS).
//
// Key ideas:
//  * NO uniform pixel grid. The search graph is built only from the
//    "interesting" horizontal/vertical lines: the edges of every
//    (margin-inflated) obstacle rectangle plus every connector terminal.
//    Graph size depends on node count, not canvas size.
//  * A* over (point, entry-direction) states. Cost = path length +
//    bendPenalty * bends, with the paper's admissible bend estimator,
//    so routes are short AND have few corners.
//  * Overlapping obstacles need no merging — blocked-interval tests
//    handle them natively (merging would destroy alleys between nodes).
//
// Pure geometry, no ComfyUI / DOM dependencies — unit-testable in Node.

export const DIR = { E: 0, S: 1, W: 2, N: 3 };
const rev = (d) => (d + 2) & 3;

const EPS = 0.6; // coordinate matching tolerance (px, graph space)

// ---------------------------------------------------------------- utils

function dedupeSorted(values) {
  values.sort((a, b) => a - b);
  const out = [];
  for (const v of values) {
    if (!out.length || v - out[out.length - 1] > 0.5) out.push(v);
  }
  return out;
}

function idxOf(arr, v) {
  let lo = 0,
    hi = arr.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] < v - EPS) lo = m + 1;
    else if (arr[m] > v + EPS) hi = m - 1;
    else return m;
  }
  return -1;
}

// Directions from v toward goal, as a bitmask of DIR bits.
function dirnsMask(vx, vy, gx, gy) {
  let m = 0;
  if (gx > vx + EPS) m |= 1 << DIR.E;
  if (gx < vx - EPS) m |= 1 << DIR.W;
  if (gy > vy + EPS) m |= 1 << DIR.S;
  if (gy < vy - EPS) m |= 1 << DIR.N;
  return m;
}

// Minimal remaining bends to reach goal arriving with direction gd,
// given we are at (vx,vy) currently travelling in direction d.
// Table from Wybrow et al. GD'09, Section 4 / Figure 2(a).
function estBends(d, vx, vy, gx, gy, gd) {
  const m = dirnsMask(vx, vy, gx, gy);
  const bd = 1 << d;
  if (m === 0) return d === gd ? 0 : d === rev(gd) ? 2 : 1;
  if (d === gd) {
    if (m === bd) return 0;
    return m & bd ? 2 : 4;
  }
  if (d === rev(gd)) return m === bd ? 4 : 2;
  return m & bd ? 1 : 3; // perpendicular to goal direction
}

// Simple binary min-heap on entry.f
class Heap {
  constructor() {
    this.a = [];
  }
  get size() {
    return this.a.length;
  }
  push(e) {
    const a = this.a;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1,
          r = l + 1;
        let s = i;
        if (l < a.length && a[l].f < a[s].f) s = l;
        if (r < a.length && a[r].f < a[s].f) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]];
        i = s;
      }
    }
    return top;
  }
}

// ---------------------------------------------------------------- router

export class OrthoRouter {
  constructor({ margin = 18, bendPenalty = 40 } = {}) {
    this.margin = margin; // number, or {l, r, t, b}
    this.bendPenalty = bendPenalty;
    this.rects = []; // inflated obstacles {x, y, x2, y2}
    this.raw = []; // un-inflated obstacles {x, y, x2, y2}
    this.xs = [];
    this.ys = [];
    // Edge tiers instead of binary passability (soft-cost routing):
    //   0 = free, 1 = inside a margin zone, 2 = inside a node body.
    // Tier-1/2 edges are walkable but expensive, so terminals that sit
    // inside a neighbour's margin zone route out naturally, and links
    // only ever cross a node body when nodes genuinely overlap.
    this.hEdge = null; // Uint8Array ny*(nx-1)
    this.vEdge = null; // Uint8Array nx*(ny-1)
    this.nx = 0;
    this.ny = 0;
    this.overlapCache = new Map();
  }

  // Extra cost multiplier per tier (applied to segment length).
  static TIER_MULT = [0, 2, 30];

  // rawRects: [{x, y, w, h}] node bounding boxes (title bar included).
  // terminals: [{x, y}] connector stub points; their coordinates are
  // added to the interesting-line sets so every route endpoint is a
  // graph vertex.
  build(rawRects, terminals = []) {
    const m = this.margin;
    const mg =
      typeof m === "number" ? { l: m, r: m, t: m, b: m } : m;
    this.raw = rawRects.map((r) => ({ x: r.x, y: r.y, x2: r.x + r.w, y2: r.y + r.h }));
    this.rects = rawRects.map((r) => ({
      x: r.x - mg.l,
      y: r.y - mg.t,
      x2: r.x + r.w + mg.r,
      y2: r.y + r.h + mg.b,
    }));
    this.overlapCache.clear();

    const xs = [],
      ys = [];
    for (const r of this.rects) {
      xs.push(r.x, r.x2);
      ys.push(r.y, r.y2);
    }
    for (const t of terminals) {
      xs.push(t.x);
      ys.push(t.y);
    }
    this.xs = dedupeSorted(xs);
    this.ys = dedupeSorted(ys);
    const nx = (this.nx = this.xs.length);
    const ny = (this.ny = this.ys.length);
    // degenerate axes (e.g. two collinear terminals, no obstacles) are
    // fine: the corresponding edge array is just empty.
    const hEdge = (this.hEdge = new Uint8Array(Math.max(0, ny * (nx - 1))));
    const vEdge = (this.vEdge = new Uint8Array(Math.max(0, nx * (ny - 1))));

    // Tier of an edge = worst tier touched by its full open segment.
    // Midpoint-only sampling can miss a short partial crossing of a body.
    // Obstacle edges themselves remain legal routing lanes.
    for (let j = 0; j < ny; j++) {
      const y = this.ys[j];
      const row = j * (nx - 1);
      const active = [];
      for (let k = 0; k < this.rects.length; k++) {
        const r = this.rects[k];
        if (y > r.y + EPS && y < r.y2 - EPS) active.push(k);
      }
      for (let i = 0; i < nx - 1; i++) {
        const x1 = this.xs[i],
          x2 = this.xs[i + 1];
        let tier = 0;
        for (const k of active) {
          const inf = this.rects[k];
          if (x2 <= inf.x + EPS || x1 >= inf.x2 - EPS) continue;
          const raw = this.raw[k];
          if (
            y > raw.y + EPS &&
            y < raw.y2 - EPS &&
            x2 > raw.x + EPS &&
            x1 < raw.x2 - EPS
          ) {
            tier = 2;
            break;
          }
          tier = 1;
        }
        hEdge[row + i] = tier;
      }
    }
    for (let i = 0; i < nx; i++) {
      const x = this.xs[i];
      const col = i * (ny - 1);
      const active = [];
      for (let k = 0; k < this.rects.length; k++) {
        const r = this.rects[k];
        if (x > r.x + EPS && x < r.x2 - EPS) active.push(k);
      }
      for (let j = 0; j < ny - 1; j++) {
        const y1 = this.ys[j],
          y2 = this.ys[j + 1];
        let tier = 0;
        for (const k of active) {
          const inf = this.rects[k];
          if (y2 <= inf.y + EPS || y1 >= inf.y2 - EPS) continue;
          const raw = this.raw[k];
          if (
            x > raw.x + EPS &&
            x < raw.x2 - EPS &&
            y2 > raw.y + EPS &&
            y1 < raw.y2 - EPS
          ) {
            tier = 2;
            break;
          }
          tier = 1;
        }
        vEdge[col + j] = tier;
      }
    }
  }

  // Route from a to b (both must have been passed as terminals to
  // build()). dirA = departure direction, dirB = required arrival
  // direction. Returns [{x, y}, ...] or null if unroutable.
  route(a, dirA, b, dirB) {
    if (!this.hEdge) return null;
    const { xs, ys, nx, ny, hEdge, vEdge, bendPenalty: BP } = this;
    const MULT = OrthoRouter.TIER_MULT;
    const ia = idxOf(xs, a.x),
      ja = idxOf(ys, a.y);
    const ib = idxOf(xs, b.x),
      jb = idxOf(ys, b.y);
    if (ia < 0 || ja < 0 || ib < 0 || jb < 0) return null;
    const gx = xs[ib],
      gy = ys[jb];

    const open = new Heap();
    const best = new Map(); // (i, j, dir) -> lowest g seen
    const skey = (i, j, d) => ((j * nx + i) << 2) | d;
    const heur = (i, j, d) =>
      Math.abs(xs[i] - gx) +
      Math.abs(ys[j] - gy) +
      BP * estBends(d, xs[i], ys[j], gx, gy, dirB);

    const start = { i: ia, j: ja, d: dirA, g: 0, f: heur(ia, ja, dirA), parent: null };
    open.push(start);
    best.set(skey(ia, ja, dirA), 0);

    let pops = 0;
    while (open.size) {
      const cur = open.pop();
      if (++pops > 60000) return null; // safety valve
      const ck = skey(cur.i, cur.j, cur.d);
      if (cur.g > (best.get(ck) ?? Infinity)) continue; // stale entry
      if (cur.i === ib && cur.j === jb) return reconstruct(cur, xs, ys);

      // straight first, then right, then left (paper's deterministic
      // tie-break: slight preference for straighter, then right turns).
      for (const nd of [cur.d, (cur.d + 1) & 3, (cur.d + 3) & 3]) {
        let ni = cur.i,
          nj = cur.j,
          tier;
        if (nd === DIR.E) {
          if (cur.i + 1 >= nx) continue;
          tier = hEdge[cur.j * (nx - 1) + cur.i];
          ni = cur.i + 1;
        } else if (nd === DIR.W) {
          if (cur.i <= 0) continue;
          tier = hEdge[cur.j * (nx - 1) + cur.i - 1];
          ni = cur.i - 1;
        } else if (nd === DIR.S) {
          if (cur.j + 1 >= ny) continue;
          tier = vEdge[cur.i * (ny - 1) + cur.j];
          nj = cur.j + 1;
        } else {
          if (cur.j <= 0) continue;
          tier = vEdge[cur.i * (ny - 1) + cur.j - 1];
          nj = cur.j - 1;
        }
        // Clearance zones are soft obstacles, but node bodies are hard
        // obstacles.  A large finite penalty still lets A* cut through a
        // node whenever the legal detour is sufficiently long.
        if (tier === 2) continue;
        const len = Math.abs(xs[ni] - xs[cur.i]) + Math.abs(ys[nj] - ys[cur.j]);
        const g =
          cur.g + len + len * MULT[tier] + (nd === cur.d ? 0 : BP);
        const k = skey(ni, nj, nd);
        if (g >= (best.get(k) ?? Infinity)) continue;
        best.set(k, g);
        open.push({ i: ni, j: nj, d: nd, g, f: g + heur(ni, nj, nd), parent: cur });
      }
    }
    return null;
  }

  // Route a complete connector through the shortest viable combination of
  // normal, vertical, direct-outward, and own-perimeter endpoint escapes.
  routeConnector(out, bodyOut, frameOut, frameIn, bodyIn, inp) {
    const sourceIndex = this._endpointRectIndex(bodyOut, frameOut, true);
    const targetIndex = this._endpointRectIndex(bodyIn, frameIn, false);
    const starts = this._frameEscapeCandidates(frameOut, sourceIndex, true);
    const goals = this._frameEscapeCandidates(frameIn, targetIndex, false);
    const pairs = [];
    const endpointLegs =
      Math.abs(out.x - frameOut.x) +
      Math.abs(out.y - frameOut.y) +
      Math.abs(frameIn.x - inp.x) +
      Math.abs(frameIn.y - inp.y);
    for (const start of starts)
      for (const goal of goals)
        pairs.push({
          start,
          goal,
          escape: start.cost + goal.cost,
          estimate:
            endpointLegs +
            start.cost +
            Math.abs(start.point.x - goal.point.x) +
            Math.abs(start.point.y - goal.point.y) +
            goal.cost,
        });
    pairs.sort((a, b) => a.escape - b.escape || a.estimate - b.estimate);

    // Endpoint escape legs are protected tunnels: they may pass through a
    // node which physically overlaps the endpoint, but the A* middle section
    // still treats every body as a hard obstacle.  Escape distance has
    // priority; full routed length only breaks ties between equally short
    // ways out of the overlap.
    let winner = null,
      winnerEscape = Infinity,
      winnerLength = Infinity;
    for (const { start, goal, escape } of pairs) {
      if (winner && escape > winnerEscape + EPS) break;
      const mid = this.route(start.point, start.dir, goal.point, goal.dir);
      if (!mid) continue;
      // Keep the two frame anchors even when the whole connector is straight.
      // Drag stretching relies on these four endpoint points being present.
      const path = dedupePoints([
        out,
        ...start.leg,
        ...mid,
        ...goal.leg.slice().reverse(),
        inp,
      ]);
      const length = pathLength(path);
      if (
        escape < winnerEscape - EPS ||
        (Math.abs(escape - winnerEscape) <= EPS && length < winnerLength)
      ) {
        winner = path;
        winnerEscape = escape;
        winnerLength = length;
      }
    }
    if (winner) return winner;

    // The clearance frame itself may be covered by a foreign node body.
    // Retry from the endpoint nodes' raw body edges; those vertices can
    // travel vertically along (but never through) their own body edges.
    const mid = this.route(bodyOut, DIR.E, bodyIn, DIR.E);
    if (mid) return dedupePoints([out, bodyOut, ...mid, bodyIn, inp]);
    return null;
  }

  // Locate the endpoint's own obstacle so its clearance rectangle is not
  // mistaken for a blocker.  Slot positions are on the raw right/left edge.
  _endpointRectIndex(body, frame, isOutput) {
    for (let i = 0; i < this.raw.length; i++) {
      const raw = this.raw[i],
        inf = this.rects[i];
      const rawEdge = isOutput ? raw.x2 : raw.x;
      const frameEdge = isOutput ? inf.x2 : inf.x;
      if (
        Math.abs(body.x - rawEdge) < EPS &&
        Math.abs(frame.x - frameEdge) < EPS &&
        body.y >= raw.y - EPS &&
        body.y <= raw.y2 + EPS
      )
        return i;
    }
    return -1;
  }

  // Return normal, direct-outward, vertical, and own-perimeter escape
  // candidates.  Protected perimeter tunnels are only created through raw
  // node bodies connected to the endpoint's own body by actual overlap.
  _frameEscapeCandidates(frame, ownIndex, isOutput) {
    const normal = this._escapeCandidate([frame], isOutput);
    if (ownIndex < 0) return [normal];
    const overlap = this._rawOverlapSet(ownIndex);
    // Clearance overlap is a soft routing cost, not an endpoint enclosure.
    // Protected escape tunnels are only needed when raw node bodies overlap.
    if (overlap.size <= 1) return [normal];
    const intervals = [];
    let blocked = false;
    for (const i of overlap) {
      if (i === ownIndex) continue;
      const r = this.rects[i];
      if (frame.x <= r.x + EPS || frame.x >= r.x2 - EPS) continue;
      intervals.push([r.y, r.y2]);
      if (frame.y > r.y + EPS && frame.y < r.y2 - EPS) blocked = true;
    }
    if (!blocked) return [normal];

    let lo = frame.y,
      hi = frame.y,
      changed = true;
    while (changed) {
      changed = false;
      for (const [a, b] of intervals) {
        if (b < lo - EPS || a > hi + EPS) continue;
        const nextLo = Math.min(lo, a),
          nextHi = Math.max(hi, b);
        if (nextLo < lo - EPS || nextHi > hi + EPS) {
          lo = nextLo;
          hi = nextHi;
          changed = true;
        }
      }
    }
    const candidates = [
      this._escapeCandidate([frame, { x: frame.x, y: lo }], isOutput),
      this._escapeCandidate([frame, { x: frame.x, y: hi }], isOutput),
    ];

    const outward = isOutput ? 1 : -1;
    const direct = this._horizontalOverlapExit(frame, ownIndex, overlap, outward);
    if (Math.abs(direct.x - frame.x) > EPS)
      candidates.push(this._escapeCandidate([frame, direct], isOutput));

    const own = this.rects[ownIndex];
    for (const y of [own.y, own.y2]) {
      const corner = { x: frame.x, y };
      const exit = this._horizontalOverlapExit(corner, ownIndex, overlap, -outward);
      candidates.push(this._escapeCandidate([frame, corner, exit], isOutput));
    }

    const best = new Map();
    for (const candidate of candidates) {
      const p = candidate.point;
      const key = Math.round(p.x * 2) + "," + Math.round(p.y * 2);
      const old = best.get(key);
      if (!old || candidate.cost < old.cost) best.set(key, candidate);
    }
    return [...best.values()];
  }

  _escapeCandidate(points, isOutput) {
    const leg = dedupePoints(points);
    const point = leg[leg.length - 1];
    let dir = DIR.E;
    if (leg.length > 1) {
      const d = segmentDirection(leg[leg.length - 2], point);
      dir = isOutput ? d : rev(d);
    }
    return { point, leg, cost: pathLength(leg), dir };
  }

  _rawOverlapSet(ownIndex) {
    const cached = this.overlapCache.get(ownIndex);
    if (cached) return cached;
    const found = new Set([ownIndex]);
    const queue = [ownIndex];
    while (queue.length) {
      const a = this.raw[queue.pop()];
      for (let i = 0; i < this.raw.length; i++) {
        if (found.has(i)) continue;
        const b = this.raw[i];
        if (
          a.x < b.x2 - EPS &&
          a.x2 > b.x + EPS &&
          a.y < b.y2 - EPS &&
          a.y2 > b.y + EPS
        ) {
          found.add(i);
          queue.push(i);
        }
      }
    }
    this.overlapCache.set(ownIndex, found);
    return found;
  }

  _horizontalOverlapExit(point, ownIndex, overlap, direction) {
    const origin = point.x;
    let edge = origin,
      changed = true;
    while (changed) {
      changed = false;
      for (const i of overlap) {
        if (i === ownIndex) continue;
        const raw = this.raw[i];
        if (point.y <= raw.y + EPS || point.y >= raw.y2 - EPS) continue;
        if (direction < 0) {
          if (raw.x2 <= edge + EPS || raw.x >= origin - EPS) continue;
          const next = Math.min(edge, this.rects[i].x);
          if (next < edge - EPS) {
            edge = next;
            changed = true;
          }
        } else {
          if (raw.x >= edge - EPS || raw.x2 <= origin + EPS) continue;
          const next = Math.max(edge, this.rects[i].x2);
          if (next > edge + EPS) {
            edge = next;
            changed = true;
          }
        }
      }
    }
    return { x: edge, y: point.y };
  }

  debugInfo() {
    return { rects: this.rects, xs: this.xs, ys: this.ys };
  }
}

function reconstruct(entry, xs, ys) {
  const pts = [];
  for (let e = entry; e; e = e.parent) pts.push({ x: xs[e.i], y: ys[e.j] });
  pts.reverse();
  return simplify(pts);
}

// Drop collinear / duplicate intermediate points.
export function simplify(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let k = 1; k < pts.length - 1; k++) {
    const a = out[out.length - 1],
      b = pts[k],
      c = pts[k + 1];
    const abH = Math.abs(a.y - b.y) < EPS,
      bcH = Math.abs(b.y - c.y) < EPS;
    const abV = Math.abs(a.x - b.x) < EPS,
      bcV = Math.abs(b.x - c.x) < EPS;
    if ((abH && bcH) || (abV && bcV)) continue; // collinear
    if (Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS) continue; // dup
    out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function dedupePoints(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < EPS && Math.abs(last.y - p.y) < EPS) continue;
    out.push(p);
  }
  return out;
}

// True only when an orthogonal segment enters a rectangle's open interior.
// Travelling exactly along a node edge remains legal for endpoint escapes.
function segmentCrossesRect(a, b, r) {
  const minX = Math.min(a.x, b.x),
    maxX = Math.max(a.x, b.x),
    minY = Math.min(a.y, b.y),
    maxY = Math.max(a.y, b.y);
  if (Math.abs(a.y - b.y) < EPS)
    return (
      a.y > r.y + EPS &&
      a.y < r.y2 - EPS &&
      maxX > r.x + EPS &&
      minX < r.x2 - EPS
    );
  if (Math.abs(a.x - b.x) < EPS)
    return (
      a.x > r.x + EPS &&
      a.x < r.x2 - EPS &&
      maxY > r.y + EPS &&
      minY < r.y2 - EPS
    );
  // Router output should never be diagonal.  Treat one as unsafe rather
  // than allowing an unverified path through a body.
  return true;
}

export function pathCrossesRects(pts, rects) {
  for (let i = 0; i < pts.length - 1; i++)
    for (const r of rects)
      if (segmentCrossesRect(pts[i], pts[i + 1], r)) return true;
  return false;
}

// A stretched drag path may leave its source body on the first segment and
// enter its target body on the last segment. Every other body intersection is
// unsafe and must force a fresh route. This deliberately rejects sticky paths
// in physically overlapped endpoint layouts; the full router owns those
// protected escape-tunnel cases.
export function stretchedPathCrossesUnexpectedNode(pts, rects, sourceIndex, targetIndex) {
  for (let i = 0; i < pts.length - 1; i++) {
    for (let j = 0; j < rects.length; j++) {
      if (i === 0 && j === sourceIndex) continue;
      if (i === pts.length - 2 && j === targetIndex) continue;
      if (segmentCrossesRect(pts[i], pts[i + 1], rects[j])) return true;
    }
  }
  return false;
}

function pathLength(pts) {
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++)
    total += Math.abs(pts[i + 1].x - pts[i].x) + Math.abs(pts[i + 1].y - pts[i].y);
  return total;
}

function segmentDirection(a, b) {
  if (b.x > a.x + EPS) return DIR.E;
  if (b.x < a.x - EPS) return DIR.W;
  if (b.y > a.y + EPS) return DIR.S;
  return DIR.N;
}
