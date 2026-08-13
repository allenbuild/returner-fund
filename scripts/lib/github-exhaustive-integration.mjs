import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

import { isFullyAuthoritativeGithubReceipt } from "./github-authoritative-reconciliation.mjs";
import {
  canonicalGithubTargetUrl,
  parseGithubTargetUrl
} from "./github-url.mjs";

export const GITHUB_EXHAUSTIVE_INTEGRATION_SCHEMA_VERSION = 1;
export const GITHUB_EXHAUSTIVE_INTEGRATION_VERSION = "2026-08-02.v1";

const BATCH_FILENAMES = Object.freeze({
  S2026: "github-traction.s2026.staged.json",
  S26: "github-traction.s26.staged.json",
  A16ZSR006: "github-traction.a16zsr006.staged.json"
});
const EVIDENCE_KINDS = new Set([
  "github_repository",
  "github_release",
  "github_tag",
  "github_commit"
]);
const FORBIDDEN_RECEIPT_KEYS = /(?:authorization|access[_-]?token|client[_-]?secret|password|private[_-]?key)/i;

/**
 * Validate and stage a completed exhaustive GitHub run without mutating any
 * canonical artifact. Existing canonical repository identities remain in the
 * scoring-visible `repos` arrays. New evidence is placed only in explicit
 * stored-but-unpublished fields and review sidecars.
 */
export async function stageGithubExhaustiveIntegration({
  runDir,
  journalPath = runDir ? join(runDir, "events.ndjson") : null,
  checkpointPath = runDir ? join(runDir, "checkpoint-current.json") : null,
  runSummaryPath = runDir ? join(runDir, "summary.json") : null,
  materializationSummaryPath = runDir ? join(runDir, "materialization-summary.json") : null,
  evidencePath = runDir ? join(runDir, "evidence-deduped.ndjson") : null,
  materializedQuarantinePath = runDir ? join(runDir, "evidence-quarantine.ndjson") : null,
  canonicalSnapshots,
  legacyQuarantinePath,
  outputDir = null,
  write = false,
  now = () => new Date()
} = {}) {
  for (const [label, value] of Object.entries({
    journalPath,
    checkpointPath,
    runSummaryPath,
    materializationSummaryPath,
    evidencePath,
    materializedQuarantinePath,
    legacyQuarantinePath
  })) {
    if (!value) throw new Error(`${label} is required.`);
  }
  if (!Array.isArray(canonicalSnapshots) || canonicalSnapshots.length === 0) {
    throw new Error("canonicalSnapshots must be a non-empty array of explicit batch/path descriptors.");
  }
  if (write && !outputDir) throw new Error("write mode requires an explicit outputDir.");

  const inputPaths = {
    journal: resolve(journalPath),
    checkpoint: resolve(checkpointPath),
    runSummary: resolve(runSummaryPath),
    materializationSummary: resolve(materializationSummaryPath),
    evidence: resolve(evidencePath),
    materializedQuarantine: resolve(materializedQuarantinePath),
    legacyQuarantine: resolve(legacyQuarantinePath)
  };
  const canonicalDescriptors = canonicalSnapshots.map((descriptor, index) => {
    if (!descriptor?.batchSlug || !descriptor?.path) {
      throw new Error(`canonicalSnapshots[${index}] requires batchSlug and path.`);
    }
    return { batchSlug: descriptor.batchSlug, path: resolve(descriptor.path) };
  });
  assertDistinctPaths([
    ...Object.values(inputPaths),
    ...canonicalDescriptors.map((descriptor) => descriptor.path)
  ]);
  const resolvedOutputDir = outputDir ? resolve(outputDir) : null;
  if (write) {
    assertSafeStagingDirectory(resolvedOutputDir, {
      runDir: runDir ? resolve(runDir) : dirname(inputPaths.journal),
      canonicalPaths: canonicalDescriptors.map((descriptor) => descriptor.path),
      legacyQuarantinePath: inputPaths.legacyQuarantine
    });
    await assertFreshOutputDirectory(resolvedOutputDir);
    await mkdir(resolvedOutputDir, { recursive: true });
  }

  const [checkpoint, runSummary, materializationSummary, legacyQuarantine] = await Promise.all([
    readJson(inputPaths.checkpoint, "checkpoint"),
    readJson(inputPaths.runSummary, "run summary"),
    readJson(inputPaths.materializationSummary, "materialization summary"),
    readJson(inputPaths.legacyQuarantine, "legacy GitHub quarantine")
  ]);
  const canonicalInputs = await Promise.all(canonicalDescriptors.map(async (descriptor) => ({
    ...descriptor,
    snapshot: await readJson(descriptor.path, `${descriptor.batchSlug} canonical GitHub snapshot`),
    sha256: await sha256File(descriptor.path)
  })));
  const runAudit = await auditCompletedGithubJournal(inputPaths.journal, {
    requestReceiptOutputPath: write
      ? join(resolvedOutputDir, "github-exhaustive-request-receipts.ndjson")
      : null
  });
  validateCompletedRun({ checkpoint, runSummary, materializationSummary, runAudit });
  await validateMaterializationArtifacts({
    materializationSummary,
    journalPath: inputPaths.journal,
    evidencePath: inputPaths.evidence,
    quarantinePath: inputPaths.materializedQuarantine,
    runAudit
  });
  const canonical = validateCanonicalInputs(canonicalInputs, runAudit);
  const legacy = validateLegacyQuarantine(legacyQuarantine, canonical);

  const stagedByBatch = new Map(
    canonicalInputs.map(({ batchSlug, snapshot }) => [batchSlug, structuredClone(snapshot)])
  );
  const stagedAccountByTask = indexStagedAccounts(stagedByBatch);
  const adapterQuarantineSink = await NdjsonSink.open(
    write ? join(resolvedOutputDir, "github-exhaustive-adapter-quarantine.ndjson") : null
  );
  const reviewSink = await NdjsonSink.open(
    write ? join(resolvedOutputDir, "github-exhaustive-stored-evidence-review.ndjson") : null
  );
  const perBatchStats = new Map(
    canonicalInputs.map(({ batchSlug, snapshot }) => [batchSlug, {
      canonicalAccountsPreserved: snapshot.accounts.length,
      canonicalRepositoriesPreserved: snapshot.accounts.reduce(
        (total, account) => total + (account.repos?.length ?? 0),
        0
      ),
      canonicalRepositoriesRefreshed: 0,
      newRepositoriesStoredUnpublished: 0,
      contentEvidenceStoredUnpublished: 0,
      adapterQuarantines: 0,
      blockedTargets: 0,
      manualReviewTargets: 0
    }])
  );

  let evidenceRows = 0;
  let repositoryEvidenceRows = 0;
  let contentEvidenceRows = 0;
  const observedRepositoryIds = new Map();
  const observedRepositoryUrls = new Map();
  const reviewIds = new Set();
  try {
    const evidenceLines = createInterface({
      input: createReadStream(inputPaths.evidence, { encoding: "utf8" }),
      crlfDelay: Infinity
    });
    for await (const line of evidenceLines) {
      if (!line.trim()) continue;
      const evidence = JSON.parse(line);
      evidenceRows += 1;
      validateMaterializedEvidence(evidence, canonical, runAudit);
      if (evidence.kind === "github_repository") {
        repositoryEvidenceRows += 1;
        const identity = repositoryIdentity(evidence);
        indexObservedRepository(observedRepositoryIds, observedRepositoryUrls, identity, evidence.evidenceId);
        const result = await integrateRepositoryEvidence({
          evidence,
          identity,
          stagedAccountByTask,
          runAudit,
          legacy,
          perBatchStats,
          quarantineSink: adapterQuarantineSink,
          reviewSink,
          reviewIds
        });
        if (result.quarantinedAllAttributions) continue;
      } else {
        contentEvidenceRows += 1;
        await writeStoredEvidenceReview({
          evidence,
          stagedAccountByTask,
          runAudit,
          legacy,
          perBatchStats,
          quarantineSink: adapterQuarantineSink,
          reviewSink,
          reviewIds,
          category: "github_exhaustive_content_stored_unpublished",
          reason:
            "Release, tag, and commit evidence is preserved by immutable GitHub content identity but remains unpublished until a canonical scoring schema and owner-attribution policy explicitly promote it."
        });
      }
    }
    if (evidenceRows !== materializationSummary.evidenceRows) {
      throw new Error(
        `Materialized evidence count ${evidenceRows} does not match receipt ${materializationSummary.evidenceRows}.`
      );
    }

    const materializedConflicts = await copyMaterializedQuarantine({
      path: inputPaths.materializedQuarantine,
      expectedRows: materializationSummary.quarantinedPhysicalIdentities,
      quarantineSink: adapterQuarantineSink
    });
    for (const [targetKey, completed] of runAudit.completedTargets) {
      if (completed.receipt.outcome === "collected") continue;
      for (const taskKey of completed.receipt.attributionTaskKeys) {
        const canonicalAccount = canonical.accountsByTask.get(taskKey);
        if (!canonicalAccount) throw new Error(`Completed blocker references unknown canonical task ${taskKey}.`);
        const stats = perBatchStats.get(canonicalAccount.batchSlug);
        if (completed.receipt.outcome === "manual_review") stats.manualReviewTargets += 1;
        else stats.blockedTargets += 1;
      }
      const blockerReview = {
        reviewId: `github-exhaustive-target:${sha256(targetKey).slice(0, 24)}`,
        category: "github_exhaustive_target_terminal_blocker",
        targetKey,
        accountUrl: completed.receipt.accountUrl,
        outcome: completed.receipt.outcome,
        blocker: completed.receipt.blocker,
        attributionTaskKeys: completed.receipt.attributionTaskKeys,
        reviewState: completed.receipt.outcome === "manual_review" ? "needs_review" : "blocked",
        scoringEligible: false,
        publicationState: "stored_but_unpublished"
      };
      await appendUniqueReview(reviewSink, reviewIds, blockerReview);
    }

    const missingCanonicalReviews = await recordCanonicalRepositoriesNotObserved({
      canonical,
      runAudit,
      observedRepositoryIds,
      observedRepositoryUrls,
      reviewSink,
      reviewIds
    });
    finalizeStagedAccounts(stagedByBatch, runAudit, perBatchStats);

    const adapterQuarantine = await adapterQuarantineSink.finish();
    const storedReview = await reviewSink.finish();
    const requestReceipts = await runAudit.requestReceiptSink.finish();
    const legacyRowsBefore = legacyQuarantine.rows.length;
    const stagedQuarantine = structuredClone(legacyQuarantine);
    stagedQuarantine.exhaustiveIntegration = {
      schemaVersion: GITHUB_EXHAUSTIVE_INTEGRATION_SCHEMA_VERSION,
      integrationVersion: GITHUB_EXHAUSTIVE_INTEGRATION_VERSION,
      planHash: runSummary.planHash,
      publicationPolicy: "stored_but_unpublished",
      scoringEligible: false,
      legacyRowsPreservedExactly: true,
      legacyRowCount: legacyRowsBefore,
      legacyRowsWithExistingCanonicalPhysicalRepresentation:
        legacy.representedQuarantineIds.size,
      artifacts: {
        requestReceipts: publicArtifactReference(requestReceipts),
        storedEvidenceReview: publicArtifactReference(storedReview),
        adapterQuarantine: publicArtifactReference(adapterQuarantine)
      },
      materializedIdentityConflicts: materializedConflicts,
      canonicalRepositoriesNotObserved: missingCanonicalReviews
    };
    assertLegacyRowsPreserved(legacyQuarantine, stagedQuarantine);

    const integrationTimestamp = now().toISOString();
    const stagedArtifacts = [];
    for (const [batchSlug, snapshot] of stagedByBatch) {
      const stats = perBatchStats.get(batchSlug);
      snapshot.source = {
        ...snapshot.source,
        exhaustiveIntegration: {
          schemaVersion: GITHUB_EXHAUSTIVE_INTEGRATION_SCHEMA_VERSION,
          integrationVersion: GITHUB_EXHAUSTIVE_INTEGRATION_VERSION,
          generatedAt: integrationTimestamp,
          planHash: runSummary.planHash,
          publicationState: "staged",
          newEvidencePublicationPolicy: "stored_but_unpublished",
          scoringPolicy:
            "Only repository identities already present in the canonical repos array remain scoring-visible. Newly recovered evidence stays outside repos until explicit promotion.",
          inputCanonicalSha256: canonicalInputs.find((input) => input.batchSlug === batchSlug).sha256,
          journalSha256: materializationSummary.journalSha256,
          materializedEvidenceSha256: materializationSummary.artifacts.evidenceSha256,
          stats
        }
      };
      validateStagedSnapshot(snapshot, canonical.snapshotsByBatch.get(batchSlug), legacy);
      stagedArtifacts.push({
        batchSlug,
        filename: BATCH_FILENAMES[batchSlug] ?? `github-traction.${batchSlug.toLowerCase()}.staged.json`,
        value: snapshot,
        sha256: sha256(`${stableJson(snapshot)}\n`),
        stats
      });
    }
    const quarantineArtifact = {
      filename: "github-traction-quarantine.staged.json",
      value: stagedQuarantine,
      sha256: sha256(`${stableJson(stagedQuarantine)}\n`)
    };
    const receiptCore = {
      schemaVersion: GITHUB_EXHAUSTIVE_INTEGRATION_SCHEMA_VERSION,
      integrationVersion: GITHUB_EXHAUSTIVE_INTEGRATION_VERSION,
      status: "staged_not_published",
      productionEligible: false,
      generatedAt: integrationTimestamp,
      planHash: runSummary.planHash,
      configFingerprint: runAudit.configFingerprint,
      denominators: {
        companiesEvaluated: runSummary.companiesEvaluated,
        foundersEvaluated: runSummary.foundersEvaluated,
        canonicalOwnersEvaluated: runSummary.canonicalOwnersEvaluated,
        verifiedAttributionTasks: runSummary.verifiedAttributionTasks,
        terminalAttributionTasks: runSummary.terminalAttributionTasks,
        physicalTargets: runSummary.physicalTargets,
        terminalPhysicalTargets: runSummary.terminalPhysicalTargets
      },
      inputs: {
        journal: await fileReceipt(inputPaths.journal),
        checkpoint: await fileReceipt(inputPaths.checkpoint),
        runSummary: await fileReceipt(inputPaths.runSummary),
        materializationSummary: await fileReceipt(inputPaths.materializationSummary),
        evidence: await fileReceipt(inputPaths.evidence),
        materializedQuarantine: await fileReceipt(inputPaths.materializedQuarantine),
        legacyQuarantine: await fileReceipt(inputPaths.legacyQuarantine),
        canonicalSnapshots: canonicalInputs.map((input) => ({
          batchSlug: input.batchSlug,
          path: input.path,
          sha256: input.sha256
        }))
      },
      preservation: {
        canonicalAccountRowsBefore: canonical.totalAccounts,
        canonicalAccountRowsAfter: [...stagedByBatch.values()].reduce(
          (total, snapshot) => total + snapshot.accounts.length,
          0
        ),
        canonicalRepositoryRowsBefore: canonical.totalRepositories,
        canonicalRepositoryRowsAfter: [...stagedByBatch.values()].reduce(
          (total, snapshot) => total + snapshot.accounts.reduce(
            (count, account) => count + account.repos.length,
            0
          ),
          0
        ),
        legacyQuarantineRowsBefore: legacyRowsBefore,
        legacyQuarantineRowsAfter: stagedQuarantine.rows.length,
        legacyRowsPreservedExactly: true,
        legacyQuarantineRowsWithExistingCanonicalPhysicalRepresentation:
          legacy.representedQuarantineIds.size,
        resurrectedLegacyAccountMappings: 0
      },
      evidence: {
        materializedRows: evidenceRows,
        repositoryRows: repositoryEvidenceRows,
        contentRows: contentEvidenceRows,
        acceptedRepositoryAttributions: [...perBatchStats.values()].reduce(
          (total, stats) => total + stats.canonicalRepositoriesRefreshed + stats.newRepositoriesStoredUnpublished,
          0
        ),
        acceptedContentAttributions: [...perBatchStats.values()].reduce(
          (total, stats) => total + stats.contentEvidenceStoredUnpublished,
          0
        ),
        storedEvidenceReviewRows: storedReview.rowCount,
        adapterQuarantineRows: adapterQuarantine.rowCount,
        requestReceiptRows: requestReceipts.rowCount,
        canonicalRepositoriesNotObserved: missingCanonicalReviews,
        materializedIdentityConflicts: materializedConflicts
      },
      byBatch: Object.fromEntries([...perBatchStats].sort(([left], [right]) => left.localeCompare(right))),
      outputs: {
        stagedSnapshots: stagedArtifacts.map((artifact) => ({
          batchSlug: artifact.batchSlug,
          filename: artifact.filename,
          sha256: artifact.sha256
        })),
        stagedQuarantine: {
          filename: quarantineArtifact.filename,
          sha256: quarantineArtifact.sha256
        },
        requestReceipts: publicArtifactReference(requestReceipts),
        storedEvidenceReview: publicArtifactReference(storedReview),
        adapterQuarantine: publicArtifactReference(adapterQuarantine)
      },
      nextAction:
        "Review stored evidence and adapter quarantine, then copy only explicitly approved staged files to canonical paths in a separate publication step."
    };
    const integrationReceipt = {
      ...receiptCore,
      receiptSha256: sha256(stableJson(receiptCore))
    };

    if (write) {
      for (const artifact of stagedArtifacts) {
        await atomicStableJsonWrite(join(resolvedOutputDir, artifact.filename), artifact.value);
      }
      await atomicStableJsonWrite(join(resolvedOutputDir, quarantineArtifact.filename), quarantineArtifact.value);
      await adapterQuarantineSink.publish();
      await reviewSink.publish();
      await runAudit.requestReceiptSink.publish();
      await atomicStableJsonWrite(
        join(resolvedOutputDir, "github-exhaustive-integration-receipt.json"),
        integrationReceipt
      );
    }
    return {
      ...integrationReceipt,
      writeMode: write,
      outputDir: resolvedOutputDir
    };
  } catch (error) {
    await Promise.allSettled([
      adapterQuarantineSink.abort(),
      reviewSink.abort(),
      runAudit.requestReceiptSink.abort()
    ]);
    throw error;
  }
}

async function auditCompletedGithubJournal(journalPath, { requestReceiptOutputPath }) {
  const requestReceiptSink = await NdjsonSink.open(requestReceiptOutputPath);
  const targetStarts = new Map();
  const taskToTarget = new Map();
  const completedTargets = new Map();
  const profiles = new Map();
  let config = null;
  let configFingerprint = null;
  let planSummary = null;
  let lastSequence = 0;
  let initializationCount = 0;
  let invocationFinishCount = 0;
  try {
    const lines = createInterface({
      input: createReadStream(journalPath, { encoding: "utf8" }),
      crlfDelay: Infinity
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.schemaVersion !== 1) {
        throw new Error(`Unsupported exhaustive journal schema at sequence ${event.sequence ?? "unknown"}.`);
      }
      if (!Number.isInteger(event.sequence) || event.sequence !== lastSequence + 1) {
        throw new Error(`Exhaustive journal sequence is not contiguous after ${lastSequence}.`);
      }
      lastSequence = event.sequence;
      if (!validTimestamp(event.recordedAt)) {
        throw new Error(`Exhaustive journal event ${event.sequence} has no valid recordedAt.`);
      }
      if (event.type === "run_initialized") {
        initializationCount += 1;
        config = event.config;
        configFingerprint = requiredText(event.configFingerprint, "journal configFingerprint");
        planSummary = event.planSummary;
      } else if (event.type === "target_started") {
        const targetKey = requiredText(event.targetKey, "target_started.targetKey");
        if (targetStarts.has(targetKey)) throw new Error(`Duplicate target_started for ${targetKey}.`);
        const accountUrl = canonicalGithubTargetUrl(event.accountUrl);
        if (!accountUrl) throw new Error(`target_started ${targetKey} has an invalid GitHub account URL.`);
        const tasks = uniqueTextArray(event.attributionTaskKeys, `${targetKey}.attributionTaskKeys`);
        const target = {
          targetKey,
          accountUrl,
          scope: event.scope,
          attributionTaskKeys: tasks
        };
        targetStarts.set(targetKey, target);
        for (const taskKey of tasks) {
          if (taskToTarget.has(taskKey)) throw new Error(`Attribution task ${taskKey} belongs to multiple targets.`);
          taskToTarget.set(taskKey, target);
        }
      } else if (event.type === "account_profile_collected") {
        const targetKey = requiredText(event.targetKey, "profile targetKey");
        if (profiles.has(targetKey)) throw new Error(`Duplicate collected profile for ${targetKey}.`);
        profiles.set(targetKey, validateProfile(event.profile));
      } else if (event.type === "target_completed") {
        const targetKey = requiredText(event.targetKey, "target_completed.targetKey");
        if (completedTargets.has(targetKey)) throw new Error(`Duplicate target_completed for ${targetKey}.`);
        completedTargets.set(targetKey, {
          recordedAt: event.recordedAt,
          receipt: validateTerminalReceipt(event.receipt, targetKey)
        });
      } else if (event.type === "request_receipt") {
        validateRequestReceipt(event.receipt);
        await requestReceiptSink.append({
          schemaVersion: GITHUB_EXHAUSTIVE_INTEGRATION_SCHEMA_VERSION,
          journalSequence: event.sequence,
          recordedAt: event.recordedAt,
          ...event.receipt
        });
      } else if (event.type === "run_invocation_finished") {
        invocationFinishCount += 1;
      }
    }
    if (initializationCount !== 1 || !config || !planSummary) {
      throw new Error("Exhaustive journal must contain exactly one complete run_initialized event.");
    }
    const configuredTargets = uniqueTextArray(config.targetKeys, "journal config.targetKeys");
    assertSameStringSet(configuredTargets, [...targetStarts.keys()], "configured and started targets");
    assertSameStringSet(configuredTargets, [...completedTargets.keys()], "configured and completed targets");
    for (const [targetKey, completed] of completedTargets) {
      const started = targetStarts.get(targetKey);
      assertSameStringSet(
        started.attributionTaskKeys,
        completed.receipt.attributionTaskKeys,
        `${targetKey} started/completed attribution tasks`
      );
      if (canonicalGithubTargetUrl(completed.receipt.accountUrl)?.toLowerCase() !== started.accountUrl.toLowerCase()) {
        throw new Error(`${targetKey} terminal receipt changed its account URL.`);
      }
    }
    if (invocationFinishCount < 1) throw new Error("Exhaustive journal has no run invocation finish receipt.");
    return {
      config,
      configFingerprint,
      planSummary,
      lastSequence,
      targetStarts,
      taskToTarget,
      completedTargets,
      profiles,
      requestReceiptSink
    };
  } catch (error) {
    await requestReceiptSink.abort();
    throw error;
  }
}

function validateCompletedRun({ checkpoint, runSummary, materializationSummary, runAudit }) {
  if (runSummary.status !== "completed") {
    throw new Error(`Exhaustive run summary status is ${runSummary.status ?? "missing"}; completed is required.`);
  }
  if (checkpoint.status !== "completed" || checkpoint.lastSummary?.status !== "completed") {
    throw new Error("Exhaustive checkpoint does not prove a completed run.");
  }
  if (
    checkpoint.configFingerprint !== runAudit.configFingerprint ||
    materializationSummary.configFingerprint !== runAudit.configFingerprint
  ) {
    throw new Error("Exhaustive checkpoint/materialization fingerprint does not match the journal.");
  }
  if (
    checkpoint.config?.planHash !== runSummary.planHash ||
    runAudit.config.planHash !== runSummary.planHash ||
    runAudit.planSummary.planHash !== runSummary.planHash
  ) {
    throw new Error("Exhaustive plan hash does not reconcile across journal, checkpoint, and summary.");
  }
  if (
    runSummary.terminalPhysicalTargets !== runSummary.physicalTargets ||
    runSummary.terminalAttributionTasks !== runSummary.verifiedAttributionTasks ||
    runAudit.completedTargets.size !== runSummary.physicalTargets ||
    runAudit.taskToTarget.size !== runSummary.verifiedAttributionTasks
  ) {
    throw new Error("Exhaustive completed denominators do not reconcile exactly.");
  }
  if (
    checkpoint.lastSequence !== runAudit.lastSequence ||
    materializationSummary.journalLastSequence !== runAudit.lastSequence
  ) {
    throw new Error("Exhaustive journal sequence does not reconcile with checkpoint/materialization.");
  }
}

async function validateMaterializationArtifacts({
  materializationSummary,
  journalPath,
  evidencePath,
  quarantinePath,
  runAudit
}) {
  if (
    materializationSummary.schemaVersion !== 1 ||
    materializationSummary.configFingerprint !== runAudit.configFingerprint ||
    !Number.isInteger(materializationSummary.evidenceRows) ||
    !Number.isInteger(materializationSummary.quarantinedPhysicalIdentities)
  ) {
    throw new Error("Materialization summary is incomplete or unsupported.");
  }
  const receipts = await Promise.all([
    sha256File(journalPath),
    sha256File(evidencePath),
    sha256File(quarantinePath)
  ]);
  if (receipts[0] !== materializationSummary.journalSha256) {
    throw new Error("Materialized journal hash mismatch.");
  }
  if (receipts[1] !== materializationSummary.artifacts?.evidenceSha256) {
    throw new Error("Materialized evidence hash mismatch.");
  }
  if (receipts[2] !== materializationSummary.artifacts?.quarantineSha256) {
    throw new Error("Materialized quarantine hash mismatch.");
  }
}

function validateCanonicalInputs(inputs, runAudit) {
  const snapshotsByBatch = new Map();
  const accountsByTask = new Map();
  const canonicalTaskKeys = [];
  let totalAccounts = 0;
  let totalRepositories = 0;
  for (const input of inputs) {
    const snapshot = input.snapshot;
    if (snapshot?.source?.batchSlug !== input.batchSlug) {
      throw new Error(`${input.batchSlug} canonical input has mismatched batchSlug.`);
    }
    if (!isFullyAuthoritativeGithubReceipt(snapshot)) {
      throw new Error(`${input.batchSlug} canonical input is not a whole-cohort authoritative receipt.`);
    }
    if (snapshotsByBatch.has(input.batchSlug)) throw new Error(`Duplicate canonical batch ${input.batchSlug}.`);
    snapshotsByBatch.set(input.batchSlug, snapshot);
    totalAccounts += snapshot.accounts.length;
    for (let accountIndex = 0; accountIndex < snapshot.accounts.length; accountIndex += 1) {
      const account = snapshot.accounts[accountIndex];
      const taskKey = canonicalAccountTaskKey(input.batchSlug, account);
      if (accountsByTask.has(taskKey)) throw new Error(`Duplicate canonical GitHub task ${taskKey}.`);
      validateCanonicalAccount(account, input.batchSlug, accountIndex);
      accountsByTask.set(taskKey, {
        batchSlug: input.batchSlug,
        account,
        accountIndex,
        taskKey
      });
      canonicalTaskKeys.push(taskKey);
      totalRepositories += account.repos.length;
    }
  }
  assertSameStringSet(canonicalTaskKeys, [...runAudit.taskToTarget.keys()], "canonical and exhaustive attribution tasks");
  for (const [taskKey, indexed] of accountsByTask) {
    const target = runAudit.taskToTarget.get(taskKey);
    if (
      !target ||
      canonicalGithubTargetUrl(target.accountUrl)?.toLowerCase() !==
        canonicalGithubTargetUrl(indexed.account.githubUrl)?.toLowerCase()
    ) {
      throw new Error(`Exhaustive target URL does not match canonical attribution task ${taskKey}.`);
    }
  }
  return {
    snapshotsByBatch,
    accountsByTask,
    totalAccounts,
    totalRepositories
  };
}

function validateLegacyQuarantine(quarantine, canonical) {
  if (
    quarantine?.source?.publicationPolicy !== "stored_but_unpublished" ||
    quarantine?.source?.scoringEligible !== false ||
    !Array.isArray(quarantine.rows) ||
    !Array.isArray(quarantine.physicalEvidenceOwnerReview) ||
    quarantine.source.rowCount !== quarantine.rows.length
  ) {
    throw new Error("Legacy GitHub quarantine is incomplete or publication-eligible.");
  }
  const accountTaskKeys = new Map();
  const quarantineRowsById = new Map();
  const repositoryIds = new Map();
  const repositoryUrls = new Map();
  for (const row of quarantine.rows) {
    if (row?.scoringEligible !== false || !row?.quarantineId || !row?.legacyRow) {
      throw new Error("Legacy GitHub quarantine row is malformed or scoring-eligible.");
    }
    quarantineRowsById.set(row.quarantineId, row);
    const accountUrl = canonicalGithubTargetUrl(row.legacyRow.githubUrl ?? row.legacyRow.url);
    if (accountUrl && row.batchSlug && row.legacyRow.entityType && row.legacyRow.entityId) {
      const taskKey = taskKeyFor(
        row.batchSlug,
        row.legacyRow.entityType,
        row.legacyRow.entityId,
        accountUrl
      );
      addMultiMap(accountTaskKeys, taskKey, row.quarantineId);
    }
    for (const repository of row.legacyRow.repos ?? []) {
      if (repository.id != null) addMultiMap(repositoryIds, String(repository.id), row.quarantineId);
      const url = canonicalRepositoryUrl(repository.htmlUrl ?? repository.fullName);
      if (url) addMultiMap(repositoryUrls, url.toLowerCase(), row.quarantineId);
    }
    if (row.legacyRow.repo) {
      const parsed = parseGithubTargetUrl(row.legacyRow.githubUrl);
      const url = parsed?.repo
        ? canonicalRepositoryUrl(`https://github.com/${parsed.login}/${parsed.repo}`)
        : null;
      if (url) addMultiMap(repositoryUrls, url.toLowerCase(), row.quarantineId);
    }
  }
  const representedAccountTaskKeys = new Map();
  const representedQuarantineIds = new Set();
  for (const [taskKey, indexed] of canonical.accountsByTask) {
    const quarantineIds = accountTaskKeys.get(taskKey) ?? [];
    if (quarantineIds.length === 0) continue;
    const proofBound = quarantineIds.filter((quarantineId) =>
      isExistingCanonicalPhysicalRepresentation(
        quarantineRowsById.get(quarantineId),
        indexed
      )
    );
    if (proofBound.length !== quarantineIds.length) {
      throw new Error(`Canonical snapshot resurrected quarantined legacy account mapping ${taskKey}.`);
    }
    accountTaskKeys.delete(taskKey);
    representedAccountTaskKeys.set(taskKey, proofBound);
    proofBound.forEach((quarantineId) => representedQuarantineIds.add(quarantineId));
  }
  return {
    accountTaskKeys,
    representedAccountTaskKeys,
    representedQuarantineIds,
    repositoryIds,
    repositoryUrls
  };
}

function isExistingCanonicalPhysicalRepresentation(row, indexed) {
  if (
    row?.category !== "legacy_repository_projection_absent_from_authoritative_targets" ||
    row.currentCanonicality !== "physical_object_present_but_legacy_account_row_not_canonical" ||
    row.physicalRepresentation?.status !== "represented_in_current_canonical_receipt" ||
    indexed.account.fetched !== true
  ) {
    return false;
  }
  const canonicalUrl = canonicalGithubTargetUrl(indexed.account.githubUrl)?.toLowerCase();
  const legacyUrl = canonicalGithubTargetUrl(
    row.legacyRow.githubUrl ?? row.legacyRow.url
  )?.toLowerCase();
  if (!canonicalUrl || canonicalUrl !== legacyUrl) return false;
  return (row.physicalRepresentation.canonicalMatches ?? []).some((match) =>
    match.location === "account" &&
    match.entityType === indexed.account.entityType &&
    match.entityId === indexed.account.entityId &&
    canonicalGithubTargetUrl(match.accountUrl)?.toLowerCase() === canonicalUrl
  );
}

function indexStagedAccounts(stagedByBatch) {
  const result = new Map();
  for (const [batchSlug, snapshot] of stagedByBatch) {
    snapshot.accounts.forEach((account, accountIndex) => {
      const taskKey = canonicalAccountTaskKey(batchSlug, account);
      result.set(taskKey, { batchSlug, snapshot, account, accountIndex, taskKey });
    });
  }
  return result;
}

async function integrateRepositoryEvidence({
  evidence,
  identity,
  stagedAccountByTask,
  runAudit,
  legacy,
  perBatchStats,
  quarantineSink,
  reviewSink,
  reviewIds
}) {
  let quarantined = 0;
  let integrated = 0;
  const integratedTaskKeys = new Set();
  const legacyQuarantineIds = legacyPhysicalOverlap(legacy, identity);
  for (const attribution of evidence.attributions) {
    const staged = stagedAccountByTask.get(attribution.taskKey);
    if (!staged) throw new Error(`Repository evidence references unknown canonical task ${attribution.taskKey}.`);
    const target = runAudit.taskToTarget.get(attribution.taskKey);
    const attributionValidation = validateEvidenceAttribution(evidence, attribution, staged, target);
    if (!attributionValidation.ok) {
      await quarantineSink.append(adapterQuarantineRow({
        evidence,
        attribution,
        reason: attributionValidation.reason,
        legacyQuarantineIds
      }));
      perBatchStats.get(staged.batchSlug).adapterQuarantines += 1;
      quarantined += 1;
      continue;
    }
    if (legacy.accountTaskKeys.has(attribution.taskKey)) {
      throw new Error(`Refusing to resurrect quarantined legacy attribution ${attribution.taskKey}.`);
    }
    const merge = mergeRepositoryIntoAccount(staged.account, evidence, identity, attribution.taskKey);
    if (merge.status === "identity_conflict") {
      await quarantineSink.append(adapterQuarantineRow({
        evidence,
        attribution,
        reason: merge.reason,
        canonicalConflicts: merge.canonicalConflicts,
        legacyQuarantineIds
      }));
      perBatchStats.get(staged.batchSlug).adapterQuarantines += 1;
      quarantined += 1;
      continue;
    }
    integrated += 1;
    integratedTaskKeys.add(attribution.taskKey);
    const stats = perBatchStats.get(staged.batchSlug);
    if (merge.status === "refreshed_existing") stats.canonicalRepositoriesRefreshed += 1;
    else stats.newRepositoriesStoredUnpublished += 1;
  }
  if (integrated > 0 && (
    evidence.requiresAttributionReview ||
    legacyQuarantineIds.length > 0 ||
    evidence.attributions.length > 1 ||
    evidence.attributions.some((attribution) =>
      stagedAccountByTask.get(attribution.taskKey)?.account?.storedButUnpublishedRepos?.some(
        (repository) => repository.contentIdentity?.key === evidence.evidenceId
      )
    )
  )) {
    await writeStoredEvidenceReview({
      evidence,
      stagedAccountByTask,
      runAudit,
      legacy,
      perBatchStats,
      quarantineSink,
      reviewSink,
      reviewIds,
      acceptedTaskKeys: integratedTaskKeys,
      category: "github_exhaustive_repository_stored_or_shared_review",
      reason:
        "Repository evidence is newly stored, shared by multiple canonical owner mappings, or overlaps a legacy physical quarantine. It must be deduplicated by immutable repository ID before any explicit promotion."
    });
  }
  return { quarantinedAllAttributions: quarantined === evidence.attributions.length };
}

function mergeRepositoryIntoAccount(account, evidence, identity, taskKey) {
  const repositories = account.repos;
  const idMatches = repositories.filter((repository) => String(repository.id ?? "") === identity.repositoryId);
  const urlMatches = repositories.filter((repository) =>
    canonicalRepositoryUrl(repository.htmlUrl ?? repository.fullName)?.toLowerCase() ===
    identity.canonicalUrl.toLowerCase()
  );
  const allMatches = [...new Set([...idMatches, ...urlMatches])];
  if (
    idMatches.some((repository) =>
      canonicalRepositoryUrl(repository.htmlUrl ?? repository.fullName)?.toLowerCase() !==
      identity.canonicalUrl.toLowerCase()
    ) ||
    urlMatches.some((repository) => String(repository.id ?? "") !== identity.repositoryId) ||
    allMatches.length > 1
  ) {
    return {
      status: "identity_conflict",
      reason: "github_exhaustive_canonical_repository_identity_conflict",
      canonicalConflicts: allMatches.map((repository) => ({
        id: repository.id ?? null,
        fullName: repository.fullName,
        htmlUrl: repository.htmlUrl
      }))
    };
  }
  const normalized = repositoryProjection(evidence, taskKey);
  if (allMatches.length === 1) {
    const existing = allMatches[0];
    const index = repositories.indexOf(existing);
    repositories[index] = {
      ...existing,
      stars: normalized.stars,
      forks: normalized.forks,
      watchers: normalized.watchers,
      openIssues: normalized.openIssues,
      language: normalized.language ?? existing.language ?? null,
      pushedAt: normalized.pushedAt ?? existing.pushedAt ?? null,
      updatedAt: normalized.updatedAt ?? existing.updatedAt ?? null,
      createdAt: normalized.createdAt ?? existing.createdAt ?? null,
      score: normalized.score,
      exhaustiveRefresh: {
        evidenceId: evidence.evidenceId,
        observedAt: evidence.observedAt,
        publicationState: "existing_canonical_evidence_refreshed",
        scoringEligibility: "already_canonical_identity"
      }
    };
    return { status: "refreshed_existing" };
  }
  account.storedButUnpublishedRepos ??= [];
  const existingStored = account.storedButUnpublishedRepos.find((repository) =>
    repository.contentIdentity?.key === evidence.evidenceId
  );
  if (existingStored) {
    Object.assign(existingStored, normalized);
  } else {
    account.storedButUnpublishedRepos.push(normalized);
  }
  return { status: "stored_unpublished" };
}

function repositoryProjection(evidence, taskKey) {
  const metadata = evidence.metadata ?? {};
  const metrics = evidence.metrics ?? {};
  return {
    id: Number(evidence.physicalRepository.repositoryId),
    name: parseGithubTargetUrl(evidence.canonicalUrl)?.repo,
    fullName: evidence.physicalRepository.fullName,
    description: "",
    htmlUrl: evidence.canonicalUrl,
    stars: nonNegativeInteger(metrics.stars),
    forks: nonNegativeInteger(metrics.forks),
    watchers: nonNegativeInteger(metrics.watchers),
    openIssues: nonNegativeInteger(metrics.openIssues),
    language: clean(metadata.language) || null,
    pushedAt: validTimestamp(metadata.pushedAt),
    updatedAt: validTimestamp(metadata.updatedAt),
    createdAt: validTimestamp(evidence.publishedAt),
    score: repositoryScore(metrics),
    contentIdentity: {
      scheme: "github_repository_id_v1",
      key: evidence.evidenceId,
      repositoryId: evidence.physicalRepository.repositoryId,
      canonicalUrl: evidence.canonicalUrl
    },
    attributionTaskKey: taskKey,
    observedAt: evidence.observedAt,
    publicationState: "stored_but_unpublished",
    scoringEligible: false,
    reviewState: "needs_review"
  };
}

async function writeStoredEvidenceReview({
  evidence,
  stagedAccountByTask,
  runAudit,
  legacy,
  perBatchStats,
  quarantineSink,
  reviewSink,
  reviewIds,
  acceptedTaskKeys = null,
  category,
  reason
}) {
  const identity = repositoryIdentity(evidence);
  const ownerCandidates = [];
  for (const attribution of evidence.attributions) {
    if (acceptedTaskKeys && !acceptedTaskKeys.has(attribution.taskKey)) continue;
    const staged = stagedAccountByTask.get(attribution.taskKey);
    if (!staged) throw new Error(`Stored evidence review references unknown task ${attribution.taskKey}.`);
    const target = runAudit.taskToTarget.get(attribution.taskKey);
    const attributionValidation = validateEvidenceAttribution(evidence, attribution, staged, target);
    if (!attributionValidation.ok) {
      await quarantineSink.append(adapterQuarantineRow({
        evidence,
        attribution,
        reason: attributionValidation.reason,
        legacyQuarantineIds: legacyPhysicalOverlap(legacy, identity)
      }));
      perBatchStats.get(staged.batchSlug).adapterQuarantines += 1;
      continue;
    }
    perBatchStats.get(staged.batchSlug).contentEvidenceStoredUnpublished +=
      evidence.kind === "github_repository" ? 0 : 1;
    ownerCandidates.push({
      taskKey: attribution.taskKey,
      batchSlug: staged.batchSlug,
      entityType: staged.account.entityType,
      entityId: staged.account.entityId,
      entityName: staged.account.name,
      accountUrl: canonicalGithubTargetUrl(staged.account.githubUrl)
    });
  }
  ownerCandidates.sort((left, right) => left.taskKey.localeCompare(right.taskKey));
  if (ownerCandidates.length === 0) return;
  const legacyQuarantineIds = legacyPhysicalOverlap(legacy, identity);
  const review = {
    reviewId: `github-exhaustive-evidence:${sha256(evidence.evidenceId).slice(0, 24)}`,
    category,
    reason,
    contentIdentity: {
      evidenceId: evidence.evidenceId,
      kind: evidence.kind,
      nativeId: evidence.nativeId,
      canonicalUrl: evidence.canonicalUrl,
      repositoryId: identity.repositoryId,
      repositoryUrl: identity.canonicalUrl
    },
    ownerCandidates,
    legacyQuarantineIds,
    publishedAt: evidence.publishedAt ?? null,
    timestampProvenance: evidence.timestampProvenance ?? null,
    observedAt: evidence.observedAt,
    metrics: evidence.metrics ?? {},
    metadata: evidence.metadata ?? {},
    reviewState: "needs_review",
    scoringPolicy: "stored_but_unpublished_until_explicit_promotion",
    scoringEligible: false,
    publicationState: "stored_but_unpublished"
  };
  await appendUniqueReview(reviewSink, reviewIds, review);
}

async function appendUniqueReview(sink, reviewIds, review) {
  if (reviewIds.has(review.reviewId)) throw new Error(`Duplicate exhaustive review ${review.reviewId}.`);
  reviewIds.add(review.reviewId);
  await sink.append(review);
}

async function copyMaterializedQuarantine({ path, expectedRows, quarantineSink }) {
  let rows = 0;
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row?.scoringEligible !== false || !row?.quarantineId || !row?.reason) {
      throw new Error("Materialized GitHub identity-conflict quarantine row is malformed.");
    }
    await quarantineSink.append({
      ...row,
      category: "github_exhaustive_materialized_identity_conflict",
      publicationState: "stored_but_unpublished"
    });
    rows += 1;
  }
  if (rows !== expectedRows) {
    throw new Error(`Materialized quarantine count ${rows} does not match receipt ${expectedRows}.`);
  }
  return rows;
}

async function recordCanonicalRepositoriesNotObserved({
  canonical,
  runAudit,
  observedRepositoryIds,
  observedRepositoryUrls,
  reviewSink,
  reviewIds
}) {
  let rows = 0;
  for (const [taskKey, indexed] of canonical.accountsByTask) {
    const target = runAudit.taskToTarget.get(taskKey);
    const completed = runAudit.completedTargets.get(target.targetKey)?.receipt;
    if (completed?.outcome !== "collected") continue;
    for (const repository of indexed.account.repos) {
      const repositoryId = repository.id == null ? null : String(repository.id);
      const repositoryUrl = canonicalRepositoryUrl(repository.htmlUrl ?? repository.fullName);
      if (
        (repositoryId && observedRepositoryIds.has(repositoryId)) ||
        (repositoryUrl && observedRepositoryUrls.has(repositoryUrl.toLowerCase()))
      ) {
        continue;
      }
      const review = {
        reviewId: `github-exhaustive-missing-canonical:${sha256(`${taskKey}:${repositoryId ?? repositoryUrl}`).slice(0, 24)}`,
        category: "canonical_repository_not_observed_in_completed_exhaustive_run",
        reason:
          "The last-good canonical repository row was preserved, but its physical identity was not observed in the completed exhaustive run. It must not be deleted without manual verification.",
        taskKey,
        batchSlug: indexed.batchSlug,
        canonicalRepository: {
          id: repository.id ?? null,
          fullName: repository.fullName,
          htmlUrl: repository.htmlUrl
        },
        reviewState: "needs_review",
        scoringEligible: false,
        publicationState: "stored_but_unpublished"
      };
      await appendUniqueReview(reviewSink, reviewIds, review);
      rows += 1;
    }
  }
  return rows;
}

function finalizeStagedAccounts(stagedByBatch, runAudit, perBatchStats) {
  for (const [batchSlug, snapshot] of stagedByBatch) {
    for (const account of snapshot.accounts) {
      const taskKey = canonicalAccountTaskKey(batchSlug, account);
      const target = runAudit.taskToTarget.get(taskKey);
      const completed = runAudit.completedTargets.get(target.targetKey).receipt;
      const profile = runAudit.profiles.get(target.targetKey) ?? null;
      account.storedButUnpublishedRepos = dedupeStoredRepositories(
        account.storedButUnpublishedRepos ?? []
      );
      account.exhaustiveBackfill = {
        schemaVersion: GITHUB_EXHAUSTIVE_INTEGRATION_SCHEMA_VERSION,
        targetKey: target.targetKey,
        attributionTaskKey: taskKey,
        outcome: completed.outcome,
        blocker: completed.blocker,
        profile,
        publicationState: "staged",
        newEvidencePublicationPolicy: "stored_but_unpublished",
        storedRepositoryCount: account.storedButUnpublishedRepos.length
      };
      account.exhaustiveAggregate = aggregateStoredRepositories(account.storedButUnpublishedRepos);
    }
    perBatchStats.get(batchSlug).storedUnpublishedRepositories = snapshot.accounts.reduce(
      (total, account) => total + account.storedButUnpublishedRepos.length,
      0
    );
  }
}

function validateStagedSnapshot(staged, original, legacy) {
  if (staged.accounts.length !== original.accounts.length) {
    throw new Error(`${staged.source.batchSlug} staged snapshot changed canonical account cardinality.`);
  }
  for (let index = 0; index < original.accounts.length; index += 1) {
    const before = original.accounts[index];
    const after = staged.accounts[index];
    if (canonicalAccountTaskKey(staged.source.batchSlug, before) !== canonicalAccountTaskKey(staged.source.batchSlug, after)) {
      throw new Error(`${staged.source.batchSlug} staged snapshot changed canonical account identity at ${index}.`);
    }
    if (after.repos.length !== before.repos.length) {
      throw new Error(`${staged.source.batchSlug} staged snapshot changed scoring-visible repository cardinality.`);
    }
    const beforeIdentities = before.repos.map(canonicalRepoIdentity).sort();
    const afterIdentities = after.repos.map(canonicalRepoIdentity).sort();
    if (stableJson(beforeIdentities) !== stableJson(afterIdentities)) {
      throw new Error(`${staged.source.batchSlug} staged snapshot changed a scoring-visible repository identity.`);
    }
    const taskKey = canonicalAccountTaskKey(staged.source.batchSlug, after);
    if (legacy.accountTaskKeys.has(taskKey)) {
      throw new Error(`Staged snapshot resurrected legacy account attribution ${taskKey}.`);
    }
    for (const repository of after.storedButUnpublishedRepos ?? []) {
      if (repository.scoringEligible !== false || repository.publicationState !== "stored_but_unpublished") {
        throw new Error("Staged new repository lost its publication/scoring gate.");
      }
    }
  }
}

function assertLegacyRowsPreserved(before, after) {
  if (
    before.rows.length !== after.rows.length ||
    stableJson(before.rows) !== stableJson(after.rows) ||
    stableJson(before.physicalEvidenceOwnerReview) !== stableJson(after.physicalEvidenceOwnerReview)
  ) {
    throw new Error("Exhaustive integration modified or dropped a legacy quarantine/review row.");
  }
}

function validateMaterializedEvidence(evidence, canonical, runAudit) {
  if (
    !EVIDENCE_KINDS.has(evidence?.kind) ||
    !requiredText(evidence.evidenceId, "evidenceId") ||
    evidence.scoringEligible !== false ||
    evidence.publicationState !== "stored_but_unpublished" ||
    !validTimestamp(evidence.observedAt) ||
    !Array.isArray(evidence.attributions) ||
    evidence.attributions.length === 0
  ) {
    throw new Error(`Materialized evidence ${evidence?.evidenceId ?? "unknown"} is malformed or publication-eligible.`);
  }
  const seenTasks = new Set();
  for (const attribution of evidence.attributions) {
    const taskKey = requiredText(attribution.taskKey, `${evidence.evidenceId}.taskKey`);
    if (seenTasks.has(taskKey)) throw new Error(`${evidence.evidenceId} repeats attribution ${taskKey}.`);
    seenTasks.add(taskKey);
    const canonicalAccount = canonical.accountsByTask.get(taskKey);
    const target = runAudit.taskToTarget.get(taskKey);
    if (!canonicalAccount || !target) throw new Error(`${evidence.evidenceId} references unknown attribution ${taskKey}.`);
    if (
      attribution.batchSlug !== canonicalAccount.batchSlug ||
      attribution.entityType !== canonicalAccount.account.entityType ||
      attribution.entityId !== canonicalAccount.account.entityId
    ) {
      throw new Error(`${evidence.evidenceId} attribution fields conflict with canonical task ${taskKey}.`);
    }
  }
  repositoryIdentity(evidence);
}

function validateEvidenceAttribution(evidence, attribution, staged, target) {
  const accountTarget = parseGithubTargetUrl(target.accountUrl);
  const repositoryTarget = parseGithubTargetUrl(evidence.canonicalUrl);
  if (!accountTarget || !repositoryTarget?.repo) {
    return { ok: false, reason: "github_exhaustive_invalid_physical_or_account_identity" };
  }
  if (accountTarget.repo) {
    if (canonicalGithubTargetUrl(target.accountUrl).toLowerCase() !== canonicalRepositoryUrl(evidence.canonicalUrl).toLowerCase()) {
      return { ok: false, reason: "github_exhaustive_exact_repository_scope_violation" };
    }
  } else if (accountTarget.login.toLowerCase() !== repositoryTarget.login.toLowerCase()) {
    return { ok: false, reason: "github_exhaustive_owner_scope_violation" };
  }
  if (
    attribution.batchSlug !== staged.batchSlug ||
    attribution.entityType !== staged.account.entityType ||
    attribution.entityId !== staged.account.entityId
  ) {
    return { ok: false, reason: "github_exhaustive_attribution_fields_conflict" };
  }
  return { ok: true };
}

function validateCanonicalAccount(account, batchSlug, index) {
  if (
    account?.fetched !== true ||
    !account.entityType ||
    !account.entityId ||
    !canonicalGithubTargetUrl(account.githubUrl) ||
    !Array.isArray(account.repos)
  ) {
    throw new Error(`${batchSlug} canonical account ${index} is malformed.`);
  }
  const ids = new Set();
  const urls = new Set();
  for (const repository of account.repos) {
    const identity = canonicalRepoIdentity(repository);
    if (ids.has(String(repository.id)) || urls.has(identity.split(":").slice(1).join(":"))) {
      throw new Error(`${batchSlug} canonical account ${index} has duplicate repository identities.`);
    }
    ids.add(String(repository.id));
    urls.add(identity.split(":").slice(1).join(":"));
  }
}

function validateProfile(profile) {
  if (!Number.isInteger(Number(profile?.id)) || !clean(profile?.login)) {
    throw new Error("Collected GitHub profile lacks immutable id/login.");
  }
  return profile;
}

function validateTerminalReceipt(receipt, targetKey) {
  if (
    receipt?.targetKey !== targetKey ||
    !["collected", "access_blocked", "manual_review"].includes(receipt.outcome) ||
    !canonicalGithubTargetUrl(receipt.accountUrl)
  ) {
    throw new Error(`${targetKey} has an invalid terminal receipt.`);
  }
  const attributionTaskKeys = uniqueTextArray(
    receipt.attributionTaskKeys,
    `${targetKey}.receipt.attributionTaskKeys`
  );
  if (receipt.outcome === "collected" && receipt.blocker) {
    throw new Error(`${targetKey} collected receipt unexpectedly has a blocker.`);
  }
  if (receipt.outcome !== "collected" && !receipt.blocker?.code) {
    throw new Error(`${targetKey} non-collected receipt lacks an exact blocker.`);
  }
  return { ...receipt, attributionTaskKeys };
}

function validateRequestReceipt(receipt) {
  if (
    !requiredText(receipt?.requestId, "requestId") ||
    !requiredText(receipt?.targetKey, "request targetKey") ||
    !requiredText(receipt?.resource, "request resource") ||
    !receipt.endpoint?.pathname ||
    !["succeeded", "failed", "blocked_without_request", "paused_before_request_budget"].includes(receipt.status) ||
    !Array.isArray(receipt.attempts)
  ) {
    throw new Error("Exhaustive request receipt is malformed.");
  }
  assertNoForbiddenReceiptKeys(receipt);
}

function assertNoForbiddenReceiptKeys(value, path = "receipt") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenReceiptKeys(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_RECEIPT_KEYS.test(key)) {
      throw new Error(`Request receipt contains forbidden credential field ${path}.${key}.`);
    }
    assertNoForbiddenReceiptKeys(nested, `${path}.${key}`);
  }
}

function adapterQuarantineRow({ evidence, attribution, reason, canonicalConflicts = [], legacyQuarantineIds = [] }) {
  return {
    quarantineId: `github-exhaustive-adapter:${sha256(`${evidence.evidenceId}:${attribution.taskKey}:${reason}`).slice(0, 24)}`,
    category: reason,
    reason:
      "The exhaustive evidence could not be merged into this exact canonical owner/repository attribution without an identity conflict.",
    evidenceIdentity: {
      evidenceId: evidence.evidenceId,
      kind: evidence.kind,
      nativeId: evidence.nativeId,
      canonicalUrl: evidence.canonicalUrl,
      repositoryId: evidence.physicalRepository?.repositoryId ?? null
    },
    rejectedAttribution: attribution,
    canonicalConflicts,
    legacyQuarantineIds,
    reviewState: "needs_review",
    scoringEligible: false,
    publicationState: "stored_but_unpublished"
  };
}

function repositoryIdentity(evidence) {
  const repositoryId = requiredText(
    evidence?.physicalRepository?.repositoryId,
    `${evidence?.evidenceId ?? "evidence"}.repositoryId`
  );
  const canonicalUrl = canonicalRepositoryUrl(
    evidence?.physicalRepository?.canonicalUrl ?? evidence?.physicalRepository?.fullName
  );
  if (!canonicalUrl) throw new Error(`${evidence?.evidenceId ?? "Evidence"} has no canonical repository URL.`);
  const parsed = parseGithubTargetUrl(canonicalUrl);
  if (!parsed?.repo) throw new Error(`${evidence.evidenceId} repository URL is an owner URL.`);
  return { repositoryId, canonicalUrl };
}

function indexObservedRepository(byId, byUrl, identity, evidenceId) {
  const priorId = byId.get(identity.repositoryId);
  const priorUrl = byUrl.get(identity.canonicalUrl.toLowerCase());
  if (priorId && priorId !== evidenceId) {
    throw new Error(`Multiple materialized evidence rows share repository id ${identity.repositoryId}.`);
  }
  if (priorUrl && priorUrl !== evidenceId) {
    throw new Error(`Multiple materialized evidence rows share repository URL ${identity.canonicalUrl}.`);
  }
  byId.set(identity.repositoryId, evidenceId);
  byUrl.set(identity.canonicalUrl.toLowerCase(), evidenceId);
}

function legacyPhysicalOverlap(legacy, identity) {
  return [...new Set([
    ...(legacy.repositoryIds.get(identity.repositoryId) ?? []),
    ...(legacy.repositoryUrls.get(identity.canonicalUrl.toLowerCase()) ?? [])
  ])].sort();
}

function canonicalAccountTaskKey(batchSlug, account) {
  const accountUrl = canonicalGithubTargetUrl(account.githubUrl);
  if (!accountUrl) throw new Error(`${batchSlug} canonical account has invalid githubUrl.`);
  return taskKeyFor(batchSlug, account.entityType, account.entityId, accountUrl);
}

function taskKeyFor(batchSlug, entityType, entityId, accountUrl) {
  return `${batchSlug}:${entityType}:${entityId}:${accountUrl.toLowerCase()}`;
}

function canonicalRepoIdentity(repository) {
  const repositoryId = String(repository?.id ?? "");
  const url = canonicalRepositoryUrl(repository?.htmlUrl ?? repository?.fullName);
  if (!repositoryId || !url) throw new Error("Canonical repository lacks id or URL identity.");
  return `${repositoryId}:${url.toLowerCase()}`;
}

function canonicalRepositoryUrl(value) {
  const raw = clean(value);
  if (!raw) return null;
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://github.com/${raw}`;
  const parsed = parseGithubTargetUrl(candidate);
  return parsed?.repo ? `https://github.com/${parsed.login}/${parsed.repo}` : null;
}

function repositoryScore(metrics) {
  const stars = nonNegativeInteger(metrics?.stars);
  const forks = nonNegativeInteger(metrics?.forks);
  const watchers = nonNegativeInteger(metrics?.watchers);
  const issues = nonNegativeInteger(metrics?.openIssues);
  return clamp(
    Math.round(
      Math.log1p(stars) * 14 +
      Math.log1p(forks) * 9 +
      Math.log1p(watchers) * 3 +
      Math.log1p(issues) * 1.5
    ),
    1,
    100
  );
}

function dedupeStoredRepositories(repositories) {
  const byIdentity = new Map();
  for (const repository of repositories) {
    const key = requiredText(repository?.contentIdentity?.key, "stored repository content identity");
    const previous = byIdentity.get(key);
    if (!previous || stableJson(repository) > stableJson(previous)) byIdentity.set(key, repository);
  }
  return [...byIdentity.values()].sort((left, right) =>
    left.contentIdentity.key.localeCompare(right.contentIdentity.key)
  );
}

function aggregateStoredRepositories(repositories) {
  return {
    publicationState: "stored_but_unpublished",
    scoringEligible: false,
    repoCount: repositories.length,
    totalStars: repositories.reduce((total, repository) => total + repository.stars, 0),
    totalForks: repositories.reduce((total, repository) => total + repository.forks, 0),
    totalWatchers: repositories.reduce((total, repository) => total + repository.watchers, 0)
  };
}

class NdjsonSink {
  static async open(finalPath) {
    const sink = new NdjsonSink(finalPath);
    await sink.initialize();
    return sink;
  }

  constructor(finalPath) {
    this.finalPath = finalPath ? resolve(finalPath) : null;
    this.temporaryPath = this.finalPath
      ? `${this.finalPath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
      : null;
    this.handle = null;
    this.hash = createHash("sha256");
    this.rowCount = 0;
    this.closed = false;
    this.published = false;
  }

  async initialize() {
    if (!this.temporaryPath) return;
    await mkdir(dirname(this.temporaryPath), { recursive: true });
    this.handle = await open(this.temporaryPath, "wx");
  }

  async append(value) {
    if (this.closed) throw new Error("Cannot append to a closed NDJSON sink.");
    const line = `${stableJson(value)}\n`;
    this.hash.update(line);
    this.rowCount += 1;
    if (this.handle) await this.handle.write(line);
  }

  async finish() {
    if (this.closed) throw new Error("NDJSON sink was already closed.");
    this.closed = true;
    const sha256Value = this.hash.digest("hex");
    if (this.handle) {
      await this.handle.close();
    }
    return {
      filename: this.finalPath ? basename(this.finalPath) : null,
      path: this.finalPath,
      sha256: sha256Value,
      rowCount: this.rowCount
    };
  }

  async publish() {
    if (!this.closed) throw new Error("NDJSON sink must be finished before publication.");
    if (this.published || !this.temporaryPath) return;
    await rename(this.temporaryPath, this.finalPath);
    this.published = true;
  }

  async abort() {
    if (!this.closed) {
      this.closed = true;
      await this.handle?.close().catch(() => {});
    }
    if (this.temporaryPath && !this.published) await rm(this.temporaryPath, { force: true });
  }
}

function publicArtifactReference(artifact) {
  return {
    filename: artifact.filename,
    sha256: artifact.sha256,
    rowCount: artifact.rowCount,
    publicationState: "stored_but_unpublished",
    scoringEligible: false
  };
}

function assertSafeStagingDirectory(outputDir, { runDir, canonicalPaths, legacyQuarantinePath }) {
  if (!outputDir) throw new Error("An explicit staging output directory is required.");
  if (sameOrInside(outputDir, runDir) || sameOrInside(runDir, outputDir)) {
    throw new Error("Staging outputDir must be separate from the exhaustive live run directory.");
  }
  for (const inputPath of [...canonicalPaths, legacyQuarantinePath]) {
    const artifactDirectory = resolve(dirname(inputPath));
    if (
      sameOrInside(outputDir, artifactDirectory) ||
      sameOrInside(artifactDirectory, outputDir)
    ) {
      throw new Error("Staging outputDir must be separate from canonical artifact directories.");
    }
  }
}

async function assertFreshOutputDirectory(outputDir) {
  try {
    const info = await stat(outputDir);
    if (!info.isDirectory()) throw new Error(`${outputDir} exists and is not a directory.`);
    const markerFiles = [
      "github-exhaustive-integration-receipt.json",
      ...Object.values(BATCH_FILENAMES),
      "github-traction-quarantine.staged.json"
    ];
    for (const marker of markerFiles) {
      try {
        await stat(join(outputDir, marker));
        throw new Error(`Staging output already exists: ${join(outputDir, marker)}.`);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function sameOrInside(candidate, parent) {
  const relation = relative(resolve(parent), resolve(candidate));
  return relation === "" || (
    relation !== ".." &&
    !relation.startsWith("../") &&
    !relation.startsWith("..\\") &&
    !relation.startsWith("/")
  );
}

function assertDistinctPaths(paths) {
  const normalized = paths.map((path) => resolve(path));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Integration inputs must be distinct explicit files.");
  }
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${path}: ${error.message}`, { cause: error });
  }
}

async function fileReceipt(path) {
  const info = await stat(path);
  return {
    path: resolve(path),
    bytes: info.size,
    sha256: await sha256File(path)
  };
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function atomicStableJsonWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, `${stableJson(value)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
}

function assertSameStringSet(left, right, label) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (
    leftSet.size !== left.length ||
    rightSet.size !== right.length ||
    stableJson([...leftSet].sort()) !== stableJson([...rightSet].sort())
  ) {
    throw new Error(`${label} do not reconcile exactly.`);
  }
}

function uniqueTextArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array.`);
  const result = value.map((entry, index) => requiredText(entry, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates.`);
  return result;
}

function addMultiMap(map, key, value) {
  map.set(key, [...(map.get(key) ?? []), value]);
}

function requiredText(value, label) {
  const text = clean(value);
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function validTimestamp(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function clean(value) {
  return String(value ?? "").trim();
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
  );
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}
