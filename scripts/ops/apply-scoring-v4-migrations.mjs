import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDatabaseEnvName,
  databaseTarget,
  formatCommand,
  lastOutputLine,
  requireConfirmedDatabase,
  runCommand
} from "./scoring-v4-ops-lib.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const SCORING_V4_MIGRATIONS = Object.freeze([
  "004_traction_scoring_evidence_lineage.sql",
  "005_harden_public_table_access.sql",
  "006_add_tiktok_bluesky_platforms.sql",
  "007_register_traction_scoring_v4.sql"
]);

export const MIGRATION_PREFLIGHT_SQL = `
select case
  when to_regclass('public.batches') is null
    or to_regclass('public.social_accounts') is null
    or to_regclass('public.posts') is null
    or to_regclass('public.scoring_runs') is null
    or to_regclass('public.ingestion_tasks') is null
    or to_regclass('public.source_failures') is null
    or to_regclass('public.platform_coverage') is null
    or to_regclass('public.discovery_attempts') is null
    or to_regclass('public.source_discovery_paths') is null
    then 'missing_base_schema'
  when to_regclass('public.scoring_model_versions') is not null
    then 'v4_schema_present'
  when not exists (select 1 from pg_roles where rolname = 'anon')
    or not exists (select 1 from pg_roles where rolname = 'authenticated')
    or not exists (select 1 from pg_roles where rolname = 'service_role')
    then 'missing_supabase_roles'
  else 'ready'
end;
`;

export function parseMigrationArgs(rawArgs) {
  const parsed = {
    mode: "dry-run",
    databaseUrlEnv: "DATABASE_URL",
    confirmTarget: undefined,
    psql: "psql",
    explicitMode: undefined
  };

  for (const argument of rawArgs) {
    if (argument === "--dry-run" || argument === "--apply") {
      const requestedMode = argument === "--apply" ? "apply" : "dry-run";
      if (parsed.explicitMode && parsed.explicitMode !== requestedMode) {
        throw new Error("Choose either --dry-run or --apply.");
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
    throw new Error(`Unknown migration argument: ${argument}`);
  }

  return parsed;
}

export function buildMigrationApplyArgs(databaseUrl, migrationPaths) {
  return [
    "--no-psqlrc",
    "--set=ON_ERROR_STOP=1",
    `--dbname=${databaseUrl}`,
    "--single-transaction",
    ...migrationPaths.flatMap((migrationPath) => [`--file=${migrationPath}`])
  ];
}

export async function main(
  rawArgs = process.argv.slice(2),
  { rootDir = REPOSITORY_ROOT, env = process.env, commandRunner = runCommand } = {}
) {
  const args = parseMigrationArgs(rawArgs);
  const migrationPaths = SCORING_V4_MIGRATIONS.map((fileName) =>
    path.join(rootDir, "supabase", "migrations", fileName)
  );
  await Promise.all(migrationPaths.map((migrationPath) => access(migrationPath)));
  const registration = extractV4Registration(
    await readFile(migrationPaths.at(-1), "utf8")
  );
  const configuredUrl = env[args.databaseUrlEnv];
  const target = configuredUrl ? databaseTarget(configuredUrl) : null;
  const displayArgs = buildMigrationApplyArgs(`<${args.databaseUrlEnv}>`, migrationPaths);

  if (args.mode === "dry-run") {
    const result = {
      status: "dry-run",
      databaseTarget: target ?? `unset:${args.databaseUrlEnv}`,
      migrations: SCORING_V4_MIGRATIONS,
      transaction: "all_four_files_single_transaction",
      command: formatCommand(args.psql, displayArgs),
      precondition: "target must have migrations 001-003 and no migration-004 schema objects",
      migrationHistoryRecorded: false,
      backfillPerformed: false
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  const confirmed = requireConfirmedDatabase({
    env,
    envName: args.databaseUrlEnv,
    confirmation: args.confirmTarget
  });
  await commandRunner(args.psql, ["--version"], { cwd: rootDir, env, capture: true });

  const preflight = await runPsqlQuery({
    commandRunner,
    psql: args.psql,
    databaseUrl: confirmed.databaseUrl,
    sql: MIGRATION_PREFLIGHT_SQL,
    cwd: rootDir,
    env
  });
  if (preflight !== "ready") {
    throw new Error(preflightFailure(preflight));
  }

  await commandRunner(args.psql, buildMigrationApplyArgs(confirmed.databaseUrl, migrationPaths), {
    cwd: rootDir,
    env
  });

  const verification = await runPsqlQuery({
    commandRunner,
    psql: args.psql,
    databaseUrl: confirmed.databaseUrl,
    sql: buildMigrationVerificationSql(registration),
    cwd: rootDir,
    env
  });
  if (verification !== "verified") {
    throw new Error("Migrations ran, but post-apply scoring-v4 verification failed.");
  }

  const result = {
    status: "applied-and-verified",
    databaseTarget: confirmed.target,
    migrations: SCORING_V4_MIGRATIONS,
    model: `${registration.modelKey}@${registration.version}`,
    configHash: registration.configHash,
    migrationHistoryRecorded: false,
    backfillPerformed: false
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

export function extractV4Registration(sql) {
  return {
    modelKey: extractTextConstant(sql, "v4_model_key"),
    version: extractTextConstant(sql, "v4_version"),
    configHash: extractTextConstant(sql, "v4_config_hash")
  };
}

export function buildMigrationVerificationSql({ modelKey, version, configHash }) {
  return `
select case when
  to_regclass('public.evidence_items') is not null
  and to_regclass('public.metric_observations') is not null
  and to_regclass('public.scoring_model_versions') is not null
  and to_regclass('public.scoring_runs_model_batch_as_of_idx') is not null
  and exists (
    select 1 from public.scoring_model_versions
    where model_key = ${sqlLiteral(modelKey)}
      and version = ${sqlLiteral(version)}
      and config_hash = ${sqlLiteral(configHash)}
  )
  then 'verified'
  else 'verification_failed'
end;
`;
}

async function runPsqlQuery({ commandRunner, psql, databaseUrl, sql, cwd, env }) {
  const result = await commandRunner(
    psql,
    [
      "--no-psqlrc",
      "--set=ON_ERROR_STOP=1",
      `--dbname=${databaseUrl}`,
      "--quiet",
      "--tuples-only",
      "--no-align",
      `--command=${sql}`
    ],
    { cwd, env, capture: true }
  );
  return lastOutputLine(result.stdout);
}

function extractTextConstant(sql, name) {
  const match = sql.match(new RegExp(`${name}\\s+constant\\s+text\\s*:=\\s*'([^']+)'`, "i"));
  if (!match?.[1]) throw new Error(`Migration 007 does not contain ${name}.`);
  return match[1];
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function preflightFailure(status) {
  if (status === "missing_base_schema") {
    return "Database is not verified through migrations 001-003; refusing to apply 004-007.";
  }
  if (status === "v4_schema_present") {
    return "Migration-004 schema objects already exist; refusing to replay non-idempotent migration 004.";
  }
  if (status === "missing_supabase_roles") {
    return "Required Supabase roles are missing; migration 005 cannot be applied safely.";
  }
  return `Unexpected migration preflight result: ${status ?? "no output"}`;
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
