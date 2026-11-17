import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as cheerio from "cheerio";
import { instagramNativeAuthorHandle, isVerifiedInstagramNativeCaption } from "./instagram-native-observation.mjs";
import { isOfficialInstagramOutboundReceipt } from "./instagram-official-outbound-proof.mjs";

const sha = (v) => createHash("sha256").update(v).digest("hex");
const text = (v) => String(v ?? "").replace(/\s+/gu, " ").trim();
const slug = (v) => v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const validHash = (v) => /^[a-f0-9]{64}$/.test(v ?? "");
const time = (v) => Number.isFinite(Date.parse(v)) ? Date.parse(v) : NaN;
const scope = {
  "2023960": { name: "Slavko Kovačević", handle: "slavzilla", id: "C3-WUN4NzWV", role: "CEO", yc: "https://www.ycombinator.com/people/slavko-kova-evi", displayNames: ["Slavko Kovačević", "Славко Ковачевић"], biography: /Ph\.D\. student in Computer Science at the University of Montenegro/u },
  "2547276": { name: "Kosta Pavlović", handle: "kosta.pavlovic", id: "C4BQ9V1NXpv", role: "CTO", yc: "https://www.ycombinator.com/people/kosta-pavlovi", displayNames: ["Kosta Pavlović"], biography: /Ph\.D\. candidate with a thesis focused on digital audio watermarking using deep neural networks/u },
};
function profileHandle(value, { relative = false } = {}) {
  try {
    const u = relative ? new URL(value, "https://www.instagram.com") : new URL(value);
    return u.protocol === "https:" && /^(?:www\.)?instagram\.com$/.test(u.hostname) && !u.username && !u.password && !u.port && !u.search && !u.hash && /^\/[a-z0-9_.]+\/?$/i.test(u.pathname) ? u.pathname.replace(/^\/|\/$/g, "").toLowerCase() : null;
  } catch { return null; }
}
function postId(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && /^(?:www\.)?instagram\.com$/.test(u.hostname) && !u.username && !u.password && !u.port && !u.search && !u.hash ? u.pathname.match(/^\/(?:[a-z0-9_.]+\/)?p\/([a-zA-Z0-9_-]+)\/?$/)?.[1] : null;
  } catch { return null; }
}
function validationHash(identity) {
  const copy = { ...identity }; delete copy.validationHash;
  return sha(JSON.stringify(copy));
}
function compactIntro(post) {
  return { url: post.url, caption: post.caption, captionConfirmedVisible: post.captionConfirmedVisible, nativeText: post.nativeText, nativeAuthorHeader: post.nativeAuthorHeader, nativeCaptionReceipt: post.nativeCaptionReceipt, publicationFooter: post.publicationFooter, observedAt: post.observedAt };
}
function assertNativeIdentity(identity, proof, entity) {
  const s = scope[identity?.founderId];
  if (!s || identity.source !== "native_instagram_formal_company_team_intro_v1" || identity.batchSlug !== "F26" || identity.companySlug !== "deepmark" || identity.companyHandle !== "deepmark.me"
    || identity.founderName !== s.name || identity.handle !== s.handle || proof.entityType !== "founder" || proof.founderId !== identity.founderId || proof.founderName !== s.name || proof.handle !== s.handle
    || proof.companyAccountMention !== "deepmark.me" || profileHandle(proof.profileUrl) !== s.handle || profileHandle(identity.profileUrl) !== s.handle
    || identity.entityId !== `founder-deepmark-${slug(s.name)}-${identity.founderId}` || entity?.entityId !== identity.entityId || entity.companySlug !== "deepmark" || entity.founderName !== s.name
    || identity.officialYcCompanyUrl !== "https://www.ycombinator.com/companies/deepmark" || identity.officialYcFounderUrl !== s.yc
    || !validHash(identity.validationHash) || validationHash(identity) !== identity.validationHash) return false;
  if (!Array.isArray(identity.archives) || identity.archives.length !== 3 || new Set(identity.archives.map((a) => a.kind)).size !== 3 || identity.archives.some((a) => !a.path || !validHash(a.sha256))
    || !identity.archives.some((a) => a.kind === "identity") || !identity.archives.some((a) => a.kind === "introduction") || !identity.archives.some((a) => a.kind === "official_company_homepage")) return false;
  const intro = identity.nativeIntro, header = intro?.nativeAuthorHeader, caption = intro?.caption ?? "";
  if (postId(intro?.url) !== s.id || postId(intro.publicationFooter?.href) !== s.id || !Number.isFinite(time(intro.publicationFooter?.datetime)) || time(intro.publicationFooter.datetime) > time(intro.observedAt)
    || !caption.startsWith(`Meet our team 👋🏻: ${s.name}, our ${s.role} and co-founder\n\n`) || !s.biography.test(caption) || !caption.includes("University of Montenegro")
    || intro.captionConfirmedVisible !== true || !text(intro.nativeText).includes(text(caption)) || instagramNativeAuthorHandle(intro) !== "deepmark.me"
    || !isVerifiedInstagramNativeCaption({ ...intro, text: caption }, "deepmark.me") || intro.nativeCaptionReceipt?.h1Count !== 1
    || header?.mechanism !== "native_post_dialog_header_v1" || header.selection !== "native_dialog_header_element" || profileHandle(header.profileUrl) !== "deepmark.me"
    || text(header.visibleText) !== `deepmark.me and ${s.handle}` || !Array.isArray(header.links) || header.links.length !== 2) return false;
  const $ = cheerio.load(header.html ?? ""), anchors = $("header a[href]").toArray();
  if ($("header").length !== 1 || anchors.length !== 2) return false;
  for (const [i, handle] of ["deepmark.me", s.handle].entries()) {
    const link = header.links[i];
    if (profileHandle($(anchors[i]).attr("href"), { relative: true }) !== handle || text($(anchors[i]).text()) !== handle || profileHandle(link?.href) !== handle || text(link.text) !== handle || !header.html.includes(link.html)) return false;
  }
  const profile = identity.profile;
  if (profileHandle(profile?.url) !== s.handle || profile.heading !== s.handle || profile.visibleText?.split("\n")[0] !== s.handle || !s.displayNames.some((name) => profile.visibleText.split("\n").includes(name))
    || /sorry, this page|page isn't available|log in to continue/i.test(profile.visibleText) || profile.private !== /This profile is private/.test(profile.visibleText) || !validHash(profile.mainHtmlSha256) || !validHash(profile.visibleTextSha256) || sha(profile.visibleText) !== profile.visibleTextSha256
    || profileHandle(profile.profileAnchor?.href) !== s.handle || !profile.profileAnchor.html?.includes(`${s.handle}'s profile picture`)) return false;
  const p$ = cheerio.load(profile.profileAnchor.html);
  if (p$("a").length !== 1 || profileHandle(p$("a").attr("href"), { relative: true }) !== s.handle || p$("img").attr("alt") !== `${s.handle}'s profile picture`) return false;
  if (!(time(intro.observedAt) <= time(identity.introExportedAt) && time(identity.introExportedAt) <= time(profile.observedAt) && time(profile.observedAt) <= time(identity.exportedAt))) return false;
  const receipt = identity.officialCompanyOutboundReceipt;
  return isOfficialInstagramOutboundReceipt(receipt, { slug: "deepmark", websiteUrl: "https://www.deepmark.me" }, "https://www.instagram.com/deepmark.me/") && time(receipt.observedAt) <= time(intro.observedAt)
    && identity.archives.find((a) => a.kind === "official_company_homepage").sha256 === receipt.htmlSha256;
}

/** Returns a compact, manually scoped identity receipt; it never discovers aliases. */
export async function buildInstagramFounderTeamIdentity({ artifactPath, artifactBytes, company, founder, companyProof }) {
  if (sha(await readFile(artifactPath)) !== sha(artifactBytes)) throw new Error("Native founder identity input differs from its physical archive.");
  const native = JSON.parse(artifactBytes), s = scope[String(founder?.id)];
  if (!s || company?.slug !== "deepmark" || founder.name !== s.name || !company.founders?.some((f) => String(f.id) === String(founder.id) && f.name === founder.name)
    || native.source?.batchSlug !== "F26" || native.source.platform !== "instagram" || native.source.collectionMethod !== "authorized_native_instagram_founder_team_intro_identity_v1"
    || native.companySlug !== company.slug || native.founderId !== String(founder.id) || native.founderName !== founder.name || native.officialFounderIdentitySourceUrl !== founder.ycProfileUrl
    || profileHandle(native.officialCompanyProfileUrl) !== "deepmark.me" || companyProof?.entityType !== "company" || companyProof.handle !== "deepmark.me" || companyProof.review_state !== "verified"
    || !isOfficialInstagramOutboundReceipt(companyProof.officialWebsiteOutboundReceipt, company, native.officialCompanyProfileUrl)) throw new Error("Formal team identity does not match the scoped official company/founder.");
  const introBytes = await readFile(native.introSource.path);
  if (sha(introBytes) !== native.introSource.sha256) throw new Error("Native team introduction archive SHA changed.");
  const introArchive = JSON.parse(introBytes);
  if (introArchive.source?.batchSlug !== "F26" || introArchive.source.platform !== "instagram" || introArchive.source.collectionMethod !== "authorized_native_instagram_founder_team_intro_dom_v1"
    || profileHandle(introArchive.source.profileUrl) !== "deepmark.me" || !introArchive.introductions?.some((p) => JSON.stringify(p) === JSON.stringify(native.introduction))) throw new Error("Copied introduction differs from the separate physical native snapshot.");
  const intro = native.introduction, profile = native.profile;
  const $ = cheerio.load(intro.dialogHtml ?? ""), h1 = $("h1");
  const h1Text = cheerio.load((h1.html() ?? "").replace(/<br\s*\/?\s*>/gi, "\n")).text();
  if (h1.length !== 1 || text(h1Text) !== text(intro.caption) || !intro.dialogHtml.includes(intro.nativeAuthorHeader?.html)) throw new Error("Formal team caption/header is not bound to the actual native dialog.");
  const profileAnchor = profile?.links?.find((l) => profileHandle(l.href) === s.handle && l.html?.includes(`${s.handle}'s profile picture`));
  if (!profileAnchor || !profile.mainHtml?.includes(profileAnchor.html) || !profile.mainHtml.includes(s.displayNames.find((name) => profile.visibleText?.split("\n").includes(name)) ?? "__missing_name__")) throw new Error("Exact personal profile header/name is not bound to native DOM.");
  const receipt = companyProof.officialWebsiteOutboundReceipt;
  const websitePath = `${"outputs/fall-2026/public-history-cache"}/deepmark/${receipt.htmlSha256}.html`;
  const websiteBytes = await readFile(websitePath);
  if (sha(websiteBytes) !== receipt.htmlSha256) throw new Error("Official company homepage archive SHA changed.");
  const w$ = cheerio.load(websiteBytes.toString("utf8"));
  if (!w$("a[href]").toArray().some((a) => profileHandle(w$(a).attr("href")) === "deepmark.me")) throw new Error("Physical official homepage has no literal company Instagram anchor.");
  const identity = {
    source: "native_instagram_formal_company_team_intro_v1", batchSlug: "F26", companySlug: company.slug, companyHandle: "deepmark.me", founderId: String(founder.id), founderName: founder.name,
    entityId: `founder-${company.slug}-${slug(founder.name)}-${founder.id}`, handle: s.handle, profileUrl: profile.url,
    officialYcCompanyUrl: company.ycProfileUrl, officialYcFounderUrl: founder.ycProfileUrl, officialCompanyOutboundReceipt: receipt,
    nativeIntro: compactIntro(intro), introExportedAt: introArchive.source.exportedAt, exportedAt: native.source.exportedAt,
    profile: { url: profile.url, heading: profile.headings?.[0], visibleText: profile.visibleText, visibleTextSha256: sha(profile.visibleText), mainHtmlSha256: sha(profile.mainHtml), profileAnchor, observedAt: profile.observedAt, private: /This profile is private/.test(profile.visibleText) },
    archives: [{ path: artifactPath, sha256: sha(artifactBytes), kind: "identity" }, { path: native.introSource.path, sha256: sha(introBytes), kind: "introduction" }, { path: websitePath, sha256: sha(websiteBytes), kind: "official_company_homepage" }],
  };
  identity.validationHash = validationHash(identity);
  const proof = { entityType: "founder", founderId: String(founder.id), founderName: founder.name, handle: s.handle, profileUrl: identity.profileUrl, companyAccountMention: "deepmark.me", nativeFounderTeamIdentity: identity };
  if (!isVerifiedInstagramFounderTeamIdentity(proof, { entityId: identity.entityId, companySlug: company.slug, founderName: founder.name })) throw new Error("Native formal team introduction/profile proof failed exact owner validation.");
  return identity;
}

export function isVerifiedInstagramFounderTeamIdentity(proof, entity) {
  try { return assertNativeIdentity(proof?.nativeFounderTeamIdentity, proof, entity); } catch { return false; }
}

export async function verifyInstagramFounderTeamIdentityArchive(proof, company, founder, companyProof) {
  const identity = proof?.nativeFounderTeamIdentity;
  if (!identity) return false;
  for (const archive of identity.archives ?? []) if (sha(await readFile(archive.path)) !== archive.sha256) throw new Error(`Native founder team ${archive.kind} archive SHA changed.`);
  const source = identity.archives.find((a) => a.kind === "identity");
  const expected = await buildInstagramFounderTeamIdentity({ artifactPath: source.path, artifactBytes: await readFile(source.path), company, founder, companyProof });
  if (JSON.stringify(expected) !== JSON.stringify(identity) || !isVerifiedInstagramFounderTeamIdentity(proof, { entityId: expected.entityId, companySlug: company.slug, founderName: founder.name })) throw new Error("Formal team proof differs from physically verified exact owner archives.");
  return true;
}
