import {
  collectionTargetAccountIdentity
} from "./logged-in-social-target-selection.mjs";

const REATTRIBUTION_REASON = "native_owner_founder_account_collision";
const STALE_COMPANY_REASON =
  "stale_company_attribution_reconciled_to_founder";

/**
 * Reconcile checkpoint-only rows collected through an account that was mapped
 * to both a company and one of its founders.
 *
 * This helper is intentionally pure: callers decide when an audited checkpoint
 * is safe to write. It only reattributes when the collision proves one company,
 * one founder, one batch, one platform, one account, and shared company
 * membership. Any company row implicated by the collision that cannot satisfy
 * those invariants is removed from accepted evidence and preserved in
 * needsReview instead.
 */
export function reconcileCheckpointOwnerCollisions(
  checkpoint,
  collisions,
  { observedAt = new Date().toISOString() } = {}
) {
  const source = checkpoint && typeof checkpoint === "object" ? checkpoint : {};
  const snapshot = structuredClone(source);
  snapshot.evidence = Array.isArray(snapshot.evidence) ? snapshot.evidence : [];
  snapshot.needsReview = Array.isArray(snapshot.needsReview)
    ? snapshot.needsReview
    : [];
  snapshot.attributionReconciliationLedger = Array.isArray(
    snapshot.attributionReconciliationLedger
  )
    ? snapshot.attributionReconciliationLedger
    : [];

  const normalizedCollisions = (Array.isArray(collisions) ? collisions : [])
    .map(normalizeCollision)
    .filter(Boolean);
  const collisionsByKey = new Map(
    normalizedCollisions.map((collision) => [collision.key, collision])
  );
  const accepted = [];
  const reviewRows = [];
  const ledgerRows = [];
  let reattributedCount = 0;
  let quarantinedCount = 0;
  let duplicateCount = 0;

  const acceptedFounderPostKeys = new Set(
    snapshot.evidence
      .filter((row) => row?.entityType === "founder")
      .map(founderPhysicalPostKey)
      .filter(Boolean)
  );

  for (const row of snapshot.evidence) {
    const implicatedCollision = collisionForCompanyRow(
      row,
      normalizedCollisions,
      collisionsByKey
    );
    if (!implicatedCollision) {
      accepted.push(row);
      continue;
    }

    const validation = validateCompanyRowForReattribution(
      row,
      implicatedCollision
    );
    if (!implicatedCollision.valid || !validation.ok) {
      const reasons = dedupeStrings([
        ...(implicatedCollision.reasons ?? []),
        ...(validation.reasons ?? [])
      ]);
      reviewRows.push(
        collisionReviewRow(row, implicatedCollision, reasons, observedAt)
      );
      ledgerRows.push(
        collisionLedgerRow(
          row,
          implicatedCollision,
          "quarantined",
          reasons.join("+") || "ambiguous_native_account_owner_mapping",
          observedAt
        )
      );
      quarantinedCount += 1;
      continue;
    }

    const founderKey = founderPhysicalPostKey({
      ...row,
      entityType: "founder",
      entityId: implicatedCollision.founder.entityId
    });
    if (!founderKey || acceptedFounderPostKeys.has(founderKey)) {
      const reasons = ["founder_attribution_already_has_native_post"];
      reviewRows.push(
        collisionReviewRow(row, implicatedCollision, reasons, observedAt)
      );
      ledgerRows.push(
        collisionLedgerRow(
          row,
          implicatedCollision,
          "quarantined",
          reasons[0],
          observedAt
        )
      );
      quarantinedCount += 1;
      duplicateCount += 1;
      continue;
    }

    const reconciled = reattributedFounderRow(
      row,
      implicatedCollision,
      observedAt
    );
    accepted.push(reconciled);
    acceptedFounderPostKeys.add(founderKey);
    reviewRows.push(
      collisionReviewRow(
        row,
        implicatedCollision,
        [STALE_COMPANY_REASON],
        observedAt,
        reconciled.id
      )
    );
    ledgerRows.push(
      collisionLedgerRow(
        row,
        implicatedCollision,
        "reattributed",
        REATTRIBUTION_REASON,
        observedAt
      )
    );
    reattributedCount += 1;
  }

  snapshot.evidence = dedupeById(accepted);
  snapshot.needsReview = dedupeById([
    ...snapshot.needsReview,
    ...reviewRows
  ]);
  snapshot.attributionReconciliationLedger = dedupeLedger([
    ...snapshot.attributionReconciliationLedger,
    ...ledgerRows
  ]);

  return {
    snapshot,
    summary: {
      collisionCount: normalizedCollisions.length,
      validCollisionCount: normalizedCollisions.filter(
        (collision) => collision.valid
      ).length,
      reattributedCount,
      quarantinedCount,
      duplicateCount,
      evidenceBefore: Array.isArray(source.evidence)
        ? source.evidence.length
        : 0,
      evidenceAfter: snapshot.evidence.length,
      reviewRecordsAdded: reviewRows.length,
      ledgerRecordsAdded: ledgerRows.length
    }
  };
}

function normalizeCollision(collision) {
  const batchSlug = cleanString(collision?.batchSlug);
  const platform = normalizePlatform(collision?.platform);
  const accountIdentity = cleanString(collision?.accountIdentity)?.toLowerCase();
  if (!batchSlug || !platform || !accountIdentity) return null;

  const targets = Array.isArray(collision?.targets)
    ? collision.targets.filter(Boolean)
    : [];
  const companyTargets = uniqueTargets(
    targets.filter((target) => target?.entityType === "company")
  );
  const founderTargets = uniqueTargets(
    targets.filter((target) => target?.entityType === "founder")
  );
  const reasons = [];
  if (
    targets.length !== 2 ||
    companyTargets.length !== 1 ||
    founderTargets.length !== 1
  ) {
    reasons.push("collision_not_exactly_one_company_and_one_founder");
  }

  const company = companyTargets[0] ?? null;
  const founder = founderTargets[0] ?? null;
  if (
    !company?.entityId ||
    !founder?.entityId ||
    !company?.companySlug ||
    founder?.companySlug !== company.companySlug
  ) {
    reasons.push("founder_company_membership_not_proven");
  }
  for (const target of targets) {
    if (
      cleanString(target?.batchSlug) !== batchSlug ||
      normalizePlatform(target?.platform) !== platform ||
      collectionTargetAccountIdentity(target) !== accountIdentity
    ) {
      reasons.push("collision_target_identity_mismatch");
      break;
    }
  }

  return {
    key: collisionKey(batchSlug, platform, accountIdentity),
    batchSlug,
    platform,
    accountIdentity,
    targets,
    company,
    founder,
    valid: reasons.length === 0,
    reasons: dedupeStrings(reasons)
  };
}

function collisionForCompanyRow(row, collisions, collisionsByKey) {
  if (row?.entityType !== "company") return null;
  const batchSlug = cleanString(row?.batchSlug);
  const platform = normalizePlatform(row?.platform);
  if (!batchSlug || !platform) return null;

  const accountIdentities = dedupeStrings([
    rowAccountIdentity(row?.accountUrl, platform),
    rowAccountIdentity(row?.sourceUrl, platform)
  ]);
  for (const identity of accountIdentities) {
    const exact = collisionsByKey.get(collisionKey(batchSlug, platform, identity));
    if (exact && collisionIncludesCompany(exact, row?.entityId)) return exact;
  }

  // A company may legitimately own a second account in the same platform.
  // Broad company fallback is safe only when neither persisted URL contains a
  // parseable account identity; otherwise a valid non-colliding account would
  // be quarantined merely because another company/founder account collides.
  if (accountIdentities.length) return null;

  // Missing or invalid account metadata must still fail closed when the row is
  // attributed to a company participating in a same-batch/platform collision.
  return (
    collisions.find(
      (collision) =>
        collision.batchSlug === batchSlug &&
        collision.platform === platform &&
        collisionIncludesCompany(collision, row?.entityId)
    ) ?? null
  );
}

function validateCompanyRowForReattribution(row, collision) {
  const reasons = [];
  if (
    cleanString(row?.batchSlug) !== collision.batchSlug ||
    normalizePlatform(row?.platform) !== collision.platform ||
    cleanString(row?.entityId) !== cleanString(collision.company?.entityId) ||
    cleanString(row?.companySlug) !== cleanString(collision.company?.companySlug)
  ) {
    reasons.push("checkpoint_row_owner_identity_mismatch");
  }

  const accountIdentity = rowAccountIdentity(row?.accountUrl, collision.platform);
  const sourceIdentity = rowAccountIdentity(row?.sourceUrl, collision.platform);
  if (
    accountIdentity !== collision.accountIdentity ||
    sourceIdentity !== collision.accountIdentity
  ) {
    reasons.push("checkpoint_row_account_identity_mismatch");
  }

  if (
    collision.platform === "x" &&
    !exactXNativePost(row, collision.accountIdentity)
  ) {
    reasons.push("checkpoint_row_native_post_identity_mismatch");
  }
  return { ok: reasons.length === 0, reasons };
}

function exactXNativePost(row, accountIdentity) {
  const postId = cleanString(row?.platformPostId);
  if (!postId || !/^\d+$/.test(postId)) return false;
  try {
    const url = new URL(row?.sourceUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const segments = url.pathname.split("/").filter(Boolean);
    return (
      ["x.com", "twitter.com"].includes(host) &&
      segments.length === 3 &&
      segments[1].toLowerCase() === "status" &&
      segments[2] === postId &&
      `x:${segments[0].toLowerCase()}` === accountIdentity
    );
  } catch {
    return false;
  }
}

function reattributedFounderRow(row, collision, observedAt) {
  const fromEntityId = collision.company.entityId;
  const toEntityId = collision.founder.entityId;
  return {
    ...row,
    id: reconciledEvidenceId(row, fromEntityId, toEntityId),
    entityType: "founder",
    entityId: toEntityId,
    entityName: collision.founder.name ?? row.entityName ?? row.companyName,
    last_checked_at: observedAt,
    attributionReconciledAt: observedAt,
    matchReason: [
      cleanString(row?.matchReason),
      `Reattributed from ${fromEntityId} to native account owner ${toEntityId} after a fail-closed company/founder account-collision audit.`
    ]
      .filter(Boolean)
      .join(" "),
    attributionReconciliation: {
      action: "company_to_founder_owner_collision",
      reason: REATTRIBUTION_REASON,
      accountIdentity: collision.accountIdentity,
      fromEntityId,
      toEntityId,
      observedAt
    }
  };
}

function collisionReviewRow(
  row,
  collision,
  reasons,
  observedAt,
  replacementEvidenceId = null
) {
  return {
    id: stableId(
      [
        replacementEvidenceId ? "reconciled-owner-collision" : "quarantined-owner-collision",
        row?.id,
        collision.key,
        ...reasons
      ].join(":")
    ),
    batchSlug: collision.batchSlug,
    entityType: "company",
    entityId: row?.entityId ?? collision.company?.entityId ?? null,
    entityName: row?.entityName ?? row?.companyName ?? null,
    companySlug: row?.companySlug ?? collision.company?.companySlug ?? null,
    companyName: row?.companyName ?? collision.company?.companyName ?? null,
    platform: collision.platform,
    platformPostId: row?.platformPostId ?? null,
    candidateUrl: row?.sourceUrl ?? null,
    sourceEvidenceId: row?.id ?? null,
    replacementEvidenceId,
    review_state: "needs_review",
    quarantineReasons: reasons,
    matchReason: replacementEvidenceId
      ? "Retired stale company attribution after exact native account ownership was reconciled to its founder."
      : `Quarantined during owner-collision reconciliation: ${reasons.join("; ")}.`,
    last_checked_at: observedAt,
    nativeAccountOwnerCollision: {
      accountIdentity: collision.accountIdentity,
      companyEntityId: collision.company?.entityId ?? null,
      founderEntityId: collision.founder?.entityId ?? null
    }
  };
}

function collisionLedgerRow(
  row,
  collision,
  disposition,
  reason,
  observedAt
) {
  return {
    platform: collision.platform,
    sourceUrl: row?.sourceUrl ?? null,
    platformPostId: row?.platformPostId ?? null,
    disposition,
    reason,
    accountIdentity: collision.accountIdentity,
    reconciledAt: observedAt,
    staleAttribution: {
      batchSlug: collision.batchSlug,
      entityType: "company",
      entityId: row?.entityId ?? collision.company?.entityId ?? null,
      attributionType: "subject"
    },
    replacementAttribution:
      disposition === "reattributed"
        ? {
            batchSlug: collision.batchSlug,
            entityType: "founder",
            entityId: collision.founder?.entityId ?? null,
            attributionType: "subject"
          }
        : null
  };
}

function reconciledEvidenceId(row, fromEntityId, toEntityId) {
  const id = cleanString(row?.id);
  const platform = normalizePlatform(row?.platform) ?? "unknown";
  const expectedPrefix = `${platform}-${fromEntityId}-`;
  if (id?.startsWith(expectedPrefix)) {
    return `${platform}-${toEntityId}-${id.slice(expectedPrefix.length)}`;
  }
  const nativeId = cleanString(row?.platformPostId);
  return stableId(
    [platform, toEntityId, nativeId ?? canonicalUrl(row?.sourceUrl) ?? id].join(
      ":"
    )
  );
}

function founderPhysicalPostKey(row) {
  if (row?.entityType !== "founder") return null;
  const batchSlug = cleanString(row?.batchSlug);
  const platform = normalizePlatform(row?.platform);
  const entityId = cleanString(row?.entityId);
  const postId = cleanString(row?.platformPostId);
  if (!batchSlug || !platform || !entityId || !postId) return null;
  return `${batchSlug}:${platform}:${entityId}:${postId}`;
}

function collisionIncludesCompany(collision, entityId) {
  return collision.targets.some(
    (target) =>
      target?.entityType === "company" &&
      cleanString(target?.entityId) === cleanString(entityId)
  );
}

function collisionKey(batchSlug, platform, accountIdentity) {
  return `${batchSlug}:${platform}:${accountIdentity}`;
}

function rowAccountIdentity(url, platform) {
  if (!url) return null;
  return collectionTargetAccountIdentity({ platform, url });
}

function uniqueTargets(targets) {
  const seen = new Map();
  for (const target of targets) {
    const key = [
      target?.entityType ?? "",
      target?.entityId ?? "",
      target?.companySlug ?? "",
      collectionTargetAccountIdentity(target) ?? ""
    ].join(":");
    if (!seen.has(key)) seen.set(key, target);
  }
  return [...seen.values()];
}

function normalizePlatform(value) {
  const platform = cleanString(value)?.toLowerCase();
  return platform === "twitter" ? "x" : platform;
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function dedupeStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function dedupeById(rows) {
  const byId = new Map();
  const idless = [];
  for (const row of rows) {
    if (row?.id) byId.set(row.id, row);
    else idless.push(row);
  }
  return [...byId.values(), ...idless];
}

function dedupeLedger(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = [
      normalizePlatform(row?.platform),
      cleanString(row?.platformPostId) ?? canonicalUrl(row?.sourceUrl),
      row?.disposition ?? "",
      row?.staleAttribution?.batchSlug ?? "",
      row?.staleAttribution?.entityId ?? "",
      row?.replacementAttribution?.entityId ?? ""
    ].join(":");
    byKey.set(key, row);
  }
  return [...byKey.values()];
}

function stableId(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 220);
}
