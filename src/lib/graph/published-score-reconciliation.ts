import type { CompanyRecord, EvidenceItem } from "./types";
import { aggregateBalancedTractionScore } from "./traction-scoring";

/**
 * Recompute company scoring from the evidence that survived publication-level
 * attribution, ambiguity filtering, and physical-post dedupe.
 *
 * Batch datasets are assembled independently, but their evidence is merged and
 * deduplicated before static graphs are built. Reusing the pre-merge company
 * breakdown after that boundary can leave a node claiming evidence that no
 * longer exists in the published snapshot.
 */
export function reconcilePublishedCompanyScores(
  companies: CompanyRecord[],
  publishedEvidence: EvidenceItem[]
): CompanyRecord[] {
  const companyByIdentity = new Map(
    companies.map((company) => [companyIdentity(company.batchSlug, company.id), company] as const)
  );
  const companyIdentitiesByScopedOwner = new Map<string, Set<string>>();
  const companyIdentitiesByOwner = new Map<string, Set<string>>();
  const evidenceByCompanyIdentity = new Map(
    [...companyByIdentity.keys()].map((identity) => [identity, [] as EvidenceItem[]] as const)
  );

  for (const [identity, company] of companyByIdentity) {
    for (const ownerId of new Set([company.id, ...company.founderIds])) {
      addIdentity(companyIdentitiesByScopedOwner, scopedOwner(company.batchSlug, ownerId), identity);
      addIdentity(companyIdentitiesByOwner, ownerId, identity);
    }
  }

  for (const item of publishedEvidence) {
    const explicitBatchSlug = normalizeBatchSlug(item.batchSlug);
    const candidateIdentities = new Set<string>();
    const ownerIds = new Set([item.attachedCompanyId, item.entityId].filter(Boolean) as string[]);

    for (const ownerId of ownerIds) {
      const candidates = explicitBatchSlug
        ? companyIdentitiesByScopedOwner.get(scopedOwner(explicitBatchSlug, ownerId))
        : companyIdentitiesByOwner.get(ownerId);
      for (const identity of candidates ?? []) candidateIdentities.add(identity);
    }

    // Final publication evidence must have one unambiguous company owner.
    // Unknown or conflicting ownership is intentionally score-neutral.
    if (candidateIdentities.size !== 1) continue;
    const [identity] = candidateIdentities;
    evidenceByCompanyIdentity.get(identity)?.push(item);
  }

  return companies.map((company) => {
    const companyEvidence = evidenceByCompanyIdentity.get(
      companyIdentity(company.batchSlug, company.id)
    ) ?? [];
    const scoreBreakdown = aggregateBalancedTractionScore(companyEvidence);

    return {
      ...company,
      totalScore: scoreBreakdown.totalScore,
      previousScore: scoreBreakdown.totalScore,
      platformScores: scoreBreakdown.platformScores,
      scoreBreakdown
    };
  });
}

function addIdentity(index: Map<string, Set<string>>, key: string, identity: string): void {
  index.set(key, new Set([...(index.get(key) ?? []), identity]));
}

function companyIdentity(batchSlug: string, companyId: string): string {
  return `${normalizeBatchSlug(batchSlug)}\u0000${companyId}`;
}

function scopedOwner(batchSlug: string, ownerId: string): string {
  return `${normalizeBatchSlug(batchSlug)}\u0000${ownerId}`;
}

function normalizeBatchSlug(value: string | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}
