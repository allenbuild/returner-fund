import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SCORING_V4_MIGRATIONS,
  buildMigrationApplyArgs,
  extractV4Registration,
  main as migrationMain,
  parseMigrationArgs
} from "../../scripts/ops/apply-scoring-v4-migrations.mjs";
import {
  main as experimentParityMain,
  parseExperimentParityArgs,
  validateExperimentParityReport
} from "../../scripts/ops/check-scoring-v4-experiment-parity.mjs";
import {
  assertArtifactCoverage,
  buildPublicationPlan,
  main as publishMain,
  parsePublishArgs
} from "../../scripts/ops/publish-scoring-v4-artifacts.mjs";
import {
  buildRollbackInspectionSql,
  main as rollbackMain,
  parseRollbackArgs
} from "../../scripts/ops/prepare-scoring-v4-rollback.mjs";
import {
  databaseTarget,
  requireConfirmedDatabase
} from "../../scripts/ops/scoring-v4-ops-lib.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("database targets are validated and require exact redacted confirmation", () => {
  const databaseUrl = "postgresql://operator:secret@db.example.test:6543/returner";
  assert.equal(databaseTarget(databaseUrl), "db.example.test:6543/returner");
  assert.throws(() => databaseTarget("https://db.example.test/returner"), /postgres: or postgresql:/);
  assert.throws(
    () =>
      requireConfirmedDatabase({
        env: { DATABASE_URL: databaseUrl },
        envName: "DATABASE_URL",
        confirmation: "db.example.test:5432/returner"
      }),
    /confirmation mismatch/
  );
  assert.deepEqual(
    requireConfirmedDatabase({
      env: { DATABASE_URL: databaseUrl },
      envName: "DATABASE_URL",
      confirmation: "db.example.test:6543/returner"
    }),
    { databaseUrl, target: "db.example.test:6543/returner" }
  );
});

test("migration operation validates arguments and applies 004-007 in one ordered transaction", async () => {
  assert.deepEqual(SCORING_V4_MIGRATIONS.map((name) => name.slice(0, 3)), ["004", "005", "006", "007"]);
  assert.throws(() => parseMigrationArgs(["--dry-run", "--apply"]), /either/);
  assert.throws(() => parseMigrationArgs(["--database-url-env=bad-name"]), /environment variable/);
  assert.throws(() => parseMigrationArgs(["--wat"]), /Unknown migration argument/);

  const migrationPaths = SCORING_V4_MIGRATIONS.map((name) => `/repo/supabase/migrations/${name}`);
  const applyArgs = buildMigrationApplyArgs("postgresql://redacted/db", migrationPaths);
  assert.ok(applyArgs.includes("--single-transaction"));
  assert.deepEqual(
    applyArgs.filter((argument) => argument.startsWith("--file=")),
    migrationPaths.map((migrationPath) => `--file=${migrationPath}`)
  );

  const calls = [];
  let queryCount = 0;
  const commandRunner = async (command, args) => {
    calls.push({ command, args });
    if (args.some((argument) => argument.startsWith("--command="))) {
      queryCount += 1;
      return { stdout: `${queryCount === 1 ? "ready" : "verified"}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  const result = await withMutedConsole(() =>
    migrationMain(["--apply", "--confirm-target=db.example.test:5432/returner"], {
      rootDir: REPOSITORY_ROOT,
      env: { DATABASE_URL: "postgresql://operator:secret@db.example.test/returner" },
      commandRunner
    })
  );
  assert.equal(result.status, "applied-and-verified");
  assert.equal(result.migrationHistoryRecorded, false);
  assert.equal(result.backfillPerformed, false);
  const applyCall = calls.find((call) => call.args.includes("--single-transaction") && call.args.some((arg) => arg.startsWith("--file=")));
  assert.ok(applyCall);
  assert.deepEqual(
    applyCall.args.filter((argument) => argument.startsWith("--file=")).map((argument) => path.basename(argument.slice(7))),
    SCORING_V4_MIGRATIONS
  );
});

test("migration dry-run and missing environment paths execute no database command", async () => {
  let commandCalls = 0;
  const dryRun = await withMutedConsole(() =>
    migrationMain(["--dry-run"], {
      rootDir: REPOSITORY_ROOT,
      env: {},
      commandRunner: async () => {
        commandCalls += 1;
        return { stdout: "", stderr: "" };
      }
    })
  );
  assert.equal(dryRun.status, "dry-run");
  assert.equal(dryRun.databaseTarget, "unset:DATABASE_URL");
  assert.equal(commandCalls, 0);
  await assert.rejects(
    () =>
      withMutedConsole(() =>
        migrationMain(["--apply", "--confirm-target=db.example.test:5432/returner"], {
          rootDir: REPOSITORY_ROOT,
          env: {},
          commandRunner: async () => {
            commandCalls += 1;
            return { stdout: "", stderr: "" };
          }
        })
      ),
    /DATABASE_URL is required/
  );
  assert.equal(commandCalls, 0);
});

test("publisher covers nine graphs and three histories through the existing direct-Next publisher", async () => {
  assert.doesNotThrow(() => assertArtifactCoverage());
  assert.throws(() => parsePublishArgs(["--port=0"], {}), /Invalid --port/);
  assert.throws(
    () => parsePublishArgs(["--base-url=http://127.0.0.1:3100", "--port=3101"], {}),
    /either --base-url or --port/
  );
  assert.throws(() => parsePublishArgs(["--unknown"], {}), /Unknown publication argument/);

  const args = parsePublishArgs(["--dry-run", "--port=3199"], {});
  const plan = buildPublicationPlan({ rootDir: REPOSITORY_ROOT, args });
  assert.equal(plan.graphPaths.length, 9);
  assert.equal(plan.historyPaths.length, 3);
  assert.match(plan.commands.find((command) => command.label === "publish").args[0], /update-daily-benchmarks\.mjs$/);
  assert.match(plan.commands.find((command) => command.label === "validate").args[0], /validate-public-artifacts\.mjs$/);

  const dryRun = await withMutedConsole(() =>
    publishMain(["--dry-run", "--port=3199"], {
      rootDir: REPOSITORY_ROOT,
      env: {},
      commandRunner: async () => {
        throw new Error("dry-run must not execute a command");
      }
    })
  );
  assert.equal(dryRun.graphSnapshots, 9);
  assert.equal(dryRun.historyFiles, 3);
  assert.equal(dryRun.databaseBackfillPerformed, false);

  const calls = [];
  const published = await withMutedConsole(() =>
    publishMain(["--publish", "--port=3199"], {
      rootDir: REPOSITORY_ROOT,
      env: {},
      commandRunner: async (command, commandArgs) => {
        calls.push({ command, args: commandArgs });
        return { stdout: "", stderr: "" };
      }
    })
  );
  assert.equal(published.status, "published-and-validated");
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((call) => path.basename(call.args[0] ?? call.command)), [
    "status",
    "next",
    "update-daily-benchmarks.mjs",
    "validate-public-artifacts.mjs"
  ]);
});

test("rollback preparation is read-only and preserves model and history rows", async () => {
  assert.throws(() => parseRollbackArgs(["--dry-run", "--inspect"]), /either/);
  assert.throws(() => parseRollbackArgs(["--delete"]), /Unknown rollback argument/);
  const inspectionSql = buildRollbackInspectionSql({
    modelKey: "returner-traction",
    version: "4.0.0"
  });
  assert.match(inspectionSql, /set transaction read only/i);
  assert.doesNotMatch(inspectionSql, /\b(?:delete|drop|truncate|update|alter|insert)\b/i);
  const registration = extractV4Registration(
    readFileSync(
      path.join(REPOSITORY_ROOT, "supabase", "migrations", "007_register_traction_scoring_v4.sql"),
      "utf8"
    )
  );

  let capturedArgs;
  const output = await withMutedConsole(() =>
    rollbackMain(["--inspect", "--confirm-target=db.example.test:5432/returner"], {
      rootDir: REPOSITORY_ROOT,
      env: { DATABASE_URL: "postgresql://operator:secret@db.example.test/returner" },
      commandRunner: async (_command, args) => {
        capturedArgs = args;
        return {
          stdout: `${JSON.stringify({
            registrationCount: 1,
            configHash: registration.configHash,
            scoringRunCount: 4,
            completedRunCount: 3,
            companySnapshotCount: 197,
            founderSnapshotCount: 250
          })}\n`,
          stderr: ""
        };
      }
    })
  );
  assert.equal(output.status, "ready-for-external-application-rollback");
  assert.equal(output.databaseMutation, "none");
  assert.equal(output.modelRegistration, "retained");
  assert.equal(output.historicalRows, "retained");
  assert.ok(capturedArgs.includes("--single-transaction"));
  assert.match(capturedArgs.find((argument) => argument.startsWith("--command=")), /read only/i);
});

test("experiment parity gate is isolated and validates the complete parity surface", async () => {
  assert.throws(() => parseExperimentParityArgs(["--write"]), /Unknown experiment parity argument/);
  const report = {
    metadata: {
      production_config_mutated: false,
      normalization_parity_assertions: 123
    },
    cohorts: Array.from({ length: 3 }, (_, cohortIndex) => ({
      cohort: `cohort-${cohortIndex}`,
      variants: Array.from({ length: 9 }, () => ({
        perturbation_stability: { reverse_input: { exact_score_and_rank_match: true } }
      }))
    }))
  };
  assert.deepEqual(validateExperimentParityReport(report), {
    cohorts: 3,
    candidatesPerCohort: 9,
    normalizationParityAssertions: 123,
    productionConfigMutated: false
  });
  const dryRun = await withMutedConsole(() =>
    experimentParityMain(["--dry-run"], { rootDir: REPOSITORY_ROOT, env: {} })
  );
  assert.equal(dryRun.repositoryArtifactsWritten, false);
});

test("package scripts expose honest v4 operations and no false S2026 collector alias", () => {
  const packageJson = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["ingest:s2026"], undefined);
  assert.equal(
    packageJson.scripts["ingest:s26:company"],
    "node scripts/fetch-public-traction.mjs --social=company"
  );
  assert.match(packageJson.scripts["check:release"], /test:scoring:experiments:v4/);
  assert.match(packageJson.scripts["check:release"], /test:scoring:audit:v4/);
  assert.match(packageJson.scripts["check:release"], /test:cohort-coverage/);
  assert.match(packageJson.scripts["check:release"], /artifacts:manifest:validate/);
  assert.match(packageJson.scripts["test:cohort-coverage"], /cohort-coverage-audit\.node-test\.mjs/);
  assert.match(packageJson.scripts["test:cohort-coverage"], /audit-cohort-coverage\.mjs/);
  assert.match(packageJson.scripts["release:migrate:v4"], /apply-scoring-v4-migrations/);
  assert.match(packageJson.scripts["release:publish:v4"], /publish-scoring-v4-artifacts/);
  assert.match(packageJson.scripts["release:rollback:v4"], /prepare-scoring-v4-rollback/);
});

async function withMutedConsole(callback) {
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    return await callback();
  } finally {
    console.log = originalLog;
  }
}
