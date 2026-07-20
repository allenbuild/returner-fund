#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STRICT_METRIC_ALLOWLIST_ROWS,
  STRICT_METRIC_EXPECTED_ALIAS_COUNTS,
  STRICT_METRIC_GRAPH_FILES,
  STRICT_METRIC_INPUT_SHA256,
  STRICT_METRIC_NORMALIZED_SOURCE_SHA256,
  STRICT_METRIC_SOURCE_FILES,
  STRICT_METRIC_SOURCE_GRAPH_DISCREPANCIES,
  formatCanonicalJson,
  normalizedSourceSemanticSha256,
  parseStrictMetricAllowlist,
  quarantineValidatedMetriclessRow,
  sha256,
  sourceRowGuardSha256,
  stableStringify,
  validateCanonicalRowGuard
} from "./lib/strict-metric-remediation.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST_FILE = "outputs/source-hunt/strict-metric-remediation-2026-07-20.md";
const AUDIT_FILE = "outputs/source-hunt/strict-metric-remediation-audit-2026-07-20.json";
const SOURCE_FILES = Object.values(STRICT_METRIC_SOURCE_FILES);
const READ_ONLY_FILES = Object.keys(STRICT_METRIC_INPUT_SHA256).filter((file) => !SOURCE_FILES.includes(file));

export async function planStrictMetricRemediation(rootDir = PROJECT_ROOT) {
  const allFiles = [ALLOWLIST_FILE, ...Object.keys(STRICT_METRIC_INPUT_SHA256)];
  const entries = await Promise.all(allFiles.map(async (relativePath) => {
    const text = await readFile(resolve(rootDir, relativePath), "utf8");
    return [relativePath, { text, sha256: sha256(text) }];
  }));
  const files = Object.fromEntries(entries);
  const specs = parseStrictMetricAllowlist(files[ALLOWLIST_FILE].text);

  for (const relativePath of READ_ONLY_FILES) {
    assert(files[relativePath].sha256 === STRICT_METRIC_INPUT_SHA256[relativePath],
      `Read-only input fingerprint drift at ${relativePath}: expected ${STRICT_METRIC_INPUT_SHA256[relativePath]}; found ${files[relativePath].sha256}.`);
  }

  const graphDocuments = Object.fromEntries(Object.entries(STRICT_METRIC_GRAPH_FILES).map(([batch, relativePath]) => [
    batch,
    parseJson(files[relativePath].text, relativePath)
  ]));

  const sourcePlans = [];
  for (const relativePath of SOURCE_FILES) {
    const document = parseJson(files[relativePath].text, relativePath);
    const sourceSpecs = specs.filter((spec) => spec.sourceFile === relativePath);
    const normalizedSha = normalizedSourceSemanticSha256(document, sourceSpecs);
    assert(normalizedSha === STRICT_METRIC_NORMALIZED_SOURCE_SHA256[relativePath],
      `Fail-closed normalized source guard drift at ${relativePath}: expected ${STRICT_METRIC_NORMALIZED_SOURCE_SHA256[relativePath]}; found ${normalizedSha}.`);

    const originalFingerprint = files[relativePath].sha256 === STRICT_METRIC_INPUT_SHA256[relativePath];
    const outputDocument = structuredClone(document);
    const quarantineIndexes = new Set();
    const quarantines = [];
    const rows = [];

    for (const spec of sourceSpecs) {
      const sourceRow = document.evidence?.[spec.evidenceIndex];
      const validation = validateCanonicalRowGuard(sourceRow, spec, {
        sourceDocument: document,
        graphDocument: graphDocuments[spec.batch]
      });
      const cleaned = validation.cleaned;
      const positiveMetricCount = Object.keys(cleaned.positiveSupportedMetrics).length;
      const metricless = positiveMetricCount === 0;
      let outputRow = cleaned.row;
      if (metricless) {
        outputRow = quarantineValidatedMetriclessRow(outputRow, {
          nativeIdentityValidated: validation.nativeIdentityValidated,
          attributionValidated: validation.attributionValidated,
          ordinal: spec.number
        });
        quarantineIndexes.add(spec.evidenceIndex);
        quarantines.push(outputRow);
      } else {
        outputDocument.evidence[spec.evidenceIndex] = outputRow;
      }
      rows.push(Object.freeze({
        number: spec.number,
        pointer: spec.pointer,
        physicalIdentity: spec.physicalIdentity,
        entityId: spec.entityId,
        metadata: cleaned.metadata,
        aliases: cleaned.aliases,
        positiveSupportedMetrics: cleaned.positiveSupportedMetrics,
        metricless,
        changed: stableStringify(sourceRow) !== stableStringify(outputRow)
      }));
    }

    if (quarantineIndexes.size > 0) {
      outputDocument.evidence = outputDocument.evidence.filter((_, index) => !quarantineIndexes.has(index));
      outputDocument.needsReview = [...(outputDocument.needsReview ?? []), ...quarantines];
    }

    const outputText = formatCanonicalJson(outputDocument);
    sourcePlans.push(Object.freeze({
      relativePath,
      sourceSpecs,
      inputText: files[relativePath].text,
      inputSha256: files[relativePath].sha256,
      outputText,
      outputSha256: sha256(outputText),
      normalizedSha256: normalizedSha,
      rowGuardSha256: sourceRowGuardSha256(document, sourceSpecs),
      originalFingerprint,
      rows,
      quarantines,
      changedRows: rows.filter((row) => row.changed).length,
      plannedMetadataMoves: rows.flatMap((row) => row.metadata).filter((move) => move.status === "moved").length,
      preservedMetadataFields: rows.flatMap((row) => row.metadata).length,
      plannedAliasNormalizations: rows.flatMap((row) => row.aliases).length
    }));
  }

  const allRows = sourcePlans.flatMap((plan) => plan.rows);
  assert(allRows.length === STRICT_METRIC_ALLOWLIST_ROWS,
    `Planned strict metric row count drift: expected ${STRICT_METRIC_ALLOWLIST_ROWS}; found ${allRows.length}.`);
  assert(new Set(allRows.map((row) => row.pointer)).size === STRICT_METRIC_ALLOWLIST_ROWS,
    "Planned strict metric rows are not unique by canonical pointer.");
  assert(new Set(allRows.map((row) => row.physicalIdentity)).size === STRICT_METRIC_ALLOWLIST_ROWS,
    "Planned strict metric rows are not unique by native physical identity.");

  return Object.freeze({
    rootDir,
    specs,
    sourcePlans,
    readOnlyFingerprints: Object.fromEntries(READ_ONLY_FILES.map((relativePath) => [relativePath, files[relativePath].sha256])),
    allRows,
    retainedRows: allRows.filter((row) => !row.metricless).length,
    quarantinedRows: allRows.filter((row) => row.metricless).length,
    changedRows: allRows.filter((row) => row.changed).length,
    plannedMetadataMoves: sourcePlans.reduce((total, plan) => total + plan.plannedMetadataMoves, 0),
    preservedMetadataFields: sourcePlans.reduce((total, plan) => total + plan.preservedMetadataFields, 0),
    plannedAliasNormalizations: sourcePlans.reduce((total, plan) => total + plan.plannedAliasNormalizations, 0)
  });
}

export async function writeStrictMetricRemediation(plan) {
  assert(plan.quarantinedRows === 0,
    `Settled strict metric remediation expected zero quarantines; planned ${plan.quarantinedRows}.`);
  for (const sourcePlan of plan.sourcePlans) {
    const current = await readFile(resolve(plan.rootDir, sourcePlan.relativePath), "utf8");
    assert(sha256(current) === sourcePlan.inputSha256,
      `Canonical source changed after planning; refusing write at ${sourcePlan.relativePath}.`);
  }
  for (const sourcePlan of plan.sourcePlans) {
    if (sourcePlan.changedRows === 0) continue;
    const destination = resolve(plan.rootDir, sourcePlan.relativePath);
    const temporary = `${destination}.strict-metric-remediation-${process.pid}.tmp`;
    await writeFile(temporary, sourcePlan.outputText, "utf8");
    await rename(temporary, destination);
  }
}

export function strictMetricAudit(plan, { mode, preWritePlan = null, auditArtifactWritten = false }) {
  const metadataBySourceKey = countBy(plan.specs.flatMap((spec) => spec.metadataKeys));
  const canonicalFiles = Object.fromEntries(plan.sourcePlans.map((sourcePlan) => [sourcePlan.relativePath, {
    expectedOriginalSha256: STRICT_METRIC_INPUT_SHA256[sourcePlan.relativePath],
    preWriteSha256: preWritePlan?.sourcePlans.find((entry) => entry.relativePath === sourcePlan.relativePath)?.inputSha256 ?? null,
    predictedRemediatedSha256: (preWritePlan?.sourcePlans.find((entry) => entry.relativePath === sourcePlan.relativePath) ?? sourcePlan).outputSha256,
    currentSha256: sourcePlan.inputSha256,
    normalizedSemanticSha256: sourcePlan.normalizedSha256,
    rowGuardSha256: sourcePlan.rowGuardSha256,
    allowlistedRows: sourcePlan.rows.length,
    changedRows: sourcePlan.changedRows
  }]));
  return {
    schemaVersion: 1,
    remediation: "strict-metric-source-only",
    allowlistArtifact: ALLOWLIST_FILE,
    mode,
    scope: {
      allowlistedRows: plan.allRows.length,
      targetedRows: plan.sourcePlans.find((entry) => entry.relativePath === STRICT_METRIC_SOURCE_FILES.targeted)?.rows.length ?? 0,
      a16zRows: plan.sourcePlans.find((entry) => entry.relativePath === STRICT_METRIC_SOURCE_FILES.a16z)?.rows.length ?? 0,
      canonicalFilesRemediated: plan.sourcePlans.filter((entry) => entry.inputSha256 !== STRICT_METRIC_INPUT_SHA256[entry.relativePath]).length,
      canonicalFilesWrittenThisRun: mode === "write" ? preWritePlan?.sourcePlans.filter((entry) => entry.changedRows > 0).length ?? 0 : 0,
      publicGraphSnapshotsWritten: 0,
      publicEvidenceWritten: false,
      auditArtifactWritten
    },
    validation: {
      nativeIdentityMatches: plan.allRows.length,
      attributionAndRosterMatches: plan.allRows.length,
      uniqueCanonicalPhysicalIdentities: plan.allRows.length,
      exactSupportedMetricGuards: plan.allRows.length,
      rowsWithPositiveSupportedMetric: plan.retainedRows,
      metriclessRows: plan.quarantinedRows,
      strictIdempotent: plan.changedRows === 0
    },
    result: {
      retainedRows: plan.retainedRows,
      quarantinedRows: plan.quarantinedRows,
      metadataFieldsPreserved: plan.preservedMetadataFields,
      metadataMovesByCanonicalSourceKey: metadataBySourceKey,
      documentedAliasOccurrencesNormalized: Object.values(STRICT_METRIC_EXPECTED_ALIAS_COUNTS).reduce((sum, count) => sum + count, 0),
      documentedAliasCounts: STRICT_METRIC_EXPECTED_ALIAS_COUNTS,
      pendingMetadataMoves: plan.plannedMetadataMoves,
      pendingAliasNormalizations: plan.plannedAliasNormalizations,
      pendingChangedRows: plan.changedRows
    },
    sourceVsGraphDiscrepancies: STRICT_METRIC_SOURCE_GRAPH_DISCREPANCIES,
    fingerprints: {
      canonicalFiles,
      readOnlyInputs: plan.readOnlyFingerprints
    }
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const supported = new Set(["--write", "--strict", "--audit"]);
  for (const argument of args) assert(supported.has(argument), `Unknown argument: ${argument}`);
  assert(!(args.has("--write") && args.has("--strict")), "--write and --strict are mutually exclusive.");

  const initialPlan = await planStrictMetricRemediation(PROJECT_ROOT);
  let finalPlan = initialPlan;
  let mode = "dry-run";
  if (args.has("--write")) {
    await writeStrictMetricRemediation(initialPlan);
    finalPlan = await planStrictMetricRemediation(PROJECT_ROOT);
    assert(finalPlan.changedRows === 0, "Post-write strict metric validation is not idempotent.");
    assert(finalPlan.quarantinedRows === 0, "Post-write strict metric validation unexpectedly quarantined rows.");
    mode = "write";
  } else if (args.has("--strict")) {
    assert(initialPlan.changedRows === 0,
      `Strict metric validation expected an idempotent canonical state; ${initialPlan.changedRows} rows still require changes.`);
    assert(initialPlan.quarantinedRows === 0,
      `Strict metric validation expected zero quarantines; found ${initialPlan.quarantinedRows}.`);
    mode = "strict-validation";
  }

  const audit = strictMetricAudit(finalPlan, {
    mode,
    preWritePlan: args.has("--write") ? initialPlan : null,
    auditArtifactWritten: args.has("--audit")
  });
  if (args.has("--audit")) {
    await writeFile(resolve(PROJECT_ROOT, AUDIT_FILE), formatCanonicalJson(audit), "utf8");
  }
  process.stdout.write(formatCanonicalJson(audit));
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Malformed JSON at ${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
