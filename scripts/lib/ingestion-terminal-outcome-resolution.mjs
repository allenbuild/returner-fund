import { createHash } from "node:crypto";

export const INGESTION_TERMINAL_OUTCOME_RESOLUTION_VERSION =
  "ingestion-terminal-outcome-resolution.v1";

export const TERMINAL_OUTCOME_PRECEDENCE = Object.freeze([
  "collected",
  "verified_no_account",
  "access_blocked",
  "requires_credentials",
  "manual_review"
]);

const BLOCKER_CODES = new Set([
  "access_denied",
  "network_error",
  "captcha_required",
  "rate_limited",
  "multiple_access_blocks"
]);
const PREVIEW_LIMIT = 250;

/**
 * Resolve one core entity-platform pair to exactly one honest terminal category.
 * Raw task outcomes are never rewritten. Lower-precedence signals remain bound
 * into the discarded-signal digest and bounded audit preview.
 */
export function resolveTerminalOutcomePair(pair) {
  assertObject(pair, "pair");
  const pairKey = requiredText(pair.pairKey, "pair.pairKey");
  const identity = {
    pairKey,
    batchSlug: requiredText(pair.batchSlug, `${pairKey}.batchSlug`),
    entityType: requiredText(pair.entity?.type, `${pairKey}.entity.type`),
    entityId: requiredText(pair.entity?.id, `${pairKey}.entity.id`),
    platform: requiredText(pair.platform, `${pairKey}.platform`)
  };
  const signals = collectSignals(pair);
  const categories = new Map();
  for (const signal of signals) {
    const category = signalCategory(signal, pair);
    if (!categories.has(category)) categories.set(category, []);
    categories.get(category).push(signal);
  }
  for (const values of categories.values()) values.sort(compareSignals);

  const selectedCategory = selectCategory(categories, pair);
  const selectedSignals = selectedCategory === "access_blocked"
    ? categories.get(selectedCategory) ?? []
    : selectedCategory === "manual_review"
      ? manualReviewSignals(categories)
      : categories.get(selectedCategory) ?? [];
  const selectedRefs = new Set(selectedSignals.map(signalIdentity));
  const discardedSignals = signals
    .filter((signal) => !selectedRefs.has(signalIdentity(signal)))
    .sort(compareSignals)
    .map(compactSignal);
  const selected = selectedSignals.map(compactSignal);
  const terminal = canonicalTerminal({
    pair,
    pairKey,
    selectedCategory,
    selectedSignals
  });
  const rawCategories = Object.fromEntries(
    [...categories.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => [key, values.length])
  );
  const rawContradictory = Object.keys(rawCategories).length > 1;

  return {
    ...identity,
    outcome: terminal.outcome,
    queueSubdisposition: terminal.queueSubdisposition,
    terminalStatus: terminal.status,
    reasonCode: terminal.reasonCode,
    reason: terminal.reason,
    nextAction: terminal.nextAction,
    absenceVerification: terminal.absenceVerification,
    compliant: true,
    structurallyUndocumented: false,
    contradictory: false,
    issues: [],
    accountOutcomeCategories: rawCategories,
    unsupportedAccountOutcomes: [],
    materializerUnresolved: isMaterializerUnresolvedPair(pair),
    resolutionProvenance: {
      policyVersion: INGESTION_TERMINAL_OUTCOME_RESOLUTION_VERSION,
      precedence: TERMINAL_OUTCOME_PRECEDENCE,
      selectedCategory,
      selectedSignals: selected,
      discardedSignals,
      rawContradictory,
      sourceRecordsPath: `coverageReceipt.pairs[${JSON.stringify(pairKey)}]`
    }
  };
}

export function createTerminalOutcomeResolutionAccumulator({
  previewLimit = PREVIEW_LIMIT
} = {}) {
  if (!Number.isSafeInteger(previewLimit) || previewLimit < 0) {
    throw new TypeError("previewLimit must be a non-negative safe integer.");
  }
  return {
    corePairs: 0,
    previousPairKey: null,
    outcomeCounts: new Map(),
    queueSubdispositions: { requires_credentials: 0, manual_review: 0 },
    rawContradictoryPairs: 0,
    discardedSignalPairs: 0,
    discardedSignals: 0,
    discardedByReasonCode: new Map(),
    selectedSignals: 0,
    resolutionHash: createHash("sha256"),
    discardedHash: createHash("sha256"),
    selectedHash: createHash("sha256"),
    previewLimit,
    discardedPreview: []
  };
}

export function accumulateTerminalOutcomeResolution(accumulator, pair) {
  if (pair.matrixScope !== "core") return null;
  const resolution = resolveTerminalOutcomePair(pair);
  if (accumulator.previousPairKey !== null &&
      accumulator.previousPairKey.localeCompare(resolution.pairKey) >= 0) {
    throw new Error(
      `Core pair order must be unique and ascending: ${accumulator.previousPairKey}, ` +
      `${resolution.pairKey}.`
    );
  }
  accumulator.previousPairKey = resolution.pairKey;
  accumulator.corePairs += 1;
  accumulator.outcomeCounts.set(
    resolution.outcome,
    (accumulator.outcomeCounts.get(resolution.outcome) ?? 0) + 1
  );
  if (resolution.queueSubdisposition) {
    accumulator.queueSubdispositions[resolution.queueSubdisposition] += 1;
  }
  if (resolution.resolutionProvenance.rawContradictory) {
    accumulator.rawContradictoryPairs += 1;
  }
  const discarded = resolution.resolutionProvenance.discardedSignals;
  if (discarded.length) accumulator.discardedSignalPairs += 1;
  for (const [index, signal] of discarded.entries()) {
    const row = { pairKey: resolution.pairKey, index, ...signal };
    accumulator.discardedSignals += 1;
    accumulator.discardedByReasonCode.set(
      signal.reasonCode ?? "missing",
      (accumulator.discardedByReasonCode.get(signal.reasonCode ?? "missing") ?? 0) + 1
    );
    accumulator.discardedHash.update(`${stableJson(row)}\n`);
    if (accumulator.discardedPreview.length < accumulator.previewLimit) {
      accumulator.discardedPreview.push(row);
    }
  }
  for (const [index, signal] of resolution.resolutionProvenance.selectedSignals.entries()) {
    accumulator.selectedSignals += 1;
    accumulator.selectedHash.update(stableJson({
      pairKey: resolution.pairKey,
      index,
      ...signal
    }) + "\n");
  }
  accumulator.resolutionHash.update(
    `${stableJson(canonicalResolutionDigestRecord(resolution))}\n`
  );
  return resolution;
}

export function finalizeTerminalOutcomeResolutionAccumulator(
  accumulator,
  { expectedCorePairs }
) {
  if (!Number.isSafeInteger(expectedCorePairs) || expectedCorePairs < 0) {
    throw new TypeError("expectedCorePairs must be a non-negative safe integer.");
  }
  if (accumulator.corePairs !== expectedCorePairs) {
    throw new Error(
      `Terminal resolution covered ${accumulator.corePairs}/${expectedCorePairs} core pairs.`
    );
  }
  const outcomeCounts = Object.fromEntries([
    "collected",
    "verified_no_account",
    "access_blocked",
    "requires_credentials_or_manual_review"
  ].map((outcome) => [outcome, accumulator.outcomeCounts.get(outcome) ?? 0]));
  const resolved = Object.values(outcomeCounts).reduce((sum, value) => sum + value, 0);
  if (resolved !== expectedCorePairs) {
    throw new Error(`Terminal outcome counts reconcile to ${resolved}/${expectedCorePairs}.`);
  }
  return {
    schemaVersion: INGESTION_TERMINAL_OUTCOME_RESOLUTION_VERSION,
    complete: true,
    corePairs: expectedCorePairs,
    resolvedPairs: resolved,
    outcomeCounts,
    queueSubdispositions: { ...accumulator.queueSubdispositions },
    policy: {
      precedence: TERMINAL_OUTCOME_PRECEDENCE,
      verifiedNoAccountRequiresExhaustiveProof: true,
      unsupportedOrUnattemptedBecomesManualReview: true,
      rawSignalsRewritten: false
    },
    auditProvenance: {
      rawContradictoryPairs: accumulator.rawContradictoryPairs,
      selectedSignals: accumulator.selectedSignals,
      selectedSignalsSha256: accumulator.selectedHash.digest("hex"),
      discardedSignalPairs: accumulator.discardedSignalPairs,
      discardedSignals: accumulator.discardedSignals,
      discardedSignalsByReasonCode: Object.fromEntries(
        [...accumulator.discardedByReasonCode].sort(([left], [right]) =>
          left.localeCompare(right)
        )
      ),
      discardedSignalsSha256: accumulator.discardedHash.digest("hex"),
      discardedSignalPreviewLimit: accumulator.previewLimit,
      discardedSignalPreviewTruncated:
        accumulator.discardedSignals > accumulator.discardedPreview.length,
      discardedSignalPreview: accumulator.discardedPreview,
      sourceRecordsPath: "coverageReceipt.pairs[].terminal + accountOutcomes[]",
      serialization: "stable-json-lines.v1"
    },
    pairResolutionSha256: accumulator.resolutionHash.digest("hex"),
    pairResolutionSerialization: "stable-json-lines.v1"
  };
}

export function buildTerminalOutcomeResolutionSummary(receipt, options = {}) {
  assertObject(receipt, "receipt");
  if (!Array.isArray(receipt.pairs)) throw new TypeError("receipt.pairs must be an array.");
  const accumulator = createTerminalOutcomeResolutionAccumulator(options);
  for (const pair of receipt.pairs) accumulateTerminalOutcomeResolution(accumulator, pair);
  return finalizeTerminalOutcomeResolutionAccumulator(accumulator, {
    expectedCorePairs: receipt.inventory?.corePairCount
  });
}

export function canonicalResolutionDigestRecord(resolution) {
  return {
    pairKey: resolution.pairKey,
    batchSlug: resolution.batchSlug,
    entityType: resolution.entityType,
    entityId: resolution.entityId,
    platform: resolution.platform,
    outcome: resolution.outcome,
    queueSubdisposition: resolution.queueSubdisposition,
    terminalStatus: resolution.terminalStatus,
    reasonCode: resolution.reasonCode,
    reason: resolution.reason,
    nextAction: resolution.nextAction,
    absenceVerification: resolution.absenceVerification,
    selectedCategory: resolution.resolutionProvenance.selectedCategory,
    selectedSignals: resolution.resolutionProvenance.selectedSignals,
    discardedSignals: resolution.resolutionProvenance.discardedSignals,
    rawContradictory: resolution.resolutionProvenance.rawContradictory,
    materializerUnresolved: resolution.materializerUnresolved
  };
}

function selectCategory(categories, pair) {
  if ((categories.get("collected")?.length ?? 0) > 0) return "collected";
  if (verifiedAbsenceIsConsistent(categories, pair)) return "verified_no_account";
  if ((categories.get("access_blocked")?.length ?? 0) > 0) return "access_blocked";
  if ((categories.get("requires_credentials")?.length ?? 0) > 0) {
    return "requires_credentials";
  }
  return "manual_review";
}

function verifiedAbsenceIsConsistent(categories, pair) {
  if ((categories.get("verified_no_account")?.length ?? 0) === 0) return false;
  return Number(pair.mapping?.accountCount ?? 0) === 0 &&
    Number(pair.evidence?.postCount ?? 0) === 0;
}

function manualReviewSignals(categories) {
  const result = [];
  for (const category of ["manual_review", "unsupported"]) {
    result.push(...(categories.get(category) ?? []));
  }
  return result.sort(compareSignals);
}

function canonicalTerminal({ pair, pairKey, selectedCategory, selectedSignals }) {
  if (selectedCategory === "collected") {
    const signal = selectedSignals[0];
    return terminalRecord({
      outcome: "collected",
      status: "collected",
      reasonCode: "native_evidence_collected",
      reason: signal?.reason ||
        `${pairKey} has ${Number(pair.evidence?.postCount ?? 0)} attributed native evidence row(s).`,
      nextAction: signal?.nextAction ||
        `Retain the verified native evidence and continue scheduled ingestion for ${pairKey}.`
    });
  }
  if (selectedCategory === "verified_no_account") {
    const signal = selectedSignals[0];
    if (!signal?.absenceVerification) {
      throw new Error(`${pairKey} cannot be verified_no_account without exhaustive proof.`);
    }
    return terminalRecord({
      outcome: "verified_no_account",
      status: "verified_no_account",
      reasonCode: "exhaustive_absence_verified",
      reason: signal.reason,
      nextAction: signal.nextAction,
      absenceVerification: signal.absenceVerification
    });
  }
  if (selectedCategory === "access_blocked") {
    const codes = [...new Set(selectedSignals.map((signal) => signal.reasonCode))].sort();
    const reasonCode = codes.length === 1 ? codes[0] : "multiple_access_blocks";
    const providers = selectedSignals.map((signal) =>
      `${signal.reasonCode}@${signal.taskKey || signal.source}`
    );
    const reasons = uniqueText(selectedSignals.map((signal) => signal.reason));
    const actions = uniqueText(selectedSignals.map((signal) => signal.nextAction));
    return terminalRecord({
      outcome: "access_blocked",
      status: "blocked",
      reasonCode,
      reason: `${reasons.join(" | ")} Exact blocker provider/code: ${providers.join(", ")}.`,
      nextAction: actions.join(" | ")
    });
  }
  if (selectedCategory === "requires_credentials") {
    const signal = selectedSignals[0];
    return terminalRecord({
      outcome: "requires_credentials_or_manual_review",
      queueSubdisposition: "requires_credentials",
      status: "queued",
      reasonCode: "missing_credentials",
      reason: signal.reason,
      nextAction: signal.nextAction
    });
  }
  const rawCodes = [...new Set(collectSignals(pair).map((signal) =>
    signal.reasonCode || `${signal.status || "missing"}_without_reason_code`
  ))].sort();
  const existingManual = selectedSignals.find((signal) =>
    signal.status === "queued" && signal.reasonCode === "manual_review_required"
  );
  return terminalRecord({
    outcome: "requires_credentials_or_manual_review",
    queueSubdisposition: "manual_review",
    status: "queued",
    reasonCode: "manual_review_required",
    reason: existingManual?.reason ||
      `${pairKey} requires manual review; current source signals are ` +
      `${rawCodes.join(", ") || "no native attempt"}. No exhaustive native-account ` +
      "absence proof exists, so verified_no_account is not allowed.",
    nextAction: existingManual?.nextAction ||
      `Review canonical account mapping for ${pairKey}, run the ${pair.platform} native ` +
      "collector, and record collected evidence, exhaustive absence proof, an exact access " +
      "blocker, or a credential requirement."
  });
}

function terminalRecord({
  outcome,
  queueSubdisposition = null,
  status,
  reasonCode,
  reason,
  nextAction,
  absenceVerification = null
}) {
  return {
    outcome,
    queueSubdisposition,
    status,
    reasonCode,
    reason: requiredOperationalText(reason, "canonical reason"),
    nextAction: requiredOperationalText(nextAction, "canonical next action"),
    absenceVerification
  };
}

function collectSignals(pair) {
  const terminal = isObject(pair.terminal) ? pair.terminal : {};
  const signals = [normalizeSignal(terminal, {
    source: "pair_terminal",
    taskKey: null,
    attemptId: null
  })];
  for (const outcome of Array.isArray(pair.accountOutcomes) ? pair.accountOutcomes : []) {
    signals.push(normalizeSignal(outcome, {
      source: "account_outcome",
      taskKey: clean(outcome?.taskKey),
      attemptId: clean(outcome?.attempt?.attemptId)
    }));
  }
  return signals;
}

function normalizeSignal(value, identity) {
  return {
    ...identity,
    status: clean(value?.status),
    reasonCode: clean(value?.reasonCode),
    reason: clean(value?.reason),
    nextAction: clean(value?.nextAction),
    absenceVerification: isObject(value?.absenceVerification)
      ? value.absenceVerification
      : null,
    evidenceRefs: Array.isArray(value?.evidenceRefs) ? value.evidenceRefs.length : 0,
    rawCollectorStatus: clean(value?.rawCollectorStatus),
    rawCollectorReasonCode: clean(value?.rawCollectorReasonCode)
  };
}

function signalCategory(signal, pair) {
  if (signal.status === "collected" &&
      signal.reasonCode === "native_evidence_collected" &&
      (Number(pair.evidence?.postCount ?? 0) > 0 || signal.evidenceRefs > 0)) {
    return "collected";
  }
  if (signal.status === "verified_no_account" &&
      signal.reasonCode === "exhaustive_absence_verified" &&
      hasExhaustiveAbsenceVerification(signal.absenceVerification)) {
    return "verified_no_account";
  }
  if (signal.status === "blocked" && BLOCKER_CODES.has(signal.reasonCode)) {
    return "access_blocked";
  }
  if (signal.status === "queued" && signal.reasonCode === "missing_credentials") {
    return "requires_credentials";
  }
  if (signal.status === "queued" && signal.reasonCode === "manual_review_required") {
    return "manual_review";
  }
  // An inconsistent verified-absence claim must never silently become absence.
  if (signal.status === "verified_no_account" &&
      (Number(pair.mapping?.accountCount ?? 0) > 0 || Number(pair.evidence?.postCount ?? 0) > 0)) {
    return "unsupported";
  }
  return "unsupported";
}

function compactSignal(signal) {
  return {
    source: signal.source,
    taskKey: signal.taskKey,
    attemptId: signal.attemptId,
    status: signal.status,
    reasonCode: signal.reasonCode,
    reason: signal.reason,
    nextAction: signal.nextAction,
    absenceVerificationSha256: signal.absenceVerification
      ? sha256Stable(signal.absenceVerification)
      : null,
    evidenceRefs: signal.evidenceRefs,
    rawCollectorStatus: signal.rawCollectorStatus,
    rawCollectorReasonCode: signal.rawCollectorReasonCode
  };
}

function compareSignals(left, right) {
  const source = (left.source === "pair_terminal" ? 0 : 1) -
    (right.source === "pair_terminal" ? 0 : 1);
  if (source !== 0) return source;
  return signalIdentity(left).localeCompare(signalIdentity(right));
}

function signalIdentity(signal) {
  return [
    signal.source,
    signal.taskKey ?? "",
    signal.attemptId ?? "",
    signal.status ?? "",
    signal.reasonCode ?? ""
  ].join("\u0000");
}

function isMaterializerUnresolvedPair(pair) {
  if (pair.scope?.objectiveComplete === true) return false;
  const terminal = pair.terminal ?? {};
  if (!["blocked", "queued"].includes(terminal.status)) return true;
  if (terminal.status === "queued" && [
    "no_current_attempt",
    "missing_native_evidence",
    "ambiguous_legacy_outcome",
    "missing_exact_reason"
  ].includes(terminal.reasonCode)) return true;
  return !clean(terminal.reason) || !clean(terminal.nextAction);
}

function uniqueText(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function requiredOperationalText(value, label) {
  const text = requiredText(value, label);
  if (text.length < 8) throw new Error(`${label} must be operationally specific.`);
  return text;
}

function hasExhaustiveAbsenceVerification(value) {
  return isObject(value) &&
    value.exhaustive === true &&
    Boolean(clean(value.receiptId)) &&
    !Number.isNaN(Date.parse(clean(value.checkedAt))) &&
    Array.isArray(value.checkedSources) &&
    value.checkedSources.some((source) => Boolean(clean(source))) &&
    clean(value.method).length >= 8;
}

function requiredText(value, label) {
  const text = clean(value);
  if (!text) throw new TypeError(`${label} must be a non-empty string.`);
  return text;
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value, label) {
  if (!isObject(value)) throw new TypeError(`${label} must be an object.`);
}

function sha256Stable(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}
