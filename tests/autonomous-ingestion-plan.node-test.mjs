import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTONOMOUS_BATCHES,
  AUTONOMOUS_PLATFORMS,
  AUTONOMOUS_PROCESS_BUDGETS,
  autonomousMappedTerminalFailureBudget,
  autonomousCollectorAccountKey,
  autonomousCollectorRetryableFailures,
  isAutonomousCollectorFailureRetryable,
  isAutonomousProviderBlocker,
  buildAutonomousTaskPlan,
  classifyAutonomousCollectorTaskOutcome,
  countSuccessfulAutonomousCollectorRows,
  indexAutonomousCollectorTaskOutcomes,
  isAutonomousCollectorTaskForRun,
  loadAutonomousCatalogs,
  maxAutonomousRunnerProcessBudgetMs,
  mergeGithubTractionSnapshots,
  mergePublicEvidenceSnapshots,
  mergeVerifiedOverridesIntoCatalog,
  normalizeVerifiedSocialOverrideLinks,
  normalizeAutonomousFailureEntityId,
  partitionAutonomousTaskInventory,
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
import { canonicalGithubTargetUrl } from "../scripts/lib/github-url.mjs";

const repositoryRoot = process.cwd();

describe("autonomous runner resume contract", () => {
  it("reuses the existing Top Voice receipt when snapshot resume is requested", async () => {
    const source = await readFile(
      join(repositoryRoot, "scripts/run-autonomous-ingestion.mjs"),
      "utf8"
    );

    assert.match(
      source,
      /await runFailFastBranches\(\[\s*\(\) => runCollectors\(\),\s*\(\) => resumeTopVoiceRefresh\(\)\s*\]\)/
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

  it("loads every real catalog and honors its declared relational count contract", async () => {
    const catalogs = await loadAutonomousCatalogs(repositoryRoot);

    const summaries = catalogs.map(summarizeCatalog);
    assert.deepEqual(
      summaries.map((catalog) => catalog.slug).sort(),
      ["A16ZSR006", "S2026", "S26"]
    );
    for (const [index, summary] of summaries.entries()) {
      const catalog = catalogs[index];
      assert.ok(summary.companies > 0, `${summary.slug} must retain companies`);
      assert.ok(summary.founders >= summary.companies, `${summary.slug} must retain founder coverage`);
      assert.ok(summary.accounts >= summary.companies, `${summary.slug} must retain account coverage`);
      assert.equal(summary.companies, catalog.expectedCompanyCount);
      assert.equal(summary.founders, catalog.expectedFounderCount);
    }
    const summer = catalogs.find((catalog) => catalog.slug === "S26");
    const summerSummary = summaries.find((catalog) => catalog.slug === "S26");
    assert.ok(summer && summerSummary);
    assert.equal(summerSummary.companies, summer.expectedCompanyCount);
    assert.equal(summerSummary.founders, summer.expectedFounderCount);
    assert.ok(summerSummary.companies >= summer.minimumCompanyCount);
    assert.ok(summerSummary.founders >= summer.minimumFounderCount);
    assert.ok(summerSummary.accounts >= summer.minimumAccountCount);
    const graphify = summer.companies.find((company) => company.sourceKey === "company-graphify-labs");
    assert.equal(graphify?.name, "Graphify Labs");
    assert.deepEqual(
      graphify?.accounts.map((account) => account.platform).sort(),
      ["github", "linkedin", "x"]
    );
  });

  it("schedules Advocate's official LinkedIn account from both audited mapping layers", async () => {
    const catalogs = await loadAutonomousCatalogs(repositoryRoot);
    const a16z = catalogs.find((catalog) => catalog.slug === "A16ZSR006");
    const advocate = a16z.companies.find(
      (company) => company.sourceKey === "a16z-speedrun-006-advocate"
    );
    assert.deepEqual(
      advocate.accounts.filter((account) => account.platform === "linkedin").map((account) => account.url),
      ["https://www.linkedin.com/company/advocate-wellbeing"]
    );

    const task = buildAutonomousTaskPlan(catalogs, { runKey: "advocate-linkedin-contract" }).find(
      (candidate) =>
        candidate.entitySourceKey === advocate.sourceKey &&
        candidate.platform === "linkedin" &&
        candidate.account.url === "https://www.linkedin.com/company/advocate-wellbeing"
    );
    assert.equal(task.status, "queued");
    assert.equal(task.terminalReason, null);

    const sourceOfTruth = await readFile(
      join(repositoryRoot, "scripts/ingest-a16z-speedrun-social-accounts.mjs"),
      "utf8"
    );
    assert.match(
      sourceOfTruth,
      /\{ companyName: "Advocate", url: "https:\/\/www\.linkedin\.com\/company\/advocate-wellbeing" \}/
    );
  });

  it("fails closed when the A16Z graph drops an owner from its independent roster", async () => {
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
        "founder-vestris-aahil-valliani-3411947",
        "founder-vestris-joshua-tang-3411757"
      ]
    );
    assert.deepEqual(
      vestris.founders
        .map((founder) => [founder.sourceKey, founder.legacyEntityAliases])
        .sort(([left], [right]) => left.localeCompare(right)),
      [
        [
          "founder-vestris-aahil-valliani-3411947",
          ["founder-vestris-aahil-valliani-verified-aahil-valliani"]
        ],
        [
          "founder-vestris-joshua-tang-3411757",
          ["founder-vestris-joshua-tang-verified-joshua-tang"]
        ]
      ]
    );
    assert.ok(vestris.founders.every((founder) =>
      founder.accounts.some((account) => account.platform === "linkedin")
    ));

    const sharedHyperparticle = ownerMappings.filter(
      (mapping) => mapping.account.platform === "x" && /x\.com\/hyperparticle\/?$/i.test(mapping.account.url)
    );
    assert.equal(sharedHyperparticle.length, 1);
    assert.equal(sharedHyperparticle[0].entity.entityType, "founder");
    assert.equal(sharedHyperparticle[0].entity.sourceKey, "founder-rekursivai-dan-kondratyuk-3527564");
  });

  it("preserves a verified founder source key as an alias when the mutable YC roster publishes that founder", () => {
    const [vestris] = mergeVerifiedOverridesIntoCatalog([{
      entityType: "company",
      sourceKey: "company-vestris",
      name: "Vestris",
      batchSlug: "S26",
      accounts: [],
      founders: [{
        entityType: "founder",
        sourceKey: "founder-vestris-aahil-valliani-3411947",
        name: "Aahil Valliani",
        batchSlug: "S26",
        companySourceKey: "company-vestris",
        profileUrl: "https://www.ycombinator.com/companies/vestris",
        accounts: []
      }]
    }], {
      vestris: {
        founders: [{
          id: "verified-aahil-valliani",
          name: "Aahil Valliani",
          sourceUrl: "https://www.linkedin.com/posts/aahil-valliani_activity-7467251847137939459",
          socialLinks: { linkedin: "https://www.linkedin.com/in/aahil-valliani" }
        }]
      }
    }, { slug: "S26" });

    assert.equal(vestris.founders.length, 1);
    assert.equal(vestris.founders[0].sourceKey, "founder-vestris-aahil-valliani-3411947");
    assert.deepEqual(vestris.founders[0].legacyEntityAliases, [
      "founder-vestris-aahil-valliani-verified-aahil-valliani"
    ]);
    assert.ok(vestris.founders[0].accounts.some((account) =>
      account.platform === "linkedin" && /linkedin\.com\/in\/aahil-valliani/.test(account.url)
    ));
  });

  it("loads every staged Product Hunt and Reddit mapping, including multiple same-platform owner accounts", async () => {
    const expected = [
      ["S2026", "company-napkin-math", "product_hunt", "https://www.producthunt.com/products/napkin-math"],
      ["S26", "company-lemonlime", "product_hunt", "https://www.producthunt.com/products/lemonlime"],
      ["S2026", "company-cignara", "product_hunt", "https://www.producthunt.com/products/cignara"],
      ["S2026", "company-gojiberry-ai", "reddit", "https://www.reddit.com/user/Ecstatic-Tough6503"],
      ["S26", "company-cerenovus", "product_hunt", "https://www.producthunt.com/products/compendium-2"],
      ["S26", "company-contextdev", "product_hunt", "https://www.producthunt.com/products/context-dev"],
      ["S26", "company-codag", "product_hunt", "https://www.producthunt.com/products/codag"],
      ["S2026", "company-runtime", "product_hunt", "https://www.producthunt.com/products/runtime"],
      ["S2026", "company-insforge", "product_hunt", "https://www.producthunt.com/products/insforge-alpha"],
      ["S26", "company-screenpipe", "product_hunt", "https://www.producthunt.com/products/screenpipe"],
      ["A16ZSR006", "a16z-speedrun-006-mirror-mirror-ai", "reddit", "https://www.reddit.com/user/somuchblood"],
      ["A16ZSR006", "a16z-speedrun-006-modaic", "reddit", "https://www.reddit.com/user/Disneyskidney"],
      ["A16ZSR006", "a16z-speedrun-006-omi-health", "reddit", "https://www.reddit.com/user/Ok-Comfortable5583"],
      ["A16ZSR006", "a16z-speedrun-006-sun", "reddit", "https://www.reddit.com/user/createvalue-dontspam"],
      ["A16ZSR006", "a16z-speedrun-006-sun", "reddit", "https://www.reddit.com/user/Total_Birthday8070"],
      ["A16ZSR006", "a16z-speedrun-006-syncere", "reddit", "https://www.reddit.com/user/cirad"],
      ["A16ZSR006", "a16z-speedrun-006-emanate", "reddit", "https://www.reddit.com/user/kainjoo"]
    ];
    const catalogs = await loadAutonomousCatalogs(repositoryRoot);
    const missing = expected.filter(([batchSlug, entityId, platform, url]) => {
      const company = catalogs
        .find((catalog) => catalog.slug === batchSlug)
        ?.companies.find((candidate) => candidate.sourceKey === entityId);
      return !company?.accounts.some((account) =>
        account.platform === platform &&
        account.url.toLowerCase().replace(/\/$/, "") === url.toLowerCase().replace(/\/$/, "") &&
        account.reviewState === "verified"
      );
    });
    assert.equal(expected.length, 17);
    assert.deepEqual(missing, []);

    const sun = catalogs
      .find((catalog) => catalog.slug === "A16ZSR006")
      .companies.find((company) => company.sourceKey === "a16z-speedrun-006-sun");
    assert.deepEqual(
      sun.accounts.filter((account) => account.platform === "reddit").map((account) => account.url),
      [
        "https://www.reddit.com/user/createvalue-dontspam",
        "https://www.reddit.com/user/Total_Birthday8070"
      ]
    );

    for (const [batchSlug, entityId, platform, expectedCanonicalUrl] of [
      ["S2026", "company-anoria", "youtube", "https://youtube.com/@anoria_inc"],
      ["S26", "company-luca-iq", "youtube", "https://youtube.com/channel/ucskrxhk7dyia_atzzbzz8ba"],
      ["S2026", "company-gojiberry-ai", "reddit", "https://reddit.com/user/ecstatic-tough6503"],
      ["S2026", "company-napkin-math", "product_hunt", "https://producthunt.com/products/napkin-math"]
    ]) {
      const company = catalogs
        .find((catalog) => catalog.slug === batchSlug)
        ?.companies.find((candidate) => candidate.sourceKey === entityId);
      const account = company?.accounts.find((candidate) => candidate.platform === platform);
      assert.equal(
        account?.sourceKey,
        `acct:company:${entityId}:${platform}:${encodeURIComponent(expectedCanonicalUrl)}`
      );
    }

    assert.equal(normalizeVerifiedSocialOverrideLinks({ reddit: "https://www.reddit.com/user/one" }).length, 1);
    assert.equal(normalizeVerifiedSocialOverrideLinks({
      reddit: ["https://www.reddit.com/user/one", "https://www.reddit.com/user/two"]
    }).length, 2);
    assert.throws(
      () => normalizeVerifiedSocialOverrideLinks({ reddit: [] }),
      /URL array must not be empty/
    );
    assert.throws(
      () => normalizeVerifiedSocialOverrideLinks({ reddit: ["https://www.reddit.com/user/one", null] }),
      /contains a malformed URL value/
    );
    assert.throws(
      () => normalizeVerifiedSocialOverrideLinks({ reddit: ["https://example.com/user/not-reddit"] }),
      /does not match its platform/
    );
    assert.throws(
      () => normalizeVerifiedSocialOverrideLinks({ youtube: "https://example.com/@not-youtube" }),
      /does not match its platform/
    );
    assert.throws(
      () => normalizeVerifiedSocialOverrideLinks({
        reddit: ["https://www.reddit.com/user/one", "https://www.reddit.com/user/one/"]
      }),
      /contains duplicate account URL/
    );
  });

  it("retires dead owner mappings while retaining replacement URLs and audit history", async () => {
    const catalogs = await loadAutonomousCatalogs(repositoryRoot);
    const summer = catalogs.find((catalog) => catalog.slug === "S26");
    const spring = catalogs.find((catalog) => catalog.slug === "S2026");
    const a16z = catalogs.find((catalog) => catalog.slug === "A16ZSR006");
    const openRelay = summer.companies.find((company) => company.sourceKey === "company-openrelay");
    const coasty = summer.companies.find((company) => company.sourceKey === "company-coasty");
    const coArena = summer.companies.find((company) => company.sourceKey === "company-coarena");
    const stage = spring.companies.find((company) => company.sourceKey === "company-stage");
    const interfaze = spring.companies.find((company) => company.sourceKey === "company-interfaze");
    const playabl = spring.companies.find((company) => company.sourceKey === "company-playablai");
    const amdahl = a16z.companies.find((company) => company.sourceKey === "a16z-speedrun-006-amdahl");

    assert.equal(openRelay.accounts.some((account) => /github\.com\/openrelayinc\/openrelay/i.test(account.url)), false);
    assert.deepEqual(
      openRelay.accounts.filter((account) => account.platform === "github").map((account) => account.url),
      ["https://github.com/OpenRelayInc"]
    );
    assert.equal(coasty, undefined);
    assert.deepEqual(
      coArena.legacyEntityAliases,
      ["coasty", "Coasty", "company-coasty"]
    );
    assert.deepEqual(
      coArena.accounts.filter((account) => account.platform === "github").map((account) => account.url),
      ["https://github.com/coasty-ai/open-cowork"]
    );
    assert.deepEqual(
      [
        ...stage.accounts,
        ...stage.founders.flatMap((founder) => founder.accounts)
      ].filter((account) => account.platform === "github").map((account) => account.url).sort(),
      [
        "https://github.com/ReviewStage",
        "https://github.com/charleslpan",
        "https://github.com/dastratakos"
      ].sort()
    );
    assert.deepEqual(
      [
        ...interfaze.accounts,
        ...interfaze.founders.flatMap((founder) => founder.accounts)
      ].filter((account) => account.platform === "github").map((account) => account.url).sort(),
      [
        "https://github.com/InterfazeAI",
        "https://github.com/Khurdhula-Harshavardhan",
        "https://github.com/yoeven"
      ].sort()
    );
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
    assert.equal(openRelayGithub.account.url, "https://github.com/OpenRelayInc");
    assert.equal(openRelayGithub.status, "queued");
    assert.equal(openRelayGithub.terminalReason, null);
    assert.equal(amdahlGithub.account.url, "https://github.com/amdahlco");

    const overrides = JSON.parse(await readFile(
      new URL("../src/lib/social/verified-social-overrides.json", import.meta.url),
      "utf8"
    ));
    for (const [slug, field] of [
      ["openrelay", "rejectedGithub"],
      ["stage", "rejectedGithub"],
      ["interfaze", "rejectedGithub"],
      ["coasty", "rejectedGithub"],
      ["amdahl", "rejectedGithub"],
      ["playablai", "rejectedInstagram"]
    ]) {
      for (const record of overrides[slug][field]) {
        assert.ok(record.url);
        assert.ok(record.reason);
        assert.ok(record.rejectedAt);
        assert.ok(record.source || field !== "rejectedGithub");
      }
    }
  });

  it("feeds the same retired and replacement mappings into the GitHub collector plan", () => {
    const summer = githubCollectorPlan("S26");
    const spring = githubCollectorPlan("S2026");
    const a16z = githubCollectorPlan("A16ZSR006");

    assert.equal(
      summer.targets.some((target) => /github\.com\/openrelayinc\/openrelay/i.test(target.githubUrl)),
      false
    );
    assert.ok(summer.targets.some(
      (target) =>
        target.entityId === "company-openrelay" &&
        target.githubUrl === "https://github.com/OpenRelayInc"
    ));
    assert.deepEqual(
      summer.targets
        .filter((target) => ["company-coasty", "company-coarena"].includes(target.entityId))
        .map((target) => `${target.entityId}:${target.githubUrl}`),
      ["company-coarena:https://github.com/coasty-ai/open-cowork"]
    );
    assert.equal(
      summer.targets.some((target) => /github\.com\/(?:vectorlay|anthropics\/open-computer-use)/i.test(target.githubUrl)),
      false
    );
    assert.deepEqual(
      spring.targets
        .filter((target) => ["company-stage", "founder-stage-dean-stratakos-1219322", "founder-stage-charles-pan-327595"].includes(target.entityId))
        .map((target) => `${target.entityId}:${target.githubUrl}`)
        .sort(),
      [
        "company-stage:https://github.com/ReviewStage",
        "founder-stage-charles-pan-327595:https://github.com/charleslpan",
        "founder-stage-dean-stratakos-1219322:https://github.com/dastratakos"
      ].sort()
    );
    assert.deepEqual(
      spring.targets
        .filter((target) => [
          "company-interfaze",
          "founder-interfaze-yoeven-d-khemlani-1618136",
          "founder-interfaze-harsha-vardhan-khurdula-2229538"
        ].includes(target.entityId))
        .map((target) => `${target.entityId}:${target.githubUrl}`)
        .sort(),
      [
        "company-interfaze:https://github.com/InterfazeAI",
        "founder-interfaze-harsha-vardhan-khurdula-2229538:https://github.com/Khurdhula-Harshavardhan",
        "founder-interfaze-yoeven-d-khemlani-1618136:https://github.com/yoeven"
      ].sort()
    );
    assert.equal(
      spring.targets.some((target) => /github\.com\/(?:stage-review|JigsawStack)/i.test(target.githubUrl)),
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
            .map((account) => `${entity.sourceKey}:${canonicalGithubTargetUrl(account.url).toLowerCase()}`)
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

  it("canonicalizes official-site repository links without attributing them to founders", async () => {
    const directory = await mkdtemp(join(tmpdir(), "returner-github-canonical-discovery-"));
    const output = join(directory, "github.json");
    const preload = join(directory, "mock-fetch.mjs");
    const requestLog = join(directory, "requests.log");
    await writeFile(
      preload,
      `import { appendFileSync } from "node:fs";
const requestLog = ${JSON.stringify(requestLog)};
globalThis.fetch = async (input) => {
  const url = String(input);
  appendFileSync(requestLog, url + "\\n");
  if (url === "https://6thsense.dev") {
    return new Response('<a href="https://github.com/acme/example.git">repo</a><a href="https://github.com/acme/example/?tab=readme">duplicate</a>', { status: 200 });
  }
  if (url === "https://api.github.com/users/acme") {
    return Response.json({
      login: "acme",
      name: "Acme",
      type: "Organization",
      html_url: "https://github.com/acme",
      followers: 1,
      following: 0,
      public_repos: 1,
      public_gists: 0,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-07-26T00:00:00.000Z"
    });
  }
  if (url === "https://api.github.com/repos/acme/example") {
    return Response.json({
      id: 1,
      name: "example",
      full_name: "acme/example",
      fork: false,
      html_url: "https://github.com/acme/example",
      stargazers_count: 1,
      forks_count: 0,
      watchers_count: 1,
      open_issues_count: 0,
      pushed_at: "2026-07-26T00:00:00.000Z",
      updated_at: "2026-07-26T00:00:00.000Z",
      created_at: "2026-07-25T00:00:00.000Z"
    });
  }
  return new Response("<html><body>No GitHub link</body></html>", { status: 200 });
};
`
    );
    execFileSync(process.execPath, [
      "scripts/fetch-github-traction.mjs",
      "--batch=S26",
      "--max-companies=1",
      "--website",
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
    assert.equal(snapshot.accounts.length, 1);
    assert.equal(snapshot.accounts[0].entityType, "company");
    assert.equal(snapshot.accounts[0].githubUrl, "https://github.com/acme/example");
    assert.equal(snapshot.accounts[0].repo, "example");
    assert.equal(snapshot.accounts[0].fetched, true);
    assert.equal(
      snapshot.source.discovery.sourceChecks.filter(
        (check) => check.entityType === "founder" && check.sourceKind === "official_website"
      ).length,
      0
    );
    const requests = (await readFile(requestLog, "utf8")).trim().split("\n");
    assert.equal(requests.filter((url) => url === "https://6thsense.dev").length, 1);
    assert.equal(requests.filter((url) => url === "https://api.github.com/repos/acme/example").length, 1);
    assert.equal(requests.some((url) => /example\\.git(?:$|[/?#])/.test(url)), false);
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

    assert.deepEqual(first, second);
    const canonicalAccountCount = catalogs.reduce(
      (count, catalog) => count + catalog.companies.reduce(
        (batchCount, company) => batchCount + company.accounts.length +
          company.founders.reduce((founderCount, founder) => founderCount + founder.accounts.length, 0),
        0
      ),
      0
    );
    assert.ok(canonicalAccountCount > 0);
    assert.equal(first.filter((task) => task.account).length, canonicalAccountCount);
    const canonicalAccountOverflow = Object.values(
      countCanonicalAccountOverflowByPlatform(catalogs)
    ).reduce((total, count) => total + count, 0);
    assert.equal(first.length, expectedEntityCount * AUTONOMOUS_PLATFORMS.length + canonicalAccountOverflow);
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
      "a16z-speedrun-006-smart-bricks",
      "a16z-speedrun-006-sun"
    ].includes(task.entitySourceKey) && task.account);
    for (const [entitySourceKey, platform, expectedUrls] of [
      ["founder-eden-robotics-stamatios-floratos-1956825", "x", ["cybermetheus", "stamatistwiy"]],
      ["a16z-speedrun-006-antihero-studios", "linkedin", ["antihero-studios", "antiherostudios-games"]],
      ["a16z-speedrun-006-quinn", "linkedin", ["meetquinn", "meetquinnai"]],
      ["a16z-speedrun-006-smart-bricks", "instagram", ["smartbricks_invest", "smartbricks.invest"]],
      ["a16z-speedrun-006-sun", "reddit", ["createvalue-dontspam", "Total_Birthday8070"]]
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

  it("rejects encoded-dot and private-host account URLs before exact task keys can collide", () => {
    const entity = {
      entityType: "company",
      sourceKey: "company-unsafe-account",
      name: "Unsafe Account",
      accounts: []
    };
    const batch = {
      slug: "S26",
      companies: [entity]
    };
    const unsafeUrls = [
      "https://x.com/safe_owner/%2e",
      "http://127.0.0.1/safe_owner",
      "https://127.0.0.1/safe_owner"
    ];

    assert.ok(autonomousCollectorAccountKey(
      "x",
      "company",
      entity.sourceKey,
      "https://x.com/safe_owner"
    ));
    for (const unsafeUrl of unsafeUrls) {
      assert.equal(
        autonomousCollectorAccountKey("x", "company", entity.sourceKey, unsafeUrl),
        null
      );
      assert.throws(
        () => buildAutonomousTaskPlan([{
          ...batch,
          companies: [{
            ...entity,
            accounts: [{ platform: "x", url: unsafeUrl }]
          }]
        }], { runKey: "unsafe-key-contract" }),
        /Invalid x account URL/
      );
    }
  });

  it("makes every unavailable task explicitly terminal and reports exact coverage", async () => {
    const catalogs = await loadAutonomousCatalogs(repositoryRoot);
    const tasks = buildAutonomousTaskPlan(catalogs, {
      runKey: "terminal-contract"
    });
    const reasonCounts = countBy(tasks, (task) => task.terminalReason ?? "queued");

    assert.deepEqual(
      Object.keys(reasonCounts).sort(),
      ["collector_not_applicable_to_founder", "collector_not_available", "queued"]
    );
    assert.equal(Object.values(reasonCounts).reduce((sum, count) => sum + count, 0), tasks.length);
    assert.ok(tasks.filter((task) => task.status === "queued").every((task) => task.terminalReason === null));
    assert.ok(tasks.filter((task) => task.status !== "queued").every((task) => Boolean(task.terminalReason)));

    const coverage = summarizeTaskCoverage(tasks);
    const expectedEntityCount = new Set(
      tasks.map((task) => `${task.batchSlug}:${task.entityType}:${task.entitySourceKey}`)
    ).size;
    const mappedTaskCount = tasks.filter((task) => task.account).length;
    assert.deepEqual({
      expected: coverage.expected,
      queued: coverage.queued,
      terminal: coverage.terminal,
      mapped: coverage.mapped,
      mappedQueued: coverage.mappedQueued,
      missingMappings: coverage.missingMappings,
      unsupported: coverage.unsupported
    }, {
      expected: tasks.length,
      queued: reasonCounts.queued,
      terminal: tasks.length - reasonCounts.queued,
      mapped: mappedTaskCount,
      mappedQueued: mappedTaskCount,
      missingMappings: coverage.missingMappings,
      unsupported: tasks.length - reasonCounts.queued
    });
    assert.deepEqual(
      Object.fromEntries(AUTONOMOUS_PLATFORMS.map((platform) => [platform, coverage.byPlatform[platform].expected])),
      Object.fromEntries(AUTONOMOUS_PLATFORMS.map((platform) => [
        platform,
        expectedEntityCount + (countCanonicalAccountOverflowByPlatform(catalogs)[platform] ?? 0)
      ]))
    );
  });

  it("keeps process retries, durable persistence, and lock-release headroom below the workflow timeout", () => {
    const runnerTimeoutMs = 330 * 60_000;

    assert.equal(AUTONOMOUS_PROCESS_BUDGETS.catalogRefreshMs, 6 * 60_000);
    assert.equal(AUTONOMOUS_PROCESS_BUDGETS.collectionPhaseMs, 120 * 60_000);
    assert.equal(
      AUTONOMOUS_PROCESS_BUDGETS.collectionDeadlineDrainHeadroomMs,
      5 * 60_000
    );
    assert.equal(AUTONOMOUS_PROCESS_BUDGETS.collectorAttempts, 2_147_483_647);
    assert.equal(AUTONOMOUS_PROCESS_BUDGETS.collectorRetryDelayMaxMs, 5 * 60_000);
    assert.equal(AUTONOMOUS_PROCESS_BUDGETS.collectorRateLimitRetryDelayMs, 65_000);
    assert.equal(AUTONOMOUS_PROCESS_BUDGETS.publicCollectorAttemptMs, 70 * 60_000);
    assert.equal(AUTONOMOUS_PROCESS_BUDGETS.collectorCheckpointFlushMs, 2 * 60_000);
    assert.equal(AUTONOMOUS_PROCESS_BUDGETS.benchmarkPublicationMs, 8 * 60_000);
    assert.equal(AUTONOMOUS_PROCESS_BUDGETS.timelineDiscoveryMs, 6 * 60_000);
    assert.equal(AUTONOMOUS_PROCESS_BUDGETS.timelineDiscoveryCommandHeadroomMs, 30_000);
    assert.equal(AUTONOMOUS_PROCESS_BUDGETS.timelineBackfillMs, 6 * 60_000);
    assert.equal(AUTONOMOUS_PROCESS_BUDGETS.scoringDiagnosticsMs, 6 * 60_000);
    assert.equal(AUTONOMOUS_PROCESS_BUDGETS.artifactValidationMs, 3 * 60_000);
    assert.equal(AUTONOMOUS_PROCESS_BUDGETS.derivedArtifactMs, 6 * 60_000);
    assert.equal(AUTONOMOUS_PROCESS_BUDGETS.durablePersistenceHeadroomMs, 25 * 60_000);
    assert.equal(AUTONOMOUS_PROCESS_BUDGETS.lockReleaseHeadroomMs, 2 * 60_000);
    assert.ok(maxAutonomousRunnerProcessBudgetMs() < runnerTimeoutMs);
  });

  it("accounts for both publication builds, every validation pass, and retry execution", () => {
    const zeroBudgets = Object.fromEntries(
      Object.keys(AUTONOMOUS_PROCESS_BUDGETS).map((key) => [key, 0])
    );
    zeroBudgets.collectorAttempts = 1;

    assert.equal(maxAutonomousRunnerProcessBudgetMs({
      ...zeroBudgets,
      derivedArtifactMs: 1
    }), 4, "two combined derived-artifact passes must be budgeted for both publication attempts");
    assert.equal(maxAutonomousRunnerProcessBudgetMs({
      ...zeroBudgets,
      scoringDiagnosticsMs: 1
    }), 2, "scoring diagnostics must be budgeted for both publication attempts");
    assert.equal(maxAutonomousRunnerProcessBudgetMs({
      ...zeroBudgets,
      artifactValidationMs: 1
    }), 10, "five validation-budget commands must be budgeted for both publication attempts");
    assert.equal(maxAutonomousRunnerProcessBudgetMs({
      ...zeroBudgets,
      timelineDiscoveryCommandHeadroomMs: 1
    }), 2, "Timeline command headroom must be budgeted for both publication attempts");
    assert.equal(maxAutonomousRunnerProcessBudgetMs({
      ...zeroBudgets,
      timelineBackfillMs: 1
    }), 4, "timeline backfill runs twice per publication attempt across two attempts");
    assert.equal(maxAutonomousRunnerProcessBudgetMs({
      ...zeroBudgets,
      artifactManifestMs: 1
    }), 4, "artifact manifest runs twice per publication attempt across two attempts");
    assert.equal(maxAutonomousRunnerProcessBudgetMs({
      ...zeroBudgets,
      catalogRefreshMs: 1
    }), 1, "mutable catalog refresh must be part of the runner budget");
    assert.equal(maxAutonomousRunnerProcessBudgetMs({
      ...zeroBudgets,
      collectionPhaseMs: 7,
      publicCollectorAttemptMs: 10_000,
      githubCollectorAttemptMs: 10_000,
      topVoiceCollectorMs: 10_000,
      collectorRateLimitRetryDelayMs: 10_000
    }), 7, "the enforced collection phase, not queued subprocess totals, bounds collection");
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
    assert.throws(
      () => validateAutonomousTerminalCoverage(
        { expected: 14_616, nonTerminal: 0, supersededNonTerminal: 1 },
        { expectedTaskCount: 14_616 }
      ),
      /superseded same-slot ingestion tasks remain nonterminal/
    );
  });

  it("excludes superseded same-slot tasks from the current mutable-catalog plan", () => {
    const plannedTasks = [
      { checkpointKey: "central-slot:current-a" },
      { checkpointKey: "central-slot:current-b" }
    ];
    const durableTasks = [
      { id: "current-a", checkpoint_key: "central-slot:current-a", platform: "web", status: "completed" },
      { id: "current-b", checkpoint_key: "central-slot:current-b", platform: "linkedin", status: "blocked_or_empty" },
      ...Array.from({ length: 39 }, (_, index) => ({
        id: `superseded-${index}`,
        checkpoint_key: `central-slot:removed-roster-task-${index}`,
        platform: "linkedin",
        status: "completed"
      })),
      {
        id: "timeline-running",
        checkpoint_key: "timeline:timeline-coordinator-2026-08-02.v1:run-id:company-id:timeline_public_web",
        platform: "timeline_public_web",
        status: "running"
      }
    ];

    const inventory = partitionAutonomousTaskInventory(durableTasks, plannedTasks, {
      isSupersededTask: (task) => isAutonomousCollectorTaskForRun(task, { runKey: "central-slot" })
    });
    assert.deepEqual(inventory.currentTasks.map((task) => task.id), ["current-a", "current-b"]);
    assert.equal(inventory.supersededTasks.length, 39);
    assert.deepEqual(inventory.unrelatedTasks.map((task) => task.id), ["timeline-running"]);
    assert.deepEqual(inventory.missingCheckpointKeys, []);
    assert.equal(
      validateAutonomousTerminalCoverage(
        { expected: inventory.currentTasks.length, nonTerminal: 0 },
        { expectedTaskCount: plannedTasks.length }
      ).expected,
      2
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

  it("rejects future, stale, foreign-attempt, foreign-campaign, and foreign-execution shard bindings", () => {
    const startedAtMs = Date.now() - 1_000;
    const completedAtMs = startedAtMs + 500;
    const attempt = {
      schemaVersion: 1,
      attemptId: "attempt-current",
      campaignKey: "campaign-current",
      idempotencyKey: "slot-current",
      executionNonce: "execution-current",
      kind: "public",
      batchSlug: "S26",
      shardIndex: 0,
      shardCount: 2,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString()
    };
    const bound = {
      ...publicSnapshot,
      source: {
        ...publicSnapshot.source,
        fetchedAt: new Date(startedAtMs + 250).toISOString(),
        autonomousAttempt: attempt
      }
    };
    const validation = {
      kind: "public",
      batchSlug: "S26",
      notBefore: startedAtMs - 10,
      notAfter: completedAtMs + 10,
      requireAttemptBinding: true,
      expectedAttemptId: attempt.attemptId,
      expectedCampaignKey: attempt.campaignKey,
      expectedExecutionNonce: attempt.executionNonce
    };

    assert.equal(validateAutonomousCollectorSnapshot(bound, validation), bound);
    for (const [field, replacement, expected] of [
      ["attemptId", "attempt-foreign", /foreign attempt/],
      ["campaignKey", "campaign-foreign", /foreign campaign/],
      ["executionNonce", "execution-foreign", /foreign execution/]
    ]) {
      assert.throws(
        () => validateAutonomousCollectorSnapshot({
          ...bound,
          source: {
            ...bound.source,
            autonomousAttempt: { ...attempt, [field]: replacement }
          }
        }, validation),
        expected
      );
    }
    assert.throws(
      () => validateAutonomousCollectorSnapshot({
        ...bound,
        source: { ...bound.source, fetchedAt: new Date(Date.now() + 120_000).toISOString() }
      }, { ...validation, notAfter: Date.now() + 60_000 }),
      /in the future/
    );
    assert.throws(
      () => validateAutonomousCollectorSnapshot(bound, {
        ...validation,
        notBefore: completedAtMs + 10_000
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
    assert.equal(failures.length, 5);
    assert.equal(failures.filter((failure) => /404 Not Found/.test(failure)).length, 0);
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

  it("classifies transport and service failures without retrying deterministic request defects", () => {
    for (const message of [
      "HTTP 403 forbidden",
      "HTTP 408 request timeout",
      "HTTP 425 too early",
      "HTTP 429 rate limit",
      "HTTP 500 internal server error",
      "HTTP 503 unavailable",
      "fetch failed: ECONNRESET",
      "socket hang up",
      "connect ETIMEDOUT 203.0.113.1:443",
      "AbortError: The operation was aborted"
    ]) {
      assert.equal(isAutonomousCollectorFailureRetryable(message), true, message);
    }
    for (const message of [
      "HTTP 400 bad request",
      "HTTP 401 unauthorized",
      "HTTP 404 Not Found",
      "HTTP 405 method not allowed",
      "HTTP 410 gone",
      "HTTP 422 unprocessable entity",
      "Profile not found",
      "Invalid owner mapping",
      "Unsupported owner URL"
    ]) {
      assert.equal(isAutonomousCollectorFailureRetryable(message), false, message);
    }
  });

  it("does not interpret bounded collection cardinalities as HTTP status codes", () => {
    const intentionalCoauthorReview =
      "Anonymous Instagram native feed exposed this post on the exact mapped @snagsubletsnyc profile; " +
      "native primary author=@subletgirl, profileRole=coauthor. The feed recovered 500 unique posts across " +
      "42 page(s); sourceExhausted=false. The mapped profile is a declared coauthor, not the native primary " +
      "author; queued for review and excluded from scored evidence.";

    assert.equal(isAutonomousCollectorFailureRetryable(intentionalCoauthorReview), false);
    assert.equal(
      isAutonomousCollectorFailureRetryable("Recovered 503 verified posts before the bounded item limit."),
      false
    );
    assert.equal(isAutonomousCollectorFailureRetryable("HTTP 500 internal server error"), true);
    assert.equal(isAutonomousCollectorFailureRetryable("status=503"), true);
    assert.equal(isAutonomousCollectorFailureRetryable("503 Service Unavailable"), true);
  });

  it("does not reopen terminal public negative evidence from transport-shaped diagnostics", () => {
    const transportFailure = "read ECONNRESET";
    const youtubeReview =
      "Official YC company page embedded this video, but the native YouTube channel identity was unavailable.";
    assert.equal(isAutonomousCollectorFailureRetryable(transportFailure), true);
    assert.equal(isAutonomousCollectorFailureRetryable(youtubeReview), true);
    const snapshot = {
      attempts: {
        "S26:rss:arbital": {
          attemptKey: "rss:arbital",
          batchSlug: "S26",
          platform: "rss",
          entityType: "company",
          entityId: "company-arbital",
          error: transportFailure,
          retryable: true,
          outcomeStatus: "blocked_or_empty",
          outcomeReason: "collector_checked_blocked_or_empty"
        },
        "S26:website:arbital": {
          attemptKey: "website:arbital",
          batchSlug: "S26",
          platform: "web",
          entityType: "company",
          entityId: "company-arbital",
          error: transportFailure,
          retryable: true,
          outcomeStatus: "blocked_or_empty",
          outcomeReason: "collector_checked_blocked_or_empty"
        },
        "S26:youtube:nex": {
          attemptKey: "youtube:nex",
          batchSlug: "S26",
          platform: "youtube",
          entityType: "company",
          entityId: "company-nex",
          platformPostId: "2amZjOKdhD4",
          error: youtubeReview,
          retryable: true,
          outcomeStatus: "needs_review",
          outcomeReason: "collector_needs_review"
        }
      },
      failures: [{
        attemptKey: "rss:arbital",
        platform: "rss",
        entityType: "company",
        entityId: "company-arbital",
        message: transportFailure,
        retryable: true
      }, {
        attemptKey: "website:arbital",
        platform: "web",
        entityType: "company",
        entityId: "company-arbital",
        message: transportFailure,
        retryable: true
      }]
    };
    const tasks = [{
      batchSlug: "S26",
      status: "queued",
      platform: "rss",
      entityType: "company",
      entitySourceKey: "company-arbital",
      account: null
    }, {
      batchSlug: "S26",
      status: "queued",
      platform: "web",
      entityType: "company",
      entitySourceKey: "company-arbital",
      account: null
    }, {
      batchSlug: "S26",
      status: "queued",
      platform: "youtube",
      entityType: "company",
      entitySourceKey: "company-nex",
      account: null
    }];

    const terminalCoverage = summarizeAutonomousCollectorTerminalTaskCoverage(snapshot, {
      kind: "public",
      batchSlug: "S26",
      tasks
    });
    assert.equal(terminalCoverage.expected, 3);
    assert.equal(terminalCoverage.terminal, 3);
    assert.equal(terminalCoverage.nonTerminal, 0);
    assert.deepEqual(autonomousCollectorRetryableFailures(snapshot), []);

    const interrupted = structuredClone(snapshot);
    interrupted.attempts["S26:rss:arbital"] = {
      ...interrupted.attempts["S26:rss:arbital"],
      outcomeStatus: "running",
      outcomeReason: null
    };
    interrupted.failures = interrupted.failures.filter(
      (failure) => failure.attemptKey !== "rss:arbital"
    );
    const interruptedCoverage = summarizeAutonomousCollectorTerminalTaskCoverage(interrupted, {
      kind: "public",
      batchSlug: "S26",
      tasks
    });
    assert.equal(interruptedCoverage.terminal, 2);
    assert.equal(interruptedCoverage.nonTerminal, 1);
    assert.deepEqual(autonomousCollectorRetryableFailures(interrupted), [transportFailure]);

    const failed = structuredClone(snapshot);
    failed.attempts["S26:rss:arbital"] = {
      ...failed.attempts["S26:rss:arbital"],
      outcomeStatus: "failed",
      outcomeReason: "collector_reported_failure"
    };
    assert.deepEqual(autonomousCollectorRetryableFailures(failed), [transportFailure]);
  });

  it("corrects persisted terminal-review retry flags without hiding a real collection interruption", () => {
    const boundedReview = ({ attemptKey, entityType, entityId, accountUrl, authorHandle }) => ({
      attemptKey,
      platform: "instagram",
      entityType,
      entityId,
      accountUrl,
      error:
        `Anonymous Instagram native feed exposed this post on the exact mapped @${new URL(accountUrl).pathname.slice(1)} profile; ` +
        `native primary author=@${authorHandle}, profileRole=coauthor. The feed recovered 500 unique posts across ` +
        "42 page(s); sourceExhausted=false. The mapped profile is a declared coauthor, not the native primary " +
        "author; queued for review and excluded from scored evidence.",
      recentWindowProofBlocker: "native_recent_window_observation_missing",
      retryable: true,
      outcomeStatus: "completed",
      outcomeReason: "collector_evidence_collected"
    });
    const interruptedAttemptKey =
      "instagram:company:a16z-speedrun-006-transport:https://instagram.com/transport";
    const interruptedCoauthor = boundedReview({
      attemptKey:
        "instagram:company:a16z-speedrun-006-interrupted-coauthor:https://instagram.com/interruptedcoauthor",
      entityType: "company",
      entityId: "a16z-speedrun-006-interrupted-coauthor",
      accountUrl: "https://instagram.com/interruptedcoauthor",
      authorHandle: "otherauthor"
    });
    interruptedCoauthor.error = interruptedCoauthor.error.replace(
      "The mapped profile is a declared coauthor",
      "Pagination transport failed: fetch failed: ECONNRESET. The mapped profile is a declared coauthor"
    );
    const snapshot = {
      attempts: {
        snag: boundedReview({
          attemptKey: "instagram:company:a16z-speedrun-006-snag:https://instagram.com/snagsubletsnyc",
          entityType: "company",
          entityId: "a16z-speedrun-006-snag",
          accountUrl: "https://instagram.com/snagsubletsnyc",
          authorHandle: "subletgirl"
        }),
        idilio: boundedReview({
          attemptKey: "instagram:company:a16z-speedrun-006-idilio:https://instagram.com/idiliotv",
          entityType: "company",
          entityId: "a16z-speedrun-006-idilio",
          accountUrl: "https://instagram.com/idiliotv",
          authorHandle: "produ"
        }),
        gabriela: boundedReview({
          attemptKey:
            "instagram:founder:a16z-speedrun-006-idilio-founder-gabriela-tafur:https://instagram.com/gabrielatafur",
          entityType: "founder",
          entityId: "a16z-speedrun-006-idilio-founder-gabriela-tafur",
          accountUrl: "https://instagram.com/gabrielatafur",
          authorHandle: "danielaalvareztv"
        }),
        interrupted: {
          attemptKey: interruptedAttemptKey,
          platform: "instagram",
          entityType: "company",
          entityId: "a16z-speedrun-006-transport",
          accountUrl: "https://instagram.com/transport",
          error:
            "Instagram native-feed pagination was interrupted after verified rows; partial rows were preserved: " +
            "page 42 request failed: fetch failed: ECONNRESET",
          retryable: true,
          outcomeStatus: "completed",
          outcomeReason: "collector_evidence_collected"
        },
        interruptedCoauthor
      }
    };

    assert.deepEqual(autonomousCollectorRetryableFailures(snapshot), [
      snapshot.attempts.interrupted.error,
      interruptedCoauthor.error
    ]);
  });

  it("uses exact attempt keys so stale sibling failures cannot reopen terminal work", () => {
    const snapshot = {
      attempts: {
        "rss:acme": {
          attemptKey: "rss:acme",
          platform: "rss",
          entityType: "company",
          entityId: "company-acme",
          outcomeStatus: "blocked_or_empty",
          retryable: false
        },
        "news_web:acme": {
          attemptKey: "news_web:acme",
          platform: "news_web",
          entityType: "company",
          entityId: "company-acme",
          outcomeStatus: "failed",
          error: "HTTP 503 current news failure",
          retryable: true
        }
      },
      failures: [{
        attemptKey: "rss:acme",
        platform: "rss",
        entityType: "company",
        entityId: "company-acme",
        message: "HTTP 503 stale RSS failure"
      }, {
        attemptKey: "news_web:acme",
        platform: "news_web",
        entityType: "company",
        entityId: "company-acme",
        message: "HTTP 503 current news failure"
      }]
    };

    assert.deepEqual(
      autonomousCollectorRetryableFailures(snapshot),
      ["HTTP 503 current news failure"]
    );
    snapshot.attempts["news_web:acme"] = {
      ...snapshot.attempts["news_web:acme"],
      outcomeStatus: "blocked_or_empty",
      retryable: false
    };
    assert.deepEqual(autonomousCollectorRetryableFailures(snapshot), []);
  });

  it("keeps retryability isolated across multiple GitHub accounts for one owner", () => {
    const failedAccount = {
      attemptKey: "account:company:company-acme:https://github.com/acme/secondary",
      platform: "github",
      entityType: "company",
      entityId: "company-acme",
      githubUrl: "https://github.com/acme/secondary",
      fetched: false,
      error: "HTTP 503 unavailable",
      retryable: true
    };
    const snapshot = {
      attempts: {
        "company:company-acme": {
          attemptKey: "company:company-acme",
          platform: "github",
          entityType: "company",
          entityId: "company-acme",
          outcomeStatus: "completed",
          retryable: false
        }
      },
      accounts: [{
        attemptKey: "account:company:company-acme:https://github.com/acme/primary",
        platform: "github",
        entityType: "company",
        entityId: "company-acme",
        githubUrl: "https://github.com/acme/primary",
        fetched: true,
        retryable: false
      }, failedAccount]
    };

    assert.deepEqual(
      autonomousCollectorRetryableFailures(snapshot),
      ["HTTP 503 unavailable"]
    );
    failedAccount.retryable = false;
    assert.deepEqual(autonomousCollectorRetryableFailures(snapshot), []);
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
    }), {
      status: "blocked_or_empty",
      reason: "collector_checked_blocked_or_empty"
    });
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

  it("requires an explicit RSS discovery receipt instead of trusting an empty snapshot", () => {
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
        status: "nonterminal",
        reason: "collector_returned_no_entity_attempt"
      }
    );

    const explicitRssIndex = indexAutonomousCollectorTaskOutcomes({
      evidence: [],
      needsReview: [],
      failures: [],
      attempts: {
        rss: {
          platform: "rss",
          entityType: "company",
          entityId: "company-no-feed",
          accountUrl: null,
          outcomeStatus: "blocked_or_empty",
          outcomeReason: "collector_checked_no_rss_feed"
        }
      }
    }, {
      kind: "public",
      batchSlug: "S26",
      explicitTerminalOnly: true
    });
    assert.deepEqual(classifyAutonomousCollectorTaskOutcome(explicitRssIndex, rssTask), {
      status: "blocked_or_empty",
      reason: "collector_checked_no_rss_feed"
    });
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
      attempts: {
        rss: {
          platform: "rss",
          entityType: "company",
          entityId: "company-no-feed",
          accountUrl: null,
          outcomeStatus: "blocked_or_empty",
          outcomeReason: "collector_checked_no_rss_feed"
        }
      }
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

  it("requires an exact unsupported receipt for company-scoped mapped accounts", () => {
    const companyOnlyIndex = indexAutonomousCollectorTaskOutcomes({
      evidence: [],
      needsReview: [],
      failures: [],
      attempts: {
        reddit: {
          platform: "reddit",
          entityType: "company",
          entityId: "company-acme",
          accountUrl: null,
          outcomeStatus: "blocked_or_empty",
          outcomeReason: "collector_checked_blocked_or_empty"
        }
      }
    }, {
      kind: "public",
      batchSlug: "S26",
      explicitTerminalOnly: true
    });

    for (const [platform, accountUrl] of [
      ["reddit", "https://reddit.com/r/acme"],
      ["hacker_news", "https://news.ycombinator.com/user?id=acme"],
      ["rss", "https://acme.example/feed.xml"],
      ["web", "https://acme.example"]
    ]) {
      assert.deepEqual(classifyAutonomousCollectorTaskOutcome(companyOnlyIndex, {
        platform,
        entityType: "company",
        entityId: "company-acme",
        accountUrl
      }), {
        status: "nonterminal",
        reason: "collector_returned_no_account_attempt"
      });
    }
    assert.deepEqual(classifyAutonomousCollectorTaskOutcome(companyOnlyIndex, {
      platform: "x",
      entityType: "company",
      entityId: "company-acme",
      accountUrl: "https://x.com/acme"
    }), {
      status: "nonterminal",
      reason: "collector_returned_no_account_attempt"
    });

    const redditUrl = "https://reddit.com/r/acme";
    const exactIndex = indexAutonomousCollectorTaskOutcomes({
      evidence: [],
      needsReview: [],
      failures: [],
      attempts: {
        reddit: {
          attemptKey: `reddit:company:company-acme:${redditUrl}`,
          platform: "reddit",
          entityType: "company",
          entityId: "company-acme",
          accountUrl: redditUrl,
          attempted: false,
          outcomeStatus: "blocked_or_empty",
          outcomeReason: "collector_scope_unsupported"
        }
      }
    }, {
      kind: "public",
      batchSlug: "S26",
      explicitTerminalOnly: true
    });
    assert.deepEqual(classifyAutonomousCollectorTaskOutcome(exactIndex, {
      platform: "reddit",
      entityType: "company",
      entityId: "company-acme",
      accountUrl: redditUrl
    }), {
      status: "blocked_or_empty",
      reason: "collector_scope_unsupported"
    });
    assert.deepEqual(classifyAutonomousCollectorTaskOutcome(exactIndex, {
      platform: "reddit",
      entityType: "company",
      entityId: "company-acme",
      accountUrl: "https://reddit.com/user/acme"
    }), {
      status: "nonterminal",
      reason: "collector_returned_no_account_attempt"
    });
  });

  it("terminalizes exhausted anonymous transport access without accepting invalid mappings", () => {
    const linkedinUrl = "https://linkedin.com/company/transport";
    const linkedinAttemptKey = `linkedin:company:company-transport:${linkedinUrl}`;
    const linkedinBlocker = {
      provider: "jina_linkedin_reader",
      code: "linkedin_public_circuit_open",
      retryAt: "2026-08-09T22:30:00.000Z",
      httpStatus: null,
      message: "Jina LinkedIn reader circuit is open."
    };
    const index = indexAutonomousCollectorTaskOutcomes({
      evidence: [],
      needsReview: [],
      failures: [{
        platform: "linkedin",
        entityType: "company",
        entityId: "company-transport",
        accountUrl: linkedinUrl,
        attemptKey: linkedinAttemptKey,
        message: "reader request failed",
        blocker: linkedinBlocker
      }, {
        platform: "instagram",
        entityType: "company",
        entityId: "company-http-access",
        message: "instagram_web_profile_info_http_401"
      }, {
        platform: "x",
        entityType: "company",
        entityId: "company-invalid",
        message: "Invalid URL mapping: host did not match x.com."
      }],
      attempts: {
        linkedin: {
          attemptKey: linkedinAttemptKey,
          platform: "linkedin",
          entityType: "company",
          entityId: "company-transport",
          accountUrl: linkedinUrl,
          outcomeStatus: "blocked_or_empty",
          outcomeReason: "collector_provider_blocked",
          blocker: linkedinBlocker
        }
      }
    }, { kind: "public", batchSlug: "S26", explicitTerminalOnly: true });

    for (const [platform, entityId] of [
      ["linkedin", "company-transport"],
      ["instagram", "company-http-access"]
    ]) {
      const outcome = classifyAutonomousCollectorTaskOutcome(index, {
        platform,
        entityType: "company",
        entityId,
        ...(platform === "linkedin" ? { accountUrl: linkedinUrl } : {})
      });
      assert.equal(outcome.status, "blocked_or_empty");
      assert.equal(outcome.providerBlocked, platform === "linkedin" ? true : undefined);
    }
    assert.equal(classifyAutonomousCollectorTaskOutcome(index, {
      platform: "x",
      entityType: "company",
      entityId: "company-invalid"
    }).status, "failed");
  });

  it("keeps bounded X no-owner surfaces reviewable without masking hard failures", () => {
    const boundedUrl = "https://x.com/bounded";
    const boundedKey = `x:company:company-bounded:${boundedUrl}`;
    const index = indexAutonomousCollectorTaskOutcomes({
      evidence: [],
      needsReview: [],
      failures: [{
        attemptKey: boundedKey,
        platform: "x",
        entityType: "company",
        entityId: "company-bounded",
        accountUrl: boundedUrl,
        message: "Anonymous X public profile verification failed: no_exact_owner_social_media_postings."
      }],
      attempts: {
        bounded: {
          attemptKey: boundedKey,
          platform: "x",
          entityType: "company",
          entityId: "company-bounded",
          accountUrl: boundedUrl,
          outcomeStatus: "needs_review",
          outcomeReason: "collector_needs_review"
        }
      }
    }, { kind: "public", batchSlug: "S26", explicitTerminalOnly: true });

    assert.deepEqual(classifyAutonomousCollectorTaskOutcome(index, {
      platform: "x",
      entityType: "company",
      entityId: "company-bounded",
      accountUrl: boundedUrl
    }), {
      status: "needs_review",
      reason: "collector_needs_review"
    });
  });

  it("does not let typed receipts erase hard failures without validated evidence", () => {
    const cases = [
      ["company-invalid", "https://x.com/invalid", "Invalid URL mapping: host did not match x.com.", "blocked_or_empty"],
      ["company-not-found", "https://x.com/not-found", "HTTP 404 Not Found", "needs_review"],
      ["company-unknown", "https://x.com/unknown", "Unexpected response schema", "completed"]
    ];
    const index = indexAutonomousCollectorTaskOutcomes({
      evidence: [],
      needsReview: [],
      failures: cases.map(([entityId, accountUrl, message]) => ({
        attemptKey: `x:company:${entityId}:${accountUrl}`,
        platform: "x",
        entityType: "company",
        entityId,
        accountUrl,
        message
      })),
      attempts: Object.fromEntries(cases.map(([entityId, accountUrl, , outcomeStatus]) => [
        entityId,
        {
          attemptKey: `x:company:${entityId}:${accountUrl}`,
          platform: "x",
          entityType: "company",
          entityId,
          accountUrl,
          outcomeStatus,
          outcomeReason: `typed_${outcomeStatus}`
        }
      ]))
    }, { kind: "public", batchSlug: "S26", explicitTerminalOnly: true });

    for (const [entityId, accountUrl] of cases) {
      assert.equal(classifyAutonomousCollectorTaskOutcome(index, {
        platform: "x",
        entityType: "company",
        entityId,
        accountUrl
      }).status, "failed");
    }
  });

  it("requires an allowlisted exact-identity provider blocker", () => {
    const accountA = "https://linkedin.com/company/account-a";
    const accountB = "https://linkedin.com/company/account-b";
    const attemptKey = `linkedin:company:company-identity:${accountA}`;
    const index = indexAutonomousCollectorTaskOutcomes({
      evidence: [],
      needsReview: [],
      failures: [{
        attemptKey,
        platform: "linkedin",
        entityType: "company",
        entityId: "company-identity",
        accountUrl: accountB,
        message: "reader request failed"
      }, {
        attemptKey: "linkedin:company:company-parser:https://linkedin.com/company/parser",
        platform: "linkedin",
        entityType: "company",
        entityId: "company-parser",
        accountUrl: "https://linkedin.com/company/parser",
        message: "Unexpected response schema",
        blocker: { provider: "parser", code: "schema_error" }
      }],
      attempts: {
        identity: {
          attemptKey,
          platform: "linkedin",
          entityType: "company",
          entityId: "company-identity",
          accountUrl: accountA,
          outcomeStatus: "blocked_or_empty",
          outcomeReason: "collector_provider_blocked",
          blocker: {
            provider: "jina_linkedin_reader",
            code: "linkedin_public_circuit_open",
            retryAt: "2026-08-10T00:00:00.000Z",
            httpStatus: null,
            message: "Jina LinkedIn reader circuit is open."
          }
        }
      }
    }, { kind: "public", batchSlug: "S26", explicitTerminalOnly: true });

    assert.equal(classifyAutonomousCollectorTaskOutcome(index, {
      platform: "linkedin",
      entityType: "company",
      entityId: "company-identity",
      accountUrl: accountB
    }).status, "failed");
    assert.deepEqual(classifyAutonomousCollectorTaskOutcome(index, {
      platform: "linkedin",
      entityType: "company",
      entityId: "company-parser",
      accountUrl: "https://linkedin.com/company/parser"
    }), {
      status: "failed",
      reason: "Unexpected response schema"
    });
  });

  it("does not inherit provider blockers through rejected account URL identities", () => {
    const blocker = {
      provider: "jina_linkedin_reader",
      code: "linkedin_public_circuit_open",
      retryAt: "2026-08-10T00:00:00.000Z",
      httpStatus: null,
      message: "Jina LinkedIn reader circuit is open."
    };
    for (const accountUrl of [
      "https://linkedin.com/company/canonical-owner/%2e",
      "https://127.0.0.1/company/canonical-owner"
    ]) {
      const attemptKey = `linkedin:company:company-canonical-owner:${accountUrl}`;
      const invalidAttempt = {
        attemptKey,
        platform: "linkedin",
        entityType: "company",
        entityId: "company-canonical-owner",
        accountUrl,
        outcomeStatus: "blocked_or_empty",
        outcomeReason: "collector_provider_blocked",
        blocker
      };
      const index = indexAutonomousCollectorTaskOutcomes({
        evidence: [],
        needsReview: [],
        failures: [{
          ...invalidAttempt,
          message: "reader request failed"
        }],
        attempts: {
          invalid: invalidAttempt
        }
      }, { kind: "public", batchSlug: "S26", explicitTerminalOnly: true });

      assert.equal(index.size, 0);
      assert.deepEqual(classifyAutonomousCollectorTaskOutcome(index, {
        platform: "linkedin",
        entityType: "company",
        entityId: "company-canonical-owner",
        accountUrl
      }), {
        status: "failed",
        reason: "collector_invalid_account_url"
      });
      assert.deepEqual(classifyAutonomousCollectorTaskOutcome(index, {
        platform: "linkedin",
        entityType: "company",
        entityId: "company-canonical-owner"
      }), {
        status: "nonterminal",
        reason: "collector_returned_no_entity_attempt"
      });
    }
  });

  it("rejects standalone, ambiguous, untyped, and platform-incompatible blockers", () => {
    const blocker = {
      provider: "jina_linkedin_reader",
      code: "linkedin_public_circuit_open",
      retryAt: "2026-08-10T00:00:00.000Z",
      httpStatus: null,
      message: "Jina LinkedIn reader circuit is open."
    };
    const duplicateUrl = "https://linkedin.com/company/duplicate";
    const duplicateKey = `linkedin:company:company-duplicate:${duplicateUrl}`;
    const borrowedUrl = "https://linkedin.com/company/borrowed";
    const borrowedKey = `linkedin:company:company-borrowed:${borrowedUrl}`;
    const index = indexAutonomousCollectorTaskOutcomes({
      evidence: [],
      needsReview: [],
      failures: [{
        attemptKey: "linkedin:company:company-standalone:https://linkedin.com/company/standalone",
        platform: "linkedin",
        entityType: "company",
        entityId: "company-standalone",
        accountUrl: "https://linkedin.com/company/standalone",
        message: "reader request failed",
        blocker
      }, {
        attemptKey: duplicateKey,
        platform: "linkedin",
        entityType: "company",
        entityId: "company-duplicate",
        accountUrl: duplicateUrl,
        message: "reader request failed"
      }, {
        attemptKey: borrowedKey,
        platform: "linkedin",
        entityType: "company",
        entityId: "company-borrowed",
        accountUrl: borrowedUrl,
        message: "Unexpected parser schema corruption"
      }, {
        platform: "x",
        entityType: "company",
        entityId: "company-untyped",
        accountUrl: "https://x.com/untyped",
        message: "Unexpected parser schema unavailable"
      }],
      attempts: {
        borrowed: {
          attemptKey: borrowedKey,
          platform: "linkedin",
          entityType: "company",
          entityId: "company-borrowed",
          accountUrl: borrowedUrl,
          outcomeStatus: "blocked_or_empty",
          outcomeReason: "collector_provider_blocked",
          blocker
        },
        duplicateA: {
          attemptKey: duplicateKey,
          platform: "linkedin",
          entityType: "company",
          entityId: "company-duplicate",
          accountUrl: duplicateUrl,
          outcomeStatus: "blocked_or_empty",
          outcomeReason: "collector_provider_blocked",
          blocker
        },
        duplicateB: {
          attemptKey: duplicateKey,
          platform: "linkedin",
          entityType: "company",
          entityId: "company-duplicate",
          accountUrl: duplicateUrl,
          outcomeStatus: "blocked_or_empty",
          outcomeReason: "collector_provider_blocked",
          blocker
        }
      }
    }, { kind: "public", batchSlug: "S26", explicitTerminalOnly: true });

    for (const [platform, entityId, accountUrl, providerBlocked] of [
      ["linkedin", "company-standalone", "https://linkedin.com/company/standalone", undefined],
      ["linkedin", "company-borrowed", borrowedUrl, true],
      ["linkedin", "company-duplicate", duplicateUrl, undefined],
      ["x", "company-untyped", "https://x.com/untyped", undefined]
    ]) {
      const outcome = classifyAutonomousCollectorTaskOutcome(index, {
        platform,
        entityType: "company",
        entityId,
        accountUrl
      });
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.providerBlocked, providerBlocked);
    }
  });

  it("validates the complete provider blocker schema and platform pairing", () => {
    const blocker = {
      provider: "jina_linkedin_reader",
      code: "linkedin_public_circuit_open",
      retryAt: "2026-08-10T00:00:00.000Z",
      httpStatus: null,
      message: "Jina LinkedIn reader circuit is open."
    };
    assert.equal(isAutonomousProviderBlocker(blocker, { platform: "linkedin" }), true);
    assert.equal(isAutonomousProviderBlocker(blocker, { platform: "x" }), false);
    assert.equal(isAutonomousProviderBlocker({ ...blocker, provider: "JINA_LINKEDIN_READER" }, { platform: "linkedin" }), false);
    assert.equal(isAutonomousProviderBlocker({ ...blocker, retryAt: null }, { platform: "linkedin" }), false);
    assert.equal(isAutonomousProviderBlocker({ ...blocker, message: "" }, { platform: "linkedin" }), false);
    assert.equal(isAutonomousProviderBlocker({ ...blocker, extra: true }, { platform: "linkedin" }), false);
    assert.equal(isAutonomousProviderBlocker({
      provider: "duckduckgo_html",
      code: "public_search_discovery_failure",
      retryAt: null,
      httpStatus: null,
      message: "Arbitrary parser failure."
    }, { platform: "x" }), false);

    const redditBlocker = {
      provider: "reddit_public_json",
      code: "reddit_public_access_blocked",
      retryAt: "2026-08-10T00:15:00.000Z",
      httpStatus: 429,
      message: "Reddit public access blocked: HTTP 429."
    };
    assert.equal(isAutonomousProviderBlocker(redditBlocker, { platform: "reddit" }), true);
    assert.equal(isAutonomousProviderBlocker(redditBlocker, { platform: "linkedin" }), false);
    assert.equal(isAutonomousProviderBlocker({ ...redditBlocker, httpStatus: 500 }, { platform: "reddit" }), false);
    assert.equal(isAutonomousProviderBlocker({ ...redditBlocker, retryAt: null }, { platform: "reddit" }), false);
  });

  it("normalizes legacy blocker failures and preserves provider health beside valid evidence", () => {
    const accountUrl = "https://linkedin.com/company/partial";
    const attemptKey = `linkedin:company:company-partial:${accountUrl}`;
    const blocker = {
      provider: "jina_linkedin_reader",
      code: "linkedin_public_circuit_open",
      retryAt: "2026-08-10T00:00:00.000Z",
      httpStatus: null,
      message: "Jina LinkedIn reader circuit is open."
    };
    const index = indexAutonomousCollectorTaskOutcomes({
      evidence: [{
        platform: "linkedin",
        entityType: "company",
        entityId: "company-partial",
        accountUrl,
        sourceUrl: "https://linkedin.com/posts/partial_native-post",
        nativeId: "partial-native-post"
      }],
      needsReview: [],
      failures: [{
        attemptKey,
        platform: "linkedin",
        entityType: "company",
        entityId: "company-partial",
        accountUrl,
        message: "reader request failed",
        blocker
      }],
      attempts: {
        partial: {
          attemptKey,
          platform: "linkedin",
          entityType: "company",
          entityId: "company-partial",
          accountUrl,
          outcomeStatus: "failed",
          outcomeReason: "legacy_provider_failure",
          error: "reader request failed",
          blocker
        }
      }
    }, { kind: "public", batchSlug: "S26", explicitTerminalOnly: true });

    assert.deepEqual(classifyAutonomousCollectorTaskOutcome(index, {
      platform: "linkedin",
      entityType: "company",
      entityId: "company-partial",
      accountUrl
    }), {
      status: "completed",
      reason: "collector_evidence_collected",
      providerBlocked: true,
      providerBlockerReason: "provider_blocked:jina_linkedin_reader:linkedin_public_circuit_open"
    });
  });

  it("distinguishes a trusted provider HTTP 404 from an untyped target 404", () => {
    const providerUrl = "https://linkedin.com/company/provider-404";
    const targetUrl = "https://linkedin.com/company/target-404";
    const index = indexAutonomousCollectorTaskOutcomes({
      evidence: [],
      needsReview: [],
      failures: [{
        attemptKey: `linkedin:company:company-provider-404:${providerUrl}`,
        platform: "linkedin",
        entityType: "company",
        entityId: "company-provider-404",
        accountUrl: providerUrl,
        message: "LinkedIn public source returned HTTP 404",
        blocker: {
          provider: "jina_linkedin_reader",
          code: "linkedin_public_http_failure",
          retryAt: null,
          httpStatus: 404,
          message: "LinkedIn public source returned HTTP 404"
        }
      }, {
        platform: "linkedin",
        entityType: "company",
        entityId: "company-target-404",
        accountUrl: targetUrl,
        message: "HTTP 404 Not Found"
      }],
      attempts: {
        provider404: {
          attemptKey: `linkedin:company:company-provider-404:${providerUrl}`,
          platform: "linkedin",
          entityType: "company",
          entityId: "company-provider-404",
          accountUrl: providerUrl,
          outcomeStatus: "blocked_or_empty",
          outcomeReason: "collector_provider_blocked",
          blocker: {
            provider: "jina_linkedin_reader",
            code: "linkedin_public_http_failure",
            retryAt: null,
            httpStatus: 404,
            message: "LinkedIn public source returned HTTP 404"
          }
        }
      }
    }, { kind: "public", batchSlug: "S26", explicitTerminalOnly: true });

    assert.equal(classifyAutonomousCollectorTaskOutcome(index, {
      platform: "linkedin",
      entityType: "company",
      entityId: "company-provider-404",
      accountUrl: providerUrl
    }).status, "blocked_or_empty");
    assert.equal(classifyAutonomousCollectorTaskOutcome(index, {
      platform: "linkedin",
      entityType: "company",
      entityId: "company-target-404",
      accountUrl: targetUrl
    }).status, "failed");
  });

  it("indexes explicit terminal receipts for URL-less social discovery tasks", () => {
    const entityId = "founder-6thsense-james-baek-3429291";
    const baseAttempt = {
      platform: "x",
      entityType: "founder",
      entityId,
      accountUrl: null,
      status: "done"
    };
    const terminalSnapshot = {
      evidence: [],
      needsReview: [],
      failures: [],
      attempts: {
        "x-founder-discovery": {
          ...baseAttempt,
          outcomeStatus: "needs_review",
          outcomeReason: "collector_needs_review"
        }
      }
    };
    const task = {
      platform: "x",
      entityType: "founder",
      entityId,
      accountUrl: null
    };

    const terminalIndex = indexAutonomousCollectorTaskOutcomes(terminalSnapshot, {
      kind: "public",
      batchSlug: "S26"
    });
    assert.deepEqual(
      classifyAutonomousCollectorTaskOutcome(terminalIndex, task),
      { status: "needs_review", reason: "collector_needs_review" }
    );

    const incompleteIndex = indexAutonomousCollectorTaskOutcomes({
      ...terminalSnapshot,
      attempts: {
        "x-founder-discovery": {
          ...baseAttempt,
          outcomeStatus: "running",
          outcomeReason: null
        }
      }
    }, {
      kind: "public",
      batchSlug: "S26"
    });
    assert.deepEqual(
      classifyAutonomousCollectorTaskOutcome(incompleteIndex, task),
      { status: "nonterminal", reason: "collector_returned_no_entity_attempt" }
    );
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

  it("preserves exact task receipts when the surrounding collector process exhausts retries", () => {
    const completedTask = {
      platform: "x",
      entityType: "company",
      entityId: "company-completed",
      accountUrl: "https://x.com/completed"
    };
    const missingTask = {
      platform: "x",
      entityType: "company",
      entityId: "company-missing",
      accountUrl: "https://x.com/missing"
    };
    const index = indexAutonomousCollectorTaskOutcomes({
      evidence: [{
        ...completedTask,
        sourceUrl: "https://x.com/completed/status/42",
        nativeId: "42",
        review_state: "verified"
      }],
      needsReview: [],
      failures: [],
      attempts: {}
    }, { kind: "public", batchSlug: "S26" });
    const processFailure = {
      collectorOk: false,
      collectorError: "public S26 exhausted retries with 1/2811 planned task(s) lacking explicit terminal outcomes."
    };

    assert.deepEqual(
      classifyAutonomousCollectorTaskOutcome(index, { ...completedTask, ...processFailure }),
      { status: "completed", reason: "collector_evidence_collected" }
    );
    assert.deepEqual(
      classifyAutonomousCollectorTaskOutcome(index, { ...missingTask, ...processFailure }),
      { status: "failed", reason: processFailure.collectorError }
    );
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
  it("bounds repeated operational histories while preserving the latest terminal receipt", () => {
    const attemptKey = "x:company:company-example:https://x.com/example";
    let merged = null;
    for (let index = 0; index < 30; index += 1) {
      const checkedAt = `2026-07-24T18:00:${String(index).padStart(2, "0")}.000Z`;
      const fresh = {
        source: { batchSlug: "S26", fetchedAt: checkedAt },
        evidence: [],
        needsReview: [],
        failures: [{
          id: `failure-${index}`,
          batchSlug: "S26",
          attemptKey,
          platform: "x",
          entityType: "company",
          entityId: "company-example",
          message: `terminal failure ${index}`,
          checkedAt
        }],
        attempts: {
          [attemptKey]: {
            attemptKey,
            batchSlug: "S26",
            platform: "x",
            entityType: "company",
            entityId: "company-example",
            accountUrl: "https://x.com/example",
            status: "failed",
            outcomeStatus: "failed",
            outcomeReason: `terminal failure ${index}`,
            retryable: true,
            checkedAt
          }
        },
        discoveryAttempts: [{
          id: `discovery-${index}`,
          batch_slug: "S26",
          entityType: "company",
          entityId: "company-example",
          platform: "x",
          source: "public_connector",
          query: "Example X",
          status: "failed",
          created_at: checkedAt
        }],
        sourceDiscoveryPaths: [{
          id: `path-${index}`,
          batch_slug: "S26",
          company_id: "company-example",
          discovered_entity_type: "company",
          discovered_entity_id: "company-example",
          source_url: "https://example.com",
          discovered_platform: "x",
          discovered_url: "https://x.com/example",
          created_at: checkedAt
        }]
      };
      merged = mergePublicEvidenceSnapshots(
        [merged, fresh].filter(Boolean),
        { fetchedAt: checkedAt }
      );
      assert.ok(merged.failures.length <= 2);
      assert.ok(merged.discoveryAttempts.length <= 2);
      assert.equal(merged.sourceDiscoveryPaths.length, 1);
      assert.equal(Object.keys(merged.attempts).length, 1);
    }

    assert.equal(merged.failures[0].checkedAt, "2026-07-24T18:00:29.000Z");
    assert.equal(
      merged.attempts[`S26:${attemptKey}`].outcomeReason,
      "terminal failure 29"
    );
    assert.equal(merged.source.failureCount, 2);
    assert.equal(merged.source.attemptCount, 1);
    assert.equal(merged.source.operationalRetention.prunedCounts.failures, 1);
    assert.ok(merged.source.operationalRetention.parentHistorySha256.length > 0);
    assert.match(merged.source.operationalRetention.historySha256, /^[a-f0-9]{64}$/);
  });

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

  it("binds a metricless promotion receipt before refreshing native-author metadata", () => {
    const company = {
      name: "Example",
      sourceKey: "company-example",
      description: "Example builds durable software."
    };
    const owner = {
      batchSlug: "S26",
      entityType: "company",
      entityId: "company-example",
      companyEntityId: "company-example",
      companySlug: "example",
      companyName: "Example"
    };
    const resolveNativeAuthor = () => ({
      status: "matched",
      reason: "fresh_canonical_resolution",
      owner,
      company
    });
    resolveNativeAuthor.companyForRow = () => ({ ...owner, company });
    resolveNativeAuthor.companyOwners = [{ ...owner, company }];
    const row = {
      id: "metricless-youtube-with-signed-receipt",
      batchSlug: "S26",
      entityType: "company",
      entityId: "company-example",
      entityName: "Example",
      companySlug: "example",
      companyName: "Example",
      platform: "youtube",
      platformPostId: "abcDEF123",
      sourceUrl: "https://www.youtube.com/watch?v=abcDEF123",
      title: "Example YC S26 product walkthrough",
      text: "Example YC S26 product walkthrough and launch details.",
      metrics: { views: 0 },
      contributionScore: 0,
      review_state: "verified",
      linkStatus: "verified",
      attributionStatus: "verified",
      attributionVersion: 3,
      attributionMode: "account_owner",
      nativeAuthorResolution: {
        status: "matched",
        reason: "signed_metricless_receipt",
        owner
      }
    };

    const merged = mergePublicEvidenceSnapshots([{
      source: { batchSlug: "S26" },
      evidence: [row],
      needsReview: [],
      failures: []
    }], {
      resolveNativeAuthor,
      allowVerifiedMetriclessEvidence: (candidate) =>
        candidate?.nativeAuthorResolution?.reason === "signed_metricless_receipt"
    });

    assert.deepEqual(merged.evidence, [row]);
    assert.deepEqual(merged.needsReview, []);
  });

  it("preserves already-promoted strict first-party web and RSS context across autonomous merge", () => {
    const web = strictFirstPartyContextRow({
      id: "first-party-web-launch",
      platform: "web",
      sourceUrl: "https://example.com/blog/launch-post"
    });
    const rss = strictFirstPartyContextRow({
      id: "first-party-rss-launch",
      platform: "rss",
      sourceUrl: "https://example.com/feed/launch-post.xml"
    });

    const merged = mergePublicEvidenceSnapshots([{
      source: { batchSlug: "S2026" },
      evidence: [web, rss],
      needsReview: [],
      failures: []
    }], {
      allowVerifiedContextEvidence: isStrictFirstPartyContext
    });

    assert.deepEqual(
      merged.evidence
        .map((row) => [row.platform, row.sourceUrl, row.platformPostId])
        .sort(([left], [right]) => left.localeCompare(right)),
      [
        ["rss", rss.sourceUrl, rss.sourceUrl],
        ["web", web.sourceUrl, web.sourceUrl]
      ]
    );
    assert.deepEqual(merged.needsReview, []);
    assert.ok(merged.evidence.every((row) =>
      row.attributionSignals.includes("exact_current_official_domain")
    ));

    const replayed = mergePublicEvidenceSnapshots([merged], {
      allowVerifiedContextEvidence: isStrictFirstPartyContext
    });
    assert.deepEqual(replayed.evidence, merged.evidence);
    assert.deepEqual(replayed.needsReview, merged.needsReview);
  });

  it("limits first-party context exceptions to explicitly trusted canonical snapshots", () => {
    const trustedRow = strictFirstPartyContextRow({
      id: "trusted-first-party-web",
      platform: "web",
      sourceUrl: "https://example.com/blog/trusted"
    });
    const collectorForgery = strictFirstPartyContextRow({
      id: "collector-forgery-web",
      platform: "web",
      sourceUrl: "https://example.com/blog/forged"
    });
    const trustedSnapshot = {
      source: { batchSlug: "S2026" },
      evidence: [trustedRow],
      needsReview: [],
      failures: []
    };
    const untrustedCollectorSnapshot = {
      source: { batchSlug: "S2026" },
      evidence: [collectorForgery],
      needsReview: [],
      failures: []
    };
    const trustedSnapshots = new Set([trustedSnapshot]);

    const merged = mergePublicEvidenceSnapshots(
      [trustedSnapshot, untrustedCollectorSnapshot],
      {
        allowVerifiedContextEvidence: (row, { snapshot }) =>
          trustedSnapshots.has(snapshot) && isStrictFirstPartyContext(row)
      }
    );

    assert.deepEqual(merged.evidence, [trustedRow]);
    assert.ok(merged.needsReview.some((row) => row.sourceEvidenceId === collectorForgery.id));
  });

  it("keeps ordinary web and RSS rows quarantined even when metricless context is allowed", () => {
    const ordinaryWeb = {
      ...strictFirstPartyContextRow({
        id: "ordinary-web",
        platform: "web",
        sourceUrl: "https://example.com/about"
      }),
      _recoveryProvenance: undefined,
      attributionSignals: []
    };
    const ordinaryRss = {
      ...strictFirstPartyContextRow({
        id: "ordinary-rss",
        platform: "rss",
        sourceUrl: "https://example.com/feed.xml"
      }),
      _recoveryProvenance: undefined,
      attributionSignals: []
    };

    const merged = mergePublicEvidenceSnapshots([{
      source: { batchSlug: "S2026" },
      evidence: [ordinaryWeb, ordinaryRss],
      needsReview: [],
      failures: []
    }], {
      allowVerifiedContextEvidence: isStrictFirstPartyContext
    });

    assert.deepEqual(merged.evidence, []);
    assert.deepEqual(
      merged.needsReview.map((row) => row.sourceEvidenceId).sort(),
      ["ordinary-rss", "ordinary-web"]
    );
  });

  it("keeps tampered first-party provenance quarantined", () => {
    const tampered = strictFirstPartyContextRow({
      id: "tampered-first-party",
      platform: "web",
      sourceUrl: "https://example.com/blog/tampered"
    });
    tampered._recoveryProvenance.contentSha256 = "0".repeat(64);

    const merged = mergePublicEvidenceSnapshots([{
      source: { batchSlug: "S2026" },
      evidence: [tampered],
      needsReview: [],
      failures: []
    }], {
      allowVerifiedContextEvidence: isStrictFirstPartyContext
    });

    assert.deepEqual(merged.evidence, []);
    const review = merged.needsReview.find((row) => row.sourceEvidenceId === tampered.id);
    assert.ok(review);
    assert.equal(review.review_state, "needs_review");
  });

  it("keeps promoted context platformPostId equal to its canonical source URL", () => {
    const row = strictFirstPartyContextRow({
      id: "first-party-context-identity",
      platform: "web",
      sourceUrl: "https://example.com/news/identity"
    });
    const merged = mergePublicEvidenceSnapshots([{
      source: { batchSlug: "S2026" },
      evidence: [row],
      needsReview: [],
      failures: []
    }], {
      allowVerifiedContextEvidence: isStrictFirstPartyContext
    });

    assert.equal(merged.evidence[0]?.platformPostId, row.sourceUrl);
    assert.equal(merged.evidence[0]?.sourceUrl, row.sourceUrl);
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

  it("keeps an active repository when a different repository under the same owner is retired", () => {
    const previous = {
      source: { batchSlug: "S26" },
      accounts: [{
        entityType: "company",
        entityId: "company-openrelay",
        githubUrl: "https://github.com/OpenRelayInc/OpenRelay",
        login: "OpenRelayInc",
        repo: "OpenRelay",
        fetched: true,
        marker: "retired"
      }, {
        entityType: "company",
        entityId: "company-openrelay",
        githubUrl: "https://github.com/OpenRelayInc/orl",
        login: "OpenRelayInc",
        repo: "orl",
        fetched: true,
        marker: "last-good-active"
      }]
    };
    const fresh = {
      source: {
        batchSlug: "S26",
        retiredAccountMappings: [{
          entityType: "company",
          entityId: "company-openrelay",
          url: "https://github.com/OpenRelayInc/OpenRelay"
        }]
      },
      accounts: [{
        entityType: "company",
        entityId: "company-openrelay",
        githubUrl: "https://github.com/OpenRelayInc/orl.git",
        login: "OpenRelayInc",
        repo: "orl",
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

function countCanonicalAccountOverflowByPlatform(catalogs) {
  const overflowByPlatform = {};
  for (const catalog of catalogs) {
    for (const company of catalog.companies) {
      for (const entity of [company, ...company.founders]) {
        const accountCounts = countBy(entity.accounts, (account) => account.platform);
        for (const [platform, count] of Object.entries(accountCounts)) {
          overflowByPlatform[platform] = (overflowByPlatform[platform] ?? 0) + Math.max(0, count - 1);
        }
      }
    }
  }
  return overflowByPlatform;
}

function strictFirstPartyContextRow({ id, platform, sourceUrl }) {
  return {
    id,
    batchSlug: "S2026",
    entityType: "company",
    entityId: "company-example",
    entityName: "Example",
    companySlug: "example",
    companyName: "Example",
    platform,
    sourceUrl,
    platformPostId: sourceUrl,
    title: "Example launches a durable new product",
    rawVisibleText: "Example launches a durable new product.",
    postedAt: "2026-08-01T00:00:00.000Z",
    first_seen_at: "2026-08-08T00:00:00.000Z",
    last_checked_at: "2026-08-08T00:00:00.000Z",
    last_updated_at: "2026-08-08T00:00:00.000Z",
    metrics: {},
    contributionScore: 0,
    review_state: "verified",
    linkStatus: "verified",
    attributionStatus: "verified",
    attributionVersion: 3,
    attributionSignals: [
      "current_cohort_owner",
      "exact_current_official_domain",
      "stable_authored_item_url",
      "title_text_date_provenance"
    ],
    _recoveryProvenance: {
      schemaVersion: 1,
      sourcePath: "history.json",
      sourceKind: "repository_history",
      officialWebsiteUrl: "https://example.com/",
      officialHost: "example.com",
      contentSha256: contextContentSha256({ platform, sourceUrl }),
      zeroEngagementAccepted: true
    }
  };
}

function isStrictFirstPartyContext(row) {
  const provenance = row?._recoveryProvenance;
  return ["web", "rss"].includes(row?.platform) &&
    row?.review_state === "verified" &&
    row?.linkStatus === "verified" &&
    row?.attributionStatus === "verified" &&
    Number(row?.attributionVersion ?? 0) >= 3 &&
    Number(row?.contributionScore ?? 0) === 0 &&
    Object.values(row?.metrics ?? {}).every((value) => Number(value ?? 0) === 0) &&
    row?.platformPostId === row?.sourceUrl &&
    provenance?.schemaVersion === 1 &&
    provenance?.zeroEngagementAccepted === true &&
    provenance?.contentSha256 === contextContentSha256(row) &&
    [
      "current_cohort_owner",
      "exact_current_official_domain",
      "stable_authored_item_url",
      "title_text_date_provenance"
    ].every((signal) => row?.attributionSignals?.includes(signal));
}

function contextContentSha256(row) {
  return createHash("sha256")
    .update(`${row?.platform}|${row?.sourceUrl}|Example launches a durable new product.`)
    .digest("hex");
}
