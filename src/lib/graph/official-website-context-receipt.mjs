const urlKey = (value) => {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch { return null; }
};
const domain = (value) => { try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; } };

export function officialWebsiteArticleContextReasons(row, company) {
  const reasons = [];
  let raw;
  try { raw = typeof row.rawVisibleText === "string" ? JSON.parse(row.rawVisibleText) : row.rawVisibleText; } catch { return ["invalid_original_article_receipt"]; }
  if (!company || row.batchSlug !== "F26" || row.entityType !== "company" || row.entityId !== `company-${company.slug}` || row.companySlug !== company.slug || row.companyName !== company.name) reasons.push("unresolved_explicit_fall_company_identity");
  if (row.platform !== "web" || !urlKey(row.sourceUrl) || row.platformPostId !== row.sourceUrl) reasons.push("invalid_native_article_identity");
  if (row.contributionScore !== 0 || !row.metrics || Object.keys(row.metrics).length) reasons.push("article_context_must_have_zero_score_and_no_metrics");
  if (raw?.source !== "official_company_website_article_v1" || raw.company?.slug !== company?.slug || raw.company?.name !== company?.name || raw.company?.entityId !== row.entityId) reasons.push("original_article_receipt_owner_conflict");
  if (typeof row.text !== "string" || !row.text.trim() || raw?.post?.text !== row.text || (row.originalText !== undefined && row.originalText !== row.text) || raw?.post?.title !== row.title || raw?.post?.sourceUrl !== row.sourceUrl) reasons.push("original_article_receipt_body_or_url_conflict");
  if (!/^[a-f0-9]{64}$/.test(row.sourceHtmlSha256 ?? "") || raw?.originalHtml?.sha256 !== row.sourceHtmlSha256 || raw?.originalHtml?.archivePath !== row.fullOriginalHtmlArchivePath) reasons.push("missing_original_html_archive_receipt");
  const lineage = raw?.officialDomainLineage;
  const chain = lineage?.chain;
  if (lineage?.officialYcProfileUrl !== company?.ycProfileUrl || domain(lineage?.officialWebsite) !== domain(company?.websiteUrl) || lineage?.canonicalUrl !== row.sourceUrl || !Array.isArray(chain) || !chain.length) reasons.push("missing_official_domain_lineage");
  else {
    const officialDomain = domain(company?.websiteUrl);
    const initialDomain = domain(chain[0].requestedUrl);
    if (!officialDomain || !initialDomain || (initialDomain !== officialDomain && !initialDomain.endsWith(`.${officialDomain}`))) reasons.push("lineage_must_start_at_official_company_website");
    const previous = new Set();
    for (const [index, hop] of chain.entries()) {
      if (!urlKey(hop.requestedUrl) || !urlKey(hop.finalUrl) || hop.status < 200 || hop.status >= 300 || !/^[a-f0-9]{64}$/.test(hop.sha256 ?? "") || typeof hop.bodyArchivePath !== "string") reasons.push("invalid_official_lineage_hop");
      if (index && !previous.has(urlKey(hop.discoveredOn))) reasons.push("unproven_official_lineage_transition");
      previous.add(urlKey(hop.finalUrl));
      previous.add(urlKey(hop.requestedUrl));
    }
    const last = chain.at(-1);
    if (last.sha256 !== row.sourceHtmlSha256 || last.bodyArchivePath !== row.fullOriginalHtmlArchivePath || urlKey(last.finalUrl) !== urlKey(raw?.post?.fetchedUrl ?? row.fetchedUrl)) reasons.push("article_archive_not_final_lineage_hop");
    if (chain.length > 1 && urlKey(chain[0].finalUrl) !== urlKey(last.finalUrl) && chain[0].sha256 === last.sha256) reasons.push("article_body_is_identical_to_homepage_shell");
    const articleDomain = domain(row.sourceUrl);
    const firstPartyDomains = [officialDomain, domain(chain[0].finalUrl)].filter(Boolean);
    if (!articleDomain || !firstPartyDomains.some((root) => articleDomain === root || articleDomain.endsWith(`.${root}`))) reasons.push("outbound_publisher_link_does_not_prove_company_authorship");
  }
  const observedMs = Date.parse(row.observedAt ?? raw?.observedAt ?? "");
  const publication = /^(?:unknown|unavailable)$/i.test(String(row.postedAt ?? "")) ? null : row.postedAt ?? null;
  const nativePublication = /^(?:unknown|unavailable)$/i.test(String(raw?.post?.nativePublishedAtLiteral ?? "")) ? null : raw?.post?.nativePublishedAtLiteral ?? null;
  if (!Number.isFinite(observedMs) || (publication && (!Number.isFinite(Date.parse(publication)) || Date.parse(publication) > observedMs))) reasons.push("invalid_or_future_native_article_publication");
  if (publication !== nativePublication) reasons.push("native_article_publication_receipt_conflict");
  try {
    const url = new URL(row.sourceUrl);
    if ((!url.pathname.replace(/\//g, "") && !url.searchParams.has("p")) || /^\/(?:[a-z]{2}\/)?(?:blog|news|research|press|updates|articles|posts)\/?$/i.test(url.pathname)) reasons.push("generic_home_or_history_index_is_not_an_article");
    if (/^\/updates\/\d{4}-\d{2}\/?$/.test(url.pathname) && /^update archive\b/i.test(row.text ?? "")) reasons.push("monthly_update_archive_is_not_an_authored_release");
    if (/^\/changelog\/versions\/?$/.test(url.pathname) && /every .{0,40}release on one page/i.test(row.text ?? "")) reasons.push("release_directory_is_not_an_authored_release");
    if (/^\/threat-intel\//.test(url.pathname) && ["First Seen", "Last Reviewed", "Publisher", "Source Type"].every((field) => String(row.text ?? "").includes(field))) reasons.push("structured_resource_catalog_is_not_an_authored_post");
  } catch { /* Native URL validation already records this. */ }
  return [...new Set(reasons)];
}
