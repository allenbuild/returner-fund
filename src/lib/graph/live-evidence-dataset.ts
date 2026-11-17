import {
  canonicalLiveEvidenceKey,
  liveEvidenceRecordBatchSlug,
  liveEvidenceRecordToEvidenceItem,
  mergeLiveEvidenceItems
} from "./live-evidence-overlay";
import type { DemoGraphDataset, EvidenceItem } from "./types";
import type { LiveEvidenceRecord } from "@/lib/ingestion/live-source-refresh";

export function datasetWithLiveEvidence(
  dataset: DemoGraphDataset,
  records: LiveEvidenceRecord[]
): DemoGraphDataset {
  if (!records.length) {
    return dataset;
  }

  const resolveOwner = datasetCompanyOwnershipResolver(dataset);
  const ownerForEvidence = (item: EvidenceItem) =>
    resolveOwner(item.entityId, item.batchSlug) ??
    (item.attachedCompanyId ? resolveOwner(item.attachedCompanyId, item.batchSlug) : undefined);
  const companyIdForEvidence = (item: EvidenceItem) =>
    ownerForEvidence(item)?.companyId;
  const batchSlugForEvidence = (item: EvidenceItem) => ownerForEvidence(item)?.batchSlug;
  const liveEvidenceByBatch = new Map<string, EvidenceItem[]>();

  for (const record of records) {
    const owner = resolveOwner(record.entityId, liveEvidenceRecordBatchSlug(record));
    if (!owner) {
      continue;
    }
    const { companyId, batchSlug } = owner;
    const item = liveEvidenceRecordToEvidenceItem(record);
    const batchEvidence = liveEvidenceByBatch.get(batchSlug) ?? [];
    batchEvidence.push({ ...item, batchSlug, attachedCompanyId: companyId });
    liveEvidenceByBatch.set(batchSlug, batchEvidence);
  }

  if (!liveEvidenceByBatch.size) {
    return dataset;
  }

  const mergedEvidenceByBatch = new Map<string, EvidenceItem[]>();
  for (const [batchSlug, liveEvidence] of [...liveEvidenceByBatch.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const batchEvidence = dataset.evidence.filter((item) => batchSlugForEvidence(item) === batchSlug);
    mergedEvidenceByBatch.set(
      batchSlug,
      mergeLiveEvidenceItems(batchEvidence, liveEvidence, companyIdForEvidence).evidence
    );
  }

  return {
    ...dataset,
    evidence: replaceAffectedBatchEvidence(
      dataset.evidence,
      mergedEvidenceByBatch,
      batchSlugForEvidence,
      companyIdForEvidence
    )
  };
}

export function liveEvidenceCacheVersion(records: LiveEvidenceRecord[]): string {
  if (!records.length) {
    return "live:0";
  }

  const newestCheckedAt = records.reduce((newest, record) => {
    const checkedAt = Date.parse(record.last_checked_at ?? record.last_updated_at ?? record.postedAt ?? "");
    return Number.isFinite(checkedAt) ? Math.max(newest, checkedAt) : newest;
  }, 0);

  const sourceSignature = records
    .map((record) => liveEvidenceRecordSignature(record))
    .sort()
    .join("|");

  return `live:${records.length}:${newestCheckedAt}:${hashString(sourceSignature)}`;
}

function liveEvidenceRecordSignature(record: LiveEvidenceRecord): string {
  const item = liveEvidenceRecordToEvidenceItem(record);

  return [
    record.id,
    liveEvidenceRecordBatchSlug(record) ?? "legacy-unscoped",
    record.entityId,
    record.platform,
    record.platformPostId ?? record.sourceUrl,
    record.sourceUrl,
    record.linkStatus ?? "",
    record.linkCheckedAt ?? "",
    record.review_state,
    record.contributionScore,
    record.last_checked_at ?? "",
    record.last_updated_at ?? "",
    record.postedAt ?? "",
    hashString(JSON.stringify(record.metrics ?? {})),
    normalizedAuthorIdentity(item.authorName, item.authorHandle),
    contentSignature(record.title, record.text, record.rawVisibleText)
  ].join(":");
}

function normalizedAuthorIdentity(authorName: string, authorHandle: string | null): string {
  return JSON.stringify([
    normalizeAuthorIdentityPart(authorName),
    normalizeAuthorIdentityPart(authorHandle).replace(/\s+/g, "")
  ]);
}

function normalizeAuthorIdentityPart(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/https?:\/\/(www\.)?/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function contentSignature(...values: Array<string | null | undefined>): string {
  return hashString(JSON.stringify(values.map((value) => value ?? "")));
}

export function liveEvidenceVisibilityForGraph(graphEvidence: EvidenceItem[], records: LiveEvidenceRecord[]): {
  visibleEvidence: EvidenceItem[];
  hiddenEvidence: Array<{
    sourceUrl: string;
    companyName: string;
    platform: LiveEvidenceRecord["platform"];
    reason: string;
  }>;
} {
  const liveKeys = new Map<string, Set<string>>();
  for (const record of records) {
    const item = liveEvidenceRecordToEvidenceItem(record);
    const key = canonicalLiveEvidenceKey(item);
    liveKeys.set(key, new Set([...(liveKeys.get(key) ?? []), item.batchSlug ?? ""]));
  }
  const graphBatchesByKey = new Map<string, Set<string>>();
  for (const item of graphEvidence) {
    const key = canonicalLiveEvidenceKey(item);
    if (liveKeys.has(key)) graphBatchesByKey.set(key, new Set([...(graphBatchesByKey.get(key) ?? []), item.batchSlug ?? ""]));
  }
  const visibleByKey = new Map<string, EvidenceItem>();
  for (const item of graphEvidence) {
    const key = canonicalLiveEvidenceKey(item);
    const batches = liveKeys.get(key);
    const batch = item.batchSlug ?? "";
    const matches = batches?.has(batch) || (batches?.has("") && graphBatchesByKey.get(key)?.size === 1);
    const scopedKey = `${batch}:${key}`;
    if (matches && !visibleByKey.has(scopedKey)) {
      visibleByKey.set(scopedKey, item);
    }
  }
  const visibleEvidence = [...visibleByKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, item]) => item);
  const visibleKeys = new Set(visibleByKey.keys());
  const visiblePhysicalKeys = new Set(visibleEvidence.map((item) => canonicalLiveEvidenceKey(item)));
  const hiddenEvidence = records
    .filter((record) => {
      const item = liveEvidenceRecordToEvidenceItem(record);
      const key = canonicalLiveEvidenceKey(item);
      return item.batchSlug ? !visibleKeys.has(`${item.batchSlug}:${key}`) : !visiblePhysicalKeys.has(key);
    })
    .map((record) => ({
      sourceUrl: record.sourceUrl,
      companyName: record.companyName,
      platform: record.platform,
      reason: "hidden_by_top_voice_matching_or_filters"
    }))
    .sort(
      (left, right) =>
        left.sourceUrl.localeCompare(right.sourceUrl) ||
        left.companyName.localeCompare(right.companyName) ||
        left.platform.localeCompare(right.platform)
    );

  return { visibleEvidence, hiddenEvidence };
}

function datasetCompanyOwnershipResolver(dataset: DemoGraphDataset) {
  type Owner = { companyId: string; batchSlug: string };
  const scopedOwners = new Map<string, Map<string, Owner>>();
  const legacyOwners = new Map<string, Map<string, Owner>>();
  const add = (entityId: string, companyId: string, batchSlug: string) => {
    const normalizedBatch = batchSlug.trim().toUpperCase();
    const owner = { companyId, batchSlug: normalizedBatch };
    const identity = `${normalizedBatch}:${companyId}`;
    const scoped = `${normalizedBatch}:${entityId}`;
    scopedOwners.set(scoped, new Map([...(scopedOwners.get(scoped) ?? []), [identity, owner]]));
    legacyOwners.set(entityId, new Map([...(legacyOwners.get(entityId) ?? []), [identity, owner]]));
  };
  for (const company of dataset.companies) add(company.id, company.id, company.batchSlug);
  for (const founder of dataset.founders) {
    const companyId = [...founder.companyIds].sort()[0];
    if (companyId) {
      add(founder.id, companyId, founder.batchSlug);
      add(founder.id.replace(/^founder:/, ""), companyId, founder.batchSlug);
    }
  }
  return (entityId: string, batchSlug?: string | null): Owner | undefined => {
    const explicitBatch = String(batchSlug ?? "").trim().toUpperCase();
    const candidates = explicitBatch
      ? scopedOwners.get(`${explicitBatch}:${entityId}`)
      : legacyOwners.get(entityId);
    return candidates?.size === 1 ? [...candidates.values()][0] : undefined;
  };
}

function replaceAffectedBatchEvidence(
  existingEvidence: EvidenceItem[],
  mergedEvidenceByBatch: Map<string, EvidenceItem[]>,
  batchSlugForEvidence: (item: EvidenceItem) => string | undefined,
  companyIdForEvidence: (item: EvidenceItem) => string | undefined
): EvidenceItem[] {
  const mergedByKeyByBatch = new Map(
    [...mergedEvidenceByBatch.entries()].map(([batchSlug, items]) => [
      batchSlug,
      new Map(items.map((item) => [canonicalLiveEvidenceKey(item, companyIdForEvidence), item] as const))
    ] as const)
  );
  const emittedKeysByBatch = new Map<string, Set<string>>();
  const evidence: EvidenceItem[] = [];

  for (const item of existingEvidence) {
    const batchSlug = batchSlugForEvidence(item);
    const mergedByKey = batchSlug ? mergedByKeyByBatch.get(batchSlug) : undefined;
    if (!batchSlug || !mergedByKey) {
      evidence.push(item);
      continue;
    }

    const key = canonicalLiveEvidenceKey(item, companyIdForEvidence);
    const emittedKeys = emittedKeysByBatch.get(batchSlug) ?? new Set<string>();
    if (!emittedKeys.has(key)) {
      evidence.push(mergedByKey.get(key) ?? item);
      emittedKeys.add(key);
      emittedKeysByBatch.set(batchSlug, emittedKeys);
    }
  }

  for (const [batchSlug, mergedEvidence] of [...mergedEvidenceByBatch.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const emittedKeys = emittedKeysByBatch.get(batchSlug) ?? new Set<string>();
    for (const item of mergedEvidence) {
      const key = canonicalLiveEvidenceKey(item, companyIdForEvidence);
      if (!emittedKeys.has(key)) {
        evidence.push(item);
        emittedKeys.add(key);
      }
    }
  }

  return evidence;
}

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(index) | 0;
  }
  return Math.abs(hash).toString(36);
}
