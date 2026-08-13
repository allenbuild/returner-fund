import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  stageHistoricalBackfillPublication
} from "../scripts/lib/historical-publication-staging.mjs";
import {
  runHistoricalBackfill
} from "../scripts/lib/historical-backfill.mjs";
import {
  writePublicEvidenceArtifactPairAtomic
} from "../scripts/lib/public-evidence-artifact.mjs";

const STARTED_AT = "2026-08-03T02:00:00.000Z";
const STAGED_AT = "2026-08-03T02:10:00.000Z";

describe("historical public publication staging", () => {
  it("preserves every canonical row and stages only exact new physical rows as unpublished", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const canonicalBefore = await readFile(fixture.canonicalPath);
    const outputDir = join(fixture.root, "staging", "historical-v2");

    const result = await stageFixture(fixture, { outputDir });

    assert.equal(result.status, "staged");
    assert.equal(result.publicationStatus, "stored_but_unpublished");
    assert.deepEqual(result.counts, {
      runnerAccepted: 3,
      runnerRejected: 0,
      runnerDuplicates: 0,
      adapterAccepted: 3,
      adapterRejected: 0,
      dedupedWithinHistorical: 0,
      dedupedAgainstCanonical: 1,
      dedupedTotal: 1,
      storedButUnpublished: 2,
      stagedReviewRowsAdded: 2,
      canonicalEvidencePreserved: 2,
      canonicalReviewsPreserved: 1
    });
    assert.deepEqual(result.byPlatform, {
      hacker_news: {
        adapterAccepted: 1,
        adapterRejected: 0,
        storedButUnpublished: 0,
        deduped: 1
      },
      rss: {
        adapterAccepted: 1,
        adapterRejected: 0,
        storedButUnpublished: 1,
        deduped: 0
      },
      web: {
        adapterAccepted: 1,
        adapterRejected: 0,
        storedButUnpublished: 1,
        deduped: 0
      }
    });
    assert.deepEqual(await readFile(fixture.canonicalPath), canonicalBefore);

    const staged = JSON.parse(await readFile(
      join(outputDir, "public-evidence-staged.json"),
      "utf8"
    ));
    assert.deepEqual(
      staged.evidence.map((row) => row.id),
      ["canonical-hn-42", "canonical-hn-7"],
      "last-good and older/deeper canonical rows remain byte-order stable"
    );
    assert.equal(staged.needsReview.length, 3);
    assert.deepEqual(
      staged.needsReview.slice(1).map((row) => row.publicationPolicy),
      ["stored_but_unpublished", "stored_but_unpublished"]
    );
    assert.equal(staged.source.historicalStaging.storedRows, 2);

    const stored = await ndjson(join(outputDir, "historical-stored-unpublished.ndjson"));
    assert.deepEqual(stored.map((row) => row.platform).sort(), ["rss", "web"]);
    assert.ok(stored.every((row) =>
      row.publicationPolicy === "stored_but_unpublished" &&
      row.historicalValidationStatus === "pending_publication_validation"
    ));
    const deduped = await ndjson(join(outputDir, "historical-deduplicated.ndjson"));
    assert.deepEqual(deduped.map((row) => [row.platform, row.reason]), [[
      "hacker_news",
      "already_stored_in_canonical_snapshot"
    ]]);

    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    for (const descriptor of Object.values(manifest.artifacts)) {
      const bytes = await readFile(join(outputDir, descriptor.path));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), descriptor.sha256);
    }
  });

  it("supports a true dry run without creating the requested output directory", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const outputDir = join(fixture.root, "must-not-exist");
    const result = await stageFixture(fixture, { outputDir, dryRun: true });

    assert.equal(result.status, "dry_run");
    assert.equal(result.counts.storedButUnpublished, 2);
    await assert.rejects(access(outputDir));
  });

  it("hash-verifies and hydrates a split canonical operational ledger", async (t) => {
    const fixture = await createFixture({ splitCanonical: true });
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const canonicalBefore = await readFile(fixture.canonicalPath);
    const ledgerBefore = await readFile(fixture.operationalLedgerPath);
    const result = await stageFixture(fixture, { dryRun: true });

    assert.equal(result.status, "dry_run");
    assert.equal(result.canonical.operationalLedger.bytes, ledgerBefore.length);
    assert.equal(
      result.canonical.operationalLedger.sha256,
      createHash("sha256").update(ledgerBefore).digest("hex")
    );
    assert.deepEqual(await readFile(fixture.canonicalPath), canonicalBefore);
    assert.deepEqual(await readFile(fixture.operationalLedgerPath), ledgerBefore);
  });

  it("rejects an unfinished journal before reading it as publication evidence", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const events = await ndjson(fixture.journalPath);
    const unfinishedPath = join(fixture.root, "unfinished.ndjson");
    await writeFile(
      unfinishedPath,
      events.slice(0, -1).map((row) => JSON.stringify(row)).join("\n") + "\n"
    );

    await assert.rejects(
      stageFixture(fixture, { journalPath: unfinishedPath, dryRun: true }),
      /must end in run_completed/
    );
  });

  it("rejects journal evidence whose platform no longer matches its exact target", async (t) => {
    const fixture = await createFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const events = await ndjson(fixture.journalPath);
    const event = events.find((row) =>
      row.type === "page_checkpoint" && row.evidence?.[0]?.platform === "rss"
    );
    assert.ok(event);
    event.evidence[0].platform = "web";
    const mismatchedPath = join(fixture.root, "mismatched.ndjson");
    await writeFile(
      mismatchedPath,
      events.map((row) => JSON.stringify(row)).join("\n") + "\n"
    );

    await assert.rejects(
      stageFixture(fixture, { journalPath: mismatchedPath, dryRun: true }),
      /evidence platform does not match its target attribution/
    );
  });
});

async function createFixture({ splitCanonical = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "historical-publication-staging-"));
  const historyDir = join(root, "history");
  const canonicalPath = join(root, "canonical.json");
  const catalogs = fixtureCatalogs();
  let tick = 0;
  await runHistoricalBackfill({
    outputDir: historyDir,
    catalogs,
    platforms: ["hacker_news", "rss", "web"],
    limits: {
      hostPaceMs: 0,
      requestAttempts: 1,
      siteMaxResponses: 8
    },
    now: () => new Date(Date.parse(STARTED_AT) + tick++ * 1_000),
    fetch: fixtureFetch
  });
  const canonical = canonicalSnapshot();
  await writeFile(canonicalPath, `${JSON.stringify(canonical, null, 2)}\n`);
  let operationalLedgerPath = null;
  if (splitCanonical) {
    const published = await writePublicEvidenceArtifactPairAtomic({
      rootDir: root,
      canonicalPath,
      snapshot: canonical
    });
    operationalLedgerPath = published.ledgerPath;
  }
  return {
    root,
    journalPath: join(historyDir, "pages.ndjson"),
    canonicalPath,
    catalogs,
    operationalLedgerPath
  };
}

function stageFixture(fixture, overrides = {}) {
  return stageHistoricalBackfillPublication({
    root: fixture.root,
    journalPath: overrides.journalPath ?? fixture.journalPath,
    canonicalPath: fixture.canonicalPath,
    outputDir: overrides.outputDir,
    stagedAt: STAGED_AT,
    dryRun: overrides.dryRun ?? false,
    catalogs: fixture.catalogs,
    contentIdentityReferenceRows: [],
    maxArtifactBytes: 16 * 1024 * 1024
  });
}

function fixtureCatalogs() {
  return [{
    slug: "TEST",
    sourcePath: "fixture-catalog.json",
    generatedAt: STARTED_AT,
    companies: [{
      entityType: "company",
      sourceKey: "company-acme",
      name: "Acme Labs",
      websiteUrl: "https://acme.example/blog/post",
      tagline: "Widgets for exact fixture testing",
      description: "Acme Labs builds widgets.",
      accounts: [],
      founders: []
    }]
  }];
}

async function fixtureFetch(input) {
  const url = new URL(String(input));
  if (url.hostname === "hn.algolia.com") {
    return jsonResponse({
      page: 0,
      nbPages: 1,
      hits: [{
        objectID: "42",
        title: "Acme Labs historical announcement",
        url: "https://acme.example/blog/hn-story",
        story_text: "Acme Labs builds widgets at acme.example.",
        created_at: "2026-04-01T12:00:00.000Z",
        author: "fixture"
      }]
    });
  }
  if (url.pathname === "/robots.txt") return textResponse("User-agent: *", "text/plain");
  if (url.pathname === "/blog/post") {
    return textResponse(`
      <html><head>
        <link rel="canonical" href="https://acme.example/blog/post">
        <link rel="alternate" type="application/rss+xml" href="/feed.xml">
        <meta property="article:published_time" content="2026-03-01T12:00:00.000Z">
        <meta property="og:title" content="Acme Labs web history">
        <meta name="description" content="Acme Labs builds widgets.">
      </head><body></body></html>
    `, "text/html");
  }
  if (url.pathname === "/feed.xml") {
    return textResponse(`
      <rss><channel><item>
        <guid>https://acme.example/blog/feed-entry</guid>
        <link>https://acme.example/blog/feed-entry</link>
        <title>Acme Labs RSS history</title>
        <description>Acme Labs builds widgets.</description>
        <pubDate>2026-02-01T12:00:00.000Z</pubDate>
      </item></channel></rss>
    `, "application/rss+xml");
  }
  return new Response("not found", { status: 404 });
}

function canonicalSnapshot() {
  return {
    source: {
      label: "Autonomous public ingestion merged export",
      fetchedAt: "2026-08-03T01:00:00.000Z",
      evidenceCount: 2,
      needsReviewCount: 1
    },
    evidence: [
      canonicalHnRow("canonical-hn-42", "42", "2026-04-01T12:00:00.000Z"),
      canonicalHnRow("canonical-hn-7", "7", "2025-01-01T12:00:00.000Z")
    ],
    needsReview: [{
      id: "canonical-review",
      batchSlug: "TEST",
      entityType: "company",
      entityId: "company-acme",
      companySlug: "acme",
      companyName: "Acme Labs",
      platform: "hacker_news",
      candidateUrl: "https://news.ycombinator.com/item?id=99",
      review_state: "needs_review",
      matchReason: "Existing canonical review remains preserved.",
      last_checked_at: "2026-08-03T01:00:00.000Z"
    }],
    attributionReconciliationLedger: [],
    failures: [],
    attempts: {},
    discoveryAttempts: [],
    sourceDiscoveryPaths: []
  };
}

function canonicalHnRow(id, postId, postedAt) {
  return {
    id,
    batchSlug: "TEST",
    entityType: "company",
    entityId: "company-acme",
    attachedCompanyId: "company-acme",
    entityName: "Acme Labs",
    companySlug: "acme",
    companyName: "Acme Labs",
    platform: "hacker_news",
    platformPostId: postId,
    sourceUrl: `https://news.ycombinator.com/item?id=${postId}`,
    title: "Acme Labs builds widgets",
    text: "Acme Labs builds widgets at acme.example.",
    postedAt,
    review_state: "verified",
    metrics: { upvotes: 1 },
    last_checked_at: "2026-08-03T01:00:00.000Z"
  };
}

function jsonResponse(value) {
  return textResponse(JSON.stringify(value), "application/json");
}

function textResponse(body, contentType) {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

async function ndjson(path) {
  return (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
