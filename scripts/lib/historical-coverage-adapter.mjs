import { createHash } from "node:crypto";
import {
  INGESTION_RECENCY_WINDOW_DAYS
} from "./ingestion-coverage-receipt.mjs";
import {
  HISTORICAL_BACKFILL_PLATFORMS,
  HISTORICAL_BACKFILL_RUNNER_VERSION,
  HISTORICAL_BACKFILL_SCHEMA_VERSION
} from "./historical-backfill.mjs";

export const HISTORICAL_COVERAGE_ADAPTER_VERSION =
  "historical-coverage-adapter.v1";
export const HISTORICAL_COVERAGE_PROVENANCE_VERSION =
  "historical-coverage-provenance.v1";
export const HISTORICAL_COMPLETION_PROOF_VERSION =
  "historical-completion-proof.v1";

export const HISTORICAL_COVERAGE_ADAPTER_LIMITS = Object.freeze({
  maxJournalBytes: 512 * 1024 * 1024,
  maxLineBytes: 16 * 1024 * 1024,
  maxEvents: 250_000,
  maxTargets: 10_000,
  maxEvidence: 2_000_000
});

const SHA256 = /^[a-f0-9]{64}$/;
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
const EXHAUSTIVE_COVERAGE_EXTENTS = new Set([
  "all_available_search_results",
  "all_discovered_official_feed_entries_within_endpoint_policy",
  "all_discovered_official_web_history_within_endpoint_policy"
]);
const VERIFIED_NO_HISTORY_MARKERS = new Set([
  "no_feed_entries_found_within_verified_official_sources",
  "no_historical_pages_found_within_verified_official_sources"
]);
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
 * Convert one historical pages.ndjson stream into inputs accepted by
 * adaptAutonomousIngestionCoverage(). The source journal is consumed once and
 * hashed while it is parsed. Memory is bounded by the normalized output rows,
 * plus one configured NDJSON line.
 *
 * Historical completion is deliberately proof-gated. A terminal receipt,
 * sourceExhausted=true, or truncated=false never creates a complete scope on
 * its own. Only an explicit completionProof bound to this artifact, terminal,
 * run-completion event, and versioned recency cutoff can do so.
 */
export async function adaptHistoricalBackfillCoverage({
  journal,
  artifact,
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
    consumeEvent(event, lineNumber, state);
  });

  if (parsed.sha256 !== normalizedArtifact.sha256) {
    throw new Error(
      `Historical journal sha256 mismatch: expected ${normalizedArtifact.sha256}, ` +
      `computed ${parsed.sha256}.`
    );
  }
  finalizeJournalState(state, normalizedArtifact);

  const proofIndex = normalizeCompletionProofs(completionProofs, {
    state,
    artifact: normalizedArtifact,
    recencyCutoffAt
  });
  const normalized = normalizeTargets(state, {
    artifact: normalizedArtifact,
    proofIndex,
    recencyCutoffAt
  });

  const collectorArtifact = {
    kind: "public",
    artifact: structuredClone(normalizedArtifact),
    snapshot: {
      source: {
        collector: "historical-backfill-coverage-bridge",
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
    schemaVersion: HISTORICAL_COVERAGE_PROVENANCE_VERSION,
    adapterVersion: HISTORICAL_COVERAGE_ADAPTER_VERSION,
    generatedAt: normalizedGeneratedAt,
    recencyCutoffAt,
    sourceArtifact: {
      kind: "historical",
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
      expectedTargets: state.expectedTargetKeys.length,
      terminalTargets: state.targetsWithTerminal
    },
    normalizedRows: {
      tasks: normalized.taskPlan.length,
      attempts: normalized.attempts.length,
      evidence: normalized.evidence.length,
      rejectedEvidence: normalized.rejectedEvidence.length,
      outboundLinks: normalized.outboundLinks.length,
      pairScopes: normalized.pairScopes.length,
      targetCoverage: normalized.targetCoverage.length
    }
  };

  return {
    taskPlan: normalized.taskPlan,
    collectorArtifacts: [collectorArtifact],
    pairScopes: normalized.pairScopes,
    targetCoverage: normalized.targetCoverage,
    rejectedEvidence: normalized.rejectedEvidence,
    outboundLinks: normalized.outboundLinks,
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
        `Historical journal exceeds maxJournalBytes=${limits.maxJournalBytes}.`
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
        `Historical journal line ${lineNumber + 1} exceeds maxLineBytes=${limits.maxLineBytes}.`
      );
    }
  }

  pending += decoder.decode();
  if (finalByte !== 0x0a) {
    throw new Error("Historical journal must end with a newline; the tail may be truncated.");
  }
  if (pending.length > 0) {
    throw new Error("Historical journal contains data after its final newline.");
  }
  if (lineNumber === 0) throw new Error("Historical journal must not be empty.");
  return { bytes, sha256: hash.digest("hex") };
}

function consumeLine(line, lineNumber, limits, onEvent) {
  if (line.length === 0) {
    throw new Error(`Historical journal line ${lineNumber} must not be blank.`);
  }
  if (Buffer.byteLength(line, "utf8") > limits.maxLineBytes) {
    throw new Error(
      `Historical journal line ${lineNumber} exceeds maxLineBytes=${limits.maxLineBytes}.`
    );
  }
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    throw new Error(`Historical journal line ${lineNumber} is not valid JSON.`);
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

function consumeEvent(rawEvent, lineNumber, state) {
  assertObject(rawEvent, `Historical journal line ${lineNumber}`);
  const eventType = requiredText(rawEvent.type, `Historical journal line ${lineNumber}.type`);
  if (!EVENT_TYPES.has(eventType)) {
    throw new Error(`Unsupported historical journal event type ${eventType}.`);
  }
  const sequence = positiveInteger(
    rawEvent.sequence,
    `Historical journal line ${lineNumber}.sequence`
  );
  if (sequence !== state.lastSequence + 1) {
    throw new Error(
      `Historical journal sequence must be contiguous; expected ${state.lastSequence + 1}, received ${sequence}.`
    );
  }
  const recordedAt = canonicalTimestamp(
    rawEvent.recordedAt,
    `Historical journal sequence ${sequence}.recordedAt`
  );
  if (state.lastRecordedAt && recordedAt < state.lastRecordedAt) {
    throw new Error(`Historical journal recordedAt decreases at sequence ${sequence}.`);
  }
  if (rawEvent.schemaVersion !== HISTORICAL_BACKFILL_SCHEMA_VERSION) {
    throw new Error(
      `Historical journal sequence ${sequence} schemaVersion must be ` +
      `${HISTORICAL_BACKFILL_SCHEMA_VERSION}.`
    );
  }
  if (state.runCompleted) {
    throw new Error(`Historical journal contains ${eventType} after run_completed.`);
  }

  if (eventType === "run_initialized") {
    consumeRunInitialized(rawEvent, { sequence, recordedAt }, state);
  } else {
    if (!state.runInitialized) {
      throw new Error("Historical journal must begin with run_initialized.");
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
    throw new Error(`Historical journal exceeds maxEvents=${state.limits.maxEvents}.`);
  }
  state.firstSequence ??= sequence;
  state.firstRecordedAt ??= recordedAt;
  state.lastSequence = sequence;
  state.lastRecordedAt = recordedAt;
}

function consumeRunInitialized(event, timing, state) {
  assertKnownKeys(event, new Set([
    "schemaVersion",
    "sequence",
    "recordedAt",
    "type",
    "config",
    "configFingerprint",
    "startedAt"
  ]), `run_initialized sequence ${timing.sequence}`);
  if (timing.sequence !== 1 || state.runInitialized) {
    throw new Error("Historical journal must contain exactly one first run_initialized event.");
  }
  assertObject(event.config, "run_initialized.config");
  const configFingerprint = requiredSha256(
    event.configFingerprint,
    "run_initialized.configFingerprint"
  );
  const computedFingerprint = sha256(stableJson(event.config));
  if (computedFingerprint !== configFingerprint) {
    throw new Error("run_initialized.configFingerprint does not match its canonical config.");
  }
  if (event.config.schemaVersion !== HISTORICAL_BACKFILL_SCHEMA_VERSION) {
    throw new Error("run_initialized.config schemaVersion is incompatible.");
  }
  if (event.config.runnerVersion !== HISTORICAL_BACKFILL_RUNNER_VERSION) {
    throw new Error("run_initialized.config runnerVersion is incompatible.");
  }
  const targetKeys = sortedUniqueText(
    event.config.targetKeys,
    "run_initialized.config.targetKeys"
  );
  if (targetKeys.length > state.limits.maxTargets) {
    throw new Error(`Historical journal exceeds maxTargets=${state.limits.maxTargets}.`);
  }
  const configuredPlatforms = sortedUniqueText(
    event.config.platforms,
    "run_initialized.config.platforms"
  );
  for (const platform of configuredPlatforms) normalizePlatform(platform);
  for (const targetKey of targetKeys) {
    const identity = identityFromTargetKey(targetKey);
    if (!configuredPlatforms.includes(identity.platform)) {
      throw new Error(`${targetKey} uses a platform absent from run_initialized.config.platforms.`);
    }
    state.targetStates.set(targetKey, newTargetState(targetKey, identity));
  }
  const startedAt = canonicalTimestamp(event.startedAt, "run_initialized.startedAt");
  if (startedAt > timing.recordedAt) {
    throw new Error("run_initialized.startedAt must not exceed its journal recordedAt.");
  }
  state.expectedTargetKeys = targetKeys;
  state.runInitialized = {
    sequence: timing.sequence,
    recordedAt: timing.recordedAt,
    startedAt,
    configFingerprint,
    config: structuredClone(event.config)
  };
}

function newTargetState(targetKey, identity) {
  return {
    targetKey,
    identity,
    pages: [],
    terminal: null,
    evidence: [],
    evidenceIdentities: new Map(),
    rejectedEvidence: []
  };
}

function consumePageCheckpoint(event, timing, state) {
  assertKnownKeys(event, new Set([
    "schemaVersion",
    "sequence",
    "recordedAt",
    "type",
    "targetKey",
    "receipt",
    "evidence",
    "progress"
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
      throw new Error(`Historical journal exceeds maxEvidence=${state.limits.maxEvidence}.`);
    }
    consumeHistoricalEvidence(event.evidence[index], {
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
    "schemaVersion",
    "sequence",
    "recordedAt",
    "type",
    "targetKey",
    "receipt"
  ]), `target_completed sequence ${timing.sequence}`);
  const target = resolveTargetState(event.targetKey, state);
  if (target.terminal) throw new Error(`${target.targetKey} has duplicate terminal receipts.`);
  const receipt = normalizeReceipt(event.receipt, "target", target.targetKey);
  assertReceiptIdentity(receipt, target);
  const previous = target.pages.at(-1)?.receipt ?? null;
  if (previous) {
    for (const field of CUMULATIVE_FIELDS) {
      if (receipt[field] !== previous[field]) {
        throw new Error(`${target.targetKey} terminal ${field} does not match its last page.`);
      }
    }
  } else if (receipt.pagesAttempted !== 0 || receipt.pagesFetched !== 0) {
    throw new Error(`${target.targetKey} terminal reports pages without page checkpoints.`);
  }
  if (receipt.accepted !== target.evidence.length + target.rejectedEvidence.length) {
    throw new Error(
      `${target.targetKey} terminal accepted count does not reconcile with journaled evidence.`
    );
  }
  target.terminal = {
    sequence: timing.sequence,
    recordedAt: timing.recordedAt,
    receipt
  };
  state.targetsWithTerminal += 1;
}

function consumeRunCompleted(event, timing, state) {
  assertKnownKeys(event, new Set([
    "schemaVersion",
    "sequence",
    "recordedAt",
    "type",
    "summary"
  ]), `run_completed sequence ${timing.sequence}`);
  assertObject(event.summary, "run_completed.summary");
  const status = requiredText(event.summary.status, "run_completed.summary.status");
  if (!new Set(["completed", "incomplete"]).has(status)) {
    throw new Error("run_completed.summary.status must be completed or incomplete.");
  }
  const expected = nonNegativeInteger(
    event.summary.targetPlatformPairs,
    "run_completed.summary.targetPlatformPairs"
  );
  const completed = nonNegativeInteger(
    event.summary.completedTargetPlatformPairs,
    "run_completed.summary.completedTargetPlatformPairs"
  );
  if (expected !== state.expectedTargetKeys.length || completed !== state.targetsWithTerminal) {
    throw new Error("run_completed.summary target counts do not reconcile with the journal.");
  }
  if (status === "completed" && completed !== expected) {
    throw new Error("A completed historical summary must contain every configured terminal target.");
  }
  state.runCompleted = {
    sequence: timing.sequence,
    recordedAt: timing.recordedAt,
    status,
    summary: structuredClone(event.summary)
  };
}

function resolveTargetState(rawTargetKey, state) {
  const targetKey = requiredText(rawTargetKey, "historical event.targetKey");
  const target = state.targetStates.get(targetKey);
  if (!target) throw new Error(`Historical event references unconfigured target ${targetKey}.`);
  return target;
}

function normalizeReceipt(rawReceipt, expectedType, targetKey) {
  assertObject(rawReceipt, `${targetKey} ${expectedType} receipt`);
  if (rawReceipt.schemaVersion !== HISTORICAL_BACKFILL_SCHEMA_VERSION) {
    throw new Error(`${targetKey} receipt schemaVersion is incompatible.`);
  }
  if (rawReceipt.runnerVersion !== HISTORICAL_BACKFILL_RUNNER_VERSION) {
    throw new Error(`${targetKey} receipt runnerVersion is incompatible.`);
  }
  if (rawReceipt.receiptType !== expectedType) {
    throw new Error(`${targetKey} receiptType must be ${expectedType}.`);
  }
  const platform = normalizePlatform(rawReceipt.platform);
  const provider = requiredText(rawReceipt.provider, `${targetKey} receipt.provider`);
  if (provider !== platform) throw new Error(`${targetKey} receipt provider/platform mismatch.`);
  const entityType = requiredText(
    rawReceipt.entityType,
    `${targetKey} receipt.entityType`
  ).toLowerCase();
  if (!ENTITY_TYPES.has(entityType)) {
    throw new Error(`${targetKey} receipt.entityType must be company or founder.`);
  }
  const receipt = {
    ...structuredClone(rawReceipt),
    batchSlug: requiredText(rawReceipt.batchSlug, `${targetKey} receipt.batchSlug`),
    entityType,
    entityId: requiredText(rawReceipt.entityId, `${targetKey} receipt.entityId`),
    platform,
    provider,
    sourceExhausted: requiredBoolean(
      rawReceipt.sourceExhausted,
      `${targetKey} receipt.sourceExhausted`
    ),
    truncated: requiredBoolean(rawReceipt.truncated, `${targetKey} receipt.truncated`),
    credentialRequired: requiredBoolean(
      rawReceipt.credentialRequired,
      `${targetKey} receipt.credentialRequired`
    ),
    blocker: optionalText(rawReceipt.blocker),
    blockers: normalizedTextArray(rawReceipt.blockers ?? [], `${targetKey} receipt.blockers`),
    nextAction: requiredText(rawReceipt.nextAction, `${targetKey} receipt.nextAction`),
    coverageExtent: requiredText(
      rawReceipt.coverageExtent,
      `${targetKey} receipt.coverageExtent`
    )
  };
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
  receipt.windowStart = optionalTimestamp(
    rawReceipt.windowStart,
    `${targetKey} receipt.windowStart`
  );
  receipt.windowEnd = optionalTimestamp(
    rawReceipt.windowEnd,
    `${targetKey} receipt.windowEnd`
  );
  if (expectedType === "page") {
    receipt.pageAccepted = nonNegativeInteger(
      rawReceipt.pageAccepted,
      `${targetKey} receipt.pageAccepted`
    );
    receipt.pageItemsSeen = nonNegativeInteger(
      rawReceipt.pageItemsSeen,
      `${targetKey} receipt.pageItemsSeen`
    );
    receipt.pageRejected = nonNegativeInteger(
      rawReceipt.pageRejected,
      `${targetKey} receipt.pageRejected`
    );
    receipt.pageDuplicates = nonNegativeInteger(
      rawReceipt.pageDuplicates,
      `${targetKey} receipt.pageDuplicates`
    );
    requiredText(rawReceipt.requestUrl, `${targetKey} receipt.requestUrl`);
  } else {
    receipt.outcome = requiredText(rawReceipt.outcome, `${targetKey} receipt.outcome`);
    if (!TARGET_OUTCOMES.has(receipt.outcome)) {
      throw new Error(`${targetKey} has unsupported historical outcome ${receipt.outcome}.`);
    }
    if (receipt.outcome === "collected" && receipt.accepted === 0) {
      throw new Error(`${targetKey} collected outcome requires accepted evidence.`);
    }
    if (receipt.outcome === "verified_no_history" && receipt.accepted !== 0) {
      throw new Error(`${targetKey} verified_no_history cannot contain accepted evidence.`);
    }
  }
  return receipt;
}

function assertReceiptIdentity(receipt, target) {
  const identity = target.identity;
  for (const [field, expected] of [
    ["batchSlug", identity.batchSlug],
    ["entityType", identity.entityType],
    ["entityId", identity.entityId],
    ["platform", identity.platform]
  ]) {
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
}

function consumeHistoricalEvidence(rawRow, context) {
  assertObject(rawRow, `${context.target.targetKey} historical evidence`);
  const target = context.target;
  for (const [field, expected] of [
    ["batchSlug", target.identity.batchSlug],
    ["entityType", target.identity.entityType],
    ["entityId", target.identity.entityId],
    ["platform", target.identity.platform]
  ]) {
    const actual = String(rawRow[field] ?? "").trim();
    const matches = field === "entityType" || field === "platform"
      ? actual.toLowerCase() === String(expected).trim().toLowerCase()
      : actual === String(expected).trim();
    if (!matches) {
      throw new Error(
        `${target.targetKey} evidence ${field} does not match its target attribution.`
      );
    }
  }
  const externalId = optionalText(rawRow.externalId);
  const publishedAt = optionalTimestamp(
    rawRow.publishedAt,
    `${target.targetKey} evidence.publishedAt`
  );
  const sourceUrl = normalizeHttpsUrl(rawRow.sourceUrl);
  const runnerCanonicalUrl = normalizePublicUrl(rawRow.canonicalUrl);
  const receiptCompatibleCanonicalUrl = normalizeHttpsUrl(rawRow.canonicalUrl);
  const nativeUrl = target.identity.platform === "hacker_news"
    ? sourceUrl
    : receiptCompatibleCanonicalUrl;
  let rejection = null;
  if (!externalId) {
    rejection = evidenceRejection(context, rawRow, "missing_native_id",
      "Historical evidence has no externalId that can be preserved as a native ID.");
  } else if (!publishedAt) {
    rejection = evidenceRejection(context, rawRow, "missing_published_at",
      "Historical evidence has no canonical native publication timestamp.");
  } else if (!nativeUrl) {
    rejection = evidenceRejection(context, rawRow, "missing_native_url",
      "Historical evidence has no credential-free HTTPS native URL.");
  } else if (target.identity.platform === "hacker_news" && !isNativeHackerNewsUrl(nativeUrl)) {
    rejection = evidenceRejection(context, rawRow, "invalid_hacker_news_native_url",
      "Hacker News evidence sourceUrl is not a native item URL.");
  } else if (target.identity.platform === "hacker_news" &&
      hackerNewsItemId(nativeUrl) !== externalId.replace(/^hn:/i, "")) {
    rejection = evidenceRejection(context, rawRow, "hacker_news_native_id_mismatch",
      "Hacker News externalId does not match the native item URL ID.");
  } else if (target.identity.platform !== "hacker_news" &&
      !urlMatchesOfficialDomain(nativeUrl, context.receipt.officialDomain)) {
    rejection = evidenceRejection(context, rawRow, "non_official_native_url",
      "Historical RSS/web evidence URL is outside the receipt's official domain.");
  }
  if (rejection) {
    target.rejectedEvidence.push(rejection);
    return;
  }

  const identityKey = `${target.identity.platform}\u0000${externalId}`;
  const output = {
    batchSlug: target.identity.batchSlug,
    entityType: target.identity.entityType,
    entityId: target.identity.entityId,
    platform: target.identity.platform,
    nativeId: externalId,
    canonicalUrl: nativeUrl,
    digest: physicalEvidenceDigest({
      platform: target.identity.platform,
      nativeId: externalId,
      canonicalUrl: nativeUrl,
      outboundUrl: target.identity.platform === "hacker_news" ? runnerCanonicalUrl : null,
      publishedAt,
      title: optionalText(rawRow.title),
      text: optionalText(rawRow.text),
      author: optionalText(rawRow.author),
      discoveryMethod: optionalText(rawRow.discoveryMethod)
    }),
    publishedAt,
    observedAt: context.recordedAt,
    sourceUrl: nativeUrl,
    historicalTargetKey: target.targetKey,
    historicalPageSequence: context.sequence,
    historicalOutboundUrl: target.identity.platform === "hacker_news" &&
      runnerCanonicalUrl && runnerCanonicalUrl !== nativeUrl
      ? runnerCanonicalUrl
      : null,
    title: optionalText(rawRow.title),
    text: optionalText(rawRow.text),
    author: optionalText(rawRow.author),
    discoveryMethod: optionalText(rawRow.discoveryMethod)
  };
  const prior = target.evidenceIdentities.get(identityKey);
  if (prior) {
    if (stableJson(prior.output) !== stableJson(output)) {
      throw new Error(`${target.targetKey} has conflicting duplicate evidence ${externalId}.`);
    }
    throw new Error(`${target.targetKey} repeats evidence ${externalId} across journal pages.`);
  }
  const row = {
    output,
    sequence: context.sequence,
    index: context.index,
    outboundUrl: output.historicalOutboundUrl
  };
  target.evidenceIdentities.set(identityKey, row);
  target.evidence.push(row);
}

function evidenceRejection(context, row, reasonCode, reason) {
  return {
    targetKey: context.target.targetKey,
    pageSequence: context.sequence,
    evidenceIndex: context.index,
    externalId: optionalText(row.externalId),
    sourceUrl: optionalText(row.sourceUrl),
    reasonCode,
    reason
  };
}

function finalizeJournalState(state, artifact) {
  if (!state.runInitialized) throw new Error("Historical journal is missing run_initialized.");
  if (artifact.observedAt < state.lastRecordedAt) {
    throw new Error("Historical artifact.observedAt predates the journal's last recordedAt.");
  }
  if (state.runCompleted && state.runCompleted.sequence !== state.lastSequence) {
    throw new Error("Historical run_completed must be the journal's final event.");
  }
}

function normalizeCompletionProofs(values, context) {
  if (!Array.isArray(values)) throw new TypeError("completionProofs must be an array.");
  if (values.length > context.state.limits.maxTargets) {
    throw new Error(`completionProofs exceeds maxTargets=${context.state.limits.maxTargets}.`);
  }
  const proofs = new Map();
  for (const rawProof of values) {
    assertObject(rawProof, "historical completion proof");
    assertKnownKeys(rawProof, new Set([
      "proofVersion",
      "targetKey",
      "status",
      "artifactSha256",
      "terminalSequence",
      "runCompletedSequence",
      "checkedAt",
      "coveredThrough",
      "receiptId",
      "technicalLimit",
      "reason"
    ]), "historical completion proof");
    if (rawProof.proofVersion !== HISTORICAL_COMPLETION_PROOF_VERSION) {
      throw new Error("Historical completion proofVersion is incompatible.");
    }
    if (rawProof.status !== "complete") {
      throw new Error("Historical completion proof status must be complete.");
    }
    const targetKey = requiredText(rawProof.targetKey, "completionProof.targetKey");
    if (proofs.has(targetKey)) throw new Error(`Duplicate completion proof for ${targetKey}.`);
    const target = context.state.targetStates.get(targetKey);
    if (!target) throw new Error(`Completion proof references unknown target ${targetKey}.`);
    if (!target.terminal) throw new Error(`Completion proof target ${targetKey} has no terminal receipt.`);
    if (!context.state.runCompleted || context.state.runCompleted.status !== "completed") {
      throw new Error("Completion proof requires a reconciled completed historical run.");
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
    assertEligibleForCompletion(target);
    const receiptId = deterministicCompletionReceiptId({
      artifactSha256: context.artifact.sha256,
      targetKey,
      terminalSequence: target.terminal.sequence,
      runCompletedSequence: context.state.runCompleted.sequence,
      coveredThrough
    });
    if (rawProof.receiptId !== undefined && rawProof.receiptId !== receiptId) {
      throw new Error(`${targetKey} completion proof receiptId is not deterministic.`);
    }
    proofs.set(targetKey, {
      receiptId,
      status: "complete",
      checkedAt,
      coveredThrough,
      technicalLimit: requiredOperationalText(
        rawProof.technicalLimit,
        `${targetKey} proof.technicalLimit`
      ),
      reason: requiredOperationalText(rawProof.reason, `${targetKey} proof.reason`)
    });
  }
  return proofs;
}

function assertEligibleForCompletion(target) {
  const receipt = target.terminal.receipt;
  const blockers = [...new Set([receipt.blocker, ...receipt.blockers].filter(Boolean))];
  const onlyNoHistoryMarkers = receipt.outcome === "verified_no_history" &&
    blockers.every((blocker) => VERIFIED_NO_HISTORY_MARKERS.has(blocker));
  if (!new Set(["collected", "verified_no_history"]).has(receipt.outcome)) {
    throw new Error(`${target.targetKey} blocked/manual target cannot be historical-complete.`);
  }
  if (!receipt.sourceExhausted || receipt.truncated || receipt.credentialRequired ||
      (!onlyNoHistoryMarkers && blockers.length > 0) || receipt.nextCursor !== null ||
      !EXHAUSTIVE_COVERAGE_EXTENTS.has(receipt.coverageExtent)) {
    throw new Error(
      `${target.targetKey} terminal receipt is not eligible for historical completion proof.`
    );
  }
  if (target.rejectedEvidence.length > 0) {
    throw new Error(`${target.targetKey} has rejected evidence and cannot be historical-complete.`);
  }
  if (receipt.outcome === "collected" && target.evidence.length !== receipt.accepted) {
    throw new Error(`${target.targetKey} collected evidence does not reconcile for completion.`);
  }
}

function normalizeTargets(state, { artifact, proofIndex, recencyCutoffAt }) {
  const taskPlan = [];
  const attempts = [];
  const evidence = [];
  const pairScopes = [];
  const targetCoverage = [];
  const rejectedEvidence = [];
  const outboundLinks = [];

  for (const targetKey of state.expectedTargetKeys) {
    const target = state.targetStates.get(targetKey);
    const task = taskForTarget(target);
    taskPlan.push(task);
    const proof = proofIndex.get(targetKey) ?? null;
    if (proof) {
      pairScopes.push({
        ...structuredClone(target.identity),
        scope: {
          historicalBackfillReceipt: structuredClone(proof)
        }
      });
    }
    for (const row of target.evidence) {
      evidence.push(structuredClone(row.output));
      if (row.outboundUrl) {
        outboundLinks.push({
          targetKey,
          platform: target.identity.platform,
          nativeId: row.output.nativeId,
          nativeUrl: row.output.canonicalUrl,
          outboundUrl: row.outboundUrl,
          publishedAt: row.output.publishedAt,
          observedAt: row.output.observedAt,
          pageSequence: row.sequence
        });
      }
    }
    rejectedEvidence.push(...target.rejectedEvidence.map((row) => structuredClone(row)));
    const attempt = attemptForTarget(target, task, artifact);
    if (attempt) attempts.push(attempt);
    targetCoverage.push(targetCoverageRow(target, proof));
  }

  attempts.sort((left, right) => left.attemptKey.localeCompare(right.attemptKey));
  evidence.sort(compareEvidence);
  pairScopes.sort(compareIdentityRows);
  targetCoverage.sort((left, right) => left.targetKey.localeCompare(right.targetKey));
  rejectedEvidence.sort(compareRejectedEvidence);
  outboundLinks.sort(compareOutboundLinks);
  taskPlan.sort((left, right) => left.checkpointKey.localeCompare(right.checkpointKey));

  // A cutoff is a coverage claim, so incomplete targets do not receive one.
  for (const row of targetCoverage) {
    row.recencyCutoffAt = row.scopeStatus === "complete" ? recencyCutoffAt : null;
  }
  return {
    taskPlan,
    attempts,
    evidence,
    pairScopes,
    targetCoverage,
    rejectedEvidence,
    outboundLinks
  };
}

function taskForTarget(target) {
  return {
    ...structuredClone(target.identity),
    entitySourceKey: target.identity.entityId,
    ...(target.identity.entityType === "company"
      ? { companySourceKey: target.identity.entityId }
      : {}),
    account: null,
    checkpointKey: `historical:${target.targetKey}`,
    status: "queued",
    terminalReason: null
  };
}

function attemptForTarget(target, task, artifact) {
  const terminal = target.terminal;
  const lastPage = target.pages.at(-1) ?? null;
  if (!terminal && !lastPage) return null;
  const startedAt = target.pages[0]?.recordedAt ?? terminal?.recordedAt ?? lastPage.recordedAt;
  const checkedAt = terminal?.recordedAt ?? lastPage.recordedAt;
  const translation = translateTargetOutcome(target);
  return {
    attemptKey: target.targetKey,
    ...structuredClone(target.identity),
    accountUrl: null,
    status: "done",
    outcomeStatus: translation.status,
    outcomeReason: translation.reason,
    error: translation.error,
    startedAt,
    checkedAt,
    retryable: translation.retryable,
    historicalArtifactSha256: artifact.sha256,
    historicalTerminalSequence: terminal?.sequence ?? null
  };
}

function translateTargetOutcome(target) {
  if (!target.terminal) {
    const reason =
      `Manual review required: ${target.targetKey} has page checkpoints but no target_completed receipt.`;
    return { status: "needs_review", reason, error: reason, retryable: true };
  }
  const receipt = target.terminal.receipt;
  if (receipt.outcome === "collected") {
    if (target.rejectedEvidence.length > 0 || target.evidence.length === 0) {
      const reason =
        `Manual review required: ${target.targetKey} collected ${receipt.accepted} rows, ` +
        `but ${target.rejectedEvidence.length} could not satisfy native ID, URL, or timestamp integrity.`;
      return { status: "needs_review", reason, error: reason, retryable: false };
    }
    return {
      status: "completed",
      reason:
        `Historical target ${target.targetKey} collected ${target.evidence.length} timestamped native rows; ` +
        `exact coverage extent ${receipt.coverageExtent}.`,
      error: null,
      retryable: false
    };
  }
  if (receipt.outcome === "verified_no_history") {
    const reason =
      `Manual review required: exact historical outcome verified_no_history for ${target.targetKey}; ` +
      "this does not prove that no native account exists.";
    return { status: "needs_review", reason, error: reason, retryable: false };
  }
  if (receipt.outcome === "manual_review") {
    const reason = receipt.credentialRequired
      ? `Required production credential is missing for ${target.targetKey}; exact blockers are preserved in bridge targetCoverage.`
      : `Manual review required for ${target.targetKey}; exact blockers are preserved in bridge targetCoverage.`;
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
      `Manual review required for ${targetKey}; multiple or unmapped exact blocker classes are preserved in bridge targetCoverage.`;
    return { status: "needs_review", reason, error: reason, retryable: false };
  }
  const blockerClass = [...blockerClasses][0];
  const prefix = {
    captcha_required: "CAPTCHA required by the historical source",
    rate_limited: "Rate limit blocked the historical source",
    access_denied: "Access denied by the historical source",
    network_error: "Network error blocked the historical source"
  }[blockerClass];
  const reason = `${prefix} for ${targetKey}; exact historical blocker ${exact}.`;
  return { status: "failed", reason, error: reason, retryable: false };
}

function classifyBlockerClasses(value) {
  const classes = new Set();
  if (/captcha/i.test(value)) classes.add("captcha_required");
  if (/(?:rate.?limit|\b429\b)/i.test(value)) classes.add("rate_limited");
  if (/(?:http_403|robots|access.?denied|forbidden)/i.test(value)) {
    classes.add("access_denied");
  }
  if (/(?:network|timeout|socket|econn|request_error|http_5\d\d)/i.test(value)) {
    classes.add("network_error");
  }
  return classes;
}

function exactBlockers(receipt) {
  const values = [...new Set([
    receipt.blocker,
    ...receipt.blockers
  ].filter(Boolean))];
  return values.length > 0 ? values.join(" | ") : "none_recorded";
}

function targetCoverageRow(target, proof) {
  const terminal = target.terminal;
  const receipt = terminal?.receipt ?? null;
  const checkedAt = terminal?.recordedAt ?? target.pages.at(-1)?.recordedAt ?? null;
  const scopeStatus = proof
    ? "complete"
    : !terminal
      ? "incomplete"
      : receipt.outcome === "access_blocked"
        ? "failed"
        : receipt.outcome === "manual_review"
          ? "manual_review"
          : "partial";
  return {
    targetKey: target.targetKey,
    ...structuredClone(target.identity),
    outcome: receipt?.outcome ?? "not_completed",
    scopeStatus,
    checkedAt,
    sourceExhausted: receipt?.sourceExhausted ?? false,
    truncated: receipt?.truncated ?? false,
    credentialRequired: receipt?.credentialRequired ?? false,
    blocker: receipt?.blocker ?? (terminal ? null : "target_terminal_receipt_missing"),
    blockers: receipt?.blockers ?? (terminal ? [] : ["target_terminal_receipt_missing"]),
    coverageExtent: receipt?.coverageExtent ?? "incomplete_journal_target",
    pagesAttempted: receipt?.pagesAttempted ?? target.pages.at(-1)?.receipt.pagesAttempted ?? 0,
    pagesFetched: receipt?.pagesFetched ?? target.pages.at(-1)?.receipt.pagesFetched ?? 0,
    accepted: receipt?.accepted ?? target.pages.at(-1)?.receipt.accepted ?? 0,
    emittedEvidence: target.evidence.length,
    rejectedEvidence: target.rejectedEvidence.length,
    completionReceiptId: proof?.receiptId ?? null,
    nextAction: proof
      ? "Retain the proof-bound historical receipt and continue scheduled incremental ingestion."
      : receipt?.nextAction ?? "Resume the exact historical journal until target_completed is recorded."
  };
}

function identityFromTargetKey(targetKey) {
  const parts = requiredText(targetKey, "historical targetKey").split(":");
  if (parts.length < 3) throw new Error(`Historical targetKey ${targetKey} is malformed.`);
  const batchSlug = parts.shift();
  const platform = normalizePlatform(parts.pop());
  const entityId = parts.join(":");
  if (!entityId) throw new Error(`Historical targetKey ${targetKey} has no entity ID.`);
  return { batchSlug, entityType: "company", entityId, platform };
}

function normalizePlatform(value) {
  const platform = requiredText(value, "historical platform").toLowerCase();
  if (!HISTORICAL_BACKFILL_PLATFORMS.includes(platform)) {
    throw new Error(`Unsupported historical platform ${platform}.`);
  }
  return platform;
}

function normalizeArtifact(value, generatedAt) {
  assertObject(value, "historical artifact");
  assertKnownKeys(value, new Set(["path", "sha256", "observedAt"]), "historical artifact");
  const observedAt = canonicalTimestamp(value.observedAt, "historical artifact.observedAt");
  if (observedAt > generatedAt) {
    throw new Error("historical artifact.observedAt cannot exceed generatedAt.");
  }
  return {
    path: requiredText(value.path, "historical artifact.path"),
    sha256: requiredSha256(value.sha256, "historical artifact.sha256"),
    observedAt
  };
}

function normalizeLimits(overrides) {
  assertObject(overrides ?? {}, "historical coverage adapter limits");
  const limits = { ...HISTORICAL_COVERAGE_ADAPTER_LIMITS };
  for (const [key, hardMaximum] of Object.entries(HISTORICAL_COVERAGE_ADAPTER_LIMITS)) {
    if (overrides[key] === undefined) continue;
    const value = positiveInteger(overrides[key], `limits.${key}`);
    if (value > hardMaximum) {
      throw new Error(`limits.${key} cannot exceed the hard maximum ${hardMaximum}.`);
    }
    limits[key] = value;
  }
  for (const key of Object.keys(overrides ?? {})) {
    if (!(key in limits)) throw new Error(`Unknown historical coverage adapter limit ${key}.`);
  }
  return limits;
}

function isNativeHackerNewsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "news.ycombinator.com" &&
      url.pathname === "/item" && Boolean(url.searchParams.get("id"));
  } catch {
    return false;
  }
}

function hackerNewsItemId(value) {
  try {
    return new URL(value).searchParams.get("id");
  } catch {
    return null;
  }
}

function urlMatchesOfficialDomain(value, rawOfficialDomain) {
  const officialDomain = String(rawOfficialDomain ?? "").trim().toLowerCase()
    .replace(/^www\./, "");
  if (!officialDomain) return false;
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return host === officialDomain || host.endsWith(`.${officialDomain}`);
  } catch {
    return false;
  }
}

function physicalEvidenceDigest(value) {
  return sha256(stableJson({
    version: HISTORICAL_COVERAGE_ADAPTER_VERSION,
    platform: value.platform,
    nativeId: value.nativeId,
    canonicalUrl: value.canonicalUrl,
    outboundUrl: value.outboundUrl,
    publishedAt: value.publishedAt,
    title: value.title,
    text: value.text,
    author: value.author,
    discoveryMethod: value.discoveryMethod
  }));
}

function deterministicCompletionReceiptId(value) {
  return `historical-${sha256(stableJson({
    version: HISTORICAL_COMPLETION_PROOF_VERSION,
    ...value
  })).slice(0, 40)}`;
}

function normalizeHttpsUrl(value) {
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

function normalizePublicUrl(value) {
  const text = optionalText(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    if ((url.protocol === "https:" && url.port && url.port !== "443") ||
        (url.protocol === "http:" && url.port && url.port !== "80")) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function compareEvidence(left, right) {
  return compareIdentityRows(left, right) ||
    left.nativeId.localeCompare(right.nativeId) ||
    left.canonicalUrl.localeCompare(right.canonicalUrl) ||
    left.publishedAt.localeCompare(right.publishedAt);
}

function compareIdentityRows(left, right) {
  return left.batchSlug.localeCompare(right.batchSlug) ||
    left.entityType.localeCompare(right.entityType) ||
    left.entityId.localeCompare(right.entityId) ||
    left.platform.localeCompare(right.platform);
}

function compareRejectedEvidence(left, right) {
  return left.targetKey.localeCompare(right.targetKey) ||
    left.pageSequence - right.pageSequence ||
    left.evidenceIndex - right.evidenceIndex;
}

function compareOutboundLinks(left, right) {
  return left.targetKey.localeCompare(right.targetKey) ||
    left.nativeId.localeCompare(right.nativeId) ||
    left.outboundUrl.localeCompare(right.outboundUrl);
}

function sortedUniqueText(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError(`${label} must be a non-empty array.`);
  }
  const normalized = values.map((value, index) => requiredText(value, `${label}[${index}]`));
  const unique = [...new Set(normalized)].sort();
  if (unique.length !== normalized.length) throw new Error(`${label} contains duplicates.`);
  return unique;
}

function normalizedTextArray(values, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array.`);
  return [...new Set(values.map((value, index) => requiredText(value, `${label}[${index}]`)))];
}

function requiredOperationalText(value, label, minimumLength = 16) {
  const text = requiredText(value, label);
  if (text.length < minimumLength) {
    throw new Error(`${label} must contain exact operational detail.`);
  }
  return text;
}

function canonicalTimestamp(value, label) {
  const raw = requiredText(value, label);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be an ISO timestamp.`);
  const canonical = new Date(parsed).toISOString();
  if (canonical !== raw) throw new Error(`${label} must be a canonical ISO timestamp.`);
  return canonical;
}

function optionalTimestamp(value, label) {
  if (value === null || value === undefined || value === "") return null;
  return canonicalTimestamp(value, label);
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return number;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
  return number;
}

function requiredBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean.`);
  return value;
}

function requiredSha256(value, label) {
  const digest = requiredText(value, label);
  if (!SHA256.test(digest)) throw new TypeError(`${label} must be a lowercase SHA-256.`);
  return digest;
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}

function optionalText(value) {
  const text = String(value ?? "").trim();
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
