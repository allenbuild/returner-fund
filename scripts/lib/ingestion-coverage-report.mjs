import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  INGESTION_CORE_PLATFORMS,
  INGESTION_EXTENDED_ONLY_PLATFORMS
} from "./ingestion-coverage-receipt.mjs";
import {
  INGESTION_COVERAGE_MATERIALIZATION_VERSION
} from "./ingestion-coverage-materializer.mjs";

export const INGESTION_COVERAGE_REPORT_VERSION = "ingestion-coverage-report.v1";
export const HISTORICAL_COMPLETION_MANIFEST_VERSION =
  "historical-completion-proof-generator.v1";
export const RECENT_COMPLETION_MANIFEST_VERSION =
  "recent-completion-proof-generator.v1";

const CAMPAIGN_VERSION = "ingestion-coverage-campaign.v1";
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MATERIALIZATION_FIELDS = new Set([
  "schemaVersion",
  "runId",
  "generatedAt",
  "coverageGeneratedAt",
  "objectiveComplete",
  "productionReleaseStatus",
  "fullIngestionCoverageStatus",
  "provenance"
]);
const MATERIALIZATION_CAPTURE_FIELDS = new Set([
  ...MATERIALIZATION_FIELDS,
  "terminalOutcomeResolution"
]);
const MATERIALIZATION_HASH_FIELDS = new Set(["coverageReceipt"]);
const JSON_OUTSIDE_STRING_TOKEN = /["{}\[\]]/g;
const JSON_INSIDE_STRING_TOKEN = /["\\]/g;

/**
 * Build a bounded-memory projection of the canonical coverage materialization.
 * The 100+ MB receipt is never retained: its exact serialized bytes are hashed
 * while the materializer-authenticated summary and provenance are captured.
 */
export async function buildIngestionCoverageReport({
  root = process.cwd(),
  materializationPath,
  historicalManifestPath,
  recentManifestPath,
  maxManifestBytes = 8 * 1024 * 1024,
  maxProofArtifactBytes = 32 * 1024 * 1024,
  maxCapturedMaterializationValueBytes = 16 * 1024 * 1024
} = {}) {
  const absoluteRoot = resolve(root);
  const paths = {
    materialization: resolveInputPath(absoluteRoot, materializationPath, "materializationPath"),
    historicalManifest: resolveInputPath(
      absoluteRoot,
      historicalManifestPath,
      "historicalManifestPath"
    ),
    recentManifest: resolveInputPath(
      absoluteRoot,
      recentManifestPath,
      "recentManifestPath"
    )
  };

  const [historicalFile, recentFile] = await Promise.all([
    readBoundJson(paths.historicalManifest, maxManifestBytes, "historical proof manifest"),
    readBoundJson(paths.recentManifest, maxManifestBytes, "recent proof manifest")
  ]);
  const historicalManifest = historicalFile.value;
  const recentManifest = recentFile.value;
  validateHistoricalManifest(historicalManifest);
  validateRecentManifest(recentManifest);

  const campaignPath = resolveInputPath(
    absoluteRoot,
    recentManifest.sourceCampaign.path,
    "recentManifest.sourceCampaign.path"
  );
  const campaignFile = await readBoundJson(campaignPath, maxManifestBytes, "campaign manifest");
  const campaign = campaignFile.value;
  if (campaignFile.sha256 !== recentManifest.sourceCampaign.sha256) {
    throw new Error(
      `Campaign manifest sha256 mismatch: expected ${recentManifest.sourceCampaign.sha256}, ` +
      `received ${campaignFile.sha256}.`
    );
  }
  validateCampaign(campaign);

  const historicalRoot = dirname(paths.historicalManifest);
  const recentRoot = dirname(paths.recentManifest);
  const expectedManifestDescriptor = requiredCampaignDescriptor(
    campaign.artifacts.expectedCatalogManifest,
    "campaign.artifacts.expectedCatalogManifest"
  );
  const expectedManifestPath = resolveDeclaredPath(
    dirname(campaignPath),
    expectedManifestDescriptor.path,
    "campaign expected catalog manifest"
  );
  const historicalProofDescriptor = requiredDescriptor(
    historicalManifest.artifacts.completionProofs,
    "historicalManifest.artifacts.completionProofs"
  );
  const historicalExclusionDescriptor = requiredDescriptor(
    historicalManifest.artifacts.completionExclusions,
    "historicalManifest.artifacts.completionExclusions"
  );
  const recentProofDescriptor = requiredDescriptor(
    recentManifest.artifacts.recentCompletionProofs,
    "recentManifest.artifacts.recentCompletionProofs"
  );
  const recentExclusionDescriptor = requiredDescriptor(
    recentManifest.artifacts.recentCompletionExclusions,
    "recentManifest.artifacts.recentCompletionExclusions"
  );
  const sourceJournalPath = resolveInputPath(
    absoluteRoot,
    historicalManifest.sourceArtifact.path,
    "historicalManifest.sourceArtifact.path"
  );

  const [
    materialized,
    historicalProofFile,
    historicalExclusionFile,
    recentProofFile,
    recentExclusionFile,
    sourceJournalFile,
    expectedManifestFile
  ] = await Promise.all([
    extractMaterializationProjection(paths.materialization, {
      maxCapturedValueBytes: maxCapturedMaterializationValueBytes
    }),
    readAndVerifyDeclaredJson({
      base: historicalRoot,
      descriptor: historicalProofDescriptor,
      maxBytes: maxProofArtifactBytes,
      label: "historical completion proofs"
    }),
    readAndVerifyDeclaredJson({
      base: historicalRoot,
      descriptor: historicalExclusionDescriptor,
      maxBytes: maxProofArtifactBytes,
      label: "historical completion exclusions"
    }),
    readAndVerifyDeclaredJson({
      base: recentRoot,
      descriptor: recentProofDescriptor,
      maxBytes: maxProofArtifactBytes,
      label: "recent completion proofs"
    }),
    readAndVerifyDeclaredJson({
      base: recentRoot,
      descriptor: recentExclusionDescriptor,
      maxBytes: maxProofArtifactBytes,
      label: "recent completion exclusions"
    }),
    hashBoundFile(sourceJournalPath, historicalManifest.sourceArtifact, "historical source journal"),
    readAndVerifyDeclaredJson({
      base: dirname(campaignPath),
      descriptor: expectedManifestDescriptor,
      maxBytes: maxManifestBytes,
      label: "expected catalog manifest"
    })
  ]);

  verifyProofArtifactRows(
    historicalProofFile.value,
    historicalProofDescriptor.rows,
    "historical completion proofs"
  );
  verifyProofArtifactRows(
    historicalExclusionFile.value,
    historicalExclusionDescriptor.rows,
    "historical completion exclusions"
  );
  verifyProofArtifactRows(
    recentProofFile.value,
    recentProofDescriptor.rows,
    "recent completion proofs"
  );
  verifyProofArtifactRows(
    recentExclusionFile.value,
    recentExclusionDescriptor.rows,
    "recent completion exclusions"
  );
  validateHistoricalProofArtifacts({
    proofs: historicalProofFile.value,
    exclusions: historicalExclusionFile.value,
    manifest: historicalManifest
  });
  validateRecentProofArtifacts({
    proofs: recentProofFile.value,
    exclusions: recentExclusionFile.value,
    manifest: recentManifest
  });

  const projection = validateMaterializationProjection(materialized, {
    campaign,
    expectedCatalogManifest: expectedManifestFile.value
  });
  crossValidateProofs({
    projection,
    campaign,
    historicalManifest,
    recentManifest,
    historicalProofDescriptor,
    recentProofDescriptor
  });

  const status = projection.fullIngestionCoverageStatus;
  const historical = summarizeHistoricalProofs(historicalManifest);
  const recent = summarizeRecentProofs(recentManifest);
  const byBatch = Object.entries(status.byBatch).map(([batchSlug, group]) => ({
    batchSlug,
    ...projectCoverageGroup(group),
    historicalProof: proofGroup(historicalManifest.summary.byBatch?.[batchSlug]),
    recentProof: proofGroup(recentManifest.summary.byBatch?.[batchSlug])
  }));
  const byPlatform = INGESTION_CORE_PLATFORMS.map((platform) => ({
    platform,
    ...projectCoverageGroup(status.byPlatform[platform]),
    historicalProof: proofGroup(historicalManifest.summary.byPlatform?.[platform]),
    recentProof: proofGroup(recentManifest.summary.byPlatform?.[platform])
  }));
  const byBatchPlatform = Object.entries(status.byBatchPlatform).map(([key, group]) => ({
    key,
    batchSlug: group.batchSlug,
    platform: group.platform,
    ...projectCoverageGroup(group)
  }));

  const missingScopeProofs = summarizeMissingScopeProofs(status);
  const nextActions = uniqueStrings([
    ...projection.productionReleaseStatus.nextActions,
    ...recentManifest.contractChangesRequired,
    ...(missingScopeProofs.scheduler.missing > 0
      ? ["Repair scheduled ingestion and issue an immutable scheduler-current receipt for every remaining core entity-platform pair."]
      : []),
    ...(missingScopeProofs.integrity.missing > 0
      ? ["Resolve duplicate, attribution, timestamp, and scoring checks and issue the four-dimensional integrity receipt for every remaining pair."]
      : []),
    ...(status.unresolved.pairs > 0
      ? [`Resolve the ${status.unresolved.pairs} unresolved core pairs from ${status.unresolved.completeRecordsPath}; retain exact reason codes and concrete next actions.`]
      : [])
  ]);

  const payload = {
    schemaVersion: INGESTION_COVERAGE_REPORT_VERSION,
    runId: projection.runId,
    generatedAt: projection.generatedAt,
    artifactBound: true,
    objectiveComplete: projection.objectiveComplete,
    productionReleaseStatus: {
      status: projection.productionReleaseStatus.status,
      complete: projection.productionReleaseStatus.complete,
      verifiedReceipts: projection.productionReleaseStatus.verifiedReceiptCount,
      requiredReceipts: projection.productionReleaseStatus.requiredReceiptCount,
      blockers: projection.productionReleaseStatus.blockers,
      nextActions: projection.productionReleaseStatus.nextActions
    },
    fullIngestionCoverageStatus: {
      status: status.status,
      complete: status.objectiveComplete,
      coverageMatrixResolved: status.coverageMatrixResolved,
      objectiveCoveragePercent: status.scope.objectiveCoveragePercent,
      matrixResolutionPercent: status.scope.matrixResolutionPercent
    },
    ...(projection.terminalOutcomeResolution
      ? { terminalOutcomeResolution: projection.terminalOutcomeResolution }
      : {}),
    inventory: {
      companies: status.denominator.companies,
      founders: status.denominator.founders,
      entities: status.denominator.entities,
      corePlatforms: status.denominator.corePlatforms,
      extendedOnlyPlatforms: status.denominator.extendedOnlyPlatforms,
      corePairs: status.denominator.corePairs,
      allPairs: status.denominator.allPairs,
      fullyEvaluatedCompanies: status.evaluated.companies,
      fullyEvaluatedFounders: status.evaluated.founders,
      fullyEvaluatedEntities: status.evaluated.entities,
      evaluatedCorePairs: status.evaluated.pairs
    },
    totals: {
      terminalStatusBuckets: status.terminalStatusBuckets,
      mapping: status.mapping,
      profiles: status.profiles,
      posts: status.posts,
      scope: status.scope,
      unresolved: {
        pairs: status.unresolved.pairs,
        documentedBlockerPairs: status.unresolved.documentedBlockerPairs,
        completeRecordsPath: status.unresolved.completeRecordsPath
      }
    },
    completionProofs: { historical, recent },
    missingScopeProofs,
    byBatch,
    byPlatform,
    byBatchPlatform,
    blockers: {
      production: projection.productionReleaseStatus.blockers,
      unresolvedCorePairs: status.unresolved.pairs,
      documentedBlockerPairs: status.unresolved.documentedBlockerPairs,
      historicalExclusionReasons: historicalManifest.summary.exclusionReasons,
      recentExclusionReasons: recentManifest.summary.exclusionReasons
    },
    nextActions,
    definitions: status.definitions,
    artifacts: {
      materialization: artifactRecord(absoluteRoot, paths.materialization, materialized),
      campaignManifest: artifactRecord(absoluteRoot, campaignPath, campaignFile),
      expectedCatalogManifest: artifactRecord(
        absoluteRoot,
        expectedManifestPath,
        expectedManifestFile
      ),
      historicalManifest: artifactRecord(
        absoluteRoot,
        paths.historicalManifest,
        historicalFile
      ),
      historicalCompletionProofs: artifactRecord(
        absoluteRoot,
        historicalProofFile.path,
        historicalProofFile
      ),
      historicalCompletionExclusions: artifactRecord(
        absoluteRoot,
        historicalExclusionFile.path,
        historicalExclusionFile
      ),
      historicalSourceJournal: artifactRecord(
        absoluteRoot,
        sourceJournalPath,
        sourceJournalFile
      ),
      recentManifest: artifactRecord(absoluteRoot, paths.recentManifest, recentFile),
      recentCompletionProofs: artifactRecord(
        absoluteRoot,
        recentProofFile.path,
        recentProofFile
      ),
      recentCompletionExclusions: artifactRecord(
        absoluteRoot,
        recentExclusionFile.path,
        recentExclusionFile
      )
    },
    sourceDigests: {
      materializationManifestSha256:
        projection.provenance.materializationManifestSha256,
      coverageReceiptSha256: projection.provenance.coverageReceiptSha256,
      expectedCatalogManifestSha256:
        projection.provenance.expectedCatalogManifestSha256,
      ...(projection.provenance.terminalOutcomeResolutionSha256
        ? {
            terminalOutcomeResolutionSha256:
              projection.provenance.terminalOutcomeResolutionSha256
          }
        : {})
    }
  };
  const reportPayloadSha256 = sha256Stable(payload);
  const report = {
    ...payload,
    provenance: {
      hashAlgorithm: "sha256",
      hashSerialization: "stable-json.v1",
      reportPayloadSha256,
      projectionStrategy: "bounded-top-level-json+raw-coverage-receipt-hash.v1"
    }
  };
  return { report, markdown: renderIngestionCoverageReportMarkdown(report) };
}

/** Stream the materialization and retain only authenticated summary fields. */
export async function extractMaterializationProjection(
  path,
  { maxCapturedValueBytes = 16 * 1024 * 1024 } = {}
) {
  if (!Number.isSafeInteger(maxCapturedValueBytes) || maxCapturedValueBytes < 1024) {
    throw new TypeError("maxCapturedValueBytes must be a safe integer of at least 1024.");
  }
  const extractor = new TopLevelJsonExtractor({
    capturedFields: MATERIALIZATION_CAPTURE_FIELDS,
    hashedFields: MATERIALIZATION_HASH_FIELDS,
    maxCapturedValueBytes
  });
  const fileHash = createHash("sha256");
  let bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const chunk of createReadStream(path)) {
    fileHash.update(chunk);
    bytes += chunk.length;
    extractor.feed(decoder.decode(chunk, { stream: true }));
  }
  extractor.feed(decoder.decode());
  const result = extractor.finish();
  return {
    path,
    bytes,
    sha256: fileHash.digest("hex"),
    values: result.values,
    valueSha256: result.valueSha256,
    valueBytes: result.valueBytes
  };
}

export function renderIngestionCoverageReportMarkdown(report) {
  requireObject(report, "report");
  if (report.schemaVersion !== INGESTION_COVERAGE_REPORT_VERSION) {
    throw new Error(`report.schemaVersion must be ${INGESTION_COVERAGE_REPORT_VERSION}.`);
  }
  const i = report.inventory;
  const t = report.totals;
  const h = report.completionProofs.historical;
  const r = report.completionProofs.recent;
  const lines = [
    "# Full ingestion coverage report",
    "",
    `Run: \`${escapeMd(report.runId)}\`  `,
    `Generated: ${escapeMd(report.generatedAt)}  `,
    `Artifact-bound payload: \`${report.provenance.reportPayloadSha256}\``,
    "",
    "## Status",
    "",
    "| Status track | Result | Evidence |",
    "|---|---:|---|",
    `| Production release | ${report.productionReleaseStatus.complete ? "VERIFIED" : "INCOMPLETE"} | ${report.productionReleaseStatus.verifiedReceipts}/${report.productionReleaseStatus.requiredReceipts} required receipts verified |`,
    `| Full ingestion coverage | ${report.fullIngestionCoverageStatus.complete ? "COMPLETE" : "INCOMPLETE"} | ${t.scope.objectiveCompletePairs}/${i.corePairs} objective-complete pairs (${formatPercent(t.scope.objectiveCoveragePercent)}) |`,
    `| Coverage matrix resolution | ${report.fullIngestionCoverageStatus.coverageMatrixResolved ? "RESOLVED" : "UNRESOLVED"} | ${t.scope.matrixResolvedPairs}/${i.corePairs} pairs resolved (${formatPercent(t.scope.matrixResolutionPercent)}) |`,
    ...(report.terminalOutcomeResolution
      ? [
          `| Terminal outcome documentation | ${report.terminalOutcomeResolution.complete ? "COMPLETE" : "INCOMPLETE"} | ` +
            `${report.terminalOutcomeResolution.resolvedPairs}/${i.corePairs} core pairs have exactly one allowed terminal category |`
        ]
      : []),
    "",
    "Production release and full ingestion coverage are independent. A deployment does not make the coverage matrix complete.",
    "",
    "## Measured totals",
    "",
    "| Measure | Count | Denominator | Coverage |",
    "|---|---:|---:|---:|",
    metricRow("Companies fully evaluated", i.fullyEvaluatedCompanies, i.companies),
    metricRow("Founders fully evaluated", i.fullyEvaluatedFounders, i.founders),
    metricRow("Core entity-platform pairs evaluated", i.evaluatedCorePairs, i.corePairs),
    metricRow("Verified account mappings", t.mapping.verifiedAccounts, t.profiles.mapped),
    metricRow("Mapped profiles scraped", t.profiles.scraped, t.profiles.mapped),
    metricRow("Verified mapped profiles scraped", t.profiles.verifiedScraped, t.profiles.verifiedMapped),
    metricRow("Recent completion proofs", r.complete, r.evaluated),
    metricRow("Historical completion proofs", h.complete, h.evaluated),
    metricRow("Scheduled-ingestion-current proofs", t.scope.schedulerCurrentPairs, i.corePairs),
    metricRow("Integrity proofs", t.scope.integrityVerifiedPairs, i.corePairs),
    "",
    `Physical attributed posts: **${formatInt(t.posts.physicalPosts)}** ` +
      `(${formatInt(t.posts.physicalRecentPosts)} recent, ` +
      `${formatInt(t.posts.physicalHistoricalPosts)} historical). ` +
      `Stored-but-unpublished physical rows surfaced: **${formatInt(t.posts.allMatrixStoredUnpublishedPosts)}**; ` +
      `surfacing checks exist for ${formatInt(t.scope.storedUnpublishedSurfacedPairs)}/${formatInt(i.corePairs)} pairs.`,
    "",
    "Raw materializer pair outcomes: " + Object.entries(t.terminalStatusBuckets)
      .map(([key, value]) => `${key}=${formatInt(value)}`).join(", ") + ".",
    ...(report.terminalOutcomeResolution
      ? [
          "Canonical terminal outcomes: " +
            Object.entries(report.terminalOutcomeResolution.outcomeCounts)
              .map(([key, value]) => `${key}=${formatInt(value)}`).join(", ") +
            ". These documentation outcomes do not imply backfill, scheduler, integrity, or production completion."
        ]
      : []),
    "",
    "## Coverage by batch",
    "",
    "| Batch | Companies evaluated | Founders evaluated | Pairs evaluated | Mapped pairs | Verified accounts | Profiles scraped | Recent posts | Historical posts | Unresolved | Recent proof | Historical proof |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.byBatch.map((row) => coverageTableRow(row, "batch")),
    "",
    "## Coverage by platform",
    "",
    "| Platform | Pairs evaluated | Mapped pairs | Verified accounts | Profiles scraped | Recent posts | Historical posts | Collected | Blocked | Queued | Unresolved | Recent proof | Historical proof |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.byPlatform.map((row) => coverageTableRow(row, "platform")),
    "",
    "## Batch × platform matrix",
    "",
    "| Batch | Platform | Evaluated | Mapped | Verified accounts | Profiles scraped | Recent posts | Historical posts | Resolved | Objective-complete |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.byBatchPlatform.map((row) =>
      `| ${escapeMd(row.batchSlug)} | ${escapeMd(row.platform)} | ` +
      `${ratio(row.evaluated.pairs, row.denominator.pairs)} | ` +
      `${ratio(row.mapping.mappedPairs, row.denominator.pairs)} | ` +
      `${formatInt(row.mapping.verifiedAccounts)} | ${ratio(row.profiles.scraped, row.profiles.mapped)} | ` +
      `${formatInt(row.posts.recentPosts)} | ${formatInt(row.posts.historicalPosts)} | ` +
      `${ratio(row.scope.matrixResolvedPairs, row.denominator.pairs)} | ` +
      `${ratio(row.scope.objectiveCompletePairs, row.denominator.pairs)} |`
    ),
    "",
    "## Blockers",
    "",
    ...bulletSection("Production", report.blockers.production),
    `- Coverage matrix: ${formatInt(report.blockers.unresolvedCorePairs)} unresolved pairs; ` +
      `${formatInt(report.blockers.documentedBlockerPairs)} pairs have documented blockers or next actions.`,
    `- Historical proof exclusions: ${reasonCounts(report.blockers.historicalExclusionReasons)}.`,
    `- Recent proof exclusions: ${reasonCounts(report.blockers.recentExclusionReasons)}.`,
    "",
    "## Next actions",
    "",
    ...report.nextActions.map((value) => `- ${escapeMd(value)}`),
    "",
    "## Artifact attestation",
    "",
    "| Artifact | Bytes | SHA-256 | Path |",
    "|---|---:|---|---|",
    ...Object.entries(report.artifacts).map(([kind, artifact]) =>
      `| ${escapeMd(kind)} | ${formatInt(artifact.bytes)} | \`${artifact.sha256}\` | ` +
      `\`${escapeMd(artifact.path)}\` |`
    ),
    "",
    "No completion is inferred from post counts, successful examples, or a passing deployment. Every completion rate above comes from the hash-verified materializer or immutable proof manifests."
  ];
  return `${lines.join("\n")}\n`;
}

function validateMaterializationProjection(materialized, { campaign, expectedCatalogManifest }) {
  const value = materialized.values;
  for (const field of MATERIALIZATION_FIELDS) {
    if (!(field in value)) throw new Error(`Materialization is missing ${field}.`);
  }
  if (value.schemaVersion !== INGESTION_COVERAGE_MATERIALIZATION_VERSION) {
    throw new Error(
      `Materialization schemaVersion must be ${INGESTION_COVERAGE_MATERIALIZATION_VERSION}.`
    );
  }
  requiredText(value.runId, "materialization.runId");
  requiredTimestamp(value.generatedAt, "materialization.generatedAt");
  requiredTimestamp(value.coverageGeneratedAt, "materialization.coverageGeneratedAt");
  if (value.runId !== campaign.runId) {
    throw new Error("Materialization runId does not match the hash-pinned campaign.");
  }
  if (value.coverageGeneratedAt !== campaign.coverageGeneratedAt) {
    throw new Error(
      "Materialization coverageGeneratedAt does not match the hash-pinned campaign."
    );
  }
  requireObject(value.productionReleaseStatus, "materialization.productionReleaseStatus");
  requireObject(value.fullIngestionCoverageStatus, "materialization.fullIngestionCoverageStatus");
  requireObject(value.provenance, "materialization.provenance");
  const provenance = value.provenance;
  requiredSha256(provenance.coverageReceiptSha256, "provenance.coverageReceiptSha256");
  requiredSha256(
    provenance.expectedCatalogManifestSha256,
    "provenance.expectedCatalogManifestSha256"
  );
  requiredSha256(
    provenance.materializationManifestSha256,
    "provenance.materializationManifestSha256"
  );
  if (provenance.hashAlgorithm !== "sha256" ||
      provenance.hashSerialization !== "stable-json.v1") {
    throw new Error("Materialization provenance hash contract is unsupported.");
  }
  if (materialized.valueSha256.coverageReceipt !== provenance.coverageReceiptSha256) {
    throw new Error(
      `Coverage receipt sha256 mismatch: expected ${provenance.coverageReceiptSha256}, ` +
      `received ${materialized.valueSha256.coverageReceipt}.`
    );
  }
  if (value.terminalOutcomeResolution !== undefined) {
    validateTerminalOutcomeResolution(
      value.terminalOutcomeResolution,
      value.fullIngestionCoverageStatus.denominator.corePairs
    );
    requiredSha256(
      provenance.terminalOutcomeResolutionSha256,
      "provenance.terminalOutcomeResolutionSha256"
    );
    if (sha256Stable(value.terminalOutcomeResolution) !==
        provenance.terminalOutcomeResolutionSha256) {
      throw new Error("Terminal outcome resolution digest does not match provenance.");
    }
  } else if (provenance.terminalOutcomeResolutionSha256 !== undefined) {
    throw new Error(
      "Materialization provenance declares terminalOutcomeResolutionSha256 without a summary."
    );
  }
  validateFullCoverageStatus(value.fullIngestionCoverageStatus);
  validateProductionStatus(value.productionReleaseStatus);
  const expectedManifestDigest = sha256Stable(expectedCatalogManifest);
  if (expectedManifestDigest !== provenance.expectedCatalogManifestSha256) {
    throw new Error(
      "Expected catalog manifest stable digest does not match materialization provenance."
    );
  }
  if (sha256Stable(value.fullIngestionCoverageStatus.expectedCatalogManifest) !==
      provenance.expectedCatalogManifestSha256) {
    throw new Error(
      "Coverage summary expected catalog manifest does not match materialization provenance."
    );
  }
  const digestPayload = {
    schemaVersion: value.schemaVersion,
    runId: value.runId,
    generatedAt: value.generatedAt,
    coverageGeneratedAt: value.coverageGeneratedAt,
    objectiveComplete: value.objectiveComplete,
    productionReleaseStatus: value.productionReleaseStatus,
    fullIngestionCoverageStatus: value.fullIngestionCoverageStatus,
    ...(value.terminalOutcomeResolution
      ? { terminalOutcomeResolution: value.terminalOutcomeResolution }
      : {}),
    coverageReceiptSha256: provenance.coverageReceiptSha256,
    expectedCatalogManifestSha256: provenance.expectedCatalogManifestSha256,
    inputArtifacts: provenance.inputArtifacts,
    adapterProvenance: provenance.adapter,
    historicalAdapterProvenance: provenance.historicalAdapters,
    historicalDepthAdapterProvenance: provenance.historicalDepthAdapters,
    crossLayerDuplicateReviews: provenance.crossLayerDuplicateReviews
  };
  const actualManifestDigest = sha256Stable(digestPayload);
  if (actualManifestDigest !== provenance.materializationManifestSha256) {
    throw new Error(
      `Materialization manifest digest mismatch: expected ` +
      `${provenance.materializationManifestSha256}, received ${actualManifestDigest}.`
    );
  }
  const expectedObjective = value.productionReleaseStatus.complete === true &&
    value.fullIngestionCoverageStatus.objectiveComplete === true;
  if (value.objectiveComplete !== expectedObjective) {
    throw new Error("Materialization objectiveComplete does not reconcile with both statuses.");
  }
  return value;
}

function validateTerminalOutcomeResolution(value, expectedCorePairs) {
  requireObject(value, "terminalOutcomeResolution");
  if (value.schemaVersion !== "ingestion-terminal-outcome-resolution.v1") {
    throw new Error("Unsupported terminalOutcomeResolution schemaVersion.");
  }
  if (value.complete !== true) {
    throw new Error("terminalOutcomeResolution must fail closed unless complete.");
  }
  nonNegativeInteger(value.corePairs, "terminalOutcomeResolution.corePairs");
  nonNegativeInteger(value.resolvedPairs, "terminalOutcomeResolution.resolvedPairs");
  if (value.corePairs !== expectedCorePairs || value.resolvedPairs !== expectedCorePairs) {
    throw new Error("Terminal outcome resolution denominator does not reconcile.");
  }
  requireObject(value.outcomeCounts, "terminalOutcomeResolution.outcomeCounts");
  const allowed = [
    "collected",
    "verified_no_account",
    "access_blocked",
    "requires_credentials_or_manual_review"
  ];
  const keys = Object.keys(value.outcomeCounts).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...allowed].sort())) {
    throw new Error("Terminal outcome resolution contains an unsupported outcome bucket.");
  }
  let total = 0;
  for (const key of allowed) {
    nonNegativeInteger(value.outcomeCounts[key], `terminalOutcomeResolution.${key}`);
    total += value.outcomeCounts[key];
  }
  if (total !== expectedCorePairs) {
    throw new Error("Terminal outcome resolution counts do not sum to the core denominator.");
  }
  requireObject(value.queueSubdispositions, "terminalOutcomeResolution.queueSubdispositions");
  nonNegativeInteger(
    value.queueSubdispositions.requires_credentials,
    "terminalOutcomeResolution.queueSubdispositions.requires_credentials"
  );
  nonNegativeInteger(
    value.queueSubdispositions.manual_review,
    "terminalOutcomeResolution.queueSubdispositions.manual_review"
  );
  if (value.queueSubdispositions.requires_credentials +
      value.queueSubdispositions.manual_review !==
      value.outcomeCounts.requires_credentials_or_manual_review) {
    throw new Error("Terminal queue subdispositions do not reconcile.");
  }
  requireObject(value.auditProvenance, "terminalOutcomeResolution.auditProvenance");
  requiredSha256(value.pairResolutionSha256, "terminalOutcomeResolution.pairResolutionSha256");
  requiredSha256(
    value.auditProvenance.selectedSignalsSha256,
    "terminalOutcomeResolution.auditProvenance.selectedSignalsSha256"
  );
  requiredSha256(
    value.auditProvenance.discardedSignalsSha256,
    "terminalOutcomeResolution.auditProvenance.discardedSignalsSha256"
  );
}

function validateFullCoverageStatus(status) {
  requireObject(status.denominator, "full coverage denominator");
  requireObject(status.evaluated, "full coverage evaluated");
  requireObject(status.terminalStatusBuckets, "full coverage terminalStatusBuckets");
  requireObject(status.mapping, "full coverage mapping");
  requireObject(status.profiles, "full coverage profiles");
  requireObject(status.posts, "full coverage posts");
  requireObject(status.scope, "full coverage scope");
  requireObject(status.unresolved, "full coverage unresolved");
  requireObject(status.byBatch, "full coverage byBatch");
  requireObject(status.byPlatform, "full coverage byPlatform");
  requireObject(status.byBatchPlatform, "full coverage byBatchPlatform");
  const d = status.denominator;
  for (const field of ["companies", "founders", "entities", "corePlatforms",
    "extendedOnlyPlatforms", "corePairs", "allPairs"]) {
    nonNegativeInteger(d[field], `denominator.${field}`);
  }
  if (d.entities !== d.companies + d.founders) {
    throw new Error("Coverage entity denominator is inconsistent.");
  }
  if (d.corePlatforms !== INGESTION_CORE_PLATFORMS.length ||
      d.extendedOnlyPlatforms !== INGESTION_EXTENDED_ONLY_PLATFORMS.length) {
    throw new Error("Coverage platform denominator does not match the supported matrix.");
  }
  if (d.corePairs !== d.entities * d.corePlatforms ||
      d.allPairs !== d.entities * (d.corePlatforms + d.extendedOnlyPlatforms)) {
    throw new Error("Coverage pair denominator is inconsistent.");
  }
  validateCoverageGroup(status, d.corePairs, "global coverage");
  const batchGroups = Object.entries(status.byBatch);
  const platformGroups = Object.entries(status.byPlatform);
  const batchPlatformGroups = Object.entries(status.byBatchPlatform);
  if (platformGroups.length !== INGESTION_CORE_PLATFORMS.length ||
      new Set(platformGroups.map(([key]) => key)).size !== INGESTION_CORE_PLATFORMS.length ||
      INGESTION_CORE_PLATFORMS.some((platform) => !(platform in status.byPlatform))) {
    throw new Error("Coverage byPlatform does not contain every core platform exactly once.");
  }
  if (batchPlatformGroups.length !== batchGroups.length * INGESTION_CORE_PLATFORMS.length) {
    throw new Error("Coverage byBatchPlatform denominator is incomplete.");
  }
  for (const [key, group] of batchGroups) {
    validateCoverageGroup(group, group.denominator?.pairs, `byBatch.${key}`);
  }
  for (const [key, group] of platformGroups) {
    validateCoverageGroup(group, d.entities, `byPlatform.${key}`);
  }
  for (const [key, group] of batchPlatformGroups) {
    requireObject(group, `byBatchPlatform.${key}`);
    if (`${group.batchSlug}:${group.platform}` !== key) {
      throw new Error(`byBatchPlatform.${key} has a mismatched identity.`);
    }
    if (!INGESTION_CORE_PLATFORMS.includes(group.platform)) {
      throw new Error(`byBatchPlatform.${key} has an unsupported platform.`);
    }
    validateCoverageGroup(group, group.denominator?.pairs, `byBatchPlatform.${key}`);
  }
  if (sum(batchGroups, ([, group]) => group.denominator.pairs) !== d.corePairs ||
      sum(platformGroups, ([, group]) => group.denominator.pairs) !== d.corePairs ||
      sum(batchPlatformGroups, ([, group]) => group.denominator.pairs) !== d.corePairs) {
    throw new Error("Coverage group pair denominators do not partition the core matrix.");
  }
}

function validateCoverageGroup(group, expectedPairs, label) {
  requireObject(group, label);
  requireObject(group.denominator, `${label}.denominator`);
  const pairs = label === "global coverage"
    ? nonNegativeInteger(expectedPairs, `${label}.expectedPairs`)
    : nonNegativeInteger(group.denominator.pairs, `${label}.denominator.pairs`);
  if (label !== "global coverage" && Number.isInteger(expectedPairs) &&
      pairs !== expectedPairs) {
    throw new Error(`${label} pair denominator mismatch.`);
  }
  for (const field of ["companies", "founders", "entities"]) {
    nonNegativeInteger(group.denominator[field], `${label}.denominator.${field}`);
  }
  if (group.denominator.entities !==
      group.denominator.companies + group.denominator.founders) {
    throw new Error(`${label} entity denominator is inconsistent.`);
  }
  requireObject(group.evaluated, `${label}.evaluated`);
  for (const field of ["pairs", "companies", "founders", "entities",
    "resolvedCompanies", "resolvedFounders", "resolvedEntities"]) {
    nonNegativeInteger(group.evaluated[field], `${label}.evaluated.${field}`);
  }
  if (group.evaluated.pairs > pairs ||
      group.evaluated.companies > group.denominator.companies ||
      group.evaluated.founders > group.denominator.founders) {
    throw new Error(`${label} evaluated count exceeds its denominator.`);
  }
  const terminal = group.terminalStatusBuckets;
  requireObject(terminal, `${label}.terminalStatusBuckets`);
  for (const field of ["collected", "verified_no_account", "blocked", "queued"]) {
    nonNegativeInteger(terminal[field], `${label}.terminalStatusBuckets.${field}`);
  }
  if (Object.values(terminal).reduce((total, count) => total + count, 0) !== pairs) {
    throw new Error(`${label} terminal outcomes do not partition the pair denominator.`);
  }
  requireObject(group.mapping, `${label}.mapping`);
  if (nonNegativeInteger(group.mapping.mappedPairs, `${label}.mapping.mappedPairs`) +
      nonNegativeInteger(group.mapping.unmappedPairs, `${label}.mapping.unmappedPairs`) !== pairs) {
    throw new Error(`${label} mapped and unmapped pairs do not reconcile.`);
  }
  requireObject(group.profiles, `${label}.profiles`);
  if (nonNegativeInteger(group.profiles.scraped, `${label}.profiles.scraped`) >
      nonNegativeInteger(group.profiles.mapped, `${label}.profiles.mapped`) ||
      nonNegativeInteger(group.profiles.verifiedScraped,
        `${label}.profiles.verifiedScraped`) >
      nonNegativeInteger(group.profiles.verifiedMapped,
        `${label}.profiles.verifiedMapped`)) {
    throw new Error(`${label} scraped profiles exceed mapped profiles.`);
  }
  requireObject(group.posts, `${label}.posts`);
  for (const field of ["attributedPosts", "recentPosts", "historicalPosts",
    "storedUnpublishedPosts"]) {
    nonNegativeInteger(group.posts[field], `${label}.posts.${field}`);
  }
  if (group.posts.recentPosts + group.posts.historicalPosts !== group.posts.attributedPosts) {
    throw new Error(`${label} recent and historical posts do not reconcile.`);
  }
  requireObject(group.scope, `${label}.scope`);
  for (const field of ["recentBackfillCompletePairs", "historicalBackfillCompletePairs",
    "storedUnpublishedSurfacedPairs", "schedulerCurrentPairs", "integrityVerifiedPairs",
    "objectiveCompletePairs", "matrixResolvedPairs"]) {
    const count = nonNegativeInteger(group.scope[field], `${label}.scope.${field}`);
    if (count > pairs) throw new Error(`${label}.scope.${field} exceeds the denominator.`);
  }
  if (label === "global coverage") {
    if (group.unresolved.pairs !== pairs - group.scope.matrixResolvedPairs) {
      throw new Error("Global unresolved count does not reconcile with matrix resolution.");
    }
    if (group.mapping.verifiedAccounts !== group.profiles.verifiedMapped) {
      throw new Error("Global verified account and verified profile counts diverge.");
    }
  }
}

function validateProductionStatus(status) {
  requireObject(status, "productionReleaseStatus");
  nonNegativeInteger(status.requiredReceiptCount, "requiredReceiptCount");
  nonNegativeInteger(status.verifiedReceiptCount, "verifiedReceiptCount");
  if (status.verifiedReceiptCount > status.requiredReceiptCount) {
    throw new Error("Production verified receipt count exceeds the denominator.");
  }
  if (!Array.isArray(status.blockers) || !Array.isArray(status.nextActions)) {
    throw new TypeError("Production blockers and nextActions must be arrays.");
  }
  if (status.complete === true &&
      (status.verifiedReceiptCount !== status.requiredReceiptCount || status.blockers.length)) {
    throw new Error("Production status claims completion without all required receipts.");
  }
}

function validateHistoricalManifest(manifest) {
  requireObject(manifest, "historical manifest");
  if (manifest.schemaVersion !== HISTORICAL_COMPLETION_MANIFEST_VERSION) {
    throw new Error(
      `Historical manifest schemaVersion must be ${HISTORICAL_COMPLETION_MANIFEST_VERSION}.`
    );
  }
  requiredTimestamp(manifest.generatedAt, "historicalManifest.generatedAt");
  requiredTimestamp(manifest.recencyCutoffAt, "historicalManifest.recencyCutoffAt");
  requireObject(manifest.denominator, "historicalManifest.denominator");
  const evaluated = nonNegativeInteger(
    manifest.denominator.targetsEvaluated,
    "historical targetsEvaluated"
  );
  const complete = nonNegativeInteger(
    manifest.denominator.targetsCompletionEligible,
    "historical targetsCompletionEligible"
  );
  const excluded = nonNegativeInteger(
    manifest.denominator.targetsExcluded,
    "historical targetsExcluded"
  );
  if (complete + excluded !== evaluated) {
    throw new Error("Historical proof denominator is inconsistent.");
  }
  requireObject(manifest.sourceArtifact, "historicalManifest.sourceArtifact");
  requiredSha256(manifest.sourceArtifact.sha256, "historical source sha256");
  nonNegativeInteger(manifest.sourceArtifact.bytes, "historical source bytes");
  requireObject(manifest.artifacts, "historicalManifest.artifacts");
  requireObject(manifest.summary, "historicalManifest.summary");
  validateProofSummary(manifest.summary.byBatch, evaluated, "historical byBatch", "evaluated");
  validateProofSummary(
    manifest.summary.byPlatform,
    evaluated,
    "historical byPlatform",
    "evaluated"
  );
}

function validateRecentManifest(manifest) {
  requireObject(manifest, "recent manifest");
  if (manifest.schemaVersion !== RECENT_COMPLETION_MANIFEST_VERSION) {
    throw new Error(
      `Recent manifest schemaVersion must be ${RECENT_COMPLETION_MANIFEST_VERSION}.`
    );
  }
  requiredTimestamp(manifest.generatedAt, "recentManifest.generatedAt");
  requireObject(manifest.denominator, "recentManifest.denominator");
  const core = nonNegativeInteger(
    manifest.denominator.canonicalCorePairs,
    "recent canonicalCorePairs"
  );
  const complete = nonNegativeInteger(
    manifest.denominator.completionEligiblePairs,
    "recent completionEligiblePairs"
  );
  const excluded = nonNegativeInteger(
    manifest.denominator.excludedPairs,
    "recent excludedPairs"
  );
  if (complete + excluded !== core) throw new Error("Recent proof denominator is inconsistent.");
  requireObject(manifest.sourceCampaign, "recentManifest.sourceCampaign");
  requiredSha256(manifest.sourceCampaign.sha256, "recent source campaign sha256");
  requireObject(manifest.artifacts, "recentManifest.artifacts");
  requireObject(manifest.summary, "recentManifest.summary");
  if (!Array.isArray(manifest.contractChangesRequired)) {
    throw new TypeError("recentManifest.contractChangesRequired must be an array.");
  }
  validateProofSummary(manifest.summary.byBatch, core, "recent byBatch", "canonicalPairs");
  validateProofSummary(
    manifest.summary.byPlatform,
    core,
    "recent byPlatform",
    "canonicalPairs"
  );
}

function validateProofSummary(groups, denominator, label, denominatorField) {
  requireObject(groups, label);
  let total = 0;
  for (const [key, group] of Object.entries(groups)) {
    requireObject(group, `${label}.${key}`);
    const groupDenominator = nonNegativeInteger(
      group[denominatorField],
      `${label}.${key}.${denominatorField}`
    );
    const completed = nonNegativeInteger(
      group.completionEligible ?? group.completionEligiblePairs,
      `${label}.${key}.completionEligible`
    );
    const excluded = nonNegativeInteger(
      group.excluded ?? group.excludedPairs,
      `${label}.${key}.excluded`
    );
    if (completed + excluded !== groupDenominator) {
      throw new Error(`${label}.${key} denominator is inconsistent.`);
    }
    total += groupDenominator;
  }
  if (total !== denominator) {
    throw new Error(`${label} does not partition its proof denominator.`);
  }
}

function validateCampaign(campaign) {
  requireObject(campaign, "campaign manifest");
  if (campaign.schemaVersion !== CAMPAIGN_VERSION) {
    throw new Error(`Campaign schemaVersion must be ${CAMPAIGN_VERSION}.`);
  }
  requiredText(campaign.runId, "campaign.runId");
  requiredTimestamp(campaign.coverageGeneratedAt, "campaign.coverageGeneratedAt");
  requireObject(campaign.artifacts, "campaign.artifacts");
}

function crossValidateProofs({
  projection,
  campaign,
  historicalManifest,
  recentManifest,
  historicalProofDescriptor,
  recentProofDescriptor
}) {
  const status = projection.fullIngestionCoverageStatus;
  if (historicalManifest.generatedAt !== projection.coverageGeneratedAt ||
      recentManifest.generatedAt !== projection.coverageGeneratedAt) {
    throw new Error(
      "Proof manifests and materialization coverage do not share one read timestamp."
    );
  }
  if (historicalManifest.denominator.targetsCompletionEligible !==
      status.scope.historicalBackfillCompletePairs) {
    throw new Error("Historical proof count does not match materialized historical scope.");
  }
  if (recentManifest.denominator.completionEligiblePairs !==
      status.scope.recentBackfillCompletePairs) {
    throw new Error("Recent proof count does not match materialized recent scope.");
  }
  if (recentManifest.denominator.canonicalCorePairs !== status.denominator.corePairs) {
    throw new Error("Recent proof denominator does not match the core coverage matrix.");
  }
  const historicalBackfills = campaign.artifacts.historicalBackfills;
  if (!Array.isArray(historicalBackfills)) {
    throw new TypeError("Campaign historicalBackfills must be an array.");
  }
  const matchingHistorical = historicalBackfills.find((entry) =>
    entry?.completionProofs?.sha256 === historicalProofDescriptor.sha256
  );
  if (!matchingHistorical) {
    throw new Error("Campaign does not bind the supplied historical completion proofs.");
  }
  if (matchingHistorical.journal?.sha256 !== historicalManifest.sourceArtifact.sha256) {
    throw new Error("Historical proof source journal does not match the campaign journal.");
  }
  if (historicalProofDescriptor.rows !==
      historicalManifest.denominator.targetsCompletionEligible ||
      recentProofDescriptor.rows !== recentManifest.denominator.completionEligiblePairs) {
    throw new Error("Proof artifact rows do not match completion-eligible counts.");
  }
}

function summarizeHistoricalProofs(manifest) {
  const d = manifest.denominator;
  return {
    status: manifest.status,
    coveredThrough: manifest.recencyCutoffAt,
    evaluated: d.targetsEvaluated,
    complete: d.targetsCompletionEligible,
    excluded: d.targetsExcluded,
    completionPercent: percent(d.targetsCompletionEligible, d.targetsEvaluated),
    byBatch: mapProofGroups(manifest.summary.byBatch),
    byPlatform: mapProofGroups(manifest.summary.byPlatform),
    exclusionReasons: manifest.summary.exclusionReasons
  };
}

function summarizeRecentProofs(manifest) {
  const d = manifest.denominator;
  return {
    status: manifest.status,
    coveredFrom: manifest.window.coveredFrom,
    coveredThrough: manifest.window.coveredThrough,
    evaluated: d.canonicalCorePairs,
    complete: d.completionEligiblePairs,
    excluded: d.excludedPairs,
    pairsWithNativeAttempts: d.pairsWithNativeAttempts,
    pairsWithoutNativeAttempts: d.pairsWithoutNativeAttempts,
    completionPercent: percent(d.completionEligiblePairs, d.canonicalCorePairs),
    byBatch: mapProofGroups(manifest.summary.byBatch),
    byPlatform: mapProofGroups(manifest.summary.byPlatform),
    exclusionReasons: manifest.summary.exclusionReasons,
    packagingDecision: manifest.packagingDecision,
    contractChangesRequired: manifest.contractChangesRequired
  };
}

function mapProofGroups(groups) {
  return Object.fromEntries(
    Object.entries(groups).map(([key, value]) => [key, proofGroup(value)])
  );
}

function proofGroup(group) {
  if (!group) return null;
  const evaluated = group.evaluated ?? group.canonicalPairs;
  const complete = group.completionEligible ?? group.completionEligiblePairs;
  const excluded = group.excluded ?? group.excludedPairs;
  return {
    evaluated,
    complete,
    excluded,
    completionPercent: percent(complete, evaluated)
  };
}

function projectCoverageGroup(group) {
  if (!group) throw new Error("Coverage group is missing.");
  return {
    denominator: structuredClone(group.denominator),
    evaluated: structuredClone(group.evaluated),
    terminalStatusBuckets: structuredClone(group.terminalStatusBuckets),
    mapping: structuredClone(group.mapping),
    profiles: structuredClone(group.profiles),
    posts: structuredClone(group.posts),
    scope: structuredClone(group.scope),
    unresolvedPairs: group.denominator.pairs - group.scope.matrixResolvedPairs
  };
}

function summarizeMissingScopeProofs(status) {
  const denominator = status.denominator.corePairs;
  const rows = {
    recent: status.scope.recentBackfillCompletePairs,
    historical: status.scope.historicalBackfillCompletePairs,
    storedUnpublished: status.scope.storedUnpublishedSurfacedPairs,
    scheduler: status.scope.schedulerCurrentPairs,
    integrity: status.scope.integrityVerifiedPairs
  };
  return Object.fromEntries(Object.entries(rows).map(([key, complete]) => [key, {
    complete,
    missing: denominator - complete,
    denominator,
    completionPercent: percent(complete, denominator)
  }]));
}

async function readAndVerifyDeclaredJson({ base, descriptor, maxBytes, label }) {
  const path = resolveDeclaredPath(base, descriptor.path, label);
  const file = await readBoundJson(path, maxBytes, label);
  verifyFileDescriptor(file, descriptor, label);
  return { ...file, path };
}

async function hashBoundFile(path, descriptor, label) {
  requireObject(descriptor, `${label} descriptor`);
  requiredSha256(descriptor.sha256, `${label} sha256`);
  const expectedBytes = nonNegativeInteger(descriptor.bytes, `${label} bytes`);
  const fileHash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    fileHash.update(chunk);
    bytes += chunk.length;
  }
  const sha256 = fileHash.digest("hex");
  if (bytes !== expectedBytes) {
    throw new Error(`${label} bytes mismatch: expected ${expectedBytes}, received ${bytes}.`);
  }
  if (sha256 !== descriptor.sha256) {
    throw new Error(
      `${label} sha256 mismatch: expected ${descriptor.sha256}, received ${sha256}.`
    );
  }
  return { path, bytes, sha256 };
}

async function readBoundJson(path, maxBytes, label) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${label} is not a file: ${path}.`);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || info.size > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte safety limit.`);
  }
  const bytes = await readFile(path);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  return {
    path,
    bytes: bytes.length,
    sha256: sha256Bytes(bytes),
    value
  };
}

function verifyFileDescriptor(file, descriptor, label) {
  if (descriptor.bytes !== undefined && file.bytes !== descriptor.bytes) {
    throw new Error(`${label} bytes mismatch: expected ${descriptor.bytes}, received ${file.bytes}.`);
  }
  if (file.sha256 !== descriptor.sha256) {
    throw new Error(
      `${label} sha256 mismatch: expected ${descriptor.sha256}, received ${file.sha256}.`
    );
  }
}

function verifyProofArtifactRows(value, expectedRows, label) {
  const rows = Array.isArray(value) ? value : value?.rows;
  if (!Array.isArray(rows)) throw new TypeError(`${label} must be an array or contain rows.`);
  if (rows.length !== expectedRows) {
    throw new Error(`${label} row mismatch: expected ${expectedRows}, received ${rows.length}.`);
  }
}

function validateHistoricalProofArtifacts({ proofs, exclusions, manifest }) {
  if (!Array.isArray(proofs)) {
    throw new TypeError("historical completion proofs must be an array.");
  }
  const targets = new Set();
  for (const [index, proof] of proofs.entries()) {
    requireObject(proof, `historical proof ${index}`);
    if (proof.proofVersion !== "historical-completion-proof.v1") {
      throw new Error(
        `historical proof ${index}.proofVersion must be historical-completion-proof.v1.`
      );
    }
    if (proof.status !== "complete") {
      throw new Error(`historical proof ${index}.status must be complete.`);
    }
    const targetKey = requiredText(proof.targetKey, `historical proof ${index}.targetKey`);
    if (targets.has(targetKey)) throw new Error(`Duplicate historical proof ${targetKey}.`);
    targets.add(targetKey);
    if (proof.artifactSha256 !== manifest.sourceArtifact.sha256) {
      throw new Error(`historical proof ${targetKey} is not bound to the source journal.`);
    }
    if (proof.coveredThrough !== manifest.recencyCutoffAt) {
      throw new Error(`historical proof ${targetKey} has a mismatched coverage cutoff.`);
    }
    if (!/^historical-[a-f0-9]{40}$/.test(proof.receiptId)) {
      throw new Error(`historical proof ${targetKey} has an invalid receiptId.`);
    }
    requiredTimestamp(proof.checkedAt, `historical proof ${targetKey}.checkedAt`);
    nonNegativeInteger(proof.terminalSequence, `${targetKey}.terminalSequence`);
    nonNegativeInteger(proof.runCompletedSequence, `${targetKey}.runCompletedSequence`);
    if (proof.terminalSequence >= proof.runCompletedSequence) {
      throw new Error(`historical proof ${targetKey} must predate run completion.`);
    }
  }
  requireObject(exclusions, "historical completion exclusions");
  if (exclusions.generatedAt !== manifest.generatedAt) {
    throw new Error("Historical exclusions generatedAt does not match the manifest.");
  }
}

function validateRecentProofArtifacts({ proofs, exclusions, manifest }) {
  if (!Array.isArray(proofs)) {
    throw new TypeError("recent completion proofs must be an array.");
  }
  const pairs = new Set();
  for (const [index, proof] of proofs.entries()) {
    requireObject(proof, `recent proof ${index}`);
    const pairKey = requiredText(proof.pairKey, `recent proof ${index}.pairKey`);
    if (pairs.has(pairKey)) throw new Error(`Duplicate recent proof ${pairKey}.`);
    pairs.add(pairKey);
    requireObject(proof.receipt, `recent proof ${pairKey}.receipt`);
    const checkedAt = requiredTimestamp(
      proof.receipt.checkedAt,
      `recent proof ${pairKey}.receipt.checkedAt`
    );
    if (proof.receipt.status !== "complete" ||
        proof.receipt.coveredFrom !== manifest.window.coveredFrom ||
        proof.receipt.coveredThrough !== manifest.window.coveredThrough ||
        checkedAt < manifest.window.coveredThrough ||
        checkedAt > manifest.generatedAt) {
      throw new Error(`recent proof ${pairKey} does not prove the declared complete window.`);
    }
    if (!/^recent-[a-f0-9]{40}$/.test(proof.receipt.receiptId)) {
      throw new Error(`recent proof ${pairKey} has an invalid receiptId.`);
    }
  }
  requireObject(exclusions, "recent completion exclusions");
  if (exclusions.schemaVersion !== RECENT_COMPLETION_MANIFEST_VERSION ||
      exclusions.campaignSha256 !== manifest.sourceCampaign.sha256 ||
      exclusions.coveredFrom !== manifest.window.coveredFrom ||
      exclusions.coveredThrough !== manifest.window.coveredThrough) {
    throw new Error("Recent exclusions do not match the manifest schema, campaign, and window.");
  }
}

function requiredDescriptor(value, label) {
  requireObject(value, label);
  requiredText(value.path, `${label}.path`);
  requiredSha256(value.sha256, `${label}.sha256`);
  nonNegativeInteger(value.bytes, `${label}.bytes`);
  nonNegativeInteger(value.rows, `${label}.rows`);
  return value;
}

function requiredCampaignDescriptor(value, label) {
  requireObject(value, label);
  requiredText(value.path, `${label}.path`);
  requiredSha256(value.sha256, `${label}.sha256`);
  return value;
}

function resolveDeclaredPath(base, value, label) {
  const text = requiredText(value, `${label} path`);
  if (isAbsolute(text)) throw new Error(`${label} path must be relative.`);
  const absoluteBase = resolve(base);
  const path = resolve(absoluteBase, text);
  const pathRelative = relative(absoluteBase, path);
  if (pathRelative === ".." || pathRelative.startsWith(`..${sep}`) || isAbsolute(pathRelative)) {
    throw new Error(`${label} path escapes its manifest directory.`);
  }
  return path;
}

function resolveInputPath(root, value, label) {
  const text = requiredText(value, label);
  return isAbsolute(text) ? resolve(text) : resolve(root, text);
}

function artifactRecord(root, path, file) {
  return {
    path: portablePath(root, path),
    bytes: file.bytes,
    sha256: file.sha256
  };
}

function portablePath(root, path) {
  const candidate = relative(root, path);
  return candidate && candidate !== ".." && !candidate.startsWith(`..${sep}`) &&
    !isAbsolute(candidate)
    ? candidate.split(sep).join("/")
    : resolve(path);
}

class TopLevelJsonExtractor {
  constructor({ capturedFields, hashedFields, maxCapturedValueBytes }) {
    this.capturedFields = capturedFields;
    this.hashedFields = hashedFields;
    this.maxCapturedValueBytes = maxCapturedValueBytes;
    this.values = {};
    this.valueSha256 = {};
    this.valueBytes = {};
    this.phase = "root";
    this.keyRaw = "";
    this.keyEscaped = false;
    this.currentKey = null;
    this.value = null;
    this.finished = false;
    this.offset = 0;
  }

  feed(text) {
    let index = 0;
    while (index < text.length) {
      if (this.phase === "value" && this.value.hash && !this.value.capture &&
          this.value.kind === "composite") {
        index = this.consumeHashedComposite(text, index);
        continue;
      }
      const character = String.fromCodePoint(text.codePointAt(index));
      this.consume(character);
      this.offset += Buffer.byteLength(character);
      index += character.length;
    }
  }

  finish() {
    if (!this.finished || this.phase !== "done") {
      throw new Error("Materialization JSON ended before the root object was complete.");
    }
    if (!("coverageReceipt" in this.valueSha256)) {
      throw new Error("Materialization is missing coverageReceipt.");
    }
    return {
      values: this.values,
      valueSha256: this.valueSha256,
      valueBytes: this.valueBytes
    };
  }

  consume(character) {
    if (this.phase === "done") {
      if (!isWhitespace(character)) throw this.syntax("Trailing content after root object");
      return;
    }
    if (this.phase === "root") {
      if (isWhitespace(character)) return;
      if (character !== "{") throw this.syntax("Materialization root must be an object");
      this.phase = "key_or_end";
      return;
    }
    if (this.phase === "key_or_end") {
      if (isWhitespace(character)) return;
      if (character === "}") {
        this.phase = "done";
        this.finished = true;
        return;
      }
      if (character !== '"') throw this.syntax("Expected a top-level JSON key");
      this.keyRaw = '"';
      this.keyEscaped = false;
      this.phase = "key";
      return;
    }
    if (this.phase === "key") {
      this.keyRaw += character;
      if (this.keyEscaped) {
        this.keyEscaped = false;
      } else if (character === "\\") {
        this.keyEscaped = true;
      } else if (character === '"') {
        this.currentKey = JSON.parse(this.keyRaw);
        if (this.currentKey in this.values || this.currentKey in this.valueSha256) {
          throw this.syntax(`Duplicate top-level field ${this.currentKey}`);
        }
        this.phase = "colon";
      }
      return;
    }
    if (this.phase === "colon") {
      if (isWhitespace(character)) return;
      if (character !== ":") throw this.syntax("Expected a colon after top-level key");
      this.phase = "value_start";
      return;
    }
    if (this.phase === "value_start") {
      if (isWhitespace(character)) return;
      this.startValue(character);
      return;
    }
    if (this.phase === "value") {
      this.consumeValue(character);
      return;
    }
    if (this.phase === "comma_or_end") {
      if (isWhitespace(character)) return;
      if (character === ",") {
        this.phase = "key_or_end";
        return;
      }
      if (character === "}") {
        this.phase = "done";
        this.finished = true;
        return;
      }
      throw this.syntax("Expected comma or root-object end");
    }
    throw this.syntax(`Unknown parser phase ${this.phase}`);
  }

  startValue(character) {
    const capture = this.capturedFields.has(this.currentKey);
    const hash = this.hashedFields.has(this.currentKey);
    const kind = character === "{" || character === "["
      ? "composite"
      : character === '"'
        ? "string"
        : "primitive";
    this.value = {
      key: this.currentKey,
      capture,
      hash: hash ? createHash("sha256") : null,
      raw: capture ? "" : null,
      bytes: 0,
      kind,
      depth: kind === "composite" ? 1 : 0,
      inString: kind === "string",
      escaped: false
    };
    this.phase = "value";
    this.appendValue(character);
    if (kind === "primitive" && (character === "," || character === "}")) {
      throw this.syntax("Empty primitive value");
    }
  }

  consumeValue(character) {
    const value = this.value;
    if (value.kind === "primitive") {
      if (character === "," || character === "}") {
        this.finalizeValue();
        if (character === ",") this.phase = "key_or_end";
        else {
          this.phase = "done";
          this.finished = true;
        }
        return;
      }
      this.appendValue(character);
      return;
    }
    this.appendValue(character);
    if (value.inString) {
      if (value.escaped) value.escaped = false;
      else if (character === "\\") value.escaped = true;
      else if (character === '"') {
        value.inString = false;
        if (value.kind === "string") this.finalizeValue();
      }
      return;
    }
    if (character === '"') {
      value.inString = true;
      return;
    }
    if (character === "{" || character === "[") value.depth += 1;
    else if (character === "}" || character === "]") {
      value.depth -= 1;
      if (value.depth < 0) throw this.syntax("Unbalanced JSON value");
      if (value.depth === 0) this.finalizeValue();
    }
  }

  consumeHashedComposite(text, startIndex) {
    const value = this.value;
    let index = startIndex;
    while (index < text.length) {
      if (value.inString) {
        if (value.escaped) {
          value.escaped = false;
          index += 1;
          continue;
        }
        JSON_INSIDE_STRING_TOKEN.lastIndex = index;
        const match = JSON_INSIDE_STRING_TOKEN.exec(text);
        if (!match) {
          this.appendHashedSegment(text.slice(startIndex));
          return text.length;
        }
        index = match.index + 1;
        if (match[0] === "\\") {
          if (index >= text.length) value.escaped = true;
          else index += 1;
        } else {
          value.inString = false;
        }
        continue;
      }
      JSON_OUTSIDE_STRING_TOKEN.lastIndex = index;
      const match = JSON_OUTSIDE_STRING_TOKEN.exec(text);
      if (!match) {
        this.appendHashedSegment(text.slice(startIndex));
        return text.length;
      }
      index = match.index + 1;
      if (match[0] === '"') value.inString = true;
      else if (match[0] === "{" || match[0] === "[") value.depth += 1;
      else {
        value.depth -= 1;
        if (value.depth < 0) throw this.syntax("Unbalanced JSON value");
        if (value.depth === 0) {
          this.appendHashedSegment(text.slice(startIndex, index));
          this.finalizeValue();
          return index;
        }
      }
    }
    this.appendHashedSegment(text.slice(startIndex));
    return text.length;
  }

  appendHashedSegment(segment) {
    if (!segment) return;
    const bytes = Buffer.byteLength(segment);
    this.value.bytes += bytes;
    this.value.hash.update(segment);
    this.offset += bytes;
  }

  appendValue(character) {
    const bytes = Buffer.byteLength(character);
    this.value.bytes += bytes;
    if (this.value.capture) {
      if (this.value.bytes > this.maxCapturedValueBytes) {
        throw new Error(
          `Materialization field ${this.value.key} exceeds the ` +
          `${this.maxCapturedValueBytes}-byte capture limit.`
        );
      }
      this.value.raw += character;
    }
    if (this.value.hash) this.value.hash.update(character);
  }

  finalizeValue() {
    const value = this.value;
    if (value.capture) {
      try {
        this.values[value.key] = JSON.parse(value.raw);
      } catch (error) {
        throw new Error(`Materialization field ${value.key} is invalid JSON: ${error.message}`);
      }
    }
    if (value.hash) this.valueSha256[value.key] = value.hash.digest("hex");
    this.valueBytes[value.key] = value.bytes;
    this.value = null;
    this.currentKey = null;
    this.phase = "comma_or_end";
  }

  syntax(message) {
    return new Error(`${message} near materialization byte ${this.offset}.`);
  }
}

function coverageTableRow(row, mode) {
  const label = mode === "batch" ? row.batchSlug : row.platform;
  const recent = row.recentProof ? ratio(row.recentProof.complete, row.recentProof.evaluated) : "n/a";
  const historical = row.historicalProof
    ? ratio(row.historicalProof.complete, row.historicalProof.evaluated)
    : "n/a";
  if (mode === "batch") {
    return `| ${escapeMd(label)} | ` +
      `${ratio(row.evaluated.companies, row.denominator.companies)} | ` +
      `${ratio(row.evaluated.founders, row.denominator.founders)} | ` +
      `${ratio(row.evaluated.pairs, row.denominator.pairs)} | ` +
      `${ratio(row.mapping.mappedPairs, row.denominator.pairs)} | ` +
      `${formatInt(row.mapping.verifiedAccounts)} | ${ratio(row.profiles.scraped, row.profiles.mapped)} | ` +
      `${formatInt(row.posts.recentPosts)} | ${formatInt(row.posts.historicalPosts)} | ` +
      `${formatInt(row.unresolvedPairs)} | ${recent} | ${historical} |`;
  }
  return `| ${escapeMd(label)} | ${ratio(row.evaluated.pairs, row.denominator.pairs)} | ` +
    `${ratio(row.mapping.mappedPairs, row.denominator.pairs)} | ` +
    `${formatInt(row.mapping.verifiedAccounts)} | ${ratio(row.profiles.scraped, row.profiles.mapped)} | ` +
    `${formatInt(row.posts.recentPosts)} | ${formatInt(row.posts.historicalPosts)} | ` +
    `${formatInt(row.terminalStatusBuckets.collected)} | ` +
    `${formatInt(row.terminalStatusBuckets.blocked)} | ` +
    `${formatInt(row.terminalStatusBuckets.queued)} | ${formatInt(row.unresolvedPairs)} | ` +
    `${recent} | ${historical} |`;
}

function metricRow(label, numerator, denominator) {
  return `| ${escapeMd(label)} | ${formatInt(numerator)} | ${formatInt(denominator)} | ` +
    `${formatPercent(percent(numerator, denominator))} |`;
}

function bulletSection(label, values) {
  if (!values.length) return [`- ${label}: none.`];
  return values.map((value) => `- ${label}: ${escapeMd(value)}`);
}

function reasonCounts(value) {
  const entries = Object.entries(value ?? {});
  return entries.length
    ? entries.map(([key, count]) => `${escapeMd(key)}=${formatInt(count)}`).join(", ")
    : "none";
}

function ratio(numerator, denominator) {
  return `${formatInt(numerator)}/${formatInt(denominator)} (${formatPercent(percent(numerator, denominator))})`;
}

function formatPercent(value) {
  return `${Number(value ?? 0).toFixed(2)}%`;
}

function formatInt(value) {
  return Number(value ?? 0).toLocaleString("en-US");
}

function escapeMd(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function percent(numerator, denominator) {
  return denominator ? Number(((numerator / denominator) * 100).toFixed(2)) : 0;
}

function sum(entries, mapper) {
  return entries.reduce((total, entry) => total + mapper(entry), 0);
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => requiredText(value, "next action")))];
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}

function requiredSha256(value, label) {
  const text = requiredText(value, label).toLowerCase();
  if (!SHA256.test(text)) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  return text;
}

function requiredTimestamp(value, label) {
  const text = requiredText(value, label);
  if (!ISO_TIMESTAMP.test(text) || new Date(text).toISOString() !== text) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return text;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function sha256Stable(value) {
  return sha256Bytes(stableJson(value));
}

function sha256Bytes(value) {
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

function isWhitespace(value) {
  return value === " " || value === "\n" || value === "\r" || value === "\t";
}
