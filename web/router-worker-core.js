// router-worker-core.js — engine behind the router worker, written so the
// exact same code can run inside a DedicatedWorker (router-worker.js) and
// under plain Node with a mock post() for protocol/fidelity testing.
//
// Protocol (main -> worker):
//   { type:"route", jobRev, graphRev, configKey, margin, bendPenalty,
//     rects: Float64Array [x,y,w,h,...], terminals: Float64Array [x,y,...],
//     jobs: [{ id, endsKey, oldPts: Float32Array|null, opts: object|null,
//              pts: [out.x,out.y, bodyOut.x,bodyOut.y, stubOut.x,stubOut.y,
//                    stubIn.x,stubIn.y, bodyIn.x,bodyIn.y, inp.x,inp.y] }] }
//   (opts is null for stable exact routes; held-pause jobs pass the same
//    {weight, popsBudget} the main-thread drag drain uses)
//   { type:"cancel" }
// Protocol (worker -> main):
//   { type:"result", jobRev, id, ok, sticky, buf: Float32Array|null, stats, ms }
//   { type:"done", jobRev }
//   { type:"error", jobRev, message }
//
// Work is chunked (CHUNK_MS per macrotask) so "cancel" and newer "route"
// messages are handled promptly; newest route always wins.

import { OrthoRouter } from "./router.js";
import { stretchPathPure } from "./stretch.js";

const CHUNK_MS = 8;

export function createEngine(post, now = () => performance.now()) {
  let router = null;
  let configKey = null;
  let builtGraphRev = null;
  let pending = null; // newest "route" message wins
  let cancelRequested = false;
  let pumping = false;

  const yieldTask = () => new Promise((r) => setTimeout(r, 0));

  function toPts(buf) {
    const pts = [];
    for (let i = 0; i < buf.length; i += 2) pts.push({ x: buf[i], y: buf[i + 1] });
    return pts;
  }

  function ensureBuild(msg) {
    if (!router || configKey !== msg.configKey) {
      router = new OrthoRouter({ margin: msg.margin, bendPenalty: msg.bendPenalty });
      configKey = msg.configKey;
      builtGraphRev = null;
    }
    if (builtGraphRev !== msg.graphRev) {
      const rawRects = [];
      for (let i = 0; i < msg.rects.length; i += 4)
        rawRects.push({ x: msg.rects[i], y: msg.rects[i + 1], w: msg.rects[i + 2], h: msg.rects[i + 3] });
      const terminals = [];
      for (let i = 0; i < msg.terminals.length; i += 2)
        terminals.push({ x: msg.terminals[i], y: msg.terminals[i + 1] });
      router.build(rawRects, terminals);
      builtGraphRev = msg.graphRev;
    }
  }

  function routeOne(j) {
    const ep = {
      out: { x: j.pts[0], y: j.pts[1] },
      bodyOut: { x: j.pts[2], y: j.pts[3] },
      stubOut: { x: j.pts[4], y: j.pts[5] },
      stubIn: { x: j.pts[6], y: j.pts[7] },
      bodyIn: { x: j.pts[8], y: j.pts[9] },
      inp: { x: j.pts[10], y: j.pts[11] },
    };
    // No opts by default: exact search, identical to the main-thread stable
    // path. Held-pause jobs carry their own opts ({weight, popsBudget}) so
    // they stay bit-identical to the main-thread drag drain instead.
    let pts = router.routeConnector(
      ep.out, ep.bodyOut, ep.stubOut, ep.stubIn, ep.bodyIn, ep.inp,
      j.opts || undefined,
    );
    const st = router.lastStats || { pops: 0, level: 0, simple: 0, weight: 1 };
    const stats = { pops: st.pops, level: st.level, simple: st.simple, weight: st.weight };
    let sticky = false;
    if (!pts && j.oldPts) {
      // Failure degrade, worker side: keep the last legal path, stretched.
      pts = stretchPathPure(router, toPts(j.oldPts), ep);
      if (pts) sticky = true;
    }
    let buf = null;
    if (pts) {
      // Float64 (not Float32): routes stay bit-identical to the sync path.
      buf = new Float64Array(pts.length * 2);
      for (let k = 0; k < pts.length; k++) {
        buf[2 * k] = pts[k].x;
        buf[2 * k + 1] = pts[k].y;
      }
    }
    return { buf, sticky, stats };
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (pending) {
        const job = pending;
        pending = null;
        cancelRequested = false;
        try {
          ensureBuild(job);
        } catch (e) {
          post({ type: "error", jobRev: job.jobRev, message: String(e?.message || e) });
          continue;
        }
        let i = 0;
        let chunkStart = now();
        while (i < job.jobs.length && !cancelRequested && !pending) {
          const j = job.jobs[i++];
          const started = now();
          let out;
          try {
            out = routeOne(j);
          } catch (e) {
            post({ type: "error", jobRev: job.jobRev, message: String(e?.message || e) });
            break;
          }
          const ms = now() - started;
          const msg = {
            type: "result",
            jobRev: job.jobRev,
            id: j.id,
            ok: !!out.buf,
            sticky: out.sticky,
            buf: out.buf,
            stats: out.stats,
            ms,
          };
          post(msg, out.buf ? [out.buf.buffer] : undefined);
          if (now() - chunkStart >= CHUNK_MS) {
            await yieldTask();
            chunkStart = now();
          }
        }
        // A fully processed job reports done even if a cancel/newer job
        // arrived meanwhile — the main side keys everything by jobRev.
        if (i >= job.jobs.length) post({ type: "done", jobRev: job.jobRev });
      }
    } finally {
      pumping = false;
      if (pending) setTimeout(pump, 0);
    }
  }

  return {
    handleMessage(msg) {
      if (!msg) return;
      if (msg.type === "route") {
        pending = msg;
        pump();
      } else if (msg.type === "cancel") {
        cancelRequested = true;
        pending = null;
      }
    },
  };
}
