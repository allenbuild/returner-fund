import { liveEvidenceRecordToEvidenceItem, scoreLiveEvidence } from "./live-evidence-overlay";
import type { DemoGraphDataset, EvidenceItem } from "./types";
import type { LiveEvidenceRecord } from "@/lib/ingestion/live-source-refresh";

export function datasetWithLiveEvidence(
  dataset: DemoGraphDataset,
  records: LiveEvidenceRecord[]
): DemoGraphDataset {
  if (!records.length) {
    return dataset;
  }

  return {
    ...dataset,
    evidence: mergeEvidenceItems(dataset.evidence, records.map(liveEvidenceRecordToEvidenceItem))
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
    record.title?.length ?? 0,
    record.text?.length ?? 0,
    record.rawVisibleText?.length ?? 0
  ].join(":");
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
  const liveKeys = new Set(records.map(liveRecordKey));
  const visibleEvidence = graphEvidence.filter((item) => liveKeys.has(evidenceItemKey(item)));
  const visibleKeys = new Set(visibleEvidence.map(evidenceItemKey));
  const hiddenEvidence = records
    .filter((record) => !visibleKeys.has(liveRecordKey(record)))
    .map((record) => ({
      sourceUrl: record.sourceUrl,
      companyName: record.companyName,
      platform: record.platform,
      reason: "hidden_by_top_voice_matching_or_filters"
    }));

  return { visibleEvidence, hiddenEvidence };
}

function mergeEvidenceItems(existing: EvidenceItem[], liveItems: EvidenceItem[]): EvidenceItem[] {
  const byKey = new Map<string, EvidenceItem>();
  for (const item of existing) {
    byKey.set(evidenceItemKey(item), item);
  }
  for (const item of liveItems) {
    const scored = scoreLiveEvidence(item, [...byKey.values()]);
    byKey.set(evidenceItemKey(scored), scored);
  }
  return [...byKey.values()];
}

function liveRecordKey(record: LiveEvidenceRecord): string {
  return `${record.entityId}:${record.platform}:${record.platformPostId ?? record.sourceUrl}`;
}

function evidenceItemKey(item: EvidenceItem): string {
  return `${item.entityId}:${item.platform}:${item.platformPostId ?? item.sourceUrl}`;
}

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(index) | 0;
  }
  return Math.abs(hash).toString(36);
}
