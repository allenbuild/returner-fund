import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
// GitHub's shared runners take roughly twice as long as a warm local run, so keep a
// bounded three-minute watchdog instead of the previous 55-second flaky threshold.
const DIAGNOSTICS_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = DIAGNOSTICS_TIMEOUT_MS + 15_000;

test(
  "scoring diagnostics v4 regenerates byte-for-byte and records the full contract",
  { timeout: TEST_TIMEOUT_MS },
  (t) => {
    const before = readArtifacts();
    const outputPaths = temporaryOutputPaths(t);
    const result = runDiagnostics(outputPaths);

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, commandFailure(result));
    assertArtifactsEqual(readArtifacts(), before, "checked-in artifacts changed");

    const regenerated = readArtifacts(outputPaths);
    assertArtifactsEqual(regenerated, before, "regenerated artifacts differ");

    const audit = JSON.parse(regenerated.audit);
    assert.equal(audit.invariants.all_passed, true);
    assert.equal(audit.invariants.violation_count, 0);
    assert.equal(audit.invariants.checks.every((check) => check.passed), true);

    const versionedInputs = audit.metadata.input_hashes.versioned_scoring_inputs;
    assert.equal(versionedInputs.parameters.length, versionedInputs.parameter_count);
    assert.equal(versionedInputs.source_files.length, versionedInputs.source_file_count);
    for (const category of ["identity", "scoring", "calibration", "confidence"]) {
      assert.ok(versionedInputs.parameter_category_hashes[category].parameter_count > 0);
      assert.match(
        versionedInputs.parameter_category_hashes[category].sha256,
        /^[a-f0-9]{64}$/
      );
    }

    for (const cohort of audit.cohorts) {
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
      for (const slice of cohort.scoring.before_vs_after_by_platform) {
        assert.equal(
          slice.before_vs_after.company_changes.length,
          cohort.input_counts.companies
        );
      }
    }

    assert.match(regenerated.report, /## Batch\/platform score and rank shifts/);
    assert.match(regenerated.report, /## Evidence outliers by platform/);
    assert.match(regenerated.report, /## Invariants/);
  }
);

test(
  "scoring diagnostics v4 exits nonzero and preserves artifacts on an input-hash violation",
  { timeout: TEST_TIMEOUT_MS },
  (t) => {
    const before = readArtifacts();
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
    assertArtifactsEqual(readArtifacts(), before, "checked-in artifacts changed");
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

function assertArtifactsEqual(actual, expected, message) {
  for (const artifact of ["audit", "report"]) {
    assert.ok(
      actual[artifact] === expected[artifact],
      `${message}: ${artifact} SHA-256 expected ${sha256(expected[artifact])}, received ${sha256(actual[artifact])}`
    );
  }
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
