import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  adaptHistoricalBackfillCoverage
} from "../scripts/lib/historical-coverage-adapter.mjs";
import {
  generateHistoricalCompletionProofs
} from "../scripts/lib/historical-completion-proof-generator.mjs";
import {
  HISTORICAL_BACKFILL_RUNNER_VERSION,
  HISTORICAL_BACKFILL_SCHEMA_VERSION
} from "../scripts/lib/historical-backfill.mjs";

const STARTED_AT = "2026-08-02T18:20:00.000Z";
const PAGE_AT = "2026-08-02T18:25:00.000Z";
const TARGET_AT = "2026-08-02T18:26:00.000Z";
const COMPLETED_AT = "2026-08-02T18:27:00.000Z";
const GENERATED_AT = "2026-08-02T18:28:00.000Z";
const CUTOFF_AT = "2026-05-04T18:28:00.000Z";

describe("historical completion proof generator", () => {
  it("emits immutable artifact-bound proofs and round-trips every eligible target", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const outputDir = join(fixture.root, "proof-package");
    const result = await runGenerator(fixture, { outputDir });

    assert.deepEqual(result.denominator, {
      targetsEvaluated: 1,
      targetsCompletionEligible: 1,
      targetsExcluded: 0
    });
    assert.equal(result.recencyCutoffAt, CUTOFF_AT);
    assert.equal(result.verification.adapterRoundTrip, "passed");
    assert.equal(result.verification.completePairScopes, 1);
    const proofs = JSON.parse(await readFile(join(outputDir, "completion-proofs.json")));
    assert.equal(proofs.length, 1);
    assert.equal(proofs[0].artifactSha256, fixture.sha256);
    assert.equal(proofs[0].terminalSequence, 3);
    assert.equal(proofs[0].runCompletedSequence, 4);
    assert.equal(proofs[0].checkedAt, TARGET_AT);
    assert.equal(proofs[0].coveredThrough, CUTOFF_AT);
    assert.match(proofs[0].receiptId, /^historical-[a-f0-9]{40}$/);

    const manifest = JSON.parse(
      await readFile(join(outputDir, "completion-proof-manifest.json"))
    );
    assert.equal(manifest.sourceArtifact.sha256, fixture.sha256);
    assert.equal(manifest.sourceArtifact.events, 4);
    assert.equal(manifest.artifacts.completionProofs.sha256, sha256(
      await readFile(join(outputDir, "completion-proofs.json"))
    ));
    const dryRun = await runGenerator(fixture, { dryRun: true });
    assert.equal(
      dryRun.artifacts.completionProofs.sha256,
      result.artifacts.completionProofs.sha256
    );
  });

  it("rejects a one-byte journal modification against the pinned digest", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const modified = fixture.body.replace("Acme launch", "Acme launcH");
    assert.equal(Buffer.byteLength(modified), Buffer.byteLength(fixture.body));
    await writeFile(fixture.journalPath, modified);
    await assert.rejects(
      runGenerator(fixture, { dryRun: true }),
      /sha256 mismatch/
    );
  });

  it("rejects an unfinished journal even when its truncated digest is explicitly supplied", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const unfinished = `${fixture.events.slice(0, -1).map(JSON.stringify).join("\n")}\n`;
    await writeFile(fixture.journalPath, unfinished);
    await assert.rejects(
      generateHistoricalCompletionProofs({
        root: fixture.root,
        journalPath: fixture.journalPath,
        expectedJournalSha256: sha256(unfinished),
        generatedAt: GENERATED_AT,
        dryRun: true
      }),
      /must end in a completed run_completed event/
    );
  });

  it("excludes blocked, truncated, and rejected-evidence targets with exact reasons", async (t) => {
    const blocked = await createFixture({
      platform: "web",
      outcome: "access_blocked",
      sourceExhausted: false,
      truncated: true,
      blocker: "official_site_source_limit_reached",
      coverageExtent: "bounded_official_site_history",
      evidence: []
    });
    const rejected = await createFixture({
      evidence: [historicalEvidence({ publishedAt: null })]
    });
    t.after(async () => {
      await Promise.all([blocked, rejected].map((fixture) =>
        rm(fixture.root, { recursive: true, force: true })
      ));
    });
    const [blockedResult, rejectedResult] = await Promise.all([
      runGenerator(blocked, { dryRun: true }),
      runGenerator(rejected, { dryRun: true })
    ]);

    assert.equal(blockedResult.denominator.targetsCompletionEligible, 0);
    assert.equal(blockedResult.denominator.targetsExcluded, 1);
    assert.deepEqual(blockedResult.summary.exclusionReasons, {
      coverage_extent_not_exhaustive: 1,
      history_truncated: 1,
      outcome_access_blocked: 1,
      source_not_exhausted: 1,
      terminal_blocker_present: 1
    });
    assert.equal(rejectedResult.denominator.targetsCompletionEligible, 0);
    assert.deepEqual(rejectedResult.summary.exclusionReasons, {
      collected_evidence_does_not_reconcile: 1,
      rejected_evidence_present: 1
    });
  });

  it("makes terminal sequence, receipt ID, and cutoff tampering fail adapter verification", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const outputDir = join(fixture.root, "proof-package");
    await runGenerator(fixture, { outputDir });
    const proofs = JSON.parse(await readFile(join(outputDir, "completion-proofs.json")));
    const artifact = {
      path: fixture.journalPath,
      sha256: fixture.sha256,
      observedAt: COMPLETED_AT
    };
    await assert.rejects(
      adaptHistoricalBackfillCoverage({
        journal: createReadStream(fixture.journalPath),
        artifact,
        generatedAt: GENERATED_AT,
        completionProofs: [{ ...proofs[0], terminalSequence: 99 }]
      }),
      /terminalSequence does not match/
    );
    await assert.rejects(
      adaptHistoricalBackfillCoverage({
        journal: createReadStream(fixture.journalPath),
        artifact,
        generatedAt: GENERATED_AT,
        completionProofs: [{ ...proofs[0], receiptId: "historical-tampered" }]
      }),
      /receiptId is not deterministic/
    );
    await assert.rejects(
      adaptHistoricalBackfillCoverage({
        journal: createReadStream(fixture.journalPath),
        artifact,
        generatedAt: GENERATED_AT,
        completionProofs: [{ ...proofs[0], coveredThrough: "2026-01-01T00:00:00.000Z" }]
      }),
      /must use the exact recency cutoff/
    );
  });

  it("refuses to overwrite an existing output directory", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const outputDir = join(fixture.root, "proof-package");
    await mkdir(outputDir);
    await assert.rejects(
      runGenerator(fixture, { outputDir }),
      /outputDir already exists/
    );
  });
});

async function runGenerator(fixture, overrides = {}) {
  return generateHistoricalCompletionProofs({
    root: fixture.root,
    journalPath: fixture.journalPath,
    expectedJournalSha256: fixture.sha256,
    outputDir: overrides.outputDir,
    generatedAt: GENERATED_AT,
    dryRun: overrides.dryRun ?? false
  });
}

async function createFixture({
  platform = "hacker_news",
  outcome = "collected",
  evidence = null,
  sourceExhausted = true,
  truncated = false,
  blocker = null,
  coverageExtent = null
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "historical-completion-proof-"));
  const targetKey = `TEST:company-acme:${platform}`;
  const rows = evidence ?? (outcome === "collected" ? [historicalEvidence()] : []);
  const extent = coverageExtent ?? (
    platform === "hacker_news"
      ? "all_available_search_results"
      : platform === "rss"
        ? "all_discovered_official_feed_entries_within_endpoint_policy"
        : "all_discovered_official_web_history_within_endpoint_policy"
  );
  const config = {
    schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
    runnerVersion: HISTORICAL_BACKFILL_RUNNER_VERSION,
    batches: ["TEST"],
    platforms: [platform],
    targetKeys: [targetKey],
    limits: { globalConcurrency: 1, hostConcurrency: 1 }
  };
  const accepted = rows.length;
  const common = {
    schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
    runnerVersion: HISTORICAL_BACKFILL_RUNNER_VERSION,
    provider: platform,
    platform,
    batchSlug: "TEST",
    entityType: "company",
    entityId: "company-acme",
    entityName: "Acme",
    officialDomain: "acme.example",
    windowStart: rows[0]?.publishedAt ?? null,
    windowEnd: rows[0]?.publishedAt ?? null,
    pagesAttempted: 1,
    pagesFetched: 1,
    requests: 1,
    itemsSeen: accepted,
    accepted,
    rejected: 0,
    duplicates: 0,
    earliest: rows[0]?.publishedAt ?? null,
    latest: rows[0]?.publishedAt ?? null,
    nextCursor: null,
    sourceExhausted,
    truncated,
    sourceLimit: platform === "hacker_news"
      ? { maxPages: 20, maxItems: 1_000, hitsPerPage: 50 }
      : { maxDepth: 3, maxUrls: 200, maxResponses: 40, maxItems: 2_000 },
    credentialRequired: false,
    blocker,
    blockers: blocker ? [blocker] : [],
    nextAction: blocker
      ? "Resolve the exact recorded blocker before retrying this target."
      : "Retain the completed journal and continue incremental ingestion.",
    coverageExtent: extent
  };
  const events = [
    {
      schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
      sequence: 1,
      recordedAt: STARTED_AT,
      type: "run_initialized",
      config,
      configFingerprint: sha256(stableJson(config)),
      startedAt: STARTED_AT
    },
    {
      schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
      sequence: 2,
      recordedAt: PAGE_AT,
      type: "page_checkpoint",
      targetKey,
      receipt: {
        ...common,
        receiptType: "page",
        page: platform === "hacker_news" ? 0 : "https://acme.example/archive",
        pageType: platform === "hacker_news" ? "search_by_date" : "html",
        requestUrl: platform === "hacker_news"
          ? "https://hn.algolia.com/api/v1/search_by_date?page=0"
          : "https://acme.example/archive",
        pageItemsSeen: accepted,
        pageAccepted: accepted,
        pageRejected: 0,
        pageDuplicates: 0
      },
      evidence: rows,
      progress: { targetKey, accepted }
    },
    {
      schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
      sequence: 3,
      recordedAt: TARGET_AT,
      type: "target_completed",
      targetKey,
      receipt: { ...common, receiptType: "target", outcome }
    },
    {
      schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
      sequence: 4,
      recordedAt: COMPLETED_AT,
      type: "run_completed",
      summary: {
        status: "completed",
        targetPlatformPairs: 1,
        completedTargetPlatformPairs: 1
      }
    }
  ];
  const body = `${events.map(JSON.stringify).join("\n")}\n`;
  const journalPath = join(root, "pages.ndjson");
  await writeFile(journalPath, body);
  return { root, journalPath, targetKey, events, body, sha256: sha256(body) };
}

function historicalEvidence(overrides = {}) {
  return {
    schemaVersion: HISTORICAL_BACKFILL_SCHEMA_VERSION,
    collector: "historical-backfill",
    platform: "hacker_news",
    batchSlug: "TEST",
    entityType: "company",
    entityId: "company-acme",
    entityName: "Acme",
    officialDomain: "acme.example",
    externalId: "hn:42",
    sourceUrl: "https://news.ycombinator.com/item?id=42",
    canonicalUrl: "https://acme.example/blog/launch",
    title: "Acme launch",
    text: "Acme launch history.",
    publishedAt: "2026-04-01T12:00:00.000Z",
    discoveredAt: PAGE_AT,
    discoveryMethod: "hn_algolia_search_by_date_exact_name_and_official_domain",
    ...overrides
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}
