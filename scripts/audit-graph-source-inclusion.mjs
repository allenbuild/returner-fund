import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { buildGraphResponse } from "../src/lib/graph/graph-builder.ts";
import {
  canonicalPostKey,
  contextEvidenceContentUrl
} from "../src/lib/graph/dedupe.ts";
import { yc2026GraphDataset } from "../src/lib/graph/yc-spring-2026-dataset.ts";

const ROOT = process.cwd();
const SOURCE_NAMES = ["public", "logged-in", "targeted", "volume"];
const BATCHES = ["S2026", "S26", "A16ZSR006"];
const SOURCE_PRIORITY = new Map(SOURCE_NAMES.map((name, index) => [name, index]));

const sourceObservations = new Map();
let verifiedSourceRows = 0;
for (const sourceName of SOURCE_NAMES) {
  const projection = readJson(join(ROOT, "generated-runtime", "graph", `${sourceName}-evidence-current.json.gz`));
  for (const row of projection.evidence ?? []) {
    if (row.review_state !== "verified") continue;
    verifiedSourceRows += 1;
    const identity = sourcePhysicalIdentity(row);
    const observations = sourceObservations.get(identity) ?? [];
    observations.push({ sourceName, row });
    sourceObservations.set(identity, observations);
  }
}

const graphIdentities = new Set(yc2026GraphDataset.evidence.map(sourcePhysicalIdentity));
const catalogs = buildCatalogs(yc2026GraphDataset);
const entityCohortMemberships = buildEntityCohortMemberships(yc2026GraphDataset);
const categories = new Map();
const excludedRows = [];
let includedPhysicalIdentities = 0;
let exactCatalogPhysicalIdentities = 0;

for (const [identity, observations] of sourceObservations) {
  const decisions = observations
    .map((observation) => ({ ...observation, decision: classifyObservation(observation.row, catalogs) }))
    .sort((left, right) => {
      if (left.decision.exactCatalog !== right.decision.exactCatalog) {
        return left.decision.exactCatalog ? -1 : 1;
      }
      return (SOURCE_PRIORITY.get(left.sourceName) ?? 99) - (SOURCE_PRIORITY.get(right.sourceName) ?? 99);
    });
  const exact = decisions.find((entry) => entry.decision.exactCatalog);
  if (exact) exactCatalogPhysicalIdentities += 1;

  if (graphIdentities.has(identity)) {
    includedPhysicalIdentities += 1;
    increment(categories, exact ? "included_exact_catalog" : "included_legacy_or_compatibility");
    continue;
  }

  const selected = exact ?? decisions[0];
  const category = selected?.decision.reason ?? "unclassified_graph_exclusion";
  increment(categories, category);
  if (exact) {
    excludedRows.push({
      identity,
      category,
      inferredBatch: selected.decision.inferredBatch,
      observations: decisions.map(({ sourceName, row }) => ({
        source: sourceName,
        id: row.id,
        batchSlug: row.batchSlug ?? row.batch_slug ?? null,
        entityType: row.entityType,
        entityId: row.entityId,
        companySlug: row.companySlug ?? null,
        platform: row.platform,
        sourceUrl: row.sourceUrl,
        platformPostId: row.platformPostId ?? null
      }))
    });
  }
}

const perCohort = Object.fromEntries(BATCHES.map((batchSlug) => {
  const sourceReceipts = yc2026GraphDataset.evidence.filter((item) =>
    resolveEvidenceCohort(item, entityCohortMemberships) === batchSlug
  );
  const graph = buildGraphResponse({ batchSlug }, yc2026GraphDataset);
  return [batchSlug, {
    sourceReceiptRows: sourceReceipts.length,
    publishedUniqueContentRows: graph.evidence.length,
    publishedUniquePhysicalIdentities: new Set(graph.evidence.map(sourcePhysicalIdentity)).size
  }];
}));
const publishedUniqueContentRows = Object.values(perCohort)
  .reduce((total, cohort) => total + cohort.publishedUniqueContentRows, 0);
const publishedUniquePhysicalIdentities = Object.values(perCohort)
  .reduce((total, cohort) => total + cohort.publishedUniquePhysicalIdentities, 0);

const report = {
  schema: "returner_graph_source_inclusion_audit_v2",
  offlineOnly: true,
  source: {
    verifiedRows: verifiedSourceRows,
    physicalIdentities: sourceObservations.size,
    exactCatalogPhysicalIdentities
  },
  graph: {
    sourceReceiptRows: yc2026GraphDataset.evidence.length,
    sourceReceiptPhysicalIdentities: graphIdentities.size,
    publishedUniqueContentRows,
    publishedUniquePhysicalIdentities,
    sourcePhysicalIdentitiesIncluded: includedPhysicalIdentities,
    perCohort
  },
  categories: Object.fromEntries([...categories].sort(([left], [right]) => left.localeCompare(right))),
  excludedExactCatalog: {
    physicalIdentities: excludedRows.length,
    byCategory: countBy(excludedRows, (row) => row.category),
    rows: excludedRows.sort((left, right) => left.identity.localeCompare(right.identity))
  }
};

console.log(JSON.stringify(report, null, 2));

function classifyObservation(row, catalogByBatch) {
  const explicitBatch = String(row.batchSlug ?? row.batch_slug ?? "").trim().toUpperCase();
  let inferredBatch = explicitBatch || null;
  if (explicitBatch && !BATCHES.includes(explicitBatch)) {
    return decision(false, inferredBatch, "unsupported_batch_scope");
  }

  if (!inferredBatch) {
    const memberships = BATCHES.filter((batch) => rowMatchesCatalog(row, catalogByBatch.get(batch)));
    if (memberships.length === 0) return decision(false, null, "entity_roster_mismatch");
    if (memberships.length > 1) return decision(false, null, "ambiguous_unscoped_batch");
    inferredBatch = memberships[0];
    const evidenceText = `${row.title ?? ""} ${row.text ?? ""} ${row.rawVisibleText ?? ""} ${row.matchReason ?? ""}`;
    if (
      (inferredBatch === "S2026" && /\b(?:Summer\s+2026|YC\s*S26|YCS26|S26)\b/i.test(evidenceText)) ||
      (inferredBatch === "S26" && /\b(?:Spring\s+2026|YC\s*S2026|YCS2026|YC\s*P26|YCP26|P26)\b/i.test(evidenceText))
    ) {
      return decision(true, inferredBatch, "batch_scope_semantic_conflict");
    }
  }

  const catalog = catalogByBatch.get(inferredBatch);
  if (!rowMatchesCatalog(row, catalog)) {
    return decision(false, inferredBatch, "entity_roster_mismatch");
  }
  if (row.linkStatus === "invalid" || row.linkStatus === "blocked") {
    return decision(true, inferredBatch, "link_integrity_gate");
  }

  if (row.platform === "web" || row.platform === "rss") {
    const contextUrl = contextEvidenceContentUrl(row.platform, row.platformPostId)
      ?? contextEvidenceContentUrl(row.platform, row.sourceUrl);
    if (!contextUrl) return decision(true, inferredBatch, "context_physical_identity_gate");
    if (inferredBatch === "A16ZSR006" && !contextMatchesCatalogWebsite(contextUrl, row, catalog)) {
      return decision(true, inferredBatch, "first_party_context_domain_gate");
    }
  }
  if (row.platform === "linkedin") {
    return decision(true, inferredBatch, "linkedin_semantic_attribution_gate");
  }
  if (inferredBatch === "A16ZSR006" && row.platform === "reddit") {
    return decision(true, inferredBatch, "native_post_identity_gate");
  }
  if (
    inferredBatch === "A16ZSR006" &&
    ["instagram", "x", "youtube", "reddit", "tiktok", "bluesky"].includes(row.platform)
  ) {
    return decision(true, inferredBatch, "native_author_gate");
  }
  return decision(true, inferredBatch, "semantic_attribution_gate");
}

function buildCatalogs(dataset) {
  return new Map(BATCHES.map((batch) => {
    const companies = dataset.companies.filter((company) => company.batchSlug === batch);
    const founders = dataset.founders.filter((founder) => founder.batchSlug === batch);
    return [batch, {
      companyIds: new Set(companies.map((company) => company.id)),
      founderIds: new Set(founders.map((founder) => founder.id)),
      companiesBySlug: new Map(companies.map((company) => [company.slug, company]))
    }];
  }));
}

function buildEntityCohortMemberships(dataset) {
  const memberships = new Map();
  for (const entity of [...dataset.companies, ...dataset.founders]) {
    const cohorts = memberships.get(entity.id) ?? new Set();
    cohorts.add(entity.batchSlug);
    memberships.set(entity.id, cohorts);
  }
  return memberships;
}

function resolveEvidenceCohort(item, memberships) {
  const cohorts = memberships.get(item.entityId);
  if (!cohorts?.size) return null;
  if (typeof item.batchSlug === "string" && item.batchSlug.trim()) {
    return cohorts.has(item.batchSlug) ? item.batchSlug : null;
  }
  return cohorts.size === 1 ? [...cohorts][0] : null;
}

function rowMatchesCatalog(row, catalog) {
  if (!catalog) return false;
  if (row.entityType === "founder") return catalog.founderIds.has(row.entityId);
  if (catalog.companyIds.has(row.entityId)) return true;
  return Boolean(row.companySlug && catalog.companiesBySlug.has(row.companySlug));
}

function contextMatchesCatalogWebsite(contextUrl, row, catalog) {
  const company = catalog.companiesBySlug.get(row.companySlug);
  if (!company?.websiteUrl) return false;
  try {
    const contextHost = new URL(contextUrl).hostname.replace(/^www\./i, "").toLowerCase();
    const websiteHost = new URL(company.websiteUrl).hostname.replace(/^www\./i, "").toLowerCase();
    return contextHost === websiteHost || contextHost.endsWith(`.${websiteHost}`);
  } catch {
    return false;
  }
}

function sourcePhysicalIdentity(row) {
  return canonicalPostKey({ ...row, platformObjectId: null });
}

function decision(exactCatalog, inferredBatch, reason) {
  return { exactCatalog, inferredBatch, reason };
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function countBy(rows, keyFor) {
  const counts = new Map();
  for (const row of rows) increment(counts, keyFor(row));
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function readJson(path) {
  const bytes = readFileSync(path);
  const json = path.endsWith(".gz") ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
  return JSON.parse(json);
}
