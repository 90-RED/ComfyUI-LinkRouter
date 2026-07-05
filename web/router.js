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

    // Tier of an edge = worst tier at its midpoint. Obstacle *edges*
    // themselves stay tier-0 (that's the margin routing lane).
    const tierAt = (px, py) => {
      let t = 0;
      for (let k = 0; k < this.rects.length; k++) {
        const inf = this.rects[k];
        if (inf.x < px && px < inf.x2 && inf.y < py && py < inf.y2) {
          const raw = this.raw[k];
          if (raw.x < px && px < raw.x2 && raw.y < py && py < raw.y2) return 2;
          if (t < 1) t = 1;
        }
      }
      return t;
    };

    for (let j = 0; j < ny; j++) {
      const y = this.ys[j];
      const row = j * (nx - 1);
      for (let i = 0; i < nx - 1; i++)
        hEdge[row + i] = tierAt((this.xs[i] + this.xs[i + 1]) / 2, y);
    }
    for (let i = 0; i < nx; i++) {
      const x = this.xs[i];
      const col = i * (ny - 1);
      for (let j = 0; j < ny - 1; j++)
        vEdge[col + j] = tierAt(x, (this.ys[j] + this.ys[j + 1]) / 2);
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
