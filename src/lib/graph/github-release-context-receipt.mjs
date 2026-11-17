import { createHash } from "node:crypto";

export const NATIVE_GITHUB_RELEASE_SOURCE = "official_snapshot_native_github_release_v1";
export const NATIVE_GITHUB_RELEASE_VALIDATION = "fall_2026_native_github_release_ingestion_v1";
export const githubReleaseSha256 = (value) => createHash("sha256").update(value).digest("hex");
const shaPattern = /^[a-f0-9]{64}$/;
const reviewOwners = new Set(["agent-relay", "useterse", "limnion"]);
export const NATIVE_GITHUB_REVIEWED_REPOSITORIES = Object.freeze({
  "agentworkforce/relay": Object.freeze({ companySlug: "agent-relay", nativeLaunchId: 124128, ownershipClaims: Object.freeze(["Agent Relay is [open source]"]) }),
  "terseai/durable-actors": Object.freeze({ companySlug: "useterse", nativeLaunchId: 125318, ownershipClaims: Object.freeze(["we are announcing our first product: Durable Actors"]) }),
  "siglake/siglake": Object.freeze({ companySlug: "limnion", nativeLaunchId: 125687, ownershipClaims: Object.freeze(["Our open-source foundation, Siglake", "the open core of the platform we’re building at Limnion"]) })
});
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const own = (o, key) => Object.prototype.hasOwnProperty.call(o ?? {}, key);
const object = (o) => o && typeof o === "object" && !Array.isArray(o);
function verifyNativeGithubRepositoryOwnershipProof(proof) {
  if (!object(proof) || proof.source !== "official_yc_launch_repository_ownership_v1") return false;
  const reviewed = NATIVE_GITHUB_REVIEWED_REPOSITORIES[String(proof.repositoryFullName ?? "").toLowerCase()], launch = proof.nativeLaunch;
  if (!reviewed || proof.companySlug !== reviewed.companySlug || proof.entityId !== `company-${reviewed.companySlug}` || typeof proof.companyName !== "string" || !proof.companyName || proof.officialYcCompanyUrl !== `https://www.ycombinator.com/companies/${reviewed.companySlug}` || typeof proof.repositoryUrl !== "string" || proof.repositoryUrl.toLowerCase() !== `https://github.com/${proof.repositoryFullName}`.toLowerCase()) return false;
  if (!object(launch) || launch.id !== reviewed.nativeLaunchId || launch.state !== "public" || typeof launch.body !== "string" || launch.bodySha256 !== githubReleaseSha256(launch.body) || !Array.isArray(launch.repositoryLinkParagraphs) || !launch.repositoryLinkParagraphs.length || !Array.isArray(launch.ownershipClaimParagraphs) || !launch.ownershipClaimParagraphs.length) return false;
  const nativeParagraphs = launch.body.split("\n\n");
  if (launch.repositoryLinkParagraphs.some((paragraph) => !nativeParagraphs.includes(paragraph) || !paragraph.toLowerCase().includes(proof.repositoryUrl.toLowerCase())) || launch.ownershipClaimParagraphs.some((paragraph) => !nativeParagraphs.includes(paragraph)) || reviewed.ownershipClaims.some((claim) => !launch.ownershipClaimParagraphs.some((paragraph) => paragraph.toLowerCase().includes(claim.toLowerCase())))) return false;
  try { const url = new URL(launch.url); if (url.origin !== "https://www.ycombinator.com" || !url.pathname.startsWith("/launches/") || url.search || url.hash) return false; } catch { return false; }
  const published = Date.parse(launch.postedAt ?? ""), observed = Date.parse(proof.observedAt ?? "");
  if (!Number.isFinite(published) || !Number.isFinite(observed) || published > observed) return false;
  if (![proof.sourceArchiveSha256, proof.proofAuditSha256].every((hash) => shaPattern.test(hash ?? "")) || typeof proof.sourceArchivePath !== "string" || typeof proof.proofAuditPath !== "string") return false;
  const { validation, ...content } = proof;
  return validation?.source === "fall_2026_yc_launch_repository_ownership_ingestion_v1" && validation.archiveHashesVerified === true && validation.nativeLaunchFieldsVerified === true && validation.sourceArchiveSha256 === proof.sourceArchiveSha256 && validation.proofAuditSha256 === proof.proofAuditSha256 && validation.proofContentSha256 === githubReleaseSha256(JSON.stringify(content));
}
export function isVerifiedNativeGithubRepositoryOwnershipProof(proof) {
  try { return verifyNativeGithubRepositoryOwnershipProof(proof); } catch { return false; }
}
function releaseOwnershipProofMatches(row) {
  const proof = row?.officialRepositoryOwnershipProof;
  return isVerifiedNativeGithubRepositoryOwnershipProof(proof) && proof.companySlug === row.companySlug && proof.companyName === row.companyName && proof.entityId === row.entityId && proof.repositoryFullName.toLowerCase() === row.repositoryFullName?.toLowerCase() && proof.repositoryUrl.toLowerCase() === row.repositoryUrl?.toLowerCase();
}
export function nativeGithubReleaseReceipt(row) {
  try { return typeof row?.rawVisibleText === "string" ? JSON.parse(row.rawVisibleText) : row?.rawVisibleText; } catch { return null; }
}
export function githubReleaseNativeFields(row) {
  return {
    id: row.nativeReleaseId, body: row.nativeBody, name: own(row, "nativeTitle") ? row.nativeTitle : row.title,
    tag_name: row.tag, html_url: row.sourceUrl, published_at: row.postedAt,
    author: row.nativeAuthor, draft: row.nativeDraft, prerelease: row.nativePrerelease
  };
}
export function nativeGithubReleaseOwnerNeedsReview(row) {
  return reviewOwners.has(row?.companySlug) || row?.officialRepositoryLineage?.owners?.some((entry) => reviewOwners.has(entry?.ownerSnapshot?.companySlug)) === true;
}

/** Pure structural preflight; physical native JSON verification belongs to ingestion. */
export function nativeGithubReleaseContextReasons(row, snapshot) {
  if (!object(row) || !object(snapshot) || !Array.isArray(snapshot.accounts)) return ["invalid_release_or_snapshot"];
  const reasons = [], raw = nativeGithubReleaseReceipt(row), lineage = row.officialRepositoryLineage;
  if (row.batchSlug !== "F26" || row.platform !== "github" || row.entityType !== "company" || row.entityId !== `company-${row.companySlug}`) reasons.push("unresolved_explicit_fall_release_owner");
  if (row.platformObjectId !== undefined) reasons.push("release_must_not_use_repository_platform_object_id");
  if (!Number.isSafeInteger(row.nativeReleaseId) || row.nativeReleaseId <= 0 || row.platformPostId !== String(row.nativeReleaseId)) reasons.push("invalid_immutable_native_release_id");
  if (row.contributionScore !== 0 || !object(row.metrics) || Object.keys(row.metrics).length || (row.tractionStatus !== undefined && row.tractionStatus !== "unscored")) reasons.push("release_context_must_have_zero_score_and_no_metrics");
  const nativeBody = row.nativeBody;
  if (nativeBody !== null && typeof nativeBody !== "string") reasons.push("invalid_native_release_body");
  if (typeof row.text !== "string" || row.text !== (nativeBody ?? "") || (own(row, "originalText") && row.originalText !== row.text)) reasons.push("release_native_body_conflict");
  if (own(row, "captionAbsent") && row.captionAbsent !== (row.text.length === 0)) reasons.push("release_caption_absent_conflict");
  if (!raw || raw.source !== NATIVE_GITHUB_RELEASE_SOURCE || raw.repositoryFullName !== row.repositoryFullName || !equal(raw.officialRepositoryLineage, lineage)) reasons.push("release_receipt_lineage_conflict");
  if (row.officialRepositoryOwnershipProof !== undefined && (!releaseOwnershipProofMatches(row) || !equal(raw?.officialRepositoryOwnershipProof, row.officialRepositoryOwnershipProof))) reasons.push("invalid_exact_repository_ownership_proof");
  const expectedPost = { platformPostId: row.platformPostId, sourceUrl: row.sourceUrl, title: own(row, "nativeTitle") ? row.nativeTitle : row.title, tag: row.tag, text: row.text, published_at: row.postedAt, author: row.nativeAuthor };
  if (!raw || !equal(raw.post, expectedPost)) reasons.push("release_receipt_native_fields_conflict");
  if (!lineage || typeof lineage.snapshotPath !== "string" || !shaPattern.test(lineage.snapshotSha256 ?? "") || !Array.isArray(lineage.owners) || !lineage.owners.length) reasons.push("missing_official_repository_snapshot_lineage");
  else {
    let matchingOwner = false;
    for (const entry of lineage.owners) {
      const account = snapshot.accounts[entry.snapshotAccountIndex], repo = account?.repos?.[entry.snapshotRepositoryIndex];
      const expectedOwner = account && Object.fromEntries(Object.entries(account).filter(([key]) => !["repos", "aggregate"].includes(key)));
      if (!account || !repo || !equal(entry.ownerSnapshot, expectedOwner) || !equal(entry.repositorySnapshot, repo) || repo.fullName?.toLowerCase() !== row.repositoryFullName?.toLowerCase() || repo.htmlUrl?.toLowerCase() !== row.repositoryUrl?.toLowerCase()) reasons.push("release_snapshot_owner_or_repository_conflict");
      if (account?.entityType === row.entityType && account?.entityId === row.entityId && account?.companySlug === row.companySlug && account?.companyName === row.companyName) matchingOwner = true;
    }
    if (!matchingOwner) reasons.push("release_assigned_to_wrong_snapshot_owner");
  }
  try {
    const repo = new URL(row.repositoryUrl), url = new URL(row.sourceUrl), api = new URL(row.nativeCollectionRequestUrl);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(row.repositoryFullName ?? "") || repo.href.toLowerCase() !== `https://github.com/${row.repositoryFullName}`.toLowerCase() || url.origin !== "https://github.com" || !url.pathname.toLowerCase().startsWith(`/${row.repositoryFullName}/releases/tag/`.toLowerCase()) || url.search || url.hash) reasons.push("invalid_native_release_url");
    if (api.origin !== "https://api.github.com" || api.pathname.toLowerCase() !== `/repos/${row.repositoryFullName}/releases`.toLowerCase() || [...api.searchParams.keys()].some((key) => !["per_page", "page"].includes(key)) || !/^(?:[1-9]\d?|100)$/.test(api.searchParams.get("per_page") ?? "")) reasons.push("invalid_native_release_collection_url");
  } catch { reasons.push("invalid_native_release_url"); }
  if (!shaPattern.test(row.nativeCollectionArchiveSha256 ?? "") || raw?.nativeCollectionArchivePath !== row.nativeCollectionArchivePath || raw?.nativeCollectionArchiveSha256 !== row.nativeCollectionArchiveSha256) reasons.push("missing_native_release_page_hash_receipt");
  const published = Date.parse(row.postedAt ?? ""), observed = Date.parse(row.observedAt ?? "");
  if (typeof row.postedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(row.postedAt) || !Number.isFinite(published) || !Number.isFinite(observed) || published > observed || row.nativePublishedAtLiteral !== row.postedAt) reasons.push("invalid_future_or_conflicting_native_release_publication");
  if (row.nativeDraft !== false) reasons.push("native_release_draft_not_published");
  if (!object(row.nativeAuthor) || row.authorName !== row.nativeAuthor.login || row.nativeAuthorUrl !== row.nativeAuthor.html_url) reasons.push("native_release_author_conflict");
  return [...new Set(reasons)];
}

/** No I/O: checks an ingestion validation receipt against the imported snapshot and current body. */
function verifyNativeGithubReleaseContext(row, snapshot, pinnedSnapshotContentSha256) {
  if (nativeGithubReleaseContextReasons(row, snapshot).length || (nativeGithubReleaseOwnerNeedsReview(row) && !releaseOwnershipProofMatches(row))) return false;
  if (row.review_state !== "verified" || row.attributionStatus !== "verified" || row.attributionMode !== "publisher" || row.attributionProvenance !== NATIVE_GITHUB_RELEASE_SOURCE || row.tractionStatus !== "unscored" || typeof row.originalText !== "string" || row.captionAbsent !== (row.originalText.length === 0)) return false;
  const validation = nativeGithubReleaseReceipt(row)?.validation;
  if (nativeGithubReleaseOwnerNeedsReview(row) && (validation?.ownershipProofVerified !== true || validation.ownershipProofSha256 !== githubReleaseSha256(JSON.stringify(row.officialRepositoryOwnershipProof)))) return false;
  return validation?.source === NATIVE_GITHUB_RELEASE_VALIDATION && validation.archiveHashesVerified === true && validation.nativeResponseFieldsVerified === true &&
    validation.nativeCollectionArchiveSha256 === row.nativeCollectionArchiveSha256 && validation.upstreamSnapshotSha256 === row.officialRepositoryLineage.snapshotSha256 &&
    validation.upstreamSnapshotContentSha256 === (pinnedSnapshotContentSha256 ?? githubReleaseSha256(JSON.stringify(snapshot))) &&
    validation.originalBodySha256 === githubReleaseSha256(row.originalText) && validation.nativeFieldsSha256 === githubReleaseSha256(JSON.stringify(githubReleaseNativeFields(row)));
}

export function isVerifiedNativeGithubReleaseContext(row, snapshot) {
  try { return verifyNativeGithubReleaseContext(row, snapshot); } catch { return false; }
}

/** Pin a private immutable JSON snapshot and its hash once for bulk admission. */
export function createNativeGithubReleaseContextVerifier(snapshot) {
  const encoded = JSON.stringify(snapshot), pinned = JSON.parse(encoded);
  const freeze = (value) => {
    if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
    return value;
  };
  freeze(pinned);
  const contentSha256 = githubReleaseSha256(encoded);
  return (row) => { try { return verifyNativeGithubReleaseContext(row, pinned, contentSha256); } catch { return false; } };
}
