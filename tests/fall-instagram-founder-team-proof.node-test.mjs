import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildInstagramFounderTeamIdentity, isVerifiedInstagramFounderTeamIdentity, verifyInstagramFounderTeamIdentityArchive } from "../scripts/lib/instagram-founder-team-proof.mjs";

const hash = (v) => createHash("sha256").update(v).digest("hex");
const clone = (v) => structuredClone(v);
const caption = "Meet our team 👋🏻: Slavko Kovačević, our CEO and co-founder\n\nSlavko Kovačević is a Ph.D. student in Computer Science at the University of Montenegro, with research in neural networks and digital signal processing.";
const founder = { id: "2023960", name: "Slavko Kovačević", ycProfileUrl: "https://www.ycombinator.com/people/slavko-kova-evi" };
const company = { id: "38127", slug: "deepmark", name: "DeepMark", websiteUrl: "https://www.deepmark.me", ycProfileUrl: "https://www.ycombinator.com/companies/deepmark", founders: [founder] };
const entity = { entityId: "founder-deepmark-slavko-kova-evi-2023960", companySlug: "deepmark", founderName: founder.name };
const link = (handle) => ({ href: `https://www.instagram.com/${handle}/`, text: handle, html: `<a href="/${handle}/">${handle}</a>` });
function wrap(identity) { return { entityType: "founder", founderId: founder.id, founderName: founder.name, handle: "slavzilla", profileUrl: "https://www.instagram.com/slavzilla/", companyAccountMention: "deepmark.me", nativeFounderTeamIdentity: identity }; }
function resign(identity) { const copy = { ...identity }; delete copy.validationHash; identity.validationHash = hash(JSON.stringify(copy)); return identity; }

async function fixture(run) {
  const previous = process.cwd(), dir = await fs.mkdtemp(path.join(os.tmpdir(), "ig-team-proof-"));
  process.chdir(dir);
  try {
    const website = '<html><footer><a href="https://www.instagram.com/deepmark.me/">Instagram</a></footer></html>';
    const receipt = { companySlug: "deepmark", companyName: "DeepMark", officialWebsite: company.websiteUrl, finalWebsiteUrl: `${company.websiteUrl}/`, instagramUrl: "https://www.instagram.com/deepmark.me/", anchorText: "Instagram", anchorHtml: '<a href="https://www.instagram.com/deepmark.me/">Instagram</a>', htmlSha256: hash(website), observedAt: "2026-11-16T03:00:00.000Z" };
    const companyProof = { entityType: "company", handle: "deepmark.me", profileUrl: receipt.instagramUrl, review_state: "verified", officialWebsiteOutboundReceipt: receipt };
    const links = [link("deepmark.me"), link("slavzilla")];
    const header = { mechanism: "native_post_dialog_header_v1", selection: "native_dialog_header_element", handle: "deepmark.me", profileUrl: receipt.instagramUrl, visibleText: "deepmark.me\nand\nslavzilla", links, html: `<header>${links.map((l) => l.html).join(" and ")}</header>` };
    const introduction = { url: "https://www.instagram.com/p/C3-WUN4NzWV/", caption, captionConfirmedVisible: true, nativeText: `deepmark.me\nand\nslavzilla\n${caption}`, nativeAuthorHeader: header, nativeCaptionReceipt: { mechanism: "native_caption_dialog_h1_v1", caption, authorLink: receipt.instagramUrl, authorName: "deepmark.me", blockVisibleText: caption, h1Count: 1 }, publicationFooter: { href: "https://www.instagram.com/deepmark.me/p/C3-WUN4NzWV/", datetime: "2024-03-01T14:00:04.000Z", text: "March 1, 2024" }, observedAt: "2026-11-16T20:15:11.933Z", dialogHtml: `<article>${header.html}<h1>${caption.replaceAll("\n", "<br>")}</h1></article>` };
    const anchor = { href: "https://www.instagram.com/slavzilla/", text: "", html: '<a href="/slavzilla/"><img alt="slavzilla\'s profile picture"></a>' };
    const introPath = path.join(dir, "intro.json"), artifactPath = path.join(dir, "identity.json");
    const intro = { source: { batchSlug: "F26", platform: "instagram", collectionMethod: "authorized_native_instagram_founder_team_intro_dom_v1", profileUrl: receipt.instagramUrl, exportedAt: "2026-11-16T20:15:27.581Z" }, introductions: [introduction] };
    const native = { source: { batchSlug: "F26", platform: "instagram", collectionMethod: "authorized_native_instagram_founder_team_intro_identity_v1", exportedAt: "2026-11-16T20:16:06.538Z" }, founderId: founder.id, founderName: founder.name, companySlug: company.slug, officialCompanyProfileUrl: receipt.instagramUrl, officialFounderIdentitySourceUrl: founder.ycProfileUrl, introSource: { path: introPath, sha256: hash(JSON.stringify(intro)) }, introduction: clone(introduction), profile: { url: "https://www.instagram.com/slavzilla/", headings: ["slavzilla"], visibleText: "slavzilla\nСлавко Ковачевић\n72 posts\nFollow", mainHtml: `<main>${anchor.html}<h2>slavzilla</h2><p>Славко Ковачевић</p></main>`, links: [anchor], observedAt: "2026-11-16T20:15:51.854Z" } };
    const websitePath = `outputs/fall-2026/public-history-cache/deepmark/${receipt.htmlSha256}.html`;
    await fs.mkdir(path.dirname(websitePath), { recursive: true }); await fs.writeFile(websitePath, website); await fs.writeFile(introPath, JSON.stringify(intro));
    const build = async () => { const artifactBytes = Buffer.from(JSON.stringify(native)); await fs.writeFile(artifactPath, artifactBytes); return buildInstagramFounderTeamIdentity({ artifactPath, artifactBytes, company, founder, companyProof }); };
    const syncIntroduction = async () => {
      native.introduction.dialogHtml = `<article>${native.introduction.nativeAuthorHeader.html}<h1>${native.introduction.caption.replaceAll("\n", "<br>")}</h1></article>`;
      native.introduction.nativeText = `${native.introduction.nativeAuthorHeader.visibleText}\n${native.introduction.caption}`;
      native.introduction.nativeCaptionReceipt.caption = native.introduction.caption;
      native.introduction.nativeCaptionReceipt.blockVisibleText = native.introduction.caption;
      intro.introductions[0] = clone(native.introduction);
      const bytes = JSON.stringify(intro); await fs.writeFile(introPath, bytes); native.introSource.sha256 = hash(bytes);
    };
    await run({ native, intro, introPath, artifactPath, websitePath, companyProof, build, syncIntroduction });
  } finally { process.chdir(previous); await fs.rm(dir, { recursive: true, force: true }); }
}

test("formal company team introduction physically binds exact Cyrillic founder profile and existing entity ID", async () => fixture(async ({ build, companyProof }) => {
  const identity = await build();
  assert.equal(identity.entityId, entity.entityId); assert.equal(identity.profile.private, false);
  assert.equal(isVerifiedInstagramFounderTeamIdentity(wrap(identity), entity), true);
  assert.equal(await verifyInstagramFounderTeamIdentityArchive(wrap(identity), company, founder, companyProof), true);
}));

for (const [name, change] of [
  ["interview instead of formal introduction", (n) => { n.introduction.caption = "Interview with Slavko Kovačević"; }],
  ["third personal coauthor", (n) => { n.introduction.nativeAuthorHeader.links.push(link("someoneelse")); n.introduction.nativeAuthorHeader.html = n.introduction.nativeAuthorHeader.html.replace("</header>", `${link("someoneelse").html}</header>`); }],
  ["personal actor replaces company primary", (n) => { n.introduction.nativeAuthorHeader.profileUrl = "https://www.instagram.com/slavzilla/"; n.introduction.nativeAuthorHeader.handle = "slavzilla"; }],
  ["caption transplanted from comment", (n) => { n.introduction.nativeCaptionReceipt.authorName = "slavzilla"; }],
  ["different personal profile", (n) => { n.profile.url = "https://www.instagram.com/unrelated/"; }],
  ["full name absent from actual profile", (n) => { n.profile.visibleText = "slavzilla\n72 posts\nFollow"; }],
  ["profile observed before company introduction", (n) => { n.profile.observedAt = "2026-11-16T19:00:00.000Z"; }],
  ["different native physical post", (n) => { n.introduction.url = "https://www.instagram.com/p/OTHER/"; }],
]) test(`rejects ${name} with mutually matching physical intro/identity archives`, async () => fixture(async ({ native, build, syncIntroduction }) => { change(native); await syncIntroduction(); await assert.rejects(build); }));

test("pure validator rejects tampered caption and canonical-ID forks even with recomputed validation hash", async () => fixture(async ({ build }) => {
  const identity = await build(), changed = clone(identity); changed.nativeIntro.caption = "Meet our team 👋🏻: Slavko Kovačević, our CEO and co-founder\n\nAn unrelated biography."; resign(changed);
  assert.equal(isVerifiedInstagramFounderTeamIdentity(wrap(changed), entity), false);
  const fork = clone(identity); fork.entityId = "founder-deepmark-slavko-kovacevic-2023960"; resign(fork);
  assert.equal(isVerifiedInstagramFounderTeamIdentity(wrap(fork), { ...entity, entityId: fork.entityId }), false);
}));

for (const kind of ["identity", "introduction", "official_company_homepage"]) test(`physical verifier rejects changed ${kind} archive`, async () => fixture(async ({ build, companyProof }) => {
  const identity = await build(), archive = identity.archives.find((a) => a.kind === kind); await fs.appendFile(archive.path, " ");
  await assert.rejects(() => verifyInstagramFounderTeamIdentityArchive(wrap(identity), company, founder, companyProof), /archive SHA changed/);
}));

test("copied intro changes require equality with separate native snapshot, not just identity-file hash", async () => fixture(async ({ native, build }) => {
  native.introduction.nativeText += " fabricated"; await assert.rejects(build, /separate physical native snapshot/);
}));
