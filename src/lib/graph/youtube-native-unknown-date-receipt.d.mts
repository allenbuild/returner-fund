export const NATIVE_YOUTUBE_UNKNOWN_DATE_SOURCE: string;
export const NATIVE_YOUTUBE_UNKNOWN_DATE_VALIDATION: string;
export function nativeYouTubeUnknownDateSummary(receipt: unknown, company: unknown): { ok: boolean; reasons: string[]; videoId: string | null; sourceUrl: string | null; channelId: string | null; channelHandle: string | null; channelName: string | null; title: string | null; text: string | null; descriptionNormalization?: Record<string, unknown> | null; publishedDay: null; publishedAtPrecision: "unknown"; relativePublicationReceipt: Record<string, unknown> | null; metrics: Record<string, number>; contributionScore: 0; tractionStatus: "unscored" };
export function verifiedNativeYouTubeUnknownDateReasons(row: unknown, company: unknown): string[];
export function isVerifiedNativeYouTubeUnknownDateReceipt(row: unknown, company: unknown): boolean;
