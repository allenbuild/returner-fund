import { access, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  buildAutonomousTaskPlan,
  loadAutonomousCatalogs
} from "./autonomous-ingestion-plan.mjs";
import { canonicalGithubTargetUrl } from "./github-url.mjs";

export const COVERAGE_AUDIT_SCHEMA_VERSION = "cohort-coverage-audit.v1";

export const COVERAGE_BATCH_SPECS = Object.freeze([
  {
    batchSlug: "S2026",
    catalogPath: "src/lib/yc/spring-2026-companies.json",
    graphPath: "public/graph/s2026.json",
    runSuffix: "s2026",
    catalogKind: "yc"
  },
  {
    batchSlug: "S26",
    catalogPath: "src/lib/yc/summer-2026-companies.json",
    graphPath: "public/graph/s26.json",
    runSuffix: "s26",
    catalogKind: "yc"
  },
  {
    batchSlug: "A16ZSR006",
    catalogPath: "src/lib/social/a16z-speedrun-006-social-accounts.json",
    profilePath: "src/lib/graph/a16z-speedrun-006-dataset.ts",
    graphPath: "public/graph/a16zsr006.json",
    runSuffix: "a16zsr006",
    catalogKind: "graph"
  }
]);

const AUDITED_MAPPING_PLATFORMS = Object.freeze([
  "github",
  "instagram",
  "linkedin",
  "product_hunt",
  "x",
  "youtube"
]);

const PLATFORM_ALIASES = Object.freeze({
  twitter: "x",
  producthunt: "product_hunt"
});

export async function loadAuthoritativeCoverageInputs(rootDir, options = {}) {
  const overridesPath = join(rootDir, "src/lib/social/verified-social-overrides.json");
  const [overrides, autonomousCatalogs] = await Promise.all([
    readOptionalJson(overridesPath, {}),
    loadAutonomousCatalogs(rootDir)
  ]);
  const planTasks = buildAutonomousTaskPlan(autonomousCatalogs, {
    runKey: "cohort-coverage-audit"
  });
  const planTasksByBatch = Map.groupBy(planTasks, (task) => task.batchSlug);
  const cohorts = [];

  for (const spec of COVERAGE_BATCH_SPECS) {
    const catalogPath = join(rootDir, spec.catalogPath);
    const graphPath = join(rootDir, spec.graphPath);
    const profilePath = spec.profilePath ? join(rootDir, spec.profilePath) : null;
    const [catalogSource, graph, profileSource] = await Promise.all([
      readJson(catalogPath),
      readJson(graphPath),
      profilePath ? readFile(profilePath, "utf8") : null
    ]);
    const catalog = spec.catalogKind === "yc"
      ? buildYcOwnerInventory({
          batchSlug: spec.batchSlug,
          catalog: catalogSource,
          overrides
        })
      : buildA16zOwnerInventory({
          batchSlug: spec.batchSlug,
          socialCatalog: catalogSource,
          profileSource,
          overrides
        });
    const graphInventory = buildGraphOwnerInventory({ batchSlug: spec.batchSlug, graph });
    const runOutputs = options.runDir
      ? await loadBatchRunOutputs(options.runDir, spec.runSuffix)
      : null;

    cohorts.push({
      batchSlug: spec.batchSlug,
      catalogPath: displayPath(rootDir, catalogPath),
      profilePath: profilePath ? displayPath(rootDir, profilePath) : null,
      graphPath: displayPath(rootDir, graphPath),
      catalog,
      graphInventory,
      graph,
      planTasks: planTasksByBatch.get(spec.batchSlug) ?? [],
      runOutputs
    });
  }

  return cohorts;
}

export function buildYcOwnerInventory({ batchSlug, catalog, overrides = {} }) {
  const companies = Array.isArray(catalog) ? catalog : catalog?.companies;
  if (!Array.isArray(companies)) {
    throw new Error(`${batchSlug} YC catalog does not contain a companies array.`);
  }

  const entities = [];
  const mappings = [];
  for (const company of companies) {
    if (!company?.slug || !company?.name) continue;
    const companyOverride = overrides[company.slug] ?? {};
    const companyEntityId = `company-${company.slug}`;
    const companyOwner = ownerRecord({
      batchSlug,
      entityType: "company",
      entityId: companyEntityId,
      sourceId: String(company.id ?? company.slug),
      entityName: company.name,
      companyEntityId,
      companySlug: company.slug
    });
    const companyLinks = mergeOwnerLinks(
      company.socialLinks,
      companyOverride.companySocialLinks ?? companyOverride.company,
      retiredOwnerAccounts(companyOverride)
    );
    companyOwner.accounts = accountMappings(companyOwner, companyLinks);
    entities.push(companyOwner);
    mappings.push(...companyOwner.accounts);

    const founders = mergeYcFounders(company.founders ?? [], companyOverride.founders ?? []);
    for (const founder of founders) {
      if (!founder?.name) continue;
      const sourceId = String(founder.id ?? slugify(founder.name));
      const founderEntityId = `founder-${company.slug}-${slugify(founder.name)}-${sourceId}`;
      const founderOwner = ownerRecord({
        batchSlug,
        entityType: "founder",
        entityId: founderEntityId,
        sourceId,
        entityName: founder.name,
        companyEntityId,
        companySlug: company.slug
      });
      founderOwner.accounts = accountMappings(founderOwner, founder.socialLinks ?? {});
      entities.push(founderOwner);
      mappings.push(...founderOwner.accounts);
    }
  }

  return finalizeInventory(batchSlug, entities, mappings);
}

export function buildA16zOwnerInventory({
  batchSlug,
  socialCatalog,
  profileSource,
  overrides = {}
}) {
  const companies = socialCatalog?.companies;
  if (!Array.isArray(companies)) {
    throw new Error("A16Z social account catalog does not contain a companies array.");
  }
  const observedFounderCount = companies.reduce(
    (count, company) => count + (company.founders?.length ?? 0),
    0
  );
  if (companies.length !== 59 || observedFounderCount !== 128) {
    throw new Error(
      `A16Z social account census is ${companies.length} companies/${observedFounderCount} founders; expected 59/128.`
    );
  }
  validateA16zProfileCensus(profileSource, companies);

  const graph = {
    nodes: companies.map((company) => {
      const companySlug = company.companySlug ?? slugify(company.companyName);
      const entityId = `a16z-speedrun-006-${companySlug}`;
      return {
        entityType: "company",
        entityId,
        label: company.companyName,
        socialAccounts: company.accounts ?? [],
        founders: (company.founders ?? []).map((founder) => ({
          id: `${entityId}-founder-${founder.founderSlug ?? slugify(founder.name)}`,
          name: founder.name,
          socialAccounts: founder.accounts ?? []
        }))
      };
    })
  };
  return buildGraphOwnerInventory({ batchSlug, graph, overrides });
}

export function buildGraphOwnerInventory({ batchSlug, graph, overrides = {} }) {
  if (!Array.isArray(graph?.nodes)) {
    throw new Error(`${batchSlug} graph does not contain a nodes array.`);
  }

  const entities = [];
  const mappings = [];
  for (const node of graph.nodes) {
    if (node?.entityType !== "company" || !node.entityId) continue;
    const companySlug = companySlugFromNode(batchSlug, node);
    const companyOverride = overrides[companySlug] ?? {};
    const companyOwner = ownerRecord({
      batchSlug,
      entityType: "company",
      entityId: node.entityId,
      sourceId: node.entityId,
      entityName: node.label ?? node.entityId,
      companyEntityId: node.entityId,
      companySlug
    });
    companyOwner.accounts = accountMappings(
      companyOwner,
      mergeOwnerLinks(
        node.socialAccounts ?? [],
        companyOverride.companySocialLinks ?? companyOverride.company,
        retiredOwnerAccounts(companyOverride)
      )
    );
    entities.push(companyOwner);
    mappings.push(...companyOwner.accounts);

    const founders = mergeGraphFounders({
      batchSlug,
      companySlug,
      companyEntityId: node.entityId,
      founders: node.founders ?? [],
      founderOverrides: companyOverride.founders ?? []
    });
    for (const founder of founders) {
      if (!founder?.id) continue;
      const founderOwner = ownerRecord({
        batchSlug,
        entityType: "founder",
        entityId: founder.id,
        sourceId: founder.id,
        entityName: founder.name ?? founder.id,
        companyEntityId: node.entityId,
        companySlug
      });
      founderOwner.accounts = accountMappings(founderOwner, founder.socialAccounts ?? []);
      entities.push(founderOwner);
      mappings.push(...founderOwner.accounts);
    }
  }

  return finalizeInventory(batchSlug, entities, mappings);
}

export function auditCoverageInputs(cohorts, options = {}) {
  const runOutputsProvided = options.runOutputsProvided ?? cohorts.some((cohort) => cohort.runOutputs !== null);
  const planProvided = cohorts.every((cohort) => Array.isArray(cohort.planTasks));
  const batches = cohorts
    .map((cohort) => auditCohort(cohort, { runOutputsProvided }))
    .sort((left, right) => left.batchSlug.localeCompare(right.batchSlug));
  const structuralFailureCount = batches.reduce(
    (count, batch) => count + batch.structural.failureCount,
    0
  );
  const structuralFailureKinds = uniqueSorted(
    batches.flatMap((batch) => batch.structural.failureKinds)
  );

  return {
    schemaVersion: COVERAGE_AUDIT_SCHEMA_VERSION,
    status: structuralFailureCount === 0 ? "pass" : "fail",
    planProvided,
    runOutputsProvided,
    structuralFailureCount,
    structuralFailureKinds,
    batches
  };
}

export async function runCohortCoverageAudit({ rootDir, runDir = null } = {}) {
  if (!rootDir) throw new Error("rootDir is required.");
  const cohorts = await loadAuthoritativeCoverageInputs(rootDir, { runDir });
  return auditCoverageInputs(cohorts, { runOutputsProvided: Boolean(runDir) });
}

export function reportHasStructuralFailures(report) {
  return Number(report?.structuralFailureCount ?? 0) > 0;
}

export function canonicalAccountUrl(rawPlatform, rawUrl) {
  const platform = normalizePlatform(rawPlatform);
  if (!platform || typeof rawUrl !== "string" || !rawUrl.trim()) return null;
  try {
    const url = new URL(rawUrl.trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (platform === "github" && host === "github.com") {
      const canonicalUrl = canonicalGithubTargetUrl(rawUrl);
      return canonicalUrl ? canonicalUrl.toLowerCase() : null;
    }
    if (platform === "x" && ["x.com", "twitter.com"].includes(host)) {
      return parts[0] ? `https://x.com/${parts[0].toLowerCase()}` : null;
    }
    if (platform === "linkedin" && host.endsWith("linkedin.com")) {
      const namespaceIndex = parts.findIndex((part) => ["company", "in", "school", "showcase"].includes(part.toLowerCase()));
      const namespace = namespaceIndex >= 0 ? parts[namespaceIndex]?.toLowerCase() : null;
      const identity = namespaceIndex >= 0 ? parts[namespaceIndex + 1] : null;
      return namespace && identity
        ? `https://linkedin.com/${namespace}/${identity.toLowerCase()}`
        : null;
    }
    if (platform === "instagram" && host === "instagram.com") {
      return parts[0] ? `https://instagram.com/${parts[0].toLowerCase()}` : null;
    }
    if (platform === "youtube" && ["youtube.com", "m.youtube.com"].includes(host)) {
      if (!parts[0]) return null;
      if (parts[0].startsWith("@")) return `https://youtube.com/@${parts[0].slice(1).toLowerCase()}`;
      if (["channel", "c", "user"].includes(parts[0].toLowerCase()) && parts[1]) {
        return `https://youtube.com/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
      }
      return `https://youtube.com/${parts[0].toLowerCase()}`;
    }
    if (platform === "product_hunt" && host === "producthunt.com") {
      return parts[0] && parts[1]
        ? `https://producthunt.com/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`
        : parts[0]
          ? `https://producthunt.com/${parts[0].toLowerCase()}`
          : null;
    }

    url.hash = "";
    url.search = "";
    url.hostname = host;
    url.pathname = `/${parts.join("/")}`.replace(/\/$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function ownerMappingKey(mapping) {
  return [
    mapping.batchSlug,
    mapping.entityType,
    mapping.entityId,
    mapping.platform,
    mapping.canonicalUrl
  ].join("|");
}

function auditCohort(cohort, { runOutputsProvided }) {
  const expectedByKey = new Map(cohort.catalog.mappings.map((mapping) => [mapping.key, mapping]));
  const graphByKey = new Map(cohort.graphInventory.mappings.map((mapping) => [mapping.key, mapping]));
  const missingGraphOwnerMappings = sortedMappings(
    [...expectedByKey].filter(([key]) => !graphByKey.has(key)).map(([, mapping]) => mapping)
  );
  const unexpectedGraphOwnerMappings = sortedMappings(
    [...graphByKey].filter(([key]) => !expectedByKey.has(key)).map(([, mapping]) => mapping)
  );
  const duplicateCatalogMappingKeys = duplicateKeys(cohort.catalog.mappings.map((mapping) => mapping.key));
  const duplicateGraphMappingKeys = duplicateKeys(cohort.graphInventory.mappings.map((mapping) => mapping.key));
  const planCoverage = auditPlanCoverage(cohort.catalog, cohort.planTasks);
  const graphEntityIds = new Set(cohort.catalog.entities.map((entity) => entity.entityId));
  const unresolvedGraphReferences = referenceFindings({
    batchSlug: cohort.batchSlug,
    entityIds: graphEntityIds,
    evidence: cohort.graph.evidence ?? [],
    needsReview: cohort.graph.needsReview ?? [],
    source: "graph"
  });

  const missingRunOutputs = [];
  let unresolvedRunReferences = [];
  let unattemptedOwnerMappings = [];
  if (runOutputsProvided) {
    if (!cohort.runOutputs?.public) missingRunOutputs.push("public");
    if (!cohort.runOutputs?.github) missingRunOutputs.push("github");
    if (cohort.runOutputs?.public) {
      unresolvedRunReferences = referenceFindings({
        batchSlug: cohort.batchSlug,
        entityIds: graphEntityIds,
        evidence: cohort.runOutputs.public.evidence ?? [],
        needsReview: cohort.runOutputs.public.needsReview ?? [],
        source: "run"
      });
    }
    if (cohort.runOutputs?.public || cohort.runOutputs?.github) {
      unattemptedOwnerMappings = sortedMappings(
        cohort.catalog.mappings.filter((mapping) => !mappingWasAttempted(mapping, cohort.runOutputs))
      );
    }
  }

  const structuralArrays = {
    duplicateCatalogMappingKeys,
    duplicateGraphMappingKeys,
    duplicatePlanMappingKeys: planCoverage.duplicatePlanMappingKeys,
    missingRunOutputs: [...missingRunOutputs].sort(),
    unplannedOwnerMappings: planCoverage.unplannedOwnerMappings,
    unexpectedPlannedMappings: planCoverage.unexpectedPlannedMappings,
    unresolvedGraphReferences,
    unresolvedRunReferences,
    unattemptedOwnerMappings
  };
  const failureKinds = Object.entries(structuralArrays)
    .filter(([, rows]) => rows.length > 0)
    .map(([kind]) => kind)
    .sort();
  const failureCount = Object.values(structuralArrays).reduce((count, rows) => count + rows.length, 0);

  return {
    batchSlug: cohort.batchSlug,
    inputs: {
      catalog: cohort.catalogPath,
      profileSource: cohort.profilePath ?? null,
      graph: cohort.graphPath,
      publicRun: cohort.runOutputs?.publicPath ?? null,
      githubRun: cohort.runOutputs?.githubPath ?? null
    },
    counts: {
      companies: cohort.catalog.entities.filter((entity) => entity.entityType === "company").length,
      founders: cohort.catalog.entities.filter((entity) => entity.entityType === "founder").length,
      catalogOwnerMappings: cohort.catalog.mappings.length,
      graphOwnerMappings: cohort.graphInventory.mappings.length,
      catalogOwnerPlatformGroups: ownerPlatformGroups(cohort.catalog.mappings).size,
      plannedOwnerMappings: planCoverage.plannedMappings.length,
      multiAccountOwnerMappings: planCoverage.multiAccountMappings.length,
      graphEvidence: cohort.graph.evidence?.length ?? 0,
      graphNeedsReview: cohort.graph.needsReview?.length ?? 0
    },
    structural: {
      status: failureCount === 0 ? "pass" : "fail",
      failureCount,
      failureKinds,
      ...structuralArrays
    },
    debt: computeCoverageDebt(cohort, {
      graphOwnerPresentationGaps: missingGraphOwnerMappings,
      unexpectedGraphOwnerMappings,
      multiAccountOwnerMappings: planCoverage.multiAccountMappings
    })
  };
}

function computeCoverageDebt(
  cohort,
  { graphOwnerPresentationGaps, unexpectedGraphOwnerMappings, multiAccountOwnerMappings }
) {
  const evidenceById = new Map((cohort.graph.evidence ?? []).map((item) => [item.id, item]));
  const reviewsByEntity = Map.groupBy(cohort.graph.needsReview ?? [], (item) => item.entityId);
  const zeroScoreCompanies = [];
  const zeroFamilyNativeEvidenceCompanies = [];
  const zeroOwnNativeEvidenceCompanies = [];
  const zeroOwnNativeEvidenceFounders = [];
  const reviewOnlyCompanies = [];
  const reviewOnlyFounders = [];

  for (const node of cohort.graph.nodes ?? []) {
    if (node?.entityType !== "company") continue;
    const companyEvidence = (node.evidenceIds ?? []).map((id) => evidenceById.get(id)).filter(Boolean);
    const companyOwnNative = companyEvidence.filter(
      (item) => item.entityId === node.entityId && isScoredNativeEvidence(item)
    );
    if (Number(node.score ?? 0) <= 0) zeroScoreCompanies.push(entityDebt(node.entityId, node.label));
    if (!companyEvidence.some(isScoredNativeEvidence)) {
      zeroFamilyNativeEvidenceCompanies.push(entityDebt(node.entityId, node.label));
    }
    if (companyOwnNative.length === 0) {
      zeroOwnNativeEvidenceCompanies.push(entityDebt(node.entityId, node.label));
      if (reviewsByEntity.has(node.entityId)) reviewOnlyCompanies.push(entityDebt(node.entityId, node.label));
    }
    for (const founder of node.founders ?? []) {
      const founderOwnNative = (founder.evidenceIds ?? [])
        .map((id) => evidenceById.get(id))
        .filter((item) => item?.entityId === founder.id && isScoredNativeEvidence(item));
      if (founderOwnNative.length === 0) {
        zeroOwnNativeEvidenceFounders.push(entityDebt(founder.id, founder.name, node.label));
        if (reviewsByEntity.has(founder.id)) {
          reviewOnlyFounders.push(entityDebt(founder.id, founder.name, node.label));
        }
      }
    }
  }

  const mappingCoverage = {};
  for (const platform of AUDITED_MAPPING_PLATFORMS) {
    const platformMappings = cohort.catalog.mappings.filter((mapping) => mapping.platform === platform);
    const mappedOwnerIds = new Set(platformMappings.map((mapping) => mapping.entityId));
    const companies = cohort.catalog.entities.filter((entity) => entity.entityType === "company");
    const founders = cohort.catalog.entities.filter((entity) => entity.entityType === "founder");
    mappingCoverage[platform] = {
      companyMapped: companies.filter((entity) => mappedOwnerIds.has(entity.entityId)).length,
      companyMissing: companies.filter((entity) => !mappedOwnerIds.has(entity.entityId)).length,
      founderMapped: founders.filter((entity) => mappedOwnerIds.has(entity.entityId)).length,
      founderMissing: founders.filter((entity) => !mappedOwnerIds.has(entity.entityId)).length
    };
  }
  const mappedOwnerIds = new Set(cohort.catalog.mappings.map((mapping) => mapping.entityId));
  const noMappedAccounts = cohort.catalog.entities
    .filter((entity) => !mappedOwnerIds.has(entity.entityId))
    .map((entity) => entityDebt(entity.entityId, entity.entityName))
    .sort(entityDebtSort);

  return {
    note: "Debt is reported but never changes audit status; an attempted account may legitimately have no active post or score.",
    graphOwnerPresentationGaps,
    unexpectedGraphOwnerMappings,
    multiAccountOwnerMappings,
    mappingCoverage,
    noMappedAccounts,
    zeroScoreCompanies: zeroScoreCompanies.sort(entityDebtSort),
    zeroFamilyNativeEvidenceCompanies: zeroFamilyNativeEvidenceCompanies.sort(entityDebtSort),
    zeroOwnNativeEvidenceCompanies: zeroOwnNativeEvidenceCompanies.sort(entityDebtSort),
    zeroOwnNativeEvidenceFounders: zeroOwnNativeEvidenceFounders.sort(entityDebtSort),
    reviewOnlyCompanies: reviewOnlyCompanies.sort(entityDebtSort),
    reviewOnlyFounders: reviewOnlyFounders.sort(entityDebtSort)
  };
}

function auditPlanCoverage(catalog, planTasks) {
  if (!Array.isArray(planTasks)) {
    return {
      duplicatePlanMappingKeys: [],
      plannedMappings: [],
      multiAccountMappings: [],
      unexpectedPlannedMappings: [],
      unplannedOwnerMappings: []
    };
  }

  const expectedGroups = ownerPlatformGroups(catalog.mappings);
  const entityByKey = new Map(
    catalog.entities.map((entity) => [`${entity.entityType}|${entity.entityId}`, entity])
  );
  const plannedMappings = planTasks
    .filter((task) => task?.account?.url && task?.entityType && task?.entitySourceKey && task?.platform)
    .flatMap((task) => {
      const platform = platformForUrl(task.platform, task.account.url);
      const canonicalUrl = canonicalAccountUrl(platform, task.account.url);
      if (!platform || !canonicalUrl) return [];
      const entityId = String(task.entitySourceKey);
      const entity = entityByKey.get(`${task.entityType}|${entityId}`);
      const mapping = {
        batchSlug: task.batchSlug,
        entityType: task.entityType,
        entityId,
        entityName: task.entityName ?? entity?.entityName ?? entityId,
        sourceId: entity?.sourceId ?? entityId,
        companyEntityId: entity?.companyEntityId ?? task.companySourceKey ?? null,
        companySlug: entity?.companySlug ?? null,
        platform,
        canonicalUrl,
        originalUrl: task.account.url,
        ownerReferenceCandidates: entity?.ownerReferenceCandidates ?? ownerReferenceCandidates(
          entityId,
          task.entityType,
          entity?.sourceId
        )
      };
      mapping.key = ownerMappingKey(mapping);
      return [mapping];
    });
  const expectedKeys = new Set(catalog.mappings.map((mapping) => mapping.key));
  const plannedKeys = new Set(plannedMappings.map((mapping) => mapping.key));
  const multiAccountMappings = [...expectedGroups.values()].flatMap((mappings) =>
    mappings.length > 1 ? mappings.slice(1) : []
  );

  return {
    duplicatePlanMappingKeys: duplicateKeys(plannedMappings.map((mapping) => mapping.key)),
    plannedMappings: sortedMappings(
      plannedMappings.filter((mapping) => expectedKeys.has(mapping.key))
    ),
    multiAccountMappings: sortedMappings(multiAccountMappings),
    unexpectedPlannedMappings: sortedMappings(
      plannedMappings.filter((mapping) => !expectedKeys.has(mapping.key))
    ),
    unplannedOwnerMappings: sortedMappings(
      catalog.mappings.filter((mapping) => !plannedKeys.has(mapping.key))
    )
  };
}

function ownerPlatformGroups(mappings) {
  return Map.groupBy(
    mappings,
    (mapping) => [
      mapping.batchSlug,
      mapping.entityType,
      mapping.entityId,
      mapping.platform
    ].join("|")
  );
}

function mappingWasAttempted(mapping, runOutputs) {
  if (mapping.platform === "github") {
    return (runOutputs?.github?.accounts ?? []).some((account) => {
      const accountOwnerCandidates = ownerReferenceCandidates(account.entityId, account.entityType);
      const expectedOwnerCandidates = new Set(mapping.ownerReferenceCandidates);
      const ownerMatches = account.entityType === mapping.entityType &&
        accountOwnerCandidates.some((candidate) => expectedOwnerCandidates.has(candidate));
      const canonicalCandidates = [
        canonicalAccountUrl("github", account.githubUrl),
        account.login ? canonicalAccountUrl("github", `https://github.com/${account.login}`) : null
      ].filter(Boolean);
      return ownerMatches && canonicalCandidates.includes(mapping.canonicalUrl);
    });
  }

  const attempts = Object.entries(runOutputs?.public?.attempts ?? {});
  return attempts.some(([key, attempt]) =>
    attemptMetadataMatchesMapping(attempt, mapping) ||
    attemptKeyMatchesMapping(key, mapping)
  );
}

function attemptMetadataMatchesMapping(attempt, mapping) {
  if (!attempt || typeof attempt !== "object") return false;
  const platform = normalizePlatform(attempt.platform);
  const canonicalUrl = canonicalAccountUrl(platform, attempt.accountUrl);
  if (!platform || !canonicalUrl) return false;
  const ownerCandidates = ownerReferenceCandidates(attempt.entityId, attempt.entityType);
  const expectedOwnerCandidates = new Set(mapping.ownerReferenceCandidates);
  return (!attempt.batchSlug || attempt.batchSlug === mapping.batchSlug) &&
    platform === mapping.platform &&
    attempt.entityType === mapping.entityType &&
    ownerCandidates.some((candidate) => expectedOwnerCandidates.has(candidate)) &&
    canonicalUrl === mapping.canonicalUrl;
}

function attemptKeyMatchesMapping(key, mapping) {
  const urlIndex = key.indexOf("http");
  if (urlIndex < 0) return false;
  const prefixParts = key.slice(0, urlIndex).replace(/:$/, "").split(":");
  let entityToken = null;
  if (prefixParts[0] === mapping.platform && prefixParts[1] === mapping.entityType) {
    entityToken = prefixParts.slice(2).join(":");
  } else if (prefixParts[0] === mapping.batchSlug && prefixParts[1] === mapping.platform) {
    entityToken = prefixParts[2] === mapping.entityType
      ? prefixParts.slice(3).join(":")
      : prefixParts.slice(2).join(":");
  } else {
    return false;
  }
  if (!mapping.ownerReferenceCandidates.includes(entityToken)) return false;
  return canonicalAccountUrl(mapping.platform, key.slice(urlIndex)) === mapping.canonicalUrl;
}

function referenceFindings({ batchSlug, entityIds, evidence, needsReview, source }) {
  const findings = [];
  for (const [collection, rows] of [["evidence", evidence], ["needsReview", needsReview]]) {
    for (const row of rows) {
      if (!row?.entityId || !entityIds.has(row.entityId)) {
        findings.push({
          batchSlug,
          source,
          collection,
          rowId: row?.id ?? null,
          entityId: row?.entityId ?? null,
          entityType: row?.entityType ?? null,
          companySlug: row?.companySlug ?? null
        });
      }
      if (row?.attachedCompanyId && !entityIds.has(row.attachedCompanyId)) {
        findings.push({
          batchSlug,
          source,
          collection,
          rowId: row?.id ?? null,
          entityId: row.attachedCompanyId,
          entityType: "attachedCompany",
          companySlug: row?.companySlug ?? null
        });
      }
    }
  }
  return findings.sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

function isScoredNativeEvidence(item) {
  if (Number(item?.contributionScore ?? 0) <= 0) return false;
  if (item?.platformPostId) return true;
  const url = String(item?.sourceUrl ?? "");
  switch (item?.platform) {
    case "github":
      return /^https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+/i.test(url);
    case "x":
      return /\/(?:status|statuses)\/\d+/i.test(url);
    case "linkedin":
      return /\/posts\/|\/feed\/update\/urn:li:activity:/i.test(url);
    case "instagram":
      return /\/(?:p|reel|tv)\//i.test(url);
    case "youtube":
      return /youtu\.be\/|youtube\.com\/(?:watch|shorts|live)\b/i.test(url);
    case "product_hunt":
      return /producthunt\.com\/posts\//i.test(url);
    case "hacker_news":
      return /(?:news\.)?ycombinator\.com\/item\?id=\d+/i.test(url);
    case "reddit":
      return /reddit\.com\/r\/[^/]+\/comments\//i.test(url);
    default:
      return false;
  }
}

function accountMappings(owner, linksOrAccounts) {
  const rows = Array.isArray(linksOrAccounts)
    ? linksOrAccounts.map((account) => [account.platform, account.url, account])
    : Object.entries(linksOrAccounts ?? {}).map(([platform, url]) => [platform, url, null]);
  const mappings = [];
  const seen = new Set();
  for (const [rawPlatform, rawUrl, sourceAccount] of rows) {
    const platform = platformForUrl(rawPlatform, rawUrl);
    const canonicalUrl = canonicalAccountUrl(platform, rawUrl);
    if (!platform || !canonicalUrl || sourceAccount?.review_state === "rejected") continue;
    const mapping = {
      batchSlug: owner.batchSlug,
      entityType: owner.entityType,
      entityId: owner.entityId,
      entityName: owner.entityName,
      sourceId: owner.sourceId,
      companyEntityId: owner.companyEntityId,
      companySlug: owner.companySlug,
      platform,
      canonicalUrl,
      originalUrl: rawUrl,
      ownerReferenceCandidates: owner.ownerReferenceCandidates
    };
    mapping.key = ownerMappingKey(mapping);
    if (seen.has(mapping.key)) continue;
    seen.add(mapping.key);
    mappings.push(mapping);
  }
  return sortedMappings(mappings);
}

function mergeYcFounders(rawFounders, founderOverrides) {
  const founders = rawFounders.map((founder) => ({
    ...founder,
    socialLinks: { ...(founder.socialLinks ?? {}) }
  }));
  for (const override of founderOverrides) {
    const exactId = founders.find(
      (founder) =>
        String(founder.id) === String(override.id) ||
        String(founder.id).endsWith(`-${override.id}`)
    );
    const nameMatch = founders.find(
      (founder) => slugify(founder.name) === slugify(override.name)
    );
    const target = exactId ?? nameMatch;
    if (target) {
      target.socialLinks = mergeOwnerLinks(
        target.socialLinks,
        override.socialLinks,
        retiredOwnerAccounts(override)
      );
      continue;
    }
    founders.push({
      id: override.id ?? slugify(override.name),
      name: override.name,
      socialLinks: mergeOwnerLinks({}, override.socialLinks, retiredOwnerAccounts(override))
    });
  }
  return founders;
}

function mergeGraphFounders({
  batchSlug,
  companySlug,
  founders,
  founderOverrides
}) {
  const merged = founders.map((founder) => ({
    ...founder,
    socialAccounts: [...(founder.socialAccounts ?? [])]
  }));
  const unmatchedOverrides = [...founderOverrides];
  for (const founder of merged) {
    const overrideIndex = unmatchedOverrides.findIndex(
      (candidate) =>
        String(founder.id).endsWith(`-${candidate.id}`) ||
        slugify(founder.name) === slugify(candidate.name)
    );
    if (overrideIndex < 0) continue;
    const [override] = unmatchedOverrides.splice(overrideIndex, 1);
    founder.socialAccounts = mergeOwnerLinks(
      founder.socialAccounts,
      override.socialLinks,
      retiredOwnerAccounts(override)
    );
  }
  for (const override of unmatchedOverrides) {
    if (!override?.id || !override?.name) continue;
    const id = batchSlug === "A16ZSR006" && /^a16z-speedrun-006-.+-founder-/i.test(override.id)
      ? override.id
      : `founder-${companySlug}-${slugify(override.name)}-${override.id}`;
    merged.push({
      id,
      name: override.name,
      socialAccounts: mergeOwnerLinks({}, override.socialLinks, retiredOwnerAccounts(override))
    });
  }
  return merged;
}

function mergeOwnerLinks(baseLinks = {}, overrideLinks = {}, retiredAccounts = []) {
  const retiredKeys = new Set(
    retiredAccounts
      .map(({ platform, url }) => ownerAccountCanonicalKey(platform, url))
      .filter(Boolean)
  );
  const baseRows = Array.isArray(baseLinks)
    ? baseLinks
    : Object.entries(baseLinks ?? {}).map(([platform, url]) => ({ platform, url }));
  const byIdentity = new Map();
  for (const account of baseRows) {
    const platform = platformForUrl(account?.platform, account?.url);
    const canonicalUrl = canonicalAccountUrl(platform, account?.url);
    const key = ownerAccountCanonicalKey(platform, account?.url);
    if (!platform || !canonicalUrl || !key || retiredKeys.has(key)) continue;
    byIdentity.set(key, { ...account, platform, url: account.url, overridePriority: 0 });
  }
  for (const [rawPlatform, url] of Object.entries(overrideLinks ?? {})) {
    if (typeof url !== "string" || !url.trim()) continue;
    const platform = platformForUrl(rawPlatform, url);
    const canonicalUrl = canonicalAccountUrl(platform, url);
    const key = ownerAccountCanonicalKey(platform, url);
    if (!platform || !canonicalUrl || !key || retiredKeys.has(key)) continue;
    byIdentity.set(key, {
      platform,
      url,
      review_state: "verified",
      overridePriority: 1
    });
  }
  return [...byIdentity.values()].sort(
    (left, right) =>
      Number(right.overridePriority ?? 0) - Number(left.overridePriority ?? 0) ||
      left.platform.localeCompare(right.platform) ||
      canonicalAccountUrl(left.platform, left.url).localeCompare(
        canonicalAccountUrl(right.platform, right.url)
      )
  );
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
  const normalizedPlatform = platformForUrl(platform, rawUrl);
  const canonicalUrl = canonicalAccountUrl(normalizedPlatform, rawUrl);
  return normalizedPlatform && canonicalUrl
    ? `${normalizedPlatform}:${canonicalUrl.toLowerCase()}`
    : null;
}

function ownerRecord(input) {
  const candidates = ownerReferenceCandidates(input.entityId, input.entityType, input.sourceId);
  return {
    ...input,
    ownerReferenceCandidates: candidates,
    accounts: []
  };
}

function ownerReferenceCandidates(entityId, entityType, sourceId = null) {
  const candidates = [entityId, sourceId].filter(Boolean).map(String);
  if (entityType === "company") {
    candidates.push(String(entityId ?? "").replace(/^company-/, ""));
  } else {
    const trailingId = String(entityId ?? "").match(/-([A-Za-z0-9][A-Za-z0-9_-]*)$/)?.[1];
    if (trailingId) candidates.push(trailingId);
  }
  return uniqueSorted(candidates.filter(Boolean));
}

function finalizeInventory(batchSlug, entities, mappings) {
  const sortedEntities = [...entities].sort((left, right) =>
    `${left.entityType}|${left.entityId}`.localeCompare(`${right.entityType}|${right.entityId}`)
  );
  const sorted = sortedMappings(mappings);
  return {
    batchSlug,
    entities: sortedEntities,
    mappings: sorted
  };
}

async function loadBatchRunOutputs(runDir, suffix) {
  const checkpointPath = join(runDir, `checkpoint-public-${suffix}.json`);
  const publicPath = join(runDir, `public-${suffix}.json`);
  const githubPath = join(runDir, `github-${suffix}.json`);
  const [checkpoint, publicSnapshot, github] = await Promise.all([
    readOptionalJson(checkpointPath, null),
    readOptionalJson(publicPath, null),
    readOptionalJson(githubPath, null)
  ]);
  const publicOutput = checkpoint || publicSnapshot
    ? {
        ...(publicSnapshot ?? {}),
        attempts: checkpoint?.attempts ?? publicSnapshot?.attempts ?? {},
        evidence: publicSnapshot?.evidence ?? checkpoint?.evidence ?? [],
        needsReview: publicSnapshot?.needsReview ?? checkpoint?.needsReview ?? []
      }
    : null;
  return {
    public: publicOutput,
    github,
    publicPath: publicOutput ? (checkpoint ? checkpointPath : publicPath) : null,
    githubPath: github ? githubPath : null
  };
}

function validateA16zProfileCensus(profileSource, socialCompanies) {
  if (typeof profileSource !== "string") {
    throw new Error("A16Z profile source is required for independent census validation.");
  }
  const marker = "const speedrun006Profiles: SpeedrunCompanyProfile[] = [";
  const start = profileSource.indexOf(marker);
  const end = start >= 0 ? profileSource.indexOf("\n];", start + marker.length) : -1;
  if (start < 0 || end < 0) {
    throw new Error("Could not locate speedrun006Profiles in the A16Z dataset source.");
  }
  const profileArray = profileSource.slice(start + marker.length, end);
  const companyMatches = [...profileArray.matchAll(/^  \{\n    name:\s*("(?:\\.|[^"\\])*")/gm)];
  const profilePairs = [];
  for (let index = 0; index < companyMatches.length; index += 1) {
    const companyName = JSON.parse(companyMatches[index][1]);
    const segmentEnd = companyMatches[index + 1]?.index ?? profileArray.length;
    const segment = profileArray.slice(companyMatches[index].index, segmentEnd);
    const foundersLiteral = segment.match(/^    founders:\s*\[([\s\S]*?)\](?:,?\s*)$/m)?.[1] ?? "";
    const founders = [...foundersLiteral.matchAll(/"((?:\\.|[^"\\])*)"/g)]
      .map((match) => JSON.parse(`"${match[1]}"`));
    for (const founderName of founders) profilePairs.push(`${companyName}|${founderName}`);
  }
  const socialPairs = socialCompanies.flatMap((company) =>
    (company.founders ?? []).map((founder) => `${company.companyName}|${founder.name}`)
  );
  const profileCompanies = companyMatches.map((match) => JSON.parse(match[1])).sort();
  const socialCompanyNames = socialCompanies.map((company) => company.companyName).sort();
  if (
    profileCompanies.length !== 59 ||
    profilePairs.length !== 128 ||
    profileCompanies.join("\n") !== socialCompanyNames.join("\n") ||
    profilePairs.sort().join("\n") !== socialPairs.sort().join("\n")
  ) {
    throw new Error(
      `A16Z independent profile/social census mismatch: profiles=${profileCompanies.length}/` +
      `${profilePairs.length}, social=${socialCompanyNames.length}/${socialPairs.length}; expected 59/128.`
    );
  }
}

function companySlugFromNode(batchSlug, node) {
  if (batchSlug === "A16ZSR006") {
    return String(node.entityId).replace(/^a16z-speedrun-006-/, "");
  }
  return String(node.entityId).replace(/^company-/, "");
}

function normalizePlatform(platform) {
  if (!platform) return null;
  const normalized = String(platform).trim().toLowerCase();
  return PLATFORM_ALIASES[normalized] ?? normalized;
}

function platformForUrl(declaredPlatform, rawUrl) {
  const declared = normalizePlatform(declaredPlatform);
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
    if (host === "github.com") return "github";
    if (host === "x.com" || host === "twitter.com") return "x";
    if (host.endsWith("linkedin.com")) return "linkedin";
    if (host === "instagram.com") return "instagram";
    if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be") return "youtube";
    if (host === "producthunt.com") return "product_hunt";
  } catch {
    // Preserve the declared platform for malformed values; canonicalization will reject them.
  }
  return declared;
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function entityDebt(entityId, name, companyName = null) {
  return { entityId, name: name ?? entityId, companyName };
}

function entityDebtSort(left, right) {
  return `${left.companyName ?? ""}|${left.name}|${left.entityId}`.localeCompare(
    `${right.companyName ?? ""}|${right.name}|${right.entityId}`
  );
}

function sortedMappings(mappings) {
  return [...mappings]
    .map((mapping) => ({ ...mapping, ownerReferenceCandidates: [...mapping.ownerReferenceCandidates].sort() }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function duplicateKeys(keys) {
  return [...Map.groupBy(keys, (key) => key)]
    .filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => ({ key, count: rows.length }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => String(left).localeCompare(String(right)));
}

function stableJson(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readOptionalJson(path, fallback) {
  try {
    await access(path);
    return await readJson(path);
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function displayPath(rootDir, path) {
  const shown = relative(rootDir, path);
  return shown.startsWith("..") ? path : shown;
}
