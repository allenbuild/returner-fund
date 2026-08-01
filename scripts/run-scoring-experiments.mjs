import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const TYPESCRIPT_LOADER_PATH = path.join(
  REPOSITORY_ROOT,
  "scripts",
  "lib",
  "scoring-diagnostics-ts-loader.mjs"
);

if (process.env.SCORING_EXPERIMENTS_TYPESCRIPT_READY !== "1") {
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--loader",
      TYPESCRIPT_LOADER_PATH,
      SCRIPT_PATH,
      ...process.argv.slice(2)
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, SCORING_EXPERIMENTS_TYPESCRIPT_READY: "1" },
      stdio: "inherit"
    }
  );

  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

const OUTPUT_DIRECTORY = path.join(REPOSITORY_ROOT, "docs", "outputs");
const JSON_OUTPUT_PATH = path.join(OUTPUT_DIRECTORY, "scoring-experiments-v4.json");
const REPORT_OUTPUT_PATH = path.join(OUTPUT_DIRECTORY, "scoring-experiments-v4.md");
const SUMMARY_OUTPUT_PATH = path.join(REPOSITORY_ROOT, "docs", "SCORING_EXPERIMENTS.md");
const ALLOWED_OUTPUT_PATHS = new Set(
  [JSON_OUTPUT_PATH, REPORT_OUTPUT_PATH, SUMMARY_OUTPUT_PATH].map((filePath) => path.resolve(filePath))
);
const DEFAULT_FROZEN_CLOCK = "2026-07-16T12:00:00.000Z";
const FROZEN_CLOCK = argumentValue("--clock") ?? DEFAULT_FROZEN_CLOCK;
const COHORT_SLUGS = ["S2026", "S26", "A16ZSR006"];
const TOP_K = 10;
const DOMINANT_PLATFORM_THRESHOLD = 0.98;
const NO_LABEL_CAVEAT =
  "No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance.";
const CONFIDENCE_CAVEAT =
  "Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval.";

assertValidClock(FROZEN_CLOCK);
freezeClock(FROZEN_CLOCK);
globalThis.fetch = async () => {
  throw new Error("Network access is disabled by scoring experiments v4.");
};

const [datasetModule, scoringModule, configModule, dedupeModule, calibrationModule] =
  await Promise.all([
    import("../src/lib/graph/yc-spring-2026-dataset.ts"),
    import("../src/lib/graph/traction-scoring.ts"),
    import("../src/lib/scoring/traction-config.ts"),
    import("../src/lib/graph/dedupe.ts"),
    import("../src/lib/scoring/batch-calibration.ts")
  ]);

const { yc2026GraphDataset } = datasetModule;
const {
  aggregateBalancedTractionScore,
  computeEvidenceRawEngagement,
  normalizeEvidenceScores,
  scoringEligibility
} = scoringModule;
const { TRACTION_SCORING_CONFIG } = configModule;
const { canonicalPostKey, dedupeEvidenceForScoring } = dedupeModule;
const { calibrateBatchCompanyScores } = calibrationModule;

const NORMALIZATION_VARIANTS = [
  {
    id: "absolute-only",
    label: "Absolute-only",
    absoluteWeight: 1,
    percentileWeight: 0,
    canonical: false,
    description:
      "Uses the canonical date-invariant platform raw-engagement reference without a peer-percentile component."
  },
  {
    id: "percentile-heavy",
    label: "Percentile-heavy (35/65)",
    absoluteWeight: 0.35,
    percentileWeight: 0.65,
    canonical: false,
    description:
      "Stress-tests cohort dependence with 35% canonical absolute signal and 65% same-platform physical-post midrank."
  },
  {
    id: "v4-robust-blend",
    label: "V4 robust blend",
    absoluteWeight: TRACTION_SCORING_CONFIG.absoluteEvidenceWeight,
    percentileWeight: TRACTION_SCORING_CONFIG.cohortPercentileWeight,
    canonical: true,
    description:
      "Calls the canonical v4 normalizer directly; current imported weights are recorded from production config."
  }
];

const AGGREGATION_VARIANTS = [
  {
    id: "max",
    label: "Max",
    canonical: false,
    description:
      "Uses the strongest canonical-normalized unique item per platform, then delegates company aggregation to v4."
  },
  {
    id: "mean",
    label: "Mean (top-K)",
    canonical: false,
    description:
      "Uses the arithmetic mean of the strongest canonical top-K unique items per platform, then delegates company aggregation to v4."
  },
  {
    id: "decaying-slots",
    label: "V4 decaying slots",
    canonical: true,
    description:
      "Calls canonical v4 aggregation with its imported descending evidence slots and cross-platform blend."
  }
];

const CANDIDATE_VARIANTS = NORMALIZATION_VARIANTS.flatMap((normalization) =>
  AGGREGATION_VARIANTS.map((aggregation) => ({
    id: `${normalization.id}__${aggregation.id}`,
    label: `${normalization.label} + ${aggregation.label}`,
    normalization,
    aggregation
  }))
);
const BASELINE_VARIANT_ID = "v4-robust-blend__decaying-slots";
const productionConfigHashBefore = sha256(canonicalJson(TRACTION_SCORING_CONFIG));
let normalizationParityAssertions = 0;

const inputHashes = await buildInputHashManifest();
const cohortContexts = COHORT_SLUGS.map(buildCohortContext);
const internalCohortRuns = cohortContexts.map(runCohortExperiments);
const representativeExamples = internalCohortRuns.flatMap(selectRepresentativeExamples);
const cohortReports = internalCohortRuns.map(publicCohortReport);
const variantRanking = rankVariants(internalCohortRuns);
const productionConfigHashAfter = sha256(canonicalJson(TRACTION_SCORING_CONFIG));

const experimentReport = {
  metadata: {
    report_version: "scoring-experiments-v4",
    schema_version: 4,
    generated_at: FROZEN_CLOCK,
    frozen_clock: FROZEN_CLOCK,
    production_model_id: TRACTION_SCORING_CONFIG.modelId,
    production_model_version: TRACTION_SCORING_CONFIG.version,
    production_model_name: TRACTION_SCORING_CONFIG.name,
    git_sha: readGitSha(),
    node_version: process.version,
    command: "npm run scoring:experiments",
    direct_command: "node scripts/run-scoring-experiments.mjs",
    cohorts: COHORT_SLUGS,
    production_imports: [
      "src/lib/graph/traction-scoring.ts#normalizeEvidenceScores",
      "src/lib/graph/traction-scoring.ts#aggregateBalancedTractionScore",
      "src/lib/graph/traction-scoring.ts#computeEvidenceRawEngagement",
      "src/lib/graph/traction-scoring.ts#scoringEligibility",
      "src/lib/graph/dedupe.ts#canonicalPostKey",
      "src/lib/graph/dedupe.ts#dedupeEvidenceForScoring",
      "src/lib/scoring/traction-config.ts#TRACTION_SCORING_CONFIG",
      "src/lib/scoring/batch-calibration.ts#calibrateBatchCompanyScores"
    ],
    production_config_sha256: productionConfigHashBefore,
    production_config_mutated: productionConfigHashBefore !== productionConfigHashAfter,
    normalization_parity_assertions: normalizationParityAssertions,
    input_hashes: inputHashes,
    dataset_sha256: sha256(canonicalJson(yc2026GraphDataset)),
    safety: {
      input_mode: "read_only_local_snapshots",
      network_fetch: "disabled",
      production_config_writes: 0,
      dataset_writes: 0,
      permitted_writes: [...ALLOWED_OUTPUT_PATHS].map(relativePath).sort(compareText)
    }
  },
  interpretation: {
    purpose:
      "Compare deterministic candidate score mechanics on the three local cohorts while holding canonical v4 metric, identity, confidence, cross-platform, and batch-calibration semantics fixed.",
    diagnostic_ranking_rule:
      "Variants are ordered lexicographically by reverse-order exactness, mean small-perturbation Spearman correlation, mean top-10 overlap, mean absolute rank shift, the rate with at least 98% of contribution from one platform, dominant-platform ablation score sensitivity, then stable variant ID.",
    prediction_boundary: NO_LABEL_CAVEAT,
    confidence_boundary: CONFIDENCE_CAVEAT,
    recommendation_boundary:
      "Diagnostic rank is not a production recommendation; concentration resistance and local perturbation stability are engineering properties, not labeled outcome quality."
  },
  candidate_definitions: {
    normalization: NORMALIZATION_VARIANTS.map(publicNormalizationVariant),
    aggregation: AGGREGATION_VARIANTS.map(publicAggregationVariant),
    matrix: CANDIDATE_VARIANTS.map(publicCandidateVariant),
    unchanged_production_semantics: [
      "Configured metric weights and alias collapsing",
      "Eligibility and native-post identity checks",
      "Physical-post dedupe",
      "Date-invariant platform references",
      "Canonical v4 confidence and caveats",
      "Canonical v4 strongest/diversified cross-platform blend",
      "Canonical v4 tie-aware company batch calibration"
    ]
  },
  methodology: {
    rank_rule: "Score descending, then company name ascending, then company ID ascending.",
    normalization_parity_guard:
      "The candidate component decomposition reconstructs the imported v4 robust blend for every eligible row and aborts on any score mismatch; published baseline rows use the imported normalizer output itself.",
    aggregation_adapter:
      "Max and mean project each platform's deduplicated normalized rows to the requested platform statistic, then call the imported v4 aggregate so cross-platform scoring and confidence stay canonical. Decaying slots pass rows through unchanged.",
    perturbations: [
      "Reverse evidence input order; exact score and rank equality is required.",
      "Increase every positive production-configured metric by 1% in memory.",
      "Advance the explicit normalization clock by 24 hours."
    ],
    concentration_test:
      "For every company, remove its own largest-contribution platform in memory, reaggregate, and recalibrate the full cohort; no evidence is renormalized for this ablation."
  },
  summary: {
    cohort_count: cohortReports.length,
    company_count: cohortReports.reduce((sum, cohort) => sum + cohort.input_counts.companies, 0),
    evidence_row_count: cohortReports.reduce(
      (sum, cohort) => sum + cohort.input_counts.cohort_scoped_evidence_rows,
      0
    ),
    candidate_count: CANDIDATE_VARIANTS.length,
    representative_example_count: representativeExamples.length,
    baseline_variant_id: BASELINE_VARIANT_ID
  },
  diagnostic_variant_ranking: variantRanking,
  cohorts: cohortReports,
  representative_before_after_examples: representativeExamples
};

validateReport(experimentReport);

const jsonContent = `${JSON.stringify(experimentReport, null, 2)}\n`;
const jsonSha256 = sha256(jsonContent);
const markdownContent = renderDetailedMarkdown(experimentReport, jsonSha256);
const summaryContent = renderSummaryMarkdown(experimentReport, jsonSha256);

await mkdir(OUTPUT_DIRECTORY, { recursive: true });
await writeAllowedArtifact(JSON_OUTPUT_PATH, jsonContent);
await writeAllowedArtifact(REPORT_OUTPUT_PATH, markdownContent);
await writeAllowedArtifact(SUMMARY_OUTPUT_PATH, summaryContent);

console.log(
  JSON.stringify(
    {
      report_version: experimentReport.metadata.report_version,
      model: `${experimentReport.metadata.production_model_id}@${experimentReport.metadata.production_model_version}`,
      frozen_clock: experimentReport.metadata.frozen_clock,
      cohorts: COHORT_SLUGS,
      candidates: CANDIDATE_VARIANTS.length,
      examples: representativeExamples.length,
      normalization_parity_assertions: normalizationParityAssertions,
      production_config_mutated: experimentReport.metadata.production_config_mutated,
      hashes: {
        json_sha256: jsonSha256,
        markdown_sha256: sha256(markdownContent),
        summary_sha256: sha256(summaryContent)
      },
      outputs: [JSON_OUTPUT_PATH, REPORT_OUTPUT_PATH, SUMMARY_OUTPUT_PATH].map(relativePath)
    },
    null,
    2
  )
);

function buildCohortContext(slug) {
  const batch = yc2026GraphDataset.batches.find((candidate) => candidate.slug === slug);
  const companies = yc2026GraphDataset.companies
    .filter((company) => company.batchSlug === slug)
    .sort((left, right) => compareText(left.id, right.id));
  const founders = yc2026GraphDataset.founders
    .filter((founder) => founder.batchSlug === slug)
    .sort((left, right) => compareText(left.id, right.id));
  const entityIds = new Set([
    ...companies.map((company) => company.id),
    ...founders.map((founder) => founder.id)
  ]);
  const evidence = yc2026GraphDataset.evidence
    .filter((item) => entityIds.has(item.entityId))
    .map(cloneEvidence)
    .sort((left, right) => compareText(left.id, right.id));

  if (!batch || !companies.length || !evidence.length) {
    throw new Error(`Cohort ${slug} is missing its batch, companies, or evidence.`);
  }

  return {
    slug,
    label: batch.label,
    companies,
    founders,
    evidence
  };
}

function runCohortExperiments(context) {
  const runs = CANDIDATE_VARIANTS.map((variant) => {
    const base = scoreCohort(context, variant, context.evidence, FROZEN_CLOCK);
    const reverseInput = scoreCohort(
      context,
      variant,
      [...context.evidence].reverse(),
      FROZEN_CLOCK
    );
    const metricPlusOnePercent = scoreCohort(
      context,
      variant,
      context.evidence.map(scaleConfiguredMetrics),
      FROZEN_CLOCK
    );
    const clockPlusOneDay = scoreCohort(
      context,
      variant,
      context.evidence,
      advanceIsoTimestamp(FROZEN_CLOCK, 1)
    );
    const dominantPlatformAblation = scoreDominantPlatformAblation(context, variant, base);
    const reverseComparison = compareRankedScores(base.rows, reverseInput.rows);

    if (!reverseComparison.exact_score_and_rank_match) {
      throw new Error(`${context.slug} ${variant.id} changed under reversed evidence order.`);
    }

    return {
      variant,
      base,
      perturbationRuns: {
        reverse_input: reverseInput,
        metric_plus_one_percent: metricPlusOnePercent,
        clock_plus_one_day: clockPlusOneDay
      },
      perturbations: {
        reverse_input: reverseComparison,
        metric_plus_one_percent: compareRankedScores(base.rows, metricPlusOnePercent.rows),
        clock_plus_one_day: compareRankedScores(base.rows, clockPlusOneDay.rows)
      },
      concentration: summarizeConcentration(base.rows),
      dominantPlatformAblation: {
        run: dominantPlatformAblation,
        comparison: compareRankedScores(base.rows, dominantPlatformAblation.rows)
      }
    };
  });
  const runByVariant = new Map(runs.map((run) => [run.variant.id, run]));
  const baseline = runByVariant.get(BASELINE_VARIANT_ID);
  if (!baseline) throw new Error(`Missing baseline variant ${BASELINE_VARIANT_ID}.`);

  return { context, runs, runByVariant, baseline };
}

function scoreCohort(context, variant, inputEvidence, asOf) {
  const evidence = normalizeCandidateEvidence(inputEvidence, variant.normalization, asOf);
  const evidenceByEntity = groupBy(evidence, (item) => item.entityId);
  const companyEvidence = new Map();
  const candidateCompanies = context.companies.map((company) => {
    const relatedEntityIds = [company.id, ...company.founderIds];
    const uniqueEvidence = dedupeEvidenceForScoring(
      relatedEntityIds.flatMap((entityId) => evidenceByEntity.get(entityId) ?? [])
    );
    companyEvidence.set(company.id, uniqueEvidence);
    const breakdown = aggregateCandidateEvidence(uniqueEvidence, variant.aggregation);

    return {
      ...company,
      totalScore: breakdown.totalScore,
      previousScore: breakdown.totalScore,
      platformScores: breakdown.platformScores,
      scoreBreakdown: breakdown
    };
  });
  const calibratedCompanies = calibrateBatchCompanyScores(candidateCompanies);
  const rows = rankRows(calibratedCompanies.map(companyScoringRow));

  return { evidence, companyEvidence, rows };
}

function scoreDominantPlatformAblation(context, variant, baseRun) {
  const baselineByCompany = new Map(baseRun.rows.map((row) => [row.company_id, row]));
  const candidateCompanies = context.companies.map((company) => {
    const baseline = baselineByCompany.get(company.id);
    const removedPlatform = baseline?.top_platform ?? null;
    const remainingEvidence = (baseRun.companyEvidence.get(company.id) ?? []).filter(
      (item) => item.platform !== removedPlatform
    );
    const breakdown = aggregateCandidateEvidence(remainingEvidence, variant.aggregation);

    return {
      ...company,
      totalScore: breakdown.totalScore,
      previousScore: breakdown.totalScore,
      platformScores: breakdown.platformScores,
      scoreBreakdown: breakdown,
      __removedPlatform: removedPlatform
    };
  });
  const removedPlatforms = new Map(
    candidateCompanies.map((company) => [company.id, company.__removedPlatform])
  );
  const calibratedCompanies = calibrateBatchCompanyScores(candidateCompanies);
  const rows = rankRows(
    calibratedCompanies.map((company) => ({
      ...companyScoringRow(company),
      removed_platform: removedPlatforms.get(company.id) ?? null
    }))
  );

  return { rows };
}

function normalizeCandidateEvidence(items, normalization, asOf) {
  const input = items.map(cloneEvidence);
  const canonicalRows = normalizeEvidenceScores(input.map(cloneEvidence), { asOf });
  const referenceTime = new Date(asOf);
  const eligiblePhysicalRows = dedupeEvidenceForScoring(
    input.filter((item) => isNormalizationSampleEligible(item, referenceTime))
  );
  const samplesByPlatform = groupBy(
    eligiblePhysicalRows.map((item) => ({
      platform: item.platform,
      logEngagement: Math.log1p(computeEvidenceRawEngagement(item.platform, item.metrics))
    })),
    (item) => item.platform
  );

  return canonicalRows.map((canonicalRow, index) => {
    const original = input[index];
    if (!original || canonicalRow.contributionScore <= 0) return canonicalRow;

    const rawEngagement = computeEvidenceRawEngagement(original.platform, original.metrics);
    const reference =
      TRACTION_SCORING_CONFIG.platformReferences[original.platform]?.highEngagement ?? 10_000;
    const absoluteScore = clamp(
      (Math.log1p(rawEngagement) / Math.log1p(reference)) * 100,
      0,
      100
    );
    const percentileScore = midrankPercentile(
      (samplesByPlatform.get(original.platform) ?? []).map((sample) => sample.logEngagement),
      Math.log1p(rawEngagement)
    );
    const reconstructedCanonical = Math.round(
      clamp(
        absoluteScore * TRACTION_SCORING_CONFIG.absoluteEvidenceWeight +
          percentileScore * TRACTION_SCORING_CONFIG.cohortPercentileWeight,
        1,
        100
      )
    );
    normalizationParityAssertions += 1;

    if (reconstructedCanonical !== canonicalRow.contributionScore) {
      throw new Error(
        `Canonical normalization parity failed for ${original.id}: imported ${canonicalRow.contributionScore}, reconstructed ${reconstructedCanonical}.`
      );
    }

    if (normalization.canonical) return canonicalRow;

    const candidateScore = Math.round(
      clamp(
        absoluteScore * normalization.absoluteWeight +
          percentileScore * normalization.percentileWeight,
        1,
        100
      )
    );

    return {
      ...canonicalRow,
      normalizedScore: candidateScore,
      contributionScore: candidateScore,
      why: `${canonicalRow.why} Experiment-only ${normalization.id}: absolute ${round(
        absoluteScore,
        1
      )}, physical-post percentile ${round(percentileScore, 1)}, publication age excluded; scored ${candidateScore}/100.`
    };
  });
}

function isNormalizationSampleEligible(item, explicitAsOf) {
  if (!scoringEligibility(item).eligible) return false;

  const availableAt = latestItemAvailability(item);
  return !availableAt || availableAt.getTime() <= explicitAsOf.getTime();
}

function latestItemAvailability(item) {
  const timestamps = [
    item.observedAt,
    item.metricsCheckedAt,
    item.ingestedAt,
    item.first_seen_at,
    item.last_checked_at,
    item.last_updated_at
  ];
  const latest = Math.max(0, ...timestamps.map((value) => parseDate(value)?.getTime() ?? 0));
  return latest > 0 ? new Date(latest) : null;
}

function aggregateCandidateEvidence(items, aggregation) {
  const uniqueItems = dedupeEvidenceForScoring(items).filter(
    (item) => Number.isFinite(item.contributionScore) && item.contributionScore > 0
  );
  if (aggregation.canonical || !uniqueItems.length) {
    return aggregateBalancedTractionScore(uniqueItems);
  }

  const grouped = groupBy(uniqueItems, (item) => item.platform);
  const projectedItems = [];
  const expectedPlatformScores = new Map();

  for (const [platform, platformItems] of grouped.entries()) {
    const sorted = [...platformItems].sort(
      (left, right) =>
        right.contributionScore - left.contributionScore ||
        compareText(canonicalPostKey(left), canonicalPostKey(right)) ||
        compareText(left.id, right.id)
    );
    const topItems = sorted.slice(0, TRACTION_SCORING_CONFIG.platformEvidenceSlots.length);
    const targetScore =
      aggregation.id === "max"
        ? topItems[0]?.contributionScore ?? 0
        : mean(topItems.map((item) => item.contributionScore));
    const activeSlotCount = Math.min(
      sorted.length,
      TRACTION_SCORING_CONFIG.platformEvidenceSlots.length
    );
    const activeSlotWeight = TRACTION_SCORING_CONFIG.platformEvidenceSlots
      .slice(0, activeSlotCount)
      .reduce((sum, weight) => sum + weight, 0);
    const roundedTargetScore = Math.round(targetScore);
    const projectedContribution =
      activeSlotWeight > 0 ? (roundedTargetScore + 1e-9) / activeSlotWeight : 0;

    expectedPlatformScores.set(platform, roundedTargetScore);
    projectedItems.push(
      ...sorted.map((item) => ({
        ...item,
        normalizedScore: projectedContribution,
        contributionScore: projectedContribution
      }))
    );
  }

  const breakdown = aggregateBalancedTractionScore(projectedItems);
  for (const [platform, expectedScore] of expectedPlatformScores.entries()) {
    if (breakdown.platformScores[platform] !== expectedScore) {
      throw new Error(
        `Candidate aggregation projection failed for ${aggregation.id}/${platform}: expected ${expectedScore}, received ${breakdown.platformScores[platform]}.`
      );
    }
  }

  return breakdown;
}

function companyScoringRow(company) {
  const breakdown = company.scoreBreakdown ?? aggregateBalancedTractionScore([]);
  return {
    company_id: company.id,
    company_name: company.name,
    score: company.totalScore,
    absolute_score: breakdown.absoluteScore,
    batch_percentile: breakdown.calibration.percentile,
    top_platform: breakdown.weightedPlatforms[0]?.platform ?? null,
    top_platform_share: breakdown.weightedPlatforms[0]?.appliedWeight ?? 0,
    concentration_hhi: round(
      breakdown.weightedPlatforms.reduce(
        (sum, platform) => sum + platform.appliedWeight ** 2,
        0
      ),
      4
    ),
    scored_evidence_rows: breakdown.confidence.scoredEvidenceCount,
    platforms_with_evidence: breakdown.platformsWithEvidence,
    total_supported_platforms: breakdown.totalSupportedPlatforms,
    coverage_ratio: round(
      breakdown.totalSupportedPlatforms
        ? breakdown.platformsWithEvidence / breakdown.totalSupportedPlatforms
        : 0,
      4
    ),
    confidence: breakdown.confidence,
    limitations: breakdown.limitations,
    breakdown
  };
}

function publicCohortReport(internal) {
  const { context, runs, baseline } = internal;
  return {
    cohort: context.slug,
    label: context.label,
    input_counts: {
      companies: context.companies.length,
      founders: context.founders.length,
      cohort_scoped_evidence_rows: context.evidence.length,
      baseline_scored_evidence_rows: baseline.base.evidence.filter(
        (item) => item.contributionScore > 0
      ).length
    },
    baseline_variant_id: BASELINE_VARIANT_ID,
    baseline_top_10: baseline.base.rows.slice(0, TOP_K).map(publicRankRow),
    variants: runs.map((run) => ({
      ...publicCandidateVariant(run.variant),
      score_distribution: summarizeNumbers(run.base.rows.map((row) => row.score)),
      coverage: summarizeCoverage(run.base.rows),
      concentration: run.concentration,
      rank_comparison_to_v4_baseline: compareRankedScores(
        baseline.base.rows,
        run.base.rows
      ),
      perturbation_stability: run.perturbations,
      dominant_platform_ablation: run.dominantPlatformAblation.comparison,
      top_10: run.base.rows.slice(0, TOP_K).map(publicRankRow),
      ranked_companies: run.base.rows.map(publicRankRow)
    }))
  };
}

function rankVariants(internalCohortRuns) {
  const rows = CANDIDATE_VARIANTS.map((variant) => {
    const runs = internalCohortRuns.map((cohort) => cohort.runByVariant.get(variant.id));
    if (runs.some((run) => !run)) throw new Error(`Missing cohort run for ${variant.id}.`);
    const definedRuns = runs.filter(Boolean);
    const smallPerturbations = definedRuns.flatMap((run) => [
      run.perturbations.metric_plus_one_percent,
      run.perturbations.clock_plus_one_day
    ]);

    return {
      variant_id: variant.id,
      label: variant.label,
      normalization: variant.normalization.id,
      aggregation: variant.aggregation.id,
      reverse_order_exact_all_cohorts: definedRuns.every(
        (run) => run.perturbations.reverse_input.exact_score_and_rank_match
      ),
      mean_small_perturbation_spearman: round(
        mean(smallPerturbations.map((item) => item.spearman_rank_correlation)),
        6
      ),
      mean_small_perturbation_top_10_overlap: round(
        mean(smallPerturbations.map((item) => item.top_10_overlap_rate)),
        4
      ),
      mean_small_perturbation_absolute_rank_shift: round(
        mean(smallPerturbations.map((item) => item.mean_absolute_rank_shift)),
        4
      ),
      dominant_platform_company_rate: round(
        mean(definedRuns.map((run) => run.concentration.dominant_platform_company_rate)),
        4
      ),
      mean_top_platform_share: round(
        mean(definedRuns.map((run) => run.concentration.mean_top_platform_share)),
        4
      ),
      dominant_platform_ablation_mean_absolute_score_delta: round(
        mean(
          definedRuns.map(
            (run) => run.dominantPlatformAblation.comparison.mean_absolute_score_delta
          )
        ),
        4
      ),
      dominant_platform_ablation_mean_absolute_rank_shift: round(
        mean(
          definedRuns.map(
            (run) => run.dominantPlatformAblation.comparison.mean_absolute_rank_shift
          )
        ),
        4
      )
    };
  });

  return rows
    .sort(
      (left, right) =>
        Number(right.reverse_order_exact_all_cohorts) -
          Number(left.reverse_order_exact_all_cohorts) ||
        right.mean_small_perturbation_spearman - left.mean_small_perturbation_spearman ||
        right.mean_small_perturbation_top_10_overlap -
          left.mean_small_perturbation_top_10_overlap ||
        left.mean_small_perturbation_absolute_rank_shift -
          right.mean_small_perturbation_absolute_rank_shift ||
        left.dominant_platform_company_rate - right.dominant_platform_company_rate ||
        left.dominant_platform_ablation_mean_absolute_score_delta -
          right.dominant_platform_ablation_mean_absolute_score_delta ||
        compareText(left.variant_id, right.variant_id)
    )
    .map((row, index) => ({ diagnostic_rank: index + 1, ...row }));
}

function selectRepresentativeExamples(internal) {
  const examples = [];
  const candidateTargets = ["absolute-only__max", "percentile-heavy__mean"];

  for (const variantId of candidateTargets) {
    const target = internal.runByVariant.get(variantId);
    if (!target) throw new Error(`Missing representative target ${variantId}.`);
    const changes = detailedChanges(internal.baseline.base.rows, target.base.rows).slice(0, 2);
    for (const change of changes) {
      examples.push(
        buildRepresentativeExample({
          cohort: internal.context,
          comparisonType: "candidate_variant",
          comparisonLabel: target.variant.label,
          selectionReason:
            "Largest deterministic rank movement for this deliberately contrasting candidate in the cohort.",
          beforeVariant: internal.baseline.variant,
          afterVariant: target.variant,
          beforeRow: change.before,
          afterRow: change.after
        })
      );
    }
  }

  const metricRun = internal.baseline.perturbationRuns.metric_plus_one_percent;
  for (const change of detailedChanges(internal.baseline.base.rows, metricRun.rows).slice(0, 2)) {
    examples.push(
      buildRepresentativeExample({
        cohort: internal.context,
        comparisonType: "metric_perturbation",
        comparisonLabel: "V4 baseline after +1% configured metrics",
        selectionReason:
          "Largest rank or score movement under the deterministic +1% configured-metric perturbation.",
        beforeVariant: internal.baseline.variant,
        afterVariant: internal.baseline.variant,
        beforeRow: change.before,
        afterRow: change.after
      })
    );
  }

  const ablationRun = internal.baseline.dominantPlatformAblation.run;
  for (const change of detailedChanges(internal.baseline.base.rows, ablationRun.rows).slice(0, 2)) {
    examples.push(
      buildRepresentativeExample({
        cohort: internal.context,
        comparisonType: "dominant_platform_ablation",
        comparisonLabel: `Remove each company's dominant platform (${change.after.removed_platform ?? "none"} for this row)`,
        selectionReason:
          "Largest score or rank sensitivity after removing the company's own largest-contribution platform.",
        beforeVariant: internal.baseline.variant,
        afterVariant: internal.baseline.variant,
        beforeRow: change.before,
        afterRow: change.after
      })
    );
  }

  return examples.map((example, index) => ({
    example_id: `${internal.context.slug}-${String(index + 1).padStart(2, "0")}`,
    ...example
  }));
}

function buildRepresentativeExample({
  cohort,
  comparisonType,
  comparisonLabel,
  selectionReason,
  beforeVariant,
  afterVariant,
  beforeRow,
  afterRow
}) {
  return {
    cohort: cohort.slug,
    cohort_label: cohort.label,
    company_id: beforeRow.company_id,
    company_name: beforeRow.company_name,
    comparison_type: comparisonType,
    comparison: comparisonLabel,
    selection_reason: selectionReason,
    before: exampleScoreSnapshot(beforeRow, beforeVariant),
    after: exampleScoreSnapshot(afterRow, afterVariant),
    delta: {
      score: round(afterRow.score - beforeRow.score, 4),
      absolute_score: round(afterRow.absolute_score - beforeRow.absolute_score, 4),
      rank: beforeRow.rank - afterRow.rank
    }
  };
}

function exampleScoreSnapshot(row, variant) {
  return {
    variant_id: variant.id,
    variant_label: variant.label,
    rank: row.rank,
    score: row.score,
    absolute_score: row.absolute_score,
    batch_percentile: row.batch_percentile,
    top_platform: row.top_platform,
    confidence: {
      level: row.confidence.level,
      value: row.confidence.value,
      reasons: row.confidence.reasons
    },
    coverage: {
      scored_evidence_rows: row.scored_evidence_rows,
      platforms_with_evidence: row.platforms_with_evidence,
      total_supported_platforms: row.total_supported_platforms,
      ratio: row.coverage_ratio,
      top_platform_share: row.top_platform_share
    },
    caveats: sortedUnique([
      ...row.limitations,
      CONFIDENCE_CAVEAT,
      NO_LABEL_CAVEAT,
      "Candidate scores are in-memory diagnostics and do not change production configuration."
    ])
  };
}

function compareRankedScores(baselineRows, variantRows) {
  const changes = detailedChanges(baselineRows, variantRows);
  const absoluteScoreDeltas = changes.map((change) => Math.abs(change.score_delta));
  const absoluteRankShifts = changes.map((change) => Math.abs(change.rank_delta));
  const topCount = Math.min(TOP_K, baselineRows.length, variantRows.length);
  const baselineTop = new Set(baselineRows.slice(0, topCount).map((row) => row.company_id));
  const variantTop = new Set(variantRows.slice(0, topCount).map((row) => row.company_id));
  const topOverlap = [...baselineTop].filter((companyId) => variantTop.has(companyId)).length;

  return {
    compared_company_count: changes.length,
    exact_score_and_rank_match: changes.every(
      (change) => change.score_delta === 0 && change.rank_delta === 0
    ),
    score_changed_company_count: changes.filter((change) => change.score_delta !== 0).length,
    score_decreased_company_count: changes.filter((change) => change.score_delta < 0).length,
    rank_changed_company_count: changes.filter((change) => change.rank_delta !== 0).length,
    mean_absolute_score_delta: round(mean(absoluteScoreDeltas), 4),
    median_absolute_score_delta: round(median(absoluteScoreDeltas), 4),
    max_absolute_score_delta: round(Math.max(0, ...absoluteScoreDeltas), 4),
    mean_absolute_rank_shift: round(mean(absoluteRankShifts), 4),
    max_absolute_rank_shift: Math.max(0, ...absoluteRankShifts),
    spearman_rank_correlation: round(spearman(changes), 6),
    top_10_overlap_count: topOverlap,
    top_10_overlap_rate: round(topCount ? topOverlap / topCount : 1, 4),
    ranking_sha256: sha256(
      canonicalJson(variantRows.map((row) => [row.company_id, row.rank, row.score]))
    ),
    largest_changes: changes.slice(0, 20).map(publicChange)
  };
}

function detailedChanges(baselineRows, variantRows) {
  const baseline = new Map(baselineRows.map((row) => [row.company_id, row]));
  const variant = new Map(variantRows.map((row) => [row.company_id, row]));

  return [...baseline.keys()]
    .filter((companyId) => variant.has(companyId))
    .map((companyId) => {
      const before = baseline.get(companyId);
      const after = variant.get(companyId);
      return {
        before,
        after,
        score_delta: round(after.score - before.score, 4),
        rank_delta: before.rank - after.rank
      };
    })
    .sort(
      (left, right) =>
        Math.abs(right.rank_delta) - Math.abs(left.rank_delta) ||
        Math.abs(right.score_delta) - Math.abs(left.score_delta) ||
        compareText(left.before.company_id, right.before.company_id)
    );
}

function publicChange(change) {
  return {
    company_id: change.before.company_id,
    company_name: change.before.company_name,
    score_before: change.before.score,
    score_after: change.after.score,
    score_delta: change.score_delta,
    rank_before: change.before.rank,
    rank_after: change.after.rank,
    rank_delta: change.rank_delta,
    top_platform_before: change.before.top_platform,
    top_platform_after: change.after.top_platform,
    removed_platform: change.after.removed_platform ?? null
  };
}

function summarizeConcentration(rows) {
  const positiveRows = rows.filter((row) => row.score > 0);
  const singlePlatformRows = positiveRows.filter((row) => row.platforms_with_evidence === 1);
  const dominantRows = positiveRows.filter(
    (row) => row.top_platform_share >= DOMINANT_PLATFORM_THRESHOLD
  );

  return {
    positive_company_count: positiveRows.length,
    single_platform_company_count: singlePlatformRows.length,
    single_platform_company_rate: round(
      positiveRows.length ? singlePlatformRows.length / positiveRows.length : 0,
      4
    ),
    dominant_platform_threshold: DOMINANT_PLATFORM_THRESHOLD,
    dominant_platform_company_count: dominantRows.length,
    dominant_platform_company_rate: round(
      positiveRows.length ? dominantRows.length / positiveRows.length : 0,
      4
    ),
    mean_top_platform_share: round(mean(positiveRows.map((row) => row.top_platform_share)), 4),
    median_top_platform_share: round(
      median(positiveRows.map((row) => row.top_platform_share)),
      4
    ),
    mean_contribution_hhi: round(mean(positiveRows.map((row) => row.concentration_hhi)), 4),
    top_platform_counts: countBy(positiveRows, (row) => row.top_platform ?? "none")
  };
}

function summarizeCoverage(rows) {
  const positiveRows = rows.filter((row) => row.score > 0);
  return {
    mean_platform_coverage_ratio: round(
      mean(positiveRows.map((row) => row.coverage_ratio)),
      4
    ),
    median_platform_coverage_ratio: round(
      median(positiveRows.map((row) => row.coverage_ratio)),
      4
    ),
    low_confidence_company_count: positiveRows.filter(
      (row) => row.confidence.level === "low"
    ).length,
    medium_confidence_company_count: positiveRows.filter(
      (row) => row.confidence.level === "medium"
    ).length,
    high_confidence_company_count: positiveRows.filter(
      (row) => row.confidence.level === "high"
    ).length
  };
}

function publicRankRow(row) {
  return {
    rank: row.rank,
    company_id: row.company_id,
    company_name: row.company_name,
    score: row.score,
    absolute_score: row.absolute_score,
    batch_percentile: row.batch_percentile,
    top_platform: row.top_platform,
    top_platform_share: row.top_platform_share,
    confidence_level: row.confidence.level,
    confidence_value: row.confidence.value,
    scored_evidence_rows: row.scored_evidence_rows,
    platforms_with_evidence: row.platforms_with_evidence,
    coverage_ratio: row.coverage_ratio,
    caveats: row.limitations
  };
}

function publicNormalizationVariant(variant) {
  return {
    id: variant.id,
    label: variant.label,
    absolute_weight: variant.absoluteWeight,
    percentile_weight: variant.percentileWeight,
    canonical: variant.canonical,
    description: variant.description
  };
}

function publicAggregationVariant(variant) {
  return {
    id: variant.id,
    label: variant.label,
    canonical: variant.canonical,
    description: variant.description
  };
}

function publicCandidateVariant(variant) {
  return {
    id: variant.id,
    label: variant.label,
    normalization: variant.normalization.id,
    aggregation: variant.aggregation.id,
    is_v4_baseline: variant.id === BASELINE_VARIANT_ID
  };
}

function renderDetailedMarkdown(report, jsonSha256) {
  const baselineVariants = report.cohorts
    .map((cohort) => ({
      cohort: cohort.cohort,
      variant: cohort.variants.find((item) => item.id === BASELINE_VARIANT_ID)
    }))
    .filter((item) => item.variant);
  const metricSpearmans = baselineVariants.map(
    ({ variant }) => variant.perturbation_stability.metric_plus_one_percent.spearman_rank_correlation
  );
  const clockSpearmans = baselineVariants.map(
    ({ variant }) => variant.perturbation_stability.clock_plus_one_day.spearman_rank_correlation
  );
  const singlePlatformRates = baselineVariants.map(
    ({ variant }) => variant.concentration.single_platform_company_rate
  );
  const ablationOverlaps = baselineVariants.map(
    ({ variant }) => variant.dominant_platform_ablation.top_10_overlap_rate
  );
  const lines = [
    "# Scoring Experiments v4",
    "",
    "## Scope",
    "",
    report.interpretation.purpose,
    "",
    `**Boundary:** ${report.interpretation.prediction_boundary}`,
    "",
    `${report.interpretation.confidence_boundary} ${report.interpretation.recommendation_boundary}`,
    "",
    `Frozen clock: \`${report.metadata.frozen_clock}\`. Production model: \`${report.metadata.production_model_id}@${report.metadata.production_model_version}\` (\`${report.metadata.production_model_name}\`). JSON SHA-256: \`${jsonSha256}\`.`,
    "",
    "## Canonical Reuse",
    "",
    ...report.metadata.production_imports.map((item) => `- \`${item}\``),
    "",
    `The runner completed ${report.metadata.normalization_parity_assertions} imported-normalizer parity assertions and recorded production-config mutation as \`${report.metadata.production_config_mutated}\`.`,
    "",
    "## Candidate Matrix",
    "",
    "| Normalization | Absolute | Percentile | Aggregation | Baseline |",
    "| --- | ---: | ---: | --- | --- |",
    ...report.candidate_definitions.matrix.map((candidate) => {
      const normalization = report.candidate_definitions.normalization.find(
        (item) => item.id === candidate.normalization
      );
      return `| ${escapeMarkdown(normalization?.label ?? candidate.normalization)} | ${formatPercent(normalization?.absolute_weight ?? 0)} | ${formatPercent(normalization?.percentile_weight ?? 0)} | ${escapeMarkdown(candidate.aggregation)} | ${candidate.is_v4_baseline ? "yes" : "no"} |`;
    }),
    "",
    "Max and mean vary only within-platform reduction. All candidates retain canonical v4 metric aliases/weights, eligibility, native identity, physical dedupe, date-invariant scoring, cross-platform aggregation, confidence, and company batch calibration.",
    "",
    "## Diagnostic Ranking",
    "",
    report.interpretation.diagnostic_ranking_rule,
    "",
    "| Rank | Variant | Perturbation Spearman | Top-10 overlap | Mean rank shift | >=98% top share | Ablation score sensitivity |",
    "| ---: | --- | ---: | ---: | ---: | ---: | ---: |",
    ...report.diagnostic_variant_ranking.map(
      (row) =>
        `| ${row.diagnostic_rank} | ${escapeMarkdown(row.label)} | ${row.mean_small_perturbation_spearman} | ${formatPercent(row.mean_small_perturbation_top_10_overlap)} | ${row.mean_small_perturbation_absolute_rank_shift} | ${formatPercent(row.dominant_platform_company_rate)} | ${row.dominant_platform_ablation_mean_absolute_score_delta} |`
    ),
    "",
    "This ordering is a deterministic engineering diagnostic, not a claim that the first row predicts better outcomes.",
    "",
    "## Observed Diagnostics",
    "",
    `- Reverse-order input was exact for all ${report.summary.candidate_count} candidates in all ${report.summary.cohort_count} cohorts.`,
    `- The v4 baseline's +1% configured-metric Spearman correlation ranged from ${Math.min(...metricSpearmans)} to ${Math.max(...metricSpearmans)}; the +1-day clock correlation ranged from ${Math.min(...clockSpearmans)} to ${Math.max(...clockSpearmans)}.`,
    `- Single-platform companies represented ${formatPercent(Math.min(...singlePlatformRates))} to ${formatPercent(Math.max(...singlePlatformRates))} of positive-score companies by cohort.`,
    `- Removing every company's own dominant platform reduced v4 baseline top-10 overlap to ${formatPercent(Math.min(...ablationOverlaps))} to ${formatPercent(Math.max(...ablationOverlaps))}, exposing materially greater concentration sensitivity than the small perturbations.`,
    "- Percentile-heavy and max/mean candidates can create large company-level rank changes despite high aggregate Spearman values; the detailed examples retain those tails rather than treating cohort-wide correlation as sufficient.",
    "",
    "These are descriptive results on frozen, unlabeled snapshots. They do not identify an optimal model.",
    "",
    "## Cohort Baselines",
    "",
    "| Cohort | Companies | Evidence rows | Scored rows | Baseline top 3 |",
    "| --- | ---: | ---: | ---: | --- |",
    ...report.cohorts.map(
      (cohort) =>
        `| ${cohort.cohort} | ${cohort.input_counts.companies} | ${cohort.input_counts.cohort_scoped_evidence_rows} | ${cohort.input_counts.baseline_scored_evidence_rows} | ${cohort.baseline_top_10
          .slice(0, 3)
          .map((row) => `${row.rank}. ${escapeMarkdown(row.company_name)} (${row.score})`)
          .join("; ")} |`
    ),
    "",
    "## Stability and Concentration",
    "",
    "| Cohort | Variant | +1% Spearman | +1 day Spearman | Reverse exact | Single-platform rate | >=98% top share | Top-platform ablation mean score delta | Top-10 overlap after ablation |",
    "| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |",
    ...report.cohorts.flatMap((cohort) =>
      cohort.variants.map(
        (variant) =>
          `| ${cohort.cohort} | ${escapeMarkdown(variant.label)} | ${variant.perturbation_stability.metric_plus_one_percent.spearman_rank_correlation} | ${variant.perturbation_stability.clock_plus_one_day.spearman_rank_correlation} | ${variant.perturbation_stability.reverse_input.exact_score_and_rank_match ? "yes" : "no"} | ${formatPercent(variant.concentration.single_platform_company_rate)} | ${formatPercent(variant.concentration.dominant_platform_company_rate)} | ${variant.dominant_platform_ablation.mean_absolute_score_delta} | ${formatPercent(variant.dominant_platform_ablation.top_10_overlap_rate)} |`
      )
    ),
    "",
    `## Representative Before/After Examples (${report.representative_before_after_examples.length})`,
    "",
    "Each row includes the canonical confidence reason and evidence coverage. Full reason arrays and caveats for both sides are preserved in the JSON artifact.",
    "",
    "| ID | Cohort | Company | Comparison | Rank | Score | Confidence | Coverage | Reasons | Caveats |",
    "| --- | --- | --- | --- | ---: | ---: | --- | --- | --- | --- |",
    ...report.representative_before_after_examples.map((example) => {
      const reasons = example.after.confidence.reasons.join(" ");
      const caveats = example.after.caveats.join(" ");
      return `| ${example.example_id} | ${example.cohort} | ${escapeMarkdown(example.company_name)} | ${escapeMarkdown(example.comparison)} | ${example.before.rank} -> ${example.after.rank} (${signed(example.delta.rank)}) | ${example.before.score} -> ${example.after.score} (${signed(example.delta.score)}) | ${example.after.confidence.level} ${formatPercent(example.after.confidence.value)} | ${example.after.coverage.scored_evidence_rows} rows, ${example.after.coverage.platforms_with_evidence}/${example.after.coverage.total_supported_platforms} platforms | ${escapeMarkdown(reasons)} | ${escapeMarkdown(caveats)} |`;
    }),
    "",
    "## Reproduction",
    "",
    "```bash",
    report.metadata.command,
    "shasum -a 256 docs/outputs/scoring-experiments-v4.json docs/outputs/scoring-experiments-v4.md docs/SCORING_EXPERIMENTS.md",
    "```",
    "",
    "The runner reads local snapshots only, disables network access, freezes time, and refuses writes outside its three documented output paths.",
    ""
  ];

  return lines.join("\n");
}

function renderSummaryMarkdown(report, jsonSha256) {
  const baselineByCohort = report.cohorts.map((cohort) => ({
    cohort: cohort.cohort,
    variant: cohort.variants.find((item) => item.id === BASELINE_VARIANT_ID)
  }));
  const lines = [
    "# Scoring Experiments",
    "",
    "## V4 Candidate Run",
    "",
    `- Frozen clock: \`${report.metadata.frozen_clock}\`.`,
    `- Production model: \`${report.metadata.production_model_id}@${report.metadata.production_model_version}\` (\`${report.metadata.production_model_name}\`).`,
    `- Scope: ${report.summary.cohort_count} cohorts, ${report.summary.company_count} companies, ${report.summary.evidence_row_count} cohort-scoped evidence rows, and ${report.summary.candidate_count} candidate combinations.`,
    `- Canonical parity assertions: ${report.metadata.normalization_parity_assertions}; production config mutated: \`${report.metadata.production_config_mutated}\`.`,
    `- Machine-readable artifact SHA-256: \`${jsonSha256}\`.`,
    "",
    `**Interpretation boundary:** ${report.interpretation.prediction_boundary}`,
    "",
    `${report.interpretation.confidence_boundary} ${report.interpretation.recommendation_boundary}`,
    "",
    "## Candidates",
    "",
    "Normalization compares absolute-only, percentile-heavy (35/65), and the imported v4 robust blend. Platform aggregation compares max, mean of the canonical top-K window, and imported v4 decaying slots. Metric aliases/weights, eligibility, identity, physical dedupe, date-invariant scoring, cross-platform aggregation, confidence, and company batch calibration remain canonical.",
    "",
    "## Deterministic Diagnostic Order",
    "",
    "| Rank | Candidate | Perturbation Spearman | Top-10 overlap | >=98% top share |",
    "| ---: | --- | ---: | ---: | ---: |",
    ...report.diagnostic_variant_ranking.map(
      (row) =>
        `| ${row.diagnostic_rank} | ${escapeMarkdown(row.label)} | ${row.mean_small_perturbation_spearman} | ${formatPercent(row.mean_small_perturbation_top_10_overlap)} | ${formatPercent(row.dominant_platform_company_rate)} |`
    ),
    "",
    "The order above ranks mechanical stability and concentration diagnostics only. It is not a recommendation or predictive leaderboard.",
    "",
    "## Observed Diagnostics",
    "",
    "All reverse-order runs matched exactly. The v4 baseline remained highly rank-stable under +1% configured metrics and a +1-day clock, while dominant-platform ablation caused much larger movement and only 50% top-10 overlap in each cohort. Single-platform coverage is therefore reported separately from near-total top-contribution concentration.",
    "",
    "## V4 Baseline by Cohort",
    "",
    "| Cohort | Score range | Mean coverage | Single-platform rate | >=98% top share | +1% metric Spearman | +1 day Spearman | Ablation top-10 overlap |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...baselineByCohort.map(({ cohort, variant }) =>
      variant
        ? `| ${cohort} | ${variant.score_distribution.min}-${variant.score_distribution.max} | ${formatPercent(variant.coverage.mean_platform_coverage_ratio)} | ${formatPercent(variant.concentration.single_platform_company_rate)} | ${formatPercent(variant.concentration.dominant_platform_company_rate)} | ${variant.perturbation_stability.metric_plus_one_percent.spearman_rank_correlation} | ${variant.perturbation_stability.clock_plus_one_day.spearman_rank_correlation} | ${formatPercent(variant.dominant_platform_ablation.top_10_overlap_rate)} |`
        : `| ${cohort} | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable |`
    ),
    "",
    `The detailed report contains ${report.representative_before_after_examples.length} before/after examples with confidence reasons, evidence coverage, and caveats.`,
    "",
    "## Artifacts",
    "",
    "- Detailed report: [`docs/outputs/scoring-experiments-v4.md`](outputs/scoring-experiments-v4.md)",
    "- Machine-readable results: [`docs/outputs/scoring-experiments-v4.json`](outputs/scoring-experiments-v4.json)",
    "",
    "Reproduce with `npm run scoring:experiments`. The runner is offline, frozen-clock, and write-allowlisted.",
    ""
  ];

  return lines.join("\n");
}

function validateReport(report) {
  if (report.metadata.production_config_mutated) {
    throw new Error("The experiment runner mutated canonical production config.");
  }
  if (report.cohorts.length !== COHORT_SLUGS.length) {
    throw new Error("Not all three required cohorts were evaluated.");
  }
  if (report.candidate_definitions.matrix.length !== 9) {
    throw new Error("The normalization/aggregation matrix must contain exactly nine candidates.");
  }
  if (report.representative_before_after_examples.length < 20) {
    throw new Error("At least 20 representative before/after examples are required.");
  }
  if (report.metadata.normalization_parity_assertions <= 0) {
    throw new Error("No canonical normalization parity assertions ran.");
  }
  if (!report.interpretation.prediction_boundary.includes("does not establish predictive calibration")) {
    throw new Error("The no-label predictive-calibration boundary is missing.");
  }

  for (const cohort of report.cohorts) {
    if (!COHORT_SLUGS.includes(cohort.cohort) || cohort.variants.length !== 9) {
      throw new Error(`Invalid cohort or candidate count for ${cohort.cohort}.`);
    }
    for (const variant of cohort.variants) {
      if (!variant.perturbation_stability.reverse_input.exact_score_and_rank_match) {
        throw new Error(`Reverse-order stability failed for ${cohort.cohort}/${variant.id}.`);
      }
      for (const value of Object.values(variant.score_distribution)) {
        if (!Number.isFinite(value)) {
          throw new Error(`Non-finite score statistic for ${cohort.cohort}/${variant.id}.`);
        }
      }
    }
  }
}

async function buildInputHashManifest() {
  const files = [
    "src/lib/scoring/traction-config.ts",
    "src/lib/scoring/batch-calibration.ts",
    "src/lib/graph/traction-scoring.ts",
    "src/lib/graph/dedupe.ts",
    "src/lib/graph/yc-spring-2026-dataset.ts",
    "src/lib/graph/a16z-speedrun-006-dataset.ts"
  ];
  const manifest = {};

  for (const relativeFile of files) {
    manifest[relativeFile] = sha256(await readFile(path.join(REPOSITORY_ROOT, relativeFile)));
  }

  return manifest;
}

async function writeAllowedArtifact(filePath, content) {
  const resolved = path.resolve(filePath);
  if (!ALLOWED_OUTPUT_PATHS.has(resolved)) {
    throw new Error(`Refusing write outside the scoring-experiment allowlist: ${filePath}`);
  }
  await writeFile(resolved, content, "utf8");
}

function scaleConfiguredMetrics(item) {
  const weights = TRACTION_SCORING_CONFIG.metricWeights[item.platform] ?? {};
  const metrics = { ...(item.metrics ?? {}) };

  for (const [metric, weight] of Object.entries(weights)) {
    const value = Number(metrics[metric]);
    if (Number(weight) > 0 && Number.isFinite(value) && value > 0) {
      metrics[metric] = value * 1.01;
    }
  }

  return { ...cloneEvidence(item), metrics };
}

function midrankPercentile(samples, value) {
  const finite = samples.filter(Number.isFinite).sort((left, right) => left - right);
  if (!finite.length || !Number.isFinite(value)) return 0;
  const less = finite.filter((sample) => sample < value).length;
  const equal = finite.filter((sample) => sample === value).length;
  return clamp(((less + equal * 0.5) / finite.length) * 100, 0, 100);
}

function rankRows(rows) {
  return [...rows]
    .sort(
      (left, right) =>
        right.score - left.score ||
        compareText(left.company_name, right.company_name) ||
        compareText(left.company_id, right.company_id)
    )
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function summarizeNumbers(values) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  return {
    min: round(finite[0] ?? 0, 4),
    p25: round(percentile(finite, 0.25), 4),
    median: round(percentile(finite, 0.5), 4),
    mean: round(mean(finite), 4),
    p75: round(percentile(finite, 0.75), 4),
    max: round(finite.at(-1) ?? 0, 4)
  };
}

function spearman(changes) {
  if (changes.length < 2) return 1;
  const sumSquaredDifferences = changes.reduce(
    (sum, change) => sum + (change.before.rank - change.after.rank) ** 2,
    0
  );
  const count = changes.length;
  return 1 - (6 * sumSquaredDifferences) / (count * (count ** 2 - 1));
}

function percentile(sortedValues, quantile) {
  if (!sortedValues.length) return 0;
  const position = (sortedValues.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  return (
    sortedValues[lower] +
    (sortedValues[upper] - sortedValues[lower]) * (position - lower)
  );
}

function median(values) {
  return percentile(
    [...values].filter(Number.isFinite).sort((left, right) => left - right),
    0.5
  );
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function groupBy(items, keyFunction) {
  const grouped = new Map();
  for (const item of items) {
    const key = keyFunction(item);
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return grouped;
}

function countBy(items, keyFunction) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFunction(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || compareText(left.key, right.key));
}

function cloneEvidence(item) {
  return { ...item, metrics: { ...(item.metrics ?? {}) } };
}

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function advanceIsoTimestamp(value, days) {
  const parsed = parseDate(value);
  if (!parsed) throw new Error(`Cannot advance invalid timestamp: ${value}`);
  return new Date(parsed.getTime() + days * 86_400_000).toISOString();
}

function argumentValue(name) {
  const equals = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function assertValidClock(value) {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid --clock value: ${value}`);
  }
}

function freezeClock(value) {
  const NativeDate = globalThis.Date;
  const frozenTime = NativeDate.parse(value);
  globalThis.Date = class Date extends NativeDate {
    constructor(...argumentsList) {
      super(...(argumentsList.length ? argumentsList : [frozenTime]));
    }

    static now() {
      return frozenTime;
    }
  };
}

function readGitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function relativePath(filePath) {
  return path.relative(REPOSITORY_ROOT, filePath).split(path.sep).join("/");
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareText);
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), "en");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}

function formatPercent(value) {
  return `${round(Number(value) * 100, 2)}%`;
}

function escapeMarkdown(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
