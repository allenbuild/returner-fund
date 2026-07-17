import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildGraphResponse,
  clearTopVoiceRollupCache
} from "@/lib/graph/graph-builder";
import { liveEvidenceCacheVersion } from "@/lib/graph/live-evidence-dataset";
import type { LiveEvidenceRecord } from "@/lib/ingestion/live-source-refresh";
import type { DemoGraphDataset, EvidenceItem } from "@/lib/graph/types";

describe("Top Voice cache signatures", () => {
  beforeEach(() => {
    clearTopVoiceRollupCache();
  });

  afterEach(() => {
    clearTopVoiceRollupCache();
  });

  it("drops a cached Top Voice rollup after its normalized author is corrected to an outsider", () => {
    const dataset = topVoiceDataset();

    expect(topVoiceCompanyIds(dataset)).toEqual(["company-cache-target"]);

    dataset.evidence[0].authorName = "Not Altman";
    dataset.evidence[0].authorHandle = "nope";

    expect(topVoiceCompanyIds(dataset)).toEqual([]);
  });

  it("drops a cached Top Voice rollup after an equal-length content correction removes the target", () => {
    const rawVisibleText = "Cache Target is gaining traction.";
    const dataset = topVoiceDataset({
      title: "Top Voice update",
      text: "A noteworthy launch.",
      rawVisibleText
    });

    expect(topVoiceCompanyIds(dataset)).toEqual(["company-cache-target"]);

    dataset.evidence[0].rawVisibleText = "x".repeat(rawVisibleText.length);

    expect(dataset.evidence[0].rawVisibleText).toHaveLength(rawVisibleText.length);
    expect(topVoiceCompanyIds(dataset)).toEqual([]);
  });

  it("changes the live cache version for an equal-length outsider author correction", () => {
    const topVoiceRaw = JSON.stringify({
      post: { author: { screen_name: "sama", name: "Sam Altman" } }
    });
    const outsiderRaw = JSON.stringify({
      post: { author: { screen_name: "nope", name: "Not Altman" } }
    });

    expect(outsiderRaw).toHaveLength(topVoiceRaw.length);
    expect(
      liveEvidenceCacheVersion([liveEvidenceRecord({ rawVisibleText: outsiderRaw })])
    ).not.toBe(
      liveEvidenceCacheVersion([liveEvidenceRecord({ rawVisibleText: topVoiceRaw })])
    );
  });

  it("changes the live cache version when corrected content has the same length", () => {
    const text = "Cache Target is gaining traction.";
    const correctedText = "x".repeat(text.length);

    expect(correctedText).toHaveLength(text.length);
    expect(
      liveEvidenceCacheVersion([liveEvidenceRecord({ text: correctedText })])
    ).not.toBe(
      liveEvidenceCacheVersion([liveEvidenceRecord({ text })])
    );
  });
});

function topVoiceCompanyIds(dataset: DemoGraphDataset): string[] {
  return buildGraphResponse({ batchSlug: "S2026", topVoices: "insiders" }, dataset)
    .leaderboard.map((row) => row.companyId);
}

function topVoiceDataset(evidenceOverrides: Partial<EvidenceItem> = {}): DemoGraphDataset {
  return {
    mode: "official_snapshot",
    batches: [{
      slug: "S2026",
      label: "Cache signature test",
      companyCountExpected: 1,
      companyCountObserved: 1
    }],
    companies: [{
      id: "company-cache-target",
      batchSlug: "S2026",
      name: "Cache Target",
      ycProfileUrl: "https://www.ycombinator.com/companies/cache-target",
      websiteUrl: "https://cache-target.example.com",
      tagline: "Cache signature testing",
      description: "Cache signature testing",
      groupPartner: null,
      primaryIndustry: "B2B",
      businessModel: "b2b",
      review_state: "verified",
      sourceUrl: "https://www.ycombinator.com/companies/cache-target",
      industries: ["B2B"],
      founderIds: [],
      socialAccounts: [],
      totalScore: 0,
      previousScore: 0,
      platformScores: {}
    }],
    founders: [],
    evidence: [{
      id: "evidence-cache-target",
      entityType: "company",
      entityId: "company-cache-target",
      platform: "x",
      authorName: "Sam Altman",
      authorHandle: "sama",
      postedAt: "2026-07-16T12:00:00.000Z",
      publishedAtPrecision: "exact",
      title: "Sam Altman mentioned Cache Target",
      text: "Cache Target is gaining traction.",
      mediaType: "text",
      linkStatus: "verified",
      metrics: { likes: 50 },
      contributionScore: 40,
      tractionStatus: "scored",
      sourceUrl: "https://x.com/sama/status/1",
      platformPostId: "1",
      why: "Verified native Top Voice post.",
      review_state: "verified",
      ...evidenceOverrides
    }],
    needsReview: [],
    platformStatus: []
  };
}

function liveEvidenceRecord(overrides: Partial<LiveEvidenceRecord> = {}): LiveEvidenceRecord {
  return {
    id: "live-cache-target",
    entityType: "company",
    entityId: "company-cache-target",
    companyName: "Cache Target",
    platform: "x",
    title: "Top Voice update",
    sourceUrl: "https://x.com/sama/status/1",
    platformPostId: "1",
    text: "Cache Target is gaining traction.",
    rawVisibleText: JSON.stringify({
      post: { author: { screen_name: "sama", name: "Sam Altman" } }
    }),
    postedAt: "2026-07-16T12:00:00.000Z",
    metrics: { likes: 50 },
    contributionScore: 40,
    review_state: "verified",
    matchReason: "Verified native Top Voice post.",
    first_seen_at: "2026-07-16T12:00:00.000Z",
    last_checked_at: "2026-07-16T12:00:00.000Z",
    last_updated_at: "2026-07-16T12:00:00.000Z",
    ...overrides
  };
}
