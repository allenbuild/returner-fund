import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

const repositoryRoot = process.cwd();
const runnerSource = await readFile(
  path.join(repositoryRoot, "scripts", "run-autonomous-ingestion.mjs"),
  "utf8"
);
const combineAttributionReconciliationLedgers = loadLedgerCombiner(runnerSource);

const thomasPost = Object.freeze({
  platform: "x",
  sourceUrl: "https://x.com/madebythomasai/status/2060477947568349494",
  platformPostId: "2060477947568349494"
});
const thomasCompanyAttribution = Object.freeze({
  batchSlug: "S2026",
  entityType: "company",
  entityId: "company-thomas",
  attributionType: "subject"
});
const thomasFounderAttribution = Object.freeze({
  batchSlug: "S2026",
  entityType: "founder",
  entityId: "founder-thomas-human-thomas-1377370",
  attributionType: "subject"
});
const thomasCompanyToFounderReattribution = Object.freeze({
  ...thomasPost,
  disposition: "reattributed",
  reason: "native_owner_founder_account",
  staleAttribution: thomasCompanyAttribution,
  replacementAttribution: thomasFounderAttribution
});
const thomasFounderQuarantine = Object.freeze({
  ...thomasPost,
  disposition: "quarantined",
  reason: "native_owner_collision",
  staleAttribution: thomasFounderAttribution
});
const unrelatedQuarantine = Object.freeze({
  ...thomasPost,
  disposition: "quarantined",
  reason: "unrelated_fixture_quarantine",
  staleAttribution: Object.freeze({
    batchSlug: "S2026",
    entityType: "founder",
    entityId: "founder-unrelated-fixture-999",
    attributionType: "subject"
  })
});

describe("combineAttributionReconciliationLedgers", () => {
  it("suppresses the Thomas founder quarantine in every ledger order", () => {
    const inputLedgers = [
      [thomasCompanyToFounderReattribution],
      [thomasFounderQuarantine],
      [unrelatedQuarantine]
    ];

    for (const ledgers of permutations(inputLedgers)) {
      const combined = combineAttributionReconciliationLedgers(...ledgers);
      assert.equal(combined.length, 2);
      assert.deepEqual(
        combined.find((entry) => entry.disposition === "reattributed"),
        thomasCompanyToFounderReattribution
      );
      assert.equal(
        combined.some((entry) => entry === thomasFounderQuarantine),
        false,
        `founder quarantine survived ledger order ${ledgerOrder(ledgers)}`
      );
      assert.deepEqual(
        combined.find((entry) => entry.reason === "unrelated_fixture_quarantine"),
        unrelatedQuarantine
      );
    }
  });

  it("fails closed for conflicting reattributions in either ledger order", () => {
    const conflictingReattribution = {
      ...thomasCompanyToFounderReattribution,
      reason: "conflicting_fixture_reattribution",
      replacementAttribution: {
        ...thomasFounderAttribution,
        entityId: "founder-conflicting-fixture-999"
      }
    };

    for (const ledgers of [
      [[thomasCompanyToFounderReattribution], [conflictingReattribution]],
      [[conflictingReattribution], [thomasCompanyToFounderReattribution]]
    ]) {
      assert.throws(
        () => combineAttributionReconciliationLedgers(...ledgers),
        /Conflicting attribution reattributions target/,
        `conflicting reattributions did not fail closed for ledger order ${ledgerOrder(ledgers)}`
      );
    }
  });
});

function loadLedgerCombiner(source) {
  const startToken = "function attributionReconciliationTargetKey";
  const endToken = "async function mergePublicationInputs";
  const startIndex = source.indexOf(startToken);
  const endIndex = source.indexOf(endToken, startIndex + startToken.length);
  assert.notEqual(startIndex, -1, `Missing ${startToken} in autonomous ingestion runner`);
  assert.ok(endIndex > startIndex, `Missing ${endToken} after ${startToken}`);
  const functionSource = source.slice(startIndex, endIndex);
  return new Function(
    `"use strict";\n${functionSource}\nreturn combineAttributionReconciliationLedgers;`
  )();
}

function permutations(values) {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, candidateIndex) => candidateIndex !== index))
      .map((remainder) => [value, ...remainder])
  );
}

function ledgerOrder(ledgers) {
  return ledgers.map(([entry]) => entry.reason).join(" -> ");
}
