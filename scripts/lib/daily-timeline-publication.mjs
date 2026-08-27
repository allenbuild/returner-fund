const TIMELINE_DATABASE_ENVIRONMENT_KEYS = Object.freeze([
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY"
]);

/**
 * Rebuild the Company Timeline closure required by a daily benchmark release.
 *
 * A configured database is authoritative unless its loader returns the exact
 * structured migration-unavailable state. Network, authentication, malformed
 * data, and every other database failure deliberately propagate so a release
 * cannot silently replace durable state with a weaker projection.
 */
export async function rebuildDailyTimelineArtifacts(options) {
  const env = { ...(options.env ?? process.env) };
  const configuration = options.validateConfiguration(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { githubActions: env.GITHUB_ACTIONS === "true" }
  );

  if (!configuration.valid) {
    const result = await options.runBackfill({
      rootDir: options.rootDir,
      resume: true,
      env: fileBackedTimelineEnvironment(env)
    });
    return {
      mode: "file_backed",
      reason: "database_configuration_unavailable",
      configurationBlockers: [...configuration.blockers],
      result
    };
  }

  const databaseSnapshot = await options.loadDatabaseSnapshot(env);
  if (databaseSnapshot.status === "loaded") {
    const result = await options.runBackfill({
      rootDir: options.rootDir,
      resume: true,
      env: { ...env, TIMELINE_REQUIRE_DATABASE: "true" },
      databaseSnapshot
    });
    return {
      mode: "database_backed",
      reason: "database_snapshot_loaded",
      configurationBlockers: [],
      result
    };
  }

  if (databaseSnapshot.status === "migration_unavailable") {
    const result = await options.runBackfill({
      rootDir: options.rootDir,
      resume: true,
      env: fileBackedTimelineEnvironment(env)
    });
    return {
      mode: "file_backed",
      reason: "timeline_migration_unavailable",
      configurationBlockers: [],
      result
    };
  }

  throw new Error(
    `Configured Company Timeline database returned unexpected snapshot status ${String(databaseSnapshot.status)}.`
  );
}

export function fileBackedTimelineEnvironment(env = process.env) {
  const result = { ...env, TIMELINE_REQUIRE_DATABASE: "false" };
  for (const key of TIMELINE_DATABASE_ENVIRONMENT_KEYS) delete result[key];
  return result;
}
