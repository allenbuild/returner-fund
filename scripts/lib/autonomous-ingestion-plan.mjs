import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readRequiredCanonicalJson } from "./canonical-json.mjs";
import { applyPublicEvidenceOperationalRetention } from "./public-evidence-artifact.mjs";
import { canonicalSocialAccountUrl } from "./social-account-url.mjs";
import {
  publicationTimesCompatible,
  sourceAuthorsCompatible,
  sourceContentIdentity
} from "./source-content-identity.mjs";
import {
  applyResolvedNativeAuthor,
  assessPublicEvidenceAttribution,
  buildPublicNativeAuthorResolver,
  containsExactTokenSequence,
  hasDistinctiveCatalogPhrase,
  isCollisionProneCompanyName,
  isListOrRoundupAttributionContext,
  organizationQualifiedBatchMarker,
  organizationQualifiedBatchMarkerCount,
  PUBLIC_EVIDENCE_ATTRIBUTION_VERSION,
  publicAttribution,
  publicEvidenceAttributionText
} from "./public-evidence-attribution.mjs";
export {
  buildGithubAuthoritativeQuarantineLedger,
  githubTractionAccountKey,
  isFullyAuthoritativeGithubReceipt,
  mergeGithubTractionSnapshots,
  reconcileGithubTractionSnapshots
} from "./github-authoritative-reconciliation.mjs";

export const AUTONOMOUS_BATCHES = Object.freeze([
  {
    slug: "S2026",
    label: "YC Spring 2026 (P26)",
    graphFile: "s2026.json",
    catalogFile: "src/lib/yc/spring-2026-companies.json",
    catalogFormat: "yc_snapshot",
    expectedCompanyCount: 197,
    expectedFounderCount: 397,
    githubSourcePath: "src/lib/yc/spring-2026-companies.json"
  },
  {
    slug: "S26",
    label: "YC Summer 2026 (S26)",
    graphFile: "s26.json",
    catalogFile: "src/lib/yc/summer-2026-companies.json",
    aliasLedgerFile: "src/lib/yc/summer-2026-company-aliases.json",
    catalogFormat: "yc_snapshot",
    minimumCompanyCount: 167,
    minimumFounderCount: 325,
    minimumAccountCount: 790,
    dynamicCatalogCounts: true,
    expectedCompanyCount: null,
    expectedFounderCount: null,
    githubSourcePath: "src/lib/yc/summer-2026-companies.json"
  },
  {
    slug: "A16ZSR006",
    label: "a16z Speedrun 006",
    graphFile: "a16zsr006.json",
    expectedCompanyCount: 59,
    expectedFounderCount: 128,
    rosterFile: "src/lib/social/a16z-speedrun-006-social-accounts.json",
    githubSourcePath: "src/lib/graph/a16z-speedrun-006-dataset.ts"
  }
]);

const MINUTE_MS = 60_000;

export const AUTONOMOUS_PROCESS_BUDGETS = Object.freeze({
  catalogRefreshMs: 6 * MINUTE_MS,
  // Every public shard, GitHub cohort, retry backoff, and Top Voice refresh
  // shares this enforced wall-clock phase. Retry counts are intentionally not
  // the bound; public and GitHub shards remain under their distinct process
  // guards while the phase deadline reserves deterministic cleanup time.
  collectionPhaseMs: 120 * MINUTE_MS,
  collectionDeadlineDrainHeadroomMs: 5 * MINUTE_MS,
  // Attempts continue until success or the phase deadline. Durable task rows
  // use the PostgreSQL integer ceiling; this legacy field remains only for
  // compatibility with historical receipts and is not a retry stop condition.
  collectorAttempts: 2_147_483_647,
  collectorRetryDelayMaxMs: 5 * MINUTE_MS,
  collectorRateLimitRetryDelayMs: 65_000,
  publicCollectorAttemptMs: 70 * MINUTE_MS,
  collectorCheckpointFlushMs: 2 * MINUTE_MS,
  githubCollectorAttemptMs: 20 * MINUTE_MS,
  topVoiceCollectorMs: 22 * MINUTE_MS,
  benchmarkPublicationMs: 8 * MINUTE_MS,
  timelineDiscoveryMs: 6 * MINUTE_MS,
  timelineDiscoveryCommandHeadroomMs: 30_000,
  timelineBackfillMs: 6 * MINUTE_MS,
  scoringDiagnosticsMs: 6 * MINUTE_MS,
  artifactManifestMs: MINUTE_MS,
  artifactValidationMs: 3 * MINUTE_MS,
  // Topic facets and Ranked Posts each rebuild all 43k+ attributable posts.
  // Linux runners are roughly twice as slow as local development for these
  // serial, memory-heavy passes, so each combined build-and-verify command
  // receives a bounded six-minute window.
  derivedArtifactMs: 6 * MINUTE_MS,
  gitConfigMs: 30_000,
  gitStageMs: MINUTE_MS,
  gitDiffMs: 30_000,
  gitCommitMs: 2 * MINUTE_MS,
  gitPushMs: 4 * MINUTE_MS,
  processKillGraceMs: 5_000,
  durablePersistenceHeadroomMs: 25 * MINUTE_MS,
  lockReleaseHeadroomMs: 2 * MINUTE_MS
});

// A small number of explicit, terminal source failures must not discard hours
// of otherwise valid collection work. The proportional ceiling scales with the
// current mapped inventory while still stopping a broad collector outage.
// Non-terminal tasks remain a hard stop.
export const AUTONOMOUS_MAPPED_TERMINAL_FAILURE_BUDGET = 5;
export const AUTONOMOUS_MAPPED_TERMINAL_FAILURE_RATIO = 0.05;

export function autonomousMappedTerminalFailureBudget(mappedExpected = 0) {
  const expected = Number.isFinite(Number(mappedExpected))
    ? Math.max(0, Math.floor(Number(mappedExpected)))
    : 0;
  return Math.max(
    AUTONOMOUS_MAPPED_TERMINAL_FAILURE_BUDGET,
    Math.ceil(expected * AUTONOMOUS_MAPPED_TERMINAL_FAILURE_RATIO)
  );
}

export function maxAutonomousRunnerProcessBudgetMs(budgets = AUTONOMOUS_PROCESS_BUDGETS) {
  // Collection has a phase-wide deadline enforced by the runner. This is the
  // only sound wall-clock bound: seven public shards share two process slots,
  // seven GitHub shards share two process slots with four workers per process,
  // and rate limits use a longer backoff than ordinary retries. Drain headroom
  // covers termination, checkpoint reads, and final in-process reconciliation.
  const collectorWindow =
    budgets.collectionPhaseMs +
    budgets.collectionDeadlineDrainHeadroomMs;
  const catalogRefreshWindow = budgets.catalogRefreshMs + budgets.processKillGraceMs;
  const publicationBaseSynchronizationWindow =
    2 * budgets.gitPushMs; // initial fetch + rebase
  // Five compact validation commands use artifactValidationMs (two runtime
  // preparations, Timeline, cohort audit, and final artifact validation).
  // Topic facets and Ranked Posts validate the bytes they write in-process,
  // so each publication attempt has two, not four, full-corpus commands.
  const publicationBuildWindow =
    budgets.benchmarkPublicationMs +
    budgets.timelineDiscoveryMs +
    budgets.timelineDiscoveryCommandHeadroomMs +
    (2 * budgets.timelineBackfillMs) +
    budgets.scoringDiagnosticsMs +
    (2 * budgets.artifactManifestMs) +
    (5 * budgets.artifactValidationMs) +
    (2 * budgets.derivedArtifactMs);
  const initialPublicationWindow =
    publicationBuildWindow +
    (2 * budgets.gitConfigMs) +
    budgets.gitStageMs +
    budgets.gitDiffMs +
    budgets.gitCommitMs +
    budgets.gitPushMs; // first push
  const publicationRetryWindow =
    (2 * budgets.gitPushMs) + // fetch + rebase
    publicationBuildWindow +
    budgets.gitStageMs +
    budgets.gitDiffMs +
    budgets.gitCommitMs +
    budgets.gitPushMs;
  const publicationVerificationWindow =
    budgets.gitDiffMs + // resolve published commit
    budgets.gitPushMs + // fetch published branch
    budgets.gitDiffMs; // verify ancestry
  return (
    catalogRefreshWindow +
    collectorWindow +
    publicationBaseSynchronizationWindow +
    initialPublicationWindow +
    publicationRetryWindow +
    publicationVerificationWindow +
    budgets.processKillGraceMs +
    budgets.durablePersistenceHeadroomMs +
    budgets.lockReleaseHeadroomMs
  );
}

export const AUTONOMOUS_PLATFORMS = Object.freeze([
  "github",
  "x",
  "instagram",
  "linkedin",
  "youtube",
  "product_hunt",
  "reddit",
  "hacker_news",
  "rss",
  "web",
  "bilibili",
  "tiktok",
  "bluesky"
]);

const PUBLIC_PLATFORM_COLLECTORS = new Set([
  "x",
  "instagram",
  "linkedin",
  "youtube",
  "product_hunt",
  "reddit",
  "hacker_news",
  "rss",
  "web"
]);
const FOUNDER_SOCIAL_PLATFORMS = new Set(["github", "x", "instagram", "linkedin"]);
const EXPLICITLY_UNAVAILABLE = new Set(["bilibili", "tiktok", "bluesky"]);
const AUTONOMOUS_PROVIDER_BLOCKER_CODES = new Map([
  ["duckduckgo_html", new Set([
    "public_search_access_blocked",
    "public_search_http_failure",
    "public_search_soft_block",
    "public_search_body_limit",
    "public_search_timeout",
    "public_search_transport_failure",
    "public_search_circuit_open"
  ])],
  ["linkedin_public_html", new Set([
    "linkedin_public_access_blocked",
    "linkedin_public_http_failure",
    "linkedin_public_soft_block",
    "linkedin_public_body_limit",
    "linkedin_public_timeout",
    "linkedin_public_transport_failure",
    "linkedin_public_circuit_open"
  ])],
  ["jina_linkedin_reader", new Set([
    "linkedin_public_access_blocked",
    "linkedin_public_http_failure",
    "linkedin_public_soft_block",
    "linkedin_public_body_limit",
    "linkedin_public_timeout",
    "linkedin_public_transport_failure",
    "linkedin_public_circuit_open"
  ])],
  ["reddit_public_json", new Set([
    "reddit_public_access_blocked"
  ])]
]);

export async function loadAutonomousCatalogs(root) {
  const verifiedSocialOverrides = await readRequiredCanonicalJson(
    join(root, "src", "lib", "social", "verified-social-overrides.json"),
    "Verified social overrides"
  );
  const catalogs = await Promise.all(
    AUTONOMOUS_BATCHES.map(async (batch) => {
      const path = batch.catalogFile
        ? join(root, batch.catalogFile)
        : join(root, "public", "graph", batch.graphFile);
      const source = JSON.parse(await readFile(path, "utf8"));
      if (batch.catalogFormat === "yc_snapshot") {
        const aliasLedger = batch.aliasLedgerFile
          ? await readRequiredCanonicalJson(
              join(root, batch.aliasLedgerFile),
              `${batch.label} company alias ledger`
            )
          : null;
        if (!Array.isArray(source.companies)) {
          throw new Error(`${batch.catalogFile} does not contain a company array.`);
        }
        if (batch.dynamicCatalogCounts) {
          validateDynamicYcSnapshot(source, batch);
        } else if (source.companies.length !== batch.expectedCompanyCount) {
          throw new Error(
            `${batch.catalogFile} contains ${source.companies.length} companies; expected ${batch.expectedCompanyCount}.`
          );
        }
        const companies = source.companies.map((company) =>
          normalizeYcCompany(company, batch, aliasLedger)
        );
        return {
          ...batch,
          expectedCompanyCount: batch.dynamicCatalogCounts
            ? source.companies.length
            : batch.expectedCompanyCount,
          sourcePath: path,
          generatedAt: source.source?.fetchedAt ?? null,
          companies
        };
      }
      const graph = source;
      if (!Array.isArray(graph.nodes)) {
        throw new Error(`${batch.graphFile} does not contain a graph node array.`);
      }
      const companies = graph.nodes
        .filter((node) => node?.entityType === "company" && node.entityId && node.label)
        .map((node) => normalizeCompanyNode(node, batch));
      if (batch.rosterFile) {
        const roster = JSON.parse(await readFile(join(root, batch.rosterFile), "utf8"));
        validateAutonomousCatalogRoster(companies, roster, batch);
      }
      return {
        ...batch,
        sourcePath: path,
        generatedAt: graph.generatedAt ?? null,
        companies
      };
    })
  );
  return catalogs.map((catalog) => {
    const companies = mergeVerifiedOverridesIntoCatalog(
      catalog.companies,
      verifiedSocialOverrides,
      catalog
    );
    if (catalog.dynamicCatalogCounts) {
      validateDynamicCatalogInventory(companies, catalog);
    }
    const resolvedCatalog = catalog.dynamicCatalogCounts
      ? {
          ...catalog,
          expectedCompanyCount: companies.length,
          expectedFounderCount: companies.reduce(
            (count, company) => count + company.founders.length,
            0
          )
        }
      : catalog;
    validateFixedCatalogCounts(
      companies,
      resolvedCatalog,
      resolvedCatalog.catalogFile ?? resolvedCatalog.graphFile
    );
    return { ...resolvedCatalog, companies };
  });
}

function validateDynamicCatalogInventory(companies, batch) {
  const founderCount = companies.reduce(
    (count, company) => count + company.founders.length,
    0
  );
  const accountCount = companies.reduce(
    (count, company) => count + company.accounts.length + company.founders.reduce(
      (founderCount, founder) => founderCount + founder.accounts.length,
      0
    ),
    0
  );
  const minimumFounderCount = Number(batch.minimumFounderCount ?? 0);
  const minimumAccountCount = Number(batch.minimumAccountCount ?? 0);
  if (founderCount < minimumFounderCount || accountCount < minimumAccountCount) {
    throw new Error(
      `${batch.catalogFile ?? batch.graphFile} lost canonical owner inventory: ` +
      `companies=${companies.length}, founders=${founderCount}/${minimumFounderCount}, ` +
      `accounts=${accountCount}/${minimumAccountCount}.`
    );
  }
}

function validateDynamicYcSnapshot(source, batch) {
  const sourceExpected = Number(source?.source?.expectedCompanyCount);
  const sourceObserved = Number(source?.source?.observedCompanyCount);
  const minimum = Number(batch.minimumCompanyCount ?? 0);
  if (!Number.isInteger(sourceExpected) || sourceExpected < minimum) {
    throw new Error(
      `${batch.catalogFile} declares ${sourceExpected || "no"} expected companies; ` +
      `at least ${minimum} are required.`
    );
  }
  if (sourceExpected !== source.companies.length || sourceObserved !== source.companies.length) {
    throw new Error(
      `${batch.catalogFile} is incomplete: expected=${sourceExpected}, observed=${sourceObserved}, ` +
      `companies=${source.companies.length}.`
    );
  }
  const ids = new Set();
  const slugs = new Set();
  for (const company of source.companies) {
    const id = String(company?.id ?? "").trim();
    const slug = String(company?.slug ?? "").trim();
    if (!id || !slug) {
      throw new Error(`${batch.catalogFile} contains a company without an immutable ID or slug.`);
    }
    if (company.batch !== "Summer 2026") {
      throw new Error(
        `${batch.catalogFile} contains ${slug} in ${company.batch ?? "an unknown batch"}; ` +
        "expected Summer 2026."
      );
    }
    if (ids.has(id) || slugs.has(slug)) {
      throw new Error(`${batch.catalogFile} contains duplicate company identity ${id}/${slug}.`);
    }
    ids.add(id);
    slugs.add(slug);
  }
}

export function buildAutonomousPublicNativeAuthorResolver(catalogs) {
  return buildPublicNativeAuthorResolver(catalogs);
}

export function buildCanonicalTargetedAttributionResolver(catalogs) {
  const nativeAuthorResolver = buildPublicNativeAuthorResolver(catalogs);
  const exactTargets = new Map();
  const legacyExactTargets = new Map();
  const companiesByBatchName = new Map();
  const companiesByBatchStructuredIdentity = new Map();
  for (const catalog of catalogs ?? []) {
    for (const company of catalog.companies ?? []) {
      const companyTarget = { catalog, company, founder: null };
      exactTargets.set(
        targetedCatalogEntityKey(catalog.slug, "company", company.sourceKey),
        companyTarget
      );
      for (const alias of company.legacyEntityAliases ?? []) {
        indexTargetedLegacyEntityAlias(
          legacyExactTargets,
          catalog.slug,
          "company",
          alias,
          companyTarget
        );
      }
      for (const name of [company.name, ...(company.legacyEntityAliases ?? [])]) {
        indexTargetedCompanyName(companiesByBatchName, catalog.slug, name, companyTarget);
      }
      for (const identity of [
        company.name,
        autonomousCompanySlug(company),
        ...(company.legacyEntityAliases ?? [])
      ]) {
        indexTargetedCompanyIdentity(
          companiesByBatchStructuredIdentity,
          catalog.slug,
          identity,
          companyTarget
        );
      }
      for (const founder of company.founders ?? []) {
        const founderTarget = { catalog, company, founder };
        exactTargets.set(
          targetedCatalogEntityKey(catalog.slug, "founder", founder.sourceKey),
          founderTarget
        );
        for (const alias of founder.legacyEntityAliases ?? []) {
          indexTargetedLegacyEntityAlias(
            legacyExactTargets,
            catalog.slug,
            "founder",
            alias,
            founderTarget
          );
        }
      }
    }
  }

  return (row, batchSlug) => {
    if (!batchSlug) return null;
    const entityType = String(row?.entityType ?? row?.entity_type ?? "").toLowerCase();
    const entityId = row?.entityId ?? row?.entity_id;
    if (entityType === "founder") {
      const strongAuthorSignals = targetedStrongAuthorSignals(row);
      if (strongAuthorSignals.length > 1) {
        return {
          rejected: true,
          reason: "canonical_targeted_conflicting_strong_author_identity",
          strongAuthorSignals
        };
      }
    }
    const exactKey = targetedCatalogEntityKey(batchSlug, entityType, entityId);
    const exact = exactTargets.get(exactKey);
    const legacyExact = exact ? null : legacyExactTargets.get(exactKey);
    const exactTarget = exact ?? legacyExact;
    if (exactTarget) {
      const companyConflict = targetedStructuredCompanyConflict(
        row,
        batchSlug,
        exactTarget.company.sourceKey,
        companiesByBatchStructuredIdentity
      );
      if (companyConflict) {
        return {
          rejected: true,
          reason: "canonical_targeted_entity_company_identity_conflict",
          companyConflict
        };
      }
      return canonicalTargetedAttributionResolution(
        row,
        exactTarget,
        exact
          ? "canonical_targeted_exact_entity_id"
          : "canonical_targeted_legacy_entity_alias"
      );
    }

    if (entityType === "founder") {
      const nativeResolution = nativeAuthorResolver({ ...row, batchSlug });
      if (
        nativeResolution.status !== "matched" ||
        nativeResolution.owner?.batchSlug !== batchSlug ||
        nativeResolution.owner?.entityType !== "founder"
      ) return null;
      const target = exactTargets.get(targetedCatalogEntityKey(
        batchSlug,
        "founder",
        nativeResolution.owner.entityId
      ));
      return target
        ? canonicalTargetedAttributionResolution(
            row,
            target,
            "canonical_targeted_unique_native_founder"
          )
        : null;
    }

    if (entityType === "company") {
      const companyName = normalizedCatalogBatchAlias(row?.companyName ?? row?.company_name);
      const matches = companiesByBatchName.get(`${batchSlug}:${companyName}`) ?? [];
      return matches.length === 1
        ? canonicalTargetedAttributionResolution(
            row,
            matches[0],
            "canonical_targeted_unique_batch_company_name"
          )
        : null;
    }
    return null;
  };
}

function indexTargetedLegacyEntityAlias(index, batchSlug, entityType, alias, target) {
  const normalizedAlias = String(alias ?? "").trim();
  if (!normalizedAlias) return;
  const key = targetedCatalogEntityKey(batchSlug, entityType, normalizedAlias);
  const previous = index.get(key);
  const previousEntityId = previous?.founder?.sourceKey ?? previous?.company?.sourceKey;
  const targetEntityId = target?.founder?.sourceKey ?? target?.company?.sourceKey;
  if (previous && previousEntityId !== targetEntityId) {
    throw new Error(
      `Canonical targeted attribution alias ${batchSlug}/${entityType}/${normalizedAlias} maps to multiple entities.`
    );
  }
  index.set(key, target);
}

function indexTargetedCompanyName(index, batchSlug, identity, target) {
  const normalized = normalizedCatalogBatchAlias(identity);
  if (!normalized) return;
  const key = `${batchSlug}:${normalized}`;
  const targets = index.get(key) ?? [];
  if (!targets.some((candidate) => candidate.company.sourceKey === target.company.sourceKey)) {
    index.set(key, [...targets, target]);
  }
}

function indexTargetedCompanyIdentity(index, batchSlug, identity, target) {
  const normalized = normalizedCatalogBatchAlias(identity);
  if (!normalized) return;
  const key = `${batchSlug}:${normalized}`;
  const targets = index.get(key) ?? [];
  if (!targets.some((candidate) => candidate.company.sourceKey === target.company.sourceKey)) {
    index.set(key, [...targets, target]);
  }
}

function targetedStructuredCompanyConflict(row, batchSlug, exactCompanyId, index) {
  for (const [field, value] of [
    ["companyName", row?.companyName ?? row?.company_name],
    ["companySlug", row?.companySlug ?? row?.company_slug]
  ]) {
    const normalized = normalizedCatalogBatchAlias(value);
    if (!normalized) continue;
    const matches = index.get(`${batchSlug}:${normalized}`) ?? [];
    if (matches.length === 1 && matches[0].company.sourceKey !== exactCompanyId) {
      return {
        field,
        value,
        resolvedCompanyId: matches[0].company.sourceKey,
        exactEntityCompanyId: exactCompanyId
      };
    }
  }
  return null;
}

function targetedStrongAuthorSignals(row) {
  const platform = normalizePlatform(row?.platform);
  const raw = parseTargetedRawObject(row?.rawVisibleText);
  const handles = new Set();
  const addHandle = (value) => {
    const handle = normalizeTargetedAuthorHandle(value);
    if (handle) handles.add(handle);
  };
  const addUrl = (value) => addHandle(targetedAuthorHandleFromUrl(platform, value));
  addUrl(row?.sourceUrl ?? row?.source_url ?? row?.canonicalUrl ?? row?.url);
  for (const value of [
    row?.authorHandle,
    row?.author_handle,
    row?.account?.handle,
    row?.account?.username,
    raw?.profile?.username,
    raw?.profile?.handle,
    raw?.post?.authorHandle,
    raw?.post?.author_handle,
    raw?.post?.author?.handle,
    raw?.post?.author?.username,
    raw?.post?.author?.screen_name,
    raw?.author?.handle,
    raw?.author?.username,
    raw?.author?.screen_name,
    typeof raw?.author === "string" ? raw.author : null
  ]) addHandle(value);
  for (const value of [
    row?.authorUrl,
    row?.author_url,
    row?.accountUrl,
    row?.account_url,
    raw?.profile?.url,
    raw?.post?.authorUrl,
    raw?.post?.author?.url,
    raw?.author?.url
  ]) addUrl(value);
  return [...handles].sort();
}

function targetedAuthorHandleFromUrl(platform, rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ""));
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    const parts = decodeURIComponent(url.pathname).split("/").filter(Boolean);
    if (platform === "x" && ["x.com", "twitter.com", "mobile.twitter.com"].includes(host)) {
      return parts[0]?.toLowerCase() === "i" ? null : parts[0] ?? null;
    }
    if (platform === "linkedin" && (host === "linkedin.com" || host.endsWith(".linkedin.com"))) {
      if (parts[0]?.toLowerCase() === "posts" && parts[1]) {
        return parts[1].match(/^(.+?)_(?:.*?activity-\d+|activity-\d+)/i)?.[1] ?? null;
      }
      if (["in", "company"].includes(parts[0]?.toLowerCase()) && parts[1]) return parts[1];
    }
    if (platform === "instagram" && (host === "instagram.com" || host.endsWith(".instagram.com"))) {
      if (parts[0] && !["p", "reel", "reels", "tv"].includes(parts[0].toLowerCase())) return parts[0];
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeTargetedAuthorHandle(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/^@/, "").toLowerCase() || null;
}

function parseTargetedRawObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value ?? ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function targetedCatalogEntityKey(batchSlug, entityType, entityId) {
  return `${batchSlug ?? ""}:${entityType ?? ""}:${entityId ?? ""}`;
}

function canonicalTargetedAttributionResolution(row, { catalog, company, founder }, reason) {
  const entityType = founder ? "founder" : "company";
  const entityId = founder?.sourceKey ?? company.sourceKey;
  const currentBatch = row?.batchSlug ?? row?.batch_slug ?? catalog.slug;
  const currentType = row?.entityType ?? row?.entity_type ?? "company";
  const currentId = row?.entityId ?? row?.entity_id;
  const changedTarget = currentBatch !== catalog.slug || currentType !== entityType || currentId !== entityId;
  return {
    changedTarget,
    reason,
    row: {
      ...row,
      batchSlug: catalog.slug,
      entityType,
      entityId,
      entityName: founder?.name ?? company.name,
      companySlug: autonomousCompanySlug(company),
      companyName: company.name,
      attachedCompanyId: company.sourceKey,
      ...(changedTarget
        ? {
            previousAttribution: {
              batchSlug: currentBatch,
              entityType: currentType,
              entityId: currentId,
              companySlug: row?.companySlug ?? row?.company_slug ?? null,
              companyName: row?.companyName ?? row?.company_name ?? null
            },
            attributionReconciliationReason: reason
          }
        : {})
    }
  };
}

export function buildLegacyPublicEvidenceBatchResolver(catalogs) {
  const companyBatchesByAlias = new Map();
  const founderBatchesByAlias = new Map();
  const addAlias = (index, alias, batchSlug) => {
    const key = normalizedCatalogBatchAlias(alias);
    if (!key) return;
    const matches = index.get(key) ?? new Set();
    matches.add(batchSlug);
    index.set(key, matches);
  };
  for (const catalog of catalogs) {
    for (const company of catalog.companies) {
      for (const alias of [
        company.sourceKey,
        autonomousCompanySlug(company),
        company.name,
        ...(company.legacyEntityAliases ?? [])
      ]) {
        addAlias(companyBatchesByAlias, alias, catalog.slug);
      }
      for (const founder of [
        ...company.founders,
        ...(company.historicalFounders ?? [])
      ]) {
        for (const alias of [
          founder.sourceKey,
          founder.name,
          ...(founder.legacyEntityAliases ?? [])
        ]) {
          addAlias(founderBatchesByAlias, alias, catalog.slug);
        }
      }
    }
  }
  return (row) => {
    const explicit = row?.batchSlug ?? row?.batch_slug;
    const validExplicit = explicit && catalogs.some((catalog) => catalog.slug === explicit)
      ? explicit
      : null;
    const entityType = String(row?.entityType ?? row?.entity_type ?? "").toLowerCase();
    const constraintSets = [];
    const entityAlias = row?.entityId ?? row?.entity_id;
    if (entityAlias) {
      const entityMatches = (entityType === "founder" ? founderBatchesByAlias : companyBatchesByAlias)
        .get(normalizedCatalogBatchAlias(entityAlias));
      if (entityMatches) constraintSets.push(entityMatches);
    }
    for (const companyAlias of [
      row?.companySlug ?? row?.company_slug,
      row?.companyName ?? row?.company_name
    ]) {
      const companyMatches = companyBatchesByAlias.get(normalizedCatalogBatchAlias(companyAlias));
      if (companyMatches) constraintSets.push(companyMatches);
    }
    if (constraintSets.length === 0) return validExplicit;
    const matches = new Set(constraintSets[0]);
    for (const constraint of constraintSets.slice(1)) {
      for (const batchSlug of matches) {
        if (!constraint.has(batchSlug)) matches.delete(batchSlug);
      }
    }
    if (validExplicit && matches.has(validExplicit)) return validExplicit;
    if (matches.size === 1) return [...matches][0];
    return null;
  };
}

function normalizedCatalogBatchAlias(value) {
  return String(value ?? "").trim().toLowerCase() || null;
}

export function validateAutonomousCatalogRoster(companies, roster, batch) {
  if (!Array.isArray(roster?.companies)) {
    throw new Error(`${batch.rosterFile ?? batch.slug} does not contain an independent company roster.`);
  }
  if (roster.companies.length !== batch.expectedCompanyCount) {
    throw new Error(
      `${batch.rosterFile ?? batch.slug} contains ${roster.companies.length} companies; expected ${batch.expectedCompanyCount}.`
    );
  }
  const rosterFounderCount = roster.companies.reduce(
    (count, company) => count + (company.founders?.length ?? 0),
    0
  );
  if (rosterFounderCount !== batch.expectedFounderCount) {
    throw new Error(
      `${batch.rosterFile ?? batch.slug} contains ${rosterFounderCount} founders; expected ${batch.expectedFounderCount}.`
    );
  }
  const graphCompanies = new Set(companies.map((company) => autonomousCompanySlug(company)));
  const rosterCompanies = new Set(roster.companies.map((company) => company.companySlug));
  const graphFounders = new Set(companies.flatMap((company) =>
    company.founders.map((founder) => `${autonomousCompanySlug(company)}:${normalizeIdentity(founder.name)}`)
  ));
  const rosterFounders = new Set(roster.companies.flatMap((company) =>
    (company.founders ?? []).map((founder) => `${company.companySlug}:${normalizeIdentity(founder.name)}`)
  ));
  const missingCompanies = [...rosterCompanies].filter((key) => !graphCompanies.has(key));
  const extraCompanies = [...graphCompanies].filter((key) => !rosterCompanies.has(key));
  const missingFounders = [...rosterFounders].filter((key) => !graphFounders.has(key));
  const extraFounders = [...graphFounders].filter((key) => !rosterFounders.has(key));
  if (missingCompanies.length || extraCompanies.length || missingFounders.length || extraFounders.length) {
    throw new Error(
      `${batch.slug} graph roster drifted from ${batch.rosterFile ?? "the independent roster"}: ` +
      JSON.stringify({ missingCompanies, extraCompanies, missingFounders, extraFounders })
    );
  }
  return companies;
}

function validateFixedCatalogCounts(companies, batch, sourcePath) {
  if (companies.length !== batch.expectedCompanyCount) {
    throw new Error(`${sourcePath} contains ${companies.length} companies; expected ${batch.expectedCompanyCount}.`);
  }
  const founderCount = companies.reduce((count, company) => count + company.founders.length, 0);
  if (founderCount !== batch.expectedFounderCount) {
    throw new Error(`${sourcePath} contains ${founderCount} founders; expected ${batch.expectedFounderCount}.`);
  }
}

export function buildAutonomousTaskPlan(catalogs, { runKey }) {
  const tasks = [];
  for (const batch of catalogs) {
    for (const company of batch.companies) {
      for (const platform of AUTONOMOUS_PLATFORMS) {
        tasks.push(...tasksForEntity({ runKey, batch, company, entity: company, platform }));
      }
      for (const founder of company.founders) {
        for (const platform of AUTONOMOUS_PLATFORMS) {
          tasks.push(...tasksForEntity({ runKey, batch, company, entity: founder, platform }));
        }
      }
    }
  }
  return tasks.sort((left, right) => left.checkpointKey.localeCompare(right.checkpointKey));
}

export function prioritizeAutonomousCompaniesByCoverage(
  companies,
  evidenceRows,
  { prioritySeed = "", batchSlug = null } = {}
) {
  const evidenceCountByEntity = new Map();
  const latestPostByEntity = new Map();
  for (const row of evidenceRows ?? []) {
    const rowBatch = row?.batchSlug ?? row?.batch_slug;
    if (batchSlug && rowBatch && rowBatch !== batchSlug) continue;
    const entityId = row?.entityId ?? row?.entity_id;
    if (!entityId || ["needs_review", "rejected"].includes(row?.review_state)) continue;
    evidenceCountByEntity.set(entityId, (evidenceCountByEntity.get(entityId) ?? 0) + 1);
    const postedAt = Date.parse(row?.postedAt ?? row?.publishedAt ?? row?.last_updated_at ?? "");
    if (Number.isFinite(postedAt)) {
      latestPostByEntity.set(entityId, Math.max(latestPostByEntity.get(entityId) ?? 0, postedAt));
    }
  }

  const summaries = new Map((companies ?? []).map((company) => {
    const owners = [company, ...(company.founders ?? [])];
    const counts = owners.map((owner) => evidenceCountByEntity.get(owner.sourceKey) ?? 0);
    const latestPostAt = Math.max(
      0,
      ...owners.map((owner) => latestPostByEntity.get(owner.sourceKey) ?? 0)
    );
    return [company.sourceKey, {
      ownerCount: owners.length,
      zeroOwnerCount: counts.filter((count) => count === 0).length,
      minimumOwnerCount: Math.min(...counts),
      totalEvidenceCount: counts.reduce((sum, count) => sum + count, 0),
      latestPostAt,
      rotation: seededCoverageRotation(prioritySeed, company.sourceKey)
    }];
  }));

  return [...(companies ?? [])].sort((left, right) => {
    const leftSummary = summaries.get(left.sourceKey);
    const rightSummary = summaries.get(right.sourceKey);
    const leftZeroRatio = leftSummary.zeroOwnerCount / leftSummary.ownerCount;
    const rightZeroRatio = rightSummary.zeroOwnerCount / rightSummary.ownerCount;
    return (
      rightZeroRatio - leftZeroRatio ||
      rightSummary.zeroOwnerCount - leftSummary.zeroOwnerCount ||
      leftSummary.minimumOwnerCount - rightSummary.minimumOwnerCount ||
      (leftSummary.totalEvidenceCount / leftSummary.ownerCount) -
        (rightSummary.totalEvidenceCount / rightSummary.ownerCount) ||
      leftSummary.latestPostAt - rightSummary.latestPostAt ||
      leftSummary.rotation - rightSummary.rotation ||
      left.sourceKey.localeCompare(right.sourceKey)
    );
  });
}

function seededCoverageRotation(seed, value) {
  let hash = 2_166_136_261;
  for (const character of `${seed}:${value}`) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function summarizeTaskCoverage(tasks) {
  const summary = {
    expected: tasks.length,
    queued: 0,
    terminal: 0,
    mapped: 0,
    mappedQueued: 0,
    missingMappings: 0,
    unsupported: 0,
    byPlatform: {}
  };
  for (const task of tasks) {
    const platform = (summary.byPlatform[task.platform] ??= {
      expected: 0,
      queued: 0,
      terminal: 0,
      missingMappings: 0,
      unsupported: 0
    });
    platform.expected += 1;
    if (task.status === "queued") {
      summary.queued += 1;
      platform.queued += 1;
    } else {
      summary.terminal += 1;
      platform.terminal += 1;
    }
    if (task.account) {
      summary.mapped += 1;
      if (task.status === "queued") summary.mappedQueued += 1;
    }
    if (task.platform === "github" && !task.account) {
      summary.missingMappings += 1;
      platform.missingMappings += 1;
    }
    if (task.terminalReason?.startsWith("collector_")) {
      summary.unsupported += 1;
      platform.unsupported += 1;
    }
  }
  return summary;
}

export function validateAutonomousCollectorMatrix(results, batches = AUTONOMOUS_BATCHES) {
  const expected = batches.flatMap((batch) => [
    `${batch.slug}:public`,
    `${batch.slug}:github`
  ]).sort();
  const actual = (results ?? [])
    .map((result) => `${result?.batchSlug}:${result?.kind}`)
    .sort();
  if (actual.length !== new Set(actual).size || actual.join("\n") !== expected.join("\n")) {
    throw new Error(
      `Collector matrix was incomplete: expected ${expected.join(", ")}; received ${actual.join(", ") || "none"}.`
    );
  }
  return results;
}

export function validateMappedAutonomousCoverage(
  coverage,
  {
    allowTerminalFailures = false,
    maxTerminalFailures = allowTerminalFailures ? Number.POSITIVE_INFINITY : 0
  } = {}
) {
  const expected = coverage?.mappedExpected ?? 0;
  const succeeded = coverage?.mappedSucceeded ?? 0;
  const needsReview = coverage?.mappedNeedsReview ?? 0;
  const blockedOrEmpty = coverage?.mappedBlockedOrEmpty ?? 0;
  const failed = coverage?.mappedFailed ?? 0;
  const nonTerminal = coverage?.mappedNonTerminal ?? 0;
  const classified = succeeded + needsReview + blockedOrEmpty;
  const terminallyAccounted = classified + failed;
  const failureBudgetExceeded = failed > maxTerminalFailures;
  if (terminallyAccounted !== expected || failureBudgetExceeded || nonTerminal) {
    const failureSamples = Array.isArray(coverage?.mappedFailureSamples)
      ? ` Failed task samples: ${JSON.stringify(coverage.mappedFailureSamples.slice(0, 20))}.`
      : "";
    throw new Error(
      "Mapped collector coverage was incomplete: " +
      `${classified}/${expected} classified (${succeeded} with native evidence), ${needsReview} need review, ` +
      `${blockedOrEmpty} blocked or empty, ${failed} failed (budget ${maxTerminalFailures}), ` +
      `${nonTerminal} nonterminal.${failureSamples}`
    );
  }
  return coverage;
}

export function isAutonomousCollectorTaskForRun(task, { runKey }) {
  const normalizedRunKey = String(runKey ?? "").trim();
  if (!normalizedRunKey) throw new Error("Collector task classification requires a run key.");
  const checkpointKey = String(task?.checkpoint_key ?? "").trim();
  const platform = String(task?.platform ?? "").trim();
  return checkpointKey.startsWith(`${normalizedRunKey}:`) && AUTONOMOUS_PLATFORMS.includes(platform);
}

export function partitionAutonomousTaskInventory(
  tasks,
  plannedTasks,
  { isSupersededTask = () => true } = {}
) {
  if (!Array.isArray(tasks) || !Array.isArray(plannedTasks)) {
    throw new TypeError("Durable tasks and planned tasks must both be arrays.");
  }
  if (typeof isSupersededTask !== "function") {
    throw new TypeError("Task inventory supersession classification must be a function.");
  }
  const plannedCheckpointKeys = new Set();
  for (const task of plannedTasks) {
    const checkpointKey = String(task?.checkpointKey ?? "").trim();
    if (!checkpointKey) throw new Error("Every planned ingestion task requires a checkpoint key.");
    if (plannedCheckpointKeys.has(checkpointKey)) {
      throw new Error(`The current ingestion plan contains duplicate checkpoint key ${checkpointKey}.`);
    }
    plannedCheckpointKeys.add(checkpointKey);
  }

  const currentTasks = [];
  const supersededTasks = [];
  const unrelatedTasks = [];
  const observedCurrentCheckpointKeys = new Set();
  for (const task of tasks) {
    const checkpointKey = String(task?.checkpoint_key ?? "").trim();
    if (!checkpointKey) throw new Error("Every durable ingestion task requires a checkpoint key.");
    if (plannedCheckpointKeys.has(checkpointKey)) {
      currentTasks.push(task);
      observedCurrentCheckpointKeys.add(checkpointKey);
    } else if (isSupersededTask(task)) {
      supersededTasks.push(task);
    } else {
      unrelatedTasks.push(task);
    }
  }

  return {
    currentTasks,
    supersededTasks,
    unrelatedTasks,
    missingCheckpointKeys: [...plannedCheckpointKeys]
      .filter((checkpointKey) => !observedCurrentCheckpointKeys.has(checkpointKey))
  };
}

export function validateAutonomousTerminalCoverage(coverage, { expectedTaskCount }) {
  if ((coverage?.expected ?? 0) !== expectedTaskCount) {
    throw new Error(
      `Task reconciliation covered ${coverage?.expected ?? 0}/${expectedTaskCount} planned tasks.`
    );
  }
  if ((coverage?.supersededNonTerminal ?? 0) > 0) {
    throw new Error(
      `${coverage.supersededNonTerminal} superseded same-slot ingestion tasks remain nonterminal.`
    );
  }
  if ((coverage?.nonTerminal ?? 0) > 0) {
    throw new Error(`${coverage.nonTerminal} ingestion tasks did not reach a terminal state.`);
  }
  return coverage;
}

export function validateAutonomousCollectorSnapshot(
  snapshot,
  {
    kind,
    batchSlug,
    expectedSourcePath = null,
    notBefore = null,
    notAfter = Date.now() + 60_000,
    requireAttemptBinding = false,
    expectedAttemptId = null,
    expectedCampaignKey = null,
    expectedExecutionNonce = null,
    expectedIdempotencyKey = null,
    expectedNotBefore = null
  }
) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error(`Invalid ${kind} collector snapshot: expected an object.`);
  }
  if (!snapshot.source || typeof snapshot.source !== "object" || Array.isArray(snapshot.source)) {
    throw new Error(`Invalid ${kind} collector snapshot: expected source metadata.`);
  }
  if (snapshot.source.batchSlug !== batchSlug) {
    throw new Error(
      `Invalid ${kind} collector snapshot: expected batch ${batchSlug}, received ${snapshot.source.batchSlug ?? "none"}.`
    );
  }
  if (typeof snapshot.source.label !== "string" || !snapshot.source.label.trim()) {
    throw new Error(`Invalid ${kind} collector snapshot: source label is required.`);
  }
  if (kind === "public" && snapshot.source.label !== "Public unauthenticated platform/page ingestion") {
    throw new Error(`Invalid public collector snapshot: unexpected source label ${snapshot.source.label}.`);
  }
  if (kind === "github" && !snapshot.source.label.startsWith("GitHub public API")) {
    throw new Error(`Invalid github collector snapshot: unexpected source label ${snapshot.source.label}.`);
  }
  if (expectedSourcePath && snapshot.source.sourcePath !== expectedSourcePath) {
    throw new Error(
      `Invalid ${kind} collector snapshot: expected source path ${expectedSourcePath}, received ${snapshot.source.sourcePath ?? "none"}.`
    );
  }
  const fetchedAt = Date.parse(snapshot.source.fetchedAt);
  if (!Number.isFinite(fetchedAt)) {
    throw new Error(`Invalid ${kind} collector snapshot: source fetchedAt must be a valid timestamp.`);
  }
  if (notBefore !== null && fetchedAt < notBefore) {
    throw new Error(`Invalid ${kind} collector snapshot: source fetchedAt predates this collector attempt.`);
  }
  if (notAfter !== null && fetchedAt > notAfter) {
    throw new Error(`Invalid ${kind} collector snapshot: source fetchedAt is in the future.`);
  }
  const attemptBinding = snapshot.source.autonomousAttempt;
  if (
    requireAttemptBinding ||
    expectedAttemptId !== null ||
    expectedCampaignKey !== null ||
    expectedExecutionNonce !== null ||
    expectedIdempotencyKey !== null ||
    expectedNotBefore !== null
  ) {
    validateCollectorAttemptBinding(attemptBinding, {
      kind,
      batchSlug,
      fetchedAt,
      notBefore,
      notAfter,
      expectedAttemptId,
      expectedCampaignKey,
      expectedExecutionNonce,
      expectedIdempotencyKey,
      expectedNotBefore
    });
  }

  const collections = kind === "github"
    ? [["accounts", snapshot.accounts]]
    : [
        ["evidence", snapshot.evidence],
        ["needsReview", snapshot.needsReview],
        ["failures", snapshot.failures]
      ];
  for (const [name, rows] of collections) {
    if (!Array.isArray(rows)) {
      throw new Error(`Invalid ${kind} collector snapshot: expected a ${name} array.`);
    }
    if (rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
      throw new Error(`Invalid ${kind} collector snapshot: ${name} must contain only objects.`);
    }
  }
  if (collections.reduce((count, [, rows]) => count + rows.length, 0) === 0) {
    throw new Error(`Invalid ${kind} collector snapshot: collector output is empty.`);
  }
  return snapshot;
}

function validateCollectorAttemptBinding(
  binding,
  {
    kind,
    batchSlug,
    fetchedAt,
    notBefore,
    notAfter,
    expectedAttemptId,
    expectedCampaignKey,
    expectedExecutionNonce,
    expectedIdempotencyKey,
    expectedNotBefore
  }
) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new Error(`Invalid ${kind} collector snapshot: source autonomousAttempt binding is required.`);
  }
  if (binding.schemaVersion !== 1) {
    throw new Error(`Invalid ${kind} collector snapshot: unsupported autonomousAttempt schema.`);
  }
  for (const key of ["attemptId", "campaignKey", "idempotencyKey", "executionNonce"]) {
    if (typeof binding[key] !== "string" || !binding[key].trim()) {
      throw new Error(`Invalid ${kind} collector snapshot: autonomousAttempt ${key} is required.`);
    }
  }
  if (binding.kind !== kind || binding.batchSlug !== batchSlug) {
    throw new Error(`Invalid ${kind} collector snapshot: autonomousAttempt scope does not match the snapshot.`);
  }
  if (expectedAttemptId !== null && binding.attemptId !== expectedAttemptId) {
    throw new Error(`Invalid ${kind} collector snapshot: autonomousAttempt belongs to a foreign attempt.`);
  }
  if (expectedCampaignKey !== null && binding.campaignKey !== expectedCampaignKey) {
    throw new Error(`Invalid ${kind} collector snapshot: autonomousAttempt belongs to a foreign campaign.`);
  }
  if (expectedExecutionNonce !== null && binding.executionNonce !== expectedExecutionNonce) {
    throw new Error(`Invalid ${kind} collector snapshot: autonomousAttempt belongs to a foreign execution.`);
  }
  if (expectedIdempotencyKey !== null && binding.idempotencyKey !== expectedIdempotencyKey) {
    throw new Error(`Invalid ${kind} collector snapshot: autonomousAttempt belongs to a foreign run.`);
  }
  const startedAt = Date.parse(binding.startedAt);
  const completedAt = Date.parse(binding.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
    throw new Error(`Invalid ${kind} collector snapshot: autonomousAttempt timestamps are invalid.`);
  }
  if (fetchedAt < startedAt - 2_000 || fetchedAt > completedAt + 60_000) {
    throw new Error(`Invalid ${kind} collector snapshot: fetchedAt falls outside its autonomousAttempt.`);
  }
  if (notBefore !== null && startedAt < notBefore - 2_000) {
    throw new Error(`Invalid ${kind} collector snapshot: autonomousAttempt started before this attempt window.`);
  }
  if (expectedNotBefore !== null) {
    const exactNotBefore = typeof expectedNotBefore === "number"
      ? new Date(expectedNotBefore).toISOString()
      : String(expectedNotBefore);
    if (binding.startedAt !== exactNotBefore) {
      throw new Error(`Invalid ${kind} collector snapshot: autonomousAttempt notBefore does not match its launch.`);
    }
  }
  if (notAfter !== null && completedAt > notAfter) {
    throw new Error(`Invalid ${kind} collector snapshot: autonomousAttempt completed in the future.`);
  }
}

export function validateAutonomousCollectorReferentialIntegrity(
  snapshot,
  { kind, batchSlug, catalog }
) {
  if (!catalog || catalog.slug !== batchSlug) {
    throw new Error(`Collector referential-integrity validation requires the ${batchSlug} catalog.`);
  }
  const companies = new Set(catalog.companies.map((company) => company.sourceKey));
  const founders = new Set(
    catalog.companies.flatMap((company) => company.founders.map((founder) => founder.sourceKey))
  );
  const collections = kind === "github"
    ? [
        ["accounts", snapshot.accounts ?? []],
        ["attempts", Object.values(snapshot.attempts ?? {})]
      ]
    : [
        ["evidence", snapshot.evidence ?? []],
        ["needsReview", snapshot.needsReview ?? []],
        ["failures", snapshot.failures ?? []]
      ];
  const invalid = [];

  for (const [collection, rows] of collections) {
    for (const row of rows) {
      const entityType = row.entityType ?? row.entity_type ?? "company";
      const entityId = row.entityId ?? row.entity_id ?? row.attachedCompanyId ?? null;
      const known = entityType === "founder" ? founders : companies;
      if (!entityId || !known.has(entityId)) {
        invalid.push({
          collection,
          field: "entityId",
          entityType,
          entityId,
          companySlug: row.companySlug ?? row.company_slug ?? null,
          platform: row.platform ?? null,
          url: row.sourceUrl ?? row.candidateUrl ?? row.githubUrl ?? row.url ?? null
        });
      }
      const attachedCompanyId = row.attachedCompanyId ?? row.attached_company_id ?? null;
      if (attachedCompanyId && !companies.has(attachedCompanyId)) {
        invalid.push({
          collection,
          field: "attachedCompanyId",
          entityType,
          entityId,
          attachedCompanyId,
          companySlug: row.companySlug ?? row.company_slug ?? null,
          platform: row.platform ?? null,
          url: row.sourceUrl ?? row.candidateUrl ?? row.githubUrl ?? row.url ?? null
        });
      }
    }
  }

  if (invalid.length) {
    throw new Error(
      `Invalid ${kind} collector snapshot: ${invalid.length} rows do not resolve to exact ${batchSlug} catalog entity IDs. ` +
      JSON.stringify(invalid.slice(0, 20))
    );
  }
  return snapshot;
}

export function countSuccessfulAutonomousCollectorRows(snapshot, kind) {
  if (kind === "github") {
    return (snapshot?.accounts ?? []).filter((account) => account.fetched === true).length;
  }
  return (snapshot?.evidence ?? []).filter(isSuccessfulPublicEvidenceRow).length;
}

const TERMINAL_COLLECTOR_OUTCOME_STATUSES = new Set([
  "completed",
  "needs_review",
  "blocked_or_empty",
  "failed"
]);
const TERMINAL_NEGATIVE_COLLECTOR_OUTCOME_STATUSES = new Set([
  "needs_review",
  "blocked_or_empty"
]);
const SUCCESSFUL_SOURCE_CHECK_STATUSES = new Set(["checked_empty", "found_candidates"]);
const MISSING_COLLECTOR_OUTCOME_REASONS = new Set([
  "collector_returned_no_account_attempt",
  "collector_returned_no_entity_attempt"
]);
const RETRYABLE_COLLECTOR_FAILURE_PATTERN =
  /(?:rate.?limit|secondary.?limit|forbidden|timeout|timed out|\babort(?:ed|error)?\b|\betimedout\b|network|fetch failed|econn|socket|temporar|unavailable)/i;
const RETRYABLE_COLLECTOR_HTTP_STATUS_PATTERN =
  /(?:\bhttp(?:[_ -]?status)?\s*[:=_/-]?\s*(?:403|408|425|429|5\d\d)\b|\bstatus(?: code)?\s*[:=_/-]?\s*(?:403|408|425|429|5\d\d)\b|\b403\s+forbidden\b|\b408\s+request timeout\b|\b425\s+too early\b|\b429\s+too many requests\b|\b5\d\d\s+(?:internal server error|bad gateway|service unavailable|gateway timeout)\b)/i;
const NON_RETRYABLE_COLLECTOR_FAILURE_PATTERN =
  /(?:not found|invalid (?:url|mapping|host|identity)|dead (?:url|mapping|account)|wrong host|host did not match|unsupported (?:owner )?url|referential)/i;
const NON_RETRYABLE_COLLECTOR_HTTP_STATUS_PATTERN =
  /(?:\bhttp(?:[_ -]?status)?\s*[:=_/-]?\s*(?:400|401|404|405|410|422)\b|\bstatus(?: code)?\s*[:=_/-]?\s*(?:400|401|404|405|410|422)\b|\b400\s+bad request\b|\b401\s+unauthori[sz]ed\b|\b404\s+not found\b|\b405\s+method not allowed\b|\b410\s+gone\b|\b422\s+unprocessable entity\b)/i;
const INTENTIONAL_INSTAGRAM_REVIEW_PATTERN =
  /(?:the mapped profile is a declared coauthor, not the native primary author|the post appeared on the profile surface without native owner or coauthor proof); queued for review and excluded from scored evidence\.?$/i;

export function isAutonomousCollectorFailureRetryable(message) {
  const normalized = String(message ?? "").trim();
  if (
    !normalized ||
    NON_RETRYABLE_COLLECTOR_FAILURE_PATTERN.test(normalized) ||
    NON_RETRYABLE_COLLECTOR_HTTP_STATUS_PATTERN.test(normalized)
  ) return false;
  return RETRYABLE_COLLECTOR_FAILURE_PATTERN.test(normalized) ||
    RETRYABLE_COLLECTOR_HTTP_STATUS_PATTERN.test(normalized);
}

export function autonomousCollectorRetryableFailures(snapshot) {
  const attempts = Object.entries(snapshot?.attempts ?? {}).map(([storedKey, attempt]) => {
    const batchPrefix = attempt?.batchSlug ? `${attempt.batchSlug}:` : "";
    const attemptKey = String(
      attempt?.attemptKey ??
      (batchPrefix && storedKey.startsWith(batchPrefix)
        ? storedKey.slice(batchPrefix.length)
        : storedKey)
    ).trim();
    return {
      ...attempt,
      attemptKey
    };
  });
  const attemptsByKey = new Map(
    attempts
      .filter((attempt) => attempt.attemptKey)
      .map((attempt) => [attempt.attemptKey, attempt])
  );
  const sourceChecks = snapshot?.source?.discovery?.sourceChecks ?? [];
  const attemptsByOwner = new Map(
    attempts
      .map((attempt) => [collectorOwnerKey(attempt), attempt])
      .filter(([key]) => Boolean(key))
      .reduce((groups, [key, attempt]) => {
        groups.set(key, [...(groups.get(key) ?? []), attempt]);
        return groups;
      }, new Map())
  );
  const sourceChecksByOwner = new Map();
  for (const check of sourceChecks) {
    const key = collectorOwnerKey(check);
    if (!key) continue;
    sourceChecksByOwner.set(key, [...(sourceChecksByOwner.get(key) ?? []), check]);
  }

  const explicitAttemptFailures = attempts
    .filter((attempt) => attempt.retryable === true)
    // A task-level terminal negative receipt is authoritative even when an
    // older collector persisted retryable=true from transport-shaped
    // diagnostic text. Replaying an explicit blocked/review outcome cannot
    // improve terminal coverage. Completed partial interruptions and failed
    // attempts retain their existing retry behavior.
    .filter((attempt) => !isExplicitTerminalNegativeCollectorAttempt(attempt))
    .filter((attempt) => !isIntentionalInstagramReviewAttempt(attempt))
    .map((attempt) =>
      attempt.error ??
      attempt.failureReason ??
      `Retryable collector attempt ${attempt.attemptKey || collectorOwnerKey(attempt) || "unknown"}`
    );
  const sourceCheckFailures = sourceChecks
    .filter((check) => check.status === "failed")
    .filter((check) => !suppressDeterministicProfileNotFoundRetry(
      check,
      newestCollectorAttempt(attemptsByOwner.get(collectorOwnerKey(check)) ?? []),
      sourceChecksByOwner.get(collectorOwnerKey(check)) ?? []
    ))
    .filter((check) => collectorFailureRetryDecision(check, attemptsByKey, attemptsByOwner) !== false)
    .map((check) => check.error);
  const messages = [
    ...explicitAttemptFailures,
    ...(snapshot?.failures ?? [])
      .filter((failure) => collectorFailureRetryDecision(failure, attemptsByKey, attemptsByOwner) !== false)
      .map((failure) => failure.message ?? failure.error),
    ...(snapshot?.accounts ?? [])
      .filter((account) => account.fetched === false)
      .filter((account) => collectorFailureRetryDecision(account, attemptsByKey, attemptsByOwner) !== false)
      .map((account) => account.error),
    ...(snapshot?.source?.discovery?.searchFailures ?? []).map((failure) => failure.error ?? failure.message),
    ...sourceCheckFailures
  ];
  return [...new Set(
    messages
      .map((message) => String(message ?? "").trim())
      .filter(Boolean)
      .filter((message) => isAutonomousCollectorFailureRetryable(message) ||
        explicitAttemptFailures.includes(message))
  )];
}

function collectorFailureRetryDecision(row, attemptsByKey, attemptsByOwner) {
  const attemptKey = String(row?.attemptKey ?? row?.attempt_key ?? "").trim();
  const exactAttempt = attemptKey ? attemptsByKey.get(attemptKey) : null;
  if (isExplicitTerminalNegativeCollectorAttempt(exactAttempt)) return false;
  if (isIntentionalInstagramReviewAttempt(exactAttempt)) return false;
  if (typeof row?.retryable === "boolean") return row.retryable;
  if (typeof exactAttempt?.retryable === "boolean") return exactAttempt.retryable;

  const ownerAttempts = attemptsByOwner.get(collectorOwnerKey(row)) ?? [];
  const accountUrl = canonicalCollectorFailureAccountUrl(row);
  const matchingAttempts = accountUrl
    ? ownerAttempts.filter((attempt) =>
        canonicalCollectorFailureAccountUrl(attempt) === accountUrl
      )
    : ownerAttempts;
  const explicit = matchingAttempts
    .filter((attempt) => !isExplicitTerminalNegativeCollectorAttempt(attempt))
    .filter((attempt) => typeof attempt.retryable === "boolean");
  if (!explicit.length) return null;
  return explicit.some((attempt) =>
    attempt.retryable === true && !isIntentionalInstagramReviewAttempt(attempt)
  );
}

function isExplicitTerminalNegativeCollectorAttempt(attempt) {
  if (!TERMINAL_NEGATIVE_COLLECTOR_OUTCOME_STATUSES.has(attempt?.outcomeStatus)) return false;
  const reason = nonEmptyCollectorReason(attempt?.error ?? attempt?.outcomeReason);
  return Boolean(reason) && !MISSING_COLLECTOR_OUTCOME_REASONS.has(reason);
}

function isIntentionalInstagramReviewAttempt(attempt) {
  if (
    attempt?.platform !== "instagram" ||
    !["completed", "needs_review"].includes(attempt?.outcomeStatus) ||
    !["collector_evidence_collected", "collector_needs_review"].includes(attempt?.outcomeReason)
  ) return false;
  const message = String(attempt?.error ?? attempt?.failureReason ?? "").trim();
  return INTENTIONAL_INSTAGRAM_REVIEW_PATTERN.test(message) &&
    !isAutonomousCollectorFailureRetryable(message);
}

function canonicalCollectorFailureAccountUrl(row) {
  const raw = row?.accountUrl ?? row?.account_url ?? row?.githubUrl ?? row?.url ?? null;
  if (!raw) return null;
  const canonicalUrl = canonicalSocialAccountUrl(
    normalizePlatform(row?.platform ?? "github"),
    raw
  );
  return canonicalUrl?.toLowerCase() ?? null;
}

function newestCollectorAttempt(attempts) {
  return [...attempts].sort(
    (left, right) =>
      (Date.parse(right?.checkedAt ?? "") || 0) -
      (Date.parse(left?.checkedAt ?? "") || 0)
  )[0] ?? null;
}

export function summarizeAutonomousCollectorTerminalTaskCoverage(
  snapshot,
  { kind, batchSlug, tasks }
) {
  const relevantTasks = (tasks ?? []).filter((task) =>
    task?.batchSlug === batchSlug &&
    task?.status === "queued" &&
    (kind === "github" ? task.platform === "github" : task.platform !== "github")
  );
  const outcomeIndex = indexAutonomousCollectorTaskOutcomes(snapshot, {
    kind,
    batchSlug,
    explicitTerminalOnly: true
  });
  const summary = {
    expected: relevantTasks.length,
    terminal: 0,
    nonTerminal: 0,
    byStatus: {
      completed: 0,
      needs_review: 0,
      blocked_or_empty: 0,
      failed: 0
    },
    nonTerminalTaskSamples: []
  };

  for (const task of relevantTasks) {
    const outcome = classifyAutonomousCollectorTaskOutcome(outcomeIndex, {
      platform: task.platform,
      entityType: task.entityType,
      entityId: task.entitySourceKey,
      accountUrl: task.account?.url ?? null
    });
    const reason = nonEmptyCollectorReason(outcome.reason);
    const isExplicitTerminal =
      TERMINAL_COLLECTOR_OUTCOME_STATUSES.has(outcome.status) &&
      Boolean(reason) &&
      !MISSING_COLLECTOR_OUTCOME_REASONS.has(reason);
    if (isExplicitTerminal) {
      summary.terminal += 1;
      summary.byStatus[outcome.status] += 1;
      continue;
    }
    summary.nonTerminal += 1;
    if (summary.nonTerminalTaskSamples.length < 20) {
      summary.nonTerminalTaskSamples.push({
        platform: task.platform,
        entityType: task.entityType,
        entityId: task.entitySourceKey,
        accountUrl: task.account?.url ?? null,
        status: outcome.status,
        reason: outcome.reason
      });
    }
  }
  return summary;
}

export function indexAutonomousCollectorTaskOutcomes(
  snapshot,
  { kind, batchSlug, explicitTerminalOnly = false }
) {
  const outcomes = new Map();
  const record = (row, platform, status, reason, accountUrl = null, metadata = {}) => {
    const entityType = row?.entityType ?? "company";
    const rawEntityId = row?.entityId ?? row?.attachedCompanyId ?? row?.companySlug ?? row?.companyName;
    const entityId = normalizeAutonomousFailureEntityId(
      { ...row, entityType, entityId: rawEntityId },
      { batchSlug }
    );
    if (!entityId) return;
    const candidate = { status, reason, ...metadata };
    const entityKey = autonomousCollectorEntityKey(platform, entityType, entityId);
    const resolvedAccountUrl = accountUrl ?? row?.accountUrl ?? row?.account_url ?? null;
    const accountKey = resolvedAccountUrl
      ? autonomousCollectorAccountKey(platform, entityType, entityId, resolvedAccountUrl)
      : null;
    // An unsafe or malformed mapped URL is not an owner-level receipt. Dropping
    // it here prevents a rejected account identity from inheriting blocker
    // metadata into either another mapped account or the discovery task.
    if (resolvedAccountUrl && !accountKey) return;
    const keys = [{ key: entityKey, exactTaskKey: !resolvedAccountUrl }];
    if (accountKey) {
      keys.push({
        key: accountKey,
        exactTaskKey: true
      });
    }
    for (const { key, exactTaskKey } of keys) {
      const previous = outcomes.get(key);
      const scopedCandidate = {
        ...candidate,
        exactTypedReceipt: candidate.exactTypedReceipt === true && exactTaskKey
      };
      const selected = !previous || shouldReplaceCollectorOutcome(previous, scopedCandidate)
        ? scopedCandidate
        : previous;
      const other = selected === scopedCandidate ? previous : scopedCandidate;
      outcomes.set(key, preserveCollectorBlockerMetadata(other, selected));
    }
  };

  if (kind === "github") {
    for (const account of snapshot?.accounts ?? []) {
      const exactFailureReason = nonEmptyCollectorReason(account.error);
      if (
        explicitTerminalOnly &&
        account.fetched !== true &&
        (account.fetched !== false || !exactFailureReason)
      ) {
        continue;
      }
      record(
        account,
        "github",
        account.fetched === true ? "completed" : "failed",
        account.fetched === true
          ? "collector_account_fetched"
          : explicitTerminalOnly
            ? exactFailureReason
            : "collector_reported_failure",
        account.githubUrl ?? account.url ?? null
      );
    }
    for (const attempt of Object.values(snapshot?.attempts ?? {})) {
      if (!attempt?.entityId) continue;
      const terminalStatus = TERMINAL_COLLECTOR_OUTCOME_STATUSES.has(attempt.outcomeStatus)
        ? attempt.outcomeStatus
        : null;
      const exactReason = nonEmptyCollectorReason(attempt.error ?? attempt.outcomeReason);
      if (explicitTerminalOnly && (!terminalStatus || !exactReason)) continue;
      const status = terminalStatus ?? "failed";
      record(
        attempt,
        "github",
        status,
        explicitTerminalOnly
          ? exactReason
          : attempt.outcomeReason ?? "collector_owner_discovery_attempted"
      );
    }
    return outcomes;
  }

  for (const evidence of snapshot?.evidence ?? []) {
    const successful = isSuccessfulPublicEvidenceRow(evidence);
    const needsReview = ["needs_review", "rejected"].includes(evidence?.review_state);
    record(
      evidence,
      evidence.platform,
      successful ? "completed" : needsReview ? "needs_review" : "blocked_or_empty",
      successful
        ? "collector_evidence_collected"
        : needsReview
          ? "collector_needs_review"
          : "collector_context_only",
      null,
      { validatedCompletedEvidence: successful }
    );
  }
  for (const review of snapshot?.needsReview ?? []) {
    record(
      review,
      review.platform,
      "needs_review",
      "collector_needs_review"
    );
  }
  const providerBlockerAttemptsByKey = new Map();
  for (const attempt of Object.values(snapshot?.attempts ?? {})) {
    if (!attempt?.attemptKey) continue;
    const key = String(attempt.attemptKey);
    const attempts = providerBlockerAttemptsByKey.get(key) ?? [];
    attempts.push(attempt);
    providerBlockerAttemptsByKey.set(key, attempts);
  }
  for (const failure of snapshot?.failures ?? []) {
    const exactFailureReason = nonEmptyCollectorReason(failure.message ?? failure.error);
    if (explicitTerminalOnly && !exactFailureReason) continue;
    const matchingBlockerAttempts = (
      providerBlockerAttemptsByKey.get(String(failure?.attemptKey ?? "")) ?? []
    ).filter((attempt) =>
      collectorAttemptMatchesFailureIdentity(attempt, failure, batchSlug) &&
      TERMINAL_COLLECTOR_OUTCOME_STATUSES.has(attempt.outcomeStatus) &&
      nonEmptyCollectorReason(attempt.error ?? attempt.outcomeReason) &&
      isAutonomousProviderBlocker(attempt.blocker, { platform: attempt.platform }) &&
      isAutonomousProviderBlocker(failure?.blocker, { platform: failure.platform }) &&
      sameAutonomousProviderBlocker(failure.blocker, attempt.blocker)
    );
    const candidateProviderBlocker = matchingBlockerAttempts.length === 1
      ? matchingBlockerAttempts[0].blocker
      : null;
    const typedProviderBlocker = isDeterministicPublicMappingFailure(failure, {
      trustedProviderBlocker: Boolean(candidateProviderBlocker)
    })
      ? null
      : candidateProviderBlocker;
    const providerBlocked = Boolean(typedProviderBlocker);
    const expectedEmpty = providerBlocked || isExpectedPublicAccessOrEmptyFailure(failure);
    record(
      failure,
      failure.platform,
      expectedEmpty ? "blocked_or_empty" : "failed",
      explicitTerminalOnly
        ? exactFailureReason
        : expectedEmpty
          ? "collector_checked_blocked_or_empty"
          : "collector_reported_failure",
      null,
      providerBlocked
        ? {
            incidentalRawFailure: true,
            providerBlocked: true,
            providerBlockerReason: typedProviderBlockerReason(
              typedProviderBlocker,
              failure.platform
            )
          }
        : {
            incidentalRawFailure: expectedEmpty,
            hardRawFailure: !expectedEmpty
          }
    );
  }
  for (const attempt of Object.values(snapshot?.attempts ?? {})) {
    if (!attempt?.entityId || !attempt?.platform) continue;
    const sameKeyAttempts = providerBlockerAttemptsByKey.get(String(attempt?.attemptKey ?? "")) ?? [];
    const providerBlocker = sameKeyAttempts.length === 1 &&
      isAutonomousProviderBlocker(attempt?.blocker, { platform: attempt.platform })
      ? attempt.blocker
      : null;
    const terminalStatus = providerBlocker && attempt.outcomeStatus === "failed"
      ? "blocked_or_empty"
      : TERMINAL_COLLECTOR_OUTCOME_STATUSES.has(attempt.outcomeStatus)
        ? attempt.outcomeStatus
        : null;
    const exactReason = nonEmptyCollectorReason(attempt.error ?? attempt.outcomeReason);
    if (explicitTerminalOnly && (!terminalStatus || !exactReason)) continue;
    // URL-less social discovery is a real queued task. Once the collector has
    // written an explicit terminal status and reason for that owner/platform,
    // index it just like a mapped-account attempt. Older URL-less checkpoint
    // rows without the explicit terminal receipt remain nonterminal.
    if (!attempt.accountUrl && (!terminalStatus || !exactReason)) continue;
    const status = terminalStatus ?? (attempt.status === "failed"
      ? (isExpectedPublicAccessOrEmptyFailure(attempt) ? "blocked_or_empty" : "failed")
      : "blocked_or_empty");
    record(
      attempt,
      attempt.platform,
      status,
      explicitTerminalOnly
        ? exactReason
        : attempt.outcomeReason ?? (status === "failed"
          ? "collector_reported_failure"
          : "collector_account_attempted"),
      attempt.accountUrl,
      providerBlocker
        ? {
            exactTypedReceipt: Boolean(terminalStatus && exactReason),
            providerBlocked: true,
            providerBlockerReason: typedProviderBlockerReason(providerBlocker, attempt.platform)
          }
        : { exactTypedReceipt: Boolean(terminalStatus && exactReason) }
    );
  }
  return outcomes;
}

export function classifyAutonomousCollectorTaskOutcome(
  outcomeIndex,
  { platform, entityType, entityId, accountUrl = null, collectorOk = true, collectorError = null }
) {
  const normalizedPlatform = normalizePlatform(platform);
  const accountKey = accountUrl
    ? autonomousCollectorAccountKey(platform, entityType, entityId, accountUrl)
    : null;
  if (accountUrl && !accountKey) {
    return { status: "failed", reason: "collector_invalid_account_url" };
  }
  const key = accountKey ?? autonomousCollectorEntityKey(platform, entityType, entityId);
  const outcome = outcomeIndex?.get(key);
  if (outcome) return collectorOutcomePublicView(outcome);
  // A process-level retry failure is not evidence that every task in the
  // collector failed. Sharded collectors durably flush task-level receipts
  // before the runner evaluates coverage, so preserve those exact outcomes
  // and apply the process failure only to tasks absent from the snapshot.
  if (!collectorOk) {
    return { status: "failed", reason: collectorError ?? "collector_process_failed" };
  }
  if (accountUrl) {
    return {
      status: "nonterminal",
      reason: "collector_returned_no_account_attempt"
    };
  }
  if (normalizedPlatform === "github" && outcomeIndex) {
    return {
      status: "blocked_or_empty",
      reason: "collector_checked_no_github_mapping"
    };
  }
  return {
    status: "nonterminal",
    reason: "collector_returned_no_entity_attempt"
  };
}

export function autonomousCollectorEntityKey(platform, entityType, entityId) {
  return `${normalizePlatform(platform)}:${entityType ?? "company"}:${normalizeIdentity(entityId)}`;
}

export function autonomousCollectorAccountKey(platform, entityType, entityId, accountUrl) {
  const normalizedPlatform = normalizePlatform(platform);
  const canonicalUrl = canonicalSocialAccountUrl(normalizedPlatform, accountUrl);
  if (!canonicalUrl) return null;
  return `${autonomousCollectorEntityKey(normalizedPlatform, entityType, entityId)}:account:${canonicalUrl.toLowerCase()}`;
}

function collectorOwnerKey(row) {
  const entityId = String(row?.entityId ?? "").trim();
  if (!entityId) return null;
  return `${row?.entityType ?? "company"}:${entityId}`;
}

function nonEmptyCollectorReason(value) {
  const reason = String(value ?? "").trim();
  return reason || null;
}

function suppressDeterministicProfileNotFoundRetry(check, attempt, ownerSourceChecks) {
  if (check?.sourceKind !== "official_profile") return false;
  if (!/(?:\b404\b|not found)/i.test(String(check?.error ?? ""))) return false;
  if (
    !TERMINAL_COLLECTOR_OUTCOME_STATUSES.has(attempt?.outcomeStatus) ||
    !nonEmptyCollectorReason(attempt?.outcomeReason)
  ) {
    return false;
  }
  return ownerSourceChecks.some((candidate) =>
    candidate !== check &&
    candidate?.sourceKind !== check.sourceKind &&
    SUCCESSFUL_SOURCE_CHECK_STATUSES.has(candidate?.status)
  );
}

export function normalizeAutonomousFailureEntityId(failure, { batchSlug }) {
  const rawEntityId = failure?.entityId ?? failure?.companyName ?? failure?.companySlug;
  if (batchSlug !== "A16ZSR006") return rawEntityId;

  // Public collector receipts already use the canonical A16Z task-plan IDs. Do
  // not reinterpret a canonical founder ID as a company slug when a legacy row
  // omits companySlug; doing so duplicates the whole ID inside the founder ID.
  const canonicalEntityId = String(rawEntityId ?? "").trim();
  if (/^a16z-speedrun-006-[a-z0-9][a-z0-9-]*$/.test(canonicalEntityId)) {
    return canonicalEntityId;
  }

  const companySlug = slugify(
    failure?.companySlug ?? String(rawEntityId ?? "").replace(/^(?:company-|a16z-speedrun-006-)/, "")
  );
  if (!companySlug) return rawEntityId;
  if ((failure?.entityType ?? "company") === "company") {
    return `a16z-speedrun-006-${companySlug}`;
  }

  const planPrefix = `a16z-speedrun-006-${companySlug}-founder-`;
  const embeddedPlanIdIndex = String(rawEntityId ?? "").indexOf(planPrefix);
  if (embeddedPlanIdIndex >= 0) return String(rawEntityId).slice(embeddedPlanIdIndex);
  const founderSlug = slugify(failure?.entityName);
  return founderSlug ? `${planPrefix}${founderSlug}` : rawEntityId;
}

export function mergePublicEvidenceSnapshots(
  snapshots,
  {
    fetchedAt = new Date().toISOString(),
    durableStorageConfigured = true,
    resolveBatchSlug = null,
    resolveNativeAuthor = null,
    contentIdentityReferenceRows = [],
    allowVerifiedMetriclessEvidence = null,
    allowVerifiedContextEvidence = null
  } = {}
) {
  const acceptedEvidence = [];
  const quarantinedEvidence = [];
  const reconciliationCandidates = [];
  const acceptedOrigins = new Map();
  for (const snapshot of snapshots) {
    reconciliationCandidates.push(...(snapshot.attributionReconciliationLedger ?? []));
    for (const sourceRow of snapshot.evidence ?? []) {
      const originalRow = withSnapshotRowBatch(sourceRow, snapshot, resolveBatchSlug);
      const canonicalCompanyReassignment = typeof resolveNativeAuthor === "function"
        ? canonicalMergedCompanyAttribution(originalRow, resolveNativeAuthor)
        : null;
      const canonicalRosterRow = canonicalCompanyReassignment?.row ?? originalRow;
      // Promotion receipts bind to the exact persisted row. Resolve their
      // exceptions before replay refreshes native-author metadata; otherwise
      // a fresh canonical resolver can overwrite receipt fields and silently
      // re-quarantine an already accepted metricless row.
      const verifiedMetriclessEvidence =
        typeof allowVerifiedMetriclessEvidence === "function" &&
        allowVerifiedMetriclessEvidence(originalRow, { snapshot });
      const verifiedContextEvidence =
        typeof allowVerifiedContextEvidence === "function" &&
        allowVerifiedContextEvidence(originalRow, { snapshot });
      const freshNativeAuthorResolution = typeof resolveNativeAuthor === "function"
        ? resolveNativeAuthor(canonicalRosterRow)
        : null;
      const nativeAuthorResolution = replayStableNativeAuthorResolution(
        canonicalRosterRow,
        freshNativeAuthorResolution
      );
      const nativeResolutionRow = nativeAuthorResolution
        ? { ...canonicalRosterRow, nativeAuthorResolution }
        : canonicalRosterRow;
      const companySubjectReassignment = typeof resolveNativeAuthor === "function"
        ? mergedFounderToCompanySubjectReassignment(
            nativeResolutionRow,
            resolveNativeAuthor,
            nativeAuthorResolution
          )
        : null;
      const shouldReassign = !companySubjectReassignment &&
        nativeAuthorResolution?.status === "matched" &&
        shouldReassignMergedPublicRow(canonicalRosterRow, resolveNativeAuthor, nativeAuthorResolution);
      const nativeResolvedRow = shouldReassign
        ? applyResolvedNativeAuthor(canonicalRosterRow, nativeAuthorResolution)
        : nativeResolutionRow;
      const row = companySubjectReassignment?.row ?? nativeResolvedRow;
      const promotionAttributionStable = samePublicAttribution(
        publicAttribution(originalRow),
        publicAttribution(row)
      );
      const preserveVerifiedPromotionRow = promotionAttributionStable &&
        (verifiedMetriclessEvidence || verifiedContextEvidence);
      const validation = validateMergedPublicEvidence(row, {
        resolveNativeAuthor,
        nativeAuthorResolution,
        verifiedMetriclessEvidence: promotionAttributionStable && verifiedMetriclessEvidence,
        verifiedContextEvidence: promotionAttributionStable && verifiedContextEvidence
      });
      if (validation.ok) {
        // Signed promotion rows are append-only receipts. Current resolver
        // checks still run above, but a same-owner replay must not rewrite the
        // exact URL, native-author receipt, provenance, or trust signals that
        // the promotion gate cryptographically validated.
        const acceptedRow = preserveVerifiedPromotionRow
          ? originalRow
          : validation.row;
        acceptedEvidence.push(acceptedRow);
        acceptedOrigins.set(reconciliationPhysicalAttributionIdentity(
          reconciliationPhysicalIdentity(acceptedRow),
          publicAttribution(acceptedRow)
        ), originalRow);
        if (!samePublicAttribution(publicAttribution(originalRow), publicAttribution(acceptedRow))) {
          reconciliationCandidates.push(reconciliationCandidate(
            originalRow,
            acceptedRow,
            "reattributed",
            companySubjectReassignment?.reason ??
              canonicalCompanyReassignment?.reason ??
              nativeAuthorResolution?.reason ??
              "canonical_native_author_reassignment"
          ));
        }
      } else {
        quarantinedEvidence.push(quarantinedPublicEvidence(row, validation.reasons));
        if (validation.reconciliationEligible) {
          reconciliationCandidates.push(reconciliationCandidate(
            originalRow,
            null,
            "quarantined",
            validation.reasons.join(";")
          ));
        }
      }
    }
    for (const sourceReviewRow of snapshot.needsReview ?? []) {
      const reviewRow = withSnapshotReviewBatch(sourceReviewRow, snapshot, resolveBatchSlug);
      const directive = reviewRow?.attributionReconciliationDirective;
      if (!directive) continue;
      reconciliationCandidates.push(explicitReviewReconciliationCandidate(reviewRow, directive));
    }
  }
  const contentReconciliation = reconcileMergedPublicContentIdentities(
    acceptedEvidence,
    contentIdentityReferenceRows,
    resolveBatchSlug
  );
  // Refreshes and URL aliases for one exact attribution are ordinary updates,
  // not review-worthy duplicates. Collapse those first, then prevent only a
  // distinct company/founder attribution in the same company rollup from
  // scoring the same physical post twice.
  const attributionDedupedEvidence = dedupeRows(contentReconciliation.evidence, evidenceKey);
  const physicalRollupReconciliation = reconcileMergedPublicRollupPhysicalIdentities(
    attributionDedupedEvidence
  );
  const duplicateEvidence = [
    ...contentReconciliation.duplicates,
    ...physicalRollupReconciliation.duplicates
  ];
  const duplicateReplacementTargets = new Set();
  for (const duplicate of duplicateEvidence) {
    const duplicateTarget = reconciliationPhysicalAttributionIdentity(
      reconciliationPhysicalIdentity(duplicate.row),
      publicAttribution(duplicate.row)
    );
    if (duplicateTarget) duplicateReplacementTargets.add(duplicateTarget);
    quarantinedEvidence.push(quarantinedPublicEvidence(
      duplicate.row,
      [duplicate.reason],
      {
        duplicateOf: {
          id: duplicate.duplicateOf?.id ?? null,
          sourceUrl: duplicate.duplicateOf?.sourceUrl ?? null,
          platformPostId: duplicate.duplicateOf?.platformPostId ?? null
        },
        contentBodySha256: duplicate.contentIdentity?.bodySha256 ?? null
      }
    ));
    if ([
      "same_platform_author_substantive_body",
      "same_rollup_physical_post_identity"
    ].includes(duplicate.reason)) {
      const originalRow = acceptedOrigins.get(duplicateTarget) ?? duplicate.row;
      reconciliationCandidates.push(reconciliationCandidate(
        originalRow,
        null,
        "quarantined",
        duplicate.reason
      ));
    }
  }
  const evidence = physicalRollupReconciliation.evidence;
  const attributionReconciliationLedger = finalizeAttributionReconciliationLedger(
    reconciliationCandidates.filter((candidate) =>
      candidate?.disposition !== "reattributed" ||
      !duplicateReplacementTargets.has(reconciliationPhysicalAttributionIdentity(
        reconciliationPhysicalIdentity(candidate),
        candidate.replacementAttribution
      ))
    ),
    evidence
  );
  const acceptedReviewResolutions = new Map(
    evidence.flatMap((row) => {
      const sourceEvidenceId = String(row?.id ?? "").trim();
      const physicalIdentity = reconciliationPhysicalIdentity(row);
      return sourceEvidenceId && physicalIdentity
        ? [[`${rowBatchScope(row)}:${sourceEvidenceId}`, physicalIdentity]]
        : [];
    })
  );
  const needsReview = dedupeReviewRows(
    [
      ...snapshots.flatMap((snapshot) =>
        (snapshot.needsReview ?? []).map((row) => withSnapshotReviewBatch(row, snapshot, resolveBatchSlug))
      ),
      ...quarantinedEvidence
    ],
    reviewEvidenceKey
  )
    .filter((row) => {
      // A later canonical roster can resolve a previously quarantined source
      // row (for example, after its native author joins the mutable cohort).
      // Remove only that exact source-row/physical-post quarantine; unrelated
      // reviews for the same URL or another batch remain fail-closed.
      const sourceEvidenceId = String(row?.sourceEvidenceId ?? "").trim();
      if (!sourceEvidenceId) return true;
      const acceptedPhysicalIdentity = acceptedReviewResolutions.get(
        `${rowBatchScope(row)}:${sourceEvidenceId}`
      );
      return !acceptedPhysicalIdentity ||
        acceptedPhysicalIdentity !== reconciliationPhysicalIdentity(row);
    })
    .map(stableJsonObjectKeyOrder);
  const failures = dedupeOperationalRows(
    snapshots.flatMap((snapshot) =>
      (snapshot.failures ?? []).map((row) => withSnapshotRowBatch(row, snapshot, resolveBatchSlug))
    ),
    (row) => `${rowBatchScope(row)}:${row.id ?? `${row.platform}:${row.companySlug}:${row.sourceUrl ?? ""}:${row.message ?? ""}`}`
  );
  const discoveryAttempts = dedupeOperationalRows(
    snapshots.flatMap((snapshot) => snapshot.discoveryAttempts ?? []),
    (row) => row.id ?? `${row.batch_slug ?? row.batchSlug}:${row.entityId}:${row.platform}:${row.query}:${row.selected_url ?? ""}`
  );
  const sourceDiscoveryPaths = dedupeOperationalRows(
    snapshots.flatMap((snapshot) => snapshot.sourceDiscoveryPaths ?? []),
    (row) => row.id ?? `${row.batch_slug ?? row.batchSlug}:${row.discovered_entity_id}:${row.source_url}:${row.discovered_url}`
  );
  const attempts = mergePublicCollectorAttempts(snapshots);
  const mergedSnapshot = {
    source: {
      label: "Autonomous public ingestion merged export",
      fetchedAt,
      batchSlugs: [...new Set(snapshots.flatMap(snapshotBatchSlugs))],
      evidenceCount: evidence.length,
      needsReviewCount: needsReview.length,
      quarantinedEvidenceCount: quarantinedEvidence.length,
      duplicateContentEvidenceCount: contentReconciliation.duplicates.filter(
        (row) => row.reason === "same_platform_author_substantive_body"
      ).length,
      duplicatePhysicalEvidenceCount: physicalRollupReconciliation.duplicates.length,
      attributionReconciliationCount: attributionReconciliationLedger.length,
      failureCount: failures.length,
      discoveryAttemptCount: discoveryAttempts.length,
      sourceDiscoveryPathCount: sourceDiscoveryPaths.length,
      attemptCount: Object.keys(attempts).length,
      notes: [
        durableStorageConfigured
          ? "Generated export only; this run also imported validated evidence into durable Supabase tables."
          : "Durable Supabase import was skipped because complete optional credentials were not configured; this export is file-backed.",
        "Accepted rows are batch-scoped and deduplicated by entity attribution plus strict platform-native physical post identity before publication.",
        "Unsupported, non-native, metricless, unverified, invalid-link, and identity-conflicting rows are preserved in needsReview with exact quarantine reasons; separately verified zero-score first-party context retains its canonical URL identity."
      ]
    },
    evidence,
    attributionReconciliationLedger,
    needsReview,
    failures,
    attempts,
    discoveryAttempts,
    sourceDiscoveryPaths
  };
  return applyPublicEvidenceOperationalRetention(mergedSnapshot, {
    priorRetentionMetadata: snapshots
      .map((snapshot) => snapshot?.source?.operationalRetention)
      .filter(Boolean)
  });
}

function mergePublicCollectorAttempts(snapshots) {
  const attempts = new Map();
  for (const snapshot of snapshots) {
    for (const [storedKey, sourceAttempt] of Object.entries(snapshot.attempts ?? {})) {
      const batchSlug = String(
        sourceAttempt?.batchSlug ??
        snapshot?.source?.batchSlug ??
        ""
      ).trim();
      if (!batchSlug) continue;
      const prefixedKey = `${batchSlug}:`;
      const attemptKey = String(
        sourceAttempt?.attemptKey ??
        (storedKey.startsWith(prefixedKey) ? storedKey.slice(prefixedKey.length) : storedKey)
      ).trim();
      if (!attemptKey) continue;
      const canonicalKey = `${batchSlug}:${attemptKey}`;
      const candidate = {
        ...sourceAttempt,
        attemptKey,
        batchSlug
      };
      const previous = attempts.get(canonicalKey);
      const candidateCheckedAt = Date.parse(candidate.checkedAt ?? "") || 0;
      const previousCheckedAt = Date.parse(previous?.checkedAt ?? "") || 0;
      if (
        !previous ||
        candidateCheckedAt > previousCheckedAt ||
        (
          candidateCheckedAt === previousCheckedAt &&
          JSON.stringify(stableJsonObjectKeyOrder(candidate)).localeCompare(
            JSON.stringify(stableJsonObjectKeyOrder(previous))
          ) >= 0
        )
      ) {
        attempts.set(canonicalKey, candidate);
      }
    }
  }
  return Object.fromEntries([...attempts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeCompanyNode(node, batch) {
  return {
    entityType: "company",
    sourceKey: node.entityId,
    name: node.label,
    batchSlug: batch.slug,
    profileUrl: node.ycProfileUrl ?? node.sourceUrl ?? null,
    websiteUrl: node.websiteUrl ?? null,
    tagline: node.tagline ?? null,
    description: node.description ?? null,
    groupPartner: node.groupPartner ?? null,
    reviewState: node.review_state ?? "needs_review",
    accounts: normalizeAccounts(node.socialAccounts),
    founders: (node.founders ?? []).map((founder) => ({
      entityType: "founder",
      sourceKey: founder.id,
      name: founder.name,
      batchSlug: batch.slug,
      companySourceKey: node.entityId,
      profileUrl: founder.ycProfileUrl ?? null,
      websiteUrl: founder.websiteUrl ?? null,
      reviewState: founder.review_state ?? "verified",
      accounts: normalizeAccounts(founder.socialAccounts)
    }))
  };
}

function normalizeYcCompany(company, batch, aliasLedger = null) {
  if (!company?.slug || !company?.name) {
    throw new Error(`${batch.catalogFile} contains a company without a slug and name.`);
  }
  const sourceKey = `company-${company.slug}`;
  const profileUrl = company.ycProfileUrl ?? null;
  const companyAliasEntries = (aliasLedger?.aliases ?? []).filter((entry) =>
    String(entry?.companyId ?? "") === String(company?.id ?? "")
  );
  const legacyEntityAliases = uniqueCatalogAliases(companyAliasEntries.flatMap((entry) => [
    entry?.fromSlug,
    entry?.fromName,
    entry?.fromSlug ? `company-${entry.fromSlug}` : null
  ]));
  const historicalFounders = normalizeRemovedYcFounders(company, batch, aliasLedger);
  return {
    entityType: "company",
    sourceKey,
    name: company.name,
    batchSlug: batch.slug,
    profileUrl,
    websiteUrl: company.websiteUrl ?? null,
    tagline: company.tagline ?? null,
    description: company.description ?? null,
    groupPartner: company.groupPartner ?? null,
    reviewState: "verified",
    legacyEntityAliases,
    historicalFounders,
    accounts: normalizeYcAccounts(company.socialLinks, {
      entityType: "company",
      entitySourceKey: sourceKey,
      discoveredFromUrl: profileUrl
    }),
    founders: (company.founders ?? []).map((founder) =>
      normalizeYcFounder(founder, company, batch, companyAliasEntries)
    )
  };
}

function normalizeRemovedYcFounders(company, batch, aliasLedger = null) {
  const currentFounderIds = new Set(
    (company.founders ?? []).map((founder) => String(founder?.id ?? "")).filter(Boolean)
  );
  const transitionsByFounderId = new Map();
  for (const transition of aliasLedger?.founderTransitions ?? []) {
    if (String(transition?.companyId ?? "") !== String(company?.id ?? "")) continue;
    const founderId = String(transition?.founderId ?? "").trim();
    if (!founderId) continue;
    const transitions = transitionsByFounderId.get(founderId) ?? [];
    transitions.push(transition);
    transitionsByFounderId.set(founderId, transitions);
  }

  const historicalFounders = [];
  for (const [founderId, transitions] of transitionsByFounderId) {
    if (currentFounderIds.has(founderId)) continue;
    const removal = [...transitions].reverse().find((transition) =>
      transition?.change === "removed" && transition?.fromName
    );
    if (!removal) continue;
    const name = String(removal.fromName).trim();
    const historicalSlug = String(removal.companySlug ?? company.slug).trim() || company.slug;
    const sourceKey = `founder-${historicalSlug}-${slugify(name)}-${founderId}`;
    const legacyEntityAliases = uniqueCatalogAliases(transitions.flatMap((transition) =>
      [transition?.fromName, transition?.toName].flatMap((transitionName) => {
        const normalizedName = String(transitionName ?? "").trim();
        if (!normalizedName) return [];
        const transitionSlug = String(transition?.companySlug ?? historicalSlug).trim() || historicalSlug;
        return [
          normalizedName,
          `founder-${transitionSlug}-${slugify(normalizedName)}-${founderId}`
        ];
      })
    )).filter((alias) => alias !== sourceKey);
    historicalFounders.push({
      entityType: "founder",
      sourceKey,
      name,
      batchSlug: batch.slug,
      companySourceKey: `company-${company.slug}`,
      profileUrl: company.ycProfileUrl ?? null,
      websiteUrl: null,
      reviewState: "verified",
      legacyEntityAliases,
      accounts: []
    });
  }
  return historicalFounders.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
}

function normalizeYcFounder(founder, company, batch, companyAliasEntries = []) {
  if (!founder?.id || !founder?.name) {
    throw new Error(`${batch.catalogFile} contains a founder without an id and name for ${company.slug}.`);
  }
  const sourceKey = `founder-${company.slug}-${slugify(founder.name)}-${founder.id}`;
  const profileUrl = founder.ycProfileUrl ?? company.ycProfileUrl ?? null;
  const legacyEntityAliases = uniqueCatalogAliases(companyAliasEntries.flatMap((entry) =>
    (entry?.founders ?? [])
      .filter((candidate) => String(candidate?.founderId ?? "") === String(founder.id))
      .flatMap((candidate) => [
        candidate?.name,
        entry?.fromSlug && candidate?.name
          ? `founder-${entry.fromSlug}-${slugify(candidate.name)}-${founder.id}`
          : null
      ])
  ));
  return {
    entityType: "founder",
    sourceKey,
    name: founder.name,
    batchSlug: batch.slug,
    companySourceKey: `company-${company.slug}`,
    profileUrl: founder.ycProfileUrl ?? null,
    websiteUrl: founder.websiteUrl ?? null,
    reviewState: "verified",
    legacyEntityAliases,
    accounts: normalizeYcAccounts(founder.socialLinks, {
      entityType: "founder",
      entitySourceKey: sourceKey,
      discoveredFromUrl: profileUrl
    })
  };
}

function uniqueCatalogAliases(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

export function mergeVerifiedOverridesIntoCatalog(companies, overrides, batch) {
  return companies.map((company) => {
    const companySlug = autonomousCompanySlug(company);
    const override = overrides?.[companySlug];
    if (!override) return company;

    const companyLinks = override.companySocialLinks ?? override.company ?? {};
    const unmatchedFounderOverrides = [...(override.founders ?? [])];
    const founders = company.founders.map((founder) => {
      const overrideIndex = unmatchedFounderOverrides.findIndex(
        (candidate) =>
          founder.sourceKey.endsWith(`-${candidate.id}`) ||
          slugify(founder.name) === slugify(candidate.name)
      );
      if (overrideIndex < 0) return founder;
      const [founderOverride] = unmatchedFounderOverrides.splice(overrideIndex, 1);
      const verifiedOverrideSourceKey = verifiedFounderOverrideSourceKey(
        companySlug,
        founderOverride,
        batch
      );
      return {
        ...founder,
        profileUrl: founderOverride.ycProfileUrl ?? founder.profileUrl,
        legacyEntityAliases: uniqueCatalogAliases([
          ...(founder.legacyEntityAliases ?? []),
          verifiedOverrideSourceKey
        ]).filter((alias) => alias !== founder.sourceKey),
        accounts: mergeOwnerAccounts(founder, founderOverride.socialLinks ?? {}, {
          discoveredFromUrl: founderOverride.sourceUrl ?? founderOverride.ycProfileUrl ?? founder.profileUrl,
          matchReason: founderOverride.matchReason ?? override.matchReason
        }, retiredOwnerAccounts(founderOverride))
      };
    });

    for (const founderOverride of unmatchedFounderOverrides) {
      if (!founderOverride?.id || !founderOverride?.name) continue;
      const sourceKey = verifiedFounderOverrideSourceKey(companySlug, founderOverride, batch);
      const founder = {
        entityType: "founder",
        sourceKey,
        name: founderOverride.name,
        batchSlug: batch.slug,
        companySourceKey: company.sourceKey,
        profileUrl: founderOverride.ycProfileUrl ?? null,
        websiteUrl: founderOverride.websiteUrl ?? null,
        reviewState: "verified",
        accounts: []
      };
      founders.push({
        ...founder,
        accounts: mergeOwnerAccounts(founder, founderOverride.socialLinks ?? {}, {
          discoveredFromUrl: founderOverride.sourceUrl ?? founderOverride.ycProfileUrl ?? company.profileUrl,
          matchReason: founderOverride.matchReason ?? override.matchReason
        }, retiredOwnerAccounts(founderOverride))
      });
    }

    return {
      ...company,
      accounts: mergeOwnerAccounts(company, companyLinks, {
        discoveredFromUrl: override.sourceUrl ?? company.profileUrl,
        matchReason: override.matchReason
      }, retiredOwnerAccounts(override)),
      founders
    };
  });
}

function verifiedFounderOverrideSourceKey(companySlug, founderOverride, batch) {
  if (!founderOverride?.id || !founderOverride?.name) return null;
  return batch.slug === "A16ZSR006" && /^a16z-speedrun-006-.+-founder-/i.test(founderOverride.id)
    ? founderOverride.id
    : `founder-${companySlug}-${slugify(founderOverride.name)}-${founderOverride.id}`;
}

function mergeOwnerAccounts(entity, overrideLinks, { discoveredFromUrl, matchReason }, retiredAccounts = []) {
  const retiredKeys = new Set(
    retiredAccounts.map(({ platform, url }) => ownerAccountCanonicalKey(platform, url)).filter(Boolean)
  );
  const byOwnerIdentity = new Map(
    (entity.accounts ?? [])
      .flatMap((account) => {
        const identity = ownerAccountCanonicalKey(account.platform, account.url);
        return identity && !retiredKeys.has(identity) ? [[identity, account]] : [];
      })
  );
  for (const { platform, rawUrl, canonicalUrl, handle } of normalizeVerifiedSocialOverrideLinks(overrideLinks)) {
    byOwnerIdentity.set(ownerAccountCanonicalKey(platform, canonicalUrl), {
      sourceKey: `acct:${entity.entityType}:${entity.sourceKey}:${platform}:${encodeURIComponent(canonicalUrl)}`,
      platform,
      handle,
      url: rawUrl,
      accountId: null,
      reviewState: "verified",
      verified: true,
      discoveredFromUrl: discoveredFromUrl ?? null,
      matchReason: matchReason ?? "Verified social override for this exact entity owner.",
      overridePriority: 1
    });
  }
  return [...byOwnerIdentity.values()].sort(
    (left, right) =>
      Number(right.overridePriority ?? 0) - Number(left.overridePriority ?? 0) ||
      left.platform.localeCompare(right.platform) ||
      ownerAccountCanonicalKey(left.platform, left.url).localeCompare(
        ownerAccountCanonicalKey(right.platform, right.url)
      )
  );
}

export function normalizeVerifiedSocialOverrideLinks(overrideLinks) {
  if (overrideLinks === null || overrideLinks === undefined) return [];
  if (typeof overrideLinks !== "object" || Array.isArray(overrideLinks)) {
    throw new Error("Verified social override links must be an object keyed by platform.");
  }

  const links = [];
  const seen = new Set();
  for (const [rawPlatform, rawValue] of Object.entries(overrideLinks)) {
    const isArray = Array.isArray(rawValue);
    if (!isArray && typeof rawValue !== "string") {
      throw new Error(`Verified ${rawPlatform} override must be a URL string or a non-empty URL array.`);
    }
    if (isArray && rawValue.length === 0) {
      throw new Error(`Verified ${rawPlatform} override URL array must not be empty.`);
    }
    const rawUrls = isArray ? rawValue : [rawValue];
    for (const rawUrl of rawUrls) {
      if (typeof rawUrl !== "string" || !rawUrl.trim()) {
        if (!isArray) continue;
        throw new Error(`Verified ${rawPlatform} override URL array contains a malformed URL value.`);
      }
      const platform = normalizePlatform(rawPlatform);
      if (!AUTONOMOUS_PLATFORMS.includes(platform)) {
        throw new Error(`Verified social override uses unsupported platform: ${rawPlatform}`);
      }
      const canonicalUrl = canonicalSocialAccountUrl(platform, rawUrl);
      if (!canonicalUrl) {
        throw new Error(`Verified ${platform} override URL does not match its platform: ${rawUrl}`);
      }
      const handle = socialHandle(canonicalUrl);
      if (!handle) throw new Error(`Verified ${platform} override URL has no account identity: ${rawUrl}`);
      const identity = `${platform}:${canonicalUrl.toLowerCase()}`;
      if (seen.has(identity)) {
        throw new Error(`Verified ${platform} override contains duplicate account URL: ${rawUrl}`);
      }
      seen.add(identity);
      links.push({ platform, rawUrl, canonicalUrl, handle });
    }
  }
  return links;
}

function retiredOwnerAccounts(ownerOverride) {
  const records = [];
  for (const [key, value] of Object.entries(ownerOverride ?? {})) {
    const platformMatch = key.match(/^rejected([A-Z].*)$/);
    if (!platformMatch || !Array.isArray(value)) continue;
    const platform = normalizePlatform(
      platformMatch[1].replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()
    );
    for (const record of value) {
      if (record?.url) records.push({ ...record, platform });
    }
  }
  for (const record of ownerOverride?.retiredAccounts ?? []) {
    if (record?.platform && record?.url) {
      records.push({ ...record, platform: normalizePlatform(record.platform) });
    }
  }
  return records;
}

function ownerAccountCanonicalKey(platform, rawUrl) {
  if (!platform || !rawUrl) return null;
  const normalizedPlatform = normalizePlatform(platform);
  const canonicalUrl = canonicalSocialAccountUrl(normalizedPlatform, rawUrl);
  return canonicalUrl ? `${normalizedPlatform}:${canonicalUrl.toLowerCase()}` : null;
}

function autonomousCompanySlug(company) {
  try {
    const parts = new URL(company.profileUrl).pathname.split("/").filter(Boolean);
    const companiesIndex = parts.indexOf("companies");
    if (companiesIndex >= 0 && parts[companiesIndex + 1]) return parts[companiesIndex + 1];
  } catch {
    // Fall back to stable catalog identity.
  }
  return String(company.sourceKey)
    .replace(/^company-/, "")
    .replace(/^a16z-speedrun-006-/, "");
}

function normalizeYcAccounts(links, { entityType, entitySourceKey, discoveredFromUrl }) {
  return Object.entries(links ?? {})
    .filter(([, url]) => typeof url === "string" && url.trim())
    .flatMap(([rawPlatform, url]) => {
      const declaredPlatform = normalizePlatform(rawPlatform);
      const platform = socialUrlMatchesPlatform(declaredPlatform, url)
        ? declaredPlatform
        : socialPlatformFromUrl(url);
      if (!platform) return [];
      const canonicalUrl = canonicalSocialAccountUrl(platform, url);
      const handle = socialHandle(canonicalUrl);
      if (!handle) return [];
      return [{
        sourceKey: `acct:${entityType}:${entitySourceKey}:${platform}:${encodeURIComponent(canonicalUrl)}`,
        platform,
        handle,
        url: canonicalUrl,
        accountId: null,
        reviewState: "verified",
        verified: true,
        discoveredFromUrl,
        matchReason: "Linked from the official public YC profile."
      }];
    });
}

function normalizeAccounts(accounts) {
  return (accounts ?? [])
    .filter((account) => account?.platform && account?.url)
    .map((account) => ({
      sourceKey: account.id ?? `${account.platform}:${account.url}`,
      platform: normalizePlatform(account.platform),
      handle: account.handle ?? null,
      url: account.url,
      accountId: account.accountId ?? null,
      reviewState: account.review_state ?? "needs_review",
      verified: account.review_state === "verified",
      discoveredFromUrl: account.discoveredFromUrl ?? null,
      matchReason: account.matchReason ?? null
    }));
}

function tasksForEntity({ runKey, batch, company, entity, platform }) {
  const accounts = entity.accounts.filter((candidate) => candidate.platform === platform);
  // A missing mapping remains one discoverable owner/platform task. Every mapped
  // account is instead its own task so aliases and additional active accounts
  // cannot be collapsed into a single collector outcome.
  return (accounts.length ? accounts : [null]).map((account) =>
    taskForEntityAccount({ runKey, batch, company, entity, platform, account })
  );
}

function taskForEntityAccount({ runKey, batch, company, entity, platform, account }) {
  const entityType = entity.entityType;
  const canonicalAccountUrl = account
    ? canonicalSocialAccountUrl(platform, account.url)
    : null;
  if (account && !canonicalAccountUrl) {
    throw new Error(
      `Invalid ${platform} account URL for ${batch.slug}:${entityType}:${entity.sourceKey}: ${account.url}`
    );
  }
  const accountIdentity = canonicalAccountUrl
    ? `account:${encodeURIComponent(canonicalAccountUrl)}`
    : "discovery";
  const base = {
    batchSlug: batch.slug,
    companySourceKey: company.sourceKey,
    companyName: company.name,
    entityType,
    entitySourceKey: entity.sourceKey,
    entityName: entity.name,
    platform,
    account,
    checkpointKey: `${runKey}:${batch.slug}:${entityType}:${entity.sourceKey}:${platform}:${accountIdentity}`,
    status: "queued",
    terminalReason: null
  };

  if (EXPLICITLY_UNAVAILABLE.has(platform)) {
    return { ...base, status: "skipped", terminalReason: "collector_not_available" };
  }
  if (entityType === "founder" && !FOUNDER_SOCIAL_PLATFORMS.has(platform) && !account) {
    return { ...base, status: "skipped", terminalReason: "collector_not_applicable_to_founder" };
  }
  if (platform === "github" && !account) return base;
  if (platform !== "github" && !PUBLIC_PLATFORM_COLLECTORS.has(platform)) {
    return { ...base, status: "skipped", terminalReason: "collector_not_available" };
  }
  return base;
}

function normalizePlatform(platform) {
  if (platform === "twitter") return "x";
  if (platform === "website") return "web";
  if (platform === "producthunt") return "product_hunt";
  if (platform === "hn" || platform === "hackernews") return "hacker_news";
  return platform;
}

function normalizeIdentity(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function collectorOutcomePriority(status) {
  return ({ blocked_or_empty: 1, failed: 2, needs_review: 3, completed: 4 })[status] ?? 0;
}

function shouldReplaceCollectorOutcome(previous, candidate) {
  if (candidate.validatedCompletedEvidence === true) return true;
  if (previous.validatedCompletedEvidence === true) return false;
  if (candidate.hardRawFailure === true) return true;
  if (previous.hardRawFailure === true) return false;
  if (candidate.exactTypedReceipt === true && previous.incidentalRawFailure === true) return true;
  if (previous.exactTypedReceipt === true && candidate.incidentalRawFailure === true) return false;
  return collectorOutcomePriority(candidate.status) > collectorOutcomePriority(previous.status);
}

function preserveCollectorBlockerMetadata(previous, candidate) {
  if (candidate.providerBlocked === true || previous?.providerBlocked !== true) return candidate;
  return {
    ...candidate,
    providerBlocked: true,
    providerBlockerReason: previous.providerBlockerReason
  };
}

function collectorOutcomePublicView(outcome) {
  return {
    status: outcome.status,
    reason: outcome.reason,
    ...(outcome.providerBlocked === true
      ? {
          providerBlocked: true,
          providerBlockerReason: outcome.providerBlockerReason
        }
      : {})
  };
}

function isSuccessfulPublicEvidenceRow(row) {
  if (["needs_review", "rejected"].includes(row?.review_state)) return false;
  if (Number(row?.contributionScore ?? 0) > 0) return true;
  if (row?.platformObjectId ?? row?.platformPostId ?? row?.platform_post_id ?? row?.nativeId) return true;
  const sourceUrl = String(row?.sourceUrl ?? row?.canonicalUrl ?? row?.url ?? "");
  return /(?:\/status\/\d+|\/posts\/[^/?#]+|\/feed\/update\/urn:li:activity:|\/(?:p|reel|tv)\/[^/?#]+|\/watch\?(?:[^#]*&)?v=[^&#]+|news\.ycombinator\.com\/item\?id=\d+|reddit\.com\/r\/[^/]+\/comments\/[^/]+|producthunt\.com\/(?:posts|products)\/[^/?#]+)/i.test(sourceUrl);
}

function isExpectedPublicAccessOrEmptyFailure(failure) {
  const message = String(failure?.message ?? failure?.error ?? "").toLowerCase();
  if (/(?:\b404\b|http[_ -]?404|not found|invalid (?:url|mapping|host|identity)|dead (?:url|mapping|account)|wrong host|host did not match|unsupported .*url|referential)/i.test(message)) {
    return false;
  }
  if (normalizePlatform(failure?.platform) === "x" &&
      /(?:^|[^a-z0-9])no_exact_owner_social_media_postings(?:$|[^a-z0-9])/.test(message)) {
    return true;
  }
  return /(?:no\b[^.\n]{0,100}\b(?:matches?|posts?|videos?|content|results?|items?|candidates?|evidence|mentions?|links?)\b|empty|login|log in|sign in|signup|join (?:linkedin|x)|access (?:blocked|denied)|\bblocked\b|rate.?limit|\b429\b|captcha|robots|authentication required|http[_ -]?(?:401|403|408|425|429|5\d\d)|\b(?:unauthori[sz]ed|forbidden|timeout|timed out)\b|(?:network|transport) (?:error|failed|failure)|fetch failed|operation was aborted|aborterror|\betimedout\b|\beconn[a-z]*\b|socket (?:hang up|closed)|circuit is open)/i.test(message);
}

function isDeterministicPublicMappingFailure(
  failure,
  { trustedProviderBlocker = false } = {}
) {
  const message = String(failure?.message ?? failure?.error ?? "").toLowerCase();
  if (/(?:invalid (?:url|mapping|host|identity)|dead (?:url|mapping|account)|wrong host|host did not match|unsupported .*url|referential)/i.test(message)) {
    return true;
  }
  return !trustedProviderBlocker && /(?:\b404\b|http[_ -]?404|not found)/i.test(message);
}

export function isAutonomousProviderBlocker(blocker, { platform = null } = {}) {
  if (!blocker || typeof blocker !== "object" || Array.isArray(blocker)) return false;
  const provider = String(blocker.provider ?? "").trim();
  const code = String(blocker.code ?? "").trim();
  if (!provider || provider !== provider.toLowerCase() || !code || code !== code.toLowerCase()) {
    return false;
  }
  if (AUTONOMOUS_PROVIDER_BLOCKER_CODES.get(provider)?.has(code) !== true) return false;
  if (provider === "reddit_public_json" && (
    ![401, 403, 429].includes(blocker.httpStatus) || blocker.retryAt === null
  )) return false;
  const normalizedPlatform = normalizePlatform(platform);
  if (normalizedPlatform) {
    if (provider === "duckduckgo_html" && !["x", "linkedin", "instagram", "product_hunt", "web"].includes(normalizedPlatform)) {
      return false;
    }
    if (provider === "reddit_public_json" && normalizedPlatform !== "reddit") return false;
    if (!["duckduckgo_html", "reddit_public_json"].includes(provider) && normalizedPlatform !== "linkedin") return false;
  }
  const allowedKeys = new Set(["provider", "code", "retryAt", "httpStatus", "message"]);
  if (Object.keys(blocker).some((key) => !allowedKeys.has(key))) return false;
  if (!Object.prototype.hasOwnProperty.call(blocker, "retryAt") ||
      !Object.prototype.hasOwnProperty.call(blocker, "httpStatus") ||
      !String(blocker.message ?? "").trim()) {
    return false;
  }
  if (blocker.retryAt !== null) {
    const timestamp = Date.parse(blocker.retryAt);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== blocker.retryAt) return false;
  }
  if (blocker.httpStatus !== null &&
      (!Number.isInteger(blocker.httpStatus) || blocker.httpStatus < 100 || blocker.httpStatus > 599)) {
    return false;
  }
  if (code.endsWith("_circuit_open") && blocker.retryAt === null) return false;
  if (code.endsWith("_access_blocked") || code.endsWith("_http_failure")) {
    if (blocker.httpStatus === null || blocker.httpStatus < 400) return false;
  } else if (code.endsWith("_soft_block")) {
    if (blocker.httpStatus !== 200) return false;
  } else if (blocker.httpStatus !== null) {
    return false;
  }
  return true;
}

function sameAutonomousProviderBlocker(left, right) {
  if (!left || !right) return false;
  return ["provider", "code", "retryAt", "httpStatus", "message"]
    .every((key) => (left[key] ?? null) === (right[key] ?? null));
}

function collectorAttemptMatchesFailureIdentity(attempt, failure, batchSlug) {
  if (String(attempt?.attemptKey ?? "") !== String(failure?.attemptKey ?? "")) return false;
  const attemptPlatform = normalizePlatform(attempt?.platform);
  const failurePlatform = normalizePlatform(failure?.platform);
  if (!attemptPlatform || attemptPlatform !== failurePlatform) return false;
  const attemptType = attempt?.entityType ?? "company";
  const failureType = failure?.entityType ?? "company";
  if (attemptType !== failureType) return false;
  const attemptId = normalizeAutonomousFailureEntityId(attempt, { batchSlug });
  const failureId = normalizeAutonomousFailureEntityId(failure, { batchSlug });
  if (!attemptId || attemptId !== failureId) return false;
  const attemptUrl = attempt?.accountUrl ?? attempt?.account_url ?? null;
  const failureUrl = failure?.accountUrl ?? failure?.account_url ?? null;
  if (Boolean(attemptUrl) !== Boolean(failureUrl)) return false;
  if (!attemptUrl) return true;
  const attemptAccountKey = autonomousCollectorAccountKey(
    attemptPlatform,
    attemptType,
    attemptId,
    attemptUrl
  );
  const failureAccountKey = autonomousCollectorAccountKey(
    failurePlatform,
    failureType,
    failureId,
    failureUrl
  );
  return Boolean(
    attemptAccountKey &&
    failureAccountKey &&
    attemptAccountKey === failureAccountKey
  );
}

function typedProviderBlockerReason(blocker, platform) {
  const provider = String(blocker?.provider ?? normalizePlatform(platform) ?? "unknown")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_");
  const code = String(blocker?.code ?? "provider_blocked")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, "_");
  return `provider_blocked:${provider || "unknown"}:${code || "provider_blocked"}`;
}

function socialUrlMatchesPlatform(platform, rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./i, "").toLowerCase();
    if (platform === "github") return host === "github.com";
    if (platform === "linkedin") return host === "linkedin.com" || host.endsWith(".linkedin.com");
    if (platform === "x") return host === "x.com" || host === "twitter.com";
    if (platform === "instagram") return host === "instagram.com";
    if (platform === "tiktok") return host === "tiktok.com" || host === "m.tiktok.com";
    if (platform === "bluesky") return host === "bsky.app";
    if (platform === "youtube") return host === "youtube.com";
    if (platform === "product_hunt") return host === "producthunt.com";
    if (platform === "reddit") return host === "reddit.com" || host.endsWith(".reddit.com");
    return true;
  } catch {
    return false;
  }
}

function socialPlatformFromUrl(rawUrl) {
  for (const platform of ["github", "linkedin", "x", "instagram", "tiktok", "bluesky"]) {
    if (socialUrlMatchesPlatform(platform, rawUrl)) return platform;
  }
  return null;
}

function socialHandle(url) {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? null;
  } catch {
    return null;
  }
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const MERGED_PUBLIC_SCORING_METRICS = Object.freeze({
  x: new Set(["views", "likes", "replies", "reposts", "quotes"]),
  linkedin: new Set(["views", "reactions", "comments", "reposts"]),
  instagram: new Set(["views", "likes", "comments", "shares", "saves"]),
  youtube: new Set(["views", "likes", "comments"]),
  product_hunt: new Set(["upvotes", "comments"]),
  hacker_news: new Set(["upvotes", "comments"]),
  reddit: new Set(["upvotes", "comments"])
});
const MERGED_PUBLIC_DISPLAY_METRICS = Object.freeze({
  ...MERGED_PUBLIC_SCORING_METRICS,
  x: new Set([...MERGED_PUBLIC_SCORING_METRICS.x, "bookmarks"])
});
const MERGED_PUBLIC_DERIVED_METRICS = new Set([
  "score",
  "profile_score",
  "contribution_score",
  "max_repo_score"
]);

function evidenceKey(row) {
  const platform = normalizePlatform(row.platform ?? "other");
  const entityId = evidenceEntityAttribution(row);
  const physicalIdentity = mergedPublicEvidenceIdentity(platform, row);
  const stableIdentity = physicalIdentity.urlId ?? physicalIdentity.explicitId ??
    canonicalUrl(row.sourceUrl ?? row.canonicalUrl ?? row.url);
  return `${rowBatchScope(row)}:${entityId}:${platform}:post:${stableIdentity}`;
}

function reconcileMergedPublicContentIdentities(rows, referenceRows, resolveBatchSlug) {
  const referenceIndex = new Map();
  const acceptedIndex = new Map();
  const evidence = [];
  const duplicates = [];

  for (const sourceRow of referenceRows ?? []) {
    const row = scopedContentIdentityRow(sourceRow, resolveBatchSlug);
    const contentIdentity = mergedPublicSourceContentIdentity(row);
    if (!contentIdentity) continue;
    indexMergedContentIdentity(referenceIndex, row, contentIdentity);
  }

  for (const sourceRow of [...rows].sort(compareMergedContentPreference)) {
    const row = scopedContentIdentityRow(sourceRow, resolveBatchSlug);
    const contentIdentity = mergedPublicSourceContentIdentity(row);
    if (!contentIdentity) {
      evidence.push(row);
      continue;
    }
    const scope = mergedContentAttributionScope(row);
    const physicalIdentity = reconciliationPhysicalIdentity(row);
    let duplicate = null;
    for (const contentKey of contentIdentity.keys) {
      const key = `${scope}:${contentKey}`;
      const candidates = [
        ...(referenceIndex.get(key) ?? []),
        ...(acceptedIndex.get(key) ?? [])
      ];
      duplicate = candidates.find((candidate) =>
        sourceAuthorsCompatible(contentIdentity, candidate.contentIdentity) &&
        publicationTimesCompatible(contentIdentity, candidate.contentIdentity) &&
        candidate.physicalIdentity !== physicalIdentity
      ) ?? null;
      if (duplicate) break;
    }
    if (duplicate) {
      duplicates.push({
        row,
        reason: "same_platform_author_substantive_body",
        duplicateOf: duplicate.row,
        contentIdentity
      });
      continue;
    }
    evidence.push(row);
    indexMergedContentIdentity(acceptedIndex, row, contentIdentity);
  }
  return { evidence, duplicates };
}

function reconcileMergedPublicRollupPhysicalIdentities(rows) {
  const retainedByIdentity = new Map();
  const evidence = [];
  const duplicates = [];

  for (const row of rows) {
    const key = mergedPublicRollupPhysicalIdentity(row);
    if (!key) {
      evidence.push(row);
      continue;
    }
    const retained = retainedByIdentity.get(key);
    if (!retained) {
      retainedByIdentity.set(key, { row, index: evidence.length });
      evidence.push(row);
      continue;
    }

    const rowWins = compareMergedRollupPhysicalPreference(row, retained.row) < 0;
    const winner = rowWins ? row : retained.row;
    const duplicate = rowWins ? retained.row : row;
    if (rowWins) {
      evidence[retained.index] = row;
      retainedByIdentity.set(key, { row, index: retained.index });
    }
    duplicates.push({
      row: duplicate,
      reason: "same_rollup_physical_post_identity",
      duplicateOf: winner,
      contentIdentity: mergedPublicSourceContentIdentity(duplicate)
    });
  }

  return { evidence, duplicates };
}

function mergedPublicRollupPhysicalIdentity(row) {
  const physicalIdentity = reconciliationPhysicalIdentity(row);
  const companyRollup = row?.companySlug ?? row?.company_slug ??
    row?.nativeAuthorResolution?.owner?.companySlug ?? null;
  if (!physicalIdentity || !companyRollup) return null;
  return [
    rowBatchScope(row),
    String(companyRollup).trim().toLowerCase(),
    physicalIdentity
  ].join(":");
}

function compareMergedRollupPhysicalPreference(left, right) {
  const ownerOrder = mergedNativeOwnerMatchScore(right) - mergedNativeOwnerMatchScore(left);
  if (ownerOrder) return ownerOrder;
  const modeOrder = mergedAttributionModeScore(right) - mergedAttributionModeScore(left);
  if (modeOrder) return modeOrder;
  const entityOrder = mergedRollupEntityScore(right) - mergedRollupEntityScore(left);
  if (entityOrder) return entityOrder;
  const timestampOrder = rowTimestamp(right) - rowTimestamp(left);
  if (timestampOrder) return timestampOrder;
  const metricOrder = mergedVisibleMetricTotal(right?.metrics) - mergedVisibleMetricTotal(left?.metrics);
  if (metricOrder) return metricOrder;
  const leftAttribution = `${left?.entityType ?? left?.entity_type ?? "company"}:${left?.entityId ?? left?.entity_id ?? ""}`;
  const rightAttribution = `${right?.entityType ?? right?.entity_type ?? "company"}:${right?.entityId ?? right?.entity_id ?? ""}`;
  const attributionOrder = leftAttribution.localeCompare(rightAttribution);
  if (attributionOrder) return attributionOrder;
  const urlOrder = String(canonicalUrl(left?.sourceUrl ?? left?.canonicalUrl ?? left?.url) ?? "")
    .localeCompare(String(canonicalUrl(right?.sourceUrl ?? right?.canonicalUrl ?? right?.url) ?? ""));
  return urlOrder || String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

function mergedNativeOwnerMatchScore(row) {
  const resolution = row?.nativeAuthorResolution;
  const owner = resolution?.owner;
  return resolution?.status === "matched" &&
    String(owner?.batchSlug ?? "").toUpperCase() === rowBatchScope(row) &&
    String(owner?.entityType ?? "company") === String(row?.entityType ?? row?.entity_type ?? "company") &&
    String(owner?.entityId ?? "") === String(row?.entityId ?? row?.entity_id ?? "")
    ? 1
    : 0;
}

function mergedAttributionModeScore(row) {
  return ["account_owner", "native_author"].includes(
    String(row?.attributionMode ?? row?.attribution_mode ?? "").toLowerCase()
  ) ? 1 : 0;
}

function mergedRollupEntityScore(row) {
  return String(row?.entityType ?? row?.entity_type ?? "company") === "company" ? 1 : 0;
}

function scopedContentIdentityRow(row, resolveBatchSlug) {
  if (typeof resolveBatchSlug !== "function") return row;
  return withCanonicalRowBatch(row, resolveBatchSlug(row));
}

function mergedContentAttributionScope(row) {
  return [
    rowBatchScope(row),
    row?.entityType ?? row?.entity_type ?? "company",
    row?.entityId ?? row?.entity_id ?? "unknown-entity"
  ].join(":");
}

function mergedPublicSourceContentIdentity(row) {
  const raw = parseMergedVisiblePayload(row?.rawVisibleText);
  const rawAuthor = mergedVisibleAuthor(row?.rawVisibleText, raw);
  return sourceContentIdentity({
    platform: normalizePlatform(row?.platform),
    authorName: row?.authorName ?? row?.voiceName ?? raw?.post?.authorName ??
      raw?.profile?.name ?? raw?.name ?? raw?.author?.name ?? rawAuthor.name,
    authorHandle: row?.authorHandle ?? raw?.post?.authorHandle ?? raw?.profile?.username ??
      raw?.author?.handle ?? raw?.author?.username ?? raw?.author?.screen_name ??
      (typeof raw?.author === "string" ? raw.author : null) ?? rawAuthor.handle,
    authorUrl: row?.authorUrl ?? raw?.profile?.url ?? raw?.author?.url,
    accountUrl: row?.accountUrl,
    sourceUrl: row?.sourceUrl ?? row?.canonicalUrl ?? row?.url,
    fallbackAuthorName: row?.entityName ?? row?.companyName,
    body: row?.text ?? row?.content ?? row?.body,
    postedAt: row?.postedAt ?? row?.publishedAt
  });
}

function mergedVisibleAuthor(rawValue, parsed) {
  if (parsed) {
    return {
      name: parsed?.post?.authorName ?? parsed?.post?.name ?? parsed?.profile?.name ??
        parsed?.name ?? parsed?.author?.name ?? null,
      handle: parsed?.post?.authorHandle ?? parsed?.post?.username ?? parsed?.profile?.username ??
        parsed?.author?.handle ?? parsed?.author?.username ?? parsed?.author?.screen_name ??
        (typeof parsed?.author === "string" ? parsed.author : null)
    };
  }
  const text = String(rawValue ?? "").normalize("NFKC");
  const linkedInFeed = text.match(/\bFeed\s+post\s+number\s+\d+\s+(.{2,80}?)\s+\1\s+Follow\b/i);
  const xHeader = text.match(/^\s*([^\n@]{2,80})\s*\n\s*@([A-Za-z0-9_]{1,30})\b/m);
  return {
    name: linkedInFeed?.[1]?.trim() ?? xHeader?.[1]?.trim() ?? null,
    handle: xHeader?.[2] ?? null
  };
}

function parseMergedVisiblePayload(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value ?? ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function indexMergedContentIdentity(index, row, contentIdentity) {
  const scope = mergedContentAttributionScope(row);
  const indexed = {
    row,
    contentIdentity,
    physicalIdentity: reconciliationPhysicalIdentity(row)
  };
  for (const contentKey of contentIdentity.keys) {
    const key = `${scope}:${contentKey}`;
    index.set(key, [...(index.get(key) ?? []), indexed]);
  }
}

function compareMergedContentPreference(left, right) {
  const leftPlatform = normalizePlatform(left?.platform);
  const rightPlatform = normalizePlatform(right?.platform);
  const leftId = String(left?.platformPostId ?? "");
  const rightId = String(right?.platformPostId ?? "");
  if (leftPlatform === "x" && rightPlatform === "x" && /^\d+$/.test(leftId) && /^\d+$/.test(rightId)) {
    const idOrder = BigInt(leftId) < BigInt(rightId) ? -1 : BigInt(leftId) > BigInt(rightId) ? 1 : 0;
    if (idOrder) return idOrder;
  }
  const leftFirstSeen = Date.parse(left?.first_seen_at ?? "");
  const rightFirstSeen = Date.parse(right?.first_seen_at ?? "");
  if (Number.isFinite(leftFirstSeen) !== Number.isFinite(rightFirstSeen)) {
    return Number.isFinite(leftFirstSeen) ? -1 : 1;
  }
  if (Number.isFinite(leftFirstSeen) && leftFirstSeen !== rightFirstSeen) {
    return leftFirstSeen - rightFirstSeen;
  }
  const metricOrder = mergedVisibleMetricTotal(right?.metrics) - mergedVisibleMetricTotal(left?.metrics);
  return metricOrder || String(left?.id ?? leftId).localeCompare(String(right?.id ?? rightId));
}

function mergedVisibleMetricTotal(metrics) {
  return Object.values(metrics ?? {}).reduce(
    (total, value) => total + (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0),
    0
  );
}

function replayStableNativeAuthorResolution(row, resolution) {
  if (!resolution || resolution.status !== "matched") return resolution;
  const prior = row?.nativeAuthorResolution;
  const sameOwner = prior?.status === "matched" &&
    String(prior.owner?.batchSlug ?? "") === String(resolution.owner?.batchSlug ?? "") &&
    String(prior.owner?.entityType ?? "") === String(resolution.owner?.entityType ?? "") &&
    String(prior.owner?.entityId ?? "") === String(resolution.owner?.entityId ?? "");
  if (!sameOwner || prior.changed !== true) return resolution;
  return {
    ...resolution,
    changed: true,
    ...(prior.previousAttribution
      ? { previousAttribution: prior.previousAttribution }
      : {})
  };
}

function reviewEvidenceKey(row) {
  const platform = normalizePlatform(row.platform ?? "other");
  const entityType = row?.entityType ?? row?.entity_type ?? "company";
  const companySlug = row?.companySlug ?? row?.company_slug;
  const entityId = entityType === "company" && companySlug
    ? `company-rollup:${String(companySlug).toLowerCase()}:${reviewReasonIdentity(row)}`
    : evidenceEntityAttribution(row);
  const candidate = canonicalUrl(row.candidateUrl ?? row.sourceUrl ?? row.canonicalUrl ?? row.url) ??
    row.platformPostId ?? row.platform_post_id ?? row.platformObjectId ?? row.nativeId ?? row.id ?? row.title;
  return `${rowBatchScope(row)}:${entityId}:${platform}:${candidate ?? "unknown-review"}`;
}

function reviewReasonIdentity(row) {
  return JSON.stringify([
    [...(row?.quarantineReasons ?? [])].sort(),
    row?.attributionReconciliationDirective?.disposition ?? null,
    row?.attributionReconciliationDirective?.reason ?? null,
    String(row?.matchReason ?? "").replace(/\s+/g, " ").trim()
  ]);
}

function evidenceEntityAttribution(row) {
  return row.entityId ?? row.attachedCompanyId ?? row.companySlug ?? row.companyName ?? "unknown-entity";
}

function samePublicAttribution(left, right) {
  const leftBatch = String(left?.batchSlug ?? "").toUpperCase();
  const rightBatch = String(right?.batchSlug ?? "").toUpperCase();
  return (!leftBatch || !rightBatch || leftBatch === rightBatch) &&
    String(left?.entityType ?? "company") === String(right?.entityType ?? "company") &&
    String(left?.entityId ?? "") === String(right?.entityId ?? "");
}

function reconciliationCandidate(originalRow, replacementRow, disposition, reason) {
  const platform = normalizePlatform(originalRow?.platform ?? replacementRow?.platform ?? "");
  const identity = mergedPublicEvidenceIdentity(platform, originalRow);
  const staleAttribution = publicAttribution(originalRow);
  if (!identity.urlId || identity.conflict || !staleAttribution.batchSlug || !staleAttribution.entityId) return null;
  return {
    platform,
    sourceUrl: canonicalUrl(originalRow?.sourceUrl ?? originalRow?.canonicalUrl ?? originalRow?.url),
    platformPostId: identity.urlId,
    disposition,
    reason,
    staleAttribution,
    ...(replacementRow ? { replacementAttribution: publicAttribution(replacementRow) } : {})
  };
}

function explicitReviewReconciliationCandidate(reviewRow, directive) {
  const platform = normalizePlatform(directive?.platform ?? reviewRow?.platform ?? "");
  const sourceUrl = canonicalUrl(directive?.sourceUrl ?? reviewRow?.sourceUrl ?? reviewRow?.candidateUrl);
  const identity = mergedPublicEvidenceIdentity(platform, {
    sourceUrl,
    platformPostId: directive?.platformPostId ?? reviewRow?.platformPostId
  });
  if (
    !identity.urlId ||
    identity.conflict ||
    !directive?.reason ||
    !["quarantined", "reattributed"].includes(directive.disposition)
  ) return null;
  return {
    platform,
    sourceUrl,
    platformPostId: identity.urlId,
    disposition: directive.disposition,
    reason: directive.reason,
    staleAttribution: {
      ...publicAttribution(reviewRow),
      ...(directive.staleAttribution ?? {}),
      batchSlug: directive.staleAttribution?.batchSlug ??
        reviewRow.batchSlug ?? reviewRow.batch_slug ?? null
    },
    ...(directive.disposition === "reattributed" && directive.replacementAttribution
      ? { replacementAttribution: directive.replacementAttribution }
      : {})
  };
}

function finalizeAttributionReconciliationLedger(candidates, acceptedEvidence) {
  const acceptedAttributionTargets = new Set(
    acceptedEvidence.map((row) => reconciliationPhysicalAttributionIdentity(
      reconciliationPhysicalIdentity(row),
      publicAttribution(row)
    )).filter(Boolean)
  );
  const viableCandidates = candidates.filter(Boolean).filter((candidate) =>
    candidate.disposition !== "reattributed" ||
    acceptedAttributionTargets.has(reconciliationPhysicalAttributionIdentity(
      reconciliationPhysicalIdentity(candidate),
      candidate.replacementAttribution
    ))
  );
  const ledger = [];
  const seen = new Set();
  const reattributedStaleTargets = new Set(
    viableCandidates
      .filter((candidate) => candidate?.disposition === "reattributed")
      .map((candidate) => reconciliationPhysicalAttributionIdentity(
        reconciliationPhysicalIdentity(candidate),
        candidate.staleAttribution
      ))
      .filter(Boolean)
  );
  for (const candidate of viableCandidates) {
    const physicalIdentity = reconciliationPhysicalIdentity(candidate);
    // A stale generic-search row may be present beside a newly refreshed and
    // accepted receipt for the exact same physical post. The accepted row wins;
    // no durable attribution is retired merely because an older copy was stale.
    if (
      candidate.disposition === "quarantined" &&
      (
        acceptedAttributionTargets.has(
          reconciliationPhysicalAttributionIdentity(physicalIdentity, candidate.staleAttribution)
        ) ||
        reattributedStaleTargets.has(
          reconciliationPhysicalAttributionIdentity(physicalIdentity, candidate.staleAttribution)
        )
      )
    ) {
      continue;
    }
    const key = JSON.stringify([
      physicalIdentity,
      candidate.disposition,
      candidate.staleAttribution?.batchSlug,
      candidate.staleAttribution?.entityType,
      candidate.staleAttribution?.entityId,
      candidate.replacementAttribution?.batchSlug,
      candidate.replacementAttribution?.entityType,
      candidate.replacementAttribution?.entityId
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    ledger.push(candidate);
  }
  return ledger.sort((left, right) =>
    String(left.platform).localeCompare(String(right.platform)) ||
    String(left.platformPostId).localeCompare(String(right.platformPostId)) ||
    String(left.staleAttribution?.batchSlug).localeCompare(String(right.staleAttribution?.batchSlug)) ||
    String(left.staleAttribution?.entityId).localeCompare(String(right.staleAttribution?.entityId))
  );
}

function reconciliationPhysicalAttributionIdentity(physicalIdentity, attribution) {
  if (!physicalIdentity || !attribution?.entityId || !attribution?.batchSlug) return null;
  return [
    physicalIdentity,
    String(attribution.batchSlug).toUpperCase(),
    attribution.entityType ?? "company",
    attribution.entityId,
    attribution.attributionType ?? "subject"
  ].join(":");
}

function reconciliationPhysicalIdentity(row) {
  const platform = normalizePlatform(row?.platform ?? "");
  const identity = row?.platformPostId ?? mergedPublicEvidenceIdentity(platform, row).urlId;
  return identity ? `${platform}:${String(identity).toLowerCase()}` : null;
}

function validateMergedPublicEvidence(
  row,
  {
    resolveNativeAuthor = null,
    nativeAuthorResolution = null,
    verifiedMetriclessEvidence = false,
    verifiedContextEvidence = false
  } = {}
) {
  const platform = normalizePlatform(row.platform ?? "");
  const sourceUrl = canonicalUrl(row.sourceUrl ?? row.canonicalUrl ?? row.url);
  const identity = mergedPublicEvidenceIdentity(platform, { ...row, sourceUrl });
  const metricValidation = mergedPublicMetricValidation(platform, row.metrics);
  const reasons = [];
  let attributionFailure = false;
  let reconciliationEligible = false;
  const verifiedContextException = verifiedContextEvidence === true;

  if (!row?.batchSlug && !row?.batch_slug) reasons.push("missing_or_ambiguous_batch_scope");
  if (!MERGED_PUBLIC_SCORING_METRICS[platform] && !verifiedContextException) {
    reasons.push(`unsupported_platform:${platform || "missing"}`);
  }
  if (!sourceUrl) reasons.push("invalid_url");
  if (sourceUrl && !identity.urlId && !verifiedContextException) {
    reasons.push("not_native_activity_url");
  }
  if (identity.conflict) {
    reasons.push(`native_id_conflict:url=${identity.urlId};explicit=${identity.explicitId}`);
  }
  if (row.review_state !== "verified") reasons.push(`not_verified:${row.review_state ?? "missing"}`);
  if (["invalid", "blocked"].includes(row.linkStatus)) reasons.push(`invalid_link:${row.linkStatus}`);
  if (metricValidation.unsupported.length > 0) {
    reasons.push(`unsupported_metrics:${metricValidation.unsupported.join(",")}`);
  }
  if (platform === "linkedin" && row?.linkedinParentMetricReceipt?.status === "unproven") {
    reasons.push(
      row.linkedinParentMetricReceipt.reason ?? "linkedin_parent_engagement_not_structurally_verified"
    );
  }
  const verifiedMetriclessException =
    !metricValidation.hasPositiveScoringMetric && verifiedMetriclessEvidence === true;
  if (
    !metricValidation.hasPositiveScoringMetric &&
    !verifiedMetriclessException &&
    !verifiedContextException
  ) {
    reasons.push("no_visible_positive_scoring_metrics");
  }

  let semanticAttribution = null;
  if (typeof resolveNativeAuthor === "function") {
    const ownership = mergedPublicOwnershipValidation(row, resolveNativeAuthor, nativeAuthorResolution);
    if (!ownership.ok) {
      reasons.push(ownership.reason);
      attributionFailure = true;
      reconciliationEligible = true;
    }
    if (isGenericSearchYouTubeRow(row) && !validGenericYouTubeAttributionReceipt(row)) {
      reasons.push("generic_youtube_missing_attribution_v2_native_channel_receipt");
      attributionFailure = true;
    }
    semanticAttribution = mergedSemanticAttribution(row, resolveNativeAuthor, nativeAuthorResolution);
    if (!semanticAttribution.verified) {
      reasons.push(`semantic_attribution:${semanticAttribution.reason}`);
      attributionFailure = true;
      reconciliationEligible ||= mergedSemanticAttributionCertainRejection(semanticAttribution);
    } else if (genericYoutubeChannelBrandOnlyWithoutProductionEntitySignal(row, semanticAttribution)) {
      reasons.push("generic_youtube_channel_brand_only_without_production_entity_signal");
      attributionFailure = true;
      reconciliationEligible = true;
    }
  }

  if (reasons.length > 0) {
    return { ok: false, reasons, attributionFailure, reconciliationEligible, semanticAttribution };
  }
  const conflictingBatchNote = semanticAttribution?.conflictingBatch
    ? " Third-party title cohort label conflicts with the canonical catalog; canonical roster scope was retained because independent exact identity anchors resolved the company."
    : "";
  return {
    ok: true,
    row: {
      ...row,
      platform,
      sourceUrl,
      platformPostId: verifiedContextException ? sourceUrl : identity.urlId,
      ...(semanticAttribution && !verifiedContextException
        ? {
            attributionVersion: Math.max(
              PUBLIC_EVIDENCE_ATTRIBUTION_VERSION,
              Number(row.attributionVersion ?? 0)
            ),
            attributionStatus: "verified",
            attributionMode: mergedPublicAttributionMode(row),
            attributionSignals: semanticAttribution.signals,
            attributionDescriptorMatches: semanticAttribution.descriptorMatches,
            matchReason: appendPublicReasonOnce(
              row.matchReason ?? "Verified public evidence.",
              conflictingBatchNote
            )
          }
        : {})
    },
    attributionFailure: false,
    semanticAttribution
  };
}

const MERGED_ATTRIBUTION_DESCRIPTOR_STOP_WORDS = new Set([
  "about", "agent", "agents", "and", "are", "build", "building", "built", "companies",
  "company", "for", "from", "into", "its", "our", "platform", "product", "products",
  "that", "the", "their", "they", "this", "through", "using", "with", "your"
]);

function canonicalMergedCompanyAttribution(row, resolveNativeAuthor) {
  if ((row?.entityType ?? row?.entity_type ?? "company") !== "company") return null;
  const owner = resolveNativeAuthor.companyForRow?.(row);
  if (!owner?.company || !owner.entityId || !owner.companySlug) return null;
  const canonicalAttribution = {
    batchSlug: owner.batchSlug,
    entityType: "company",
    entityId: owner.entityId,
    companySlug: owner.companySlug,
    companyName: owner.companyName
  };
  const staleAttribution = publicAttribution(row);
  const identityChanged = !samePublicAttribution(staleAttribution, canonicalAttribution);
  const displayChanged =
    String(row?.entityName ?? "") !== String(owner.entityName ?? "") ||
    String(row?.companySlug ?? row?.company_slug ?? "") !== String(owner.companySlug ?? "") ||
    String(row?.companyName ?? row?.company_name ?? "") !== String(owner.companyName ?? "");
  if (!identityChanged && !displayChanged) return null;
  const reason = identityChanged
    ? "canonical_company_legacy_alias_reassignment"
    : "canonical_company_display_refresh";
  return {
    reason,
    row: {
      ...row,
      ...canonicalAttribution,
      entityName: owner.entityName,
      ...(row?.attachedCompanyId ? { attachedCompanyId: owner.companyEntityId } : {}),
      ...(identityChanged && !row?.previousAttribution
        ? { previousAttribution: staleAttribution }
        : {}),
      attributionReconciliationReason: reason
    }
  };
}

function mergedSemanticAttribution(row, resolveNativeAuthor, nativeAuthorResolution) {
  const companyOwner = resolveNativeAuthor.companyForRow?.(row);
  const company = companyOwner?.company;
  if (!company) {
    return {
      verified: false,
      reason: "canonical_company_attribution_unresolved",
      signals: [],
      descriptorMatches: []
    };
  }
  const text = publicEvidenceAttributionText(row);
  const companyNames = mergedCompanyAttributionNames(company);
  const companyNameMentioned = companyNames.some((name) => containsExactTokenSequence(text, name));
  const signals = [];
  if (
    nativeAuthorResolution?.status === "matched" &&
    nativeAuthorResolution.owner?.entityType === (row.entityType ?? row.entity_type ?? "company") &&
    nativeAuthorResolution.owner?.entityId === (row.entityId ?? row.entity_id)
  ) {
    signals.push("unique_native_author");
  }
  if (
    nativeAuthorResolution?.status === "matched" &&
    nativeAuthorResolution.owner?.companySlug === (row.companySlug ?? row.company_slug) &&
    companyNameMentioned
  ) {
    signals.push("same_company_native_author_subject");
  }
  if (mergedCompanyDomainMentioned(company, row, text)) signals.push("company_domain");
  if (hasDistinctiveCatalogPhrase(company, text)) signals.push("catalog_distinctive_phrase");
  if (isListOrRoundupAttributionContext(row.batchSlug ?? row.batch_slug, text)) {
    signals.push("batch_list_only");
  }
  // The public subject text deliberately strips native-author title chrome.
  // A full canonical founder in that original title suffix is still valid
  // corroboration, but only alongside an exact company subject match in the
  // shared assessment below.
  const rosterFounderMatches = mergedRosterFounderMatches(company, `${text}\n${row?.title ?? ""}`);
  if (rosterFounderMatches.length > 0) {
    signals.push("roster_founder");
  }
  if (rosterFounderMatches.length >= 2) signals.push("multiple_roster_founders");
  if (
    (row.entityType ?? row.entity_type) === "founder" &&
    mergedAssignedFounderNameMentioned(row, company, nativeAuthorResolution)
  ) {
    signals.push("founder_subject_exact_identity");
  }
  if (mergedMappedAccountMatches(company, row)) signals.push("mapped_official_account");
  const channelName = String(row?.youtubeChannelName ?? "");
  const channelBrandNames = channelName
    ? companyNames.filter((name) => mergedCompanyBrandMatchesChannel(name, channelName))
    : [];
  if (
    channelBrandNames.length > 0 &&
    (channelBrandNames.some((name) => !isCollisionProneCompanyName(name)) ||
      organizationQualifiedBatchMarker(row.batchSlug ?? row.batch_slug, `${text}\n${channelName}`))
  ) {
    signals.push("native_channel_brand");
  }
  if (
    channelName &&
    (company?.founders ?? []).some((founder) => {
      const name = String(founder?.name ?? "").trim();
      return name.split(/\s+/).filter(Boolean).length >= 2 && containsExactTokenSequence(channelName, name);
    })
  ) {
    signals.push("native_channel_roster_founder");
  }
  if (Number(row.attributionVersion ?? 0) >= PUBLIC_EVIDENCE_ATTRIBUTION_VERSION) {
    for (const signal of row.attributionSignals ?? []) {
      if ([
        "company_domain",
        "batch_list_only",
        "founder_subject_exact_identity",
        "mapped_official_account",
        "native_channel_brand",
        "native_channel_roster_founder",
        "roster_founder",
        "same_company_native_author_subject",
        "unique_native_author"
      ].includes(signal)) {
        signals.push(signal);
      }
    }
  }
  const assessments = companyNames.map((companyName) => assessPublicEvidenceAttribution({
    batchSlug: row.batchSlug ?? row.batch_slug,
    companyName,
    text,
    signals,
    descriptorMatches: mergedCompanyDescriptorMatches(company, text)
  }));
  return assessments.find((assessment) => assessment.verified) ??
    assessments.find((assessment) => assessment.companySubjectNameMatch) ??
    assessments[0];
}

function mergedCompanyAttributionNames(company) {
  const names = [];
  const seen = new Set();
  for (const value of [company?.name, ...(company?.legacyEntityAliases ?? [])]) {
    const name = String(value ?? "").normalize("NFKC").trim();
    if (!name || /^company-/i.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function mergedPublicAttributionMode(row) {
  const explicit = String(row?.attributionMode ?? row?.attributionType ?? "").trim().toLowerCase();
  if (["author", "account_owner", "owner"].includes(explicit)) return "account_owner";
  if (explicit === "subject") return "subject";
  return row?.accountUrl ? "account_owner" : "subject";
}

function shouldReassignMergedPublicRow(row, resolveNativeAuthor, nativeAuthorResolution) {
  if (mergedPublicAttributionMode(row) !== "subject") return true;
  const company = resolveNativeAuthor.companyForRow?.(row)?.company;
  if (!company) return true;
  if ((row?.entityType ?? row?.entity_type ?? "company") === "founder") {
    return !mergedAssignedFounderNameMentioned(row, company, nativeAuthorResolution) &&
      !mergedNativeOwnerMatchesRow(row, nativeAuthorResolution);
  }
  if (
    nativeAuthorResolution?.owner?.companySlug === (row?.companySlug ?? row?.company_slug) &&
    containsExactTokenSequence(publicEvidenceAttributionText(row), company.name)
  ) {
    return false;
  }
  return !mergedSemanticAttribution(row, resolveNativeAuthor, null).verified;
}

function mergedFounderToCompanySubjectReassignment(row, resolveNativeAuthor, nativeAuthorResolution) {
  if (mergedPublicAttributionMode(row) !== "subject") return null;
  if ((row?.entityType ?? row?.entity_type ?? "company") !== "founder") return null;
  const companyOwner = resolveNativeAuthor.companyForRow?.(row);
  const company = companyOwner?.company;
  if (!company) return null;
  if (
    mergedAssignedFounderNameMentioned(row, company, nativeAuthorResolution) ||
    mergedNativeOwnerMatchesRow(row, nativeAuthorResolution)
  ) {
    return null;
  }
  const companyRowFor = (owner) => ({
    ...row,
    batchSlug: owner.batchSlug,
    entityType: "company",
    entityId: owner.companyEntityId ?? owner.entityId,
    entityName: owner.company.name,
    companySlug: owner.companySlug,
    companyName: owner.company.name,
    attributionMode: "subject",
    previousAttribution: publicAttribution(row),
    nativeAuthorResolution
  });
  const currentCompanyRow = companyRowFor(companyOwner);
  const currentAssessment = mergedSemanticAttribution(
    currentCompanyRow,
    resolveNativeAuthor,
    nativeAuthorResolution
  );
  let resolvedCompanyRow = currentAssessment.verified ? currentCompanyRow : null;

  if (!resolvedCompanyRow) {
    const matches = [];
    const seen = new Set();
    for (const owner of resolveNativeAuthor.companyOwners ?? []) {
      const key = `${owner.batchSlug}:${owner.companyEntityId ?? owner.entityId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const candidate = companyRowFor(owner);
      const assessment = mergedSemanticAttribution(candidate, resolveNativeAuthor, nativeAuthorResolution);
      // First count every ordinary exact company+cohort subject. A second
      // company makes the physical post ambiguous even if only one entry also
      // names roster founders.
      if (
        assessment.verified &&
        assessment.companySubjectNameMatch &&
        assessment.expectedBatch &&
        !assessment.signals.includes("batch_list_only")
      ) {
        matches.push({ candidate, assessment });
      }
    }
    if (matches.length !== 1) return null;
    if (!matches[0].assessment.signals.includes("roster_founder")) return null;
    resolvedCompanyRow = matches[0].candidate;
  }
  resolvedCompanyRow = {
    ...resolvedCompanyRow,
    matchReason: appendPublicReasonOnce(
      row.matchReason ?? "Verified public evidence.",
      `Assigned founder was not established by the primary post; unique exact company evidence reassigned this physical post to company ${resolvedCompanyRow.companyName}.`
    )
  };
  return {
    row: resolvedCompanyRow,
    reason: "founder_subject_reassigned_to_verified_company_subject"
  };
}

function mergedPublicOwnershipValidation(row, resolveNativeAuthor, nativeAuthorResolution) {
  const platform = normalizePlatform(row?.platform);
  if (!["x", "linkedin", "instagram"].includes(platform)) return { ok: true };
  const mode = mergedPublicAttributionMode(row);
  const company = resolveNativeAuthor.companyForRow?.(row)?.company ?? nativeAuthorResolution?.company;
  if (nativeAuthorResolution?.status === "ambiguous") {
    return { ok: false, reason: "native_author_ambiguous:multiple_canonical_owners" };
  }
  if (mode === "account_owner") {
    return mergedNativeOwnerMatchesRow(row, nativeAuthorResolution)
      ? { ok: true }
      : {
          ok: false,
          reason: `account_owner_native_author_mismatch:${nativeAuthorResolution?.status ?? "unavailable"}`
        };
  }
  if ((row?.entityType ?? row?.entity_type ?? "company") === "founder") {
    return mergedNativeOwnerMatchesRow(row, nativeAuthorResolution) ||
      mergedAssignedFounderNameMentioned(row, company, nativeAuthorResolution)
      ? { ok: true }
      : { ok: false, reason: "founder_subject_without_exact_founder_or_native_owner" };
  }
  return { ok: true };
}

function mergedNativeOwnerMatchesRow(row, nativeAuthorResolution) {
  return nativeAuthorResolution?.status === "matched" &&
    nativeAuthorResolution.owner?.entityType === (row?.entityType ?? row?.entity_type ?? "company") &&
    nativeAuthorResolution.owner?.entityId === (row?.entityId ?? row?.entity_id) &&
    nativeAuthorResolution.owner?.batchSlug === (row?.batchSlug ?? row?.batch_slug);
}

function mergedAssignedFounderNameMentioned(row, company, nativeAuthorResolution = row?.nativeAuthorResolution) {
  const entityId = row?.entityId ?? row?.entity_id;
  const founder = (company?.founders ?? []).find((candidate) => candidate.sourceKey === entityId);
  const name = String(founder?.name ?? "").trim();
  if (name.split(/\s+/).filter(Boolean).length < 2) return false;
  if (containsExactTokenSequence(publicEvidenceAttributionText(row), name)) return true;
  return String(nativeAuthorResolution?.author?.key ?? "").toLowerCase() === slugify(name);
}

function appendPublicReasonOnce(reason, note) {
  const base = String(reason ?? "").trim();
  const addition = String(note ?? "").trim();
  if (!addition || base.includes(addition)) return base;
  return `${base}${base ? " " : ""}${addition}`;
}

function mergedCompanyBrandMatchesChannel(companyName, channelName) {
  if (containsExactTokenSequence(channelName, companyName)) return true;
  const tokens = String(companyName ?? "").normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
  const genericSuffixes = new Set(["ai", "app", "inc", "labs", "technologies", "technology"]);
  if (tokens.length < 2 || !genericSuffixes.has(tokens.at(-1).toLowerCase())) return false;
  return containsExactTokenSequence(channelName, tokens.slice(0, -1).join(" "));
}

function mergedCompanyDomainMentioned(company, row, text) {
  const host = normalizedHost(company?.websiteUrl);
  if (!host) return false;
  if (String(text ?? "").toLowerCase().includes(host)) return true;
  return [row?.sourceUrl, row?.submittedUrl]
    .filter(Boolean)
    .some((url) => {
      const candidate = normalizedHost(url);
      return candidate === host || candidate?.endsWith(`.${host}`);
    });
}

function mergedRosterFounderMatches(company, text) {
  return (company?.founders ?? []).filter((founder) => {
    const name = String(founder?.name ?? "")
      .replace(/\s*\([^)]*\)\s*$/, "")
      .trim();
    return name.split(/\s+/).filter(Boolean).length >= 2 && containsExactTokenSequence(text, name);
  });
}

function mergedMappedAccountMatches(company, row) {
  const platform = normalizePlatform(row?.platform);
  const entityType = row?.entityType ?? row?.entity_type ?? "company";
  const entityId = row?.entityId ?? row?.entity_id;
  const owner = entityType === "founder"
    ? (company?.founders ?? []).find((founder) => founder.sourceKey === entityId)
    : company;
  if (!owner) return false;
  const candidateUrls = [row?.accountUrl, row?.youtubeChannelUrl].filter(Boolean);
  if (candidateUrls.length === 0 && !row?.youtubeChannelId) return false;
  const candidateKeys = new Set(candidateUrls.map((url) => canonicalMappedAccountIdentity(platform, url)).filter(Boolean));
  if (row?.youtubeChannelId) candidateKeys.add(`youtube:channel:${String(row.youtubeChannelId).toLowerCase()}`);
  return (owner.accounts ?? []).some((account) => {
    if (normalizePlatform(account?.platform) !== platform) return false;
    const key = canonicalMappedAccountIdentity(platform, account?.url);
    if (key && candidateKeys.has(key)) return true;
    return platform === "youtube" && row?.youtubeChannelId &&
      String(account?.accountId ?? "").toLowerCase() === String(row.youtubeChannelId).toLowerCase();
  });
}

function canonicalMappedAccountIdentity(platform, rawUrl) {
  const normalizedPlatform = normalizePlatform(platform);
  const canonicalUrl = canonicalSocialAccountUrl(normalizedPlatform, rawUrl);
  if (!canonicalUrl) return null;
  if (normalizedPlatform === "youtube") {
    const channel = new URL(canonicalUrl).pathname.match(/^\/channel\/(uc[\w-]+)$/i)?.[1];
    if (channel) return `youtube:channel:${channel.toLowerCase()}`;
  }
  return `${normalizedPlatform}:${canonicalUrl.toLowerCase()}`;
}

function mergedCompanyDescriptorMatches(company, text) {
  const candidateTokens = new Set(String(text ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const companyTokens = new Set(String(company?.name ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []);
  return [...new Set(
    String(`${company?.tagline ?? ""} ${company?.description ?? ""}`).toLowerCase().match(/[a-z0-9]+/g) ?? []
  )]
    .filter((token) => token.length >= 2)
    .filter((token) => !companyTokens.has(token))
    .filter((token) => !MERGED_ATTRIBUTION_DESCRIPTOR_STOP_WORDS.has(token))
    .filter((token) => candidateTokens.has(token));
}

function normalizedHost(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function isGenericSearchYouTubeRow(row) {
  return normalizePlatform(row?.platform) === "youtube" && !row?.accountUrl &&
    /(?:public\s+youtube\s+search|generic[_ -]?search|youtube\s+search\s+result)/i.test(String(row?.matchReason ?? ""));
}

function validGenericYouTubeAttributionReceipt(row) {
  return Number(row?.attributionVersion ?? 0) >= PUBLIC_EVIDENCE_ATTRIBUTION_VERSION &&
    Boolean(row?.youtubeChannelId || row?.youtubeChannelUrl);
}

function genericYoutubeChannelBrandOnlyWithoutProductionEntitySignal(row, assessment) {
  if (!isGenericSearchYouTubeRow(row)) return false;
  if (assessment?.expectedBatch || (assessment?.descriptorMatches?.length ?? 0) > 0) return false;
  if (
    assessment?.signals?.length !== 1 ||
    assessment.signals[0] !== "native_channel_brand"
  ) {
    return false;
  }

  const companyTokens = String(row?.companyName ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const shortSingleTokenBrand = companyTokens.length === 1 && companyTokens[0].length <= 4;
  const channelName = String(row?.youtubeChannelName ?? "");
  const unrelatedInstitutionalQualifier = companyTokens.length === 1 &&
    containsExactTokenSequence(channelName, row?.companyName) &&
    /\b(?:academy|association|bank|college|foundation|hospital|institute|school|university)\b/i.test(channelName);
  return shortSingleTokenBrand || unrelatedInstitutionalQualifier;
}

function mergedSemanticAttributionCertainRejection(assessment) {
  if (assessment?.verified) return false;
  if (assessment?.reason === "company_name_token_boundary_mismatch") return true;
  if (assessment?.reason === "list_or_roundup_without_target_specific_owner_anchor") return true;
  if (assessment?.reason === "collision_prone_name_without_independent_anchor") {
    return !assessment.expectedBatch;
  }
  return false;
}

function quarantinedPublicEvidence(row, reasons, metadata = null) {
  const sourceId = row.id ?? `${evidenceEntityAttribution(row)}-${row.platform ?? "unknown"}`;
  return {
    ...row,
    id: `quarantined-${sourceId}`,
    sourceEvidenceId: row.id ?? null,
    candidateUrl: row.sourceUrl ?? row.canonicalUrl ?? row.url ?? null,
    review_state: "needs_review",
    quarantineReasons: reasons,
    matchReason: `Quarantined during public evidence merge: ${reasons.join("; ")}.`,
    ...(metadata ? { duplicateEvidenceIdentity: metadata } : {})
  };
}

function withSnapshotRowBatch(row, snapshot, resolveBatchSlug) {
  if (typeof resolveBatchSlug === "function") {
    // Catalog identity is authoritative. In particular, never let a collector
    // lane's single-batch envelope stamp a canonically resolvable row from a
    // different cohort. A resolver null is also authoritative: conflicts stay
    // unscoped and fail closed instead of inheriting a plausible-looking lane.
    return withCanonicalRowBatch(row, resolveBatchSlug(row));
  }
  const existing = row?.batchSlug ?? row?.batch_slug;
  if (existing) return withCanonicalRowBatch(row, existing);
  const batches = snapshotBatchSlugs(snapshot);
  return batches.length === 1
    ? withCanonicalRowBatch(row, batches[0])
    : withCanonicalRowBatch(row, null);
}

function withSnapshotReviewBatch(row, snapshot, resolveBatchSlug) {
  const reviewRow = withSnapshotRowBatch(row, snapshot, resolveBatchSlug);
  const directive = reviewRow?.attributionReconciliationDirective;
  if (!directive?.staleAttribution) return reviewRow;
  const stale = {
    ...publicAttribution(reviewRow),
    ...directive.staleAttribution
  };
  const staleRow = withSnapshotRowBatch({
    ...reviewRow,
    batchSlug: stale.batchSlug,
    entityType: stale.entityType,
    entityId: stale.entityId,
    companySlug: stale.companySlug ?? reviewRow.companySlug ?? reviewRow.company_slug,
    companyName: stale.companyName ?? reviewRow.companyName ?? reviewRow.company_name,
    attributionType: stale.attributionType
  }, snapshot, resolveBatchSlug);
  const canonicalStale = {
    ...stale,
    ...publicAttribution(staleRow)
  };
  if (!canonicalStale.batchSlug) delete canonicalStale.batchSlug;
  return {
    ...reviewRow,
    attributionReconciliationDirective: {
      ...directive,
      staleAttribution: canonicalStale
    }
  };
}

function withCanonicalRowBatch(row, batchSlug) {
  const { batchSlug: _camelBatch, batch_slug: _snakeBatch, ...rest } = row ?? {};
  return batchSlug ? { ...rest, batchSlug } : rest;
}

function snapshotBatchSlugs(snapshot) {
  return [...new Set([
    snapshot?.source?.batchSlug,
    ...(Array.isArray(snapshot?.source?.batchSlugs) ? snapshot.source.batchSlugs : [])
  ].filter(Boolean))];
}

function rowBatchScope(row) {
  return String(row?.batchSlug ?? row?.batch_slug ?? "unscoped").trim().toUpperCase() || "unscoped";
}

function mergedPublicMetricValidation(platform, value) {
  const metrics = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const aliases = {
    plays: "views",
    points: "upvotes",
    retweets: "reposts",
    reactions: platform === "linkedin" ? "reactions" : "likes",
    likes: platform === "linkedin" ? "reactions" : "likes",
    comments: platform === "x" ? "replies" : "comments",
    saves: platform === "x" ? "bookmarks" : "saves"
  };
  const supported = MERGED_PUBLIC_DISPLAY_METRICS[platform] ?? new Set();
  const scoring = MERGED_PUBLIC_SCORING_METRICS[platform] ?? new Set();
  const unsupported = [];
  let hasPositiveScoringMetric = false;
  for (const [rawKey, rawValue] of Object.entries(metrics)) {
    const key = aliases[rawKey] ?? rawKey;
    if (MERGED_PUBLIC_DERIVED_METRICS.has(key)) continue;
    const number = typeof rawValue === "string" ? Number(rawValue.replace(/,/g, "")) : Number(rawValue);
    if (!Number.isFinite(number) || number < 0) {
      unsupported.push(`${key}:invalid_value`);
      continue;
    }
    if (!supported.has(key)) {
      unsupported.push(key);
      continue;
    }
    if (number > 0 && scoring.has(key)) hasPositiveScoringMetric = true;
  }
  return {
    unsupported: [...new Set(unsupported)].sort(),
    hasPositiveScoringMetric
  };
}

function mergedPublicEvidenceIdentity(platform, row) {
  const sourceUrl = row.sourceUrl ?? row.canonicalUrl ?? row.url;
  const urlId = strictNativePublicIdentity(platform, sourceUrl);
  const rawExplicit = row.platformPostId ?? row.platform_post_id ?? row.platformObjectId ?? row.nativeId;
  const explicitId = normalizeExplicitPublicIdentity(platform, rawExplicit);
  return {
    urlId,
    explicitId,
    conflict: Boolean(urlId && explicitId && !publicIdentitiesMatch(platform, urlId, explicitId))
  };
}

function strictNativePublicIdentity(platform, rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (platform === "x" && ["x.com", "twitter.com", "mobile.twitter.com"].includes(host)) {
      return path.match(/^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/web\/status)\/(\d+)(?:\/(?:photo|video)\/\d+)?$/i)?.[1] ?? null;
    }
    if (platform === "linkedin" && (host === "linkedin.com" || host.endsWith(".linkedin.com"))) {
      return path.match(/^\/feed\/update\/urn:li:activity:(\d+)$/i)?.[1] ??
        path.match(/^\/posts\/[^/]*?activity[-:](\d+)(?:-[^/]*)?$/i)?.[1] ?? null;
    }
    if (platform === "instagram" && ["instagram.com", "m.instagram.com"].includes(host)) {
      return path.match(/^\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)$/i)?.[1] ?? null;
    }
    if (platform === "youtube") {
      if (host === "youtu.be") return path.match(/^\/([A-Za-z0-9_-]{6,})$/)?.[1] ?? null;
      if (!["youtube.com", "m.youtube.com"].includes(host)) return null;
      const value = path === "/watch" ? url.searchParams.get("v") : path.match(/^\/(?:shorts|live)\/([A-Za-z0-9_-]+)$/i)?.[1];
      return /^[A-Za-z0-9_-]{6,}$/.test(value ?? "") ? value : null;
    }
    if (platform === "reddit") {
      if (host === "redd.it") return path.match(/^\/([A-Za-z0-9]+)$/)?.[1]?.toLowerCase() ?? null;
      if (!(host === "reddit.com" || host.endsWith(".reddit.com"))) return null;
      return path.match(/^\/(?:r\/[A-Za-z0-9_]+\/)?comments\/([A-Za-z0-9]+)(?:\/[A-Za-z0-9_%.-]+)?(?:\/[A-Za-z0-9]+)?$/i)?.[1]?.toLowerCase() ?? null;
    }
    if (platform === "hacker_news" && host === "news.ycombinator.com" && path === "/item") {
      const value = url.searchParams.get("id");
      return /^\d+$/.test(value ?? "") ? value : null;
    }
    if (platform === "product_hunt" && host === "producthunt.com") {
      const direct = path.match(/^\/(posts)\/([A-Za-z0-9][A-Za-z0-9_-]*)$/i);
      if (direct) return `${direct[1].toLowerCase()}/${direct[2].toLowerCase()}`;
      const forum = path.match(/^\/(p)\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\/([A-Za-z0-9][A-Za-z0-9_-]*))?$/i);
      if (forum) return [forum[1], forum[2], forum[3]].filter(Boolean).join("/").toLowerCase();
      const launch = path.match(/^\/(products)\/([A-Za-z0-9][A-Za-z0-9_-]*)\/(launches)\/([A-Za-z0-9][A-Za-z0-9_-]*)$/i);
      return launch ? launch.slice(1).join("/").toLowerCase() : null;
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeExplicitPublicIdentity(platform, rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return strictNativePublicIdentity(platform, value);
  if (platform === "x") return value.match(/(?:^|\/)status\/(\d+)/i)?.[1] ?? (/^\d+$/.test(value) ? value : null);
  if (platform === "linkedin") return value.match(/activity[-:](\d+)/i)?.[1] ?? (/^\d+$/.test(value) ? value : null);
  if (platform === "instagram") return value.match(/^(?:\/)?(?:p|reel|tv)[/:]([A-Za-z0-9_-]+)/i)?.[1] ?? (/^[A-Za-z0-9_-]+$/.test(value) ? value : null);
  if (platform === "youtube") return value.match(/^(?:shorts|live)\/([A-Za-z0-9_-]+)$/i)?.[1] ?? (/^[A-Za-z0-9_-]{6,}$/.test(value) ? value : null);
  if (platform === "reddit") return (value.match(/(?:^|\/)comments\/([A-Za-z0-9]+)/i)?.[1] ?? value.replace(/^t3_/i, "")).toLowerCase();
  if (platform === "hacker_news") return /^\d+$/.test(value) ? value : null;
  if (platform === "product_hunt") {
    const normalized = value.replace(/^\/+|\/+$/g, "").toLowerCase();
    return /^(?:posts\/[a-z0-9][a-z0-9_-]*|p\/[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)?|products\/[a-z0-9][a-z0-9_-]*\/launches\/[a-z0-9][a-z0-9_-]*)$/.test(normalized) ||
      /^[a-z0-9][a-z0-9_-]*$/.test(normalized)
      ? normalized
      : null;
  }
  return null;
}

function publicIdentitiesMatch(platform, urlId, explicitId) {
  if (urlId === explicitId) return true;
  if (platform !== "product_hunt") return false;
  const aliases = new Set([urlId.replace(/\//g, "-")]);
  const launch = urlId.match(/^products\/([^/]+)\/launches\/([^/]+)$/);
  if (launch) aliases.add(`${launch[1]}-${launch[2]}`);
  const direct = urlId.match(/^posts\/([^/]+)$/);
  if (direct) aliases.add(direct[1]);
  const forum = urlId.match(/^p\/([^/]+)$/);
  if (forum) aliases.add(forum[1]);
  return aliases.has(explicitId);
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|ref_|source$|si$|feature$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.replace(/^www\./, "").replace(/^twitter\.com$/, "x.com");
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

function dedupeRows(rows, keyForRow) {
  const byKey = new Map();
  for (const row of rows) {
    const key = keyForRow(row);
    const previous = byKey.get(key);
    if (!previous || rowTimestamp(row) >= rowTimestamp(previous)) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

function dedupeOperationalRows(rows, keyForRow) {
  const byKey = new Map();
  for (const row of rows) {
    const key = keyForRow(row);
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, row);
      continue;
    }
    const rowTime = rowTimestamp(row);
    const previousTime = rowTimestamp(previous);
    if (
      rowTime > previousTime ||
      (
        rowTime === previousTime &&
        JSON.stringify(stableJsonObjectKeyOrder(row)).localeCompare(
          JSON.stringify(stableJsonObjectKeyOrder(previous))
        ) >= 0
      )
    ) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

function dedupeReviewRows(rows, keyForRow) {
  const byKey = new Map();
  for (const row of rows) {
    const key = keyForRow(row);
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, row);
      continue;
    }
    const previousHasExactQuarantine = Array.isArray(previous?.quarantineReasons) &&
      previous.quarantineReasons.length > 0;
    const rowHasExactQuarantine = Array.isArray(row?.quarantineReasons) &&
      row.quarantineReasons.length > 0;
    const previousCanonicalAttribution = canonicalReviewAttributionScore(previous);
    const rowCanonicalAttribution = canonicalReviewAttributionScore(row);
    const rowWins = rowHasExactQuarantine !== previousHasExactQuarantine
      ? rowHasExactQuarantine
      : rowCanonicalAttribution !== previousCanonicalAttribution
        ? rowCanonicalAttribution > previousCanonicalAttribution
        : rowTimestamp(row) >= rowTimestamp(previous);
    const selected = rowWins ? row : previous;
    const alternate = rowWins ? previous : row;
    byKey.set(key, {
      ...selected,
      ...(!selected.attributionReconciliationDirective && alternate.attributionReconciliationDirective
        ? { attributionReconciliationDirective: alternate.attributionReconciliationDirective }
        : {})
    });
  }
  return [...byKey.values()];
}

function canonicalReviewAttributionScore(row) {
  if ((row?.entityType ?? row?.entity_type ?? "company") !== "company") return 0;
  const companySlug = String(row?.companySlug ?? row?.company_slug ?? "").toLowerCase();
  const entityId = String(row?.entityId ?? row?.entity_id ?? "").toLowerCase();
  if (!companySlug || !entityId) return 0;
  const expected = rowBatchScope(row) === "A16ZSR006"
    ? `a16z-speedrun-006-${companySlug}`
    : `company-${companySlug}`;
  return entityId === expected ? 1 : 0;
}

function stableJsonObjectKeyOrder(value) {
  if (Array.isArray(value)) return value.map(stableJsonObjectKeyOrder);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, stableJsonObjectKeyOrder(value[key])])
  );
}

function rowTimestamp(row) {
  const parsed = Date.parse(
    row.last_checked_at ?? row.lastCheckedAt ?? row.checkedAt ?? row.collected_at ?? row.collectedAt ?? 0
  );
  return Number.isFinite(parsed) ? parsed : 0;
}
