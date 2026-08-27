import assert from "node:assert/strict";
import test from "node:test";
import {
  fileBackedTimelineEnvironment,
  rebuildDailyTimelineArtifacts
} from "../scripts/lib/daily-timeline-publication.mjs";

const configuredEnvironment = Object.freeze({
  GITHUB_ACTIONS: "true",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "secret-value",
  PRESERVED_VALUE: "preserved"
});

test("an exact migration-unavailable snapshot falls back with database credentials removed", async () => {
  const calls = [];
  const result = await rebuildDailyTimelineArtifacts({
    rootDir: "/repository",
    env: configuredEnvironment,
    validateConfiguration: () => ({ valid: true, blockers: [] }),
    loadDatabaseSnapshot: async () => ({ status: "migration_unavailable" }),
    runBackfill: async (options) => {
      calls.push(options);
      return { generatedAt: "2026-08-27T00:00:00.000Z" };
    }
  });

  assert.equal(result.mode, "file_backed");
  assert.equal(result.reason, "timeline_migration_unavailable");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].resume, true);
  assert.equal(calls[0].rootDir, "/repository");
  assert.equal(calls[0].env.TIMELINE_REQUIRE_DATABASE, "false");
  assert.equal(calls[0].env.PRESERVED_VALUE, "preserved");
  assert.equal("NEXT_PUBLIC_SUPABASE_URL" in calls[0].env, false);
  assert.equal("SUPABASE_SERVICE_ROLE_KEY" in calls[0].env, false);
  assert.equal("databaseSnapshot" in calls[0], false);
});

test("a loaded snapshot remains strict and is passed directly to the backfill", async () => {
  const snapshot = { status: "loaded", marker: "database-snapshot" };
  let backfillOptions = null;
  const result = await rebuildDailyTimelineArtifacts({
    rootDir: "/repository",
    env: configuredEnvironment,
    validateConfiguration: () => ({ valid: true, blockers: [] }),
    loadDatabaseSnapshot: async () => snapshot,
    runBackfill: async (options) => {
      backfillOptions = options;
      return {};
    }
  });

  assert.equal(result.mode, "database_backed");
  assert.equal(backfillOptions.databaseSnapshot, snapshot);
  assert.equal(backfillOptions.env.TIMELINE_REQUIRE_DATABASE, "true");
  assert.equal(backfillOptions.env.NEXT_PUBLIC_SUPABASE_URL, configuredEnvironment.NEXT_PUBLIC_SUPABASE_URL);
  assert.equal(backfillOptions.env.SUPABASE_SERVICE_ROLE_KEY, configuredEnvironment.SUPABASE_SERVICE_ROLE_KEY);
});

test("invalid or absent configuration uses the credential-free canonical path", async () => {
  let databaseReads = 0;
  let backfillEnvironment = null;
  const result = await rebuildDailyTimelineArtifacts({
    rootDir: "/repository",
    env: configuredEnvironment,
    validateConfiguration: () => ({ valid: false, blockers: ["SUPABASE_SERVICE_ROLE_KEY:invalid_format"] }),
    loadDatabaseSnapshot: async () => {
      databaseReads += 1;
      return { status: "loaded" };
    },
    runBackfill: async (options) => {
      backfillEnvironment = options.env;
      return {};
    }
  });

  assert.equal(databaseReads, 0);
  assert.equal(result.reason, "database_configuration_unavailable");
  assert.equal(backfillEnvironment.TIMELINE_REQUIRE_DATABASE, "false");
  assert.equal("NEXT_PUBLIC_SUPABASE_URL" in backfillEnvironment, false);
  assert.equal("SUPABASE_SERVICE_ROLE_KEY" in backfillEnvironment, false);
});

test("database reads and every non-migration status fail closed", async () => {
  let backfillCalls = 0;
  const options = {
    rootDir: "/repository",
    env: configuredEnvironment,
    validateConfiguration: () => ({ valid: true, blockers: [] }),
    runBackfill: async () => {
      backfillCalls += 1;
      return {};
    }
  };

  await assert.rejects(
    rebuildDailyTimelineArtifacts({
      ...options,
      loadDatabaseSnapshot: async () => { throw new Error("database authentication failed"); }
    }),
    /database authentication failed/
  );
  await assert.rejects(
    rebuildDailyTimelineArtifacts({
      ...options,
      loadDatabaseSnapshot: async () => ({ status: "not_configured" })
    }),
    /unexpected snapshot status not_configured/
  );
  await assert.rejects(
    rebuildDailyTimelineArtifacts({
      ...options,
      loadDatabaseSnapshot: async () => ({ status: "loaded" }),
      runBackfill: async () => { throw new Error("timeline artifact validation failed"); }
    }),
    /timeline artifact validation failed/
  );
  assert.equal(backfillCalls, 0);
});

test("the credential scrubber does not mutate its caller's environment", () => {
  const source = { ...configuredEnvironment, TIMELINE_REQUIRE_DATABASE: "true" };
  const sanitized = fileBackedTimelineEnvironment(source);
  assert.equal(source.NEXT_PUBLIC_SUPABASE_URL, configuredEnvironment.NEXT_PUBLIC_SUPABASE_URL);
  assert.equal(source.SUPABASE_SERVICE_ROLE_KEY, configuredEnvironment.SUPABASE_SERVICE_ROLE_KEY);
  assert.equal(sanitized.TIMELINE_REQUIRE_DATABASE, "false");
  assert.equal("NEXT_PUBLIC_SUPABASE_URL" in sanitized, false);
  assert.equal("SUPABASE_SERVICE_ROLE_KEY" in sanitized, false);
});
