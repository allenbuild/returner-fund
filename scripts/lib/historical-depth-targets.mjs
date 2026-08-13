import { createHash } from "node:crypto";
import { loadAutonomousCatalogs } from "./autonomous-ingestion-plan.mjs";

export const HISTORICAL_DEPTH_SCHEMA_VERSION = 1;
export const HISTORICAL_DEPTH_RUNNER_VERSION = "2026-08-02.v1";
export const HISTORICAL_DEPTH_PLATFORMS = Object.freeze([
  "youtube",
  "product_hunt",
  "reddit"
]);

const PLATFORM_SET = new Set(HISTORICAL_DEPTH_PLATFORMS);

export function normalizeHistoricalDepthPlatforms(platforms) {
  const values = platforms == null
    ? [...HISTORICAL_DEPTH_PLATFORMS]
    : Array.isArray(platforms)
      ? platforms
      : String(platforms).split(",");
  const normalized = [...new Set(values.map(normalizePlatform).filter(Boolean))].sort();
  const invalid = normalized.filter((platform) => !PLATFORM_SET.has(platform));
  if (invalid.length > 0) {
    throw new Error(
      `Unsupported historical-depth platform(s): ${invalid.join(", ")}. ` +
      `Supported values: ${HISTORICAL_DEPTH_PLATFORMS.join(", ")}.`
    );
  }
  if (normalized.length === 0) throw new Error("At least one historical-depth platform is required.");
  return normalized;
}

export function selectHistoricalDepthCatalogs(catalogs, batches) {
  if (!Array.isArray(catalogs) || catalogs.length === 0) {
    throw new TypeError("catalogs must be a non-empty array.");
  }
  if (batches == null) return [...catalogs];
  const requested = [...new Set(
    (Array.isArray(batches) ? batches : String(batches).split(","))
      .map((value) => String(value).trim().toUpperCase())
      .filter(Boolean)
  )];
  if (requested.length === 0) throw new Error("At least one historical-depth batch is required.");
  const index = new Map(catalogs.map((catalog) => [String(catalog.slug).toUpperCase(), catalog]));
  const missing = requested.filter((slug) => !index.has(slug));
  if (missing.length > 0) throw new Error(`Unknown historical-depth batch(es): ${missing.join(", ")}.`);
  return requested.map((slug) => index.get(slug));
}

/**
 * Evaluate every canonical owner/platform pair, but create network targets only
 * from verified account mappings. Missing mappings are denominators, never
 * evidence that a native account does not exist.
 */
export function buildHistoricalDepthTargets(catalogs, { batches, platforms } = {}) {
  const selectedCatalogs = selectHistoricalDepthCatalogs(catalogs, batches);
  const selectedPlatforms = normalizeHistoricalDepthPlatforms(platforms);
  const targets = [];
  const invalidVerifiedMappings = [];
  const byPlatform = Object.fromEntries(selectedPlatforms.map((platform) => [platform, {
    platform,
    ownersEvaluated: 0,
    companyOwnersEvaluated: 0,
    founderOwnersEvaluated: 0,
    ownersWithVerifiedMappings: 0,
    verifiedMappingsFound: 0,
    verifiedAccountsMapped: 0,
    invalidVerifiedMappings: 0,
    unmappedOwnerPlatformPairs: 0
  }]));
  const byBatch = [];
  let companiesEvaluated = 0;
  let foundersEvaluated = 0;
  let verifiedMappingsFound = 0;
  let verifiedAccountsMapped = 0;
  let unverifiedMappingsSkipped = 0;

  for (const catalog of selectedCatalogs) {
    const batch = {
      slug: catalog.slug,
      companiesEvaluated: 0,
      foundersEvaluated: 0,
      ownerPlatformPairsEvaluated: 0,
      verifiedMappingsFound: 0,
      verifiedAccountsMapped: 0,
      invalidVerifiedMappings: 0,
      unmappedOwnerPlatformPairs: 0,
      byPlatform: Object.fromEntries(selectedPlatforms.map((platform) => [platform, {
        ownersEvaluated: 0,
        ownersWithVerifiedMappings: 0,
        verifiedMappingsFound: 0,
        verifiedAccountsMapped: 0,
        invalidVerifiedMappings: 0,
        unmappedOwnerPlatformPairs: 0
      }]))
    };
    const companies = [...(catalog.companies ?? [])].sort(compareEntity);
    for (const company of companies) {
      companiesEvaluated += 1;
      batch.companiesEvaluated += 1;
      const owners = [company, ...[...(company.founders ?? [])].sort(compareEntity)];
      foundersEvaluated += owners.length - 1;
      batch.foundersEvaluated += owners.length - 1;
      for (const owner of owners) {
        for (const platform of selectedPlatforms) {
          const platformRow = byPlatform[platform];
          const batchPlatform = batch.byPlatform[platform];
          platformRow.ownersEvaluated += 1;
          batchPlatform.ownersEvaluated += 1;
          if (owner.entityType === "founder") platformRow.founderOwnersEvaluated += 1;
          else platformRow.companyOwnersEvaluated += 1;
          batch.ownerPlatformPairsEvaluated += 1;

          const rawMappings = (owner.accounts ?? []).filter((account) =>
            normalizePlatform(account?.platform) === platform && isVerifiedMapping(account)
          );
          const skipped = (owner.accounts ?? []).filter((account) =>
            normalizePlatform(account?.platform) === platform && !isVerifiedMapping(account)
          ).length;
          unverifiedMappingsSkipped += skipped;
          verifiedMappingsFound += rawMappings.length;
          batch.verifiedMappingsFound += rawMappings.length;
          platformRow.verifiedMappingsFound += rawMappings.length;
          batchPlatform.verifiedMappingsFound += rawMappings.length;

          if (rawMappings.length === 0) {
            platformRow.unmappedOwnerPlatformPairs += 1;
            batchPlatform.unmappedOwnerPlatformPairs += 1;
            batch.unmappedOwnerPlatformPairs += 1;
            continue;
          }
          platformRow.ownersWithVerifiedMappings += 1;
          batchPlatform.ownersWithVerifiedMappings += 1;
          const seenAccounts = new Set();
          for (const account of rawMappings.sort(compareAccount)) {
            const accountUrl = canonicalHistoricalDepthAccountUrl(platform, account.url);
            if (!accountUrl) {
              const invalid = Object.freeze({
                batchSlug: catalog.slug,
                entityType: owner.entityType,
                entityId: owner.sourceKey,
                entityName: owner.name,
                companyId: company.sourceKey,
                companyName: company.name,
                platform,
                accountSourceKey: clean(account.sourceKey) || null,
                suppliedUrl: clean(account.url) || null,
                reason: "verified_mapping_url_is_not_a_native_account_profile"
              });
              invalidVerifiedMappings.push(invalid);
              platformRow.invalidVerifiedMappings += 1;
              batchPlatform.invalidVerifiedMappings += 1;
              batch.invalidVerifiedMappings += 1;
              targets.push(buildTarget({
                catalog,
                company,
                owner,
                platform,
                account,
                accountUrl: null,
                mappingBlocker: invalid.reason
              }));
              continue;
            }
            const accountKey = accountUrl.toLowerCase();
            if (seenAccounts.has(accountKey)) continue;
            seenAccounts.add(accountKey);
            targets.push(buildTarget({ catalog, company, owner, platform, account, accountUrl }));
            verifiedAccountsMapped += 1;
            batch.verifiedAccountsMapped += 1;
            platformRow.verifiedAccountsMapped += 1;
            batchPlatform.verifiedAccountsMapped += 1;
          }
        }
      }
    }
    byBatch.push(batch);
  }

  const ownersEvaluated = companiesEvaluated + foundersEvaluated;
  return {
    schemaVersion: HISTORICAL_DEPTH_SCHEMA_VERSION,
    runnerVersion: HISTORICAL_DEPTH_RUNNER_VERSION,
    platforms: selectedPlatforms,
    batches: byBatch,
    companiesEvaluated,
    foundersEvaluated,
    ownersEvaluated,
    ownerPlatformPairsEvaluated: ownersEvaluated * selectedPlatforms.length,
    verifiedMappingsFound,
    verifiedAccountsMapped,
    invalidVerifiedMappings: invalidVerifiedMappings.length,
    invalidVerifiedMappingRows: invalidVerifiedMappings,
    unverifiedMappingsSkipped,
    unmappedOwnerPlatformPairs: ownersEvaluated * selectedPlatforms.length -
      Object.values(byPlatform).reduce((sum, row) => sum + row.ownersWithVerifiedMappings, 0),
    targetAccountPairs: targets.length,
    byPlatform,
    targets: targets.sort((left, right) => left.targetKey.localeCompare(right.targetKey))
  };
}

export async function loadHistoricalDepthTargets(root, options = {}) {
  const catalogs = options.catalogs ?? await loadAutonomousCatalogs(root);
  return buildHistoricalDepthTargets(catalogs, options);
}

export function canonicalHistoricalDepthAccountUrl(platform, rawUrl) {
  try {
    const parsed = new URL(String(rawUrl ?? "").trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    parsed.protocol = "https:";
    parsed.hash = "";
    parsed.search = "";
    let host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (platform === "youtube") {
      if (host !== "youtube.com") return null;
      if (parts.length === 1 && /^@[A-Za-z0-9_.-]+$/.test(parts[0])) {
        return `https://www.youtube.com/${parts[0]}`;
      }
      if (parts.length !== 2) return null;
      const kind = parts[0];
      const identity = parts[1];
      if (parts.length === 2 && ["channel", "c", "user"].includes(kind.toLowerCase())) {
        if (!/^[A-Za-z0-9_.@-]+$/.test(identity)) return null;
        return `https://www.youtube.com/${kind.toLowerCase()}/${identity}`;
      }
      return null;
    }
    if (platform === "product_hunt") {
      if (host !== "producthunt.com") return null;
      if (parts.length === 1 && /^@[A-Za-z0-9_-]+$/.test(parts[0])) {
        return `https://www.producthunt.com/${parts[0]}`;
      }
      if (parts.length === 2 && parts[0].toLowerCase() === "products" && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(parts[1])) {
        return `https://www.producthunt.com/products/${parts[1].toLowerCase()}`;
      }
      return null;
    }
    if (platform === "reddit") {
      if (!["reddit.com", "old.reddit.com"].includes(host)) return null;
      if (parts.length !== 2) return null;
      const kind = parts[0].toLowerCase();
      const identity = parts[1];
      if (!["r", "u", "user"].includes(kind) || !/^[A-Za-z0-9_-]+$/.test(identity)) return null;
      return kind === "r"
        ? `https://www.reddit.com/r/${identity}`
        : `https://www.reddit.com/user/${identity}`;
    }
    return null;
  } catch {
    return null;
  }
}

function buildTarget({ catalog, company, owner, platform, account, accountUrl, mappingBlocker = null }) {
  const officialWebsite = canonicalWebsite(company.websiteUrl);
  const entityType = owner.entityType === "founder" ? "founder" : "company";
  const accountIdentity = accountUrl ?? `invalid:${clean(account.url) || clean(account.sourceKey) || "missing"}`;
  const targetKey = [
    catalog.slug,
    entityType,
    owner.sourceKey,
    platform,
    sha256(accountIdentity).slice(0, 20)
  ].join(":");
  return Object.freeze({
    targetKey,
    batchSlug: catalog.slug,
    entityType,
    entityId: owner.sourceKey,
    entityName: owner.name,
    companyId: company.sourceKey,
    companyName: company.name,
    officialWebsite,
    officialDomain: officialWebsite ? new URL(officialWebsite).hostname.replace(/^www\./i, "").toLowerCase() : null,
    platform,
    accountSourceKey: clean(account.sourceKey) || null,
    accountHandle: clean(account.handle) || null,
    accountId: clean(account.accountId) || null,
    accountUrl,
    suppliedAccountUrl: clean(account.url) || null,
    mappingVerified: true,
    mappingReviewState: clean(account.reviewState ?? account.review_state) || null,
    mappingDiscoveredFromUrl: clean(account.discoveredFromUrl) || null,
    mappingMatchReason: clean(account.matchReason) || null,
    mappingBlocker
  });
}

function isVerifiedMapping(account) {
  const reviewState = String(account?.reviewState ?? account?.review_state ?? "").trim().toLowerCase();
  if (reviewState) return reviewState === "verified" && account?.verified !== false;
  return account?.verified === true;
}

function normalizePlatform(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "producthunt") return "product_hunt";
  return normalized;
}

function canonicalWebsite(value) {
  try {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    parsed.protocol = "https:";
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString();
  } catch {
    return null;
  }
}

function compareEntity(left, right) {
  return String(left?.sourceKey ?? "").localeCompare(String(right?.sourceKey ?? ""));
}

function compareAccount(left, right) {
  return String(left?.url ?? "").localeCompare(String(right?.url ?? ""));
}

function clean(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}
