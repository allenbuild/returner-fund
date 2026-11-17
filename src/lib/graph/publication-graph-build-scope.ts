import { AsyncLocalStorage } from "node:async_hooks";
import type { GraphResponse } from "./types";

interface PublicationBuildState {
  closed: boolean;
  bases: Map<string, GraphResponse>;
  builds: number;
  reuses: number;
}
const storage = new AsyncLocalStorage<PublicationBuildState>();

/** An explicit publisher lifetime; ordinary diagnostic requests have no scope. */
export function createPublicationGraphBuildScope() {
  const state: PublicationBuildState = { closed: false, bases: new Map(), builds: 0, reuses: 0 };
  return {
    run<T>(callback: () => T): T {
      if (state.closed) throw new Error("Publication graph build scope is closed.");
      return storage.run(state, callback);
    },
    stats: () => ({ baseBuilds: state.builds, baseReuses: state.reuses, retainedBases: state.bases.size }),
    close() {
      state.closed = true;
      state.bases.clear();
    }
  };
}

export function publicationCanonicalBaseGraph(key: string, build: () => GraphResponse): GraphResponse {
  const state = storage.getStore();
  if (!state || state.closed) return build();
  const existing = state.bases.get(key);
  if (existing) {
    state.reuses += 1;
    return existing;
  }
  const graph = build();
  state.builds += 1;
  // A publisher visits four cohorts serially; retain at most one base per
  // cohort, with a hard bound even if source versions change during a run.
  if (state.bases.size >= 4) state.bases.delete(state.bases.keys().next().value!);
  state.bases.set(key, graph);
  return graph;
}
