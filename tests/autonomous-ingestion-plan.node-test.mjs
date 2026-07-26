import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTONOMOUS_BATCHES,
  AUTONOMOUS_PLATFORMS,
  AUTONOMOUS_PROCESS_BUDGETS,
  autonomousMappedTerminalFailureBudget,
  autonomousCollectorRetryableFailures,
  buildAutonomousTaskPlan,
  classifyAutonomousCollectorTaskOutcome,
  countSuccessfulAutonomousCollectorRows,
  indexAutonomousCollectorTaskOutcomes,
  loadAutonomousCatalogs,
  maxAutonomousRunnerProcessBudgetMs,
  mergeGithubTractionSnapshots,
  mergePublicEvidenceSnapshots,
  normalizeAutonomousFailureEntityId,
  prioritizeAutonomousCompaniesByCoverage,
  summarizeAutonomousCollectorTerminalTaskCoverage,
  summarizeTaskCoverage,
  validateAutonomousCatalogRoster,
  validateAutonomousCollectorMatrix,
  validateAutonomousCollectorReferentialIntegrity,
  validateAutonomousCollectorSnapshot,
  validateAutonomousTerminalCoverage,
  validateMappedAutonomousCoverage
} from "../scripts/lib/autonomous-ingestion-plan.mjs";
import { readRequiredCanonicalJson } from "../scripts/lib/canonical-json.mjs";

const repositoryRoot = process.cwd();

describe("autonomous runner resume contract", () => {
  it("reuses the existing Top Voice receipt when snapshot resume is requested", async () => {
    const source = await readFile(
      join(repositoryRoot, "scripts/run-autonomous-ingestion.mjs"),
      "utf8"
    );

    assert.match(
      source,
      /await Promise\.all\(\[\s*runCollectors\(\),\s*resumeTopVoiceRefresh\(\)\s*\]\)/
    );
  });
});

describe("autonomous ingestion planning against the collector catalogs", () => {
  it("puts companies with zero and low owner evidence first and rotates equal gaps by run", () => {
    const companies = [
      {
        sourceKey: "company-covered",
        founders: [{ sourceKey: "founder-covered" }]
      },
      {
        sourceKey: "company-founder-gap",
        founders: [{ sourceKey: "founder-gap" }]
      },
      {
        sourceKey: "company-zero-a",
        founders: [{ sourceKey: "founder-zero-a" }]
      },
      {
        sourceKey: "company-zero-b",
        founders: [{ sourceKey: "founder-zero-b" }]
      }
    ];
    const evidence = [
      { batchSlug: "S26", entityId: "company-covered", postedAt: "2026-07-24T01:00:00Z" },
      { batchSlug: "S26", entityId: "founder-covered", postedAt: "2026-07-24T01:00:00Z" },
      { batchSlug: "S26", entityId: "company-founder-gap", postedAt: "2026-07-22T01:00:00Z" }
    ];
    const first = prioritizeAutonomousCompaniesByCoverage(companies, evidence, {
      batchSlug: "S26",
      prioritySeed: "central-2026-07-24-0600"
    });
    assert.deepEqual(
      first.slice(0, 2).map((company) => company.sourceKey).sort(),
      ["company-zero-a", "company-zero-b"]
    );
    assert.equal(first[2].sourceKey, "company-founder-gap");
    assert.equal(first[3].sourceKey, "company-covered");
    const firstGapAcrossRuns = new Set(
      Array.from({ length: 12 }, (_, index) =>
        prioritizeAutonomousCompaniesByCoverage(companies, evidence, {
          batchSlug: "S26",
          prioritySeed: `central-run-${index}`
        })[0].sourceKey
      )
    );
    assert.deepEqual(firstGapAcrossRuns, new Set(["company-zero-a", "company-zero-b"]));
  });

  it("fails closed when required canonical override JSON is absent or malformed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "returner-required-canonical-json-"));
    const path = join(directory, "verified-social-overrides.json");

    await assert.rejects(
      readRequiredCanonicalJson(path, "Verified social overrides"),
      /Verified social overrides could not be read.*verified-social-overrides\.json/
    );
    await writeFile(path, "{ malformed\n");
    await assert.rejects(
      readRequiredCanonicalJson(path, "Verified social overrides"),
      /Verified social overrides is malformed.*verified-social-overrides\.json/
    );
    await writeFile(path, '{"eden-robotics":{"founders":[]}}\n');
    assert.deepEqual(
      await readRequiredCanonicalJson(path, "Verified social overrides"),
      { "eden-robotics": { founders: [] } }
    );

    for (const collectorPath of [
      "scripts/fetch-public-traction.mjs",
      "scripts/fetch-github-traction.mjs",
      "scripts/fetch-logged-in-social-traction.mjs"
    ]) {
      const source = await readFile(join(repositoryRoot, collectorPath), "utf8");
      assert.match(source, /readRequiredCanonicalJson\([\s\S]*verifiedSocialOverridesPath/);
    }
  });

  it("loads the exact company, founder, and account counts from every real catalog", async () => {
    const catalogs = await loadAutonomousCatalogs(repositoryRoot);

    assert.deepEqual(catalogs.map(summarizeCatalog), [
      { slug: "S2026", companies: 197, founders: 397, accounts: 959 },
      { slug: "S26", companies: 115, founders: 230, accounts: 551 },
      { slug: "A16ZSR006", companies: 59, founders: 128, accounts: 327 }
    ]);
  });

  it("fails closed when the A16Z graph drops an owner from the independent 59/128 roster", async () => {
    const catalogs = await loadAutonomousCatalogs(repositoryRoot);
    const a16z = catalogs.find((catalog) => catalog.slug === "A16ZSR006");
    const batch = AUTONOMOUS_BATCHES.find((candidate) => candidate.slug === "A16ZSR006");
    const roster = JSON.parse(await readFile(
      new URL("../src/lib/social/a16z-speedrun-006-social-accounts.json", import.meta.url),
      "utf8"
    ));
    assert.equal(validateAutonomousCatalogRoster(a16z.companies, roster, batch), a16z.companies);
    assert.throws(
      () => validateAutonomousCatalogRoster(a16z.companies.slice(1), roster, batch),
      /graph roster drifted/
    );
    const withoutFounder = a16z.companies.map((company, index) =>
      index === 0 ? { ...company, founders: company.founders.slice(1) } : company
    );
    assert.throws(
      () => validateAutonomousCatalogRoster(withoutFounder, roster, batch),
      /graph roster drifted/
    );
  });

  it("merges verified overrides by entity owner without globally collapsing shared URLs", async () => {
    const summer = (await loadAutonomousCatalogs(repositoryRoot)).find((catalog) => catalog.slug === "S26");
    const entities = summer.companies.flatMap((company) => [company, ...company.founders]);
    const ownerMappings = entities.flatMap((entity) =>
      entity.accounts.map((account) => ({
        key: `${entity.sourceKey}:${account.platform}:${account.url.toLowerCase().replace(/\/$/, "")}`,
        entity,
        account
      }))
    );
    assert.equal(new Set(ownerMappings.map((mapping) => mapping.key)).size, ownerMappings.length);

    const codag = summer.companies.find((company) => company.sourceKey === "company-codag");
    const michael = codag.founders.find((founder) => founder.name === "Michael Zhou");
    assert.ok(codag.accounts.some((account) => account.platform === "github" && /codag-megalith/i.test(account.url)));
    assert.ok(michael.accounts.some((account) => account.platform === "github" && /michaelzixizhou/i.test(account.url)));
    assert.equal(michael.sourceKey, "founder-codag-michael-zhou-2706494");

    const vestris = summer.companies.find((company) => company.sourceKey === "company-vestris");
    assert.deepEqual(
      vestris.founders.map((founder) => founder.name).sort(),
      ["Aahil Valliani", "Joshua Tang"]
    );
    assert.deepEqual(
      vestris.founders.map((founder) => founder.sourceKey).sort(),
      [
        "founder-vestris-aahil-valliani-verified-aahil-valliani",
        "founder-vestris-joshua-tang-verified-joshua-tang"
      ]
    );
    assert.ok(vestris.founders.every((founder) =>
      founder.accounts.some((account) => account.platform === "linkedin")
    ));

    const sharedHyperparticle = ownerMappings.filter(
      (mapping) => mapping.account.platform === "x" && /x\.com\/hyperparticle\/?$/i.test(mapping.account.url)
    );
    assert.equal(sharedHyperparticle.length, 2);
    assert.equal(new Set(sharedHyperparticle.map((mapping) => mapping.entity.sourceKey)).size, 2);
  });

  it("retires dead owner mappings while retaining replacement URLs and audit history", async () => {
    const catalogs = await loadAutonomousCatalogs(repositoryRoot);
    const summer = catalogs.find((catalog) => catalog.slug === "S26");
    const spring = catalogs.find((catalog) => catalog.slug === "S2026");
    const a16z = catalogs.find((catalog) => catalog.slug === "A16ZSR006");
    const openRelay = summer.companies.find((company) => company.sourceKey === "company-openrelay");
    const playabl = spring.companies.find((company) => company.sourceKey === "company-playablai");
    const amdahl = a16z.companies.find((company) => company.sourceKey === "a16z-speedrun-006-amdahl");

    assert.equal(openRelay.accounts.some((account) => /github\.com\/openrelayinc\/openrelay/i.test(account.url)), false);
    assert.equal(playabl.accounts.some((account) => /instagram\.com\/playabl_ai/i.test(account.url)), false);
    assert.deepEqual(
      amdahl.accounts.filter((account) => account.platform === "github").map((account) => account.url),
      ["https://github.com/amdahlco"]
    );

    const tasks = buildAutonomousTaskPlan(catalogs, { runKey: "retired-mapping-contract" });
    const openRelayGithub = tasks.find(
      (task) => task.entitySourceKey === openRelay.sourceKey && task.platform === "github"
    );
    const amdahlGithub = tasks.find(
      (task) => task.entitySourceKey === amdahl.sourceKey && task.platform === "github"
    );
    assert.equal(openRelayGithub.account, null);
    assert.equal(openRelayGithub.status, "queued");
    assert.equal(openRelayGithub.terminalReason, null);
    assert.equal(amdahlGithub.account.url, "https://github.com/amdahlco");

    const overrides = JSON.parse(await readFile(
      new URL("../src/lib/social/verified-social-overrides.json", import.meta.url),
      "utf8"
    ));
    for (const [slug, field] of [
      ["openrelay", "rejectedGithub"],
      ["amdahl", "rejectedGithub"],
      ["playablai", "rejectedInstagram"]
    ]) {
      assert.ok(overrides[slug][field][0].url);
      assert.ok(overrides[slug][field][0].reason);
      assert.ok(overrides[slug][field][0].rejectedAt);
    }
  });

  it("feeds the same retired and replacement mappings into the GitHub collector plan", () => {
    const summer = githubCollectorPlan("S26");
    const a16z = githubCollectorPlan("A16ZSR006");

    assert.equal(
      summer.targets.some((target) => /github\.com\/openrelayinc\/openrelay/i.test(target.githubUrl)),
      false
    );
    assert.ok(summer.targets.some(
      (target) => target.entityId === "company-codag" && /github\.com\/codag-megalith/i.test(target.githubUrl)
    ));
    assert.ok(summer.targets.some(
      (target) =>
        target.entityId === "founder-codag-michael-zhou-2706494" &&
        /github\.com\/michaelzixizhou/i.test(target.githubUrl)
    ));
    assert.deepEqual(
      a16z.targets.filter((target) => target.entityId === "a16z-speedrun-006-amdahl").map((target) => target.githubUrl),
      ["https://github.com/amdahlco"]
    );
  });

  it("keeps every cohort GitHub collector plan in exact parity with canonical owner mappings", async () => {
    const catalogs = await loadAutonomousCatalogs(repositoryRoot);
    for (const catalog of catalogs) {
      const expected = catalog.companies.flatMap((company) =>
        [company, ...company.founders].flatMap((entity) =>
          entity.accounts
            .filter((account) => account.platform === "github")
            .map((account) => `${entity.sourceKey}:${account.url.toLowerCase().replace(/\/$/, "")}`)
        )
      ).sort();
      const actual = githubCollectorPlan(catalog.slug).targets.map(
        (target) => `${target.entityId}:${target.githubUrl.toLowerCase().replace(/\/$/, "")}`
      ).sort();
      assert.deepEqual(actual, expected, `${catalog.slug} GitHub collector plan drifted from canonical mappings`);
    }
    assert.equal(githubCollectorPlan("A16ZSR006").targets.length, 28);
  });

  it("partitions every GitHub cohort into deterministic disjoint company shards", () => {
    for (const [batchSlug, shardCount] of [
      ["S2026", 4],
      ["S26", 2],
      ["A16ZSR006", 1]
    ]) {
      const complete = githubCollectorPlan(batchSlug);
      const shards = Array.from({ length: shardCount }, (_, shardIndex) =>
        githubCollectorPlan(batchSlug, [
          `--company-shard-count=${shardCount}`,
          `--company-shard-index=${shardIndex}`
        ])
      );
      assert.ok(shards.every((shard) => shard.companyShardCount === shardCount));
      assert.deepEqual(
        shards.map((shard) => shard.companyShardIndex),
        Array.from({ length: shardCount }, (_, shardIndex) => shardIndex)
      );
      assert.ok(shards.every((shard) => shard.totalCompanyCount === complete.companyCount));
      assert.equal(
        shards.reduce((total, shard) => total + shard.companyCount, 0),
        complete.companyCount
      );
      const targetKey = (target) =>
        `${target.entityType}:${target.entityId}:${target.githubUrl.toLowerCase()}`;
      const shardedTargetKeys = shards.flatMap((shard) => shard.targets.map(targetKey));
      assert.equal(new Set(shardedTargetKeys).size, shardedTargetKeys.length);
      assert.deepEqual(
        [...shardedTargetKeys].sort(),
        complete.targets.map(targetKey).sort()
      );
    }
  });

  it("records checked-empty GitHub discovery only after fetching each owner's official profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "returner-github-owner-attempts-"));
    const output = join(directory, "github.json");
    const preload = join(directory, "mock-fetch.mjs");
    await writeFile(
      preload,
      "globalThis.fetch = async () => new Response('<html><body>No GitHub link</body></html>', { status: 200 });\n"
    );
    execFileSync(process.execPath, [
      "scripts/fetch-github-traction.mjs",
      "--batch=A16ZSR006",
      "--max-companies=1",
      "--no-website",
      "--no-search",
      `--output=${output}`
    ], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" ")
      },
      stdio: "pipe"
    });
    const snapshot = JSON.parse(await readFile(output, "utf8"));
    const attempts = Object.values(snapshot.attempts);
    assert.equal(attempts.length, 3);
    assert.ok(attempts.every((attempt) => attempt.checkedSources.length === 1));
    assert.ok(attempts.every((attempt) => attempt.checkedSources[0].status === "checked_empty"));
    const index = indexAutonomousCollectorTaskOutcomes(snapshot, {
      kind: "github",
      batchSlug: "A16ZSR006"
    });
    assert.equal(classifyAutonomousCollectorTaskOutcome(index, {
      platform: "github",
      entityType: "company",
      entityId: "a16z-speedrun-006-acceler8"
    }).status, "blocked_or_empty");
  });

  it("fails closed when every official GitHub discovery source is rate limited", async () => {
    const directory = await mkdtemp(join(tmpdir(), "returner-github-owner-rate-limit-"));
    const output = join(directory, "github.json");
    const preload = join(directory, "mock-fetch.mjs");
    await writeFile(
      preload,
      "globalThis.fetch = async () => new Response('rate limited', { status: 429, statusText: 'Too Many Requests' });\n"
    );
    execFileSync(process.execPath, [
      "scripts/fetch-github-traction.mjs",
      "--batch=A16ZSR006",
      "--max-companies=1",
      "--no-website",
      "--no-search",
      `--output=${output}`
    ], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" ")
      },
      stdio: "pipe"
    });

    const snapshot = JSON.parse(await readFile(output, "utf8"));
    assert.equal(snapshot.source.discovery.sourceChecks.length, 3);
    assert.ok(snapshot.source.discovery.sourceChecks.every((check) => check.status === "failed"));
    assert.ok(snapshot.source.discovery.sourceChecks.every((check) =>
      check.error.includes(check.sourceUrl) && /429 Too Many Requests/.test(check.error)
    ));
    assert.ok(Object.values(snapshot.attempts).every((attempt) => attempt.outcomeStatus === "failed"));
    assert.ok(Object.values(snapshot.attempts).every((attempt) => attempt.successfulSourceCheckCount === 0));

    const index = indexAutonomousCollectorTaskOutcomes(snapshot, {
      kind: "github",
      batchSlug: "A16ZSR006"
    });
    assert.equal(classifyAutonomousCollectorTaskOutcome(index, {
      platform: "github",
      entityType: "company",
      entityId: "a16z-speedrun-006-acceler8"
    }).status, "failed");
  });

  it("uses a verified founder source when no standalone accelerator profile exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "returner-github-founder-source-"));
    const output = join(directory, "github.json");
    const preload = join(directory, "mock-fetch.mjs");
    await writeFile(
      preload,
      "globalThis.fetch = async () => new Response('<html><body>No GitHub link</body></html>', { status: 200 });\n"
    );
    execFileSync(process.execPath, [
      "scripts/fetch-github-traction.mjs",
      "--batch=S2026",
      "--max-companies=73",
      "--no-website",
      "--no-search",
      `--output=${output}`
    ], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" ")
      },
      stdio: "pipe"
    });
    const snapshot = JSON.parse(await readFile(output, "utf8"));
    const attempt = snapshot.attempts[
      "founder:founder-heyclicky-farza-majeed-manual-farza-majeed"
    ];
    assert.equal(attempt.profileUrl, "https://www.instagram.com/farza954/");
    assert.deepEqual(attempt.checkedSources, [{
      sourceKind: "official_profile",
      sourceUrl: "https://www.instagram.com/farza954/",
      status: "checked_empty",
      error: null
    }]);
    assert.equal(attempt.outcomeStatus, "blocked_or_empty");
  });

  it("deterministically covers every owner/platform and every canonical account independently", async () => {
    const catalogs = await loadAutonomousCatalogs(repositoryRoot);
    const first = buildAutonomousTaskPlan(catalogs, { runKey: "catalog-contract" });
    const second = buildAutonomousTaskPlan([...catalogs].reverse(), { runKey: "catalog-contract" });
    const expectedEntityCount = catalogs.reduce(
      (count, catalog) => count + catalog.companies.length + catalog.companies.flatMap((company) => company.founders).length,
      0
    );

    assert.equal(expectedEntityCount, 1_126);
    assert.deepEqual(first, second);
    const canonicalAccountCount = catalogs.reduce(
      (count, catalog) => count + catalog.companies.reduce(
        (batchCount, company) => batchCount + company.accounts.length +
          company.founders.reduce((founderCount, founder) => founderCount + founder.accounts.length, 0),
        0
      ),
      0
    );
    assert.equal(canonicalAccountCount, 1_837);
    assert.equal(first.filter((task) => task.account).length, canonicalAccountCount);
    assert.equal(first.length, expectedEntityCount * AUTONOMOUS_PLATFORMS.length + 4);
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
      assert.deepEqual([...new Set(platforms)].sort(), [...AUTONOMOUS_PLATFORMS].sort());
    }

    const multiplyMapped = first.filter((task) => [
      "founder-eden-robotics-stamatios-floratos-1956825",
      "a16z-speedrun-006-antihero-studios",
      "a16z-speedrun-006-quinn",
      "a16z-speedrun-006-smart-bricks"
    ].includes(task.entitySourceKey) && task.account);
    for (const [entitySourceKey, platform, expectedUrls] of [
      ["founder-eden-robotics-stamatios-floratos-1956825", "x", ["cybermetheus", "StamatisTWIY"]],
      ["a16z-speedrun-006-antihero-studios", "linkedin", ["antihero-studios", "antiherostudios-games"]],
      ["a16z-speedrun-006-quinn", "linkedin", ["meetquinn", "meetquinnai"]],
      ["a16z-speedrun-006-smart-bricks", "instagram", ["smartbricks_invest", "smartbricks.invest"]]
    ]) {
      const tasks = multiplyMapped.filter(
        (task) => task.entitySourceKey === entitySourceKey && task.platform === platform
      );
      assert.equal(tasks.length, 2);
      assert.deepEqual(
        tasks.map((task) => task.account.url.split("/").filter(Boolean).at(-1)).sort(),
        expectedUrls.sort()
      );
      assert.equal(new Set(tasks.map((task) => task.checkpointKey)).size, 2);
    }
  });

  it("makes every unavailable task explicitly terminal and reports exact coverage", async () => {
    const tasks = buildAutonomousTaskPlan(await loadAutonomousCatalogs(repositoryRoot), {
      runKey: "terminal-contract"
    });
    const reasonCounts = countBy(tasks, (task) => task.terminalReason ?? "queued");

    assert.deepEqual(reasonCounts, {
      collector_not_applicable_to_founder: 4_529,
      collector_not_available: 3_378,
      queued: 6_735
    });
    assert.ok(tasks.filter((task) => task.status === "queued").every((task) => task.terminalReason === null));
    assert.ok(tasks.filter((task) => task.status !== "queued").every((task) => Boolean(task.terminalReason)));

    const coverage = summarizeTaskCoverage(tasks);
    assert.deepEqual({
      expected: coverage.expected,
      queued: coverage.queued,
      terminal: coverage.terminal,
      mapped: coverage.mapped,
      mappedQueued: coverage.mappedQueued,
      missingMappings: coverage.missingMappings,
      unsupported: coverage.unsupported
    }, {
      expected: 14_642,
      queued: 6_735,
      terminal: 7_907,
      mapped: 1_837,
      mappedQueued: 1_837,
      missingMappings: 1_070,
      unsupported: 7_907
    });
    assert.deepEqual(
      Object.fromEntries(AUTONOMOUS_PLATFORMS.map((platform) => [platform, coverage.byPlatform[platform].expected])),
      Object.fromEntries(AUTONOMOUS_PLATFORMS.map((platform) => [
        platform,
        1_126 + ({ x: 1, linkedin: 2, instagram: 1 }[platform] ?? 0)
      ]))
    );
  });

  it("keeps process retries, durable persistence, and lock-release headroom below the workflow timeout", () => {
    const runnerTimeoutMs = 300 * 60_000;

    assert.equal(AUTONOMOUS_PROCESS_BUDGETS.collectorAttempts, 2);
    assert.equal(AUTONOMOUS_PROCESS_BUDGETS.publicCollectorAttemptMs, 90 * 60_000);
    assert.equal(AUTONOMOUS_PROCESS_BUDGETS.collectorCheckpointFlushMs, 2 * 60_000);
    assert.equal(AUTONOMOUS_PROCESS_BUDGETS.durablePersistenceHeadroomMs, 25 * 60_000);
    assert.equal(AUTONOMOUS_PROCESS_BUDGETS.lockReleaseHeadroomMs, 2 * 60_000);
    assert.ok(maxAutonomousRunnerProcessBudgetMs() < runnerTimeoutMs);
  });

  it("queues unresolved discoverable founder targets again under every new run key", async () => {
    const catalogs = await loadAutonomousCatalogs(repositoryRoot);
    const first = buildAutonomousTaskPlan(catalogs, { runKey: "central-2026-07-20-0600" });
    const next = buildAutonomousTaskPlan(catalogs, { runKey: "central-2026-07-20-1800" });
    const unresolved = first.find(
      (task) => task.entityType === "founder" && task.platform === "linkedin" && !task.account
    );
    const retry = next.find(
      (task) =>
        task.batchSlug === unresolved.batchSlug &&
        task.entitySourceKey === unresolved.entitySourceKey &&
        task.platform === unresolved.platform
    );

    assert.equal(unresolved.status, "queued");
    assert.equal(retry.status, "queued");
    assert.notEqual(retry.checkpointKey, unresolved.checkpointKey);
  });
});

describe("autonomous collector and publication gates", () => {
  const completeMatrix = ["S2026", "S26", "A16ZSR006"].flatMap((batchSlug) => [
    { batchSlug, kind: "public" },
    { batchSlug, kind: "github" }
  ]);

  it("requires one public and one GitHub collector result for every cohort", () => {
    assert.equal(validateAutonomousCollectorMatrix(completeMatrix), completeMatrix);
    assert.throws(
      () => validateAutonomousCollectorMatrix(completeMatrix.slice(1)),
      /Collector matrix was incomplete/
    );
    assert.throws(
      () => validateAutonomousCollectorMatrix([...completeMatrix, completeMatrix[0]]),
      /Collector matrix was incomplete/
    );
  });

  it("accepts terminal mapped failures only through complete explicit opt-in accounting", () => {
    const classified = {
      mappedExpected: 4,
      mappedSucceeded: 1,
      mappedNeedsReview: 1,
      mappedBlockedOrEmpty: 2,
      mappedFailed: 0,
      mappedNonTerminal: 0
    };
    assert.equal(validateMappedAutonomousCoverage(classified), classified);
    const terminalFailure = {
      ...classified,
      mappedBlockedOrEmpty: 1,
      mappedFailed: 1
    };
    assert.throws(
      () => validateMappedAutonomousCoverage(terminalFailure),
      /Mapped collector coverage was incomplete/
    );
    assert.equal(
      validateMappedAutonomousCoverage(terminalFailure, { allowTerminalFailures: true }),
      terminalFailure
    );
    assert.equal(
      validateMappedAutonomousCoverage(terminalFailure, { maxTerminalFailures: 1 }),
      terminalFailure
    );
    assert.throws(
      () => validateMappedAutonomousCoverage(
        { ...terminalFailure, mappedFailed: 2, mappedBlockedOrEmpty: 0 },
        { maxTerminalFailures: 1 }
      ),
      /failed \(budget 1\)/
    );
    assert.throws(
      () => validateMappedAutonomousCoverage(
        { ...terminalFailure, mappedBlockedOrEmpty: 0 },
        { allowTerminalFailures: true }
      ),
      /Mapped collector coverage was incomplete/
    );
    assert.throws(
      () => validateMappedAutonomousCoverage(
        { ...terminalFailure, mappedNonTerminal: 1 },
        { allowTerminalFailures: true }
      ),
      /Mapped collector coverage was incomplete/
    );
  });

  it("scales the bounded terminal-failure budget without accepting a broad outage", () => {
    assert.equal(autonomousMappedTerminalFailureBudget(0), 5);
    assert.equal(autonomousMappedTerminalFailureBudget(100), 5);
    assert.equal(autonomousMappedTerminalFailureBudget(1_837), 92);
    assert.equal(autonomousMappedTerminalFailureBudget(10_000), 500);
  });

  it("requires every planned task to exist and be terminal before publication", () => {
    const coverage = { expected: 14_616, nonTerminal: 0 };
    assert.equal(
      validateAutonomousTerminalCoverage(coverage, { expectedTaskCount: 14_616 }),
      coverage
    );
    assert.throws(
      () => validateAutonomousTerminalCoverage({ expected: 14_615, nonTerminal: 0 }, { expectedTaskCount: 14_616 }),
      /covered 14615\/14616 planned tasks/
    );
    assert.throws(
      () => validateAutonomousTerminalCoverage({ expected: 14_616, nonTerminal: 1 }, { expectedTaskCount: 14_616 }),
      /did not reach a terminal state/
    );
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

  it("rejects collector rows whose exact entity IDs are outside the selected cohort", async () => {
    const catalog = (await loadAutonomousCatalogs(repositoryRoot)).find(
      (candidate) => candidate.slug === "A16ZSR006"
    );
    const company = catalog.companies.find(
      (candidate) => candidate.sourceKey === "a16z-speedrun-006-acceler8"
    );
    const founder = company.founders[0];
    const valid = {
      source: {
        label: "Public unauthenticated platform/page ingestion",
        batchSlug: "A16ZSR006",
        fetchedAt
      },
      evidence: [{
        platform: "linkedin",
        entityType: "founder",
        entityId: founder.sourceKey,
        sourceUrl: "https://linkedin.com/posts/example_activity-7999999999999999999-test"
      }],
      needsReview: [{
        platform: "web",
        entityType: "company",
        entityId: company.sourceKey,
        candidateUrl: company.websiteUrl
      }],
      failures: []
    };

    assert.equal(validateAutonomousCollectorReferentialIntegrity(valid, {
      kind: "public",
      batchSlug: "A16ZSR006",
      catalog
    }), valid);
    assert.throws(
      () => validateAutonomousCollectorReferentialIntegrity({
        ...valid,
        needsReview: [{
          ...valid.needsReview[0],
          entityId: "company-acceler8"
        }]
      }, {
        kind: "public",
        batchSlug: "A16ZSR006",
        catalog
      }),
      /do not resolve to exact A16ZSR006 catalog entity IDs/
    );
    assert.throws(
      () => validateAutonomousCollectorReferentialIntegrity({
        ...valid,
        evidence: [{
          ...valid.evidence[0],
          entityId: `founder-acceler8-${founder.name.toLowerCase().replace(/\s+/g, "-")}`
        }]
      }, {
        kind: "public",
        batchSlug: "A16ZSR006",
        catalog
      }),
      /do not resolve to exact A16ZSR006 catalog entity IDs/
    );
    assert.throws(
      () => validateAutonomousCollectorReferentialIntegrity({
        ...valid,
        evidence: [{
          ...valid.evidence[0],
          attachedCompanyId: "company-acceler8"
        }]
      }, {
        kind: "public",
        batchSlug: "A16ZSR006",
        catalog
      }),
      /attachedCompanyId/
    );
  });
});

describe("autonomous collector task accounting", () => {
  it("suppresses only deterministic profile 404 retries with a successful alternate terminal source path", () => {
    const snapshot = {
      failures: [{ message: "Public endpoint network timeout." }],
      accounts: [{ fetched: false, error: "socket hang up" }],
      attempts: {
        alternate: {
          entityType: "founder",
          entityId: "founder-alternate",
          outcomeStatus: "blocked_or_empty",
          outcomeReason: "collector_official_sources_checked_empty_or_blocked"
        },
        allSourceFailure: {
          entityType: "founder",
          entityId: "founder-all-source-failure",
          outcomeStatus: "failed",
          outcomeReason: "collector_returned_no_owner_source_attempt"
        },
        nonterminal: {
          entityType: "founder",
          entityId: "founder-nonterminal",
          outcomeStatus: "running",
          outcomeReason: null
        }
      },
      source: {
        discovery: {
          searchFailures: [{ error: "HTTP 503 unavailable" }],
          sourceChecks: [{
            entityType: "founder",
            entityId: "founder-alternate",
            sourceKind: "official_profile",
            status: "failed",
            error: "Official source fetch failed: 404 Not Found"
          }, {
            entityType: "founder",
            entityId: "founder-alternate",
            sourceKind: "official_website",
            status: "checked_empty",
            error: null
          }, {
            entityType: "founder",
            entityId: "founder-all-source-failure",
            sourceKind: "official_profile",
            status: "failed",
            error: "Official source fetch failed: 404 Not Found"
          }, {
            entityType: "founder",
            entityId: "founder-nonterminal",
            sourceKind: "official_profile",
            status: "failed",
            error: "Official source fetch failed: 404 Not Found"
          }, {
            entityType: "founder",
            entityId: "founder-nonterminal",
            sourceKind: "official_website",
            status: "found_candidates",
            error: null
          }, {
            entityType: "company",
            entityId: "company-transport",
            sourceKind: "official_profile",
            status: "failed",
            error: "fetch failed: ECONNRESET"
          }, {
            entityType: "company",
            entityId: "company-rate-limit",
            sourceKind: "official_website",
            status: "failed",
            error: "HTTP 429 rate limit"
          }]
        }
      }
    };

    const failures = autonomousCollectorRetryableFailures(snapshot);
    assert.equal(failures.length, 7);
    assert.equal(failures.filter((failure) => /404 Not Found/.test(failure)).length, 2);
    assert.ok(failures.includes("fetch failed: ECONNRESET"));
    assert.ok(failures.includes("HTTP 429 rate limit"));
    assert.ok(failures.includes("HTTP 503 unavailable"));
    assert.ok(failures.includes("Public endpoint network timeout."));
    assert.ok(failures.includes("socket hang up"));
  });

  it("retries AbortController and ETIMEDOUT transport failures", () => {
    const failures = autonomousCollectorRetryableFailures({
      failures: [{
        message: "This operation was aborted"
      }, {
        message: "AbortError: The operation was aborted"
      }, {
        message: "connect ETIMEDOUT 203.0.113.1:443"
      }, {
        message: "Unsupported owner URL"
      }]
    });

    assert.deepEqual(failures, [
      "This operation was aborted",
      "AbortError: The operation was aborted",
      "connect ETIMEDOUT 203.0.113.1:443"
    ]);
  });

  it("requires explicit terminal outcomes for every planned GitHub and public task", () => {
    const githubTasks = [{
      batchSlug: "S26",
      status: "queued",
      platform: "github",
      entityType: "company",
      entitySourceKey: "company-acme",
      account: { url: "https://github.com/acme" }
    }, {
      batchSlug: "S26",
      status: "queued",
      platform: "github",
      entityType: "founder",
      entitySourceKey: "founder-acme-ada",
      account: null
    }];
    const githubSnapshot = {
      accounts: [{
        entityType: "company",
        entityId: "company-acme",
        githubUrl: "https://github.com/acme",
        fetched: false,
        error: "404 Not Found"
      }],
      attempts: {
        founder: {
          entityType: "founder",
          entityId: "founder-acme-ada",
          outcomeStatus: "failed",
          outcomeReason: "collector_returned_no_owner_source_attempt"
        }
      }
    };
    const githubCoverage = summarizeAutonomousCollectorTerminalTaskCoverage(githubSnapshot, {
      kind: "github",
      batchSlug: "S26",
      tasks: githubTasks
    });
    assert.equal(githubCoverage.expected, 2);
    assert.equal(githubCoverage.terminal, 2);
    assert.equal(githubCoverage.byStatus.failed, 2);

    const publicTasks = [{
      batchSlug: "S26",
      status: "queued",
      platform: "linkedin",
      entityType: "founder",
      entitySourceKey: "founder-acme-ada",
      account: { url: "https://linkedin.com/in/ada" }
    }, {
      batchSlug: "S26",
      status: "queued",
      platform: "x",
      entityType: "company",
      entitySourceKey: "company-acme",
      account: null
    }];
    const publicSnapshot = {
      evidence: [],
      needsReview: [],
      failures: [],
      attempts: {
        linkedin: {
          platform: "linkedin",
          entityType: "founder",
          entityId: "founder-acme-ada",
          accountUrl: "https://linkedin.com/in/ada",
          outcomeStatus: "failed",
          outcomeReason: "collector_reported_failure",
          error: "Reader transport timed out."
        },
        x: {
          platform: "x",
          entityType: "company",
          entityId: "company-acme",
          accountUrl: null,
          outcomeStatus: "blocked_or_empty",
          outcomeReason: "collector_checked_blocked_or_empty"
        }
      }
    };
    const publicCoverage = summarizeAutonomousCollectorTerminalTaskCoverage(publicSnapshot, {
      kind: "public",
      batchSlug: "S26",
      tasks: [...githubTasks, ...publicTasks]
    });
    assert.equal(publicCoverage.expected, 2);
    assert.equal(publicCoverage.terminal, 2);
    assert.equal(publicCoverage.nonTerminal, 0);

    publicSnapshot.attempts.x.outcomeStatus = "running";
    publicSnapshot.attempts.x.outcomeReason = null;
    const partialCoverage = summarizeAutonomousCollectorTerminalTaskCoverage(publicSnapshot, {
      kind: "public",
      batchSlug: "S26",
      tasks: publicTasks
    });
    assert.equal(partialCoverage.terminal, 1);
    assert.equal(partialCoverage.nonTerminal, 1);
    assert.equal(
      partialCoverage.nonTerminalTaskSamples[0].reason,
      "collector_returned_no_entity_attempt"
    );
  });

  it("does not count review candidates or failures as successful public output", () => {
    assert.equal(countSuccessfulAutonomousCollectorRows({
      evidence: [
        { id: "evidence-1", review_state: "verified", nativeId: "post-1" },
        { id: "quarantined-1", review_state: "needs_review" }
      ],
      needsReview: [{ id: "review-1" }, { id: "review-2" }],
      failures: [{ id: "failure-1" }]
    }, "public"), 1);
    assert.equal(countSuccessfulAutonomousCollectorRows({
      evidence: [],
      needsReview: [{ id: "review-only" }],
      failures: []
    }, "public"), 0);
    assert.equal(countSuccessfulAutonomousCollectorRows({
      evidence: [{ id: "quarantined-only", review_state: "needs_review" }],
      needsReview: [],
      failures: []
    }, "public"), 0);
    assert.equal(countSuccessfulAutonomousCollectorRows({
      evidence: [{
        id: "profile-only",
        platform: "x",
        sourceUrl: "https://x.com/acme",
        review_state: "verified"
      }],
      needsReview: [],
      failures: []
    }, "public"), 0);
    assert.equal(countSuccessfulAutonomousCollectorRows({
      accounts: [{ fetched: true }, { fetched: false }, { fetched: true }]
    }, "github"), 2);
  });

  it("classifies evidence, review-only, failure-only, and empty public tasks distinctly", () => {
    const index = indexAutonomousCollectorTaskOutcomes({
      evidence: [{
        platform: "x",
        entityType: "company",
        entityId: "company-has-evidence",
        review_state: "verified",
        nativeId: "status-42"
      }, {
        platform: "web",
        entityType: "company",
        entityId: "company-quarantined-evidence",
        review_state: "needs_review",
        matchReason: "Context row requires review."
      }, {
        platform: "x",
        entityType: "company",
        entityId: "company-profile-only",
        sourceUrl: "https://x.com/profileonly",
        review_state: "verified"
      }],
      needsReview: [{
        platform: "linkedin",
        entityType: "founder",
        entityId: "founder-review-only",
        matchReason: "Identity needs confirmation."
      }],
      failures: [{
        platform: "youtube",
        entityType: "company",
        entityId: "company-failed",
        message: "Collector was blocked."
      }, {
        platform: "youtube",
        entityType: "company",
        entityId: "company-youtube-empty",
        message: "No visible native YouTube videos were exposed on the mapped account."
      }, {
        platform: "x",
        entityType: "company",
        entityId: "company-invalid-mapping",
        message: "Invalid URL mapping: host did not match x.com."
      }, {
        platform: "linkedin",
        entityType: "company",
        entityId: "company-login-wall",
        message: "LinkedIn login wall blocked the public page."
      }, {
        platform: "reddit",
        entityType: "company",
        entityId: "company-rate-blocked",
        message: "Public endpoint rate limited the request (429)."
      }]
    }, { kind: "public", batchSlug: "S26" });

    assert.deepEqual(classifyAutonomousCollectorTaskOutcome(index, {
      platform: "x",
      entityType: "company",
      entityId: "company-has-evidence"
    }), { status: "completed", reason: "collector_evidence_collected" });
    assert.deepEqual(classifyAutonomousCollectorTaskOutcome(index, {
      platform: "web",
      entityType: "company",
      entityId: "company-quarantined-evidence"
    }), { status: "needs_review", reason: "collector_needs_review" });
    assert.deepEqual(classifyAutonomousCollectorTaskOutcome(index, {
      platform: "x",
      entityType: "company",
      entityId: "company-profile-only"
    }), { status: "blocked_or_empty", reason: "collector_context_only" });
    assert.deepEqual(classifyAutonomousCollectorTaskOutcome(index, {
      platform: "linkedin",
      entityType: "founder",
      entityId: "founder-review-only"
    }), { status: "needs_review", reason: "collector_needs_review" });
    assert.deepEqual(classifyAutonomousCollectorTaskOutcome(index, {
      platform: "youtube",
      entityType: "company",
      entityId: "company-failed"
    }), { status: "blocked_or_empty", reason: "collector_checked_blocked_or_empty" });
    assert.deepEqual(classifyAutonomousCollectorTaskOutcome(index, {
      platform: "youtube",
      entityType: "company",
      entityId: "company-youtube-empty"
    }), { status: "blocked_or_empty", reason: "collector_checked_blocked_or_empty" });
    assert.deepEqual(classifyAutonomousCollectorTaskOutcome(index, {
      platform: "x",
      entityType: "company",
      entityId: "company-invalid-mapping"
    }), { status: "failed", reason: "collector_reported_failure" });
    for (const [platform, entityId] of [
      ["linkedin", "company-login-wall"],
      ["reddit", "company-rate-blocked"]
    ]) {
      assert.equal(classifyAutonomousCollectorTaskOutcome(index, {
        platform,
        entityType: "company",
        entityId
      }).status, "blocked_or_empty");
    }
    assert.deepEqual(classifyAutonomousCollectorTaskOutcome(index, {
      platform: "reddit",
      entityType: "company",
      entityId: "company-empty"
    }), { status: "nonterminal", reason: "collector_returned_no_entity_attempt" });
  });

  it("terminalizes only an unmapped RSS discovery task after its public collector completed", () => {
    const completedPublicOutcomeIndex = indexAutonomousCollectorTaskOutcomes({
      evidence: [],
      needsReview: [],
      failures: [],
      attempts: {}
    }, {
      kind: "public",
      batchSlug: "S26",
      explicitTerminalOnly: true
    });
    const rssTask = {
      platform: "rss",
      entityType: "company",
      entityId: "company-no-feed",
      accountUrl: null
    };

    assert.deepEqual(
      classifyAutonomousCollectorTaskOutcome(completedPublicOutcomeIndex, rssTask),
      {
        status: "blocked_or_empty",
        reason: "collector_checked_no_rss_feed"
      }
    );
    assert.deepEqual(
      classifyAutonomousCollectorTaskOutcome(null, rssTask),
      {
        status: "nonterminal",
        reason: "collector_returned_no_entity_attempt"
      }
    );
    assert.deepEqual(
      classifyAutonomousCollectorTaskOutcome(completedPublicOutcomeIndex, {
        ...rssTask,
        platform: "web"
      }),
      {
        status: "nonterminal",
        reason: "collector_returned_no_entity_attempt"
      }
    );

    const coverage = summarizeAutonomousCollectorTerminalTaskCoverage({
      evidence: [],
      needsReview: [],
      failures: [],
      attempts: {}
    }, {
      kind: "public",
      batchSlug: "S26",
      tasks: [{
        batchSlug: "S26",
        status: "queued",
        platform: "rss",
        entityType: "company",
        entitySourceKey: "company-no-feed",
        account: null
      }]
    });
    assert.equal(coverage.expected, 1);
    assert.equal(coverage.terminal, 1);
    assert.equal(coverage.nonTerminal, 0);
    assert.equal(coverage.byStatus.blocked_or_empty, 1);
  });

  it("prefers validated evidence over review and failure rows for the same task", () => {
    const task = {
      platform: "x",
      entityType: "company",
      entityId: "company-mixed"
    };
    const row = { ...task, nativeId: "status-42" };
    const index = indexAutonomousCollectorTaskOutcomes({
      evidence: [row],
      needsReview: [{ ...row, matchReason: "Secondary candidate needs review." }],
      failures: [{ ...row, message: "One fallback source failed." }]
    }, { kind: "public", batchSlug: "S26" });

    assert.deepEqual(classifyAutonomousCollectorTaskOutcome(index, task), {
      status: "completed",
      reason: "collector_evidence_collected"
    });
  });

  it("keeps outcomes isolated for multiple accounts owned by the same entity and platform", () => {
    const entity = {
      platform: "x",
      entityType: "founder",
      entityId: "founder-eden-robotics-stamatios-floratos-1956825"
    };
    const index = indexAutonomousCollectorTaskOutcomes({
      evidence: [{
        ...entity,
        accountUrl: "https://x.com/cybermetheus",
        sourceUrl: "https://x.com/cybermetheus/status/42",
        nativeId: "42",
        review_state: "verified"
      }],
      needsReview: [],
      failures: [],
      attempts: {
        primary: {
          ...entity,
          accountUrl: "https://x.com/cybermetheus",
          status: "done",
          outcomeStatus: "completed",
          outcomeReason: "collector_evidence_collected"
        },
        alias: {
          ...entity,
          accountUrl: "https://x.com/StamatisTWIY",
          status: "done",
          outcomeStatus: "blocked_or_empty",
          outcomeReason: "collector_checked_blocked_or_empty"
        }
      }
    }, { kind: "public", batchSlug: "S2026" });

    assert.equal(classifyAutonomousCollectorTaskOutcome(index, {
      ...entity,
      accountUrl: "https://x.com/cybermetheus"
    }).status, "completed");
    assert.equal(classifyAutonomousCollectorTaskOutcome(index, {
      ...entity,
      accountUrl: "https://x.com/StamatisTWIY"
    }).status, "blocked_or_empty");
    assert.equal(classifyAutonomousCollectorTaskOutcome(index, entity).status, "completed");
  });

  it("normalizes A16Z collector IDs and marks missing or failed GitHub accounts accurately", () => {
    const index = indexAutonomousCollectorTaskOutcomes({
      accounts: [
        {
          entityType: "company",
          entityId: "company-acceler8",
          companySlug: "acceler8",
          fetched: true
        },
        {
          entityType: "founder",
          entityId: "founder-acceler8-trisha-pathak-a16z-speedrun-006-acceler8-founder-trisha-pathak",
          companySlug: "acceler8",
          entityName: "Trisha Pathak",
          fetched: false,
          error: "GitHub API unavailable."
        }
      ]
    }, { kind: "github", batchSlug: "A16ZSR006" });

    assert.equal(classifyAutonomousCollectorTaskOutcome(index, {
      platform: "github",
      entityType: "company",
      entityId: "a16z-speedrun-006-acceler8"
    }).status, "completed");
    assert.deepEqual(classifyAutonomousCollectorTaskOutcome(index, {
      platform: "github",
      entityType: "founder",
      entityId: "a16z-speedrun-006-acceler8-founder-trisha-pathak"
    }), { status: "failed", reason: "collector_reported_failure" });
    assert.deepEqual(classifyAutonomousCollectorTaskOutcome(index, {
      platform: "github",
      entityType: "company",
      entityId: "a16z-speedrun-006-no-account"
    }), {
      status: "blocked_or_empty",
      reason: "collector_checked_no_github_mapping"
    });
    assert.deepEqual(classifyAutonomousCollectorTaskOutcome(null, {
      platform: "github",
      entityType: "company",
      entityId: "a16z-speedrun-006-no-account",
      collectorOk: false,
      collectorError: "Process exited 1."
    }), { status: "failed", reason: "Process exited 1." });
  });

  it("does not let one GitHub account outcome satisfy another account for the same owner", () => {
    const index = indexAutonomousCollectorTaskOutcomes({
      accounts: [{
        entityType: "company",
        entityId: "company-acme",
        githubUrl: "https://github.com/acme/working",
        fetched: true
      }, {
        entityType: "company",
        entityId: "company-acme",
        githubUrl: "https://github.com/acme-archive",
        fetched: false,
        error: "GitHub API unavailable."
      }]
    }, { kind: "github", batchSlug: "S26" });

    assert.equal(classifyAutonomousCollectorTaskOutcome(index, {
      platform: "github",
      entityType: "company",
      entityId: "company-acme",
      accountUrl: "https://github.com/acme/working"
    }).status, "completed");
    assert.equal(classifyAutonomousCollectorTaskOutcome(index, {
      platform: "github",
      entityType: "company",
      entityId: "company-acme",
      accountUrl: "https://github.com/acme-archive"
    }).status, "failed");
  });

  it("preserves an exact A16Z missing-URL founder receipt as terminal", () => {
    const entityId = "a16z-speedrun-006-loops-ai-founder-ilker-zorluoglu";
    const index = indexAutonomousCollectorTaskOutcomes({
      attempts: {
        "x:founder:a16z-speedrun-006-loops-ai-founder-ilker-zorluoglu:missing-url": {
          batchSlug: "A16ZSR006",
          platform: "x",
          entityType: "founder",
          entityId,
          entityName: "Ilker Zorluoglu",
          accountUrl: null,
          status: "done",
          outcomeStatus: "blocked_or_empty",
          outcomeReason: "collector_checked_blocked_or_empty"
        }
      }
    }, { kind: "public", batchSlug: "A16ZSR006", explicitTerminalOnly: true });

    assert.deepEqual(classifyAutonomousCollectorTaskOutcome(index, {
      platform: "x",
      entityType: "founder",
      entityId,
      accountUrl: null
    }), {
      status: "blocked_or_empty",
      reason: "collector_checked_blocked_or_empty"
    });
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
    assert.equal(normalizeAutonomousFailureEntityId({
      entityType: "founder",
      entityId: "a16z-speedrun-006-loops-ai-founder-ilker-zorluoglu",
      entityName: "Ilker Zorluoglu"
    }, { batchSlug: "A16ZSR006" }), "a16z-speedrun-006-loops-ai-founder-ilker-zorluoglu");
  });

  it("leaves other batch entity IDs unchanged", () => {
    assert.equal(normalizeAutonomousFailureEntityId({
      entityId: "company-acme",
      companySlug: "acme"
    }, { batchSlug: "S26" }), "company-acme");
  });
});

describe("autonomous public evidence merge", () => {
  it("persists batch-scoped terminal attempt receipts so later slots can resume", () => {
    const merged = mergePublicEvidenceSnapshots([
      {
        source: { batchSlug: "S2026" },
        attempts: {
          "x:company:company-example:https://x.com/example": {
            status: "done",
            checkedAt: "2026-07-24T06:00:00.000Z",
            batchSlug: "S2026",
            platform: "x",
            entityType: "company",
            entityId: "company-example",
            outcomeStatus: "completed",
            outcomeReason: "collector_verified_native_evidence"
          }
        },
        evidence: [],
        needsReview: [],
        failures: []
      },
      {
        source: { batchSlug: "S26" },
        attempts: {
          "x:company:company-example:https://x.com/example": {
            status: "done",
            checkedAt: "2026-07-24T18:00:00.000Z",
            batchSlug: "S26",
            platform: "x",
            entityType: "company",
            entityId: "company-example",
            outcomeStatus: "blocked_or_empty",
            outcomeReason: "collector_checked_blocked_or_empty"
          }
        },
        evidence: [],
        needsReview: [],
        failures: []
      }
    ], { fetchedAt: "2026-07-24T18:01:00.000Z" });

    assert.equal(Object.keys(merged.attempts).length, 2);
    assert.equal(merged.source.attemptCount, 2);
    assert.equal(
      merged.attempts["S2026:x:company:company-example:https://x.com/example"].attemptKey,
      "x:company:company-example:https://x.com/example"
    );
    assert.equal(
      merged.attempts["S26:x:company:company-example:https://x.com/example"].batchSlug,
      "S26"
    );
  });

  it("replaces a malformed legacy attempt timestamp with a valid fresh shard receipt", () => {
    const attemptKey = "x:company:company-example:https://x.com/example";
    const merged = mergePublicEvidenceSnapshots([
      {
        source: { batchSlug: "S26" },
        attempts: {
          [attemptKey]: {
            status: "done",
            checkedAt: "not-a-date",
            batchSlug: "S26",
            platform: "x",
            entityType: "company",
            entityId: "company-example",
            outcomeStatus: "blocked_or_empty",
            outcomeReason: "legacy"
          }
        },
        evidence: [],
        needsReview: [],
        failures: []
      },
      {
        source: { batchSlug: "S26" },
        attempts: {
          [attemptKey]: {
            status: "done",
            checkedAt: "2026-07-24T18:00:00.000Z",
            batchSlug: "S26",
            platform: "x",
            entityType: "company",
            entityId: "company-example",
            outcomeStatus: "completed",
            outcomeReason: "fresh_shard_receipt"
          }
        },
        evidence: [],
        needsReview: [],
        failures: []
      }
    ]);

    assert.equal(
      merged.attempts[`S26:${attemptKey}`].outcomeReason,
      "fresh_shard_receipt"
    );
  });

  it("retains a native multi-company post once for each distinct entity attribution", () => {
    const sourceUrl = "https://www.linkedin.com/posts/test_activity-7999999999999999999-fixture";
    const merged = mergePublicEvidenceSnapshots([
      {
        source: { batchSlug: "S2026" },
        evidence: [
          {
            entityId: "company-eden-robotics",
            platform: "linkedin",
            nativeId: "7999999999999999999",
            sourceUrl,
            metrics: { reactions: 2 },
            review_state: "verified",
            last_checked_at: "2026-07-20T12:00:00.000Z"
          },
          {
            entityId: "company-9-mothers-corporation",
            platform: "linkedin",
            nativeId: "7999999999999999999",
            sourceUrl,
            metrics: { reactions: 2 },
            review_state: "verified",
            last_checked_at: "2026-07-20T12:00:00.000Z"
          },
          {
            entityId: "company-eden-robotics",
            platform: "linkedin",
            nativeId: "7999999999999999999",
            sourceUrl,
            metrics: { reactions: 1 },
            review_state: "verified",
            last_checked_at: "2026-07-19T12:00:00.000Z",
            stale: true
          }
        ],
        needsReview: [],
        failures: []
      }
    ]);

    assert.equal(merged.evidence.length, 2);
    assert.deepEqual(
      merged.evidence.map((row) => row.entityId).sort(),
      ["company-9-mothers-corporation", "company-eden-robotics"]
    );
    assert.equal(merged.evidence.some((row) => row.stale), false);
  });

  it("quarantines a repeated physical post within one company rollup and replays idempotently", () => {
    const platformPostId = "2070898557645660388";
    const sourceUrl = `https://x.com/rhs/status/${platformPostId}`;
    const nativeAuthorResolution = {
      status: "matched",
      owner: {
        batchSlug: "S2026",
        entityType: "founder",
        entityId: "founder-9-mothers-russell-smith",
        companySlug: "9-mothers"
      }
    };
    const base = {
      companySlug: "9-mothers",
      companyName: "9 Mothers",
      platform: "x",
      platformPostId,
      sourceUrl,
      metrics: { views: 7900 },
      review_state: "verified",
      nativeAuthorResolution
    };
    const merged = mergePublicEvidenceSnapshots([{
      source: { batchSlug: "S2026" },
      evidence: [
        {
          ...base,
          id: "company-subject-copy",
          entityType: "company",
          entityId: "company-9-mothers",
          attributionMode: "subject"
        },
        {
          ...base,
          id: "founder-native-copy",
          entityType: "founder",
          entityId: "founder-9-mothers-russell-smith",
          attributionMode: "account_owner"
        }
      ],
      needsReview: [],
      failures: []
    }], { fetchedAt: "2026-07-20T00:00:00.000Z" });

    assert.deepEqual(merged.evidence.map((row) => row.id), ["founder-native-copy"]);
    assert.equal(merged.source.duplicatePhysicalEvidenceCount, 1);
    const duplicate = merged.needsReview.find((row) => row.sourceEvidenceId === "company-subject-copy");
    assert.deepEqual(duplicate.quarantineReasons, ["same_rollup_physical_post_identity"]);
    assert.equal(duplicate.duplicateEvidenceIdentity.duplicateOf.id, "founder-native-copy");
    assert.ok(merged.attributionReconciliationLedger.some((entry) =>
      entry.platform === "x" &&
      entry.platformPostId === platformPostId &&
      entry.disposition === "quarantined" &&
      entry.staleAttribution.entityId === "company-9-mothers"
    ));

    const replayed = mergePublicEvidenceSnapshots([merged], {
      fetchedAt: "2026-07-20T00:00:00.000Z"
    });
    assert.deepEqual(replayed.evidence, merged.evidence);
    assert.deepEqual(replayed.needsReview, merged.needsReview);
    assert.deepEqual(
      replayed.attributionReconciliationLedger,
      merged.attributionReconciliationLedger
    );
    assert.equal(replayed.source.duplicatePhysicalEvidenceCount, 0);
  });

  it("treats a refreshed observation for the same attribution as an update, not a physical duplicate", () => {
    const base = {
      entityType: "company",
      entityId: "company-acme",
      companySlug: "acme",
      companyName: "Acme",
      platform: "x",
      platformPostId: "42",
      sourceUrl: "https://x.com/acme/status/42",
      review_state: "verified"
    };
    const merged = mergePublicEvidenceSnapshots([
      {
        source: { batchSlug: "S26" },
        evidence: [{
          ...base,
          id: "fresh",
          metrics: { views: 20 },
          last_checked_at: "2026-07-20T12:00:00.000Z"
        }]
      },
      {
        source: { batchSlug: "S26" },
        evidence: [{
          ...base,
          id: "previous",
          sourceUrl: "https://twitter.com/acme/status/42?utm_source=previous",
          metrics: { views: 10 },
          last_checked_at: "2026-07-19T12:00:00.000Z"
        }]
      }
    ]);

    assert.deepEqual(merged.evidence.map((row) => row.id), ["fresh"]);
    assert.equal(merged.source.duplicatePhysicalEvidenceCount, 0);
    assert.equal(
      merged.needsReview.some((row) => row.quarantineReasons?.includes("same_rollup_physical_post_identity")),
      false
    );
  });

  it("selects the same rollup attribution regardless of snapshot row order", () => {
    const row = (entityId) => ({
      id: "shared-collector-id",
      entityType: "founder",
      entityId,
      companySlug: "acme",
      companyName: "Acme",
      platform: "x",
      platformPostId: "43",
      sourceUrl: "https://x.com/thirdparty/status/43",
      metrics: { views: 10 },
      review_state: "verified",
      attributionMode: "subject"
    });
    const merge = (evidence) => mergePublicEvidenceSnapshots([{
      source: { batchSlug: "S26" },
      evidence
    }]);
    const forward = merge([row("founder-acme-a"), row("founder-acme-b")]);
    const reversed = merge([row("founder-acme-b"), row("founder-acme-a")]);

    assert.deepEqual(forward.evidence.map((item) => item.entityId), ["founder-acme-a"]);
    assert.deepEqual(reversed.evidence.map((item) => item.entityId), ["founder-acme-a"]);
    assert.deepEqual(
      forward.needsReview.map((item) => item.entityId),
      reversed.needsReview.map((item) => item.entityId)
    );
  });

  it("deduplicates stale company review aliases by canonical batch rollup", () => {
    const candidateUrl = "https://producthunt.com/products/panorama";
    const merged = mergePublicEvidenceSnapshots([{
      source: { batchSlug: "A16ZSR006" },
      needsReview: [
        {
          id: "newer-stale-alias",
          entityType: "company",
          entityId: "company-panorama",
          companySlug: "panorama",
          companyName: "Panorama",
          platform: "product_hunt",
          candidateUrl,
          review_state: "needs_review",
          last_checked_at: "2026-07-20T13:00:00.000Z"
        },
        {
          id: "older-canonical-owner",
          entityType: "company",
          entityId: "a16z-speedrun-006-panorama",
          companySlug: "panorama",
          companyName: "Panorama",
          platform: "product_hunt",
          candidateUrl,
          review_state: "needs_review",
          last_checked_at: "2026-07-20T12:00:00.000Z"
        }
      ]
    }]);

    assert.deepEqual(
      merged.needsReview.map((row) => [row.id, row.entityId, row.candidateUrl]),
      [["older-canonical-owner", "a16z-speedrun-006-panorama", candidateUrl]]
    );
  });

  it("deduplicates X, LinkedIn, and YouTube URL aliases while preserving the newest observation", () => {
    const newer = {
      source: { batchSlug: "S26" },
      evidence: [
        {
          entityId: "company-acme",
          platform: "x",
          sourceUrl: "https://x.com/acme/status/42/",
          platformPostId: "42",
          metrics: { views: 20 },
          review_state: "verified",
          last_checked_at: "2026-07-18T14:00:00.000Z",
          marker: "new-x"
        },
        {
          entityId: "company-acme",
          platform: "linkedin",
          platformPostId: "7999999999999999999",
          sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7999999999999999999",
          metrics: { reactions: 3 },
          review_state: "verified",
          last_checked_at: "2026-07-18T13:00:00.000Z",
          marker: "new-linkedin"
        },
        {
          entityId: "company-acme",
          platform: "youtube",
          platformPostId: "abcDEF123",
          sourceUrl: "https://www.youtube.com/watch?v=abcDEF123",
          metrics: { views: 40 },
          review_state: "verified",
          last_checked_at: "2026-07-18T12:00:00.000Z",
          marker: "new-youtube"
        }
      ],
      needsReview: [{ id: "review-1", last_checked_at: "2026-07-18T12:00:00.000Z", marker: "new-review" }],
      failures: [{ id: "failure-1", checkedAt: "2026-07-18T11:00:00.000Z", marker: "new-failure" }]
    };
    const older = {
      source: { batchSlug: "S26" },
      evidence: [
        {
          entityId: "company-acme",
          platform: "twitter",
          sourceUrl: "https://www.twitter.com/acme/status/42?utm_source=old#fragment",
          nativeId: "42",
          metrics: { views: 10 },
          review_state: "verified",
          last_checked_at: "2026-07-17T14:00:00.000Z",
          marker: "old-x"
        },
        {
          entityId: "company-acme",
          platform: "linkedin",
          nativeId: "7999999999999999999",
          sourceUrl: "https://www.linkedin.com/posts/acme_activity-7999999999999999999-fixture",
          metrics: { reactions: 1 },
          review_state: "verified",
          last_checked_at: "2026-07-17T13:00:00.000Z",
          marker: "old-linkedin"
        },
        {
          entityId: "company-acme",
          platform: "youtube",
          nativeId: "abcDEF123",
          sourceUrl: "https://youtu.be/abcDEF123?si=old",
          metrics: { views: 30 },
          review_state: "verified",
          last_checked_at: "2026-07-17T12:00:00.000Z",
          marker: "old-youtube"
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
      batchSlugs: ["S26"],
      evidenceCount: 3,
      needsReviewCount: 1,
      failureCount: 1
    });
    assert.deepEqual({
      evidence: merged.evidence.map((row) => row.marker).sort(),
      needsReview: merged.needsReview.map((row) => row.marker).sort(),
      failures: merged.failures.map((row) => row.marker).sort()
    }, {
      evidence: ["new-linkedin", "new-x", "new-youtube"],
      needsReview: ["new-review"],
      failures: ["new-failure"]
    }, "dedupe must compare platform-native physical identities and collector timestamps");
  });

  it("deduplicates native aliases within a batch but never collapses the same post across batches", () => {
    const row = {
      entityId: "company-textsidekick",
      platform: "x",
      sourceUrl: "https://x.com/textsidekick/status/123456",
      platformPostId: "123456",
      metrics: { views: 7 },
      review_state: "verified"
    };
    const merged = mergePublicEvidenceSnapshots([
      {
        source: { batchSlug: "S26" },
        evidence: [
          { ...row, sourceUrl: "https://twitter.com/textsidekick/status/123456?utm_source=a", marker: "summer-old", last_checked_at: "2026-07-19T00:00:00.000Z" },
          { ...row, marker: "summer-new", last_checked_at: "2026-07-20T00:00:00.000Z" }
        ]
      },
      {
        source: { batchSlug: "S2026" },
        evidence: [{ ...row, marker: "spring", last_checked_at: "2026-07-20T00:00:00.000Z" }]
      }
    ]);

    assert.equal(merged.evidence.length, 2);
    assert.deepEqual(
      merged.evidence.map((item) => [item.batchSlug, item.marker]).sort(),
      [["S2026", "spring"], ["S26", "summer-new"]]
    );
  });

  it("resolves uniquely attributable legacy rows and quarantines ambiguous cross-batch owners", () => {
    const resolveBatchSlug = (row) => row.entityId === "company-unique-spring" ? "S2026" : null;
    const base = {
      platform: "x",
      metrics: { views: 1 },
      review_state: "verified"
    };
    const merged = mergePublicEvidenceSnapshots([{
      source: { batchSlugs: ["S2026", "S26"] },
      evidence: [
        { ...base, id: "unique", entityId: "company-unique-spring", sourceUrl: "https://x.com/unique/status/200" },
        { ...base, id: "ambiguous", entityId: "company-textsidekick", sourceUrl: "https://x.com/textsidekick/status/201" }
      ]
    }], { resolveBatchSlug });

    assert.deepEqual(merged.evidence.map((row) => [row.id, row.batchSlug]), [["unique", "S2026"]]);
    const ambiguous = merged.needsReview.find((row) => row.sourceEvidenceId === "ambiguous");
    assert.ok(ambiguous.quarantineReasons.includes("missing_or_ambiguous_batch_scope"));
  });

  it("quarantines identity conflicts, non-native URLs, unsupported platforms, and metricless rows", () => {
    const base = {
      entityId: "company-acme",
      platform: "x",
      metrics: { views: 1 },
      review_state: "verified"
    };
    const merged = mergePublicEvidenceSnapshots([{
      source: { batchSlug: "S26" },
      evidence: [
        { ...base, id: "conflict", sourceUrl: "https://x.com/acme/status/100", platformPostId: "101" },
        { ...base, id: "profile", sourceUrl: "https://x.com/acme" },
        { ...base, id: "web", platform: "web", sourceUrl: "https://acme.example", metrics: {} },
        { ...base, id: "metricless", sourceUrl: "https://x.com/acme/status/102", metrics: {} },
        { ...base, id: "accepted", sourceUrl: "https://x.com/acme/status/103", platformPostId: "103" }
      ]
    }]);

    assert.deepEqual(merged.evidence.map((row) => row.id), ["accepted"]);
    assert.equal(merged.source.quarantinedEvidenceCount, 4);
    const reasons = new Map(merged.needsReview.map((row) => [row.sourceEvidenceId, row.quarantineReasons]));
    assert.ok(reasons.get("conflict").some((reason) => reason.startsWith("native_id_conflict:")));
    assert.ok(reasons.get("profile").includes("not_native_activity_url"));
    assert.ok(reasons.get("web").includes("unsupported_platform:web"));
    assert.ok(reasons.get("metricless").includes("no_visible_positive_scoring_metrics"));
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

  it("prunes confirmed retired GitHub rows without dropping last-good active failures", () => {
    const previous = {
      source: { batchSlug: "A16ZSR006" },
      accounts: [{
        entityType: "company",
        entityId: "a16z-speedrun-006-amdahl",
        githubUrl: "https://github.com/amdahl-ai",
        login: "amdahl-ai",
        repo: null,
        fetched: true,
        marker: "retired"
      }, {
        entityType: "company",
        entityId: "a16z-speedrun-006-amdahl",
        githubUrl: "https://github.com/amdahlco",
        login: "amdahlco",
        repo: null,
        fetched: true,
        marker: "last-good-active"
      }]
    };
    const fresh = {
      source: {
        batchSlug: "A16ZSR006",
        retiredAccountMappings: [{
          entityType: "company",
          entityId: "a16z-speedrun-006-amdahl",
          url: "https://github.com/amdahl-ai"
        }]
      },
      accounts: [{
        entityType: "company",
        entityId: "a16z-speedrun-006-amdahl",
        githubUrl: "https://github.com/amdahlco",
        login: "amdahlco",
        repo: null,
        fetched: false,
        marker: "fresh-failure"
      }]
    };
    const merged = mergeGithubTractionSnapshots(previous, fresh);
    assert.equal(merged.source.prunedRetired, 1);
    assert.equal(merged.source.retainedLastGood, 1);
    assert.deepEqual(merged.accounts.map((row) => row.marker), ["last-good-active"]);
  });
});

function githubCollectorPlan(batchSlug, extraArgs = []) {
  return JSON.parse(execFileSync(
    process.execPath,
    ["scripts/fetch-github-traction.mjs", `--batch=${batchSlug}`, "--plan", ...extraArgs],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
  ));
}

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
