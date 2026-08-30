export const YC_ALGOLIA_ABSENCE_VERIFICATION = "yc_algolia_exact_object_absence_v1";
export const YC_ALGOLIA_OBJECT_URL_BASE =
  "https://45BWZJ1SGC.algolia.net/1/indexes/YCCompany_production";

/**
 * Recognize a 404 only when it came from the exact canonical detail URL for the
 * immutable-ID-backed Algolia hit. This is only the first half of retirement
 * verification; the exact Algolia object must independently be absent too.
 */
export function isCanonicalYcCompanyDetail404(hit, error) {
  if (Number(error?.status) !== 404) return null;
  const slug = clean(hit?.slug);
  const id = clean(hit?.id);
  const objectID = clean(hit?.objectID);
  const name = clean(hit?.name);
  const batch = clean(hit?.batch);
  if (
    !id ||
    !objectID ||
    !slug ||
    !name ||
    !batch ||
    id !== objectID ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
  ) {
    return null;
  }
  const detailUrl = `https://www.ycombinator.com/companies/${slug}`;
  return canonicalPublicUrl(error?.url) === detailUrl ? { id, objectID, slug, detailUrl } : null;
}

/**
 * Fetch one YC company detail or return an explicit retirement receipt. This
 * keeps the narrow tombstone policy independently testable from the live crawl.
 */
export async function fetchYcCompanyDetailOrRetirement(hit, fetchDetail, verifyRetirement) {
  if (typeof fetchDetail !== "function") {
    throw new TypeError("fetchDetail must be a function");
  }
  try {
    return {
      kind: "active",
      detail: await fetchDetail(hit.slug)
    };
  } catch (error) {
    const detail404 = isCanonicalYcCompanyDetail404(hit, error);
    if (!detail404 || typeof verifyRetirement !== "function") throw error;
    const tombstone = await verifyRetirement(hit, detail404);
    if (!verifiedRetirementMatchesHit(tombstone, hit, detail404)) throw error;
    return {
      kind: "retired",
      tombstone,
      httpStatus: 404
    };
  }
}

function verifiedRetirementMatchesHit(tombstone, hit, detail404) {
  return Boolean(
    tombstone &&
    clean(tombstone.id) === clean(hit?.id) &&
    clean(tombstone.objectID) === clean(hit?.objectID) &&
    clean(tombstone.slug) === clean(hit?.slug) &&
    clean(tombstone.name) === clean(hit?.name) &&
    clean(tombstone.batch) === clean(hit?.batch) &&
    tombstone.detailUrl === detail404.detailUrl &&
    Number(tombstone.detailHttpStatus) === 404 &&
    tombstone.directoryLookupUrl ===
      `${YC_ALGOLIA_OBJECT_URL_BASE}/${encodeURIComponent(detail404.objectID)}` &&
    Number(tombstone.directoryLookupHttpStatus) === 404 &&
    tombstone.verification === YC_ALGOLIA_ABSENCE_VERIFICATION
  );
}

function clean(value) {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

function canonicalPublicUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
