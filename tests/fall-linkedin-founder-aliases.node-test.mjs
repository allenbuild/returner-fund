import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalLinkedInFounderProfile, verifiedFallLinkedInFounderAccounts } from "../src/lib/graph/linkedin-founder-aliases.mjs";

const company = { slug: "championeffect-inc" }, founder = { id: "56520", name: "Kevin Law", socialLinks: { linkedin: "https://www.linkedin.com/in/kevin-law-4b526525" } };
function registry() {
  const proof = { source: "fall_2026_linkedin_founder_alias_v1", batchSlug: "F26", companySlug: company.slug, founderId: founder.id, founderName: founder.name, officialProfileUrl: founder.socialLinks.linkedin, profileUrl: "https://www.linkedin.com/in/kvnlw/", method: "native_official_profile_redirect", archives: [{ path: "exact-native-profile.json", sha256: "a".repeat(64) }] };
  return { proofs: [{ ...proof, validation: { source: "fall_2026_linkedin_founder_alias_ingestion_v1", archiveHashesVerified: true, contentSha256: createHash("sha256").update(JSON.stringify(proof)).digest("hex") } }] };
}
test("physically reviewed alias extends only the exact founder lineage and retains official URL", () => {
  assert.deepEqual(verifiedFallLinkedInFounderAccounts(company, founder, registry()), [founder.socialLinks.linkedin, "https://www.linkedin.com/in/kvnlw/"]);
  assert.deepEqual(verifiedFallLinkedInFounderAccounts(company, { ...founder, id: "other" }, registry()), [founder.socialLinks.linkedin]);
});
test("changed alias/company/digest, missing physical validation and unknown methods fail closed", () => {
  for (const change of [(p) => { p.profileUrl = "https://www.linkedin.com/in/other/"; }, (p) => { p.companySlug = "other"; }, (p) => { p.validation.archiveHashesVerified = false; }, (p) => { p.method = "name_search"; }, (p) => { p.archives = []; }]) { const value = registry(); change(value.proofs[0]); assert.deepEqual(verifiedFallLinkedInFounderAccounts(company, founder, value), [founder.socialLinks.linkedin]); }
});
test("regional official profiles normalize while lookalikes, queries and credentials are rejected", () => {
  assert.equal(canonicalLinkedInFounderProfile("https://tr.linkedin.com/in/emre-%C5%9Fimdi-8b256949"), "https://www.linkedin.com/in/emre-%c5%9fimdi-8b256949/");
  for (const url of ["https://notlinkedin.com/in/kvnlw/", "https://www.linkedin.com.evil.test/in/kvnlw/", "https://www.linkedin.com/in/kvnlw/?other=true", "https://user@www.linkedin.com/in/kvnlw/"]) assert.equal(canonicalLinkedInFounderProfile(url), null);
});
