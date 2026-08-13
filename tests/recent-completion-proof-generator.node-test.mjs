import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  RECENT_NATIVE_PAGE_RECEIPT_VERSION,
  RECENT_NATIVE_WINDOW_PROOF_VERSION,
  generateRecentCompletionProofs
} from "../scripts/lib/recent-completion-proof-generator.mjs";
import {
  INGESTION_CORE_PLATFORMS
} from "../scripts/lib/ingestion-coverage-receipt.mjs";

const STARTED_AT = "2026-08-02T23:34:48.858Z";
const COMPLETED_AT = "2026-08-03T03:10:00.000Z";
const ATTEMPT_CHECKED_AT = "2026-08-03T03:09:30.000Z";
const WINDOW_START_AT = "2026-05-04T23:34:48.858Z";
const PAIR_KEY = "TEST:company:company-acme:x";

describe("recent completion proof generator", () => {
  it("emits one deterministic receipt only for a full, hash-pinned native window", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const outputDir = join(fixture.root, "recent-proof-package");
    const result = await runGenerator(fixture, { outputDir });

    assert.deepEqual(result.denominator, {
      canonicalCorePairs: 10,
      collectorAttemptRows: 1,
      pairsWithNativeAttempts: 1,
      pairsWithoutNativeAttempts: 9,
      completionEligiblePairs: 1,
      excludedPairs: 9
    });
    assert.deepEqual(result.window, {
      coveredFrom: WINDOW_START_AT,
      coveredThrough: STARTED_AT
    });
    assert.equal(result.summary.byPlatform.x.completionEligiblePairs, 1);
    assert.equal(result.summary.byPlatform.github.pairsWithoutNativeAttempts, 1);
    const proofs = JSON.parse(
      await readFile(join(outputDir, "recent-completion-proofs.json"))
    );
    assert.equal(proofs.length, 1);
    assert.equal(proofs[0].pairKey, PAIR_KEY);
    assert.match(proofs[0].receipt.receiptId, /^recent-[a-f0-9]{40}$/);
    assert.deepEqual(proofs[0].receipt, {
      receiptId: proofs[0].receipt.receiptId,
      status: "complete",
      checkedAt: COMPLETED_AT,
      coveredFrom: WINDOW_START_AT,
      coveredThrough: STARTED_AT,
      reason:
        "Every hash-pinned native request journal for 1 sibling attempt(s) has contiguous time segments, a gap-free cursor chain, an explicit terminal native boundary, and no blocker, cap, or truncation."
    });
    const pairScopes = JSON.parse(await readFile(join(outputDir, "pair-scopes.json")));
    assert.equal(pairScopes.length, 10);
    assert.equal(
      pairScopes.find((row) => key(row) === PAIR_KEY).scope.recentBackfillReceipt.receiptId,
      proofs[0].receipt.receiptId
    );
  });

  it("keeps legacy attempts without the exact contract explicitly incomplete", async (t) => {
    const fixture = await createFixture({ includeProof: false });
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const result = await runGenerator(fixture, { dryRun: true });

    assert.equal(result.denominator.completionEligiblePairs, 0);
    assert.equal(result.denominator.excludedPairs, 10);
    assert.equal(result.summary.exclusionReasons.no_native_collector_attempt, 9);
    assert.equal(
      result.summary.exclusionReasons.attempt_contract_missing_recent_window_proof,
      1
    );
    assert.equal(result.summary.exclusionReasons.not_every_sibling_attempt_is_proved, 1);
    assert.match(result.packagingDecision, /do not create a new campaign package/);
    assert.equal(result.artifacts.pairScopes, undefined);
  });

  it("rejects cap-bound pagination even when the attempt claims exhaustion", async (t) => {
    const fixture = await createFixture({ limitReached: true, pageLimit: 1 });
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const result = await runGenerator(fixture, { dryRun: true });
    assert.equal(result.denominator.completionEligiblePairs, 0);
    assert.equal(result.summary.exclusionReasons.page_limit_reached_or_ambiguous, 1);
  });

  it("rejects a remaining or discontinuous cursor chain", async (t) => {
    const remaining = await createFixture({ finalCursor: "cursor-next" });
    const discontinuous = await createFixture({
      pageRows: pageRowsWithGap({ cursorGap: true, timeGap: false })
    });
    t.after(async () => {
      await Promise.all([remaining, discontinuous].map((fixture) =>
        rm(fixture.root, { recursive: true, force: true })
      ));
    });
    const [remainingResult, discontinuousResult] = await Promise.all([
      runGenerator(remaining, { dryRun: true }),
      runGenerator(discontinuous, { dryRun: true })
    ]);
    assert.equal(remainingResult.summary.exclusionReasons.cursor_remaining, 1);
    assert.equal(discontinuousResult.summary.exclusionReasons.cursor_chain_gap, 1);
  });

  it("rejects a time gap even when page sequence and final cursor reconcile", async (t) => {
    const fixture = await createFixture({
      pageRows: pageRowsWithGap({ cursorGap: false, timeGap: true })
    });
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const result = await runGenerator(fixture, { dryRun: true });
    assert.equal(result.denominator.completionEligiblePairs, 0);
    assert.equal(result.summary.exclusionReasons.page_coverage_time_gap, 1);
  });

  it("requires every sibling attempt and keeps proof checks inside the run", async (t) => {
    const sibling = await createFixture({ includeUnprovedSibling: true });
    const late = await createFixture({ checkedAt: "2026-08-03T03:10:00.001Z" });
    t.after(async () => {
      await Promise.all([sibling, late].map((fixture) =>
        rm(fixture.root, { recursive: true, force: true })
      ));
    });
    const [siblingResult, lateResult] = await Promise.all([
      runGenerator(sibling, { dryRun: true }),
      runGenerator(late, { dryRun: true })
    ]);
    assert.equal(
      siblingResult.summary.exclusionReasons.attempt_contract_missing_recent_window_proof,
      1
    );
    assert.equal(siblingResult.summary.exclusionReasons.not_every_sibling_attempt_is_proved, 1);
    assert.equal(lateResult.summary.exclusionReasons.proof_checked_at_outside_run, 1);
  });

  it("rejects pre-cutoff requests and immutable-cutoff tampering", async (t) => {
    const preCutoff = await createFixture({
      pageRows: [pageReceipt({
        sequence: 1,
        cursorIn: null,
        cursorOut: null,
        sourceExhausted: true,
        requestedAt: "2026-08-02T23:34:48.857Z",
        coverageFrom: WINDOW_START_AT,
        coverageThrough: STARTED_AT
      })]
    });
    const cutoffTamper = await createFixture();
    t.after(async () => {
      await Promise.all([preCutoff, cutoffTamper].map((fixture) =>
        rm(fixture.root, { recursive: true, force: true })
      ));
    });
    const preCutoffResult = await runGenerator(preCutoff, { dryRun: true });
    assert.equal(
      preCutoffResult.summary.exclusionReasons.page_requested_before_coverage_cutoff,
      1
    );

    const manifest = JSON.parse(await readFile(cutoffTamper.manifestPath));
    manifest.recentCoverageCutoff = "2026-08-02T23:34:48.857Z";
    const body = `${JSON.stringify(manifest)}\n`;
    await writeFile(cutoffTamper.manifestPath, body);
    cutoffTamper.manifestSha256 = sha256(body);
    const tamperedResult = await runGenerator(cutoffTamper, { dryRun: true });
    assert.equal(
      tamperedResult.summary.exclusionReasons.attempt_immutable_cutoff_mismatch,
      1
    );
    assert.equal(tamperedResult.summary.exclusionReasons.proof_window_end_gap, 1);
  });

  it("rejects modified request-journal bytes and a modified campaign manifest", async (t) => {
    const journalTamper = await createFixture();
    const manifestTamper = await createFixture();
    t.after(async () => {
      await Promise.all([journalTamper, manifestTamper].map((fixture) =>
        rm(fixture.root, { recursive: true, force: true })
      ));
    });
    await writeFile(journalTamper.requestJournalPath, "{}\n");
    const journalResult = await runGenerator(journalTamper, { dryRun: true });
    assert.equal(journalResult.summary.exclusionReasons.request_journal_sha256_mismatch, 1);

    const manifest = JSON.parse(await readFile(manifestTamper.manifestPath));
    manifest.generatedAt = "2026-08-03T03:10:00.001Z";
    await writeFile(manifestTamper.manifestPath, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(
      runGenerator(manifestTamper, { dryRun: true }),
      /Campaign manifest sha256 mismatch/
    );
  });

  it("refuses to overwrite an existing output package", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const outputDir = join(fixture.root, "recent-proof-package");
    await mkdir(outputDir);
    await assert.rejects(runGenerator(fixture, { outputDir }), /outputDir already exists/);
  });
});

async function runGenerator(fixture, overrides = {}) {
  return generateRecentCompletionProofs({
    root: fixture.root,
    campaignManifestPath: fixture.manifestPath,
    expectedCampaignSha256: fixture.manifestSha256,
    outputDir: overrides.outputDir,
    dryRun: overrides.dryRun ?? false,
    maxArtifactBytes: 8 * 1024 * 1024
  });
}

async function createFixture({
  includeProof = true,
  includeUnprovedSibling = false,
  limitReached = false,
  pageLimit = 10,
  finalCursor = null,
  checkedAt = ATTEMPT_CHECKED_AT,
  pageRows = null
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "recent-completion-proof-"));
  await Promise.all([
    mkdir(join(root, "generated")),
    mkdir(join(root, "collectors")),
    mkdir(join(root, "coverage")),
    mkdir(join(root, "receipts"))
  ]);
  const catalogs = [{
    slug: "TEST",
    sourcePath: "fixtures/test-catalog.json",
    generatedAt: STARTED_AT,
    companies: [{
      entityType: "company",
      sourceKey: "company-acme",
      name: "Acme",
      accounts: [],
      founders: []
    }]
  }];
  const catalogsBody = `${JSON.stringify(catalogs)}\n`;
  const catalogsPath = join(root, "generated", "catalogs.json");
  await writeFile(catalogsPath, catalogsBody);

  const runnerRows = [
    {
      eventType: "run.started",
      createdAt: STARTED_AT,
      severity: "info",
      message: "Fixture started.",
      payload: {}
    },
    {
      eventType: "run.completed",
      createdAt: COMPLETED_AT,
      severity: "info",
      message: "Fixture completed.",
      payload: {}
    }
  ];
  const runnerBody = `${runnerRows.map(JSON.stringify).join("\n")}\n`;
  const runnerPath = join(root, "generated", "runner-events.ndjson");
  await writeFile(runnerPath, runnerBody);

  const rows = pageRows ?? [pageReceipt({
    sequence: 1,
    cursorIn: null,
    cursorOut: finalCursor,
    sourceExhausted: finalCursor === null,
    coverageFrom: WINDOW_START_AT,
    coverageThrough: STARTED_AT
  })];
  const requestJournalBody = `${rows.map(JSON.stringify).join("\n")}\n`;
  const requestJournalPath = join(root, "receipts", "x-acme.ndjson");
  await writeFile(requestJournalPath, requestJournalBody);
  const recentWindowProof = {
    schemaVersion: RECENT_NATIVE_WINDOW_PROOF_VERSION,
    status: "complete",
    coverageScope: "pair_all_native_targets",
    coveredFrom: WINDOW_START_AT,
    coveredThrough: STARTED_AT,
    checkedAt,
    sourceExhausted: true,
    nextCursor: finalCursor,
    truncated: false,
    limitReached,
    pageLimit,
    pagesAttempted: rows.length,
    pagesFetched: rows.length,
    blockers: [],
    requestJournal: {
      path: "receipts/x-acme.ndjson",
      sha256: sha256(requestJournalBody),
      observedAt: checkedAt
    }
  };
  const attempt = {
    attemptKey: "x:company-acme",
    status: "done",
    checkedAt,
    recentWindowCoverageCutoff: STARTED_AT,
    error: null,
    retryable: false,
    outcomeStatus: "completed",
    outcomeReason: "native_window_collected",
    batchSlug: "TEST",
    platform: "x",
    entityType: "company",
    entityId: "company-acme",
    entityName: "Acme",
    accountUrl: "https://x.com/acme",
    ...(includeProof ? { recentWindowProof } : {})
  };
  const attempts = { "TEST:x:company-acme": attempt };
  if (includeUnprovedSibling) {
    attempts["TEST:x:company-acme:sibling"] = {
      ...attempt,
      attemptKey: "x:company-acme:sibling",
      accountUrl: "https://x.com/acme-labs",
      recentWindowProof: undefined
    };
  }
  const collector = {
    source: {
      batchSlug: "TEST",
      fetchedAt: COMPLETED_AT,
      recentCoverageCutoff: STARTED_AT
    },
    attempts
  };
  const collectorBody = `${JSON.stringify(collector)}\n`;
  const collectorPath = join(root, "collectors", "public-test.json");
  await writeFile(collectorPath, collectorBody);

  const pairScopes = INGESTION_CORE_PLATFORMS.map((platform) => ({
    batchSlug: "TEST",
    entityType: "company",
    entityId: "company-acme",
    platform,
    scope: {}
  }));
  const pairScopesBody = `${JSON.stringify(pairScopes)}\n`;
  const pairScopesPath = join(root, "coverage", "pair-scopes.json");
  await writeFile(pairScopesPath, pairScopesBody);

  const manifest = {
    schemaVersion: "ingestion-coverage-campaign.v1",
    runId: "recent-proof-fixture",
    generatedAt: COMPLETED_AT,
    coverageGeneratedAt: COMPLETED_AT,
    recentCoverageCutoff: STARTED_AT,
    artifacts: {
      catalogs: fileDescriptor("generated/catalogs.json", catalogsBody),
      runnerLog: fileDescriptor("generated/runner-events.ndjson", runnerBody),
      collectors: [fileDescriptor("collectors/public-test.json", collectorBody)],
      pairScopes: fileDescriptor("coverage/pair-scopes.json", pairScopesBody)
    }
  };
  const manifestBody = `${JSON.stringify(manifest)}\n`;
  const manifestPath = join(root, "campaign.json");
  await writeFile(manifestPath, manifestBody);
  return {
    root,
    manifestPath,
    manifestSha256: sha256(manifestBody),
    requestJournalPath
  };
}

function pageRowsWithGap({ cursorGap, timeGap }) {
  return [
    pageReceipt({
      sequence: 1,
      cursorIn: null,
      cursorOut: "cursor-1",
      sourceExhausted: false,
      coverageFrom: WINDOW_START_AT,
      coverageThrough: "2026-06-01T00:00:00.000Z"
    }),
    pageReceipt({
      sequence: 2,
      cursorIn: cursorGap ? "wrong-cursor" : "cursor-1",
      cursorOut: null,
      sourceExhausted: true,
      coverageFrom: timeGap
        ? "2026-06-02T00:00:00.000Z"
        : "2026-06-01T00:00:00.000Z",
      coverageThrough: STARTED_AT
    })
  ];
}

function pageReceipt({
  sequence,
  cursorIn,
  cursorOut,
  sourceExhausted,
  requestedAt = "2026-08-03T03:09:00.000Z",
  coverageFrom,
  coverageThrough
}) {
  return {
    schemaVersion: RECENT_NATIVE_PAGE_RECEIPT_VERSION,
    sequence,
    attemptKey: "x:company-acme",
    pairKey: PAIR_KEY,
    requestedAt,
    completedAt: ATTEMPT_CHECKED_AT,
    requestUrl: `https://api.x.example/native/posts?page=${sequence}`,
    status: "success",
    cursorIn,
    cursorOut,
    sourceExhausted,
    responseSha256: String(sequence).repeat(64).slice(0, 64),
    coverageFrom,
    coverageThrough
  };
}

function fileDescriptor(path, body) {
  return {
    path,
    format: path.endsWith(".ndjson") ? "ndjson" : "json",
    sha256: sha256(body),
    observedAt: COMPLETED_AT
  };
}

function key(row) {
  return `${row.batchSlug}:${row.entityType}:${row.entityId}:${row.platform}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
