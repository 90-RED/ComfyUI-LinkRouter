// Unit tests for router.js — run with: node test/router.test.mjs
import { OrthoRouter, DIR, simplify } from "../web/router.js";

let passed = 0,
  failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log("  ok  " + name);
  } else {
    failed++;
    console.log("FAIL  " + name + (extra ? " — " + extra : ""));
  }
}

function segments(pts) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) out.push([pts[i], pts[i + 1]]);
  return out;
}
function isOrthogonal(pts) {
  return segments(pts).every(
    ([a, b]) => Math.abs(a.x - b.x) < 0.01 || Math.abs(a.y - b.y) < 0.01,
  );
}
// Does the path enter the raw (un-inflated) rect interior?
function crossesRect(pts, r, shrink = 0.5) {
  const rx = r.x + shrink,
    ry = r.y + shrink,
    rx2 = r.x + r.w - shrink,
    ry2 = r.y + r.h - shrink;
  for (const [a, b] of segments(pts)) {
    const x1 = Math.min(a.x, b.x),
      x2 = Math.max(a.x, b.x);
    const y1 = Math.min(a.y, b.y),
      y2 = Math.max(a.y, b.y);
    if (x1 < rx2 && x2 > rx && y1 < ry2 && y2 > ry) return true;
  }
  return false;
}
function pathLen(pts) {
  let l = 0;
  for (const [a, b] of segments(pts)) l += Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  return l;
}
function bends(pts) {
  return simplify(pts).length - 2;
}

// ---------------------------------------------------------------- tests

console.log("\n[1] no obstacle — straight line");
{
  const r = new OrthoRouter({ margin: 10 });
  const A = { x: 0, y: 50 },
    B = { x: 300, y: 50 };
  r.build([], [A, B]);
  const p = r.route(A, DIR.E, B, DIR.E);
  check("route found", !!p);
  check("orthogonal", p && isOrthogonal(p));
  check("straight (2 pts)", p && p.length === 2, p && JSON.stringify(p));
  check("length = 300", p && Math.abs(pathLen(p) - 300) < 1);
}

console.log("\n[2] single obstacle between endpoints — must detour");
{
  const r = new OrthoRouter({ margin: 10 });
  const obs = { x: 100, y: 0, w: 100, h: 100 }; // blocks y=50 straight shot
  const A = { x: 0, y: 50 },
    B = { x: 300, y: 50 };
  r.build([obs], [A, B]);
  const p = r.route(A, DIR.E, B, DIR.E);
  check("route found", !!p);
  check("orthogonal", p && isOrthogonal(p));
  check("avoids obstacle", p && !crossesRect(p, obs), p && JSON.stringify(p));
  check("has bends", p && bends(p) >= 2);
  check("reasonable length (< 500)", p && pathLen(p) < 500, p && "len=" + pathLen(p));
}

console.log("\n[3] wall of two overlapping obstacles — route around the block");
{
  const r = new OrthoRouter({ margin: 10 });
  const o1 = { x: 100, y: -100, w: 80, h: 150 };
  const o2 = { x: 120, y: 40, w: 80, h: 160 }; // overlaps o1 vertically
  const A = { x: 0, y: 50 },
    B = { x: 320, y: 50 };
  r.build([o1, o2], [A, B]);
  const p = r.route(A, DIR.E, B, DIR.E);
  check("route found", !!p);
  check("avoids o1", p && !crossesRect(p, o1), p && JSON.stringify(p));
  check("avoids o2", p && !crossesRect(p, o2));
}

console.log("\n[4] alley between two nodes — should pass between, not around");
{
  const r = new OrthoRouter({ margin: 10 });
  // two tall blocks with a 60px-wide gap at x = 130..190
  const o1 = { x: 50, y: -400, w: 80, h: 380 }; // ends at y=-20
  const o2 = { x: 50, y: 60, w: 80, h: 380 }; // starts at y=60; alley y in (-10, 50)
  const A = { x: 0, y: 20 },
    B = { x: 250, y: 20 };
  r.build([o1, o2], [A, B]);
  const p = r.route(A, DIR.E, B, DIR.E);
  check("route found", !!p);
  check("avoids o1", p && !crossesRect(p, o1));
  check("avoids o2", p && !crossesRect(p, o2));
  // going around would cost > 800; through the alley ~250
  check("goes through alley", p && pathLen(p) < 400, p && "len=" + pathLen(p));
}

console.log("\n[5] backward link (B left of A) — U-turn route");
{
  const r = new OrthoRouter({ margin: 10 });
  const obs = { x: -50, y: -60, w: 200, h: 120 }; // both ports on this node's sides
  const A = { x: 150, y: 0 }, // output on right edge
    B = { x: -50, y: 0 }; // input on left edge
  const stubA = { x: 164, y: 0 },
    stubB = { x: -64, y: 0 };
  r.build([obs], [stubA, stubB]);
  const p = r.route(stubA, DIR.E, stubB, DIR.E);
  check("route found", !!p);
  check("orthogonal", p && isOrthogonal(p));
  check("avoids node", p && !crossesRect(p, obs), p && JSON.stringify(p));
}

console.log("\n[6] dense workflow — performance");
{
  const r = new OrthoRouter({ margin: 16 });
  const rects = [];
  const terms = [];
  // 60 nodes in a jittered grid
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 60; i++) {
    rects.push({
      x: (i % 10) * 260 + rnd() * 60,
      y: Math.floor(i / 10) * 220 + rnd() * 60,
      w: 180 + rnd() * 40,
      h: 100 + rnd() * 80,
    });
  }
  // 80 links between random node pairs
  const links = [];
  for (let k = 0; k < 80; k++) {
    const i = Math.floor(rnd() * 59);
    const j = Math.min(59, i + 1 + Math.floor(rnd() * 8));
    const a = rects[i],
      b = rects[j];
    const A = { x: a.x + a.w + 22, y: a.y + 30 + rnd() * 40 };
    const B = { x: b.x - 22, y: b.y + 30 + rnd() * 40 };
    terms.push(A, B);
    links.push([A, B]);
  }

  const t0 = performance.now();
  r.build(rects, terms);
  const t1 = performance.now();
  const inside = (p, o, s = 0.5) =>
    p.x > o.x + s && p.x < o.x + o.w - s && p.y > o.y + s && p.y < o.y + o.h - s;
  let found = 0,
    badCross = 0;
  for (const [A, B] of links) {
    const p = r.route(A, DIR.E, B, DIR.E);
    if (p) {
      found++;
      // crossings through a node that contains this link's own port are
      // unavoidable (nodes placed on top of each other); anything else
      // is a real routing failure.
      const hit = rects.filter((o) => crossesRect(p, o));
      if (hit.some((o) => !inside(A, o) && !inside(B, o))) badCross++;
    }
  }
  const t2 = performance.now();
  const build = t1 - t0,
    route = t2 - t1;
  console.log(
    `      build=${build.toFixed(1)}ms  route80=${route.toFixed(1)}ms  ` +
      `(${(route / 80).toFixed(2)}ms/link)  found=${found}/80  badCross=${badCross}`,
  );
  check("all routes found", found === 80);
  check("no avoidable node crossings", badCross === 0, `badCross=${badCross}`);
  check("build < 50ms", build < 50, build.toFixed(1) + "ms");
  check("routing < 4ms/link avg", route / 80 < 4, (route / 80).toFixed(2) + "ms");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
