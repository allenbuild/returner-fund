import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  auditCoverageInputs,
  buildGraphOwnerInventory,
  buildYcOwnerInventory,
  canonicalAccountUrl,
  loadAuthoritativeCoverageInputs
} from "../scripts/lib/cohort-coverage-audit.mjs";

describe("cohort-wide structural coverage audit", () => {
  it("builds the real owner-scoped catalog inventory independently", async () => {
    const cohorts = await loadAuthoritativeCoverageInputs(process.cwd());
    const summary = cohorts.map((cohort) => ({
      batchSlug: cohort.batchSlug,
      companies: cohort.catalog.entities.filter((entity) => entity.entityType === "company").length,
      founders: cohort.catalog.entities.filter((entity) => entity.entityType === "founder").length,
      mappings: cohort.catalog.mappings.length
    }));

    assert.deepEqual(summary.filter((cohort) => cohort.batchSlug !== "S26"), [
      { batchSlug: "S2026", companies: 197, founders: 397, mappings: 994 },
      { batchSlug: "A16ZSR006", companies: 59, founders: 128, mappings: 339 }
    ]);
    const summerSummary = summary.find((cohort) => cohort.batchSlug === "S26");
    assert.ok(summerSummary.companies >= 167);
    assert.ok(summerSummary.founders > 0);
    assert.ok(summerSummary.mappings > 0);

    const spring = cohorts.find((cohort) => cohort.batchSlug === "S2026").catalog;
    const sharedThomasX = spring.mappings.filter(
      (mapping) => mapping.canonicalUrl === "https://x.com/madebythomasai"
    );
    assert.equal(sharedThomasX.length, 2);
    assert.deepEqual(sharedThomasX.map((mapping) => mapping.entityType).sort(), ["company", "founder"]);

    const summer = cohorts.find((cohort) => cohort.batchSlug === "S26").catalog;
    const sharedHyperparticle = summer.mappings.filter(
      (mapping) => mapping.canonicalUrl === "https://x.com/hyperparticle"
    );
    assert.equal(sharedHyperparticle.length, 1);
    assert.equal(sharedHyperparticle[0].entityType, "founder");
    assert.equal(sharedHyperparticle[0].entityId, "founder-rekursivai-dan-kondratyuk-3527564");

    const a16z = cohorts.find((cohort) => cohort.batchSlug === "A16ZSR006").catalog;
    assert.deepEqual(
      a16z.mappings
        .filter((mapping) =>
          mapping.entityId === "a16z-speedrun-006-sun" && mapping.platform === "reddit"
        )
        .map((mapping) => mapping.canonicalUrl),
      [
        "https://reddit.com/user/createvalue-dontspam",
        "https://reddit.com/user/total_birthday8070"
      ]
    );

    const audit = auditCoverageInputs(cohorts);
    assert.equal(audit.status, "pass");
    assert.equal(audit.structuralFailureCount, 0);
    assert.equal(
      audit.batches.reduce((count, batch) => count + batch.counts.plannedOwnerMappings, 0),
      summary.reduce((count, batch) => count + batch.mappings, 0)
    );
    const multiAccountOwnerMappings = audit.batches.flatMap((batch) =>
      batch.debt.multiAccountOwnerMappings.map((mapping) => ({
        batchSlug: batch.batchSlug,
        entityId: mapping.entityId,
        platform: mapping.platform,
        canonicalUrl: mapping.canonicalUrl
      }))
    );
    assert.equal(multiAccountOwnerMappings.length, 6);
    assert.deepEqual(
      multiAccountOwnerMappings.filter((mapping) => mapping.batchSlug === "S26"),
      [
        {
          batchSlug: "S26",
          entityId: "company-lato",
          platform: "linkedin",
          canonicalUrl: "https://linkedin.com/company/latoio"
        }
      ]
    );
  });

  it("canonicalizes account identity without collapsing owners", () => {
    assert.equal(
      canonicalAccountUrl("github", "https://github.com/orgs/Example-Co/repo?tab=readme"),
      "https://github.com/example-co/repo"
    );
    assert.equal(
      canonicalAccountUrl("linkedin", "https://www.linkedin.com/company/Example-Co/admin/dashboard/?viewAsMember=true"),
      "https://linkedin.com/company/example-co"
    );
    assert.equal(
      canonicalAccountUrl("twitter", "http://twitter.com/Example_User/status/123"),
      "https://x.com/example_user"
    );

    const mismatchedDeclaration = buildYcOwnerInventory({
      batchSlug: "TEST",
      catalog: {
        companies: [{
          id: "1",
          slug: "wrong-platform",
          name: "Wrong Platform",
          socialLinks: { linkedin: "https://x.com/right_host" },
          founders: []
        }]
      }
    });
    assert.equal(mismatchedDeclaration.mappings[0].platform, "x");
  });

  it("keeps a retired GitHub repository distinct from its verified owner account", () => {
    const inventory = buildYcOwnerInventory({
      batchSlug: "TEST",
      catalog: {
        companies: [{
          id: "1",
          slug: "repo-rename",
          name: "Repo Rename",
          socialLinks: { github: "https://github.com/Example-Co/retired-repo" },
          founders: []
        }]
      },
      overrides: {
        "repo-rename": {
          companySocialLinks: { github: "https://github.com/Example-Co" },
          rejectedGithub: [{
            url: "https://github.com/Example-Co/retired-repo"
          }]
        }
      }
    });

    assert.deepEqual(
      inventory.mappings.map((mapping) => mapping.canonicalUrl),
      ["https://github.com/example-co"]
    );
  });

  it("passes attempted-but-inactive owners and fails only a missing owner attempt", () => {
    const fixture = syntheticCohort();
    const pass = auditCoverageInputs([fixture], { runOutputsProvided: true });
    assert.equal(pass.status, "pass");
    assert.equal(pass.batches[0].debt.graphOwnerPresentationGaps.length, 1);
    assert.equal(pass.batches[0].debt.zeroScoreCompanies.length, 1);
    assert.equal(pass.batches[0].debt.zeroOwnNativeEvidenceCompanies.length, 1);

    const oneAttempt = Object.keys(fixture.runOutputs.public.attempts)[0];
    fixture.runOutputs.public.attempts = {
      [oneAttempt]: fixture.runOutputs.public.attempts[oneAttempt]
    };
    const fail = auditCoverageInputs([fixture], { runOutputsProvided: true });
    assert.equal(fail.status, "fail");
    assert.deepEqual(fail.structuralFailureKinds, ["unattemptedOwnerMappings"]);
    assert.equal(fail.batches[0].structural.unattemptedOwnerMappings.length, 1);
    assert.equal(fail.batches[0].structural.unattemptedOwnerMappings[0].entityType, "founder");
  });

  it("recognizes batch-scoped runner attempts from their receipt metadata", () => {
    const fixture = syntheticCohort();
    fixture.runOutputs.public.attempts = Object.fromEntries(
      fixture.catalog.mappings.map((mapping) => [
        [
          mapping.batchSlug,
          mapping.platform,
          mapping.entityType,
          mapping.entityId,
          mapping.originalUrl
        ].join(":"),
        {
          status: "done",
          batchSlug: mapping.batchSlug,
          platform: mapping.platform,
          entityType: mapping.entityType,
          entityId: mapping.entityId,
          accountUrl: mapping.originalUrl,
          outcomeStatus: "blocked_or_empty"
        }
      ])
    );

    const report = auditCoverageInputs([fixture], { runOutputsProvided: true });
    assert.equal(report.status, "pass");
    assert.equal(report.batches[0].structural.unattemptedOwnerMappings.length, 0);
  });

  it("requires a distinct run attempt for every same-owner canonical URL", () => {
    const fixture = multiAccountCohort();
    const report = auditCoverageInputs([fixture], { runOutputsProvided: true });
    assert.equal(report.status, "fail");
    assert.deepEqual(report.structuralFailureKinds, ["unattemptedOwnerMappings"]);
    assert.equal(report.batches[0].structural.unattemptedOwnerMappings.length, 1);
    assert.equal(
      report.batches[0].structural.unattemptedOwnerMappings[0].canonicalUrl,
      "https://x.com/shared_alias"
    );
  });

  it("fails unresolved review IDs while preserving deterministic output", () => {
    const fixture = syntheticCohort();
    fixture.runOutputs.public.needsReview = [{
      id: "review-bad-id",
      entityType: "company",
      entityId: "company-wrong-namespace",
      companySlug: "shared"
    }];
    const first = auditCoverageInputs([fixture], { runOutputsProvided: true });
    const second = auditCoverageInputs([fixture], { runOutputsProvided: true });

    assert.deepEqual(first, second);
    assert.equal(first.status, "fail");
    assert.deepEqual(first.structuralFailureKinds, ["unresolvedRunReferences"]);
    assert.deepEqual(first.batches[0].structural.unresolvedRunReferences, [{
      batchSlug: "TEST",
      source: "run",
      collection: "needsReview",
      rowId: "review-bad-id",
      entityId: "company-wrong-namespace",
      entityType: "company",
      companySlug: "shared"
    }]);
  });
});

function syntheticCohort() {
  const catalogSource = {
    companies: [{
      id: "1",
      slug: "shared",
      name: "Shared",
      socialLinks: { x: "https://x.com/shared_owner" },
      founders: [{
        id: "2",
        name: "Shared Founder",
        socialLinks: { x: "https://x.com/shared_owner" }
      }]
    }]
  };
  const catalog = buildYcOwnerInventory({ batchSlug: "TEST", catalog: catalogSource });
  const company = catalog.entities.find((entity) => entity.entityType === "company");
  const founder = catalog.entities.find((entity) => entity.entityType === "founder");
  const graph = {
    nodes: [{
      entityType: "company",
      entityId: company.entityId,
      label: company.entityName,
      score: 0,
      evidenceIds: [],
      socialAccounts: [{
        platform: "x",
        url: "https://x.com/shared_owner",
        review_state: "verified"
      }],
      founders: [{
        id: founder.entityId,
        name: founder.entityName,
        evidenceIds: [],
        socialAccounts: []
      }]
    }],
    evidence: [],
    needsReview: []
  };
  const graphInventory = buildGraphOwnerInventory({ batchSlug: "TEST", graph });
  const attempts = Object.fromEntries(catalog.mappings.map((mapping) => [
    `x:${mapping.entityType}:${mapping.sourceId}:${mapping.originalUrl}`,
    { status: "done" }
  ]));
  return {
    batchSlug: "TEST",
    catalogPath: "synthetic-catalog.json",
    graphPath: "synthetic-graph.json",
    catalog,
    graphInventory,
    graph,
    runOutputs: {
      public: { attempts, evidence: [], needsReview: [] },
      github: { accounts: [] },
      publicPath: "synthetic-public.json",
      githubPath: "synthetic-github.json"
    }
  };
}

function multiAccountCohort() {
  const catalog = buildYcOwnerInventory({
    batchSlug: "TEST",
    catalog: {
      companies: [{
        id: "1",
        slug: "shared",
        name: "Shared",
        socialLinks: { x: "https://x.com/shared_owner" },
        founders: []
      }]
    },
    overrides: {
      shared: {
        companySocialLinks: { x: "https://x.com/shared_alias" }
      }
    }
  });
  const company = catalog.entities[0];
  const graph = {
    nodes: [{
      entityType: "company",
      entityId: company.entityId,
      label: company.entityName,
      score: 0,
      evidenceIds: [],
      socialAccounts: catalog.mappings.map((mapping) => ({
        platform: mapping.platform,
        url: mapping.originalUrl,
        review_state: "verified"
      })),
      founders: []
    }],
    evidence: [],
    needsReview: []
  };
  const first = catalog.mappings.find(
    (mapping) => mapping.canonicalUrl === "https://x.com/shared_owner"
  );
  return {
    batchSlug: "TEST",
    catalogPath: "synthetic-catalog.json",
    graphPath: "synthetic-graph.json",
    catalog,
    graphInventory: buildGraphOwnerInventory({ batchSlug: "TEST", graph }),
    graph,
    runOutputs: {
      public: {
        attempts: {
          [`x:company:${first.entityId}:${first.originalUrl}`]: { status: "done" }
        },
        evidence: [],
        needsReview: []
      },
      github: { accounts: [] },
      publicPath: "synthetic-public.json",
      githubPath: "synthetic-github.json"
    }
  };
}
