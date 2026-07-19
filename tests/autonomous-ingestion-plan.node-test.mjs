import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTONOMOUS_PLATFORMS,
  AUTONOMOUS_PROCESS_BUDGETS,
  buildAutonomousTaskPlan,
  loadAutonomousCatalogs,
  maxAutonomousRunnerProcessBudgetMs,
  mergeGithubTractionSnapshots,
  mergePublicEvidenceSnapshots,
  normalizeAutonomousFailureEntityId,
  summarizeTaskCoverage,
  validateAutonomousCollectorSnapshot
} from "../scripts/lib/autonomous-ingestion-plan.mjs";

const repositoryRoot = process.cwd();

describe("autonomous ingestion planning against the collector catalogs", () => {
  it("loads the exact company, founder, and account counts from every real catalog", async () => {
    const catalogs = await loadAutonomousCatalogs(repositoryRoot);

    assert.deepEqual(catalogs.map(summarizeCatalog), [
      { slug: "S2026", companies: 197, founders: 397, accounts: 948 },
      { slug: "S26", companies: 115, founders: 228, accounts: 548 },
      { slug: "A16ZSR006", companies: 59, founders: 128, accounts: 328 }
    ]);
  });

  it("deterministically covers every company and founder on every platform exactly once", async () => {
    const catalogs = await loadAutonomousCatalogs(repositoryRoot);
    const first = buildAutonomousTaskPlan(catalogs, { runKey: "catalog-contract" });
    const second = buildAutonomousTaskPlan([...catalogs].reverse(), { runKey: "catalog-contract" });
    const expectedEntityCount = catalogs.reduce(
      (count, catalog) => count + catalog.companies.length + catalog.companies.flatMap((company) => company.founders).length,
      0
    );

    assert.equal(expectedEntityCount, 1_124);
    assert.deepEqual(first, second);
    assert.equal(first.length, expectedEntityCount * AUTONOMOUS_PLATFORMS.length);
    assert.equal(new Set(first.map((task) => task.checkpointKey)).size, first.length);
    assert.deepEqual(first.map((task) => task.checkpointKey),
      [...first.map((task) => task.checkpointKey)].sort((left, right) => left.localeCompare(right))
    );

    const platformsByEntity = new Map();
    for (const task of first) {
      const entityKey = `${task.batchSlug}:${task.entityType}:${task.entitySourceKey}`;
      const platforms = platformsByEntity.get(entityKey) ?? [];
      platforms.push(task.platform);
      platformsByEntity.set(entityKey, platforms);
    }
    assert.equal(platformsByEntity.size, expectedEntityCount);
    for (const platforms of platformsByEntity.values()) {
      assert.deepEqual(platforms.sort(), [...AUTONOMOUS_PLATFORMS].sort());
    }
  });

  it("makes every unavailable task explicitly terminal and reports exact coverage", async () => {
    const tasks = buildAutonomousTaskPlan(await loadAutonomousCatalogs(repositoryRoot), {
      runKey: "terminal-contract"
    });
    const reasonCounts = countBy(tasks, (task) => task.terminalReason ?? "queued");

    assert.deepEqual(reasonCounts, {
      collector_not_applicable_to_founder: 4_518,
      collector_not_available: 3_372,
      missing_account_mapping: 2_089,
      queued: 4_633
    });
    assert.ok(tasks.filter((task) => task.status === "queued").every((task) => task.terminalReason === null));
    assert.ok(tasks.filter((task) => task.status !== "queued").every((task) => Boolean(task.terminalReason)));

    const coverage = summarizeTaskCoverage(tasks);
    assert.deepEqual({
      expected: coverage.expected,
      queued: coverage.queued,
      terminal: coverage.terminal,
      missingMappings: coverage.missingMappings,
      unsupported: coverage.unsupported
    }, {
      expected: 14_612,
      queued: 4_633,
      terminal: 9_979,
      missingMappings: 2_089,
      unsupported: 7_890
    });
    for (const platform of AUTONOMOUS_PLATFORMS) {
      assert.equal(coverage.byPlatform[platform].expected, 1_124);
    }
  });

  it("keeps process retries, durable persistence, and lock-release headroom below the workflow timeout", () => {
    const runnerTimeoutMs = 95 * 60_000;

    assert.equal(AUTONOMOUS_PROCESS_BUDGETS.collectorAttempts, 2);
    assert.equal(AUTONOMOUS_PROCESS_BUDGETS.durablePersistenceHeadroomMs, 25 * 60_000);
    assert.equal(AUTONOMOUS_PROCESS_BUDGETS.lockReleaseHeadroomMs, 2 * 60_000);
    assert.ok(maxAutonomousRunnerProcessBudgetMs() < runnerTimeoutMs);
  });
});

describe("autonomous collector snapshot validation", () => {
  const fetchedAt = "2026-07-19T12:00:00.000Z";
  const publicSnapshot = {
    source: {
      label: "Public unauthenticated platform/page ingestion",
      batchSlug: "S26",
      fetchedAt
    },
    evidence: [],
    needsReview: [],
    failures: [{ platform: "web", companySlug: "acme", entityId: "company-acme" }]
  };
  const githubSnapshot = {
    source: {
      label: "GitHub public API for official YC Summer 2026 GitHub links",
      batchSlug: "S26",
      sourcePath: "src/lib/yc/summer-2026-companies.json",
      fetchedAt
    },
    accounts: [{ entityType: "company", entityId: "company-acme", fetched: true }]
  };

  it("accepts non-empty snapshots with exact batch and source metadata", () => {
    assert.equal(
      validateAutonomousCollectorSnapshot(publicSnapshot, { kind: "public", batchSlug: "S26" }),
      publicSnapshot
    );
    assert.equal(validateAutonomousCollectorSnapshot(githubSnapshot, {
      kind: "github",
      batchSlug: "S26",
      expectedSourcePath: "src/lib/yc/summer-2026-companies.json"
    }), githubSnapshot);
  });

  it("rejects empty, stale, wrong-batch, and wrong-source snapshots", () => {
    assert.throws(
      () => validateAutonomousCollectorSnapshot(
        { ...publicSnapshot, evidence: [], needsReview: [], failures: [] },
        { kind: "public", batchSlug: "S26" }
      ),
      /collector output is empty/
    );
    assert.throws(
      () => validateAutonomousCollectorSnapshot(publicSnapshot, { kind: "public", batchSlug: "S2026" }),
      /expected batch S2026/
    );
    assert.throws(
      () => validateAutonomousCollectorSnapshot(githubSnapshot, {
        kind: "github",
        batchSlug: "S26",
        expectedSourcePath: "src/lib/yc/spring-2026-companies.json"
      }),
      /expected source path/
    );
    assert.throws(
      () => validateAutonomousCollectorSnapshot(publicSnapshot, {
        kind: "public",
        batchSlug: "S26",
        notBefore: Date.parse(fetchedAt) + 1
      }),
      /predates this collector attempt/
    );
  });
});

describe("autonomous collector failure identities", () => {
  it("normalizes A16Z company and founder failures to task-plan entity IDs", () => {
    assert.equal(normalizeAutonomousFailureEntityId({
      entityType: "company",
      entityId: "company-acceler8",
      companySlug: "acceler8"
    }, { batchSlug: "A16ZSR006" }), "a16z-speedrun-006-acceler8");
    assert.equal(normalizeAutonomousFailureEntityId({
      entityType: "founder",
      entityId: "founder-acceler8-chinmay-chauhan-a16z-speedrun-006-acceler8-founder-chinmay-chauhan",
      companySlug: "acceler8",
      entityName: "Chinmay Chauhan"
    }, { batchSlug: "A16ZSR006" }), "a16z-speedrun-006-acceler8-founder-chinmay-chauhan");
  });

  it("leaves other batch entity IDs unchanged", () => {
    assert.equal(normalizeAutonomousFailureEntityId({
      entityId: "company-acme",
      companySlug: "acme"
    }, { batchSlug: "S26" }), "company-acme");
  });
});

describe("autonomous public evidence merge", () => {
  it("deduplicates evidence and review/failure rows while preserving the newest observation", () => {
    const newer = {
      source: { batchSlug: "S26" },
      evidence: [
        {
          platform: "x",
          sourceUrl: "https://x.com/acme/status/42/",
          last_checked_at: "2026-07-18T14:00:00.000Z",
          marker: "new-canonical-url"
        },
        {
          platform: "github",
          platformObjectId: "repo-7",
          sourceUrl: "https://github.com/acme/new-location",
          last_checked_at: "2026-07-18T13:00:00.000Z",
          marker: "new-native-id"
        }
      ],
      needsReview: [{ id: "review-1", last_checked_at: "2026-07-18T12:00:00.000Z", marker: "new-review" }],
      failures: [{ id: "failure-1", checkedAt: "2026-07-18T11:00:00.000Z", marker: "new-failure" }]
    };
    const older = {
      source: { batchSlug: "S2026" },
      evidence: [
        {
          platform: "twitter",
          sourceUrl: "https://www.twitter.com/acme/status/42?utm_source=old#fragment",
          last_checked_at: "2026-07-17T14:00:00.000Z",
          marker: "old-canonical-url"
        },
        {
          platform: "github",
          platformObjectId: "repo-7",
          sourceUrl: "https://github.com/acme/old-location",
          last_checked_at: "2026-07-17T13:00:00.000Z",
          marker: "old-native-id"
        }
      ],
      needsReview: [{ id: "review-1", last_checked_at: "2026-07-17T12:00:00.000Z", marker: "old-review" }],
      failures: [{ id: "failure-1", checkedAt: "2026-07-17T11:00:00.000Z", marker: "old-failure" }]
    };

    const merged = mergePublicEvidenceSnapshots([newer, older], {
      fetchedAt: "2026-07-18T15:00:00.000Z"
    });

    assert.deepEqual({
      fetchedAt: merged.source.fetchedAt,
      batchSlugs: merged.source.batchSlugs,
      evidenceCount: merged.source.evidenceCount,
      needsReviewCount: merged.source.needsReviewCount,
      failureCount: merged.source.failureCount
    }, {
      fetchedAt: "2026-07-18T15:00:00.000Z",
      batchSlugs: ["S26", "S2026"],
      evidenceCount: 2,
      needsReviewCount: 1,
      failureCount: 1
    });
    assert.deepEqual({
      evidence: merged.evidence.map((row) => row.marker).sort(),
      needsReview: merged.needsReview.map((row) => row.marker),
      failures: merged.failures.map((row) => row.marker)
    }, {
      evidence: ["new-canonical-url", "new-native-id"],
      needsReview: ["new-review"],
      failures: ["new-failure"]
    }, "dedupe must compare the timestamp fields emitted by the public collector");
  });

  it("marks file-backed publication when durable Supabase import is not configured", () => {
    const merged = mergePublicEvidenceSnapshots(
      [{ source: { batchSlug: "S26" }, evidence: [], needsReview: [], failures: [] }],
      { durableStorageConfigured: false }
    );

    assert.match(merged.source.notes.join(" "), /Durable Supabase import was skipped/);
    assert.match(merged.source.notes.join(" "), /file-backed/);
    assert.doesNotMatch(merged.source.notes.join(" "), /imported validated evidence/);
  });
});

describe("autonomous GitHub evidence merge", () => {
  it("retains last-good accounts when a fresh target refresh fails", () => {
    const previous = {
      source: { batchSlug: "S26" },
      accounts: [
        { entityType: "company", entityId: "company-1", login: "acme", repo: null, fetched: true, marker: "good" }
      ]
    };
    const fresh = {
      source: { batchSlug: "S26" },
      accounts: [
        { entityType: "company", entityId: "company-1", login: "acme", repo: null, fetched: false, marker: "failed" },
        { entityType: "company", entityId: "company-2", login: "newco", repo: null, fetched: true, marker: "new" }
      ]
    };

    const merged = mergeGithubTractionSnapshots(previous, fresh, {
      fetchedAt: "2026-07-18T15:00:00.000Z"
    });

    assert.equal(merged.source.retainedLastGood, 1);
    assert.deepEqual(merged.accounts.map((row) => row.marker).sort(), ["good", "new"]);
  });
});

function summarizeCatalog(catalog) {
  return {
    slug: catalog.slug,
    companies: catalog.companies.length,
    founders: catalog.companies.reduce((count, company) => count + company.founders.length, 0),
    accounts: catalog.companies.reduce(
      (count, company) =>
        count +
        company.accounts.length +
        company.founders.reduce((founderCount, founder) => founderCount + founder.accounts.length, 0),
      0
    )
  };
}

function countBy(values, keyForValue) {
  return Object.fromEntries(
    [...values.reduce((counts, value) => {
      const key = keyForValue(value);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return counts;
    }, new Map())].sort(([left], [right]) => left.localeCompare(right))
  );
}
