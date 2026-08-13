import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildGithubExhaustiveTargets,
  materializeGithubExhaustiveJournal,
  runGithubExhaustiveBackfill
} from "../scripts/lib/github-exhaustive-backfill.mjs";
import { stageGithubExhaustiveIntegration } from "../scripts/lib/github-exhaustive-integration.mjs";

describe("exhaustive GitHub fail-closed staging integration", () => {
  it("preserves canonical and 158 legacy rows while staging new evidence outside scoring", async () => {
    const fixture = await completedFixture();
    const dryRun = await stageFixture(fixture, { write: false });

    assert.equal(dryRun.writeMode, false);
    assert.deepEqual(dryRun.preservation, {
      canonicalAccountRowsBefore: 1,
      canonicalAccountRowsAfter: 1,
      canonicalRepositoryRowsBefore: 1,
      canonicalRepositoryRowsAfter: 1,
      legacyQuarantineRowsBefore: 158,
      legacyQuarantineRowsAfter: 158,
      legacyRowsPreservedExactly: true,
      legacyQuarantineRowsWithExistingCanonicalPhysicalRepresentation: 0,
      resurrectedLegacyAccountMappings: 0
    });
    assert.equal(dryRun.evidence.materializedRows, 3);
    assert.equal(dryRun.evidence.acceptedRepositoryAttributions, 2);
    assert.equal(dryRun.evidence.acceptedContentAttributions, 1);
    assert.equal(dryRun.evidence.adapterQuarantineRows, 0);
    assert.equal(dryRun.byBatch.S2026.canonicalRepositoriesRefreshed, 1);
    assert.equal(dryRun.byBatch.S2026.newRepositoriesStoredUnpublished, 1);

    const outputDir = join(fixture.root, "staged-output");
    const written = await stageFixture(fixture, { write: true, outputDir });
    assert.equal(written.productionEligible, false);
    const staged = JSON.parse(await readFile(join(outputDir, "github-traction.s2026.staged.json"), "utf8"));
    assert.equal(staged.accounts[0].repos.length, 1);
    assert.equal(staged.accounts[0].repos[0].id, 1);
    assert.equal(staged.accounts[0].repos[0].stars, 9);
    assert.equal(staged.accounts[0].storedButUnpublishedRepos.length, 1);
    assert.equal(staged.accounts[0].storedButUnpublishedRepos[0].id, 2);
    assert.equal(staged.accounts[0].storedButUnpublishedRepos[0].scoringEligible, false);
    const quarantine = JSON.parse(
      await readFile(join(outputDir, "github-traction-quarantine.staged.json"), "utf8")
    );
    assert.equal(quarantine.rows.length, 158);
    assert.deepEqual(quarantine.rows, fixture.legacy.rows);
    assert.equal(
      (await readFile(join(outputDir, "github-exhaustive-stored-evidence-review.ndjson"), "utf8"))
        .trim().split("\n").length,
      2
    );
  });

  it("quarantines a canonical repository identity conflict instead of changing its identity", async () => {
    const fixture = await completedFixture({ canonicalRepositoryUrl: "https://github.com/acme/legacy-one" });
    const receipt = await stageFixture(fixture, { write: false });

    assert.equal(receipt.evidence.acceptedRepositoryAttributions, 1);
    assert.equal(receipt.evidence.adapterQuarantineRows, 1);
    assert.equal(receipt.byBatch.S2026.adapterQuarantines, 1);
    assert.equal(receipt.preservation.canonicalRepositoryRowsBefore, 1);
    assert.equal(receipt.preservation.canonicalRepositoryRowsAfter, 1);
    assert.equal(receipt.preservation.legacyQuarantineRowsAfter, 158);
  });

  it("keeps a proof-bound current canonical representation separate from its failed legacy projection", async () => {
    const fixture = await completedFixture();
    const legacy = structuredClone(fixture.legacy);
    legacy.rows[0] = {
      ...legacy.rows[0],
      batchSlug: "S2026",
      category: "legacy_repository_projection_absent_from_authoritative_targets",
      currentCanonicality: "physical_object_present_but_legacy_account_row_not_canonical",
      physicalRepresentation: {
        kind: "owner",
        canonicalUrl: "https://github.com/acme",
        repositoryId: null,
        status: "represented_in_current_canonical_receipt",
        matchedBy: ["canonical_url"],
        canonicalMatches: [{
          entityType: "company",
          entityId: "company-acme",
          entityName: "Acme",
          accountKey: "company:company-acme:acme:",
          location: "account",
          accountUrl: "https://github.com/acme",
          repositoryId: null,
          repositoryUrl: null
        }],
        repositories: []
      },
      legacyRow: {
        entityType: "company",
        entityId: "company-acme",
        name: "Acme",
        githubUrl: "https://github.com/acme",
        login: "acme",
        repo: null,
        fetched: false,
        error: "404 Not Found"
      }
    };
    await writeFile(fixture.legacyPath, `${JSON.stringify(legacy, null, 2)}\n`);

    const receipt = await stageFixture(fixture, { write: false });
    assert.equal(
      receipt.preservation.legacyQuarantineRowsWithExistingCanonicalPhysicalRepresentation,
      1
    );
    assert.equal(receipt.preservation.resurrectedLegacyAccountMappings, 0);
    assert.equal(receipt.preservation.legacyQuarantineRowsBefore, 158);
    assert.equal(receipt.preservation.legacyQuarantineRowsAfter, 158);
  });
});

async function completedFixture({ canonicalRepositoryUrl = "https://github.com/acme/one" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "github-exhaustive-integration-"));
  const runDir = join(root, "completed-run");
  const canonicalDir = join(root, "canonical-inputs");
  const canonicalPath = join(canonicalDir, "github-traction.json");
  const legacyPath = join(canonicalDir, "github-traction-quarantine.json");
  const canonical = authoritativeSnapshot(canonicalRepositoryUrl);
  const plan = buildGithubExhaustiveTargets(catalogs(), {
    batches: ["S2026"],
    snapshots: [canonical]
  });
  await mkdir(canonicalDir, { recursive: true });
  await Promise.all([
    writeFile(canonicalPath, `${JSON.stringify(canonical, null, 2)}\n`),
    writeFile(legacyPath, `${JSON.stringify(legacyQuarantine(), null, 2)}\n`)
  ]);
  await runGithubExhaustiveBackfill({
    outputDir: runDir,
    plan,
    fetch: githubFixtureFetch,
    activitySince: "2026-07-01T00:00:00.000Z",
    activityUntil: "2026-08-01T00:00:00.000Z",
    limits: { globalConcurrency: 1, requestAttempts: 1, maxHttpAttemptsPerRun: 100 },
    now: () => new Date("2026-08-01T00:00:00.000Z")
  });
  await materializeGithubExhaustiveJournal({
    journalPath: join(runDir, "events.ndjson"),
    outputDir: runDir,
    partitions: 4
  });
  return {
    root,
    runDir,
    canonicalPath,
    legacyPath,
    legacy: JSON.parse(await readFile(legacyPath, "utf8"))
  };
}

async function stageFixture(fixture, { write, outputDir = null }) {
  return stageGithubExhaustiveIntegration({
    runDir: fixture.runDir,
    canonicalSnapshots: [{ batchSlug: "S2026", path: fixture.canonicalPath }],
    legacyQuarantinePath: fixture.legacyPath,
    outputDir,
    write,
    now: () => new Date("2026-08-02T00:00:00.000Z")
  });
}

function catalogs() {
  return [{
    slug: "S2026",
    catalogFile: "fixture.json",
    sourcePath: "/fixture.json",
    companies: [{
      entityType: "company",
      sourceKey: "company-acme",
      name: "Acme",
      profileUrl: "https://accelerator.example/acme",
      accounts: [{
        sourceKey: "account-acme",
        platform: "github",
        url: "https://github.com/acme",
        verified: true,
        reviewState: "verified",
        discoveredFromUrl: "https://accelerator.example/acme",
        matchReason: "Official accelerator profile link."
      }],
      founders: []
    }]
  }];
}

function authoritativeSnapshot(repositoryUrl) {
  return {
    source: {
      batchSlug: "S2026",
      fetchedAt: "2026-08-01T00:00:00Z",
      companyCount: 1,
      totalCompanyCount: 1,
      companyShardCount: 1,
      companyShardIndex: 0,
      targetCount: 1,
      fetchedCount: 1
    },
    accounts: [{
      entityType: "company",
      entityId: "company-acme",
      companySlug: "acme",
      companyName: "Acme",
      name: "Acme",
      githubUrl: "https://github.com/acme",
      login: "acme",
      repo: null,
      fetched: true,
      discoverySource: "yc_profile",
      sourceUrl: "https://accelerator.example/acme",
      matchReason: "Official accelerator profile link.",
      repos: [{
        id: 1,
        name: "one",
        fullName: new URL(repositoryUrl).pathname.slice(1),
        description: "last-good canonical row",
        htmlUrl: repositoryUrl,
        stars: 1,
        forks: 0,
        watchers: 1,
        openIssues: 0,
        language: "TypeScript",
        pushedAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-01T00:00:00Z",
        createdAt: "2025-01-01T00:00:00Z",
        score: 10
      }]
    }]
  };
}

function legacyQuarantine() {
  const rows = Array.from({ length: 158 }, (_, index) => ({
    quarantineId: `legacy-${String(index + 1).padStart(3, "0")}`,
    batchSlug: "S2026",
    category: "legacy_account_mapping_absent_from_authoritative_targets",
    reason: "Fixture legacy row.",
    scoringEligible: false,
    legacyRow: {
      entityType: "company",
      entityId: `legacy-company-${index + 1}`,
      name: `Legacy ${index + 1}`,
      githubUrl: `https://github.com/legacy-${index + 1}`,
      login: `legacy-${index + 1}`,
      repo: null,
      repos: []
    }
  }));
  return {
    source: {
      schemaVersion: 1,
      publicationPolicy: "stored_but_unpublished",
      scoringEligible: false,
      rowCount: rows.length,
      rowsByBatch: { S2026: rows.length },
      sharedPhysicalEvidenceReviewCount: 0
    },
    rows,
    physicalEvidenceOwnerReview: []
  };
}

async function githubFixtureFetch(rawUrl) {
  const url = new URL(rawUrl);
  if (url.pathname === "/users/acme") return json({
    id: 10,
    login: "acme",
    type: "Organization",
    html_url: "https://github.com/acme",
    public_repos: 2,
    followers: 12,
    created_at: "2020-01-01T00:00:00Z",
    updated_at: "2026-07-31T00:00:00Z"
  });
  if (url.pathname === "/orgs/acme/repos") {
    return json([repository(1, "one", 9), repository(2, "two", 4)]);
  }
  if (url.pathname === "/repos/acme/one/releases") return json([{
    id: 11,
    html_url: "https://github.com/acme/one/releases/tag/v11",
    tag_name: "v11",
    draft: false,
    prerelease: false,
    immutable: false,
    published_at: "2026-07-15T00:00:00Z",
    assets: []
  }]);
  if (/^\/repos\/acme\/(?:one|two)\/(?:releases|tags|commits)$/.test(url.pathname)) return json([]);
  throw new Error(`Unexpected GitHub fixture request: ${url.href}`);
}

function repository(id, name, stars) {
  return {
    id,
    name,
    full_name: `acme/${name}`,
    html_url: `https://github.com/acme/${name}`,
    owner: { id: 10, login: "acme", type: "Organization" },
    private: false,
    visibility: "public",
    fork: false,
    archived: false,
    disabled: false,
    default_branch: "main",
    language: "TypeScript",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-07-31T00:00:00Z",
    pushed_at: "2026-07-31T00:00:00Z",
    stargazers_count: stars,
    forks_count: 1,
    watchers_count: stars,
    open_issues_count: 0
  };
}

function json(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-ratelimit-resource": "core",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-used": "1",
      "x-ratelimit-reset": "1785546000"
    }
  });
}
