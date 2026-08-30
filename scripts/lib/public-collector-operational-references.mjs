import { createHash } from "node:crypto";

export const PUBLIC_COLLECTOR_OPERATIONAL_REFERENCE_RECONCILIATION_SCHEMA =
  "public-collector-operational-reference-reconciliation.v1";

/**
 * Retired mutable-catalog owners can remain in resumable collector checkpoints
 * after a roster refresh. They are operational diagnostics, not accepted
 * evidence. Remove only failures whose exact generated founder source key is
 * backed by an explicit `change: "removed"` transition and is absent from the
 * current catalog. Arbitrary unknown references remain fail-closed downstream.
 */
export function reconcileRetiredFounderOperationalFailures(
  failures,
  { currentEntityIds = [], founderTransitions = [] } = {}
) {
  const current = new Set(
    [...currentEntityIds].map(clean).filter(Boolean)
  );
  const removedFounderKeys = removedFounderSourceKeys(founderTransitions);
  const retained = [];
  const pruned = [];

  for (const failure of Array.isArray(failures) ? failures : []) {
    const entityType = clean(failure?.entityType ?? failure?.entity_type).toLowerCase();
    const entityId = clean(failure?.entityId ?? failure?.entity_id);
    if (
      entityType === "founder" &&
      entityId &&
      !current.has(entityId) &&
      removedFounderKeys.has(entityId)
    ) {
      pruned.push(failure);
    } else {
      retained.push(failure);
    }
  }

  return {
    failures: retained,
    pruned,
    receipt: pruned.length > 0
      ? reconciliationReceipt(pruned)
      : null
  };
}

export function removedFounderSourceKeys(founderTransitions) {
  return new Set(
    (Array.isArray(founderTransitions) ? founderTransitions : [])
      .filter((transition) => clean(transition?.change).toLowerCase() === "removed")
      .map((transition) => {
        const companySlug = clean(transition?.companySlug);
        const founderId = clean(transition?.founderId);
        const founderName = clean(transition?.fromName);
        if (!companySlug || !founderId || !founderName) return null;
        return `founder-${companySlug}-${slugify(founderName)}-${founderId}`;
      })
      .filter(Boolean)
  );
}

function reconciliationReceipt(pruned) {
  const failureIds = pruned
    .map((failure) => clean(failure?.id) || operationalFailureFingerprint(failure))
    .sort();
  return {
    schemaVersion: PUBLIC_COLLECTOR_OPERATIONAL_REFERENCE_RECONCILIATION_SCHEMA,
    disposition: "pruned_obsolete_operational_failures",
    reason: "exact_removed_mutable_catalog_founder_transition",
    prunedFailureCount: pruned.length,
    prunedFounderEntityIds: [
      ...new Set(pruned.map((failure) => clean(failure?.entityId ?? failure?.entity_id)).filter(Boolean))
    ].sort(),
    prunedFailureIdsSha256: createHash("sha256")
      .update(JSON.stringify(failureIds))
      .digest("hex")
  };
}

function operationalFailureFingerprint(failure) {
  return JSON.stringify([
    clean(failure?.platform),
    clean(failure?.entityType ?? failure?.entity_type),
    clean(failure?.entityId ?? failure?.entity_id),
    clean(failure?.accountUrl ?? failure?.sourceUrl),
    clean(failure?.message ?? failure?.failure_reason ?? failure?.error),
    clean(failure?.checkedAt ?? failure?.last_checked_at)
  ]);
}

function slugify(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function clean(value) {
  return String(value ?? "").trim();
}
