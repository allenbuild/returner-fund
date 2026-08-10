import { describe, expect, it } from "vitest";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import {
  PUBLIC_GRAPH_EVIDENCE_LIMIT,
  sanitizeGraphResponse
} from "@/lib/graph/response-sanitizer";
import {
  formatStaticGraphSnapshotContractIssue,
  validateStaticGraphSnapshotContract
} from "@/lib/graph/static-graph-snapshot-contract.mjs";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";

describe("graph response sanitizer", () => {
  it("removes raw scrape text from dashboard graph payloads", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const graphWithRaw = {
      ...graph,
      evidence: graph.evidence.map((item, index) =>
        index === 0 ? { ...item, rawVisibleText: "raw scrape text that should not ship" } : item
      )
    };
    const sanitized = sanitizeGraphResponse(graphWithRaw);

    expect(graphWithRaw.evidence.some((item) => item.rawVisibleText)).toBe(true);
    expect(sanitized.evidence.some((item) => "rawVisibleText" in item)).toBe(false);
    expect(sanitized.evidence.length).toBeLessThan(graph.evidence.length);
    expect(sanitized.evidenceProjection).toMatchObject({
      sourceEvidenceCount: graph.evidence.length,
      retainedEvidenceCount: sanitized.evidence.length,
      omittedEvidenceCount: graph.evidence.length - sanitized.evidence.length
    });
    expect(sanitized.evidence.every((item) => item.contributionScore > 0)).toBe(true);
    expect(sanitized.evidence[0]?.id).toMatch(/^ev-/);
    expect(sanitized.evidence.every((item) => item.why === "")).toBe(true);
    expect(sanitized.nodes.every((node) => node.evidenceIds.every((id) => sanitized.evidence.some((item) => item.id === id)))).toBe(true);
    expect(
      sanitized.leaderboard.some((row) => row.biggestContribution && "rawVisibleText" in row.biggestContribution)
    ).toBe(false);
    expect(JSON.stringify(sanitized.fastestGaining)).not.toContain("rawVisibleText");
    expect(JSON.stringify(sanitized.fastestGaining)).not.toContain("newHighPerformingPosts");
  });

  it("keeps raw scrape text when explicitly requested for debug audits", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);

    expect(sanitizeGraphResponse(graph, { includeRaw: true })).toBe(graph);
  });

  it("keeps public-safe GitHub creation provenance when raw payloads are removed", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const evidence = graph.evidence[0];
    const nativeCreation = "2025-01-02T03:04:05.000Z";
    const sanitized = sanitizeGraphResponse({
      ...graph,
      evidence: [{
        ...evidence,
        platform: "github",
        sourceUrl: "https://github.com/returner/example-repository",
        postedAt: nativeCreation,
        publishedAtPrecision: "exact",
        rawVisibleText: JSON.stringify({
          repositoryTimestamps: {
            createdAt: nativeCreation,
            updatedAt: "2026-07-14T10:00:00.000Z",
            pushedAt: "2026-07-15T10:00:00.000Z",
            observedAt: "2026-07-16T10:00:00.000Z"
          }
        })
      }]
    }, { includeNonScoring: true, compactIds: false });

    expect(sanitized.evidence[0]).not.toHaveProperty("rawVisibleText");
    expect(sanitized.evidence[0]?.publicationProvenance).toEqual({
      kind: "github_repository",
      createdAt: nativeCreation,
      updatedAt: "2026-07-14T10:00:00.000Z",
      pushedAt: "2026-07-15T10:00:00.000Z",
      observedAt: "2026-07-16T10:00:00.000Z"
    });
  });

  it("can keep explanations for debug views without keeping raw scrape text", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const sanitized = sanitizeGraphResponse(graph, { includeWhy: true });

    expect(sanitized.evidence.some((item) => item.why)).toBe(true);
    expect(sanitized.evidence.some((item) => "rawVisibleText" in item)).toBe(false);
  });

  it("hard-caps the payload while publishing compact full-score omission metadata", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const scoredEvidenceCount = graph.evidence.filter((item) => item.contributionScore > 0).length;

    expect(scoredEvidenceCount).toBeGreaterThan(1);

    const sanitized = sanitizeGraphResponse(graph, {
      includeNonScoring: true,
      compactIds: false,
      maxEvidence: 1
    });
    const contract = validateStaticGraphSnapshotContract(sanitized);
    const detail = contract.ok
      ? ""
      : contract.issues.slice(0, 3).map(formatStaticGraphSnapshotContractIssue).join("; ");

    expect(sanitized.evidence).toHaveLength(1);
    expect(sanitized.evidenceProjection).toMatchObject({
      maxEvidence: 1,
      sourceEvidenceCount: graph.evidence.length,
      retainedEvidenceCount: 1,
      omittedEvidenceCount: graph.evidence.length - 1,
      sourcePositiveEvidenceCount: scoredEvidenceCount,
      omittedPositiveEvidenceCount: scoredEvidenceCount - 1
    });
    expect(sanitized.nodes.map((node) => node.score)).toEqual(graph.nodes.map((node) => node.score));
    expect(sanitized.nodes.map((node) => node.scoreBreakdown)).toEqual(
      graph.nodes.map((node) => node.scoreBreakdown)
    );
    expect(contract, detail).toEqual({ ok: true, issues: [] });
  });

  it("never lets a caller raise or disable the hard public evidence ceiling", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const overLimit = sanitizeGraphResponse(graph, {
      includeNonScoring: true,
      compactIds: false,
      maxEvidence: PUBLIC_GRAPH_EVIDENCE_LIMIT + 1_000
    });

    expect(graph.evidence.length).toBeGreaterThan(PUBLIC_GRAPH_EVIDENCE_LIMIT);
    expect(overLimit.evidence).toHaveLength(PUBLIC_GRAPH_EVIDENCE_LIMIT);
    expect(overLimit.evidenceProjection).toMatchObject({
      maxEvidence: PUBLIC_GRAPH_EVIDENCE_LIMIT,
      sourceEvidenceCount: graph.evidence.length,
      retainedEvidenceCount: PUBLIC_GRAPH_EVIDENCE_LIMIT,
      omittedEvidenceCount: graph.evidence.length - PUBLIC_GRAPH_EVIDENCE_LIMIT
    });

    const smallGraph = { ...graph, evidence: graph.evidence.slice(0, 3) };
    for (const maxEvidence of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const failClosed = sanitizeGraphResponse(smallGraph, {
        includeNonScoring: true,
        compactIds: false,
        maxEvidence
      });

      expect(failClosed.evidence, String(maxEvidence)).toEqual([]);
      expect(failClosed.evidenceProjection, String(maxEvidence)).toMatchObject({
        maxEvidence: 0,
        sourceEvidenceCount: 3,
        retainedEvidenceCount: 0,
        omittedEvidenceCount: 3
      });
      expect(failClosed.nodes.every((node) => node.evidenceIds.length === 0)).toBe(true);
      expect(
        failClosed.nodes.every((node) =>
          node.founders.every((founder) => founder.evidenceIds.length === 0)
        )
      ).toBe(true);
      expect(failClosed.leaderboard.every((row) => row.biggestContribution === null)).toBe(true);
    }
  });

  it("requires omission metadata when canonical full-corpus statistics exceed an at-cap preview", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const sanitized = sanitizeGraphResponse(graph, {
      includeNonScoring: true,
      compactIds: false
    });
    const withoutProjection = { ...sanitized, evidenceProjection: undefined };
    const contract = validateStaticGraphSnapshotContract(withoutProjection);

    expect(sanitized.evidence).toHaveLength(PUBLIC_GRAPH_EVIDENCE_LIMIT);
    expect(sanitized.evidenceProjection?.sourceEvidenceCount).toBe(graph.evidence.length);
    expect(contract.ok).toBe(false);
    expect(contract.issues).toContainEqual({
      path: "evidenceProjection",
      message:
        `is required because evidenceStats.totalCount=${graph.evidence.length} exceeds the ` +
        `${PUBLIC_GRAPH_EVIDENCE_LIMIT} retained rows`
    });
  });

  it("rejects malformed at-cap omission metadata", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const sanitized = sanitizeGraphResponse(graph, {
      includeNonScoring: true,
      compactIds: false
    });
    const projection = sanitized.evidenceProjection!;
    const cases = [
      {
        label: "raised ceiling",
        value: { ...projection, maxEvidence: PUBLIC_GRAPH_EVIDENCE_LIMIT + 1 }
      },
      {
        label: "wrong retained count",
        value: { ...projection, retainedEvidenceCount: sanitized.evidence.length - 1 }
      },
      {
        label: "wrong source count",
        value: { ...projection, sourceEvidenceCount: projection.sourceEvidenceCount - 1 }
      },
      {
        label: "wrong positive count",
        value: { ...projection, sourcePositiveEvidenceCount: projection.sourcePositiveEvidenceCount - 1 }
      }
    ];

    for (const candidate of cases) {
      const contract = validateStaticGraphSnapshotContract({
        ...sanitized,
        evidenceProjection: candidate.value
      });
      expect(contract.ok, candidate.label).toBe(false);
    }
  });
});
