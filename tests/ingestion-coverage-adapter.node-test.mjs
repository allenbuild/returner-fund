import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  INGESTION_COVERAGE_ADAPTER_VERSION,
  adaptAutonomousIngestionCoverage,
  normalizeAutonomousIngestionCatalogs,
  sha256IngestionCoverageArtifact
} from "../scripts/lib/ingestion-coverage-adapter.mjs";
import {
  INGESTION_CATALOG_MANIFEST_VERSION,
  buildIngestionCoverageReceipt
} from "../scripts/lib/ingestion-coverage-receipt.mjs";

const STARTED_AT = "2026-08-02T18:20:00.000Z";
const CHECKED_AT = "2026-08-02T18:29:00.000Z";
const COMPLETED_AT = "2026-08-02T18:30:00.000Z";
const GENERATED_AT = "2026-08-02T18:31:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_D = "d".repeat(64);

function liveCatalog({ accounts = [], founders = [] } = {}) {
  return [{
    slug: "TEST",
    sourcePath: "fixtures/live-test-catalog.json",
    generatedAt: "2026-08-02T18:00:00.000Z",
    companies: [{
      entityType: "company",
      sourceKey: "company-acme",
      name: "Acme",
      accounts,
      founders
    }]
  }];
}

function manifestFor(catalogs) {
  const normalized = normalizeAutonomousIngestionCatalogs(catalogs);
  return {
    version: INGESTION_CATALOG_MANIFEST_VERSION,
    batches: normalized.map((catalog) => {
      const founders = catalog.companies.reduce(
        (sum, company) => sum + company.founders.length,
        0
      );
      return {
        batchSlug: catalog.batchSlug,
        sourcePath: catalog.sourcePath,
        sourceVersion: catalog.sourceVersion,
        sourceHash: catalog.sourceHash,
        companies: catalog.companies.length,
        founders,
        entities: catalog.companies.length + founders
      };
    })
  };
}

function planTask({
  platform = "x",
  account = null,
  taskKey = `run:TEST:company:company-acme:${platform}:discovery`
} = {}) {
  return {
    batchSlug: "TEST",
    companySourceKey: "company-acme",
    entityType: "company",
    entitySourceKey: "company-acme",
    platform,
    account,
    checkpointKey: taskKey,
    status: "queued",
    terminalReason: null
  };
}

function runnerLogs({ collectionResults = [] } = {}) {
  return [
    {
      eventType: "run.started",
      createdAt: STARTED_AT,
      severity: "info",
      message: "Autonomous ingestion run started.",
      payload: {}
    },
    {
      eventType: "collection.finished",
      createdAt: CHECKED_AT,
      severity: "info",
      message: "Collector processes reached terminal states.",
      payload: { results: collectionResults }
    },
    {
      eventType: "run.completed",
      createdAt: COMPLETED_AT,
      severity: "info",
      message: "Autonomous ingestion completed.",
      payload: {}
    }
  ];
}

function artifact(kind, sha256, path, observedAt = CHECKED_AT) {
  return { kind, artifact: { path, sha256, observedAt } };
}

function publicSnapshot({
  attempt = {},
  evidence = [],
  needsReview = [],
  failures = []
} = {}) {
  return {
    source: { batchSlug: "TEST", fetchedAt: CHECKED_AT },
    attempts: {
      "x:company:company-acme:missing-url": {
        attemptKey: "x:company:company-acme:missing-url",
        batchSlug: "TEST",
        entityType: "company",
        entityId: "company-acme",
        platform: "x",
        accountUrl: null,
        status: "done",
        outcomeStatus: "completed",
        outcomeReason: "collector_evidence_collected",
        checkedAt: CHECKED_AT,
        retryable: false,
        ...attempt
      }
    },
    evidence,
    needsReview,
    failures
  };
}

function nativeXEvidence(overrides = {}) {
  return {
    id: "x-company-acme-42",
    batchSlug: "TEST",
    entityType: "company",
    entityId: "company-acme",
    platform: "x",
    sourceUrl: "https://x.com/acme/status/42",
    platformPostId: "42",
    accountUrl: "https://x.com/acme",
    title: "Acme shipped a native update",
    text: "Acme shipped a native update with exact public evidence.",
    postedAt: "2026-08-02T18:00:00.000Z",
    last_checked_at: CHECKED_AT,
    review_state: "verified",
    metrics: { likes: 12 },
    ...overrides
  };
}

async function adapt({
  catalogs = liveCatalog(),
  taskPlan = [planTask()],
  collectorArtifacts = [],
  logs = runnerLogs(),
  overrides = {}
} = {}) {
  return adaptAutonomousIngestionCoverage({
    runId: "run-test-1",
    idempotencyKey: "idempotency-test-1",
    campaignKey: "campaign-test-1",
    generatedAt: GENERATED_AT,
    catalogs,
    expectedCatalogManifest: manifestFor(catalogs),
    taskPlan,
    collectorArtifacts,
    runnerLogs: logs,
    runnerLogArtifact: {
      path: "runner-events.ndjson",
      sha256: HASH_D,
      observedAt: GENERATED_AT
    },
    ...overrides
  });
}

describe("autonomous ingestion coverage adapter", () => {
  it("folds a discovered account into its URL-less plan task without double-counting", async () => {
    const envelope = {
      ...artifact("public", HASH_A, "public-test.json"),
      snapshot: publicSnapshot({
        attempt: { accountUrl: "https://x.com/acme" },
        evidence: [nativeXEvidence()]
      })
    };
    const normalized = await adapt({ collectorArtifacts: [envelope] });

    assert.equal(normalized.tasks.length, 1);
    assert.equal(normalized.tasks[0].taskKey, planTask().checkpointKey);
    assert.equal(normalized.tasks[0].account, undefined);
    assert.equal(normalized.outcomes.length, 1);
    assert.equal(normalized.outcomes[0].taskKey, planTask().checkpointKey);
    assert.equal(normalized.outcomes[0].account.url, "https://x.com/acme");
    assert.equal(normalized.evidence.length, 1);
    assert.equal(normalized.evidence[0].taskKey, planTask().checkpointKey);
    assert.equal(normalized.evidence[0].attemptId, normalized.outcomes[0].attemptId);

    const receipt = buildIngestionCoverageReceipt(normalized);
    const pair = receipt.pairs.find((candidate) =>
      candidate.pairKey === "TEST:company:company-acme:x"
    );
    assert.equal(pair.mapping.accountCount, 1);
    assert.equal(pair.accountOutcomes.length, 1);
    assert.equal(pair.accountOutcomes[0].status, "collected");
    assert.equal(pair.terminal.status, "collected");
  });

  it("never infers collected from a numeric evidence count", async () => {
    const envelope = {
      ...artifact("public", HASH_A, "public-count-only.json"),
      snapshot: publicSnapshot({
        attempt: {
          accountUrl: "https://x.com/acme",
          nativeEvidenceCount: 50,
          outcomeStatus: "completed",
          outcomeReason: "collector_evidence_collected"
        },
        evidence: []
      })
    };
    const normalized = await adapt({ collectorArtifacts: [envelope] });
    assert.equal("nativeEvidenceCount" in normalized.outcomes[0], false);

    const receipt = buildIngestionCoverageReceipt(normalized);
    const pair = receipt.pairs.find((candidate) =>
      candidate.pairKey === "TEST:company:company-acme:x"
    );
    assert.equal(pair.accountOutcomes[0].status, "queued");
    assert.equal(pair.accountOutcomes[0].reasonCode, "missing_native_evidence");
    assert.equal(pair.evidence.postCount, 0);
  });

  it("normalizes GitHub discovery, profiles, and repositories onto the exact discovery task", async () => {
    const task = planTask({ platform: "github" });
    const envelope = {
      ...artifact("github", HASH_A, "github-test.json"),
      snapshot: {
        source: { batchSlug: "TEST", fetchedAt: CHECKED_AT },
        attempts: {
          "company:company-acme": {
            attemptKey: "company:company-acme",
            entityType: "company",
            entityId: "company-acme",
            platform: "github",
            mappedAccountCount: 1,
            status: "done",
            outcomeStatus: "completed",
            outcomeReason: "collector_account_fetched",
            checkedAt: CHECKED_AT
          }
        },
        accounts: [{
          entityType: "company",
          entityId: "company-acme",
          githubUrl: "https://github.com/AcmeOrg",
          login: "AcmeOrg",
          fetched: true,
          attemptKey: "account:company:company-acme:https://github.com/AcmeOrg",
          account: { login: "AcmeOrg", followers: 8, publicRepos: 1 },
          aggregate: { repoCount: 1, totalStars: 10 },
          repos: [{
            id: 123,
            fullName: "AcmeOrg/widget",
            htmlUrl: "https://github.com/AcmeOrg/widget",
            stars: 10,
            forks: 2,
            watchers: 10,
            openIssues: 0,
            pushedAt: "2026-08-02T18:00:00.000Z"
          }]
        }]
      }
    };
    const normalized = await adapt({ taskPlan: [task], collectorArtifacts: [envelope] });
    assert.equal(normalized.tasks.length, 1);
    assert.equal(normalized.outcomes[0].taskKey, task.checkpointKey);
    assert.equal(normalized.outcomes[0].account.url, "https://github.com/AcmeOrg");
    assert.equal(normalized.outcomes[0].profileReceipt.status, "scraped");
    assert.equal(normalized.evidence[0].nativeId, "123");
    assert.equal(normalized.evidence[0].taskKey, task.checkpointKey);

    const receipt = buildIngestionCoverageReceipt(normalized);
    const pair = receipt.pairs.find((candidate) =>
      candidate.pairKey === "TEST:company:company-acme:github"
    );
    assert.equal(pair.mapping.accountCount, 1);
    assert.equal(pair.accountOutcomes.length, 1);
    assert.equal(pair.accountOutcomes[0].status, "collected");
  });

  it("records exact blocked and queued reasons without claiming exhaustive absence", async () => {
    const xTask = planTask({
      account: {
        platform: "x",
        url: "https://x.com/acme",
        reviewState: "verified"
      },
      taskKey: "run:TEST:company:company-acme:x:account"
    });
    const githubTask = planTask({ platform: "github" });
    const publicEnvelope = {
      ...artifact("public", HASH_A, "public-blocked.json", "2026-08-02T18:28:00.000Z"),
      snapshot: publicSnapshot({
        attempt: {
          accountUrl: "https://x.com/acme",
          outcomeStatus: "blocked_or_empty",
          outcomeReason: "collector_checked_blocked_or_empty",
          error: "Public profile returned a login-walled access denied response.",
          checkedAt: "2026-08-02T18:28:00.000Z"
        }
      })
    };
    const githubEnvelope = {
      ...artifact("github", HASH_B, "github-no-match.json"),
      snapshot: {
        source: { batchSlug: "TEST", fetchedAt: CHECKED_AT },
        accounts: [],
        attempts: {
          "company:company-acme": {
            attemptKey: "company:company-acme",
            entityType: "company",
            entityId: "company-acme",
            mappedAccountCount: 0,
            status: "done",
            outcomeStatus: "completed",
            outcomeReason: "collector_account_fetched",
            checkedAt: CHECKED_AT
          }
        }
      }
    };
    const catalogs = liveCatalog({ accounts: [xTask.account] });
    const normalized = await adapt({
      catalogs,
      taskPlan: [xTask, githubTask],
      collectorArtifacts: [publicEnvelope, githubEnvelope]
    });
    const blocked = normalized.outcomes.find((outcome) => outcome.platform === "x");
    const queued = normalized.outcomes.find((outcome) => outcome.platform === "github");
    assert.equal(blocked.reasonCode, "access_denied");
    assert.equal(blocked.reason, "Public profile returned a login-walled access denied response.");
    assert.equal(queued.status, "queued");
    assert.equal(queued.reasonCode, "no_match");
    assert.match(queued.reason, /not exhaustive absence proof/);

    const receipt = buildIngestionCoverageReceipt(normalized);
    const xPair = receipt.pairs.find((pair) => pair.platform === "x");
    const githubPair = receipt.pairs.find((pair) => pair.platform === "github");
    assert.equal(xPair.terminal.status, "blocked");
    assert.equal(xPair.terminal.reasonCode, "access_denied");
    assert.equal(githubPair.terminal.status, "queued");
    assert.equal(githubPair.terminal.reasonCode, "no_match");
  });

  it("normalizes targeted native evidence without inventing a company account mapping", async () => {
    const envelope = {
      ...artifact("targeted", HASH_A, "top-voice.json"),
      snapshot: {
        source: { fetchedAt: CHECKED_AT },
        evidence: [nativeXEvidence({ accountUrl: null })],
        needsReview: []
      }
    };
    const normalized = await adapt({ collectorArtifacts: [envelope] });
    const targetedTask = normalized.tasks.find((task) => task.taskKey.startsWith("targeted:"));
    assert.ok(targetedTask);
    assert.equal(targetedTask.account, undefined);
    const targetedOutcome = normalized.outcomes.find((outcome) =>
      outcome.taskKey === targetedTask.taskKey
    );
    assert.equal(targetedOutcome.status, "completed");
    assert.equal(normalized.evidence[0].taskKey, targetedTask.taskKey);
  });

  it("rejects duplicate attempt IDs across artifacts", async () => {
    const first = {
      ...artifact("public", HASH_A, "first.json", "2026-08-02T18:28:00.000Z"),
      snapshot: publicSnapshot({
        attempt: {
          attemptId: "duplicate-attempt",
          checkedAt: "2026-08-02T18:28:00.000Z"
        }
      })
    };
    const second = {
      ...artifact("public", HASH_B, "second.json"),
      snapshot: publicSnapshot({ attempt: { attemptId: "duplicate-attempt" } })
    };
    await assert.rejects(
      adapt({ collectorArtifacts: [first, second] }),
      /Duplicate attemptId duplicate-attempt/
    );
  });

  it("rejects contradictory terminal states for one task observation", async () => {
    const first = {
      ...artifact("public", HASH_A, "success.json"),
      snapshot: publicSnapshot({
        attempt: { attemptId: "success-attempt" },
        evidence: [nativeXEvidence()]
      })
    };
    const second = {
      ...artifact("public", HASH_B, "blocked.json"),
      snapshot: publicSnapshot({
        attempt: {
          attemptId: "blocked-attempt",
          outcomeStatus: "blocked_or_empty",
          outcomeReason: "collector_checked_blocked_or_empty",
          error: "Public endpoint returned a captcha-required access block."
        }
      })
    };
    await assert.rejects(
      adapt({ collectorArtifacts: [first, second] }),
      /Contradictory terminal states/
    );
  });

  it("turns a structured whole-collector runner failure into exact per-task outcomes", async () => {
    const normalized = await adapt({
      collectorArtifacts: [],
      logs: runnerLogs({
        collectionResults: [{
          kind: "public",
          batchSlug: "TEST",
          ok: false,
          successfulRows: 999,
          error: "Public collector hit a 429 rate limit at the upstream endpoint."
        }]
      })
    });
    assert.equal(normalized.outcomes.length, 1);
    assert.equal(normalized.outcomes[0].status, "failed");
    assert.equal(normalized.outcomes[0].reasonCode, "rate_limited");
    assert.equal("nativeEvidenceCount" in normalized.outcomes[0], false);
    const receipt = buildIngestionCoverageReceipt(normalized);
    const pair = receipt.pairs.find((candidate) => candidate.platform === "x");
    assert.equal(pair.terminal.status, "blocked");
    assert.equal(pair.terminal.reasonCode, "rate_limited");
  });

  it("is deterministic across streamed artifact order and records source hashes", async () => {
    const publicEnvelope = {
      ...artifact("public", HASH_A, "public.json"),
      snapshot: publicSnapshot({
        attempt: { accountUrl: "https://x.com/acme" },
        evidence: [nativeXEvidence()]
      })
    };
    const targetedEnvelope = {
      ...artifact("targeted", HASH_B, "targeted.json", "2026-08-02T18:29:30.000Z"),
      snapshot: {
        source: { fetchedAt: "2026-08-02T18:29:30.000Z" },
        evidence: [nativeXEvidence({
          sourceUrl: "https://x.com/partner/status/99",
          platformPostId: "99",
          accountUrl: null,
          last_checked_at: "2026-08-02T18:29:30.000Z"
        })],
        needsReview: []
      }
    };
    async function* stream(rows) {
      for (const row of rows) {
        await Promise.resolve();
        yield row;
      }
    }
    const left = await adapt({
      collectorArtifacts: stream([publicEnvelope, targetedEnvelope])
    });
    const right = await adapt({
      collectorArtifacts: stream([targetedEnvelope, publicEnvelope])
    });
    assert.deepEqual(left, right);
    assert.equal(left.provenance.adapterVersion, INGESTION_COVERAGE_ADAPTER_VERSION);
    assert.deepEqual(
      left.provenance.collectorArtifacts.map((source) => [source.path, source.sha256]),
      [["public.json", HASH_A], ["targeted.json", HASH_B]]
    );
    assert.equal(left.provenance.runnerLog.sha256, HASH_D);
    assert.equal(left.provenance.normalizedRows.evidence, 2);
  });

  it("uses a current artifact observation for a resumed stale attempt", async () => {
    const envelope = {
      ...artifact("public", HASH_A, "resumed.json"),
      snapshot: publicSnapshot({
        attempt: {
          accountUrl: "https://x.com/acme",
          checkedAt: "2026-07-01T00:00:00.000Z"
        },
        evidence: [nativeXEvidence({ last_checked_at: "2026-07-01T00:00:00.000Z" })]
      })
    };
    const normalized = await adapt({ collectorArtifacts: [envelope] });
    assert.equal(normalized.outcomes[0].checkedAt, CHECKED_AT);
    assert.equal(normalized.evidence[0].observedAt, CHECKED_AT);
    assert.doesNotThrow(() => buildIngestionCoverageReceipt(normalized));
  });

  it("rejects malformed envelopes and artifacts outside the current run", async () => {
    await assert.rejects(
      adapt({
        collectorArtifacts: [{
          ...artifact("public", HASH_A, "bad-extra.json"),
          snapshot: publicSnapshot(),
          unexpected: true
        }]
      }),
      /Unknown collector artifact envelope field unexpected/
    );
    await assert.rejects(
      adapt({
        collectorArtifacts: [{
          ...artifact("public", HASH_A, "stale-artifact.json", "2026-07-01T00:00:00.000Z"),
          snapshot: publicSnapshot()
        }]
      }),
      /was not observed within the current run/
    );
  });

  it("hashes artifact chunks incrementally", async () => {
    let pulls = 0;
    async function* chunks() {
      pulls += 1;
      yield "alpha";
      pulls += 1;
      yield new TextEncoder().encode("beta");
    }
    const actual = await sha256IngestionCoverageArtifact(chunks());
    const expected = createHash("sha256").update("alphabeta").digest("hex");
    assert.equal(actual, expected);
    assert.equal(pulls, 2);
  });
});
