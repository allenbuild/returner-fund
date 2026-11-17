import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicationGraphBuildScope, publicationCanonicalBaseGraph } from "@/lib/graph/publication-graph-build-scope";
import type { GraphResponse } from "@/lib/graph/types";

const graph = (version = 1) => ({ nodes: [{ score: version }], evidence: [{ text: `native ${version}` }] }) as GraphResponse;

describe("publication graph base lifetime", () => {
  it("does not retain ordinary builds outside an explicit publisher lifetime", () => {
    const build = vi.fn(() => graph());
    publicationCanonicalBaseGraph("F26:v1", build);
    publicationCanonicalBaseGraph("F26:v1", build);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("reuses one base across awaits and keeps cohorts and source versions separate", async () => {
    const scope = createPublicationGraphBuildScope(), build = vi.fn(() => graph());
    await scope.run(async () => {
      const first = publicationCanonicalBaseGraph("F26:v1", build);
      await Promise.resolve();
      expect(publicationCanonicalBaseGraph("F26:v1", build)).toBe(first);
      publicationCanonicalBaseGraph("S26:v1", build);
      publicationCanonicalBaseGraph("F26:v2", build);
    });
    expect(scope.stats()).toEqual({ baseBuilds: 3, baseReuses: 1, retainedBases: 3 });
    scope.close();
    expect(scope.stats().retainedBases).toBe(0);
    expect(() => scope.run(() => graph())).toThrow(/closed/);
  });

  it("bounds retained bases and releases every graph when publication ends", () => {
    const scope = createPublicationGraphBuildScope();
    scope.run(() => {
      for (let index = 0; index < 8; index++) publicationCanonicalBaseGraph(`F26:v${index}`, () => graph(index));
    });
    expect(scope.stats().retainedBases).toBe(4);
    scope.close();
    const next = createPublicationGraphBuildScope();
    expect(next.run(() => publicationCanonicalBaseGraph("F26:v7", () => graph(99))).nodes[0].score).toBe(99);
    next.close();
  });
});

describe("publication route reuse parity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("@/app/api/graph/full/dependencies");
    vi.doUnmock("@/lib/graph/client-filters");
    vi.doUnmock("@/lib/social/user-insiders-server");
    vi.resetModules();
  });

  it("preserves all audience outputs while avoiding repeated canonical bases only in a publication scope", async () => {
    vi.resetModules();
    let baseBuilds = 0;
    const makeGraph = (audience: string) => ({
      batch: { slug: "F26" }, selectedTopVoiceAudience: { id: audience },
      nodes: [{ id: "company-native", score: 42 }], evidence: [{ id: "native-1", text: "Exact original", contributionScore: 0 }],
      fastestGaining: [], leaderboard: []
    });
    vi.doMock("@/lib/graph/client-filters", () => ({ applyClientGraphFilters: (value: unknown) => value }));
    vi.doMock("@/lib/social/user-insiders-server", () => ({ authenticateInsiderRequest: async () => null, loadUserInsiderConfiguration: vi.fn() }));
    vi.doMock("@/app/api/graph/full/dependencies", async () => {
      const { getOrBuildCachedGraphResponse } = await import("@/lib/graph/graph-response-cache");
      return { fullGraphDependencies: {
        applyBenchmarkMomentumRows: (value: unknown) => value,
        benchmarkStoreVersion: () => "frozen-v1",
        buildGraphResponse: ({ topVoices }: { topVoices: string }) => {
          if (topVoices === "off") baseBuilds++;
          return makeGraph(topVoices);
        },
        datasetWithLiveEvidence: (value: unknown) => value,
        enrichGraphTaxonomies: (value: unknown) => value,
        ensureBenchmarkMomentum: (value: unknown) => ({ graph: value }),
        getOrBuildCachedGraphResponse,
        inheritCanonicalCompanyScoring: (value: unknown) => value,
        liveEvidenceCacheVersion: () => "frozen-live-v1",
        loadLiveEvidenceRecords: async () => [],
        overlayLiveEvidenceOnGraph: (value: unknown) => ({ graph: value }),
        personalizeInsiderGraphSnapshot: vi.fn(),
        sanitizeGraphResponse: (value: unknown) => value,
        yc2026GraphDataset: { companies: [] }
      } };
    });
    const [{ GET }, { createPublicationGraphBuildScope: createScope }] = await Promise.all([
      import("@/app/api/graph/full/route"), import("@/lib/graph/publication-graph-build-scope")
    ]);
    const token = "local-test-publication-token-with-entropy";
    vi.stubEnv("GRAPH_PUBLICATION_BUILD_TOKEN", token);
    const readAudiences = async () => {
      const output = [];
      for (const audience of ["off", "yc_partners", "insiders"]) {
        const response = await GET(new Request(`http://127.0.0.1/api/graph/full?batch=F26&includeNonScoring=true&topVoices=${audience}`, {
          headers: { "x-returner-publication-build": token }
        }));
        expect(response.status).toBe(200);
        output.push(await response.json());
      }
      return output;
    };
    const uncached = await readAudiences();
    expect(baseBuilds).toBe(3);
    const scope = createScope();
    const cached = await scope.run(readAudiences);
    expect(cached).toEqual(uncached);
    expect(baseBuilds).toBe(4);
    expect(scope.stats()).toEqual({ baseBuilds: 1, baseReuses: 2, retainedBases: 1 });
    scope.close();
    await readAudiences();
    expect(baseBuilds).toBe(7);
  });
});
