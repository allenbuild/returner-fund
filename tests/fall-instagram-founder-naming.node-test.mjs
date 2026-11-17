import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { matchesInstagramFounderNamingArchive, verifyInstagramFounderNamingArchive } from "../scripts/lib/instagram-founder-naming-proof.mjs";

const company = { slug: "rhem-labs", websiteUrl: "https://rhem.ai", ycProfileUrl: "https://www.ycombinator.com/companies/rhem-labs" };
const founder = { id: "1690205", name: "Jacob Shen", ycProfileUrl: "https://www.ycombinator.com/people/jacob-shen" };
function fixture() {
  const nameAnchor = { href: "https://www.instagram.com/JacobHardware/", text: "@JacobHardware", html: '<a href="/JacobHardware/">@JacobHardware</a>' };
  const domainAnchor = { url: "https://l.instagram.com/?u=https%3A%2F%2Frhem.ai%2F", text: "rhem.ai", html: '<a href="https://l.instagram.com/?u=https%3A%2F%2Frhem.ai%2F">rhem.ai</a>' };
  const native = {
    source: { batchSlug: "F26", collectionMethod: "authorized_native_instagram_dom_v1", exportedAt: "2026-11-16T20:00:00Z" },
    profile: { url: "https://www.instagram.com/JacobHardware/", text: "jacobhardware\nJacob\nbuilding @rhemcares\nrhem.ai", observedAt: "2026-11-16T19:59:00Z", links: [domainAnchor], mainHtml: domainAnchor.html },
    founderNamingPost: { url: "https://www.instagram.com/p/DeKktiEH9w9/", visibleText: "FOUNDERS: Jacob Shen (@JacobHardware) & Huey Shen", links: [nameAnchor], mainHtml: nameAnchor.html }
  };
  const proof = { entityType: "founder", review_state: "verified", founderId: founder.id, founderName: founder.name, handle: "jacobhardware", profileUrl: "https://www.instagram.com/jacobhardware/", companyAccountMention: "rhemcares", visibleWebsite: "rhem.ai", nativeFounderNamingReceipt: {
    source: "native_instagram_founder_name_link_plus_official_domain_v1", officialYcCompanyUrl: company.ycProfileUrl, officialYcFounderUrl: founder.ycProfileUrl,
    nativePostUrl: native.founderNamingPost.url, nativePostId: "DeKktiEH9w9", exactFounderDeclaration: native.founderNamingPost.visibleText, nativeFounderAnchor: nameAnchor, nativeCompanyWebsiteAnchor: domainAnchor
  } };
  return { proof, native };
}
test("exact native naming link plus independently linked official-domain profile binds the existing founder", () => {
  const { proof, native } = fixture();
  assert.equal(matchesInstagramFounderNamingArchive(proof, company, founder, native), true);
  assert.equal(matchesInstagramFounderNamingArchive(proof, company, { ...founder, id: "another" }, native), false);
});
test("a name-only mention, unrelated profile, or unowned outbound domain cannot supply this proof", () => {
  for (const mutate of [
    ({ native }) => { native.founderNamingPost.links = []; },
    ({ native }) => { native.profile.url = "https://www.instagram.com/unrelated/"; },
    ({ native }) => { native.profile.text = "jacobhardware\nJacob\nNo company bio"; },
    ({ proof }) => { proof.nativeFounderNamingReceipt.nativeCompanyWebsiteAnchor.url = "https://example.org/"; },
    ({ native }) => { native.founderNamingPost.visibleText = "FOUNDERS: Other Jacob (@JacobHardware)"; }
  ]) {
    const value = fixture(); mutate(value);
    assert.equal(matchesInstagramFounderNamingArchive(value.proof, company, founder, value.native), false);
  }
});
test("the physical original archive is hashed and revalidated before collection admission", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "founder-naming-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const { proof, native } = fixture(), bytes = JSON.stringify(native), path = join(dir, "native.json");
  await writeFile(path, bytes);
  Object.assign(proof.nativeFounderNamingReceipt, { artifactPath: path, artifactSha256: createHash("sha256").update(bytes).digest("hex") });
  assert.equal(await verifyInstagramFounderNamingArchive(proof, company, founder), true);
  await writeFile(path, `${bytes}\n`);
  await assert.rejects(verifyInstagramFounderNamingArchive(proof, company, founder), /SHA changed/);
});
