import {
  canonicalLiveEvidenceKey,
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

  const companyIdByEntityId = datasetCompanyOwnershipMap(dataset);
  const batchSlugByCompanyId = new Map(
    dataset.companies.map((company) => [company.id, company.batchSlug] as const)
  );
  const companyIdForEvidence = (item: EvidenceItem) =>
    companyIdByEntityId.get(item.entityId) ?? item.attachedCompanyId;
  const batchSlugForEvidence = (item: EvidenceItem) => {
    const companyId = companyIdForEvidence(item);
    return companyId ? batchSlugByCompanyId.get(companyId) : undefined;
  };
  const liveEvidenceByBatch = new Map<string, EvidenceItem[]>();

  for (const record of records) {
    const companyId = companyIdByEntityId.get(record.entityId);
    const batchSlug = companyId ? batchSlugByCompanyId.get(companyId) : undefined;
    if (!companyId || !batchSlug) {
      continue;
    }
    const item = liveEvidenceRecordToEvidenceItem(record);
    const batchEvidence = liveEvidenceByBatch.get(batchSlug) ?? [];
    batchEvidence.push({ ...item, attachedCompanyId: companyId });
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
  const liveKeys = new Set(records.map((record) => canonicalLiveEvidenceKey(liveEvidenceRecordToEvidenceItem(record))));
  const visibleByKey = new Map<string, EvidenceItem>();
  for (const item of graphEvidence) {
    const key = canonicalLiveEvidenceKey(item);
    if (liveKeys.has(key) && !visibleByKey.has(key)) {
      visibleByKey.set(key, item);
    }
  }
  const visibleEvidence = [...visibleByKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, item]) => item);
  const visibleKeys = new Set(visibleByKey.keys());
  const hiddenEvidence = records
    .filter((record) => !visibleKeys.has(canonicalLiveEvidenceKey(liveEvidenceRecordToEvidenceItem(record))))
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

function datasetCompanyOwnershipMap(dataset: DemoGraphDataset): Map<string, string> {
  const companyIdByEntityId = new Map(dataset.companies.map((company) => [company.id, company.id] as const));
  for (const founder of dataset.founders) {
    const companyId = [...founder.companyIds].sort()[0];
    if (companyId) {
      companyIdByEntityId.set(founder.id, companyId);
      companyIdByEntityId.set(founder.id.replace(/^founder:/, ""), companyId);
    }
  }
  return companyIdByEntityId;
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
