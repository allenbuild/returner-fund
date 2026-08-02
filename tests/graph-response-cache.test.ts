import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearGraphResponseCache,
  getOrBuildCachedGraphResponse,
  type GraphResponseCacheScope
} from "@/lib/graph/graph-response-cache";
import type { GraphResponse } from "@/lib/graph/types";

const TTL_MS = 60_000;
const springOff = scope("S2026", "off");
const springInsiders = scope("S2026", "insiders");
const speedrunOff = scope("A16ZSR006", "off");
const xFilterKey = JSON.stringify({ filters: { platforms: ["x"] }, includeWhy: false });
const githubFilterKey = JSON.stringify({ filters: { platforms: ["github"] }, includeWhy: false });

describe("graph response cache", () => {
  beforeEach(() => {
    clearGraphResponseCache();
  });

  afterEach(() => {
    clearGraphResponseCache();
    vi.restoreAllMocks();
  });

  it("coalesces only identical concurrent response identities", async () => {
    const identicalBuild = vi.fn(async () => taggedGraph("spring-off-x"));
    const differentFilterBuild = vi.fn(async () => taggedGraph("spring-off-github"));
    const differentBatchBuild = vi.fn(async () => taggedGraph("speedrun-off-x"));
    const differentAudienceBuild = vi.fn(async () => taggedGraph("spring-insiders-x"));

    const results = await Promise.all([
      getOrBuild(xFilterKey, springOff, identicalBuild),
      getOrBuild(xFilterKey, springOff, identicalBuild),
      getOrBuild(githubFilterKey, springOff, differentFilterBuild),
      getOrBuild(xFilterKey, speedrunOff, differentBatchBuild),
      getOrBuild(xFilterKey, springInsiders, differentAudienceBuild)
    ]);

    expect(identicalBuild).toHaveBeenCalledTimes(1);
    expect(differentFilterBuild).toHaveBeenCalledTimes(1);
    expect(differentBatchBuild).toHaveBeenCalledTimes(1);
    expect(differentAudienceBuild).toHaveBeenCalledTimes(1);
    expect(results.map(graphTag)).toEqual([
      "spring-off-x",
      "spring-off-x",
      "spring-off-github",
      "speedrun-off-x",
      "spring-insiders-x"
    ]);

    const unexpectedBuild = vi.fn(() => taggedGraph("unexpected"));
    expect(graphTag(await getOrBuild(xFilterKey, springOff, unexpectedBuild))).toBe("spring-off-x");
    expect(unexpectedBuild).not.toHaveBeenCalled();
  });

  it("invalidates all filter variants in only the selected batch and audience scope", async () => {
    await Promise.all([
      getOrBuild(xFilterKey, springOff, () => taggedGraph("spring-off-x-v1")),
      getOrBuild(githubFilterKey, springOff, () => taggedGraph("spring-off-github-v1")),
      getOrBuild(xFilterKey, springInsiders, () => taggedGraph("spring-insiders-x-v1")),
      getOrBuild(xFilterKey, speedrunOff, () => taggedGraph("speedrun-off-x-v1"))
    ]);

    clearGraphResponseCache({ batchSlug: "S2026", topVoices: "off" });

    const rebuildX = vi.fn(() => taggedGraph("spring-off-x-v2"));
    const rebuildGithub = vi.fn(() => taggedGraph("spring-off-github-v2"));
    const rebuildInsiders = vi.fn(() => taggedGraph("spring-insiders-x-v2"));
    const rebuildSpeedrun = vi.fn(() => taggedGraph("speedrun-off-x-v2"));
    expect(graphTag(await getOrBuild(xFilterKey, springOff, rebuildX))).toBe("spring-off-x-v2");
    expect(graphTag(await getOrBuild(githubFilterKey, springOff, rebuildGithub))).toBe(
      "spring-off-github-v2"
    );
    expect(graphTag(await getOrBuild(xFilterKey, springInsiders, rebuildInsiders))).toBe(
      "spring-insiders-x-v1"
    );
    expect(graphTag(await getOrBuild(xFilterKey, speedrunOff, rebuildSpeedrun))).toBe(
      "speedrun-off-x-v1"
    );
    expect(rebuildX).toHaveBeenCalledTimes(1);
    expect(rebuildGithub).toHaveBeenCalledTimes(1);
    expect(rebuildInsiders).not.toHaveBeenCalled();
    expect(rebuildSpeedrun).not.toHaveBeenCalled();

    clearGraphResponseCache({ batchSlug: "S2026" });
    expect(graphTag(await getOrBuild(xFilterKey, springInsiders, rebuildInsiders))).toBe(
      "spring-insiders-x-v2"
    );
    expect(graphTag(await getOrBuild(xFilterKey, speedrunOff, rebuildSpeedrun))).toBe(
      "speedrun-off-x-v1"
    );
    expect(rebuildInsiders).toHaveBeenCalledTimes(1);
    expect(rebuildSpeedrun).not.toHaveBeenCalled();
  });

  it("does not let an invalidated flight repopulate cache or remove its replacement", async () => {
    const stale = deferred<GraphResponse>();
    const replacement = deferred<GraphResponse>();
    const staleBuild = vi.fn(() => stale.promise);
    const replacementBuild = vi.fn(() => replacement.promise);

    const staleRequest = getOrBuild(xFilterKey, springOff, staleBuild);
    await Promise.resolve();
    expect(staleBuild).toHaveBeenCalledTimes(1);

    clearGraphResponseCache({ batchSlug: "S2026", topVoices: "off" });
    const replacementRequest = getOrBuild(xFilterKey, springOff, replacementBuild);
    await Promise.resolve();
    expect(replacementBuild).toHaveBeenCalledTimes(1);

    stale.resolve(taggedGraph("stale"));
    expect(graphTag(await staleRequest)).toBe("stale");

    const unexpectedBuild = vi.fn(() => taggedGraph("unexpected"));
    const joinedReplacement = getOrBuild(xFilterKey, springOff, unexpectedBuild);
    await Promise.resolve();
    expect(unexpectedBuild).not.toHaveBeenCalled();

    replacement.resolve(taggedGraph("replacement"));
    const replacementResults = await Promise.all([replacementRequest, joinedReplacement]);
    expect(replacementResults.map(graphTag)).toEqual(["replacement", "replacement"]);

    expect(graphTag(await getOrBuild(xFilterKey, springOff, unexpectedBuild))).toBe("replacement");
    expect(unexpectedBuild).not.toHaveBeenCalled();
  });

  it("clears a rejected shared flight so the next request can retry", async () => {
    const failure = new Error("cold build failed");
    const failingBuild = vi.fn(async () => {
      throw failure;
    });

    const first = getOrBuild(xFilterKey, springOff, failingBuild);
    const second = getOrBuild(xFilterKey, springOff, failingBuild);
    const settled = await Promise.allSettled([first, second]);

    expect(failingBuild).toHaveBeenCalledTimes(1);
    expect(settled).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure }
    ]);

    const retryBuild = vi.fn(() => taggedGraph("retry"));
    expect(graphTag(await getOrBuild(xFilterKey, springOff, retryBuild))).toBe("retry");
    expect(retryBuild).toHaveBeenCalledTimes(1);
  });

  it("can coalesce a build without retaining the completed graph", async () => {
    const build = vi.fn(async () => taggedGraph("diagnostic"));
    const options = {
      cacheKey: xFilterKey,
      ttlMs: TTL_MS,
      scope: springOff,
      retainResult: false,
      build
    };

    const firstPair = await Promise.all([
      getOrBuildCachedGraphResponse(options),
      getOrBuildCachedGraphResponse(options)
    ]);
    expect(firstPair.map(graphTag)).toEqual(["diagnostic", "diagnostic"]);
    expect(build).toHaveBeenCalledTimes(1);

    await getOrBuildCachedGraphResponse(options);
    expect(build).toHaveBeenCalledTimes(2);
  });
});

function getOrBuild(
  cacheKey: string,
  cacheScope: GraphResponseCacheScope,
  build: () => GraphResponse | Promise<GraphResponse>
): Promise<GraphResponse> {
  return getOrBuildCachedGraphResponse({
    cacheKey,
    ttlMs: TTL_MS,
    scope: cacheScope,
    build
  });
}

function scope(
  batchSlug: string,
  topVoices: GraphResponseCacheScope["topVoices"]
): GraphResponseCacheScope {
  return { batchSlug, topVoices };
}

function taggedGraph(tag: string): GraphResponse {
  return { cacheTestTag: tag } as unknown as GraphResponse;
}

function graphTag(graph: GraphResponse): string {
  return (graph as GraphResponse & { cacheTestTag: string }).cacheTestTag;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
