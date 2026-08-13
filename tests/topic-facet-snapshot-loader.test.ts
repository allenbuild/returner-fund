import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTopicFacetSnapshotLoaderState,
  isCurrentTopicFacetSnapshot,
  loadCurrentTopicFacetSnapshot,
  TOPIC_FACET_MAX_BYTES,
  topicFacetApiUrl
} from "@/lib/graph/topic-facet-snapshot-loader";
import { TOPIC_FACET_SNAPSHOT_VERSION } from "@/lib/graph/topic-facets";

const snapshot = {
  version: TOPIC_FACET_SNAPSHOT_VERSION,
  batchSlug: "S26",
  rowCount: 1,
  rows: [{
    topic: "product-launch",
    postKey: "x:post:1",
    platform: "x",
    companyId: "company-one",
    contributionScore: 12,
    audienceId: "off"
  }]
} as const;

describe("topic facet snapshot loader", () => {
  beforeEach(() => clearTopicFacetSnapshotLoaderState());

  it("uses a no-store, cache-busting per-batch API request", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toMatch(/^\/api\/topic-facets\/S26\?v=.*&refresh=/);
      expect(init?.cache).toBe("no-store");
      expect((init?.headers as Record<string, string>)["X-Topic-Facets-Version"])
        .toBe(TOPIC_FACET_SNAPSHOT_VERSION);
      return new Response(JSON.stringify(snapshot));
    });

    await expect(loadCurrentTopicFacetSnapshot("S26", { fetchImpl })).resolves.toEqual(snapshot);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent requests but does not retain completed responses", async () => {
    let resolveResponse!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise((resolve) => {
      resolveResponse = resolve;
    }));
    const first = loadCurrentTopicFacetSnapshot("S26", { fetchImpl });
    const second = loadCurrentTopicFacetSnapshot("S26", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveResponse(new Response(JSON.stringify(snapshot)));
    await Promise.all([first, second]);
    await loadCurrentTopicFacetSnapshot("S26", {
      fetchImpl: vi.fn<typeof fetch>(async () => new Response(JSON.stringify(snapshot)))
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not let an aborted same-batch caller cancel a newer caller", async () => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    let requestIndex = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.signal === undefined) throw new Error("Expected a request signal.");
      requestIndex += 1;
      if (requestIndex === 1) {
        await new Promise<never>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      return new Response(JSON.stringify(snapshot));
    });

    const first = loadCurrentTopicFacetSnapshot("S26", {
      fetchImpl,
      signal: firstController.signal
    });
    const second = loadCurrentTopicFacetSnapshot("S26", {
      fetchImpl,
      signal: secondController.signal
    });
    firstController.abort();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toEqual(snapshot);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects wrong batches, row counts, versions, and oversized bodies", async () => {
    expect(isCurrentTopicFacetSnapshot(snapshot, "S26")).toBe(true);
    expect(isCurrentTopicFacetSnapshot({ ...snapshot, batchSlug: "S2026" }, "S26")).toBe(false);
    expect(isCurrentTopicFacetSnapshot({ ...snapshot, rowCount: 2 }, "S26")).toBe(false);
    expect(isCurrentTopicFacetSnapshot({ ...snapshot, version: "old" }, "S26")).toBe(false);

    const oversized = "x".repeat(TOPIC_FACET_MAX_BYTES + 1);
    await expect(loadCurrentTopicFacetSnapshot("S26", {
      fetchImpl: vi.fn<typeof fetch>(async () => new Response(oversized))
    })).rejects.toThrow("size limit");
  });

  it("exposes a stable endpoint prefix while retaining a unique refresh token", () => {
    expect(topicFacetApiUrl("S2026")).toMatch(/^\/api\/topic-facets\/S2026\?v=.*&refresh=/);
  });
});
