import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  HISTORICAL_COMPLETION_PROOF_VERSION,
  HISTORICAL_COVERAGE_ADAPTER_LIMITS,
  adaptHistoricalBackfillCoverage
} from "./historical-coverage-adapter.mjs";
import { INGESTION_RECENCY_WINDOW_DAYS } from "./ingestion-coverage-receipt.mjs";

export const HISTORICAL_COMPLETION_PROOF_GENERATOR_VERSION =
  "historical-completion-proof-generator.v1";

const SHA256 = /^[a-f0-9]{64}$/;
const ELIGIBLE_OUTCOMES = new Set(["collected", "verified_no_history"]);
const EXHAUSTIVE_COVERAGE_EXTENTS = new Set([
  "all_available_search_results",
  "all_discovered_official_feed_entries_within_endpoint_policy",
  "all_discovered_official_web_history_within_endpoint_policy"
]);
const VERIFIED_NO_HISTORY_MARKERS = new Set([
  "no_feed_entries_found_within_verified_official_sources",
  "no_historical_pages_found_within_verified_official_sources"
]);
const TECHNICAL_LIMITS = Object.freeze({
  all_available_search_results:
    "All native results exposed by the configured public search pagination policy were exhausted.",
  all_discovered_official_feed_entries_within_endpoint_policy:
    "All discovered official feed endpoints and entries within the configured endpoint policy were exhausted.",
  all_discovered_official_web_history_within_endpoint_policy:
    "All discovered official website history within the configured endpoint policy was exhausted."
});

/**
 * Generate immutable historical-completion proofs only for targets whose
 * completed, hash-pinned journal receipts satisfy the production adapter's
 * exhaustive-source contract. The adapter validates the complete journal both
 * before and after proof generation, so a changed or partially written source
 * cannot produce an output package.
 */
export async function generateHistoricalCompletionProofs({
  root = process.cwd(),
  journalPath,
  expectedJournalSha256,
  outputDir = null,
  generatedAt,
  dryRun = false,
  maxJournalBytes = HISTORICAL_COVERAGE_ADAPTER_LIMITS.maxJournalBytes,
  maxLineBytes = HISTORICAL_COVERAGE_ADAPTER_LIMITS.maxLineBytes,
  maxEvents = HISTORICAL_COVERAGE_ADAPTER_LIMITS.maxEvents
} = {}) {
  const normalizedGeneratedAt = canonicalTimestamp(generatedAt, "generatedAt");
  const normalizedExpectedSha256 = requiredSha256(
    expectedJournalSha256,
    "expectedJournalSha256"
  );
  const normalizedLimits = normalizeLimits({ maxJournalBytes, maxLineBytes, maxEvents });
  const rootPath = await realpath(resolve(root));
  const journalAbsolutePath = await realpath(resolveFromRoot(
    rootPath,
    requiredText(journalPath, "journalPath")
  ));
  const outputPath = outputDir
    ? resolveFromRoot(rootPath, requiredText(outputDir, "outputDir"))
    : null;
  if (!dryRun && !outputPath) throw new Error("outputDir is required unless dryRun=true.");
  if (outputPath) await assertPathDoesNotExist(outputPath, "outputDir");

  const inspection = await inspectHistoricalJournal(journalAbsolutePath, normalizedLimits);
  if (inspection.sha256 !== normalizedExpectedSha256) {
    throw new Error(
      `Historical journal sha256 mismatch: expected ${normalizedExpectedSha256}, ` +
      `computed ${inspection.sha256}.`
    );
  }
  if (inspection.lastRecordedAt > normalizedGeneratedAt) {
    throw new Error("generatedAt cannot predate the journal's final recordedAt.");
  }
  const sourceArtifact = {
    path: portablePath(rootPath, journalAbsolutePath),
    sha256: inspection.sha256,
    observedAt: inspection.lastRecordedAt
  };
  const recencyCutoffAt = new Date(
    Date.parse(normalizedGeneratedAt) -
      INGESTION_RECENCY_WINDOW_DAYS * 24 * 60 * 60 * 1_000
  ).toISOString();

  // First adapter pass validates the entire hash chain, target receipts,
  // evidence reconciliation, run completion, and artifact digest without
  // granting any completion scope.
  const unproved = await adaptHistoricalBackfillCoverage({
    journal: createReadStream(journalAbsolutePath),
    artifact: sourceArtifact,
    generatedAt: normalizedGeneratedAt,
    completionProofs: [],
    limits: normalizedLimits
  });
  if (unproved.pairScopes.length !== 0) {
    throw new Error("Unproved historical adapter pass unexpectedly emitted complete scopes.");
  }
  if (unproved.targetCoverage.length !== inspection.expectedTargets) {
    throw new Error(
      `Historical denominator mismatch: adapter=${unproved.targetCoverage.length}, ` +
      `journal=${inspection.expectedTargets}.`
    );
  }
  if (inspection.terminals.size !== inspection.expectedTargets) {
    throw new Error(
      `Historical journal has ${inspection.terminals.size}/${inspection.expectedTargets} terminal targets.`
    );
  }

  const targetCoverage = new Map(unproved.targetCoverage.map((row) => [row.targetKey, row]));
  const proofs = [];
  const exclusions = [];
  for (const targetKey of inspection.targetKeys) {
    const terminal = inspection.terminals.get(targetKey);
    const coverage = targetCoverage.get(targetKey);
    if (!terminal || !coverage) {
      throw new Error(`Historical target ${targetKey} did not reconcile across validated passes.`);
    }
    const exclusionReasons = completionExclusionReasons(terminal.receipt, coverage);
    if (exclusionReasons.length > 0) {
      exclusions.push(exclusionRow({
        targetKey,
        terminal,
        coverage,
        exclusionReasons
      }));
      continue;
    }
    const proof = completionProof({
      targetKey,
      terminal,
      runCompletedSequence: inspection.runCompleted.sequence,
      artifactSha256: inspection.sha256,
      coveredThrough: recencyCutoffAt,
      coverage
    });
    proofs.push(proof);
  }
  proofs.sort((left, right) => left.targetKey.localeCompare(right.targetKey));
  exclusions.sort((left, right) => left.targetKey.localeCompare(right.targetKey));

  // Final adapter pass is the compatibility oracle. It re-reads and re-hashes
  // the journal, validates every generated field, and must emit exactly the
  // generated target set as complete scopes.
  const proved = await adaptHistoricalBackfillCoverage({
    journal: createReadStream(journalAbsolutePath),
    artifact: sourceArtifact,
    generatedAt: normalizedGeneratedAt,
    completionProofs: proofs,
    limits: normalizedLimits
  });
  verifyRoundTrip({ proofs, proved, recencyCutoffAt });

  const summary = summarize({
    targetCoverage: unproved.targetCoverage,
    proofs,
    exclusions
  });
  const proofBody = `${stableJson(proofs)}\n`;
  const exclusionDocument = {
    schemaVersion: HISTORICAL_COMPLETION_PROOF_GENERATOR_VERSION,
    generatedAt: normalizedGeneratedAt,
    sourceArtifactSha256: inspection.sha256,
    rows: exclusions
  };
  const exclusionBody = `${stableJson(exclusionDocument)}\n`;
  const proofDescriptor = descriptor({
    path: "completion-proofs.json",
    body: proofBody,
    rows: proofs.length,
    observedAt: normalizedGeneratedAt
  });
  const exclusionDescriptor = descriptor({
    path: "completion-exclusions.json",
    body: exclusionBody,
    rows: exclusions.length,
    observedAt: normalizedGeneratedAt
  });
  const manifest = {
    schemaVersion: HISTORICAL_COMPLETION_PROOF_GENERATOR_VERSION,
    status: "generated_verified",
    generatedAt: normalizedGeneratedAt,
    recencyCutoffAt,
    sourceArtifact: {
      ...sourceArtifact,
      bytes: inspection.bytes,
      events: inspection.events,
      firstSequence: inspection.firstSequence,
      lastSequence: inspection.lastSequence,
      firstRecordedAt: inspection.firstRecordedAt,
      lastRecordedAt: inspection.lastRecordedAt,
      runCompletedSequence: inspection.runCompleted.sequence,
      expectedTargets: inspection.expectedTargets,
      terminalTargets: inspection.terminals.size
    },
    denominator: {
      targetsEvaluated: inspection.expectedTargets,
      targetsCompletionEligible: proofs.length,
      targetsExcluded: exclusions.length
    },
    summary,
    verification: {
      adapterRoundTrip: "passed",
      completePairScopes: proved.pairScopes.length,
      completeTargetCoverageRows: proved.targetCoverage.filter(
        (row) => row.scopeStatus === "complete"
      ).length,
      sourceJournalRereadAndHashVerified: true
    },
    artifacts: {
      completionProofs: proofDescriptor,
      completionExclusions: exclusionDescriptor
    }
  };
  const manifestBody = `${stableJson(manifest)}\n`;
  const manifestDescriptor = descriptor({
    path: "completion-proof-manifest.json",
    body: manifestBody,
    rows: 1,
    observedAt: normalizedGeneratedAt
  });

  if (!dryRun) {
    await writeImmutablePackage({
      outputPath,
      files: [
        [proofDescriptor.path, proofBody],
        [exclusionDescriptor.path, exclusionBody],
        [manifestDescriptor.path, manifestBody]
      ]
    });
  }

  return {
    schemaVersion: HISTORICAL_COMPLETION_PROOF_GENERATOR_VERSION,
    status: "generated_verified",
    outputDir: outputPath,
    generatedAt: normalizedGeneratedAt,
    recencyCutoffAt,
    sourceArtifact,
    denominator: manifest.denominator,
    summary,
    verification: manifest.verification,
    artifacts: {
      ...manifest.artifacts,
      manifest: manifestDescriptor
    },
    dryRun
  };
}

async function inspectHistoricalJournal(path, limits) {
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let bytes = 0;
  let lineNumber = 0;
  let finalByte = null;
  let firstSequence = null;
  let lastSequence = 0;
  let firstRecordedAt = null;
  let lastRecordedAt = null;
  let runInitialized = null;
  let runCompleted = null;
  const terminals = new Map();

  const consumeLine = (line) => {
    lineNumber += 1;
    if (lineNumber > limits.maxEvents) {
      throw new Error(`Historical journal exceeds maxEvents=${limits.maxEvents}.`);
    }
    if (!line) throw new Error(`Historical journal line ${lineNumber} must not be blank.`);
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
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new Error(`Historical journal line ${lineNumber} must be an object.`);
    }
    const sequence = positiveInteger(event.sequence, `line ${lineNumber}.sequence`);
    if (sequence !== lastSequence + 1) {
      throw new Error(
        `Historical journal sequence must be contiguous; expected ${lastSequence + 1}, got ${sequence}.`
      );
    }
    const recordedAt = canonicalTimestamp(event.recordedAt, `line ${lineNumber}.recordedAt`);
    if (lastRecordedAt && recordedAt < lastRecordedAt) {
      throw new Error("Historical journal recordedAt timestamps must be non-decreasing.");
    }
    firstSequence ??= sequence;
    firstRecordedAt ??= recordedAt;
    lastSequence = sequence;
    lastRecordedAt = recordedAt;
    if (event.type === "run_initialized") {
      if (runInitialized || sequence !== 1) {
        throw new Error("Historical journal must contain exactly one initial run_initialized event.");
      }
      const targetKeys = event.config?.targetKeys;
      if (!Array.isArray(targetKeys) || targetKeys.length === 0) {
        throw new Error("Historical run_initialized must declare non-empty targetKeys.");
      }
      if (new Set(targetKeys).size !== targetKeys.length) {
        throw new Error("Historical run_initialized targetKeys must be unique.");
      }
      runInitialized = { sequence, recordedAt, targetKeys: [...targetKeys] };
    } else if (event.type === "target_completed") {
      const targetKey = requiredText(event.targetKey, `line ${lineNumber}.targetKey`);
      if (terminals.has(targetKey)) {
        throw new Error(`Historical journal repeats terminal target ${targetKey}.`);
      }
      terminals.set(targetKey, {
        sequence,
        recordedAt,
        receipt: structuredClone(event.receipt)
      });
    } else if (event.type === "run_completed") {
      if (runCompleted) throw new Error("Historical journal repeats run_completed.");
      if (event.summary?.status !== "completed") {
        throw new Error("Historical run_completed summary status must be completed.");
      }
      runCompleted = { sequence, recordedAt };
    }
  };

  for await (const rawChunk of createReadStream(path)) {
    const chunk = Buffer.from(rawChunk);
    if (chunk.length === 0) continue;
    bytes += chunk.length;
    if (bytes > limits.maxJournalBytes) {
      throw new Error(`Historical journal exceeds maxJournalBytes=${limits.maxJournalBytes}.`);
    }
    hash.update(chunk);
    finalByte = chunk.at(-1);
    pending += decoder.decode(chunk, { stream: true });
    while (true) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      consumeLine(line);
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
  if (!runInitialized) throw new Error("Historical journal is missing run_initialized.");
  if (!runCompleted || runCompleted.sequence !== lastSequence) {
    throw new Error("Historical journal must end in a completed run_completed event.");
  }
  const expectedSet = new Set(runInitialized.targetKeys);
  for (const targetKey of terminals.keys()) {
    if (!expectedSet.has(targetKey)) {
      throw new Error(`Historical terminal target ${targetKey} was not declared at initialization.`);
    }
  }
  return {
    bytes,
    sha256: hash.digest("hex"),
    events: lineNumber,
    firstSequence,
    lastSequence,
    firstRecordedAt,
    lastRecordedAt,
    runCompleted,
    targetKeys: runInitialized.targetKeys,
    expectedTargets: runInitialized.targetKeys.length,
    terminals
  };
}

function completionExclusionReasons(receipt, coverage) {
  const reasons = [];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return ["terminal_receipt_missing_or_invalid"];
  }
  if (!ELIGIBLE_OUTCOMES.has(receipt.outcome)) {
    reasons.push(`outcome_${String(receipt.outcome ?? "missing")}`);
  }
  if (receipt.sourceExhausted !== true) reasons.push("source_not_exhausted");
  if (receipt.truncated !== false) reasons.push("history_truncated");
  if (receipt.credentialRequired !== false) reasons.push("credentials_required");
  if (receipt.nextCursor !== null) reasons.push("next_cursor_remaining");
  if (!EXHAUSTIVE_COVERAGE_EXTENTS.has(receipt.coverageExtent)) {
    reasons.push("coverage_extent_not_exhaustive");
  }
  const blockers = [...new Set([receipt.blocker, ...(receipt.blockers ?? [])].filter(Boolean))];
  const blockersAllowed = receipt.outcome === "verified_no_history" &&
    blockers.every((blocker) => VERIFIED_NO_HISTORY_MARKERS.has(blocker));
  if (blockers.length > 0 && !blockersAllowed) reasons.push("terminal_blocker_present");
  if (coverage.rejectedEvidence !== 0) reasons.push("rejected_evidence_present");
  if (
    receipt.outcome === "collected" &&
    coverage.emittedEvidence !== receipt.accepted
  ) {
    reasons.push("collected_evidence_does_not_reconcile");
  }
  return [...new Set(reasons)].sort();
}

function completionProof({
  targetKey,
  terminal,
  runCompletedSequence,
  artifactSha256,
  coveredThrough,
  coverage
}) {
  const receiptId = deterministicCompletionReceiptId({
    artifactSha256,
    targetKey,
    terminalSequence: terminal.sequence,
    runCompletedSequence,
    coveredThrough
  });
  const evidenceClause = terminal.receipt.outcome === "collected"
    ? `${coverage.emittedEvidence} accepted native evidence rows reconcile with zero rejected rows`
    : "the verified official sources returned no historical native rows";
  return {
    proofVersion: HISTORICAL_COMPLETION_PROOF_VERSION,
    targetKey,
    status: "complete",
    artifactSha256,
    terminalSequence: terminal.sequence,
    runCompletedSequence,
    checkedAt: terminal.recordedAt,
    coveredThrough,
    receiptId,
    technicalLimit: TECHNICAL_LIMITS[terminal.receipt.coverageExtent],
    reason:
      `The completed hash-chained journal proves source exhaustion; ${evidenceClause}.`
  };
}

function deterministicCompletionReceiptId(value) {
  return `historical-${sha256(stableJson({
    version: HISTORICAL_COMPLETION_PROOF_VERSION,
    ...value
  })).slice(0, 40)}`;
}

function exclusionRow({ targetKey, terminal, coverage, exclusionReasons }) {
  return {
    targetKey,
    batchSlug: coverage.batchSlug,
    entityType: coverage.entityType,
    entityId: coverage.entityId,
    platform: coverage.platform,
    outcome: coverage.outcome,
    terminalSequence: terminal.sequence,
    checkedAt: terminal.recordedAt,
    sourceExhausted: terminal.receipt.sourceExhausted === true,
    truncated: terminal.receipt.truncated === true,
    credentialRequired: terminal.receipt.credentialRequired === true,
    blockers: [...new Set([
      terminal.receipt.blocker,
      ...(terminal.receipt.blockers ?? [])
    ].filter(Boolean))].sort(),
    coverageExtent: terminal.receipt.coverageExtent ?? null,
    accepted: coverage.accepted,
    emittedEvidence: coverage.emittedEvidence,
    rejectedEvidence: coverage.rejectedEvidence,
    exclusionReasons,
    nextAction: terminal.receipt.nextAction
  };
}

function verifyRoundTrip({ proofs, proved, recencyCutoffAt }) {
  const expected = new Map(proofs.map((proof) => [proof.targetKey, proof]));
  const completedRows = proved.targetCoverage.filter((row) => row.scopeStatus === "complete");
  if (proved.pairScopes.length !== proofs.length || completedRows.length !== proofs.length) {
    throw new Error(
      `Historical proof round-trip emitted ${proved.pairScopes.length} scopes and ` +
      `${completedRows.length} complete rows for ${proofs.length} proofs.`
    );
  }
  for (const row of completedRows) {
    const proof = expected.get(row.targetKey);
    if (!proof || row.completionReceiptId !== proof.receiptId ||
        row.recencyCutoffAt !== recencyCutoffAt) {
      throw new Error(`Historical proof round-trip mismatch for ${row.targetKey}.`);
    }
    expected.delete(row.targetKey);
  }
  if (expected.size > 0) {
    throw new Error(`Historical proof round-trip omitted ${expected.size} generated targets.`);
  }
}

function summarize({ targetCoverage, proofs, exclusions }) {
  const proofKeys = new Set(proofs.map((proof) => proof.targetKey));
  const byPlatform = {};
  const byBatch = {};
  const byOutcome = {};
  for (const row of targetCoverage) {
    incrementSlice(byPlatform, row.platform, proofKeys.has(row.targetKey));
    incrementSlice(byBatch, row.batchSlug, proofKeys.has(row.targetKey));
    incrementSlice(byOutcome, row.outcome, proofKeys.has(row.targetKey));
  }
  const exclusionReasons = {};
  for (const row of exclusions) {
    for (const reason of row.exclusionReasons) {
      exclusionReasons[reason] = (exclusionReasons[reason] ?? 0) + 1;
    }
  }
  return {
    byPlatform: sortedObject(byPlatform),
    byBatch: sortedObject(byBatch),
    byOutcome: sortedObject(byOutcome),
    exclusionReasons: sortedObject(exclusionReasons)
  };
}

function incrementSlice(output, key, eligible) {
  const row = output[key] ??= { evaluated: 0, completionEligible: 0, excluded: 0 };
  row.evaluated += 1;
  row[eligible ? "completionEligible" : "excluded"] += 1;
}

function sortedObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right)
  ));
}

function descriptor({ path, body, rows, observedAt }) {
  return {
    path,
    format: "json",
    rows,
    bytes: Buffer.byteLength(body),
    sha256: sha256(body),
    observedAt
  };
}

async function writeImmutablePackage({ outputPath, files }) {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  await assertPathDoesNotExist(temporaryPath, "temporary outputDir");
  await mkdir(temporaryPath, { recursive: false, mode: 0o700 });
  try {
    await Promise.all(files.map(([path, body]) =>
      writeFile(resolve(temporaryPath, path), body, { mode: 0o600, flag: "wx" })
    ));
    await assertPathDoesNotExist(outputPath, "outputDir");
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { recursive: true, force: true });
    throw error;
  }
}

async function assertPathDoesNotExist(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} already exists: ${path}`);
}

function normalizeLimits({ maxJournalBytes, maxLineBytes, maxEvents }) {
  return {
    maxJournalBytes: boundedPositiveInteger(
      maxJournalBytes,
      HISTORICAL_COVERAGE_ADAPTER_LIMITS.maxJournalBytes,
      "maxJournalBytes"
    ),
    maxLineBytes: boundedPositiveInteger(
      maxLineBytes,
      HISTORICAL_COVERAGE_ADAPTER_LIMITS.maxLineBytes,
      "maxLineBytes"
    ),
    maxEvents: boundedPositiveInteger(
      maxEvents,
      HISTORICAL_COVERAGE_ADAPTER_LIMITS.maxEvents,
      "maxEvents"
    )
  };
}

function boundedPositiveInteger(value, maximum, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new TypeError(`${label} must be a positive safe integer no greater than ${maximum}.`);
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

function canonicalTimestamp(value, label) {
  const text = requiredText(value, label);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  }
  return text;
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}

function requiredSha256(value, label) {
  const text = requiredText(value, label);
  if (!SHA256.test(text)) throw new TypeError(`${label} must be a lowercase SHA-256.`);
  return text;
}

function resolveFromRoot(root, path) {
  return isAbsolute(path) ? resolve(path) : resolve(root, path);
}

function portablePath(root, path) {
  const rel = relative(root, path);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) ? rel : path;
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
