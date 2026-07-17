import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractV4Registration } from "./apply-scoring-v4-migrations.mjs";
import {
  assertDatabaseEnvName,
  databaseTarget,
  lastOutputLine,
  requireConfirmedDatabase,
  runCommand
} from "./scoring-v4-ops-lib.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function parseRollbackArgs(rawArgs) {
  const parsed = {
    mode: "dry-run",
    databaseUrlEnv: "DATABASE_URL",
    confirmTarget: undefined,
    psql: "psql",
    explicitMode: undefined
  };

  for (const argument of rawArgs) {
    if (argument === "--dry-run" || argument === "--inspect") {
      const requestedMode = argument === "--inspect" ? "inspect" : "dry-run";
      if (parsed.explicitMode && parsed.explicitMode !== requestedMode) {
        throw new Error("Choose either --dry-run or --inspect.");
      }
      parsed.mode = requestedMode;
      parsed.explicitMode = requestedMode;
      continue;
    }
    if (argument.startsWith("--database-url-env=")) {
      parsed.databaseUrlEnv = assertDatabaseEnvName(argument.slice("--database-url-env=".length));
      continue;
    }
    if (argument.startsWith("--confirm-target=")) {
      parsed.confirmTarget = argument.slice("--confirm-target=".length);
      if (!parsed.confirmTarget) throw new Error("--confirm-target cannot be empty.");
      continue;
    }
    if (argument.startsWith("--psql=")) {
      parsed.psql = argument.slice("--psql=".length);
      if (!parsed.psql) throw new Error("--psql cannot be empty.");
      continue;
    }
    throw new Error(`Unknown rollback argument: ${argument}`);
  }
  return parsed;
}

export function buildRollbackInspectionSql({ modelKey, version }) {
  return `
set transaction read only;
with target_model as (
  select id, config_hash
  from public.scoring_model_versions
  where model_key = ${sqlLiteral(modelKey)} and version = ${sqlLiteral(version)}
)
select json_build_object(
  'registrationCount', (select count(*)::integer from target_model),
  'configHash', (select config_hash from target_model limit 1),
  'scoringRunCount', (
    select count(*)::integer
    from public.scoring_runs run
    where run.scoring_model_version_id in (select id from target_model)
  ),
  'completedRunCount', (
    select count(*)::integer
    from public.scoring_runs run
    where run.scoring_model_version_id in (select id from target_model)
      and run.status = 'completed'
  ),
  'companySnapshotCount', (
    select count(*)::integer
    from public.traction_snapshots snapshot
    join public.scoring_runs run on run.id = snapshot.scoring_run_id
    where run.scoring_model_version_id in (select id from target_model)
  ),
  'founderSnapshotCount', (
    select count(*)::integer
    from public.founder_traction_snapshots snapshot
    join public.scoring_runs run on run.id = snapshot.scoring_run_id
    where run.scoring_model_version_id in (select id from target_model)
  )
);
`;
}

export async function main(
  rawArgs = process.argv.slice(2),
  { rootDir = REPOSITORY_ROOT, env = process.env, commandRunner = runCommand } = {}
) {
  const args = parseRollbackArgs(rawArgs);
  const migrationPath = path.join(
    rootDir,
    "supabase",
    "migrations",
    "007_register_traction_scoring_v4.sql"
  );
  const registration = extractV4Registration(await readFile(migrationPath, "utf8"));
  const configuredUrl = env[args.databaseUrlEnv];
  const target = configuredUrl ? databaseTarget(configuredUrl) : null;
  const common = {
    operation: "schema-forward application rollback preparation",
    model: `${registration.modelKey}@${registration.version}`,
    databaseMutation: "none",
    modelRegistration: "retained",
    historicalRows: "retained",
    requiredExternalActions: [
      "stop any v4 writers",
      "deploy the reviewed prior application/read path"
    ],
    limitation: "the current schema has no active-model flag, so this command cannot switch application scoring behavior"
  };

  if (args.mode === "dry-run") {
    const result = {
      status: "dry-run",
      databaseTarget: target ?? `unset:${args.databaseUrlEnv}`,
      ...common
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  const confirmed = requireConfirmedDatabase({
    env,
    envName: args.databaseUrlEnv,
    confirmation: args.confirmTarget
  });
  const result = await commandRunner(
    args.psql,
    [
      "--no-psqlrc",
      "--set=ON_ERROR_STOP=1",
      `--dbname=${confirmed.databaseUrl}`,
      "--single-transaction",
      "--quiet",
      "--tuples-only",
      "--no-align",
      `--command=${buildRollbackInspectionSql(registration)}`
    ],
    { cwd: rootDir, env, capture: true }
  );
  const inspection = parseInspection(lastOutputLine(result.stdout));
  if (inspection.registrationCount !== 1 || inspection.configHash !== registration.configHash) {
    throw new Error("Canonical v4 registration is missing or has config drift; rollback inspection stopped.");
  }

  const output = {
    status: "ready-for-external-application-rollback",
    databaseTarget: confirmed.target,
    ...common,
    observedHistoricalRows: {
      scoringRuns: inspection.scoringRunCount,
      completedRuns: inspection.completedRunCount,
      companySnapshots: inspection.companySnapshotCount,
      founderSnapshots: inspection.founderSnapshotCount
    }
  };
  console.log(JSON.stringify(output, null, 2));
  return output;
}

function parseInspection(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Rollback inspection did not return valid JSON.");
  }
  const countFields = [
    "registrationCount",
    "scoringRunCount",
    "completedRunCount",
    "companySnapshotCount",
    "founderSnapshotCount"
  ];
  if (countFields.some((field) => !Number.isInteger(parsed[field]) || parsed[field] < 0)) {
    throw new Error("Rollback inspection returned invalid historical row counts.");
  }
  return parsed;
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
