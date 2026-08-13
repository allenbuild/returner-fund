import { createHash } from "node:crypto";
import {
  INGESTION_CATALOG_MANIFEST_VERSION,
  INGESTION_CORE_PLATFORMS,
  INGESTION_EXTENDED_ONLY_PLATFORMS,
  computeIngestionCatalogSourceHash
} from "./ingestion-coverage-receipt.mjs";

export const INGESTION_COVERAGE_ADAPTER_VERSION =
  "autonomous-ingestion-coverage-adapter.v1";
export const INGESTION_COVERAGE_PROVENANCE_VERSION =
  "autonomous-ingestion-coverage-provenance.v1";

const PLATFORM_SET = new Set([
  ...INGESTION_CORE_PLATFORMS,
  ...INGESTION_EXTENDED_ONLY_PLATFORMS
]);
const HTTPS_UPGRADEABLE_ACCOUNT_HOSTS = Object.freeze({
  x: new Set(["x.com", "twitter.com", "mobile.twitter.com"]),
  linkedin: new Set(["linkedin.com", "www.linkedin.com"]),
  instagram: new Set(["instagram.com", "www.instagram.com", "m.instagram.com"]),
  github: new Set(["github.com", "www.github.com"]),
  youtube: new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]),
  product_hunt: new Set(["producthunt.com", "www.producthunt.com"]),
  reddit: new Set(["reddit.com", "www.reddit.com", "old.reddit.com", "redd.it"]),
  hacker_news: new Set(["news.ycombinator.com"])
});
const SHA256 = /^[a-f0-9]{64}$/;
const ENTITY_TYPES = new Set(["company", "founder"]);

/**
 * Convert the autonomous runner's live catalog, task, collector, and event
 * formats to the flat contract consumed by buildIngestionCoverageReceipt.
 *
 * collectorArtifacts, taskPlan, and runnerLogs may be AsyncIterables. The
 * adapter consumes each source once and retains only normalized output rows,
 * identity indexes, and compact provenance counters. Memory is therefore
 * bounded by the receipt output rather than by a second copy of raw payloads.
 */
export async function adaptAutonomousIngestionCoverage({
  runId = null,
  idempotencyKey,
  campaignKey,
  generatedAt,
  recentCoverageCutoff = null,
  catalogs,
  expectedCatalogManifest,
  taskPlan,
  collectorArtifacts,
  runnerLogs,
  runnerLogArtifact,
  pairScopes = [],
  multiAttributionReviews = []
} = {}) {
  const receiptTime = canonicalTimestamp(generatedAt, "generatedAt");
  const normalizedIdempotencyKey = requiredText(idempotencyKey, "idempotencyKey");
  const normalizedCampaignKey = requiredText(campaignKey, "campaignKey");
  const logState = await consumeRunnerLogs({
    runnerLogs,
    artifact: runnerLogArtifact,
    generatedAt: receiptTime
  });
  const run = {
    idempotencyKey: normalizedIdempotencyKey,
    campaignKey: normalizedCampaignKey,
    startedAt: logState.startedAt,
    completedAt: logState.completedAt,
    ...(recentCoverageCutoff ? {
      recentCoverageCutoff: canonicalTimestamp(
        recentCoverageCutoff,
        "recentCoverageCutoff"
      )
    } : {})
  };
  if (Date.parse(run.completedAt) > Date.parse(receiptTime)) {
    throw new Error("Runner completion cannot be later than generatedAt.");
  }
  if (
    run.recentCoverageCutoff &&
    Date.parse(run.recentCoverageCutoff) > Date.parse(run.startedAt)
  ) {
    throw new Error("recentCoverageCutoff must be pinned no later than runner start.");
  }

  const normalizedCatalogs = normalizeAutonomousIngestionCatalogs(catalogs);
  const entityIndex = buildCatalogEntityIndex(normalizedCatalogs);
  validateExpectedManifestShape(expectedCatalogManifest);

  const state = {
    run,
    generatedAt: receiptTime,
    entityIndex,
    tasks: new Map(),
    planTaskKeys: new Set(),
    tasksByPair: new Map(),
    pendingOutcomes: [],
    pendingEvidence: [],
    attemptIds: new Map(),
    artifactPaths: new Set(),
    artifactProvenance: [],
    outcomesByTask: new Map()
  };

  await consumeTaskPlan(taskPlan, state);
  for await (const envelope of asAsyncIterable(collectorArtifacts, "collectorArtifacts")) {
    await consumeCollectorArtifact(envelope, state);
  }
  applyRunnerCollectorFailures(logState.collectionFailures, state);

  const tasks = [...state.tasks.values()]
    .map((entry) => entry.output)
    .sort((left, right) => left.taskKey.localeCompare(right.taskKey));
  const outcomes = finalizeOutcomes(state);
  const evidence = finalizeEvidence(state);
  const normalizedScopes = normalizePassThroughRows(pairScopes, "pairScopes");
  const normalizedReviews = normalizePassThroughRows(
    multiAttributionReviews,
    "multiAttributionReviews"
  );

  const planHash = hashCanonicalRows(tasks);
  const provenance = {
    schemaVersion: INGESTION_COVERAGE_PROVENANCE_VERSION,
    adapterVersion: INGESTION_COVERAGE_ADAPTER_VERSION,
    generatedAt: receiptTime,
    run: { ...run },
    catalogs: normalizedCatalogs.map((catalog) => ({
      batchSlug: catalog.batchSlug,
      sourcePath: catalog.sourcePath,
      sourceVersion: catalog.sourceVersion,
      canonicalSourceHash: catalog.sourceHash,
      companies: catalog.companies.length,
      founders: catalog.companies.reduce(
        (sum, company) => sum + company.founders.length,
        0
      )
    })),
    taskPlan: {
      hashAlgorithm: "sha256",
      hashKind: "normalized_rows",
      sha256: planHash,
      tasks: tasks.length
    },
    runnerLog: logState.provenance,
    collectorArtifacts: [...state.artifactProvenance].sort(compareArtifacts),
    normalizedRows: {
      tasks: tasks.length,
      outcomes: outcomes.length,
      evidence: evidence.length,
      pairScopes: normalizedScopes.length,
      multiAttributionReviews: normalizedReviews.length
    }
  };

  return {
    runId: clean(runId) || normalizedIdempotencyKey,
    run,
    idempotencyKey: normalizedIdempotencyKey,
    campaignKey: normalizedCampaignKey,
    generatedAt: receiptTime,
    catalogs: normalizedCatalogs,
    expectedCatalogManifest: structuredClone(expectedCatalogManifest),
    tasks,
    outcomes,
    evidence,
    pairScopes: normalizedScopes,
    multiAttributionReviews: normalizedReviews,
    provenance
  };
}

/** Normalize the live loadAutonomousCatalogs() shape without collector fields. */
export function normalizeAutonomousIngestionCatalogs(catalogs) {
  if (!Array.isArray(catalogs) || catalogs.length === 0) {
    throw new TypeError("catalogs must be a non-empty array.");
  }
  const seenBatches = new Set();
  const normalized = catalogs.map((catalog, catalogIndex) => {
    assertObject(catalog, `catalogs[${catalogIndex}]`);
    const batchSlug = requiredText(
      catalog.batchSlug ?? catalog.slug,
      `catalogs[${catalogIndex}].batchSlug`
    );
    if (seenBatches.has(batchSlug)) throw new Error(`Duplicate catalog batch ${batchSlug}.`);
    seenBatches.add(batchSlug);
    if (!Array.isArray(catalog.companies)) {
      throw new TypeError(`${batchSlug}.companies must be an array.`);
    }
    const companies = catalog.companies.map((company, companyIndex) =>
      normalizeCatalogCompany(company, batchSlug, companyIndex)
    );
    const sourcePath = requiredText(
      catalog.sourcePath ?? catalog.catalogFile ?? catalog.graphFile,
      `${batchSlug}.sourcePath`
    );
    const sourceVersion = requiredText(
      catalog.sourceVersion ?? catalog.generatedAt ?? catalog.version ??
        `${batchSlug}:canonical-roster`,
      `${batchSlug}.sourceVersion`
    );
    const draft = { batchSlug, sourcePath, sourceVersion, companies };
    return {
      ...draft,
      sourceHash: computeIngestionCatalogSourceHash(draft)
    };
  });
  return normalized.sort((left, right) => left.batchSlug.localeCompare(right.batchSlug));
}

/** Incrementally hash a byte/string stream without concatenating it in memory. */
export async function sha256IngestionCoverageArtifact(chunks) {
  const hash = createHash("sha256");
  let count = 0;
  for await (const chunk of asAsyncIterable(chunks, "chunks")) {
    if (typeof chunk !== "string" && !ArrayBuffer.isView(chunk)) {
      throw new TypeError("Artifact hash chunks must be strings or byte-array views.");
    }
    hash.update(chunk);
    count += 1;
  }
  if (count === 0) throw new Error("Artifact hash stream must not be empty.");
  return hash.digest("hex");
}

async function consumeRunnerLogs({ runnerLogs, artifact, generatedAt }) {
  const normalizedArtifact = normalizeArtifactDescriptor(
    artifact,
    "runner_log",
    generatedAt,
    { requireWithinRun: false }
  );
  const hash = createHash("sha256");
  let startedAt = null;
  let completedAt = null;
  let firstEventAt = null;
  let lastEventAt = null;
  let events = 0;
  const collectionFailures = [];
  for await (const rawEvent of asAsyncIterable(runnerLogs, "runnerLogs")) {
    assertObject(rawEvent, `runnerLogs[${events}]`);
    const eventType = requiredText(
      rawEvent.eventType ?? rawEvent.event_type,
      `runnerLogs[${events}].eventType`
    );
    const createdAt = canonicalTimestamp(
      rawEvent.createdAt ?? rawEvent.created_at ?? rawEvent.timestamp,
      `runnerLogs[${events}].createdAt`
    );
    if (Date.parse(createdAt) > Date.parse(generatedAt)) {
      throw new Error(`Runner event ${eventType} is later than generatedAt.`);
    }
    const payload = rawEvent.payload ?? rawEvent.payload_json ?? {};
    assertObject(payload, `runnerLogs[${events}].payload`);
    const normalizedEvent = {
      eventType,
      createdAt,
      severity: clean(rawEvent.severity) || null,
      message: clean(rawEvent.message) || null,
      payload
    };
    hash.update(stableJson(normalizedEvent));
    hash.update("\n");
    events += 1;
    firstEventAt = firstEventAt === null || createdAt < firstEventAt ? createdAt : firstEventAt;
    lastEventAt = lastEventAt === null || createdAt > lastEventAt ? createdAt : lastEventAt;
    if (eventType === "run.started") {
      if (startedAt !== null) throw new Error("Runner log contains duplicate run.started events.");
      startedAt = createdAt;
    } else if (eventType === "run.completed") {
      if (completedAt !== null) throw new Error("Runner log contains duplicate run.completed events.");
      completedAt = createdAt;
    } else if (eventType === "collection.finished") {
      if (!Array.isArray(payload.results)) {
        throw new TypeError("collection.finished payload.results must be an array.");
      }
      for (const result of payload.results) {
        assertObject(result, "collection.finished result");
        if (result.ok !== false) continue;
        collectionFailures.push({
          kind: normalizeCollectorKind(result.kind),
          batchSlug: requiredText(result.batchSlug, "collection result.batchSlug"),
          error: requireOperationalReason(
            result.error,
            `collection result ${result.kind}/${result.batchSlug}.error`
          ),
          checkedAt: createdAt
        });
      }
    }
  }
  if (events === 0) throw new Error("runnerLogs must contain structured current-run events.");
  if (!startedAt || !completedAt) {
    throw new Error("runnerLogs must contain exactly one run.started and run.completed event.");
  }
  if (Date.parse(startedAt) > Date.parse(completedAt)) {
    throw new Error("run.started must not be later than run.completed.");
  }
  if (
    Date.parse(normalizedArtifact.observedAt) < Date.parse(startedAt) ||
    Date.parse(normalizedArtifact.observedAt) > Date.parse(generatedAt)
  ) {
    throw new Error("runnerLogArtifact.observedAt must be within the current run/read window.");
  }
  return {
    startedAt,
    completedAt,
    collectionFailures,
    provenance: {
      ...normalizedArtifact,
      normalizedEventSha256: hash.digest("hex"),
      events,
      firstEventAt,
      lastEventAt
    }
  };
}

async function consumeTaskPlan(taskPlan, state) {
  let rowIndex = 0;
  for await (const rawTask of asAsyncIterable(taskPlan, "taskPlan")) {
    assertObject(rawTask, `taskPlan[${rowIndex}]`);
    const identity = normalizePairIdentity(rawTask, `taskPlan[${rowIndex}]`);
    assertCatalogIdentity(identity, state.entityIndex, `taskPlan[${rowIndex}]`);
    const taskKey = requiredText(
      rawTask.taskKey ?? rawTask.checkpointKey,
      `taskPlan[${rowIndex}].taskKey`
    );
    if (state.tasks.has(taskKey)) throw new Error(`Duplicate taskKey ${taskKey}.`);
    const account = rawTask.account === null || rawTask.account === undefined
      ? null
      : normalizeAccount(rawTask.account, identity.platform, `taskPlan[${rowIndex}].account`);
    const terminalReason = clean(rawTask.terminalReason);
    const reasonCode = terminalReason === "collector_not_applicable_to_founder"
      ? "not_applicable"
      : terminalReason.startsWith("collector_")
        ? "collector_unavailable"
        : null;
    const reason = reasonCode === "not_applicable"
      ? `${taskKey} is not applicable to the ${identity.entityType} in the live autonomous task plan.`
      : reasonCode === "collector_unavailable"
        ? `${taskKey} has no configured collector in the live autonomous task plan (${terminalReason}).`
        : null;
    const output = compact({
      taskKey,
      ...identity,
      account,
      reasonCode,
      reason
    });
    addTask(state, {
      output,
      pairKey: pairIdentityKey(identity),
      accountComparisonKey: account ? accountComparisonKey(account.platform, account.url) : null,
      isPlanTask: true,
      planStatus: clean(rawTask.status) || "queued"
    });
    state.planTaskKeys.add(taskKey);
    rowIndex += 1;
  }
  if (rowIndex === 0) throw new Error("taskPlan must not be empty.");
}

async function consumeCollectorArtifact(envelope, state) {
  assertObject(envelope, "collector artifact envelope");
  const allowed = new Set(["kind", "artifact", "snapshot"]);
  for (const key of Object.keys(envelope)) {
    if (!allowed.has(key)) throw new Error(`Unknown collector artifact envelope field ${key}.`);
  }
  const kind = normalizeCollectorKind(envelope.kind);
  const artifact = normalizeArtifactDescriptor(
    envelope.artifact,
    kind,
    state.generatedAt,
    { run: state.run, requireWithinRun: true }
  );
  if (state.artifactPaths.has(artifact.path)) {
    throw new Error(`Duplicate collector artifact path ${artifact.path}.`);
  }
  state.artifactPaths.add(artifact.path);
  assertObject(envelope.snapshot, `${kind} snapshot`);
  const counters = kind === "public"
    ? consumePublicSnapshot(envelope.snapshot, artifact, state)
    : kind === "github"
      ? consumeGithubSnapshot(envelope.snapshot, artifact, state)
      : consumeTargetedSnapshot(envelope.snapshot, artifact, state);
  state.artifactProvenance.push({ ...artifact, ...counters });
}

function consumePublicSnapshot(snapshot, artifact, state) {
  assertArray(snapshot.evidence ?? [], "public snapshot.evidence");
  assertArray(snapshot.needsReview ?? [], "public snapshot.needsReview");
  assertArray(snapshot.failures ?? [], "public snapshot.failures");
  const attempts = normalizedAttemptEntries(snapshot.attempts, "public snapshot.attempts");
  const sourceBatch = clean(snapshot.source?.batchSlug) || null;
  const context = [];
  const usedTaskAttempts = new Set();
  for (const [entryKey, attempt] of attempts) {
    const identity = normalizePairIdentity(
      { ...attempt, batchSlug: attempt.batchSlug ?? sourceBatch },
      `public attempt ${entryKey}`
    );
    assertCatalogIdentity(identity, state.entityIndex, `public attempt ${entryKey}`);
    const account = clean(attempt.accountUrl)
      ? normalizeAccount(
          { url: attempt.accountUrl, verificationStatus: "unknown" },
          identity.platform,
          `public attempt ${entryKey}.account`
        )
      : null;
    let task = resolvePlanTask(state, identity, account?.url ?? null, {
      label: `public attempt ${entryKey}`
    });
    if (usedTaskAttempts.has(task.output.taskKey)) {
      const sourceAttemptKey = attempt.attemptKey ?? entryKey;
      const supplementalTaskKey =
        `public-attempt:${artifact.sha256}:${pairIdentityKey(identity)}:${sha256(sourceAttemptKey)}`;
      task = addSupplementalTask(state, supplementalTaskKey, identity, account);
    }
    usedTaskAttempts.add(task.output.taskKey);
    const timing = currentRunTiming(attempt, artifact, state.run, `public attempt ${entryKey}`);
    const status = normalizedCollectorStatus(attempt);
    const reason = collectorReason(attempt, status, `public attempt ${entryKey}`);
    const reasonCode = reasonCodeFor(status, reason);
    const attemptId = normalizedAttemptId(
      attempt.attemptId,
      artifact.sha256,
      attempt.attemptKey ?? entryKey,
      timing.checkedAt
    );
    const pending = {
      ...identity,
      taskKey: task.output.taskKey,
      account,
      attemptId,
      startedAt: timing.startedAt,
      checkedAt: timing.checkedAt,
      status,
      reasonCode,
      reason,
      nextAction: nextActionFor(reasonCode, task.output.taskKey),
      profileReceipt: profileReceiptFor({
        status,
        account,
        checkedAt: timing.checkedAt,
        attemptId,
        artifactHash: artifact.sha256,
        source: attempt
      })
    };
    addOutcome(state, pending, {
      sourceArtifact: artifact.path,
      sourceAttemptKey: attempt.attemptKey ?? entryKey
    });
    context.push({
      pending,
      task,
      accountComparisonKey: task.accountComparisonKey,
      sourceAttemptKey: attempt.attemptKey ?? entryKey,
      mayExpandStartedAt: !clean(attempt.startedAt)
    });
  }

  let evidenceCount = 0;
  for (const row of snapshot.evidence ?? []) {
    const evidence = normalizeNativeEvidence(row, {
      artifact,
      state,
      sourceBatch,
      sourceKind: "public",
      context
    });
    state.pendingEvidence.push(evidence);
    evidenceCount += 1;
  }
  consumeUnrepresentedReviewRows(snapshot.needsReview ?? [], {
    artifact,
    state,
    sourceBatch,
    sourceKind: "public",
    context
  });
  consumeUnrepresentedFailureRows(snapshot.failures ?? [], {
    artifact,
    state,
    sourceBatch,
    sourceKind: "public",
    context
  });
  return {
    batchSlug: sourceBatch,
    attempts: attempts.length,
    evidence: evidenceCount,
    needsReview: snapshot.needsReview?.length ?? 0,
    failures: snapshot.failures?.length ?? 0
  };
}

function consumeGithubSnapshot(snapshot, artifact, state) {
  assertArray(snapshot.accounts ?? [], "github snapshot.accounts");
  const attempts = normalizedAttemptEntries(snapshot.attempts, "github snapshot.attempts");
  const batchSlug = requiredText(snapshot.source?.batchSlug, "github snapshot.source.batchSlug");
  const accountEntities = new Set();
  const seenAccounts = new Set();
  const usedTaskAccounts = new Map();
  let evidenceCount = 0;

  for (let index = 0; index < (snapshot.accounts ?? []).length; index += 1) {
    const row = snapshot.accounts[index];
    assertObject(row, `github snapshot.accounts[${index}]`);
    const identity = normalizePairIdentity(
      { ...row, batchSlug, platform: "github" },
      `github account ${index}`
    );
    assertCatalogIdentity(identity, state.entityIndex, `github account ${index}`);
    const githubUrl = requiredText(
      row.githubUrl ?? row.account?.htmlUrl,
      `github account ${index}.githubUrl`
    );
    const account = normalizeAccount(
      {
        url: githubUrl,
        handle: row.login ?? row.account?.login ?? null,
        verificationStatus: row.reviewState ?? "unknown"
      },
      "github",
      `github account ${index}`
    );
    const comparison = accountComparisonKey(account.platform, account.url);
    const accountIdentity = `${entityIdentityKey(identity)}\u0000${comparison}`;
    if (seenAccounts.has(accountIdentity)) {
      throw new Error(`Duplicate GitHub account row for ${account.url} on ${entityIdentityKey(identity)}.`);
    }
    seenAccounts.add(accountIdentity);
    let task = resolvePlanTask(state, identity, account.url, {
      label: `github account ${index}`
    });
    const priorComparison = usedTaskAccounts.get(task.output.taskKey);
    if (priorComparison && priorComparison !== comparison) {
      const supplementalTaskKey =
        `github-discovered:${artifact.sha256}:${pairIdentityKey(identity)}:${sha256(comparison)}`;
      task = addSupplementalTask(state, supplementalTaskKey, identity, account);
    }
    usedTaskAccounts.set(task.output.taskKey, comparison);
    const timing = currentRunTiming(
      { checkedAt: row.checkedAt ?? snapshot.source?.fetchedAt },
      artifact,
      state.run,
      `github account ${index}`
    );
    if (typeof row.fetched !== "boolean") {
      throw new TypeError(`github account ${index}.fetched must be boolean.`);
    }
    const status = row.fetched ? "completed" : "failed";
    const reason = row.fetched
      ? `GitHub collector fetched native account ${account.url}.`
      : requireOperationalReason(
          row.error,
          `github account ${index}.error`
        );
    const reasonCode = reasonCodeFor(status, reason);
    const attemptId = normalizedAttemptId(
      row.attemptId,
      artifact.sha256,
      row.attemptKey ?? `account:${identity.entityType}:${identity.entityId}:${account.url}`,
      timing.checkedAt
    );
    addOutcome(state, {
      ...identity,
      taskKey: task.output.taskKey,
      account,
      attemptId,
      startedAt: timing.startedAt,
      checkedAt: timing.checkedAt,
      status,
      reasonCode,
      reason,
      nextAction: nextActionFor(reasonCode, task.output.taskKey),
      profileReceipt: profileReceiptFor({
        status,
        account,
        checkedAt: timing.checkedAt,
        attemptId,
        artifactHash: artifact.sha256,
        source: row.account ?? row
      })
    }, {
      sourceArtifact: artifact.path,
      sourceAttemptKey: row.attemptKey ?? account.url
    });
    accountEntities.add(entityIdentityKey(identity));
    if (!Array.isArray(row.repos ?? [])) {
      throw new TypeError(`github account ${index}.repos must be an array.`);
    }
    for (const repository of row.repos ?? []) {
      assertObject(repository, `github account ${index}.repository`);
      state.pendingEvidence.push(normalizeGithubRepositoryEvidence(repository, {
        identity,
        task,
        account,
        attemptId,
        checkedAt: timing.checkedAt,
        artifact
      }));
      evidenceCount += 1;
    }
  }

  for (const [entryKey, attempt] of attempts) {
    const identity = normalizePairIdentity(
      { ...attempt, batchSlug, platform: "github" },
      `github attempt ${entryKey}`
    );
    if (accountEntities.has(entityIdentityKey(identity))) continue;
    assertCatalogIdentity(identity, state.entityIndex, `github attempt ${entryKey}`);
    const task = resolvePlanTask(state, identity, null, {
      label: `github attempt ${entryKey}`
    });
    const timing = currentRunTiming(attempt, artifact, state.run, `github attempt ${entryKey}`);
    const mappedCount = nonNegativeInteger(
      attempt.mappedAccountCount ?? 0,
      `github attempt ${entryKey}.mappedAccountCount`
    );
    const status = mappedCount > 0 ? "needs_review" : normalizedCollectorStatus(attempt);
    const baseReason = mappedCount > 0
      ? `GitHub discovery reported ${mappedCount} mapped account(s) but no account payload was present in this artifact.`
      : collectorReason(attempt, status, `github attempt ${entryKey}`);
    const reasonCode = mappedCount > 0
      ? "manual_review_required"
      : status === "completed"
        ? "no_match"
        : reasonCodeFor(status, baseReason);
    const normalizedStatus = status === "completed" ? "queued" : status;
    const reason = status === "completed"
      ? `GitHub discovery completed without a verified native account for ${identity.entityId}; no account is not exhaustive absence proof.`
      : baseReason;
    addOutcome(state, {
      ...identity,
      taskKey: task.output.taskKey,
      account: null,
      attemptId: normalizedAttemptId(
        attempt.attemptId,
        artifact.sha256,
        attempt.attemptKey ?? entryKey,
        timing.checkedAt
      ),
      startedAt: timing.startedAt,
      checkedAt: timing.checkedAt,
      status: normalizedStatus,
      reasonCode,
      reason,
      nextAction: nextActionFor(reasonCode, task.output.taskKey),
      profileReceipt: null
    }, {
      sourceArtifact: artifact.path,
      sourceAttemptKey: attempt.attemptKey ?? entryKey
    });
  }
  return {
    batchSlug,
    attempts: attempts.length,
    accounts: snapshot.accounts?.length ?? 0,
    evidence: evidenceCount,
    needsReview: 0,
    failures: (snapshot.accounts ?? []).filter((row) => row.fetched === false).length
  };
}

function consumeTargetedSnapshot(rawSnapshot, artifact, state) {
  const snapshot = rawSnapshot.isolatedEvidence?.snapshot ?? rawSnapshot;
  assertObject(snapshot, "targeted snapshot payload");
  assertArray(snapshot.evidence ?? [], "targeted snapshot.evidence");
  assertArray(snapshot.needsReview ?? [], "targeted snapshot.needsReview");
  const sourceBatch = clean(snapshot.source?.batchSlug) || null;
  const contexts = new Map();
  let evidenceCount = 0;
  for (const row of snapshot.evidence ?? []) {
    const identity = normalizePairIdentity(
      { ...row, batchSlug: row.batchSlug ?? sourceBatch },
      "targeted evidence"
    );
    assertCatalogIdentity(identity, state.entityIndex, "targeted evidence");
    const context = targetedContext(identity, artifact, state, contexts, "completed");
    state.pendingEvidence.push(normalizeNativeEvidence(row, {
      artifact,
      state,
      sourceBatch,
      sourceKind: "targeted",
      context: [context]
    }));
    evidenceCount += 1;
  }
  for (const row of snapshot.needsReview ?? []) {
    const identity = normalizePairIdentity(
      { ...row, batchSlug: row.batchSlug ?? sourceBatch },
      "targeted needsReview"
    );
    assertCatalogIdentity(identity, state.entityIndex, "targeted needsReview");
    targetedContext(identity, artifact, state, contexts, "needs_review", row.matchReason);
  }
  return {
    batchSlug: sourceBatch,
    attempts: contexts.size,
    evidence: evidenceCount,
    needsReview: snapshot.needsReview?.length ?? 0,
    failures: 0
  };
}

function targetedContext(identity, artifact, state, contexts, status, rawReason = null) {
  const pairKey = pairIdentityKey(identity);
  const contextKey = `${status}:${pairKey}`;
  const existing = contexts.get(contextKey);
  if (existing) return existing;
  const taskKey = status === "completed"
    ? `targeted:${artifact.sha256}:${pairKey}`
    : `targeted-review:${artifact.sha256}:${pairKey}`;
  const task = addSupplementalTask(state, taskKey, identity, null);
  const checkedAt = artifact.observedAt;
  const reason = status === "completed"
    ? `Targeted collector persisted verified native evidence for ${pairKey}.`
    : requireOperationalReason(
        rawReason ?? `Targeted collector requires manual attribution review for ${pairKey}.`,
        `${pairKey} targeted review reason`
      );
  const reasonCode = status === "completed" ? null : "manual_review_required";
  const pending = {
    ...identity,
    taskKey,
    account: null,
    attemptId: normalizedAttemptId(null, artifact.sha256, taskKey, checkedAt),
    startedAt: checkedAt,
    checkedAt,
    status,
    reasonCode,
    reason,
    nextAction: nextActionFor(reasonCode, taskKey),
    profileReceipt: null
  };
  addOutcome(state, pending, {
    sourceArtifact: artifact.path,
    sourceAttemptKey: taskKey
  });
  const context = { pending, task, accountComparisonKey: null };
  contexts.set(contextKey, context);
  return context;
}

function normalizeNativeEvidence(row, {
  artifact,
  state,
  sourceBatch,
  sourceKind,
  context
}) {
  assertObject(row, `${sourceKind} evidence`);
  if (["needs_review", "rejected"].includes(clean(row.review_state ?? row.reviewState).toLowerCase())) {
    throw new Error(`${sourceKind} evidence cannot contain an unverified review row.`);
  }
  const identity = normalizePairIdentity(
    { ...row, batchSlug: row.batchSlug ?? row.batch_slug ?? sourceBatch },
    `${sourceKind} evidence`
  );
  assertCatalogIdentity(identity, state.entityIndex, `${sourceKind} evidence`);
  const candidates = context
    .filter((candidate) => pairIdentityKey(candidate.pending) === pairIdentityKey(identity))
    .filter((candidate) => isSuccessStatus(candidate.pending.status));
  const rowAccountUrl = clean(row.accountUrl);
  const observedAt = currentObservationTimestamp(
    row,
    artifact,
    state.run,
    `${sourceKind} evidence`
  );
  let matched = rowAccountUrl
    ? candidates.filter((candidate) =>
        candidate.pending.account &&
        accountComparisonKey(identity.platform, candidate.pending.account.url) ===
          accountComparisonKey(identity.platform, rowAccountUrl)
      )
    : candidates;
  if (!matched.length) {
    const taskKey = `${sourceKind}-native:${artifact.sha256}:${pairIdentityKey(identity)}`;
    let supplemental = context.find((candidate) => candidate.pending.taskKey === taskKey);
    if (!supplemental) {
      const task = state.tasks.get(taskKey) ?? addSupplementalTask(state, taskKey, identity, null);
      const checkedAt = currentObservationTimestamp(row, artifact, state.run, `${sourceKind} evidence`);
      const pending = {
        ...identity,
        taskKey,
        account: null,
        attemptId: normalizedAttemptId(null, artifact.sha256, taskKey, checkedAt),
        startedAt: checkedAt,
        checkedAt,
        status: "completed",
        reasonCode: null,
        reason: `${sourceKind} artifact contains verified native evidence for ${pairIdentityKey(identity)}.`,
        nextAction: nextActionFor(null, taskKey),
        profileReceipt: null
      };
      addOutcome(state, pending, {
        sourceArtifact: artifact.path,
        sourceAttemptKey: taskKey
      });
      supplemental = {
        pending,
        task,
        accountComparisonKey: null,
        mayExpandStartedAt: true,
        mayExpandCheckedAt: true
      };
      context.push(supplemental);
    }
    matched = [supplemental];
  }
  const distinctTasks = new Set(matched.map((candidate) => candidate.pending.taskKey));
  if (distinctTasks.size > 1) {
    throw new Error(
      `${sourceKind} evidence for ${pairIdentityKey(identity)} is ambiguous across tasks: ` +
      [...distinctTasks].sort().join(", ")
    );
  }
  matched.sort((left, right) =>
    left.pending.checkedAt.localeCompare(right.pending.checkedAt) ||
    left.pending.attemptId.localeCompare(right.pending.attemptId)
  );
  const selectedContext = matched.at(-1);
  const selected = selectedContext.pending;
  if (
    observedAt < selected.startedAt &&
    observedAt <= selected.checkedAt &&
    selectedContext.mayExpandStartedAt === true
  ) {
    // Merged resumable snapshots can retain evidence observed by an earlier
    // checkpoint while replacing the logical attempt's checkedAt. When the
    // source omitted an explicit startedAt, bind that same attempt to the
    // earliest exact in-run evidence observation instead of inventing a fresh
    // collection or dropping the retained native row.
    selected.startedAt = observedAt;
  }
  if (
    observedAt > selected.checkedAt &&
    selectedContext.mayExpandCheckedAt === true
  ) {
    selected.checkedAt = observedAt;
  }
  const canonicalUrl = clean(row.canonicalUrl ?? row.sourceUrl ?? row.url) || null;
  const nativeId = clean(
    row.nativeId ?? row.platformPostId ?? row.platform_post_id ?? row.platformObjectId
  ) || null;
  if (!canonicalUrl && !nativeId) {
    throw new Error(`${sourceKind} evidence requires a native ID or canonical URL.`);
  }
  const publishedAt = canonicalTimestamp(
    row.publishedAt ?? row.postedAt ?? row.last_updated_at,
    `${sourceKind} evidence.publishedAt`
  );
  return compact({
    ...identity,
    nativeId,
    canonicalUrl,
    digest: validSha256(row.digest)
      ? row.digest
      : hashEvidencePayload(row, identity, nativeId, canonicalUrl, publishedAt),
    publishedAt,
    observedAt,
    taskKey: selected.taskKey,
    attemptId: selected.attemptId,
    accountUrl: rowAccountUrl || selected.account?.url || null,
    storedUnpublished: row.storedUnpublished === true || row.stored_unpublished === true
  });
}

function normalizeGithubRepositoryEvidence(repository, {
  identity,
  task,
  account,
  attemptId,
  checkedAt,
  artifact
}) {
  const canonicalUrl = requiredText(
    repository.htmlUrl ?? repository.url,
    "GitHub repository.htmlUrl"
  );
  const nativeId = clean(repository.id ?? repository.fullName) || null;
  const publishedAt = canonicalTimestamp(
    repository.pushedAt ?? repository.updatedAt ?? repository.createdAt,
    "GitHub repository publication timestamp"
  );
  return {
    ...identity,
    nativeId,
    canonicalUrl,
    digest: validSha256(repository.digest)
      ? repository.digest
      : sha256(stableJson({
          adapterVersion: INGESTION_COVERAGE_ADAPTER_VERSION,
          platform: "github",
          nativeId,
          canonicalUrl,
          publishedAt,
          fullName: clean(repository.fullName) || null,
          stars: finiteNumberOrNull(repository.stars),
          forks: finiteNumberOrNull(repository.forks),
          watchers: finiteNumberOrNull(repository.watchers),
          openIssues: finiteNumberOrNull(repository.openIssues),
          artifactSha256: artifact.sha256
        })),
    publishedAt,
    observedAt: checkedAt,
    taskKey: task.output.taskKey,
    attemptId,
    accountUrl: account.url,
    storedUnpublished: repository.storedUnpublished === true
  };
}

function consumeUnrepresentedReviewRows(rows, context) {
  for (const row of rows) {
    assertObject(row, `${context.sourceKind} needsReview row`);
    const identity = normalizePairIdentity(
      { ...row, batchSlug: row.batchSlug ?? row.batch_slug ?? context.sourceBatch },
      `${context.sourceKind} needsReview row`
    );
    if (context.context.some((candidate) =>
      pairIdentityKey(candidate.pending) === pairIdentityKey(identity) &&
      candidate.pending.status === "needs_review"
    )) continue;
    const taskKey = `${context.sourceKind}-review:${context.artifact.sha256}:${pairIdentityKey(identity)}`;
    const task = addSupplementalTask(context.state, taskKey, identity, null);
    const reason = requireOperationalReason(
      `Collector requires manual review for ${pairIdentityKey(identity)} because the candidate was not verified as native evidence.`,
      `${taskKey}.reason`
    );
    const pending = {
      ...identity,
      taskKey,
      account: null,
      attemptId: normalizedAttemptId(null, context.artifact.sha256, taskKey, context.artifact.observedAt),
      startedAt: context.artifact.observedAt,
      checkedAt: context.artifact.observedAt,
      status: "needs_review",
      reasonCode: "manual_review_required",
      reason,
      nextAction: nextActionFor("manual_review_required", taskKey),
      profileReceipt: null
    };
    addOutcome(context.state, pending, {
      sourceArtifact: context.artifact.path,
      sourceAttemptKey: taskKey
    });
    context.context.push({ pending, task, accountComparisonKey: null });
  }
}

function consumeUnrepresentedFailureRows(rows, context) {
  for (const row of rows) {
    assertObject(row, `${context.sourceKind} failure row`);
    const identity = normalizePairIdentity(
      { ...row, batchSlug: row.batchSlug ?? row.batch_slug ?? context.sourceBatch },
      `${context.sourceKind} failure row`
    );
    const sourceAttemptKey = row.attemptKey ?? row.id;
    const reason = requireOperationalReason(
      row.message ?? row.error ?? row.failure_reason,
      `${context.sourceKind} failure reason`
    );
    const sourceFailureKey = row.id ?? sha256(stableJson({ sourceAttemptKey, reason }));
    if (context.context.some((candidate) =>
      pairIdentityKey(candidate.pending) === pairIdentityKey(identity) &&
      candidate.sourceAttemptKey === sourceAttemptKey &&
      candidate.sourceFailureKey === sourceFailureKey
    )) continue;
    let task = resolvePlanTask(context.state, identity, clean(row.accountUrl) || null, {
      label: `${context.sourceKind} failure row`
    });
    if ((context.state.outcomesByTask.get(task.output.taskKey) ?? []).length) {
      const supplementalTaskKey =
        `${context.sourceKind}-failure:${context.artifact.sha256}:` +
        `${pairIdentityKey(identity)}:${sha256(`${sourceAttemptKey ?? "unknown"}\u0000${sourceFailureKey}`)}`;
      task = addSupplementalTask(context.state, supplementalTaskKey, identity, null);
    }
    const reasonCode = reasonCodeFor("failed", reason);
    const pending = {
      ...identity,
      taskKey: task.output.taskKey,
      account: null,
      attemptId: normalizedAttemptId(
        null,
        context.artifact.sha256,
        `${sourceAttemptKey ?? "unknown"}\u0000${sourceFailureKey}`,
        context.artifact.observedAt
      ),
      startedAt: context.artifact.observedAt,
      checkedAt: context.artifact.observedAt,
      status: "failed",
      reasonCode,
      reason,
      nextAction: nextActionFor(reasonCode, task.output.taskKey),
      profileReceipt: null
    };
    addOutcome(context.state, pending, {
      sourceArtifact: context.artifact.path,
      sourceAttemptKey: sourceAttemptKey ?? task.output.taskKey
    });
    context.context.push({
      pending,
      task,
      accountComparisonKey: null,
      sourceAttemptKey,
      sourceFailureKey
    });
  }
}

function applyRunnerCollectorFailures(failures, state) {
  for (const failure of failures) {
    const relevant = [...state.tasks.values()].filter((task) =>
      task.isPlanTask &&
      task.output.batchSlug === failure.batchSlug &&
      (failure.kind === "github"
        ? task.output.platform === "github"
        : task.output.platform !== "github") &&
      task.planStatus === "queued"
    );
    for (const task of relevant) {
      if ((state.outcomesByTask.get(task.output.taskKey) ?? []).length) continue;
      const reasonCode = reasonCodeFor("failed", failure.error);
      addOutcome(state, {
        batchSlug: task.output.batchSlug,
        entityType: task.output.entityType,
        entityId: task.output.entityId,
        platform: task.output.platform,
        taskKey: task.output.taskKey,
        account: task.output.account ?? null,
        attemptId: `runner-${sha256(stableJson({
          taskKey: task.output.taskKey,
          kind: failure.kind,
          checkedAt: failure.checkedAt,
          error: failure.error
        }))}`,
        startedAt: failure.checkedAt,
        checkedAt: failure.checkedAt,
        status: "failed",
        reasonCode,
        reason: failure.error,
        nextAction: nextActionFor(reasonCode, task.output.taskKey),
        profileReceipt: null
      }, {
        sourceArtifact: "runner-log",
        sourceAttemptKey: `${failure.kind}:${failure.batchSlug}:${task.output.taskKey}`
      });
    }
  }
}

function finalizeOutcomes(state) {
  const byTask = new Map();
  for (const outcome of state.pendingOutcomes) {
    const rows = byTask.get(outcome.taskKey) ?? [];
    rows.push(outcome);
    byTask.set(outcome.taskKey, rows);
  }
  const output = [];
  for (const [taskKey, rows] of byTask) {
    rows.sort((left, right) =>
      left.checkedAt.localeCompare(right.checkedAt) ||
      left.attemptId.localeCompare(right.attemptId)
    );
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1];
      const current = rows[index];
      if (previous.checkedAt === current.checkedAt) {
        const previousClass = terminalClass(previous.status, previous.reasonCode);
        const currentClass = terminalClass(current.status, current.reasonCode);
        if (previousClass !== currentClass) {
          throw new Error(
            `Contradictory terminal states for ${taskKey} at ${current.checkedAt}: ` +
            `${previousClass} and ${currentClass}.`
          );
        }
        throw new Error(`Duplicate terminal observations for ${taskKey} at ${current.checkedAt}.`);
      }
    }
    rows.forEach((row, attemptSequence) => {
      output.push(compact({
        batchSlug: row.batchSlug,
        entityType: row.entityType,
        entityId: row.entityId,
        platform: row.platform,
        taskKey: row.taskKey,
        account: row.account,
        attemptId: row.attemptId,
        attemptSequence,
        startedAt: row.startedAt,
        checkedAt: row.checkedAt,
        status: row.status,
        reasonCode: row.reasonCode,
        reason: row.reason,
        nextAction: row.nextAction,
        profileReceipt: row.profileReceipt
      }));
    });
  }
  return output.sort((left, right) =>
    left.taskKey.localeCompare(right.taskKey) ||
    left.attemptSequence - right.attemptSequence ||
    left.attemptId.localeCompare(right.attemptId)
  );
}

function finalizeEvidence(state) {
  return state.pendingEvidence.map((row) => compact(row)).sort((left, right) =>
    pairIdentityKey(left).localeCompare(pairIdentityKey(right)) ||
    left.platform.localeCompare(right.platform) ||
    nullableCompare(left.nativeId, right.nativeId) ||
    nullableCompare(left.canonicalUrl, right.canonicalUrl) ||
    left.taskKey.localeCompare(right.taskKey) ||
    left.attemptId.localeCompare(right.attemptId)
  );
}

function addTask(state, task) {
  const taskKey = task.output.taskKey;
  if (state.tasks.has(taskKey)) throw new Error(`Duplicate taskKey ${taskKey}.`);
  state.tasks.set(taskKey, task);
  const rows = state.tasksByPair.get(task.pairKey) ?? [];
  if (task.accountComparisonKey && rows.some((candidate) =>
    candidate.accountComparisonKey === task.accountComparisonKey
  )) {
    throw new Error(`Duplicate task account identity in ${task.pairKey}.`);
  }
  rows.push(task);
  rows.sort((left, right) => left.output.taskKey.localeCompare(right.output.taskKey));
  state.tasksByPair.set(task.pairKey, rows);
  return task;
}

function addSupplementalTask(state, taskKey, identity, account) {
  const existing = state.tasks.get(taskKey);
  if (existing) return existing;
  return addTask(state, {
    output: compact({ taskKey, ...identity, account }),
    pairKey: pairIdentityKey(identity),
    accountComparisonKey: account ? accountComparisonKey(account.platform, account.url) : null,
    isPlanTask: false,
    planStatus: "queued"
  });
}

function addOutcome(state, outcome, provenance) {
  if (state.attemptIds.has(outcome.attemptId)) {
    const prior = state.attemptIds.get(outcome.attemptId);
    throw new Error(
      `Duplicate attemptId ${outcome.attemptId} from ${prior.sourceArtifact}/${prior.sourceAttemptKey} ` +
      `and ${provenance.sourceArtifact}/${provenance.sourceAttemptKey}.`
    );
  }
  state.attemptIds.set(outcome.attemptId, provenance);
  state.pendingOutcomes.push(outcome);
  const rows = state.outcomesByTask.get(outcome.taskKey) ?? [];
  rows.push(outcome);
  state.outcomesByTask.set(outcome.taskKey, rows);
}

function resolvePlanTask(state, identity, accountUrl, { label }) {
  const pairKey = pairIdentityKey(identity);
  const candidates = (state.tasksByPair.get(pairKey) ?? []).filter((task) => task.isPlanTask);
  if (!candidates.length) throw new Error(`${label} has no live plan task for ${pairKey}.`);
  if (accountUrl) {
    const comparison = accountComparisonKey(identity.platform, accountUrl);
    const exact = candidates.filter((task) => task.accountComparisonKey === comparison);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) throw new Error(`${label} matches duplicate mapped tasks for ${comparison}.`);
    const discovery = candidates.filter((task) => task.accountComparisonKey === null);
    if (discovery.length === 1) {
      // Preserve the URL-less plan task key. The discovered account is attached
      // to its outcome, allowing the receipt builder to fold the mapping into
      // this task rather than materializing and counting a second task.
      return discovery[0];
    }
    throw new Error(`${label} discovered ${accountUrl} but no unique discovery task exists.`);
  }
  const discovery = candidates.filter((task) => task.accountComparisonKey === null);
  if (discovery.length === 1) return discovery[0];
  if (candidates.length === 1) return candidates[0];
  throw new Error(`${label} requires an exact task key or account; ${candidates.length} tasks match ${pairKey}.`);
}

function normalizeCatalogCompany(company, batchSlug, companyIndex) {
  assertObject(company, `${batchSlug}.companies[${companyIndex}]`);
  const id = requiredText(
    company.id ?? company.sourceKey,
    `${batchSlug}.companies[${companyIndex}].id`
  );
  const name = requiredText(company.name, `${id}.name`);
  if (!Array.isArray(company.accounts ?? [])) throw new TypeError(`${id}.accounts must be an array.`);
  if (!Array.isArray(company.founders ?? [])) throw new TypeError(`${id}.founders must be an array.`);
  return {
    id,
    name,
    accounts: company.accounts.map((account, index) =>
      normalizeAccount(account, null, `${id}.accounts[${index}]`)
    ),
    founders: company.founders.map((founder, founderIndex) => {
      assertObject(founder, `${id}.founders[${founderIndex}]`);
      const founderId = requiredText(
        founder.id ?? founder.sourceKey,
        `${id}.founders[${founderIndex}].id`
      );
      if (!Array.isArray(founder.accounts ?? [])) {
        throw new TypeError(`${founderId}.accounts must be an array.`);
      }
      return {
        id: founderId,
        name: requiredText(founder.name, `${founderId}.name`),
        accounts: founder.accounts.map((account, accountIndex) =>
          normalizeAccount(account, null, `${founderId}.accounts[${accountIndex}]`)
        )
      };
    })
  };
}

function normalizeAccount(account, forcedPlatform, label) {
  assertObject(account, label);
  const platform = normalizePlatform(forcedPlatform ?? account.platform);
  const rawUrl = requiredText(account.url ?? account.githubUrl, `${label}.url`);
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new TypeError(`${label}.url must be absolute.`);
  }
  if (url.username || url.password || url.port) {
    throw new Error(`${label}.url must use credential-free HTTPS and the default port.`);
  }
  if (
    url.protocol === "http:" &&
    (
      HTTPS_UPGRADEABLE_ACCOUNT_HOSTS[platform]?.has(url.hostname.toLowerCase()) ||
      (platform === "linkedin" && url.hostname.toLowerCase().endsWith(".linkedin.com"))
    )
  ) {
    url.protocol = "https:";
  }
  if (url.protocol !== "https:") {
    throw new Error(`${label}.url must use credential-free HTTPS and the default port.`);
  }
  url.hash = "";
  url.hostname = canonicalHost(platform, url.hostname);
  if (!["web", "rss", "hacker_news"].includes(platform)) url.search = "";
  const parts = url.pathname.split("/").filter(Boolean);
  if (platform === "linkedin" && ["company", "in", "school"].includes(parts[0]?.toLowerCase())) {
    url.pathname = `/${parts.slice(0, 2).join("/")}`;
  } else if (
    platform === "github" &&
    parts.length === 2 &&
    ["orgs", "users"].includes(parts[0]?.toLowerCase())
  ) {
    url.pathname = `/${parts[1]}`;
  } else if (["x", "instagram"].includes(platform) && parts.length) {
    url.pathname = `/${parts[0]}`;
  } else {
    url.pathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");
  }
  const suppliedHandle = clean(account.handle ?? account.login) || null;
  const canonicalHandle = platform === "github" && suppliedHandle
    ? url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part)).join("/").toLowerCase()
    : suppliedHandle;
  return {
    platform,
    url: url.toString().replace(/\/$/, ""),
    handle: canonicalHandle,
    verificationStatus: verificationStatus(account)
  };
}

function buildCatalogEntityIndex(catalogs) {
  const index = new Map();
  for (const catalog of catalogs) {
    for (const company of catalog.companies) {
      addCatalogEntity(index, catalog.batchSlug, "company", company.id);
      for (const founder of company.founders) {
        addCatalogEntity(index, catalog.batchSlug, "founder", founder.id);
      }
    }
  }
  return index;
}

function addCatalogEntity(index, batchSlug, entityType, entityId) {
  const key = `${batchSlug}\u0000${entityType}\u0000${entityId}`;
  if (index.has(key)) throw new Error(`Duplicate catalog entity ${key}.`);
  index.set(key, true);
}

function assertCatalogIdentity(identity, index, label) {
  const key = entityIdentityKey(identity);
  if (!index.has(key)) throw new Error(`${label} references unknown canonical entity ${key}.`);
}

function normalizePairIdentity(value, label) {
  const batchSlug = requiredText(value.batchSlug ?? value.batch_slug, `${label}.batchSlug`);
  const entityType = clean(value.entityType ?? value.entity_type).toLowerCase();
  if (!ENTITY_TYPES.has(entityType)) {
    throw new Error(`${label}.entityType must be company or founder.`);
  }
  const entityId = requiredText(
    value.entityId ?? value.entity_id ?? value.entitySourceKey ?? value.company_id,
    `${label}.entityId`
  );
  return {
    batchSlug,
    entityType,
    entityId,
    platform: normalizePlatform(value.platform)
  };
}

function normalizeArtifactDescriptor(value, kind, generatedAt, {
  run = null,
  requireWithinRun = false
} = {}) {
  assertObject(value, `${kind} artifact`);
  const path = requiredText(value.path, `${kind} artifact.path`);
  const digest = requiredSha256(value.sha256, `${kind} artifact.sha256`);
  const observedAt = canonicalTimestamp(value.observedAt, `${kind} artifact.observedAt`);
  if (Date.parse(observedAt) > Date.parse(generatedAt)) {
    throw new Error(`${kind} artifact.observedAt cannot exceed generatedAt.`);
  }
  if (requireWithinRun && (
    Date.parse(observedAt) < Date.parse(run.startedAt) ||
    Date.parse(observedAt) > Date.parse(run.completedAt)
  )) {
    throw new Error(`${kind} artifact ${path} was not observed within the current run.`);
  }
  return { kind, path, sha256: digest, observedAt };
}

function currentRunTiming(value, artifact, run, label) {
  const checkedAt = currentObservationTimestamp(value, artifact, run, label);
  const candidate = optionalTimestamp(value.startedAt, `${label}.startedAt`);
  const startedAt = candidate && withinRun(candidate, run) && candidate <= checkedAt
    ? candidate
    : checkedAt;
  return { startedAt, checkedAt };
}

function currentObservationTimestamp(value, artifact, run, label) {
  const candidate = optionalTimestamp(
    value.checkedAt ?? value.last_checked_at ?? value.observedAt,
    `${label}.checkedAt`
  );
  if (candidate && withinRun(candidate, run)) return candidate;
  // A resumed snapshot is re-observed when its current-run artifact descriptor
  // is validated. Use that explicit observation time rather than claiming its
  // older collector timestamp was a current run attempt.
  return artifact.observedAt;
}

function normalizedAttemptEntries(value, label) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.map((row, index) => {
      assertObject(row, `${label}[${index}]`);
      return [String(index), row];
    });
  }
  assertObject(value, label);
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(
    ([key, row]) => {
      assertObject(row, `${label}.${key}`);
      return [key, row];
    }
  );
}

function normalizedCollectorStatus(value) {
  const explicit = clean(value.outcomeStatus ?? value.status).toLowerCase();
  if (["completed", "collected", "success", "succeeded"].includes(explicit)) return "completed";
  if (["needs_review", "manual_review", "requires_credentials", "queued"].includes(explicit)) {
    return explicit;
  }
  if (["verified_no_account", "checked_empty", "no_account", "not_found"].includes(explicit)) {
    return explicit;
  }
  if (["blocked_or_empty", "failed", "skipped", "empty"].includes(explicit)) return explicit;
  if (value.retryable === true) return "failed";
  throw new Error(`Unknown collector outcome status ${explicit || "missing"}.`);
}

function collectorReason(value, status, label) {
  if (["needs_review", "manual_review"].includes(status)) {
    return requireOperationalReason(
      `${label} requires manual review because the collector did not verify a native public post URL.`,
      `${label}.reason`
    );
  }
  const success = isSuccessStatus(status);
  let reason = success
    ? clean(value.outcomeReason ?? value.reason) || `${label} reported native collection success.`
    : clean(value.error ?? value.outcomeReason ?? value.reason);
  if (
    reason === "collector_checked_blocked_or_empty" ||
    /checked_empty.*blocked|blocked.*checked_empty/.test(reason)
  ) {
    reason = "Collector reported a legacy combined access-or-zero-result outcome without an exact cause.";
  }
  if (/login.?wall/i.test(reason) &&
      !/network|timeout|timed out|socket|econn|fetch failed|\b5\d\d\b/i.test(reason) &&
      !/access denied|forbidden|\b403\b|robots blocked/i.test(reason)) {
    reason = `Access denied by a public login wall: ${reason}`;
  }
  return requireOperationalReason(
    reason || `${label} ended as ${status} without a more specific legacy reason.`,
    `${label}.reason`
  );
}

function reasonCodeFor(status, reason) {
  if (isSuccessStatus(status) || status === "verified_no_account") return null;
  const text = reason.toLowerCase();
  if (/captcha/.test(text)) return "captcha_required";
  if (/rate.?limit|secondary.?limit|\b429\b/.test(text)) return "rate_limited";
  if (/missing|absent|not configured|required/.test(text) &&
      /credential|token|api key|bearer|secret/.test(text)) return "missing_credentials";
  if (/access denied|forbidden|robots blocked|\b403\b/.test(text)) {
    return "access_denied";
  }
  if (/network|timeout|timed out|socket|econn|fetch failed|\b5\d\d\b/.test(text)) {
    return "network_error";
  }
  if (/login.?wall/.test(text)) return "access_denied";
  if (/manual review|needs review|requires manual|attribution review/.test(text) ||
      status === "needs_review" || status === "manual_review") {
    return "manual_review_required";
  }
  if (/no match|no result|not found|no account|no posts?|without a verified native account/.test(text)) {
    return "no_match";
  }
  return ["blocked_or_empty", "checked_empty", "empty", "failed", "skipped"].includes(status)
    ? "ambiguous_legacy_outcome"
    : "manual_review_required";
}

function nextActionFor(reasonCode, taskKey) {
  const actions = {
    access_denied: `Restore permitted public access for ${taskKey}, then retry the bounded collector.`,
    network_error: `Retry ${taskKey} after network health recovers.`,
    captcha_required: `Queue ${taskKey} for a permitted non-personal access path or manual review.`,
    rate_limited: `Retry ${taskKey} after the recorded rate-limit reset with bounded concurrency.`,
    missing_credentials: `Configure the required production credential for ${taskKey}, then retry.`,
    manual_review_required: `Manually review ${taskKey} and record a structured current-attempt outcome.`,
    no_match: `Review official identity sources for ${taskKey}; verify absence or map the native account.`,
    ambiguous_legacy_outcome: `Re-run ${taskKey} and record an exact structured terminal reason.`
  };
  return actions[reasonCode] ??
    `Continue scheduled incremental ingestion for ${taskKey} while preserving native IDs and digests.`;
}

function profileReceiptFor({ status, account, checkedAt, attemptId, artifactHash, source }) {
  if (!isSuccessStatus(status) || !account) return null;
  return {
    receiptId: `profile-${sha256(`${attemptId}\u0000${account.url}`)}`,
    status: "scraped",
    checkedAt,
    profileUrl: account.url,
    digest: sha256(stableJson({
      adapterVersion: INGESTION_COVERAGE_ADAPTER_VERSION,
      artifactHash,
      account,
      source: {
        status: clean(source.status) || null,
        outcomeStatus: clean(source.outcomeStatus) || null,
        account: source.account ?? null,
        aggregate: source.aggregate ?? null
      }
    }))
  };
}

function normalizedAttemptId(explicit, artifactHash, sourceAttemptKey, checkedAt) {
  const supplied = clean(explicit);
  return supplied || `attempt-${sha256(stableJson({ artifactHash, sourceAttemptKey, checkedAt }))}`;
}

function hashEvidencePayload(row, identity, nativeId, canonicalUrl, publishedAt) {
  return sha256(stableJson({
    adapterVersion: INGESTION_COVERAGE_ADAPTER_VERSION,
    identity,
    nativeId,
    canonicalUrl,
    publishedAt,
    title: clean(row.title) || null,
    text: clean(row.text) || null,
    rawVisibleText: clean(row.rawVisibleText) || null,
    metrics: row.metrics ?? null
  }));
}

function validateExpectedManifestShape(manifest) {
  assertObject(manifest, "expectedCatalogManifest");
  if (manifest.version !== INGESTION_CATALOG_MANIFEST_VERSION) {
    throw new Error(
      `expectedCatalogManifest.version must be ${INGESTION_CATALOG_MANIFEST_VERSION}.`
    );
  }
  if (!Array.isArray(manifest.batches) || !manifest.batches.length) {
    throw new TypeError("expectedCatalogManifest.batches must be a non-empty array.");
  }
  for (const batch of manifest.batches) {
    assertObject(batch, "expectedCatalogManifest batch");
    requiredText(batch.batchSlug, "expectedCatalogManifest batch.batchSlug");
    requiredSha256(batch.sourceHash, "expectedCatalogManifest batch.sourceHash");
  }
}

function normalizePassThroughRows(rows, label) {
  if (!Array.isArray(rows)) throw new TypeError(`${label} must be an array.`);
  return rows.map((row, index) => {
    assertObject(row, `${label}[${index}]`);
    return structuredClone(row);
  }).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

function normalizeCollectorKind(value) {
  const kind = clean(value).toLowerCase();
  if (!new Set(["public", "github", "targeted"]).has(kind)) {
    throw new Error(`Collector kind must be public, github, or targeted; received ${kind || "missing"}.`);
  }
  return kind;
}

function normalizePlatform(value) {
  const platform = clean(value).toLowerCase();
  const aliases = {
    twitter: "x",
    website: "web",
    producthunt: "product_hunt",
    hn: "hacker_news",
    hackernews: "hacker_news"
  };
  const normalized = aliases[platform] ?? platform;
  if (!PLATFORM_SET.has(normalized)) throw new Error(`Unsupported ingestion platform ${normalized}.`);
  return normalized;
}

function canonicalHost(platform, value) {
  let host = value.toLowerCase().replace(/^www\./, "");
  if (platform === "x" && host === "twitter.com") host = "x.com";
  if (platform === "linkedin" && host.endsWith(".linkedin.com")) host = "linkedin.com";
  if (platform === "reddit" && host === "old.reddit.com") host = "reddit.com";
  return host;
}

function accountComparisonKey(platform, rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new TypeError(`${platform} account URL must be absolute.`);
  }
  url.hostname = canonicalHost(platform, url.hostname);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return `${platform}:${url.toString().toLowerCase()}`;
}

function verificationStatus(account) {
  const value = clean(account.verificationStatus ?? account.reviewState ?? account.review_state).toLowerCase();
  if (account.verified === true || value === "verified") return "verified";
  if (value === "needs_review" || value === "rejected") return value;
  return "unknown";
}

function pairIdentityKey(value) {
  return `${value.batchSlug}:${value.entityType}:${value.entityId}:${value.platform}`;
}

function entityIdentityKey(value) {
  return `${value.batchSlug}\u0000${value.entityType}\u0000${value.entityId}`;
}

function terminalClass(status, reasonCode) {
  if (isSuccessStatus(status)) return "collected";
  if (status === "verified_no_account") return "verified_no_account";
  if (["access_denied", "network_error", "captcha_required", "rate_limited"].includes(reasonCode)) {
    return "blocked";
  }
  return "queued";
}

function isSuccessStatus(status) {
  return ["completed", "collected", "success", "succeeded"].includes(status);
}

function withinRun(timestamp, run) {
  return timestamp >= run.startedAt && timestamp <= run.completedAt;
}

function optionalTimestamp(value, label) {
  if (value === null || value === undefined || value === "") return null;
  return canonicalTimestamp(value, label);
}

function canonicalTimestamp(value, label) {
  const text = requiredText(value, label);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be an ISO timestamp.`);
  return new Date(parsed).toISOString();
}

function requireOperationalReason(value, label) {
  const reason = requiredText(value, label);
  if (reason.length < 8) throw new Error(`${label} must contain an exact operational reason.`);
  return reason;
}

function requiredText(value, label) {
  const text = clean(value);
  if (!text) throw new TypeError(`${label} must be a non-empty string.`);
  return text;
}

function requiredSha256(value, label) {
  const digest = clean(value).toLowerCase();
  if (!SHA256.test(digest)) throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  return digest;
}

function validSha256(value) {
  return SHA256.test(clean(value).toLowerCase());
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
  return number;
}

function finiteNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}

function assertArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
}

function clean(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined)
  );
}

function nullableCompare(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function compareArtifacts(left, right) {
  return left.kind.localeCompare(right.kind) || left.path.localeCompare(right.path);
}

function hashCanonicalRows(rows) {
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(stableJson(row));
    hash.update("\n");
  }
  return hash.digest("hex");
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

async function* asAsyncIterable(value, label) {
  if (value?.[Symbol.asyncIterator]) {
    yield* value;
    return;
  }
  if (value?.[Symbol.iterator] && typeof value !== "string") {
    yield* value;
    return;
  }
  throw new TypeError(`${label} must be an iterable or AsyncIterable.`);
}
