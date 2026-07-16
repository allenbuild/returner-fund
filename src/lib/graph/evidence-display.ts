import type { EvidenceItem } from "./types";

type EvidenceDisplaySource = Partial<Pick<EvidenceItem, "sourceUrl" | "text" | "title">>;

export function evidenceDisplayText(item: EvidenceDisplaySource, fallback = "Untitled evidence"): string {
  const title = item.title?.trim();
  const body = item.text?.trim();
  return title && !isGenericEvidenceLabel(title) ? title : body || item.sourceUrl || fallback;
}

export function isGenericEvidenceLabel(value: string): boolean {
  return /^.{1,80}\s(?:x|twitter|linkedin|instagram|youtube|reddit|product hunt)\s(?:post|video|reel|comment)$/i.test(
    value.trim()
  );
}
