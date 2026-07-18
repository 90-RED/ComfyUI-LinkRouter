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

// First index with arr[idx] >= v (sorted ascending).
function lowerBound(arr, v) {
  let lo = 0,
    hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

// First index with arr[idx] > v (sorted ascending).
function upperBound(arr, v) {
  let lo = 0,
    hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] <= v) lo = m + 1;
    else hi = m;
  }
  return lo;
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
    this._diff = null; // reusable Int32Array for difference-array build
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
    //
    // Computed with 2D difference arrays over the compressed grid instead
    // of scanning active rects per edge: each rect contributes +1/-1 over
    // the strict-interior index ranges it covers, then a prefix sum yields
    // per-edge coverage counts.  Two passes per orientation: raw bodies
    // (tier 2), then inflated clearance frames (tier 1 where not already
    // tier 2).  O(nx*ny + R log R) instead of O(nx*ny * activeRects);
    // produces byte-identical results to the previous active-set scan.
    this._stampTiers(hEdge, true);
    this._stampTiers(vEdge, false);
  }

  // Fill `out` (Uint8Array) with edge tiers for one orientation.
  // horizontal: out[j*(nx-1) + i], segment xs[i]..xs[i+1] at row ys[j].
  // !horizontal: out[i*(ny-1) + j], segment ys[j]..ys[j+1] at column xs[i].
  _stampTiers(out, horizontal) {
    const { xs, ys, nx, ny } = this;
    const segW = horizontal ? nx - 1 : ny - 1; // segments per line
    const segH = horizontal ? ny : nx; // lines
    const cells = segW * segH;
    if (cells <= 0) return;
    let diff = this._diff;
    // Signed type required: decrement positions go negative before the
    // prefix sum runs (unsigned would wrap and corrupt the counts).
    if (!diff || diff.length < cells) diff = this._diff = new Int32Array(cells);
    // pass 0: raw bodies -> tier 2; pass 1: inflated frames -> tier 1.
    for (let pass = 0; pass < 2; pass++) {
      const rects = pass === 0 ? this.raw : this.rects;
      const tier = pass === 0 ? 2 : 1;
      diff.fill(0, 0, cells);
      for (let k = 0; k < rects.length; k++) {
        const r = rects[k];
        let lineLo, lineHi, segLo, segHi;
        if (horizontal) {
          // row strictly inside the rect's y-range:
          //   ys[j] > r.y+EPS && ys[j] < r.y2-EPS
          lineLo = upperBound(ys, r.y + EPS);
          lineHi = lowerBound(ys, r.y2 - EPS);
          // open segment strictly overlapping the rect's x-range:
          //   xs[i+1] > r.x+EPS && xs[i] < r.x2-EPS
          segLo = upperBound(xs, r.x + EPS) - 1;
          segHi = lowerBound(xs, r.x2 - EPS);
        } else {
          // column strictly inside the rect's x-range
          lineLo = upperBound(xs, r.x + EPS);
          lineHi = lowerBound(xs, r.x2 - EPS);
          // open segment strictly overlapping the rect's y-range
          segLo = upperBound(ys, r.y + EPS) - 1;
          segHi = lowerBound(ys, r.y2 - EPS);
        }
        if (lineLo >= lineHi || segLo >= segHi) continue;
        if (segLo < 0) segLo = 0;
        for (let a = lineLo; a < lineHi; a++) {
          const row = a * segW;
          diff[row + segLo]++;
          if (segHi < segW) diff[row + segHi]--;
        }
      }
      for (let a = 0; a < segH; a++) {
        const row = a * segW;
        let c = 0;
        for (let b = 0; b < segW; b++) {
          c += diff[row + b];
          if (c > 0 && (tier === 2 || out[row + b] === 0)) out[row + b] = tier;
        }
      }
    }
  }

  // Route from a to b (both must have been passed as terminals to
  // build()). dirA = departure direction, dirB = required arrival
  // direction. Returns [{x, y}, ...] or null if unroutable.
  //
  // opts (all optional, defaults reproduce the historical exact search):
  //   weight  — heuristic inflation (weighted A*). 1 = optimal; >1 is
  //             bounded-suboptimal but several times faster on big graphs.
  //   win     — {i0, i1, j0, j1} grid-index bounds; states outside the
  //             window are never expanded (corridor search).
  //   maxPops — safety valve on A* pops (default 60000).
  // Side effects for diagnostics: this._lastPops / this._lastCost.
  route(a, dirA, b, dirB, opts) {
    this._lastPops = 0;
    this._lastCost = Infinity;
    if (!this.hEdge) return null;
    const { xs, ys, nx, ny, hEdge, vEdge, bendPenalty: BP } = this;
    const MULT = OrthoRouter.TIER_MULT;
    const weight = Math.max(1, opts?.weight || 1);
    const win = opts?.win || null;
    const maxPops = opts?.maxPops || 60000;
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
      weight *
      (Math.abs(xs[i] - gx) +
        Math.abs(ys[j] - gy) +
        BP * estBends(d, xs[i], ys[j], gx, gy, dirB));

    const start = { i: ia, j: ja, d: dirA, g: 0, f: heur(ia, ja, dirA), parent: null };
    open.push(start);
    best.set(skey(ia, ja, dirA), 0);

    let pops = 0;
    while (open.size) {
      const cur = open.pop();
      if (++pops > maxPops) {
        this._lastPops = pops;
        return null; // safety valve
      }
      const ck = skey(cur.i, cur.j, cur.d);
      if (cur.g > (best.get(ck) ?? Infinity)) continue; // stale entry
      if (cur.i === ib && cur.j === jb) {
        this._lastPops = pops;
        this._lastCost = cur.g;
        return reconstruct(cur, xs, ys);
      }

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
        // Corridor window: never leave the search bounds.
        if (win && (ni < win.i0 || ni > win.i1 || nj < win.j0 || nj > win.j1))
          continue;
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
    this._lastPops = pops;
    return null;
  }

  // Route a complete connector through the shortest viable combination of
  // normal, vertical, direct-outward, and own-perimeter endpoint escapes.
  //
  // opts.weight (default 1): heuristic inflation for the A* middle section.
  // Interactive callers pass ~2.5 for responsiveness; the stable pass uses 1
  // so settled paths remain optimal in the common case.
  //
  // Search strategy per escape pair (cheapest first):
  //   0. simple 0/1-bend candidates with an exact optimality proof;
  //   1. A* inside a corridor window around the terminals;
  //   2. A* inside a larger window;
  //   3. full-graph A* with weight >= 2.5 (last resort; previously these
  //      links simply died on the 60k-pops valve and vanished).
  // A windowed route whose cost exceeds 1.15x the global lower bound is
  // rejected so the search escalates instead of accepting a long detour.
  // Diagnostics land in this.lastStats = {pops, level, simple, weight}.
  routeConnector(out, bodyOut, frameOut, frameIn, bodyIn, inp, opts) {
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

    const weight = Math.max(1, opts?.weight || 1);
    const stats = (this.lastStats = { pops: 0, level: 0, simple: 0, weight });
    // Tests and diagnostics may disable the proven-optimal fast path.
    const useSimple = opts?.simple !== false;

    // Corridor window: bbox of every terminal, expanded by the larger of
    // 4x margin or half the endpoint manhattan distance.
    const bb = {
      x0: Math.min(out.x, bodyOut.x, frameOut.x, frameIn.x, bodyIn.x, inp.x),
      y0: Math.min(out.y, bodyOut.y, frameOut.y, frameIn.y, bodyIn.y, inp.y),
      x1: Math.max(out.x, bodyOut.x, frameOut.x, frameIn.x, bodyIn.x, inp.x),
      y1: Math.max(out.y, bodyOut.y, frameOut.y, frameIn.y, bodyIn.y, inp.y),
    };
    const mg = this.margin;
    const mMax = typeof mg === "number" ? mg : Math.max(mg.l, mg.r, mg.t, mg.b);
    const manh = Math.abs(out.x - inp.x) + Math.abs(out.y - inp.y);
    const pad1 = Math.max(4 * mMax, 0.75 * manh);
    const win0 = this._windowIndices(bb, pad1);
    const winStates = (w) => 4 * (w.i1 - w.i0 + 1) * (w.j1 - w.j0 + 1);
    const winPops = (ws) => Math.min(60000, Math.max(8000, 2 * ws));
    const w0s = winStates(win0);
    const fullStates = 4 * this.nx * this.ny;
    const wFast = Math.max(weight, 2.5);
    let levels;
    let defaultBudget = 250000;
    if (fullStates <= 2000000) {
      // Small/medium graph: the plain exact search was never the lag
      // problem here, so keep it — outcomes stay identical to the
      // historical router, drag included. The new machinery below only
      // engages where the exact search actually breaks down.
      levels = [{ win: null, weight: 1, maxPops: 60000 }];
      defaultBudget = Infinity;
    } else if (pairs.length > 2) {
      // Overlap-tangled connector: escape pairs multiply the search cost
      // (each losing pair can burn a whole pops cap before the winning
      // pair is reached). Exactness is already compromised by the overlap
      // geometry, so every level goes weighted: failures fail fast and
      // the winning pair resolves in a few thousand pops.
      levels = [
        { win: win0, weight: wFast, maxPops: 60000 },
        { win: null, weight: wFast, maxPops: 150000 },
      ];
      defaultBudget = 400000;
    } else if (w0s <= 250000 || w0s * 2 < fullStates) {
      // Exact chain: the corridor is affordable or actually prunes the
      // graph, so settled paths stay optimal for the common links.
      const win1 = this._windowIndices(bb, pad1 * 2.5);
      levels = [
        { win: win0, weight, maxPops: winPops(w0s) },
        { win: win1, weight, maxPops: winPops(winStates(win1)) },
        { win: null, weight: wFast, maxPops: 150000 },
      ];
    } else {
      // The corridor covers most of a huge graph: exact search there is
      // the old 200ms+ disaster. Go weighted immediately; the window still
      // prunes the far-flung regions.
      levels = [
        { win: win0, weight: wFast, maxPops: 100000 },
        { win: null, weight: wFast, maxPops: 150000 },
      ];
    }
    // Hard per-connector pops budget across every pair and level: a
    // pathological link must degrade (negative cache + sticky path), never
    // freeze the canvas for hundreds of milliseconds.
    const popsBudget = opts?.popsBudget ?? defaultBudget;

    // Endpoint escape legs are protected tunnels: they may pass through a
    // node which physically overlaps the endpoint, but the A* middle section
    // still treats every body as a hard obstacle.  Escape distance has
    // priority; full routed length only breaks ties between equally short
    // ways out of the overlap.
    let winner = null,
      winnerEscape = Infinity,
      winnerLength = Infinity;
    for (let lv = 0; lv < levels.length && !winner; lv++) {
      const L = levels[lv];
      for (const { start, goal, escape } of pairs) {
        if (winner && escape > winnerEscape + EPS) break;
        if (stats.pops >= popsBudget) break;
        let mid = null;
        if (lv === 0 && useSimple) {
          mid = this._simpleMid(start, goal);
          if (mid) stats.simple++;
        }
        if (!mid) {
          mid = this.route(start.point, start.dir, goal.point, goal.dir, {
            ...L,
            maxPops: Math.min(L.maxPops, popsBudget - stats.pops),
          });
          stats.pops += this._lastPops;
          if (!mid) continue;
          // Escalation happens on failure only: a windowed path that looks
          // expensive may simply have a loose lower bound (obstacle-forced
          // detour), so cost alone must not discard it.
        }
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
      if (winner) stats.level = lv + 1;
    }
    if (winner) return winner;

    // The clearance frame itself may be covered by a foreign node body.
    // Retry from the endpoint nodes' raw body edges; those vertices can
    // travel vertically along (but never through) their own body edges.
    // This escape hatch gets its own dedicated pops allowance (the
    // historical 60k valve): the pair loop above must not be able to
    // starve it, or links the old router saved would newly vanish.
    const mid = this.route(bodyOut, DIR.E, bodyIn, DIR.E, {
      maxPops: 60000,
    });
    stats.pops += this._lastPops;
    if (mid) return dedupePoints([out, bodyOut, ...mid, bodyIn, inp]);
    return null;
  }

  // Convert a pixel-space bbox + padding into inclusive grid-index bounds.
  // Terminals passed to build() are always inside, so the range is never
  // empty.
  _windowIndices(bb, pad) {
    const { xs, ys } = this;
    return {
      i0: Math.max(0, lowerBound(xs, bb.x0 - pad - EPS)),
      i1: Math.min(xs.length - 1, upperBound(xs, bb.x1 + pad + EPS) - 1),
      j0: Math.max(0, lowerBound(ys, bb.y0 - pad - EPS)),
      j1: Math.min(ys.length - 1, upperBound(ys, bb.y1 + pad + EPS) - 1),
    };
  }

  // Edge-by-edge cost of an axis-aligned grid segment, following the same
  // tier pricing as the A* step. Returns null when a node body blocks it.
  _walkSeg(i1, j1, i2, j2) {
    const { xs, ys, nx, ny, hEdge, vEdge } = this;
    const MULT = OrthoRouter.TIER_MULT;
    let cost = 0;
    if (j1 === j2) {
      const row = j1 * (nx - 1);
      const a = Math.min(i1, i2),
        b = Math.max(i1, i2);
      for (let i = a; i < b; i++) {
        const t = hEdge[row + i];
        if (t === 2) return null;
        cost += (xs[i + 1] - xs[i]) * (1 + MULT[t]);
      }
    } else if (i1 === i2) {
      const col = i1 * (ny - 1);
      const a = Math.min(j1, j2),
        b = Math.max(j1, j2);
      for (let j = a; j < b; j++) {
        const t = vEdge[col + j];
        if (t === 2) return null;
        cost += (ys[j + 1] - ys[j]) * (1 + MULT[t]);
      }
    } else return null;
    return cost;
  }

  // Global lower bound for a mid-section: manhattan distance plus the
  // cheapest bend estimate over all arrival directions (arrival direction
  // is a soft preference, so the bound must minimise over it).
  _midLB(start, goal) {
    const S = start.point,
      G = goal.point;
    let minB = Infinity;
    for (let gd = 0; gd < 4; gd++)
      minB = Math.min(minB, estBends(start.dir, S.x, S.y, G.x, G.y, gd));
    return (
      Math.abs(S.x - G.x) + Math.abs(S.y - G.y) + this.bendPenalty * minB
    );
  }

  // Fast path: try the straight and the two L-shaped mid-sections. A
  // candidate whose exact cost matches the global lower bound is provably
  // optimal, so A* can be skipped entirely. Returns the path (and sets
  // _lastCost) or null to fall through to the search.
  _simpleMid(start, goal) {
    const { xs, ys, bendPenalty: BP } = this;
    const S = start.point,
      G = goal.point;
    const is = idxOf(xs, S.x),
      js = idxOf(ys, S.y);
    const ig = idxOf(xs, G.x),
      jg = idxOf(ys, G.y);
    if (is < 0 || js < 0 || ig < 0 || jg < 0) return null;
    const cands = [];
    if (is === ig || js === jg)
      cands.push([
        { i: is, j: js },
        { i: ig, j: jg },
      ]);
    else {
      cands.push([
        { i: is, j: js },
        { i: ig, j: js },
        { i: ig, j: jg },
      ]);
      cands.push([
        { i: is, j: js },
        { i: is, j: jg },
        { i: ig, j: jg },
      ]);
    }
    let bestPts = null,
      bestCost = Infinity,
      tied = false;
    for (const c of cands) {
      let cost = 0,
        ok = true,
        prevDir = start.dir;
      for (let k = 0; k < c.length - 1 && ok; k++) {
        const a = c[k],
          b = c[k + 1];
        if (a.i === b.i && a.j === b.j) continue; // degenerate zero-length
        const seg = this._walkSeg(a.i, a.j, b.i, b.j);
        if (seg === null) {
          ok = false;
          break;
        }
        const d =
          a.j === b.j ? (b.i > a.i ? DIR.E : DIR.W) : b.j > a.j ? DIR.S : DIR.N;
        cost += seg + (d === prevDir ? 0 : BP);
        prevDir = d;
      }
      if (!ok) continue;
      if (cost < bestCost - EPS) {
        bestCost = cost;
        bestPts = c.map((p) => ({ x: xs[p.i], y: ys[p.j] }));
        tied = false;
      } else if (cost <= bestCost + EPS) {
        // An equal-cost alternative exists; let A*'s deterministic
        // tie-break pick the shape instead of guessing here.
        tied = true;
      }
    }
    // The optimality proof must be strict: EPS-level slack would accept a
    // candidate marginally worse than a path A* would have found, changing
    // the settled shape. Only a candidate that truly reaches the lower
    // bound (up to float noise) may bypass the search.
    if (bestPts && !tied && bestCost <= this._midLB(start, goal) + 1e-6) {
      this._lastCost = bestCost;
      return bestPts;
    }
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
