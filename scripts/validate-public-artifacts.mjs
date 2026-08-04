import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  formatStaticGraphSnapshotContractIssue,
  validateStaticGraphSnapshotContract
} from "../src/lib/graph/static-graph-snapshot-contract.mjs";

export const EXPECTED_SCORING_MODEL = Object.freeze({
  id: "returner-traction",
  version: "4.2.0",
  name: "returner-traction-v4-absolute-fixed-platform-global-best"
});
export const HISTORICAL_SCORING_MODEL_VERSIONS = Object.freeze(["4.0.0", "4.0.1", "4.0.2", "4.1.0"]);
const SUPPORTED_HISTORY_MODEL_VERSIONS = new Set([
  EXPECTED_SCORING_MODEL.version,
  ...HISTORICAL_SCORING_MODEL_VERSIONS
]);

export const GRAPH_ARTIFACTS = Object.freeze([
  graphArtifact("S2026", "s2026.json"),
  graphArtifact("S2026", "s2026-yc-partners.json", "yc_partners"),
  graphArtifact("S2026", "s2026-insiders.json", "insiders"),
  graphArtifact("S26", "s26.json"),
  graphArtifact("S26", "s26-yc-partners.json", "yc_partners"),
  graphArtifact("S26", "s26-insiders.json", "insiders"),
  graphArtifact("A16ZSR006", "a16zsr006.json"),
  graphArtifact("A16ZSR006", "a16zsr006-yc-partners.json", "yc_partners"),
  graphArtifact("A16ZSR006", "a16zsr006-insiders.json", "insiders")
]);

export const HISTORY_ARTIFACTS = Object.freeze([
  historyArtifact("S2026", "s2026-score-benchmarks.json"),
  historyArtifact("S26", "s26-score-benchmarks.json"),
  historyArtifact("A16ZSR006", "a16zsr006-score-benchmarks.json")
]);

export const S26_CATALOG_PATH = path.posix.join(
  "src",
  "lib",
  "yc",
  "summer-2026-companies.json"
);

const PLATFORM_WEIGHTS = Object.freeze({
  x: 0.21,
  instagram: 0.21,
  linkedin: 0.15,
  github: 0.15,
  youtube: 0.1,
  product_hunt: 0.07,
  hacker_news: 0.05,
  reddit: 0.04,
  bilibili: 0.02
});
const SIGNAL_FAMILIES = Object.freeze([
  "reach",
  "engagement",
  "developerAdoption",
  "launchAndCommunity",
  "momentum"
]);
const SUPPORTED_PLATFORM_COUNT = Object.keys(PLATFORM_WEIGHTS).length;
const SCORE_EPSILON = 1e-9;
const MAX_FUTURE_SKEW_MS = 60_000;
const CENTRAL_TIME_ZONE = "America/Chicago";
const CANONICAL_NODE_FIELDS = [
  "score",
  "previousScore",
  "scoreDelta",
  "radius",
  "topPlatform",
  "platformScores",
  "scoreBreakdown"
];
const CANONICAL_LEADERBOARD_FIELDS = ["rank", "score", "topPlatform"];
const CENTRAL_DAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: CENTRAL_TIME_ZONE,
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});
const OBJECT_ID = /^[A-Za-z0-9_-]+$/;
const REDDIT_ID = /^[A-Za-z0-9]+$/;
const GITHUB_REPO = /^[A-Za-z0-9_.-]+$/;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const BLUESKY_RECORD_KEY = /^[A-Za-z0-9._~:-]{1,512}$/;
const YC_COMPANY_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GITHUB_REPOSITORY_ACTIVITY_FIELDS = Object.freeze([
  "observedAt",
  "metricsCheckedAt",
  "linkCheckedAt",
  "first_seen_at",
  "last_checked_at",
  "last_updated_at"
]);
const GITHUB_RESERVED_OWNERS = new Set([
  "collections",
  "codespaces",
  "enterprise",
  "events",
  "explore",
  "features",
  "gist",
  "login",
  "marketplace",
  "new",
  "notifications",
  "organizations",
  "orgs",
  "pricing",
  "search",
  "settings",
  "signup",
  "sponsors",
  "topics",
  "users"
]);

export class PublicArtifactValidationError extends Error {
  constructor(violations) {
    super(formatValidationFailure(violations));
    this.name = "PublicArtifactValidationError";
    this.violations = [...violations];
  }
}

export async function validatePublicArtifacts({
  rootDir = process.cwd(),
  now = new Date(),
  requireCurrentCentralDay = false
} = {}) {
  if (!isValidDate(now)) {
    throw new TypeError("Public artifact validation requires a valid now timestamp");
  }
  const violations = [];
  let graphNodes = 0;
  let evidenceRows = 0;
  let versionedDailyEntries = 0;
  let versionedWeeklyEntries = 0;
  const graphArtifacts = [];

  for (const descriptor of GRAPH_ARTIFACTS) {
    const graph = await readJsonArtifact(rootDir, descriptor.path, violations);
    if (graph === null) continue;
    violations.push(...collectGraphArtifactViolations(graph, descriptor, {
      now,
      requireCurrentCentralDay
    }));
    graphArtifacts.push({ descriptor, graph });
    graphNodes += Array.isArray(graph?.nodes) ? graph.nodes.length : 0;
    evidenceRows += Array.isArray(graph?.evidence) ? graph.evidence.length : 0;
  }
  const s26Catalog = await readJsonArtifact(rootDir, S26_CATALOG_PATH, violations);
  if (s26Catalog !== null) {
    violations.push(...collectS26GraphCensusViolations(s26Catalog, graphArtifacts));
  }
  violations.push(...collectCanonicalGraphSetViolations(graphArtifacts));

  for (const descriptor of HISTORY_ARTIFACTS) {
    const history = await readJsonArtifact(rootDir, descriptor.path, violations);
    if (history === null) continue;
    const result = collectHistoryArtifactViolations(history, descriptor, {
      now,
      requireCurrentCentralDay
    });
    violations.push(...result.violations);
    versionedDailyEntries += result.versionedDailyEntries;
    versionedWeeklyEntries += result.versionedWeeklyEntries;
  }

  if (violations.length) {
    throw new PublicArtifactValidationError(violations);
  }

  return {
    status: "ok",
    scoringModel: `${EXPECTED_SCORING_MODEL.id}@${EXPECTED_SCORING_MODEL.version}`,
    graphSnapshots: GRAPH_ARTIFACTS.length,
    historyFiles: HISTORY_ARTIFACTS.length,
    graphNodes,
    evidenceRows,
    versionedDailyEntries,
    versionedWeeklyEntries
  };
}

export function collectS26GraphCensusViolations(catalog, graphArtifacts) {
  const violations = [];
  if (!isRecord(catalog)) {
    return [`${S26_CATALOG_PATH}: expected a JSON object`];
  }
  if (!Array.isArray(catalog.companies) || catalog.companies.length === 0) {
    return [`${S26_CATALOG_PATH}: companies must be a non-empty array`];
  }

  const catalogCount = catalog.companies.length;
  for (const sourceCountField of ["observedCompanyCount", "expectedCompanyCount"]) {
    const sourceCount = catalog.source?.[sourceCountField];
    if (
      (sourceCountField === "observedCompanyCount" || sourceCount !== undefined) &&
      sourceCount !== catalogCount
    ) {
      violations.push(
        `${S26_CATALOG_PATH}: source.${sourceCountField} must equal the ${catalogCount}-company catalog, received ${formatValue(sourceCount)}`
      );
    }
  }

  const catalogByEntityId = new Map();
  const catalogBySlug = new Map();
  const catalogIds = new Map();
  const catalogObjectIds = new Map();
  for (const [index, company] of catalog.companies.entries()) {
    const scope = `${S26_CATALOG_PATH}: companies[${index}]`;
    if (!isRecord(company)) {
      violations.push(`${scope} must be an object`);
      continue;
    }
    const companyId = nonEmptyString(company.id);
    const objectId = nonEmptyString(company.objectID);
    const slug = validCompanySlug(company.slug);
    if (!companyId) {
      violations.push(`${scope}.id must be a non-empty string`);
    }
    if (!objectId) {
      violations.push(`${scope}.objectID must be a non-empty string`);
    } else if (companyId && objectId !== companyId) {
      violations.push(`${scope}.objectID must equal id ${companyId}, received ${formatValue(objectId)}`);
    }
    if (!slug) {
      violations.push(`${scope}.slug must be a canonical company slug`);
    }
    if (companyId) {
      const previousIndex = catalogIds.get(companyId);
      if (previousIndex !== undefined) {
        violations.push(`${scope}.id duplicates companies[${previousIndex}].id ${companyId}`);
      } else {
        catalogIds.set(companyId, index);
      }
    }
    if (objectId) {
      const previousIndex = catalogObjectIds.get(objectId);
      if (previousIndex !== undefined) {
        violations.push(`${scope}.objectID duplicates companies[${previousIndex}].objectID ${objectId}`);
      } else {
        catalogObjectIds.set(objectId, index);
      }
    }
    if (!slug) continue;

    const entityId = `company-${slug}`;
    const previousEntity = catalogByEntityId.get(entityId);
    if (previousEntity) {
      violations.push(`${scope}.slug duplicates ${previousEntity.scope}.slug ${slug}`);
      continue;
    }
    const profileSlug = ycCompanySlugFromUrl(company.ycProfileUrl);
    if (profileSlug !== slug) {
      violations.push(
        `${scope}.ycProfileUrl must identify slug ${slug}, received ${formatValue(company.ycProfileUrl)}`
      );
    }
    const entry = { companyId, entityId, slug, scope };
    catalogByEntityId.set(entityId, entry);
    catalogBySlug.set(slug, entry);
  }

  for (const entry of Array.isArray(graphArtifacts) ? graphArtifacts : []) {
    const descriptor = entry?.descriptor;
    const graph = entry?.graph;
    if (descriptor?.batch !== "S26" || !isRecord(graph)) continue;
    const artifactPath = descriptor.path;
    for (const countField of ["companyCountObserved", "companyCountExpected"]) {
      const graphCount = graph.batch?.[countField];
      if (graphCount !== undefined && graphCount !== catalogCount) {
        violations.push(
          `${artifactPath}: batch.${countField} must match the S26 catalog count ${catalogCount}, received ${formatValue(graphCount)}`
        );
      }
    }

    const companyNodes = (Array.isArray(graph.nodes) ? graph.nodes : []).filter(
      (node) => node?.entityType === "company"
    );
    const graphEntityIds = new Set();
    const graphSlugs = new Set();
    for (const [index, node] of companyNodes.entries()) {
      const scope = `${artifactPath}: nodes[${index}]`;
      const entityId = nonEmptyString(node?.entityId);
      const slug = ycCompanySlugFromUrl(node?.ycProfileUrl);
      if (entityId) graphEntityIds.add(entityId);
      if (slug) graphSlugs.add(slug);

      const catalogCompany = entityId ? catalogByEntityId.get(entityId) : null;
      if (entityId && !catalogCompany) {
        violations.push(`${scope}.entityId ${entityId} is absent from the S26 catalog`);
      }
      if (!slug) {
        violations.push(`${scope}.ycProfileUrl must contain a canonical YC company slug`);
      } else if (!catalogBySlug.has(slug)) {
        violations.push(`${scope}.ycProfileUrl slug ${slug} is absent from the S26 catalog`);
      }
      if (catalogCompany && slug && catalogCompany.slug !== slug) {
        violations.push(
          `${scope} pairs entityId ${entityId} with YC slug ${slug}; the S26 catalog maps it to ${catalogCompany.slug}`
        );
      }
    }

    // Audience snapshots intentionally contain only companies connected to the
    // selected Top Voice cohort. Their included companies must still be a clean
    // catalog subset, while the base snapshot must materialize the full census.
    if ((descriptor.audience ?? "off") !== "off") continue;
    if (companyNodes.length !== catalogCount) {
      violations.push(
        `${artifactPath}: base snapshot has ${companyNodes.length} company nodes for the ${catalogCount}-company S26 catalog`
      );
    }
    appendSetCensusViolation(
      violations,
      artifactPath,
      "company entityId",
      new Set(catalogByEntityId.keys()),
      graphEntityIds
    );
    appendSetCensusViolation(
      violations,
      artifactPath,
      "company slug",
      new Set(catalogBySlug.keys()),
      graphSlugs
    );
  }

  return violations;
}

export function collectGraphArtifactViolations(
  graph,
  descriptor,
  { now = new Date(), requireCurrentCentralDay = false } = {}
) {
  const violations = [];
  const artifactPath = descriptor?.path ?? "public graph artifact";
  const expectedBatch = descriptor?.batch;
  const expectedAudience = descriptor?.audience ?? "off";
  const expectedScope = "all_platforms";

  if (!isRecord(graph)) {
    return [`${artifactPath}: expected a JSON object`];
  }

  const validationNow = isValidDate(now) ? now : new Date();
  const contract = validateStaticGraphSnapshotContract(graph, {
    now: validationNow,
    maxFutureSkewMs: MAX_FUTURE_SKEW_MS
  });
  if (!contract.ok) {
    violations.push(
      ...contract.issues.map(
        (issue) => `${artifactPath}: ${formatStaticGraphSnapshotContractIssue(issue)}`
      )
    );
  }

  if (graph.mode !== "official_snapshot") {
    violations.push(`${artifactPath}: mode must be official_snapshot, received ${formatValue(graph.mode)}`);
  }
  if (!isRecord(graph.batch)) {
    violations.push(`${artifactPath}: batch must be an object`);
  } else {
    if (graph.batch.slug !== expectedBatch) {
      violations.push(
        `${artifactPath}: batch.slug must be ${expectedBatch}, received ${formatValue(graph.batch.slug)}`
      );
    }
    if (!isPositiveInteger(graph.batch.companyCountObserved)) {
      violations.push(`${artifactPath}: batch.companyCountObserved must be a positive integer`);
    }
  }

  if (graph.selectedTopVoiceAudience?.id !== expectedAudience) {
    violations.push(
      `${artifactPath}: selectedTopVoiceAudience.id must be ${expectedAudience}, received ${formatValue(graph.selectedTopVoiceAudience?.id)}`
    );
  }
  if (!isIsoTimestamp(graph.generatedAt)) {
    violations.push(`${artifactPath}: generatedAt must be an ISO timestamp`);
  } else if (requireCurrentCentralDay && !isCurrentCentralDay(graph.generatedAt, validationNow)) {
    violations.push(
      `${artifactPath}: generatedAt must be on the current ${CENTRAL_TIME_ZONE} day ${centralDayKey(validationNow)}`
    );
  }

  validateScoringContext(graph.scoringContext, graph.generatedAt, expectedScope, artifactPath, violations);

  const nodes = arrayField(graph, "nodes", artifactPath, violations);
  const leaderboard = arrayField(graph, "leaderboard", artifactPath, violations);
  const fastestGaining = arrayField(graph, "fastestGaining", artifactPath, violations);
  const evidence = arrayField(graph, "evidence", artifactPath, violations);

  if (leaderboard && nodes && leaderboard.length !== nodes.length) {
    violations.push(
      `${artifactPath}: leaderboard has ${leaderboard.length} rows for ${nodes.length} nodes`
    );
  }
  if (fastestGaining && leaderboard && fastestGaining.length !== leaderboard.length) {
    violations.push(
      `${artifactPath}: fastestGaining has ${fastestGaining.length} rows for ${leaderboard.length} leaderboard rows`
    );
  }
  if (
    expectedAudience === "off" &&
    nodes &&
    isPositiveInteger(graph.batch?.companyCountObserved) &&
    nodes.length !== graph.batch.companyCountObserved
  ) {
    violations.push(
      `${artifactPath}: base snapshot has ${nodes.length} nodes for ${graph.batch.companyCountObserved} observed companies`
    );
  }

  const nodesByCompanyId = new Map();
  const nodeIds = new Set();
  const breakdowns = [];

  for (const [index, node] of (nodes ?? []).entries()) {
    const nodeLabel = node?.entityId ?? node?.id ?? `index ${index}`;
    const scope = `${artifactPath}: node ${nodeLabel}`;
    if (!isRecord(node)) {
      violations.push(`${scope} must be an object`);
      continue;
    }
    if (typeof node.entityId !== "string" || !node.entityId) {
      violations.push(`${scope} must have a non-empty entityId`);
    } else if (nodesByCompanyId.has(node.entityId)) {
      violations.push(`${scope} duplicates company entityId ${node.entityId}`);
    } else {
      nodesByCompanyId.set(node.entityId, node);
    }
    if (typeof node.id !== "string" || !node.id) {
      violations.push(`${scope} must have a non-empty id`);
    } else if (nodeIds.has(node.id)) {
      violations.push(`${scope} duplicates node id ${node.id}`);
    } else {
      nodeIds.add(node.id);
    }
    if (node.entityType !== "company" || node.id !== `company:${node.entityId}`) {
      violations.push(`${scope} must use coherent company identity company:${node.entityId}`);
    }
    if (node.batchSlug !== expectedBatch) {
      violations.push(`${scope} batchSlug must be ${expectedBatch}, received ${formatValue(node.batchSlug)}`);
    }
    if (
      expectedAudience !== "off" &&
      node.selectedTopVoiceAudience?.id !== expectedAudience
    ) {
      violations.push(`${scope} selected Top Voice audience must be ${expectedAudience}`);
    }

    validateNodeScores(node, scope, violations);
    const breakdown = validateScoreBreakdown(node.scoreBreakdown, node.score, scope, violations);
    if (breakdown) breakdowns.push({ scope, breakdown });

    if (isRecord(node.platformScores) && isRecord(breakdown?.platformScores)) {
      if (!sameNumericRecord(node.platformScores, breakdown.platformScores)) {
        violations.push(`${scope} platformScores must match scoreBreakdown.platformScores`);
      }
    }
    if (breakdown) {
      const expectedTopPlatform = breakdown.weightedPlatforms?.[0]?.platform ?? null;
      if (node.topPlatform !== expectedTopPlatform) {
        violations.push(
          `${scope} topPlatform must be ${formatValue(expectedTopPlatform)}, received ${formatValue(node.topPlatform)}`
        );
      }
    }
    validateStringIdArray(node.evidenceIds, `${scope} evidenceIds`, violations);
    if (expectedAudience !== "off") {
      if (!isPositiveInteger(node.topVoiceConnectionCount)) {
        violations.push(`${scope} must have a positive topVoiceConnectionCount`);
      }
      if (!Array.isArray(node.evidenceIds) || node.evidenceIds.length === 0) {
        violations.push(`${scope} must reference matched Top Voice evidence`);
      }
    }
  }

  validateCalibrationModes(breakdowns, expectedAudience, artifactPath, violations);
  validateLeaderboard(
    leaderboard ?? [],
    nodesByCompanyId,
    artifactPath,
    violations,
    { allowCanonicalRankGaps: expectedAudience !== "off" }
  );
  validateEvidence(evidence ?? [], nodes ?? [], expectedAudience, artifactPath, violations);

  return violations;
}

export function collectCanonicalGraphSetViolations(entries) {
  const violations = [];
  const graphByBatchAndAudience = new Map(
    (Array.isArray(entries) ? entries : []).map(({ descriptor, graph }) => [
      `${descriptor?.batch}:${descriptor?.audience ?? "off"}`,
      { descriptor, graph }
    ])
  );

  for (const descriptor of GRAPH_ARTIFACTS) {
    if (descriptor.audience === "off") continue;

    const audienceEntry = graphByBatchAndAudience.get(`${descriptor.batch}:${descriptor.audience}`);
    const baseEntry = graphByBatchAndAudience.get(`${descriptor.batch}:off`);
    if (!audienceEntry || !baseEntry || !isRecord(audienceEntry.graph) || !isRecord(baseEntry.graph)) {
      continue;
    }
    collectCanonicalAudienceGraphViolations(
      baseEntry.graph,
      audienceEntry.graph,
      descriptor.path,
      violations
    );
  }

  const baseCompanyNodes = [...graphByBatchAndAudience.entries()]
    .filter(([key, entry]) => key.endsWith(":off") && isRecord(entry.graph))
    .flatMap(([, entry]) =>
      (Array.isArray(entry.graph.nodes) ? entry.graph.nodes : []).filter(
        (node) => node?.entityType === "company"
      )
    );
  const positiveBaseCompanyNodes = baseCompanyNodes.filter(
    (node) => isFiniteNumber(node?.scoreBreakdown?.absoluteScore) && node.scoreBreakdown.absoluteScore > 0
  );
  const expectedCohortSize = positiveBaseCompanyNodes.length;
  const expectedBenchmarkScore = expectedCohortSize > 0
    ? Math.max(...positiveBaseCompanyNodes.map((node) => node.scoreBreakdown.absoluteScore))
    : 0;
  const expectedScaleFactor = expectedBenchmarkScore > 0 ? 100 / expectedBenchmarkScore : 0;

  for (const entry of graphByBatchAndAudience.values()) {
    if (!isRecord(entry.graph)) continue;
    const companyNodes = (Array.isArray(entry.graph.nodes) ? entry.graph.nodes : []).filter(
      (node) => node?.entityType === "company"
    );
    for (const node of companyNodes) {
      const calibration = node?.scoreBreakdown?.calibration;
      if (!isRecord(calibration)) continue;
      const scope = `canonical graph ${formatValue(entry.graph.batch?.slug)}: node ${formatValue(node.entityId)}`;
      if (calibration.cohortSize !== expectedCohortSize) {
        violations.push(`${scope} calibration.cohortSize must be global count ${expectedCohortSize}`);
      }
      if (!numbersEqual(calibration.benchmarkScore, expectedBenchmarkScore)) {
        violations.push(`${scope} calibration.benchmarkScore must be global maximum ${expectedBenchmarkScore}`);
      }
      if (
        !isFiniteNumber(calibration.scaleFactor) ||
        Math.abs(calibration.scaleFactor - expectedScaleFactor) > 1e-9
      ) {
        violations.push(`${scope} calibration.scaleFactor must use the one global factor ${expectedScaleFactor}`);
      }
    }
    const zeroEvidenceNodes = companyNodes.filter(
      (node) => Number(node?.scoreBreakdown?.absoluteScore) === 0
    );
    if (zeroEvidenceNodes.some((node) => node.score !== 0)) {
      violations.push(
        `canonical graph ${formatValue(entry.graph.batch?.slug)}: companies without scored evidence must remain at 0`
      );
    }
  }

  return violations;
}

function collectCanonicalAudienceGraphViolations(baseGraph, audienceGraph, artifactPath, violations) {
  const baseNodes = new Map(
    (Array.isArray(baseGraph.nodes) ? baseGraph.nodes : []).map((node) => [node?.entityId, node])
  );
  for (const node of Array.isArray(audienceGraph.nodes) ? audienceGraph.nodes : []) {
    const baseNode = baseNodes.get(node?.entityId);
    if (!baseNode) {
      violations.push(`${artifactPath}: company ${formatValue(node?.entityId)} is absent from the base snapshot`);
      continue;
    }
    for (const field of CANONICAL_NODE_FIELDS) {
      if (!isDeepStrictEqual(node?.[field], baseNode?.[field])) {
        violations.push(`${artifactPath}: node ${node.entityId} must preserve canonical ${field}`);
      }
    }
  }

  const audienceLeaderboard = Array.isArray(audienceGraph.leaderboard) ? audienceGraph.leaderboard : [];
  const baseLeaderboard = Array.isArray(baseGraph.leaderboard) ? baseGraph.leaderboard : [];
  const audienceCompanyIds = new Set(audienceLeaderboard.map((row) => row?.companyId));
  const expectedLeaderboard = baseLeaderboard.filter((row) => audienceCompanyIds.has(row?.companyId));
  if (
    !isDeepStrictEqual(
      audienceLeaderboard.map((row) => row?.companyId),
      expectedLeaderboard.map((row) => row?.companyId)
    )
  ) {
    violations.push(`${artifactPath}: leaderboard must preserve canonical base ordering`);
  }
  const baseLeaderboardByCompanyId = new Map(baseLeaderboard.map((row) => [row?.companyId, row]));
  for (const row of audienceLeaderboard) {
    const baseRow = baseLeaderboardByCompanyId.get(row?.companyId);
    if (!baseRow) continue;
    for (const field of CANONICAL_LEADERBOARD_FIELDS) {
      if (!isDeepStrictEqual(row?.[field], baseRow?.[field])) {
        violations.push(`${artifactPath}: leaderboard ${row.companyId} must preserve canonical ${field}`);
      }
    }
  }

  const expectedMomentum = (Array.isArray(baseGraph.fastestGaining) ? baseGraph.fastestGaining : [])
    .filter((row) => audienceCompanyIds.has(row?.companyId));
  if (!isDeepStrictEqual(audienceGraph.fastestGaining, expectedMomentum)) {
    violations.push(`${artifactPath}: fastestGaining must preserve canonical benchmark momentum rows`);
  }
  if (audienceGraph.scoringContext?.evidenceAsOf !== baseGraph.scoringContext?.evidenceAsOf) {
    violations.push(`${artifactPath}: scoringContext.evidenceAsOf must match the base snapshot`);
  }
}

export function collectHistoryArtifactViolations(
  history,
  descriptor,
  { now = new Date(), requireCurrentCentralDay = false } = {}
) {
  const violations = [];
  const artifactPath = descriptor?.path ?? "benchmark history artifact";
  const expectedBatch = descriptor?.batch;
  const validationNow = isValidDate(now) ? now : new Date();
  const latestAllowedTime = validationNow.getTime() + MAX_FUTURE_SKEW_MS;
  const currentDay = centralDayKey(validationNow);
  let versionedDailyEntries = 0;
  let versionedWeeklyEntries = 0;
  let latestRecordedTime = null;

  if (!isRecord(history)) {
    return {
      violations: [`${artifactPath}: expected a JSON object`],
      versionedDailyEntries,
      versionedWeeklyEntries
    };
  }
  if (history.version !== 1) {
    violations.push(`${artifactPath}: version must be 1, received ${formatValue(history.version)}`);
  }
  if (history.batchSlug !== expectedBatch) {
    violations.push(
      `${artifactPath}: batchSlug must be ${expectedBatch}, received ${formatValue(history.batchSlug)}`
    );
  }
  const updatedAtIsValid = isIsoTimestamp(history.updatedAt);
  const updatedAtTime = updatedAtIsValid ? Date.parse(history.updatedAt) : null;
  if (!updatedAtIsValid) {
    violations.push(`${artifactPath}: updatedAt must be an ISO timestamp`);
  } else if (updatedAtTime > latestAllowedTime) {
    violations.push(`${artifactPath}: updatedAt must not be in the future`);
  }

  for (const series of ["daily", "weekly"]) {
    const entries = arrayField(history, series, artifactPath, violations) ?? [];
    let versionedEntries = 0;
    let previousRecordedTime = null;
    let hasCurrentCanonicalEntry = false;
    const canonicalDays = new Set();
    for (const [index, entry] of entries.entries()) {
      const scope = `${artifactPath}: ${series}[${index}]`;
      if (!isRecord(entry)) {
        violations.push(`${scope} must be an object`);
        continue;
      }
      const recordedAtIsValid = isIsoTimestamp(entry.recordedAt);
      const recordedAtTime = recordedAtIsValid ? Date.parse(entry.recordedAt) : null;
      if (!recordedAtIsValid) {
        violations.push(`${scope}.recordedAt must be an ISO timestamp`);
      } else {
        if (recordedAtTime > latestAllowedTime) {
          violations.push(`${scope}.recordedAt must not be in the future`);
        }
        if (previousRecordedTime !== null && recordedAtTime < previousRecordedTime) {
          violations.push(`${scope}.recordedAt must preserve ascending chronological order`);
        }
        previousRecordedTime = recordedAtTime;
        latestRecordedTime = latestRecordedTime === null
          ? recordedAtTime
          : Math.max(latestRecordedTime, recordedAtTime);
      }

      const hasVersion = hasOwn(entry, "scoringModelVersion");
      const hasInputTime = hasOwn(entry, "inputGeneratedAt");
      const isCurrentCanonical =
        hasVersion &&
        hasInputTime &&
        entry.scoringModelVersion === EXPECTED_SCORING_MODEL.version;
      const isSupportedVersioned =
        hasVersion &&
        hasInputTime &&
        SUPPORTED_HISTORY_MODEL_VERSIONS.has(entry.scoringModelVersion);
      validateHistoryCompanies(entry.companies, scope, violations, {
        strictTieRanks: isSupportedVersioned
      });
      if (hasVersion !== hasInputTime) {
        violations.push(
          `${scope} must include scoringModelVersion and inputGeneratedAt together`
        );
        continue;
      }
      if (!hasVersion) continue;

      if (!SUPPORTED_HISTORY_MODEL_VERSIONS.has(entry.scoringModelVersion)) {
        violations.push(
          `${scope}.scoringModelVersion must be ${EXPECTED_SCORING_MODEL.version} or a supported historical version, received ${formatValue(entry.scoringModelVersion)}`
        );
        continue;
      }
      if (!isIsoTimestamp(entry.inputGeneratedAt)) {
        violations.push(`${scope}.inputGeneratedAt must be an ISO timestamp`);
        continue;
      }
      const inputGeneratedAtTime = Date.parse(entry.inputGeneratedAt);
      if (inputGeneratedAtTime > latestAllowedTime) {
        violations.push(`${scope}.inputGeneratedAt must not be in the future`);
      }
      if (recordedAtTime !== null && inputGeneratedAtTime > recordedAtTime) {
        violations.push(`${scope}.inputGeneratedAt must not be later than recordedAt`);
      }

      if (!isCurrentCanonical) {
        continue;
      }

      if (recordedAtTime !== null) {
        const entryDay = centralDayKey(new Date(recordedAtTime));
        if (canonicalDays.has(entryDay)) {
          violations.push(
            `${scope} duplicates ${EXPECTED_SCORING_MODEL.version} observation for Central day ${entryDay}`
          );
        } else {
          canonicalDays.add(entryDay);
        }
        if (series === "daily" && entryDay === currentDay) {
          if (centralDayKey(new Date(inputGeneratedAtTime)) === currentDay) {
            hasCurrentCanonicalEntry = true;
          } else if (requireCurrentCentralDay) {
            violations.push(
              `${scope}.inputGeneratedAt must be on the current ${CENTRAL_TIME_ZONE} day ${currentDay}`
            );
          }
        }
      }
      versionedEntries += 1;
    }

    if (versionedEntries === 0) {
      violations.push(
        `${artifactPath}: ${series} must contain a ${EXPECTED_SCORING_MODEL.id}@${EXPECTED_SCORING_MODEL.version} version-tagged entry`
      );
    }
    if (series === "daily" && requireCurrentCentralDay && !hasCurrentCanonicalEntry) {
      violations.push(
        `${artifactPath}: daily must contain a current ${CENTRAL_TIME_ZONE} day ${currentDay} ${EXPECTED_SCORING_MODEL.id}@${EXPECTED_SCORING_MODEL.version} entry`
      );
    }
    if (series === "daily") versionedDailyEntries = versionedEntries;
    if (series === "weekly") versionedWeeklyEntries = versionedEntries;
  }

  if (
    updatedAtTime !== null &&
    latestRecordedTime !== null &&
    updatedAtTime < latestRecordedTime
  ) {
    violations.push(`${artifactPath}: updatedAt must not precede the latest recorded entry`);
  }

  return { violations, versionedDailyEntries, versionedWeeklyEntries };
}

function validateScoringContext(context, generatedAt, expectedScope, artifactPath, violations) {
  if (!isRecord(context)) {
    violations.push(
      `${artifactPath}: scoringContext must identify ${EXPECTED_SCORING_MODEL.id}@${EXPECTED_SCORING_MODEL.version}`
    );
    return;
  }
  if (context.modelId !== EXPECTED_SCORING_MODEL.id) {
    violations.push(`${artifactPath}: scoringContext.modelId must be ${EXPECTED_SCORING_MODEL.id}`);
  }
  if (context.modelVersion !== EXPECTED_SCORING_MODEL.version) {
    violations.push(`${artifactPath}: scoringContext.modelVersion must be ${EXPECTED_SCORING_MODEL.version}`);
  }
  if (context.modelName !== EXPECTED_SCORING_MODEL.name) {
    violations.push(`${artifactPath}: scoringContext.modelName must be ${EXPECTED_SCORING_MODEL.name}`);
  }
  if (context.scoreScope !== expectedScope) {
    violations.push(
      `${artifactPath}: scoringContext.scoreScope must be ${expectedScope}, received ${formatValue(context.scoreScope)}`
    );
  }
  if (!Array.isArray(context.selectedPlatforms) || context.selectedPlatforms.length !== 0) {
    violations.push(`${artifactPath}: scoringContext.selectedPlatforms must be an empty array`);
  }
  if (!isIsoTimestamp(context.responseBuiltAt)) {
    violations.push(`${artifactPath}: scoringContext.responseBuiltAt must be an ISO timestamp`);
  } else if (isIsoTimestamp(generatedAt) && context.responseBuiltAt !== generatedAt) {
    violations.push(`${artifactPath}: scoringContext.responseBuiltAt must equal generatedAt`);
  }
  if (context.evidenceAsOf !== null && !isIsoTimestamp(context.evidenceAsOf)) {
    violations.push(`${artifactPath}: scoringContext.evidenceAsOf must be null or an ISO timestamp`);
  }
}

function validateNodeScores(node, scope, violations) {
  validateScore(node.score, `${scope} score`, violations, { integer: true });
  validateScore(node.previousScore, `${scope} previousScore`, violations, { integer: true });
  if (!isFiniteNumber(node.scoreDelta) || node.scoreDelta < -100 || node.scoreDelta > 100) {
    violations.push(`${scope} scoreDelta must be a finite number from -100 through 100`);
  } else if (
    isFiniteNumber(node.score) &&
    isFiniteNumber(node.previousScore) &&
    !numbersEqual(node.scoreDelta, node.score - node.previousScore)
  ) {
    violations.push(`${scope} scoreDelta must equal score - previousScore`);
  }
  validateScoreRecord(node.platformScores, `${scope} platformScores`, violations);
}

function validateScoreBreakdown(breakdown, nodeScore, scope, violations) {
  if (!isRecord(breakdown)) {
    violations.push(
      `${scope} is missing a complete ${EXPECTED_SCORING_MODEL.id}@${EXPECTED_SCORING_MODEL.version} scoreBreakdown`
    );
    return null;
  }
  if (breakdown.modelId !== EXPECTED_SCORING_MODEL.id) {
    violations.push(`${scope} scoreBreakdown.modelId must be ${EXPECTED_SCORING_MODEL.id}`);
  }
  if (breakdown.modelVersion !== EXPECTED_SCORING_MODEL.version) {
    violations.push(`${scope} scoreBreakdown.modelVersion must be ${EXPECTED_SCORING_MODEL.version}`);
  }
  if (breakdown.modelName !== EXPECTED_SCORING_MODEL.name) {
    violations.push(`${scope} scoreBreakdown.modelName must be ${EXPECTED_SCORING_MODEL.name}`);
  }

  for (const field of ["totalScore", "absoluteScore"]) {
    validateScore(breakdown[field], `${scope} scoreBreakdown.${field}`, violations, {
      integer: true
    });
  }
  validateScore(
    breakdown.weightedAvailableScore,
    `${scope} scoreBreakdown.weightedAvailableScore`,
    violations
  );
  if (!numbersEqual(breakdown.totalScore, nodeScore)) {
    violations.push(`${scope} scoreBreakdown.totalScore must equal node score`);
  }
  if (!isFiniteNumber(breakdown.coverageFactor) || breakdown.coverageFactor < 0) {
    violations.push(`${scope} scoreBreakdown.coverageFactor must be finite and non-negative`);
  }
  if (
    !Number.isInteger(breakdown.platformsWithEvidence) ||
    breakdown.platformsWithEvidence < 0 ||
    breakdown.platformsWithEvidence > SUPPORTED_PLATFORM_COUNT
  ) {
    violations.push(
      `${scope} scoreBreakdown.platformsWithEvidence must be an integer from 0 through ${SUPPORTED_PLATFORM_COUNT}`
    );
  }
  if (breakdown.totalSupportedPlatforms !== SUPPORTED_PLATFORM_COUNT) {
    violations.push(
      `${scope} scoreBreakdown.totalSupportedPlatforms must be ${SUPPORTED_PLATFORM_COUNT}`
    );
  }

  const platformScores = validateScoreRecord(
    breakdown.platformScores,
    `${scope} scoreBreakdown.platformScores`,
    violations,
    { weightedOnly: true }
  );
  const weightedPlatforms = validateWeightedPlatforms(
    breakdown.weightedPlatforms,
    platformScores,
    scope,
    violations
  );
  if (
    Number.isInteger(breakdown.platformsWithEvidence) &&
    breakdown.platformsWithEvidence !== weightedPlatforms.length
  ) {
    violations.push(
      `${scope} scoreBreakdown.platformsWithEvidence must match weightedPlatforms length`
    );
  }
  if (platformScores && Object.keys(platformScores).length !== weightedPlatforms.length) {
    violations.push(
      `${scope} scoreBreakdown.platformScores and weightedPlatforms must cover the same platforms`
    );
  }
  const contributionTotal = weightedPlatforms.reduce(
    (sum, row) =>
      sum +
      (isFiniteNumber(row.score) && isFiniteNumber(row.configuredWeight)
        ? row.score * row.configuredWeight
        : 0),
    0
  );
  const configuredCoverage = weightedPlatforms.reduce(
    (sum, row) => sum + (isFiniteNumber(row.configuredWeight) ? row.configuredWeight : 0),
    0
  );
  const expectedAbsoluteScore = contributionTotal > 0 ? Math.max(1, Math.round(contributionTotal)) : 0;
  if (!numbersEqual(breakdown.absoluteScore, expectedAbsoluteScore)) {
    violations.push(`${scope} scoreBreakdown.absoluteScore must equal the rounded fixed contribution total`);
  }
  if (
    breakdown.calibration?.method === "none" &&
    !numbersEqual(breakdown.totalScore, breakdown.absoluteScore)
  ) {
    violations.push(`${scope} scoreBreakdown.totalScore must equal absoluteScore without a global benchmark`);
  }
  if (!numbersEqual(breakdown.coverageFactor, configuredCoverage)) {
    violations.push(`${scope} scoreBreakdown.coverageFactor must equal present configured platform weight`);
  }
  const expectedWeightedAvailableScore = configuredCoverage > 0
    ? contributionTotal / configuredCoverage
    : 0;
  if (Math.abs(breakdown.weightedAvailableScore - expectedWeightedAvailableScore) > 0.011) {
    violations.push(`${scope} scoreBreakdown.weightedAvailableScore must be the present-platform weighted average`);
  }

  if (!isRecord(breakdown.signalFamilyScores)) {
    violations.push(`${scope} scoreBreakdown.signalFamilyScores must be an object`);
  } else {
    for (const family of SIGNAL_FAMILIES) {
      validateScore(
        breakdown.signalFamilyScores[family],
        `${scope} scoreBreakdown.signalFamilyScores.${family}`,
        violations,
        { integer: true }
      );
    }
  }
  validateConfidence(breakdown.confidence, scope, violations);
  validateCalibration(
    breakdown.calibration,
    breakdown.totalScore,
    breakdown.absoluteScore,
    scope,
    violations
  );

  if (!Array.isArray(breakdown.limitations) || !breakdown.limitations.every(isString)) {
    violations.push(`${scope} scoreBreakdown.limitations must be an array of strings`);
  }
  if (breakdown.evidenceAsOf !== null && !isIsoTimestamp(breakdown.evidenceAsOf)) {
    violations.push(`${scope} scoreBreakdown.evidenceAsOf must be null or an ISO timestamp`);
  }
  if (typeof breakdown.explanation !== "string" || !breakdown.explanation.trim()) {
    violations.push(`${scope} scoreBreakdown.explanation must be a non-empty string`);
  }

  return { ...breakdown, weightedPlatforms };
}

function validateWeightedPlatforms(value, platformScores, scope, violations) {
  if (!Array.isArray(value)) {
    violations.push(`${scope} scoreBreakdown.weightedPlatforms must be an array`);
    return [];
  }
  const seen = new Set();
  for (const [index, row] of value.entries()) {
    const rowScope = `${scope} scoreBreakdown.weightedPlatforms[${index}]`;
    if (!isRecord(row)) {
      violations.push(`${rowScope} must be an object`);
      continue;
    }
    if (!hasOwn(PLATFORM_WEIGHTS, row.platform)) {
      violations.push(`${rowScope}.platform must be a canonically weighted platform`);
    } else {
      if (seen.has(row.platform)) {
        violations.push(`${scope} scoreBreakdown.weightedPlatforms duplicates ${row.platform}`);
      }
      seen.add(row.platform);
      if (!numbersEqual(row.configuredWeight, PLATFORM_WEIGHTS[row.platform])) {
        violations.push(
          `${rowScope}.configuredWeight must be ${PLATFORM_WEIGHTS[row.platform]}`
        );
      }
      if (platformScores && !numbersEqual(row.score, platformScores[row.platform])) {
        violations.push(`${rowScope}.score must match scoreBreakdown.platformScores`);
      }
      if (!numbersEqual(row.appliedWeight, row.configuredWeight)) {
        violations.push(`${rowScope}.appliedWeight must equal configuredWeight`);
      }
      const expectedContribution = Math.round(row.score * row.configuredWeight * 100) / 100;
      if (!numbersEqual(row.contribution, expectedContribution)) {
        violations.push(`${rowScope}.contribution must equal score multiplied by configuredWeight`);
      }
    }
    validateScore(row.score, `${rowScope}.score`, violations, { integer: true });
    validateUnitInterval(row.appliedWeight, `${rowScope}.appliedWeight`, violations);
    validateScore(row.contribution, `${rowScope}.contribution`, violations);
    if (!isPositiveInteger(row.evidenceCount)) {
      violations.push(`${rowScope}.evidenceCount must be a positive integer`);
    }
  }
  return value;
}

function validateConfidence(confidence, scope, violations) {
  if (!isRecord(confidence)) {
    violations.push(`${scope} scoreBreakdown.confidence must be an object`);
    return;
  }
  if (!["low", "medium", "high"].includes(confidence.level)) {
    violations.push(`${scope} scoreBreakdown.confidence.level is invalid`);
  }
  validateUnitInterval(confidence.value, `${scope} scoreBreakdown.confidence.value`, violations);
  if (!Array.isArray(confidence.reasons) || !confidence.reasons.every(isString)) {
    violations.push(`${scope} scoreBreakdown.confidence.reasons must be an array of strings`);
  }
  for (const field of ["scoredEvidenceCount", "datedEvidenceCount", "verifiedLinkCount"]) {
    if (!isNonNegativeInteger(confidence[field])) {
      violations.push(`${scope} scoreBreakdown.confidence.${field} must be a non-negative integer`);
    }
  }
  if (
    isNonNegativeInteger(confidence.scoredEvidenceCount) &&
    isNonNegativeInteger(confidence.datedEvidenceCount) &&
    confidence.datedEvidenceCount > confidence.scoredEvidenceCount
  ) {
    violations.push(`${scope} scoreBreakdown.confidence.datedEvidenceCount exceeds scoredEvidenceCount`);
  }
  if (
    isNonNegativeInteger(confidence.scoredEvidenceCount) &&
    isNonNegativeInteger(confidence.verifiedLinkCount) &&
    confidence.verifiedLinkCount > confidence.scoredEvidenceCount
  ) {
    violations.push(`${scope} scoreBreakdown.confidence.verifiedLinkCount exceeds scoredEvidenceCount`);
  }
}

function validateCalibration(calibration, totalScore, absoluteScore, scope, violations) {
  if (!isRecord(calibration)) {
    violations.push(`${scope} scoreBreakdown.calibration must be an object`);
    return;
  }
  if (calibration.method !== "global_best_ratio") {
    violations.push(
      `${scope} scoreBreakdown.calibration.method must be global_best_ratio for the 4.2 scoring model`
    );
  }
  if (!isNonNegativeInteger(calibration.cohortSize)) {
    violations.push(`${scope} scoreBreakdown.calibration.cohortSize must be a non-negative integer`);
  }
  if (calibration.percentile !== null) {
    violations.push(`${scope} scoreBreakdown.calibration.percentile must be null`);
  }
  if (!numbersEqual(calibration.inputScore, absoluteScore)) {
    violations.push(`${scope} scoreBreakdown.calibration.inputScore must equal absoluteScore`);
  }
  if (calibration.method === "global_best_ratio") {
    validateScore(
      calibration.benchmarkScore,
      `${scope} scoreBreakdown.calibration.benchmarkScore`,
      violations
    );
    if (!isFiniteNumber(calibration.scaleFactor) || calibration.scaleFactor < 0) {
      violations.push(`${scope} scoreBreakdown.calibration.scaleFactor must be finite and non-negative`);
    }
    if (calibration.benchmarkScope !== "all_supported_batches") {
      violations.push(`${scope} scoreBreakdown.calibration.benchmarkScope must be all_supported_batches`);
    }
    if (calibration.benchmarkPopulation !== "current_company_snapshot") {
      violations.push(`${scope} scoreBreakdown.calibration.benchmarkPopulation must be current_company_snapshot`);
    }
    if (isFiniteNumber(calibration.benchmarkScore) && isFiniteNumber(calibration.scaleFactor)) {
      const expectedFactor = calibration.benchmarkScore > 0
        ? 100 / calibration.benchmarkScore
        : 0;
      if (Math.abs(calibration.scaleFactor - expectedFactor) > 1e-9) {
        violations.push(`${scope} scoreBreakdown.calibration.scaleFactor must equal 100 / benchmarkScore`);
      }
      const expectedTotal = calibration.benchmarkScore > 0 && absoluteScore > 0
        ? Math.max(1, Math.min(100, Math.round((absoluteScore / calibration.benchmarkScore) * 100)))
        : 0;
      if (!numbersEqual(totalScore, expectedTotal)) {
        violations.push(`${scope} scoreBreakdown.totalScore must equal global benchmark score ${expectedTotal}`);
      }
      if ((calibration.benchmarkScore > 0) !== (calibration.cohortSize > 0)) {
        violations.push(`${scope} scoreBreakdown.calibration.cohortSize must match benchmark availability`);
      }
    }
  }
}

function validateCalibrationModes(breakdowns, expectedAudience, artifactPath, violations) {
  const positiveCohortSize = breakdowns.filter(
    ({ breakdown }) => isFiniteNumber(breakdown.absoluteScore) && breakdown.absoluteScore > 0
  ).length;

  const globalSignatures = new Set();
  for (const { scope, breakdown } of breakdowns) {
    const calibration = breakdown.calibration;
    if (!isRecord(calibration)) continue;
    if (expectedAudience !== "off") {
      continue;
    }

    if (calibration.method === "none") {
      if (calibration.cohortSize !== positiveCohortSize) {
        violations.push(
          `${scope} calibration.cohortSize must be ${positiveCohortSize} for ${artifactPath}`
        );
      }
    } else if (calibration.method === "global_best_ratio") {
      if (calibration.cohortSize < positiveCohortSize) {
        violations.push(`${scope} global calibration.cohortSize cannot be smaller than the visible batch`);
      }
      globalSignatures.add(JSON.stringify({
        cohortSize: calibration.cohortSize,
        benchmarkScore: calibration.benchmarkScore,
        scaleFactor: calibration.scaleFactor,
        benchmarkScope: calibration.benchmarkScope,
        benchmarkPopulation: calibration.benchmarkPopulation
      }));
    }
    if (calibration.percentile !== null) {
      violations.push(`${scope} score calibration percentile must be null`);
    }
  }
  if (globalSignatures.size > 1) {
    violations.push(`${artifactPath} nodes must share exactly one global company benchmark factor`);
  }
}

function validateLeaderboard(
  rows,
  nodesByCompanyId,
  artifactPath,
  violations,
  { allowCanonicalRankGaps = false } = {}
) {
  const seen = new Set();
  let previousScore = Infinity;
  let previousRank = null;
  let currentRank = 0;

  for (const [index, row] of rows.entries()) {
    const scope = `${artifactPath}: leaderboard[${index}]`;
    if (!isRecord(row)) {
      violations.push(`${scope} must be an object`);
      continue;
    }
    if (typeof row.companyId !== "string" || !row.companyId) {
      violations.push(`${scope}.companyId must be a non-empty string`);
    } else if (seen.has(row.companyId)) {
      violations.push(`${scope} duplicates companyId ${row.companyId}`);
    }
    seen.add(row.companyId);
    if (typeof row.companyName !== "string" || !row.companyName) {
      violations.push(`${scope}.companyName must be a non-empty string`);
    }
    validateScore(row.score, `${scope}.score`, violations, { integer: true });
    if (!isPositiveInteger(row.rank)) {
      violations.push(`${scope}.rank must be a positive integer`);
    }
    if (isFiniteNumber(row.score)) {
      if (row.score > previousScore) {
        violations.push(`${artifactPath}: leaderboard must be sorted by descending score`);
      }
      if (allowCanonicalRankGaps) {
        if (
          previousRank !== null &&
          ((row.score === previousScore && row.rank !== previousRank) ||
            (row.score !== previousScore && row.rank <= previousRank))
        ) {
          violations.push(`${scope}.rank must preserve canonical tied descending rank order`);
        }
      } else {
        if (index === 0 || row.score !== previousScore) currentRank = index + 1;
        if (row.rank !== currentRank) {
          violations.push(`${scope}.rank must be ${currentRank} for tied descending scores`);
        }
      }
      previousScore = row.score;
      if (isPositiveInteger(row.rank)) previousRank = row.rank;
    }

    const node = nodesByCompanyId.get(row.companyId);
    if (!node) {
      violations.push(`${scope} references missing node ${row.companyId}`);
    } else if (!numbersEqual(row.score, node.score)) {
      violations.push(`${scope}.score must match node score for ${row.companyId}`);
    }
  }

  for (const companyId of nodesByCompanyId.keys()) {
    if (!seen.has(companyId)) {
      violations.push(`${artifactPath}: node ${companyId} is missing from leaderboard`);
    }
  }
}

function validateEvidence(evidence, nodes, expectedAudience, artifactPath, violations) {
  const evidenceIds = new Set();
  const nativeIdentities = new Map();

  for (const [index, item] of evidence.entries()) {
    const scope = `${artifactPath}: evidence[${index}]`;
    if (!isRecord(item)) {
      violations.push(`${scope} must be an object`);
      continue;
    }
    if (typeof item.id !== "string" || !item.id) {
      violations.push(`${scope}.id must be a non-empty string`);
    } else if (evidenceIds.has(item.id)) {
      violations.push(`${scope} duplicates evidence id ${item.id}`);
    }
    evidenceIds.add(item.id);

    validateScore(item.contributionScore, `${scope}.contributionScore`, violations);
    if (item.normalizedScore !== undefined) {
      validateScore(item.normalizedScore, `${scope}.normalizedScore`, violations);
    }
    if (
      item.rawEngagement !== undefined &&
      (!isFiniteNumber(item.rawEngagement) || item.rawEngagement < 0)
    ) {
      violations.push(`${scope}.rawEngagement must be finite and non-negative`);
    }
    if (
      expectedAudience !== "off" &&
      item.topVoice?.audienceId !== expectedAudience
    ) {
      violations.push(`${scope}.topVoice.audienceId must be ${expectedAudience}`);
    }
    if (
      isRecord(item.topVoice) &&
      isFiniteNumber(item.topVoice.originalContributionScore) &&
      !numbersEqual(item.contributionScore, item.topVoice.originalContributionScore)
    ) {
      violations.push(`${scope}.contributionScore must not apply a Top Voice member weight`);
    }

    validateGithubRepositoryPublication(item, scope, violations);

    const identities = evidenceNativeIdentities(item);
    if (identities.conflict) {
      violations.push(
        `${scope} has conflicting ${item.platform} native identities ${identities.urlId} and ${identities.explicitId}`
      );
    }
    if (item.contributionScore > 0 && !identities.urlId) {
      violations.push(`${scope} has a positive score without a platform-native sourceUrl identity`);
    }
    const identity = identities.urlId ?? identities.explicitId;
    if (identity) {
      // Display evidence is entity-scoped: a single list/recommendation post may
      // legitimately support every company it explicitly names. Physical dedupe
      // still happens inside each company score rollup.
      const key = `${item.entityId ?? "unknown-entity"}:${item.platform}:${identity}`;
      const existing = nativeIdentities.get(key);
      if (existing) {
        violations.push(
          `${artifactPath}: duplicate native identity ${key} on evidence ${existing} and ${item.id ?? `index ${index}`}`
        );
      } else {
        nativeIdentities.set(key, item.id ?? `index ${index}`);
      }
    }
  }

  const referenced = new Set();
  for (const node of nodes) {
    if (!Array.isArray(node?.evidenceIds)) continue;
    for (const evidenceId of node.evidenceIds) {
      referenced.add(evidenceId);
      if (!evidenceIds.has(evidenceId)) {
        violations.push(
          `${artifactPath}: node ${node.entityId ?? node.id ?? "unknown"} references missing evidence ${evidenceId}`
        );
      }
    }
  }
  for (const evidenceId of evidenceIds) {
    if (!referenced.has(evidenceId)) {
      violations.push(`${artifactPath}: evidence ${evidenceId} is not referenced by a node`);
    }
  }
}

function validateGithubRepositoryPublication(item, scope, violations) {
  if (
    item.platform !== "github" ||
    nativeEvidenceIdentityFromUrl("github", item.sourceUrl) === null
  ) {
    return;
  }

  const provenance = githubRepositoryPublicationProvenance(item);
  const postedAtMs = timestampMs(item.postedAt);

  if (
    item.publishedAtPrecision === "exact" &&
    provenance.createdAt !== null &&
    postedAtMs !== provenance.createdAt.timestamp
  ) {
    const matchingActivity = provenance.activityTimestamps.find(
      ({ timestamp }) => timestamp === postedAtMs
    );
    violations.push(
      `${scope} GitHub repository publication must use native createdAt ${formatValue(provenance.createdAt.value)}; ` +
        `exact postedAt ${formatValue(item.postedAt)}` +
        `${matchingActivity ? ` matches ${matchingActivity.label} instead` : " differs from native creation"}`
    );
    return;
  }

  if (
    provenance.createdAt === null &&
    provenance.activityDerived &&
    item.publishedAtPrecision !== "unknown"
  ) {
    violations.push(
      `${scope} GitHub repository publication derived from ${provenance.activityLabels.join(", ")} ` +
        `has no auditable native createdAt; publishedAtPrecision must be unknown`
    );
  }
}

function githubRepositoryPublicationProvenance(item) {
  const raw = parseJsonRecord(item.rawVisibleText);
  const sourceProvenance = recordAt(raw, "sourceProvenance");
  const sourceProvenanceUrl = nonEmptyString(sourceProvenance?.sourceUrl);
  const commitDerived =
    sourceProvenance?.kind === "github_commit" ||
    (sourceProvenanceUrl !== null && /\/commit\/[a-f0-9]{7,64}(?:\/|$)/i.test(sourceProvenanceUrl));
  const timestampRecords = [
    recordAt(item, "publicationProvenance"),
    recordAt(raw, "repositoryTimestamps"),
    recordAt(recordAt(raw, "repo"), "repositoryTimestamps"),
    recordAt(raw, "repo"),
    recordAt(raw, "repository"),
    recordAt(recordAt(raw, "canonicalRepository"), "repositoryTimestamps"),
    recordAt(raw, "canonicalRepository")
  ].filter(Boolean);
  if (!commitDerived) {
    const postRecord = recordAt(raw, "post");
    if (postRecord) timestampRecords.push(postRecord);
  }

  const createdAt = firstTimestamp(timestampRecords, [
    "createdAt",
    "created_at",
    "repositoryCreatedAt",
    "repository_created_at"
  ]);
  const activityTimestamps = [];
  for (const record of timestampRecords) {
    appendTimestamp(activityTimestamps, record, "updatedAt", "updatedAt");
    appendTimestamp(activityTimestamps, record, "updated_at", "updatedAt");
    appendTimestamp(activityTimestamps, record, "pushedAt", "pushedAt");
    appendTimestamp(activityTimestamps, record, "pushed_at", "pushedAt");
    appendTimestamp(activityTimestamps, record, "observedAt", "observedAt");
    appendTimestamp(activityTimestamps, record, "observed_at", "observedAt");
  }
  for (const field of GITHUB_REPOSITORY_ACTIVITY_FIELDS) {
    appendTimestamp(activityTimestamps, item, field, field);
  }

  const postedAtMs = timestampMs(item.postedAt);
  const matchingActivityLabels = activityTimestamps
    .filter(({ timestamp }) => timestamp === postedAtMs)
    .map(({ label }) => label);
  const activityLabels = [...new Set([
    ...(commitDerived ? ["commit provenance"] : []),
    ...matchingActivityLabels,
    ...(createdAt === null && timestampRecords.length > 0
      ? activityTimestamps.map(({ label }) => label)
      : [])
  ])];

  return {
    createdAt,
    activityTimestamps,
    activityDerived: activityLabels.length > 0,
    activityLabels
  };
}

function parseJsonRecord(value) {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function recordAt(record, key) {
  return isRecord(record?.[key]) ? record[key] : null;
}

function firstTimestamp(records, keys) {
  for (const record of records) {
    for (const key of keys) {
      const value = nonEmptyString(record?.[key]);
      const timestamp = timestampMs(value);
      if (value !== null && timestamp !== null) return { value, timestamp };
    }
  }
  return null;
}

function appendTimestamp(target, record, key, label) {
  const value = nonEmptyString(record?.[key]);
  const timestamp = timestampMs(value);
  if (value === null || timestamp === null) return;
  if (target.some((entry) => entry.label === label && entry.timestamp === timestamp)) return;
  target.push({ label, value, timestamp });
}

function timestampMs(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function validateHistoryCompanies(companies, scope, violations, { strictTieRanks = false } = {}) {
  if (!Array.isArray(companies) || companies.length === 0) {
    violations.push(`${scope}.companies must be a non-empty array`);
    return;
  }
  const seen = new Set();
  let previousScore = Infinity;
  let expectedRank = 0;
  for (const [index, company] of companies.entries()) {
    const rowScope = `${scope}.companies[${index}]`;
    if (!isRecord(company)) {
      violations.push(`${rowScope} must be an object`);
      continue;
    }
    if (typeof company.companyId !== "string" || !company.companyId) {
      violations.push(`${rowScope}.companyId must be a non-empty string`);
    } else if (seen.has(company.companyId)) {
      violations.push(`${rowScope} duplicates companyId ${company.companyId}`);
    }
    seen.add(company.companyId);
    if (typeof company.companyName !== "string" || !company.companyName) {
      violations.push(`${rowScope}.companyName must be a non-empty string`);
    }
    validateScore(company.score, `${rowScope}.score`, violations, { integer: true });
    if (!isPositiveInteger(company.rank)) {
      violations.push(`${rowScope}.rank must be a positive integer`);
    }
    if (isFiniteNumber(company.score)) {
      if (company.score > previousScore) {
        violations.push(`${scope}.companies must be sorted by descending score`);
      }
      if (index === 0 || company.score !== previousScore) expectedRank = index + 1;
      if (strictTieRanks && company.rank !== expectedRank) {
        violations.push(`${rowScope}.rank must be ${expectedRank} for tied descending scores`);
      }
      previousScore = company.score;
    }
  }
}

function validateScoreRecord(value, scope, violations, { weightedOnly = false } = {}) {
  if (!isRecord(value)) {
    violations.push(`${scope} must be an object`);
    return null;
  }
  for (const [platform, score] of Object.entries(value)) {
    if (weightedOnly && !hasOwn(PLATFORM_WEIGHTS, platform)) {
      violations.push(`${scope}.${platform} is not a canonically weighted platform`);
    }
    validateScore(score, `${scope}.${platform}`, violations, { integer: true });
  }
  return value;
}

function validateScore(value, scope, violations, { integer = false } = {}) {
  if (!isFiniteNumber(value) || value < 0 || value > 100 || (integer && !Number.isInteger(value))) {
    violations.push(
      `${scope} must be ${integer ? "an integer" : "a finite number"} from 0 through 100`
    );
  }
}

function validateUnitInterval(value, scope, violations) {
  if (!isFiniteNumber(value) || value < 0 || value > 1) {
    violations.push(`${scope} must be a finite number from 0 through 1`);
  }
}

function validateStringIdArray(value, scope, violations) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item)) {
    violations.push(`${scope} must be an array of non-empty strings`);
    return;
  }
  if (new Set(value).size !== value.length) {
    violations.push(`${scope} must not contain duplicates`);
  }
}

function evidenceNativeIdentities(item) {
  const urlId = nativeEvidenceIdentityFromUrl(item.platform, item.sourceUrl);
  const explicitId = platformPostIdIdentity(item.platform, item.platformPostId);
  return {
    urlId,
    explicitId,
    conflict: Boolean(urlId && explicitId && !identitiesMatch(item.platform, urlId, explicitId))
  };
}

export function nativeEvidenceIdentityFromUrl(platform, rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = normalizedHost(url);
    const pathname = normalizedPath(url);

    if (platform === "x") {
      if (!hostIs(host, "x.com", "twitter.com", "mobile.twitter.com")) return null;
      return (
        pathname.match(
          /^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/web\/status)\/(\d+)(?:\/(?:photo|video)\/\d+)?$/i
        )?.[1] ?? null
      );
    }
    if (platform === "tiktok") {
      if (!hostIs(host, "tiktok.com", "m.tiktok.com")) return null;
      return pathname.match(/^\/@[A-Za-z0-9._-]+\/video\/(\d+)$/i)?.[1] ?? null;
    }
    if (platform === "bluesky") {
      if (host !== "bsky.app") return null;
      const match = pathname.match(/^\/profile\/([^/]+)\/post\/([^/]+)$/i);
      return match ? blueskyPostIdentity(match[1], match[2]) : null;
    }
    if (platform === "instagram") {
      if (!hostIs(host, "instagram.com", "m.instagram.com")) return null;
      return pathname.match(/^\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)$/i)?.[1] ?? null;
    }
    if (platform === "linkedin") {
      if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
      const feedId = pathname.match(/^\/feed\/update\/urn:li:activity:(\d+)$/i)?.[1];
      if (feedId) return feedId;
      const postSegment = pathname.match(/^\/posts\/([^/]+)$/i)?.[1];
      return postSegment?.match(/activity[-:](\d+)/i)?.[1] ?? null;
    }
    if (platform === "youtube") {
      if (host === "youtu.be") return pathname.match(/^\/([A-Za-z0-9_-]+)$/)?.[1] ?? null;
      if (!hostIs(host, "youtube.com", "m.youtube.com")) return null;
      if (pathname === "/watch") return validObjectId(url.searchParams.get("v"));
      return pathname.match(/^\/(?:shorts|live)\/([A-Za-z0-9_-]+)$/i)?.[1] ?? null;
    }
    if (platform === "reddit") {
      if (host === "redd.it") {
        return pathname.match(/^\/([A-Za-z0-9]+)$/)?.[1]?.toLowerCase() ?? null;
      }
      if (
        !hostIs(
          host,
          "reddit.com",
          "old.reddit.com",
          "new.reddit.com",
          "np.reddit.com",
          "m.reddit.com"
        )
      ) {
        return null;
      }
      return redditPostIdFromPath(pathname);
    }
    if (platform === "hacker_news") {
      if (host !== "news.ycombinator.com" || pathname !== "/item") return null;
      const id = url.searchParams.get("id");
      return id && /^\d+$/.test(id) ? id : null;
    }
    if (platform === "bilibili") {
      if (!hostIs(host, "bilibili.com", "m.bilibili.com")) return null;
      return pathname.match(/^\/video\/([A-Za-z0-9]+)$/i)?.[1] ?? null;
    }
    if (platform === "github") {
      if (host !== "github.com") return null;
      const parts = pathname.split("/").filter(Boolean);
      if (parts.length !== 2) return null;
      const [owner, repo] = parts;
      if (
        !GITHUB_OWNER.test(owner) ||
        !GITHUB_REPO.test(repo) ||
        repo === "." ||
        repo === ".." ||
        GITHUB_RESERVED_OWNERS.has(owner.toLowerCase())
      ) {
        return null;
      }
      return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    }
    if (platform === "product_hunt") {
      if (host !== "producthunt.com") return null;
      const direct = pathname.match(/^\/(posts)\/([A-Za-z0-9][A-Za-z0-9_-]*)$/i);
      if (direct) return `${direct[1].toLowerCase()}/${direct[2].toLowerCase()}`;
      const forum = pathname.match(
        /^\/(p)\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\/([A-Za-z0-9][A-Za-z0-9_-]*))?$/i
      );
      if (forum) return [forum[1], forum[2], forum[3]].filter(Boolean).join("/").toLowerCase();
      const launch = pathname.match(
        /^\/(products)\/([A-Za-z0-9][A-Za-z0-9_-]*)\/(launches)\/([A-Za-z0-9][A-Za-z0-9_-]*)$/i
      );
      return launch ? launch.slice(1).join("/").toLowerCase() : null;
    }
    return null;
  } catch {
    return null;
  }
}

function platformPostIdIdentity(platform, rawValue) {
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return nativeEvidenceIdentityFromUrl(platform, value) ?? value;
  if (platform === "x") return value.match(/(?:^|\/)status\/(\d+)/i)?.[1] ?? value;
  if (platform === "tiktok") return value.match(/(?:^|\/)video\/(\d+)/i)?.[1] ?? value;
  if (platform === "bluesky") {
    const atUri = value.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/i);
    if (atUri) return blueskyPostIdentity(atUri[1], atUri[2]);
    const webPath = value.match(/^(?:profile\/)?([^/]+)\/post\/([^/]+)$/i);
    if (webPath) return blueskyPostIdentity(webPath[1], webPath[2]);
    return BLUESKY_RECORD_KEY.test(value) ? value : null;
  }
  if (platform === "instagram") {
    return (
      value.match(/^(?:\/)?(?:p|reel|tv)[/:]([A-Za-z0-9_-]+)/i)?.[1] ??
      validObjectId(value) ??
      value
    );
  }
  if (platform === "linkedin") return value.match(/activity[-:](\d+)/i)?.[1] ?? value;
  if (platform === "youtube") {
    return value.match(/^(?:shorts|live)\/([A-Za-z0-9_-]+)$/i)?.[1] ?? validObjectId(value) ?? value;
  }
  if (platform === "reddit") {
    const id = value.match(/(?:^|\/)comments\/([A-Za-z0-9]+)/i)?.[1] ?? value.replace(/^t3_/i, "");
    return REDDIT_ID.test(id) ? id.toLowerCase() : value;
  }
  if (platform === "hacker_news") return value;
  if (platform === "bilibili") {
    return value.match(/(?:^|\/)video\/([A-Za-z0-9]+)/i)?.[1] ?? value;
  }
  if (platform === "github") {
    const parts = value.replace(/^\/+|\/+$/g, "").split("/");
    return parts.length === 2 && GITHUB_OWNER.test(parts[0]) && GITHUB_REPO.test(parts[1])
      ? `${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`
      : value.toLowerCase();
  }
  if (platform === "product_hunt") {
    const normalized = value.replace(/^\/+|\/+$/g, "").toLowerCase();
    return /^(?:posts\/[a-z0-9][a-z0-9_-]*|p\/[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)?|products\/[a-z0-9][a-z0-9_-]*\/launches\/[a-z0-9][a-z0-9_-]*)$/.test(
      normalized
    ) || /^[a-z0-9][a-z0-9_-]*$/.test(normalized)
      ? normalized
      : `invalid:${normalized}`;
  }
  return null;
}

function identitiesMatch(platform, urlId, explicitId) {
  if (urlId === explicitId) return true;
  if (platform === "bluesky") return urlId.endsWith(`/post/${explicitId}`);
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

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validCompanySlug(value) {
  const slug = nonEmptyString(value);
  return slug && YC_COMPANY_SLUG.test(slug) ? slug : null;
}

function ycCompanySlugFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (normalizedHost(url) !== "ycombinator.com") return null;
    return validCompanySlug(normalizedPath(url).match(/^\/companies\/([^/]+)$/)?.[1]);
  } catch {
    return null;
  }
}

function appendSetCensusViolation(
  violations,
  artifactPath,
  label,
  expectedValues,
  observedValues
) {
  const missing = [...expectedValues].filter((value) => !observedValues.has(value)).sort();
  const unexpected = [...observedValues].filter((value) => !expectedValues.has(value)).sort();
  if (missing.length === 0 && unexpected.length === 0) return;
  violations.push(
    `${artifactPath}: ${label} census must match the S26 catalog` +
      `${missing.length ? `; missing ${missing.join(", ")}` : ""}` +
      `${unexpected.length ? `; unexpected ${unexpected.join(", ")}` : ""}`
  );
}

function graphArtifact(batch, filename, audience = "off") {
  return Object.freeze({
    batch,
    audience,
    path: path.posix.join("public", "graph", filename)
  });
}

function historyArtifact(batch, filename) {
  return Object.freeze({
    batch,
    path: path.posix.join("outputs", "benchmarks", filename)
  });
}

async function readJsonArtifact(rootDir, relativePath, violations) {
  let raw;
  try {
    raw = await readFile(path.join(rootDir, relativePath), "utf8");
  } catch (error) {
    violations.push(
      `${relativePath}: could not be read${error?.code ? ` (${error.code})` : ""}`
    );
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    violations.push(`${relativePath}: invalid JSON (${error.message})`);
    return null;
  }
}

function arrayField(object, field, artifactPath, violations) {
  if (!Array.isArray(object[field])) {
    violations.push(`${artifactPath}: ${field} must be an array`);
    return null;
  }
  return object[field];
}

function sameNumericRecord(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && numbersEqual(left[key], right[key]))
  );
}

function numbersEqual(left, right) {
  return isFiniteNumber(left) && isFiniteNumber(right) && Math.abs(left - right) <= SCORE_EPSILON;
}

function normalizedHost(url) {
  return url.hostname.replace(/^www\./i, "").toLowerCase();
}

function normalizedPath(url) {
  return url.pathname.replace(/\/+$/, "") || "/";
}

function hostIs(host, ...allowed) {
  return allowed.includes(host);
}

function validObjectId(value) {
  return value && OBJECT_ID.test(value) ? value : null;
}

function redditPostIdFromPath(pathname) {
  const match = pathname.match(
    /^\/(?:r\/[A-Za-z0-9_]+\/)?comments\/([A-Za-z0-9]+)(?:\/[A-Za-z0-9_%.-]+)?(?:\/[A-Za-z0-9]+)?$/i
  );
  return match?.[1]?.toLowerCase() ?? null;
}

function blueskyPostIdentity(actor, recordKey) {
  if (!actor || !BLUESKY_RECORD_KEY.test(recordKey)) return null;
  return `${actor.toLowerCase()}/post/${recordKey}`;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isValidDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function centralDayKey(date) {
  if (!isValidDate(date)) return null;
  const parts = Object.fromEntries(
    CENTRAL_DAY_FORMATTER.formatToParts(date).map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isCurrentCentralDay(value, now) {
  if (!isIsoTimestamp(value)) return false;
  return centralDayKey(new Date(value)) === centralDayKey(now);
}

function isIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isString(value) {
  return typeof value === "string";
}

function formatValue(value) {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function formatValidationFailure(violations) {
  const limit = 60;
  const displayed = violations.slice(0, limit).map((violation) => `- ${violation}`);
  if (violations.length > limit) {
    displayed.push(`- ... ${violations.length - limit} additional violation(s)`);
  }
  return `Public artifact validation failed with ${violations.length} violation(s):\n${displayed.join("\n")}`;
}

function parseCliArgs(rawArgs) {
  let rootDir = process.cwd();
  for (let index = 0; index < rawArgs.length; index += 1) {
    const argument = rawArgs[index];
    if (argument === "--root") {
      const value = rawArgs[index + 1];
      if (!value) throw new Error("--root requires a directory path");
      rootDir = path.resolve(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--root=")) {
      rootDir = path.resolve(argument.slice("--root=".length));
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { rootDir };
}

export function runPublicArtifactValidationCli(
  rawArgs = process.argv.slice(2),
  { now = new Date() } = {}
) {
  return validatePublicArtifacts({
    ...parseCliArgs(rawArgs),
    now,
    requireCurrentCentralDay: true
  });
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  try {
    const result = await runPublicArtifactValidationCli(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
