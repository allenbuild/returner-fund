import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  captureProductionGraphSamples,
  PRODUCTION_GRAPH_BATCHES,
  PRODUCTION_GRAPH_CORE_PLATFORMS,
  readCoveragePairsFromFile
} from "../scripts/lib/production-graph-sampler.mjs";

const NOW = "2026-08-03T04:00:00.000Z";
const DIGEST = "a".repeat(64);
const REVISION = "revision-production-42";

describe("production graph sampler", () => {
  it("makes exactly three bounded concurrent unauthenticated reads and emits all 30 proof rows", async () => {
    const tracker = { calls: [], active: 0, maxActive: 0 };
    const fetchImpl = concurrentGraphFetch(tracker);
    const result = await captureProductionGraphSamples({
      coveragePairs: coverageFixture(),
      baseUrl: "https://returner.example",
      artifactDigest: DIGEST,
      revision: REVISION,
      fetchImpl,
      now: () => new Date(NOW)
    });

    assert.equal(tracker.calls.length, 3);
    assert.equal(tracker.maxActive, 3);
    assert.deepEqual(
      tracker.calls.map((call) => call.batch).sort(),
      [...PRODUCTION_GRAPH_BATCHES].sort()
    );
    for (const call of tracker.calls) {
      assert.equal(call.authorization, null);
      assert.equal(call.cookie, null);
      assert.equal(call.method, "GET");
      assert.equal(call.topVoices, "off");
    }
    assert.equal(result.status, "verified");
    assert.deepEqual(result.summary, {
      verifiedCells: 30,
      blockedCells: 0,
      blockers: 0,
      proofEmitted: true
    });
    assert.equal(result.requests.length, 3);
    assert.equal(result.coverageSource.corePairCount, 30);
    assert.equal(result.coverageSource.pairKeysSha256.length, 64);
    assert.equal(result.productionSample.samples.length, 30);
    assert.equal(new Set(result.productionSample.samples.map((row) =>
      `${row.batchSlug}:${row.platform}`)).size, 30);
    assert.equal(result.productionSample.artifactDigest, DIGEST);
    assert.equal(result.productionSample.revision, REVISION);
    assert.ok(result.cells.every((cell) => cell.pairKey.startsWith(`${cell.batchSlug}:company:`)));
    assert.ok(result.cells.every((cell) => cell.observation.entityPresent));
    assert.ok(result.cells.every((cell) => cell.observation.evidenceCount === 1));
    assert.ok(result.requests.every((request) => request.responseSha256?.length === 64));
    assert.ok(result.requests.every((request) => request.responseHeaders["x-vercel-id"]));
  });

  it("keeps verified observations but refuses to invent a receipt without release binding", async () => {
    const result = await captureProductionGraphSamples({
      coveragePairs: coverageFixture(),
      baseUrl: "https://returner.example",
      fetchImpl: concurrentGraphFetch({ calls: [], active: 0, maxActive: 0 }),
      now: () => new Date(NOW)
    });

    assert.equal(result.summary.verifiedCells, 30);
    assert.equal(result.status, "blocked");
    assert.equal(result.productionSample, null);
    assert.deepEqual(
      result.blockers.map((row) => row.code).sort(),
      ["missing_or_invalid_artifact_digest", "missing_revision"]
    );
  });

  it("blocks every cell for a response whose payload spoofs the requested batch", async () => {
    const tracker = { calls: [], active: 0, maxActive: 0 };
    const fetchImpl = concurrentGraphFetch(tracker, {
      mutateGraph(graph, requestedBatch) {
        if (requestedBatch === "S26") {
          graph.batch.slug = "S2026";
          graph.batches = [{ slug: "S2026" }];
        }
      }
    });
    const result = await captureProductionGraphSamples({
      coveragePairs: coverageFixture(),
      baseUrl: "https://returner.example",
      artifactDigest: DIGEST,
      revision: REVISION,
      fetchImpl,
      now: () => new Date(NOW)
    });

    assert.equal(tracker.calls.length, 3);
    assert.equal(result.summary.verifiedCells, 20);
    assert.equal(result.summary.blockedCells, 10);
    assert.equal(result.productionSample, null);
    assert.ok(result.cells.filter((cell) => cell.batchSlug === "S26")
      .every((cell) => cell.blockers.some((row) => row.code === "batch_mismatch")));
  });

  it("does not attribute a platform row from the wrong entity to the sampled pair", async () => {
    const fetchImpl = concurrentGraphFetch({ calls: [], active: 0, maxActive: 0 }, {
      mutateGraph(graph, requestedBatch) {
        if (requestedBatch !== "A16ZSR006") return;
        graph.evidence = graph.evidence.filter((row) => row.platform !== "reddit");
        graph.evidence.push({
          id: "wrong-owner-reddit",
          batchSlug: requestedBatch,
          entityType: "company",
          entityId: "company-not-in-coverage",
          platform: "reddit"
        });
        graph.nodes[0].socialAccounts = graph.nodes[0].socialAccounts.filter(
          (account) => account.platform !== "reddit"
        );
        graph.platformStatus = graph.platformStatus.filter((row) => row.platform !== "reddit");
      }
    });
    const result = await captureProductionGraphSamples({
      coveragePairs: coverageFixture(),
      baseUrl: "https://returner.example",
      artifactDigest: DIGEST,
      revision: REVISION,
      fetchImpl,
      now: () => new Date(NOW)
    });

    const cell = result.cells.find((row) =>
      row.batchSlug === "A16ZSR006" && row.platform === "reddit"
    );
    assert.equal(cell.verified, false);
    assert.equal(cell.observation.evidenceCount, 0);
    assert.ok(cell.blockers.some((row) => row.code === "platform_signal_missing"));
    assert.equal(result.productionSample, null);
  });

  it("records HTTP failures and never substitutes another batch response", async () => {
    const tracker = { calls: [], active: 0, maxActive: 0 };
    const fetchImpl = concurrentGraphFetch(tracker, { failBatch: "S2026" });
    const result = await captureProductionGraphSamples({
      coveragePairs: coverageFixture(),
      baseUrl: "https://returner.example",
      artifactDigest: DIGEST,
      revision: REVISION,
      fetchImpl,
      now: () => new Date(NOW)
    });

    assert.equal(tracker.calls.length, 3);
    assert.equal(result.summary.verifiedCells, 20);
    assert.equal(result.productionSample, null);
    const failedRequest = result.requests.find((row) => row.batchSlug === "S2026");
    assert.equal(failedRequest.status, 503);
    assert.ok(result.cells.filter((cell) => cell.batchSlug === "S2026")
      .every((cell) => cell.blockers.some((row) => row.code === "http_status")));
  });

  it("rejects cross-origin redirects even when the redirected body looks valid", async () => {
    const fetchImpl = async (url) => {
      const batch = new URL(url).searchParams.get("batch");
      const response = jsonResponse(graphFixture(batch));
      Object.defineProperty(response, "url", {
        value: `https://attacker.example/api/graph?batch=${batch}&topVoices=off`
      });
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    };
    const result = await captureProductionGraphSamples({
      coveragePairs: coverageFixture(),
      baseUrl: "https://returner.example",
      artifactDigest: DIGEST,
      revision: REVISION,
      fetchImpl,
      now: () => new Date(NOW)
    });

    assert.equal(result.summary.verifiedCells, 0);
    assert.equal(result.productionSample, null);
    assert.ok(result.cells.every((cell) =>
      cell.blockers.some((row) => row.code === "unexpected_redirect")
    ));
  });

  it("bounds decoded response bodies before parsing", async () => {
    const fetchImpl = async () => new Response("x".repeat(2_048), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
    const result = await captureProductionGraphSamples({
      coveragePairs: coverageFixture(),
      baseUrl: "https://returner.example",
      artifactDigest: DIGEST,
      revision: REVISION,
      fetchImpl,
      maxResponseBytes: 1_024,
      now: () => new Date(NOW)
    });

    assert.equal(result.summary.verifiedCells, 0);
    assert.ok(result.cells.every((cell) =>
      cell.blockers.some((row) => row.code === "invalid_or_oversized_json")
    ));
  });

  it("enforces its timeout even when a fetch implementation ignores abort", async () => {
    const result = await captureProductionGraphSamples({
      coveragePairs: coverageFixture(),
      baseUrl: "https://returner.example",
      artifactDigest: DIGEST,
      revision: REVISION,
      fetchImpl: async () => new Promise(() => {}),
      timeoutMs: 50,
      now: () => new Date(NOW)
    });

    assert.equal(result.summary.verifiedCells, 0);
    assert.equal(result.requests.length, 3);
    assert.ok(result.requests.every((request) =>
      request.error.includes("timed out after 50ms")
    ));
  });

  it("rejects duplicate exact coverage pair keys before issuing any request", async () => {
    const pairs = coverageFixture();
    let calls = 0;
    await assert.rejects(
      captureProductionGraphSamples({
        coveragePairs: [...pairs, structuredClone(pairs[0])],
        baseUrl: "https://returner.example",
        artifactDigest: DIGEST,
        revision: REVISION,
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse({});
        }
      }),
      /Duplicate coverage pairKey/
    );
    assert.equal(calls, 0);
  });

  it("streams the receipt pair array past large decoy strings and nested pairs keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "production-graph-sampler-"));
    const path = join(directory, "coverage.json");
    try {
      const payload = {
        noise: `decoy \\"pairs\\": [${"{".repeat(270_000)}]`,
        coverageReceipt: {
          evidenceRegistry: [{ pairs: [{ bad: true }], text: "braces } ] { in a string" }],
          pairs: coverageFixture()
        },
        pairs: [{ also: "wrong root array after target" }]
      };
      await writeFile(path, JSON.stringify(payload));
      const pairs = await readCoveragePairsFromFile(path);
      assert.equal(pairs.length, 30);
      assert.equal(pairs[0].expectation.postCount, 1);
      assert.equal(pairs[0].expectation.accounts.length, 1);
      assert.deepEqual(
        new Set(pairs.map((row) => `${row.batchSlug}:${row.platform}`)).size,
        30
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function coverageFixture() {
  return PRODUCTION_GRAPH_BATCHES.flatMap((batchSlug) => {
    const entityId = companyId(batchSlug);
    return PRODUCTION_GRAPH_CORE_PLATFORMS.map((platform) => ({
      pairKey: `${batchSlug}:company:${entityId}:${platform}`,
      batchSlug,
      entity: { type: "company", id: entityId, name: `Company ${batchSlug}` },
      platform,
      mapping: {
        status: "mapped",
        verifiedAccountCount: 1,
        accounts: [{
          platform,
          handle: `${batchSlug.toLowerCase()}-${platform}`,
          url: `https://${platform}.example/${batchSlug.toLowerCase()}`,
          verified: true
        }]
      },
      terminal: { status: "collected", reasonCode: "native_evidence_collected" },
      evidence: { postCount: 1, recentPostCount: 1, historicalPostCount: 0 }
    }));
  });
}

function graphFixture(batchSlug) {
  const entityId = companyId(batchSlug);
  return {
    batch: { slug: batchSlug, label: batchSlug },
    batches: PRODUCTION_GRAPH_BATCHES.map((slug) => ({ slug })),
    nodes: [{
      id: `company:${entityId}`,
      entityType: "company",
      entityId,
      batchSlug,
      socialAccounts: PRODUCTION_GRAPH_CORE_PLATFORMS.map((platform) => ({
        id: `account-${batchSlug}-${platform}`,
        platform,
        handle: `${batchSlug.toLowerCase()}-${platform}`,
        url: `https://${platform}.example/${batchSlug.toLowerCase()}`,
        review_state: "verified"
      })),
      founders: []
    }],
    evidence: PRODUCTION_GRAPH_CORE_PLATFORMS.map((platform) => ({
      id: `evidence-${batchSlug}-${platform}`,
      batchSlug,
      entityType: "company",
      entityId,
      platform
    })),
    needsReview: [],
    platformStatus: PRODUCTION_GRAPH_CORE_PLATFORMS.map((platform) => ({
      platform,
      status: platform === "web" ? "disabled" : "working",
      authMethod: "read-only public",
      notes: `Exact ${batchSlug} ${platform} status.`,
      batchSlugs: [batchSlug]
    })),
    generatedAt: NOW,
    scoringContext: {
      modelId: "returner-traction",
      modelVersion: "4.2.0",
      evidenceAsOf: NOW
    },
    mode: "official_snapshot"
  };
}

function concurrentGraphFetch(tracker, { mutateGraph = null, failBatch = null } = {}) {
  return async (url, options) => {
    const parsed = new URL(url);
    const batch = parsed.searchParams.get("batch");
    tracker.active += 1;
    tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
    tracker.calls.push({
      batch,
      topVoices: parsed.searchParams.get("topVoices"),
      method: options?.method ?? null,
      authorization: headerValue(options?.headers, "authorization"),
      cookie: headerValue(options?.headers, "cookie")
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    tracker.active -= 1;
    if (batch === failBatch) {
      return new Response(JSON.stringify({ error: "maintenance" }), {
        status: 503,
        headers: { "content-type": "application/json" }
      });
    }
    const graph = graphFixture(batch);
    mutateGraph?.(graph, batch);
    return jsonResponse(graph, { "x-vercel-id": `iad1::${batch.toLowerCase()}` });
  };
}

function jsonResponse(value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}

function headerValue(headers, name) {
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? null;
  }
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name) return value;
  }
  return null;
}

function companyId(batchSlug) {
  return `company-${batchSlug.toLowerCase()}`;
}
