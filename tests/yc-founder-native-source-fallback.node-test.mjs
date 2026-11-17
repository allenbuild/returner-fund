import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeFounder } from "../scripts/fetch-yc-spring-2026.mjs";

test("future founder sanitization uses the actual company profile without inventing a person URL", () => {
  const native = { user_id: 406206, full_name: "Robin Choy", title: "Founder/CEO", founder_bio: "Native biography", twitter_url: "https://x.com/ChoyRb", linkedin_url: "https://www.linkedin.com/in/rbchoy/" };
  const result = sanitizeFounder(native, "adsideai", "https://www.ycombinator.com/companies/adsideai");
  assert.deepEqual(result, { id: "406206", name: "Robin Choy", title: "Founder/CEO", bio: "Native biography", ycProfileUrl: "https://www.ycombinator.com/companies/adsideai", socialLinks: { linkedin: native.linkedin_url, x: native.twitter_url } });
  assert.equal(result.ycProfileUrl.includes("/people/"), false);
});
test("accented names and missing user IDs cannot produce guessed person slugs", () => {
  const named = sanitizeFounder({ user_id: 2023960, full_name: "Slavko Kovačević" }, "deepmark", "https://www.ycombinator.com/companies/deepmark");
  assert.equal(named.id, "2023960"); assert.equal(named.name, "Slavko Kovačević");
  assert.equal(named.ycProfileUrl, "https://www.ycombinator.com/companies/deepmark");
  const unknown = sanitizeFounder({ full_name: "Known Person" }, "company", "https://www.ycombinator.com/companies/company");
  assert.equal(unknown.id, "company-known-person");
  assert.equal(unknown.ycProfileUrl, "https://www.ycombinator.com/companies/company");
  assert.equal(sanitizeFounder({ user_id: 1, full_name: "Name" }, "company").ycProfileUrl, null);
});
