import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as cheerio from "cheerio";
import { instagramProfileKey, isOfficialInstagramOutboundReceipt } from "./instagram-official-outbound-proof.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const host = (value) => { try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; } };
const clock = (value) => Date.parse(value);
const outbound = (href) => { try { const u = new URL(href); return u.hostname === "l.instagram.com" ? new URL(u.searchParams.get("u")).href : u.href; } catch { return null; } };
async function archived(path, expectedHash) {
  const bytes = await readFile(path);
  if (sha(bytes) !== expectedHash) throw new Error("Native company identity source archive SHA changed.");
  return bytes;
}

export async function buildInstagramCompanyProfileProof({ artifactPath, artifactSha256, company }) {
  const bytes = await archived(artifactPath, artifactSha256), native = JSON.parse(bytes), profile = native.profile;
  const handle = instagramProfileKey(profile?.url), domain = host(company?.websiteUrl);
  if (native.source?.batchSlug !== "F26" || native.source.platform !== "instagram" || native.source.collectionMethod !== "authorized_native_instagram_profile_dom_v1"
    || native.companySlug !== company?.slug || native.officialIdentitySourceUrl !== company.ycProfileUrl || host(native.officialWebsite) !== domain
    || !handle || profile.url !== `https://www.instagram.com/${handle}/` || profile.visibleText?.split("\n")[0] !== handle
    || !Number.isFinite(clock(profile.observedAt)) || !(clock(profile.observedAt) <= clock(native.source.exportedAt))) throw new Error("Native company profile must resolve exactly to the existing roster company.");
  const link = profile.links?.find((entry) => host(outbound(entry.href)) === domain && entry.html && profile.mainHtml?.includes(entry.html));
  const n$ = cheerio.load(link?.html ?? "");
  if (!link || n$("a").length !== 1 || n$("a").attr("href")?.replaceAll("&amp;", "&") !== link.href || host(outbound(n$("a").attr("href"))) !== domain
    || !profile.mainHtml.includes(`${handle}'s profile picture`)) throw new Error("Actual native profile DOM must contain its own account and exact official-domain outbound anchor.");
  const inventoryBytes = await archived(native.ownedSiteCandidateSource.path, native.ownedSiteCandidateSource.sha256);
  const candidates = JSON.parse(inventoryBytes).candidates?.filter((entry) => entry.companySlug === company.slug && entry.platform === "instagram" && entry.observedUrl === profile.url && entry.intendedEntityType === "company" && entry.ownershipConfidence === "literal_company_footer_on_proven_official_domain");
  if (candidates?.length !== 1) throw new Error("An exact owned official footer candidate is required.");
  const candidate = candidates[0], source = candidate.source;
  const websiteBytes = await archived(source.path, source.sha256), w$ = cheerio.load(websiteBytes.toString());
  const literal = w$("footer a[href]").toArray().some((node) => instagramProfileKey(w$(node).attr("href")) === handle);
  if (!literal || !source.hostOwned || host(source.officialWebsite) !== domain || host(source.sourceUrl) !== domain || candidate.literalHref !== profile.url) throw new Error("Physical official company footer does not link the exact native account.");
  const archives = [{ path: artifactPath, sha256: artifactSha256, kind: "native_company_profile" }, { ...native.ownedSiteCandidateSource, kind: "official_owned_social_inventory" }, { path: source.path, sha256: source.sha256, kind: "official_company_footer" }];
  for (const redirect of source.homepageRedirectLineage ?? []) {
    if (host(redirect.requestedUrl) !== domain || host(redirect.finalUrl) !== domain) throw new Error("Official homepage redirect domain conflicts with the roster.");
    await archived(redirect.path, redirect.sha256);
    archives.push({ path: redirect.path, sha256: redirect.sha256, kind: "official_homepage_redirect" });
  }
  const officialWebsiteOutboundReceipt = { companySlug: company.slug, officialWebsite: company.websiteUrl, finalWebsiteUrl: source.sourceUrl, instagramUrl: profile.url, anchorText: candidate.anchorText, anchorHtml: candidate.anchorHtml, htmlSha256: source.sha256, observedAt: source.observedAt };
  if (!isOfficialInstagramOutboundReceipt(officialWebsiteOutboundReceipt, company, profile.url) || !(clock(source.observedAt) <= clock(profile.observedAt))) throw new Error("Official footer/native profile clock or ownership receipt conflicts.");
  return { handle, entityType: "company", profileUrl: profile.url, visibleWebsite: `https://${domain}`, visibleBio: profile.visibleText, review_state: "verified", observedAt: profile.observedAt, observationSource: artifactPath,
    officialWebsiteOutboundReceipt, nativeCompanyProfileReceipt: { source: "native_instagram_official_company_profile_v1", artifactPath, artifactSha256, companySlug: company.slug, handle, nativeOutboundHref: link.href, nativeOutboundTarget: outbound(link.href), nativeOutboundAnchorHtml: link.html, archives },
    verificationNotes: "The exact official company footer links this account. Its separately captured native profile header and literal outbound link point back to the exact roster website domain. All native/profile/footer/inventory/redirect archives are SHA-verified; post attribution still follows the actual native primary author." };
}

export async function verifyInstagramCompanyProfileArchive(proof, company) {
  const receipt = proof.nativeCompanyProfileReceipt;
  if (!receipt) return false;
  const expected = await buildInstagramCompanyProfileProof({ artifactPath: receipt.artifactPath, artifactSha256: receipt.artifactSha256, company });
  if (JSON.stringify(expected) !== JSON.stringify(proof)) throw new Error("Company identity differs from its physical native/official archives.");
  return true;
}
