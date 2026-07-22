import assert from "node:assert/strict";
import test from "node:test";
import {
  dedupePublicNeedsReviewItems,
  productHuntReviewIdentity
} from "../scripts/lib/public-review-dedupe.mjs";

function review(id, overrides = {}) {
  return {
    id,
    batchSlug: "A16ZSR006",
    companySlug: "taxnova",
    entityType: "company",
    entityId: "a16z-speedrun-006-taxnova",
    platform: "product_hunt",
    candidateUrl: "https://www.producthunt.com/products/taxnova",
    last_checked_at: "2026-07-21T12:00:00.000Z",
    ...overrides
  };
}

test("deduplicates Product Hunt review aliases for one entity and canonical product URL", () => {
  const older = review("taxnova-product-title", {
    candidateUrl: "https://producthunt.com/products/TaxNova/?ref=search",
    last_checked_at: "2026-07-20T12:00:00.000Z"
  });
  const latest = review("taxnova-domain-match");
  const rows = dedupePublicNeedsReviewItems([latest, older]);

  assert.deepEqual(rows, [latest]);
  assert.equal(productHuntReviewIdentity(older), productHuntReviewIdentity(latest));
});

test("does not collapse the same candidate URL across different entity attributions", () => {
  const taxnova = review("taxnova");
  const another = review("another", {
    companySlug: "another",
    entityId: "company-another"
  });

  assert.deepEqual(dedupePublicNeedsReviewItems([taxnova, another]), [taxnova, another]);
});

test("keeps non-Product-Hunt review rows deduplicated only by stable row ID", () => {
  const first = review("linkedin-row", {
    platform: "linkedin",
    candidateUrl: "https://linkedin.com/company/taxnova"
  });
  const latest = { ...first, last_checked_at: "2026-07-22T12:00:00.000Z" };

  assert.deepEqual(dedupePublicNeedsReviewItems([first, latest]), [latest]);
});
