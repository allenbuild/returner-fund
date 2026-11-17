/**
 * One offline build lifetime, explicitly bound to its rankability/key functions.
 * Arrays AND their row contents must remain unchanged while cached. A caller
 * that mutates either must invalidate that array or create a fresh scope.
 * Returned Maps are read-only by contract; sortedKeys always returns a copy.
 * No path/global/process cache or source-file freshness assumption is made.
 */
export function createRankedPostsPhysicalMapCache({ rankableEvidence, canonicalPostKey }) {
  if (typeof rankableEvidence !== "function" || typeof canonicalPostKey !== "function") {
    throw new TypeError("Scoped Ranked Posts cache requires explicit rankability and physical-key functions.");
  }
  let entries = new WeakMap();
  let closed = false;
  let computations = 0, reuses = 0, keySorts = 0, invalidations = 0;
  const entryFor = ({ evidence, label }) => {
    if (closed) throw new Error("Scoped Ranked Posts physical-map cache is closed.");
    if (!Array.isArray(evidence)) throw new TypeError("Scoped Ranked Posts cache requires an evidence array.");
    const existing = entries.get(evidence);
    if (existing) { reuses++; return existing; }
    const byKey = new Map();
    for (const item of rankableEvidence(evidence)) {
      const key = canonicalPostKey(item);
      if (typeof key !== "string" || key.length === 0) {
        throw new Error(`Ranked Posts ${label} emitted an empty canonical physical-post key.`);
      }
      if (byKey.has(key)) {
        throw new Error(`Ranked Posts ${label} rankability contract returned duplicate physical key ${key}.`);
      }
      byKey.set(key, item);
    }
    const entry = { byKey, sorted: null };
    entries.set(evidence, entry); computations++;
    return entry;
  };
  return {
    physicalMap: (input) => entryFor(input).byKey,
    sortedKeys(input) {
      const entry = entryFor(input);
      if (!entry.sorted) { entry.sorted = [...entry.byKey.keys()].sort(); keySorts++; }
      return [...entry.sorted];
    },
    invalidate(evidence) {
      if (closed) throw new Error("Scoped Ranked Posts physical-map cache is closed.");
      const removed = entries.delete(evidence);
      if (removed) invalidations++;
      return removed;
    },
    stats: () => ({ computations, reuses, keySorts, invalidations, closed }),
    close() { closed = true; entries = new WeakMap(); },
  };
}
