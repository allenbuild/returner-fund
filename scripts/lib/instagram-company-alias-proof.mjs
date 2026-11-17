import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const domain = (value) => { try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; } };
const instagramProfile = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.instagram.com" && /^\/[a-z0-9_.]+\/$/i.test(url.pathname) && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
};
const outboundUrl = (value) => { try { const url = new URL(value); return url.hostname === "l.instagram.com" ? new URL(url.searchParams.get("u")).href : url.href; } catch { return null; } };

export function buildInstagramCompanyAliasIdentity({ artifactPath, artifactBytes, company, handle, primaryHandle }) {
  const native = JSON.parse(artifactBytes), profile = native.profile;
  const profileUrl = `https://www.instagram.com/${handle}/`;
  const officialDomain = domain(company.websiteUrl);
  const nativeCompanyLinks = (profile?.links ?? []).filter((link) => domain(outboundUrl(link.url)) === officialDomain).map(({ text, url }) => ({ text, url }));
  if (native.source?.batchSlug !== "F26" || native.companySlug !== company.slug || instagramProfile(profile?.url) !== profileUrl
    || !profile.text?.split("\n").some((line) => line.trim() === handle) || !Number.isFinite(Date.parse(profile.observedAt))
    || !officialDomain || !nativeCompanyLinks.length || !handle || handle === primaryHandle) throw new Error("Native company alias requires the exact profile, official-domain outbound link, and existing primary company account.");
  return {
    source: "native_instagram_exact_company_domain_alias_v1", batchSlug: "F26", companySlug: company.slug,
    entityId: `company-${company.slug}`, handle, primaryHandle, profileUrl, officialDomain,
    visibleBio: profile.text, observedAt: profile.observedAt, nativeCompanyLinks,
    artifactPath, artifactSha256: sha(artifactBytes)
  };
}

export async function verifyInstagramCompanyAliasArchive(proof, company, primaryHandle) {
  const identity = proof.nativeCompanyAliasIdentity;
  if (!identity || proof.entityType !== "company" || proof.companyAlias !== true || proof.profileUrl !== identity.profileUrl
    || proof.handle !== identity.handle || identity.primaryHandle !== primaryHandle) return false;
  const bytes = await readFile(identity.artifactPath);
  if (sha(bytes) !== identity.artifactSha256) throw new Error("Native company alias archive SHA changed.");
  const expected = buildInstagramCompanyAliasIdentity({ artifactPath: identity.artifactPath, artifactBytes: bytes, company, handle: proof.handle, primaryHandle });
  return JSON.stringify(expected) === JSON.stringify(identity);
}
