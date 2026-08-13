import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { basename, dirname, join, resolve, sep } from "node:path";

import { loadAutonomousCatalogs } from "./autonomous-ingestion-plan.mjs";
import { normalizeAutonomousIngestionCatalogs } from "./ingestion-coverage-adapter.mjs";
import {
  INGESTION_CORE_PLATFORMS,
  INGESTION_EXTENDED_ONLY_PLATFORMS
} from "./ingestion-coverage-receipt.mjs";
import {
  GRAPH_ARTIFACTS,
  HISTORY_ARTIFACTS,
  validatePublicArtifacts
} from "../validate-public-artifacts.mjs";

export const PAIR_INTEGRITY_PROOF_BRIDGE_VERSION = "pair-integrity-proof-bridge.v1";
export const PAIR_INTEGRITY_EXPECTED_PAIR_COUNT = 16_705;
export const PAIR_INTEGRITY_MAX_INPUT_BYTES = 512 * 1024 * 1024;

const STORED_COVERAGE_VERSION = "stored-unpublished-coverage-bridge.v1";
const DIMENSIONS = Object.freeze(["duplicates", "attribution", "timestamps", "scoring"]);
const ALL_PLATFORMS = Object.freeze([
  ...INGESTION_CORE_PLATFORMS,
  ...INGESTION_EXTENDED_ONLY_PLATFORMS
]);
const WEIGHTED_SCORING_PLATFORMS = Object.freeze([
  "bilibili",
  "github",
  "hacker_news",
  "instagram",
  "linkedin",
  "product_hunt",
  "reddit",
  "x",
  "youtube"
]);
const ATTRIBUTION_REJECTION_REASONS = new Set(["not_verified"]);
const TIMESTAMP_FINDINGS = new Set([
  "missing_or_invalid_publication_date",
  "publication_date_precision_unknown",
  "publication_date_precision_unrecorded"
]);
const GITHUB_EVIDENCE_CATEGORIES = new Set([
  "github_exhaustive_content_stored_unpublished",
  "github_exhaustive_repository_stored_or_shared_review"
]);
const GITHUB_BLOCKER_CATEGORY = "github_exhaustive_target_terminal_blocker";
const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256 = /^[a-f0-9]{64}$/;

const DEFAULT_DEPENDENCY_PATHS = Object.freeze({
  duplicates: Object.freeze([
    "src/lib/graph/dedupe.ts",
    "scripts/lib/source-content-identity.mjs",
    "scripts/lib/historical-publication-staging.mjs",
    "scripts/lib/github-exhaustive-integration.mjs",
    "scripts/run-scoring-diagnostics-v4.mjs"
  ]),
  attribution: Object.freeze([
    "src/lib/graph/evidence-attribution.ts",
    "scripts/lib/public-evidence-attribution.mjs",
    "scripts/lib/historical-publication-staging.mjs",
    "scripts/lib/github-exhaustive-integration.mjs",
    "scripts/run-scoring-diagnostics-v4.mjs"
  ]),
  timestamps: Object.freeze([
    "src/lib/graph/native-publication-date.ts",
    "scripts/lib/historical-coverage-adapter.mjs",
    "scripts/lib/github-exhaustive-integration.mjs",
    "scripts/validate-public-artifacts.mjs",
    "scripts/run-scoring-diagnostics-v4.mjs"
  ]),
  scoring: Object.freeze([
    "src/lib/scoring/traction-config.ts",
    "src/lib/graph/traction-scoring.ts",
    "src/lib/graph/dedupe.ts",
    "scripts/run-scoring-diagnostics-v4.mjs",
    "scripts/validate-public-artifacts.mjs"
  ])
});

/**
 * Merge exact four-dimensional integrity receipts into an immutable copy of a
 * stored-unpublished pair-scopes artifact. No canonical or scoring-visible
 * artifact is written.
 */
export async function buildPairIntegrityProofBridge({
  root = process.cwd(),
  storedCoverageManifestPath,
  scoringAuditPath,
  outputDir = null,
  generatedAt,
  dryRun = false,
  expectedPairCount = PAIR_INTEGRITY_EXPECTED_PAIR_COUNT,
  maxInputBytes = PAIR_INTEGRITY_MAX_INPUT_BYTES,
  catalogs: suppliedCatalogs = null,
  dependencyPaths = DEFAULT_DEPENDENCY_PATHS,
  productionArtifactPaths = null,
  productionValidator = validatePublicArtifacts
} = {}) {
  const checkedAt = canonicalTimestamp(generatedAt, "generatedAt");
  positiveInteger(expectedPairCount, "expectedPairCount");
  positiveInteger(maxInputBytes, "maxInputBytes");
  const rootPath = await realpath(resolve(root));
  const storedManifestRealPath = await realpath(resolveFromRoot(
    rootPath,
    requiredText(storedCoverageManifestPath, "storedCoverageManifestPath")
  ));
  const scoringAuditRealPath = await realpath(resolveFromRoot(
    rootPath,
    requiredText(scoringAuditPath, "scoringAuditPath")
  ));
  const outputPath = outputDir ? resolveFromRoot(rootPath, outputDir) : null;
  if (!dryRun && !outputPath) throw new Error("outputDir is required unless dryRun=true.");
  if (outputPath) await assertPathDoesNotExist(outputPath, "outputDir");

  const catalogs = normalizeAutonomousIngestionCatalogs(
    suppliedCatalogs ?? await loadAutonomousCatalogs(rootPath)
  );
  const matrix = buildCanonicalMatrix(catalogs);
  if (matrix.pairs.size !== expectedPairCount) {
    throw new Error(`Canonical pair denominator is ${matrix.pairs.size}; expected ${expectedPairCount}.`);
  }

  const storedManifestFile = await readBoundedJson(
    storedManifestRealPath,
    maxInputBytes,
    "stored-unpublished coverage manifest"
  );
  const storedManifest = validateStoredCoverageManifest(
    storedManifestFile.value,
    checkedAt,
    expectedPairCount
  );
  const storedPairScopesPath = await resolveDeclaredSibling(
    storedManifestRealPath,
    storedManifest.artifacts.pairScopes.path,
    "stored pair-scopes artifact"
  );
  const storedPairScopesFile = await readBoundedJson(
    storedPairScopesPath,
    maxInputBytes,
    "stored pair-scopes artifact"
  );
  validateFileDescriptor(
    storedPairScopesFile.bytes,
    storedManifest.artifacts.pairScopes,
    "stored pair-scopes artifact"
  );
  const storedRows = validateStoredPairScopes(
    storedPairScopesFile.value,
    matrix.pairs,
    storedManifest,
    expectedPairCount
  );

  const states = new Map([...matrix.pairs].map(([pairKey, identity]) => [pairKey, {
    ...identity,
    findings: Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, []])),
    evaluated: { duplicates: true, attribution: true, timestamps: true, scoring: false },
    observedRows: { historical: 0, github: 0, scoring: 0 }
  }]));
  const globalFindings = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, []]));

  const pinnedSources = await validateStoredSourcePins({
    rootPath,
    storedManifest,
    maxInputBytes
  });
  const historicalAudit = await auditHistoricalStoredLedger({
    path: pinnedSources.historical.ledgerPath,
    expected: pinnedSources.historical,
    states,
    globalFindings,
    maxInputBytes
  });
  const githubAudit = await auditGithubStoredLedger({
    path: pinnedSources.github.ledgerPath,
    expected: pinnedSources.github,
    states,
    globalFindings,
    maxInputBytes
  });

  const scoringAuditFile = await readBoundedJson(
    scoringAuditRealPath,
    maxInputBytes,
    "current scoring diagnostic"
  );
  const scoringAudit = await validateAndApplyScoringAudit({
    rootPath,
    audit: scoringAuditFile.value,
    checkedAt,
    states,
    matrix,
    globalFindings,
    maxInputBytes
  });

  const resolvedProductionPaths = productionArtifactPaths ?? [
    ...GRAPH_ARTIFACTS.map((descriptor) => descriptor.path),
    ...HISTORY_ARTIFACTS.map((descriptor) => descriptor.path)
  ];
  const productionValidation = await productionValidator({
    rootDir: rootPath,
    now: new Date(checkedAt),
    requireCurrentCentralDay: false
  });
  if (productionValidation?.status !== "ok") {
    throw new Error("Existing public artifact validator did not return status=ok.");
  }
  const productionArtifacts = await hashDeclaredFiles(
    rootPath,
    resolvedProductionPaths,
    maxInputBytes,
    "production scoring artifact"
  );
  const dependencies = await hashDimensionDependencies({
    rootPath,
    dependencyPaths,
    maxInputBytes
  });

  const artifactDigests = {
    duplicates: hashProofEnvelope({
      dimension: "duplicates",
      storedPairScopesSha256: sha256(storedPairScopesFile.bytes),
      historicalLedgerSha256: historicalAudit.sha256,
      githubLedgerSha256: githubAudit.sha256,
      scoringAuditSha256: sha256(scoringAuditFile.bytes),
      scoringInputSha256: scoringAudit.inputSha256
    }),
    attribution: hashProofEnvelope({
      dimension: "attribution",
      storedPairScopesSha256: sha256(storedPairScopesFile.bytes),
      historicalLedgerSha256: historicalAudit.sha256,
      githubLedgerSha256: githubAudit.sha256,
      scoringAuditSha256: sha256(scoringAuditFile.bytes),
      scoringInputSha256: scoringAudit.inputSha256
    }),
    timestamps: hashProofEnvelope({
      dimension: "timestamps",
      historicalLedgerSha256: historicalAudit.sha256,
      githubLedgerSha256: githubAudit.sha256,
      scoringAuditSha256: sha256(scoringAuditFile.bytes),
      productionArtifactsSha256: productionArtifacts.combinedSha256
    }),
    scoring: hashProofEnvelope({
      dimension: "scoring",
      scoringAuditSha256: sha256(scoringAuditFile.bytes),
      scoringInputSha256: scoringAudit.inputSha256,
      scoringVersionedInputSha256: scoringAudit.versionedInputSha256,
      productionArtifactsSha256: productionArtifacts.combinedSha256
    })
  };

  applyGlobalFindings(states, globalFindings);
  const mergedRows = storedRows.map((row) => {
    const state = states.get(row.pairKey);
    return {
      ...row,
      scope: {
        ...row.scope,
        storedUnpublishedReceipt: refreshStoredUnpublishedReceipt(
          row.scope.storedUnpublishedReceipt,
          row.pairKey,
          checkedAt
        ),
        integrityChecks: buildIntegrityChecks(state, {
          checkedAt,
          artifactDigests,
          dependencies
        })
      }
    };
  });
  const summary = summarizeIntegrity(mergedRows);
  const manifestCore = {
    schemaVersion: PAIR_INTEGRITY_PROOF_BRIDGE_VERSION,
    status: dryRun ? "dry_run" : "staged",
    productionEligible: false,
    publicationAction: "none",
    generatedAt: checkedAt,
    denominator: {
      canonicalPairs: mergedRows.length,
      canonicalOwners: matrix.inventory.owners,
      companies: matrix.inventory.companies,
      founders: matrix.inventory.founders,
      platforms: ALL_PLATFORMS.length
    },
    sources: {
      storedCoverageManifest: descriptorForBytes(
        storedManifestRealPath,
        storedManifestFile.bytes
      ),
      storedPairScopes: descriptorForBytes(storedPairScopesPath, storedPairScopesFile.bytes, {
        rows: storedRows.length
      }),
      historical: historicalAudit,
      github: githubAudit,
      scoringAudit: descriptorForBytes(scoringAuditRealPath, scoringAuditFile.bytes),
      scoringInputSha256: scoringAudit.inputSha256,
      scoringVersionedInputSha256: scoringAudit.versionedInputSha256,
      productionArtifacts: productionArtifacts.files,
      productionArtifactsSha256: productionArtifacts.combinedSha256,
      productionValidation
    },
    dependencies,
    artifactDigests,
    summary,
    globalFindings,
    invariants: {
      everyCanonicalPairEvaluatedPerDimension: true,
      verifiedRequiresExactEvaluation: true,
      ambiguousOrUnknownNeverVerified: true,
      storedReceiptSourceProofPreserved: true,
      storedReceiptsRevalidatedThroughIntegrityCheck: true,
      rawEvidenceCopied: false,
      scoredRowsEmitted: 0,
      publishedRowsEmitted: 0
    }
  };
  if (dryRun) return manifestCore;
  return writeIntegrityPackage({ outputPath, rows: mergedRows, manifestCore });
}

function refreshStoredUnpublishedReceipt(receipt, pairKey, checkedAt) {
  const priorReceiptId = requiredText(receipt.receiptId, `${pairKey} stored receiptId`);
  const sourceProofSha256 = requiredSha256(
    receipt.sourceProofSha256,
    `${pairKey} stored sourceProofSha256`
  );
  return {
    ...receipt,
    receiptId: `stored-unpublished:${sha256(
      `${priorReceiptId}\u0000${sourceProofSha256}\u0000${checkedAt}`
    ).slice(0, 32)}`,
    checkedAt,
    coveredThrough: checkedAt,
    reason:
      `${receipt.reason} The exact source pins and both named ledgers were revalidated by ` +
      `${PAIR_INTEGRITY_PROOF_BRIDGE_VERSION} through ${checkedAt}.`,
    priorReceiptId
  };
}

function buildCanonicalMatrix(catalogs) {
  const pairs = new Map();
  const companiesByBatch = new Map();
  let companies = 0;
  let founders = 0;
  for (const catalog of catalogs) {
    const batchCompanies = new Set();
    for (const company of catalog.companies) {
      companies += 1;
      batchCompanies.add(company.id);
      addOwner(catalog.batchSlug, "company", company.id, company.name);
      for (const founder of company.founders) {
        founders += 1;
        addOwner(catalog.batchSlug, "founder", founder.id, founder.name);
      }
    }
    companiesByBatch.set(catalog.batchSlug, batchCompanies);
  }
  function addOwner(batchSlug, entityType, entityId, entityName) {
    for (const platform of ALL_PLATFORMS) {
      const pairKey = coveragePairKey({ batchSlug, entityType, entityId, platform });
      if (pairs.has(pairKey)) throw new Error(`Duplicate canonical pair ${pairKey}.`);
      pairs.set(pairKey, { pairKey, batchSlug, entityType, entityId, entityName, platform });
    }
  }
  return {
    pairs,
    companiesByBatch,
    inventory: { companies, founders, owners: companies + founders }
  };
}

function validateStoredCoverageManifest(value, generatedAt, expectedPairCount) {
  assertObject(value, "stored coverage manifest");
  if (value.schemaVersion !== STORED_COVERAGE_VERSION || value.status !== "staged" ||
      value.productionEligible !== false || value.scoringEligible !== false ||
      value.publicationAction !== "none") {
    throw new Error("Stored coverage input is not a fail-closed staged proof.");
  }
  if (
    requiredSha256(value.sourceProofSha256, "stored coverage.sourceProofSha256") !==
    sha256(stableJson(value.sources))
  ) {
    throw new Error("Stored coverage source proof no longer matches its hash-pinned source envelope.");
  }
  const stagedAt = canonicalTimestamp(value.generatedAt, "stored coverage.generatedAt");
  assertNotAfter(stagedAt, generatedAt, "stored coverage.generatedAt");
  if (exactNonnegativeInteger(
    value.denominator?.canonicalPairs,
    "stored coverage.denominator.canonicalPairs"
  ) !== expectedPairCount) {
    throw new Error("Stored coverage denominator does not match the exact canonical matrix.");
  }
  const descriptor = normalizeFileDescriptor(
    value.artifacts?.pairScopes,
    "stored coverage.artifacts.pairScopes"
  );
  if (descriptor.rows !== expectedPairCount || descriptor.format !== "json") {
    throw new Error("Stored pair-scopes descriptor has the wrong format or denominator.");
  }
  return { ...value, generatedAt: stagedAt, artifacts: { ...value.artifacts, pairScopes: descriptor } };
}

function validateStoredPairScopes(rows, canonicalPairs, manifest, expectedPairCount) {
  if (!Array.isArray(rows) || rows.length !== expectedPairCount) {
    throw new Error(`Stored pair-scopes must contain exactly ${expectedPairCount} rows.`);
  }
  const seen = new Set();
  const normalized = rows.map((row, index) => {
    assertObject(row, `stored pairScopes[${index}]`);
    const identity = exactIdentity(row, `stored pairScopes[${index}]`);
    const pairKey = coveragePairKey(identity);
    if (row.pairKey !== pairKey || !canonicalPairs.has(pairKey)) {
      throw new Error(`Stored pairScopes[${index}] does not resolve to canonical pair ${pairKey}.`);
    }
    if (seen.has(pairKey)) throw new Error(`Duplicate stored pair scope ${pairKey}.`);
    seen.add(pairKey);
    const receipt = row.scope?.storedUnpublishedReceipt;
    if (
      receipt?.status !== "complete" ||
      receipt?.sourceProofSha256 !== manifest.sourceProofSha256 ||
      receipt?.publicationPolicy !== "proof_only_no_publication" ||
      receipt?.scoringEligible !== false
    ) {
      throw new Error(`${pairKey} lacks the exact fail-closed stored-unpublished receipt.`);
    }
    if (row.scope?.integrityChecks !== undefined) {
      throw new Error(`${pairKey} already contains integrityChecks; refusing to overwrite proof.`);
    }
    return { ...row, pairKey };
  });
  if (seen.size !== canonicalPairs.size) {
    throw new Error("Stored pair-scopes are not an exact canonical pair census.");
  }
  return normalized.sort((left, right) => left.pairKey.localeCompare(right.pairKey));
}

async function validateStoredSourcePins({ rootPath, storedManifest, maxInputBytes }) {
  const historical = storedManifest.sources?.historical;
  const github = storedManifest.sources?.github;
  assertObject(historical, "stored manifest.sources.historical");
  assertObject(github, "stored manifest.sources.github");
  const historicalManifest = await verifyPinnedFile(
    rootPath,
    historical.manifestPath,
    historical.manifestSha256,
    maxInputBytes,
    "historical staging manifest"
  );
  const githubReceipt = await verifyPinnedFile(
    rootPath,
    github.receiptPath,
    github.receiptFileSha256,
    maxInputBytes,
    "GitHub staging receipt"
  );
  return {
    historical: {
      manifestPath: historicalManifest.path,
      manifestSha256: historicalManifest.sha256,
      ledgerPath: (await verifyPinnedPath(rootPath, historical.ledgerPath, "historical ledger")).path,
      ledgerSha256: requiredSha256(historical.ledgerSha256, "historical ledgerSha256"),
      ledgerRows: exactNonnegativeInteger(historical.ledgerRows, "historical ledgerRows")
    },
    github: {
      receiptPath: githubReceipt.path,
      receiptSha256: githubReceipt.sha256,
      ledgerPath: (await verifyPinnedPath(rootPath, github.ledgerPath, "GitHub ledger")).path,
      ledgerSha256: requiredSha256(github.ledgerSha256, "GitHub ledgerSha256"),
      ledgerRows: exactNonnegativeInteger(github.ledgerRows, "GitHub ledgerRows")
    }
  };
}

async function auditHistoricalStoredLedger({
  path,
  expected,
  states,
  globalFindings,
  maxInputBytes
}) {
  const seenIds = new Map();
  const seenPhysical = new Map();
  const seenDigests = new Map();
  const audit = await auditNdjson(path, {
    maxInputBytes,
    label: "historical stored ledger",
    onRow(row, index) {
      const resolved = resolveRowState(states, row, `historical row ${index}`, globalFindings);
      if (!resolved) return;
      const id = requiredText(row.id, `historical row ${index}.id`);
      resolved.observedRows.historical += 1;
      recordDuplicate(seenIds, id, resolved, `repeated historical row id ${id}`);
      const physical = requiredText(
        row.nativeId ?? row.canonicalUrl ?? row.sourceUrl,
        `${id}.physical identity`
      );
      recordDuplicate(
        seenPhysical,
        `${resolved.pairKey}\u0000${physical}`,
        resolved,
        `repeated historical physical identity ${physical}`
      );
      const digest = requiredSha256(row.historicalDigest, `${id}.historicalDigest`);
      recordDuplicate(
        seenDigests,
        `${resolved.pairKey}\u0000${digest}`,
        resolved,
        `repeated historical content digest ${digest}`
      );
      const expectedTarget = `${resolved.batchSlug}:${resolved.entityId}:${resolved.platform}`;
      if (row.historicalTargetKey !== expectedTarget ||
          row.publicationPolicy !== "stored_but_unpublished" ||
          row.historicalValidationStatus !== "pending_publication_validation") {
        addFinding(resolved, "attribution", "historical target attribution or publication gate mismatch");
      }
      validateEvidenceTimestamps(row, resolved, "historical");
    }
  });
  validateLedgerPin(audit, expected, "historical stored ledger");
  return { path, sha256: audit.sha256, rows: audit.rows, bytes: audit.bytes };
}

async function auditGithubStoredLedger({
  path,
  expected,
  states,
  globalFindings,
  maxInputBytes
}) {
  const seenReviewIds = new Map();
  const seenEvidenceIds = new Map();
  const audit = await auditNdjson(path, {
    maxInputBytes,
    label: "GitHub stored review ledger",
    onRow(row, index) {
      const reviewId = requiredText(row.reviewId, `GitHub row ${index}.reviewId`);
      const category = requiredText(row.category, `${reviewId}.category`);
      const candidateStates = [];
      if (GITHUB_EVIDENCE_CATEGORIES.has(category)) {
        if (!Array.isArray(row.ownerCandidates) || row.ownerCandidates.length === 0) {
          globalFindings.attribution.push(`${reviewId} has no owner candidates`);
          return;
        }
        for (const [candidateIndex, candidate] of row.ownerCandidates.entries()) {
          const state = resolveRowState(states, {
            ...candidate,
            platform: "github"
          }, `${reviewId}.ownerCandidates[${candidateIndex}]`, globalFindings);
          if (state) candidateStates.push(state);
        }
        const evidenceId = requiredText(
          row.contentIdentity?.evidenceId,
          `${reviewId}.contentIdentity.evidenceId`
        );
        for (const state of candidateStates) {
          state.observedRows.github += 1;
          recordDuplicate(seenReviewIds, `${reviewId}\u0000${state.pairKey}`, state,
            `repeated GitHub review attribution ${reviewId}`);
          recordDuplicate(seenEvidenceIds, `${evidenceId}\u0000${state.pairKey}`, state,
            `repeated GitHub physical identity ${evidenceId}`);
          validateEvidenceTimestamps(row, state, "GitHub");
        }
        if (new Set(candidateStates.map((state) => state.pairKey)).size !== candidateStates.length) {
          for (const state of candidateStates) {
            addFinding(state, "attribution", `duplicate owner attribution on ${reviewId}`);
          }
        }
        if (candidateStates.length !== 1) {
          for (const state of candidateStates) {
            addFinding(
              state,
              "attribution",
              `${reviewId} has ${candidateStates.length} canonical owner candidates`
            );
          }
        }
      } else if (category === GITHUB_BLOCKER_CATEGORY) {
        if (!Array.isArray(row.attributionTaskKeys) || row.attributionTaskKeys.length === 0) {
          globalFindings.attribution.push(`${reviewId} blocker has no attribution task`);
          return;
        }
        for (const [taskIndex, taskKey] of row.attributionTaskKeys.entries()) {
          const identity = parseGithubTaskKey(taskKey, `${reviewId}.attributionTaskKeys[${taskIndex}]`);
          const state = resolveRowState(states, { ...identity, platform: "github" }, reviewId,
            globalFindings);
          if (!state) continue;
          state.observedRows.github += 1;
          recordDuplicate(seenReviewIds, `${reviewId}\u0000${state.pairKey}`, state,
            `repeated GitHub blocker attribution ${reviewId}`);
          addFinding(state, "attribution", `${reviewId} remains a terminal attribution blocker`);
        }
      } else {
        globalFindings.attribution.push(`${reviewId} has unsupported category ${category}`);
      }
      if (row.publicationState !== "stored_but_unpublished" || row.scoringEligible !== false) {
        for (const state of candidateStates) {
          addFinding(state, "attribution", `${reviewId} violates stored-unpublished gates`);
        }
      }
    }
  });
  validateLedgerPin(audit, expected, "GitHub stored review ledger");
  return { path, sha256: audit.sha256, rows: audit.rows, bytes: audit.bytes };
}

async function validateAndApplyScoringAudit({
  rootPath,
  audit,
  checkedAt,
  states,
  matrix,
  globalFindings,
  maxInputBytes
}) {
  assertObject(audit, "scoring audit");
  const metadata = audit.metadata;
  if (
    metadata?.report_version !== "scoring-diagnostics-v4" ||
    metadata?.production_model_id !== "returner-traction" ||
    metadata?.production_model_version !== "4.2.0" ||
    audit.invariants?.all_passed !== true ||
    audit.invariants?.passed_count !== audit.invariants?.check_count ||
    audit.invariants?.violation_count !== 0
  ) {
    throw new Error("Scoring diagnostic lacks a complete passing V4 recomputation proof.");
  }
  const auditAt = canonicalTimestamp(metadata.generated_at, "scoring audit.metadata.generated_at");
  assertNotAfter(auditAt, checkedAt, "scoring audit.metadata.generated_at");
  const inputManifest = await verifyScoringInputManifest(
    rootPath,
    metadata.input_hashes,
    maxInputBytes
  );
  if (audit.global_summary?.company_count !== matrix.inventory.companies) {
    throw new Error("Scoring diagnostic company denominator is not the canonical census.");
  }
  if (!Array.isArray(audit.cohorts) || audit.cohorts.length !== matrix.companiesByBatch.size) {
    throw new Error("Scoring diagnostic does not contain every canonical cohort.");
  }
  const seenCohorts = new Set();
  for (const cohort of audit.cohorts) {
    const batchSlug = requiredText(cohort.cohort, "scoring cohort");
    if (seenCohorts.has(batchSlug) || !matrix.companiesByBatch.has(batchSlug)) {
      throw new Error(`Scoring diagnostic contains unknown or duplicate cohort ${batchSlug}.`);
    }
    seenCohorts.add(batchSlug);
    const expectedCompanies = matrix.companiesByBatch.get(batchSlug);
    if (cohort.input_counts?.companies !== expectedCompanies.size) {
      throw new Error(`${batchSlug} scoring diagnostic company count is incomplete.`);
    }
    const observations = new Map(
      (cohort.invariant_observations?.platform_rank_observations ?? [])
        .map((row) => [row.platform, row])
    );
    const slices = new Map(
      (cohort.scoring?.before_vs_after_by_platform ?? []).map((row) => [row.platform, row])
    );
    if (slices.size !== WEIGHTED_SCORING_PLATFORMS.length ||
        observations.size !== WEIGHTED_SCORING_PLATFORMS.length) {
      throw new Error(`${batchSlug} scoring diagnostic lacks an exact nine-platform comparison.`);
    }
    for (const platform of WEIGHTED_SCORING_PLATFORMS) {
      const slice = slices.get(platform);
      const observation = observations.get(platform);
      const beforeIds = scoringCompanyIds(slice?.score_before?.ranked_companies, batchSlug, platform,
        "before");
      const afterIds = scoringCompanyIds(slice?.score_after?.ranked_companies, batchSlug, platform,
        "after");
      if (!sameSet(beforeIds, expectedCompanies) || !sameSet(afterIds, expectedCompanies) ||
          !completePlatformObservation(observation, expectedCompanies.size)) {
        throw new Error(`${batchSlug}:${platform} scoring slice is not a complete recomputation.`);
      }
      for (const companyId of expectedCompanies) {
        const state = states.get(coveragePairKey({
          batchSlug,
          entityType: "company",
          entityId: companyId,
          platform
        }));
        state.evaluated.scoring = true;
        state.observedRows.scoring += 1;
      }
    }
    applyScoringFindings(cohort, states, globalFindings);
  }
  if (seenCohorts.size !== matrix.companiesByBatch.size) {
    throw new Error("Scoring diagnostic cohort census is incomplete.");
  }
  return {
    generatedAt: auditAt,
    inputSha256: inputManifest.combinedSha256,
    versionedInputSha256: requiredSha256(
      metadata.input_hashes.versioned_scoring_inputs?.combined_sha256,
      "scoring versioned input hash"
    )
  };
}

function applyScoringFindings(cohort, states, globalFindings) {
  for (const finding of cohort.eligibility_rejections?.findings ?? []) {
    if (!ATTRIBUTION_REJECTION_REASONS.has(finding.reason)) continue;
    for (const state of resolveAuditFindingStates(states, cohort.cohort, finding, globalFindings,
      "attribution")) {
      addFinding(state, "attribution", `scoring input rejected ${finding.audit_key} as ${finding.reason}`);
    }
  }
  for (const finding of cohort.missing_data?.findings ?? []) {
    if (!TIMESTAMP_FINDINGS.has(finding.issue)) continue;
    for (const state of resolveAuditFindingStates(states, cohort.cohort, finding, globalFindings,
      "timestamps")) {
      addFinding(state, "timestamps", `scoring input ${finding.audit_key} has ${finding.issue}`);
    }
  }
  const duplicateContainers = [
    ...Object.values(cohort.canonical_duplicates ?? {}).flatMap((value) => value?.groups ?? []),
    ...(cohort.invariant_observations?.eligible_company_physical_duplicate_groups ?? [])
  ];
  for (const group of duplicateContainers) {
    const identities = findAuditIdentities(group);
    if (identities.length === 0) {
      globalFindings.duplicates.push(`unscoped scoring duplicate in ${cohort.cohort}`);
      continue;
    }
    for (const identity of identities) {
      const state = resolveAuditIdentity(states, cohort.cohort, identity);
      if (state) addFinding(state, "duplicates", "scoring diagnostic reported a physical duplicate group");
      else globalFindings.duplicates.push(`unknown scoring duplicate identity in ${cohort.cohort}`);
    }
  }
}

function resolveAuditFindingStates(states, batchSlug, finding, globalFindings, dimension) {
  const identities = [];
  if (finding.entity_id && finding.platform) {
    identities.push({ entityId: finding.entity_id, platform: finding.platform });
  }
  for (const companyId of finding.owner_company_ids ?? []) {
    if (finding.platform) identities.push({ entityId: companyId, entityType: "company", platform: finding.platform });
  }
  const resolved = new Map();
  for (const identity of identities) {
    const state = resolveAuditIdentity(states, batchSlug, identity);
    if (state) resolved.set(state.pairKey, state);
  }
  if (resolved.size === 0) {
    globalFindings[dimension].push(`unscoped scoring finding ${finding.audit_key ?? "unknown"}`);
  }
  return [...resolved.values()];
}

function resolveAuditIdentity(states, batchSlug, identity) {
  const platform = String(identity.platform ?? "").toLowerCase();
  const entityId = String(identity.entityId ?? identity.entity_id ?? "");
  if (!ALL_PLATFORMS.includes(platform) || !entityId) return null;
  const explicitType = identity.entityType ?? identity.entity_type;
  for (const entityType of explicitType ? [explicitType] : ["company", "founder"]) {
    const state = states.get(coveragePairKey({ batchSlug, entityType, entityId, platform }));
    if (state) return state;
  }
  return null;
}

async function verifyScoringInputManifest(rootPath, manifest, maxInputBytes) {
  assertObject(manifest, "scoring input hash manifest");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0 ||
      manifest.file_count !== manifest.files.length) {
    throw new Error("Scoring input hash manifest has no exact file census.");
  }
  const seen = new Set();
  const entries = [];
  for (const [index, entry] of manifest.files.entries()) {
    assertObject(entry, `scoring input files[${index}]`);
    const relativePath = safeRelativePath(entry.path, `scoring input files[${index}].path`);
    if (seen.has(relativePath)) throw new Error(`Duplicate scoring input path ${relativePath}.`);
    seen.add(relativePath);
    const file = await hashFile(resolve(rootPath, relativePath), maxInputBytes, relativePath);
    if (file.sha256 !== requiredSha256(entry.sha256, `${relativePath}.sha256`) ||
        file.bytes !== exactNonnegativeInteger(entry.bytes, `${relativePath}.bytes`)) {
      throw new Error(`Scoring audit input ${relativePath} changed after recomputation.`);
    }
    entries.push({ path: relativePath, sha256: file.sha256 });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const combinedSha256 = sha256(entries.map((entry) => `${entry.path}\0${entry.sha256}\n`).join(""));
  if (combinedSha256 !== requiredSha256(manifest.combined_sha256, "scoring input combined_sha256")) {
    throw new Error("Scoring input combined SHA-256 does not reconcile with its exact file census.");
  }
  return { combinedSha256 };
}

function scoringCompanyIds(rows, batchSlug, platform, phase) {
  if (!Array.isArray(rows)) {
    throw new Error(`${batchSlug}:${platform} ${phase} scoring rows are missing.`);
  }
  const ids = rows.map((row) => requiredText(row.company_id, `${batchSlug}:${platform} company_id`));
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${batchSlug}:${platform} ${phase} scoring rows repeat a company.`);
  }
  return new Set(ids);
}

function completePlatformObservation(value, expectedRows) {
  return value?.before?.row_count === expectedRows &&
    value?.after?.row_count === expectedRows &&
    value.before.expected_row_count === expectedRows &&
    value.after.expected_row_count === expectedRows &&
    value.before.duplicate_company_id_count === 0 &&
    value.after.duplicate_company_id_count === 0 &&
    value.before.missing_company_ids?.length === 0 &&
    value.after.missing_company_ids?.length === 0 &&
    value.before.unexpected_company_ids?.length === 0 &&
    value.after.unexpected_company_ids?.length === 0 &&
    value.before.non_finite_score_count === 0 &&
    value.after.non_finite_score_count === 0 &&
    value.before.out_of_bounds_score_count === 0 &&
    value.after.out_of_bounds_score_count === 0;
}

function validateEvidenceTimestamps(row, state, source) {
  const published = row.publishedAt ?? row.postedAt;
  const observed = row.observedAt ?? row.last_checked_at ?? row.first_seen_at;
  if (!isCanonicalTimestamp(published) || !isCanonicalTimestamp(observed)) {
    addFinding(state, "timestamps", `${source} evidence lacks canonical exact timestamps`);
    return;
  }
  if (Date.parse(published) > Date.parse(observed)) {
    addFinding(state, "timestamps", `${source} publication time exceeds observation time`);
  }
}

function resolveRowState(states, row, label, globalFindings) {
  let identity;
  try {
    identity = exactIdentity(row, label);
  } catch (error) {
    globalFindings.attribution.push(`${label}: ${error.message}`);
    return null;
  }
  const pairKey = coveragePairKey(identity);
  const state = states.get(pairKey);
  if (!state) {
    globalFindings.attribution.push(`${label} references unknown canonical pair ${pairKey}`);
    return null;
  }
  return state;
}

function exactIdentity(row, label) {
  const batchSlug = requiredText(row.batchSlug, `${label}.batchSlug`);
  const entityType = requiredText(row.entityType, `${label}.entityType`).toLowerCase();
  if (!new Set(["company", "founder"]).has(entityType)) {
    throw new Error(`${label}.entityType must be company or founder.`);
  }
  const entityId = requiredText(row.entityId, `${label}.entityId`);
  const platform = requiredText(row.platform, `${label}.platform`).toLowerCase();
  if (!ALL_PLATFORMS.includes(platform)) throw new Error(`${label}.platform ${platform} is unknown.`);
  return { batchSlug, entityType, entityId, platform };
}

function recordDuplicate(index, key, state, reason) {
  const previous = index.get(key);
  if (previous) {
    addFinding(previous, "duplicates", reason);
    addFinding(state, "duplicates", reason);
  } else {
    index.set(key, state);
  }
}

function addFinding(state, dimension, reason) {
  const findings = state.findings[dimension];
  if (!findings.includes(reason)) findings.push(reason);
}

function applyGlobalFindings(states, globalFindings) {
  for (const dimension of DIMENSIONS) {
    if (globalFindings[dimension].length === 0) continue;
    const reason = `unscoped ${dimension} finding prevented exact pair attribution`;
    for (const state of states.values()) addFinding(state, dimension, reason);
  }
}

function buildIntegrityChecks(state, { checkedAt, artifactDigests, dependencies }) {
  return Object.fromEntries(DIMENSIONS.map((dimension) => {
    const findings = state.findings[dimension];
    const evaluated = state.evaluated[dimension] === true;
    const verified = evaluated && findings.length === 0;
    const observed = Object.values(state.observedRows).reduce((sum, count) => sum + count, 0);
    const reason = verified
      ? `${dimension} integrity was evaluated for ${state.pairKey} against the exact hash-pinned ` +
        `canonical and staged inputs; ${observed} attributed observation(s) were inspected and no ` +
        `${dimension} finding remained.`
      : !evaluated
        ? `${dimension} integrity is unverified for ${state.pairKey}: the current validator does not ` +
          "evaluate this entity-platform scoring lane."
        : `${dimension} integrity was evaluated for ${state.pairKey} but remains unverified with ` +
          `${findings.length} exact finding(s): ${findings.slice(0, 3).join("; ")}.`;
    const pairDigest = sha256(`${artifactDigests[dimension]}\u0000${state.pairKey}`);
    return [dimension, {
      receiptId: `integrity-${dimension}:${pairDigest.slice(0, 32)}`,
      verified,
      checkedAt,
      artifactDigest: artifactDigests[dimension],
      toolVersion: `${PAIR_INTEGRITY_PROOF_BRIDGE_VERSION}/${dimension}`,
      dependencyHash: dependencies[dimension].combinedSha256,
      reason,
      evaluated,
      findingCount: findings.length,
      observedRows: { ...state.observedRows },
      nextAction: verified
        ? `Retain the hash-pinned ${dimension} receipt when refreshing ${state.pairKey}.`
        : `Resolve or extend validator coverage for ${state.pairKey} before marking ${dimension} verified.`
    }];
  }));
}

function summarizeIntegrity(rows) {
  const dimensions = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, {
    verified: 0,
    unverified: 0,
    evaluated: 0,
    unevaluated: 0
  }]));
  const byPlatform = Object.fromEntries(ALL_PLATFORMS.map((platform) => [platform,
    Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, { verified: 0, unverified: 0 }]))
  ]));
  const byBatch = {};
  for (const row of rows) {
    byBatch[row.batchSlug] ??= Object.fromEntries(
      DIMENSIONS.map((dimension) => [dimension, { verified: 0, unverified: 0 }])
    );
    for (const dimension of DIMENSIONS) {
      const check = row.scope.integrityChecks[dimension];
      const status = check.verified ? "verified" : "unverified";
      dimensions[dimension][status] += 1;
      dimensions[dimension][check.evaluated ? "evaluated" : "unevaluated"] += 1;
      byPlatform[row.platform][dimension][status] += 1;
      byBatch[row.batchSlug][dimension][status] += 1;
    }
  }
  return { dimensions, byPlatform, byBatch };
}

async function hashDimensionDependencies({ rootPath, dependencyPaths, maxInputBytes }) {
  const output = {};
  for (const dimension of DIMENSIONS) {
    const paths = dependencyPaths?.[dimension];
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error(`dependencyPaths.${dimension} must name exact validator sources.`);
    }
    output[dimension] = await hashDeclaredFiles(
      rootPath,
      paths,
      maxInputBytes,
      `${dimension} validator dependency`
    );
  }
  return output;
}

async function hashDeclaredFiles(rootPath, paths, maxInputBytes, label) {
  const seen = new Set();
  const files = [];
  for (const [index, rawPath] of paths.entries()) {
    const relativePath = safeRelativePath(rawPath, `${label}[${index}]`);
    if (seen.has(relativePath)) throw new Error(`Duplicate ${label} ${relativePath}.`);
    seen.add(relativePath);
    const file = await hashFile(resolve(rootPath, relativePath), maxInputBytes, `${label} ${relativePath}`);
    files.push({ path: relativePath, sha256: file.sha256, bytes: file.bytes });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    files,
    combinedSha256: sha256(files.map((file) => `${file.path}\0${file.sha256}\n`).join(""))
  };
}

async function auditNdjson(path, { maxInputBytes, label, onRow }) {
  const info = await stat(path);
  if (!info.isFile()) throw new TypeError(`${label} must be a regular file.`);
  if (info.size > maxInputBytes) throw new Error(`${label} exceeds maxInputBytes=${maxInputBytes}.`);
  const hash = createHash("sha256");
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let rows = 0;
  let finalByte = null;
  for await (const rawChunk of createReadStream(path)) {
    const chunk = Buffer.from(rawChunk);
    hash.update(chunk);
    finalByte = chunk.at(-1);
    pending += decoder.write(chunk);
    while (true) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      if (!line) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch (error) {
        throw new Error(`${label} row ${rows + 1} is invalid JSON: ${error.message}`);
      }
      rows += 1;
      onRow(row, rows);
    }
    if (Buffer.byteLength(pending, "utf8") > 16 * 1024 * 1024) {
      throw new Error(`${label} contains a line larger than 16 MiB.`);
    }
  }
  pending += decoder.end();
  if (info.size > 0 && (finalByte !== 0x0a || pending.length !== 0)) {
    throw new Error(`${label} must end with a newline-terminated row.`);
  }
  return { path, sha256: hash.digest("hex"), rows, bytes: info.size };
}

async function writeIntegrityPackage({ outputPath, rows, manifestCore }) {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(temporary, { recursive: false });
  try {
    const pairDescriptor = await writeJsonArrayArtifact(
      join(temporary, "pair-scopes.json"),
      rows,
      manifestCore.generatedAt
    );
    const manifest = {
      ...manifestCore,
      outputDir: outputPath,
      artifacts: { pairScopes: pairDescriptor }
    };
    const manifestBody = `${stableJson(manifest)}\n`;
    const manifestName = "pair-integrity-proof-manifest.json";
    await writeFile(join(temporary, manifestName), manifestBody, { mode: 0o600, flag: "wx" });
    await rename(temporary, outputPath);
    return {
      ...manifest,
      manifestPath: join(outputPath, manifestName),
      manifestSha256: sha256(manifestBody)
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function writeJsonArrayArtifact(path, rows, observedAt) {
  const stream = createWriteStream(path, { flags: "wx", mode: 0o600 });
  const hash = createHash("sha256");
  let bytes = 0;
  async function append(chunk) {
    hash.update(chunk);
    bytes += Buffer.byteLength(chunk);
    if (!stream.write(chunk)) await once(stream, "drain");
  }
  try {
    await append("[");
    for (let index = 0; index < rows.length; index += 1) {
      await append(`${index ? "," : ""}${stableJson(rows[index])}`);
    }
    await append("]\n");
    stream.end();
    await once(stream, "finish");
  } catch (error) {
    stream.destroy();
    throw error;
  }
  return {
    path: basename(path),
    format: "json",
    rows: rows.length,
    bytes,
    sha256: hash.digest("hex"),
    observedAt
  };
}

async function verifyPinnedFile(rootPath, rawPath, expectedSha, maxBytes, label) {
  const verified = await verifyPinnedPath(rootPath, rawPath, label);
  const file = await hashFile(verified.path, maxBytes, label);
  if (file.sha256 !== requiredSha256(expectedSha, `${label}.sha256`)) {
    throw new Error(`${label} no longer matches its stored coverage pin.`);
  }
  return { path: verified.path, ...file };
}

async function verifyPinnedPath(rootPath, rawPath, label) {
  const declared = requiredText(rawPath, label);
  const candidate = resolveFromRoot(rootPath, declared);
  const real = await realpath(candidate);
  return { path: real };
}

async function hashFile(path, maxBytes, label) {
  const info = await stat(path);
  if (!info.isFile()) throw new TypeError(`${label} must be a regular file.`);
  if (info.size > maxBytes) throw new Error(`${label} exceeds maxInputBytes=${maxBytes}.`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { sha256: hash.digest("hex"), bytes: info.size };
}

async function readBoundedJson(path, maxBytes, label) {
  const info = await stat(path);
  if (!info.isFile()) throw new TypeError(`${label} must be a regular file.`);
  if (info.size > maxBytes) throw new Error(`${label} exceeds maxInputBytes=${maxBytes}.`);
  const bytes = await readFile(path);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
  return { bytes, value };
}

async function resolveDeclaredSibling(receiptPath, declaredPath, label) {
  if (basename(declaredPath) !== declaredPath || declaredPath.includes("\\")) {
    throw new Error(`${label} must be one sibling filename without traversal.`);
  }
  const candidate = await realpath(resolve(dirname(receiptPath), declaredPath));
  if (dirname(candidate) !== dirname(receiptPath)) {
    throw new Error(`${label} resolves outside its immutable proof directory.`);
  }
  return candidate;
}

function normalizeFileDescriptor(value, label) {
  assertObject(value, label);
  return {
    path: requiredText(value.path, `${label}.path`),
    format: requiredText(value.format, `${label}.format`),
    rows: exactNonnegativeInteger(value.rows, `${label}.rows`),
    bytes: exactNonnegativeInteger(value.bytes, `${label}.bytes`),
    sha256: requiredSha256(value.sha256, `${label}.sha256`),
    observedAt: canonicalTimestamp(value.observedAt, `${label}.observedAt`)
  };
}

function validateFileDescriptor(bytes, descriptor, label) {
  if (bytes.length !== descriptor.bytes || sha256(bytes) !== descriptor.sha256) {
    throw new Error(`${label} bytes or SHA-256 differ from its immutable descriptor.`);
  }
}

function validateLedgerPin(actual, expected, label) {
  if (actual.sha256 !== expected.ledgerSha256 || actual.rows !== expected.ledgerRows) {
    throw new Error(`${label} does not match its stored coverage hash/row pin.`);
  }
}

function descriptorForBytes(path, bytes, extras = {}) {
  return { path, bytes: bytes.length, sha256: sha256(bytes), ...extras };
}

function parseGithubTaskKey(value, label) {
  const match = requiredText(value, label)
    .match(/^([^:]+):(company|founder):([^:]+):(https:\/\/github\.com\/.+)$/i);
  if (!match) throw new Error(`${label} is not an exact GitHub attribution task key.`);
  return { batchSlug: match[1], entityType: match[2].toLowerCase(), entityId: match[3] };
}

function findAuditIdentities(value, output = []) {
  if (Array.isArray(value)) {
    for (const entry of value) findAuditIdentities(entry, output);
  } else if (value && typeof value === "object") {
    if ((value.entity_id || value.entityId) && value.platform) output.push(value);
    for (const nested of Object.values(value)) findAuditIdentities(nested, output);
  }
  return output;
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function hashProofEnvelope(value) {
  return sha256(stableJson(value));
}

function safeRelativePath(value, label) {
  const path = requiredText(value, label);
  if (path.startsWith("/") || path.split(/[\\/]/).includes("..") || path.includes("\\")) {
    throw new Error(`${label} must be a repository-relative path without traversal.`);
  }
  return path.split("/").join(sep);
}

async function assertPathDoesNotExist(path, label) {
  try {
    await stat(path);
    throw new Error(`${label} already exists: ${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function coveragePairKey({ batchSlug, entityType, entityId, platform }) {
  return [batchSlug, entityType, entityId, platform]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

function resolveFromRoot(root, path) {
  return resolve(root, path);
}

function isCanonicalTimestamp(value) {
  return typeof value === "string" && CANONICAL_ISO.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function canonicalTimestamp(value, label) {
  if (!isCanonicalTimestamp(value)) {
    throw new TypeError(`${label} must be a canonical ISO UTC timestamp.`);
  }
  return value;
}

function assertNotAfter(value, upperBound, label) {
  if (Date.parse(value) > Date.parse(upperBound)) {
    throw new Error(`${label} cannot be later than generatedAt.`);
  }
}

function requiredText(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new TypeError(`${label} must be non-empty text.`);
  return text;
}

function requiredSha256(value, label) {
  const digest = requiredText(value, label).toLowerCase();
  if (!SHA256.test(digest)) throw new TypeError(`${label} must be lowercase SHA-256.`);
  return digest;
}

function exactNonnegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer.`);
  }
  return number;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return number;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}
