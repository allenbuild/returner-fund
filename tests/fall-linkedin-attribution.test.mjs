import assert from "node:assert/strict";
import test from "node:test";
import { resolveLinkedInNativeAuthor } from "../scripts/lib/fall-linkedin-attribution.mjs";

const company = {
  slug: "vexo", name: "Vexo", ycProfileUrl: "https://www.ycombinator.com/companies/vexo",
  socialLinks: { linkedin: "https://www.linkedin.com/company/vexoaiinc" },
  founders: [{ id: "4000265", name: "Farqaleet Kiani", ycProfileUrl: "https://www.ycombinator.com/people/farqaleet-kiani", socialLinks: { linkedin: "https://www.linkedin.com/in/kianif/" } }]
};
const receipt = (url, extra = []) => ({
  profile: { resolvedProfileUrl: "https://www.linkedin.com/company/tryvexoai/" },
  captured: { preview: { links: [
    { href: `${url}?trk=public_post_embed_feed-actor-name`, text: "Observed author" }, ...extra
  ] } }
});

test("founder/company collaboration uses the exact roster primary founder", () => {
  const resolved = resolveLinkedInNativeAuthor(company, { kind: "coauthored_company_post" }, receipt("https://www.linkedin.com/in/kianif"));
  assert.equal(resolved.entityId, "founder-vexo-farqaleet-kiani-4000265");
  assert.equal(resolved.accountUrl, company.founders[0].socialLinks.linkedin);
  assert.equal(resolved.companyContext.entityId, "company-vexo");
});

test("quoted founder identity cannot replace the outer company author", () => {
  const resolved = resolveLinkedInNativeAuthor(company, {}, receipt("https://www.linkedin.com/company/tryvexoai", [
    { href: "https://www.linkedin.com/in/kianif?trk=public_post_embed_reshare_feed-actor-name", text: "Farqaleet Kiani" }
  ]));
  assert.equal(resolved.entityType, "company");
});

test("unknown personal primary authors require review despite company-grid membership", () => {
  assert.equal(resolveLinkedInNativeAuthor(company, {}, receipt("https://www.linkedin.com/in/unknown")).status, "needs_review");
});

test("collaborations without native primary-author proof require review", () => {
  assert.equal(resolveLinkedInNativeAuthor(company, { dateLabel: "with 2 others • 1mo" }).status, "needs_review");
});

test("an unrelated company primary author cannot borrow the roster identity", () => {
  assert.equal(resolveLinkedInNativeAuthor(company, {}, receipt("https://www.linkedin.com/company/unrelated")).status, "needs_review");
});

test("ordinary company HOME captions retain their observed authorship", () => {
  const resolved = resolveLinkedInNativeAuthor(company, { authorName: "Vexo", kind: "authored_quote_wrapper" });
  assert.equal(resolved.entityType, "company");
  assert.equal(resolved.kind, "authored_quote_wrapper");
});
