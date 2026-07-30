/**
 * Decide whether an Instagram profile discovered through an official company
 * surface has enough identity evidence to be promoted into the company-owned
 * account catalog.
 *
 * A link being the only Instagram URL on an official site is useful discovery
 * evidence, but it is not owner proof: company sites routinely link founder
 * profiles. Promotion therefore requires an exact catalog/snapshot mapping or
 * one uniquely strong company-identity handle match, and any founder-like or
 * explicitly rejected identity fails closed.
 */
export function officialCompanyInstagramIdentityDecision({
  explicitlyRejected = false,
  snapshotVerified = false,
  uniquelyStrongCompanyHandle = false,
  founderLikeHandle = false
} = {}) {
  if (explicitlyRejected) {
    return { reviewState: "needs_review", reason: "explicitly_rejected" };
  }
  if (founderLikeHandle) {
    return { reviewState: "needs_review", reason: "founder_like_handle" };
  }
  if (snapshotVerified) {
    return { reviewState: "verified", reason: "snapshot_verified" };
  }
  if (uniquelyStrongCompanyHandle) {
    return { reviewState: "verified", reason: "unique_strong_company_handle" };
  }
  return { reviewState: "needs_review", reason: "insufficient_company_owner_proof" };
}
