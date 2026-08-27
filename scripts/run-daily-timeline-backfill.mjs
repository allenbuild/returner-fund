#!/usr/bin/env node

import { resolve } from "node:path";
import { runCompanyTimelineBackfill } from "../src/lib/timeline/backfill.ts";
import { loadPublishedTimelineDatabaseSnapshot } from "../src/lib/timeline/database-backfill.ts";
import { rebuildDailyTimelineArtifacts } from "./lib/daily-timeline-publication.mjs";
import { validateSupabaseConfiguration } from "./lib/supabase-configuration.mjs";

const rootDir = resolve(argumentValue("--root") ?? process.cwd());

try {
  const publication = await rebuildDailyTimelineArtifacts({
    rootDir,
    env: process.env,
    validateConfiguration: validateSupabaseConfiguration,
    loadDatabaseSnapshot: loadPublishedTimelineDatabaseSnapshot,
    runBackfill: runCompanyTimelineBackfill
  });
  if (publication.reason === "timeline_migration_unavailable") {
    process.stderr.write(
      "::warning title=Timeline file-backed fallback::Company Timeline database projections are unavailable. Rebuilt the complete public Timeline from canonical repository evidence with database credentials removed.\n"
    );
  } else if (publication.reason === "database_configuration_unavailable") {
    process.stderr.write(
      "::warning title=Timeline file-backed fallback::Supabase publication credentials are unavailable or invalid. Rebuilt the complete public Timeline from canonical repository evidence with database writes disabled.\n"
    );
  }
  process.stdout.write(`${JSON.stringify({
    status: "completed",
    mode: publication.mode,
    reason: publication.reason,
    configurationBlockers: publication.configurationBlockers,
    generatedAt: publication.result.generatedAt,
    companyCount: publication.result.uniqueCompanies,
    eventCount: publication.result.publishedEvents
  })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: "failed",
    error: error instanceof Error ? error.message : String(error)
  })}\n`);
  process.exitCode = 1;
}

function argumentValue(name) {
  const prefix = `${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  if (!argument) return null;
  const value = argument.slice(prefix.length).trim();
  if (!value) throw new TypeError(`${name} requires a value.`);
  return value;
}
