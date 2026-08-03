import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIRECTORY = path.join(REPOSITORY_ROOT, "docs", "outputs");
const AUDIT_OUTPUT_PATH = path.join(OUTPUT_DIRECTORY, "scoring-diagnostics-v4-audit.json");
const REPORT_OUTPUT_PATH = path.join(OUTPUT_DIRECTORY, "scoring-diagnostics-v4-report.md");
const AUDIT_WRITE_PATH = resolveOutputPath("--audit-output", AUDIT_OUTPUT_PATH);
const REPORT_WRITE_PATH = resolveOutputPath("--report-output", REPORT_OUTPUT_PATH);
const DEFAULT_FROZEN_CLOCK = "2026-07-17T12:00:00.000Z";
const FROZEN_CLOCK = argumentValue("--clock") ?? DEFAULT_FROZEN_CLOCK;
const EXPECTED_INPUT_SHA256 = argumentValue("--expect-input-sha256");
const COHORT_SLUGS = ["S2026", "S26", "A16ZSR006"];
const PORTABLE_COMMAND =
  "node --experimental-strip-types --loader ./scripts/lib/scoring-diagnostics-ts-loader.mjs ./scripts/run-scoring-diagnostics-v4.mjs";
const PACKAGE_COMMAND = "npm run scoring:audit:v4";
const COMPATIBILITY_SHIMS = await detectCompatibilityShims();
const EXECUTION_GIT_SHA = readGitSha();

assertValidClock(FROZEN_CLOCK);
freezeClock(FROZEN_CLOCK);
globalThis.fetch = async () => {
  throw new Error("Network access is disabled by scoring diagnostics v4.");
};

const [datasetModule, scoringModule, configModule, dedupeModule] = await Promise.all([
  import("../src/lib/graph/yc-spring-2026-dataset.ts"),
  import("../src/lib/graph/traction-scoring.ts"),
  import("../src/lib/graph/traction-scoring-config.ts"),
  import("../src/lib/graph/dedupe.ts")
]);

const { yc2026GraphDataset } = datasetModule;
const {
  aggregateBalancedTractionScore,
  computeEvidenceRawEngagement,
  isNativeEvidenceUrl,
  normalizeEvidenceScores,
  scoringEligibility
} = scoringModule;
const { TRACTION_SCORING_CONFIG, normalizeMetricsForScoring } = configModule;
const {
  canonicalEvidenceKey,
  canonicalEvidenceUrl,
  canonicalPostKey,
  dedupeEvidenceForScoring,
  dedupeEvidenceItems
} = dedupeModule;

const ALIAS_GROUPS = [
  {
    id: "github_stars_watchers_api_alias",
    platforms: new Set(["github"]),
    metrics: ["stars", "watchers"],
    canonicalMetric: "stars",
    requireEqual: true
  },
  {
    id: "likes_reactions",
    platforms: new Set(["linkedin"]),
    metrics: ["likes", "reactions"],
    canonicalMetric: "likes"
  },
  {
    id: "comments_replies",
    platforms: new Set(["x", "linkedin", "instagram"]),
    metrics: ["comments", "replies"],
    canonicalMetric: "replies"
  },
  {
    id: "shares_reposts",
    platforms: new Set(["x", "linkedin", "instagram"]),
    metrics: ["shares", "reposts"],
    canonicalMetric: "reposts"
  },
  {
    id: "issues_open_issues",
    platforms: new Set(["github"]),
    metrics: ["issues", "open_issues"],
    canonicalMetric: "open_issues"
  }
];

const VERSIONED_INPUT_SOURCE_ROLES = [
  {
    role: "canonical_scoring_calibration_confidence_config",
    path: "src/lib/scoring/traction-config.ts"
  },
  {
    role: "graph_scoring_and_confidence_algorithm",
    path: "src/lib/graph/traction-scoring.ts"
  },
  {
    role: "graph_config_reexport",
    path: "src/lib/graph/traction-scoring-config.ts"
  },
  {
    role: "batch_calibration_algorithm",
    path: "src/lib/scoring/batch-calibration.ts"
  },
  {
    role: "global_company_headline_benchmark_algorithm",
    path: "src/lib/scoring/global-score-benchmark.ts"
  },
  {
    role: "tie_aware_percentile_algorithm",
    path: "src/lib/scoring/percentiles.ts"
  },
  {
    role: "eligibility_and_physical_dedupe_algorithm",
    path: "src/lib/graph/dedupe.ts"
  },
  {
    role: "yc_batch_assembly_and_calibration_application",
    path: "src/lib/graph/yc-spring-2026-dataset.ts"
  },
  {
    role: "a16z_batch_assembly_and_calibration_application",
    path: "src/lib/graph/a16z-speedrun-006-dataset.ts"
  }
];

const WEIGHTED_PLATFORMS = Object.entries(TRACTION_SCORING_CONFIG.platformWeights)
  .filter(([, weight]) => Number(weight) > 0)
  .map(([platform]) => platform)
  .sort(compareText);

const inputHashes = await buildInputHashManifest();
assertExpectedInputHash(inputHashes);
const cohortMemberships = entityCohortMemberships(yc2026GraphDataset);
const cohortContexts = COHORT_SLUGS.map((slug) => buildCohortContext(slug));
const cohortAudits = cohortContexts.map(runCohortAudit);
const globalDuplicates = auditGlobalDuplicates();
const audit = {
  metadata: {
    report_version: "scoring-diagnostics-v4",
    schema_version: 4,
    generated_at: FROZEN_CLOCK,
    frozen_clock: FROZEN_CLOCK,
    production_model_id: TRACTION_SCORING_CONFIG.modelId,
    production_model_version: TRACTION_SCORING_CONFIG.version,
    production_model_name: TRACTION_SCORING_CONFIG.name,
    production_scoring_imports: [
      "src/lib/graph/traction-scoring.ts#normalizeEvidenceScores",
      "src/lib/graph/traction-scoring.ts#aggregateBalancedTractionScore",
      "src/lib/graph/traction-scoring.ts#computeEvidenceRawEngagement",
      "src/lib/graph/traction-scoring.ts#isNativeEvidenceUrl",
      "src/lib/graph/traction-scoring.ts#scoringEligibility",
      "src/lib/graph/dedupe.ts#canonicalEvidenceKey",
      "src/lib/graph/dedupe.ts#canonicalEvidenceUrl",
      "src/lib/graph/dedupe.ts#canonicalPostKey",
      "src/lib/graph/dedupe.ts#dedupeEvidenceForScoring",
      "src/lib/graph/dedupe.ts#dedupeEvidenceItems",
      "src/lib/scoring/traction-config.ts#TRACTION_SCORING_CONFIG",
      "src/lib/scoring/traction-config.ts#normalizeMetricsForScoring"
    ],
    // The executing commit is logged to stdout below. Embedding it here would
    // make a checked-in artifact stale as soon as its regeneration is committed.
    git_sha: null,
    node_version: process.version,
    command: PACKAGE_COMMAND,
    direct_command: PORTABLE_COMMAND,
    package_script_declared: true,
    compatibility_shims: COMPATIBILITY_SHIMS,
    safety: {
      input_mode: "read_only_local_snapshots",
      network_fetch: "disabled",
      mutable_api_calls: 0,
      benchmark_writes: 0,
      permitted_writes: [
        relativePath(AUDIT_OUTPUT_PATH),
        relativePath(REPORT_OUTPUT_PATH)
      ]
    },
    input_hashes: inputHashes
  },
  methodology: {
    before:
      "Re-normalize each cohort's production-assembled evidence and aggregate company plus founder evidence with the imported production scoring functions.",
    after:
      "In memory only: retain only rows accepted by the production scoring-eligibility predicate, audit but retain publication-date gaps under the production conservative-momentum behavior, canonicalize metrics with the production normalizer, apply entity-scoped production canonical dedupe, and apply the production physical-post comparator only to eligible rows with one unambiguous company owner before re-running the same production scorer.",
    published_reference:
      "Published company scores are reported separately because cohort dataset builders can apply calibration after the exported aggregate scorer.",
    rank_rule: "Ordinal rank by score descending, then company name and company ID ascending.",
    perturbations: [
      "reverse evidence input order",
      "increase every positive configured metric by 1 percent",
      "advance collection timestamps by 24 hours",
      "increase one configured metric for a deterministic score-stratified sample of up to 40 rows per platform by max(1, ceil(value * 1 percent))"
    ],
    after_is_diagnostic_only: true
  },
  global_summary: buildGlobalSummary(cohortAudits, globalDuplicates),
  global_canonical_duplicates: globalDuplicates,
  cohorts: cohortAudits
};

audit.invariants = buildInvariantResults(audit);

validateAudit(audit);

const auditJson = `${JSON.stringify(audit, null, 2)}\n`;
const auditSha256 = sha256(auditJson);
const markdown = renderMarkdownReport(audit, auditSha256);

await Promise.all([
  mkdir(path.dirname(AUDIT_WRITE_PATH), { recursive: true }),
  mkdir(path.dirname(REPORT_WRITE_PATH), { recursive: true })
]);
await writeArtifact(AUDIT_WRITE_PATH, auditJson);
await writeArtifact(REPORT_WRITE_PATH, markdown);

console.log(
  JSON.stringify(
    {
      report_version: audit.metadata.report_version,
      model_id: audit.metadata.production_model_id,
      model_version: audit.metadata.production_model_version,
      model_name: audit.metadata.production_model_name,
      frozen_clock: audit.metadata.frozen_clock,
      git_sha: EXECUTION_GIT_SHA,
      audit_sha256: auditSha256,
      outputs: [relativePath(AUDIT_WRITE_PATH), relativePath(REPORT_WRITE_PATH)],
      summary: audit.global_summary
    },
    null,
    2
  )
);

function runCohortAudit(context) {
  const before = scoreCohort(context, context.evidence);
  const published = publishedScores(context);
  const duplicates = auditEvidenceDuplicates(context, context.evidence);
  const aliases = auditAliasMetrics(context, context.evidence);
  const urlQuality = auditUrlQuality(context, context.evidence);
  const eligibilityRejections = auditEligibilityRejections(context, context.evidence);
  const missingData = auditMissingData(context, context.evidence);
  const cleaning = cleanEvidence(context, context.evidence);
  const after = scoreCohort(context, cleaning.evidence);
  const beforeAfter = compareRankedScores(before.rows, after.rows);
  const beforeAfterByPlatform = comparePlatformScores(context, before, after);
  const outliers = auditOutliers(context, context.evidence, before, after);
  const invariantObservations = cohortInvariantObservations(
    context,
    before,
    after,
    cleaning,
    beforeAfterByPlatform
  );

  return {
    cohort: context.slug,
    label: context.label,
    input_counts: {
      companies: context.companies.length,
      founders: context.founders.length,
      evidence_rows: context.evidence.length,
      scored_evidence_rows: before.evidence.filter(isScoredEvidence).length
    },
    canonical_duplicates: duplicates,
    alias_metric_duplication: aliases,
    url_quality: urlQuality,
    eligibility_rejections: eligibilityRejections,
    missing_data: missingData,
    outliers,
    platform_concentration: {
      before: platformConcentration(before),
      after: platformConcentration(after)
    },
    scoring: {
      published_reference: summarizeScoredCohort(published),
      diagnostic_before: summarizeScoredCohort(before),
      diagnostic_after: summarizeScoredCohort(after),
      published_vs_diagnostic_before: compareRankedScores(published.rows, before.rows),
      before_vs_after: beforeAfter,
      before_vs_after_by_platform: beforeAfterByPlatform,
      after_transformation: cleaning.summary
    },
    perturbations: {
      monotonicity: runMonotonicityAudit(context, before),
      stability: runStabilityAudit(context, before)
    },
    invariant_observations: invariantObservations
  };
}

function cohortInvariantObservations(context, before, after, cleaning, platformSlices) {
  const expectedCompanyIds = context.companies.map((company) => company.id).sort(compareText);
  const afterIneligibleRows = cleaning.evidence.filter(
    (item) => !scoringEligibility(item).eligible
  );
  const retainedAuditKeyCounts = countBy(cleaning.evidence, (item) => item.__auditKey);
  const duplicateRetainedAuditKeys = retainedAuditKeyCounts.filter((entry) => entry.count > 1);
  const physicalDuplicateGroups = [...groupBy(
    cleaning.evidence,
    (item) => eligibleCompanyScopedKey(context, item, (row) => canonicalPostKey(row))
  ).entries()]
    .filter(([key, rows]) => key && rows.length > 1)
    .map(([key, rows]) => ({ key, row_count: rows.length }))
    .sort(compareDuplicateGroups);
  const ambiguousOwnerEligibleRows = cleaning.evidence.filter((item) => {
    if (!scoringEligibility(item).eligible) return false;
    return (context.entityOwners.get(item.entityId) ?? new Set()).size !== 1;
  });
  const platformRankObservations = platformSlices.map((slice) => ({
    platform: slice.platform,
    before: rankedRowsObservation(slice.score_before.ranked_companies, expectedCompanyIds),
    after: rankedRowsObservation(slice.score_after.ranked_companies, expectedCompanyIds),
    baseline_only_company_count: slice.before_vs_after.baseline_only_company_ids.length,
    variant_only_company_count: slice.before_vs_after.variant_only_company_ids.length
  }));

  return {
    before_ranks: rankedRowsObservation(before.rows, expectedCompanyIds),
    after_ranks: rankedRowsObservation(after.rows, expectedCompanyIds),
    cleanup_row_accounting_delta:
      cleaning.summary.before_evidence_rows -
      cleaning.summary.after_evidence_rows -
      cleaning.summary.removed_row_count,
    after_ineligible_row_count: afterIneligibleRows.length,
    after_ineligible_audit_keys: afterIneligibleRows
      .map((item) => item.__auditKey)
      .sort(compareText),
    duplicate_retained_audit_key_count: duplicateRetainedAuditKeys.length,
    duplicate_retained_audit_keys: duplicateRetainedAuditKeys,
    eligible_company_physical_duplicate_group_count: physicalDuplicateGroups.length,
    eligible_company_physical_duplicate_groups: physicalDuplicateGroups,
    ambiguous_owner_eligible_row_count: ambiguousOwnerEligibleRows.length,
    ambiguous_owner_eligible_audit_keys: ambiguousOwnerEligibleRows
      .map((item) => item.__auditKey)
      .sort(compareText),
    expected_platform_slice_count: WEIGHTED_PLATFORMS.length,
    observed_platform_slice_count: platformSlices.length,
    missing_platform_slices: WEIGHTED_PLATFORMS.filter(
      (platform) => !platformSlices.some((slice) => slice.platform === platform)
    ),
    platform_rank_observations: platformRankObservations
  };
}

function rankedRowsObservation(rows, expectedCompanyIds) {
  const companyIds = rows.map((row) => row.company_id);
  const uniqueCompanyIds = new Set(companyIds);
  const expectedSet = new Set(expectedCompanyIds);
  const sortedRows = [...rows].sort((left, right) =>
    right.score - left.score ||
    compareText(left.company_name, right.company_name) ||
    compareText(left.company_id, right.company_id)
  );

  return {
    row_count: rows.length,
    expected_row_count: expectedCompanyIds.length,
    duplicate_company_id_count: rows.length - uniqueCompanyIds.size,
    missing_company_ids: expectedCompanyIds.filter((companyId) => !uniqueCompanyIds.has(companyId)),
    unexpected_company_ids: sortedUnique(
      companyIds.filter((companyId) => !expectedSet.has(companyId))
    ),
    invalid_rank_count: rows.filter((row, index) => row.rank !== index + 1).length,
    order_mismatch_count: rows.filter(
      (row, index) => row.company_id !== sortedRows[index]?.company_id
    ).length,
    non_finite_score_count: rows.filter((row) => !Number.isFinite(row.score)).length,
    out_of_bounds_score_count: rows.filter(
      (row) => Number.isFinite(row.score) && (row.score < 0 || row.score > 100)
    ).length
  };
}

function buildCohortContext(slug) {
  const batch = yc2026GraphDataset.batches.find((candidate) => candidate.slug === slug);
  const companies = yc2026GraphDataset.companies.filter((company) => company.batchSlug === slug);
  const founders = yc2026GraphDataset.founders.filter((founder) => founder.batchSlug === slug);
  const entityIds = new Set([
    ...companies.map((company) => company.id),
    ...founders.map((founder) => founder.id)
  ]);
  const entityOwners = new Map();

  for (const company of companies) {
    for (const entityId of [company.id, ...company.founderIds]) {
      entityOwners.set(entityId, new Set([...(entityOwners.get(entityId) ?? []), company.id]));
    }
  }

  const evidence = yc2026GraphDataset.evidence.flatMap((item, index) =>
    entityIds.has(item.entityId)
      ? [
          {
            ...item,
            metrics: { ...(item.metrics ?? {}) },
            __auditKey: `${slug}:${String(index).padStart(6, "0")}:${item.id}`
          }
        ]
      : []
  );

  return {
    slug,
    label: batch?.label ?? slug,
    companies,
    founders,
    entityIds,
    entityOwners,
    evidence
  };
}

function scoreCohort(context, inputEvidence, options = {}) {
  const evidence = normalizeEvidenceScores(inputEvidence.map(cloneEvidence), options);
  return scoreNormalizedCohort(context, evidence);
}

function scoreNormalizedCohort(context, evidence) {
  const evidenceByEntity = groupBy(evidence, (item) => item.entityId);
  const rows = rankRows(
    context.companies.map((company) => {
      const relatedEntityIds = [company.id, ...company.founderIds];
      const companyEvidence = dedupeEvidenceForScoring(
        relatedEntityIds.flatMap((entityId) => evidenceByEntity.get(entityId) ?? [])
      );
      const breakdown = aggregateBalancedTractionScore(companyEvidence);

      return {
        company_id: company.id,
        company_name: company.name,
        score: breakdown.totalScore,
        top_platform: breakdown.weightedPlatforms[0]?.platform ?? null,
        scored_evidence_rows: breakdown.weightedPlatforms.reduce(
          (sum, platform) => sum + platform.evidenceCount,
          0
        ),
        platforms_with_evidence: breakdown.platformsWithEvidence,
        breakdown
      };
    })
  );

  return { evidence, rows };
}

function comparePlatformScores(context, before, after) {
  return WEIGHTED_PLATFORMS.map((platform) => {
    const beforePlatform = scoreNormalizedCohort(
      context,
      before.evidence.filter((item) => item.platform === platform)
    );
    const afterPlatform = scoreNormalizedCohort(
      context,
      after.evidence.filter((item) => item.platform === platform)
    );

    return {
      platform,
      evidence_rows_before: beforePlatform.evidence.length,
      evidence_rows_after: afterPlatform.evidence.length,
      scored_evidence_rows_before: beforePlatform.evidence.filter(isScoredEvidence).length,
      scored_evidence_rows_after: afterPlatform.evidence.filter(isScoredEvidence).length,
      score_before: summarizeScoredCohort(beforePlatform),
      score_after: summarizeScoredCohort(afterPlatform),
      before_vs_after: compareRankedScores(beforePlatform.rows, afterPlatform.rows)
    };
  });
}

function publishedScores(context) {
  return {
    evidence: context.evidence,
    rows: rankRows(
      context.companies.map((company) => ({
        company_id: company.id,
        company_name: company.name,
        score: company.totalScore,
        top_platform: company.scoreBreakdown?.weightedPlatforms[0]?.platform ?? null,
        scored_evidence_rows:
          company.scoreBreakdown?.weightedPlatforms.reduce(
            (sum, platform) => sum + platform.evidenceCount,
            0
          ) ?? 0,
        platforms_with_evidence: company.scoreBreakdown?.platformsWithEvidence ?? 0,
        breakdown: company.scoreBreakdown ?? aggregateBalancedTractionScore([])
      }))
    )
  };
}

function summarizeScoredCohort(scored) {
  const scores = scored.rows.map((row) => row.score);
  return {
    company_count: scored.rows.length,
    nonzero_company_count: scores.filter((score) => score > 0).length,
    score_distribution: summarizeNumbers(scores),
    top_10: scored.rows.slice(0, 10).map(publicRankRow),
    ranked_companies: scored.rows.map(publicRankRow)
  };
}

function publicRankRow(row) {
  return {
    rank: row.rank,
    company_id: row.company_id,
    company_name: row.company_name,
    score: row.score,
    top_platform: row.top_platform,
    scored_evidence_rows: row.scored_evidence_rows,
    platforms_with_evidence: row.platforms_with_evidence
  };
}

function auditEvidenceDuplicates(context, evidence) {
  return {
    canonical_evidence_ids: duplicateEvidenceGroups(
      context,
      evidence,
      (item) => canonicalIdentifier(item.id)
    ),
    canonical_platform_post_ids: duplicateEvidenceGroups(
      context,
      evidence,
      (item) =>
        item.platformPostId
          ? `${item.platform}:${canonicalIdentifier(item.platformPostId)}`
          : null
    ),
    production_canonical_evidence_keys: duplicateEvidenceGroups(
      context,
      evidence,
      (item) => canonicalEvidenceKey(item)
    ),
    production_canonical_post_keys: duplicateEvidenceGroups(
      context,
      evidence,
      (item) => canonicalPostKey(item)
    ),
    canonical_source_urls: duplicateEvidenceGroups(
      context,
      evidence,
      (item) => canonicalEvidenceUrl(item.sourceUrl) || null
    )
  };
}

function duplicateEvidenceGroups(context, evidence, keyFunction) {
  const groups = [...groupBy(evidence, keyFunction).entries()]
    .filter(([key, rows]) => key && rows.length > 1)
    .map(([key, rows]) => evidenceDuplicateGroup(context, key, rows))
    .sort(compareDuplicateGroups);

  return {
    group_count: groups.length,
    row_count: groups.reduce((sum, group) => sum + group.row_count, 0),
    scored_row_count: groups.reduce((sum, group) => sum + group.scored_row_count, 0),
    groups
  };
}

function evidenceDuplicateGroup(context, key, rows) {
  const ownerCompanyIds = sortedUnique(
    rows.flatMap((item) => [...(context.entityOwners.get(item.entityId) ?? [])])
  );

  return {
    key,
    row_count: rows.length,
    scored_row_count: rows.filter(isScoredEvidence).length,
    owner_scope:
      ownerCompanyIds.length === 1
        ? "same_company"
        : ownerCompanyIds.length > 1
          ? "cross_company"
          : "unresolved",
    owner_company_ids: ownerCompanyIds,
    evidence_ids: sortedUnique(rows.map((item) => item.id)),
    platform_post_ids: sortedUnique(rows.map((item) => item.platformPostId).filter(Boolean)),
    canonical_urls: sortedUnique(
      rows.map((item) => canonicalEvidenceUrl(item.sourceUrl)).filter(Boolean)
    ),
    platforms: sortedUnique(rows.map((item) => item.platform)),
    entity_ids: sortedUnique(rows.map((item) => item.entityId)),
    rows: rows.map((item) => evidenceReference(item, context)).sort(compareEvidenceReferences)
  };
}

function auditGlobalDuplicates() {
  const companyGroups = duplicateEntityGroups(yc2026GraphDataset.companies, "company");
  const founderGroups = duplicateEntityGroups(yc2026GraphDataset.founders, "founder");
  const socialAccounts = [
    ...yc2026GraphDataset.companies.flatMap((company) =>
      company.socialAccounts.map((account) => ({
        entity_type: "company",
        entity_id: company.id,
        entity_name: company.name,
        batch_slug: company.batchSlug,
        platform: account.platform,
        url: account.url
      }))
    ),
    ...yc2026GraphDataset.founders.flatMap((founder) =>
      founder.socialAccounts.map((account) => ({
        entity_type: "founder",
        entity_id: founder.id,
        entity_name: founder.name,
        batch_slug: founder.batchSlug,
        platform: account.platform,
        url: account.url
      }))
    )
  ];
  const socialAccountGroups = [...groupBy(socialAccounts, (account) => {
    const canonicalUrl = canonicalEvidenceUrl(account.url);
    return canonicalUrl ? `${account.platform}:${canonicalUrl}` : null;
  }).entries()]
    .filter(([key, rows]) => key && rows.length > 1)
    .map(([key, rows]) => ({
      key,
      row_count: rows.length,
      distinct_entity_count: new Set(rows.map((row) => `${row.entity_type}:${row.entity_id}`)).size,
      rows: [...rows].sort((left, right) =>
        compareText(
          `${left.batch_slug}:${left.entity_type}:${left.entity_id}`,
          `${right.batch_slug}:${right.entity_type}:${right.entity_id}`
        )
      )
    }))
    .sort(compareDuplicateGroups);
  const allEvidenceContext = {
    entityOwners: new Map(
      [...new Set(cohortContexts.flatMap((context) => [...context.entityOwners.keys()]))].map(
        (entityId) => [
          entityId,
          new Set(
            cohortContexts.flatMap((context) => [
              ...(context.entityOwners.get(entityId) ?? [])
            ])
          )
        ]
      )
    )
  };
  const allEvidence = yc2026GraphDataset.evidence.map((item, index) => ({
    ...item,
    metrics: { ...(item.metrics ?? {}) },
    __auditKey: `global:${String(index).padStart(6, "0")}:${item.id}`
  }));

  return {
    canonical_company_ids: companyGroups,
    canonical_founder_ids: founderGroups,
    canonical_social_account_urls: {
      group_count: socialAccountGroups.length,
      row_count: socialAccountGroups.reduce((sum, group) => sum + group.row_count, 0),
      groups: socialAccountGroups
    },
    evidence: auditEvidenceDuplicates(allEvidenceContext, allEvidence)
  };
}

function duplicateEntityGroups(entities, entityType) {
  const groups = [...groupBy(entities, (entity) => canonicalIdentifier(entity.id)).entries()]
    .filter(([key, rows]) => key && rows.length > 1)
    .map(([key, rows]) => ({
      key,
      row_count: rows.length,
      batch_slugs: sortedUnique(rows.map((row) => row.batchSlug)),
      rows: rows
        .map((row) => ({
          entity_type: entityType,
          entity_id: row.id,
          entity_name: row.name,
          batch_slug: row.batchSlug,
          source_url: row.sourceUrl
        }))
        .sort((left, right) =>
          compareText(`${left.batch_slug}:${left.entity_id}`, `${right.batch_slug}:${right.entity_id}`)
        )
    }))
    .sort(compareDuplicateGroups);

  return {
    group_count: groups.length,
    row_count: groups.reduce((sum, group) => sum + group.row_count, 0),
    groups
  };
}

function auditAliasMetrics(context, evidence) {
  const findings = evidence
    .flatMap((item) => aliasFindings(item).map((finding) => ({
      ...evidenceReference(item, context),
      alias_group: finding.group.id,
      canonical_metric: finding.group.canonicalMetric,
      values: finding.values,
      values_are_equal: finding.valuesAreEqual
    })))
    .sort((left, right) =>
      compareText(`${left.alias_group}:${left.evidence_id}`, `${right.alias_group}:${right.evidence_id}`)
    );
  const uniqueRows = new Set(findings.map((finding) => finding.audit_key));
  const scoredRows = new Set(
    findings.filter((finding) => finding.scored).map((finding) => finding.audit_key)
  );

  return {
    finding_count: findings.length,
    row_count: uniqueRows.size,
    scored_row_count: scoredRows.size,
    by_alias_group: countBy(findings, (finding) => finding.alias_group),
    findings
  };
}

function aliasFindings(item) {
  return ALIAS_GROUPS.flatMap((group) => {
    if (!group.platforms.has(item.platform)) {
      return [];
    }

    const positiveEntries = group.metrics
      .map((metric) => [metric, Number(item.metrics?.[metric])])
      .filter(([, value]) => Number.isFinite(value) && value > 0);
    if (positiveEntries.length < 2) {
      return [];
    }

    const values = Object.fromEntries(positiveEntries);
    const distinctValues = new Set(positiveEntries.map(([, value]) => value));
    if (group.requireEqual && distinctValues.size !== 1) {
      return [];
    }

    return [{ group, values, valuesAreEqual: distinctValues.size === 1 }];
  });
}

function auditUrlQuality(context, evidence) {
  const findings = evidence
    .flatMap((item) =>
      classifyEvidenceUrl(item).issues.map((issue) => ({
        ...evidenceReference(item, context),
        issue
      }))
    )
    .sort((left, right) => compareText(`${left.issue}:${left.evidence_id}`, `${right.issue}:${right.evidence_id}`));

  return {
    finding_count: findings.length,
    row_count: new Set(findings.map((finding) => finding.audit_key)).size,
    scored_row_count: new Set(
      findings.filter((finding) => finding.scored).map((finding) => finding.audit_key)
    ).size,
    by_issue: countBy(findings, (finding) => finding.issue),
    scored_by_issue: countBy(
      findings.filter((finding) => finding.scored),
      (finding) => finding.issue
    ),
    findings
  };
}

function classifyEvidenceUrl(item) {
  let parsed;
  try {
    parsed = new URL(item.sourceUrl);
  } catch {
    return { issues: ["invalid_url"] };
  }

  if (item.platform === "web" || item.platform === "rss") {
    return { issues: [] };
  }

  const host = normalizedHost(parsed.hostname);
  const pathName = parsed.pathname.toLowerCase();
  const nativeHost = isNativePlatformHost(item.platform, host);
  const productionNativeEvidence = isNativeEvidenceUrl(item.platform, item.sourceUrl);

  if (isSearchUrl(parsed, host, pathName)) {
    return { issues: ["search_url"] };
  }
  if (!nativeHost) {
    return { issues: ["non_native_url"] };
  }
  if (!productionNativeEvidence && isProfileUrl(item.platform, parsed, host, pathName)) {
    return { issues: ["profile_url"] };
  }
  if (!productionNativeEvidence) {
    return { issues: ["non_native_url"] };
  }

  return { issues: [] };
}

function isNativePlatformHost(platform, host) {
  if (platform === "github") return host === "github.com";
  if (platform === "x") return host === "x.com" || host === "twitter.com";
  if (platform === "linkedin") return host === "linkedin.com" || host.endsWith(".linkedin.com");
  if (platform === "instagram") return host === "instagram.com" || host.endsWith(".instagram.com");
  if (platform === "product_hunt") return host === "producthunt.com";
  if (platform === "youtube") return host === "youtube.com" || host === "youtu.be";
  if (platform === "reddit") return host === "reddit.com" || host.endsWith(".reddit.com");
  if (platform === "hacker_news") return host === "news.ycombinator.com";
  if (platform === "bilibili") {
    return host === "bilibili.com" || host.endsWith(".bilibili.com") || host === "b23.tv";
  }
  return false;
}

function isSearchUrl(url, host, pathName) {
  const searchHosts = new Set([
    "google.com",
    "bing.com",
    "duckduckgo.com",
    "search.brave.com"
  ]);
  if (searchHosts.has(host)) return true;
  if (/\/(search|results)(\/|$)/.test(pathName)) return true;
  if (pathName.startsWith("/explore/") && (url.searchParams.has("q") || pathName.includes("tags"))) {
    return true;
  }
  return false;
}

function isProfileUrl(platform, url, host, pathName) {
  const parts = pathName.split("/").filter(Boolean);
  if (platform === "github") {
    return parts.length <= 1 || (parts[0] === "orgs" && parts.length <= 2);
  }
  if (platform === "x") return !/\/(?:i\/web\/)?status\/\d+/.test(pathName);
  if (platform === "instagram") return !/^\/(p|reel|tv)\/[^/]+/.test(pathName);
  if (platform === "linkedin") {
    return /^\/(in|company|school|showcase)\//.test(pathName) && !pathName.includes("/posts/");
  }
  if (platform === "youtube") {
    if (host === "youtu.be") return parts.length === 0;
    const isContent =
      (pathName === "/watch" && url.searchParams.has("v")) ||
      /^\/(shorts|live|clip)\//.test(pathName);
    return !isContent && /^\/(?:@|channel\/|c\/|user\/)/.test(pathName);
  }
  if (platform === "product_hunt") return /^\/@/.test(pathName) || pathName === "/";
  if (platform === "reddit") return /^\/user\//.test(pathName) || /^\/r\/[^/]+\/?$/.test(pathName);
  if (platform === "hacker_news") return pathName === "/user" || !url.searchParams.has("id");
  if (platform === "bilibili") return host.startsWith("space.") || pathName.startsWith("/space/");
  return false;
}

function auditEligibilityRejections(context, evidence) {
  const evaluated = evidence.map((item) => ({
    item,
    eligibility: scoringEligibility(item)
  }));
  const findings = evaluated
    .filter(({ eligibility }) => !eligibility.eligible)
    .map(({ item, eligibility }) => ({
      ...evidenceReference(item, context),
      reason: eligibility.reason
    }))
    .sort((left, right) =>
      compareText(`${left.reason}:${left.audit_key}`, `${right.reason}:${right.audit_key}`)
    );
  const eligibleRows = evaluated
    .filter(({ eligibility }) => eligibility.eligible)
    .map(({ item }) => item);

  return {
    evaluated_row_count: evaluated.length,
    eligible_row_count: eligibleRows.length,
    rejected_row_count: findings.length,
    rejected_upstream_enabled_row_count: findings.filter((finding) => finding.scored).length,
    by_reason: countBy(findings, (finding) => finding.reason),
    by_platform: countBy(findings, (finding) => finding.platform),
    findings
  };
}

function auditMissingData(context, evidence) {
  const findings = evidence
    .flatMap((item) => missingDataIssues(item).map((issue) => ({
      ...evidenceReference(item, context),
      issue
    })))
    .sort((left, right) => compareText(`${left.issue}:${left.evidence_id}`, `${right.issue}:${right.evidence_id}`));

  return {
    finding_count: findings.length,
    row_count: new Set(findings.map((finding) => finding.audit_key)).size,
    scored_row_count: new Set(
      findings.filter((finding) => finding.scored).map((finding) => finding.audit_key)
    ).size,
    by_issue: countBy(findings, (finding) => finding.issue),
    scored_by_issue: countBy(
      findings.filter((finding) => finding.scored),
      (finding) => finding.issue
    ),
    findings
  };
}

function missingDataIssues(item) {
  const issues = [];
  const metricEntries = Object.entries(item.metrics ?? {}).filter(
    ([, value]) => value !== null && value !== undefined && Number.isFinite(Number(value))
  );
  const positiveMetrics = metricEntries.filter(([, value]) => Number(value) > 0);

  if (!item.postedAt || !Number.isFinite(Date.parse(item.postedAt))) {
    issues.push("missing_or_invalid_publication_date");
  } else if (item.publishedAtPrecision === "unknown") {
    issues.push("publication_date_precision_unknown");
  } else if (!item.publishedAtPrecision) {
    issues.push("publication_date_precision_unrecorded");
  }
  if (!metricEntries.length) {
    issues.push("no_metric_values");
  } else if (!positiveMetrics.length) {
    issues.push("no_positive_metric_values");
  }
  if (computeEvidenceRawEngagement(item.platform, item.metrics ?? {}) <= 0) {
    issues.push("no_positive_scoring_engagement");
  }

  return issues;
}

function cleanEvidence(context, evidence) {
  const removed = [];
  const aliasChanges = [];
  let retained = [];

  for (const sourceItem of evidence) {
    const item = cloneEvidence(sourceItem);
    const eligibility = scoringEligibility(item);
    const blockingMissingIssues = missingDataIssues(item).filter((issue) =>
      ["no_metric_values", "no_positive_metric_values", "no_positive_scoring_engagement"].includes(issue)
    );
    const reasons = [
      ...classifyEvidenceUrl(item).issues,
      ...blockingMissingIssues,
      ...(eligibility.eligible ? [] : [`production_rejection_${eligibility.reason}`])
    ];
    if (reasons.length) {
      removed.push({
        ...evidenceReference(item, context),
        production_eligibility_reason: eligibility.reason,
        reasons: sortedUnique(reasons)
      });
      continue;
    }

    const collapsed = collapseAliasMetrics(item);
    retained.push(collapsed.item);
    if (collapsed.groups.length) {
      aliasChanges.push({
        ...evidenceReference(item, context),
        alias_groups: collapsed.groups
      });
    }
  }

  const productionDedupe = dedupeWithProduction(context, retained, removed);
  retained = productionDedupe.retained;
  removed.splice(0, removed.length, ...productionDedupe.removed);

  const physicalPostDedupe = dedupeSameOwner(
    context,
    retained,
    (item) => canonicalPostKey(item),
    "same_company_eligible_physical_post_duplicate",
    (rows) => dedupeEvidenceForScoring(rows)[0]
  );
  retained = physicalPostDedupe.retained;
  removed.push(...physicalPostDedupe.removed);

  const sameOwnerIdDedupe = dedupeSameOwner(
    context,
    retained,
    (item) => canonicalIdentifier(item.id),
    "same_company_canonical_evidence_id_duplicate"
  );
  retained = sameOwnerIdDedupe.retained;
  removed.push(...sameOwnerIdDedupe.removed);

  const sameOwnerUrlDedupe = dedupeSameOwner(
    context,
    retained,
    (item) => canonicalEvidenceUrl(item.sourceUrl) || null,
    "same_company_canonical_url_duplicate"
  );
  retained = sameOwnerUrlDedupe.retained;
  removed.push(...sameOwnerUrlDedupe.removed);

  return {
    evidence: retained,
    summary: {
      before_evidence_rows: evidence.length,
      after_evidence_rows: retained.length,
      removed_row_count: removed.length,
      alias_changed_row_count: new Set(aliasChanges.map((change) => change.audit_key)).size,
      removed_by_reason: countBy(
        removed.flatMap((row) => row.reasons.map((reason) => ({ reason }))),
        (row) => row.reason
      ),
      eligible_physical_dedupe: {
        group_count: physicalPostDedupe.group_count,
        removed_row_count: physicalPostDedupe.removed.length,
        groups: physicalPostDedupe.groups
      },
      removed_rows: removed.sort((left, right) => compareText(left.audit_key, right.audit_key)),
      alias_changed_rows: aliasChanges.sort((left, right) => compareText(left.audit_key, right.audit_key))
    }
  };
}

function dedupeWithProduction(context, retained, previousRemoved) {
  const deduped = dedupeEvidenceItems(retained);
  const keptKeys = new Set(deduped.map((item) => item.__auditKey));
  const removed = [
    ...previousRemoved,
    ...retained
      .filter((item) => !keptKeys.has(item.__auditKey))
      .map((item) => ({
        ...evidenceReference(item, context),
        reasons: ["production_canonical_evidence_key_duplicate"]
      }))
  ];

  return { retained: deduped, removed };
}

function dedupeSameOwner(
  context,
  evidence,
  keyFunction,
  reason,
  preferredRow = (rows) => [...rows].sort(comparePreferredEvidence)[0]
) {
  const groups = groupBy(evidence, (item) =>
    eligibleCompanyScopedKey(context, item, keyFunction)
  );
  const removedKeys = new Set();
  const removed = [];
  const duplicateGroups = [];

  for (const [key, rows] of groups) {
    if (!key || rows.length < 2) continue;
    const preferred = preferredRow(rows);
    if (!preferred) continue;
    const removedEvidenceIds = [];
    for (const item of rows) {
      if (item.__auditKey === preferred.__auditKey) continue;
      removedKeys.add(item.__auditKey);
      removedEvidenceIds.push(item.id);
      removed.push({
        ...evidenceReference(item, context),
        reasons: [reason],
        retained_evidence_id: preferred.id
      });
    }
    duplicateGroups.push({
      key,
      row_count: rows.length,
      retained_evidence_id: preferred.id,
      removed_evidence_ids: sortedUnique(removedEvidenceIds)
    });
  }

  return {
    retained: evidence.filter((item) => !removedKeys.has(item.__auditKey)),
    removed,
    group_count: duplicateGroups.length,
    groups: duplicateGroups.sort(compareDuplicateGroups)
  };
}

function unambiguousCompanyOwnerKey(context, item) {
  const owners = [...(context.entityOwners.get(item.entityId) ?? [])].sort(compareText);
  return owners.length === 1 ? `company:${owners[0]}` : null;
}

function eligibleCompanyScopedKey(context, item, keyFunction) {
  if (!scoringEligibility(item).eligible) return null;
  const ownerKey = unambiguousCompanyOwnerKey(context, item);
  if (!ownerKey) return null;
  const key = keyFunction(item);
  return key ? `${ownerKey}:${item.platform}:${key}` : null;
}

function comparePreferredEvidence(left, right) {
  const leftValues = [
    isScoredEvidence(left) ? 1 : 0,
    computeEvidenceRawEngagement(left.platform, left.metrics ?? {}),
    evidenceFreshness(left)
  ];
  const rightValues = [
    isScoredEvidence(right) ? 1 : 0,
    computeEvidenceRawEngagement(right.platform, right.metrics ?? {}),
    evidenceFreshness(right)
  ];

  for (let index = 0; index < leftValues.length; index += 1) {
    if (leftValues[index] !== rightValues[index]) {
      return rightValues[index] - leftValues[index];
    }
  }
  return compareText(left.id, right.id);
}

function collapseAliasMetrics(item) {
  const findings = aliasFindings(item);
  if (!findings.length) {
    return { item, groups: [] };
  }

  return {
    item: {
      ...item,
      metrics: normalizeMetricsForScoring(item.platform, item.metrics ?? {})
    },
    groups: findings.map((finding) => finding.group.id).sort(compareText)
  };
}

function platformConcentration(scored) {
  const evidenceCounts = new Map();
  const scoredEvidenceCounts = new Map();
  for (const item of scored.evidence) {
    evidenceCounts.set(item.platform, (evidenceCounts.get(item.platform) ?? 0) + 1);
    if (isScoredEvidence(item)) {
      scoredEvidenceCounts.set(item.platform, (scoredEvidenceCounts.get(item.platform) ?? 0) + 1);
    }
  }

  const contributionTotals = new Map();
  const dominantPlatformCounts = new Map();
  const dominantShares = [];
  let singlePlatformCompanies = 0;
  let nonzeroCompanies = 0;

  for (const row of scored.rows) {
    const weightedPlatforms = row.breakdown.weightedPlatforms ?? [];
    if (!weightedPlatforms.length) continue;
    nonzeroCompanies += 1;
    if (weightedPlatforms.length === 1) singlePlatformCompanies += 1;
    dominantPlatformCounts.set(
      weightedPlatforms[0].platform,
      (dominantPlatformCounts.get(weightedPlatforms[0].platform) ?? 0) + 1
    );
    const contributionSum = weightedPlatforms.reduce(
      (sum, platform) => sum + platform.contribution,
      0
    );
    dominantShares.push(
      contributionSum > 0 ? weightedPlatforms[0].contribution / contributionSum : 0
    );
    for (const platform of weightedPlatforms) {
      contributionTotals.set(
        platform.platform,
        (contributionTotals.get(platform.platform) ?? 0) + platform.contribution
      );
    }
  }

  return {
    evidence_rows_by_platform: mapCountsWithShare(evidenceCounts),
    scored_evidence_rows_by_platform: mapCountsWithShare(scoredEvidenceCounts),
    aggregate_score_contribution_by_platform: mapValuesWithShare(contributionTotals),
    contribution_hhi: concentrationHhi(contributionTotals),
    dominant_platform_company_counts: mapCountsWithShare(dominantPlatformCounts),
    single_platform_company_share: round(
      nonzeroCompanies ? singlePlatformCompanies / nonzeroCompanies : 0,
      4
    ),
    median_dominant_platform_share: round(median(dominantShares), 4)
  };
}

function auditOutliers(context, evidence, before, after) {
  const eligibleRows = evidence.filter((item) => scoringEligibility(item).eligible);
  const platformProfiles = WEIGHTED_PLATFORMS.map((platform) => {
    const rows = eligibleRows.filter((item) => item.platform === platform);
    const profile = tukeyProfile(
      rows.map((item) => computeEvidenceRawEngagement(item.platform, item.metrics ?? {})),
      (value) => Math.log1p(value),
      (value) => Math.max(0, Math.expm1(value))
    );
    const findings = rows
      .map((item) => {
        const rawEngagement = computeEvidenceRawEngagement(item.platform, item.metrics ?? {});
        const direction = tukeyOutlierDirection(rawEngagement, profile, (value) => Math.log1p(value));
        return direction
          ? {
              ...evidenceReference(item, context),
              direction,
              raw_engagement: rawEngagement
            }
          : null;
      })
      .filter(Boolean)
      .sort((left, right) =>
        compareText(left.direction, right.direction) ||
        right.raw_engagement - left.raw_engagement ||
        compareText(left.audit_key, right.audit_key)
      );

    return {
      platform,
      ...profile,
      outlier_count: findings.length,
      findings
    };
  });

  return {
    method:
      "Tukey 1.5 IQR fences; evidence uses log1p(raw production-weighted engagement), company scores use the 0-100 score directly, and samples smaller than four are not classified.",
    evidence_raw_engagement: {
      eligible_row_count: eligibleRows.length,
      outlier_count: platformProfiles.reduce(
        (sum, profile) => sum + profile.outlier_count,
        0
      ),
      by_platform: platformProfiles
    },
    company_scores: {
      before: companyScoreOutliers(before.rows),
      after: companyScoreOutliers(after.rows)
    }
  };
}

function companyScoreOutliers(rows) {
  const profile = tukeyProfile(
    rows.map((row) => row.score),
    (value) => value,
    (value) => value
  );
  const findings = rows
    .map((row) => {
      const direction = tukeyOutlierDirection(row.score, profile, (value) => value);
      return direction
        ? {
            rank: row.rank,
            company_id: row.company_id,
            company_name: row.company_name,
            score: row.score,
            direction
          }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) =>
      compareText(left.direction, right.direction) ||
      right.score - left.score ||
      compareText(left.company_id, right.company_id)
    );

  return {
    ...profile,
    outlier_count: findings.length,
    findings
  };
}

function tukeyProfile(values, transform, inverse) {
  const transformed = values
    .filter(Number.isFinite)
    .map(transform)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (transformed.length < 4) {
    return {
      sample_count: transformed.length,
      q1: null,
      q3: null,
      iqr: null,
      lower_fence: null,
      upper_fence: null,
      transformed_lower_fence: null,
      transformed_upper_fence: null
    };
  }
  const q1 = percentile(transformed, 0.25);
  const q3 = percentile(transformed, 0.75);
  const iqr = q3 - q1;
  const transformedLowerFence = q1 - iqr * 1.5;
  const transformedUpperFence = q3 + iqr * 1.5;

  return {
    sample_count: transformed.length,
    q1: round(inverse(q1), 4),
    q3: round(inverse(q3), 4),
    iqr: round(iqr, 6),
    lower_fence: round(inverse(transformedLowerFence), 4),
    upper_fence: round(inverse(transformedUpperFence), 4),
    transformed_lower_fence: round(transformedLowerFence, 6),
    transformed_upper_fence: round(transformedUpperFence, 6)
  };
}

function tukeyOutlierDirection(value, profile, transform) {
  if (
    profile.transformed_lower_fence === null ||
    profile.transformed_upper_fence === null ||
    !Number.isFinite(value)
  ) {
    return null;
  }
  const transformed = transform(value);
  if (transformed < profile.transformed_lower_fence) return "low";
  if (transformed > profile.transformed_upper_fence) return "high";
  return null;
}

function runStabilityAudit(context, before) {
  const scenarios = [
    {
      name: "reverse_input_order",
      evidence: [...context.evidence].reverse().map(cloneEvidence)
    },
    {
      name: "configured_metrics_plus_1_percent",
      evidence: context.evidence.map(scaleConfiguredMetrics)
    },
    {
      name: "collection_timestamps_plus_24_hours",
      evidence: context.evidence.map(advanceCollectionClock)
    }
  ];

  return scenarios.map((scenario) => ({
    name: scenario.name,
    ...compareRankedScores(before.rows, scoreCohort(context, scenario.evidence).rows)
  }));
}

function runMonotonicityAudit(context, before) {
  const sampleLimitPerPlatform = 40;
  const fullBaselineByKey = new Map(
    before.evidence.map((item) => [item.__auditKey, item])
  );
  const eligibleRows = context.evidence.filter((item) => {
    const baselineItem = fullBaselineByKey.get(item.__auditKey);
    return (
      baselineItem &&
      isScoredEvidence(baselineItem) &&
      monotonicMetricCandidate(item) &&
      (context.entityOwners.get(item.entityId)?.size ?? 0) > 0
    );
  });
  const auditEvidence = stratifiedMonotonicitySample(
    eligibleRows,
    before,
    sampleLimitPerPlatform
  );
  const auditAsOf = monotonicityAuditReferenceTime(auditEvidence);
  const sampleBefore = scoreCohort(context, auditEvidence, { asOf: auditAsOf });
  const rawByPlatform = groupBy(auditEvidence, (item) => item.platform);
  const normalizedByKey = new Map(
    sampleBefore.evidence.map((item) => [item.__auditKey, item])
  );
  const companyRows = new Map(sampleBefore.rows.map((row) => [row.company_id, row]));
  const companyEvidence = new Map();

  for (const company of context.companies) {
    const entityIds = new Set([company.id, ...company.founderIds]);
    companyEvidence.set(
      company.id,
      sampleBefore.evidence.filter((item) => entityIds.has(item.entityId))
    );
  }

  let testedEvidenceRows = 0;
  let companyTests = 0;
  let skippedRows = 0;
  let rowScoreDecreaseCount = 0;
  const failures = [];

  for (const sourceItem of auditEvidence) {
    const baselineItem = normalizedByKey.get(sourceItem.__auditKey);
    if (!baselineItem || !isScoredEvidence(baselineItem)) continue;
    const candidate = monotonicMetricCandidate(sourceItem);
    const ownerCompanyIds = [...(context.entityOwners.get(sourceItem.entityId) ?? [])].sort(compareText);
    if (!candidate || !ownerCompanyIds.length) {
      skippedRows += 1;
      continue;
    }

    testedEvidenceRows += 1;
    const platformRows = rawByPlatform.get(sourceItem.platform) ?? [];
    const perturbedPlatformRows = platformRows.map((item) =>
      item.__auditKey === sourceItem.__auditKey
        ? {
            ...cloneEvidence(item),
            metrics: {
              ...item.metrics,
              [candidate.metric]: candidate.afterValue
            }
          }
        : cloneEvidence(item)
    );
    const normalizedPerturbedPlatform = normalizeEvidenceScores(perturbedPlatformRows, {
      asOf: auditAsOf
    });
    const replacements = new Map(
      normalizedPerturbedPlatform.map((item) => [item.__auditKey, item])
    );
    const perturbedItem = replacements.get(sourceItem.__auditKey);
    const rowScoreDecreased =
      Boolean(perturbedItem) && perturbedItem.contributionScore < baselineItem.contributionScore;
    if (rowScoreDecreased) rowScoreDecreaseCount += 1;

    for (const companyId of ownerCompanyIds) {
      const baselineCompany = companyRows.get(companyId);
      const baselineCompanyEvidence = companyEvidence.get(companyId) ?? [];
      if (!baselineCompany) continue;
      companyTests += 1;
      const perturbedCompanyEvidence = baselineCompanyEvidence.map(
        (item) => replacements.get(item.__auditKey) ?? item
      );
      const baselineCompanyBreakdown = aggregateBalancedTractionScore(
        baselineCompanyEvidence
      );
      const perturbedCompanyBreakdown = aggregateBalancedTractionScore(
        perturbedCompanyEvidence
      );
      const perturbedCompanyScore = perturbedCompanyBreakdown.totalScore;
      if (rowScoreDecreased || perturbedCompanyScore < baselineCompany.score) {
        failures.push({
          evidence_id: sourceItem.id,
          audit_key: sourceItem.__auditKey,
          company_id: companyId,
          platform: sourceItem.platform,
          metric: candidate.metric,
          metric_before: candidate.beforeValue,
          metric_after: candidate.afterValue,
          row_score_before: baselineItem.contributionScore,
          row_score_after: perturbedItem?.contributionScore ?? null,
          company_score_before: baselineCompany.score,
          company_score_after: perturbedCompanyScore,
          row_score_decreased: rowScoreDecreased,
          company_score_decreased: perturbedCompanyScore < baselineCompany.score,
          company_platform_scores_before: baselineCompanyBreakdown.platformScores,
          company_platform_scores_after: perturbedCompanyBreakdown.platformScores,
          company_evidence_changes: baselineCompanyEvidence
            .map((item) => {
              const replacement = replacements.get(item.__auditKey);
              return {
                evidence_id: item.id,
                platform: item.platform,
                score_before: item.contributionScore,
                score_after: replacement?.contributionScore ?? item.contributionScore
              };
            })
            .filter((item) => item.score_before !== item.score_after)
        });
      }
    }
  }

  failures.sort((left, right) =>
    right.company_score_before - right.company_score_after -
      (left.company_score_before - left.company_score_after) ||
    compareText(`${left.company_id}:${left.evidence_id}`, `${right.company_id}:${right.evidence_id}`)
  );

  return {
    eligible_scored_rows: eligibleRows.length,
    sampled_evidence_rows: auditEvidence.length,
    sample_limit_per_platform: sampleLimitPerPlatform,
    sample_coverage: round(
      eligibleRows.length ? auditEvidence.length / eligibleRows.length : 1,
      4
    ),
    sample_selection: "Evenly spaced by production raw engagement within each platform.",
    tested_evidence_rows: testedEvidenceRows,
    company_tests: companyTests,
    skipped_scored_rows: skippedRows,
    row_score_decrease_count: rowScoreDecreaseCount,
    company_score_decrease_count: failures.filter((failure) => failure.company_score_decreased).length,
    passed: failures.length === 0,
    failures
  };
}

function monotonicityAuditReferenceTime(evidence) {
  const timestamps = evidence.flatMap((item) => [
    item.observedAt,
    item.metricsCheckedAt,
    item.ingestedAt
  ]);
  const latest = timestamps.reduce((latestTime, value) => {
    const parsed = Date.parse(value ?? "");
    return Number.isFinite(parsed) && parsed > latestTime ? parsed : latestTime;
  }, 0);
  return new Date(latest).toISOString();
}

function stratifiedMonotonicitySample(eligibleRows, before, limitPerPlatform) {
  const baselineByKey = new Map(before.evidence.map((item) => [item.__auditKey, item]));
  const selectedKeys = new Set();

  for (const rows of groupBy(eligibleRows, (item) => item.platform).values()) {
    const sorted = [...rows].sort((left, right) => {
      const leftRaw = baselineByKey.get(left.__auditKey)?.rawEngagement ?? 0;
      const rightRaw = baselineByKey.get(right.__auditKey)?.rawEngagement ?? 0;
      return leftRaw - rightRaw || compareText(left.__auditKey, right.__auditKey);
    });
    const sampleSize = Math.min(limitPerPlatform, sorted.length);
    if (sampleSize === 1) {
      selectedKeys.add(sorted[0].__auditKey);
      continue;
    }
    for (let index = 0; index < sampleSize; index += 1) {
      const sourceIndex = Math.round((index * (sorted.length - 1)) / (sampleSize - 1));
      selectedKeys.add(sorted[sourceIndex].__auditKey);
    }
  }

  return eligibleRows.filter((item) => selectedKeys.has(item.__auditKey)).map(cloneEvidence);
}

function monotonicMetricCandidate(item) {
  const platformWeights = TRACTION_SCORING_CONFIG.metricWeights[item.platform] ?? {};
  const candidates = Object.entries(platformWeights)
    .filter(([, weight]) => Number(weight) > 0)
    .map(([metric, weight]) => ({
      metric,
      weight: Number(weight),
      value: Number(item.metrics?.[metric])
    }))
    .filter((candidate) => Number.isFinite(candidate.value) && candidate.value >= 0)
    .sort((left, right) =>
      right.weight * Math.max(right.value, 1) - left.weight * Math.max(left.value, 1) ||
      compareText(left.metric, right.metric)
    );
  const selected = candidates[0];
  if (!selected) return null;
  const increment = Math.max(1, Math.ceil(Math.abs(selected.value) * 0.01));
  return {
    metric: selected.metric,
    beforeValue: selected.value,
    afterValue: selected.value + increment
  };
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
  return { ...item, metrics };
}

function advanceCollectionClock(item) {
  return {
    ...cloneEvidence(item),
    first_seen_at: advanceIsoTimestamp(item.first_seen_at, 1),
    last_checked_at: advanceIsoTimestamp(item.last_checked_at, 1),
    last_updated_at: advanceIsoTimestamp(item.last_updated_at, 1)
  };
}

function compareRankedScores(baselineRows, variantRows) {
  const baseline = new Map(baselineRows.map((row) => [row.company_id, row]));
  const variant = new Map(variantRows.map((row) => [row.company_id, row]));
  const changes = [...baseline.keys()]
    .filter((companyId) => variant.has(companyId))
    .map((companyId) => {
      const before = baseline.get(companyId);
      const after = variant.get(companyId);
      return {
        company_id: companyId,
        company_name: before.company_name,
        score_before: before.score,
        score_after: after.score,
        score_delta: round(after.score - before.score, 4),
        rank_before: before.rank,
        rank_after: after.rank,
        rank_delta: before.rank - after.rank
      };
    });
  const absoluteScoreDeltas = changes.map((change) => Math.abs(change.score_delta));
  const maxRankShift = Math.max(0, ...changes.map((change) => Math.abs(change.rank_delta)));
  const topCount = Math.min(10, baselineRows.length, variantRows.length);
  const baselineTop = new Set(baselineRows.slice(0, topCount).map((row) => row.company_id));
  const variantTop = new Set(variantRows.slice(0, topCount).map((row) => row.company_id));
  const topOverlap = [...baselineTop].filter((companyId) => variantTop.has(companyId)).length;

  return {
    compared_company_count: changes.length,
    baseline_only_company_ids: [...baseline.keys()]
      .filter((companyId) => !variant.has(companyId))
      .sort(compareText),
    variant_only_company_ids: [...variant.keys()]
      .filter((companyId) => !baseline.has(companyId))
      .sort(compareText),
    score_changed_company_count: changes.filter((change) => change.score_delta !== 0).length,
    rank_changed_company_count: changes.filter((change) => change.rank_delta !== 0).length,
    mean_absolute_score_delta: round(mean(absoluteScoreDeltas), 4),
    max_absolute_score_delta: round(Math.max(0, ...absoluteScoreDeltas), 4),
    max_absolute_rank_shift: maxRankShift,
    spearman_rank_correlation: round(spearman(changes), 6),
    top_10_overlap_count: topOverlap,
    top_10_overlap_rate: round(topCount ? topOverlap / topCount : 1, 4),
    company_changes: [...changes].sort((left, right) =>
      compareText(left.company_id, right.company_id)
    ),
    largest_changes: changes
      .filter((change) => change.score_delta !== 0 || change.rank_delta !== 0)
      .sort((left, right) =>
        Math.abs(right.rank_delta) - Math.abs(left.rank_delta) ||
        Math.abs(right.score_delta) - Math.abs(left.score_delta) ||
        compareText(left.company_id, right.company_id)
      )
      .slice(0, 20)
  };
}

function buildGlobalSummary(cohorts, duplicates) {
  const allAliasFindings = cohorts.flatMap(
    (cohort) => cohort.alias_metric_duplication.findings
  );
  const allUrlFindings = cohorts.flatMap((cohort) => cohort.url_quality.findings);
  const allEligibilityRejections = cohorts.flatMap(
    (cohort) => cohort.eligibility_rejections.findings
  );
  const allMissingFindings = cohorts.flatMap((cohort) => cohort.missing_data.findings);
  const allEvidenceOutliers = cohorts.flatMap((cohort) =>
    cohort.outliers.evidence_raw_engagement.by_platform.flatMap((platform) => platform.findings)
  );
  const monotonicFailures = cohorts.flatMap(
    (cohort) => cohort.perturbations.monotonicity.failures
  );
  const publicationDateIssues = new Set([
    "missing_or_invalid_publication_date",
    "publication_date_precision_unknown",
    "publication_date_precision_unrecorded"
  ]);
  const metricIssues = new Set([
    "no_metric_values",
    "no_positive_metric_values",
    "no_positive_scoring_engagement"
  ]);

  return {
    cohort_count: cohorts.length,
    company_count: cohorts.reduce((sum, cohort) => sum + cohort.input_counts.companies, 0),
    cohort_scoped_evidence_rows: cohorts.reduce(
      (sum, cohort) => sum + cohort.input_counts.evidence_rows,
      0
    ),
    global_duplicate_company_id_groups: duplicates.canonical_company_ids.group_count,
    global_duplicate_founder_id_groups: duplicates.canonical_founder_ids.group_count,
    global_duplicate_social_account_url_groups:
      duplicates.canonical_social_account_urls.group_count,
    global_duplicate_evidence_url_groups:
      duplicates.evidence.canonical_source_urls.group_count,
    global_duplicate_evidence_post_key_groups:
      duplicates.evidence.production_canonical_post_keys.group_count,
    alias_metric_finding_count: allAliasFindings.length,
    alias_metric_scored_row_count: new Set(
      allAliasFindings.filter((finding) => finding.scored).map((finding) => finding.audit_key)
    ).size,
    eligibility_rejection_count: allEligibilityRejections.length,
    upstream_enabled_eligibility_rejection_count: allEligibilityRejections.filter(
      (finding) => finding.scored
    ).length,
    scored_profile_search_non_native_row_count: new Set(
      allUrlFindings.filter((finding) => finding.scored).map((finding) => finding.audit_key)
    ).size,
    scored_missing_date_or_metric_row_count: new Set(
      allMissingFindings.filter((finding) => finding.scored).map((finding) => finding.audit_key)
    ).size,
    scored_publication_date_gap_row_count: new Set(
      allMissingFindings
        .filter((finding) => finding.scored && publicationDateIssues.has(finding.issue))
        .map((finding) => finding.audit_key)
    ).size,
    scored_metric_gap_row_count: new Set(
      allMissingFindings
        .filter((finding) => finding.scored && metricIssues.has(finding.issue))
        .map((finding) => finding.audit_key)
    ).size,
    evidence_raw_engagement_outlier_count: allEvidenceOutliers.length,
    company_score_outlier_count_before: cohorts.reduce(
      (sum, cohort) => sum + cohort.outliers.company_scores.before.outlier_count,
      0
    ),
    company_score_outlier_count_after: cohorts.reduce(
      (sum, cohort) => sum + cohort.outliers.company_scores.after.outlier_count,
      0
    ),
    monotonicity_failure_count: monotonicFailures.length,
    cohorts_with_rank_changes_after_cleanup: cohorts.filter(
      (cohort) => cohort.scoring.before_vs_after.rank_changed_company_count > 0
    ).length,
    maximum_after_cleanup_rank_shift: Math.max(
      0,
      ...cohorts.map((cohort) => cohort.scoring.before_vs_after.max_absolute_rank_shift)
    ),
    batch_platform_slices_with_score_changes: cohorts.flatMap(
      (cohort) => cohort.scoring.before_vs_after_by_platform
    ).filter((slice) => slice.before_vs_after.score_changed_company_count > 0).length,
    maximum_batch_platform_rank_shift: Math.max(
      0,
      ...cohorts.flatMap((cohort) =>
        cohort.scoring.before_vs_after_by_platform.map(
          (slice) => slice.before_vs_after.max_absolute_rank_shift
        )
      )
    )
  };
}

function buildInvariantResults(payload) {
  const versionedInputs = payload.metadata.input_hashes.versioned_scoring_inputs;
  const expectedParameters = flattenRuntimeConfig(TRACTION_SCORING_CONFIG).map((parameter) => ({
    ...parameter,
    category: versionedInputCategory(parameter.path),
    sha256: sha256(
      canonicalJson({
        model_id: TRACTION_SCORING_CONFIG.modelId,
        model_version: TRACTION_SCORING_CONFIG.version,
        model_name: TRACTION_SCORING_CONFIG.name,
        parameter_path: parameter.path,
        value: parameter.value
      })
    )
  }));
  const recordedParameters = new Map(
    versionedInputs.parameters.map((parameter) => [parameter.path, parameter])
  );
  const parameterMismatchCount = expectedParameters.filter((expected) => {
    const recorded = recordedParameters.get(expected.path);
    return (
      !recorded ||
      recorded.category !== expected.category ||
      recorded.sha256 !== expected.sha256 ||
      canonicalJson(recorded.value) !== canonicalJson(expected.value)
    );
  }).length + Math.max(0, recordedParameters.size - expectedParameters.length);
  const expectedCategoryHashes = Object.fromEntries(
    ["identity", "scoring", "calibration", "confidence"].map((category) => {
      const categoryParameters = expectedParameters.filter(
        (parameter) => parameter.category === category
      );
      return [
        category,
        {
          parameter_count: categoryParameters.length,
          sha256: sha256(
            categoryParameters
              .map((parameter) => `${parameter.path}\0${parameter.sha256}\n`)
              .join("")
          )
        }
      ];
    })
  );
  const categoryHashMismatchCount = ["identity", "scoring", "calibration", "confidence"]
    .filter(
      (category) =>
        canonicalJson(versionedInputs.parameter_category_hashes[category]) !==
        canonicalJson(expectedCategoryHashes[category])
    ).length;
  const broadFileHashes = new Map(
    payload.metadata.input_hashes.files.map((entry) => [entry.path, entry.sha256])
  );
  const expectedSourceRoles = new Map(
    VERSIONED_INPUT_SOURCE_ROLES.map((descriptor) => [descriptor.role, descriptor.path])
  );
  const sourceEntryMismatchCount = versionedInputs.source_files.filter(
    (source) =>
      expectedSourceRoles.get(source.role) !== source.path ||
      broadFileHashes.get(source.path) !== source.sha256
  ).length + Math.abs(versionedInputs.source_files.length - expectedSourceRoles.size);
  const expectedSourceCombinedSha256 = sha256(
    versionedInputs.source_files
      .map((entry) => `${entry.role}\0${entry.path}\0${entry.sha256}\n`)
      .join("")
  );
  const expectedVersionedCombinedSha256 = sha256(
    canonicalJson({
      model_id: TRACTION_SCORING_CONFIG.modelId,
      model_version: TRACTION_SCORING_CONFIG.version,
      model_name: TRACTION_SCORING_CONFIG.name,
      canonical_config_sha256: sha256(canonicalJson(TRACTION_SCORING_CONFIG)),
      parameter_category_hashes: expectedCategoryHashes,
      source_combined_sha256: expectedSourceCombinedSha256
    })
  );
  const sourceMismatchCount =
    sourceEntryMismatchCount +
    Number(versionedInputs.source_combined_sha256 !== expectedSourceCombinedSha256) +
    Number(versionedInputs.combined_sha256 !== expectedVersionedCombinedSha256);
  const inputEnvelopeHash = sha256(
    payload.metadata.input_hashes.files
      .map((entry) => `${entry.path}\0${entry.sha256}\n`)
      .join("")
  );
  const cohortSlugs = payload.cohorts.map((cohort) => cohort.cohort).sort(compareText);
  const rankingViolationCount = payload.cohorts.reduce((sum, cohort) => {
    const observations = cohort.invariant_observations;
    return (
      sum +
      rankedRowsViolationCount(observations.before_ranks) +
      rankedRowsViolationCount(observations.after_ranks) +
      observations.platform_rank_observations.reduce(
        (platformSum, platform) =>
          platformSum +
          rankedRowsViolationCount(platform.before) +
          rankedRowsViolationCount(platform.after),
        0
      )
    );
  }, 0);
  const cleanupAccountingDelta = payload.cohorts.reduce(
    (sum, cohort) => sum + Math.abs(cohort.invariant_observations.cleanup_row_accounting_delta),
    0
  );
  const afterIneligibleRowCount = payload.cohorts.reduce(
    (sum, cohort) => sum + cohort.invariant_observations.after_ineligible_row_count,
    0
  );
  const retainedIdentityViolationCount = payload.cohorts.reduce(
    (sum, cohort) =>
      sum +
      cohort.invariant_observations.duplicate_retained_audit_key_count +
      cohort.invariant_observations.eligible_company_physical_duplicate_group_count,
    0
  );
  const physicalDedupePolicy = physicalDedupePolicySelfCheck();
  const platformComparisonViolationCount = payload.cohorts.reduce((sum, cohort) => {
    const observations = cohort.invariant_observations;
    return (
      sum +
      Math.abs(
        observations.expected_platform_slice_count - observations.observed_platform_slice_count
      ) +
      observations.missing_platform_slices.length +
      observations.platform_rank_observations.reduce(
        (platformSum, platform) =>
          platformSum +
          platform.baseline_only_company_count +
          platform.variant_only_company_count,
        0
      )
    );
  }, 0);
  const reverseOrderViolationCount = payload.cohorts.reduce((sum, cohort) => {
    const reverse = cohort.perturbations.stability.find(
      (scenario) => scenario.name === "reverse_input_order"
    );
    return (
      sum +
      (reverse?.score_changed_company_count ?? 1) +
      (reverse?.rank_changed_company_count ?? 1) +
      (reverse?.baseline_only_company_ids.length ?? 1) +
      (reverse?.variant_only_company_ids.length ?? 1)
    );
  }, 0);
  const monotonicityFailureCount = payload.cohorts.reduce(
    (sum, cohort) => sum + cohort.perturbations.monotonicity.failures.length,
    0
  );
  const permittedWrites = [
    relativePath(AUDIT_OUTPUT_PATH),
    relativePath(REPORT_OUTPUT_PATH)
  ].sort(compareText);
  const recordedWrites = [...payload.metadata.safety.permitted_writes].sort(compareText);
  const checks = [
    invariantCheck(
      "versioned_runtime_parameter_hashes_complete",
      parameterMismatchCount === 0 &&
        categoryHashMismatchCount === 0 &&
        versionedInputs.parameter_count === expectedParameters.length &&
        versionedInputs.canonical_config_sha256 === sha256(canonicalJson(TRACTION_SCORING_CONFIG)),
      {
        parameter_mismatch_count: 0,
        category_hash_mismatch_count: 0,
        parameter_count: expectedParameters.length
      },
      {
        parameter_mismatch_count: parameterMismatchCount,
        category_hash_mismatch_count: categoryHashMismatchCount,
        parameter_count: versionedInputs.parameter_count
      }
    ),
    invariantCheck(
      "versioned_source_hashes_complete",
      sourceMismatchCount === 0,
      { source_mismatch_count: 0, source_file_count: expectedSourceRoles.size },
      {
        source_mismatch_count: sourceMismatchCount,
        source_file_count: versionedInputs.source_file_count
      }
    ),
    invariantCheck(
      "input_envelope_hash_consistent",
      inputEnvelopeHash === payload.metadata.input_hashes.combined_sha256,
      payload.metadata.input_hashes.combined_sha256,
      inputEnvelopeHash
    ),
    invariantCheck(
      "required_cohort_coverage",
      canonicalJson(cohortSlugs) === canonicalJson([...COHORT_SLUGS].sort(compareText)),
      [...COHORT_SLUGS].sort(compareText),
      cohortSlugs
    ),
    invariantCheck(
      "company_rankings_complete_unique_ordered_and_bounded",
      rankingViolationCount === 0,
      0,
      rankingViolationCount
    ),
    invariantCheck(
      "cleanup_row_accounting_exact",
      cleanupAccountingDelta === 0,
      0,
      cleanupAccountingDelta
    ),
    invariantCheck(
      "retained_rows_production_eligible",
      afterIneligibleRowCount === 0,
      0,
      afterIneligibleRowCount
    ),
    invariantCheck(
      "eligible_company_physical_dedupe_complete",
      retainedIdentityViolationCount === 0,
      0,
      retainedIdentityViolationCount
    ),
    invariantCheck(
      "eligible_physical_dedupe_policy_self_check",
      physicalDedupePolicy.violation_count === 0,
      physicalDedupePolicy.expected,
      physicalDedupePolicy.observed
    ),
    invariantCheck(
      "batch_platform_comparisons_complete",
      platformComparisonViolationCount === 0,
      0,
      platformComparisonViolationCount
    ),
    invariantCheck(
      "reverse_input_order_stable",
      reverseOrderViolationCount === 0,
      0,
      reverseOrderViolationCount
    ),
    invariantCheck(
      "sampled_monotonicity_non_decreasing",
      monotonicityFailureCount === 0,
      0,
      monotonicityFailureCount
    ),
    invariantCheck(
      "artifact_write_allowlist_exact",
      canonicalJson(recordedWrites) === canonicalJson(permittedWrites),
      permittedWrites,
      recordedWrites
    )
  ];

  return {
    policy:
      "Any failed invariant throws before artifact writes and makes the process exit nonzero; dirty-data findings such as rejections, missingness, duplicates, outliers, and concentration are diagnostic rather than invariant failures.",
    check_count: checks.length,
    passed_count: checks.filter((check) => check.passed).length,
    violation_count: checks.filter((check) => !check.passed).length,
    all_passed: checks.every((check) => check.passed),
    checks
  };
}

function physicalDedupePolicySelfCheck() {
  const eligibleRows = [
    physicalDedupeFixtureRow("fixture-a", "fixture-audit-a", 10),
    physicalDedupeFixtureRow("fixture-b", "fixture-audit-b", 20)
  ];
  const singleOwnerContext = {
    entityOwners: new Map([["fixture-entity", new Set(["fixture-company"])]]),
    slug: "FIXTURE"
  };
  const ambiguousOwnerContext = {
    entityOwners: new Map([
      ["fixture-entity", new Set(["fixture-company-a", "fixture-company-b"])]
    ]),
    slug: "FIXTURE"
  };
  const eligibleResult = dedupeSameOwner(
    singleOwnerContext,
    eligibleRows,
    (item) => canonicalPostKey(item),
    "fixture_duplicate",
    (rows) => dedupeEvidenceForScoring(rows)[0]
  );
  const mixedEligibilityResult = dedupeSameOwner(
    singleOwnerContext,
    [eligibleRows[0], { ...eligibleRows[1], contributionScore: 0 }],
    (item) => canonicalPostKey(item),
    "fixture_duplicate",
    (rows) => dedupeEvidenceForScoring(rows)[0]
  );
  const ambiguousOwnerResult = dedupeSameOwner(
    ambiguousOwnerContext,
    eligibleRows,
    (item) => canonicalPostKey(item),
    "fixture_duplicate",
    (rows) => dedupeEvidenceForScoring(rows)[0]
  );
  const expected = {
    eligible_retained_rows: 1,
    eligible_removed_rows: 1,
    mixed_eligibility_retained_rows: 2,
    mixed_eligibility_removed_rows: 0,
    ambiguous_owner_retained_rows: 2,
    ambiguous_owner_removed_rows: 0
  };
  const observed = {
    eligible_retained_rows: eligibleResult.retained.length,
    eligible_removed_rows: eligibleResult.removed.length,
    mixed_eligibility_retained_rows: mixedEligibilityResult.retained.length,
    mixed_eligibility_removed_rows: mixedEligibilityResult.removed.length,
    ambiguous_owner_retained_rows: ambiguousOwnerResult.retained.length,
    ambiguous_owner_removed_rows: ambiguousOwnerResult.removed.length
  };

  return {
    expected,
    observed,
    violation_count: Object.keys(expected).filter(
      (key) => expected[key] !== observed[key]
    ).length
  };
}

function physicalDedupeFixtureRow(id, auditKey, likes) {
  return {
    id,
    __auditKey: auditKey,
    entityId: "fixture-entity",
    platform: "x",
    sourceUrl: "https://x.com/returner/status/999999999999999999",
    platformPostId: "999999999999999999",
    metrics: { likes },
    contributionScore: 1,
    linkStatus: "verified",
    review_state: "verified",
    postedAt: "2026-07-01T00:00:00.000Z",
    publishedAtPrecision: "exact",
    metricsCheckedAt: "2026-07-16T00:00:00.000Z"
  };
}

function rankedRowsViolationCount(observation) {
  return (
    Math.abs(observation.row_count - observation.expected_row_count) +
    observation.duplicate_company_id_count +
    observation.missing_company_ids.length +
    observation.unexpected_company_ids.length +
    observation.invalid_rank_count +
    observation.order_mismatch_count +
    observation.non_finite_score_count +
    observation.out_of_bounds_score_count
  );
}

function invariantCheck(id, passed, expected, observed) {
  return { id, passed, expected, observed };
}

function renderMarkdownReport(payload, auditSha256) {
  const lines = [
    "# Scoring Diagnostics v4 Audit",
    "",
    `- Frozen clock: \`${payload.metadata.frozen_clock}\``,
    `- Production model: \`${payload.metadata.production_model_name}\` (\`${payload.metadata.production_model_id}\` v${payload.metadata.production_model_version})`,
    "- Git SHA: excluded from deterministic artifacts; the runtime command logs the executing revision.",
    `- Input envelope SHA-256: \`${payload.metadata.input_hashes.combined_sha256}\``,
    `- Effective versioned scoring-input SHA-256: \`${payload.metadata.input_hashes.versioned_scoring_inputs.combined_sha256}\``,
    `- Canonical config: ${payload.metadata.input_hashes.versioned_scoring_inputs.parameter_count} leaf parameters across scoring, calibration, and confidence; ${payload.metadata.input_hashes.versioned_scoring_inputs.source_file_count} role-labeled runtime source files.`,
    `- Audit JSON SHA-256: \`${auditSha256}\``,
    `- Command: \`${payload.metadata.command}\``,
    `- Direct command: \`${payload.metadata.direct_command}\``,
    "- Safety: local snapshots only; `fetch` disabled; no API calls, benchmark writes, source edits, or user-data mutation.",
    `- Compatibility shims: ${payload.metadata.compatibility_shims.length ? payload.metadata.compatibility_shims.map((shim) => shim.id).join(", ") : "none"}.`,
    "",
    "## Executive summary",
    "",
    `- ${payload.global_summary.company_count} companies across ${payload.global_summary.cohort_count} cohorts were inspected with ${payload.global_summary.cohort_scoped_evidence_rows} cohort-scoped evidence rows.`,
    `- Global canonical duplicates: ${payload.global_summary.global_duplicate_company_id_groups} company-ID groups, ${payload.global_summary.global_duplicate_founder_id_groups} founder-ID groups, ${payload.global_summary.global_duplicate_social_account_url_groups} social-account URL groups, ${payload.global_summary.global_duplicate_evidence_post_key_groups} physical-post groups, and ${payload.global_summary.global_duplicate_evidence_url_groups} evidence URL groups.`,
    `- Alias diagnostics found ${payload.global_summary.alias_metric_finding_count} overlaps across ${payload.global_summary.alias_metric_scored_row_count} scored rows.`,
    `- Production eligibility rejected ${payload.global_summary.eligibility_rejection_count} rows, including ${payload.global_summary.upstream_enabled_eligibility_rejection_count} rows whose incoming contribution flag was positive.`,
    `- URL diagnostics found ${payload.global_summary.scored_profile_search_non_native_row_count} scored profile/search/non-native rows. Publication-date metadata gaps affect ${payload.global_summary.scored_publication_date_gap_row_count} scored rows; metric gaps affect ${payload.global_summary.scored_metric_gap_row_count}.`,
    `- Robust fences flagged ${payload.global_summary.evidence_raw_engagement_outlier_count} eligible evidence rows and ${payload.global_summary.company_score_outlier_count_before}/${payload.global_summary.company_score_outlier_count_after} company scores before/after.`,
    `- Monotonicity produced ${payload.global_summary.monotonicity_failure_count} failing company tests. Cleanup changed ranks in ${payload.global_summary.cohorts_with_rank_changes_after_cleanup}/${payload.global_summary.cohort_count} cohorts and scores in ${payload.global_summary.batch_platform_slices_with_score_changes}/${payload.global_summary.cohort_count * WEIGHTED_PLATFORMS.length} batch/platform slices; maximum overall/platform rank shifts were ${payload.global_summary.maximum_after_cleanup_rank_shift}/${payload.global_summary.maximum_batch_platform_rank_shift}.`,
    `- Invariants: ${payload.invariants.passed_count}/${payload.invariants.check_count} passed. Any violation exits nonzero before artifact writes.`,
    "",
    "The after view is a diagnostic simulation only. It does not update the production model, graph, benchmarks, snapshots, or stored scores.",
    "",
    "## Cohort before/after",
    "",
    "| Cohort | Companies | Evidence before | Evidence after | Published mean | Diagnostic before mean | Diagnostic after mean | Rank changes | Max shift |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];

  for (const cohort of payload.cohorts) {
    lines.push(
      `| ${cohort.cohort} | ${cohort.input_counts.companies} | ${cohort.scoring.after_transformation.before_evidence_rows} | ${cohort.scoring.after_transformation.after_evidence_rows} | ${cohort.scoring.published_reference.score_distribution.mean} | ${cohort.scoring.diagnostic_before.score_distribution.mean} | ${cohort.scoring.diagnostic_after.score_distribution.mean} | ${cohort.scoring.before_vs_after.rank_changed_company_count} | ${cohort.scoring.before_vs_after.max_absolute_rank_shift} |`
    );
  }

  lines.push(
    "",
    "## Diagnostic counts",
    "",
    "| Cohort | Post duplicate groups | URL duplicate groups | Eligibility rejects | Enabled rejects | Physical rows removed | Alias rows | URL findings | Publication gaps | Metric gaps | Evidence outliers | Company outliers B/A |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const cohort of payload.cohorts) {
    const publicationGaps =
      countValue(cohort.missing_data.by_issue, "missing_or_invalid_publication_date") +
      countValue(cohort.missing_data.by_issue, "publication_date_precision_unknown") +
      countValue(cohort.missing_data.by_issue, "publication_date_precision_unrecorded");
    const metricGaps = new Set(
      cohort.missing_data.findings
        .filter((finding) =>
          [
            "no_metric_values",
            "no_positive_metric_values",
            "no_positive_scoring_engagement"
          ].includes(finding.issue)
        )
        .map((finding) => finding.audit_key)
    ).size;
    lines.push(
      `| ${cohort.cohort} | ${cohort.canonical_duplicates.production_canonical_post_keys.group_count} | ${cohort.canonical_duplicates.canonical_source_urls.group_count} | ${cohort.eligibility_rejections.rejected_row_count} | ${cohort.eligibility_rejections.rejected_upstream_enabled_row_count} | ${cohort.scoring.after_transformation.eligible_physical_dedupe.removed_row_count} | ${cohort.alias_metric_duplication.row_count} | ${cohort.url_quality.finding_count} | ${publicationGaps} | ${metricGaps} | ${cohort.outliers.evidence_raw_engagement.outlier_count} | ${cohort.outliers.company_scores.before.outlier_count}/${cohort.outliers.company_scores.after.outlier_count} |`
    );
  }

  lines.push(
    "",
    "## Batch/platform score and rank shifts",
    "",
    "| Cohort | Platform | Evidence B/A | Nonzero companies B/A | Mean score B/A | Score changes | Rank changes | Max score delta | Max rank shift |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const cohort of payload.cohorts) {
    for (const slice of cohort.scoring.before_vs_after_by_platform) {
      lines.push(
        `| ${cohort.cohort} | ${slice.platform} | ${slice.evidence_rows_before}/${slice.evidence_rows_after} | ${slice.score_before.nonzero_company_count}/${slice.score_after.nonzero_company_count} | ${slice.score_before.score_distribution.mean}/${slice.score_after.score_distribution.mean} | ${slice.before_vs_after.score_changed_company_count} | ${slice.before_vs_after.rank_changed_company_count} | ${slice.before_vs_after.max_absolute_score_delta} | ${slice.before_vs_after.max_absolute_rank_shift} |`
      );
    }
  }

  lines.push(
    "",
    "## Platform concentration",
    "",
    "| Cohort | Leading platform B/A | Leading share B/A | HHI B/A | Single-platform companies B/A | Median dominant share B/A |",
    "| --- | --- | ---: | ---: | ---: | ---: |"
  );
  for (const cohort of payload.cohorts) {
    const beforeConcentration = cohort.platform_concentration.before;
    const afterConcentration = cohort.platform_concentration.after;
    const beforeLeading = beforeConcentration.aggregate_score_contribution_by_platform[0] ?? {
      key: "none",
      share: 0
    };
    const afterLeading = afterConcentration.aggregate_score_contribution_by_platform[0] ?? {
      key: "none",
      share: 0
    };
    lines.push(
      `| ${cohort.cohort} | ${beforeLeading.key}/${afterLeading.key} | ${formatPercent(beforeLeading.share)}/${formatPercent(afterLeading.share)} | ${beforeConcentration.contribution_hhi}/${afterConcentration.contribution_hhi} | ${formatPercent(beforeConcentration.single_platform_company_share)}/${formatPercent(afterConcentration.single_platform_company_share)} | ${formatPercent(beforeConcentration.median_dominant_platform_share)}/${formatPercent(afterConcentration.median_dominant_platform_share)} |`
    );
  }

  lines.push(
    "",
    "## Evidence outliers by platform",
    "",
    "| Cohort | Platform | Eligible sample | Outliers | Raw engagement Q1/Q3 | Lower/upper fence |",
    "| --- | --- | ---: | ---: | ---: | ---: |"
  );
  for (const cohort of payload.cohorts) {
    for (const profile of cohort.outliers.evidence_raw_engagement.by_platform) {
      lines.push(
        `| ${cohort.cohort} | ${profile.platform} | ${profile.sample_count} | ${profile.outlier_count} | ${profile.q1 ?? "n/a"}/${profile.q3 ?? "n/a"} | ${profile.lower_fence ?? "n/a"}/${profile.upper_fence ?? "n/a"} |`
      );
    }
  }

  lines.push(
    "",
    "## Perturbation checks",
    "",
    "| Cohort | Monotonic tests | Company decreases | Reverse-order rank changes | +1% max rank shift | +24h max rank shift |",
    "| --- | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const cohort of payload.cohorts) {
    const stability = Object.fromEntries(
      cohort.perturbations.stability.map((scenario) => [scenario.name, scenario])
    );
    lines.push(
      `| ${cohort.cohort} | ${cohort.perturbations.monotonicity.company_tests} | ${cohort.perturbations.monotonicity.company_score_decrease_count} | ${stability.reverse_input_order.rank_changed_company_count} | ${stability.configured_metrics_plus_1_percent.max_absolute_rank_shift} | ${stability.collection_timestamps_plus_24_hours.max_absolute_rank_shift} |`
    );
  }

  lines.push("", "## Largest cleanup rank changes", "");
  for (const cohort of payload.cohorts) {
    lines.push(`### ${cohort.cohort}`, "");
    const changes = cohort.scoring.before_vs_after.largest_changes.slice(0, 8);
    if (!changes.length) {
      lines.push("No score or rank changes.", "");
      continue;
    }
    lines.push(
      "| Company | Score before | Score after | Delta | Rank before | Rank after |",
      "| --- | ---: | ---: | ---: | ---: | ---: |"
    );
    for (const change of changes) {
      lines.push(
        `| ${escapeMarkdown(change.company_name)} | ${change.score_before} | ${change.score_after} | ${signed(change.score_delta)} | ${change.rank_before} | ${change.rank_after} |`
      );
    }
    lines.push("");
  }

  lines.push(
    "## Invariants",
    "",
    "| Invariant | Passed | Observed |",
    "| --- | --- | --- |"
  );
  for (const check of payload.invariants.checks) {
    lines.push(
      `| ${check.id} | ${check.passed ? "yes" : "no"} | ${escapeMarkdown(canonicalJson(check.observed))} |`
    );
  }

  lines.push(
    "",
    "## Interpretation notes",
    "",
    "- GitHub `watchers_count` is stored as `watchers` by the local collector and commonly equals stars. v4 flags equal positive star/watcher pairs; the diagnostic after view canonicalizes metrics with the production normalizer.",
    "- URL findings distinguish platform profiles, search/result pages, and URLs rejected by the production native-evidence check. Zero-score context rows are still counted in diagnostics but do not create a score delta.",
    "- Eligibility rejections use the exported production `scoringEligibility` predicate. The after view removes rejected rows but retains publication-date gaps that production handles with conservative momentum.",
    "- Physical-post duplicates use the production `canonicalPostKey` and `dedupeEvidenceForScoring` comparator only when every retained candidate is eligible and maps to one unambiguous company owner. Ambiguous ownership is reported and never silently collapsed.",
    "- Evidence outliers use Tukey 1.5 IQR fences over `log1p` production-weighted raw engagement; company score outliers use direct 0-100 scores. These are inventory flags, not invariant failures or automatic exclusions.",
    "- Monotonicity uses a deterministic raw-engagement-stratified sample capped at 40 scored rows per platform; exact eligible, sampled, and coverage counts are recorded per cohort in the JSON audit.",
    "- Published scores can include cohort calibration in dataset builders. The before/after comparison therefore uses a fresh exported-scorer baseline on both sides; published ranks remain a separate reference.",
    "- The JSON audit includes every config leaf hash, role-labeled effective source hashes, full company changes for overall and batch/platform comparisons, row-level findings, transformations, and invariant observations.",
    "- The full machine-readable artifact is `docs/outputs/scoring-diagnostics-v4-audit.json`.",
    "",
    "The profiler writes only the two allowlisted files under `docs/outputs/` and performs no network or mutable API calls.",
    ""
  );

  return lines.join("\n");
}

async function buildInputHashManifest() {
  const roots = [
    path.join(REPOSITORY_ROOT, "src", "lib", "graph"),
    path.join(REPOSITORY_ROOT, "src", "lib", "scoring"),
    path.join(REPOSITORY_ROOT, "src", "lib", "social"),
    path.join(REPOSITORY_ROOT, "src", "lib", "yc")
  ];
  const explicitFiles = [
    path.join(REPOSITORY_ROOT, "package.json"),
    path.join(REPOSITORY_ROOT, "tsconfig.json"),
    path.join(REPOSITORY_ROOT, "scripts", "prepare-graph-runtime-evidence.mjs"),
    path.join(REPOSITORY_ROOT, "scripts", "run-scoring-diagnostics-v4.mjs"),
    path.join(REPOSITORY_ROOT, "scripts", "lib", "scoring-diagnostics-ts-loader.mjs")
  ];
  const discovered = [];
  for (const root of roots) {
    discovered.push(...(await listFilesRecursively(root)));
  }
  const files = sortedUnique([...discovered, ...explicitFiles]).filter((filePath) =>
    /\.(json|mjs|ts|tsx)$/.test(filePath) || path.basename(filePath) === "package.json"
  );
  const entries = [];
  for (const filePath of files) {
    const content = await readFile(filePath);
    entries.push({
      path: relativePath(filePath),
      bytes: content.byteLength,
      sha256: sha256(content)
    });
  }
  entries.sort((left, right) => compareText(left.path, right.path));
  const combined = entries.map((entry) => `${entry.path}\0${entry.sha256}\n`).join("");
  const versionedScoringInputs = await buildVersionedScoringInputManifest();

  return {
    scope:
      "graph, scoring, social, and YC local input envelope plus profiler runtime files; canonical runtime values and effective scoring/calibration/confidence sources are hashed separately",
    file_count: entries.length,
    combined_sha256: sha256(combined),
    files: entries,
    versioned_scoring_inputs: versionedScoringInputs
  };
}

async function buildVersionedScoringInputManifest() {
  const identity = {
    model_id: TRACTION_SCORING_CONFIG.modelId,
    model_version: TRACTION_SCORING_CONFIG.version,
    model_name: TRACTION_SCORING_CONFIG.name
  };
  const parameters = flattenRuntimeConfig(TRACTION_SCORING_CONFIG).map((parameter) => ({
    ...parameter,
    category: versionedInputCategory(parameter.path),
    sha256: sha256(
      canonicalJson({
        ...identity,
        parameter_path: parameter.path,
        value: parameter.value
      })
    )
  }));
  const categoryHashes = Object.fromEntries(
    ["identity", "scoring", "calibration", "confidence"].map((category) => {
      const categoryParameters = parameters.filter((parameter) => parameter.category === category);
      return [
        category,
        {
          parameter_count: categoryParameters.length,
          sha256: sha256(
            categoryParameters
              .map((parameter) => `${parameter.path}\0${parameter.sha256}\n`)
              .join("")
          )
        }
      ];
    })
  );
  const sourceFiles = [];
  for (const descriptor of VERSIONED_INPUT_SOURCE_ROLES) {
    const filePath = path.join(REPOSITORY_ROOT, descriptor.path);
    const content = await readFile(filePath);
    sourceFiles.push({
      ...descriptor,
      bytes: content.byteLength,
      sha256: sha256(content)
    });
  }
  sourceFiles.sort(
    (left, right) => compareText(left.role, right.role) || compareText(left.path, right.path)
  );
  const canonicalConfigSha256 = sha256(canonicalJson(TRACTION_SCORING_CONFIG));
  const sourceCombinedSha256 = sha256(
    sourceFiles
      .map((entry) => `${entry.role}\0${entry.path}\0${entry.sha256}\n`)
      .join("")
  );

  return {
    ...identity,
    canonical_config_sha256: canonicalConfigSha256,
    parameter_count: parameters.length,
    parameter_category_hashes: categoryHashes,
    parameters,
    source_file_count: sourceFiles.length,
    source_combined_sha256: sourceCombinedSha256,
    source_files: sourceFiles,
    combined_sha256: sha256(
      canonicalJson({
        ...identity,
        canonical_config_sha256: canonicalConfigSha256,
        parameter_category_hashes: categoryHashes,
        source_combined_sha256: sourceCombinedSha256
      })
    )
  };
}

function flattenRuntimeConfig(value, prefix = "") {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenRuntimeConfig(item, `${prefix}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort(compareText)
      .flatMap((key) =>
        flattenRuntimeConfig(value[key], prefix ? `${prefix}.${key}` : key)
      );
  }
  return [{ path: prefix, value }];
}

function versionedInputCategory(parameterPath) {
  if (parameterPath.startsWith("batchCalibration.")) return "calibration";
  if (parameterPath.startsWith("confidence.")) return "confidence";
  if (["modelId", "version", "name"].includes(parameterPath)) return "identity";
  return "scoring";
}

async function detectCompatibilityShims() {
  const filePath = path.join(
    REPOSITORY_ROOT,
    "src",
    "lib",
    "graph",
    "a16z-speedrun-006-dataset.ts"
  );
  const source = await readFile(filePath, "utf8");
  const callsRound = /\bround\s*\(/.test(source);
  const definesRound = /(?:function|const|let|var)\s+round\b/.test(source);
  return callsRound && !definesRound
    ? [
        {
          id: "a16z_dataset_missing_round_helper",
          file: relativePath(filePath),
          behavior:
            "Loader supplies a local decimal formatter so the current dataset module can evaluate; production scoring modules are not transformed."
        }
      ]
    : [];
}

async function listFilesRecursively(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function entityCohortMemberships(dataset) {
  const memberships = new Map();
  for (const entity of [...dataset.companies, ...dataset.founders]) {
    memberships.set(
      entity.id,
      new Set([...(memberships.get(entity.id) ?? []), entity.batchSlug])
    );
  }
  return memberships;
}

function evidenceReference(item, context) {
  const owners = context
    ? sortedUnique([...(context.entityOwners.get(item.entityId) ?? [])])
    : [];
  return {
    audit_key: item.__auditKey ?? item.id,
    evidence_id: item.id,
    entity_id: item.entityId,
    owner_company_ids: owners,
    cohort_memberships: sortedUnique([...(cohortMemberships.get(item.entityId) ?? [])]),
    platform: item.platform,
    platform_post_id: item.platformPostId ?? null,
    source_url: item.sourceUrl,
    canonical_source_url: canonicalEvidenceUrl(item.sourceUrl) || null,
    posted_at: item.postedAt ?? null,
    published_at_precision: item.publishedAtPrecision ?? null,
    metrics_checked_at: item.metricsCheckedAt ?? null,
    metrics: compactMetrics(item.metrics),
    contribution_score: item.contributionScore,
    scored: isScoredEvidence(item)
  };
}

function compactMetrics(metrics) {
  return Object.fromEntries(
    Object.entries(metrics ?? {})
      .filter(([, value]) => value !== undefined && value !== null)
      .sort(([left], [right]) => compareText(left, right))
  );
}

function rankRows(rows) {
  return [...rows]
    .sort((left, right) =>
      right.score - left.score ||
      compareText(left.company_name, right.company_name) ||
      compareText(left.company_id, right.company_id)
    )
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function mapCountsWithShare(counts) {
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  return [...counts.entries()]
    .map(([key, count]) => ({
      key,
      count,
      share: round(total ? count / total : 0, 4)
    }))
    .sort((left, right) => right.count - left.count || compareText(left.key, right.key));
}

function mapValuesWithShare(values) {
  const total = [...values.values()].reduce((sum, value) => sum + value, 0);
  return [...values.entries()]
    .map(([key, value]) => ({
      key,
      value: round(value, 4),
      share: round(total ? value / total : 0, 4)
    }))
    .sort((left, right) => right.value - left.value || compareText(left.key, right.key));
}

function concentrationHhi(values) {
  const total = [...values.values()].reduce((sum, value) => sum + value, 0);
  if (!total) return 0;
  return round(
    [...values.values()].reduce((sum, value) => sum + (value / total) ** 2, 0),
    4
  );
}

function countBy(items, keyFunction) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFunction(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || compareText(String(left.key), String(right.key)));
}

function countValue(counts, key) {
  return counts.find((entry) => entry.key === key)?.count ?? 0;
}

function groupBy(items, keyFunction) {
  const grouped = new Map();
  for (const item of items) {
    const key = keyFunction(item);
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return grouped;
}

function compareDuplicateGroups(left, right) {
  return right.row_count - left.row_count || compareText(String(left.key), String(right.key));
}

function compareEvidenceReferences(left, right) {
  return compareText(left.audit_key, right.audit_key);
}

function compareText(left, right) {
  const leftText = String(left ?? "");
  const rightText = String(right ?? "");
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function canonicalIdentifier(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizedHost(hostname) {
  return hostname
    .toLowerCase()
    .replace(/^(?:www\.|m\.|mobile\.)/, "");
}

function isScoredEvidence(item) {
  return Number(item.contributionScore) > 0;
}

function cloneEvidence(item) {
  return { ...item, metrics: { ...(item.metrics ?? {}) } };
}

function evidenceFreshness(item) {
  return Math.max(
    0,
    ...[item.last_checked_at, item.last_updated_at, item.first_seen_at, item.postedAt]
      .map((value) => Date.parse(value ?? ""))
      .filter(Number.isFinite)
  );
}

function advanceIsoTimestamp(value, days) {
  if (!value) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed + days * 86_400_000).toISOString() : value;
}

function spearman(changes) {
  const count = changes.length;
  if (count < 2) return 1;
  const squaredDifferences = changes.reduce(
    (sum, change) => sum + (change.rank_before - change.rank_after) ** 2,
    0
  );
  return 1 - (6 * squaredDifferences) / (count * (count ** 2 - 1));
}

function summarizeNumbers(values) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  return {
    min: finite.length ? finite[0] : 0,
    p25: round(percentile(finite, 0.25), 4),
    median: round(percentile(finite, 0.5), 4),
    mean: round(mean(finite), 4),
    p75: round(percentile(finite, 0.75), 4),
    max: finite.length ? finite[finite.length - 1] : 0
  };
}

function percentile(sortedValues, quantile) {
  if (!sortedValues.length) return 0;
  const position = (sortedValues.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (position - lower);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values) {
  return percentile([...values].filter(Number.isFinite).sort((left, right) => left - right), 0.5);
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareText);
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

function relativePath(filePath) {
  return path.relative(REPOSITORY_ROOT, filePath).split(path.sep).join("/");
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

async function writeArtifact(filePath, content) {
  const resolved = path.resolve(filePath);
  const allowed = new Set([path.resolve(AUDIT_WRITE_PATH), path.resolve(REPORT_WRITE_PATH)]);
  if (!allowed.has(resolved)) {
    throw new Error(`Refusing write outside the v4 artifact allowlist: ${filePath}`);
  }
  await writeFile(resolved, content, "utf8");
}

function resolveOutputPath(argumentName, fallbackPath) {
  const configuredPath = argumentValue(argumentName);
  if (configuredPath === undefined) return fallbackPath;
  if (!configuredPath.trim()) {
    throw new Error(`${argumentName} requires a non-empty path.`);
  }
  return path.resolve(REPOSITORY_ROOT, configuredPath);
}

function assertExpectedInputHash(inputHashes) {
  if (!EXPECTED_INPUT_SHA256) return;
  if (EXPECTED_INPUT_SHA256 !== inputHashes.combined_sha256) {
    throw new Error(
      `Scoring diagnostics invariant violation: expected_input_envelope_sha256 (expected ${EXPECTED_INPUT_SHA256}, observed ${inputHashes.combined_sha256})`
    );
  }
}

function validateAudit(payload) {
  if (
    payload.metadata.production_model_id !== TRACTION_SCORING_CONFIG.modelId ||
    payload.metadata.production_model_version !== TRACTION_SCORING_CONFIG.version ||
    payload.metadata.production_model_name !== TRACTION_SCORING_CONFIG.name
  ) {
    throw new Error("Production scoring model version was not recorded correctly.");
  }
  if (payload.cohorts.length !== COHORT_SLUGS.length) {
    throw new Error("Not all required cohorts were audited.");
  }
  for (const cohort of payload.cohorts) {
    if (!COHORT_SLUGS.includes(cohort.cohort)) {
      throw new Error(`Unexpected cohort in audit: ${cohort.cohort}`);
    }
    for (const section of [
      cohort.scoring.published_reference,
      cohort.scoring.diagnostic_before,
      cohort.scoring.diagnostic_after
    ]) {
      for (const value of Object.values(section.score_distribution)) {
        if (!Number.isFinite(value)) {
          throw new Error(`Non-finite score statistic in ${cohort.cohort}.`);
        }
      }
    }
  }
  const violations = payload.invariants?.checks?.filter((check) => !check.passed) ?? [
    { id: "invariant_results_missing" }
  ];
  if (violations.length) {
    const monotonicityFailures = payload.cohorts
      .flatMap((cohort) =>
        cohort.perturbations.monotonicity.failures.map((failure) => ({
          cohort: cohort.cohort,
          ...failure
        }))
      )
      .slice(0, 5);
    const diagnosticSuffix = monotonicityFailures.length
      ? `; monotonicity examples: ${JSON.stringify(monotonicityFailures)}`
      : "";
    throw new Error(
      `Scoring diagnostics invariant violation${violations.length === 1 ? "" : "s"}: ${violations
        .map((violation) => violation.id)
        .join(", ")}${diagnosticSuffix}`
    );
  }
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
