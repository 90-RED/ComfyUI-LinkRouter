import test from "node:test";
import assert from "node:assert/strict";

import {
  DIR,
  OrthoRouter,
  pathCrossesRects,
  stretchedPathCrossesUnexpectedNode,
} from "../web/router.js";

function raw(rects) {
  return rects.map((r) => ({ x: r.x, y: r.y, x2: r.x + r.w, y2: r.y + r.h }));
}

test("sticky drag paths allow only their own endpoint bodies", () => {
  const rects = raw([
    { x: 0, y: 0, w: 100, h: 100 },
    { x: 150, y: 0, w: 100, h: 100 },
    { x: 300, y: 0, w: 100, h: 100 },
  ]);
  const clearDetour = [
    { x: 90, y: 50 },
    { x: 120, y: 50 },
    { x: 120, y: 130 },
    { x: 280, y: 130 },
    { x: 280, y: 50 },
    { x: 310, y: 50 },
  ];
  const throughThirdNode = [
    { x: 90, y: 50 },
    { x: 120, y: 50 },
    { x: 280, y: 50 },
    { x: 310, y: 50 },
  ];

  assert.equal(stretchedPathCrossesUnexpectedNode(clearDetour, rects, 0, 2), false);
  assert.equal(stretchedPathCrossesUnexpectedNode(throughThirdNode, rects, 0, 2), true);
});

test("A* treats every node body as a hard obstacle", () => {
  const rects = [
    { x: 0, y: 0, w: 100, h: 100 },
    { x: 130, y: 10, w: 100, h: 80 },
    { x: 400, y: 0, w: 100, h: 100 },
  ];
  const start = { x: 116, y: 50 };
  const goal = { x: 384, y: 50 };
  const router = new OrthoRouter({ margin: 16, bendPenalty: 40 });
  router.build(rects, [start, goal]);

  const path = router.route(start, DIR.E, goal, DIR.E);
  assert.ok(path, "expected a legal detour");
  assert.equal(pathCrossesRects(path, raw(rects)), false);
});

test("three-sided blockage escapes along the endpoint frame without crossing nodes", () => {
  const rects = [
    { x: 0, y: 0, w: 100, h: 100 },       // source
    { x: 120, y: -80, w: 100, h: 80 },    // above
    { x: 120, y: 100, w: 100, h: 80 },    // below
    { x: 130, y: 10, w: 100, h: 80 },     // in front
    { x: 400, y: 0, w: 100, h: 100 },     // target
  ];
  const out = { x: 100, y: 50 };
  const frameOut = { x: 116, y: 50 };
  const frameIn = { x: 384, y: 50 };
  const inp = { x: 400, y: 50 };
  const router = new OrthoRouter({ margin: 16, bendPenalty: 40 });
  router.build(rects, [out, frameOut, frameIn, inp]);
  const originalRoute = router.route.bind(router);
  let routeCalls = 0;
  router.route = (...args) => {
    routeCalls++;
    return originalRoute(...args);
  };

  const path = router.routeConnector(out, out, frameOut, frameIn, inp, inp);
  assert.ok(path, "expected the boxed-in output to escape");
  assert.deepEqual(path[0], out);
  assert.deepEqual(path.at(-1), inp);
  assert.equal(pathCrossesRects(path, raw(rects)), false);
  assert.ok(
    path.some((p, i) => i > 0 && p.x === frameOut.x && p.y !== frameOut.y),
    "expected an upward/downward segment on the source clearance frame",
  );
  assert.equal(routeCalls, 1, "clearance-only blockage should stay in the normal A* route");
});

test("an endpoint overlapped by another node still escapes along its own frame", () => {
  const rects = [
    { x: 0, y: 0, w: 100, h: 100 },
    { x: 90, y: 20, w: 60, h: 60 },       // physically overlaps the source
    { x: 400, y: 0, w: 100, h: 100 },
  ];
  const out = { x: 100, y: 50 };
  const frameOut = { x: 116, y: 50 };
  const frameIn = { x: 384, y: 50 };
  const inp = { x: 400, y: 50 };
  const router = new OrthoRouter({ margin: 16, bendPenalty: 40 });
  router.build(rects, [out, frameOut, frameIn, inp]);

  const path = router.routeConnector(out, out, frameOut, frameIn, inp, inp);
  assert.ok(path, "expected the overlapped output to remain visible");
  assert.deepEqual(path[0], out);
  assert.deepEqual(path.at(-1), inp);
  const escapedAt = path.findIndex((p) => p.x === frameOut.x && p.y !== frameOut.y);
  assert.ok(escapedAt > 0, "expected a protected upward/downward frame escape");
  assert.equal(pathCrossesRects(path.slice(escapedAt), raw(rects)), false);
});

test("overlap near the left side follows the source perimeter for the shorter exit", () => {
  const rects = [
    { x: 100, y: 200, w: 100, h: 80 },
    { x: 150, y: 100, w: 200, h: 300 },
  ];
  const out = { x: 200, y: 240 };
  const frameOut = { x: 216, y: 240 };
  const frameIn = { x: 134, y: 140 };
  const inp = { x: 150, y: 140 };
  const router = new OrthoRouter({ margin: 16, bendPenalty: 40 });
  router.build(rects, [out, frameOut, frameIn, inp]);

  const path = router.routeConnector(out, out, frameOut, frameIn, inp, inp);
  assert.deepEqual(path, [
    out,
    frameOut,
    { x: 216, y: 184 },
    { x: 134, y: 184 },
    frameIn,
    inp,
  ]);
});

test("overlap near the right side exits directly when the local escape is shorter", () => {
  const rects = [
    { x: 300, y: 100, w: 100, h: 80 },
    { x: 350, y: 50, w: 100, h: 200 },
    { x: 600, y: 100, w: 100, h: 100 },
  ];
  const out = { x: 400, y: 140 };
  const frameOut = { x: 416, y: 140 };
  const frameIn = { x: 584, y: 140 };
  const inp = { x: 600, y: 140 };
  const router = new OrthoRouter({ margin: 16, bendPenalty: 40 });
  router.build(rects, [out, frameOut, frameIn, inp]);

  const path = router.routeConnector(out, out, frameOut, frameIn, inp, inp);
  assert.deepEqual(path, [
    out,
    frameOut,
    { x: 466, y: 140 },
    frameIn,
    inp,
  ]);
});

test("overlapped input keeps the locally shortest exit even when the route approaches from the right", () => {
  const rects = [
    { x: 600, y: 200, w: 100, h: 80 },
    { x: 300, y: 200, w: 100, h: 80 },
    { x: 250, y: 100, w: 100, h: 300 },
  ];
  const out = { x: 700, y: 240 };
  const frameOut = { x: 716, y: 240 };
  const frameIn = { x: 284, y: 240 };
  const inp = { x: 300, y: 240 };
  const router = new OrthoRouter({ margin: 16, bendPenalty: 40 });
  router.build(rects, [out, frameOut, frameIn, inp]);

  const path = router.routeConnector(out, out, frameOut, frameIn, inp, inp);
  assert.deepEqual(path.slice(-3), [
    { x: 234, y: 240 },
    frameIn,
    inp,
  ], "target should use its shorter direct-left escape corridor");
});

test("upper/lower escape selection uses completed route length", () => {
  const rects = [
    { x: 0, y: 0, w: 100, h: 100 },
    { x: 90, y: 20, w: 60, h: 60 },
    { x: 400, y: 0, w: 100, h: 100 },
  ];
  const out = { x: 100, y: 50 };
  const frameOut = { x: 116, y: 50 };
  const frameIn = { x: 384, y: 50 };
  const inp = { x: 400, y: 50 };
  const router = new OrthoRouter({ margin: 16, bendPenalty: 40 });
  router.build(rects, [out, frameOut, frameIn, inp]);
  let routeCalls = 0;
  router.route = (start, _dirA, goal) => {
    routeCalls++;
    if (start.y < frameOut.y)
      return [start, { x: start.x, y: -200 }, { x: goal.x, y: -200 }, goal];
    return [start, { x: goal.x, y: start.y }, goal];
  };

  // The simple-path fast lane computes from real tiers and would bypass
  // this stubbed route(); disable it so the test exercises the A* layer's
  // escape-pair selection exactly as before.
  const path = router.routeConnector(out, out, frameOut, frameIn, inp, inp, {
    simple: false,
  });
  assert.ok(path.some((p) => p.x === frameOut.x && p.y === 96));
  assert.equal(routeCalls, 2, "second candidate is checked only because it can still be shorter");
});

test("ComfyUI bounding padding does not make every endpoint look trapped inside its own node", () => {
  const rects = [
    { x: -4, y: -4, w: 108, h: 108 },
    { x: 396, y: -4, w: 108, h: 108 },
  ];
  const out = { x: 100, y: 50 };
  const bodyOut = { x: 104, y: 50 };
  const frameOut = { x: 120, y: 50 };
  const frameIn = { x: 380, y: 50 };
  const bodyIn = { x: 396, y: 50 };
  const inp = { x: 400, y: 50 };
  const router = new OrthoRouter({ margin: 16, bendPenalty: 40 });
  router.build(rects, [out, bodyOut, frameOut, frameIn, bodyIn, inp]);

  const path = router.routeConnector(out, bodyOut, frameOut, frameIn, bodyIn, inp);
  assert.ok(path, "expected a normal link despite four-pixel bounding padding");
  assert.deepEqual(path[0], out);
  assert.deepEqual(path[1], frameOut, "source frame anchor must survive collinear simplification");
  assert.deepEqual(path.at(-2), frameIn, "target frame anchor must survive collinear simplification");
  assert.deepEqual(path.at(-1), inp);
  assert.ok(path.length >= 4, "straight links need enough anchors for drag stretching");
  assert.equal(pathCrossesRects(path.slice(1, -1), raw(rects)), false);
});

test("three-sided input blockage enters from above or below along its own frame", () => {
  const rects = [
    { x: 0, y: 0, w: 100, h: 100 },
    { x: 280, y: -80, w: 100, h: 80 },
    { x: 280, y: 100, w: 100, h: 80 },
    { x: 270, y: 10, w: 100, h: 80 },
    { x: 400, y: 0, w: 100, h: 100 },
  ];
  const out = { x: 100, y: 50 };
  const frameOut = { x: 116, y: 50 };
  const frameIn = { x: 384, y: 50 };
  const inp = { x: 400, y: 50 };
  const router = new OrthoRouter({ margin: 16, bendPenalty: 40 });
  router.build(rects, [out, frameOut, frameIn, inp]);

  const path = router.routeConnector(out, out, frameOut, frameIn, inp, inp);
  assert.ok(path, "expected the boxed-in input to remain reachable");
  assert.deepEqual(path[0], out);
  assert.deepEqual(path.at(-1), inp);
  assert.equal(pathCrossesRects(path, raw(rects)), false);
  assert.ok(
    path.some((p, i) => i < path.length - 1 && p.x === frameIn.x && p.y !== frameIn.y),
    "expected an upward/downward entry segment on the target clearance frame",
  );
});

test("t01 sub-pixel clearance contact does not create a 515px wall detour", () => {
  const rects = [
    { x: 6831.641534224541, y: 1340.2901401161546, w: 350, h: 1090 },
    { x: 7213.416150735367, y: 1340.6378892243872, w: 225, h: 175.59375 },
    { x: 7213.368009485402, y: 1520.4259276037512, w: 225, h: 167.59375 },
    { x: 7213.368009485402, y: 1680.4259276037512, w: 225, h: 143.59375 },
  ];
  const out = { x: 7181.641534224541, y: 1375.2901401161546 };
  const frameOut = { x: 7197.641534224541, y: 1375.2901401161546 };
  const frameIn = { x: 7197.368009485402, y: 1555.4259276037512 };
  const inp = { x: 7213.368009485402, y: 1555.4259276037512 };
  const router = new OrthoRouter({ margin: 16, bendPenalty: 40 });
  router.build(rects, [out, frameOut, frameIn, inp]);

  const path = router.routeConnector(out, out, frameOut, frameIn, inp, inp);
  assert.ok(path.every((p) => p.y >= out.y && p.y <= inp.y));
  assert.deepEqual(path[1], frameOut);
  assert.deepEqual(path.at(-2), frameIn);
});

test("t02 chooses left locally for the left case and right locally for the right case", () => {
  const margin = 16;
  const route = (source, target) => {
    const out = { x: source.x + source.w, y: source.y + 35 };
    const frameOut = { x: out.x + margin, y: out.y };
    const inp = { x: target.x, y: target.y + 35 };
    const frameIn = { x: inp.x - margin, y: inp.y };
    const router = new OrthoRouter({ margin, bendPenalty: 40 });
    router.build([source, target], [out, frameOut, frameIn, inp]);
    return router.routeConnector(out, out, frameOut, frameIn, inp, inp);
  };

  const left = route(
    { x: 7453.141169896629, y: 1620.6679489714559, w: 240, h: 100 },
    { x: 7600, y: 1430, w: 300, h: 420 },
  );
  assert.deepEqual(left.slice(1, 4), [
    { x: 7709.141169896629, y: 1655.6679489714559 },
    { x: 7709.141169896629, y: 1604.6679489714559 },
    { x: 7584, y: 1604.6679489714559 },
  ]);

  const right = route(
    { x: 8138.5991586569835, y: 1621.8030956659554, w: 240, h: 100 },
    { x: 8110, y: 1430, w: 300, h: 420 },
  );
  assert.deepEqual(right.slice(1, 3), [
    { x: 8394.599158656983, y: 1656.8030956659554 },
    { x: 8426, y: 1656.8030956659554 },
  ]);
});

test("t03 margin-only contact does not force comparer links around the clearance chain", () => {
  const rects = [
    { x: 6878.083509111058, y: 1852.4612555417975, w: 270, h: 143.59375 },
    { x: 7178.083509111058, y: 1422.4612555417975, w: 270, h: 143.59375 },
    { x: 7178.083509111058, y: 1582.4612555417975, w: 270, h: 79.59375 },
    { x: 7476.357033850198, y: 1012.3254680542008, w: 350, h: 1090 },
    { x: 7178.083509111058, y: 1692.4612555417975, w: 270, h: 1438.796875 },
    { x: 7471.7112621111855, y: 2152.4612555417975, w: 380, h: 600 },
  ];
  const before = {
    out: { x: 7148.083509111058, y: 1887.4612555417975 },
    frameOut: { x: 7164.083509111058, y: 1887.4612555417975 },
    frameIn: { x: 7455.7112621111855, y: 2187.4612555417975 },
    inp: { x: 7471.7112621111855, y: 2187.4612555417975 },
  };
  const after = {
    out: { x: 7826.357033850198, y: 1047.3254680542008 },
    frameOut: { x: 7842.357033850198, y: 1047.3254680542008 },
    frameIn: { x: 7455.7112621111855, y: 2207.4612555417975 },
    inp: { x: 7471.7112621111855, y: 2207.4612555417975 },
  };
  const router = new OrthoRouter({ margin: 16, bendPenalty: 40 });
  router.build(rects, [...Object.values(before), ...Object.values(after)]);
  const route = (e) =>
    router.routeConnector(e.out, e.out, e.frameOut, e.frameIn, e.inp, e.inp);

  const beforePath = route(before);
  assert.ok(Math.min(...beforePath.map((p) => p.y)) > 1600, "must not chain up to y=1406");

  const afterPath = route(after);
  assert.ok(afterPath.every((p) => p.y >= after.out.y), "must use the lower gap, not loop above USDU");
  assert.ok(afterPath.some((p) => Math.abs(p.y - 2136.4612555417975) < 0.01));
});
