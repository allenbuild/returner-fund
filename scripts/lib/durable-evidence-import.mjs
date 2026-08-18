import { createHash } from "node:crypto";

const TRACKING_PARAMETER = /^(?:utm_.+|fbclid|gclid|dclid|igshid|mc_.+|ref|ref_src|source|si|feature|trk|trackingid)$/i;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+$/;
const GITHUB_RESERVED_OWNERS = new Set([
  "about", "account", "apps", "collections", "codespaces", "enterprise", "events",
  "explore", "features", "gist", "issues", "login", "marketplace", "new",
  "notifications", "organizations", "orgs", "pricing", "pulls", "search", "settings",
  "signup", "sponsors", "topics", "users"
]);
const PLATFORM_ALIASES = {
  twitter: "x",
  x: "x",
  yt: "youtube",
  youtube: "youtube",
  github: "github",
  reddit: "reddit",
  producthunt: "product_hunt",
  product_hunt: "product_hunt",
  hn: "hacker_news",
  hackernews: "hacker_news",
  hacker_news: "hacker_news",
  instagram: "instagram",
  linkedin: "linkedin",
  bsky: "bluesky",
  bluesky: "bluesky",
  tiktok: "tiktok",
  bilibili: "bilibili",
  website: "web",
  news_web: "web",
  web: "web",
  rss: "rss"
};
const TRACTION_PLATFORMS = new Set([
  "x", "youtube", "github", "reddit", "product_hunt", "hacker_news",
  "instagram", "linkedin", "bilibili"
]);
const DERIVED_METRICS = new Set(["score", "profile_score", "contribution_score", "max_repo_score"]);
const ATTRIBUTION_TYPES = new Set(["subject", "author", "mention", "account_owner", "founder_rollup", "other"]);
const RECONCILIATION_DISPOSITIONS = new Set(["reattributed", "quarantined"]);
const ATTRIBUTION_READ_COLUMNS = [
  "id", "evidence_id", "entity_type", "company_id", "founder_id", "batch_id",
  "attribution_type", "is_primary", "score_eligible", "review_state", "risk_level",
  "match_reason", "source_url", "reviewed_at", "metadata_json"
].join(",");

/**
 * Imports public collector and GitHub collector snapshots into the durable evidence tables.
 * Rejected context rows are retained in evidence_items, but never produce metric observations.
 * `attributionReconciliationLedger`, when present, is an explicit fail-closed list of stale
 * batch/entity targets to retire. Reattribution entries must name a replacement that is also
 * present in the sanitized snapshots; omission alone never retires durable attribution. A
 * stale target that no longer exists in the current batch catalog is retained in the source
 * ledger but skipped here when a verified replacement is present, because there is no safe
 * durable row to target. Incomplete reattributions still fail closed.
 */
export async function importDurableEvidence(options) {
  if (!options || typeof options !== "object") throw new TypeError("Import options are required.");
  const client = options.client ?? options.supabase;
  if (!client || typeof client.from !== "function") {
    throw new TypeError("A Supabase-like client with from(table) is required.");
  }
  const ingestionRunId = nonBlank(options.ingestionRunId ?? options.ingestion_run_id);
  if (!ingestionRunId) throw new TypeError("ingestionRunId is required.");

  const catalogMaps = options.catalogMaps ?? options.catalog ?? {};
  const snapshots = snapshotList(options);
  if (snapshots.length === 0) throw new TypeError("At least one public or GitHub snapshot is required.");

  const now = validTimestamp(options.now) ?? new Date().toISOString();
  const candidates = snapshots.flatMap((snapshot, snapshotIndex) =>
    candidatesFromSnapshot(snapshot, snapshotIndex, now)
  );
  const normalized = candidates.map(normalizeCandidate);
  const reconciliationLedger = normalizeAttributionReconciliationLedger(
    options.attributionReconciliationLedger,
    catalogMaps,
    normalized
  );
  assertReconciliationCandidates(reconciliationLedger.entries, normalized, catalogMaps);
  const counters = {
    received: normalized.length,
    rejected: normalized.filter((item) => !item.tractionEligible).length,
    duplicates: 0,
    stored: 0,
    readBack: 0
  };

  const groups = new Map();
  const unstorableRejections = [];
  for (const item of normalized) {
    if (!item.evidenceRow) {
      unstorableRejections.push(rejectionSummary(item));
      continue;
    }
    const existing = groups.get(item.key);
    if (existing) {
      counters.duplicates += 1;
      existing.items.push(item);
      mergeEvidenceRows(existing.evidenceRow, item.evidenceRow, existing.items.length - 1);
    } else {
      groups.set(item.key, { evidenceRow: item.evidenceRow, items: [item] });
    }
  }

  const evidenceRows = [...groups.values()].map((group) => group.evidenceRow);
  let evidenceReadBack = [];
  if (evidenceRows.length > 0) {
    const response = await client
      .from("evidence_items")
      .upsert(evidenceRows, { onConflict: "platform,canonical_key" })
      .select("id,platform,canonical_key");
    evidenceReadBack = checkedRows(response, "upsert and read back evidence_items");
    assertCompleteReadBack(evidenceRows, evidenceReadBack);
  }
  counters.stored = evidenceRows.length;
  counters.readBack = evidenceReadBack.length;

  const evidenceIds = new Map(
    evidenceReadBack.map((row) => [`${row.platform}\u0000${row.canonical_key}`, row.id])
  );
  const reconciliationEvidence = await resolveReconciliationEvidenceIds({
    client,
    entries: reconciliationLedger.entries,
    evidenceIds
  });
  const attributionRows = [];
  const observationRows = [];
  const attributionRejections = [];
  let unresolvedAttributions = 0;

  for (const group of groups.values()) {
    const evidenceId = evidenceIds.get(group.items[0].key);
    if (!evidenceId) throw new Error(`Missing read-back id for ${group.items[0].key}.`);

    for (const item of group.items) {
      let attribution = null;
      if (item.verified) {
        attribution = attributionRow(item, evidenceId, catalogMaps);
        if (attribution) attributionRows.push(attribution);
        else unresolvedAttributions += 1;
      }
      if (item.tractionEligible) {
        if (attribution) {
          observationRows.push(...metricRows(item, evidenceId, ingestionRunId));
        } else {
          if (!item.verified) unresolvedAttributions += 1;
          item.reasons = uniqueStrings([...item.reasons, "unresolved_attribution"]);
          attributionRejections.push(rejectionSummary(item));
          counters.rejected += 1;
        }
      }
    }
  }

  if (options.requireCompleteAttribution === true && unresolvedAttributions > 0) {
    throw new Error(
      `Durable evidence import rejected ${unresolvedAttributions} unresolved_attribution row(s); ` +
      "metric observations were not written."
    );
  }

  const uniqueAttributions = uniqueRows(attributionRows, (row) =>
    `${row.evidence_id}:${row.entity_type}:${row.company_id ?? row.founder_id}:${row.attribution_type}:${row.batch_id ?? "legacy"}`
  );
  const reconciliation = await retireEnumeratedAttributions({
    client,
    entries: reconciliationLedger.entries,
    generatedAttributions: uniqueAttributions.rows,
    now,
    evidenceResolution: reconciliationEvidence,
    received: reconciliationLedger.received
  });
  if (uniqueAttributions.rows.length > 0) {
    const response = await client
      .from("evidence_attributions")
      .upsert(uniqueAttributions.rows, { onConflict: "id" });
    checkedResponse(response, "upsert evidence_attributions");
  }

  await assertAttributionReconciliationReadBack({
    client,
    entries: reconciliationLedger.entries,
    generatedAttributions: uniqueAttributions.rows
  });

  const uniqueObservations = uniqueRows(observationRows, (row) =>
    `${row.evidence_id}:${row.metric_name}:${row.source_name}:${row.observed_at}`
  );
  if (uniqueObservations.rows.length > 0) {
    const response = await client.from("metric_observations").upsert(uniqueObservations.rows, {
      onConflict: "evidence_id,metric_name,source_name,observed_at",
      ignoreDuplicates: true
    });
    checkedResponse(response, "append metric_observations");
  }

  const attributionReconciliation = reconciliationLedger.skipped.length > 0
    ? { ...reconciliation, skippedUnresolved: reconciliationLedger.skipped }
    : reconciliation;
  return {
    ...counters,
    attributions: {
      stored: uniqueAttributions.rows.length,
      duplicates: uniqueAttributions.duplicates,
      unresolved: unresolvedAttributions
    },
    metricObservations: {
      stored: uniqueObservations.rows.length,
      duplicates: uniqueObservations.duplicates
    },
    attributionReconciliation,
    rejections: [...unstorableRejections, ...attributionRejections]
  };
}

export const importEvidenceSnapshots = importDurableEvidence;
export const durableEvidenceImport = importDurableEvidence;
export default importDurableEvidence;

function snapshotList(options) {
  const values = [
    options.snapshots,
    options.snapshot,
    options.publicSnapshots,
    options.publicSnapshot,
    options.githubSnapshots,
    options.githubSnapshot
  ];
  return values.flatMap((value) => value == null ? [] : Array.isArray(value) ? value : [value]);
}

function candidatesFromSnapshot(snapshot, snapshotIndex, now) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError(`Snapshot ${snapshotIndex + 1} must be an object.`);
  }
  const rows = [];
  if (Array.isArray(snapshot.evidence)) {
    const observedAt = sourceTimestamp(snapshot, now);
    for (const row of snapshot.evidence) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      rows.push({
        kind: "public",
        row,
        source: snapshot.source ?? {},
        sourceName: "public_snapshot",
        observedAt: validTimestamp(row.last_checked_at) ?? observedAt,
        sourceLabel: nonBlank(snapshot.source?.label) ?? "Public evidence snapshot"
      });
    }
  }
  if (Array.isArray(snapshot.accounts)) {
    const observedAt = sourceTimestamp(snapshot, now);
    for (const accountRow of snapshot.accounts) {
      if (!accountRow || typeof accountRow !== "object" || Array.isArray(accountRow) || !accountRow.fetched) continue;
      rows.push({
        kind: "github_account",
        row: accountRow,
        source: snapshot.source ?? {},
        sourceName: "github_api",
        sourceLabel: nonBlank(snapshot.source?.label) ?? "GitHub public API snapshot",
        observedAt
      });
      for (const repository of accountRow.repos ?? []) {
        if (!repository || typeof repository !== "object" || Array.isArray(repository)) continue;
        rows.push({
          kind: "github_repository",
          row: repository,
          ownerRow: accountRow,
          source: snapshot.source ?? {},
          sourceName: "github_api",
          sourceLabel: nonBlank(snapshot.source?.label) ?? "GitHub public API snapshot",
          observedAt
        });
      }
    }
  }
  if (rows.length === 0 && !Array.isArray(snapshot.evidence) && !Array.isArray(snapshot.accounts)) {
    throw new TypeError(`Snapshot ${snapshotIndex + 1} is neither a public evidence nor GitHub snapshot.`);
  }
  return rows;
}

function normalizeCandidate(candidate) {
  if (candidate.kind === "github_account") return normalizeGithubAccount(candidate);
  if (candidate.kind === "github_repository") return normalizeGithubRepository(candidate);
  return normalizePublicEvidence(candidate);
}

function normalizePublicEvidence(candidate) {
  const row = candidate.row;
  const platform = normalizePlatform(row.platform);
  const sourceUrl = firstString(row.sourceUrl, row.canonicalUrl, row.url);
  const canonical = canonicalizeUrl(platform, sourceUrl);
  const suppliedNativeId = normalizeSuppliedNativeId(platform, row.platformPostId ?? row.nativeId);
  const reasons = canonical.reason ? [canonical.reason] : [];
  if (row.platformPostId != null && !suppliedNativeId) reasons.push("invalid_native_id");
  if (canonical.nativeId && suppliedNativeId && canonical.nativeId !== suppliedNativeId) {
    reasons.push("native_id_conflict");
  }
  const metrics = normalizeMetrics(row.metrics);
  if (metrics.invalid) reasons.push("invalid_metrics");
  const positiveMetricCount = Object.values(metrics.values).filter((value) => value > 0).length;
  const nativeObject = canonical.classification === "native_object" && reasons.length === 0;
  if (nativeObject && !TRACTION_PLATFORMS.has(platform)) reasons.push("traction_not_supported");
  if (nativeObject && positiveMetricCount === 0) reasons.push("no_visible_positive_metrics");
  const tractionEligible = nativeObject && TRACTION_PLATFORMS.has(platform) && positiveMetricCount > 0;
  const evidenceKind = evidenceKindFor(platform, canonical.objectType, canonical.classification);
  const nativeId = canonical.nativeId ?? (canonical.classification === "native_object" ? suppliedNativeId : null);
  const key = canonicalKey(platform, evidenceKind, nativeId, canonical.canonicalUrl);
  const metadata = evidenceMetadata(candidate, canonical, reasons, tractionEligible, {
    row_id: nonBlank(row.id),
    entity_type: normalizedEntityType(row.entityType),
    entity_id: nonBlank(row.entityId),
    company_slug: nonBlank(row.companySlug),
    company_name: nonBlank(row.companyName),
    title: nonBlank(row.title),
    text: nonBlank(row.text),
    match_reason: nonBlank(row.matchReason),
    review_state: normalizedReviewState(row.review_state)
  });
  const item = baseNormalized(candidate, row, platform, canonical, reasons, tractionEligible, metrics.values);
  item.key = key ? `${platform}\u0000${key}` : null;
  item.verified = normalizedReviewState(row.review_state) === "verified";
  item.entityType = normalizedEntityType(row.entityType);
  item.entityKeys = [row.entityId, row.companySlug, row.companyName];
  item.matchReason = nonBlank(row.matchReason) ?? "Verified public evidence attribution.";
  item.attributionSourceUrl = canonicalHttpUrl(row.attributionSourceUrl ?? sourceUrl);
  item.attributionType = "subject";
  item.evidenceRow = key && canonical.canonicalUrl ? {
    platform,
    evidence_kind: evidenceKind,
    canonical_key: key,
    platform_object_id: nativeId,
    canonical_url: canonical.canonicalUrl,
    published_at: validTimestamp(row.postedAt ?? row.publishedAt),
    content_fingerprint: contentFingerprint(row),
    first_seen_at: validTimestamp(row.first_seen_at ?? row.firstSeenAt) ?? candidate.observedAt,
    last_seen_at: candidate.observedAt,
    metadata_json: metadata
  } : null;
  return item;
}

function normalizeGithubAccount(candidate) {
  const row = candidate.row;
  const account = row.account ?? {};
  const login = normalizeGithubOwner(account.login ?? row.login);
  const sourceUrl = firstString(account.htmlUrl, row.githubUrl, login && `https://github.com/${login}`);
  const canonical = canonicalizeUrl("github", sourceUrl);
  const reasons = uniqueStrings([
    canonical.reason,
    "profile_page"
  ]);
  const key = login ? `github:account:${login}` : canonicalKey("github", "account", null, canonical.canonicalUrl);
  const verified = githubAttributionVerified(row);
  const metadata = evidenceMetadata(candidate, canonical, reasons, false, {
    entity_type: normalizedEntityType(row.entityType),
    entity_id: nonBlank(row.entityId),
    company_slug: nonBlank(row.companySlug),
    company_name: nonBlank(row.companyName),
    login,
    account: cleanJson(account),
    aggregate: cleanJson(row.aggregate ?? {}),
    match_reason: nonBlank(row.matchReason),
    discovery_source: nonBlank(row.discoverySource),
    review_state: verified ? "verified" : "needs_review"
  });
  return {
    ...baseNormalized(candidate, row, "github", canonical, reasons, false, {}),
    key: key ? `github\u0000${key}` : null,
    verified,
    entityType: normalizedEntityType(row.entityType),
    entityKeys: [row.entityId, row.companySlug, row.companyName],
    matchReason: nonBlank(row.matchReason) ?? "Verified GitHub account attribution.",
    attributionSourceUrl: canonicalHttpUrl(row.sourceUrl ?? row.githubUrl),
    attributionType: "account_owner",
    evidenceRow: key && canonical.canonicalUrl ? {
      platform: "github",
      evidence_kind: "account",
      canonical_key: key,
      platform_object_id: login,
      canonical_url: canonical.canonicalUrl,
      published_at: null,
      content_fingerprint: contentFingerprint(account),
      first_seen_at: candidate.observedAt,
      last_seen_at: candidate.observedAt,
      metadata_json: metadata
    } : null
  };
}

function normalizeGithubRepository(candidate) {
  const repository = candidate.row;
  const ownerRow = candidate.ownerRow;
  const sourceUrl = firstString(repository.htmlUrl, repository.url);
  const canonical = canonicalizeUrl("github", sourceUrl);
  const suppliedNativeId = normalizeGithubRepositoryId(repository.fullName);
  const reasons = canonical.reason ? [canonical.reason] : [];
  if (repository.fullName != null && !suppliedNativeId) reasons.push("invalid_native_id");
  if (canonical.nativeId && suppliedNativeId && canonical.nativeId !== suppliedNativeId) {
    reasons.push("native_id_conflict");
  }
  const metrics = normalizeMetrics({
    stars: repository.stars,
    forks: repository.forks,
    watchers: repository.watchers,
    open_issues: repository.openIssues
  });
  if (metrics.invalid) reasons.push("invalid_metrics");
  const positiveMetricCount = Object.values(metrics.values).filter((value) => value > 0).length;
  const nativeObject = canonical.classification === "native_object" && reasons.length === 0;
  if (nativeObject && positiveMetricCount === 0) reasons.push("no_visible_positive_metrics");
  const tractionEligible = nativeObject && positiveMetricCount > 0;
  const nativeId = canonical.nativeId ?? suppliedNativeId;
  const key = canonicalKey("github", "repository", nativeId, canonical.canonicalUrl);
  const verified = githubAttributionVerified(ownerRow);
  const metadata = evidenceMetadata(candidate, canonical, reasons, tractionEligible, {
    repository_id: finiteNonnegative(repository.id),
    full_name: suppliedNativeId,
    name: nonBlank(repository.name),
    description: nonBlank(repository.description),
    language: nonBlank(repository.language),
    pushed_at: validTimestamp(repository.pushedAt),
    updated_at: validTimestamp(repository.updatedAt),
    created_at: validTimestamp(repository.createdAt),
    entity_type: normalizedEntityType(ownerRow.entityType),
    entity_id: nonBlank(ownerRow.entityId),
    company_slug: nonBlank(ownerRow.companySlug),
    company_name: nonBlank(ownerRow.companyName),
    match_reason: nonBlank(ownerRow.matchReason),
    discovery_source: nonBlank(ownerRow.discoverySource),
    review_state: verified ? "verified" : "needs_review"
  });
  return {
    ...baseNormalized(candidate, repository, "github", canonical, reasons, tractionEligible, metrics.values),
    key: key ? `github\u0000${key}` : null,
    verified,
    entityType: normalizedEntityType(ownerRow.entityType),
    entityKeys: [ownerRow.entityId, ownerRow.companySlug, ownerRow.companyName],
    matchReason: nonBlank(ownerRow.matchReason) ?? "Verified GitHub repository attribution.",
    attributionSourceUrl: canonicalHttpUrl(ownerRow.sourceUrl ?? ownerRow.githubUrl),
    attributionType: "account_owner",
    evidenceRow: key && canonical.canonicalUrl ? {
      platform: "github",
      evidence_kind: "repository",
      canonical_key: key,
      platform_object_id: nativeId,
      canonical_url: canonical.canonicalUrl,
      published_at: validTimestamp(repository.createdAt),
      content_fingerprint: contentFingerprint(repository),
      first_seen_at: candidate.observedAt,
      last_seen_at: candidate.observedAt,
      metadata_json: metadata
    } : null
  };
}

function baseNormalized(candidate, row, platform, canonical, reasons, tractionEligible, metrics) {
  return {
    candidate,
    row,
    platform,
    canonical,
    reasons: uniqueStrings(reasons),
    tractionEligible,
    metrics,
    observedAt: candidate.observedAt,
    sourceName: candidate.sourceName,
    batchSlug: nonBlank(
      row?.batchSlug ?? row?.batch_slug ?? candidate.source?.batchSlug ?? candidate.source?.batch_slug
    ),
    sourceUrl: canonical.canonicalUrl,
    evidenceRow: null,
    key: null,
    verified: false,
    entityType: null,
    entityKeys: [],
    matchReason: "Verified evidence attribution.",
    attributionSourceUrl: null,
    attributionType: "subject"
  };
}

function evidenceMetadata(candidate, canonical, reasons, tractionEligible, detail) {
  return cleanJson({
    source_kind: candidate.kind,
    source_name: candidate.sourceName,
    source_label: candidate.sourceLabel,
    batch_slug: nonBlank(
      candidate.row?.batchSlug ?? candidate.row?.batch_slug ??
        candidate.source?.batchSlug ?? candidate.source?.batch_slug
    ),
    source_url: canonical.sourceUrl || null,
    observed_at: candidate.observedAt,
    url_classification: canonical.classification,
    canonicalization_reason: canonical.reason,
    traction_eligible: tractionEligible,
    rejection_reasons: uniqueStrings(reasons),
    ...detail
  });
}

function normalizeAttributionReconciliationLedger(value, catalogMaps, normalizedCandidates = []) {
  if (value == null) return { received: 0, entries: [], skipped: [] };
  if (!Array.isArray(value)) {
    throw new TypeError("attributionReconciliationLedger must be an array.");
  }
  const normalized = value.map((entry, index) =>
    normalizeAttributionReconciliationEntry(entry, index, catalogMaps, normalizedCandidates)
  );
  const skipped = normalized.filter((entry) => entry?.skip).map((entry) => entry.skip);
  const entries = normalized.filter((entry) => !entry?.skip);
  const seen = new Set();
  for (const entry of entries) {
    const key = `${entry.key}:${reconciliationTargetKey(entry.staleAttribution)}`;
    if (seen.has(key)) {
      throw new Error(
        `attributionReconciliationLedger entry ${entry.ordinal} duplicates an earlier stale attribution directive.`
      );
    }
    seen.add(key);
  }
  return { received: value.length, entries, skipped };
}

function normalizeAttributionReconciliationEntry(entry, index, catalogMaps, normalizedCandidates = []) {
  const ordinal = index + 1;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new TypeError(`attributionReconciliationLedger entry ${ordinal} must be an object.`);
  }
  const platform = normalizePlatform(entry.platform);
  const sourceUrl = firstString(entry.sourceUrl, entry.canonicalUrl, entry.url);
  const canonical = canonicalizeUrl(platform, sourceUrl);
  if (canonical.classification !== "native_object" || !canonical.nativeId || !canonical.canonicalUrl) {
    throw new Error(
      `attributionReconciliationLedger entry ${ordinal} must identify a platform-native physical item.`
    );
  }
  const suppliedNativeId = normalizeSuppliedNativeId(
    platform,
    entry.platformPostId ?? entry.platformObjectId ?? entry.nativeId
  );
  if ((entry.platformPostId != null || entry.platformObjectId != null || entry.nativeId != null) && !suppliedNativeId) {
    throw new Error(`attributionReconciliationLedger entry ${ordinal} has an invalid explicit native id.`);
  }
  if (suppliedNativeId && suppliedNativeId !== canonical.nativeId) {
    throw new Error(
      `attributionReconciliationLedger entry ${ordinal} has a native id conflict: ` +
      `url=${canonical.nativeId}; explicit=${suppliedNativeId}.`
    );
  }
  const evidenceKind = evidenceKindFor(platform, canonical.objectType, canonical.classification);
  const canonicalKeyValue = canonicalKey(platform, evidenceKind, canonical.nativeId, canonical.canonicalUrl);
  if (!canonicalKeyValue) {
    throw new Error(`attributionReconciliationLedger entry ${ordinal} has no canonical physical key.`);
  }
  const disposition = nonBlank(entry.disposition)?.toLowerCase();
  if (!RECONCILIATION_DISPOSITIONS.has(disposition)) {
    throw new Error(
      `attributionReconciliationLedger entry ${ordinal} disposition must be reattributed or quarantined.`
    );
  }
  const reason = nonBlank(entry.reason);
  if (!reason) throw new Error(`attributionReconciliationLedger entry ${ordinal} requires a reason.`);
  const replacementAttribution = entry.replacementAttribution == null
    ? null
    : normalizeReconciliationTarget(
        entry.replacementAttribution,
        `entry ${ordinal} replacementAttribution`,
        catalogMaps
      );
  if (disposition === "reattributed" && !replacementAttribution) {
    throw new Error(
      `attributionReconciliationLedger entry ${ordinal} reattributed disposition requires replacementAttribution.`
    );
  }
  if (disposition === "quarantined" && replacementAttribution) {
    throw new Error(
      `attributionReconciliationLedger entry ${ordinal} quarantined disposition cannot have replacementAttribution.`
    );
  }
  const staleAttribution = normalizeReconciliationTarget(
    entry.staleAttribution,
    `entry ${ordinal} staleAttribution`,
    catalogMaps,
    { allowMissingEntity: true }
  );
  if (!staleAttribution) {
    if (
      disposition === "reattributed" &&
      !hasReconciliationCandidateAttribution(
        normalizedCandidates,
        `${platform}\u0000${canonicalKeyValue}`,
        replacementAttribution,
        catalogMaps
      )
    ) {
      throw new Error(
        `attributionReconciliationLedger entry ${ordinal} staleAttribution did not resolve entity ` +
        `${nonBlank(entry.staleAttribution?.entityId ?? entry.staleAttribution?.entity_id)} in batch ` +
        `${nonBlank(entry.staleAttribution?.batchSlug ?? entry.staleAttribution?.batch_slug)}.`
      );
    }
    return {
      skip: {
        ordinal,
        disposition,
        reason: "stale_entity_not_in_current_catalog",
        entityType: normalizedEntityType(entry.staleAttribution?.entityType ?? entry.staleAttribution?.entity_type),
        entityId: nonBlank(entry.staleAttribution?.entityId ?? entry.staleAttribution?.entity_id),
        batchSlug: nonBlank(entry.staleAttribution?.batchSlug ?? entry.staleAttribution?.batch_slug)
      }
    };
  }
  if (replacementAttribution && sameReconciliationTarget(staleAttribution, replacementAttribution)) {
    throw new Error(
      `attributionReconciliationLedger entry ${ordinal} replacementAttribution equals staleAttribution.`
    );
  }
  return {
    ordinal,
    platform,
    sourceUrl: canonical.canonicalUrl,
    nativeId: canonical.nativeId,
    canonicalKey: canonicalKeyValue,
    key: `${platform}\u0000${canonicalKeyValue}`,
    disposition,
    reason,
    staleAttribution,
    replacementAttribution,
    evidenceId: null,
    replacementAttributionId: null
  };
}

function hasReconciliationCandidateAttribution(normalizedCandidates, key, target, catalogMaps) {
  if (!target) return false;
  return normalizedCandidates.some((item) => {
    if (!item?.verified || item.key !== key) return false;
    const candidateTarget = resolvedAttributionTarget(item, catalogMaps);
    return candidateTarget && sameReconciliationTarget(candidateTarget, target);
  });
}

function normalizeReconciliationTarget(value, label, catalogMaps, { allowMissingEntity = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`attributionReconciliationLedger ${label} must be an object.`);
  }
  const entityType = normalizedEntityType(value.entityType ?? value.entity_type);
  const entityId = nonBlank(value.entityId ?? value.entity_id);
  const batchSlug = nonBlank(value.batchSlug ?? value.batch_slug);
  const attributionType = nonBlank(value.attributionType ?? value.attribution_type ?? "subject")?.toLowerCase();
  if (!entityType) throw new Error(`attributionReconciliationLedger ${label} has an invalid entityType.`);
  if (!entityId) throw new Error(`attributionReconciliationLedger ${label} requires entityId.`);
  if (!batchSlug) throw new Error(`attributionReconciliationLedger ${label} requires batchSlug.`);
  if (!ATTRIBUTION_TYPES.has(attributionType)) {
    throw new Error(`attributionReconciliationLedger ${label} has an invalid attributionType.`);
  }
  const targetId = resolveCatalogId(catalogMaps, entityType, [entityId], batchSlug);
  if (!targetId) {
    if (allowMissingEntity) return null;
    throw new Error(
      `attributionReconciliationLedger ${label} did not resolve entity ${entityId} in batch ${batchSlug}.`
    );
  }
  const batchId = resolveBatchId(catalogMaps, batchSlug);
  if (!batchId) {
    throw new Error(`attributionReconciliationLedger ${label} did not resolve batch ${batchSlug}.`);
  }
  const founderBatchCount = entityType === "founder"
    ? Number(catalogValue(catalogMaps.founderBatchCountById, targetId) ?? 1)
    : 1;
  return {
    batchSlug,
    batchId,
    entityType,
    entityId,
    targetId,
    targetColumn: entityType === "company" ? "company_id" : "founder_id",
    attributionType,
    legacyNullBatchSafe: entityType === "company" || founderBatchCount <= 1
  };
}

function reconciliationTargetKey(target) {
  return [
    target.batchId,
    target.entityType,
    target.targetId,
    target.attributionType
  ].join(":");
}

function sameReconciliationTarget(left, right) {
  return reconciliationTargetKey(left) === reconciliationTargetKey(right);
}

function assertReconciliationCandidates(entries, normalized, catalogMaps) {
  if (entries.length === 0) return;
  const generatedTargets = normalized.flatMap((item) => {
    if (!item.verified || !item.key) return [];
    const target = resolvedAttributionTarget(item, catalogMaps);
    return target ? [{ item, target }] : [];
  });
  for (const entry of entries) {
    const physicalTargets = generatedTargets.filter(({ item }) => item.key === entry.key);
    if (physicalTargets.some(({ target }) => sameReconciliationTarget(target, entry.staleAttribution))) {
      throw new Error(
        `attributionReconciliationLedger entry ${entry.ordinal} stale attribution is still present in sanitized snapshots.`
      );
    }
    if (
      entry.replacementAttribution &&
      !physicalTargets.some(({ target }) => sameReconciliationTarget(target, entry.replacementAttribution))
    ) {
      throw new Error(
        `attributionReconciliationLedger entry ${entry.ordinal} replacement attribution is absent from sanitized snapshots.`
      );
    }
  }
}

async function resolveReconciliationEvidenceIds({ client, entries, evidenceIds }) {
  if (entries.length === 0) return { resolved: 0, missing: 0 };
  for (const entry of entries) entry.evidenceId = evidenceIds.get(entry.key) ?? null;
  const missingKeys = [...new Set(
    entries.filter((entry) => !entry.evidenceId).map((entry) => entry.canonicalKey)
  )];
  if (missingKeys.length > 0) {
    const response = await client
      .from("evidence_items")
      .select("id,platform,canonical_key")
      .in("canonical_key", missingKeys);
    const rows = checkedRows(response, "read reconciliation evidence_items");
    for (const row of rows) {
      const key = `${normalizePlatform(row.platform)}\u0000${row.canonical_key}`;
      if (evidenceIds.has(key) && evidenceIds.get(key) !== row.id) {
        throw new Error(`read reconciliation evidence_items: conflicting ids for ${row.canonical_key}.`);
      }
      if (nonBlank(row.id)) evidenceIds.set(key, row.id);
    }
    for (const entry of entries) entry.evidenceId ??= evidenceIds.get(entry.key) ?? null;
  }
  for (const entry of entries) {
    if (entry.replacementAttribution && !entry.evidenceId) {
      throw new Error(
        `attributionReconciliationLedger entry ${entry.ordinal} replacement has no durable evidence item.`
      );
    }
  }
  return {
    resolved: entries.filter((entry) => entry.evidenceId).length,
    missing: entries.filter((entry) => !entry.evidenceId).length
  };
}

async function retireEnumeratedAttributions({
  client,
  entries,
  generatedAttributions,
  now,
  evidenceResolution,
  received
}) {
  const summary = {
    received,
    unique: entries.length,
    evidenceResolved: evidenceResolution.resolved,
    evidenceMissing: evidenceResolution.missing,
    retired: 0,
    alreadyRetired: 0,
    staleNotFound: 0,
    legacyNullRetired: 0,
    legacyAmbiguousInactive: 0,
    replacementsExpected: entries.filter((entry) => entry.replacementAttribution).length
  };
  if (entries.length === 0) return summary;

  for (const entry of entries) {
    if (!entry.replacementAttribution) continue;
    const replacement = generatedAttributions.find((row) =>
      row.evidence_id === entry.evidenceId && attributionMatchesTarget(row, entry.replacementAttribution)
    );
    if (!replacement) {
      throw new Error(
        `attributionReconciliationLedger entry ${entry.ordinal} generated no exact replacement attribution.`
      );
    }
    entry.replacementAttributionId = replacement.id;
  }

  const evidenceIdValues = [...new Set(entries.map((entry) => entry.evidenceId).filter(Boolean))];
  let existing = [];
  if (evidenceIdValues.length > 0) {
    const response = await client
      .from("evidence_attributions")
      .select(ATTRIBUTION_READ_COLUMNS)
      .in("evidence_id", evidenceIdValues);
    existing = checkedRows(response, "read existing evidence_attributions for reconciliation");
  }

  for (const entry of entries) {
    if (!entry.evidenceId) {
      summary.staleNotFound += 1;
      continue;
    }
    const staleRows = existing.filter((row) =>
      row.evidence_id === entry.evidenceId && staleAttributionMatchesTarget(row, entry.staleAttribution)
    );
    if (staleRows.length === 0) {
      summary.staleNotFound += 1;
      continue;
    }
    for (const stale of staleRows) {
      if (stale.batch_id == null && !entry.staleAttribution.legacyNullBatchSafe) {
        if (stale.score_eligible !== false) {
          throw new Error(
            `attributionReconciliationLedger entry ${entry.ordinal} found an active legacy null-batch ` +
            "shared-founder attribution; exact cohort retirement is ambiguous."
          );
        }
        summary.legacyAmbiguousInactive += 1;
        continue;
      }
      if (isCompletedReconciliation(stale, entry)) {
        summary.alreadyRetired += 1;
        continue;
      }
      const update = retiredAttributionUpdate(stale, entry, now);
      const response = await client
        .from("evidence_attributions")
        .update(update)
        .eq("id", stale.id)
        .select(ATTRIBUTION_READ_COLUMNS);
      const updated = checkedRows(response, `retire evidence_attribution ${stale.id}`);
      if (updated.length !== 1 || updated[0].id !== stale.id || !isCompletedReconciliation(updated[0], entry)) {
        throw new Error(`retire evidence_attribution ${stale.id}: exact read-back assertion failed.`);
      }
      summary.retired += 1;
      if (stale.batch_id == null) summary.legacyNullRetired += 1;
    }
  }
  return summary;
}

function retiredAttributionUpdate(stale, entry, now) {
  const previousReconciliation = stale.metadata_json?.attribution_reconciliation;
  const retiredAt = validTimestamp(previousReconciliation?.retired_at) ?? now;
  return {
    is_primary: false,
    score_eligible: false,
    review_state: "rejected",
    risk_level: "high",
    match_reason: `Retired by explicit ${entry.disposition} reconciliation: ${entry.reason}`,
    reviewed_at: now,
    metadata_json: cleanJson({
      ...(stale.metadata_json ?? {}),
      attribution_reconciliation: {
        schema_version: 1,
        disposition: entry.disposition,
        reason: entry.reason,
        retired_at: retiredAt,
        stale: reconciliationTargetMetadata(entry.staleAttribution),
        replacement: entry.replacementAttribution
          ? {
              ...reconciliationTargetMetadata(entry.replacementAttribution),
              attribution_id: entry.replacementAttributionId
            }
          : null
      }
    })
  };
}

function reconciliationTargetMetadata(target) {
  return {
    batch_slug: target.batchSlug,
    batch_id: target.batchId,
    entity_type: target.entityType,
    entity_id: target.entityId,
    target_id: target.targetId,
    attribution_type: target.attributionType
  };
}

function isCompletedReconciliation(row, entry) {
  const metadata = row?.metadata_json?.attribution_reconciliation;
  return Boolean(
    row?.is_primary === false &&
    row?.score_eligible === false &&
    row?.review_state === "rejected" &&
    row?.risk_level === "high" &&
    metadata?.schema_version === 1 &&
    metadata?.disposition === entry.disposition &&
    metadata?.reason === entry.reason &&
    reconciliationMetadataMatchesTarget(metadata?.stale, entry.staleAttribution) &&
    (
      entry.replacementAttribution
        ? reconciliationMetadataMatchesTarget(metadata?.replacement, entry.replacementAttribution)
        : metadata?.replacement == null
    ) &&
    (metadata?.replacement?.attribution_id ?? null) === (entry.replacementAttributionId ?? null)
  );
}

function reconciliationMetadataMatchesTarget(metadata, target) {
  return Boolean(
    metadata?.batch_slug === target.batchSlug &&
    metadata?.batch_id === target.batchId &&
    metadata?.entity_type === target.entityType &&
    metadata?.entity_id === target.entityId &&
    metadata?.target_id === target.targetId &&
    metadata?.attribution_type === target.attributionType
  );
}

async function assertAttributionReconciliationReadBack({ client, entries, generatedAttributions }) {
  const evidenceIds = [...new Set(entries.map((entry) => entry.evidenceId).filter(Boolean))];
  if (evidenceIds.length === 0) return;
  const response = await client
    .from("evidence_attributions")
    .select(ATTRIBUTION_READ_COLUMNS)
    .in("evidence_id", evidenceIds);
  const rows = checkedRows(response, "read back reconciled evidence_attributions");
  for (const entry of entries) {
    if (!entry.evidenceId) continue;
    const staleRows = rows.filter((row) =>
      row.evidence_id === entry.evidenceId && staleAttributionMatchesTarget(row, entry.staleAttribution)
    );
    if (staleRows.some((row) => {
      if (row.batch_id == null && !entry.staleAttribution.legacyNullBatchSafe) {
        return row.score_eligible !== false;
      }
      return !isCompletedReconciliation(row, entry);
    })) {
      throw new Error(
        `attributionReconciliationLedger entry ${entry.ordinal} left a stale attribution active or unverified.`
      );
    }
    if (entry.replacementAttribution) {
      const expected = generatedAttributions.find((row) => row.id === entry.replacementAttributionId);
      const replacement = rows.find((row) => row.id === entry.replacementAttributionId);
      if (
        !expected ||
        !replacement ||
        !attributionMatchesTarget(replacement, entry.replacementAttribution) ||
        replacement.review_state !== "verified" ||
        replacement.risk_level !== "low" ||
        replacement.score_eligible !== expected.score_eligible
      ) {
        throw new Error(
          `attributionReconciliationLedger entry ${entry.ordinal} replacement read-back assertion failed.`
        );
      }
    }
  }
}

function attributionMatchesTarget(row, target) {
  return Boolean(
    row?.entity_type === target.entityType &&
    row?.batch_id === target.batchId &&
    row?.[target.targetColumn] === target.targetId &&
    row?.attribution_type === target.attributionType
  );
}

function staleAttributionMatchesTarget(row, target) {
  return Boolean(
    row?.entity_type === target.entityType &&
    (row?.batch_id === target.batchId || row?.batch_id == null) &&
    row?.[target.targetColumn] === target.targetId &&
    row?.attribution_type === target.attributionType
  );
}

function resolvedAttributionTarget(item, catalogMaps) {
  const targetId = resolveCatalogId(catalogMaps, item.entityType, item.entityKeys, item.batchSlug);
  if (!targetId || !item.entityType) return null;
  const batchId = resolveBatchId(catalogMaps, item.batchSlug);
  if (item.batchSlug && hasBatchCatalog(catalogMaps) && !batchId) return null;
  return {
    batchSlug: item.batchSlug,
    batchId,
    entityType: item.entityType,
    entityId: nonBlank(item.row?.entityId) ?? nonBlank(item.entityKeys[0]) ?? targetId,
    targetId,
    targetColumn: item.entityType === "company" ? "company_id" : "founder_id",
    attributionType: item.attributionType
  };
}

function attributionRow(item, evidenceId, catalogMaps) {
  const target = resolvedAttributionTarget(item, catalogMaps);
  if (!target) return null;
  const founderBatchCount = Number(catalogValue(catalogMaps.founderBatchCountById, target.targetId) ?? 1);
  const sharedFounderBatch = item.entityType === "founder" && founderBatchCount > 1
    ? item.batchSlug ?? "legacy"
    : null;
  // Company ids are already cohort-specific, and single-cohort founder ids can
  // retain the pre-migration UUID. Only a founder shared across cohorts needs
  // a distinct attribution UUID per batch.
  const baseIdentity = `${evidenceId}:${item.entityType}:${target.targetId}:${item.attributionType}`;
  const identity = sharedFounderBatch ? `${baseIdentity}:${sharedFounderBatch}` : baseIdentity;
  return {
    id: stableUuid(identity),
    evidence_id: evidenceId,
    entity_type: item.entityType,
    company_id: null,
    founder_id: null,
    batch_id: target.batchId,
    [target.targetColumn]: target.targetId,
    attribution_type: item.attributionType,
    is_primary: false,
    score_eligible: item.tractionEligible,
    review_state: "verified",
    risk_level: "low",
    match_reason: item.matchReason,
    source_url: item.attributionSourceUrl,
    reviewed_at: item.observedAt,
    metadata_json: cleanJson({
      imported_by: "durable_evidence_import",
      source_kind: item.candidate.kind,
      batch_slug: item.batchSlug,
      rejection_reasons: item.reasons
    })
  };
}

function metricRows(item, evidenceId, ingestionRunId) {
  return Object.entries(item.metrics).map(([metricName, metricValue]) => ({
    evidence_id: evidenceId,
    ingestion_run_id: ingestionRunId,
    metric_name: metricName,
    metric_value: metricValue,
    metric_unit: "count",
    observed_at: item.observedAt,
    source_name: item.sourceName,
    source_url: item.sourceUrl,
    is_estimated: false,
    metadata_json: cleanJson({
      imported_by: "durable_evidence_import",
      source_kind: item.candidate.kind,
      batch_slug: item.batchSlug
    })
  }));
}

function resolveCatalogId(catalogMaps, entityType, keys, batchSlug = null) {
  if (!entityType) return null;
  const batchCollections = entityType === "company"
    ? [
        catalogMaps.companyByBatchEntityId,
        catalogMaps.companiesByBatchEntityId,
        catalogMaps.companyIdsByBatchEntityId,
        catalogMaps.companyByBatchSlug,
        catalogMaps.companiesByBatchSlug,
        catalogMaps.companyIdsByBatchSlug
      ]
    : [
        catalogMaps.founderByBatchEntityId,
        catalogMaps.foundersByBatchEntityId,
        catalogMaps.founderIdsByBatchEntityId
      ];
  if (batchSlug && batchCollections.some(Boolean)) {
    for (const collection of batchCollections) {
      for (const rawKey of keys) {
        const key = nonBlank(rawKey);
        if (!key) continue;
        const value = batchCatalogValue(collection, batchSlug, key);
        const id = catalogId(value, entityType);
        if (id) return id;
      }
    }
    // A batch-aware caller must never silently attribute an unresolved row to
    // an identically named entity from another cohort.
    return null;
  }
  const collections = entityType === "company"
    ? [
        catalogMaps.companies,
        catalogMaps.companyIds,
        catalogMaps.company,
        catalogMaps.companyByEntityId,
        catalogMaps.companiesByEntityId,
        catalogMaps.companyIdsByEntityId,
        catalogMaps.companyBySlug,
        catalogMaps.companiesBySlug,
        catalogMaps.companyIdsBySlug
      ]
    : [
        catalogMaps.founders,
        catalogMaps.founderIds,
        catalogMaps.founder,
        catalogMaps.founderByEntityId,
        catalogMaps.foundersByEntityId,
        catalogMaps.founderIdsByEntityId
      ];
  for (const collection of collections) {
    for (const rawKey of keys) {
      const key = nonBlank(rawKey);
      if (!key) continue;
      const value = catalogValue(collection, key);
      const id = catalogId(value, entityType);
      if (id) return id;
    }
  }
  return null;
}

function resolveBatchId(catalogMaps, batchSlug) {
  const slug = nonBlank(batchSlug);
  if (!slug) return null;
  for (const collection of [catalogMaps.batchBySlug, catalogMaps.batchesBySlug, catalogMaps.batchIdsBySlug]) {
    const id = catalogId(catalogValue(collection, slug), "batch");
    if (id) return id;
  }
  return null;
}

function hasBatchCatalog(catalogMaps) {
  return Boolean(catalogMaps.batchBySlug || catalogMaps.batchesBySlug || catalogMaps.batchIdsBySlug);
}

function batchCatalogValue(collection, batchSlug, key) {
  if (!collection) return null;
  const nested = catalogValue(collection, batchSlug);
  const nestedValue = catalogValue(nested, key);
  if (nestedValue != null) return nestedValue;
  return catalogValue(collection, batchCatalogKey(batchSlug, key));
}

function batchCatalogKey(batchSlug, key) {
  return `${batchSlug}\u0000${key}`;
}

function catalogValue(collection, key) {
  if (collection instanceof Map) {
    return collection.get(key) ?? collection.get(key.toLowerCase());
  }
  if (collection && typeof collection === "object" && !Array.isArray(collection)) {
    return collection[key] ?? collection[key.toLowerCase()];
  }
  return null;
}

function catalogId(value, entityType) {
  if (typeof value === "string") return nonBlank(value);
  if (!value || typeof value !== "object") return null;
  return nonBlank(value.id ?? value[`${entityType}_id`] ?? value[`${entityType}Id`]);
}

function canonicalizeUrl(platform, rawUrl) {
  const sourceUrl = nonBlank(rawUrl) ?? "";
  const url = parseHttpUrl(sourceUrl);
  if (!url) return canonicalResult(sourceUrl, null, null, null, "invalid", "invalid_url");
  stripUrlNoise(url);
  const host = normalizedHost(url.hostname);
  const path = normalizedPath(url.pathname);

  if (platform === "x") {
    if (!hostMatches(host, "x.com", "twitter.com")) return hostMismatch(sourceUrl, url);
    const userStatus = path.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/i);
    if (userStatus) {
      return canonicalResult(sourceUrl, `https://x.com/${userStatus[1].toLowerCase()}/status/${userStatus[2]}`, userStatus[2], "post", "native_object", null);
    }
    const webStatus = path.match(/^\/i\/(?:web\/)?status\/(\d+)/i);
    if (webStatus) return canonicalResult(sourceUrl, `https://x.com/i/status/${webStatus[1]}`, webStatus[1], "post", "native_object", null);
    return contextResult(sourceUrl, canonicalWith(url, "x.com", path), routeClass(path, ["/search", "/hashtag", "/explore"], [/^\/[A-Za-z0-9_]{1,15}(?:\/with_replies|\/media|\/likes)?$/i]));
  }

  if (platform === "youtube") {
    let id = null;
    if (host === "youtu.be") id = validObjectId(path.slice(1));
    if (hostMatches(host, "youtube.com", "youtube-nocookie.com")) {
      if (path === "/watch") id = validObjectId(url.searchParams.get("v"));
      id ??= path.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]+)$/i)?.[1] ?? null;
    }
    if (id) return canonicalResult(sourceUrl, `https://youtube.com/watch?v=${id}`, id, "video", "native_object", null);
    if (!hostMatches(host, "youtube.com", "youtube-nocookie.com", "youtu.be")) return hostMismatch(sourceUrl, url);
    return contextResult(sourceUrl, canonicalWith(url, "youtube.com", path), routeClass(path, ["/results", "/search"], [/^\/@[^/]+$/i, /^\/(?:channel|c|user)\/[^/]+$/i]));
  }

  if (platform === "github") {
    if (host !== "github.com") return hostMismatch(sourceUrl, url);
    const parts = path.split("/").filter(Boolean);
    const owner = parts[0] ?? "";
    const repository = (parts[1] ?? "").replace(/\.git$/i, "");
    if (validGithubRepository(owner, repository)) {
      const id = `${owner.toLowerCase()}/${repository.toLowerCase()}`;
      return canonicalResult(sourceUrl, `https://github.com/${id}`, id, "repository", "native_object", null);
    }
    const classification = path === "/search" || path.startsWith("/search/")
      ? "search"
      : parts.length === 1 && GITHUB_OWNER.test(owner) ? "profile" : "context";
    return contextResult(sourceUrl, canonicalWith(url, "github.com", path), classification);
  }

  if (platform === "reddit") {
    const postId = host === "redd.it"
      ? path.split("/").filter(Boolean)[0]
      : path.match(/^\/(?:r\/[^/]+\/)?comments\/([A-Za-z0-9]+)/i)?.[1];
    if (postId && /^[A-Za-z0-9]+$/.test(postId) && hostMatches(host, "reddit.com", "redd.it")) {
      const id = postId.toLowerCase();
      return canonicalResult(sourceUrl, `https://reddit.com/comments/${id}`, id, "post", "native_object", null);
    }
    if (!hostMatches(host, "reddit.com", "redd.it")) return hostMismatch(sourceUrl, url);
    const classification = path === "/search" || path.startsWith("/search/")
      ? "search" : /^\/(?:r|user|u)\/[^/]+$/i.test(path) ? "profile" : "context";
    return contextResult(sourceUrl, canonicalWith(url, "reddit.com", path), classification);
  }

  if (platform === "product_hunt") {
    if (host !== "producthunt.com") return hostMismatch(sourceUrl, url);
    const native = path.match(/^\/(posts\/[A-Za-z0-9][A-Za-z0-9_-]*|products\/[A-Za-z0-9][A-Za-z0-9_-]*\/launches\/[A-Za-z0-9][A-Za-z0-9_-]*|p\/[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9_-]*)$/i)?.[1];
    if (native) {
      const id = native.toLowerCase();
      return canonicalResult(sourceUrl, `https://producthunt.com/${id}`, id, "launch", "native_object", null);
    }
    const classification = path === "/search" || path.startsWith("/search/")
      ? "search" : /^\/(?:products|@)\/[^/]+$/i.test(path) || /^\/@[^/]+$/i.test(path) ? "profile" : "context";
    return contextResult(sourceUrl, canonicalWith(url, "producthunt.com", path), classification);
  }

  if (platform === "hacker_news") {
    if (host !== "news.ycombinator.com") return hostMismatch(sourceUrl, url);
    const id = path === "/item" && /^\d+$/.test(url.searchParams.get("id") ?? "") ? url.searchParams.get("id") : null;
    if (id) return canonicalResult(sourceUrl, `https://news.ycombinator.com/item?id=${id}`, id, "post", "native_object", null);
    return contextResult(sourceUrl, canonicalWith(url, host, path), path === "/user" ? "profile" : path === "/from" ? "search" : "context");
  }

  if (platform === "instagram") {
    if (host !== "instagram.com") return hostMismatch(sourceUrl, url);
    const post = path.match(/^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)$/i);
    if (post) {
      const route = post[1].toLowerCase() === "reels" ? "reel" : post[1].toLowerCase();
      return canonicalResult(sourceUrl, `https://instagram.com/${route}/${post[2]}`, post[2], "post", "native_object", null);
    }
    return contextResult(sourceUrl, canonicalWith(url, host, path), path === "/explore" || path.startsWith("/explore/") ? "search" : /^\/[A-Za-z0-9._]+$/i.test(path) ? "profile" : "context");
  }

  if (platform === "linkedin") {
    if (host !== "linkedin.com") return hostMismatch(sourceUrl, url);
    const decodedPath = safeDecode(path);
    const id = decodedPath.match(/^\/feed\/update\/urn:li:activity:(\d+)/i)?.[1]
      ?? decodedPath.match(/^\/posts\/[^/]*activity[-:](\d+)[^/]*$/i)?.[1]
      ?? null;
    if (id) return canonicalResult(sourceUrl, `https://linkedin.com/feed/update/urn:li:activity:${id}`, id, "post", "native_object", null);
    return contextResult(sourceUrl, canonicalWith(url, host, path), path === "/search" || path.startsWith("/search/") ? "search" : /^\/(?:in|company|school|showcase)\/[^/]+$/i.test(path) ? "profile" : "context");
  }

  if (platform === "bluesky") {
    if (host !== "bsky.app") return hostMismatch(sourceUrl, url);
    const post = path.match(/^\/profile\/([^/]+)\/post\/([A-Za-z0-9._~:-]+)$/i);
    if (post) {
      const id = `${post[1].toLowerCase()}/post/${post[2]}`;
      return canonicalResult(sourceUrl, `https://bsky.app/profile/${id}`, id, "post", "native_object", null);
    }
    return contextResult(sourceUrl, canonicalWith(url, host, path), path === "/search" || path.startsWith("/search/") ? "search" : /^\/profile\/[^/]+$/i.test(path) ? "profile" : "context");
  }

  if (platform === "tiktok") {
    if (host !== "tiktok.com") return hostMismatch(sourceUrl, url);
    const video = path.match(/^\/@([A-Za-z0-9._-]+)\/video\/(\d+)$/i);
    if (video) {
      return canonicalResult(sourceUrl, `https://tiktok.com/@${video[1].toLowerCase()}/video/${video[2]}`, video[2], "video", "native_object", null);
    }
    return contextResult(sourceUrl, canonicalWith(url, host, path), path === "/search" || path.startsWith("/search/") ? "search" : /^\/@[A-Za-z0-9._-]+$/i.test(path) ? "profile" : "context");
  }

  if (platform === "bilibili") {
    if (host !== "bilibili.com") return hostMismatch(sourceUrl, url);
    const video = path.match(/^\/video\/((?:BV[A-Za-z0-9]+)|(?:av\d+))$/i)?.[1];
    if (video) {
      const id = /^bv/i.test(video) ? `BV${video.slice(2)}` : `av${video.replace(/^av/i, "")}`;
      return canonicalResult(sourceUrl, `https://bilibili.com/video/${id}`, id, "video", "native_object", null);
    }
    return contextResult(sourceUrl, canonicalWith(url, host, path), path === "/search" || path.startsWith("/search/") ? "search" : /^\/\d+$/i.test(path) || path.startsWith("/space/") ? "profile" : "context");
  }

  const canonicalUrl = canonicalWith(url, host, path);
  const reason = platform === "web" || platform === "rss" ? "context_only_platform" : "unsupported_platform";
  return canonicalResult(sourceUrl, canonicalUrl, null, null, "context", reason);
}

function normalizeMetrics(metrics) {
  const values = {};
  let invalid = false;
  if (metrics == null) return { values, invalid };
  if (typeof metrics !== "object" || Array.isArray(metrics)) return { values, invalid: true };
  for (const [rawName, rawValue] of Object.entries(metrics)) {
    const name = metricName(rawName);
    if (!name || DERIVED_METRICS.has(name)) continue;
    if (rawValue == null) continue;
    if (typeof rawValue !== "number" || !Number.isFinite(rawValue) || rawValue < 0) {
      invalid = true;
      continue;
    }
    values[name] = rawValue;
  }
  return { values, invalid };
}

function metricName(value) {
  const normalized = String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z][a-z0-9_]*$/.test(normalized) ? normalized : null;
}

function evidenceKindFor(platform, objectType, classification) {
  if (classification === "profile") return "account";
  if (objectType === "repository") return "repository";
  if (objectType === "video") return "video";
  if (objectType === "launch") return "launch";
  if (objectType === "post") return "post";
  if (platform === "web" || platform === "rss") return "article";
  return "other";
}

function canonicalKey(platform, evidenceKind, nativeId, canonicalUrl) {
  if (nativeId) return `${platform}:${evidenceKind}:${nativeId}`;
  if (canonicalUrl) return `${platform}:${evidenceKind}:url:${canonicalUrl}`;
  return null;
}

function normalizeSuppliedNativeId(platform, value) {
  const id = nonBlank(value);
  if (!id) return null;
  if (platform === "x" || platform === "hacker_news" || platform === "linkedin") return /^\d+$/.test(id) ? id : null;
  if (platform === "github") return normalizeGithubRepositoryId(id);
  if (platform === "reddit") return /^[A-Za-z0-9]+$/.test(id) ? id.toLowerCase() : null;
  if (platform === "product_hunt") return /^(?:posts|products|p)\//i.test(id) ? id.toLowerCase() : null;
  return /^[A-Za-z0-9._~:/-]+$/.test(id) ? id : null;
}

function normalizeGithubRepositoryId(value) {
  const id = nonBlank(value)?.replace(/^\/+|\/+$/g, "");
  if (!id) return null;
  const [owner, repository, ...rest] = id.split("/");
  if (rest.length || !validGithubRepository(owner, repository?.replace(/\.git$/i, ""))) return null;
  return `${owner.toLowerCase()}/${repository.replace(/\.git$/i, "").toLowerCase()}`;
}

function normalizeGithubOwner(value) {
  const owner = nonBlank(value);
  return owner && GITHUB_OWNER.test(owner) && !GITHUB_RESERVED_OWNERS.has(owner.toLowerCase())
    ? owner.toLowerCase() : null;
}

function validGithubRepository(owner, repository) {
  return Boolean(
    owner && repository && GITHUB_OWNER.test(owner) && GITHUB_REPOSITORY.test(repository)
    && !GITHUB_RESERVED_OWNERS.has(owner.toLowerCase()) && repository !== "." && repository !== ".."
  );
}

function mergeEvidenceRows(target, source, duplicateCount) {
  target.first_seen_at = earlierTimestamp(target.first_seen_at, source.first_seen_at);
  target.last_seen_at = laterTimestamp(target.last_seen_at, source.last_seen_at);
  target.published_at = target.published_at ?? source.published_at;
  target.content_fingerprint = target.content_fingerprint ?? source.content_fingerprint;
  target.metadata_json = cleanJson({
    ...target.metadata_json,
    duplicate_count: duplicateCount,
    batch_slugs: uniqueStrings([
      ...(target.metadata_json.batch_slugs ?? []),
      target.metadata_json.batch_slug,
      ...(source.metadata_json.batch_slugs ?? []),
      source.metadata_json.batch_slug
    ]),
    rejection_reasons: uniqueStrings([
      ...(target.metadata_json.rejection_reasons ?? []),
      ...(source.metadata_json.rejection_reasons ?? [])
    ]),
    traction_eligible: Boolean(target.metadata_json.traction_eligible || source.metadata_json.traction_eligible)
  });
}

function uniqueRows(rows, keyFor) {
  const values = new Map();
  let duplicates = 0;
  for (const row of rows) {
    const key = keyFor(row);
    if (values.has(key)) duplicates += 1;
    values.set(key, row);
  }
  return { rows: [...values.values()], duplicates };
}

function checkedRows(response, operation) {
  const data = checkedResponse(response, operation);
  if (!Array.isArray(data)) throw new Error(`${operation}: Supabase returned non-array data.`);
  return data;
}

function checkedResponse(response, operation) {
  if (!response || typeof response !== "object") {
    throw new Error(`${operation}: Supabase returned no response.`);
  }
  if (response.error) {
    const code = nonBlank(response.error.code);
    const details = nonBlank(response.error.details ?? response.error.hint);
    throw new Error(`${operation}: ${response.error.message ?? String(response.error)}${code ? ` (${code})` : ""}${details ? `: ${details}` : ""}`);
  }
  return response.data;
}

function assertCompleteReadBack(expected, actual) {
  const actualKeys = new Set(actual.map((row) => `${row.platform}\u0000${row.canonical_key}`));
  const missing = expected.filter((row) => !actualKeys.has(`${row.platform}\u0000${row.canonical_key}`));
  if (missing.length > 0) {
    throw new Error(`upsert and read back evidence_items: ${missing.length} canonical row(s) were not returned.`);
  }
  for (const row of actual) {
    if (!nonBlank(row.id)) throw new Error("upsert and read back evidence_items: a row has no id.");
  }
}

function rejectionSummary(item) {
  return cleanJson({
    source_kind: item.candidate.kind,
    source_url: item.canonical.sourceUrl,
    platform: item.platform,
    reasons: item.reasons.length ? item.reasons : ["missing_canonical_identity"]
  });
}

function normalizePlatform(value) {
  const key = String(value ?? "unknown").trim().toLowerCase().replace(/[ -]+/g, "_");
  return PLATFORM_ALIASES[key] ?? (key.replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "unknown");
}

function normalizedEntityType(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "company" || normalized === "founder" ? normalized : null;
}

function normalizedReviewState(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["verified", "needs_review", "rejected"].includes(normalized) ? normalized : null;
}

function githubAttributionVerified(row) {
  const explicit = normalizedReviewState(row.review_state);
  if (explicit) return explicit === "verified";
  return String(row.discoverySource ?? "").trim().toLowerCase() !== "github_search";
}

function sourceTimestamp(snapshot, fallback) {
  return validTimestamp(snapshot.source?.fetchedAt ?? snapshot.fetchedAt) ?? fallback;
}

function validTimestamp(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  const text = nonBlank(value);
  if (!text) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function laterTimestamp(first, second) {
  return Date.parse(second) > Date.parse(first) ? second : first;
}

function earlierTimestamp(first, second) {
  return Date.parse(second) < Date.parse(first) ? second : first;
}

function contentFingerprint(row) {
  const content = nonBlank(row.text ?? row.content ?? row.description ?? row.bio ?? row.title);
  if (!content) return null;
  return createHash("sha256").update(content.trim().replace(/\s+/g, " ").toLowerCase()).digest("hex");
}

function stableUuid(value) {
  const hex = createHash("sha256").update(`durable-evidence-attribution:${value}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const id = hex.join("");
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

function canonicalHttpUrl(value) {
  const url = parseHttpUrl(nonBlank(value) ?? "");
  if (!url) return null;
  stripUrlNoise(url);
  return canonicalWith(url, normalizedHost(url.hostname), normalizedPath(url.pathname));
}

function parseHttpUrl(value) {
  if (!value) return null;
  const candidate = /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || !url.hostname.includes(".")) return null;
    if (url.port && !((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443"))) return null;
    return url;
  } catch {
    return null;
  }
}

function stripUrlNoise(url) {
  url.protocol = "https:";
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMETER.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
}

function normalizedHost(hostname) {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  if (/^(?:mobile|m)\.twitter\.com$/.test(host)) return "twitter.com";
  if (/^(?:mobile|m)\.x\.com$/.test(host)) return "x.com";
  if (/^(?:music|m)\.youtube\.com$/.test(host)) return "youtube.com";
  if (/^(?:old|new|np|m)\.reddit\.com$/.test(host)) return "reddit.com";
  if (/^m\.instagram\.com$/.test(host)) return "instagram.com";
  if (/^m\.linkedin\.com$/.test(host)) return "linkedin.com";
  if (/^m\.tiktok\.com$/.test(host)) return "tiktok.com";
  if (/^m\.bilibili\.com$/.test(host)) return "bilibili.com";
  return host;
}

function normalizedPath(pathname) {
  const path = pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "");
  return path || "/";
}

function canonicalWith(url, host, path) {
  const canonical = new URL(url.toString());
  canonical.protocol = "https:";
  canonical.hostname = host;
  canonical.port = "";
  canonical.pathname = path;
  canonical.hash = "";
  canonical.searchParams.sort();
  return canonical.toString().replace(/\/$/, "");
}

function canonicalResult(sourceUrl, canonicalUrl, nativeId, objectType, classification, reason) {
  return { sourceUrl, canonicalUrl, nativeId, objectType, classification, reason };
}

function contextResult(sourceUrl, canonicalUrl, classification) {
  const reason = classification === "profile" ? "profile_page" : classification === "search" ? "search_page" : "not_native_object";
  return canonicalResult(sourceUrl, canonicalUrl, null, null, classification, reason);
}

function hostMismatch(sourceUrl, url) {
  return canonicalResult(sourceUrl, canonicalWith(url, normalizedHost(url.hostname), normalizedPath(url.pathname)), null, null, "context", "platform_host_mismatch");
}

function routeClass(path, searchRoutes, profilePatterns) {
  if (searchRoutes.some((route) => path === route || path.startsWith(`${route}/`))) return "search";
  if (profilePatterns.some((pattern) => pattern.test(path))) return "profile";
  return "context";
}

function hostMatches(host, ...expected) {
  return expected.includes(host);
}

function validObjectId(value) {
  return value && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function finiteNonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function firstString(...values) {
  for (const value of values) {
    const result = nonBlank(value);
    if (result) return result;
  }
  return "";
}

function nonBlank(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function cleanJson(value) {
  if (Array.isArray(value)) return value.map(cleanJson).filter((item) => item !== undefined);
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
      const cleaned = cleanJson(item);
      if (cleaned !== undefined) result[key] = cleaned;
    }
    return result;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}
