import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";

import {
  INGESTION_CORE_PLATFORMS
} from "./ingestion-coverage-receipt.mjs";
import {
  buildIngestionCoverageReport
} from "./ingestion-coverage-report.mjs";
import {
  accumulateTerminalOutcomeResolution,
  createTerminalOutcomeResolutionAccumulator,
  finalizeTerminalOutcomeResolutionAccumulator
} from "./ingestion-terminal-outcome-resolution.mjs";

export const INGESTION_TERMINAL_OUTCOME_AUDIT_VERSION =
  "ingestion-terminal-outcome-audit.v1";

export const REQUIRED_TERMINAL_OUTCOMES = Object.freeze([
  "collected",
  "verified_no_account",
  "access_blocked",
  "requires_credentials_or_manual_review"
]);

const MATERIALIZATION_VERSION = "ingestion-coverage-materialization.v1";
const CORE_PLATFORM_SET = new Set(INGESTION_CORE_PLATFORMS);
const BLOCKER_CODES = new Set([
  "access_denied",
  "network_error",
  "captcha_required",
  "rate_limited",
  "multiple_access_blocks"
]);
const ACCEPTED_QUEUE_CODES = new Map([
  ["missing_credentials", "requires_credentials"],
  ["manual_review_required", "manual_review"]
]);
const MATERIALIZER_UNRESOLVED_QUEUE_CODES = new Set([
  "no_current_attempt",
  "missing_native_evidence",
  "ambiguous_legacy_outcome",
  "missing_exact_reason"
]);
const GENERIC_OPERATIONAL_TEXT = new Set([
  "blocked",
  "checked",
  "complete",
  "completed",
  "failed",
  "manual review",
  "n/a",
  "none",
  "queued",
  "unknown"
]);
const STRUCTURAL_TOKEN = /["{}\[\]:]/g;
const STRING_TOKEN = /["\\]/g;

/**
 * Audit the user-facing four-outcome terminal contract over every core pair.
 * The canonical coverage report is rebuilt first, then the large pair array is
 * streamed one row at a time and reconciled to its authenticated denominator.
 */
export async function buildIngestionTerminalOutcomeAudit({
  root = process.cwd(),
  materializationPath,
  historicalManifestPath,
  recentManifestPath,
  maxPairBytes = 4 * 1024 * 1024,
  reportLimits = {}
} = {}) {
  const absoluteRoot = resolve(root);
  const { report: coverageReport } = await buildIngestionCoverageReport({
    root: absoluteRoot,
    materializationPath,
    historicalManifestPath,
    recentManifestPath,
    ...reportLimits
  });
  const accumulator = createAuditAccumulator();
  const canonicalResolutionAccumulator = coverageReport.terminalOutcomeResolution
    ? createTerminalOutcomeResolutionAccumulator({
        previewLimit:
          coverageReport.terminalOutcomeResolution.auditProvenance
            .discardedSignalPreviewLimit
      })
    : null;
  const scan = await scanMaterializationCoveragePairs({
    materializationPath: resolveInputPath(absoluteRoot, materializationPath),
    maxPairBytes,
    onPair: (pair) => {
      const canonicalResolution = canonicalResolutionAccumulator
        ? accumulateTerminalOutcomeResolution(canonicalResolutionAccumulator, pair)
        : null;
      accumulatePairAudit(accumulator, pair, canonicalResolution);
    }
  });
  const canonicalResolution = canonicalResolutionAccumulator
    ? finalizeTerminalOutcomeResolutionAccumulator(canonicalResolutionAccumulator, {
        expectedCorePairs: coverageReport.inventory.corePairs
      })
    : null;
  reconcileScanWithCoverageReport(
    scan,
    accumulator,
    coverageReport,
    canonicalResolution
  );

  const gapLedgerBody = accumulator.gaps.length
    ? `${accumulator.gaps.map(stableJson).join("\n")}\n`
    : "";
  const gapLedger = {
    schemaVersion: "ingestion-terminal-outcome-gap-ledger.v1",
    format: "ndjson",
    rows: accumulator.gaps.length,
    bytes: Buffer.byteLength(gapLedgerBody),
    sha256: sha256(gapLedgerBody)
  };
  const outcomeCounts = finalizeOutcomeCounts(accumulator.outcomes);
  const byBatch = finalizeGroups(accumulator.byBatch);
  const byPlatform = finalizeGroups(accumulator.byPlatform);
  const byBatchPlatform = finalizeGroups(accumulator.byBatchPlatform);
  const structurallyUndocumentedPairs = accumulator.gaps.filter((row) =>
    row.structurallyUndocumented
  ).length;
  const contradictoryPairs = accumulator.gaps.filter((row) => row.contradictory).length;
  const complete = accumulator.gaps.length === 0 &&
    accumulator.corePairs === coverageReport.inventory.corePairs;

  const payload = {
    schemaVersion: INGESTION_TERMINAL_OUTCOME_AUDIT_VERSION,
    runId: coverageReport.runId,
    generatedAt: coverageReport.generatedAt,
    status: complete ? "complete" : "incomplete",
    complete,
    contract: {
      requiredOutcomes: REQUIRED_TERMINAL_OUTCOMES,
      queueSubdispositions: ["requires_credentials", "manual_review"],
      exactReasonRequired: true,
      concreteNextActionRequired: true,
      contradictoryAccountOutcomesAllowed: false,
      deterministicEvidencePrecedence:
        canonicalResolution?.policy.precedence ?? null,
      rawSignalsRewritten: false
    },
    denominator: {
      companies: coverageReport.inventory.companies,
      founders: coverageReport.inventory.founders,
      entities: coverageReport.inventory.entities,
      corePlatforms: coverageReport.inventory.corePlatforms,
      corePairs: coverageReport.inventory.corePairs,
      allPairsObserved: scan.allPairs
    },
    audited: {
      corePairs: accumulator.corePairs,
      compliantPairs: accumulator.compliantPairs,
      nonCompliantPairs: accumulator.gaps.length,
      structurallyUndocumentedPairs,
      contradictoryPairs,
      missingReasonPairs: accumulator.issuePairCounts.missing_exact_reason ?? 0,
      missingNextActionPairs:
        accumulator.issuePairCounts.missing_concrete_next_action ?? 0,
      unsupportedOutcomePairs:
        accumulator.issuePairCounts.unsupported_terminal_outcome ?? 0,
      rawContradictorySignalPairs:
        canonicalResolution?.auditProvenance.rawContradictoryPairs ?? contradictoryPairs,
      compliancePercent: percent(accumulator.compliantPairs, accumulator.corePairs)
    },
    materializerResolution: {
      unresolvedPairs: accumulator.materializerUnresolvedPairs,
      unresolvedCompliantTerminalPairs:
        accumulator.materializerUnresolvedCompliantTerminalPairs,
      unresolvedNonCompliantTerminalPairs:
        accumulator.materializerUnresolvedNonCompliantTerminalPairs,
      expectedUnresolvedPairs: coverageReport.totals.unresolved.pairs
    },
    outcomes: outcomeCounts,
    queueSubdispositions: { ...accumulator.queueSubdispositions },
    ...(canonicalResolution
      ? { resolutionProvenance: canonicalResolution }
      : {}),
    issuesByCode: sortObject(accumulator.issueOccurrences),
    issuePairsByCode: sortObject(accumulator.issuePairCounts),
    byBatch,
    byPlatform,
    byBatchPlatform,
    gapLedger,
    artifactBinding: {
      materialization: coverageReport.artifacts.materialization,
      coverageReceiptSha256: scan.coverageReceiptSha256,
      coverageReportPayloadSha256: coverageReport.provenance.reportPayloadSha256,
      allCorePairAuditSha256: accumulator.allPairAuditHash.digest("hex"),
      ...(canonicalResolution
        ? {
            canonicalPairResolutionSha256:
              canonicalResolution.pairResolutionSha256,
            discardedSignalsSha256:
              canonicalResolution.auditProvenance.discardedSignalsSha256
          }
        : {}),
      pairAuditSerialization: "stable-json-lines.v1",
      scanStrategy: "streamed-coverage-receipt-pairs.v1"
    }
  };
  const auditPayloadSha256 = sha256Stable(payload);
  const audit = {
    ...payload,
    provenance: {
      hashAlgorithm: "sha256",
      hashSerialization: "stable-json.v1",
      auditPayloadSha256
    }
  };
  return {
    audit,
    gapLedgerBody,
    markdown: renderIngestionTerminalOutcomeAuditMarkdown(audit)
  };
}

/**
 * Stream only coverageReceipt.pairs. No evidence registry or full pair array is
 * retained in memory. The receipt and materialization are hashed concurrently.
 */
export async function scanMaterializationCoveragePairs({
  materializationPath,
  onPair,
  maxPairBytes = 4 * 1024 * 1024
} = {}) {
  if (typeof onPair !== "function") throw new TypeError("onPair must be a function.");
  if (!Number.isSafeInteger(maxPairBytes) || maxPairBytes < 1024) {
    throw new TypeError("maxPairBytes must be a safe integer of at least 1024.");
  }
  const scanner = new MaterializationPairScanner({ onPair, maxPairBytes });
  const fileHash = createHash("sha256");
  let bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const chunk of createReadStream(materializationPath, {
    highWaterMark: 256 * 1024
  })) {
    fileHash.update(chunk);
    bytes += chunk.length;
    scanner.feed(decoder.decode(chunk, { stream: true }));
  }
  scanner.feed(decoder.decode());
  return {
    path: materializationPath,
    bytes,
    sha256: fileHash.digest("hex"),
    ...scanner.finish()
  };
}

/** Audit one already-validated receipt pair against the stricter user outcome contract. */
export function auditTerminalOutcomePair(pair) {
  const issues = [];
  const pairKey = requiredText(pair?.pairKey, "pair.pairKey");
  const terminal = isObject(pair?.terminal) ? pair.terminal : {};
  const terminalClassification = classifyOutcome(terminal, issues, "terminal");
  if (!hasExactOperationalText(terminal.reason)) {
    issues.push(issue(
      "missing_exact_reason",
      "The pair terminal outcome lacks an exact operational reason."
    ));
  }
  if (!hasExactOperationalText(terminal.nextAction)) {
    issues.push(issue(
      "missing_concrete_next_action",
      "The pair terminal outcome lacks a concrete next action."
    ));
  }
  const expectedTerminalFlag = terminal.status !== "queued";
  if (terminal.isTerminal !== expectedTerminalFlag) {
    issues.push(issue(
      "terminal_flag_mismatch",
      `terminal.isTerminal must be ${expectedTerminalFlag} for ${terminal.status ?? "missing"}.`
    ));
  }
  if (terminal.status === "verified_no_account" && !isObject(terminal.absenceVerification)) {
    issues.push(issue(
      "absence_verification_missing",
      "verified_no_account requires an exhaustive native-absence verification receipt."
    ));
  }

  const accountOutcomes = Array.isArray(pair.accountOutcomes) ? pair.accountOutcomes : [];
  if (accountOutcomes.length === 0) {
    issues.push(issue(
      "account_outcomes_missing",
      "The pair contains no task/account outcome supporting its terminal classification."
    ));
  }
  const accountCategories = new Map();
  const unsupportedAccountOutcomes = [];
  for (const [index, outcome] of accountOutcomes.entries()) {
    const accountIssues = [];
    const classification = classifyOutcome(outcome, accountIssues, `accountOutcomes[${index}]`);
    const key = classification.outcome ?? `unsupported:${outcome?.status ?? "missing"}:${outcome?.reasonCode ?? "missing"}`;
    accountCategories.set(key, (accountCategories.get(key) ?? 0) + 1);
    if (!classification.outcome || accountIssues.length) {
      unsupportedAccountOutcomes.push({
        index,
        taskKey: clean(outcome?.taskKey) || null,
        status: clean(outcome?.status) || null,
        reasonCode: clean(outcome?.reasonCode) || null,
        issueCodes: [...new Set(accountIssues.map((entry) => entry.code))]
      });
    }
  }
  if (unsupportedAccountOutcomes.length) {
    issues.push(issue(
      "account_outcome_unsupported",
      `${unsupportedAccountOutcomes.length} task/account outcome(s) do not map to the four required outcomes.`
    ));
  }
  const accountCategoryKeys = [...accountCategories.keys()];
  if (accountCategoryKeys.length > 1) {
    issues.push(issue(
      "contradictory_account_outcomes",
      `Task/account outcomes span contradictory categories: ${accountCategoryKeys.join(", ")}.`
    ));
  } else if (accountCategoryKeys.length === 1 && terminalClassification.outcome &&
      accountCategoryKeys[0] !== terminalClassification.outcome) {
    issues.push(issue(
      "terminal_account_outcome_mismatch",
      `Pair terminal category ${terminalClassification.outcome} contradicts ` +
      `task/account category ${accountCategoryKeys[0]}.`
    ));
  }

  const uniqueIssues = uniqueIssuesByCode(issues);
  const contradictory = uniqueIssues.some((entry) => [
    "contradictory_account_outcomes",
    "terminal_account_outcome_mismatch"
  ].includes(entry.code));
  const structurallyUndocumented = uniqueIssues.some((entry) => ![
    "contradictory_account_outcomes",
    "terminal_account_outcome_mismatch"
  ].includes(entry.code));
  const compliant = Boolean(terminalClassification.outcome) && uniqueIssues.length === 0;
  const result = {
    pairKey,
    batchSlug: requiredText(pair.batchSlug, `${pairKey}.batchSlug`),
    entityType: requiredText(pair.entity?.type, `${pairKey}.entity.type`),
    entityId: requiredText(pair.entity?.id, `${pairKey}.entity.id`),
    platform: requiredText(pair.platform, `${pairKey}.platform`),
    outcome: terminalClassification.outcome,
    queueSubdisposition: terminalClassification.queueSubdisposition,
    terminalStatus: clean(terminal.status) || null,
    reasonCode: clean(terminal.reasonCode) || null,
    reason: clean(terminal.reason) || null,
    nextAction: clean(terminal.nextAction) || null,
    compliant,
    structurallyUndocumented,
    contradictory,
    issues: uniqueIssues,
    accountOutcomeCategories: Object.fromEntries(
      [...accountCategories].sort(([left], [right]) => left.localeCompare(right))
    ),
    unsupportedAccountOutcomes,
    materializerUnresolved: isMaterializerUnresolvedPair(pair)
  };
  return result;
}

export function renderIngestionTerminalOutcomeAuditMarkdown(audit) {
  if (!isObject(audit) || audit.schemaVersion !== INGESTION_TERMINAL_OUTCOME_AUDIT_VERSION) {
    throw new Error(
      `audit.schemaVersion must be ${INGESTION_TERMINAL_OUTCOME_AUDIT_VERSION}.`
    );
  }
  const lines = [
    "# Core pair terminal-outcome audit",
    "",
    `Run: \`${escapeMd(audit.runId)}\`  `,
    `Generated: ${escapeMd(audit.generatedAt)}  `,
    `Audit payload: \`${audit.provenance.auditPayloadSha256}\``,
    "",
    "## Result",
    "",
    `**${audit.complete ? "COMPLETE" : "INCOMPLETE"}** — ` +
      `${formatInt(audit.audited.compliantPairs)}/${formatInt(audit.denominator.corePairs)} ` +
      `core pairs satisfy exactly one allowed terminal outcome ` +
      `(${formatPercent(audit.audited.compliancePercent)}).`,
    "",
    `Structurally undocumented pairs: **${formatInt(audit.audited.structurallyUndocumentedPairs)}**. ` +
      `Contradictory pairs: **${formatInt(audit.audited.contradictoryPairs)}**. ` +
      `Gap-ledger rows: **${formatInt(audit.gapLedger.rows)}**.`,
    ...(audit.resolutionProvenance
      ? [
          `Raw contradictory-signal pairs resolved by evidence precedence: ` +
            `**${formatInt(audit.audited.rawContradictorySignalPairs)}**. ` +
            `Discarded signals retained in audit provenance: ` +
            `**${formatInt(audit.resolutionProvenance.auditProvenance.discardedSignals)}**.`
        ]
      : []),
    "",
    "| Required outcome | Pairs | Compliant | With gaps |",
    "|---|---:|---:|---:|",
    ...Object.entries(audit.outcomes).map(([outcome, row]) =>
      `| ${escapeMd(outcome)} | ${formatInt(row.pairs)} | ` +
      `${formatInt(row.compliantPairs)} | ${formatInt(row.gapPairs)} |`
    ),
    "",
    "## Materializer-unresolved intersection",
    "",
    `The materializer records ${formatInt(audit.materializerResolution.unresolvedPairs)} ` +
      `unresolved pairs (expected ${formatInt(audit.materializerResolution.expectedUnresolvedPairs)}). ` +
      `${formatInt(audit.materializerResolution.unresolvedCompliantTerminalPairs)} have an allowed ` +
      `terminal classification; ${formatInt(audit.materializerResolution.unresolvedNonCompliantTerminalPairs)} ` +
      `fail this stricter terminal-outcome contract.`,
    "",
    "## By batch",
    "",
    "| Batch | Audited | Compliant | Structural gaps | Contradictions | Unclassified |",
    "|---|---:|---:|---:|---:|---:|",
    ...Object.entries(audit.byBatch).map(([key, row]) => groupMarkdownRow(key, row)),
    "",
    "## By platform",
    "",
    "| Platform | Audited | Compliant | Structural gaps | Contradictions | Unclassified |",
    "|---|---:|---:|---:|---:|---:|",
    ...Object.entries(audit.byPlatform).map(([key, row]) => groupMarkdownRow(key, row)),
    "",
    "## Gap reasons",
    "",
    ...(Object.keys(audit.issuePairsByCode).length
      ? Object.entries(audit.issuePairsByCode).map(([code, count]) =>
          `- ${escapeMd(code)}: ${formatInt(count)} pair(s).`
        )
      : ["- None."]),
    "",
    "## Artifact binding",
    "",
    `- Materialization: \`${audit.artifactBinding.materialization.sha256}\` ` +
      `(${formatInt(audit.artifactBinding.materialization.bytes)} bytes).`,
    `- Coverage receipt: \`${audit.artifactBinding.coverageReceiptSha256}\`.`,
    `- All-core-pair audit records: \`${audit.artifactBinding.allCorePairAuditSha256}\`.`,
    `- Gap ledger: \`${audit.gapLedger.sha256}\` ` +
      `(${formatInt(audit.gapLedger.bytes)} bytes).`,
    "",
    audit.resolutionProvenance
      ? "A pair is compliant only when deterministic evidence precedence emits one allowed category with an exact reason and concrete next action. Lower-precedence raw signals are not rewritten; their digest, counts, bounded preview, and source-record path remain in audit provenance."
      : "A pair is compliant only when its pair-level terminal and every supporting task/account outcome reconcile to one of the four required categories with an exact reason and concrete next action."
  ];
  return `${lines.join("\n")}\n`;
}

function createAuditAccumulator() {
  return {
    corePairs: 0,
    compliantPairs: 0,
    materializerUnresolvedPairs: 0,
    materializerUnresolvedCompliantTerminalPairs: 0,
    materializerUnresolvedNonCompliantTerminalPairs: 0,
    outcomes: new Map(),
    queueSubdispositions: { requires_credentials: 0, manual_review: 0 },
    issueOccurrences: {},
    issuePairCounts: {},
    byBatch: new Map(),
    byPlatform: new Map(),
    byBatchPlatform: new Map(),
    gaps: [],
    allPairAuditHash: createHash("sha256")
  };
}

function accumulatePairAudit(accumulator, pair, canonicalResolution = null) {
  if (pair.matrixScope !== "core") return;
  if (!CORE_PLATFORM_SET.has(pair.platform)) {
    throw new Error(`${pair.pairKey} declares core scope for unsupported platform ${pair.platform}.`);
  }
  const audit = canonicalResolution ?? auditTerminalOutcomePair(pair);
  accumulator.corePairs += 1;
  if (audit.compliant) accumulator.compliantPairs += 1;
  if (audit.queueSubdisposition) {
    accumulator.queueSubdispositions[audit.queueSubdisposition] += 1;
  }
  const outcome = audit.outcome ?? "unclassified";
  incrementOutcome(accumulator.outcomes, outcome, audit.compliant);
  addGroup(accumulator.byBatch, audit.batchSlug, outcome, audit);
  addGroup(accumulator.byPlatform, audit.platform, outcome, audit);
  addGroup(
    accumulator.byBatchPlatform,
    `${audit.batchSlug}:${audit.platform}`,
    outcome,
    audit
  );
  const pairIssueCodes = new Set();
  for (const entry of audit.issues) {
    accumulator.issueOccurrences[entry.code] =
      (accumulator.issueOccurrences[entry.code] ?? 0) + 1;
    pairIssueCodes.add(entry.code);
  }
  for (const code of pairIssueCodes) {
    accumulator.issuePairCounts[code] = (accumulator.issuePairCounts[code] ?? 0) + 1;
  }
  if (audit.materializerUnresolved) {
    accumulator.materializerUnresolvedPairs += 1;
    if (audit.compliant) accumulator.materializerUnresolvedCompliantTerminalPairs += 1;
    else accumulator.materializerUnresolvedNonCompliantTerminalPairs += 1;
  }
  const auditDigestRecord = compactAuditDigestRecord(audit);
  accumulator.allPairAuditHash.update(`${stableJson(auditDigestRecord)}\n`);
  if (!audit.compliant) accumulator.gaps.push(compactGapRecord(audit));
}

function classifyOutcome(value, issues, label) {
  const status = clean(value?.status);
  const reasonCode = clean(value?.reasonCode);
  if (status === "collected") {
    if (reasonCode !== "native_evidence_collected") {
      issues.push(issue(
        "terminal_reason_code_mismatch",
        `${label} collected status requires native_evidence_collected.`
      ));
    }
    return { outcome: "collected", queueSubdisposition: null };
  }
  if (status === "verified_no_account") {
    if (reasonCode !== "exhaustive_absence_verified") {
      issues.push(issue(
        "terminal_reason_code_mismatch",
        `${label} verified_no_account requires exhaustive_absence_verified.`
      ));
    }
    return { outcome: "verified_no_account", queueSubdisposition: null };
  }
  if (status === "blocked") {
    if (!BLOCKER_CODES.has(reasonCode)) {
      issues.push(issue(
        "terminal_reason_code_mismatch",
        `${label} blocked status lacks an exact access/network/captcha/rate reason code.`
      ));
    }
    return { outcome: "access_blocked", queueSubdisposition: null };
  }
  if (status === "queued") {
    const queueSubdisposition = ACCEPTED_QUEUE_CODES.get(reasonCode) ?? null;
    if (!queueSubdisposition) {
      issues.push(issue(
        "unsupported_terminal_outcome",
        `${label} queued reason ${reasonCode || "missing"} is neither credentials nor manual review.`
      ));
      return { outcome: null, queueSubdisposition: null };
    }
    return {
      outcome: "requires_credentials_or_manual_review",
      queueSubdisposition
    };
  }
  issues.push(issue(
    "unsupported_terminal_outcome",
    `${label} status ${status || "missing"} is outside the required outcome taxonomy.`
  ));
  return { outcome: null, queueSubdisposition: null };
}

function isMaterializerUnresolvedPair(pair) {
  if (pair.scope?.objectiveComplete === true) return false;
  const terminal = pair.terminal ?? {};
  if (!["blocked", "queued"].includes(terminal.status)) return true;
  if (terminal.status === "queued" &&
      MATERIALIZER_UNRESOLVED_QUEUE_CODES.has(terminal.reasonCode)) return true;
  return !clean(terminal.reason) || !clean(terminal.nextAction);
}

function compactAuditDigestRecord(audit) {
  return {
    pairKey: audit.pairKey,
    batchSlug: audit.batchSlug,
    entityType: audit.entityType,
    entityId: audit.entityId,
    platform: audit.platform,
    outcome: audit.outcome,
    queueSubdisposition: audit.queueSubdisposition,
    terminalStatus: audit.terminalStatus,
    reasonCode: audit.reasonCode,
    reason: audit.reason,
    nextAction: audit.nextAction,
    compliant: audit.compliant,
    structurallyUndocumented: audit.structurallyUndocumented,
    contradictory: audit.contradictory,
    issueCodes: audit.issues.map((entry) => entry.code),
    accountOutcomeCategories: audit.accountOutcomeCategories,
    materializerUnresolved: audit.materializerUnresolved
  };
}

function compactGapRecord(audit) {
  return {
    schemaVersion: "ingestion-terminal-outcome-gap.v1",
    pairKey: audit.pairKey,
    batchSlug: audit.batchSlug,
    entityType: audit.entityType,
    entityId: audit.entityId,
    platform: audit.platform,
    terminalStatus: audit.terminalStatus,
    reasonCode: audit.reasonCode,
    proposedOutcome: audit.outcome,
    queueSubdisposition: audit.queueSubdisposition,
    reason: audit.reason,
    nextAction: audit.nextAction,
    structurallyUndocumented: audit.structurallyUndocumented,
    contradictory: audit.contradictory,
    materializerUnresolved: audit.materializerUnresolved,
    issues: audit.issues,
    accountOutcomeCategories: audit.accountOutcomeCategories,
    unsupportedAccountOutcomes: audit.unsupportedAccountOutcomes
  };
}

function incrementOutcome(map, outcome, compliant) {
  const row = map.get(outcome) ?? { pairs: 0, compliantPairs: 0, gapPairs: 0 };
  row.pairs += 1;
  if (compliant) row.compliantPairs += 1;
  else row.gapPairs += 1;
  map.set(outcome, row);
}

function addGroup(map, key, outcome, audit) {
  const row = map.get(key) ?? {
    auditedPairs: 0,
    compliantPairs: 0,
    structurallyUndocumentedPairs: 0,
    contradictoryPairs: 0,
    materializerUnresolvedPairs: 0,
    outcomes: new Map()
  };
  row.auditedPairs += 1;
  if (audit.compliant) row.compliantPairs += 1;
  if (audit.structurallyUndocumented) row.structurallyUndocumentedPairs += 1;
  if (audit.contradictory) row.contradictoryPairs += 1;
  if (audit.materializerUnresolved) row.materializerUnresolvedPairs += 1;
  incrementOutcome(row.outcomes, outcome, audit.compliant);
  map.set(key, row);
}

function finalizeOutcomeCounts(map) {
  const ordered = [...REQUIRED_TERMINAL_OUTCOMES, "unclassified"];
  return Object.fromEntries(ordered.map((key) => [
    key,
    structuredClone(map.get(key) ?? { pairs: 0, compliantPairs: 0, gapPairs: 0 })
  ]));
}

function finalizeGroups(map) {
  return Object.fromEntries([...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, row]) => [key, {
      auditedPairs: row.auditedPairs,
      compliantPairs: row.compliantPairs,
      gapPairs: row.auditedPairs - row.compliantPairs,
      structurallyUndocumentedPairs: row.structurallyUndocumentedPairs,
      contradictoryPairs: row.contradictoryPairs,
      materializerUnresolvedPairs: row.materializerUnresolvedPairs,
      compliancePercent: percent(row.compliantPairs, row.auditedPairs),
      outcomes: finalizeOutcomeCounts(row.outcomes)
    }]));
}

function reconcileScanWithCoverageReport(
  scan,
  accumulator,
  report,
  canonicalResolution = null
) {
  if (scan.sha256 !== report.artifacts.materialization.sha256 ||
      scan.bytes !== report.artifacts.materialization.bytes) {
    throw new Error("Pair scan materialization does not match the authenticated coverage report.");
  }
  if (scan.coverageReceiptSha256 !== report.sourceDigests.coverageReceiptSha256) {
    throw new Error("Pair scan coverage receipt digest does not match the authenticated report.");
  }
  if (scan.materializationSchemaVersion !== MATERIALIZATION_VERSION) {
    throw new Error(`Materialization schemaVersion must be ${MATERIALIZATION_VERSION}.`);
  }
  if (scan.corePairs !== report.inventory.corePairs ||
      accumulator.corePairs !== report.inventory.corePairs ||
      scan.allPairs !== report.inventory.allPairs) {
    throw new Error("Streamed pair counts do not match the authenticated matrix denominator.");
  }
  if (accumulator.materializerUnresolvedPairs !== report.totals.unresolved.pairs) {
    throw new Error("Streamed materializer-unresolved count does not match the coverage report.");
  }
  if (Boolean(canonicalResolution) !== Boolean(report.terminalOutcomeResolution)) {
    throw new Error("Canonical terminal resolution presence does not reconcile.");
  }
  if (canonicalResolution &&
      stableJson(canonicalResolution) !== stableJson(report.terminalOutcomeResolution)) {
    throw new Error(
      "Streamed canonical terminal resolution does not match the authenticated materializer summary."
    );
  }
  for (const row of report.byBatch) {
    const actual = accumulator.byBatch.get(row.batchSlug)?.auditedPairs ?? 0;
    if (actual !== row.denominator.pairs) {
      throw new Error(`${row.batchSlug} pair audit denominator mismatch.`);
    }
  }
  for (const row of report.byPlatform) {
    const actual = accumulator.byPlatform.get(row.platform)?.auditedPairs ?? 0;
    if (actual !== row.denominator.pairs) {
      throw new Error(`${row.platform} pair audit denominator mismatch.`);
    }
  }
  for (const row of report.byBatchPlatform) {
    const actual = accumulator.byBatchPlatform.get(row.key)?.auditedPairs ?? 0;
    if (actual !== row.denominator.pairs) {
      throw new Error(`${row.key} pair audit denominator mismatch.`);
    }
  }
}

class MaterializationPairScanner {
  constructor({ onPair, maxPairBytes }) {
    this.onPair = onPair;
    this.maxPairBytes = maxPairBytes;
    this.phase = "materialization";
    this.materializationDepth = 0;
    this.receiptDepth = 0;
    this.awaitReceipt = false;
    this.awaitSchemaVersion = false;
    this.awaitPairs = false;
    this.candidateKey = null;
    this.inString = false;
    this.escaped = false;
    this.captureString = false;
    this.stringRaw = "";
    this.receiptHash = createHash("sha256");
    this.receiptBytes = 0;
    this.receiptOpen = false;
    this.receiptComplete = false;
    this.receiptChunkStart = null;
    this.pairsFound = false;
    this.pairsComplete = false;
    this.pairActive = false;
    this.pairDepth = 0;
    this.pairParts = [];
    this.pairBytes = 0;
    this.pairChunkStart = null;
    this.allPairs = 0;
    this.corePairs = 0;
    this.previousPairKey = null;
    this.seenPairKeys = new Set();
    this.materializationSchemaVersion = null;
    this.currentText = "";
  }

  feed(text) {
    if (!text) return;
    this.currentText = text;
    this.receiptChunkStart = this.receiptOpen ? 0 : null;
    this.pairChunkStart = this.pairActive ? 0 : null;
    let index = 0;
    let stringCaptureStart = this.inString && this.captureString ? 0 : null;
    while (index < text.length && !this.receiptComplete) {
      if (this.inString) {
        if (this.escaped) {
          this.escaped = false;
          index += 1;
          continue;
        }
        STRING_TOKEN.lastIndex = index;
        const match = STRING_TOKEN.exec(text);
        if (!match) {
          if (this.captureString) {
            this.appendString(text.slice(stringCaptureStart));
            stringCaptureStart = null;
          }
          index = text.length;
          break;
        }
        index = match.index + 1;
        if (match[0] === "\\") {
          if (index >= text.length) this.escaped = true;
          else index += 1;
          continue;
        }
        if (this.captureString) {
          this.appendString(text.slice(stringCaptureStart, match.index));
        }
        this.inString = false;
        this.finishString();
        stringCaptureStart = null;
        continue;
      }

      STRUCTURAL_TOKEN.lastIndex = index;
      const match = STRUCTURAL_TOKEN.exec(text);
      if (!match) {
        index = text.length;
        break;
      }
      index = match.index + 1;
      if (match[0] === '"') {
        this.inString = true;
        this.escaped = false;
        this.captureString = this.shouldCaptureKey();
        this.stringRaw = "";
        stringCaptureStart = this.captureString ? index : null;
        continue;
      }
      this.processToken(match[0], match.index, index);
    }
    if (this.inString && this.captureString && stringCaptureStart !== null) {
      this.appendString(text.slice(stringCaptureStart));
    }
    if (this.pairActive && this.pairChunkStart !== null) {
      this.appendPairSegment(text.slice(this.pairChunkStart));
      this.pairChunkStart = null;
    }
    if (this.receiptOpen && this.receiptChunkStart !== null) {
      this.appendReceiptSegment(text.slice(this.receiptChunkStart));
      this.receiptChunkStart = null;
    }
    this.currentText = "";
  }

  finish() {
    if (this.inString || this.pairActive || !this.receiptComplete ||
        !this.pairsFound || !this.pairsComplete) {
      throw new Error("Materialization ended before coverageReceipt.pairs was complete.");
    }
    if (!this.materializationSchemaVersion) {
      throw new Error("Materialization schemaVersion was not observed.");
    }
    return {
      materializationSchemaVersion: this.materializationSchemaVersion,
      coverageReceiptBytes: this.receiptBytes,
      coverageReceiptSha256: this.receiptHash.digest("hex"),
      allPairs: this.allPairs,
      corePairs: this.corePairs
    };
  }

  shouldCaptureKey() {
    return (this.phase === "materialization" && this.materializationDepth === 1) ||
      (this.phase === "receipt" && this.receiptDepth === 1);
  }

  appendString(value) {
    this.stringRaw += value;
    if (Buffer.byteLength(this.stringRaw) > 1024) {
      throw new Error("Top-level JSON key exceeds the 1024-byte safety limit.");
    }
  }

  finishString() {
    if (this.captureString) {
      let decoded;
      try {
        decoded = JSON.parse(`"${this.stringRaw}"`);
      } catch (error) {
        throw new Error(`Invalid top-level JSON string: ${error.message}`);
      }
      if (this.phase === "materialization" && this.awaitSchemaVersion) {
        this.materializationSchemaVersion = decoded;
        this.awaitSchemaVersion = false;
        this.candidateKey = null;
      } else {
        this.candidateKey = decoded;
      }
    }
    this.captureString = false;
    this.stringRaw = "";
  }

  processToken(token, start, end) {
    if (this.phase === "materialization") {
      this.processMaterializationToken(token, start);
      return;
    }
    if (this.phase === "receipt") {
      this.processReceiptToken(token, start, end);
      return;
    }
    if (this.phase === "pairs") {
      this.processPairsToken(token, start, end);
    }
  }

  processMaterializationToken(token, start) {
    if (token === ":" && this.materializationDepth === 1) {
      if (this.candidateKey === "coverageReceipt") this.awaitReceipt = true;
      if (this.candidateKey === "schemaVersion") this.awaitSchemaVersion = true;
      this.candidateKey = null;
      return;
    }
    if (token === "{") {
      if (this.materializationDepth === 1 && this.awaitReceipt) {
        this.phase = "receipt";
        this.receiptDepth = 1;
        this.receiptOpen = true;
        this.receiptChunkStart = start;
        this.awaitReceipt = false;
        return;
      }
      this.materializationDepth += 1;
      return;
    }
    if (token === "[") this.materializationDepth += 1;
    else if (token === "}" || token === "]") this.materializationDepth -= 1;
  }

  processReceiptToken(token, start, end) {
    if (token === ":" && this.receiptDepth === 1) {
      if (this.candidateKey === "pairs") this.awaitPairs = true;
      this.candidateKey = null;
      return;
    }
    if (token === "[") {
      if (this.receiptDepth === 1 && this.awaitPairs) {
        this.phase = "pairs";
        this.pairsFound = true;
        this.awaitPairs = false;
        return;
      }
      this.receiptDepth += 1;
      return;
    }
    if (token === "{") {
      this.receiptDepth += 1;
      return;
    }
    if (token === "}" || token === "]") {
      this.receiptDepth -= 1;
      if (this.receiptDepth === 0) {
        this.appendReceiptThrough(end);
        this.receiptOpen = false;
        this.receiptComplete = true;
        this.phase = "done";
      }
    }
  }

  processPairsToken(token, start, end) {
    if (!this.pairActive) {
      if (token === "{") {
        this.pairActive = true;
        this.pairDepth = 1;
        this.pairParts = [];
        this.pairBytes = 0;
        this.pairChunkStart = start;
      } else if (token === "]") {
        this.pairsComplete = true;
        this.phase = "receipt";
        this.receiptDepth = 1;
      }
      return;
    }
    if (token === "{" || token === "[") this.pairDepth += 1;
    else if (token === "}" || token === "]") {
      this.pairDepth -= 1;
      if (this.pairDepth < 0) throw new Error("Pair JSON nesting is unbalanced.");
      if (this.pairDepth === 0) {
        if (token !== "}") throw new Error("Coverage pair must be a JSON object.");
        this.appendPairThrough(end);
        this.finishPair();
      }
    }
  }

  appendReceiptThrough(end) {
    if (this.receiptChunkStart === null) {
      throw new Error("Receipt hash segment is missing.");
    }
    this.appendReceiptSegment(this.currentText.slice(this.receiptChunkStart, end));
    this.receiptChunkStart = null;
  }

  appendReceiptSegment(value) {
    this.receiptHash.update(value);
    this.receiptBytes += Buffer.byteLength(value);
  }

  appendPairThrough(end) {
    if (this.pairChunkStart === null) throw new Error("Pair capture segment is missing.");
    this.appendPairSegment(this.currentText.slice(this.pairChunkStart, end));
    this.pairChunkStart = null;
  }

  appendPairSegment(value) {
    this.pairParts.push(value);
    this.pairBytes += Buffer.byteLength(value);
    if (this.pairBytes > this.maxPairBytes) {
      throw new Error(`Coverage pair exceeds the ${this.maxPairBytes}-byte safety limit.`);
    }
  }

  finishPair() {
    const raw = this.pairParts.join("");
    let pair;
    try {
      pair = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Coverage pair is invalid JSON: ${error.message}`);
    }
    const pairKey = requiredText(pair.pairKey, "coverage pair.pairKey");
    if (this.seenPairKeys.has(pairKey)) throw new Error(`Duplicate coverage pair ${pairKey}.`);
    if (this.previousPairKey !== null && this.previousPairKey.localeCompare(pairKey) > 0) {
      throw new Error("Coverage pairs are not in canonical pairKey order.");
    }
    this.seenPairKeys.add(pairKey);
    this.previousPairKey = pairKey;
    this.allPairs += 1;
    if (pair.matrixScope === "core") this.corePairs += 1;
    else if (pair.matrixScope !== "extended_only") {
      throw new Error(`${pairKey} has invalid matrixScope ${pair.matrixScope}.`);
    }
    this.onPair(pair);
    this.pairActive = false;
    this.pairDepth = 0;
    this.pairParts = [];
    this.pairBytes = 0;
  }
}

function uniqueIssuesByCode(values) {
  const seen = new Set();
  return values.filter((entry) => {
    if (seen.has(entry.code)) return false;
    seen.add(entry.code);
    return true;
  });
}

function issue(code, detail) {
  return { code, detail };
}

function hasExactOperationalText(value) {
  const text = clean(value);
  return text.length >= 12 && !GENERIC_OPERATIONAL_TEXT.has(text.toLowerCase());
}

function groupMarkdownRow(key, row) {
  return `| ${escapeMd(key)} | ${formatInt(row.auditedPairs)} | ` +
    `${formatInt(row.compliantPairs)} | ${formatInt(row.structurallyUndocumentedPairs)} | ` +
    `${formatInt(row.contradictoryPairs)} | ` +
    `${formatInt(row.outcomes.unclassified.pairs)} |`;
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right)
  ));
}

function resolveInputPath(root, value) {
  const path = requiredText(value, "materializationPath");
  return path.startsWith("/") ? resolve(path) : resolve(root, path);
}

function requiredText(value, label) {
  const text = clean(value);
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}

function clean(value) {
  return String(value ?? "").trim();
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Stable(value) {
  return sha256(stableJson(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function percent(numerator, denominator) {
  return denominator ? Number(((numerator / denominator) * 100).toFixed(2)) : 0;
}

function formatInt(value) {
  return Number(value ?? 0).toLocaleString("en-US");
}

function formatPercent(value) {
  return `${Number(value ?? 0).toFixed(2)}%`;
}

function escapeMd(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
