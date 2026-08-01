import { describe, expect, it } from "vitest";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { dedupeEvidenceForScoring } from "@/lib/graph/dedupe";
import {
  aggregateBalancedTractionScore,
  computeEvidenceRawEngagement,
  normalizeEvidenceScores
} from "@/lib/graph/traction-scoring";
import { TRACTION_SCORING_CONFIG } from "@/lib/graph/traction-scoring-config";
import { calibrateBatchCompanyScores } from "@/lib/scoring/batch-calibration";
import type {
  CompanyRecord,
  DemoGraphDataset,
  EvidenceItem,
  EvidenceMetrics,
  Platform,
  ScoreBreakdown
} from "@/lib/graph/types";

const PROPERTY_SEED = 0x4a16_2f91;
const FIXED_TIME = "2026-07-15T12:00:00.000Z";
const FUTURE_TIME = "2099-01-01T00:00:00.000Z";
const SUPPORTED_PLATFORMS = Object.entries(TRACTION_SCORING_CONFIG.platformWeights)
  .filter(([, weight]) => Number(weight) > 0)
  .map(([platform]) => platform as Platform);

const SCORED_METRIC_CASES = (
  Object.entries(TRACTION_SCORING_CONFIG.metricWeights) as Array<[
    Platform,
    Record<string, number | undefined>
  ]>
).flatMap(([platform, weights]) =>
  Object.entries(weights)
    .filter(([, weight]) => Number.isFinite(weight) && Number(weight) > 0)
    .map(([metric]) => ({ platform, metric }))
);

const ALIAS_CASES: Array<{
  platform: Platform;
  canonical: string;
  alias: string;
}> = [
  { platform: "x", canonical: "replies", alias: "comments" },
  { platform: "x", canonical: "reposts", alias: "shares" },
  { platform: "linkedin", canonical: "reactions", alias: "likes" },
  { platform: "linkedin", canonical: "comments", alias: "replies" },
  { platform: "linkedin", canonical: "reposts", alias: "shares" },
  { platform: "instagram", canonical: "comments", alias: "replies" },
  { platform: "instagram", canonical: "shares", alias: "reposts" },
  { platform: "github", canonical: "issues", alias: "open_issues" }
];

describe("canonical v4 adversarial generated properties", () => {
  describe("metric monotonicity", () => {
    it.each(SCORED_METRIC_CASES)(
      "$platform.$metric cannot lower raw, normalized, or entity scores when increased",
      ({ platform, metric }) => {
        const rng = deterministicRng(PROPERTY_SEED ^ stableNumber(`${platform}:${metric}`));

        for (let trial = 0; trial < 48; trial += 1) {
          const targetValue = rng.int(1, 20_000);
          const increasedValue = targetValue + rng.int(1, 20_000);
          const targetId = `metric-${platform}-${metric}-${trial}`;
          const peers = Array.from({ length: 7 }, (_, index) =>
            evidence(
              `${targetId}-peer-${index}`,
              platform,
              { [metric]: rng.int(1, 40_000) },
              { entityId: `metric-company-${trial}` }
            )
          );
          const beforeTarget = evidence(
            targetId,
            platform,
            { [metric]: targetValue },
            { entityId: `metric-company-${trial}` }
          );
          const afterTarget = {
            ...beforeTarget,
            metrics: { [metric]: increasedValue }
          };
          const beforeRows = normalizeEvidenceScores([beforeTarget, ...peers], { asOf: FIXED_TIME });
          const afterRows = normalizeEvidenceScores([afterTarget, ...peers], { asOf: FIXED_TIME });
          const before = requiredEvidence(beforeRows, targetId);
          const after = requiredEvidence(afterRows, targetId);
          const context = propertyContext("metric-monotonicity", trial, {
            platform,
            metric,
            targetValue,
            increasedValue
          });

          expect(after.rawEngagement, context).toBeGreaterThan(before.rawEngagement ?? 0);
          expect(after.contributionScore, context).toBeGreaterThanOrEqual(before.contributionScore);
          for (const peer of peers) {
            expect(requiredEvidence(afterRows, peer.id).contributionScore, context).toBe(
              requiredEvidence(beforeRows, peer.id).contributionScore
            );
          }
          expect(aggregateBalancedTractionScore(afterRows).totalScore, context).toBeGreaterThanOrEqual(
            aggregateBalancedTractionScore(beforeRows).totalScore
          );
        }
      }
    );
  });

  describe("metric aliases", () => {
    it.each(ALIAS_CASES)(
      "$platform treats $canonical and $alias as one max-valued signal",
      ({ platform, canonical, alias }) => {
        const rng = deterministicRng(PROPERTY_SEED ^ stableNumber(`${platform}:${canonical}:${alias}`));

        for (let trial = 0; trial < 96; trial += 1) {
          const canonicalValue = rng.int(1, 1_000_000);
          const aliasValue = rng.int(1, 1_000_000);
          const unrelatedMetrics = unrelatedPositiveMetrics(platform, canonical, alias, rng);
          const combined = {
            ...unrelatedMetrics,
            [canonical]: canonicalValue,
            [alias]: aliasValue
          };
          const collapsed = {
            ...unrelatedMetrics,
            [canonical]: Math.max(canonicalValue, aliasValue)
          };
          const context = propertyContext("alias-single-count", trial, {
            platform,
            canonical,
            alias,
            canonicalValue,
            aliasValue
          });

          expect(computeEvidenceRawEngagement(platform, combined), context).toBe(
            computeEvidenceRawEngagement(platform, collapsed)
          );

          const combinedScore = normalizeEvidenceScores(
            [evidence(`alias-combined-${platform}-${canonical}-${trial}`, platform, combined)],
            { asOf: FIXED_TIME }
          )[0];
          const collapsedScore = normalizeEvidenceScores(
            [evidence(`alias-collapsed-${platform}-${canonical}-${trial}`, platform, collapsed)],
            { asOf: FIXED_TIME }
          )[0];

          expect(combinedScore?.contributionScore, context).toBe(collapsedScore?.contributionScore);
        }
      }
    );
  });

  it("keeps fixed-slot platform and entity aggregation monotone under generated mutations", () => {
    const rng = deterministicRng(PROPERTY_SEED ^ 0x51_07_a66);

    for (let trial = 0; trial < 320; trial += 1) {
      const platform = rng.pick(SUPPORTED_PLATFORMS);
      const scores = Array.from({ length: rng.int(1, 12) }, () => rng.int(1, 99));
      const rows = scoredRows(`slots-${trial}`, platform, scores);
      const before = aggregateBalancedTractionScore(rows);
      const mutationIndex = rng.int(0, scores.length - 1);
      const increasedScores = [...scores];
      increasedScores[mutationIndex] = rng.int(scores[mutationIndex]!, 100);
      const after = aggregateBalancedTractionScore(scoredRows(`slots-${trial}`, platform, increasedScores));
      const appendedScore = rng.int(1, 100);
      const appended = aggregateBalancedTractionScore(
        scoredRows(`slots-${trial}`, platform, [...scores, appendedScore])
      );
      const context = propertyContext("fixed-slot-monotonicity", trial, {
        platform,
        scores,
        mutationIndex,
        increasedScores,
        appendedScore
      });

      expect(before.platformScores[platform], context).toBe(expectedPlatformSlotScore(scores));
      expect(after.platformScores[platform], context).toBe(expectedPlatformSlotScore(increasedScores));
      expect(after.platformScores[platform], context).toBeGreaterThanOrEqual(before.platformScores[platform] ?? 0);
      expect(after.totalScore, context).toBeGreaterThanOrEqual(before.totalScore);
      expect(appended.platformScores[platform], context).toBeGreaterThanOrEqual(before.platformScores[platform] ?? 0);
      expect(appended.totalScore, context).toBeGreaterThanOrEqual(before.totalScore);
    }
  });

  it("is invariant to duplicate attribution rows and deterministic input shuffles", () => {
    const rng = deterministicRng(PROPERTY_SEED ^ 0xded0_0e5);

    for (let trial = 0; trial < 40; trial += 1) {
      const groups = Array.from({ length: rng.int(2, 7) }, (_, index) =>
        duplicateXGroup(trial, index, rng.int(5, 50_000))
      );
      const winners = groups.map((group) => group.winner);
      const duplicates = groups.flatMap((group) => group.rows);
      const expectedWinnerIds = winners.map((row) => row.id).sort();
      const expectedProjection = aggregateProjection(
        aggregateBalancedTractionScore(normalizeEvidenceScores(winners, { asOf: FIXED_TIME }))
      );

      for (let shuffleIndex = 0; shuffleIndex < 24; shuffleIndex += 1) {
        const shuffled = rng.shuffle(duplicates);
        const context = propertyContext("dedupe-order-invariance", trial, {
          shuffleIndex,
          inputIds: shuffled.map((row) => row.id)
        });

        expect(
          dedupeEvidenceForScoring(shuffled).map((row) => row.id).sort(),
          context
        ).toEqual(expectedWinnerIds);
        expect(
          aggregateProjection(
            aggregateBalancedTractionScore(normalizeEvidenceScores(shuffled, { asOf: FIXED_TIME }))
          ),
          context
        ).toEqual(expectedProjection);
      }
    }
  });

  it("keeps generated positive evidence score-neutral to missing or invalid dates on every scored platform", () => {
    for (const [platformIndex, platform] of SUPPORTED_PLATFORMS.entries()) {
      const metric = primaryMetric(platform);
      const rng = deterministicRng(PROPERTY_SEED ^ stableNumber(`missing-date:${platform}`));

      for (let trial = 0; trial < 40; trial += 1) {
        const metrics = { [metric]: rng.int(1, 1_000_000) };
        const fresh = normalizeEvidenceScores(
          [evidence(`dated-${platform}-${trial}`, platform, metrics)],
          { asOf: FIXED_TIME }
        )[0];
        const unknown = normalizeEvidenceScores(
          [
            evidence(`unknown-date-${platform}-${trial}`, platform, metrics, {
              publishedAtPrecision: "unknown"
            })
          ],
          { asOf: FIXED_TIME }
        )[0];
        const invalid = normalizeEvidenceScores(
          [
            evidence(`invalid-date-${platform}-${trial}`, platform, metrics, {
              postedAt: "not-a-date",
              publishedAtPrecision: "exact"
            })
          ],
          { asOf: FIXED_TIME }
        )[0];
        const context = propertyContext("missing-date-neutrality", trial, {
          platform,
          platformIndex,
          metric,
          metrics
        });

        expect(unknown?.rawEngagement, context).toBe(fresh?.rawEngagement);
        expect(invalid?.rawEngagement, context).toBe(fresh?.rawEngagement);
        expect(unknown?.normalizedScore, context).toBe(fresh?.normalizedScore);
        expect(invalid?.normalizedScore, context).toBe(fresh?.normalizedScore);
        expect(unknown?.contributionScore, context).toBe(fresh?.contributionScore);
        expect(invalid?.contributionScore, context).toBe(fresh?.contributionScore);
      }
    }
  });

  it("keeps future publication dates neutral and rejects future rejected-row clock poisoning", () => {
    const rng = deterministicRng(PROPERTY_SEED ^ 0xf070_12e);

    for (let trial = 0; trial < 144; trial += 1) {
      const platformIndex = trial % SUPPORTED_PLATFORMS.length;
      const platform = SUPPORTED_PLATFORMS[platformIndex]!;
      const otherPlatform = SUPPORTED_PLATFORMS[(platformIndex + 1) % SUPPORTED_PLATFORMS.length]!;
      const metric = primaryMetric(platform);
      const otherMetric = primaryMetric(otherPlatform);
      const metrics = { [metric]: rng.int(1, 1_000_000) };
      const target = evidence(`temporal-target-${trial}`, platform, metrics);
      const future = evidence(
        `temporal-future-${trial}`,
        otherPlatform,
        { [otherMetric]: rng.int(1, 1_000_000) },
        { postedAt: FUTURE_TIME }
      );
      const rejected = evidence(
        `temporal-rejected-${trial}`,
        platform,
        { [metric]: Number.MAX_SAFE_INTEGER },
        {
          review_state: "rejected",
          postedAt: FUTURE_TIME,
          observedAt: FUTURE_TIME,
          metricsCheckedAt: FUTURE_TIME,
          last_checked_at: FUTURE_TIME
        }
      );
      const baseline = requiredEvidence(normalizeEvidenceScores([target]), target.id);
      const augmented = normalizeEvidenceScores([target, future, rejected]);
      const augmentedTarget = requiredEvidence(augmented, target.id);
      const futureEquivalent = normalizeEvidenceScores(
        [evidence(`temporal-future-equivalent-${trial}`, platform, metrics, { postedAt: FUTURE_TIME })],
        { asOf: FIXED_TIME }
      )[0];
      const freshEquivalent = normalizeEvidenceScores(
        [evidence(`temporal-fresh-equivalent-${trial}`, platform, metrics)],
        { asOf: FIXED_TIME }
      )[0];
      const context = propertyContext("future-rejected-neutrality", trial, {
        platform,
        otherPlatform,
        metric,
        metrics
      });

      expect(augmentedTarget.contributionScore, context).toBe(baseline.contributionScore);
      expect(requiredEvidence(augmented, rejected.id).contributionScore, context).toBe(0);
      expect(futureEquivalent?.contributionScore, context).toBe(freshEquivalent?.contributionScore);
    }
  });

  it("returns canonical zero state when no evidence is scoreable", () => {
    const excluded = SUPPORTED_PLATFORMS.flatMap((platform, index) => {
      const metric = primaryMetric(platform);
      return [
        evidence(`zero-metrics-${platform}`, platform, {}),
        evidence(`rejected-${platform}`, platform, { [metric]: index + 1 }, { review_state: "rejected" }),
        evidence(`blocked-${platform}`, platform, { [metric]: index + 1 }, { linkStatus: "blocked" }),
        evidence(`upstream-zero-${platform}`, platform, { [metric]: index + 1 }, { contributionScore: 0 })
      ];
    });
    const normalized = normalizeEvidenceScores(excluded, { asOf: FIXED_TIME });
    const empty = aggregateBalancedTractionScore([]);
    const excludedAggregate = aggregateBalancedTractionScore(normalized);

    expect(normalizeEvidenceScores([])).toEqual([]);
    expect(normalized.every((row) => row.contributionScore === 0)).toBe(true);
    expect(aggregateProjection(excludedAggregate)).toEqual(aggregateProjection(empty));
    expect(empty).toEqual(
      expect.objectContaining({
        totalScore: 0,
        absoluteScore: 0,
        weightedAvailableScore: 0,
        coverageFactor: 0,
        platformsWithEvidence: 0,
        platformScores: {},
        weightedPlatforms: [],
        evidenceAsOf: null,
        calibration: { method: "none", cohortSize: 0, percentile: null, inputScore: 0 }
      })
    );

    const zeroCompany = calibrationCompany("zero-company", empty);
    expect(calibrateBatchCompanyScores([])).toEqual([]);
    expect(calibrateBatchCompanyScores([zeroCompany])[0]).toEqual(
      expect.objectContaining({
        id: zeroCompany.id,
        totalScore: 0,
        previousScore: 0,
        scoreBreakdown: expect.objectContaining({
          absoluteScore: 0,
          totalScore: 0,
          calibration: { method: "none", cohortSize: 0, percentile: null, inputScore: 0 }
        })
      })
    );
  });

  it("preserves every finite generated absolute input exactly", () => {
    const rng = deterministicRng(PROPERTY_SEED ^ 0xca11_ba7e);

    for (let trial = 0; trial < 160; trial += 1) {
      const scores = [
        Number.MIN_VALUE,
        rng.next() / 1_000_000,
        ...Array.from({ length: rng.int(1, 18) }, () => rng.next() * 100),
        100,
        0
      ];
      const companies = scores.map((score, index) => companyWithAbsoluteScore(`positive-${trial}-${index}`, score));
      const calibrated = calibrateBatchCompanyScores(companies);
      const context = propertyContext("positive-calibration", trial, { scores });

      expect(calibrated.map((company) => company.id), context).toEqual(companies.map((company) => company.id));
      for (const [index, company] of calibrated.entries()) {
        expect(company.totalScore, context).toBe(scores[index]);
        expect(company.scoreBreakdown?.calibration.method, context).toBe("none");
        expect(company.scoreBreakdown?.calibration.percentile, context).toBeNull();
      }

      const positive = calibrated
        .filter((company) => (company.scoreBreakdown?.absoluteScore ?? 0) > 0)
        .sort(
          (left, right) =>
            (left.scoreBreakdown?.absoluteScore ?? 0) - (right.scoreBreakdown?.absoluteScore ?? 0)
        );
      for (let index = 1; index < positive.length; index += 1) {
        expect(positive[index]!.totalScore, context).toBeGreaterThanOrEqual(positive[index - 1]!.totalScore);
      }
    }
  });

  it("keeps absolute scores and stable competition ranks across generated permutations", () => {
    const rng = deterministicRng(PROPERTY_SEED ^ 0x71e0_a4e5);

    for (let trial = 0; trial < 48; trial += 1) {
      const tiedScore = rng.int(10, 90);
      const rawScores = [
        rng.int(1, tiedScore - 1),
        tiedScore,
        tiedScore,
        tiedScore,
        rng.int(tiedScore + 1, 100),
        rng.int(tiedScore + 1, 100),
        0
      ];
      const companies = rawScores.map((score, index) => companyWithAbsoluteScore(`rank-${trial}-${index}`, score));
      const baseline = calibrateBatchCompanyScores(companies);
      const expectedById = calibrationProjection(baseline);
      for (const tied of baseline.filter((company) => company.scoreBreakdown?.absoluteScore === tiedScore)) {
        expect(tied.scoreBreakdown?.calibration.percentile).toBeNull();
        expect(tied.totalScore).toBe(tiedScore);
      }

      for (let shuffleIndex = 0; shuffleIndex < 20; shuffleIndex += 1) {
        const shuffled = rng.shuffle(companies);
        const calibrated = calibrateBatchCompanyScores(shuffled);
        const context = propertyContext("tie-aware-stable-ranks", trial, {
          shuffleIndex,
          tiedScore,
          rawScores,
          inputIds: shuffled.map((company) => company.id)
        });

        expect(calibrated.map((company) => company.id), context).toEqual(shuffled.map((company) => company.id));
        expect(calibrationProjection(calibrated), context).toEqual(expectedById);

        const graph = buildGraphResponse(
          { batchSlug: "property-batch", similarityThreshold: 1 },
          graphDataset(calibrated)
        );
        const ranks = new Map(graph.leaderboard.map((row) => [row.companyId, row.rank]));

        for (const company of calibrated) {
          const expectedRank =
            1 + calibrated.filter((candidate) => candidate.totalScore > company.totalScore).length;
          expect(ranks.get(company.id), context).toBe(expectedRank);
        }

        for (const score of new Set(calibrated.map((company) => company.totalScore))) {
          const expectedCompanyIds = calibrated
            .filter((company) => company.totalScore === score)
            .sort(
              (left, right) =>
                left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
            )
            .map((company) => company.id);
          expect(
            graph.leaderboard.filter((row) => row.score === score).map((row) => row.companyId),
            context
          ).toEqual(expectedCompanyIds);
        }
      }
    }
  });

  it("bounds every canonical score under generated finite and overflow-scale metrics", () => {
    const rng = deterministicRng(PROPERTY_SEED ^ 0xb0a0_d5);
    const metricValues = [
      -Number.MAX_VALUE,
      -1_000_000,
      -1,
      0,
      Number.MIN_VALUE,
      0.000_001,
      1,
      10_000,
      1_000_000_000_000,
      Number.MAX_VALUE
    ];

    for (let trial = 0; trial < 256; trial += 1) {
      const rows = Array.from({ length: rng.int(1, 24) }, (_, index) => {
        const platform = rng.pick(SUPPORTED_PLATFORMS);
        const metrics = Object.fromEntries(
          configuredMetrics(platform).map((metric) => [metric, rng.pick(metricValues)])
        );
        return evidence(`bounds-${trial}-${index}`, platform, metrics);
      });
      const normalized = normalizeEvidenceScores(rows, { asOf: FIXED_TIME });
      const aggregate = aggregateBalancedTractionScore(normalized);
      const context = propertyContext("score-bounds", trial, {
        rows: rows.map((row) => ({ id: row.id, platform: row.platform, metrics: row.metrics }))
      });

      for (const row of normalized) {
        expectScore(row.contributionScore, context);
        expectScore(row.normalizedScore ?? 0, context);
        expect(Number.isFinite(row.rawEngagement ?? 0), context).toBe(true);
        expect(JSON.parse(JSON.stringify(row)).rawEngagement, context).not.toBeNull();
      }
      expectBreakdownScores(aggregate, context);

      const calibrationInputs = [
        companyWithAbsoluteScore(`bounds-negative-${trial}`, -rng.int(1, 1_000_000)),
        calibrationCompany(`bounds-aggregate-${trial}`, aggregate),
        companyWithAbsoluteScore(`bounds-overflow-${trial}`, Number.MAX_VALUE)
      ];
      for (const company of calibrateBatchCompanyScores(calibrationInputs)) {
        expectScore(company.totalScore, context);
        expectScore(company.previousScore, context);
        expectScore(company.scoreBreakdown?.totalScore ?? 0, context);
        expectScore(company.scoreBreakdown?.absoluteScore ?? 0, context);
      }
    }
  });
});

function evidence(
  id: string,
  platform: Platform,
  metrics: EvidenceMetrics,
  overrides: Partial<EvidenceItem> = {}
): EvidenceItem {
  const { metrics: overrideMetrics, ...itemOverrides } = overrides;
  return {
    id,
    entityType: "company",
    entityId: "property-company",
    platform,
    authorName: "Property Fixture",
    authorHandle: "propertyfixture",
    postedAt: FIXED_TIME,
    publishedAtPrecision: "exact",
    observedAt: FIXED_TIME,
    metricsCheckedAt: FIXED_TIME,
    text: "Deterministic canonical v4 property fixture",
    mediaType: mediaTypeFor(platform),
    linkStatus: "verified",
    contributionScore: 1,
    sourceUrl: nativeUrl(platform, stableNumber(id)),
    platformPostId: null,
    first_seen_at: FIXED_TIME,
    last_checked_at: FIXED_TIME,
    last_updated_at: FIXED_TIME,
    why: "Deterministic property fixture.",
    review_state: "verified",
    ...itemOverrides,
    metrics: overrideMetrics ?? metrics
  };
}

function scoredRows(prefix: string, platform: Platform, scores: number[]): EvidenceItem[] {
  return scores.map((score, index) =>
    evidence(`${prefix}-${index}`, platform, positiveMetrics(platform), { contributionScore: score })
  );
}

function duplicateXGroup(
  trial: number,
  index: number,
  metricValue: number
): { winner: EvidenceItem; rows: EvidenceItem[] } {
  const postId = String(1_849_812_345_000_000_000n + BigInt(trial * 100 + index + 1));
  const loser = evidence(`duplicate-${trial}-${index}-loser`, "x", { likes: metricValue }, {
    entityId: `company-${trial}`,
    sourceUrl: `https://x.com/propertyfixture/status/${postId}?utm_source=company`,
    platformPostId: null,
    contributionScore: 20,
    observedAt: "2026-07-13T12:00:00.000Z",
    metricsCheckedAt: "2026-07-13T12:00:00.000Z",
    last_checked_at: "2026-07-13T12:00:00.000Z"
  });
  const winner = evidence(`duplicate-${trial}-${index}-winner`, "x", {
    views: metricValue * 10,
    likes: metricValue + 1
  }, {
    entityType: "founder",
    entityId: `founder-${trial}`,
    sourceUrl: `https://twitter.com/propertyfounder/status/${postId}?s=20`,
    platformPostId: postId,
    contributionScore: 30,
    observedAt: FIXED_TIME,
    metricsCheckedAt: FIXED_TIME,
    last_checked_at: FIXED_TIME
  });
  const rejected = evidence(`duplicate-${trial}-${index}-rejected`, "x", {
    views: Number.MAX_SAFE_INTEGER,
    likes: Number.MAX_SAFE_INTEGER
  }, {
    entityId: `rejected-${trial}`,
    sourceUrl: `https://x.com/rejected/status/${postId}`,
    platformPostId: postId,
    contributionScore: 100,
    review_state: "rejected",
    observedAt: FUTURE_TIME,
    metricsCheckedAt: FUTURE_TIME,
    last_checked_at: FUTURE_TIME
  });
  return { winner, rows: [loser, winner, rejected] };
}

function aggregateProjection(breakdown: ScoreBreakdown) {
  return {
    totalScore: breakdown.totalScore,
    absoluteScore: breakdown.absoluteScore,
    weightedAvailableScore: breakdown.weightedAvailableScore,
    coverageFactor: breakdown.coverageFactor,
    platformsWithEvidence: breakdown.platformsWithEvidence,
    platformScores: Object.entries(breakdown.platformScores).sort(([left], [right]) =>
      left.localeCompare(right)
    ),
    weightedPlatforms: breakdown.weightedPlatforms,
    signalFamilyScores: breakdown.signalFamilyScores,
    confidence: breakdown.confidence,
    evidenceAsOf: breakdown.evidenceAsOf
  };
}

function calibrationProjection(companies: CompanyRecord[]) {
  return Object.fromEntries(
    companies
      .map((company) => [
        company.id,
        {
          totalScore: company.totalScore,
          absoluteScore: company.scoreBreakdown?.absoluteScore,
          percentile: company.scoreBreakdown?.calibration.percentile,
          method: company.scoreBreakdown?.calibration.method,
          cohortSize: company.scoreBreakdown?.calibration.cohortSize
        }
      ] as const)
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function expectedPlatformSlotScore(scores: number[]): number {
  return Math.round(
    [...scores]
      .sort((left, right) => right - left)
      .slice(0, TRACTION_SCORING_CONFIG.platformEvidenceSlots.length)
      .reduce(
        (sum, score, index) =>
          sum + score * (TRACTION_SCORING_CONFIG.platformEvidenceSlots[index] ?? 0),
        0
      )
  );
}

function unrelatedPositiveMetrics(
  platform: Platform,
  canonical: string,
  alias: string,
  rng: DeterministicRng
): EvidenceMetrics {
  const unrelated = configuredMetrics(platform).find(
    (metric) => metric !== canonical && metric !== alias
  );
  return unrelated ? { [unrelated]: rng.int(1, 10_000) } : {};
}

function primaryMetric(platform: Platform): string {
  const metric = configuredMetrics(platform)[0];
  if (!metric) throw new Error(`No positive configured metric for ${platform}`);
  return metric;
}

function configuredMetrics(platform: Platform): string[] {
  return Object.entries(TRACTION_SCORING_CONFIG.metricWeights[platform] ?? {})
    .filter(([, weight]) => Number.isFinite(weight) && Number(weight) > 0)
    .map(([metric]) => metric);
}

function positiveMetrics(platform: Platform): EvidenceMetrics {
  return { [primaryMetric(platform)]: 1 };
}

function companyWithAbsoluteScore(id: string, absoluteScore: number): CompanyRecord {
  const empty = aggregateBalancedTractionScore([]);
  return calibrationCompany(id, {
    ...empty,
    totalScore: absoluteScore,
    absoluteScore,
    calibration: { ...empty.calibration, inputScore: absoluteScore }
  });
}

function calibrationCompany(id: string, scoreBreakdown: ScoreBreakdown): CompanyRecord {
  return {
    id,
    batchSlug: "property-batch",
    name: id,
    ycProfileUrl: `https://www.ycombinator.com/companies/${id}`,
    websiteUrl: `https://${id}.example.com`,
    tagline: "Deterministic scoring property fixture",
    description: `Deterministic scoring property fixture ${id}`,
    groupPartner: null,
    primaryIndustry: "financial-services",
    businessModel: "b2b",
    review_state: "verified",
    sourceUrl: `https://www.ycombinator.com/companies/${id}`,
    industries: [`property-${id}`],
    founderIds: [],
    socialAccounts: [],
    totalScore: scoreBreakdown.absoluteScore,
    previousScore: scoreBreakdown.absoluteScore,
    platformScores: scoreBreakdown.platformScores,
    scoreBreakdown
  };
}

function graphDataset(companies: CompanyRecord[]): DemoGraphDataset {
  return {
    mode: "demo",
    batches: [
      {
        slug: "property-batch",
        label: "Property batch",
        companyCountExpected: companies.length,
        companyCountObserved: companies.length
      }
    ],
    companies,
    founders: [],
    evidence: [],
    needsReview: [],
    platformStatus: []
  };
}

function expectBreakdownScores(breakdown: ScoreBreakdown, context: string): void {
  expectScore(breakdown.totalScore, context);
  expectScore(breakdown.absoluteScore, context);
  expectScore(breakdown.weightedAvailableScore, context);
  for (const score of Object.values(breakdown.platformScores)) expectScore(score, context);
  for (const item of breakdown.weightedPlatforms) {
    expectScore(item.score, context);
    expectScore(item.contribution, context);
  }
  for (const score of Object.values(breakdown.signalFamilyScores)) expectScore(score, context);
  expect(breakdown.confidence.value, context).toBeGreaterThanOrEqual(0);
  expect(breakdown.confidence.value, context).toBeLessThanOrEqual(1);
}

function expectScore(score: number, context: string): void {
  expect(Number.isFinite(score), context).toBe(true);
  expect(score, context).toBeGreaterThanOrEqual(0);
  expect(score, context).toBeLessThanOrEqual(100);
}

function requiredEvidence(rows: EvidenceItem[], id: string): EvidenceItem {
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`Expected generated evidence row ${id}`);
  return row;
}

function nativeUrl(platform: Platform, index: number): string {
  const suffix = Math.max(1, Math.floor(index));
  switch (platform) {
    case "x":
      return `https://x.com/propertyfixture/status/${1_849_812_345_000_000_000n + BigInt(suffix)}`;
    case "instagram":
      return `https://www.instagram.com/reel/Property${suffix}/`;
    case "linkedin":
      return `https://www.linkedin.com/posts/property_traction-activity-${7_468_000_000_000_000_000n + BigInt(suffix)}-p`;
    case "github":
      return `https://github.com/property-fixture/repository-${suffix}`;
    case "youtube":
      return `https://www.youtube.com/watch?v=Property${suffix}`;
    case "product_hunt":
      return `https://www.producthunt.com/posts/property-${suffix}`;
    case "hacker_news":
      return `https://news.ycombinator.com/item?id=${40_000_000 + (suffix % 9_000_000)}`;
    case "reddit":
      return `https://www.reddit.com/r/startups/comments/p${suffix.toString(36)}/property_test/`;
    case "bilibili":
      return `https://www.bilibili.com/video/BVProperty${suffix}/`;
    default:
      throw new Error(`No canonical scoring URL fixture for ${platform}`);
  }
}

function mediaTypeFor(platform: Platform): EvidenceItem["mediaType"] {
  if (platform === "github") return "repo";
  if (platform === "product_hunt") return "launch";
  if (["instagram", "youtube", "bilibili"].includes(platform)) return "video";
  return "text";
}

function stableNumber(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) + 1;
}

function propertyContext(
  property: string,
  trial: number,
  details: Record<string, unknown>
): string {
  return `${property} failed (seed=${PROPERTY_SEED}, trial=${trial}): ${JSON.stringify(details)}`;
}

interface DeterministicRng {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(values: readonly T[]): T;
  shuffle<T>(values: readonly T[]): T[];
}

function deterministicRng(seed: number): DeterministicRng {
  let state = seed >>> 0 || 0x9e37_79b9;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };

  return {
    next,
    int(min, max) {
      if (max < min) throw new RangeError(`Invalid deterministic range ${min}..${max}`);
      return min + Math.floor(next() * (max - min + 1));
    },
    pick<T>(values: readonly T[]): T {
      if (!values.length) throw new RangeError("Cannot pick from an empty deterministic collection");
      return values[Math.floor(next() * values.length)]!;
    },
    shuffle<T>(values: readonly T[]): T[] {
      const shuffled = [...values];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(next() * (index + 1));
        [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
      }
      return shuffled;
    }
  };
}
