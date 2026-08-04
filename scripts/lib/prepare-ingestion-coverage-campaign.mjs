import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import {
  AUTONOMOUS_BATCHES,
  buildAutonomousTaskPlan,
  loadAutonomousCatalogs,
  summarizeAutonomousCollectorTerminalTaskCoverage,
  validateAutonomousCollectorReferentialIntegrity,
  validateAutonomousCollectorSnapshot
} from "./autonomous-ingestion-plan.mjs";
import {
  normalizeAutonomousIngestionCatalogs
} from "./ingestion-coverage-adapter.mjs";
import {
  INGESTION_CORE_PLATFORMS,
  INGESTION_EXTENDED_ONLY_PLATFORMS,
  INGESTION_CATALOG_MANIFEST_VERSION
} from "./ingestion-coverage-receipt.mjs";
import {
  INGESTION_COVERAGE_CAMPAIGN_VERSION
} from "./ingestion-coverage-campaign.mjs";

export const INGESTION_COVERAGE_CAMPAIGN_PREPARER_VERSION =
  "ingestion-coverage-campaign-preparer.v1";
export const PREPARED_CAMPAIGN_MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const PAIR_SCOPE_PLATFORMS = Object.freeze([
  ...INGESTION_CORE_PLATFORMS,
  ...INGESTION_EXTENDED_ONLY_PLATFORMS
]);
const PAIR_SCOPE_PLATFORM_SET = new Set(PAIR_SCOPE_PLATFORMS);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

// These names/counts are the exact durable files written by the autonomous
// runner. Tests bind this table to the runner contract so configuration drift
// fails before a production campaign is packaged.
export const AUTONOMOUS_COVERAGE_BATCH_LAYOUT = Object.freeze([
  Object.freeze({ slug: "S2026", publicShards: 4, githubShards: 4 }),
  Object.freeze({ slug: "S26", publicShards: 2, githubShards: 2 }),
  Object.freeze({ slug: "A16ZSR006", publicShards: 1, githubShards: 1 })
]);

/**
 * Package exact, explicitly named autonomous campaign files for the measured
 * coverage CLI. No directory scan, row count, or mtime can establish success.
 */
export async function prepareIngestionCoverageCampaign({
  root = process.cwd(),
  campaignDir,
  outputDir,
  idempotencyKey,
  campaignKey,
  batchSlugs,
  materializedAt,
  historicalJournalPath = null,
  historicalCompletionProofsPath = null,
  historicalDepthJournalPath = null,
  historicalDepthCompletionProofsPath = null,
  pairScopesPath = null,
  maxArtifactBytes = PREPARED_CAMPAIGN_MAX_ARTIFACT_BYTES,
  catalogs: suppliedCatalogs = null,
  batchLayout = AUTONOMOUS_COVERAGE_BATCH_LAYOUT
} = {}) {
  const normalizedIdempotencyKey = requiredText(idempotencyKey, "idempotencyKey");
  const normalizedCampaignKey = requiredText(campaignKey, "campaignKey");
  const normalizedMaterializedAt = canonicalTimestamp(materializedAt, "materializedAt");
  validateByteLimit(maxArtifactBytes, "maxArtifactBytes");
  const rootPath = await realpath(resolve(root));
  const campaignPath = await realpath(resolve(requiredText(campaignDir, "campaignDir")));
  const campaignStat = await stat(campaignPath);
  if (!campaignStat.isDirectory()) throw new TypeError("campaignDir must be a directory.");
  const outputPath = resolve(requiredText(outputDir, "outputDir"));
  if (outputPath === campaignPath) throw new Error("outputDir must not replace campaignDir.");
  await assertPathDoesNotExist(outputPath, "outputDir");

  const selectedLayouts = selectBatchLayouts(batchSlugs, batchLayout);
  const loadedCatalogs = suppliedCatalogs ?? await loadAutonomousCatalogs(rootPath);
  const selectedCatalogs = selectCatalogs(loadedCatalogs, selectedLayouts);
  const normalizedCatalogs = normalizeAutonomousIngestionCatalogs(selectedCatalogs);
  const expectedCatalogManifest = expectedManifestFor(normalizedCatalogs);
  const taskPlan = buildAutonomousTaskPlan(selectedCatalogs, {
    runKey: normalizedIdempotencyKey
  });
  if (taskPlan.length === 0) throw new Error("Canonical task plan must not be empty.");

  const temporaryPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(temporaryPath, { recursive: false });
  try {
    const descriptors = {
      collectors: [],
      supporting: []
    };
    const timeline = [];
    const collectionResults = [];

    const catalogsDescriptor = await writeGeneratedArtifact({
      packageRoot: temporaryPath,
      path: "generated/catalogs.json",
      body: `${stableJson(selectedCatalogs)}\n`,
      observedAt: normalizedMaterializedAt,
      format: "json"
    });
    const expectedDescriptor = await writeGeneratedArtifact({
      packageRoot: temporaryPath,
      path: "generated/expected-catalog-manifest.json",
      body: `${stableJson(expectedCatalogManifest)}\n`,
      observedAt: normalizedMaterializedAt,
      format: "json"
    });
    const taskPlanDescriptor = await writeGeneratedArtifact({
      packageRoot: temporaryPath,
      path: "generated/task-plan.ndjson",
      body: taskPlan.map((row) => stableJson(row)).join("\n") + "\n",
      observedAt: normalizedMaterializedAt,
      format: "ndjson"
    });

    await copyCatalogSources({
      rootPath,
      packageRoot: temporaryPath,
      selectedCatalogs,
      selectedLayouts,
      descriptors,
      observedAt: normalizedMaterializedAt,
      maxArtifactBytes
    });

    for (const layout of selectedLayouts) {
      const catalog = selectedCatalogs.find((candidate) => candidate.slug === layout.slug);
      const batchTasks = taskPlan.filter((task) => task.batchSlug === layout.slug);
      const batchKey = layout.slug.toLowerCase();
      const publicResult = await packageCollectorLane({
        kind: "public",
        batchSlug: layout.slug,
        mergedRelativePath: `public-${batchKey}.json`,
        shardRelativePaths: Array.from({ length: layout.publicShards }, (_, index) =>
          `public-${batchKey}-shard-${index}-of-${layout.publicShards}.json`
        ),
        checkpointRelativePaths: Array.from({ length: layout.publicShards }, (_, index) =>
          `checkpoint-public-${batchKey}-shard-${index}-of-${layout.publicShards}.json`
        ),
        campaignPath,
        packageRoot: temporaryPath,
        catalog,
        tasks: batchTasks,
        maxArtifactBytes
      });
      descriptors.collectors.push(publicResult.collector);
      descriptors.supporting.push(...publicResult.supporting);
      timeline.push(...publicResult.timeline);
      collectionResults.push(publicResult.collectionResult);

      const githubResult = await packageCollectorLane({
        kind: "github",
        batchSlug: layout.slug,
        mergedRelativePath: `github-${batchKey}.json`,
        shardRelativePaths: Array.from({ length: layout.githubShards }, (_, index) =>
          `github-${batchKey}-shard-${index}-of-${layout.githubShards}.json`
        ),
        checkpointRelativePaths: [],
        expectedSourcePath: catalog.githubSourcePath,
        campaignPath,
        packageRoot: temporaryPath,
        catalog,
        tasks: batchTasks,
        maxArtifactBytes
      });
      descriptors.collectors.push(githubResult.collector);
      descriptors.supporting.push(...githubResult.supporting);
      timeline.push(...githubResult.timeline);
      collectionResults.push(githubResult.collectionResult);
    }

    let historicalBackfill = null;
    if (historicalCompletionProofsPath && !historicalJournalPath) {
      throw new Error("historicalCompletionProofsPath requires historicalJournalPath.");
    }
    if (historicalJournalPath) {
      historicalBackfill = await packageHistoricalJournal({
        journalPath: historicalJournalPath,
        completionProofsPath: historicalCompletionProofsPath,
        packageRoot: temporaryPath,
        materializedAt: normalizedMaterializedAt,
        maxArtifactBytes
      });
      timeline.push(...historicalBackfill.timeline);
      descriptors.supporting.push(...historicalBackfill.supporting);
    }
    let historicalDepthBackfill = null;
    if (historicalDepthCompletionProofsPath && !historicalDepthJournalPath) {
      throw new Error(
        "historicalDepthCompletionProofsPath requires historicalDepthJournalPath."
      );
    }
    if (historicalDepthJournalPath) {
      historicalDepthBackfill = await packageHistoricalJournal({
        journalPath: historicalDepthJournalPath,
        completionProofsPath: historicalDepthCompletionProofsPath,
        packageRoot: temporaryPath,
        materializedAt: normalizedMaterializedAt,
        maxArtifactBytes,
        label: "Historical-depth",
        packageDirectory: "historical-depth"
      });
      timeline.push(...historicalDepthBackfill.timeline);
      descriptors.supporting.push(...historicalDepthBackfill.supporting);
    }
    let pairScopes = null;
    if (pairScopesPath) {
      pairScopes = await packagePairScopes({
        pairScopesPath,
        packageRoot: temporaryPath,
        materializedAt: normalizedMaterializedAt,
        maxArtifactBytes,
        normalizedCatalogs
      });
      timeline.push(...pairScopes.timeline);
    }

    const runTiming = deriveRunTiming(timeline);
    const recentCoverageCutoff = resolveRecentCoverageCutoff(
      collectionResults,
      runTiming
    );
    if (Date.parse(normalizedMaterializedAt) < Date.parse(runTiming.completedAt)) {
      throw new Error("materializedAt cannot predate the latest exact campaign observation.");
    }
    if (
      pairScopes &&
      Date.parse(pairScopes.minimumCoveredThrough) < Date.parse(runTiming.completedAt)
    ) {
      throw new Error(
        "Complete stored-unpublished pair scopes must cover through the latest exact campaign observation."
      );
    }
    if (historicalBackfill) {
      await validatePackagedHistoricalBridge({
        historicalBackfill,
        generatedAt: runTiming.completedAt
      });
    }
    if (historicalDepthBackfill) {
      await validatePackagedHistoricalDepthBridge({
        historicalDepthBackfill,
        catalogs: selectedCatalogs,
        generatedAt: runTiming.completedAt
      });
    }

    const runnerEvents = buildRunnerEvents({
      runTiming,
      collectionResults,
      idempotencyKey: normalizedIdempotencyKey,
      campaignKey: normalizedCampaignKey
    });
    const runnerLogDescriptor = await writeGeneratedArtifact({
      packageRoot: temporaryPath,
      path: "generated/runner-events.ndjson",
      body: runnerEvents.map((row) => stableJson(row)).join("\n") + "\n",
      observedAt: runTiming.completedAt,
      format: "ndjson"
    });

    const manifest = {
      schemaVersion: INGESTION_COVERAGE_CAMPAIGN_VERSION,
      preparerVersion: INGESTION_COVERAGE_CAMPAIGN_PREPARER_VERSION,
      runId: normalizedIdempotencyKey,
      idempotencyKey: normalizedIdempotencyKey,
      campaignKey: normalizedCampaignKey,
      generatedAt: normalizedMaterializedAt,
      coverageGeneratedAt: runTiming.completedAt,
      recentCoverageCutoff,
      manifestObservedAt: normalizedMaterializedAt,
      batches: selectedLayouts.map((layout) => layout.slug),
      artifacts: {
        catalogs: catalogsDescriptor,
        expectedCatalogManifest: expectedDescriptor,
        taskPlan: taskPlanDescriptor,
        runnerLog: runnerLogDescriptor,
        collectors: descriptors.collectors,
        supporting: descriptors.supporting,
        ...(historicalBackfill ? {
          historicalBackfills: [{
            journal: historicalBackfill.journal,
            ...(historicalBackfill.completionProofs
              ? { completionProofs: historicalBackfill.completionProofs }
              : {})
          }]
        } : {}),
        ...(historicalDepthBackfill ? {
          historicalDepthBackfills: [{
            journal: historicalDepthBackfill.journal,
            ...(historicalDepthBackfill.completionProofs
              ? { completionProofs: historicalDepthBackfill.completionProofs }
              : {})
          }]
        } : {}),
        ...(pairScopes ? { pairScopes: pairScopes.descriptor } : {})
      }
    };
    const manifestPath = join(temporaryPath, "campaign.json");
    await writeFile(manifestPath, `${stableJson(manifest)}\n`, { mode: 0o600 });
    await rename(temporaryPath, outputPath);
    return {
      schemaVersion: INGESTION_COVERAGE_CAMPAIGN_PREPARER_VERSION,
      outputDir: outputPath,
      manifestPath: join(outputPath, "campaign.json"),
      batches: manifest.batches,
      tasks: taskPlan.length,
      collectors: descriptors.collectors.length,
      supportingArtifacts: descriptors.supporting.length,
      historicalIncluded: Boolean(historicalBackfill),
      historicalDepthIncluded: Boolean(historicalDepthBackfill),
      pairScopesIncluded: Boolean(pairScopes),
      pairScopes: pairScopes?.count ?? 0,
      coverageGeneratedAt: runTiming.completedAt,
      recentCoverageCutoff,
      materializedAt: normalizedMaterializedAt,
      collectionResults
    };
  } catch (error) {
    await rm(temporaryPath, { recursive: true, force: true });
    throw error;
  }
}

async function packageCollectorLane({
  kind,
  batchSlug,
  mergedRelativePath,
  shardRelativePaths,
  checkpointRelativePaths,
  expectedSourcePath = null,
  campaignPath,
  packageRoot,
  catalog,
  tasks,
  maxArtifactBytes
}) {
  const mergedSource = await readCampaignJson(
    campaignPath,
    mergedRelativePath,
    maxArtifactBytes
  );
  validateAutonomousCollectorSnapshot(mergedSource.value, {
    kind,
    batchSlug,
    expectedSourcePath
  });
  validateAutonomousCollectorReferentialIntegrity(mergedSource.value, {
    kind,
    batchSlug,
    catalog
  });
  const mergedAttempts = indexDatedAttempts(mergedSource.value, {
    batchSlug,
    label: `${kind} ${batchSlug} merged output`,
    requireNonEmpty: true
  });
  const mergedObservation = collectorObservation(mergedSource.value, mergedAttempts, {
    label: `${kind} ${batchSlug} merged output`
  });
  const recentCoverageCutoff = kind === "public"
    ? optionalCanonicalTimestamp(
        mergedSource.value?.source?.recentCoverageCutoff,
        `${kind} ${batchSlug} merged output.source.recentCoverageCutoff`
      )
    : null;
  if (recentCoverageCutoff) {
    validateRecentWindowAttemptCutoff(mergedAttempts, recentCoverageCutoff, {
      label: `${kind} ${batchSlug} merged output`
    });
  }
  const recentWindowJournals = await packageRecentWindowRequestJournals({
    snapshot: mergedSource.value,
    campaignPath,
    packageRoot,
    maxArtifactBytes,
    kind,
    batchSlug
  });
  const collectorCopy = await writeCopiedArtifact({
    packageRoot,
    path: `collectors/${kind}-${batchSlug.toLowerCase()}.json`,
    bytes: mergedSource.bytes,
    observedAt: mergedObservation.observedAt,
    format: "json"
  });
  const collector = { kind, ...collectorCopy };
  const supporting = [...recentWindowJournals];
  const timeline = [...mergedObservation.timeline];

  for (let index = 0; index < shardRelativePaths.length; index += 1) {
    const source = await readCampaignJson(
      campaignPath,
      shardRelativePaths[index],
      maxArtifactBytes
    );
    validateAutonomousCollectorSnapshot(source.value, {
      kind,
      batchSlug,
      expectedSourcePath
    });
    validateAutonomousCollectorReferentialIntegrity(source.value, {
      kind,
      batchSlug,
      catalog
    });
    const attempts = indexDatedAttempts(source.value, {
      batchSlug,
      label: `${kind} ${batchSlug} shard ${index}`,
      requireNonEmpty: true
    });
    validateAttemptSuperset(mergedAttempts, attempts, {
      label: `${kind} ${batchSlug} shard ${index}`
    });
    const observation = collectorObservation(source.value, attempts, {
      label: `${kind} ${batchSlug} shard ${index}`
    });
    if (kind === "public") {
      const shardCutoff = optionalCanonicalTimestamp(
        source.value?.source?.recentCoverageCutoff,
        `${kind} ${batchSlug} shard ${index}.source.recentCoverageCutoff`
      );
      if (shardCutoff !== recentCoverageCutoff) {
        throw new Error(
          `${kind} ${batchSlug} shard ${index} does not preserve the merged immutable recent coverage cutoff.`
        );
      }
      if (shardCutoff) {
        validateRecentWindowAttemptCutoff(attempts, shardCutoff, {
          label: `${kind} ${batchSlug} shard ${index}`
        });
      }
    }
    timeline.push(...observation.timeline);
    supporting.push({
      kind: `${kind}_${batchSlug.toLowerCase()}_shard_${index}`,
      ...await writeCopiedArtifact({
        packageRoot,
        path: `supporting/${kind}-${batchSlug.toLowerCase()}-shard-${index}.json`,
        bytes: source.bytes,
        observedAt: observation.observedAt,
        format: "json"
      })
    });
  }

  for (let index = 0; index < checkpointRelativePaths.length; index += 1) {
    const checkpoint = await readCampaignJson(
      campaignPath,
      checkpointRelativePaths[index],
      maxArtifactBytes
    );
    validatePublicCheckpoint(checkpoint.value, `${batchSlug} public checkpoint ${index}`);
    const attempts = indexDatedAttempts(checkpoint.value, {
      batchSlug,
      label: `public ${batchSlug} checkpoint ${index}`,
      requireNonEmpty: true
    });
    validateAttemptSuperset(mergedAttempts, attempts, {
      label: `public ${batchSlug} checkpoint ${index}`
    });
    const observation = collectorObservation(checkpoint.value, attempts, {
      label: `public ${batchSlug} checkpoint ${index}`,
      sourceTimestampRequired: false
    });
    timeline.push(...observation.timeline);
    supporting.push({
      kind: `public_${batchSlug.toLowerCase()}_checkpoint_${index}`,
      ...await writeCopiedArtifact({
        packageRoot,
        path: `supporting/public-${batchSlug.toLowerCase()}-checkpoint-${index}.json`,
        bytes: checkpoint.bytes,
        observedAt: observation.observedAt,
        format: "json"
      })
    });
  }

  const terminalCoverage = summarizeAutonomousCollectorTerminalTaskCoverage(
    mergedSource.value,
    { kind, batchSlug, tasks }
  );
  const ok = terminalCoverage.nonTerminal === 0;
  const error = ok ? null : exactNonTerminalReason(kind, batchSlug, terminalCoverage);
  return {
    collector,
    supporting,
    timeline,
    collectionResult: {
      kind,
      batchSlug,
      ...(recentCoverageCutoff ? { recentCoverageCutoff } : {}),
      ok,
      terminalCoverage,
      error
    }
  };
}

function resolveRecentCoverageCutoff(collectionResults, runTiming) {
  const publicResults = collectionResults.filter((result) => result.kind === "public");
  const declared = publicResults
    .map((result) => result.recentCoverageCutoff)
    .filter(Boolean);
  if (declared.length === 0) {
    // Legacy fixture compatibility only. Production public collectors emitted
    // by the autonomous runner always pin the explicit cutoff before requests.
    return runTiming.startedAt;
  }
  if (declared.length !== publicResults.length || new Set(declared).size !== 1) {
    throw new Error(
      "Public collector outputs must preserve one immutable recent coverage cutoff across every batch."
    );
  }
  const cutoff = declared[0];
  if (cutoff > runTiming.startedAt) {
    throw new Error(
      "recentCoverageCutoff must be pinned no later than the first campaign request."
    );
  }
  return cutoff;
}

function validateRecentWindowAttemptCutoff(attempts, cutoff, { label }) {
  for (const { attempt, attemptKey, startedAt, checkedAt } of attempts.values()) {
    if (!["instagram", "hacker_news"].includes(clean(attempt.platform))) continue;
    if (attempt.recentWindowCoverageCutoff !== cutoff) {
      throw new Error(
        `${label} ${attemptKey} does not bind its recent-window outcome to ${cutoff}.`
      );
    }
    if (startedAt < cutoff || checkedAt < cutoff) {
      throw new Error(`${label} ${attemptKey} predates recentCoverageCutoff.`);
    }
    const proof = attempt.recentWindowProof;
    const blocker = clean(attempt.recentWindowProofBlocker);
    if (!proof && !blocker) {
      throw new Error(
        `${label} ${attemptKey} has neither an exhaustive proof nor an explicit recent-window blocker.`
      );
    }
    if (proof) {
      assertObject(proof, `${label} ${attemptKey}.recentWindowProof`);
      if (
        proof.coveredThrough !== cutoff ||
        proof.checkedAt !== checkedAt ||
        proof.status !== "complete"
      ) {
        throw new Error(
          `${label} ${attemptKey} recent-window proof does not reconcile with the immutable cutoff and attempt timing.`
        );
      }
    }
  }
}

async function packageRecentWindowRequestJournals({
  snapshot,
  campaignPath,
  packageRoot,
  maxArtifactBytes,
  kind,
  batchSlug
}) {
  const descriptors = new Map();
  for (const [storedKey, attempt] of Object.entries(snapshot?.attempts ?? {})) {
    const proof = attempt?.recentWindowProof;
    if (!proof) continue;
    if (proof.schemaVersion !== "recent-native-window-proof.v1" || proof.status !== "complete") {
      throw new Error(`${kind} ${batchSlug} attempt ${storedKey} has an incompatible recent-window proof.`);
    }
    const journal = proof.requestJournal;
    assertObject(journal, `${kind} ${batchSlug} attempt ${storedKey}.requestJournal`);
    const path = requiredText(
      journal.path,
      `${kind} ${batchSlug} attempt ${storedKey}.requestJournal.path`
    );
    if (!path.startsWith("recent-window-journals/")) {
      throw new Error(
        `${kind} ${batchSlug} attempt ${storedKey} request journal must be under recent-window-journals/.`
      );
    }
    const sha256 = requiredText(
      journal.sha256,
      `${kind} ${batchSlug} attempt ${storedKey}.requestJournal.sha256`
    );
    if (!SHA256_PATTERN.test(sha256)) {
      throw new TypeError(
        `${kind} ${batchSlug} attempt ${storedKey} request journal sha256 is invalid.`
      );
    }
    const observedAt = canonicalTimestamp(
      journal.observedAt,
      `${kind} ${batchSlug} attempt ${storedKey}.requestJournal.observedAt`
    );
    if (observedAt !== canonicalTimestamp(
      proof.checkedAt,
      `${kind} ${batchSlug} attempt ${storedKey}.recentWindowProof.checkedAt`
    )) {
      throw new Error(`${kind} ${batchSlug} attempt ${storedKey} journal observation is stale.`);
    }
    const existing = descriptors.get(path);
    if (existing && (existing.sha256 !== sha256 || existing.observedAt !== observedAt)) {
      throw new Error(`${kind} ${batchSlug} reuses recent-window journal ${path} inconsistently.`);
    }
    descriptors.set(path, { path, sha256, observedAt });
  }

  const supporting = [];
  for (const descriptor of [...descriptors.values()].sort((left, right) =>
    left.path.localeCompare(right.path)
  )) {
    const sourcePath = await resolveInside(campaignPath, descriptor.path);
    const source = await readBoundedFile(
      sourcePath,
      maxArtifactBytes,
      `${kind} ${batchSlug} recent-window journal ${descriptor.path}`
    );
    if (sha256(source.bytes) !== descriptor.sha256) {
      throw new Error(
        `${kind} ${batchSlug} recent-window journal ${descriptor.path} sha256 mismatch.`
      );
    }
    supporting.push({
      kind: `${kind}_${batchSlug.toLowerCase()}_recent_window_journal`,
      ...await writeCopiedArtifact({
        packageRoot,
        path: descriptor.path,
        bytes: source.bytes,
        observedAt: descriptor.observedAt,
        format: "ndjson"
      })
    });
  }
  return supporting;
}

async function packageHistoricalJournal({
  journalPath,
  completionProofsPath,
  packageRoot,
  materializedAt,
  maxArtifactBytes,
  label = "Historical",
  packageDirectory = "historical"
}) {
  const journalSource = await readExplicitFile(
    journalPath,
    maxArtifactBytes,
    `${label} journal`
  );
  const inspection = await inspectCompletedHistoricalJournal(journalSource.path, label);
  if (Date.parse(inspection.completedAt) > Date.parse(materializedAt)) {
    throw new Error(`${label} journal completion cannot exceed materializedAt.`);
  }
  const journal = await writeCopiedArtifact({
    packageRoot,
    path: `${packageDirectory}/pages.ndjson`,
    bytes: journalSource.bytes,
    observedAt: inspection.completedAt,
    format: "ndjson"
  });
  let completionProofs = null;
  let completionProofValues = [];
  const supporting = [];
  if (completionProofsPath) {
    const proofSource = await readExplicitFile(
      completionProofsPath,
      maxArtifactBytes,
      `${label} completion proofs`
    );
    const proofs = parseJson(proofSource.bytes, `${label} completion proofs`);
    if (!Array.isArray(proofs)) {
      throw new TypeError(`${label} completion proofs must contain a JSON array.`);
    }
    completionProofValues = proofs;
    completionProofs = await writeCopiedArtifact({
      packageRoot,
      path: `${packageDirectory}/completion-proofs.json`,
      bytes: proofSource.bytes,
      observedAt: materializedAt,
      format: "json"
    });
  }
  return {
    journal,
    journalAbsolutePath: join(packageRoot, journal.path),
    completionProofs,
    completionProofValues,
    timeline: [
      { kind: `${label}_started`, timestamp: inspection.startedAt },
      { kind: `${label}_completed`, timestamp: inspection.completedAt }
    ],
    supporting
  };
}

async function packagePairScopes({
  pairScopesPath,
  packageRoot,
  materializedAt,
  maxArtifactBytes,
  normalizedCatalogs
}) {
  const source = await readExplicitFile(
    pairScopesPath,
    maxArtifactBytes,
    "pair scopes"
  );
  const values = parseJson(source.bytes, "pair scopes");
  if (!Array.isArray(values)) {
    throw new TypeError("pair scopes must contain a JSON array.");
  }
  const expected = expectedPairScopeKeys(normalizedCatalogs);
  if (values.length !== expected.size) {
    throw new Error(
      `pair scopes must cover the exact canonical matrix; received ${values.length}/` +
      `${expected.size} rows.`
    );
  }
  const receiptIds = new Set();
  const sourceProofs = new Set();
  let earliestCheckedAt = null;
  let latestCheckedAt = null;
  let minimumCoveredThrough = null;
  let totalAttributedRows = 0;
  for (let index = 0; index < values.length; index += 1) {
    const row = values[index];
    assertObject(row, `pair scopes[${index}]`);
    const batchSlug = requiredText(row.batchSlug, `pair scopes[${index}].batchSlug`);
    const entityType = requiredText(
      row.entityType,
      `pair scopes[${index}].entityType`
    );
    if (!["company", "founder"].includes(entityType)) {
      throw new Error(`pair scopes[${index}].entityType must be company or founder.`);
    }
    const entityId = requiredText(row.entityId, `pair scopes[${index}].entityId`);
    const platform = requiredText(row.platform, `pair scopes[${index}].platform`);
    if (!PAIR_SCOPE_PLATFORM_SET.has(platform)) {
      throw new Error(`pair scopes[${index}] has unsupported platform ${platform}.`);
    }
    const pairKey = `${batchSlug}:${entityType}:${entityId}:${platform}`;
    if (row.pairKey !== pairKey) {
      throw new Error(`pair scopes[${index}].pairKey must equal ${pairKey}.`);
    }
    if (!expected.delete(pairKey)) {
      throw new Error(`pair scopes contains an unknown or duplicate pair ${pairKey}.`);
    }
    assertObject(row.scope, `${pairKey}.scope`);
    const receipt = row.scope.storedUnpublishedReceipt;
    assertObject(receipt, `${pairKey}.scope.storedUnpublishedReceipt`);
    const receiptId = requiredText(
      receipt.receiptId,
      `${pairKey}.storedUnpublishedReceipt.receiptId`
    );
    if (receiptIds.has(receiptId)) {
      throw new Error(`pair scopes contains duplicate receiptId ${receiptId}.`);
    }
    receiptIds.add(receiptId);
    if (receipt.status !== "complete") {
      throw new Error(`${pairKey} stored-unpublished status must be complete.`);
    }
    requiredText(receipt.reason, `${pairKey}.storedUnpublishedReceipt.reason`);
    const checkedAt = canonicalTimestamp(
      receipt.checkedAt,
      `${pairKey}.storedUnpublishedReceipt.checkedAt`
    );
    const coveredThrough = canonicalTimestamp(
      receipt.coveredThrough,
      `${pairKey}.storedUnpublishedReceipt.coveredThrough`
    );
    if (Date.parse(checkedAt) < Date.parse(coveredThrough)) {
      throw new Error(`${pairKey} stored-unpublished receipt predates coveredThrough.`);
    }
    if (Date.parse(checkedAt) > Date.parse(materializedAt)) {
      throw new Error(`${pairKey} stored-unpublished receipt exceeds materializedAt.`);
    }
    const proof = validateStoredUnpublishedProof(receipt, pairKey);
    sourceProofs.add(proof.sourceProofSha256);
    totalAttributedRows += proof.totalAttributedRows;
    if (!Number.isSafeInteger(totalAttributedRows)) {
      throw new Error("pair scopes aggregate totalAttributedRows exceeds a safe integer.");
    }
    earliestCheckedAt = earlierTimestamp(earliestCheckedAt, checkedAt);
    latestCheckedAt = laterTimestamp(latestCheckedAt, checkedAt);
    minimumCoveredThrough = earlierTimestamp(minimumCoveredThrough, coveredThrough);
  }
  if (expected.size > 0) {
    throw new Error(
      `pair scopes omits ${expected.size} canonical pairs; first missing=${[...expected].sort()[0]}.`
    );
  }
  if (sourceProofs.size !== 1) {
    throw new Error("pair scopes must share one exact sourceProofSha256.");
  }
  const descriptor = await writeCopiedArtifact({
    packageRoot,
    path: "coverage/pair-scopes.json",
    bytes: source.bytes,
    observedAt: latestCheckedAt,
    format: "json"
  });
  return {
    descriptor,
    count: values.length,
    totalAttributedRows,
    sourceProofSha256: [...sourceProofs][0],
    minimumCoveredThrough,
    timeline: [
      { kind: "pair_scopes_first_checked", timestamp: earliestCheckedAt },
      { kind: "pair_scopes_last_checked", timestamp: latestCheckedAt }
    ]
  };
}

function expectedPairScopeKeys(normalizedCatalogs) {
  const keys = new Set();
  for (const catalog of normalizedCatalogs) {
    for (const company of catalog.companies) {
      for (const platform of PAIR_SCOPE_PLATFORMS) {
        keys.add(`${catalog.batchSlug}:company:${company.id}:${platform}`);
      }
      for (const founder of company.founders) {
        for (const platform of PAIR_SCOPE_PLATFORMS) {
          keys.add(`${catalog.batchSlug}:founder:${founder.id}:${platform}`);
        }
      }
    }
  }
  return keys;
}

function validateStoredUnpublishedProof(receipt, pairKey) {
  assertObject(
    receipt.surfacedCounts,
    `${pairKey}.storedUnpublishedReceipt.surfacedCounts`
  );
  const counts = Object.fromEntries([
    "historicalEvidenceRows",
    "githubEvidenceAttributions",
    "githubBlockerReviews",
    "evidenceAttributions",
    "totalAttributedRows"
  ].map((field) => {
    const value = receipt.surfacedCounts[field];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(
        `${pairKey}.storedUnpublishedReceipt.surfacedCounts.${field} must be a non-negative safe integer.`
      );
    }
    return [field, value];
  }));
  if (
    counts.evidenceAttributions !==
      counts.historicalEvidenceRows + counts.githubEvidenceAttributions ||
    !Number.isSafeInteger(counts.evidenceAttributions)
  ) {
    throw new Error(`${pairKey} stored-unpublished evidence counts do not reconcile.`);
  }
  if (
    counts.totalAttributedRows !==
      counts.evidenceAttributions + counts.githubBlockerReviews ||
    !Number.isSafeInteger(counts.totalAttributedRows)
  ) {
    throw new Error(`${pairKey} stored-unpublished total counts do not reconcile.`);
  }
  if (
    typeof receipt.surfacedCounts.explicitZero !== "boolean" ||
    receipt.surfacedCounts.explicitZero !== (counts.totalAttributedRows === 0)
  ) {
    throw new Error(`${pairKey} stored-unpublished explicitZero does not reconcile.`);
  }
  const sourceProofSha256 = requiredText(
    receipt.sourceProofSha256,
    `${pairKey}.storedUnpublishedReceipt.sourceProofSha256`
  );
  if (!SHA256_PATTERN.test(sourceProofSha256)) {
    throw new TypeError(
      `${pairKey}.storedUnpublishedReceipt.sourceProofSha256 must be lowercase SHA-256.`
    );
  }
  if (receipt.publicationPolicy !== "proof_only_no_publication") {
    throw new Error(
      `${pairKey}.storedUnpublishedReceipt.publicationPolicy must be proof_only_no_publication.`
    );
  }
  if (receipt.scoringEligible !== false) {
    throw new Error(`${pairKey}.storedUnpublishedReceipt.scoringEligible must be false.`);
  }
  return { sourceProofSha256, totalAttributedRows: counts.totalAttributedRows };
}

async function validatePackagedHistoricalBridge({ historicalBackfill, generatedAt }) {
  const { adaptHistoricalBackfillCoverage } = await import("./historical-coverage-adapter.mjs");
  const recencyCutoffAt = historicalBackfill.completionProofValues[0]?.coveredThrough ?? null;
  await adaptHistoricalBackfillCoverage({
    journal: createReadStream(historicalBackfill.journalAbsolutePath),
    artifact: {
      path: historicalBackfill.journal.path,
      sha256: historicalBackfill.journal.sha256,
      observedAt: historicalBackfill.journal.observedAt
    },
    generatedAt,
    recencyCutoffAt,
    completionProofs: historicalBackfill.completionProofValues
  });
}

async function validatePackagedHistoricalDepthBridge({
  historicalDepthBackfill,
  catalogs,
  generatedAt
}) {
  const { adaptHistoricalDepthCoverage } = await import(
    "./historical-depth-coverage-adapter.mjs"
  );
  await adaptHistoricalDepthCoverage({
    journal: createReadStream(historicalDepthBackfill.journalAbsolutePath),
    artifact: {
      path: historicalDepthBackfill.journal.path,
      sha256: historicalDepthBackfill.journal.sha256,
      observedAt: historicalDepthBackfill.journal.observedAt
    },
    catalogs,
    generatedAt,
    completionProofs: historicalDepthBackfill.completionProofValues
  });
}

function buildRunnerEvents({ runTiming, collectionResults, idempotencyKey, campaignKey }) {
  return [
    {
      eventType: "run.started",
      createdAt: runTiming.startedAt,
      severity: "info",
      message: "Coverage campaign read window started at the earliest exact task observation.",
      payload: { idempotencyKey, campaignKey }
    },
    {
      eventType: "collection.finished",
      createdAt: runTiming.completedAt,
      severity: collectionResults.every((result) => result.ok) ? "info" : "warning",
      message: "Coverage preparation reconciled every explicitly required collector artifact and checkpoint.",
      payload: { results: collectionResults }
    },
    {
      eventType: "run.completed",
      createdAt: runTiming.completedAt,
      severity: "info",
      message: "Coverage campaign read window ended; this event does not assert objective completion.",
      payload: { idempotencyKey, campaignKey }
    }
  ];
}

async function copyCatalogSources({
  rootPath,
  packageRoot,
  selectedCatalogs,
  selectedLayouts,
  descriptors,
  observedAt,
  maxArtifactBytes
}) {
  const configured = new Map(AUTONOMOUS_BATCHES.map((batch) => [batch.slug, batch]));
  const paths = new Map();
  const overridesPath = join(rootPath, "src/lib/social/verified-social-overrides.json");
  paths.set("verified_social_overrides", overridesPath);
  for (const layout of selectedLayouts) {
    const catalog = selectedCatalogs.find((candidate) => candidate.slug === layout.slug);
    const batch = configured.get(layout.slug);
    const sourcePath = isAbsolute(catalog.sourcePath)
      ? catalog.sourcePath
      : resolve(rootPath, catalog.sourcePath);
    paths.set(`${layout.slug.toLowerCase()}_canonical_catalog`, sourcePath);
    if (batch?.rosterFile) {
      paths.set(`${layout.slug.toLowerCase()}_independent_roster`, resolve(rootPath, batch.rosterFile));
    }
  }
  for (const [kind, sourcePath] of paths) {
    const source = await readExplicitFile(sourcePath, maxArtifactBytes, `catalog source ${kind}`);
    const extension = extname(source.path) || ".txt";
    descriptors.supporting.push({
      kind,
      ...await writeCopiedArtifact({
        packageRoot,
        path: `sources/${kind}${extension}`,
        bytes: source.bytes,
        observedAt,
        format: extension === ".json" ? "json" : "source"
      })
    });
  }
}

function expectedManifestFor(normalizedCatalogs) {
  return {
    version: INGESTION_CATALOG_MANIFEST_VERSION,
    batches: normalizedCatalogs.map((catalog) => {
      const founders = catalog.companies.reduce(
        (sum, company) => sum + company.founders.length,
        0
      );
      return {
        batchSlug: catalog.batchSlug,
        sourcePath: catalog.sourcePath,
        sourceVersion: catalog.sourceVersion,
        sourceHash: catalog.sourceHash,
        companies: catalog.companies.length,
        founders,
        entities: catalog.companies.length + founders
      };
    }).sort((left, right) => left.batchSlug.localeCompare(right.batchSlug))
  };
}

function selectBatchLayouts(batchSlugs, layouts) {
  if (!Array.isArray(batchSlugs) || batchSlugs.length === 0) {
    throw new TypeError("batchSlugs must be a non-empty explicit array.");
  }
  const configured = new Map(layouts.map((layout) => [layout.slug, layout]));
  const seen = new Set();
  return batchSlugs.map((slug) => {
    const normalized = requiredText(slug, "batchSlug");
    if (seen.has(normalized)) throw new Error(`Duplicate selected batch ${normalized}.`);
    seen.add(normalized);
    const layout = configured.get(normalized);
    if (!layout) throw new Error(`Batch ${normalized} is not canonically configured.`);
    if (!Number.isInteger(layout.publicShards) || layout.publicShards < 1 ||
        !Number.isInteger(layout.githubShards) || layout.githubShards < 1) {
      throw new Error(`Batch ${normalized} has invalid shard configuration.`);
    }
    return layout;
  });
}

function selectCatalogs(catalogs, layouts) {
  if (!Array.isArray(catalogs)) throw new TypeError("catalogs must be an array.");
  const index = new Map(catalogs.map((catalog) => [catalog.slug, catalog]));
  return layouts.map((layout) => {
    const catalog = index.get(layout.slug);
    if (!catalog) throw new Error(`Canonical catalog ${layout.slug} is missing.`);
    return catalog;
  });
}

function indexDatedAttempts(snapshot, { batchSlug, label, requireNonEmpty }) {
  const source = snapshot?.attempts;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError(`${label}.attempts must be an object.`);
  }
  const index = new Map();
  for (const [storedKey, attempt] of Object.entries(source)) {
    if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) {
      throw new TypeError(`${label} attempt ${storedKey} must be an object.`);
    }
    const attemptKey = requiredText(
      attempt.attemptKey ?? stripBatchPrefix(storedKey, batchSlug),
      `${label} attemptKey`
    );
    if (index.has(attemptKey)) throw new Error(`${label} contains duplicate attemptKey ${attemptKey}.`);
    const checkedAt = canonicalizeTimestamp(attempt.checkedAt, `${label} ${attemptKey}.checkedAt`);
    const startedAt = attempt.startedAt
      ? canonicalizeTimestamp(attempt.startedAt, `${label} ${attemptKey}.startedAt`)
      : checkedAt;
    if (Date.parse(startedAt) > Date.parse(checkedAt)) {
      throw new Error(`${label} ${attemptKey} startedAt exceeds checkedAt.`);
    }
    index.set(attemptKey, { attempt, attemptKey, startedAt, checkedAt });
  }
  if (requireNonEmpty && index.size === 0) throw new Error(`${label} has no dated attempts.`);
  return index;
}

function validateAttemptSuperset(merged, child, { label }) {
  for (const [attemptKey, candidate] of child) {
    const current = merged.get(attemptKey);
    if (!current) throw new Error(`Merged collector output omits ${label} attempt ${attemptKey}.`);
    if (Date.parse(current.checkedAt) < Date.parse(candidate.checkedAt)) {
      throw new Error(`Merged collector output is older than ${label} attempt ${attemptKey}.`);
    }
    for (const field of ["entityType", "entityId", "platform", "accountUrl"]) {
      const expected = clean(candidate.attempt[field]);
      const actual = clean(current.attempt[field]);
      if (expected && actual && expected !== actual) {
        throw new Error(`Merged collector output changes ${label} attempt ${attemptKey} ${field}.`);
      }
    }
  }
}

function collectorObservation(snapshot, attempts, { label, sourceTimestampRequired = true }) {
  const timeline = [];
  for (const attempt of attempts.values()) {
    timeline.push({ kind: `${label}:attempt_started`, timestamp: attempt.startedAt });
    timeline.push({ kind: `${label}:attempt_checked`, timestamp: attempt.checkedAt });
  }
  const fetchedAtRaw = snapshot?.source?.fetchedAt;
  if (fetchedAtRaw) {
    timeline.push({
      kind: `${label}:source_fetched`,
      timestamp: canonicalizeTimestamp(fetchedAtRaw, `${label}.source.fetchedAt`)
    });
  } else if (sourceTimestampRequired) {
    throw new TypeError(`${label}.source.fetchedAt is required.`);
  }
  if (timeline.length === 0) throw new Error(`${label} has no exact dated observations.`);
  const observedAt = timeline.map((row) => row.timestamp).sort().at(-1);
  return { timeline, observedAt };
}

function deriveRunTiming(timeline) {
  if (!Array.isArray(timeline) || timeline.length === 0) {
    throw new Error("Cannot derive a run window without exact task observations.");
  }
  const timestamps = timeline.map((row) => canonicalTimestamp(row.timestamp, row.kind)).sort();
  return { startedAt: timestamps[0], completedAt: timestamps.at(-1) };
}

function exactNonTerminalReason(kind, batchSlug, coverage) {
  return `Manual review required: ${kind} ${batchSlug} has ${coverage.nonTerminal}/` +
    `${coverage.expected} planned tasks without an explicit terminal per-task attempt in the ` +
    `required merged output and checkpoints; samples=${stableJson(coverage.nonTerminalTaskSamples)}.`;
}

function validatePublicCheckpoint(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  if (!value.attempts || typeof value.attempts !== "object" || Array.isArray(value.attempts)) {
    throw new TypeError(`${label}.attempts must be an object.`);
  }
  for (const field of ["evidence", "needsReview", "failures"]) {
    if (!Array.isArray(value[field])) throw new TypeError(`${label}.${field} must be an array.`);
  }
}

async function inspectCompletedHistoricalJournal(filePath, label = "Historical") {
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  let first = null;
  let last = null;
  let lineNumber = 0;
  for await (const raw of lines) {
    lineNumber += 1;
    if (!raw.trim()) throw new Error(`${label} journal line ${lineNumber} is blank.`);
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      throw new Error(`${label} journal line ${lineNumber} is invalid JSON.`);
    }
    first ??= event;
    last = event;
  }
  if (!last) throw new Error(`${label} journal is empty.`);
  if (last.type !== "run_completed") {
    throw new Error(
      `${label} journal is not complete; omit it or rerun preparation after run_completed.`
    );
  }
  const startedAt = canonicalizeTimestamp(
    first.startedAt ?? first.recordedAt,
    `${label} run start`
  );
  const completedAt = canonicalizeTimestamp(last.recordedAt, `${label} run completion`);
  return { startedAt, completedAt };
}

async function readCampaignJson(campaignRoot, relativePath, limit) {
  const filePath = await resolveInside(campaignRoot, relativePath);
  const source = await readBoundedFile(filePath, limit, relativePath);
  return { ...source, value: parseJson(source.bytes, relativePath) };
}

async function readExplicitFile(filePath, limit, label) {
  const resolvedPath = await realpath(resolve(requiredText(filePath, label)));
  return readBoundedFile(resolvedPath, limit, label);
}

async function readBoundedFile(filePath, limit, label) {
  const value = await stat(filePath);
  if (!value.isFile()) throw new TypeError(`${label} must be a regular file.`);
  if (value.size > limit) {
    throw new Error(`${label} is ${value.size} bytes, exceeding the ${limit}-byte limit.`);
  }
  return { path: filePath, bytes: await readFile(filePath) };
}

async function resolveInside(root, relativePath) {
  if (isAbsolute(relativePath)) throw new Error(`Campaign artifact path must be relative: ${relativePath}.`);
  const candidate = resolve(root, relativePath);
  assertWithin(candidate, root, relativePath);
  const resolvedPath = await realpath(candidate);
  assertWithin(resolvedPath, root, relativePath);
  return resolvedPath;
}

function assertWithin(candidate, root, label) {
  const suffix = relative(root, candidate);
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error(`Campaign artifact ${label} escapes campaignDir.`);
  }
}

async function writeGeneratedArtifact({ packageRoot, path, body, observedAt, format }) {
  return writeCopiedArtifact({
    packageRoot,
    path,
    bytes: Buffer.from(body, "utf8"),
    observedAt,
    format
  });
}

async function writeCopiedArtifact({ packageRoot, path, bytes, observedAt, format }) {
  const destination = join(packageRoot, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { mode: 0o600 });
  return {
    path,
    sha256: sha256(bytes),
    observedAt: canonicalTimestamp(observedAt, `${path}.observedAt`),
    format
  };
}

async function assertPathDoesNotExist(path, label) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} already exists: ${path}. Choose a new resumable package directory.`);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new SyntaxError(`${label} contains invalid JSON: ${error.message}`);
  }
}

function stripBatchPrefix(value, batchSlug) {
  const prefix = `${batchSlug}:`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function canonicalizeTimestamp(value, label) {
  const text = requiredText(value, label);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be a valid timestamp.`);
  return new Date(parsed).toISOString();
}

function canonicalTimestamp(value, label) {
  const text = requiredText(value, label);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    throw new TypeError(`${label} must be a canonical ISO-8601 UTC timestamp.`);
  }
  return text;
}

function optionalCanonicalTimestamp(value, label) {
  if (value === null || value === undefined || value === "") return null;
  return canonicalTimestamp(value, label);
}

function validateByteLimit(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function earlierTimestamp(current, candidate) {
  return current === null || Date.parse(candidate) < Date.parse(current)
    ? candidate
    : current;
}

function laterTimestamp(current, candidate) {
  return current === null || Date.parse(candidate) > Date.parse(current)
    ? candidate
    : current;
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

function requiredText(value, label) {
  const text = clean(value);
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}
