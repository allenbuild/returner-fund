import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  EXPECTED_SCORING_MODEL,
  GRAPH_ARTIFACTS,
  HISTORY_ARTIFACTS,
  PublicArtifactValidationError,
  collectCanonicalGraphSetViolations,
  collectGraphArtifactViolations,
  collectHistoryArtifactViolations,
  nativeEvidenceIdentityFromUrl,
  runPublicArtifactValidationCli,
  validatePublicArtifacts
} from "../scripts/validate-public-artifacts.mjs";

const GENERATED_AT = "2026-07-16T12:00:00.000Z";
const VALIDATION_NOW = new Date("2026-07-16T13:00:00.000Z");
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

test("validates the complete nine-graph and three-history manifest without a server", async () => {
  const rootDir = await writeValidArtifactTree();

  const result = await validatePublicArtifacts({ rootDir });

  assert.deepEqual(result, {
    status: "ok",
    scoringModel: "returner-traction@4.0.1",
    graphSnapshots: 9,
    historyFiles: 3,
    graphNodes: 9,
    evidenceRows: 9,
    versionedDailyEntries: 3,
    versionedWeeklyEntries: 3
  });
});

test("rejects wrong batch, audience, scoring scope, v4 identity, and incomplete breakdowns", () => {
  const descriptor = GRAPH_ARTIFACTS[0];
  const graph = makeGraph(descriptor, 1);
  graph.mode = "demo";
  graph.batch.slug = "S26";
  graph.selectedTopVoiceAudience.id = "insiders";
  graph.scoringContext.modelVersion = "3.0.0";
  graph.scoringContext.scoreScope = "top_voice";
  delete graph.nodes[0].scoreBreakdown.confidence;

  const violations = collectGraphArtifactViolations(graph, descriptor).join("\n");

  assert.match(violations, /mode must be official_snapshot/);
  assert.match(violations, /batch\.slug must be S2026/);
  assert.match(violations, /selectedTopVoiceAudience\.id must be off/);
  assert.match(violations, /scoringContext\.modelVersion must be 4\.0\.1/);
  assert.match(violations, /scoringContext\.scoreScope must be all_platforms/);
  assert.match(violations, /scoreBreakdown\.confidence must be an object/);
});

test("rejects impossible score values and internally inconsistent score surfaces", () => {
  const descriptor = GRAPH_ARTIFACTS[0];
  const graph = makeGraph(descriptor, 2);
  graph.nodes[0].score = 101;
  graph.nodes[0].scoreDelta = 4;
  graph.nodes[0].scoreBreakdown.absoluteScore = -1;
  graph.nodes[0].scoreBreakdown.confidence.value = 1.1;
  graph.nodes[0].scoreBreakdown.weightedPlatforms[0].configuredWeight = 0.99;
  graph.leaderboard[0].score = 101;

  const violations = collectGraphArtifactViolations(graph, descriptor).join("\n");

  assert.match(violations, /node .* score must be an integer from 0 through 100/);
  assert.match(violations, /scoreDelta must equal score - previousScore/);
  assert.match(violations, /absoluteScore must be an integer from 0 through 100/);
  assert.match(violations, /confidence\.value must be a finite number from 0 through 1/);
  assert.match(violations, /configuredWeight must be 0\.21/);
  assert.match(violations, /leaderboard\[0\]\.score must be an integer from 0 through 100/);
});

test("rejects Top Voice member-weighted evidence while retaining its provenance", () => {
  const descriptor = GRAPH_ARTIFACTS[1];
  const graph = makeGraph(descriptor, 2);
  graph.evidence[0].contributionScore = 80;

  const violations = collectGraphArtifactViolations(graph, descriptor).join("\n");

  assert.match(violations, /contributionScore must not apply a Top Voice member weight/);
  assert.equal(graph.evidence[0].topVoice.memberId, "fixture-member");
  assert.equal(graph.evidence[0].topVoice.originalContributionScore, 70);
});

test("rejects canonical audience state that drifts from its base artifact", () => {
  const entries = GRAPH_ARTIFACTS.slice(0, 3).map((descriptor, index) => ({
    descriptor,
    graph: makeGraph(descriptor, index + 1)
  }));
  entries[1].graph.nodes[0].radius += 1;

  const violations = collectCanonicalGraphSetViolations(entries).join("\n");

  assert.match(violations, /s2026-yc-partners\.json: node company-s2026 must preserve canonical radius/);
});

test("detects duplicate native posts across URL aliases and explicit identity conflicts", () => {
  const descriptor = GRAPH_ARTIFACTS[0];
  const graph = makeGraph(descriptor, 3);
  const original = graph.evidence[0];
  const duplicate = {
    ...structuredClone(original),
    id: `${original.id}-duplicate`,
    sourceUrl: original.sourceUrl.replace("https://x.com/", "https://twitter.com/")
  };
  graph.evidence.push(duplicate);
  graph.nodes[0].evidenceIds.push(duplicate.id);

  const duplicated = collectGraphArtifactViolations(graph, descriptor).join("\n");
  assert.match(duplicated, /duplicate native identity .*:x:/);

  duplicate.entityId = "company-distinct-attribution";
  const distinctAttribution = collectGraphArtifactViolations(graph, descriptor).join("\n");
  assert.doesNotMatch(distinctAttribution, /duplicate native identity/);

  duplicate.entityId = original.entityId;
  duplicate.platformPostId = "999999999999999999";
  const conflicted = collectGraphArtifactViolations(graph, descriptor).join("\n");
  assert.match(conflicted, /conflicting x native identities/);
});

test("accepts locale LinkedIn hosts but rejects lookalike domains", () => {
  const postPath = "/posts/vereda.agro_launch-activity-7485423404670521345-HjKU";

  assert.equal(
    nativeEvidenceIdentityFromUrl("linkedin", `https://pt.linkedin.com${postPath}`),
    "7485423404670521345"
  );
  assert.equal(
    nativeEvidenceIdentityFromUrl("linkedin", `https://regional.pt.linkedin.com${postPath}`),
    "7485423404670521345"
  );
  assert.equal(
    nativeEvidenceIdentityFromUrl("linkedin", `https://pt.linkedin.com.evil.example${postPath}`),
    null
  );
});

test("enforces canonical materialized account lineage and preserves explicit null lineage", () => {
  const descriptor = GRAPH_ARTIFACTS[0];
  const cases = [
    {
      name: "dangling account lineage",
      pattern: /evidence\[0\]\.socialAccountId: must resolve to exactly one materialized social account; found 0/,
      mutate(graph) {
        graph.evidence[0].socialAccountId = materializedSocialAccountId(
          "company",
          graph.nodes[0].entityId,
          "x",
          "https://x.com/missing"
        );
      }
    },
    {
      name: "wrong-owner account lineage",
      pattern: /evidence\[0\]\.socialAccountId: must reference an account owned by company:/,
      mutate(graph) {
        const account = makeMaterializedSocialAccount(
          "founder",
          "founder-fixture",
          "x",
          "https://x.com/founderfixture"
        );
        graph.nodes[0].socialAccounts = [];
        graph.nodes[0].founders = [{ id: "founder-fixture", socialAccounts: [account] }];
        graph.evidence[0].socialAccountId = account.id;
      }
    },
    {
      name: "wrong-platform account lineage",
      pattern: /evidence\[0\]\.socialAccountId: must reference an account on platform x/,
      mutate(graph) {
        const account = makeMaterializedSocialAccount(
          "company",
          graph.nodes[0].entityId,
          "github",
          "https://github.com/returner"
        );
        graph.nodes[0].socialAccounts = [account];
        graph.evidence[0].socialAccountId = account.id;
      }
    },
    {
      name: "account ID collision",
      pattern: /nodes\[0\]\.socialAccounts\[1\]\.id: collides with an account ID/,
      mutate(graph) {
        graph.nodes[0].socialAccounts.push(structuredClone(graph.nodes[0].socialAccounts[0]));
      }
    },
    {
      name: "fabricated account ID",
      pattern: /nodes\[0\]\.socialAccounts\[0\]\.id: must be a canonical materialized social account ID/,
      mutate(graph) {
        graph.nodes[0].socialAccounts[0].id = "fabricated-account-id";
        graph.evidence[0].socialAccountId = "fabricated-account-id";
      }
    }
  ];

  for (const testCase of cases) {
    const graph = makeGraph(descriptor, 1);
    testCase.mutate(graph);
    const violations = collectGraphArtifactViolations(graph, descriptor, {
      now: VALIDATION_NOW
    }).join("\n");
    assert.match(violations, testCase.pattern, testCase.name);
  }

  const graph = makeGraph(descriptor, 1);
  graph.evidence[0].socialAccountId = null;
  graph.nodes[0].socialAccounts = [];
  assert.deepEqual(
    collectGraphArtifactViolations(graph, descriptor, { now: VALIDATION_NOW }),
    []
  );
});

test("rejects adversarial graph mutations across time, identity, edges, ties, and momentum", () => {
  const descriptor = GRAPH_ARTIFACTS[0];
  const cases = [
    {
      name: "future generation time",
      pattern: /generatedAt: must not be in the future/,
      mutate(graph) {
        graph.generatedAt = "2026-07-16T13:02:00.000Z";
        graph.scoringContext.responseBuiltAt = graph.generatedAt;
      }
    },
    {
      name: "responseBuiltAt drift",
      pattern: /scoringContext\.responseBuiltAt: must equal generatedAt/,
      mutate(graph) {
        graph.scoringContext.responseBuiltAt = "2026-07-16T12:00:01.000Z";
      }
    },
    {
      name: "future evidence time",
      pattern: /evidence\[0\]\.postedAt: must not be later than generatedAt/,
      mutate(graph) {
        graph.evidence[0].postedAt = "2026-07-16T12:00:01.000Z";
      }
    },
    {
      name: "node identity drift",
      pattern: /nodes\[0\]\.id: must be company:/,
      mutate(graph) {
        graph.nodes[0].id = "company:wrong-company";
      }
    },
    {
      name: "node scope drift",
      pattern: /nodes\[0\]\.batchSlug: must be S2026/,
      mutate(graph) {
        graph.nodes[0].batchSlug = "S26";
      }
    },
    {
      name: "missing edge endpoint",
      pattern: /edges\[0\]\.target: references missing node/,
      mutate(graph) {
        graph.edges.push({
          id: "edge-invalid",
          source: graph.nodes[0].id,
          target: "company:missing",
          edgeType: "industry_similarity",
          weight: 0.5,
          label: "Industry similarity",
          explanation: "Adversarial fixture."
        });
      }
    },
    {
      name: "ordinal tied rank",
      pattern: /leaderboard\[1\]\.rank: must be 1 for tied descending scores/,
      mutate(graph) {
        addTiedCompany(graph);
        graph.leaderboard[1].rank = 2;
      }
    },
    {
      name: "momentum identity drift",
      pattern: /fastestGaining\[0\]\.companyId: references missing leaderboard company/,
      mutate(graph) {
        graph.fastestGaining[0].companyId = "company:missing";
      }
    },
    {
      name: "momentum current value drift",
      pattern: /fastestGaining\[0\]\.dod\.currentScore: must equal the matching leaderboard score/,
      mutate(graph) {
        graph.fastestGaining[0].dod.currentScore -= 1;
      }
    },
    {
      name: "half-null momentum baseline",
      pattern: /fastestGaining\[0\]\.dod\.baselineRank: must be null exactly/,
      mutate(graph) {
        graph.fastestGaining[0].dod.baselineRank = 2;
      }
    },
    {
      name: "nonzero null-baseline delta",
      pattern: /fastestGaining\[0\]\.dod\.scoreDelta: must equal currentScore - baselineScore \(0\)/,
      mutate(graph) {
        graph.fastestGaining[0].dod.scoreDelta = 1;
      }
    },
    {
      name: "incorrect baseline delta math",
      pattern: /fastestGaining\[0\]\.dod\.percentDelta: must equal the baseline percent change/,
      mutate(graph) {
        Object.assign(graph.fastestGaining[0].dod, {
          baselineScore: 60,
          baselineRank: 2,
          scoreDelta: 10,
          percentDelta: 99,
          rankDelta: -1
        });
      }
    }
  ];

  for (const testCase of cases) {
    const graph = makeGraph(descriptor, 1);
    testCase.mutate(graph);
    const violations = collectGraphArtifactViolations(graph, descriptor, {
      now: VALIDATION_NOW
    }).join("\n");
    assert.match(violations, testCase.pattern, testCase.name);
  }
});

test("allows legacy history rows but requires valid v4 daily and weekly entries", () => {
  const descriptor = HISTORY_ARTIFACTS[0];
  const history = makeHistory(descriptor);
  const legacy = structuredClone(history.daily[0]);
  legacy.recordedAt = "2026-07-01T12:00:00.000Z";
  delete legacy.scoringModelVersion;
  delete legacy.inputGeneratedAt;
  legacy.companies.push({
    ...legacy.companies[0],
    companyId: `${legacy.companies[0].companyId}-legacy-tie`,
    companyName: `${legacy.companies[0].companyName} legacy tie`,
    rank: 2
  });
  history.daily.unshift(legacy);
  const historicalV4 = structuredClone(history.daily[1]);
  historicalV4.recordedAt = "2026-07-02T12:00:00.000Z";
  historicalV4.inputGeneratedAt = "2026-07-02T11:59:00.000Z";
  historicalV4.scoringModelVersion = "4.0.0";
  history.daily.splice(1, 0, historicalV4);

  assert.deepEqual(collectHistoryArtifactViolations(history, descriptor).violations, []);

  delete history.daily[2].scoringModelVersion;
  delete history.daily[2].inputGeneratedAt;
  history.weekly[0].scoringModelVersion = "3.0.0";
  const result = collectHistoryArtifactViolations(history, descriptor);
  const violations = result.violations.join("\n");

  assert.equal(result.versionedDailyEntries, 0);
  assert.equal(result.versionedWeeklyEntries, 0);
  assert.match(violations, /daily must contain a returner-traction@4\.0\.1 version-tagged entry/);
  assert.match(
    violations,
    /weekly\[0\]\.scoringModelVersion must be 4\.0\.1 or a supported historical version/
  );
  assert.match(violations, /weekly must contain a returner-traction@4\.0\.1 version-tagged entry/);
});

test("rejects future history, non-tied canonical ranks, and stale Central-day entries", () => {
  const descriptor = HISTORY_ARTIFACTS[0];

  const future = makeHistory(descriptor);
  future.updatedAt = "2026-07-16T13:02:00.000Z";
  future.daily[0].recordedAt = future.updatedAt;
  let violations = collectHistoryArtifactViolations(future, descriptor, {
    now: VALIDATION_NOW
  }).violations.join("\n");
  assert.match(violations, /updatedAt must not be in the future/);
  assert.match(violations, /daily\[0\]\.recordedAt must not be in the future/);

  const tied = makeHistory(descriptor);
  tied.daily[0].companies.push({
    companyId: "company-tied",
    companyName: "Tied Company",
    score: 66,
    rank: 2
  });
  violations = collectHistoryArtifactViolations(tied, descriptor, {
    now: VALIDATION_NOW
  }).violations.join("\n");
  assert.match(violations, /daily\[0\]\.companies\[1\]\.rank must be 1 for tied descending scores/);

  const stale = makeHistory(descriptor);
  stale.daily[0].recordedAt = "2026-07-15T12:05:00.000Z";
  stale.daily[0].inputGeneratedAt = "2026-07-15T12:00:00.000Z";
  violations = collectHistoryArtifactViolations(stale, descriptor, {
    now: VALIDATION_NOW,
    requireCurrentCentralDay: true
  }).violations.join("\n");
  assert.match(violations, /daily must contain a current America\/Chicago day 2026-07-16/);
});

test("CLI validation requires graph and canonical daily artifacts from the current Central day", async () => {
  const rootDir = await writeValidArtifactTree();

  const valid = await runPublicArtifactValidationCli(["--root", rootDir], {
    now: VALIDATION_NOW
  });
  assert.equal(valid.status, "ok");

  const graphPath = path.join(rootDir, GRAPH_ARTIFACTS[0].path);
  const graph = JSON.parse(await readFile(graphPath, "utf8"));
  graph.generatedAt = "2026-07-15T12:00:00.000Z";
  graph.scoringContext.responseBuiltAt = graph.generatedAt;
  await writeJson(rootDir, GRAPH_ARTIFACTS[0].path, graph);

  await assert.rejects(
    runPublicArtifactValidationCli([`--root=${rootDir}`], { now: VALIDATION_NOW }),
    (error) => {
      assert.ok(error instanceof PublicArtifactValidationError);
      assert.ok(error.violations.some((violation) => /generatedAt must be on the current America\/Chicago day/.test(violation)));
      return true;
    }
  );
});

test("reports missing committed artifacts as one deterministic validation error", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "returner-artifacts-missing-"));
  temporaryRoots.push(rootDir);

  await assert.rejects(
    validatePublicArtifacts({ rootDir }),
    (error) => {
      assert.ok(error instanceof PublicArtifactValidationError);
      assert.equal(error.violations.length, GRAPH_ARTIFACTS.length + HISTORY_ARTIFACTS.length);
      assert.match(error.message, /Public artifact validation failed with 12 violation\(s\)/);
      assert.match(error.violations[0], /public\/graph\/s2026\.json: could not be read/);
      return true;
    }
  );
});

async function writeValidArtifactTree() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "returner-artifacts-valid-"));
  temporaryRoots.push(rootDir);

  for (const [index, descriptor] of GRAPH_ARTIFACTS.entries()) {
    await writeJson(rootDir, descriptor.path, makeGraph(descriptor, index + 1));
  }
  for (const descriptor of HISTORY_ARTIFACTS) {
    await writeJson(rootDir, descriptor.path, makeHistory(descriptor));
  }
  return rootDir;
}

function makeGraph(descriptor, serial) {
  const audience = descriptor.audience;
  const companyId = `company-${descriptor.batch.toLowerCase()}`;
  const companyName = `Fixture ${descriptor.batch}`;
  const evidenceId = `evidence-${serial}`;
  const nativeId = `206000000000000${String(serial).padStart(3, "0")}`;
  const socialAccount = makeMaterializedSocialAccount(
    "company",
    companyId,
    "x",
    "https://x.com/returner"
  );
  const absoluteScore = 70;
  const totalScore = 66;
  const selectedTopVoiceAudience = { id: audience };
  const calibration = {
    method: "tie_aware_percentile_blend",
    cohortSize: 1,
    percentile: 0.5,
    inputScore: absoluteScore
  };
  const scoreBreakdown = {
    modelId: EXPECTED_SCORING_MODEL.id,
    modelVersion: EXPECTED_SCORING_MODEL.version,
    modelName: EXPECTED_SCORING_MODEL.name,
    totalScore,
    absoluteScore,
    weightedAvailableScore: 70,
    coverageFactor: 1,
    platformsWithEvidence: 1,
    totalSupportedPlatforms: 9,
    platformScores: { x: 70 },
    weightedPlatforms: [
      {
        platform: "x",
        score: 70,
        configuredWeight: 0.21,
        appliedWeight: 1,
        contribution: 54.04,
        evidenceCount: 1
      }
    ],
    signalFamilyScores: {
      reach: 70,
      engagement: 70,
      developerAdoption: 0,
      launchAndCommunity: 0,
      momentum: 70
    },
    confidence: {
      level: "medium",
      value: 0.6,
      reasons: ["Fixture has one scored row."],
      scoredEvidenceCount: 1,
      datedEvidenceCount: 1,
      verifiedLinkCount: 1
    },
    calibration,
    limitations: ["Fixture limitation."],
    evidenceAsOf: GENERATED_AT,
    explanation: "Canonical v4 fixture score."
  };
  const evidence = {
    id: evidenceId,
    entityType: "company",
    entityId: companyId,
    platform: "x",
    sourceUrl: `https://x.com/returner/status/${nativeId}`,
    platformPostId: nativeId,
    postedAt: GENERATED_AT,
    publishedAtPrecision: "exact",
    contributionScore: 70,
    normalizedScore: 70,
    attachedCompanyId: companyId,
    socialAccountId: socialAccount.id,
    review_state: "verified",
    linkStatus: "verified",
    tractionStatus: "scored"
  };
  if (audience !== "off") {
    evidence.topVoice = {
      audienceId: audience,
      memberId: "fixture-member",
      displayName: "Fixture Member",
      category: "fixture",
      weight: 2,
      matchedBy: "fixture identity",
      originalContributionScore: evidence.contributionScore
    };
  }

  return {
    batch: { slug: descriptor.batch, companyCountObserved: 1 },
    edges: [],
    nodes: [
      {
        id: `company:${companyId}`,
        entityType: "company",
        entityId: companyId,
        label: companyName,
        batchSlug: descriptor.batch,
        score: totalScore,
        previousScore: totalScore,
        scoreDelta: 0,
        radius: 42,
        topPlatform: "x",
        platformScores: { x: 70 },
        scoreBreakdown,
        socialAccounts: [socialAccount],
        evidenceIds: [evidenceId],
        relatedEntityIds: [],
        founders: [],
        ...(audience === "off"
          ? {}
          : {
              selectedTopVoiceAudience,
              topVoiceConnectionCount: 1,
              topVoiceConnections: [{
                memberId: "fixture-member",
                displayName: "Fixture Member",
                category: "fixture",
                weight: 2,
                contributionScore: evidence.contributionScore,
                evidenceCount: 1,
                topEvidenceId: evidence.id,
                platforms: ["x"]
              }]
            })
      }
    ],
    leaderboard: [
      {
        rank: 1,
        companyId,
        companyName,
        score: totalScore,
        topPlatform: "x",
        biggestContribution: evidence
      }
    ],
    fastestGaining: [{
      rank: 1,
      companyId,
      companyName,
      dod: momentum(totalScore, 1),
      wow: momentum(totalScore, 1)
    }],
    evidence: [evidence],
    selectedTopVoiceAudience,
    generatedAt: GENERATED_AT,
    scoringContext: {
      modelId: EXPECTED_SCORING_MODEL.id,
      modelVersion: EXPECTED_SCORING_MODEL.version,
      modelName: EXPECTED_SCORING_MODEL.name,
      scoreScope: "all_platforms",
      selectedPlatforms: [],
      responseBuiltAt: GENERATED_AT,
      evidenceAsOf: GENERATED_AT
    },
    mode: "official_snapshot"
  };
}

function momentum(currentScore, currentRank) {
  return {
    scoreDelta: 0,
    percentDelta: 0,
    rankDelta: 0,
    currentScore,
    currentRank,
    baselineScore: null,
    baselineRank: null,
    benchmarkedAt: null
  };
}

function addTiedCompany(graph) {
  const firstNode = graph.nodes[0];
  const firstEvidence = graph.evidence[0];
  const firstLeaderboard = graph.leaderboard[0];
  const companyId = `${firstNode.entityId}-tied`;
  const companyName = `${firstLeaderboard.companyName} Tied`;
  const socialAccount = makeMaterializedSocialAccount(
    "company",
    companyId,
    "x",
    "https://x.com/returnertied"
  );
  const evidence = {
    ...structuredClone(firstEvidence),
    id: `${firstEvidence.id}-tied`,
    entityId: companyId,
    attachedCompanyId: companyId,
    sourceUrl: "https://x.com/returner/status/206000000000009999",
    platformPostId: "206000000000009999",
    socialAccountId: socialAccount.id
  };
  const node = {
    ...structuredClone(firstNode),
    id: `company:${companyId}`,
    entityId: companyId,
    label: companyName,
    socialAccounts: [socialAccount],
    evidenceIds: [evidence.id]
  };

  graph.batch.companyCountObserved = 2;
  if (node.scoreBreakdown.calibration.method === "tie_aware_percentile_blend") {
    firstNode.scoreBreakdown.calibration.cohortSize = 2;
    node.scoreBreakdown.calibration.cohortSize = 2;
  }
  graph.evidence.push(evidence);
  graph.nodes.push(node);
  graph.leaderboard.push({
    ...structuredClone(firstLeaderboard),
    rank: 1,
    companyId,
    companyName,
    biggestContribution: evidence
  });
  graph.fastestGaining.push({
    rank: 2,
    companyId,
    companyName,
    dod: momentum(firstLeaderboard.score, 1),
    wow: momentum(firstLeaderboard.score, 1)
  });
}

function makeMaterializedSocialAccount(entityType, entityId, platform, url) {
  return {
    id: materializedSocialAccountId(entityType, entityId, platform, url),
    platform,
    handle: url.split("/").at(-1) ?? null,
    url,
    review_state: "verified",
    discoveredFromUrl: null,
    matchReason: "Canonical lineage fixture."
  };
}

function materializedSocialAccountId(entityType, entityId, platform, canonicalUrl) {
  return `acct:${entityType}:${entityId}:${platform}:${encodeURIComponent(canonicalUrl)}`;
}

function makeHistory(descriptor) {
  const entry = {
    recordedAt: "2026-07-16T12:05:00.000Z",
    scoringModelVersion: EXPECTED_SCORING_MODEL.version,
    inputGeneratedAt: GENERATED_AT,
    companies: [
      {
        companyId: `company-${descriptor.batch.toLowerCase()}`,
        companyName: `Fixture ${descriptor.batch}`,
        score: 66,
        rank: 1
      }
    ]
  };
  return {
    version: 1,
    batchSlug: descriptor.batch,
    updatedAt: entry.recordedAt,
    daily: [structuredClone(entry)],
    weekly: [structuredClone(entry)]
  };
}

async function writeJson(rootDir, relativePath, value) {
  const outputPath = path.join(rootDir, relativePath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
