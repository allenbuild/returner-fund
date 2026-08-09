import { physicalPostIdentity } from "./targeted-evidence-merge.mjs";

const MAX_HISTORY_RECEIPTS = 800;

export function summarizeIngestionSourceDelta({
  idempotencyKey,
  beforeSnapshots = [],
  afterSnapshots = [],
  previousHistory = [],
  observedAt = new Date().toISOString(),
  mappedFailures = 0,
  collectionCoverage = null,
  credentialGaps = []
}) {
  const githubObjectAliases = githubObjectIdentityAliases([
    ...beforeSnapshots,
    ...afterSnapshots
  ]);
  const before = physicalSourceIndex(beforeSnapshots, githubObjectAliases);
  const after = physicalSourceIndex(afterSnapshots, githubObjectAliases);
  const insertedRows = [...after]
    .filter(([key]) => !before.has(key))
    .map(([, row]) => row);
  const removed = [...before.keys()].filter((key) => !after.has(key)).length;
  const centralDay = centralDayFromSlot(idempotencyKey);
  const previousSlotReceipt = (previousHistory ?? []).find((receipt) =>
    receipt?.idempotencyKey === idempotencyKey
  );
  const priorDayReceipts = (previousHistory ?? []).filter((receipt) =>
    receipt?.centralDay === centralDay && receipt?.idempotencyKey !== idempotencyKey
  );
  const attemptInsertedByBatchPlatform = countBy(insertedRows, (row) => [
    String(row?.batchSlug ?? row?.batch_slug ?? "unscoped").toUpperCase(),
    normalizePlatform(row?.platform)
  ].join(":"));
  const insertedByBatchPlatform = mergeCounts(
    previousSlotReceipt?.insertedByBatchPlatform,
    attemptInsertedByBatchPlatform
  );
  const insertedSourceSamples = mergeSamples(
    previousSlotReceipt?.insertedSourceSamples,
    insertedRows.map(sourceSample)
  );
  const newestPostedAt = newestValidTimestamp([
    previousSlotReceipt?.newestNewSourcePostedAt,
    ...insertedRows.map((row) => row?.postedAt ?? row?.posted_at)
  ]);
  const newPhysicalSourcesThisAttempt = insertedRows.length;
  const newPhysicalSources = Number(previousSlotReceipt?.newPhysicalSources ?? 0) + newPhysicalSourcesThisAttempt;
  const dailyNewPhysicalSources = newPhysicalSources + priorDayReceipts.reduce(
    (total, receipt) => total + Number(receipt?.newPhysicalSources ?? 0),
    0
  );
  const isFinalDailySlot = /-1800$/.test(String(idempotencyKey));
  const mappedExpected = Number(collectionCoverage?.mappedExpected ?? 0);
  const mappedSucceeded = Number(collectionCoverage?.mappedSucceeded ?? 0);
  const mappedNeedsReview = Number(collectionCoverage?.mappedNeedsReview ?? 0);
  const mappedBlockedOrEmpty = Number(collectionCoverage?.mappedBlockedOrEmpty ?? 0);
  const providerBlocked = Number(collectionCoverage?.providerBlocked ?? 0);
  const providerBlockedByReason = normalizeCountMap(
    collectionCoverage?.providerBlockedByReason
  );
  const mappedProviderBlocked = Number(collectionCoverage?.mappedProviderBlocked ?? 0);
  const mappedProviderBlockedByReason = normalizeCountMap(
    collectionCoverage?.mappedProviderBlockedByReason
  );
  const mappedScopeUnsupported = Number(collectionCoverage?.mappedScopeUnsupported ?? 0);
  const mappedFailureCount = Number(collectionCoverage?.mappedFailed ?? mappedFailures ?? 0);
  const mappedNonTerminal = Number(collectionCoverage?.mappedNonTerminal ?? 0);
  const mappedSuccessRate = mappedExpected > 0 ? mappedSucceeded / mappedExpected : null;
  const collectionHealthReasons = [
    ...(credentialGaps ?? []).map((name) => {
      const issue = String(name);
      return issue.includes(":") ? `connector_failure:${issue}` : `missing_credential:${issue}`;
    }),
    ...(mappedFailureCount > 0 ? [`mapped_failures:${mappedFailureCount}`] : []),
    ...(providerBlocked > 0 ? [`provider_blocked:${providerBlocked}`] : []),
    ...(mappedProviderBlocked > 0 ? [`mapped_provider_blocked:${mappedProviderBlocked}`] : []),
    ...(mappedScopeUnsupported > 0 ? [`mapped_scope_unsupported:${mappedScopeUnsupported}`] : []),
    ...(mappedNonTerminal > 0 ? [`mapped_nonterminal:${mappedNonTerminal}`] : []),
    ...(mappedExpected > 0 && mappedSuccessRate < 0.1
      ? [`mapped_success_rate_below_10_percent:${mappedSuccessRate.toFixed(4)}`]
      : [])
  ];

  return {
    schemaVersion: 1,
    idempotencyKey,
    centralDay,
    observedAt,
    baselinePhysicalSources: before.size,
    publishedPhysicalSources: after.size,
    newPhysicalSources,
    newPhysicalSourcesThisAttempt,
    retainedPhysicalSources: [...after.keys()].filter((key) => before.has(key)).length,
    removedPhysicalSources: removed,
    dailyNewPhysicalSources,
    dailySourceHealth: dailyNewPhysicalSources > 0
      ? "healthy"
      : isFinalDailySlot
        ? "stale_day"
        : "awaiting_second_slot",
    collectionHealth: collectionHealthReasons.length > 0 ? "degraded" : "complete",
    collectionHealthReasons,
    mappedExpected,
    mappedSucceeded,
    mappedNeedsReview,
    mappedBlockedOrEmpty,
    providerBlocked,
    providerBlockedByReason,
    mappedProviderBlocked,
    mappedProviderBlockedByReason,
    mappedScopeUnsupported,
    mappedFailures: mappedFailureCount,
    mappedNonTerminal,
    mappedSuccessRate: mappedSuccessRate === null ? null : Number(mappedSuccessRate.toFixed(4)),
    newestNewSourcePostedAt: newestPostedAt,
    insertedByBatchPlatform,
    insertedSourceSamples
  };
}

function normalizeCountMap(value) {
  return Object.fromEntries(
    Object.entries(value ?? {})
      .filter(([, count]) => Number.isSafeInteger(Number(count)) && Number(count) >= 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, count]) => [reason, Number(count)])
  );
}

export function mergeIngestionSourceDeltaHistory(previousHistory, receipt) {
  const byKey = new Map(
    (previousHistory ?? [])
      .filter((candidate) => candidate?.idempotencyKey)
      .map((candidate) => [candidate.idempotencyKey, candidate])
  );
  byKey.set(receipt.idempotencyKey, receipt);
  return [...byKey.values()]
    .sort((left, right) => String(left.observedAt).localeCompare(String(right.observedAt)))
    .slice(-MAX_HISTORY_RECEIPTS);
}

export function physicalSourceKey(row, githubObjectAliases = null) {
  const platform = normalizePlatform(row?.platform);
  if (!platform) return null;
  const platformObjectId = String(
    row?.platformObjectId ?? row?.platform_object_id ?? ""
  ).trim();
  if (platform === "github" && /^\d+$/.test(platformObjectId)) {
    return `github:object:${platformObjectId}`;
  }
  const identity = physicalPostIdentity({ ...row, platform }).value;
  if (!identity || identity === "row:unknown") return null;
  const normalizedIdentity = ["youtube", "instagram"].includes(platform)
    ? String(identity).trim()
    : String(identity).trim().toLowerCase();
  const fallbackKey = `${platform}:${normalizedIdentity}`;
  if (platform === "github") {
    return githubObjectAliases?.get(fallbackKey) ?? fallbackKey;
  }
  return fallbackKey;
}

function physicalSourceIndex(snapshots, githubObjectAliases) {
  const index = new Map();
  for (const snapshot of snapshots ?? []) {
    for (const row of snapshot?.evidence ?? []) {
      const key = physicalSourceKey(row, githubObjectAliases);
      if (key) index.set(key, row);
    }
  }
  return index;
}

function githubObjectIdentityAliases(snapshots) {
  const aliases = new Map();
  const ambiguousAliases = new Set();
  for (const snapshot of snapshots ?? []) {
    for (const row of snapshot?.evidence ?? []) {
      if (normalizePlatform(row?.platform) !== "github") continue;
      const platformObjectId = String(
        row?.platformObjectId ?? row?.platform_object_id ?? ""
      ).trim();
      if (!/^\d+$/.test(platformObjectId)) continue;
      const objectKey = `github:object:${platformObjectId}`;
      for (const alias of githubFallbackIdentityKeys(row)) {
        if (ambiguousAliases.has(alias)) continue;
        const previous = aliases.get(alias);
        if (previous && previous !== objectKey) {
          aliases.delete(alias);
          ambiguousAliases.add(alias);
        } else {
          aliases.set(alias, objectKey);
        }
      }
    }
  }
  return aliases;
}

function githubFallbackIdentityKeys(row) {
  const candidates = [
    row,
    {
      ...row,
      platformPostId: null,
      platform_post_id: null,
      platformObjectId: null,
      platform_object_id: null
    }
  ];
  return new Set(
    candidates
      .map((candidate) => {
        const identity = physicalPostIdentity(candidate).value;
        if (!identity || identity === "row:unknown") return null;
        return `github:${String(identity).trim().toLowerCase()}`;
      })
      .filter(Boolean)
  );
}

function sourceSample(row) {
  return {
    batchSlug: row?.batchSlug ?? row?.batch_slug ?? null,
    platform: normalizePlatform(row?.platform),
    entityType: row?.entityType ?? row?.entity_type ?? null,
    entityId: row?.entityId ?? row?.entity_id ?? null,
    sourceUrl: row?.sourceUrl ?? row?.source_url ?? null,
    platformPostId: row?.platformPostId ?? row?.platform_post_id ?? null,
    platformObjectId: row?.platformObjectId ?? row?.platform_object_id ?? null,
    postedAt: row?.postedAt ?? row?.posted_at ?? null
  };
}

function countBy(rows, keyFor) {
  const counts = {};
  for (const row of rows) {
    const key = keyFor(row);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function mergeCounts(left = {}, right = {}) {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    merged[key] = Number(merged[key] ?? 0) + Number(value ?? 0);
  }
  return Object.fromEntries(Object.entries(merged).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)));
}

function mergeSamples(previous = [], current = []) {
  const byIdentity = new Map();
  for (const sample of [...previous, ...current]) {
    const key = physicalSourceKey(sample) ?? JSON.stringify(sample);
    byIdentity.set(key, sample);
  }
  return [...byIdentity.values()].slice(0, 25);
}

function newestValidTimestamp(values) {
  return values
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function centralDayFromSlot(value) {
  return String(value ?? "").match(/^central-(\d{4}-\d{2}-\d{2})-(?:0600|1800)$/)?.[1] ?? null;
}

function normalizePlatform(value) {
  const platform = String(value ?? "").trim().toLowerCase();
  if (platform === "twitter") return "x";
  if (platform === "producthunt") return "product_hunt";
  if (platform === "hackernews" || platform === "hn") return "hacker_news";
  return platform;
}
