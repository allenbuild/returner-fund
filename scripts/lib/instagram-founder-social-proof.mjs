import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function account(value) {
  try {
    let url = new URL(value);
    if (url.hostname === "l.instagram.com") url = new URL(url.searchParams.get("u"));
    const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^twitter\.com$/, "x.com");
    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) return null;
    if (host === "x.com" && /^\/[a-z0-9_]{1,15}$/.test(path) || host === "linkedin.com" && /^\/in\/[^/]+$/.test(path) || host === "instagram.com" && /^\/[a-z0-9_.]+$/.test(path)) return `https://${host}${path}`;
    return null;
  } catch { return null; }
}

export function buildInstagramFounderSocialIdentity({ artifactPath, artifactBytes, company, founder, handle, companyHandle }) {
  const native = JSON.parse(artifactBytes);
  const identity = {
    source: "native_instagram_exact_roster_social_outbound_v1", batchSlug: "F26",
    companySlug: company.slug, companyHandle, founderId: String(founder.id), founderName: founder.name,
    entityId: `founder-${company.slug}-${slug(founder.name)}-${founder.id}`,
    profileUrl: native.profile?.url, visibleBio: native.profile?.text,
    observedAt: native.profile?.observedAt, nativeOutboundLinks: (native.outboundDialog?.links ?? []).map(({ url, text }) => ({ url, text })),
    matchedCanonicalAccounts: { x: account(founder.socialLinks.x), linkedin: account(founder.socialLinks.linkedin) },
    artifactPath, artifactSha256: sha(artifactBytes)
  };
  const proof = { entityType: "founder", entityId: identity.entityId, founderId: String(founder.id), founderName: founder.name, handle, profileUrl: `https://www.instagram.com/${handle}/`, companyAccountMention: companyHandle, nativeFounderSocialIdentity: identity };
  if (!isVerifiedInstagramFounderSocialIdentity(proof, { entityId: identity.entityId, companySlug: company.slug, founderName: founder.name, socialAccounts: founder.socialLinks })) throw new Error("Native founder outbound links do not match both official roster accounts.");
  return identity;
}

export function isVerifiedInstagramFounderSocialIdentity(proof, entity) {
  const identity = proof?.nativeFounderSocialIdentity;
  if (identity?.source !== "native_instagram_exact_roster_social_outbound_v1" || identity.batchSlug !== "F26" || proof.entityType !== "founder"
    || identity.entityId !== entity?.entityId || identity.companySlug !== entity.companySlug || identity.founderName !== entity.founderName
    || identity.founderName !== proof.founderName || identity.founderId !== String(proof.founderId)
    || proof.companyAccountMention !== identity.companyHandle || account(identity.profileUrl) !== account(proof.profileUrl)
    || account(proof.profileUrl) !== `https://instagram.com/${proof.handle}`
    || !identity.visibleBio?.split("\n").some((line) => line.trim() === proof.handle)
    || !identity.visibleBio?.includes(`@${identity.companyHandle}`) || !Number.isFinite(Date.parse(identity.observedAt))
    || !/^[a-f0-9]{64}$/.test(identity.artifactSha256 ?? "")) return false;
  for (const platform of ["x", "linkedin"]) {
    const expected = identity.matchedCanonicalAccounts?.[platform];
    const canonical = entity.socialAccounts?.[platform];
    const known = (Array.isArray(canonical) ? canonical : [canonical]).map(account).filter(Boolean);
    if (!expected || !known.includes(expected) || !identity.nativeOutboundLinks?.some((link) => account(link.url) === expected)) return false;
  }
  return true;
}

export async function verifyInstagramFounderSocialIdentityArchive(proof, company, founder) {
  if (!proof.nativeFounderSocialIdentity || !founder) return false;
  const identity = proof.nativeFounderSocialIdentity;
  const bytes = await readFile(identity.artifactPath);
  if (sha(bytes) !== identity.artifactSha256) throw new Error("Native founder identity archive SHA changed.");
  const expected = buildInstagramFounderSocialIdentity({ artifactPath: identity.artifactPath, artifactBytes: bytes, company, founder, handle: proof.handle, companyHandle: proof.companyAccountMention });
  return JSON.stringify(expected) === JSON.stringify(identity);
}
