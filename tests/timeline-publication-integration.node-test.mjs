import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");
const runner = read("scripts/run-autonomous-ingestion.mjs");
const plan = read("scripts/lib/autonomous-ingestion-plan.mjs");
const autonomousWorkflow = read(".github/workflows/autonomous-ingestion.yml");
const dailyWorkflow = read(".github/workflows/daily-benchmarks.yml");
const nextConfig = read("next.config.mjs");
const fileDiscovery = read("src/lib/timeline/file-discovery.ts");
const packageJson = JSON.parse(read("package.json"));

test("release and scheduled publication gates validate Company Timeline artifacts", () => {
  assert.match(packageJson.scripts["check:release"], /check:release:artifacts/);
  assert.match(packageJson.scripts["check:release:artifacts"], /timeline:validate/);
  assert.match(packageJson.scripts["check:release:artifacts"], /timeline:audit/);
  assert.match(autonomousWorkflow, /npm run timeline:validate/);
  assert.match(dailyWorkflow, /npm run timeline:backfill/);
  assert.match(dailyWorkflow, /npm run timeline:validate/);
});

test("autonomous publication rebuilds timelines after graph publication and stages them", () => {
  const publication = runner.slice(
    runner.indexOf("async function buildAndValidatePublication"),
    runner.indexOf("async function synchronizePublicationBase"),
  );
  const benchmarks = publication.indexOf('"scripts/update-daily-benchmarks.mjs"');
  const prepare = publication.indexOf('"scripts/prepare-graph-runtime-evidence.mjs"');
  const prebuild = publication.indexOf('label: "pre-publication production build"');
  const discovery = publication.indexOf("runTimelineDiscoveryBeforeBackfill(catalogState)");
  const timeline = publication.indexOf('"scripts/backfill-company-timelines.mjs"');
  const validation = publication.indexOf('"scripts/validate-timeline-artifacts.mjs"');
  const build = publication.indexOf('"node_modules/next/dist/bin/next", "build"', validation);
  const graphManifest = publication.indexOf('"scripts/write-artifact-manifest.mjs"');
  assert.ok(
    prepare >= 0 && prebuild > prepare && benchmarks > prebuild
    && discovery > benchmarks && timeline > discovery && validation > timeline
    && build > validation && graphManifest > build
  );
  assert.match(runner, /scripts\/run-company-timeline-ingestion\.mjs/);
  assert.match(runner, /buildCanonicalTimelineIngestionInventory/);
  assert.match(runner, /graphCompanyIds/);
  assert.match(runner, /companyByBatchSourceKey/);
  assert.match(runner, /AUTONOMOUS_PROCESS_BUDGETS\.timelineDiscoveryMs/);
  assert.match(publication, /AUTONOMOUS_PROCESS_BUDGETS\.timelineBackfillMs/);
  assert.match(runner, /"public\/timelines"/);
  assert.match(plan, /timelineDiscoveryMs:\s*4 \* MINUTE_MS/);
  assert.match(plan, /timelineBackfillMs:\s*4 \* MINUTE_MS/);
});

test("autonomous publication has a bounded database-free public discovery lane", () => {
  assert.match(runner, /scripts\/discover-company-timeline-public-sources\.mjs/);
  assert.match(runner, /--concurrency=2/);
  assert.match(runner, /--max-companies=12/);
  assert.match(runner, /--per-fetch-timeout-ms=6000/);
  assert.match(runner, /timeline\.discovery\.file_backed/);
  assert.match(runner, /network_collection_explicitly_skipped/);
  assert.match(fileDiscovery, /work\/timeline-public-discovery-current\.json/);
  const stagedArtifacts = runner.slice(runner.indexOf("function repositoryArtifactPaths"));
  assert.doesNotMatch(stagedArtifacts, /outputs\/timeline-public-discovery-current\.json/);
});

test("autonomous publication consumes only Timeline invalidations claimed before its build", () => {
  const publicationFlow = runner.slice(
    runner.indexOf('let publicationReceipt = { status: "skipped"'),
    runner.indexOf("if (!args.skipPublish && publicationInputs.sourceDelta.dailySourceHealth"),
  );
  const claimIndex = publicationFlow.indexOf("claimTimelineArtifactInvalidationsForBuild()");
  const buildIndex = publicationFlow.indexOf("buildAndValidatePublication(publicationRunId, catalogState)");
  const publishIndex = publicationFlow.indexOf("publishRepositoryArtifacts(publicationRunId, publicationInputs)");
  const completeIndex = publicationFlow.indexOf("completePublishedTimelineInvalidations(publicationReceipt, timelineInvalidationClaim)");
  assert.ok(claimIndex >= 0 && buildIndex > claimIndex && publishIndex > buildIndex && completeIndex > publishIndex);

  const claim = runner.slice(
    runner.indexOf("async function claimTimelineArtifactInvalidationsForBuild"),
    runner.indexOf("async function completePublishedTimelineInvalidations"),
  );
  assert.match(claim, /update\(\{ status: "processing"/);
  assert.match(claim, /\.in\("status", \["pending", "processing", "failed"\]\)/);
  assert.match(claim, /\.select\("id,company_id,invalidated_at"\)/);

  const complete = runner.slice(
    runner.indexOf("async function completePublishedTimelineInvalidations"),
    runner.indexOf("async function runTimelineDiscoveryBeforeBackfill"),
  );
  assert.match(complete, /\.eq\("status", "processing"\)/);
  assert.match(complete, /\.in\("id", invalidationClaim\.ids\)/);
  assert.doesNotMatch(complete, /\.in\("status"/);
});

test("durable Timeline publication is bounded, source-complete, and database-aware", () => {
  const coordinator = read("src/lib/timeline/coordinator.ts");
  const ingestion = read("src/lib/timeline/ingestion-runner.ts");
  const backfill = read("src/lib/timeline/backfill.ts");
  const databaseBackfill = read("src/lib/timeline/database-backfill.ts");
  assert.match(coordinator, /TIMELINE_SOURCE_CLASSES/);
  assert.match(coordinator, /offset \+= 250/);
  assert.match(ingestion, /expectedTasks = companies\.length \* TIMELINE_SOURCE_CLASSES\.length/);
  assert.match(ingestion, /bounded_timeline_discovery_budget_exhausted/);
  assert.match(ingestion, /searchSnippetUsedAsEvidence:\s*false/);
  assert.match(ingestion, /deadLetterTask/);
  assert.match(ingestion, /rescheduleTask/);
  assert.match(backfill, /loadPublishedTimelineDatabaseSnapshot/);
  assert.match(backfill, /databaseSha256/);
  assert.match(backfill, /company-timeline-backfill-checkpoint\.v2/);
  assert.match(backfill, /previousCheckpoint\.buildVersion === TIMELINE_BACKFILL_BUILD_VERSION/);
  assert.match(backfill, /\^tldb-\[0-9a-f\]/, "DB-backed event details must be included in stale-artifact cleanup");
  assert.match(databaseBackfill, /published_timeline_events/);
  assert.match(databaseBackfill, /published_timeline_source_metadata/);
});

test("daily benchmark publication keeps timeline source hashes synchronized on normal and retry paths", () => {
  assert.ok((dailyWorkflow.match(/npm run timeline:backfill/g) ?? []).length >= 2);
  assert.ok((dailyWorkflow.match(/npm run timeline:validate/g) ?? []).length >= 2);
  assert.match(dailyWorkflow, /public\/timelines/);
  assert.match(dailyWorkflow, /EXA_API_KEY:\s*\$\{\{ secrets\.EXA_API_KEY \}\}/);
});

test("serverless timeline routes explicitly trace prebuilt artifacts", () => {
  assert.match(nextConfig, /"public\/timelines\/\*\*\/\*\.json"/);
  assert.match(nextConfig, /"artifacts\/company-timeline\/coverage\.json"/);
  assert.match(nextConfig, /"\/api\/companies\/\[slug\]\/timeline": \[\.\.\.timelineRuntimeData, \.\.\.timelineInternalRuntimeData\]/);
  assert.match(nextConfig, /"\/api\/timeline\/events\/\[eventId\]": \[\.\.\.timelineRuntimeData, \.\.\.timelineInternalRuntimeData\]/);
});
