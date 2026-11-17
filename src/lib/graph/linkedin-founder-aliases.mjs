import { createHash } from "node:crypto";

export function canonicalLinkedInFounderProfile(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !/(?:^|\.)linkedin\.com$/.test(url.hostname) || url.username || url.password || url.port || url.hash || url.search) return null;
    const handle = url.pathname.match(/^\/in\/([^/]+)\/?$/i)?.[1];
    return handle ? `https://www.linkedin.com/in/${handle.toLowerCase()}/` : null;
  } catch { return null; }
}

/** Only aliases in the physically reviewed Fall registry extend the roster.
 * A post receipt cannot register its own author alias. */
export function verifiedFallLinkedInFounderAccounts(company, founder, registry) {
  const official = canonicalLinkedInFounderProfile(founder?.socialLinks?.linkedin);
  const accounts = official ? [founder.socialLinks.linkedin] : [];
  for (const proof of registry?.proofs ?? []) {
    if (proof.source !== "fall_2026_linkedin_founder_alias_v1" || proof.batchSlug !== "F26" || proof.companySlug !== company?.slug || proof.founderId !== String(founder?.id) || proof.founderName !== founder?.name || canonicalLinkedInFounderProfile(proof.officialProfileUrl) !== official || !canonicalLinkedInFounderProfile(proof.profileUrl) || !["native_official_profile_redirect", "official_homepage_founder_link_and_native_profile"].includes(proof.method)) continue;
    const { validation, ...content } = proof;
    const digest = createHash("sha256").update(JSON.stringify(content)).digest("hex");
    if (validation?.source !== "fall_2026_linkedin_founder_alias_ingestion_v1" || validation.archiveHashesVerified !== true || validation.contentSha256 !== digest || !proof.archives?.length || proof.archives.some((archive) => !/^[a-f0-9]{64}$/.test(archive.sha256) || !archive.path)) continue;
    accounts.push(proof.profileUrl);
  }
  return [...new Set(accounts)];
}
