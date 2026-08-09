import { createHash } from "node:crypto";

import { physicalSourceKey } from "./ingestion-source-delta.mjs";
import {
  publicationTimesCompatible,
  sourceAuthorsCompatible,
  sourceContentIdentity
} from "./source-content-identity.mjs";
import {
  xAccountIdentity,
  xSnowflakeTimestamp,
  xStatusIdentity
} from "./repository-history-x-recovery.mjs";

const RECOVERY_HISTORY_PATHS = new Set([
  "src/lib/social/public-evidence-current.json",
  "src/lib/social/targeted-evidence-current.json",
  "src/lib/social/logged-in-evidence-current.json",
  "src/lib/social/volume-evidence-current.json"
]);
const REQUIRED_ZERO_METRIC_KEYS = Object.freeze(["likes", "replies", "reposts"]);
const X_METRIC_KEYS = Object.freeze(["views", "likes", "replies", "reposts", "quotes"]);
const REQUIRED_SIGNALS = Object.freeze([
  "current_verified_account_mapping",
  "official_x_oembed_author_match",
  "native_x_snowflake_timestamp"
]);

export function withXPublicStatusValidation(
  row,
  {
    post,
    endpoint = row?.sourceUrl,
    checkedAt = new Date().toISOString(),
    httpStatus = 200,
    responseBody
  } = {}
) {
  const native = xStatusIdentity(row?.sourceUrl);
  const account = xAccountIdentity(row?.accountUrl);
  const requestedNative = xStatusIdentity(endpoint);
  const returnedNative = xStatusIdentity(post?.url);
  const observedAt = requiredIso(checkedAt, "X public status checkedAt");
  const postTime = requiredIso(post?.postedAt, "X public status postedAt");
  const expectedTime = native ? xSnowflakeTimestamp(native.postId) : null;
  const authorHandle = normalizeHandle(post?.authorHandle);
  const metrics = normalizeXMetrics(post?.metrics, { requireBaseKeys: true });
  const body = Buffer.isBuffer(responseBody)
    ? responseBody
    : Buffer.from(String(responseBody ?? ""));

  if (!native || !account || native.handle !== account.handle) {
    throw new Error("Recovered row does not have one exact X status/account owner identity.");
  }
  if (requestedNative?.postId !== native.postId || requestedNative?.handle !== native.handle) {
    throw new Error("Public X status endpoint did not match the recovered native post.");
  }
  if (
    !returnedNative ||
    returnedNative.postId !== native.postId ||
    returnedNative.handle !== native.handle ||
    String(post?.id ?? "") !== native.postId
  ) {
    throw new Error(`Public X status response did not return ${native.url}.`);
  }
  if (authorHandle !== native.handle) {
    throw new Error(`Public X status author @${authorHandle ?? "missing"} did not match @${native.handle}.`);
  }
  if (!sameUtcSecond(postTime, expectedTime) || !sameUtcSecond(row?.postedAt, expectedTime)) {
    throw new Error(`Public X status timestamp did not match snowflake ${native.postId}.`);
  }
  if (Number(httpStatus) !== 200 || body.length === 0) {
    throw new Error("Public X status validation requires a non-empty HTTP 200 response.");
  }

  const positiveMetrics = Object.values(metrics).some((value) => value > 0);
  const contributionScore = Number(row?.contributionScore ?? 0);
  if (!Number.isFinite(contributionScore) || contributionScore < 0) {
    throw new Error(`Recovered row ${row?.id ?? native.postId} has an invalid contributionScore.`);
  }
  if (positiveMetrics && contributionScore <= 0) {
    throw new Error(
      `Recovered row ${row?.id ?? native.postId} has positive live metrics but no reusable historical score.`
    );
  }

  return {
    ...row,
    platform: "x",
    sourceUrl: native.url,
    platformPostId: native.postId,
    accountUrl: account.url,
    authorHandle: native.handle,
    authorName: clean(post?.authorName) ?? row?.authorName ?? null,
    postedAt: expectedTime,
    metrics,
    contributionScore: positiveMetrics ? contributionScore : 0,
    review_state: "verified",
    linkStatus: "verified",
    linkCheckedAt: observedAt,
    last_checked_at: observedAt,
    _recoveryProvenance: {
      ...(row?._recoveryProvenance ?? {}),
      publicStatusValidation: {
        schemaVersion: 1,
        kind: "official_x_public_status_schema_org",
        checkedAt: observedAt,
        endpoint: requestedNative.url,
        httpStatus: 200,
        responseSha256: createHash("sha256").update(body).digest("hex"),
        postId: native.postId,
        authorHandle: native.handle,
        authorName: clean(post?.authorName),
        postedAt: postTime,
        metrics
      }
    }
  };
}

export function buildRepositoryHistoryPublicEvidenceCandidate(
  rows,
  {
    generatedAt = new Date().toISOString(),
    inputPath = null
  } = {}
) {
  const fetchedAt = requiredIso(generatedAt, "candidate generatedAt");
  const evidence = [...(rows ?? [])].sort(compareRecoveredRows);
  for (const row of evidence) {
    const failures = repositoryHistoryXTrustFailures(row);
    if (failures.length > 0) {
      throw new Error(
        `Recovered row ${row?.id ?? "missing-id"} is not promotion ready: ${failures.join(", ")}.`
      );
    }
  }
  const batchSlugs = [...new Set(evidence.map((row) => row.batchSlug))].sort();
  return {
    source: {
      label: "Repository-history X public-evidence recovery candidate",
      fetchedAt,
      batchSlugs,
      evidenceCount: evidence.length,
      needsReviewCount: 0,
      notes: [
        "Every row was recovered from accepted repository history and revalidated against official public X surfaces.",
        "Zero-engagement posts retain explicit zero metrics and a zero contribution score; no engagement is synthesized.",
        ...(inputPath ? [`Recovery input: ${inputPath}`] : [])
      ]
    },
    evidence,
    attributionReconciliationLedger: [],
    needsReview: [],
    failures: [],
    attempts: {},
    discoveryAttempts: [],
    sourceDiscoveryPaths: []
  };
}

export function auditRepositoryHistoryXCandidate(
  candidate,
  {
    currentSnapshots = [],
    expectedTotal = null,
    expectedByBatch = null,
    throwOnFailure = true
  } = {}
) {
  const evidence = Array.isArray(candidate?.evidence) ? candidate.evidence : [];
  const currentRows = (currentSnapshots ?? []).flatMap((snapshot) => snapshot?.evidence ?? []);
  const candidateIds = new Set();
  const currentIds = new Set(currentRows.map((row) => clean(row?.id)).filter(Boolean));
  const currentPhysical = new Set(
    currentRows.map((row) => physicalSourceKey(row)).filter(Boolean)
  );
  const candidatePhysical = new Set();
  const duplicateIds = [];
  const currentIdCollisions = [];
  const duplicatePhysical = [];
  const currentPhysicalCollisions = [];
  const trustFailures = [];

  for (const row of evidence) {
    const id = clean(row?.id);
    if (!id || candidateIds.has(id)) duplicateIds.push(id ?? "missing-id");
    if (id && currentIds.has(id)) currentIdCollisions.push(id);
    if (id) candidateIds.add(id);
    const physical = physicalSourceKey(row);
    if (!physical || candidatePhysical.has(physical)) duplicatePhysical.push(physical ?? `missing:${id}`);
    if (physical && currentPhysical.has(physical)) currentPhysicalCollisions.push(physical);
    if (physical) candidatePhysical.add(physical);
    const failures = repositoryHistoryXTrustFailures(row);
    if (failures.length > 0) trustFailures.push({ id, failures });
  }

  const contentAudit = auditContentDuplicates(evidence, currentRows);
  const byBatch = countBy(evidence, (row) => String(row?.batchSlug ?? "missing"));
  const sourceCountMatches = Number(candidate?.source?.evidenceCount) === evidence.length;
  const expectedTotalMatches = expectedTotal === null || evidence.length === Number(expectedTotal);
  const expectedByBatchMatches = !expectedByBatch || Object.entries(expectedByBatch).every(
    ([batch, count]) => Number(byBatch[batch] ?? 0) === Number(count)
  );
  const report = {
    schemaVersion: 1,
    candidateEvidence: evidence.length,
    currentEvidenceRowsCompared: currentRows.length,
    byBatch,
    zeroEngagementEvidence: evidence.filter((row) => !hasPositiveXMetric(row?.metrics)).length,
    positiveEngagementEvidence: evidence.filter((row) => hasPositiveXMetric(row?.metrics)).length,
    contentIdentityEligibleEvidence: contentAudit.eligible,
    duplicateIds: duplicateIds.length,
    currentIdCollisions: currentIdCollisions.length,
    duplicatePhysical: duplicatePhysical.length,
    currentPhysicalCollisions: currentPhysicalCollisions.length,
    duplicateContent: contentAudit.duplicates.length,
    trustFailures: trustFailures.length,
    sourceCountMatches,
    expectedTotalMatches,
    expectedByBatchMatches,
    details: {
      duplicateIds,
      currentIdCollisions,
      duplicatePhysical,
      currentPhysicalCollisions,
      duplicateContent: contentAudit.duplicates,
      trustFailures
    }
  };
  const failed = [
    report.duplicateIds,
    report.currentIdCollisions,
    report.duplicatePhysical,
    report.currentPhysicalCollisions,
    report.duplicateContent,
    report.trustFailures
  ].some((count) => count !== 0) ||
    !sourceCountMatches ||
    !expectedTotalMatches ||
    !expectedByBatchMatches;
  if (failed && throwOnFailure) {
    throw new Error(`Repository-history candidate audit failed: ${JSON.stringify(report)}`);
  }
  return report;
}

export function isVerifiedRepositoryHistoryXMetriclessEvidence(row) {
  return !hasPositiveXMetric(row?.metrics) &&
    Number(row?.contributionScore ?? 0) === 0 &&
    repositoryHistoryXTrustFailures(row).length === 0;
}

export function repositoryHistoryXTrustFailures(row) {
  const failures = [];
  const native = xStatusIdentity(row?.sourceUrl);
  const account = xAccountIdentity(row?.accountUrl);
  const provenance = row?._recoveryProvenance;
  const git = provenance?.git;
  const oembed = provenance?.liveValidation;
  const status = provenance?.publicStatusValidation;
  const statusNative = xStatusIdentity(status?.endpoint);
  const returnedNative = xStatusIdentity(oembed?.returnedUrl);
  const returnedAccount = xAccountIdentity(oembed?.returnedAuthorUrl);
  const metrics = safeNormalizeXMetrics(row?.metrics);
  const statusMetrics = safeNormalizeXMetrics(status?.metrics, { requireBaseKeys: true });

  if (!clean(row?.id)) failures.push("missing_id");
  if (String(row?.platform ?? "").toLowerCase() !== "x") failures.push("platform_not_x");
  if (row?.review_state !== "verified") failures.push("review_state_not_verified");
  if (row?.linkStatus !== "verified") failures.push("link_not_verified");
  if (!["verified", "verified_native_author"].includes(row?.attributionStatus)) {
    failures.push("attribution_not_verified");
  }
  if (row?.attributionMode !== "account_owner") failures.push("attribution_mode_not_account_owner");
  if (!native || String(row?.platformPostId ?? "") !== native?.postId) failures.push("native_status_identity_invalid");
  if (!account || account?.handle !== native?.handle) failures.push("account_owner_identity_invalid");
  if (row?.authorHandle && normalizeHandle(row.authorHandle) !== native?.handle) failures.push("author_handle_mismatch");
  if (!sameUtcMillisecond(row?.postedAt, xSnowflakeTimestamp(native?.postId))) failures.push("snowflake_timestamp_mismatch");
  if (provenance?.kind !== "git_repository_history_plus_official_x_oembed") failures.push("recovery_kind_invalid");
  if (provenance?.physicalKey !== physicalSourceKey(row)) failures.push("recovery_physical_key_mismatch");
  if (!/^[0-9a-f]{40}$/i.test(String(git?.commit ?? ""))) failures.push("git_commit_invalid");
  if (!RECOVERY_HISTORY_PATHS.has(git?.path)) failures.push("git_source_path_invalid");
  if (!Number.isSafeInteger(git?.sourceIndex) || git.sourceIndex < 0) failures.push("git_source_index_invalid");
  if (!validIso(git?.committedAt)) failures.push("git_commit_time_invalid");
  if (!returnedNative || returnedNative?.postId !== native?.postId || returnedNative?.handle !== native?.handle) {
    failures.push("oembed_status_identity_invalid");
  }
  if (!returnedAccount || returnedAccount?.handle !== native?.handle) failures.push("oembed_author_identity_invalid");
  if (!isOfficialXOembedEndpoint(oembed?.endpoint, native?.url)) failures.push("oembed_endpoint_invalid");
  if (!validIso(oembed?.checkedAt)) failures.push("oembed_checked_at_invalid");
  if (status?.kind !== "official_x_public_status_schema_org") failures.push("public_status_kind_invalid");
  if (Number(status?.httpStatus) !== 200) failures.push("public_status_http_invalid");
  if (!/^[0-9a-f]{64}$/i.test(String(status?.responseSha256 ?? ""))) failures.push("public_status_hash_invalid");
  if (!statusNative || statusNative?.postId !== native?.postId || statusNative?.handle !== native?.handle) {
    failures.push("public_status_endpoint_invalid");
  }
  if (String(status?.postId ?? "") !== native?.postId) failures.push("public_status_post_id_mismatch");
  if (normalizeHandle(status?.authorHandle) !== native?.handle) failures.push("public_status_author_mismatch");
  if (!sameUtcSecond(status?.postedAt, xSnowflakeTimestamp(native?.postId))) failures.push("public_status_time_mismatch");
  if (!validIso(status?.checkedAt)) failures.push("public_status_checked_at_invalid");
  if (!metrics || !statusMetrics || JSON.stringify(metrics) !== JSON.stringify(statusMetrics)) {
    failures.push("public_status_metrics_mismatch");
  }
  const score = Number(row?.contributionScore);
  if (!Number.isFinite(score) || score < 0) failures.push("contribution_score_invalid");
  if (!hasPositiveXMetric(metrics) && score !== 0) failures.push("zero_metrics_nonzero_score");
  const recoverySignalsComplete = Array.isArray(row?.attributionSignals) && REQUIRED_SIGNALS.every(
    (signal) => row.attributionSignals.includes(signal)
  );
  const canonicalNativeAuthorComplete = row?.nativeAuthorResolution?.status === "matched" &&
    row.nativeAuthorResolution.owner?.batchSlug === row?.batchSlug &&
    row.nativeAuthorResolution.owner?.entityType === row?.entityType &&
    row.nativeAuthorResolution.owner?.entityId === row?.entityId &&
    Array.isArray(row?.attributionSignals) &&
    row.attributionSignals.includes("unique_native_author");
  if (!recoverySignalsComplete && !canonicalNativeAuthorComplete) {
    failures.push("recovery_attribution_signals_incomplete");
  }
  return [...new Set(failures)];
}

function auditContentDuplicates(candidateRows, currentRows) {
  const currentIndex = buildContentIndex(currentRows);
  const candidateIndex = new Map();
  const duplicates = [];
  let eligible = 0;
  for (const row of candidateRows) {
    const identity = contentIdentityForRow(row);
    if (!identity) continue;
    eligible += 1;
    const scope = contentScope(row);
    const physical = physicalSourceKey(row);
    let duplicate = null;
    for (const key of identity.keys) {
      const candidates = [
        ...(currentIndex.get(`${scope}:${key}`) ?? []),
        ...(candidateIndex.get(`${scope}:${key}`) ?? [])
      ];
      duplicate = candidates.find((candidate) =>
        candidate.physical !== physical &&
        sourceAuthorsCompatible(identity, candidate.identity) &&
        publicationTimesCompatible(identity, candidate.identity)
      ) ?? null;
      if (duplicate) break;
    }
    if (duplicate) {
      duplicates.push({
        id: row?.id ?? null,
        duplicateOf: duplicate.row?.id ?? null,
        bodySha256: identity.bodySha256
      });
      continue;
    }
    indexContent(candidateIndex, row, identity, physical);
  }
  return { eligible, duplicates };
}

function buildContentIndex(rows) {
  const index = new Map();
  for (const row of rows) {
    const identity = contentIdentityForRow(row);
    if (!identity) continue;
    indexContent(index, row, identity, physicalSourceKey(row));
  }
  return index;
}

function indexContent(index, row, identity, physical) {
  const scope = contentScope(row);
  const entry = { row, identity, physical };
  for (const key of identity.keys) {
    const scoped = `${scope}:${key}`;
    index.set(scoped, [...(index.get(scoped) ?? []), entry]);
  }
}

function contentIdentityForRow(row) {
  const raw = parseVisiblePayload(row?.rawVisibleText);
  return sourceContentIdentity({
    platform: row?.platform,
    authorName: row?.authorName ?? raw?.name ?? raw?.author?.name,
    authorHandle: row?.authorHandle ?? raw?.authorHandle ?? raw?.author?.handle ??
      raw?.author?.username ?? (typeof raw?.author === "string" ? raw.author : null),
    authorUrl: row?.authorUrl ?? raw?.author?.url,
    accountUrl: row?.accountUrl,
    sourceUrl: row?.sourceUrl,
    fallbackAuthorName: row?.entityName ?? row?.companyName,
    body: row?.text ?? row?.content ?? row?.body,
    postedAt: row?.postedAt ?? row?.publishedAt
  });
}

function contentScope(row) {
  return [
    String(row?.batchSlug ?? row?.batch_slug ?? "unscoped").toUpperCase(),
    row?.entityType ?? row?.entity_type ?? "company",
    row?.entityId ?? row?.entity_id ?? "unknown-entity"
  ].join(":");
}

function normalizeXMetrics(value, { requireBaseKeys = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("X metrics must be an object.");
  }
  const aliases = { comments: "replies", retweets: "reposts" };
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = aliases[rawKey] ?? rawKey;
    if (!X_METRIC_KEYS.includes(key)) continue;
    const number = Number(rawValue);
    if (!Number.isFinite(number) || number < 0) throw new Error(`Invalid X metric ${rawKey}.`);
    result[key] = Math.max(result[key] ?? 0, number);
  }
  if (requireBaseKeys && REQUIRED_ZERO_METRIC_KEYS.some((key) => !Object.hasOwn(result, key))) {
    throw new Error("Public X status receipt omitted a base interaction counter.");
  }
  return Object.fromEntries(X_METRIC_KEYS.filter((key) => Object.hasOwn(result, key)).map(
    (key) => [key, result[key]]
  ));
}

function safeNormalizeXMetrics(value, options) {
  try {
    return normalizeXMetrics(value, options);
  } catch {
    return null;
  }
}

function hasPositiveXMetric(metrics) {
  return Object.values(metrics ?? {}).some((value) => Number(value) > 0);
}

function isOfficialXOembedEndpoint(rawEndpoint, statusUrl) {
  try {
    const endpoint = new URL(String(rawEndpoint ?? ""));
    const embedded = xStatusIdentity(endpoint.searchParams.get("url"));
    const expected = xStatusIdentity(statusUrl);
    return endpoint.protocol === "https:" &&
      endpoint.hostname === "publish.twitter.com" &&
      endpoint.pathname === "/oembed" &&
      embedded?.postId === expected?.postId &&
      embedded?.handle === expected?.handle;
  } catch {
    return false;
  }
}

function parseVisiblePayload(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value ?? ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function compareRecoveredRows(left, right) {
  return String(left?.batchSlug ?? "").localeCompare(String(right?.batchSlug ?? "")) ||
    String(left?.entityId ?? "").localeCompare(String(right?.entityId ?? "")) ||
    String(left?.postedAt ?? "").localeCompare(String(right?.postedAt ?? "")) ||
    String(left?.platformPostId ?? "").localeCompare(String(right?.platformPostId ?? ""));
}

function countBy(rows, keyFor) {
  const counts = {};
  for (const row of rows) {
    const key = keyFor(row);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function sameUtcSecond(left, right) {
  const leftTime = Date.parse(String(left ?? ""));
  const rightTime = Date.parse(String(right ?? ""));
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) &&
    Math.floor(leftTime / 1_000) === Math.floor(rightTime / 1_000);
}

function sameUtcMillisecond(left, right) {
  const leftTime = Date.parse(String(left ?? ""));
  const rightTime = Date.parse(String(right ?? ""));
  return Number.isFinite(leftTime) && leftTime === rightTime;
}

function requiredIso(value, label) {
  if (!validIso(value)) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(value).toISOString();
}

function validIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function normalizeHandle(value) {
  const handle = String(value ?? "").trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_]{1,15}$/.test(handle) ? handle : null;
}

function clean(value) {
  const text = String(value ?? "").trim();
  return text || null;
}
