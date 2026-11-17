export const NATIVE_LINKEDIN_FOUNDER_HISTORY_PROVENANCE: "native_linkedin_founder_history_v1";
export const NATIVE_LINKEDIN_FOUNDER_HISTORY_VALIDATION: "fall_2026_native_linkedin_founder_history_ingestion_v1";
export function nativeLinkedInFounderCaption(node: unknown): { ok: boolean; text?: string; removedUiControlCount?: number; reason?: string };
export function nativeLinkedInFounderCardSummary(receipt: unknown, entity: unknown): { ok: boolean; reasons: string[]; platformPostId?: string | null; sourceUrl?: string | null; accountUrl?: string | null; text?: string | null; metrics?: Record<string, number>; postedAt?: null; publishedAtPrecision?: "unknown" };
export function verifiedNativeLinkedInFounderHistoryReasons(row: unknown, entity: unknown): string[];
export function isVerifiedNativeLinkedInFounderHistoryReceipt(row: unknown, entity: unknown): boolean;
