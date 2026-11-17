export const NATIVE_FACEBOOK_SOURCE: string;
export const NATIVE_FACEBOOK_VALIDATION: string;
export function facebookNativeIdentity(value: unknown): { accountKey: string | null; profileUrl: string | null; postId: string | null; sourceUrl: string; kind: "profile" | "post" | "permalink" | "reel" } | null;
export function nativeFacebookCaption(article: unknown, authorName: string): { ok: boolean; reason?: string; text?: string; kind?: string; countsAsAuthoredPost?: boolean; removedUiControl?: string | null };
export function nativeFacebookPublicationLabel(article: unknown): string | null;
export function verifiedNativeFacebookReasons(row: unknown, company: unknown): string[];
export function isVerifiedNativeFacebookReceipt(row: unknown, company: unknown): boolean;
