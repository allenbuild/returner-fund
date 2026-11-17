export const NATIVE_TIKTOK_SOURCE: string;
export const NATIVE_TIKTOK_VALIDATION: string;
export function tiktokNativeIdentity(value: unknown): { handle: string; kind: string | null; postId: string | null; profileUrl: string } | null;
export function nativeTikTokMetrics(post: unknown): Record<string, number>;
export function verifiedNativeTikTokReasons(row: unknown, company: unknown): string[];
export function isVerifiedNativeTikTokReceipt(row: unknown, company: unknown): boolean;
