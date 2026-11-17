import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInstagramFounderSocialIdentity, isVerifiedInstagramFounderSocialIdentity, verifyInstagramFounderSocialIdentityArchive } from "../scripts/lib/instagram-founder-social-proof.mjs";

const company = { slug: "antimattr" }, founder = { id: "3675155", name: "Sirsho C", socialLinks: { x: "https://x.com/sirsho29", linkedin: "https://www.linkedin.com/in/sirsho29" } };
const native = () => ({ profile: { url: "https://www.instagram.com/sirsho29/", text: "sirsho29\nSirsho Chakraborty\nbuilding @antimattr.one", observedAt: "2026-11-16T18:07:26.308Z" }, outboundDialog: { links: [{ url: "https://l.instagram.com/?u=https%3A%2F%2Fx.com%2Fsirsho29%3Ffbclid%3Dnative", text: "X" }, { url: "https://l.instagram.com/?u=http%3A%2F%2Flinkedin.com%2Fin%2Fsirsho29%3Futm_source%3Dig", text: "LinkedIn" }] } });
const make = (bytes, artifactPath = "native.json") => buildInstagramFounderSocialIdentity({ artifactPath, artifactBytes: bytes, company, founder, handle: "sirsho29", companyHandle: "antimattr.one" });
const wrapper = (identity) => ({ entityType: "founder", founderId: founder.id, founderName: founder.name, handle: "sirsho29", profileUrl: native().profile.url, companyAccountMention: "antimattr.one", nativeFounderSocialIdentity: identity });
const entity = { entityId: "founder-antimattr-sirsho-c-3675155", founderName: founder.name, companySlug: company.slug, socialAccounts: founder.socialLinks };

test("exact native outbound X and LinkedIn bind an existing founder without inventing a company-domain link", () => {
  const identity = make(Buffer.from(JSON.stringify(native())));
  assert.equal(isVerifiedInstagramFounderSocialIdentity(wrapper(identity), entity), true);
  assert.equal(isVerifiedInstagramFounderSocialIdentity(wrapper(identity), { ...entity, entityId: "founder-antimattr-another-1" }), false);
  const wrong = native(); wrong.outboundDialog.links[1].url = "https://linkedin.com/in/unrelated";
  assert.throws(() => make(Buffer.from(JSON.stringify(wrong))), /both official roster/);
});

test("a company mention alone and a copied known social link in a different native profile cannot authorize a founder", () => {
  const mentionOnly = native(); mentionOnly.outboundDialog.links = [];
  assert.throws(() => make(Buffer.from(JSON.stringify(mentionOnly))), /both official roster/);
  const other = native(); other.profile.url = "https://www.instagram.com/unrelated/";
  assert.throws(() => make(Buffer.from(JSON.stringify(other))), /both official roster/);
});

test("the exact physical native profile/overlay archive is rehashed before ingestion", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "instagram-founder-proof-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "native.json"), bytes = Buffer.from(JSON.stringify(native())); await writeFile(path, bytes);
  const proof = wrapper(make(bytes, path));
  assert.equal(await verifyInstagramFounderSocialIdentityArchive(proof, company, founder), true);
  await writeFile(path, JSON.stringify({ ...native(), source: "changed" }));
  await assert.rejects(verifyInstagramFounderSocialIdentityArchive(proof, company, founder), /SHA changed/);
});
