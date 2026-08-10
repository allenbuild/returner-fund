#!/usr/bin/env node

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COVERAGE_SCHEMA = "company-timeline-coverage.v1";
const PUBLIC_INDEX_SCHEMA = "company-timeline-public-index.v1";
const TIMELINE_SCHEMA = "company-timeline.v1";
const DETAIL_SCHEMA = "company-timeline-event.v1";
const BASE_GRAPH_FILES = ["s2026.json", "s26.json", "a16zsr006.json"];
const SUPPLEMENTAL_TIMELINE_FILES = [
  "src/lib/social/public-evidence-current.json",
  "src/lib/social/logged-in-evidence-current.json",
  "src/lib/social/targeted-evidence-current.json",
  "src/lib/social/volume-evidence-current.json",
];
const CATEGORIES = new Set([
  "founded", "accelerator", "funding", "product_launch", "product_update",
  "traction_milestone", "revenue_milestone", "user_milestone", "customer",
  "partnership", "pricing", "business_model", "hiring", "leadership", "founder",
  "geographic_expansion", "open_source", "github", "research", "patent",
  "regulatory", "legal", "press", "award", "acquisition", "merger", "exit",
  "pivot", "shutdown", "website", "other",
]);
const DATE_TYPES = new Set(["occurrence_date", "announcement_date", "publication_date"]);
const COVERAGE_STATUSES = new Set(["complete", "partial", "failed"]);
const TERMINAL_SOURCE_STATES = new Set([
  "completed", "no_applicable_source", "no_results", "blocked", "rate_limited",
  "authentication_required", "failed",
]);
const EVIDENCE_ROLES = new Set(["primary", "supporting", "conflicting"]);
const TRACKING_PARAMETERS = new Set([
  "fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "igshid",
  "vero_id", "_hsenc", "_hsmi",
]);
const MAX_SOURCE_PREVIEW = 3;
const MAX_INITIAL_ARTIFACT_BYTES = 100_000;
const MAX_DETAIL_ARTIFACT_BYTES = 500_000;
const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });

export class TimelineArtifactValidationError extends Error {
  constructor(violations) {
    super(`Timeline artifact validation failed:\n- ${violations.join("\n- ")}`);
    this.name = "TimelineArtifactValidationError";
    this.violations = [...violations];
  }
}

export async function validateTimelineArtifacts({ rootDir = process.cwd(), now = new Date() } = {}) {
  const violations = [];
  const publicIndexPath = path.join(rootDir, "public", "timelines", "coverage.json");
  const publicIndexRead = await readJsonWithHash(publicIndexPath, violations, "public/timelines/coverage.json");
  const coveragePath = path.join(rootDir, "artifacts", "company-timeline", "coverage.json");
  const coverageRead = await readJsonWithHash(
    coveragePath,
    violations,
    "artifacts/company-timeline/coverage.json",
  );
  if (!publicIndexRead) throw new TimelineArtifactValidationError(violations);
  if (!coverageRead) throw new TimelineArtifactValidationError(violations);
  const publicIndex = publicIndexRead.value;
  const coverage = coverageRead.value;

  validatePublicIndex(publicIndex, coverage, violations);
  validateCoverageShape(coverage, violations);
  const inventory = await readCanonicalInventory(rootDir, violations);
  const manifestCompanies = Array.isArray(coverage?.companies) ? coverage.companies : [];
  const manifestByCompanyId = new Map();
  const artifactEvents = new Map();
  let publishedEvents = 0;
  let maxInitialArtifactBytes = 0;
  let maxDetailArtifactBytes = 0;
  let conflictCount = 0;

  for (const [index, entry] of manifestCompanies.entries()) {
    const scope = `coverage.companies[${index}]`;
    validateCoverageCompany(entry, scope, violations);
    const companyId = stringValue(entry?.company?.id);
    if (!companyId) continue;
    if (manifestByCompanyId.has(companyId)) {
      violations.push(`${scope}.company.id duplicates ${companyId}`);
      continue;
    }
    manifestByCompanyId.set(companyId, entry);

    const relativePath = safeArtifactPath(entry?.artifactPath, "companies");
    if (!relativePath) {
      violations.push(`${scope}.artifactPath must stay under public/timelines/companies`);
      continue;
    }
    const absolutePath = path.join(rootDir, relativePath);
    const artifactRead = await readJsonWithHash(absolutePath, violations, relativePath);
    if (!artifactRead) continue;
    if (entry.artifactSha256 !== artifactRead.sha256) {
      violations.push(`${scope}.artifactSha256 does not match ${relativePath}`);
    }
    maxInitialArtifactBytes = Math.max(maxInitialArtifactBytes, artifactRead.byteSize);
    if (artifactRead.byteSize > MAX_INITIAL_ARTIFACT_BYTES) {
      violations.push(`${relativePath} is ${artifactRead.byteSize} bytes; initial timeline artifacts must remain at or below ${MAX_INITIAL_ARTIFACT_BYTES}`);
    }

    const timelineResult = validateCompanyArtifact(artifactRead.value, entry, relativePath, now, violations);
    publishedEvents += timelineResult.events.length;
    conflictCount += timelineResult.events.filter((event) => event.hasConflict).length;
    for (const event of timelineResult.events) {
      if (artifactEvents.has(event.id)) {
        violations.push(`${relativePath}: event id ${event.id} is not globally unique`);
      } else {
        artifactEvents.set(event.id, { event, company: entry.company, artifactPath: relativePath });
      }
    }
  }

  validateInventoryCoverage(inventory, coverage, manifestByCompanyId, violations);
  await validateSourceArtifactHashes(rootDir, coverage, violations);

  const detailDirectory = path.join(rootDir, "public", "timelines", "events");
  const detailFiles = await jsonFiles(detailDirectory, violations);
  const seenDetailIds = new Set();
  for (const filename of detailFiles) {
    const relativePath = path.posix.join("public", "timelines", "events", filename);
    const detailRead = await readJsonWithHash(path.join(detailDirectory, filename), violations, relativePath);
    if (!detailRead) continue;
    maxDetailArtifactBytes = Math.max(maxDetailArtifactBytes, detailRead.byteSize);
    if (detailRead.byteSize > MAX_DETAIL_ARTIFACT_BYTES) {
      violations.push(`${relativePath} is ${detailRead.byteSize} bytes; detail artifacts must remain bounded at or below ${MAX_DETAIL_ARTIFACT_BYTES}`);
    }
    const eventId = validateDetailArtifact(detailRead.value, relativePath, artifactEvents, now, violations);
    if (eventId) {
      if (seenDetailIds.has(eventId)) violations.push(`${relativePath}: duplicate detail artifact for ${eventId}`);
      seenDetailIds.add(eventId);
    }
  }
  for (const eventId of artifactEvents.keys()) {
    if (!seenDetailIds.has(eventId)) violations.push(`Missing detail artifact for published event ${eventId}`);
  }

  const companyDirectory = path.join(rootDir, "public", "timelines", "companies");
  const companyFiles = await jsonFiles(companyDirectory, violations);
  const expectedCompanyFiles = new Set(manifestCompanies.map((entry) => path.basename(entry?.artifactPath ?? "")));
  for (const filename of companyFiles) {
    if (!expectedCompanyFiles.has(filename)) violations.push(`Unmanifested company timeline artifact ${filename}`);
  }

  const totals = coverage?.totals ?? {};
  compareTotal(totals.publishedEvents, publishedEvents, "publishedEvents", violations);
  compareTotal(totals.unresolvedConflicts, sum(manifestCompanies, "unresolvedConflictCount"), "unresolvedConflicts", violations);
  compareTotal(totals.unresolvedDates, sum(manifestCompanies, "unresolvedDateCount"), "unresolvedDates", violations);
  compareTotal(totals.candidates, sum(manifestCompanies, "candidateEventCount"), "candidates", violations);

  if (hasForbiddenPublicKey(publicIndex)) {
    violations.push("public/timelines/coverage.json exposes a forbidden confidence, prompt, raw-text, or processing field");
  }
  if (violations.length) throw new TimelineArtifactValidationError(violations);

  return {
    status: "ok",
    schemaVersion: COVERAGE_SCHEMA,
    inventoryRecords: inventory.inventoryRecords,
    uniqueCompanies: inventory.companies.size,
    terminalUniqueCompanies: manifestCompanies.length,
    publishedEvents,
    conflictCount,
    candidateCount: totals.candidates,
    unresolvedDateCount: totals.unresolvedDates,
    initialArtifactMaxBytes: maxInitialArtifactBytes,
    detailArtifactMaxBytes: maxDetailArtifactBytes,
  };
}

function validatePublicIndex(value, internalCoverage, violations) {
  if (!isRecord(value)) return violations.push("public/timelines/coverage.json must contain an object");
  const allowedKeys = ["companyCount", "generatedAt", "publishedEventCount", "schemaVersion"];
  const actualKeys = Object.keys(value).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(allowedKeys)) {
    violations.push("public/timelines/coverage.json may contain only aggregate public index fields");
  }
  if (value.schemaVersion !== PUBLIC_INDEX_SCHEMA) {
    violations.push(`public timeline index schemaVersion must be ${PUBLIC_INDEX_SCHEMA}`);
  }
  requireTimestamp(value.generatedAt, "public timeline index generatedAt", violations);
  requireNonnegativeInteger(value.companyCount, "public timeline index companyCount", violations);
  requireNonnegativeInteger(value.publishedEventCount, "public timeline index publishedEventCount", violations);
  if (isRecord(internalCoverage)) {
    if (value.generatedAt !== internalCoverage.generatedAt) {
      violations.push("public timeline index generatedAt must match the internal coverage manifest");
    }
    if (value.companyCount !== internalCoverage.totals?.uniqueCompanies) {
      violations.push("public timeline index companyCount must match the internal coverage manifest");
    }
    if (value.publishedEventCount !== internalCoverage.totals?.publishedEvents) {
      violations.push("public timeline index publishedEventCount must match the internal coverage manifest");
    }
  }
  const serialized = JSON.stringify(value).toLowerCase();
  for (const forbiddenValue of [
    "authentication_required", "retry_pending", "rate_limited", "no_results",
    "timeline_existing_evidence", "historical_backfill", "last_error",
  ]) {
    if (serialized.includes(forbiddenValue)) {
      violations.push(`public/timelines/coverage.json exposes private operational value ${forbiddenValue}`);
    }
  }
}

function validateCoverageShape(value, violations) {
  if (!isRecord(value)) return violations.push("internal coverage manifest must contain an object");
  if (value.schemaVersion !== COVERAGE_SCHEMA) violations.push(`coverage.schemaVersion must be ${COVERAGE_SCHEMA}`);
  requireTimestamp(value.generatedAt, "coverage.generatedAt", violations);
  requireSha(value.inventorySha256, "coverage.inventorySha256", violations);
  if (!Array.isArray(value.sourceArtifacts)) {
    violations.push(`coverage.sourceArtifacts must list the ${BASE_GRAPH_FILES.length} canonical base graph artifacts`);
  } else if (!BASE_GRAPH_FILES.every((filename) => value.sourceArtifacts.some((source) => path.basename(source?.path ?? "") === filename))) {
    violations.push(`coverage.sourceArtifacts must list all ${BASE_GRAPH_FILES.length} canonical base graph artifacts`);
  }
  if (!Array.isArray(value.companies)) violations.push("coverage.companies must be an array");
  if (!isRecord(value.totals)) return violations.push("coverage.totals must be an object");
  for (const key of [
    "inventoryRecords", "uniqueCompanies", "terminalUniqueCompanies", "completeCompanies",
    "partialCompanies", "failedCompanies", "publishedEvents", "candidates",
    "unresolvedConflicts", "unresolvedDates",
  ]) requireNonnegativeInteger(value.totals[key], `coverage.totals.${key}`, violations);
}

function validateCoverageCompany(entry, scope, violations) {
  if (!isRecord(entry)) return violations.push(`${scope} must be an object`);
  validateCompanyRef(entry.company, `${scope}.company`, violations);
  if (!COVERAGE_STATUSES.has(entry.status)) violations.push(`${scope}.status must be terminal`);
  requireSha(entry.artifactSha256, `${scope}.artifactSha256`, violations);
  for (const key of ["publishedEventCount", "candidateEventCount", "unresolvedConflictCount", "unresolvedDateCount"]) {
    requireNonnegativeInteger(entry[key], `${scope}.${key}`, violations);
  }
  if (entry.lastSuccessfulArtifactAt !== null) requireTimestamp(entry.lastSuccessfulArtifactAt, `${scope}.lastSuccessfulArtifactAt`, violations);
  if (entry.lastError !== null && typeof entry.lastError !== "string") violations.push(`${scope}.lastError must be null or a string`);
  if (!isRecord(entry.sourceCoverage) || Object.keys(entry.sourceCoverage).length === 0) {
    violations.push(`${scope}.sourceCoverage must record at least one source class`);
  } else {
    for (const [sourceClass, state] of Object.entries(entry.sourceCoverage)) {
      if (!sourceClass.trim()) violations.push(`${scope}.sourceCoverage contains a blank source class`);
      if (!TERMINAL_SOURCE_STATES.has(state)) violations.push(`${scope}.sourceCoverage.${sourceClass} is not terminal`);
    }
  }
}

function validateCompanyArtifact(value, manifestEntry, artifactPath, now, violations) {
  if (!isRecord(value)) {
    violations.push(`${artifactPath} must contain an object`);
    return { events: [] };
  }
  if (value.schemaVersion !== TIMELINE_SCHEMA) violations.push(`${artifactPath}.schemaVersion must be ${TIMELINE_SCHEMA}`);
  validateCompanyRef(value.company, `${artifactPath}.company`, violations);
  if (JSON.stringify(value.company) !== JSON.stringify(manifestEntry.company)) violations.push(`${artifactPath}.company must match coverage manifest`);
  requireTimestamp(value.generatedAt, `${artifactPath}.generatedAt`, violations);
  requireTimestamp(value.lastModifiedAt, `${artifactPath}.lastModifiedAt`, violations);
  if (value.nextCursor !== null && typeof value.nextCursor !== "string") violations.push(`${artifactPath}.nextCursor must be null or a string`);
  if (!Array.isArray(value.events)) {
    violations.push(`${artifactPath}.events must be an array`);
    return { events: [] };
  }
  let previousDate = null;
  const eventIds = new Set();
  for (const [index, event] of value.events.entries()) {
    const scope = `${artifactPath}.events[${index}]`;
    validatePublishedEvent(event, scope, now, violations);
    if (eventIds.has(event?.id)) violations.push(`${scope}.id duplicates ${event?.id}`);
    if (typeof event?.id === "string") eventIds.add(event.id);
    if (previousDate && typeof event?.eventDate === "string" && event.eventDate > previousDate) {
      violations.push(`${scope}.eventDate breaks newest-first chronological order`);
    }
    previousDate = typeof event?.eventDate === "string" ? event.eventDate : previousDate;
  }
  if (manifestEntry.publishedEventCount !== value.events.length) violations.push(`${artifactPath}.events count must match manifest`);
  validateGroups(value.groups, value.events, artifactPath, violations);
  if (!isRecord(value.coverage) || value.coverage.status !== manifestEntry.status || value.coverage.publishedEventCount !== value.events.length) {
    violations.push(`${artifactPath}.coverage must match manifest status and event count`);
  }
  if (hasForbiddenPublicKey(value)) violations.push(`${artifactPath} exposes a forbidden confidence, prompt, raw-text, or processing field`);
  return { events: value.events };
}

function validatePublishedEvent(event, scope, now, violations) {
  if (!isRecord(event)) return violations.push(`${scope} must be an object`);
  requireIdentifier(event.id, `${scope}.id`, violations);
  requireExactDate(event.eventDate, `${scope}.eventDate`, now, violations);
  if (!DATE_TYPES.has(event.eventDateType)) violations.push(`${scope}.eventDateType is invalid`);
  requireText(event.title, `${scope}.title`, violations, { min: 4, max: 140 });
  requireText(event.summary, `${scope}.summary`, violations, { min: 12, max: 320 });
  if (typeof event.summary === "string" && !isOneSentence(event.summary)) violations.push(`${scope}.summary must be exactly one sentence`);
  if (!CATEGORIES.has(event.category)) violations.push(`${scope}.category is invalid`);
  if (typeof event.isMajor !== "boolean") violations.push(`${scope}.isMajor must be boolean`);
  if (typeof event.hasConflict !== "boolean") violations.push(`${scope}.hasConflict must be boolean`);
  if (event.hasConflict) requireText(event.conflictSummary, `${scope}.conflictSummary`, violations, { min: 8, max: 240 });
  else if (event.conflictSummary !== null) violations.push(`${scope}.conflictSummary must be null without a conflict`);
  requireNonnegativeInteger(event.evidenceCount, `${scope}.evidenceCount`, violations);
  if (!Number.isInteger(event.evidenceCount) || event.evidenceCount < 1) violations.push(`${scope}.evidenceCount must be at least one`);
  if (!Array.isArray(event.sourcePreview) || event.sourcePreview.length < 1 || event.sourcePreview.length > MAX_SOURCE_PREVIEW) {
    violations.push(`${scope}.sourcePreview must contain 1-${MAX_SOURCE_PREVIEW} sources`);
  } else {
    if (event.sourcePreview.length > event.evidenceCount) violations.push(`${scope}.sourcePreview cannot exceed evidenceCount`);
    event.sourcePreview.forEach((source, index) => validateSource(source, `${scope}.sourcePreview[${index}]`, now, violations));
  }
}

function validateDetailArtifact(value, artifactPath, eventIndex, now, violations) {
  if (!isRecord(value)) return violations.push(`${artifactPath} must contain an object`);
  if (value.schemaVersion !== DETAIL_SCHEMA) violations.push(`${artifactPath}.schemaVersion must be ${DETAIL_SCHEMA}`);
  validateCompanyRef(value.company, `${artifactPath}.company`, violations);
  requireTimestamp(value.generatedAt, `${artifactPath}.generatedAt`, violations);
  requireTimestamp(value.lastModifiedAt, `${artifactPath}.lastModifiedAt`, violations);
  const event = value.event;
  validatePublishedEvent(event, `${artifactPath}.event`, now, violations);
  const indexed = typeof event?.id === "string" ? eventIndex.get(event.id) : null;
  if (!indexed) return violations.push(`${artifactPath}.event.id does not exist in a company artifact`);
  if (JSON.stringify(value.company) !== JSON.stringify(indexed.company)) violations.push(`${artifactPath}.company does not match owning company`);
  for (const key of ["eventDate", "eventDateType", "title", "summary", "category", "isMajor", "hasConflict", "conflictSummary", "evidenceCount"]) {
    if (event[key] !== indexed.event[key]) violations.push(`${artifactPath}.event.${key} differs from the initial artifact`);
  }
  if (!Array.isArray(event.evidence) || event.evidence.length < 1) violations.push(`${artifactPath}.event.evidence must contain direct evidence`);
  else event.evidence.forEach((source, index) => validateEvidenceDetail(source, `${artifactPath}.event.evidence[${index}]`, now, violations));
  if (!Array.isArray(event.posts)) violations.push(`${artifactPath}.event.posts must be an array`);
  else event.posts.forEach((post, index) => validatePost(post, `${artifactPath}.event.posts[${index}]`, now, violations));
  const evidenceIds = new Set(Array.isArray(event.evidence) ? event.evidence.map((source) => source?.id) : []);
  for (const preview of indexed.event.sourcePreview) {
    if (!evidenceIds.has(preview.id)) violations.push(`${artifactPath} omits preview source ${preview.id} from full evidence`);
  }
  if (hasForbiddenPublicKey(value)) violations.push(`${artifactPath} exposes a forbidden confidence, prompt, raw-text, or processing field`);
  return event?.id;
}

function validateEvidenceDetail(source, scope, now, violations) {
  validateSource(source, scope, now, violations);
  if (source.publicationDate !== null) requireTimestampOrDate(source.publicationDate, `${scope}.publicationDate`, now, violations);
  if (source.sourceEventDate !== null) requireExactDate(source.sourceEventDate, `${scope}.sourceEventDate`, now, violations);
  if (source.excerpt !== null) requireText(source.excerpt, `${scope}.excerpt`, violations, { min: 1, max: 500 });
  if (typeof source.isConflicting !== "boolean") violations.push(`${scope}.isConflicting must be boolean`);
  if (source.isConflicting) requireText(source.conflictDescription, `${scope}.conflictDescription`, violations, { min: 4, max: 300 });
  else if (source.conflictDescription !== null) violations.push(`${scope}.conflictDescription must be null without a conflict`);
}

function validatePost(post, scope, now, violations) {
  if (!isRecord(post)) return violations.push(`${scope} must be an object`);
  requireIdentifier(post.id, `${scope}.id`, violations);
  requireText(post.platform, `${scope}.platform`, violations, { min: 1, max: 40 });
  if (post.account !== null) requireText(post.account, `${scope}.account`, violations, { min: 1, max: 160 });
  requireExactDate(post.postDate, `${scope}.postDate`, now, violations);
  if (post.excerpt !== null) requireText(post.excerpt, `${scope}.excerpt`, violations, { min: 1, max: 500 });
  validatePublicUrl(post.url, `${scope}.url`, violations);
  if (!isRecord(post.metrics)) violations.push(`${scope}.metrics must be an object`);
  else {
    const entries = Object.entries(post.metrics);
    if (entries.length > 64) violations.push(`${scope}.metrics must contain at most 64 bounded numeric fields`);
    for (const [key, metric] of entries) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)
          || (metric !== null && (typeof metric !== "number" || !Number.isFinite(metric)))) {
        violations.push(`${scope}.metrics.${key} must be a finite number or null`);
      }
    }
  }
  if (!EVIDENCE_ROLES.has(post.evidenceRole)) violations.push(`${scope}.evidenceRole is invalid`);
}

function validateSource(source, scope, now, violations) {
  if (!isRecord(source)) return violations.push(`${scope} must be an object`);
  requireIdentifier(source.id, `${scope}.id`, violations);
  requireText(source.title, `${scope}.title`, violations, { min: 1, max: 240 });
  if (source.publisher !== null) requireText(source.publisher, `${scope}.publisher`, violations, { min: 1, max: 160 });
  requireText(source.domain, `${scope}.domain`, violations, { min: 3, max: 255 });
  requireText(source.sourceType, `${scope}.sourceType`, violations, { min: 2, max: 64 });
  if (source.publishedAt !== null) requireTimestampOrDate(source.publishedAt, `${scope}.publishedAt`, now, violations);
  if (!EVIDENCE_ROLES.has(source.evidenceRole)) violations.push(`${scope}.evidenceRole is invalid`);
  validatePublicUrl(source.url, `${scope}.url`, violations);
  try {
    const hostname = new URL(source.url).hostname.replace(/^www\./, "").toLowerCase();
    if (typeof source.domain === "string" && source.domain.toLowerCase() !== hostname) violations.push(`${scope}.domain must match url hostname ${hostname}`);
  } catch {
    // URL validation reports the actionable issue.
  }
}

function validateGroups(groups, events, artifactPath, violations) {
  if (!Array.isArray(groups)) return violations.push(`${artifactPath}.groups must be an array`);
  const expected = new Map();
  for (const event of events) {
    if (typeof event?.eventDate !== "string") continue;
    const month = event.eventDate.slice(0, 7);
    expected.set(month, (expected.get(month) ?? 0) + 1);
  }
  const actual = new Map();
  let previousYear = Infinity;
  for (const [groupIndex, group] of groups.entries()) {
    if (!isRecord(group) || !Number.isInteger(group.year)) {
      violations.push(`${artifactPath}.groups[${groupIndex}] must contain an integer year`);
      continue;
    }
    if (group.year >= previousYear) violations.push(`${artifactPath}.groups must use descending unique years`);
    previousYear = group.year;
    if (!Array.isArray(group.months)) {
      violations.push(`${artifactPath}.groups[${groupIndex}].months must be an array`);
      continue;
    }
    let previousMonth = "99";
    for (const [monthIndex, item] of group.months.entries()) {
      const scope = `${artifactPath}.groups[${groupIndex}].months[${monthIndex}]`;
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(item?.month ?? "")) violations.push(`${scope}.month must be YYYY-MM`);
      if (typeof item?.month === "string" && Number(item.month.slice(0, 4)) !== group.year) violations.push(`${scope}.month must belong to group year`);
      const monthPart = typeof item?.month === "string" ? item.month.slice(5) : "";
      if (monthPart >= previousMonth) violations.push(`${scope} breaks descending month order`);
      previousMonth = monthPart;
      requireNonnegativeInteger(item?.count, `${scope}.count`, violations);
      if (typeof item?.month === "string") actual.set(item.month, item.count);
    }
  }
  if (JSON.stringify([...actual]) !== JSON.stringify([...expected])) violations.push(`${artifactPath}.groups do not match filtered event months`);
}

async function readCanonicalInventory(rootDir, violations) {
  const companies = new Map();
  const sourceArtifacts = [];
  let inventoryRecords = 0;
  for (const filename of BASE_GRAPH_FILES) {
    const relativePath = path.posix.join("public", "graph", filename);
    const graphRead = await readJsonWithHash(path.join(rootDir, relativePath), violations, relativePath);
    if (!graphRead) continue;
    sourceArtifacts.push({ path: relativePath, sha256: graphRead.sha256 });
    const nodes = Array.isArray(graphRead.value?.nodes) ? graphRead.value.nodes : [];
    for (const node of nodes) {
      if (node?.entityType !== "company" || typeof node.entityId !== "string") continue;
      inventoryRecords += 1;
      if (!companies.has(node.entityId)) companies.set(node.entityId, { name: node.label, batches: [] });
      companies.get(node.entityId).batches.push(node.batchSlug);
    }
  }
  const inventorySha256 = sha256(JSON.stringify([...companies.entries()].sort(([left], [right]) => left.localeCompare(right))));
  return { companies, inventoryRecords, sourceArtifacts, inventorySha256 };
}

function validateInventoryCoverage(inventory, coverage, manifestByCompanyId, violations) {
  for (const companyId of inventory.companies.keys()) {
    if (!manifestByCompanyId.has(companyId)) violations.push(`Coverage manifest omits canonical company ${companyId}`);
  }
  for (const companyId of manifestByCompanyId.keys()) {
    if (!inventory.companies.has(companyId)) violations.push(`Coverage manifest contains unknown company ${companyId}`);
  }
  const totals = coverage?.totals ?? {};
  compareTotal(totals.inventoryRecords, inventory.inventoryRecords, "inventoryRecords", violations);
  compareTotal(totals.uniqueCompanies, inventory.companies.size, "uniqueCompanies", violations);
  compareTotal(totals.terminalUniqueCompanies, manifestByCompanyId.size, "terminalUniqueCompanies", violations);
  compareTotal(totals.completeCompanies, [...manifestByCompanyId.values()].filter((entry) => entry.status === "complete").length, "completeCompanies", violations);
  compareTotal(totals.partialCompanies, [...manifestByCompanyId.values()].filter((entry) => entry.status === "partial").length, "partialCompanies", violations);
  compareTotal(totals.failedCompanies, [...manifestByCompanyId.values()].filter((entry) => entry.status === "failed").length, "failedCompanies", violations);
  if (coverage.inventorySha256 !== inventory.inventorySha256) violations.push("coverage.inventorySha256 does not match canonical graph inventory");
}

async function validateSourceArtifactHashes(rootDir, coverage, violations) {
  if (!Array.isArray(coverage?.sourceArtifacts)) return;
  const seen = new Set();
  for (const [index, source] of coverage.sourceArtifacts.entries()) {
    const scope = `coverage.sourceArtifacts[${index}]`;
    if (!isRecord(source) || typeof source.path !== "string") {
      violations.push(`${scope}.path must identify a canonical timeline source artifact`);
      continue;
    }
    const normalized = path.posix.normalize(source.path);
    const allowed = normalized.startsWith("public/graph/")
      && BASE_GRAPH_FILES.includes(path.basename(normalized))
      || SUPPLEMENTAL_TIMELINE_FILES.includes(normalized);
    if (!allowed || normalized.includes("..")) {
      violations.push(`${scope}.path must identify an allowed canonical timeline source artifact`);
      continue;
    }
    if (seen.has(normalized)) violations.push(`${scope}.path duplicates ${normalized}`);
    seen.add(normalized);
    const bytes = await readFile(path.join(rootDir, normalized)).catch(() => null);
    if (!bytes || sha256(bytes) !== source.sha256) violations.push(`${scope}.sha256 does not match ${normalized}`);
  }
}

async function readJsonWithHash(absolutePath, violations, label) {
  let bytes;
  try {
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile()) {
      violations.push(`${label}: artifact must be a regular file`);
      return null;
    }
    bytes = await readFile(absolutePath);
  } catch (error) {
    violations.push(`${label}: could not read artifact (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
  try {
    return { value: JSON.parse(bytes.toString("utf8")), sha256: sha256(bytes), byteSize: bytes.byteLength };
  } catch {
    violations.push(`${label}: invalid JSON`);
    return null;
  }
}

async function jsonFiles(directory, violations) {
  try {
    return (await readdir(directory)).filter((filename) => filename.endsWith(".json")).sort();
  } catch (error) {
    violations.push(`${path.relative(process.cwd(), directory)}: could not list artifacts (${error instanceof Error ? error.message : String(error)})`);
    return [];
  }
}

function safeArtifactPath(value, subdirectory) {
  if (typeof value !== "string") return null;
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  const prefix = `public/timelines/${subdirectory}/`;
  return normalized.startsWith(prefix) && !normalized.includes("..") && normalized.endsWith(".json") ? normalized : null;
}

function validateCompanyRef(company, scope, violations) {
  if (!isRecord(company)) return violations.push(`${scope} must be an object`);
  requireIdentifier(company.id, `${scope}.id`, violations);
  if (typeof company.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(company.slug)) violations.push(`${scope}.slug must be canonical kebab-case`);
  requireText(company.name, `${scope}.name`, violations, { min: 1, max: 160 });
}

function requireExactDate(value, scope, now, violations) {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) {
    return violations.push(`${scope} must be an exact YYYY-MM-DD date`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) violations.push(`${scope} is not a real calendar date`);
  if (parsed.getTime() > now.getTime() + 86_400_000) violations.push(`${scope} cannot be in the future`);
}

function requireTimestampOrDate(value, scope, now, violations) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return requireExactDate(value, scope, now, violations);
  requireTimestamp(value, scope, violations);
}

function requireTimestamp(value, scope, violations) {
  if (typeof value !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || Number.isNaN(Date.parse(value))) {
    violations.push(`${scope} must be a strict ISO-8601 timestamp with an explicit timezone`);
  }
}

function requireText(value, scope, violations, { min, max }) {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) violations.push(`${scope} must contain ${min}-${max} characters`);
  if (typeof value === "string" && /<\/?[a-z][^>]*>/i.test(value)) violations.push(`${scope} must not contain HTML`);
}

function requireIdentifier(value, scope, violations) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,255}$/.test(value)) violations.push(`${scope} must be a stable identifier`);
}

function requireSha(value, scope, violations) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) violations.push(`${scope} must be a lowercase SHA-256 digest`);
}

function requireNonnegativeInteger(value, scope, violations) {
  if (!Number.isInteger(value) || value < 0) violations.push(`${scope} must be a non-negative integer`);
}

function validatePublicUrl(value, scope, violations) {
  if (typeof value !== "string" || value.length > 2_048) {
    violations.push(`${scope} must be a URL no longer than 2048 characters`);
    return;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return violations.push(`${scope} must be an absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") violations.push(`${scope} must use http or https`);
  if (url.username || url.password) violations.push(`${scope} must not contain credentials`);
  if (!isPublicHostname(url.hostname)) violations.push(`${scope} must not target localhost or a private network`);
  for (const parameter of url.searchParams.keys()) {
    if (parameter.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(parameter.toLowerCase())) {
      violations.push(`${scope} contains tracking parameter ${parameter}`);
    }
  }
}

function isPublicHostname(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) return false;
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    const octets = normalized.split(".").map(Number);
    return !(octets[0] === 10 || octets[0] === 127 || octets[0] === 0 || (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168));
  }
  if (ipVersion === 6) return !(normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb"));
  return true;
}

function isOneSentence(value) {
  const segments = [...sentenceSegmenter.segment(value.trim())].filter((entry) => entry.segment.trim());
  return segments.length === 1 && /[.!?][\])}"'’”]*$/.test(value.trim());
}

function hasForbiddenPublicKey(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll("_", "");
    if (normalized.includes("confidence") || normalized.includes("prompt") || normalized === "rawtext" || normalized === "normalizedtext" || normalized === "classifierversion" || normalized === "extractionversion") return true;
    if (hasForbiddenPublicKey(nested, seen)) return true;
  }
  return false;
}

function compareTotal(actual, expected, label, violations) {
  if (actual !== expected) violations.push(`coverage.totals.${label} must be ${expected}, received ${String(actual)}`);
}

function sum(entries, key) {
  return entries.reduce((total, entry) => total + (Number.isInteger(entry?.[key]) ? entry[key] : 0), 0);
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseArgs(rawArgs) {
  const args = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const argument = rawArgs[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    const [flag, inline] = argument.split("=", 2);
    if (flag !== "--root-dir") throw new Error(`Unknown argument ${flag}`);
    const value = inline ?? rawArgs[++index];
    if (!value) throw new Error("--root-dir requires a value");
    args.rootDir = path.resolve(value);
  }
  return args;
}

function usage() {
  return "Usage: node scripts/validate-timeline-artifacts.mjs [--root-dir=.]";
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) console.log(usage());
  else validateTimelineArtifacts(options)
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
