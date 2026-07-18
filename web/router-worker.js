// router-worker.js — DedicatedWorker entry (module worker). All logic lives
// in router-worker-core.js so it can also run under Node for testing.

import { createEngine } from "./router-worker-core.js";

// Guarded so an accidental import outside a Worker (tests, bundlers) is inert.
if (typeof globalThis.postMessage === "function") {
  const engine = createEngine((msg, transfer) =>
    globalThis.postMessage(msg, transfer),
  );
  globalThis.onmessage = (ev) => engine.handleMessage(ev.data);
}
