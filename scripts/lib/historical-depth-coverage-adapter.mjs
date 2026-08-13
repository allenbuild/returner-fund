import { createHash } from "node:crypto";
import {
  INGESTION_RECENCY_WINDOW_DAYS
} from "./ingestion-coverage-receipt.mjs";
import {
  HISTORICAL_DEPTH_PLATFORMS,
  HISTORICAL_DEPTH_RUNNER_VERSION,
  HISTORICAL_DEPTH_SCHEMA_VERSION,
  buildHistoricalDepthTargets
} from "./historical-depth-targets.mjs";

export const HISTORICAL_DEPTH_COVERAGE_ADAPTER_VERSION =
  "historical-depth-coverage-adapter.v1";
export const HISTORICAL_DEPTH_COVERAGE_PROVENANCE_VERSION =
  "historical-depth-coverage-provenance.v1";
export const HISTORICAL_DEPTH_COMPLETION_PROOF_VERSION =
  "historical-depth-completion-proof.v1";

export const HISTORICAL_DEPTH_COVERAGE_ADAPTER_LIMITS = Object.freeze({
  maxJournalBytes: 512 * 1024 * 1024,
  maxLineBytes: 16 * 1024 * 1024,
  maxEvents: 250_000,
  maxTargets: 10_000,
  maxEvidence: 2_000_000,
  maxOwnerPlatformPairs: 25_000
});

const SHA256 = /^[a-f0-9]{64}$/;
const TARGET_HASH = /^[a-f0-9]{20}$/;
const ENTITY_TYPES = new Set(["company", "founder"]);
const EVENT_TYPES = new Set([
  "run_initialized",
  "page_checkpoint",
  "target_completed",
  "run_completed"
]);
const TARGET_OUTCOMES = new Set([
  "collected",
  "verified_no_history",
  "access_blocked",
  "manual_review"
]);
const COMPLETE_EXTENTS = Object.freeze({
  youtube: "all_items_exposed_by_official_uploads_playlist_api",
  product_hunt: "all_official_graphql_posts_matching_exact_official_url_since_1970",
  reddit: "all_posts_exposed_by_reddit_listing_not_guaranteed_account_lifetime_history"
});
const CUMULATIVE_FIELDS = Object.freeze([
  "pagesAttempted",
  "pagesFetched",
  "requests",
  "itemsSeen",
  "accepted",
  "rejected",
  "duplicates"
]);

/**
 * Authenticate and bridge one historical-depth pages.ndjson artifact. The
 * journal is read and hashed exactly once. Missing mappings become explicit
 * queued attempts; they are never converted to native-account absence.
 */
export async function adaptHistoricalDepthCoverage({
  journal,
  artifact,
  catalogs,
  generatedAt,
  completionProofs = [],
  limits: limitOverrides = {}
} = {}) {
  const limits = normalizeLimits(limitOverrides);
  const normalizedGeneratedAt = canonicalTimestamp(generatedAt, "generatedAt");
  const normalizedArtifact = normalizeArtifact(artifact, normalizedGeneratedAt);
  const recencyCutoffAt = new Date(
    Date.parse(normalizedGeneratedAt) -
      INGESTION_RECENCY_WINDOW_DAYS * 24 * 60 * 60 * 1_000
  ).toISOString();
  const state = newJournalState(limits);
  const parsed = await consumeNdjson(journal, limits, (event, lineNumber) => {
    consumeEvent(event, lineNumber, state, normalizedGeneratedAt);
  });
  if (parsed.sha256 !== normalizedArtifact.sha256) {
    throw new Error(
      `Historical-depth journal sha256 mismatch: expected ${normalizedArtifact.sha256}, ` +
      `computed ${parsed.sha256}.`
    );
  }
  finalizeJournalState(state, normalizedArtifact);

  const canonicalPlan = reconcileCanonicalPlan(catalogs, state, limits);
  const proofIndex = normalizeCompletionProofs(completionProofs, {
    state,
    artifact: normalizedArtifact,
    recencyCutoffAt
  });
  const normalized = normalizeCoverageRows(state, canonicalPlan, {
    artifact: normalizedArtifact,
    proofIndex,
    recencyCutoffAt
  });
  const collectorArtifact = {
    kind: "public",
    artifact: structuredClone(normalizedArtifact),
    snapshot: {
      source: {
        collector: "historical-depth-coverage-bridge",
        fetchedAt: normalizedArtifact.observedAt
      },
      attempts: Object.fromEntries(normalized.attempts.map((attempt) => [
        attempt.attemptKey,
        attempt
      ])),
      evidence: normalized.evidence,
      needsReview: [],
      failures: []
    }
  };
  const provenance = {
    schemaVersion: HISTORICAL_DEPTH_COVERAGE_PROVENANCE_VERSION,
    adapterVersion: HISTORICAL_DEPTH_COVERAGE_ADAPTER_VERSION,
    generatedAt: normalizedGeneratedAt,
    recencyCutoffAt,
    sourceArtifact: {
      kind: "historical_depth",
      ...structuredClone(normalizedArtifact)
    },
    journal: {
      bytes: parsed.bytes,
      events: state.eventCount,
      firstSequence: state.firstSequence,
      lastSequence: state.lastSequence,
      firstRecordedAt: state.firstRecordedAt,
      lastRecordedAt: state.lastRecordedAt,
      configFingerprint: state.runInitialized.configFingerprint,
      runCompleted: state.runCompleted !== null,
      expectedAccountTargets: state.expectedTargetKeys.length,
      terminalAccountTargets: state.targetsWithTerminal
    },
    canonicalPlan: normalized.coverageSummary,
    normalizedRows: {
      tasks: normalized.taskPlan.length,
      attempts: normalized.attempts.length,
      evidence: normalized.evidence.length,
      rejectedEvidence: normalized.rejectedEvidence.length,
      pairScopes: normalized.pairScopes.length,
      accountTargetCoverage: normalized.accountTargetCoverage.length,
      pairCoverage: normalized.pairCoverage.length,
      targetCoverage: normalized.targetCoverage.length
    }
  };

  return {
    taskPlan: normalized.taskPlan,
    collectorArtifacts: [collectorArtifact],
    pairScopes: normalized.pairScopes,
    targetCoverage: normalized.targetCoverage,
    accountTargetCoverage: normalized.accountTargetCoverage,
    pairCoverage: normalized.pairCoverage,
    rejectedEvidence: normalized.rejectedEvidence,
    coverageSummary: normalized.coverageSummary,
    provenance
  };
}

function newJournalState(limits) {
  return {
    limits,
    eventCount: 0,
    firstSequence: null,
    lastSequence: 0,
    firstRecordedAt: null,
    lastRecordedAt: null,
    runInitialized: null,
    runCompleted: null,
    expectedTargetKeys: [],
    targetStates: new Map(),
    evidenceCount: 0,
    targetsWithTerminal: 0
  };
}

async function consumeNdjson(source, limits, onEvent) {
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let bytes = 0;
  let lineNumber = 0;
  let finalByte = null;
  for await (const rawChunk of asChunks(source)) {
    const chunk = typeof rawChunk === "string"
      ? Buffer.from(rawChunk, "utf8")
      : Buffer.from(rawChunk);
    if (chunk.length === 0) continue;
    bytes += chunk.length;
    if (bytes > limits.maxJournalBytes) {
      throw new Error(
        `Historical-depth journal exceeds maxJournalBytes=${limits.maxJournalBytes}.`
      );
    }
    hash.update(chunk);
    finalByte = chunk.at(-1);
    pending += decoder.decode(chunk, { stream: true });
    while (true) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      lineNumber += 1;
      consumeLine(line, lineNumber, limits, onEvent);
    }
    if (Buffer.byteLength(pending, "utf8") > limits.maxLineBytes) {
      throw new Error(
        `Historical-depth journal line ${lineNumber + 1} exceeds maxLineBytes=${limits.maxLineBytes}.`
      );
    }
  }
  pending += decoder.decode();
  if (finalByte !== 0x0a) {
    throw new Error(
      "Historical-depth journal must end with a newline; the tail may be truncated."
    );
  }
  if (pending.length > 0) {
    throw new Error("Historical-depth journal contains data after its final newline.");
  }
  if (lineNumber === 0) throw new Error("Historical-depth journal must not be empty.");
  return { bytes, sha256: hash.digest("hex") };
}

function consumeLine(line, lineNumber, limits, onEvent) {
  if (!line) throw new Error(`Historical-depth journal line ${lineNumber} must not be blank.`);
  if (Buffer.byteLength(line, "utf8") > limits.maxLineBytes) {
    throw new Error(
      `Historical-depth journal line ${lineNumber} exceeds maxLineBytes=${limits.maxLineBytes}.`
    );
  }
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    throw new Error(`Historical-depth journal line ${lineNumber} is not valid JSON.`);
  }
  onEvent(event, lineNumber);
}

async function* asChunks(source) {
  if (typeof source === "string" || source instanceof Uint8Array) {
    yield source;
    return;
  }
  if (source?.[Symbol.asyncIterator]) {
    yield* source;
    return;
  }
  if (source?.[Symbol.iterator]) {
    yield* source;
    return;
  }
  throw new TypeError(
    "journal must be a string, Uint8Array, Iterable, or AsyncIterable of chunks."
  );
}

function consumeEvent(rawEvent, lineNumber, state, generatedAt) {
  assertObject(rawEvent, `Historical-depth journal line ${lineNumber}`);
  const eventType = requiredText(
    rawEvent.type,
    `Historical-depth journal line ${lineNumber}.type`
  );
  if (!EVENT_TYPES.has(eventType)) {
    throw new Error(`Unsupported historical-depth journal event type ${eventType}.`);
  }
  const sequence = positiveInteger(
    rawEvent.sequence,
    `Historical-depth journal line ${lineNumber}.sequence`
  );
  if (sequence !== state.lastSequence + 1) {
    throw new Error(
      `Historical-depth journal sequence must be contiguous; expected ` +
      `${state.lastSequence + 1}, received ${sequence}.`
    );
  }
  const recordedAt = canonicalTimestamp(
    rawEvent.recordedAt,
    `Historical-depth journal sequence ${sequence}.recordedAt`
  );
  if (recordedAt > generatedAt) {
    throw new Error(`Historical-depth journal sequence ${sequence} is later than generatedAt.`);
  }
  if (state.lastRecordedAt && recordedAt < state.lastRecordedAt) {
    throw new Error(`Historical-depth journal recordedAt decreases at sequence ${sequence}.`);
  }
  if (rawEvent.schemaVersion !== HISTORICAL_DEPTH_SCHEMA_VERSION) {
    throw new Error(
      `Historical-depth journal sequence ${sequence} schemaVersion must be ` +
      `${HISTORICAL_DEPTH_SCHEMA_VERSION}.`
    );
  }
  if (state.runCompleted) {
    throw new Error(`Historical-depth journal contains ${eventType} after run_completed.`);
  }
  if (eventType === "run_initialized") {
    consumeRunInitialized(rawEvent, { sequence, recordedAt }, state);
  } else {
    if (!state.runInitialized) {
      throw new Error("Historical-depth journal must begin with run_initialized.");
    }
    if (eventType === "page_checkpoint") {
      consumePageCheckpoint(rawEvent, { sequence, recordedAt }, state);
    } else if (eventType === "target_completed") {
      consumeTargetCompleted(rawEvent, { sequence, recordedAt }, state);
    } else {
      consumeRunCompleted(rawEvent, { sequence, recordedAt }, state);
    }
  }
  state.eventCount += 1;
  if (state.eventCount > state.limits.maxEvents) {
    throw new Error(`Historical-depth journal exceeds maxEvents=${state.limits.maxEvents}.`);
  }
  state.firstSequence ??= sequence;
  state.firstRecordedAt ??= recordedAt;
  state.lastSequence = sequence;
  state.lastRecordedAt = recordedAt;
}

function consumeRunInitialized(event, timing, state) {
  assertKnownKeys(event, new Set([
    "schemaVersion", "sequence", "recordedAt", "type", "config",
    "configFingerprint", "startedAt"
  ]), `run_initialized sequence ${timing.sequence}`);
  if (timing.sequence !== 1 || state.runInitialized) {
    throw new Error(
      "Historical-depth journal must contain exactly one first run_initialized event."
    );
  }
  assertObject(event.config, "run_initialized.config");
  const configFingerprint = requiredSha256(
    event.configFingerprint,
    "run_initialized.configFingerprint"
  );
  if (sha256(stableJson(event.config)) !== configFingerprint) {
    throw new Error(
      "Historical-depth run_initialized.configFingerprint does not match its canonical config."
    );
  }
  if (event.config.schemaVersion !== HISTORICAL_DEPTH_SCHEMA_VERSION) {
    throw new Error("Historical-depth run_initialized config schemaVersion is incompatible.");
  }
  if (event.config.runnerVersion !== HISTORICAL_DEPTH_RUNNER_VERSION) {
    throw new Error("Historical-depth run_initialized config runnerVersion is incompatible.");
  }
  const targetKeys = sortedUniqueText(
    event.config.targetKeys,
    "run_initialized.config.targetKeys"
  );
  if (targetKeys.length > state.limits.maxTargets) {
    throw new Error(`Historical-depth journal exceeds maxTargets=${state.limits.maxTargets}.`);
  }
  const platforms = sortedUniqueText(
    event.config.platforms,
    "run_initialized.config.platforms"
  ).map(normalizePlatform);
  const batches = uniqueText(event.config.batches, "run_initialized.config.batches").sort();
  assertObject(event.config.credentialModes, "run_initialized.config.credentialModes");
  assertObject(event.config.limits, "run_initialized.config.limits");
  for (const targetKey of targetKeys) {
    const identity = identityFromTargetKey(targetKey);
    if (!platforms.includes(identity.platform)) {
      throw new Error(`${targetKey} uses a platform absent from run_initialized.config.platforms.`);
    }
    if (!batches.includes(identity.batchSlug)) {
      throw new Error(`${targetKey} uses a batch absent from run_initialized.config.batches.`);
    }
    state.targetStates.set(targetKey, newTargetState(targetKey, identity));
  }
  const startedAt = canonicalTimestamp(event.startedAt, "run_initialized.startedAt");
  if (startedAt > timing.recordedAt) {
    throw new Error("Historical-depth run_initialized.startedAt exceeds recordedAt.");
  }
  state.expectedTargetKeys = targetKeys;
  state.runInitialized = {
    sequence: timing.sequence,
    recordedAt: timing.recordedAt,
    startedAt,
    configFingerprint,
    config: structuredClone(event.config),
    platforms,
    batches
  };
}

function newTargetState(targetKey, identity) {
  return {
    targetKey,
    identity,
    canonicalTarget: null,
    pages: [],
    terminal: null,
    evidence: [],
    evidenceIdentities: new Map(),
    rejectedEvidence: []
  };
}

function consumePageCheckpoint(event, timing, state) {
  assertKnownKeys(event, new Set([
    "schemaVersion", "sequence", "recordedAt", "type", "targetKey",
    "receipt", "evidence", "progress"
  ]), `page_checkpoint sequence ${timing.sequence}`);
  const target = resolveTargetState(event.targetKey, state);
  if (target.terminal) {
    throw new Error(`${target.targetKey} has a page checkpoint after its terminal receipt.`);
  }
  const receipt = normalizeReceipt(event.receipt, "page", target.targetKey);
  assertReceiptIdentity(receipt, target);
  const previous = target.pages.at(-1)?.receipt ?? null;
  if (previous) assertCumulativeProgress(previous, receipt, target.targetKey);
  if (!Array.isArray(event.evidence)) {
    throw new TypeError(`${target.targetKey} page_checkpoint.evidence must be an array.`);
  }
  if (event.evidence.length !== receipt.pageAccepted) {
    throw new Error(
      `${target.targetKey} pageAccepted=${receipt.pageAccepted} does not equal its ` +
      `${event.evidence.length} journaled evidence rows.`
    );
  }
  for (let index = 0; index < event.evidence.length; index += 1) {
    state.evidenceCount += 1;
    if (state.evidenceCount > state.limits.maxEvidence) {
      throw new Error(`Historical-depth journal exceeds maxEvidence=${state.limits.maxEvidence}.`);
    }
    consumeHistoricalDepthEvidence(event.evidence[index], {
      index,
      sequence: timing.sequence,
      recordedAt: timing.recordedAt,
      receipt,
      target
    });
  }
  target.pages.push({
    sequence: timing.sequence,
    recordedAt: timing.recordedAt,
    receipt
  });
}

function consumeTargetCompleted(event, timing, state) {
  assertKnownKeys(event, new Set([
    "schemaVersion", "sequence", "recordedAt", "type", "targetKey", "receipt"
  ]), `target_completed sequence ${timing.sequence}`);
  const target = resolveTargetState(event.targetKey, state);
  if (target.terminal) throw new Error(`${target.targetKey} has duplicate terminal receipts.`);
  const receipt = normalizeReceipt(event.receipt, "target", target.targetKey);
  assertReceiptIdentity(receipt, target);
  const previous = target.pages.at(-1)?.receipt ?? null;
  if (previous) {
    assertTerminalProgress(previous, receipt, target.targetKey, state);
    if (stableJson(receipt.sourceLimit) !== stableJson(previous.sourceLimit)) {
      throw new Error(`${target.targetKey} terminal sourceLimit changed after its last page.`);
    }
  } else if (receipt.pagesAttempted !== 0 || receipt.pagesFetched !== 0 || receipt.requests !== 0) {
    assertBoundedUncheckpointedFailure(null, receipt, target.targetKey, state);
  }
  if (receipt.accepted !== target.evidence.length + target.rejectedEvidence.length) {
    throw new Error(
      `${target.targetKey} terminal accepted count does not reconcile with journaled evidence.`
    );
  }
  target.terminal = { sequence: timing.sequence, recordedAt: timing.recordedAt, receipt };
  state.targetsWithTerminal += 1;
}

function assertTerminalProgress(previous, receipt, targetKey, state) {
  for (const field of CUMULATIVE_FIELDS) {
    if (receipt[field] < previous[field]) {
      throw new Error(`${targetKey} terminal cumulative ${field} decreases after its last page.`);
    }
  }
  for (const field of ["itemsSeen", "accepted", "rejected", "duplicates"]) {
    if (receipt[field] !== previous[field]) {
      throw new Error(`${targetKey} terminal ${field} changed without a page checkpoint.`);
    }
  }
  const hasUncheckpointedRequest = ["pagesAttempted", "pagesFetched", "requests"]
    .some((field) => receipt[field] !== previous[field]);
  if (!hasUncheckpointedRequest) return;
  if (["collected", "verified_no_history"].includes(receipt.outcome)) {
    throw new Error(`${targetKey} successful terminal contains an uncheckpointed request.`);
  }
  assertBoundedUncheckpointedFailure(previous, receipt, targetKey, state);
}

function assertBoundedUncheckpointedFailure(previous, receipt, targetKey, state) {
  const baseline = previous ?? Object.fromEntries(CUMULATIVE_FIELDS.map((field) => [field, 0]));
  const attemptedDelta = receipt.pagesAttempted - baseline.pagesAttempted;
  const fetchedDelta = receipt.pagesFetched - baseline.pagesFetched;
  const requestDelta = receipt.requests - baseline.requests;
  const requestAttemptLimit = Number(state.runInitialized.config.limits.requestAttempts);
  if (attemptedDelta !== 1 || ![0, 1].includes(fetchedDelta) ||
      !Number.isSafeInteger(requestAttemptLimit) || requestAttemptLimit <= 0 ||
      requestDelta < 1 || requestDelta > requestAttemptLimit) {
    throw new Error(
      `${targetKey} terminal has an unbounded or irreconcilable uncheckpointed request.`
    );
  }
}

function consumeRunCompleted(event, timing, state) {
  assertKnownKeys(event, new Set([
    "schemaVersion", "sequence", "recordedAt", "type", "summary"
  ]), `run_completed sequence ${timing.sequence}`);
  assertObject(event.summary, "run_completed.summary");
  const status = requiredText(event.summary.status, "run_completed.summary.status");
  if (!["completed", "incomplete"].includes(status)) {
    throw new Error("Historical-depth run_completed status must be completed or incomplete.");
  }
  const expected = nonNegativeInteger(
    event.summary.targetAccountPairs,
    "run_completed.summary.targetAccountPairs"
  );
  const completed = nonNegativeInteger(
    event.summary.completedTargetAccountPairs,
    "run_completed.summary.completedTargetAccountPairs"
  );
  if (expected !== state.expectedTargetKeys.length || completed !== state.targetsWithTerminal) {
    throw new Error(
      "Historical-depth run_completed account target counts do not reconcile with the journal."
    );
  }
  if (status === "completed" && completed !== expected) {
    throw new Error(
      "A completed historical-depth summary must contain every configured terminal target."
    );
  }
  state.runCompleted = {
    sequence: timing.sequence,
    recordedAt: timing.recordedAt,
    status,
    summary: structuredClone(event.summary)
  };
}

function resolveTargetState(rawTargetKey, state) {
  const targetKey = requiredText(rawTargetKey, "historical-depth event.targetKey");
  const target = state.targetStates.get(targetKey);
  if (!target) {
    throw new Error(`Historical-depth event references unconfigured target ${targetKey}.`);
  }
  return target;
}

function normalizeReceipt(rawReceipt, expectedType, targetKey) {
  assertObject(rawReceipt, `${targetKey} ${expectedType} receipt`);
  if (rawReceipt.schemaVersion !== HISTORICAL_DEPTH_SCHEMA_VERSION) {
    throw new Error(`${targetKey} receipt schemaVersion is incompatible.`);
  }
  if (rawReceipt.runnerVersion !== HISTORICAL_DEPTH_RUNNER_VERSION) {
    throw new Error(`${targetKey} receipt runnerVersion is incompatible.`);
  }
  if (rawReceipt.receiptType !== expectedType) {
    throw new Error(`${targetKey} receiptType must be ${expectedType}.`);
  }
  const platform = normalizePlatform(rawReceipt.platform);
  const provider = normalizePlatform(rawReceipt.provider);
  if (provider !== platform) throw new Error(`${targetKey} receipt provider/platform mismatch.`);
  const entityType = requiredText(rawReceipt.entityType, `${targetKey} receipt.entityType`)
    .toLowerCase();
  if (!ENTITY_TYPES.has(entityType)) {
    throw new Error(`${targetKey} receipt.entityType must be company or founder.`);
  }
  const receipt = {
    ...structuredClone(rawReceipt),
    targetKey: requiredText(rawReceipt.targetKey, `${targetKey} receipt.targetKey`),
    batchSlug: requiredText(rawReceipt.batchSlug, `${targetKey} receipt.batchSlug`),
    entityType,
    entityId: requiredText(rawReceipt.entityId, `${targetKey} receipt.entityId`),
    platform,
    provider,
    accountUrl: optionalHttpsUrl(rawReceipt.accountUrl),
    mappingVerified: requiredBoolean(
      rawReceipt.mappingVerified,
      `${targetKey} receipt.mappingVerified`
    ),
    sourceExhausted: requiredBoolean(
      rawReceipt.sourceExhausted,
      `${targetKey} receipt.sourceExhausted`
    ),
    truncated: requiredBoolean(rawReceipt.truncated, `${targetKey} receipt.truncated`),
    nextCursor: optionalText(rawReceipt.nextCursor),
    blocker: optionalText(rawReceipt.blocker),
    blockers: normalizedTextArray(rawReceipt.blockers ?? [], `${targetKey} receipt.blockers`),
    coverageExtent: requiredText(
      rawReceipt.coverageExtent,
      `${targetKey} receipt.coverageExtent`
    ),
    sourceLimit: normalizeSourceLimit(rawReceipt.sourceLimit, targetKey)
  };
  if (receipt.targetKey !== targetKey) throw new Error(`${targetKey} receipt targetKey mismatch.`);
  if (!receipt.mappingVerified) throw new Error(`${targetKey} receipt mappingVerified must be true.`);
  if (receipt.sourceExhausted && receipt.truncated) {
    throw new Error(`${targetKey} cannot be both sourceExhausted and truncated.`);
  }
  for (const field of CUMULATIVE_FIELDS) {
    receipt[field] = nonNegativeInteger(rawReceipt[field], `${targetKey} receipt.${field}`);
  }
  if (receipt.pagesFetched > receipt.pagesAttempted) {
    throw new Error(`${targetKey} pagesFetched cannot exceed pagesAttempted.`);
  }
  receipt.earliest = optionalTimestamp(rawReceipt.earliest, `${targetKey} receipt.earliest`);
  receipt.latest = optionalTimestamp(rawReceipt.latest, `${targetKey} receipt.latest`);
  if (receipt.earliest && receipt.latest && receipt.earliest > receipt.latest) {
    throw new Error(`${targetKey} earliest cannot exceed latest.`);
  }
  if (expectedType === "page") {
    for (const field of [
      "pageItemsSeen", "pageAccepted", "pageRejected", "pageDuplicates"
    ]) {
      receipt[field] = nonNegativeInteger(rawReceipt[field], `${targetKey} receipt.${field}`);
    }
    const requestUrl = requiredText(rawReceipt.requestUrl, `${targetKey} receipt.requestUrl`);
    if (/(?:[?&](?:key|access_token|token)=)(?!REDACTED(?:&|$))[^&\s]+/i.test(requestUrl)) {
      throw new Error(`${targetKey} receipt.requestUrl contains an unredacted credential.`);
    }
  } else {
    receipt.outcome = requiredText(rawReceipt.outcome, `${targetKey} receipt.outcome`);
    if (!TARGET_OUTCOMES.has(receipt.outcome)) {
      throw new Error(`${targetKey} has unsupported historical-depth outcome ${receipt.outcome}.`);
    }
    receipt.credentialRequired = requiredBoolean(
      rawReceipt.credentialRequired,
      `${targetKey} receipt.credentialRequired`
    );
    receipt.requiredCredential = optionalText(rawReceipt.requiredCredential);
    receipt.nextAction = requiredOperationalText(
      rawReceipt.nextAction,
      `${targetKey} receipt.nextAction`
    );
    receipt.technicalCutoff = optionalText(rawReceipt.technicalCutoff);
    if (receipt.credentialRequired && !receipt.requiredCredential) {
      throw new Error(`${targetKey} credentialRequired needs requiredCredential.`);
    }
    if (receipt.outcome === "collected" && receipt.accepted === 0) {
      throw new Error(`${targetKey} collected outcome requires accepted evidence.`);
    }
    if (receipt.outcome === "verified_no_history" && receipt.accepted !== 0) {
      throw new Error(`${targetKey} verified_no_history cannot contain accepted evidence.`);
    }
    if (["collected", "verified_no_history"].includes(receipt.outcome) &&
        receipt.credentialRequired) {
      throw new Error(`${targetKey} successful terminal outcome cannot require credentials.`);
    }
  }
  return receipt;
}

function normalizeSourceLimit(value, targetKey) {
  assertObject(value, `${targetKey} receipt.sourceLimit`);
  const output = structuredClone(value);
  if (Object.keys(output).length === 0) {
    throw new Error(`${targetKey} receipt.sourceLimit must preserve a bounded source limit.`);
  }
  for (const [key, raw] of Object.entries(output)) {
    if (typeof raw === "number" && (!Number.isFinite(raw) || raw < 0)) {
      throw new Error(`${targetKey} receipt.sourceLimit.${key} must be bounded.`);
    }
  }
  return output;
}

function assertReceiptIdentity(receipt, target) {
  for (const [field, expected] of Object.entries(target.identity)) {
    if (receipt[field] !== expected) {
      throw new Error(
        `${target.targetKey} receipt ${field}=${receipt[field]} does not match ${expected}.`
      );
    }
  }
}

function assertCumulativeProgress(previous, current, targetKey) {
  for (const field of CUMULATIVE_FIELDS) {
    if (current[field] < previous[field]) {
      throw new Error(`${targetKey} cumulative ${field} decreases between pages.`);
    }
  }
  if (stableJson(previous.sourceLimit) !== stableJson(current.sourceLimit)) {
    throw new Error(`${targetKey} sourceLimit changes between pages.`);
  }
}

function consumeHistoricalDepthEvidence(rawRow, context) {
  assertObject(rawRow, `${context.target.targetKey} historical-depth evidence`);
  const target = context.target;
  for (const [field, expected] of Object.entries(target.identity)) {
    const actual = String(rawRow[field] ?? "").trim();
    const matches = ["entityType", "platform"].includes(field)
      ? actual.toLowerCase() === String(expected).toLowerCase()
      : actual === String(expected);
    if (!matches) {
      throw new Error(
        `${target.targetKey} evidence ${field} does not match its target attribution.`
      );
    }
  }
  const nativeId = optionalText(rawRow.nativeId);
  const externalId = optionalText(rawRow.externalId);
  const publishedAt = optionalTimestamp(
    rawRow.publishedAt,
    `${target.targetKey} evidence.publishedAt`
  );
  const canonicalUrl = normalizeNativeEvidenceUrl(target.identity.platform, rawRow.canonicalUrl);
  const sourceUrl = normalizeNativeEvidenceUrl(target.identity.platform, rawRow.sourceUrl);
  const accountUrl = optionalHttpsUrl(rawRow.accountUrl);
  const attributionStatus = optionalText(rawRow.attribution?.status)?.toLowerCase() ?? null;
  let rejection = null;
  if (!nativeId || !externalId) {
    rejection = evidenceRejection(
      context,
      rawRow,
      "missing_native_id",
      "Historical-depth evidence is missing its nativeId or namespaced externalId."
    );
  } else if (externalId !== `${target.identity.platform}:${nativeId}`) {
    rejection = evidenceRejection(
      context,
      rawRow,
      "native_id_mismatch",
      "Historical-depth externalId does not match platform and nativeId."
    );
  } else if (!publishedAt) {
    rejection = evidenceRejection(
      context,
      rawRow,
      "missing_published_at",
      "Historical-depth evidence has no exact native publication timestamp."
    );
  } else if (!canonicalUrl || !sourceUrl || canonicalUrl !== sourceUrl) {
    rejection = evidenceRejection(
      context,
      rawRow,
      "missing_or_conflicting_native_url",
      "Historical-depth evidence has no single credential-free canonical native URL."
    );
  } else if (!nativeUrlMatches(target.identity.platform, canonicalUrl, nativeId)) {
    rejection = evidenceRejection(
      context,
      rawRow,
      "invalid_native_url",
      "Historical-depth native URL does not match the platform and nativeId."
    );
  } else if (!accountUrl || attributionStatus !== "verified") {
    rejection = evidenceRejection(
      context,
      rawRow,
      "unverified_attribution",
      "Historical-depth evidence lacks verified native-account attribution."
    );
  }
  if (rejection) {
    target.rejectedEvidence.push(rejection);
    return;
  }
  const output = {
    batchSlug: target.identity.batchSlug,
    entityType: target.identity.entityType,
    entityId: target.identity.entityId,
    platform: target.identity.platform,
    nativeId,
    canonicalUrl,
    digest: physicalEvidenceDigest({
      platform: target.identity.platform,
      nativeId,
      canonicalUrl,
      publishedAt
    }),
    publishedAt,
    observedAt: context.recordedAt,
    accountUrl,
    title: optionalText(rawRow.title),
    text: optionalText(rawRow.text),
    metrics: rawRow.metrics ?? null,
    historicalDepthTargetKey: target.targetKey,
    historicalDepthPageSequence: context.sequence
  };
  const identityKey = `${target.identity.platform}\u0000${nativeId}`;
  const prior = target.evidenceIdentities.get(identityKey);
  if (prior) {
    if (stableJson(prior.output) !== stableJson(output)) {
      throw new Error(`${target.targetKey} has conflicting duplicate evidence ${nativeId}.`);
    }
    throw new Error(`${target.targetKey} repeats evidence ${nativeId} across journal pages.`);
  }
  const row = { output, sequence: context.sequence, index: context.index };
  target.evidenceIdentities.set(identityKey, row);
  target.evidence.push(row);
}

function evidenceRejection(context, row, reasonCode, reason) {
  return {
    targetKey: context.target.targetKey,
    pageSequence: context.sequence,
    evidenceIndex: context.index,
    externalId: optionalText(row.externalId),
    nativeId: optionalText(row.nativeId),
    sourceUrl: optionalText(row.sourceUrl),
    reasonCode,
    reason
  };
}

function finalizeJournalState(state, artifact) {
  if (!state.runInitialized) {
    throw new Error("Historical-depth journal is missing run_initialized.");
  }
  if (artifact.observedAt < state.lastRecordedAt) {
    throw new Error(
      "Historical-depth artifact.observedAt predates the journal's last recordedAt."
    );
  }
  if (state.runCompleted && state.runCompleted.sequence !== state.lastSequence) {
    throw new Error("Historical-depth run_completed must be the journal's final event.");
  }
}

function reconcileCanonicalPlan(catalogs, state, limits) {
  const plan = buildHistoricalDepthTargets(catalogs, {
    batches: state.runInitialized.batches,
    platforms: state.runInitialized.platforms
  });
  const selectedBatches = new Set(state.runInitialized.batches.map((value) => value.toUpperCase()));
  plan.__catalogs = catalogs.filter((catalog) =>
    selectedBatches.has(String(catalog.slug ?? catalog.batchSlug ?? "").toUpperCase())
  );
  if (plan.ownerPlatformPairsEvaluated > limits.maxOwnerPlatformPairs) {
    throw new Error(
      `Historical-depth plan exceeds maxOwnerPlatformPairs=${limits.maxOwnerPlatformPairs}.`
    );
  }
  const plannedKeys = plan.targets.map((target) => target.targetKey).sort();
  if (stableJson(plannedKeys) !== stableJson(state.expectedTargetKeys)) {
    const configured = new Set(state.expectedTargetKeys);
    const planned = new Set(plannedKeys);
    const missing = plannedKeys.filter((key) => !configured.has(key));
    const extra = state.expectedTargetKeys.filter((key) => !planned.has(key));
    throw new Error(
      `Historical-depth journal target inventory does not match canonical verified mappings; ` +
      `missing [${missing.join(", ")}], extra [${extra.join(", ")}].`
    );
  }
  const targetIndex = new Map(plan.targets.map((target) => [target.targetKey, target]));
  for (const [targetKey, targetState] of state.targetStates) {
    const canonicalTarget = targetIndex.get(targetKey);
    targetState.canonicalTarget = canonicalTarget;
    for (const receipt of [
      ...targetState.pages.map((page) => page.receipt),
      targetState.terminal?.receipt
    ].filter(Boolean)) {
      if ((receipt.accountUrl ?? null) !== (canonicalTarget.accountUrl ?? null)) {
        throw new Error(`${targetKey} receipt accountUrl does not match the canonical mapping.`);
      }
    }
    for (const row of targetState.evidence) {
      if (row.output.accountUrl !== canonicalTarget.accountUrl) {
        throw new Error(`${targetKey} evidence accountUrl does not match the canonical mapping.`);
      }
    }
  }
  reconcileSummaryPlan(state.runCompleted?.summary, plan);
  return plan;
}

function reconcileSummaryPlan(summary, plan) {
  if (!summary) return;
  for (const [field, expected] of [
    ["companiesEvaluated", plan.companiesEvaluated],
    ["foundersEvaluated", plan.foundersEvaluated],
    ["ownersEvaluated", plan.ownersEvaluated],
    ["ownerPlatformPairsEvaluated", plan.ownerPlatformPairsEvaluated],
    ["verifiedMappingsFound", plan.verifiedMappingsFound],
    ["verifiedAccountsMapped", plan.verifiedAccountsMapped],
    ["invalidVerifiedMappings", plan.invalidVerifiedMappings],
    ["unmappedOwnerPlatformPairs", plan.unmappedOwnerPlatformPairs],
    ["targetAccountPairs", plan.targetAccountPairs]
  ]) {
    if (nonNegativeInteger(summary[field], `run_completed.summary.${field}`) !== expected) {
      throw new Error(`Historical-depth run_completed.summary.${field} does not reconcile.`);
    }
  }
}

function normalizeCompletionProofs(values, context) {
  if (!Array.isArray(values)) throw new TypeError("completionProofs must be an array.");
  if (values.length > context.state.limits.maxTargets) {
    throw new Error(
      `Historical-depth completionProofs exceeds maxTargets=${context.state.limits.maxTargets}.`
    );
  }
  const proofs = new Map();
  for (const rawProof of values) {
    assertObject(rawProof, "historical-depth completion proof");
    assertKnownKeys(rawProof, new Set([
      "proofVersion", "targetKey", "status", "artifactSha256", "terminalSequence",
      "runCompletedSequence", "checkedAt", "coveredThrough", "receiptId",
      "coverageExtent", "technicalLimit", "reason"
    ]), "historical-depth completion proof");
    if (rawProof.proofVersion !== HISTORICAL_DEPTH_COMPLETION_PROOF_VERSION) {
      throw new Error("Historical-depth completion proofVersion is incompatible.");
    }
    if (rawProof.status !== "complete") {
      throw new Error("Historical-depth completion proof status must be complete.");
    }
    const targetKey = requiredText(rawProof.targetKey, "completionProof.targetKey");
    if (proofs.has(targetKey)) {
      throw new Error(`Duplicate historical-depth completion proof for ${targetKey}.`);
    }
    const target = context.state.targetStates.get(targetKey);
    if (!target || !target.terminal) {
      throw new Error(`Completion proof target ${targetKey} has no terminal receipt.`);
    }
    if (!context.state.runCompleted || context.state.runCompleted.status !== "completed") {
      throw new Error(
        "Historical-depth completion proof requires a reconciled completed run."
      );
    }
    const artifactSha256 = requiredSha256(
      rawProof.artifactSha256,
      `${targetKey} completionProof.artifactSha256`
    );
    if (artifactSha256 !== context.artifact.sha256) {
      throw new Error(`${targetKey} completion proof is bound to a different artifact hash.`);
    }
    if (positiveInteger(rawProof.terminalSequence, `${targetKey} terminalSequence`) !==
        target.terminal.sequence) {
      throw new Error(`${targetKey} completion proof terminalSequence does not match.`);
    }
    if (positiveInteger(rawProof.runCompletedSequence, `${targetKey} runCompletedSequence`) !==
        context.state.runCompleted.sequence) {
      throw new Error(`${targetKey} completion proof runCompletedSequence does not match.`);
    }
    const checkedAt = canonicalTimestamp(rawProof.checkedAt, `${targetKey} proof.checkedAt`);
    if (checkedAt !== target.terminal.recordedAt) {
      throw new Error(`${targetKey} completion proof checkedAt must equal terminal recordedAt.`);
    }
    const coveredThrough = canonicalTimestamp(
      rawProof.coveredThrough,
      `${targetKey} proof.coveredThrough`
    );
    if (coveredThrough !== context.recencyCutoffAt) {
      throw new Error(`${targetKey} completion proof must use the exact recency cutoff.`);
    }
    const coverageExtent = requiredText(
      rawProof.coverageExtent,
      `${targetKey} proof.coverageExtent`
    );
    if (coverageExtent !== target.terminal.receipt.coverageExtent) {
      throw new Error(`${targetKey} completion proof coverageExtent does not match terminal.`);
    }
    assertEligibleForCompletion(target);
    const receiptId = deterministicCompletionReceiptId({
      artifactSha256: context.artifact.sha256,
      targetKey,
      terminalSequence: target.terminal.sequence,
      runCompletedSequence: context.state.runCompleted.sequence,
      coveredThrough,
      coverageExtent,
      sourceLimit: target.terminal.receipt.sourceLimit,
      technicalCutoff: target.terminal.receipt.technicalCutoff ?? null
    });
    if (rawProof.receiptId !== undefined && rawProof.receiptId !== receiptId) {
      throw new Error(`${targetKey} completion proof receiptId is not deterministic.`);
    }
    proofs.set(targetKey, {
      receiptId,
      status: "complete",
      checkedAt,
      coveredThrough,
      coverageExtent,
      technicalLimit: requiredOperationalText(
        rawProof.technicalLimit,
        `${targetKey} proof.technicalLimit`
      ),
      reason: requiredOperationalText(rawProof.reason, `${targetKey} proof.reason`),
      sourceLimit: structuredClone(target.terminal.receipt.sourceLimit),
      technicalCutoff: target.terminal.receipt.technicalCutoff ?? null
    });
  }
  return proofs;
}

function assertEligibleForCompletion(target) {
  const receipt = target.terminal.receipt;
  if (!["collected", "verified_no_history"].includes(receipt.outcome)) {
    throw new Error(`${target.targetKey} blocked/manual target cannot be historical-complete.`);
  }
  if (!receipt.sourceExhausted || receipt.truncated || receipt.credentialRequired ||
      receipt.blocker || receipt.blockers.length > 0 || receipt.nextCursor !== null ||
      receipt.coverageExtent !== COMPLETE_EXTENTS[target.identity.platform]) {
    throw new Error(
      `${target.targetKey} terminal receipt is not eligible for historical completion proof.`
    );
  }
  if (target.identity.platform === "reddit" &&
      receipt.technicalCutoff !== "reddit_listing_window_maximum_1000_items") {
    throw new Error(`${target.targetKey} must preserve Reddit's listing-window cutoff.`);
  }
  if (target.identity.platform !== "reddit" && receipt.technicalCutoff) {
    throw new Error(`${target.targetKey} exhaustive terminal has an unresolved technical cutoff.`);
  }
  if (target.rejectedEvidence.length > 0) {
    throw new Error(`${target.targetKey} has rejected evidence and cannot be historical-complete.`);
  }
  if (receipt.outcome === "collected" && target.evidence.length !== receipt.accepted) {
    throw new Error(`${target.targetKey} collected evidence does not reconcile for completion.`);
  }
}

function normalizeCoverageRows(state, plan, { artifact, proofIndex, recencyCutoffAt }) {
  const taskPlan = [];
  const attempts = [];
  const evidence = [];
  const rejectedEvidence = [];
  const accountTargetCoverage = [];
  const targetsByPair = new Map();

  for (const targetKey of state.expectedTargetKeys) {
    const target = state.targetStates.get(targetKey);
    const task = taskForTarget(target);
    taskPlan.push(task);
    const attempt = attemptForTarget(target, artifact);
    if (attempt) attempts.push(attempt);
    for (const row of target.evidence) evidence.push(structuredClone(row.output));
    rejectedEvidence.push(...target.rejectedEvidence.map((row) => structuredClone(row)));
    const proof = proofIndex.get(targetKey) ?? null;
    accountTargetCoverage.push(accountTargetCoverageRow(target, proof));
    const pairKey = identityKey(target.identity);
    const rows = targetsByPair.get(pairKey) ?? [];
    rows.push({ target, proof });
    targetsByPair.set(pairKey, rows);
  }

  const ownerPairs = canonicalOwnerPairs(plan);
  const pairScopes = [];
  const pairCoverage = [];
  for (const pair of ownerPairs) {
    const rows = targetsByPair.get(identityKey(pair)) ?? [];
    if (rows.length === 0) {
      const task = unmappedTask(pair);
      taskPlan.push(task);
      attempts.push(unmappedAttempt(pair, artifact));
      pairCoverage.push(unmappedPairCoverage(pair, artifact.observedAt));
      continue;
    }
    const pairProof = pairCompletionProof(pair, rows, recencyCutoffAt);
    if (pairProof) {
      pairScopes.push({
        ...structuredClone(pair),
        scope: { historicalBackfillReceipt: pairProof }
      });
    }
    pairCoverage.push(mappedPairCoverage(pair, rows, pairProof));
  }

  const targetCoverage = [
    ...accountTargetCoverage,
    ...pairCoverage.filter((row) => row.mappingStatus === "unmapped")
  ].sort((left, right) => left.targetKey.localeCompare(right.targetKey));
  taskPlan.sort((left, right) => left.checkpointKey.localeCompare(right.checkpointKey));
  attempts.sort((left, right) => left.attemptKey.localeCompare(right.attemptKey));
  evidence.sort(compareEvidence);
  rejectedEvidence.sort(compareRejectedEvidence);
  accountTargetCoverage.sort((left, right) => left.targetKey.localeCompare(right.targetKey));
  pairCoverage.sort(compareIdentityRows);
  pairScopes.sort(compareIdentityRows);

  const pairStatusCounts = Object.fromEntries([
    "complete", "collected_partial", "verified_no_history", "access_blocked",
    "requires_credentials", "manual_review", "incomplete", "queued_unmapped"
  ].map((status) => [status, pairCoverage.filter((row) => row.status === status).length]));
  const coverageSummary = {
    companiesEvaluated: plan.companiesEvaluated,
    foundersEvaluated: plan.foundersEvaluated,
    ownersEvaluated: plan.ownersEvaluated,
    ownerPlatformPairsEvaluated: plan.ownerPlatformPairsEvaluated,
    verifiedMappingsFound: plan.verifiedMappingsFound,
    verifiedAccountsMapped: plan.verifiedAccountsMapped,
    mappedOwnerPlatformPairs: pairCoverage.filter((row) => row.mappingStatus === "mapped").length,
    unmappedOwnerPlatformPairs: pairCoverage.filter((row) => row.mappingStatus === "unmapped").length,
    targetAccountPairs: plan.targetAccountPairs,
    completedTargetAccountPairs: state.targetsWithTerminal,
    pairStatusCounts,
    byPlatform: structuredClone(plan.byPlatform),
    byBatch: structuredClone(plan.batches)
  };
  if (coverageSummary.unmappedOwnerPlatformPairs !== plan.unmappedOwnerPlatformPairs) {
    throw new Error("Historical-depth explicit unmapped pair rows do not reconcile with plan.");
  }
  return {
    taskPlan,
    attempts,
    evidence,
    pairScopes,
    targetCoverage,
    accountTargetCoverage,
    pairCoverage,
    rejectedEvidence,
    coverageSummary
  };
}

function canonicalOwnerPairs(plan) {
  const pairs = [];
  for (const batch of plan.batches) {
    for (const platform of Object.keys(batch.byPlatform).sort()) {
      // Pair identities are recovered from targets plus the canonical batch
      // roster supplied to buildHistoricalDepthTargets below.
      void platform;
    }
  }
  // buildHistoricalDepthTargets intentionally retains aggregate denominators
  // only. Its private source catalogs are attached by reconcileCanonicalPlan.
  for (const catalog of plan.__catalogs) {
    for (const company of [...(catalog.companies ?? [])].sort(compareSourceEntity)) {
      const owners = [company, ...[...(company.founders ?? [])].sort(compareSourceEntity)];
      for (const owner of owners) {
        for (const platform of plan.platforms) {
          pairs.push({
            batchSlug: catalog.slug,
            entityType: owner === company ? "company" : "founder",
            entityId: requiredText(owner.sourceKey ?? owner.id, "canonical owner sourceKey"),
            platform
          });
        }
      }
    }
  }
  return pairs.sort(compareIdentityRows);
}

function taskForTarget(target) {
  const accountUrl = target.canonicalTarget.accountUrl;
  return {
    ...structuredClone(target.identity),
    entitySourceKey: target.identity.entityId,
    ...(target.identity.entityType === "company"
      ? { companySourceKey: target.identity.entityId }
      : {}),
    account: accountUrl ? {
      platform: target.identity.platform,
      url: accountUrl,
      handle: target.canonicalTarget.accountHandle,
      verificationStatus: "verified"
    } : null,
    checkpointKey: `historical-depth:${target.targetKey}`,
    status: "queued",
    terminalReason: null
  };
}

function unmappedTask(identity) {
  return {
    ...structuredClone(identity),
    entitySourceKey: identity.entityId,
    ...(identity.entityType === "company" ? { companySourceKey: identity.entityId } : {}),
    account: null,
    checkpointKey: `historical-depth-unmapped:${identityKey(identity)}`,
    status: "queued",
    terminalReason: null
  };
}

function attemptForTarget(target, artifact) {
  const terminal = target.terminal;
  const lastPage = target.pages.at(-1) ?? null;
  if (!terminal && !lastPage) return null;
  const translation = translateTargetOutcome(target);
  return {
    attemptKey: `historical-depth:${target.targetKey}`,
    ...structuredClone(target.identity),
    accountUrl: target.canonicalTarget.accountUrl,
    status: "done",
    outcomeStatus: translation.status,
    outcomeReason: translation.reason,
    error: translation.error,
    startedAt: target.pages[0]?.recordedAt ?? terminal?.recordedAt ?? lastPage.recordedAt,
    checkedAt: terminal?.recordedAt ?? lastPage.recordedAt,
    retryable: translation.retryable,
    historicalDepthArtifactSha256: artifact.sha256,
    historicalDepthTerminalSequence: terminal?.sequence ?? null
  };
}

function unmappedAttempt(identity, artifact) {
  const pairKey = identityKey(identity);
  const reason =
    `Manual review required: ${pairKey} has no verified native account mapping in the ` +
    "canonical catalog; this queued discovery outcome is not no-account proof.";
  return {
    attemptKey: `historical-depth-unmapped:${pairKey}`,
    ...structuredClone(identity),
    accountUrl: null,
    status: "done",
    outcomeStatus: "needs_review",
    outcomeReason: reason,
    error: reason,
    startedAt: artifact.observedAt,
    checkedAt: artifact.observedAt,
    retryable: false,
    historicalDepthArtifactSha256: artifact.sha256,
    historicalDepthTerminalSequence: null
  };
}

function translateTargetOutcome(target) {
  if (!target.terminal) {
    const reason =
      `Manual review required: ${target.targetKey} has no target_completed receipt.`;
    return { status: "needs_review", reason, error: reason, retryable: true };
  }
  const receipt = target.terminal.receipt;
  if (receipt.outcome === "collected") {
    if (target.rejectedEvidence.length > 0 || target.evidence.length === 0) {
      const reason =
        `Manual review required: ${target.targetKey} reported ${receipt.accepted} accepted ` +
        `rows but ${target.rejectedEvidence.length} failed native evidence integrity.`;
      return { status: "needs_review", reason, error: reason, retryable: false };
    }
    return {
      status: "completed",
      reason:
        `Historical-depth target ${target.targetKey} collected timestamped native rows; ` +
        `exact extent ${receipt.coverageExtent}.`,
      error: null,
      retryable: false
    };
  }
  if (receipt.outcome === "verified_no_history") {
    const reason =
      `Manual review required: ${target.targetKey} returned verified_no_history for a ` +
      "mapped account; it does not prove that no native account exists.";
    return { status: "needs_review", reason, error: reason, retryable: false };
  }
  if (receipt.outcome === "manual_review") {
    const exact = exactBlockers(receipt);
    const reason = receipt.credentialRequired
      ? `Required production credential ${receipt.requiredCredential} is missing for ` +
        `${target.targetKey}; exact blocker ${exact}.`
      : `Manual review required for ${target.targetKey}; exact blocker ${exact}.`;
    return {
      status: receipt.credentialRequired ? "requires_credentials" : "needs_review",
      reason,
      error: reason,
      retryable: false
    };
  }
  return translateAccessBlock(target.targetKey, receipt);
}

function translateAccessBlock(targetKey, receipt) {
  const exact = exactBlockers(receipt);
  const blockerClasses = classifyBlockerClasses(exact);
  if (blockerClasses.size !== 1) {
    const reason =
      `Manual review required for ${targetKey}; exact access blocker ${exact} could not ` +
      "be reduced to one safe terminal class.";
    return { status: "needs_review", reason, error: reason, retryable: false };
  }
  const blockerClass = [...blockerClasses][0];
  const label = {
    captcha_required: "CAPTCHA required",
    rate_limited: "Rate limit blocked collection",
    access_denied: "Access denied",
    network_error: "Network/provider failure blocked collection"
  }[blockerClass];
  const reason = `${label} for ${targetKey}; exact historical-depth blocker ${exact}.`;
  return { status: "failed", reason, error: reason, retryable: false };
}

function classifyBlockerClasses(value) {
  const classes = new Set();
  if (/captcha|challenge/i.test(value)) classes.add("captcha_required");
  if (/(?:rate.?limit|http_429|\b429\b)/i.test(value)) classes.add("rate_limited");
  if (/(?:http_403|robots|access.?denied|forbidden|access_wall)/i.test(value)) {
    classes.add("access_denied");
  }
  if (/(?:network|timeout|socket|econn|request|circuit|http_5\d\d|body_limit)/i.test(value)) {
    classes.add("network_error");
  }
  return classes;
}

function exactBlockers(receipt) {
  return [...new Set([receipt.blocker, ...receipt.blockers].filter(Boolean))].join(" | ") ||
    "none_recorded";
}

function accountTargetCoverageRow(target, proof) {
  const terminal = target.terminal;
  const receipt = terminal?.receipt ?? null;
  const translation = translateTargetOutcome(target);
  const scopeStatus = proof
    ? "complete"
    : !terminal
      ? "incomplete"
      : receipt.outcome === "access_blocked"
        ? "failed"
        : receipt.outcome === "manual_review"
          ? receipt.credentialRequired ? "requires_credentials" : "manual_review"
          : "partial";
  return {
    targetKey: target.targetKey,
    ...structuredClone(target.identity),
    mappingStatus: target.canonicalTarget.mappingBlocker ? "invalid_verified_mapping" : "mapped",
    accountUrl: target.canonicalTarget.accountUrl,
    outcome: receipt?.outcome ?? "not_completed",
    translatedOutcomeStatus: translation.status,
    scopeStatus,
    checkedAt: terminal?.recordedAt ?? target.pages.at(-1)?.recordedAt ?? null,
    sourceExhausted: receipt?.sourceExhausted ?? false,
    truncated: receipt?.truncated ?? false,
    credentialRequired: receipt?.credentialRequired ?? false,
    requiredCredential: receipt?.requiredCredential ?? null,
    blocker: receipt?.blocker ?? (terminal ? null : "target_terminal_receipt_missing"),
    blockers: receipt?.blockers ?? (terminal ? [] : ["target_terminal_receipt_missing"]),
    coverageExtent: receipt?.coverageExtent ?? "incomplete_journal_target",
    technicalCutoff: receipt?.technicalCutoff ?? null,
    sourceLimit: receipt ? structuredClone(receipt.sourceLimit) : null,
    pagesAttempted: receipt?.pagesAttempted ?? target.pages.at(-1)?.receipt.pagesAttempted ?? 0,
    pagesFetched: receipt?.pagesFetched ?? target.pages.at(-1)?.receipt.pagesFetched ?? 0,
    accepted: receipt?.accepted ?? target.pages.at(-1)?.receipt.accepted ?? 0,
    emittedEvidence: target.evidence.length,
    rejectedEvidence: target.rejectedEvidence.length,
    completionReceiptId: proof?.receiptId ?? null,
    recencyCutoffAt: proof?.coveredThrough ?? null,
    nextAction: proof
      ? "Retain the proof-bound source limit and continue scheduled incremental ingestion."
      : receipt?.nextAction ?? "Resume the exact journal until target_completed is recorded."
  };
}

function unmappedPairCoverage(identity, checkedAt) {
  const pairKey = identityKey(identity);
  return {
    targetKey: `unmapped:${pairKey}`,
    ...structuredClone(identity),
    pairKey,
    mappingStatus: "unmapped",
    mappedAccountTargets: 0,
    status: "queued_unmapped",
    outcome: "requires_mapping",
    translatedOutcomeStatus: "needs_review",
    scopeStatus: "manual_review",
    checkedAt,
    credentialRequired: false,
    blocker: "verified_native_account_mapping_missing",
    blockers: ["verified_native_account_mapping_missing"],
    coverageExtent: "not_started_verified_mapping_required",
    technicalCutoff: null,
    completionReceiptId: null,
    nextAction:
      `Discover and verify the official ${identity.platform} account for ${pairKey}, then ` +
      "queue a bounded historical-depth target; do not infer native-account absence."
  };
}

function mappedPairCoverage(identity, rows, pairProof) {
  const pairKey = identityKey(identity);
  const accountRows = rows.map(({ target, proof }) => accountTargetCoverageRow(target, proof));
  let status = "incomplete";
  if (pairProof) status = "complete";
  else if (accountRows.some((row) => row.scopeStatus === "requires_credentials")) {
    status = "requires_credentials";
  } else if (accountRows.some((row) => row.scopeStatus === "failed")) {
    status = "access_blocked";
  } else if (accountRows.some((row) => row.scopeStatus === "manual_review")) {
    status = "manual_review";
  } else if (accountRows.some((row) => row.outcome === "collected")) {
    status = "collected_partial";
  } else if (accountRows.every((row) => row.outcome === "verified_no_history")) {
    status = "verified_no_history";
  }
  return {
    targetKey: `pair:${pairKey}`,
    ...structuredClone(identity),
    pairKey,
    mappingStatus: "mapped",
    mappedAccountTargets: rows.length,
    status,
    scopeStatus: pairProof ? "complete" : "partial",
    accountTargetKeys: rows.map(({ target }) => target.targetKey).sort(),
    completedAccountTargets: rows.filter(({ target }) => Boolean(target.terminal)).length,
    completionReceiptId: pairProof?.receiptId ?? null,
    blockers: [...new Set(accountRows.flatMap((row) => row.blockers))].sort(),
    credentialRequired: accountRows.some((row) => row.credentialRequired),
    nextAction: pairProof
      ? "Retain every account-bound proof and continue scheduled incremental ingestion."
      : "Resolve every mapped account target or record its exact technical blocker."
  };
}

function pairCompletionProof(identity, rows, recencyCutoffAt) {
  if (!rows.length || rows.some(({ proof }) => !proof)) return null;
  const proofs = rows.map(({ proof }) => proof).sort((a, b) =>
    a.receiptId.localeCompare(b.receiptId)
  );
  const checkedAt = proofs.map((proof) => proof.checkedAt).sort().at(-1);
  const receiptId = `historical-depth-pair-${sha256(stableJson({
    pairKey: identityKey(identity),
    receipts: proofs.map((proof) => proof.receiptId),
    coveredThrough: recencyCutoffAt
  }))}`;
  const limitSummary = proofs.map((proof) => ({
    coverageExtent: proof.coverageExtent,
    sourceLimit: proof.sourceLimit,
    technicalCutoff: proof.technicalCutoff,
    technicalLimit: proof.technicalLimit
  }));
  return {
    receiptId,
    status: "complete",
    checkedAt,
    coveredThrough: recencyCutoffAt,
    technicalLimit:
      `Bound to ${proofs.length} exact verified-account receipt(s); preserved endpoint ` +
      `limits sha256=${sha256(stableJson(limitSummary))}.`,
    reason:
      `Every verified account target for ${identityKey(identity)} has a proof-bound ` +
      "exhaustive endpoint receipt; source-specific limits remain in depth coverage provenance."
  };
}

function identityFromTargetKey(targetKey) {
  const parts = requiredText(targetKey, "historical-depth targetKey").split(":");
  if (parts.length < 5) throw new Error(`Historical-depth targetKey ${targetKey} is malformed.`);
  const batchSlug = parts.shift();
  const entityType = parts.shift()?.toLowerCase();
  const targetHash = parts.pop();
  const platform = normalizePlatform(parts.pop());
  const entityId = parts.join(":");
  if (!ENTITY_TYPES.has(entityType)) {
    throw new Error(`Historical-depth targetKey ${targetKey} has invalid entity type.`);
  }
  if (!entityId || !TARGET_HASH.test(targetHash ?? "")) {
    throw new Error(`Historical-depth targetKey ${targetKey} has invalid identity or hash.`);
  }
  return { batchSlug, entityType, entityId, platform };
}

function normalizePlatform(value) {
  const platform = requiredText(value, "historical-depth platform")
    .toLowerCase()
    .replace(/-/g, "_");
  if (!HISTORICAL_DEPTH_PLATFORMS.includes(platform)) {
    throw new Error(`Unsupported historical-depth platform ${platform}.`);
  }
  return platform;
}

function normalizeNativeEvidenceUrl(platform, value) {
  const url = optionalHttpsUrl(value);
  if (!url) return null;
  const parsed = new URL(url);
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (platform === "reddit" && parsed.hostname === "old.reddit.com") {
    parsed.hostname = "reddit.com";
  }
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString();
}

function nativeUrlMatches(platform, rawUrl, nativeId) {
  const url = new URL(rawUrl);
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (platform === "youtube") {
    return ["youtube.com", "youtu.be"].includes(host) &&
      (url.searchParams.get("v") === nativeId || url.pathname === `/${nativeId}`);
  }
  if (platform === "product_hunt") {
    return host === "producthunt.com" && /^\/posts\/[A-Za-z0-9_-]+$/.test(url.pathname);
  }
  return host === "reddit.com" && /^\/r\/[^/]+\/comments\//i.test(url.pathname);
}

function normalizeArtifact(value, generatedAt) {
  assertObject(value, "historical-depth artifact");
  assertKnownKeys(value, new Set(["path", "sha256", "observedAt"]),
    "historical-depth artifact");
  const observedAt = canonicalTimestamp(
    value.observedAt,
    "historical-depth artifact.observedAt"
  );
  if (observedAt > generatedAt) {
    throw new Error("historical-depth artifact.observedAt cannot exceed generatedAt.");
  }
  return {
    path: requiredText(value.path, "historical-depth artifact.path"),
    sha256: requiredSha256(value.sha256, "historical-depth artifact.sha256"),
    observedAt
  };
}

function normalizeLimits(overrides) {
  assertObject(overrides ?? {}, "historical-depth coverage adapter limits");
  const limits = { ...HISTORICAL_DEPTH_COVERAGE_ADAPTER_LIMITS };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!(key in limits)) throw new Error(`Unknown historical-depth adapter limit ${key}.`);
    limits[key] = positiveInteger(value, `historical-depth adapter limit ${key}`);
  }
  return limits;
}

function deterministicCompletionReceiptId(value) {
  return `historical-depth-${sha256(stableJson(value))}`;
}

function physicalEvidenceDigest(value) {
  return sha256(stableJson({ schema: "historical-depth-physical-evidence.v1", ...value }));
}

function compareEvidence(left, right) {
  return identityKey(left).localeCompare(identityKey(right)) ||
    left.nativeId.localeCompare(right.nativeId) ||
    left.canonicalUrl.localeCompare(right.canonicalUrl);
}

function compareIdentityRows(left, right) {
  return left.batchSlug.localeCompare(right.batchSlug) ||
    left.entityType.localeCompare(right.entityType) ||
    left.entityId.localeCompare(right.entityId) ||
    left.platform.localeCompare(right.platform);
}

function compareRejectedEvidence(left, right) {
  return left.targetKey.localeCompare(right.targetKey) ||
    left.pageSequence - right.pageSequence || left.evidenceIndex - right.evidenceIndex;
}

function compareSourceEntity(left, right) {
  return String(left?.sourceKey ?? left?.id ?? "")
    .localeCompare(String(right?.sourceKey ?? right?.id ?? ""));
}

function identityKey(value) {
  return `${value.batchSlug}:${value.entityType}:${value.entityId}:${value.platform}`;
}

function sortedUniqueText(values, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array.`);
  const normalized = values.map((value, index) => requiredText(value, `${label}[${index}]`));
  const unique = [...new Set(normalized)].sort();
  if (unique.length !== normalized.length) throw new Error(`${label} contains duplicates.`);
  if (stableJson(unique) !== stableJson(normalized)) {
    throw new Error(`${label} must use canonical sorted ordering.`);
  }
  return unique;
}

function uniqueText(values, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array.`);
  const normalized = values.map((value, index) => requiredText(value, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} contains duplicates.`);
  }
  return normalized;
}

function normalizedTextArray(values, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array.`);
  return values.map((value, index) => requiredText(value, `${label}[${index}]`));
}

function requiredOperationalText(value, label, minimumLength = 16) {
  const text = requiredText(value, label);
  if (text.length < minimumLength) {
    throw new Error(`${label} must contain an exact operational explanation.`);
  }
  return text;
}

function canonicalTimestamp(value, label) {
  const text = requiredText(value, label);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    throw new TypeError(`${label} must be a canonical ISO-8601 UTC timestamp.`);
  }
  return text;
}

function optionalTimestamp(value, label) {
  if (value === null || value === undefined || value === "") return null;
  return canonicalTimestamp(value, label);
}

function optionalHttpsUrl(value) {
  const text = optionalText(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function requiredBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean.`);
  return value;
}

function requiredSha256(value, label) {
  const text = requiredText(value, label).toLowerCase();
  if (!SHA256.test(text)) throw new TypeError(`${label} must be a lowercase sha256 digest.`);
  return text;
}

function requiredText(value, label) {
  const text = optionalText(value);
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}

function optionalText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field ${key}.`);
  }
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
