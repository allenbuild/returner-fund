import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  GithubCollectionPause,
  buildGithubExhaustivePlan,
  buildGithubExhaustiveTargets,
  createGithubRequester,
  materializeGithubExhaustiveJournal,
  runGithubExhaustiveBackfill,
  safeGithubEndpointDescriptor,
  validateRepository
} from "../scripts/lib/github-exhaustive-backfill.mjs";

describe("exhaustive GitHub target planning", () => {
  it("unions verified catalog and whole-receipt mappings without widening repository scope", () => {
    const catalogs = fixtureCatalogs({ sharedFounder: true });
    const snapshot = authoritativeSnapshot([
      snapshotAccount("company-acme", "company", "https://github.com/acme", "yc_profile"),
      snapshotAccount("company-acme", "company", "https://github.com/acme/product", "official_website")
    ]);
    const plan = buildGithubExhaustiveTargets(catalogs, {
      batches: ["S2026"],
      snapshots: [snapshot]
    });

    assert.equal(plan.companiesEvaluated, 1);
    assert.equal(plan.foundersEvaluated, 1);
    assert.equal(plan.verifiedAttributionTasks, 3);
    assert.equal(plan.physicalTargets, 2);
    assert.equal(plan.ownerTargets, 1);
    assert.equal(plan.exactRepositoryTargets, 1);
    assert.equal(plan.catalogVerifiedMappings, 2);
    assert.equal(plan.authoritativeReceiptOnlyMappings, 1);
    assert.equal(plan.multiAttributionReviews, 1);

    const owner = plan.targets.find((target) => target.repo === null);
    const exact = plan.targets.find((target) => target.repo === "product");
    assert.equal(owner.scope, "owner_public_repositories");
    assert.equal(owner.attributions.length, 2);
    assert.equal(owner.requiresAttributionReview, true);
    assert.equal(exact.scope, "exact_repository");
    assert.equal(exact.attributions.length, 1);
    assert.deepEqual(
      plan.attributionReviews[0].attributionTaskKeys,
      owner.attributions.map((row) => row.taskKey)
    );
  });

  it("fails closed on partial receipts, search-only attribution, and unknown entities", () => {
    const catalogs = fixtureCatalogs();
    const partial = authoritativeSnapshot([
      snapshotAccount("company-acme", "company", "https://github.com/acme", "yc_profile")
    ]);
    partial.source.fetchedCount = 0;
    assert.throws(
      () => buildGithubExhaustiveTargets(catalogs, { batches: ["S2026"], snapshots: [partial] }),
      /not a whole-cohort authoritative receipt/
    );

    const search = authoritativeSnapshot([
      snapshotAccount("company-acme", "company", "https://github.com/acme", "github_search")
    ]);
    assert.throws(
      () => buildGithubExhaustiveTargets(catalogs, { batches: ["S2026"], snapshots: [search] }),
      /non-verifying discovery source github_search/
    );

    const unknown = authoritativeSnapshot([
      snapshotAccount("company-unknown", "company", "https://github.com/unknown", "official_website")
    ]);
    assert.throws(
      () => buildGithubExhaustiveTargets(catalogs, { batches: ["S2026"], snapshots: [unknown] }),
      /references unknown entity/
    );
  });

  it("reconciles the live plan exactly to every current authoritative target", async () => {
    const plan = await buildGithubExhaustivePlan(process.cwd());
    const expectedByBatch = new Map([
      ["S2026", "src/lib/social/github-traction.json"],
      ["S26", "src/lib/social/github-traction-summer-2026.json"],
      ["A16ZSR006", "src/lib/social/github-traction-a16z-speedrun-006.json"]
    ]);
    let expectedTasks = 0;
    for (const [batchSlug, path] of expectedByBatch) {
      const snapshot = JSON.parse(await readFile(path, "utf8"));
      expectedTasks += snapshot.source.targetCount;
      assert.equal(
        plan.attributionTasks.filter((task) => task.batchSlug === batchSlug).length,
        snapshot.source.targetCount
      );
    }
    assert.equal(plan.companiesEvaluated, 427);
    assert.equal(plan.foundersEvaluated, 858);
    assert.equal(plan.canonicalOwnersEvaluated, 1_285);
    assert.equal(plan.verifiedAttributionTasks, expectedTasks);
    assert.equal(plan.catalogVerifiedMappings + plan.authoritativeReceiptOnlyMappings, expectedTasks);
    assert.ok(plan.physicalTargets <= plan.verifiedAttributionTasks);
    assert.equal(new Set(plan.attributionTasks.map((task) => task.taskKey)).size, expectedTasks);
  });
});

describe("exhaustive GitHub collection", () => {
  it("exhausts owner/release/tag/activity pages while rejecting token-visible private and non-owner rows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "github-exhaustive-complete-"));
    const plan = singleTargetPlan();
    const requested = [];
    const fetchImplementation = async (rawUrl, options) => {
      const url = new URL(rawUrl);
      requested.push({ url: url.href, authorization: options.headers.authorization ?? null });
      const headers = rateHeaders();
      if (url.pathname === "/users/acme") return json(profile(), { headers });
      if (url.pathname === "/orgs/acme/repos" && !url.searchParams.has("page")) {
        headers.set(
          "link",
          '<https://api.github.com/orgs/acme/repos?type=public&sort=full_name&direction=asc&per_page=100&page=2>; rel="next"'
        );
        return json([
          repository(1, "one"),
          repository(99, "token-secret-private", { private: true, visibility: "private" }),
          repository(98, "member-repository", { owner: { id: 777, login: "elsewhere", type: "Organization" } })
        ], { headers });
      }
      if (url.pathname === "/orgs/acme/repos" && url.searchParams.get("page") === "2") {
        return json([repository(2, "forked", { fork: true })], { headers });
      }
      if (url.pathname === "/repos/acme/one/releases") {
        return json([
          release(11),
          { ...release(12), draft: true, name: "token-secret-draft" }
        ], { headers });
      }
      if (url.pathname === "/repos/acme/one/tags") return json([tag("v1.0.0", "a".repeat(40))], { headers });
      if (url.pathname === "/repos/acme/one/commits") return json([commit("b".repeat(40))], { headers });
      if (url.pathname === "/repos/acme/forked/releases") return json([], { headers });
      if (url.pathname === "/repos/acme/forked/tags") return json([], { headers });
      throw new Error(`Unexpected test request: ${url.href}`);
    };

    const summary = await runGithubExhaustiveBackfill({
      outputDir: directory,
      plan,
      token: "token-must-never-be-written",
      fetch: fetchImplementation,
      activitySince: "2026-07-01T00:00:00.000Z",
      activityUntil: "2026-08-01T00:00:00.000Z",
      limits: { globalConcurrency: 1, requestAttempts: 1, maxHttpAttemptsPerRun: 100 },
      now: fixedClock("2026-08-01T00:00:00.000Z")
    });

    assert.equal(summary.status, "completed");
    assert.equal(summary.terminalPhysicalTargets, 1);
    assert.equal(summary.terminalAttributionTasks, 1);
    assert.equal(summary.byOutcome.collected, 1);
    assert.equal(requested.length, 8);
    assert.ok(requested.every((request) => request.authorization === "Bearer token-must-never-be-written"));
    assert.ok(!requested.some((request) => /forked\/commits/.test(request.url)));

    const journalText = await readFile(join(directory, "events.ndjson"), "utf8");
    assert.doesNotMatch(journalText, /token-must-never-be-written|token-secret-private|token-secret-draft/);
    const events = journalText.trim().split("\n").map(JSON.parse);
    const evidence = events.flatMap((event) => event.evidence ?? []);
    assert.deepEqual(
      [...new Set(evidence.map((row) => row.kind))].sort(),
      ["github_commit", "github_release", "github_repository", "github_tag"]
    );
    assert.equal(evidence.filter((row) => row.kind === "github_repository").length, 2);
    assert.ok(evidence.every((row) => row.scoringEligible === false));
    assert.ok(evidence.every((row) => row.publicationState === "stored_but_unpublished"));
    const repositoryPages = events.filter((event) => event.type === "repository_page_committed");
    assert.equal(repositoryPages.at(-1).page.sourceExhausted, true);
    assert.equal(repositoryPages[0].page.rejectedNonPublic, 1);
    assert.equal(repositoryPages[0].page.rejectedOwnershipMismatch, 1);
    const requestReceipts = events.filter((event) => event.type === "request_receipt");
    assert.equal(requestReceipts.length, 8);
    assert.ok(requestReceipts.every((event) => event.receipt.attempts.length === 1));
    assert.ok(requestReceipts.every((event) => !JSON.stringify(event).includes("authorization")));
  });

  it("pauses at the per-run request budget and resumes without refetching completed profile state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "github-exhaustive-resume-"));
    const plan = singleTargetPlan();
    const requested = [];
    const fetchImplementation = async (rawUrl) => {
      const url = new URL(rawUrl);
      requested.push(url.href);
      if (url.pathname === "/users/acme") return json(profile());
      if (url.pathname === "/orgs/acme/repos") return json([repository(1, "one")]);
      if (/\/repos\/acme\/one\/(?:releases|tags|commits)$/.test(url.pathname)) return json([]);
      throw new Error(`Unexpected test request: ${url.href}`);
    };
    const common = {
      outputDir: directory,
      plan,
      fetch: fetchImplementation,
      activitySince: "2026-07-01T00:00:00.000Z",
      activityUntil: "2026-08-01T00:00:00.000Z",
      now: fixedClock("2026-08-01T00:00:00.000Z")
    };
    const first = await runGithubExhaustiveBackfill({
      ...common,
      limits: { globalConcurrency: 1, requestAttempts: 1, maxHttpAttemptsPerRun: 1 }
    });
    assert.equal(first.status, "incomplete_resumable");
    assert.equal(first.pausedPhysicalTargets, 1);
    assert.equal(first.httpAttemptsThisInvocation, 1);

    const resumed = await runGithubExhaustiveBackfill({
      ...common,
      resume: true,
      limits: { globalConcurrency: 1, requestAttempts: 1, maxHttpAttemptsPerRun: 100 }
    });
    assert.equal(resumed.status, "completed");
    assert.equal(requested.filter((url) => new URL(url).pathname === "/users/acme").length, 1);
    assert.equal(requested.length, 5);

    const materialized = await materializeGithubExhaustiveJournal({
      journalPath: join(directory, "events.ndjson"),
      outputDir: directory,
      partitions: 8
    });
    assert.equal(materialized.evidenceRows, 1);
    assert.equal(materialized.quarantinedPhysicalIdentities, 0);
  });

  it("records exact rate-limit receipts and opens a no-request circuit", async () => {
    const receipts = [];
    let calls = 0;
    const requester = createGithubRequester({
      fetchImplementation: async () => {
        calls += 1;
        return new Response(null, {
          status: 403,
          statusText: "rate limited",
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-used": "5000",
            "x-ratelimit-resource": "core",
            "x-ratelimit-reset": "1785542460"
          }
        });
      },
      limits: { requestAttempts: 1, maxHttpAttemptsPerRun: 10 },
      now: fixedClock("2026-08-01T00:00:00.000Z"),
      onReceipt: async (receipt) => receipts.push(receipt)
    });
    await assert.rejects(
      requester.get("https://api.github.com/users/acme", { targetKey: "github:acme", resource: "profile" }),
      /rate limit exhausted/
    );
    await assert.rejects(
      requester.get("https://api.github.com/users/other", { targetKey: "github:other", resource: "profile" }),
      (error) => error instanceof GithubCollectionPause
    );
    assert.equal(calls, 1);
    assert.equal(receipts.length, 2);
    assert.equal(receipts[0].status, "failed");
    assert.equal(receipts[0].blocker.code, "github_rate_limit_exhausted");
    assert.equal(receipts[0].blocker.retryAt, "2026-08-01T00:01:00.000Z");
    assert.deepEqual(receipts[0].endpoint, { pathname: "/users/acme", query: {} });
    assert.equal(receipts[1].status, "blocked_without_request");
    assert.deepEqual(receipts[1].attempts, []);
  });
});

describe("GitHub exhaustive integrity helpers", () => {
  it("rejects non-public, member, and redirected exact repository objects", () => {
    const account = profile();
    const ownerTarget = { login: "acme", repo: null };
    assert.equal(validateRepository(repository(1, "private", { private: true }), account, ownerTarget).reason, "not_public");
    assert.equal(
      validateRepository(repository(2, "member", { owner: { id: 22, login: "other" } }), account, ownerTarget).blocker.code,
      "github_repository_owner_mismatch"
    );
    assert.equal(
      validateRepository(repository(3, "renamed"), account, { login: "acme", repo: "old-name" }).blocker.code,
      "github_mapped_repository_redirect_or_transfer"
    );
  });

  it("retains only allowlisted query fields in exact secret-free endpoint receipts", () => {
    assert.deepEqual(
      safeGithubEndpointDescriptor(
        "https://api.github.com/repos/acme/tool/commits?until=2026-08-01T00%3A00%3A00Z&per_page=100&since=2026-07-01T00%3A00%3A00Z"
      ),
      {
        pathname: "/repos/acme/tool/commits",
        query: {
          per_page: "100",
          since: "2026-07-01T00:00:00Z",
          until: "2026-08-01T00:00:00Z"
        }
      }
    );
    assert.throws(
      () => safeGithubEndpointDescriptor("https://api.github.com/users/acme?access_token=secret"),
      /unrecognized GitHub API query parameter/
    );
    assert.throws(
      () => safeGithubEndpointDescriptor("https://evil.example/users/acme?page=1"),
      /outside https:\/\/api.github.com/
    );
  });

  it("materializes deterministic unions and quarantines physical identity conflicts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "github-exhaustive-materialize-"));
    const journalPath = join(directory, "events.ndjson");
    const shared = evidence("github:repository:1", "https://github.com/acme/one", "task-a", "2026-08-01T00:00:00Z");
    const later = {
      ...shared,
      observedAt: "2026-08-02T00:00:00Z",
      metrics: { stars: 2 },
      attributions: [{ taskKey: "task-b", batchSlug: "S26", entityType: "company", entityId: "company-b" }]
    };
    const conflictOne = evidence("github:repository:2", "https://github.com/acme/two", "task-a", "2026-08-01T00:00:00Z");
    const conflictTwo = { ...conflictOne, canonicalUrl: "https://github.com/acme/renamed" };
    await writeFile(journalPath, [
      JSON.stringify({ schemaVersion: 1, sequence: 1, type: "run_initialized", configFingerprint: "fixture-fingerprint" }),
      JSON.stringify({ schemaVersion: 1, sequence: 2, evidence: [shared, conflictOne] }),
      JSON.stringify({ schemaVersion: 1, sequence: 3, evidence: [later, conflictTwo] })
    ].join("\n") + "\n");

    const summary = await materializeGithubExhaustiveJournal({
      journalPath,
      outputDir: directory,
      partitions: 4
    });
    assert.deepEqual(
      {
        raw: summary.rawEvidenceRows,
        evidence: summary.evidenceRows,
        quarantine: summary.quarantinedPhysicalIdentities,
        duplicates: summary.duplicateRowsMerged
      },
      { raw: 4, evidence: 1, quarantine: 1, duplicates: 2 }
    );
    const merged = JSON.parse((await readFile(join(directory, "evidence-deduped.ndjson"), "utf8")).trim());
    assert.equal(merged.metrics.stars, 2);
    assert.deepEqual(merged.attributions.map((row) => row.taskKey), ["task-a", "task-b"]);
    assert.equal(merged.requiresAttributionReview, true);
    const quarantined = JSON.parse((await readFile(join(directory, "evidence-quarantine.ndjson"), "utf8")).trim());
    assert.equal(quarantined.reason, "github_physical_identity_conflict");
    assert.equal(quarantined.scoringEligible, false);
  });
});

function fixtureCatalogs({ sharedFounder = false } = {}) {
  const companyAccount = verifiedAccount("https://github.com/acme", "company");
  return [{
    slug: "S2026",
    catalogFile: "fixtures/s2026.json",
    sourcePath: "/fixtures/s2026.json",
    companies: [{
      entityType: "company",
      sourceKey: "company-acme",
      name: "Acme",
      profileUrl: "https://accelerator.example/acme",
      accounts: [companyAccount],
      founders: [{
        entityType: "founder",
        sourceKey: "founder-acme-ada-1",
        companySourceKey: "company-acme",
        name: "Ada",
        accounts: sharedFounder ? [verifiedAccount("https://github.com/acme", "founder")] : []
      }]
    }]
  }];
}

function verifiedAccount(url, suffix) {
  return {
    sourceKey: `account-${suffix}`,
    platform: "github",
    url,
    verified: true,
    reviewState: "verified",
    discoveredFromUrl: "https://accelerator.example/acme",
    matchReason: "Explicit official profile mapping."
  };
}

function authoritativeSnapshot(accounts) {
  return {
    source: {
      batchSlug: "S2026",
      fetchedAt: "2026-08-01T00:00:00Z",
      companyCount: 1,
      totalCompanyCount: 1,
      companyShardCount: 1,
      companyShardIndex: 0,
      targetCount: accounts.length,
      fetchedCount: accounts.length
    },
    accounts
  };
}

function snapshotAccount(entityId, entityType, githubUrl, discoverySource) {
  const parsed = new URL(githubUrl).pathname.split("/").filter(Boolean);
  return {
    entityType,
    entityId,
    companySlug: "acme",
    companyName: "Acme",
    name: "Acme",
    githubUrl,
    login: parsed[0],
    repo: parsed[1] ?? null,
    fetched: true,
    discoverySource,
    sourceUrl: "https://acme.example",
    matchReason: "GitHub URL linked by an official public source."
  };
}

function singleTargetPlan() {
  return buildGithubExhaustiveTargets(fixtureCatalogs(), {
    batches: ["S2026"],
    snapshots: [authoritativeSnapshot([
      snapshotAccount("company-acme", "company", "https://github.com/acme", "yc_profile")
    ])]
  });
}

function profile() {
  return {
    id: 10,
    login: "acme",
    type: "Organization",
    html_url: "https://github.com/acme",
    public_repos: 2,
    followers: 12,
    created_at: "2020-01-01T00:00:00Z",
    updated_at: "2026-07-31T00:00:00Z"
  };
}

function repository(id, name, overrides = {}) {
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
    stargazers_count: 3,
    forks_count: 1,
    watchers_count: 3,
    open_issues_count: 0,
    ...overrides
  };
}

function release(id) {
  return {
    id,
    html_url: `https://github.com/acme/one/releases/tag/v${id}`,
    tag_name: `v${id}`,
    draft: false,
    prerelease: false,
    immutable: false,
    published_at: "2026-07-15T00:00:00Z",
    assets: [{ download_count: 5 }]
  };
}

function tag(name, sha) {
  return { name, commit: { sha } };
}

function commit(sha) {
  return {
    sha,
    html_url: `https://github.com/acme/one/commit/${sha}`,
    author: { login: "contributor" },
    committer: { login: "contributor" },
    commit: {
      author: { date: "2026-07-20T00:00:00Z" },
      committer: { date: "2026-07-20T00:00:00Z" }
    }
  };
}

function json(value, { status = 200, headers = rateHeaders() } = {}) {
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { status, headers });
}

function rateHeaders() {
  return new Headers({
    "x-ratelimit-resource": "core",
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": "4999",
    "x-ratelimit-used": "1",
    "x-ratelimit-reset": "1785546000"
  });
}

function fixedClock(timestamp) {
  return () => new Date(timestamp);
}

function evidence(evidenceId, canonicalUrl, taskKey, observedAt) {
  return {
    evidenceId,
    kind: "github_repository",
    nativeId: evidenceId.split(":").at(-1),
    canonicalUrl,
    observedAt,
    metrics: { stars: 1 },
    physicalRepository: {
      repositoryId: evidenceId.split(":").at(-1),
      fullName: new URL(canonicalUrl).pathname.slice(1),
      canonicalUrl
    },
    attributions: [{ taskKey, batchSlug: "S2026", entityType: "company", entityId: "company-a" }],
    requiresAttributionReview: false,
    scoringEligible: false,
    publicationState: "stored_but_unpublished"
  };
}
