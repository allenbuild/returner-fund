import { describe, expect, it } from "vitest";
import {
  datasetWithLiveEvidence,
  liveEvidenceCacheVersion,
  liveEvidenceVisibilityForGraph
} from "@/lib/graph/live-evidence-dataset";
import { aggregateBalancedTractionScore } from "@/lib/graph/traction-scoring";
import type { LiveEvidenceRecord } from "@/lib/ingestion/live-source-refresh";
import type { CompanyRecord, DemoGraphDataset, EvidenceItem } from "@/lib/graph/types";

describe("live evidence dataset merge", () => {
  it("normalizes live evidence scores before top-voice graph rollups consume them", () => {
    const dataset = datasetWithLiveEvidence(baseDataset(), [
      liveXRecord({
        contributionScore: 17,
        metrics: {
          views: 100000,
          likes: 2000,
          comments: 140,
          reposts: 90
        }
      })
    ]);
    const liveEvidence = dataset.evidence.find((item) => item.id === "live-x-company-screenpipe-2077045452579778664");

    expect(liveEvidence?.contributionScore).toBeGreaterThan(17);
    expect(liveEvidence?.normalizedScore).toBe(liveEvidence?.contributionScore);
    expect(liveEvidence?.why).toContain("/100");
  });

  it("does not let a live row from one batch renormalize evidence or scores in another batch", () => {
    const dataset = twoBatchDataset();
    const untouchedBefore = dataset.evidence.filter(
      (item) => item.attachedCompanyId === "company-alpha"
    );
    const scoreBefore = aggregateBalancedTractionScore(untouchedBefore);
    const merged = datasetWithLiveEvidence(dataset, [
      liveXRecord({
        id: "live-x-company-beta-2077045452579778664",
        entityId: "company-beta",
        companyName: "Beta",
        metrics: { views: 90_000_000, likes: 900_000, replies: 90_000, reposts: 90_000 }
      })
    ]);
    const untouchedAfter = merged.evidence.filter(
      (item) => item.attachedCompanyId === "company-alpha"
    );

    expect(untouchedAfter).toEqual(untouchedBefore);
    expect(aggregateBalancedTractionScore(untouchedAfter)).toEqual(scoreBefore);
  });

  it("merges canonical observations identically for every live-record permutation", () => {
    const timestamplessOverstatement = liveXRecord({
      id: "live-x-screenpipe-timestampless-overstatement",
      sourceUrl: "https://twitter.com/screenpipe/status/2077045452579778664?s=20",
      platformPostId: null,
      postedAt: null,
      first_seen_at: "",
      last_checked_at: "",
      last_updated_at: "",
      linkCheckedAt: null,
      metrics: { views: 900000000, likes: 9000000, replies: 900000, reposts: 900000 },
      contributionScore: 100
    });
    const explicitCorrection = liveXRecord({
      id: "live-x-screenpipe-explicit-correction",
      sourceUrl: "https://x.com/screenpipe/status/2077045452579778664?utm_source=refresh",
      metrics: { views: 250, likes: 4, replies: 1, reposts: 0 },
      contributionScore: 5,
      first_seen_at: "2031-07-14T17:00:00.000Z",
      last_checked_at: "2031-07-14T17:00:00.000Z",
      last_updated_at: "2031-07-14T17:00:00.000Z",
      linkCheckedAt: "2031-07-14T17:00:00.000Z"
    });
    const secondPost = liveXRecord({
      id: "live-x-screenpipe-second-post",
      sourceUrl: "https://x.com/screenpipe/status/2077045452579778665",
      platformPostId: "2077045452579778665",
      metrics: { views: 12500, likes: 80, replies: 9, reposts: 4 }
    });
    const recordPermutations = permutations([timestamplessOverstatement, explicitCorrection, secondPost]);
    const datasets = recordPermutations.map((records) => datasetWithLiveEvidence(baseDataset(), records));

    for (const dataset of datasets.slice(1)) {
      expect(dataset.evidence).toEqual(datasets[0].evidence);
    }
    const canonicalRows = datasets[0].evidence.filter(
      (item) => item.platform === "x" && item.platformPostId === "2077045452579778664"
    );
    expect(canonicalRows).toHaveLength(1);
    expect(canonicalRows[0].metrics.views).toBe(250);
    expect(new Set(recordPermutations.map(liveEvidenceCacheVersion))).toHaveLength(1);

    const visibility = liveEvidenceVisibilityForGraph(datasets[0].evidence, [
      {
        ...explicitCorrection,
        sourceUrl: "https://twitter.com/screenpipe/status/2077045452579778664?s=20",
        platformPostId: null
      }
    ]);
    expect(visibility.visibleEvidence).toHaveLength(1);
    expect(visibility.hiddenEvidence).toEqual([]);
  });
});

function baseDataset(): DemoGraphDataset {
  return {
    mode: "official_snapshot",
    batches: [{ slug: "S26", label: "YC Summer 2026 (S26)", companyCountExpected: 2, companyCountObserved: 2 }],
    companies: [companyRecord("company-existing", "S26"), companyRecord("company-screenpipe", "S26")],
    founders: [],
    evidence: [
      evidenceItem("existing-low", { views: 1000, likes: 20, comments: 2 }, 30),
      evidenceItem("existing-mid", { views: 10000, likes: 120, comments: 12 }, 55)
    ],
    needsReview: [],
    platformStatus: []
  };
}

function twoBatchDataset(): DemoGraphDataset {
  return {
    mode: "official_snapshot",
    batches: [
      { slug: "A", label: "Batch A", companyCountExpected: 1, companyCountObserved: 1 },
      { slug: "B", label: "Batch B", companyCountExpected: 1, companyCountObserved: 1 }
    ],
    companies: [companyRecord("company-alpha", "A"), companyRecord("company-beta", "B")],
    founders: [],
    evidence: [
      evidenceItem("alpha-low", { views: 1_000, likes: 20, comments: 2 }, 30, "company-alpha"),
      evidenceItem("beta-mid", { views: 10_000, likes: 120, comments: 12 }, 55, "company-beta"),
      evidenceItem("alpha-high", { views: 100_000, likes: 2_000, comments: 140 }, 75, "company-alpha")
    ],
    needsReview: [],
    platformStatus: []
  };
}

function evidenceItem(
  id: string,
  metrics: EvidenceItem["metrics"],
  contributionScore: number,
  entityId = "company-existing"
): EvidenceItem {
  return {
    id,
    entityType: "company",
    entityId,
    platform: "x",
    authorName: "Existing",
    authorHandle: "existing",
    postedAt: "2026-07-10T00:00:00.000Z",
    title: "Existing post",
    text: "Existing post",
    mediaType: "text",
    metrics,
    contributionScore,
    sourceUrl: `https://x.com/existing/status/${id}`,
    platformPostId: id,
    why: "Existing normalized evidence.",
    attachedCompanyId: entityId,
    attachedCompanyName: "Existing"
  };
}

function companyRecord(id: string, batchSlug: string): CompanyRecord {
  return {
    id,
    batchSlug,
    name: id,
    ycProfileUrl: `https://www.ycombinator.com/companies/${id}`,
    websiteUrl: `https://${id}.example.com`,
    tagline: "Test company",
    description: "Test company",
    groupPartner: null,
    primaryIndustry: "B2B",
    businessModel: "b2b",
    review_state: "verified",
    sourceUrl: `https://www.ycombinator.com/companies/${id}`,
    industries: ["B2B"],
    founderIds: [],
    socialAccounts: [],
    totalScore: 0,
    previousScore: 0,
    platformScores: {}
  };
}

function liveXRecord(overrides: Partial<LiveEvidenceRecord> = {}): LiveEvidenceRecord {
  return {
    id: "live-x-company-screenpipe-2077045452579778664",
    entityType: "company",
    entityId: "company-screenpipe",
    companyName: "screenpipe",
    platform: "x",
    title: "introducing screenpipe",
    sourceUrl: "https://x.com/screenpipe/status/2077045452579778664",
    platformPostId: "2077045452579778664",
    text: "introducing screenpipe: searchable work memory and AI agents",
    thumbnailUrl: null,
    thumbnailSource: null,
    mediaUrl: null,
    mediaUrls: [],
    media_urls: [],
    media_posters: [],
    linkStatus: "verified",
    linkCheckedAt: "2026-07-14T17:00:00.000Z",
    rawVisibleText: JSON.stringify({
      source: "live_x_profile",
      post: {
        author: {
          screen_name: "screenpipe",
          name: "screenpipe (YC S26)",
          url: "https://x.com/screenpipe"
        }
      }
    }),
    postedAt: "2026-07-14T15:00:00.000Z",
    metrics: {
      views: 116000,
      likes: 697,
      comments: 74,
      replies: 74,
      reposts: 104
    },
    contributionScore: 17,
    review_state: "verified",
    matchReason: "Live manual refresh verified a native X post from official @screenpipe for screenpipe.",
    first_seen_at: "2026-07-14T17:00:00.000Z",
    last_checked_at: "2026-07-14T17:00:00.000Z",
    last_updated_at: "2026-07-14T15:00:00.000Z",
    ...overrides
  };
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) {
    return [items];
  }
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest])
  );
}
