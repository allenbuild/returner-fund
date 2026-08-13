import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRankedPostsSidecarLoaderCache,
  isRankedPostsSidecarSnapshot,
  loadRankedPostsSidecarForGraph,
  rankedPostsSidecarLoaderCacheEntryCount,
  rankedPostsSidecarLoaderInFlightCount,
  RANKED_POSTS_SIDECAR_CACHE_MAX_ENTRIES,
  RANKED_POSTS_SIDECAR_IN_FLIGHT_MAX_ENTRIES,
  RANKED_POSTS_SIDECAR_MAX_EVIDENCE_ROWS,
  type TopVoiceAudienceId,
  type RankedPostsGraphTarget
} from "@/lib/graph/ranked-posts-sidecar-loader";
import {
  rankedPostsSidecarSnapshot,
  type RankedPostsSidecarSnapshot
} from "@/lib/graph/ranked-posts-sidecar";

describe("ranked posts sidecar loader", () => {
  beforeEach(() => {
    clearRankedPostsSidecarLoaderCache();
  });

  it("uses the bundled scope without a request when its timestamp matches the graph", async () => {
    const generatedAt = rankedPostsSidecarSnapshot.batches.S26.off!.previewGeneratedAt;
    const fetchImpl = vi.fn<typeof fetch>();

    const scope = await loadRankedPostsSidecarForGraph(graphTarget(generatedAt), { fetchImpl });

    expect(scope.previewGeneratedAt).toBe(generatedAt);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches and accepts one current server snapshot when the bundled timestamp is stale", async () => {
    const generatedAt = "2031-04-15T12:00:00.000Z";
    const remote = snapshotWithScopeTimestamp(generatedAt);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(remote), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));

    const scope = await loadRankedPostsSidecarForGraph(graphTarget(generatedAt), { fetchImpl });

    expect(scope.previewGeneratedAt).toBe(generatedAt);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent stale-sidecar requests", async () => {
    const generatedAt = "2031-04-15T12:00:00.000Z";
    const remote = snapshotWithScopeTimestamp(generatedAt);
    let resolveResponse!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise((resolve) => {
      resolveResponse = resolve;
    }));

    const first = loadRankedPostsSidecarForGraph(graphTarget(generatedAt), { fetchImpl });
    const second = loadRankedPostsSidecarForGraph(graphTarget(generatedAt), { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    resolveResponse(new Response(JSON.stringify(remote), { status: 200 }));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("refetches when the graph timestamp advances during one page lifetime", async () => {
    const firstGeneratedAt = "2031-04-15T12:00:00.000Z";
    const secondGeneratedAt = "2031-04-15T13:00:00.000Z";
    let requestCount = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      requestCount += 1;
      const generatedAt = requestCount === 1 ? firstGeneratedAt : secondGeneratedAt;
      return new Response(JSON.stringify(snapshotWithScopeTimestamp(generatedAt)), {
        status: 200,
        headers: { "cache-control": "no-store" }
      });
    });

    await expect(loadRankedPostsSidecarForGraph(graphTarget(firstGeneratedAt), { fetchImpl }))
      .resolves.toMatchObject({ previewGeneratedAt: firstGeneratedAt });
    await expect(loadRankedPostsSidecarForGraph(graphTarget(secondGeneratedAt), { fetchImpl }))
      .resolves.toMatchObject({ previewGeneratedAt: secondGeneratedAt });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toMatch(/\/api\/ranked-posts-sidecar\?v=.*&refresh=/);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toMatch(/\/api\/ranked-posts-sidecar\?v=.*&refresh=/);
  });

  it("keeps only the latest completed snapshot for a scope", async () => {
    const firstGeneratedAt = "2031-04-15T12:00:00.000Z";
    const secondGeneratedAt = "2031-04-15T13:00:00.000Z";
    let requestCount = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      requestCount += 1;
      const generatedAt = requestCount === 2 ? secondGeneratedAt : firstGeneratedAt;
      return new Response(JSON.stringify(snapshotWithScopeTimestamp(generatedAt)), { status: 200 });
    });

    await expect(loadRankedPostsSidecarForGraph(graphTarget(firstGeneratedAt), { fetchImpl }))
      .resolves.toMatchObject({ previewGeneratedAt: firstGeneratedAt });
    await expect(loadRankedPostsSidecarForGraph(graphTarget(secondGeneratedAt), { fetchImpl }))
      .resolves.toMatchObject({ previewGeneratedAt: secondGeneratedAt });

    // The first timestamp is no longer retained after the newer publication.
    // It must be fetched again instead of being served from an unbounded
    // timestamp-keyed cache.
    await expect(loadRankedPostsSidecarForGraph(graphTarget(firstGeneratedAt), { fetchImpl }))
      .resolves.toMatchObject({ previewGeneratedAt: firstGeneratedAt });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(rankedPostsSidecarLoaderCacheEntryCount()).toBe(1);
  });

  it.each([
    ["shared", false],
    ["signal-bearing", true]
  ])("does not cache mismatched %s responses", async (_label, signalBearing) => {
    for (let index = 0; index < RANKED_POSTS_SIDECAR_CACHE_MAX_ENTRIES + 3; index += 1) {
      const generatedAt = new Date(Date.UTC(2031, 3, 15, 12, index)).toISOString();
      const wrongGeneratedAt = new Date(Date.UTC(2031, 3, 15, 13, index)).toISOString();
      const options = {
        fetchImpl: vi.fn<typeof fetch>(async () =>
          new Response(JSON.stringify(snapshotWithScopeTimestamp(wrongGeneratedAt)))),
        ...(signalBearing ? { signal: new AbortController().signal } : {})
      };

      await expect(loadRankedPostsSidecarForGraph(graphTarget(generatedAt), options))
        .rejects.toThrow("does not match");
      expect(rankedPostsSidecarLoaderCacheEntryCount()).toBe(0);
    }
  });

  it("globally bounds valid signal-bearing snapshots by batch and audience", async () => {
    for (let index = 0; index < RANKED_POSTS_SIDECAR_CACHE_MAX_ENTRIES + 3; index += 1) {
      const batchSlug = `CACHE${index}`;
      const generatedAt = new Date(Date.UTC(2031, 3, 15, 12, index)).toISOString();
      await expect(loadRankedPostsSidecarForGraph(graphTarget(generatedAt, batchSlug), {
        fetchImpl: vi.fn<typeof fetch>(async () =>
          new Response(JSON.stringify(snapshotWithScopeTimestamp(generatedAt, batchSlug)))),
        signal: new AbortController().signal
      })).resolves.toMatchObject({ previewGeneratedAt: generatedAt });
      expect(rankedPostsSidecarLoaderCacheEntryCount()).toBe(
        Math.min(index + 1, RANKED_POSTS_SIDECAR_CACHE_MAX_ENTRIES)
      );
    }
  });

  it.each([
    ["shared", false],
    ["signal-bearing", true]
  ])("does not let a stale concurrent %s response overwrite a newer publication", async (_label, signalBearing) => {
    const oldGeneratedAt = "2031-04-15T12:00:00.000Z";
    const newGeneratedAt = "2031-04-15T13:00:00.000Z";
    let resolveOld!: (response: Response) => void;
    let requestCount = 0;
    const fetchImpl = vi.fn<typeof fetch>(() => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      }
      return Promise.resolve(new Response(JSON.stringify(snapshotWithScopeTimestamp(newGeneratedAt))));
    });
    const requestOptions = () => ({
      fetchImpl,
      ...(signalBearing ? { signal: new AbortController().signal } : {})
    });

    const oldRequest = loadRankedPostsSidecarForGraph(graphTarget(oldGeneratedAt), requestOptions());
    await expect(loadRankedPostsSidecarForGraph(graphTarget(newGeneratedAt), requestOptions()))
      .resolves.toMatchObject({ previewGeneratedAt: newGeneratedAt });
    resolveOld(new Response(JSON.stringify(snapshotWithScopeTimestamp(oldGeneratedAt))));
    await expect(oldRequest).resolves.toMatchObject({ previewGeneratedAt: oldGeneratedAt });

    const cachedFetch = vi.fn<typeof fetch>();
    await expect(loadRankedPostsSidecarForGraph(graphTarget(newGeneratedAt), { fetchImpl: cachedFetch }))
      .resolves.toMatchObject({ previewGeneratedAt: newGeneratedAt });
    expect(cachedFetch).not.toHaveBeenCalled();
    expect(rankedPostsSidecarLoaderCacheEntryCount()).toBe(1);
  });

  it("isolates aborts between signal-bearing callers for the same target", async () => {
    const generatedAt = "2031-04-15T12:00:00.000Z";
    const firstController = new AbortController();
    const secondController = new AbortController();
    let requestCount = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      requestCount += 1;
      if (requestCount === 1) {
        await new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          );
        });
      }
      return new Response(JSON.stringify(snapshotWithScopeTimestamp(generatedAt)));
    });

    const first = loadRankedPostsSidecarForGraph(graphTarget(generatedAt), {
      fetchImpl,
      signal: firstController.signal
    });
    const second = loadRankedPostsSidecarForGraph(graphTarget(generatedAt), {
      fetchImpl,
      signal: secondController.signal
    });
    firstController.abort();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toMatchObject({ previewGeneratedAt: generatedAt });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(rankedPostsSidecarLoaderCacheEntryCount()).toBe(1);
  });

  it("globally bounds active requests during rapid signal-bearing scope churn", async () => {
    const controllers: AbortController[] = [];
    const requests: Promise<unknown>[] = [];
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      const rejectAbort = () => reject(new DOMException("Aborted", "AbortError"));
      if (!signal) {
        reject(new Error("Expected an abort signal."));
      } else if (signal.aborted) {
        rejectAbort();
      } else {
        signal.addEventListener("abort", rejectAbort, { once: true });
      }
    }));

    for (let index = 0; index < RANKED_POSTS_SIDECAR_IN_FLIGHT_MAX_ENTRIES + 3; index += 1) {
      const controller = new AbortController();
      controllers.push(controller);
      const generatedAt = new Date(Date.UTC(2031, 3, 15, 12, index)).toISOString();
      requests.push(loadRankedPostsSidecarForGraph(graphTarget(generatedAt, `CHURN${index}`), {
        fetchImpl,
        signal: controller.signal
      }).catch((error: unknown) => error));
      expect(rankedPostsSidecarLoaderInFlightCount())
        .toBeLessThanOrEqual(RANKED_POSTS_SIDECAR_IN_FLIGHT_MAX_ENTRIES);
    }

    expect(rankedPostsSidecarLoaderInFlightCount()).toBe(RANKED_POSTS_SIDECAR_IN_FLIGHT_MAX_ENTRIES);
    controllers.forEach((controller) => controller.abort());
    expect(rankedPostsSidecarLoaderInFlightCount()).toBe(0);
    await Promise.all(requests);
  });

  it("promptly removes a globally canceled shared request from keyed dedupe", async () => {
    const generatedAt = "2031-04-15T12:00:00.000Z";
    const pendingRequests: Promise<unknown>[] = [];
    const pressureControllers: AbortController[] = [];
    const hangingFetch = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const rejectAbort = () => reject(new DOMException("Aborted", "AbortError"));
      if (init?.signal?.aborted) rejectAbort();
      else init?.signal?.addEventListener("abort", rejectAbort, { once: true });
    }));
    pendingRequests.push(loadRankedPostsSidecarForGraph(graphTarget(generatedAt), {
      fetchImpl: hangingFetch
    }).catch((error: unknown) => error));

    for (let index = 0; index < RANKED_POSTS_SIDECAR_IN_FLIGHT_MAX_ENTRIES; index += 1) {
      const controller = new AbortController();
      pressureControllers.push(controller);
      const pressureTimestamp = new Date(Date.UTC(2031, 3, 16, 12, index)).toISOString();
      pendingRequests.push(loadRankedPostsSidecarForGraph(graphTarget(pressureTimestamp, `PRESSURE${index}`), {
        fetchImpl: hangingFetch,
        signal: controller.signal
      }).catch((error: unknown) => error));
    }

    const freshFetch = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(snapshotWithScopeTimestamp(generatedAt))));
    await expect(loadRankedPostsSidecarForGraph(graphTarget(generatedAt), { fetchImpl: freshFetch }))
      .resolves.toMatchObject({ previewGeneratedAt: generatedAt });
    expect(freshFetch).toHaveBeenCalledTimes(1);

    pressureControllers.forEach((controller) => controller.abort());
    clearRankedPostsSidecarLoaderCache();
    await Promise.all(pendingRequests);
    expect(rankedPostsSidecarLoaderInFlightCount()).toBe(0);
  });

  it("rejects a late response after its signal-bearing caller has aborted", async () => {
    const generatedAt = "2031-04-15T12:00:00.000Z";
    const controller = new AbortController();
    let resolveResponse!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise((resolve) => {
      resolveResponse = resolve;
    }));

    const request = loadRankedPostsSidecarForGraph(graphTarget(generatedAt), {
      fetchImpl,
      signal: controller.signal
    });
    controller.abort();
    expect(rankedPostsSidecarLoaderInFlightCount()).toBe(0);
    resolveResponse(new Response(JSON.stringify(snapshotWithScopeTimestamp(generatedAt))));

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(rankedPostsSidecarLoaderCacheEntryCount()).toBe(0);
  });

  it("rejects invalid timestamps and a server snapshot for the wrong graph scope", async () => {
    const generatedAt = "2031-04-15T12:00:00.000Z";
    const invalidTimestamp = snapshotWithScopeTimestamp("2031-04-15T12:00:00Z");
    const invalidFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(invalidTimestamp)));
    await expect(loadRankedPostsSidecarForGraph(graphTarget(generatedAt), { fetchImpl: invalidFetch }))
      .rejects.toThrow("failed validation");

    clearRankedPostsSidecarLoaderCache();
    const wrongScope = snapshotWithScopeTimestamp(generatedAt);
    wrongScope.batches.S26.off = undefined;
    const wrongScopeFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(wrongScope)));
    await expect(loadRankedPostsSidecarForGraph(graphTarget(generatedAt), { fetchImpl: wrongScopeFetch }))
      .rejects.toThrow("does not match");
  });

  it("validates the sidecar envelope before accepting it", () => {
    expect(isRankedPostsSidecarSnapshot(rankedPostsSidecarSnapshot)).toBe(true);
    expect(isRankedPostsSidecarSnapshot({
      ...rankedPostsSidecarSnapshot,
      generatedAt: "not-a-timestamp"
    })).toBe(false);
  });

  it("rejects missing scope metadata and malformed evidence rows before caching", async () => {
    const generatedAt = "2031-04-15T12:00:00.000Z";
    const missingMetadata = snapshotWithScopeTimestamp(generatedAt);
    delete (missingMetadata.batches.S26.off as unknown as Record<string, unknown>).sourceEvidenceCount;
    expect(isRankedPostsSidecarSnapshot(missingMetadata)).toBe(false);

    const malformedEvidence = snapshotWithScopeTimestamp(generatedAt);
    const malformedRow = malformedEvidence.batches.S2026.off!.evidence[0]!;
    delete (malformedRow as unknown as Record<string, unknown>).id;
    expect(isRankedPostsSidecarSnapshot(malformedEvidence)).toBe(false);

    const malformedClassification = snapshotWithScopeTimestamp(generatedAt);
    const classifiedRow = malformedClassification.batches.S2026.off!.evidence[0]!;
    (classifiedRow as unknown as Record<string, unknown>).topicClassification = {
      topics: ["product-launch"]
    };
    expect(isRankedPostsSidecarSnapshot(malformedClassification)).toBe(false);

    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(malformedEvidence), { status: 200 }));
    await expect(loadRankedPostsSidecarForGraph(graphTarget(generatedAt), { fetchImpl }))
      .rejects.toThrow("failed validation");
    expect(rankedPostsSidecarLoaderCacheEntryCount()).toBe(0);
  });

  it("rejects oversized evidence arrays before inspecting or caching their rows", () => {
    const oversized = snapshotWithScopeTimestamp("2031-04-15T12:00:00.000Z");
    const scope = oversized.batches.S2026.off!;
    const validRow = scope.evidence[0]!;
    scope.evidence = Array.from(
      { length: RANKED_POSTS_SIDECAR_MAX_EVIDENCE_ROWS + 1 },
      () => validRow
    );

    expect(isRankedPostsSidecarSnapshot(oversized)).toBe(false);
    expect(rankedPostsSidecarLoaderCacheEntryCount()).toBe(0);
  });
});

function graphTarget(
  generatedAt: string,
  batchSlug = "S26",
  audienceId: TopVoiceAudienceId = "off"
): RankedPostsGraphTarget {
  return {
    batch: { slug: batchSlug },
    generatedAt,
    selectedTopVoiceAudience: { id: audienceId }
  };
}

function snapshotWithScopeTimestamp(
  generatedAt: string,
  batchSlug = "S26",
  audienceId: TopVoiceAudienceId = "off"
): RankedPostsSidecarSnapshot {
  const snapshot = JSON.parse(JSON.stringify(rankedPostsSidecarSnapshot)) as RankedPostsSidecarSnapshot;
  const template = snapshot.batches.S26.off!;
  snapshot.generatedAt = generatedAt;
  snapshot.batches[batchSlug] = {
    ...(snapshot.batches[batchSlug] ?? {}),
    [audienceId]: {
      ...template,
      previewGeneratedAt: generatedAt
    }
  };
  return snapshot;
}
