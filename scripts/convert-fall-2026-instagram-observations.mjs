import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isVerifiedInstagramNativeCaption, normalizeInstagramNativeObservation } from "./lib/instagram-native-observation.mjs";
import { isOfficialInstagramOutboundReceipt } from "./lib/instagram-official-outbound-proof.mjs";
import { isVerifiedInstagramCaptionAbsence } from "./lib/instagram-caption-absence-proof.mjs";
import { verifyInstagramFounderSocialIdentityArchive } from "./lib/instagram-founder-social-proof.mjs";
import { verifyInstagramCompanyAliasArchive } from "./lib/instagram-company-alias-proof.mjs";
import { verifyInstagramFounderNamingArchive } from "./lib/instagram-founder-naming-proof.mjs";
import { verifyInstagramFounderTeamIdentityArchive } from "./lib/instagram-founder-team-proof.mjs";
import { verifyInstagramCompanyProfileArchive } from "./lib/instagram-company-profile-proof.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const values = (name) => args.filter((arg) => arg.startsWith(`${name}=`)).map((arg) => arg.slice(name.length + 1));
const readJson = async (name) => JSON.parse(await readFile(resolve(root, name), "utf8"));
const inputs = values("--input");
if (!inputs.length) throw new Error("Pass at least one --input= native Instagram observation artifact.");
const proofPath = values("--identity-proofs")[0] ?? "outputs/fall-2026/instagram-vexo-identity-proofs.json";
const outputPath = values("--output")[0] ?? "outputs/fall-2026/instagram-vexo-importable.json";
const captionDecisionsPath = values("--caption-decisions")[0] ?? "outputs/fall-2026/instagram-caption-absence-decisions.json";
const captionDecisions = await readJson(captionDecisionsPath).catch((error) => {
  if (error.code === "ENOENT") return { posts: [] };
  throw error;
});
const roster = await readJson("src/lib/yc/fall-2026-companies.json");
const proofs = await readJson(proofPath);
// Match the existing YC graph/importer founder ID convention exactly. Accent
// transliteration here would create a second entity for an existing founder.
const slugify = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const accounts = new Map();
for (const group of proofs.companies ?? [proofs]) {
const company = roster.companies.find((entry) => entry.slug === group.companySlug);
if (!company || group.batchSlug !== "F26") throw new Error("Identity proofs must resolve to an exact F26 company.");
const officialDomain = new URL(company.websiteUrl).hostname.replace(/^www\./, "").toLowerCase();
for (const proof of group.accounts) {
  if (proof.review_state !== "verified") continue;
  const url = new URL(proof.profileUrl);
  const handle = url.pathname.replace(/^\/|\/$/g, "");
  const linkedDomain = proof.visibleWebsite ? new URL(proof.visibleWebsite.includes("://") ? proof.visibleWebsite : `https://${proof.visibleWebsite}`).hostname.replace(/^www\./, "").toLowerCase() : null;
  const hasOfficialOutboundProof = isOfficialInstagramOutboundReceipt(proof.officialWebsiteOutboundReceipt, company, proof.profileUrl);
  const founder = proof.entityType === "founder" ? company.founders.find((entry) => String(entry.id) === String(proof.founderId) && entry.name === proof.founderName) : null;
  const hasFounderSocialProof = await verifyInstagramFounderSocialIdentityArchive(proof, company, founder);
  await verifyInstagramFounderNamingArchive(proof, company, founder);
  const hasCompanyAliasProof = await verifyInstagramCompanyAliasArchive(proof, company, group.companyHandle);
  await verifyInstagramCompanyProfileArchive(proof, company);
  const hasFounderTeamProof = await verifyInstagramFounderTeamIdentityArchive(proof, company, founder, group.accounts.find((account) => account.entityType === "company"));
  if (url.hostname !== "www.instagram.com" || handle !== proof.handle || (linkedDomain !== officialDomain && !hasOfficialOutboundProof && !hasFounderSocialProof && !hasFounderTeamProof)) {
    throw new Error(`Unproven exact Instagram account/domain identity: ${proof.handle}`);
  }
  let entityId = `company-${company.slug}`;
  let entityName = company.name;
  if (proof.entityType === "founder") {
    if (!founder || proof.companyAccountMention !== group.companyHandle) throw new Error(`Unresolved founder identity: ${proof.handle}`);
    entityId = `founder-${company.slug}-${slugify(founder.name)}-${founder.id}`;
    entityName = founder.name;
  } else if (proof.entityType !== "company" || (proof.handle !== group.companyHandle && !hasCompanyAliasProof)) {
    throw new Error(`Unsupported account owner: ${proof.handle}`);
  }
  if (accounts.has(proof.handle.toLowerCase())) throw new Error(`Duplicate Instagram owner proof: ${proof.handle}`);
  accounts.set(proof.handle.toLowerCase(), { ...proof, companySlug: company.slug, companyName: company.name, entityId, entityName });
}
}

const observedById = new Map();
for (const input of inputs) {
  const artifact = await readJson(input);
  for (const saved of artifact.observations ?? artifact.nativePosts ?? []) {
    const original = normalizeInstagramNativeObservation(saved);
    const suppliedUrl = String(original.url ?? original.sourceUrl ?? "");
    const native = suppliedUrl.match(/\/(reel|p)\/([A-Za-z0-9_-]+)(?:\/|$)/);
    const row = {
      ...original,
      id: original.id ?? native?.[2],
      kind: original.kind ?? native?.[1]
    };
    if (!row.id) throw new Error(`Native Instagram observation has no shortcode: ${input}`);
    const previous = observedById.get(row.id);
    if (!previous || Date.parse(row.observedAt) > Date.parse(previous.row.observedAt)) observedById.set(row.id, { row, input, source: artifact.source });
  }
}
const evidence = [];
const needsReview = [];
for (const { row, input, source } of observedById.values()) {
  const owner = accounts.get(String(row.authorHandle).toLowerCase());
  const nativeId = String(row.id ?? "");
  const sourceUrl = `https://www.instagram.com/${row.kind === "reel" ? "reel" : "p"}/${nativeId}/`;
  const publishedMs = Date.parse(row.postedAt ?? "");
  const observedMs = Date.parse(row.observedAt ?? "");
  const reasons = [];
  const captionAbsenceProof = captionDecisions.posts.find((proof) => proof.platformPostId === nativeId);
  const captionAbsent = isVerifiedInstagramCaptionAbsence(row, captionAbsenceProof, row.authorHandle, nativeId);
  if (!/^[A-Za-z0-9_-]+$/.test(nativeId)) reasons.push("invalid_native_shortcode");
  if (!owner) reasons.push("native_author_identity_not_yet_confirmed");
  if (row.attributionDisposition === "third_party_subject_context") reasons.push("third_party_subject_context_is_not_founder_authorship");
  if (row.controls && !row.captionConfirmedVisible && !captionAbsent) reasons.push("caption_not_confirmed_in_native_detail_dom");
  if (/^\s*[\d,.]+(?:\s*[KMB])?(?:\s*(?:views|plays))?\s*$/i.test(String(row.text ?? "")) && !isVerifiedInstagramNativeCaption(row, row.authorHandle)) reasons.push("numeric_only_listing_counter_is_not_a_verified_caption");
  if (!Number.isFinite(publishedMs) || !Number.isFinite(observedMs) || publishedMs > observedMs) reasons.push("missing_or_future_native_publication_timestamp");
  const metrics = Object.fromEntries(Object.entries(row.metrics ?? {}).filter(([key, value]) =>
    ["views", "likes", "comments", "shares", "saves"].includes(key) && typeof value === "number" && Number.isFinite(value) && value >= 0
  ));
  if (reasons.length) {
    needsReview.push({ platform: "instagram", platformPostId: nativeId, sourceUrl, authorHandle: row.authorHandle, reasons, originalObservation: row, input });
    continue;
  }
  const mediaUrls = [...new Set([
    ...(row.media?.images ?? []).map((item) => item.src),
    ...(row.media?.videos ?? []).flatMap((item) => [item.src, item.poster])
  ].filter((url) => typeof url === "string" && /^https?:\/\//.test(url)))];
  evidence.push({
    id: `instagram-f26-${owner.entityId}-${nativeId}`,
    batchSlug: "F26", companySlug: owner.companySlug, companyName: owner.companyName,
    entityType: owner.entityType, entityId: owner.entityId, entityName: owner.entityName,
    platform: "instagram", platformPostId: nativeId, sourceUrl,
    accountUrl: owner.profileUrl, authorHandle: owner.handle, authorName: owner.entityName,
    title: row.text.split("\n")[0] || `${owner.entityName} Instagram post`,
    text: row.text, originalText: row.text, postedAt: row.postedAt, publishedAtPrecision: "exact",
    ...(captionAbsent ? { captionAbsent: true, contributionScore: 0, tractionStatus: "unscored" } : {}),
    observedAt: row.observedAt, first_seen_at: row.observedAt, last_checked_at: row.observedAt, last_updated_at: row.postedAt,
    mediaType: row.kind === "reel" || row.media?.videos?.length ? "video" : "image", metrics,
    ...(mediaUrls.length ? { mediaUrls } : {}),
    review_state: "verified", linkStatus: "verified", linkCheckedAt: row.observedAt,
    attributionVersion: 3, attributionStatus: "verified", attributionMode: "account_owner",
    attributionProvenance: "authorized_native_instagram_dom_v1", attributionSignals: ["mapped_official_account", "exact_native_author"],
    matchReason: `Native Instagram detail DOM proves @${owner.handle} as the author; the account identity is confirmed by the exact official company domain or its literal outbound Instagram link and roster owner. Appearance on a company collaborator grid does not change authorship.`,
    rawVisibleText: JSON.stringify({
      source: "authorized_native_instagram_dom_v1", identityProof: owner,
      profile: { username: owner.handle, name: owner.entityName, url: owner.profileUrl, batchSlug: "F26" },
      post: { ...row, shortcode: nativeId, authorName: owner.entityName, authorHandle: owner.handle, url: sourceUrl, ...(captionAbsent ? { captionAbsent: true, captionAbsenceProof } : {}) },
      metrics, observationSource: input, listingProfileUrl: source?.profileUrl ?? null,
      collaborationSourceIsNotAuthorship: true
    })
  });
}
const summary = {
  batchSlug: "F26", companySlugs: [...new Set([...accounts.values()].map((account) => account.companySlug))], inputs, identityProofs: proofPath,
  receivedUniqueNativePosts: observedById.size, accepted: evidence.length, pendingOrRejected: needsReview.length,
  companyAuthored: evidence.filter((row) => row.entityType === "company").length,
  founderAuthored: evidence.filter((row) => row.entityType === "founder").length,
  historyCoverage: "Only the enumerated native detail observations are represented. Founder account history coverage is reported separately from the company collaborator grid."
};
await writeFile(resolve(root, outputPath), `${JSON.stringify({ source: summary, evidence, needsReview }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary)}\n`);
