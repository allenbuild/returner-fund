export function linkedinIdentity(value) {
  if (!value) return null;
  try {
    const url = new URL(value.replace(/^http:/, "https:"));
    if (url.hostname.replace(/^www\./, "").toLowerCase() !== "linkedin.com") return null;
    return url.pathname.toLowerCase().match(/^\/(company|in)\/([^/]+)/)?.[0] ?? null;
  } catch {
    return null;
  }
}

export function resolveLinkedInNativeAuthor(company, row, receipt) {
  // The outer embed author is distinct from quoted authors and company-grid membership.
  const primary = receipt?.captured?.preview?.links?.find((link) => {
    try {
      return new URL(link.href).searchParams.get("trk") === "public_post_embed_feed-actor-name";
    } catch {
      return false;
    }
  });
  const companyContext = {
    entityId: `company-${company.slug}`, name: company.name,
    profileUrl: company.socialLinks.linkedin
  };
  const primaryIdentity = linkedinIdentity(primary?.href);
  if (primaryIdentity?.startsWith("/in/")) {
    const founder = company.founders.find((candidate) =>
      linkedinIdentity(candidate.socialLinks.linkedin) === primaryIdentity
    );
    if (!founder) return { status: "needs_review", reason: "native_personal_author_not_verified_in_company_roster", primary };
    const slug = founder.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return {
      status: "verified", entityType: "founder",
      entityId: `founder-${company.slug}-${slug}-${founder.id}`,
      authorName: founder.name, accountUrl: founder.socialLinks.linkedin,
      identitySourceUrl: founder.ycProfileUrl,
      kind: "coauthored_founder_post", primary, companyContext,
      signal: "native_primary_author_matches_official_yc_founder"
    };
  }
  if (primaryIdentity) {
    const companyIdentities = [company.socialLinks.linkedin, receipt?.profile?.resolvedProfileUrl]
      .map(linkedinIdentity).filter(Boolean);
    if (!companyIdentities.includes(primaryIdentity)) {
      return { status: "needs_review", reason: "native_company_author_does_not_match_verified_company_identity", primary };
    }
  } else if (/coauthored/.test(row.kind ?? "") || row.dateLabel?.startsWith("with ")) {
    return { status: "needs_review", reason: "collaboration_primary_author_receipt_missing" };
  }
  return {
    status: "verified", entityType: "company", entityId: `company-${company.slug}`,
    authorName: primary?.text?.trim() || row.authorName,
    accountUrl: company.socialLinks.linkedin, identitySourceUrl: company.ycProfileUrl,
    kind: row.kind ?? "original_company_post", primary, companyContext,
    signal: primary ? "native_primary_author_matches_official_yc_company" : "visible_company_authored_caption"
  };
}
