export function dedupePublicNeedsReviewItems(items, { isUseful = () => true } = {}) {
  const byId = new Map();
  for (const item of items ?? []) {
    if (!item?.id || !isUseful(item)) continue;
    byId.set(item.id, item);
  }

  const uniqueItems = [...byId.values()];
  const selectedProductHuntRows = new Map();
  for (const item of uniqueItems) {
    const key = productHuntReviewIdentity(item);
    if (!key) continue;
    const previous = selectedProductHuntRows.get(key);
    if (!previous || compareReviewRows(item, previous) < 0) {
      selectedProductHuntRows.set(key, item);
    }
  }

  return uniqueItems.filter((item) => {
    const key = productHuntReviewIdentity(item);
    return !key || selectedProductHuntRows.get(key) === item;
  });
}

export function productHuntReviewIdentity(item) {
  if (normalizePlatform(item?.platform) !== "product_hunt") return null;
  const candidateUrl = canonicalProductHuntUrl(item?.candidateUrl ?? item?.sourceUrl);
  if (!candidateUrl) return null;
  return JSON.stringify([
    item?.batchSlug ?? item?.batch_slug ?? "",
    item?.companySlug ?? item?.company_slug ?? "",
    item?.entityType ?? item?.entity_type ?? "company",
    item?.entityId ?? item?.entity_id ?? "",
    candidateUrl
  ]);
}

function compareReviewRows(left, right) {
  const checkedDifference = checkedAtMillis(right) - checkedAtMillis(left);
  if (checkedDifference !== 0) return checkedDifference;
  return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

function checkedAtMillis(item) {
  const value = Date.parse(item?.last_checked_at ?? item?.checkedAt ?? "");
  return Number.isFinite(value) ? value : 0;
}

function canonicalProductHuntUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ""));
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host !== "producthunt.com") return null;
    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    if (!/^\/(?:products|posts)\/[^/]+$/.test(path)) return null;
    return `https://producthunt.com${path}`;
  } catch {
    return null;
  }
}

function normalizePlatform(value) {
  return String(value ?? "").trim().toLowerCase().replace(/^producthunt$/, "product_hunt");
}
