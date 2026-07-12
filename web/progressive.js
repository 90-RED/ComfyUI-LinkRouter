// Pure helpers for spreading expensive connector searches over multiple frames.

// Small/medium route sets are cheaper and look much better when they appear
// together. Progressive reveal is reserved for genuinely large updates.
export const PROGRESSIVE_ROUTE_THRESHOLD = 16;

export function shouldProgressivelyRoute(dragging, forceSync, jobCount) {
  return !dragging && !forceSync && jobCount >= PROGRESSIVE_ROUTE_THRESHOLD;
}

export function progressiveItemLimit(total, percent) {
  const pct = Math.max(1, Math.min(100, +percent || 10));
  return Math.max(1, Math.ceil(total * pct / 100));
}

export function processRouteSlice(batch, routeOne, options = {}) {
  const now = options.now || (() => performance.now());
  const maxItems = options.maxItems ?? Infinity;
  const budgetMs = options.budgetMs ?? Infinity;
  const started = now();
  let processed = 0;

  while (batch.index < batch.jobs.length && processed < maxItems) {
    const job = batch.jobs[batch.index++];
    const result = routeOne(job);
    if (result) batch.resultsById.set(job.entry.link.id, result);
    processed++;
    if (processed > 0 && now() - started >= budgetMs) break;
  }
  return {
    processed,
    done: batch.index >= batch.jobs.length,
    remaining: batch.jobs.length - batch.index,
  };
}

export function orderedRouteResults(entries, resultsById) {
  const out = [];
  for (const entry of entries) {
    const result = resultsById.get(entry.link.id);
    if (result) out.push(result);
  }
  return out;
}
