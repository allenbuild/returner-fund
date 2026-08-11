import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCORING_AUDIT_DETAIL_EXAMPLE_LIMIT,
  SCORING_AUDIT_MAX_BYTES,
  SCORING_AUDIT_SCHEMA_VERSION,
  applyBoundedScoringAuditRetention,
  canonicalJson,
  resolveJsonPointer,
  serializeBoundedScoringAudit,
  validateBoundedScoringAuditRetention
} from "../scripts/lib/scoring-audit-bounded-artifact.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const SCRIPT_PATH = path.join(
  REPOSITORY_ROOT,
  "scripts",
  "run-scoring-diagnostics-v4.mjs"
);
const LOADER_PATH = path.join(
  REPOSITORY_ROOT,
  "scripts",
  "lib",
  "scoring-diagnostics-ts-loader.mjs"
);
const AUDIT_PATH = path.join(
  REPOSITORY_ROOT,
  "docs",
  "outputs",
  "scoring-diagnostics-v4-audit.json"
);
const REPORT_PATH = path.join(
  REPOSITORY_ROOT,
  "docs",
  "outputs",
  "scoring-diagnostics-v4-report.md"
);
// This audit deliberately loads and rescans every scored row in all three cohorts.
// The volume publication can add tens of thousands of rows to the runtime snapshot,
// so allow the bounded watchdog to scale to a cold shared-runner execution while
// keeping the release job's own timeout as the outer safety limit.
const DIAGNOSTICS_TIMEOUT_MS = 900_000;
const TEST_TIMEOUT_MS = DIAGNOSTICS_TIMEOUT_MS + 15_000;
const GITHUB_SAFE_ARTIFACT_BYTES = 75 * 1024 * 1024;

test("bounded scoring audit retention is deterministic, diverse, and tamper-evident", () => {
  const source = retentionFixture();
  const fullFindings = structuredClone(source.cohorts[0].missing_data.findings);
  const first = structuredClone(source);
  const second = structuredClone(source);

  applyBoundedScoringAuditRetention(first, {
    exampleLimit: 4,
    artifactByteLimit: 64 * 1024
  });
  applyBoundedScoringAuditRetention(second, {
    exampleLimit: 4,
    artifactByteLimit: 64 * 1024
  });

  assert.deepEqual(first, second);
  const retention = validateBoundedScoringAuditRetention(first);
  const pointer = "/cohorts/0/missing_data/findings";
  const descriptor = retention.collections.find(
    (collection) => collection.json_pointer === pointer
  );
  assert.ok(descriptor);
  assert.equal(descriptor.total_count, fullFindings.length);
  assert.equal(descriptor.retained_count, 4);
  assert.equal(descriptor.omitted_count, fullFindings.length - 4);
  assert.equal(descriptor.full_collection_sha256, sha256(canonicalJson(fullFindings)));
  assert.ok(descriptor.retained_signature_count >= 3);
  assert.equal(first.cohorts[0].missing_data.finding_count, fullFindings.length);
  assert.equal(resolveJsonPointer(first, pointer).length, 4);
  assert.ok(retention.omitted_record_count > 0);

  const serialized = serializeBoundedScoringAudit(first);
  assert.ok(serialized.bytes <= retention.artifact_byte_limit);

  first.cohorts[0].missing_data.findings[0].evidence_id = "tampered";
  assert.throws(
    () => validateBoundedScoringAuditRetention(first),
    /retained scoring audit digest mismatch/i
  );
});

test("bounded scoring audit serializer fails closed above its declared byte ceiling", () => {
  const payload = retentionFixture();
  applyBoundedScoringAuditRetention(payload, {
    exampleLimit: 1,
    artifactByteLimit: 256
  });
  assert.throws(
    () => serializeBoundedScoringAudit(payload),
    /exceeding the release limit/i
  );
});

test(
  "scoring diagnostics v4 emits a bounded audit and preserves the full contract",
  { timeout: TEST_TIMEOUT_MS },
  (t) => {
    const before = artifactStates();
    const outputPaths = temporaryOutputPaths(t);
    const result = runDiagnostics(outputPaths);

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, commandFailure(result));
    assert.deepEqual(artifactStates(), before, "checked-in artifacts changed");

    const regenerated = readArtifacts(outputPaths);
    const audit = JSON.parse(regenerated.audit);
    const retention = validateBoundedScoringAuditRetention(audit);
    const auditBytes = Buffer.byteLength(regenerated.audit);
    assert.equal(audit.metadata.schema_version, SCORING_AUDIT_SCHEMA_VERSION);
    assert.equal(
      retention.example_limit_per_collection,
      SCORING_AUDIT_DETAIL_EXAMPLE_LIMIT
    );
    assert.equal(retention.artifact_byte_limit, SCORING_AUDIT_MAX_BYTES);
    assert.ok(auditBytes <= retention.artifact_byte_limit);
    assert.ok(auditBytes < GITHUB_SAFE_ARTIFACT_BYTES);
    assert.ok(retention.bounded_collection_count > 0);
    assert.ok(retention.omitted_record_count > 0);
    assert.match(retention.full_detail_sha256, /^[a-f0-9]{64}$/);
    assert.match(retention.collection_manifest_sha256, /^[a-f0-9]{64}$/);
    assert.equal(audit.invariants.all_passed, true);
    assert.equal(audit.invariants.violation_count, 0);
    assert.equal(audit.invariants.checks.every((check) => check.passed), true);
    assert.equal(
      audit.global_summary.cohort_scoped_evidence_rows,
      audit.global_summary.cohort_entity_evidence_rows
    );
    assert.equal(audit.global_summary.invalid_batch_scope_evidence_rows, 0);
    const cohortPartition = audit.invariants.checks.find(
      (check) => check.id === "cohort_evidence_partition_exact"
    );
    assert.equal(cohortPartition?.passed, true);
    assert.deepEqual(
      cohortPartition?.observed.cohort_evidence_rows,
      cohortPartition?.expected.cohort_evidence_rows
    );

    const versionedInputs = audit.metadata.input_hashes.versioned_scoring_inputs;
    assert.equal(versionedInputs.parameters.length, versionedInputs.parameter_count);
    assert.equal(versionedInputs.source_files.length, versionedInputs.source_file_count);
    assert.ok(
      audit.metadata.input_hashes.files.some(
        (entry) => entry.path === "scripts/lib/scoring-audit-bounded-artifact.mjs"
      )
    );
    assert.equal(
      audit.metadata.input_hashes.files.some(
        (entry) => entry.path === "public/graph/manifest.json"
      ),
      false
    );
    for (const category of ["identity", "scoring", "calibration", "confidence"]) {
      assert.ok(versionedInputs.parameter_category_hashes[category].parameter_count > 0);
      assert.match(
        versionedInputs.parameter_category_hashes[category].sha256,
        /^[a-f0-9]{64}$/
      );
    }

    for (const [cohortIndex, cohort] of audit.cohorts.entries()) {
      assert.equal(cohort.scoring.before_vs_after_by_platform.length, 9);
      assert.equal(
        cohort.eligibility_rejections.evaluated_row_count,
        cohort.input_counts.evidence_rows
      );
      assert.equal(cohort.outliers.evidence_raw_engagement.by_platform.length, 9);
      assert.equal(cohort.invariant_observations.after_ineligible_row_count, 0);
      assert.equal(
        cohort.invariant_observations.eligible_company_physical_duplicate_group_count,
        0
      );
      const eligibility = retentionDescriptor(
        retention,
        `/cohorts/${cohortIndex}/eligibility_rejections/findings`
      );
      const missing = retentionDescriptor(
        retention,
        `/cohorts/${cohortIndex}/missing_data/findings`
      );
      const removed = retentionDescriptor(
        retention,
        `/cohorts/${cohortIndex}/scoring/after_transformation/removed_rows`
      );
      assert.equal(eligibility.total_count, cohort.eligibility_rejections.rejected_row_count);
      assert.equal(missing.total_count, cohort.missing_data.finding_count);
      assert.equal(removed.total_count, cohort.scoring.after_transformation.removed_row_count);
      assert.ok(cohort.eligibility_rejections.findings.length <= SCORING_AUDIT_DETAIL_EXAMPLE_LIMIT);
      assert.ok(cohort.missing_data.findings.length <= SCORING_AUDIT_DETAIL_EXAMPLE_LIMIT);
      assert.ok(cohort.scoring.after_transformation.removed_rows.length <= SCORING_AUDIT_DETAIL_EXAMPLE_LIMIT);

      for (const [sliceIndex, slice] of cohort.scoring.before_vs_after_by_platform.entries()) {
        const changes = retentionDescriptor(
          retention,
          `/cohorts/${cohortIndex}/scoring/before_vs_after_by_platform/${sliceIndex}/before_vs_after/company_changes`
        );
        assert.equal(changes.total_count, cohort.input_counts.companies);
        assert.ok(slice.before_vs_after.company_changes.length <= SCORING_AUDIT_DETAIL_EXAMPLE_LIMIT);
      }
    }

    assert.match(regenerated.report, /Detail retention:/);
    assert.match(regenerated.report, /## Batch\/platform score and rank shifts/);
    assert.match(regenerated.report, /## Evidence outliers by platform/);
    assert.match(regenerated.report, /## Invariants/);
  }
);

test(
  "scoring diagnostics v4 exits nonzero and preserves artifacts on an input-hash violation",
  { timeout: TEST_TIMEOUT_MS },
  (t) => {
    const before = artifactStates();
    const outputPaths = temporaryOutputPaths(t);
    const result = runDiagnostics(outputPaths, [
      `--expect-input-sha256=${"0".repeat(64)}`
    ]);

    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /expected_input_envelope_sha256/
    );
    assert.deepEqual(artifactStates(), before, "checked-in artifacts changed");
    assert.equal(existsSync(outputPaths.audit), false);
    assert.equal(existsSync(outputPaths.report), false);
  }
);

function runDiagnostics(outputPaths, extraArguments = []) {
  return spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--loader",
      LOADER_PATH,
      SCRIPT_PATH,
      `--audit-output=${outputPaths.audit}`,
      `--report-output=${outputPaths.report}`,
      ...extraArguments
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      timeout: DIAGNOSTICS_TIMEOUT_MS
    }
  );
}

function readArtifacts(paths = { audit: AUDIT_PATH, report: REPORT_PATH }) {
  return {
    audit: readFileSync(paths.audit, "utf8"),
    report: readFileSync(paths.report, "utf8")
  };
}

function artifactStates(paths = { audit: AUDIT_PATH, report: REPORT_PATH }) {
  return Object.fromEntries(
    Object.entries(paths).map(([artifact, filePath]) => [
      artifact,
      {
        bytes: statSync(filePath).size,
        sha256: sha256(readFileSync(filePath))
      }
    ])
  );
}

function retentionDescriptor(retention, pointer) {
  const descriptor = retention.collections.find(
    (collection) => collection.json_pointer === pointer
  );
  assert.ok(descriptor, `missing detail-retention descriptor for ${pointer}`);
  return descriptor;
}

function retentionFixture() {
  const issues = [
    "missing_or_invalid_publication_date",
    "no_metric_values",
    "no_positive_metric_values",
    "no_positive_scoring_engagement"
  ];
  const findings = Array.from({ length: 12 }, (_, index) => ({
    audit_key: `audit-${String(index).padStart(2, "0")}`,
    evidence_id: `evidence-${index}`,
    issue: issues[index % issues.length],
    platform: index % 2 ? "x" : "linkedin",
    scored: index % 3 === 0
  }));
  const groups = Array.from({ length: 7 }, (_, groupIndex) => ({
    key: `group-${groupIndex}`,
    row_count: 6,
    owner_scope: groupIndex % 2 ? "same_company" : "cross_company",
    rows: Array.from({ length: 6 }, (_, rowIndex) => ({
      audit_key: `group-${groupIndex}-row-${rowIndex}`,
      evidence_id: `group-evidence-${groupIndex}-${rowIndex}`,
      platform: rowIndex % 2 ? "x" : "youtube"
    }))
  }));

  return {
    metadata: { schema_version: 4 },
    global_summary: { finding_count: findings.length },
    cohorts: [
      {
        cohort: "FIXTURE",
        missing_data: {
          finding_count: findings.length,
          by_issue: issues.map((issue) => ({
            key: issue,
            count: findings.filter((finding) => finding.issue === issue).length
          })),
          findings
        },
        canonical_duplicates: {
          canonical_source_urls: {
            group_count: groups.length,
            row_count: groups.reduce((sum, group) => sum + group.row_count, 0),
            groups
          }
        }
      }
    ],
    invariants: { all_passed: true, violation_count: 0, checks: [] }
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function temporaryOutputPaths(t) {
  const directory = mkdtempSync(
    path.join(tmpdir(), "returner-scoring-diagnostics-v4-")
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    audit: path.join(directory, "scoring-diagnostics-v4-audit.json"),
    report: path.join(directory, "scoring-diagnostics-v4-report.md")
  };
}

function commandFailure(result) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}
