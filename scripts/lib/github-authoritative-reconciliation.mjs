import { createHash } from "node:crypto";

export const GITHUB_QUARANTINE_SCHEMA_VERSION = 1;

/**
 * A whole-receipt GitHub collection is authoritative only when it covers the
 * entire cohort, reports every target fetched, and contains one successful row
 * per target. Shards and partial/failed receipts must never prune last-good
 * canonical rows.
 */
export function isFullyAuthoritativeGithubReceipt(snapshot) {
  const source = snapshot?.source ?? {};
  const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
  const targetCount = source.targetCount;
  const fetchedCount = source.fetchedCount;
  const companyCount = source.companyCount;
  const totalCompanyCount = source.totalCompanyCount;
  const shardCount = source.companyShardCount;
  const shardIndex = source.companyShardIndex;

  if (
    !Number.isInteger(targetCount) ||
    targetCount < 0 ||
    fetchedCount !== targetCount ||
    accounts.length !== targetCount ||
    !Number.isInteger(companyCount) ||
    companyCount < 0 ||
    companyCount !== totalCompanyCount ||
    shardCount !== 1 ||
    shardIndex !== 0 ||
    accounts.some((account) => account?.fetched !== true)
  ) {
    return false;
  }

  return new Set(accounts.map(githubTractionAccountKey)).size === accounts.length;
}

export function reconcileGithubTractionSnapshots(
  previous,
  fresh,
  { fetchedAt = new Date().toISOString() } = {}
) {
  const previousAccounts = Array.isArray(previous?.accounts) ? previous.accounts : [];
  const freshAccounts = Array.isArray(fresh?.accounts) ? fresh.accounts : [];

  if (isFullyAuthoritativeGithubReceipt(fresh)) {
    const freshKeys = new Set(freshAccounts.map(githubTractionAccountKey));
    const quarantinedAccounts = previousAccounts
      .filter((account) => !freshKeys.has(githubTractionAccountKey(account)))
      .sort(compareGithubAccounts);

    return {
      authority: "fully_authoritative",
      snapshot: {
        source: structuredClone(fresh.source),
        accounts: structuredClone(freshAccounts)
      },
      quarantinedAccounts,
      retainedLastGood: 0
    };
  }

  const accounts = new Map();
  const retiredMappingKeys = new Set(
    (fresh?.source?.retiredAccountMappings ?? []).map(githubOwnerMappingKey)
  );
  let prunedRetired = 0;
  for (const account of previousAccounts) {
    if (retiredMappingKeys.has(githubOwnerMappingKey({
      entityType: account.entityType,
      entityId: account.entityId ?? account.companySlug ?? account.companyName,
      url: account.githubUrl ?? account.url
    }))) {
      prunedRetired += 1;
      continue;
    }
    accounts.set(githubTractionAccountKey(account), account);
  }

  let retainedLastGood = 0;
  for (const account of freshAccounts) {
    const key = githubTractionAccountKey(account);
    if (account.fetched === false && accounts.has(key)) {
      retainedLastGood += 1;
      continue;
    }
    accounts.set(key, account);
  }

  return {
    authority: "partial_or_failed",
    snapshot: {
      source: {
        ...(previous?.source ?? {}),
        ...(fresh?.source ?? {}),
        fetchedAt,
        retainedLastGood,
        prunedRetired,
        notes: [
          ...(fresh?.source?.notes ?? []),
          ...(prunedRetired ? [`Pruned ${prunedRetired} confirmed retired GitHub account rows.`] : []),
          ...(retainedLastGood ? [`Retained ${retainedLastGood} last-good account rows after failed refreshes.`] : [])
        ]
      },
      accounts: [...accounts.values()]
    },
    quarantinedAccounts: [],
    retainedLastGood
  };
}

export function mergeGithubTractionSnapshots(previous, fresh, options) {
  return reconcileGithubTractionSnapshots(previous, fresh, options).snapshot;
}

/**
 * Builds the non-scoring audit ledger for rows removed by a fully authoritative
 * receipt. Existing ledger rows are retained so a later no-op replay cannot
 * erase the audit trail. Current physical representation is recomputed against
 * the supplied canonical receipts on every publication.
 */
export function buildGithubAuthoritativeQuarantineLedger({
  reconciliations,
  canonicalSnapshots,
  existingLedger = null
}) {
  const canonicalByBatch = mapSnapshotsByBatch(canonicalSnapshots);
  const entries = new Map();

  for (const row of existingLedger?.rows ?? []) {
    if (!row?.batchSlug || !row?.legacyRow) continue;
    entries.set(githubQuarantineRowKey(row.batchSlug, row.legacyRow), {
      batchSlug: row.batchSlug,
      legacyRow: row.legacyRow
    });
  }

  for (const reconciliation of reconciliations ?? []) {
    if (reconciliation?.authority !== "fully_authoritative") continue;
    const batchSlug = reconciliation.snapshot?.source?.batchSlug;
    if (!batchSlug) continue;
    for (const legacyRow of reconciliation.quarantinedAccounts ?? []) {
      entries.set(githubQuarantineRowKey(batchSlug, legacyRow), { batchSlug, legacyRow });
    }
  }

  const rows = [...entries.values()]
    .map(({ batchSlug, legacyRow }) =>
      githubQuarantineLedgerRow(batchSlug, legacyRow, canonicalByBatch.get(batchSlug))
    )
    .sort(compareQuarantineRows);
  const physicalEvidenceOwnerReview = [...canonicalByBatch.values()]
    .flatMap(sharedGithubPhysicalEvidenceReview)
    .sort(comparePhysicalReviewRows);
  const fetchedAtValues = [...canonicalByBatch.values()]
    .map((snapshot) => String(snapshot?.source?.fetchedAt ?? ""))
    .filter(Boolean)
    .sort();

  return {
    source: {
      schemaVersion: GITHUB_QUARANTINE_SCHEMA_VERSION,
      generatedFromFetchedAt: fetchedAtValues.at(-1) ?? null,
      publicationPolicy: "stored_but_unpublished",
      scoringEligible: false,
      reason:
        "Rows absent from a fully authoritative whole-cohort GitHub receipt are retained only for audit and manual attribution review; they are not scoring inputs.",
      rowCount: rows.length,
      rowsByBatch: countBy(rows, (row) => row.batchSlug),
      sharedPhysicalEvidenceReviewCount: physicalEvidenceOwnerReview.length
    },
    rows,
    physicalEvidenceOwnerReview
  };
}

export function githubTractionAccountKey(account) {
  return [
    account?.entityType ?? "company",
    account?.entityId ?? account?.companySlug ?? account?.companyName ?? "unknown",
    String(account?.login ?? "").toLowerCase(),
    String(account?.repo ?? "").toLowerCase()
  ].join(":");
}

function githubQuarantineLedgerRow(batchSlug, legacyRow, canonicalSnapshot) {
  const canonicalIndex = buildCanonicalPhysicalIndex(canonicalSnapshot);
  const primary = primaryPhysicalIdentity(legacyRow);
  const primaryRepresentation = physicalRepresentationForIdentity(primary, canonicalIndex);
  const matches = primaryRepresentation.canonicalMatches;
  const sameOwnerMatches = matches.filter(
    (match) =>
      match.entityType === (legacyRow.entityType ?? "company") &&
      match.entityId === (legacyRow.entityId ?? legacyRow.companySlug ?? legacyRow.companyName)
  );
  const category = legacyRow.repo
    ? "legacy_repository_projection_absent_from_authoritative_targets"
    : "legacy_account_mapping_absent_from_authoritative_targets";

  return {
    quarantineId: `github-quarantine-${stableHash(githubQuarantineRowKey(batchSlug, legacyRow))}`,
    batchSlug,
    category,
    reason: legacyRow.repo
      ? "The prior repository-specific projection is absent from the complete authenticated target receipt. Preserve it for audit only until its entity attribution is manually re-verified."
      : "The prior account mapping is absent from the complete authenticated target receipt. Preserve it for audit only until its entity attribution is manually re-verified.",
    currentCanonicality: sameOwnerMatches.length
      ? "physical_object_present_but_legacy_account_row_not_canonical"
      : matches.length
        ? "physical_object_present_under_different_canonical_attribution"
        : "absent_from_current_canonical_receipt",
    physicalRepresentation: {
      ...primaryRepresentation,
      repositories: dedupePhysicalIdentities(
        (legacyRow.repos ?? []).map((repository) => ({
          kind: "repository",
          ...repositoryPhysicalIdentity(repository)
        }))
      ).map((identity) => physicalRepresentationForIdentity(identity, canonicalIndex))
    },
    ownerAttributionReview: {
      status: matches.length ? "required" : "queued_missing_physical_representation",
      reason: matches.length
        ? "The physical GitHub object remains represented, but this legacy owner mapping is not canonical and must not be restored without review."
        : "The physical GitHub object is absent from the authoritative receipt and requires manual verification before any future publication.",
      legacyOwner: {
        entityType: legacyRow.entityType ?? "company",
        entityId: legacyRow.entityId ?? legacyRow.companySlug ?? legacyRow.companyName ?? "unknown",
        entityName: legacyRow.name ?? legacyRow.companyName ?? null
      }
    },
    scoringEligible: false,
    legacyRow: structuredClone(legacyRow)
  };
}

function physicalRepresentationForIdentity(identity, canonicalIndex) {
  const canonicalMatches = findPhysicalMatches(identity, canonicalIndex);
  return {
    kind: identity.kind,
    canonicalUrl: identity.canonicalUrl,
    repositoryId: identity.repositoryId,
    status: canonicalMatches.length
      ? "represented_in_current_canonical_receipt"
      : "not_represented_in_current_canonical_receipt",
    matchedBy: [
      ...(identity.repositoryId && canonicalIndex.byRepositoryId.has(identity.repositoryId)
        ? ["repository_id"]
        : []),
      ...(identity.canonicalUrl && canonicalIndex.byCanonicalUrl.has(identity.canonicalUrl)
        ? ["canonical_url"]
        : [])
    ],
    canonicalMatches
  };
}

function dedupePhysicalIdentities(identities) {
  const byKey = new Map();
  for (const identity of identities) {
    const key = identity.repositoryId
      ? `repository-id:${identity.repositoryId}`
      : `canonical-url:${identity.canonicalUrl}`;
    if (!byKey.has(key)) byKey.set(key, identity);
  }
  return [...byKey.values()].sort((left, right) =>
    String(left.repositoryId ?? "").localeCompare(String(right.repositoryId ?? "")) ||
    String(left.canonicalUrl ?? "").localeCompare(String(right.canonicalUrl ?? ""))
  );
}

function sharedGithubPhysicalEvidenceReview(snapshot) {
  if (snapshot?.source?.batchSlug !== "A16ZSR006") return [];
  const groups = new Map();

  for (const account of snapshot.accounts ?? []) {
    for (const repository of account.repos ?? []) {
      const identity = repositoryPhysicalIdentity(repository);
      const key = identity.repositoryId
        ? `repository-id:${identity.repositoryId}`
        : `canonical-url:${identity.canonicalUrl}`;
      const group = groups.get(key) ?? { identity, owners: new Map() };
      const owner = canonicalOwner(account, "repository", identity);
      group.owners.set(`${owner.entityType}:${owner.entityId}`, owner);
      groups.set(key, group);
    }
  }

  return [...groups.entries()]
    .filter(([, group]) => group.owners.size > 1)
    .map(([key, group]) => ({
      reviewId: `github-owner-review-${stableHash(`A16ZSR006:${key}`)}`,
      batchSlug: "A16ZSR006",
      category: "shared_physical_repository_owner_attribution",
      reason:
        "One physical GitHub repository is exposed by multiple canonical entity-account mappings. Score the repository once by native repository ID/canonical URL and retain every owner candidate for review.",
      physicalIdentity: group.identity,
      ownerCandidates: [...group.owners.values()].sort(compareOwners),
      scoringPolicy: "deduplicate_physical_evidence",
      reviewState: "needs_review"
    }));
}

function buildCanonicalPhysicalIndex(snapshot) {
  const byRepositoryId = new Map();
  const byCanonicalUrl = new Map();

  for (const account of snapshot?.accounts ?? []) {
    addIndexMatch(byCanonicalUrl, canonicalGithubUrl(account.githubUrl), canonicalOwner(account, "account"));
    for (const repository of account.repos ?? []) {
      const identity = repositoryPhysicalIdentity(repository);
      const owner = canonicalOwner(account, "repository", identity);
      if (identity.repositoryId) addIndexMatch(byRepositoryId, identity.repositoryId, owner);
      if (identity.canonicalUrl) addIndexMatch(byCanonicalUrl, identity.canonicalUrl, owner);
    }
  }

  return { byRepositoryId, byCanonicalUrl };
}

function primaryPhysicalIdentity(account) {
  if (account.repo) {
    const canonicalUrl = canonicalGithubUrl(account.githubUrl);
    const repository = (account.repos ?? []).find((candidate) =>
      String(candidate?.id ?? "") && canonicalGithubUrl(candidate?.htmlUrl) === canonicalUrl
    ) ?? (account.repos ?? [])[0];
    return {
      kind: "repository",
      canonicalUrl,
      repositoryId: repository?.id == null ? null : String(repository.id)
    };
  }
  return {
    kind: "account",
    canonicalUrl: canonicalGithubUrl(account.githubUrl),
    repositoryId: null
  };
}

function repositoryPhysicalIdentity(repository) {
  return {
    repositoryId: repository?.id == null ? null : String(repository.id),
    canonicalUrl: canonicalGithubUrl(repository?.htmlUrl ?? repository?.fullName)
  };
}

function findPhysicalMatches(identity, index) {
  const matches = new Map();
  if (identity.repositoryId) {
    for (const match of index.byRepositoryId.get(identity.repositoryId)?.values() ?? []) {
      matches.set(canonicalMatchKey(match), match);
    }
  }
  if (identity.canonicalUrl) {
    for (const match of index.byCanonicalUrl.get(identity.canonicalUrl)?.values() ?? []) {
      matches.set(canonicalMatchKey(match), match);
    }
  }
  return [...matches.values()].sort(compareCanonicalMatches);
}

function canonicalOwner(account, location, physicalIdentity = null) {
  return {
    entityType: account.entityType ?? "company",
    entityId: account.entityId ?? account.companySlug ?? account.companyName ?? "unknown",
    entityName: account.name ?? account.companyName ?? null,
    accountKey: githubTractionAccountKey(account),
    location,
    accountUrl: canonicalGithubUrl(account.githubUrl),
    repositoryId: physicalIdentity?.repositoryId ?? null,
    repositoryUrl: physicalIdentity?.canonicalUrl ?? null
  };
}

function canonicalGithubUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).includes("://") ? value : `https://github.com/${value}`);
    if (url.hostname.replace(/^www\./i, "").toLowerCase() !== "github.com") return null;
    const parts = url.pathname.split("/").filter(Boolean).slice(0, 2);
    if (!parts.length) return null;
    if (parts[1]) parts[1] = parts[1].replace(/\.git$/i, "");
    return `https://github.com/${parts.join("/")}`.toLowerCase();
  } catch {
    return null;
  }
}

function githubOwnerMappingKey(mapping) {
  return [
    mapping?.entityType ?? "company",
    mapping?.entityId ?? "unknown",
    canonicalGithubUrl(mapping?.url) ?? ""
  ].join(":");
}

function githubQuarantineRowKey(batchSlug, account) {
  return `${batchSlug}:${githubTractionAccountKey(account)}`;
}

function mapSnapshotsByBatch(snapshots) {
  return new Map((snapshots ?? []).map((snapshot) => [snapshot?.source?.batchSlug, snapshot]));
}

function addIndexMatch(index, key, match) {
  if (!key) return;
  const matches = index.get(key) ?? new Map();
  matches.set(canonicalMatchKey(match), match);
  index.set(key, matches);
}

function canonicalMatchKey(match) {
  return [match.entityType, match.entityId, match.location, match.repositoryId, match.repositoryUrl].join(":");
}

function countBy(values, keyForValue) {
  return Object.fromEntries(
    [...values.reduce((counts, value) => {
      const key = keyForValue(value);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return counts;
    }, new Map())].sort(([left], [right]) => left.localeCompare(right))
  );
}

function stableHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function compareGithubAccounts(left, right) {
  return githubTractionAccountKey(left).localeCompare(githubTractionAccountKey(right));
}

function compareQuarantineRows(left, right) {
  return left.batchSlug.localeCompare(right.batchSlug) ||
    githubTractionAccountKey(left.legacyRow).localeCompare(githubTractionAccountKey(right.legacyRow));
}

function comparePhysicalReviewRows(left, right) {
  return left.batchSlug.localeCompare(right.batchSlug) || left.reviewId.localeCompare(right.reviewId);
}

function compareOwners(left, right) {
  return left.entityType.localeCompare(right.entityType) || left.entityId.localeCompare(right.entityId);
}

function compareCanonicalMatches(left, right) {
  return compareOwners(left, right) || left.location.localeCompare(right.location);
}
