import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const normalized = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const profileHandle = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /^(?:www\.)?instagram\.com$/.test(url.hostname) && !url.username && !url.password && !url.port && !url.search && !url.hash && /^\/[A-Za-z0-9_.]+\/?$/.test(url.pathname)
      ? url.pathname.replace(/^\/|\/$/g, "").toLowerCase() : null;
  } catch { return null; }
};
const linkedDomain = (value) => {
  try {
    let url = new URL(value);
    if (url.hostname === "l.instagram.com") url = new URL(url.searchParams.get("u"));
    return /^https?:$/.test(url.protocol) && !url.username && !url.password && !url.port ? url.hostname.replace(/^www\./, "").toLowerCase() : null;
  } catch { return null; }
};

/** This extra receipt validates a manually reviewed founder mapping; it never discovers one. */
export function matchesInstagramFounderNamingArchive(proof, company, founder, native) {
  const receipt = proof.nativeFounderNamingReceipt;
  if (!receipt || receipt.source !== "native_instagram_founder_name_link_plus_official_domain_v1" || !founder || proof.entityType !== "founder" || proof.review_state !== "verified"
    || proof.founderId !== String(founder.id) || proof.founderName !== founder.name || receipt.officialYcCompanyUrl !== company.ycProfileUrl || receipt.officialYcFounderUrl !== founder.ycProfileUrl
    || profileHandle(native.profile?.url) !== proof.handle || profileHandle(proof.profileUrl) !== proof.handle
    || !native.profile.text.split("\n").some((line) => line.trim() === proof.handle) || !native.profile.text.includes(`@${proof.companyAccountMention}`)
    || native.source?.batchSlug !== "F26" || native.source.collectionMethod !== "authorized_native_instagram_dom_v1"
    || !Number.isFinite(Date.parse(native.profile.observedAt)) || !Number.isFinite(Date.parse(native.source.exportedAt))
    || Date.parse(native.profile.observedAt) > Date.parse(native.source.exportedAt)) return false;
  const naming = native.founderNamingPost;
  let postUrl;
  try { postUrl = new URL(naming.url); } catch { return false; }
  if (!/^(?:www\.)?instagram\.com$/.test(postUrl.hostname) || !new RegExp(`^/(?:[A-Za-z0-9_.]+/)?p/${receipt.nativePostId}/?$`).test(postUrl.pathname) || receipt.nativePostUrl !== naming.url) return false;
  const declaration = receipt.exactFounderDeclaration;
  if (!/^FOUNDERS?:\s/.test(declaration) || !declaration.includes(`${founder.name} (@${receipt.nativeFounderAnchor?.text?.replace(/^@/, "")})`)
    || !normalized(naming.visibleText).includes(declaration)) return false;
  const anchor = receipt.nativeFounderAnchor;
  if (profileHandle(anchor?.href) !== proof.handle || anchor?.text?.toLowerCase() !== `@${proof.handle}`
    || !anchor.html?.includes(anchor.href.replace("https://www.instagram.com", "")) || !anchor.html.includes(anchor.text)
    || !naming.links?.some((link) => JSON.stringify(link) === JSON.stringify(anchor)) || !naming.mainHtml?.includes(anchor.html)) return false;
  const website = receipt.nativeCompanyWebsiteAnchor;
  const domain = linkedDomain(company.websiteUrl);
  return linkedDomain(proof.visibleWebsite?.includes("://") ? proof.visibleWebsite : `https://${proof.visibleWebsite}`) === domain
    && linkedDomain(website?.url) === domain && native.profile.links?.some((link) => JSON.stringify(link) === JSON.stringify(website))
    && native.profile.mainHtml?.includes(website.html);
}

export async function verifyInstagramFounderNamingArchive(proof, company, founder) {
  if (!proof.nativeFounderNamingReceipt) return false;
  const receipt = proof.nativeFounderNamingReceipt;
  const bytes = await readFile(receipt.artifactPath);
  if (sha(bytes) !== receipt.artifactSha256) throw new Error("Native founder naming archive SHA changed.");
  if (!matchesInstagramFounderNamingArchive(proof, company, founder, JSON.parse(bytes))) throw new Error("Native founder naming/profile/domain proof does not match the exact roster owner.");
  return true;
}
