import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDatabaseEnvName,
  databaseTarget,
  formatCommand,
  lastOutputLine,
  requireConfirmedDatabase,
  runCommand,
} from "./scoring-v4-ops-lib.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const TIMELINE_MIGRATIONS = Object.freeze([
  "017_company_timeline.sql",
  "018_atomic_timeline_admin_actions.sql",
  "019_timeline_verified_post_links.sql",
  "020_timeline_entity_attribution_invariants.sql",
]);
const TIMELINE_MIGRATION_VERSIONS = Object.freeze(
  TIMELINE_MIGRATIONS.map((fileName) => fileName.slice(0, 3)),
);

export const TIMELINE_MIGRATION_PREFLIGHT_SQL = `
with migration_state as (
  select
    to_regclass('public.companies') is not null
      and to_regclass('public.founders') is not null
      and to_regclass('public.evidence_items') is not null
      and to_regclass('public.evidence_attributions') is not null
      and to_regclass('public.ingestion_tasks') is not null
      and to_regprocedure('public.set_updated_at()') is not null as base_complete,
    exists (select 1 from pg_roles where rolname = 'anon')
      and exists (select 1 from pg_roles where rolname = 'authenticated')
      and exists (select 1 from pg_roles where rolname = 'service_role') as roles_complete,
    to_regclass('supabase_migrations.schema_migrations') is not null as history_available,
    num_nonnulls(
      to_regclass('public.source_documents'),
      to_regclass('public.source_document_entities'),
      to_regclass('public.timeline_events'),
      to_regclass('public.timeline_event_entities'),
      to_regclass('public.timeline_event_evidence'),
      to_regclass('public.timeline_event_posts'),
      to_regclass('public.timeline_event_candidates'),
      to_regclass('public.timeline_candidate_sources'),
      to_regclass('public.timeline_company_state'),
      to_regclass('public.timeline_source_coverage'),
      to_regclass('public.timeline_event_audit_log'),
      to_regclass('public.timeline_artifact_invalidations')
    ) as migration_017_markers,
    num_nonnulls(
      to_regprocedure('public.apply_timeline_admin_action(text,jsonb,jsonb)'),
      to_regprocedure('public.claim_timeline_admin_tasks(text,integer,interval,text)'),
      to_regclass('public.ingestion_tasks_timeline_admin_claimable_idx')
    ) as migration_018_markers,
    num_nonnulls(
      to_regclass('public.published_timeline_post_metadata'),
      to_regprocedure('public.assert_timeline_event_post_company_attribution(uuid,uuid)')
    ) as migration_019_markers,
    num_nonnulls(
      to_regprocedure('public.reassign_timeline_event_primary_company(uuid,uuid)'),
      to_regclass('public.timeline_event_entities_one_primary_idx')
    )
      + (select count(*) from pg_trigger where not tgisinternal and tgname in (
          'timeline_event_evidence_company_subject_guard',
          'timeline_event_entities_primary_company_guard',
          'timeline_events_seed_primary_entity',
          'timeline_events_primary_entity_required'
        )) as migration_020_markers
)
select case
  when not base_complete then 'missing_base_schema'
  when not roles_complete then 'missing_supabase_roles'
  when not history_available then 'missing_migration_history'
  when migration_017_markers not in (0, 12)
    or migration_018_markers not in (0, 3)
    or migration_019_markers not in (0, 2)
    or migration_020_markers not in (0, 6)
    then 'inconsistent_partial_timeline_schema'
  when migration_020_markers = 6
    and migration_017_markers = 12
    and migration_018_markers = 3
    and migration_019_markers = 2
    then 'applied'
  when migration_020_markers <> 0 then 'inconsistent_partial_timeline_schema'
  when migration_019_markers = 2
    and migration_018_markers = 3
    and migration_017_markers = 12
    then 'ready_020'
  when migration_019_markers <> 0 then 'inconsistent_partial_timeline_schema'
  when migration_018_markers = 3 and migration_017_markers = 12 then 'ready_019'
  when migration_018_markers <> 0 then 'inconsistent_partial_timeline_schema'
  when migration_017_markers = 12 then 'ready_018'
  when migration_017_markers = 0 then 'ready_017'
  else 'inconsistent_partial_timeline_schema'
end
from migration_state;
`;

export const TIMELINE_MIGRATION_HISTORY_MASK_SQL = `
select concat(
  case when exists (
    select 1 from supabase_migrations.schema_migrations where version = '017'
  ) then '1' else '0' end,
  case when exists (
    select 1 from supabase_migrations.schema_migrations where version = '018'
  ) then '1' else '0' end,
  case when exists (
    select 1 from supabase_migrations.schema_migrations where version = '019'
  ) then '1' else '0' end,
  case when exists (
    select 1 from supabase_migrations.schema_migrations where version = '020'
  ) then '1' else '0' end
);
`;

// This intentionally returns aggregate counts only. Operators can remediate
// separately without leaking company/event/source rows into CI or shell logs.
export const TIMELINE_DATA_PREFLIGHT_SQL = `
select format(
  'primary=%s;evidence=%s;posts=%s',
  (
    select count(*)
    from (
      select event.id
      from public.timeline_events as event
      left join public.timeline_event_entities as entity on entity.event_id = event.id
      group by event.id, event.primary_company_id
      having count(entity.id) filter (where entity.is_primary) <> 1
        or count(entity.id) filter (
          where entity.is_primary
            and entity.entity_type = 'company'
            and entity.company_id = event.primary_company_id
            and entity.founder_id is null
            and entity.external_entity_name is null
            and entity.relationship_type = 'subject'
        ) <> 1
    ) as invalid_primary
  ),
  (
    select count(*)
    from public.timeline_event_evidence as evidence
    join public.timeline_events as event on event.id = evidence.event_id
    where not exists (
      select 1
      from public.source_document_entities as subject
      where subject.source_document_id = evidence.source_document_id
        and subject.company_id = event.primary_company_id
        and subject.founder_id is null
        and subject.relationship_type = 'subject'
    )
  ),
  (
    select count(*)
    from public.timeline_event_posts as post
    join public.timeline_events as event on event.id = post.event_id
    where not exists (
      select 1
      from public.evidence_attributions as attribution
      where attribution.evidence_id = post.evidence_id
        and attribution.company_id = event.primary_company_id
        and attribution.entity_type = 'company'
        and attribution.review_state = 'verified'
    )
  )
);
`;

export const TIMELINE_MIGRATION_VERIFICATION_SQL = `
select case when
  to_regprocedure('public.reassign_timeline_event_primary_company(uuid,uuid)') is not null
  and to_regprocedure('public.timeline_event_has_publishable_company_evidence(uuid,uuid,text,text,date,text)') is not null
  and to_regclass('public.timeline_event_entities_one_primary_idx') is not null
  and (
    select count(*)
    from pg_trigger
    where not tgisinternal
      and tgenabled <> 'D'
      and tgname in (
        'timeline_event_evidence_company_subject_guard',
        'timeline_event_entities_primary_company_guard',
        'timeline_events_seed_primary_entity',
        'timeline_events_primary_entity_required',
        'timeline_events_primary_company_attribution_guard',
        'timeline_events_publication_guard'
      )
  ) = 6
  and not has_function_privilege(
    'anon',
    'public.reassign_timeline_event_primary_company(uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.reassign_timeline_event_primary_company(uuid,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.reassign_timeline_event_primary_company(uuid,uuid)',
    'EXECUTE'
  )
  and (${TIMELINE_DATA_PREFLIGHT_SQL.trim().replace(/;$/, "")}) = 'primary=0;evidence=0;posts=0'
then 'verified'
else 'verification_failed'
end;
`;

const PREFLIGHT_TO_FIRST_MIGRATION = Object.freeze({
  ready_017: 0,
  ready_018: 1,
  ready_019: 2,
  ready_020: 3,
});

export function parseTimelineMigrationArgs(rawArgs) {
  const parsed = {
    mode: "dry-run",
    databaseUrlEnv: "DATABASE_URL",
    confirmTarget: undefined,
    psql: "psql",
    supabase: "supabase",
    explicitMode: undefined,
  };

  for (const argument of rawArgs) {
    if (["--dry-run", "--apply", "--verify-only"].includes(argument)) {
      const requestedMode = argument.slice(2);
      if (parsed.explicitMode && parsed.explicitMode !== requestedMode) {
        throw new Error("Choose exactly one of --dry-run, --apply, or --verify-only.");
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
    if (argument.startsWith("--supabase=")) {
      parsed.supabase = argument.slice("--supabase=".length);
      if (!parsed.supabase) throw new Error("--supabase cannot be empty.");
      continue;
    }
    throw new Error(`Unknown Timeline migration argument: ${argument}`);
  }
  return parsed;
}

export function pendingTimelineMigrations(preflightStatus) {
  if (preflightStatus === "applied") return [];
  const firstIndex = PREFLIGHT_TO_FIRST_MIGRATION[preflightStatus];
  if (firstIndex === undefined) {
    throw new Error(preflightFailure(preflightStatus));
  }
  return TIMELINE_MIGRATIONS.slice(firstIndex);
}

export function buildTimelineMigrationApplyArgs(databaseUrl, migrationPaths) {
  return [
    "--no-psqlrc",
    "--set=ON_ERROR_STOP=1",
    `--dbname=${databaseUrl}`,
    "--single-transaction",
    ...migrationPaths.flatMap((migrationPath) => [`--file=${migrationPath}`]),
  ];
}

export function buildSupabaseHistoryRepairArgs(databaseUrl, versions) {
  return [
    "migration",
    "repair",
    "--status",
    "applied",
    `--db-url=${databaseUrl}`,
    "--yes",
    ...versions,
  ];
}

export async function main(
  rawArgs = process.argv.slice(2),
  { rootDir = REPOSITORY_ROOT, env = process.env, commandRunner = runCommand } = {},
) {
  const args = parseTimelineMigrationArgs(rawArgs);
  const migrationPaths = TIMELINE_MIGRATIONS.map((fileName) =>
    path.join(rootDir, "supabase", "migrations", fileName)
  );
  await Promise.all(migrationPaths.map((migrationPath) => access(migrationPath)));

  const configuredUrl = env[args.databaseUrlEnv];
  const target = configuredUrl ? databaseTarget(configuredUrl) : null;
  if (args.mode === "dry-run") {
    const result = {
      status: "dry-run",
      databaseTarget: target ?? `unset:${args.databaseUrlEnv}`,
      migrations: TIMELINE_MIGRATIONS,
      transaction: "pending_contiguous_tail_single_transaction",
      command: formatCommand(
        args.psql,
        buildTimelineMigrationApplyArgs(
          `<${args.databaseUrlEnv}>`,
          migrationPaths,
        ),
      ),
      historyRepairCommandTemplate: formatCommand(
        args.supabase,
        buildSupabaseHistoryRepairArgs(
          `<${args.databaseUrlEnv}>`,
          TIMELINE_MIGRATION_VERSIONS,
        ),
      ),
      preflightOutput: "aggregate_counts_only",
      migrationHistoryRecorded: "reconciled_after_verified_apply_before_success",
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  const confirmed = requireConfirmedDatabase({
    env,
    envName: args.databaseUrlEnv,
    confirmation: args.confirmTarget,
  });
  await commandRunner(args.psql, ["--version"], { cwd: rootDir, env, capture: true });

  const preflightStatus = await runPsqlQuery({
    commandRunner,
    psql: args.psql,
    databaseUrl: confirmed.databaseUrl,
    sql: TIMELINE_MIGRATION_PREFLIGHT_SQL,
    cwd: rootDir,
    env,
  });
  const pendingFiles = pendingTimelineMigrations(preflightStatus);
  const historyMask = await runPsqlQuery({
    commandRunner,
    psql: args.psql,
    databaseUrl: confirmed.databaseUrl,
    sql: TIMELINE_MIGRATION_HISTORY_MASK_SQL,
    cwd: rootDir,
    env,
  });
  const structurallyAppliedCount = TIMELINE_MIGRATIONS.length - pendingFiles.length;
  const historyState = parseHistoryMask(historyMask);
  for (let index = structurallyAppliedCount; index < historyState.length; index += 1) {
    if (historyState[index]) {
      throw new Error(
        "Timeline migration history claims a version whose schema markers are absent; reconcile before retrying.",
      );
    }
  }

  if (args.mode === "verify-only" && pendingFiles.length > 0) {
    throw new Error(
      `Timeline migrations are not fully applied (aggregate schema state: ${preflightStatus}).`,
    );
  }
  if (args.mode === "verify-only" && historyState.some((applied) => !applied)) {
    const missingVersions = TIMELINE_MIGRATION_VERSIONS.filter((_, index) => !historyState[index]);
    throw new Error(
      `Timeline schema is present but migration history is incomplete. Required repair: ${formatCommand(
        args.supabase,
        buildSupabaseHistoryRepairArgs(`<${args.databaseUrlEnv}>`, missingVersions),
      )}`,
    );
  }

  let dataPreflight = "not_applicable_no_timeline_tables";
  if (preflightStatus !== "ready_017") {
    dataPreflight = await runPsqlQuery({
      commandRunner,
      psql: args.psql,
      databaseUrl: confirmed.databaseUrl,
      sql: TIMELINE_DATA_PREFLIGHT_SQL,
      cwd: rootDir,
      env,
    });
    if (dataPreflight !== "primary=0;evidence=0;posts=0") {
      throw new Error(
        `Timeline migration data preflight failed (${dataPreflight ?? "no aggregate result"}).`,
      );
    }
  }

  if (args.mode === "apply" && pendingFiles.length > 0) {
    const pendingPaths = pendingFiles.map((fileName) =>
      path.join(rootDir, "supabase", "migrations", fileName)
    );
    await commandRunner(
      args.psql,
      buildTimelineMigrationApplyArgs(confirmed.databaseUrl, pendingPaths),
      { cwd: rootDir, env },
    );
  }

  const verification = await runPsqlQuery({
    commandRunner,
    psql: args.psql,
    databaseUrl: confirmed.databaseUrl,
    sql: TIMELINE_MIGRATION_VERIFICATION_SQL,
    cwd: rootDir,
    env,
  });
  if (verification !== "verified") {
    throw new Error("Timeline migrations ran, but post-apply invariant verification failed.");
  }

  const missingHistoryVersions = TIMELINE_MIGRATION_VERSIONS.filter(
    (_, index) => !historyState[index],
  );
  if (args.mode === "apply" && missingHistoryVersions.length > 0) {
    await commandRunner(args.supabase, ["--version"], {
      cwd: rootDir,
      env,
      capture: true,
    });
    await commandRunner(
      args.supabase,
      buildSupabaseHistoryRepairArgs(confirmed.databaseUrl, missingHistoryVersions),
      { cwd: rootDir, env },
    );
  }
  const verifiedHistoryMask = await runPsqlQuery({
    commandRunner,
    psql: args.psql,
    databaseUrl: confirmed.databaseUrl,
    sql: TIMELINE_MIGRATION_HISTORY_MASK_SQL,
    cwd: rootDir,
    env,
  });
  if (verifiedHistoryMask !== "1111") {
    throw new Error(
      "Timeline schema verified, but Supabase migration history reconciliation did not complete.",
    );
  }

  const result = {
    status: pendingFiles.length > 0 ? "applied-and-verified" : "already-applied-and-verified",
    databaseTarget: confirmed.target,
    preflightSchemaState: preflightStatus,
    preflightDataCounts: dataPreflight,
    migrationsApplied: args.mode === "apply" ? pendingFiles : [],
    migrationHistoryRecorded: true,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
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
      `--command=${sql}`,
    ],
    { cwd, env, capture: true },
  );
  return lastOutputLine(result.stdout);
}

function preflightFailure(status) {
  if (status === "missing_base_schema") {
    return "Database is not verified through migration 016; refusing Timeline migration apply.";
  }
  if (status === "missing_supabase_roles") {
    return "Required Supabase roles are missing; refusing Timeline migration apply.";
  }
  if (status === "missing_migration_history") {
    return "Supabase migration history is unavailable; refusing an untracked Timeline migration apply.";
  }
  if (status === "inconsistent_partial_timeline_schema") {
    return "Timeline schema is partially applied; reconcile migration history before retrying.";
  }
  return `Unexpected Timeline migration preflight result: ${status ?? "no output"}`;
}

function parseHistoryMask(value) {
  if (!/^[01]{4}$/.test(value ?? "")) {
    throw new Error(`Unexpected Timeline migration-history aggregate: ${value ?? "no output"}`);
  }
  return [...value].map((flag) => flag === "1");
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
