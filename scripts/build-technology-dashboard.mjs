#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { refreshTechnologyDashboard } from "../src/lib/dashboard/refresh.ts";
import { persistDashboardSnapshot } from "../src/lib/dashboard/persistence.ts";
import { isDashboardPublicSnapshot, writePublicDashboardArtifact } from "../src/lib/dashboard/store.ts";
import { dashboardSnapshotMaterialDescriptor } from "../src/lib/dashboard/pipeline.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT_PATH = path.join(ROOT, "artifacts", "dashboard", "current.json");

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const noExternal = process.argv.includes("--no-external");
  const nowValue = argumentValue("--now");
  const requestedNow = nowValue ? new Date(nowValue) : new Date();
  if (!Number.isFinite(requestedNow.getTime())) throw new Error("--now must be a valid ISO timestamp.");
  // The source refresh can run a few minutes after its GitHub schedule, but
  // run provenance and historical snapshots must belong to one UTC hour.
  const now = utcHourSlot(requestedNow);

  const priorSnapshot = await loadExistingSnapshot();
  const result = await refreshTechnologyDashboard({
    now,
    includeExternal: !noExternal,
    priorSnapshot
  });
  if (result.snapshot.stories.length === 0) {
    // A rolling 24-hour feed may legitimately be empty (for example during a
    // temporary upstream outage or before the first fresh source arrives).
    // Never overwrite a last-good artifact with an empty projection, and do
    // not turn that safe preservation into a noisy failed hourly job.
    const noPriorPublication = !priorSnapshot;
    const message = noPriorPublication
      ? "Dashboard refresh found no eligible stories and no prior artifact exists; refusing an empty first publication.\n"
      : "Dashboard refresh found no eligible stories; preserving the last published snapshot.\n";
    process.stderr.write(message);
    process.stdout.write(`${JSON.stringify({
      status: noPriorPublication && !dryRun ? "initial_empty" : "preserved_empty",
      generatedAt: result.snapshot.generatedAt,
      windowStart: result.snapshot.windowStart,
      storyCount: 0,
      candidateCount: result.snapshot.status.candidateCount,
      eligibleCandidateCount: result.snapshot.status.eligibleCandidateCount,
      sourceCounts: result.sourceCounts,
      platformFailures: result.sourceFailures,
      artifactPath: "artifacts/dashboard/current.json"
    })}\n`);
    if (noPriorPublication && !dryRun) process.exitCode = 1;
    return;
  }
  // A stable ranking still needs a fresh publication receipt each hour. The
  // material descriptor intentionally ignores window timestamps for summary
  // reuse/idempotence, so compare the generated hour separately; otherwise a
  // healthy but unchanged feed would age out of the public route after two
  // hours when database persistence is unavailable.
  const changed = !priorSnapshot ||
    priorSnapshot.generatedAt !== result.snapshot.generatedAt ||
    dashboardSnapshotMaterialDescriptor(priorSnapshot) !== dashboardSnapshotMaterialDescriptor(result.snapshot);
  if (!dryRun && changed) await writePublicDashboardArtifact(result.snapshot);
  const persistence = dryRun
    ? { status: "skipped", reason: "dry_run" }
    : await persistWithSafeFallback(result.snapshot);

  process.stdout.write(`${JSON.stringify({
    status: dryRun ? "validated" : changed ? "written" : "unchanged",
    generatedAt: result.snapshot.generatedAt,
    windowStart: result.snapshot.windowStart,
    storyCount: result.snapshot.stories.length,
    candidateCount: result.snapshot.status.candidateCount,
    eligibleCandidateCount: result.snapshot.status.eligibleCandidateCount,
    sourceCounts: result.sourceCounts,
    platformFailures: result.sourceFailures,
    persistence,
    artifactPath: "artifacts/dashboard/current.json"
  })}\n`);
}

async function persistWithSafeFallback(snapshot) {
  try {
    return await persistDashboardSnapshot(snapshot);
  } catch (error) {
    // The static artifact was already atomically published. Preserve that
    // public availability while retaining a sanitized worker-visible signal
    // for a transient database or rollout failure.
    const reason = error instanceof Error ? error.message.replace(/[\r\n\t]+/g, " ").slice(0, 500) : "dashboard_persistence_error";
    process.stderr.write(`::warning title=Dashboard database persistence deferred::${reason}\n`);
    if (process.env.DASHBOARD_REQUIRE_DATABASE === "true") throw error;
    return { status: "skipped", reason: `persistence_deferred:${reason}` };
  }
}

async function loadExistingSnapshot() {
  try {
    const raw = await readFile(ARTIFACT_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return isDashboardPublicSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function argumentValue(name) {
  const prefix = `${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : null;
}

function utcHourSlot(value) {
  const result = new Date(value);
  result.setUTCMinutes(0, 0, 0);
  return result;
}

await main();
