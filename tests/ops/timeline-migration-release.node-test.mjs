import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  TIMELINE_DATA_PREFLIGHT_SQL,
  TIMELINE_MIGRATION_HISTORY_MASK_SQL,
  TIMELINE_MIGRATION_PREFLIGHT_SQL,
  TIMELINE_MIGRATION_VERIFICATION_SQL,
  TIMELINE_MIGRATIONS,
  buildSupabaseHistoryRepairArgs,
  buildTimelineMigrationApplyArgs,
  main as migrationMain,
  parseTimelineMigrationArgs,
  pendingTimelineMigrations,
} from "../../scripts/ops/apply-timeline-migrations.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATABASE_URL = "postgresql://operator:secret@db.example.test/returner";
const CONFIRM_TARGET = "db.example.test:5432/returner";

test("Timeline release arguments and contiguous migration tails fail closed", () => {
  assert.deepEqual(TIMELINE_MIGRATIONS.map((name) => name.slice(0, 3)), ["017", "018", "019", "020"]);
  assert.throws(
    () => parseTimelineMigrationArgs(["--apply", "--verify-only"]),
    /exactly one/,
  );
  assert.throws(
    () => parseTimelineMigrationArgs(["--database-url-env=bad-name"]),
    /environment variable/,
  );
  assert.throws(() => parseTimelineMigrationArgs(["--unknown"]), /Unknown Timeline/);
  assert.deepEqual(pendingTimelineMigrations("ready_017"), TIMELINE_MIGRATIONS);
  assert.deepEqual(pendingTimelineMigrations("ready_019"), TIMELINE_MIGRATIONS.slice(2));
  assert.deepEqual(pendingTimelineMigrations("ready_020"), [TIMELINE_MIGRATIONS[3]]);
  assert.deepEqual(pendingTimelineMigrations("applied"), []);
  assert.throws(
    () => pendingTimelineMigrations("inconsistent_partial_timeline_schema"),
    /partially applied/,
  );
});

test("dry-run is offline, redacts the URL, and does not imply migration-history writes", async () => {
  let calls = 0;
  const result = await withMutedConsole(() =>
    migrationMain(["--dry-run"], {
      rootDir: REPOSITORY_ROOT,
      env: { DATABASE_URL },
      commandRunner: async () => {
        calls += 1;
        throw new Error("dry-run must not execute psql");
      },
    })
  );
  assert.equal(calls, 0);
  assert.equal(result.status, "dry-run");
  assert.equal(result.preflightOutput, "aggregate_counts_only");
  assert.equal(result.migrationHistoryRecorded, "reconciled_after_verified_apply_before_success");
  assert.doesNotMatch(result.command, /operator:secret/);
  assert.match(result.command, /<DATABASE_URL>/);
});

test("apply selects only the pending tail, runs aggregate preflight, and verifies", async () => {
  const calls = [];
  let historyQueries = 0;
  const commandRunner = async (command, args) => {
    calls.push({ command, args });
    const sql = args.find((argument) => argument.startsWith("--command="))?.slice(10);
    if (!sql) return { stdout: "", stderr: "" };
    if (sql === TIMELINE_MIGRATION_PREFLIGHT_SQL) {
      return { stdout: "ready_020\n", stderr: "" };
    }
    if (sql === TIMELINE_DATA_PREFLIGHT_SQL) {
      return { stdout: "primary=0;evidence=0;posts=0\n", stderr: "" };
    }
    if (sql === TIMELINE_MIGRATION_HISTORY_MASK_SQL) {
      historyQueries += 1;
      return { stdout: `${historyQueries === 1 ? "1110" : "1111"}\n`, stderr: "" };
    }
    if (sql === TIMELINE_MIGRATION_VERIFICATION_SQL) {
      return { stdout: "verified\n", stderr: "" };
    }
    throw new Error("unexpected SQL query");
  };

  const result = await withMutedConsole(() =>
    migrationMain(["--apply", `--confirm-target=${CONFIRM_TARGET}`], {
      rootDir: REPOSITORY_ROOT,
      env: { DATABASE_URL },
      commandRunner,
    })
  );
  assert.equal(result.status, "applied-and-verified");
  assert.deepEqual(result.migrationsApplied, ["020_timeline_entity_attribution_invariants.sql"]);
  assert.equal(result.preflightDataCounts, "primary=0;evidence=0;posts=0");
  assert.equal(result.migrationHistoryRecorded, true);

  const applyCall = calls.find((call) => call.args.includes("--single-transaction"));
  assert.ok(applyCall);
  assert.deepEqual(
    applyCall.args
      .filter((argument) => argument.startsWith("--file="))
      .map((argument) => path.basename(argument.slice(7))),
    ["020_timeline_entity_attribution_invariants.sql"],
  );
  const repairCall = calls.find((call) => call.args.includes("repair"));
  assert.ok(repairCall);
  assert.deepEqual(repairCall.args.slice(-1), ["020"]);
});

test("dirty legacy attribution aborts before any migration file executes", async () => {
  const calls = [];
  await assert.rejects(
    () => withMutedConsole(() =>
      migrationMain(["--apply", `--confirm-target=${CONFIRM_TARGET}`], {
        rootDir: REPOSITORY_ROOT,
        env: { DATABASE_URL },
        commandRunner: async (command, args) => {
          calls.push({ command, args });
          const sql = args.find((argument) => argument.startsWith("--command="))?.slice(10);
          if (sql === TIMELINE_MIGRATION_PREFLIGHT_SQL) {
            return { stdout: "ready_020\n", stderr: "" };
          }
          if (sql === TIMELINE_DATA_PREFLIGHT_SQL) {
            return { stdout: "primary=2;evidence=1;posts=0\n", stderr: "" };
          }
          if (sql === TIMELINE_MIGRATION_HISTORY_MASK_SQL) {
            return { stdout: "1110\n", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        },
      })
    ),
    /primary=2;evidence=1;posts=0/,
  );
  assert.equal(calls.some((call) => call.args.includes("--single-transaction")), false);
});

test("verify-only is a non-mutating production check", async () => {
  const calls = [];
  const result = await withMutedConsole(() =>
    migrationMain(["--verify-only", `--confirm-target=${CONFIRM_TARGET}`], {
      rootDir: REPOSITORY_ROOT,
      env: { DATABASE_URL },
      commandRunner: async (command, args) => {
        calls.push({ command, args });
        const sql = args.find((argument) => argument.startsWith("--command="))?.slice(10);
        if (sql === TIMELINE_MIGRATION_PREFLIGHT_SQL) {
          return { stdout: "applied\n", stderr: "" };
        }
        if (sql === TIMELINE_DATA_PREFLIGHT_SQL) {
          return { stdout: "primary=0;evidence=0;posts=0\n", stderr: "" };
        }
        if (sql === TIMELINE_MIGRATION_HISTORY_MASK_SQL) {
          return { stdout: "1111\n", stderr: "" };
        }
        if (sql === TIMELINE_MIGRATION_VERIFICATION_SQL) {
          return { stdout: "verified\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
    })
  );
  assert.equal(result.status, "already-applied-and-verified");
  assert.deepEqual(result.migrationsApplied, []);
  assert.equal(calls.some((call) => call.args.includes("--single-transaction")), false);
});

test("preflight and migration lock cover every cross-table invariant surface", () => {
  const normalizedPreflight = TIMELINE_MIGRATION_PREFLIGHT_SQL.replace(/\s+/g, " ").toLowerCase();
  const normalizedData = TIMELINE_DATA_PREFLIGHT_SQL.replace(/\s+/g, " ").toLowerCase();
  const normalizedVerification = TIMELINE_MIGRATION_VERIFICATION_SQL.replace(/\s+/g, " ").toLowerCase();
  assert.match(normalizedPreflight, /inconsistent_partial_timeline_schema/);
  assert.match(normalizedData, /'primary=%s;evidence=%s;posts=%s'.*count\(\*\)/);
  assert.match(normalizedData, /relationship_type = 'subject'/);
  assert.match(normalizedData, /review_state = 'verified'/);
  assert.match(normalizedVerification, /not has_function_privilege.*'anon'/);
  assert.match(normalizedVerification, /has_function_privilege.*'service_role'/);

  const migration = readFileSync(
    path.join(REPOSITORY_ROOT, "supabase/migrations/020_timeline_entity_attribution_invariants.sql"),
    "utf8",
  ).replace(/\s+/g, " ").toLowerCase();
  assert.match(
    migration,
    /lock table public\.timeline_events, public\.timeline_event_entities, public\.timeline_event_evidence, public\.source_documents, public\.source_document_entities, public\.timeline_event_posts, public\.evidence_attributions in share row exclusive mode/,
  );
});

test("psql apply uses one transaction and ON_ERROR_STOP", () => {
  const paths = TIMELINE_MIGRATIONS.map((name) => `/repo/supabase/migrations/${name}`);
  const args = buildTimelineMigrationApplyArgs("postgresql://redacted/db", paths);
  assert.ok(args.includes("--single-transaction"));
  assert.ok(args.includes("--set=ON_ERROR_STOP=1"));
  assert.deepEqual(
    args.filter((argument) => argument.startsWith("--file=")),
    paths.map((migrationPath) => `--file=${migrationPath}`),
  );
  assert.deepEqual(
    buildSupabaseHistoryRepairArgs("postgresql://redacted/db", ["019", "020"]).slice(-2),
    ["019", "020"],
  );
});

async function withMutedConsole(callback) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await callback();
  } finally {
    console.log = originalLog;
  }
}
