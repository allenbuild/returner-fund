import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTONOMOUS_PLATFORMS,
  buildAutonomousTaskPlan,
  loadAutonomousCatalogs,
  mergeGithubTractionSnapshots,
  mergePublicEvidenceSnapshots,
  summarizeTaskCoverage
} from "../scripts/lib/autonomous-ingestion-plan.mjs";

const repositoryRoot = process.cwd();

describe("autonomous ingestion planning against the published catalogs", () => {
  it("loads the exact company, founder, and account counts from every real graph", async () => {
    const catalogs = await loadAutonomousCatalogs(repositoryRoot);

    assert.deepEqual(catalogs.map(summarizeCatalog), [
      { slug: "S2026", companies: 197, founders: 397, accounts: 957 },
      { slug: "S26", companies: 83, founders: 165, accounts: 402 },
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

    assert.equal(expectedEntityCount, 1_029);
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
      collector_not_applicable_to_founder: 4_140,
      collector_not_available: 3_087,
      missing_account_mapping: 1_907,
      queued: 4_243
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
      expected: 13_377,
      queued: 4_243,
      terminal: 9_134,
      missingMappings: 1_907,
      unsupported: 7_227
    });
    for (const platform of AUTONOMOUS_PLATFORMS) {
      assert.equal(coverage.byPlatform[platform].expected, 1_029);
    }
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
