import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildInstagramCompanyProfileProof, verifyInstagramCompanyProfileArchive } from "../scripts/lib/instagram-company-profile-proof.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t, change = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), "native-company-profile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const company = { slug: "fixture", websiteUrl: "https://www.fixture.example", ycProfileUrl: "https://www.ycombinator.com/companies/fixture" };
  const url = "https://www.instagram.com/fixture.brand/", anchor = `<a href="${url}" aria-label="Instagram">Instagram</a>`;
  const footerPath = join(directory, "footer.html"), inventoryPath = join(directory, "inventory.json"), artifactPath = join(directory, "native.json");
  const footer = `<footer>${anchor}</footer>`;
  const candidate = { companySlug: company.slug, platform: "instagram", observedUrl: url, literalHref: url, intendedEntityType: "company", ownershipConfidence: "literal_company_footer_on_proven_official_domain", anchorText: "Instagram", anchorHtml: anchor,
    source: { path: footerPath, sha256: sha(footer), hostOwned: true, officialWebsite: company.websiteUrl, sourceUrl: "https://fixture.example/about", observedAt: "2026-11-16T10:00:00Z" } };
  const nativeLink = { href: "https://l.instagram.com/?u=https%3A%2F%2Ffixture.example%2F", text: "fixture.example" };
  nativeLink.html = `<a href="${nativeLink.href}">fixture.example</a>`;
  const native = { source: { batchSlug: "F26", platform: "instagram", collectionMethod: "authorized_native_instagram_profile_dom_v1", exportedAt: "2026-11-16T12:00:00Z" }, companySlug: company.slug, officialWebsite: company.websiteUrl, officialIdentitySourceUrl: company.ycProfileUrl,
    profile: { url, visibleText: "fixture.brand\nFixture Brand\nfixture.example", observedAt: "2026-11-16T11:00:00Z", links: [nativeLink], mainHtml: `<main><img alt="fixture.brand's profile picture">${nativeLink.html}</main>` } };
  const state = { native, candidate, footer };
  change(state);
  await writeFile(footerPath, state.footer);
  candidate.source.sha256 = sha(state.footer);
  const inventory = JSON.stringify({ candidates: [candidate] });
  await writeFile(inventoryPath, inventory);
  native.ownedSiteCandidateSource = { path: inventoryPath, sha256: sha(inventory) };
  const bytes = JSON.stringify(native);
  await writeFile(artifactPath, bytes);
  return { company, artifactPath, artifactSha256: sha(bytes), footerPath };
}

test("literal official footer and native profile outbound domain prove the existing company account", async (t) => {
  const f = await fixture(t), proof = await buildInstagramCompanyProfileProof(f);
  assert.equal(proof.handle, "fixture.brand");
  assert.equal(proof.visibleWebsite, "https://fixture.example");
  assert.equal(await verifyInstagramCompanyProfileArchive(proof, f.company), true);
  await writeFile(f.footerPath, "mutated");
  await assert.rejects(verifyInstagramCompanyProfileArchive(proof, f.company), /archive SHA changed/);
});

test("self-consistent archived inputs still reject unrelated domains, footer accounts, and profile headers", async (t) => {
  for (const mutate of [
    ({ native }) => { native.profile.links[0].href = "https://l.instagram.com/?u=https%3A%2F%2Funrelated.example%2F"; },
    ({ native }) => { native.profile.mainHtml = "<main>No outbound anchor</main>"; },
    ({ native }) => { native.profile.visibleText = "other.account\nFixture Brand\nfixture.example"; },
    (state) => { state.footer = '<footer><a href="https://www.instagram.com/unrelated/">Instagram</a></footer>'; },
    ({ candidate }) => { candidate.source.sourceUrl = "https://external-publisher.example/press"; },
    ({ native }) => { native.source.exportedAt = "2026-11-16T09:00:00Z"; }
  ]) {
    const f = await fixture(t, mutate);
    await assert.rejects(buildInstagramCompanyProfileProof(f));
  }
});

test("proof fields cannot be reassigned while retaining the original physical identity receipt", async (t) => {
  const f = await fixture(t), proof = await buildInstagramCompanyProfileProof(f);
  await assert.rejects(verifyInstagramCompanyProfileArchive({ ...proof, handle: "unrelated" }, f.company), /differs/);
  assert.ok((await readFile(f.artifactPath)).length);
});
