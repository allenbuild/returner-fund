import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATIONS_DIRECTORY = path.join(REPOSITORY_ROOT, "supabase", "migrations");

const IDS = Object.freeze({
  run: "90000000-0000-4000-8000-000000000001",
  allViewsStory: "90000000-0000-4000-8000-000000000002",
  breakingOnlyStory: "90000000-0000-4000-8000-000000000003",
  allViewsScore: "90000000-0000-4000-8000-000000000004",
  breakingOnlyScore: "90000000-0000-4000-8000-000000000005",
  finalizationStory: "90000000-0000-4000-8000-000000000006",
  finalizationExternalSource: "90000000-0000-4000-8000-000000000007",
  firstRun: "90000000-0000-4000-8000-000000000008",
  firstScore: "90000000-0000-4000-8000-000000000009",
  firstPublication: "90000000-0000-4000-8000-000000000010",
  newerRun: "90000000-0000-4000-8000-000000000011",
  newerScore: "90000000-0000-4000-8000-000000000012",
  newerPublication: "90000000-0000-4000-8000-000000000013",
  delayedRun: "90000000-0000-4000-8000-000000000014",
  delayedScore: "90000000-0000-4000-8000-000000000015",
  delayedPublication: "90000000-0000-4000-8000-000000000016",
  primaryReconciliationStory: "90000000-0000-4000-8000-000000000017",
  firstPrimaryExternalSource: "90000000-0000-4000-8000-000000000018",
  secondPrimaryExternalSource: "90000000-0000-4000-8000-000000000019",
  legacyWindowRun: "90000000-0000-4000-8000-000000000020",
  currentWindowRun: "90000000-0000-4000-8000-000000000021",
  rejectedLegacyWindowRun: "90000000-0000-4000-8000-000000000022",
  rejectedUnalignedWindowRun: "90000000-0000-4000-8000-000000000023",
});

const HASHES = Object.freeze({
  input: "a".repeat(64),
  sources: "b".repeat(64),
  summary: "c".repeat(64),
  payload: "d".repeat(64),
  artifact: "e".repeat(64),
});

const FINALIZATION_OBSERVED_THROUGH = Object.freeze({
  [IDS.firstRun]: "2026-08-15 10:00:00+00",
  [IDS.newerRun]: "2026-08-15 11:00:00+00",
  [IDS.delayedRun]: "2026-08-15 09:00:00+00",
});

test("Dashboard migrations preserve legacy windows, enforce 72 hours, and support the three-view Top 100", { timeout: 30_000 }, async () => {
  const db = new PGlite({
    extensions: { pgcrypto },
    initialMemory: 128 * 1024 * 1024,
  });
  try {
    await bootstrapSupabaseSurfaces(db);
    await applyDashboard72HourWindowMigrationFixture(db);
    assert.equal(
      await scalar(db, `
        select config_hash
        from public.scoring_model_versions
        where model_key = 'technology_dashboard' and version = '1.0.0'
      `),
      "00e9e9ceff685a0401db95ea801227606aaa549b306a437371eea99ec46b138a",
    );
    assert.equal(
      await scalar(db, `
        select config_hash
        from public.scoring_model_versions
        where model_key = 'technology_dashboard' and version = '2.0.0'
      `),
      "e7e8527efdc21584ab98e8d74d12bf4cd8efae6a875e4d496afe868cb6f3c0bf",
    );
    await insertDashboardFixture(db);

    const allViewRanks = await db.query(`
      select ranking_view, rank, view_score
      from public.dashboard_rank_snapshots
      where story_id = '${IDS.allViewsStory}'
      order by ranking_view
    `);
    assert.deepEqual(allViewRanks.rows, [
      { ranking_view: "breaking", rank: 8, view_score: "80.000000" },
      { ranking_view: "emerging", rank: 12, view_score: "70.000000" },
      { ranking_view: "hottest", rank: 10, view_score: "90.000000" },
    ]);

    assert.equal(
      await scalar(db, `
        select rank
        from public.dashboard_story_scores
        where id = '${IDS.breakingOnlyScore}'
      `),
      127,
    );
    const breakingOnlyRank = await db.query(`
      select ranking_view, rank, view_score
      from public.dashboard_rank_snapshots
      where story_id = '${IDS.breakingOnlyStory}'
    `);
    assert.deepEqual(breakingOnlyRank.rows, [
      { ranking_view: "breaking", rank: 1, view_score: "99.000000" },
    ]);

    await assert.rejects(
      db.exec(`
        insert into public.dashboard_rank_snapshots (
          dashboard_run_id, story_id, dashboard_story_score_id,
          ranking_view, rank, view_score, trend_state
        ) values (
          '${IDS.run}', '${IDS.breakingOnlyStory}', '${IDS.breakingOnlyScore}',
          'breaking', 101, 99, 'new'
        )
      `),
      /dashboard_rank_snapshots_rank_check|violates check constraint/i,
    );
  } finally {
    await db.close();
  }
});

test("Dashboard finalization stamps the run on the server, publishes a staged draft, and cannot resurrect an older draft", { timeout: 30_000 }, async () => {
  const db = new PGlite({
    extensions: { pgcrypto },
    initialMemory: 128 * 1024 * 1024,
  });
  try {
    await bootstrapSupabaseSurfaces(db);
    await applyAllMigrations(db);
    await insertDashboardFinalizationFixture(db);

    await expectArtifactPathConstraint(db);

    assert.equal(await finalizeDashboardPublication(db, IDS.firstRun, IDS.firstPublication), "published");
    const firstFinalization = await db.query(`
      select
        run.status as run_status,
        run.finished_at is not null as has_finished_at,
        run.finished_at >= run.started_at as finished_after_started,
        run.finished_at <= clock_timestamp() as finished_at_is_server_time,
        publication.status as publication_status,
        publication.is_current,
        publication.published_at is not null as has_published_at
      from public.dashboard_runs run
      join public.dashboard_publications publication on publication.dashboard_run_id = run.id
      where run.id = '${IDS.firstRun}'
    `);
    assert.deepEqual(firstFinalization.rows, [{
      run_status: "completed",
      has_finished_at: true,
      finished_after_started: true,
      finished_at_is_server_time: true,
      publication_status: "published",
      is_current: true,
      has_published_at: true,
    }]);

    assert.equal(await finalizeDashboardPublication(db, IDS.newerRun, IDS.newerPublication), "published");
    const currentPublication = await db.query(`
      select id, status, is_current
      from public.dashboard_publications
      where is_current
    `);
    assert.deepEqual(currentPublication.rows, [{
      id: IDS.newerPublication,
      status: "published",
      is_current: true,
    }]);
    assert.equal(
      await scalar(db, `
        select status
        from public.dashboard_publications
        where id = '${IDS.firstPublication}'
      `),
      "superseded",
    );

    assert.equal(await finalizeDashboardPublication(db, IDS.delayedRun, IDS.delayedPublication), "unchanged");
    const delayedFinalization = await db.query(`
      select run.status as run_status, publication.status as publication_status, publication.is_current
      from public.dashboard_runs run
      join public.dashboard_publications publication on publication.dashboard_run_id = run.id
      where run.id = '${IDS.delayedRun}'
    `);
    assert.deepEqual(delayedFinalization.rows, [{
      run_status: "completed",
      publication_status: "superseded",
      is_current: false,
    }]);
    assert.equal(
      await scalar(db, "select id from public.dashboard_publications where is_current"),
      IDS.newerPublication,
    );

    assert.equal(await finalizeDashboardPublication(db, IDS.newerRun, IDS.newerPublication), "unchanged");
    await db.query("select public.fail_dashboard_run($1, $2::jsonb)", [
      IDS.newerRun,
      JSON.stringify({ message: "late worker retry" }),
    ]);
    assert.equal(
      await scalar(db, `select status from public.dashboard_runs where id = '${IDS.newerRun}'`),
      "completed",
    );
  } finally {
    await db.close();
  }
});

test("Dashboard primary-source reconciliation atomically switches the primary and retains exactly one", { timeout: 30_000 }, async () => {
  const db = new PGlite({
    extensions: { pgcrypto },
    initialMemory: 128 * 1024 * 1024,
  });
  try {
    await bootstrapSupabaseSurfaces(db);
    await applyAllMigrations(db);
    await insertPrimaryReconciliationFixture(db);

    // The worker upserts the current hourly boundary on every refresh. The
    // trigger must retain the original boundary while moving last_seen_at.
    await db.exec(`
      update public.dashboard_stories
      set
        first_seen_at = timestamptz '2026-08-15 11:00:00+00',
        last_seen_at = timestamptz '2026-08-15 11:00:00+00'
      where id = '${IDS.primaryReconciliationStory}'
    `);
    assert.equal(
      await scalar(db, `
        select first_seen_at = timestamptz '2026-08-15 10:00:00+00'
        from public.dashboard_stories
        where id = '${IDS.primaryReconciliationStory}'
      `),
      true,
    );
    assert.equal(
      await scalar(db, `
        select last_seen_at = timestamptz '2026-08-15 11:00:00+00'
        from public.dashboard_stories
        where id = '${IDS.primaryReconciliationStory}'
      `),
      true,
    );

    await reconcileDashboardPrimary(db, IDS.secondPrimaryExternalSource);
    assert.deepEqual(
      (await db.query(`
        select external_source_id, source_role
        from public.dashboard_story_sources
        where story_id = '${IDS.primaryReconciliationStory}'
        order by external_source_id
      `)).rows,
      [
        { external_source_id: IDS.firstPrimaryExternalSource, source_role: "supporting" },
        { external_source_id: IDS.secondPrimaryExternalSource, source_role: "primary" },
      ],
    );
    assert.equal(
      await scalar(db, `
        select count(*)
        from public.dashboard_story_sources
        where story_id = '${IDS.primaryReconciliationStory}'
          and source_role = 'primary'
      `),
      1,
    );

    await reconcileDashboardPrimary(db, IDS.firstPrimaryExternalSource);
    assert.deepEqual(
      (await db.query(`
        select external_source_id, source_role
        from public.dashboard_story_sources
        where story_id = '${IDS.primaryReconciliationStory}'
        order by external_source_id
      `)).rows,
      [
        { external_source_id: IDS.firstPrimaryExternalSource, source_role: "primary" },
        { external_source_id: IDS.secondPrimaryExternalSource, source_role: "supporting" },
      ],
    );
    assert.equal(
      await scalar(db, `
        select count(*)
        from public.dashboard_story_sources
        where story_id = '${IDS.primaryReconciliationStory}'
          and source_role = 'primary'
      `),
      1,
    );
  } finally {
    await db.close();
  }
});

async function bootstrapSupabaseSurfaces(db) {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create schema supabase_migrations;
    create table supabase_migrations.schema_migrations (version text primary key);
  `);
}

async function applyDashboard72HourWindowMigrationFixture(db) {
  await applyMigrationsThrough(db, "029_register_dashboard_scoring_v2.sql");
  await db.exec(`
    insert into public.dashboard_runs (
      id, run_key, scoring_model_version_id, window_start, window_end, as_of_at, status
    ) values (
      '${IDS.legacyWindowRun}',
      'dashboard-legacy-window-2026-08-15t12',
      (select id from public.scoring_model_versions where model_key = 'technology_dashboard' and version = '1.0.0'),
      timestamptz '2026-08-14 12:00:00+00',
      timestamptz '2026-08-15 12:00:00+00',
      timestamptz '2026-08-15 12:00:00+00',
      'running'
    )
  `);

  await applyMigration(db, "030_dashboard_runs_rolling_72_hour_window.sql");

  assert.equal(
    await scalar(db, `
      select (extract(epoch from (window_end - window_start)) / 3600)::integer
      from public.dashboard_runs
      where id = '${IDS.legacyWindowRun}'
    `),
    24,
  );
  const windowConstraint = (await db.query(`
    select convalidated, pg_get_constraintdef(oid) as definition
    from pg_constraint
    where conrelid = 'public.dashboard_runs'::regclass
      and conname = 'dashboard_runs_window_check'
  `)).rows;
  assert.equal(windowConstraint.length, 1);
  assert.equal(windowConstraint[0].convalidated, false);
  assert.match(windowConstraint[0].definition, /72(?::00:00| hours)/i);

  await db.exec(`
    insert into public.dashboard_runs (
      id, run_key, scoring_model_version_id, window_start, window_end, as_of_at, status
    ) values (
      '${IDS.currentWindowRun}',
      'dashboard-current-window-2026-08-15t12',
      (select id from public.scoring_model_versions where model_key = 'technology_dashboard' and version = '2.0.0'),
      timestamptz '2026-08-12 12:00:00+00',
      timestamptz '2026-08-15 12:00:00+00',
      timestamptz '2026-08-15 12:00:00+00',
      'running'
    )
  `);

  await assert.rejects(
    db.exec(`
      insert into public.dashboard_runs (
        id, run_key, window_start, window_end, as_of_at, status
      ) values (
        '${IDS.rejectedLegacyWindowRun}',
        'dashboard-rejected-legacy-window-2026-08-15t12',
        timestamptz '2026-08-14 12:00:00+00',
        timestamptz '2026-08-15 12:00:00+00',
        timestamptz '2026-08-15 12:00:00+00',
        'running'
      )
    `),
    /dashboard_runs_window_check|violates check constraint/i,
  );
  await assert.rejects(
    db.exec(`
      insert into public.dashboard_runs (
        id, run_key, window_start, window_end, as_of_at, status
      ) values (
        '${IDS.rejectedUnalignedWindowRun}',
        'dashboard-rejected-unaligned-window-2026-08-15t1230',
        timestamptz '2026-08-12 12:30:00+00',
        timestamptz '2026-08-15 12:30:00+00',
        timestamptz '2026-08-15 12:30:00+00',
        'running'
      )
    `),
    /dashboard_runs_window_check|violates check constraint/i,
  );
}

async function applyAllMigrations(db) {
  return applyMigrationsThrough(db);
}

async function applyMigrationsThrough(db, finalMigrationName = null) {
  const migrationNames = (await readdir(MIGRATIONS_DIRECTORY))
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right));
  assert.ok(migrationNames.includes("022_dashboard_stories.sql"));
  assert.ok(migrationNames.includes("023_dashboard_publication_finalization.sql"));
  assert.ok(migrationNames.includes("024_dashboard_story_source_primaries.sql"));
  assert.ok(migrationNames.includes("025_dashboard_story_first_seen.sql"));
  assert.ok(migrationNames.includes("026_dashboard_internal_artifact_path.sql"));
  assert.ok(migrationNames.includes("029_register_dashboard_scoring_v2.sql"));
  assert.ok(migrationNames.includes("030_dashboard_runs_rolling_72_hour_window.sql"));

  for (const migrationName of migrationNames) {
    await applyMigration(db, migrationName);
    if (migrationName === finalMigrationName) return;
  }
  if (finalMigrationName !== null) {
    assert.fail(`Migration ${finalMigrationName} was not found.`);
  }
}

async function applyMigration(db, migrationName) {
  await db.exec(await readFile(path.join(MIGRATIONS_DIRECTORY, migrationName), "utf8"));
  await db.query(
    "insert into supabase_migrations.schema_migrations (version) values ($1)",
    [migrationName.slice(0, 3)],
  );
}

async function insertDashboardFixture(db) {
  await db.exec(`
    insert into public.dashboard_runs (
      id, run_key, window_start, window_end, as_of_at, status
    ) values (
      '${IDS.run}',
      'dashboard-three-view-integration-2026-08-15t12',
      timestamptz '2026-08-12 12:00:00+00',
      timestamptz '2026-08-15 12:00:00+00',
      timestamptz '2026-08-15 12:00:00+00',
      'running'
    );

    insert into public.dashboard_stories (
      id, story_key, status, universe, title
    ) values
      ('${IDS.allViewsStory}', 'story-all-views', 'active', 'industry', 'All views fixture'),
      ('${IDS.breakingOnlyStory}', 'story-breaking-only', 'active', 'industry', 'Breaking only fixture');

    insert into public.dashboard_story_scores (
      id, dashboard_run_id, story_id, rank, trend_score,
      relative_engagement_score, velocity_score, freshness_score,
      confirmation_score, source_quality_score, breaking_score, emerging_score,
      trend_state, source_count, platform_count, independent_source_count
    ) values
      (
        '${IDS.allViewsScore}', '${IDS.run}', '${IDS.allViewsStory}', 10, 90,
        75, 70, 80, 60, 65, 80, 70,
        'new', 3, 2, 2
      ),
      (
        '${IDS.breakingOnlyScore}', '${IDS.run}', '${IDS.breakingOnlyStory}', 127, 40,
        10, 99, 20, 0, 30, 99, 20,
        'new', 1, 1, 1
      );

    insert into public.dashboard_rank_snapshots (
      dashboard_run_id, story_id, dashboard_story_score_id,
      ranking_view, rank, view_score, trend_state
    ) values
      ('${IDS.run}', '${IDS.allViewsStory}', '${IDS.allViewsScore}', 'hottest', 10, 90, 'new'),
      ('${IDS.run}', '${IDS.allViewsStory}', '${IDS.allViewsScore}', 'breaking', 8, 80, 'new'),
      ('${IDS.run}', '${IDS.allViewsStory}', '${IDS.allViewsScore}', 'emerging', 12, 70, 'new'),
      ('${IDS.run}', '${IDS.breakingOnlyStory}', '${IDS.breakingOnlyScore}', 'breaking', 1, 99, 'new');
  `);
}

async function insertDashboardFinalizationFixture(db) {
  await db.exec(`
    insert into public.dashboard_stories (
      id, story_key, status, universe, title,
      summary, summary_status, summary_input_hash, summary_model_version
    ) values (
      '${IDS.finalizationStory}', 'story-finalization-fixture', 'active', 'industry',
      'Finalization fixture story',
      'A generated, source-grounded dashboard summary.',
      'generated', '${HASHES.summary}', 'dashboard-summary-v1'
    );

    insert into public.dashboard_external_sources (
      id, canonical_key, platform, source_type, canonical_url,
      source_title, verification_state, source_quality_tier, independence_key,
      content_fingerprint
    ) values (
      '${IDS.finalizationExternalSource}', 'github:finalization-fixture', 'github', 'release',
      'https://github.com/example/finalization/releases/tag/v1',
      'Finalization fixture release', 'verified', 3, 'github:example', '${HASHES.sources}'
    );

    insert into public.dashboard_story_sources (
      story_id, external_source_id, source_key, source_role, verification_state,
      source_quality_tier, platform, canonical_url, source_title, independence_key
    ) values (
      '${IDS.finalizationStory}', '${IDS.finalizationExternalSource}',
      'github:finalization-fixture', 'primary', 'verified', 3, 'github',
      'https://github.com/example/finalization/releases/tag/v1',
      'Finalization fixture release', 'github:example'
    );

    insert into public.dashboard_runs (
      id, run_key, scoring_model_version_id, window_start, window_end, as_of_at, status
    ) values
      (
        '${IDS.firstRun}', 'dashboard-finalization-first-2026-08-15t10',
        (select id from public.scoring_model_versions where model_key = 'technology_dashboard' and version = '2.0.0'),
        timestamptz '2026-08-12 10:00:00+00', timestamptz '2026-08-15 10:00:00+00',
        timestamptz '2026-08-15 10:00:00+00', 'running'
      ),
      (
        '${IDS.newerRun}', 'dashboard-finalization-newer-2026-08-15t11',
        (select id from public.scoring_model_versions where model_key = 'technology_dashboard' and version = '2.0.0'),
        timestamptz '2026-08-12 11:00:00+00', timestamptz '2026-08-15 11:00:00+00',
        timestamptz '2026-08-15 11:00:00+00', 'running'
      ),
      (
        '${IDS.delayedRun}', 'dashboard-finalization-delayed-2026-08-15t09',
        (select id from public.scoring_model_versions where model_key = 'technology_dashboard' and version = '2.0.0'),
        timestamptz '2026-08-12 09:00:00+00', timestamptz '2026-08-15 09:00:00+00',
        timestamptz '2026-08-15 09:00:00+00', 'running'
      );

    insert into public.dashboard_story_scores (
      id, dashboard_run_id, story_id, rank, trend_score,
      relative_engagement_score, velocity_score, freshness_score,
      confirmation_score, source_quality_score, breaking_score, emerging_score,
      trend_state, source_count, platform_count, independent_source_count
    ) values
      ('${IDS.firstScore}', '${IDS.firstRun}', '${IDS.finalizationStory}', 1, 90, 70, 70, 70, 70, 70, 80, 80, 'new', 1, 1, 1),
      ('${IDS.newerScore}', '${IDS.newerRun}', '${IDS.finalizationStory}', 1, 91, 70, 70, 70, 70, 70, 81, 81, 'new', 1, 1, 1),
      ('${IDS.delayedScore}', '${IDS.delayedRun}', '${IDS.finalizationStory}', 1, 89, 70, 70, 70, 70, 70, 79, 79, 'new', 1, 1, 1);

    insert into public.dashboard_rank_snapshots (
      dashboard_run_id, story_id, dashboard_story_score_id,
      ranking_view, rank, view_score, trend_state
    ) values
      ('${IDS.firstRun}', '${IDS.finalizationStory}', '${IDS.firstScore}', 'hottest', 1, 90, 'new'),
      ('${IDS.newerRun}', '${IDS.finalizationStory}', '${IDS.newerScore}', 'hottest', 1, 91, 'new'),
      ('${IDS.delayedRun}', '${IDS.finalizationStory}', '${IDS.delayedScore}', 'hottest', 1, 89, 'new');

    insert into public.dashboard_publications (
      id, dashboard_run_id, publication_key, status, is_current,
      generated_at, freshness_checked_at, data_fresh_through, freshness_status,
      schema_version, payload_json, payload_sha256, artifact_path, artifact_sha256
    ) values
      (
        '${IDS.firstPublication}', '${IDS.firstRun}', 'dashboard-finalization-first', 'draft', false,
        timestamptz '2026-08-15 10:00:00+00', timestamptz '2026-08-15 10:00:00+00',
        timestamptz '2026-08-15 10:00:00+00', 'fresh', 'technology-dashboard-v2',
        '{"stories":[]}'::jsonb, '${HASHES.payload}', 'artifacts/dashboard/finalization-first.json', '${HASHES.artifact}'
      ),
      (
        '${IDS.newerPublication}', '${IDS.newerRun}', 'dashboard-finalization-newer', 'draft', false,
        timestamptz '2026-08-15 11:00:00+00', timestamptz '2026-08-15 11:00:00+00',
        timestamptz '2026-08-15 11:00:00+00', 'fresh', 'technology-dashboard-v2',
        '{"stories":[]}'::jsonb, '${HASHES.payload}', 'artifacts/dashboard/finalization-newer.json', '${HASHES.artifact}'
      ),
      (
        '${IDS.delayedPublication}', '${IDS.delayedRun}', 'dashboard-finalization-delayed', 'draft', false,
        timestamptz '2026-08-15 09:00:00+00', timestamptz '2026-08-15 09:00:00+00',
        timestamptz '2026-08-15 09:00:00+00', 'fresh', 'technology-dashboard-v2',
        '{"stories":[]}'::jsonb, '${HASHES.payload}', 'artifacts/dashboard/finalization-delayed.json', '${HASHES.artifact}'
      );
  `);
}

async function insertPrimaryReconciliationFixture(db) {
  await db.exec(`
    insert into public.dashboard_stories (
      id, story_key, status, universe, title, first_seen_at, last_seen_at
    )
    values (
      '${IDS.primaryReconciliationStory}',
      'story-primary-reconciliation-fixture',
      'active',
      'industry',
      'Primary reconciliation fixture story',
      timestamptz '2026-08-15 10:00:00+00',
      timestamptz '2026-08-15 10:00:00+00'
    );

    insert into public.dashboard_external_sources (
      id, canonical_key, platform, source_type, canonical_url,
      source_title, verification_state, source_quality_tier, independence_key
    ) values
      (
        '${IDS.firstPrimaryExternalSource}', 'github:primary-reconciliation-first', 'github', 'release',
        'https://github.com/example/first/releases/tag/v1',
        'First primary reconciliation release', 'verified', 3, 'github:example:first'
      ),
      (
        '${IDS.secondPrimaryExternalSource}', 'github:primary-reconciliation-second', 'github', 'release',
        'https://github.com/example/second/releases/tag/v1',
        'Second primary reconciliation release', 'verified', 3, 'github:example:second'
      );

    insert into public.dashboard_story_sources (
      story_id, external_source_id, source_key, source_role, verification_state,
      source_quality_tier, platform, canonical_url, source_title, independence_key
    ) values
      (
        '${IDS.primaryReconciliationStory}', '${IDS.firstPrimaryExternalSource}',
        'github:primary-reconciliation-first', 'primary', 'verified', 3, 'github',
        'https://github.com/example/first/releases/tag/v1',
        'First primary reconciliation release', 'github:example:first'
      ),
      (
        '${IDS.primaryReconciliationStory}', '${IDS.secondPrimaryExternalSource}',
        'github:primary-reconciliation-second', 'supporting', 'verified', 3, 'github',
        'https://github.com/example/second/releases/tag/v1',
        'Second primary reconciliation release', 'github:example:second'
      );
  `);
}

async function finalizeDashboardPublication(db, runId, publicationId) {
  const observedThrough = FINALIZATION_OBSERVED_THROUGH[runId];
  assert.ok(observedThrough, `Missing observed-through fixture for ${runId}.`);
  return scalar(db, `
    select public.finalize_dashboard_publication(
      '${runId}',
      '${publicationId}',
      '${HASHES.input}',
      '${HASHES.sources}',
      timestamptz '${observedThrough}',
      '{"candidateCount":1,"storyCount":1}'::jsonb
    )
  `);
}

async function reconcileDashboardPrimary(db, externalSourceId) {
  await db.query("select public.reconcile_dashboard_story_source_primaries($1::jsonb)", [
    JSON.stringify([{
      story_id: IDS.primaryReconciliationStory,
      external_source_id: externalSourceId,
    }]),
  ]);
}

async function expectArtifactPathConstraint(db) {
  assert.equal(
    await scalar(db, `
      select artifact_path
      from public.dashboard_publications
      where id = '${IDS.firstPublication}'
    `),
    "artifacts/dashboard/finalization-first.json",
  );
  await assert.rejects(
    db.exec(`
      update public.dashboard_publications
      set artifact_path = 'artifacts/dashboard/../escape.json'
      where id = '${IDS.firstPublication}'
    `),
    /dashboard_publications_artifact_path_check|violates check constraint/i,
  );
}

async function scalar(db, sql) {
  const result = await db.query(sql);
  const row = result.rows[0];
  assert.ok(row, "Expected a scalar query row.");
  return Object.values(row)[0];
}
