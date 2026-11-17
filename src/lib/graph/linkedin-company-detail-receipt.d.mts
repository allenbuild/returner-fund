export const NATIVE_LINKEDIN_COMPANY_DETAIL: "native_linkedin_company_detail_v1";
export function nativeLinkedInCompanyDetailSummary(receipt: unknown, entity: unknown): { ok: boolean; reasons: string[]; platformPostId?: string; sourceUrl?: string | null; accountUrl?: string; authorName?: string; text?: string; metrics?: Record<string, number>; postedAt?: null; publishedAtPrecision?: "unknown" };
export function verifiedNativeLinkedInCompanyDetailReasons(row: unknown, entity: unknown): string[];
export function isVerifiedNativeLinkedInCompanyDetailReceipt(row: unknown, entity: unknown): boolean;
