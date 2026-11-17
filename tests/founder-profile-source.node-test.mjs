import assert from "node:assert/strict";
import test from "node:test";
import { founderProfileSourceUrl } from "../src/lib/graph/founder-profile-source.mjs";

const node = { batchSlug: "F26", entityType: "company", entityId: "company-ploid", review_state: "verified", ycProfileUrl: "https://www.ycombinator.com/companies/ploid", sourceUrl: "https://www.ycombinator.com/companies/ploid" };
const founder = { id: "founder-ploid-known-founder-123", ycProfileUrl: "https://www.ycombinator.com/people/guessed-name" };
test("F26 founder chip uses the exact verified company profile and leaves source objects unchanged", () => {
  const before = JSON.stringify({ node, founder });
  assert.equal(founderProfileSourceUrl(node, founder), node.ycProfileUrl);
  assert.equal(JSON.stringify({ node, founder }), before);
});
test("older cohorts keep their existing founder destination unchanged", () => {
  for (const batchSlug of ["S26", "S2026", "A16ZSR006"]) assert.equal(founderProfileSourceUrl({ ...node, batchSlug }, founder), founder.ycProfileUrl);
});
test("fallback uses only an actually supplied matching official company source", () => {
  assert.equal(founderProfileSourceUrl({ ...node, ycProfileUrl: founder.ycProfileUrl }, founder), node.sourceUrl);
  for (const sourceUrl of ["https://www.ycombinator.com/companies/other", "https://evil.example/companies/ploid", "http://www.ycombinator.com/companies/ploid", "https://www.ycombinator.com/companies/ploid?redirect=other", "https://www.ycombinator.com/people/guessed-name"])
    assert.equal(founderProfileSourceUrl({ ...node, ycProfileUrl: sourceUrl, sourceUrl }, founder), undefined);
});
test("unverified company and cross-company founder cannot acquire a provenance link", () => {
  assert.equal(founderProfileSourceUrl({ ...node, review_state: "needs_review" }, founder), undefined);
  assert.equal(founderProfileSourceUrl({ ...node, entityType: "founder" }, founder), undefined);
  assert.equal(founderProfileSourceUrl(node, { ...founder, id: "founder-other-person-123" }), undefined);
});
