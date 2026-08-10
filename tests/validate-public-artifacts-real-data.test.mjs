import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildGraphResponse,
  clearTopVoiceRollupCache
} from "../src/lib/graph/graph-builder.ts";
import { yc2026GraphDataset } from "../src/lib/graph/yc-spring-2026-dataset.ts";
import {
  GRAPH_ARTIFACTS,
  collectCanonicalGraphSetViolations,
  collectGraphArtifactViolations
} from "../scripts/validate-public-artifacts.mjs";
import {
  PUBLIC_GRAPH_EVIDENCE_LIMIT,
  sanitizeGraphResponse
} from "../src/lib/graph/response-sanitizer.ts";

const RESPONSE_BUILT_AT = new Date().toISOString();
const MIN_FULL_SOURCE_EVIDENCE_COUNTS = {
  S2026: 20_000,
  S26: 13_000,
  A16ZSR006: 9_000
};

describe("public artifact validator against canonical v4 responses", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(RESPONSE_BUILT_AT);
    clearTopVoiceRollupCache();
  });

  afterAll(() => {
    clearTopVoiceRollupCache();
    vi.useRealTimers();
  });

  it.each(GRAPH_ARTIFACTS)("accepts $path", (descriptor) => {
    const sourceGraph = buildGraphResponse(
      {
        batchSlug: descriptor.batch,
        ...(descriptor.audience === "off" ? {} : { topVoices: descriptor.audience })
      },
      yc2026GraphDataset
    );
    const sourceEvidenceCount = sourceGraph.evidenceStats?.totalCount;

    // Cohort evidence is a live, append-only publication corpus. Guard its
    // established scale without pinning CI to counts that legitimately move
    // after every autonomous ingestion release.
    expect(sourceEvidenceCount).toBeGreaterThanOrEqual(
      MIN_FULL_SOURCE_EVIDENCE_COUNTS[descriptor.batch]
    );
    if (descriptor.audience === "off") {
      expect(sourceGraph.evidence).toHaveLength(sourceEvidenceCount);
      expect(sourceGraph.evidence.length).toBeGreaterThan(PUBLIC_GRAPH_EVIDENCE_LIMIT);
    }

    const publicGraph = sanitizeGraphResponse(sourceGraph, {
      includeNonScoring: true,
      compactIds: false
    });

    expect(publicGraph.evidence.length).toBeLessThanOrEqual(PUBLIC_GRAPH_EVIDENCE_LIMIT);
    if (sourceGraph.evidence.length > PUBLIC_GRAPH_EVIDENCE_LIMIT) {
      expect(publicGraph.evidenceProjection).toMatchObject({
        maxEvidence: PUBLIC_GRAPH_EVIDENCE_LIMIT,
        sourceEvidenceCount: sourceGraph.evidence.length,
        retainedEvidenceCount: PUBLIC_GRAPH_EVIDENCE_LIMIT,
        omittedEvidenceCount: sourceGraph.evidence.length - PUBLIC_GRAPH_EVIDENCE_LIMIT
      });
    }

    // Publication bounds the evidence rows only after the full-corpus graph
    // has materialized scores, ranks, momentum, and topic statistics.
    expect(publicGraph.nodes.map(({ entityId, score, scoreBreakdown }) => ({
      entityId,
      score,
      scoreBreakdown
    }))).toEqual(sourceGraph.nodes.map(({ entityId, score, scoreBreakdown }) => ({
      entityId,
      score,
      scoreBreakdown
    })));
    expect(publicGraph.leaderboard.map(({ companyId, rank, score, topPlatform }) => ({
      companyId,
      rank,
      score,
      topPlatform
    }))).toEqual(sourceGraph.leaderboard.map(({ companyId, rank, score, topPlatform }) => ({
      companyId,
      rank,
      score,
      topPlatform
    })));
    expect(publicGraph.fastestGaining).toEqual(sourceGraph.fastestGaining);
    expect(publicGraph.evidenceStats).toEqual(sourceGraph.evidenceStats);

    const violations = collectGraphArtifactViolations(publicGraph, descriptor);

    expect(violations, violations.slice(0, 20).join("\n")).toEqual([]);
  });

  it("preserves canonical scores, ranks, radii, and momentum across audience snapshots", () => {
    const entries = GRAPH_ARTIFACTS.map((descriptor) => ({
      descriptor,
      graph: buildGraphResponse(
        {
          batchSlug: descriptor.batch,
          ...(descriptor.audience === "off" ? {} : { topVoices: descriptor.audience })
        },
        yc2026GraphDataset
      )
    }));

    const violations = collectCanonicalGraphSetViolations(entries);

    expect(violations, violations.slice(0, 20).join("\n")).toEqual([]);
  });
});
