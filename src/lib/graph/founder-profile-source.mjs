/** F26 founder links were constructed from names. Prefer their verified YC company source. */
export function founderProfileSourceUrl(node, founder) {
  if (node?.batchSlug !== "F26") return founder?.ycProfileUrl;
  if (node.entityType !== "company" || node.review_state !== "verified" || !node.entityId?.startsWith("company-")) return undefined;
  const slug = node.entityId.slice("company-".length);
  if (!/^[a-z0-9-]+$/.test(slug) || !founder?.id?.startsWith(`founder-${slug}-`)) return undefined;
  for (const candidate of [node.ycProfileUrl, node.sourceUrl]) {
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" && ["www.ycombinator.com", "ycombinator.com"].includes(url.hostname)
        && !url.username && !url.password && !url.port && !url.search && !url.hash
        && url.pathname.replace(/\/$/, "") === `/companies/${slug}`) return candidate;
    } catch { /* An absent or invalid source cannot become a guessed founder profile. */ }
  }
  return undefined;
}
